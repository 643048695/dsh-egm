// 顶栏宠物与大象金鱼卡片的状态源测试：不联网、不碰界面，只验证「什么时候该动、动成什么样」。
//
// 覆盖：状态迁移（idle / prep / writing / dispatch / crit）、代际隔离防复活、精确 ID 匹配防篡改、
// 重复开窗保留 in-flight、gate 真实时效同步、轮询轻量化不返报告正文、按需读取报告、双闸未放行不创建金鱼。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_REPORT_CHARS,
  MAX_REPORT_RPC_BYTES,
  PET_IDLE_AFTER_MS,
  PET_METHOD,
  PET_REPORT_METHOD,
  PET_REPORT_ROUTE_PATH,
  PET_REVIEW_ACCESS_ROUTE_PATH,
  PET_ROUTE_PATH,
  PET_STATES,
  createPetStore,
  registerPetRoutes,
} from '../lib/pet-state.js'

function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

test('初始状态是空闲，且没有计数与金鱼记录', () => {
  const store = createPetStore()
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.count, 0)
  assert.equal(pet.role, null)
  assert.equal(pet.sessionId, 's1')
  assert.equal(pet.gate.open, false)
  assert.deepEqual(pet.goldfish, [])
})

test('状态白名单包含五个状态（含 prep 准备态）', () => {
  assert.deepEqual([...PET_STATES], ['idle', 'prep', 'writing', 'dispatch', 'crit'])
})

test('/egm-open 仅开窗：保持 idle，若带真实 gate 元数据则正确同步', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-0', role: 'logic' })
  store.apply('s1', 'dispatch-done', { id: 'gf-0', role: 'logic' })
  assert.equal(store.read('s1').count, 1)

  // /egm-open 仅开窗，不带 prep/writing，带真实 gate
  store.apply('s1', 'gate-opened', {
    prep: false,
    writing: false,
    gate: { expiresAt: Date.now() + 7200000, remaining: 20 },
  })
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle', '/egm-open 只是开窗，不能视为 writing 或 prep 证据')
  assert.equal(pet.gate.open, true)
  assert.equal(pet.gate.remaining, 20)
  assert.equal(pet.count, 0)
  assert.equal(pet.role, null)
  assert.deepEqual(pet.goldfish, [])
})

test('/egm kickoff 仅证明准备而非写图纸：状态标为 prep，不要虚报已写', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-0', role: 'logic' })
  store.apply('s1', 'dispatch-done', { id: 'gf-0', role: 'logic' })
  assert.equal(store.read('s1').count, 1)

  // /egm <需求> kickoff 仅代表准备流程开始
  store.apply('s1', 'gate-opened', {
    prep: true,
    gate: { expiresAt: Date.now() + 7200000, remaining: 20 },
  })
  const pet = store.read('s1')
  assert.equal(pet.state, 'prep', 'kickoff 仅证明准备阶段，状态应标为 prep')
  assert.equal(pet.gate.open, true)
  assert.equal(pet.count, 0)
  assert.equal(pet.role, null)
  assert.deepEqual(pet.goldfish, [])
})

test('重复 /egm-open 不应丢失正在 running 的真实金鱼记录', () => {
  const store = createPetStore()
  store.apply('s1', 'gate-opened', {
    prep: false,
    gate: { expiresAt: Date.now() + 7200000, remaining: 20 },
  })
  store.apply('s1', 'dispatch-start', { id: 'gf-inflight', role: 'logic' })
  assert.equal(store.read('s1').state, 'dispatch')
  assert.equal(store.read('s1').goldfish.length, 1)

  // 再次执行 /egm-open，不能丢失正在跑的金鱼！
  store.apply('s1', 'gate-opened', {
    prep: false,
    gate: { expiresAt: Date.now() + 7200000, remaining: 19 },
  })
  const pet = store.read('s1')
  assert.equal(pet.state, 'dispatch', '有金鱼在 running 时，重复开窗必须维持 dispatch')
  assert.equal(pet.goldfish.length, 1)
  assert.equal(pet.goldfish[0].id, 'gf-inflight')
  assert.equal(pet.goldfish[0].status, 'running')
})

test('gate 时效与额度：拿不到真实 gate 时不暴露为授权，过期或用尽自动关闭', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })

  // 1. 无有效 gate 元数据：open 为 false
  store.apply('s1', 'gate-opened', { prep: false })
  assert.equal(store.read('s1').gate.open, false, '拿不到真实 gate 元数据时不应谎报 open: true')

  // 2. 带真实 gate（2 小时，20 次）
  store.apply('s1', 'gate-opened', {
    prep: false,
    gate: { expiresAt: c.now() + 7200000, remaining: 2 },
  })
  assert.equal(store.read('s1').gate.open, true)
  assert.equal(store.read('s1').gate.remaining, 2)

  // 派发一次，消费 1 次
  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  assert.equal(store.read('s1').gate.remaining, 1)
  assert.equal(store.read('s1').gate.open, true)

  // 派发第二次，额度用尽
  store.apply('s1', 'dispatch-start', { id: 'gf-2', role: 'logic' })
  assert.equal(store.read('s1').gate.remaining, 0)
  assert.equal(store.read('s1').gate.open, false, '额度用尽自动关闭')

  // 3. 时间过期（超过 2 小时）
  store.apply('s1', 'gate-opened', {
    prep: false,
    gate: { expiresAt: c.now() + 1000, remaining: 10 },
  })
  assert.equal(store.read('s1').gate.open, true)
  c.advance(1001)
  assert.equal(store.read('s1').gate.open, false, '超时自动失效')
})

