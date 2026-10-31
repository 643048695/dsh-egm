// EGM 仓库文档并行整理（Bootstrap）
//
// 目的：把"给一个仓库补设计文档"拆成互不重叠的分区，并行派文档工，最后在父侧统一校验与落盘。
//
// 流程（保守版）：
//   1. planBootstrap：按顶层目录分区，跳过依赖/构建/版本库，给出文件清单与规模；
//   2. dispatchBootstrapWorkers：每个分区一个零上下文子代理，只允许往暂存目录写；
//   3. validateBootstrapOutput：父侧校验产物路径在工作区/暂存目录内、非空、索引可解析；
//   4. commitBootstrap：逐份写入目标目录；目标已存在且内容不同 → 保留候选副本、停止覆盖、报冲突；
//   5. checkpoint：记录已完成分区，重启后只重试未完成的分区。
//
// 边界（诚实声明）：
//   - 暂存目录挡不住子代理去改别的文件（本机无法证实只读），所以提交前必须逐份校验，冲突一律保留双方；
//   - 文档质量不在这里评价，也不代表与代码一致；
//   - 并发数取 min(用户上限, 分区数, 宿主允许)；不承诺宿主一定有独立进程。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const BOOTSTRAP_SCHEMA = 1
export const DEFAULT_BOOTSTRAP_LIMITS = Object.freeze({
  maxPartitions: 12,
  maxFilesPerPartition: 40,
  maxDepth: 4,
  maxFileBytes: 512 * 1024,
  concurrency: 3,
  timeoutMs: 300_000,
})

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.egm', '.pnpm-store', 'node_modules', 'dist', 'build', 'out',
  '.next', '.nuxt', 'target', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'coverage',
  'vendor', 'third_party', 'assets', 'public', 'static',
])

const DOC_EXT = new Set(['.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml'])

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function toPosix(path) {
  return String(path ?? '').split(sep).join('/')
}

function readIgnoreRules(workspace) {
  const rules = []
  for (const name of ['.gitignore', '.egmignore']) {
    try {
      for (const line of fs.readFileSync(join(workspace, name), 'utf8').split(/\r?\n/)) {
        const raw = line.trim()
        if (!raw || raw.startsWith('#')) continue
        const cleaned = raw.replace(/^\/+/, '').replace(/\/+$/, '')
        if (cleaned) rules.push(cleaned)
      }
    } catch {
      // 没有就跳过
    }
  }
  return rules
}

function ignored(relPath, rules) {
  const posix = toPosix(relPath)
  return rules.some(rule => posix === rule || posix.startsWith(`${rule}/`) || posix.includes(`/${rule}/`))
}

/**
 * 生成分区计划。
 * @param {{ workspace: string, root?: string, limits?: object, includeDocs?: boolean }} params
 */
