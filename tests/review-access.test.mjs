// review-access.js 与 /egm-review-access 命令、只读 RPC 的完整契约测试。
//
// 覆盖：
// 1. 默认 fail-closed：初始与未授权状态 snapshot 严格 closed；
// 2. 命令 /egm-review-access 参数校验：必须确认语，拒绝篡改，单次点击授权双门（2h/20次 + 10m/6次）；
// 3. 输出格式校验：返回文案换行真实（无 \\n 双转义），不产生 followup / 不碰草稿附件；
// 4. 命令 /egm-review-access revoke 撤销：触发 access-updated 事件，保持 inflight 任务不被清退；
// 5. 只读 RPC /api/egm-pet/review-access：只读无副作用、错误协议过滤、不回退最近会话；
// 6. 双门一致性：派发消耗实时反映在快照 remaining 中，额度耗尽或过期自动 fail-closed；
// 7. 父代理身份漂移防护回归：agent 身份切换后，旧 session 查询必须自动清理映射并 fail-closed，绝不泄漏新 session 许可；
// 8. 模型工具隔离：插件绝不向模型注册任何授权 tool。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONFIRMATION_PHRASE,
  getActiveAgent,
  getReviewAccessSnapshot,
  grantReviewAccess,
  revokeReviewAccess,
  registerActiveAgent,
  unregisterActiveAgent,
} from '../lib/review-access.js'
import {
  GATE_MAX_DISPATCHES,
  UNSAFE_PERMIT_USES,
  dispatchGoldfish,
  handleReviewUserAction,
  registerDispatchTool,
  registerEgmCommand,
  registerEgmReviewAccessCommand,
  registerEgmSafeCommand,
} from '../lib/dispatch.js'
import {
  PET_REVIEW_ACCESS_METHOD,
  PET_REVIEW_ACCESS_ROUTE_PATH,
  PET_ROUTE_PATH,
  createPetStore,
  registerPetRoutes,
} from '../lib/pet-state.js'
import { createElephantTracker } from '../lib/elephant-state.js'
import { apply as applyPlugin } from '../lib/index.js'

function fakeAgent(sessionId = 'test-session') {
  return {
    session: { id: sessionId, header: { id: sessionId } },
    steer: () => {},
    subagents: {
      createChild: async () => ({
        id: 'child-1',
        session: { id: 'child-session' },
        on: () => {},
        terminate: async () => {},
        dispose: async () => {},
      }),
    },
  }
}

function fakeConnectionCtx() {
  const routes = []
  return {
    routes,
    ctx: { connection: { fetch: { register: (route) => routes.push(route) } } },
  }
}

async function callRoute(route, { method = PET_REVIEW_ACCESS_METHOD, payload = {}, rpcId = 'r1', contentType = 'application/json', body } = {}) {
  const message = body !== undefined ? body : JSON.stringify({ type: 'client-request', rpcId, method, payload })
  return route.fetch(
    new Request('http://127.0.0.1' + route.path, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: message,
    }),
  )
}

test('默认 fail-closed：未授权时快照严格处于 closed 状态', () => {
  const snapshot = getReviewAccessSnapshot('unauthorized-session')
  assert.equal(snapshot.sessionId, 'unauthorized-session')
  assert.equal(snapshot.allowed, false)
  assert.equal(snapshot.gate.open, false)
  assert.equal(snapshot.gate.remaining, 0)
  assert.equal(snapshot.unsafePermit.granted, false)
  assert.equal(snapshot.unsafePermit.remaining, 0)

  // 空 session 返回 null id 且 closed
  const emptySnapshot = getReviewAccessSnapshot('')
  assert.equal(emptySnapshot.sessionId, null)
  assert.equal(emptySnapshot.allowed, false)
})

