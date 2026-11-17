// Login and credentials for residents.
//
// Login = a Sign-In-With-Solana-shaped challenge (phantom/sign-in-with-solana
// fields: domain, address, statement, nonce ≥ 8 alphanumerics, issuedAt,
// expirationTime, requestId) that names the **asset** being logged into.
// The server checks: the message is byte for byte the one it issued for
// that nonce, the signature is the address's, the nonce is unused and
// unexpired, the domain is ours, the world is published, and — read fresh
// from the chain, not from the registry's memory — the address is the
// asset's current holder. Then it issues a session token bound to
// (residentId, wallet, epoch).
//
// Three kinds of credential, all relay-side, all bound to the epoch:
//   login       the browser's token (sha256 kept, shown once)
//   capability  an MCP-style token a holder hands to a tool (as the agent
//               wallet's capability token); asks for operations only
//   delegation  the holder named an agent key (the on-chain SetSession is
//               the mock program's; this is the relay's record of it)
// `authorize` is what every operation calls at the time it is authorized:
// it re-reads the holder (holderNow) and refuses when the holder or the
// epoch moved (OwnerChanged), revoking the credential. A credential is also
// refused when the read is stale or the chain unreachable: unverified means
// refused, never "probably still fine".
import { randomId, sha256, toHex, utf8, verifySignature, isPubkey } from './crypto.mjs';
import { ERR, Refusal, refuse } from './errors.mjs';

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 3_600_000;
export const NONCE_RE = /^[A-Za-z0-9]{8,64}$/;

/** The text the wallet signs (ASCII only; the resident's asset is named so a signature for one asset cannot log into another). */
export function signInText({ domain, address, assetId, nonce, issuedAt, expirationTime, requestId }) {
  const text = `${domain} wants you to sign in with your Solana account:\n${address}\n\n`
    + `Log in to the Wylls resident held by this NFT. This signature moves nothing.\n\n`
    + `URI: https://${domain}/resident\nVersion: 1\nChain ID: localnet\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expirationTime}\nRequest ID: ${requestId}\nResources:\n- wylls:resident-asset:${assetId}`;
  if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error('sign-in text must be printable ASCII');
  return text;
}

const hash = s => toHex(sha256(utf8(s)));

export class ResidentAuth {
  constructor({ store, registry, domain, now = Date.now }) {
    this.store = store;
    this.registry = registry;
    this.domain = domain;
    this.now = now;
    this.store.state ??= {};
    this.store.state.auth ??= { challenges: {}, credentials: {}, revoked: [] };
    // Revoke proactively when the registry confirms a holder change; `authorize` still catches a change the registry learns of only then.
    registry.onHolderChange?.push(rec => this.revokeBefore(rec.residentId, rec.epoch, 'holder changed (registry)'));
  }

  get db() { return this.store.state.auth; }
  save() { this.store.save(); }

  // ------------------------------------------------------------ login

  /** A challenge for `address` to log into `assetId`; the server keeps the exact text it expects back. */
  challenge({ address, assetId }) {
    if (!isPubkey(address) || !isPubkey(assetId)) refuse(ERR.BAD_REQUEST, 'address and assetId must be base58 keys');
    const nonce = randomId(12).replace(/[^A-Za-z0-9]/g, 'x').padEnd(16, 'x');
    const issuedAt = new Date(this.now()).toISOString();
    const expirationTime = new Date(this.now() + CHALLENGE_TTL_MS).toISOString();
    const requestId = randomId(8);
    const text = signInText({ domain: this.domain, address, assetId, nonce, issuedAt, expirationTime, requestId });
    this.db.challenges[nonce] = { address, assetId, text, expiresAt: this.now() + CHALLENGE_TTL_MS, used: false };
    this.#sweep();
    this.save();
    return { nonce, text, expiresAt: expirationTime };
  }

