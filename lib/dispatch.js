// EGM 的两个入口：/egm 命令（人工入口）与 egm_dispatch 工具（派金鱼通道）。
//
// 插件层能强制的只有「派发」这一步：
//   命令门控 —— egm_dispatch 需要 /egm 打开的会话内派发窗口（用户命令才能开）；
//   只读门控 —— 默认 fail-closed，另需用户亲自 /egm-unsafe 的短时许可；
//   喂料锁 —— 参数只有路径、阶段、白名单角色，没有能塞对话正文的格子；
//   房间锁 —— 每次派活用 mkdtemp 建一次性目录，图纸/角色卡/标准各拷一份进去，
//             子会话 cwd 指向它；并发派活不会撞名。
//
// 这不是「全流程硬锁」：技能虽不提供模型自动调用入口，模型仍可能直接读取规程、
// 自己出图纸、自己走流程；本插件也无法阻止模型干脆不做评审直接写代码。能保证的
// 只是「egm_dispatch 这一步」不会在用户没开窗、没许可的情况下被模型单独启动。
// 别再写成「/egm 是唯一入口，模型无法自己进流程」。
//
// 2026-10-28 扩展：在原有三种兼容角色（logic / feasibility / cold）之外，
// 接入上游 EGM 的 7 个评审角色，并把「角色 → 标准」固定映射写死在这里。
// 角色卡与标准全部来自包内 vendor/egm/；缺文件就返回明确错误，绝不静默降级。
//
// 只读边界与默认 fail-closed（重要）：
//   preset 只装配读取/搜索工具，但宿主仍可能注入注册表之外的工具。0.3.1 的
//   goldfish-policy.js 会在自身金鱼首条 prompt 前追加并校验子会话 read-only 策略；
//   此策略只保护遵守 sandboxPolicy 的文件效果，Windows 实机拒写和完整外部工具
//   隔离尚未验证。因此本工具仍默认**拒绝派发**，返回
//   E_READONLY_UNVERIFIED；只有用户本人在会话里敲 `/egm-unsafe 确认无隔离`
//   （命令不产生模型消息，模型无法铸许可），才在 10 分钟 / 最多 6 次的短时许可
//   下运行，且每次结果都标注 strictGoldfishReview:false，不得当作严格金鱼评审。
//
//   参数只收路径也不等于零泄漏：文档与源码本身可能包含父对话或恶意指令，
//   本工具不做内容审查。哪些做到了、哪些没做到，一律写进 boundary.uncovered。
//
// 刻意不 import 任何 @deepseek-ai 包：工具定义手写，避开宿主加载器的解析差异。
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GOLDFISH_ID } from './goldfish.js'
import {
  countLines,
  prepareDesignDoc,
  prepareMaterials,
  prepareSources,
  validateDesignDoc,
  validateMaterials,
  validateSources,
} from './review-materials.js'
import { assertSkillResources, skillResourceInstructions } from './skill-resources.js'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(LIB_DIR)

/** 上游 EGM 资源在包内的根目录（由资源侧落入，dispatch 只读）。 */
export const VENDOR_ROOT = join(PKG_ROOT, 'vendor', 'egm')

const DISPATCH_TIMEOUT_MS = 240_000
const MAX_SOURCES = 50
const MAX_MATERIALS = 10
const MAX_MATERIAL_BYTES = 2 * 1024 * 1024
const HASH_LIMIT_BYTES = 2 * 1024 * 1024

import {
  UNSAFE_PERMIT_TTL_MS,
  UNSAFE_PERMIT_USES,
  GATE_TTL_MS,
  GATE_MAX_DISPATCHES,
  CONFIRMATION_PHRASE,
  sessionIdOf,
  grantUnsafePermit,
  revokeUnsafePermit,
  peekUnsafePermit,
  takeUnsafePermit,
  openGate,
  closeGate,
  peekGate,
  takeGate,
  grantReviewAccess,
  revokeReviewAccess,
  getReviewAccessSnapshot,
  getActiveAgent,
  registerActiveAgent,
} from './review-access.js'

import {
  TASK_ACTIONS,
  TASK_PHASES,
  TASK_STATUSES,
  archiveActiveTask,
  createActiveTask,
  listArchivedTasks,
  readActiveTaskForSession,
  readArchivedTask,
  readTaskRecordStatus,
  restoreArchivedTask,
  safeSessionId,
  updateActiveTask,
  workspaceOf,
  writeActiveTask,
} from './active-task.js'
import {
  createOrReuseOp,
  updateOp,
  findInFlightOp,
} from './action-log.js'
import {
  checkReviewFreshness,
  docSha256Of,
  recordReviewRun,
} from './review-runs.js'
import {
  listWorkflows,
  parseWorkflowPrefix,
  resolveWorkflow,
  workflowKickoffBrief,
  workflowProcedureText,
} from './workflow-catalog.js'
import { describeReviewConfig, loadReviewConfig, resolveReviewProfile } from './review-config.js'
import { collectMaterials, needsCollection } from './materials-collector.js'
import {
  createReviewRun,
  describeReviewRun,
  finishReviewRun,
  listReviewRuns,
  planReviewRetry,
  readReviewRun,
  reconcileReviewRuns,
  resolveSectionRange,
  updateReviewRunJob,
} from './review-batch.js'
import { analyzeReviewImpact, staleReviewRuns } from './incremental-review.js'
import { exportHandoff, importHandoff } from './handoff.js'
import {
  commitBootstrap,
  dispatchBootstrapWorkers,
  pendingPartitions,
  planBootstrap,
  readBootstrapCheckpoint,
  validateBootstrapOutput,
  writeBootstrapCheckpoint,
} from './bootstrap.js'
import {
  ARTIFACT_KINDS,
  SEVERITIES,
  listFindings,
  readLedger,
  setFindingDisposition,
  setFindingVerification,
  summarizeLedger,
  upsertArtifact,
  upsertFinding,
} from './ledger.js'

export {
  UNSAFE_PERMIT_TTL_MS,
  UNSAFE_PERMIT_USES,
  GATE_TTL_MS,
  GATE_MAX_DISPATCHES,
  CONFIRMATION_PHRASE,
  sessionIdOf,
  grantUnsafePermit,
  revokeUnsafePermit,
  peekUnsafePermit,
  takeUnsafePermit,
  openGate,
  closeGate,
  peekGate,
  takeGate,
  grantReviewAccess,
  revokeReviewAccess,
  getReviewAccessSnapshot,
  getActiveAgent,
  registerActiveAgent,
  TASK_ACTIONS,
  TASK_PHASES,
  TASK_STATUSES,
  archiveActiveTask,
  createActiveTask,
  listArchivedTasks,
  readActiveTaskForSession,
  readArchivedTask,
  restoreArchivedTask,
  safeSessionId,
  updateActiveTask,
  workspaceOf,
  writeActiveTask,
  checkReviewFreshness,
  docSha256Of,
  recordReviewRun,
  describeReviewConfig,
  loadReviewConfig,
  resolveReviewProfile,
  analyzeReviewImpact,
  staleReviewRuns,
  readLedger,
  commitBootstrap,
  dispatchBootstrapWorkers,
  pendingPartitions,
  planBootstrap,
  readBootstrapCheckpoint,
  validateBootstrapOutput,
  writeBootstrapCheckpoint,
  ARTIFACT_KINDS,
  SEVERITIES,
  listFindings,
  setFindingDisposition,
  setFindingVerification,
  summarizeLedger,
  upsertArtifact,
  upsertFinding,
  createReviewRun,
  describeReviewRun,
  finishReviewRun,
  listReviewRuns,
  planReviewRetry,
  readReviewRun,
  reconcileReviewRuns,
  resolveSectionRange,
  updateReviewRunJob,
  collectMaterials,
  needsCollection,
  exportHandoff,
  importHandoff,
}

/** 原有三种兼容角色（沿用本包 agents/ 与 resources/defect-schema.md）。 */
export const LEGACY_ROLE_IDS = ['logic', 'feasibility', 'cold']

/** 上游 EGM 的 7 个评审角色（短名与上游 agents/ 文件名一致）。 */
export const EGM_REVIEW_ROLE_IDS = [
  'design_critic',
  'structural',
  'style',
  'zoom_out',
  'comprehension',
  'implementation_readiness',
  'codebase_details',
]

/** 全部合法角色 id（工具 schema 的 enum 就取这个）。 */
export const ROLE_IDS = [...LEGACY_ROLE_IDS, ...EGM_REVIEW_ROLE_IDS]

/** 上游 5 个评审阶段的名称（用于错误信息与结果）。 */
export const STAGE_NAMES = {
  5: '初始 Zoom Out',
  6: '复述测试（Comprehension）',
  7: '敌意评审（Critic）',
  8: '中期 Zoom Out',
  9: '实现就绪测试（Implementation Readiness）',
}

/** 阶段 → 允许的角色（按上游 egm_review / egm_review_loop 的编排）。 */
export const STAGE_ROLES = {
  5: ['zoom_out'],
  6: ['comprehension'],
  7: ['design_critic', 'structural', 'style'],
  8: ['zoom_out'],
  9: ['implementation_readiness', 'codebase_details', 'style'],
}

/**
 * brainstorm 模式允许的 6 个视角（上游 egm_brainstorm 的 Reviewer 列表）。
 * 上游是 synthesizer 并行派这 6 条；本插件一次只派一条，六视角由调用方逐个派发。
 */
export const BRAINSTORM_ROLES = [
  'design_critic',
  'codebase_details',
  'zoom_out',
  'comprehension',
  'implementation_readiness',
  'structural',
]

/**
 * 兼容角色的固定文件。
 * standard 是缺陷清单格式（原来就叫 defect-schema），不是上游标准。
 */
const LEGACY_ROLES = {
  logic: { card: 'agents/logic-critic.md', standard: 'resources/defect-schema.md', label: '逻辑与边界' },
  feasibility: { card: 'agents/feasibility-critic.md', standard: 'resources/defect-schema.md', label: '可行性与依赖' },
  cold: { card: 'agents/cold-implementer.md', standard: 'resources/defect-schema.md', label: '零背景实现者复述' },
}

/**
 * 上游 7 角色的「角色卡 → 固定标准」映射。
 * 这张表是唯一事实来源：调用方不能换标准，也不能按 phase 传自定义标准。
 * style 在上游编排里不绑定独立标准（见 egm_review Step 9 的 standards 映射），
 * 所以 standard 为 null，只按角色卡执行。
 */
const EGM_ROLES = {
  design_critic: {
    card: 'agents/design_critic.md',
    standard: 'resources/document_standards/feature-spec-standard.md',
    stages: [7],
    label: '敌意设计评审（架构/扩展性/成本）',
  },
  structural: {
    card: 'agents/structural.md',
    standard: 'resources/document_standards/feature-spec-standard.md',
    stages: [7],
    label: '结构与模板合规',
  },
  style: {
    card: 'agents/style.md',
    standard: null,
    stages: [7, 9],
    label: '文风与表达（技术文案编辑）',
  },
  zoom_out: {
    card: 'agents/zoom_out.md',
    standard: 'resources/document_standards/zoom-out-standard.md',
    stages: [5, 8],
    label: '高空视角（根问题/简洁/YAGNI）',
  },
  comprehension: {
    card: 'agents/comprehension.md',
    standard: 'resources/document_standards/re-implementation-standard.md',
    stages: [6],
    label: '零背景复述测试',
  },
  implementation_readiness: {
    card: 'agents/implementation_readiness.md',
    standard: 'resources/document_standards/implementation-readiness-standard.md',
    stages: [9],
    label: '实现就绪（零决策）',
  },
  codebase_details: {
    card: 'agents/codebase_details.md',
    standard: 'resources/document_standards/implementation-readiness-standard.md',
    stages: [9],
    label: '代码事实与复用审计',
  },
}

/** 默认文件实现（测试可整体替换，避免碰真实文件系统）。 */
const DEFAULT_IO = { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile }

// 门禁与许可的核心弱引用表及操作函数已迁移至 ./review-access.js 并统一导出。

/**
 * 解析角色元数据。
 * @param role - 角色 id。
 * @param vendorRoot - vendor/egm 根目录（测试可指向临时目录）。
 * @returns 角色元数据；未知角色返回 null。
 */
export function roleSpecOf(role, vendorRoot = VENDOR_ROOT) {
  if (Object.hasOwn(LEGACY_ROLES, role)) {
    const spec = LEGACY_ROLES[role]
    return {
      role,
      kind: 'legacy',
      label: spec.label,
      cardPath: join(PKG_ROOT, spec.card),
      standardPath: join(PKG_ROOT, spec.standard),
      stages: [],
    }
  }
  if (!Object.hasOwn(EGM_ROLES, role)) return null
  const spec = EGM_ROLES[role]
  return {
    role,
    kind: 'egm',
    label: spec.label,
    cardPath: join(vendorRoot, spec.card),
    standardPath: spec.standard === null ? null : join(vendorRoot, spec.standard),
    stages: [...spec.stages],
  }
}

/** 把角色卡与标准的相对路径暴露出去（技能侧写文档时可直接引用）。 */
export function roleCatalog(vendorRoot = VENDOR_ROOT) {
  return ROLE_IDS.map((role) => {
    const spec = roleSpecOf(role, vendorRoot)
    return {
      role,
      kind: spec.kind,
      label: spec.label,
      stages: spec.stages,
      card: relative(spec.kind === 'egm' ? vendorRoot : PKG_ROOT, spec.cardPath).split('\\').join('/'),
      standard:
        spec.standardPath === null
          ? null
          : relative(spec.kind === 'egm' ? vendorRoot : PKG_ROOT, spec.standardPath).split('\\').join('/'),
    }
  })
}

/**
 * 项目级评审配置摘要（面板/命令用）。角色白名单以本模块为唯一事实来源，
 * 所以这里注入 ROLE_IDS，避免 review-config 反向 import dispatch。
 */
/** 面板摘要缓存：只影响展示，派发时永远现读配置。 */
const CONFIG_SUMMARY_CACHE = new Map()
const CONFIG_SUMMARY_TTL_MS = 3000

export function describeReviewConfigFor(workspace) {
  const key = String(workspace || '')
  // 面板每 1.2 秒轮询一次状态；配置是慢变量，3 秒内复用上一次结果，避免每轮读盘。
  const now = Date.now()
  const cached = CONFIG_SUMMARY_CACHE.get(key)
  if (cached && now - cached.at < CONFIG_SUMMARY_TTL_MS) return cached.summary
  const summary = describeReviewConfig({ workspace: key, roleIds: ROLE_IDS })
  if (CONFIG_SUMMARY_CACHE.size > 32) CONFIG_SUMMARY_CACHE.clear()
  CONFIG_SUMMARY_CACHE.set(key, { at: now, summary })
  return summary
}

/** 读一份命名配置并解析（命令与派发共用；不传 profileId 时用 config 里的 defaultProfile）。 */
export function resolveReviewProfileFor(workspace, profileId) {
  return resolveReviewProfile({ workspace: String(workspace || ''), roleIds: ROLE_IDS, profileId: profileId || null })
}

/** 把子代理的返回统一成纯文本（平台返回形状有几种，全部归一化）。 */
function textOf(result) {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map(textOf).filter(Boolean).join('\n')
  if (typeof result === 'object') {
    if (result.ok === false || (result.error && !result.output && !result.text && !result.content && !result.message)) {
      const err = new Error(result.error ? `子代理返回失败：${result.error}` : '子代理返回失败')
      err.code = result.code ?? 'E_DISPATCH'
      throw err
    }
    for (const key of ['output', 'text', 'content', 'message']) {
      if (result[key] !== undefined) return textOf(result[key])
    }
    if (Object.keys(result).length === 0) return ''
    return JSON.stringify(result).slice(0, 4000)
  }
  return String(result)
}

/** 读会话工作目录：子代理的相对路径都从它出发。 */
function sessionCwdOf(agent) {
  return agent?.session?.header?.cwd ?? agent?.cwd ?? process.cwd()
}

