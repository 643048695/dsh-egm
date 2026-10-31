// EGM 操作流水（Action Ops Ledger）
//
// 目的：按钮点击后到底发生了什么，必须有一条可查的账，而不是只靠聊天记录猜。
// 投递与执行分开记录（新方案 A1）：
//   - deliveryState：pending-send → delivered / unknown（入队后抛错不证明没送达）
//   - executionState：not-started → running / reported-done / failed / unknown（模型经 opId 报告）
//   - "RPC 成功""通知已提交""模型开始""模型报告完成"是四个不同事实，不许混写。
// 兼容字段 state 保留（pending-send/delivered/awaiting-confirm/failed/superseded），
// 由两个新字段合成，老读者仍然可读；新代码一律读 deliveryState/executionState。
// 铁律：
//   - 只记录，不自动重试、不代用户重发；重试复用原 operationId，不产生第二条；
//   - JSONL 追加写，单条损坏不影响其余记录；
//   - 严格按 sessionId 隔离，绝不跨会话读别人的账。

import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { safeSessionId } from './active-task.js'

/** 操作状态集合（兼容汇总态）。 */
export const OP_STATES = Object.freeze([
  'pending-send',     // 已创建，尚未提交给宿主
  'delivered',        // 命令执行成功、消息已交给宿主
  'awaiting-confirm', // 状态可能已变更，但结果未确认（不自动重试）
  'failed',           // 明确失败，可以重试
  'superseded',       // 被更新的操作覆盖（如同一任务连续点了两次）
])

/** 投递状态：只有宿主明确拒绝才算 failed，入队后异常一律 unknown。 */
export const DELIVERY_STATES = Object.freeze(['pending-send', 'delivered', 'unknown', 'failed'])
/** 执行状态：与投递无关，由模型进度报告或动作结果回填。 */
export const EXECUTION_STATES = Object.freeze(['not-started', 'running', 'reported-done', 'failed', 'unknown'])

/** 在途冷却：超过该时长 awaiting-confirm 不再拦截重复点击（毫秒）。 */
export const IN_FLIGHT_TTL_MS = 3 * 60 * 1000

/** 内存缓存（key: sessionId → ops 数组），避免每次轮询都读盘。 */
const OPS_CACHE = new Map()

/** 内存缓存最大条数（每会话）。 */
const MAX_CACHED_OPS = 50

/**
 * 计算某会话的操作流水文件路径：.egm/sessions/ops/<safeSessionId>.jsonl
 * @param {string} workspace
 * @param {string} sessionId
 * @returns {string}
 */
export function opsFilePath(workspace, sessionId) {
  return join(resolve(workspace), '.egm', 'sessions', 'ops', `${safeSessionId(sessionId)}.jsonl`)
}

/**
 * 生成操作 ID：时间 + 随机片段，够排重即可，不承担安全语义。
 * @returns {string}
 */
function newOpId() {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 追加一条操作记录到 JSONL 文件（同步、追加、原子性以行为单位）。
 * @param {string} filePath
 * @param {object} entry
 */
function appendOpLine(filePath, entry) {
  const dir = join(filePath, '..')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * 从磁盘读取某会话全部流水（尾部优先返回时倒序）。
 * 单行 JSON 损坏只跳过该行，不炸整个账本。
 * @param {string} filePath
 * @returns {object[]}
 */
function readAllOps(filePath) {
  let raw = ''
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const ops = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') ops.push(parsed)
    } catch {
      // 损坏行跳过
    }
  }
  return ops
}

/**
 * 更新内存缓存里的操作状态。
 * @param {string} sessionId
 * @param {string} opId
 * @param {object} patch
 */
function patchCachedOp(sessionId, opId, patch) {
  const cached = OPS_CACHE.get(sessionId)
  if (!cached) return
  const op = cached.find((item) => item.opId === opId)
  if (op) Object.assign(op, patch)
}

/**
 * 创建一条操作记录（pending-send）。
 * @param {{ sessionId: string, workspace?: string, taskId?: string|null, specRevision?: number|null, action: string, detail?: object }} params
 * @returns {object}
 */
