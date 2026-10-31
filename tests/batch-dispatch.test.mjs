// tests/batch-dispatch.test.mjs
// 阶段内批量评审与独立汇总自动化测试：
// 覆盖受控 fake 子代理、并发峰值控制与测量、等待全部评审 terminal 后汇总、
// 单鱼失败与汇总失败（保留 raw artifacts 并显式 partial）、
// 授权/额度不足整批拒绝且不启动首条任务、fresh 汇总 prompt 绝无父聊天、
// 共享不可变设计快照与逐角色最少材料、生命周期 dispose 回收。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BATCH_TOOL_NAME,
  DEFAULT_CONCURRENCY,
  MAX_BATCH_TASKS,
  MAX_CONCURRENCY,
  dispatchBatch,
  registerBatchDispatchTool,
} from '../lib/batch-dispatch.js'
import {
  closeGate,
  grantUnsafePermit,
  openGate,
  peekGate,
  peekUnsafePermit,
  revokeUnsafePermit,
  takeGate,
  takeUnsafePermit,
} from '../lib/dispatch.js'
import { SUMMARY_PRESET_ID } from '../lib/review-summarizer.js'

const AGENT_ROLES = [
  'logic',
  'feasibility',
  'cold',
  'design_critic',
  'structural',
  'style',
  'zoom_out',
  'comprehension',
  'implementation_readiness',
  'codebase_details',
]

const STANDARD_FILES = [
  'feature-spec-standard.md',
  'zoom-out-standard.md',
  're-implementation-standard.md',
  'implementation-readiness-standard.md',
]

/** 构造包含必要角色卡与标准的临时工作区 */
async function makeWorkspace(t, { design = '# 核心图纸设计\n\n初始版本内容\n' } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'egm-batch-test-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const vendorRoot = join(work, 'vendor', 'egm')
  const agentsDir = join(vendorRoot, 'agents')
  const standardsDir = join(vendorRoot, 'resources', 'document_standards')

  await mkdir(join(work, '.egm'), { recursive: true })
  await mkdir(agentsDir, { recursive: true })
  await mkdir(standardsDir, { recursive: true })
  await mkdir(join(work, 'src'), { recursive: true })
  await mkdir(join(work, 'materials'), { recursive: true })

  // 写入角色卡与标准文件
  for (const role of AGENT_ROLES) {
    await writeFile(join(agentsDir, `${role}.md`), `# ${role}\n\n### IF Mode: REVIEW\n\nreview body\n`, 'utf8')
  }
  for (const file of STANDARD_FILES) {
    await writeFile(join(standardsDir, file), `# ${file}\n\nstandard standard\n`, 'utf8')
  }

  const docPath = '.egm/design.md'
  await writeFile(join(work, docPath), design, 'utf8')
  await writeFile(join(work, 'src', 'a.js'), '// source a\nexport const a = 1\n', 'utf8')
  await writeFile(join(work, 'materials', 'spec.md'), '# 补充材料\n', 'utf8')

  return { work, vendorRoot, docPath, rooms: join(work, '.egm') }
}

/** 构造带受控时序与生命周期统计的 fake 子代理 */
function createFakeSubagents(options = {}) {
  const {
    delayMs = 0,
    delaysByRole = {},
    failuresByRole = {},
    summaryDelayMs = 0,
    summaryMode = 'ok',
    summaryResponse = '### 独立汇总\n综合所有意见完成去重。',
  } = options

  const calls = []
  const events = [] // 记录时序事件：{ type: 'start'|'end', label, time }
  let currentActive = 0
  let maxActive = 0
  const lifecycle = { disposed: 0, terminated: 0 }

  const subagents = {
    calls,
    events,
    lifecycle,
    get maxActive() {
      return maxActive
    },
    async startActivation(spec) {
      calls.push(spec)
      const label = spec.label || 'unknown'
      const isSummary = label.includes('summar') || spec.request?.agentPreset === SUMMARY_PRESET_ID

      currentActive += 1
      if (currentActive > maxActive) {
        maxActive = currentActive
      }
      events.push({ type: 'start', label, time: Date.now() })

      const handle = {
        childId: `child-${calls.length}`,
        result: (async () => {
          try {
            if (isSummary) {
              if (summaryMode === 'throw') throw new Error('汇总代理启动崩溃')
              if (summaryDelayMs > 0) await new Promise((r) => setTimeout(r, summaryDelayMs))
              if (summaryMode === 'empty') return '   \n  '
              return summaryResponse
            }

            // 金鱼评审
            const role = spec.request?.agentPreset ? label.replace('egm-goldfish-', '') : 'unknown'
            if (failuresByRole[role]) {
              throw new Error(`角色 ${role} 评审异常失败`)
            }
            const taskDelay = delaysByRole[role] ?? delayMs
            if (taskDelay > 0) {
              await new Promise((r) => setTimeout(r, taskDelay))
            }
            return `### 评审报告 [${role}]\n- 严重 | design.md:1 | 发现缺陷`
          } finally {
            currentActive -= 1
            events.push({ type: 'end', label, time: Date.now() })
          }
        })(),
        async terminate() {
          lifecycle.terminated += 1
        },
        async dispose() {
          lifecycle.disposed += 1
        },
      }
      return handle
    },
  }

  return subagents
}

