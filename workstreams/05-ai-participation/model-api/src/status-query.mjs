// The status of one of ⑤'s game operations, for ③ (the owner's MCP shows it) and for ④ — in ④'s vocabulary
// (CONTRACTS §5 ③-R4: Landed / Failed / Pending / Absent / Unavailable), from what ⑤ can read today:
//   ⑤'s journal (did the act begin, what did the relay answer) and the relay's GET /f/tx/{signature}.
//
// Where the relay cannot show ④'s conditions, the answer is the weaker one, never the stronger:
//   - relay `landed` / `failed` are reported at `confirmed` OR `finalized` (the relay does not say which):
//     Landed / Failed with finality "not distinguished" — not a finalized proof
//   - relay `expired` only compares the CONFIRMED block height with the send's lastValidBlockHeight, without a
//     finalized, complete-history query: NOT ④'s Absent → Unavailable (costs stay held; nothing is re-signed)
//   - relay `unknown`, or no answer → Unavailable (it may still land)
//   - validUntil: null — the relay records lastValidBlockHeight for a priced send but does not expose it (agent_view
//     holds have no such field); ⑤ does not guess it from a clock
// Nothing here signs, re-sends or releases anything.
//
// p05-status/0.2: with a fate reader (GET /f/agent/fate, ④ 77c5cbe2) the answer carries ④'s seven states
// (`fate.state`: not-sent | landed | failed | expired | pending | unknown | unqueryable), the signing facts the relay
// fixed (signature, lastValidBlockHeight as `validUntil`, slotFloor, signedAt), the commitment seen, and the act's
// run4Id in ④'s registry contract. RESULT UNKNOWN (`unknown`), PROVED EXPIRY (`expired`) and COULD NOT ASK
// (`unqueryable`) are three different answers; only the proved ends are `terminal`.
// Without a fate reader the 0.1 answer (GET /f/tx, weaker) is given, and says so.
import { IN_RUN4, idempotencyKeyOf } from './fate-reader.mjs';
import { run4IdOf } from './acts-registry.mjs';

export const STATUS_CONTRACT = 'p05-status/0.2 (④ EXECUTION-CONTRACT 77c5cbe2 states; agreed by neither side yet)';

const chainOf = t => {
  if (!t || typeof t !== 'object') return { status: 'Unavailable', why: 'the relay did not answer' };
  switch (t.state) {
    case 'landed': return { status: 'Landed', finality: 'confirmed or finalized (not distinguished by the relay)', slot: t.slot ?? null };
    case 'failed': return { status: 'Failed', finality: 'confirmed or finalized (not distinguished by the relay)', slot: t.slot ?? null, code: t.code ?? null };
    case 'expired': return { status: 'Unavailable', why: 'the relay says expired by the confirmed block height; ④\'s Absent needs a finalized, complete-history query (not shown)', relayState: 'expired' };
    default: return { status: 'Unavailable', why: 'no status yet: it may still land', relayState: t.state ?? null };
  }
};

/**
 * @param {object} o
 * @param {object} o.journal   RunJournal (⑤'s record of act-begin / act-result / act-error)
 * @param {Function} o.txState async signature → GET /f/tx answer
 * @param {string} requestId   the agent_act requestId (p05.…)
 */
export async function statusOf({ journal, txState, fate = null, agentId = null, source = null }, requestId) {
  const es = journal.entries.filter(e => e.attemptId === requestId);
  if (fate && agentId && source) return statusByFate({ es, fate, agentId, source, requestId });
  const base = { contract: STATUS_CONTRACT, readBy: 'GET /f/tx (no fate reader)', requestId, validUntil: null, validUntilWhy: 'the relay does not expose lastValidBlockHeight for an action' };
  if (!es.length) return { ...base, submission: 'unknown-request', chain: null, terminal: false };
  const result = es.findLast(e => e.step === 'act-result');
  const error = es.findLast(e => e.step === 'act-error');
  if (result && result.outcome !== 'sent' && !(result.outcome === 'failed' && result.sent !== false)) {
    // The relay answered and did not send (refused, or failed before sending): nothing to look up on chain.
    return { ...base, submission: result.outcome === 'refused' ? 'refused' : 'not-sent', code: result.code ?? null, signature: null, chain: null, terminal: true };
  }
  const signature = result?.signature ?? null;
  if (!signature) {
    // Begun, and the relay's answer is not known (unreachable, lost): it may have been sent. Asking again with the same
    // requestId is the relay's replay, not a new send (participate does that on the next run).
    return { ...base, submission: 'begun-unknown', code: error?.code ?? null, signature: null, chain: { status: 'Unavailable', why: 'no signature known yet' }, terminal: false };
  }
  let t = null;
  try { t = await txState(signature); } catch { t = null; }
  const chain = chainOf(t);
  return { ...base, submission: 'sent', signature, chain, terminal: false, terminalWhy: 'finality is not distinguished by the relay: no answer here is final' };
}

/** The answer from GET /f/agent/fate: ④'s seven states, kept apart. */
async function statusByFate({ es, fate, agentId, source, requestId }) {
  const key = idempotencyKeyOf(source, requestId);
  const base = { contract: STATUS_CONTRACT, readBy: 'GET /f/agent/fate', requestId, idempotencyKey: key, run4Id: run4IdOf(agentId, key) };
  const journalSays = es.length ? (es.findLast(e => e.step === 'act-result')?.outcome ?? (es.some(e => e.step === 'act-error') ? 'begun-unknown' : 'begun')) : 'unknown-request';
  const f = await fate(agentId, key);
  const terminal = f.final === true;
  return {
    ...base, journal: journalSays,
    fate: { state: f.state, in4: IN_RUN4[f.state], commitment: f.commitment ?? null, why: f.why ?? null, retained: f.retained ?? null, ...(f.readError ? { readError: f.readError } : {}) },
    signature: f.signature ?? null, signedAt: f.signedAt ?? null, slotFloor: f.slotFloor ?? null,
    // ③-R3 valid_until: the block height after which the signed bytes cannot land (a BLOCK HEIGHT, not a slot).
    validUntil: f.lastValidBlockHeight ?? null, validUntilUnit: 'block height (lastValidBlockHeight)',
    terminal, mayRetry: f.noEffect === true,
    terminalWhy: terminal ? 'finalized, or proved never to land' : f.state === 'unqueryable' ? 'could not ask: says nothing about the act' : f.state === 'unknown' ? 'result unknown: absence cannot be proved; held' : 'not final yet',
  };
}
