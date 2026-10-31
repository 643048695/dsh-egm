import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { peekGate, peekUnsafePermit } from '../lib/dispatch.js'

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

function fakeAgent(id) {
  const followups = []
  return {
    session: { header: { id, cwd: process.cwd() } },
    followups,
    followup(payload) {
      followups.push(payload)
    },
  }
}

test('plugin registers the user commands and the dispatch tool', () => {
  const { commands, tools } = boot()
  assert.deepEqual([...commands.keys()].sort(), ['egm', 'egm-open', 'egm-review-access', 'egm-safe', 'egm-unsafe'])
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

test('/egm-open 只开窗口：不发 followup、不开启非隔离许可', () => {
  const { commands } = boot()
  const agent = fakeAgent('entry-open')
  const result = commands.get('egm-open').handler({ agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /不启动任何流程/)
  assert.equal(agent.followups.length, 0, '/egm-open 不得注入任何流程消息')
  assert.notEqual(peekGate(agent), null)
  assert.equal(peekUnsafePermit(agent), null, '/egm-open 不得私自开启 unsafe')

  const anonymous = { session: {} }
  const rejected = commands.get('egm-open').handler({ agent: anonymous, rawInput: '' })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /无法验证当前会话身份/)
})

test('/egm 原行为保留：仍要求输入，并注入 kickoff 消息', () => {
  const { commands } = boot()
  const agent = fakeAgent('entry-legacy')
  const empty = commands.get('egm').handler({ agent, rawInput: '  ' })
  assert.equal(empty.kind, 'error')

  const ok = commands.get('egm').handler({ agent, rawInput: '做个工具' })
  assert.equal(ok.kind, 'success')
  assert.equal(agent.followups.length, 2)
  assert.deepEqual(agent.followups[0].source, {
    kind: 'context',
    name: 'egm-kickoff-procedure',
    form: 'notice',
    summary: 'EGM 守门规程与操作指引（折叠）',
  })
  assert.match(agent.followups[1].content[0].text, /EGM 守门已启动/)
  assert.match(agent.followups[1].content[0].text, /现在还没有派出金鱼/)
  assert.match(agent.followups[1].content[0].text, /无法证实金鱼运行环境是只读隔离的/)
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
  assert.equal(agent.followups.length, 2)
  assert.deepEqual(agent.followups[0].source, {
    kind: 'context',
    name: 'egm-kickoff-procedure',
    form: 'notice',
    summary: 'EGM 守门规程与操作指引（折叠）',
  })
  assert.equal(agent.followups[1].role, 'user')
  assert.equal(typeof agent.followups[1].id, 'string')
  assert.deepEqual(agent.followups[1].content[0], imgBlock)
  assert.match(agent.followups[1].content[1].text, /按附带的图片进行需求梳理与设计/)
  assert.notEqual(peekGate(agent), null)
})

test('/egm 处理提交后异常：如实提示、窗口保持开启，不声称未发送', () => {
  const { commands } = boot()

  // 宿主在「消息入队」之后仍可能抛错；插件无法判断是否已入队，只能如实提示
  const agentError = fakeAgent('entry-post-commit')
  agentError.followup = () => {
    throw new Error('driver crashed')
  }
  const resError = commands.get('egm').handler({
    agent: agentError,
    rawInput: '优化',
    attachments: [{ type: 'image', attachment: 'ref-q' }],
  })
  assert.equal(resError.kind, 'error')
  assert.match(resError.text, /driver crashed/)
  assert.match(resError.text, /无法确认这条需求是否已经进入会话队列/)
  assert.doesNotMatch(resError.text, /未入队|没有发送|附件已保留/)
  assert.notEqual(peekGate(agentError), null, '无法确认入队状态时保持窗口开启')
})
