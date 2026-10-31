// 端到端模块集成测试：egm_dispatch（registerDispatchTool）真实派发事件 → createPetStore →
// registerPetRoutes 的真实 JSON 路由读取。
//
// 范围声明（别把它当成 DSH 验收）：子代理服务是本地 mock，没有真的 spawn 子会话，
// 也没有起 DSH 宿主。本测试只证明这三个模块在进程内按真实接口拼起来后行为正确：
//   - /egm-open、/egm-unsafe 命令 handler 真实打开窗口与许可；
//   - egm_dispatch 的 execute 真实走门控、建一次性房间、收报告、落盘校验；
//   - dispatch-start / dispatch-done / dispatch-failed 事件按 index.js 的接线方式进入状态表；
//   - 客户端形状的 { type:'client-request', rpcId, method, payload } JSON 请求打到注册的路由。
//
// 覆盖：running→done 复用同一真实 id 且报告可回读、会话严格隔离（含并发跨会话）、
// 失败不冒充成功（start 后失败 / 空报告失败）、未启动的失败不伪造记录。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PET_METHOD,
  PET_REPORT_METHOD,
  PET_REPORT_ROUTE_PATH,
  PET_ROUTE_PATH,
  createPetStore,
  registerPetRoutes,
} from '../lib/pet-state.js'
import {
  registerDispatchTool,
  registerEgmOpenCommand,
  registerEgmUnsafeCommand,
} from '../lib/dispatch.js'

/** 临时工作区：只放一份图纸；房间也建在它下面，测完整个删掉，不碰用户目录。 */
async function makeWorkspace(t) {
  const work = await mkdtemp(join(tmpdir(), 'egm-pet-roundtrip-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  await mkdir(join(work, '.egm'), { recursive: true })
  await writeFile(join(work, '.egm', 'design.md'), '# 图纸\n\n本轮集成测试用的设计文档正文。\n', 'utf8')
  return { work, docPath: '.egm/design.md' }
}

/** 假 agent：带稳定 session id 与工作目录，命令门控和许可表都按这个对象取条目。 */
function fakeAgent(id, cwd) {
  return {
    session: { header: { id, cwd } },
    followup() {},
  }
}

/** 手动控制完成时机的 Promise，用来在 running 中途读路由。 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** mock 子代理：按父会话绑定返回值；记录调用，供断言并发与门控。 */
function mockSubagents() {
  const calls = []
  const planners = new Map()
  const startWaiters = []
  const stats = { disposed: 0, terminated: 0 }
  const subagents = {
    calls,
    stats,
    /** 给某个父会话绑定一个结果工厂；工厂可返回报告字符串、Promise 或抛错。 */
    planFor(parent, factory) {
      planners.set(parent, factory)
      return subagents
    },
    /** 等某会话真的走到 startActivation（房间准备是异步的，不能只看 dispatch-start）。 */
    waitForStart(parent) {
      if (calls.some((call) => call.request.parent === parent)) return Promise.resolve()
      return new Promise((resolve) => startWaiters.push({ parent, resolve }))
    },
    async startActivation(spec) {
      calls.push(spec)
      for (let index = startWaiters.length - 1; index >= 0; index -= 1) {
        if (startWaiters[index].parent === spec.request.parent) {
          startWaiters.splice(index, 1)[0].resolve()
        }
      }
      // 按父会话取，而不是按调用顺序取：并发派活时先后顺序不确定，顺序队列会串。
      const factory = planners.get(spec.request.parent) ?? (() => '默认报告')
      return {
        childId: `child-${calls.length}`,
        result: Promise.resolve().then(factory),
        async terminate() {
          stats.terminated += 1
        },
        async dispose() {
          stats.disposed += 1
        },
      }
    },
  }
  return subagents
}

/**
 * 按 lib/index.js 的接线方式拼装：同一个 onPetEvent 同时接命令、工具与状态表。
 * 路由则注册到假的 connection.fetch，返回真实的 route.fetch 供 JSON 请求调用。
 */
function createHarness() {
  const store = createPetStore()
  const events = []
  const waiters = []

  const onPetEvent = (event) => {
    if (!event || typeof event.type !== 'string') return false
    events.push(event)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].match(event)) {
        const waiter = waiters.splice(index, 1)[0]
        waiter.resolve(event)
      }
    }
    return store.apply(event.sessionId, event.type, event)
  }

  const waitFor = (match) => new Promise((resolve) => waiters.push({ match, resolve }))

  const routes = []
  assert.equal(
    registerPetRoutes({ connection: { fetch: { register: (route) => routes.push(route) } } }, store),
    true,
    '路由应注册成功',
  )
  const stateRoute = routes.find((route) => route.path === PET_ROUTE_PATH)
  const reportRoute = routes.find((route) => route.path === PET_REPORT_ROUTE_PATH)
  assert.ok(stateRoute, '应有状态路由')
  assert.ok(reportRoute, '应有报告路由')

  const commands = new Map()
  const commandCtx = { commands: { register: (definition) => commands.set(definition.name, definition) } }
  registerEgmOpenCommand(commandCtx, { onEvent: onPetEvent })
  registerEgmUnsafeCommand(commandCtx)

  const mock = mockSubagents()
  let tool = null
  registerDispatchTool(
    {
      tools: { register: (definition) => (tool = definition) },
      get: (name) => (name === 'subagents' ? mock : null),
    },
    { onEvent: onPetEvent },
  )
  assert.ok(tool, '应注册 egm_dispatch 工具')

  /** 按 Connection 客户端的信封形状发一次真实 JSON 请求。 */
  const rpc = async (route, method, payload) => {
    const response = await route.fetch(
      new Request('http://127.0.0.1' + route.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'roundtrip-1', method, payload }),
      }),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, 'roundtrip-1')
    return body.result
  }

  const callState = (sessionId) =>
    rpc(stateRoute, PET_METHOD, sessionId === undefined ? {} : { sessionId })
  const callReport = (sessionId, query, field = 'goldfishId') =>
    rpc(reportRoute, PET_REPORT_METHOD, { sessionId, [field]: query })

  /** 走用户命令开窗 + 许可（命令 handler 是唯一真实入口）。 */
  const openFor = (agent) => {
    assert.equal(commands.get('egm-open').handler({ agent }).kind, 'success')
    assert.equal(
      commands.get('egm-unsafe').handler({ agent, rawInput: '确认无隔离' }).kind,
      'success',
    )
  }

  return {
    store,
    events,
    waitFor,
    routes,
    stateRoute,
    reportRoute,
    commands,
    mock,
    tool,
    callState,
    callReport,
    openFor,
  }
}

