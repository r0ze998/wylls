// LOCAL PLAY ONLY — the six economy and mustering commands, signed by the page's own memory-only wallet:
//
//   Join, PlaceHome, Harvest, Build, Train, Muster
//
// The page's general order path (`act` in controller.mjs) stays refused in local play. These six — and only these —
// go through this module instead, as a transport with the same answers as fplay.mjs `submit` and `track`:
//   context   POST /gw/f/local-play/act/context   a blockhash to build on (the relay also names its one wallet)
//   build     the game's OWN builder (fplay.mjs accountsFor / buildShape) with the wallet as fee payer AND actor:
//             one signature, no session key, no sponsor. No command, account list or field is changed.
//   sign      the live memory-only wallet signs exactly that message; the signature is verified here
//   submit    POST /gw/f/local-play/act/submit    ONE POST, with the intent stated beside the transaction; the relay
//             rebuilds the message from the stated intent and refuses anything that is not byte for byte the same
//   status    POST /gw/f/local-play/act/status    the transaction is followed by its signature; nothing is sent again
// A village outside the legacy disk is refused here before anything is asked (a wide holding is another family; the
// controller's own wide guard has already run, and the relay checks the real account again).
// It establishes nothing about a world: whether the relay serves these routes is the relay's and the launcher's.
import { accountsFor, buildShape } from './fplay.mjs';
import { localDepartSigned } from './flocalplay-depart.mjs';
import { seasonAddresses } from './faddr.mjs';
import { ringPosition } from './map/wide.mjs';
import { profileForHash } from '../sdk/frontier/profile.mjs';
import { compileMessage, wireTransaction } from '../sdk/solana-tx.mjs';
import { budgetPrefix } from '../sdk/frontier/budgets.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { toBase64, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const LOCAL_ACT_NAMES = Object.freeze(['Join', 'PlaceHome', 'Harvest', 'Build', 'Train', 'Muster']);
export const LOCAL_ACT_CONTEXT_PATH = '/gw/f/local-play/act/context';
export const LOCAL_ACT_SUBMIT_PATH = '/gw/f/local-play/act/submit';
export const LOCAL_ACT_STATUS_PATH = '/gw/f/local-play/act/status';
export const LOCAL_ACT_CONTEXT_SCHEMA = 'frontier-local-play-act-context-v1';
export const LOCAL_ACT_SUBMIT_SCHEMA = 'frontier-local-play-act-submit-v1';
export const LOCAL_ACT_STATUS_SCHEMA = 'frontier-local-play-act-status-v1';
export const LOCAL_ACT_SEASON_ID = '11';
/**
 * The relay's refusals that are made BEFORE it sends anything (its validation of the stated intent and of the signed
 * bytes, its capacity check, its read of the real accounts, its last question to the runner). A closed list: a code
 * that is not here is never taken to mean "not sent" once the POST has begun. NOT here, on purpose:
 * `LocalActSendRefused` (the send was attempted) and `LocalActMessageUsed` (the bytes or the signature are already known).
 */
export const LOCAL_ACT_PRESEND_REFUSALS = Object.freeze(['LocalActInvalid', 'LocalActNotAllowed', 'LocalActWideHolding', 'LocalActMessageMismatch', 'LocalActSigner',
  'LocalActBusy', 'LocalActAlreadyJoined', 'LocalActCitizen', 'LocalActHolding', 'LocalActNotYourVillage', 'LocalActRpcUnavailable', 'LocalActClosed']);
export const LOCAL_ACT_MAX_BYTES = 16 * 1024;
export const LOCAL_ACT_TIMEOUT_MS = 30_000;

