// 输入框下方 EGM 入口 / 浮动卡片的客户端测试。
//
// 用一个小型 React 运行时把打包文件真的跑起来：状态钩子可更新、effect 只按
// 依赖重跑，因此能验证“真实状态、按角色出现、展开收起、草稿保留、真实命令、
// 真实报告、几何夹取”这些行为，而不是只检查字符串。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

// 和 lib/client.js 的 PANEL_WIDTH 对齐：启动卡是一张窄卡，不铺满整条输入卡。
const PANEL_WIDTH = 320

function flatten(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out)
  } else if (value !== null && value !== undefined && value !== false && value !== true) {
    out.push(value)
  }
  return out
}

/** 极简 React：useState/useEffect/useRef/useCallback 足够跑 EgmDock。
 *  effect 在整棵树展开完（ref 已赋值）之后才执行，和真实 React 的提交顺序一致。 */
function createReact(refFor) {
  const hooks = []
  let cursor = 0
  let pending = []
  let updates = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flatten(children) }
    },
    useState(initial) {
      const index = cursor++
      if (!Object.prototype.hasOwnProperty.call(hooks, index)) {
        hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value
        if (!Object.is(hooks[index], next)) updates++
        hooks[index] = next
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
    if (node.props && node.props.ref && typeof node.props.ref === 'object') {
      node.props.ref.current = refFor ? refFor(out) : null
    }
    return out
  }
  return {
    React,
    get updates() { return updates },
    expand,
    render(Component, props) {
      cursor = 0
      pending = []
      const tree = expand(Component(props))
      const queue = pending
      pending = []
      for (const item of queue) {
        const previous = hooks[item.index]
        if (previous && typeof previous.cleanup === 'function') previous.cleanup()
        hooks[item.index] = { deps: item.deps, cleanup: item.fn() }
      }
      return tree
    },
  }
}

/** 假 DOM：只实现组件真正用到的那几个方法，矩形可以从外部改，用来模拟进度卡变化。 */
function fakeDom(initial = {}) {
  const state = Object.assign(
    {
      card: { left: 120, top: 560, right: 920, bottom: 700, width: 800, height: 140 },
      // 编辑器自身矩形：真实卡片里附件托盘在它上方，标记要按它定位而不是按卡顶。
      input: { left: 120, top: 600, right: 920, bottom: 660, width: 800, height: 60 },
      composing: Boolean(initial.composing),
      stack: { left: 120, top: 500, right: 920, bottom: 700, width: 800, height: 200 },
      seat: { left: 120, top: 500, right: 920, bottom: 700, width: 800, height: 200 },
      dock: { left: 340, top: 500, right: 700, bottom: 552, width: 360, height: 52 },
      float: { left: 120, top: 600, right: 275, bottom: 626, width: 155, height: 26 },
    },
    initial,
  )
  const node = (rect, extra = {}) =>
    Object.assign(
      {
        getBoundingClientRect: () => rect(),
        closest: () => null,
        parentElement: null,
        contains: () => false,
        querySelectorAll: () => [],
        focus() {},
      },
      extra,
    )
  const dockItemRect = () => {
    if (state.noDock || state.hasDock === false) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    if (state.seat && state.card && state.seat.top >= state.card.top) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    }
    const top = state.seat ? state.seat.top : (state.dock ? state.dock.top : 500)
    const cardTop = state.card ? state.card.top : 560
    return {
      left: 340,
      top,
      right: 700,
      bottom: Math.max(top, cardTop - 8),
      width: 360,
      height: Math.max(0, cardTop - top),
    }
  }
  const dockOutletNode = node(dockItemRect, {
    children: [node(dockItemRect)],
  })
  // 真实结构：composerSeat > composerStack > [dock（进度卡）, inputBar > card]。
  const seatNode = node(() => state.seat)
  const stackNode = node(() => state.stack)
  const inputBarNode = node(() => state.card)

  dockOutletNode.parentElement = stackNode
  inputBarNode.parentElement = stackNode
  stackNode.parentElement = seatNode

  const queryComposer = (selector) => {
    if (selector === '[data-slot="conversation.input.dock"]' || selector === '[data-composer-dock]' || selector === '.conversation\\.input\\.dock') {
      return state.noDock ? null : dockOutletNode
    }
    if (selector === '[data-composer-card]') {
      return state.noCard ? null : (state.cards && state.cards[0] ? state.cards[0] : cardNode)
    }
    if (selector === '[data-composer-input]') {
      return node(() => state.input)
    }
    return null
  }
  seatNode.querySelector = queryComposer
  stackNode.querySelector = queryComposer
  // 模拟输入卡片底部那一排控件：入口要绕开它们。
  const controls = initial.controls || [
    { left: 128, top: 620, right: 156, bottom: 648 },
    { left: 164, top: 620, right: 240, bottom: 648 },
    { left: 248, top: 620, right: 324, bottom: 648 },
    { left: 820, top: 620, right: 848, bottom: 648 },
  ]
  const cardNode = node(() => state.card, {
    parentElement: inputBarNode,
    closest: (selector) => (selector === '[data-composer-seat]' && !state.noSeat ? seatNode : null),
    querySelectorAll: () => controls.map((rect) => node(() => rect)),
    querySelector: (selector) => {
      if (selector === '[data-composer-input]') return node(() => state.input)
      if (selector === '[data-composer-composing]') return state.composing ? node(() => state.input) : null
      return null
    },
  })
  seatNode.querySelectorAll = (selector) => selector === '[data-composer-card]' ? (state.noCard ? [] : state.cards || [cardNode]) : []
  const rootNode = node(() => state.card, {
    closest: (selector) => selector === '[data-composer-card]'
      ? (!state.noCard && !state.toolbarSibling ? state.currentCard || cardNode : null)
      : selector === '[data-composer-seat]' && !state.noSeat ? seatNode : null,
    parentElement: inputBarNode,
  })
  const calcFloat = () => {
    if (initial.float) return state.float
    if (state.float && (state.float.width === 0 || state.float.height === 0)) return state.float
    const cardTop = state.card ? state.card.top : 560
    return { left: 120, top: cardTop + 40, right: 275, bottom: cardTop + 66, width: 155, height: 26 }
  }
  const floatNode = node(calcFloat)
  const chipNode = node(() => (state.chip ? state.chip : calcFloat()))
  const panelNode = node(() => ({ left: 120, top: 200, right: 540, bottom: 490, width: 420, height: 290 }))
  panelNode.contains = (target) => target === panelNode
  rootNode.contains = (target) => target === rootNode || target === floatNode || target === chipNode
  return {
    state,
    panelNode,
    cardNode,
    rootNode,
    seatNode,
    stackNode,
    stackTarget: stackNode,
    refFor(rendered) {
      const classes = String((rendered.props && rendered.props.className) || '').split(/\s+/)
      if (classes.includes('egm-root')) return rootNode
      if (classes.includes('egm-float')) return floatNode
      if (classes.includes('egm-panel')) return panelNode
      if (classes.includes('egm-chip')) return chipNode
      return node(() => state.card)
    },
  }
}

/** 最小的 DOM 事件目标，够测 Esc / 点外部这两条全局监听。 */
function eventTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type)
      if (!list) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event)
    },
  }
}

function fakeDocument() {
  const styles = []
  const events = eventTarget()
  return {
    styles,
    document: {
      // 宿主真实环境里有 body；面板和模式标记都要 Portal 到这里，测试也必须一致。
      body: {
        appendChild(child) { child.parentNode = this },
        removeChild(child) { child.parentNode = null },
      },
      head: { appendChild: (node) => styles.push(node) },
      getElementById: (id) => styles.find((node) => node.id === id) || null,
      createElement: (tag) => ({ tag, id: '', textContent: '', className: '', setAttribute() {}, parentNode: null, contains: () => false }),
      addEventListener: events.addEventListener,
      removeEventListener: events.removeEventListener,
      listeners: events.listeners,
      dispatch: events.dispatch,
    },
  }
}

function makeRpc() {
  const calls = []
  let reply = async () => ({ ok: true, value: null })
  return {
    calls,
    set(handler) {
      reply = handler
    },
    rpc: {
      call: async (...args) => {
        calls.push(args)
        return reply(...args)
      },
    },
  }
}

/** 记录实例的假观察器，测试里可以手动触发回调。 */
function makeObservers() {
  const instances = []
  class FakeResizeObserver {
    constructor(callback) {
      this.kind = 'resize'
      this.callback = callback
      this.targets = []
      this.disconnected = false
      instances.push(this)
    }
    observe(target, options) {
      this.targets.push(target)
      this.options = options
    }
    disconnect() {
      this.disconnected = true
    }
    fire(records) {
      this.callback(records || [], this)
    }
  }
  class FakeMutationObserver {
    constructor(callback) {
      this.kind = 'mutation'
      this.callback = callback
      this.targets = []
      this.disconnected = false
      instances.push(this)
    }
    observe(target, options) {
      this.targets.push(target)
      this.options = options
    }
    disconnect() {
      this.disconnected = true
    }
    fire(records) {
      this.callback(records || [], this)
    }
  }
  return { instances, FakeResizeObserver, FakeMutationObserver }
}

async function loadBundle(options = {}) {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const loaded = []
  const dom = fakeDom(options.dom)
  const react = createReact(dom.refFor)
  const { document, styles } = fakeDocument()
  const windowEvents = eventTarget()
  const observers = makeObservers()
  const timers = []
  let timerId = 0
  // 显式开启假 rAF 的用例才能观察“同帧合并”；默认不装，让既有用例保持同步语义。
  const frames = []
  let frameId = 0
  const raf = options.raf === true
    ? {
        requestAnimationFrame: (fn) => {
          frames.push({ id: ++frameId, fn })
          return frameId
        },
        cancelAnimationFrame: (id) => {
          const index = frames.findIndex((row) => row.id === id)
          if (index >= 0) frames.splice(index, 1)
        },
      }
    : {}
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (entry) => loaded.push(entry) },
      innerWidth: options.viewport ? options.viewport.width : 1024,
      innerHeight: options.viewport ? options.viewport.height : 768,
      addEventListener: windowEvents.addEventListener,
      removeEventListener: windowEvents.removeEventListener,
      listeners: windowEvents.listeners,
      dispatch: windowEvents.dispatch,
    },
    document,
    navigator: { language: 'zh-CN' },
    ResizeObserver: observers.FakeResizeObserver,
    MutationObserver: observers.FakeMutationObserver,
    setTimeout: (fn, ms) => {
      const id = ++timerId
      // 发送流程里的 25ms 轮询要真的推进；组件轮询（>=800ms）只记录，
      // 避免测试进程被无限轮询挂住。
      if (ms <= 50) {
        queueMicrotask(fn)
      } else {
        timers.push({ id, fn, ms })
      }
      return id
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((row) => row.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    console,
    ...raf,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, '应当只调用一次 __ModuleLoader__.load')
  const entry = loaded[0]
  const mod = entry.factory((name) => (name === 'react' ? react.React : {}))
  const flushFrame = () => {
    const queue = frames.splice(0, frames.length)
    for (const row of queue) row.fn()
    return queue.length
  }
  return { entry, mod, react, styles, timers, sandbox, dom, observers, frames, flushFrame }
}

function findByClass(node, className) {
  if (!node || typeof node !== 'object') return null
  if (node.props && String(node.props.className || '').split(/\s+/).includes(className)) return node
  for (const child of node.children || []) {
    const found = findByClass(child, className)
    if (found) return found
  }
  return null
}

function findById(node, id) {
  if (!node || typeof node !== 'object') return null
  if (node.props && node.props.id === id) return node
  for (const child of node.children || []) {
    const found = findById(child, id)
    if (found) return found
  }
  return null
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
}

function buttonByText(tree, text) {
  return findAll(
    tree,
    (node) => node.type === 'button' && textOf(node).trim().includes(text),
  )[0]
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function contextFor(rpc, { conversation } = {}) {
  const registrations = []
  const injected = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injected.push(name)
        factory()
      },
      register(spec, Component) {
        registrations.push({ spec, Component })
        return () => {}
      },
    },
    connection: { rpc },
  }
  if (conversation) {
    ctx.get = (name) => (name === 'conversation' ? conversation : undefined)
  }
  return { ctx, registrations, injected }
}

