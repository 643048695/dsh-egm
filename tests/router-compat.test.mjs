import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GOLDFISH_ID } from '../lib/goldfish.js'
import { SUMMARY_PRESET_ID } from '../lib/review-summarizer.js'

// 定位本机真实安装的 dsh-subagent-router 2.3.0 插件
const userProfile = process.env.USERPROFILE || process.env.HOME || ''
const routerEntryPath = join(
  userProfile,
  '.dsh',
  'profiles',
  'desktop',
  'plugins',
  'dsh-subagent-router',
  'lib',
  'index.js',
)

const hasInstalledRouter = existsSync(routerEntryPath)

/**
 * 构造轻量 Cordis 宿主 stub，用于挂载真实 router 的 apply()。
 * 仅模拟 Cordis 生命周期与 subagents 基础对象，不包含虚假业务实现。
 */
function createHostHarness(routerModule, config) {
  const cleanups = []
  const capturedSpawns = []

  const rawSubagents = {
    startActivation(spec) {
      capturedSpawns.push({ kind: 'startActivation', spec })
      return { id: 'stub-child-receipt', spec }
    },
    startContinuable(spec) {
      capturedSpawns.push({ kind: 'startContinuable', spec })
      return { id: 'stub-child-continuable', spec }
    },
    start(childId, request) {
      capturedSpawns.push({ kind: 'start', childId, request })
      return Promise.resolve({ id: childId, request })
    },
  }

  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: () => () => {},
    effect(fn) {
      const off = fn()
      if (typeof off === 'function') cleanups.push(off)
    },
    inject(names, fn) {
      if (names.includes('subagents')) {
        fn({
          logger: ctx.logger,
          on: ctx.on,
          effect: ctx.effect,
          subagents: rawSubagents,
        })
      }
    },
  }

  routerModule.apply(ctx, config)

  return {
    subagents: rawSubagents,
    capturedSpawns,
    dispose() {
      for (const cleanup of cleanups.reverse()) cleanup()
    },
  }
}

