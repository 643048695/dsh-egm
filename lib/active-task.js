// EGM 同象任务持久化与生命周期管理 (Active Task Lifecycle & Persistence)
//
// 核心职责：
//   1. 维持会话（Session）与工作区（Workspace）维度的单象任务（Task）持久化状态；
//   2. /egm 命令首次执行时创建任务，后续 /egm 消息识别为同一任务的需求补充与增量推进（不重置图纸或重新开窗）；
//   3. 任务数据以 .egm/sessions/<safeSessionId>.json 形式原子落盘，保存当前任务记录，供界面刷新后读取；
//   4. 按会话与工作区核对记录归属：仅当 sessionId 且 workspace 严格匹配时才载入；
//   5. 状态同步：对外暴露 readActiveTaskForSession(sessionId, options)，供 pet-state 与前端实时查询；
//   6. 显式新任务与归档留存：/egm-new 或 /egm-action new 命令归档旧任务，并在 .egm/sessions/archive/ 备份历史。
//
// 版本语义（三种，互不替代）：
//   - revision     ：任务**记录**版本。每次真正写入记录都自增，只用于审计与"记录被改过"的判断。
//   - specRevision ：方案**内容**版本，也是动作卡**绑定**版本。只有确认发生实质变更
//                    （用户明确改需求、图纸修订、推进/结项等用户动作）才前进。
//                    普通追问、状态轮询、只记录会话活动都不改变它。
//   - 旧记录兼容：老文件没有 specRevision 时按 1 起步，**绝不**用旧 revision 冒充
//                    已证明的图纸版本；因此升级前生成的动作卡一律按过期处理（保守，不自动套用）。

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { getActiveAgent } from './review-access.js'

/** 任务合法阶段列表（基础阶段，不臆造虚构阶段）。 */
export const TASK_PHASES = Object.freeze([
  'prep',     // 准备阶段：刚启动或正在梳理需求
  'design',   // 出图纸阶段：正在或已产出 .egm/ 下的设计图纸
  'review',   // 评审阶段：正在筹备或派发金鱼评审
  'revise',   // 修订阶段：根据评审意见或用户反馈修订图纸
  'proceed',  // 确认阶段：方案已通过，推进后续工序或落地实施
  'hold',     // 暂缓阶段：方案或任务被用户挂起/暂缓
])

/** 任务合法状态列表。 */
export const TASK_STATUSES = Object.freeze([
  'active',    // 进行中
  'held',      // 暂缓
  'archived',  // 已归档
  'completed', // 已完成
])

/** /egm-action 允许的固定动作列表（都是用户显式动作，不靠关键词猜测）。 */
export const TASK_ACTIONS = Object.freeze([
  'revise',   // 修订方案
  'review',   // 发起评审
  'proceed',  // 确认方案并继续
  'hold',     // 暂缓/搁置
  'new',      // 归档当前任务并准备发起新任务
  'resume',   // 从暂缓恢复推进（只有显式动作才解除暂停）
  'complete', // 结项：方案已完成，与归档不同，允许之后显式重开
  'reopen',   // 重开已结项/已暂缓的方案
])

/** 方案内容版本（动作卡绑定版本）的起始值。 */
export const SPEC_REVISION_DEFAULT = 1

/** 内存中活跃任务缓存（key: sessionId）。 */
const ACTIVE_TASKS = new Map()

/** 会话所在工作区路径记录缓存（key: sessionId）。 */
const SESSION_WORKSPACES = new Map()

/**
 * 将 sessionId 转为跨平台安全的文件名片段。
 * @param {string} id
 * @returns {string}
 */
