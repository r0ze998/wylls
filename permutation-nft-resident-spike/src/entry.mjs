// The entry desk: payment, mint and eligibility as three separate records.
//
//   payment     the x402/USDC leg (⑰): a receipt with a state the payment
//               rail reports — settled / failed / unknown. Mocked here.
//   mint        one Core asset minted for one settled payment, keyed by the
//               payment id, with an intent written BEFORE the send so a crash
//               between send and record is recoverable (the chain is asked
//               by memo = intent id). Never two mints for one payment.
//   eligibility NOT a record here at all: it is the registry's projection of
//               who holds the asset. The desk returns the asset id; the
//               waitlist shows the resident once the chain confirms it.
//
// One transaction for payment + mint is not claimed. With Core, a mint into
// a collection needs the collection authority's signature and the payer's
// USDC transfer needs the payer's; the relay already co-signs user
// transactions (the x402 join route), so a combined transaction is
// *plausible*, but whether it is atomic under the real signer set, the
// sponsor's fee rules and the x402 facilitator's checks is an integration
// condition (docs/CONTRACT.ja.md §6), not a property of this mock.
import { randomId } from './crypto.mjs';
import { ERR, refuse } from './errors.mjs';

/** A payment rail stand-in: `settle(ref)` returns the outcome the test scripted; `lookup(ref)` what the rail knows later. */
export class MockPaymentRail {
  constructor() { this.outcomes = new Map(); this.settled = new Map(); }
  /** Script the next outcome of `ref`: 'settled' | 'failed' | 'unknown'. */
  script(ref, outcome) { this.outcomes.set(ref, outcome); }
  async settle(ref, { wallet, amount }) {
    const o = this.outcomes.get(ref) ?? 'settled';
    if (o === 'unknown') { this.settled.set(ref, { wallet, amount, state: 'settled', hidden: true }); return { state: 'unknown' }; }
    if (o === 'failed') return { state: 'failed', reason: 'declined' };
    this.settled.set(ref, { wallet, amount, state: 'settled' });
    return { state: 'settled', paymentId: `pay_${ref}` };
  }
  /** What the rail says about `ref` when asked again (the unknown case resolved by a later lookup). */
  async lookup(ref) {
    const s = this.settled.get(ref);
    return s ? { state: 'settled', paymentId: `pay_${ref}` } : { state: 'notfound' };
  }
}

export class EntryDesk {
  /**
   * @param {object} o
   * @param {{state, save()}} o.store
   * @param {MockPaymentRail} o.rail
   * @param {import('./mock-chain.mjs').MockChain} o.chain    the mint side (the relay holds the collection authority)
   * @param {string} o.collection
   * @param {object} o.authority   the collection authority keypair
   * @param {object} o.registry    to prompt a read after a mint (eligibility is derived there)
   * @param {{amount: string}} o.terms   test values only (not a price decision)
   */
  constructor({ store, rail, chain, collection, authority, registry, terms = { amount: 'TEST-VALUE' }, now = Date.now }) {
    this.store = store; this.rail = rail; this.chain = chain; this.collection = collection; this.authority = authority; this.registry = registry; this.terms = terms; this.now = now;
    this.store.state ??= {};
    this.store.state.entry ??= { payments: {}, mints: {}, byIdempotencyKey: {} };
  }

  get db() { return this.store.state.entry; }
  save() { this.store.save(); }