export function createOp({ sessionId, workspace, taskId = null, specRevision = null, action, detail }) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) throw new Error('E_INVALID_SESSION: createOp 需要有效 sessionId')
  const now = Date.now()
  const op = {
    opId: newOpId(),
    sessionId: sid,
    taskId: taskId || null,
    specRevision: typeof specRevision === 'number' ? specRevision : null,
    action: String(action ?? ''),
    state: 'pending-send',
    deliveryState: 'pending-send',
    executionState: 'not-started',
    createdAt: now,
    updatedAt: now,
    detail: detail && typeof detail === 'object' ? detail : {},
  }
  try {
    appendOpLine(opsFilePath(workspace, sid), op)
  } catch {
    // 账本写失败不阻断业务动作本身；内存里仍保留这条，供本次反馈。
  }
  const cached = OPS_CACHE.get(sid) || []
  cached.unshift(op)
  OPS_CACHE.set(sid, cached.slice(0, MAX_CACHED_OPS))
  return op
}

/**
 * 由投递状态推导兼容汇总态（老读者只认 state）。
 * @param {string} deliveryState
 * @returns {string}
 */
function legacyStateOf(deliveryState) {
  if (deliveryState === 'delivered') return 'delivered'
  if (deliveryState === 'unknown') return 'awaiting-confirm'
  if (deliveryState === 'failed') return 'failed'
  return 'pending-send'
}

/**
 * 更新一条操作的状态。投递状态与执行状态分开写，同时维护兼容字段 state。
 * 不存在的 opId 返回 null；磁盘与内存缓存同步更新。
 *
 * @param {{ sessionId: string, workspace?: string, opId: string, state?: string,
 *           deliveryState?: string, executionState?: string, detail?: object }} params
 * @returns {object|null}
 */
export function updateOp({ sessionId, workspace, opId, state, deliveryState, executionState, detail }) {
  const sid = String(sessionId ?? '').trim()
  if (!sid || !opId) return null
  if (state && !OP_STATES.includes(state)) throw new Error(`E_OP_STATE_INVALID: 未知操作状态 ${state}`)
  if (deliveryState && !DELIVERY_STATES.includes(deliveryState)) {
    throw new Error(`E_OP_DELIVERY_INVALID: 未知投递状态 ${deliveryState}`)
  }
  if (executionState && !EXECUTION_STATES.includes(executionState)) {
    throw new Error(`E_OP_EXECUTION_INVALID: 未知执行状态 ${executionState}`)
  }

  const filePath = opsFilePath(workspace, sid)
  const all = readAllOps(filePath)
  const target = all.find((item) => item.opId === opId)
  if (!target) {
    // 内存里有但盘上没有（写盘失败过）：仍更新内存，保证本次会话内一致。
    const patch = { updatedAt: Date.now() }
    if (deliveryState) {
      patch.deliveryState = deliveryState
      patch.state = legacyStateOf(deliveryState)
    }
    if (executionState) patch.executionState = executionState
    if (state) patch.state = state
    if (detail) patch.detail = detail
    patchCachedOp(sid, opId, patch)
    return null
  }

  if (deliveryState) {
    target.deliveryState = deliveryState
    target.state = legacyStateOf(deliveryState)
  }
  if (executionState) target.executionState = executionState
  if (state) target.state = state
  target.updatedAt = Date.now()
  if (detail && typeof detail === 'object') {
    target.detail = { ...(target.detail || {}), ...detail }
  }

  // JSONL 追加式更新：重写整份文件（记录量小，页面级一致优先于追加语义）
  try {
    const dir = join(filePath, '..')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmpPath = `${filePath}.tmp.${Date.now()}`
    fs.writeFileSync(tmpPath, all.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')
    fs.renameSync(tmpPath, filePath)
  } catch {
    // 写盘失败保留内存态
  }
  patchCachedOp(sid, opId, target)
  return target
}

/**
 * 读取单条操作记录（不存在返回 null）。
 * @param {{ sessionId: string, workspace?: string, opId: string }} params
 * @returns {object|null}
 */
export function getOp({ sessionId, workspace, opId }) {
  const sid = String(sessionId ?? '').trim()
  if (!sid || !opId) return null
  const all = readAllOps(opsFilePath(workspace, sid))
  const fromDisk = all.find((item) => item.opId === opId)
  if (fromDisk) return fromDisk
  const cached = OPS_CACHE.get(sid) || []
  return cached.find((item) => item.opId === opId) || null
}

/**
 * 模型进度报告回填执行状态（只认本会话、本任务的操作；不能写许可/批准）。
 * 同一操作已完成时拒绝再改成 running，避免"重复开始"看起来像成功。
 *
 * @param {{ sessionId: string, workspace?: string, opId: string, executionState: string,
 *           detail?: object }} params
 * @returns {{ ok: boolean, op?: object, code?: string, error?: string }}
 */
export function recordExecutionProgress({ sessionId, workspace, opId, executionState, detail }) {
  if (!EXECUTION_STATES.includes(executionState)) {
    return { ok: false, code: 'E_OP_EXECUTION_INVALID', error: `未知执行状态 ${executionState}` }
  }
  const op = getOp({ sessionId, workspace, opId })
  if (!op) return { ok: false, code: 'E_OP_NOT_FOUND', error: '这条操作记录不存在，或不属于当前会话。' }
  if (op.executionState === 'reported-done' && executionState === 'running') {
    return { ok: false, code: 'E_OP_ALREADY_DONE', error: '这条操作已经报过完成，不接受再次报"开始"。' }
  }
  const updated = updateOp({ sessionId, workspace, opId, executionState, detail })
  return { ok: true, op: updated || op }
}

/**
 * 创建或复用操作：同一任务同一动作若仍有未确认的在途记录，复用原 opId（attempts+1），
 * 不制造第二条执行记录（新方案 §4.1「前端重复点击复用同一个操作」）。
 *
 * @param {{ sessionId: string, workspace?: string, taskId?: string|null, specRevision?: number|null,
 *           action: string, detail?: object }} params
 * @returns {{ op: object, reused: boolean }}
 */
export function createOrReuseOp({ sessionId, workspace, taskId = null, specRevision = null, action, detail }) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) throw new Error('E_INVALID_SESSION: createOrReuseOp 需要有效 sessionId')
  const ops = listRecentOps({ sessionId: sid, workspace, taskId, limit: 50 })
  const reusable = ops.find(
    (item) =>
      item.state !== 'superseded' &&
      item.action === action &&
      (!taskId || item.taskId === taskId) &&
      (item.deliveryState === 'pending-send' || item.deliveryState === 'unknown'),
  )
  if (reusable) {
    const attempts = Number(reusable.detail?.attempts || 1) + 1
    const updated = updateOp({
      sessionId: sid,
      workspace,
      opId: reusable.opId,
      deliveryState: 'pending-send',
      detail: { ...(detail || {}), attempts, retriedAt: Date.now() },
    })
    return { op: updated || reusable, reused: true }
  }
  return { op: createOp({ sessionId: sid, workspace, taskId, specRevision, action, detail }), reused: false }
}