export function planBootstrap({ workspace, root = '.', limits = {}, includeDocs = false }) {
  const config = { ...DEFAULT_BOOTSTRAP_LIMITS, ...limits }
  const ws = resolve(String(workspace ?? '.'))
  const absoluteRoot = resolve(ws, String(root ?? '.'))
  const relRoot = relative(ws, absoluteRoot)
  if (relRoot.startsWith('..') || isAbsolute(relRoot)) {
    return { ok: false, code: 'E_BOOTSTRAP_ESCAPE', error: `扫描根目录必须在工作区内：${root}` }
  }
  let rootStat
  try {
    rootStat = fs.statSync(absoluteRoot)
  } catch {
    return { ok: false, code: 'E_BOOTSTRAP_MISSING', error: `目录不存在：${root}` }
  }
  if (!rootStat.isDirectory()) return { ok: false, code: 'E_BOOTSTRAP_NOT_DIR', error: `不是目录：${root}` }

  const rules = readIgnoreRules(ws)
  const buckets = new Map()
  let totalFiles = 0
  let skipped = 0

  const walk = (current, depth) => {
    if (depth > config.maxDepth) return
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const abs = join(current, entry.name)
      const rel = relative(ws, abs)
      if (SKIP_DIRS.has(entry.name) || ignored(rel, rules)) {
        skipped += 1
        continue
      }
      if (entry.isSymbolicLink()) {
        skipped += 1
        continue
      }
      if (entry.isDirectory()) {
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (!includeDocs && DOC_EXT.has(ext)) {
        skipped += 1
        continue
      }
      if (!includeDocs && !['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.swift', '.lua', '.sh', '.ps1'].includes(ext)) {
        skipped += 1
        continue
      }
      let info
      try {
        info = fs.statSync(abs)
      } catch {
        continue
      }
      if (info.size > config.maxFileBytes) {
        skipped += 1
        continue
      }
      totalFiles += 1
      const top = rel.split(sep)[0] === '..' ? 'root' : rel.split(sep)[0]
      const key = rel.split(sep).length > 1 ? top : '_root'
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push({ relativePath: toPosix(rel), bytes: info.size })
    }
  }

  walk(absoluteRoot, 0)

  const partitions = []
  let truncated = false
  const keys = Array.from(buckets.keys()).sort()
  for (const key of keys) {
    if (partitions.length >= config.maxPartitions) {
      truncated = true
      break
    }
    const files = buckets.get(key).slice(0, config.maxFilesPerPartition)
    if (files.length === 0) continue
    partitions.push({
      id: `p${partitions.length + 1}`,
      label: key === '_root' ? '根目录文件' : key,
      dirs: key === '_root' ? [] : [key],
      files,
      approxBytes: files.reduce((sum, item) => sum + item.bytes, 0),
    })
  }

  return {
    ok: true,
    root: toPosix(relRoot) || '.',
    partitions,
    totalFiles,
    skippedFiles: skipped,
    truncated,
    notes: [
      truncated ? `分区数达到上限 ${config.maxPartitions}，还有目录没有排进来。` : '',
      skipped > 0 ? `跳过 ${skipped} 个文件（依赖/构建/文档/超大/符号链接）。` : '',
      '分区只决定"谁来读哪一堆文件"，不保证子代理只读这些文件。',
    ].filter(Boolean),
  }
}

function textOf(result) {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return ''
  if (typeof result.text === 'string') return result.text
  if (Array.isArray(result.content)) {
    return result.content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n')
  }
  if (typeof result.output === 'string') return result.output
  return ''
}

async function awaitResult(started, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      started.result,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`文档工 ${Math.round(timeoutMs / 1000)} 秒没有交卷`)
          error.code = 'E_TIMEOUT'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function partitionPrompt({ partition, stagingDir, targetDocsRoot }) {
  const list = partition.files.map(item => `- ${item.relativePath}（${item.bytes} 字节）`).join('\n')
  return [
    `你是仓库文档整理工，负责分区「${partition.label}」。`,
    '',
    '任务：只根据下面这些源码文件，写一份该分区的中文设计说明，并给出子树索引。',
    '',
    '要读的文件（工作区相对路径）：',
    list,
    '',
    '输出要求（严格按路径写，别写到别处）：',
    `1. 文档写到：${toPosix(join(stagingDir, partition.id, 'doc.md'))}`,
    `2. 索引写到：${toPosix(join(stagingDir, partition.id, 'subtree_index.json'))}`,
    '3. 索引格式：{"partition":"' + partition.id + '","docs":[{"path":"<工作区相对路径>","summary":"一句话"}],"notes":["不确定的地方"]}',
    '',
    '内容要求：',
    '- 写"代码里实际有什么"：模块职责、关键数据流、对外接口、明显约束；',
    '- 没读到的东西不要编，写进 notes 说明"未覆盖"；',
    '- 不要修改任何源码、不要移动文件、不要写分区以外的路径；',
    `- 目标文档目录将来是 ${targetDocsRoot}，但你只写暂存目录，由父会话统一落盘。`,
    '',
    '完成后用一句话说明：写了哪些文件、还有哪些没覆盖。',
  ].join('\n')
}

/**
 * 并行跑文档工。返回每个分区的结果（不落盘到目标目录）。
 * @param {{ subagents: object, parent: object, workspace: string, plan: object, stagingDir: string, targetDocsRoot?: string, concurrency?: number, timeoutMs?: number, onEvent?: Function, agentPreset?: string }} params
 */
