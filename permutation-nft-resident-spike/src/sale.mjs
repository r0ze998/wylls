// The relay-side sale desk for the dedicated path (CONTRACT §11): one
// listing per resident, one `Buy` instruction that pays, transfers, bumps
// the generation and clears the session together. The desk adds what the
// chain cannot: idempotency across retries, a record of the signature
// **before** the send (so a lost answer is recovered by looking the
// signature up, never by sending again), and the relay-side refusals.
//
// Price, currency and fee are TEST VALUES carried in the listing; nothing
// here is a product figure. The payment leg is the mock token program; the
// x402 side (⑰) is a boundary, not implemented here (docs/SALE-PATH.ja.md §4).
import { randomId } from './crypto.mjs';
import { ERR, Refusal, refuse } from './errors.mjs';
import { signatureOf, signTx } from './mock-chain.mjs';

export class SaleDesk {
  constructor({ store, chain, registry, now = Date.now }) {
    this.store = store; this.chain = chain; this.registry = registry; this.now = now;
    this.store.state ??= {};
    this.store.state.sales ??= { purchases: {} };
    /** Test hook: throw after the send, before the result is recorded (a lost answer). */
    this.loseAnswer = false;
  }

  get db() { return this.store.state.sales; }

  /** List: the holder signs. Returns the listing as the chain holds it. */
  list({ assetId, seller, price, mint }) {
    const sent = this.chain.send(signTx(this.chain.buildTx([this.chain.ixList({ assetId, seller: seller.publicKey, price, mint })]), [seller]));
    return { signature: sent.signature, listing: this.chain.listings.get(assetId) };
  }

  /**
   * Buy with an idempotency key. A repeat returns the recorded outcome; a
   * repeat of a purchase whose answer was lost looks the recorded signature
   * up on chain (`recover`) instead of sending a second transaction.
   */
  async buy({ idempotencyKey, assetId, buyer, maxPrice = null }) {
    if (!idempotencyKey) refuse(ERR.BAD_REQUEST, 'idempotencyKey');
    const prior = this.db.purchases[idempotencyKey];
    if (prior) {
      if (prior.assetId !== assetId || prior.buyer !== buyer.publicKey) refuse(ERR.IDEMPOTENCY_CONFLICT, 'this key was used for another purchase');
      if (prior.state === 'sent') return this.recover(idempotencyKey);
      return { ...prior, replayed: true };
    }
    const tx = signTx(this.chain.buildTx([this.chain.ixBuy({ assetId, buyer: buyer.publicKey, maxPrice })]), [buyer]);
    const signature = signatureOf(tx);
    const rec = { idempotencyKey, assetId, buyer: buyer.publicKey, signature, state: 'sent', at: this.now() };
    this.db.purchases[idempotencyKey] = rec;
    this.store.save();                                    // the signature is on disk before the bytes leave
    let result;
    try {
      result = this.chain.send(tx);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      rec.state = 'failed'; rec.code = e.code; rec.message = e.message; this.store.save();
      return { ...rec, replayed: false };
    }
    if (this.loseAnswer) { this.loseAnswer = false; throw new Error('simulated: the answer to the send was lost'); }
    const r = result.results?.[0] ?? result; // a one-instruction transaction answers with its instruction's result
    rec.state = 'landed'; rec.gen = r.gen; rec.price = r.price; rec.fee = r.fee; rec.slot = result.slot; this.store.save();
    await this.registry.ingest({ kind: 'transfer', assetId, signature, slot: result.slot, from: r.from, to: r.to });
    return { ...rec, replayed: false };
  }

  /** Resolve a purchase whose answer was lost: ask the chain about the recorded signature. Never resends. */
  async recover(idempotencyKey) {
    const rec = this.db.purchases[idempotencyKey];
    if (!rec) refuse(ERR.BAD_REQUEST, 'unknown purchase');
    if (rec.state !== 'sent') return { ...rec, replayed: true };
    const st = this.chain.transaction(rec.signature);
    if (!st) refuse(ERR.MINT_UNKNOWN, 'the purchase was sent and its outcome is not known yet; not resent', { signature: rec.signature });
    if (st.result === 'ok') {
      const ev = this.chain.events.find(e => e.signature === rec.signature && e.kind === 'transfer');
      rec.state = 'landed'; rec.gen = ev?.gen ?? null; rec.price = ev?.price ?? null; rec.fee = ev?.fee ?? null; rec.slot = st.slot; rec.recovered = true;
      this.store.save();
      if (ev) await this.registry.ingest({ kind: 'transfer', assetId: rec.assetId, signature: rec.signature, slot: st.slot, from: ev.from, to: ev.to });
    } else {
      rec.state = 'failed'; rec.code = st.result; rec.recovered = true; this.store.save();
    }
    return { ...rec, replayed: true };
  }
}

