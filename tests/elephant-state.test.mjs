// 大象真实状态桥测试：只用假宿主事件，不联网、不启动 DSH。
//
// 这里验证的是「哪些宿主信号能变成大象状态、哪些不能」：
//   - agent/status 是真实的 running/idle；
//   - skill 加载 / 用户点名技能 / egm_dispatch 调用是真实 EGM 活动；
//   - 绝不因为开窗、超时或助理文案推断 writing；
//   - 子会话、别的会话、已 dispose 的旧 Agent 都不能污染当前会话。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createPetStore } from '../lib/pet-state.js'
import {
  EGM_SKILL_NAMES,
  attachElephantTracker,
  egmSkillName,
  isMainSession,
  sessionIdOfSession,
  signalOfSessionEvent,
} from '../lib/elephant-state.js'

function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

function makeSession(id, extra = {}) {
  return { id, header: { id, ...extra } }
}

function makeAgent(id, status = 'idle', extra = {}) {
  const session = makeSession(id, extra)
  return { id, session, status }
}

/** 假 Cordis ctx：按事件名保存监听器，并记录 disposer。 */
function makeCtx() {
  const handlers = new Map()
  const disposed = []
  return {
    handlers,
    disposed,
    ctx: {
      on(name, handler) {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
        return () => {
          const current = handlers.get(name) ?? []
          const index = current.indexOf(handler)
          if (index >= 0) current.splice(index, 1)
          disposed.push(name)
        }
      },
    },
  }
}

function fire(host, name, ...args) {
  for (const handler of host.handlers.get(name) ?? []) handler(...args)
}

function attach(options = {}) {
  const host = makeCtx()
  const store = createPetStore(options)
  const bridge = attachElephantTracker(host.ctx, store, options)
  return { host, store, bridge }
}

test('attach 订阅四个真实宿主事件，并把桥标成可用', () => {
  const { host, bridge } = attach()
  assert.deepEqual(
    [...host.handlers.keys()].sort(),
    ['agent/created', 'agent/disposed', 'agent/status', 'session/event'],
  )
  assert.equal(bridge.attached, true)
  assert.equal(bridge.agentLifecycle, true)
  assert.equal(bridge.agentStatus, true)
  assert.equal(bridge.sessionEvents, true)
})

test('agent/created 只种下真实 idle；没有 EGM 信号时顶层仍是 idle', () => {
  const { host, store } = attach()
  const agent = makeAgent('s1', 'idle')
  fire(host, 'agent/created', { agent, source: 'startup' })

  const pet = store.read('s1')
  assert.equal(pet.elephant.status, 'idle')
  assert.equal(pet.elephant.known, true)
  assert.equal(pet.elephant.source, 'agent/created')
  assert.equal(pet.elephant.working, false)
  assert.equal(pet.elephant.egm.active, false)
  assert.equal(pet.state, 'idle')
})

test('agent/status 真实 running/idle 进入快照；迟到的旧状态被拒绝', () => {
  const c = clock()
  const { host, store } = attach({ now: c.now })
  const agent = makeAgent('s1', 'idle')
  fire(host, 'agent/created', { agent, source: 'startup' })

  agent.status = 'running'
  fire(host, 'agent/status', { agent, status: 'running' })
  let pet = store.read('s1')
  assert.equal(pet.elephant.status, 'running')
  assert.equal(pet.elephant.working, true)
  assert.equal(pet.elephant.workingOnEgm, false, '还没见过 EGM 信号，不能声称在 EGM 上工作')
  assert.equal(pet.state, 'idle', '主 Agent 在跑不等于 EGM 已进入写图纸')

  // 模拟一个迟到的 running 事件：宿主当前已经是 idle，旧事件不能复活 running。
  agent.status = 'idle'
  fire(host, 'agent/status', { agent, status: 'idle' })
  fire(host, 'agent/status', { agent, status: 'running' })
  pet = store.read('s1')
  assert.equal(pet.elephant.status, 'idle')
  assert.equal(pet.elephant.working, false)
})

