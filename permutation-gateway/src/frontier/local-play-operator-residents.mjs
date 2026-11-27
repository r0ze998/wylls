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
//
// TEST-ONLY war world (`--war operator-war-v1`, the launcher's `--operator-war`; owner t359u): up to 12 residents, two
// per nation; each turn the world's eyes are read once (local-play-operator-march.mjs: the page's herald client, keeps
// and kernel), each resident's war snapshot is taken, the policy decides (defend / attack / muster / train / economy),
// at most ONE action per resident per turn (owner Q16-2), and a march is sealed and sent by the page's own flow to the
// resident's own relay (opened only by the page's own capability read with the TEST-ONLY trial).
// `--keys-dir` (TEST-ONLY, NOT FOR PRODUCTION; passed by the launcher only for a world started with `--persist
// local-persist-v1`, ⑧ P2): instead of step 1's memory-only keys, each resident's TEST key is kept as a PKCS#8 file
// `resident-<i>.pkcs8.pem` (mode 0600) in that directory (mode 0700), so a RESUMED world has the same residents and
// villages. The directory or a key file that another user may use, or a symbolic link, is refused (exit 64); nothing
// is repaired. The key bytes are never printed.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { selectLocalLane, COEXIST_LANE, COEXIST_LANE_WORD } from '../../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encode } from '../../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction, wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { pacingOf } from '../../../permutation-server/web/frontier/fpacing.mjs';
import { submitLocalAct, postLocalAct, followLocalAct } from '../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { postLocalMarch } from '../../../permutation-server/web/frontier/flocalplay-march.mjs';
import { RESIDENT_ALREADY_ACTED } from './resident-turns.mjs';
import { OPERATOR_RESIDENTS_MODE, OPERATOR_RESIDENTS_SCHEMA, OPERATOR_RESIDENTS_MAX, OPERATOR_NATIONS_MAX, OPERATOR_DEFAULTS, parseOperatorNations, createResidentMemory, createOperatorBudget, decideNext, noteOutcome, residentView, bellOf, wideMarchDue, nearChoice, pruneOwnTiles } from './local-play-operator-policy.mjs';
import { createWideMarch } from './local-play-operator-wide-march.mjs';
import { createWideHost } from './local-play-operator-wide-host.mjs';
import { profileForHash } from '../../../permutation-server/web/sdk/frontier/profile.mjs';
import { claimTargets, settlerCost, freeWideSites } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { createWideLandReader, expansionTargets, headingOf, withTerritory } from './local-play-operator-expansion.mjs';
import { storesAt } from '../../../permutation-server/web/frontier/fland.mjs';
import { citizenTagOf } from '../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { ownLandOf, cachedFor } from './local-play-operator-land.mjs';
export { ownLandOf, cachedFor } from './local-play-operator-land.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';

/**
 * (TEST-ONLY wide play) Whether `holding` (the page's decoder's fields) holds the settler cost of the citizen's next
 * holding at chain time `secs`; `holdingsN` = the villages held BEFORE it, as the program reads it (loop-play11:
 * 1 + the wide villages, not 2 + — the AI waited for 1.5× the price). False when anything is unreadable.
 */
/** The village's ore (whole units) at `secs`, or null when unreadable (verify-pr206-209: tile claims are paid in ore). */
export function oreAt(holding, secs) {
  try { return Number.isSafeInteger(secs) ? Number(storesAt(holding, secs, RESOURCE_ORDER)[RESOURCE_ORDER.indexOf('Ore')]?.value ?? null) : null; } catch { return null; }
}
/** The village's stores (whole units by resource index) at `secs`, or null when unreadable (ai-ore-reserve: what a Train needs). */
export function storesNow(holding, secs) {
  try { return Number.isSafeInteger(secs) ? storesAt(holding, secs, RESOURCE_ORDER).map(x => Number(x.value)) : null; } catch { return null; }
}
/** The village's food per hour in milli-food at `secs`, or null when unreadable (Q-LP19-1 (a): its food surplus). */
export function foodMilliPerHourAt(holding, secs) {
  try { const x = Number.isSafeInteger(secs) ? storesAt(holding, secs, RESOURCE_ORDER)[RESOURCE_ORDER.indexOf('Food')]?.perHour : null; return Number.isFinite(x) ? Math.round(x * 1000) : null; } catch { return null; }
}
export function coversSettlerCost(holding, secs, holdingsN) {
  try {
    const have = storesAt(holding, secs, RESOURCE_ORDER).map(x => x.value), need = settlerCost(holdingsN);
    return need.every((n, i) => (have[i] ?? 0) >= n);
  } catch { return false; }
}
import { OPERATOR_WAR_MODE, OPERATOR_WAR_MAX, mayActThisTurn } from './local-play-operator-war.mjs';
import { createWarEyes, openMarch, sendWarMarch } from './local-play-operator-march.mjs';

