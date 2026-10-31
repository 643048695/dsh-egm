import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { getReviewAccessSnapshot } from './review-access.js'
import { buildTaskView } from './task-view.js'
import { describeReviewConfigFor } from './dispatch.js'

/**
 * 顶栏宠物与大象金鱼卡片的状态源（服务端一半）。
 *
 * 为什么要有这个文件：界面上的小动物与卡片必须跟着**真实发生的事**动，而不是自己
 * 转圈或随意猜状态。插件的服务端知道每次派活什么时候开始、哪条金鱼什么时候回来、
 * 落盘文件在哪，所以由它维护「每个会话此刻是什么状态及并发金鱼记录」，界面只负责读取并画出来。
 *
 * 隔离铁律：准确隔离 sessionId，严格禁止无 ID 回退最近会话造成串话。未传 sessionId
 * 时一律返回空闲初始快照（sessionId: null），绝不跨会话串读。
 *
 * 安全声明与证据：经代码实测审查（参考官方 @deepseek-ai/dsh-client-ui-deliverables 等），
 * DSH 宿主的 connection.fetch.register 为全局 HTTP 路由，传入 request 仅为常规 Fetch Request，
 * 宿主并未对请求附带受信任的 session 鉴权或 caller 绑定（未注入受信 session 签名）。
 * 因此本插件不声称具备宿主级路由会话授权；为减少暴露风险，必须严格提供确切 sessionId 方可查询，
 * 且状态轮询严禁返回报告正文，仅提供元数据，报告必须由客户端显式指定 sessionId + goldfishId 按需读取。
 *
 * 通道说明（DSH 0.1.5+ 实测）：不能用 connection.rpc.handle，它会在子 fiber 里
 * 解析 owner.webServer 而静默消失；要走 connection.fetch.register 注册在 `/api`
 * 下，客户端用 ctx.connection.rpc.call('/api', '<prefix>/<endpoint>', payload)
 * 调用。信封形状与 Connection 客户端的校验一致：
 *   请求  { type: 'client-request', rpcId, method: 'egm-pet/state', payload: { sessionId } }
 *   响应  { type: 'server-response', rpcId, result: { ok, value } | { ok:false, error } }
 */

/** 路由命名空间：与客户端 METHOD 常量必须一致。 */
export const PET_ROUTE_PREFIX = 'egm-pet'

/** 客户端调用的方法名。 */
export const PET_METHOD = `${PET_ROUTE_PREFIX}/state`

/** 报告读取方法名（供卡片按需读取落盘正文）。 */
export const PET_REPORT_METHOD = `${PET_ROUTE_PREFIX}/report`

/** 评审门禁与许可实时快照读取方法名。 */
export const PET_REVIEW_ACCESS_METHOD = `${PET_ROUTE_PREFIX}/review-access`

/** 服务端实际挂载的路径。 */
export const PET_ROUTE_PATH = `/api/${PET_METHOD}`
export const PET_REPORT_ROUTE_PATH = `/api/${PET_REPORT_METHOD}`
export const PET_REVIEW_ACCESS_ROUTE_PATH = `/api/${PET_REVIEW_ACCESS_METHOD}`

/** 宠物与卡片认识的状态；多一个都算 bug。
 * idle: 空闲
 * prep: 准备（/egm kickoff 或真实 EGM 技能加载仅证明准备阶段，绝不虚报为已写图纸）
 * writing: 写图纸（保留状态；当前宿主没有可核实的「技能工作开始/结束」事件，绝不因开窗或超时推断）
 * dispatch: 派鱼（有 ≥1 条金鱼在 running）
 * crit: 挑刺（至少 1 条金鱼完成且全部并发金鱼结束）
 */
export const PET_STATES = Object.freeze(['idle', 'prep', 'writing', 'dispatch', 'crit'])

/** 大象（主会话 Agent）真实状态；unknown 表示宿主没给到可核实的信号。 */
export const ELEPHANT_STATUSES = Object.freeze(['unknown', 'idle', 'running'])

/** 已观察到的 EGM 活动信号。只有真实事件能写入，不能从时间或文案推断。 */
export const ELEPHANT_SIGNALS = Object.freeze([
  'gate-opened',
  'skill-loaded',
  'skill-invoked',
  'dispatch-called',
  'dispatch-start',
])

/** 多久没动静且无运行中任务时回到空闲，避免长时间无人操作让宠物永远在咬人。 */
export const PET_IDLE_AFTER_MS = 10 * 60 * 1000

/** 内存单条金鱼报告最大字符数（默认 32KB），超长截断并打标，防止撑爆内存。 */
export const MAX_REPORT_CHARS = 32 * 1024

/** RPC 按需返回报告单次上限（256KB），超出显式标注截断并提供绝对路径供全文访问。 */
export const MAX_REPORT_RPC_BYTES = 256 * 1024

/** 事件 → 状态。集中在一处，方便测试逐个核对。 */
export const PET_EVENT_TRANSITIONS = Object.freeze({
  'gate-opened': 'prep',
  'dispatch-start': 'dispatch',
  'dispatch-done': 'crit',
  'dispatch-failed': 'idle',
  reset: 'idle',
})

