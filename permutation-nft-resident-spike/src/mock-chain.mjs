// A mock Solana-like chain for the spike. It holds Core-shaped asset and
// collection accounts (encoded with core-asset.mjs, so the verifier reads
// real bytes), executes signed "transactions" in arrival order, keeps every
// account's history by slot (so a lagging reader can be simulated), and
// hosts the mock **resident program**: the part the game program would own
// in the real design (session keys set by the holder, player operations
// whose prologue checks the asset's current owner at execution time).
//
// The **transfer guard** (option D of CONTRACT §10): a guarded asset is
// minted with Core's Permanent Freeze Delegate (frozen for good) and
// Permanent Transfer Delegate (the resident program), both of which can only
// be added at creation and are never revoked (metaplex.com/docs/core/plugins/
// permanent-*-delegate). The owner's plain Core transfer is then refused
// (frozen); the only transfer path is the program's `transferResident`,
// which the current owner signs and which, in the same transaction, bumps
// the Citizen's holder generation (`gen`) and clears the session key. An
// unguarded asset shows the hole: a plain transfer bypasses the program.
//
// Boundary: everything here is a stand-in. Program ids are the real ones
// so the verifier's checks are the real checks; signatures are real
// ed25519; slots, fees, rent, Core plugins (modelled as account flags), CPI
// and the RPC are simplified.
import { base58, fromBase58, isPubkey, keypair, randomAddress, sha256, utf8, verifySignature } from './crypto.mjs';
import { encodeAssetV1, encodeCollectionV1, MPL_CORE_PROGRAM } from './core-asset.mjs';
import { ERR, Refusal, refuse } from './errors.mjs';
import { residentIdOf } from './ids.mjs';

/** The mock resident program's id (a stand-in for the Frontier program). */
export const RESIDENT_PROGRAM = 'ResidentProgram111111111111111111111111111';
/** The resident program's account for an asset (a stand-in for the Citizen at its derived address). */
export const residentAccountOf = assetId => base58(sha256('wylls-mock-resident', assetId));
/** Decode the mock resident account (`{gen, session}`); null for no account. */
export const decodeResident = account => (account ? JSON.parse(Buffer.from(account.data).toString('utf8')) : null);

/** How many slots a signed transaction stays valid (a blockhash lifetime). */
export const TX_LIFETIME_SLOTS = 150;
export const MAX_SESSION_SECS = 30 * 86_400;

const clone = v => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? { $u8: Buffer.from(x).toString('base64') } : x)),
  (_, x) => (x && typeof x === 'object' && typeof x.$u8 === 'string' ? new Uint8Array(Buffer.from(x.$u8, 'base64')) : x));

/** Canonical bytes of a transaction message (what signers sign). */
export function messageBytes(message) {
  const canon = v => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
  return utf8(`wylls-mock-tx-v1\n${canon(message)}`);
}

/** Sign `message` with `keypairs` (each must be in message.signers). Returns the wire object. */
export function signTx(message, keypairs) {
  const bytes = messageBytes(message);
  const signatures = {};
  for (const kp of keypairs) {
    if (!message.signers.includes(kp.publicKey)) throw new Error(`${kp.publicKey} is not a signer of this message`);
    signatures[kp.publicKey] = Buffer.from(kp.sign(bytes)).toString('base64');
  }
  return { message, signatures };
}

/** A transaction id: the first signer's signature, base58 (as Solana). */
export const signatureOf = tx => {
  const first = tx.message.signers[0];
  const s = tx.signatures[first];
  return s ? base58(Buffer.from(s, 'base64')) : null;
};

