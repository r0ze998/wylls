// The resident registry: the off-chain projection of "which asset is which
// resident, who holds it now, and how many times the holder changed". It is
// what the waitlist, the login and every operation-time check read.
//
// Rules (the contract's §3):
// * A resident record is created the first time the asset is **seen on
//   chain** as a valid asset of the collection (verifyResidentAsset), never
//   from a notification, a payment or a front-end claim. Publishing the
//   world and transferring the asset never create or replace the record.
// * The holder is whatever the chain reader returns. A notification
//   (indexer webhook, our own send) only says "look again"; an event that
//   the chain does not confirm stays `unconfirmed` and changes nothing.
// * `epoch` counts confirmed holder changes of one resident. Credentials are
//   issued under an epoch; a later epoch refuses them, also when the same
//   wallet buys the asset back (same resident data, new epoch).
// * A read older than the last confirmed change (`slot < holderSince.slot`)
//   or older than what the caller requires (`minSlot`) is `StaleRead`: it is
//   never used to grant anything. An unreachable reader is `ChainUnavailable`.
// * Duplicate notifications (same signature) are ignored; replay from the
//   last processed sequence after a restart is idempotent.
import { ERR, Refusal, refuse } from './errors.mjs';
import { verifyResidentAsset } from './core-asset.mjs';
import { residentIdOf } from './ids.mjs';

export class ResidentRegistry {
  /**
   * @param {object} o
   * @param {{state, save()}} o.store
   * @param {{program: string, collection: string}} o.expected  the only program and collection that count
   * @param {{getAccount(address): Promise<{slot, account}>, latestSlot(): Promise<number>}} o.reader
   * @param {() => number} [o.now]
   */
  constructor({ store, expected, reader, now = Date.now }) {
    if (!expected?.collection) throw new TypeError('the registry needs the expected collection address');
    this.store = store;
    this.expected = { program: expected.program, collection: expected.collection };
    this.reader = reader;
    this.now = now;
    /** Called with the record after a confirmed holder change (the auth module revokes the old epoch's credentials). */
    this.onHolderChange = [];
    this.store.state ??= {};
    this.store.state.registry ??= { residents: {}, byResidentId: {}, processed: {}, pending: {}, lastSeq: 0, published: false, publishedAt: null, expected: this.expected };
    const e = this.db.expected;
    if (e.collection !== this.expected.collection || e.program !== this.expected.program) {
      throw new Error(`this state file belongs to another collection (${e.collection}); refusing to mix residents`);
    }
  }

  get db() { return this.store.state.registry; }
  save() { this.store.save(); }

  // ------------------------------------------------------------ reads

  resident(assetId) { return this.db.residents[assetId] ?? null; }
  byResidentId(residentId) { const a = this.db.byResidentId[residentId]; return a ? this.resident(a) : null; }
  residents() { return Object.values(this.db.residents); }
  get published() { return this.db.published; }

  /**
   * Read the asset now and reconcile the record with what the chain says.
   * `minSlot`: the read must be at least this fresh. Returns the record (with
   * `holder`, `epoch`, `readSlot`) or throws StaleRead / ChainUnavailable /
   * a verifier refusal (NoAccount, WrongProgram, NotAnAsset, NotInCollection).
   */
  async observe(assetId, { minSlot = 0 } = {}) {
    let r;
    try {
      r = await this.reader.getAccount(assetId);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      refuse(ERR.CHAIN_UNAVAILABLE, `chain read failed: ${e.message}`);
    }
    const existing = this.resident(assetId);
    const floor = Math.max(minSlot, existing?.holderSince?.slot ?? 0);
    if (r.slot < floor) refuse(ERR.STALE_READ, `the chain read (slot ${r.slot}) is older than required (slot ${floor})`, { readSlot: r.slot, minSlot: floor });
    const v = verifyResidentAsset({ account: r.account ? { ...r.account, address: assetId } : null, expected: this.expected });
    if (!v.ok) {
      // An asset that was ours and is gone (burnt) is kept, marked, and refuses everything: never silently re-created.
      if (existing && v.code === ERR.NO_ACCOUNT) { existing.gone = { slot: r.slot, at: this.now() }; this.save(); }
      refuse(v.code, `not a resident asset of this collection: ${v.code}`, { assetId, detail: v.detail ?? null });
    }
    return this.#reconcile(assetId, v, r.slot);
  }

