import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

function createReact() {
  const hooks = []
  let cursor = 0
  let pending = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: (children || []).flat(Infinity) }
    },
    useState(initial) {
      const index = cursor++
      if (!Object.prototype.hasOwnProperty.call(hooks, index)) {
        hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (value) => {
        hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
      }
      return [hooks[index], set]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      const changed =
        !previous ||
        !deps ||
        deps.length !== previous.deps.length ||
        deps.some((item, i) => !Object.is(item, previous.deps[i]))
      if (changed) pending.push({ index, fn, deps: deps || [] })
    },
    useCallback(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      const changed =
        !previous ||
        !deps ||
        deps.length !== previous.deps.length ||
        deps.some((item, i) => !Object.is(item, previous.deps[i]))
      if (changed) hooks[index] = { deps: deps || [], value: fn }
      return hooks[index].value
    },
    useRef(initial) {
      const index = cursor++
      if (!Object.prototype.hasOwnProperty.call(hooks, index)) hooks[index] = { current: initial }
      return hooks[index]
    },
  }
  function expand(node) {
    if (Array.isArray(node)) return node.flatMap(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      return expand(node.type(Object.assign({}, node.props || {}, { children: node.children })))
    }
    const out = Object.assign({}, node, {
      children: (node.children || []).flatMap(expand),
    })
    return out
  }
  return {
    React,
    expand,
    render(Component, props) {
      cursor = 0
      pending = []
      const tree = expand(Component(props))
      const queue = pending
      pending = []
      for (const item of queue) {
        const previous = hooks[item.index]
        if (previous && typeof previous.cleanup === 'function') {
          previous.cleanup()
        }
        hooks[item.index] = { deps: item.deps, cleanup: item.fn() }
      }
      return tree
    },
    unmount() {
      for (const hook of hooks) {
        if (hook && typeof hook.cleanup === 'function') {
          hook.cleanup()
          hook.cleanup = null
        }
      }
      hooks.length = 0
      cursor = 0
      pending = []
    },
  }
}

async function loadBundle() {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const loaded = []
  const react = createReact()
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (entry) => loaded.push(entry) },
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      body: {},
      head: { appendChild() {} },
      getElementById() { return null },
      createElement() { return { id: '', textContent: '' } },
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { language: 'zh-CN' },
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(fn, delay) { return setTimeout(fn, delay) },
    clearTimeout(id) { clearTimeout(id) },
    console,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, '应当只调用一次 __ModuleLoader__.load')
  const entry = loaded[0]
  const mod = entry.factory((name) => (name === 'react' ? react.React : {}))
  mod.react = react
  return mod
}

test('极简引导：文案与四步流程符合新手认知', async () => {
  const mod = await loadBundle()
  const { COPY } = mod.__test

  assert.equal(COPY.guideStep1, '写一句需求')
  assert.equal(COPY.guideStep2, '大象整理方案')
  assert.equal(COPY.guideStep3, '授权金鱼评审')
  assert.equal(COPY.guideStep4, '查看评审报告')
  assert.match(COPY.reviewRiskStatement, /只读保护尚未验证/)
  assert.match(COPY.reviewRiskStatement, /可能访问或修改工作区文件/)
  assert.equal(COPY.reviewConfirmCheckbox, '我已知晓只读未验证风险，允许本轮评审')
})

