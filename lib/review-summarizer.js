// 阶段内评审独立汇总模块。
//
// 汇总原则：
// 1. 独立汇总：必须启动另一个 provider: 'spawn' 的 fresh 子代理，不是主会话自问自答，更不是简单拼字符串。
// 2. 纯净喂料：输入仅包含本批原始报告、范围与出处，不携带父会话历史对话，防止模型被上下文污染或先入为主。
// 3. 忠实提炼：整理去重、合并相近问题，保留不同角色之间的分歧冲突与少数派意见及其出处；缺失原报告在开头突出警示。
// 4. 结果落盘：父插件负责将 summary 落盘并校验；若 summary 生成或落盘失败，必须明确返回 summaryFailed 并保留原始报告路径，禁止伪造成功。
// 5. 权限与配额：汇总者不是新评审者，不额外扣减金鱼评审次数；但必须在双门开启且有真实报告后才能启动，不能被用作绕过门控的后门。

import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 上游 5 个评审阶段的名称 */
export const STAGE_NAMES = {
  5: '初始 Zoom Out',
  6: '复述测试（Comprehension）',
  7: '敌意评审（Critic）',
  8: '中期 Zoom Out',
  9: '实现就绪测试（Implementation Readiness）',
}

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(LIB_DIR)

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version ?? '0.0.0').replace(/[^0-9A-Za-z-]/g, '-')
  } catch {
    return '0-0-0'
  }
}

const version = await readVersion()

/** 汇总 preset 稳定 id（带插件版本）。 */
export const SUMMARY_PRESET_ID = `egm-review-summarizer-${version}`

/** 汇总人设宪章：输出-only 最小人设，不宣称严格隔离。 */
export const SUMMARY_CHARTER = [
  '你是 EGM 评审汇总者。',
  '',
  '你负责将同一设计文档下多个角色的独立评审报告进行客观、中立的整理汇总。',
  '',
  '工作准则：',
  '1. 忠实汇总：仅基于输入的各角色评审报告，不引入外部假设，不自行对文档进行未提及的额外评审。',
  '2. 整理与去重：合并各角色指出的相同或重叠问题，保留所有相关位置引用（章节、行号、源码路径）。',
  '3. 核验声称与出处：将评审意见声称如实区分已核实（confirmed）、已证伪（disproven）与未核实（unverified）三类并保留出处角色与行号；已证伪项记入审计明细备查，绝不计入关键阻塞项；未核实项标明证据缺口，不自动视为成立，亦不自动当作通过。',
  '4. 保留冲突与少数派意见：不同角色存在分歧或冲突时，必须明确列出争议并标明各方出处角色；单一角色提出的关键风险切勿丢弃。',
  '5. 突出缺失风险与证据透明：若有角色评审失败或缺失，必须在汇总前部醒目位置列出缺失视角与潜在审计盲区；不捏造证据，不承诺模型绝对保证，保持实际覆盖范围与缺失证据透明。',
  '6. 纯文本输出：直接输出结构清晰的 Markdown 汇总报告，不调用任何写入或执行工具。',
  '7. 区分覆盖与结论：报告收齐不代表设计通过；保留未解决项和原报告已有的修正建议，未提供建议就说明未提供。不要替用户接受风险、批准开工或发起下一步选择问卷。',
].join('\n')

let summaryPresetRegistrationError = null

/** 记录 preset 注册错误（供显式报错，不吞掉伪成功）。 */
export function markSummaryPresetRegistrationError(err) {
  summaryPresetRegistrationError = err
}

export function getSummaryPresetRegistrationError() {
  return summaryPresetRegistrationError
}

/** 组装汇总 preset 定义（输出-only 最小 preset）。 */
export function summaryPresetDefinition() {
  return {
    id: SUMMARY_PRESET_ID,
    name: 'EGM 评审独立汇总者',
    description: '用于多角色评审后的客观独立汇总。纯输出预设，不宣称严格隔离。',
    order: 91,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: SUMMARY_CHARTER } },
    ],
  }
}

/**
 * 统一子代理返回为纯文本。
 * 识别失败结构（ok === false / error / status failed / 无输出空对象），按空文本返回，
 * 绝不能序列化成成功 summary。
 */
export function textOf(result) {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map(textOf).filter(Boolean).join('\n')
  if (typeof result === 'object') {
    // 识别失败结构与无输出空对象
    if (result.ok === false) return ''
    if (result.status === 'failed' || result.status === 'error') return ''
    if (result.error && !result.output && !result.text && !result.content && !result.message) return ''

    for (const key of ['output', 'text', 'content', 'message', 'response', 'finalText', 'deliverable']) {
      if (result[key] !== undefined) return textOf(result[key])
    }
    // 无任何有效输出字段的普通对象（如 {} 或纯错误元数据），不序列化为成功内容
    return ''
  }
  return String(result)
}

