// EGM 评审门禁与许可集中控制器 (Review Access Controller)
//
// 核心职责：
//   1. 统一管理命令门控（Gate 派发窗口：2 小时 / 最多 20 次）与非隔离许可（Unsafe Permit：10 分钟 / 最多 6 次）；
//   2. 复用原有许可表与配额，确保与原有 dispatch 派发、测试完全兼容；
//   3. 基于 WeakMap 绑定真实 agent 对象，同时维护会话维度活跃 agent 弱引用（WeakRef），
//      使外部只读 RPC 能够即时通过 sessionId 读取真实状态，绝不依靠过期或推测的 store 旧数据；
//   4. 提供原子化的一键授予（grantReviewAccess）与撤销（revokeReviewAccess）；
//   5. 严格隔离会话，找不到当前会话 active agent 时状态一律 closed，未传 sessionId 绝不回退最近会话。
//
// 安全与边界说明（诚实声明）：
//   - 未向宿主注册任何可由模型调用的授权 tool，外部 HTTP RPC 接口严格只读；
//   - 授权依赖 UI 明确点击并经宿主 command 严格参数检查（要求显式确认语「确认无隔离」）；
//   - 命令机制依赖宿主环境边界，不是形式化密码学硬权限隔离边界，仍可能受到 prompt 诱导等潜在威胁；
//   - 本插件严格默认 fail-closed，非隔离许可下每次评审结果强制标注 strictGoldfishReview:false。

/** 非隔离许可：用户确认后得到的短时额度。 */
export const UNSAFE_PERMIT_TTL_MS = 10 * 60 * 1000
export const UNSAFE_PERMIT_USES = 6

/** 命令门控：开启的会话内派发窗口。 */
export const GATE_TTL_MS = 2 * 60 * 60 * 1000
export const GATE_MAX_DISPATCHES = 20

/** 显式确认词（防误触，同 legacy 用户命令边界）。 */
export const CONFIRMATION_PHRASE = '确认无隔离'

/**
 * 会话级许可表（原有 WeakMap，以 agent 为 key）。
 */
const PERMITS = new WeakMap()
const GATES = new WeakMap()

/**
 * 活跃会话与其 agent 的弱引用映射表。
 * 键为稳定非空的 sessionId，值为 WeakRef<agent>。
 * 用于按 sessionId 只读查询实时门禁与许可状态，避免持有强引用阻碍 GC。
 * @type {Map<string, WeakRef<object>>}
 */
const ACTIVE_AGENTS = new Map()

/**
 * 稳定会话身份提取。拿不到或非空字符串返回 null（此时一律 fail-closed）。
 * @param {any} agent
 * @returns {string|null}
 */
export function sessionIdOf(agent) {
  const id = agent?.session?.header?.id ?? agent?.session?.id ?? agent?.session?.header?.sessionId
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

/**
 * 登记活跃 agent。
 * @param {any} agent
 */
export function registerActiveAgent(agent) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return
  if (typeof WeakRef !== 'undefined') {
    ACTIVE_AGENTS.set(sessionId, new WeakRef(agent))
  }
}

/**
 * 注销活跃 agent。
 * @param {any} agent
 */
export function unregisterActiveAgent(agent) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return
  const ref = ACTIVE_AGENTS.get(sessionId)
  if (ref) {
    const derefAgent = ref.deref()
    if (!derefAgent || derefAgent === agent) {
      ACTIVE_AGENTS.delete(sessionId)
    }
  }
}

/**
 * 获取某个 session 当前活跃且存活的 agent。
 * @param {string} sessionId
 * @returns {object|null}
 */
export function getActiveAgent(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
  const key = sessionId.trim()
  const ref = ACTIVE_AGENTS.get(key)
  if (!ref) return null
  const agent = ref.deref()
  if (!agent) {
    ACTIVE_AGENTS.delete(key)
    return null
  }
  // 严格核验：该 agent 当前真实的 session 身份必须与请求的 key 严格一致；
  // 若发生会话身份切换，立即清理过期旧映射并返回 null (fail-closed)。
  if (sessionIdOf(agent) !== key) {
    ACTIVE_AGENTS.delete(key)
    return null
  }
  return agent
}

/**
 * 内部读取 agent 的条目并核验 sessionId。
 */
function scopedGet(store, agent) {
  if (!agent || typeof agent !== 'object') return null
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return null
  const entry = store.get(agent)
  return entry && entry.sessionId === sessionId ? entry : null
}

/**
 * 发放非隔离许可。
 * 无法确认会话身份时返回 null。
 * @param {object} agent
 * @param {string} [reason='']
 */
export function grantUnsafePermit(agent, reason = '') {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return null
  registerActiveAgent(agent)
  const permit = {
    sessionId,
    reason: String(reason ?? ''),
    expiresAt: Date.now() + UNSAFE_PERMIT_TTL_MS,
    remaining: UNSAFE_PERMIT_USES,
  }
  PERMITS.set(agent, permit)
  return permit
}

/**
 * 撤销非隔离许可。
 * @param {object} agent
 */
export function revokeUnsafePermit(agent) {
  if (agent && typeof agent === 'object') {
    PERMITS.delete(agent)
  }
}

/**
 * 只读检查：有未过期且未用完的非隔离许可则返回快照，否则返回 null。
 * @param {object} agent
 */
export function peekUnsafePermit(agent) {
  const permit = scopedGet(PERMITS, agent)
  if (!permit) return null
  if (Date.now() >= permit.expiresAt || permit.remaining <= 0) {
    PERMITS.delete(agent)
    return null
  }
  return { ...permit }
}

