// LIVE CONNECTION TEST, "FRESH ECONOMY": a test-only entry that serves, on ONE loopback origin in the test port
// range, a test page and the EXISTING economy relay's three routes (local-play-act.mjs — used as it is) for the
// page's own Build, Train, Muster and Harvest on a village the same run founds (Join and PlaceHome are PREREQUISITES
// here), against the offline fresh ECONOMY test runner (itest `fresh_economy_runner`).
// Contract: docs/integration/CLAUDE-FRESH-ECONOMY-ENTRY-CONTRACT-20261112.md.
//
//   node permutation-gateway/screens/codex/live-connect-fresh-economy.mjs --page-port <47100-47999> --max-seconds <1-225>
//   … then, on stdin from the harness: ONE line {"runner": <the runner's line 1>}; the runner's {"e_step": …} lines
//   in its order; and, only when the runner ended without `stopped`, ONE
//   {"e_harness":"runner-ended","rc":<int>,"stopped":false}. A refused line is answered {"e_error": …}.
//
// TEST ONLY, and a SEPARATE test from the fresh Join/Home entry (live-connect-fresh.mjs) and from Stage A: it imports
// none of their files, shares no state with them, and its evidence is its own. Not the relay's own entry, not the
// launcher: neither can start this, and no flag or URL of theirs reaches it. No gate constant is read or changed.
// WHAT A PASS IS EVIDENCE OF, at most (a natural clock from Join on, no rule or time changed): an intro Build
// accepted and completed (60 s), Train of 100 in reserve, Muster ACCEPTED (a pending entry), Harvest accepted.
// NOT of: a host on the roster, movement or combat, any other build, costs, production over time, Join / PlaceHome
// (prerequisites), natural season timing, the launcher, or play on the game's own screens.
//
// TWO PHASES, each entered once: (1) the page hands over its PUBLIC key — POST /e/wallet {public_key} → stdout
// {"e_wallet": …}; a second key is refused. (2) the harness's ONE configuring line, checked against the pinned wallet
// and the test pins (purpose "fresh-economy"); then the economy relay is built once. No HTTP request configures.
// WHAT CAN BE SENT: the six commands, ONE EACH, IN THE RUNNER'S ORDER — Join, PlaceHome, Build, Train, Muster,
// Harvest — each only while it is the command the runner announced last and has not reported landed, and only within
// that announcement (nation / expiry; site; item; unit and n; unit, troops and tile; always the announced village).
// From `page-actions-closed` (or `stopped`, or the harness's runner-ended line, or a refused ruleset hash) NOTHING is
// sent — asked again inside the relay as the last thing before its one send. {"e_entry":"send-closed"} is printed
// only for `page-actions-closed` / `stopped`. Status reads go on until the run ends.
// LIFETIME: fixed at start (`--max-seconds`, at most 225): wall clock AND monotonic, latched; the process exits 0.
// BOUNDS: 127.0.0.1 only; Host / Origin / JSON checks; bounded bodies; GET serves the page, its state, and the
// page's own modules read-only. The wallet's SECRET key never comes here: the page signs.
import http from 'node:http';
import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalPlayAct, LocalActError, LOCAL_ACT_ROUTES, LOCAL_ACT_PRESEND_REFUSALS } from '../../src/frontier/local-play-act.mjs';
import { LocalPlayError, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, LOCAL_PLAY_SEASON_ID, errorAnswer } from '../../src/frontier/local-play-relay.mjs';
import { createTestLifetime, testLoopbackPort, TEST_CAPABILITY_MAX_MS, TEST_PORT_MIN, TEST_PORT_MAX } from '../../src/frontier/conquest-test-capability.mjs';
import { seasonPda } from '../../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../../permutation-server/web/sdk/base58.mjs';

