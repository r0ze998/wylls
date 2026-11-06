// What became of a transaction the agent wallet sent (a priced action's
// hold, a withdrawal): the rule reconcile uses before money moves back or
// is spent (docs/agent-wallet/STATUS-2026-10-23.ja.md §6). Time passing is
// not evidence. A transaction counts as
//
//   landed   its status is finalized and without error
//   failed   its status is finalized with an error (it ran and moved nothing)
//   expired  ALL of: no status; the finalized block height is past its last
//            valid block height; the node has no such transaction at
//            finalized; and the node can show it keeps history from before
//            the transaction could have landed (its first available block is
//            at or below the slot read before the transaction was built, or
//            the node is known to keep all history, as the in-process local
//            chain does)
//   pending  not decided yet (not finalized, or still within its lifetime)
//   unknown  past its lifetime, but this node cannot prove it never landed
//            (no history from that time, or a read failed): the money stays
//            where it is and the operator is told; never guessed
//
// Every answer also carries (workstream 04, additive; `fate` is unchanged):
//   commitment   the confirmationStatus the node reported ('processed' |
//                'confirmed' | 'finalized'), or null with no status. Only
//                'finalized' decides a fate; the others are progress.
//   queryFailed  true when a read threw (the node could not be asked): the
//                fate is then 'pending' or 'unknown' by the rule above, and
//                says nothing about the transaction itself
//
// A node without history answers "no status" for a transaction that landed:
// reading that as "expired" would give a landed withdrawal's money back to
// `available`, and the owner could withdraw it again.
const FINAL = 'finalized';

/**
 * @param {object} connection   a web3.js Connection (or the tests' fake)
 * @param {object} sent         {signature, lastValidBlockHeight, slotFloor}
 * @param {object} [o]
 * @param {boolean} [o.fullHistory]  the node keeps every transaction (the local chain); otherwise getFirstAvailableBlock decides
 * @returns {Promise<{fate: 'landed'|'failed'|'expired'|'pending'|'unknown', why: string}>}
 */
export async function fateOf(connection, { signature, lastValidBlockHeight, slotFloor = null }, { fullHistory = false } = {}) {
  let commitment = null;
  const out = (fate, why, queryFailed = false) => ({ fate, why, commitment, queryFailed });
  let st;
  try {
    st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))?.value?.[0] ?? null;
  } catch (e) {
    return out('pending', `status read failed: ${e.message}`, true);
  }
  if (st) {
    commitment = st.confirmationStatus ?? 'processed';
    if (st.confirmationStatus !== FINAL) return out('pending', `status ${commitment}, not finalized yet`);
    return st.err ? out('failed', 'finalized with an error') : out('landed', 'finalized');
  }
  if (!Number.isSafeInteger(lastValidBlockHeight)) return out('unknown', 'no status and no recorded lifetime');
  let height;
  try {
    height = await connection.getBlockHeight(FINAL);
  } catch (e) {
    return out('pending', `block height read failed: ${e.message}`, true);
  }
  if (!(height > lastValidBlockHeight)) return out('pending', 'no status yet, still within its lifetime');
  // Past its lifetime with no status: ask for the transaction itself (a lagging status index can miss one that landed).
  let tx;
  try {
    tx = await connection.getTransaction(signature, { commitment: FINAL, maxSupportedTransactionVersion: 0 });
  } catch (e) {
    return out('unknown', `transaction read failed: ${e.message}`, true);
  }
  if (tx) {
    commitment = FINAL;
    return tx.meta?.err ? out('failed', 'found at finalized, with an error') : out('landed', 'found at finalized');
  }
  if (fullHistory) return out('expired', 'past its lifetime; the node keeps all history and has no such transaction');
  if (!Number.isSafeInteger(slotFloor)) return out('unknown', 'no slot recorded before it was built: history coverage cannot be shown');
  let first;
  try {
    first = await connection.getFirstAvailableBlock();
  } catch (e) {
    return out('unknown', `history coverage read failed: ${e.message}`, true);
  }
  if (Number.isSafeInteger(first) && first <= slotFloor) return out('expired', `past its lifetime; the node's history starts at slot ${first} ≤ ${slotFloor} and has no such transaction`);
  return out('unknown', `the node's history starts at slot ${first}, after slot ${slotFloor}: it cannot show the transaction never landed`);
}

/** The slot to record before a transaction is built (finalized: at or below any slot the transaction can land in); null when unreadable. */
export async function slotFloorOf(connection) {
  try {
    const s = await connection.getSlot(FINAL);
    return Number.isSafeInteger(s) ? s : null;
  } catch {
    return null;
  }
}
