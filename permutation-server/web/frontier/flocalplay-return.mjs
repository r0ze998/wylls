// Local play only: the two player-signed steps of the existing return of an original host that stays in wide land,
// from the return card's own observation (fexpedition.mjs inspection → fexpedition-return.mjs model):
//
//   OwnerDissolve ("Dissolve")  →  [ResolveVoluntaryLeave: the turn's own processing; nothing is signed for it]
//                               →  ReturnOriginalReserve ("Return")
//
// Which of the two is offered is never chosen here: it is the step the card's validated observation names, and the
// request is rebuilt from that observation (fexpedition-prepare.mjs preparationRequest), never from a caller's bytes.
// Two presses, never one:
//
//   1. prepare   POST /gw/f/local-play/resident/prepare   the existing full preparation request → `{report, submit}`.
//                The report is checked whole against this request (preparationReport: every closed flag, the echo,
//                the source, the blockhash, the unsigned message instruction by instruction and account by account);
//                `submit` names that message and this wallet as its one signer. Nothing is signed. The page then
//                shows what would be signed.
//   2. send      the player's explicit press: the memory-only wallet signs THAT message, the signature is verified
//                here, and it is submitted ONCE   POST /gw/f/local-play/resident/submit
//      then      POST /gw/f/local-play/resident/status   as often as asked: the only reconciliation.
//
// The same gate as the local-play departure (localDepartAllowed). The identity (program, Season, cluster, wallet, the
// live signer, the verified program version and ruleset) and the observation (the card's state, its report and
// request, the herald, the relay, the wallet and session objects, the selection still naming the same request) are
// taken at `prepare` and asked again after every wait: a page that is another one ends the run unsent.
//
// An outcome that is not known is `unknown`: asked about by its first signature, never signed or sent again. An
// observation a step was sent on is used up: the card must read again before another step. "confirmed" says the
// chain confirmed THIS step's transaction and no more: after Dissolve the turn still has to be processed, and after
// Return the card's next read is what shows the reserve. Nothing here adds to a reserve or marks a return complete.
// Nothing is stored; no key leaves the wallet.
import { loopbackRelay } from './flocalplay-depart.mjs';
import { registerHostStep, claimHostStep, holdHostStep, hostStepInFlight, spendHostObservation, hostObservationSpent } from './flocalplay-hoststep.mjs';
import { LOCAL_PLAY_PROGRAM_VERSION } from './flocalplay.mjs';
import { inspectionRequest } from './fexpedition.mjs';
import { originalReturnModel } from './fexpedition-return.mjs';
import { preparationRequest, preparationReport } from './fexpedition-prepare.mjs';
import { parseTransaction, wireTransaction } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromBase64, toBase64, toHex } from '../sdk/bytes.mjs';

