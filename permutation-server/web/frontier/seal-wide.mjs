// The WIDE march seal for the browser: a 136-byte WidePlain sealed into a
// 264-byte seal exactly as frontier-abi/src/world_index/seal.rs defines it
// and frontier-node/crates/fclient/src/wide_seal.rs produces it:
//
//   seal   = U (96, compressed G2) ‖ V (16) ‖ W (16) ‖ body (136)
//   body   = plain136 XOR sha256("PS-KS" ‖ k ‖ [c]) blocks, c = 0..4
//   salt   = sha256("PS-SALT" ‖ k)
//   commit = sha256("PS-FRONTIER-MARCH-WIDE-v1" ‖ plain136 ‖ salt)
//   ct_hash = sha256(seal), seal_root = sha256(commit ‖ ct_hash)
//
// Everything is reused, nothing re-derived: the WidePlain codec and its
// validation (fexpedition-seal.mjs), the compact-16 IBE block and its
// primitives (seal-ibe.mjs, the same standard tlock as the legacy seal),
// the keystream, salt, ct_hash, seal_root, T(b) and the Quicknet pin
// (seal.mjs). The legacy 37-byte plaintext / 165-byte seal is untouched.
//
// Secrets: k and σ are drawn fresh per seal (crypto.getRandomValues) and
// zeroed before returning; they never leave this module. The packed
// plaintext and salt a later Reveal needs are returned in `reveal`, held only
// in memory by the caller: `JSON.stringify` of a result redacts them, and
// nothing here logs, stores or sends anything.
import { bls12_381 as bls } from '../sdk/vendor/noble/curves/bls12-381.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { toHex } from '../sdk/bytes.mjs';
import { ExpeditionSealError, WIDE_PLAIN_LEN, packWidePlain, unpackWidePlain, validateWidePlain } from './fexpedition-seal.mjs';
// The pure primitives only: importing seal-worker.mjs would also install the
// legacy worker's message handler inside the wide worker.
import { K_LEN, gtHash, h3, h4, ibeEncrypt, maskFor } from './seal-ibe.mjs';
import { bodyXor, checkBeacon, ctHash, saltOf, sealRoot, sealRound } from './seal.mjs';

