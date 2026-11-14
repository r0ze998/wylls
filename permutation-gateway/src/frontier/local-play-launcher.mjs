// Local development only. Never accepts private keys, executable paths or arguments over HTTP.
//
//   node permutation-gateway/src/frontier/local-play-launcher.mjs --root <abs checkout> --data <abs dir> \
//     --runner <abs localnet-expedition-play> --herald <abs frontier-herald, feature local-play-bootstrap> \
//     --depart <abs frontier-experimental-expedition-depart-prepare> --preview <abs frontier-original-expedition-preview> \
//     --resident <abs frontier-experimental-expedition-prepare> --artifact <abs .so> --artifact-sha <its sha256, hex> \
//     [--world-preset local-conquest-test-v1 [--conquest <abs conquest prepare CLI>]] [--prepare-scale <10-60>]
//     [--port 41920] [--world-port 41924]
//
// One loopback page origin (`--port`): the game's own static files, and three same-origin JSON routes that take a
// PUBLIC address or nothing:
//   POST /local-play/start  {wallet} → {herald}          a new world for that address (the same address: the same world)
//   POST /local-play/stop   {wallet} → {stopped: true}   ends that one world, on its owner's explicit press
//   POST /local-play/worlds {}       → {worlds}          the worlds this launcher runs (public addresses), when asked
// A world is three processes this launcher started (runner, relay, herald) and a public proxy in this process, on
// five loopback ports from `--world-port` (the second world: +5): RPC, WS, public proxy, relay, herald.
// At most two worlds. Each ends by itself after its life (two hours unless `--world-ttl-minutes` chose another, fixed
// once at the world's start and told to its page as `expiry`), past 128 MiB of output, or under 5.25 GiB of free disk.
// Only what this process started is ever stopped, and no world is stopped to make room for another: at the limit a
// start is refused with the list of worlds, and the player chooses.
// `--prepare-scale` (off unless given; `prepareWorld` below): a NEW world's clock is run faster, by the runner's own
// time control, only until the runner has opened the destination province, and is back at 1x — read back — before
// the world is handed to its page. Never afterwards, never from HTTP, never another world's clock.
// `--world-preset local-conquest-test-v1` (off unless given; `conquestProof` below): the runner is asked for that
// explicit local test preset, and what THIS start then proves of itself — its artefact's two markers, and the
// runner's own `conquest_world` statement once it has opened the destination (the preset, this program, Season and
// RPC, the Free City it read from the chain) — is handed on as two statements: to the relay (a capability file, only
// when the relay's own conditions are established) and to the page (`conquestWorld` beside `herald`). A world that
// proves less gets neither: it is never said to be a conquest world.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { decode, encode } from '../../../permutation-server/web/sdk/base58.mjs';
const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
const RULESET = '234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d';
/** Worlds at once; a world's life (the default; `--world-ttl-minutes` may choose another); its output; the disk's floor (bytes). */
export const WORLD_LIMIT = 2, WORLD_TTL_MS = 7200000, WORLD_OUTPUT_MAX = 128 * 1024 ** 2, DISK_FLOOR = 5.25 * 1024 ** 3;
/** The page's statement of a world's automatic end (`expiryOf`). */
export const WORLD_EXPIRY_SCHEMA = 'frontier-local-play-world-expiry-v1';
/** The largest time a Date can hold (ms since the epoch). */
const DATE_MAX_MS = 8.64e15;
/**
 * `--world-ttl-minutes` (optional; absent: the default two hours, `WORLD_TTL_MS`): a world's life in whole minutes,
 * written as a plain decimal integer (`1`…, no sign, no leading zero, no fraction, no exponent). Anything else is
 * refused, never rounded or clamped. No upper bound is set here: the operator chooses; the value must stay a safe
 * integer of milliseconds (the world's own start then checks `started + ttl` against what a Date can hold).
 * → milliseconds.
 */
export function parseWorldTtl(raw) {
  if (raw === undefined) return WORLD_TTL_MS;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) throw fault('InvalidWorldTtl');
  const minutes = Number(raw), ms = minutes * 60000;
  if (!Number.isSafeInteger(minutes) || !Number.isSafeInteger(ms) || ms > DATE_MAX_MS) throw fault('InvalidWorldTtl');
  return ms;
}
/**
 * A world's automatic end, fixed ONCE at its TTL origin `started` (the moment its guard starts counting): `started +
 * ttlMs`, both safe integers and the sum within a Date. Throws (the world is then not started) when it is not.
 */
export function worldExpiry(started, ttlMs) {
  if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw fault('WorldExpiryUnrepresentable', 503);
  const at = started + ttlMs;
  if (!Number.isSafeInteger(at) || at > DATE_MAX_MS) throw fault('WorldExpiryUnrepresentable', 503);
  return at;
}
/**
 * What the page is told of a world's automatic end: bound to that world's runner instance (null when the runner
 * states none; the page then shows the end as unknown). Real (wall) clock, not game time.
 */
export function expiryOf(started, ttlMs, instance) {
  return Object.freeze({ schema: WORLD_EXPIRY_SCHEMA, startedAt: started, ttlMs, expiresAt: worldExpiry(started, ttlMs), instance: instance ?? null });
}
/** A world's five loopback ports: the runner's RPC and WS, the public proxy (the page's herald), the relay, the herald behind the proxy. */
export const worldPorts = (worldPort, slot) => { const b = worldPort + slot * 5; return { rpc: b, ws: b + 1, herald: b + 2, relay: b + 3, internalHerald: b + 4 }; };
const delay = ms => new Promise(r => setTimeout(r, ms));
const fault = (code, status = 400) => Object.assign(new Error(code), { code, status });
/** The policy of every answer that is not a page, and the headers of every answer: as the herald sends them (server.rs). */
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const SHIELD = Object.freeze({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
const answer = (res, status, obj) => { res.writeHead(status, { ...SHIELD, 'content-security-policy': API_CSP, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
/** The request's body, at most `max` bytes. Past that nothing is kept, and the refusal waits for the request's end so the client receives it. */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', b => { size += b.length; if (size <= max) chunks.push(b); else if (size > max * 16) req.destroy(); });
    req.on('end', () => (size > max ? reject(fault('BodyTooLarge', 413)) : resolve(Buffer.concat(chunks))));
    req.on('error', () => reject(fault('ClientGone'))); req.on('close', () => reject(fault('ClientGone')));
  });
}
export function validWallet(s) { try { return typeof s === 'string' && s.length <= 44 && decode(s).length === 32 && encode(decode(s)) === s; } catch { return false; } }
export function parseStart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !validWallet(value.wallet)) throw fault('InvalidWallet');
  return value.wallet;
}
async function freePort(port) {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once('error', e => reject(e?.code === 'EADDRINUSE' ? fault('PortBusy', 503) : e)); s.listen(port, '127.0.0.1', resolve); });
  await new Promise(r => s.close(r));
}
/**
 * The bytes under `dir`. An entry ALREADY LISTED that disappears before its own read (ENOENT: the herald renames and
 * compresses its files continually, e.g. `h/control/{b}.bin` → `.bin.gz`) holds no bytes any more and counts 0. The world's
 * own directory is never excused: a failure to list it (ENOENT included — the root itself gone) is thrown, as is any
 * other error, so the world's guard still stops it (`guard-failed`) as before. `io` is for tests; `listed` is internal.
 */
export async function bytesUnder(dir, io = fs, listed = false) {
  const gone = e => e?.code === 'ENOENT';
  let total = 0, entries;
  try { entries = await io.readdir(dir, { withFileTypes: true }); } catch (e) { if (listed && gone(e)) return 0; throw e; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await bytesUnder(p, io, true);
    else if (e.isFile()) { try { total += (await io.stat(p)).size; } catch (x) { if (!gone(x)) throw x; } }
  }
  return total;
}
/** The opt-in preparation (`--prepare-scale`): the scale's range, the most chain seconds it may add while fast, the real time allowed beyond what those take, and how long the checks at 1x may take. */
export const PREPARE_SCALE_MIN = 10, PREPARE_SCALE_MAX = 60, PREPARE_CHAIN_MAX = 1200, PREPARE_SLACK_MS = 30000, PREPARE_SETTLE_MS = 45000;
const WIDE_LINE = 'frontier-local-play-wide-destination-v1', KEEPER_LINE = 'frontier-local-play-keeper-v1';
/**
 * The page's view of this world's keeper, from the runner's LATEST keeper line, given only on the player's own press:
 * codes and numbers, never the runner's text. `state`:
 *   'unknown'  the keeper itself stopped on a send whose landing it could not see (the origin driver halts the loop);
 *   'stopped'  the keeper itself stopped (a refusal, or asked to);
 *   'partial'  the keeper still runs, but its destination or resident driver ended alone (keeper_loop: their unknown
 *              outcome or refusal ends only that driver); `part`: 'unknown' or 'refused'. Never resent;
 *   'waiting'  blocked or retrying a fetch; 'running'.
 * null before its first line.
 */