test('skill 工具加载 EGM 技能：等真实 result 成功后才记活动，绝不写成 writing', () => {
  const c = clock()
  const { host, store } = attach({ now: c.now })
  const agent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })

  const session = agent.session
  fire(host, 'session/event', session, { type: 'turn/start', seq: 9, data: { turn: 1 } })
  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 10,
    data: { turn: 1, callId: 'call-1', name: 'skill', arguments: JSON.stringify({ name: 'egm-gate' }) },
  })
  assert.equal(store.read('s1').elephant.egm.active, false, '只有 tool/call 请求时还不能说技能已加载')

  fire(host, 'session/event', session, {
    type: 'tool/result',
    seq: 11,
    data: {
      turn: 1,
      message: {
        toolCallId: 'call-1',
        isError: false,
        source: { kind: 'tool', callId: 'call-1' },
      },
    },
  })

  const pet = store.read('s1')
  assert.equal(pet.state, 'prep')
  assert.notEqual(pet.state, 'writing', '没有技能工作开始/结束事件时不许伪造 writing')
  assert.equal(pet.elephant.egm.active, true)
  assert.equal(pet.elephant.egm.signal, 'skill-loaded')
  assert.equal(pet.elephant.egm.skill, 'egm-gate')
  assert.equal(pet.elephant.workingOnEgm, true)
})

test('skill 调用失败或没有 result 时不算加载：错误结果不点亮 EGM', () => {
  const { host, store } = attach()
  const agent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })
  const session = agent.session

  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 1,
    data: { callId: 'call-bad', name: 'skill', arguments: JSON.stringify({ name: 'egm-gate' }) },
  })
  fire(host, 'session/event', session, {
    type: 'tool/result',
    seq: 2,
    data: {
      message: {
        toolCallId: 'call-bad',
        isError: true,
        source: { kind: 'tool', callId: 'call-bad' },
      },
    },
  })
  assert.equal(store.read('s1').elephant.egm.active, false)

  // 另一个请求没有 result，step/end 后也不能被当成已加载。
  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 3,
    data: { callId: 'call-never', name: 'skill', arguments: JSON.stringify({ name: 'egm-review' }) },
  })
  fire(host, 'session/event', session, { type: 'step/end', seq: 4, data: {} })
  assert.equal(store.read('s1').elephant.egm.active, false)
})

test('非 EGM 技能、坏 JSON、非技能工具都不产生 EGM 信号', () => {
  const { host, store } = attach()
  const agent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })
  const session = agent.session

  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 1,
    data: { callId: 'call-1', name: 'skill', arguments: JSON.stringify({ name: 'find-skills' }) },
  })
  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 2,
    data: { callId: 'call-2', name: 'skill', arguments: '{' },
  })
  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 3,
    data: { callId: 'call-3', name: 'ops_bash', arguments: '{}' },
  })

  const pet = store.read('s1')
  assert.equal(pet.elephant.egm.active, false)
  assert.equal(pet.state, 'idle')
})

test('用户点名 egm-classic-review：user/message 的 skill-invocation 是真实信号', () => {
  const { host, store } = attach()
  const agent = makeAgent('s1', 'idle')
  fire(host, 'agent/created', { agent, source: 'startup' })

  fire(host, 'session/event', agent.session, {
    type: 'user/message',
    seq: 7,
    data: { source: { kind: 'skill-invocation', name: 'egm-classic-review' } },
  })

  const pet = store.read('s1')
  assert.equal(pet.elephant.egm.active, true)
  assert.equal(pet.elephant.egm.signal, 'skill-invoked')
  assert.equal(pet.elephant.egm.skill, 'egm-classic-review')
  assert.equal(pet.state, 'prep')
})

