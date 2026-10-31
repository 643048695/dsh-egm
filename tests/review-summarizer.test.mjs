// tests/review-summarizer.test.mjs
// 独立汇总模块单元测试：
// 覆盖汇总人设 preset、prompt 构建（严格纯净无父聊天、突出缺失角色）、
// 子代理调用与结果归一化、超时释放、落盘校验、无报告跳过与失败诚实报告。

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SUMMARY_CHARTER,
  SUMMARY_PRESET_ID,
  awaitResult,
  buildSummaryPrompt,
  getSummaryPresetRegistrationError,
  markSummaryPresetRegistrationError,
  summarizeReviews,
  summaryPresetDefinition,
  textOf,
} from '../lib/review-summarizer.js'

/** 构造临时测试目录 */
async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'egm-summary-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 构造受控 mock 子代理服务 */
function mockSubagents({
  response = '### 综合汇总报告\n1. 统一结论：通过\n2. 少数意见：注意内存占用',
  mode = 'ok',
  delayMs = 0,
} = {}) {
  const calls = []
  const lifecycle = { disposed: 0, terminated: 0 }

  const subagents = {
    calls,
    lifecycle,
    async startActivation(spec) {
      calls.push(spec)
      if (mode === 'throw-start') {
        throw new Error('startActivation failed')
      }
      return {
        childId: `summary-child-${calls.length}`,
        result: (async () => {
          if (mode === 'throw-result') throw new Error('subagent execution failed')
          if (mode === 'hang') return new Promise(() => {})
          if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
          return response
        })(),
        async terminate() {
          lifecycle.terminated += 1
        },
        async dispose() {
          lifecycle.disposed += 1
        },
      }
    },
  }
  return subagents
}

test('summaryPresetDefinition 组装最小输出-only 预设', () => {
  const def = summaryPresetDefinition()
  assert.equal(def.id, SUMMARY_PRESET_ID)
  assert.match(def.id, /^egm-review-summarizer-/)
  assert.equal(def.order, 91)
  assert.equal(typeof def.name, 'string')
  assert.equal(def.plugins.length, 1)
  assert.equal(def.plugins[0].id, 'persona')
  assert.equal(def.plugins[0].config.prefix, SUMMARY_CHARTER)
  assert.match(SUMMARY_CHARTER, /你是 EGM 评审汇总者/)
  assert.match(SUMMARY_CHARTER, /忠实汇总/)
  assert.match(SUMMARY_CHARTER, /保留冲突与少数派意见/)
  assert.match(SUMMARY_CHARTER, /突出缺失风险/)
})

test('textOf 兼容各种子代理返回形态', () => {
  assert.equal(textOf(null), '')
  assert.equal(textOf(undefined), '')
  assert.equal(textOf('plain string'), 'plain string')
  assert.equal(textOf(['line 1', 'line 2']), 'line 1\nline 2')
  assert.equal(textOf({ output: 'from output' }), 'from output')
  assert.equal(textOf({ text: 'from text' }), 'from text')
  assert.equal(textOf({ content: 'from content' }), 'from content')
  assert.equal(textOf({ message: 'from message' }), 'from message')
})