export function keeperSummary(lines) {
  const k = (Array.isArray(lines) ? lines : []).filter(v => v && typeof v === 'object' && v.schema === KEEPER_LINE).at(-1);
  if (!k) return null;
  const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : null), has = v => v !== null && v !== undefined;
  const halted = has(k.stopped) || k.running !== true;
  const driverStopped = [k.destination_step, k.resident_step].some(s => typeof s === 'string' && /^(Stopped|Unknown)\b/.test(s));
  const state = halted ? (has(k.unknown_signature) ? 'unknown' : 'stopped') : has(k.unknown_signature) || driverStopped ? 'partial'
    : has(k.blocked) || has(k.last_error) ? 'waiting' : 'running';
  const out = { state, resident: typeof k.resident === 'boolean' ? k.resident : null, resolvedNext: n(k.resolved_next), bell: n(k.bell) };
  if (state === 'partial') out.part = has(k.unknown_signature) ? 'unknown' : 'refused';
  return out;
}
/** One call of this world's own runner's JSON-RPC (loopback, the port this launcher gave it): its result. */
async function runnerRpc(port, method, params = []) {
  const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const v = await r.json();
  if (!r.ok || !v || v.error !== undefined || v.result === undefined || v.result === null) throw fault('RunnerRpcRefused', 503);
  return v.result;
}
/** The runner's public lines so far (its stdout: one JSON object a line; a line still being written is not one yet). */
async function runnerLines(dir) {
  const out = [];
  for (const line of (await fs.readFile(path.join(dir, 'runner.out'), 'utf8')).split('\n')) { try { const v = JSON.parse(line); if (v && typeof v === 'object') out.push(v); } catch { /* not a whole line yet */ } }
  return out;
}
/**
 * The opt-in preparation of a NEW world, before it is handed to its page and never after. The runner's own time
 * control (`frontier_setScale`, named in its public line) runs this world's clock at `scale` until the runner's own
 * wide-destination task reports the destination province opened by its real instructions; then — whatever happened in
 * between — the clock is set back to 1x and read back at 1x. Only after that: the keeper's next line must show the
 * home resident with nothing refused, and the herald must serve the destination as a captured record (what the page
 * reads before it offers a departure), the clock still at 1x. Nothing is written to the chain from here and no state
 * or result is put in: the one thing changed is the clock's scale, for at most `PREPARE_CHAIN_MAX` chain seconds.
 * Resolves what was done (also written to `prepare.json`); any refusal is thrown, and the caller ends the world.
 */
export async function prepareWorld({ scale, dir, rpc, herald, meta, stopping, limit = {} }) {
  const chainMax = limit.prepareChainMax ?? PREPARE_CHAIN_MAX, slack = limit.prepareSlackMs ?? PREPARE_SLACK_MS, settle = limit.prepareSettleMs ?? PREPARE_SETTLE_MS, pace = limit.preparePaceMs ?? 250;
  const dest = meta?.wide_destination?.dest;
  if (!Array.isArray(meta?.time_control_rpc) || !meta.time_control_rpc.includes('frontier_setScale') || !Array.isArray(dest) || dest.length !== 2 || !dest.every(Number.isSafeInteger)) throw fault('PrepareUnavailable', 503);
  const opened = lines => lines.some(v => v.schema === WIDE_LINE && v.step === 'opened' && Array.isArray(v.detail?.dest) && v.detail.dest[0] === dest[0] && v.detail.dest[1] === dest[1]);
  const halted = lines => lines.some(v => (v.schema === WIDE_LINE && v.stopped !== undefined) || (v.schema === KEEPER_LINE && (v.stopped || v.unknown_signature)));
  const at1x = c => !!c && c.scale === 1 && (c.pendingScale ?? null) === null && c.paused === false && Number.isSafeInteger(c.unixTimestamp);
  const began = Date.now(), before = await runnerRpc(rpc, 'frontier_status');
  // (a new world runs at 1x; a clock in any other state is not this launcher's to change)
  if (!at1x(before)) throw fault('PrepareClock', 503);
  let lines = await runnerLines(dir), asked = false, fast = null, failure = null, after = before;
  try {
    if (!opened(lines)) {
      // (from here the scale may have changed, even if this call's answer is lost: the restore below runs in every case)
      asked = true; fast = await runnerRpc(rpc, 'frontier_setScale', [scale]);
      const deadline = Date.now() + (chainMax / scale) * 1000 + slack;
      for (;;) {
        if (stopping()) { failure = fault('WorldStopped', 503); break; }
        lines = await runnerLines(dir);
        if (halted(lines)) { failure = fault('PrepareHalted', 503); break; }
        if (opened(lines)) break;
        const now = await runnerRpc(rpc, 'frontier_status');
        if (!(now.unixTimestamp - before.unixTimestamp < chainMax) || Date.now() >= deadline) { failure = fault('PrepareTimeout', 503); break; }
        await delay(pace);
      }
    }
  } catch (e) { failure = e?.status ? e : fault('PrepareFailed', 503); }
  // Whatever happened above: back to 1x, and read back at 1x, before anything else is looked at.
  if (asked) {
    let restored = false;
    for (let i = 0; i < (stopping() ? 2 : 40) && !restored; i++) {
      try { if (i % 8 === 0) await runnerRpc(rpc, 'frontier_setScale', [1]); after = await runnerRpc(rpc, 'frontier_status'); restored = at1x(after); } catch { /* asked again */ }
      if (!restored) await delay(Math.min(pace, 250));
    }
    if (!restored) throw fault('PrepareClockNotRestored', 503);
  }
  if (failure) throw failure;
  // At 1x. The keeper's NEXT line and the herald's own answer, with the clock still at 1x at each look.
  const mark = (await runnerLines(dir)).length, until = Date.now() + settle; let keeper = null, captured = false;
  for (;;) {
    if (stopping()) throw fault('WorldStopped', 503);
    lines = await runnerLines(dir);
    if (halted(lines)) throw fault('PrepareHalted', 503);
    const last = lines.slice(mark).filter(v => v.schema === KEEPER_LINE).at(-1);
    keeper = last && last.running === true && last.resident === true && !last.last_error ? last : null;
    if (!captured) {
      try {
        const r = await fetch(`http://127.0.0.1:${herald}/h/world/wide/route?at=${dest[0]}%2C${dest[1]}`, { signal: AbortSignal.timeout(2000) });
        const row = r.ok ? (await r.json())?.route?.[0] : null;
        captured = !!row && String(row.p) === String(dest[0]) && String(row.q) === String(dest[1]) && row.state === 'captured';
      } catch { /* asked again */ }
    }
    after = await runnerRpc(rpc, 'frontier_status');
    if (!at1x(after)) throw fault('PrepareClockNotRestored', 503);
    if (keeper && captured) break;
    if (Date.now() >= until) throw fault('PrepareNotSettled', 503);
    await delay(pace);
  }
  const report = { accelerated: asked, scale: asked ? scale : 1, dest, chainSeconds: after.unixTimestamp - before.unixTimestamp, wallMs: Date.now() - began,
    slots: { before: before.slot ?? null, fastAt: fast?.atSlot ?? null, after: after.slot ?? null }, clock: { scale: after.scale, pendingScale: after.pendingScale ?? null, paused: after.paused },
    keeper: { bell: keeper.bell ?? null, resolved_next: keeper.resolved_next ?? null, resident: true }, herald: { dest: 'captured' }, at: Date.now() };
  await fs.writeFile(path.join(dir, 'prepare.json'), JSON.stringify(report));
  return { accelerated: report.accelerated, scale: report.scale, chainSeconds: report.chainSeconds, wallMs: report.wallMs };
}
/** A conquest world's explicit local preset, its artefact's two markers (in this order), and the two statements a start makes of itself: to the relay and to the page. */
export const CONQUEST_WORLD_PRESET = 'local-conquest-test-v1';
/**
 * The NATURAL world's preset (`--world-preset local-natural-v1`, with `--natural-runner` and `--economy page-signed-v1`):
 * a new Season by the runner's own instructions, the player's real Join and PlaceHome from the page, then the keeper on
 * that home (itest `natural_play`). No fixture, no wide destination, no preparation; the herald folds the real
 * transactions only (no `--local-play-metadata`: nothing synthetic to seed). The start answer says `natural: true`.
 */
export const NATURAL_WORLD_PRESET = 'local-natural-v1';
/**
 * `--march-trial local-march-trial-v1` (TEST-ONLY, optional; off unless given in exactly these words; natural preset
 * only): the relay of each world is started with the same words, so its march capability answers `trial: true`, and
 * the page is addressed with `march=trial`. Only both together stand in for the march's `liveProven` readiness, so a
 * first approved live trial of the ordinary march is possible without opening it anywhere else. It changes no game
 * rule, no origin or destination rule, and opens no conquest gate. Without it nothing changes.
 */
export const MARCH_TRIAL_MODE = 'local-march-trial-v1';
/**
 * `--capture-demo capture-demo-v1 --demo-scale <10-60>` (TEST-ONLY, optional, both or neither; natural preset with
 * `--march-trial` only): the natural runner, after the player's PlaceHome, compresses its memory-only chain's clock by
 * the scale and creates test participants on the player's wedge so the next ring opens by the program's own rule
 * (itest `capture_demo`). The start answer says `captureDemo: {scale}` and the page is addressed with `demo=capture`.
 * No game rule changes; the natural preset without these options is unchanged.
 */
export const CAPTURE_DEMO_MODE = 'capture-demo-v1';
/**
 * `--contest-pair contest-pair-v1` (TEST-ONLY; only with the capture demo): ONE memory-only world for TWO players, each
 * with their own page and memory-only key. The first wallet to press start waits (`pairWaiting`); the second distinct
 * wallet's press starts one runner with both (`--second-wallet`); the second player's page reaches its OWN relay (pinned to
 * its wallet) through its own proxy (`/gw` → that relay, everything else → the shared herald), on the second slot's ports.
 * Either page asking again gets the same world; a second world is never started for either; one stop or the TTL ends it
 * for both. Both sides are people: there is no automatic opponent.
 */