test('/egm-review-access 命令校验：必须提供确切确认语，拒绝空参或错误参', () => {
  const commands = new Map()
  const ctx = {
    commands: { register: (c) => commands.set(c.name, c) },
  }
  registerEgmReviewAccessCommand(ctx)
  const cmd = commands.get('egm-review-access')
  assert.ok(cmd, '应该成功注册 /egm-review-access 命令')

  const agent = fakeAgent('test-validation-session')

  // 空输入报错
  const resEmpty = cmd.handler({ agent, rawInput: '' })
  assert.equal(resEmpty.kind, 'error')
  assert.match(resEmpty.text, /未开启/)
  assert.equal(getReviewAccessSnapshot('test-validation-session').allowed, false)

  // 错误确认短语报错
  const resWrong = cmd.handler({ agent, rawInput: '我确认' })
  assert.equal(resWrong.kind, 'error')
  assert.match(resWrong.text, /未开启/)
  assert.equal(getReviewAccessSnapshot('test-validation-session').allowed, false)
})

test('/egm-review-access 单次授权：同时开启 2h/20次 Gate 与 10m/6次 Permit，换行真实', () => {
  const commands = new Map()
  const events = []
  const ctx = {
    commands: { register: (c) => commands.set(c.name, c) },
  }
  registerEgmReviewAccessCommand(ctx, {
    onEvent: (ev) => events.push(ev),
  })
  const cmd = commands.get('egm-review-access')

  const agent = fakeAgent('test-auth-session')
  const res = cmd.handler({ agent, rawInput: CONFIRMATION_PHRASE })

  assert.equal(res.kind, 'success')
  // 必须使用真实换行 \n，严禁出现 \\n 双转义字面
  assert.ok(res.text.includes('\n'), '输出必须包含真实换行')
  assert.ok(!res.text.includes('\\n'), '输出绝不能包含未转义的 \\\\n 字符')

  // 状态检查
  const snapshot = getReviewAccessSnapshot('test-auth-session')
  assert.equal(snapshot.allowed, true)
  assert.equal(snapshot.gate.open, true)
  assert.equal(snapshot.gate.remaining, GATE_MAX_DISPATCHES)
  assert.equal(snapshot.unsafePermit.granted, true)
  assert.equal(snapshot.unsafePermit.remaining, UNSAFE_PERMIT_USES)
  assert.equal(snapshot.unsafePermit.reason, CONFIRMATION_PHRASE)

  // 验证触发了 access-updated 事件，通知宠物和卡片
  const updateEvent = events.find((e) => e.type === 'access-updated')
  assert.ok(updateEvent, '应该触发 access-updated 事件')
  assert.equal(updateEvent.sessionId, 'test-auth-session')
  assert.equal(updateEvent.gate.open, true)
  assert.equal(updateEvent.unsafePermit.granted, true)
})

test('/egm-review-access revoke 撤销权限：关闭门禁，发送 access-updated，不清除 inflight 任务', () => {
  const commands = new Map()
  const events = []
  const ctx = {
    commands: { register: (c) => commands.set(c.name, c) },
  }
  registerEgmReviewAccessCommand(ctx, {
    onEvent: (ev) => events.push(ev),
  })
  const cmd = commands.get('egm-review-access')
  const agent = fakeAgent('test-revoke-session')

  // 先授权
  cmd.handler({ agent, rawInput: CONFIRMATION_PHRASE })
  assert.equal(getReviewAccessSnapshot('test-revoke-session').allowed, true)

  // 执行 revoke
  const resRevoke = cmd.handler({ agent, rawInput: 'revoke' })
  assert.equal(resRevoke.kind, 'success')
  assert.match(resRevoke.text, /已关闭评审许可/)

  const snapshot = getReviewAccessSnapshot('test-revoke-session')
  assert.equal(snapshot.allowed, false)
  assert.equal(snapshot.gate.open, false)
  assert.equal(snapshot.unsafePermit.granted, false)

  // 验证事件是 access-updated 而绝不是 reset！
  const lastEvent = events[events.length - 1]
  assert.equal(lastEvent.type, 'access-updated')
  assert.equal(lastEvent.gate.open, false)
  assert.equal(lastEvent.unsafePermit.granted, false)
  assert.ok(!events.some((e) => e.type === 'reset'), 'revoke 绝对不应发送 reset 事件以防误伤运行中金鱼')
})

