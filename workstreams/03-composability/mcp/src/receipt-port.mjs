// The seam to ④'s run ledger (patches/0006, adopted on this side): everything this server says about the fate
// of an operation — the receipt, a revoked connection's cancellation, the amount that arrived — goes through one
// port object. Today only the local adapter exists: this server's own tracking, in a MOCK shape it labels as such
// (`mock: true`, contract `wylls.mock-run-receipt/0`). ④'s contract has not been received, so no adapter for it
// exists, and asking for one fails at start instead of quietly falling back to the MOCK.
//
// A port is { contract: string, real: boolean, receipt(op), cancellation(link, ops), arrival(op) }.
// `portConformance` (test/receipt-port.test.mjs) is what any adapter, ④'s included, must pass.
import { MOCK_RUN_RECEIPT, receiptOf, cancellationOf } from './ports.mjs';

export const RECEIPT_PORT_SHAPE = 'wylls.ws03.receipt-port/1';

/**
 * What the end of a caravan says about the amount that arrived (④'s "arrival quantity unverified", as a MOCK field).
 * The settle record carries the cargo that was sent, not what was credited: a storehouse clips each resource at its
 * capacity, and a village's stores were not compared. So a delivery's quantity is `unverified`, never the full cargo
 * and never 0. A lost caravan credits nothing (the program's lost branch writes no store).
 */
export function arrivalOf(op) {
  const toVault = String(op.planSummary?.to ?? '').startsWith('vault:');
  if (op.outcome === 'lost') return { transportEnded: true, settled: true, quantity: { state: 'none', basis: 'program: a lost caravan credits nothing' } };
  if (op.outcome === 'delivered') return { transportEnded: true, settled: true, quantity: { state: 'unverified', sent: op.planSummary?.cargo ?? null,
    basis: toVault ? 'the settle record carries the sent cargo; a storehouse keeps at most its capacity of each resource and drops the rest' : 'the settle record carries the sent cargo; the village\'s stores were not compared' } };
  return { transportEnded: true, settled: op.outcome !== 'taken', quantity: { state: 'unverified', basis: `the caravan was ${op.outcome ?? 'raided'}: what reached the destination is not recorded` } };
}

/** This server's own tracking behind the port (MOCK shapes, labelled). */
export class LocalReceiptPort {
  contract = MOCK_RUN_RECEIPT;
  real = false;
  receipt(op) { return receiptOf(op); }
  cancellation(link, ops) { return cancellationOf(link, ops); }
  arrival(op) { return arrivalOf(op); }
}

/** Checks that `p` has the port's shape; returns it. */
export function assertReceiptPort(p) {
  for (const m of ['receipt', 'cancellation', 'arrival']) if (typeof p?.[m] !== 'function') throw new Error(`receipt port: ${m}() is missing`);
  if (typeof p.contract !== 'string' || !p.contract) throw new Error('receipt port: contract is missing');
  if (typeof p.real !== 'boolean') throw new Error('receipt port: real must say whether it is ④\'s ledger');
  if (p.real === false && !/mock/.test(p.contract)) throw new Error('receipt port: a port that is not ④\'s ledger must name a mock contract');
  return p;
}

/**
 * The port a deployment asks for (`WYLLS_MCP_RECEIPT_PORT`): `local` (default) or the name of ④'s adapter,
 * which this build does not have. Never falls back.
 */
export function receiptPortFor(name = 'local') {
  if (name === 'local') return new LocalReceiptPort();
  throw new Error(`receipt port "${name}": no adapter in this build (④'s RunReceipt contract has not been received; see patches/0006 and docs 13). Use local.`);
}