export const CONTEST_PAIR_MODE = 'contest-pair-v1';
/** `--demo-scale`: a whole number 10..60 written plainly, or null. */
export function parseDemoScale(raw) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]$/.test(raw)) return null;
  const n = Number(raw); return n >= 10 && n <= 60 ? n : null;
}
/** How long the natural runner may take to state its first line (its own Season setup, the genesis round fetch). */
export const NATURAL_FIRST_LINE_MS = 180000;
/**
 * The longest a natural start can take here before it answers or refuses: the first line, then the herald's 30 s.
 * The page's own wait for a natural start (flocalplay.mjs `NATURAL_START_MS`, 240 s) is longer, so the page never gives
 * up on a start this launcher is still making. The page knows the mode before any start from `world=natural`.
 */
export const NATURAL_START_BOUND_MS = NATURAL_FIRST_LINE_MS + 30000;
/** The one word that asks for the page-signed economy routes (the relay's own `ECONOMY_MODE`: local-play-relay-server.mjs). */
export const ECONOMY_MODE = 'page-signed-v1';
export const CONQUEST_ARTIFACT_MARKERS = Object.freeze(['PSF_LOCALNET_EXPEDITION_SBF_BUILD', 'PSF_LOCALNET_CONQUEST_SBF_BUILD']);
export const CONQUEST_CAPABILITY_SCHEMA = 'frontier-local-play-conquest-capability-v1', CONQUEST_WORLD_SCHEMA = 'frontier-local-play-conquest-world-v1';
/** How long, once the destination is open and the clock is back at 1x, the runner's own statement is waited for. */
export const CONQUEST_STATEMENT_MS = 10000;
/** frontier-abi `FreeCityRule::CanonicalHashV1` (1 is NoFreeCity): the rule byte the runner's "opened" line shows for a world with a Free City. */
const FREE_CITY_CANONICAL = 2;
/** The runner's statements of a conquest world among its public lines: the top-level key `conquest_world` of a line, each distinct one once. */
const conquestStatements = lines => [...new Map(lines.filter(v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, 'conquest_world')).map(v => [JSON.stringify(v.conquest_world), v.conquest_world])).values()];
/**
 * What THIS start proves of itself as a conquest world, from its own public start result and nothing else:
 *   the preset     asked for in words on this launcher's command line (`c.worldPreset`);
 *   the artefact   the very file this launcher was given has the sha256 it was given (recomputed here), the runner's
 *                  first line reports that sha256, and those bytes carry each of the two markers exactly once (an
 *                  expedition-only artefact carries one);
 *   the world      program, Season and RPC of the runner's own first line (already held to this launcher's pins and
 *                  to this world's port by the caller);
 *   the opening    the runner's own "opened" line of the destination province (unchanged from the expedition world:
 *                  `frontier-local-play-wide-destination-v1`), whose rules show the canonical Free City rule;
 *   the statement  the runner's own `conquest_world` (docs/integration/CLAUDE-LOCAL-CONQUEST-PRESET-PLAN-20261112.md
 *                  §3: the ONE source of the preset and the Free City), as the top-level key of one of its public
 *                  lines: exactly one, of this preset, this artefact, both markers, this program, Season and RPC,
 *                  with a Free City `{p, q, site, tile}` in the destination province. Whatever else it carries (its
 *                  evidence, what it does not claim) is kept in the record and not passed on.
 * `lines`: the runner's public lines (`runnerLines`; `meta` is the first of them).
 * → `{capability, world, stated, why}`: the relay's statement (local-play-conquest.mjs `conquestCapabilityProblems`)
 * and the page's (flocalplay-conquest.mjs reads it as `FS.localPlay.conquestWorld`), or both null with every reason;
 * `stated` is the runner's statement as it gave it (null unless there is exactly one). Nothing is inferred, nothing is
 * read from anywhere else when the statement is missing, nothing comes from HTTP or from another world, and nothing
 * here establishes anyone's opening condition: a world that proves less is simply not a conquest world to this
 * launcher.
 */
export async function conquestProof({ c, meta, lines }) {
  const why = [], list = [meta, ...(Array.isArray(lines) ? lines : [])];
  if (c?.worldPreset !== CONQUEST_WORLD_PRESET) why.push('no explicit world preset was asked for');
  let bytes = null;
  try { bytes = await fs.readFile(c.artifact); } catch { why.push('the artefact cannot be read'); }
  if (bytes) {
    if (createHash('sha256').update(bytes).digest('hex') !== c.artifactSha) why.push('the artefact file is not the one named by its sha256');
    const count = marker => { let n = 0; for (let i = bytes.indexOf(marker); i !== -1; i = bytes.indexOf(marker, i + 1)) n++; return n; };
    for (const marker of CONQUEST_ARTIFACT_MARKERS) if (count(marker) !== 1) why.push(`the artefact does not carry ${marker} exactly once`);
  }
  if (meta?.artifact?.sha256 !== c?.artifactSha) why.push('the runner reports another artefact');
  if (meta?.program !== PROGRAM || !validWallet(meta?.season) || typeof meta?.rpc_url !== 'string') why.push('the runner\'s line does not name this world');
  const dest = meta?.wide_destination?.dest, there = Array.isArray(dest) && dest.length === 2 && dest.every(Number.isSafeInteger);
  const opened = there ? list.find(v => v?.schema === WIDE_LINE && v.step === 'opened' && Array.isArray(v.detail?.dest) && v.detail.dest[0] === dest[0] && v.detail.dest[1] === dest[1]) : null;
  if (!opened) why.push('the destination province is not opened');
  else if (opened.detail.rules?.free_city !== FREE_CITY_CANONICAL) why.push('the world\'s rules give it no Free City');
  const said = conquestStatements(list), s = said.length === 1 ? said[0] : null, whole = /^-?(0|[1-9][0-9]{0,18})$/;
  if (said.length === 0) why.push('the runner states no conquest world');
  else if (said.length > 1) why.push('the runner states more than one conquest world');
  else if (s === null || typeof s !== 'object' || Array.isArray(s) || s.schema !== CONQUEST_CAPABILITY_SCHEMA) why.push('the runner\'s statement is not a conquest capability');
  else {
    if (s.world_preset !== CONQUEST_WORLD_PRESET) why.push('the runner does not state the conquest preset');
    if (s.artifact_sha256 !== c?.artifactSha) why.push('the runner states another artefact');
    if (!Array.isArray(s.markers) || s.markers.length !== CONQUEST_ARTIFACT_MARKERS.length || s.markers.some((m, i) => m !== CONQUEST_ARTIFACT_MARKERS[i])) why.push('the runner states other markers');
    if (s.program !== meta?.program || s.season !== meta?.season || s.rpc !== meta?.rpc_url) why.push('the runner\'s statement is of another world');
    const f = s.free_city;
    if (f === null || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).length !== 4 || typeof f.p !== 'string' || !whole.test(f.p) || typeof f.q !== 'string' || !whole.test(f.q)
      || !Number.isInteger(f.site) || f.site < 0 || f.site > 11 || !Number.isInteger(f.tile) || f.tile < 0 || f.tile > 60) why.push('the runner does not report the Free City\'s position');
    else if (!there || f.p !== String(dest[0]) || f.q !== String(dest[1])) why.push('the Free City reported is not in the destination province');
  }
  if (why.length) return { capability: null, world: null, stated: s, why };
  const city = () => ({ p: s.free_city.p, q: s.free_city.q, site: s.free_city.site, tile: s.free_city.tile });
  return { why, stated: s,
    capability: { schema: CONQUEST_CAPABILITY_SCHEMA, artifact_sha256: c.artifactSha, markers: [...CONQUEST_ARTIFACT_MARKERS], program: meta.program, season: meta.season, rpc: meta.rpc_url, world_preset: CONQUEST_WORLD_PRESET, free_city: city() },
    world: { schema: CONQUEST_WORLD_SCHEMA, program: meta.program, season: meta.season, world_preset: CONQUEST_WORLD_PRESET, free_city: city() } };
}
/**
 * Whether the relay of this start is given the conquest CLI and the capability: only when there is a capability, a
 * conquest CLI was configured, and the relay's own modules in this checkout say so — every opening condition of
 * local-play-conquest.mjs is established, the relay's own command-line parser takes the very arguments it would be
 * started with (`relayArgs`: the usual ones plus `--conquest-bin` and `--conquest-capability <file>`), and its own
 * checker accepts this capability for the pins those arguments give it. This launcher establishes none of that and
 * overrides none of it: while anything is missing the relay is started as for any world (no conquest route), and
 * `why` names what is missing.
 */
/**
 * The runner's instance id from its public metadata line (`runner_instance`), for the relay's `--runner-instance`.
 * → `{ok: true, id: null}` when the line has no such key (a runner that states none: everything as before);
 * `{ok: true, id}` for exactly 64 lowercase hex, not all zeros; `{ok: false, id: null}` for a key that is present
 * but anything else (the start is then refused). Added 2026-11-12 (Fable) for the relay's settling of an unknown
 * outcome; the runner does not state one yet.
 */