export async function dispatchBootstrapWorkers({
  subagents,
  parent,
  workspace,
  plan,
  stagingDir,
  targetDocsRoot = 'docs/designs',
  concurrency = DEFAULT_BOOTSTRAP_LIMITS.concurrency,
  timeoutMs = DEFAULT_BOOTSTRAP_LIMITS.timeoutMs,
  onEvent = null,
  agentPreset = null,
}) {
  if (!parent) return { ok: false, code: 'E_NO_PARENT', error: '仓库文档整理必须在会话内调用。' }
  if (!subagents?.startActivation) return { ok: false, code: 'E_NO_SUBAGENTS', error: '宿主没有可用的子代理服务。' }
  const partitions = Array.isArray(plan?.partitions) ? plan.partitions : []
  if (partitions.length === 0) return { ok: false, code: 'E_PLAN_EMPTY', error: '没有可派的分区。' }

  const limit = Math.max(1, Math.min(Number(concurrency) || 1, partitions.length))
  const results = new Array(partitions.length)
  let cursor = 0
  let active = 0
  let maxActive = 0

  await new Promise(done => {
    const launch = () => {
      while (active < limit && cursor < partitions.length) {
        const index = cursor
        cursor += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        const partition = partitions[index]
        const controller = new AbortController()
        const startedAt = Date.now()
        ;(async () => {
          try {
            onEvent?.({ type: 'bootstrap-job-start', partition: partition.id, label: partition.label })
            const request = {
              parent,
              prompt: [{ type: 'text', text: partitionPrompt({ partition, stagingDir, targetDocsRoot }) }],
              cwd: resolve(String(workspace ?? '.')),
            }
            if (agentPreset) request.agentPreset = agentPreset
            const started = await subagents.startActivation({
              provider: 'spawn',
              label: `egm-bootstrap-${partition.id}`,
              request,
              delivery: 'caller',
              signal: controller.signal,
            })
            const raw = await awaitResult(started, timeoutMs)
            const text = textOf(raw)
            results[index] = {
              ok: true,
              partitionId: partition.id,
              label: partition.label,
              text,
              stagingDir,
              startedAt,
              endedAt: Date.now(),
            }
            onEvent?.({ type: 'bootstrap-job-done', partition: partition.id, ok: true })
          } catch (error) {
            results[index] = {
              ok: false,
              partitionId: partition.id,
              label: partition.label,
              code: error?.code === 'E_TIMEOUT' ? 'E_TIMEOUT' : 'E_BOOTSTRAP_JOB',
              error: error?.message ?? String(error),
              startedAt,
              endedAt: Date.now(),
            }
            onEvent?.({ type: 'bootstrap-job-done', partition: partition.id, ok: false, error: error?.message ?? String(error) })
          } finally {
            active -= 1
            if (cursor < partitions.length) launch()
            else if (active === 0) done()
          }
        })()
      }
      if (partitions.length === 0) done()
    }
    launch()
  })

  return {
    ok: true,
    results,
    maxActiveObserved: maxActive,
    requestedConcurrency: limit,
    notes: ['并发只是"同时开了几个子会话"，不保证宿主真的并行；失败的分区可以单独重试。'],
  }
}

/**
 * 校验分区产物：文件必须存在、非空、位于暂存目录内，索引必须是合法 JSON 且路径不越界。
 */
export function validateBootstrapOutput({ stagingDir, partitionId, workspace = '.' }) {
  const base = resolve(String(stagingDir ?? '.'))
  const docPath = join(base, String(partitionId), 'doc.md')
  const indexPath = join(base, String(partitionId), 'subtree_index.json')
  const problems = []
  let docText = ''
  try {
    docText = fs.readFileSync(docPath, 'utf8')
    if (docText.trim() === '') problems.push('文档是空的')
  } catch (error) {
    problems.push(`文档不存在或读不出来：${error?.message ?? String(error)}`)
  }
  let index = null
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  } catch (error) {
    problems.push(`索引不是合法 JSON：${error?.message ?? String(error)}`)
  }
  if (index) {
    if (!Array.isArray(index.docs)) problems.push('索引缺少 docs 数组')
    else {
      for (const item of index.docs) {
        const p = String(item?.path ?? '')
        if (!p) problems.push('索引里有空的 path')
        else if (p.startsWith('..') || isAbsolute(p)) problems.push(`索引路径越界：${p}`)
      }
    }
  }
  if (problems.length > 0) {
    return { ok: false, code: 'E_BOOTSTRAP_OUTPUT_INVALID', problems, docPath, indexPath }
  }
  return {
    ok: true,
    docPath,
    indexPath,
    docText,
    docSha256: sha256(docText),
    index,
    workspaceRelativeDoc: toPosix(relative(resolve(String(workspace ?? '.')), docPath)),
  }
}

