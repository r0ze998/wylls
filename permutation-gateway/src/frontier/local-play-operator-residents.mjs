// LOCAL PLAY, TEST-ONLY — operator AI residents (⑤ option A, owner decision 2026-11-18): the ACTING side.
//
//   node permutation-gateway/src/frontier/local-play-operator-residents.mjs --count <1-4> \
//     --relay-ports <p1,p2,…> --herald http://localhost:<world proxy port> --homes <runner ready-for-join JSON> \
//     [--cadence-ms 6000] [--max-acts <n>] [--max-refusals 12] [--min-gap-ms 4000] [--nations <csv, one per resident>] \
//     [--keys-dir <abs private dir>]
//
// Started by local-play-launcher.mjs for a world opened with `--operator-residents <n>` (never over HTTP). What it does:
//   1. makes <count> TEST ed25519 keys IN MEMORY ONLY (node:crypto; never written, never printed, gone with the
//      process) and prints ONE public line: {schema, mode, test_only, wallets: [...]} — public addresses only;
//   2. waits until the launcher has started one local-play relay per wallet on the named ports (the same
//      local-play-relay-server.mjs a page talks to; its /f/local-play/info must name exactly that wallet);
//   3. every --cadence-ms, for each resident in turn: reads the public herald (`/h/me/{wallet}`, the page's own read),
//      decides by the fixed rule (local-play-operator-policy.mjs), and — within its budget — sends that ONE command
//      with the PAGE'S OWN code (flocalplay-act.mjs `submitLocalAct`: context, the game's builder, one signature, one
//      submit) to ITS OWN relay; then follows it by its signature (`followLocalAct`), never sending it again.
//      ONE action per resident per bell (owner decision Q16-2): the bell is the program's own, from the herald's
//      `/h/status` chain time (read once a round) and its `/h/season` GENESIS_TS (read until known); a relay answer
//      `ResidentAlreadyActed` (PR #62's relay-side hold) uses that bell up too, so it is never asked again in it.
//   4. (B12) a line that only repeats the resident's previous one (the same wait, the same "this bell's one action is taken") is
//      not printed again; a resident that is stopped for good is said once and then skipped; once EVERY resident is
//      stopped for good the process prints its summary and exits 0 (the world goes on: it is a side process).
// Every step is one JSON line on stdout (the launcher keeps it in the world's directory: operators.out).
// Same rules as a person: no other route, no operator read, no clock control, no account write, no RPC of the runner.
// No model, no network beyond 127.0.0.1, no paid API. SIGINT/SIGTERM: prints its summary line AT ONCE (the launcher
// kills a side process 3 s after SIGINT, which may be mid-send), stops, exits 0.
// `--keys-dir` (TEST-ONLY, NOT FOR PRODUCTION; passed by the launcher only for a world started with `--persist
// local-persist-v1`, ⑧ P2): instead of step 1's memory-only keys, each resident's TEST key is kept as a PKCS#8 file
// `resident-<i>.pkcs8.pem` (mode 0600) in that directory (mode 0700), so a RESUMED world has the same residents and
// villages. The directory or a key file that another user may use, or a symbolic link, is refused (exit 64); nothing
// is repaired. The key bytes are never printed.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encode } from '../../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction, wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { submitLocalAct, postLocalAct, followLocalAct } from '../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { RESIDENT_ALREADY_ACTED } from './resident-turns.mjs';
import { OPERATOR_RESIDENTS_MODE, OPERATOR_RESIDENTS_SCHEMA, OPERATOR_RESIDENTS_MAX, OPERATOR_NATIONS_MAX, OPERATOR_DEFAULTS, parseOperatorNations, createResidentMemory, createOperatorBudget, decideNext, noteOutcome, residentView, bellOf } from './local-play-operator-policy.mjs';
import { profileForHash } from '../../../permutation-server/web/sdk/frontier/profile.mjs';
import { claimTargets, settlerCost, freeWideSites } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { storesAt } from '../../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';

/**
 * (TEST-ONLY wide play) Whether `holding` (the page's decoder's fields) holds the settler cost of the citizen's next
 * holding (`holdingsN` after it) at chain time `secs`. False when anything is unreadable.
 */
export function coversSettlerCost(holding, secs, holdingsN) {
  try {
    const have = storesAt(holding, secs, RESOURCE_ORDER).map(x => x.value), need = settlerCost(holdingsN);
    return need.every((n, i) => (have[i] ?? 0) >= n);
  } catch { return false; }
}