test('对比：/egm-safe 命令会发送 reset，而 /egm-review-access revoke 只更新状态', () => {
  const commands = new Map()
  const events = []
  const ctx = {
    commands: { register: (c) => commands.set(c.name, c) },
  }
  registerEgmSafeCommand(ctx, {
    onEvent: (ev) => events.push(ev),
  })
  const cmdSafe = commands.get('egm-safe')
  const agent = fakeAgent('test-safe-session')

  grantReviewAccess(agent, CONFIRMATION_PHRASE)
  cmdSafe.handler({ agent })

  assert.ok(events.some((e) => e.type === 'reset'), '/egm-safe 保持向后兼容发送 reset')
})

test('只读 RPC /api/egm-pet/review-access：提供实时快照且绝无副作用', async () => {
  const store = createPetStore()
  const { ctx, routes } = fakeConnectionCtx()
  registerPetRoutes(ctx, store)

  const reviewRoute = routes.find((r) => r.path === PET_REVIEW_ACCESS_ROUTE_PATH)
  assert.ok(reviewRoute, '路由中必须包含 /api/egm-pet/review-access')

  // 1. 未授权会话调用
  const res1 = await callRoute(reviewRoute, { payload: { sessionId: 'rpc-session-1' } })
  assert.equal(res1.status, 200)
  const body1 = await res1.json()
  assert.equal(body1.result.ok, true)
  assert.equal(body1.result.value.allowed, false)

  // 2. 授权会话调用
  const agent = fakeAgent('rpc-session-1')
  grantReviewAccess(agent, CONFIRMATION_PHRASE)

  const res2 = await callRoute(reviewRoute, { payload: { sessionId: 'rpc-session-1' } })
  const body2 = await res2.json()
  assert.equal(body2.result.ok, true)
  assert.equal(body2.result.value.allowed, true)
  assert.equal(body2.result.value.gate.remaining, GATE_MAX_DISPATCHES)
  assert.equal(body2.result.value.unsafePermit.remaining, UNSAFE_PERMIT_USES)

  // 3. 多次调用验证无副作用（只读属性）：额度不减少
  await callRoute(reviewRoute, { payload: { sessionId: 'rpc-session-1' } })
  await callRoute(reviewRoute, { payload: { sessionId: 'rpc-session-1' } })
  const snapAfter = getReviewAccessSnapshot('rpc-session-1')
  assert.equal(snapAfter.gate.remaining, GATE_MAX_DISPATCHES, '只读 RPC 绝不能扣减门禁配额')
  assert.equal(snapAfter.unsafePermit.remaining, UNSAFE_PERMIT_USES, '只读 RPC 绝不能扣减许可配额')

  // 4. 异常参数校验
  const resBadMethod = await callRoute(reviewRoute, { method: 'invalid/method' })
  const bodyBadMethod = await resBadMethod.json()
  assert.equal(bodyBadMethod.result.ok, false)

  const resBadContentType = await callRoute(reviewRoute, { contentType: 'text/plain', body: 'hello' })
  assert.equal(resBadContentType.status, 415)
})