/**
 * 读取某会话最近的操作流水（新的在前）。
 * @param {{ sessionId: string, workspace?: string, taskId?: string|null, limit?: number }} params
 * @returns {object[]}
 */
export function listRecentOps({ sessionId, workspace, taskId = null, limit = 20 }) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return []
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20
  let ops = readAllOps(opsFilePath(workspace, sid))
  if (!ops.length) ops = OPS_CACHE.get(sid) || []
  if (taskId) ops = ops.filter((item) => item.taskId === taskId)
  return ops
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, max)
}

/**
 * 查找某会话「正在途中」的操作（投递待确认或未送达）。
 * 用于决定是否拒绝同一任务的重复点击（E_OP_IN_FLIGHT）。
 * 超过 IN_FLIGHT_TTL_MS 的未知投递不再拦截——用户已核对过状态就可以重试，
 * 但重试仍复用原 operationId，不会制造第二条执行记录。
 *
 * @param {{ sessionId: string, workspace?: string, taskId?: string|null, now?: number }} params
 * @returns {object|null}
 */
export function findInFlightOp({ sessionId, workspace, taskId = null, now = Date.now() }) {
  const ops = listRecentOps({ sessionId, workspace, taskId, limit: 20 })
  return (
    ops.find((item) => {
      if (item.state === 'superseded') return false
      const delivery = item.deliveryState || (item.state === 'awaiting-confirm' ? 'unknown' : item.state)
      if (delivery !== 'pending-send' && delivery !== 'unknown') return false
      const age = now - Number(item.updatedAt || item.createdAt || 0)
      return age < IN_FLIGHT_TTL_MS
    }) || null
  )
}

/**
 * 把某任务的在途操作标为 superseded（例如用户在面板里确认了最新状态之后调用）。
 * @param {{ sessionId: string, workspace?: string, taskId?: string|null }} params
 * @returns {number} 更新的条数
 */
export function supersedeInFlightOps({ sessionId, workspace, taskId = null }) {
  const ops = listRecentOps({ sessionId, workspace, taskId, limit: 50 })
  let count = 0
  for (const op of ops) {
    if (op.state === 'superseded') continue
    const delivery = op.deliveryState || (op.state === 'awaiting-confirm' ? 'unknown' : op.state)
    if (delivery === 'pending-send' || delivery === 'unknown') {
      updateOp({ sessionId, workspace, opId: op.opId, state: 'superseded' })
      count += 1
    }
  }
  return count
}
