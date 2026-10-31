// EGM 任务视图（Task View）
//
// 目的：让"现在能做什么"由后端算出来，前端只负责显示和转发。
//   - 动作卡与底栏面板共用同一份 allowedActions，避免两处各写一套判断；
//   - 每个动作都给出中文理由（为什么不可用）和可直接执行的命令文本；
//   - 只读：本模块不写任务、不发消息、不改变任何权限。
//
// 诚实边界：
//   - 这里判断的是"插件这一侧看起来能不能做"，最终仍以命令执行时的真实检查为准；
//   - review 是否可派发依赖临时派发窗口（/egm-open），窗口关闭时这里如实说不可用；
//   - proceed 是否已核对过评审由 review-runs 台账决定，台账可被删除，只作提醒不作安全边界。

import fs from 'node:fs'
import { listArchivedTasks, readTaskRecordStatus } from './active-task.js'
import { findInFlightOp, listRecentOps } from './action-log.js'
import { checkReviewFreshness } from './review-runs.js'
import { getActiveAgent, peekGate } from './review-access.js'
import { listReviewRuns } from './review-batch.js'
import { analyzeReviewImpact } from './incremental-review.js'
import { listFindings, readLedger, summarizeLedger } from './ledger.js'

/** 任务记录读不出来时的中文说明（code 来自 active-task 的错误码）。 */
const RECORD_ERROR_MESSAGES = Object.freeze({
  E_INVALID_SESSION: '会话 ID 不合法，无法定位任务记录。',
  E_PARSE_FAILED: '任务记录不是合法 JSON，已停止自动处理，请先备份该文件。',
  E_SHAPE_INVALID: '任务记录字段不完整，已停止自动处理，请先备份该文件。',
  E_SESSION_MISMATCH: '任务记录属于另一个会话，已拒绝按本会话处理。',
  E_WORKSPACE_MISMATCH: '任务记录属于另一个工作区，已拒绝按本工作区处理。',
  E_READ_FAILED: '任务记录暂时读不出来（可能是权限或占用），本次不覆盖。',
})

/** 工序（阶段）中文名。 */
export const PHASE_LABELS = Object.freeze({
  prep: '准备',
  design: '写图纸',
  review: '评审',
  revise: '改图纸',
  proceed: '开始实现',
  hold: '暂缓',
})

/** 生命周期中文名。 */
export const STATUS_LABELS = Object.freeze({
  active: '进行中',
  held: '已暂缓',
  completed: '已完成',
  archived: '已归档',
  closed: '已归档',
})

/** 动作中文名。 */
export const ACTION_LABELS = Object.freeze({
  revise: '改图纸',
  review: '再评审',
  proceed: '开始实现',
  hold: '暂缓',
  resume: '继续',
  complete: '结项',
  reopen: '重新打开',
  new: '另起方案',
})

const MAX_OPS = 20
const MAX_ARCHIVES = 8
const MAX_RUNS = 6
const MAX_FINDINGS = 12

// 证据视图的短缓存：面板 1.2 秒轮询一次，台账/运行记录不用每次都读盘；
// 只影响显示，命令执行时全部重新读。
const EVIDENCE_CACHE = new Map()
const EVIDENCE_CACHE_TTL_MS = 3000

/**
 * 由 specRevision 拼出可直接执行的命令；缺 ID/版本时返回 null（不编造）。
 * @param {string} action
 * @param {object|null} task
 * @param {boolean} [confirm]
 * @returns {string|null}
 */
export function actionCommand(action, task, confirm = false) {
  if (!task || typeof task.id !== 'string' || task.id === '') return null
  const version = Number.isInteger(task.specRevision) ? task.specRevision : null
  if (version === null) return null
  const base = `/egm-action ${action} ${task.id} ${version}`
  return confirm ? `${base} confirm` : base
}

/**
 * 计算当前任务可用的动作。返回顺序即界面顺序。
 * @param {object|null} task
 * @param {{ inFlightOpId?: string|null, freshness?: { ok: boolean, reason: string } | null, gateOpen?: boolean }} [context]
 * @returns {Array<{ action: string, label: string, enabled: boolean, reason: string|null, confirm?: boolean, command: string|null }>}
 */