test('egm_dispatch 工具调用只记为 EGM 活动；真正派发仍由 dispatch-start 决定', () => {
  const { host, store } = attach()
  const agent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })

  fire(host, 'session/event', agent.session, {
    type: 'tool/call',
    seq: 11,
    data: { name: 'egm_dispatch', arguments: '{}' },
  })
  let pet = store.read('s1')
  assert.equal(pet.elephant.egm.signal, 'dispatch-called')
  assert.equal(pet.state, 'prep', '仅调用工具不代表金鱼已经在跑')
  assert.equal(pet.goldfish.length, 0)

  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  pet = store.read('s1')
  assert.equal(pet.state, 'dispatch')
  assert.equal(pet.elephant.egm.signal, 'dispatch-start')
  assert.equal(pet.goldfish[0].status, 'running')
})

test('egm_dispatch_batch 在当前主会话只记录准备活动，不虚报金鱼已运行', () => {
  const { host, store } = attach()
  const agent = makeAgent('batch-current', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })
  fire(host, 'session/event', agent.session, {
    type: 'tool/call',
    seq: 12,
    data: { name: 'egm_dispatch_batch', arguments: '{"tasks":[{"role":"logic"},{"role":"feasibility"}]}' },
  })
  const pet = store.read('batch-current')
  assert.equal(pet.elephant.egm.signal, 'dispatch-called')
  assert.equal(pet.state, 'prep')
  assert.equal(pet.goldfish.length, 0, '未收到真实 dispatch-start 不能展示运行金鱼')
  assert.equal(store.read('another-conversation').elephant.egm.active, false)
  assert.equal(signalOfSessionEvent({ type: 'tool/call', data: { name: 'egm_dispatch_batch_fake' } }), null)
})

test('子会话不进入大象状态：origin=subagent 或 delegationDepth>0 都忽略', () => {
  const { host, store } = attach()
  const childA = makeAgent('child-a', 'running', { origin: 'subagent' })
  const childB = makeAgent('child-b', 'running', { delegationDepth: 1 })
  fire(host, 'agent/created', { agent: childA, source: 'startup' })
  fire(host, 'agent/status', { agent: childA, status: 'running' })
  fire(host, 'agent/created', { agent: childB, source: 'startup' })

  assert.deepEqual(store.snapshotAll(), [])
  assert.equal(store.read('child-a').elephant.status, 'unknown')
  assert.equal(store.read('child-b').elephant.status, 'unknown')
})

test('会话隔离：A 的真实状态与信号不泄漏到 B', () => {
  const { host, store } = attach()
  const a = makeAgent('a', 'running')
  const b = makeAgent('b', 'idle')
  fire(host, 'agent/created', { agent: a, source: 'startup' })
  fire(host, 'agent/created', { agent: b, source: 'startup' })
  fire(host, 'session/event', a.session, {
    type: 'tool/call',
    seq: 5,
    data: { callId: 'call-a', name: 'skill', arguments: JSON.stringify({ name: 'egm-review' }) },
  })
  fire(host, 'session/event', a.session, {
    type: 'tool/result',
    seq: 6,
    data: { message: { toolCallId: 'call-a', isError: false, source: { kind: 'tool', callId: 'call-a' } } },
  })

  assert.equal(store.read('a').elephant.status, 'running')
  assert.equal(store.read('a').elephant.egm.active, true)
  assert.equal(store.read('b').elephant.status, 'idle')
  assert.equal(store.read('b').elephant.egm.active, false)
  assert.equal(store.read('b').state, 'idle')
})

test('pending 技能请求按会话隔离：B 的 step/end 不清掉 A 的待确认请求', () => {
  const { host, store } = attach()
  const a = makeAgent('a', 'running')
  const b = makeAgent('b', 'running')
  fire(host, 'agent/created', { agent: a, source: 'startup' })
  fire(host, 'agent/created', { agent: b, source: 'startup' })

  fire(host, 'session/event', a.session, {
    type: 'tool/call',
    seq: 1,
    data: { callId: 'call-a', name: 'skill', arguments: JSON.stringify({ name: 'egm-gate' }) },
  })
  fire(host, 'session/event', b.session, { type: 'step/end', seq: 2, data: {} })
  fire(host, 'session/event', a.session, {
    type: 'tool/result',
    seq: 3,
    data: { message: { toolCallId: 'call-a', isError: false, source: { kind: 'tool', callId: 'call-a' } } },
  })

  assert.equal(store.read('a').elephant.egm.skill, 'egm-gate')
  assert.equal(store.read('b').elephant.egm.active, false)
})