/** 带超时地等结果；超时抛出带 code 的错误，调用方据此返回 E_TIMEOUT。 */
async function awaitResult(started, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      started.result,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`金鱼 ${Math.round(timeoutMs / 1000)} 秒没交卷，已收工`)
          error.code = 'E_TIMEOUT'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 统一的失败返回。 */
function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra }
}

/**
 * 边界披露：这是给调用方和用户看的「哪些做到了、哪些没做到」。
 * 任何时候都不要把这里说成沙箱，也不要用环境变量或 cwd 推断权限成功。
 */
export function boundaryOf() {
  return {
    isolation: 'unverified',
    readOnlyVerified: false,
    strictReviewAvailable: false,
    statement:
      '这不是安全隔离，只读未经验证。预设只装配读取与搜索工具，但平台最外层注入的工具可能无法排除，子会话继承父会话的权限根。',
    enforced: [
      '默认 fail-closed：没有用户显式许可就拒绝派发',
      '零上下文：spawn 后端，子会话不携带父对话',
      '喂料：参数只收路径，角色与标准都是白名单固定映射',
      '一次性房间：.egm/ 下 mkdtemp 唯一目录，房内文件可控',
      '受控材料副本：无 range 时全文复制，传 range 时裁剪指定行并标记原行号，sources 显式拒目录并拷入房间副本',
      '报告：写盘后回读字节数校验，失败即返回错误',
    ],
    uncovered: [
      'OS 级只读：没有任何系统调用拦截写入',
      '平台外层注入的工具（ops_bash / ops_discover_tools 等）可能无法用 restrict 摘除',
      '子会话默认继承父会话权限根；创建钩子覆盖本插件金鱼的文件策略，但外部工具是否全部遵守仍未实测',
      '房间 cwd 只是工作目录，不是权限边界；不是沙箱',
      '参数只收路径不等于零泄漏：文档/源码可能包含父对话或恶意指令，本工具不做内容审查',
      '源码证据未覆盖：金鱼是否真的读过指定源码、读到的内容是否被篡改，均无法验证',
      '多阶段上下文编排未覆盖：不传递 Stage 5 报告到 Stage 8、不校验 Stage 9 目标详设',
      'brainstorm 只做到单次冷启动：一次只派 6 视角中的一条，不并行、不汇总裁剪，调用方需自行逐个派发',
      '材料控制非权限隔离：传 range 时 design.md 仅裁剪指定行并标记原行号，sources/materials 仅拷入受控副本，但子会话未受系统级沙箱隔离，文档内部引用的外部路径仍可能被访问，accessIsolated:false',
      '报告里关于源码的证据无法核对：是否真读过、引用是否对应真实行号，均未验证',
      '命令门控是插件内状态，不是平台权限边界：技能已禁用模型自动调用，但模型仍可直接读取规程、出图纸，或跳过评审直接写代码',
      '创建钩子会为对应版本的金鱼设置原生 read-only 并核对解析结果；本机实际子会话行为尚未验收，不能将钩子与本地测试当作隔离证明',
      '提交后异常探测未经验证：真实宿主环境下 agent.inbox / session.log 的公开性与竞态未作全链路实测，状态未知时仅做尽力探测与防盲目重试，无法保证绝对无重',
    ],
    disclosure: '不安全模式下每次派发都会在结果里标注 strictGoldfishReview:false，不得当作严格金鱼评审。',
  }
}

/** 校验 stage 参数（字符串或数字都接受），非法时返回错误说明。 */
function normalizeStage(raw) {
  const value = String(raw ?? '').trim()
  if (!/^[5-9]$/.test(value)) return { error: `stage 只能是 5 / 6 / 7 / 8 / 9（收到「${value}」）` }
  return { stage: Number(value) }
}

/**
 * 把一串路径解析成工作区内真实路径（逐条 realpath，避免符号链接/junction 越界）。
 * @returns {{entries: Array}|{code: string, error: string}}
 */
async function resolveWorkspacePaths(rawPaths, { baseCwd, io, kind, limit, requireFiles = false }) {
  if (rawPaths === undefined || rawPaths === null) return { entries: [] }
  if (!Array.isArray(rawPaths)) return { code: `E_${kind}_INVALID`, error: `${kind.toLowerCase()} 必须是路径字符串数组` }
  if (rawPaths.length > limit) return { code: `E_${kind}_INVALID`, error: `${kind.toLowerCase()} 最多 ${limit} 条` }

  let baseReal
  try {
    baseReal = await io.realpath(baseCwd)
  } catch {
    baseReal = resolve(baseCwd)
  }

  const entries = []
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { code: `E_${kind}_INVALID`, error: `${kind.toLowerCase()} 里每一项都必须是非空路径字符串` }
    }
    const abs = resolve(baseCwd, raw.trim())
    let real
    try {
      real = await io.realpath(abs)
    } catch {
      return { code: `E_${kind}_MISSING`, error: `路径不存在：${raw}` }
    }
    const rel = relative(baseReal, real)
    if (rel === '') {
      return { code: `E_${kind}_OUTSIDE`, error: `${kind.toLowerCase()} 不能把整个工作区当成范围：${raw}` }
    }
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { code: `E_${kind}_OUTSIDE`, error: `路径越出工作区：${raw}` }
    }
    let info
    try {
      info = await io.stat(real)
    } catch {
      return { code: `E_${kind}_MISSING`, error: `读不到路径：${raw}` }
    }
    if (requireFiles && !info.isFile()) {
      return { code: `E_${kind}_INVALID`, error: `必须是文件：${raw}` }
    }
    const entry = {
      path: real,
      relative: rel.split('\\').join('/'),
      kind: info.isDirectory() ? 'dir' : 'file',
    }
    if (info.isFile()) {
      entry.bytes = info.size
      if (info.size <= HASH_LIMIT_BYTES) {
        try {
          entry.sha256 = createHash('sha256').update(await io.readFile(real)).digest('hex')
        } catch {
          entry.sha256 = '(读取失败，未计算)'
        }
      } else {
        entry.sha256 = '(超过 2MB，未计算)'
      }
    }
    entries.push(entry)
  }
  return { entries }
}

/** 文件存在性检查：返回 null 表示可用，否则返回问题描述。 */
async function missingFile(path, io) {
  try {
    const info = await io.stat(path)
    return info.isFile() ? null : `${path} 不是普通文件`
  } catch {
    return `${path} 不存在`
  }
}

/** 兼容角色的提示词：保持原有语义，只把路径换到房间内的副本。 */
function legacyPrompt({ role, label, roleCopy, docCopy, standardCopy, range }) {
  const lines = [
    `你是 ${role}（${label}）角色。先读角色卡，再干活：`,
    `角色卡：${roleCopy}`,
    `你要审的图纸：${docCopy}`,
  ]
  if (range) {
    lines.push(`本次只审第 ${range.start}–${range.end} 行（共 ${range.total} 行）；行号以原文件为准（房间内的图纸仅包含裁剪行并标注原文行号）。`)
  }
  lines.push('只输出缺陷清单，格式见下面这个文件，总数 ≤500 字：', `格式：${standardCopy}`)
  return lines.join('\n')
}

/** 上游角色的提示词：Mode/标准/图纸/源码清单全部只给路径，不带任何对话内容。 */
function egmPrompt({
  mode,
  role,
  label,
  stage,
  range,
  roleCopy,
  standardCopy,
  docCopy,
  sources,
  manifestPath,
  materials,
}) {
  const lines = [
    `你是 EGM 上游评审角色 ${role}（${label}）。`,
    `Mode: ${mode === 'brainstorm' ? 'BRAINSTORM' : 'REVIEW'}`,
    `第一步：完整读角色卡（它定义你的职责、审计向量与输出格式）：${roleCopy}`,
  ]
  if (standardCopy) lines.push(`第二步：读本次绑定的标准（固定映射，不能换）：${standardCopy}`)
  const concept = mode === 'brainstorm'
  lines.push(
    `${standardCopy ? '第三步' : '第二步'}：读${concept ? '原始功能概念' : '图纸'}：${docCopy}`,
  )
  if (concept) {
    lines.push('按角色卡的 BRAINSTORM 分支执行：评估概念本身，不是审文档合规。')
    lines.push('本工具一次只派一个视角，不并行、不汇总裁剪；不宣称与原版 egm_brainstorm 流程等效。')
  } else {
    lines.push(`评审范围：整份图纸${range ? `，本次只审第 ${range.start}–${range.end} 行（共 ${range.total} 行）` : ''}${stage ? `；当前阶段 ${stage}（${STAGE_NAMES[stage]}）` : ''}。`)
    if (range) {
      lines.push(
        `行号必须以原文件为准（房间里的 design.md 仅包含裁剪区间第 ${range.start}–${range.end} 行，每行已标注原行号）；只审 ${range.start}–${range.end}，范围外的问题只有在影响本区间时才提。`,
      )
    }
  }
  if (sources.length > 0) {
    lines.push('图纸引用的源码（房间内受控副本；请只读本房间副本，不要读取房间外路径）：')
    for (const source of sources) lines.push(`- ${source.copyPath}（对应原文件 ${source.relative}）`)
    if (manifestPath) {
      lines.push(`源码清单与校验值（包含 origin 与 hash 证据）：${manifestPath}`)
    }
  }
  if (materials.length > 0) {
    lines.push('阶段材料（房间内受控副本；请只读本房间副本）：')
    for (const material of materials) lines.push(`- ${material.copyPath}（原路径 ${material.relative}）`)
  }
  if (stage === 8) {
    lines.push(
      materials.length > 0
        ? '注意：本工具不校验上面哪一份是 Stage 5 报告；请自行按内容判断，缺失就明说缺口。'
        : '注意：本次没有提供 Stage 5 报告。上游 Stage 8 依赖它，缺了就不算完整的中期 Zoom Out，请在报告里明说。',
    )
  }
  if (stage === 9) {
    lines.push(
      materials.length > 0
        ? '注意：本工具不校验上面哪一份是目标详设（DetailedRange）；请自行按内容判断，缺失就明说缺口。'
        : '注意：本次没有提供目标详设。上游 Stage 9 以详设为对象，缺了就只能审现有图纸，请在报告里明说。',
    )
  }
  lines.push(
    '',
    '硬规矩：',
    '- 只输出评审意见。不修改任何文件，不写补丁代码，不执行命令。',
    '- 每条意见必须指到具体位置（标题、行号或文件路径）；指不出来就写 [无代码依据]。',
    '- 报告用中文，按严重级别从高到低排列；不要奉承、不要总结陈词。',
  )
  return lines.join('\n')
}

/**
 * 从 .egm/config.json 尝试查找并解析自定义角色。
 * 支持显式 profileId 查找，也支持从 defaultProfile 或配置的所有 profiles 中查找。
 */
function resolveCustomRole(role, options = {}) {
  const { baseCwd = process.cwd(), profileId = '', standardPath = null } = options
  const loaded = loadReviewConfig({ workspace: baseCwd, roleIds: ROLE_IDS })
  if (!loaded.ok || !loaded.present) {
    return fail('E_UNKNOWN_ROLE', `未知角色「${role}」。白名单：${ROLE_IDS.join(' / ')}`)
  }

  const profiles = loaded.config.review?.profiles || {}

  // 1. 如果显式指定了 profileId
  if (profileId) {
    const resolved = resolveReviewProfile({ workspace: baseCwd, roleIds: ROLE_IDS, profileId, config: loaded.config, hash: loaded.hash })
    if (!resolved.ok) {
      return fail(resolved.code || 'E_PROFILE_INVALID', resolved.error, { field: resolved.field || null, boundary: boundaryOf() })
    }
    const entry = (resolved.profile.roles || []).find((item) => item.id === role)
    if (!entry) {
      return fail(
        'E_PROFILE_ROLE_NOT_IN_PROFILE',
        `角色「${role}」不在评审配置「${resolved.profile.id}」里（该配置包含：${(resolved.profile.roles || []).map((item) => item.id).join(' / ')}）。`,
        { boundary: boundaryOf() },
      )
    }
    const finalStandardPath = standardPath || entry.standardPath || null
    return {
      ok: true,
      spec: {
        role,
        kind: 'custom',
        label: entry.label || role,
        cardPath: null,
        standardPath: finalStandardPath,
        stages: resolved.profile.stages?.length ? resolved.profile.stages : [5, 6, 7, 8, 9],
      },
      profile: resolved.profile,
      configHash: resolved.hash,
    }
  }

  // 2. 未显式指定 profileId，按 defaultProfile 优先，再遍历所有 profiles 查找
  const candidateIds = []
  const defaultProfile = loaded.config.review?.defaultProfile
  if (defaultProfile && profiles[defaultProfile]) {
    candidateIds.push(defaultProfile)
  }
  for (const pid of Object.keys(profiles)) {
    if (!candidateIds.includes(pid)) candidateIds.push(pid)
  }

  for (const pid of candidateIds) {
    const profileDef = profiles[pid]
    const hasRole = (profileDef?.roles || []).some((r) => (typeof r === 'object' ? r.id === role : r === role))
    if (hasRole) {
      const resolved = resolveReviewProfile({ workspace: baseCwd, roleIds: ROLE_IDS, profileId: pid, config: loaded.config, hash: loaded.hash })
      if (!resolved.ok) {
        return fail(resolved.code || 'E_PROFILE_INVALID', resolved.error, { field: resolved.field || null, boundary: boundaryOf() })
      }
      const entry = (resolved.profile.roles || []).find((item) => item.id === role)
      if (entry) {
        const finalStandardPath = standardPath || entry.standardPath || null
        return {
          ok: true,
          spec: {
            role,
            kind: 'custom',
            label: entry.label || role,
            cardPath: null,
            standardPath: finalStandardPath,
            stages: resolved.profile.stages?.length ? resolved.profile.stages : [5, 6, 7, 8, 9],
          },
          profile: resolved.profile,
          configHash: resolved.hash,
        }
      }
    }
  }

  return fail('E_UNKNOWN_ROLE', `未知角色「${role}」。白名单：${ROLE_IDS.join(' / ')}`)
}

/**
 * 派发核心：校验 → 检查用户许可 → 建房间 → 派零上下文子代理 → 收报告 → 落盘校验。
 * 与工具注册解耦，便于本地测试注入 mock（不真实派发）。
 *
 * 默认 fail-closed：没有用户通过 /egm-unsafe 发放的短时许可，直接返回
 * E_READONLY_UNVERIFIED，不建房间、不派发。
 *
 * @param options.subagents - 子代理服务（须有 startActivation）。
 * @param options.parent - 父会话 agent。
 * @param options.args - { docPath, role, stage?, mode?, sources?, materials? }。
 * @param options.baseCwd - 工作区根（相对路径的基准）。
 * @param options.vendorRoot - vendor/egm 根目录。
 * @param options.roomsRoot - 房间根目录（默认 <baseCwd>/.egm）。
 * @param options.io - 文件操作实现（默认 node:fs/promises）。
 * @param options.timeoutMs - 子代理超时。
 * @returns 成功 {ok:true,...} / 失败 {ok:false,code,error,...}。
 */