test('dispatch-failed 不得按角色回退匹配导致未放行任务篡改同角色运行任务', () => {
  const store = createPetStore()
  // gf-running 是真实已放行且正在运行的 logic 金鱼
  store.apply('s1', 'dispatch-start', { id: 'gf-running', role: 'logic' })
  assert.equal(store.read('s1').goldfish[0].status, 'running')

  // 并发请求另一条 logic 金鱼，但在双闸拦截（未放行 didStart: false），上报 failed
  const blockedHandled = store.apply('s1', 'dispatch-failed', {
    id: 'gf-blocked',
    role: 'logic',
    didStart: false,
    error: '双闸拦截未放行',
  })
  assert.equal(blockedHandled, false, 'didStart 为 false 应直接忽略')

  // 即使没带 didStart，但 id 不匹配，也不得回退篡改 gf-running
  const noMatchHandled = store.apply('s1', 'dispatch-failed', {
    id: 'gf-other',
    role: 'logic',
    didStart: true,
    error: '错误',
  })
  assert.equal(noMatchHandled, false, 'id 不匹配且未启动应直接忽略')

  const pet = store.read('s1')
  assert.equal(pet.state, 'dispatch', 'gf-running 仍在运行，状态必须依然是 dispatch')
  assert.equal(pet.goldfish.length, 1)
  assert.equal(pet.goldfish[0].id, 'gf-running')
  assert.equal(pet.goldfish[0].status, 'running', '正在运行的 logic 金鱼绝不能被同角色失败篡改！')
})

test('dispatch-done 必须明确匹配有效启动记录，不得按角色回退匹配', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-real', role: 'style' })

  // 传入未知 id 的 done 事件
  const handled = store.apply('s1', 'dispatch-done', {
    id: 'gf-fake',
    role: 'style',
    report: '伪造报告',
  })
  assert.equal(handled, false, '未启动的伪造记录不得被 done 接受')

  const pet = store.read('s1')
  assert.equal(pet.state, 'dispatch')
  assert.equal(pet.count, 0)
  assert.equal(pet.goldfish[0].id, 'gf-real')
  assert.equal(pet.goldfish[0].status, 'running', '真实运行的任务未被篡改')
})

test('/egm-safe reset 后迟到完成不能复活：使用代际拒旧事件', () => {
  const store = createPetStore()
  // 第 1 代发起 gf-old
  store.apply('s1', 'gate-opened', {
    prep: false,
    gate: { expiresAt: Date.now() + 7200000, remaining: 20 },
  })
  store.apply('s1', 'dispatch-start', { id: 'gf-old', role: 'logic' })
  assert.equal(store.read('s1').state, 'dispatch')

  // 用户执行 /egm-safe，reset 会话进入第 2 代
  store.apply('s1', 'reset')
  const afterReset = store.read('s1')
  assert.equal(afterReset.state, 'idle')
  assert.equal(afterReset.count, 0)
  assert.deepEqual(afterReset.goldfish, [])

  // 之前第 1 代在后台运行的任务延迟返回 dispatch-done
  const lateHandled = store.apply('s1', 'dispatch-done', {
    id: 'gf-old',
    role: 'logic',
    report: '迟到的报告',
  })
  assert.equal(lateHandled, false, 'reset 后的旧代际迟到事件必须被拒绝')

  // 状态不能被复活！
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle', '迟到事件绝不能把 reset 后的 idle 复活为 crit')
  assert.equal(pet.count, 0)
  assert.deepEqual(pet.goldfish, [])
})

test('状态轮询不返回报告正文，仅包含 hasReport、reportBytes、reportPath', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  store.apply('s1', 'dispatch-done', {
    id: 'gf-1',
    role: 'logic',
    report: '很长的正文内容...',
    reportPath: '/tmp/report.md',
  })

  const pet = store.read('s1')
  assert.equal(pet.state, 'crit')
  assert.equal(pet.goldfish.length, 1)
  const g = pet.goldfish[0]
  assert.equal(g.hasReport, true)
  assert.equal(g.reportPath, '/tmp/report.md')
  assert.equal(g.reportBytes > 0, true)
  assert.equal(g.report, undefined, '轮询快照严禁返回报告正文，保证轻量无泄露')
})

test('按需读取报告 readReport：澄清截断及全文访问', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  store.apply('s1', 'dispatch-done', {
    id: 'gf-1',
    role: 'logic',
    report: '## 报告标题\n这是正文内容。',
    reportPath: '/tmp/report-logic.md',
  })

  // 按 sessionId + goldfishId 读取
  const res = store.readReport('s1', 'gf-1')
  assert.equal(res.ok, true)
  assert.equal(res.value.id, 'gf-1')
  assert.equal(res.value.role, 'logic')
  assert.equal(res.value.reportPath, '/tmp/report-logic.md')
  assert.equal(res.value.content, '## 报告标题\n这是正文内容。')
  assert.equal(res.value.totalBytes > 0, true)
  assert.equal(res.value.truncated, false)

  // 跨会话或不存在的记录返回错误
  assert.equal(store.readReport('s2', 'gf-1').ok, false)
  assert.equal(store.readReport('s1', 'gf-unknown').ok, false)
})

