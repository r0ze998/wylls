// The checks a RunReceipt port must pass for ⑤ to use it: the local adapter today, ④'s implementation once received.
// Each check returns a list of failures (empty = conformant). `receipt` is what port.close() (and refreshFates) gave.
import { RECEIPT_FIELDS, RECEIPT_VERSION } from './run-receipt.mjs';

const get = (o, path) => path.replace(/\[\]/g, '').split('.').reduce((v, k) => (v == null ? v : v[k]), o);

/** Shape: every field ⑤ reads is present (null allowed only where the port says it cannot give it). */
export function checkShape(receipt, { allowFrom4Null = true } = {}) {
  const fails = [];
  if (receipt.receiptVersion !== RECEIPT_VERSION) fails.push(`receiptVersion ${receipt.receiptVersion} ≠ ${RECEIPT_VERSION}`);
  for (const [path, f] of Object.entries(RECEIPT_FIELDS)) {
    if (path.includes('[]')) {
      const [list, field] = path.split('[].');
      for (const [i, a] of (receipt[list] ?? []).entries()) if (!(field in a)) fails.push(`${list}[${i}].${field} missing`);
      continue;
    }
    const v = get(receipt, path);
    if (v === undefined) fails.push(`${path} missing`);
    else if (v === null && !(f.from4 && allowFrom4Null) && !['cancel.stage', 'inference.status', 'inference.attempts', 'costs.inference', 'costs.game'].includes(path)) fails.push(`${path} is null`);
  }
  return fails;
}

/** Sequence: the run's marks are ordered, and every act the relay recorded during the run falls between them. */
export function checkSeq(receipt) {
  const fails = [];
  if (!Number.isInteger(receipt.seq?.observed) || !Number.isInteger(receipt.seq?.closed)) fails.push('seq.observed and seq.closed must be integers');
  else if (receipt.seq.closed < receipt.seq.observed) fails.push(`seq.closed ${receipt.seq.closed} < seq.observed ${receipt.seq.observed}`);
  return fails;
}

/** Acts: a sent act has a signature and an idempotency key read back from the relay; a refused one has a code; nothing sent twice. */
export function checkActs(receipt) {
  const fails = [];
  const sigs = new Set();
  for (const a of receipt.acts) {
    if (a.status === 'sent' && !a.signature) fails.push(`${a.requestId}: sent without a signature`);
    if (a.status === 'sent' && !a.idempotencyKey) fails.push(`${a.requestId}: sent but not found in the relay history`);
    if (a.status === 'refused' && !a.code) fails.push(`${a.requestId}: refused without a code`);
    if (a.signature) { if (sigs.has(a.signature)) fails.push(`${a.signature}: twice in one run`); sigs.add(a.signature); }
  }
  return fails;
}

/** Costs: the inference cost is never shown as 0 while undecided; the game charge of a refused act is 0. */
export function checkCosts(receipt) {
  const fails = [];
  const inf = receipt.costs?.inference;
  if (inf && receipt.inference?.attempts?.some(a => a.cost?.unknown) && BigInt(inf.undecided) === 0n && BigInt(inf.settled) === 0n) fails.push('an attempt with an unknown cost shows neither undecided nor settled');
  for (const a of receipt.acts) if (a.status === 'refused' && a.gameCharge && BigInt(a.gameCharge.reserved ?? '0') !== 0n) fails.push(`${a.requestId}: refused but a game charge is held`);
  return fails;
}

/** Cancel: a sent act cannot be cancelled; a stop before signing is honoured. */
export function checkCancel(port, runId) {
  const fails = [];
  const sent = port.cancel(runId, 'sent');
  if (sent.result !== 'Irrevocable') fails.push(`cancel at 'sent' answered ${sent.result}`);
  return fails;
}

export const conformance = receipt => [...checkShape(receipt), ...checkSeq(receipt), ...checkActs(receipt), ...checkCosts(receipt)];
