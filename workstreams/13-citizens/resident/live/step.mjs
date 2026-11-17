// One step of the operator resident in the REAL world, up to a proposal (2026-11-17). Not the test world's Resident
// (resident.mjs is unchanged and keeps its test-world path); this is the live path beside it.
//
//   stopped (halt, owner stop, revoked)  stop-A: no new operation. Only the results of what was already submitted are
//                                        read (execution.status of the keys given); nothing is submitted, cancelled,
//                                        posted or signed; an unreadable result stays unreadable (Unqueryable), never
//                                        an answer.
//   otherwise                            observe (observe.mjs) → candidates (candidates.mjs) → decide (decide.mjs) →
//                                        for a send, plan it (workstream 1's planSend: chain reads only) → a proposal.
// Enacting a proposal (signing a board record, signing and submitting a caravan, joining) is NOT done by this step:
// every proposal says `enacted: false` with why, whatever authority is supplied. (2026-11-17) A proposal's result also
// carries `context`, the observation it was made from (a deep frozen copy), for the separate, explicit respond entry
// (enact-step.mjs); this step never calls it. The authorities a proposal
// would need are named, and a missing one is named as missing.
import { liveCandidates, planLiveSend } from './candidates.mjs';
import { decideLive } from './decide.mjs';

export const ENACT_NOT_CONNECTED = 'enacting is not connected in this build: nothing is signed, posted, submitted or joined';
export const CONTEXT_KIND = 'ws13-live-step-context/1';

/** A deep, frozen copy (plain JSON values only); throws on anything else, so nothing is shared or changed later. */
function frozenCopy(v) {
  const c = JSON.parse(JSON.stringify(v, (k, x) => { if (typeof x === 'bigint' || typeof x === 'function' || typeof x === 'symbol') throw new TypeError(`not plain data at ${k}`); return x; }));
  const f = o => { if (o && typeof o === 'object') { for (const x of Object.values(o)) f(x); Object.freeze(o); } return o; };
  return f(c);
}

/**
 * (2026-11-17) The observation a proposal was made from, as this step used it: the wallet it observed for, the board
 * its requests came from, the world, Season and clock, and the requests, a deep frozen copy (later changes of the
 * observation or of the proposal object change nothing here), with the proposal it belongs to. It is what an explicit
 * enacting entry (enact-step.mjs) passes on, so nothing is observed again for it. → context | {unavailable: why}
 */
function contextOf(obs, wallet, cand) {
  try {
    return frozenCopy({ kind: CONTEXT_KIND, wallet, requestsFrom: obs.requestsFrom ?? null, world: obs.world, season: obs.season, clock: obs.clock, requests: obs.requests,
      forProposal: { candidate: cand.id, kind: cand.kind, request: cand.request ?? null, offer: cand.offer ?? null } });
  } catch (e) { return Object.freeze({ unavailable: `the observation could not be kept as plain data: ${String(e?.message ?? e).slice(0, 80)}` }); }
}

/** stop-A: read the results of keys already submitted. execution.status(key) only. */
export async function confirmSubmitted(execution, keys = []) {
  if (!execution || typeof execution.status !== 'function') return { read: [], why: 'no execution port to read results from' };
  const read = [];
  for (const key of keys) {
    try { read.push({ key, result: await execution.status(key) }); }
    catch (e) { read.push({ key, unqueryable: e?.code === 'Unqueryable', why: String(e?.message ?? e).slice(0, 120) }); }
  }
  return { read };
}

/**
 * `ports` = {observe() → live observation, execution (ws04-acts port: status only is used here)}
 * `stop` = null | {why}: the owner's or operator's stop, decided by the caller (the resident's own halt file,
 *          mode and revocation rules are resident.mjs #stopReason's; this step takes their answer).
 * `authority` = what the owner supplied ({boardSign?, sendSign?}); only named here, never used.
 */
export async function liveStep({ wallet, ports, deps = {}, provider = null, allow = {}, stop = null, submittedKeys = [], authority = {} }) {
  if (stop) return { stopped: stop.why ?? 'stopped', newOperations: 0, confirmed: await confirmSubmitted(ports.execution, submittedKeys) };
  const obs = await ports.observe();
  // (2026-11-17) deps may be made for this observation (factory.mjs: the planner's Season is the one observed)
  if (typeof deps === 'function') deps = deps(obs) ?? {};
  const c = liveCandidates(obs, { wallet, deps });
  const d = decideLive({ candidates: c.candidates, obs }, provider, { allow });
  const base = { world: obs.world, bell: obs.bell, bellBasis: obs.bellBasis, candidates: c.candidates, unsupported: Object.keys(c.unsupported), why: c.why, unknown: obs.unknown, held: obs.held, decision: d };
  if (d.choice === 'wait') return { ...base, proposal: null };
  const cand = c.candidates.find(x => x.id === d.choice);
  const q = obs.requests.find(x => x.id === cand.request);
  const missing = cand.needs.filter(n => !(n === 'board-sign' ? authority.boardSign : n === 'send-sign' ? authority.sendSign : false));
  const proposal = { candidate: cand, needs: cand.needs, missingAuthority: missing, enacted: false, why: ENACT_NOT_CONNECTED };
  // (2026-11-17) the observation this proposal was made from, kept with the step's result (not enacted here)
  const context = contextOf(obs, wallet, cand);
  if (cand.kind === 'send') {
    proposal.plan = await planLiveSend(cand, q, { wallet, deps });
    // (2026-11-17) a plan that did not come (no planner, another or changed world, the chain refused): held, with why
    if (!proposal.plan?.ok) proposal.held = [`${proposal.plan?.code ?? 'NoPlan'}: ${proposal.plan?.why ?? ''}`];
  }
  // the fields of workstream 1's respond record this step can fill; the rest belong to the signer at enacting
  // (coop-ui.mjs 'accept' adds `nation`, signRecord adds v, season and at). Unsigned, not posted.
  if (cand.kind === 'respond') { proposal.record = { kind: 'respond', request: q.id, answer: 'accept', offer: { ...cand.offer } }; proposal.recordMissing = ['nation (declared by the signer)', 'v, season, at (added when signed)']; }
  return { ...base, proposal, context };
}