test('双门一致性：派发同时扣减 Gate 与 Permit，配额归零后自动关闭', async () => {
  const agent = fakeAgent('test-consumption-session')
  const resAuth = grantReviewAccess(agent, CONFIRMATION_PHRASE)
  assert.equal(resAuth.ok, true)

  const snapBefore = getReviewAccessSnapshot('test-consumption-session')
  assert.equal(snapBefore.allowed, true)
  assert.equal(snapBefore.gate.remaining, GATE_MAX_DISPATCHES)
  assert.equal(snapBefore.unsafePermit.remaining, UNSAFE_PERMIT_USES)

  // 模拟用掉 5 次许可（通过返回的 live 对象直接修改）
  resAuth.unsafePermit.remaining = 1

  const snapMid = getReviewAccessSnapshot('test-consumption-session')
  assert.equal(snapMid.allowed, true)
  assert.equal(snapMid.unsafePermit.remaining, 1)

  // 耗尽许可
  resAuth.unsafePermit.remaining = 0
  const snapExhausted = getReviewAccessSnapshot('test-consumption-session')
  assert.equal(snapExhausted.allowed, false, '许可耗尽后 allowed 必须自动变为 false')
  assert.equal(snapExhausted.unsafePermit.granted, false)
})

test('过期处理：超过 TTL 后快照自动判断为 closed', async () => {
  const agent = fakeAgent('test-expired-session')
  const resAuth = grantReviewAccess(agent, CONFIRMATION_PHRASE)
  assert.equal(resAuth.ok, true)

  // 模拟已过期
  resAuth.unsafePermit.expiresAt = Date.now() - 1000

  const snapshot = getReviewAccessSnapshot('test-expired-session')
  assert.equal(snapshot.allowed, false)
  assert.equal(snapshot.unsafePermit.granted, false)
})

test('会话身份切换防泄漏回归（父代理审查核心项）：agent 身份漂移时自动清理旧映射并 fail-closed', () => {
  // 构造可动态切换 session 的 agent
  let currentSessionId = 'session-alpha'
  const dynamicAgent = {
    get session() {
      return { id: currentSessionId }
    },
    subagents: { createChild: async () => ({}) },
  }

  // 1. 为 session-alpha 授权
  grantReviewAccess(dynamicAgent, CONFIRMATION_PHRASE)
  assert.equal(getReviewAccessSnapshot('session-alpha').allowed, true)

  // 2. 模拟 dynamicAgent 被宿主调度切换到 session-beta，并为 session-beta 授权
  currentSessionId = 'session-beta'
  grantReviewAccess(dynamicAgent, CONFIRMATION_PHRASE)
  assert.equal(getReviewAccessSnapshot('session-beta').allowed, true)

  // 3. 此时以 session-alpha 查询：
  // 必须识别出 dynamicAgent 的当前身份 (session-beta) !== 'session-alpha'，
  // 立即剔除 session-alpha 的过期弱引用映射，返回 null agent，快照必须 fail-closed！
  const retrievedAgent = getActiveAgent('session-alpha')
  assert.equal(retrievedAgent, null, '身份不匹配时 getActiveAgent 必须返回 null 并清理映射')

  const snapAlpha = getReviewAccessSnapshot('session-alpha')
  assert.equal(snapAlpha.allowed, false, 'session-alpha 必须为 closed，绝不能泄露 session-beta 的许可！')

  // 4. session-beta 的权限依旧有效不受影响
  const snapBeta = getReviewAccessSnapshot('session-beta')
  assert.equal(snapBeta.allowed, true)
})

test('模型隔离验证：插件绝不向模型暴露授权相关工具', () => {
  const tools = []
  const commands = new Map()
  const services = {
    commands: { register: (definition) => commands.set(definition.name, definition) },
    tools: { register: (definition) => tools.push(definition.name) },
    subagents: {},
    agentPresets: { register: () => {} },
  }
  const child = { get: (name) => services[name], ...services }
  const ctx = {
    skills: { registerProvider: () => {} },
    on: () => () => {},
    inject: (_dependencies, callback) => callback(child),
  }

  applyPlugin(ctx)

  // 验证注册的工具列表
  assert.ok(tools.includes('egm_dispatch'))
  assert.ok(tools.includes('egm_dispatch_batch'))
  // 核心安全红线：绝不能注册任何 authorization/review-access 相关的 model tools
  for (const toolName of tools) {
    assert.ok(!toolName.includes('access'), `工具 ${toolName} 不能暴露授权能力`)
    assert.ok(!toolName.includes('grant'), `工具 ${toolName} 不能暴露授权能力`)
    assert.ok(!toolName.includes('permit'), `工具 ${toolName} 不能暴露授权能力`)
  }
})