test('dsh-subagent-router 真实 wrapper 离线契约测试', async (t) => {
  if (!hasInstalledRouter) {
    t.skip(`未在预期位置找到本机 router 插件: ${routerEntryPath}`)
    return
  }

  // 直接动态 import 本机真实模块，严禁使用改写的镜像假实现
  const routerModule = await import(pathToFileURL(routerEntryPath).href)

  const mockParent = { session: { header: { id: 'parent-session-1' } } }
  const mockSignal = new AbortController().signal

  await t.test('分支一：缺省默认路由分支（exemptRules 为空时透传所有参数并注入默认路由）', () => {
    const harness = createHostHarness(routerModule, {
      roleMode: true,
      exploreModels: [{ provider: 'router-test-p', model: 'router-test-m' }],
      patchModels: [{ provider: 'router-patch-p', model: 'router-patch-m' }],
      exemptRules: [],
    })

    try {
      // 1. 金鱼 Spec
      const goldfishSpec = {
        provider: 'spawn',
        label: 'egm-goldfish-logic',
        request: {
          parent: mockParent,
          prompt: [{ type: 'text', text: '审查此图纸逻辑' }],
          agentPreset: GOLDFISH_ID,
          cwd: 'C:/fake/.egm/review-test-1',
        },
        delivery: 'caller',
        signal: mockSignal,
      }

      harness.subagents.startActivation(goldfishSpec)
      assert.equal(harness.capturedSpawns.length, 1)
      const passedGoldfish = harness.capturedSpawns[0].spec

      // 验证全部 8 项关键契约字段透传
      assert.equal(passedGoldfish.provider, 'spawn', 'provider 必须保持 spawn')
      assert.equal(passedGoldfish.label, 'egm-goldfish-logic', 'label 必须完整保留')
      assert.equal(passedGoldfish.delivery, 'caller', 'delivery 必须完整保留')
      assert.equal(passedGoldfish.signal, mockSignal, 'signal 必须完整保留')
      assert.equal(passedGoldfish.request.parent, mockParent, 'request.parent 必须完整保留')
      assert.deepEqual(passedGoldfish.request.prompt, goldfishSpec.request.prompt, 'request.prompt 必须完整保留')
      assert.equal(passedGoldfish.request.agentPreset, GOLDFISH_ID, 'request.agentPreset 必须完整保留')
      assert.equal(passedGoldfish.request.cwd, 'C:/fake/.egm/review-test-1', 'request.cwd 必须完整保留')

      // 验证未豁免时注入默认角色池模型
      assert.ok(passedGoldfish.request.agentOptions?.model, '未豁免时应有 router 分配的模型')

      // 2. 汇总者 Spec
      const summarizerSpec = {
        provider: 'spawn',
        label: 'egm-review-summarizer',
        request: {
          parent: mockParent,
          prompt: [{ type: 'text', text: '汇总多角色评审报告' }],
          agentPreset: SUMMARY_PRESET_ID,
          cwd: 'C:/fake/.egm/stage-5-summary',
        },
        delivery: 'caller',
        signal: mockSignal,
      }

      harness.subagents.startActivation(summarizerSpec)
      assert.equal(harness.capturedSpawns.length, 2)
      const passedSummarizer = harness.capturedSpawns[1].spec

      // 验证全部 8 项关键契约字段透传
      assert.equal(passedSummarizer.provider, 'spawn', 'provider 必须保持 spawn')
      assert.equal(passedSummarizer.label, 'egm-review-summarizer', 'label 必须完整保留')
      assert.equal(passedSummarizer.delivery, 'caller', 'delivery 必须完整保留')
      assert.equal(passedSummarizer.signal, mockSignal, 'signal 必须完整保留')
      assert.equal(passedSummarizer.request.parent, mockParent, 'request.parent 必须完整保留')
      assert.deepEqual(passedSummarizer.request.prompt, summarizerSpec.request.prompt, 'request.prompt 必须完整保留')
      assert.equal(passedSummarizer.request.agentPreset, SUMMARY_PRESET_ID, 'request.agentPreset 必须完整保留')
      assert.equal(passedSummarizer.request.cwd, 'C:/fake/.egm/stage-5-summary', 'request.cwd 必须完整保留')
      assert.ok(passedSummarizer.request.agentOptions?.model, '未豁免时应有 router 分配的模型')
    } finally {
      harness.dispose()
    }
  })

  await t.test('分支二：用户前缀豁免规则分支（无 pinned 模型时完全不碰 agentOptions）', () => {
    const harness = createHostHarness(routerModule, {
      roleMode: true,
      exploreModels: [{ provider: 'router-test-p', model: 'router-test-m' }],
      exemptRules: [
        {
          name: 'EGM 全套豁免',
          match: 'label',
          pattern: 'egm-',
          provider: '',
          model: '',
          effort: '',
        },
      ],
    })

    try {
      // 1. 金鱼（命中 egm- 前缀）
      harness.subagents.startActivation({
        provider: 'spawn',
        label: 'egm-goldfish-feasibility',
        request: {
          parent: mockParent,
          prompt: [{ type: 'text', text: '审查可行性' }],
          agentPreset: GOLDFISH_ID,
          cwd: 'C:/fake/.egm/review-test-2',
        },
        delivery: 'caller',
        signal: mockSignal,
      })

      const passedGoldfish = harness.capturedSpawns[0].spec
      assert.equal(passedGoldfish.provider, 'spawn')
      assert.equal(passedGoldfish.label, 'egm-goldfish-feasibility')
      assert.equal(passedGoldfish.request.agentPreset, GOLDFISH_ID)
      assert.equal(passedGoldfish.request.cwd, 'C:/fake/.egm/review-test-2')
      assert.equal(passedGoldfish.request.agentOptions, undefined, '豁免无固定模型时 agentOptions 必须保持 undefined')

      // 2. 汇总者（命中 egm- 前缀）
      harness.subagents.startActivation({
        provider: 'spawn',
        label: 'egm-review-summarizer',
        request: {
          parent: mockParent,
          prompt: [{ type: 'text', text: '汇总报告' }],
          agentPreset: SUMMARY_PRESET_ID,
          cwd: 'C:/fake/.egm/stage-7-summary',
        },
        delivery: 'caller',
        signal: mockSignal,
      })

      const passedSummarizer = harness.capturedSpawns[1].spec
      assert.equal(passedSummarizer.provider, 'spawn')
      assert.equal(passedSummarizer.label, 'egm-review-summarizer')
      assert.equal(passedSummarizer.request.agentPreset, SUMMARY_PRESET_ID)
      assert.equal(passedSummarizer.request.cwd, 'C:/fake/.egm/stage-7-summary')
      assert.equal(passedSummarizer.request.agentOptions, undefined, '豁免无固定模型时 agentOptions 必须保持 undefined')
    } finally {
      harness.dispose()
    }
  })

  await t.test('分支三：用户前缀豁免规则带 pinned 模型分支', () => {
    const harness = createHostHarness(routerModule, {
      roleMode: true,
      exemptRules: [
        {
          name: 'EGM 专用审查模型',
          match: 'label',
          pattern: 'egm-',
          provider: 'pinned-provider',
          model: 'pinned-model',
          effort: 'high',
        },
      ],
    })

    try {
      harness.subagents.startActivation({
        provider: 'spawn',
        label: 'egm-goldfish-style',
        request: {
          parent: mockParent,
          prompt: [{ type: 'text', text: '审查风格' }],
          agentPreset: GOLDFISH_ID,
          cwd: 'C:/fake/.egm/review-test-3',
        },
        delivery: 'caller',
        signal: mockSignal,
      })

      const passed = harness.capturedSpawns[0].spec
      assert.equal(passed.provider, 'spawn')
      assert.deepEqual(passed.request.agentOptions, {
        provider: 'pinned-provider',
        model: 'pinned-model',
        reasoningEffort: 'high',
      })
    } finally {
      harness.dispose()
    }
  })
})