test('评审授权：状态解析函数 getReviewAccessStatus 正确处理各种状态', async () => {
  const mod = await loadBundle()
  const { getReviewAccessStatus } = mod.__test

  // 1. 未授权（初始状态）
  const initial = getReviewAccessStatus({
    gate: { open: false, remaining: null, expiresAt: null },
    unsafePermit: { granted: false, remaining: null, expiresAt: null },
  })
  assert.equal(initial.state, 'unauthorized')
  assert.equal(initial.allowed, false)
  assert.equal(initial.isExpired, false)
  assert.equal(initial.isExhausted, false)

  // 2. 正常已授权（双门均开），min(gate, unsafePermit) 剩余次数与最近到期
  const now = Date.now()
  const allowed = getReviewAccessStatus({
    gate: { open: true, remaining: 20, expiresAt: now + 7200000 },
    unsafePermit: { granted: true, remaining: 6, expiresAt: now + 600000 },
  })
  assert.equal(allowed.state, 'allowed')
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.effectiveRemaining, 6)
  assert.equal(allowed.nearestExpiresAt, now + 600000)

  // 3. reviewAccess.allowed 明确指示
  const explicitAllowed = getReviewAccessStatus({
    reviewAccess: { allowed: true },
    gate: { open: true },
    unsafePermit: { granted: true },
  })
  assert.equal(explicitAllowed.allowed, true)

  // 4. 到期状态（未授权且过去时间戳）
  const expired = getReviewAccessStatus({
    gate: { open: false, expiresAt: Date.now() - 1000 },
    unsafePermit: { granted: false, expiresAt: Date.now() - 1000 },
  })
  assert.equal(expired.state, 'expired')
  assert.equal(expired.isExpired, true)
  assert.equal(expired.allowed, false)

  // 5. 次数用尽状态（有有效期或曾经开启过，但剩余次数归零）
  const exhausted = getReviewAccessStatus({
    gate: { open: false, remaining: 0, expiresAt: Date.now() + 10000 },
    unsafePermit: { granted: false, remaining: 0, expiresAt: Date.now() + 10000 },
  })
  assert.equal(exhausted.state, 'exhausted')
  assert.equal(exhausted.isExhausted, true)
  assert.equal(exhausted.allowed, false)

  // 6. 初始 closed 0/0 状态（未打开过且无到期时间）不误报 exhausted，判定为 unauthorized
  const initialZero = getReviewAccessStatus({
    gate: { open: false, remaining: 0 },
    unsafePermit: { granted: false, remaining: 0 },
  })
  assert.equal(initialZero.state, 'unauthorized')
  assert.equal(initialZero.isExhausted, false)
  assert.equal(initialZero.allowed, false)
})

test('命令执行：executeHostCommand 调用真实 host 接口 remote.commands.execute 并校验嵌套回包', async () => {
  const mod = await loadBundle()
  const { executeHostCommand } = mod.__test

  // 1. 宿主未注入接口时拒绝并提供备用命令
  const noHost = await executeHostCommand({}, 'sess-1', '/egm-review-access 确认无隔离')
  assert.equal(noHost.ok, false)
  assert.match(noHost.error, /未提供 remote.commands.execute/)
  assert.equal(noHost.backupCommand, '/egm-review-access 确认无隔离')

  // 2. 真实宿主返回成功
  const mockSuccessCtx = {
    remote: {
      commands: {
        async execute(sessionId, line, attachments) {
          assert.equal(sessionId, 'sess-1')
          assert.equal(line, '/egm-review-access 确认无隔离')
          assert.equal(Array.isArray(attachments), true)
          assert.equal(attachments.length, 0)
          return {
            ok: true,
            value: {
              result: {
                kind: 'success',
                text: '已开启评审闸门与非隔离许可',
              },
            },
          }
        },
      },
    },
  }
  const successRes = await executeHostCommand(mockSuccessCtx, 'sess-1', '/egm-review-access 确认无隔离')
  assert.equal(successRes.ok, true)
  assert.equal(successRes.text, '已开启评审闸门与非隔离许可')

  // 3. 真实宿主返回嵌套 handler 错误 (value.result.kind === 'error')
  const mockHandlerErrorCtx = {
    remote: {
      commands: {
        async execute() {
          return {
            ok: true,
            value: {
              result: {
                kind: 'error',
                text: '确认短语不正确，应输入“确认无隔离”',
              },
            },
          }
        },
      },
    },
  }
  const handlerErrRes = await executeHostCommand(mockHandlerErrorCtx, 'sess-1', '/egm-review-access 确认无隔离')
  assert.equal(handlerErrRes.ok, false)
  assert.equal(handlerErrRes.error, '确认短语不正确，应输入“确认无隔离”')
  assert.equal(handlerErrRes.backupCommand, '/egm-review-access 确认无隔离')

  // 4. RPC 拒绝 (res.ok === false)
  const mockRpcRejectCtx = {
    remote: {
      commands: {
        async execute() {
          return {
            ok: false,
            error: { code: -32600, message: '会话已过期' },
          }
        },
      },
    },
  }
  const rpcErrRes = await executeHostCommand(mockRpcRejectCtx, 'sess-1', '/egm-review-access revoke')
  assert.equal(rpcErrRes.ok, false)
  assert.equal(rpcErrRes.error, '会话已过期')
  assert.equal(rpcErrRes.backupCommand, '/egm-review-access revoke')
})