/**
 * WHERE AN ORDER GOES — the one decision the page's order path (`act`, controller.mjs) makes about local play:
 *   'general'    not local play: the game's ordinary path, exactly as it is (this module is never involved)
 *   'local-act'  local play AND one of the six names AND in its plain form: an object of subjects, the default
 *                signer, no requester
 *   'refuse'     local play, anything else: another command; one of the six as a settle shape (`signer: null`), a
 *                wallet-only shape (`signer: 'wallet'`), with a requester, or with accounts that are a function of a
 *                fee payer. Nothing is built, signed or sent for it.
 * `localPlay`: the identity the gate verified, or null.
 */
export function localOrderRoute({ localPlay, name, v, signer, requester }) {
  if (!localPlay) return 'general';
  return LOCAL_ACT_NAMES.includes(name) && v !== null && typeof v === 'object' && !Array.isArray(v) && signer === undefined && (requester === null || requester === undefined) ? 'local-act' : 'refuse';
}

/**
 * The same order, for the "sent, not confirmed" guard: the command, its village (or nation), and its fields. Two
 * presses of the same button with the same values are the same order; another village or another amount is another.
 */
export function localActKey(name, v, fields) {
  // Join is ONE order per wallet and nation, whatever its fields say: its expiry is worked out anew from the clock at
  // every press (and its session key is always the wallet), so neither may tell two presses apart — a Join whose
  // outcome is unknown must hold the next press of Join a second later exactly as it holds one in the same instant.
  if (name === 'Join') return JSON.stringify(['Join', v?.faction ?? null]);
  const h = v?.holding, where = h && typeof h === 'object' ? [h.p, h.q, h.site] : null;
  return JSON.stringify([name, where, v?.faction ?? null, fields ?? {}], (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Array.from(x) : x));
}
/**
 * WHOSE orders, and through which relay: the wallet, the program, the Season and the relay's origin. An order held as
 * "sent, not confirmed" is held under this scope and is asked about only under it: another wallet, another world
 * (program, Season) or another relay never sees it, never asks about it, and cannot let it go — and it is not erased
 * when the page's identity changes: back under the same scope, it is still held. Null when there is no such scope.
 */
export function localActScope({ identity, relay }) {
  if (!object(identity) || !address(identity.address) || !address(identity.programId) || !address(identity.seasonAddress) || typeof relay !== 'string' || relay.length === 0) return null;
  return JSON.stringify([identity.address, identity.programId, identity.seasonAddress, relay]);
}
/**
 * SENT, NOT CONFIRMED — the orders whose ONE transaction left this page and whose outcome is not known yet.
 * While an order is held here, the same order is never built or sent again: a press on it only ASKS what became of
 * the transaction already sent (by its signature). It is released when the chain says it landed or refused it; an
 * unknown outcome keeps it. Held in the page's memory only (a reload forgets it; the relay's own barrier and the
 * chain still stand), and held PER SCOPE (`localActScope`): every call names the scope, and one scope's orders are
 * never returned, asked about or released under another. A null scope holds and finds nothing.
 * → `{held(scope, key), hold(scope, key, {name, signature}), release(scope, key), list(scope)}`.
 */
export function createLocalActLedger() {
  const scopes = new Map();   // scope → Map(key → {name, signature})
  const flying = new Set();   // `${scope}\n${key}` of orders in flight (no signature yet)
  const of = (scope, make = false) => { if (typeof scope !== 'string' || scope.length === 0) return null; let m = scopes.get(scope); if (!m && make) { m = new Map(); scopes.set(scope, m); } return m ?? null; };
  return Object.freeze({
    held: (scope, key) => of(scope)?.get(key) ?? null,
    hold(scope, key, { name, signature }) {
      const m = of(scope, true);
      check(m !== null && typeof signature === 'string' && signature.length > 0 && !m.has(key), 'LocalActLedger');
      m.set(key, Object.freeze({ name, signature }));
    },
    release: (scope, key) => of(scope)?.delete(key) ?? false,
    list: scope => [...(of(scope) ?? [])].map(([key, e]) => ({ key, ...e })),
    // IN FLIGHT: the order is being built, signed or posted right now and has no signature to be held by yet. Taken
    // by the same stable key and scope as a held order, so that a second press during the first one's awaits — also
    // a Join whose expiry would by then be another number — starts nothing.
    begin(scope, key) { if (typeof scope !== 'string' || scope.length === 0) return false; const k = `${scope}\n${key}`; if (flying.has(k) || of(scope)?.has(key)) return false; flying.add(k); return true; },
    end(scope, key) { flying.delete(`${scope}\n${key}`); },
  });
}
/**
 * One order at a time per scope and key: `work()` runs only if the order is neither in flight nor held; otherwise
 * `{ok: false, code: 'InFlight'}` and nothing is started. The slot is given back when `work` settles, whatever it did.
 */