export async function dispatchGoldfish(options = {}) {
  const {
    subagents,
    parent,
    args = {},
    baseCwd = process.cwd(),
    vendorRoot = VENDOR_ROOT,
    roomsRoot,
    io = DEFAULT_IO,
    timeoutMs = DISPATCH_TIMEOUT_MS,
    onStart = null,
    goldfishId: optionsGoldfishId,
  } = options

  if (!parent) return fail('E_NO_PARENT', 'egm_dispatch 必须在会话内调用（需要父会话作为派活方）')

  const docPath = String(args?.docPath ?? '').trim()
  if (docPath === '') return fail('E_DOC_EMPTY', 'docPath 不能为空：金鱼只看文件，不收口头描述')

  const role = String(args?.role ?? '').trim()
  let spec = roleSpecOf(role, vendorRoot)

  // 可选 profile：项目级评审配置（.egm/config.json）里的一份命名配置。
  // 只做三件事：校验配置本身、确认角色属于这份配置、把配置哈希带回结果。
  let profile = null
  const rawProfile = args?.profile === undefined ? '' : String(args.profile).trim()
  let configHash = null

  if (spec) {
    if (rawProfile) {
      const resolved = resolveReviewProfile({ workspace: baseCwd, roleIds: ROLE_IDS, profileId: rawProfile })
      if (!resolved.ok) {
        return fail(resolved.code || 'E_PROFILE_INVALID', resolved.error, { field: resolved.field || null, boundary: boundaryOf() })
      }
      profile = resolved.profile
      configHash = resolved.hash
      const entry = (profile.roles || []).filter((item) => item.id === role)[0] || null
      if (!entry) {
        return fail(
          'E_PROFILE_ROLE_NOT_IN_PROFILE',
          `角色「${role}」不在评审配置「${profile.id}」里（该配置包含：${(profile.roles || []).map((item) => item.id).join(' / ')}）。`,
          { boundary: boundaryOf() },
        )
      }
    }
  } else {
    // 角色不在内置白名单，尝试从 review-config 加载自定义角色
    const customResult = resolveCustomRole(role, {
      baseCwd,
      profileId: rawProfile,
      standardPath: options?.standardPath || args?.standardPath,
    })
    if (!customResult.ok) {
      return fail(customResult.code || 'E_UNKNOWN_ROLE', customResult.error, { boundary: boundaryOf() })
    }
    spec = customResult.spec
    if (rawProfile) {
      profile = customResult.profile
    }
    configHash = customResult.configHash
  }

  // 模式：review（默认）与 brainstorm。brainstorm 只走上游 6 个视角，标准不参与。
  const mode = String(args?.mode ?? 'review').trim().toLowerCase()
  if (mode !== 'review' && mode !== 'brainstorm') {
    return fail('E_MODE_UNSUPPORTED', `未知模式「${mode}」：只支持 mode=review 或 mode=brainstorm。`, {
      boundary: boundaryOf(),
    })
  }
  if (mode === 'brainstorm' && !BRAINSTORM_ROLES.includes(role)) {
    return fail(
      'E_MODE_ROLE_MISMATCH',
      `brainstorm 只允许这 6 个视角：${BRAINSTORM_ROLES.join(' / ')}；收到 ${role}。`,
      { boundary: boundaryOf() },
    )
  }

  // 阶段校验：只对上游 7 角色与自定义角色生效；兼容角色或 brainstorm 带 stage 明确拒绝，不猜测。
  let stage = null
  const rawStage = args?.stage
  if (rawStage !== undefined && rawStage !== null && String(rawStage).trim() !== '') {
    const normalized = normalizeStage(rawStage)
    if (normalized.error) return fail('E_STAGE_INVALID', normalized.error)
    stage = normalized.stage
    if (mode === 'brainstorm') {
      return fail('E_STAGE_NOT_APPLICABLE', 'brainstorm 发生在 draft/review 之前，没有阶段绑定；请去掉 stage')
    }
    if (spec.kind === 'legacy') {
      return fail(
        'E_STAGE_NOT_APPLICABLE',
        `这一步不能带阶段。角色「${role}」是老三鱼（逻辑 / 可行性 / 冷水），它们不参加阶段评审。两条路二选一：① 去掉 stage，让老三鱼当普通评审；② 把角色换成上游七鱼（design_critic / structural / style / comprehension / zoom_out / implementation_readiness / codebase_details）之一，再配对应的 stage。`,
      )
    }
    if (spec.kind === 'custom') {
      if (profile && Array.isArray(profile.stages) && profile.stages.length > 0 && !profile.stages.includes(stage)) {
        return fail(
          'E_STAGE_ROLE_MISMATCH',
          `阶段 ${stage}（${STAGE_NAMES[stage]}）不在评审配置「${profile.id}」声明的阶段（${profile.stages.join(' / ')}）中；收到 ${role}`,
        )
      }
    } else if (!spec.stages.includes(stage)) {
      return fail(
        'E_STAGE_ROLE_MISMATCH',
        `阶段 ${stage}（${STAGE_NAMES[stage]}）只接受角色：${STAGE_ROLES[stage].join(' / ')}；收到 ${role}`,
      )
    }
  }

  const rawRange = args?.range
  if (mode === 'brainstorm' && rawRange !== undefined && rawRange !== null) {
    return fail('E_RANGE_NOT_APPLICABLE', 'brainstorm 评估概念，不做行区间审核；请去掉 range')
  }

  // 1. 图纸验证（前置验证：realpath、工作区限制、大小、range 合法性）
  const docCheck = await validateDesignDoc({
    docPath,
    range: rawRange,
    baseCwd,
    io,
  })
  if (!docCheck.ok) return fail(docCheck.code, docCheck.error)

  // 2. sources 校验（前置验证：realpath、显式拒目录、防越界）
  const sourcesCheck = await validateSources({
    rawSources: args?.sources,
    baseCwd,
    io,
    limit: MAX_SOURCES,
  })
  if (!sourcesCheck.ok) return fail(sourcesCheck.code, sourcesCheck.error)

  // 3. materials：先把目录/网址收成受控副本并留清单，再按普通文件校验。
  //    目录展开与网址抓取都有显式上限；没收进来的项写进清单，报告必须按"缺材料"处理，
  //    不许用印象补。不收目录/网址时这一层完全跳过（行为和之前一致）。
  let materialManifest = null
  let rawMaterials = args?.materials
  if (needsCollection(rawMaterials)) {
    const collected = await collectMaterials({ workspace: baseCwd, entries: rawMaterials })
    if (!collected.ok) return fail(collected.code, collected.error)
    const rel = (path) => (typeof path === 'string' ? relative(baseCwd, path).split('\\').join('/') : null)
    materialManifest = {
      dir: rel(collected.dir),
      manifestPath: rel(collected.manifestPath),
      manifestSha256: collected.manifestSha256,
      coverage: collected.coverage,
      excluded: Array.isArray(collected.excluded) ? collected.excluded.slice(0, 20) : [],
      missing: Array.isArray(collected.missing) ? collected.missing.slice(0, 20) : [],
      notes: collected.notes,
    }
    if (collected.files.length === 0) {
      const reasons = materialManifest.missing.map(item => item.reason).filter(Boolean).join('；')
      return fail(
        'E_MATERIALS_EMPTY',
        `材料一份也没收进来${reasons ? `：${reasons}` : ''}。清单在 ${materialManifest.manifestPath ?? '（没写出来）'}；不能用印象补，请换成本地文件或修好网址后重试。`,
      )
    }
    rawMaterials = collected.files.map(file => rel(file))
  }

  // 4. materials 校验（前置验证：realpath、普通文件、≤2MB、防越界）
  const materialsCheck = await validateMaterials({
    rawMaterials,
    baseCwd,
    io,
    limit: materialManifest ? 64 : MAX_MATERIALS,
  })
  if (!materialsCheck.ok) return fail(materialsCheck.code, materialsCheck.error)

  // 角色卡与标准必须在建房间之前确认；缺文件就是错误，不降级、不换角色。
  if (spec.cardPath) {
    const cardProblem = await missingFile(spec.cardPath, io)
    if (cardProblem) {
      const hint = spec.kind === 'egm' ? '（检查包内 vendor/egm 是否已装入，或文件名是否与上游一致）' : ''
      return fail('E_ROLE_CARD_MISSING', `角色卡缺失：${cardProblem}${hint}`)
    }
  }
  // brainstorm 不绑定标准（上游 6 视角走概念，标准只服务于 REVIEW）。
  const needsStandard = mode === 'review' && spec.standardPath !== null
  if (needsStandard) {
    const standardProblem = await missingFile(spec.standardPath, io)
    if (standardProblem) {
      const hint = spec.kind === 'custom' ? `（自定义角色 ${role} 的标准文件不可访问）` : `（角色 ${role} 的固定标准不可替换）`
      return fail('E_STANDARD_MISSING', `标准文件缺失：${standardProblem}${hint}`)
    }
  }

  if (!subagents?.startActivation) {
    return fail('E_SUBAGENTS_UNAVAILABLE', '这台机器上派不出零上下文评审（子代理服务不可用）。按铁律：不许在同上下文里假装评审。')
  }

  // 命令门控：只有 /egm 打开的会话窗口里才允许派发。模型调不到命令，但可以加载
  // egm-gate 技能自建流程——所以这里只锁「派发」这一步，不声称锁住全流程。
  if (!peekGate(parent)) {
    return fail(
      'E_GATE_NOT_OPEN',
      '未通过 /egm 启动：egm_dispatch 只能在已打开的会话窗口内使用。请让用户在 EGM 界面点击「允许本轮评审」按钮一次性授权，或输入 /egm-review-access 确认无隔离；亦可输入 /egm-open（只开窗，不启动任何流程），或输入 /egm <需求>（会同时启动 egm-gate 快速流程）后再派发。',
      { boundary: boundaryOf() },
    )
  }

  // 默认 fail-closed：没有用户本人发放的短时许可，就不派发。
  const permit = takeUnsafePermit(parent)
  if (!permit) {
    return fail(
      'E_READONLY_UNVERIFIED',
      '默认拒绝：无法证实子代理只读（平台外层工具可能无法排除、子会话继承父权限根），本工具不声称隔离成立。如用户明确接受非隔离评审，请让用户在 EGM 界面点击「允许本轮评审」按钮，或亲自输入 /egm-review-access 确认无隔离（或 /egm-unsafe 确认无隔离，10 分钟内最多 6 次），再重试；结果会被标注为非严格评审。',
      { boundary: boundaryOf() },
    )
  }

  const gate = takeGate(parent)
  if (!gate) {
    return fail(
      'E_GATE_NOT_OPEN',
      '派发窗口已过期或用尽，请让用户在 EGM 界面点击「允许本轮评审」按钮，或重新输入 /egm-review-access 确认无隔离；亦可重新输入 /egm-open（只开窗，不启动任何流程）或 /egm <需求>（会同时启动 egm-gate 快速流程）。',
      { boundary: boundaryOf() },
    )
  }

  const goldfishId =
    optionsGoldfishId ||
    (typeof args?.goldfishId === 'string' && args.goldfishId.trim() !== ''
      ? args.goldfishId.trim()
      : `gf-${role || 'goldfish'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  const boundary = {
    ...boundaryOf(),
    unsafePermit: { reason: permit.reason, remaining: permit.remaining, expiresAt: permit.expiresAt },
  }

  // 真正要派了：通知顶栏宠物。钩子出错绝不影响派发本身。
  const startedAt = Date.now()
  try {
    onStart?.({
      id: goldfishId,
      role,
      mode,
      stage,
      docPath: typeof args?.docPath === 'string' ? args.docPath : undefined,
      sessionId: sessionIdOf(parent),
      startedAt,
      gate: { remaining: gate.remaining, expiresAt: gate.expiresAt },
    })
  } catch {
    // 宠物只是装饰，不许拖累派发。
  }

  // 一次性房间：mkdtemp 保证并发唯一；房内只有图纸、角色卡、标准、材料与源码清单。
  const rooms = roomsRoot ?? join(baseCwd, '.egm')
  let scratch
  try {
    await io.mkdir(rooms, { recursive: true })
    scratch = await io.mkdtemp(join(rooms, 'review-'))
  } catch (error) {
    return fail('E_ROOM_CREATE', `无法创建一次性评审房间：${error?.message ?? String(error)}`)
  }

  const roleCopy = join(scratch, 'role.md')
  const standardCopy = needsStandard ? join(scratch, 'standard.md') : null
  let docCopy
  let sourcesList = []
  let manifestPath = null
  let materialsList = []
  try {
    if (spec.cardPath) {
      await io.copyFile(spec.cardPath, roleCopy)
    } else {
      const customCardContent = [
        `# 角色：${role}（${spec.label || role}）`,
        '',
        '你是一个零上下文的独立评审子代理（金鱼）。',
        '1. 严格只读：不修改任何文件，不写补丁代码，不执行命令。',
        '2. 零历史：以全新读者视角独立审查图纸。',
        '3. 严格按绑定的标准进行独立挑刺，每条意见必须指到具体位置。',
      ].join('\n')
      await io.writeFile(roleCopy, customCardContent, 'utf8')
    }
    if (standardCopy) await io.copyFile(spec.standardPath, standardCopy)

    const docPrep = await prepareDesignDoc({ verifiedDoc: docCheck, scratch, io })
    if (!docPrep.ok) return fail(docPrep.code, docPrep.error, { scratch })
    docCopy = docPrep.docCopy

    const sourcesPrep = await prepareSources({ verifiedSources: sourcesCheck.entries, scratch, io })
    if (!sourcesPrep.ok) return fail(sourcesPrep.code, sourcesPrep.error, { scratch })
    sourcesList = sourcesPrep.entries
    manifestPath = sourcesPrep.manifestPath

    const materialsPrep = await prepareMaterials({ verifiedMaterials: materialsCheck.entries, scratch, io })
    if (!materialsPrep.ok) return fail(materialsPrep.code, materialsPrep.error, { scratch })
    materialsList = materialsPrep.entries
  } catch (error) {
    return fail('E_ROOM_PREPARE', `评审房间准备失败：${error?.message ?? String(error)}`, { scratch })
  }

  const range = docCheck.range
  const prompt =
    spec.kind === 'legacy'
      ? legacyPrompt({ role, label: spec.label, roleCopy, docCopy, standardCopy, range })
      : egmPrompt({
          mode,
          role,
          label: spec.label,
          stage,
          range,
          roleCopy,
          standardCopy,
          docCopy,
          sources: sourcesList,
          manifestPath,
          materials: materialsList,
        })

  const controller = new AbortController()
  let started
  try {
    started = await subagents.startActivation({
      provider: 'spawn',
      label: `egm-goldfish-${role}`,
      request: {
        parent,
        prompt: [{ type: 'text', text: prompt }],
        agentPreset: GOLDFISH_ID,
        cwd: scratch,
      },
      delivery: 'caller',
      signal: controller.signal,
    })
  } catch (error) {
    return fail(error?.code === 'E_GOLDFISH_POLICY' ? 'E_GOLDFISH_POLICY' : 'E_DISPATCH', `派金鱼失败：${error?.message ?? String(error)}`, { scratch, boundary })
  }

  let report
  let timedOut = false
  try {
    const rawResult = await awaitResult(started, timeoutMs)
    if (rawResult && typeof rawResult === 'object' && rawResult.ok === false) {
      return fail(rawResult.code ?? 'E_DISPATCH', `金鱼返回失败：${rawResult.error ?? '未知错误'}`, {
        scratch,
        boundary,
        role,
        stage,
      })
    }
    report = textOf(rawResult)
  } catch (error) {
    timedOut = error?.code === 'E_TIMEOUT'
    return fail(timedOut ? 'E_TIMEOUT' : (error?.code ?? 'E_DISPATCH'), error?.message ?? String(error), {
      scratch,
      boundary,
      role,
      stage,
    })
  } finally {
    // 超时也要尽量终止并释放子会话；释放失败不影响已拿到的错误或报告。
    if (timedOut) {
      try {
        controller.abort()
      } catch {
        // 忽略中止错误
      }
      for (const method of ['terminate', 'abort', 'cancel']) {
        try {
          if (typeof started?.[method] === 'function') await started[method]()
        } catch {
          // 尽力而为：有的平台没有这些钩子。
        }
      }
    }
    try {
      await started?.dispose?.()
    } catch {
      // 释放失败不影响已拿到的结果。
    }
  }

  if (typeof report !== 'string' || report.trim() === '') {
    return fail('E_EMPTY_REPORT', '金鱼没有返回正文（可能超时或异常结束），本次不算通过。', {
      scratch,
      boundary,
      role,
      stage,
    })
  }

  // Artifact-First：报告必须落盘；写失败或校验不一致都算失败，不能静默成功。
  const reportPath = join(scratch, `report-${role}.md`)
  try {
    await io.writeFile(reportPath, report, 'utf8')
    const written = await io.stat(reportPath)
    const expected = Buffer.byteLength(report, 'utf8')
    if (!written.isFile() || written.size !== expected) {
      return fail(
        'E_REPORT_WRITE',
        `报告写入后校验失败：期望 ${expected} 字节，实际 ${written.isFile() ? written.size : '非文件'} 字节（${reportPath}）`,
        { report, scratch, boundary, role, stage },
      )
    }
  } catch (error) {
    return fail('E_REPORT_WRITE', `报告落盘失败：${error?.message ?? String(error)}（${reportPath}）`, {
      report,
      scratch,
      boundary,
      role,
      stage,
    })
  }

  const display = (path, base) => (path === null ? null : relative(base, path).split('\\').join('/'))

  return {
    ok: true,
    goldfishId,
    mode,
    role,
    roleKind: spec.kind,
    label: spec.label,
    stage,
    range: docCheck.range ? {
      start: docCheck.range.start,
      end: docCheck.range.end,
      total: docCheck.range.total,
    } : null,
    rangeMapping: docCheck.rangeMapping,
    accessIsolated: false,
    report,
    reportPath,
    scratch,
    standard: needsStandard
      ? display(spec.standardPath, spec.kind === 'custom' ? baseCwd : (spec.kind === 'egm' ? vendorRoot : PKG_ROOT))
      : null,
    // 评审配置：profile 只在调用方显式传了 config 里的名字时才有值；configHash 让报告能对回同一份配置。
    profile: profile ? { id: profile.id, label: profile.label, coverage: profile.coverage } : null,
    configHash,
    // 材料清单：只有收过目录/网址时才有值；coverage.complete=false 表示有缺项。
    materialManifest,
    sources: sourcesList,
    materials: materialsList.map((material) => ({ relative: material.relative, copyPath: material.copyPath, accessIsolated: false })),
    // 非隔离评审：结果可用，但不得当作严格金鱼评审。
    reviewClass: 'unsafe-nonisolated',
    strictGoldfishReview: false,
    // 单次派活不编排多阶段上下文（Stage 5 → 8、Stage 9 详设），因此不宣称与原版流程等效。
    equivalence: {
      flowEquivalent: false,
      note: '各次任务独立临时目录，不限制访问范围；不编排跨阶段上下文（Stage 5 → 8 报告、Stage 9 目标详设需调用方自行提供）；brainstorm 六视角需调用方逐个派发。不宣称与原版 egm_review / egm_brainstorm 流程等效。',
    },
    boundary,
  }
}

