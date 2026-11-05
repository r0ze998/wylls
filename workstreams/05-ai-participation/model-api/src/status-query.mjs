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
export const STATUS_CONTRACT = 'p05-status/0.1 (④ vocabulary; ④\'s contract not yet agreed)';

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
export async function statusOf({ journal, txState }, requestId) {
  const es = journal.entries.filter(e => e.attemptId === requestId);
  const base = { contract: STATUS_CONTRACT, requestId, validUntil: null, validUntilWhy: 'the relay does not expose lastValidBlockHeight for an action' };
  if (!es.length) return { ...base, submission: 'unknown-request', chain: null, terminal: false };
  const result = es.findLast(e => e.step === 'act-result');
  const error = es.findLast(e => e.step === 'act-error');
  if (result && result.outcome !== 'sent') {
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
