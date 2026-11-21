// DEVNET PLAY (devnet gap P15) — the BOUNDARY DEPARTURE of a devnet wide season from the page: the boundary draft
// (fexpedition-compose.mjs, 「境界への道を準備」) sealed, shown, signed by the player's CONNECTED wallet and sent through
// the gateway's two devnet routes. The devnet analog of local play's flocalplay-depart.mjs, in TWO presses:
//
//   1. prepareDevnetDepart  the draft as it stands ── seal (seal-wide.mjs, injected) ──▶ the reveal half kept in the
//      devnet ENCRYPTED book (fdevnetbook.mjs: a non-extractable AES-GCM key in IndexedDB, as devnet-page-war) ──▶
//      a blockhash (POST /gw/f/devnet-play/act/context) ──▶ the canonical request and its unsigned message, built HERE
//      with the one shared builder (fexpedition-depart-message.mjs, byte-equal to the keyless Rust CLI's) ──▶ the run
//      stops at `preview`: what will be signed and what it costs, for the player to read.
//   2. sendDevnetDepart     the same draft, the preview not expired ──▶ the wallet signs THAT message (Wallet Standard
//      signTransaction via the controller's `sign`) ──▶ checked: the same message, one signature, the wallet's, valid
//      ──▶ POST /gw/f/devnet-play/expedition/submit ONCE ──▶ POST …/expedition/status as often as asked.
//
// The gateway rebuilds the message from the stated request and compares it byte for byte before its one send; it
// never sees the reveal half. On devnet keeper A's `expeditions` role opens the seal from the PUBLIC round T(arrive)
// and drives every later step (SettleOrigin, Reveal, the destination's resolves, Gather, SettleMember): nothing of
// the reveal half is ever posted from here — it stays in this browser's encrypted book, kept across a reload, as the
// player's own record. No keyless inspector is used (it is local play's): on devnet the draft's own review (the
// herald's observation of the host, its village and the free transit slot) and the program's preflight are the checks.
//
// An outcome that is not known is `unknown`, never success: it is asked about by its signature on the status route;
// nothing is sealed, built, signed or submitted a second time for it.
import { canonicalDepartProposal, departPreparationRequestOf, publicSealOk, DEPART_PREPARE_REQUEST_SCHEMA, DEPART_PREPARE_PROGRAM_VERSION } from './fexpedition-depart-prepare.mjs';
import { OUTBOUND_POP, reconcileOutbound, outboundClockSeen } from './fexpedition-compose.mjs';
import { unpackWidePlain } from './fexpedition-seal.mjs';
import { departUnsignedMessage } from './fexpedition-depart-message.mjs';
import { marchCosts } from './fmarch.mjs';
import { parseTransaction, wireTransaction } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { toBase64, fromHex, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const DEVNET_DEPART_CONTEXT_PATH = '/gw/f/devnet-play/act/context';
export const DEVNET_DEPART_CONTEXT_SCHEMA = 'frontier-devnet-play-expedition-context-v1';
export const DEVNET_DEPART_SUBMIT_PATH = '/gw/f/devnet-play/expedition/submit';
export const DEVNET_DEPART_SUBMIT_SCHEMA = 'frontier-devnet-play-expedition-submit-v1';
export const DEVNET_DEPART_STATUS_PATH = '/gw/f/devnet-play/expedition/status';
export const DEVNET_DEPART_STATUS_SCHEMA = 'frontier-devnet-play-expedition-status-v1';
const PATHS = [DEVNET_DEPART_CONTEXT_PATH, DEVNET_DEPART_SUBMIT_PATH, DEVNET_DEPART_STATUS_PATH];
/** The key of the reveal halves in the devnet march book (one JSON list; the book encrypts every write). */
export const DEVNET_DEPART_BOOK_KEY = 'devnet-expedition-reveals-v1';
export const DEVNET_DEPART_MAX_BYTES = 64 * 1024;
export const DEVNET_DEPART_TIMEOUT_MS = 30_000;
/** The base fee of one signature (lamports): the transaction's one signer. */
export const DEVNET_DEPART_FEE = 5000n;
/** The steps of a run: `preview` waits for the second press; the last five are ends. */
export const DEVNET_DEPART_STEPS = Object.freeze(['sealing', 'preparing', 'preview', 'signing', 'submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'error']);
const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e.code) ? e.code : fallback);

/** One bounded POST of JSON to one of the three devnet routes (behind the herald's /gw); never a retry, never credentials. */
export async function postDevnetDepart(origin, path, body, { fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = DEVNET_DEPART_TIMEOUT_MS } = {}) {
  check(typeof origin === 'string' && origin.length > 0 && PATHS.includes(path), 'DevnetDepartPath');
  const text = JSON.stringify(body);
  check(text.length <= DEVNET_DEPART_MAX_BYTES, 'DevnetDepartTooLarge');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
  let res, raw;
  try {
    res = await fetcher(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal });
    raw = await res.text();
  } catch { fail('DevnetDepartNoAnswer'); } finally { clearTimeout(timer); }
  check(typeof raw === 'string' && raw.length <= DEVNET_DEPART_MAX_BYTES, 'DevnetDepartTooLarge');
  let value; try { value = JSON.parse(raw); } catch { fail('DevnetDepartNoAnswer'); }
  if (!res.ok) throw Object.assign(new Error('refused'), { code: codeOf(value, 'DevnetDepartRefused'), refused: true, status: res.status });
  return value;
}

