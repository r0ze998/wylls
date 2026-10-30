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

// ------------------------------------------------------------ ④'s vocabulary (proposal 0.2), as a MOCK mapping

/**
 * ④'s received contract (workstream 04, HEAD 2e536b6b, docs/CONTRACTS.ja.md "④ 0.2", every item a *proposal*):
 * the run states, held reasons, cancel phases, verification and fee categories this mapping speaks.
 * Source: workstreams/04-execution/src/model.rs (RunState, CancelPhase, Verification, Outcome), src/store.rs (FeeBook).
 */
export const WS04 = Object.freeze({
  source: '④ workstreams/04-execution @ 2e536b6b119d8eaa4e9f4d795e856b696249a664 (CONTRACTS 0.2, proposal)',
  states: Object.freeze(['Accepted', 'Reserved', 'FacilityRequested', 'FacilitySubmitted', 'FacilityConfirmed', 'ShipRequested', 'ShipSubmitted', 'InTransit', 'Arrived', 'Fulfilled', 'Partial', 'DeliveredUnverified', 'Failed', 'Cancelled', 'Expired']),
  held: Object.freeze(['WalletRequired', 'Indeterminate', 'PortUnavailable', 'Inconsistent']),
  cancel: Object.freeze(['StoppingNew', 'AwaitingSigned', 'Completed', 'Ineffective']),
  verification: Object.freeze(['Recorded', 'RuleDerived', 'KnownZero', 'Unverifiable', 'NotShipped']),
  fees: Object.freeze(['reserved', 'charged', 'unconfirmed', 'released']),
});

const cvSubject = op => `cv:${BigInt(op.caravan?.ownerTag ?? 0).toString(16)}:${op.caravan?.seq ?? '?'}`;
const failReason = { lost: 'DestinationChanged', taken: 'Raided', burned: 'LostInTransit' };

/** ③'s operation (one SendCaravan between the owner's own places) as ④'s Run state, held reason and outcome. */
export function ws04View(op) {
  const toVault = String(op.planSummary?.to ?? '').startsWith('vault:');
  const sent = Boolean(op.gateway?.signature) || op.state === STATES_PROCESSING || op.state === 'completed';
  let state; let reason = null;
  if (op.state === 'requested') state = op.attempts > 0 ? 'ShipRequested' : 'Accepted';
  else if (op.state === 'accepted') state = 'ShipSubmitted';
  else if (op.state === 'processing') state = 'InTransit';
  else if (op.state === 'completed') state = op.outcome === 'delivered' ? (toVault ? 'DeliveredUnverified' : 'Fulfilled') : 'Failed';
  else state = op.error?.code === 'GrantRevoked' && !sent ? 'Cancelled' : 'Failed';
  if (state === 'Failed') reason = failReason[op.outcome] ?? op.error?.code ?? 'Failed';
  // Held: an attempt whose outcome is unknown (Indeterminate), or this server cannot reach the agent wallet with
  // the connection's capability (no ④ reason fits exactly: PortUnavailable is the nearest, a mismatch to report).
  const held = op.hold?.code === 'CapabilityUnavailable' ? 'PortUnavailable' : (op.uncertain && !['completed', 'failed'].includes(op.state) ? 'Indeterminate' : null);
  // Outcome (④ STATE-MACHINE "到着量の判定"): a holding credits the whole cargo (RuleDerived); a vault without
  // `credited` cannot be known (Unverifiable); lost, taken and burned are known to be nothing (KnownZero).
  let outcome = null;
  if (op.outcome) {
    const cargo = op.planSummary?.cargo ?? null;
    if (op.outcome === 'delivered') outcome = toVault ? { delivered: null, verification: 'Unverifiable', cargo_logged: cargo } : { delivered: cargo, verification: 'RuleDerived', cargo_logged: cargo };
    else outcome = { delivered: {}, verification: 'KnownZero', cargo_logged: op.outcome === 'lost' ? cargo : null };
    outcome.effects = [`caravan_sent ${cvSubject(op)}`, `caravan_settled ${cvSubject(op)}`];
  }
  return { contract: WS04.source, state, ...(reason ? { reason } : {}), held_reason: held, outcome, fees: feesOf(op) };
}