export async function withLocalActSlot(ledger, scope, key, work) {
  if (!ledger.begin(scope, key)) return { ok: false, code: 'InFlight' };
  try { return await work(); } finally { ledger.end(scope, key); }
}
/**
 * A NOTE OF A SENT ORDER, ASKED ABOUT AGAIN (the home choice's "pending" Join or PlaceHome, when the player comes
 * back to it): the same rule as every local order — asked ONCE, at the relay of this scope, only while the page is
 * still this scope; nothing is sent.
 *   'landed' | 'failed'  the chain's own word: the ledger lets go of the order that holds this signature under THIS
 *                        scope (and only then may the caller clear its note)
 *   'unconfirmed'        pending, processed only, or no answer: the note and the held order STAY — it is not a
 *                        failure, and nothing may be sent in its place
 *   'left'               the page is not this scope (any more): nothing was asked or, if it was, nothing of it is used;
 *                        nothing is released and the caller must not touch its note
 * There is no "expired" here: this path never settles a transaction as "did not take effect" by time.
 */
// `note` = `{signature, scope}`: the note as it was written when the order was SENT — with the scope (wallet, world AND
// relay) it was sent under. The home record's own key has no relay in it, so the note itself must say where its
// transaction went:
//   'other-scope'  the note carries no scope, or another one than the page's now (another relay, another wallet, another
//                  world): NOTHING is asked — a signature is never asked of a relay it was not sent through — and the
//                  caller must not clear the note; it waits for the page to be that scope again.
// The ledger is NOT required to still hold the order: an order that landed and was let go, whose result the page has
// not shown yet, is asked about again by its signature all the same (its note is cleared by what the page then sees).
export async function recheckLocalPending(ledger, scope, note, { origin, still, post = postLocalAct } = {}) {
  const signature = note?.signature;
  if (typeof scope !== 'string' || scope.length === 0 || typeof signature !== 'string' || signature.length === 0) return { state: 'left' };
  if (typeof note.scope !== 'string' || note.scope !== scope) return { state: 'other-scope' };
  if (!still()) return { state: 'left' };
  const f = await followLocalAct(signature, { origin, still, post, tries: 1, every: 0, wait: async () => {} });
  if (f.state === 'landed' || f.state === 'failed') for (const e of ledger.list(scope)) if (e.signature === signature) ledger.release(scope, e.key);
  return f;
}
/**
 * The moment the ONE send has answered with a signature — in this order, and no other:
 *   1. HOLD: the order is held by its signature under the scope it was sent under. First, before anything of the
 *      page's runs: whatever happens next, the signature is not lost and the order cannot be sent again.
 *   2. THE SCOPE: if the page is no longer that scope (the wallet, world or relay changed while the send was
 *      awaited) → `{state: 'left'}`: none of the page's callbacks runs — a signature of the old scope is never
 *      written into the new one's state — and the order stays held under its own scope.
 *   3. THE PAGE'S CALLBACK (`onSent`, e.g. the home choice's "pending" note). If it throws, the order is still held
 *      (step 1 is done): the error is returned (`callbackError`), never thrown past the hold.
 * → `{state: 'held', callbackError}` or `{state: 'left'}`.
 */