const SPKI_ED25519_PREFIX = 12;   // (an ed25519 SPKI DER is 12 bytes of header, then the 32-byte public key)

/** One TEST resident key, in memory only: `{address, signMessage(bytes) → 64 bytes}`. The private half never leaves this closure. */
export function memoryTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_ED25519_PREFIX));
  return Object.freeze({ address, signMessage: bytes => new Uint8Array(edSign(null, Buffer.from(bytes), privateKey)) });
}

/** Refuses a link, another kind, or any group/other bit (`mode & 0o077`). */
function privateOrThrow(p, dir) {
  const st = lstatSync(p);
  if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile()) || (st.mode & 0o077) !== 0) throw new Error(`${dir ? 'the keys dir' : 'a resident key'} is not private (0700 dir / 0600 file, no link): refusing`);
}
/**
 * TEST-ONLY, persisted worlds: resident `index`'s key kept in `dir` (see the header): read when it is there, made and
 * written (0600, never over an existing file) when it is not. → the same shape as `memoryTestKey`.
 */
export function keptTestKey(dir, index) {
  privateOrThrow(dir, true);
  const file = path.join(dir, `resident-${index}.pkcs8.pem`);
  let privateKey;
  let exists = true; try { lstatSync(file); } catch { exists = false; }
  if (exists) { privateOrThrow(file, false); privateKey = createPrivateKey(readFileSync(file)); if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('a resident key is not ed25519: refusing'); }
  else { privateKey = generateKeyPairSync('ed25519').privateKey; writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 }); }
  const address = encode(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(SPKI_ED25519_PREFIX));
  return Object.freeze({ address, signMessage: bytes => new Uint8Array(edSign(null, Buffer.from(bytes), privateKey)) });
}

/**
 * The key as the page's local-play signer looks (flocalplay-act.mjs `submitLocalAct` → `signer()`): a wallet-standard
 * shape with `standard:connect` and `solana:signTransaction`, signing exactly the message it is handed, once.
 */
export function pageShapedSigner(key) {
  const account = Object.freeze({ address: key.address });
  return Object.freeze({
    destroyed: false, address: key.address,
    wallet: Object.freeze({ features: Object.freeze({
      'standard:connect': Object.freeze({ connect: async () => ({ accounts: [account] }) }),
      'solana:signTransaction': Object.freeze({ signTransaction: async ({ transaction }) => {
        const tx = parseTransaction(Uint8Array.from(transaction));
        if (tx.signers.length !== 1 || tx.signers[0] !== key.address) throw new Error('not this resident\'s transaction');
        return [{ signedTransaction: wireTransaction(tx.message, [key.signMessage(tx.message)]) }];
      } }),
    }) }),
  });
}

/**
 * The page posts `/gw/f/local-play/act/*` to its world proxy, whose herald strips `/gw` for the relay; a resident posts
 * to its own relay directly. `onRefusal(answer)`: the relay's refusal as it said it (its code and detail), for the log.
 */
export const relayPost = (fetcher = globalThis.fetch, onRefusal = () => {}) => (origin, path, body) => postLocalAct(origin, path, body, { fetch: async (url, init) => {
  const res = await fetcher(String(url).replace(`${origin}/gw/`, `${origin}/`), init);
  if (!res.ok) { try { onRefusal(await res.clone().json()); } catch { /* not JSON: the page's own code says so */ } }
  return res;
} });

/**
 * The chain's clock as the herald last saw it (`/h/status` `live: [slot, unix seconds]`), the page's own source for
 * rule times (clock.mjs): never the local clock — a local-play chain may run on a synthetic clock far from it.
 */
export function chainSecondsOf(status) {
  const t = Array.isArray(status?.live) ? Number(status.live[1]) : NaN;
  return Number.isSafeInteger(t) && t > 0 ? t : null;
}

