// EGM 增量复审影响面
//
// 目的：图纸改了一节之后，回答"哪些旧结论还能用、哪些必须重看"，而不是每次全量重审，
// 也不是天真地认为"文字没变就一定没事"。
//
// 规则（保守优先，宁可多审）：
//   - 没有可用的评审记录 → 全量；
//   - 配置或材料清单变了 → 全量（标准/材料换了，结论的前提就变了）；
//   - 改到"全局性"小节（总体架构、数据流、接口、依赖、横切关注点等）→ 全量；
//   - 图纸删掉了小节 → 全量（可能是重构，影响面不可判定）；
//   - 只有局部小节变化，且问题台账里有落在这些行区间的问题 → 只重审这些角色（局部）；
//   - 局部变化但台账里找不到对应问题 → 扩大复审（expand），不假装只影响一处。
//
// 边界：这是启发式判断，不是证明。界面上必须显示"依据"和"不确定"的地方。

import fs from 'node:fs'
import { listReviewRuns, sectionsOf } from './review-batch.js'
import { readLedger } from './ledger.js'

const GLOBAL_SECTION_RE =
  /(架构|总体|整体|总览|数据流|接口|依赖|横切|全局|约束|非功能|性能|安全|overview|architecture|data-?flow|interface|dependenc|constraint|non-?functional)/i

const GLOBAL_ROLES = ['structural', 'zoom_out', 'design_critic', 'codebase_details']

function readDocText(docPath) {
  try {
    return fs.readFileSync(String(docPath ?? ''), 'utf8')
  } catch {
    return null
  }
}

/**
 * 分析一次改动的复审影响面。
 *
 * @param {{ workspace: string, taskId: string|null, docPath: string, configHash?: string|null, materialManifestHash?: string|null }} params
 * @returns {object} { ok, mode: 'full'|'expand'|'local', changed, added, removed, affectedRoles, reason, basis }
 */