export function settleLocalSend(ledger, { scope, key }, name, sent, { still, onSent = null } = {}) {
  if (!ledger.held(scope, key)) ledger.hold(scope, key, { name, signature: sent.signature });
  if (!still()) return { state: 'left' };
  // (the callback is told the scope of the SEND: a note it writes — the home choice's "pending" — carries it, so that
  //  the note is later asked about only at the relay its transaction went through)
  let callbackError = null;
  try { onSent?.(sent, { scope }); } catch (e) { callbackError = e ?? new Error('onSent'); }
  return { state: 'held', callbackError };
}
/**
 * Follow a sent order by its signature, at the relay it was SENT through and only while the page is still the scope
 * it was sent under (`still()`): `{state: 'landed', slot} | {state: 'failed', code} | {state: 'unconfirmed'} |
 * {state: 'left'}`. `left` = the page became another wallet, world or relay while this was awaited: the following
 * stops at once; what it had read, if anything, is NOT a result for the page as it is now. Nothing is sent.
 */
export async function followLocalAct(signature, { origin, still, post = postLocalAct, tries = 40, every = 1500, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const read = localActRead({ allowed: () => ({ ok: true, relay: origin }), post });
  for (let i = 0; i < tries; i++) {
    if (!still()) return { state: 'left' };
    const s = await read(signature);
    if (!still()) return { state: 'left' };   // (asked again after the await: an answer that arrives for another page is not shown to it)
    if (s?.ok && s.state === 'landed') return { state: 'landed', slot: s.slot ?? null };
    if (s?.ok && s.state === 'failed') return { state: 'failed', code: s.code ?? 'TransactionFailed' };
    if (i + 1 < tries) await wait(every);
  }
  return { state: 'unconfirmed' };
}
/**
 * Ask ONCE what became of an order held under `scope` (`read` = `localActRead(…)` of that same scope's relay):
 * `'landed'` or `'failed'` (the ledger lets it go), or `'unconfirmed'` (it stays held: pending, processed only, or no
 * answer). Nothing is sent. An order of another scope is not found here (`'none'`) and nothing is asked about it.
 */
// `still()` (optional): whether the page is STILL this scope. Asked after the read: if it is not, the answer is not
// used — nothing is released and nothing is reported as landed or failed (`'left'`); the order stays held under its
// own scope for when the page is that scope again.
export async function settleLocalAct(ledger, scope, key, read, { still = () => true } = {}) {
  const e = ledger.held(scope, key); if (!e) return { state: 'none' };
  if (!still()) return { state: 'left', signature: e.signature };
  let s; try { s = await read(e.signature); } catch { s = { ok: false }; }
  if (!still()) return { state: 'left', signature: e.signature };
  if (s?.ok && s.state === 'landed') { ledger.release(scope, key); return { state: 'landed', signature: e.signature, slot: s.slot ?? null }; }
  if (s?.ok && s.state === 'failed') { ledger.release(scope, key); return { state: 'failed', signature: e.signature, code: s.code ?? 'TransactionFailed' }; }
  return { state: 'unconfirmed', signature: e.signature };
}

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };
const uintText = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v);
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e.code) ? e.code : fallback);

/** A legacy village from the page's holding object: `{p, q, site}` inside the legacy disk. Anything else is not this path's. */
function village(h) {
  check(object(h) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11), 'LocalActShape');
  let ring; try { ring = ringPosition(BigInt(h.p), BigInt(h.q)).ring; } catch { fail('LocalActShape'); }
  check(ring <= 128n, 'LocalActWideHolding');
  return { p: h.p, q: h.q, site: h.site };
}

/**
 * The intent the relay is told, from what the page's order carries (`v`, `fields` as controller.mjs passes them) —
 * the closed wire form `{name, subject, fields}`, plain JSON. Throws a code for anything these six cannot carry.
 * Join: the session key is the WALLET ITSELF (no other key is made or registered in local play); its expiry is the
 * page's own value.
 */
