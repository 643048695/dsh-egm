// File-effect policy for goldfish sessions. This does not sandbox network or MCP.
// DSH 0.2.1-rc.3 awaits agent/created before publishing the first inbox prompt.
// The sandbox/mode event is an internal host contract: fail closed if unavailable.
import { GOLDFISH_ID } from './goldfish.js'

const proofs = new WeakMap()

function policyError(message) {
  return Object.assign(new Error(`EGM goldfish read-only policy: ${message}`), { code: 'E_GOLDFISH_POLICY' })
}

export function goldfishPolicyProof(session) {
  return proofs.get(session) ?? null
}

/** Called by the awaited host creation hook, before a goldfish's first prompt. */
export async function protectGoldfishCreated(ctx, event, presetId = GOLDFISH_ID) {
  const agent = event?.agent
  const session = agent?.session
  if (session?.header?.origin !== 'subagent' || session.header.agentPreset !== presetId) return null

  const sandboxPolicy = agent.ctx?.get?.('sandboxPolicy') ?? ctx.get?.('sandboxPolicy')
  if (typeof session.append !== 'function' || typeof sandboxPolicy?.overrideOf !== 'function' || typeof sandboxPolicy?.resolve !== 'function') {
    throw policyError('host session policy API is unavailable; the child must not start')
  }

  // Only this child log is mutated. Never switch the parent's policy to spawn.
  const policyEvent = await session.append('sandbox/mode', { mode: 'read-only', source: 'egm-goldfish' })
  const override = sandboxPolicy.overrideOf(session)
  const resolved = sandboxPolicy.resolve({ session })
  if (override !== 'read-only' || resolved?.mode !== 'read-only') {
    throw policyError('the logged override did not resolve to read-only; the child must not start')
  }

  const proof = Object.freeze({
    sessionId: session.header.id,
    agentPreset: presetId,
    sandboxMode: 'read-only',
    source: 'egm-goldfish',
    eventSeq: Number.isInteger(policyEvent?.seq) ? policyEvent.seq : null,
    verifiedAt: new Date().toISOString(),
    scope: 'sandbox-policy-aware file effects only',
  })
  proofs.set(session, proof)
  return proof
}

/** Keep this listener in the plugin's profile scope so it sees its child agents. */
export function registerGoldfishPolicy(ctx) {
  if (typeof ctx.on !== 'function') throw policyError('awaited agent/created hook is unavailable')
  return ctx.on('agent/created', (event) => protectGoldfishCreated(ctx, event))
}