/** 构造带上下文与会话 ID 的父会话 Agent */
function createFakeParent(id = 'test-batch-session', cwd = process.cwd()) {
  return {
    session: {
      header: { id, cwd },
      id,
    },
    chatHistory: ['用户说：请帮我评审设计', '大象说：好，准备派发金鱼'],
  }
}

test('batch: 证明并发峰值 > 1 且不超限 (concurrency=2)', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-concurrent', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents({ delayMs: 40 })

  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      concurrency: 2,
      tasks: [
        { role: 'design_critic' },
        { role: 'structural' },
        { role: 'style' },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.manifest.total, 3)
  assert.equal(result.manifest.successfulCount, 3)
  assert.equal(result.manifest.failedCount, 0)
  assert.equal(result.manifest.allPassed, true)

  // 证明并发峰值 > 1 且 <= 限制 2
  assert.ok(subagents.maxActive > 1, `并发峰值 ${subagents.maxActive} 必须 > 1`)
  assert.ok(subagents.maxActive <= 2, `并发峰值 ${subagents.maxActive} 不能超过设定的限制 2`)
  assert.equal(result.manifest.concurrencyPeak, subagents.maxActive)
})

test('batch: 汇总必须等待所有金鱼评审 terminal 后才启动', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-terminal-wait', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  // 设置阶梯式延时，确保金鱼先后完成
  const subagents = createFakeSubagents({
    delaysByRole: {
      design_critic: 20,
      structural: 60,
    },
    summaryDelayMs: 10,
  })

  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [
        { role: 'design_critic' },
        { role: 'structural' },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.manifest.allPassed, true)

  // 核对时序事件：汇总的 start 必须晚于所有 goldfish 的 end
  const events = subagents.events
  const goldfishEnds = events.filter((e) => e.type === 'end' && e.label.startsWith('egm-goldfish-'))
  const summaryStart = events.find((e) => e.type === 'start' && e.label.includes('summar'))

  assert.ok(summaryStart, '汇总必须被启动')
  assert.equal(goldfishEnds.length, 2, '两只金鱼都必须已结束')
  for (const end of goldfishEnds) {
    assert.ok(
      summaryStart.time >= end.time,
      `汇总启动时间 (${summaryStart.time}) 必须晚于或等于金鱼完成时间 (${end.time})`,
    )
  }
})

test('batch: 单鱼失败不抹掉其他结果，manifest 显式 partial，raw artifacts 保留', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-single-fail', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  // 让 structural 失败，其他成功
  const subagents = createFakeSubagents({
    failuresByRole: {
      structural: true,
    },
  })

  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [
        { role: 'design_critic' },
        { role: 'structural' },
        { role: 'style' },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.manifest.total, 3)
  assert.equal(result.manifest.successfulCount, 2)
  assert.equal(result.manifest.failedCount, 1)
  assert.equal(result.manifest.partial, true, '部分失败必须标为 partial')
  assert.equal(result.manifest.allPassed, false, '有失败项绝不能标为 allPassed')

  // 成功项包含原始报告与落盘路径
  assert.equal(result.successful.length, 2)
  const successfulRoles = result.successful.map((s) => s.role)
  assert.ok(successfulRoles.includes('design_critic'))
  assert.ok(successfulRoles.includes('style'))

  for (const succ of result.successful) {
    const reportOnDisk = await readFile(succ.reportPath, 'utf8')
    assert.match(reportOnDisk, /评审报告/)
  }

  // 失败项明确记录错误
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].role, 'structural')
  assert.match(result.failed[0].error, /评审异常失败/)

  // 汇总仍正常运行，且 prompt 会包含 structural 的警示
  assert.equal(result.summaryFailed, false)
  assert.ok(result.summaryPath)
  const summaryOnDisk = await readFile(result.summaryPath, 'utf8')
  assert.match(summaryOnDisk, /独立汇总/)
})