export const IBE_LEN = 128;
export const WIDE_SEAL_LEN = IBE_LEN + WIDE_PLAIN_LEN; // 264
export const DOMAIN_MARCH_WIDE = 'PS-FRONTIER-MARCH-WIDE-v1';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
const fail = (code, msg = code) => { throw Object.assign(new Error(msg), { code }); };
const asBytes = (x, n, code) => {
  const b = typeof x === 'string'
    ? (/^([0-9a-f]{2})*$/.test(x) ? Uint8Array.from(x.match(/../g) ?? [], v => parseInt(v, 16)) : fail(code))
    : x instanceof Uint8Array ? Uint8Array.from(x) : fail(code);
  if (n !== undefined && b.length !== n) fail(code);
  return b;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const xor = (a, b) => a.map((x, i) => x ^ b[i]);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** commit = sha256("PS-FRONTIER-MARCH-WIDE-v1" ‖ plain136 ‖ salt). */
export function commitWide(plain, salt) {
  return sha256(DOMAIN_MARCH_WIDE, asBytes(plain, WIDE_PLAIN_LEN, 'PlainLength'), asBytes(salt, 32, 'SaltLength'));
}

/** The 136-byte body XOR the deployed keystream of k (an involution). */
export function bodyXorWide(k, plain) {
  return bodyXor(asBytes(k, K_LEN, 'KeyLength'), asBytes(plain, WIDE_PLAIN_LEN, 'PlainLength'));
}

/** The memory-only reveal half: `plain` (136) and `salt` (32). */
function revealOf(plain, salt) {
  const r = { plain, salt };
  Object.defineProperty(r, 'toJSON', { value: () => '<redacted>', enumerable: false });
  Object.defineProperty(r, Symbol.for('nodejs.util.inspect.custom'), { value: () => 'WideReveal(<redacted>)', enumerable: false });
  return Object.freeze(r);
}

/**
 * The seal of a typed WidePlain for `round` with the given k and σ (tests and
 * the request below; callers use `sealWideRequest`, which draws them).
 */
export function sealWideWith({ plain, round, publicKey, k, sigma }) {
  const pt = packWidePlain(plain);
  const { U, V, W } = ibeEncrypt(publicKey, round, asBytes(k, K_LEN, 'KeyLength'), asBytes(sigma, K_LEN, 'SigmaLength'));
  const seal = concat(U, V, W, bodyXorWide(k, pt));
  const salt = saltOf(asBytes(k, K_LEN, 'KeyLength'));
  const c = commitWide(pt, salt);
  const ct = ctHash(seal);
  return { seal, commit: c, ctHash: ct, sealRoot: sealRoot(c, ct), reveal: revealOf(pt, salt) };
}

/**
 * Opens a 264-byte seal with the round's signature (48-byte compressed G1):
 * the FO check, then the body. `{plain (136), salt, commit}`; throws
 * `{code: 'BadPoint' | 'FoCheck' | 'SealLength'}`. k is zeroed before return.
 */
export function openWide(seal, signature) {
  const s = asBytes(seal, WIDE_SEAL_LEN, 'SealLength');
  let U, sig;
  try {
    U = G2.fromHex(s.subarray(0, 96)); U.assertValidity();
    sig = G1.fromHex(asBytes(signature, 48, 'SignatureLength')); sig.assertValidity();
  } catch (e) {
    if (e.code) throw e;
    fail('BadPoint', `bad point: ${e.message}`);
  }
  const sigma = xor(s.slice(96, 112), gtHash(bls.pairing(sig, U), K_LEN));
  const k = xor(s.slice(112, 128), h4(sigma, K_LEN));
  try {
    if (!G2.BASE.multiply(h3(sigma, k)).equals(U)) fail('FoCheck', 'FO check failed');
    const plain = bodyXorWide(k, s.slice(IBE_LEN));
    const salt = saltOf(k);
    return { plain, salt, commit: commitWide(plain, salt) };
  } finally {
    k.fill(0); sigma.fill(0);
  }
}

/**
 * The off-chain judge, as fclient's `open_wide`: opens, checks the logged
 * commitment, unpacks and validates against the transit. The typed plain or
 * `{code}` thrown (`Commit`, or the WidePlain error code).
 */
export function judgeWide({ seal, signature, commit, host, arriveBell }) {
  const opened = openWide(seal, signature);
  if (!same(opened.commit, asBytes(commit, 32, 'CommitLength'))) fail('Commit', 'commitment mismatch');
  const plain = unpackWidePlain(opened.plain);
  validateWidePlain(plain, { host, arriveBell });
  return plain;
}

let worker = null, seq = 0;
const waiting = new Map();
function startWorker() {
  if (worker !== null) return worker;
  try {
    worker = new globalThis.Worker(new URL('./seal-wide-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = e => { const w = waiting.get(e.data?.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
    worker.onerror = () => { for (const w of waiting.values()) w({ ok: false, code: 'WorkerFailed', error: 'worker failed' }); waiting.clear(); worker = false; };
  } catch {
    worker = false; // no module workers: seal on this thread
  }
  return worker;
}

/**
 * Seal a wide march off the main thread when module workers exist (inline
 * otherwise, or with `{inline: true}`). Same request and answer as
 * `sealWideRequest`; the answer's `reveal` is rebuilt from the worker's
 * message so it stays redacted in JSON.
 */
export async function sealWide(req, { inline = false } = {}) {
  const w = inline ? false : startWorker();
  if (!w) return sealWideRequest(req);
  const id = ++seq;
  const r = await new Promise(resolve => {
    waiting.set(id, resolve);
    try {
      // the internal id last: a caller's own `id` can never replace it
      // seasonClock also carries a window function. Only its exact scalar
      // inputs cross the worker boundary; keep their types for validation.
      w.postMessage({ ...req, clock: { genesisTs: req?.clock?.genesisTs,
        drand: { genesis: req?.clock?.drand?.genesis, period: req?.clock?.drand?.period } }, id });
    } catch (e) {
      waiting.delete(id);
      resolve({ ok: false, code: 'WorkerPost', error: String(e?.message ?? e) });
    }
  });
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  return { ok: true, seal: r.seal, commit: r.commit, ctHash: r.ctHash, sealRoot: r.sealRoot, round: r.round,
    reveal: revealOf(r.revealPlain, r.revealSalt),
    toJSON() { return { ok: true, seal: toHex(this.seal), commit: toHex(this.commit), ctHash: toHex(this.ctHash), sealRoot: toHex(this.sealRoot), round: this.round, reveal: '<redacted>' }; } };
}

/**
 * One sealing request. Inputs: `plain` (typed WidePlain), the transit's
 * `host` (56-byte hex) and `arriveBell`, the season `clock`
 * ({genesisTs, drand: {genesis, period}}), the `/h/season` beacon `drand`
 * ({publicKey, period, genesis, chainHash?}), the Season's `seasonPkHash`
 * and `seasonNetwork`, and the pinned `cluster`. A `round`, if given, must be
 * T(arriveBell).
 *
 * `{ok: true, seal, commit, ctHash, sealRoot, round, reveal: {plain, salt}}`
 * (Uint8Arrays; keep `reveal` in memory until the Reveal, whatever happened
 * to the transaction) or `{ok: false, code, error}`.
 */
export function sealWideRequest(req, draw = n => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  let k = null, sigma = null;
  try {
    const { plain, host, arriveBell, clock, drand, seasonPkHash, seasonNetwork, cluster } = req ?? {};
    if (seasonNetwork === undefined || seasonNetwork === null) fail('SeasonNetworkRequired');
    const pin = checkBeacon({ drand, seasonPkHash, cluster, seasonNetwork });
    if (!pin.ok) fail(pin.code);
    validateWidePlain(plain, { host, arriveBell });
    // The round comes from the season clock, whose beacon clock must be the
    // pinned beacon's exactly: one genesis, one period, safe integers only.
    const safe = x => typeof x === 'number' && Number.isSafeInteger(x);
    if (!safe(clock?.genesisTs) || !safe(clock?.drand?.genesis) || !safe(clock?.drand?.period) || clock.drand.period <= 0) fail('Clock');
    if (clock.drand.genesis !== Number(drand.genesis) || clock.drand.period !== Number(drand.period)) fail('ClockBeaconMismatch');
    if (!safe(arriveBell)) fail('ArriveBell');
    // T(b) exactly (BigInt): cutoff = genesisTs + 600·(b + 1); round = 1 at or
    // before the beacon genesis, else ceil((cutoff − genesis) / period) + 1.
    // The cutoff, the delta (cutoff − genesis, either sign) and the round must
    // each lie within ±Number.MAX_SAFE_INTEGER, or the request is refused
    // ('Clock'), never rounded; inside that range T equals seal.mjs sealRound.
    const MAX = BigInt(Number.MAX_SAFE_INTEGER);
    const cutoff = BigInt(clock.genesisTs) + 600n * (BigInt(arriveBell) + 1n);
    const bg = BigInt(clock.drand.genesis), bp = BigInt(clock.drand.period);
    const delta = cutoff - bg;
    const exactRound = delta <= 0n ? 1n : (delta + bp - 1n) / bp + 1n;
    const outside = x => x > MAX || x < -MAX;
    if (outside(cutoff) || outside(delta) || outside(exactRound)) fail('Clock', 'season clock out of the exact range');
    const t = Number(exactRound);
    if (sealRound(clock, arriveBell) !== t) fail('Clock', 'season clock arithmetic disagrees');
    if (req.round !== undefined && req.round !== null) {
      if (!safe(req.round)) fail('WrongRound', 'round is not a safe integer');
      if (req.round !== t) fail('WrongRound', `round ${req.round} is not T(${arriveBell}) = ${t}`);
    }
    k = draw(K_LEN); sigma = draw(K_LEN);
    if (!(k instanceof Uint8Array) || k.length !== K_LEN || !(sigma instanceof Uint8Array) || sigma.length !== K_LEN) fail('Random');
    if (k.every(x => x === 0) || sigma.every(x => x === 0) || same(k, sigma)) fail('Random');
    const out = sealWideWith({ plain, round: t, publicKey: pin.publicKey, k, sigma });
    // self-audit: the program's opener would accept exactly this
    const r = h3(sigma, k);
    if (!same(G2.BASE.multiply(r).toRawBytes(true), out.seal.subarray(0, 96))) fail('SealAuditFailed', 'U');
    if (!same(xor(sigma, maskFor(pin.publicKey, t, r)), out.seal.subarray(96, 112))) fail('SealAuditFailed', 'V');
    if (!same(xor(k, h4(sigma, K_LEN)), out.seal.subarray(112, 128))) fail('SealAuditFailed', 'W');
    if (!same(bodyXorWide(k, out.seal.slice(IBE_LEN)), out.reveal.plain)) fail('SealAuditFailed', 'body');
    if (!same(packWidePlain(unpackWidePlain(out.reveal.plain)), out.reveal.plain)) fail('SealAuditFailed', 're-pack');
    return { ok: true, ...out, round: t, reveal: out.reveal,
      toJSON() { return { ok: true, seal: toHex(this.seal), commit: toHex(this.commit), ctHash: toHex(this.ctHash), sealRoot: toHex(this.sealRoot), round: this.round, reveal: '<redacted>' }; } };
  } catch (e) {
    const code = e instanceof ExpeditionSealError ? e.code : (e.code ?? 'SealFailed');
    return { ok: false, code, error: String(e.message ?? e) };
  } finally {
    k?.fill?.(0); sigma?.fill?.(0);
  }
}
