// EGM 任务台账（Ledger）
//
// 目的：把"需求—图纸—问题—处置—交付"变成能查的事实，而不是散在聊天里的记忆。
//   - 需求：编号、原文、关联图纸段落、关联问题、关联交付物、证据等级；
//   - 问题：来自某次评审，保留原文摘录、核实状态（未核实/已确认/已推翻）、处置（未处理/已修/接受风险/延期）；
//   - 产物：登记过的文件（含内容哈希），一份正式图纸只有一个"当前"引用。
//
// 边界（诚实声明）：
//   - 台账只记录"谁在什么时候说了什么"，不证明图纸真的实现、也不替代真机验收；
//   - 标成"已确认"必须写证据来源；标成"已验证"只是记录了声称，界面上仍标"未独立核实"；
//   - 台账可被人为改写或删除，它不是安全边界，也不是审批凭证。

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const LEDGER_SCHEMA_VERSION = 1
export const SEVERITIES = ['blocker', 'high', 'medium', 'low']
export const VERIFICATION_STATES = ['unverified', 'confirmed', 'disproven']
export const DISPOSITIONS = ['open', 'fixed', 'accepted-risk', 'deferred']
export const EVIDENCE_LEVELS = ['planned', 'reported', 'claimed-verified']
export const ARTIFACT_KINDS = [
  'brief',
  'draft',
  'design',
  'review-report',
  'review-summary',
  'bootstrap-doc',
  'drift-report',
  'handoff',
  'code-diff',
  'other',
]

const MAX_QUOTE_CHARS = 4000
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024

/** 台账目录：.egm/tasks/<taskId>/ */
export function taskDirPath(workspace, taskId) {
  return join(resolve(String(workspace ?? '.')), '.egm', 'tasks', safeId(taskId))
}

/** 台账文件：.egm/tasks/<taskId>/ledger.json */
export function ledgerPath(workspace, taskId) {
  return join(taskDirPath(workspace, taskId), 'ledger.json')
}