  /**
   * Step 1: pay. Idempotent by `idempotencyKey` (a retry or a double click
   * returns the recorded result; a different request under the same key is
   * IdempotencyConflict). The rail's answer is recorded as it is: 'unknown'
   * is kept unknown, never guessed as settled or failed.
   */
  async pay({ wallet, idempotencyKey, ref = idempotencyKey }) {
    if (!wallet || !idempotencyKey) refuse(ERR.BAD_REQUEST, 'wallet and idempotencyKey');
    const prior = this.db.byIdempotencyKey[idempotencyKey];
    if (prior) {
      const p = this.db.payments[prior];
      if (p.wallet !== wallet) refuse(ERR.IDEMPOTENCY_CONFLICT, 'this key was used for another wallet');
      if (p.state !== 'unknown') return { ...p, replayed: true };
      return this.#resolveUnknown(p);
    }
    const id = `p_${randomId(10)}`;
    const p = { id, wallet, ref, amount: this.terms.amount, state: 'pending', idempotencyKey, createdAt: this.now() };
    this.db.payments[id] = p;
    this.db.byIdempotencyKey[idempotencyKey] = id;
    this.save();
    const r = await this.rail.settle(ref, { wallet, amount: this.terms.amount });
    p.state = r.state; p.paymentId = r.paymentId ?? null; p.reason = r.reason ?? null; p.settledAt = this.now();
    this.save();
    return { ...p, replayed: false };
  }

  async #resolveUnknown(p) {
    const r = await this.rail.lookup(p.ref);
    if (r.state === 'settled') { p.state = 'settled'; p.paymentId = r.paymentId; p.resolvedAt = this.now(); this.save(); }
    return { ...p, replayed: true };
  }

  /**
   * Step 2: mint for a settled payment. One asset per payment, ever. The
   * intent is recorded before the mint is sent; a mint whose outcome was
   * lost is found again by its memo (`recover`). An unknown or failed
   * payment mints nothing (PaymentUnknown / PaymentFailed).
   */
  async mintFor({ paymentRecordId, to }) {
    const p = this.db.payments[paymentRecordId];
    if (!p) refuse(ERR.BAD_REQUEST, 'no such payment');
    if (p.state === 'unknown' || p.state === 'pending') refuse(ERR.PAYMENT_UNKNOWN, 'the payment outcome is not known; nothing is minted until it is', { payment: p.id });
    if (p.state === 'failed') refuse(ERR.PAYMENT_FAILED, 'the payment failed; nothing is minted', { payment: p.id });
    if (to !== p.wallet) refuse(ERR.BAD_REQUEST, 'the asset goes to the paying wallet in this spike (a different recipient is a decision for the owner)');
    let m = this.db.mints[p.id];
    if (m?.state === 'minted') return { ...m, replayed: true };
    if (m?.state === 'sent') return this.recover(p.id);
    m = { paymentRecordId: p.id, intent: `intent_${randomId(8)}`, to, state: 'sent', sentAt: this.now(), assetId: null, signature: null };
    this.db.mints[p.id] = m;
    this.save();                              // the intent is on disk before the send
    const r = this.chain.mint({ collection: this.collection, to, authority: this.authority, memo: m.intent });
    if (this.crashAfterSend) { this.crashAfterSend = false; throw new Error('simulated crash after the mint was sent, before it was recorded'); }
    m.state = 'minted'; m.assetId = r.assetId; m.signature = r.signature; m.slot = r.slot;
    this.save();
    await this.registry.ingest({ kind: 'mint', assetId: r.assetId, signature: r.signature, slot: r.slot, to });
    return { ...m, replayed: false };
  }

  /** Find a mint whose outcome was lost (state 'sent'): the chain's events by memo. Never mints again while the first is unknown. */
  async recover(paymentRecordId) {
    const m = this.db.mints[paymentRecordId];
    if (!m || m.state !== 'sent') return m ? { ...m, replayed: true } : null;
    const found = this.chain.eventsSince(0).find(e => e.kind === 'mint' && e.memo === m.intent);
    if (!found) refuse(ERR.MINT_UNKNOWN, 'the mint was sent and its outcome is not known yet; it is not retried blindly', { intent: m.intent });
    m.state = 'minted'; m.assetId = found.assetId; m.signature = found.signature; m.slot = found.slot; m.recovered = true;
    this.save();
    await this.registry.ingest({ kind: 'mint', assetId: found.assetId, signature: found.signature, slot: found.slot, to: found.to });
    return { ...m, replayed: true };
  }

  /** Step 3 is not here: eligibility = the registry's view of the holder. */
  eligibility(wallet) { return this.registry.entitlement(wallet); }
}