export function allowedActionsFor(task, context = {}) {
  if (!task || typeof task !== 'object') return []
  const status = typeof task.status === 'string' ? task.status : 'active'
  const inFlight = typeof context.inFlightOpId === 'string' && context.inFlightOpId !== ''
  const freshness = context.freshness ?? null
  const gateOpen = context.gateOpen === true

  const build = (action, enabled, reason, extra = {}) => ({
    action,
    label: ACTION_LABELS[action] ?? action,
    enabled: enabled === true,
    reason: reason ?? null,
    command: actionCommand(action, task, extra.confirm === true),
    ...(extra.confirm === true ? { confirm: true } : {}),
  })

  if (status === 'archived' || status === 'closed') {
    return [build('new', !inFlight, inFlight ? '上一个操作还在等待确认，请稍后重试。' : null)]
  }

  const busy = inFlight ? '上一个操作还在等待确认，请稍后重试。' : null

  if (status === 'completed') {
    return [
      build('reopen', !inFlight, busy ?? '重新打开后可以继续改图纸或再评审。'),
      build('new', !inFlight, busy),
    ]
  }

  if (status === 'held') {
    return [
      build('resume', !inFlight, busy ?? '继续后才会重新安排评审与实现。'),
      build('revise', !inFlight, busy ?? '暂缓不阻止改图纸，但不会自动重新排期。'),
      build('review', false, '方案处于暂缓状态：先继续，再安排评审。'),
      build('proceed', false, '方案处于暂缓状态：先继续，再开始实现。'),
      build('complete', !inFlight, busy),
      build('new', !inFlight, busy),
    ]
  }

  // active
  const actions = [
    build('revise', !inFlight, busy ?? '只改图纸，不代表开始实现。'),
    build(
      'review',
      !inFlight && gateOpen,
      busy ?? (gateOpen ? '需要先明确许可非隔离评审，派发前会再检查。' : '派发窗口未打开：先执行 /egm-open 或 /egm 打开。'),
    ),
  ]

  if (freshness && freshness.ok === true) {
    actions.push(build('proceed', !inFlight, busy ?? '当前图纸与最近一次成功评审一致。'))
  } else {
    const reason = busy ?? freshness?.reason ?? '没有查到对当前图纸的成功评审记录。'
    actions.push(build('proceed', false, reason))
    actions.push(build('proceed', !inFlight, '旧评审不能批准新图纸：确认覆盖核对后才开始实现。', { confirm: true }))
  }

  actions.push(build('hold', !inFlight, busy ?? '暂缓只阻止后续排期，不会打断已在运行的金鱼或工具。'))
  actions.push(build('complete', !inFlight, busy))
  actions.push(build('new', !inFlight, busy))
  return actions
}

/**
 * 组装一个会话的任务视图（只读）。
 * @param {{ sessionId: string, workspace?: string, includeArchives?: boolean, includeOps?: boolean }} params
 * @returns {object}
 */