function composer(initial = '', options = {}) {
  let draft = typeof initial === 'string' ? initial : ''
  let references = Array.isArray(options.references) ? options.references.slice() : []
  let command = typeof options.command === 'string' ? options.command : null
  let phase = options.phase || (command ? 'claimed' : draft.trimStart().startsWith('/') ? 'slash' : 'plain')
  const listeners = new Set()
  const calls = []
  let setDraftCalls = 0
  const attachments = { ids: Array.isArray(options.attachments) ? options.attachments : [] }
  const snapshot = () => ({
    draft,
    attachmentIds: attachments.ids,
    phase,
    ...(command ? { claim: { name: command.slice(1).trim(), token: command, hint: options.hint } } : {}),
  })
  const publish = () => {
    for (const listener of Array.from(listeners)) listener(snapshot())
  }
  // 宿主里 `inputHub.shell(id)` 同时被当成键盘面（host-conv-client.js:20137-20141），
  // Enter、发送键、actions.submit 最后都落到同一个 submit 上；这里照抄这个结构。
  const protoSubmit = function submit(mode = 'queue', source) {
    calls.push(['submit', mode, source])
    draft = ''
    references = []
    command = null
    phase = 'plain'
    publish()
  }
  const shell = {
    submit: protoSubmit,
    notify(level, text) {
      calls.push(['notify', level, text])
    },
    state: {
      getSnapshot: snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    get draftSnapshot() {
      // 模拟宿主读不出草稿：这种情况必须当成“证明不了会走 /egm”。
      if (options.throwDraftSnapshot) throw new Error('draftSnapshot unavailable')
      return {
        text: draft,
        references: references.slice(),
        ...(command ? { command: { token: command } } : {}),
      }
    },
    actions: {
      setDraft(value) {
        calls.push(['setDraft', value])
        setDraftCalls += 1
        // 模拟宿主拒收：记录调用但草稿不变，用来测“标记补不上”的僵持态。
        if (options.ignoreSetDraft) return
        // 只拒收第 N 次以后的写入：测“开模式成功、关模式没摘干净”。
        if (typeof options.rejectSetDraft === 'function' && options.rejectSetDraft(setDraftCalls)) return
        if (value && typeof value === 'object') {
          draft = typeof value.text === 'string' ? value.text : ''
          references = Array.isArray(value.references) ? value.references.slice() : []
          command =
            !options.dropCommand && value.command && typeof value.command.token === 'string'
              ? value.command.token
              : null
          phase = command ? 'claimed' : draft.trimStart().startsWith('/') ? 'slash' : 'plain'
        } else {
          draft = String(value == null ? '' : value)
          references = []
          command = null
          phase = draft.trimStart().startsWith('/') ? 'slash' : 'plain'
        }
        options.onSetDraft?.(attachments)
        publish()
      },
      submit() {
        shell.submit('queue')
      },
    },
  }
  // 模拟宿主把 submit 设成不可写：赋值会抛错，装闸门必须失败。
  if (options.lockedSubmit) {
    Object.defineProperty(shell, 'submit', {
      value: protoSubmit,
      writable: false,
      configurable: true,
      enumerable: true,
    })
  }
  return {
    calls,
    attachments,
    shell,
    protoSubmit,
    snapshot,
    publish,
    getDraft: () => draft,
    getCommand: () => command,
    getPhase: () => phase,
    getReferences: () => references.slice(),
    conversation: {
      input: {
        shell(id) {
          calls.push(['shell', id])
          return shell
        },
      },
    },
  }
}

/** 一份“真实在跑”的状态：大象在跑、金鱼在跑。 */
function workingState(overrides = {}) {
  return {
    sessionId: 's1',
    state: 'dispatch',
    count: 1,
    goldfish: [
      {
        id: 'g1',
        role: 'logic',
        mode: 'review',
        stage: '7',
        status: 'running',
        startedAt: 1700000000000,
        hasReport: false,
      },
    ],
    elephant: {
      status: 'running',
      known: true,
      working: true,
      workingOnEgm: true,
      source: 'agent-status',
      reason: null,
      egm: { active: true, signal: 'dispatch-start' },
      bridge: { attached: true, agentStatus: true, agentLifecycle: true },
    },
    gate: { open: false, remaining: 0, expiresAt: 0 },
    ...overrides,
  }
}

function asTree(mod, react, rpc, extra) {
  const { ctx, registrations } = contextFor(rpc.rpc, extra)
  mod.apply(ctx)
  return { Dock: registrations[0].Component, registrations, ctx }
}

/** 入口上的工作灯。新行为：只有真在干 EGM 的活时才存在这个节点。 */
function chipDot(tree) {
  return findByClass(tree, 'egm-chip-dot')
}

/** 启动卡里那个折叠区：详细状态默认收起。 */
function statusDetails(tree) {
  return findAll(tree, (node) => node.type === 'details')[0] || null
}

/** root 子树里是否包含 target（用来确认折叠区确实包住了状态明细）。 */
function containsNode(root, target) {
  if (root === target) return true
  if (!root || typeof root !== 'object') return false
  return (root.children || []).some((child) => containsNode(child, target))
}

function petChips(tree) {
  return findAll(
    tree,
    (node) => node.props && String(node.props.className || '').split(/\s+/).includes('egm-pet-chip'),
  )
}

// ---------------------------------------------------------------------------

test('客户端包：id、插件名、注册原生左侧工具栏插槽 conversation.input.left', async () => {
  const { entry, mod } = await loadBundle()
  assert.equal(entry.id, 'dsh-egm')
  assert.deepEqual([...mod.inject], ['slots', 'connection'])
  const rpc = makeRpc()
  const { ctx, registrations, injected } = contextFor(rpc.rpc)
  mod.apply(ctx)
  assert.deepEqual(injected, ['conversation.input.left'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].spec.name, 'conversation.input.left')
  assert.equal(registrations[0].spec.id, 'dsh-egm-pet')
  assert.equal(registrations[0].spec.order, 10)
  assert.equal(typeof registrations[0].Component, 'function')
})

test('状态：只读 RPC egm-pet/state，参数带当前 sessionId，并沿用轮询节流', async () => {
  const { mod, react, timers } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  assert.equal(rpc.calls.length, 1)
  assert.equal(
    JSON.stringify(rpc.calls[0]),
    JSON.stringify(['/api', 'egm-pet/state', { sessionId: 's1' }]),
  )
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 1200)
})

test('状态：回包 sessionId 对不上就丢弃，不做“最近会话”回退', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 'other', state: 'crit', count: 9, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })
  const chip = findByClass(tree, 'egm-chip')
  assert.match(chip.props.title, /不属于当前会话/)
  assert.equal(chip.props['aria-label'], '选择 EGM 启动方式')
  assert.equal(findByClass(tree, 'egm-pet-chip'), null, '状态不可信时不出宠物')
  assert.equal(findByClass(tree, 'egm-chip-badge'), null)
})

test('状态：中断后保留最近一次成功数据并标明“已中断”', async () => {
  const { mod, react, timers } = await loadBundle()
  const rpc = makeRpc()
  let fail = false
  rpc.set(async () => {
    if (fail) throw new Error('后端断开')
    return {
      ok: true,
      value: { sessionId: 's1', state: 'idle', count: 2, goldfish: [], elephant: { status: 'idle', known: true } },
    }
  })
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  assert.match(findByClass(tree, 'egm-chip').props.title, /空闲/)
  fail = true
  timers.shift().fn()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.match(findByClass(tree, 'egm-chip').props.title, /后端断开|最近一次/)
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.match(textOf(findById(tree, 'egm-mode-panel')), /状态断了/)
})

test('空闲：不常驻大象和金鱼，只留一个紧凑入口', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({
    ok: true,
    value: { sessionId: 's1', state: 'idle', count: 3, goldfish: [], elephant: { status: 'idle', known: true, working: false } },
  }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-pet-chip'), null)
  assert.equal(textOf(findByClass(tree, 'egm-chip-badge')), '3', '结果条数仍可从入口看到')
  assert.equal(petChips(tree).length, 0)
})

test('干活时：对应角色才出现，大象和金鱼可同屏', async () => {
  const { mod, react, styles } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: workingState() }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })
  const pets = petChips(tree)
  assert.equal(pets.length, 2)
  assert.equal(pets[0].props['aria-controls'], 'egm-elephant-panel')
  assert.equal(pets[1].props['aria-controls'], 'egm-goldfish-panel')
  assert.equal(pets[0].props['aria-expanded'], 'false')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].id, 'dsh-egm-pet-style')
  assert.match(styles[0].textContent, /prefers-reduced-motion/)
  assert.match(styles[0].textContent, /\.egm-float\{position:relative/)
  assert.match(styles[0].textContent, /\.egm-panel\{position:fixed/)
})

test('工作动画：live + prep + 核实是 EGM 的活，大象才带上工作场景和 data-work', async () => {
  const { mod, react, styles } = await loadBundle()
  const rpc = makeRpc()
  // 后端诚实状态只会给 prep：它从不伪造 writing。
  // 之前的 CSS 只认 .egm-pet--writing，所以真在干活时也一动不动。
  rpc.set(async () => ({ ok: true, value: workingState({ state: 'prep' }) }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })

  const elephant = petChips(tree)[0]
  assert.ok(elephant, '真在干 EGM 的活时大象必须在场')
  assert.equal(elephant.props['data-kind'], 'elephant')
  assert.equal(elephant.props['data-work'], 'true', '工作动画只认 data-work，不认状态名')
  assert.match(elephant.props.className, /egm-pet--busy/)

  // 场景要一眼看出在写东西：埋头、鼻子、笔、图纸上的墨线、耳朵、眼睛。
  for (const part of ['egm-el-w-head', 'egm-el-w-ear', 'egm-el-w-trunk', 'egm-el-w-pen', 'egm-el-w-eye']) {
    assert.ok(findByClass(elephant, part), '工作场景缺少部件：' + part)
  }
  const inkLines = findAll(elephant, (node) =>
    String((node.props && node.props.className) || '').split(/\s+/).includes('egm-el-w-line'),
  )
  assert.equal(inkLines.length, 3, '图纸上要有三行正在写上去的墨线')

  // 文案说实话：在忙、在处理方案；prep 阶段不说“在写图纸”。
  assert.match(textOf(elephant), /大象在忙/)
  assert.match(elephant.props.title, /大象在忙（正在处理方案）/)
  assert.doesNotMatch(elephant.props.title, /写图纸/)

  // 动画只挂在 data-work 上，状态名选择器必须彻底消失。
  const css = styles[0].textContent
  assert.match(css, /\.egm-pet-chip\[data-work="true"\] \.egm-el-w-trunk\{animation:/)
  assert.match(css, /@keyframes egm-el-w-write\{/)
  assert.match(css, /@keyframes egm-el-w-line\{/)
  assert.doesNotMatch(css, /\.egm-pet--writing/, '不能再按 writing 挂动画：这个状态永远不会出现')
  assert.doesNotMatch(css, /\.egm-pet--dispatch/)
  assert.match(css, /prefers-reduced-motion/, 'reduced-motion 下仍然全部停掉')
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.egm-root \*/, '整棵子树的动画都被关掉')
})

test('工作动画：普通对话里主 Agent 在跑，也不放工作场景', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({
    ok: true,
    value: workingState({
      state: 'prep',
      goldfish: [],
      elephant: { status: 'running', known: true, working: true, workingOnEgm: false, egm: { active: false } },
    }),
  }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(petChips(tree).length, 0, '不是 EGM 的活就不常驻宠物')
  assert.equal(findByClass(tree, 'egm-el-w-trunk'), null, '工作场景一点都不能露出来')
  assert.equal(findByClass(tree, 'egm-pet-work-label'), null)
  assert.equal(findByClass(tree, 'egm-pet--busy'), null)
})

test('工作动画：EGM 回合结束或断线时立刻停，场景不残留', async () => {
  const { mod, react, timers } = await loadBundle()
  const rpc = makeRpc()
  let mode = 'busy'
  rpc.set(async () => {
    if (mode === 'down') throw new Error('后端断开')
    if (mode === 'idle') {
      return {
        ok: true,
        value: workingState({
          state: 'idle',
          goldfish: [],
          elephant: { status: 'idle', known: true, working: false },
        }),
      }
    }
    return { ok: true, value: workingState({ state: 'prep' }) }
  })
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(petChips(tree)[0].props['data-work'], 'true', '先确认活着时在动')

  // 回合结束：state 回 idle，工作场景立刻消失。
  mode = 'idle'
  timers.shift().fn()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(petChips(tree).length, 0)
  assert.equal(findByClass(tree, 'egm-el-w-trunk'), null)

  // 又跑起来，然后后端断线：同样立刻停。
  mode = 'busy'
  timers.shift().fn()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(petChips(tree)[0].props['data-work'], 'true')

  mode = 'down'
  timers.shift().fn()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(petChips(tree).length, 0, '断线后不放动画')
  assert.equal(findByClass(tree, 'egm-el-w-trunk'), null)
  assert.equal(chipDot(tree), null)
})

test('工作动画：忙碌的大象照样点开原来那张卡，入口的两种启动方式不受影响', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: workingState({ state: 'prep' }) }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })

  petChips(tree)[0].props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  const panel = findById(tree, 'egm-elephant-panel')
  assert.ok(panel, '点工作场景仍然打开已有的大象卡')
  assert.match(textOf(panel), /大象在忙（正在处理方案）/, '卡片里也说实话：在处理方案')
  assert.doesNotMatch(textOf(panel), /写图纸/)
  assert.equal(findByClass(tree, 'egm-pet-chip').props['aria-expanded'], 'true')

  petChips(tree)[0].props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-elephant-panel'), null, '再点一次还是收起')

  // 入口按钮还在：卡片方式和模式方式都从它出发，不能被工作场景挤掉。
  const entry = findByClass(tree, 'egm-chip')
  assert.ok(entry, '入口按钮不能被工作场景挤掉')
  entry.props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(
    findById(tree, 'egm-choose-panel') || findById(tree, 'egm-mode-panel'),
    '两种启动方式至少有一种照常可达',
  )
})

