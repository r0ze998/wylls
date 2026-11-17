// One step of the operator resident in the REAL world, up to a proposal (2026-11-17). Not the test world's Resident
// (resident.mjs is unchanged and keeps its test-world path); this is the live path beside it.
//
//   stopped (halt, owner stop, revoked)  stop-A: no new operation. Only the results of what was already submitted are
//                                        read (execution.status of the keys given); nothing is submitted, cancelled,
//                                        posted or signed; an unreadable result stays unreadable (Unqueryable), never
//                                        an answer.
//   otherwise                            observe (observe.mjs) → candidates (candidates.mjs) → decide (decide.mjs) →
//                                        for a send, plan it (workstream 1's planSend: chain reads only) → a proposal.
// Enacting a proposal (signing a board record, signing and submitting a caravan, joining) is NOT connected in this
// build: every proposal says `enacted: false` with why, whatever authority is supplied. The authorities a proposal
// would need are named, and a missing one is named as missing.
import { liveCandidates, planLiveSend } from './candidates.mjs';
import { decideLive } from './decide.mjs';

export const ENACT_NOT_CONNECTED = 'enacting is not connected in this build: nothing is signed, posted, submitted or joined';

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
  const c = liveCandidates(obs, { wallet, deps });
  const d = decideLive({ candidates: c.candidates, obs }, provider, { allow });
  const base = { world: obs.world, bell: obs.bell, bellBasis: obs.bellBasis, candidates: c.candidates, unsupported: Object.keys(c.unsupported), why: c.why, unknown: obs.unknown, held: obs.held, decision: d };
  if (d.choice === 'wait') return { ...base, proposal: null };
  const cand = c.candidates.find(x => x.id === d.choice);
  const q = obs.requests.find(x => x.id === cand.request);
  const missing = cand.needs.filter(n => !(n === 'board-sign' ? authority.boardSign : n === 'send-sign' ? authority.sendSign : false));
  const proposal = { candidate: cand, needs: cand.needs, missingAuthority: missing, enacted: false, why: ENACT_NOT_CONNECTED };
  if (cand.kind === 'send') proposal.plan = await planLiveSend(cand, q, { wallet, deps });
  // the fields of workstream 1's respond record this step can fill; the rest belong to the signer at enacting
  // (coop-ui.mjs 'accept' adds `nation`, signRecord adds v, season and at). Unsigned, not posted.
  if (cand.kind === 'respond') { proposal.record = { kind: 'respond', request: q.id, answer: 'accept', offer: { ...cand.offer } }; proposal.recordMissing = ['nation (declared by the signer)', 'v, season, at (added when signed)']; }
  return { ...base, proposal };
}