export function buildTaskView({ sessionId, workspace, includeArchives = false, includeOps = true, includeEvidence = false }) {
  const sid = String(sessionId ?? '').trim()
  if (sid === '') {
    return {
      task: null,
      taskError: null,
      allowedActions: [],
      proceedGate: null,
      ops: [],
      archives: [],
      reviewRuns: [],
      findings: [],
      ledgerSummary: null,
      impact: null,
    }
  }

  const record = readTaskRecordStatus(sid, { includeArchived: true })
  const task = record.state === 'ok' ? record.task : null
  const taskError =
    record.state === 'ok' || record.state === 'absent'
      ? null
      : {
          state: record.state,
          code: record.error ?? null,
          message: RECORD_ERROR_MESSAGES[record.error] ?? '任务记录无法读取，已停止自动处理。',
          path: record.path ?? null,
        }

  const effectiveWorkspace = String(task?.workspace ?? workspace ?? '').trim()
  const taskId = task?.id ?? null

  const inFlight = task
    ? findInFlightOp({ sessionId: sid, workspace: effectiveWorkspace, taskId })
    : null

  const freshness = task && task.docPath ? checkReviewFreshness({ workspace: effectiveWorkspace, sessionId: sid, docPath: task.docPath }) : null
  const liveAgent = getActiveAgent(sid) ?? null
  const gate = liveAgent ? peekGate(liveAgent) : null
  const gateOpen = gate !== null && (gate.remaining ?? 0) > 0

  const ops =
    includeOps && task
      ? listRecentOps({ sessionId: sid, workspace: effectiveWorkspace, taskId, limit: MAX_OPS }).map((op) => ({
          opId: op.opId,
          action: op.action,
          label: ACTION_LABELS[op.action] ?? op.action,
          deliveryState: op.deliveryState ?? op.state ?? null,
          executionState: op.executionState ?? null,
          createdAt: op.createdAt ?? null,
          updatedAt: op.updatedAt ?? null,
          attempts: Number.isInteger(op.detail?.attempts) ? op.detail.attempts : 1,
        }))
      : []

  const archives =
    includeArchives && effectiveWorkspace !== ''
      ? listArchivedTasks(effectiveWorkspace, sid, { limit: MAX_ARCHIVES }).items
      : []

  let docExists = null
  if (task && typeof task.docPath === 'string' && task.docPath !== '') {
    try {
      docExists = fs.existsSync(task.docPath)
    } catch {
      docExists = null
    }
  }

  // 证据视图：评审记录 + 问题台账 + 影响面判断。只读，读不出来就返回 null，
  // 绝不用"没查到"冒充"没问题"。
  let reviewRuns = []
  let findings = []
  let ledgerSummary = null
  let impact = null
  if (includeEvidence && task && effectiveWorkspace !== '') {
    const cacheKey = `${effectiveWorkspace}::${taskId ?? ''}`
    const cached = EVIDENCE_CACHE.get(cacheKey)
    if (cached && Date.now() - cached.at < EVIDENCE_CACHE_TTL_MS) {
      reviewRuns = cached.reviewRuns
      findings = cached.findings
      ledgerSummary = cached.ledgerSummary
      impact = cached.impact
    } else {
    try {
      const listed = listReviewRuns({ workspace: effectiveWorkspace, taskId, limit: MAX_RUNS })
      reviewRuns = (listed.ok ? listed.runs : []).map(run => ({
        runId: run.runId,
        status: run.status,
        stage: run.stage ?? null,
        createdAt: run.createdAt ?? null,
        jobs: Array.isArray(run.jobs)
          ? run.jobs.map(job => ({ role: job.role, status: job.status, reportPath: job.reportPath ?? null }))
          : [],
      }))
    } catch {
      reviewRuns = []
    }
    try {
      const listed = listFindings({ workspace: effectiveWorkspace, taskId, limit: MAX_FINDINGS })
      findings = (listed.ok ? listed.findings : []).map(item => ({
        id: item.id,
        severity: item.severity,
        summary: item.summary || item.quote || '',
        verification: item.verification?.state ?? 'unverified',
        disposition: item.disposition?.state ?? 'open',
      }))
    } catch {
      findings = []
    }
    try {
      const read = readLedger({ workspace: effectiveWorkspace, taskId })
      ledgerSummary = read.ok ? summarizeLedger(read.ledger) : { unreadable: true, note: read.error ?? '台账读不出来。' }
    } catch {
      ledgerSummary = { unreadable: true, note: '台账读不出来。' }
    }
    try {
      if (task.docPath) {
        const analyzed = analyzeReviewImpact({ workspace: effectiveWorkspace, taskId, docPath: task.docPath })
        impact = analyzed.ok
          ? {
              mode: analyzed.mode,
              reason: analyzed.reason,
              changed: analyzed.changed.slice(0, 8),
              affectedRoles: analyzed.affectedRoles,
            }
          : { mode: 'unknown', reason: analyzed.error ?? '算不出影响面' }
      }
    } catch {
      impact = null
    }
      if (EVIDENCE_CACHE.size > 32) EVIDENCE_CACHE.clear()
      EVIDENCE_CACHE.set(cacheKey, { at: Date.now(), reviewRuns, findings, ledgerSummary, impact })
    }
  }

  return {
    workspace: effectiveWorkspace,
    task: task
      ? {
          sessionId: task.sessionId,
          id: task.id,
          taskId: task.taskId ?? null,
          revision: task.revision ?? 1,
          specRevision: Number.isInteger(task.specRevision) ? task.specRevision : 1,
          workflow: task.workflow ?? 'gate',
          status: task.status ?? 'active',
          statusLabel: STATUS_LABELS[task.status] ?? task.status,
          phase: task.phase ?? 'prep',
          phaseLabel: PHASE_LABELS[task.phase] ?? task.phase,
          heldFrom: task.heldFrom ?? null,
          title: task.title ?? '',
          docPath: task.docPath ?? null,
          docExists,
          updatedAt: task.updatedAt ?? null,
        }
      : null,
    taskError,
    allowedActions: allowedActionsFor(task, {
      inFlightOpId: inFlight?.opId ?? null,
      freshness,
      gateOpen,
    }),
    proceedGate: freshness
      ? { ok: freshness.ok === true, code: freshness.code, reason: freshness.reason }
      : null,
    inFlightOpId: inFlight?.opId ?? null,
    ops,
    archives,
    reviewRuns,
    findings,
    ledgerSummary,
    impact,
  }
}
