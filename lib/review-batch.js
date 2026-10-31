// EGM 评审批次运行记录（Review Runs）
//
// 目的：阶段内多条金鱼并行时，把"这一批派了谁、谁回来了、报告在哪"落盘，
// 让进程重启后能回答三个问题，而不是靠聊天回忆：
//   1. 这批到底跑完了没有？（没跑完的一律标 unknown，绝不自动重跑）
//   2. 哪些角色的报告还能用？（要同时满足：图纸哈希、配置哈希、材料清单哈希都没变）
//   3. 重试要不要重新扣预算？（失败项重试算新派发；只重做汇不算金鱼）
//
// 边界（诚实声明）：
//   - 宿主没有"查询子代理作业状态"的接口，重启后我们只能依据自己落的记录判断；
//     记录里没有终态的一律标 unknown，宁可让用户手动重试，也不假装成功；
//   - 这里只记调度事实，不评价报告质量；报告是否成立仍要大象核实。

import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const RUN_STATUSES = ['running', 'completed', 'partial', 'failed', 'unknown']
export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'unknown', 'cancelled']
export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'unknown', 'cancelled']

/** 运行记录目录：.egm/runs/ */
export function runsDirPath(workspace) {
  return join(resolve(String(workspace ?? '.')), '.egm', 'runs')
}