test('batch: 汇总失败时不伪造成功，仍返回所有原始报告路径与 summaryFailed', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-summary-fail', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents({
    summaryMode: 'throw',
  })

  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [
        { role: 'design_critic' },
        { role: 'style' },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.summaryFailed, true, '汇总失败必须如实反映')
  assert.match(result.summaryError, /汇总代理启动崩溃/)
  assert.equal(result.summary, null)
  assert.equal(result.summaryPath, null)

  // 原始金鱼报告仍然完整返回
  assert.equal(result.successful.length, 2)
  for (const succ of result.successful) {
    assert.ok(succ.reportPath)
    const reportContent = await readFile(succ.reportPath, 'utf8')
    assert.match(reportContent, /评审报告/)
  }
})

test('batch: 门控或许可不足首条前整批拒绝，不启动任何任务且不消耗配额', async (t) => {
  const ws = await makeWorkspace(t)
  const subagents = createFakeSubagents()

  // 1. 无 gate
  const agentNoGate = createFakeParent('session-no-gate', ws.work)
  grantUnsafePermit(agentNoGate, '确认无隔离')
  const resNoGate = await dispatchBatch({
    subagents,
    parent: agentNoGate,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: { docPath: ws.docPath, tasks: [{ role: 'logic' }] },
  })
  assert.equal(resNoGate.ok, false)
  assert.equal(resNoGate.code, 'E_GATE_NOT_OPEN')
  assert.equal(subagents.calls.length, 0, '未开窗时不得派发任何子代理')

  // 2. 无 permit
  const agentNoPermit = createFakeParent('session-no-permit', ws.work)
  openGate(agentNoPermit)
  const resNoPermit = await dispatchBatch({
    subagents,
    parent: agentNoPermit,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: { docPath: ws.docPath, tasks: [{ role: 'logic' }] },
  })
  assert.equal(resNoPermit.ok, false)
  assert.equal(resNoPermit.code, 'E_READONLY_UNVERIFIED')
  assert.equal(subagents.calls.length, 0, '无许可时不得派发任何子代理')

  // 3. gate 剩余次数不足以执行整批任务（需要 3 次，只剩 2 次）
  const agentShortGate = createFakeParent('session-short-gate', ws.work)
  openGate(agentShortGate)
  grantUnsafePermit(agentShortGate, '确认无隔离')
  // GATE_MAX_DISPATCHES = 20，消耗 18 次后剩 2 次
  for (let i = 0; i < 18; i += 1) takeGate(agentShortGate)

  const resShortGate = await dispatchBatch({
    subagents,
    parent: agentShortGate,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      tasks: [{ role: 'logic' }, { role: 'feasibility' }, { role: 'cold' }],
    },
  })
  assert.equal(resShortGate.ok, false)
  assert.equal(resShortGate.code, 'E_GATE_INSUFFICIENT')
  assert.match(resShortGate.error, /需要 3 次，当前仅剩 2 次/)
  assert.equal(subagents.calls.length, 0, '额度不足时整批拒绝，不得启动首条')
  assert.equal(peekGate(agentShortGate).remaining, 2, '拒绝时不扣减配额')

  // 4. permit 剩余次数不足以执行整批任务（需要 2 次，只剩 1 次）
  const agentShortPermit = createFakeParent('session-short-permit', ws.work)
  openGate(agentShortPermit)
  grantUnsafePermit(agentShortPermit, '确认无隔离')
  // UNSAFE_PERMIT_USES = 6，消耗 5 次后剩 1 次
  for (let i = 0; i < 5; i += 1) takeUnsafePermit(agentShortPermit)

  const resShortPermit = await dispatchBatch({
    subagents,
    parent: agentShortPermit,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      tasks: [{ role: 'logic' }, { role: 'feasibility' }],
    },
  })
  assert.equal(resShortPermit.ok, false)
  assert.equal(resShortPermit.code, 'E_PERMIT_INSUFFICIENT')
  assert.match(resShortPermit.error, /需要 2 次，当前仅剩 1 次/)
  assert.equal(subagents.calls.length, 0, '许可不足时整批拒绝，不得启动首条')
  assert.equal(peekUnsafePermit(agentShortPermit).remaining, 1, '拒绝时不扣减许可')
})

