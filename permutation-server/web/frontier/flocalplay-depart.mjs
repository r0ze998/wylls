// Local play only: the departure of the boundary draft, from the page's memory-only test wallet, through the
// loopback relay's two dedicated routes. One narrow way through the local-play read-only gate (controller.mjs):
//
//   the reviewed draft (fexpedition-compose.mjs) ── seal (seal-wide.mjs, injected) ──▶ public commit + seal
//     ──▶ POST /gw/f/local-play/depart/prepare (the full canonical request of fexpedition-depart-prepare.mjs)
//           ──▶ {report, submit}: the keeper's prepared report, checked whole by departPreparationReport
//     ──▶ the memory-only wallet signs THAT message (fephemeral-wallet.mjs) ──▶ checked again, signature verified
//     ──▶ POST /gw/f/local-play/depart/submit {schema, message_digest, transaction_b64}   ONCE for a run
//     ──▶ POST /gw/f/local-play/depart/status {schema, signature}   as often as asked: the only reconciliation
//
// It runs only when ALL of these hold (localDepartAllowed): the page is in local play with its verified identity,
// the cluster is localnet, the page and the relay are loopback, the acting wallet is the identity's wallet and is
// the live memory-only wallet. Nothing here serves a public cluster, a stored key, a session key or another relay
// route. Everything that knows the three routes' shape (permutation-gateway local-play-relay.mjs) is in this file.
//
// What is kept: one run a page state (a WeakMap, never storage), and, apart from it, the seals' reveals (plain +
// salt) by host and transit slot: kept in memory whatever happened to the transaction and whatever the card does
// (clearing the run's lines does not touch them); a reload loses them, and with them the way to open the march.
// An outcome that is not known is `unknown`, never success: it is asked about by its FIRST signature on the status
// route; nothing is sealed, prepared, signed or submitted a second time for it.
import { departPreparationRequest, departPreparationReport, publicSealOk } from './fexpedition-depart-prepare.mjs';
import { OUTBOUND_POP, reconcileOutbound, outboundClockSeen } from './fexpedition-compose.mjs';
import { unpackWidePlain } from './fexpedition-seal.mjs';
import { isLoopbackHost } from './fephemeral-wallet.mjs';
import { parseTransaction, wireTransaction } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromBase64, toBase64, fromHex, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const LOCAL_DEPART_SUBMIT_SCHEMA = 'frontier-local-play-depart-submit-v1';
export const LOCAL_DEPART_PREPARE_PATH = '/gw/f/local-play/depart/prepare';
export const LOCAL_DEPART_SUBMIT_PATH = '/gw/f/local-play/depart/submit';
export const LOCAL_DEPART_STATUS_SCHEMA = 'frontier-local-play-depart-status-v1';
export const LOCAL_DEPART_STATUS_PATH = '/gw/f/local-play/depart/status';
const PATHS = [LOCAL_DEPART_PREPARE_PATH, LOCAL_DEPART_SUBMIT_PATH, LOCAL_DEPART_STATUS_PATH];
export const LOCAL_DEPART_MAX_BYTES = 64 * 1024;
export const LOCAL_DEPART_TIMEOUT_MS = 30_000;
/** The steps of a run, in order; the last four are ends. */
export const LOCAL_DEPART_STEPS = Object.freeze(['sealing', 'preparing', 'signing', 'submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'error']);
const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hex = (v, bytes) => typeof v === 'string' && v.length === 2 * bytes && /^[0-9a-f]*$/.test(v);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e.code) ? e.code : fallback);