test('EGM turn 结束后普通 turn 立即切断 workingOnEgm，历史信号不能借当前 running 复活', () => {
  const { host, store } = attach()
  const agent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })
  const session = agent.session

  fire(host, 'session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 2,
    data: { turn: 1, callId: 'call-egm', name: 'skill', arguments: JSON.stringify({ name: 'egm-gate' }) },
  })
  fire(host, 'session/event', session, {
    type: 'tool/result',
    seq: 3,
    data: { turn: 1, message: { toolCallId: 'call-egm', isError: false, source: { kind: 'tool', callId: 'call-egm' } } },
  })
  assert.equal(store.read('s1').elephant.workingOnEgm, true)

  fire(host, 'session/event', session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })
  const afterEnd = store.read('s1')
  assert.equal(afterEnd.elephant.workingOnEgm, false, 'turn 结束后不再算 EGM 正在工作')
  assert.equal(afterEnd.elephant.egm.active, false, '匹配 EGM turn 的 end 必须清活动标记')
  assert.equal(afterEnd.state, 'idle', '匹配 EGM turn 的 end 必须把 prep 收回 idle')

  // 用户马上聊别的话题：新 turn 开始就必须切断历史 EGM 关联，即使 Agent 仍在 running。
  fire(host, 'session/event', session, { type: 'turn/start', seq: 5, data: { turn: 2 } })
  const pet = store.read('s1')
  assert.equal(pet.elephant.status, 'running')
  assert.equal(pet.elephant.workingOnEgm, false)
  assert.equal(pet.elephant.egm.active, false)
  assert.equal(pet.state, 'idle')
})

test('turn/end 后普通 status 变化不复活 EGM 活动，也不让 prep 留存', () => {
  const c = clock()
  const { host, store } = attach({ now: c.now })
  const agent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })
  const session = agent.session

  fire(host, 'session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  fire(host, 'session/event', session, {
    type: 'tool/call',
    seq: 2,
    data: { turn: 1, callId: 'call-egm', name: 'skill', arguments: JSON.stringify({ name: 'egm-gate' }) },
  })
  fire(host, 'session/event', session, {
    type: 'tool/result',
    seq: 3,
    data: { turn: 1, message: { toolCallId: 'call-egm', isError: false, source: { kind: 'tool', callId: 'call-egm' } } },
  })
  fire(host, 'session/event', session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })

  let pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.elephant.egm.active, false)

  // 之后只有普通 status 变化，没有 EGM 信号；它们不能复活活动或 prep。
  c.advance(6 * 60 * 1000)
  agent.status = 'idle'
  fire(host, 'agent/status', { agent, status: 'idle' })
  c.advance(5 * 60 * 1000)
  pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.elephant.egm.active, false)
})

test('disposed 后的旧 Agent 不能复活；同一会话新建 Agent 后恢复真实状态', () => {
  const { host, store } = attach()
  const oldAgent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent: oldAgent, source: 'startup' })
  fire(host, 'agent/disposed', { agent: oldAgent })

  let pet = store.read('s1')
  assert.equal(pet.elephant.status, 'idle')
  assert.equal(pet.elephant.source, 'agent/disposed')

  // 旧 Agent 的迟到 status / session 事件都不得复活。
  fire(host, 'agent/status', { agent: oldAgent, status: 'running' })
  fire(host, 'session/event', oldAgent.session, {
    type: 'tool/call',
    seq: 20,
    data: { name: 'skill', arguments: JSON.stringify({ name: 'egm-gate' }) },
  })
  pet = store.read('s1')
  assert.equal(pet.elephant.status, 'idle')
  assert.equal(pet.elephant.egm.active, false)

  // 新 Agent 是真实的新生命周期，应清掉 tombstone 并重新种状态。
  const newAgent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent: newAgent, source: 'resume' })
  pet = store.read('s1')
  assert.equal(pet.elephant.status, 'running')
  assert.equal(pet.elephant.source, 'agent/created')
})