export function localActIntentOf(name, v, fields, wallet) {
  check(LOCAL_ACT_NAMES.includes(name), 'LocalActNotAllowed'); check(object(v) && object(fields ?? {}), 'LocalActShape');
  const f = fields ?? {};
  if (name === 'Join') {
    check(int(v.faction, 0, 5) && f.faction === v.faction && !v.joinGate && !v.invite, 'LocalActShape');
    const expiry = typeof f.session_expiry === 'bigint' ? f.session_expiry.toString() : f.session_expiry;
    check(typeof expiry === 'string' && /^[1-9][0-9]{0,18}$/.test(expiry) && address(wallet), 'LocalActShape');
    return { name, subject: { faction: v.faction }, fields: { faction: v.faction, session: wallet, session_expiry: expiry } };
  }
  const h = village(v.holding);
  if (name === 'PlaceHome') {
    check(int(v.faction, 0, 5) && exact(f, ['p', 'q', 'site']) && f.p === h.p && f.q === h.q && f.site === h.site, 'LocalActShape');
    return { name, subject: { holding: h, faction: v.faction }, fields: { p: h.p, q: h.q, site: h.site } };
  }
  if (name === 'Harvest') { check(exact(f, []), 'LocalActShape'); return { name, subject: { holding: h }, fields: {} }; }
  if (name === 'Build') { check(exact(f, ['item']) && int(f.item, 0, 7), 'LocalActShape'); return { name, subject: { holding: h }, fields: { item: f.item } }; }
  // (the ABI's own widths: unit 1 byte; n and troops 4 bytes; tile 1 byte, 0-60 on the province's map)
  if (name === 'Train') { check(exact(f, ['unit', 'n']) && int(f.unit, 0, 255) && int(f.n, 1, 0xffffffff), 'LocalActShape'); return { name, subject: { holding: h }, fields: { unit: f.unit, n: f.n } }; }
  check(exact(f, ['unit', 'troops', 'tile']) && int(f.unit, 0, 255) && int(f.troops, 1, 0xffffffff) && int(f.tile, 0, 60), 'LocalActShape');
  return { name, subject: { holding: h }, fields: { unit: f.unit, troops: f.troops, tile: f.tile } };
}

/**
 * The loaded-data limit of a local-play command (bytes): the runtime's maximum, the value the launcher gives the local
 * relays (`--loaded-limit 67108864`). The local lane's program is far larger than the release program the game's
 * per-command limits are set for, and the runner counts its programdata in every command's loaded size, so the
 * release limit refuses every command there. The CU limit stays the game's own. The relay builds with the same value
 * (local-play-act.mjs `LOCAL_ACT_LOADED_LIMIT`): another value is refused there before any send.
 */
export const LOCAL_ACT_LOADED_LIMIT = 67108864;

/** The message of `intent` for `identity` on `blockhash`: the game's own builder, the wallet as fee payer and actor. */
export function localActMessage(intent, identity, rulesetHash, blockhash) {
  const A = seasonAddresses(identity.programId, LOCAL_ACT_SEASON_ID);
  check(A.season === identity.seasonAddress, 'LocalActIdentity');
  const profile = profileForHash(rulesetHash), wallet = identity.address;
  const v = { addresses: A, wallet, actor: wallet, profile, ...intent.subject };
  const fields = intent.name === 'Join' ? { faction: intent.fields.faction, session: Uint8Array.from(decode(wallet)), session_expiry: BigInt(intent.fields.session_expiry) } : { ...intent.fields };
  const built = buildShape({ programId: identity.programId, name: intent.name, accounts: accountsFor(intent.name, v), fields, feePayer: wallet, blockhash, profile });
  check(built.signers.length === 0, 'LocalActSigner');   // (the wallet is the only signer)
  // (the game's own instruction, under the game's own budget prefix with the local loaded-data limit)
  const prefix = budgetPrefix(intent.name, { profile, loadedLimit: LOCAL_ACT_LOADED_LIMIT });
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, built.expected] }));
}

