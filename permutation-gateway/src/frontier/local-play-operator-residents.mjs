// LOCAL PLAY, TEST-ONLY — operator AI residents (⑤ option A, owner decision 2026-11-18): the ACTING side.
//
//   node permutation-gateway/src/frontier/local-play-operator-residents.mjs --count <1-4> \
//     --relay-ports <p1,p2,…> --herald http://localhost:<world proxy port> --homes <runner ready-for-join JSON> \
//     [--cadence-ms 6000] [--max-acts 60] [--max-refusals 12] [--min-gap-ms 4000]
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
// Every step is one JSON line on stdout (the launcher keeps it in the world's directory: operators.out).
// Same rules as a person: no other route, no operator read, no clock control, no account write, no RPC of the runner.
// No model, no network beyond 127.0.0.1, no paid API. SIGINT/SIGTERM: stops, prints a summary line, exits 0.
//
// TEST-ONLY war world (`--war operator-war-v1`, the launcher's `--operator-war`; owner t359u): up to 12 residents, two
// per nation; each turn the world's eyes are read once (local-play-operator-march.mjs: the page's herald client, keeps
// and kernel), each resident's war snapshot is taken, the policy decides (defend / attack / muster / train / economy),
// at most ONE action per resident per turn (owner Q16-2), and a march is sealed and sent by the page's own flow to the
// resident's own relay (opened only by the page's own capability read with the TEST-ONLY trial).
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { encode } from '../../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction, wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { submitLocalAct, postLocalAct, followLocalAct } from '../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { postLocalMarch } from '../../../permutation-server/web/frontier/flocalplay-march.mjs';
import { OPERATOR_RESIDENTS_MODE, OPERATOR_RESIDENTS_SCHEMA, OPERATOR_RESIDENTS_MAX, OPERATOR_DEFAULTS, createResidentMemory, createOperatorBudget, decideNext, noteOutcome, residentView } from './local-play-operator-policy.mjs';
import { OPERATOR_WAR_MODE, OPERATOR_WAR_MAX, mayActThisTurn } from './local-play-operator-war.mjs';
import { createWarEyes, openMarch, sendWarMarch } from './local-play-operator-march.mjs';

/** A war world's pace: residents look every 2 s (one action per turn still), and a budget for a long world. */
export const WAR_DEFAULTS = Object.freeze({ cadenceMs: 2000, maxActs: 5000, maxRefusals: 400, minGapMs: 1000 });
/** Bells after its arrival a keep a resident marched on counts as taken by it (its contest runs 72 turns). */
export const TARGET_HOLD_BELLS = 80;

const SPKI_ED25519_PREFIX = 12;   // (an ed25519 SPKI DER is 12 bytes of header, then the 32-byte public key)

