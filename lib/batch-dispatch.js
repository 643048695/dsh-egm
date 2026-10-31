// EGM 阶段内批量评审与独立汇总调度器。
//
// 核心原则：
// 1. 阶段内并行：一次 batch 严格属于同一个 stage，不得将多个 review 阶段混在同一批；阶段推进由技能层驱动。
// 2. 双门控与配额：绝不绕过 /egm-open 派发窗口与 /egm-unsafe 非隔离许可，首条启动前进行廉价字段与配额预检，
//    额度不足整批拒绝；每条金鱼仍单独调用 dispatchGoldfish 走完原授权与额度扣减。
// 3. 不可变设计快照：并行启动前为当前 docPath 生成唯一不可变快照，所有金鱼任务均基于此快照运行，
//    避免并行执行期间图纸被修改导致各角色读到不同修订版本。
// 4. 独立房间与 Raw Artifacts：每条金鱼在各自独立的临时房间内运行，原始报告各自分立落盘；
//    单鱼失败或超时不抹掉其他成功结果，manifest 诚实呈现 successful/failed/missing 及整体 partial 状态。
// 5. 独立汇总：所有金鱼评审达到 terminal 状态后，启动另一个 provider:'spawn' 的 fresh 子代理进行汇总去重，
//    保留分歧冲突与出处，突出缺失原报告；汇总代理不额外扣减金鱼配额，但必须在双门放行并有真实报告后执行。

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BRAINSTORM_ROLES,
  ROLE_IDS,
  STAGE_NAMES,
  STAGE_ROLES,
  VENDOR_ROOT,
  boundaryOf,
  dispatchGoldfish,
  peekGate,
  peekUnsafePermit,
  roleSpecOf,
  sessionIdOf,
} from './dispatch.js'
import { summarizeReviews } from './review-summarizer.js'
import { validateDesignDoc } from './review-materials.js'
import { readTaskRecordStatus } from './active-task.js'
import { recordReviewRun } from './review-runs.js'
import { createReviewRun, finishReviewRun, updateReviewRunJob } from './review-batch.js'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(LIB_DIR)

export const BATCH_TOOL_NAME = 'egm_dispatch_batch'
export const MAX_BATCH_TASKS = 6
export const DEFAULT_CONCURRENCY = 3
export const MAX_CONCURRENCY = 3
export const BATCH_TIMEOUT_MS = 240_000

const DEFAULT_IO = { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile }

/** 统一失败返回 */
function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra }
}

/** 阶段校验辅助函数 */
function normalizeStage(raw) {
  const value = String(raw ?? '').trim()
  if (!/^[5-9]$/.test(value)) return { error: `stage 只能是 5 / 6 / 7 / 8 / 9（收到「${value}」）` }
  return { stage: Number(value) }
}

/** 文件存在性校验 */
async function missingFile(path, io) {
  try {
    const info = await io.stat(path)
    return info.isFile() ? null : `${path} 不是普通文件`
  } catch {
    return `${path} 不存在`
  }
}

/**
 * 受控并发工作池：保持并发峰值不超过 limit，记录真实最高并发数。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} workerFn
 * @returns {Promise<{ results: R[], maxActiveObserved: number }>}
 */
async function runConcurrentPool(items, limit, workerFn) {
  const results = new Array(items.length)
  let nextIndex = 0
  let activeCount = 0
  let maxActiveObserved = 0

  return new Promise((resolve) => {
    if (items.length === 0) {
      return resolve({ results, maxActiveObserved: 0 })
    }
    const launch = () => {
      while (activeCount < limit && nextIndex < items.length) {
        const index = nextIndex++
        activeCount++
        if (activeCount > maxActiveObserved) {
          maxActiveObserved = activeCount
        }
        workerFn(items[index], index)
          .then((res) => {
            results[index] = res
          })
          .catch((err) => {
            results[index] = { ok: false, error: err?.message ?? String(err) }
          })
          .finally(() => {
            activeCount--
            if (nextIndex < items.length) {
              launch()
            } else if (activeCount === 0) {
              resolve({ results, maxActiveObserved })
            }
          })
      }
    }
    launch()
  })
}