test('干活时：只有真在跑的角色出现；未知状态不冒充在工作', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({
    ok: true,
    value: {
      sessionId: 's1',
      state: 'prep',
      count: 0,
      goldfish: [],
      elephant: { status: 'unknown', known: false, reason: 'no-status-event' },
    },
  }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-pet-chip'), null)
  findByClass(tree, 'egm-chip').props.onContextMenu()
  const panel = react.render(Dock, { sessionId: 's1' })
  assert.match(textOf(findById(panel, 'egm-mode-panel')), /状态未知/)
})

test('卡片：一次最多一张，点另一只切换，再点同一只收起', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: workingState() }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })

  petChips(tree)[0].props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-elephant-panel'))
  assert.equal(findById(tree, 'egm-goldfish-panel'), null)

  petChips(tree)[1].props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-elephant-panel'), null)
  assert.ok(findById(tree, 'egm-goldfish-panel'))

  petChips(tree)[1].props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-goldfish-panel'), null)
  assert.equal(findByClass(tree, 'egm-panel'), null)
})

test('卡片：打开后任务结束，卡片留到用户自己收起', async () => {
  const { mod, react, timers } = await loadBundle()
  const rpc = makeRpc()
  let done = false
  rpc.set(async () =>
    done
      ? {
          ok: true,
          value: {
            sessionId: 's1',
            state: 'crit',
            count: 1,
            goldfish: [{ id: 'g1', role: 'logic', status: 'done', hasReport: false }],
            elephant: { status: 'idle', known: true, working: false },
          },
        }
      : { ok: true, value: workingState() },
  )
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  petChips(tree)[1].props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-goldfish-panel'))

  done = true
  timers.shift().fn()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-pet-chip'), null, '任务结束后不再常驻宠物')
  assert.ok(findById(tree, 'egm-goldfish-panel'), '已打开的卡片保持到用户收起')
})



test('点外部：收起卡片，不提交也不停止任务', async () => {
  const { mod, react, sandbox } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({
    ok: true,
    value: { sessionId: 's1', state: 'dispatch', count: 1, goldfish: [], elephant: { status: 'running', known: true, working: true } },
  }))
  const store = composer()
  const { Dock } = asTree(mod, react, rpc, { conversation: store.conversation })
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  assert.ok(findById(react.render(Dock, { sessionId: 's1' }), 'egm-mode-panel'))

  sandbox.document.dispatch('pointerdown', { target: {} })
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-panel'), null)
  assert.equal(store.calls.length, 0)
})

test('点内部：点击面板内部或工具栏触发器不误关面板（double-contains）', async () => {
  const { mod, react, sandbox, dom } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({
    ok: true,
    value: { sessionId: 's1', state: 'dispatch', count: 1, goldfish: [], elephant: { status: 'running', known: true, working: true } },
  }))
  const store = composer()
  const { Dock } = asTree(mod, react, rpc, { conversation: store.conversation })
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  assert.ok(findById(react.render(Dock, { sessionId: 's1' }), 'egm-mode-panel'))

  // 点击面板内部（panelRef.current.contains(target) === true）
  sandbox.document.dispatch('pointerdown', { target: dom.panelNode })
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'), '点击面板内部不关闭面板')

  // 点击外部收起
  sandbox.document.dispatch('pointerdown', { target: {} })
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel'), null, '点击外部正常收起')
})





async function openLaunchAndType(react, Dock, text) {
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  findById(tree, 'egm-launch-draft').props.onChange({ target: { value: text } })
  tree = react.render(Dock, { sessionId: 's1' })
  await buttonByText(tree, '启动 EGM').props.onClick()
  await settle()
  return react.render(Dock, { sessionId: 's1' })
}











test('金鱼卡片：列表来自真实 goldfish，报告按需 RPC 并显示正文', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async (channel, method) => {
    if (method === 'egm-pet/state') {
      return {
        ok: true,
        value: {
          sessionId: 's1',
          state: 'crit',
          count: 1,
          goldfish: [
            {
              id: 'g1',
              role: 'logic',
              mode: 'review',
              stage: '7',
              docPath: '.egm/design.md',
              status: 'done',
              startedAt: 1700000000000,
              finishedAt: 1700000001000,
              reportPath: '.egm/report.md',
              hasReport: true,
              reportBytes: 12,
            },
          ],
        },
      }
    }
    if (method === 'egm-pet/report') {
      return {
        ok: true,
        value: {
          id: 'g1',
          role: 'logic',
          reportPath: '.egm/report.md',
          content: '真实评审正文',
          totalBytes: 18,
          truncated: false,
          source: 'disk',
        },
      }
    }
    throw new Error('unexpected ' + method)
  })
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  // 全部跑完时没有金鱼宠物，结果从入口卡的“查看评审记录”进。
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  await buttonByText(tree, '查看评审记录（1 条）').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  const fishRow = findByClass(tree, 'egm-fish')
  assert.ok(fishRow, '应渲染真实金鱼行')
  assert.match(textOf(fishRow), /logic/)
  assert.match(textOf(fishRow), /已完成/)
  await buttonByText(tree, '读取报告').props.onClick()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  const reportCall = rpc.calls.find((row) => row[1] === 'egm-pet/report')
  assert.equal(
    JSON.stringify(reportCall),
    JSON.stringify(['/api', 'egm-pet/report', { sessionId: 's1', goldfishId: 'g1' }]),
  )
  const panelText = textOf(findById(tree, 'egm-goldfish-panel'))
  assert.match(panelText, /真实评审正文/)
  assert.match(panelText, /来源：报告文件/)
  assert.match(panelText, /18 B/)
})

test('金鱼卡片：报告回包 id 对不上就丢弃，不当成这条鱼的结论', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async (channel, method) => {
    if (method === 'egm-pet/state') {
      return {
        ok: true,
        value: {
          sessionId: 's1',
          state: 'crit',
          count: 1,
          goldfish: [{ id: 'g1', role: 'logic', status: 'done', hasReport: true, reportPath: '.egm/report.md' }],
        },
      }
    }
    return { ok: true, value: { id: 'other', content: '别的鱼', totalBytes: 3, source: 'disk' } }
  })
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  await buttonByText(tree, '查看评审记录（1 条）').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  await buttonByText(tree, '读取报告').props.onClick()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.match(textOf(findById(tree, 'egm-goldfish-panel')), /不属于这条金鱼/)
  assert.equal(textOf(findById(tree, 'egm-goldfish-panel')).includes('别的鱼'), false)
})

test('金鱼卡片：内存回退和截断都明确告知，不当成磁盘完整报告', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async (channel, method) => {
    if (method === 'egm-pet/state') {
      return {
        ok: true,
        value: {
          sessionId: 's1',
          state: 'crit',
          count: 1,
          goldfish: [{ id: 'g1', role: 'style', status: 'done', hasReport: true, reportPath: '.egm/report.md' }],
        },
      }
    }
    return {
      ok: true,
      value: {
        id: 'g1',
        role: 'style',
        reportPath: '.egm/report.md',
        content: '摘要',
        totalBytes: 4096,
        truncated: true,
        source: 'memory-fallback',
      },
    }
  })
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  await buttonByText(tree, '查看评审记录（1 条）').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  await buttonByText(tree, '读取报告').props.onClick()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  const text = textOf(findById(tree, 'egm-goldfish-panel'))
  assert.match(text, /内存回退摘要/)
  assert.match(text, /只显示前面一部分/)
  assert.match(text, /来源：内存摘要/)
})

test('状态：后端没给 gate 时显示“暂不可用”，不冒充未打开', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.match(textOf(findById(tree, 'egm-mode-panel')), /派发窗口状态暂不可用/)
})

test('闸门：关闭时 expiresAt:0 不显示 1970 或“到期时间”', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({
    ok: true,
    value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [], gate: { open: false, remaining: 0, expiresAt: 0 } },
  }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  const text = textOf(findById(tree, 'egm-mode-panel'))
  assert.match(text, /派发窗口未打开/)
  assert.equal(text.includes('1970'), false)
  assert.equal(text.includes('到期时间'), false)
})

test('状态：兼容旧版把 state 包成对象的回包，不被误判为未知', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({
    ok: true,
    value: { sessionId: 's1', state: { state: 'crit', role: 'logic' }, count: 1, goldfish: [] },
  }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })
  assert.match(findByClass(tree, 'egm-chip').props.title, /挑刺/)
})

test('没有 sessionId 时不渲染、不请求', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  const { ctx, registrations } = contextFor(rpc.rpc)
  mod.apply(ctx)
  const Dock = registrations[0].Component
  const tree = react.render(Dock, {})
  await settle()
  assert.equal(tree, null)
  assert.equal(rpc.calls.length, 0)
})

// ---- 行为：进度卡变化要重新量，放不下就不开面板 ---------------------------

test('行为：进度卡变高时重新量天花板，面板底边跟着上移', async () => {
  const { mod, react, dom, observers } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel').props.style.bottom, '276px', '进度卡 60px 高时贴它上沿')

  dom.state.seat = Object.assign({}, dom.state.seat, { top: 400, height: 300 })
  for (const observer of observers.instances.filter((item) => item.kind === 'resize')) observer.fire()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel').props.style.bottom, '376px', '进度卡长高后要重新让位')
})

test('行为：进度卡被移除（MutationObserver）后回到贴输入框上方', async () => {
  const { mod, react, dom, observers } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel').props.style.bottom, '276px')

  dom.state.seat = Object.assign({}, dom.state.seat, { top: 560, height: 140 })
  for (const observer of observers.instances.filter((item) => item.kind === 'mutation')) observer.fire()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel').props.style.bottom, '216px', '没有进度卡时贴输入框')
})

test('行为：上方空间受限时向下翻转，不 blocked 并正常展开面板', async () => {
  const { mod, react } = await loadBundle({
    viewport: { width: 440, height: 700 },
    dom: {
      card: { left: 40, top: 200, right: 400, bottom: 340, width: 360, height: 140 },
      stack: { left: 40, top: -300, right: 400, bottom: 340, width: 360, height: 640 },
      seat: { left: 40, top: -300, right: 400, bottom: 340, width: 360, height: 640 },
    },
  })
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-float').props['data-panel-mode'], 'below', '上方空间紧而下方充裕时自动翻转到下方')
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  const panel = findById(tree, 'egm-mode-panel')
  assert.ok(panel, '向下翻转后可正常展开面板，绝不 blocked')
  assert.equal(panel.props['data-mode'], 'below')
})