/**
 * 注册 egm_dispatch 工具。
 * @param ctx - 已就绪 tools/subagents 服务的插件上下文。
 */
export function registerDispatchTool(ctx, hooks = {}) {
  ctx.tools.register({
    name: 'egm_dispatch',
    description: [
      'EGM 派金鱼：把设计文档复制进一次性房间，派一条零上下文子代理按白名单角色与固定标准挑刺。',
      `角色：${ROLE_IDS.join(' / ')}（logic/feasibility/cold 为原有兼容角色，其余为上游 7 评审角色）。`,
      '派发有两道用户门：需先由用户输入 /egm-open 或 /egm <需求> 打开本会话的派发窗口，再由用户输入 /egm-unsafe 确认无隔离（默认 fail-closed）。',
      '本机无法证实子代理只读，这不是安全隔离，工具不声称隔离成立；结果标注 strictGoldfishReview:false、accessIsolated:false。参数只有路径，没有传对话内容的口子；',
      '文档/源码本身仍可能含父对话或恶意指令。可选 stage=5..9 校验角色属于该阶段；mode=brainstorm 走 6 个概念视角（一次一条，不并行）；',
      'range={start,end} 裁剪房间内 design.md 仅含指定区间并标注原行号；sources 传引用的源码文件路径（显式拒目录，拷入受控副本）；materials 传阶段材料。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        docPath: { type: 'string', description: '要审的设计文档路径（通常是 .egm/ 下的图纸）' },
        role: {
          type: 'string',
          description: '金鱼角色：3 个兼容角色 + 上游 7 评审角色，亦支持在 .egm/config.json 中声明的自定义角色；角色决定固定标准，不可随意替换',
        },
        stage: {
          type: 'string',
          enum: ['5', '6', '7', '8', '9'],
          description: '可选：上游评审阶段，用于校验角色属于该阶段（5=zoom_out, 6=comprehension, 7=design/structural/style, 8=zoom_out, 9=implementation_readiness/codebase_details/style）',
        },
        mode: {
          type: 'string',
          enum: ['review', 'brainstorm'],
          description:
            '可选，默认 review（提示词固定 Mode: REVIEW）。brainstorm 走上游 6 个概念视角（design_critic/codebase_details/zoom_out/comprehension/implementation_readiness/structural），一次只派一条，需调用方逐个派发；不宣称与原版 brainstorm 编排等效',
        },
        range: {
          type: 'object',
          properties: {
            start: { type: 'integer', description: '起始行号（1 起，含）' },
            end: { type: 'integer', description: '结束行号（含）' },
          },
          required: ['start', 'end'],
          additionalProperties: false,
          description:
            '可选：单次审核的原文件行区间（FeatureRange / DetailedRange）。裁剪房间内 design.md 仅含指定区间并标注原文行号，非权限隔离；越界、非整数或 start>end 一律拒绝；brainstorm 不可用',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：图纸引用的源码文件路径（工作区相对或绝对，必须位于工作区内，不支持目录）；准备房间内受控副本与校验值清单，不收文件内容以外的输入',
        },
        materials: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：阶段材料。可以是工作区内的文件路径（≤10 个、每个 ≤2MB），也可以是 dir:<工作区相对目录>（按 .gitignore/.egmignore 展开，有文件数/体积/深度上限）或 https:// 网址（只抓公开地址，拒私网/回环/重定向越界，只收文本，有超时与体积上限）。目录/网址会先收成受控副本并写 manifest；没收进来的项记在 materialManifest 里，coverage.complete=false 时必须按缺材料处理',
        },
        profile: {
          type: 'string',
          description:
            '可选：项目级评审配置（.egm/config.json 的 review.profiles 里的一份配置名）。给了就校验配置本身、确认角色属于该配置，并把配置哈希写进结果；不会因此放宽角色白名单，也不会改工具权限。配置写错会返回具体字段错误，不回落到默认值',
        },
      },
      required: ['docPath', 'role'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => {
        const scratch = typeof value?.scratch === 'string' ? `\n\n（评审房间：${value.scratch}）` : ''
        if (value?.ok === false || (value?.error && typeof value?.report !== 'string')) {
          const code = value?.code ? `（${value.code}）` : ''
          return [{ type: 'text', text: `EGM 派发失败${code}：${value?.error ?? '未知错误'}${scratch}\n（运行预设：${GOLDFISH_ID}）` }]
        }
        const report =
          typeof value?.report === 'string' && value.report.trim() !== '' ? value.report : '（金鱼没有返回正文）'
        const banner =
          value?.strictGoldfishReview === false
            ? '⚠️ 非隔离评审（用户已显式许可，10 分钟内有效）：只读未经验证，不得当作严格金鱼评审。\n\n'
            : ''
        const saved = typeof value?.reportPath === 'string' ? `\n\n（完整报告：${value.reportPath}）` : ''
        return [{ type: 'text', text: banner + report + saved + scratch }]
      },
    },
    async execute(args, exec) {
      const parent = exec?.agent
      if (!parent) return fail('E_NO_PARENT', 'egm_dispatch 必须在会话内调用（需要父会话作为派活方）')
      const sessionId = sessionIdOf(parent)
      const role = String(args?.role ?? '')
      const mode = String(args?.mode ?? 'review')
      const stage = args?.stage
      const docPath = typeof args?.docPath === 'string' ? args.docPath : undefined
      const goldfishId = typeof args?.goldfishId === 'string' && args.goldfishId.trim() !== ''
        ? args.goldfishId.trim()
        : `gf-${role || 'goldfish'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      let didStart = false

      const notify = (type, extra = {}) => {
        try {
          hooks.onEvent?.({
            type,
            sessionId,
            id: goldfishId,
            role,
            mode,
            stage,
            docPath,
            ...extra,
          })
        } catch {
          // 宠物只是装饰，不许影响派发结果。
        }
      }

      const startedAt = Date.now()
      const workspaceCwd = sessionCwdOf(parent)

      // 评审批次记录：单次派发也留一条 run（一份 job），用来回答"这份内容审过没有"、
      // "重启后哪些作业状态未知"。记录失败绝不影响派发本身。
      let runId = null
      try {
        const record = readTaskRecordStatus(sessionId, { includeArchived: true })
        const task = record?.state === 'ok' ? record.task : null
        const rawDoc = typeof docPath === 'string' && docPath.trim() !== '' ? docPath.trim() : task?.docPath
        const reviewDoc = rawDoc ? (isAbsolute(rawDoc) ? rawDoc : resolve(workspaceCwd, rawDoc)) : null
        if (reviewDoc) {
          let docText = null
          try {
            docText = await readFile(reviewDoc, 'utf8')
          } catch {
            docText = null
          }
          const created = createReviewRun({
            workspace: workspaceCwd,
            sessionId,
            taskId: task?.id ?? null,
            stage: stage ?? null,
            mode,
            docPath: reviewDoc,
            docText,
            configHash: null,
            materialManifestHash: null, // manifest 在 dispatchGoldfish 内部收集，此处拿不到；留 null 不崩溃
            roles: [role],
          })
          if (created?.ok) {
            runId = created.run.runId
            updateReviewRunJob({ workspace: workspaceCwd, runId, role, status: 'running' })
          }
        }
      } catch {
        runId = null
      }

      const result = await dispatchGoldfish({
        subagents: ctx.get?.('subagents'),
        parent,
        args,
        goldfishId,
        baseCwd: sessionCwdOf(parent),
        onStart: (startEvent) => {
          didStart = true
          notify('dispatch-start', startEvent)
        },
      })

      // 评审台账：记录本次派发对应的图纸内容摘要，供"旧评审不能批准新图纸"的核对使用。
      // 台账只证明"这份内容被审过"，不证明评审质量，也不自动放行实现。
      try {
        const record = readTaskRecordStatus(sessionId, { includeArchived: true })
        const task = record?.state === 'ok' ? record.task : null
        const baseCwd = sessionCwdOf(parent)
        const rawDoc = typeof docPath === 'string' && docPath.trim() !== '' ? docPath.trim() : task?.docPath
        const reviewDoc = rawDoc ? (isAbsolute(rawDoc) ? rawDoc : resolve(baseCwd, rawDoc)) : null
        if (reviewDoc) {
          recordReviewRun({
            workspace: baseCwd,
            sessionId,
            taskId: task?.id ?? null,
            docPath: reviewDoc,
            role,
            stage: stage ?? null,
            ok: result?.ok === true,
            reportPath: result?.reportPath ?? null,
            startedAt,
            endedAt: Date.now(),
          })
        }
      } catch {
        // 台账故障不影响派发结果。
      }

      // 收尾运行记录：成功→completed，失败→failed；状态写不进去就留在 running，
      // 下次 reconcileReviewRuns 会把它标成 unknown，不会自动重跑。
      if (runId) {
        try {
          updateReviewRunJob({
            workspace: workspaceCwd,
            runId,
            role,
            status: result?.ok === true ? 'completed' : 'failed',
            reportPath: result?.reportPath ?? null,
            error: result?.ok === true ? null : (result?.error ?? result?.code ?? 'dispatch failed'),
          })
          finishReviewRun({ workspace: workspaceCwd, runId })
        } catch {
          // 同上：记录问题不影响结果。
        }
      }

      if (result?.ok === true) {
        notify('dispatch-done', {
          id: result.goldfishId ?? goldfishId,
          reportPath: result.reportPath,
          report: result.report,
          finishedAt: Date.now(),
        })
      } else {
        notify('dispatch-failed', {
          id: result?.goldfishId ?? goldfishId,
          error: result?.error ?? result?.message ?? result?.code ?? 'dispatch failed',
          code: result?.code,
          didStart,
          failedAt: Date.now(),
        })
      }
      return result
    },
  })
}

/** 开场白（简明版）：用户气泡可见，仅含需求与未派金鱼提示。 */
export function kickoffBriefText(idea) {
  return [
    '🐘🐟【EGM 守门已启动 · 大象与金鱼开始筹备】',
    `想做的事：${idea}`,
    '大象会先梳理需求和方案；图纸准备好后，金鱼可以帮你挑问题，是否采纳由你决定。',
    '现在还没有派出金鱼。派发前需要你明确确认：目前无法证实金鱼运行环境是只读隔离的。',
  ].join('\n')
}

/** 开场规程（详细版）：通过宿主原生 context 注入，UI 默认折叠，模型完整接收全部步骤。 */
export function kickoffProcedureText() {
  let resourceNote = ''
  try {
    resourceNote = skillResourceInstructions('egm-gate', PKG_ROOT)
  } catch {
    // 降级兜底
  }
  return [
    resourceNote ? `${resourceNote}\n` : '',
    '请先在对话中简短说明已进入准备阶段、接下来会做什么；不要声称金鱼已经开始评审。',
    '本会话的 egm_dispatch 派发窗口已打开（2 小时 / 最多 20 次；模型无法自行打开）。',
    '请立即按以下顺序工作，中途不要写任何实现代码：',
    `1. 读取规程文件 ${join(PKG_ROOT, 'skills', 'egm-gate', 'SKILL.md')}，严格按其工序与铁律执行；文件中的引用以插件包根目录 ${PKG_ROOT} 为基准。若无法读取，停止并请用户手动调用 egm-gate 技能；`,
    '2. 在 .egm/ 下出图纸；拿不准的问题先问用户，不要编；',
    '3. 图纸就绪后调用 egm_dispatch 工具派金鱼挑刺（只给文档路径和角色），把结果整理成结果卡交给用户拍板。',
    '   注意：egm_dispatch 默认拒绝派发（无法证实只读）。需要许可时，读取上面列出的 interaction-contract.md，按其中插件专有的 ```egm-review 围栏或 <egm-review>JSON</egm-review> 块输出 egm-review-grant / egm-review-deny 专用按钮，再等待用户本人点击。专有块由 EGM 独占解析渲染，严禁使用通用 dsh-ui 围栏，防止 GenUI 竞争；不要要求复制命令或把普通文字“好”当授权（备用终端命令为 /egm-review-access 确认无隔离 或 /egm-unsafe 确认无隔离）。',
    '   点击允许后插件会先执行真实许可命令，随后以默认折叠的内部上下文通知（source.kind: context）提醒你继续原任务，不产生普通可见用户气泡，不污染输入框草稿。用户点否同样注入内部通知并停止派金鱼。实际派发仍以工具当前许可检查为准，禁止模型自行执行许可命令。',
    '   评审完成后，必须先在正常可见回复中完整呈现金鱼发现与推荐的具体修复方案，严禁在用户看清结果前过早发起 ask_user_question 问卷；有未跑通报告如实标明，绝不声称全通过。',
  ].filter(Boolean).join('\n')
}

/** 开场白全量文本（保留兼容）：两段拼接。 */
export function kickoffText(idea) {
  return [kickoffBriefText(idea), '', kickoffProcedureText()].filter(Boolean).join('\n')
}

/** 继续现有任务时的简明说明：包含当前任务 ID、版本及新增需求。 */
export function continuationBriefText(idea, task) {
  return [
    `🐘【EGM 任务继续 · 增量推进】（任务: ${task.taskId} · r${task.revision}）`,
    `补充/变更需求：${idea}`,
    task.originalRequest ? `初始需求：${task.originalRequest}` : '',
    task.docPath ? `当前图纸：${task.docPath}` : '（沿用当前会话在 .egm/ 下的已有图纸）',
  ].filter(Boolean).join('\n')
}

/** 继续现有任务时的执行规程：明确要求在原有图纸和决策基础上更新，严禁重置。 */
export function continuationProcedureText(task) {
  return [
    '这是当前会话既有 EGM 任务的继续推进，请严格遵循以下规则：',
    '1. 保持同一份图纸：在 .egm/ 下更新已有的设计图纸，保留已确定且仍有效的架构决策与历史上下文，严禁从头重置或推翻重来；',
    '2. 增量融合新需求：将用户补充或更新的要求融入现有图纸中，清晰标注修改范围；',
    '3. 保持当前图纸路径；任务修订编号用于接续和防旧卡，不是修改额度；',
    '4. 如需金鱼评审，向用户说明修订部分后按规程申请与派发；中途不要直接编写实现代码。',
  ].join('\n')
}

/** 继续推进全量文本（保留兼容）：两段拼接。 */
export function continuationText(idea, task) {
  return [continuationBriefText(idea, task), '', continuationProcedureText(task)].filter(Boolean).join('\n')
}

/** 纯图片输入时，大象梳理需求的默认目标描述。 */
export const DEFAULT_IMAGE_IDEA = '按附带的图片进行需求梳理与设计'

/**
 * 构造符合 DSH 规范的 UserMessage（参考 dsh-llm 的 createUserMessage 与 goal.js）。
 */
export function createUserMessage(input) {
  return {
    id: input?.id ?? randomUUID(),
    role: 'user',
    content: Array.isArray(input?.content) ? input.content : [],
    source: input?.source ?? { kind: 'user' },
  }
}

/**
 * 注册 /egm 斜杠命令：打开本次会话的派发窗口，并提示模型走守门流程。
 * 注意：这挡不住模型自行加载 egm-gate 技能或跳过评审；能锁的只有 egm_dispatch。
 * 当会话已有进行中任务时，增量继续推进现有任务，绝不重置图纸或重新开窗。
 * @param ctx - 已就绪 commands 服务的插件上下文。
 */
function taskResult(task) {
  return {
    sessionId: task.sessionId,
    id: task.id,
    taskId: task.taskId,
    revision: task.revision,
    specRevision: task.specRevision,
    workflow: task.workflow || 'gate',
    status: task.status,
    title: task.title,
    phase: task.phase,
    heldFrom: task.heldFrom || null,
    docPath: task.docPath,
  }
}

function emitTaskEvent(hooks, event) {
  try { hooks.onEvent?.(event) } catch { /* decorations do not decide delivery */ }
}

function startEgmTask(invocation, hooks) {
  const { agent, rawInput, attachments = [] } = invocation ?? {}
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return { kind: 'error', text: '无法核实当前会话，未启动方案。' }
  if (typeof agent?.steer !== 'function') return { kind: 'error', text: '宿主不支持直接投递，未改用排队发送。' }

  // 工作流前缀：/egm --workflow brainstorm 需求…
  const parsed = parseWorkflowPrefix(String(rawInput ?? ''))
  if (parsed.explicit && !parsed.found) {
    return {
      kind: 'error',
      code: 'E_WORKFLOW_UNKNOWN',
      text:
        '未知工作流：' +
        parsed.rawId +
        '。可用：' +
        listWorkflows()
          .map(item => item.id + '（' + item.label + '）')
          .join('、'),
    }
  }
  const workflow = resolveWorkflow(parsed.workflowId)
  const text = parsed.rest
  if (text.startsWith('/egm-')) return { kind: 'error', text: '控制命令不能作为新的 EGM 需求。' }
  const safeAttachments = Array.isArray(attachments) ? attachments : []
  const idea = text || (safeAttachments.length ? DEFAULT_IMAGE_IDEA : '')
  if (!idea) return { kind: 'error', text: '请先填写需求或附上图片。' }

  try {
    assertSkillResources(workflow.skill, PKG_ROOT)
    registerActiveAgent(agent)

    const record = readTaskRecordStatus(sessionId, { includeArchived: true })
    if (record.state === 'corrupt' || record.state === 'unreadable') {
      return {
        kind: 'error',
        code: 'E_TASK_RECORD_UNREADABLE',
        text:
          '当前方案记录读不出来（这不等于没有方案）。为避免覆盖，没有新建任务；请先备份或移走 .egm/sessions 下的记录文件，再刷新面板。',
      }
    }
    const previous = record.state === 'ok' ? record.task : null
    const isContinuation = Boolean(previous)
    const workflowChanged = Boolean(previous) && previous.workflow !== workflow.id
    const task = previous
      ? updateActiveTask(sessionId, {
          currentRequest: idea,
          status: 'active',
          phase: workflowChanged ? 'prep' : 'revise',
          workflow: parsed.explicit ? workflow.id : previous.workflow || 'gate',
          bumpSpec: true,
          historyEntry: {
            type: 'continuation',
            request: idea,
            workflow: parsed.explicit ? workflow.id : previous.workflow || 'gate',
          },
        })
      : createActiveTask({
          sessionId,
          workspace: workspaceOf(agent),
          request: idea,
          workflow: workflow.id,
        })

    // 只有需要派金鱼的工作流才开派发窗口；其余工作流不额外发放窗口
    const needsGate = task.workflow === 'gate' || task.workflow === 'custom'
    const gate = needsGate ? peekGate(agent) || openGate(agent) : peekGate(agent)
    if (needsGate && !gate) return { kind: 'error', text: '派发窗口打开失败；没有发放评审许可。' }

    const activeWorkflow = resolveWorkflow(task.workflow)
    const isGate = activeWorkflow.id === 'gate'
    const procedure = isGate
      ? isContinuation
        ? continuationProcedureText(task)
        : kickoffProcedureText()
      : workflowProcedureText(activeWorkflow)
    const brief = isGate
      ? isContinuation
        ? continuationBriefText(idea, task)
        : kickoffBriefText(idea)
      : workflowKickoffBrief(activeWorkflow, idea)
    const stateNote = [
      '当前任务 ID：' + task.id + '；记录版本：' + task.revision + '；方案版本：' + task.specRevision + '（都不是修改额度）。',
      '工作流：' + activeWorkflow.label + '（' + activeWorkflow.id + '）。',
      '图纸路径：' + task.docPath + '。沿用同一份图纸，按变动范围核对旧报告是否仍适用。',
      '普通用户消息（提问、补充说明）不改变方案版本，也不解除暂缓；只有明确改需求才接续并升版。',
      '暂缓只阻止后续调度；已经在跑的金鱼或工具不会被打断，插件没有"停止当前运行"的按钮。',
      '需要用户拍板时，先展示发现和修法，再按 interaction-contract 输出 egm-actions 按钮。',
      '动作卡 taskId 和 specRevision 必须使用本次真实值；不确定时省略这两个字段，勿编造。',
      '进度用 egm-progress 块上报（绑定 opId），只报进度，不代替用户批准或独立验收。',
    ].join('\n')

    if (gate) {
      emitTaskEvent(hooks, {
        type: 'gate-opened',
        sessionId,
        prep: true,
        writing: false,
        gate: { remaining: gate.remaining, expiresAt: gate.expiresAt },
      })
    }
    agent.steer(
      createUserMessage({
        content: [...safeAttachments, { type: 'text', text: [brief, stateNote, procedure].join('\n\n') }],
        source: {
          kind: 'context',
          name: isContinuation ? 'egm-continuation-procedure' : 'egm-kickoff-procedure',
          form: 'notice',
          summary: (isContinuation ? 'EGM 需求更新：' : 'EGM 需求：') + idea.slice(0, 120),
        },
      })
    )
    return {
      kind: 'success',
      text: isContinuation ? '已接续当前大象和图纸。' : '大象已开始梳理当前方案。',
      data: { ...taskResult(task), isContinuation },
    }
  } catch (error) {
    return {
      kind: 'error',
      text:
        'EGM 处理异常：' +
        (error?.message || String(error)) +
        '。任务记录或消息可能已经提交，请先查看当前状态，避免重复发送。',
    }
  }
}

export function registerEgmCommand(ctx, hooks = {}) {
  ctx.commands.register({ name: 'egm', description: '首次启动方案，或接续当前大象与图纸。',
    input: { hint: '<需求或调整>', attachments: true },
    handler: invocation => startEgmTask(invocation, hooks) })
}

const TASK_ACTION_GUIDANCE = Object.freeze({
  revise: '用户选择按推荐修改图纸。大象只更新 .egm/ 下的设计文档、图纸和设计状态；禁止改动业务源码、客户端或服务端实现。保留有效决策，先核实金鱼意见，再修改图纸。金鱼继续只做独立审查，不新增施工金鱼。',
  review: '用户选择继续复核。只检查当前图纸变更与受影响范围，不编写业务实现代码。按真实许可决定是否可以派金鱼；许可不足展示 egm-review 授权按钮，不自行批准。',
  proceed: '用户明确选择按方案开始实现。先核对已展示的当前图纸、验收判据、未覆盖范围及确认成立的阻塞项。未闭环阻塞不得绕过；点击本按钮不等于用户接受未披露风险。条件满足才按图纸实现，不扩展范围。',
  hold: '用户选择先保留方案。保存当前图纸与决定，本步只简短确认暂缓；不继续修改图纸、实现代码或派金鱼，等待后续用户消息。注意：已经在跑的金鱼或工具不会被强行打断，会自然结束；插件没有提供"停止当前运行"的按钮，不要声称已经停掉它们。',
  resume: '用户明确要求从暂缓恢复到之前的阶段继续推进。不改图纸内容、不重置版本；先说明将从哪一步继续，再按当前图纸推进。若此前有在途工作，按实际状态说明，不要假设它们还活着。',
  complete: '用户选择结项：这份方案视为完成。简短确认已完成的范围与仍未覆盖的部分，不要声称未验证的东西已验证。结项与归档不同，之后用户仍可显式重开。',
  reopen: '用户选择重开已结项（或暂缓）的方案。恢复为进行中，保留原图纸与历史决策；不要假装之前已经完成的工作需要全部重做，也不要跳过仍需核实的部分。',
})

/** 动作对应的阶段（只切换工序，不改图纸内容）。 */
function phaseForAction(action, task) {
  switch (action) {
    case 'revise':
      return 'revise'
    case 'review':
      return 'review'
    case 'proceed':
      return 'proceed'
    case 'hold':
      return 'hold'
    case 'resume':
      return task.heldFrom || (task.phase === 'hold' ? 'design' : task.phase) || 'design'
    case 'complete':
      return task.phase === 'hold' ? task.heldFrom || 'design' : task.phase || 'design'
    case 'reopen':
      return task.phase === 'hold' ? task.heldFrom || 'design' : task.phase || 'design'
    default:
      return task.phase
  }
}

/** 动作对应的状态。 */
function statusForAction(action) {
  if (action === 'hold') return 'held'
  if (action === 'complete') return 'completed'
  return 'active'
}

/**
 * 应用一次用户显式方案动作。
 *
 * 交付语义（见 P0-B）：
 *   1. 先落操作流水（pending-send）；
 *   2. 校验不过 → failed（明确没送达，可以重试）；
 *   3. 记录已改但投递抛错 → awaiting-confirm（绝不自动重发、不回滚）；
 *   4. 投递成功 → delivered。
 *
 * @param {string} extraArg 额外参数（proceed 的 confirm 覆盖标记）
 */
function applyTaskAction(invocation, hooks, action, expectedId, expectedSpec, extraArg) {
  const agent = invocation?.agent
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return { kind: 'error', text: '无法核实当前会话。' }
  registerActiveAgent(agent)
  const workspace = workspaceOf(agent)

  const record = readTaskRecordStatus(sessionId, { includeArchived: true })
  if (record.state === 'corrupt' || record.state === 'unreadable') {
    return {
      kind: 'error',
      code: 'E_TASK_RECORD_UNREADABLE',
      text: '当前方案记录读不出来（这不等于没有方案）。为避免覆盖，本次操作没有执行；请先备份或移走 .egm/sessions 下的记录文件，再刷新面板。',
    }
  }
  const task = record.state === 'ok' ? record.task : null
  if (!task) return { kind: 'error', text: '当前没有可接续的方案，请先填写需求。' }
  if (action !== 'new' && (task.status === 'archived' || task.status === 'closed')) {
    return {
      kind: 'error',
      code: 'E_TASK_ARCHIVED',
      text: '这份方案已归档，不能继续操作；请从面板恢复历史方案，或另起新方案。',
    }
  }
  if (expectedId && expectedId !== task.id) {
    return { kind: 'error', code: 'E_TASK_ID_MISMATCH', text: '这是旧方案的按钮，请使用当前方案。' }
  }
  if (!TASK_ACTIONS.includes(action)) return { kind: 'error', text: '未知方案操作。' }
  if (expectedSpec && String(task.specRevision) !== String(expectedSpec)) {
    return {
      kind: 'error',
      code: 'E_SPEC_REVISION_MISMATCH',
      text:
        '方案已更新（当前第 ' +
        task.specRevision +
        ' 版），这张操作卡已过期；请使用最新回复里的按钮，或在面板查看当前方案。',
    }
  }

  // 上一次操作结果未知时不诱导重复点击；冷却时间过后自动放行（见 action-log）。
  const inFlight = findInFlightOp({ sessionId, workspace, taskId: task.id })
  if (inFlight) {
    return {
      kind: 'error',
      code: 'E_OP_IN_FLIGHT',
      text:
        '上一次操作（' +
        (inFlight.action || '方案动作') +
        '）的送达状态还没确认。先看当前方案是否已经变了，不要重复点击；几分钟后仍未变化可以再试一次。',
    }
  }

  // 归档：单独分支，不需要投递消息
  if (action === 'new') {
    const { op } = createOrReuseOp({
      sessionId,
      workspace,
      taskId: task.id,
      specRevision: task.specRevision,
      action,
    })
    try {
      const archived = archiveActiveTask(sessionId, { note: '用户明确另起方案' })
      if (!archived) {
        updateOp({ sessionId, workspace, opId: op.opId, deliveryState: 'failed', detail: { code: 'E_ARCHIVE_EMPTY' } })
        return { kind: 'error', code: 'E_ARCHIVE_EMPTY', text: '没有可归档的方案。' }
      }
      updateOp({ sessionId, workspace, opId: op.opId, deliveryState: 'delivered', detail: { status: archived.status } })
      emitTaskEvent(hooks, { type: 'task-archived', sessionId, task: taskResult(archived) })
      return { kind: 'success', text: '旧方案记录已归档，请填写新需求。', data: taskResult(archived) }
    } catch (error) {
      updateOp({
        sessionId,
        workspace,
        opId: op.opId,
        deliveryState: 'unknown',
        detail: { error: error?.message || String(error) },
      })
      return {
        kind: 'error',
        code: 'E_DELIVERY_UNKNOWN',
        text:
          '归档过程出错：' +
          (error?.message || String(error)) +
          '。状态可能已经改了，请先查看当前状态，不要重复点击。',
      }
    }
  }

  if (typeof agent?.steer !== 'function') {
    return { kind: 'error', text: '宿主不支持直接投递，未改用排队发送。' }
  }

  // proceed 门：当前图纸必须被成功评审过；内容变了要显式 confirm 覆盖（并留痕）。
  let override = null
  if (action === 'proceed') {
    const confirmOverride = String(extraArg ?? '').trim().toLowerCase() === 'confirm'
    const check = checkReviewFreshness({ workspace, sessionId, docPath: task.docPath || '' })
    if (!check.ok && !confirmOverride) {
      const detail = check.code === 'E_DOC_UNREADABLE' ? '图纸文件还没读到（可能还没出图纸）。' : check.reason
      return {
        kind: 'error',
        code: check.code,
        text:
          detail +
          ' 若你确认不需要重新评审、并接受未复核的部分，请显式输入：/egm-action proceed ' +
          task.id +
          ' ' +
          task.specRevision +
          ' confirm',
      }
    }
    if (!check.ok) override = { code: check.code, reason: check.reason }

    // 台账里还没处理的阻断问题，不许"因为评审过期了就直接开工"绕过。
    // 这里只做提示与阻断，不代替用户判断，也不自动把问题标成已处理。
    try {
      const ledgerRead = readLedger({ workspace, taskId: task.id })
      if (ledgerRead.ok) {
        const summary = summarizeLedger(ledgerRead.ledger)
        if (summary.openBlockers > 0 && !confirmOverride) {
          return {
            kind: 'error',
            code: 'E_OPEN_BLOCKERS',
            text:
              `台账里还有 ${summary.openBlockers} 条阻断问题没处理（${summary.note}）。` +
              '要么先处理掉，要么显式输入：/egm-action proceed ' +
              task.id +
              ' ' +
              task.specRevision +
              ' confirm 表示你接受带着这些问题开始实现。',
          }
        }
        if (summary.openBlockers > 0 && confirmOverride && !override) {
          override = { code: 'E_OPEN_BLOCKERS', reason: `${summary.openBlockers} 条阻断问题未处理（用户显式覆盖）` }
        }
      }
    } catch {
      // 台账读不出来不阻断动作，但也不会被当成"没问题"写进任何结论。
    }
  }

  const { op } = createOrReuseOp({
    sessionId,
    workspace,
    taskId: task.id,
    specRevision: task.specRevision,
    action,
    detail: override ? { override } : {},
  })

  let updated = null
  try {
    updated = updateActiveTask(sessionId, {
      phase: phaseForAction(action, task),
      status: statusForAction(action),
      action,
      historyEntry: override
        ? { type: 'proceed-override', action, note: '用户显式覆盖评审核对：' + override.reason }
        : { type: 'action', action, note: '用户点击方案动作：' + action },
    })
  } catch (error) {
    updateOp({
      sessionId,
      workspace,
      opId: op.opId,
      deliveryState: 'failed',
      detail: { stage: 'record', error: error?.message || String(error) },
    })
    return {
      kind: 'error',
      code: 'E_TASK_UPDATE_FAILED',
      text: '方案记录没有更新成功：' + (error?.message || String(error)) + '。这次没有发出任何指令。',
    }
  }
  if (!updated) {
    updateOp({ sessionId, workspace, opId: op.opId, deliveryState: 'failed', detail: { stage: 'record' } })
    return { kind: 'error', code: 'E_TASK_MISSING', text: '方案记录突然不见了，这次没有发出任何指令。' }
  }

  emitTaskEvent(hooks, { type: 'task-updated', sessionId, task: taskResult(updated) })

  try {
    agent.steer(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: [
              TASK_ACTION_GUIDANCE[action],
              override ? '注意：用户已显式覆盖评审核对（' + override.reason + '），不要把它说成"评审已通过"。' : '',
              '当前任务 ID：' + updated.id + '；方案版本：' + updated.specRevision + '；记录版本：' + updated.revision + '。',
              '当前图纸：' + (updated.docPath || '（还没有图纸路径）') + '。版本号不是修改额度。',
              '后续动作卡请引用本次真实 taskId 和方案版本（specRevision），过期卡不可继续使用。',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        source: { kind: 'context', name: 'egm-task-action', form: 'notice', summary: 'EGM 方案操作：' + action },
      })
    )
  } catch (error) {
    updateOp({
      sessionId,
      workspace,
      opId: op.opId,
      deliveryState: 'unknown',
      detail: { stage: 'deliver', error: error?.message || String(error) },
    })
    return {
      kind: 'error',
      code: 'E_DELIVERY_UNKNOWN',
      text:
        '方案状态已更新，但通知没有确认送到大象（' +
        (error?.message || String(error)) +
        '）。不要重复点击；直接发一句普通消息说明你的要求即可，状态不会丢。',
    }
  }

  updateOp({
    sessionId,
    workspace,
    opId: op.opId,
    deliveryState: 'delivered',
    detail: { status: updated.status, phase: updated.phase },
  })

  const okText =
    action === 'hold'
      ? '已保留当前方案。已经在跑的金鱼或工具不会被强行中断，会自然结束。'
      : action === 'complete'
        ? '已把这份方案标记为完成。之后仍可显式重开。'
        : action === 'resume'
          ? '已恢复推进，接着之前的阶段继续。'
          : action === 'reopen'
            ? '已重开这份方案。'
            : '已将所选操作交给当前大象。'
  return { kind: 'success', text: okText, data: taskResult(updated) }
}