test('双闸未放行时失败：不应创建/宣称已派金鱼', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-failed', {
    id: 'gf-blocked',
    role: 'logic',
    error: '未通过 /egm 启动',
    didStart: false,
  })
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.count, 0)
  assert.deepEqual(pet.goldfish, [], '双闸未放行时不应创建或宣称已派金鱼')
})

test('派发启动后失败：记录失败原因，不伪造摘要与报告', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-fail-1', role: 'logic' })
  store.apply('s1', 'dispatch-failed', {
    id: 'gf-fail-1',
    role: 'logic',
    didStart: true,
    error: '子代理响应超时',
    failedAt: 125000,
  })
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.goldfish.length, 1)
  assert.equal(pet.goldfish[0].status, 'failed')
  assert.equal(pet.goldfish[0].error, '子代理响应超时')
  assert.equal(pet.goldfish[0].hasReport, false)
  assert.equal(pet.goldfish[0].finishedAt, 125000)
})

test('并发金鱼：先后完成时，只要仍有 running 任务就保持 dispatch', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  store.apply('s1', 'dispatch-start', { id: 'gf-2', role: 'structural' })
  assert.equal(store.read('s1').state, 'dispatch')

  // gf-1 完成，gf-2 还在跑：状态必须保持 dispatch
  store.apply('s1', 'dispatch-done', { id: 'gf-1', role: 'logic', report: 'r1', reportPath: 'p1' })
  assert.equal(store.read('s1').state, 'dispatch', 'gf-2 仍在 running，状态必须保持 dispatch')
  assert.equal(store.read('s1').count, 1)

  // gf-2 随后完成：全部完成，进入 crit
  store.apply('s1', 'dispatch-done', { id: 'gf-2', role: 'structural', report: 'r2', reportPath: 'p2' })
  assert.equal(store.read('s1').state, 'crit')
  assert.equal(store.read('s1').count, 2)
  assert.equal(store.read('s1').goldfish.length, 2)
})

test('并发金鱼：失败不覆盖其他运行中金鱼的状态', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  store.apply('s1', 'dispatch-start', { id: 'gf-2', role: 'structural' })

  // gf-1 失败，gf-2 仍在跑：状态必须保持 dispatch，不得覆盖为 idle
  store.apply('s1', 'dispatch-failed', { id: 'gf-1', role: 'logic', didStart: true, error: '超时' })
  assert.equal(store.read('s1').state, 'dispatch', 'gf-2 仍在运行，失败不能把状态改成 idle')
  assert.equal(store.read('s1').goldfish[0].status, 'failed')
  assert.equal(store.read('s1').goldfish[1].status, 'running')

  // gf-2 随后完成：全部结束且有完成项，进入 crit
  store.apply('s1', 'dispatch-done', { id: 'gf-2', role: 'structural', report: 'r2', reportPath: 'p2' })
  assert.equal(store.read('s1').state, 'crit')
})

test('10 分钟失活：有 running 任务时绝不误改 idle，无 running 任务才回落', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })

  // 情况 A：有 running 任务，即使超过 10 分钟也不能改为 idle
  store.apply('s1', 'dispatch-start', { id: 'gf-running', role: 'logic' })
  c.advance(PET_IDLE_AFTER_MS + 5000)
  assert.equal(store.read('s1').state, 'dispatch', '有金鱼正在 running 时不能误改 idle')

  // 情况 B：任务完成后超过 10 分钟，无任何 running，自然回落 idle
  store.apply('s1', 'dispatch-done', { id: 'gf-running', role: 'logic', report: 'r', reportPath: 'p' })
  assert.equal(store.read('s1').state, 'crit')
  c.advance(PET_IDLE_AFTER_MS + 1000)
  assert.equal(store.read('s1').state, 'idle', '无 running 任务超时后自然回落 idle')
  assert.equal(store.read('s1').count, 1, '已完成计数保留')
})

test('/egm-safe 重置：清空 gate、计数与金鱼记录', () => {
  const store = createPetStore()
  store.apply('s1', 'gate-opened', {
    prep: true,
    gate: { expiresAt: Date.now() + 7200000, remaining: 20 },
  })
  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  store.apply('s1', 'dispatch-done', { id: 'gf-1', role: 'logic' })
  assert.equal(store.read('s1').gate.open, true)
  assert.equal(store.read('s1').count, 1)

  store.apply('s1', 'reset')
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.gate.open, false)
  assert.equal(pet.count, 0)
  assert.deepEqual(pet.goldfish, [])
})

test('未知事件名不猜：忽略并返回 false', () => {
  const store = createPetStore()
  assert.equal(store.apply('s1', 'goldfish-dance'), false)
  assert.equal(store.read('s1').state, 'idle')
})

test('没有会话号就不记：宁可没宠物，也不张冠李戴', () => {
  const store = createPetStore()
  assert.equal(store.apply('', 'dispatch-done'), false)
  assert.equal(store.apply(null, 'dispatch-done'), false)
  assert.deepEqual(store.snapshotAll(), [])
})