/** Whether the runner's first line states exactly this launcher's capture demo (`demo` = `{scale}` or null). */
/** The runner's first line and this start agree on the contest pair: the same second wallet, or neither mentions it. */
export function runnerPairAgrees(meta, second) {
  const d = meta?.contest_pair;
  if (second === null || second === undefined) return d === undefined;
  return d !== null && typeof d === 'object' && Object.keys(d).sort().join() === 'automatic_opponent,mode,second_wallet,test_only'
    && d.mode === CONTEST_PAIR_MODE && d.second_wallet === second && d.test_only === true && d.automatic_opponent === false;
}
export function runnerDemoAgrees(meta, demo) {
  const d = meta?.capture_demo;
  if (demo === null || demo === undefined) return d === undefined;
  return d !== null && typeof d === 'object' && Object.keys(d).sort().join() === 'mode,scale,test_only' && d.mode === CAPTURE_DEMO_MODE && d.scale === demo.scale && d.test_only === true;
}
export function runnerInstanceOf(meta) {
  if (meta === null || typeof meta !== 'object' || !Object.hasOwn(meta, 'runner_instance')) return { ok: true, id: null };
  const v = meta.runner_instance;
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) && !/^0{64}$/.test(v) ? { ok: true, id: v } : { ok: false, id: null };
}

