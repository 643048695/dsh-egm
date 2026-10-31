// EGM 交接包导出 / 导入
//
// 目的：换会话、换人接手时，把"目标、决定、图纸、评审来源、未解决风险、下一步"整理成一份能读的 Markdown，
// 而不是让对方翻几百条聊天。
//
// 明确不做（按方案 §9 E3）：
//   - 不导出任何临时许可、派发窗口、密钥或凭据；
//   - 不导出无关聊天记录；
//   - 不写机器私有绝对路径（统一写成工作区相对路径或 <workspace>）；
//   - 导入只恢复"任务摘要 + 材料引用"，不恢复授权、不自动派发、不自动改状态。

import fs from 'node:fs'
import { join } from 'node:path'
import { readTaskRecordStatus } from './active-task.js'
import { listRecentOps } from './action-log.js'
import { readLedger, summarizeLedger } from './ledger.js'
import { listReviewRuns } from './review-batch.js'
import { taskDirPath } from './ledger.js'

export const HANDOFF_SCHEMA = 'egm-handoff/1'

function relativePath(workspace, absolutePath) {
  const raw = String(absolutePath ?? '').trim()
  if (!raw) return ''
  const ws = String(workspace ?? '').replace(/\\/g, '/')
  const normalized = raw.replace(/\\/g, '/')
  if (ws && normalized.startsWith(ws)) return normalized.slice(ws.length).replace(/^\/+/, '')
  return normalized
}

function line(label, value) {
  const text = String(value ?? '').trim()
  return text ? `- ${label}：${text}` : `- ${label}：—`
}

function timeText(ms) {
  if (!ms) return '—'
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  } catch {
    return '—'
  }
}

/**
 * 导出交接包。
 * @param {{ workspace: string, taskId?: string|null, sessionId: string }} params
 * @returns {{ ok: boolean, path?: string, text?: string, code?: string, error?: string }}
 */