/** 只保留安全字符，避免路径穿越。 */
export function safeId(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return 'unknown'
  return text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

function emptyLedger(taskId) {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    taskId: safeId(taskId),
    requirements: [],
    findings: [],
    artifacts: [],
    currentDesignId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function clip(text, max = MAX_QUOTE_CHARS) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…（已截断，原文 ${value.length} 字）` : value
}

/**
 * 读台账。文件不存在不算错误（返回空台账）。
 * @returns {{ ok: boolean, ledger: object|null, path: string, code?: string, error?: string }}
 */
export function readLedger({ workspace, taskId }) {
  const path = ledgerPath(workspace, taskId)
  let raw
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, ledger: emptyLedger(taskId), path, fresh: true }
    }
    return { ok: false, ledger: null, path, code: 'E_LEDGER_UNREADABLE', error: `台账读不出来：${error?.message ?? String(error)}` }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, ledger: null, path, code: 'E_LEDGER_CORRUPT', error: '台账内容不是对象，无法解析。' }
    }
    const ledger = {
      ...emptyLedger(taskId),
      ...parsed,
      requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    }
    return { ok: true, ledger, path }
  } catch (error) {
    return {
      ok: false,
      ledger: null,
      path,
      code: 'E_LEDGER_CORRUPT',
      error: `台账不是合法 JSON（${error?.message ?? String(error)}）。请先备份该文件，不要直接覆盖。`,
    }
  }
}

/** 原子写台账。 */
export function writeLedger({ workspace, taskId, ledger }) {
  const path = ledgerPath(workspace, taskId)
  const dir = taskDirPath(workspace, taskId)
  const payload = { ...ledger, schemaVersion: LEDGER_SCHEMA_VERSION, taskId: safeId(taskId), updatedAt: Date.now() }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, path)
    return { ok: true, ledger: payload, path }
  } catch (error) {
    return { ok: false, ledger: null, path, code: 'E_LEDGER_WRITE', error: `台账写入失败：${error?.message ?? String(error)}` }
  }
}

/**
 * 读—改—写一体：回调拿到可变台账，返回 false 表示不保存。
 * @param {(ledger: object) => boolean|void} mutate
 */
export function mutateLedger({ workspace, taskId }, mutate) {
  const read = readLedger({ workspace, taskId })
  if (!read.ok) return read
  const keep = mutate(read.ledger)
  if (keep === false) return { ok: true, ledger: read.ledger, path: read.path, unchanged: true }
  return writeLedger({ workspace, taskId, ledger: read.ledger })
}

/** 计算文件 sha256；读不到返回 null。 */
export function fileSha256(filePath) {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 把产物路径规整为工作区相对路径，并拒绝逃逸。
 * @returns {{ ok: true, relativePath: string, absolutePath: string } | { ok: false, code: string, error: string }}
 */
export function normalizeArtifactPath({ workspace, path }) {
  const ws = resolve(String(workspace ?? '.'))
  const raw = String(path ?? '').trim()
  if (!raw) return { ok: false, code: 'E_ARTIFACT_PATH_EMPTY', error: '产物路径为空。' }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ws, raw)
  const rel = relative(ws, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: 'E_ARTIFACT_PATH_ESCAPE', error: `产物必须位于工作区内：${raw}` }
  }
  return { ok: true, relativePath: rel.split(sep).join('/'), absolutePath: absolute }
}

// ---------------------------------------------------------------------------
// 需求
// ---------------------------------------------------------------------------

/**
 * 登记或更新一条需求。
 * @param {{ workspace: string, taskId: string, requirement: { id?: string, title?: string, statement: string, sourceRefs?: string[] } }} params
 */
export function upsertRequirement({ workspace, taskId, requirement }) {
  const statement = String(requirement?.statement ?? '').trim()
  if (!statement) return { ok: false, code: 'E_REQUIREMENT_EMPTY', error: '需求原文不能为空。' }
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const id = String(requirement?.id ?? '').trim()
    const existing = id ? ledger.requirements.find(item => item.id === id) : null
    if (existing) {
      existing.statement = clip(statement)
      if (requirement.title) existing.title = clip(requirement.title, 200)
      if (Array.isArray(requirement.sourceRefs)) existing.sourceRefs = requirement.sourceRefs.map(String)
      existing.updatedAt = Date.now()
      saved = existing
      return
    }
    const created = {
      id: id || newId('req'),
      title: clip(requirement?.title ?? statement.slice(0, 60), 200),
      statement: clip(statement),
      sourceRefs: Array.isArray(requirement?.sourceRefs) ? requirement.sourceRefs.map(String) : [],
      designRefs: [],
      findingIds: [],
      deliveryRefs: [],
      evidenceLevel: 'planned',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    ledger.requirements.push(created)
    saved = created
  })
  if (!result.ok) return result
  return { ok: true, requirement: saved, path: result.path }
}

/**
 * 把需求与图纸段落/问题/交付物关联起来。
 * @param {{ workspace: string, taskId: string, requirementId: string, kind: 'design'|'finding'|'delivery', ref: string }} params
 */
export function linkRequirement({ workspace, taskId, requirementId, kind, ref }) {
  const value = String(ref ?? '').trim()
  if (!value) return { ok: false, code: 'E_LINK_EMPTY', error: '关联目标不能为空。' }
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const requirement = ledger.requirements.find(item => item.id === requirementId)
    if (!requirement) return false
    const bucket =
      kind === 'design' ? 'designRefs' : kind === 'finding' ? 'findingIds' : kind === 'delivery' ? 'deliveryRefs' : null
    if (!bucket) return false
    if (!Array.isArray(requirement[bucket])) requirement[bucket] = []
    if (!requirement[bucket].includes(value)) requirement[bucket].push(value)
    requirement.updatedAt = Date.now()
    saved = requirement
  })
  if (!result.ok) return result
  if (result.unchanged || !saved) return { ok: false, code: 'E_REQUIREMENT_NOT_FOUND', error: `找不到需求 ${requirementId}。` }
  return { ok: true, requirement: saved, path: result.path }
}

/**
 * 记录需求证据等级。只允许 planned / reported / claimed-verified；
 * claimed-verified 必须写清"谁用什么方式声称验证过"，界面仍显示未独立核实。
 */
export function setRequirementEvidence({ workspace, taskId, requirementId, level, evidence = '' }) {
  const target = String(level ?? '').trim()
  if (!EVIDENCE_LEVELS.includes(target)) {
    return { ok: false, code: 'E_EVIDENCE_INVALID', error: `证据等级只能是 ${EVIDENCE_LEVELS.join(' / ')}。` }
  }
  if (target === 'claimed-verified' && String(evidence ?? '').trim() === '') {
    return { ok: false, code: 'E_EVIDENCE_REQUIRED', error: '要标"已验证"必须写清证据来源（谁、用什么方式）。' }
  }
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const requirement = ledger.requirements.find(item => item.id === requirementId)
    if (!requirement) return false
    requirement.evidenceLevel = target
    requirement.evidence = String(evidence ?? '').trim()
    requirement.evidenceAt = Date.now()
    requirement.updatedAt = Date.now()
    saved = requirement
  })
  if (!result.ok) return result
  if (result.unchanged || !saved) return { ok: false, code: 'E_REQUIREMENT_NOT_FOUND', error: `找不到需求 ${requirementId}。` }
  return { ok: true, requirement: saved, path: result.path }
}

// ---------------------------------------------------------------------------
// 问题
// ---------------------------------------------------------------------------

/**
 * 登记一条评审问题（来自某次运行/角色）。
 * @param {{ workspace: string, taskId: string, finding: object }} params
 */
export function upsertFinding({ workspace, taskId, finding }) {
  const summary = String(finding?.summary ?? '').trim()
  const quote = String(finding?.quote ?? '').trim()
  if (!summary && !quote) {
    return { ok: false, code: 'E_FINDING_EMPTY', error: '问题至少要有一句摘要或原文摘录。' }
  }
  const severity = SEVERITIES.includes(String(finding?.severity)) ? String(finding.severity) : 'medium'
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const id = String(finding?.id ?? '').trim()
    const existing = id ? ledger.findings.find(item => item.id === id) : null
    if (existing) {
      if (summary) existing.summary = clip(summary, 1000)
      if (quote) existing.quote = clip(quote)
      existing.severity = severity
      if (finding.requiredFix) existing.requiredFix = clip(finding.requiredFix, 1000)
      existing.updatedAt = Date.now()
      saved = existing
      return
    }
    const created = {
      id: id || newId('fnd'),
      runId: finding?.runId ? String(finding.runId) : null,
      role: finding?.role ? String(finding.role) : null,
      severity,
      range: finding?.range && Number.isInteger(finding.range.start) ? { start: finding.range.start, end: finding.range.end } : null,
      summary: clip(summary, 1000),
      quote: clip(quote),
      requiredFix: clip(finding?.requiredFix ?? '', 1000),
      verification: { state: 'unverified', evidence: '', verifiedAt: null, by: null },
      disposition: { state: 'open', note: '', riskScope: '', at: null },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    ledger.findings.push(created)
    saved = created
  })
  if (!result.ok) return result
  return { ok: true, finding: saved, path: result.path }
}

/** 核实一条问题：未核实 / 已确认（必须给证据）/ 已推翻。 */
export function setFindingVerification({ workspace, taskId, findingId, state, evidence = '', by = 'elephant' }) {
  const target = String(state ?? '').trim()
  if (!VERIFICATION_STATES.includes(target)) {
    return { ok: false, code: 'E_VERIFICATION_INVALID', error: `核实状态只能是 ${VERIFICATION_STATES.join(' / ')}。` }
  }
  const note = String(evidence ?? '').trim()
  if (target === 'confirmed' && note === '') {
    return { ok: false, code: 'E_VERIFICATION_EVIDENCE_REQUIRED', error: '标"已确认"必须写清证据来源（引用文件、行号或复现方式）。' }
  }
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const finding = ledger.findings.find(item => item.id === findingId)
    if (!finding) return false
    finding.verification = { state: target, evidence: clip(note, 2000), verifiedAt: Date.now(), by: String(by ?? '') }
    finding.updatedAt = Date.now()
    saved = finding
  })
  if (!result.ok) return result
  if (result.unchanged || !saved) return { ok: false, code: 'E_FINDING_NOT_FOUND', error: `找不到问题 ${findingId}。` }
  return { ok: true, finding: saved, path: result.path }
}

/** 处置一条问题：未处理 / 已修 / 接受风险（必须写范围）/ 延期。 */
export function setFindingDisposition({ workspace, taskId, findingId, disposition, note = '', riskScope = '' }) {
  const target = String(disposition ?? '').trim()
  if (!DISPOSITIONS.includes(target)) {
    return { ok: false, code: 'E_DISPOSITION_INVALID', error: `处置只能是 ${DISPOSITIONS.join(' / ')}。` }
  }
  const scope = String(riskScope ?? '').trim()
  if (target === 'accepted-risk' && scope === '') {
    return { ok: false, code: 'E_RISK_SCOPE_REQUIRED', error: '接受风险必须写清接受的是哪一段风险、由谁决定。' }
  }
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const finding = ledger.findings.find(item => item.id === findingId)
    if (!finding) return false
    finding.disposition = { state: target, note: clip(note, 2000), riskScope: clip(scope, 2000), at: Date.now() }
    finding.updatedAt = Date.now()
    saved = finding
  })
  if (!result.ok) return result
  if (result.unchanged || !saved) return { ok: false, code: 'E_FINDING_NOT_FOUND', error: `找不到问题 ${findingId}。` }
  return { ok: true, finding: saved, path: result.path }
}

/** 列出问题（可按严重度/核实/处置过滤）。 */
export function listFindings({ workspace, taskId, severity = null, verification = null, disposition = null, limit = 50 }) {
  const read = readLedger({ workspace, taskId })
  if (!read.ok) return read
  const items = read.ledger.findings
    .filter(item => (severity ? item.severity === severity : true))
    .filter(item => (verification ? item.verification?.state === verification : true))
    .filter(item => (disposition ? item.disposition?.state === disposition : true))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
  return { ok: true, findings: items, total: read.ledger.findings.length, path: read.path }
}

// ---------------------------------------------------------------------------
// 产物
// ---------------------------------------------------------------------------

/**
 * 登记产物（文件必须存在于工作区内，自动算哈希）。
 * @param {{ workspace: string, taskId: string, artifact: { kind: string, path: string, producer?: string, note?: string, sourceRefs?: string[] } }} params
 */
export function upsertArtifact({ workspace, taskId, artifact }) {
  const kind = ARTIFACT_KINDS.includes(String(artifact?.kind)) ? String(artifact.kind) : 'other'
  const normalized = normalizeArtifactPath({ workspace, path: artifact?.path })
  if (!normalized.ok) return normalized
  let stat
  try {
    stat = fs.statSync(normalized.absolutePath)
  } catch (error) {
    return { ok: false, code: 'E_ARTIFACT_MISSING', error: `产物文件不存在：${normalized.relativePath}` }
  }
  if (!stat.isFile()) return { ok: false, code: 'E_ARTIFACT_NOT_FILE', error: `产物不是普通文件：${normalized.relativePath}` }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    return { ok: false, code: 'E_ARTIFACT_TOO_LARGE', error: `产物超过 ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)}MB：${normalized.relativePath}` }
  }
  const hash = fileSha256(normalized.absolutePath)
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const existing = ledger.artifacts.find(item => item.path === normalized.relativePath && item.kind === kind)
    if (existing) {
      existing.contentHash = hash
      existing.bytes = stat.size
      existing.registeredAt = Date.now()
      if (artifact?.note) existing.note = clip(artifact.note, 1000)
      saved = existing
      return
    }
    const created = {
      id: newId('art'),
      kind,
      path: normalized.relativePath,
      contentHash: hash,
      bytes: stat.size,
      producer: artifact?.producer ? String(artifact.producer) : null,
      sourceRefs: Array.isArray(artifact?.sourceRefs) ? artifact.sourceRefs.map(String) : [],
      note: clip(artifact?.note ?? '', 1000),
      registeredAt: Date.now(),
    }
    ledger.artifacts.push(created)
    if (kind === 'design') ledger.currentDesignId = created.id
    saved = created
  })
  if (!result.ok) return result
  return { ok: true, artifact: saved, path: result.path }
}

/** 指定哪一份图纸是当前版本（只改引用，不移动文件）。 */
export function setCurrentDesign({ workspace, taskId, artifactId }) {
  let saved = null
  const result = mutateLedger({ workspace, taskId }, ledger => {
    const artifact = ledger.artifacts.find(item => item.id === artifactId)
    if (!artifact || artifact.kind !== 'design') return false
    ledger.currentDesignId = artifact.id
    saved = artifact
  })
  if (!result.ok) return result
  if (result.unchanged || !saved) return { ok: false, code: 'E_ARTIFACT_NOT_FOUND', error: `找不到图纸产物 ${artifactId}。` }
  return { ok: true, artifact: saved, path: result.path }
}

/** 当前图纸产物（可能为 null）。 */
export function currentDesignArtifact(ledger) {
  if (!ledger?.currentDesignId) return null
  return ledger.artifacts.find(item => item.id === ledger.currentDesignId) ?? null
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * 台账汇总：给面板与"能不能开始实现"的检查用。
 * 结论只有"看起来完整/尚不完整"，不代替评审结论。
 */
export function summarizeLedger(ledger) {
  const findings = Array.isArray(ledger?.findings) ? ledger.findings : []
  const requirements = Array.isArray(ledger?.requirements) ? ledger.requirements : []
  const bySeverity = { blocker: 0, high: 0, medium: 0, low: 0 }
  const byVerification = { unverified: 0, confirmed: 0, disproven: 0 }
  const byDisposition = { open: 0, fixed: 0, 'accepted-risk': 0, deferred: 0 }
  for (const finding of findings) {
    if (bySeverity[finding.severity] !== undefined) bySeverity[finding.severity] += 1
    const verification = finding.verification?.state ?? 'unverified'
    if (byVerification[verification] !== undefined) byVerification[verification] += 1
    const disposition = finding.disposition?.state ?? 'open'
    if (byDisposition[disposition] !== undefined) byDisposition[disposition] += 1
  }
  const severeUnverified = findings.filter(
    item => (item.severity === 'blocker' || item.severity === 'high') && item.verification?.state !== 'confirmed',
  )
  const openBlockers = findings.filter(
    item => item.severity === 'blocker' && item.disposition?.state !== 'fixed' && item.disposition?.state !== 'accepted-risk',
  )
  const incomplete = severeUnverified.length > 0 || openBlockers.length > 0
  const reasons = []
  if (severeUnverified.length > 0) reasons.push(`${severeUnverified.length} 条严重问题还没核实`)
  if (openBlockers.length > 0) reasons.push(`${openBlockers.length} 条阻断问题还没处理`)
  return {
    requirements: requirements.length,
    findings: findings.length,
    bySeverity,
    byVerification,
    byDisposition,
    severeUnverified: severeUnverified.length,
    openBlockers: openBlockers.length,
    artifacts: Array.isArray(ledger?.artifacts) ? ledger.artifacts.length : 0,
    currentDesign: currentDesignArtifact(ledger),
    incomplete,
    note: incomplete ? `尚不完整：${reasons.join('；')}。` : '没有发现未核实的严重问题或未处理的阻断问题（这不等于设计已通过）。',
  }
}
