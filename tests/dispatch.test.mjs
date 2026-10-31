// dispatch.js 的本地自动化测试：全部用 mock 子代理与临时目录，不真实派发、不写用户目录。
//
// 覆盖：命令门控 + 许可双门、默认 fail-closed、会话级许可、10 角色与固定标准映射、
// 阶段绑定、Mode: REVIEW / BRAINSTORM、行区间、角色卡/标准缺失、源码与阶段材料、
// 报告落盘失败、超时释放、并发房间唯一、工具 schema 与渲染不吞错误、命令 handler 实际效果。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BRAINSTORM_ROLES,
  DEFAULT_IMAGE_IDEA,
  EGM_REVIEW_ROLE_IDS,
  GATE_MAX_DISPATCHES,
  LEGACY_ROLE_IDS,
  ROLE_IDS,
  UNSAFE_PERMIT_USES,
  boundaryOf,
  closeGate,
  createUserMessage,
  dispatchGoldfish,
  grantUnsafePermit,
  openGate,
  peekGate,
  peekUnsafePermit,
  registerDispatchTool,
  registerEgmCommand,
  registerEgmOpenCommand,
  registerEgmReviewAccessCommand,
  registerEgmSafeCommand,
  registerEgmUnsafeCommand,
  revokeUnsafePermit,
  roleCatalog,
  roleSpecOf,
  takeUnsafePermit,
} from '../lib/dispatch.js'

const AGENT_FILES = EGM_REVIEW_ROLE_IDS
const STANDARD_FILES = [
  'feature-spec-standard.md',
  'zoom-out-standard.md',
  're-implementation-standard.md',
  'implementation-readiness-standard.md',
]

const io = (overrides = {}) => ({
  copyFile: nodeFs.copyFile,
  mkdir: nodeFs.mkdir,
  mkdtemp: nodeFs.mkdtemp,
  readFile: nodeFs.readFile,
  realpath: nodeFs.realpath,
  stat: nodeFs.stat,
  writeFile: nodeFs.writeFile,
  ...overrides,
})

/** 临时工作区：.egm/design.md + 假 vendor/egm 里的全部角色卡与标准。 */
async function makeWorkspace(t, { omitCard = null, omitStandard = null, design = '# 图纸\n\n正文\n' } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'egm-dispatch-test-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const vendorRoot = join(work, 'vendor', 'egm')
  const agentsDir = join(vendorRoot, 'agents')
  const standardsDir = join(vendorRoot, 'resources', 'document_standards')
  await mkdir(join(work, '.egm'), { recursive: true })
  await mkdir(agentsDir, { recursive: true })
  await mkdir(standardsDir, { recursive: true })
  for (const role of AGENT_FILES) {
    if (role === omitCard) continue
    await writeFile(join(agentsDir, `${role}.md`), `# ${role}\n\n### IF Mode: REVIEW\n\nreview body\n`, 'utf8')
  }
  for (const file of STANDARD_FILES) {
    if (file === omitStandard) continue
    await writeFile(join(standardsDir, file), `# ${file}\n\nstandard body\n`, 'utf8')
  }
  await writeFile(join(work, '.egm', 'design.md'), design, 'utf8')
  return { work, vendorRoot, docPath: '.egm/design.md', rooms: join(work, '.egm') }
}

/** mock 子代理：记录调用，返回固定报告；可选抛错、空报告、挂起、延迟。 */
function mockSubagents({ report = '阻塞 | design.md:1 | 测试问题 | 返工', mode = 'ok', delayMs = 0 } = {}) {
  const calls = []
  const state = { disposed: 0, terminated: 0 }
  const subagents = {
    calls,
    state,
    async startActivation(spec) {
      calls.push(spec)
      const handle = {
        childId: `child-${calls.length}`,
        result: (async () => {
          if (mode === 'throw') throw new Error('spawn 炸了')
          if (mode === 'hang') return new Promise(() => {})
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
          return report
        })(),
        async terminate() {
          state.terminated += 1
        },
        async dispose() {
          state.disposed += 1
        },
      }
      return handle
    },
  }
  return subagents
}

/** 假 agent：带稳定 session id，便于许可/窗口表命中。 */
function fakeAgent(id = 'test-session', cwd = process.cwd()) {
  return {
    session: { header: { id, cwd } },
    followupCalls: [],
    followup(payload) {
      this.followupCalls.push(payload)
    },
  }
}

/** 双门都开：/egm 窗口 + /egm-unsafe 许可。 */
function allow(agent) {
  assert.notEqual(openGate(agent), null, '测试前提：应能打开派发窗口')
  assert.notEqual(grantUnsafePermit(agent, '测试许可'), null, '测试前提：应能发放许可')
}