test('行为：切换会话时观察器被断开，不留下监听', async () => {
  const { mod, react, observers } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async (channel, method, payload) => ({
    ok: true,
    value: { sessionId: payload.sessionId, state: 'idle', count: 0, goldfish: [] },
  }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  react.render(Dock, { sessionId: 's1' })
  const created = observers.instances.length
  assert.ok(created >= 2, '应同时盯输入卡片和整个 stack')
  react.render(Dock, { sessionId: 's2' })
  await settle()
  assert.equal(
    observers.instances.slice(0, created).every((item) => item.disconnected),
    true,
    '换会话要断开旧观察器',
  )
})

// ---- 几何：浮动层不能改宿主布局 -------------------------------------------

test('几何：入口塞进输入卡片底部最宽的空档，不压任何按钮', async () => {
  const { mod } = await loadBundle()
  const placement = mod.__test.choosePillPlacement({
    card: { left: 100, top: 600, right: 900, bottom: 720, width: 800, height: 120 },
    size: { width: 96, height: 26 },
    // 左下有“+”，右下有发送键，中间是空的。
    obstacles: [
      { left: 108, top: 680, right: 136, bottom: 708 },
      { left: 820, top: 680, right: 892, bottom: 708 },
    ],
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(placement.placement, 'row')
  assert.ok(placement.left >= 140 && placement.left + 96 <= 816, '应落在中间空档里')
  assert.equal(placement.top, 680 + (28 - 26) / 2, '入口应贴在按钮那一行的垂直中线上')
})

test('几何：换行成两排按钮时，入口落在真正空着的那一排', async () => {
  const { mod } = await loadBundle()
  const placement = mod.__test.choosePillPlacement({
    card: { left: 20, top: 520, right: 380, bottom: 660, width: 360, height: 140 },
    size: { width: 96, height: 26 },
    // 第一排：+ 与模式 chip 挤在左边；第二排：只有右边一个发送键。
    obstacles: [
      { left: 28, top: 540, right: 56, bottom: 568 },
      { left: 64, top: 540, right: 140, bottom: 568 },
      { left: 336, top: 580, right: 364, bottom: 608 },
    ],
    viewport: { width: 520, height: 700 },
  })
  assert.equal(placement.placement, 'row')
  assert.ok(placement.top >= 580 && placement.top <= 608, '应落在第二排（空档更宽）')
  assert.ok(placement.left + 96 <= 336, '不压发送键')
})

test('几何：控制行塞不下就返回 null，绝不跑到卡片上方压进度卡', async () => {
  const { mod } = await loadBundle()
  const tight = mod.__test.choosePillPlacement({
    card: { left: 0, top: 600, right: 380, bottom: 700, width: 380, height: 100 },
    size: { width: 200, height: 26 },
    obstacles: [{ left: 0, top: 660, right: 380, bottom: 700 }],
    viewport: { width: 380, height: 700 },
  })
  assert.equal(tight, null)
})

test('几何：空间不够时先缩小入口，缩到能放下的尺寸就仍落在控制行', async () => {
  const { mod } = await loadBundle()
  const card = { left: 80, top: 500, right: 440, bottom: 640, width: 360, height: 140 }
  const obstacles = [
    { left: 88, top: 540, right: 116, bottom: 568 },
    { left: 124, top: 540, right: 200, bottom: 568 },
    { left: 396, top: 540, right: 424, bottom: 568 },
  ]
  const viewport = { width: 520, height: 700 }
  assert.equal(mod.__test.choosePillPlacement({ card, size: { width: 200, height: 26 }, obstacles, viewport }), null)
  const compact = mod.__test.choosePillPlacement({ card, size: { width: 112, height: 26 }, obstacles, viewport })
  assert.ok(compact, '缩到 112 宽后应能塞进同一行')
  assert.equal(compact.placement, 'row')
  assert.ok(compact.left >= 206 && compact.left + 112 <= 396, '仍落在空档里')
})

test('几何：底部条也被占满时返回 null，宁可暂时不显示也不压控件', async () => {
  const { mod } = await loadBundle()
  const dock = mod.__test.chooseDockPlacement({
    card: { left: 80, top: 500, right: 440, bottom: 640, width: 360, height: 140 },
    size: { width: 112, height: 26 },
    obstacles: [{ left: 80, top: 600, right: 440, bottom: 640 }],
    viewport: { width: 520, height: 700 },
  })
  assert.equal(dock, null)
})

test('行为：量不到输入卡片时面板保持收起，不凭猜想弹出', async () => {
  const { mod, react } = await loadBundle({ dom: { noCard: true } })
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  const chip = findByClass(tree, 'egm-chip')
  assert.ok(chip, '工具栏入口按钮存在')
  chip.props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'), 'card 缺失但按钮可测仍开')
})

test('行为：空间不足时面板 blocked，不覆盖进度卡', async () => {
  const { mod, react, dom } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  // 把卡片顶到视口最顶端，上方没有空档（spaceAbove < PANEL_MINIMAL + EDGE）
  dom.state.card = { left: 120, top: 40, right: 920, bottom: 180, width: 800, height: 140 }
  dom.state.seat = { left: 120, top: 40, right: 920, bottom: 180, width: 800, height: 140 }
  let tree = react.render(Dock, { sessionId: 's1' })
  const chip = findByClass(tree, 'egm-chip')
  chip.props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  const panel = findById(tree, 'egm-mode-panel')
  assert.ok(panel, '上方空间不足时向下翻转展开，不 blocked')
  assert.equal(panel.props['data-mode'], 'below')
})

test('几何：最后一级退让落在卡片内部底部条，仍在卡片里、夹在视口内', async () => {
  const { mod } = await loadBundle()
  const dock = mod.__test.chooseDockPlacement({
    card: { left: 80, top: 500, right: 440, bottom: 640, width: 360, height: 140 },
    size: { width: 112, height: 26 },
    obstacles: [],
    viewport: { width: 520, height: 700 },
  })
  assert.equal(dock.placement, 'dock')
  assert.ok(dock.top >= 500 && dock.top + 26 <= 640, '仍在卡片内部')
  assert.ok(dock.left >= 86 && dock.left + 112 <= 434)
})

test('几何：卡片与输入卡同宽同左、不越过发送键那一列，高度按剩余空间收缩', async () => {
  const { mod } = await loadBundle()
  const roomy = mod.__test.choosePanelGeometry({
    card: { left: 120, top: 500, right: 920, bottom: 720, width: 800, height: 220 },
    stack: { left: 120, top: 500, right: 920, bottom: 720, width: 800, height: 220 },
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(roomy.offsetLeft, 0, '与输入卡左对齐')
  assert.equal(roomy.width, PANEL_WIDTH, '窄卡，不铺满整条输入卡')
  assert.equal(roomy.maxHeight, 460)
  assert.ok(roomy.width < 800 - 40, '卡片不盖住右侧发送键')

  const short = mod.__test.choosePanelGeometry({
    card: { left: 20, top: 300, right: 400, bottom: 640, width: 380, height: 340 },
    stack: { left: 20, top: 300, right: 400, bottom: 640, width: 380, height: 340 },
    viewport: { width: 380, height: 640 },
  })
  assert.equal(short.width, Math.min(PANEL_WIDTH, 380, 380 - 16))
  // 窄卡在 380 宽的视口里本来就放得下：不再需要往右让，也不会越界。
  assert.equal(short.offsetLeft, 0, '放得下就与输入卡左对齐，不硬挤')
  assert.ok(short.offsetLeft + 20 >= 8, '卡片不越过视口左边')
  assert.ok(short.offsetLeft + 20 + short.width <= 380 - 8, '卡片不越过视口右边')
  assert.ok(short.maxHeight >= 120 && short.maxHeight <= 284)
})



test('几何：有进度卡时，面板贴到进度卡上沿，不压它也不压输入卡', async () => {
  const { mod } = await loadBundle()
  const card = { left: 120, top: 560, right: 920, bottom: 700, width: 800, height: 140 }
  const stack = { left: 120, top: 500, right: 920, bottom: 700, width: 800, height: 200 }
  const geometry = mod.__test.choosePanelGeometry({ card, dockCeiling: stack.top, viewport: { width: 1200, height: 800 } })
  assert.equal(geometry.mode, 'above')
  assert.equal(geometry.offsetBottom, card.top - stack.top + 8, '底边落在进度卡上沿 8px')
  assert.equal(card.top - geometry.offsetBottom, stack.top - 8, '面板底边在进度卡上方')
  assert.ok(geometry.maxHeight <= stack.top - 16)
})

test('几何：上方放不下就向下翻转并夹在视口内（替代已废弃的侧栏模式）', async () => {
  const { mod } = await loadBundle()
  const card = { left: 120, top: 100, right: 920, bottom: 240, width: 800, height: 140 }
  const flipped = mod.__test.choosePanelGeometry({ card, viewport: { width: 1400, height: 800 } })
  assert.equal(flipped.mode, 'below', '上方空间紧而下方充裕时向下翻转')
  assert.ok(flipped.maxHeight > 0)
  assert.ok(flipped.fixedTop >= 240, '下方展开时面板顶边在卡片下方')

  const narrow = { left: 300, top: 100, right: 700, bottom: 240, width: 400, height: 140 }
  const left = mod.__test.choosePanelGeometry({ card: narrow, viewport: { width: 800, height: 700 } })
  assert.equal(left.mode, 'below')
  assert.ok(left.fixedLeft >= 8, '面板不越过视口左边')
  assert.ok(left.fixedLeft + left.width <= 800 - 8, '面板不越过视口右边')
})

test('几何：四周都挤就压成精简卡；再小整卡滚动，仍保留正文', async () => {
  const { mod } = await loadBundle()
  const card = { left: 40, top: 500, right: 400, bottom: 640, width: 360, height: 140 }
  const compact = mod.__test.choosePanelGeometry({
    card,
    dockCeiling: 200,
    viewport: { width: 440, height: 700 },
  })
  assert.equal(compact.mode, 'compact')
  assert.ok(compact.maxHeight <= 200)
  assert.match(compact.note, /整张卡片可滚动/)

  const minimal = mod.__test.choosePanelGeometry({
    card,
    dockCeiling: 100,
    viewport: { width: 440, height: 700 },
  })
  assert.equal(minimal.mode, 'minimal')
  assert.equal(minimal.maxHeight, 84, '使用可用高度，不能只剩48px标题条')
  assert.match(minimal.note, /整张卡片可滚动/)
})

test('几何：上方空间受限时翻转到下方，不再 blocked', async () => {
  const { mod } = await loadBundle()
  const geometry = mod.__test.choosePanelGeometry({
    card: { left: 40, top: 200, right: 400, bottom: 340, width: 360, height: 140 },
    dockCeiling: 200,
    viewport: { width: 440, height: 700 },
  })
  assert.equal(geometry.mode, 'below', '上方不足时向下翻转，不 blocked')
  assert.ok(geometry.maxHeight > 0)
})

test('几何：空闲区间识别会合并相邻障碍', async () => {
  const { mod } = await loadBundle()
  const free = mod.__test.freeIntervals(
    [
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 10, top: 0, right: 20, bottom: 10 },
      { left: 50, top: 0, right: 60, bottom: 10 },
    ],
    0,
    10,
    0,
    100,
  )
  assert.equal(JSON.stringify(free), JSON.stringify([[20, 50], [60, 100]]))
})

test('纯函数：/egm 命令拼接、可见宠物判定、状态文案', async () => {
  const { mod } = await loadBundle()
  const { launchCommand, visiblePets, stateText, chipTone } = mod.__test
  assert.equal(launchCommand('  '), '')
  assert.equal(launchCommand(' 做一个  小工具\n再补一句 '), '/egm 做一个 小工具 再补一句')
  assert.equal(JSON.stringify(visiblePets(null)), JSON.stringify({ elephant: false, goldfish: false }))
  assert.equal(
    JSON.stringify(
      visiblePets({
        status: 'live',
        state: 'dispatch',
        elephant: { working: true, workingOnEgm: true, egm: { active: true } },
        goldfish: [{ status: 'running' }],
      }),
    ),
    JSON.stringify({ elephant: true, goldfish: true }),
  )
  assert.equal(
    JSON.stringify(
      visiblePets({
        status: 'live',
        state: 'idle',
        elephant: { working: true, workingOnEgm: false, egm: { active: false } },
        goldfish: [{ status: 'done' }],
      }),
    ),
    JSON.stringify({ elephant: false, goldfish: false }),
    '普通对话里主 Agent 在跑，也不能冒充大象在做 EGM',
  )
  assert.equal(
    JSON.stringify(
      visiblePets({
        status: 'live',
        state: 'crit',
        elephant: { working: true, workingOnEgm: null, egm: { active: true } },
        goldfish: [{ status: 'done' }],
      }),
    ),
    JSON.stringify({ elephant: false, goldfish: false }),
    '宿主没说清这次是不是 EGM 的活时，宁可不显示',
  )
  assert.equal(stateText({ status: 'error', state: 'unknown' }), '暂时读不到')
  assert.equal(chipTone({ status: 'live', state: 'idle' }), 'ok')
  assert.equal(chipTone({ status: 'stale', state: 'idle' }), 'stale')
})

test('几何：座位量不到时面板直接 hidden，不拿视口猜位置', async () => {
  const { mod } = await loadBundle()
  assert.equal(mod.__test.choosePanelGeometry({ card: null, trigger: null, viewport: { width: 900, height: 700 } }).mode, 'hidden')
  const zeroCard = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  assert.equal(mod.__test.choosePanelGeometry({ card: zeroCard, trigger: null, viewport: { width: 900, height: 700 } }).mode, 'hidden')
})

test('几何：面板贴的是含进度卡的 composer 区上沿，不会插在进度卡和输入框之间', async () => {
  const { mod } = await loadBundle()
  const card = { left: 120, top: 560, right: 920, bottom: 700, width: 800, height: 140 }
  const seat = { left: 120, top: 500, right: 920, bottom: 700, width: 800, height: 200 }
  const dock = { left: 340, top: 500, right: 700, bottom: 552, width: 360, height: 52 }
  const geometry = mod.__test.choosePanelGeometry({ card, dockCeiling: dock.top, viewport: { width: 1200, height: 800 } })
  assert.equal(geometry.mode, 'above')
  const panelBottom = card.top - geometry.offsetBottom
  assert.ok(panelBottom <= dock.top, '面板底边不超过进度卡上沿')
})

test('结构：原生左侧工具栏插槽渲染入口按钮，面板通过 Portal 挂载 document.body', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  const chip = findByClass(tree, 'egm-chip')
  assert.ok(chip, '入口按钮在工具栏中渲染')
  chip.props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  const panel = findById(tree, 'egm-mode-panel')
  assert.ok(panel, '点击后展开 launch 面板')
  assert.equal(panel.props.style.position, 'fixed', '采用 fixed 视口绝对定位摆脱 Claude 容器裁剪')
})

test('行为：已打开后座位不可测，面板安全收起而不是凭旧坐标硬撑', async () => {
  const { mod, react, dom } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'), '先确认面板已经打开')

  dom.state.card = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  dom.state.float = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  dom.state.noCard = true
  react.render(Dock, { sessionId: 's1' })
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel'), null, '座位没了就不许留着旧位置的面板')
  assert.match(textOf(tree), /量不到输入卡片和上方进度区的位置/)
})

test('Esc：输入法选词中（isComposing / keyCode 229）不关面板、不拦事件', async () => {
  const { mod, react, sandbox } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'state', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'))

  const composing = { key: 'Escape', isComposing: true, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
  sandbox.window.dispatch('keydown', composing)
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'), 'IME 选词中不关面板')
  assert.notEqual(composing.prevented, true, '也不能抢走输入法的 Esc')

  const legacy = { key: 'Escape', keyCode: 229, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
  sandbox.window.dispatch('keydown', legacy)
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'), 'keyCode 229 同样不关')
  assert.notEqual(legacy.prevented, true)

  const nativeComposing = { key: 'Escape', nativeEvent: { isComposing: true }, preventDefault() { this.prevented = true }, stopPropagation() {} }
  sandbox.window.dispatch('keydown', nativeComposing)
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'), 'nativeEvent.isComposing 同样不关')

  const plain = { key: 'Escape', preventDefault() { this.prevented = true }, stopPropagation() {} }
  sandbox.window.dispatch('keydown', plain)
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel'), null, '不在选词时 Esc 才关')
  assert.equal(plain.prevented, true, '正常 Esc 要拦住，避免宿主当成停止任务')
})

test('Esc：组件自己的 onKeyDown 在选词中也不关面板', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'state', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  const panel = findById(tree, 'egm-mode-panel')
  assert.ok(panel)
  const composing = { key: 'Escape', isComposing: true, preventDefault() { this.prevented = true }, stopPropagation() {} }
  panel.props.onKeyDown(composing)
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-mode-panel'), '组件的 Esc 处理同样要让开输入法')
})

test('状态：断线后保留历史数据，但不放宠物动画、一个灯都不亮', async () => {
  const { mod, react, timers } = await loadBundle()
  const rpc = makeRpc()
  let fail = false
  rpc.set(async () => {
    if (fail) throw new Error('后端断开')
    return {
      ok: true,
      value: {
        sessionId: 's1',
        state: 'dispatch',
        count: 3,
        goldfish: [{ id: 'g1', role: 'logic', status: 'running' }],
        elephant: { status: 'working', known: true, working: true, workingOnEgm: true },
      },
    }
  })
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findByClass(tree, 'egm-pet-chip'), '先确认活着时宠物在场')
  assert.equal(chipDot(tree).props['data-tone'], 'working')

  fail = true
  timers.shift().fn()
  await settle()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(chipDot(tree), null, '断了连绿点都不留：绿点只代表真实 EGM 活动')
  assert.equal(findByClass(tree, 'egm-pet-chip'), null, 'stale 时宠物收起，不再继续动画')
  assert.match(textOf(findByClass(tree, 'egm-chip')), /3/, '历史条数如实保留')
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  const panel = findById(tree, 'egm-mode-panel')
  assert.match(textOf(panel), /状态断了/, '面板如实标注断线')
  assert.ok(containsNode(statusDetails(panel), findByClass(panel, 'egm-warn')), '断线说明也在折叠区里')
})

test('状态：空闲或没有真实 EGM 活动时，入口不亮绿点', async () => {
  const cases = [
    { name: '空闲', state: 'idle', elephant: { status: 'idle', known: true, working: false } },
    { name: 'prep 只是阶段名', state: 'prep', elephant: { status: 'running', known: true } },
    {
      name: '普通对话里主 Agent 在跑',
      state: 'crit',
      elephant: { status: 'working', known: true, working: true, workingOnEgm: false },
    },
  ]
  for (const row of cases) {
    const { mod, react } = await loadBundle()
    const rpc = makeRpc()
    rpc.set(async () => ({
      ok: true,
      value: { sessionId: 's1', state: row.state, count: 1, goldfish: [], elephant: row.elephant },
    }))
    const { Dock } = asTree(mod, react, rpc)
    react.render(Dock, { sessionId: 's1' })
    await settle()
    const tree = react.render(Dock, { sessionId: 's1' })
    assert.equal(chipDot(tree), null, row.name + '：不亮绿点，也不留假的工作灯')
    assert.equal(petChips(tree).length, 0, row.name + '：不常驻宠物')
  }
})

test('状态：真在干 EGM 的活才亮绿点，绿点和宠物同进同出', async () => {
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: workingState() }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  const tree = react.render(Dock, { sessionId: 's1' })
  const dot = chipDot(tree)
  assert.ok(dot, '真有 EGM 活动才有绿点')
  assert.equal(dot.props['data-tone'], 'working')
  assert.equal(dot.props.title, '正在工作')
  assert.equal(petChips(tree).length, 2, '绿点和两只宠物一起出现')

  // 只有金鱼在跑也算真实活动：绿点不该绑在某一个角色上。
  const second = await loadBundle()
  const live = makeRpc()
  live.set(async () => ({
    ok: true,
    value: {
      sessionId: 's1',
      state: 'crit',
      count: 1,
      goldfish: [{ id: 'g1', role: 'logic', status: 'running' }],
      elephant: { status: 'idle', known: true, working: false },
    },
  }))
  const built = asTree(second.mod, second.react, live)
  second.react.render(built.Dock, { sessionId: 's1' })
  await settle()
  const tree2 = second.react.render(built.Dock, { sessionId: 's1' })
  assert.equal(chipDot(tree2).props['data-tone'], 'working', '金鱼在跑就亮绿点')
  assert.equal(petChips(tree2).length, 1)
})

test('几何：跨行高 textarea 时，入口不会卡在按钮行上下溢出压到文字', async () => {
  const { mod } = await loadBundle()
  const card = { left: 0, top: 0, right: 400, bottom: 120, width: 400, height: 120 }
  const textarea = { left: 0, top: 0, right: 400, bottom: 75, width: 400, height: 75 }
  const button = { left: 0, top: 65, right: 30, bottom: 95, width: 30, height: 30 }
  const placement = mod.__test.choosePillPlacement({
    card,
    size: { width: 96, height: 26 },
    obstacles: [textarea, button],
    viewport: { width: 400, height: 120 },
  })
  // 按按钮行居中会落到 top≈67，纵向 67..93 与 textarea 的 0..75 重叠：
  // 没有真正空出来的整段高度就返回 null，交给调用方缩小/退到底部条。
  if (placement) {
    const rect = { left: placement.left, top: placement.top, right: placement.left + 96, bottom: placement.top + 26 }
    for (const obstacle of [textarea, button]) {
      const overlap = rect.left < obstacle.right && rect.right > obstacle.left && rect.top < obstacle.bottom && rect.bottom > obstacle.top
      assert.ok(!overlap, '入口不能和任何控件相交：' + JSON.stringify(rect) + ' vs ' + JSON.stringify(obstacle))
    }
  }
  assert.equal(placement, null, '这一行没有能放下整只入口的空档')
})

test('几何：入口一旦给出位置，就一定不和任何障碍物相交', async () => {
  const { mod } = await loadBundle()
  const cases = [
    {
      card: { left: 0, top: 0, right: 400, bottom: 120, width: 400, height: 120 },
      obstacles: [
        { left: 0, top: 0, right: 400, bottom: 75, width: 400, height: 75 },
        { left: 0, top: 65, right: 30, bottom: 95, width: 30, height: 30 },
      ],
    },
    {
      card: { left: 120, top: 560, right: 920, bottom: 700, width: 800, height: 140 },
      obstacles: [
        { left: 120, top: 560, right: 900, bottom: 640, width: 780, height: 80 },
        { left: 128, top: 620, right: 156, bottom: 648, width: 28, height: 28 },
        { left: 820, top: 620, right: 848, bottom: 648, width: 28, height: 28 },
      ],
    },
    {
      card: { left: 20, top: 300, right: 380, bottom: 440, width: 360, height: 140 },
      obstacles: [
        { left: 20, top: 300, right: 380, bottom: 380, width: 360, height: 80 },
        { left: 28, top: 390, right: 120, bottom: 418, width: 92, height: 28 },
      ],
    },
  ]
  for (const item of cases) {
    const size = { width: 96, height: 26 }
    const placement = mod.__test.choosePillPlacement({ ...item, size, viewport: { width: 1200, height: 800 } })
    if (!placement) continue
    const rect = {
      left: placement.left,
      top: placement.top,
      right: placement.left + size.width,
      bottom: placement.top + size.height,
    }
    for (const obstacle of item.obstacles) {
      const overlap =
        rect.left < obstacle.right && rect.right > obstacle.left && rect.top < obstacle.bottom && rect.bottom > obstacle.top
      assert.ok(!overlap, '不相交：' + JSON.stringify({ rect, obstacle }))
    }
  }
})

test('几何：跨行高 textarea 挡死控制行时，底部条兜底也不碰文字', async () => {
  const { mod } = await loadBundle()
  const card = { left: 0, top: 0, right: 400, bottom: 120, width: 400, height: 120 }
  const textarea = { left: 0, top: 0, right: 400, bottom: 75, width: 400, height: 75 }
  const button = { left: 0, top: 65, right: 30, bottom: 95, width: 30, height: 30 }
  const dock = mod.__test.chooseDockPlacement({
    card,
    size: { width: 96, height: 26 },
    obstacles: [textarea, button],
    viewport: { width: 400, height: 120 },
  })
  assert.ok(dock)
  assert.ok(dock.top >= textarea.bottom, '兜底条在文字下面')
})

test('观察器：subtree 覆盖深层进度卡，但过滤掉自己渲染的节点', async () => {
  const { mod, react, observers } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  react.render(Dock, { sessionId: 's1' })

  const mutation = observers.instances.find((item) => item.kind === 'mutation')
  assert.ok(mutation, '注册了 MutationObserver')
  assert.equal(mutation.options.subtree, true, '必须看深层节点，进度卡不在 seat 的直接子层')
  assert.equal(mutation.options.childList, true)

  const ourNode = { nodeType: 1 }
  const ours = { contains: (node) => node === ourNode }
  const element = { nodeType: 1 }
  assert.equal(
    mod.__test.mutationTouchesComposer({ target: ourNode, addedNodes: [element], removedNodes: [] }, ours),
    false,
    '自己区域里的变化要忽略，否则会自激',
  )
  assert.equal(
    mod.__test.mutationTouchesComposer({ target: null, addedNodes: [], removedNodes: [element] }, ours),
    true,
    '外部节点增删要重测',
  )
  assert.equal(
    mod.__test.mutationTouchesComposer({ target: null, addedNodes: [], removedNodes: [] }, ours),
    true,
    '外部文字类变化也要重测',
  )
  assert.equal(
    mod.__test.mutationTouchesComposer({ target: ourNode, addedNodes: [], removedNodes: [] }, ours),
    false,
    '自己区域里的空变化同样忽略',
  )
})

test('行为：座位尺寸不变但深层进度卡插进来，也能触发重测', async () => {
  const { mod, react, dom, observers } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onContextMenu()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel').props.style.bottom, '276px')

  // 座位高度不变，但内部多了一张进度卡：只有 subtree 的 mutation 记录能看到它。
  dom.state.card = Object.assign({}, dom.state.card, { top: 620 })
  dom.state.seat = Object.assign({}, dom.state.seat, { top: 460 })
  const mutation = observers.instances.find((item) => item.kind === 'mutation')
  mutation.fire([{ target: dom.stackTarget, addedNodes: [{ nodeType: 1 }], removedNodes: [] }])
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-mode-panel').props.style.bottom, '316px', '深层插入触发重测')
})

test('观察器：同一帧内多次变化只重测一次，卸载时取消排队', async () => {
  const { mod, react, observers, frames, flushFrame } = await loadBundle({ raf: true })
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  await settle()
  react.render(Dock, { sessionId: 's1' })
  flushFrame() // 消费挂载后的主动测量，后面单独验证事件合帧。

  const resize = observers.instances.find((item) => item.kind === 'resize')
  const mutation = observers.instances.find((item) => item.kind === 'mutation')
  resize.fire()
  resize.fire()
  mutation.fire([{ target: null, addedNodes: [{ nodeType: 1 }], removedNodes: [] }])
  mutation.fire([{ target: null, addedNodes: [{ nodeType: 1 }], removedNodes: [] }])
  assert.equal(frames.length, 1, '三个来源四个回调，同一帧只排一次重测')
  assert.equal(flushFrame(), 1, 'flush 后队列清空')
  assert.equal(frames.length, 0)

  resize.fire()
  assert.equal(frames.length, 1)
  react.render(Dock, { sessionId: undefined })
  assert.equal(frames.length, 0, '卸载/切会话时取消还没执行的回调')
})

// ---- 0.8.2：首次挂载、局部锚点恢复与真实错误原因 ------------------------

test('挂载：没有轮询结果或观察器事件也会主动重测一次', async () => {
  const { mod, react, frames, flushFrame } = await loadBundle({ raf: true })
  const rpc = makeRpc()
  rpc.set(() => new Promise(() => {}))
  const { Dock } = asTree(mod, react, rpc)
  const first = react.render(Dock, { sessionId: 's1' })
  assert.equal(first.props['data-panel-mode'], 'hidden', '首轮 ref 尚未挂载')
  assert.equal(frames.length, 1, 'effect 必须主动排队，不能等 resize/poll 来救活')
  const before = react.updates
  assert.equal(flushFrame(), 1)
  assert.equal(react.updates, before + 1, '挂载测量触发真实 state 更新')
  const ready = react.render(Dock, { sessionId: 's1' })
  assert.equal(ready.props['data-egm-version'], '0.8.3')
  assert.equal(ready.props['data-egm-anchor'], 'ready')
  assert.notEqual(ready.props['data-panel-mode'], 'hidden')
  assert.equal(frames.length, 0, '重渲染自身不得重复排队')
})

test('锚点：同 seat 的兄弟工具栏可定位，缺失/歧义/跨 seat 均拒绝', async () => {
  const { mod, dom } = await loadBundle({ dom: { toolbarSibling: true } })
  const resolve = mod.__test.resolveComposerCard
  assert.equal(resolve(dom.rootNode), dom.cardNode)
  const foreignSeat = {}
  const foreignCard = { closest: () => foreignSeat }
  dom.state.cards = [foreignCard]
  assert.equal(resolve(dom.rootNode), null, '不能借另一个 seat 的输入框')
  const second = { closest: () => dom.seatNode }
  dom.state.cards = [dom.cardNode, second]
  assert.equal(resolve(dom.rootNode), null, '同 seat 两张卡片时不猜')
  dom.state.cards = [{ isConnected: false, closest: () => dom.seatNode }]
  assert.equal(resolve(dom.rootNode), null, '旧的脱离节点不能作为锚点')
  dom.state.cards = [dom.cardNode]
  dom.state.composing = true
  assert.equal(mod.__test.isComposingComposer(dom.rootNode), true, 'IME 使用相同解析路径')
})

test('恢复：初次无卡片，后插入与替换都会重新绑定观察器', async () => {
  const { mod, react, dom, observers, flushFrame } = await loadBundle({ raf: true, dom: { noCard: true, toolbarSibling: true } })
  const rpc = makeRpc()
  rpc.set(() => new Promise(() => {}))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  flushFrame()
  let tree = react.render(Dock, { sessionId: 's1' })
  assert.notEqual(tree.props['data-panel-mode'], 'hidden', '卡片缺失但按钮可测仍可定位')
  const mutation = observers.instances.find((item) => item.kind === 'mutation')
  const resize = observers.instances.find((item) => item.kind === 'resize')
  assert.ok(mutation.targets.includes(dom.seatNode), '盯稳定 seat，不能只盯尚不存在的 card')
  dom.state.noCard = false
  mutation.fire([{ target: dom.seatNode, addedNodes: [{ nodeType: 1 }], removedNodes: [] }])
  assert.equal(flushFrame(), 1)
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(tree.props['data-egm-anchor'], 'ready')
  assert.ok(resize.targets.includes(dom.cardNode))
  const replacement = { ...dom.cardNode, isConnected: true }
  dom.state.cards = [replacement]
  mutation.fire([{ target: dom.seatNode, addedNodes: [{ nodeType: 1 }], removedNodes: [{ nodeType: 1 }] }])
  assert.equal(flushFrame(), 1)
  assert.ok(resize.targets.includes(replacement), '重绑新的 card，不只观察已脱离旧卡片')
})

test('提示：定位失败与发送接口错误都不再误称放不下', async () => {
  const { mod, react, dom } = await loadBundle({ dom: { noCard: true, float: { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } } })
  const rpc = makeRpc()
  rpc.set(() => new Promise(() => {}))
  const { Dock } = asTree(mod, react, rpc)
  react.render(Dock, { sessionId: 's1' })
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  tree = react.render(Dock, { sessionId: 's1' })
  assert.match(textOf(findByClass(tree, 'egm-chip')), /定位失败/)
  assert.doesNotMatch(textOf(findByClass(tree, 'egm-chip')), /放不下/)
  assert.match(findByClass(tree, 'egm-chip').props.title, /0\.8\.3.*量不到/)
  assert.equal(mod.__test.entryNoticeLabel('宿主接口出现异常'), '查看提示')
})

// ── 大象模式：复用宿主自己的输入框和附件，标记不可编辑、只随模式消失 ──────────

async function modeScene(options = {}) {
  const { mod, react, sandbox, dom } = await loadBundle(options.dom ? { dom: options.dom } : undefined)
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const store = composer(options.draft || '', options.composer || {})
  const { Dock } = asTree(mod, react, rpc, { conversation: store.conversation })
  react.render(Dock, { sessionId: options.sessionId || 's1' })
  await settle()
  return { mod, react, rpc, store, Dock, sandbox, dom }
}

function clickChip(react, Dock, sessionId = 's1', handler = 'onClick', options = {}) {
  let tree = react.render(Dock, { sessionId })
  findByClass(tree, 'egm-chip').props[handler]()
  tree = react.render(Dock, { sessionId })
  // 0.6.x 新流程：没记住过选择时，点入口先弹「选择启动方式」；
  // 这里默认替用户选第一项（对话框方式）再进模式，与真实点击路径一致。
  // options.choose=false 时不替选：用于「点入口=关模式」或只看弹窗本身的场景。
  if (handler === 'onClick' && options.choose !== false && findById(tree, 'egm-choose-panel')) {
    findByClass(tree, 'egm-option').props.onClick()
    tree = react.render(Dock, { sessionId })
  }
  return react.render(Dock, { sessionId })
}

test('模式：点入口就开，草稿装上 /egm 标记，输入区最左出现大象，且不发送', async () => {
  const { react, store, Dock } = await modeScene({ draft: '帮我审一下图纸' })
  const tree = clickChip(react, Dock)

  assert.equal(store.getDraft(), '/egm 帮我审一下图纸', '模式把 /egm 放到草稿最前，用户文字原样保留')
  assert.equal(store.getCommand(), '/egm ', '走宿主的命令 claim，而不是普通消息')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0, '开启模式不自动发送')

  const mark = findByClass(tree, 'egm-mode-mark')
  assert.ok(mark, '模式开启后必须有不可编辑的大象标记')
  assert.equal(mark.props['data-session'], 's1')
  assert.equal(mark.props['data-state'], 'armed')
  assert.equal(mark.props.type, 'button', '标记是个按钮：点它可以换启动方式，但不是文本编辑器')
  assert.equal(mark.props['aria-label'], '选择 EGM 启动方式')
  assert.equal(mark.props.style.left, '111px', '贴在输入卡左缘外沿（card.left-9），不压正文')
  assert.equal(mark.props.style.top, '621px', '按编辑器垂直中线定位（600+60/2-9），附件托盘顶开也不跑')
  assert.equal(findByClass(tree, 'egm-chip').props['aria-pressed'], 'true')
})

test('模式：已有草稿和引用时把 /egm 放最前，引用偏移跟着 +5', async () => {
  const { react, store, Dock } = await modeScene({
    draft: '看这个',
    composer: { references: [{ offset: 0, length: 1, clipboardText: '看' }] },
  })
  clickChip(react, Dock)
  assert.equal(store.getDraft(), '/egm 看这个')
  assert.deepEqual(
    store.getReferences().map((ref) => ({ offset: ref.offset, length: ref.length, clipboardText: ref.clipboardText })),
    [{ offset: 5, length: 1, clipboardText: '看' }],
  )
})

test('模式：输入框已有别的命令时不覆盖，标记标 stale 也不发送', async () => {
  const { react, store, Dock } = await modeScene({ draft: '/goal 做点事', composer: { command: '/goal ' } })
  const tree = clickChip(react, Dock)
  assert.equal(store.getDraft(), '/goal 做点事', '不覆盖用户已有的命令')
  assert.equal(store.getCommand(), '/goal ')
  assert.equal(findByClass(tree, 'egm-mode-mark').props['data-state'], 'stale')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0)
})