test('新 Agent 接管后旧 Agent 迟到的 disposed 不得误关新实例', () => {
  const { host, store } = attach()
  const oldAgent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent: oldAgent, source: 'startup' })

  const newAgent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent: newAgent, source: 'resume' })
  fire(host, 'agent/disposed', { agent: oldAgent })

  let pet = store.read('s1')
  assert.equal(pet.elephant.status, 'running', '旧实例的 disposed 不能把新实例写成 idle')
  assert.equal(pet.elephant.source, 'agent/created')
  assert.equal(store.snapshotAll()[0].elephant.status, 'running')

  // 新实例自己的 disposed 仍然正常生效。
  fire(host, 'agent/disposed', { agent: newAgent })
  pet = store.read('s1')
  assert.equal(pet.elephant.status, 'idle')
  assert.equal(pet.elephant.source, 'agent/disposed')
})

test('没有 ctx.on 时如实标记桥不可用，status 保持 unknown', () => {
  const store = createPetStore()
  const bridge = attachElephantTracker({}, store)
  assert.equal(bridge.attached, false)
  assert.equal(bridge.failures.length > 0, true)
  const pet = store.read('s1')
  assert.equal(pet.elephant.status, 'unknown')
  assert.equal(pet.elephant.working, null)
  assert.equal(pet.elephant.reason, 'status-bridge-unavailable')
  assert.equal(pet.elephant.bridge.attached, false)
})

test('部分订阅失败：status 可用但 session/event 不可用时如实降级', () => {
  const host = makeCtx()
  const original = host.ctx.on
  host.ctx.on = (name, handler) => {
    if (name === 'session/event') throw new Error('host has no session/event')
    return original(name, handler)
  }
  const store = createPetStore()
  const bridge = attachElephantTracker(host.ctx, store)

  assert.equal(bridge.attached, true)
  assert.equal(bridge.agentStatus, true)
  assert.equal(bridge.sessionEvents, false)
  assert.equal(bridge.failures.some((item) => item.includes('session/event')), true)

  const agent = makeAgent('s1', 'running')
  fire(host, 'agent/created', { agent, source: 'startup' })
  const pet = store.read('s1')
  assert.equal(pet.elephant.status, 'running')
  assert.equal(pet.elephant.egm.active, false, '没有 session/event 就不能假装看到了 EGM 技能')
})

test('热接入：已存在的 Agent 从宿主注册表种下当前状态，不等到下一次 status 事件', () => {
  const host = makeCtx()
  const existing = makeAgent('live-session', 'running')
  host.ctx.get = (name) => (name === 'agents' ? { list: () => [existing] } : null)
  const store = createPetStore()
  const bridge = attachElephantTracker(host.ctx, store)

  assert.equal(bridge.attached, true)
  const pet = store.read('live-session')
  assert.equal(pet.elephant.status, 'running')
  assert.equal(pet.elephant.source, 'agents.list')
  assert.equal(pet.elephant.working, true)
})

test('agents 服务晚到：ctx.inject 注册后播种已有 Agent，重复播种不重复刷新', () => {
  const host = makeCtx()
  let callback = null
  let injectDisposeCount = 0
  host.ctx.get = () => null // agents 服务还没注册
  host.ctx.inject = (deps, cb) => {
    assert.deepEqual(deps, ['agents'])
    callback = cb
    return () => {
      injectDisposeCount += 1
      callback = null
    }
  }
  const store = createPetStore()
  const bridge = attachElephantTracker(host.ctx, store)
  assert.equal(bridge.lateSeed, true)

  const late = makeAgent('late-session', 'running')
  callback({ get: (name) => (name === 'agents' ? { list: () => [late] } : null) })

  let pet = store.read('late-session')
  assert.equal(pet.elephant.status, 'running')
  assert.equal(pet.elephant.source, 'agents.list')
  const firstSince = pet.elephant.since

  // 服务重载可以再次调用回调；同一个 Agent 不应重复播种或刷新时间。
  callback({ get: (name) => (name === 'agents' ? { list: () => [late] } : null) })
  pet = store.read('late-session')
  assert.equal(pet.elephant.source, 'agents.list')
  assert.equal(pet.elephant.since, firstSince)

  bridge.detach()
  assert.equal(injectDisposeCount, 1)
})