const REPORT_A = '# 评审报告（A 会话）\n\n阻塞 | design.md:1 | 真实 id 与报告必须一一对应 | 返工\n通过项：无。\n'
const REPORT_B = '# 评审报告（B 会话）\n\n建议 | design.md:3 | 并发会话不得串读 | 采纳\n'

test('端到端：真实派发事件进状态表，running→done 复用同一 id，报告经路由按 id 回读', async (t) => {
  const workspace = await makeWorkspace(t)
  const harness = createHarness()
  const agent = fakeAgent('session-A', workspace.work)
  harness.openFor(agent)

  // /egm-open 的 gate-opened 事件已按真实形状进入状态表。
  const opened = await harness.callState('session-A')
  assert.equal(opened.ok, true)
  assert.equal(opened.value.gate.open, true)
  assert.equal(opened.value.gate.remaining, 20)
  assert.equal(opened.value.state, 'idle')

  const started = deferred()
  harness.mock.planFor(agent, () => started.promise)

  const pending = harness.tool.execute({ docPath: workspace.docPath, role: 'logic' }, { agent })
  const startEvent = await harness.waitFor(
    (event) => event.type === 'dispatch-start' && event.sessionId === 'session-A',
  )
  assert.match(startEvent.id, /^gf-logic-\d+-[a-z0-9]+$/, '派发开始必须带真实金鱼 id')

  // running 中途读路由：状态在跑、报告还没有、正文绝不下发。
  const running = await harness.callState('session-A')
  assert.equal(running.ok, true)
  assert.equal(running.value.sessionId, 'session-A')
  assert.equal(running.value.state, 'dispatch')
  assert.equal(running.value.count, 0)
  assert.equal(running.value.goldfish.length, 1)
  assert.equal(running.value.goldfish[0].id, startEvent.id)
  assert.equal(running.value.goldfish[0].status, 'running')
  assert.equal(running.value.goldfish[0].hasReport, false)
  assert.equal(running.value.goldfish[0].reportPath, null)
  assert.equal(running.value.goldfish[0].report, undefined, '轮询快照不返回报告正文')
  assert.equal(running.value.gate.remaining, 19, '真实派发开始后 gate 额度应被消费一次')

  // running 时按 id 读报告：明确拒绝，而不是提前给空内容。
  const early = await harness.callReport('session-A', startEvent.id)
  assert.equal(early.ok, false)
  assert.match(early.error.message, /still running/)

  // 子代理交卷后，done 事件必须复用开始时的同一个 id。
  started.resolve(REPORT_A)
  const result = await pending
  assert.equal(result.ok, true, '模拟子代理成功交卷时派发应成功')
  assert.equal(result.goldfishId, startEvent.id, '成功结果必须复用 dispatch-start 的真实 id')
  assert.equal(result.strictGoldfishReview, false, '非隔离评审必须诚实标注，不得冒充严格金鱼评审')

  const done = await harness.callState('session-A')
  assert.equal(done.value.sessionId, 'session-A')
  assert.equal(done.value.state, 'crit')
  assert.equal(done.value.count, 1)
  assert.equal(done.value.role, 'logic')
  assert.equal(done.value.goldfish.length, 1)
  const record = done.value.goldfish[0]
  assert.equal(record.id, startEvent.id, 'done 记录必须是同一个真实 id')
  assert.equal(record.status, 'done')
  assert.equal(typeof record.startedAt, 'number')
  assert.equal(typeof record.finishedAt, 'number')
  assert.ok(record.finishedAt >= record.startedAt)
  assert.equal(record.hasReport, true)
  assert.equal(record.reportPath, result.reportPath)
  assert.equal(record.report, undefined, '轮询快照不返回报告正文')

  // 落盘文件与报告路由内容必须一致。
  assert.equal(await readFile(result.reportPath, 'utf8'), REPORT_A)
  const content = await harness.callReport('session-A', startEvent.id)
  assert.equal(content.ok, true)
  assert.equal(content.value.id, startEvent.id)
  assert.equal(content.value.content, REPORT_A)
  assert.equal(content.value.reportPath, result.reportPath)
  assert.equal(content.value.truncated, false)
  assert.equal(content.value.source, 'disk')

  // 事件序列就是真实发生的事：开窗 → 开始 → 完成，没有伪造中间态。
  const sessionEvents = harness.events.filter((event) => event.sessionId === 'session-A')
  assert.deepEqual(sessionEvents.map((event) => event.type), ['gate-opened', 'dispatch-start', 'dispatch-done'])
  assert.equal(sessionEvents[1].id, startEvent.id)
  assert.equal(sessionEvents[2].id, startEvent.id)
  assert.equal(sessionEvents[2].reportPath, result.reportPath)
  assert.equal(sessionEvents[2].report, REPORT_A)
})