/**
 * @typedef {{
 *   id: string,
 *   generation: number,
 *   role: string,
 *   mode: string,
 *   stage?: number,
 *   docPath?: string,
 *   status: 'running' | 'done' | 'failed',
 *   startedAt: number,
 *   finishedAt: number | null,
 *   reportPath: string | null,
 *   report: string | null,
 *   reportBytes: number,
 *   truncated: boolean,
 *   error: string | null
 * }} GoldfishRecord
 */

/**
 * 建一个内存状态表。服务端是进程级单例，多会话/多标签页/子代理并存，
 * 所以每个会话一行，读的时候严格按会话取，禁止无 ID 回退。
 * @param {{ now?: () => number, idleAfterMs?: number, maxReportChars?: number }} [options]
 */
export function createPetStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const idleAfterMs = Number.isFinite(options.idleAfterMs) ? options.idleAfterMs : PET_IDLE_AFTER_MS
  const maxReportChars = Number.isFinite(options.maxReportChars) ? options.maxReportChars : MAX_REPORT_CHARS

  /** @type {Map<string, { generation: number, state: string, count: number, role: string|null, mode: string|null, updatedAt: number, gate: { open: boolean, remaining: number, expiresAt: number }, goldfish: GoldfishRecord[], elephant: { status: string, source: string|null, since: number, lastActivityAt: number, reason: string|null, currentTurn: number|null, egm: { active: boolean, signal: string|null, skill: string|null, since: number, lastSeq: number|null, turn: number|null, bindNextTurn: boolean } } }>} */
  const rows = new Map()

  /**
   * 大象状态桥的可用性。它描述的是「本进程有没有订到宿主的真实事件」，
   * 不是「某个会话此刻一定在工作」。永远不会把没订到写成 idle。
   */
  let bridge = {
    attached: false,
    agentLifecycle: false,
    agentStatus: false,
    sessionEvents: false,
    failures: [],
    reason: 'not attached',
  }

  function markElephantBridge(next) {
    if (!next || typeof next !== 'object') return { ...bridge }
    bridge = {
      ...bridge,
      ...next,
      failures: Array.isArray(next.failures) ? [...next.failures] : bridge.failures,
    }
    return { ...bridge }
  }

  const emptyElephant = () => ({
    status: 'unknown',
    source: null,
    since: 0,
    lastActivityAt: 0,
    reason: 'no-status-event',
    currentTurn: null,
    egm: {
      active: false,
      signal: null,
      skill: null,
      since: 0,
      lastSeq: null,
      turn: null,
      bindNextTurn: false,
    },
  })

  const empty = () => ({
    generation: 1,
    state: 'idle',
    count: 0,
    role: null,
    mode: null,
    updatedAt: 0,
    gate: { open: false, remaining: 0, expiresAt: 0 },
    unsafePermit: { granted: false, remaining: 0, expiresAt: 0, reason: null },
    goldfish: [],
    elephant: emptyElephant(),
  })

  function rowOf(key) {
    let row = rows.get(key)
    if (!row) {
      row = empty()
      rows.set(key, row)
    }
    return row
  }

  function keyOf(sessionId) {
    const raw = sessionId === undefined || sessionId === null ? '' : String(sessionId).trim()
    return raw
  }

  /**
   * 把大象状态压成对外快照。`status: unknown` 时明确给 reason，不拿 idle 冒充。
   * workingOnEgm 只表示「主机报告 Agent 正在跑，且本会话见过真实 EGM 信号」，
   * 不表示已经写了图纸——宿主没有可核实的技能工作开始/结束事件。
   */
  function elephantView(row) {
    const status = row.elephant.status
    const known = status !== 'unknown'
    const currentTurn = row.elephant.currentTurn
    const egmTurnActive =
      row.elephant.egm.active &&
      row.elephant.egm.turn !== null &&
      currentTurn !== null &&
      row.elephant.egm.turn === currentTurn
    let reason = null
    if (!known) {
      reason = bridge.agentStatus && bridge.agentLifecycle
        ? 'no-status-event'
        : 'status-bridge-unavailable'
    }
    return {
      status,
      known,
      source: row.elephant.source,
      since: row.elephant.since > 0 ? row.elephant.since : null,
      lastActivityAt: row.elephant.lastActivityAt > 0 ? row.elephant.lastActivityAt : null,
      working: known ? status === 'running' : null,
      workingOnEgm: known ? status === 'running' && egmTurnActive : null,
      reason,
      egm: {
        active: row.elephant.egm.active,
        signal: row.elephant.egm.signal,
        skill: row.elephant.egm.skill,
        since: row.elephant.egm.since > 0 ? row.elephant.egm.since : null,
        // 只有和当前真实 turn 对上的信号才算「正在做 EGM」；历史信号不能借普通对话复活。
        turn: row.elephant.egm.turn,
        currentTurn,
      },
      bridge: {
        attached: bridge.attached,
        agentLifecycle: bridge.agentLifecycle,
        agentStatus: bridge.agentStatus,
        sessionEvents: bridge.sessionEvents,
        reason: bridge.reason ?? null,
        // 只暴露失败的事件名，不把宿主内部错误文本带进无鉴权的状态轮询。
        failedSources: bridge.failures.map((item) => String(item).split(':', 1)[0]),
      },
    }
  }

  /** 读某个会话的当前状态（带无运行中任务时的超时回落；禁止无 ID 回退）。 */
  function read(sessionId) {
    const key = keyOf(sessionId)
    if (key === '') {
      const row = empty()
      return {
        sessionId: null,
        ...row,
        reviewAccess: {
          allowed: false,
          gate: { open: false, remaining: 0, expiresAt: 0 },
          unsafePermit: { granted: false, remaining: 0, expiresAt: 0, reason: null },
        },
        elephant: elephantView(row),
      }
    }
    const row = rowOf(key)

    // 优先读取当前活跃会话在 review-access 中的实时 WeakMap 快照
    const access = getReviewAccessSnapshot(key)
    let isGateOpen = false
    let gateRemaining = 0
    let gateExpiresAt = 0

    let isPermitGranted = false
    let permitRemaining = 0
    let permitExpiresAt = 0
    let permitReason = null

    if (access && access.gate && access.unsafePermit && (access.gate.open || access.unsafePermit.granted)) {
      // 实时 WeakMap 存在有效活跃数据
      isGateOpen = access.gate.open
      gateRemaining = access.gate.remaining
      gateExpiresAt = access.gate.expiresAt
      isPermitGranted = access.unsafePermit.granted
      permitRemaining = access.unsafePermit.remaining
      permitExpiresAt = access.unsafePermit.expiresAt
      permitReason = access.unsafePermit.reason
      row.gate = { open: isGateOpen, remaining: gateRemaining, expiresAt: gateExpiresAt }
      row.unsafePermit = { granted: isPermitGranted, remaining: permitRemaining, expiresAt: permitExpiresAt, reason: permitReason }
    } else {
      // 若 WeakMap 中无活跃记录或已过期/关闭，校验 store 内部 row 的记录
      isGateOpen = Boolean(
        row.gate &&
        typeof row.gate.expiresAt === 'number' &&
        row.gate.expiresAt > 0 &&
        now() < row.gate.expiresAt &&
        typeof row.gate.remaining === 'number' &&
        row.gate.remaining > 0
      )
      gateRemaining = Math.max(0, row.gate?.remaining || 0)
      gateExpiresAt = row.gate?.expiresAt || 0
      row.gate = { open: isGateOpen, remaining: gateRemaining, expiresAt: gateExpiresAt }

      isPermitGranted = Boolean(
        row.unsafePermit &&
        typeof row.unsafePermit.expiresAt === 'number' &&
        row.unsafePermit.expiresAt > 0 &&
        now() < row.unsafePermit.expiresAt &&
        typeof row.unsafePermit.remaining === 'number' &&
        row.unsafePermit.remaining > 0
      )
      permitRemaining = Math.max(0, row.unsafePermit?.remaining || 0)
      permitExpiresAt = row.unsafePermit?.expiresAt || 0
      permitReason = row.unsafePermit?.reason || null
      row.unsafePermit = { granted: isPermitGranted, remaining: permitRemaining, expiresAt: permitExpiresAt, reason: permitReason }
    }

    // 10 分钟失活：只有在没有 running 金鱼、且当前 turn 没有真实 EGM 活动时才回落。
    // 普通对话里的 running 不能借历史 egm.active 续命；elephant-status 也不再刷新这个计时。
    const hasRunning = row.goldfish.some((g) => g.status === 'running')
    const egmTurnActive =
      row.elephant.egm.active &&
      row.elephant.egm.turn !== null &&
      row.elephant.currentTurn !== null &&
      row.elephant.egm.turn === row.elephant.currentTurn
    if (!hasRunning && !egmTurnActive && row.state !== 'idle' && idleAfterMs > 0 && now() - row.updatedAt > idleAfterMs) {
      row.state = 'idle'
      row.role = null
      row.mode = null
      // 失活只结束本轮 EGM 活动，不清 status（主 Agent 的真实状态仍由宿主事件更新）；
      // 保留 lastSeq，让超时后的旧事件仍被拒绝。
      row.elephant.egm = {
        active: false,
        signal: null,
        skill: null,
        since: 0,
        lastSeq: row.elephant.egm.lastSeq,
        turn: null,
        bindNextTurn: false,
      }
      row.updatedAt = now()
    }

    return {
      sessionId: key,
      generation: row.generation,
      state: row.state,
      count: row.count,
      role: row.role,
      mode: row.mode,
      updatedAt: row.updatedAt,
      gate: {
        open: isGateOpen,
        remaining: gateRemaining,
        expiresAt: gateExpiresAt,
      },
      unsafePermit: {
        granted: isPermitGranted,
        remaining: permitRemaining,
        expiresAt: permitExpiresAt,
        reason: permitReason,
      },
      reviewAccess: {
        allowed: Boolean(isGateOpen && isPermitGranted),
        gate: {
          open: isGateOpen,
          remaining: gateRemaining,
          expiresAt: gateExpiresAt,
        },
        unsafePermit: {
          granted: isPermitGranted,
          remaining: permitRemaining,
          expiresAt: permitExpiresAt,
          reason: permitReason,
        },
      },
      // 状态轮询不返回报告正文！按需读取，只返回元数据与状态
      goldfish: row.goldfish.map((item) => ({
        id: item.id,
        role: item.role,
        mode: item.mode,
        stage: item.stage,
        docPath: item.docPath,
        status: item.status,
        startedAt: item.startedAt,
        finishedAt: item.finishedAt,
        reportPath: item.reportPath,
        hasReport: Boolean(item.reportPath || item.report),
        reportBytes: item.reportBytes || 0,
        truncated: item.truncated || false,
        error: item.error,
      })),
      elephant: elephantView(row),
    }
  }

  /**
   * 按需读取某个金鱼的报告全文。
   * 按调用者提供的会话 ID 分组查询记录（注意：sessionId 由请求传入，RPC 通道无调用方身份认证，不构成安全认证边界）。
   * 采用受限文件读取与 UTF-8 安全截断，避免全量读入大文件耗尽内存，但同步 I/O 在慢速存储下仍可能产生短暂阻塞，不承诺完全无阻塞。
   */
  function readReport(sessionId, query) {
    const key = keyOf(sessionId)
    if (key === '') return { ok: false, error: 'sessionId is required' }
    const row = rows.get(key)
    if (!row) return { ok: false, error: 'session not found' }
    const q = String(query ?? '').trim()
    if (!q) return { ok: false, error: 'goldfishId or reportPath is required' }
    const item = row.goldfish.find((g) => g.id === q || g.reportPath === q)
    if (!item) {
      return { ok: false, error: 'goldfish record not found' }
    }
    if (item.status === 'running') {
      return { ok: false, error: 'goldfish is still running' }
    }
    if (item.status === 'failed') {
      return { ok: false, error: item.error || 'goldfish failed' }
    }

    let content = ''
    let reportPath = item.reportPath || null
    let truncated = false
    let totalBytes = 0
    let source = 'memory-fallback'
    let diskReadOk = false

    // 目标路径检查与受限磁盘读取：只读可信记录里的真实 reportPath。
    // 采用 lstat 初筛与 open 后 fstat 二次校验，拒绝直接符号链接与非普通文件。
    // 注意：lstat 与 open 之间存在固有 TOCTOU 竞态，且未递归校验各级父目录符号链接，本检查为最佳努力（best-effort）基础过滤，不声称完全防穿透。
    if (reportPath && typeof reportPath === 'string') {
      let fd = null
      try {
        const stat = fs.lstatSync(reportPath)
        if (stat.isSymbolicLink()) {
          throw new Error('E_UNSAFE_PATH: symlink report path is not permitted')
        }
        if (!stat.isFile()) {
          throw new Error('E_UNSAFE_PATH: report path must be a regular file')
        }

        totalBytes = stat.size
        const bytesToRead = Math.min(totalBytes, MAX_REPORT_RPC_BYTES)
        const buf = Buffer.alloc(bytesToRead)
        fd = fs.openSync(reportPath, 'r')
        const fstat = fs.fstatSync(fd)
        if (!fstat.isFile()) {
          throw new Error('E_UNSAFE_PATH: opened descriptor is not a regular file')
        }

        const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, 0)

        // UTF-8 安全截断：StringDecoder 会保留末尾未完成的多字节序列
        const decoder = new StringDecoder('utf8')
        content = decoder.write(buf.subarray(0, bytesRead))

        let safeBytes = Buffer.byteLength(content, 'utf8')
        // 若存在非法 UTF-8 字节，替换字符 (U+FFFD, 3字节) 可能导致输出体积膨胀超过读入字节数。
        // 此处严格处理，确保输出 UTF-8 字节数绝对不超过 MAX_REPORT_RPC_BYTES 输出预算
        if (safeBytes > MAX_REPORT_RPC_BYTES) {
          const reBuf = Buffer.from(content, 'utf8').subarray(0, MAX_REPORT_RPC_BYTES)
          const reDecoder = new StringDecoder('utf8')
          content = reDecoder.write(reBuf)
          safeBytes = Buffer.byteLength(content, 'utf8')
          truncated = true
        } else {
          truncated = totalBytes > safeBytes
        }
        diskReadOk = true
        source = 'disk'
      } catch {
        // 磁盘读取异常（文件缺失、权限不足、符号链接或非普通文件等），降级回退至内存缓存
        diskReadOk = false
        source = 'memory-fallback'
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd)
          } catch {}
        }
      }
    }

    if (!diskReadOk) {
      // 回退内存缓存：明确标示来源为 memory-fallback 及截断状态，绝不虚假声称全文
      let memContent = item.report || ''
      totalBytes = item.reportBytes || Buffer.byteLength(memContent, 'utf8')
      const memBytes = Buffer.byteLength(memContent, 'utf8')
      if (memBytes > MAX_REPORT_RPC_BYTES) {
        const memBuf = Buffer.from(memContent, 'utf8').subarray(0, MAX_REPORT_RPC_BYTES)
        const decoder = new StringDecoder('utf8')
        memContent = decoder.write(memBuf)
        if (Buffer.byteLength(memContent, 'utf8') > MAX_REPORT_RPC_BYTES) {
          const reBuf = Buffer.from(memContent, 'utf8').subarray(0, MAX_REPORT_RPC_BYTES)
          const reDecoder = new StringDecoder('utf8')
          memContent = reDecoder.write(reBuf)
        }
        truncated = true
      } else {
        truncated = Boolean(item.truncated || (totalBytes > memBytes))
      }
      content = memContent
      source = 'memory-fallback'
    }

    if (!content) {
      return { ok: false, error: 'no report content available' }
    }

    return {
      ok: true,
      value: {
        id: item.id,
        role: item.role,
        reportPath,
        content,
        totalBytes,
        truncated,
        source,
      },
    }
  }

  /**
   * 记录一次真实观察到的 EGM 信号。只改 egm 子状态；绝不把它直接写成 writing。
   * seq 用于拒绝同一会话里迟到的旧事件；没有 seq 的命令事件保留已有的 lastSeq。
   */
  function noteEgmSignal(row, extra = {}) {
    const signal = typeof extra.signal === 'string' ? extra.signal : ''
    if (!ELEPHANT_SIGNALS.includes(signal)) return false
    const seq = Number.isInteger(extra.seq) ? extra.seq : null
    const lastSeq = row.elephant.egm.lastSeq
    if (seq !== null && lastSeq !== null && seq <= lastSeq) return false
    const at = Number.isFinite(extra.at) ? extra.at : now()
    const bindNextTurn = extra.bindNextTurn === true
    const turn = bindNextTurn
      ? null
      : Number.isInteger(extra.turn)
        ? extra.turn
        : row.elephant.currentTurn
    row.elephant.egm = {
      active: true,
      signal,
      skill: typeof extra.skill === 'string' && extra.skill !== '' ? extra.skill : null,
      since: at,
      lastSeq: seq !== null ? seq : lastSeq,
      turn: turn !== null && Number.isInteger(turn) ? turn : null,
      bindNextTurn,
    }
    row.elephant.lastActivityAt = at
    if (row.state === 'idle') row.state = 'prep'
    row.updatedAt = now()
    return true
  }

  /**
   * 记一件事。未知事件名直接忽略并返回 false——宁可宠物不动，也不猜。
   * @param {string|null} sessionId
   * @param {string} type
   * @param {{ id?: string, role?: string|null, mode?: string|null, stage?: number, docPath?: string, reportPath?: string|null, report?: string|null, error?: string|null, prep?: boolean, writing?: boolean, didStart?: boolean, gate?: { expiresAt?: number, remaining?: number }, startedAt?: number, finishedAt?: number, failedAt?: number, status?: 'idle'|'running', source?: string, at?: number, signal?: string, skill?: string|null, seq?: number|null, turn?: number|null, phase?: 'start'|'end', bindNextTurn?: boolean, agentId?: string }} [extra]
   */
  function apply(sessionId, type, extra = {}) {
    const raw = keyOf(sessionId)
    // 没有会话号就不记：准确隔离，不张冠李戴。
    if (raw === '') return false

    const row = rowOf(raw)

    if (type === 'access-updated') {
      if (extra.gate && typeof extra.gate.expiresAt === 'number' && typeof extra.gate.remaining === 'number') {
        row.gate = {
          open: now() < extra.gate.expiresAt && extra.gate.remaining > 0,
          expiresAt: extra.gate.expiresAt,
          remaining: extra.gate.remaining,
        }
      } else if (extra.gate && extra.gate.open === false) {
        row.gate = { open: false, expiresAt: 0, remaining: 0 }
      }

      if (extra.unsafePermit && typeof extra.unsafePermit.expiresAt === 'number' && typeof extra.unsafePermit.remaining === 'number') {
        row.unsafePermit = {
          granted: now() < extra.unsafePermit.expiresAt && extra.unsafePermit.remaining > 0,
          expiresAt: extra.unsafePermit.expiresAt,
          remaining: extra.unsafePermit.remaining,
          reason: typeof extra.unsafePermit.reason === 'string' ? extra.unsafePermit.reason : null,
        }
      } else if (extra.unsafePermit && extra.unsafePermit.granted === false) {
        row.unsafePermit = { granted: false, expiresAt: 0, remaining: 0, reason: null }
      }

      row.updatedAt = now()
      // 保持 inflight 历史，绝不误清退正在跑的任务，也不重置代际
      const runningGoldfish = row.goldfish.filter((g) => g.status === 'running' && g.generation === row.generation)
      if (runningGoldfish.length > 0) {
        row.state = 'dispatch'
      }
      return true
    }

    if (type === 'gate-opened') {
      // 真实 gate 元数据同步；若拿不到真实 gate，不暴露为真实授权状态
      if (extra.gate && typeof extra.gate.expiresAt === 'number' && typeof extra.gate.remaining === 'number') {
        row.gate = {
          open: now() < extra.gate.expiresAt && extra.gate.remaining > 0,
          expiresAt: extra.gate.expiresAt,
          remaining: extra.gate.remaining,
        }
      } else {
        row.gate = { open: false, expiresAt: 0, remaining: 0 }
      }

      // 重复 /egm-open 不应丢失真实 in-flight 任务
      const runningGoldfish = row.goldfish.filter((g) => g.status === 'running')
      if (runningGoldfish.length > 0) {
        // 仍有金鱼正在运行，保留当前运行中任务，状态维持 dispatch
        row.goldfish = runningGoldfish
        row.state = 'dispatch'
      } else {
        row.goldfish = []
        row.count = 0
        row.role = null
        row.mode = null
        // /egm kickoff 仅证明准备（prep）而非已在写图纸（writing），状态标为准备、不要虚报已写
        row.state = (extra.prep === true || extra.writing === true) ? 'prep' : 'idle'
      }
      // /egm kickoff 是用户亲手启动 EGM 的真实信号；它没有自己的 turn，
      // 因此绑定到下一个真实 turn；/egm-open 只开窗，不记活动。
      if (extra.prep === true) noteEgmSignal(row, { signal: 'gate-opened', at: now(), bindNextTurn: true })
      row.updatedAt = now()
      return true
    }

    if (type === 'reset') {
      // /egm-safe 重置：递增代际，使在此之前发起的任务迟到事件无法复活本轮状态
      row.generation += 1
      row.gate = { open: false, expiresAt: 0, remaining: 0 }
      row.state = 'idle'
      row.count = 0
      row.role = null
      row.mode = null
      row.goldfish = []
      // 只结束 EGM 活动；主 Agent 的真实 running/idle 仍由宿主事件更新，不能在这里篡改。
      // 保留 lastSeq，reset 之后迟到的旧 session 事件仍会被拒绝。
      row.elephant.egm = {
        active: false,
        signal: null,
        skill: null,
        since: 0,
        lastSeq: row.elephant.egm.lastSeq,
        turn: null,
        bindNextTurn: false,
      }
      row.updatedAt = now()
      return true
    }

    if (type === 'elephant-status') {
      const status = typeof extra.status === 'string' ? extra.status : ''
      if (status !== 'idle' && status !== 'running') return false
      const at = Number.isFinite(extra.at) ? extra.at : now()
      row.elephant.status = status
      row.elephant.source = typeof extra.source === 'string' && extra.source !== '' ? extra.source : 'agent/status'
      row.elephant.since = at
      row.elephant.lastActivityAt = at
      row.elephant.reason = null
      // 关键：不刷新 row.updatedAt。普通对话的 running/idle 不能给 EGM 活动续命。
      return true
    }

    if (type === 'elephant-turn') {
      const turn = Number.isInteger(extra.turn) ? extra.turn : null
      if (turn === null) return false
      const phase = extra.phase
      const at = Number.isFinite(extra.at) ? extra.at : now()
      if (phase === 'start') {
        row.elephant.currentTurn = turn
        const egm = row.elephant.egm
        if (egm.active && egm.bindNextTurn) {
          // /egm kickoff 没有自己的 turn；下一个真实 turn 就是 EGM turn。
          egm.turn = turn
          egm.bindNextTurn = false
          row.updatedAt = at
        } else if (egm.active) {
          // 新 turn 没有 EGM 信号：历史活动立刻与当前工作脱钩。
          row.elephant.egm = {
            active: false,
            signal: null,
            skill: null,
            since: 0,
            lastSeq: egm.lastSeq,
            turn: null,
            bindNextTurn: false,
          }
          if (row.state === 'prep') row.state = 'idle'
        }
        return true
      }
      if (phase === 'end') {
        const matchesCurrent = row.elephant.currentTurn === turn
        if (matchesCurrent) row.elephant.currentTurn = null
        // 只有结束的正是绑定过 EGM 信号的 turn，才清活动标记。
        // currentTurn 未知（热接入错过 turn/start）时，egm.turn 仍能证明这是同一个 turn；
        // 若 currentTurn 是另一个 turn，则这是迟到/别的 turn 的 end，不能误伤当前活动。
        const matchesEgmTurn =
          row.elephant.egm.active &&
          row.elephant.egm.turn === turn &&
          (matchesCurrent || row.elephant.currentTurn === null)
        if (matchesEgmTurn) {
          row.elephant.egm = {
            active: false,
            signal: null,
            skill: null,
            since: 0,
            lastSeq: row.elephant.egm.lastSeq,
            turn: null,
            bindNextTurn: false,
          }
          // 只把准备态收回 idle；running 金鱼（dispatch）与历史报告（crit/count）保持不动。
          if (row.state === 'prep') row.state = 'idle'
          row.updatedAt = at
        }
        return true
      }
      return false
    }

    if (type === 'elephant-activity') {
      const turn = Number.isInteger(extra.turn) ? extra.turn : row.elephant.currentTurn
      const egm = row.elephant.egm
      if (!egm.active || egm.turn === null || turn === null || egm.turn !== turn) return false
      const at = Number.isFinite(extra.at) ? extra.at : now()
      row.elephant.lastActivityAt = at
      row.updatedAt = at
      return true
    }

    if (type === 'elephant-disposed') {
      const at = Number.isFinite(extra.at) ? extra.at : now()
      // Agent 已经离开注册表：此刻确实不在 running。仍不冒充 EGM 完成或写图纸。
      row.elephant.status = 'idle'
      row.elephant.source = 'agent/disposed'
      row.elephant.since = at
      row.elephant.lastActivityAt = at
      row.elephant.reason = 'agent-disposed'
      // 不刷新 row.updatedAt：Agent 生命周期变化不应延长 EGM 活动的失活计时。
      return true
    }

    if (type === 'elephant-signal') {
      return noteEgmSignal(row, extra)
    }

    if (type === 'dispatch-start') {
      const gfId = typeof extra.id === 'string' && extra.id.trim() !== ''
        ? extra.id.trim()
        : `gf-${extra.role ?? 'goldfish'}-${now()}-${Math.random().toString(36).slice(2, 8)}`

      // 消费一次 gate 额度，与真实 takeGate 保持一致
      if (row.gate && typeof row.gate.remaining === 'number' && row.gate.remaining > 0) {
        row.gate.remaining -= 1
        if (row.gate.remaining <= 0 || now() >= row.gate.expiresAt) {
          row.gate.open = false
        }
      }

      let item = row.goldfish.find((g) => g.id === gfId && g.generation === row.generation)
      if (!item) {
        item = {
          id: gfId,
          generation: row.generation,
          role: extra.role ?? 'unknown',
          mode: extra.mode ?? 'review',
          stage: extra.stage,
          docPath: extra.docPath,
          status: 'running',
          startedAt: Number.isFinite(extra.startedAt) ? extra.startedAt : now(),
          finishedAt: null,
          reportPath: null,
          report: null,
          reportBytes: 0,
          truncated: false,
          error: null,
        }
        row.goldfish.push(item)
      } else {
        item.status = 'running'
        item.startedAt = Number.isFinite(extra.startedAt) ? extra.startedAt : now()
      }

      // 真正放行并开始派活：这是 EGM 活动，但金鱼状态仍由 dispatch 主导。
      noteEgmSignal(row, { signal: 'dispatch-start', at: now() })
      row.state = 'dispatch'
      row.role = extra.role ?? row.role
      row.mode = extra.mode ?? row.mode
      row.updatedAt = now()
      return true
    }

    if (type === 'dispatch-done') {
      const gfId = typeof extra.id === 'string' ? extra.id.trim() : ''
      // 必须精确 ID 且匹配当前代际启动记录，不得按角色回退匹配
      if (gfId === '') return false
      const item = row.goldfish.find((g) => g.id === gfId && g.generation === row.generation)
      // 若未找到对应的有效 running 记录（如 reset 后的迟到事件），直接拒绝，绝不篡改或复活
      if (!item || item.status !== 'running') {
        return false
      }

      let reportText = null
      let truncated = false
      let reportBytes = 0
      if (typeof extra.report === 'string') {
        reportBytes = Buffer.byteLength(extra.report, 'utf8')
        if (extra.report.length > maxReportChars) {
          reportText = extra.report.slice(0, maxReportChars) + '\n\n...[报告过长，已截断显示]'
          truncated = true
        } else {
          reportText = extra.report
          truncated = false
        }
      }

      item.status = 'done'
      item.finishedAt = Number.isFinite(extra.finishedAt) ? extra.finishedAt : now()
      item.reportPath = typeof extra.reportPath === 'string' ? extra.reportPath : item.reportPath
      if (reportText !== null) {
        item.report = reportText
        item.reportBytes = reportBytes
        item.truncated = truncated
      }
      if (extra.role) item.role = extra.role
      if (extra.stage !== undefined) item.stage = extra.stage

      row.count += 1
      row.role = extra.role ?? row.role
      row.mode = extra.mode ?? row.mode
      row.elephant.lastActivityAt = now()

      // 并发金鱼：若还有其他金鱼仍在 running，保持 dispatch；全部完成才进 crit
      const stillRunning = row.goldfish.some((g) => g.status === 'running' && g.generation === row.generation)
      row.state = stillRunning ? 'dispatch' : 'crit'
      row.updatedAt = now()
      return true
    }

    if (type === 'dispatch-failed') {
      // 必须精确 ID + didStart 保障：未放行/未真正启动任务坚决不篡改运行中任务
      if (extra.didStart !== true) {
        return false
      }
      const gfId = typeof extra.id === 'string' ? extra.id.trim() : ''
      if (gfId === '') return false
      const item = row.goldfish.find((g) => g.id === gfId && g.generation === row.generation)
      // 必须明确匹配有效启动中的记录，不得按角色回退匹配
      if (!item || item.status !== 'running') {
        return false
      }

      item.status = 'failed'
      item.finishedAt = Number.isFinite(extra.failedAt) ? extra.failedAt : now()
      item.error = typeof extra.error === 'string' ? extra.error : 'dispatch failed'
      item.report = null

      row.role = extra.role ?? row.role
      row.elephant.lastActivityAt = now()
      // 并发金鱼：如果有其他金鱼仍处于 running，不能覆盖为 idle！
      const stillRunning = row.goldfish.some((g) => g.status === 'running' && g.generation === row.generation)
      row.state = stillRunning ? 'dispatch' : (row.count > 0 ? 'crit' : 'idle')
      row.updatedAt = now()
      return true
    }

    return false
  }

  /** 全部会话（测试与排查用）。 */
  function snapshotAll() {
    return [...rows.entries()].map(([sessionId, row]) => ({ sessionId, ...row }))
  }

  return { read, readReport, apply, snapshotAll, keyOf, markElephantBridge }
}