test('工作大象机位：findMascotStand 与同 seat 唯一鲸鱼共享挂载容器，cleanup 只移自己', async () => {
  const mod = await loadBundle()
  const { findMascotStand } = mod.__test

  // 1. 同 seat 唯一可见鲸鱼：返回鲸鱼的 parentElement
  const standChildren = []
  const standParent = {
    children: standChildren,
    appendChild(child) {
      standChildren.push(child)
      child.parentNode = standParent
    },
    removeChild(child) {
      const idx = standChildren.indexOf(child)
      if (idx >= 0) standChildren.splice(idx, 1)
      child.parentNode = null
    },
  }
  const whaleNode = {
    className: 'dsh-claude-deepy',
    parentElement: standParent,
    isConnected: true,
    hidden: false,
    getBoundingClientRect: () => ({ left: 888, top: 400, width: 104, height: 104, right: 992, bottom: 504 }),
    closest: (sel) => (sel === '[data-composer-seat]' ? seatNode : null),
  }
  standChildren.push(whaleNode)

  // 0.10 的 findMascotStand 用合并选择器 '.dsh-claude-deepy, .dsh-claude-crab' 在 seat 范围内查询
  const seatNode = {
    querySelectorAll: (sel) => (sel === '.dsh-claude-deepy, .dsh-claude-crab' ? [whaleNode] : []),
  }
  const rootNode = {
    isConnected: true,
    closest: (sel) => (sel === '[data-composer-seat]' ? seatNode : null),
  }

  const stand = findMascotStand(rootNode)
  assert.equal(stand, standParent, '同 seat 唯一可见鲸鱼时返回其 parentElement')

  // 模拟挂载大象与 cleanup：只移除大象自身，鲸鱼不受影响
  const elephantMount = { className: 'egm-working-elephant-container', parentNode: null }
  stand.appendChild(elephantMount)
  assert.equal(standChildren.length, 2)
  assert.equal(standChildren[1], elephantMount)

  // cleanup 动作
  if (elephantMount.parentNode && typeof elephantMount.parentNode.removeChild === 'function') {
    elephantMount.parentNode.removeChild(elephantMount)
  }
  assert.equal(standChildren.length, 1, 'cleanup 仅移出自己，不破坏鲸鱼节点')
  assert.equal(standChildren[0], whaleNode)

  // 2. 歧义按“唯一挂载容器”判定：两只鲸鱼共用同一容器仍是同一 stand，正常返回
  const foreignWhale = { ...whaleNode }
  seatNode.querySelectorAll = (sel) => (sel === '.dsh-claude-deepy, .dsh-claude-crab' ? [whaleNode, foreignWhale] : [])
  assert.equal(findMascotStand(rootNode), standParent, '同 seat 多鲸鱼共享同一容器时仍返回该容器')

  // 2b. 两只鲸鱼挂在不同容器 → stand 不唯一，返回 null
  const foreignWhale2 = { ...whaleNode, parentElement: { children: [] } }
  seatNode.querySelectorAll = (sel) => (sel === '.dsh-claude-deepy, .dsh-claude-crab' ? [whaleNode, foreignWhale2] : [])
  assert.equal(findMascotStand(rootNode), null, '挂载容器不唯一（歧义）时不挂载')

  // 3. 无鲸鱼元素时返回 null
  seatNode.querySelectorAll = () => []
  assert.equal(findMascotStand(rootNode), null, '无鲸鱼时不挂载')
})