export function registerEgmTaskActionCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-action',
    description: '处理当前方案的直接点击操作（含显式覆盖评审核对）。',
    input: { hint: '<revise|review|proceed|hold|resume|complete|reopen|new> [taskId] [specRevision] [confirm]' },
    handler: invocation => {
      const parts = String(invocation?.rawInput ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
      if (parts.length > 4) return { kind: 'error', text: '方案动作参数不正确。' }
      return applyTaskAction(invocation, hooks, parts[0], parts[1], parts[2], parts[3])
    },
  })
}

/**
 * 注册 /egm-restore：把一条历史归档方案恢复成当前方案。
 * 不恢复任何评审许可或派发窗口；恢复后 specRevision 前进，旧动作卡作废。
 */
export function registerEgmRestoreCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-restore',
    description: '恢复一条历史归档方案为当前方案（不恢复任何评审许可）。',
    input: { hint: '<归档文件名>' },
    handler: invocation => {
      const agent = invocation?.agent
      const sessionId = sessionIdOf(agent)
      if (!sessionId) return { kind: 'error', text: '无法核实当前会话。' }
      registerActiveAgent(agent)
      const fileName = String(invocation?.rawInput ?? '').trim()
      if (!fileName) return { kind: 'error', text: '请提供要恢复的归档文件名（面板「历史方案」里有）。' }
      try {
        const restored = restoreArchivedTask({
          sessionId,
          workspace: workspaceOf(agent),
          fileName,
          note: '用户从历史方案恢复',
        })
        emitTaskEvent(hooks, { type: 'task-restored', sessionId, task: taskResult(restored) })
        if (typeof agent?.steer === 'function') {
          try {
            agent.steer(
              createUserMessage({
                content: [
                  {
                    type: 'text',
                    text: [
                      '用户恢复了历史方案（归档文件：' + fileName + '）。',
                      '当前任务 ID：' + restored.id + '；方案版本：' + restored.specRevision + '；记录版本：' + restored.revision + '。',
                      '当前图纸：' + (restored.docPath || '（归档记录里没有图纸路径）') + '。',
                      '请先核对图纸文件是否还在。没有恢复任何评审许可或派发窗口；需要评审时重新申请。',
                      '后续动作卡请使用本次真实 taskId 和方案版本（specRevision）。',
                    ].join('\n'),
                  },
                ],
                source: { kind: 'context', name: 'egm-task-restore', form: 'notice', summary: 'EGM 恢复历史方案' },
              })
            )
          } catch {
            // 通知失败不影响恢复结果本身
          }
        }
        return {
          kind: 'success',
          text:
            '已恢复历史方案：' +
            (restored.title || restored.id) +
            '。图纸文件是否仍在请以面板显示为准；评审许可没有恢复。',
          data: taskResult(restored),
        }
      } catch (error) {
        return {
          kind: 'error',
          code: 'E_RESTORE_FAILED',
          text: '恢复失败：' + (error?.message || String(error)),
        }
      }
    },
  })
}