test('两个会话互不影响：严格隔离', () => {
  const store = createPetStore()
  store.apply('a', 'dispatch-start', { id: 'gf-a', role: 'logic' })
  store.apply('a', 'dispatch-done', { id: 'gf-a', role: 'logic', report: 'ra' })
  store.apply('b', 'gate-opened', { prep: true })

  assert.equal(store.read('a').state, 'crit')
  assert.equal(store.read('a').goldfish.length, 1)
  assert.equal(store.read('b').state, 'prep')
  assert.equal(store.read('b').goldfish.length, 0)
})

test('准确隔离 sessionId：未传会话号时返回空闲/空会话，绝不回退最近会话造成串话', () => {
  const store = createPetStore()
  store.apply('a', 'dispatch-start', { id: 'gf-a', role: 'logic' })
  store.apply('a', 'dispatch-done', { id: 'gf-a', role: 'logic' })
  store.apply('b', 'dispatch-start', { id: 'gf-b', role: 'style' })

  const unk = store.read()
  assert.equal(unk.sessionId, null, '未传 sessionId 绝不猜测')
  assert.equal(unk.state, 'idle')
  assert.equal(unk.count, 0)
  assert.deepEqual(unk.goldfish, [], '绝不串联到其他会话的金鱼')

  const unkEmpty = store.read('')
  assert.equal(unkEmpty.sessionId, null)
  assert.equal(unkEmpty.state, 'idle')
})

/** 造一个只记录路由的假 ctx。 */
function fakeConnectionCtx() {
  const routes = []
  return {
    routes,
    ctx: { connection: { fetch: { register: (route) => routes.push(route) } } },
  }
}

/** 按 Connection 客户端的形状发一次请求。 */
async function callRoute(route, { method = PET_METHOD, payload = {}, rpcId = 'r1', contentType = 'application/json', body } = {}) {
  const message = body !== undefined ? body : JSON.stringify({ type: 'client-request', rpcId, method, payload })
  return route.fetch(
    new Request('http://127.0.0.1' + route.path, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: message,
    }),
  )
}

test('路由：合法请求返回当前轻量快照及并发金鱼列表（不含报告正文）', async () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-1', role: 'logic' })
  store.apply('s1', 'dispatch-done', { id: 'gf-1', role: 'logic', report: '意见全文', reportPath: '/tmp/r.md' })

  const { ctx, routes } = fakeConnectionCtx()
  assert.equal(registerPetRoutes(ctx, store), true)
  assert.equal(routes.length, 3, '应注册 state、report 与 review-access 路由')
  assert.equal(routes[0].path, PET_ROUTE_PATH)
  assert.equal(routes[1].path, PET_REPORT_ROUTE_PATH)
  assert.equal(routes[2].path, PET_REVIEW_ACCESS_ROUTE_PATH)

  const response = await callRoute(routes[0], { payload: { sessionId: 's1' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'r1')
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.state, 'crit')
  assert.equal(body.result.value.count, 1)
  assert.equal(body.result.value.role, 'logic')
  assert.equal(body.result.value.goldfish.length, 1)
  assert.equal(body.result.value.goldfish[0].id, 'gf-1')
  assert.equal(body.result.value.goldfish[0].hasReport, true)
  assert.equal(body.result.value.goldfish[0].report, undefined, '轮询快照不返正文')
  assert.equal(body.result.value.goldfish[0].reportPath, '/tmp/r.md')
})

test('路由：安全读取报告内容 /api/egm-pet/report', async () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-report-1', role: 'logic' })
  store.apply('s1', 'dispatch-done', {
    id: 'gf-report-1',
    role: 'logic',
    report: '# 完整报告\n通过。',
    reportPath: '/tmp/report-logic.md',
  })

  const { ctx, routes } = fakeConnectionCtx()
  registerPetRoutes(ctx, store)
  const reportRoute = routes[1]

  // 用 id 查
  const res1 = await (await callRoute(reportRoute, {
    method: PET_REPORT_METHOD,
    payload: { sessionId: 's1', goldfishId: 'gf-report-1' },
  })).json()
  assert.equal(res1.result.ok, true)
  assert.equal(res1.result.value.id, 'gf-report-1')
  assert.equal(res1.result.value.content, '# 完整报告\n通过。')
  assert.equal(res1.result.value.reportPath, '/tmp/report-logic.md')
  assert.equal(res1.result.value.truncated, false)

  // 未就绪或不存在报错
  const res2 = await (await callRoute(reportRoute, {
    method: PET_REPORT_METHOD,
    payload: { sessionId: 's1', goldfishId: 'gf-nonexistent' },
  })).json()
  assert.equal(res2.result.ok, false)
  assert.match(res2.result.error.message, /not found/)
})

test('路由：方法名不对就拒绝，不猜', async () => {
  const store = createPetStore()
  const { ctx, routes } = fakeConnectionCtx()
  registerPetRoutes(ctx, store)
  const body = await (await callRoute(routes[0], { method: 'egm-pet/other' })).json()
  assert.equal(body.result.ok, false)
  assert.match(body.result.error.message, /unexpected method/)
})