export async function conquestGateway(c, capability, relayArgs) {
  const why = [];
  if (!capability) why.push('this start has no capability');
  if (!c?.conquest) why.push('no conquest prepare CLI was configured (--conquest)');
  if (capability && c?.conquest) {
    try {
      const at = file => pathToFileURL(path.join(c.root, 'permutation-gateway/src/frontier', file)).href;
      const relay = await import(at('local-play-conquest.mjs')), server = await import(at('local-play-relay-server.mjs'));
      const closed = Object.entries(relay.CONQUEST_OPEN_CONDITIONS).filter(([, ok]) => ok !== true).map(([k]) => k);
      if (closed.length) why.push(`the relay's opening conditions are not established: ${closed.join(', ')}`);
      let pins = null;
      try { pins = server.parseArgs(relayArgs).cfg; } catch { why.push('the relay\'s command line does not take --conquest-capability'); }
      const problems = relay.conquestCapabilityProblems(capability, pins ?? { program: capability.program, season: capability.season, rpc: capability.rpc });
      if (problems.length) why.push(`the relay's own check refuses the capability: ${problems.join('; ')}`);
    } catch { why.push('the relay\'s conquest module cannot be read'); }
  }
  return { pass: why.length === 0, why };
}
export class WorldManager {
  constructor(config, launch = startWorld) { this.config = config; this.launch = launch; this.worlds = new Map(); this.closed = false; this.pairWaiting = null; this.pairOf = new Map(); }
  /** The worlds this launcher runs, by their public addresses: what a refused start shows the player. */
  list() { return [...this.worlds].map(([wallet, w]) => ({ wallet, herald: w.herald, startedAt: w.startedAt, state: w.stopping ? 'stopping' : w.herald ? 'running' : 'starting', ...(w.expiry ? { expiry: w.expiry } : {}) })); }
  start(wallet) {
    if (!validWallet(wallet)) return Promise.reject(fault('InvalidWallet'));
    if (this.closed) return Promise.reject(fault('LauncherClosed', 503));
    if (this.config.contestPair) return this.#pairStart(wallet);
    return this.#start(wallet);
  }
  /**
   * The contest pair (TEST-ONLY): the second player's press is looked up, never started as a world of its own; the first
   * press waits for a second distinct wallet; then ONE world for both. A third wallet is refused while a pair world runs.
   */
  #pairStart(wallet) {
    const first = this.pairOf.get(wallet);
    if (first !== undefined) {
      const record = this.worlds.get(first);
      if (!record) { this.pairOf.delete(wallet); return Promise.reject(fault('WorldNotFound', 404)); }
      if (record.stopping) return Promise.reject(fault('WorldStopping', 409));
      return record.promise.then(view => ({ ...view, herald: record.pairHerald, pair: { role: 'second', mode: CONTEST_PAIR_MODE } }));
    }
    if (this.worlds.has(wallet)) return this.#start(wallet);
    if (this.worlds.size > 0) return Promise.reject(Object.assign(fault('WorldLimit', 409), { worlds: this.list() }));
    if (this.pairWaiting === null || this.pairWaiting === wallet) { this.pairWaiting = wallet; return Promise.resolve({ pairWaiting: true, pair: { mode: CONTEST_PAIR_MODE } }); }
    const a = this.pairWaiting; this.pairWaiting = null; this.pairOf.set(wallet, a);
    return this.#start(a, { second: wallet }).then(() => this.#pairStart(wallet), e => { this.pairOf.delete(wallet); throw e; });
  }
  #start(wallet, opts = {}) {
    const existing = this.worlds.get(wallet); if (existing) return existing.stopping ? Promise.reject(fault('WorldStopping', 409)) : existing.promise;
    // (never an eviction: the refusal names the worlds, and ending one is the player's own press)
    if (this.worlds.size >= WORLD_LIMIT) return Promise.reject(Object.assign(fault('WorldLimit', 409), { worlds: this.list() }));
    const used = new Set([...this.worlds.values()].map(w => w.slot)); let slot = 0; while (used.has(slot)) slot++;
    const record = { slot, promise: null, stop: null, herald: null, startedAt: Date.now(), stopping: null, expiry: null, keeper: null, abort: new AbortController() }; this.worlds.set(wallet, record);
    const forget = () => { if (this.worlds.get(wallet) === record) this.worlds.delete(wallet); for (const [b, a] of this.pairOf) if (a === wallet) this.pairOf.delete(b); };
    record.promise = Promise.resolve().then(() => this.launch(this.config, wallet, slot, forget, record.abort.signal, opts)).then(async world => {
      record.stop = world.stop;
      if (this.closed || record.abort.signal.aborted) { await world.stop(); throw fault(this.closed ? 'LauncherClosed' : 'WorldStopped', 503); }
      record.herald = world.herald;
      // (the world's automatic end, fixed once by the world at its own TTL origin: kept as it came, never recomputed,
      //  so a second start of the same address, a list or a reconnect answers the same and nothing extends it)
      record.expiry = world.expiry ?? null;
      record.keeper = typeof world.keeper === 'function' ? world.keeper : null;
      record.pairHerald = opts.second ? (world.pair?.second === opts.second && typeof world.pair.herald === 'string' ? world.pair.herald : null) : null;
      if (opts.second && record.pairHerald === null) { await world.stop(); throw fault('PairNotReady', 503); }
      return { herald: world.herald, ...(opts.second ? { pair: { role: 'first', mode: CONTEST_PAIR_MODE } } : {}), ...(world.natural === true ? { natural: true } : {}), ...(world.marchTrial === true ? { marchTrial: true } : {}), ...(world.captureDemo ? { captureDemo: world.captureDemo } : {}), ...(world.prepared ? { prepared: world.prepared } : {}), ...(world.conquestWorld ? { conquestWorld: world.conquestWorld } : {}), ...(record.expiry ? { expiry: record.expiry } : {}) };
    }).catch(e => { forget(); throw e; });
    return record.promise;
  }
  /** One world's keeper view (`keeperSummary`), named by its public address; none for a world still starting or ending. */
  async keeper(wallet) {
    if (!validWallet(wallet)) throw fault('InvalidWallet');
    if (this.pairOf.has(wallet)) wallet = this.pairOf.get(wallet);
    const record = this.worlds.get(wallet);
    if (!record || record.stopping || !record.keeper) throw fault('WorldNotFound', 404);
    const keeper = await record.keeper();
    // (the world may have ended while its lines were read — TTL, a stop, a crash: then its view is not given)
    if (this.worlds.get(wallet) !== record || record.stopping) throw fault('WorldNotFound', 404);
    return { keeper };
  }
  /**
   * End one world, named by its public address. Only a world of this manager, and only this one: the others go on.
   * A world still starting is stopped where it is. Resolves once its processes are gone and its ports are free.
   */
  stop(wallet) {
    if (!validWallet(wallet)) return Promise.reject(fault('InvalidWallet'));
    if (this.pairWaiting === wallet) { this.pairWaiting = null; return Promise.resolve({ stopped: true }); }
    if (this.pairOf.has(wallet)) wallet = this.pairOf.get(wallet);
    const record = this.worlds.get(wallet); if (!record) return Promise.reject(fault('WorldNotFound', 404));
    record.stopping ??= this.#end(record, 'requested');
    return record.stopping.then(() => { if (this.worlds.get(wallet) === record) this.worlds.delete(wallet); return { stopped: true }; });
  }
  async #end(record, reason) { record.abort.abort(reason); await record.promise.catch(() => {}); await record.stop?.(reason); }
  /** Stops every world of this manager and takes no more. Resolves once all of them are gone. */
  close() { this.closed = true; return Promise.all([...this.worlds.values()].map(w => (w.stopping ??= this.#end(w, 'launcher-closing')))).then(() => {}); }
}
/** Largest request body the proxy passes on (the herald's own `/gw` limit). */
export const WORLD_BODY_MAX = 64 * 1024;
/**
 * The only writes a page may make to a world: these JSON routes of the local-play relay (local-play-relay-server.mjs,
 * behind the herald's `/gw`), each with its preflight. A relay route is not reachable from the page until it is here.
 */
export const WORLD_POST_ROUTES = Object.freeze([
  '/gw/f/local-play/depart/prepare', '/gw/f/local-play/depart/submit', '/gw/f/local-play/depart/status',
  '/gw/f/local-play/reveal/context', '/gw/f/local-play/reveal/submit', '/gw/f/local-play/reveal/status',
  '/gw/f/local-play/resident/prepare', '/gw/f/local-play/resident/submit', '/gw/f/local-play/resident/status',
  // (local-play-conquest.mjs: the relay serves these only when it was started with --conquest-bin, which this launcher
  //  passes only when its own command line names `--conquest`; admitted here so that opening them needs no change here)
  '/gw/f/local-play/conquest/prepare', '/gw/f/local-play/conquest/submit', '/gw/f/local-play/conquest/status',
  // (local-play-conquest-orders.mjs: the READ-ONLY reservation read; it signs and sends nothing. Served by the relay
  //  only as part of the same conquest object, so it is closed exactly while the three above are)
  '/gw/f/local-play/conquest/orders',
  // (local-play-act.mjs: the page-signed economy commands. The relay serves these only when it was started with
  //  `--economy page-signed-v1`, which this launcher passes only when its own command line says `--economy`; without
  //  it the relay answers 404 and the page says "reads only", as before. Admitted here so that serving them needs no change here)
  '/gw/f/local-play/act/context', '/gw/f/local-play/act/submit', '/gw/f/local-play/act/status',
  // (local-play-march.mjs: the ordinary march's page-signed Depart. DEFAULT CLOSED: the relay serves these only when it
  //  was started with `--march-trial` (which this launcher passes only for its own `--march-trial`, natural worlds only)
  //  AND a pinned runner instance; otherwise it answers 404 and the page keeps the march closed)
  '/gw/f/local-play/march/capability', '/gw/f/local-play/march/submit', '/gw/f/local-play/march/status',
  '/gw/f/expedition/preview',
]);
/** The reads beside the herald's public `/h/*`: the relay's public pins. */
export const WORLD_GET_ROUTES = Object.freeze(['/gw/f/local-play/info']);
export const WORLD_WS_ROUTE = '/h/ws';
/** The request target as `{path, query}` when it is a plain origin-form path (no dot or empty segment, no escape), else null. */
export function worldTarget(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const q = url.indexOf('?'), p = q < 0 ? url : url.slice(0, q), query = q < 0 ? '' : url.slice(q + 1);
  if (!/^\/[A-Za-z0-9/_.~,-]*$/.test(p) || p.split('/').slice(1).some(s => s === '' || s === '.' || s === '..')) return null;
  return /^[\x21-\x7e]*$/.test(query) && !query.includes('#') ? { path: p, query } : null;
}
// The existing herald intentionally has no cross-origin write interface. This proxy stands in front of one world's
// herald and admits only the launcher page: its exact origins, this proxy's own Host, the routes above. It sends no
// credentials on, takes no destination from the request (always 127.0.0.1:targetPort), and serves no page.
export function createWorldProxy({ port, targetPort, launcherPort, relayPort = null }) {
  const origins = new Set([`http://localhost:${launcherPort}`, `http://127.0.0.1:${launcherPort}`]);
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const here = req => ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && hosts.has(req.headers.host);
  const server = http.createServer((req, res) => { pass(req, res).catch(() => { if (!res.headersSent) answer(res, 500, { error: 'WorldProxyError' }); else res.destroy(); }); });
  const pass = async (req, res) => {
    const origin = req.headers.origin, known = origins.has(origin);
    res.setHeader('vary', 'Origin');
    if (!here(req) || (origin !== undefined && !known)) return answer(res, 403, { error: 'WorldOriginDenied' });
    if (known) res.setHeader('access-control-allow-origin', origin);
    const target = worldTarget(req.url); if (!target) return answer(res, 400, { error: 'BadWorldPath' });
    const read = target.path.startsWith('/h/') || WORLD_GET_ROUTES.includes(target.path), write = WORLD_POST_ROUTES.includes(target.path);
    if (!read && !write) return answer(res, 404, { error: 'WorldRouteDenied' });
    if (req.method === 'OPTIONS') {
      // (a preflight exists only for a write: the page's reads are simple requests)
      const asked = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
      if (!known || !write || req.headers['access-control-request-method'] !== 'POST' || asked.some(x => x !== 'content-type')) return answer(res, 403, { error: 'WorldPreflightDenied' });
      res.writeHead(204, { ...SHIELD, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '60', 'cache-control': 'no-store' }); return res.end();
    }
    const post = req.method === 'POST';
    if (post ? !write : !(read && (req.method === 'GET' || req.method === 'HEAD'))) return answer(res, 405, { error: 'MethodNotAllowed' });
    let body = null;
    if (post) {
      if (!known) return answer(res, 403, { error: 'WorldOriginDenied' });
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return answer(res, 415, { error: 'JsonOnly' });
      try { body = await readBody(req, WORLD_BODY_MAX); } catch (e) { return answer(res, e.status ?? 400, { error: e.code ?? 'BadRequest' }); }
    } else req.resume();
    // (the second player's proxy: its relay routes go to ITS relay, as the herald's own `/gw` strips the prefix; the rest to the herald)
    const toRelay = relayPort !== null && target.path.startsWith('/gw/');
    const upstream = http.request({ hostname: '127.0.0.1', port: toRelay ? relayPort : targetPort, method: req.method, agent: false, path: (toRelay ? target.path.slice(3) : target.path) + (target.query ? `?${target.query}` : ''),
      headers: { ...(post ? { 'content-type': 'application/json', 'content-length': body.length } : {}), ...(req.headers.accept ? { accept: req.headers.accept } : {}) } }, r => {
      for (const [k, v] of Object.entries(SHIELD)) res.setHeader(k, v);
      res.setHeader('content-security-policy', API_CSP);
      for (const h of ['content-type', 'content-length', 'cache-control', 'etag', 'content-encoding']) if (r.headers[h]) res.setHeader(h, r.headers[h]);
      res.writeHead(r.statusCode); r.pipe(res);
    });
    upstream.setTimeout(95000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) answer(res, 503, { error: 'WorldNotReady' }); else res.destroy(); });
    // (a page that goes away takes its request with it: the relay cancels a read nobody waits for)
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end(body ?? undefined);
  };
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    const refuse = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.on('error', () => {});
    if (!here(req) || !origins.has(req.headers.origin)) return refuse(403, 'Forbidden');
    if (req.method !== 'GET' || req.url !== WORLD_WS_ROUTE || String(req.headers.upgrade).toLowerCase() !== 'websocket') return refuse(404, 'Not Found');
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const keep = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'].filter(k => typeof req.headers[k] === 'string');
      upstream.write(`GET ${WORLD_WS_ROUTE} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n` + keep.map(k => `${k}: ${req.headers[k]}\r\n`).join('') + '\r\n');
      if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    for (const s of [socket, upstream]) { sockets.add(s); s.on('close', () => sockets.delete(s)); }
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  /** Ends every connection (also the upgraded ones, which the server itself no longer counts) and stops listening. */
  server.closeNow = () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); server.closeAllConnections(); });
  return server;
}
// Children still alive when this process ends are ended with it: nothing this launcher started outlives it.
const live = new Set(); let hooked = false;
function own(child) {
  live.add(child);
  if (!hooked) { hooked = true; process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL'); } catch { /* already gone */ } } }); }
}
const exited = p => p.pid === undefined || p.exitCode !== null || p.signalCode !== null;
/**
 * Starts one world for `wallet` on slot `slot` and resolves `{herald, stop}` when its herald answers through the
 * proxy. `stop(reason)` ends the three processes (SIGINT, then SIGKILL) and the proxy, writes why in the world's
 * directory, calls `onStop` and resolves when all of that is done; every call returns the same promise. The world
 * stops itself the same way when any of its processes ends or a limit is passed. With `c.prepareScale` the world is
 * prepared (`prepareWorld`) after its herald answers and before it is resolved: `{herald, stop, prepared}`. With
 * `c.worldPreset` (which needs the preparation: the Free City's place is known only once the destination is open) the
 * runner is asked for that preset (a runner that cannot make it does not start), its relay is started LAST — once
 * the runner has stated its conquest world and what this start proves of itself is known (`conquestProof`,
 * `conquestGateway`; written to `conquest.json`) — and the page's statement is resolved too:
 * `{herald, stop, prepared, conquestWorld}`. `c.guard` (tests only; the command line cannot set it) overrides the
 * limits and may stand in for the relay's own decision.
 */
export async function startWorld(c, wallet, slot, onStop, signal, opts = {}) {
  const natural = c.worldPreset === NATURAL_WORLD_PRESET;
  if (natural && (!c.naturalRunner || c.economy !== ECONOMY_MODE || c.prepareScale || c.conquest)) throw fault('InvalidWorldPreset', 503);
  const marchTrial = c.marchTrial === true;
  if (c.marchTrial !== undefined && (!marchTrial || !natural)) throw fault('InvalidWorldPreset', 503);
  // (the test-only capture demo: only on a natural world started with the march trial, with a valid scale)
  const demo = c.captureDemo ?? null;
  if (demo !== null && (!natural || !marchTrial || !Number.isInteger(demo.scale) || demo.scale < 10 || demo.scale > 60)) throw fault('InvalidWorldPreset', 503);
  // (`preset`: the conquest lane only; a natural world takes none of its steps)
  const preset = natural ? null : c.worldPreset ?? null;
  if (preset !== null && preset !== CONQUEST_WORLD_PRESET) throw fault('InvalidWorldPreset', 503);
  if (preset !== null && !c.prepareScale) throw fault('WorldPresetNeedsPrepare', 503);
  // (the TEST-ONLY contest pair: a second wallet only with the pair option on a capture-demo world; its relay and proxy
  //  take the NEXT slot's relay and herald ports, which no other world may then use)
  const second = opts.second ?? null;
  if (second !== null && (!c.contestPair || demo === null || !validWallet(second) || second === wallet || slot + 1 >= WORLD_LIMIT)) throw fault('InvalidContestPair', 503);
  const { rpc, ws, herald, relay, internalHerald } = worldPorts(c.worldPort, slot);
  const pairPorts = second !== null ? worldPorts(c.worldPort, slot + 1) : null;
  const limit = { ttlMs: c.worldTtlMs ?? WORLD_TTL_MS, outputMax: WORLD_OUTPUT_MAX, diskFloor: DISK_FLOOR, everyMs: 1000, ...c.guard };
  for (const p of [rpc, ws, herald, relay, internalHerald, ...(pairPorts ? [pairPorts.herald, pairPorts.relay] : [])]) await freePort(p);
  const disk = await fs.statfs(c.data); if (disk.bavail * disk.bsize < limit.diskFloor) throw fault('DiskFloor', 503);
  const dir = path.join(c.data, randomUUID()); await fs.mkdir(dir);
  const children = []; let stopping = null, timer, ready = false, proxy, pairProxy;
  const stop = (reason = 'requested') => (stopping ??= (async () => {
    clearInterval(timer);
    try {
      for (const p of children) if (!exited(p)) p.kill('SIGINT');
      const gone = Promise.all(children.map(p => (exited(p) ? null : new Promise(r => p.once('exit', r)))));
      const within = ms => { let t; return Promise.race([gone, new Promise(r => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t)); };
      await within(3000);
      for (const p of children) if (!exited(p)) p.kill('SIGKILL');
      await within(2000);
      await proxy?.closeNow();
      await pairProxy?.closeNow();
      await fs.writeFile(path.join(dir, 'stopped.json'), JSON.stringify({ reason: String(reason), at: Date.now() })).catch(() => {});
    } finally { for (const p of children) live.delete(p); onStop(); }
  })());
  const aborted = () => { stop(typeof signal.reason === 'string' ? signal.reason : 'aborted'); };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  const launch = (name, executable, args) => {
    if (stopping) throw fault('WorldStopped', 503);
    const out = openSync(path.join(dir, name + '.out'), 'wx'), err = openSync(path.join(dir, name + '.err'), 'wx');
    let child;
    try { child = spawn(executable, args, { cwd: c.root, stdio: ['ignore', out, err], shell: false }); } finally { closeSync(out); closeSync(err); }
    children.push(child); own(child); child.once('error', () => { stop(`${name}-failed`); }); child.once('exit', () => { stop(`${name}-exited`); }); return child;
  };
  // the TTL origin: the world's automatic end is fixed here, once (`worldExpiry` refuses a value a Date cannot hold)
  const started = Date.now(); let checking = false;
  let expiresAt;
  try { expiresAt = worldExpiry(started, limit.ttlMs); } catch (e) { await stop('expiry-unrepresentable'); throw e; }
  timer = setInterval(async () => {
    if (checking || stopping) return; checking = true;
    try {
      const stat = await fs.statfs(c.data);
      if (Date.now() > expiresAt) stop('ttl'); else if (stat.bavail * stat.bsize < limit.diskFloor) stop('disk-floor'); else if (await bytesUnder(dir) > limit.outputMax) stop('output-limit');
    } catch { stop('guard-failed'); } finally { checking = false; }
  }, limit.everyMs); timer.unref();
  try {
    if (natural) launch('runner', c.naturalRunner, ['--artifact', c.artifact, '--artifact-sha256', c.artifactSha, '--player-wallet', wallet, '--rpc-port', String(rpc), '--ws-port', String(ws), '--keeper', 'public-quicknet',
      ...(demo !== null ? ['--capture-demo', CAPTURE_DEMO_MODE, '--demo-scale', String(demo.scale)] : []),
      ...(second !== null ? ['--contest-pair', CONTEST_PAIR_MODE, '--second-wallet', second] : [])]);
    else launch('runner', c.runner, ['--artifact', c.artifact, '--artifact-sha256', c.artifactSha, '--player-wallet', wallet, '--rpc-port', String(rpc), '--ws-port', String(ws), '--keeper', 'public-quicknet', '--wide-destination', 'public-quicknet', ...(preset ? ['--world-preset', preset] : [])]);
    let meta;
    for (let i = 0; i < (natural ? Math.ceil((limit.naturalFirstLineMs ?? NATURAL_FIRST_LINE_MS) / 200) : 150) && !stopping; i++) {
      const line = (await fs.readFile(path.join(dir, 'runner.out'), 'utf8')).split('\n')[0];
      try { meta = JSON.parse(line); } catch {}
      if (meta) break; await delay(200);
    }
    // (the runner's own public line: the dedicated program on this world's port, and — as the herald will require of
    //  the same line — started for THIS address with the artifact this launcher was given)
    if (!meta || stopping || meta.program !== PROGRAM || meta.rpc_url !== `http://127.0.0.1:${rpc}` || !validWallet(meta.season) || !Number.isSafeInteger(meta.season_id)
      || meta.player_wallet !== wallet || meta.artifact?.sha256 !== c.artifactSha) throw fault('RunnerNotReady', 503);
    // (a natural world's runner says so on that line, and a plain runner never does: neither is taken for the other)
    if (natural !== (meta.world === 'natural' && meta.world_preset === NATURAL_WORLD_PRESET)) throw fault('RunnerNotReady', 503);
    // (the test-only capture demo: the runner's own first line states it with this launcher's mode and scale, or does
    //  not mention it at all; anything else is another runner or another mode, refused like any unready runner)
    if (!runnerDemoAgrees(meta, demo)) throw fault('RunnerNotReady', 503);
    // (the contest pair likewise: the runner's first line names THIS second wallet, or a runner of one player never mentions it)
    if (!runnerPairAgrees(meta, second)) throw fault('RunnerNotReady', 503);
    // (the runner's own instance id, when it states one on that line: handed to the relay so that the relay can tell
    //  THIS runner's answers from any other's. A runner that states none starts as before; one that states a
    //  malformed id is not started with — a wrong id is never passed on and never ignored)
    const instance = runnerInstanceOf(meta);
    if (!instance.ok) throw fault('RunnerNotReady', 503);
    const instanceArgs = instance.id === null ? [] : ['--runner-instance', instance.id];
    // (the relay serves the page-signed economy routes only when this launcher was itself started with `--economy page-signed-v1`)
    const economyArgs = c.economy === ECONOMY_MODE ? ['--economy', ECONOMY_MODE] : [];
    // (the test-only march trial reaches the relay only when this launcher was itself started with it: natural only)
    const trialArgs = marchTrial ? ['--march-trial', MARCH_TRIAL_MODE] : [];
    await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(meta), { flag: 'wx' });
    const relayArgsFor = (w, port, conquest = []) => ['--local-play', '--rpc', meta.rpc_url, '--program', meta.program, '--season', meta.season, '--wallet', w, '--ruleset-hash', RULESET, '--prepare-bin', c.depart, '--preview-bin', c.preview, '--resident-bin', c.resident, ...conquest, ...instanceArgs, ...economyArgs, ...trialArgs, '--cu-limit', '1000000', '--loaded-limit', '67108864', '--listen-port', String(port)];
    const relayArgs = (conquest = []) => relayArgsFor(wallet, relay, conquest);
    const startRelay = (conquest = []) => launch('relay', process.execPath, [path.join(c.root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), ...relayArgs(conquest)]);
    // (a world with no preset: its relay starts now, as it always has, and is never given a conquest CLI)
    if (!preset) startRelay();
    // (the second player's relay: the same world, pinned to ITS wallet as actor and payer; never the first's)
    if (second !== null) launch('relay-b', process.execPath, [path.join(c.root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), ...relayArgsFor(second, pairPorts.relay)]);
    // (no --web: the page is the launcher's own; a world serves records and the relay, never a second copy of the page)
    // (a natural world has no synthetic account to seed: its herald folds the real transactions only)
    launch('herald', c.herald, ['--data', path.join(dir, 'herald'), '--program', meta.program, '--season', String(meta.season_id), '--rpc', meta.rpc_url, '--listen', `127.0.0.1:${internalHerald}`, '--source', 'localnet', '--cluster', 'localnet', ...(natural ? [] : ['--local-play-metadata', path.join(dir, 'metadata.json')]), '--relay', `127.0.0.1:${relay}`]);
    proxy = createWorldProxy({ port: herald, targetPort: internalHerald, launcherPort: c.port });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(herald, '127.0.0.1', resolve); });
    if (second !== null) {
      pairProxy = createWorldProxy({ port: pairPorts.herald, targetPort: internalHerald, launcherPort: c.port, relayPort: pairPorts.relay });
      await new Promise((resolve, reject) => { pairProxy.once('error', reject); pairProxy.listen(pairPorts.herald, '127.0.0.1', resolve); });
    }
    for (let i = 0; i < 150 && !stopping; i++) {
      try { const r = await fetch(`http://127.0.0.1:${herald}/h/status`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch {} await delay(200);
    }
    if (!ready || stopping) throw fault('HeraldNotReady', 503);
    await fs.writeFile(path.join(dir, 'processes.json'), JSON.stringify({ started, wallet, ...(second !== null ? { second } : {}), pids: children.map(p => p.pid), ports: [rpc, ws, herald, relay, internalHerald, ...(pairPorts ? [pairPorts.herald, pairPorts.relay] : [])] }));
    // (only with --prepare-scale, only now: after this the launcher never touches this world's clock again)
    const prepared = c.prepareScale ? await prepareWorld({ scale: c.prepareScale, dir, rpc, herald, meta, stopping: () => stopping !== null, limit }) : null;
    let conquestWorld = null;
    if (preset) {
      // The destination is open and the clock is back at 1x. The runner states its conquest world on a line of its
      // own after that (it reads the Free City from the province it opened): waited for a bounded time, then what this
      // start proves of itself, then its relay, once.
      let lines = await runnerLines(dir);
      for (const until = Date.now() + (limit.conquestStatementMs ?? CONQUEST_STATEMENT_MS); conquestStatements(lines).length === 0 && Date.now() < until && !stopping;) { await delay(Math.min(limit.preparePaceMs ?? 250, 250)); lines = await runnerLines(dir); }
      if (stopping) throw fault('WorldStopped', 503);
      const proof = await conquestProof({ c, meta, lines: lines.slice(1) });
      // (the capability is this start's own record whether or not a relay takes it today; the relay gets it, with the
      //  conquest CLI, only when its own modules decide so)
      const capabilityFile = path.join(dir, 'conquest-capability.json'), handed = ['--conquest-bin', c.conquest, '--conquest-capability', capabilityFile];
      if (proof.capability) await fs.writeFile(capabilityFile, JSON.stringify(proof.capability), { flag: 'wx' });
      const gateway = await (limit.conquestGateway ?? conquestGateway)(c, proof.capability, relayArgs(handed));
      const pass = gateway?.pass === true && !!proof.capability && !!c.conquest;
      await fs.writeFile(path.join(dir, 'conquest.json'), JSON.stringify({ preset, stated: proof.stated, world: proof.world, capability: proof.capability, why: proof.why, gateway: { pass, why: gateway?.why ?? [] } }), { flag: 'wx' });
      startRelay(pass ? handed : []);
      // (this relay was started last: the world is handed over only once it says it listens)
      let listening = false;
      for (let i = 0; i < 100 && !stopping && !listening; i++) {
        try { listening = typeof JSON.parse((await fs.readFile(path.join(dir, 'relay.out'), 'utf8')).split('\n')[0]).listen === 'string'; } catch { /* not a whole line yet */ }
        if (!listening) await delay(100);
      }
      if (!listening || stopping) throw fault('RelayNotReady', 503);
      await fs.writeFile(path.join(dir, 'processes.json'), JSON.stringify({ started, wallet, pids: children.map(p => p.pid), ports: [rpc, ws, herald, relay, internalHerald] }));
      conquestWorld = proof.world;
    }
    // (the automatic end the guard above enforces, bound to this runner's instance: the same `started` and TTL)
    const expiry = expiryOf(started, limit.ttlMs, instance.id);
    // (the keeper's latest line, read only when the player asks: `keeperSummary`)
    const keeper = async () => { try { return keeperSummary(await runnerLines(dir)); } catch { return null; } };
    return { herald: `http://localhost:${herald}`, stop, expiry, keeper, ...(second !== null ? { pair: { second, herald: `http://localhost:${pairPorts.herald}` } } : {}), ...(natural ? { natural: true } : {}), ...(marchTrial ? { marchTrial: true } : {}), ...(demo !== null ? { captureDemo: { scale: demo.scale } } : {}), ...(prepared ? { prepared } : {}), ...(conquestWorld ? { conquestWorld } : {}) };
  } catch (e) { await stop(`startup-failed${e?.status && e.code ? `:${e.code}` : ''}`); throw e; }
}
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.txt': 'text/plain' };
export function createLauncherServer(c, manager = new WorldManager(c)) {
  const allowedHosts = new Set([`localhost:${c.port}`, `127.0.0.1:${c.port}`]);
  // The herald's own policy for the Frontier pages, and beside 'self' only the two places a world of this launcher
  // can be: the page reaches nothing else, whatever a reply names.
  const worlds = Number.isInteger(c.worldPort) ? Array.from({ length: WORLD_LIMIT }, (_, slot) => worldPorts(c.worldPort, slot).herald).flatMap(p => [`http://localhost:${p}`, `ws://localhost:${p}`]) : [];
  const PAGE = '/frontier/frontier/index.html', prepare = c.prepareScale ? 'accelerated' : '', world = c.worldPreset === NATURAL_WORLD_PRESET ? 'natural' : '', march = c.marchTrial === true ? 'trial' : '', demoWord = c.captureDemo ? 'capture' : '';
  const pageCsp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src ${["'self'", ...worlds].join(' ')}; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'`;
  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host) || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) throw fault('HostDenied', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/local-play/start' || url.pathname === '/local-play/stop' || url.pathname === '/local-play/worlds' || url.pathname === '/local-play/keeper') {
        if (req.method !== 'POST') throw fault('MethodNotAllowed', 405);
        if (req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw fault('OriginDenied', 403);
        const body = (await readBody(req, 256)).toString('utf8');
        let parsed; try { parsed = JSON.parse(body); } catch { throw fault('InvalidJSON'); }
        if (url.pathname === '/local-play/worlds') {
          // (what a refused start lists, on the player's own request: so a world can be ended before the limit is met)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 0) throw fault('InvalidRequest');
          return answer(res, 200, { worlds: manager.list() });
        }
        const wallet = parseStart(parsed);
        if (url.pathname === '/local-play/keeper') return answer(res, 200, await manager.keeper(wallet));
        return answer(res, 200, url.pathname === '/local-play/start' ? await manager.start(wallet) : await manager.stop(wallet));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fault('MethodNotAllowed', 405);
      const moved = location => { res.writeHead(302, { ...SHIELD, 'content-security-policy': API_CSP, 'cache-control': 'no-store', location }); res.end(); };
      if (url.pathname === '/') return moved(`${PAGE}?localPlay=1&launcher=1&devWallet=off${prepare ? `&prepare=${prepare}` : ''}${world ? `&world=${world}` : ''}${march ? `&march=${march}` : ''}${demoWord ? `&demo=${demoWord}` : ''}`);
      // The launcher page always says how this launcher prepares its worlds (`prepare=accelerated`, or nothing): one
      // asked for with another value is sent to the right address, so the page shows what will really happen.
      // (the same for the natural world's `world=natural`: the page knows before a start which wait and text are right)
      if (url.pathname === PAGE && url.searchParams.get('launcher') === '1' && ((url.searchParams.get('prepare') ?? '') !== prepare || (url.searchParams.get('world') ?? '') !== world || (url.searchParams.get('march') ?? '') !== march || (url.searchParams.get('demo') ?? '') !== demoWord)) {
        const query = new URLSearchParams(url.searchParams); if (prepare) query.set('prepare', prepare); else query.delete('prepare');
        if (world) query.set('world', world); else query.delete('world');
        if (march) query.set('march', march); else query.delete('march');
        if (demoWord) query.set('demo', demoWord); else query.delete('demo');
        return moved(`${PAGE}?${query}`);
      }
      if (!url.pathname.startsWith('/frontier/')) throw fault('NotFound', 404);
      let actual, stat;
      try {
        const decoded = decodeURIComponent(url.pathname.slice('/frontier/'.length));
        actual = await fs.realpath(path.resolve(c.web, decoded === '' || decoded.endsWith('/') ? decoded + 'index.html' : decoded)); stat = await fs.stat(actual);
      } catch { throw fault('NotFound', 404); }
      if (!actual.startsWith(c.web + path.sep) || !stat.isFile()) throw fault('NotFound', 404);
      res.writeHead(200, { ...SHIELD, 'content-security-policy': pageCsp, 'content-type': mime[path.extname(actual)] ?? 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store' });
      if (req.method === 'HEAD') return res.end(); createReadStream(actual).pipe(res);
    } catch (e) {
      // (only this file's own refusals are named; anything else is one opaque code, never a path or a system error)
      if (res.headersSent) return res.destroy();
      answer(res, e?.status ?? 503, { error: e?.status ? e.code : 'LauncherUnavailable', ...(e?.code === 'WorldLimit' && Array.isArray(e.worlds) ? { worlds: e.worlds } : {}) });
    }
  });
  server.requestTimeout = 70000; server.headersTimeout = 10000;
  server.on('close', () => { manager.close(); });
  return { server, manager };
}
export const USAGE = `local-play launcher (this machine only)
  node permutation-gateway/src/frontier/local-play-launcher.mjs
    --root <abs checkout>  --data <abs dir for the worlds' records>
    --runner <abs localnet-expedition-play>  --herald <abs frontier-herald (feature local-play-bootstrap)>
    --depart <abs frontier-experimental-expedition-depart-prepare>  --preview <abs frontier-original-expedition-preview>
    --resident <abs frontier-experimental-expedition-prepare>
    --artifact <abs localnet-expedition .so (for --world-preset: the conquest lane's)>  --artifact-sha <its sha256, 64 hex>
    [--world-preset local-conquest-test-v1: the runner is asked for that explicit local test preset (needs
       --prepare-scale); only what that start then proves of itself, with the runner's own conquest_world line, is
       handed to the relay and the page, or nothing is]
    [--conquest <abs conquest prepare CLI>: only with --world-preset; reaches the relay only with a capability of
       that start and only while the relay's own opening conditions are established]
    [--prepare-scale <10-60>: a NEW world's clock runs that much faster only until the runner has opened the
       destination province, then is back at 1x before the world is handed to its page; without it, natural 1x]
    [--economy page-signed-v1: the relay of each world also serves the page-signed economy commands (Join,
       PlaceHome, Harvest, Build, Train, Muster: the page's own wallet signs, one send each); without it they are
       not served and the page says "reads only"]
    [--world-preset local-natural-v1 --natural-runner <abs localnet-natural-play>: a NEW Season by the runner's own
       instructions, then the player's real Join and PlaceHome from the page (needs --economy page-signed-v1; no
       --prepare-scale, no --conquest); the keeper starts on the home that PlaceHome made]
    [--march-trial local-march-trial-v1: TEST-ONLY, natural preset only: the relay's march capability says trial
       and the page is addressed with march=trial; only both together let an approved live trial of the ordinary
       march open it on that page. No game rule changes; no conquest gate opens]
    [--capture-demo capture-demo-v1 --demo-scale <10-60>: TEST-ONLY, both or neither, natural preset with
       --march-trial only: after the player's home, that world's clock runs <scale> times faster and test
       participants open the next ring; the page says so all session. Never the natural preset's behaviour]
    [--contest-pair contest-pair-v1: TEST-ONLY, only with --capture-demo: ONE world for TWO players (two people, no
       automatic opponent); the first press waits, the second distinct wallet starts it; each page keeps its own key
       and reaches its own relay; one stop or the limit ends it for both]
    [--world-ttl-minutes <whole minutes, decimal>: each world's automatic end, counted from its own start; without it
       two hours. Set here only (never over HTTP); fixed once per world and told to its page as its expiry]
    [--port 41920] [--world-port 41924]
  Ports: the page on --port; a world on five from --world-port (RPC, WS, public proxy, relay, herald), the second
  world on the next five. All within 41000-41999, none of 41904-41907, 127.0.0.1 only.`;