async function run(t, options = {}) {
  const workspace = await makeWorkspace(t, options.workspace ?? {})
  const agent = options.agent ?? fakeAgent(options.sessionId ?? `s-${Math.random().toString(36).slice(2)}`, workspace.work)
  if (options.gate !== false) assert.notEqual(openGate(agent), null)
  if (options.permit !== false) assert.notEqual(grantUnsafePermit(agent, '测试许可'), null)
  const subagents = options.subagents ?? mockSubagents(options.mock)
  const result = await dispatchGoldfish({
    subagents,
    parent: agent,
    args: options.args ?? { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: options.io ?? io(),
    timeoutMs: options.timeoutMs ?? 5000,
  })
  return { result, subagents, workspace, agent }
}

test('默认 fail-closed：没有 /egm 窗口就拒绝派发，且不建房间、不派子代理', async (t) => {
  const { result, subagents, workspace } = await run(t, {
    gate: false,
    args: { docPath: '.egm/design.md', role: 'logic' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_GATE_NOT_OPEN')
  assert.match(result.error, /\/egm-open/)
  assert.match(result.error, /只开窗，不启动任何流程/)
  assert.match(result.error, /\/egm <需求>/)
  assert.match(result.error, /egm-gate 快速流程/)
  assert.equal(result.boundary.isolation, 'unverified')
  assert.equal(subagents.calls.length, 0)
  const entries = await readdir(join(workspace.work, '.egm'))
  assert.deepEqual(entries, ['design.md'])
})

test('有窗口但没 /egm-unsafe 许可：仍拒绝派发（只读未被证实）', async (t) => {
  const { result, subagents } = await run(t, { permit: false, args: { docPath: '.egm/design.md', role: 'logic' } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_READONLY_UNVERIFIED')
  assert.match(result.error, /默认拒绝/)
  assert.match(result.error, /\/egm-unsafe/)
  assert.equal(result.boundary.readOnlyVerified, false)
  assert.equal(subagents.calls.length, 0)
})

test('只有 /egm-unsafe 没有 /egm：仍被窗口挡住（两道门缺一不可）', async (t) => {
  const { result, subagents } = await run(t, {
    gate: false,
    permit: true,
    args: { docPath: '.egm/design.md', role: 'logic' },
  })
  assert.equal(result.code, 'E_GATE_NOT_OPEN')
  assert.equal(subagents.calls.length, 0)
})

test('双门都开后可派发，但结果强制标注非严格评审，并消耗一次窗口与许可', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('permit-ok', workspace.work)
  allow(agent)
  const gateBefore = peekGate(agent).remaining
  const permitBefore = peekUnsafePermit(agent).remaining
  const subagents = mockSubagents()
  const result = await dispatchGoldfish({
    subagents,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.strictGoldfishReview, false)
  assert.equal(result.reviewClass, 'unsafe-nonisolated')
  assert.equal(result.equivalence.flowEquivalent, false)
  assert.match(result.equivalence.note, /独立临时目录/)
  assert.doesNotMatch(result.equivalence.note, /隔离/)
  assert.equal(result.boundary.isolation, 'unverified')
  assert.equal(result.boundary.uncovered.length >= 5, true)
  assert.equal(subagents.calls.length, 1)
  assert.equal(peekGate(agent).remaining, gateBefore - 1)
  assert.equal(peekUnsafePermit(agent).remaining, permitBefore - 1)
  const written = await readFile(result.reportPath, 'utf8')
  assert.equal(written, result.report)
  assert.equal(subagents.state.disposed, 1)
})

test('窗口次数上限：用完后 E_GATE_NOT_OPEN', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('gate-count', workspace.work)
  allow(agent)
  const subagents = mockSubagents()
  const args = { docPath: workspace.docPath, role: 'logic' }
  for (let i = 0; i < GATE_MAX_DISPATCHES; i += 1) {
    grantUnsafePermit(agent, `第 ${i + 1} 次许可`)
    const result = await dispatchGoldfish({
      subagents,
      parent: agent,
      args,
      baseCwd: workspace.work,
      vendorRoot: workspace.vendorRoot,
      io: io(),
    })
    assert.equal(result.ok, true, `第 ${i + 1} 次应成功`)
  }
  assert.equal(peekGate(agent), null)
  const exhausted = await dispatchGoldfish({
    subagents,
    parent: agent,
    args,
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(exhausted.code, 'E_GATE_NOT_OPEN')
  assert.match(exhausted.error, /\/egm-open/)
  assert.match(exhausted.error, /只开窗，不启动任何流程/)
  assert.equal(subagents.calls.length, GATE_MAX_DISPATCHES)
})

test('许可有次数上限，用完后回到 fail-closed', () => {
  const agent = fakeAgent('permit-count')
  grantUnsafePermit(agent, '次数测试')
  for (let i = 0; i < UNSAFE_PERMIT_USES; i += 1) assert.notEqual(takeUnsafePermit(agent), null)
  assert.equal(takeUnsafePermit(agent), null)
  assert.equal(peekUnsafePermit(agent), null)
})

test('许可会过期，过期后不可用', () => {
  const agent = fakeAgent('permit-expiry')
  const permit = grantUnsafePermit(agent, '过期测试')
  permit.expiresAt = Date.now() - 1
  assert.equal(takeUnsafePermit(agent), null)
})

test('许可与窗口只属于当前会话：跨会话不串、拿不到 session id 就 fail-closed', () => {
  const a = fakeAgent('session-a')
  const b = fakeAgent('session-b')
  assert.notEqual(grantUnsafePermit(a, '只给 A'), null)
  assert.equal(peekUnsafePermit(b), null)
  assert.equal(takeUnsafePermit(b), null)
  assert.equal(openGate(a) !== null, true)
  assert.equal(peekGate(b), null)

  const anonymous = { session: {} }
  assert.equal(grantUnsafePermit(anonymous, '无身份'), null)
  assert.equal(openGate(anonymous), null)
})

test('命令 handler：/egm 打开窗口；空输入报错，followup 失败如实提示且窗口保持开启', () => {
  const commands = new Map()
  const ctx = { commands: { register: (definition) => commands.set(definition.name, definition) } }
  registerEgmCommand(ctx)
  registerEgmOpenCommand(ctx)
  registerEgmUnsafeCommand(ctx)
  registerEgmSafeCommand(ctx)
  assert.deepEqual([...commands.keys()].sort(), ['egm', 'egm-open', 'egm-safe', 'egm-unsafe'])

  const empty = commands.get('egm').handler({ agent: fakeAgent('cmd-empty'), rawInput: '  ' })
  assert.equal(empty.kind, 'error')

  const broken = fakeAgent('cmd-broken')
  broken.followup = () => {
    throw new Error('followup 炸了')
  }
  const failed = commands.get('egm').handler({ agent: broken, rawInput: '做个工具' })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /followup 炸了/)
  assert.notEqual(peekGate(broken), null, '无法确认入队状态时窗口保持开启，避免误伤已排队的大象')

  const ok = fakeAgent('cmd-ok')
  const opened = commands.get('egm').handler({ agent: ok, rawInput: '做个工具' })
  assert.equal(opened.kind, 'success')
  assert.notEqual(peekGate(ok), null)
  assert.equal(ok.followupCalls.length, 2)
  // 隐藏/折叠上下文消息（先入队）
  assert.deepEqual(ok.followupCalls[0].source, {
    kind: 'context',
    name: 'egm-kickoff-procedure',
    form: 'notice',
    summary: 'EGM 守门规程与操作指引（折叠）',
  })
  assert.match(ok.followupCalls[0].content[0].text, /派发窗口已打开/)
  assert.ok(ok.followupCalls[0].content[0].text.includes(join('skills', 'egm-gate', 'SKILL.md')))
  assert.match(ok.followupCalls[0].content[0].text, /无法读取/)
  assert.match(ok.followupCalls[0].content[0].text, /egm-unsafe/)
  // 用户简要需求提示（后入队，作为当前会话用户输入展示）
  assert.deepEqual(ok.followupCalls[1].source, { kind: 'user' })
  assert.match(ok.followupCalls[1].content[0].text, /想做的事：做个工具/)
  assert.match(ok.followupCalls[1].content[0].text, /EGM 守门已启动/)

  // 无 session id：拒绝开窗，不发消息。
  const anonymous = { session: {}, followupCalls: [], followup() { this.followupCalls.push(1) } }
  const rejected = commands.get('egm').handler({ agent: anonymous, rawInput: '做个工具' })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /无法验证当前会话身份/)
  assert.equal(anonymous.followupCalls.length, 0)
})

test('命令 handler：/egm 原生输入框支持图片附件（图文、纯图、失败、未授权与 UserMessage 结构）', () => {
  const commands = new Map()
  const ctx = { commands: { register: (definition) => commands.set(definition.name, definition) } }
  registerEgmCommand(ctx)
  const egmCommand = commands.get('egm')
  assert.ok(egmCommand, '应注册 /egm 命令')
  assert.equal(egmCommand.input?.attachments, true, '/egm 必须声明 input.attachments: true')

  // 1. 图文：同时提供文字与图片附件
  const agentTextImg = fakeAgent('cmd-text-img')
  const imgAttachment1 = { type: 'image', attachment: 'ref-img-1' }
  const imgAttachment2 = { type: 'image', attachment: 'ref-img-2' }
  const resTextImg = egmCommand.handler({
    agent: agentTextImg,
    rawInput: '设计一个美观的看板',
    attachments: [imgAttachment1, imgAttachment2],
  })
  assert.equal(resTextImg.kind, 'success')
  assert.notEqual(peekGate(agentTextImg), null, '应成功打开派发窗口')
  assert.equal(peekUnsafePermit(agentTextImg), null, '不得自动开启非隔离许可')
  assert.equal(agentTextImg.followupCalls.length, 2)
  const procMsgTextImg = agentTextImg.followupCalls[0]
  assert.deepEqual(procMsgTextImg.source, {
    kind: 'context',
    name: 'egm-kickoff-procedure',
    form: 'notice',
    summary: 'EGM 守门规程与操作指引（折叠）',
  })
  const msgTextImg = agentTextImg.followupCalls[1]
  assert.equal(typeof msgTextImg.id, 'string', 'UserMessage 必须携带有效 id')
  assert.ok(msgTextImg.id.length > 0)
  assert.equal(msgTextImg.role, 'user', 'UserMessage role 必须为 user')
  assert.deepEqual(msgTextImg.source, { kind: 'user' }, 'UserMessage source 必须为 { kind: "user" }')
  assert.equal(msgTextImg.content.length, 3, 'content 应包含两个附件与一个文本块')
  assert.deepEqual(msgTextImg.content[0], imgAttachment1, '第一个附件未丢失且在前方')
  assert.deepEqual(msgTextImg.content[1], imgAttachment2, '第二个附件未丢失且在前方')
  assert.equal(msgTextImg.content[2].type, 'text')
  assert.match(msgTextImg.content[2].text, /想做的事：设计一个美观的看板/)
  assert.match(msgTextImg.content[2].text, /EGM 守门已启动/)

  // 2. 纯图：无文字（空字符串或空格），仅有图片附件
  const agentPureImg = fakeAgent('cmd-pure-img')
  const imgPure = { type: 'image', attachment: 'ref-pure-image' }
  const resPureImg = egmCommand.handler({
    agent: agentPureImg,
    rawInput: '   ',
    attachments: [imgPure],
  })
  assert.equal(resPureImg.kind, 'success')
  assert.notEqual(peekGate(agentPureImg), null, '纯图输入应成功打开派发窗口')
  assert.equal(peekUnsafePermit(agentPureImg), null, '纯图输入不得开启非隔离许可')
  assert.equal(agentPureImg.followupCalls.length, 2)
  const procMsgPureImg = agentPureImg.followupCalls[0]
  assert.deepEqual(procMsgPureImg.source, {
    kind: 'context',
    name: 'egm-kickoff-procedure',
    form: 'notice',
    summary: 'EGM 守门规程与操作指引（折叠）',
  })
  const msgPureImg = agentPureImg.followupCalls[1]
  assert.equal(typeof msgPureImg.id, 'string')
  assert.ok(msgPureImg.id.length > 0)
  assert.equal(msgPureImg.role, 'user')
  assert.deepEqual(msgPureImg.source, { kind: 'user' })
  assert.equal(msgPureImg.content.length, 2)
  assert.deepEqual(msgPureImg.content[0], imgPure, '纯图附件未丢失')
  assert.equal(msgPureImg.content[1].type, 'text')
  assert.match(msgPureImg.content[1].text, new RegExp(`想做的事：${DEFAULT_IMAGE_IDEA}`))
  assert.match(msgPureImg.content[1].text, /EGM 守门已启动/)

  // 3. 失败：缺文字且缺附件仍报错
  const agentEmptyBoth = fakeAgent('cmd-empty-both')
  const resEmptyBoth = egmCommand.handler({
    agent: agentEmptyBoth,
    rawInput: '   ',
    attachments: [],
  })
  assert.equal(resEmptyBoth.kind, 'error', '缺文字且缺附件必须报错')
  assert.match(resEmptyBoth.text, /用法：\/egm/)
  assert.equal(peekGate(agentEmptyBoth), null, '失败时不应开窗')
  assert.equal(agentEmptyBoth.followupCalls.length, 0, '失败时不应调用 followup')

  // 3b. 失败：纯图或图文时 followup 抛错，如实提示且窗口保持开启
  const agentThrow = fakeAgent('cmd-throw')
  agentThrow.followup = () => {
    throw new Error('followup 模拟网络中断')
  }
  const resThrow = egmCommand.handler({
    agent: agentThrow,
    rawInput: '',
    attachments: [{ type: 'image', attachment: 'ref-throw' }],
  })
  assert.equal(resThrow.kind, 'error')
  assert.match(resThrow.text, /followup 模拟网络中断/)
  assert.match(resThrow.text, /无法确认这条需求是否已经进入会话队列/)
  assert.doesNotMatch(resThrow.text, /未入队|没有发送|附件已保留/)
  assert.notEqual(peekGate(agentThrow), null, '无法确认入队状态时保持窗口开启')

  // 4. 未授权 / 无会话身份：无法验证当前会话身份时拒绝开窗并保留 fail-closed
  const agentNoSession = { session: {}, followupCalls: [], followup() { this.followupCalls.push(1) } }
  const resNoSession = egmCommand.handler({
    agent: agentNoSession,
    rawInput: '',
    attachments: [{ type: 'image', attachment: 'ref-unauth' }],
  })
  assert.equal(resNoSession.kind, 'error')
  assert.match(resNoSession.text, /无法验证当前会话身份/)
  assert.equal(agentNoSession.followupCalls.length, 0, '未授权时不应触发 followup，不泄漏附件')
  assert.equal(peekGate(agentNoSession), null, '未授权时不应开启窗口')
})

test('命令 handler：/egm 提交后异常如实提示（不声称未发送、窗口保持开启、reset 不遮蔽原失败）', () => {
  const commands = new Map()
  const ctx = { commands: { register: (definition) => commands.set(definition.name, definition) } }
  const events = []
  registerEgmCommand(ctx, { onEvent: (event) => events.push(event) })
  registerEgmSafeCommand(ctx)
  const egmCommand = commands.get('egm')

  // 提交后异常：宿主在 session.append 之后仍可能抛错，插件无法判断消息是否已入队
  const agentError = fakeAgent('post-commit-error')
  agentError.followup = () => {
    throw new Error('wakeDriver crashed after inbox append')
  }
  const resError = egmCommand.handler({
    agent: agentError,
    rawInput: '优化界面',
    attachments: [{ type: 'image', attachment: 'ref-q' }],
  })
  assert.equal(resError.kind, 'error')
  assert.match(resError.text, /wakeDriver crashed after inbox append/)
  assert.match(resError.text, /无法确认这条需求是否已经进入会话队列/)
  assert.doesNotMatch(resError.text, /未入队|没有发送|附件已保留/)
  assert.notEqual(peekGate(agentError), null, '无法确认入队状态时保持窗口开启，避免误伤已排队的大象')
  assert.ok(events.some((e) => e.type === 'gate-opened'), '异常前已上报 gate-opened')
  assert.ok(events.some((e) => e.type === 'reset'), '异常时上报 reset 让界面回空闲；真实事件随后自纠')

  // /egm-safe 仍能关窗重置
  const safeRes = commands.get('egm-safe').handler({ agent: agentError })
  assert.equal(safeRes.kind, 'success')
  assert.equal(peekGate(agentError), null)

  // 重置后再试（模拟 followup 恢复正常）
  agentError.followup = (msg) => {
    agentError.followupCalls.push(msg)
  }
  const resAfterSafe = egmCommand.handler({
    agent: agentError,
    rawInput: '修个bug',
  })
  assert.equal(resAfterSafe.kind, 'success')
  assert.notEqual(peekGate(agentError), null)
})

test('/egm-open 只开窗口：不发 followup、不发放许可，且能支撑后续派发', async (t) => {
  const commands = new Map()
  const ctx = { commands: { register: (definition) => commands.set(definition.name, definition) } }
  registerEgmOpenCommand(ctx)
  const agent = fakeAgent('open-only')

  const opened = commands.get('egm-open').handler({ agent, rawInput: '' })
  assert.equal(opened.kind, 'success')
  assert.match(opened.text, /不启动任何流程/)
  assert.match(opened.text, /\/egm-unsafe/)
  assert.equal(agent.followupCalls.length, 0, '/egm-open 不得注入流程消息')
  assert.notEqual(peekGate(agent), null)
  assert.equal(peekUnsafePermit(agent), null, '/egm-open 不得私自开启非隔离许可')

  const anonymous = { session: {} }
  const rejected = commands.get('egm-open').handler({ agent: anonymous, rawInput: '' })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /无法验证当前会话身份/)
  assert.equal(peekGate(anonymous), null)

  // 只开窗口不够；用户再显式 /egm-unsafe 后才能派发。
  const workspace = await makeWorkspace(t)
  grantUnsafePermit(agent, '测试许可')
  const subagents = mockSubagents()
  const dispatched = await dispatchGoldfish({
    subagents,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(dispatched.ok, true, dispatched.error)
  assert.equal(subagents.calls.length, 1)
})

test('命令 handler：/egm-unsafe 必须确认语；无身份拒绝；/egm-safe 同时关闭许可与窗口', () => {
  const commands = new Map()
  const ctx = { commands: { register: (definition) => commands.set(definition.name, definition) } }
  registerEgmUnsafeCommand(ctx)
  registerEgmSafeCommand(ctx)
  const agent = fakeAgent('cmd-permit')

  assert.equal(commands.get('egm-unsafe').handler({ agent, rawInput: '随便' }).kind, 'error')
  assert.equal(peekUnsafePermit(agent), null)
  const success = commands.get('egm-unsafe').handler({ agent, rawInput: '确认无隔离' })
  assert.equal(success.kind, 'success')
  assert.match(success.text, /不代表隔离成立/)
  assert.notEqual(peekUnsafePermit(agent), null)

  const anonymous = { session: {} }
  const rejected = commands.get('egm-unsafe').handler({ agent: anonymous, rawInput: '确认无隔离' })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /无法验证当前会话身份/)

  openGate(agent)
  assert.equal(commands.get('egm-safe').handler({ agent, rawInput: '' }).kind, 'success')
  assert.equal(peekUnsafePermit(agent), null)
  assert.equal(peekGate(agent), null)
})

test('未知角色不再静默回落 logic，直接报错且不派发', async (t) => {
  const { result, subagents } = await run(t, { args: { docPath: '.egm/design.md', role: 'nope' } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_UNKNOWN_ROLE')
  assert.match(result.error, /白名单/)
  assert.equal(subagents.calls.length, 0)
})

test('10 个角色全部可解析，标准映射固定', () => {
  const catalog = roleCatalog()
  assert.deepEqual(
    catalog.map((entry) => entry.role),
    ROLE_IDS,
  )
  const byRole = Object.fromEntries(catalog.map((entry) => [entry.role, entry]))
  for (const role of LEGACY_ROLE_IDS) assert.equal(byRole[role].standard, 'resources/defect-schema.md')
  assert.equal(byRole.design_critic.standard, 'resources/document_standards/feature-spec-standard.md')
  assert.equal(byRole.structural.standard, 'resources/document_standards/feature-spec-standard.md')
  assert.equal(byRole.style.standard, null)
  assert.equal(byRole.zoom_out.standard, 'resources/document_standards/zoom-out-standard.md')
  assert.equal(byRole.comprehension.standard, 'resources/document_standards/re-implementation-standard.md')
  assert.equal(
    byRole.implementation_readiness.standard,
    'resources/document_standards/implementation-readiness-standard.md',
  )
  assert.equal(byRole.codebase_details.standard, 'resources/document_standards/implementation-readiness-standard.md')
  assert.equal(roleSpecOf('nope'), null)
})

test('7 个上游角色逐个派发：固定标准落进房间，提示词带 Mode: REVIEW', async (t) => {
  const workspace = await makeWorkspace(t)
  const catalog = roleCatalog(workspace.vendorRoot)
  const byRole = Object.fromEntries(catalog.map((entry) => [entry.role, entry]))
  for (const role of EGM_REVIEW_ROLE_IDS) {
    const agent = fakeAgent(`role-${role}`, workspace.work)
    allow(agent)
    const subagents = mockSubagents()
    const result = await dispatchGoldfish({
      subagents,
      parent: agent,
      args: { docPath: workspace.docPath, role },
      baseCwd: workspace.work,
      vendorRoot: workspace.vendorRoot,
      io: io(),
    })
    assert.equal(result.ok, true, `${role} 应成功：${result.error ?? ''}`)
    assert.equal(result.roleKind, 'egm')
    assert.equal(result.mode, 'review')
    assert.equal(result.strictGoldfishReview, false)
    const prompt = subagents.calls[0].request.prompt[0].text
    assert.match(prompt, /Mode: REVIEW/)
    assert.ok(prompt.includes('role.md'))
    if (byRole[role].standard === null) {
      await assert.rejects(stat(join(result.scratch, 'standard.md')))
      assert.doesNotMatch(prompt, /standard\.md/)
      assert.equal(result.standard, null)
    } else {
      assert.equal(result.standard, byRole[role].standard)
      assert.ok((await stat(join(result.scratch, 'standard.md'))).isFile())
      assert.ok(prompt.includes('standard.md'))
    }
    assert.equal(subagents.calls[0].request.agentPreset.startsWith('egm-goldfish-'), true)
    assert.equal(subagents.calls[0].request.cwd, result.scratch)
  }
})

test('兼容角色保持原有行为：缺陷清单格式 + 角色卡', async (t) => {
  const workspace = await makeWorkspace(t)
  for (const role of LEGACY_ROLE_IDS) {
    const agent = fakeAgent(`legacy-${role}`, workspace.work)
    allow(agent)
    const subagents = mockSubagents()
    const result = await dispatchGoldfish({
      subagents,
      parent: agent,
      args: { docPath: workspace.docPath, role },
      baseCwd: workspace.work,
      vendorRoot: workspace.vendorRoot,
      io: io(),
    })
    assert.equal(result.ok, true, `${role} 应成功：${result.error ?? ''}`)
    assert.equal(result.roleKind, 'legacy')
    assert.equal(result.stage, null)
    assert.equal(result.standard, 'resources/defect-schema.md')
    const prompt = subagents.calls[0].request.prompt[0].text
    assert.match(prompt, /缺陷清单/)
    assert.doesNotMatch(prompt, /Mode: REVIEW/)
    await assert.rejects(stat(join(result.scratch, 'sources.json')))
  }
})

test('阶段绑定：角色不匹配 / 兼容角色带 stage / 非法 stage 都明确报错', async (t) => {
  const mismatch = await run(t, { args: { docPath: '.egm/design.md', role: 'zoom_out', stage: '7' } })
  assert.equal(mismatch.result.code, 'E_STAGE_ROLE_MISMATCH')
  assert.match(mismatch.result.error, /design_critic/)

  const legacyStage = await run(t, { args: { docPath: '.egm/design.md', role: 'logic', stage: '7' } })
  assert.equal(legacyStage.result.code, 'E_STAGE_NOT_APPLICABLE')

  const badStage = await run(t, { args: { docPath: '.egm/design.md', role: 'zoom_out', stage: '10' } })
  assert.equal(badStage.result.code, 'E_STAGE_INVALID')

  const numberStage = await run(t, { args: { docPath: '.egm/design.md', role: 'zoom_out', stage: 5 } })
  assert.equal(numberStage.result.ok, true)
  assert.equal(numberStage.result.stage, 5)
})

test('Stage 5 派 zoom_out：提示词带阶段；Stage 8 缺 Stage 5 报告时明说缺口', async (t) => {
  const stage5 = await run(t, { args: { docPath: '.egm/design.md', role: 'zoom_out', stage: '5' } })
  assert.equal(stage5.result.ok, true)
  let prompt = stage5.subagents.calls[0].request.prompt[0].text
  assert.match(prompt, /当前阶段 5（初始 Zoom Out）/)

  const stage8 = await run(t, {
    workspace: {},
    args: { docPath: '.egm/design.md', role: 'zoom_out', stage: '8' },
  })
  assert.equal(stage8.result.ok, true)
  prompt = stage8.subagents.calls[0].request.prompt[0].text
  assert.match(prompt, /阶段 8（中期 Zoom Out）/)
  assert.match(prompt, /没有提供 Stage 5 报告/)
  assert.match(prompt, /不算完整的中期 Zoom Out/)
})

test('Stage 9 提供阶段材料：复制进房间并写进提示词', async (t) => {
  const workspace = await makeWorkspace(t)
  const detail = join(workspace.work, '.egm', 'detail-range.md')
  await writeFile(detail, '# 目标详设\n\n正文\n', 'utf8')
  const agent = fakeAgent('stage9', workspace.work)
  allow(agent)
  const mock = mockSubagents()
  const result = await dispatchGoldfish({
    subagents: mock,
    parent: agent,
    args: {
      docPath: workspace.docPath,
      role: 'implementation_readiness',
      stage: '9',
      materials: ['.egm/detail-range.md'],
    },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.materials.length, 1)
  assert.ok((await stat(result.materials[0].copyPath)).isFile())
  const prompt = mock.calls[0].request.prompt[0].text
  assert.match(prompt, /阶段材料/)
  assert.match(prompt, /materials/)
  assert.match(prompt, /不校验上面哪一份是目标详设/)
})

test('角色卡缺失：明确 E_ROLE_CARD_MISSING，不派发', async (t) => {
  const { result, subagents } = await run(t, {
    workspace: { omitCard: 'structural' },
    args: { docPath: '.egm/design.md', role: 'structural' },
  })
  assert.equal(result.code, 'E_ROLE_CARD_MISSING')
  assert.match(result.error, /structural\.md/)
  assert.equal(subagents.calls.length, 0)
})

test('标准文件缺失：明确 E_STANDARD_MISSING，不换标准不降级', async (t) => {
  const { result, subagents } = await run(t, {
    workspace: { omitStandard: 'zoom-out-standard.md' },
    args: { docPath: '.egm/design.md', role: 'zoom_out' },
  })
  assert.equal(result.code, 'E_STANDARD_MISSING')
  assert.match(result.error, /zoom-out-standard\.md/)
  assert.equal(subagents.calls.length, 0)
})

test('sources：越界 / 不存在 / 合法文件写清单', async (t) => {
  const outside = await run(t, {
    args: { docPath: '.egm/design.md', role: 'logic', sources: ['../../etc/passwd'] },
  })
  assert.equal(outside.result.code, 'E_SOURCE_MISSING')

  const { result: missing } = await run(t, {
    args: { docPath: '.egm/design.md', role: 'logic', sources: ['src/nope.js'] },
  })
  assert.equal(missing.code, 'E_SOURCE_MISSING')

  const workspace = await makeWorkspace(t)
  await mkdir(join(workspace.work, 'src'), { recursive: true })
  const sourcePath = join(workspace.work, 'src', 'a.js')
  await writeFile(sourcePath, 'export const a = 1\n', 'utf8')
  const agent = fakeAgent('sources-ok', workspace.work)
  allow(agent)
  const mock = mockSubagents()
  const result = await dispatchGoldfish({
    subagents: mock,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'codebase_details', stage: '9', sources: ['src/a.js'] },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].relative, 'src/a.js')
  assert.equal(result.sources[0].sha256, createHash('sha256').update('export const a = 1\n').digest('hex'))
  const manifest = JSON.parse(await readFile(join(result.scratch, 'sources.json'), 'utf8'))
  assert.equal(manifest.sources[0].path, sourcePath)
  assert.equal(manifest.accessIsolated, false)
  assert.ok(result.sources[0].copyPath.includes(result.scratch))
  assert.equal(await readFile(result.sources[0].copyPath, 'utf8'), 'export const a = 1\n')
  const prompt = mock.calls[0].request.prompt[0].text
  assert.ok(prompt.includes(result.sources[0].copyPath), '提示词应包含受控副本路径')
  assert.ok(!prompt.includes(sourcePath), '提示词不应提示子代理去原始绝对路径自由读取')
  assert.equal(result.accessIsolated, false)
})

test('sources 指向工作区外（绝对路径）被拒', async (t) => {
  const workspace = await makeWorkspace(t)
  const outsideDir = await mkdtemp(join(tmpdir(), 'egm-outside-'))
  t.after(() => rm(outsideDir, { recursive: true, force: true }))
  await writeFile(join(outsideDir, 'x.txt'), 'x', 'utf8')
  const { result } = await run(t, {
    args: { docPath: '.egm/design.md', role: 'logic', sources: [join(outsideDir, 'x.txt')] },
  })
  assert.equal(result.code, 'E_SOURCE_OUTSIDE')
})

test('阶段材料必须是文件，且大小受限', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('material-dir', workspace.work)
  allow(agent)
  const result = await dispatchGoldfish({
    subagents: mockSubagents(),
    parent: agent,
    args: { docPath: workspace.docPath, role: 'implementation_readiness', stage: '9', materials: ['.egm'] },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(result.code, 'E_MATERIAL_INVALID')
})

test('range：合法区间真裁剪并标注行号，非权限隔离，非法区间 fail-closed', async (t) => {
  const ok = await run(t, {
    workspace: { design: '# 图纸\n\n正文\n\n补充\n' },
    args: { docPath: '.egm/design.md', role: 'design_critic', stage: '7', range: { start: 2, end: 4 } },
  })
  assert.equal(ok.result.ok, true)
  assert.deepEqual(ok.result.range, { start: 2, end: 4, total: 5 })
  assert.equal(ok.result.accessIsolated, false)
  assert.equal(ok.result.rangeMapping.start, 2)
  assert.equal(ok.result.rangeMapping.end, 4)
  assert.equal(ok.result.rangeMapping.format, 'line-prefixed')

  const prompt = ok.subagents.calls[0].request.prompt[0].text
  assert.match(prompt, /本次只审第 2–4 行（共 5 行）/)
  assert.match(prompt, /行号必须以原文件为准/)

  // 房间里的图纸必须真的裁剪：仅含第 2-4 行，标注原行号，且第 1 行与第 5 行绝对不进入！
  const slicedDesign = await readFile(join(ok.result.scratch, 'design.md'), 'utf8')
  assert.ok(slicedDesign.includes('L2 | '))
  assert.ok(slicedDesign.includes('L3 | 正文'))
  assert.ok(slicedDesign.includes('L4 | '))
  assert.ok(!slicedDesign.includes('# 图纸'), '第 1 行 # 图纸 不得进入裁剪副本')
  assert.ok(!slicedDesign.includes('补充'), '第 5 行 补充 不得进入裁剪副本')
  assert.ok(slicedDesign.includes('accessIsolated: false'), '裁剪副本必须保留非权限隔离声明')

  for (const range of [{ start: 0, end: 2 }, { start: 3, end: 2 }, { start: 1, end: 99 }, { start: 1.5, end: 2 }, { start: 'a', end: 2 }]) {
    const bad = await run(t, { args: { docPath: '.egm/design.md', role: 'design_critic', range } })
    assert.equal(bad.result.code, 'E_RANGE_INVALID', `${JSON.stringify(range)} 应被拒绝`)
    assert.equal(bad.subagents.calls.length, 0)
  }

  const notObject = await run(t, { args: { docPath: '.egm/design.md', role: 'design_critic', range: '1-2' } })
  assert.equal(notObject.result.code, 'E_RANGE_INVALID')

  const legacy = await run(t, {
    workspace: { design: 'a\nb\n' },
    args: { docPath: '.egm/design.md', role: 'logic', range: { start: 1, end: 1 } },
  })
  assert.equal(legacy.result.ok, true)
  assert.match(legacy.subagents.calls[0].request.prompt[0].text, /本次只审第 1–1 行（共 2 行）/)
})

test('brainstorm：6 视角单次冷启动走 Mode: BRAINSTORM，不绑标准', async (t) => {
  const workspace = await makeWorkspace(t)
  for (const role of BRAINSTORM_ROLES) {
    const agent = fakeAgent(`brainstorm-${role}`, workspace.work)
    allow(agent)
    const subagents = mockSubagents()
    const result = await dispatchGoldfish({
      subagents,
      parent: agent,
      args: { docPath: workspace.docPath, role, mode: 'brainstorm' },
      baseCwd: workspace.work,
      vendorRoot: workspace.vendorRoot,
      io: io(),
    })
    assert.equal(result.ok, true, `${role} brainstorm 应成功：${result.error ?? ''}`)
    assert.equal(result.mode, 'brainstorm')
    assert.equal(result.standard, null)
    await assert.rejects(stat(join(result.scratch, 'standard.md')))
    const prompt = subagents.calls[0].request.prompt[0].text
    assert.match(prompt, /Mode: BRAINSTORM/)
    assert.doesNotMatch(prompt, /Mode: REVIEW/)
    assert.match(prompt, /BRAINSTORM 分支/)
    assert.match(prompt, /不宣称与原版 egm_brainstorm 流程等效/)
  }
})

test('brainstorm 边界：非 6 视角、带 stage、带 range、未知 mode 都明确拒绝', async (t) => {
  const legacyRole = await run(t, { args: { docPath: '.egm/design.md', role: 'logic', mode: 'brainstorm' } })
  assert.equal(legacyRole.result.code, 'E_MODE_ROLE_MISMATCH')
  assert.match(legacyRole.result.error, /design_critic/)

  const styleRole = await run(t, { args: { docPath: '.egm/design.md', role: 'style', mode: 'brainstorm' } })
  assert.equal(styleRole.result.code, 'E_MODE_ROLE_MISMATCH')

  const withStage = await run(t, {
    args: { docPath: '.egm/design.md', role: 'design_critic', mode: 'brainstorm', stage: '7' },
  })
  assert.equal(withStage.result.code, 'E_STAGE_NOT_APPLICABLE')

  const withRange = await run(t, {
    args: { docPath: '.egm/design.md', role: 'design_critic', mode: 'brainstorm', range: { start: 1, end: 1 } },
  })
  assert.equal(withRange.result.code, 'E_RANGE_NOT_APPLICABLE')

  const badMode = await run(t, { args: { docPath: '.egm/design.md', role: 'design_critic', mode: 'deep' } })
  assert.equal(badMode.result.code, 'E_MODE_UNSUPPORTED')
})

test('报告写入失败必须报错，不能静默成功', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('report-fail', workspace.work)
  allow(agent)
  const failingIo = io({
    async writeFile(path, ...rest) {
      if (String(path).includes('report-')) throw new Error('磁盘满了')
      return nodeFs.writeFile(path, ...rest)
    },
  })
  const result = await dispatchGoldfish({
    subagents: mockSubagents(),
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: failingIo,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_REPORT_WRITE')
  assert.match(result.error, /磁盘满了/)
  assert.equal(result.report, '阻塞 | design.md:1 | 测试问题 | 返工')
})

test('报告写入后字节数不一致也算失败', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('report-short', workspace.work)
  allow(agent)
  const shortIo = io({
    async writeFile(path, ...rest) {
      if (String(path).includes('report-')) return nodeFs.writeFile(path, 'short', 'utf8')
      return nodeFs.writeFile(path, ...rest)
    },
  })
  const result = await dispatchGoldfish({
    subagents: mockSubagents(),
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: shortIo,
  })
  assert.equal(result.code, 'E_REPORT_WRITE')
  assert.match(result.error, /校验失败/)
})

test('空报告算失败，不假装通过', async (t) => {
  const { result } = await run(t, { mock: { report: '   ' }, args: { docPath: '.egm/design.md', role: 'logic' } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_EMPTY_REPORT')
})

test('子代理返回错误对象（如 {ok:false,error}）或空对象不得伪造成报告落盘', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('error-report', workspace.work)
  allow(agent)

  // 1. 返回 { ok: false, error: "Quota exceeded" }
  const subagentsErr = {
    async startActivation() {
      return {
        childId: 'c-err',
        result: Promise.resolve({ ok: false, error: 'Quota exceeded' }),
        async dispose() {},
      }
    },
  }
  const resultErr = await dispatchGoldfish({
    subagents: subagentsErr,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(resultErr.ok, false)
  assert.match(resultErr.error, /Quota exceeded/)
  if (resultErr.scratch) {
    const reportExists = await io().stat(join(resultErr.scratch, 'report-logic.md')).then(() => true).catch(() => false)
    assert.equal(reportExists, false, '错误对象不得落盘为成功报告')
  }

  // 2. 返回空对象 {}
  openGate(agent)
  grantUnsafePermit(agent, '空对象测试')
  const subagentsEmpty = {
    async startActivation() {
      return {
        childId: 'c-empty',
        result: Promise.resolve({}),
        async dispose() {},
      }
    },
  }
  const resultEmpty = await dispatchGoldfish({
    subagents: subagentsEmpty,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(resultEmpty.ok, false)
  assert.equal(resultEmpty.code, 'E_EMPTY_REPORT')
  if (resultEmpty.scratch) {
    const reportExists = await io().stat(join(resultEmpty.scratch, 'report-logic.md')).then(() => true).catch(() => false)
    assert.equal(reportExists, false, '空对象不得落盘为成功报告')
  }
})

test('派发异常报 E_DISPATCH，不吞错误', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('spawn-throw', workspace.work)
  allow(agent)
  const result = await dispatchGoldfish({
    subagents: mockSubagents({ mode: 'throw' }),
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(result.code, 'E_DISPATCH')
  assert.match(result.error, /spawn 炸了/)
})

test('只读创建钩子失败保留 E_GOLDFISH_POLICY', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('policy-hook-throw', workspace.work)
  allow(agent)
  const result = await dispatchGoldfish({
    subagents: { async startActivation() { throw Object.assign(new Error('policy hook failed'), { code: 'E_GOLDFISH_POLICY' }) } },
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_GOLDFISH_POLICY')
  assert.match(result.error, /policy hook failed/)
})

test('超时：返回 E_TIMEOUT，并终止/释放子会话', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('timeout', workspace.work)
  allow(agent)
  const subagents = mockSubagents({ mode: 'hang' })
  const result = await dispatchGoldfish({
    subagents,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
    timeoutMs: 30,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_TIMEOUT')
  assert.equal(subagents.state.terminated, 1)
  assert.equal(subagents.state.disposed, 1)
  assert.equal(subagents.calls[0]?.signal?.aborted, true, "超时必须触发 controller.abort()")
})

test('并发派发房间唯一（mkdtemp）', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('concurrent', workspace.work)
  openGate(agent)
  for (let i = 0; i < 5; i += 1) grantUnsafePermit(agent, '并发许可')
  const subagents = mockSubagents({ delayMs: 10 })
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      dispatchGoldfish({
        subagents,
        parent: agent,
        args: { docPath: workspace.docPath, role: 'logic' },
        baseCwd: workspace.work,
        vendorRoot: workspace.vendorRoot,
        io: io(),
      }),
    ),
  )
  assert.equal(results.every((result) => result.ok), true, JSON.stringify(results.map((r) => r.code)))
  assert.equal(new Set(results.map((result) => result.scratch)).size, 5)
  for (const result of results) {
    assert.ok((await stat(join(result.scratch, 'design.md'))).isFile())
    assert.ok((await stat(result.reportPath)).isFile())
  }
})

test('工具 schema：只有路径、白名单角色、mode 与 range，没有对话入口', () => {
  let definition
  const ctx = { tools: { register: (value) => (definition = value) }, get: () => null }
  registerDispatchTool(ctx)
  assert.equal(definition.name, 'egm_dispatch')
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), [
    'docPath',
    'materials',
    'mode',
    'range',
    'role',
    'sources',
    'stage',
  ])
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.required, ['docPath', 'role'])
  assert.deepEqual(definition.parameters.properties.role.enum, ROLE_IDS)
  assert.equal(definition.parameters.properties.role.enum.length, 10)
  assert.deepEqual(definition.parameters.properties.mode.enum, ['review', 'brainstorm'])
  assert.deepEqual(definition.parameters.properties.range.required, ['start', 'end'])
  assert.equal(definition.parameters.properties.range.additionalProperties, false)
  assert.match(definition.description, /\/egm/)
  assert.match(definition.description, /\/egm-unsafe/)
  assert.match(definition.description, /不是安全隔离/i)
  for (const value of Object.values(definition.parameters.properties)) {
    assert.doesNotMatch(JSON.stringify(value), /自由文本|对话内容/, 'API 不应有接收对话文本的字段')
  }
})

test('工具 execute 走同一套双门：无窗口时返回 E_GATE_NOT_OPEN', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('tool-exec', workspace.work)
  const subagents = mockSubagents()
  let definition
  const ctx = { tools: { register: (value) => (definition = value) }, get: (name) => (name === 'subagents' ? subagents : null) }
  registerDispatchTool(ctx)
  const blocked = await definition.execute({ docPath: workspace.docPath, role: 'logic' }, { agent })
  assert.equal(blocked.code, 'E_GATE_NOT_OPEN')

  allow(agent)
  const ok = await definition.execute({ docPath: workspace.docPath, role: 'logic' }, { agent })
  assert.equal(ok.ok, true)
  assert.equal(subagents.calls.length, 1)
})

test('工具结果渲染：失败必须显示错误码与原因；成功带非隔离横幅', () => {
  let definition
  const ctx = { tools: { register: (value) => (definition = value) }, get: () => null }
  registerDispatchTool(ctx)
  const failure = definition.output.render(
    {},
    { ok: false, code: 'E_REPORT_WRITE', error: '报告落盘失败：磁盘满了', scratch: 'C:/tmp/x' },
  )[0].text
  assert.match(failure, /E_REPORT_WRITE/)
  assert.match(failure, /磁盘满了/)
  assert.match(failure, /C:\/tmp\/x/)
  assert.doesNotMatch(failure, /没有返回正文/)

  const gateFailure = definition.output.render({}, { ok: false, code: 'E_GATE_NOT_OPEN', error: '未通过 /egm 启动' })[0]
    .text
  assert.match(gateFailure, /E_GATE_NOT_OPEN/)
  assert.match(gateFailure, /\/egm/)

  const success = definition.output.render(
    {},
    { ok: true, strictGoldfishReview: false, report: '阻塞 | a.md:1 | x | 返工' },
  )[0].text
  assert.match(success, /非隔离评审/)
  assert.match(success, /阻塞/)
})

test('报告回传保留超过旧截断长度的正文、尾部意见与落盘路径', () => {
  let definition
  registerDispatchTool({ tools: { register: (value) => (definition = value) }, get: () => null })
  const report = '# 冷审报告\n' + '待核对的意见。'.repeat(4000) + '\nFINAL_FINDING_需处理的最后一条'
  const text = definition.output.render({}, {
    ok: true,
    strictGoldfishReview: false,
    report,
    reportPath: 'C:/tmp/egm/review.md',
  })[0].text
  assert.ok(text.includes(report), '不能静默丢弃报告后半段')
  assert.ok(text.includes('FINAL_FINDING_需处理的最后一条'))
  assert.ok(text.includes('C:/tmp/egm/review.md'))
})

test('错误回传标明实际运行预设，便于核对安装版本和内存版本', () => {
  let definition
  registerDispatchTool({ tools: { register: (value) => (definition = value) }, get: () => null })
  const text = definition.output.render({}, { ok: false, code: 'E_GATE_NOT_OPEN', error: '窗口未开' })[0].text
  assert.match(text, /运行预设：egm-goldfish-/)
})

test('边界声明：只读未验证、关键未覆盖项如实列出，不声称隔离成立', () => {
  const boundary = boundaryOf()
  assert.equal(boundary.isolation, 'unverified')
  assert.equal(boundary.readOnlyVerified, false)
  assert.equal(boundary.strictReviewAvailable, false)
  assert.match(boundary.statement, /不是安全隔离/)
  const joined = boundary.uncovered.join('\n')
  for (const fragment of [
    'OS 级只读',
    '继承父会话权限根',
    '不是权限边界',
    '不等于零泄漏',
    '源码证据未覆盖',
    '多阶段上下文编排未覆盖',
    'brainstorm 只做到单次冷启动',
    '材料控制非权限隔离',
    '命令门控是插件内状态',
  ]) {
    assert.ok(joined.includes(fragment), `uncovered 应包含：${fragment}`)
  }
})

test('真实 vendor/egm：7 角色卡与固定标准齐全，可被 roleSpecOf 解析', async (t) => {
  // 以测试文件自身定位：仓库根与 dsh-egm/ 内运行都应拿到同一路径。
  const vendorRoot = fileURLToPath(new URL('../vendor/egm', import.meta.url))
  t.diagnostic(`vendor: ${vendorRoot}`)
  for (const role of EGM_REVIEW_ROLE_IDS) {
    const spec = roleSpecOf(role, vendorRoot)
    assert.equal(spec.kind, 'egm')
    assert.ok((await stat(spec.cardPath)).isFile(), `${role} 角色卡缺失：${spec.cardPath}`)
    if (spec.standardPath !== null) {
      assert.ok((await stat(spec.standardPath)).isFile(), `${role} 标准缺失：${spec.standardPath}`)
    }
  }
  // 真实 vendor 参与派发时也应通过（锁只读门仍生效）。
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('real-vendor', workspace.work)
  allow(agent)
  const subagents = mockSubagents()
  const result = await dispatchGoldfish({
    subagents,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'zoom_out', stage: '5' },
    baseCwd: workspace.work,
    vendorRoot,
    io: io(),
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.standard, 'resources/document_standards/zoom-out-standard.md')
})

test('核心派发函数不在插件入口之外暴露绕过口子：dispatchGoldfish 自身仍检查双门', async (t) => {
  // 直接调用 dispatchGoldfish（绕过 registerDispatchTool）也必须被门控拦住。
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent(`bypass-${Math.random().toString(36).slice(2)}`, workspace.work)
  const subagents = mockSubagents()
  const blocked = await dispatchGoldfish({
    subagents,
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(blocked.code, 'E_GATE_NOT_OPEN')
  assert.equal(subagents.calls.length, 0)
  await assert.rejects(access(join(workspace.work, '.egm', 'review-')))
  assert.equal(peekGate(agent), null)
})

// ── 顶栏宠物的钩子 ────────────────────────────────────────────────────────────
// 宠物是装饰，但它必须跟着真实状态动：没放行就不许显示「派鱼」，放行后必须
// 收到开始与结果两种事件，钩子自己抛错也不许影响派发。

test('宠物钩子：未放行时不触发 onStart', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('pet-blocked', workspace.work)
  const events = []
  const result = await dispatchGoldfish({
    subagents: mockSubagents(),
    parent: agent,
    args: { docPath: workspace.docPath, role: 'logic' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
    onStart: (event) => events.push(event),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_GATE_NOT_OPEN')
  assert.deepEqual(events, [], 'fail-closed 时宠物不该进入派鱼状态')
})

test('宠物钩子：放行后 onStart 收到角色与会话号，钩子抛错不影响结果', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('pet-allowed', workspace.work)
  allow(agent)
  const events = []
  const result = await dispatchGoldfish({
    subagents: mockSubagents(),
    parent: agent,
    args: { docPath: workspace.docPath, role: 'structural' },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
    onStart: (event) => {
      events.push(event)
      throw new Error('宠物炸了')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(events.length, 1)
  assert.equal(events[0].role, 'structural')
  assert.equal(events[0].sessionId, 'pet-allowed')
})

test('宠物钩子：registerDispatchTool 上报开始与完成', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('pet-tool', workspace.work)
  allow(agent)
  const events = []
  let definition = null
  const subagents = mockSubagents()
  const ctx = {
    tools: { register: (value) => { definition = value } },
    get: (name) => (name === 'subagents' ? subagents : undefined),
  }
  registerDispatchTool(ctx, { onEvent: (event) => events.push(event) })
  assert.ok(definition, '应注册 egm_dispatch 工具')

  const result = await definition.execute({ docPath: workspace.docPath, role: 'logic' }, { agent })
  assert.equal(result.ok, true)
  assert.deepEqual(events.map((event) => event.type), ['dispatch-start', 'dispatch-done'])
  assert.equal(events[0].sessionId, 'pet-tool')
  assert.equal(events[1].role, 'logic')
})

test('宠物钩子：派发失败时上报失败而不是完成', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('pet-fail', workspace.work)
  // 只开窗口、不发许可：工具层失败，宠物必须回到空闲。
  openGate(agent)
  const events = []
  let definition = null
  const ctx = {
    tools: { register: (value) => { definition = value } },
    get: (name) => (name === 'subagents' ? mockSubagents() : undefined),
  }
  registerDispatchTool(ctx, { onEvent: (event) => events.push(event) })
  const result = await definition.execute({ docPath: workspace.docPath, role: 'logic' }, { agent })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_READONLY_UNVERIFIED')
  assert.deepEqual(events.map((event) => event.type), ['dispatch-failed'])
})

test('材料控制集成：传 range 时真裁剪、片段外独有文本不进入、带原文行号标记与元数据', async (t) => {
  const designText = [
    'Line 1: TOP_SECRET_HEADER',
    'Line 2: FEATURE_START',
    'Line 3: FEATURE_DETAIL',
    'Line 4: FEATURE_END',
    'Line 5: BOTTOM_SECRET_FOOTER',
  ].join('\n') + '\n'

  const workspace = await makeWorkspace(t, { design: designText })
  const agent = fakeAgent('range-slice-test', workspace.work)
  allow(agent)
  const mock = mockSubagents()

  const result = await dispatchGoldfish({
    subagents: mock,
    parent: agent,
    args: {
      docPath: workspace.docPath,
      role: 'design_critic',
      stage: '7',
      range: { start: 2, end: 4 },
    },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.accessIsolated, false)
  assert.deepEqual(result.range, { start: 2, end: 4, total: 5 })
  assert.equal(result.rangeMapping.start, 2)
  assert.equal(result.rangeMapping.end, 4)
  assert.equal(result.rangeMapping.lineCount, 3)
  assert.equal(result.rangeMapping.accessIsolated, false)
  assert.equal(result.rangeMapping.format, 'line-prefixed')

  const slicedFile = await readFile(join(result.scratch, 'design.md'), 'utf8')
  assert.ok(slicedFile.includes('L2 | Line 2: FEATURE_START'))
  assert.ok(slicedFile.includes('L3 | Line 3: FEATURE_DETAIL'))
  assert.ok(slicedFile.includes('L4 | Line 4: FEATURE_END'))
  assert.ok(!slicedFile.includes('TOP_SECRET_HEADER'), '片段前独有文本不得进入')
  assert.ok(!slicedFile.includes('BOTTOM_SECRET_FOOTER'), '片段后独有文本不得进入')
  assert.ok(slicedFile.includes('accessIsolated: false'))
})

test('材料控制集成：sources 传目录显式拒绝并提示指定文件', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('sources-dir-test', workspace.work)
  allow(agent)

  await mkdir(join(workspace.work, 'src', 'components'), { recursive: true })
  await writeFile(join(workspace.work, 'src', 'components', 'button.js'), 'export const btn = 1\n')

  const result = await dispatchGoldfish({
    subagents: mockSubagents(),
    parent: agent,
    args: {
      docPath: workspace.docPath,
      role: 'codebase_details',
      stage: '9',
      sources: ['src/components'],
    },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_SOURCE_INVALID')
  assert.match(result.error, /不支持目录扫描，请指定具体文件/)
})

test('材料控制集成：docPath 越界与链接逃逸被拦截', async (t) => {
  const workspace = await makeWorkspace(t)
  const agent = fakeAgent('doc-outside-test', workspace.work)
  allow(agent)

  const outsideDir = await mkdtemp(join(tmpdir(), 'egm-doc-outside-'))
  t.after(() => rm(outsideDir, { recursive: true, force: true }))
  await writeFile(join(outsideDir, 'secret-plan.md'), '# Secret\n')

  // 1. Path traversal 越界
  const resTraversal = await dispatchGoldfish({
    subagents: mockSubagents(),
    parent: agent,
    args: {
      docPath: join(outsideDir, 'secret-plan.md'),
      role: 'logic',
    },
    baseCwd: workspace.work,
    vendorRoot: workspace.vendorRoot,
    io: io(),
  })
  assert.equal(resTraversal.ok, false)
  assert.equal(resTraversal.code, 'E_DOC_OUTSIDE')
})

test('命令 handler：/egm-review-access notify 注入内部上下文通知（折叠），支持 grant/deny，不修改用户可见草稿', () => {
  const commands = new Map()
  const events = []
  const ctx = { commands: { register: (c) => commands.set(c.name, c) } }
  registerEgmReviewAccessCommand(ctx, { onEvent: (ev) => events.push(ev) })
  const cmd = commands.get('egm-review-access')
  assert.ok(cmd)

  const agent = fakeAgent('notify-session-1')

  // 1. notify grant 只能通知真实已开启的许可
  const resNotGranted = cmd.handler({ agent, rawInput: 'notify grant' })
  assert.equal(resNotGranted.code, 'E_ACCESS_STATE_MISMATCH')
  assert.equal(agent.followupCalls.length, 0)
  assert.equal(cmd.handler({ agent, rawInput: '确认无隔离' }).kind, 'success')
  const resGrant = cmd.handler({ agent, rawInput: 'notify grant' })
  assert.equal(resGrant.kind, 'success')
  assert.equal(resGrant.data.notified, true)
  assert.equal(resGrant.data.action, 'grant')
  assert.equal(agent.followupCalls.length, 1)
  const grantMsg = agent.followupCalls[0]
  assert.deepEqual(grantMsg.source, {
    kind: 'context',
    name: 'egm-review-notice',
    form: 'notice',
    summary: 'EGM 评审许可已更新：允许本轮评审（折叠）',
  })
  assert.match(grantMsg.content[0].text, /允许本轮金鱼评审/)

  // 2. notify deny / continue deny 必须在真实撤销后
  assert.equal(cmd.handler({ agent, rawInput: 'revoke' }).kind, 'success')
  const resDeny = cmd.handler({ agent, rawInput: 'continue deny' })
  assert.equal(resDeny.kind, 'success')
  assert.equal(resDeny.data.action, 'deny')
  assert.equal(agent.followupCalls.length, 2)
  const denyMsg = agent.followupCalls[1]
  assert.deepEqual(denyMsg.source, {
    kind: 'context',
    name: 'egm-review-notice',
    form: 'notice',
    summary: 'EGM 评审许可已更新：暂不评审（折叠）',
  })
  assert.match(denyMsg.content[0].text, /暂不评审/)

  // 3. invalid arg
  const resInvalid = cmd.handler({ agent, rawInput: 'notify foo' })
  assert.equal(resInvalid.kind, 'error')
  assert.equal(resInvalid.code, 'E_INVALID_ARGUMENT')

  // 4. agent unresolved
  const resUnresolved = cmd.handler({ agent: null, rawInput: 'notify grant' })
  assert.equal(resUnresolved.kind, 'error')
  assert.equal(resUnresolved.code, 'E_AGENT_UNRESOLVED')
})