test('batch: fresh 汇总 prompt 绝无父聊天记录，输入纯净', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-pure-prompt', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents()

  await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [{ role: 'design_critic' }],
    },
  })

  // 查找汇总子代理调用的 prompt
  const summaryCall = subagents.calls.find(
    (c) => c.label.includes('summary') || c.request?.agentPreset === SUMMARY_PRESET_ID,
  )
  assert.ok(summaryCall, '汇总子代理必须被调用')
  const promptText = summaryCall.request.prompt[0].text

  // 严格校验不包含父会话历史
  assert.doesNotMatch(promptText, /用户说：请帮我评审设计/)
  assert.doesNotMatch(promptText, /大象说：好，准备派发金鱼/)
  assert.doesNotMatch(promptText, /chatHistory/)
  assert.match(promptText, /你是 EGM 评审汇总者/)
  assert.match(promptText, /design_critic/)
})

test('batch: 共享不可变设计快照，并行中原文档被改动不影响评审与逐角色材料隔离', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-snapshot-test', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  // 在任务执行延时期间，恶意修改工作区内的原 design.md
  let tampered = false
  const subagents = createFakeSubagents({
    delayMs: 30,
  })

  // 启动后台篡改计时器
  const tamperTimer = setTimeout(async () => {
    try {
      await writeFile(join(ws.work, ws.docPath), '# 被恶意篡改的图纸！\n\n新修订\n', 'utf8')
      tampered = true
    } catch {}
  }, 10)
  t.after(() => clearTimeout(tamperTimer))

  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '9',
      tasks: [
        { role: 'codebase_details', sources: ['src/a.js'] },
        { role: 'implementation_readiness', materials: ['materials/spec.md'] },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.manifest.allPassed, true)

  // 验证快照文件的内容仍然是初始内容，未被篡改
  assert.ok(result.snapshot?.path)
  const snapshotContent = await readFile(result.snapshot.path, 'utf8')
  assert.match(snapshotContent, /核心图纸设计/)
  assert.doesNotMatch(snapshotContent, /被恶意篡改的图纸/)

  // 校验各角色的独立房间：codebase_details 有 sources.json，implementation_readiness 有 materials
  const cbTask = result.successful.find((s) => s.role === 'codebase_details')
  const irTask = result.successful.find((s) => s.role === 'implementation_readiness')
  assert.notEqual(cbTask.scratch, irTask.scratch, '各角色必须在独立房间内运行')

  const cbSourcesManifest = await readFile(join(cbTask.scratch, 'sources.json'), 'utf8')
  assert.match(cbSourcesManifest, /src\/a\.js/)

  const irMaterials = await stat(join(irTask.scratch, 'materials'))
  assert.ok(irMaterials.isDirectory(), '材料必须被拷贝进独立房间')
})

test('batch: 生命周期 dispose 释放每个子代理（金鱼与汇总）', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-lifecycle', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents()

  await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [
        { role: 'design_critic' },
        { role: 'style' },
      ],
    },
  })

  // 2 只金鱼 + 1 个汇总 = 3 个激活
  assert.equal(subagents.calls.length, 3)
  assert.equal(subagents.lifecycle.disposed, 3, '所有子代理必须全部被 dispose 回收')
})

test('batch: hooks.onEvent 上报符合契约且 id 唯一', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-events', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents()
  const recordedEvents = []

  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    onEvent: (type, data) => {
      recordedEvents.push({ type, data })
    },
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [
        { role: 'design_critic' },
        { role: 'style' },
      ],
    },
  })

  assert.equal(result.ok, true)
  const startEvents = recordedEvents.filter((e) => e.type === 'dispatch-start')
  const doneEvents = recordedEvents.filter((e) => e.type === 'dispatch-done')

  assert.equal(startEvents.length, 2)
  assert.equal(doneEvents.length, 2)

  // 校验每只金鱼的 id 唯一性
  const ids = startEvents.map((e) => e.data.id)
  assert.equal(new Set(ids).size, 2, '每条金鱼必须拥有唯一的 id')

  for (const done of doneEvents) {
    assert.ok(ids.includes(done.data.id), 'done 事件 id 必须匹配 start 事件 id')
    assert.ok(done.data.reportPath, 'done 事件必须携带 reportPath')
  }
})