test('ctx.inject 晚到的旧快照不能覆盖真实新 Agent，卸载后不再播种', () => {
  const host = makeCtx()
  let callback = null
  host.ctx.get = () => null
  host.ctx.inject = (_deps, cb) => {
    callback = cb
    return () => {
      callback = null
    }
  }
  const store = createPetStore()
  const bridge = attachElephantTracker(host.ctx, store)

  const oldAgent = makeAgent('race-session', 'running')
  callback({ get: (name) => (name === 'agents' ? { list: () => [oldAgent] } : null) })
  assert.equal(store.read('race-session').elephant.source, 'agents.list')

  // 新 Agent 已通过真实生命周期事件接管同一会话。
  const newAgent = makeAgent('race-session', 'idle')
  fire(host, 'agent/created', { agent: newAgent, source: 'resume' })
  assert.equal(store.read('race-session').elephant.source, 'agent/created')

  // 旧快照迟到：不能把 idle 的新 Agent 改回 running 的旧 Agent。
  callback({ get: (name) => (name === 'agents' ? { list: () => [oldAgent] } : null) })
  let pet = store.read('race-session')
  assert.equal(pet.elephant.status, 'idle')
  assert.equal(pet.elephant.source, 'agent/created')

  // 卸载后即使宿主还持有旧回调，也不能再写状态。
  const savedCallback = callback
  assert.equal(typeof savedCallback, 'function')
  bridge.detach()
  const thirdAgent = makeAgent('race-session', 'running')
  savedCallback({ get: (name) => (name === 'agents' ? { list: () => [thirdAgent] } : null) })
  pet = store.read('race-session')
  assert.equal(pet.elephant.status, 'idle')
  assert.equal(pet.elephant.source, 'agent/created')
})

test('detach 退订全部监听器并把桥标为 detached', () => {
  const { host, store, bridge } = attach()
  const agent = makeAgent('s1', 'idle')
  fire(host, 'agent/created', { agent, source: 'startup' })
  bridge.detach()

  assert.equal(host.handlers.get('agent/status').length, 0)
  assert.equal(host.handlers.get('session/event').length, 0)
  const pet = store.read('s1')
  assert.equal(pet.elephant.bridge.attached, false)
  assert.equal(pet.elephant.bridge.reason, 'detached')
})

test('纯映射：技能名精确匹配、主会话判定、session id 提取', () => {
  assert.equal(egmSkillName('egm-gate'), 'egm-gate')
  assert.equal(egmSkillName(' egm-classic-review '), 'egm-classic-review')
  assert.equal(egmSkillName('egm-gate-extra'), null)
  assert.equal(egmSkillName('EGM-GATE'), null)
  assert.equal(EGM_SKILL_NAMES.includes('egm-gate'), true)

  assert.equal(isMainSession(makeSession('s1')), true)
  assert.equal(isMainSession(makeSession('s1', { origin: 'subagent' })), false)
  assert.equal(isMainSession(makeSession('s1', { delegationDepth: 2 })), false)
  assert.equal(isMainSession({ header: {} }), true, '没有 subagent 标记的普通会话仍是主会话')
  assert.equal(isMainSession({}), false)

  assert.equal(sessionIdOfSession(makeSession(' s1 ')), 's1')
  assert.equal(sessionIdOfSession({ id: 's2' }), 's2')
  assert.equal(sessionIdOfSession({}), null)

  assert.deepEqual(
    signalOfSessionEvent({
      type: 'tool/call',
      seq: 3,
      data: { callId: 'call-9', name: 'skill', arguments: JSON.stringify({ name: 'egm-review' }) },
    }),
    { signal: 'skill-load-request', skill: 'egm-review', seq: 3, callId: 'call-9' },
  )
  assert.equal(signalOfSessionEvent({ type: 'assistant/message', data: {} }), null)
})