/**
 * ④'s four fee categories for the one network fee an attempt can cost (lamports, paid by the relay's payer).
 * This server never sees the amount (the relay's /f/tx answer has no fee) and cannot prove absence (④ HANDOFF §3),
 * so it can only say which category the attempt is in: never `released` (that needs Absent), and `unconfirmed`
 * wherever ④ would want a reported fee. Amounts are null, not 0.
 */
export function feesOf(op) {
  if (op.attempts === 0 && !op.gateway?.signature) return { category: null, lamports: null, basis: 'no attempt was made' };
  if (op.gateway?.status === 'refused') return { category: null, lamports: null, basis: 'refused by the agent wallet before signing (its record for this key)' };
  if (op.state === 'failed' && !op.uncertain && op.unknownSince === null && !op.gateway?.signature) return { category: null, lamports: null, basis: 'refused on a clean first attempt, before anything was signed' };
  if (op.chain?.state === 'landed' || op.state === 'processing' || op.state === 'completed' || op.chain?.state === 'failed') return { category: 'unconfirmed', lamports: null, basis: 'landed (or landed and failed): the fee is charged, but the relay does not report its amount' };
  if (op.gateway?.signature && !['failed'].includes(op.state)) return { category: 'reserved', lamports: null, basis: 'signed and may still land' };
  return { category: 'unconfirmed', lamports: null, basis: 'an attempt may have been signed; absence cannot be proven here, so it is never released' };
}

/** A revoked connection's cancellation in ④'s phases, per operation. */
export function ws04CancelPhase(op) {
  if (op.state === 'processing') return { phase: 'Ineffective', at: 'InTransit' };
  if (op.state === 'completed') return { phase: 'Completed', effects: [`caravan_sent ${cvSubject(op)}`, `caravan_settled ${cvSubject(op)}`] };
  if (op.state === 'failed') return { phase: 'Completed', effects: [] };
  // Signed or possibly signed, not yet decided: ④ wants `until` (the last slot it can land in). The agent wallet
  // does not return it to this server, so it is null here: a gap to close in ⑤'s ActionResult (docs 14).
  if (op.attempts > 0 || op.gateway?.signature) return { phase: 'AwaitingSigned', until: null };
  return { phase: 'StoppingNew' };
}

const STATES_PROCESSING = 'processing';

/**
 * ③'s own tracking rendered in ④'s proposed vocabulary. Still a MOCK: it is not ④'s ledger (④'s executor is Rust
 * with its own run store; no adapter between them exists yet). Every receipt keeps ③'s fields and adds `ws04`.
 */
export class Ws04MappedPort {
  contract = 'wylls.mock-run-receipt/0+ws04-proposal-0.2';
  real = false;
  #local = new LocalReceiptPort();
  receipt(op) { return { ...this.#local.receipt(op), contract: this.contract, ws04: ws04View(op) }; }
  cancellation(link, ops) {
    const c = this.#local.cancellation(link, ops);
    return c && { ...c, contract: this.contract, ws04: Object.fromEntries(ops.map(o => [o.id, ws04CancelPhase(o)])) };
  }
  arrival(op) {
    const v = ws04View(op).outcome;
    if (!v) return this.#local.arrival(op);
    if (v.verification === 'RuleDerived') return { transportEnded: true, settled: true, quantity: { state: 'verified', received: v.delivered, basis: 'RuleDerived (④): a holding credits the whole cargo (Accrual::add has no cap)' }, verification: v.verification };
    if (v.verification === 'KnownZero') return { transportEnded: true, settled: op.outcome !== 'taken', quantity: { state: 'none', basis: `KnownZero (④): ${failReason[op.outcome] ?? op.outcome}` }, verification: v.verification };
    return { ...this.#local.arrival(op), verification: v.verification };
  }
}

/**
 * The port a deployment asks for (`WYLLS_MCP_RECEIPT_PORT`): `local` (default), `ws04-mapped` (the same tracking
 * in ④'s proposed vocabulary, still a MOCK), or ④'s real adapter, which this build does not have. Never falls back.
 */
export function receiptPortFor(name = 'local') {
  if (name === 'local') return new LocalReceiptPort();
  if (name === 'ws04-mapped') return new Ws04MappedPort();
  throw new Error(`receipt port "${name}": no adapter in this build (④'s run ledger has no adapter to this server yet; see docs 14). Use local or ws04-mapped.`);
}