test('模式：关闭只摘掉 /egm 标记，用户文字留着，也不发送', async () => {
  const { react, store, Dock } = await modeScene({ draft: '帮我审一下图纸' })
  clickChip(react, Dock)
  const tree = clickChip(react, Dock)
  assert.equal(store.getDraft(), '帮我审一下图纸')
  assert.equal(store.getCommand(), null)
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '关掉模式，标记必须消失')
  assert.equal(findByClass(tree, 'egm-chip').props['aria-pressed'], 'false')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0)
})

test('模式：草稿是 /egm 加换行或制表符时不接管，需求一个字都不丢', async () => {
  for (const separator of ['\n', '\t']) {
    const draft = '/egm' + separator + '帮我审一下图纸'
    const { react, store, Dock } = await modeScene({ draft, composer: { phase: 'slash' } })
    const tree = clickChip(react, Dock)
    assert.equal(store.getDraft(), draft, '接管会改字，所以宁可不接管：原文一个字都没动')
    assert.equal(store.getCommand(), null, '没有硬装成 claim')
    assert.equal(store.calls.filter((call) => call[0] === 'setDraft').length, 0, '不接管就不写草稿')
    assert.equal(findByClass(tree, 'egm-mode-mark').props['data-state'], 'stale')
  }
})

test('模式：草稿只有 /egm 时不接管，原样留给宿主自己的斜杠裁决', async () => {
  const { react, store, Dock } = await modeScene({ draft: '/egm', composer: { phase: 'slash' } })
  const tree = clickChip(react, Dock)
  assert.equal(store.getDraft(), '/egm', '一个字符都不改')
  assert.equal(store.calls.filter((call) => call[0] === 'setDraft').length, 0, '斜杠草稿不碰')
  assert.equal(findByClass(tree, 'egm-mode-mark').props['data-state'], 'stale')
})