async function getJson(url, ms = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'error' });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
}
/** A wait of `ms`, cut short by `signal`; its abort listener is removed either way (one per round would pile up: loop-play-b12 live run). */
export const delay = (ms, signal) => new Promise(r => {
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); r(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    if (!k || !['count', 'relay-ports', 'herald', 'homes', 'cadence-ms', 'max-acts', 'max-refusals', 'min-gap-ms', 'nations', 'keys-dir', 'wide'].includes(k) || o[k] !== undefined || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    o[k] = argv[i + 1];
  }
  const count = Number(o.count);
  // (`--nations`: one named nation per resident, up to six; without it the fixed nations of residents 0-3)
  const nations = o.nations === undefined ? null : parseOperatorNations(o.nations);
  if (o.nations !== undefined && (nations === null || nations.length !== count)) throw new Error('--nations');
  if (!Number.isInteger(count) || count < 1 || count > (nations ? OPERATOR_NATIONS_MAX : OPERATOR_RESIDENTS_MAX)) throw new Error('--count');
  const ports = String(o['relay-ports'] ?? '').split(',').map(Number);
  if (ports.length !== count || ports.some(p => !Number.isInteger(p) || p < 41000 || p > 41999)) throw new Error('--relay-ports');
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d{4,5}$/.test(o.herald ?? '')) throw new Error('--herald (loopback only)');
  const homes = JSON.parse(o.homes ?? 'null');
  if (!Array.isArray(homes) || !homes.length) throw new Error('--homes');
  const num = (k, d) => { if (o[k] === undefined) return d; const n = Number(o[k]); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${k}`); return n; };
  if (o['keys-dir'] !== undefined && !path.isAbsolute(o['keys-dir'])) throw new Error('--keys-dir (absolute path)');
  if (o['keys-dir'] !== undefined) privateOrThrow(o['keys-dir'], true);
  // (TEST-ONLY wide play: the opened wide provinces `[{p, q}]`, decimal strings, from the runner's first line)
  let wide = null;
  if (o.wide !== undefined) {
    wide = JSON.parse(o.wide);
    if (!Array.isArray(wide) || !wide.length || wide.length > 4096 || !wide.every(t => t && /^-?[0-9]{1,19}$/.test(String(t.p)) && /^-?[0-9]{1,19}$/.test(String(t.q)))) throw new Error('--wide');
    wide = Object.freeze(wide.map(t => Object.freeze({ p: String(t.p), q: String(t.q) })));
  }
  return { count, ports, herald: o.herald, homes, ...(wide ? { wide } : {}), ...(nations ? { nations } : {}), ...(o['keys-dir'] !== undefined ? { keysDir: o['keys-dir'] } : {}), cadenceMs: num('cadence-ms', OPERATOR_DEFAULTS.cadenceMs), maxActs: num('max-acts', OPERATOR_DEFAULTS.maxActs), maxRefusals: num('max-refusals', OPERATOR_DEFAULTS.maxRefusals), minGapMs: num('min-gap-ms', OPERATOR_DEFAULTS.minGapMs) };
}

/** PR #62's relay answer: this resident already acted in this bell (re-exported from resident-turns.mjs). */
export { RESIDENT_ALREADY_ACTED };

/** The Season's GENESIS_TS from the herald's `/h/season` record (the game's own decoder), or null when unreadable. */
export function genesisOf(record, rulesetHash = null, decode = decodePrefix) {
  try {
    if (!record || record.v !== 1 || typeof record.bytes_b64 !== 'string') return null;
    const g = decode('Season', Buffer.from(record.bytes_b64, 'base64'), { profile: profileForHash(rulesetHash) ?? 2 }).genesisTs;
    const n = Number(g);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/**
 * One resident's one round: its budget first (a resident whose bell is used reads nothing), then read, decide, maybe
 * send and follow. → the line to print. `bell`: the bell of this round (`bellOf`), or null (then nothing is sent).
 * `deps` (tests): `read(wallet)`, `submit(order, ctx)`, `follow(signature)`, `now()` (ms), `nowSecs()`.
 */
export async function residentTurn(r, { homes, deps, bell = null, wideTargets = null }) {
  const t = deps.now();
  const allow = r.budget.allow(t, bell);
  if (!allow.ok) return { resident: r.index, wallet: r.key.address, step: 'budget', outcome: allow.stopped ? 'stopped' : 'later', why: allow.why };
  let me;
  try { me = await deps.read(r.key.address); } catch (e) { return { resident: r.index, wallet: r.key.address, step: 'read', outcome: 'no-answer', why: String(e?.message ?? e).slice(0, 80) }; }
  const view = residentView(me, (kind, bytes) => decodePrefix(kind, bytes, { profile: 2 }));
  // (TEST-ONLY wide play: the opened wide provinces within reach of the village, and whether its stores cover the claim)
  let wide = null;
  if (Array.isArray(wideTargets)) {
    const v = view?.holding;
    const secs = v ? await deps.nowSecs().catch(() => null) : null;
    wide = { targets: v ? claimTargets(v, wideTargets) : [], canClaim: !!v && Number.isSafeInteger(secs) && coversSettlerCost(v.decoded, secs, 2 + (view.wide ?? 0)) };
    // (only when a claim is due: the herald's capture of the nearest targets names their free sites — one read, at most 4)
    if (wide.canClaim && wide.targets.length && deps.route) {
      try {
        const near = wide.targets.slice(0, 4), free = freeWideSites(await deps.route(near));
        wide.targets = near.map(t => (free.has(`${t.p},${t.q}`) ? { ...t, free: free.get(`${t.p},${t.q}`) } : t));
      } catch { /* no answer: every site, as before (a refused site is not asked again) */ }
    }
  }
  const d = decideNext(r.memory, view, { homes, wide, nowSecs: view?.joined === false ? await deps.nowSecs().catch(() => null) : null });
  const seen = { joined: view?.joined ?? null, faction: view?.faction ?? null, village: view?.holding ? `${view.holding.p},${view.holding.q},${view.holding.site}` : null };
  if (d.wait) { noteOutcome(r.memory, d, 'wait'); return { resident: r.index, wallet: r.key.address, step: 'decide', outcome: 'wait', why: d.why, seen }; }
  const sent = await deps.submit({ name: d.name, v: d.v, fields: d.fields }, r);
  let outcome, signature = null, code = null;
  const detail = r.lastRefusal ?? null; r.lastRefusal = null;
  // One action per resident per bell (Q16-2): its relay (PR #62, resident-turns.mjs) says this bell's action was already
  // taken — by this resident or by another writer for it. Not a refusal: nothing was sent, nothing is marked tried; the
  // bell is used up here as well ('held', no refusal counted), so the policy does not ask again before the next bell
  if (!sent.ok && sent.code === RESIDENT_ALREADY_ACTED) {
    r.budget.spent('held', deps.now(), bell);
    return { resident: r.index, wallet: r.key.address, step: 'act', act: d.name, outcome: 'wait', code: sent.code, why: 'this resident already acted in this bell: the next bell', ...(detail ? { detail: JSON.stringify(detail).slice(0, 400) } : {}), seen, budget: r.budget.state() };
  }
  // (the runner's definite rejection — LocalActRejected, 2026-11-19 — counts as before, when it was LocalActSendRefused: failed)
  if (!sent.ok) { outcome = sent.code === 'LocalActRejected' ? 'failed' : 'refused'; code = sent.code; }
  else {
    signature = sent.signature;
    const f = await deps.follow(signature, r);
    outcome = f.state === 'landed' ? 'landed' : f.state === 'failed' ? 'failed' : sent.relayCode === 'LocalActSendRefused' ? 'failed' : 'unknown';
    code = f.code ?? sent.relayCode ?? null;
  }
  noteOutcome(r.memory, d, outcome);
  r.budget.spent(outcome, deps.now(), bell);
  return { resident: r.index, wallet: r.key.address, step: 'act', act: d.name, fields: JSON.parse(JSON.stringify(d.fields, (_, v) => (typeof v === 'bigint' ? v.toString() : v))), why: d.why, outcome, ...(code ? { code } : {}), ...(detail ? { detail: JSON.stringify(detail).slice(0, 400) } : {}), ...(signature ? { signature } : {}), seen, budget: r.budget.state() };
}

/**
 * (B12) The log's filter: a line is printed unless it only repeats the same resident's previous printed line (the same
 * step, outcome, reason and code — a wait, a "this turn is spent", a herald that does not answer). A send is always
 * printed, and after one the next wait is printed again. `fresh(line)` → whether to print it.
 */
export function createQuietLog() {
  const last = new Map();
  return Object.freeze({
    fresh(line) {
      if (line?.step === 'act') { last.delete(line.resident); return true; }
      const k = JSON.stringify([line?.step, line?.outcome, line?.why, line?.code ?? null, line?.seen ?? null]);
      if (last.get(line?.resident) === k) return false;
      last.set(line?.resident, k);
      return true;
    },
  });
}

export async function main(argv = process.argv.slice(2), { print = s => process.stdout.write(`${s}\n`) } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`operator residents: ${e.message}\n`); return 64; }
  const stop = new AbortController();
  let residents = [], turns = 0, summarised = false;
  const summary = why => { if (summarised) return; summarised = true; print(JSON.stringify({ step: 'stopped', why, turns, residents: residents.map(r => ({ resident: r.index, wallet: r.key.address, budget: r.budget.state() })) })); };
  // (the summary is said at the signal itself: the launcher kills a side process 3 s after SIGINT, maybe mid-send)
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, () => { summary(s); stop.abort(s); });
  let keys;
  try { keys = Array.from({ length: o.count }, (_, index) => (o.keysDir ? keptTestKey(o.keysDir, index) : memoryTestKey())); } catch (e) { process.stderr.write(`operator residents: ${e.message}\n`); return 64; }
  residents = Array.from({ length: o.count }, (_, index) => ({ index, key: keys[index], port: o.ports[index], memory: createResidentMemory(index, o.nations?.[index]),
    budget: createOperatorBudget({ maxActs: o.maxActs, maxRefusals: o.maxRefusals, minGapMs: o.minGapMs }), identity: null, rulesetHash: null }));
  residents.forEach(r => { r.signer = pageShapedSigner(r.key); r.origin = `http://127.0.0.1:${r.port}`; });
  print(JSON.stringify({ schema: OPERATOR_RESIDENTS_SCHEMA, mode: OPERATOR_RESIDENTS_MODE, test_only: true, keys: o.keysDir ? 'TEST keys kept in the persisted world\'s private keys dir (0600 files, 0700 dir); never printed' : 'memory-only TEST keys, made by this process, never written', wallets: residents.map(r => r.key.address) }));
  // 2. each resident's own relay, pinned to its own wallet
  for (const r of residents) {
    for (let i = 0; !stop.signal.aborted; i++) {
      try {
        const info = await getJson(`${r.origin}/f/local-play/info`, 1500);
        if (info?.localPlay === true && info.wallet === r.key.address && info.cluster === 'localnet') {
          r.identity = Object.freeze({ address: r.key.address, programId: info.program, seasonAddress: info.season, cluster: 'localnet' });
          r.rulesetHash = info.rulesetHash; break;
        }
      } catch { /* not listening yet */ }
      if (i > 300) { print(JSON.stringify({ resident: r.index, step: 'relay', outcome: 'stopped', why: 'its relay never answered for its wallet' })); return 1; }
      await delay(200, stop.signal);
    }
  }
  if (stop.signal.aborted) return 0;
  print(JSON.stringify({ step: 'ready', residents: residents.map(r => ({ resident: r.index, wallet: r.key.address, relay: r.origin, faction: r.memory.faction })) }));
  const posts = new Map(residents.map(r => [r.origin, relayPost(globalThis.fetch, a => { r.lastRefusal = a; })]));
  const postFor = r => posts.get(r.origin);
  const deps = {
    now: () => Date.now(),
    nowSecs: async () => chainSecondsOf(await getJson(`${o.herald}/h/status`)),
    season: () => getJson(`${o.herald}/h/season`),
    read: wallet => getJson(`${o.herald}/h/me/${wallet}`),
    route: places => getJson(`${o.herald}/h/world/wide/route?at=${encodeURIComponent(places.map(t => `${t.p},${t.q}`).join(';'))}`),
    submit: (order, r) => submitLocalAct(order, { allowed: () => ({ ok: true, relay: r.origin }), identity: () => r.identity, rulesetHash: () => r.rulesetHash, signer: () => r.signer, post: postFor(r) }),
    follow: (signature, r) => followLocalAct(signature, { origin: r.origin, still: () => !stop.signal.aborted, post: postFor(r), tries: 20, every: 1000 }),
  };
  let why = null, genesis = null;
  const quiet = createQuietLog();
  while (!stop.signal.aborted) {
    // (the bell, once a round, for every resident's one action: the Season's genesis read until known, then the chain
    //  time; either unknown = nobody sends this round)
    if (genesis === null) genesis = genesisOf(await deps.season().catch(() => null), residents[0]?.rulesetHash);
    const bell = bellOf(genesis, await deps.nowSecs().catch(() => null));
    for (const r of residents) {
      if (stop.signal.aborted) break;
      if (r.budget.state().stopped) continue;   // (said once, when it stopped)
      const line = await residentTurn(r, { homes: o.homes, deps, bell, wideTargets: o.wide ?? null });
      if (quiet.fresh(line)) print(JSON.stringify({ at: new Date().toISOString(), turn: turns, bell, ...line }));
    }
    turns++;
    if (residents.every(r => r.budget.state().stopped)) { why = 'every resident is stopped for good'; break; }
    await delay(o.cadenceMs, stop.signal);
  }
  summary(why ?? String(stop.signal.reason ?? 'stopped'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