test('会话隔离：并发跨会话各读各的，未知/缺省 sessionId 绝不回退最近会话', async (t) => {
  const workspace = await makeWorkspace(t)
  const harness = createHarness()
  const agentA = fakeAgent('session-A', workspace.work)
  const agentB = fakeAgent('session-B', workspace.work)
  harness.openFor(agentA)
  harness.openFor(agentB)

  // A 卡在 running，B 立即完成——并发下最容易串话的时机。
  const holdA = deferred()
  harness.mock.planFor(agentA, () => holdA.promise)
  harness.mock.planFor(agentB, () => REPORT_B)

  const pendingA = harness.tool.execute({ docPath: workspace.docPath, role: 'logic' }, { agent: agentA })
  const startA = await harness.waitFor(
    (event) => event.type === 'dispatch-start' && event.sessionId === 'session-A',
  )
  const resultB = await harness.tool.execute({ docPath: workspace.docPath, role: 'logic' }, { agent: agentB })
  assert.equal(resultB.ok, true)
  assert.notEqual(resultB.goldfishId, startA.id, '并发派活必须拿到不同 id')

  const snapshotA = await harness.callState('session-A')
  const snapshotB = await harness.callState('session-B')
  assert.equal(snapshotA.value.sessionId, 'session-A')
  assert.equal(snapshotB.value.sessionId, 'session-B')
  assert.equal(snapshotA.value.state, 'dispatch')
  assert.equal(snapshotB.value.state, 'crit')
  assert.equal(snapshotA.value.goldfish.length, 1)
  assert.equal(snapshotB.value.goldfish.length, 1)
  assert.equal(snapshotA.value.goldfish[0].id, startA.id)
  assert.equal(snapshotA.value.goldfish[0].status, 'running')
  assert.equal(snapshotB.value.goldfish[0].id, resultB.goldfishId)
  assert.equal(snapshotB.value.goldfish[0].status, 'done')
  assert.equal(snapshotA.value.goldfish.some((g) => g.id === resultB.goldfishId), false, 'A 不应看到 B 的金鱼')
  assert.equal(snapshotB.value.goldfish.some((g) => g.id === startA.id), false, 'B 不应看到 A 的金鱼')

  // 跨会话按 id 读报告：即使知道对方 id，也只能拿到 not found。
  const crossId = await harness.callReport('session-B', startA.id)
  assert.equal(crossId.ok, false)
  assert.match(crossId.error.message, /not found/)
  const crossB = await harness.callReport('session-A', resultB.goldfishId)
  assert.equal(crossB.ok, false)
  assert.match(crossB.error.message, /not found/)

  // 未传 sessionId：返回空会话，绝不猜「最近一个会话」。
  const anonymous = await harness.callState()
  assert.equal(anonymous.ok, true)
  assert.equal(anonymous.value.sessionId, null)
  assert.equal(anonymous.value.state, 'idle')
  assert.equal(anonymous.value.count, 0)
  assert.deepEqual(anonymous.value.goldfish, [])

  // 传了不存在的 sessionId：同样是空闲空表，不串读。
  const stranger = await harness.callState('session-nobody')
  assert.equal(stranger.value.sessionId, 'session-nobody')
  assert.equal(stranger.value.state, 'idle')
  assert.deepEqual(stranger.value.goldfish, [])

  // 报告路由缺 sessionId 也拒绝，不靠 goldfishId 全局搜。
  const noSession = await harness.callReport(undefined, startA.id)
  assert.equal(noSession.ok, false)
  assert.match(noSession.error.message, /sessionId is required/)

  // A 收卷后仍只影响自己；B 的快照保持不变。
  holdA.resolve(REPORT_A)
  const resultA = await pendingA
  assert.equal(resultA.ok, true)
  assert.equal(resultA.goldfishId, startA.id)

  const doneA = await harness.callState('session-A')
  const stillB = await harness.callState('session-B')
  assert.equal(doneA.value.state, 'crit')
  assert.equal(doneA.value.count, 1)
  assert.equal(doneA.value.goldfish[0].id, startA.id)
  assert.equal(doneA.value.goldfish[0].status, 'done')
  assert.equal(stillB.value.count, 1)
  assert.equal(stillB.value.goldfish[0].id, resultB.goldfishId)
  assert.deepEqual(stillB.value.goldfish, snapshotB.value.goldfish, 'B 的记录不应被 A 的完成事件改写')

  // 知道 A 的 reportPath 也不能从 B 会话读走内容。
  const crossPath = await harness.callReport('session-B', resultA.reportPath, 'reportPath')
  assert.equal(crossPath.ok, false)
  assert.match(crossPath.error.message, /not found/)
  const ownReport = await harness.callReport('session-A', startA.id)
  assert.equal(ownReport.ok, true)
  assert.equal(ownReport.value.content, REPORT_A)
})