test('模式：chip 还没恢复就关模式，残留的 /egm 前缀也要清干净', async () => {
  const { react, store, Dock } = await modeScene({ draft: '帮我审图纸', composer: { dropCommand: true } })
  clickChip(react, Dock)
  assert.equal(store.getDraft(), '/egm 帮我审图纸', '开模式加前缀')
  assert.equal(store.getCommand(), null, '宿主还没恢复 chip，属于 pending')

  const tree = clickChip(react, Dock)
  assert.equal(store.getDraft(), '帮我审图纸', '关模式把 pending 的 /egm 也摘掉，用户文字留着')
  assert.equal(store.getCommand(), null)
  assert.equal(findByClass(tree, 'egm-mode-mark'), null)
})

test('模式：开了立刻关（chip 还没恢复）原文、引用、附件都不丢，也不留插件前缀', async () => {
  const { react, store, Dock } = await modeScene({
    draft: '帮我审图纸',
    composer: {
      dropCommand: true,
      references: [{ offset: 2, length: 2, clipboardText: '审图' }],
      attachments: ['a1', 'a2'],
    },
  })
  clickChip(react, Dock)
  assert.equal(store.getDraft(), '/egm 帮我审图纸', '开模式只加前缀')
  assert.equal(store.getReferences()[0].offset, 7, '引用跟着整体 +5')

  const tree = clickChip(react, Dock)
  assert.equal(store.getDraft(), '帮我审图纸', '关模式把插件自己加的前缀摘干净')
  assert.equal(store.getReferences()[0].offset, 2, '引用回到原偏移')
  assert.deepEqual(store.attachments.ids.slice(), ['a1', 'a2'], '附件一个不动')
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '标记也消失')
})

test('模式：用户自己写的 /egm 不替人删，关模式后如实说明仍会走 EGM', async () => {
  const { react, store, Dock } = await modeScene({ draft: '/egm 帮我审图纸', composer: { command: '/egm ' } })
  clickChip(react, Dock)
  const tree = clickChip(react, Dock)

  assert.equal(store.getDraft(), '/egm 帮我审图纸', '用户自己的文字一个字都不动')
  assert.equal(store.getCommand(), null, 'chip 摘掉')
  assert.equal(findByClass(tree, 'egm-mode-mark'), null)
  assert.ok(
    String(findByClass(tree, 'egm-chip').props.title).includes('仍然会走 EGM'),
    '不谎称已经清干净，明确告诉用户这条仍会走 EGM',
  )
})

test('模式：关模式时宿主没真正摘掉 chip，就留在模式里并提示，不谎称已关闭', async () => {
  const { react, store, Dock } = await modeScene({
    draft: '帮我审图纸',
    composer: { rejectSetDraft: (count) => count >= 2 },
  })
  clickChip(react, Dock)
  assert.equal(store.getCommand(), '/egm ', '开模式装上了 chip')

  const tree = clickChip(react, Dock)
  assert.equal(store.getDraft(), '/egm 帮我审图纸', '摘不掉就不动草稿')
  assert.equal(store.getCommand(), '/egm ', 'chip 还在，下一次发送仍会走 EGM')
  assert.ok(findByClass(tree, 'egm-mode-mark'), '模式仍然开着')
  assert.equal(findByClass(tree, 'egm-chip').props['aria-pressed'], 'true')
  assert.ok(
    String(findByClass(tree, 'egm-chip').props.title).includes('没能摘掉'),
    '如实报告没关掉',
  )
})