/**
 * `/egm-config`：只读检查项目级评审配置。
 * 不写文件、不改许可、不派发；配置写错时回具体字段错误，由用户自己改。
 */
/** 命令共用的"当前任务"读取（区分"没有任务"和"记录读不出来"）。 */
function currentTaskFor(agent) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return { sessionId: null, task: null, error: '无法核实当前会话。' }
  const record = readTaskRecordStatus(sessionId, { includeArchived: true })
  if (record.state !== 'ok') {
    return {
      sessionId,
      task: null,
      error: (record.error || '任务记录读不出来。') + ' 请先备份该文件，不要直接覆盖。',
    }
  }
  return { sessionId, task: record.task, error: null }
}

function fmtTime(value) {
  if (!value) return '时间未知'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '时间未知'
  }
}

/**
 * /egm-run：看评审批次记录；`reconcile` 只把重启后状态不明的作业标成未知，不重跑；
 * `retry <runId>` 只给"能复用哪些、要重派哪些"的建议，派发仍由人决定。
 */
export function registerEgmRunCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-run',
    description: '查看本会话的评审批次记录；把重启后状态不明的作业标成未知；给出重试建议（不会自动重跑）。',
    input: { hint: '[reconcile|retry <运行ID>]' },
    handler: invocation => {
      const agent = invocation?.agent
      const { sessionId, task, error } = currentTaskFor(agent)
      if (!sessionId) return { kind: 'error', text: '无法核实当前会话。' }
      if (error) return { kind: 'error', code: 'E_TASK_RECORD_UNREADABLE', text: error }
      const workspace = workspaceOf(agent)
      const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      const sub = (parts[0] || '').toLowerCase()

      if (sub === 'retry') {
        const runId = parts[1] || ''
        if (!runId) return { kind: 'error', text: '请给出运行 ID：/egm-run retry <运行ID>' }
        const plan = planReviewRetry({ workspace, runId })
        if (!plan.ok) return { kind: 'error', code: plan.code, text: plan.error || '算不出重试方案。' }
        const lines = [
          `运行 ${runId} 的重试建议：`,
          `- 可以复用：${plan.reuse.length > 0 ? plan.reuse.join(' / ') : '（没有）'}`,
          `- 需要重派：${plan.retry.length > 0 ? plan.retry.join(' / ') : '（没有）'}`,
          `- 依据：${plan.reason}`,
          '汇总报告不会复用（每次都要重新汇总，避免把旧结论当新结论）。',
          '要重派请自己在对话里说明角色，或用 egm_dispatch；本命令不会自动派发。',
        ]
        return { kind: 'success', text: lines.join('\n'), data: plan }
      }

      let reconciled = null
      if (task) {
        const result = reconcileReviewRuns({ workspace, taskId: task.id })
        if (result.ok) reconciled = result.changed
      }
      const listed = task ? listReviewRuns({ workspace, taskId: task.id, limit: 8 }) : { ok: true, runs: [] }
      if (!listed.ok) return { kind: 'error', code: listed.code, text: listed.error || '读不到运行记录。' }
      if (listed.runs.length === 0) {
        return {
          kind: 'success',
          text: task
            ? '这个方案还没有评审批次记录（派过金鱼之后才会有）。'
            : '当前会话还没有方案，也就没有评审批次记录。',
        }
      }
      const lines = ['评审批次记录（最近 ' + listed.runs.length + ' 条）：']
      for (const run of listed.runs) {
        lines.push(
          `- ${run.runId}｜${run.status}｜${describeReviewRun(run)}｜阶段 ${run.stage ?? '未标'}｜${fmtTime(run.createdAt)}`,
        )
        const jobs = (run.jobs || []).map(job => `${job.role}:${job.status}`).join('，')
        if (jobs) lines.push(`  作业：${jobs}`)
      }
      if (reconciled && reconciled > 0) {
        lines.push('', `这次把 ${reconciled} 条"进程重启后状态不明"的记录标成了未知；没有自动重跑。`)
      } else {
        lines.push('', '没有需要改成未知的记录（进程没重启过，或之前已经处理过）。')
      }
      if (task) {
        const impact = analyzeReviewImpact({ workspace, taskId: task.id, docPath: task.docPath || '' })
        if (impact.ok) {
          lines.push(`影响面判断：${impact.mode}（${impact.reason}）。`)
          if (impact.changed.length > 0) lines.push(`- 变过的段落：${impact.changed.slice(0, 8).join(' / ')}`)
          if (impact.affectedRoles.length > 0) lines.push(`- 建议重审角色：${impact.affectedRoles.join(' / ')}`)
        }
      }
      return { kind: 'success', text: lines.join('\n'), data: { runs: listed.runs, reconciled } }
    },
  })
}

/**
 * /egm-findings：问题台账。默认列出来；add / verify / dispose 改状态。
 * 规则：confirmed 必须给证据；accepted-risk 必须给范围；模型和人都不能凭一句话把问题标成已核实。
 */
export function registerEgmFindingsCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-findings',
    description: '查看/登记问题台账（原文、核实状态、处置状态）。核实为 confirmed 必须带证据，接受风险必须带范围。',
    input: { hint: '[add <严重度> <摘要>|verify <问题ID> <unverified|confirmed|disproven> [证据]|dispose <问题ID> <open|fixed|accepted-risk|deferred> [范围]]' },
    handler: invocation => {
      const agent = invocation?.agent
      const { task, error } = currentTaskFor(agent)
      if (error) return { kind: 'error', code: 'E_TASK_RECORD_UNREADABLE', text: error }
      if (!task) return { kind: 'error', text: '当前会话还没有方案，台账没有挂靠对象。' }
      const workspace = workspaceOf(agent)
      const raw = String(invocation?.rawInput ?? '').trim()
      const parts = raw.split(/\s+/).filter(Boolean)
      const sub = (parts[0] || '').toLowerCase()

      if (sub === 'add') {
        const severity = SEVERITIES.includes((parts[1] || '').toLowerCase()) ? parts[1].toLowerCase() : 'medium'
        const summary = parts.slice(2).join(' ')
        const saved = upsertFinding({ workspace, taskId: task.id, finding: { severity, summary } })
        if (!saved.ok) return { kind: 'error', code: saved.code, text: saved.error }
        return {
          kind: 'success',
          text: `已登记问题 ${saved.finding.id}（${severity}，未核实）：${saved.finding.summary || '（只有原文摘录）'}`,
          data: saved.finding,
        }
      }

      if (sub === 'verify') {
        const id = parts[1] || ''
        const state = (parts[2] || '').toLowerCase()
        const evidence = parts.slice(3).join(' ')
        if (!id) return { kind: 'error', text: '请给出问题 ID：/egm-findings verify <问题ID> <状态> [证据]' }
        const result = setFindingVerification({ workspace, taskId: task.id, findingId: id, state, evidence, by: 'user-command' })
        if (!result.ok) return { kind: 'error', code: result.code, text: result.error }
        return {
          kind: 'success',
          text: `问题 ${id} 的核实状态已改为 ${state}${evidence ? '（证据已记录）' : ''}。`,
          data: result.finding,
        }
      }

      if (sub === 'dispose') {
        const id = parts[1] || ''
        const state = (parts[2] || '').toLowerCase()
        const note = parts.slice(3).join(' ')
        if (!id) return { kind: 'error', text: '请给出问题 ID：/egm-findings dispose <问题ID> <处置> [范围]' }
        const result = setFindingDisposition({ workspace, taskId: task.id, findingId: id, state, note, riskScope: note })
        if (!result.ok) return { kind: 'error', code: result.code, text: result.error }
        return {
          kind: 'success',
          text: `问题 ${id} 的处置状态已改为 ${state}${note ? '（范围已记录）' : ''}。`,
          data: result.finding,
        }
      }

      const listed = listFindings({ workspace, taskId: task.id, limit: 30 })
      if (!listed.ok) return { kind: 'error', code: listed.code, text: listed.error }
      const read = readLedger({ workspace, taskId: task.id })
      const summary = read.ok ? summarizeLedger(read.ledger) : null
      if (listed.findings.length === 0) {
        return { kind: 'success', text: '台账里还没有问题。派金鱼评审后可以把问题记进来。' }
      }
      const lines = [`问题台账（共 ${listed.total} 条）：`]
      for (const item of listed.findings) {
        const verification = item.verification?.state ?? 'unverified'
        const disposition = item.disposition?.state ?? 'open'
        lines.push(`- ${item.id}｜${item.severity}｜核实:${verification}｜处置:${disposition}｜${item.summary || '（原文摘录）'}`)
      }
      if (summary) lines.push('', summary.note)
      return { kind: 'success', text: lines.join('\n'), data: { findings: listed.findings, summary } }
    },
  })
}