/**
 * 带超时等待子代理执行结果；超时抛出带 code 的 E_TIMEOUT。
 */
export async function awaitResult(started, timeoutMs) {
  let timer
  try {
    const targetPromise = typeof started?.wait === 'function' ? started.wait() : started.result
    return await Promise.race([
      targetPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`汇总代理 ${Math.round(timeoutMs / 1000)} 秒未完成，已超时`)
          error.code = 'E_TIMEOUT'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 构建汇总子代理的专用 prompt。
 * 严格限制输入：仅本批原始报告、范围与出处，不传父聊天。
 */
export function buildSummaryPrompt({ docPath, stage, mode, successful = [], failed = [], missing = [], range = null }) {
  const lines = [
    '你是 EGM 评审汇总者。请对以下同一设计文档的各角色独立评审报告进行客观汇总。',
    '',
    `文档路径：${docPath}`,
    `评审模式：${mode === 'brainstorm' ? 'BRAINSTORM' : 'REVIEW'}`,
  ]
  if (stage) {
    lines.push(`评审阶段：Stage ${stage}（${STAGE_NAMES[stage] ?? '未知阶段'}）`)
  }
  if (range) {
    lines.push(`审核区间：第 ${range.start}–${range.end} 行`)
  }
  lines.push('')

  if (failed.length > 0 || missing.length > 0) {
    lines.push('【⚠️ 警示：以下角色评审未完成或报告缺失】')
    for (const f of failed) {
      lines.push(`- 角色「${f.role}」：评审失败（${f.error ?? f.code ?? '未知错误'}）`)
    }
    for (const m of missing) {
      lines.push(`- 角色「${m.role}」：报告缺失`)
    }
    lines.push('请在汇总开头明确指出上述视角缺失及其可能导致的设计盲区。', '')
  }

  lines.push(`【共收到 ${successful.length} 份独立评审报告】`, '')

  for (const item of successful) {
    const roleRange = item.range ? `（区间：第 ${item.range.start}–${item.range.end} 行）` : ''
    lines.push(`### 角色：${item.role}${item.label ? `（${item.label}）` : ''}${roleRange ? ` ${roleRange}` : ''}`)
    if (item.range) {
      lines.push(`评审行号区间：第 ${item.range.start}–${item.range.end} 行`)
    }
    lines.push(`原始报告路径：${item.reportPath ?? '未落盘'}`)
    lines.push('报告正文：')
    lines.push('```markdown')
    lines.push(item.report || '（空报告）')
    lines.push('```', '')
  }

  lines.push(
    '汇总任务要求：',
    '1. 整理去重：将各角色指出的相同或实质相近问题归并，整合相关位置引用（章节、行号、源码）。',
    '2. 区分核验状态与出处：对照输入报告和源码引用，将缺陷声称区分为已核实（confirmed）、已证伪（disproven）与未核实（unverified）三类，并保留角色出处；已证伪项列入审计明细供核查，不得列为关键阻塞；未核实项标明证据缺口，不自动视为成立，亦不自动当作通过。',
    '3. 保留冲突与少数派意见：若不同角色对同一设计点意见相左，必须明确列出分歧并指明角色出处；单独立场的重要缺陷切勿略去。',
    '4. 突出缺失风险与证据透明：若有缺失视角，在汇总开头醒目列出；严禁凭空捏造证据，不得宣称模型绝对保证，保持覆盖与缺口透明。',
    '5. 严禁自行发挥：仅对报告中已有事实进行汇总归纳，不要捏造原报告中没有的问题。',
    '6. 输出格式：直接输出结构清晰的 Markdown 汇总，先给覆盖与结论，再列具体发现、证据、分歧和原报告已有的修正建议。',
    '7. 不代用户决策：报告收齐不等于设计通过；建议缺失时说明缺失，不编造解决方案，不替用户接受风险或批准开工，不输出让用户选择下一步的问卷。',
  )

  return lines.join('\n')
}

/**
 * 启动独立的 fresh 汇总子代理并落盘。
 *
 * @param {object} options
 * @param {object} options.subagents - 子代理服务
 * @param {object} options.parent - 父会话 agent
 * @param {string} options.docPath - 文档路径
 * @param {number|string} [options.stage] - 阶段
 * @param {string} [options.mode] - review | brainstorm
 * @param {Array} options.successful - 成功报告列表
 * @param {Array} options.failed - 失败任务列表
 * @param {Array} options.missing - 缺失报告列表
 * @param {string} options.summaryDir - 汇总落盘目录
 * @param {object} [options.range] - 行号范围
 * @param {object} [options.io] - 文件操作注入
 * @param {number} [options.timeoutMs] - 超时毫秒数
 * @returns {Promise<{ summary: string|null, summaryPath: string|null, summaryFailed: boolean, summaryError?: string, skipped?: boolean, reason?: string }>}
 */
export async function summarizeReviews(options = {}) {
  const {
    subagents,
    parent,
    docPath,
    stage,
    mode = 'review',
    successful = [],
    failed = [],
    missing = [],
    summaryDir,
    range = null,
    io = { readFile, writeFile, stat },
    timeoutMs = 120_000,
  } = options

  if (successful.length === 0) {
    return {
      summary: null,
      summaryPath: null,
      summaryFailed: false,
      skipped: true,
      reason: '无可用评审报告，跳过汇总',
    }
  }

  if (summaryPresetRegistrationError) {
    return {
      summary: null,
      summaryPath: null,
      summaryFailed: true,
      summaryError: `汇总 preset 注册失败：${summaryPresetRegistrationError?.message ?? String(summaryPresetRegistrationError)}`,
    }
  }

  if (!subagents?.startActivation) {
    return {
      summary: null,
      summaryPath: null,
      summaryFailed: true,
      summaryError: '子代理服务不可用，无法启动独立汇总代理',
    }
  }

  const prompt = buildSummaryPrompt({ docPath, stage, mode, successful, failed, missing, range })

  const abortController = new AbortController()
  let started
  try {
    started = await subagents.startActivation({
      provider: 'spawn',
      label: 'egm-review-summarizer',
      request: {
        parent,
        prompt: [{ type: 'text', text: prompt }],
        agentPreset: SUMMARY_PRESET_ID,
        cwd: summaryDir,
      },
      delivery: 'caller',
      signal: abortController.signal,
    })
  } catch (error) {
    return {
      summary: null,
      summaryPath: null,
      summaryFailed: true,
      summaryError: `启动汇总子代理失败：${error?.message ?? String(error)}`,
    }
  }

  let summary = ''
  let timedOut = false
  try {
    const rawResult = await awaitResult(started, timeoutMs)
    if (rawResult && typeof rawResult === 'object') {
      if (rawResult.ok === false) {
        return {
          summary: null,
          summaryPath: null,
          summaryFailed: true,
          summaryError: rawResult.error || '汇总子代理返回失败状态',
        }
      }
      if (rawResult.status === 'failed' || rawResult.status === 'error') {
        return {
          summary: null,
          summaryPath: null,
          summaryFailed: true,
          summaryError: rawResult.error || `汇总子代理状态异常：${rawResult.status}`,
        }
      }
      if (rawResult.error && !rawResult.output && !rawResult.text && !rawResult.content && !rawResult.message) {
        return {
          summary: null,
          summaryPath: null,
          summaryFailed: true,
          summaryError: typeof rawResult.error === 'string' ? rawResult.error : JSON.stringify(rawResult.error),
        }
      }
    }
    summary = textOf(rawResult)
  } catch (error) {
    timedOut = error?.code === 'E_TIMEOUT'
    return {
      summary: null,
      summaryPath: null,
      summaryFailed: true,
      summaryError: timedOut ? '汇总生成超时' : (error?.message ?? String(error)),
    }
  } finally {
    if (timedOut) {
      try {
        abortController.abort()
      } catch {}
      for (const method of ['terminate', 'abort', 'cancel']) {
        try {
          if (typeof started?.[method] === 'function') await started[method]()
        } catch {}
      }
    }
    try {
      if (typeof started?.dispose === 'function') await started.dispose()
    } catch {}
  }

  if (typeof summary !== 'string' || summary.trim() === '') {
    return {
      summary: null,
      summaryPath: null,
      summaryFailed: true,
      summaryError: '汇总子代理返回空报告',
    }
  }

  const summaryPath = join(summaryDir, 'summary.md')
  try {
    await io.writeFile(summaryPath, summary, 'utf8')
    const written = await io.stat(summaryPath)
    const expected = Buffer.byteLength(summary, 'utf8')
    if (!written.isFile() || written.size !== expected) {
      return {
        summary,
        summaryPath,
        summaryFailed: true,
        summaryError: `汇总写入后校验失败：期望 ${expected} 字节，实际 ${written.isFile() ? written.size : '非文件'} 字节`,
      }
    }
  } catch (error) {
    return {
      summary,
      summaryPath,
      summaryFailed: true,
      summaryError: `汇总落盘失败：${error?.message ?? String(error)}`,
    }
  }

  return {
    summary,
    summaryPath,
    summaryFailed: false,
  }
}