export function exportHandoff({ workspace, taskId = null, sessionId }) {
  const record = readTaskRecordStatus(sessionId, { includeArchived: true })
  if (record.state === 'corrupt' || record.state === 'unreadable') {
    return {
      ok: false,
      code: 'E_TASK_RECORD_UNREADABLE',
      error: '任务记录读不出来，无法导出交接包；请先备份 .egm/sessions 下的记录文件。',
    }
  }
  const task = record.state === 'ok' ? record.task : null
  const effectiveTaskId = taskId || task?.id || null
  if (!effectiveTaskId) {
    return { ok: false, code: 'E_NO_TASK', error: '当前没有方案，无法导出交接包。' }
  }

  const ledgerRead = readLedger({ workspace, taskId: effectiveTaskId })
  const ledger = ledgerRead.ok ? ledgerRead.ledger : null
  const summary = ledger ? summarizeLedger(ledger) : null
  const runs = listReviewRuns({ workspace, taskId: effectiveTaskId, limit: 10 }).runs ?? []
  const ops = listRecentOps({ sessionId, workspace, taskId: effectiveTaskId, limit: 20 })

  const lines = []
  lines.push(`# EGM 交接包：${task?.title || effectiveTaskId}`)
  lines.push('')
  lines.push(`> 由 dsh-egm 生成，格式 ${HANDOFF_SCHEMA}。这是给人读的摘要，不是审批凭证；不含任何临时许可或凭据。`)
  lines.push('')
  lines.push('## 任务')
  lines.push(line('任务编号', effectiveTaskId))
  lines.push(line('工作内容', task?.workflow || '—'))
  lines.push(line('状态', `${task?.status || '—'} / ${task?.phase || '—'}`))
  lines.push(line('方案版本', task?.specRevision ?? '—'))
  lines.push(line('记录版本', task?.revision ?? '—'))
  lines.push(line('更新时间', timeText(task?.updatedAt)))
  lines.push('')
  lines.push('## 目标')
  lines.push(line('最初需求', task?.originalRequest || '—'))
  lines.push(line('当前需求', task?.currentRequest || '—'))
  lines.push('')
  lines.push('## 关键决定')
  const history = Array.isArray(task?.history) ? task.history.slice(-20) : []
  if (history.length === 0) lines.push('- （没有记录）')
  for (const entry of history) {
    const type = entry?.type || 'event'
    const note = entry?.note || entry?.request || entry?.action || ''
    lines.push(`- ${timeText(entry?.at)} · ${type}${note ? `：${note}` : ''}`)
  }
  lines.push('')
  lines.push('## 图纸与产物')
  if (!ledger || ledger.artifacts.length === 0) {
    lines.push(line('当前图纸', relativePath(workspace, task?.docPath) || '—'))
  } else {
    const current = ledger.artifacts.find(item => item.id === ledger.currentDesignId)
    lines.push(line('当前图纸', current ? `${current.path}（哈希 ${String(current.contentHash || '').slice(0, 12)}）` : relativePath(workspace, task?.docPath) || '—'))
    for (const artifact of ledger.artifacts) {
      lines.push(`- 产物 · ${artifact.kind}：${artifact.path}（${artifact.bytes} 字节，哈希 ${String(artifact.contentHash || '').slice(0, 12)}）`)
    }
  }
  lines.push('')
  lines.push('## 评审来源')
  if (runs.length === 0) {
    lines.push('- （没有运行记录：不能证明图纸被评审过）')
  }
  for (const run of runs) {
    const jobs = (run.jobs ?? [])
      .map(job => `${job.role}=${job.status}`)
      .join('，')
    lines.push(`- ${timeText(run.createdAt)} · ${run.mode}${run.stage ? ` 阶段${run.stage}` : ''} · 状态 ${run.status} · ${jobs || '无作业'}`)
    const missing = (run.jobs ?? []).filter(job => job.status !== 'completed')
    if (missing.length > 0) {
      lines.push(`  - 缺报告：${missing.map(job => `${job.role}（${job.status}）`).join('、')}`)
    }
  }
  lines.push('')
  lines.push('## 问题台账')
  if (!ledger || ledger.findings.length === 0) {
    lines.push('- （没有问题记录）')
  } else {
    for (const finding of ledger.findings.slice(0, 40)) {
      const verification = finding.verification?.state || 'unverified'
      const disposition = finding.disposition?.state || 'open'
      const quote = String(finding.quote || finding.summary || '').replace(/\s+/g, ' ').slice(0, 160)
      lines.push(`- [${finding.severity}] ${finding.role || '未知角色'} · 核实=${verification} · 处置=${disposition}：${quote}`)
      if (disposition === 'accepted-risk' && finding.disposition?.riskScope) {
        lines.push(`  - 接受的风险范围：${finding.disposition.riskScope}`)
      }
    }
  }
  lines.push('')
  lines.push('## 结论与风险')
  if (summary) {
    lines.push(line('问题统计', `${summary.findings} 条（阻断 ${summary.bySeverity.blocker}，严重 ${summary.bySeverity.high}）`))
    lines.push(line('核实情况', `未核实 ${summary.byVerification.unverified}，已确认 ${summary.byVerification.confirmed}，已推翻 ${summary.byVerification.disproven}`))
    lines.push(line('完整性', summary.note))
  } else {
    lines.push('- （没有台账，无法汇总）')
  }
  lines.push('')
  lines.push('## 操作记录（最近 20 条）')
  if (!ops || ops.length === 0) lines.push('- （没有操作记录）')
  for (const op of ops || []) {
    lines.push(`- ${timeText(op.createdAt)} · ${op.action} · 送达=${op.deliveryState || op.state || '—'} · 执行=${op.executionState || '—'}`)
  }
  lines.push('')
  lines.push('## 下一步建议')
  const suggestions = []
  if (summary?.openBlockers) suggestions.push(`先处理 ${summary.openBlockers} 条阻断问题，再谈开始实现。`)
  if (summary?.severeUnverified) suggestions.push(`${summary.severeUnverified} 条严重问题还没核实，建议先让大象核实。`)
  const unknownJobs = runs.flatMap(run => (run.jobs ?? []).filter(job => job.status === 'unknown')).length
  if (unknownJobs > 0) suggestions.push(`${unknownJobs} 个评审作业状态未知（进程重启或中断），需要的话手动重派。`)
  if (suggestions.length === 0) suggestions.push('没有发现需要立刻处理的项；继续按当前阶段推进。')
  for (const item of suggestions) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## 未验证项')
  lines.push('- 本交接包不含任何真机验收结论；标"已确认"的问题只代表记录里给了证据来源。')
  lines.push('- 没有导出临时许可、派发窗口或凭据；接手方需要重新申请评审权限。')
  lines.push('')

  const text = lines.join('\n')
  const dir = taskDirPath(workspace, effectiveTaskId)
  const file = join(dir, `handoff-${Date.now().toString(36)}.md`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, text, 'utf8')
  } catch (error) {
    return { ok: false, code: 'E_HANDOFF_WRITE', error: `交接包写入失败：${error?.message ?? String(error)}` }
  }
  return { ok: true, path: file, relativePath: relativePath(workspace, file), text }
}

/**
 * 导入交接包：只读取摘要与材料引用，不恢复授权、不自动派发。
 * @param {{ workspace: string, filePath: string }} params
 */
export function importHandoff({ workspace, filePath }) {
  const target = String(filePath ?? '').trim()
  if (!target) return { ok: false, code: 'E_HANDOFF_EMPTY', error: '请提供交接包文件路径。' }
  let text
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch (error) {
    return { ok: false, code: 'E_HANDOFF_UNREADABLE', error: `交接包读不出来：${error?.message ?? String(error)}` }
  }
  if (!text.includes(HANDOFF_SCHEMA) && !text.startsWith('# EGM 交接包')) {
    return { ok: false, code: 'E_HANDOFF_FORMAT', error: '这不是本插件导出的交接包（缺少格式标记）。' }
  }
  const pick = label => {
    const match = new RegExp(`^- ${label}：(.*)$`, 'm').exec(text)
    return match ? match[1].trim() : ''
  }
  const docLine = pick('当前图纸')
  const docPath = docLine && !docLine.startsWith('（') ? docLine.replace(/（哈希.*$/, '').trim() : ''
  return {
    ok: true,
    summary: {
      title: (text.split('\n')[0] || '').replace(/^#\s*EGM 交接包：/, '').trim(),
      taskId: pick('任务编号'),
      workflow: pick('工作内容'),
      status: pick('状态'),
      specRevision: pick('方案版本'),
      originalRequest: pick('最初需求'),
      currentRequest: pick('当前需求'),
      docPath,
      completeness: pick('完整性'),
    },
    notes: [
      '导入只读取摘要与材料引用；没有恢复任何许可、派发窗口或任务状态。',
      '要真正接续，仍需在当前会话重新启动 EGM 并申请评审权限。',
    ],
  }
}