test('路由：内容类型或 JSON 不合法就拒绝', async () => {
  const store = createPetStore()
  const { ctx, routes } = fakeConnectionCtx()
  registerPetRoutes(ctx, store)

  const wrongType = await callRoute(routes[0], { contentType: 'text/plain' })
  assert.equal(wrongType.status, 415)

  const broken = await callRoute(routes[0], { body: '{' })
  const body = await broken.json()
  assert.equal(body.result.ok, false)
  assert.match(body.result.error.message, /not JSON/)

  const wrongShape = await callRoute(routes[0], { body: JSON.stringify({ type: 'nope' }) })
  const shapeBody = await wrongShape.json()
  assert.equal(shapeBody.result.ok, false)
  assert.match(shapeBody.result.error.message, /invalid client-request/)
})

test('没有 connection 服务时安静跳过，不拖垮插件', () => {
  const store = createPetStore()
  assert.equal(registerPetRoutes({}, store), false)
  assert.equal(registerPetRoutes({ connection: {} }, store), false)
})

test('按需读取：多字节大文件受限读取与 UTF-8 安全截断（不超过 256KB，不切断字符）', () => {
  const store = createPetStore()
  const tmpFile = join(os.tmpdir(), `egm-multibyte-test-${Date.now()}.md`)
  try {
    // 构造约 300KB 的多字节中文内容
    const chunk = '【深度评审】系统并发处理与高可用架构，确保数据零丢失。\n'
    const repeatCount = Math.ceil((300 * 1024) / Buffer.byteLength(chunk, 'utf8'))
    const largeContent = chunk.repeat(repeatCount)
    fs.writeFileSync(tmpFile, largeContent, 'utf8')

    store.apply('s1', 'dispatch-start', { id: 'gf-multibyte', role: 'logic' })
    store.apply('s1', 'dispatch-done', {
      id: 'gf-multibyte',
      role: 'logic',
      reportPath: tmpFile,
      report: '内存缩略内容',
    })

    const res = store.readReport('s1', 'gf-multibyte')
    assert.equal(res.ok, true)
    assert.equal(res.value.id, 'gf-multibyte')
    assert.equal(res.value.source, 'disk')
    assert.equal(res.value.truncated, true)
    assert.ok(res.value.totalBytes > MAX_REPORT_RPC_BYTES)
    const readBytes = Buffer.byteLength(res.value.content, 'utf8')
    assert.ok(readBytes <= MAX_REPORT_RPC_BYTES, `返回字节数 (${readBytes}) 不得超过 ${MAX_REPORT_RPC_BYTES}`)
    // UTF-8 安全截断：末尾不得出现 U+FFFD 替换字符
    assert.ok(!res.value.content.includes('\uFFFD'), '不得包含截断损坏的多字节乱码字符')
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
})

test('按需读取失败与安全检查：文件缺失或符号链接拦截，安全回退内存缓存', () => {
  const store = createPetStore()

  // 1. 物理文件缺失：回退到内存缓存并标明来源
  store.apply('s1', 'dispatch-start', { id: 'gf-missing', role: 'logic' })
  store.apply('s1', 'dispatch-done', {
    id: 'gf-missing',
    role: 'logic',
    reportPath: join(os.tmpdir(), 'nonexistent-report.md'),
    report: '## 内存中的有效报告',
  })

  const resMissing = store.readReport('s1', 'gf-missing')
  assert.equal(resMissing.ok, true)
  assert.equal(resMissing.value.source, 'memory-fallback')
  assert.equal(resMissing.value.content, '## 内存中的有效报告')
  assert.equal(resMissing.value.truncated, false)

  // 2. 符号链接安全拦截：禁止通过 symlink 从磁盘读取，拦截后回退至内存缓存
  const targetFile = join(os.tmpdir(), `egm-target-${Date.now()}.txt`)
  const linkFile = join(os.tmpdir(), `egm-link-${Date.now()}.txt`)
  try {
    fs.writeFileSync(targetFile, '敏感或外部文件内容', 'utf8')
    fs.symlinkSync(targetFile, linkFile)

    store.apply('s1', 'dispatch-start', { id: 'gf-symlink', role: 'structural' })
    store.apply('s1', 'dispatch-done', {
      id: 'gf-symlink',
      role: 'structural',
      reportPath: linkFile,
      report: '内存安全备份报告',
    })

    const resSymlink = store.readReport('s1', 'gf-symlink')
    assert.equal(resSymlink.ok, true)
    // 符号链接必须被安全拦截，不得标记为 disk 读取，必须回退至 memory-fallback
    assert.equal(resSymlink.value.source, 'memory-fallback')
    assert.equal(resSymlink.value.content, '内存安全备份报告')
  } finally {
    try { fs.unlinkSync(linkFile) } catch {}
    try { fs.unlinkSync(targetFile) } catch {}
  }

  // 3. 磁盘文件缺失且内存缓存也为空时，报错拒绝
  store.apply('s1', 'dispatch-start', { id: 'gf-empty', role: 'cold' })
  store.apply('s1', 'dispatch-done', {
    id: 'gf-empty',
    role: 'cold',
    reportPath: join(os.tmpdir(), 'missing.md'),
    report: null,
  })
  const resEmpty = store.readReport('s1', 'gf-empty')
  assert.equal(resEmpty.ok, false)
  assert.match(resEmpty.error, /no report content available/)
})

test('按需读取：非法 UTF-8 字节膨胀严格约束在 256KB 预算内，不超额', () => {
  const store = createPetStore()
  const tmpFile = join(os.tmpdir(), `egm-invalid-utf8-${Date.now()}.bin`)
  try {
    // 写入全是非法 UTF-8 字节 (0xFF)，每个字节经由 StringDecoder 会变为 3 字节的 U+FFFD
    const rawBuf = Buffer.alloc(200 * 1024, 0xff)
    fs.writeFileSync(tmpFile, rawBuf)

    store.apply('s1', 'dispatch-start', { id: 'gf-invalid-utf8', role: 'logic' })
    store.apply('s1', 'dispatch-done', {
      id: 'gf-invalid-utf8',
      role: 'logic',
      reportPath: tmpFile,
      report: 'backup',
    })

    const res = store.readReport('s1', 'gf-invalid-utf8')
    assert.equal(res.ok, true)
    assert.equal(res.value.id, 'gf-invalid-utf8')
    assert.equal(res.value.source, 'disk')
    const outBytes = Buffer.byteLength(res.value.content, 'utf8')
    assert.ok(outBytes <= MAX_REPORT_RPC_BYTES, `非法 UTF-8 替换膨胀后输出字节 (${outBytes}) 必须严格 <= ${MAX_REPORT_RPC_BYTES}`)
    assert.equal(res.value.truncated, true)
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
})

test('报告路径读取只匹配已存记录：任意路径参数不会变成文件读取，临时房间路径不被 cwd 误限', () => {
  const store = createPetStore()
  const tmpFile = join(os.tmpdir(), `egm-outside-cwd-${Date.now()}.md`)
  try {
    fs.writeFileSync(tmpFile, '临时房间外的报告正文', 'utf8')
    store.apply('s1', 'dispatch-start', { id: 'gf-outside', role: 'logic' })
    store.apply('s1', 'dispatch-done', {
      id: 'gf-outside',
      role: 'logic',
      report: '内存备份',
      reportPath: tmpFile,
    })

    // 已存记录里的真实路径可以读；不按 cwd 二次限制（报告在临时房间，可能不在当前 cwd）。
    const own = store.readReport('s1', 'gf-outside')
    assert.equal(own.ok, true)
    assert.equal(own.value.source, 'disk')
    assert.equal(own.value.content, '临时房间外的报告正文')

    // 调用方传任意路径不会被当成文件路径读取，只能匹配已存记录。
    const arbitrary = store.readReport('s1', '/etc/passwd')
    assert.equal(arbitrary.ok, false)
    assert.match(arbitrary.error, /not found/)

    // 别的会话即使知道这个已存路径也读不到。
    const cross = store.readReport('s2', tmpFile)
    assert.equal(cross.ok, false)
    assert.match(cross.error, /not found/)
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
})

test('大象快照初始为 unknown：桥未接入时不拿 idle 冒充真实状态', () => {
  const store = createPetStore()
  const pet = store.read('s1')
  assert.equal(pet.elephant.status, 'unknown')
  assert.equal(pet.elephant.known, false)
  assert.equal(pet.elephant.working, null)
  assert.equal(pet.elephant.workingOnEgm, null)
  assert.equal(pet.elephant.egm.active, false)
  assert.equal(pet.elephant.reason, 'status-bridge-unavailable')
  assert.equal(pet.elephant.bridge.attached, false)
})

test('大象真实状态进入快照；EGM 技能信号只到 prep，绝不写成 writing', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })
  store.markElephantBridge({
    attached: true,
    agentLifecycle: true,
    agentStatus: true,
    sessionEvents: true,
  })

  store.apply('s1', 'elephant-status', { status: 'running', source: 'agent/status', at: c.now() })
  let pet = store.read('s1')
  assert.equal(pet.elephant.status, 'running')
  assert.equal(pet.elephant.known, true)
  assert.equal(pet.elephant.working, true)
  assert.equal(pet.elephant.workingOnEgm, false)
  assert.equal(pet.state, 'idle', '主 Agent 在跑但还没有 EGM 信号时，EGM 状态仍是 idle')

  store.apply('s1', 'elephant-turn', { phase: 'start', turn: 1, at: c.now() })
  store.apply('s1', 'elephant-signal', {
    signal: 'skill-loaded',
    skill: 'egm-gate',
    seq: 10,
    turn: 1,
    at: c.now(),
  })
  pet = store.read('s1')
  assert.equal(pet.state, 'prep')
  assert.notEqual(pet.state, 'writing')
  assert.equal(pet.elephant.egm.active, true)
  assert.equal(pet.elephant.egm.signal, 'skill-loaded')
  assert.equal(pet.elephant.egm.skill, 'egm-gate')
  assert.equal(pet.elephant.egm.turn, 1)
  assert.equal(pet.elephant.workingOnEgm, true)
})