export function analyzeReviewImpact({
  workspace,
  taskId = null,
  docPath,
  configHash = null,
  materialManifestHash = null,
}) {
  const text = readDocText(docPath)
  if (text === null) {
    return {
      ok: false,
      code: 'E_DOC_UNREADABLE',
      error: '图纸读不出来，无法判断影响面；请先确认文件存在。',
      mode: 'full',
      affectedRoles: [],
      reason: '图纸读不出来。',
    }
  }
  const currentSections = sectionsOf(text)
  const listed = listReviewRuns({ workspace, taskId, limit: 20 })
  const runs = listed.ok ? listed.runs : []
  const usable = runs.filter(run => run.status === 'completed' || run.status === 'partial')
  if (usable.length === 0) {
    return {
      ok: true,
      mode: 'full',
      changed: [],
      added: [],
      removed: [],
      affectedRoles: [],
      reason: '没有可用的评审记录，这次按全量重审处理。',
      basis: 'no-review-run',
    }
  }
  const latest = usable[0]

  // 配置/材料变了 → 全量
  const configChanged = String(configHash ?? '') !== String(latest.configHash ?? '')
  const materialsChanged = String(materialManifestHash ?? '') !== String(latest.materialManifestHash ?? '')
  if (configChanged || materialsChanged) {
    return {
      ok: true,
      mode: 'full',
      changed: [],
      added: [],
      removed: [],
      affectedRoles: [],
      reason: configChanged
        ? '评审配置变了（角色/标准/覆盖范围不同），旧结论的前提不成立，按全量重审处理。'
        : '材料清单变了，旧结论依据的材料已经不同，按全量重审处理。',
      basis: configChanged ? 'config-changed' : 'materials-changed',
      runId: latest.runId,
    }
  }

  const before = new Map((latest.sections ?? []).map(section => [section.sectionId, section]))
  const after = new Map(currentSections.map(section => [section.sectionId, section]))
  const changed = []
  const added = []
  const removed = []
  for (const [id, section] of after) {
    const old = before.get(id)
    if (!old) added.push({ sectionId: id, title: section.title })
    else if (old.hash !== section.hash) changed.push({ sectionId: id, title: section.title, startLine: section.startLine, endLine: section.endLine })
  }
  for (const [id, section] of before) {
    if (!after.has(id)) removed.push({ sectionId: id, title: section.title })
  }

  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    return {
      ok: true,
      mode: 'local',
      changed,
      added,
      removed,
      affectedRoles: [],
      reason: '图纸正文与上次评审时一致，旧结论仍然对应这份内容（但这不等于结论正确）。',
      basis: 'unchanged',
      runId: latest.runId,
    }
  }

  if (removed.length > 0) {
    return {
      ok: true,
      mode: 'full',
      changed,
      added,
      removed,
      affectedRoles: [],
      reason: `有 ${removed.length} 个小节被删除或改名，可能是结构调整，影响面无法可靠判定，按全量重审处理。`,
      basis: 'section-removed',
      runId: latest.runId,
    }
  }

  const globalTouched = changed
    .concat(added)
    .filter(item => GLOBAL_SECTION_RE.test(String(item.title ?? '')) || GLOBAL_SECTION_RE.test(String(item.sectionId ?? '')))
  if (globalTouched.length > 0) {
    return {
      ok: true,
      mode: 'full',
      changed,
      added,
      removed,
      affectedRoles: [],
      reason: `改到了全局性小节（${globalTouched.map(item => item.title).slice(0, 3).join('、')}），这类改动会影响跨小节一致性，按全量重审处理。`,
      basis: 'global-section',
      runId: latest.runId,
    }
  }

  // 台账里落在改动区间的问题 → 这些角色需要重看
  const ledgerRead = readLedger({ workspace, taskId: taskId ?? latest.taskId ?? '' })
  const findings = ledgerRead.ok ? ledgerRead.ledger.findings : []
  const touchedRanges = changed.filter(item => Number.isInteger(item.startLine))
  const hitRoles = new Set()
  for (const finding of findings) {
    if (!finding?.range || !Number.isInteger(finding.range.start)) continue
    const overlap = touchedRanges.some(
      item => finding.range.start <= item.endLine && finding.range.end >= item.startLine,
    )
    if (overlap && finding.role) hitRoles.add(String(finding.role))
  }

  if (hitRoles.size > 0) {
    return {
      ok: true,
      mode: 'local',
      changed,
      added,
      removed,
      affectedRoles: Array.from(hitRoles).sort(),
      reason: `只有局部小节变化，且台账里有 ${hitRoles.size} 个角色的问题落在这几段，建议只重审这些角色。`,
      basis: 'local-findings',
      runId: latest.runId,
    }
  }

  const affected = new Set(GLOBAL_ROLES)
  return {
    ok: true,
    mode: 'expand',
    changed,
    added,
    removed,
    affectedRoles: Array.from(affected).sort(),
    reason: `局部小节有变化（${changed.concat(added).map(item => item.title).slice(0, 3).join('、')}），但台账里没有对应的历史问题可定位，建议扩大复审而不是只审一处。`,
    basis: 'no-finding-coverage',
    runId: latest.runId,
  }
}

/**
 * 判断某条评审记录相对当前图纸是否已经过期（只用于显示，不删记录）。
 * @param {{ workspace: string, taskId?: string|null, docPath: string }} params
 */
export function staleReviewRuns({ workspace, taskId = null, docPath }) {
  const text = readDocText(docPath)
  if (text === null) return { ok: false, runs: [], error: '图纸读不出来。' }
  const current = new Map(sectionsOf(text).map(section => [section.sectionId, section.hash]))
  const listed = listReviewRuns({ workspace, taskId, limit: 20 })
  const runs = (listed.ok ? listed.runs : []).map(run => {
    const changed = (run.sections ?? []).filter(section => current.get(section.sectionId) !== section.hash).length
    return {
      runId: run.runId,
      status: run.status,
      createdAt: run.createdAt,
      stale: changed > 0,
      changedSections: changed,
      jobs: run.jobs.map(job => ({ role: job.role, status: job.status })),
    }
  })
  return { ok: true, runs }
}