/** /egm-artifact：把图纸/报告/交接文档登记进台账（自动算内容哈希）。 */
export function registerEgmArtifactCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-artifact',
    description: '把一个产物（图纸、评审报告、交接文档等）登记进本方案的台账，记录内容哈希。',
    input: { hint: '<类型> <工作区相对路径>' },
    handler: invocation => {
      const agent = invocation?.agent
      const { task, error } = currentTaskFor(agent)
      if (error) return { kind: 'error', code: 'E_TASK_RECORD_UNREADABLE', text: error }
      if (!task) return { kind: 'error', text: '当前会话还没有方案，产物没有挂靠对象。' }
      const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      if (parts.length < 2) {
        return {
          kind: 'error',
          text: `用法：/egm-artifact <类型> <路径>。类型可用：${ARTIFACT_KINDS.join(' / ')}`,
        }
      }
      const kind = ARTIFACT_KINDS.includes(parts[0].toLowerCase()) ? parts[0].toLowerCase() : 'other'
      const path = parts.slice(1).join(' ')
      const saved = upsertArtifact({ workspace: workspaceOf(agent), taskId: task.id, artifact: { kind, path } })
      if (!saved.ok) return { kind: 'error', code: saved.code, text: saved.error }
      return {
        kind: 'success',
        text: `已登记产物：${saved.artifact.path}（${kind}，哈希 ${String(saved.artifact.contentHash).slice(0, 12)}）${kind === 'design' ? '，并设为当前图纸' : ''}。`,
        data: saved.artifact,
      }
    },
  })
}

/** /egm-handoff：导出交接包；import 只做只读预览，不恢复任何权限、不自动开工。 */
export function registerEgmHandoffCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-handoff',
    description: '导出/预览交接包（Markdown）。导出不含许可、密钥、无关聊天；导入只预览，不恢复权限、不自动开工。',
    input: { hint: '[export|import <交接文件路径>]' },
    handler: invocation => {
      const agent = invocation?.agent
      const { sessionId, task, error } = currentTaskFor(agent)
      if (error) return { kind: 'error', code: 'E_TASK_RECORD_UNREADABLE', text: error }
      const workspace = workspaceOf(agent)
      const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      const sub = (parts[0] || 'export').toLowerCase()

      if (sub === 'import') {
        const filePath = parts.slice(1).join(' ')
        if (!filePath) return { kind: 'error', text: '请给出交接文件路径：/egm-handoff import <路径>' }
        const result = importHandoff({ workspace, filePath })
        if (!result.ok) return { kind: 'error', code: result.code, text: result.error }
        const s = result.summary
        return {
          kind: 'success',
          text: [
            '交接包预览（只读，没有恢复任何东西）：',
            `- 方案：${s.title || '（没写标题）'}｜${s.taskId || '无 ID'}｜${s.workflow || '未标流程'}｜${s.status || '状态未知'}`,
            `- 图纸：${s.docPath || '（没写）'}`,
            `- 完整性：${s.completeness}`,
            ...result.notes.map(note => `- ${note}`),
          ].join('\n'),
          data: result.summary,
        }
      }

      if (!task) return { kind: 'error', text: '当前会话还没有方案，没有可导出的交接内容。' }
      const result = exportHandoff({ workspace, taskId: task.id, sessionId })
      if (!result.ok) return { kind: 'error', code: result.code, text: result.error }
      return {
        kind: 'success',
        text: [
          `已导出交接包：${result.path}`,
          '里面不含评审许可、密钥、无关聊天；机器私有路径已换成工作区相对路径。',
          `未验证项：${result.summary.unverified > 0 ? result.summary.unverified + ' 条（交接包里逐条列了）' : '没有登记'}`,
        ].join('\n'),
        data: { path: result.path, summary: result.summary },
      }
    },
  })
}

/**
 * /egm-bootstrap：仓库文档并行整理。
 * plan 只出分区；run 派文档工写到暂存目录；commit 校验后落盘，冲突保留候选、不覆盖。
 * 这不是金鱼评审，不声明只读隔离；跑之前仍然要求用户已经打开 EGM 流程窗口。
 */
export function registerEgmBootstrapCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-bootstrap',
    description: '仓库文档并行整理：plan 出分区，run 派文档工写到暂存目录，commit 校验后落盘（冲突保留候选，不覆盖）。',
    input: { hint: '[plan|run|commit] [分区ID,分区ID] [--root <子目录>]' },
    handler: invocation => {
      const agent = invocation?.agent
      const sessionId = sessionIdOf(agent)
      if (!sessionId) return { kind: 'error', text: '无法核实当前会话。' }
      registerActiveAgent(agent)
      const workspace = workspaceOf(agent)
      const record = readTaskRecordStatus(sessionId, { includeArchived: true })
      const task = record.state === 'ok' ? record.task : null
      if (record.state !== 'ok') {
        return { kind: 'error', code: 'E_TASK_RECORD_UNREADABLE', text: (record.error || '任务记录读不出来。') + ' 请先备份该文件。' }
      }
      const raw = String(invocation?.rawInput ?? '').trim()
      const parts = raw.split(/\s+/).filter(Boolean)
      const sub = (parts[0] || 'plan').toLowerCase()
      const rootIndex = parts.indexOf('--root')
      const root = rootIndex >= 0 && parts[rootIndex + 1] ? parts[rootIndex + 1] : '.'
      const idArg = parts.slice(1).filter((part, index) => part !== '--root' && index !== rootIndex - 1 && !part.startsWith('-')).join(',')
      const selectedIds = idArg.split(',').map(item => item.trim()).filter(Boolean)

      const plan = planBootstrap({ workspace, root })
      if (!plan.ok) return { kind: 'error', code: plan.code, text: plan.error }

      if (sub === 'plan') {
        const lines = [`仓库文档整理计划（根目录 ${plan.root}）：共 ${plan.totalFiles} 个文件，${plan.partitions.length} 个分区。`]
        for (const partition of plan.partitions) {
          lines.push(`- ${partition.id}｜${partition.label}｜${partition.files.length} 个文件｜约 ${Math.round(partition.approxBytes / 1024)}KB`)
        }
        for (const note of plan.notes) lines.push(`注：${note}`)
        lines.push('下一步：/egm-bootstrap run（派文档工写到暂存目录）。')
        return { kind: 'success', text: lines.join('\n'), data: plan }
      }

      if (!peekGate(agent)) {
        return {
          kind: 'error',
          code: 'E_GATE_NOT_OPEN',
          text: '文档整理也要先打开 EGM 流程窗口（/egm-open 或 /egm <需求>）；这是为了防止模型自己在后台开一堆子会话。',
        }
      }

      const checkpointRead = task ? readBootstrapCheckpoint({ workspace, taskId: task.id }) : { ok: true, checkpoint: null }
      const checkpoint = checkpointRead.ok ? checkpointRead.checkpoint : null

      if (sub === 'run') {
        const subagents = ctx.get?.('subagents')
        if (!subagents?.startActivation) {
          return { kind: 'error', code: 'E_NO_SUBAGENTS', text: '宿主没有可用的子代理服务，派不出文档工。' }
        }
        const todo = selectedIds.length > 0
          ? plan.partitions.filter(partition => selectedIds.includes(partition.id))
          : pendingPartitions(plan, checkpoint)
        if (todo.length === 0) {
          return { kind: 'success', text: '没有待整理的分区（都做过了，或你选的分区不在计划里）。' }
        }
        const stagingDir = join(workspace, '.egm', 'bootstrap-staging', Date.now().toString(36))
        return dispatchBootstrapWorkers({
          subagents,
          parent: agent,
          workspace,
          plan: { ...plan, partitions: todo },
          stagingDir,
          concurrency: Math.min(3, todo.length),
          onEvent: event => {
            try {
              hooks.onEvent?.({ ...event, sessionId })
            } catch {
              // 宠物只是装饰
            }
          },
        }).then(async result => {
          if (!result.ok) return { kind: 'error', code: result.code, text: result.error }
          const okIds = []
          const problems = []
          for (const item of result.results) {
            if (!item.ok) {
              problems.push(`${item.partitionId}：派发失败（${item.code}）${item.error}`)
              continue
            }
            const checked = validateBootstrapOutput({ stagingDir, partitionId: item.partitionId, workspace })
            if (!checked.ok) {
              problems.push(`${item.partitionId}：产物不合格 —— ${checked.problems.join('；')}`)
              continue
            }
            okIds.push(item.partitionId)
          }
          if (task && okIds.length > 0) {
            const completed = Array.from(new Set([...(checkpoint?.completed ?? []), ...okIds]))
            writeBootstrapCheckpoint({
              workspace,
              taskId: task.id,
              checkpoint: { completed, stagingDir, root: plan.root, updatedAt: Date.now() },
            })
          }
          return {
            kind: 'success',
            text: [
              `派了 ${result.results.length} 个文档工（并发上限 ${result.requestedConcurrency}，实际同时最多 ${result.maxActiveObserved} 个）。`,
              `合格分区：${okIds.length > 0 ? okIds.join(' / ') : '（没有）'}`,
              ...(problems.length > 0 ? ['问题：', ...problems.map(item => `- ${item}`)] : []),
              `暂存目录：${stagingDir}`,
              '下一步：/egm-bootstrap commit —— 只写新文件；目标已存在且内容不同就留候选副本，不覆盖。',
              '注意：暂存目录挡不住子代理去改别的文件，落盘前请自己看一眼 diff。',
            ].join('\n'),
            data: { stagingDir, okIds, problems, results: result.results },
          }
        })
      }

      if (sub === 'commit') {
        const stagingDir = checkpoint?.stagingDir
        if (!stagingDir) return { kind: 'error', text: '还没有跑过 /egm-bootstrap run，没有可提交的暂存目录。' }
        const ids = selectedIds.length > 0 ? selectedIds : (checkpoint?.completed ?? [])
        if (ids.length === 0) return { kind: 'error', text: '没有已完成的分区可提交。' }
        const result = commitBootstrap({ workspace, stagingDir, partitionIds: ids })
        if (!result.ok) return { kind: 'error', code: result.code, text: result.error }
        const lines = [`提交结果：新写 ${result.committed.length} 份，跳过 ${result.skipped.length} 份，冲突 ${result.conflicts.length} 份，拒收 ${result.rejected.length} 份。`]
        for (const item of result.committed) lines.push(`- 新写：${item.path}`)
        for (const item of result.conflicts) lines.push(`- 冲突（保留候选）：${item.path} → ${item.candidate}`)
        for (const item of result.rejected) lines.push(`- 拒收：${item.partitionId} —— ${item.problems.join('；')}`)
        lines.push('冲突文件没有覆盖，两份都在；请自己决定留哪份。')
        return { kind: 'success', text: lines.join('\n'), data: result }
      }

      return { kind: 'error', text: '用法：/egm-bootstrap [plan|run|commit] [分区ID,分区ID] [--root <子目录>]' }
    },
  })
}

export function registerEgmConfigCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-config',
    description: '检查项目级评审配置（.egm/config.json），只读，不派发。',
    input: { hint: '[配置名]' },
    handler: invocation => {
      const agent = invocation?.agent
      if (!agent) return { kind: 'error', text: '无法核实当前会话。' }
      const workspace = workspaceOf(agent)
      const summary = describeReviewConfigFor(workspace)
      const lines = []
      if (!summary.ok) {
        lines.push('评审配置有问题，已停止使用：' + summary.error)
        if (summary.field) lines.push('出错字段：' + summary.field)
        lines.push('文件：' + summary.path)
        lines.push('修好之前不会回落到默认配置。')
        return { kind: 'error', code: summary.code || 'E_CONFIG_INVALID', text: lines.join('\n'), data: summary }
      }
      if (summary.present !== true) {
        lines.push('没有找到 .egm/config.json，当前用内置默认角色（' + ROLE_IDS.join(' / ') + '）。')
        lines.push('要自定义角色/标准/材料，可以新建该文件，再运行 /egm-config 检查。')
        return { kind: 'success', text: lines.join('\n'), data: summary }
      }
      lines.push('配置文件：' + summary.path)
      lines.push('配置哈希：' + String(summary.hash || '').slice(0, 12) + '（改文件只影响下一次评审）')
      lines.push('默认配置：' + (summary.defaultProfile || '（未设置，默认用内置）'))
      if (summary.profiles.length === 0) {
        lines.push('文件里还没有任何命名配置。')
        return { kind: 'success', text: lines.join('\n'), data: summary }
      }
      for (const profile of summary.profiles) {
        lines.push(
          '· ' +
            profile.id +
            '（' +
            profile.label +
            '）：角色 ' +
            profile.roles.map((role) => role.id + (role.custom ? '（自定义，标准：仅声明）' : '')).join(' / ') +
            '；并发 ' +
            profile.concurrency +
            '；派发预算 ' +
            profile.budget +
            '；材料 ' +
            profile.materialCount +
            ' 份' +
            (profile.stages.length ? '；阶段 ' + profile.stages.join('/') : ''),
        )
      }
      const requested = String(invocation?.rawInput ?? '').trim()
      if (requested) {
        const resolved = resolveReviewProfileFor(workspace, requested)
        if (!resolved.ok) {
          lines.push('')
          lines.push('配置「' + requested + '」不可用：' + resolved.error)
          return { kind: 'error', code: resolved.code || 'E_PROFILE_INVALID', text: lines.join('\n'), data: summary }
        }
        lines.push('')
        lines.push(
          '配置「' +
            resolved.profile.id +
            '」已通过校验；可派发角色：' +
            resolved.profile.roles.map((role) => role.id + (role.custom ? '（自定义）' : '')).join(' / '),
        )
        if (resolved.profile.materials.length > 0) {
          lines.push('材料：' + resolved.profile.materials.map((m) => m.path + '（' + m.bytes + ' 字节）').join('；'))
        }
        lines.push('自定义角色在配置里声明并通过文件校验后，已支持直接在 egm_dispatch 中派发。')
      }
      return { kind: 'success', text: lines.join('\n'), data: summary }
    },
  })
}

export function registerEgmNewCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-new',
    description: '明确归档旧方案；填写新需求后启动新方案。',
    input: { hint: '[新需求]', attachments: true },
    handler: invocation => {
      const agent = invocation?.agent
      const sessionId = sessionIdOf(agent)
      if (!sessionId) return { kind: 'error', text: '无法核实当前会话。' }
      registerActiveAgent(agent)
      const record = readTaskRecordStatus(sessionId, { includeArchived: true })
      if (record.state === 'corrupt' || record.state === 'unreadable') {
        return {
          kind: 'error',
          code: 'E_TASK_RECORD_UNREADABLE',
          text: '当前方案记录读不出来（这不等于没有方案）。为避免覆盖，没有新建；请先备份或移走 .egm/sessions 下的记录文件。',
        }
      }
      const current = record.state === 'ok' ? record.task : null
      if (current && current.status !== 'archived' && current.status !== 'closed') {
        const archived = applyTaskAction(invocation, hooks, 'new', current.id, String(current.specRevision))
        if (archived.kind !== 'success') return archived
      }
      if (String(invocation?.rawInput ?? '').trim() || invocation?.attachments?.length) return startEgmTask(invocation, hooks)
      return { kind: 'success', text: '请填写新需求，旧方案已保留。' }
    },
  })
}
export function registerEgmOpenCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-open',
    description: '只打开本会话的 egm_dispatch 派发窗口（2 小时 / 最多 20 次），不注入流程、不开启非隔离许可。',
    handler: ({ agent }) => {
      const gate = openGate(agent)
      if (!gate) {
        return {
          kind: 'error',
          text: '无法验证当前会话身份，拒绝打开派发窗口（fail-closed）。请确认命令在会话内执行后重试。',
        }
      }
      hooks.onEvent?.({
        type: 'gate-opened',
        sessionId: sessionIdOf(agent),
        prep: false,
        writing: false,
        gate: { expiresAt: gate.expiresAt, remaining: gate.remaining },
      })
      return {
        kind: 'success',
        text:
          '已打开派发窗口（2 小时 / 最多 20 次）。本命令不启动任何流程、不开启非隔离许可；' +
          '派发前仍需用户输入 /egm-unsafe 确认无隔离。',
        data: { expiresAt: new Date(gate.expiresAt).toISOString(), remaining: gate.remaining },
      }
    },
  })
}