/** One bounded POST of JSON to one of the three loopback routes; never a retry, never credentials. → the parsed answer; a refusal throws its code with `refused: true`. */
export async function postLocalAct(origin, path, body, { fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = LOCAL_ACT_TIMEOUT_MS } = {}) {
  check([LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_SUBMIT_PATH, LOCAL_ACT_STATUS_PATH].includes(path), 'BadLocalActPath');
  const text = JSON.stringify(body); check(text.length <= LOCAL_ACT_MAX_BYTES, 'LocalActTooLarge');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
  let res, raw;
  try {
    res = await fetcher(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal });
    raw = await res.text();
  } catch { fail('LocalActNoAnswer'); } finally { clearTimeout(timer); }
  check(typeof raw === 'string' && raw.length <= LOCAL_ACT_MAX_BYTES, 'LocalActTooLarge');
  let value; try { value = JSON.parse(raw); } catch { fail('LocalActNoAnswer'); }
  if (!res.ok) throw Object.assign(new Error('refused'), { code: codeOf(value, 'LocalActRefused'), refused: true, status: res.status });
  return value;
}

/**
 * Send one of the six, as fplay.mjs `submit` answers: `{ok: true, signature, message, feePayer, lastValidBlockHeight,
 * bytes}` once the ONE POST has been made (also when its answer did not come: the transaction may be on its way, it
 * is followed by its signature and never sent again), or `{ok: false, code, error}` when nothing was sent.
 * `deps`: `allowed()` → the page's local-play gate (`{ok, relay}`), `identity()` → `fs.localPlay`, `rulesetHash()` →
 * the Season's ruleset hash (64 hex), `signer()` → the live memory-only wallet, `post` (tests).
 */