test('batch: registerBatchDispatchTool 工具注册、参数校验与渲染', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-tool-reg', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const registeredTools = new Map()
  const fakeCtx = {
    tools: {
      register: (tool) => registeredTools.set(tool.name, tool),
    },
    get: (service) => {
      if (service === 'subagents') return createFakeSubagents()
      return null
    },
  }

  registerBatchDispatchTool(fakeCtx)
  assert.ok(registeredTools.has(BATCH_TOOL_NAME))
  const tool = registeredTools.get(BATCH_TOOL_NAME)

  assert.deepEqual(tool.parameters.required, ['docPath', 'tasks'])

  // 执行工具
  const toolResult = await tool.execute(
    {
      docPath: ws.docPath,
      stage: '7',
      tasks: [{ role: 'design_critic' }],
    },
    { agent },
  )

  assert.equal(toolResult.ok, true)

  // 测试 render 函数
  const rendered = tool.output.render({}, toolResult)
  assert.ok(Array.isArray(rendered))
  assert.match(rendered[0].text, /非隔离评审/)
  assert.match(rendered[0].text, /EGM 阶段内多角色评审独立汇总/)
  assert.match(rendered[0].text, /批量评审执行清单/)
  assert.match(rendered[0].text, /design_critic.*完成/)
  assert.ok(!rendered[0].text.includes('全部通过'), '文案绝不能写全部通过，避免误导用户认为无缺陷')
  assert.match(rendered[0].text, /全部报告完成（仍需阅读发现并裁决）/)
})

test('batch: 快照前校验原图，工作区外路径直接拒绝且不生成快照', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-outside-doc', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents()
  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: '../outside-secret.md',
      stage: '7',
      tasks: [{ role: 'design_critic' }],
    },
  })

  assert.equal(result.ok, false)
  assert.match(result.code, /^E_DOC_/)
  assert.equal(result.snapshot, undefined, '工作区外文档绝不创建快照')
  assert.equal(subagents.calls.length, 0, '被拒绝时不启动任何子代理')
})

test('batch: tasks 内自定义 goldfishId 重复时整批拒绝并返回 E_TASK_INVALID', async (t) => {
  const ws = await makeWorkspace(t)
  const agent = createFakeParent('session-dup-gid', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents()
  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [
        { role: 'design_critic', goldfishId: 'same-goldfish-id' },
        { role: 'style', goldfishId: 'same-goldfish-id' },
      ],
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_TASK_INVALID')
  assert.match(result.error, /重复/)
  assert.equal(subagents.calls.length, 0, '重复 ID 不启动任何任务')
})

test('batch: per-task range 保留在 successful 且在汇总 prompt 中逐角色标注', async (t) => {
  const ws = await makeWorkspace(t, {
    design: Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n',
  })
  const agent = createFakeParent('session-role-ranges', ws.work)
  openGate(agent)
  grantUnsafePermit(agent, '确认无隔离')

  const subagents = createFakeSubagents()

  const result = await dispatchBatch({
    subagents,
    parent: agent,
    baseCwd: ws.work,
    vendorRoot: ws.vendorRoot,
    roomsRoot: ws.rooms,
    args: {
      docPath: ws.docPath,
      stage: '7',
      tasks: [
        { role: 'design_critic', range: { start: 1, end: 5 } },
        { role: 'style', range: { start: 6, end: 10 } },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.successful.length, 2)
  assert.deepEqual(result.successful[0].range, { start: 1, end: 5 })
  assert.deepEqual(result.successful[1].range, { start: 6, end: 10 })

  const summaryCall = subagents.calls.find(
    (c) => c.label?.includes('summar') || c.request?.agentPreset === SUMMARY_PRESET_ID,
  )
  assert.ok(summaryCall, '汇总子代理必须被调用')
  const promptText = summaryCall.request.prompt[0].text
  assert.ok(promptText.includes('1–5'), '汇总 prompt 包含角色 1 区间')
  assert.ok(promptText.includes('6–10'), '汇总 prompt 包含角色 2 区间')
})