/**
 * 阶段内批量派发核心：
 * 预检 -> 校验配额与双门 -> 生成共享设计快照 -> 并发执行每条金鱼 -> 汇总 -> 落盘。
 *
 * @param {object} options
 * @param {object} options.subagents - 子代理服务
 * @param {object} options.parent - 父会话 agent
 * @param {object} options.args - { docPath, tasks, stage?, mode?, concurrency? }
 * @param {string} [options.baseCwd] - 工作区根路径
 * @param {string} [options.vendorRoot] - vendor/egm 根路径
 * @param {string} [options.roomsRoot] - 临时房间根路径（默认 <baseCwd>/.egm）
 * @param {object} [options.io] - 文件操作实现
 * @param {number} [options.timeoutMs] - 单个任务超时毫秒数
 * @param {(type: string, data: object) => void} [options.onEvent] - 状态事件通知钩子
 * @returns {Promise<object>}
 */
export async function dispatchBatch(options = {}) {
  const {
    subagents,
    parent,
    args = {},
    baseCwd = process.cwd(),
    vendorRoot = VENDOR_ROOT,
    roomsRoot,
    io = DEFAULT_IO,
    timeoutMs = BATCH_TIMEOUT_MS,
    onEvent = null,
  } = options

  const effectiveVendorRoot = vendorRoot && existsSync(vendorRoot) ? vendorRoot : VENDOR_ROOT

  if (!parent) {
    return fail('E_NO_PARENT', 'egm_dispatch_batch 必须在会话内调用（需要父会话作为派活方）')
  }

  const docPath = String(args?.docPath ?? '').trim()
  if (docPath === '') {
    return fail('E_DOC_EMPTY', 'docPath 不能为空：金鱼只看文件，不收口头描述')
  }

  const tasks = args?.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return fail('E_TASKS_EMPTY', 'tasks 不能为空，且必须是任务对象数组')
  }
  if (tasks.length > MAX_BATCH_TASKS) {
    return fail('E_TASKS_OVER_LIMIT', `单次 batch 最多支持 ${MAX_BATCH_TASKS} 个任务（收到 ${tasks.length} 项）`)
  }

  const mode = String(args?.mode ?? 'review').trim().toLowerCase()
  if (mode !== 'review' && mode !== 'brainstorm') {
    return fail('E_MODE_UNSUPPORTED', `未知模式「${mode}」：只支持 mode=review 或 mode=brainstorm。`, {
      boundary: boundaryOf(),
    })
  }

  let stage = null
  const rawStage = args?.stage
  if (rawStage !== undefined && rawStage !== null && String(rawStage).trim() !== '') {
    if (mode === 'brainstorm') {
      return fail('E_STAGE_NOT_APPLICABLE', 'brainstorm 发生在 draft/review 之前，没有阶段绑定；请去掉 stage')
    }
    const normalized = normalizeStage(rawStage)
    if (normalized.error) return fail('E_STAGE_INVALID', normalized.error)
    stage = normalized.stage
  }

  // 逐项廉价检查角色、阶段映射与角色卡/标准文件存在性，并校验 goldfishId 唯一性
  const customIds = new Set()
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]
    if (!task || typeof task !== 'object') {
      return fail('E_TASK_INVALID', `tasks[${i}] 必须是合法的任务对象`)
    }
    if (task.goldfishId !== undefined && task.goldfishId !== null) {
      const gid = String(task.goldfishId).trim()
      if (gid === '') {
        return fail('E_TASK_INVALID', `tasks[${i}].goldfishId 不能为空字符串`)
      }
      if (customIds.has(gid)) {
        return fail('E_TASK_INVALID', `tasks 内自定义 goldfishId 重复：${gid}（金鱼 ID 必须唯一）`)
      }
      customIds.add(gid)
    }
    const role = String(task.role ?? '').trim()
    if (!role) {
      return fail('E_TASK_INVALID', `tasks[${i}] 缺少必需的 role 字段`)
    }
    const spec = roleSpecOf(role, effectiveVendorRoot)
    if (!spec) {
      return fail('E_UNKNOWN_ROLE', `未知角色「${role}」。白名单：${ROLE_IDS.join(' / ')}`)
    }
    if (mode === 'brainstorm' && !BRAINSTORM_ROLES.includes(role)) {
      return fail(
        'E_MODE_ROLE_MISMATCH',
        `brainstorm 只允许这 6 个视角：${BRAINSTORM_ROLES.join(' / ')}；tasks[${i}] 收到 ${role}。`,
        { boundary: boundaryOf() },
      )
    }
    if (stage !== null) {
      if (spec.kind === 'legacy') {
        return fail('E_STAGE_NOT_APPLICABLE', `阶段绑定只适用于上游 7 角色；tasks[${i}] 角色「${role}」是兼容角色，请去掉 stage`)
      }
      if (!spec.stages.includes(stage)) {
        return fail(
          'E_STAGE_ROLE_MISMATCH',
          `阶段 ${stage}（${STAGE_NAMES[stage]}）只接受角色：${STAGE_ROLES[stage].join(' / ')}；tasks[${i}] 收到 ${role}`,
        )
      }
    }

    const cardProblem = await missingFile(spec.cardPath, io)
    if (cardProblem) {
      return fail('E_ROLE_CARD_MISSING', `角色卡缺失：${cardProblem}`)
    }

    const needsStandard = mode === 'review' && spec.standardPath !== null
    if (needsStandard) {
      const standardProblem = await missingFile(spec.standardPath, io)
      if (standardProblem) {
        return fail('E_STANDARD_MISSING', `标准文件缺失：${standardProblem}（角色 ${role} 的固定标准不可替换）`)
      }
    }

    if (task.range !== undefined && task.range !== null) {
      if (mode === 'brainstorm') {
        return fail('E_RANGE_NOT_APPLICABLE', `brainstorm 评估概念，不做行区间审核；tasks[${i}] 请去掉 range`)
      }
      const { start, end } = task.range
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return fail('E_RANGE_INVALID', `tasks[${i}].range 必须是包含整数 start 与 end 的对象`)
      }
      if (start < 1 || end < start) {
        return fail('E_RANGE_INVALID', `tasks[${i}].range 非法区间：start=${start}, end=${end}（要求 1 ≤ start ≤ end）`)
      }
    }
  }

  if (!subagents?.startActivation) {
    return fail('E_SUBAGENTS_UNAVAILABLE', '这台机器上派不出零上下文评审（子代理服务不可用）。按铁律：不许在同上下文里假装评审。')
  }

  // 首条启动前核对命令门控与剩余额度；额度不足整批拒绝
  const gate = peekGate(parent)
  if (!gate) {
    return fail(
      'E_GATE_NOT_OPEN',
      '未通过 /egm 启动：egm_dispatch_batch 只能在已打开的会话窗口内使用。请让用户输入 /egm-open（只开窗，不启动任何流程），或输入 /egm <需求>（会同时启动 egm-gate 快速流程）后再派发。',
      { boundary: boundaryOf() },
    )
  }
  if (gate.remaining < tasks.length) {
    return fail(
      'E_GATE_INSUFFICIENT',
      `派发窗口剩余次数不足以执行整批任务：整批需要 ${tasks.length} 次，当前仅剩 ${gate.remaining} 次。请让用户重新输入 /egm-open 刷新窗口。`,
      { boundary: boundaryOf(), remaining: gate.remaining, required: tasks.length },
    )
  }

  // 首条启动前核对非隔离许可与剩余额度；额度不足整批拒绝
  const permit = peekUnsafePermit(parent)
  if (!permit) {
    return fail(
      'E_READONLY_UNVERIFIED',
      '默认拒绝：无法证实子代理只读（平台外层工具可能无法排除、子会话继承父权限根），本工具不声称隔离成立。如用户明确接受非隔离评审，请让用户亲自输入 /egm-unsafe 确认无隔离（10 分钟内最多 6 次），再重试；结果会被标注为非严格评审。',
      { boundary: boundaryOf() },
    )
  }
  if (permit.remaining < tasks.length) {
    return fail(
      'E_PERMIT_INSUFFICIENT',
      `非隔离评审许可剩余次数不足以执行整批任务：整批需要 ${tasks.length} 次，当前仅剩 ${permit.remaining} 次。请让用户重新输入 /egm-unsafe 确认无隔离。`,
      { boundary: boundaryOf(), remaining: permit.remaining, required: tasks.length },
    )
  }

  // 原始设计图纸前置安全校验（防止工作区外路径洗入、大小超限等）
  const safeIo = { ...DEFAULT_IO, ...io }
  const docValidation = await validateDesignDoc({ docPath, baseCwd, io: safeIo })
  if (!docValidation.ok) {
    return fail(docValidation.code, docValidation.error, { boundary: boundaryOf() })
  }

  // 生成不可变设计快照：所有角色使用同一快照，杜绝并行执行中读到不同修订
  const rooms = roomsRoot ?? join(baseCwd, '.egm')
  let snapshotDir
  let snapshotDocPath
  let snapshotSha256
  try {
    await safeIo.mkdir(rooms, { recursive: true })
    snapshotDir = await safeIo.mkdtemp(join(rooms, 'batch-snapshot-'))
    snapshotDocPath = join(snapshotDir, 'design.md')
    await safeIo.copyFile(docValidation.realPath, snapshotDocPath)
    const content = await safeIo.readFile(snapshotDocPath)
    snapshotSha256 = createHash('sha256').update(content).digest('hex')
  } catch (error) {
    return fail('E_ROOM_PREPARE', `创建设计快照失败：${error?.message ?? String(error)}`)
  }

  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Number.isInteger(args?.concurrency) ? args.concurrency : DEFAULT_CONCURRENCY),
  )

  // 评审批次记录：同一批的角色共享同一份快照与哈希；作业状态逐个更新。
  // 进程重启后这些 running 记录会被 reconcileReviewRuns 标成未知，不会自动重派。
  let runId = null
  try {
    const sessionId = sessionIdOf(parent)
    const record = readTaskRecordStatus(sessionId, { includeArchived: true })
    const activeTask = record?.state === 'ok' ? record.task : null
    let docText = null
    try {
      docText = await safeIo.readFile(snapshotDocPath, 'utf8')
    } catch {
      docText = null
    }
    const originalDoc = docPath.trim() !== ''
      ? (isAbsolute(docPath) ? docPath : resolve(baseCwd, docPath))
      : (activeTask?.docPath ?? snapshotDocPath)
    const created = createReviewRun({
      workspace: baseCwd,
      sessionId,
      taskId: activeTask?.id ?? null,
      stage: stage ?? null,
      mode,
      docPath: originalDoc,
      docText,
      configHash: null, // 配置哈希在每个 dispatchGoldfish 内部才解析，此处无法预知
      materialManifestHash: null, // manifest 在每个 dispatchGoldfish 内部收集
      roles: tasks.map(item => String(item.role).trim()),
    })
    if (created?.ok) runId = created.run.runId
  } catch {
    runId = null
  }

  // 并发池执行：每条任务仍调用 dispatchGoldfish 扣减原授权与额度
  const { results, maxActiveObserved } = await runConcurrentPool(tasks, concurrency, async (task, index) => {
    const role = String(task.role).trim()
    const goldfishId =
      typeof task.goldfishId === 'string' && task.goldfishId.trim() !== ''
        ? task.goldfishId.trim()
        : `gf-${role}-${Date.now()}-${randomUUID().slice(0, 6)}`

    let taskDidStart = false
    const taskStartedAt = Date.now()

    const taskResult = await dispatchGoldfish({
      subagents,
      parent,
      args: {
        docPath: snapshotDocPath,
        role,
        stage,
        mode,
        range: task.range,
        sources: task.sources,
        materials: task.materials,
        goldfishId,
      },
      baseCwd,
      vendorRoot: effectiveVendorRoot,
      roomsRoot,
      io,
      timeoutMs,
      goldfishId,
      onStart: (startEvent) => {
        taskDidStart = true
        onEvent?.('dispatch-start', {
          ...startEvent,
          id: goldfishId,
          docPath, // 上报给顶栏宠物的路径保持原 docPath
          role,
          stage,
          mode,
        })
      },
    })

    // 评审台账：按原始 docPath 记录（快照内容与原始图纸一致，sha256 相同），
    // 这样 /egm-action proceed 的图纸核对能对上同一份内容。
    try {
      const sessionId = sessionIdOf(parent)
      const record = readTaskRecordStatus(sessionId, { includeArchived: true })
      const activeTask = record?.state === 'ok' ? record.task : null
      const rawDoc = docPath.trim() !== '' ? docPath : activeTask?.docPath
      const reviewDoc = rawDoc ? (isAbsolute(rawDoc) ? rawDoc : resolve(baseCwd, rawDoc)) : null
      if (sessionId && reviewDoc) {
        recordReviewRun({
          workspace: baseCwd,
          sessionId,
          taskId: activeTask?.id ?? null,
          docPath: reviewDoc,
          role,
          stage: stage ?? null,
          ok: taskResult?.ok === true,
          reportPath: taskResult?.reportPath ?? null,
          startedAt: taskStartedAt,
          endedAt: Date.now(),
        })
      }
    } catch {
      // 台账故障不影响批量结果。
    }

    if (runId) {
      try {
        updateReviewRunJob({
          workspace: baseCwd,
          runId,
          role,
          status: taskResult?.ok === true ? 'completed' : 'failed',
          reportPath: taskResult?.reportPath ?? null,
          error: taskResult?.ok === true ? null : (taskResult?.error ?? taskResult?.code ?? 'dispatch failed'),
        })
      } catch {
        // 记录失败只影响"能不能看到状态"，不影响评审结果。
      }
    }

    if (taskResult?.ok === true) {
      onEvent?.('dispatch-done', {
        id: taskResult.goldfishId ?? goldfishId,
        role,
        stage,
        mode,
        reportPath: taskResult.reportPath,
        report: taskResult.report,
        finishedAt: Date.now(),
      })
    } else {
      onEvent?.('dispatch-failed', {
        id: taskResult?.goldfishId ?? goldfishId,
        role,
        stage,
        mode,
        didStart: taskDidStart,
        error: taskResult?.error ?? taskResult?.message ?? taskResult?.code ?? 'dispatch failed',
        code: taskResult?.code,
        failedAt: Date.now(),
      })
    }

    return {
      ...taskResult,
      taskIndex: index,
      requestedRole: role,
      docPath,
      snapshotPath: snapshotDocPath,
    }
  })

  // 整理结果清单
  const successful = []
  const failed = []
  const missing = []

  for (let i = 0; i < results.length; i += 1) {
    const res = results[i]
    const role = tasks[i].role
    const taskRange = tasks[i].range ?? res?.range ?? null
    if (res?.ok === true && typeof res.report === 'string' && res.report.trim() !== '') {
      successful.push({
        role,
        label: res.label,
        goldfishId: res.goldfishId,
        report: res.report,
        reportPath: res.reportPath,
        scratch: res.scratch,
        standard: res.standard,
        sources: res.sources,
        materials: res.materials,
        range: taskRange,
      })
    } else if (res?.ok === false) {
      failed.push({
        role,
        code: res.code ?? 'E_TASK_FAILED',
        error: res.error ?? '任务执行失败',
        scratch: res.scratch,
        range: taskRange,
      })
    } else {
      missing.push({
        role,
        reason: '报告为空或未落盘',
        range: taskRange,
      })
    }
  }

  const allPassed = successful.length === tasks.length && failed.length === 0 && missing.length === 0
  const partial = !allPassed && successful.length > 0

  const manifest = {
    total: tasks.length,
    successfulCount: successful.length,
    failedCount: failed.length,
    missingCount: missing.length,
    partial,
    allPassed,
    concurrencyPeak: maxActiveObserved,
  }

  // 独立汇总：等待所有评审 terminal 后启动，且必须有真实成功报告
  let summaryResult = null
  if (successful.length > 0) {
    summaryResult = await summarizeReviews({
      subagents,
      parent,
      docPath,
      stage,
      mode,
      successful,
      failed,
      missing,
      summaryDir: snapshotDir,
      io,
      timeoutMs,
    })
  } else {
    summaryResult = {
      summary: null,
      summaryPath: null,
      summaryFailed: false,
      skipped: true,
      reason: '未获得任何成功的评审报告，跳过独立汇总',
    }
  }

  // 收尾批次记录：汇总成功/失败/缺报告都写进去；状态不明就留在 running，交给重启后的核对。
  if (runId) {
    try {
      finishReviewRun({ workspace: baseCwd, runId, summaryPath: summaryResult?.summaryPath ?? null })
    } catch {
      // 同上：只影响可见状态。
    }
  }

  return {
    ok: true,
    batchId: `batch-${Date.now()}-${randomUUID().slice(0, 6)}`,
    runId,
    docPath,
    stage,
    mode,
    concurrency,
    concurrencyPeak: maxActiveObserved,
    snapshot: { path: snapshotDocPath, sha256: snapshotSha256 },
    manifest,
    tasks: results,
    successful,
    failed,
    missing,
    summary: summaryResult?.summary ?? null,
    summaryPath: summaryResult?.summaryPath ?? null,
    summaryFailed: summaryResult?.summaryFailed ?? false,
    summaryError: summaryResult?.summaryError ?? null,
    summarySkipped: summaryResult?.skipped ?? false,
    summaryReason: summaryResult?.reason ?? null,
    reviewClass: 'unsafe-nonisolated',
    strictGoldfishReview: false,
    boundary: boundaryOf(),
  }
}