/** One TEST resident key, in memory only: `{address, signMessage(bytes) → 64 bytes}`. The private half never leaves this closure. */
export function memoryTestKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_ED25519_PREFIX));
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
const delay = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    if (!k || !['count', 'relay-ports', 'herald', 'homes', 'cadence-ms', 'max-acts', 'max-refusals', 'min-gap-ms', 'war'].includes(k) || o[k] !== undefined || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    o[k] = argv[i + 1];
  }
  if (o.war !== undefined && o.war !== OPERATOR_WAR_MODE) throw new Error(`--war must be exactly ${OPERATOR_WAR_MODE}`);
  const war = o.war === OPERATOR_WAR_MODE;
  const count = Number(o.count);
  if (!/^([1-9]|1[0-2])$/.test(String(o.count)) || count < 1 || count > (war ? OPERATOR_WAR_MAX : OPERATOR_RESIDENTS_MAX)) throw new Error('--count');
  const D = war ? WAR_DEFAULTS : OPERATOR_DEFAULTS;
  const ports = String(o['relay-ports'] ?? '').split(',').map(Number);
  if (ports.length !== count || ports.some(p => !Number.isInteger(p) || p < 41000 || p > 41999)) throw new Error('--relay-ports');
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d{4,5}$/.test(o.herald ?? '')) throw new Error('--herald (loopback only)');
  const homes = JSON.parse(o.homes ?? 'null');
  if (!Array.isArray(homes) || !homes.length) throw new Error('--homes');
  const num = (k, d) => { if (o[k] === undefined) return d; const n = Number(o[k]); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${k}`); return n; };
  return { count, ports, herald: o.herald, homes, war, cadenceMs: num('cadence-ms', D.cadenceMs), maxActs: num('max-acts', D.maxActs), maxRefusals: num('max-refusals', D.maxRefusals), minGapMs: num('min-gap-ms', D.minGapMs) };
}

/**
 * One resident's one turn: read, decide, maybe send and follow. → the line to print. `deps` (tests): `read(wallet)`,
 * `submit(order, ctx)`, `follow(signature)`, `now()` (ms), `nowSecs()`.
 */
export async function residentTurn(r, { homes, deps }) {
  const t = deps.now();
  let me;
  try { me = await deps.read(r.key.address); } catch (e) { return { resident: r.index, wallet: r.key.address, step: 'read', outcome: 'no-answer', why: String(e?.message ?? e).slice(0, 80) }; }
  // (`deps.view`: tests only — the same reduction from an already decoded record)
  const view = deps.view ? deps.view(me) : residentView(me, (kind, bytes) => decodePrefix(kind, bytes, { profile: 2 }));
  // (a war resident with a village: its war snapshot — the page's own reads, keeps and target finder)
  let snap = null;
  if (r.memory.war && view?.holding && deps.warView) { try { snap = await deps.warView(r); } catch (e) { snap = null; } }
  const nowBell = r.memory.war && deps.nowBell ? deps.nowBell() : null;
  const d = decideNext(r.memory, view, { homes, nowSecs: view?.joined === false ? await deps.nowSecs().catch(() => null) : null,
    war: snap ? { nowBell, reserve: snap.reserve, hostCount: snap.hostCount, march: snap.march, settling: snap.settling } : null });
  const seen = { joined: view?.joined ?? null, faction: view?.faction ?? null, village: view?.holding ? `${view.holding.p},${view.holding.q},${view.holding.site}` : null,
    ...(snap ? { bell: nowBell, reserve: snap.reserve, hosts: snap.hostCount, ready: snap.ready } : {}) };
  if (d.wait) { noteOutcome(r.memory, d, 'wait'); return { resident: r.index, wallet: r.key.address, step: 'decide', outcome: 'wait', why: d.why, seen }; }
  // (one action per resident per turn, owner Q16-2: a war resident that acted this turn waits for the next)
  if (r.memory.war && !mayActThisTurn(r.memory.lastBell, nowBell, d.name)) return { resident: r.index, wallet: r.key.address, step: 'turn', outcome: 'wait', why: 'already acted this turn', want: d.name, seen };
  const allow = r.budget.allow(t);
  if (!allow.ok) return { resident: r.index, wallet: r.key.address, step: 'budget', outcome: allow.later ? 'later' : 'stopped', why: allow.why, want: d.name, seen };
  if (d.name === 'Depart') {
    if (!r.marchOpen) return { resident: r.index, wallet: r.key.address, step: 'march', outcome: 'wait', why: 'the march is not open on its own relay', want: 'Depart', seen };
    r.lastRefusal = null;
    const m = await deps.march(r, snap);
    const detail = r.lastRefusal; r.lastRefusal = null;
    const outcome = m.ok ? 'landed' : m.step === 'check' || m.step === 'route' || m.step === 'sealing' ? 'refused' : m.code === 'TransactionFailed' ? 'failed' : m.step === 'sent' && m.code !== 'network' ? 'refused' : 'unknown';
    if (outcome !== 'refused') r.memory.lastBell = nowBell;
    if (outcome === 'landed' || outcome === 'unknown') (r.memory.targets ??= {})[`${d.row.p},${d.row.q}`] = (m.arriveBell ?? nowBell) + TARGET_HOLD_BELLS;
    noteOutcome(r.memory, d, outcome);
    r.budget.spent(outcome, deps.now());
    return { resident: r.index, wallet: r.key.address, step: 'act', act: 'Depart', kind: d.kind, why: d.why, outcome,
      to: { p: d.row.p, q: d.row.q, tile: d.row.tile, holder: d.row.holder, guard: d.row.troops }, host: { id: String(snap.march.host.id), troops: snap.march.host.troops, from: [d.row.origin.p, d.row.origin.q] },
      ...(m.arriveBell ? { arrive_bell: m.arriveBell } : {}), ...(m.route ? { route: m.route } : {}), ...(m.code ? { code: m.code } : {}), ...(m.programCode !== undefined ? { program_code: m.programCode } : {}), ...(m.problems ? { problems: m.problems } : {}),
      ...(m.signature ? { signature: m.signature } : {}), ...(detail ? { detail: JSON.stringify(detail).slice(0, 500) } : {}), seen, budget: r.budget.state() };
  }
  const sent = await deps.submit({ name: d.name, v: d.v, fields: d.fields }, r);
  let outcome, signature = null, code = null;
  const detail = r.lastRefusal ?? null; r.lastRefusal = null;
  if (!sent.ok) { outcome = 'refused'; code = sent.code; }
  else {
    signature = sent.signature;
    const f = await deps.follow(signature, r);
    outcome = f.state === 'landed' ? 'landed' : f.state === 'failed' ? 'failed' : sent.relayCode === 'LocalActSendRefused' ? 'failed' : 'unknown';
    code = f.code ?? sent.relayCode ?? null;
  }
  if (r.memory.war && outcome !== 'refused' && d.name !== 'Join') r.memory.lastBell = nowBell;
  noteOutcome(r.memory, d, outcome);
  r.budget.spent(outcome, deps.now());
  return { resident: r.index, wallet: r.key.address, step: 'act', act: d.name, fields: JSON.parse(JSON.stringify(d.fields, (_, v) => (typeof v === 'bigint' ? v.toString() : v))), why: d.why, outcome, ...(code ? { code } : {}), ...(detail ? { detail: JSON.stringify(detail).slice(0, 400) } : {}), ...(signature ? { signature } : {}), seen, budget: r.budget.state() };
}

export async function main(argv = process.argv.slice(2), { print = s => process.stdout.write(`${s}\n`) } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`operator residents: ${e.message}\n`); return 64; }
  const stop = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, () => stop.abort(s));
  const residents = Array.from({ length: o.count }, (_, index) => ({ index, key: memoryTestKey(), port: o.ports[index], memory: createResidentMemory(index, { war: o.war }),
    budget: createOperatorBudget({ maxActs: o.maxActs, maxRefusals: o.maxRefusals, minGapMs: o.minGapMs }), identity: null, rulesetHash: null }));
  residents.forEach(r => { r.signer = pageShapedSigner(r.key); r.origin = `http://127.0.0.1:${r.port}`; });
  print(JSON.stringify({ schema: OPERATOR_RESIDENTS_SCHEMA, mode: OPERATOR_RESIDENTS_MODE, test_only: true, keys: 'memory-only TEST keys, made by this process, never written', wallets: residents.map(r => r.key.address), ...(o.war ? { war: OPERATOR_WAR_MODE } : {}) }));
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
    read: wallet => getJson(`${o.herald}/h/me/${wallet}`),
    submit: (order, r) => submitLocalAct(order, { allowed: () => ({ ok: true, relay: r.origin }), identity: () => r.identity, rulesetHash: () => r.rulesetHash, signer: () => r.signer, post: postFor(r) }),
    follow: (signature, r) => followLocalAct(signature, { origin: r.origin, still: () => !stop.signal.aborted, post: postFor(r), tries: 20, every: 1000 }),
  };
  // (TEST-ONLY war world: the world's eyes, read once per loop; the march opened per resident by its own relay)
  const eyes = o.war ? createWarEyes({ herald: o.herald }) : null;
  if (eyes) {
    deps.warView = r => eyes.view(r.key.address, r.memory);
    deps.nowBell = () => eyes.world.nowBell;
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
  let turns = 0;
  while (!stop.signal.aborted) {
    if (eyes) {
      try { await eyes.refresh(); } catch (e) { print(JSON.stringify({ at: new Date().toISOString(), turn: turns, step: 'eyes', outcome: 'no-answer', why: String(e?.message ?? e).slice(0, 120) })); await delay(o.cadenceMs, stop.signal); continue; }
      for (const r of residents) if (!r.marchOpen && turns % 5 === 0) {
        try { const m = await openMarch(r.origin, r.key.address); r.marchOpen = m.open === true; if (r.marchOpen || turns % 50 === 0) print(JSON.stringify({ at: new Date().toISOString(), turn: turns, resident: r.index, step: 'march-capability', open: r.marchOpen, trial: m.trial ?? null, ...(m.why ? { why: m.why } : {}) })); } catch { /* its relay is not up yet */ }
      }
    }
    // (a war world: every resident takes its turn at once — each has its own relay and its own wallet, and a refused
    //  send's follow must not hold the other residents past the turn; one action per resident per turn still)
    if (o.war) await Promise.all(residents.map(async r => { if (!stop.signal.aborted) print(JSON.stringify({ at: new Date().toISOString(), turn: turns, ...await residentTurn(r, { homes: o.homes, deps }) })); }));
    else for (const r of residents) {
      if (stop.signal.aborted) break;
      const line = await residentTurn(r, { homes: o.homes, deps });
      print(JSON.stringify({ at: new Date().toISOString(), turn: turns, ...line }));
    }
    turns++;
    await delay(o.cadenceMs, stop.signal);
  }
  print(JSON.stringify({ step: 'stopped', why: String(stop.signal.reason ?? 'stopped'), turns, residents: residents.map(r => ({ resident: r.index, wallet: r.key.address, budget: r.budget.state() })) }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