export class MockChain {
  constructor({ coreProgram = MPL_CORE_PROGRAM, residentProgram = RESIDENT_PROGRAM, now = () => 1_800_000_000 } = {}) {
    this.coreProgram = coreProgram;
    this.residentProgram = residentProgram;
    this.slot = 1;
    this.now = now;
    /** address → {address, owner, data, lamports, flags} */
    this.accounts = new Map();
    /** address → [{slot, account|null}] (newest last) */
    this.history = new Map();
    /** base58 signature → {slot, result} */
    this.processed = new Map();
    /** [{seq, slot, signature, kind, ...}] */
    this.events = [];
    /** The resident program's state lives in mock accounts (`residentAccountOf`), so readers see it by slot. */
    /** The world the resident program drives (set by `attachWorld`). */
    this.world = null;
    this.collectionAuthorities = new Map();
    /** Mock token program: `${mint}:${owner}` → bigint balance (test units, no value). */
    this.tokens = new Map();
    /** Resident listings on the dedicated sale path: assetId → {seller, price, mint, gen, slot}. */
    this.listings = new Map();
    /** Sale fee destination and basis points (TEST VALUES; not a product figure). */
    this.operator = 'Operator11111111111111111111111111111111111';
    this.saleFeeBps = 250;
    /** Failure injection for the atomicity tests: a label the instruction throws at after its payment leg. */
    this.failInside = null;
  }

  // ------------------------------------------------------------ mock token program