function runPath(workspace, runId) {
  return join(runsDirPath(workspace), `${String(runId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

function sha(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// 图纸段落
// ---------------------------------------------------------------------------

/**
 * 把 Markdown 按标题切段，给出每段的行区间与内容哈希。
 * 重复标题用出现序号区分，避免"同名小节"被当成同一段。
 *
 * @param {string} text
 * @returns {Array<{ sectionId: string, title: string, level: number, path: string[], startLine: number, endLine: number, hash: string }>}
 */
export function sectionsOf(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const headings = []
  const seen = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (!match) continue
    const level = match[1].length
    const title = match[2].trim()
    const key = `${level}|${title}`
    const index = (seen.get(key) ?? 0) + 1
    seen.set(key, index)
    headings.push({ level, title, index, line: i })
  }
  const result = []
  const stack = []
  for (let h = 0; h < headings.length; h += 1) {
    const heading = headings[h]
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop()
    stack.push({ level: heading.level, title: heading.title })
    const startLine = heading.line + 1
    const nextLine = h + 1 < headings.length ? headings[h + 1].line : lines.length
    const body = lines.slice(heading.line, nextLine).join('\n')
    const slug = stack
      .map(item => item.title.replace(/\s+/g, '-'))
      .join('/')
    const sectionId = `${slug}${heading.index > 1 ? `#${heading.index}` : ''}`
    result.push({
      sectionId,
      title: heading.title,
      level: heading.level,
      path: stack.map(item => item.title),
      startLine,
      endLine: Math.max(startLine, nextLine),
      hash: sha(body.trim()),
    })
  }
  return result
}

/** 只取段落标识 + 哈希（存进运行记录，用于增量复审比对）。 */
export function sectionHashes(text) {
  return sectionsOf(text).map(section => ({ sectionId: section.sectionId, title: section.title, hash: section.hash }))
}

/**
 * 按标题（或标题路径）找回当前行区间。找不到/有歧义都明确报错，不猜旧行号。
 * @param {string} text
 * @param {{ title?: string, headingPath?: string[] }} target
 */
export function resolveSectionRange(text, target = {}) {
  const sections = sectionsOf(text)
  const wantedPath = Array.isArray(target.headingPath) ? target.headingPath.map(String) : null
  const wantedTitle = target.title ? String(target.title).trim() : null
  const matches = sections.filter(section => {
    if (wantedPath && wantedPath.length > 0) {
      if (section.path.length !== wantedPath.length) return false
      return section.path.every((part, index) => part === wantedPath[index])
    }
    return wantedTitle ? section.title === wantedTitle : false
  })
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'E_SECTION_MISSING',
      error: `图纸里找不到这一段（${wantedTitle ?? wantedPath?.join(' / ')}）；请重新选择要审的段落。`,
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'E_SECTION_AMBIGUOUS',
      error: `图纸里有 ${matches.length} 处同名标题（${matches[0].title}），请改用标题路径或行号区间，避免审错段。`,
    }
  }
  const section = matches[0]
  return {
    ok: true,
    sectionId: section.sectionId,
    title: section.title,
    range: { start: section.startLine, end: section.endLine },
    hash: section.hash,
  }
}

// ---------------------------------------------------------------------------
// 运行记录
// ---------------------------------------------------------------------------

function newRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 开一条运行记录（并行派发前调用）。
 * @param {{ workspace: string, sessionId: string, taskId?: string|null, stage?: number|null, mode?: string, docPath: string, docText?: string, configHash?: string|null, materialManifestHash?: string|null, roles: Array<string|{role: string, jobId?: string}> }} params
 */
export function createReviewRun({
  workspace,
  sessionId,
  taskId = null,
  stage = null,
  mode = 'review',
  docPath,
  docText = null,
  configHash = null,
  materialManifestHash = null,
  roles = [],
}) {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return { ok: false, code: 'E_RUN_NO_SESSION', error: '缺少会话标识，无法开运行记录。' }
  if (!docPath) return { ok: false, code: 'E_RUN_NO_DOC', error: '缺少图纸路径，无法开运行记录。' }
  const run = {
    runId: newRunId(),
    sessionId: sid,
    taskId: taskId ? String(taskId) : null,
    stage: stage ?? null,
    mode: String(mode ?? 'review'),
    docPath: String(docPath),
    docSha256: (() => {
      try {
        return createHash('sha256').update(fs.readFileSync(docPath)).digest('hex')
      } catch {
        return null
      }
    })(),
    configHash: configHash ? String(configHash) : null,
    materialManifestHash: materialManifestHash ? String(materialManifestHash) : null,
    sections: docText ? sectionHashes(docText) : [],
    jobs: (Array.isArray(roles) ? roles : []).map(item => {
      const role = typeof item === 'string' ? item : String(item?.role ?? '')
      const jobId = typeof item === 'string' ? null : item?.jobId ? String(item.jobId) : null
      return { role, jobId, status: 'pending', reportPath: null, error: null, startedAt: null, endedAt: null }
    }),
    status: 'running',
    summaryPath: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const saved = writeRun(workspace, run)
  if (!saved.ok) return saved
  return { ok: true, run }
}

function writeRun(workspace, run) {
  const path = runPath(workspace, run.runId)
  try {
    fs.mkdirSync(runsDirPath(workspace), { recursive: true })
    const payload = { ...run, updatedAt: Date.now() }
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, path)
    return { ok: true, run: payload, path }
  } catch (error) {
    return { ok: false, code: 'E_RUN_WRITE', error: `运行记录写入失败：${error?.message ?? String(error)}` }
  }
}

/** 读一条运行记录。 */
export function readReviewRun({ workspace, runId }) {
  const path = runPath(workspace, runId)
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, code: 'E_RUN_CORRUPT', error: '运行记录不是对象。' }
    }
    if (!Array.isArray(parsed.jobs)) parsed.jobs = []
    return { ok: true, run: parsed, path }
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'E_RUN_NOT_FOUND' : 'E_RUN_UNREADABLE'
    return { ok: false, code, error: code === 'E_RUN_NOT_FOUND' ? `找不到运行记录 ${runId}。` : `运行记录读不出来：${error?.message ?? String(error)}` }
  }
}

/**
 * 更新某个角色的作业状态。
 * @param {{ workspace: string, runId: string, role: string, status: string, reportPath?: string|null, error?: string|null }} params
 */
export function updateReviewRunJob({ workspace, runId, role, status, reportPath = null, error = null }) {
  const target = String(status ?? '').trim()
  if (!JOB_STATUSES.includes(target)) {
    return { ok: false, code: 'E_JOB_STATUS_INVALID', error: `作业状态只能是 ${JOB_STATUSES.join(' / ')}。` }
  }
  const read = readReviewRun({ workspace, runId })
  if (!read.ok) return read
  const job = read.run.jobs.find(item => item.role === String(role))
  if (!job) return { ok: false, code: 'E_JOB_NOT_FOUND', error: `运行记录里没有角色 ${role}。` }
  const now = Date.now()
  job.status = target
  if (target === 'running' && !job.startedAt) job.startedAt = now
  if (TERMINAL_JOB_STATUSES.includes(target)) job.endedAt = now
  if (reportPath !== null) job.reportPath = reportPath || null
  if (error !== null) job.error = error ? String(error) : null
  const saved = writeRun(workspace, read.run)
  if (!saved.ok) return saved
  return { ok: true, run: saved.run, job }
}

/**
 * 收尾一条运行记录：按各作业终态推出整体状态。
 * 全部 completed → completed；有成功也有失败/未知 → partial；全失败 → failed；仍有未终态 → 保持 running。
 */
export function finishReviewRun({ workspace, runId, summaryPath = null }) {
  const read = readReviewRun({ workspace, runId })
  if (!read.ok) return read
  const run = read.run
  if (summaryPath) run.summaryPath = String(summaryPath)
  const statuses = run.jobs.map(job => job.status)
  const pending = statuses.filter(status => !TERMINAL_JOB_STATUSES.includes(status))
  if (pending.length > 0) {
    run.status = 'running'
  } else if (statuses.length === 0) {
    run.status = 'failed'
  } else if (statuses.every(status => status === 'completed')) {
    run.status = 'completed'
  } else if (statuses.some(status => status === 'completed')) {
    run.status = 'partial'
  } else {
    run.status = 'failed'
  }
  const saved = writeRun(workspace, run)
  if (!saved.ok) return saved
  return { ok: true, run: saved.run }
}

/** 列运行记录（同一任务，时间新的优先）。 */
export function listReviewRuns({ workspace, taskId = null, limit = 20 }) {
  let names = []
  try {
    names = fs.readdirSync(runsDirPath(workspace)).filter(name => name.endsWith('.json')).sort().reverse()
  } catch {
    return { ok: true, runs: [] }
  }
  const runs = []
  // 文件名带时间戳，倒序读≈按时间从新到旧；最多读 150 份，够用且不至于在轮询里拖垮磁盘。
  const budget = Math.min(names.length, 150)
  for (let i = 0; i < budget; i += 1) {
    const name = names[i]
    try {
      const parsed = JSON.parse(fs.readFileSync(join(runsDirPath(workspace), name), 'utf8'))
      if (!parsed || typeof parsed !== 'object') continue
      if (taskId && parsed.taskId !== String(taskId)) continue
      runs.push(parsed)
      if (runs.length >= limit) break
    } catch {
      // 损坏记录跳过，不影响其它记录
    }
  }
  runs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return { ok: true, runs: runs.slice(0, limit) }
}

/**
 * 重启对账：把所有"还在 running 但作业没有终态"的记录标成 unknown。
 * 绝不自动重派、不自动恢复许可。
 *
 * @param {{ workspace: string, taskId?: string|null }} params
 * @returns {{ ok: boolean, changed: Array<{ runId: string, roles: string[] }> }}
 */
export function reconcileReviewRuns({ workspace, taskId = null }) {
  const listed = listReviewRuns({ workspace, taskId, limit: 200 })
  if (!listed.ok) return { ok: false, changed: [], error: listed.error }
  const changed = []
  for (const run of listed.runs) {
    if (run.status !== 'running') continue
    const stuck = run.jobs.filter(job => !TERMINAL_JOB_STATUSES.includes(job.status))
    if (stuck.length === 0) {
      finishReviewRun({ workspace, runId: run.runId })
      continue
    }
    for (const job of stuck) {
      job.status = 'unknown'
      job.endedAt = Date.now()
      job.error = job.error || '进程重启或记录中断：宿主没有可查询的作业状态，按未知处理，未自动重跑。'
    }
    run.status = 'unknown'
    const saved = writeRun(workspace, run)
    if (saved.ok) changed.push({ runId: run.runId, roles: stuck.map(job => job.role) })
  }
  return { ok: true, changed }
}

/**
 * 重试计划：哪些角色的报告能复用，哪些必须重派。
 * 复用条件（全部满足）：作业 completed、有报告文件、图纸哈希一致、配置哈希一致、材料清单哈希一致。
 *
 * @param {{ workspace: string, runId: string, docPath?: string, configHash?: string|null, materialManifestHash?: string|null }} params
 */
export function planReviewRetry({ workspace, runId, docPath = null, configHash = null, materialManifestHash = null }) {
  const read = readReviewRun({ workspace, runId })
  if (!read.ok) return read
  const run = read.run
  const targetDoc = String(docPath || run.docPath || '')
  let currentDocHash = null
  try {
    currentDocHash = createHash('sha256').update(fs.readFileSync(targetDoc)).digest('hex')
  } catch {
    currentDocHash = null
  }
  const sameDoc = currentDocHash !== null && run.docSha256 !== null && currentDocHash === run.docSha256
  const sameConfig = String(configHash ?? '') === String(run.configHash ?? '')
  const sameMaterials = String(materialManifestHash ?? '') === String(run.materialManifestHash ?? '')
  const reuse = []
  const retry = []
  const reasons = []
  if (!sameDoc) reasons.push('图纸内容变了（哈希不一致）')
  if (!sameConfig) reasons.push('评审配置变了（哈希不一致）')
  if (!sameMaterials) reasons.push('材料清单变了（哈希不一致）')
  for (const job of run.jobs) {
    const reportOk = job.status === 'completed' && job.reportPath && fs.existsSync(job.reportPath)
    if (reportOk && sameDoc && sameConfig && sameMaterials) reuse.push(job.role)
    else retry.push(job.role)
  }
  return {
    ok: true,
    runId: run.runId,
    reuse,
    retry,
    reason: reasons.length > 0 ? reasons.join('；') : reuse.length > 0 ? '图纸、配置、材料都没变，成功的报告可以复用。' : '没有可复用的成功报告。',
    canReuseSummary: false,
  }
}

/** 运行记录的一句话摘要（给面板）。 */
export function describeReviewRun(run) {
  if (!run) return ''
  const done = run.jobs.filter(job => job.status === 'completed').length
  const failed = run.jobs.filter(job => job.status === 'failed').length
  const unknown = run.jobs.filter(job => job.status === 'unknown').length
  const parts = [`${done}/${run.jobs.length} 份报告`]
  if (failed > 0) parts.push(`${failed} 份失败`)
  if (unknown > 0) parts.push(`${unknown} 份未知`)
  return parts.join('，')
}