test('大象信号按 seq 拒绝迟到旧事件：旧技能信号不能覆盖新活动', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })
  store.markElephantBridge({ attached: true, agentLifecycle: true, agentStatus: true, sessionEvents: true })

  assert.equal(store.apply('s1', 'elephant-signal', {
    signal: 'skill-loaded',
    skill: 'egm-gate',
    seq: 20,
    at: c.now(),
  }), true)
  assert.equal(store.apply('s1', 'elephant-signal', {
    signal: 'skill-invoked',
    skill: 'egm-review',
    seq: 19,
    at: c.now(),
  }), false)
  const pet = store.read('s1')
  assert.equal(pet.elephant.egm.signal, 'skill-loaded')
  assert.equal(pet.elephant.egm.skill, 'egm-gate')
})

test('/egm-safe reset 只结束 EGM 活动，不篡改主 Agent 真实 running 状态', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })
  store.markElephantBridge({ attached: true, agentLifecycle: true, agentStatus: true, sessionEvents: true })
  store.apply('s1', 'elephant-status', { status: 'running', at: c.now() })
  store.apply('s1', 'elephant-signal', { signal: 'skill-loaded', seq: 5, at: c.now() })

  store.apply('s1', 'reset')
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.elephant.egm.active, false)
  assert.equal(pet.elephant.status, 'running', 'reset 是 EGM 许可/窗口重置，不是 Agent 生命周期事件')

  // reset 之后旧 seq 仍被拒绝，新 seq 可以重新开启 EGM 活动。
  assert.equal(store.apply('s1', 'elephant-signal', { signal: 'skill-loaded', seq: 4, at: c.now() }), false)
  assert.equal(store.apply('s1', 'elephant-signal', { signal: 'skill-loaded', seq: 6, at: c.now() }), true)
  assert.equal(store.read('s1').state, 'prep')
})