/**
 * 落盘：目标已存在且内容不同 → 写候选副本、报冲突，不覆盖。
 * @param {{ workspace: string, stagingDir: string, partitionIds: string[], docsRoot?: string }} params
 */
export function commitBootstrap({ workspace, stagingDir, partitionIds, docsRoot = 'docs/designs' }) {
  const ws = resolve(String(workspace ?? '.'))
  const committed = []
  const skipped = []
  const conflicts = []
  const rejected = []
  for (const partitionId of partitionIds) {
    const checked = validateBootstrapOutput({ stagingDir, partitionId, workspace: ws })
    if (!checked.ok) {
      rejected.push({ partitionId, problems: checked.problems })
      continue
    }
    const index = checked.index
    const suggested = String(index?.docs?.[0]?.path ?? '').trim()
    const relDoc = suggested && !suggested.startsWith('..') && !isAbsolute(suggested)
      ? suggested
      : join(docsRoot, `${partitionId}.md`).split(sep).join('/')
    const targetRel = relDoc.startsWith(docsRoot) ? relDoc : join(docsRoot, basename(relDoc)).split(sep).join('/')
    const targetAbs = resolve(ws, targetRel)
    const targetRelative = relative(ws, targetAbs)
    if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
      rejected.push({ partitionId, problems: [`目标路径越界：${targetRel}`] })
      continue
    }
    const nextText = checked.docText
    let existing = null
    try {
      existing = fs.readFileSync(targetAbs, 'utf8')
    } catch {
      existing = null
    }
    try {
      fs.mkdirSync(dirname(targetAbs), { recursive: true })
    } catch (error) {
      rejected.push({ partitionId, problems: [`建目录失败：${error?.message ?? String(error)}`] })
      continue
    }
    if (existing === null) {
      fs.writeFileSync(targetAbs, nextText, 'utf8')
      committed.push({ partitionId, path: toPosix(targetRelative), created: true })
      continue
    }
    if (existing === nextText) {
      skipped.push({ partitionId, path: toPosix(targetRelative), reason: '内容一致，无需改动' })
      continue
    }
    const candidateRel = toPosix(targetRelative).replace(/\.md$/i, '') + '.egm-candidate.md'
    const candidateAbs = resolve(ws, candidateRel)
    try {
      fs.writeFileSync(candidateAbs, nextText, 'utf8')
    } catch (error) {
      rejected.push({ partitionId, problems: [`写候选副本失败：${error?.message ?? String(error)}`] })
      continue
    }
    conflicts.push({
      partitionId,
      path: toPosix(targetRelative),
      candidate: candidateRel,
      reason: '目标文件已存在且内容不同：没有覆盖，两份都保留，请你决定留哪一份。',
    })
  }
  return {
    ok: true,
    committed,
    skipped,
    conflicts,
    rejected,
    notes: ['冲突一律保留双方，没有自动合并或覆盖。'],
  }
}

/** 读/写 bootstrap 断点（按任务）。 */
export function bootstrapCheckpointPath(workspace, taskId) {
  return join(resolve(String(workspace ?? '.')), '.egm', 'tasks', String(taskId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_'), 'bootstrap.json')
}

export function readBootstrapCheckpoint({ workspace, taskId }) {
  const path = bootstrapCheckpointPath(workspace, taskId)
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    return { ok: true, checkpoint: parsed, path }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, checkpoint: null, path }
    return { ok: false, code: 'E_CHECKPOINT_UNREADABLE', error: `断点读不出来：${error?.message ?? String(error)}`, path }
  }
}

export function writeBootstrapCheckpoint({ workspace, taskId, checkpoint }) {
  const path = bootstrapCheckpointPath(workspace, taskId)
  try {
    fs.mkdirSync(dirname(path), { recursive: true })
    const payload = { schemaVersion: BOOTSTRAP_SCHEMA, taskId: taskId ?? null, updatedAt: Date.now(), ...checkpoint }
    fs.writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path, checkpoint: payload }
  } catch (error) {
    return { ok: false, code: 'E_CHECKPOINT_WRITE', error: `断点写入失败：${error?.message ?? String(error)}` }
  }
}

/** 只重试未完成的分区（已完成的保留，不重跑）。 */
export function pendingPartitions(plan, checkpoint) {
  const doneIds = new Set(Array.isArray(checkpoint?.completed) ? checkpoint.completed : [])
  return (plan?.partitions ?? []).filter(partition => !doneIds.has(partition.id))
}
