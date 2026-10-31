import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GOLDFISH_ID } from '../lib/goldfish.js'
import { protectGoldfishCreated, registerGoldfishPolicy, goldfishPolicyProof } from '../lib/goldfish-policy.js'

function fixture({ origin = 'subagent', preset = GOLDFISH_ID, effective = 'read-only' } = {}) {
  const events = [{ type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } }]
  const session = {
    header: { id: 'child-policy-test', origin, agentPreset: preset },
    append(type, data) { events.push({ type, data }); return { type, data, seq: events.length } },
  }
  const policy = {
    overrideOf(target) { assert.equal(target, session); return events.at(-1).data.mode },
    resolve({ session: target }) { assert.equal(target, session); return { mode: effective } },
  }
  const ctx = { get: (name) => name === 'sandboxPolicy' ? policy : undefined }
  return { events, session, ctx, event: { agent: { session, ctx }, source: 'created' } }
}

test('only the matching goldfish subagent receives a policy event', async () => {
  for (const options of [{ origin: 'user' }, { preset: 'another-preset' }]) {
    const f = fixture(options)
    assert.equal(await protectGoldfishCreated(f.ctx, f.event), null)
    assert.equal(f.events.length, 1)
    assert.equal(goldfishPolicyProof(f.session), null)
  }
})

test('child override wins inherited full access and resolves before hook completes', async () => {
  const f = fixture()
  const proof = await protectGoldfishCreated(f.ctx, f.event)
  assert.deepEqual(f.events.at(-1), { type: 'sandbox/mode', data: { mode: 'read-only', source: 'egm-goldfish' } })
  assert.equal(proof.sandboxMode, 'read-only')
  assert.equal(proof.sessionId, f.session.header.id)
  assert.equal(proof.eventSeq, 2)
  assert.equal(goldfishPolicyProof(f.session), proof)
  assert.ok(Object.isFrozen(proof))
})

test('missing host policy API rejects creation without a false proof', async () => {
  const f = fixture()
  f.event.agent.ctx = { get: () => undefined }
  await assert.rejects(protectGoldfishCreated({}, f.event), { code: 'E_GOLDFISH_POLICY' })
  assert.equal(f.events.length, 1)
  assert.equal(goldfishPolicyProof(f.session), null)
})

test('an unresolved policy rejects creation instead of relying on the prompt', async () => {
  const f = fixture({ effective: 'danger-full-access' })
  await assert.rejects(protectGoldfishCreated(f.ctx, f.event), { code: 'E_GOLDFISH_POLICY' })
  assert.equal(goldfishPolicyProof(f.session), null)
})

test('append failure rejects the awaited creation hook', async () => {
  const f = fixture()
  f.session.append = () => { throw new Error('log unavailable') }
  await assert.rejects(protectGoldfishCreated(f.ctx, f.event), /log unavailable/)
  assert.equal(goldfishPolicyProof(f.session), null)
})

test('hook awaits append before checking the effective policy', async () => {
  const f = fixture()
  f.session.append = async (type, data) => { await Promise.resolve(); f.events.push({ type, data }) }
  const result = await protectGoldfishCreated(f.ctx, f.event)
  assert.equal(result.sandboxMode, 'read-only')
  assert.equal(f.events.length, 2)
})

test('plugin registers one creation listener and returns its disposer', () => {
  const f = fixture()
  const dispose = () => {}
  let listener
  const result = registerGoldfishPolicy({ ...f.ctx, on(name, callback) { assert.equal(name, 'agent/created'); listener = callback; return dispose } })
  assert.equal(typeof listener, 'function')
  assert.equal(result, dispose)
})

test('missing creation hook is a plugin loading failure', () => {
  assert.throws(() => registerGoldfishPolicy({}), { code: 'E_GOLDFISH_POLICY' })
})