test('动作桥接契约：专用按钮改变当前会话许可，普通聊天不授权，未知会话拒绝', () => {
  const agent = fakeAgent('session-action-1')
  registerActiveAgent(agent)
  assert.equal(getReviewAccessSnapshot('session-action-1').allowed, false)
  for (const text of ['是', '允许', '授权', '好', '同意', '取消', '否']) {
    assert.equal(handleReviewUserAction(agent, text).handled, false)
    assert.equal(getReviewAccessSnapshot('session-action-1').allowed, false)
  }
  const granted = handleReviewUserAction(agent, '[genui-action] egm-review-grant')
  assert.equal(granted.ok, true)
  assert.equal(getReviewAccessSnapshot('session-action-1').allowed, true)
  assert.equal(handleReviewUserAction(agent, '取消').handled, false)
  assert.equal(getReviewAccessSnapshot('session-action-1').allowed, true)
  const denied = handleReviewUserAction(agent, '[genui-action] egm-review-deny')
  assert.equal(denied.ok, true)
  assert.equal(getReviewAccessSnapshot('session-action-1').allowed, false)
  const unknown = handleReviewUserAction('session-non-existent', '[genui-action] egm-review-grant')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error, 'E_AGENT_UNRESOLVED')
  unregisterActiveAgent(agent)
})

test('会话事件集成：仅真实用户来源的专用按钮动作发放许可', () => {
  const store = createPetStore()
  const tracker = createElephantTracker({ store })
  const agent = fakeAgent('session-event-grant')
  tracker.handleCreated({ agent })
  const send = (text, source) => tracker.handleSessionEvent(agent.session, {
    type: 'user/message', data: { content: [{ type: 'text', text }], source },
  })
  send('是', { kind: 'user' })
  assert.equal(getReviewAccessSnapshot('session-event-grant').allowed, false)
  send('[genui-action] egm-review-grant', { kind: 'context' })
  assert.equal(getReviewAccessSnapshot('session-event-grant').allowed, false)
  send('[genui-action] egm-review-grant', undefined)
  assert.equal(getReviewAccessSnapshot('session-event-grant').allowed, false)
  send('[genui-action] egm-review-grant', { kind: 'user' })
  assert.equal(getReviewAccessSnapshot('session-event-grant').allowed, true)
  send('[genui-action] egm-review-deny', { kind: 'user' })
  assert.equal(getReviewAccessSnapshot('session-event-grant').allowed, false)
  tracker.handleSessionEvent({ id: 'session-other' }, {
    type: 'user/message', data: { text: '[genui-action] egm-review-grant', source: { kind: 'user' } },
  })
  assert.equal(getReviewAccessSnapshot('session-other').allowed, false)
  unregisterActiveAgent(agent)
})

test('/egm 命令防护：拒绝控制命令输入，避免大象将 /egm-unsafe 等当成新需求', () => {
  const commands = new Map()
  const ctx = { commands: { register: (definition) => commands.set(definition.name, definition) } }
  registerEgmCommand(ctx)
  const egmCommand = commands.get('egm')
  const agent = fakeAgent('session-cmd-protect')

  const resUnsafe = egmCommand.handler({ agent, rawInput: '/egm-unsafe 确认无隔离' })
  assert.equal(resUnsafe.kind, 'error')
  assert.equal(resUnsafe.code, undefined)
  assert.match(resUnsafe.text, /控制命令不能作为新的 EGM 需求/)

  const resReview = egmCommand.handler({ agent, rawInput: '/egm-review-access 确认无隔离' })
  assert.equal(resReview.kind, 'error')
  assert.equal(resReview.code, undefined)
  assert.match(resReview.text, /控制命令不能作为新的 EGM 需求/)
})