/** A war world's pace: residents look every 2 s (one action per turn still), and no send cap (owner t364u: no caps; one
 *  action per turn is the only limit — loop-play4 B-6 puts war in every play-local world, kept ones of hours too). */
export const WAR_DEFAULTS = Object.freeze({ cadenceMs: 2000, maxActs: null, maxRefusals: 400, minGapMs: 1000 });
/** (fix-loop4) A war resident whose expedition into the wide land was held (its province settling) retries after this many turns. */
export const WAR_WIDE_RETRY_BELLS = 2;
/** Bells after its arrival a keep a resident marched on counts as taken by it (its contest runs 72 turns). */
export const TARGET_HOLD_BELLS = 80;

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
    if (!k || !['count', 'relay-ports', 'herald', 'homes', 'cadence-ms', 'max-acts', 'max-refusals', 'min-gap-ms', 'nations', 'keys-dir', 'war', 'wide', 'lane', 'goals', 'near'].includes(k) || o[k] !== undefined || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    o[k] = argv[i + 1];
  }
  if (o.war !== undefined && o.war !== OPERATOR_WAR_MODE) throw new Error(`--war must be exactly ${OPERATOR_WAR_MODE}`);
  // (TEST-ONLY coexist lane, the launcher's `--coexist`: `--lane coexist`, exactly; the residents' process then plays it)
  if (o.lane !== undefined && o.lane !== COEXIST_LANE_WORD) throw new Error(`--lane must be exactly ${COEXIST_LANE_WORD}`);
  const war = o.war === OPERATOR_WAR_MODE;
  const count = Number(o.count);
  // (`--nations`: one named nation per resident, up to six; without it the fixed nations of residents 0-3)
  const nations = o.nations === undefined ? null : parseOperatorNations(o.nations);
  if (o.nations !== undefined && (nations === null || nations.length !== count)) throw new Error('--nations');
  if (!/^([1-9]|1[0-2])$/.test(String(o.count)) || count < 1 || count > (war ? OPERATOR_WAR_MAX : nations ? OPERATOR_NATIONS_MAX : OPERATOR_RESIDENTS_MAX)) throw new Error('--count');
  const D = war ? WAR_DEFAULTS : OPERATOR_DEFAULTS;
  const ports = String(o['relay-ports'] ?? '').split(',').map(Number);
  if (ports.length !== count || ports.some(p => !Number.isInteger(p) || p < 41000 || p > 41999)) throw new Error('--relay-ports');
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d{4,5}$/.test(o.herald ?? '')) throw new Error('--herald (loopback only)');
  // (flag-keeps-ai, TEST-ONLY: the launcher's world-goals judge of THIS world — the page's 「世界の目標」 read; war worlds only)
  if (o.goals !== undefined && (!war || !/^http:\/\/(localhost|127\.0\.0\.1):\d{4,5}\/goals-world\/\d{5}\/goals\/state$/.test(o.goals))) throw new Error('--goals (loopback goals state of a war world only)');
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
  // (fix-loop16, `--near <the player's PUBLIC address>`, TEST-ONLY, only with `--wide` and without `--nations`: nearChoice)
  if (o.near !== undefined && (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.near) || !wide || nations)) throw new Error('--near');
  return { count, ports, herald: o.herald, homes, war, ...(o.near !== undefined ? { near: o.near } : {}), ...(o.goals !== undefined ? { goals: o.goals } : {}), ...(o.lane !== undefined ? { lane: o.lane } : {}), ...(wide ? { wide } : {}), ...(nations ? { nations } : {}), ...(o['keys-dir'] !== undefined ? { keysDir: o['keys-dir'] } : {}), cadenceMs: num('cadence-ms', D.cadenceMs), maxActs: num('max-acts', D.maxActs), maxRefusals: num('max-refusals', D.maxRefusals), minGapMs: num('min-gap-ms', D.minGapMs) };
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
 * world4-pacing-impl: whether the Season places a first village at once on a settled rim province (`pacing` 1, the
 * page's fpacing.mjs `pacingOf`), from the same `/h/season` record; false when unreadable (every world before the byte).
 */
export function firstHomeAtOnceOf(record, rulesetHash = null, decode = decodePrefix) {
  try {
    if (!record || record.v !== 1 || typeof record.bytes_b64 !== 'string') return false;
    const s = decode('Season', Buffer.from(record.bytes_b64, 'base64'), { profile: profileForHash(rulesetHash) ?? 2 });
    return pacingOf(s).firstHomeAtOnce;
  } catch { return false; }
}

/**
 * The turn a war resident's sent action is booked on (owner Q16-2): the later of the bell it was decided at and the
 * bell the chain is in when the send and its follow are over (`deps.liveBell`). A send started at the very end of a
 * turn runs on the chain in the NEXT one (seen 2026-11-19, verify-pr68: a Depart decided at bell 26 ran — and was
 * refused NotResident — in bell 27, and a Build of bell 27 followed it): booked on the later bell, the resident does
 * nothing more in the turn its transaction ran in.
 */
export function spentBell(nowBell, deps) {
  const live = typeof deps?.liveBell === 'function' ? deps.liveBell() : null;
  return Number.isSafeInteger(live) && Number.isSafeInteger(nowBell) ? Math.max(nowBell, live) : nowBell;
}

/**
 * One resident's one round: its budget first (a resident whose bell is used reads nothing), then read, decide, maybe
 * send and follow. → the line to print. `bell`: the bell of this round (`bellOf`), or null (then nothing is sent).
 * `deps` (tests): `read(wallet)`, `submit(order, ctx)`, `follow(signature)`, `now()` (ms), `nowSecs()`.
 */
/** Whether the resident plays a territory world (a target carries territory facts, or it owns a tile already). */
const territoryWorld = (targets, memory) => (memory.ownTiles ?? []).length > 0 || (Array.isArray(targets) && targets.some(t => t?.territory));
export async function residentTurn(r, { homes, deps, bell = null, wideTargets = null, atOnce = false }) {
  const t = deps.now();
  // (a war resident's bell is the one its eyes read this round — the same chain clock —; its budget is asked after the
  //  decision, so a held turn (the settle wait) and the war rule's own "already acted" are said as what they are)
  const war = r.memory.war === true;
  const nowBell = war && deps.nowBell ? deps.nowBell() : null;
  const turnBell = war ? nowBell : bell;
  if (!war) {
    const allow = r.budget.allow(t, turnBell);
    if (!allow.ok) return { resident: r.index, wallet: r.key.address, step: 'budget', outcome: allow.stopped ? 'stopped' : 'later', why: allow.why };
  }
  // (fix-loop16, `--near`: this resident has no nation until the player's first village is seen; then nearChoice names
  //  its nation and its province, and its claims head toward the player's village)
  if (r.memory.near && !r.memory.near.home) {
    let theirs = null;
    try { const pm = await deps.read(r.memory.near.wallet); theirs = deps.view ? deps.view(pm) : residentView(pm, (kind, bytes) => decodePrefix(kind, bytes, { profile: 2 })); } catch { theirs = null; }
    const c = theirs?.holding ? nearChoice(homes, theirs.holding, theirs.faction) : null;
    if (!c) return { resident: r.index, wallet: r.key.address, step: 'near', outcome: 'wait', why: 'waiting for the player\'s first village (joins the nearest other nation then)', test_only: true };
    r.memory.near.home = { nation: c.nation, p: c.p, q: c.q };
    r.memory.faction = c.nation;
    r.memory.heading = { toward: { p: String(theirs.holding.p), q: String(theirs.holding.q) } };
    return { resident: r.index, wallet: r.key.address, step: 'near', outcome: 'chosen', nation: c.nation, home: `${c.p},${c.q}`, player_village: `${theirs.holding.p},${theirs.holding.q}`, distance: c.distance,
      why: `the nearest village site of another nation is ${c.distance} province(s) from the player's village: join that nation and ask for that site`, test_only: true };
  }
  let me;
  try { me = await deps.read(r.key.address); } catch (e) { return { resident: r.index, wallet: r.key.address, step: 'read', outcome: 'no-answer', why: String(e?.message ?? e).slice(0, 80) }; }
  // (`deps.view`: tests only — the same reduction from an already decoded record)
  const view = deps.view ? deps.view(me) : residentView(me, (kind, bytes) => decodePrefix(kind, bytes, { profile: 2 }));
  // (a war resident with a village: its war snapshot — the page's own reads, keeps and target finder)
  let snap = null;
  if (war && view?.holding && deps.warView) { try { snap = await deps.warView(r); } catch (e) { snap = null; } }
  // (TEST-ONLY wide play: the opened wide provinces within reach of the village, and whether its stores cover the claim)
  let wide = null;
  // (expansion-gameplay-1: the live wide land — the opened provinces now and their captures — read once per round)
  let live = null;
  if (Array.isArray(wideTargets)) {
    const v = view?.holding;
    const secs = v ? await deps.nowSecs().catch(() => null) : null;
    // (expansion-gameplay-1: with the live wide land, the targets of the reach rule — from home or the nation's land —
    //  best first for this resident's heading; without it, the launcher's opened list within reach of home, as before)
    if (v && deps.wideLand) { try { live = await deps.wideLand.read(); } catch { live = null; } }
    const faction = Number.isInteger(view?.faction) ? view.faction : r.memory.faction;
    // (territory-impl: in a territory world each target carries its site tiles — the policy claims the site's tile first)
    const targets = !v ? [] : live ? withTerritory(expansionTargets(v, live, faction, { heading: r.memory.heading ?? headingOf(r.index) }), live) : claimTargets(v, wideTargets);
    // (expansion-gameplay-1: the herald's /h/me holdings list carries the legacy villages only, so `view.wide` stays 0
    //  after a wide village settles and the third village was priced as a second — 800 for a 1,200 cost, refused
    //  Insufficient (Custom 21) live; the resident's own record of its wide villages counts too)
    const wideHeld = Math.max(Number.isInteger(view?.wide) ? view.wide : 0, (r.memory.wideVillages ?? []).length);
    wide = { targets, canClaim: !!v && Number.isSafeInteger(secs) && coversSettlerCost(v.decoded, secs, 1 + wideHeld), ore: oreAt(v?.decoded, secs), stores: storesNow(v?.decoded, secs) };
    // (owner-answers-logic, Q-LP19-1 (a): its own land — the food surplus a far target is weighed against — and the tiles
    //  the world let go leave its memory; pruneOwnTiles / landTooDear in the policy)
    if (v && territoryWorld(targets, r.memory)) {
      const own = await ownLandOf({ citizen: me?.citizen?.address, foodMilliPerHour: foodMilliPerHourAt(v.decoded, secs), rememberedTiles: (r.memory.ownTiles ?? []).length, deps });
      if (own.land) wide.land = own.land;
      if (own.records) { const dropped = pruneOwnTiles(r.memory, own.records, citizenTagOf(me.citizen.address)); if (dropped.length) r.tilesDropped = dropped; }
    }
    // (only when a claim is due: the herald's capture of the nearest targets names their free sites — one read, at most 4)
    if (wide.canClaim && wide.targets.length && deps.route) {
      try {
        const near = wide.targets.slice(0, 4), free = freeWideSites(await deps.route(near));
        wide.targets = near.map(t => (free.has(`${t.p},${t.q}`) ? { ...t, free: free.get(`${t.p},${t.q}`) } : t));
      } catch { /* no answer: every site, as before (a refused site is not asked again) */ }
    }
  }
  // (TEST-ONLY wide march: a rim village with a ready host and a judged path into the bordering wide land)
  if (wide && view?.holding && deps.wideMarch && wideMarchDue(r.memory, bell)) {
    try {
      const m = await deps.wideMarch.plan(r, wideTargets);
      if (m.ok) wide.march = m.plan;
      else {
        r.wideMarchWhy = m.why;
        // (no host at all and none away: form one — the reserve from the village record the policy reads)
        const transits = (view.holding.decoded?.transit ?? []).filter(t => t && t.state !== 0).length;
        if (m.hosts === 0 && transits === 0 && (r.memory.wideMarches ?? 0) === 0) wide.needHost = { reserve: Number(view.holding.decoded?.reserve?.[0] ?? 0) };
      }
    } catch (e) { r.wideMarchWhy = String(e?.message ?? e).slice(0, 120); }
  }
  // (TEST-ONLY wide -> wide, Q-W2 owner t385u: a wide village's own host — train, muster, then march onto a
  //  neighbouring province's keep. Local-play-operator-wide-host.mjs; the program opens the march only in the local lane)
  //  A war resident's wide village does the same (loop-play4 B-6: war is on by default in every play-local world with AI
  //  residents), within its one action per turn (Q16-2)
  if (wide && deps.wideHost && (r.memory.wideVillages ?? []).length && (!war || mayActThisTurn(r.memory.lastBell, nowBell, 'WideHost'))) {
    let w;
    try { w = await deps.wideHost.decide(r, { wideTargets: live?.opened ?? wideTargets, villages: r.memory.wideVillages }); } catch (e) { w = { why: String(e?.message ?? e).slice(0, 160) }; }
    r.wideHostWhy = w?.why ?? null;
    if (w?.decision) {
      const wd = w.decision;
      const sent = await deps.submit({ name: wd.name, v: wd.v, fields: wd.fields }, r);
      const detail = r.lastRefusal ?? null; r.lastRefusal = null;
      let outcome, signature = null, code = null;
      if (!sent.ok && sent.code === RESIDENT_ALREADY_ACTED) {
        r.budget.spent('held', deps.now(), turnBell);
        return { resident: r.index, wallet: r.key.address, step: 'act', act: wd.name, outcome: 'wait', code: sent.code, why: 'this resident already acted in this bell: the next bell', test_only: true };
      }
      if (!sent.ok) { outcome = sent.code === 'LocalActRejected' ? 'failed' : 'refused'; code = sent.code; }
      else {
        signature = sent.signature;
        const fl = await deps.follow(signature, r);
        outcome = fl.state === 'landed' ? 'landed' : fl.state === 'failed' ? 'failed' : 'unknown';
        code = fl.code ?? sent.relayCode ?? null;
      }
      deps.wideHost.note(r, wd, outcome);
      if (war && outcome !== 'refused') r.memory.lastBell = spentBell(nowBell, deps);
      noteOutcome(r.memory, wd, outcome);
      r.budget.spent(outcome, deps.now(), turnBell);
      return { resident: r.index, wallet: r.key.address, step: 'act', act: wd.name, why: wd.why, outcome, test_only: true, wide_host: true,
        ...(wd.to ? { to: wd.to, from: wd.from, troops: wd.troops, arrive_bell: wd.fields.arrive_bell, now_bell: wd.nowBell } : {}),
        ...(code ? { code } : {}), ...(signature ? { signature } : {}), ...(detail ? { detail: JSON.stringify(detail).slice(0, 400) } : {}), budget: r.budget.state() };
    }
  }
  const d = decideNext(r.memory, view, { homes, wide, atOnce, nowSecs: view?.joined === false ? await deps.nowSecs().catch(() => null) : null,
    war: snap ? { nowBell, reserve: snap.reserve, hostCount: snap.hostCount, march: snap.march, settling: snap.settling, army: snap.army, threatened: snap.threatened } : null });
  const seen = { joined: view?.joined ?? null, faction: view?.faction ?? null, village: view?.holding ? `${view.holding.p},${view.holding.q},${view.holding.site}` : null,
    ...(wide?.land ? { land: { food_per_hour: wide.land.foodMilliPerHour / 1000, upkeep_per_hour: wide.land.upkeepMilliPerHour / 1000, tiles: wide.land.tiles, remembered: (r.memory.ownTiles ?? []).length } } : {}),
    ...(r.tilesDropped ? { tiles_dropped: r.tilesDropped } : {}), ...(d.dear ? { dear: d.dear } : {}),
    ...(snap ? { bell: nowBell, reserve: snap.reserve, hosts: snap.hostCount, ready: snap.ready, ...(snap.threatened ? { threatened: true } : {}), ...(Number.isFinite(wide?.ore) ? { ore: wide.ore } : {}), ...(snap.goals ? { goals: snap.goals } : {}) } : {}) };
  r.tilesDropped = null;
  if (d.wait) { noteOutcome(r.memory, d, 'wait'); return { resident: r.index, wallet: r.key.address, step: 'decide', outcome: 'wait', why: d.why, seen }; }
  if (war) {
    // (one action per resident per turn, owner Q16-2: a war resident that acted this turn waits for the next)
    if (!mayActThisTurn(r.memory.lastBell, nowBell, d.name)) return { resident: r.index, wallet: r.key.address, step: 'turn', outcome: 'wait', why: 'already acted this turn', want: d.name, seen };
    const allow = r.budget.allow(t, turnBell);
    if (!allow.ok) return { resident: r.index, wallet: r.key.address, step: 'budget', outcome: allow.stopped ? 'stopped' : 'later', why: allow.why, want: d.name, seen };
  }
  if (d.name === 'Depart') {
    if (!r.marchOpen) return { resident: r.index, wallet: r.key.address, step: 'march', outcome: 'wait', why: 'the march is not open on its own relay', want: 'Depart', seen };
    r.lastRefusal = null;
    const m = await deps.march(r, snap);
    const detail = r.lastRefusal; r.lastRefusal = null;
    // (its relay's own one-action-per-bell rule, #62: this bell's action is taken — nothing was sent; not a refusal of
    //  the march: no cooldown, no refusal counted; the bell is used up ('held') and booked, and it decides again in the next)
    if (!m.ok && m.code === RESIDENT_ALREADY_ACTED) {
      r.memory.lastBell = spentBell(nowBell, deps);
      r.budget.spent('held', deps.now(), turnBell);
      return { resident: r.index, wallet: r.key.address, step: 'act', act: 'Depart', kind: d.kind, outcome: 'wait', code: m.code, why: 'this resident already acted in this bell: the next bell', seen, budget: r.budget.state() };
    }
    const outcome = m.ok ? 'landed' : m.step === 'check' || m.step === 'route' || m.step === 'sealing' ? 'refused' : m.code === 'TransactionFailed' ? 'failed' : m.step === 'sent' && m.code !== 'network' ? 'refused' : 'unknown';
    if (outcome !== 'refused') r.memory.lastBell = spentBell(nowBell, deps);
    if (outcome === 'landed' || outcome === 'unknown') (r.memory.targets ??= {})[`${d.row.p},${d.row.q}`] = (m.arriveBell ?? nowBell) + TARGET_HOLD_BELLS;
    noteOutcome(r.memory, d, outcome);
    r.budget.spent(outcome, deps.now(), turnBell);
    return { resident: r.index, wallet: r.key.address, step: 'act', act: 'Depart', kind: d.kind, ...(d.goal ? { goal: d.goal } : {}), ...(snap.goals?.plain !== undefined ? { plain: snap.goals.plain } : {}), why: d.why, outcome,
      to: { p: d.row.p, q: d.row.q, tile: d.row.tile, holder: d.row.holder, guard: d.row.troops }, host: { id: String(snap.march.host.id), troops: snap.march.host.troops, from: [d.row.origin.p, d.row.origin.q] },
      ...(m.arriveBell ? { arrive_bell: m.arriveBell } : {}), ...(m.route ? { route: m.route } : {}), ...(m.code ? { code: m.code } : {}), ...(m.programCode !== undefined ? { program_code: m.programCode } : {}), ...(m.problems ? { problems: m.problems } : {}),
      ...(m.signature ? { signature: m.signature } : {}), ...(detail ? { detail: JSON.stringify(detail).slice(0, 500) } : {}), seen, budget: r.budget.state() };
  }
  if (d.name === 'WideMarch') {
    const p = d.plan;
    const m = await deps.wideMarch.send(r, p, { transitSlot: (r.memory.wideMarches ?? 0) % 4 });
    // (the home province has not settled this turn yet — at ×60 it is caught up only for part of each turn: the page's
    //  muster wait. Nothing was sent; not a refusal: the bell is used up ('held') and it looks again next turn)
    if (!m.ok && m.step === 'preparing' && ['NotResident', 'NotFinal'].includes(m.code)) {
      // (a war resident leaves the next WAR_WIDE_RETRY_BELLS turns to the war step: in a ×60 wide world this prepare was
      //  held NotResident for 70 turns in a row, and the war never got a turn — fix-loop4 play-through)
      if (war && Number.isSafeInteger(turnBell)) r.memory.wideMarchUntil = turnBell + WAR_WIDE_RETRY_BELLS;
      r.budget.spent('held', deps.now(), turnBell);
      return { resident: r.index, wallet: r.key.address, step: 'act', act: 'WideMarch', outcome: 'wait', code: m.code, why: 'the home province did not settle while it waited (this turn and the next): a later turn', test_only: true,
        ...(m.looks !== undefined ? { looks: m.looks, waited_ms: m.waitedMs } : {}), seen, budget: r.budget.state() };
    }
    const outcome = m.ok ? 'landed' : m.unknown ? 'unknown' : m.step === 'failed' ? 'failed' : 'refused';
    if (war && outcome !== 'refused') r.memory.lastBell = spentBell(nowBell, deps);
    noteOutcome(r.memory, d, outcome);
    r.budget.spent(outcome, deps.now(), turnBell);
    return { resident: r.index, wallet: r.key.address, step: 'act', act: 'WideMarch', why: d.why, outcome, test_only: true,
      to: { p: p.dest.p, q: p.dest.q, tile: p.destTile }, from: { p: p.holding.p, q: p.holding.q, tile: p.host.tile }, host: { id: String(p.host.id), troops: p.host.troops },
      arrive_bell: p.arriveBell, directions: p.directions, ...(m.looks !== undefined ? { looks: m.looks, waited_ms: m.waitedMs } : {}), ...(m.code ? { code: m.code, at: m.step } : {}), ...(m.signature ? { signature: m.signature } : {}), seen, budget: r.budget.state() };
  }
  const sent = await deps.submit({ name: d.name, v: d.v, fields: d.fields }, r);
  let outcome, signature = null, code = null;
  const detail = r.lastRefusal ?? null; r.lastRefusal = null;
  // One action per resident per bell (Q16-2): its relay (PR #62, resident-turns.mjs) says this bell's action was already
  // taken — by this resident or by another writer for it. Not a refusal: nothing was sent, nothing is marked tried; the
  // bell is used up here as well ('held', no refusal counted), so the policy does not ask again before the next bell
  if (!sent.ok && sent.code === RESIDENT_ALREADY_ACTED) {
    if (war) r.memory.lastBell = spentBell(nowBell, deps);
    r.budget.spent('held', deps.now(), turnBell);
    return { resident: r.index, wallet: r.key.address, step: 'act', act: d.name, outcome: 'wait', code: sent.code, why: 'this resident already acted in this bell: the next bell', ...(detail ? { detail: JSON.stringify(detail).slice(0, 400) } : {}), seen, budget: r.budget.state() };
  }
  // (the runner's definite rejection — LocalActRejected, 2026-11-19 — counts as before, when it was LocalActSendRefused: failed)
  let programCode = null;
  if (!sent.ok) { outcome = sent.code === 'LocalActRejected' ? 'failed' : 'refused'; code = sent.code; programCode = Number.isInteger(sent.programCode) ? sent.programCode : null; }
  else {
    signature = sent.signature;
    const f = await deps.follow(signature, r);
    outcome = f.state === 'landed' ? 'landed' : f.state === 'failed' ? 'failed' : sent.relayCode === 'LocalActSendRefused' ? 'failed' : 'unknown';
    code = f.code ?? sent.relayCode ?? null;
    programCode = Number.isInteger(f.programCode) ? f.programCode : null;
  }
  if (war && outcome !== 'refused' && d.name !== 'Join') r.memory.lastBell = spentBell(nowBell, deps);
  noteOutcome(r.memory, d, outcome, { code, programCode });
  r.budget.spent(outcome, deps.now(), turnBell);
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
  if (o.lane === COEXIST_LANE_WORD) selectLocalLane(COEXIST_LANE);
  const stop = new AbortController();
  let residents = [], turns = 0, summarised = false;
  const summary = why => { if (summarised) return; summarised = true; print(JSON.stringify({ step: 'stopped', why, turns, residents: residents.map(r => ({ resident: r.index, wallet: r.key.address, budget: r.budget.state() })) })); };
  // (the summary is said at the signal itself: the launcher kills a side process 3 s after SIGINT, maybe mid-send)
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, () => { summary(s); stop.abort(s); });
  let keys;
  try { keys = Array.from({ length: o.count }, (_, index) => (o.keysDir ? keptTestKey(o.keysDir, index) : memoryTestKey())); } catch (e) { process.stderr.write(`operator residents: ${e.message}\n`); return 64; }
  residents = Array.from({ length: o.count }, (_, index) => ({ index, key: keys[index], port: o.ports[index], memory: { ...createResidentMemory(index, o.nations?.[index], { war: o.war }), ...(o.near && index === 0 ? { near: { wallet: o.near, home: null } } : {}) },
    budget: createOperatorBudget({ maxActs: o.maxActs, maxRefusals: o.maxRefusals, minGapMs: o.minGapMs }), identity: null, rulesetHash: null }));
  residents.forEach(r => { r.signer = pageShapedSigner(r.key); r.origin = `http://127.0.0.1:${r.port}`; });
  print(JSON.stringify({ schema: OPERATOR_RESIDENTS_SCHEMA, mode: OPERATOR_RESIDENTS_MODE, test_only: true, keys: o.keysDir ? 'TEST keys kept in the persisted world\'s private keys dir (0600 files, 0700 dir); never printed' : 'memory-only TEST keys, made by this process, never written', wallets: residents.map(r => r.key.address), ...(o.war ? { war: OPERATOR_WAR_MODE } : {}) }));
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
  print(JSON.stringify({ step: 'ready', residents: residents.map(r => ({ resident: r.index, wallet: r.key.address, relay: r.origin, faction: r.memory.near && !r.memory.near.home ? null : r.memory.faction, ...(r.memory.near ? { near: true } : {}) })) }));
  const posts = new Map(residents.map(r => [r.origin, relayPost(globalThis.fetch, a => { r.lastRefusal = a; })]));
  const postFor = r => posts.get(r.origin);
  const deps = {
    now: () => Date.now(),
    nowSecs: async () => chainSecondsOf(await getJson(`${o.herald}/h/status`)),
    season: () => getJson(`${o.herald}/h/season`),
    read: wallet => getJson(`${o.herald}/h/me/${wallet}`),
    route: places => getJson(`${o.herald}/h/world/wide/route?at=${encodeURIComponent(places.map(t => `${t.p},${t.q}`).join(';'))}`),
    // (Q-LP19-1 (a): its own territory summary; the territory tiles only when a tile was let go — shared, kept 20 s)
    territoryPlayer: citizen => getJson(`${o.herald}/h/world/wide/territory/player/${citizen}`),
    territoryTiles: cachedFor(20_000, () => getJson(`${o.herald}/h/world/wide/territory`, 6000)),
    submit: (order, r) => submitLocalAct(order, { allowed: () => ({ ok: true, relay: r.origin }), identity: () => r.identity, rulesetHash: () => r.rulesetHash, signer: () => r.signer, post: postFor(r) }),
    follow: (signature, r) => followLocalAct(signature, { origin: r.origin, still: () => !stop.signal.aborted, post: postFor(r), tries: 20, every: 1000 }),
  };
  // (TEST-ONLY wide march: the residents of a wide world march into the wide land through their own relays' depart routes)
  if (o.wide) deps.wideMarch = createWideMarch({ herald: o.herald });
  if (o.wide) deps.wideHost = createWideHost({ herald: o.herald });
  // (expansion-gameplay-1: the live wide land for the reach rule's claim targets)
  if (o.wide) deps.wideLand = createWideLandReader({ herald: o.herald });
  // (TEST-ONLY war world: the world's eyes, read once per loop; the march opened per resident by its own relay)
  const eyes = o.war ? createWarEyes({ herald: o.herald, goals: o.goals ?? null }) : null;
  if (eyes) {
    deps.warView = r => eyes.view(r.key.address, r.memory);
    deps.nowBell = () => eyes.world.nowBell;
    deps.liveBell = () => eyes.liveBell();
    deps.march = (r, snap) => sendWarMarch(r, snap, eyes, { post: marchPostFor(r) });
  }
  const marchPosts = new Map();
  function marchPostFor(r) {
    if (!marchPosts.has(r.origin)) marchPosts.set(r.origin, (origin, path, body) => postLocalMarch(origin, path, body, { fetch: async (url, init) => {
      const res = await globalThis.fetch(String(url).replace(`${origin}/gw/`, `${origin}/`), init);
      if (!res.ok) { try { r.lastRefusal = await res.clone().json(); } catch { /* not JSON */ } }
      return res;
    } }));
    return marchPosts.get(r.origin);
  }
  let why = null, genesis = null, atOnce = false;
  const quiet = createQuietLog();
  while (!stop.signal.aborted) {
    // (the bell, once a round, for every resident's one action: the Season's genesis read until known, then the chain
    //  time; either unknown = nobody sends this round)
    if (genesis === null) {
      const rec = await deps.season().catch(() => null);
      genesis = genesisOf(rec, residents[0]?.rulesetHash);
      if (genesis !== null) atOnce = firstHomeAtOnceOf(rec, residents[0]?.rulesetHash);
    }
    const bell = bellOf(genesis, await deps.nowSecs().catch(() => null));
    if (eyes) {
      try { await eyes.refresh(); } catch (e) { print(JSON.stringify({ at: new Date().toISOString(), turn: turns, step: 'eyes', outcome: 'no-answer', why: String(e?.message ?? e).slice(0, 120) })); await delay(o.cadenceMs, stop.signal); continue; }
      for (const r of residents) if (!r.marchOpen && turns % 5 === 0) {
        try { const m = await openMarch(r.origin, r.key.address); r.marchOpen = m.open === true; if (r.marchOpen || turns % 50 === 0) print(JSON.stringify({ at: new Date().toISOString(), turn: turns, resident: r.index, step: 'march-capability', open: r.marchOpen, trial: m.trial ?? null, ...(m.why ? { why: m.why } : {}) })); } catch { /* its relay is not up yet */ }
      }
    }
    const one = async r => {
      if (stop.signal.aborted || r.budget.state().stopped) return;   // (stopped for good: said once, when it stopped)
      const line = await residentTurn(r, { homes: o.homes, deps, bell, wideTargets: o.wide ?? null, atOnce });
      if (quiet.fresh(line)) print(JSON.stringify({ at: new Date().toISOString(), turn: turns, bell, ...line }));
    };
    // (a war world: every resident takes its turn at once — each has its own relay and its own wallet, and a refused
    //  send's follow must not hold the other residents past the turn; one action per resident per turn still)
    if (o.war) await Promise.all(residents.map(one));
    else for (const r of residents) { if (stop.signal.aborted) break; await one(r); }
    turns++;
    if (residents.every(r => r.budget.state().stopped)) { why = 'every resident is stopped for good'; break; }
    await delay(o.cadenceMs, stop.signal);
  }
  summary(why ?? String(stop.signal.reason ?? 'stopped'));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