export const E_STATE_SCHEMA = 'frontier-live-connect-fresh-economy-state-v1';
export const E_RUNNER_PURPOSE = 'fresh-economy';
// THIS TEST'S OWN ARTEFACT PIN — the program artefact (sha256) the economy runner must state in its line 1. It is
// this entry's constant, NOT the shared `CONQUEST_ARTIFACT_CURRENT` (conquest-table-read.mjs), which the conquest
// evidence and the other test entries read: when the economy runner moves to a rebuilt artefact, ONLY this line
// changes (with this entry's pin list), and nothing of the conquest lane moves with it.
// Now: b64a539a… — the lane artefact REBUILT with the CreateSeason fix (the runner's owner's
// `sbf-seasonfix-b64a539a/permutation_frontier.so`, which the economy harness is fixed to). The conquest lane's
// e6bfe8c2… (which refuses CreateSeason for the fresh runners) is REFUSED here; the shared constant still names it,
// for the conquest evidence, and is not changed by this.
export const E_ARTIFACT_SHA256 = 'b64a539afe066c59c6584ff7928f620647428f1a115df41f9289c772c4447f80';
export const E_PAGE_PORT_MIN = 47100, E_PAGE_PORT_MAX = TEST_PORT_MAX, E_RPC_PORT_MIN = TEST_PORT_MIN, E_RPC_PORT_MAX = 47099;
export const E_MAX_MS = 225000;
export const E_BODY_MAX = 64 * 1024;
export const E_STEP_MAX_BYTES = 32 * 1024;
export const WEB_PREFIX = '/permutation-server/web/';
export const E_PAGE_FILES = Object.freeze({ '/permutation-gateway/screens/codex/live-connect-fresh-economy-steps.mjs': 'live-connect-fresh-economy-steps.mjs', '/permutation-gateway/screens/codex/live-connect-fresh-economy-page-script.mjs': 'live-connect-fresh-economy-page-script.mjs' });
/** The runner's announcements, in the only order they can come; each at most once. */
export const E_STEPS = Object.freeze(['season-created', 'genesis', 'prereq-ready-for-join', 'prereq-join-landed', 'prereq-ready-for-place-home', 'prereq-place-home-landed',
  'ready-for-build', 'build-landed', 'ready-for-train', 'train-landed', 'ready-for-muster', 'muster-accepted', 'ready-for-harvest', 'harvest-landed', 'page-actions-closed', 'stopped']);
/** The six commands in the runner's fixed order: the announcement that opens each, the one that closes it, and whether it is only a prerequisite here. */
export const E_COMMANDS = Object.freeze([
  Object.freeze({ name: 'Join', ready: 'prereq-ready-for-join', landed: 'prereq-join-landed', prerequisite: true }),
  Object.freeze({ name: 'PlaceHome', ready: 'prereq-ready-for-place-home', landed: 'prereq-place-home-landed', prerequisite: true }),
  Object.freeze({ name: 'Build', ready: 'ready-for-build', landed: 'build-landed', prerequisite: false }),
  Object.freeze({ name: 'Train', ready: 'ready-for-train', landed: 'train-landed', prerequisite: false }),
  Object.freeze({ name: 'Muster', ready: 'ready-for-muster', landed: 'muster-accepted', prerequisite: false }),
  Object.freeze({ name: 'Harvest', ready: 'ready-for-harvest', landed: 'harvest-landed', prerequisite: false }),
]);
const HEX64 = /^[0-9a-f]{64}$/, INT = /^-?(0|[1-9][0-9]{0,5})$/, UINT = /^[1-9][0-9]{0,18}$/;
const NOTE = 'Test run on a NEW synthetic, memory-only test season (its clock was moved by the test runner up to genesis; natural from Join on). Join and PlaceHome are prerequisites; then Build, Train, Muster and Harvest, signed by this page\'s test key. Nothing here is play on the game\'s own screens, and nothing here opens the game.';
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const address = s => { try { return typeof s === 'string' && s.length <= 44 && decode(s).length === 32 && encode(decode(s)) === s; } catch { return false; } };
const fault = (status, code) => Object.assign(new Error(code), { status, code, e: true });
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const coordText = s => typeof s === 'string' && INT.test(s);
const village = v => object(v) && coordText(v.p) && coordText(v.q) && int(v.site, 0, 11);
const ints = (a, lo, hi, max) => Array.isArray(a) && a.length > 0 && a.length <= max && a.every(x => int(x, lo, hi)) && new Set(a).size === a.length;
const U32 = 0xffffffff;