test('失败不冒充成功：start 后失败 / 空报告都记 failed，不计数、不出报告；未启动失败不造记录', async (t) => {
  const workspace = await makeWorkspace(t)
  const harness = createHarness()

  // 1) 真正启动后子代理崩溃：有 dispatch-start，随后 dispatch-failed(didStart=true)。
  const agentF = fakeAgent('session-F', workspace.work)
  harness.openFor(agentF)
  const holdF = deferred()
  harness.mock.planFor(agentF, () => holdF.promise)

  const pendingF = harness.tool.execute({ docPath: workspace.docPath, role: 'logic' }, { agent: agentF })
  const startF = await harness.waitFor(
    (event) => event.type === 'dispatch-start' && event.sessionId === 'session-F',
  )
  const runningF = await harness.callState('session-F')
  assert.equal(runningF.value.state, 'dispatch')
  assert.equal(runningF.value.goldfish[0].id, startF.id)
  assert.equal(runningF.value.goldfish[0].status, 'running')

  // 等子代理服务真的被调用、并让 dispatch 挂上结果处理器后再拒绝；
  // 否则拒绝会先成为未处理拒绝，测试运行器会把它记成失败。
  await harness.mock.waitForStart(agentF)
  await new Promise((resolve) => setTimeout(resolve, 0))
  holdF.reject(new Error('金鱼内部崩溃（模拟）'))
  const failedF = await pendingF
  assert.equal(failedF.ok, false, '子代理崩溃绝不能返回成功')
  assert.equal(failedF.code, 'E_DISPATCH')

  const afterF = await harness.callState('session-F')
  assert.equal(afterF.value.state, 'idle', '没有成功记录时应回到 idle，而不是 crit')
  assert.notEqual(afterF.value.state, 'crit', '失败不得被当成一次完成')
  assert.equal(afterF.value.count, 0, '失败不得增加完成计数')
  assert.equal(afterF.value.goldfish.length, 1)
  const recordF = afterF.value.goldfish[0]
  assert.equal(recordF.id, startF.id, '失败记录仍必须是那次真实启动的 id')
  assert.equal(recordF.status, 'failed')
  assert.notEqual(recordF.status, 'done', '失败不得冒充 done')
  assert.match(recordF.error, /崩溃/)
  assert.equal(recordF.hasReport, false)
  assert.equal(recordF.reportPath, null)
  assert.equal(recordF.report, undefined)

  const reportF = await harness.callReport('session-F', startF.id)
  assert.equal(reportF.ok, false, '失败的金鱼不能通过报告路由返回正文')
  assert.match(reportF.error.message, /崩溃/)

  const eventsF = harness.events.filter((event) => event.sessionId === 'session-F')
  assert.deepEqual(eventsF.map((event) => event.type), ['gate-opened', 'dispatch-start', 'dispatch-failed'])
  assert.equal(eventsF[2].id, startF.id)
  assert.equal(eventsF[2].didStart, true, '失败事件必须诚实标注确实启动过')
  assert.match(eventsF[2].error, /崩溃/)

  // 2) 空报告：已启动但没正文，同样算失败，不能空报告冒充通过。
  const agentH = fakeAgent('session-H', workspace.work)
  harness.openFor(agentH)
  harness.mock.planFor(agentH, () => '')
  const emptyH = await harness.tool.execute({ docPath: workspace.docPath, role: 'logic' }, { agent: agentH })
  assert.equal(emptyH.ok, false)
  assert.equal(emptyH.code, 'E_EMPTY_REPORT')

  const afterH = await harness.callState('session-H')
  assert.equal(afterH.value.state, 'idle')
  assert.equal(afterH.value.count, 0)
  assert.equal(afterH.value.goldfish.length, 1)
  assert.equal(afterH.value.goldfish[0].status, 'failed')
  assert.match(afterH.value.goldfish[0].error, /没有返回正文/)
  assert.equal(afterH.value.goldfish[0].hasReport, false)
  const reportH = await harness.callReport('session-H', afterH.value.goldfish[0].id)
  assert.equal(reportH.ok, false)
  assert.match(reportH.error.message, /没有返回正文/)

  // 3) 未开窗就失败：dispatch-failed(didStart=false) 不得凭空造出 running/done 记录。
  const agentG = fakeAgent('session-G', workspace.work)
  const blocked = await harness.tool.execute({ docPath: workspace.docPath, role: 'logic' }, { agent: agentG })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'E_GATE_NOT_OPEN')

  const afterG = await harness.callState('session-G')
  assert.equal(afterG.value.state, 'idle')
  assert.equal(afterG.value.count, 0)
  assert.deepEqual(afterG.value.goldfish, [], '未真正启动的失败不得伪造金鱼记录')
  assert.equal(afterG.value.gate.open, false)

  const eventsG = harness.events.filter((event) => event.sessionId === 'session-G')
  assert.deepEqual(eventsG.map((event) => event.type), ['dispatch-failed'])
  assert.equal(eventsG[0].didStart, false)
  assert.equal(eventsG[0].id.startsWith('gf-logic-'), true)

  // 三次调用里只有 F/H 真正启动了子代理；G 在门控处就被挡住。
  assert.equal(harness.mock.calls.length, 2, '未开窗的派发不得触碰子代理服务')
})
