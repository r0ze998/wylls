// Whether the autopilot may decide through a given MCP server now, checked before start and resume, BEFORE any model
// call. Passing it never replaces the relay's own checks at the real act (authentication, policy, mode, budget, delegation):
// those run again, every time, inside AgentGateway.submit.
//
// The token itself can be checked three ways, in this order:
//   1. `agent_whoami`, a read-only authenticated MCP tool (proposed shared change, patches/0004; NOT in the relay today)
//   2. the GATE-REFUSAL PROBE — QUARANTINED, opt-in, see below
//   3. neither → TokenUnverifiable: the autopilot does not start or resume
//
// THE PROBE (a workaround while no authenticated read exists): an agent_act that the relay authenticates and then must
// refuse at its gate. Its guarantee rests on the relay code as read at the trees in VERIFIED_RELAY_TREES, not on "far-off
// numbers" alone:
//   - order (gateway.mjs submit): parse → authenticate (BadCapability) → idempotency lookup → #run → #gate, and #gate runs
//     before any hold, build or send
//   - #gate: mode → policy version (strict equality) → mode epoch (strict equality) → checkAllowed → village
//   - checkAllowed refuses every NEVER_DELEGATED action unconditionally (a code constant); the probe names SetSession
//   - accepted ranges (parseActionRequest): policyVersion a positive integer, modeEpoch a non-negative integer, no upper
//     bound; the probe sends Number.MAX_SAFE_INTEGER for both. Policy versions only grow by 1 per owner update
//     (ledger.mjs), so a concurrent update cannot make them equal either.
// On a relay whose code tree is not in the list, none of this is known: the probe is not sent (TokenUnverifiable).
//
// SIDE EFFECTS — not zero: every probe leaves one idempotency record (`ledger.requests`, at most REQUESTS_MAX = 2,000 per
// agent; the oldest are evicted). Repeated probes would push real requests' records out and break their idempotent
// replay, so probes are capped per day (PROBE_LIMIT) and refused beyond it (ProbeLimit). No hold, no send, no history
// entry, no charge (tested at the verified trees).
import { randomBytes } from 'node:crypto';
import { tool } from '../../src/participate.mjs';

/**
 * permutation-gateway trees (the whole subtree, `git rev-parse <commit>:permutation-gateway`) whose submit/gate/
 * checkAllowed order was read and tested for the probe. An entry attests the probe's preconditions at that exact tree;
 * it does not enable the probe (that stays the operator's opt-in, `probe.enabled`), and a relay serving agent_whoami is
 * checked by that read instead. Review evidence for each entry: RELAY-TREE-ATTESTATION-10.ja.md.
 */
export const VERIFIED_RELAY_TREES = Object.freeze({
  '560f8659fdc091d6870c35539333acf59381acf8': 'base (4cd901de = ba3c180b = ④ 2e536b6b = ③ acdcd0bf)',
  '98f52eb2bfdf153e4c2c0761e6a4387a28bbef3e': 'base + ③ 0005 + ⑤ 0002b + 0001 + 0003 (the integration candidate)',
  '477c5685ad2390c2b8a627936187f8f546423a0e': '④ 6984acfa + ⑤ 0002c, 0003, 0004b, 0005, 0006, 0007 (⑤ hand-off e29ec011); order re-read with the lane and the credential re-check',
  '52ccd7fc13daba4d2e4af111a65b644b4f0e8ae2': '④ integration candidate 7535a17e: src/ identical to 477c5685; the agent wallet\'s ABI entries (17 names, profiles 1 and 3) identical; other changes are screens and tests',
});
export const PROBE_LIMIT = Object.freeze({ perDay: 3 });
const PROBE_ACTION = 'SetSession'; // NEVER_DELEGATED: refused by checkAllowed whatever the policy says
/** Answer codes that can only come after authentication and before any hold (gate refusals). */
const GATE_CODES = new Set(['StalePolicy']);

export class ProbeBudget {
  constructor({ perDay = PROBE_LIMIT.perDay, now = () => Date.now() } = {}) { Object.assign(this, { perDay, now, days: new Map() }); }
  take() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    const n = this.days.get(d) ?? 0;
    if (n >= this.perDay) return false;
    this.days.set(d, n + 1);
    return true;
  }
}

/**
 * @param {object} mcp
 * @param {object} o
 * @param {object} o.mandate
 * @param {string|null} [o.owner]       the owner this autopilot works for (fixed at the first start)
 * @param {object|null} [o.probe]       {enabled: true, relayTree, budget: ProbeBudget, key?: () => requestId} — opt-in
 */