test('模式：会话隔离，切到别的会话既没有标记也不动那边草稿', async () => {
  const { react, store, Dock } = await modeScene({ draft: '甲' })
  clickChip(react, Dock, 's1')
  react.render(Dock, { sessionId: 's2' })
  const tree = react.render(Dock, { sessionId: 's2' })
  assert.equal(findByClass(tree, 'egm-mode-mark'), null)
  assert.equal(findByClass(tree, 'egm-chip').props['aria-pressed'], 'false')
  assert.equal(store.getDraft(), '/egm 甲', '切会话不改写草稿')
})

test('模式：不碰附件，也不提交', async () => {
  const { react, store, Dock } = await modeScene({ draft: '看图', composer: { attachments: ['a1'] } })
  clickChip(react, Dock)
  assert.deepEqual(store.attachments.ids, ['a1'], '附件原样留着')
  assert.equal(store.getDraft(), '/egm 看图')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0)
})

test('模式：输入法选词中不改写草稿，标记转 stale', async () => {
  const { react, store, Dock } = await modeScene({ draft: '正在输入', dom: { composing: true } })
  const tree = clickChip(react, Dock)
  assert.equal(store.getDraft(), '正在输入', '选词中绝不动草稿')
  assert.equal(findByClass(tree, 'egm-mode-mark').props['data-state'], 'stale')
})

test('模式：标记被删掉后按新草稿补回，收起面板不等于关模式', async () => {
  const { react, store, Dock } = await modeScene({ draft: '甲' })
  let tree = clickChip(react, Dock)
  store.shell.actions.setDraft('乙')
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(store.getDraft(), '/egm 乙', '标记被删后按当前草稿补回')

  tree = clickChip(react, Dock, 's1', 'onContextMenu')
  assert.ok(findById(tree, 'egm-mode-panel'), '右键入口打开状态面板')
  buttonByText(tree, '收起').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-panel'), null)
  assert.ok(findByClass(tree, 'egm-mode-mark'), '收起面板不等于关模式')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0)
})

test('模式：面板里没有独立输入框和“启动 EGM”按钮，只有开关和状态', async () => {
  const { react, Dock } = await modeScene()
  const tree = clickChip(react, Dock, 's1', 'onContextMenu')
  const panel = findById(tree, 'egm-mode-panel')
  assert.ok(panel)
  assert.equal(findById(tree, 'egm-launch-draft'), null, '不再有独立输入框')
  assert.ok(!textOf(panel).includes('启动 EGM'), '不再有启动按钮')
  assert.ok(textOf(panel).includes('开启大象模式'))
  assert.equal(statusDetails(panel).props.open, undefined, '状态默认折叠')
})

// ── 防误发：宿主的提交入口是编辑器 root 自己的 keydown，document 捕获阶段能拦在它前面 ──

/**
 * 照宿主真实结构造一个卡内按钮：.row 的最后一个子元素是 .trailing，
 * 发送键是 .trailing 的最后一个子元素，图标是 16×16 的 path（忙时换 rect=停止）。
 */
function cardButton(dom, options = {}) {
  const icon = options.icon || 'path'
  const svg = {
    getAttribute: (name) => {
      if (name === 'viewBox') return options.viewBox === undefined ? '0 0 16 16' : options.viewBox
      if (name === 'aria-hidden') return options.ariaHidden === undefined ? 'true' : options.ariaHidden
      return null
    },
    querySelector: (selector) => {
      if (icon === 'rect') return selector === 'rect' ? {} : null
      if (icon === 'path') return selector === 'path' ? {} : null
      return null
    },
  }
  const button = {
    disabled: Boolean(options.disabled),
    querySelector: (selector) => (selector === 'svg' ? (options.noSvg ? null : svg) : null),
    closest(selector) {
      if (selector === 'button') return button
      if (selector === '[data-composer-card]') {
        if (options.otherCard) return {}
        return options.inCard === false ? null : dom.cardNode
      }
      return null
    },
  }
  const parent = { lastElementChild: options.notLastChild ? {} : button }
  button.parentElement = parent
  const grand = { lastElementChild: options.notLastParent ? {} : parent }
  parent.parentElement = grand
  return button
}

function clickEvent(target) {
  const event = {
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      event.stopped = true
    },
  }
  return event
}

function enterEvent(overrides = {}) {
  const event = {
    key: 'Enter',
    target: { closest: (selector) => (selector === '[data-composer-card]' ? enterEvent.card : null) },
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      event.stopped = true
    },
  }
  return Object.assign(event, overrides)
}

test('模式：标记没接上时宿主 submit（Enter / 发送键 / actions.submit 共用）被拦下，不发普通消息', async () => {
  const { react, store, Dock } = await modeScene({
    draft: '帮我审一下图纸',
    composer: { ignoreSetDraft: true },
  })
  clickChip(react, Dock)
  assert.equal(store.getDraft(), '帮我审一下图纸', '宿主拒收时草稿保持原样')

  // 宿主的 Enter 与发送键都走 keyboard.submit，这里直接调同一个入口。
  store.shell.submit('queue', 'enter')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0, '一个字节都没发')
  assert.equal(store.getDraft(), '帮我审一下图纸', '草稿还在')
  assert.ok(
    store.calls.some((call) => call[0] === 'notify' && String(call[2]).includes('已拦下这条消息')),
    '如实告诉用户为什么没发出去',
  )

  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-mode-mark').props['data-state'], 'stale', '标记转成没接上')
  assert.ok(String(findByClass(tree, 'egm-chip').props.title).includes('已拦下'), '入口上也能看到')
})

test('模式：actions.submit 与 click 来源同样被闸门盖住，停止键根本不走 submit', async () => {
  const { react, store, Dock } = await modeScene({
    draft: '帮我审一下图纸',
    composer: { ignoreSetDraft: true },
  })
  clickChip(react, Dock)

  store.shell.actions.submit()
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0, '公开 actions.submit 也被盖住')

  store.shell.submit('queue', 'click')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0, '发送键的 click 来源也被盖住')
})

test('模式：只有图片没有文字且标记没接上时同样拦，接了 /egm 才放行', async () => {
  const blocked = await modeScene({
    draft: '',
    composer: { ignoreSetDraft: true, attachments: ['a1'] },
  })
  clickChip(blocked.react, blocked.Dock)
  blocked.store.shell.submit('queue', 'enter')
  assert.equal(
    blocked.store.calls.filter((call) => call[0] === 'submit').length,
    0,
    '纯图片也会被当普通消息发出去，必须拦',
  )

  const ok = await modeScene({ draft: '/egm ', composer: { command: '/egm ', attachments: ['a1'] } })
  clickChip(ok.react, ok.Dock)
  ok.store.shell.submit('queue', 'enter')
  assert.equal(ok.store.calls.filter((call) => call[0] === 'submit').length, 1, 'claimed 的 /egm 交给宿主发')
})

test('模式：读不到草稿时 submit 也拦下，不猜', async () => {
  const { react, store, Dock } = await modeScene({
    draft: '帮我审图纸',
    composer: { throwDraftSnapshot: true },
  })
  clickChip(react, Dock)
  store.shell.submit('queue', 'enter')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0, '证明不了会走 /egm，就不发')
})

test('模式：证明不了会走 /egm 的一律拦下（别的命令、未 claim 的斜杠、pending）', async () => {
  const own = await modeScene({ draft: '/goal 做点事', composer: { command: '/goal ' } })
  clickChip(own.react, own.Dock)
  own.store.shell.submit('queue', 'enter')
  assert.equal(own.store.calls.filter((call) => call[0] === 'submit').length, 0, '别的命令不放行，免得以为走了 EGM')

  const slash = await modeScene({ draft: '/unknown 甲', composer: { phase: 'slash' } })
  clickChip(slash.react, slash.Dock)
  slash.store.shell.submit('queue', 'enter')
  assert.equal(slash.store.calls.filter((call) => call[0] === 'submit').length, 0, '未 claim 的斜杠不能误放行')

  const pending = await modeScene({ draft: '/egm 甲', composer: { phase: 'slash' } })
  clickChip(pending.react, pending.Dock)
  pending.store.shell.submit('queue', 'enter')
  assert.equal(pending.store.calls.filter((call) => call[0] === 'submit').length, 0, 'chip 没恢复之前不算证明')

  const empty = await modeScene({ draft: '', composer: { ignoreSetDraft: true } })
  clickChip(empty.react, empty.Dock)
  empty.store.shell.submit('queue', 'enter')
  assert.equal(empty.store.calls.filter((call) => call[0] === 'submit').length, 1, '空草稿没有可发内容，不拦')
})

test('模式：标记挂上后 submit 照常放行，关掉模式立刻恢复原生 submit', async () => {
  const { react, store, Dock } = await modeScene({ draft: '甲' })
  clickChip(react, Dock)
  assert.equal(store.getCommand(), '/egm ')
  store.shell.submit('queue', 'enter')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 1, 'claimed 状态下交给宿主走 /egm')
  assert.equal(store.getCommand(), '/egm ', '发完之后模式还开着，chip 重新挂上等下一条')

  const again = await modeScene({ draft: '乙', composer: { ignoreSetDraft: true } })
  clickChip(again.react, again.Dock)
  clickChip(again.react, again.Dock) // 再点一次 = 关模式
  assert.equal(again.store.shell.submit, again.store.protoSubmit, '关掉模式后立刻还原原生 submit')
  again.store.shell.submit('queue', 'enter')
  assert.equal(again.store.calls.filter((call) => call[0] === 'submit').length, 1, '普通消息照常发')
})

test('模式：闸门只装在本会话的 shell 上，别的会话不受影响', async () => {
  const mine = composer('帮我审图纸', { ignoreSetDraft: true })
  const other = composer('别的会话的草稿', {})
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc, {
    conversation: { input: { shell: (id) => (id === 's2' ? other.shell : mine.shell) } },
  })
  react.render(Dock, { sessionId: 's1' })
  clickChip(react, Dock)

  mine.shell.submit('queue', 'enter')
  assert.equal(mine.calls.filter((call) => call[0] === 'submit').length, 0, '本会话被拦')

  other.shell.submit('queue', 'enter')
  assert.equal(other.calls.filter((call) => call[0] === 'submit').length, 1, '别的会话一点不受影响')
})

test('模式：别的插件后包一层时，卸载不拆别人的链，只把自己这层变直通', async () => {
  const { react, store, Dock } = await modeScene({ draft: '甲', composer: { ignoreSetDraft: true } })
  clickChip(react, Dock)
  const ours = store.shell.submit
  assert.notEqual(ours, store.protoSubmit, '模式开着时确实装了闸门')

  // 模拟另一个插件在我们之后又包了一层。
  const theirs = function theirs(...args) {
    return ours.apply(this, args)
  }
  store.shell.submit = theirs

  clickChip(react, Dock, 's1', 'onClick', { choose: false }) // 关模式（此时若已被自动关闭，也不替选）
  assert.equal(store.shell.submit, theirs, '不拆别人的链')

  store.shell.submit('queue', 'enter')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 1, '我们这层已经直通，普通发送照常')
})

test('模式：同一份草稿最多补 3 次标记，不会无限 setDraft 打转', async () => {
  const { react, store, Dock, sandbox } = await modeScene({
    draft: '甲',
    composer: { ignoreSetDraft: true },
  })
  clickChip(react, Dock)
  for (let index = 0; index < 8; index += 1) {
    store.shell.submit('queue', 'enter')
  }
  const writes = store.calls.filter((call) => call[0] === 'setDraft').length
  assert.ok(writes <= 3, `同一份草稿最多写 3 次，实际 ${writes}`)
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0)
})

test('模式：输入法选词结束后自动重试，把标记补回来', async () => {
  const { react, store, Dock, sandbox, dom } = await modeScene({ draft: '正在输入', dom: { composing: true } })
  clickChip(react, Dock)
  assert.equal(store.getDraft(), '正在输入', '选词期间绝不动草稿')
  assert.equal(
    store.calls.filter((call) => call[0] === 'setDraft').length,
    0,
    '选词中一次都不写草稿',
  )

  dom.state.composing = false
  sandbox.document.dispatch('compositionend', {})
  await settle()

  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(store.getDraft(), '/egm 正在输入', '选词结束后补上标记')
  assert.equal(store.getCommand(), '/egm ')
  assert.equal(findByClass(tree, 'egm-mode-mark').props['data-state'], 'armed')
})