/**
 * 注册 egm_dispatch_batch 工具。
 *
 * @param {object} ctx - 包含 tools/subagents 服务的上下文
 * @param {object} [hooks] - 事件钩子 { onEvent }
 */
export function registerBatchDispatchTool(ctx, hooks = {}) {
  ctx.tools.register({
    name: BATCH_TOOL_NAME,
    description: [
      'EGM 阶段内批量评审与独立汇总：在同一会话内接受同一 docPath 的 tasks 数组（每项指定 role 及可选 range/sources/materials），',
      '共用 stage/mode，按受限并发并行派发金鱼评审。所有角色共享不可变设计快照与独立房间。',
      '在所有评审 terminal 后，启动独立 fresh 汇总子代理完成去重、分歧保留与缺失突出并落盘。',
      '同样受 /egm-open 窗口与 /egm-unsafe 非隔离许可双门控，额度按任务数预检并每鱼扣减；不宣称安全隔离。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        docPath: { type: 'string', description: '要审的设计文档路径（通常是 .egm/ 下的图纸）' },
        stage: {
          type: 'string',
          enum: ['5', '6', '7', '8', '9'],
          description: '可选：上游评审阶段（5..9），整批任务共用',
        },
        mode: {
          type: 'string',
          enum: ['review', 'brainstorm'],
          description: '可选：评审模式，默认 review；brainstorm 走概念视角',
        },
        concurrency: {
          type: 'integer',
          description: '可选：并发上限，建议上限 3，默认 3，最大 3',
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ROLE_IDS,
                description: '金鱼角色',
              },
              range: {
                type: 'object',
                properties: {
                  start: { type: 'integer', description: '起始行号（1 起，含）' },
                  end: { type: 'integer', description: '结束行号（含）' },
                },
                required: ['start', 'end'],
                description: '可选：该角色的行号范围',
              },
              sources: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：该角色关注的源码路径列表',
              },
              materials: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：该角色的阶段材料文件路径列表',
              },
            },
            required: ['role'],
            additionalProperties: false,
          },
          description: '要并行派发的任务列表（最多 6 项）',
        },
      },
      required: ['docPath', 'tasks'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => {
        if (value?.ok === false) {
          const code = value?.code ? `（${value.code}）` : ''
          return [{ type: 'text', text: `EGM 批量派发失败${code}：${value?.error ?? '未知错误'}` }]
        }
        const banner =
          value?.strictGoldfishReview === false
            ? '⚠️ 非隔离评审（用户已显式许可，10 分钟内有效）：只读未经验证，不得当作严格金鱼评审。\n\n'
            : ''
        const lines = [banner]

        if (value?.summaryFailed) {
          lines.push(`⚠️ 独立汇总生成失败：${value.summaryError || '未知错误'}\n各角色原始报告仍已落盘保存：\n`)
        } else if (value?.summary) {
          lines.push('### 📋 EGM 阶段内多角色评审独立汇总\n\n')
          lines.push(value.summary)
          if (value?.summaryPath) {
            lines.push(`\n\n（汇总落盘：${value.summaryPath}）\n`)
          }
        } else if (value?.summarySkipped) {
          lines.push(`（未执行独立汇总：${value.summaryReason || '无可用报告'}）\n\n`)
        }

        const m = value?.manifest
        if (m) {
          lines.push('\n### 🔍 批量评审执行清单\n')
          lines.push(`- 任务总数: ${m.total} | 成功: ${m.successfulCount} | 失败: ${m.failedCount} | 缺失: ${m.missingCount}`)
          lines.push(`- 最终状态: ${m.allPassed ? '✅ 全部报告完成（仍需阅读发现并裁决）' : '⚠️ 部分报告完成 (partial)'}`)
          if (m.concurrencyPeak) {
            lines.push(`- 并发峰值: ${m.concurrencyPeak}`)
          }
          if (value?.snapshot?.path) {
            lines.push(`- 共享快照: ${value.snapshot.path} (sha256: ${value.snapshot.sha256?.slice(0, 12)}...)`)
          }
          lines.push('\n**各角色明细：**')
          for (const item of value.tasks || []) {
            const role = item.requestedRole || item.role || 'unknown'
            if (item.ok) {
              lines.push(`- [${role}] ✅ 完成 | 报告: ${item.reportPath || '内存'}`)
            } else {
              lines.push(`- [${role}] ❌ 失败: ${item.error || item.code || '未知错误'}`)
            }
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const parent = exec?.agent
      if (!parent) return fail('E_NO_PARENT', 'egm_dispatch_batch 必须在会话内调用（需要父会话作为派活方）')
      const sessionId = sessionIdOf(parent)

      return await dispatchBatch({
        subagents: ctx.get?.('subagents'),
        parent,
        args,
        baseCwd: parent?.session?.header?.cwd ?? parent?.cwd ?? process.cwd(),
        onEvent: (type, data) => {
          try {
            hooks.onEvent?.({
              type,
              sessionId,
              ...data,
            })
          } catch {
            // 宠物不影响派发
          }
        },
      })
    },
  })
}
