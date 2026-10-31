// Real main-agent (elephant) status bridge for the EGM pet.
//
// What this file does NOT do:
//   - It never infers "writing a design doc" from /egm being opened or from
//     elapsed time. DSH 0.2.1-rc.3 has no "skill work started/finished" event.
//     The only honest elephant facts we can observe are:
//       * agent/status: the main agent is running or idle (host lifecycle);
//       * agent/created / agent/disposed: a live main agent appeared or left;
//       * session/event: a real skill load, a user-explicit skill invocation,
//         or an egm_dispatch attempt was committed in this session.
//     Consequently the pet's top-level state stays `prep`, never a fabricated
//     `writing`. `elephant.egm.active` + `elephant.workingOnEgm` are the honest
//     "the main agent is running after an EGM signal was seen" facts.
//
// Isolation and races:
//   - Every event is keyed by an exact session id; there is no fallback to a
//     "most recent" session.
//   - Subagent sessions (origin === 'subagent' or delegationDepth > 0) are
//     ignored. The goldfish have their own rows only if the parent dispatches.
//   - A stale agent/status event is rejected when the live agent's current
//     status no longer equals the event payload.
//   - A disposed agent is tombstoned, so a late status event from that exact
//     agent cannot revive it. A later agent/created for the same session clears
//     the tombstone because that is a new, real agent.
//   - Session events carry a monotonic seq; the store rejects an older seq for
//     the same session so a late EGM signal cannot overwrite newer activity.

import { registerActiveAgent, unregisterActiveAgent } from './review-access.js'
import { handleReviewUserAction } from './dispatch.js'
import { noteUserChat, readActiveTaskForSession, updateActiveTask, workspaceOf } from './active-task.js'
import { EXECUTION_STATES, recordExecutionProgress } from './action-log.js'
import { ARTIFACT_KINDS, upsertArtifact, upsertFinding } from './ledger.js'

/** Skills that mean "this session is doing EGM work". Exact names, no prefix guessing. */
export const EGM_SKILL_NAMES = Object.freeze([
  'egm-gate',
  'egm-review',
  'egm-classic-bootstrap',
  'egm-classic-brainstorm',
  'egm-classic-draft',
  'egm-classic-drift-report',
  'egm-classic-resolve',
  'egm-classic-review',
  'egm-classic-review-loop',
])

const EGM_SKILLS = new Set(EGM_SKILL_NAMES)

/** Committed events that count as real work inside an already-bound EGM turn. */
const EGM_ACTIVITY_EVENTS = new Set([
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/start',
  'step/end',
])

/** Every event name this bridge needs from the host. */
export const ELEPHANT_EVENT_NAMES = Object.freeze([
  'agent/created',
  'agent/status',
  'agent/disposed',
  'session/event',
])

