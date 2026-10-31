import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { peekGate, peekUnsafePermit } from '../lib/dispatch.js'

/** 测试用临时工作区，避免把任务记录写进仓库目录。 */
let workspaceRoot = ''

before(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), 'egm-entry-test-'))
})

after(async () => {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true })
})

/** 用假 ctx 启动插件，收集命令定义、工具名与宿主事件订阅。 */
function boot() {
  const commands = new Map()
  const tools = []
  const listeners = []
  const services = {
    commands: { register: (definition) => commands.set(definition.name, definition) },
    tools: { register: (definition) => tools.push(definition.name) },
    subagents: {},
    agentPresets: { register: () => {} },
  }
  const child = { get: (name) => services[name], ...services }
  const ctx = {
    skills: { registerProvider: (provider) => assert.equal(typeof provider, 'function') },
    on: (name, callback) => {
      assert.equal(typeof callback, 'function')
      listeners.push({ name, callback })
      return () => {
        const index = listeners.findIndex((item) => item.name === name && item.callback === callback)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    inject: (_dependencies, callback) => callback(child),
  }
  apply(ctx)
  return { commands, tools, listeners }
}

/**
 * 0.10 起 /egm 通过 agent.steer 单次投递开场消息（不再走两次 followup）。
 * 假 agent 同时记录 steer 与 followup 两个通道。
 */
function fakeAgent(id) {
  const followups = []
  const steers = []
  return {
    session: { header: { id, cwd: workspaceRoot } },
    followups,
    steers,
    followup(payload) {
      followups.push(payload)
    },
    steer(payload) {
      steers.push(payload)
    },
  }
}

test('plugin registers the user commands and the dispatch tool', () => {
  const { commands, tools } = boot()
  assert.deepEqual([...commands.keys()].sort(), [
    'egm',
    'egm-action',
    'egm-artifact',
    'egm-bootstrap',
    'egm-config',
    'egm-findings',
    'egm-handoff',
    'egm-new',
    'egm-open',
    'egm-restore',
    'egm-review-access',
    'egm-run',
    'egm-safe',
    'egm-unsafe',
  ])
  assert.equal(commands.get('egm').input?.attachments, true, '/egm 声明 input.attachments: true')
  assert.deepEqual(tools, ['egm_dispatch', 'egm_dispatch_batch'])
})

test('plugin subscribes to the real elephant host signals without adding RPCs', () => {
  const { listeners } = boot()
  const names = listeners.map((item) => item.name)
  for (const required of ['agent/created', 'agent/status', 'agent/disposed', 'session/event']) {
    assert.ok(names.includes(required), `应订阅 ${required}`)
  }
})

test('/egm-open 只开窗口：不发消息、不开启非隔离许可', () => {
  const { commands } = boot()
  const agent = fakeAgent('entry-open')
  const result = commands.get('egm-open').handler({ agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /不启动任何流程/)
  assert.equal(agent.followups.length, 0, '/egm-open 不得注入任何流程消息')
  assert.equal(agent.steers.length, 0, '/egm-open 不得注入任何流程消息')
  assert.notEqual(peekGate(agent), null)
  assert.equal(peekUnsafePermit(agent), null, '/egm-open 不得私自开启 unsafe')

  const anonymous = { session: {} }
  const rejected = commands.get('egm-open').handler({ agent: anonymous, rawInput: '' })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /无法验证当前会话身份|无法核实当前会话/)
})

test('/egm 首次启动：要求输入，经 steer 单次投递 kickoff 消息', () => {
  const { commands } = boot()
  const agent = fakeAgent('entry-legacy')
  const empty = commands.get('egm').handler({ agent, rawInput: '  ' })
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /请先填写需求或附上图片/)

  const ok = commands.get('egm').handler({ agent, rawInput: '做个工具' })
  assert.equal(ok.kind, 'success')
  assert.equal(ok.data?.isContinuation, false)
  assert.match(ok.text, /大象已开始梳理当前方案/)
  assert.equal(agent.steers.length, 1, '开场经 steer 单次投递')
  assert.equal(agent.followups.length, 0, '不再走 followup 通道')
  const delivered = agent.steers[0]
  assert.deepEqual(delivered.source, {
    kind: 'context',
    name: 'egm-kickoff-procedure',
    form: 'notice',
    summary: 'EGM 需求：做个工具',
  })
  assert.match(delivered.content[0].text, /EGM 守门已启动/)
  assert.match(delivered.content[0].text, /现在还没有派出金鱼/)
  assert.match(delivered.content[0].text, /无法证实金鱼运行环境是只读隔离的/)
  assert.equal(peekUnsafePermit(agent), null, '开场不得自动授予非隔离派发许可')
  assert.notEqual(peekGate(agent), null)
})

test('/egm 原生输入框支持图片附件与纯图片启动', () => {
  const { commands } = boot()
  const agent = fakeAgent('entry-attachments')
  const imgBlock = { type: 'image', attachment: 'ref-test-entry' }
  const res = commands.get('egm').handler({
    agent,
    rawInput: '',
    attachments: [imgBlock],
  })
  assert.equal(res.kind, 'success')
  assert.equal(res.data?.isContinuation, false)
  assert.equal(agent.steers.length, 1)
  const delivered = agent.steers[0]
  assert.equal(delivered.role, 'user')
  assert.equal(typeof delivered.id, 'string')
  assert.deepEqual(delivered.content[0], imgBlock)
  assert.match(delivered.content[1].text, /按附带的图片进行需求梳理与设计/)
  assert.notEqual(peekGate(agent), null)
})

test('/egm 处理投递异常：如实提示、窗口保持开启，不声称未发送', () => {
  const { commands } = boot()

  // 宿主在 steer 内仍可能抛错；插件无法判断消息是否已送达，只能如实提示
  const agentError = fakeAgent('entry-post-commit')
  agentError.steer = () => {
    throw new Error('driver crashed')
  }
  const resError = commands.get('egm').handler({
    agent: agentError,
    rawInput: '优化',
    attachments: [{ type: 'image', attachment: 'ref-q' }],
  })
  assert.equal(resError.kind, 'error')
  assert.match(resError.text, /driver crashed/)
  assert.match(resError.text, /任务记录或消息可能已经提交/)
  assert.doesNotMatch(resError.text, /未入队|没有发送|附件已保留/)
  assert.notEqual(peekGate(agentError), null, '无法确认送达状态时保持窗口开启')
})