  /** Test helper: mint `amount` test tokens of `mint` to `owner` (no authority modelled; the faucet). */
  mintTokens(mint, owner, amount) { this.tokens.set(`${mint}:${owner}`, this.balance(mint, owner) + BigInt(amount)); }
  balance(mint, owner) { return this.tokens.get(`${mint}:${owner}`) ?? 0n; }
  #debit(mint, owner, amount) {
    const have = this.balance(mint, owner);
    if (have < amount) refuse(ERR.INSUFFICIENT_FUNDS, 'token transfer: insufficient funds', { have: String(have), need: String(amount) });
    this.tokens.set(`${mint}:${owner}`, have - amount);
  }
  #credit(mint, owner, amount) { this.tokens.set(`${mint}:${owner}`, this.balance(mint, owner) + amount); }

  /** Instruction: a plain token transfer signed by `from`. */
  ixTokenTransfer({ mint, from, to, amount }) { return { kind: 'tokenTransfer', mint, from, to, amount: String(amount), signers: [from] }; }
  /** Instruction: list a guarded resident asset for sale on the dedicated path (the holder signs). */
  ixList({ assetId, seller, price, mint }) { return { kind: 'list', assetId, seller, price: String(price), mint, signers: [seller] }; }
  ixCancelList({ assetId, seller }) { return { kind: 'cancelList', assetId, seller, signers: [seller] }; }
  /**
   * Instruction: buy a listed resident. ONE instruction does the payment
   * (buyer → seller and operator fee), the asset transfer (as permanent
   * transfer delegate), the generation bump and the session clear, so none
   * of them can exist without the others.
   */
  ixBuy({ assetId, buyer, maxPrice = null }) { return { kind: 'buy', assetId, buyer, maxPrice: maxPrice === null ? null : String(maxPrice), signers: [buyer] }; }
  /** Instruction: the owner approves an owner-managed Transfer Delegate (Core: revoked after any transfer; cannot move a frozen asset). */
  ixApproveTransferDelegate({ assetId, owner, delegate }) { return { kind: 'approveTransferDelegate', assetId, owner, delegate, signers: [owner] }; }
  /** Instruction: a Transfer Delegate moves the asset. */
  ixTransferByDelegate({ assetId, delegate, to }) { return { kind: 'transferByDelegate', assetId, delegate, to, signers: [delegate] }; }
  /** Instruction: thaw. `permanent: true` targets the Permanent Freeze Delegate (its authority is the program; no key can sign for it). */
  ixThaw({ assetId, by, permanent = false }) { return { kind: 'thaw', assetId, by, permanent, signers: [by] }; }

  /** A message of several instructions, executed atomically (all or nothing), as a Solana transaction. */
  buildTx(instructions, { validUntilSlot = this.slot + TX_LIFETIME_SLOTS } = {}) {
    const signers = [...new Set(instructions.flatMap(i => i.signers))];
    return { kind: 'tx', instructions, signers, validUntilSlot, nonce: randomAddress() };
  }

  // ------------------------------------------------------------ clock

  tick(n = 1) { this.slot += n; return this.slot; }

  // ------------------------------------------------------------ accounts

  #write(address, account) {
    const rec = account ? { address, ...account } : null;
    if (rec) this.accounts.set(address, rec); else this.accounts.delete(address);
    const h = this.history.get(address) ?? [];
    h.push({ slot: this.slot, account: rec ? clone(rec) : null });
    this.history.set(address, h);
  }

  /** The account as of `slot` (the latest write at or before it), or null. */
  readAt(address, slot) {
    const h = this.history.get(address);
    if (!h) return null;
    let found = null;
    for (const e of h) { if (e.slot <= slot) found = e.account; else break; }
    return found ? clone(found) : null;
  }

  /** A chain reader: `{getAccount(address) → {slot, account}, latestSlot()}`, optionally lagging or failing. */
  reader({ lagSlots = 0, fail = () => false } = {}) {
    const chain = this;
    return {
      kind: 'mock',
      async latestSlot() { if (fail('slot')) refuse(ERR.CHAIN_UNAVAILABLE, 'mock RPC: unavailable'); return Math.max(1, chain.slot - lagSlots); },
      async getAccount(address) {
        if (fail(address)) refuse(ERR.CHAIN_UNAVAILABLE, 'mock RPC: unavailable');
        const slot = Math.max(1, chain.slot - lagSlots);
        return { slot, account: chain.readAt(address, slot) };
      },
    };
  }

  // ------------------------------------------------------------ Core: collections and assets

  /** A collection whose update authority is `authority` (a keypair the operator holds). */
  createCollection({ authority, name = 'Wylls Residents (test)', uri = 'local://collection' }) {
    const address = randomAddress();
    this.#write(address, { owner: this.coreProgram, data: encodeCollectionV1({ updateAuthority: authority.publicKey, name, uri }), lamports: 1_000_000, flags: {} });
    this.collectionAuthorities.set(address, authority.publicKey);
    this.#event({ kind: 'collection', collection: address, signature: `col-${address.slice(0, 8)}` });
    return address;
  }

  /**
   * Mint an asset into `collection` for `to`. Core requires the collection's
   * authority to sign a mint into a collection: `authority` must be it.
   * `memo` (an intent id) is recorded in the event so an unknown-outcome mint
   * can be found again (the entry desk's recovery path).
   */
  mint({ collection, to, authority, name = 'Wylls Resident', uri = 'local://asset', memo = null, assetKeypair = keypair(), guard = true }) {
    if (this.collectionAuthorities.get(collection) !== authority.publicKey) refuse(ERR.AUTH, 'mint: not the collection authority');
    const assetId = assetKeypair.publicKey;
    if (this.accounts.has(assetId)) refuse(ERR.ALREADY_PROCESSED, 'mint: asset exists');
    // `guard`: Permanent Freeze Delegate (frozen for good) + Permanent Transfer Delegate = the resident program; creation only.
    const flags = guard ? { frozen: false, permanentFrozen: true, permanentTransferDelegate: this.residentProgram } : { frozen: false };
    this.#write(assetId, { owner: this.coreProgram, data: encodeAssetV1({ owner: to, updateAuthority: { type: 'Collection', address: collection }, name, uri }), lamports: 2_000_000, flags });
    const signature = base58(sha256('mint', assetId, String(this.slot)));
    this.processed.set(signature, { slot: this.slot, result: 'ok' });
    this.#event({ kind: 'mint', assetId, collection, to, memo, signature });
    return { assetId, signature, slot: this.slot };
  }

  /** Look-alikes for the tests: same strings, wrong provenance. */
  mintLookalike({ kind, collection, to, name = 'Wylls Resident', uri = 'local://asset' }) {
    const assetId = randomAddress();
    if (kind === 'other-program') {
      this.#write(assetId, { owner: 'Fake1111111111111111111111111111111111111111', data: encodeAssetV1({ owner: to, updateAuthority: { type: 'Collection', address: collection }, name, uri }), lamports: 1, flags: {} });
    } else if (kind === 'other-collection') {
      const other = this.createCollection({ authority: keypair(), name: 'Wylls Residents (test)', uri: 'local://collection' });
      this.#write(assetId, { owner: this.coreProgram, data: encodeAssetV1({ owner: to, updateAuthority: { type: 'Collection', address: other }, name, uri }), lamports: 1, flags: {} });
    } else if (kind === 'no-collection') {
      this.#write(assetId, { owner: this.coreProgram, data: encodeAssetV1({ owner: to, updateAuthority: { type: 'Address', address: to }, name, uri }), lamports: 1, flags: {} });
    } else if (kind === 'collection-account') {
      return collection; // a CollectionV1 account passed off as an asset
    } else if (kind === 'garbage') {
      this.#write(assetId, { owner: this.coreProgram, data: new Uint8Array([1, 2, 3]), lamports: 1, flags: {} });
    } else {
      throw new Error(`lookalike kind ${kind}`);
    }
    return assetId;
  }

  /** The asset's current owner (base58) or null. */
  ownerOf(assetId) {
    const a = this.accounts.get(assetId);
    return a && a.owner === this.coreProgram ? base58(a.data.subarray(1, 33)) : null;
  }

  setFrozen(assetId, frozen) {
    const a = this.accounts.get(assetId);
    if (!a) refuse(ERR.NO_ACCOUNT);
    this.#write(assetId, { ...a, flags: { ...a.flags, frozen } });
  }

  // ------------------------------------------------------------ transactions

  /** Message for a Core transfer: the owner (or a transfer delegate, not modelled) signs. */
  buildTransfer({ assetId, from, to, validUntilSlot = this.slot + TX_LIFETIME_SLOTS }) {
    return { kind: 'transfer', assetId, from, to, signers: [from], validUntilSlot, nonce: randomAddress() };
  }

  /** Message for the resident program's TransferResident: the current holder signs; the program moves the asset as permanent transfer delegate and bumps the generation. */
  buildTransferResident({ assetId, from, to, validUntilSlot = this.slot + TX_LIFETIME_SLOTS }) {
    return { kind: 'transferResident', assetId, from, to, signers: [from], validUntilSlot, nonce: randomAddress() };
  }

  /** Message for the resident program's SetSession: the current holder signs. */
  buildSetSession({ assetId, holder, session, expiry, validUntilSlot = this.slot + TX_LIFETIME_SLOTS }) {
    return { kind: 'setSession', assetId, actor: holder, session, expiry, signers: [holder], validUntilSlot, nonce: randomAddress() };
  }

  /**
   * Message for a player operation on a resident: `actor` is the holder or
   * its session key. `gen` is the holder generation the client built it
   * against (read from the resident account); the prologue refuses a stale
   * one, so an operation signed before a transfer cannot land after it, even
   * for the same wallet after a buy-back.
   */
  buildOp({ assetId, actor, op, gen = this.residentOf(assetId).gen, validUntilSlot = this.slot + TX_LIFETIME_SLOTS }) {
    return { kind: 'op', assetId, actor, op, gen, signers: [actor], validUntilSlot, nonce: randomAddress() };
  }

  /** The resident program's state for an asset: `{gen, session}` (gen 0, no session before the first instruction). */
  residentOf(assetId) { return decodeResident(this.accounts.get(residentAccountOf(assetId))) ?? { gen: 0, session: null }; }
  #writeResident(assetId, st) { this.#write(residentAccountOf(assetId), { owner: this.residentProgram, data: new Uint8Array(Buffer.from(JSON.stringify(st))), lamports: 1_000_000, flags: {} }); }

  /**
   * Execute a signed transaction now (this slot). Checks, in order: replay
   * (`AlreadyProcessed`), lifetime (`BlockhashExpired`), every signer's
   * signature (`BadSignature`), then the instruction. Records the result
   * under the signature either way (a failed transaction is still a
   * processed one, as on chain).
   */
  send(tx) {
    const signature = signatureOf(tx);
    if (!signature) refuse(ERR.BAD_SIGNATURE, 'the first signer did not sign');
    if (this.processed.has(signature)) refuse(ERR.ALREADY_PROCESSED, 'this transaction was processed already', { signature, ...this.processed.get(signature) });
    const m = tx.message;
    if (this.slot > m.validUntilSlot) refuse(ERR.BLOCKHASH_EXPIRED, 'the transaction outlived its blockhash', { signature });
    const bytes = messageBytes(m);
    for (const s of m.signers) {
      const sig = tx.signatures[s] ? Buffer.from(tx.signatures[s], 'base64') : null;
      if (!sig || !verifySignature(bytes, sig, s)) refuse(ERR.BAD_SIGNATURE, `missing or invalid signature of ${s}`, { signature });
    }
    // All or nothing: every write of the transaction is undone when any instruction fails (as on chain).
    const snap = this.#snapshot();
    try {
      const results = (m.kind === 'tx' ? m.instructions : [m]).map(ix => this.#execute(ix, signature));
      const result = m.kind === 'tx' ? { results } : results[0];
      this.processed.set(signature, { slot: this.slot, result: 'ok' });
      return { ok: true, signature, slot: this.slot, ...result };
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      this.#restore(snap);
      this.processed.set(signature, { slot: this.slot, result: e.code });
      this.#event({ kind: 'failed', signature, reason: e.code, assetId: m.assetId ?? m.instructions?.[0]?.assetId ?? null, txKind: m.kind });
      throw new Refusal(e.code, e.message, { ...e.extra, signature, slot: this.slot });
    }
  }

  #snapshot() {
    return {
      accounts: new Map([...this.accounts].map(([k, v]) => [k, clone(v)])),
      historyLen: new Map([...this.history].map(([k, v]) => [k, v.length])),
      tokens: new Map(this.tokens),
      listings: new Map([...this.listings].map(([k, v]) => [k, { ...v }])),
      events: this.events.length,
      world: this.world ? JSON.stringify(this.world.db) : null,
    };
  }
  #restore(snap) {
    this.accounts = snap.accounts;
    for (const [k, h] of this.history) { const n = snap.historyLen.get(k); if (n === undefined) this.history.delete(k); else h.length = n; }
    this.tokens = snap.tokens;
    this.listings = snap.listings;
    this.events.length = snap.events;
    if (this.world && snap.world !== null) Object.assign(this.world.db, JSON.parse(snap.world));
  }

  #execute(m, signature) {
    switch (m.kind) {
      case 'transfer': return this.#transfer(m, signature);
      case 'transferResident': return this.#transferResident(m, signature);
      case 'setSession': return this.#setSession(m, signature);
      case 'op': return this.#op(m, signature);
      case 'tokenTransfer': { this.#debit(m.mint, m.from, BigInt(m.amount)); this.#credit(m.mint, m.to, BigInt(m.amount)); return { moved: m.amount }; }
      case 'list': return this.#list(m, signature);
      case 'cancelList': return this.#cancelList(m, signature);
      case 'buy': return this.#buy(m, signature);
      case 'approveTransferDelegate': return this.#approveDelegate(m);
      case 'transferByDelegate': return this.#transferByDelegate(m, signature);
      case 'thaw': return this.#thaw(m);
      default: refuse(ERR.BAD_DATA, `unknown instruction ${m.kind}`);
    }
  }

  #transfer(m, signature) {
    const a = this.accounts.get(m.assetId);
    if (!a || a.owner !== this.coreProgram) refuse(ERR.NO_ACCOUNT, 'transfer: no such asset');
    const owner = base58(a.data.subarray(1, 33));
    if (owner !== m.from) refuse(ERR.NOT_OWNER, 'transfer: the signer is not the current owner', { owner });
    if (a.flags.frozen || a.flags.permanentFrozen) refuse(ERR.FROZEN, a.flags.permanentFrozen ? 'transfer: the asset is permanently frozen; only its permanent transfer delegate (the resident program) moves it' : 'transfer: the asset is frozen');
    this.#move(m.assetId, a, m.to);
    this.#event({ kind: 'transfer', assetId: m.assetId, from: m.from, to: m.to, signature, via: 'core' });
    return { from: m.from, to: m.to };
  }

  #move(assetId, a, to) {
    if (!isPubkey(to)) refuse(ERR.BAD_DATA, 'transfer: bad recipient');
    const data = new Uint8Array(a.data);
    data.set(Buffer.from(require58(to)), 1);
    this.#write(assetId, { ...a, data });
  }

  /**
   * TransferResident (the resident program): the current owner signs; the
   * program, as the asset's permanent transfer delegate, moves it with
   * forceApprove (works while permanently frozen), and in the same
   * transaction bumps `gen` and clears the session. A plain transfer cannot
   * do this, so every change of hands of a guarded asset passes here.
   */
  #transferResident(m, signature) {
    const a = this.accounts.get(m.assetId);
    if (!a || a.owner !== this.coreProgram) refuse(ERR.NO_ACCOUNT, 'TransferResident: no such asset');
    const owner = base58(a.data.subarray(1, 33));
    if (owner !== m.from) refuse(ERR.NOT_OWNER, 'TransferResident: the signer is not the current owner', { owner });
    const gen = this.#programMove(m.assetId, a, m.to);
    this.listings.delete(m.assetId); // a gift after listing: the listing is gone (and would be stale by generation anyway)
    this.#event({ kind: 'transfer', assetId: m.assetId, from: m.from, to: m.to, signature, via: 'program', gen });
    return { from: m.from, to: m.to, gen };
  }

  /**
   * The resident program's prologue: `actor` is the asset's current owner,
   * or a session key the current owner set **in the current generation**,
   * unexpired; and the operation was built against the current generation
   * (`gen`). Order: owner/session (`NotOwner`), then generation (`StaleGen`).
   */
  prologue(assetId, actor, gen = null) {
    const owner = this.ownerOf(assetId);
    if (!owner) refuse(ERR.NO_ACCOUNT, 'prologue: no such asset');
    const st = this.residentOf(assetId);
    let bySession = false;
    if (actor !== owner) {
      const s = st.session;
      if (!(s && s.key === actor && s.setBy === owner && s.gen === st.gen && s.expiry > this.now())) {
        refuse(ERR.NOT_OWNER, 'prologue: the actor is neither the current holder nor a session key the current holder set in this generation', { owner, actor, session: s, gen: st.gen });
      }
      bySession = true;
    }
    if (gen !== null && gen !== st.gen) refuse(ERR.STALE_GEN, 'prologue: the operation was built against an earlier holder generation', { gen, current: st.gen });
    return { owner, bySession, gen: st.gen };
  }

  /** The asset's current owner change as the program does it (permanent transfer delegate, forceApprove): owner, gen + 1, session cleared. */
  #programMove(assetId, a, to) {
    if (a.flags.permanentTransferDelegate !== this.residentProgram) refuse(ERR.AUTH, 'the program is not this asset\'s permanent transfer delegate (unguarded asset)');
    if (a.flags.frozen) refuse(ERR.FROZEN, 'the owner-managed freeze is on');
    this.#move(assetId, a, to);
    const st = this.residentOf(assetId);
    const gen = st.gen + 1;
    this.#writeResident(assetId, { gen, session: null });
    // Core revokes owner-managed delegates on any transfer.
    const after = this.accounts.get(assetId);
    if (after.flags.transferDelegate) this.#write(assetId, { ...after, flags: { ...after.flags, transferDelegate: null } });
    return gen;
  }

  #list(m, signature) {
    const a = this.accounts.get(m.assetId);
    if (!a || a.owner !== this.coreProgram) refuse(ERR.NO_ACCOUNT, 'List: no such asset');
    if (base58(a.data.subarray(1, 33)) !== m.seller) refuse(ERR.NOT_OWNER, 'List: only the holder lists');
    if (a.flags.permanentTransferDelegate !== this.residentProgram) refuse(ERR.AUTH, 'List: unguarded asset; the dedicated path cannot move it');
    if (!(BigInt(m.price) > 0n)) refuse(ERR.BAD_DATA, 'List: price');
    const st = this.residentOf(m.assetId);
    this.listings.set(m.assetId, { seller: m.seller, price: m.price, mint: m.mint, gen: st.gen, slot: this.slot });
    this.#event({ kind: 'listed', assetId: m.assetId, seller: m.seller, price: m.price, mint: m.mint, gen: st.gen, signature });
    return { listed: true, gen: st.gen };
  }

  #cancelList(m, signature) {
    const l = this.listings.get(m.assetId);
    if (!l) refuse(ERR.NO_LISTING, 'CancelList: not listed');
    if (l.seller !== m.seller) refuse(ERR.NOT_OWNER, 'CancelList: not the seller');
    this.listings.delete(m.assetId);
    this.#event({ kind: 'unlisted', assetId: m.assetId, signature });
    return { listed: false };
  }

  /**
   * Buy: payment, transfer, generation bump and session clear in ONE
   * instruction. Checks: a listing exists (`NoListing`), its seller is still
   * the owner and its generation is current (`ListingStale`: a gift or an
   * earlier sale since listing), the price fits `maxPrice`, the buyer can
   * pay (`InsufficientFunds`). Then: buyer −price, seller +price−fee,
   * operator +fee, asset → buyer, gen + 1, session = null, listing removed.
   * `failInside = 'afterPayment'` throws between the legs (tests): the
   * transaction's rollback must leave no payment behind.
   */
  #buy(m, signature) {
    const l = this.listings.get(m.assetId);
    if (!l) refuse(ERR.NO_LISTING, 'Buy: this resident is not listed');
    const a = this.accounts.get(m.assetId);
    const owner = a ? base58(a.data.subarray(1, 33)) : null;
    const st = this.residentOf(m.assetId);
    if (!a || owner !== l.seller || st.gen !== l.gen) refuse(ERR.LISTING_STALE, 'Buy: the listing is stale (the holder or the generation changed since it was made)', { owner, listing: l, gen: st.gen });
    if (m.buyer === l.seller) refuse(ERR.BAD_DATA, 'Buy: the seller cannot buy its own listing');
    const price = BigInt(l.price);
    if (m.maxPrice !== null && price > BigInt(m.maxPrice)) refuse(ERR.PRICE_CHANGED, 'Buy: the price is above the buyer\'s maximum', { price: l.price });
    const fee = (price * BigInt(this.saleFeeBps)) / 10_000n;
    this.#debit(l.mint, m.buyer, price);
    this.#credit(l.mint, l.seller, price - fee);
    this.#credit(l.mint, this.operator, fee);
    if (this.failInside === 'afterPayment') { this.failInside = null; refuse(ERR.BAD_DATA, 'Buy: injected failure after the payment leg'); }
    const gen = this.#programMove(m.assetId, a, m.buyer);
    this.listings.delete(m.assetId);
    this.#event({ kind: 'transfer', assetId: m.assetId, from: l.seller, to: m.buyer, signature, via: 'sale', gen, price: l.price, fee: String(fee) });
    return { from: l.seller, to: m.buyer, gen, price: l.price, fee: String(fee) };
  }

  #approveDelegate(m) {
    const a = this.accounts.get(m.assetId);
    if (!a || base58(a.data.subarray(1, 33)) !== m.owner) refuse(ERR.NOT_OWNER, 'ApproveTransferDelegate: only the owner');
    this.#write(m.assetId, { ...a, flags: { ...a.flags, transferDelegate: m.delegate } });
    return { delegate: m.delegate };
  }

  #transferByDelegate(m, signature) {
    const a = this.accounts.get(m.assetId);
    if (!a) refuse(ERR.NO_ACCOUNT, 'delegate transfer: no such asset');
    if (a.flags.transferDelegate !== m.delegate) refuse(ERR.AUTH, 'delegate transfer: not the asset\'s transfer delegate');
    // Core: "Frozen Assets cannot be transferred by delegates" (owner-managed delegates never force-approve).
    if (a.flags.frozen || a.flags.permanentFrozen) refuse(ERR.FROZEN, 'delegate transfer: the asset is frozen');
    this.#move(m.assetId, a, m.to);
    this.#write(m.assetId, { ...this.accounts.get(m.assetId), flags: { ...a.flags, transferDelegate: null } });
    this.#event({ kind: 'transfer', assetId: m.assetId, from: base58(a.data.subarray(1, 33)), to: m.to, signature, via: 'delegate' });
    return { to: m.to };
  }

  #thaw(m) {
    const a = this.accounts.get(m.assetId);
    if (!a) refuse(ERR.NO_ACCOUNT, 'thaw: no such asset');
    if (m.permanent) {
      // The Permanent Freeze Delegate's authority is the program; it is never revoked and no wallet, not the owner, not the collection authority, can sign for it.
      refuse(ERR.AUTH, 'thaw: the permanent freeze can only be lifted by its authority, the resident program, which exposes no instruction for it', { by: m.by });
    }
    const owner = base58(a.data.subarray(1, 33));
    if (m.by !== owner) refuse(ERR.AUTH, 'thaw: only the owner (or its freeze delegate) thaws the owner-managed freeze');
    this.#write(m.assetId, { ...a, flags: { ...a.flags, frozen: false } });
    return { frozen: false, permanentFrozen: a.flags.permanentFrozen === true };
  }

  #setSession(m, signature) {
    const owner = this.ownerOf(m.assetId);
    if (!owner) refuse(ERR.NO_ACCOUNT, 'SetSession: no such asset');
    if (m.actor !== owner) refuse(ERR.NOT_OWNER, 'SetSession: only the current holder sets the session key', { owner });
    if (m.session !== null && !isPubkey(m.session)) refuse(ERR.BAD_DATA, 'SetSession: bad key');
    if (m.expiry > this.now() + MAX_SESSION_SECS) refuse(ERR.BAD_DATA, 'SetSession: expiry too far');
    const st = this.residentOf(m.assetId);
    st.session = m.session === null ? null : { key: m.session, setBy: owner, gen: st.gen, expiry: m.expiry };
    this.#writeResident(m.assetId, st);
    this.#event({ kind: 'session', assetId: m.assetId, setBy: owner, session: m.session, gen: st.gen, signature });
    return { session: st.session };
  }

  #op(m, signature) {
    const pc = this.prologue(m.assetId, m.actor, m.gen ?? null);
    if (!this.world) refuse(ERR.BAD_DATA, 'no world attached');
    // The resident is the asset's, by derivation (as the Citizen address is derived from its seed): an operation naming another resident is refused.
    const residentId = residentIdOf(m.assetId);
    if (m.op?.residentId && m.op.residentId !== residentId) refuse(ERR.WRONG_RESIDENT, 'the operation names a resident that is not this asset\'s', { residentId, named: m.op.residentId });
    const out = this.world.applyFromProgram({ assetId: m.assetId, op: m.op, actor: m.actor, owner: pc.owner, slot: this.slot, signature, residentId });
    this.#event({ kind: 'op', assetId: m.assetId, actor: m.actor, op: m.op.name, signature });
    return { applied: out };
  }

  /** The session record the program holds for an asset (null if none). */
  sessionOf(assetId) { return this.residentOf(assetId).session; }

  attachWorld(world) { this.world = world; return this; }

  // ------------------------------------------------------------ events (what an indexer / webhook would deliver)

  #event(e) {
    const seq = this.events.length + 1;
    this.events.push({ seq, slot: this.slot, ...e });
  }

  eventsSince(seq = 0) { return this.events.filter(e => e.seq > seq).map(e => ({ ...e })); }

  /** getTransaction-like lookup: `{slot, result}` or null. */
  transaction(signature) { return this.processed.get(signature) ?? null; }
}

const require58 = s => { const b = Buffer.from(fromBase58(s)); if (b.length !== 32) throw new RangeError('key'); return b; };