/** Stable session id from a Session (header id is the durable identity). */
export function sessionIdOfSession(session) {
  const raw = session?.header?.id ?? session?.id
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

/** Only top-level sessions are elephants. Subagent sessions are goldfish/work children. */
export function isMainSession(session) {
  if (!session || typeof session !== 'object') return false
  const header = session?.header
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return false
  if (Number.isFinite(header.delegationDepth) && header.delegationDepth > 0) return false
  return true
}

/** Exact EGM skill name, or null. Never treats a prefix match as proof. */
export function egmSkillName(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return EGM_SKILLS.has(name) ? name : null
}

/** Parse the raw tool-call arguments only far enough to read a skill name. */
function skillNameFromArguments(raw) {
  if (raw === undefined || raw === null) return null
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  return egmSkillName(value?.name)
}

/**
 * Map one committed session event to an EGM signal, or null.
 * Only committed, durable events are considered. Assistant prose is never read
 * as conversation; the one exception is the plugin-owned `egm-progress` block,
 * which the model may use to report execution progress (never approval).
 *
 * `skill-load-request` is internal: a tool/call alone is only a request. The
 * tracker waits for the matching tool/result before calling it `skill-loaded`,
 * so a refused or never-started skill cannot light up the pet.
 * @returns {{ signal: string, skill: string|null, seq: number|null, callId?: string } | null}
 */
export function signalOfSessionEvent(event) {
  if (!event || typeof event !== 'object') return null
  const seq = Number.isInteger(event.seq) ? event.seq : null

  if (event.type === 'tool/call') {
    const name = event.data?.name
    if (name === 'skill') {
      const skill = skillNameFromArguments(event.data?.arguments)
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
      if (skill === null || callId === '') return null
      return { signal: 'skill-load-request', skill, seq, callId }
    }
    if (name === 'egm_dispatch' || name === 'egm_dispatch_batch') {
      // A real call attempt. It may still be refused by the gates; the store
      // only treats this as "EGM activity", never as a running goldfish.
      return { signal: 'dispatch-called', skill: null, seq }
    }
    return null
  }

  if (event.type === 'user/message') {
    const source = event.data?.source
    if (source?.kind !== 'skill-invocation') return null
    const skill = egmSkillName(source.name)
    return skill === null ? null : { signal: 'skill-invoked', skill, seq }
  }

  return null
}

/**
 * 从宿主消息负载里取纯文本。只用于解析插件专有的 egm-progress 块，
 * 不用于理解对话内容（进度上报之外，助手正文一律不读）。
 * @param {any} data
 * @returns {string}
 */
function messageTextOf(data) {
  const chunks = []
  const push = (value) => {
    if (typeof value === 'string') chunks.push(value)
    else if (value && typeof value.text === 'string') chunks.push(value.text)
  }
  if (Array.isArray(data?.content)) data.content.forEach(push)
  else push(data?.content)
  if (Array.isArray(data?.message?.content)) data.message.content.forEach(push)
  else push(data?.message?.content)
  push(data?.text)
  push(data?.message?.text)
  return chunks.join('\n')
}

const PROGRESS_FENCE_RE = /```egm-progress[^\n]*\n([\s\S]*?)```/g
const PROGRESS_TAG_RE = /<egm-progress>([\s\S]*?)<\/egm-progress>/g

/**
 * 解析助手消息里的进度块：```egm-progress {...} ``` 或 <egm-progress>{...}</egm-progress>。
 * 只接受单个 JSON 对象；同一消息里完全相同的块只处理一次。
 * @param {string} text
 * @returns {object[]}
 */
export function parseProgressReports(text) {
  const source = String(text ?? '')
  const reports = []
  const seen = new Set()
  const consider = (raw) => {
    const body = String(raw ?? '').trim()
    if (body === '' || seen.has(body)) return
    seen.add(body)
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reports.push(parsed)
  }
  for (const re of [PROGRESS_FENCE_RE, PROGRESS_TAG_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(source)) !== null) consider(match[1])
  }
  return reports
}

/**
 * Pure reducer over host event payloads. The returned handlers are stable so
 * attach() can subscribe/unsubscribe exactly once per host event.
 */