  #reconcile(assetId, v, slot) {
    let rec = this.resident(assetId);
    if (!rec) {
      const residentId = residentIdOf(assetId);
      const taken = this.db.byResidentId[residentId];
      if (taken && taken !== assetId) refuse(ERR.RESIDENT_ID_COLLISION, 'two assets derive the same resident id; refusing to merge', { residentId, assets: [taken, assetId] });
      rec = { residentId, assetId, holder: v.holder, holderSince: { slot, signature: null }, epoch: 0, firstSeen: { slot, at: this.now() }, display: { name: v.asset.name, uri: v.asset.uri }, frozen: v.frozen, gone: null };
      this.db.residents[assetId] = rec;
      this.db.byResidentId[residentId] = assetId;
      this.save();
      return { ...rec, readSlot: slot, changed: 'created' };
    }
    let changed = null;
    if (rec.holder !== v.holder) {
      rec.holder = v.holder;
      rec.holderSince = { slot, signature: rec.pendingSignature ?? null };
      rec.epoch += 1;
      changed = 'holder';
    }
    if (rec.frozen !== v.frozen) { rec.frozen = v.frozen; changed ??= 'frozen'; }
    rec.display = { name: v.asset.name, uri: v.asset.uri };
    rec.gone = null;
    delete rec.pendingSignature;
    if (changed) this.save();
    if (changed === 'holder') for (const fn of this.onHolderChange) fn({ ...rec, readSlot: slot });
    return { ...rec, readSlot: slot, changed };
  }

  /**
   * The holder at operation time, read fresh: `{holder, epoch, readSlot, frozen}`.
   * Throws StaleRead when the reader has not reached `minSlot` or the last
   * confirmed change, ChainUnavailable when it cannot be read: callers
   * refuse the operation in both cases (fail closed).
   */
  async holderNow(assetId, { minSlot = 0 } = {}) {
    const rec = await this.observe(assetId, { minSlot });
    return { holder: rec.holder, epoch: rec.epoch, readSlot: rec.readSlot, frozen: rec.frozen, residentId: rec.residentId };
  }

  // ------------------------------------------------------------ notifications

  /**
   * Ingest one chain event (an indexer's webhook, our own send's receipt).
   * Idempotent by signature. The event is only a prompt to read the chain:
   * `mint` and `transfer` events trigger `observe(assetId)`; when the read
   * cannot confirm them yet (lagging reader) they are kept in `pending` and
   * retried by `reconcile()`. Returns `{applied: 'confirmed'|'duplicate'|'unconfirmed'|'ignored', ...}`.
   */
  async ingest(event) {
    const sig = event?.signature;
    if (typeof sig !== 'string' || !sig) return { applied: 'ignored', reason: 'no signature' };
    if (this.db.processed[sig]) return { applied: 'duplicate', signature: sig };
    if (!['mint', 'transfer'].includes(event.kind) || typeof event.assetId !== 'string') {
      this.db.processed[sig] = { at: this.now(), kind: event.kind ?? null, ignored: true };
      if (Number.isInteger(event.seq) && event.seq > this.db.lastSeq) this.db.lastSeq = event.seq;
      this.save();
      return { applied: 'ignored', signature: sig };
    }
    const rec = this.resident(event.assetId);
    if (rec) rec.pendingSignature = sig;
    try {
      const after = await this.observe(event.assetId, { minSlot: Number.isInteger(event.slot) ? event.slot : 0 });
      this.db.processed[sig] = { at: this.now(), kind: event.kind, slot: after.readSlot };
      delete this.db.pending[sig];
      if (Number.isInteger(event.seq) && event.seq > this.db.lastSeq) this.db.lastSeq = event.seq;
      this.save();
      return { applied: 'confirmed', signature: sig, holder: after.holder, epoch: after.epoch, changed: after.changed };
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      if (rec) delete rec.pendingSignature;
      if ([ERR.STALE_READ, ERR.CHAIN_UNAVAILABLE].includes(e.code)) {
        this.db.pending[sig] = { event, lastTry: this.now(), reason: e.code };
        this.save();
        return { applied: 'unconfirmed', signature: sig, reason: e.code };
      }
      // A notification about something that is not a resident asset (a look-alike, a burnt asset): recorded, nothing changes.
      this.db.processed[sig] = { at: this.now(), kind: event.kind, refused: e.code };
      this.save();
      return { applied: 'ignored', signature: sig, reason: e.code };
    }
  }

  /** Retry every unconfirmed notification; returns what each became. */
  async reconcile() {
    const out = [];
    for (const [sig, p] of Object.entries({ ...this.db.pending })) {
      delete this.db.pending[sig];
      out.push(await this.ingest(p.event));
    }
    return out;
  }

  /** Replay events from a source `{eventsSince(seq)}` after the last processed sequence (restart). */
  async replay(source) {
    const out = [];
    for (const e of source.eventsSince(this.db.lastSeq)) out.push(await this.ingest(e));
    return out;
  }

  // ------------------------------------------------------------ waitlist and publishing

  /**
   * The waitlist as a pure projection of holdings: one row per resident asset,
   * `status` 'eligible' (seen on chain) or 'unconfirmed' (a notification the
   * chain has not confirmed; never counted as eligible). No row exists for a
   * payment, a front-end claim or a look-alike.
   */
  waitlist() {
    const rows = this.residents().filter(r => !r.gone).map(r => ({ residentId: r.residentId, assetId: r.assetId, holder: r.holder, epoch: r.epoch, since: r.holderSince.slot, status: 'eligible' }));
    for (const p of Object.values(this.db.pending)) {
      if (!this.db.residents[p.event.assetId]) rows.push({ residentId: null, assetId: p.event.assetId, holder: null, epoch: null, since: null, status: 'unconfirmed', reason: p.reason });
    }
    return rows.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || String(a.assetId).localeCompare(String(b.assetId)));
  }

  /** What a wallet is entitled to right now: its residents (eligible) and the world's state. */
  entitlement(wallet) {
    const mine = this.residents().filter(r => !r.gone && r.holder === wallet).map(r => ({ residentId: r.residentId, assetId: r.assetId, epoch: r.epoch }));
    return { wallet, published: this.db.published, residents: mine, canLogin: this.db.published && mine.length > 0, onWaitlist: !this.db.published && mine.length > 0 };
  }

  /**
   * The test publish switch: flips one flag. It touches no resident, no
   * holder, no epoch and no world data (asserted: the record count and every
   * record are the same before and after).
   */
  publish() {
    const before = JSON.stringify(this.db.residents);
    this.db.published = true;
    this.db.publishedAt = this.now();
    if (JSON.stringify(this.db.residents) !== before) throw new Error('publish changed resident records');
    this.save();
    return { published: true, residents: this.residents().length };
  }
}
