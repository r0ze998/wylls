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
 * The settle record's cargo is floor(milli / 1000) of what the caravan carried (worn on the road at the send), so it
 * is a lower bound of the cargo carried, and a 0 there is not "nothing arrived". A storehouse also keeps at most its
 * capacity and drops the rest silently; a village's stores were not compared here. So a delivery's quantity is
 * `unverified`, with the record's lower bound kept beside it, never the plan's cargo, never 0. A lost caravan credits
 * nothing (the program's lost branch writes no store), counted only for a caravan proven this request's own.
 */
export function arrivalOf(op) {
  const toVault = String(op.planSummary?.to ?? '').startsWith('vault:');
  const recorded = op.caravan?.settle ? { cargoLogged: op.caravan.settle.cargoLogged, precision: op.caravan.settle.precision } : null;
  if (!op.caravan?.mine) return { transportEnded: Boolean(op.outcome), settled: Boolean(op.caravan?.settle), quantity: { state: 'unverified', basis: 'the caravan is not proven this request\'s own (signature): nothing about its amount is claimed' } };
  if (op.outcome === 'lost') return { transportEnded: true, settled: true, quantity: { state: 'none', basis: 'program: a lost caravan credits nothing (its own settle record, outcome LOST)' } };
  if (op.outcome === 'delivered') return { transportEnded: true, settled: true, quantity: { state: 'unverified', ...(recorded ? { recorded } : {}),
    basis: toVault ? 'the settle record carries floor(milli / 1000) of the cargo carried; a storehouse keeps at most its capacity of each resource and drops the rest' : 'the settle record carries floor(milli / 1000) of the cargo carried; the village\'s stores were not compared' } };
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
    // ④ (30e7de98, as reported): the settle record's cargo is floor(milli / 1000), a lower bound; 0 there is not 0.
    // A village credits the whole carried cargo (RuleDerived): what arrived is at least the logged units and less
    // than one more of each, never the plan's cargo (the road wears it). KnownZero only on this request's own
    // matching record (a raid's, or the settle's LOST).
    const logged = op.caravan?.settle?.cargoLogged ?? null;
    const mine = Boolean(op.caravan?.mine);
    if (op.outcome === 'delivered' && mine && !toVault && logged) outcome = { delivered: { atLeast: logged, below: Object.fromEntries(Object.entries(logged).map(([r, n]) => [r, n + 1])), unit: 'whole', precision: 'floor(milli / 1000) in the record; resources not listed: at least 0, below 1' }, verification: 'RuleDerived', cargo_logged: logged };
    else if (op.outcome === 'delivered') outcome = { delivered: null, verification: 'Unverifiable', cargo_logged: logged };
    else if (mine && (op.outcome === 'lost' || (op.outcome === 'taken' || op.outcome === 'burned') && op.caravan?.raid?.record)) outcome = { delivered: {}, verification: 'KnownZero', cargo_logged: op.outcome === 'lost' ? logged : null };
    else outcome = { delivered: null, verification: 'Unverifiable', cargo_logged: logged };
    outcome.effects = mine ? [`caravan_sent ${cvSubject(op)}`, `caravan_settled ${cvSubject(op)}`] : [];
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
  if (op.chain?.absenceProven === true) return { category: 'released', lamports: null, basis: 'this request\'s own signature is proven absent (patch 0007: finalized history over its lifetime): it never landed, so no fee' };
  if (Number.isSafeInteger(op.chain?.fee) && ['landed', 'failed'].includes(op.chain?.state)) return { category: op.chain.commitment === 'finalized' ? 'charged' : 'unconfirmed', lamports: op.chain.fee, basis: `the relay reported the fee (patch 0007) at commitment ${op.chain.commitment}` };
  if (op.gateway?.status === 'refused') return { category: null, lamports: null, basis: 'refused by the agent wallet before signing (its record for this key)' };
  if (op.state === 'failed' && !op.uncertain && op.unknownSince === null && !op.gateway?.signature) return { category: null, lamports: null, basis: 'refused on a clean first attempt, before anything was signed' };
  if (op.chain?.state === 'landed' || op.state === 'processing' || op.state === 'completed' || op.chain?.state === 'failed') return { category: 'unconfirmed', lamports: null, basis: 'landed (or landed and failed): the fee is charged, but the relay does not report its amount' };
  if (op.gateway?.signature && !['failed'].includes(op.state)) return { category: 'reserved', lamports: null, basis: 'signed and may still land' };
  return { category: 'unconfirmed', lamports: null, basis: 'an attempt may have been signed; its absence is not proven, so it is never released' };
}

/** A revoked connection's cancellation in ④'s phases, per operation. */
export function ws04CancelPhase(op) {
  if (op.state === 'processing') return { phase: 'Ineffective', at: 'InTransit' };
  if (op.state === 'completed') return { phase: 'Completed', effects: [`caravan_sent ${cvSubject(op)}`, `caravan_settled ${cvSubject(op)}`] };
  if (op.state === 'failed') return { phase: 'Completed', effects: [] };
  // Signed or possibly signed, not yet decided: ④ wants `until`. Known only once this server has the signature and
  // the relay's recorded lifetime (patch 0007): then it is that signature's last valid block height (a block height,
  // not a slot). Without them (no 0007, or the signature unknown) it is null: ⑤'s ActionResult does not carry it (④ G-1).
  if (op.attempts > 0 || op.gateway?.signature) {
    const h = op.gateway?.signature ? op.lifetime?.lastValidBlockHeight ?? null : null;
    return { phase: 'AwaitingSigned', until: h == null ? null : { lastValidBlockHeight: h, unit: 'block height', signature: op.gateway.signature, source: op.lifetime.source } };
  }
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
    if (v.verification === 'RuleDerived') return { transportEnded: true, settled: true, quantity: { state: 'verified', received: v.delivered, basis: 'RuleDerived (④): a holding credits the whole carried cargo (Accrual::add has no cap); the amount is the settle record\'s floor(milli / 1000), a lower bound' }, verification: v.verification };
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