export function createElephantTracker({ store, now = () => Date.now(), onEvent = null } = {}) {
  if (!store || typeof store.apply !== 'function') {
    throw new TypeError('elephant tracker requires a pet store with apply()')
  }

  /** sessionId -> exact live Agent object */
  const live = new Map()
  /** sessionId -> the currently open real turn, from turn/start and turn/end. */
  const turns = new Map()
  /** Agent objects that already emitted disposed; weak so we do not retain them. */
  const retired = new WeakSet()
  /** Agents observed through a real lifecycle/status event, never a registry snapshot. */
  const eventObserved = new WeakSet()
  /** Sessions whose exact agent was disposed; session events after that are stale. */
  const closed = new Set()
  /** callId -> { skill, seq } for a skill tool call waiting for its real result. */
  const pendingSkills = new Map() // sessionId -> Map<callId, { skill, seq }>

  function emit(sessionId, type, extra = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const event = { type, sessionId, ...extra }
    try {
      onEvent?.(event)
    } catch {
      // Observability must never break host dispatch.
    }
    try {
      return store.apply(sessionId, type, event)
    } catch {
      return false
    }
  }

  /**
   * 应用模型上报的进度 / 需求变更。
   * 边界：进度只改操作记录的 executionState（这是"模型自称"，不是独立验收）；
   * 需求变更只接续同一任务并升 specRevision，绝不产生批准、许可或验收结论。
   */
  function applyProgressReports(sessionId, text) {
    const reports = parseProgressReports(text)
    if (reports.length === 0) return false
    const workspace = workspaceOf(live.get(sessionId) ?? null)
    let touched = false
    for (const report of reports) {
      const opId = typeof report?.opId === 'string' ? report.opId.trim() : ''
      const state = typeof report?.state === 'string' ? report.state : ''
      if (opId !== '' && EXECUTION_STATES.includes(state)) {
        const detail = {
          reportedBy: 'model',
          reportedAt: now(),
          note: typeof report?.note === 'string' ? report.note.slice(0, 500) : undefined,
        }
        const result = recordExecutionProgress({ sessionId, workspace, opId, executionState: state, detail })
        if (result?.ok === true) touched = true
        continue
      }
      if (report?.type === 'requirement-change') {
        const summary = typeof report?.summary === 'string' ? report.summary.trim() : ''
        if (summary === '') continue
        try {
          const task = readActiveTaskForSession(sessionId)
          if (!task) continue
          updateActiveTask(sessionId, {
            currentRequest: summary,
            bumpSpec: true,
            historyEntry: { type: 'requirement-change', request: summary, source: 'model-report' },
          })
          touched = true
        } catch { /* 上报失败不影响对话 */ }
        continue
      }
      if (report?.type === 'artifact') {
        // 模型登记产物：只登记工作区内真实存在的文件；kind 必须在清单里，不接受静默改成 other。
        try {
          if (!ARTIFACT_KINDS.includes(String(report?.kind))) continue
          const task = readActiveTaskForSession(sessionId)
          if (!task) continue
          const result = upsertArtifact({
            workspace,
            taskId: task.id,
            artifact: {
              kind: String(report.kind),
              path: report?.path,
              producer: 'elephant',
              note: typeof report?.note === 'string' ? report.note : undefined,
            },
          })
          if (result?.ok === true) touched = true
        } catch { /* 上报失败不影响对话 */ }
        continue
      }
      if (report?.type === 'finding') {
        // 模型上报问题：一律 unverified 入台账，核实与处置只能走 /egm-findings 或用户命令。
        try {
          const task = readActiveTaskForSession(sessionId)
          if (!task) continue
          const result = upsertFinding({
            workspace,
            taskId: task.id,
            finding: {
              severity: report?.severity,
              summary: typeof report?.summary === 'string' ? report.summary : '',
              quote: typeof report?.quote === 'string' ? report.quote : '',
              requiredFix: typeof report?.requiredFix === 'string' ? report.requiredFix : '',
              role: 'elephant',
            },
          })
          if (result?.ok === true) touched = true
        } catch { /* 上报失败不影响对话 */ }
        continue
      }
    }
    return touched
  }

  function handleCreated(payload) {
    const agent = payload?.agent
    const session = agent?.session
    if (!isMainSession(session)) return false
    const sessionId = sessionIdOfSession(session)
    if (sessionId === null) return false
    if (retired.has(agent)) return false
    const seeded = payload?.seed === true
    if (!seeded) eventObserved.add(agent)
    live.set(sessionId, agent)
    registerActiveAgent(agent)
    closed.delete(sessionId)
    turns.delete(sessionId)
    // A new lifecycle must not inherit a skill request left by the previous agent.
    pendingSkills.delete(sessionId)
    const status = agent?.status === 'running' ? 'running' : 'idle'
    return emit(sessionId, 'elephant-status', {
      status,
      source: seeded ? 'agents.list' : 'agent/created',
      at: now(),
      agentId: typeof agent?.id === 'string' ? agent.id : sessionId,
    })
  }

  function handleStatus(payload) {
    const agent = payload?.agent
    const status = payload?.status
    const session = agent?.session
    if (!isMainSession(session)) return false
    const sessionId = sessionIdOfSession(session)
    if (sessionId === null) return false
    if (status !== 'idle' && status !== 'running') return false
    if (retired.has(agent)) return false

    // A status event is only current when the live agent already holds it.
    // This rejects a late/out-of-order event without guessing a clock order.
    const current = agent?.status
    if (current === 'idle' || current === 'running') {
      if (current !== status) return false
    }

    const known = live.get(sessionId)
    if (known !== undefined && known !== agent) return false
    eventObserved.add(agent)
    live.set(sessionId, agent)
    registerActiveAgent(agent)
    closed.delete(sessionId)
    return emit(sessionId, 'elephant-status', {
      status,
      source: 'agent/status',
      at: now(),
      agentId: typeof agent?.id === 'string' ? agent.id : sessionId,
    })
  }

  function handleDisposed(payload) {
    const agent = payload?.agent
    const session = agent?.session
    if (!isMainSession(session)) return false
    const sessionId = sessionIdOfSession(session)
    if (sessionId === null) return false
    if (retired.has(agent)) return false
    retired.add(agent)
    unregisterActiveAgent(agent)

    // 新实例已经接管同一会话时，旧实例迟到的 disposed 绝不能把新实例关掉。
    const current = live.get(sessionId)
    if (current !== undefined && current !== agent) return false
    if (current === agent) live.delete(sessionId)
    closed.add(sessionId)
    turns.delete(sessionId)
    pendingSkills.delete(sessionId)
    return emit(sessionId, 'elephant-disposed', {
      at: now(),
      agentId: typeof agent?.id === 'string' ? agent.id : sessionId,
    })
  }

  function handleSessionEvent(session, event) {
    if (!isMainSession(session)) return false
    const sessionId = sessionIdOfSession(session)
    if (sessionId === null) return false
    if (closed.has(sessionId)) return false

    if (event?.type === 'turn/start') {
      const turn = Number.isInteger(event.data?.turn) ? event.data.turn : null
      if (turn === null) return false
      turns.set(sessionId, turn)
      return emit(sessionId, 'elephant-turn', {
        phase: 'start',
        turn,
        source: 'session/event',
        at: now(),
      })
    }

    if (event?.type === 'turn/end') {
      const turn = Number.isInteger(event.data?.turn) ? event.data.turn : null
      if (turn === null) return false
      if (turns.get(sessionId) === turn) turns.delete(sessionId)
      pendingSkills.delete(sessionId)
      return emit(sessionId, 'elephant-turn', {
        phase: 'end',
        turn,
        source: 'session/event',
        at: now(),
      })
    }

    if (event?.type === 'user/message') {
      const data = event.data
      const source = data?.source
      // 严格检查来源：仅响应真正的人类用户消息，拒绝 context 注入或技能内部调用
      const isUserSource = source?.kind === 'user'
      if (isUserSource) {
        let userText = ''
        if (typeof data?.text === 'string') userText = data.text
        else if (typeof data?.content === 'string') userText = data.content
        else if (typeof data?.message?.text === 'string') userText = data.message.text
        else if (typeof data?.message?.content === 'string') userText = data.message.content
        else if (Array.isArray(data?.content)) {
          for (const item of data.content) {
            if (typeof item === 'string') userText += item + ' '
            else if (item?.type === 'text' && typeof item.text === 'string') userText += item.text + ' '
          }
        } else if (Array.isArray(data?.message?.content)) {
          for (const item of data.message.content) {
            if (typeof item === 'string') userText += item + ' '
            else if (item?.type === 'text' && typeof item.text === 'string') userText += item.text + ' '
          }
        }
        userText = userText.trim()
        if (userText) {
          // 普通用户消息只记录「此刻说过话」：不改方案版本、不解除暂缓、不复活已完成或已归档的任务。
          // 改需求、继续、暂停、结项都必须走用户明确动作（/egm、动作卡、/egm-action），由后端单一入口处理。
          if (!userText.startsWith('/') && !userText.startsWith('[genui-action]')) {
            try {
              readActiveTaskForSession(sessionId)
              noteUserChat(sessionId, userText)
            } catch { /* 记录失败不能挡住用户消息 */ }
          }
          const liveAgent = live.get(sessionId)
          if (liveAgent) {
            handleReviewUserAction(liveAgent, userText, {
              onEvent: (ev) => {
                if (ev && typeof ev.type === 'string') {
                  store.apply(sessionId, ev.type, ev)
                }
              },
            })
          }
        }
      }
    }

    if (event?.type === 'assistant/message') {
      // 只解析插件专有的 egm-progress 块；助手正文不读、不执行、不作为结论。
      try {
        applyProgressReports(sessionId, messageTextOf(event.data))
      } catch { /* 进度解析失败不能影响消息本身 */ }
    }

    // A tool call is only a request. Clear unmatched requests at step/turn end so
    // a refused or never-started skill cannot be reported as loaded later.
    if (event?.type === 'step/end') {
      pendingSkills.delete(sessionId)
    }

    const eventTurn = Number.isInteger(event.data?.turn) ? event.data.turn : turns.get(sessionId)
    if (EGM_ACTIVITY_EVENTS.has(event?.type) && Number.isInteger(eventTurn)) {
      emit(sessionId, 'elephant-activity', {
        turn: eventTurn,
        source: 'session/event',
        at: now(),
      })
    }

    if (event?.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.source?.callId ?? message?.toolCallId
      if (typeof callId !== 'string' || callId === '') return false
      const pendingForSession = pendingSkills.get(sessionId)
      const pending = pendingForSession?.get(callId)
      if (pending === undefined) return false
      pendingForSession.delete(callId)
      if (pendingForSession.size === 0) pendingSkills.delete(sessionId)
      if (message?.isError === true || event.data?.error !== undefined) return false
      return emit(sessionId, 'elephant-signal', {
        signal: 'skill-loaded',
        skill: pending.skill,
        seq: Number.isInteger(event.seq) ? event.seq : null,
        turn: Number.isInteger(eventTurn) ? eventTurn : null,
        source: 'session/event',
        at: now(),
      })
    }

    const signal = signalOfSessionEvent(event)
    if (signal === null) return false

    if (signal.signal === 'skill-load-request') {
      let pendingForSession = pendingSkills.get(sessionId)
      if (pendingForSession === undefined) {
        pendingForSession = new Map()
        pendingSkills.set(sessionId, pendingForSession)
      }
      pendingForSession.set(signal.callId, { skill: signal.skill, seq: signal.seq })
      if (pendingForSession.size > 64) {
        const oldest = pendingForSession.keys().next().value
        pendingForSession.delete(oldest)
      }
      return false
    }

    return emit(sessionId, 'elephant-signal', {
      ...signal,
      turn: Number.isInteger(eventTurn) ? eventTurn : null,
      source: 'session/event',
      at: now(),
    })
  }

  /**
   * Seed one agent from a host registry snapshot. Unlike agent/created this may
   * run again whenever the agents service becomes available, so it must never
   * let a stale snapshot overwrite an agent we already observed through a real
   * lifecycle/status event.
   */
  function seedAgent(agent, snapshot) {
    const session = agent?.session
    if (!isMainSession(session)) return false
    const sessionId = sessionIdOfSession(session)
    if (sessionId === null || retired.has(agent)) return false
    const current = live.get(sessionId)
    if (current !== undefined) {
      if (current === agent) return false
      if (eventObserved.has(current)) return false
      // A previous seed may be replaced only when the fresh snapshot no longer
      // contains it (or contains a different live agent for the same session).
      if (snapshot !== null && snapshot.has(current)) return false
    }
    return handleCreated({ agent, seed: true })
  }

  function seedFromAgents(agents) {
    let list
    try {
      list = typeof agents?.list === 'function' ? agents.list() : null
    } catch {
      return 0
    }
    if (!Array.isArray(list)) return 0
    const snapshot = new Set(list)
    let seeded = 0
    for (const agent of list) {
      if (seedAgent(agent, snapshot)) seeded += 1
    }
    return seeded
  }

  return {
    handleCreated,
    handleStatus,
    handleDisposed,
    handleSessionEvent,
    seedFromAgents,
    /** Test/reporting view; never serialized by the HTTP route. */
    liveCount: () => live.size,
    isClosed: (sessionId) => closed.has(String(sessionId ?? '')),
  }
}

