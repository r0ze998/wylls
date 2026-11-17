// LOCAL PLAY ONLY — whether the ordinary march may be offered on this page: the `marchOpen` contract for the UI.
//
// The ordinary march has its OWN routes on the local-play relay (local-play-march.mjs), apart from the six economy
// commands (flocalplay-act.mjs `LOCAL_ACT_NAMES` stays those six; Depart is never looked for there):
//   capability  POST /gw/f/local-play/march/capability   read-only: this relay serves the march for this wallet, on the
//                                                         runner that states the pinned instance itself
//   submit      POST /gw/f/local-play/march/submit       ONE page-signed Depart (not wired on the page yet)
//   status      POST /gw/f/local-play/march/status       a read of a signature this relay sent
//
// `localMarchOpen(...)` is the ONE answer the UI reads. It is open only when ALL of these hold:
//   1. a capability read for THIS wallet whose instance equals the launcher's stated instance (instance-verified);
//   2. every implementation readiness boolean of `LOCAL_MARCH_READY` is true — they are ALL FALSE today, so the
//      answer is closed whatever else holds. Turning one to true is a reviewed code change, never a runtime switch;
//   3. the page's local-play gate (flocalplay-depart.mjs `localDepartAllowed`) is ok;
//   4. the village is a legacy one (ring ≤ 128);
//   5. no march of this host is held (sent, outcome not yet known): it is only asked about, never sent again.
// It reads, signs and sends nothing itself. It opens no conquest gate and changes no game rule.
import { ringPosition } from './map/wide.mjs';
import { accountsFor, buildShape } from './fplay.mjs';
import { seasonAddresses } from './faddr.mjs';
import { localDepartSigned } from './flocalplay-depart.mjs';
import { LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_CONTEXT_SCHEMA, LOCAL_ACT_SEASON_ID, LOCAL_ACT_LOADED_LIMIT } from './flocalplay-act.mjs';
import { profileForHash } from '../sdk/frontier/profile.mjs';
import { compileMessage, wireTransaction } from '../sdk/solana-tx.mjs';
import { budgetPrefix } from '../sdk/frontier/budgets.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { toBase64, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const LOCAL_MARCH_CAPABILITY_PATH = '/gw/f/local-play/march/capability';
export const LOCAL_MARCH_SUBMIT_PATH = '/gw/f/local-play/march/submit';
export const LOCAL_MARCH_STATUS_PATH = '/gw/f/local-play/march/status';
export const LOCAL_MARCH_CAPABILITY_SCHEMA = 'frontier-local-play-march-capability-v1';
export const LOCAL_MARCH_TIMEOUT_MS = 8000;

/**
 * The implementation readiness conditions, each true only once implemented, tested and reviewed:
 *   pageSend       the page's local Depart: seal once, the memory wallet signs, ONE POST, a memory-only book, no retry,
 *                  no nudge, no self-reveal, an unknown outcome held and only asked about
 *   keeperArrival  the world's keeper settles the departure (legacy SettleDeparture) and resolves the arrival
 *                  province's turn (reveal from the public round, gather/resolve, SettleTransit)
 *   liveProven     one approved live trial of the above on a natural world
 * 2026-11-13: pageSend (independent review of the page path passed with the 23-file canonical set) and keeperArrival
 * (reviewed; the real-artifact in-process runs passed: same-home and another province, order asserted) are TRUE.
 * liveProven stays FALSE: outside the test-only trial entry the march stays closed (localMarchReady).
 */
export const LOCAL_MARCH_READY = Object.freeze({ pageSend: true, keeperArrival: true, liveProven: false });

/** The reasons, in the order they are decided: the first that holds is the answer's `reason`. */
export const LOCAL_MARCH_REASONS = Object.freeze(['LocalMarchNoCapability', 'LocalMarchNotReady', 'LocalMarchGate', 'LocalMarchWideHolding', 'LocalMarchHeld', 'open']);

const HEX64 = /^[0-9a-f]{64}$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const instanceOk = v => typeof v === 'string' && HEX64.test(v) && !/^0{64}$/.test(v);

