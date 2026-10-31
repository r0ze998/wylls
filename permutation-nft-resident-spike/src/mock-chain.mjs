// A mock Solana-like chain for the spike. It holds Core-shaped asset and
// collection accounts (encoded with core-asset.mjs, so the verifier reads
// real bytes), executes signed "transactions" in arrival order, keeps every
// account's history by slot (so a lagging reader can be simulated), and
// hosts the mock **resident program**: the part the game program would own
// in the real design (session keys set by the holder, player operations
// whose prologue checks the asset's current owner at execution time).
//
// Boundary: everything here is a stand-in. Program ids are the real ones
// so the verifier's checks are the real checks; signatures are real
// ed25519; slots, fees, rent, Core plugins, CPI and the RPC are simplified.
import { base58, fromBase58, isPubkey, keypair, randomAddress, sha256, utf8, verifySignature } from './crypto.mjs';
import { encodeAssetV1, encodeCollectionV1, MPL_CORE_PROGRAM } from './core-asset.mjs';
import { ERR, Refusal, refuse } from './errors.mjs';
import { residentIdOf } from './ids.mjs';

/** The mock resident program's id (a stand-in for the Frontier program). */
export const RESIDENT_PROGRAM = 'ResidentProgram111111111111111111111111111';
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
    /** The resident program's state: assetId → {session: {key, setBy, expiry}|null}; world ops go to `this.program` */
    this.residentState = new Map();
    /** The world the resident program drives (set by `attachWorld`). */
    this.world = null;
    this.collectionAuthorities = new Map();
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
  mint({ collection, to, authority, name = 'Wylls Resident', uri = 'local://asset', memo = null, assetKeypair = keypair() }) {
    if (this.collectionAuthorities.get(collection) !== authority.publicKey) refuse(ERR.AUTH, 'mint: not the collection authority');
    const assetId = assetKeypair.publicKey;
    if (this.accounts.has(assetId)) refuse(ERR.ALREADY_PROCESSED, 'mint: asset exists');
    this.#write(assetId, { owner: this.coreProgram, data: encodeAssetV1({ owner: to, updateAuthority: { type: 'Collection', address: collection }, name, uri }), lamports: 2_000_000, flags: { frozen: false } });
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

  /** Message for the resident program's SetSession: the current holder signs. */
  buildSetSession({ assetId, holder, session, expiry, validUntilSlot = this.slot + TX_LIFETIME_SLOTS }) {
    return { kind: 'setSession', assetId, actor: holder, session, expiry, signers: [holder], validUntilSlot, nonce: randomAddress() };
  }

  /** Message for a player operation on a resident: `actor` is the holder or its session key. */
  buildOp({ assetId, actor, op, validUntilSlot = this.slot + TX_LIFETIME_SLOTS }) {
    return { kind: 'op', assetId, actor, op, signers: [actor], validUntilSlot, nonce: randomAddress() };
  }

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
    let result;
    try {
      result = this.#execute(m, signature);
      this.processed.set(signature, { slot: this.slot, result: 'ok' });
      return { ok: true, signature, slot: this.slot, ...result };
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      this.processed.set(signature, { slot: this.slot, result: e.code });
      this.#event({ kind: 'failed', signature, reason: e.code, assetId: m.assetId, txKind: m.kind });
      throw new Refusal(e.code, e.message, { ...e.extra, signature, slot: this.slot });
    }
  }

  #execute(m, signature) {
    switch (m.kind) {
      case 'transfer': return this.#transfer(m, signature);
      case 'setSession': return this.#setSession(m, signature);
      case 'op': return this.#op(m, signature);
      default: refuse(ERR.BAD_DATA, `unknown instruction ${m.kind}`);
    }
  }

  #transfer(m, signature) {
    const a = this.accounts.get(m.assetId);
    if (!a || a.owner !== this.coreProgram) refuse(ERR.NO_ACCOUNT, 'transfer: no such asset');
    const owner = base58(a.data.subarray(1, 33));
    if (owner !== m.from) refuse(ERR.NOT_OWNER, 'transfer: the signer is not the current owner', { owner });
    if (a.flags.frozen) refuse(ERR.FROZEN, 'transfer: the asset is frozen');
    if (!isPubkey(m.to)) refuse(ERR.BAD_DATA, 'transfer: bad recipient');
    const data = new Uint8Array(a.data);
    data.set(Buffer.from(require58(m.to)), 1);
    this.#write(m.assetId, { ...a, data });
    this.#event({ kind: 'transfer', assetId: m.assetId, from: m.from, to: m.to, signature });
    return { from: m.from, to: m.to };
  }

  /** The resident program's prologue: `actor` is the asset's current owner, or the session key the current owner set, unexpired. */
  prologue(assetId, actor) {
    const owner = this.ownerOf(assetId);
    if (!owner) refuse(ERR.NO_ACCOUNT, 'prologue: no such asset');
    if (actor === owner) return { owner, bySession: false };
    const st = this.residentState.get(assetId);
    const s = st?.session;
    if (s && s.key === actor && s.setBy === owner && s.expiry > this.now()) return { owner, bySession: true };
    refuse(ERR.NOT_OWNER, 'prologue: the actor is neither the current holder nor a session key the current holder set', { owner, actor, session: s ?? null });
  }

  #setSession(m, signature) {
    const owner = this.ownerOf(m.assetId);
    if (!owner) refuse(ERR.NO_ACCOUNT, 'SetSession: no such asset');
    if (m.actor !== owner) refuse(ERR.NOT_OWNER, 'SetSession: only the current holder sets the session key', { owner });
    if (m.session !== null && !isPubkey(m.session)) refuse(ERR.BAD_DATA, 'SetSession: bad key');
    if (m.expiry > this.now() + MAX_SESSION_SECS) refuse(ERR.BAD_DATA, 'SetSession: expiry too far');
    const st = this.residentState.get(m.assetId) ?? {};
    st.session = m.session === null ? null : { key: m.session, setBy: owner, expiry: m.expiry };
    this.residentState.set(m.assetId, st);
    this.#event({ kind: 'session', assetId: m.assetId, setBy: owner, session: m.session, signature });
    return { session: st.session };
  }

  #op(m, signature) {
    const pc = this.prologue(m.assetId, m.actor);
    if (!this.world) refuse(ERR.BAD_DATA, 'no world attached');
    // The resident is the asset's, by derivation (as the Citizen address is derived from its seed): an operation naming another resident is refused.
    const residentId = residentIdOf(m.assetId);
    if (m.op?.residentId && m.op.residentId !== residentId) refuse(ERR.WRONG_RESIDENT, 'the operation names a resident that is not this asset\'s', { residentId, named: m.op.residentId });
    const out = this.world.applyFromProgram({ assetId: m.assetId, op: m.op, actor: m.actor, owner: pc.owner, slot: this.slot, signature, residentId });
    this.#event({ kind: 'op', assetId: m.assetId, actor: m.actor, op: m.op.name, signature });
    return { applied: out };
  }

  /** The session record the program holds for an asset (null if none). */
  sessionOf(assetId) { return this.residentState.get(assetId)?.session ?? null; }

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