test('失活按真实 turn 判断：当前 turn 有 EGM 活动才阻止回落，running 本身不算', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })
  store.markElephantBridge({ attached: true, agentLifecycle: true, agentStatus: true, sessionEvents: true })
  store.apply('s1', 'elephant-status', { status: 'running', at: c.now() })
  store.apply('s1', 'elephant-turn', { phase: 'start', turn: 1, at: c.now() })
  store.apply('s1', 'elephant-signal', { signal: 'skill-loaded', seq: 1, turn: 1, at: c.now() })

  c.advance(PET_IDLE_AFTER_MS + 1000)
  assert.equal(store.read('s1').state, 'prep', '当前 turn 有真实 EGM 活动，不能因超时回落')

  // turn 结束后，即使 Agent 仍是 running，也不能把历史 EGM 信号当成当前工作。
  store.apply('s1', 'elephant-turn', { phase: 'end', turn: 1, at: c.now() })
  const afterEnd = store.read('s1')
  assert.equal(afterEnd.state, 'idle', '匹配 EGM turn 的 end 必须把 prep 收回 idle')
  assert.equal(afterEnd.elephant.egm.active, false, '匹配 EGM turn 的 end 必须清活动标记')
  c.advance(PET_IDLE_AFTER_MS + 1000)
  const pet = store.read('s1')
  assert.equal(pet.state, 'idle')
  assert.equal(pet.elephant.status, 'running', 'running 是真实状态，保留')
  assert.equal(pet.elephant.workingOnEgm, false)
  assert.equal(pet.elephant.egm.active, false)

  // 超时后旧 seq 仍被拒绝，新 seq 才能重新开始。
  assert.equal(store.apply('s1', 'elephant-signal', { signal: 'skill-invoked', seq: 1, at: c.now() }), false)
  assert.equal(store.apply('s1', 'elephant-signal', { signal: 'skill-invoked', seq: 2, at: c.now() }), true)
})

test('/egm kickoff 只绑定下一个真实 turn；新普通 turn 不继承历史 EGM 活动', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })
  store.markElephantBridge({ attached: true, agentLifecycle: true, agentStatus: true, sessionEvents: true })
  store.apply('s1', 'elephant-status', { status: 'running', at: c.now() })
  store.apply('s1', 'gate-opened', {
    prep: true,
    gate: { expiresAt: c.now() + 7200000, remaining: 20 },
  })

  let pet = store.read('s1')
  assert.equal(pet.state, 'prep')
  assert.equal(pet.elephant.egm.active, true)
  assert.equal(pet.elephant.egm.turn, null)
  assert.equal(pet.elephant.workingOnEgm, false, 'kickoff 还没进入真实 turn，不能声称正在做 EGM')

  store.apply('s1', 'elephant-turn', { phase: 'start', turn: 5, at: c.now() })
  pet = store.read('s1')
  assert.equal(pet.elephant.egm.turn, 5)
  assert.equal(pet.elephant.workingOnEgm, true)

  store.apply('s1', 'elephant-turn', { phase: 'end', turn: 5, at: c.now() })
  pet = store.read('s1')
  assert.equal(pet.elephant.workingOnEgm, false)
  assert.equal(pet.elephant.egm.active, false, '匹配 EGM turn 的 end 必须清活动标记')
  assert.equal(pet.state, 'idle', '匹配 EGM turn 的 end 必须把 prep 收回 idle')

  store.apply('s1', 'elephant-turn', { phase: 'start', turn: 6, at: c.now() })
  pet = store.read('s1')
  assert.equal(pet.elephant.egm.active, false, '普通新 turn 必须切断历史 EGM 关联')
  assert.equal(pet.elephant.workingOnEgm, false)
  assert.equal(pet.state, 'idle')
})