/**
 * 取用一次非隔离许可配额。没有可用许可返回 null。
 * @param {object} agent
 */
export function takeUnsafePermit(agent) {
  const permit = peekUnsafePermit(agent)
  if (!permit) return null
  permit.remaining -= 1
  PERMITS.set(agent, permit)
  return { ...permit }
}

/**
 * 打开派发窗口。无法确认会话身份时返回 null。
 * @param {object} agent
 */
export function openGate(agent) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return null
  registerActiveAgent(agent)
  const gate = {
    sessionId,
    openedAt: Date.now(),
    expiresAt: Date.now() + GATE_TTL_MS,
    remaining: GATE_MAX_DISPATCHES,
  }
  GATES.set(agent, gate)
  return gate
}

/**
 * 关闭派发窗口。
 * @param {object} agent
 */
export function closeGate(agent) {
  if (agent && typeof agent === 'object') {
    GATES.delete(agent)
  }
}

/**
 * 只读检查：检查派发窗口是否开着（不消耗次数）。
 * @param {object} agent
 */
export function peekGate(agent) {
  const gate = scopedGet(GATES, agent)
  if (!gate) return null
  if (Date.now() >= gate.expiresAt || gate.remaining <= 0) {
    GATES.delete(agent)
    return null
  }
  return { ...gate }
}

/**
 * 取用一次派发窗口配额。没有返回 null。
 * @param {object} agent
 */
export function takeGate(agent) {
  const gate = peekGate(agent)
  if (!gate) return null
  gate.remaining -= 1
  GATES.set(agent, gate)
  return { ...gate }
}

/**
 * 用户侧一键操作：同时开启派发窗口 (Gate) 与发放非隔离许可 (Unsafe Permit)。
 * @param {object} agent
 * @param {string} confirmation - 用户确认语（必须为「确认无隔离」）
 * @returns {{ ok: boolean, error?: string, sessionId?: string, gate?: object, unsafePermit?: object }}
 */
export function grantReviewAccess(agent, confirmation) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) {
    return { ok: false, error: '无法验证当前会话身份，拒绝授权（fail-closed）。请确认命令在会话内执行后重试。' }
  }
  const phrase = String(confirmation ?? '').trim()
  if (phrase !== CONFIRMATION_PHRASE) {
    return {
      ok: false,
      error: `未开启：只读保护未经验证，评审可能修改文件；若要继续，必须原样输入：${CONFIRMATION_PHRASE}。`,
    }
  }

  registerActiveAgent(agent)
  const gate = openGate(agent)
  const permit = grantUnsafePermit(agent, phrase)
  if (!gate || !permit) {
    return { ok: false, error: '授权初始化失败，无法写入会话门禁表。' }
  }

  return {
    ok: true,
    sessionId,
    gate,
    unsafePermit: permit,
  }
}

/**
 * 关闭按钮操作：撤销许可（同时关闭派发窗口，恢复默认拒绝派发；不影响正在运行的任务）。
 * @param {object} agent
 * @returns {{ ok: boolean, sessionId?: string }}
 */
export function revokeReviewAccess(agent) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) {
    return { ok: false, error: '无法验证当前会话身份。' }
  }
  revokeUnsafePermit(agent)
  closeGate(agent)
  unregisterActiveAgent(agent)
  return { ok: true, sessionId }
}

/**
 * 实时只读快照：严格按当前 sessionId 查询当前会话真实的 gate 和 unsafe permit 状态。
 * 必须即时从同一 agent / WeakMap 读取，不猜测 store 旧状态。
 * 如果没有 sessionId 或找不到活跃 agent，一律返回 closed 状态（默认关闭，fail-closed）。
 *
 * @param {string|null|undefined} sessionId
 * @returns {{
 *   sessionId: string|null,
 *   allowed: boolean,
 *   gate: { open: boolean, remaining: number, expiresAt: number },
 *   unsafePermit: { granted: boolean, remaining: number, expiresAt: number, reason: string|null }
 * }}
 */
export function getReviewAccessSnapshot(sessionId) {
  const key = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (key === '') {
    return {
      sessionId: null,
      allowed: false,
      gate: { open: false, remaining: 0, expiresAt: 0 },
      unsafePermit: { granted: false, remaining: 0, expiresAt: 0, reason: null },
    }
  }

  const agent = getActiveAgent(key)
  if (!agent) {
    return {
      sessionId: key,
      allowed: false,
      gate: { open: false, remaining: 0, expiresAt: 0 },
      unsafePermit: { granted: false, remaining: 0, expiresAt: 0, reason: null },
    }
  }

  const gate = peekGate(agent)
  const permit = peekUnsafePermit(agent)

  const isGateOpen = Boolean(gate && gate.remaining > 0)
  const isPermitGranted = Boolean(permit && permit.remaining > 0)

  return {
    sessionId: key,
    allowed: isGateOpen && isPermitGranted,
    gate: {
      open: isGateOpen,
      remaining: isGateOpen ? gate.remaining : 0,
      expiresAt: isGateOpen ? gate.expiresAt : 0,
    },
    unsafePermit: {
      granted: isPermitGranted,
      remaining: isPermitGranted ? permit.remaining : 0,
      expiresAt: isPermitGranted ? permit.expiresAt : 0,
      reason: isPermitGranted ? permit.reason : null,
    },
  }
}