/**
 * @param {string} [o.sender]  the sender this autopilot acts as ('ai'). With per-sender tokens (shared patch 0005, ④
 *                             AUTH-ROUTES A1), agent_whoami says whose token it is: another sender's (③'s 'mcp') is
 *                             refused here, before any model call — it would be BadCapability at the first act.
 */
export async function checkAccess(mcp, { mandate, owner = null, probe = null, sender = 'ai' }) {
  const fail = (code, detail, extra = {}) => ({ ok: false, code, detail, ...extra });
  const v = (await tool(mcp, 'agent_view')).structuredContent;
  if (!v || v.error) return fail('ViewFailed', v?.error?.code ?? 'agent_view did not answer');
  if (mandate.agentId && v.agentId !== mandate.agentId) return fail('WrongAgent', 'the server reads another agent than the mandate\'s');
  if (owner && v.owner !== owner) return fail('WrongOwner', 'the agent belongs to another owner than the one this autopilot works for');
  if (v.mode !== 'auto') return fail('NotAuto', 'the owner has not switched the agent on (relay mode is not auto)');
  if (v.delegation?.delegated !== true) return fail('NotDelegated', 'the agent\'s key is not the Citizen\'s session: the owner delegates it with their wallet; the autopilot never does');
  const missing = (mandate.allowed ?? []).filter(n => !(v.policy?.allowed ?? []).includes(n));
  if (missing.length) return fail('ScopeNarrowed', `the relay policy no longer allows ${missing.join(', ')}`);
  const base = { owner: v.owner, agentId: v.agentId, policyVersion: v.policy.version };

  // 1. A read-only authenticated tool, where the server has one (patch 0004).
  if (Array.isArray(mcp.tools) && mcp.tools.includes('agent_whoami')) {
    const w = (await tool(mcp, 'agent_whoami')).structuredContent;
    if (w?.error?.code === 'BadCapability') return fail('BadCapability', 'the relay does not take this token for this agent');
    if (!w || w.error || w.agentId !== v.agentId || w.owner !== v.owner) return fail('TokenUnverifiable', `agent_whoami answered ${w?.error?.code ?? 'another agent or owner'}`);
    const src = w.capabilitySource ?? null;
    if (src !== null && src !== 'any' && src !== sender) return fail('OtherSendersToken', `this token is the ${src} sender's; this autopilot acts as ${sender}`);
    return { ok: true, ...base, method: 'agent_whoami (read-only)', sideEffects: 'none', tokenSource: src ?? 'not reported (relay without per-sender tokens)' };
  }

  // 2. The quarantined probe, only where its guarantee was established.
  if (!probe?.enabled) return fail('TokenUnverifiable', 'no read-only authenticated check on this relay, and the gate-refusal probe is not enabled');
  if (!Object.hasOwn(VERIFIED_RELAY_TREES, probe.relayTree ?? '')) return fail('TokenUnverifiable', `relay tree ${probe.relayTree ?? 'unknown'} is not one whose gate order was verified: the probe could not be shown never to send`);
  if (!probe.budget?.take()) return fail('ProbeLimit', `at most ${probe.budget?.perDay ?? PROBE_LIMIT.perDay} probes a day: each leaves an idempotency record (the relay keeps 2,000 and evicts the oldest)`);
  const requestId = probe.key ? probe.key() : `p05.probe.${randomBytes(12).toString('hex')}`;
  const a = await tool(mcp, 'agent_act', { requestId, policyVersion: Number.MAX_SAFE_INTEGER, modeEpoch: Number.MAX_SAFE_INTEGER, action: { name: PROBE_ACTION, fields: {} }, reason: 'access check: must be refused at the gate' });
  const sc = a.structuredContent ?? {};
  const code = sc.error?.code ?? null;
  if (code === 'BadCapability') return fail('BadCapability', 'the relay does not take this token for this agent', { probe: { requestId } });
  // Anything that is not a gate refusal — including a "sent" or a replayed earlier answer — is not taken as proof.
  if (sc.ok === true || sc.status === 'sent') return fail('ProbeUnsafe', 'the probe was not refused: stop and report (the relay code is not what was verified)', { probe: { requestId } });
  if (!GATE_CODES.has(code)) return fail('TokenUnverifiable', `the probe answered ${code ?? 'without a code'}`, { probe: { requestId } });
  return { ok: true, ...base, method: `gate-refusal probe (quarantined; relay tree ${probe.relayTree.slice(0, 8)})`, sideEffects: 'one idempotency record', probe: { requestId, replayed: sc.replayed === true } };
}