/** Why the harness's line does not configure THIS entry, or [] when it does. `line` is exactly `{runner}`. */
export function eConfigProblems(line, { wallet, pagePort }) {
  if (!exact(line, ['runner'])) return ['the line must have exactly runner'];
  const out = [], r = line.runner;
  if (!object(r)) return ['runner must be the runner\'s line 1'];
  if (r.program !== LOCAL_PLAY_PROGRAM) out.push('program is not the local-play program');
  if (r.season !== seasonPda(LOCAL_PLAY_PROGRAM, LOCAL_PLAY_SEASON_ID)[0] || r.season_id !== LOCAL_PLAY_SEASON_ID) out.push('season is not the program\'s Season of id 11');
  const rpcPort = testLoopbackPort(r.rpc_url);
  if (rpcPort === null || rpcPort < E_RPC_PORT_MIN || rpcPort > E_RPC_PORT_MAX || rpcPort === pagePort) out.push(`rpc_url must be http://127.0.0.1:<${E_RPC_PORT_MIN}-${E_RPC_PORT_MAX}>`);
  if (r.player_wallet !== wallet) out.push('player_wallet is not the public key the page handed over');
  if (r.artifact?.sha256 !== E_ARTIFACT_SHA256) out.push('artifact is not this test\'s pinned one');
  if (typeof r.runner_instance !== 'string' || !HEX64.test(r.runner_instance) || /^0{64}$/.test(r.runner_instance)) out.push('runner_instance must be 64 lowercase hex');
  const t = r.test_capability;
  if (!object(t) || t.purpose !== E_RUNNER_PURPOSE || t.synthetic !== true || t.memory_only !== true || t.outside_network !== false) out.push(`test_capability must state purpose ${E_RUNNER_PURPOSE}, synthetic: true, memory_only: true, outside_network: false`);
  return out;
}

/** Why an announcement's own content is not usable, or null (its village is checked against the run's by `step`). */
export function eStepProblem(v) {
  if (!object(v) || !E_STEPS.includes(v.e_step)) return 'not an announcement of this run';
  const s = v.e_step;
  if (s === 'season-created' && v.ruleset_hash !== LOCAL_PLAY_RULESET_HASH) return 'ruleset_hash is not the relay\'s';
  if (s === 'prereq-ready-for-join') {
    if (!Array.isArray(v.home_provinces) || v.home_provinces.length === 0 || v.home_provinces.length > 512
        || !v.home_provinces.every(h => object(h) && coordText(h.p) && coordText(h.q) && int(h.nation, 0, 5))) return 'home_provinces [{p, q, nation}]';
    if (typeof v.max_session_expiry !== 'string' || !UINT.test(v.max_session_expiry)) return 'max_session_expiry';
  }
  if (s === 'prereq-ready-for-place-home' && (!int(v.faction, 0, 5) || !Array.isArray(v.candidates) || v.candidates.length === 0 || v.candidates.length > 2048 || !v.candidates.every(village))) return 'faction, candidates [{p, q, site}]';
  if (s === 'prereq-place-home-landed' && !village(v)) return 'p, q, site';
  if (['ready-for-build', 'ready-for-train', 'ready-for-muster', 'ready-for-harvest'].includes(s) && !village(v.village)) return 'village {p, q, site}';
  if (s === 'ready-for-build' && (!ints(v.items, 0, 5, 6) || v.intro_secs !== 60)) return 'items (0-5), intro_secs 60';
  if (s === 'ready-for-train' && (!ints(v.units, 0, 6, 7) || !int(v.min_n, 1, U32) || !int(v.max_n, v.min_n, U32))) return 'units, min_n, max_n';
  if (s === 'ready-for-muster' && (!int(v.unit, 0, 6) || !int(v.min_troops, 1, U32) || !int(v.max_troops, v.min_troops, U32) || !ints(v.tiles, 0, 60, 61))) return 'unit, min_troops, max_troops, tiles';
  return null;
}

/**
 * THE COMMAND THAT IS OPEN NOW, from the announcements received: the one whose `ready` announcement is the LAST
 * `ready` received and whose `landed` has not come — or null. (So an earlier command can never be sent once a later
 * one was announced, whatever was skipped.)
 */
export function eCurrent(steps) {
  const has = n => steps.some(s => s.e_step === n);
  let open = null;
  for (const c of E_COMMANDS) if (has(c.ready)) open = c;
  return open !== null && !has(open.landed) ? open : null;
}