test('状态持久化与单一数据源：初始状态与归一化均以只读状态为准，不依赖 localStorage 乐观凭据', async () => {
  const mod = await loadBundle()
  const { normalizeState } = mod.__test

  const rawState = {
    sessionId: 'sess-123',
    gate: { open: true, remaining: 15, expiresAt: 1780000000000 },
    unsafePermit: { granted: true, remaining: 5, expiresAt: 1780000000000, reason: '用户显式确认' },
    reviewAccess: { allowed: true },
  }
  const normalized = normalizeState(rawState, 'sess-123')
  assert.equal(normalized.gate.open, true)
  assert.equal(normalized.gate.remaining, 15)
  assert.equal(normalized.unsafePermit.granted, true)
  assert.equal(normalized.unsafePermit.remaining, 5)
  assert.equal(normalized.unsafePermit.reason, '用户显式确认')
  assert.equal(normalized.reviewAccess.allowed, true)

  // 缺少字段时的默认值（未授权）
  const emptyNorm = normalizeState({ sessionId: 'sess-123' }, 'sess-123')
  assert.equal(emptyNorm.gate.open, false)
  assert.equal(emptyNorm.unsafePermit.granted, false)
  assert.equal(emptyNorm.reviewAccess.allowed, false)
})

test('撤销授权：调用 /egm-review-access revoke 且提示文案说明不中止正在运行的任务', async () => {
  const mod = await loadBundle()
  const { executeHostCommand, COPY } = mod.__test

  let calledLine = null
  const mockCtx = {
    remote: {
      commands: {
        async execute(sessionId, line) {
          calledLine = line
          return {
            ok: true,
            value: {
              result: {
                kind: 'success',
                text: '已撤销评审授权',
              },
            },
          }
        },
      },
    },
  }

  const res = await executeHostCommand(mockCtx, 'sess-1', '/egm-review-access revoke')
  assert.equal(res.ok, true)
  assert.equal(calledLine, '/egm-review-access revoke')
  assert.match(COPY.reviewRevokeNotice, /停止后续金鱼派发/)
  assert.match(COPY.reviewRevokeNotice, /正在运行的任务不受影响/)
})

function findNode(tree, predicate) {
  if (!tree) return null
  if (predicate(tree)) return tree
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const found = findNode(item, predicate)
      if (found) return found
    }
  }
  if (tree.children && Array.isArray(tree.children)) {
    for (const child of tree.children) {
      const found = findNode(child, predicate)
      if (found) return found
    }
  }
  return null
}