/**
 * The relay's capability for `wallet`, believed only when it names exactly that wallet and `expectedInstance` (the
 * launcher's statement of the world's runner instance): → a frozen `{wallet, instance}`, or null for everything else
 * (an older relay or no economy flag: 404; no pinned instance; another wallet or instance; a malformed or longer
 * answer; a failure or timeout). ONE bounded same-origin POST; never repeated by itself; no signature.
 * `origin`: the verified herald's exact origin (the relay is its `/gw`). `request`: the page's fetch (tests: a stub).
 */
export async function readLocalMarchCapability({ origin, wallet, expectedInstance, request, timeoutMs = LOCAL_MARCH_TIMEOUT_MS }) {
  let exactOrigin = null;
  try { exactOrigin = new URL(origin).origin; } catch { return null; }
  if (exactOrigin !== origin || typeof wallet !== 'string' || wallet === '' || !instanceOk(expectedInstance) || typeof request !== 'function') return null;
  const abort = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await request(`${origin}${LOCAL_MARCH_CAPABILITY_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: LOCAL_MARCH_CAPABILITY_SCHEMA }), signal: abort.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
        if (abort.signal.aborted || !response?.ok) return null;
        const b = await response.json();
        if (abort.signal.aborted) return null;
        if (!exact(b, ['schema', 'wallet', 'instance', 'commands', 'reveal', 'trial']) || b.schema !== LOCAL_MARCH_CAPABILITY_SCHEMA || b.wallet !== wallet
          || b.instance !== expectedInstance || !Array.isArray(b.commands) || b.commands.length !== 1 || b.commands[0] !== 'Depart' || b.reveal !== 'keeper' || typeof b.trial !== 'boolean') return null;
        // (bound to the relay it came from and the instance it names: `localMarchOpen` discards it on any other)
        return Object.freeze({ wallet: b.wallet, instance: b.instance, trial: b.trial, relay: origin });
      })(),
      new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve(null); }, Math.max(1, Math.min(LOCAL_MARCH_TIMEOUT_MS, timeoutMs))); }),
    ]);
  } catch { return null; } finally { clearTimeout(timer); abort.abort(); }
}

/**
 * Whether the march is ready: `pageSend` and `keeperArrival` exactly true, and `liveProven` exactly true — or, in its
 * place ONLY, the TEST-ONLY trial entry: `trial` true, which `localMarchOpen` passes only when BOTH the page was
 * addressed for the trial (`march=trial`, checked against the launcher's start answer) AND the instance-verified
 * capability says `trial: true` (the relay was started with `--march-trial`). A missing, extra or non-boolean key is not ready.
 */
export function localMarchReady(ready = LOCAL_MARCH_READY, { trial = false } = {}) {
  const keys = Object.keys(LOCAL_MARCH_READY);
  return exact(ready, keys) && keys.every(k => typeof ready[k] === 'boolean') && ready.pageSend === true && ready.keeperArrival === true && (ready.liveProven === true || trial === true);
}

/**
 * THE `marchOpen` answer for the UI, frozen: `{open, reason, capability, ready, trial, held}`.
 *   trialEntry  (TEST-ONLY) true only when the page was addressed `march=trial` and the launcher's start answer said
 *               `marchTrial: true`; `trial` in the answer is true when that entry is what stands in for `liveProven`
 *   capability  the value `readLocalMarchCapability` returned (or null)
 *   wallet      the page's wallet now; the capability must be this wallet's
 *   instance    the launcher's stated runner instance now; the capability must name it
 *   (and `gate.relay` — the relay origin the page posts to — must be the origin the capability was read from)
 *   ready       the readiness booleans (default `LOCAL_MARCH_READY`; tests may pass others — the page never does)
 *   gate        `localDepartAllowed(...)`'s answer (`{ok, relay}` or `{ok: false, code}`)
 *   holding     the village the march would leave from, `{p, q, site}`
 *   held        the signatures of this host's marches that are sent and not yet known (from the page's memory)
 * `open` is true only for reason 'open'. `capability` and `ready` are the booleans of conditions 1 and 2, so the UI can
 * say "this world does not serve the march" apart from "not available yet". `held` is a frozen copy, for an "ask" control.
 */
export function localMarchOpen({ capability = null, wallet = null, instance = null, ready = LOCAL_MARCH_READY, gate = null, holding = null, held = [], trialEntry = false } = {}) {
  // (the capability is THIS wallet's, THIS instance's (the launcher's statement now) and THIS relay's (the gate's relay
  //  now): after any switch it is discarded, never carried over)
  const cap = object(capability) && instanceOk(capability.instance) && typeof wallet === 'string' && capability.wallet === wallet
    && instanceOk(instance) && capability.instance === instance && typeof capability.relay === 'string'
    && (gate?.ok !== true || gate.relay === capability.relay);   // (a closed gate is said as LocalMarchGate below; an open one must be the same relay)
  // (the test-only trial: the page's own entry AND the relay's instance-verified word, both exactly true)
  const trial = cap && trialEntry === true && capability.trial === true;
  const rdy = localMarchReady(ready, { trial });
  const heldList = Object.freeze(Array.isArray(held) ? held.filter(s => typeof s === 'string' && s !== '') : []);
  const answer = reason => Object.freeze({ open: reason === 'open', reason, capability: cap, ready: rdy, trial: trial && ready?.liveProven !== true, held: heldList });
  if (!cap) return answer('LocalMarchNoCapability');
  if (!rdy) return answer('LocalMarchNotReady');
  if (!gate?.ok) return answer('LocalMarchGate');
  let ring = null;
  try { if (object(holding) && Number.isSafeInteger(holding.p) && Number.isSafeInteger(holding.q) && Number.isInteger(holding.site) && holding.site >= 0 && holding.site <= 11) ring = ringPosition(BigInt(holding.p), BigInt(holding.q)).ring; } catch { ring = null; }
  if (ring === null || ring > 128n) return answer('LocalMarchWideHolding');
  if (heldList.length > 0) return answer('LocalMarchHeld');
  return answer('open');
}

// ================================================================== the page's local Depart (`pageSend`)
//
// The game's own single-attempt send (fmarch.mjs `sendMarch`: check, seal once, record, submit, track) is used with
// these deps instead of the chain-page ones — and NEVER through `sendMarchRetrying`:
//   storage/bookKey  a memory-only book (this page's tab; never localStorage; gone with the tab and its key)
//   submit           the game's own Depart (fplay.mjs builder) with the memory wallet as fee payer AND actor, signed by
//                    it, ONE POST to the march submit route. No session key, no retry, no nudge.
//   track            reads of the march status route; nothing is sent again
// There is no reveal on the page (no self-reveal, no hidden-page tick): the world's keeper reveals from the public round.
// A march whose outcome is not known stays `sent` in the book and holds its host: `localMarchOpen` answers
// `LocalMarchHeld`, and only `ask` (one read) is offered for it.
export const LOCAL_MARCH_SUBMIT_SCHEMA = 'frontier-local-play-march-submit-v1';
export const LOCAL_MARCH_STATUS_SCHEMA = 'frontier-local-play-march-status-v1';
/** The relay's refusals made BEFORE its send (local-play-march.mjs `LOCAL_MARCH_PRESEND_REFUSALS`): only these say "not sent". */
export const LOCAL_MARCH_PRESEND_REFUSALS = Object.freeze(['LocalMarchInvalid', 'LocalMarchNotAllowed', 'LocalMarchWideHolding', 'LocalMarchNotYourHost', 'LocalMarchSeal',
  'LocalMarchMessageMismatch', 'LocalMarchSigner', 'LocalMarchCitizen', 'LocalMarchHolding', 'LocalMarchProvince', 'LocalMarchBusy', 'LocalMarchRpcUnavailable', 'LocalMarchClosed']);
export const LOCAL_MARCH_BOOK_KEY = 'local-march:memory';
export const LOCAL_MARCH_MAX_BYTES = 16 * 1024;
const POST_PATHS = Object.freeze([LOCAL_ACT_CONTEXT_PATH, LOCAL_MARCH_SUBMIT_PATH, LOCAL_MARCH_STATUS_PATH]);

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e.code) ? e.code : fallback);
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };
const uintText = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v);
const bytesOf = (v, n) => (v instanceof Uint8Array || Array.isArray(v)) && v.length === n ? Uint8Array.from(v) : null;

/** A memory-only store with the marchbook's storage shape (`get`, `set`). Nothing reaches the browser's storage. */
export function memoryStorage() {
  const m = new Map();
  return Object.freeze({ get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); return true; } });
}

/** One bounded POST of JSON to the act context or a march route; never a retry, never credentials. A refusal throws its code with `refused: true`. */
export async function postLocalMarch(origin, path, body, { fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = 30_000 } = {}) {
  check(POST_PATHS.includes(path), 'BadLocalMarchPath');
  const text = JSON.stringify(body); check(text.length <= LOCAL_MARCH_MAX_BYTES, 'LocalMarchTooLarge');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
  let res, raw;
  try {
    res = await fetcher(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal });
    raw = await res.text();
  } catch { fail('LocalMarchNoAnswer'); } finally { clearTimeout(timer); }
  check(typeof raw === 'string' && raw.length <= LOCAL_MARCH_MAX_BYTES, 'LocalMarchTooLarge');
  let value; try { value = JSON.parse(raw); } catch { fail('LocalMarchNoAnswer'); }
  if (!res.ok) throw Object.assign(new Error('refused'), { code: codeOf(value, 'LocalMarchRefused'), refused: true, status: res.status, detail: value?.detail });
  return value;
}

/**
 * The relay's intent `{name, subject, fields}` (plain JSON) from what `sendMarch` submits and the departing village.
 * Throws a code for anything the ordinary march cannot carry.
 */
export function localMarchIntentOf(fields, holding, province) {
  check(object(holding) && Number.isSafeInteger(holding.p) && Number.isSafeInteger(holding.q) && Number.isInteger(holding.site) && holding.site >= 0 && holding.site <= 11, 'LocalMarchShape');
  check(object(province) && Number.isSafeInteger(province.p) && Number.isSafeInteger(province.q), 'LocalMarchShape');
  for (const x of [holding, province]) { let r; try { r = ringPosition(BigInt(x.p), BigInt(x.q)).ring; } catch { fail('LocalMarchShape'); } check(r <= 128n, 'LocalMarchWideHolding'); }
  const f = fields, commit = bytesOf(f?.commit, 32), seal = bytesOf(f?.seal, 165);
  check(object(f) && typeof f.host_id === 'bigint' && f.host_id >= 0n && f.host_id <= 0xffffffffffffffffn && typeof f.tip === 'bigint' && f.tip >= 0n && f.tip <= 0xffffffffffffffffn
    && Number.isInteger(f.arrive_bell) && f.arrive_bell >= 1 && f.arrive_bell <= 0xffffffff && Number.isInteger(f.transit_slot) && f.transit_slot >= 0 && f.transit_slot <= 3 && !!commit && !!seal, 'LocalMarchShape');
  return Object.freeze({ name: 'Depart', subject: { holding: { p: holding.p, q: holding.q, site: holding.site }, province: { p: province.p, q: province.q } },
    fields: { host_id: String(f.host_id), commit: toHex(commit), seal: toHex(seal), arrive_bell: f.arrive_bell, tip: String(f.tip), transit_slot: f.transit_slot } });
}

/** The program's commitments of an intent: `{ct_hash, seal_root}` (host.rs: seal_root = sha256(commit ‖ sha256(seal))). */
export function localMarchBinding(intent) {
  const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  const ct = sha256(hex(intent.fields.seal)), commit = hex(intent.fields.commit);
  const both = new Uint8Array(64); both.set(commit, 0); both.set(ct, 32);
  return { ct_hash: toHex(ct), seal_root: toHex(sha256(both)) };
}

/** The message of `intent` for `identity` on `blockhash`: the game's own Depart, the wallet as fee payer and actor (the relay rebuilds the same bytes). */
export function localMarchMessageOf(intent, identity, rulesetHash, blockhash) {
  const A = seasonAddresses(identity.programId, LOCAL_ACT_SEASON_ID);
  check(A.season === identity.seasonAddress, 'LocalMarchIdentity');
  const profile = profileForHash(rulesetHash), wallet = identity.address;
  const v = { addresses: A, wallet, actor: wallet, profile, holding: intent.subject.holding, province: intent.subject.province };
  const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  const f = intent.fields;
  const built = buildShape({ programId: identity.programId, name: 'Depart', accounts: accountsFor('Depart', v), feePayer: wallet, blockhash, profile,
    fields: { host_id: BigInt(f.host_id), commit: hex(f.commit), seal: hex(f.seal), arrive_bell: f.arrive_bell, tip: BigInt(f.tip), transit_slot: f.transit_slot } });
  check(built.signers.length === 0, 'LocalMarchSigner');
  const prefix = budgetPrefix('Depart', { profile, loadedLimit: LOCAL_ACT_LOADED_LIMIT });
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, built.expected] }));
}

/** The production signer: the live memory-only wallet signs `message`; the signature is verified here. → `{wire, signature}`. */
export async function signWithMemoryWallet(w, wallet, message) {
  const account = (await w.wallet.features['standard:connect'].connect()).accounts.find(a => a.address === wallet);
  check(!!account, 'LocalMarchSigner');
  const [out] = await w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(message, []) });
  return localDepartSigned(out?.signedTransaction ?? [], { message, digest: toHex(sha256(message)) }, wallet);
}

/** The relay's status answer → `{state: 'landed'|'failed'|'pending', slot?, programCode?}`; throws on anything else. */
function statusOf(v, signature) {
  check(object(v) && v.signature === signature && ['pending', 'processed', 'confirmed', 'finalized', 'failed'].includes(v.status), 'BadLocalMarchStatus');
  if (v.status === 'confirmed' || v.status === 'finalized') return { state: 'landed', slot: Number.isSafeInteger(v.slot) ? v.slot : null };
  if (v.status === 'failed') {
    check(v.err !== null && v.err !== undefined, 'BadLocalMarchStatus');
    const custom = Array.isArray(v.err?.InstructionError) ? v.err.InstructionError[1]?.Custom : undefined;
    return { state: 'failed', programCode: Number.isInteger(custom) ? custom : null };
  }
  return { state: 'pending' };
}

/**
 * The page's local march sender. `deps`:
 *   allowed()     the local-play gate (`localDepartAllowed`): `{ok, relay}`
 *   open()        whether `FS.localMarch?.open === true` NOW (asked before anything is signed)
 *   identity()    `fs.localPlay`;  rulesetHash() the Season's ruleset hash;  signer() the live memory wallet
 *   post, sign    (tests) the POST and the signing step; production: postLocalMarch, signWithMemoryWallet
 *   wait, tries, every  the status reads after the send (40 × 1.5 s by default)
 * → `{storage, bookKey, held(host), depsFor({holding, province}), ask(signature)}`. Constructing it sends nothing.
 */
export function createLocalMarchSender({ allowed, open, identity, rulesetHash, signer, post = postLocalMarch, sign = signWithMemoryWallet,
  wait = ms => new Promise(r => setTimeout(r, ms)), tries = 40, every = 1500 } = {}) {
  const storage = memoryStorage(), bookKey = LOCAL_MARCH_BOOK_KEY;
  const read = () => { try { const v = JSON.parse(storage.get(bookKey) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const patch = (signature, p) => storage.set(bookKey, JSON.stringify(read().map(e => (e.signature === signature ? { ...e, ...p } : e))));
  const origins = new Map();   // signature → the relay origin it was sent through (asked only there)
  /** The signatures of `host`'s marches that were sent and whose outcome is not known (state `sent`). */
  const held = host => read().filter(e => (host === null || host === undefined || String(e.host) === String(host)) && e.state === 'sent' && typeof e.signature === 'string').map(e => e.signature);
  const readStatus = async (origin, signature) => statusOf(await post(origin, LOCAL_MARCH_STATUS_PATH, { schema: LOCAL_MARCH_STATUS_SCHEMA, signature }), signature);
  return Object.freeze({
    storage, bookKey, held,
    depsFor({ holding, province }) {
      return {
        storage, bookKey,
        async submit(req) {
          const no = code => ({ ok: false, code, error: code });
          let attempted = false, sig = null;
          try {
            check(req?.name === 'Depart', 'LocalMarchNotAllowed');
            const gate = () => { const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalMarchGate'); if (open() !== true) fail('LocalMarchClosed'); return a.relay; };
            const origin = gate();
            const i = identity(), w = signer();
            check(object(i) && address(i.address) && address(i.programId) && address(i.seasonAddress) && i.cluster === 'localnet', 'LocalMarchIdentity');
            check(!!w && w.destroyed === false && w.address === i.address, 'LocalMarchSigner');
            const hash = rulesetHash(); check(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash), 'LocalMarchIdentity');
            const intent = localMarchIntentOf(req.fields, holding, province);
            check(held(intent.fields.host_id).length === 0, 'LocalMarchHeld');
            const ctx = await post(origin, LOCAL_ACT_CONTEXT_PATH, { schema: LOCAL_ACT_CONTEXT_SCHEMA });
            check(object(ctx) && ctx.wallet === i.address && object(ctx.blockhash) && address(ctx.blockhash.hash) && uintText(ctx.blockhash.last_valid_block_height), 'BadLocalMarchContext');
            const message = localMarchMessageOf(intent, i, hash, ctx.blockhash.hash);
            check(gate() === origin && signer() === w && w.destroyed === false && identity() === i, 'LocalMarchChanged');
            const signed = await sign(w, i.address, message);
            check(gate() === origin && signer() === w && w.destroyed === false && identity() === i, 'LocalMarchChanged');
            check(object(signed) && typeof signed.signature === 'string' && signed.signature !== '' && signed.wire instanceof Uint8Array, 'LocalMarchSigner');
            sig = signed.signature;
            // from here the transaction may reach the chain: ONE POST, and the signature is this march's for good
            attempted = true; origins.set(sig, origin);
            const answer = await post(origin, LOCAL_MARCH_SUBMIT_PATH, { schema: LOCAL_MARCH_SUBMIT_SCHEMA, ...intent, transaction_b64: toBase64(signed.wire) });
            const binding = localMarchBinding(intent);
            check(object(answer) && ['submitted', 'unknown'].includes(answer.status) && answer.signature === sig && answer.name === 'Depart'
              && answer.ct_hash === binding.ct_hash && answer.seal_root === binding.seal_root, 'BadLocalMarchSubmitted');
            return { ok: true, signature: sig, ...(answer.status === 'unknown' ? { outcome: 'unknown' } : {}) };
          } catch (e) {
            const code = codeOf(e, 'LocalMarchFailed');
            if (!attempted) return no(code);
            if (e?.refused === true && LOCAL_MARCH_PRESEND_REFUSALS.includes(code)) { origins.delete(sig); return no(code); }
            // sent, outcome unknown (no answer, an unbelievable answer, the runner's refusal of the send, a used message):
            // kept by its signature and followed; never sent again
            return { ok: true, signature: sig, outcome: 'unknown', relayCode: code };
          }
        },
        async track(signature) {
          const origin = origins.get(signature);
          if (!origin) return { ok: false, state: 'unconfirmed', code: 'Unconfirmed' };
          for (let n = 0; n < tries; n++) {
            let s = null;
            try { s = await readStatus(origin, signature); } catch { s = null; }
            if (s?.state === 'landed') return { ok: true, slot: s.slot };
            if (s?.state === 'failed') return { ok: false, state: 'failed', code: 'TransactionFailed', programCode: s.programCode };
            if (n + 1 < tries) await wait(every);
          }
          return { ok: false, state: 'unconfirmed', code: 'Unconfirmed' };
        },
      };
    },
    /** ONE status read of a held march, through the relay it was sent through: `'landed'`, `'failed'` (the book lets it go) or `'unconfirmed'` (still held). Sends nothing. */
    async ask(signature) {
      const origin = origins.get(signature);
      if (!origin || !read().some(e => e.signature === signature && e.state === 'sent')) return 'none';
      let s = null;
      try { s = await readStatus(origin, signature); } catch { s = null; }
      if (s?.state === 'landed') { patch(signature, { state: 'landed' }); return 'landed'; }
      if (s?.state === 'failed') { patch(signature, { state: 'failed', failure: 'TransactionFailed' }); return 'failed'; }
      return 'unconfirmed';
    },
  });
}