test('模式：宿主不让接管发送入口时不开模式，明确提示且草稿一个字不动', async () => {
  const { react, store, Dock } = await modeScene({ draft: '帮我审图纸', composer: { lockedSubmit: true } })
  const tree = clickChip(react, Dock)

  assert.equal(store.getDraft(), '帮我审图纸', '草稿原样保留，没有加 /egm')
  assert.equal(store.getCommand(), null)
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '装不上闸门就不显示“开着”')
  const title = findByClass(tree, 'egm-chip').props.title
  assert.match(title, /没有开启/, '如实说明为什么没开')
})

test('模式：闸门被别的插件盖住后自动关模式，摘掉自己加的 /egm 并说明原因', async () => {
  const { react, store, Dock } = await modeScene({ draft: '甲' })
  clickChip(react, Dock)
  assert.equal(store.getDraft(), '/egm 甲')

  // 模拟另一个插件在我们之上又包了一层：我们这层不再是被调用的顶层。
  store.shell.submit = function replaced(...args) {
    return store.protoSubmit.apply(this, args)
  }
  store.publish()

  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '不再显示模式开着')
  assert.equal(store.getDraft(), '甲', '摘掉插件自己加的前缀，用户文字留着')
  assert.equal(store.getCommand(), null)
  assert.match(findByClass(tree, 'egm-chip').props.title, /自动关闭/)
})

test('模式：宿主换了 shell 实例后自动关模式，不再假装拦得住', async () => {
  const mine = composer('甲', {})
  const other = composer('乙', {})
  let current = mine.shell
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc, {
    conversation: { input: { shell: () => current } },
  })
  react.render(Dock, { sessionId: 's1' })
  clickChip(react, Dock)
  assert.equal(mine.getCommand(), '/egm ')

  current = other.shell
  mine.publish()

  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, 'shell 换了就不再显示模式开着')
  assert.equal(other.getDraft(), '乙', '不动另一个 shell 的草稿')
  assert.match(findByClass(tree, 'egm-chip').props.title, /自动关闭/)
})

test('模式：闸门判定自己抛错时照样拦下并提示，不把普通消息放出去', async () => {
  const { mod, store } = await modeScene({ draft: '甲' })
  // 直接测闸门本身：判定逻辑抛异常时必须 fail closed（不能因为我们的 bug 放行）。
  const gate = mod.__test.installSubmitGate('s1', store.shell, () => {
    throw new Error('boom')
  })
  assert.ok(gate, '闸门装上了')

  store.shell.submit('queue', 'enter')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0, '抛错也拦')
  assert.ok(
    store.calls.some((call) => call[0] === 'notify' && /出错/.test(call[2])),
    '告诉用户为什么没发',
  )
  mod.__test.releaseSubmitGate('s1')
})

test('模式：被动关模式时不动用户自己写的 /egm，并如实说明没动', async () => {
  // 用户自己敲的 /egm：chip 是宿主装的，ownedRef 一直是 false。
  const { react, store, Dock } = await modeScene({ draft: '/egm 甲' })
  clickChip(react, Dock)
  assert.equal(store.getDraft(), '/egm 甲')

  store.shell.submit = function replaced(...args) {
    return store.protoSubmit.apply(this, args)
  }
  store.publish()

  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '模式已经关了')
  assert.equal(store.getDraft(), '/egm 甲', '归属不明就一个字都不删')
  assert.match(findByClass(tree, 'egm-chip').props.title, /没有动它/)
})

test('模式：换 shell 后只清旧 shell 里自己加的前缀，新 shell 的草稿一个字不碰', async () => {
  const mine = composer('甲', {})
  const other = composer('/egm 乙', {})
  let current = mine.shell
  const { mod, react } = await loadBundle()
  const rpc = makeRpc()
  rpc.set(async () => ({ ok: true, value: { sessionId: 's1', state: 'idle', count: 0, goldfish: [] } }))
  const { Dock } = asTree(mod, react, rpc, { conversation: { input: { shell: () => current } } })
  react.render(Dock, { sessionId: 's1' })
  clickChip(react, Dock)
  assert.equal(mine.getDraft(), '/egm 甲', '前缀是我们加的（ownedRef=true）')

  current = other.shell
  mine.publish()

  react.render(Dock, { sessionId: 's1' })
  assert.equal(mine.getDraft(), '甲', '旧 shell 里我们加的前缀清掉')
  assert.equal(other.getDraft(), '/egm 乙', '新 shell 的草稿一个字不碰')
})

test('模式：state 缺 draft 或缺 attachmentIds 时一律阻断，不默认成空放行', async () => {
  const { mod } = await modeScene({ draft: '甲' })
  const { modeBlocksSend } = mod.__test
  const withState = (state) => ({ state: { getSnapshot: () => state } })

  assert.equal(modeBlocksSend(true, withState({ phase: 'plain' })), true, '缺 draft 与 attachmentIds')
  assert.equal(
    modeBlocksSend(true, withState({ draft: '甲', phase: 'plain' })),
    true,
    '缺 attachmentIds（纯图片草稿会被误当空）',
  )
  assert.equal(
    modeBlocksSend(true, withState({ draft: '', attachmentIds: ['a1'] })),
    true,
    '纯附件且没有 /egm claim：拦',
  )
  assert.equal(modeBlocksSend(true, withState({ draft: '', attachmentIds: [] })), false, '真的没东西可发')
  assert.equal(modeBlocksSend(false, withState({ phase: 'plain' })), false, '模式关着就不管')
})

test('模式：闸门被换掉到被发现之间的一次发送会绕过（如实记录可实现边界）', async () => {
  const { react, store, Dock } = await modeScene({ draft: '甲', composer: { ignoreSetDraft: true } })
  clickChip(react, Dock)

  // 别的插件把我们这层盖掉：此刻我们已不在调用链上，没有任何回调会通知我们。
  store.shell.submit = function replaced(...args) {
    return store.protoSubmit.apply(this, args)
  }

  // 在下次渲染/状态变更之前发送：闸门根本不被调用，宿主按原生行为发出。
  store.shell.submit('queue', 'enter')
  assert.equal(
    store.calls.filter((call) => call[0] === 'submit').length,
    1,
    '这一条绕过闸门——插件侧无法即时感知，检测只能发生在下一次渲染/状态变更',
  )

  // 下一次状态变更就把模式关掉，不再继续假装开着。
  store.publish()
  const tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '发现后立刻关模式')
})

test('启动方式：记住的选择要能存、能读、读不出就当没选过', async () => {
  const { readLaunchPreference, writeLaunchPreference } = await loadBundle().then((r) => r.mod.__test)
  const memory = new Map()
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
  }

  assert.equal(readLaunchPreference(storage), null, '没选过就是 null')
  assert.equal(writeLaunchPreference('composer', storage), true, '写入成功')
  assert.equal(readLaunchPreference(storage), 'composer')
  assert.equal(writeLaunchPreference('card', storage), true)
  assert.equal(readLaunchPreference(storage), 'card')

  memory.set('egm.launchMode', 'fish')
  assert.equal(readLaunchPreference(storage), null, '不认识的值当没选过')
  memory.set('egm.launchMode', '')
  assert.equal(readLaunchPreference(storage), null)
  memory.clear()
  assert.equal(writeLaunchPreference('whatever', storage), false, '非法值不写')

  const broken = {
    getItem: () => {
      throw new Error('boom')
    },
    setItem: () => {
      throw new Error('boom')
    },
  }
  assert.equal(readLaunchPreference(broken), null, '读取抛错当没选过，不让设置页崩')
  assert.equal(writeLaunchPreference('card', broken), false, '写入抛错返回 false（下次再问一次）')
})

test('几何：大象标记贴输入卡左缘、垂直对齐输入框中线，并夹在卡片与视口内', async () => {
  const { chooseMarkPlacement } = await loadBundle().then((r) => r.mod.__test)

  assert.equal(chooseMarkPlacement(null, null, { width: 1200, height: 800 }), null, '没有输入卡就不放标记')

  const card = { left: 120, top: 560, right: 920, bottom: 700, width: 800, height: 140 }
  const input = { left: 134, top: 570, right: 900, bottom: 620, width: 766, height: 50 }
  const place = chooseMarkPlacement(card, input, { width: 1200, height: 800 })
  // left = card.left - 9（贴左缘），top = 输入框垂直中线 - 9（自身高 18 的一半）
  assert.equal(place.left, card.left - 9)
  assert.equal(place.top, Math.round(input.top + input.height / 2 - 9))

  // 卡片已经很靠左（left < 13）：夹到 4，不越过视口左边。
  const nearLeft = chooseMarkPlacement(
    { left: 2, top: 560, right: 802, bottom: 700, width: 800, height: 140 },
    input,
    { width: 1200, height: 800 },
  )
  assert.equal(nearLeft.left, 4, '贴左缘不能小于 4')

  // 输入框中线比卡片还高：夹回卡片范围内（card.top+4 到 card.bottom-22）。
  const weird = chooseMarkPlacement(
    card,
    { left: 134, top: 100, right: 900, bottom: 130, width: 766, height: 30 },
    { width: 1200, height: 800 },
  )
  assert.ok(weird.top >= card.top + 4, '标记不跑到输入卡上沿之外')

  // 窄视口：left 不越过视口右缘。
  const narrow = chooseMarkPlacement(card, input, { width: 30, height: 800 })
  assert.ok(narrow.left <= 30 - 22, '窄视口里标记不越过右缘')
})

// ── 启动方式选择卡（0.6.x）：点入口先问用哪种方式，可记住，卡片/对话框互斥 ──────

function collectByClass(tree, className) {
  return findAll(tree, (node) =>
    String((node.props && node.props.className) || '')
      .split(/\s+/)
      .includes(className),
  )
}

test('入口：没记住过选择时先弹选择卡；选「卡片方式」开卡片面板，不进大象模式', async () => {
  const { react, store, Dock } = await modeScene({ draft: '帮我画个封面' })
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })

  const chooser = findById(tree, 'egm-choose-panel')
  assert.ok(chooser, '第一次点入口：先问用哪种方式')
  assert.ok(textOf(chooser).includes('对话框方式'), '列出了对话框方式')
  assert.ok(textOf(chooser).includes('卡片方式'), '列出了卡片方式')
  assert.ok(textOf(chooser).includes('不再提示'), '带「不再提示」勾选')
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '还没选方式，不进大象模式')

  const optionButtons = collectByClass(tree, 'egm-option')
  assert.equal(optionButtons.length, 2, '两个选项')
  assert.ok(textOf(optionButtons[0]).includes('对话框方式'), '第一项是对话框方式')
  optionButtons[1].props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })

  assert.ok(findById(tree, 'egm-launch-panel'), '卡片面板打开了')
  assert.equal(findById(tree, 'egm-choose-panel'), null, '选完方式，选择卡关掉')
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '没有进大象模式')
  assert.equal(store.getDraft(), '帮我画个封面', '卡片方式不动输入框草稿')
  assert.equal(store.calls.filter((call) => call[0] === 'submit').length, 0, '开卡片不发送')
})

test('入口：勾选「不再提示」记住对话框方式后，再点入口直接进模式不再问', async () => {
  const { react, store, Dock, sandbox } = await modeScene({ draft: '甲' })
  const memory = new Map()
  sandbox.window.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
  }
  let tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-chip').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })

  const checkbox = findByClass(tree, 'egm-check').children[0]
  checkbox.props.onChange({ target: { checked: true } })
  tree = react.render(Dock, { sessionId: 's1' })
  findByClass(tree, 'egm-option').props.onClick()
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(store.getDraft(), '/egm 甲', '选对话框方式进模式')
  assert.equal(memory.get('egm.launchMode'), 'composer', '选择被记住')

  findByClass(tree, 'egm-chip').props.onClick() // 模式开着 → 关
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '模式关了')

  findByClass(tree, 'egm-chip').props.onClick() // 记住了 composer → 直接进
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findById(tree, 'egm-choose-panel'), null, '记住了就不再弹选择卡')
  assert.ok(findByClass(tree, 'egm-mode-mark'), '直接进大象模式')
})

test('方式：大象模式开着时点大象标记换方式；选卡片先退模式再开卡片（互斥）', async () => {
  const { react, store, Dock } = await modeScene({ draft: '甲' })
  let tree = clickChip(react, Dock)
  assert.ok(findByClass(tree, 'egm-mode-mark'), '先进了对话框模式')
  assert.equal(store.getDraft(), '/egm 甲')

  findByClass(tree, 'egm-mode-mark').props.onClick() // 大象标记：换方式
  tree = react.render(Dock, { sessionId: 's1' })
  assert.ok(findById(tree, 'egm-choose-panel'), '大象标记打开选择卡')

  collectByClass(tree, 'egm-option')[1].props.onClick() // 选卡片方式
  tree = react.render(Dock, { sessionId: 's1' })
  assert.equal(findByClass(tree, 'egm-mode-mark'), null, '对话框模式先退掉')
  assert.equal(store.getDraft(), '甲', '/egm 前缀摘干净')
  assert.ok(findById(tree, 'egm-launch-panel'), '卡片面板打开，两种方式不重叠')
})