  #sweep() {
    for (const [n, c] of Object.entries(this.db.challenges)) if (c.expiresAt < this.now() - CHALLENGE_TTL_MS) delete this.db.challenges[n];
    for (const [h, c] of Object.entries(this.db.credentials)) if (c.expiresAt && c.expiresAt < this.now() - SESSION_TTL_MS) delete this.db.credentials[h];
  }

  /**
   * Complete a login. `signature`: 64 bytes (Uint8Array or base64) by
   * `address` over `text`. Before publication the answer is the waitlist
   * status (`NotPublished`, with the entitlement), not a token.
   */
  async login({ address, assetId, nonce, text, signature }) {
    const c = this.db.challenges[nonce];
    if (!c) refuse(ERR.NONCE_UNKNOWN, 'unknown or expired challenge');
    if (c.used) refuse(ERR.NONCE_USED, 'this challenge was used already');
    if (c.expiresAt < this.now()) { delete this.db.challenges[nonce]; this.save(); refuse(ERR.EXPIRED, 'the challenge expired'); }
    if (c.address !== address || c.assetId !== assetId) refuse(ERR.BAD_MESSAGE, 'the challenge was issued for another address or asset');
    if (text !== c.text) refuse(ERR.BAD_MESSAGE, 'the signed text is not the challenge text');
    if (!text.startsWith(`${this.domain} wants you to sign in`)) refuse(ERR.WRONG_DOMAIN, 'the message names another domain');
    const sig = typeof signature === 'string' ? new Uint8Array(Buffer.from(signature, 'base64')) : signature;
    if (!verifySignature(utf8(text), sig, address)) refuse(ERR.BAD_SIGNATURE, 'the signature is not this address\'s signature of the challenge');
    // The nonce is consumed before any chain read, so a concurrent repeat is NonceUsed whatever the chain says.
    c.used = true;
    this.save();
    let h;
    try {
      h = await this.registry.holderNow(assetId);
    } catch (e) {
      if (e instanceof Refusal && e.code === ERR.STALE_READ) refuse(ERR.UNCONFIRMED, 'the chain read is not fresh enough to confirm the holder; try again', e.extra);
      throw e;
    }
    if (h.holder !== address) refuse(ERR.NOT_HOLDER, 'this address does not hold the asset now', { holder: h.holder, readSlot: h.readSlot });
    if (!this.registry.published) refuse(ERR.NOT_PUBLISHED, 'the world is not published yet: you are on the waitlist as the holder of this resident', { entitlement: this.registry.entitlement(address), residentId: h.residentId, epoch: h.epoch });
    return this.#issue({ kind: 'login', residentId: h.residentId, assetId, wallet: address, epoch: h.epoch, ttl: SESSION_TTL_MS });
  }

  #issue({ kind, residentId, assetId, wallet, epoch, ttl = null, extra = {} }) {
    const token = `${kind}_${randomId(24)}`;
    const rec = { kind, residentId, assetId, wallet, epoch, issuedAt: this.now(), expiresAt: ttl ? this.now() + ttl : null, ...extra };
    this.db.credentials[hash(token)] = rec;
    this.save();
    return { token, ...rec };
  }

  // ------------------------------------------------------------ capabilities and delegations (holder-only)

  /** A capability for a tool (MCP): issued only under a live login of the holder; bound to the login's epoch. */
  async issueCapability({ loginToken, label = 'tool' }) {
    const owner = await this.authorize({ credential: loginToken });
    return this.#issue({ kind: 'capability', residentId: owner.residentId, assetId: owner.assetId, wallet: owner.wallet, epoch: owner.epoch, extra: { label, issuedBy: 'login' } });
  }

  /** The relay's record of an agent delegation (the on-chain SetSession is separate and checked by the program). */
  async recordDelegation({ loginToken, agentKey }) {
    if (!isPubkey(agentKey)) refuse(ERR.BAD_REQUEST, 'agentKey');
    const owner = await this.authorize({ credential: loginToken });
    const rec = { kind: 'delegation', residentId: owner.residentId, assetId: owner.assetId, wallet: owner.wallet, epoch: owner.epoch, agentKey, issuedAt: this.now(), expiresAt: null };
    this.db.credentials[hash(`delegation:${agentKey}:${owner.assetId}`)] = rec;
    this.save();
    return rec;
  }

  /** Look up a credential record without authorizing (tests, views). */
  peek(credential) { return this.db.credentials[hash(credential)] ?? null; }
  peekDelegation(agentKey, assetId) { return this.db.credentials[hash(`delegation:${agentKey}:${assetId}`)] ?? null; }

  /** Revoke every credential of a resident issued under an epoch older than `epoch`. Returns how many. */
  revokeBefore(residentId, epoch, reason) {
    let n = 0;
    for (const [h, c] of Object.entries(this.db.credentials)) {
      if (c.residentId === residentId && c.epoch < epoch) { delete this.db.credentials[h]; this.db.revoked.push({ kind: c.kind, wallet: c.wallet, epoch: c.epoch, reason, at: this.now() }); n++; }
    }
    if (n) this.save();
    return n;
  }

  /**
   * Authorize an action now. `credential`: a login or capability token, or
   * `{agentKey, assetId}` for a delegation. `minSlot`: how fresh the chain
   * read must be. Returns `{residentId, assetId, wallet, epoch, kind, readSlot}`
   * or refuses: BadCredential, Expired, OwnerChanged (holder or epoch moved;
   * the credential is revoked), NotHolder, StaleRead / ChainUnavailable
   * (not verified → refused, credential kept), Frozen.
   */
  async authorize({ credential, minSlot = 0 } = {}) {
    let rec;
    let key;
    if (credential && typeof credential === 'object' && credential.agentKey) {
      key = hash(`delegation:${credential.agentKey}:${credential.assetId}`);
      rec = this.db.credentials[key];
    } else if (typeof credential === 'string') {
      key = hash(credential);
      rec = this.db.credentials[key];
    }
    if (!rec) refuse(ERR.BAD_CREDENTIAL, 'unknown or revoked credential');
    if (rec.expiresAt && rec.expiresAt < this.now()) { delete this.db.credentials[key]; this.save(); refuse(ERR.EXPIRED, 'the credential expired'); }
    const h = await this.registry.holderNow(rec.assetId, { minSlot });
    if (h.epoch !== rec.epoch || h.holder !== rec.wallet) {
      const n = this.revokeBefore(rec.residentId, h.epoch, 'holder changed');
      refuse(ERR.OWNER_CHANGED, 'the resident changed hands since this credential was issued; it is revoked', { holder: h.holder, epoch: h.epoch, issuedEpoch: rec.epoch, revoked: n });
    }
    if (h.frozen) refuse(ERR.FROZEN, 'the asset is frozen', { readSlot: h.readSlot });
    return { residentId: rec.residentId, assetId: rec.assetId, wallet: rec.wallet, epoch: rec.epoch, kind: rec.kind, agentKey: rec.agentKey ?? null, readSlot: h.readSlot };
  }
}