/** Why a submit body is not one this entry lets through NOW, or null. Checked BEFORE the relay sees the body. */
export function eSendProblem(body, { steps, used }) {
  const c = object(body) ? E_COMMANDS.find(x => x.name === body.name) : undefined;
  if (!c) return 'not-one-of-the-six';
  const of = name => steps.find(s => s.e_step === name) ?? null;
  if (of('season-created')?.ruleset_hash !== LOCAL_PLAY_RULESET_HASH) return 'ruleset-not-confirmed';
  if (used[c.name]) return 'sent-already';
  if (eCurrent(steps) !== c) return 'not-the-announced-command';
  const a = of(c.ready), s = body.subject, f = body.fields;
  if (!object(s) || !object(f)) return 'not-as-announced';
  if (c.name === 'Join') {
    if (!a.home_provinces.some(h => h.nation === s.faction)) return 'not-an-announced-nation';
    const e = f.session_expiry; if (typeof e !== 'string' || !UINT.test(e) || BigInt(e) > BigInt(a.max_session_expiry)) return 'expiry-over-the-announced-bound';
    return null;
  }
  const at = (v, h) => object(h) && Number(v.p) === h.p && Number(v.q) === h.q && v.site === h.site;
  if (c.name === 'PlaceHome') return s.faction === a.faction && a.candidates.some(x => at(x, s.holding)) ? null : 'not-an-announced-site';
  // the four: the announced village, and the announced choices only
  if (!at(a.village, s.holding)) return 'not-the-announced-village';
  if (c.name === 'Build') return a.items.includes(f.item) ? null : 'not-an-announced-item';
  if (c.name === 'Train') return a.units.includes(f.unit) && int(f.n, a.min_n, a.max_n) ? null : 'not-the-announced-training';
  if (c.name === 'Muster') return f.unit === a.unit && int(f.troops, a.min_troops, a.max_troops) && a.tiles.includes(f.tile) ? null : 'not-the-announced-muster';
  return Object.keys(f).length === 0 ? null : 'not-as-announced';   // Harvest: no fields
}