/**
 * 注册 /egm-unsafe：唯一能开启「非隔离评审」的用户动作。
 * 必须输入确认语「确认无隔离」，避免误触；许可 10 分钟、最多 6 次派发。
 * 命令不产生模型消息，模型无法自行发放许可。
 * @param ctx - 已就绪 commands 服务的插件上下文。
 */
export function registerEgmUnsafeCommand(ctx) {
  ctx.commands.register({
    name: 'egm-unsafe',
    description: '允许在无法验证只读隔离的情况下派金鱼（10 分钟 / 最多 6 次）。用法 /egm-unsafe 确认无隔离',
    input: { hint: '确认无隔离' },
    handler: ({ agent, rawInput }) => {
      const confirmation = String(rawInput ?? '').trim()
      if (confirmation !== '确认无隔离') {
        return {
          kind: 'error',
          text: '未开启。只读保护未经验证，评审可能修改文件；若要继续，必须原样输入：/egm-unsafe 确认无隔离',
        }
      }
      const permit = grantUnsafePermit(agent, confirmation)
      if (!permit) {
        return {
          kind: 'error',
          text: '未开启：无法验证当前会话身份，无法把许可绑定到本会话（fail-closed）。请确认命令在会话内执行后重试。',
        }
      }
      return {
        kind: 'success',
        text: [
          '⚠️ 已开启非隔离评审：10 分钟内最多 6 次派发。',
          '这只说明「你明确接受了无法验证只读的风险」，不代表隔离成立：子代理仍可能继承父权限根，平台外层工具可能无法排除。',
          '期间每次结果都会标注 strictGoldfishReview:false，不得当作严格金鱼评审。',
          '要立即关闭，输入 /egm-safe。',
        ].join('\n'),
        data: { expiresAt: new Date(permit.expiresAt).toISOString(), remaining: permit.remaining },
      }
    },
  })
}

/**
 * 注册 /egm-safe：关闭非隔离许可，恢复默认 fail-closed。
 * @param ctx - 已就绪 commands 服务的插件上下文。
 */
export function registerEgmSafeCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-safe',
    description: '关闭非隔离评审许可，恢复默认拒绝派发。',
    handler: ({ agent }) => {
      revokeUnsafePermit(agent)
      closeGate(agent)
      hooks.onEvent?.({ type: 'reset', sessionId: sessionIdOf(agent) })
      return { kind: 'success', text: '已关闭非隔离评审许可与派发窗口；egm_dispatch 恢复默认 fail-closed，需重新输入 /egm 或 /egm-open 才能派发。' }
    },
  })
}

/**
 * 注册 /egm-review-access：统一管理本轮评审权限的用户命令。
 * 用户侧一键开启同时打开派发窗口与非隔离许可；关闭模式撤销许可与窗口。
 * 核心安全边界：
 *   1. 仅通过 commands 接口注册，未注册任何授权 tool，模型无法 tool-call 授权；
 *   2. 授权必须输入确认语「确认无隔离」，防止误触或随意授权；
 *   3. 命令执行不发 followup 消息（不入 LLM，不产生模型消耗），不改写 composer 草稿/附件；
 *   4. 命令机制依赖宿主环境边界，不是形式化密码学硬隔离边界，本插件默认 fail-closed；
 *   5. 关闭许可时发送 access-updated 事件，保持 inflight 任务不被清退。
 *
 * @param ctx - 已就绪 commands 服务的插件上下文。
 * @param hooks - 可选事件钩子。
 */
export function registerEgmReviewAccessCommand(ctx, hooks = {}) {
  ctx.commands.register({
    name: 'egm-review-access',
    description: 'EGM 评审门禁与许可控制。用法：/egm-review-access 确认无隔离、/egm-review-access revoke 或 /egm-review-access notify <grant|deny>',
    input: { hint: '确认无隔离 | revoke | notify <grant|deny>' },
    handler: ({ agent, rawInput }) => {
      let input = String(rawInput ?? '').trim()
      if (input.startsWith('/egm-review-access')) {
        input = input.slice(18).trim()
      }

      const isRevoke = input === 'revoke' || input === 'off' || input === 'close' || input === 'safe'

      if (isRevoke) {
        const sessionId = sessionIdOf(agent)
        if (!sessionId) {
          return {
            kind: 'error',
            text: '无法验证当前会话身份，无法撤销许可。请确认命令在会话内执行后重试。',
          }
        }
        revokeReviewAccess(agent)
        hooks.onEvent?.({
          type: 'access-updated',
          sessionId,
          gate: { open: false, remaining: 0, expiresAt: 0 },
          unsafePermit: { granted: false, remaining: 0, expiresAt: 0, reason: null },
        })
        return {
          kind: 'success',
          text: '已关闭评审许可与派发窗口，恢复默认拒绝派发。正在进行的评审任务不受影响。',
          data: {
            sessionId,
            gate: { open: false, remaining: 0 },
            unsafePermit: { granted: false, remaining: 0 },
          },
        }
      }

      // 内部上下文通知子命令：前端真实 grant/revoke 成功后调用，注入折叠上下文通知模型继续任务
      const isNotify = /^(notify|continue)\b/i.test(input)
      if (isNotify) {
        const subArg = input.replace(/^(notify|continue)\s*/i, '').trim().toLowerCase()
        let isGrant = null
        if (['grant', 'allow', 'yes', 'true', 'ok', 'approved'].includes(subArg)) {
          isGrant = true
        } else if (['deny', 'reject', 'no', 'false', 'cancel', 'revoke'].includes(subArg)) {
          isGrant = false
        } else if (subArg === '') {
          const sid = sessionIdOf(agent) || (typeof agent === 'string' ? agent.trim() : null)
          const snapshot = sid ? getReviewAccessSnapshot(sid) : null
          isGrant = Boolean(snapshot?.allowed)
        } else {
          return {
            kind: 'error',
            code: 'E_INVALID_ARGUMENT',
            text: `未知的通知参数「${subArg}」，用法：/egm-review-access notify grant 或 /egm-review-access notify deny`,
          }
        }

        let targetAgent = (agent && typeof agent === 'object' && typeof agent.steer === 'function') ? agent : null
        const sessionId = sessionIdOf(agent) || (typeof agent === 'string' ? agent.trim() : (agent?.sessionId || agent?.id || null))

        if (!targetAgent && sessionId) {
          const active = getActiveAgent(sessionId)
          if (active && typeof active.steer === 'function') {
            targetAgent = active
          }
        }

        if (!targetAgent) {
          return {
            kind: 'error',
            code: 'E_AGENT_UNRESOLVED',
            text: '无法定位当前活跃会话，内部继续通知未能发送。',
            data: { sessionId, action: isGrant ? 'grant' : 'deny', notified: false },
          }
        }

        const gate = peekGate(targetAgent)
        const permit = peekUnsafePermit(targetAgent)
        const accessMatches = isGrant
          ? Boolean(gate?.remaining > 0 && permit?.remaining > 0)
          : !gate && !permit
        if (!sessionId || !accessMatches) {
          return {
            kind: 'error',
            code: 'E_ACCESS_STATE_MISMATCH',
            text: '当前真实评审许可与通知不一致，未发送继续通知；请查看当前许可状态。',
            data: { sessionId, action: isGrant ? 'grant' : 'deny', notified: false },
          }
        }

        const noticeText = isGrant
          ? '用户已通过 EGM 确认按钮允许本轮金鱼评审（已开启派发窗口与非隔离许可）。请继续沿原方案和既定范围推进评审，无需再次要求授权或复制命令。'
          : '用户已通过 EGM 确认按钮选择暂不评审（本轮评审许可已关闭）。请保留图纸并停止派金鱼，继续处理当前任务的其余部分。'

        const noticeSummary = isGrant
          ? 'EGM 评审许可已更新：允许本轮评审（折叠）'
          : 'EGM 评审许可已更新：暂不评审（折叠）'

        const noticeMessage = createUserMessage({
          content: [{ type: 'text', text: noticeText }],
          source: {
            kind: 'context',
            name: 'egm-review-notice',
            form: 'notice',
            summary: noticeSummary,
          },
        })

        try {
          targetAgent.steer(noticeMessage)
          hooks.onEvent?.({
            type: 'review-notified',
            sessionId,
            action: isGrant ? 'grant' : 'deny',
          })
          return {
            kind: 'success',
            text: isGrant
              ? '已向会话注入允许评审的内部上下文通知（默认折叠）。'
              : '已向会话注入暂不评审的内部上下文通知（默认折叠）。',
            data: {
              sessionId,
              action: isGrant ? 'grant' : 'deny',
              notified: true,
            },
          }
        } catch (error) {
          return {
            kind: 'error',
            code: 'E_NOTIFY_FAILED',
            text: `内部继续通知入队失败：${error?.message ?? String(error)}`,
            data: {
              sessionId,
              action: isGrant ? 'grant' : 'deny',
              notified: false,
            },
          }
        }
      }

      // 授权模式：必须包含或等于「确认无隔离」
      let confirmation = input
      if (confirmation.startsWith('grant ') || confirmation.startsWith('allow ')) {
        confirmation = confirmation.slice(6).trim()
      }
      if (confirmation !== CONFIRMATION_PHRASE) {
        return {
          kind: 'error',
          text: `未开启：只读保护未经验证，评审可能修改文件；若要继续，请在界面点击「允许本轮评审」或原样输入：/egm-review-access ${CONFIRMATION_PHRASE}`,
        }
      }

      // 验证依赖资源
      try {
        assertSkillResources('egm-gate', PKG_ROOT)
      } catch (error) {
        return {
          kind: 'error',
          text: `未开启：缺少必要运行资源，拒绝开启评审门禁：${error?.message ?? String(error)}`,
        }
      }

      const res = grantReviewAccess(agent, confirmation)
      if (!res.ok) {
        return {
          kind: 'error',
          text: res.error ?? '授权失败',
        }
      }

      hooks.onEvent?.({
        type: 'access-updated',
        sessionId: res.sessionId,
        gate: { open: true, expiresAt: res.gate.expiresAt, remaining: res.gate.remaining },
        unsafePermit: { granted: true, expiresAt: res.unsafePermit.expiresAt, remaining: res.unsafePermit.remaining, reason: confirmation },
      })

      return {
        kind: 'success',
        text: [
          '⚠️ 已开启本轮评审访问权限：已同时打开派发窗口（2 小时 / 最多 20 次）与非隔离许可（10 分钟 / 最多 6 次）。',
          '本次评审为非严格隔离评审（标注 strictGoldfishReview:false，只读隔离未被证实）。',
          '可随时在 EGM 界面点击关闭，或执行 /egm-review-access revoke 撤销。',
        ].join('\n'),
        data: {
          sessionId: res.sessionId,
          gate: { expiresAt: new Date(res.gate.expiresAt).toISOString(), remaining: res.gate.remaining },
          unsafePermit: { expiresAt: new Date(res.unsafePermit.expiresAt).toISOString(), remaining: res.unsafePermit.remaining },
        },
      }
    },
  })
}

/**
 * 处理用户在问答/围栏中对评审许可的直接交互响应（“是 / 允许 / 授权 / 开启” 或 “否 / 拒绝 / 暂不 / 取消”）。
 * 跨 session 严格隔离，找不到当前 session 活跃 agent 时拒绝执行（fail-closed）。
 *
 * @param {object|string} target agent 对象或 sessionId 字符串
 * @param {string|object} actionPayload 动作标识或用户回复文本
 * @param {{ onEvent?: Function }} [hooks={}]
 * @returns {{ handled: boolean, granted: boolean, error?: string, sessionId?: string }}
 */
/**
 * 从消息文本中解析专用的 GenUI 评审动作。
 * 必须以 [genui-action] 开头（支持中英文后续提示文本，如 `[genui-action] egm-review-grant。用户刚刚在界面中触发了动作...`），
 * 或直接为纯动作标识。绝不扫描消息中间，绝不接受普通自然语言聊天。
 * @param {string} text
 * @returns {'egm-review-grant'|'egm-review-deny'|null}
 */
export function parseReviewGenUiAction(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. 匹配开头为 [genui-action] <actionName> 伴随标点/空白/换行或结尾
  const prefixMatch = trimmed.match(/^\[genui-action\]\s*([a-zA-Z0-9_-]+)(?:[\s。.\n,，]|$)/i);
  if (prefixMatch) {
    const name = prefixMatch[1].toLowerCase();
    if (name === 'egm-review-grant' || name === 'egm-review-deny') {
      return name;
    }
    return null;
  }

  // 2. 纯动作标识精确匹配（支持对象传入或程序内部调用）
  const lower = trimmed.toLowerCase();
  if (lower === 'egm-review-grant' || lower === 'egm-review-deny') {
    return lower;
  }

  return null;
}

/**
 * 集中处理前端 UI 触发的用户动作（如 [genui-action] egm-review-grant / egm-review-deny）。
 * 仅接受显式专用动作，严禁普通自然语言聊天误授权。
 * 验证目标会话真实主 Agent 后直接调用底层 grant/revoke 函数，并派发 access-updated 事件。
 *
 * @param {object|string} target agent 对象或 sessionId 字符串
 * @param {string|object} actionPayload 动作标识或用户回复文本
 * @param {{ onEvent?: Function }} [hooks={}]
 * @returns {{ handled: boolean, ok: boolean, granted: boolean, error?: string, sessionId?: string }}
 */
export function handleReviewUserAction(target, actionPayload, hooks = {}) {
  const agent = (target && typeof target === 'object' && target.session)
    ? target
    : getActiveAgent(typeof target === 'string' ? target : '');
  const sessionId = sessionIdOf(agent) || (typeof target === 'string' ? target.trim() : null);

  if (!sessionId) {
    return { handled: false, ok: false, granted: false, error: '缺少会话标识，无法确认操作所属会话。' };
  }

  let text = '';
  if (typeof actionPayload === 'string') {
    text = actionPayload;
  } else if (actionPayload && typeof actionPayload === 'object') {
    if (typeof actionPayload.action === 'string') {
      text = actionPayload.action;
    } else if (typeof actionPayload.text === 'string') {
      text = actionPayload.text;
    }
  }

  const action = parseReviewGenUiAction(text);
  if (!action) {
    return { handled: false, ok: false, granted: false, error: '非 EGM 评审专用动作，不予自动授权。' };
  }

  if (!agent) {
    return { handled: true, ok: false, error: 'E_AGENT_UNRESOLVED', granted: false, sessionId };
  }

  if (action === 'egm-review-deny') {
    const res = revokeReviewAccess(agent);
    if (res.ok) {
      hooks.onEvent?.({
        type: 'access-updated',
        sessionId,
        gate: { open: false, remaining: 0 },
        unsafePermit: { granted: false, remaining: 0 },
      });
    }
    return { handled: true, ok: true, action: 'deny', granted: false, sessionId };
  }

  // action === 'egm-review-grant'
  const res = grantReviewAccess(agent, CONFIRMATION_PHRASE);
  if (!res.ok) {
    return { handled: true, ok: false, action: 'grant', granted: false, error: res.error, sessionId };
  }

  hooks.onEvent?.({
    type: 'access-updated',
    sessionId,
    gate: { open: true, remaining: res.gate.remaining, expiresAt: res.gate.expiresAt },
    unsafePermit: { granted: true, remaining: res.unsafePermit.remaining, expiresAt: res.unsafePermit.expiresAt },
  });

  return { handled: true, ok: true, action: 'grant', granted: true, sessionId };
}