test('只清理匹配当前 EGM turn 的 end；并发金鱼与历史报告不被误伤', () => {
  const c = clock()
  const store = createPetStore({ now: c.now })
  store.markElephantBridge({ attached: true, agentLifecycle: true, agentStatus: true, sessionEvents: true })

  // A) 不匹配的 end 不能清当前 EGM 活动。
  store.apply('s1', 'elephant-status', { status: 'running', at: c.now() })
  store.apply('s1', 'elephant-turn', { phase: 'start', turn: 1, at: c.now() })
  store.apply('s1', 'elephant-signal', { signal: 'skill-loaded', seq: 1, turn: 1, at: c.now() })
  store.apply('s1', 'elephant-turn', { phase: 'end', turn: 99, at: c.now() })
  let pet = store.read('s1')
  assert.equal(pet.elephant.egm.active, true, '别的 turn 结束不能误伤当前 EGM 活动')
  assert.equal(pet.state, 'prep')

  // B) 匹配的 end 清活动、prep 回 idle，但 running 金鱼与历史报告保持。
  store.apply('s1', 'dispatch-start', { id: 'gf-running', role: 'logic' })
  assert.equal(store.read('s1').state, 'dispatch')
  store.apply('s1', 'elephant-turn', { phase: 'end', turn: 1, at: c.now() })
  pet = store.read('s1')
  assert.equal(pet.state, 'dispatch', 'running 金鱼必须保留 dispatch')
  assert.equal(pet.goldfish[0].status, 'running')
  assert.equal(pet.elephant.egm.active, false)

  store.apply('s1', 'dispatch-done', { id: 'gf-running', role: 'logic', report: 'r', reportPath: '/tmp/r.md' })
  assert.equal(store.read('s1').state, 'crit')
  assert.equal(store.read('s1').count, 1)

  store.apply('s1', 'elephant-turn', { phase: 'start', turn: 2, at: c.now() })
  store.apply('s1', 'elephant-signal', { signal: 'skill-invoked', seq: 2, turn: 2, at: c.now() })
  store.apply('s1', 'elephant-turn', { phase: 'end', turn: 2, at: c.now() })
  pet = store.read('s1')
  assert.equal(pet.state, 'crit', '历史报告对应的 crit 不能被 EGM turn 结束改写')
  assert.equal(pet.count, 1)
  assert.equal(pet.goldfish.length, 1)
  assert.equal(pet.elephant.egm.active, false)

  // C) 新 turn 已开始后，旧 turn 的迟到 end 不能清掉新 EGM 活动。
  store.apply('s1', 'elephant-turn', { phase: 'start', turn: 3, at: c.now() })
  store.apply('s1', 'elephant-signal', { signal: 'skill-loaded', seq: 3, turn: 3, at: c.now() })
  store.apply('s1', 'elephant-turn', { phase: 'end', turn: 2, at: c.now() })
  pet = store.read('s1')
  assert.equal(pet.elephant.egm.active, true, '旧 turn 的迟到 end 不能误伤当前 EGM 活动')
  assert.equal(pet.elephant.egm.turn, 3)

  // D) 热接入错过 turn/start：currentTurn 未知，但 egm.turn 能证明是同一个 turn，end 仍应清理。
  store.apply('hot', 'elephant-signal', { signal: 'skill-loaded', seq: 10, turn: 7, at: c.now() })
  assert.equal(store.read('hot').elephant.egm.active, true)
  store.apply('hot', 'elephant-turn', { phase: 'end', turn: 7, at: c.now() })
  pet = store.read('hot')
  assert.equal(pet.elephant.egm.active, false)
  assert.equal(pet.state, 'idle')
})

test('dispatch-start 同时记录真实 EGM 活动，但顶层状态仍由金鱼 dispatch 主导', () => {
  const store = createPetStore()
  store.apply('s1', 'dispatch-start', { id: 'gf-real', role: 'logic' })
  const pet = store.read('s1')
  assert.equal(pet.state, 'dispatch')
  assert.equal(pet.elephant.egm.active, true)
  assert.equal(pet.elephant.egm.signal, 'dispatch-start')
  assert.equal(pet.goldfish[0].status, 'running')
})

test('路由快照包含大象字段，且只返回请求会话的状态', async () => {
  const store = createPetStore()
  store.markElephantBridge({ attached: true, agentLifecycle: true, agentStatus: true, sessionEvents: true })
  store.apply('a', 'elephant-status', { status: 'running', source: 'agent/status' })
  store.apply('a', 'elephant-signal', { signal: 'skill-loaded', skill: 'egm-gate', seq: 1 })
  store.apply('b', 'elephant-status', { status: 'idle', source: 'agent/status' })

  const { ctx, routes } = fakeConnectionCtx()
  registerPetRoutes(ctx, store)

  const a = await (await callRoute(routes[0], { payload: { sessionId: 'a' } })).json()
  assert.equal(a.result.ok, true)
  assert.equal(a.result.value.elephant.status, 'running')
  assert.equal(a.result.value.elephant.egm.skill, 'egm-gate')
  assert.equal(a.result.value.elephant.bridge.attached, true)

  const b = await (await callRoute(routes[0], { payload: { sessionId: 'b' } })).json()
  assert.equal(b.result.value.elephant.status, 'idle')
  assert.equal(b.result.value.elephant.egm.active, false, 'A 的 EGM 活动绝不能泄漏给 B')

  const anonymous = await (await callRoute(routes[0], { payload: {} })).json()
  assert.equal(anonymous.result.value.sessionId, null)
  assert.equal(anonymous.result.value.elephant.status, 'unknown')
})