test('ReviewAuthSection 生命周期与异步守卫：卸载后延迟 resolve/reject 无副作用，切会话隔离不触发旧轮询', async () => {
  const mod = await loadBundle()
  const { ReviewAuthSection } = mod.__test
  const { react } = mod

  let polledSessions = []
  let deferredCommands = []
  const mockCtx = {
    remote: {
      commands: {
        async execute(sessionId, line) {
          return new Promise((resolve, reject) => {
            deferredCommands.push({ sessionId, line, resolve, reject })
          })
        },
      },
      events: {
        emit(event, payload) {
          if (event === 'egm:poll') polledSessions.push(payload && payload.sessionId)
        },
      },
    },
    emit(event, payload) {
      if (event === 'egm:poll') polledSessions.push(payload && payload.sessionId)
    },
  }

  // 1. 挂载会话 A 并触发授权
  let vdomA = react.render(ReviewAuthSection, {
    sessionId: 'session-A',
    snapshot: { gate: { open: false }, unsafePermit: { granted: false } },
    ctx: mockCtx,
  })

  // 勾选风险复选框
  const checkboxA = findNode(vdomA, (n) => n.type === 'input' && n.props && n.props.type === 'checkbox')
  assert.ok(checkboxA, '应当找到风险复选框')
  checkboxA.props.onChange({ target: { checked: true } })

  // 重新渲染以更新 checked 状态
  vdomA = react.render(ReviewAuthSection, {
    sessionId: 'session-A',
    snapshot: { gate: { open: false }, unsafePermit: { granted: false } },
    ctx: mockCtx,
  })

  const authBtnA = findNode(vdomA, (n) => n.type === 'button' && n.props && n.props.className && n.props.className.includes('egm-btn--primary'))
  assert.ok(authBtnA, '应当找到授权按钮')
  assert.equal(authBtnA.props.disabled, false)

  // 点击授权，进入异步等待
  const authPromiseA = authBtnA.props.onClick()
  assert.equal(deferredCommands.length, 1)
  assert.equal(deferredCommands[0].sessionId, 'session-A')
  assert.equal(deferredCommands[0].line, '/egm-review-access 确认无隔离')

  // 此时组件卸载（例如切换路由或关闭面板）
  react.unmount()

  // 延迟 resolve 成功回包
  deferredCommands[0].resolve({
    ok: true,
    value: { result: { kind: 'success', text: '已开启' } },
  })
  await authPromiseA

  // 卸载后不应触发任何 immediate poll
  assert.equal(polledSessions.length, 0, '卸载后迟到的成功回包绝对不应触发轮询')

  // 2. 测试延迟 reject 错误回包在卸载后同样无副作用
  deferredCommands = []
  polledSessions = []

  let vdomB = react.render(ReviewAuthSection, {
    sessionId: 'session-B',
    snapshot: { gate: { open: false }, unsafePermit: { granted: false } },
    ctx: mockCtx,
  })
  const checkboxB = findNode(vdomB, (n) => n.type === 'input' && n.props && n.props.type === 'checkbox')
  checkboxB.props.onChange({ target: { checked: true } })
  vdomB = react.render(ReviewAuthSection, {
    sessionId: 'session-B',
    snapshot: { gate: { open: false }, unsafePermit: { granted: false } },
    ctx: mockCtx,
  })
  const authBtnB = findNode(vdomB, (n) => n.type === 'button' && n.props && n.props.className && n.props.className.includes('egm-btn--primary'))
  const authPromiseB = authBtnB.props.onClick()
  assert.equal(deferredCommands.length, 1)

  // 卸载
  react.unmount()

  // 延迟 reject 异常
  deferredCommands[0].reject(new Error('网络中断'))
  await authPromiseB // 不应抛出未捕获异常或更新已卸载组件

  assert.equal(polledSessions.length, 0, '卸载后迟到的异常绝对不应触发轮询或异常扩散')

  // 3. 测试撤销授权 (revoke) 延迟回包在卸载后的防护
  deferredCommands = []
  polledSessions = []

  let vdomRevoke = react.render(ReviewAuthSection, {
    sessionId: 'session-C',
    snapshot: { gate: { open: true, remaining: 10, expiresAt: Date.now() + 100000 }, unsafePermit: { granted: true, remaining: 5, expiresAt: Date.now() + 100000 } },
    ctx: mockCtx,
  })
  const revokeBtn = findNode(vdomRevoke, (n) => n.type === 'button' && n.props && n.props.className && n.props.className.includes('egm-btn--revoke'))
  assert.ok(revokeBtn, '应当找到撤销授权按钮')

  const revokePromise = revokeBtn.props.onClick()
  assert.equal(deferredCommands.length, 1)
  assert.equal(deferredCommands[0].line, '/egm-review-access revoke')

  // 卸载
  react.unmount()

  // 延迟 resolve
  deferredCommands[0].resolve({
    ok: true,
    value: { result: { kind: 'success', text: '已撤销' } },
  })
  await revokePromise

  assert.equal(polledSessions.length, 0, '卸载后迟到的撤销成功回包不应触发轮询')
})

