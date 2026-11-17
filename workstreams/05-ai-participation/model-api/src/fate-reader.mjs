// What became of one of ⑤'s game acts, read the way ④'s execution contract says (④ 77c5cbe2,
// docs/EXECUTION-CONTRACT-20261106.ja.md §1): the agent wallet's GET /f/agent/fate?id=&key=, one state of seven.
//
//   not-sent     nothing left the relay                                  final
//   landed       finalized, no error                                     final
//   failed       finalized, with an error                                final
//   expired      past its lifetime AND the node's history proves absence final
//   pending      not finalized yet (commitment is progress, not a decision)
//   unknown      RESULT UNKNOWN: past its lifetime, absence not provable
//   unqueryable  COULD NOT ASK: the node or the record could not be read; says nothing about the transaction
//
// `unknown` and `unqueryable` are different answers and are kept apart here; neither is a failure, neither frees
// the act for a new attempt. Only the three proved ends (failed, expired, not-sent) do.
//
// GET /f/tx/{signature} (the relay's older read) is coarser: its `expired` compares the CONFIRMED height and is not
// ④'s proof, its `unknown` folds pending, result-unknown and unreadable together. txStateFromTx keeps that weakness
// visible instead of upgrading it.
//
// Nothing here signs, sends, releases or derives anything. The HTTP call is injected (`fetch`), so tests use a stub.
export const FATE_CONTRACT = 'p04-fate (④ 77c5cbe2 EXECUTION-CONTRACT §1)';
export const FATE_STATES = Object.freeze(['not-sent', 'landed', 'failed', 'expired', 'pending', 'unknown', 'unqueryable']);
export const FINAL_STATES = Object.freeze(['landed', 'failed', 'expired', 'not-sent']);
/** Proved that the act had no effect: a new attempt may follow (④ §1 "再送してよいか"). */
export const NO_EFFECT_STATES = Object.freeze(['failed', 'expired', 'not-sent']);

/** The same state in ④'s run executor's words (SigStatus, §2). */
export const IN_RUN4 = Object.freeze({
  'not-sent': 'Absent', landed: 'Landed', failed: 'Failed', expired: 'Absent', pending: 'Pending', unknown: 'Unavailable (Indeterminate)', unqueryable: 'Err(PortError::Unavailable)',
});

const SEND_FACTS = ['signature', 'lastValidBlockHeight', 'slotFloor', 'signedAt'];

/** The relay's idempotency key for an agent_act requestId (the MCP server's rule: `${source}:${requestId}`). */
export const idempotencyKeyOf = (source, requestId) => `${source}:${requestId}`;

/**
 * Checks one GET /f/agent/fate answer; anything malformed is NOT trusted as an answer (it becomes unqueryable).
 * @returns {{state, final, noEffect, in4, sent, signature, lastValidBlockHeight, slotFloor, signedAt, commitment, why, retained}}
 */
export function readFate(body) {
  if (!body || typeof body !== 'object' || !FATE_STATES.includes(body.state)) {
    return { state: 'unqueryable', final: false, noEffect: false, in4: IN_RUN4.unqueryable, why: 'the fate answer was not one of the seven states', retained: null, sent: null, signature: null, lastValidBlockHeight: null, slotFloor: null, signedAt: null, commitment: null };
  }
  const facts = Object.fromEntries(SEND_FACTS.map(k => [k, body[k] ?? null]));
  return {
    state: body.state, final: FINAL_STATES.includes(body.state), noEffect: NO_EFFECT_STATES.includes(body.state), in4: IN_RUN4[body.state],
    sent: body.state === 'not-sent' ? false : (body.sent ?? (facts.signature ? true : null)), ...facts,
    commitment: body.commitment ?? null, queryFailed: body.queryFailed === true, retained: body.retained ?? null, why: typeof body.why === 'string' ? body.why : null,
  };
}

/**
 * A reader of GET /f/agent/fate over HTTP.
 * @param {object} o
 * @param {string} o.relay     the relay's base URL
 * @param {Function} o.fetch   fetch-compatible; injected
 * @returns {(agentId: string, key: string) => Promise<object>}  never throws: a failed read is `unqueryable`
 */
export function fateReader({ relay, fetch: f }) {
  if (typeof f !== 'function') throw new Error('fateReader needs a fetch');
  return async (agentId, key) => {
    let res;
    try {
      res = await f(`${String(relay).replace(/\/$/, '')}/f/agent/fate?id=${encodeURIComponent(agentId)}&key=${encodeURIComponent(key)}`, { method: 'GET' });
    } catch (e) {
      return { ...readFate(null), why: `could not ask the relay: ${e?.message ?? e}`, readError: 'Unreachable' };
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.status !== 200) return { ...readFate(null), why: `the fate read answered HTTP ${res.status}${body?.code ? ` (${body.code})` : ''}`, readError: body?.code ?? `HTTP${res.status}` };
    return readFate(body);
  };
}

/**
 * verifyPending's txState from the fate read: `final` only for ④'s proved ends; pending, unknown and unqueryable all
 * map to state 'unknown' for the old caller BUT keep `fateState` so the record tells them apart.
 * @param {Function} fate     fateReader(...)
 * @param {object} o
 * @param {string} o.agentId
 * @param {string} o.source   'ai' | 'mcp': how the MCP server keyed the act
 */
export function txStateFromFate(fate, { agentId, source }) {
  return async (signature, { requestId } = {}) => {
    if (!requestId) return { state: 'unknown', final: false, fateState: 'unqueryable', why: 'no requestId to read the fate by' };
    const r = await fate(agentId, idempotencyKeyOf(source, requestId));
    if (r.signature && signature && r.signature !== signature) return { state: 'unknown', final: false, fateState: 'unqueryable', why: `the fate read is for another signature (${r.signature})` };
    const state = r.final ? (r.state === 'not-sent' ? 'expired' : r.state) : 'unknown';
    return { state, final: r.final, proved: r.final, fateState: r.state, commitment: r.commitment, why: r.why, source: 'GET /f/agent/fate' };
  };
}

/**
 * The older GET /f/tx/{signature} answer, with its limits stated: `expired` there is NOT a proof (confirmed height
 * only), so it is not final; `landed`/`failed` may be read at confirmed (finality not distinguished).
 */
export function txStateFromTx(txState) {
  return async (signature) => {
    let t;
    try { t = await txState(signature); } catch (e) { return { state: 'unknown', final: false, fateState: 'unqueryable', why: `GET /f/tx failed: ${e?.message ?? e}`, source: 'GET /f/tx' }; }
    if (t?.state === 'expired') return { ...t, state: 'unknown', final: false, fateState: 'unknown', relayState: 'expired', why: 'GET /f/tx says expired by the confirmed height: not ④\'s proof of absence', source: 'GET /f/tx' };
    if (t?.state === 'landed' || t?.state === 'failed') return { ...t, final: null, finality: 'not distinguished by GET /f/tx', source: 'GET /f/tx' };
    return { ...t, state: 'unknown', final: false, fateState: 'unknown', source: 'GET /f/tx' };
  };
}