export async function parseConfig(args) {
  const out = {}; const keys = new Set(['root', 'data', 'runner', 'herald', 'depart', 'preview', 'resident', 'artifact', 'artifact-sha', 'conquest', 'world-preset', 'prepare-scale', 'port', 'world-port', 'economy', 'world-ttl-minutes', 'natural-runner', 'march-trial', 'capture-demo', 'demo-scale', 'contest-pair']);
  for (let i = 0; i < args.length; i += 2) { const k = args[i]?.slice(2); if (!args[i]?.startsWith('--') || !keys.has(k) || out[k] || !args[i + 1]) throw fault('InvalidArguments'); out[k] = args[i + 1]; }
  for (const k of ['root', 'data', 'runner', 'herald', 'depart', 'preview', 'resident', 'artifact']) { if (!path.isAbsolute(out[k] ?? '')) throw fault('AbsolutePathRequired'); }
  if (out.conquest !== undefined && !path.isAbsolute(out.conquest)) throw fault('AbsolutePathRequired');
  if (out['natural-runner'] !== undefined && !path.isAbsolute(out['natural-runner'])) throw fault('AbsolutePathRequired');
  const port = Number(out.port ?? 41920), worldPort = Number(out['world-port'] ?? 41924), span = WORLD_LIMIT * 5;
  if (!Number.isInteger(port) || !Number.isInteger(worldPort) || port < 41000 || port > 41999 || worldPort < 41000 || worldPort + span - 1 > 41999 || (port >= worldPort && port <= worldPort + span - 1) || [port, ...Array.from({ length: span }, (_, i) => worldPort + i)].some(p => p >= 41904 && p <= 41907)) throw fault('InvalidPorts');
  if (!/^[a-f0-9]{64}$/.test(out['artifact-sha'] ?? '')) throw fault('ArtifactHashRequired');
  const prepareScale = out['prepare-scale'] === undefined ? undefined : Number(out['prepare-scale']);
  if (prepareScale !== undefined && !(/^[0-9]{2}$/.test(out['prepare-scale']) && prepareScale >= PREPARE_SCALE_MIN && prepareScale <= PREPARE_SCALE_MAX)) throw fault('InvalidPrepareScale');
  // (the conquest lane is asked for in words: the one preset, which needs the preparation; a conquest CLI only with it)
  const worldPreset = out['world-preset'];
  if (worldPreset !== undefined && worldPreset !== CONQUEST_WORLD_PRESET && worldPreset !== NATURAL_WORLD_PRESET) throw fault('InvalidWorldPreset');
  const natural = worldPreset === NATURAL_WORLD_PRESET;
  if (worldPreset !== undefined && !natural && prepareScale === undefined) throw fault('WorldPresetNeedsPrepare');
  if (out.conquest !== undefined && (worldPreset === undefined || natural)) throw fault('ConquestNeedsWorldPreset');
  // (the natural world: its own runner, the page-signed economy (Join and PlaceHome are the player's), natural 1x only)
  if (natural && out['natural-runner'] === undefined) throw fault('NaturalNeedsRunner');
  if (!natural && out['natural-runner'] !== undefined) throw fault('NaturalRunnerNeedsPreset');
  if (natural && out.economy !== ECONOMY_MODE) throw fault('NaturalNeedsEconomy');
  if (natural && prepareScale !== undefined) throw fault('NaturalHasNoPreparation');
  // (the page-signed economy commands are asked for in exactly one word; anything else is refused, never ignored)
  if (out.economy !== undefined && out.economy !== ECONOMY_MODE) throw fault('InvalidEconomy');
  // (the test-only march trial: exactly its one word, and only on a natural world)
  if (out['march-trial'] !== undefined && out['march-trial'] !== MARCH_TRIAL_MODE) throw fault('InvalidMarchTrial');
  if (out['march-trial'] !== undefined && !natural) throw fault('MarchTrialNeedsNatural');
  // (the test-only capture demo: both words or neither; exactly its mode; a natural world with the march trial)
  if ((out['capture-demo'] === undefined) !== (out['demo-scale'] === undefined)) throw fault('InvalidCaptureDemo');
  if (out['capture-demo'] !== undefined && (out['capture-demo'] !== CAPTURE_DEMO_MODE || parseDemoScale(out['demo-scale']) === null)) throw fault('InvalidCaptureDemo');
  if (out['capture-demo'] !== undefined && (!natural || out['march-trial'] === undefined)) throw fault('CaptureDemoNeedsNaturalTrial');
  if (out['contest-pair'] !== undefined && (out['contest-pair'] !== CONTEST_PAIR_MODE || out['capture-demo'] === undefined)) throw fault('InvalidContestPair');
  // (a world's life: the default two hours, or the operator's whole minutes; refused, never rounded, when malformed)
  const worldTtlMs = parseWorldTtl(out['world-ttl-minutes']);
  const c = { ...out, port, worldPort, worldTtlMs, artifactSha: out['artifact-sha'], ...(prepareScale !== undefined ? { prepareScale } : {}), ...(worldPreset !== undefined ? { worldPreset } : {}), ...(out['natural-runner'] !== undefined ? { naturalRunner: out['natural-runner'] } : {}), ...(out['march-trial'] !== undefined ? { marchTrial: true } : {}), ...(out['capture-demo'] !== undefined ? { captureDemo: { scale: parseDemoScale(out['demo-scale']) } } : {}), ...(out['contest-pair'] !== undefined ? { contestPair: true } : {}), web: await fs.realpath(path.join(out.root, 'permutation-server/web')) };
  for (const file of [c.runner, c.herald, c.depart, c.preview, c.resident, c.artifact, ...(c.conquest ? [c.conquest] : []), ...(c.naturalRunner ? [c.naturalRunner] : []), path.join(c.root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs')]) if (!(await fs.stat(file).catch(() => null))?.isFile()) throw fault('MissingFile');
  await fs.mkdir(c.data, { recursive: true }); return c;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config;
  try { config = await parseConfig(process.argv.slice(2)); } catch (e) { console.error(`local-play launcher: ${e?.code ?? e?.message ?? 'cannot start'}\n${USAGE}`); process.exit(2); }
  const { server, manager } = createLauncherServer(config);
  server.once('error', e => { console.error(`local-play launcher: ${e?.code === 'EADDRINUSE' ? `port ${config.port} is in use` : 'cannot listen'}`); process.exit(2); });
  server.listen(config.port, '127.0.0.1', () => console.log(JSON.stringify({ origin: `http://localhost:${config.port}`, open: `http://localhost:${config.port}/`, mode: 'new-world-per-wallet', worlds: WORLD_LIMIT, ttl_seconds: (config.worldTtlMs ?? WORLD_TTL_MS) / 1000, ttl_source: config['world-ttl-minutes'] === undefined ? 'default' : '--world-ttl-minutes',
    prepare: config.prepareScale ? { clock_scale: config.prepareScale, chain_seconds_max: PREPARE_CHAIN_MAX, then: '1x, read back, before the world is handed over' } : 'natural 1x',
    world_preset: config.worldPreset ?? null, conquest_cli: config.conquest ? 'configured (reaches a relay only with that start\'s capability)' : null,
    ports: { launcher: config.port, worlds: Array.from({ length: WORLD_LIMIT }, (_, slot) => worldPorts(config.worldPort, slot)) } })));
  // Ctrl-C (or a closed terminal): every world of this launcher is ended first, then the launcher.
  let ending = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => { if (ending) return; ending = true; server.close(); server.closeAllConnections(); await manager.close(); process.exit(0); });
}