export const LOCAL_RETURN_SUBMIT_SCHEMA = 'frontier-local-play-resident-submit-v1';
export const LOCAL_RETURN_STATUS_SCHEMA = 'frontier-local-play-resident-status-v1';
export const LOCAL_RETURN_PREPARE_PATH = '/gw/f/local-play/resident/prepare';
export const LOCAL_RETURN_SUBMIT_PATH = '/gw/f/local-play/resident/submit';
export const LOCAL_RETURN_STATUS_PATH = '/gw/f/local-play/resident/status';
const PATHS = [LOCAL_RETURN_PREPARE_PATH, LOCAL_RETURN_SUBMIT_PATH, LOCAL_RETURN_STATUS_PATH];
export const LOCAL_RETURN_MAX_BYTES = 48 * 1024;
export const LOCAL_RETURN_TIMEOUT_MS = 35_000;
export const LOCAL_RETURN_ACTIONS = Object.freeze(['Dissolve', 'Return']);

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e.code) ? e.code : fallback);
const stable = x => JSON.stringify(x, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

/**
 * The relay's `prepare` answer `{report, submit}` for `request`, believed in nothing. → `{message, digest, action,
 * lastValidBlockHeight}` (frozen), or throws a code (a blocked report: its blocker's code).
 */
export function localReturnPrepared(value, request) {
  check(object(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'report') && Object.hasOwn(value, 'submit') && object(value.report), 'BadLocalReturnPrepared');
  const report = preparationReport(value.report, request);
  // (a blocked report comes with no submit note: its own blocker is what the player is told)
  if (report.status !== 'prepared') { check(value.submit === null, 'BadLocalReturnPrepared'); fail(codeOf(report.blocker, 'LocalReturnBlocked')); }
  const p = report.prepared, s = value.submit, wallet = request.source_request.wallet;
  check(object(s), 'BadLocalReturnPrepared');
  // (local play: the acting wallet pays, and it alone signs: both steps, as the relay pins it)
  check(address(wallet) && request.source_request.payer === wallet && p.fee_payer === wallet && same(p.signers, [wallet]) && LOCAL_RETURN_ACTIONS.includes(p.action) && p.action === request.action, 'LocalReturnSignerMismatch');
  check(Object.keys(s).length === 5 && s.route === 'POST /f/local-play/resident/submit' && s.schema === LOCAL_RETURN_SUBMIT_SCHEMA && s.message_digest === p.message_digest
    && s.last_valid_block_height === report.blockhash.last_valid_block_height && s.signer === wallet, 'LocalReturnSubmitMismatch');
  return Object.freeze({ message: fromBase64(p.message_b64), digest: p.message_digest, action: p.action, lastValidBlockHeight: report.blockhash.last_valid_block_height });
}

/** One bounded POST of JSON to one of the three loopback resident routes; never a retry, never credentials. A refusal throws its code with `refused`. */
export async function postLocalReturn(origin, path, body, { fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = LOCAL_RETURN_TIMEOUT_MS } = {}) {
  check(loopbackRelay(origin, null) === origin && PATHS.includes(path), 'LocalReturnRelay');
  const text = JSON.stringify(body);
  check(text.length <= LOCAL_RETURN_MAX_BYTES, 'LocalReturnRequestTooLarge');
  const timer = new AbortController(), t = setTimeout(() => timer.abort(), timeoutMs);
  try {
    const res = await fetcher(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: timer.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const raw = await res.text();
    check(raw.length <= LOCAL_RETURN_MAX_BYTES, 'LocalReturnAnswerTooLarge');
    let value; try { value = JSON.parse(raw); } catch { fail('LocalReturnAnswerMalformed'); }
    if (!res.ok) throw Object.assign(new Error('the local-play relay refused'), { code: codeOf(object(value) ? value : null, 'LocalReturnRelayRefused'), refused: true });
    return value;
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ the run (memory only)
const runs = new WeakMap();
const idle = () => Object.freeze({ status: 'idle', busy: false, action: null, host: null, digest: null, returnUnits: null, reserveAfter: null, lastValidBlockHeight: null,
  requestId: null, signature: null, code: null, error: null, sent: false, chain: null, slot: null });
const runOf = fs => { let r = runs.get(fs); if (!r) { r = { state: idle(), busy: false, held: null, sent: null, spent: null }; runs.set(fs, r); } return r; };
const OPEN = ['unknown', 'submitted'];
/** The return step's state for the card: `{status, busy, action, host, digest, returnUnits, reserveAfter, lastValidBlockHeight, requestId, signature, code, error, sent, chain, slot}`. */
export const localReturnOf = fs => runOf(fs).state;
/** Whether the card's present observation was already used to send a step (it must be read again before another). */
export const localReturnSpent = fs => hostObservationSpent(fs, fs?.expeditionPreview?.report);
// (one step at a time for the observed host, across the step modules, and one shared record of used observations:
// flocalplay-hoststep.mjs. A siege in flight or of unknown outcome blocks a return step, and the reverse)
registerHostStep('return', fs => { const r = runOf(fs); return { busy: r.busy, open: OPEN.includes(r.state.status), prepared: r.held !== null,
  discard() { if (!r.busy && r.held !== null) { r.held = null; r.state = idle(); } } }; });
/** Forget a settled step's lines. One in flight, or whose outcome is not settled, is not forgotten. A used observation stays used. */
export function clearLocalReturn(fs) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return false;
  r.state = idle(); r.held = null; r.sent = null;
  return true;
}

const rulesetOf = fs => { const x = fs?.season?.rulesetHash, h = x instanceof Uint8Array && x.length === 32 ? toHex(x) : x; return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) && h !== '0'.repeat(64) ? h : null; };
/** The identity and the observation a step is prepared under, taken once. */
function capture(fs, ctx, signer) {
  const i = fs?.localPlay;
  check(object(i) && address(i.programId) && address(i.seasonAddress) && address(i.address) && i.cluster === 'localnet', 'LocalReturnIdentity');
  check(!!signer && signer.destroyed === false && signer.address === i.address, 'LocalReturnSigner');
  const ruleset = rulesetOf(fs);
  check(fs.season?.programVersion === LOCAL_PLAY_PROGRAM_VERSION && ruleset !== null, 'LocalReturnDeployment');
  const state = fs.expeditionPreview;
  check(object(state) && object(state.report) && object(state.request), 'ReturnObservationMissing');
  const selected = inspectionRequest(fs, ctx);
  check(stable(selected) === stable(state.request), 'ReturnSelectionChanged');
  // (the request the card observed is this identity's own: this wallet acts and pays, on this program and Season)
  check(selected.wallet === i.address && selected.payer === i.address && selected.program === i.programId && selected.season === i.seasonAddress && selected.cluster === i.cluster
    && selected.deployment.program_version === String(LOCAL_PLAY_PROGRAM_VERSION) && selected.deployment.ruleset_hash === ruleset, 'LocalReturnIdentity');
  return { pin: Object.freeze({ programId: i.programId, seasonAddress: i.seasonAddress, seasonId: String(i.seasonId), cluster: i.cluster, address: i.address, signer, ruleset }),
    snap: { state, report: state.report, request: state.request, source: ctx.source, relay: ctx.relay, wallet: fs.wallet, session: fs.session }, selected };
}
/** Whether the page is still the one captured: the same identity, signer, card observation and selection. */
function holds(fs, ctx, signer, { pin, snap }) {
  try {
    const i = fs?.localPlay;
    return object(i) && i.programId === pin.programId && i.seasonAddress === pin.seasonAddress && String(i.seasonId) === pin.seasonId && i.cluster === pin.cluster && i.address === pin.address
      && signer === pin.signer && signer.destroyed === false && signer.address === pin.address && fs.season?.programVersion === LOCAL_PLAY_PROGRAM_VERSION && rulesetOf(fs) === pin.ruleset
      && fs.expeditionPreview === snap.state && snap.state.report === snap.report && snap.state.request === snap.request
      && ctx.source === snap.source && ctx.relay === snap.relay && fs.wallet === snap.wallet && fs.session === snap.session
      && stable(inspectionRequest(fs, ctx)) === stable(snap.request);
  } catch { return false; }
}

/**
 * Press 1: prepare the step the card's observation names. Nothing is signed or sent. → the state: `prepared` (with
 * the action, the message digest and, for Return, the units the observation gives), or `error`. `deps`: `allowed()`,
 * `context()`, `signer()`, `post`, `changed()`, `requestId`.
 */
export async function prepareLocalReturn(fs, { allowed, context, signer, post = postLocalReturn, changed = () => {}, requestId } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  r.busy = true; r.held = null;
  let base = {};
  const put = (status, more = {}) => { base = { ...base, ...more }; r.state = Object.freeze({ ...idle(), ...base, status, busy: r.busy }); try { changed(); } catch { /* the page's repaint is not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  try {
    // (no other step of this host in flight or unsettled; another step's merely prepared message is discarded)
    claimHostStep(fs, 'return');
    const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalReturnNotAllowed');
    const origin = a.relay, ctx = context(), cap = capture(fs, ctx, signer());
    check(!hostObservationSpent(fs, fs.expeditionPreview.report), 'ReturnObservationSpent');
    const model = originalReturnModel(cap.snap.report, cap.selected);
    check(!!model.proposal && LOCAL_RETURN_ACTIONS.includes(model.proposal.action), 'ReturnStepUnavailable');
    const request = requestId === undefined ? preparationRequest(cap.snap.report, cap.selected) : preparationRequest(cap.snap.report, cap.selected, requestId);
    const still = () => { const g = allowed(); check(g?.ok && g.relay === origin, g?.code ?? 'LocalReturnNotAllowed'); check(holds(fs, context(), signer(), cap), 'LocalReturnChanged');
      check(hostStepInFlight(fs, 'return') === null, 'HostStepInFlight'); check(!hostObservationSpent(fs, fs.expeditionPreview.report), 'ReturnObservationSpent'); };
    put('preparing', { action: request.action, host: cap.selected.host, requestId: request.request_id, returnUnits: model.returnUnits, reserveAfter: model.reserveAfter });
    still();
    const prepared = localReturnPrepared(await post(origin, LOCAL_RETURN_PREPARE_PATH, request), request);
    still();
    r.held = { cap, origin, request, prepared };
    return end('prepared', { digest: prepared.digest, lastValidBlockHeight: prepared.lastValidBlockHeight });
  } catch (e) {
    return end('error', { error: codeOf(e, 'LocalReturnFailed') });
  }
}

/**
 * Press 2, the player's explicit send: only after `prepared`, and only what was prepared. The memory-only wallet signs
 * that very message; the signature is verified here; the gate, the identity and the observation are asked again after
 * connect, after the signature and in the same turn as the POST; then ONE submit. `deps`: `allowed()`, `context()`,
 * `signer()`, `post`, `changed()`.
 */
export async function sendLocalReturn(fs, { allowed, context, signer, post = postLocalReturn, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  const held = r.held;
  if (r.state.status !== 'prepared' || !held) return r.state;
  r.busy = true; r.sent = null; r.held = null;   // (a prepared message is offered once: whatever happens next, it is not offered again)
  const { cap, origin, prepared } = held, wallet = cap.pin.address, w = cap.pin.signer;
  let base = { ...r.state };
  const put = (status, more = {}) => { base = { ...base, ...more }; r.state = Object.freeze({ ...base, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const still = () => { const g = allowed(); check(g?.ok && g.relay === origin, g?.code ?? 'LocalReturnNotAllowed'); check(holds(fs, context(), signer(), cap), 'LocalReturnChanged');
    holdHostStep(fs, 'return'); check(!hostObservationSpent(fs, fs.expeditionPreview.report), 'ReturnObservationSpent'); };
  try {
    still();
    put('signing'); still();
    const account = (await w.wallet.features['standard:connect'].connect()).accounts.find(x => x.address === wallet);
    check(!!account, 'LocalReturnSigner');
    still();
    const [out] = await w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(prepared.message, []) });
    still();
    let tx; try { tx = parseTransaction(Uint8Array.from(out?.signedTransaction ?? [])); } catch { fail('LocalReturnSignedMalformed'); }
    check(same([...tx.message], [...prepared.message]) && same(tx.signers, [wallet]) && tx.signatures.length === 1 && tx.signatures[0].some(x => x !== 0), 'LocalReturnSignedOtherMessage');
    let ok = false;
    try { const key = await globalThis.crypto.subtle.importKey('raw', decode(wallet), 'Ed25519', false, ['verify']); ok = await globalThis.crypto.subtle.verify('Ed25519', key, tx.signatures[0], tx.message); } catch { ok = false; }
    check(ok === true, 'LocalReturnSignatureInvalid');
    const signature = encode(tx.signatures[0]), wire = wireTransaction(tx.message, [tx.signatures[0]]);
    put('submitting', { signature });
    // (the repaint above is the page's own code: asked again in this same turn of the loop as the POST)
    still();
    r.sent = Object.freeze({ origin, signature, pin: cap.pin });
    spendHostObservation(fs, cap.snap.report);   // (the observation this step is sent on is used up for every step, whatever the outcome)
    base = { ...base, sent: true }; r.state = Object.freeze({ ...r.state, sent: true });
    let answer;
    try {
      const v = await post(origin, LOCAL_RETURN_SUBMIT_PATH, { schema: LOCAL_RETURN_SUBMIT_SCHEMA, message_digest: prepared.digest, transaction_b64: toBase64(wire) });
      check(object(v) && ['submitted', 'unknown'].includes(v.status) && v.signature === signature, 'BadLocalReturnSubmitted');
      answer = v.status;
    } catch (e) {
      // no answer, a refusal or one that cannot be believed: asked about by its signature; never sent again
      return end('unknown', { error: codeOf(e, 'LocalReturnOutcomeUnknown') });
    }
    end(answer);
    // (the first look at the outcome. Whatever goes wrong in it — also a gate or an accessor that throws — the step
    //  stays what the submit made it: `submitted` or `unknown`. It is never turned into a settled `error` here)
    try { return await reconcileLocalReturn(fs, { allowed, post, changed }); }
    catch (e) { r.busy = false; r.state = Object.freeze({ ...r.state, busy: false, error: codeOf(e, 'LocalReturnStatusUnavailable') }); return r.state; }
  } catch (e) {
    // AFTER the POST began (`r.sent` is set and the observation is spent) nothing may leave the step looking settled:
    // an exception from there on is an outcome that is not known. Before it, nothing was sent: `error`.
    if (r.sent !== null && base.sent === true) return end(OPEN.includes(r.state.status) ? r.state.status : 'unknown', { error: codeOf(e, 'LocalReturnOutcomeUnknown') });
    return end('error', { error: codeOf(e, 'LocalReturnFailed') });
  }
}

/**
 * Ask what became of a step whose outcome is not settled: its FIRST signature goes to the status route, and only
 * there. confirmed | finalized → `confirmed`; failed → `failed` with the chain's own error; pending | processed, no
 * answer, a refusal (also "not a signature this relay submitted", which proves nothing) → the state stays as it was.
 */
export async function reconcileLocalReturn(fs, { allowed, post = postLocalReturn, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || !r.sent || !OPEN.includes(r.state.status)) return r.state;
  const before = r.state;
  r.busy = true;
  const put = (status, more = {}) => { r.state = Object.freeze({ ...before, ...more, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  // (the gate and the identity are the page's own code: if either throws, `busy` is released and the step stays as it
  //  was — unsettled. It must never stay busy for good, and never become a settled state by an exception)
  try {
    const a = allowed();
    if (!a?.ok || a.relay !== r.sent.origin) return end(before.status, { error: a?.code ?? 'LocalReturnRelay' });
    // (the status of a signature is only believed for the identity that sent it)
    const i = fs?.localPlay, p = r.sent.pin;
    if (!object(i) || i.programId !== p.programId || i.seasonAddress !== p.seasonAddress || String(i.seasonId) !== p.seasonId || i.address !== p.address) return end(before.status, { error: 'LocalReturnIdentityChanged' });
  } catch (e) { return end(before.status, { error: codeOf(e, 'LocalReturnGateFailed') }); }
  put(before.status);
  let s;
  try {
    const v = await post(r.sent.origin, LOCAL_RETURN_STATUS_PATH, { schema: LOCAL_RETURN_STATUS_SCHEMA, signature: r.sent.signature });
    check(object(v) && v.signature === r.sent.signature && ['pending', 'processed', 'confirmed', 'finalized', 'failed', 'expired_unlanded'].includes(v.status), 'BadLocalReturnStatus');
    check((v.status === 'failed') === (v.err !== null && v.err !== undefined), 'BadLocalReturnStatus');
    // "did not land": believed only for THIS step — the relay's last valid height is the one held since prepare, and
    // the slot it read the absence at is a real one past that height. Any other shape is not a settlement.
    if (v.status === 'expired_unlanded') check(typeof before.lastValidBlockHeight === 'string' && v.last_valid_block_height === before.lastValidBlockHeight
      && Number.isSafeInteger(v.context_slot) && BigInt(v.context_slot) > BigInt(before.lastValidBlockHeight), 'BadLocalReturnStatus');
    // (the values are taken HERE, inside the try: nothing of the answer is read after it, so an answer that
    //  throws when read is a status that could not be had — the step stays as it was, and `busy` is released)
    s = { status: v.status, err: v.err ?? null, slot: v.status === 'expired_unlanded' ? v.context_slot : v.slot };
  } catch (e) { return end(before.status, { error: codeOf(e, 'LocalReturnStatusUnavailable') }); }
  const slot = Number.isSafeInteger(s.slot) ? s.slot : null;
  // (terminal: the transaction is not in the chain and can no longer enter it. Nothing was resent; the observation it
  //  was sent on stays used, so a new step needs a new reading)
  if (s.status === 'expired_unlanded') return end('expired', { error: null, code: null, chain: 'expired_unlanded', slot });
  if (s.status === 'failed') { let err = 'Failed'; try { err = (typeof s.err === 'string' ? s.err : JSON.stringify(s.err)).slice(0, 200); } catch { /* kept */ } return end('failed', { code: err, error: null, chain: 'failed', slot }); }
  if (s.status === 'confirmed' || s.status === 'finalized') return end('confirmed', { error: null, code: null, chain: s.status, slot });
  return end(before.status, { error: null, chain: s.status, slot });
}