/** The loopback origin of a relay address (a relative one is read against the page's own), or null: http(s), a loopback host, no credentials. */
export function loopbackRelay(relay, base = globalThis.location?.href) {
  try {
    if (typeof relay !== 'string' || !relay) return null;
    const u = base ? new URL(relay, base) : new URL(relay);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !isLoopbackHost(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Whether this page may run a local-play departure now: `{ok: true, relay}` or `{ok: false, code}`.
 * `localPlay` is the page's verified identity (flocalplay.mjs → cfg.localPlay), `wallet` the connected wallet's
 * address, `signer` the live memory-only wallet (fephemeral-wallet.mjs currentEphemeralWallet()).
 */
export function localDepartAllowed({ localPlay, cluster, hostname = globalThis.location?.hostname, relay, wallet, signer } = {}) {
  const no = code => ({ ok: false, code });
  if (!object(localPlay) || !address(localPlay.address) || !address(localPlay.programId) || !address(localPlay.seasonAddress)) return no('LocalDepartNotLocalPlay');
  if (cluster !== 'localnet' || localPlay.cluster !== 'localnet') return no('LocalDepartCluster');
  if (!isLoopbackHost(hostname)) return no('LocalDepartHost');
  const origin = loopbackRelay(relay);
  if (!origin) return no('LocalDepartRelay');
  if (typeof wallet !== 'string' || wallet !== localPlay.address) return no('LocalDepartWallet');
  if (!signer || signer.destroyed !== false || signer.address !== wallet || !signer.wallet?.features?.['solana:signTransaction']) return no('LocalDepartSigner');
  return { ok: true, relay: origin };
}

/**
 * The relay's `prepare` answer `{report, submit}`, believed in nothing: the report is the keeper's prepared report
 * and is checked whole against this request (departPreparationReport: every closed flag, the echo, the source, the
 * blockhash, the message instruction by instruction and account by account); `submit` names that message, this
 * wallet as its one signer and the submit route's schema. → `{message, digest, blockhash, lastValidBlockHeight}`
 * (frozen), or throws a code (a blocked report: its blocker's code).
 */
export function localDepartPrepared(value, request) {
  check(object(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'report') && Object.hasOwn(value, 'submit') && object(value.report), 'BadLocalDepartPrepared');
  const report = departPreparationReport(value.report, request);
  // (a blocked report comes with no submit note: its own blocker is what the player is told)
  if (report.status !== 'prepared') { check(value.submit === null, 'BadLocalDepartPrepared'); fail(codeOf(report.blocker, 'LocalDepartBlocked')); }
  const p = report.prepared, s = value.submit;
  check(object(s), 'BadLocalDepartPrepared');
  check(request.payer === request.wallet && same(p.signers, [request.wallet]) && p.fee_payer === request.wallet, 'LocalDepartSignerMismatch');
  check(Object.keys(s).length === 5 && s.route === 'POST /f/local-play/depart/submit' && s.schema === LOCAL_DEPART_SUBMIT_SCHEMA && s.message_digest === p.message_digest
    && s.last_valid_block_height === report.blockhash.last_valid_block_height && s.signer === request.wallet, 'LocalDepartSubmitMismatch');
  return Object.freeze({ message: fromBase64(p.message_b64), digest: p.message_digest, blockhash: report.blockhash.hash, lastValidBlockHeight: report.blockhash.last_valid_block_height });
}

/**
 * What the wallet returned for `prepared.message`: the same message, byte for byte, with exactly one signature, this
 * wallet's, which verifies. → `{wire, signature}` (the signature in base58), or throws a code.
 */
export async function localDepartSigned(signedTransaction, prepared, wallet, { subtle = globalThis.crypto?.subtle } = {}) {
  let tx; try { tx = parseTransaction(Uint8Array.from(signedTransaction)); } catch { fail('LocalDepartSignedMalformed'); }
  check(same([...tx.message], [...prepared.message]) && toHex(sha256(tx.message)) === prepared.digest, 'LocalDepartSignedOtherMessage');
  check(same(tx.signers, [wallet]) && tx.signatures.length === 1 && tx.signatures[0].some(x => x !== 0), 'LocalDepartSignedUnsigned');
  let ok = false;
  try {
    const key = await subtle.importKey('raw', decode(wallet), 'Ed25519', false, ['verify']);   // a PUBLIC key
    ok = await subtle.verify('Ed25519', key, tx.signatures[0], tx.message);
  } catch { ok = false; }
  check(ok === true, 'LocalDepartSignatureInvalid');
  return Object.freeze({ wire: wireTransaction(tx.message, [tx.signatures[0]]), signature: encode(tx.signatures[0]) });
}

/** The relay's `submit` answer for this run's `signature`: `'submitted'` or `'unknown'` (sent, outcome not known), or throws. */
export function localDepartSubmitted(value, signature) {
  check(object(value) && ['submitted', 'unknown'].includes(value.status), 'BadLocalDepartSubmitted');
  check(value.signature === signature, 'LocalDepartSubmittedOtherSignature');
  return value.status;
}

/**
 * The relay's `status` answer for `signature`: `{status, err, slot}` with status one of pending | processed |
 * confirmed | finalized | failed, or throws. `failed` carries the chain's own error (JSON text, shortened).
 */
export function localDepartStatus(value, signature) {
  check(object(value) && value.signature === signature && ['pending', 'processed', 'confirmed', 'finalized', 'failed'].includes(value.status), 'BadLocalDepartStatus');
  check((value.status === 'failed') === (value.err !== null && value.err !== undefined), 'BadLocalDepartStatus');
  let err = null; if (value.status === 'failed') { try { err = (typeof value.err === 'string' ? value.err : JSON.stringify(value.err)).slice(0, 200); } catch { err = 'Failed'; } }
  return Object.freeze({ status: value.status, err, slot: Number.isSafeInteger(value.slot) ? value.slot : null });
}

/** One bounded POST of JSON to one of the three loopback routes; never a retry, never credentials. → the parsed answer; a refusal throws its code. */
export async function postLocalDepart(origin, path, body, { fetch: fetcher = (...a) => globalThis.fetch(...a), signal, timeoutMs = LOCAL_DEPART_TIMEOUT_MS } = {}) {
  check(loopbackRelay(origin, null) === origin && PATHS.includes(path), 'LocalDepartRelay');
  const text = JSON.stringify(body);
  check(text.length <= LOCAL_DEPART_MAX_BYTES, 'LocalDepartRequestTooLarge');
  const timer = new AbortController(), t = setTimeout(() => timer.abort(), timeoutMs);
  const onAbort = () => timer.abort(); signal?.addEventListener?.('abort', onAbort, { once: true }); if (signal?.aborted) timer.abort();
  try {
    const res = await fetcher(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: timer.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const raw = await res.text();
    check(raw.length <= LOCAL_DEPART_MAX_BYTES, 'LocalDepartAnswerTooLarge');
    let value; try { value = JSON.parse(raw); } catch { fail('LocalDepartAnswerMalformed'); }
    if (!res.ok) throw Object.assign(new Error('the local-play relay refused'), { code: codeOf(object(value) ? value : null, 'LocalDepartRelayRefused'), refused: true });
    return value;
  } finally { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); }
}

// ------------------------------------------------------------------ the reveals (memory only)
const reveals = new WeakMap();
const revealsOf = fs => { let m = reveals.get(fs); if (!m) { m = new Map(); reveals.set(fs, m); } return m; };
const revealKey = (host, transitSlot, commit) => `${host}|${transitSlot}|${commit}`;
/**
 * The reveals this page holds, oldest first: `{host, transitSlot, commit, arriveBell, requestId, signature, plain, salt,
 * ctHash, sealRoot, holding, revealed}`.
 * One a host, transit slot and commit: every seal made here keeps its own, and none is replaced or dropped by a
 * later seal, a later run, or the card (`signature` is set once that seal's transaction was signed for sending).
 * Memory only: never written, never posted, lost on reload — and with it the way to open that march on arrival.
 */
export const localDepartReveals = fs => [...revealsOf(fs).values()];
/** The reveals of a host and transit slot (all commits), or the one of a commit (hex). */
export const localDepartRevealFor = (fs, host, transitSlot, commit = null) => (commit !== null ? revealsOf(fs).get(revealKey(host, transitSlot, commit)) ?? null
  : localDepartReveals(fs).filter(x => x.host === host && x.transitSlot === transitSlot));

// ------------------------------------------------------------------ the run
const runs = new WeakMap();
const idle = () => Object.freeze({ status: 'idle', busy: false, requestId: null, signature: null, digest: null, code: null, error: null, arriveBell: null, transitSlot: null, host: null, sent: false, chain: null, slot: null });
const runOf = fs => { let r = runs.get(fs); if (!r) { r = { state: idle(), busy: false, sent: null, spent: null, seq: 0 }; runs.set(fs, r); } return r; };
/** The outcomes that are not settled: the transaction was (or may have been) sent and the chain has not said. */
const OPEN = ['unknown', 'submitted'];
/** The run's state for the page: `{status, busy, requestId, signature, digest, code, error, arriveBell, transitSlot, host, sent, chain, slot}`. */
export const localDepartOf = fs => runOf(fs).state;
/**
 * Whether the draft's observation of the departure conditions is the one a departure was already sent on. A sent
 * departure uses its observation up, whatever became of it: the same "conditions hold" is never sent on twice. A
 * fresh read of the conditions (a new observation: the chain as it is now) is needed first; another draft, with its
 * own observation, is not touched. Clearing the card's lines does not bring a spent observation back.
 */
export const localDepartSpent = fs => { const c = fs.expeditionCompose?.contextCheck ?? null; return c !== null && runOf(fs).spent === c; };
/**
 * Forget a finished run's lines (the card closed, or the player starts another draft). A run in flight, or one whose
 * outcome is not settled, is NOT forgotten: its signature is the only way to ask what became of it. The reveals are
 * not this run's to forget (localDepartReveals).
 */
export function clearLocalDepart(fs) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return false;
  r.state = idle(); r.sent = null;
  return true;
}

/**
 * Run the departure of the boundary draft as it stands. `deps`:
 *   allowed()            → localDepartAllowed(...) of the page now (asked before every step that leaves the page)
 *   context()            → the composer's context (controller.mjs expeditionContext)
 *   sealInput()          → `{clock, drand, seasonPkHash, seasonNetwork, cluster}` for the seal
 *   seal(req)            → seal-wide.mjs sealWide
 *   signer()             → the live memory-only wallet
 *   post(origin, path, body) → postLocalDepart (a stand-in in tests)
 *   changed()            → the page repaints
 * One run at a time: a press while one runs, or while an outcome is not settled, starts nothing and returns the
 * state as it is. Only `confirmed` is a success; `submitted` and `unknown` say so and wait for the status.
 */
export async function runLocalDepart(fs, { allowed, context, sealInput, seal, signer, post = postLocalDepart, changed = () => {}, requestId } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  r.busy = true; r.sent = null;
  const id = requestId ?? `lp_${Date.now().toString(36)}_${++r.seq}`;
  let base = { requestId: id };
  const put = (status, more = {}) => { base = { ...base, ...more }; r.state = Object.freeze({ ...idle(), ...base, status, busy: r.busy }); try { changed(); } catch { /* the page's repaint is not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const gate = () => { const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalDepartNotAllowed'); return a.relay; };
  try {
    gate();
    // the draft as it stands: reviewed, with its roles and its observed free transit slot
    // (reconciled first, then read: a tick first noticed here has already worked the review out again and dropped the
    // observation, and it is that draft this run is about)
    const ctx = context();
    check(fs.hand?.pop === OUTBOUND_POP && reconcileOutbound(fs, ctx), 'DepartDraftUnavailable');
    const draft = fs.expeditionCompose, review = draft?.review;
    check(!!draft?.source && draft.status === 'review' && !!review, 'DepartDraftUnavailable');
    const observation = draft.contextCheck ?? null;
    check(observation === null || r.spent !== observation, 'DepartObservationSpent');
    // The draft this run is about, asked before every step that leaves the page. The reconcile comes FIRST: it is what
    // notices that the clock has run on (the review is then worked out again and the observation dropped) or that the
    // source has changed. Only after it are the review, the observation and the clock this run began with compared:
    // asked the other way round, a tick first noticed here would have passed with the old review and observation.
    const seen = outboundClockSeen(fs);
    const still = () => {
      if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, context())) return false;
      let now = null; try { now = outboundClockSeen(fs); } catch { return false; }
      return fs.expeditionCompose === draft && draft.review === review && (draft.contextCheck ?? null) === observation && now === seen;
    };
    const host = draft.source.host, transitSlot = review.transitSlot;
    put('sealing', { arriveBell: review.arriveBell, transitSlot, host });
    let plain; try { plain = unpackWidePlain(fromHex(review.plainHex)); } catch { fail('DepartDraftUnavailable'); }
    const sealed = await seal({ plain, host, arriveBell: review.arriveBell, ...sealInput() });
    if (!sealed?.ok) fail(codeOf(sealed, 'LocalDepartSealFailed'));
    const pub = { commit: toHex(sealed.commit), seal: toHex(sealed.seal) };
    check(publicSealOk(pub), 'LocalDepartSealFailed');
    // (kept from here on, whatever happens next: the reveal is the only way to open this march later)
    // (with what a later Reveal needs beside the plaintext and salt: the seal's public ciphertext hash and root, and
    // the village the transit is embedded in; flocalplay-reveal.mjs. `revealed` is set there once the chain has
    // confirmed the Reveal; the record itself is never dropped)
    const reveal = { host, transitSlot, commit: pub.commit, arriveBell: review.arriveBell, requestId: id, signature: null, plain: Uint8Array.from(sealed.reveal.plain), salt: Uint8Array.from(sealed.reveal.salt),
      ctHash: sealed.ctHash ? Uint8Array.from(sealed.ctHash) : null, sealRoot: sealed.sealRoot ? Uint8Array.from(sealed.sealRoot) : null, holding: draft.source.holding ?? null, revealed: null };
    check(!revealsOf(fs).has(revealKey(host, transitSlot, pub.commit)), 'LocalDepartSealFailed');   // (a fresh seal has a fresh commit)
    revealsOf(fs).set(revealKey(host, transitSlot, pub.commit), reveal);
    check(still(), 'DepartDraftChanged');
    const request = departPreparationRequest(fs, { sealed: pub, requestId: id });
    const identity = fs.localPlay;
    check(request.cluster === 'localnet' && request.program === identity?.programId && request.season === identity?.seasonAddress
      && request.wallet === identity?.address && request.payer === request.wallet, 'LocalDepartIdentityMismatch');
    put('preparing');
    const prepared = localDepartPrepared(await post(gate(), LOCAL_DEPART_PREPARE_PATH, request), request);
    check(still(), 'DepartDraftChanged');
    put('signing', { digest: prepared.digest });
    const w = signer(); gate();
    check(w?.address === request.wallet && w.destroyed === false, 'LocalDepartSigner');
    const account = (await w.wallet.features['standard:connect'].connect()).accounts.find(a => a.address === request.wallet);
    check(!!account, 'LocalDepartSigner');
    // (the connect was awaited: the page, the wallet and the draft are asked again before anything is signed)
    gate(); check(signer() === w && w.destroyed === false, 'LocalDepartSigner'); check(still(), 'DepartDraftChanged');
    const [out] = await w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(prepared.message, []) });
    const signed = await localDepartSigned(out?.signedTransaction ?? [], prepared, request.wallet);
    check(still(), 'DepartDraftChanged');
    const origin = gate();
    // from here the transaction may reach the chain: its signature is this run's for good, and is the reveal's
    reveal.signature = signed.signature;
    r.sent = Object.freeze({ origin, signature: signed.signature });
    put('submitting', { signature: signed.signature });
    // (the repaint above is the page's code and may have closed the card, changed the draft or the wallet: asked
    // again, in this same turn of the loop as the POST. Refused here, nothing was sent: `sent` stays false)
    check(gate() === origin && signer() === w && w.destroyed === false, 'LocalDepartSigner'); check(still(), 'DepartDraftChanged');
    // (said without another repaint: nothing of the page's runs between this check and the POST)
    base = { ...base, sent: true }; r.state = Object.freeze({ ...r.state, sent: true });
    r.spent = observation;   // (this observation has been sent on: used up, whatever the outcome)
    let answer;
    try { answer = localDepartSubmitted(await post(origin, LOCAL_DEPART_SUBMIT_PATH, { schema: LOCAL_DEPART_SUBMIT_SCHEMA, message_digest: prepared.digest, transaction_b64: toBase64(signed.wire) }), signed.signature); } catch (e) {
      // no answer, a refusal or one that cannot be believed: whether the transaction went out is not known here.
      // It is asked about by its signature (reconcileLocalDepart); it is never submitted again.
      return end('unknown', { error: codeOf(e, 'LocalDepartOutcomeUnknown') });
    }
    r.busy = false; put(answer);
    // one look at the chain's word straight away; whatever it says, the state stays honest
    return await reconcileLocalDepart(fs, { allowed, post, changed });
  } catch (e) {
    return end('error', { error: codeOf(e, 'LocalDepartFailed') });
  }
}

/**
 * Ask what became of a run whose outcome is not settled (`unknown` or `submitted`): its FIRST signature goes to the
 * status route, and only there. Nothing is sealed, prepared, signed or submitted again. `allowed()` is asked first.
 *   confirmed | finalized → `confirmed`;  failed → `failed` (the chain's error in `code`);
 *   processed | pending   → the state stays as it was (`chain` says which);
 *   no answer, or a refusal (also "not a signature this relay submitted": a restarted relay has forgotten it, so
 *   that proves nothing) → the state stays, with the error. `failed` is only ever the chain's own error. → the state.
 */
export async function reconcileLocalDepart(fs, { allowed, post = postLocalDepart, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || !r.sent || !OPEN.includes(r.state.status)) return r.state;
  const before = r.state;
  r.busy = true;
  const put = (status, more = {}) => { r.state = Object.freeze({ ...before, ...more, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const a = allowed();
  if (!a?.ok || a.relay !== r.sent.origin) return end(before.status, { error: a?.code ?? 'LocalDepartRelay' });
  put(before.status);
  let s;
  try { s = localDepartStatus(await post(r.sent.origin, LOCAL_DEPART_STATUS_PATH, { schema: LOCAL_DEPART_STATUS_SCHEMA, signature: r.sent.signature }), r.sent.signature); } catch (e) {
    return end(before.status, { error: codeOf(e, 'LocalDepartStatusUnavailable') });
  }
  if (s.status === 'failed') return end('failed', { code: s.err, error: null, chain: 'failed', slot: s.slot });
  if (s.status === 'confirmed' || s.status === 'finalized') return end('confirmed', { error: null, code: null, chain: s.status, slot: s.slot });
  return end(before.status, { error: null, chain: s.status, slot: s.slot });
}