/** `{handle(req), configure(line), step(v), harness(v), state(), close(), closed()}` over `pagePort`, `maxMs`, the two clocks and `page`. */
export function createEconomyEntry({ pagePort, maxMs = E_MAX_MS, now = () => Date.now(), mono = () => performance.now(), page, readWeb = async () => null, readScript = async () => null, emit = () => {},
  make = { act: createLocalPlayAct } }) {
  if (!Number.isInteger(pagePort) || pagePort < E_PAGE_PORT_MIN || pagePort > E_PAGE_PORT_MAX) throw new Error(`live-connect fresh economy: --page-port must be ${E_PAGE_PORT_MIN}-${E_PAGE_PORT_MAX}`);
  if (!Number.isSafeInteger(maxMs) || maxMs < 1000 || maxMs > E_MAX_MS || maxMs > TEST_CAPABILITY_MAX_MS) throw new Error('live-connect fresh economy: --max-seconds must be 1-225');
  if (typeof page !== 'string' || page.length === 0) throw new Error('live-connect fresh economy: no page');
  const expires = now() + maxMs, life = createTestLifetime({ expires_at_ms: expires }, { now, mono });
  const live = () => { if (!life.alive()) throw fault(410, 'Closed'); };
  const hosts = new Set([`127.0.0.1:${pagePort}`, `localhost:${pagePort}`]), origins = new Set([`http://127.0.0.1:${pagePort}`, `http://localhost:${pagePort}`]);
  let phase = 'wallet', wallet = null, configured = false, shown = null, act = null, routes = {};
  let sendClosed = false, worldEnded = false, runnerEnded = null, rulesetRefused = false;
  const steps = [], used = Object.fromEntries(E_COMMANDS.map(c => [c.name, false]));
  const sendOpen = () => life.alive() && !sendClosed;
  const closedForSends = () => new LocalActError('LocalActClosed');
  const closeSends = () => { if (sendClosed) return; sendClosed = true; emit({ e_entry: 'send-closed' }); };
  // (what the run was doing: the command announced last and not yet reported landed — for the "ended during" words)
  const during = () => { const c = eCurrent(steps); return c === null ? null : c.prerequisite ? `${c.name} (prerequisite)` : c.name; };

  function configure(line) {
    live();
    if (configured) throw fault(409, 'ConfiguredAlready');
    if (runnerEnded !== null) throw fault(409, 'RunnerEnded');
    if (phase !== 'awaiting-runner') throw fault(409, 'NoWalletYet');
    const problems = eConfigProblems(line, { wallet, pagePort });
    if (problems.length) throw Object.assign(fault(400, 'BadConfiguration'), { problems });
    const r = line.runner;
    const cfg = { localPlay: true, rpc: r.rpc_url, program: r.program, season: r.season, wallet, rulesetHash: LOCAL_PLAY_RULESET_HASH,
      prepareBin: '/nonexistent/not-used-by-the-economy-relay', cuLimit: '1000000', loadedLimit: '67108864' };
    let built;
    try { built = make.act({ cfg, runnerInstance: r.runner_instance, test: { rpcOk: url => testLoopbackPort(url) !== null, sendGuard: () => { if (!sendOpen()) throw closedForSends(); } } }); }
    catch (e) { throw Object.assign(fault(400, 'BadConfiguration'), { problems: [String(e?.message ?? e)] }); }
    act = built;
    const read = f => async body => { live(); const out = await f(body); live(); return out; };
    routes = {
      [LOCAL_ACT_ROUTES.context]: read(b => act.context(b)),
      [LOCAL_ACT_ROUTES.status]: read(b => act.status(b)),
      [LOCAL_ACT_ROUTES.submit]: async body => {
        live();
        if (!sendOpen()) throw closedForSends();
        const why = eSendProblem(body, { steps, used });
        if (why !== null) throw new LocalActError('LocalActNotAllowed', { fresh_economy: why });
        // ONE per command: taken before the relay is asked; given back only when the relay refused BEFORE its send
        const name = body.name; used[name] = true;
        try { return await act.submit(body); }
        catch (e) { if (e instanceof LocalActError && LOCAL_ACT_PRESEND_REFUSALS.includes(e.code)) used[name] = false; throw e; }
      },
    };
    shown = Object.freeze({ runner_test_capability: Object.freeze({ purpose: r.test_capability.purpose, synthetic: true, memory_only: true, outside_network: false }),
      identity: Object.freeze({ address: wallet, programId: r.program, seasonAddress: r.season, cluster: 'localnet' }), ruleset_hash: LOCAL_PLAY_RULESET_HASH, runner_instance: r.runner_instance });
    configured = true; phase = 'ready';
    emit({ e_entry: 'ready', synthetic: true, remaining_ms: life.remainingMs() });
    return true;
  }

  function step(v) {
    live();
    if (phase !== 'ready') throw fault(409, 'NotReady');
    if (runnerEnded !== null) throw fault(409, 'RunnerEnded');
    let size; try { size = JSON.stringify(v).length; } catch { throw fault(400, 'BadStep'); }
    if (size > E_STEP_MAX_BYTES) throw fault(400, 'BadStep');
    if (object(v) && v.e_step === 'season-created' && v.ruleset_hash !== LOCAL_PLAY_RULESET_HASH) { sendClosed = true; rulesetRefused = true; throw fault(400, 'RulesetHashMismatch'); }
    if (eStepProblem(v) !== null) throw fault(400, 'BadStep');
    // THE SIXTEEN, IN THEIR FIXED ORDER, NONE SKIPPED: only the announcement that follows the last one received is
    // taken. (So no `ready-for-…` is ever taken without the `…-landed` before it, and a run's record cannot show a
    // command opened that the runner had not reached. A run that ends early ends with the harness's line, not a jump.)
    const at = E_STEPS.indexOf(v.e_step), last = steps.length ? E_STEPS.indexOf(steps.at(-1).e_step) : -1;
    if (at <= last) throw fault(409, 'StepOutOfOrder');
    if (at !== last + 1) throw fault(409, 'StepSkipped');
    // every `village` is the site PlaceHome landed on (the announcement that says so must have come first)
    if (Object.hasOwn(v, 'village')) { const home = steps.find(s => s.e_step === 'prereq-place-home-landed'); if (!home || home.p !== v.village.p || home.q !== v.village.q || home.site !== v.village.site) throw fault(400, 'VillageMismatch'); }
    steps.push(Object.freeze(structuredClone(v)));
    if (v.e_step === 'page-actions-closed' || v.e_step === 'stopped') closeSends();
    if (v.e_step === 'stopped' && !worldEnded) { worldEnded = true; act?.close(); emit({ e_entry: 'world-ended' }); }
    return true;
  }

  /** G2 — the harness's word that the runner ended WITHOUT `stopped`: exactly `{e_harness: "runner-ended", rc, stopped: false}`, once, in any phase. */
  function harness(v) {
    live();
    if (!exact(v, ['e_harness', 'rc', 'stopped']) || v.e_harness !== 'runner-ended' || v.stopped !== false || !int(v.rc, -1, 65535)) throw fault(400, 'BadHarnessLine');
    if (runnerEnded !== null) throw fault(409, 'RunnerEndedAlready');
    if (worldEnded) throw fault(409, 'RunnerEndedAfterStopped');
    runnerEnded = Object.freeze({ rc: v.rc, during: during() }); sendClosed = true; act?.close();
    emit({ e_entry: 'runner-ended-noted', rc: v.rc, during: runnerEnded.during });
    return true;
  }

  const world = () => (worldEnded ? 'ended' : runnerEnded !== null ? 'ended-incomplete' : 'running');
  const state = () => ({ schema: E_STATE_SCHEMA, phase: life.alive() ? phase : 'closed', synthetic: true, note: NOTE, wallet, remaining_ms: life.remainingMs(),
    ...(runnerEnded !== null && life.alive() ? { world: 'ended-incomplete', runner_rc: runnerEnded.rc, ended_during: runnerEnded.during } : {}),
    ...(phase === 'ready' && life.alive() ? { ...shown, ruleset: rulesetRefused ? 'refused' : steps.some(s => s.e_step === 'season-created') ? 'confirmed' : 'not-yet-announced',
      steps: [...steps], current: sendClosed ? null : eCurrent(steps)?.name ?? null, send: sendClosed ? 'closed' : 'open', world: world(), used: { ...used } } : {}) });

  async function handle({ method, path: p, host, origin, type, body }) {
    const json = (status, v) => ({ status, type: 'application/json', body: JSON.stringify(v) });
    try {
      if (!hosts.has(host)) return json(403, { code: 'HostDenied' });
      if (method !== 'GET' && method !== 'POST') return json(405, { code: 'MethodNotAllowed' });
      if (method === 'POST') {
        if (!origins.has(origin)) return json(403, { code: 'OriginDenied' });
        if (typeof type !== 'string' || type.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, { code: 'JsonOnly' });
      }
      live();
      if (method === 'GET') {
        if (p === '/') return { status: 200, type: 'text/html; charset=utf-8', body: page };
        if (p === '/e/state') return json(200, state());
        if (p.startsWith(WEB_PREFIX)) { const file = await readWeb(p.slice(WEB_PREFIX.length)); live(); return file ? { status: 200, type: file.type, body: file.body } : json(404, { code: 'NotFound' }); }
        if (Object.hasOwn(E_PAGE_FILES, p)) { const file = await readScript(E_PAGE_FILES[p]); live(); return file ? { status: 200, type: 'text/javascript; charset=utf-8', body: file } : json(404, { code: 'NotFound' }); }
        return json(404, { code: 'NotFound' });
      }
      if (p === '/e/wallet') {
        if (phase !== 'wallet') return json(409, { code: 'WalletAlreadyPinned' });
        if (!exact(body, ['public_key']) || !address(body.public_key) || body.public_key === LOCAL_PLAY_PROGRAM) return json(400, { code: 'BadPublicKey' });
        wallet = body.public_key; phase = 'awaiting-runner'; emit({ e_wallet: wallet });
        return json(200, { pinned: wallet });
      }
      const key = `POST ${p.startsWith('/gw/') ? p.slice(3) : p}`, route = Object.hasOwn(routes, key) ? routes[key] : null;
      if (!route) return json(phase === 'ready' ? 404 : 409, { code: phase === 'ready' ? 'NotFound' : 'NotReady' });
      return json(200, await route(body));
    } catch (e) {
      if (e?.e === true) return json(e.status, { code: e.code });
      if (e instanceof LocalActError) return json(e.status, { error: e.message, code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
      if (typeof e?.status === 'number' && typeof e?.code === 'string' && !(e instanceof LocalPlayError)) return json(e.status, { error: e.message, code: e.code });
      const a = errorAnswer(e); return json(a.status, a.body);
    }
  }
  return Object.freeze({ handle, configure, step, harness, state, close() { life.end(); sendClosed = true; act?.close(); }, closed: () => !life.alive() });
}

export function parseArgs(argv) {
  const want = ['--page-port', '--max-seconds'], out = {};
  if (argv.length !== want.length * 2) throw new Error('live-connect fresh economy: exactly --page-port, --max-seconds');
  for (let i = 0; i < argv.length; i += 2) { if (!want.includes(argv[i]) || Object.hasOwn(out, argv[i])) throw new Error(`live-connect fresh economy: bad argument ${argv[i]}`); out[argv[i]] = argv[i + 1]; }
  const port = /^[1-9][0-9]{4}$/.test(out['--page-port']) ? Number(out['--page-port']) : NaN, secs = /^[1-9][0-9]{0,2}$/.test(out['--max-seconds']) ? Number(out['--max-seconds']) : NaN;
  if (!(port >= E_PAGE_PORT_MIN && port <= E_PAGE_PORT_MAX)) throw new Error(`live-connect fresh economy: --page-port must be ${E_PAGE_PORT_MIN}-${E_PAGE_PORT_MAX}`);
  if (!(secs >= 1 && secs * 1000 <= E_MAX_MS)) throw new Error('live-connect fresh economy: --max-seconds must be 1-225');
  return { pagePort: port, maxMs: secs * 1000 };
}

/** A page module under `root`, read-only: `.mjs` / `.css` only, no path that leaves the root, no symbolic link. */
export async function readWebFile(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 200 || rel.includes('\0') || rel.includes('\\') || rel.split('/').some(s => s === '' || s === '.' || s === '..')) return null;
  const type = rel.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : rel.endsWith('.css') ? 'text/css; charset=utf-8' : null;
  if (type === null) return null;
  try {
    const full = path.join(root, rel), st = await lstat(full);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const real = await realpath(full), realRoot = await realpath(root);
    if (real !== path.join(realRoot, rel)) return null;
    return { type, body: await readFile(full) };
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = parseArgs(process.argv.slice(2));
  const { E_PAGE } = await import('./live-connect-fresh-economy-page.mjs');
  const root = fileURLToPath(new URL('../../../permutation-server/web/', import.meta.url));
  const emit = v => console.log(JSON.stringify(v));
  const here = fileURLToPath(new URL('./', import.meta.url));
  const entry = createEconomyEntry({ ...a, page: E_PAGE, emit, readWeb: rel => readWebFile(root, rel),
    readScript: async name => (Object.values(E_PAGE_FILES).includes(name) ? (await readWebFile(here, name))?.body ?? null : null) });
  const server = http.createServer(async (req, res) => {
    let body;
    const peer = req.socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'LoopbackOnly' })); }
    if (req.method === 'POST') {
      const chunks = []; let size = 0, tooBig = false;
      for await (const c of req) { size += c.length; if (size > E_BODY_MAX) { tooBig = true; break; } chunks.push(c); }
      if (tooBig) { res.writeHead(413, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'BodyTooLarge' })); }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'InvalidJson' })); }
    }
    const u = new URL(req.url, 'http://x');
    const r = await entry.handle({ method: req.method, path: u.pathname, host: req.headers.host, origin: req.headers.origin, type: req.headers['content-type'], body });
    res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(r.body);
  });
  server.listen(a.pagePort, '127.0.0.1', () => emit({ e_entry: 'listening', page: `http://127.0.0.1:${a.pagePort}/`, synthetic: true, max_seconds: a.maxMs / 1000 }));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk; if (buf.length > 4 * E_BODY_MAX) { emit({ e_error: 'StdinTooLarge' }); buf = ''; return; }
    let i; while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim() === '') continue;
      try {
        const v = JSON.parse(line), is = k => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, k);
        if (is('e_step')) entry.step(v); else if (is('e_harness')) entry.harness(v); else entry.configure(v);
      } catch (e) { emit({ e_error: e?.code ?? 'BadLine', ...(e?.problems ? { problems: e.problems } : {}) }); }
    }
  });
  setTimeout(() => { entry.close(); server.close(); server.closeAllConnections?.(); process.exit(0); }, a.maxMs);
}
