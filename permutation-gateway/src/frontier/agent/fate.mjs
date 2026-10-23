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
  let st;
  try {
    st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))?.value?.[0] ?? null;
  } catch (e) {
    return { fate: 'pending', why: `status read failed: ${e.message}` };
  }
  if (st) {
    if (st.confirmationStatus !== FINAL) return { fate: 'pending', why: `status ${st.confirmationStatus ?? 'processed'}, not finalized yet` };
    return st.err ? { fate: 'failed', why: 'finalized with an error' } : { fate: 'landed', why: 'finalized' };
  }
  if (!Number.isSafeInteger(lastValidBlockHeight)) return { fate: 'unknown', why: 'no status and no recorded lifetime' };
  let height;
  try {
    height = await connection.getBlockHeight(FINAL);
  } catch (e) {
    return { fate: 'pending', why: `block height read failed: ${e.message}` };
  }
  if (!(height > lastValidBlockHeight)) return { fate: 'pending', why: 'no status yet, still within its lifetime' };
  // Past its lifetime with no status: ask for the transaction itself (a lagging status index can miss one that landed).
  let tx;
  try {
    tx = await connection.getTransaction(signature, { commitment: FINAL, maxSupportedTransactionVersion: 0 });
  } catch (e) {
    return { fate: 'unknown', why: `transaction read failed: ${e.message}` };
  }
  if (tx) return tx.meta?.err ? { fate: 'failed', why: 'found at finalized, with an error' } : { fate: 'landed', why: 'found at finalized' };
  if (fullHistory) return { fate: 'expired', why: 'past its lifetime; the node keeps all history and has no such transaction' };
  if (!Number.isSafeInteger(slotFloor)) return { fate: 'unknown', why: 'no slot recorded before it was built: history coverage cannot be shown' };
  let first;
  try {
    first = await connection.getFirstAvailableBlock();
  } catch (e) {
    return { fate: 'unknown', why: `history coverage read failed: ${e.message}` };
  }
  if (Number.isSafeInteger(first) && first <= slotFloor) return { fate: 'expired', why: `past its lifetime; the node's history starts at slot ${first} ≤ ${slotFloor} and has no such transaction` };
  return { fate: 'unknown', why: `the node's history starts at slot ${first}, after slot ${slotFloor}: it cannot show the transaction never landed` };
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