/**
 * Subscribe the bridge to a Cordis plugin context. Failures are recorded on the
 * store instead of thrown: the pet is decoration, not a security gate.
 * @returns {{ attached: boolean, agentLifecycle: boolean, agentStatus: boolean, sessionEvents: boolean, failures: string[], lateSeed: boolean, detach: () => void }}
 */
export function attachElephantTracker(ctx, store, options = {}) {
  const tracker = createElephantTracker({
    store,
    now: options.now,
    onEvent: options.onEvent,
  })

  const availability = {
    attached: false,
    agentLifecycle: false,
    agentStatus: false,
    sessionEvents: false,
    failures: [],
  }
  const disposers = []

  if (!ctx || typeof ctx.on !== 'function') {
    availability.failures.push('ctx.on is unavailable')
    try {
      store.markElephantBridge?.({ ...availability, reason: 'status-bridge-unavailable' })
    } catch {
      // Store reporting must not break plugin load.
    }
    return { ...availability, tracker, detach: () => {}, lateSeed: false }
  }

  const subscriptions = [
    ['agent/created', tracker.handleCreated, 'agentLifecycle'],
    ['agent/disposed', tracker.handleDisposed, 'agentLifecycle'],
    ['agent/status', tracker.handleStatus, 'agentStatus'],
    ['session/event', tracker.handleSessionEvent, 'sessionEvents'],
  ]

  for (const [name, handler, key] of subscriptions) {
    try {
      const dispose = ctx.on(name, handler)
      availability[key] = true
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      availability.failures.push(`${name}: ${error?.message ?? String(error)}`)
    }
  }

  // Status is the minimum real fact; lifecycle without status is not enough.
  availability.attached = availability.agentStatus && availability.agentLifecycle

  // Hot attach: sessions that were already live before this plugin loaded will
  // never replay agent/created. Seed their current host status once, then keep
  // following agent/status. A missing registry is not fatal: status stays unknown.
  let disposed = false
  let injectDispose = null
  let injectRegistered = false

  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null
    if (agents) tracker.seedFromAgents(agents)
  } catch (error) {
    availability.failures.push(`seed existing agents: ${error?.message ?? String(error)}`)
  }

  // The agents service may register after this plugin. ctx.inject observes that
  // without polling; the callback can run again on a service reload, so seeding
  // is idempotent and never lets an old snapshot overwrite a newer live agent.
  if (typeof ctx.inject === 'function') {
    try {
      const dispose = ctx.inject(['agents'], (child) => {
        if (disposed) return
        let agents = null
        try {
          agents = typeof child?.get === 'function' ? child.get('agents') : null
        } catch {
          return
        }
        if (agents) tracker.seedFromAgents(agents)
      })
      injectRegistered = true
      if (typeof dispose === 'function') injectDispose = dispose
    } catch (error) {
      availability.failures.push(`inject agents: ${error?.message ?? String(error)}`)
    }
  }

  try {
    store.markElephantBridge?.({
      ...availability,
      reason: availability.attached ? null : 'status-bridge-unavailable',
    })
  } catch {
    // Keep the plugin alive even if a store from an older version is mounted.
  }

  const detach = () => {
    if (disposed) return
    disposed = true
    if (typeof injectDispose === 'function') {
      try {
        injectDispose()
      } catch {
        // Host cleanup is best effort.
      }
      injectDispose = null
    }
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Host cleanup is best effort.
      }
    }
    try {
      store.markElephantBridge?.({
        ...availability,
        attached: false,
        reason: 'detached',
      })
    } catch {
      // Ignore store teardown races.
    }
  }

  return { ...availability, tracker, detach, lateSeed: injectRegistered }
}