const INVALID_RPC_ID = 'invalid'

function envelope(rpcId, result, status = 200) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function rpcError(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * 把状态查询与报告读取挂到 Connection 的 Fetch 注册表上。
 * 只需要 POST：客户端只读快照，不需要长连接。
 * @param {any} ctx 带 connection 服务的插件上下文
 * @param {ReturnType<typeof createPetStore>} store
 * @returns {boolean} 是否挂上
 */
export function registerPetRoutes(ctx, store) {
  const registry = ctx?.connection?.fetch
  if (!registry?.register) return false
  try {
    // 状态查询路由：/api/egm-pet/state（轻量轮询，不包含报告正文）
    registry.register({
      path: PET_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const contentType = String(request.headers.get('content-type') ?? '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase()
        if (contentType !== 'application/json') {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'content type must be application/json'), 415)
        }
        let message
        try {
          message = await request.json()
        } catch {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'body is not JSON'))
        }
        if (!message || typeof message !== 'object' || message.type !== 'client-request' || typeof message.rpcId !== 'string') {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'invalid client-request message'))
        }
        if (message.method !== PET_METHOD && message.method !== 'egm/state') {
          return envelope(message.rpcId, rpcError('gateway/bad-request', `unexpected method ${String(message.method)}`))
        }
        try {
          const payload = message.payload && typeof message.payload === 'object' ? message.payload : {}
          // 动作可用性由后端算，前端只显示与转发；任务记录损坏时如实返回 taskError，不静默当成"没有任务"。
          const view = buildTaskView({
            sessionId: payload.sessionId,
            workspace: typeof payload.workspace === 'string' ? payload.workspace : undefined,
            includeArchives: payload.wantArchives === true,
            includeEvidence: payload.wantEvidence === true,
          })
          const cfgWorkspace = String(view.workspace || (typeof payload.workspace === 'string' ? payload.workspace : '')).trim()
          return envelope(message.rpcId, {
            ok: true,
            value: {
              ...store.read(payload.sessionId),
              task: view.task,
              taskError: view.taskError,
              allowedActions: view.allowedActions,
              proceedGate: view.proceedGate,
              inFlightOpId: view.inFlightOpId,
              ops: view.ops,
              archives: view.archives,
              // 评审配置摘要：面板只显示预设与错误字段，不回传全文，也不改任何权限。
              config: cfgWorkspace === '' ? null : describeReviewConfigFor(cfgWorkspace),
              // 证据视图：评审记录/问题台账/影响面，只有前端明确要的时候才算（省一点轮询开销）。
              reviewRuns: view.reviewRuns,
              findings: view.findings,
              ledgerSummary: view.ledgerSummary,
              impact: view.impact,
            },
          })
        } catch (error) {
          return envelope(message.rpcId, rpcError('internal', String(error?.message ?? error)))
        }
      },
    })

    // 报告按需读取路由：/api/egm-pet/report（显式按会话与金鱼 ID 访问）
    registry.register({
      path: PET_REPORT_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const contentType = String(request.headers.get('content-type') ?? '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase()
        if (contentType !== 'application/json') {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'content type must be application/json'), 415)
        }
        let message
        try {
          message = await request.json()
        } catch {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'body is not JSON'))
        }
        if (!message || typeof message !== 'object' || message.type !== 'client-request' || typeof message.rpcId !== 'string') {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'invalid client-request message'))
        }
        if (message.method !== PET_REPORT_METHOD && message.method !== 'egm/report') {
          return envelope(message.rpcId, rpcError('gateway/bad-request', `unexpected method ${String(message.method)}`))
        }
        try {
          const payload = message.payload && typeof message.payload === 'object' ? message.payload : {}
          const reportRes = store.readReport(payload.sessionId, payload.goldfishId || payload.reportPath)
          if (!reportRes.ok) {
            return envelope(message.rpcId, rpcError('not-found', reportRes.error))
          }
          return envelope(message.rpcId, { ok: true, value: reportRes.value })
        } catch (error) {
          return envelope(message.rpcId, rpcError('internal', String(error?.message ?? error)))
        }
      },
    })

    // 评审门禁与许可实时快照读取路由：/api/egm-pet/review-access（只读 RPC，严禁作为模型工具）
    registry.register({
      path: PET_REVIEW_ACCESS_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const contentType = String(request.headers.get('content-type') ?? '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase()
        if (contentType !== 'application/json') {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'content type must be application/json'), 415)
        }
        let message
        try {
          message = await request.json()
        } catch {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'body is not JSON'))
        }
        if (!message || typeof message !== 'object' || message.type !== 'client-request' || typeof message.rpcId !== 'string') {
          return envelope(INVALID_RPC_ID, rpcError('gateway/bad-request', 'invalid client-request message'))
        }
        if (message.method !== PET_REVIEW_ACCESS_METHOD && message.method !== 'egm/review-access') {
          return envelope(message.rpcId, rpcError('gateway/bad-request', `unexpected method ${String(message.method)}`))
        }
        try {
          const payload = message.payload && typeof message.payload === 'object' ? message.payload : {}
          const snapshot = getReviewAccessSnapshot(payload.sessionId)
          return envelope(message.rpcId, { ok: true, value: snapshot })
        } catch (error) {
          return envelope(message.rpcId, rpcError('internal', String(error?.message ?? error)))
        }
      },
    })

    return true
  } catch (error) {
    console.error('[dsh-egm] pet route registration failed:', error)
    return false
  }
}