// ------------------------------------------------------------------ the reveal halves (the encrypted book)
const hexOf = b => toHex(Uint8Array.from(b));
/** The reveal halves kept in `storage` (the devnet book's `{get, set}`), oldest first; a malformed list reads as none. */
export function devnetDepartReveals(storage) {
  let list = null; try { list = JSON.parse(storage?.get?.(DEVNET_DEPART_BOOK_KEY) ?? 'null'); } catch { list = null; }
  return Array.isArray(list) ? Object.freeze(list.filter(object).map(e => Object.freeze({ ...e }))) : Object.freeze([]);
}
/** Append one reveal half (never replaced, never dropped). */
function keepReveal(storage, entry) {
  const list = [...devnetDepartReveals(storage)];
  check(!list.some(e => e.host === entry.host && e.transitSlot === entry.transitSlot && e.commit === entry.commit), 'DevnetDepartSealFailed');
  list.push(entry);
  check(storage.set(DEVNET_DEPART_BOOK_KEY, JSON.stringify(list)) !== false, 'DevnetDepartBookUnavailable');
}
function markReveal(storage, commit, signature) {
  const list = devnetDepartReveals(storage).map(e => (e.commit === commit && e.signature === null ? { ...e, signature } : e));
  storage.set(DEVNET_DEPART_BOOK_KEY, JSON.stringify(list));
}

/**
 * The devnet request of the draft as it stands (`fs.expeditionCompose`, reviewed; its sealed public commit and seal):
 * the local relay's canonical request shape with cluster 'devnet' and `min_slot` the blockhash's context slot (no
 * keyless observation exists on devnet). Throws a code.
 */
export function devnetDepartRequest(fs, { sealed, requestId, minSlot = '0' }) {
  const s = fs.expeditionCompose;
  check(fs.hand?.pop === OUTBOUND_POP && !!s?.source && s.status === 'review' && !!s.review, 'DepartDraftUnavailable');
  const r = s.review, src = s.source;
  check(Array.isArray(r.roles) && r.roles.length === 9 && Number.isInteger(r.transitSlot) && r.transitSlot === src.transitSlot, 'DepartRolesUnavailable');
  check(String(src.programVersion) === DEPART_PREPARE_PROGRAM_VERSION, 'ExperimentalPreparationUnavailable');
  check(src.cluster === 'devnet' && src.payer === src.wallet, 'DevnetDepartIdentityMismatch');
  check(Number.isInteger(r.arriveBell) && String(r.arriveBell) === s.arriveBell && /^(0|[1-9][0-9]{0,19})$/.test(String(r.tip?.lamports ?? '')), 'DepartDraftUnavailable');
  check(publicSealOk(sealed), 'DepartSealUnavailable');
  const scope = { schema: DEPART_PREPARE_REQUEST_SCHEMA, request_id: requestId, cluster: 'devnet', program: src.program, season: src.season,
    deployment: { program_version: DEPART_PREPARE_PROGRAM_VERSION, ruleset_hash: src.ruleset }, wallet: src.wallet, payer: src.payer, host: src.host,
    standing: { p: src.origin.p, q: src.origin.q }, transit_slot: String(r.transitSlot), arrive_bell: String(r.arriveBell), tip: String(r.tip.lamports),
    public_commit: sealed.commit, public_seal: sealed.seal, min_slot: String(minSlot) };
  let request;
  try { request = departPreparationRequestOf({ ...scope, proposal: canonicalDepartProposal(scope) }); } catch { fail('DepartDraftUnavailable'); }
  const mine = r.roles.map(x => JSON.stringify([x.name, x.address, x.signer, x.writable])).join();
  check(request.proposal.roles.map(x => JSON.stringify([x.name, x.address, x.signer, x.writable])).join() === mine, 'DepartRolesUnavailable');
  return request;
}