test('buildSummaryPrompt 严格只含评审报告、不带父聊天，且突出缺失角色', () => {
  const prompt = buildSummaryPrompt({
    docPath: '.egm/design.md',
    stage: '7',
    mode: 'review',
    range: { start: 10, end: 50 },
    successful: [
      {
        role: 'design_critic',
        label: '敌意设计评审',
        reportPath: '.egm/review-1/report-design_critic.md',
        report: '严重 | 缺少缓存降级策略',
      },
    ],
    failed: [
      {
        role: 'structural',
        code: 'E_TIMEOUT',
        error: '执行超时',
      },
    ],
    missing: [
      {
        role: 'style',
      },
    ],
  })

  // 必须包含元数据与成功报告
  assert.match(prompt, /文档路径：\.egm\/design\.md/)
  assert.match(prompt, /评审阶段：Stage 7/)
  assert.match(prompt, /审核区间：第 10–50 行/)
  assert.match(prompt, /### 角色：design_critic（敌意设计评审）/)
  assert.match(prompt, /缺少缓存降级策略/)
  assert.match(prompt, /\.egm\/review-1\/report-design_critic\.md/)

  // 必须突出警示缺失与失败角色
  assert.match(prompt, /⚠️ 警示：以下角色评审未完成或报告缺失/)
  assert.match(prompt, /角色「structural」：评审失败（执行超时）/)
  assert.match(prompt, /角色「style」：报告缺失/)
  assert.match(prompt, /明确指出上述视角缺失及其可能导致的设计盲区/)

  // 确认不包含任何父聊天标记或口头语
  assert.doesNotMatch(prompt, /UserMessage/)
  assert.doesNotMatch(prompt, /parent/)
  assert.doesNotMatch(prompt, /followup/)
})

test('summarizeReviews: 无成功报告时安全跳过，不启动子代理', async (t) => {
  const subagents = mockSubagents()
  const result = await summarizeReviews({
    subagents,
    parent: { session: { id: 's-1' } },
    docPath: '.egm/design.md',
    successful: [],
    failed: [{ role: 'logic', error: 'failed' }],
  })

  assert.equal(result.skipped, true)
  assert.equal(result.summary, null)
  assert.equal(result.summaryPath, null)
  assert.equal(result.summaryFailed, false)
  assert.equal(subagents.calls.length, 0, '无报告时绝不派发子代理')
})

test('summarizeReviews: 子代理服务缺失时返回明确错误，不伪造成功', async (t) => {
  const result = await summarizeReviews({
    subagents: null,
    parent: { session: { id: 's-1' } },
    docPath: '.egm/design.md',
    successful: [{ role: 'logic', report: 'ok', reportPath: 'p1' }],
  })
  assert.equal(result.summaryFailed, true)
  assert.match(result.summaryError, /子代理服务不可用/)
  assert.equal(result.summary, null)
})

test('summarizeReviews: 正常汇总流程，落盘校验并回收 dispose', async (t) => {
  const summaryDir = await makeTempDir(t)
  const subagents = mockSubagents({
    response: '### 汇总意见\n各角色无分歧，整体通过。',
  })

  const result = await summarizeReviews({
    subagents,
    parent: { session: { id: 's-normal' } },
    docPath: '.egm/design.md',
    stage: '7',
    summaryDir,
    successful: [
      { role: 'design_critic', report: '问题A', reportPath: join(summaryDir, 'rep1.md') },
      { role: 'structural', report: '问题B', reportPath: join(summaryDir, 'rep2.md') },
    ],
  })

  assert.equal(result.summaryFailed, false)
  assert.equal(result.summary, '### 汇总意见\n各角色无分歧，整体通过。')
  assert.equal(result.summaryPath, join(summaryDir, 'summary.md'))

  // 检查磁盘真实文件
  const diskContent = await readFile(result.summaryPath, 'utf8')
  assert.equal(diskContent, result.summary)

  // 检查子代理配置：provider 必须为 spawn，独立预设，无父聊天
  assert.equal(subagents.calls.length, 1)
  assert.equal(subagents.calls[0].provider, 'spawn')
  assert.equal(subagents.calls[0].request.agentPreset, SUMMARY_PRESET_ID)
  assert.equal(subagents.calls[0].request.cwd, summaryDir)

  // 检查生命周期释放
  assert.equal(subagents.lifecycle.disposed, 1, '子代理必须被 dispose 回收')
})

test('summarizeReviews: 空报告判定失败，不冒充通过', async (t) => {
  const summaryDir = await makeTempDir(t)
  const subagents = mockSubagents({ response: '   \n  ' })

  const result = await summarizeReviews({
    subagents,
    parent: { session: { id: 's-empty' } },
    docPath: '.egm/design.md',
    summaryDir,
    successful: [{ role: 'logic', report: 'ok', reportPath: 'p1' }],
  })

  assert.equal(result.summaryFailed, true)
  assert.match(result.summaryError, /空报告/)
  assert.equal(subagents.lifecycle.disposed, 1)
})

test('summarizeReviews: 超时处理，触发 terminate 与 dispose，返回 summaryFailed', async (t) => {
  const summaryDir = await makeTempDir(t)
  const subagents = mockSubagents({ mode: 'hang' })

  const result = await summarizeReviews({
    subagents,
    parent: { session: { id: 's-hang' } },
    docPath: '.egm/design.md',
    summaryDir,
    timeoutMs: 30, // 30ms 快速超时
    successful: [{ role: 'logic', report: 'ok', reportPath: 'p1' }],
  })

  assert.equal(result.summaryFailed, true)
  assert.match(result.summaryError, /超时/)
  assert.equal(subagents.lifecycle.terminated, 1, '超时必须尝试 terminate')
  assert.equal(subagents.lifecycle.disposed, 1, '超时必须调用 dispose 回收资源')
})

test('summarizeReviews: preset 注册失败时显式报告，不伪造成功', async (t) => {
  const summaryDir = await makeTempDir(t)
  const subagents = mockSubagents()

  markSummaryPresetRegistrationError(new Error('preset conflict with host'))
  try {
    const result = await summarizeReviews({
      subagents,
      parent: { session: { id: 's-preset-err' } },
      docPath: '.egm/design.md',
      summaryDir,
      successful: [{ role: 'logic', report: 'ok', reportPath: 'p1' }],
    })
    assert.equal(result.summaryFailed, true)
    assert.match(result.summaryError, /preset 注册失败/)
    assert.match(result.summaryError, /preset conflict with host/)
  } finally {
    markSummaryPresetRegistrationError(null)
  }
})

test('summarizeReviews: textOf 与汇总识别错误结构与空对象为失败，不序列化成 summary', async (t) => {
  const summaryDir = await makeTempDir(t)

  // 1. textOf 纯函数核对
  const errorObj = { ok: false, error: 'Quota exceeded' }
  assert.equal(textOf(errorObj), '', 'textOf 绝不将 error 对象序列化为成功正文')
  assert.equal(textOf({ status: 'failed' }), '', 'status: failed 判定为空')
  assert.equal(textOf({}), '', '空对象判定为空')

  // 2. summarizeReviews 返回 errorObj 时标记 summaryFailed
  const subagents = {
    async startActivation() {
      return {
        childId: 'child-err',
        result: Promise.resolve(errorObj),
        async dispose() {},
      }
    },
  }

  const result = await summarizeReviews({
    subagents,
    parent: { session: { id: 's-err-obj' } },
    docPath: '.egm/design.md',
    summaryDir,
    successful: [{ role: 'logic', report: 'ok', reportPath: 'p1' }],
  })
  assert.equal(result.summaryFailed, true, '子代理返回错误对象时必须标记失败')
  assert.equal(result.summary, null)
  assert.match(result.summaryError, /Quota exceeded/)
})

test('summarizeReviews: 超时后 AbortController.signal 必须被 abort()', async (t) => {
  const summaryDir = await makeTempDir(t)
  let receivedSignal = null

  const subagents = {
    async startActivation(spec) {
      receivedSignal = spec.signal
      return {
        childId: 'child-timeout-sig',
        result: new Promise(() => {}),
        async terminate() {},
        async dispose() {},
      }
    },
  }

  const result = await summarizeReviews({
    subagents,
    parent: { session: { id: 's-timeout-sig' } },
    docPath: '.egm/design.md',
    summaryDir,
    successful: [{ role: 'logic', report: 'ok', reportPath: 'p1' }],
    timeoutMs: 30,
  })

  assert.equal(result.summaryFailed, true)
  assert.ok(receivedSignal, '子代理必须接收到 signal')
  assert.equal(receivedSignal.aborted, true, '超时后 signal 必须已被 controller.abort()')
})