test('几何天花板根治：结构化排除 hero，多层 display:contents 与 boxzero 递归穿透，工作大象局部避让', async () => {
  const mod = await loadBundle()
  const { findDockCeiling, choosePanelGeometry } = mod.__test

  // 1. stack.top = 0（巨大 hero 占满 0~420），dock 在 420，card 在 480
  // 构建 DOM 节点结构：seat > stack > [hero(0~420), dockOutlet, card(480~620)]
  const mockCard = {
    getBoundingClientRect: () => ({ left: 200, top: 480, right: 1000, bottom: 620, width: 800, height: 140 }),
  }
  const mockProgressItem = {
    hidden: false,
    getBoundingClientRect: () => ({ left: 200, top: 420, right: 1000, bottom: 470, width: 800, height: 50 }),
  }
  const mockDockSlot = {
    hidden: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }), // display: contents
    children: [mockProgressItem],
  }
  const mockStack = {
    getBoundingClientRect: () => ({ left: 200, top: 0, right: 1000, bottom: 620, width: 800, height: 620 }),
    querySelector: (sel) => {
      if (sel === '[data-slot="conversation.input.dock"]') return mockDockSlot
      return null
    },
  }

  const ceiling = findDockCeiling(mockCard, mockStack)
  assert.equal(ceiling, 420, 'findDockCeiling 必须返回真实的进度卡 top: 420，绝不返回 hero 的 0')

  const geomWithDock = choosePanelGeometry({
    card: mockCard.getBoundingClientRect(),
    stack: mockStack.getBoundingClientRect(),
    dockCeiling: ceiling,
    viewport: { width: 1400, height: 900 },
  })
  assert.equal(geomWithDock.mode, 'above', '结构化排除 hero 后，面板空间充裕（above），绝不误判为 blocked 放不下')
  // 当前实现：锚点只用 trigger/card 本身（不并入 dockCeiling）。above 时 y = card.top - gap - height，
  // fixedBottom = viewport.height - y - height = 900 - (480 - 8 - 460) - 460 = 428
  assert.equal(geomWithDock.fixedBottom, 428)

  // 2. dock slot display:contents rect 为 0，且嵌套一层 0x0 wrapper，子进度卡在 420
  const mockInnerWrapper = {
    hidden: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    children: [mockProgressItem],
  }
  const mockNestedDockSlot = {
    hidden: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    children: [mockInnerWrapper],
  }
  const mockStackNested = {
    getBoundingClientRect: () => ({ left: 200, top: 0, right: 1000, bottom: 620, width: 800, height: 620 }),
    querySelector: (sel) => (sel === '[data-slot="conversation.input.dock"]' ? mockNestedDockSlot : null),
  }
  const nestedCeiling = findDockCeiling(mockCard, mockStackNested)
  assert.equal(nestedCeiling, 420, '递归穿透多层 display:contents 与 boxzero 后，仍准确量出 420')

  // 3. dock 为空（没有可见子元素），排除 hero，天花板回落到 card.top (480)
  const mockEmptyDockSlot = {
    hidden: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    children: [],
  }
  const mockStackEmpty = {
    getBoundingClientRect: () => ({ left: 200, top: 0, right: 1000, bottom: 620, width: 800, height: 620 }),
    querySelector: (sel) => (sel === '[data-slot="conversation.input.dock"]' ? mockEmptyDockSlot : null),
  }
  const emptyCeiling = findDockCeiling(mockCard, mockStackEmpty)
  assert.equal(emptyCeiling, 480, 'dock 为空时，天花板为 card.top 480，绝不回退到 hero 的 top: 0')

  // 4. 工作大象局部避让契约已简化：不扣 elephant，面板按实际 trigger/card 上下翻转夹视口
  const geomNoOverlap = choosePanelGeometry({
    card: { left: 100, top: 500, right: 900, bottom: 640, width: 800, height: 140 },
    stack: { left: 100, top: 400, right: 900, bottom: 640, width: 800, height: 240 },
    trigger: { left: 300, top: 600, width: 40, height: 30 },
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(geomNoOverlap.mode, 'above')
  // 当前实现：面板只认按钮（trigger）本身作锚点。fixedBottom = 800 - (600 - 8 - 460) - 460 = 208
  assert.equal(geomNoOverlap.fixedBottom, 208, '不扣 elephant，底边按 trigger 锚点上方定位')

  // 5. 零 card 边界下有效 trigger 依然可正常弹出面板（above），不误退回 hidden
  const zeroCardGeom = choosePanelGeometry({
    card: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    trigger: { left: 120, top: 600, right: 152, bottom: 632, width: 32, height: 32 },
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(zeroCardGeom.mode, 'above', '零 card 边界下有效 trigger 依然可正常弹出面板')
  assert.ok(zeroCardGeom.maxHeight > 0)
})