/** What the wallet returned: the same message, one signature, the wallet's, which verifies. → `{wire, signature}`. */
export async function devnetDepartSigned(signedTransaction, message, wallet, { subtle = globalThis.crypto?.subtle } = {}) {
  let tx; try { tx = parseTransaction(Uint8Array.from(signedTransaction)); } catch { fail('DevnetDepartSignedMalformed'); }
  check(same([...tx.message], [...message]), 'DevnetDepartSignedOtherMessage');
  check(same(tx.signers, [wallet]) && tx.signatures.length === 1 && tx.signatures[0].some(x => x !== 0), 'DevnetDepartSignedUnsigned');
  let ok = false;
  try {
    const key = await subtle.importKey('raw', decode(wallet), 'Ed25519', false, ['verify']);   // a PUBLIC key
    ok = await subtle.verify('Ed25519', key, tx.signatures[0], tx.message);
  } catch { ok = false; }
  check(ok === true, 'DevnetDepartSignatureInvalid');
  return Object.freeze({ wire: wireTransaction(tx.message, [tx.signatures[0]]), signature: encode(tx.signatures[0]) });
}

// ------------------------------------------------------------------ the run
const runs = new WeakMap();
const idle = () => Object.freeze({ status: 'idle', busy: false, requestId: null, signature: null, digest: null, code: null, error: null, arriveBell: null, transitSlot: null, host: null, sent: false, chain: null, slot: null, preview: null });
const runOf = fs => { let r = runs.get(fs); if (!r) { r = { state: idle(), busy: false, sent: null, ready: null, seq: 0 }; runs.set(fs, r); } return r; };
const OPEN = ['unknown', 'submitted'];
/** The run's state for the page (`preview` is the frozen preview while waiting for the second press, and after). */
export const devnetDepartOf = fs => runOf(fs).state;
/** Forget a finished run (not one in flight or unsettled; not the reveal halves). */
export function clearDevnetDepart(fs) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return false;
  r.state = idle(); r.sent = null; r.ready = null;
  return true;
}

/** The draft identity a run is about: the reconcile first, then the same draft, review and clock. */
function draftWatch(fs, context) {
  const ctx = context();
  check(fs.hand?.pop === OUTBOUND_POP && reconcileOutbound(fs, ctx), 'DepartDraftUnavailable');
  const draft = fs.expeditionCompose, review = draft?.review;
  check(!!draft?.source && draft.status === 'review' && !!review, 'DepartDraftUnavailable');
  const seen = outboundClockSeen(fs);
  const still = () => {
    if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, context())) return false;
    let now = null; try { now = outboundClockSeen(fs); } catch { return false; }
    return fs.expeditionCompose === draft && draft.review === review && now === seen;
  };
  return { draft, review, still };
}

/**
 * Press 1. `deps`: `allowed()` → the controller's devnet gate (`{ok, relay}`), `context()` → the composer's context,
 * `sealInput()`, `seal(req)` (seal-wide.mjs sealWide), `book()` → the devnet book (`{storage, flush, wallet}`), `post`,
 * `changed()`, `wallet()` → the connected wallet's address. Ends at `preview` (or `error`). Nothing is signed or sent.
 */