export function safeSessionId(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * 从 agent 对象提取真实工作区绝对路径。
 * 覆盖宿主核心真实字段：agent.header.cwd、agent.session.header.cwd 等。
 * @param {any} agent
 * @returns {string}
 */
export function workspaceOf(agent) {
  const ws =
    agent?.header?.cwd ??
    agent?.session?.header?.cwd ??
    agent?.session?.header?.workingDirectory ??
    agent?.session?.cwd ??
    agent?.workspace ??
    agent?.cwd
  if (typeof ws === 'string' && ws.trim() !== '') {
    return resolve(ws.trim())
  }
  return resolve(process.cwd())
}

/**
 * 计算任务落盘绝对路径。
 * @param {string} workspace
 * @param {string} sessionId
 * @returns {string}
 */
export function taskFilePath(workspace, sessionId) {
  const safeId = safeSessionId(sessionId)
  return join(resolve(workspace), '.egm', 'sessions', `${safeId}.json`)
}

/**
 * 计算任务独立历史归档目录。
 * @param {string} workspace
 * @returns {string}
 */
export function archiveDirPath(workspace) {
  return join(resolve(workspace), '.egm', 'sessions', 'archive')
}

/** 归档态判断（含历史遗留的 closed）。 */
function isArchivedStatus(status) {
  return status === 'archived' || status === 'closed'
}

/**
 * 补齐任务记录的必备字段；不改动语义，只做缺省与类型收敛。
 * 旧记录（无 specRevision）按 1 起步，不继承 revision。
 * @param {object} task
 * @returns {object}
 */
function normalizeTask(task) {
  const out = { ...task }
  out.id = out.id || out.taskId || `egm-${safeSessionId(out.sessionId)}`
  out.taskId = out.taskId || out.id
  out.title = out.title || out.currentRequest || out.originalRequest || 'EGM 任务'
  out.revision = typeof out.revision === 'number' && out.revision > 0 ? out.revision : 1
  out.specRevision =
    typeof out.specRevision === 'number' && out.specRevision > 0
      ? out.specRevision
      : SPEC_REVISION_DEFAULT
  out.status = out.status || 'active'
  out.phase = out.phase || 'prep'
  out.history = Array.isArray(out.history) ? out.history : []
  out.heldFrom =
    typeof out.heldFrom === 'string' && TASK_PHASES.includes(out.heldFrom) && out.heldFrom !== 'hold'
      ? out.heldFrom
      : null
  out.lastUserChatAt = typeof out.lastUserChatAt === 'number' ? out.lastUserChatAt : null
  out.workflow = typeof out.workflow === 'string' && out.workflow.trim() ? out.workflow.trim() : 'gate'
  return out
}

/**
 * 同步将任务数据原子写入工作区磁盘文件。
 * 白名单落盘：只有这里列出的字段会持久化，防止把临时字段写进记录。
 * @param {object} task
 * @returns {object}
 */
export function writeActiveTask(task) {
  if (!task || typeof task !== 'object' || !task.sessionId) {
    throw new Error('E_INVALID_TASK: 任务对象缺少必要的 sessionId')
  }

  const sid = String(task.sessionId).trim()
  const ws = resolve(task.workspace || process.cwd())
  const dir = join(ws, '.egm', 'sessions')

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const targetPath = taskFilePath(ws, sid)
  const tmpPath = join(
    dir,
    `${safeSessionId(sid)}.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  )

  const normalized = normalizeTask(task)
  const payload = {
    id: normalized.id,
    taskId: normalized.taskId,
    sessionId: sid,
    workspace: ws,
    title: normalized.title,
    revision: normalized.revision,
    specRevision: normalized.specRevision,
    status: normalized.status,
    phase: normalized.phase,
    workflow: normalized.workflow,
    heldFrom: normalized.heldFrom,
    originalRequest: normalized.originalRequest || '',
    currentRequest: normalized.currentRequest || '',
    docPath: normalized.docPath || null,
    lastUserChatAt: normalized.lastUserChatAt,
    history: normalized.history,
    createdAt: typeof normalized.createdAt === 'number' ? normalized.createdAt : Date.now(),
    updatedAt: Date.now(),
  }

  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tmpPath, targetPath)

  SESSION_WORKSPACES.set(sid, ws)
  // 保持内存中对象完整，包括归档状态
  ACTIVE_TASKS.set(sid, payload)

  return payload
}

/**
 * 解析某会话应使用的工作区（agent 优先，其次缓存，最后进程 cwd）。
 * @param {string} sid
 * @returns {string}
 */
function workspaceForSession(sid) {
  let ws = null
  const agent = getActiveAgent(sid)
  if (agent) ws = workspaceOf(agent)
  if (!ws && SESSION_WORKSPACES.has(sid)) ws = SESSION_WORKSPACES.get(sid)
  if (!ws) ws = resolve(process.cwd())
  return ws
}

/**
 * 读取任务记录**健康状态**：区分「没有任务」「记录损坏」「暂时读不了」。
 * 读取异常不能等同「没有任务」，否则会静默新建并覆盖用户方案。
 *
 * @param {string} sessionId
 * @param {{ includeArchived?: boolean }} [options={}]
 * @returns {{ state: 'ok'|'absent'|'corrupt'|'unreadable', task: object|null, path: string|null, error: string|null }}
 */
export function readTaskRecordStatus(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { state: 'absent', task: null, path: null, error: 'E_INVALID_SESSION' }
  }
  const sid = sessionId.trim()
  const ws = workspaceForSession(sid)
  const filePath = taskFilePath(ws, sid)

  // 1. 内存缓存优先（核验工作区归属）
  const memoryTask = ACTIVE_TASKS.get(sid)
  if (memoryTask && memoryTask.workspace === ws) {
    const visible = Boolean(options.includeArchived) || !isArchivedStatus(memoryTask.status)
    return { state: 'ok', task: visible ? memoryTask : null, path: filePath, error: null }
  }

  // 2. 磁盘读取：不存在 / 损坏 / 暂不可读 三类分开报
  let raw = null
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'absent', task: null, path: filePath, error: null }
    }
    return { state: 'unreadable', task: null, path: filePath, error: code || 'E_READ_FAILED' }
  }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'corrupt', task: null, path: filePath, error: 'E_PARSE_FAILED' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'corrupt', task: null, path: filePath, error: 'E_SHAPE_INVALID' }
  }
  // 严格核验会话 ID 与工作区归属（防止串读/串写）
  if (parsed.sessionId !== sid) {
    return { state: 'corrupt', task: null, path: filePath, error: 'E_SESSION_MISMATCH' }
  }
  if (parsed.workspace && resolve(parsed.workspace) !== ws) {
    return { state: 'corrupt', task: null, path: filePath, error: 'E_WORKSPACE_MISMATCH' }
  }

  const task = normalizeTask(parsed)
  SESSION_WORKSPACES.set(sid, ws)
  ACTIVE_TASKS.set(sid, task)

  if (!options.includeArchived && isArchivedStatus(task.status)) {
    return { state: 'ok', task: null, path: filePath, error: null }
  }
  return { state: 'ok', task, path: filePath, error: null }
}

/**
 * 依据 sessionId 读取当前会话的持久化任务记录。
 * 供 pet-state 状态轮询及命令校验使用（完全同步）。
 * 读取失败返回 null（需要区分故障时改用 readTaskRecordStatus）。
 *
 * @param {string} sessionId
 * @param {{ includeArchived?: boolean }} [options={}]
 * @returns {object|null}
 */
export function readActiveTaskForSession(sessionId, options = {}) {
  const status = readTaskRecordStatus(sessionId, options)
  return status.state === 'ok' ? status.task : null
}

/**
 * 只记录「会话里有普通用户发言」这一活动，不改需求、不改图纸版本、不解除暂停。
 * 纯内存，不落盘：活动时间不是任务记录的一部分，重启后重新积累即可。
 *
 * @param {string} sessionId
 * @param {string} [text]
 * @returns {object|null}
 */
export function noteUserChat(sessionId, text = '') {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return null
  const cached = ACTIVE_TASKS.get(sid)
  if (!cached) return null
  cached.lastUserChatAt = Date.now()
  const preview = String(text ?? '').trim().slice(0, 80)
  if (preview) cached.lastUserChatPreview = preview
  return cached
}

/**
 * 将任务归档并另外持久化至 archive/ 独立文件，避免旧方案仅在口头上留存。
 * @param {string} sessionId
 * @param {{ note?: string }} [options={}]
 * @returns {object|null}
 */
export function archiveActiveTask(sessionId, options = {}) {
  const current = readActiveTaskForSession(sessionId, { includeArchived: true })
  if (!current) return null
  const task = { ...current, history: [...current.history] }

  // 若已是归档态，直接返回
  if (isArchivedStatus(task.status)) {
    return task
  }

  task.status = 'archived'
  task.revision = (typeof task.revision === 'number' ? task.revision : 1) + 1
  task.specRevision = (typeof task.specRevision === 'number' ? task.specRevision : SPEC_REVISION_DEFAULT) + 1
  task.history.push({
    timestamp: Date.now(),
    type: 'archive',
    revision: task.revision,
    specRevision: task.specRevision,
    note: options.note || '任务已归档',
  })
  task.updatedAt = Date.now()

  // 保存到单独的 archive/ 历史归档目录，确保持久留存
  try {
    const ws = resolve(task.workspace || process.cwd())
    const archiveDir = archiveDirPath(ws)
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true })
    }
    const safeTaskId = safeSessionId(task.taskId || task.id)
    const archiveFilename = `${safeSessionId(task.sessionId)}-${safeTaskId}-${Date.now()}.json`
    fs.writeFileSync(join(archiveDir, archiveFilename), JSON.stringify(task, null, 2), 'utf8')
  } catch (error) {
    throw new Error('E_TASK_ARCHIVE_FAILED: ' + (error?.message || String(error)))
  }

  return writeActiveTask(task)
}

/**
 * 列出某会话的历史归档方案（新的在前），供面板「历史方案」使用。
 * 单条解析失败只计数，不阻断列表。
 *
 * @param {string} workspace
 * @param {string} sessionId
 * @param {{ limit?: number }} [options={}]
 * @returns {{ items: object[], broken: number }}
 */
export function listArchivedTasks(workspace, sessionId, options = {}) {
  const ws = resolve(workspace || process.cwd())
  const sid = String(sessionId ?? '').trim()
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 10
  const dir = archiveDirPath(ws)
  const out = { items: [], broken: 0 }

  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return out
  }

  const prefix = sid ? `${safeSessionId(sid)}-` : ''
  const files = names
    .filter((name) => name.endsWith('.json') && (!prefix || name.startsWith(prefix)))
    .map((name) => {
      let mtime = 0
      try {
        mtime = fs.statSync(join(dir, name)).mtimeMs || 0
      } catch {
        mtime = 0
      }
      return { name, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)

  for (const file of files) {
    if (out.items.length >= limit) break
    try {
      const parsed = JSON.parse(fs.readFileSync(join(dir, file.name), 'utf8'))
      if (!parsed || typeof parsed !== 'object') {
        out.broken += 1
        continue
      }
      const history = Array.isArray(parsed.history) ? parsed.history : []
      const last = history.length ? history[history.length - 1] : null
      out.items.push({
        file: file.name,
        taskId: parsed.taskId || parsed.id || '',
        title: parsed.title || parsed.currentRequest || parsed.originalRequest || 'EGM 方案',
        status: parsed.status || 'archived',
        phase: parsed.phase || '',
        revision: typeof parsed.revision === 'number' ? parsed.revision : 1,
        specRevision:
          typeof parsed.specRevision === 'number' ? parsed.specRevision : SPEC_REVISION_DEFAULT,
        docPath: parsed.docPath || null,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : null,
        archivedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : file.mtime,
        note: last && typeof last.note === 'string' ? last.note : '',
      })
    } catch {
      out.broken += 1
    }
  }
  return out
}

/**
 * 按文件名读取一条归档记录（只接受 archive 目录内的纯文件名）。
 * @param {string} workspace
 * @param {string} fileName
 * @returns {{ ok: true, task: object } | { ok: false, code: string, error: string }}
 */
export function readArchivedTask(workspace, fileName) {
  const ws = resolve(workspace || process.cwd())
  const name = String(fileName ?? '').trim()
  const invalid = { ok: false, code: 'E_ARCHIVE_NAME_INVALID', error: '归档文件名不合法。' }
  if (!name || name !== basename(name) || name.includes('/') || name.includes('\\')) return invalid
  if (!name.endsWith('.json')) return invalid

  const dir = resolve(archiveDirPath(ws))
  const full = resolve(join(dir, name))
  if (full !== join(dir, name)) return invalid

  let raw = ''
  try {
    raw = fs.readFileSync(full, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, code: 'E_ARCHIVE_NOT_FOUND', error: '归档记录不存在。' }
    }
    return { ok: false, code: 'E_ARCHIVE_UNREADABLE', error: '归档记录暂时无法读取。' }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'E_ARCHIVE_CORRUPT', error: '归档记录内容损坏。' }
    }
    return { ok: true, task: normalizeTask(parsed) }
  } catch {
    return { ok: false, code: 'E_ARCHIVE_CORRUPT', error: '归档记录内容损坏。' }
  }
}

/**
 * 恢复一条历史归档方案为当前任务。
 * 规则：
 *   - 若当前已有未归档任务，先归档它，绝不覆盖；
 *   - 图纸路径沿用归档记录（归档只存路径，不存文件内容快照；文件缺失由界面提示）；
 *   - 不恢复任何评审许可/派发窗口（许可是短时的，不能跨会话恢复）；
 *   - specRevision 前进，恢复前生成的动作卡一律作废。
 *
 * @param {{ sessionId: string, workspace?: string, fileName: string, note?: string }} params
 * @returns {object}
 */
export function restoreArchivedTask({ sessionId, workspace, fileName, note }) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) throw new Error('E_INVALID_SESSION: 必须提供有效的 sessionId')
  const ws = resolve(workspace || process.cwd())

  const read = readArchivedTask(ws, fileName)
  if (!read.ok) throw new Error(`${read.code}: ${read.error}`)

  const archived = read.task
  if (archived.sessionId && archived.sessionId !== sid) {
    throw new Error('E_ARCHIVE_SESSION_MISMATCH: 归档记录属于其他会话，拒绝恢复。')
  }
  if (archived.workspace && resolve(archived.workspace) !== ws) {
    throw new Error('E_ARCHIVE_WORKSPACE_MISMATCH: 归档记录属于其他工作区，拒绝恢复。')
  }

  const record = readTaskRecordStatus(sid, { includeArchived: true })
  if (record.state === 'corrupt' || record.state === 'unreadable') {
    throw new Error(
      'E_TASK_RECORD_UNREADABLE: 当前任务记录存在但无法读取（' +
        (record.path || '') +
        '），为避免覆盖未恢复。'
    )
  }
  if (record.task && !isArchivedStatus(record.task.status)) {
    archiveActiveTask(sid, { note: '恢复历史方案前归档当前方案' })
  }

  const now = Date.now()
  const restored = normalizeTask({
    ...archived,
    sessionId: sid,
    workspace: ws,
    status: archived.phase === 'hold' ? 'held' : 'active',
    revision: (typeof archived.revision === 'number' ? archived.revision : 1) + 1,
    specRevision:
      (typeof archived.specRevision === 'number' ? archived.specRevision : SPEC_REVISION_DEFAULT) + 1,
    history: [
      ...(Array.isArray(archived.history) ? archived.history : []),
      {
        timestamp: now,
        type: 'restore',
        archiveFile: fileName,
        revision: (typeof archived.revision === 'number' ? archived.revision : 1) + 1,
        specRevision:
          (typeof archived.specRevision === 'number' ? archived.specRevision : SPEC_REVISION_DEFAULT) + 1,
        note: note || '恢复历史方案',
      },
    ],
    updatedAt: now,
  })

  return writeActiveTask(restored)
}

/**
 * 为会话创建全新的活跃任务。若存在历史任务，先原子归档至 archive 备份。
 * 任务记录损坏或暂时不可读时拒绝新建，避免静默覆盖用户方案。
 * @param {{ sessionId: string, workspace?: string, request: string }} params
 * @returns {object}
 */
export function createActiveTask({ sessionId, workspace, request, workflow = 'gate' }) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('E_INVALID_SESSION: 必须提供有效的 sessionId')
  }

  const sid = sessionId.trim()
  const ws = resolve(workspace || process.cwd())

  const record = readTaskRecordStatus(sid, { includeArchived: true })
  if (record.state === 'corrupt' || record.state === 'unreadable') {
    throw new Error(
      'E_TASK_RECORD_UNREADABLE: 任务记录存在但无法读取（' +
        (record.path || '') +
        '）。为避免覆盖你的方案，本次没有新建；请先备份或移走该文件，再重试。'
    )
  }

  // 若同会话已有旧任务，先归档留存备份
  const prior = record.state === 'ok' ? record.task : null
  if (prior && !isArchivedStatus(prior.status)) {
    archiveActiveTask(sid, { note: '创建新任务前归档前序任务' })
  }

  const now = Date.now()
  const taskId = `egm-${now.toString(36)}-${randomUUID().slice(0, 6)}`
  const reqText = String(request ?? '').trim()

  const newTask = {
    id: taskId,
    taskId,
    sessionId: sid,
    workspace: ws,
    title: reqText || 'EGM 设计任务',
    revision: 1,
    specRevision: SPEC_REVISION_DEFAULT,
    status: 'active',
    phase: 'prep',
    workflow: String(workflow || 'gate'),
    heldFrom: null,
    originalRequest: reqText,
    currentRequest: reqText,
    docPath: join(ws, '.egm', taskId + '.md'),
    history: [
      {
        timestamp: now,
        type: 'kickoff',
        request: reqText,
        revision: 1,
        specRevision: SPEC_REVISION_DEFAULT,
        phase: 'prep',
        note: '任务创建',
      },
    ],
    createdAt: now,
    updatedAt: now,
  }

  return writeActiveTask(newTask)
}

/**
 * 更新活跃任务属性（revision 仅作为记录版本递增，不设修订轮数上限）。
 *
 * 关键规则：
 *   - revision 每次都自增（记录被改过）；
 *   - specRevision 只在 updates.bumpSpec === true 时自增（方案内容/动作卡绑定版本）；
 *   - 进入 held 时记下 heldFrom；回到 active 且阶段不再是 hold 时清除 heldFrom；
 *   - 普通会话活动请用 noteUserChat，不要走这里改 status/phase。
 *
 * @param {string} sessionId
 * @param {object} updates
 * @returns {object|null}
 */
export function updateActiveTask(sessionId, updates = {}) {
  const current = readActiveTaskForSession(sessionId)
  if (!current) return null
  const task = { ...current, history: [...current.history] }
  const previousPhase = task.phase
  const previousStatus = task.status

  if (typeof updates.title === 'string' && updates.title.trim()) {
    task.title = updates.title.trim()
  }
  if (typeof updates.currentRequest === 'string' && updates.currentRequest.trim()) {
    task.currentRequest = updates.currentRequest.trim()
  }
  if (typeof updates.docPath === 'string' && updates.docPath.trim()) {
    task.docPath = updates.docPath.trim()
  }
  if (typeof updates.phase === 'string' && TASK_PHASES.includes(updates.phase)) {
    task.phase = updates.phase
  }
  if (typeof updates.status === 'string' && TASK_STATUSES.includes(updates.status)) {
    task.status = updates.status
  }
  if (typeof updates.workflow === 'string' && updates.workflow.trim()) {
    task.workflow = updates.workflow.trim()
  }

  // 暂缓阶段记下从哪一步暂停；恢复后清空，避免留下矛盾状态
  if (task.status === 'held' && previousPhase !== 'hold') {
    task.heldFrom = previousPhase
  } else if (task.status === 'active' && task.phase !== 'hold') {
    task.heldFrom = null
  }

  // 记录版本：每次写入都自增
  task.revision = (typeof task.revision === 'number' ? task.revision : 1) + 1
  // 方案内容版本：只有实质变更才前进
  if (updates.bumpSpec === true) {
    task.specRevision =
      (typeof task.specRevision === 'number' ? task.specRevision : SPEC_REVISION_DEFAULT) + 1
  }
  if (typeof updates.lastUserChatAt === 'number') {
    task.lastUserChatAt = updates.lastUserChatAt
  }

  if (updates.historyEntry && typeof updates.historyEntry === 'object') {
    task.history.push({
      timestamp: Date.now(),
      revision: task.revision,
      specRevision: task.specRevision,
      ...updates.historyEntry,
    })
  } else if (updates.note || updates.action || updates.phase || previousStatus !== task.status) {
    task.history.push({
      timestamp: Date.now(),
      type: updates.type || 'update',
      action: updates.action,
      phase: task.phase,
      status: task.status,
      revision: task.revision,
      specRevision: task.specRevision,
      note: updates.note || `状态更新为 ${task.phase}`,
    })
  }

  task.updatedAt = Date.now()
  return writeActiveTask(task)
}