export async function submitLocalAct({ name, v, fields }, { allowed, identity, rulesetHash, signer, post = postLocalAct } = {}) {
  // (`httpStatus`: when the relay answered with a status, or did not answer at all (503) — the page's existing notice
  //  texts say "unavailable" for 5xx and "busy" for 429 from it (fi18n.mjs `failureText`); no new sentence is made)
  const no = (code, httpStatus = undefined) => ({ ok: false, code, error: code, ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) });
  const statusOf = e => (e?.refused === true && Number.isInteger(e.status) ? e.status : codeOf(e, '') === 'LocalActNoAnswer' ? 503 : undefined);
  let sig = null, attempted = false, message = null, height = null, bytes = 0, wallet = null;
  try {
    const gate = () => { const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalActNotAllowed'); return a.relay; };
    const origin = gate();
    const i = identity(), w = signer();
    check(object(i) && address(i.address) && address(i.programId) && address(i.seasonAddress) && i.cluster === 'localnet', 'LocalActIdentity');
    check(!!w && w.destroyed === false && w.address === i.address, 'LocalActSigner');
    wallet = i.address;
    const hash = rulesetHash(); check(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash), 'LocalActIdentity');
    const intent = localActIntentOf(name, v, fields, wallet);
    const ctx = await post(origin, LOCAL_ACT_CONTEXT_PATH, { schema: LOCAL_ACT_CONTEXT_SCHEMA });
    check(exact(ctx, ['wallet', 'blockhash']) && ctx.wallet === wallet && exact(ctx.blockhash, ['hash', 'last_valid_block_height', 'context_slot'])
      && address(ctx.blockhash.hash) && uintText(ctx.blockhash.last_valid_block_height) && uintText(ctx.blockhash.context_slot), 'BadLocalActContext');
    message = localActMessage(intent, i, hash, ctx.blockhash.hash); height = Number(ctx.blockhash.last_valid_block_height);
    // (the context was awaited: the page, the identity and the wallet are asked again before anything is signed)
    check(gate() === origin && signer() === w && w.destroyed === false && identity() === i, 'LocalActChanged');
    const account = (await w.wallet.features['standard:connect'].connect()).accounts.find(a => a.address === wallet);
    check(!!account, 'LocalActSigner');
    const [out] = await w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(message, []) });
    const signed = await localDepartSigned(out?.signedTransaction ?? [], { message, digest: toHex(sha256(message)) }, wallet);
    check(gate() === origin && signer() === w && w.destroyed === false && identity() === i, 'LocalActChanged');
    sig = signed.signature; bytes = signed.wire.length;
    // from here the transaction may reach the chain: ONE POST, and its signature is this order's for good
    attempted = true;
    const answer = await post(origin, LOCAL_ACT_SUBMIT_PATH, { schema: LOCAL_ACT_SUBMIT_SCHEMA, name: intent.name, subject: intent.subject, fields: intent.fields, transaction_b64: toBase64(signed.wire) });
    check(object(answer) && ['submitted', 'unknown'].includes(answer.status) && answer.signature === sig && answer.name === intent.name, 'BadLocalActSubmitted');
    return { ok: true, signature: sig, message, feePayer: wallet, lastValidBlockHeight: height, bytes };
  } catch (e) {
    const code = codeOf(e, 'LocalActFailed');
    // before the POST nothing left this page: not sent. (A relay that does not serve these routes — its context
    // answers 404 — is said as that: local play there is reads only, as it always was.)
    if (!attempted) return e?.refused === true && e.status === 404 ? no('LocalActNotServed') : no(code, statusOf(e));
    // AFTER the POST began, "not sent" is said ONLY for a refusal the relay makes BEFORE its send, by its own closed
    // list of codes (LOCAL_ACT_PRESEND_REFUSALS): the request was refused on what it states or on the accounts read.
    // Everything else keeps the signature and is "sent — outcome unknown": no answer, an unbelievable answer, any
    // other status or code — and in particular
    //   LocalActSendRefused   the relay DID call the runner's send for these bytes;
    //   LocalActMessageUsed   these bytes were submitted before, or the runner already knows this signature.
    // In both the transaction may be, or already is, on the chain. Losing the signature there would let the same
    // order be built again on a new blockhash and done twice. It is followed by its signature and never sent again.
    if (e?.refused === true && LOCAL_ACT_PRESEND_REFUSALS.includes(code)) return no(code, statusOf(e));
    return { ok: true, signature: sig, message, feePayer: wallet, lastValidBlockHeight: height, bytes, outcome: 'unknown', relayCode: code };
  }
}

/**
 * The status read fplay.mjs `track` follows a signature with (`track(signature, {read})`): the relay's word, as
 * `{ok: true, state: 'landed' | 'failed' | 'pending', slot?, code?}`, or `{ok: false}` when no answer came.
 * `pending` is not a failure and not an expiry: this path has no "did not take effect" settlement, so a command that
 * never lands stays "not confirmed" — never "failed", never "done".
 */
export function localActRead({ allowed, post = postLocalAct } = {}) {
  return async signature => {
    try {
      const a = allowed(); if (!a?.ok) return { ok: false, code: a?.code ?? 'LocalActNotAllowed' };
      const v = await post(a.relay, LOCAL_ACT_STATUS_PATH, { schema: LOCAL_ACT_STATUS_SCHEMA, signature });
      check(object(v) && v.signature === signature && ['pending', 'processed', 'confirmed', 'finalized', 'failed'].includes(v.status), 'BadLocalActStatus');
      if (v.status === 'confirmed' || v.status === 'finalized') return { ok: true, state: 'landed', slot: Number.isSafeInteger(v.slot) ? v.slot : null };
      if (v.status === 'failed') { check(v.err !== null && v.err !== undefined, 'BadLocalActStatus'); return { ok: true, state: 'failed', code: 'TransactionFailed' }; }
      return { ok: true, state: 'pending' };
    } catch (e) { return { ok: false, code: codeOf(e, 'LocalActNoAnswer') }; }
  };
}