export async function prepareDevnetDepart(fs, { allowed, context, sealInput, seal, book, wallet, post = postDevnetDepart, changed = () => {}, requestId } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  r.busy = true; r.sent = null; r.ready = null;
  const id = requestId ?? `dp_${Date.now().toString(36)}_${++r.seq}`;
  let base = { requestId: id };
  const put = (status, more = {}) => { base = { ...base, ...more }; r.state = Object.freeze({ ...idle(), ...base, status, busy: r.busy }); try { changed(); } catch { /* the page's repaint */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const gate = () => { const a = allowed(); if (!a?.ok) fail(a?.code ?? 'DevnetDepartNotAllowed'); return a.relay; };
  try {
    gate();
    const { draft, review, still } = draftWatch(fs, context);
    const me = wallet();
    check(address(me) && draft.source.wallet === me && draft.source.payer === me && draft.source.cluster === 'devnet', 'DevnetDepartIdentityMismatch');
    const kept = await book();
    check(kept?.wallet === me && typeof kept.storage?.set === 'function', 'DevnetDepartBookUnavailable');
    const host = draft.source.host, transitSlot = review.transitSlot;
    put('sealing', { arriveBell: review.arriveBell, transitSlot, host });
    let plain; try { plain = unpackWidePlain(fromHex(review.plainHex)); } catch { fail('DepartDraftUnavailable'); }
    const sealed = await seal({ plain, host, arriveBell: review.arriveBell, ...sealInput() });
    if (!sealed?.ok) fail(codeOf(sealed, 'DevnetDepartSealFailed'));
    const pub = { commit: toHex(sealed.commit), seal: toHex(sealed.seal) };
    check(publicSealOk(pub), 'DevnetDepartSealFailed');
    // (kept from here on, encrypted in this browser, whatever happens next: never posted)
    keepReveal(kept.storage, { host, transitSlot, commit: pub.commit, arriveBell: review.arriveBell, requestId: id, signature: null,
      plain: hexOf(sealed.reveal.plain), salt: hexOf(sealed.reveal.salt), ctHash: sealed.ctHash ? hexOf(sealed.ctHash) : null,
      sealRoot: sealed.sealRoot ? hexOf(sealed.sealRoot) : null, holding: draft.source.holding ?? null });
    await kept.flush?.();
    check(still(), 'DepartDraftChanged');
    put('preparing');
    const ctx = await post(gate(), DEVNET_DEPART_CONTEXT_PATH, { schema: DEVNET_DEPART_CONTEXT_SCHEMA, wallet: me });
    const bh = ctx?.blockhash;
    check(object(ctx) && ctx.wallet === me && address(bh?.hash) && /^[0-9]{1,20}$/.test(String(bh?.last_valid_block_height ?? '')) && /^[0-9]{1,20}$/.test(String(bh?.context_slot ?? ''))
      && typeof ctx.transit_rent === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(ctx.transit_rent), 'DevnetDepartContextMalformed');
    // (the rent of the transit record the Depart creates from this wallet, at the cluster's own rate: the gateway's read)
    const transitRent = BigInt(ctx.transit_rent);
    const request = devnetDepartRequest(fs, { sealed: pub, requestId: id, minSlot: String(bh.context_slot) });
    const built = departUnsignedMessage({ request, blockhash: bh.hash });
    check(still(), 'DepartDraftChanged');
    const costs = marchCosts(fs.season, BigInt(request.tip));
    const dest = draft.trace?.endpoint ?? null;
    const preview = Object.freeze({ action: 'ExpeditionDepart', payer: me, signer: me, arriveBell: review.arriveBell, transitSlot,
      destination: dest && dest.p !== undefined ? Object.freeze({ p: String(dest.p), q: String(dest.q) }) : null,
      tip: costs.tip.toString(), marchFee: costs.marchFee.toString(), sealBond: costs.sealBond.toString(), fee: DEVNET_DEPART_FEE.toString(),
      transitRent: transitRent.toString(), total: (costs.total + DEVNET_DEPART_FEE + transitRent).toString(), accounts: built.accounts, digest: built.digest, blockhash: bh.hash,
      lastValidBlockHeight: String(bh.last_valid_block_height), commit: pub.commit });
    r.ready = { request, message: built.message, digest: built.digest, blockhash: bh.hash, still, commit: pub.commit, book: kept, wallet: me };
    return end('preview', { preview, digest: built.digest });
  } catch (e) {
    r.ready = null;
    return end('error', { error: codeOf(e, 'DevnetDepartFailed') });
  }
}

/**
 * Press 2: the previewed message, signed by the connected wallet (`sign(wire)` → the signed transaction bytes), sent
 * ONCE; then one status read. Refused (nothing signed) unless the run is at `preview`, the gate holds for the same
 * wallet and the draft is unchanged since the preview.
 */
export async function sendDevnetDepart(fs, { allowed, sign, wallet, post = postDevnetDepart, changed = () => {}, subtle } = {}) {
  const r = runOf(fs);
  if (r.busy || r.state.status !== 'preview' || !r.ready) return r.state;
  const ready = r.ready;
  r.busy = true;
  const put = (status, more = {}) => { r.state = Object.freeze({ ...r.state, ...more, status, busy: r.busy }); try { changed(); } catch { /* the page's repaint */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const gate = () => { const a = allowed(); if (!a?.ok) fail(a?.code ?? 'DevnetDepartNotAllowed'); return a.relay; };
  try {
    gate();
    check(wallet() === ready.wallet, 'DevnetDepartSigner');
    check(ready.still(), 'DepartDraftChanged');
    put('signing');
    const signedBytes = await sign(wireTransaction(ready.message, []));
    const signed = await devnetDepartSigned(signedBytes ?? [], ready.message, ready.wallet, subtle ? { subtle } : {});
    const origin = gate();
    check(wallet() === ready.wallet, 'DevnetDepartSigner'); check(ready.still(), 'DepartDraftChanged');
    // from here the transaction may reach the chain: its signature is this run's for good
    r.ready = null;
    r.sent = Object.freeze({ origin, signature: signed.signature });
    try { markReveal(ready.book.storage, ready.commit, signed.signature); } catch { /* the book's own failure is not the send's */ }
    put('submitting', { signature: signed.signature, sent: true });
    let answer;
    try {
      answer = await post(origin, DEVNET_DEPART_SUBMIT_PATH, { schema: DEVNET_DEPART_SUBMIT_SCHEMA, request: ready.request, blockhash: ready.blockhash, transaction_b64: toBase64(signed.wire) });
      check(object(answer) && ['submitted', 'unknown'].includes(answer.status) && answer.signature === signed.signature, 'BadDevnetDepartSubmitted');
    } catch (e) {
      // a refusal BEFORE the send (the gateway's pre-send codes) is still "outcome unknown" here: asked by signature
      return end('unknown', { error: codeOf(e, 'DevnetDepartOutcomeUnknown') });
    }
    r.busy = false; put(answer.status);
    return await reconcileDevnetDepart(fs, { allowed, post, changed });
  } catch (e) {
    return end('error', { error: codeOf(e, 'DevnetDepartFailed') });
  }
}

/** Ask what became of a sent run (`unknown` / `submitted`) by its signature; never sends again. → the state. */
export async function reconcileDevnetDepart(fs, { allowed, post = postDevnetDepart, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || !r.sent || !OPEN.includes(r.state.status)) return r.state;
  const before = r.state;
  r.busy = true;
  const put = (status, more = {}) => { r.state = Object.freeze({ ...before, ...more, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const a = allowed();
  if (!a?.ok || a.relay !== r.sent.origin) return end(before.status, { error: a?.code ?? 'DevnetDepartNotAllowed' });
  let s;
  try {
    s = await post(r.sent.origin, DEVNET_DEPART_STATUS_PATH, { schema: DEVNET_DEPART_STATUS_SCHEMA, signature: r.sent.signature });
    check(object(s) && s.signature === r.sent.signature && ['pending', 'expired', 'processed', 'confirmed', 'finalized', 'failed'].includes(s.status), 'BadDevnetDepartStatus');
  } catch (e) { return end(before.status, { error: codeOf(e, 'DevnetDepartStatusUnavailable') }); }
  if (s.status === 'failed') { let err; try { err = (typeof s.err === 'string' ? s.err : JSON.stringify(s.err)).slice(0, 200); } catch { err = 'Failed'; } return end('failed', { code: err, error: null, chain: 'failed', slot: s.slot ?? null }); }
  if (s.status === 'confirmed' || s.status === 'finalized') return end('confirmed', { error: null, code: null, chain: s.status, slot: s.slot ?? null });
  return end(before.status, { error: null, chain: s.status, slot: Number.isSafeInteger(s.slot) ? s.slot : null });
}

/** sha256 hex of bytes (tests and the driver's checks). */
export const devnetDepartDigest = b => toHex(sha256(Uint8Array.from(b)));
