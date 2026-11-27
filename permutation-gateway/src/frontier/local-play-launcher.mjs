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
//   POST /local-play/stop   {wallet, owner} → {stopped: true}   ends that one world, on its owner's explicit press;
//                           `owner` is this launcher's owner proof (`launcherOwnerProof`), never an address
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
import { randomUUID, randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { decode, encode } from '../../../permutation-server/web/sdk/base58.mjs';
import { onLocalLane, selectLocalLane, localLane, COEXIST_LANE, COEXIST_MODE, COEXIST_LANE_WORD } from '../../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { COOP_BOARD_MODE, openWorldBoard, answerWorldBoard, coopRouteOf, coopTarget } from './local-play-coop-board.mjs';
import { WORLD_GOALS_MODE, WORLD_GOALS_MODES, openWorldGoals, answerWorldGoals, goalsRouteOf, goalRulesOf, goalsMount } from './local-play-world-goals.mjs';
import { OPERATOR_RESIDENTS_MODE, OPERATOR_RESIDENTS_SCHEMA, OPERATOR_RESIDENTS_MAX, OPERATOR_NATIONS_MAX, OPERATOR_FACTIONS, OPERATOR_NEAR_MODE, parseOperatorResidents, parseOperatorNations, operatorRelayPorts, operatorSlotPorts, homesOf } from './local-play-operator-policy.mjs';
import { OPERATOR_WAR_MODE, OPERATOR_WAR_MAX } from './local-play-operator-war.mjs';
import { EXTERNAL_RESIDENTS_MODE, EXTERNAL_RESIDENTS_SCHEMA, EXTERNAL_RESIDENTS_MAX, parseExternalResidents, externalPorts, externalSpan } from './local-play-external-residents.mjs';
const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
let RULESET = 'e9059c9307189f337b00a4b2166b72a46e1cbbf888068ed1057067546d89de70';
// (TEST-ONLY `--coexist`: the coexist lane's RULESET_HASH_V4, once this launcher selected it; plain: unchanged)
onLocalLane(l => { RULESET = l.rulesetHash; });
/** Worlds at once; a world's life (the default; `--world-ttl-minutes` may choose another); its output; the disk's floor (bytes). */
export const WORLD_LIMIT = 2, WORLD_TTL_MS = 7200000, WORLD_OUTPUT_MAX = 128 * 1024 ** 2, DISK_FLOOR = 5.25 * 1024 ** 3;
/** (TEST-ONLY) The output guard of a `--wide-land` world (above). */
export const WIDE_OUTPUT_MAX = 512 * 1024 ** 2;
/** The guard (startWorld): how often a world's output is measured (a walk of all its files), and when a measurement still under way is given up. */
export const OUTPUT_EVERY_MS = 15000, GUARD_STALL_MS = 120000;
/** How often the launcher says on stderr that it is alive (its worlds, memory, event-loop lag). */
export const LAUNCHER_HEARTBEAT_MS = 600000;
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
/**
 * The launcher's owner proof (D-verify-pr57-1). A world's address is public — `/local-play/worlds` lists it, and an
 * admitted external resident lives in that world — so naming it proves nothing. Ending a world takes this launcher's
 * own secret instead: 32 random bytes (base64url, 43 characters) made once per launcher process and given out only on
 * its own standard output, in the `open` URL's fragment (`/#owner=<proof>`), the way a Jupyter or VS Code server
 * hands its token to the browser it opens. A fragment is never sent in a request or a Referer; the page reads it and
 * names it in the stop body only (`flocalplay.mjs` `launcherOwnerProof`), so the launcher requests stay credential-free.
 * Whoever opened the launcher's printed address may end any of its worlds (the WorldLimit list ends worlds of earlier
 * pages, whose keys are gone); a program that only knows the launcher's origin may not.
 */
export const OWNER_PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
export const makeOwnerProof = () => randomBytes(32).toString('base64url');
/** `/local-play/stop`'s body → `{wallet, owner}`; an address without a proof is well-formed but refused (403 NotWorldOwner). */
export function parseStop(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validWallet(value.wallet)) throw fault('InvalidWallet');
  const keys = Object.keys(value).sort().join();
  if (keys === 'wallet') throw fault('NotWorldOwner', 403);
  if (keys !== 'owner,wallet') throw fault('InvalidWallet');
  if (typeof value.owner !== 'string' || !OWNER_PROOF_RE.test(value.owner)) throw fault('NotWorldOwner', 403);
  return { wallet: value.wallet, owner: value.owner };
}
/** Whether `given` is exactly this launcher's proof (compared in constant time). */
export function ownerProofOk(given, proof) {
  if (typeof given !== 'string' || typeof proof !== 'string' || !OWNER_PROOF_RE.test(proof)) return false;
  const a = Buffer.from(given), b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
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
const DEMO_LINE = 'frontier-localnet-capture-demo-v1', PAIR_LINE = 'frontier-localnet-contest-pair-v1';
/**
 * TEST-ONLY contest pair: what the two players need to know to meet, from the runner's public lines, given only on a
 * player's own press: the fort the demo chose (another nation's, which the first player can reach) and the nation that
 * holds it, which the SECOND player may choose to defend it, with the home the page will place for that nation. Numbers
 * only, every field checked; anything else is `{state: 'invalid'}` (fail closed). `state`: 'pending' before the demo's
 * ready line; 'predicted' after it (the home is the page's standard candidate, not yet placed); 'ready' once the
 * runner re-checked both routes on the chain's bytes — then the fort and the home are the CHECKED ones (the second
 * player's real home, which may differ from the prediction), and the check must name the same fort and nation;
 * 'not_ready' when that re-check failed. The nation is a suggestion the page shows: the second player's choice stays free.
 */
export function pairTargetSummary(lines) {
  const all = Array.isArray(lines) ? lines.filter(v => v && typeof v === 'object' && v.test_only === true) : [];
  const ready = all.filter(v => v.schema === DEMO_LINE && v.demo_step === 'ready').at(-1);
  if (!ready) return { state: 'pending' };
  const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
  const pq = v => int(v, -1000, 1000);
  const pair = ready.pair, fort = Array.isArray(ready.new_ring_reachable) && ready.new_ring_reachable.length === 1 ? ready.new_ring_reachable[0] : null;
  const home = pair?.second_player_home;
  const ok = pair && typeof pair === 'object' && fort && typeof fort === 'object' && home && typeof home === 'object'
    && int(pair.second_player_nation, 0, 5) && int(ready.player_nation, 0, 5) && ready.player_nation !== pair.second_player_nation
    && pq(home.p) && pq(home.q) && int(home.site, 0, 255) && int(home.tile, 0, 60)
    && pq(fort.p) && pq(fort.q) && int(fort.keep_tile, 0, 60) && fort.keep_holder === pair.second_player_nation
    && int(pair.second_player_route_steps, 1, 32);
  if (!ok) return { state: 'invalid' };
  const check = all.filter(v => v.schema === PAIR_LINE && (v.pair_step === 'pair_ready' || v.pair_step === 'pair_not_ready')).at(-1);
  const base = { nation: pair.second_player_nation, opponentNation: ready.player_nation, fort: { p: fort.p, q: fort.q, tile: fort.keep_tile } };
  if (!check) return { state: 'predicted', ...base, home: { p: home.p, q: home.q, site: home.site, tile: home.tile } };
  if (check.pair_step === 'pair_not_ready') return { state: 'not_ready', ...base, home: { p: home.p, q: home.q, site: home.site, tile: home.tile } };
  // (ready: the runner's own re-check, every field, and it must be about the same fort and nation)
  const t = check.target, h = check.second_home;
  const checked = t && typeof t === 'object' && h && typeof h === 'object' && t.p === fort.p && t.q === fort.q && t.keep_tile === fort.keep_tile && t.holder === pair.second_player_nation
    && pq(h.p) && pq(h.q) && int(h.site, 0, 255) && int(h.tile, 0, 60) && int(check.second_steps, 1, 32) && int(check.first_steps, 1, 32) && typeof check.as_predicted === 'boolean';
  if (!checked) return { state: 'invalid' };
  return { state: 'ready', ...base, home: { p: h.p, q: h.q, site: h.site, tile: h.tile } };
}
/** One call of this world's own runner's JSON-RPC (loopback, the port this launcher gave it): its result. */
// (fix-loop7, D-verify-pr136-2: a world's runner guards its time control — frontier_pause / resume / setScale / hold /
//  release — with a per-world token that only this launcher holds: given to the runner process alone, in its environment
//  (`RUNNER_CONTROL_ENV`, never on argv), and sent back here in `RUNNER_CONTROL_HEADER`. Another loopback program that
//  knows the port can still read the chain and send transactions, as the page does, but can no longer freeze the clock)
export const RUNNER_CONTROL_ENV = 'FRONTIER_CONTROL_TOKEN';
export const RUNNER_CONTROL_HEADER = 'x-frontier-control';
export const makeRunnerControl = () => randomBytes(32).toString('base64url');
export async function runnerRpc(port, method, params = [], control = null) {
  const headers = { 'content-type': 'application/json', ...(typeof control === 'string' && control ? { [RUNNER_CONTROL_HEADER]: control } : {}) };
  const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
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
 * The runner's latest public line of each schema in `schemas`, read incrementally (local-perf, 2026-11-21): each call
 * reads only the bytes the runner appended since the previous one, in 64 KiB steps, and parses only the lines that name
 * one of the schemas. `runnerLines` reads and parses the whole file: a wide world's runner writes ~5 MB an hour (a
 * 30-hour world's was 165 MB), and the keeper question re-read all of it on the event loop each time it was asked.
 * One read at a time (a call while one runs shares it); a file that became shorter is read again from its start.
 * → `() => Promise<Map(schema → line)>`.
 */
export function runnerFollower(dir, schemas, io = fs) {
  let at = 0, rest = '', last = new Map(), decoder = new StringDecoder('utf8'), busy = null;
  const wanted = schemas.map(x => [x, `"${x}"`]);
  const take = line => { for (const [x, quoted] of wanted) if (line.includes(quoted)) { try { const v = JSON.parse(line); if (v && typeof v === 'object' && v.schema === x) last.set(x, v); } catch { /* not a whole line */ } } };
  const step = async () => {
    const fh = await io.open(path.join(dir, 'runner.out'), 'r');
    try {
      const { size } = await fh.stat();
      if (size < at) { at = 0; rest = ''; last = new Map(); decoder = new StringDecoder('utf8'); }
      const buf = Buffer.alloc(64 * 1024);
      while (at < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
        if (!bytesRead) break;
        at += bytesRead;
        const parts = (rest + decoder.write(buf.subarray(0, bytesRead))).split('\n');
        rest = parts.pop();
        for (const line of parts) take(line);
      }
    } finally { await fh.close(); }
    return new Map(last);
  };
  return () => (busy ??= step().finally(() => { busy = null; }));
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
export async function prepareWorld({ scale, dir, rpc, herald, meta, stopping, limit = {}, control = null }) {
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
      asked = true; fast = await runnerRpc(rpc, 'frontier_setScale', [scale], control);
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
      try { if (i % 8 === 0) await runnerRpc(rpc, 'frontier_setScale', [1], control); after = await runnerRpc(rpc, 'frontier_status'); restored = at1x(after); } catch { /* asked again */ }
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
 * `--world-option land-preview-v1` (TEST-ONLY, optional; only with the capture demo): the natural runner also runs the
 * land preview's crank (itest `land_lane`: the program's own FoldLand / ClaimLandYield on its provisional tags), so
 * land a nation holds grows where its hosts stand and is taken where a hostile host stands ("Standing Ground" in
 * reduced form). Needs a program, runner and herald built with the land preview. The start answer says
 * `landPreview: true`. Without the option nothing of it runs.
 */
export const LAND_PREVIEW_OPTION = 'land-preview-v1';
/** The runner's first line and this start agree on the land preview: its statement with the option, none without. */
export function runnerLandAgrees(meta, land) {
  const d = meta?.land_preview;
  if (!land) return d === undefined;
  return d !== null && typeof d === 'object' && d.mode === LAND_PREVIEW_OPTION && d.test_only === true && d.stand_bells === 6 && d.seize_bells === 72 && d.fray_bells === 36;
}
/**
 * `--contest-pair contest-pair-v1` (TEST-ONLY; only with the capture demo): ONE memory-only world for TWO players, each
 * with their own page and memory-only key. The first wallet to press start waits (`pairWaiting`); the second distinct
 * wallet's press starts one runner with both (`--second-wallet`); the second player's page reaches its OWN relay (pinned to
 * its wallet) through its own proxy (`/gw` → that relay, everything else → the shared herald), on the second slot's ports.
 * Either page asking again gets the same world; a second world is never started for either; one stop or the TTL ends it
 * for both. Both sides are people: there is no automatic opponent.
 */
export const CONTEST_PAIR_MODE = 'contest-pair-v1';
/**
 * B16 (loop-play3): a KEPT world (`--persist`) for two people. Its second player is recorded once, at the world's first
 * start, in `<data>/persist/<first wallet>/pair.json` (0600; public addresses only, never a key). With the pair option a
 * later press of EITHER of the two resumes that world for both at once (no waiting); a recorded pair is never changed.
 */
export const PAIR_FILE = 'pair.json', PAIR_FILE_SCHEMA = 'frontier-local-play-kept-pair-v1';
/** A kept world's recorded second player: its address, null when there is no record, false when the record is not one. */
export async function readPersistedPair(home, io = fs) {
  let raw;
  try { raw = await io.readFile(path.join(home, PAIR_FILE), 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? null : false; }
  if (!(await privateMode(path.join(home, PAIR_FILE), false, io)).ok) return false;
  let d; try { d = JSON.parse(raw); } catch { return false; }
  const ok = d !== null && typeof d === 'object' && Object.keys(d).sort().join() === 'first,mode,schema,second,test_only' && d.schema === PAIR_FILE_SCHEMA
    && d.mode === CONTEST_PAIR_MODE && d.test_only === true && validWallet(d.first) && validWallet(d.second) && d.first !== d.second && d.first === path.basename(home);
  return ok ? d.second : false;
}
/** Every kept pair under `<data>/persist/`: Map first → second (an unreadable or invalid record is left out). */
export async function persistedPairs(data, io = fs) {
  const out = new Map();
  let names = [];
  try { names = await io.readdir(path.join(data, 'persist')); } catch { return out; }
  for (const n of names) {
    if (!validWallet(n)) continue;
    const second = await readPersistedPair(path.join(data, 'persist', n), io);
    if (typeof second === 'string') out.set(n, second);
  }
  return out;
}
/**
 * `--continuous local-continuous-v1` (TEST-ONLY, optional; off unless given in exactly these words; natural preset only,
 * never with the capture demo): the natural runner makes its Season with the program's continuous preset
 * (`S1_LOCAL_CONTINUOUS`: no end bell, joins always open, EndSeason refused by the program), so the world does not end
 * by the rules. The launcher's own guards (its TTL, output and disk limits) still stop the world's PROCESSES; with
 * `--persist` such a stop is resumable. The start answer says `continuous: true`.
 */
export const CONTINUOUS_MODE = 'local-continuous-v1';
/**
 * `--persist local-persist-v1` (TEST-ONLY, "not for production"; optional, off unless given in exactly these words;
 * natural preset only, never with the capture demo): each wallet's world lives in a stable private directory
 * `<data>/persist/<wallet>/` (0700): the runner's run dir `run/` (its chain's ledger and snapshots, and the world's two
 * operator keys, 0600 files in 0700 directories; itest `natural_persist`), the herald's `herald/` (checkpoint and
 * archive) and one `starts/<n>/` of logs per start. A stop (the player's, the TTL's, Ctrl-C) ends the processes and keeps
 * the directory; the next start for the same wallet RESUMES that world (the runner re-opens its chain from its ledger
 * and refuses another wallet, artefact or continuous word, a missing ledger, or a looser mode). The player's key is
 * never here: the page keeps it in its browser (a non-extractable WebCrypto key). The start answer says
 * `persisted: {resumed}`; the page is addressed with `persist=local`. Nothing is ever deleted by the launcher.
 */
export const PERSIST_MODE = 'local-persist-v1';
/** The page's word for a persisted launcher (`persist=local`). */
export const PERSIST_PAGE_WORD = 'local';
/** Whether a path is private to this user: not a link, the expected kind, and no group or other bits. */
export async function privateMode(p, dir, io = fs) {
  let st; try { st = await io.lstat(p); } catch { return { ok: false, why: 'missing' }; }
  if (st.isSymbolicLink()) return { ok: false, why: 'link' };
  if (dir ? !st.isDirectory() : !st.isFile()) return { ok: false, why: 'kind' };
  const mode = st.mode & 0o777;
  return mode & 0o077 ? { ok: false, why: 'mode', mode } : { ok: true, mode };
}
/** Creates `p` 0700 when missing (its parent must exist), then refuses it unless private (`PersistNotPrivate`). */
export async function ensurePrivateDir(p, io = fs) {
  try { await io.mkdir(p, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') throw fault('PersistDirUnavailable', 503); }
  const m = await privateMode(p, true, io);
  if (!m.ok) throw Object.assign(fault('PersistNotPrivate', 503), { detail: m });
}
/** The runner's first line and this start agree on the continuous preset and the persistence (fail closed). */
export function runnerPersistAgrees(meta, { continuous = false, persist = false } = {}) {
  if (meta?.continuous !== undefined && typeof meta.continuous !== 'boolean') return false;
  if ((meta?.continuous === true) !== continuous) return false;
  if (continuous && meta.continuous_mode !== CONTINUOUS_MODE) return false;
  const d = meta?.persist;
  if (!persist) return d === undefined && meta?.memory_only !== false;
  return d !== null && typeof d === 'object' && Object.keys(d).sort().join() === 'mode,not_for_production,resumed,test_only'
    && d.mode === PERSIST_MODE && d.test_only === true && d.not_for_production === true && typeof d.resumed === 'boolean' && meta.memory_only === false;
}
/**
 * `--fresh-map local-fresh-map-v1` (TEST-ONLY, optional; off unless given in exactly these words; natural preset only):
 * each NEW world gets its own map. Without it every natural world has the SAME map: the runner's chain starts at one
 * fixed clock origin, so every Season fixes the same genesis round (30943232) and the program derives the same genesis
 * seed — the same terrain, sites, Free City and dispersed home offsets. With it the launcher picks, per new world, a
 * clock origin in the 365 days before the fixed one (`freshMapOrigin`) and hands it to the runner (`--map-origin`): the
 * Season then fixes another real quicknet round, and the program derives another genesis seed from that round's
 * verified signature BY ITS UNCHANGED RULES (no game rule, account layout or program byte changes; only the local TEST
 * chain's clock starts elsewhere). The runner's first line must state that origin (`fresh_map`), or the world is not
 * started with; this start's `fresh-map.json` records it. A resumed kept world keeps the map it was made with.
 */
export const FRESH_MAP_MODE = 'local-fresh-map-v1';
/**
 * TEST-ONLY `--coexist local-coexist-v1` (2026-11-20, rights-play): this launcher's worlds run the ②+⑨+⑩ COEXIST lane
 * (`--artifact` the coexist .so of scripts/build-frontier-localnet-coexist-sbf.sh; the runners, herald and tools built
 * with their `coexist-lane` feature): program version 0x7805 and RULESET_HASH_V4 instead of 0x4804 / V3. The launcher
 * selects the lane at its start (flocalplay-lane.mjs), its relays get `--coexist`, its pages `lane=coexist`, its start
 * answers `lane: 'coexist'`. Natural worlds only (kept, or the capture demo's TEST clock), never the wide land. Off by default.
 */
export { COEXIST_MODE };
/**
 * `--wide-land local-wide-land-v1` (TEST-ONLY, optional; off unless given in exactly these words; natural preset only,
 * never with the capture demo, the contest pair, the land preview, `--continuous` or `--persist`): the owner's wide
 * version, locally. The runner (itest `wide_land`) creates the world's Season from the devnet playable preset
 * `S1_DEVNET_WIDE_7D` (#70) and, still on its synthetic setup clock, grows the map by the program's own instructions
 * one ring per bell to the rim (ring 128), then opens wide rings 129+ (WideRequestRingSeed / WideConsumeRingSeed with
 * verified public rounds, WideSetRules, WideOpenProvince), with one test participant per nation for the occupancy
 * rule. From `ready-for-join` on the clock is the natural world's. The runner's first line must state `wide_land`, or
 * the world is not started with; a memory-only world (a stop ends it). The herald must be built with
 * `wide-world-experimental` to serve the page's recorded-world view.
 */
export const WIDE_LAND_MODE = 'local-wide-land-v1';
/**
 * `--pacing fast-v1` (TEST-ONLY, world4-pacing-impl, only with `--wide-land`): the wide world's Season takes the NEXT
 * world's pacing bytes (frontier-abi `pacing_fast`: first village at once on the settled rim, arrival 1 turn after the
 * departure, reveal window 300 s, keep hold 36, Depart stamina 74, starter host 500), runner `--pacing fast-v1`; its
 * first line names them (`local_rules.pacing`).
 */
export const PACING_MODE = 'fast-v1';
/** The runner's first line and this start agree on the wide land: its statement with the option, none without (and its TEST clock scale, `--wide-scale`, exactly as asked). */
export function runnerWideAgrees(meta, wide, scale = null) {
  const d = meta?.wide_land;
  if (!wide) return d === undefined;
  return d !== null && typeof d === 'object' && d.mode === WIDE_LAND_MODE && d.test_only === true && d.preset === 'S1_DEVNET_WIDE_7D'
    && Number.isSafeInteger(d.summary?.legacy_rings_opened) && d.summary.legacy_rings_opened === 129 && Array.isArray(d.summary?.wide_rings) && d.summary.wide_rings.length > 0
    && (scale === null ? d.scale === undefined : d.scale === scale);
}
/**
 * `--wide-scale <1-60>` (TEST-ONLY, only with `--wide-land`): the wide world's chain clock from `ready-for-join` on runs
 * at this many game seconds per second (runner `--wide-scale`), so a rim village's stores reach a wide claim's settler
 * cost within a play session (~30 game hours at a Hamlet's base production). → the number, or null when not plain 1-60.
 */
export function parseWideScale(raw) {
  return typeof raw === 'string' && /^([1-9]|[1-5][0-9]|60)$/.test(raw) ? Number(raw) : null;
}
/** The opened wide provinces stated on the runner's first line (`wide_land.summary.wide_rings[].provinces`): `[{p, q}]` decimal strings, or []. */
export function wideTargetsOf(meta) {
  const rings = meta?.wide_land?.summary?.wide_rings;
  if (!Array.isArray(rings)) return [];
  return rings.flatMap(r => (Array.isArray(r?.provinces) ? r.provinces : [])).filter(x => /^-?[0-9]{1,19}$/.test(String(x?.p)) && /^-?[0-9]{1,19}$/.test(String(x?.q))).map(x => ({ p: String(x.p), q: String(x.q) }));
}
/** The local chain's fixed clock origin (2026-08-01T00:00:00Z) and how far before it a fresh map's origin may be. */
export const MAP_ORIGIN_DEFAULT = 1_785_542_400, MAP_ORIGIN_SPAN_SECS = 365 * 86_400;
/** Whether `g0` is an origin the runner's `--map-origin` accepts: a whole second in the 365 days before the fixed origin. */
export const mapOriginOk = g0 => Number.isSafeInteger(g0) && g0 >= MAP_ORIGIN_DEFAULT - MAP_ORIGIN_SPAN_SECS && g0 < MAP_ORIGIN_DEFAULT;
/** A new world's clock origin: uniform over the 31,536,000 whole seconds before the fixed origin (`pick(lo, hi)`: lo ≤ n < hi). */
export function freshMapOrigin(pick = randomInt) { return MAP_ORIGIN_DEFAULT - pick(1, MAP_ORIGIN_SPAN_SECS + 1); }
/** The runner's first line's `fresh_map`, when it is exactly `{mode, origin, genesis_round, test_only}` of a valid origin; else null. */
export function runnerFreshMap(meta) {
  const d = meta?.fresh_map;
  return d !== null && typeof d === 'object' && Object.keys(d).sort().join() === 'genesis_round,mode,origin,test_only' && d.mode === FRESH_MAP_MODE && d.test_only === true
    && mapOriginOk(d.origin) && Number.isSafeInteger(d.genesis_round) && d.genesis_round > 0 ? { origin: d.origin, genesis_round: d.genesis_round } : null;
}
/**
 * The runner's first line and this start agree on the map (fail closed). `origin`: the one this start asked for, or
 * null. A NEW world states exactly the origin asked for, and none when none was asked for. A RESUMED kept world
 * (`persist.resumed`) keeps the map it was made with, whatever this start asked for: it states its own valid origin, or
 * none (a world of the fixed map).
 */
export function runnerMapAgrees(meta, origin = null) {
  const stated = meta?.fresh_map === undefined ? undefined : runnerFreshMap(meta);
  if (stated === null) return false;
  if (meta?.persist?.resumed === true) return true;
  return origin === null ? stated === undefined : stated !== undefined && stated.origin === origin;
}
/**
 * `--herald-output compact-v1` (TEST-ONLY, optional; only with the capture demo): each NEW world's herald keeps only the
 * deterministic `.gz` of each output file (herald `--output compact-v1`) to reduce its output; whether a long world stays
 * under the unchanged 128 MiB output guard is not promised and must be measured. Every file of every turn is kept and
 * served as before. Each world has its own new data directory, so the herald's
 * own rule (compact only in a new directory; a compact world never reopened without it) always holds. The world is handed
 * over only once its herald has recorded the mode (`herald/output-mode`): a herald that ignored the option is never used.
 * Without this option every world's output is as before, byte for byte.
 * `--herald-output compact-v2` (round 14, TEST-ONLY, the same conditions): compact-v1 AND the herald's findex store
 * (its archive and index) gzip-compressed, every record kept (herald `--output compact-v2`); recorded as `compact-v2`.
 */
export const HERALD_OUTPUT_MODE = 'compact-v1';
/** Every output word the launcher may hand a new world's herald. */
export const HERALD_OUTPUT_MODES = Object.freeze(['compact-v1', 'compact-v2']);
/** The herald's record of its output mode (`<data>/output-mode`), exactly as a compact herald writes it for `mode`. */
export function heraldOutputRecorded(text, mode = HERALD_OUTPUT_MODE) { return HERALD_OUTPUT_MODES.includes(mode) && text === `${mode}\n`; }
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
/** frontier-abi `FreeCityRule::DeployedLe32V1` (⑧ (d): the deployed formula; 1 is NoFreeCity, 2 the older wide formula a placement-2 Season refuses): the rule byte the runner's "opened" line shows for a world with a Free City. */
const FREE_CITY_CANONICAL = 3;
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
  constructor(config, launch = startWorld) { this.config = config; this.launch = launch; this.worlds = new Map(); this.closed = false; this.pairWaiting = null; this.pairOf = new Map(); this.externalOf = new Map(); }
  /** The worlds this launcher runs, by their public addresses: what a refused start shows the player. */
  list() { return [...this.worlds].map(([wallet, w]) => ({ wallet, herald: w.herald, startedAt: w.startedAt, state: w.stopping ? 'stopping' : w.herald ? 'running' : 'starting', ...(w.expiry ? { expiry: w.expiry } : {}) })); }
  start(wallet) {
    if (!validWallet(wallet)) return Promise.reject(fault('InvalidWallet'));
    if (this.closed) return Promise.reject(fault('LauncherClosed', 503));
    if (this.config.contestPair) return this.#pairStart(wallet);
    if (this.config.externalResidents?.includes(wallet)) return this.#externalStart(wallet);
    return this.#start(wallet, this.config.externalResidents ? { external: this.config.externalResidents.filter(a => !this.externalOf.has(a)) } : {});
  }
  /**
   * TEST-ONLY external residents (⑤ option B): an admitted address's press (the page's own `/local-play/start`) is
   * looked up, never started as a world of its own: the world it was admitted to (the next one started after it was
   * free), answered with ITS proxy as the herald, once that world is ready; `{residentWaiting: true}` while no world
   * has it. It owns nothing of that world: stop, keeper and pair stay the owner's.
   * (external-wide: in a `--wide-land` world it is told so as the person's page is — `wideLand: {scale, targets}`, the
   * same public facts the owner's start answer carries — so its first village may take the rim route the page takes)
   */
  #externalStart(wallet) {
    const owner = this.externalOf.get(wallet);
    const record = owner === undefined ? null : this.worlds.get(owner);
    if (!record) { this.externalOf.delete(wallet); return Promise.resolve({ residentWaiting: true, external: { mode: EXTERNAL_RESIDENTS_MODE } }); }
    if (record.stopping) return Promise.reject(fault('WorldStopping', 409));
    return record.promise.then(view => {
      const herald = record.externalHerald?.get(wallet);
      if (typeof herald !== 'string') throw fault('WorldNotFound', 404);
      return { herald, ...(view.natural ? { natural: true } : {}), ...(view.marchTrial ? { marchTrial: true } : {}), ...(view.captureDemo ? { captureDemo: view.captureDemo } : {}), ...(view.wideLand ? { wideLand: view.wideLand } : {}), ...(view.expiry ? { expiry: view.expiry } : {}), external: { role: 'resident', mode: EXTERNAL_RESIDENTS_MODE } };
    });
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
    // (B16: a kept pair's either player resumes its world for both, at once)
    if (this.config.persist) return this.#keptPair(wallet).then(r => r ?? this.#pairWait(wallet));
    return this.#pairWait(wallet);
  }
  /** A kept pair (`persistedPairs`) that has `wallet`: its world started for both (or the one running), then answered as for any pair press; null when `wallet` is in no kept pair. */
  async #keptPair(wallet) {
    const pairs = await (this.config.guard?.persistedPairs ?? persistedPairs)(this.config.data);
    let a = null, b = null;
    if (pairs.has(wallet)) { a = wallet; b = pairs.get(wallet); } else for (const [f, s] of pairs) if (s === wallet) { a = f; b = s; }
    if (a === null) return null;
    if (this.closed) throw fault('LauncherClosed', 503);
    if (this.pairWaiting === a || this.pairWaiting === b) this.pairWaiting = null;
    if (!this.worlds.has(a)) {
      if (this.worlds.size > 0) throw Object.assign(fault('WorldLimit', 409), { worlds: this.list() });
      this.pairOf.set(b, a);
      await this.#start(a, { second: b }).catch(e => { this.pairOf.delete(b); throw e; });
    } else if (this.worlds.get(a) && !this.pairOf.has(b)) this.pairOf.set(b, a);
    return this.#pairStart(wallet);
  }
  #pairWait(wallet) {
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
    const forget = () => { if (this.worlds.get(wallet) === record) this.worlds.delete(wallet); for (const [b, a] of this.pairOf) if (a === wallet) this.pairOf.delete(b); for (const [b, a] of this.externalOf) if (a === wallet) this.externalOf.delete(b); };
    // (TEST-ONLY external residents: the admitted addresses no other world has are this world's from now on)
    for (const a of opts.external ?? []) this.externalOf.set(a, wallet);
    record.promise = Promise.resolve().then(() => this.launch(this.config, wallet, slot, forget, record.abort.signal, opts)).then(async world => {
      record.stop = world.stop;
      if (this.closed || record.abort.signal.aborted) { await world.stop(); throw fault(this.closed ? 'LauncherClosed' : 'WorldStopped', 503); }
      record.herald = world.herald;
      // (the world's automatic end, fixed once by the world at its own TTL origin: kept as it came, never recomputed,
      //  so a second start of the same address, a list or a reconnect answers the same and nothing extends it)
      record.expiry = world.expiry ?? null;
      record.keeper = typeof world.keeper === 'function' ? world.keeper : null;
      record.coop = world.coop ?? null;
      record.goals = world.goals ?? null;
      record.pairHerald = opts.second ? (world.pair?.second === opts.second && typeof world.pair.herald === 'string' ? world.pair.herald : null) : null;
      record.pairView = opts.second && typeof world.pairView === 'function' ? world.pairView : null;
      if (opts.second && record.pairHerald === null) { await world.stop(); throw fault('PairNotReady', 503); }
      record.externalHerald = new Map(Object.entries(world.external ?? {}));
      if ((opts.external ?? []).some(a => typeof record.externalHerald.get(a) !== 'string')) { await world.stop(); throw fault('ExternalResidentsNotReady', 503); }
      return { herald: world.herald, ...(opts.second ? { pair: { role: 'first', mode: CONTEST_PAIR_MODE } } : {}), ...(world.natural === true ? { natural: true } : {}), ...(world.marchTrial === true ? { marchTrial: true } : {}), ...(world.captureDemo ? { captureDemo: world.captureDemo } : {}), ...(world.landPreview === true ? { landPreview: true } : {}), ...(world.continuous === true ? { continuous: true } : {}), ...(world.persisted && typeof world.persisted.resumed === 'boolean' ? { persisted: { resumed: world.persisted.resumed } } : {}), ...(world.prepared ? { prepared: world.prepared } : {}), ...(world.conquestWorld ? { conquestWorld: world.conquestWorld } : {}), ...(world.wideLand ? { wideLand: world.wideLand } : {}), ...(Array.isArray(world.aiNations) ? { aiNations: world.aiNations, ...(world.aiNear === true ? { aiNear: true } : {}) } : {}), ...(world.lane ? { lane: world.lane } : {}), ...(record.expiry ? { expiry: record.expiry } : {}) };
    }).catch(e => { forget(); throw e; });
    return record.promise;
  }
  /**
   * (B13, TEST-ONLY `--coop-board`) The co-op board of the live world one of whose proxies listens on `port`, or null
   * (no such world, one still starting or ending, or a launcher without the board).
   */
  coopFor(port) {
    for (const w of this.worlds.values()) if (!w.stopping && w.herald && w.coop?.ports.includes(port)) return w.coop;
    return null;
  }
  /** (TEST-ONLY `--world-goals`) The goals judge of the live world one of whose proxies listens on `port`, or null. */
  goalsFor(port) {
    for (const w of this.worlds.values()) if (!w.stopping && w.herald && w.goals?.ports.includes(port)) return w.goals;
    return null;
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
   * TEST-ONLY contest pair: the fort and the nations the two players meet over (`pairTargetSummary`), for either of the
   * pair's own two addresses only, while its world runs; `{pair: {mode, role, target}}`. Any other address, a world
   * that is not a pair, one still starting or ending: refused. Nothing is changed by asking.
   */
  async pair(wallet) {
    if (!validWallet(wallet)) throw fault('InvalidWallet');
    if (!this.config.contestPair) throw fault('NotAPair', 404);
    const role = this.pairOf.has(wallet) ? 'second' : this.worlds.get(wallet)?.pairView ? 'first' : null;
    if (role === null) throw fault('NotAPair', 404);
    const first = role === 'second' ? this.pairOf.get(wallet) : wallet;
    const record = this.worlds.get(first);
    if (!record || record.stopping || !record.pairView || !record.herald) throw fault('WorldNotFound', 404);
    const target = await record.pairView();
    if (this.worlds.get(first) !== record || record.stopping) throw fault('WorldNotFound', 404);
    if (!target || typeof target !== 'object') throw fault('PairTargetUnavailable', 503);
    // (the world it is about: the page accepts the answer only if this is the herald and the end it verified at its start)
    const herald = role === 'second' ? record.pairHerald : record.herald;
    if (typeof herald !== 'string' || !record.expiry) throw fault('WorldNotFound', 404);
    return { pair: { mode: CONTEST_PAIR_MODE, role, target, world: { herald, expiry: record.expiry } } };
  }
  /**
   * End one world, named by its public address. Only a world of this manager, and only this one: the others go on.
   * A world still starting is stopped where it is. Resolves once its processes are gone and its ports are free.
   */
  stop(wallet) {
    if (!validWallet(wallet)) return Promise.reject(fault('InvalidWallet'));
    if (this.pairWaiting === wallet) { this.pairWaiting = null; return Promise.resolve({ stopped: true }); }
    if (this.pairOf.has(wallet)) wallet = this.pairOf.get(wallet);
    // (an admitted external resident owns no world: it cannot end the one it lives in)
    if (this.config.externalResidents?.includes(wallet)) return Promise.reject(fault('NotWorldOwner', 403));
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
/**
 * The herald's nation chat (frontier-node/crates/herald/src/chat.rs; owner Q-PT-11 (a)): the page's three JSON POSTs —
 * every one signed by the player's wallet or carrying a wallet-signed read token, checked by the herald — and its live
 * socket. Its operator paths (`/h/chat/admin/*`) are not here: they are the operator's, on the herald's own loopback port.
 */
export const WORLD_CHAT_POST_ROUTES = Object.freeze(['/h/chat/post', '/h/chat/read', '/h/chat/report']);
export const WORLD_CHAT_WS_ROUTE = '/h/chat/ws';
/** The chat's one public read (whether it is on, the world it signs for, its limits): no message in it. */
export const WORLD_CHAT_INFO_ROUTE = '/h/chat/info';
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
    const write = WORLD_POST_ROUTES.includes(target.path) || WORLD_CHAT_POST_ROUTES.includes(target.path);
    // (a chat POST is a write, never a read: `/h/chat/*` is not passed on as a GET — its socket is the upgrade below)
    const read = !write && (!target.path.startsWith('/h/chat/') || target.path === WORLD_CHAT_INFO_ROUTE) && (target.path.startsWith('/h/') || WORLD_GET_ROUTES.includes(target.path));
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
    // (the herald's diff socket, or its nation chat socket — whose first message must be a wallet-signed read token)
    const route = [WORLD_WS_ROUTE, WORLD_CHAT_WS_ROUTE].find(r => r === req.url);
    if (req.method !== 'GET' || !route || String(req.headers.upgrade).toLowerCase() !== 'websocket') return refuse(404, 'Not Found');
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const keep = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'].filter(k => typeof req.headers[k] === 'string');
      upstream.write(`GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n` + keep.map(k => `${k}: ${req.headers[k]}\r\n`).join('') + '\r\n');
      if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket);
    });
    for (const s of [socket, upstream]) { sockets.add(s); s.on('close', () => sockets.delete(s)); }
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  /** Ends every connection (also the upgraded ones, which the server itself no longer counts) and stops listening. */
  server.closeNow = () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); server.closeAllConnections(); });
  return server;
}
/** (fix-loop16, Q-LP16-4) The nation of each operator resident of a launcher config, by resident index: the named nations (`--operator-nations`), else the fixed OPERATOR_FACTIONS. */
export const operatorNationsOf = c => (c?.operatorNations ? [...c.operatorNations] : OPERATOR_FACTIONS.slice(0, c?.operatorResidents ?? 0));
/** The lamports each operator resident's wallet is given: the runner's own amount for a player (fees and rent only). */
export const OPERATOR_LAMPORTS = 10_000_000_000;
export const OPERATOR_HOMES_MS = 30000, OPERATOR_WALLETS_MS = 10000;
/**
 * TEST-ONLY operator residents (⑤ option A) for one natural world, once its herald answers: the runner's own
 * `ready-for-join` homes are read; the residents' process (local-play-operator-residents.mjs) is started as a SIDE
 * process (its end never ends the world) and states its public wallets — memory-only TEST keys it made itself; this
 * launcher never sees a key; each wallet is funded through the runner's RPC with the player's own amount, the one
 * set-up step the runner does for the player too; then one local-play relay per wallet, with the player's own relay
 * arguments, on the residents' ports. → `{count, wallets, ports}` (also written to `operators.json`: the operator's
 * own roster of who is an AI, kept beside the world, never sent to a page). Any refusal ends the world's start.
 */
export async function startOperatorResidents({ n, nations = null, dir, ports, rpc, herald, players, launch, launchSide, relayArgsFor, root, stopping, limit = {}, pace = {}, war = false, keysDir = null, wideTargets = null, goals = null, near = null }) {
  // (`nations`: the TEST-ONLY `--operator-nations` list, one nation per resident, up to six; otherwise the fixed four)
  if (!Number.isInteger(n) || n < 1 || n > (war ? OPERATOR_WAR_MAX : nations ? OPERATOR_NATIONS_MAX : OPERATOR_RESIDENTS_MAX) || ports.length !== n || (nations && (nations.length !== n || parseOperatorNations(nations.join(',')) === null))) throw fault('InvalidOperatorResidents', 503);
  for (const p of ports) await freePort(p);
  let homes = null;
  for (const until = Date.now() + (limit.operatorHomesMs ?? OPERATOR_HOMES_MS); !homes && Date.now() < until && !stopping();) {
    homes = homesOf(await runnerLines(dir).catch(() => []));
    if (!homes) await delay(250);
  }
  if (stopping()) throw fault('WorldStopped', 503);
  if (!homes) throw fault('OperatorHomesUnknown', 503);
  const paceArgs = Object.entries({ 'cadence-ms': pace.cadenceMs, 'max-acts': pace.maxActs, 'max-refusals': pace.maxRefusals, 'min-gap-ms': pace.minGapMs }).filter(([, v]) => Number.isSafeInteger(v) && v >= 0).flatMap(([k, v]) => [`--${k}`, String(v)]);
  launchSide('operators', process.execPath, [path.join(root, 'permutation-gateway/src/frontier/local-play-operator-residents.mjs'), '--count', String(n), '--relay-ports', ports.join(','),
    '--herald', `http://127.0.0.1:${herald}`, '--homes', JSON.stringify(homes), ...(nations ? ['--nations', nations.join(',')] : []), ...paceArgs, ...(war ? ['--war', OPERATOR_WAR_MODE] : []),
    // (flag-keeps-ai, F4: a war world with the world's goals — its residents read the judge's posting as the page's card does)
    ...(war && goals ? ['--goals', goals] : []), ...(localLane() === COEXIST_LANE ? ['--lane', COEXIST_LANE_WORD] : []),
    // (⑧ P2, TEST-ONLY: a persisted world keeps its residents' keys in its own private dir, so a resume has the same residents)
    ...(keysDir ? ['--keys-dir', keysDir] : []),
    // (TEST-ONLY wide play: the opened wide provinces, so the residents claim wide land within reach of a rim village)
    ...(Array.isArray(wideTargets) && wideTargets.length ? ['--wide', JSON.stringify(wideTargets)] : []),
    // (fix-loop16, owner Q-LP16-2 (b), TEST-ONLY `--operator-near`: resident 0 waits for this PUBLIC address's first village
    //  and settles beside it — local-play-operator-policy.mjs nearChoice. A public address only, never a key)
    ...(near ? ['--near', near] : [])]);
  let first = null;
  for (const until = Date.now() + (limit.operatorWalletsMs ?? OPERATOR_WALLETS_MS); !first && Date.now() < until && !stopping();) {
    try { first = JSON.parse((await fs.readFile(path.join(dir, 'operators.out'), 'utf8')).split('\n')[0]); } catch { /* not a whole line yet */ }
    if (!first) await delay(100);
  }
  const wallets = first?.wallets;
  if (stopping()) throw fault('WorldStopped', 503);
  if (!first || first.schema !== OPERATOR_RESIDENTS_SCHEMA || first.mode !== OPERATOR_RESIDENTS_MODE || first.test_only !== true || !Array.isArray(wallets) || wallets.length !== n
    || !wallets.every(validWallet) || new Set([...wallets, ...players]).size !== n + players.length) throw fault('OperatorResidentsNotReady', 503);
  for (const w of wallets) await (limit.operatorFund ?? (a => runnerRpc(rpc, 'requestAirdrop', [a, OPERATOR_LAMPORTS])))(w);
  // (each is a RESIDENT's relay: one action per bell for its wallet's Citizen, Q16-2 — one lease directory per world,
  //  so a second relay for the same wallet in this world could not double-act either)
  const turnsDir = path.resolve(dir, 'resident-turns');
  wallets.forEach((w, i) => launch(`relay-op-${i}`, process.execPath, [path.join(root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), ...relayArgsFor(w, ports[i]), '--resident-turns', turnsDir]));
  await fs.writeFile(path.join(dir, 'operators.json'), JSON.stringify({ schema: OPERATOR_RESIDENTS_SCHEMA, mode: OPERATOR_RESIDENTS_MODE, test_only: true, count: n, ...(nations ? { nations: [...nations] } : {}), wallets, ports, lamports_each: OPERATOR_LAMPORTS, homes: homes.length }), { flag: 'wx' });
  return Object.freeze({ count: n, wallets: Object.freeze([...wallets]), ports: Object.freeze([...ports]) });
}
/**
 * TEST-ONLY external residents (⑤ option B) for one natural world: for each admitted PUBLIC address (never a key), the
 * newcomer's set-up a second person of a contest pair gets — funded through the runner's RPC with the player's own
 * amount (`OPERATOR_LAMPORTS`, the same for everyone; nothing more), one local-play relay pinned to that wallet with the
 * player's own relay arguments, started as a SIDE process (its end never ends the people's world), and one public world
 * proxy of its own in front of the shared herald and that relay. Written to `externals.json` (the operator's local
 * record; never served). → `{wallets, ports, heralds: {address: proxy origin}}`. Any refusal ends the world's start.
 */
export async function startExternalResidents({ wallets, dir, ports, rpc, internalHerald, launcherPort, players, launchSide, relayArgsFor, root, proxies, stopping, limit = {} }) {
  if (!Array.isArray(wallets) || wallets.length < 1 || wallets.length > EXTERNAL_RESIDENTS_MAX || ports.length !== wallets.length || !wallets.every(validWallet)
    || new Set([...wallets, ...players]).size !== wallets.length + players.length) throw fault('InvalidExternalResidents', 503);
  for (const p of ports) { await freePort(p.herald); await freePort(p.relay); }
  for (const w of wallets) { if (stopping()) throw fault('WorldStopped', 503); await (limit.externalFund ?? (a => runnerRpc(rpc, 'requestAirdrop', [a, OPERATOR_LAMPORTS])))(w); }
  const heralds = {};
  // (each is a RESIDENT's relay too — ⑤B, an external AI resident: one action per bell for its wallet's Citizen, Q16-2,
  //  on the world's one lease directory, the same as the operator residents' relays)
  const turnsDir = path.resolve(dir, 'resident-turns');
  for (const [i, w] of wallets.entries()) {
    // (external-wide-orders: in a --wide-land world too, the SAME relay as an operator resident's — the person's relay
    //  arguments plus `--resident-turns`: the wide claim, a wide village's Train/Muster/Depart and the expedition's
    //  depart route are served under the one action per turn, the program's checks and the relay's byte-for-byte rebuild,
    //  as for the page. verify-pr163's `--no-wide-orders` stays a relay option; the launcher no longer passes it)
    launchSide(`relay-ext-${i}`, process.execPath, [path.join(root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), ...relayArgsFor(w, ports[i].relay), '--resident-turns', turnsDir]);
    const x = createWorldProxy({ port: ports[i].herald, targetPort: internalHerald, launcherPort, relayPort: ports[i].relay });
    proxies.push(x);
    await new Promise((resolve, reject) => { x.once('error', reject); x.listen(ports[i].herald, '127.0.0.1', resolve); });
    heralds[w] = `http://localhost:${ports[i].herald}`;
  }
  // (each relay was started last: the world is handed over only once every one says it listens, as the conquest relay)
  for (const i of wallets.keys()) {
    let listening = false;
    for (let k = 0; k < (limit.externalListenTries ?? 100) && !stopping() && !listening; k++) {
      try { listening = typeof JSON.parse((await fs.readFile(path.join(dir, `relay-ext-${i}.out`), 'utf8')).split('\n')[0]).listen === 'string'; } catch { /* not a whole line yet */ }
      if (!listening) await delay(100);
    }
    if (!listening) throw fault(stopping() ? 'WorldStopped' : 'ExternalRelayNotReady', 503);
  }
  await fs.writeFile(path.join(dir, 'externals.json'), JSON.stringify({ schema: EXTERNAL_RESIDENTS_SCHEMA, mode: EXTERNAL_RESIDENTS_MODE, test_only: true, wallets, ports, lamports_each: OPERATOR_LAMPORTS, keys: 'none: each signs with its own wallet in its own process' }), { flag: 'wx' });
  return Object.freeze({ wallets: Object.freeze([...wallets]), ports: ports.flatMap(p => [p.herald, p.relay]), heralds: Object.freeze(heralds) });
}
// Children still alive when this process ends are ended with it: nothing this launcher started outlives it.
const live = new Set(); let hooked = false;
function own(child) {
  live.add(child);
  if (!hooked) { hooked = true; process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL'); } catch { /* already gone */ } } }); }
}
const exited = p => p.pid === undefined || p.exitCode !== null || p.signalCode !== null;
/** Real milliseconds the launcher waits for its worlds to close on Ctrl-C before it ends their processes itself. */
export const LAUNCHER_CLOSE_MAX_MS = 20_000;
/**
 * (fix-loop6, LP6-3) The launcher's end on Ctrl-C / SIGTERM / SIGHUP. loop-play6: a `--wide --ai 4` launcher, hours
 * after its world's TTL with the page still polling, closed its port on Ctrl-C and then waited in `manager.close()`
 * forever at 0 % CPU; a second Ctrl-C and SIGTERM were ignored (it was already ending), only SIGKILL ended it. Not
 * reproduced with a 15-min `--demo` world, so the root cause is not known; whatever it is, the end is bounded now:
 *   - the first signal closes the port and every world, as before, but waits at most `maxMs` for that;
 *   - past it, or on a second signal, it says which worlds were left (to find the cause next time), ends every
 *     process it started (`live`, SIGKILL) and exits — 0: a stop the person asked for.
 * → the handler for `process.on(signal, …)`. `exit`, `log`, `kill` are stand-ins in tests.
 */
export function launcherShutdown({ server, manager, live: kids = live, maxMs = LAUNCHER_CLOSE_MAX_MS, exit = code => process.exit(code),
  log = line => console.error(line), kill = p => { try { p.kill('SIGKILL'); } catch { /* already gone */ } } }) {
  let ending = false, done = false;
  const finish = why => {
    if (done) return; done = true;
    let left = [];
    try { left = manager.list(); } catch { /* nothing to say */ }
    if (why !== 'closed') log(JSON.stringify({ step: 'launcher-end', why, worlds_left: left.map(w => ({ state: w.state, startedAt: w.startedAt, ...(w.expiry ? { expiresAt: w.expiry.expiresAt } : {}) })), processes_left: [...kids].filter(p => !exited(p)).map(p => p.pid) }));
    for (const p of kids) if (!exited(p)) kill(p);
    exit(0);
  };
  return signal => {
    if (ending) { finish(`second ${signal ?? 'signal'}`); return; }
    ending = true;
    try { server.close(); server.closeAllConnections(); } catch { /* already closed */ }
    const t = setTimeout(() => finish(`worlds not closed within ${maxMs} ms`), maxMs); t.unref?.();
    Promise.resolve().then(() => manager.close()).catch(() => {}).then(() => { clearTimeout(t); finish('closed'); });
  };
}
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
  // (the test-only land preview: only with the capture demo)
  const land = c.landPreview === true;
  if (land && demo === null) throw fault('InvalidWorldPreset', 503);
  // (the TEST-ONLY continuous preset and persistence: natural worlds only, never with the demo's compressed clock)
  const continuous = c.continuous === true, persist = c.persist === true;
  if ((c.continuous !== undefined && !continuous) || (c.persist !== undefined && !persist) || ((continuous || persist) && (!natural || demo !== null))) throw fault('InvalidWorldPreset', 503);
  // (the TEST-ONLY fresh map: natural worlds only; this world's own clock origin, picked here (`c.guard.mapOrigin`: tests only))
  const freshMap = c.freshMap === true;
  if (c.freshMap !== undefined && (!freshMap || !natural)) throw fault('InvalidWorldPreset', 503);
  const mapOrigin = freshMap ? (typeof c.guard?.mapOrigin === 'function' ? c.guard.mapOrigin() : freshMapOrigin()) : null;
  if (mapOrigin !== null && !mapOriginOk(mapOrigin)) throw fault('InvalidWorldPreset', 503);
  // (the TEST-ONLY wide land: a memory-only, finite natural world without the demo, the pair or the land preview)
  const wide = c.wideLand === true;
  if (c.wideLand !== undefined && (!wide || !natural || demo !== null || land || continuous || persist || c.contestPair)) throw fault('InvalidWorldPreset', 503);
  // (`preset`: the conquest lane only; a natural world takes none of its steps)
  const preset = natural ? null : c.worldPreset ?? null;
  if (preset !== null && preset !== CONQUEST_WORLD_PRESET) throw fault('InvalidWorldPreset', 503);
  if (preset !== null && !c.prepareScale) throw fault('WorldPresetNeedsPrepare', 503);
  // (the TEST-ONLY contest pair: a second wallet only with the pair option on a capture-demo world; its relay and proxy
  //  take the NEXT slot's relay and herald ports, which no other world may then use)
  const second = opts.second ?? null;
  if (second !== null && (!c.contestPair || (demo === null && !natural) || !validWallet(second) || second === wallet || slot + 1 >= WORLD_LIMIT)) throw fault('InvalidContestPair', 503);
  const { rpc, ws, herald, relay, internalHerald } = worldPorts(c.worldPort, slot);
  const pairPorts = second !== null ? worldPorts(c.worldPort, slot + 1) : null;
  // (TEST-ONLY wide land: its herald records a 129-ring map every turn — 128 MiB lasts ~40 min of a x60 clock even
  //  compact (wide-local-playable run 4, ~3 MB/min) — so its world's output guard is WIDE_OUTPUT_MAX; the disk floor stands)
  const limit = { ttlMs: c.worldTtlMs ?? WORLD_TTL_MS, outputMax: wide ? WIDE_OUTPUT_MAX : WORLD_OUTPUT_MAX, diskFloor: DISK_FLOOR, everyMs: 1000, ...c.guard };
  for (const p of [rpc, ws, herald, relay, internalHerald, ...(pairPorts ? [pairPorts.herald, pairPorts.relay] : [])]) await freePort(p);
  const disk = await fs.statfs(c.data); if (disk.bavail * disk.bsize < limit.diskFloor) throw fault('DiskFloor', 503);
  // (persisted: the wallet's own stable private directory, and this start's logs inside it; otherwise a new directory)
  const home = persist ? path.join(c.data, 'persist', wallet) : null;
  if (persist) {
    await ensurePrivateDir(path.join(c.data, 'persist'));
    await ensurePrivateDir(home);
    // (a herald's records without the runner's world are another start's remains: never adopted)
    const has = async rel => !!(await fs.lstat(path.join(home, rel)).catch(() => null));
    if (await has('herald') && !(await has('run/world.json'))) throw fault('PersistIncomplete', 503);
    // (B16: a kept world for two people records its second player once, in `pair.json` (0600); it resumes only as the
    //  same pair, and a kept world of one person never becomes a pair, nor a pair's world a world of one)
    const pair = await readPersistedPair(home);
    if (pair === false) throw fault('PersistPairInvalid', 503);
    if (second !== null && pair !== null && pair !== second) throw fault('PersistPairMismatch', 503);
    if (second === null && pair !== null) throw fault('PersistPairMismatch', 503);
    if (second !== null && pair === null) {
      if (await has('run/world.json')) throw fault('PersistNotAPair', 503);
      await fs.writeFile(path.join(home, PAIR_FILE), JSON.stringify({ schema: PAIR_FILE_SCHEMA, mode: CONTEST_PAIR_MODE, first: wallet, second, test_only: true }), { flag: 'wx', mode: 0o600 });
    }
    await ensurePrivateDir(path.join(home, 'starts'));
  }
  const dir = persist ? path.join(home, 'starts', `${Date.now()}-${randomUUID().slice(0, 8)}`) : path.join(c.data, randomUUID()); await fs.mkdir(dir, persist ? { mode: 0o700 } : undefined);
  const children = [], externalProxies = []; let stopping = null, timer, ready = false, proxy, pairProxy;
  // (fix-loop8: the co-op board's chain-clock sampler, stopped with the world)
  let coopStop = null, goalsStop = null;
  const stop = (reason = 'requested') => (stopping ??= (async () => {
    clearInterval(timer);
    try { coopStop?.(); } catch { /* the sampler only reads */ }
    try { goalsStop?.(); } catch { /* the judge only reads */ }
    try {
      for (const p of children) if (!exited(p)) p.kill('SIGINT');
      const gone = Promise.all(children.map(p => (exited(p) ? null : new Promise(r => p.once('exit', r)))));
      const within = ms => { let t; return Promise.race([gone, new Promise(r => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t)); };
      await within(3000);
      for (const p of children) if (!exited(p)) p.kill('SIGKILL');
      await within(2000);
      await proxy?.closeNow();
      await pairProxy?.closeNow();
      for (const x of externalProxies) await x.closeNow();
      await fs.writeFile(path.join(dir, 'stopped.json'), JSON.stringify({ reason: String(reason), at: Date.now() })).catch(() => {});
    } finally { for (const p of children) live.delete(p); onStop(); }
  })());
  const aborted = () => { stop(typeof signal.reason === 'string' ? signal.reason : 'aborted'); };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  // (fix-loop7: this world's runner time-control token — RUNNER_CONTROL_ENV — handed to the runner process only)
  const control = makeRunnerControl();
  const launch = (name, executable, args) => {
    if (stopping) throw fault('WorldStopped', 503);
    const out = openSync(path.join(dir, name + '.out'), 'wx'), err = openSync(path.join(dir, name + '.err'), 'wx');
    let child;
    const env = name === 'runner' ? { ...process.env, [RUNNER_CONTROL_ENV]: control } : { ...process.env, [RUNNER_CONTROL_ENV]: '' };
    try { child = spawn(executable, args, { cwd: c.root, stdio: ['ignore', out, err], shell: false, env }); } finally { closeSync(out); closeSync(err); }
    children.push(child); own(child); child.once('error', () => { stop(`${name}-failed`); }); child.once('exit', () => { stop(`${name}-exited`); }); return child;
  };
  // (a side process: stopped with the world, but its own end never ends the world — the TEST-ONLY operator residents:
  //  a resident that stops or fails leaves the people's world running)
  const launchSide = (name, executable, args) => {
    if (stopping) throw fault('WorldStopped', 503);
    const out = openSync(path.join(dir, name + '.out'), 'wx'), err = openSync(path.join(dir, name + '.err'), 'wx');
    let child;
    try { child = spawn(executable, args, { cwd: c.root, stdio: ['ignore', out, err], shell: false, env: { ...process.env, [RUNNER_CONTROL_ENV]: '' } }); } finally { closeSync(out); closeSync(err); }
    children.push(child); own(child); child.once('error', () => {}); return child;
  };
  // the TTL origin: the world's automatic end is fixed here, once (`worldExpiry` refuses a value a Date cannot hold)
  const started = Date.now(); let checking = false;
  let expiresAt;
  try { expiresAt = worldExpiry(started, limit.ttlMs); } catch (e) { await stop('expiry-unrepresentable'); throw e; }
  // (local-perf, 2026-11-21: the life is checked on every tick, before anything is awaited; the disk and the output are
  //  measured beside it, the output — a walk of every file of the world, ~70,000 of them after a day of a wide world —
  //  at most every OUTPUT_EVERY_MS. Before, one `checking` flag held all three, so a measurement that never came back
  //  held the life too: two wide worlds of the owner's ran a day past their 90-minute life, 1 GB past their 512 MiB
  //  output limit, with the guard silent. A measurement still under way after GUARD_STALL_MS is given up (said on
  //  stderr) and the next tick measures again)
  let outputAt = 0, checkingSince = 0;
  timer = setInterval(async () => {
    if (stopping) return;
    if (Date.now() > expiresAt) { stop('ttl'); return; }
    if (checking) {
      if (Date.now() - checkingSince < (limit.stallMs ?? GUARD_STALL_MS)) return;
      process.stderr.write(`${JSON.stringify({ launcher_guard: 'stalled', world: path.basename(dir), ms: Date.now() - checkingSince })}\n`);
    }
    const mine = checkingSince = Date.now(); checking = true;
    try {
      const stat = await fs.statfs(c.data);
      if (stopping) return;
      if (stat.bavail * stat.bsize < limit.diskFloor) { stop('disk-floor'); return; }
      if (Date.now() - outputAt >= (limit.outputEveryMs ?? OUTPUT_EVERY_MS)) { outputAt = Date.now(); if (await bytesUnder(home ?? dir) > limit.outputMax) stop('output-limit'); }
    } catch { stop('guard-failed'); } finally { if (checkingSince === mine) checking = false; }
  }, limit.everyMs); timer.unref();
  try {
    if (natural) launch('runner', c.naturalRunner, ['--artifact', c.artifact, '--artifact-sha256', c.artifactSha, '--player-wallet', wallet, '--rpc-port', String(rpc), '--ws-port', String(ws), '--keeper', 'public-quicknet',
      ...(demo !== null ? ['--capture-demo', CAPTURE_DEMO_MODE, '--demo-scale', String(demo.scale)] : []),
      ...(second !== null ? ['--contest-pair', CONTEST_PAIR_MODE, '--second-wallet', second] : []),
      ...(land ? ['--land-preview', LAND_PREVIEW_OPTION] : []),
      ...(continuous ? ['--continuous', CONTINUOUS_MODE] : []),
      ...(persist ? ['--persist-dir', path.join(home, 'run')] : []),
      ...(mapOrigin !== null ? ['--map-origin', String(mapOrigin)] : []),
      ...(wide ? ['--wide-land', WIDE_LAND_MODE, ...(c.wideScale ? ['--wide-scale', String(c.wideScale)] : []), ...(c.pacing ? ['--pacing', PACING_MODE] : [])] : []),
      // (TEST-ONLY war world: the keeper also serves the operator residents' villages, read from operators.json)
      // (TEST-ONLY wide world, wide-march-local: likewise, so the AI residents' marches into the wide land are revealed
      //  and settled)
      ...(c.operatorWar || (wide && c.operatorResidents) ? ['--operator-villages', path.join(dir, 'operators.json')] : []),
      // (TEST-ONLY external residents, runner-throughput-2 / BREAK-143-1: their villages join the same keeper loop as the
      //  operator residents' and the person's, read from externals.json once written — before, no keeper served an
      //  external resident's home, and it trailed by many turns)
      ...((opts.external ?? []).length ? ['--external-villages', path.join(dir, 'externals.json')] : [])]);
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
    if (!runnerLandAgrees(meta, land)) throw fault('RunnerNotReady', 503);
    // (the contest pair likewise: the runner's first line names THIS second wallet, or a runner of one player never mentions it)
    if (!runnerPairAgrees(meta, second)) throw fault('RunnerNotReady', 503);
    // (the continuous preset and the persistence likewise: stated exactly as asked, or not at all)
    if (!runnerPersistAgrees(meta, { continuous, persist })) throw fault('RunnerNotReady', 503);
    // (the fresh map likewise: a new world states exactly this start's origin, or none when none was asked for; a
    //  resumed kept world keeps its own. What this world's map is made from is recorded with this start's logs)
    if (!runnerMapAgrees(meta, mapOrigin)) throw fault('RunnerNotReady', 503);
    // (the wide land likewise: stated exactly as asked, or not at all; what was grown is recorded with this start's logs)
    if (!runnerWideAgrees(meta, wide, wide && c.wideScale ? c.wideScale : null)) throw fault('RunnerNotReady', 503);
    if ((meta?.local_rules?.pacing === PACING_MODE) !== (c.pacing === true)) throw fault('RunnerNotReady', 503);
    if (wide) await fs.writeFile(path.join(dir, 'wide-land.json'), JSON.stringify({ mode: WIDE_LAND_MODE, world: meta.wide_land, test_only: true }));
    if (freshMap) await fs.writeFile(path.join(dir, 'fresh-map.json'), JSON.stringify({ mode: FRESH_MAP_MODE, asked_origin: mapOrigin, world: runnerFreshMap(meta), resumed: meta.persist?.resumed === true, fixed_origin: MAP_ORIGIN_DEFAULT, test_only: true }));
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
    const relayArgsFor = (w, port, conquest = []) => ['--local-play', '--rpc', meta.rpc_url, '--program', meta.program, '--season', meta.season, '--wallet', w, '--ruleset-hash', RULESET, ...(c.coexist === true ? ['--coexist'] : []), '--prepare-bin', c.depart, '--preview-bin', c.preview, '--resident-bin', c.resident, ...conquest, ...instanceArgs, ...economyArgs, ...trialArgs, '--cu-limit', '1000000', '--loaded-limit', '67108864', '--listen-port', String(port)];
    const relayArgs = (conquest = []) => relayArgsFor(wallet, relay, conquest);
    const startRelay = (conquest = []) => launch('relay', process.execPath, [path.join(c.root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), ...relayArgs(conquest)]);
    // (a world with no preset: its relay starts now, as it always has, and is never given a conquest CLI)
    if (!preset) startRelay();
    // (the second player's relay: the same world, pinned to ITS wallet as actor and payer; never the first's)
    if (second !== null) launch('relay-b', process.execPath, [path.join(c.root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), ...relayArgsFor(second, pairPorts.relay)]);
    // (no --web: the page is the launcher's own; a world serves records and the relay, never a second copy of the page)
    // (a natural world has no synthetic account to seed: its herald folds the real transactions only)
    // (nation chat, TEST-ONLY local worlds: the herald keeps the world's messages beside its own data; no operator token — a
    //  local world's operator reads `chat/reports.json` there. A herald built before the chat ignores the flag.)
    const chatArgs = ['--chat-dir', path.join(home ?? dir, 'chat')];
    launch('herald', c.herald, ['--data', path.join(home ?? dir, 'herald'), '--program', meta.program, '--season', String(meta.season_id), '--rpc', meta.rpc_url, '--listen', `127.0.0.1:${internalHerald}`, '--source', 'localnet', '--cluster', 'localnet', ...chatArgs, ...(natural ? [] : ['--local-play-metadata', path.join(dir, 'metadata.json')]), '--relay', `127.0.0.1:${relay}`, ...(HERALD_OUTPUT_MODES.includes(c.heraldOutput) ? ['--output', c.heraldOutput] : [])]);
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
    // (compact output: handed over only once this world's herald has recorded the mode; a herald that ignored the option
    //  is stopped by the same path as an unready one, never used with the default output in its place)
    if (HERALD_OUTPUT_MODES.includes(c.heraldOutput) && !heraldOutputRecorded(await fs.readFile(path.join(dir, 'herald', 'output-mode'), 'utf8').catch(() => null), c.heraldOutput)) throw fault('HeraldOutputNotCompact', 503);
    await fs.writeFile(path.join(dir, 'processes.json'), JSON.stringify({ started, wallet, ...(second !== null ? { second } : {}), pids: children.map(p => p.pid), ports: [rpc, ws, herald, relay, internalHerald, ...(pairPorts ? [pairPorts.herald, pairPorts.relay] : [])] }));
    // (B13, TEST-ONLY `--coop-board`: ①'s co-op board for this world, in this process, its records in the world's own
    //  directory; served on the launcher's origin under the mount of each of this world's proxies — local-play-coop-board.mjs)
    const coop = c.coopBoard === true ? await (limit.openWorldBoard ?? openWorldBoard)({ dir, meta, heraldPort: herald, pairPort: pairPorts?.herald ?? null }) : null;
    coopStop = typeof coop?.stop === 'function' ? coop.stop : null;
    // (TEST-ONLY `--world-goals flag-keeps-v2`: the world's goals judged off chain in this process — flag keeps only, no
    //  money; its state in the world's directory — a kept world's home, so a resume keeps its rounds (verify-pr198) —
    //  served under /goals-world/<proxy port>/ — local-play-world-goals.mjs)
    const goals = c.worldGoals ? await (limit.openWorldGoals ?? openWorldGoals)({ dir, stateDir: persist ? home : dir, meta, heraldPort: herald, pairPort: pairPorts?.herald ?? null, rules: c.worldGoals }) : null;
    goalsStop = typeof goals?.stop === 'function' ? goals.stop : null;
    // (TEST-ONLY operator residents, ⑤ option A: only on a natural world whose launcher was started with
    //  `--operator-residents <n>`; each is an ordinary participant — its own memory-only TEST wallet, funded like the
    //  player's, its own relay — and the page is told nothing about them: they are shown as any other resident is)
    // (⑧ P2: in a persisted world the residents' TEST keys are kept in `<home>/operator-keys/` (0700, 0600 files))
    const operatorKeys = persist && natural && c.operatorResidents ? path.join(home, 'operator-keys') : null;
    if (operatorKeys) await ensurePrivateDir(operatorKeys);
    const operators = natural && c.operatorResidents ? await startOperatorResidents({ keysDir: operatorKeys, n: c.operatorResidents, dir, ports: operatorRelayPorts(c.worldPort, slot, c.operatorResidents, WORLD_LIMIT, c.operatorNations ? OPERATOR_NATIONS_MAX : OPERATOR_RESIDENTS_MAX), nations: c.operatorNations ?? null, rpc, herald,
      players: [wallet, ...(second !== null ? [second] : [])], launch, launchSide, relayArgsFor, root: c.root, stopping: () => stopping !== null, limit, pace: c.operatorPace ?? {}, war: !!c.operatorWar, wideTargets: wide ? wideTargetsOf(meta) : null, goals: goals ? `http://127.0.0.1:${c.port}${goalsMount(herald)}/goals/state` : null, near: c.operatorNear ? wallet : null }) : null;
    if (operators) await fs.writeFile(path.join(dir, 'processes.json'), JSON.stringify({ started, wallet, ...(second !== null ? { second } : {}), pids: children.map(p => p.pid), ports: [rpc, ws, herald, relay, internalHerald, ...(pairPorts ? [pairPorts.herald, pairPorts.relay] : []), ...operators.ports] }));
    // (TEST-ONLY external residents, ⑤ option B: only on a natural world whose launcher admitted their public addresses;
    //  each gets the newcomer's set-up and nothing else — the player's funding, a relay pinned to its own wallet, a
    //  public proxy of its own — and the page is told nothing about them)
    const external = natural && (opts.external ?? []).length ? await startExternalResidents({ wallets: opts.external, dir, ports: externalPorts(c.worldPort, slot, opts.external.length, { worldLimit: WORLD_LIMIT, operatorMax: c.operatorResidents ? Math.max(c.operatorNations ? OPERATOR_NATIONS_MAX : OPERATOR_RESIDENTS_MAX, operatorSlotPorts(c.operatorResidents)) : 0 }),
      rpc, internalHerald, launcherPort: c.port, players: [wallet, ...(second !== null ? [second] : []), ...(operators?.wallets ?? [])], launchSide, relayArgsFor, root: c.root, proxies: externalProxies, stopping: () => stopping !== null, limit }) : null;
    if (external) await fs.writeFile(path.join(dir, 'processes.json'), JSON.stringify({ started, wallet, ...(second !== null ? { second } : {}), pids: children.map(p => p.pid), ports: [rpc, ws, herald, relay, internalHerald, ...(pairPorts ? [pairPorts.herald, pairPorts.relay] : []), ...(operators?.ports ?? []), ...external.ports] }));
    // (only with --prepare-scale, only now: after this the launcher never touches this world's clock again)
    const prepared = c.prepareScale ? await prepareWorld({ scale: c.prepareScale, dir, rpc, herald, meta, stopping: () => stopping !== null, limit, control }) : null;
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
    // (incrementally: runnerFollower — a long world's runner.out is too large to read whole on each question)
    const keeperLines = runnerFollower(dir, [KEEPER_LINE]);
    const keeper = async () => { try { return keeperSummary([...(await keeperLines()).values()]); } catch { return null; } };
    // (TEST-ONLY contest pair: the fort and nations the two players meet over, read only when a player asks)
    const pairView = second !== null ? async () => { try { return pairTargetSummary(await runnerLines(dir)); } catch { return null; } } : null;
    return { herald: `http://localhost:${herald}`, stop, expiry, keeper, ...(coop ? { coop } : {}), ...(goals ? { goals } : {}), ...(external ? { external: external.heralds } : {}), ...(second !== null ? { pair: { second, herald: `http://localhost:${pairPorts.herald}` }, pairView } : {}), ...(natural ? { natural: true } : {}), ...(c.coexist === true ? { lane: COEXIST_LANE_WORD } : {}), ...(marchTrial ? { marchTrial: true } : {}), ...(demo !== null ? { captureDemo: { scale: demo.scale } } : {}), ...(land ? { landPreview: true } : {}), ...(prepared ? { prepared } : {}), ...(conquestWorld ? { conquestWorld } : {}),
      ...(wide ? { wideLand: { scale: c.wideScale ?? 1, targets: wideTargetsOf(meta) } } : {}),
      // (fix-loop16, owner 2026-11-25 12:04 Q-LP16-4 (a): the NATIONS that have an operator AI resident, for the nation
      //  picker's mark — nation numbers only: no wallet, no village, nothing that says which resident is an AI. With
      //  `--operator-near` resident 0 has no nation until the player has a village, so it is not in the list; `aiNear` says so)
      ...(operators ? { aiNations: operatorNationsOf(c).slice(c.operatorNear ? 1 : 0), ...(c.operatorNear ? { aiNear: true } : {}) } : {}),
      ...(continuous ? { continuous: true } : {}), ...(persist ? { persisted: { resumed: meta.persist.resumed } } : {}) };
  } catch (e) { await stop(`startup-failed${e?.status && e.code ? `:${e.code}` : ''}`); throw e; }
}
/** The art a page may keep between loads (checked again on each: no-cache with a validator). */
const ART_EXT = new Set(['.svg', '.png', '.webp', '.woff2', '.ico', '.mp3']);
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.txt': 'text/plain' };
export function createLauncherServer(c, manager = new WorldManager(c)) {
  // (D-verify-pr57-1: ending a world takes this proof — `parseStop`; tests may fix it as `c.ownerProof`)
  const ownerProof = c.ownerProof ?? makeOwnerProof();
  if (!OWNER_PROOF_RE.test(ownerProof)) throw fault('InvalidOwnerProof');
  // (TEST-ONLY `--coexist`: this process plays the coexist lane from here on — its relays' ruleset, its residents' pins)
  if (c.coexist === true) selectLocalLane(COEXIST_LANE);
  const allowedHosts = new Set([`localhost:${c.port}`, `127.0.0.1:${c.port}`]);
  // The herald's own policy for the Frontier pages, and beside 'self' only the two places a world of this launcher
  // can be: the page reaches nothing else, whatever a reply names.
  const worlds = Number.isInteger(c.worldPort) ? Array.from({ length: WORLD_LIMIT }, (_, slot) => worldPorts(c.worldPort, slot).herald).flatMap(p => [`http://localhost:${p}`, `ws://localhost:${p}`]) : [];
  const PAGE = '/frontier/frontier/index.html', laneWord = c.coexist === true ? COEXIST_LANE_WORD : '', prepare = c.prepareScale ? 'accelerated' : '', world = c.worldPreset === NATURAL_WORLD_PRESET ? 'natural' : '', march = c.marchTrial === true ? 'trial' : '', demoWord = c.captureDemo ? 'capture' : '', persistWord = c.persist === true ? PERSIST_PAGE_WORD : '';
  const pageCsp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src ${["'self'", ...worlds].join(' ')}; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'`;
  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host) || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) throw fault('HostDenied', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/local-play/start' || url.pathname === '/local-play/stop' || url.pathname === '/local-play/worlds' || url.pathname === '/local-play/keeper' || url.pathname === '/local-play/pair') {
        if (req.method !== 'POST') throw fault('MethodNotAllowed', 405);
        if (req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw fault('OriginDenied', 403);
        const body = (await readBody(req, 256)).toString('utf8');
        let parsed; try { parsed = JSON.parse(body); } catch { throw fault('InvalidJSON'); }
        if (url.pathname === '/local-play/worlds') {
          // (what a refused start lists, on the player's own request: so a world can be ended before the limit is met)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 0) throw fault('InvalidRequest');
          return answer(res, 200, { worlds: manager.list() });
        }
        if (url.pathname === '/local-play/stop') {
          const asked = parseStop(parsed);
          if (!ownerProofOk(asked.owner, ownerProof)) throw fault('NotWorldOwner', 403);
          return answer(res, 200, await manager.stop(asked.wallet));
        }
        const wallet = parseStart(parsed);
        if (url.pathname === '/local-play/keeper') return answer(res, 200, await manager.keeper(wallet));
        if (url.pathname === '/local-play/pair') return answer(res, 200, await manager.pair(wallet));
        return answer(res, 200, await manager.start(wallet));
      }
      // (TEST-ONLY `--world-goals`: the goals judge of one live world, read only — local-play-world-goals.mjs)
      const goalsRoute = c.worldGoals ? goalsRouteOf(url.pathname) : null;
      if (goalsRoute) return answerWorldGoals(req, res, { entry: manager.goalsFor(goalsRoute.port), rest: goalsRoute.rest, origin: `http://${req.headers.host}` });
      // (B13, TEST-ONLY `--coop-board`: ①'s board of one live world, under that world's mount — local-play-coop-board.mjs)
      const coopRoute = c.coopBoard === true ? coopRouteOf(url.pathname) : null;
      if (coopRoute) {
        const target = coopTarget(req.url); if (!target) throw fault('BadPath', 400);
        return await answerWorldBoard(req, res, { entry: manager.coopFor(coopRoute.port), port: coopRoute.port, rest: coopRoute.rest, query: target.query, origin: `http://${req.headers.host}` });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fault('MethodNotAllowed', 405);
      const moved = location => { res.writeHead(302, { ...SHIELD, 'content-security-policy': API_CSP, 'cache-control': 'no-store', location }); res.end(); };
      if (url.pathname === '/') return moved(`${PAGE}?localPlay=1&launcher=1&devWallet=off${prepare ? `&prepare=${prepare}` : ''}${world ? `&world=${world}` : ''}${march ? `&march=${march}` : ''}${demoWord ? `&demo=${demoWord}` : ''}${persistWord ? `&persist=${persistWord}` : ''}${laneWord ? `&lane=${laneWord}` : ''}`);
      // The launcher page always says how this launcher prepares its worlds (`prepare=accelerated`, or nothing): one
      // asked for with another value is sent to the right address, so the page shows what will really happen.
      // (the same for the natural world's `world=natural`: the page knows before a start which wait and text are right)
      if (url.pathname === PAGE && url.searchParams.get('launcher') === '1' && ((url.searchParams.get('prepare') ?? '') !== prepare || (url.searchParams.get('world') ?? '') !== world || (url.searchParams.get('march') ?? '') !== march || (url.searchParams.get('persist') ?? '') !== persistWord || (url.searchParams.get('demo') ?? '') !== demoWord || (url.searchParams.get('lane') ?? '') !== laneWord)) {
        const query = new URLSearchParams(url.searchParams); if (prepare) query.set('prepare', prepare); else query.delete('prepare');
        if (world) query.set('world', world); else query.delete('world');
        if (march) query.set('march', march); else query.delete('march');
        if (demoWord) query.set('demo', demoWord); else query.delete('demo');
        if (persistWord) query.set('persist', persistWord); else query.delete('persist');
        if (laneWord) query.set('lane', laneWord); else query.delete('lane');
        return moved(`${PAGE}?${query}`);
      }
      if (!url.pathname.startsWith('/frontier/')) throw fault('NotFound', 404);
      let actual, stat;
      try {
        const decoded = decodeURIComponent(url.pathname.slice('/frontier/'.length));
        actual = await fs.realpath(path.resolve(c.web, decoded === '' || decoded.endsWith('/') ? decoded + 'index.html' : decoded)); stat = await fs.stat(actual);
      } catch { throw fault('NotFound', 404); }
      if (!actual.startsWith(c.web + path.sep) || !stat.isFile()) throw fault('NotFound', 404);
      // (local-perf, 2026-11-21: the art — pictures and fonts — may be kept by the browser but is checked with this
      //  launcher on every load of the page (no-cache + a validator: 304 when unchanged). With no-store the page asked
      //  the same icons again every time the HUD was drawn anew, ~260 requests a minute. Code and pages stay no-store)
      if (ART_EXT.has(path.extname(actual))) {
        const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        const head = { ...SHIELD, 'content-security-policy': pageCsp, 'cache-control': 'no-cache', etag };
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
        res.writeHead(200, { ...head, 'content-type': mime[path.extname(actual)] ?? 'application/octet-stream', 'content-length': stat.size });
        if (req.method === 'HEAD') return res.end(); return createReadStream(actual).pipe(res);
      }
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
  return { server, manager, ownerProof };
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
    [--world-option land-preview-v1: TEST-ONLY, only with --capture-demo: the land preview's crank runs beside the
       keeper (FoldLand / ClaimLandYield, provisional tags); needs a program, runner and herald built with it]
    [--herald-output compact-v1: TEST-ONLY, only with --capture-demo or --wide-land: each new world's herald keeps only the .gz of each
       output file (every file of every turn kept and served as before); the world is used only if its herald recorded it.
       compact-v2: the same, and the herald's findex store gzip-compressed (every record kept)]
    [--continuous local-continuous-v1: TEST-ONLY, natural preset only, not with --capture-demo: the world's Season is
       the program's continuous preset (no end bell, joins always open); the start answer says continuous: true]
    [--persist local-persist-v1: TEST-ONLY, NOT FOR PRODUCTION, natural preset only, not with --capture-demo: each
       wallet's world lives in <data>/persist/<wallet>/ (0700; its chain ledger and two operator keys, 0600, refused when
       looser); a stop keeps it and the next start for that wallet resumes it; the page keeps its key in IndexedDB]
    [--world-ttl-minutes <whole minutes, decimal>: each world's automatic end, counted from its own start; without it
       two hours. Set here only (never over HTTP); fixed once per world and told to its page as its expiry]
    [--coexist local-coexist-v1: TEST-ONLY, natural preset only (kept or capture demo; no wide land): the ②+⑨+⑩ coexist lane
      (0x7805, RULESET_HASH_V4): --artifact the coexist .so, the runners/herald/tools built with feature coexist-lane]
    [--fresh-map local-fresh-map-v1: TEST-ONLY, natural preset only: each NEW world gets its own map. Without it
       every natural world has the same map (one fixed clock origin, so one genesis round and one genesis seed).
       With it the launcher picks a clock origin in the 365 days before the fixed one for each new world; the
       Season fixes another real quicknet round and the program derives another seed by its unchanged rules. A
       resumed kept world keeps its map. Recorded in the start's fresh-map.json]
    [--wide-land local-wide-land-v1: TEST-ONLY, natural preset only, not with --capture-demo, --contest-pair,
       --world-option, --continuous or --persist: each new world's Season is the devnet wide preset S1_DEVNET_WIDE_7D,
       grown during its setup by the program's own instructions one ring per bell to the rim (128) and into the wide
       land (rings 129+), one test participant per nation; then the natural clock. Memory-only. Recorded in the
       start's wide-land.json; the herald needs wide-world-experimental for the page's recorded-world view.
       Its Season's own bytes also free the centre (⑭ R2) and let a Hamlet rim home anchor a wide claim (itest
       wide_play: TEST-only local rules, never the presets); every nation gets real rim homes (tickets), so a player
       and the operator residents may start beside the wide land and claim it (0xD9, settled by the runner)]
    [--wide-scale <1-60>: TEST-ONLY, only with --wide-land: the wide world's clock from ready-for-join on, in game
       seconds per second (a rim village saves the ~30 game hours of a wide claim's settler cost in 30 min at 60)]
    [--pacing fast-v1: TEST-ONLY, only with --wide-land: the next world's pacing bytes (first village at once on the
       settled rim, 1-turn arrival, 300 s reveal window, 36-turn keep hold, starter host; world4-pacing-impl)]
    [--operator-residents <1-4>: TEST-ONLY, natural preset only: each new world also gets that many operator AI
       residents (⑤ option A): memory-only TEST wallets made by their own process, funded like the player, each with
       its own relay; they Join, PlaceHome and use the economy commands by a fixed offline rule, through the same
       routes and checks as a page. The page is not told which residents they are. Their relays take 4 more ports per
       world after the worlds' ten. Each acts at most ONCE per bell (owner decision Q16-2), with no cap for the
       whole world: residents keep playing until the world ends]
    [--operator-nations <csv of distinct nations 0-5, e.g. 1,4,2,5,0,3>: TEST-ONLY, natural preset only, never with
       --operator-residents: the same residents, one per named nation, in that order (up to six; the six-nation
       recording, scripts/demo/sixnation). Their relays take 6 more ports per world after the worlds' ten.
       Not with --persist]
    [--operator-near operator-near-v1: TEST-ONLY, only with --wide-land and --operator-residents (scripts/play-local.sh
       --ai-near; owner decision Q-LP16-2 (b)): operator resident 0 joins no nation at first; once the player has a
       first village it joins the other nation whose rim village site is nearest to that village, asks for that site
       and claims wide land toward the player. So tiles of another nation stand within an expedition's reach (4
       provinces). No rule, parameter or reach changes: an ordinary resident, placed by choice of site]
    [--operator-max-acts <1-9999>: TEST-ONLY, only with --operator-residents or --operator-nations: each resident's
       send cap for the whole world (without it: none; still one action per bell, Q16-2); the cadence and the refusal limit stay the residents' own]
    [--operator-war operator-war-v1: TEST-ONLY, only with --operator-residents and --march-trial (any natural world: kept,
       plain, --fresh-map, --wide-land or --capture-demo; scripts/play-local.sh turns it on with --ai): the operator residents
       also march (the page's own Depart through their own relays), aimed at reachable keeps of other nations and at
       their own nation's contested keeps, one action per resident per turn; up to 12 residents (two per nation, every
       nation from six on; 5-12 only with this option, their relays then take that many ports per world). The world's
       keeper also serves their villages, and the capture demo's new ring is opened whole (OpenProvince), so every
       nation has keeps to contest. No rule, parameter, turn length or keep timer changes]
    [--external-residents <address>[,<address>]: TEST-ONLY, natural preset only, not with --contest-pair: PUBLIC
       addresses of external AI residents (⑤ option B), programs someone else runs with their OWN wallet. Each new
       world admits the listed addresses no other world has: each is funded like the player (nothing more), gets a
       relay pinned to its wallet and a public proxy of its own, and finds its world with the page's own
       POST /local-play/start {wallet}. It never starts or stops a world. No key is ever given here. Their proxies and
       relays take 4 more ports per world after the worlds' (and the operator residents') ports]
    [--coop-board ws01-board-v1: TEST-ONLY: each world also gets workstream 01's co-op board (requests between nations
       and their answers, signed records; no resource moves), kept in this process with its records in the world's
       directory and served on this launcher's origin under /coop-world/<the world's proxy port>/; the page signs its
       records with its own memory-only key. No caravan is sent from the board's page here (no relay route)]
    [--world-goals flag-keeps-v2 [--flag-keeps-hold <bells>] [--flag-keeps-need <n>] [--flag-keeps-member <bells>]:
       TEST-ONLY: each world's goals are judged off chain in this process (first slice: the flag keeps — a nation that
       holds as many CAPTURED flag keeps as half of the designated ones, each for 144 bells, achieves the round; a
       nation's own starting flag keeps do not count; the older word flag-keeps-v1 is accepted) and served read only under
       /goals-world/<the world's proxy port>/goals/state, with the prize it WOULD have won from a simulated vault (no
       money, no transfer, no chain change). The three numbers override the hold time, the need and the membership time
       for a TEST world only]
    [--port 41920] [--world-port 41924]
  Ports: the page on --port; a world on five from --world-port (RPC, WS, public proxy, relay, herald), the second
  world on the next five. All within 41000-41999, none of 41904-41907, 127.0.0.1 only.`;
export async function parseConfig(args) {
  const out = {}; const keys = new Set(['root', 'data', 'runner', 'herald', 'depart', 'preview', 'resident', 'artifact', 'artifact-sha', 'conquest', 'world-preset', 'prepare-scale', 'port', 'world-port', 'economy', 'world-ttl-minutes', 'natural-runner', 'march-trial', 'capture-demo', 'demo-scale', 'contest-pair', 'herald-output', 'world-option', 'operator-residents', 'operator-nations', 'operator-near', 'operator-max-acts', 'external-residents', 'continuous', 'persist', 'fresh-map', 'prize-epochs', 'coop-board', 'operator-war', 'wide-land', 'wide-scale', 'pacing', 'coexist', 'world-goals', 'flag-keeps-hold', 'flag-keeps-need', 'flag-keeps-member']);
  // (⑰ owner decision 2026-11-18 21:44 (t353u): no AI residents in paid periods. This launcher has no prize lane —
  //  paid windows run only under `frontier-stack up --continuous --prize-epochs` — so `--prize-epochs` is always
  //  refused here, and by name when operator AI residents (⑤A) or external AI residents (⑤B) are asked for with it)
  //  (checked before the strict flag loop, so a ⑤B `--external-residents` is named even where this launcher lacks it)
  if (args.includes('--prize-epochs')) {
    if (args.includes('--operator-residents') || args.includes('--operator-nations') || args.includes('--operator-near') || args.includes('--external-residents')) throw fault('AiResidentsInPaidWindow');
    throw fault('PrizeNotInLauncher');
  }
  for (let i = 0; i < args.length; i += 2) { const k = args[i]?.slice(2); if (!args[i]?.startsWith('--') || !keys.has(k) || out[k] || !args[i + 1]) throw fault('InvalidArguments'); out[k] = args[i + 1]; }
  for (const k of ['root', 'data', 'runner', 'herald', 'depart', 'preview', 'resident', 'artifact']) { if (!path.isAbsolute(out[k] ?? '')) throw fault('AbsolutePathRequired'); }
  if (out.conquest !== undefined && !path.isAbsolute(out.conquest)) throw fault('AbsolutePathRequired');
  if (out['natural-runner'] !== undefined && !path.isAbsolute(out['natural-runner'])) throw fault('AbsolutePathRequired');
  // (TEST-ONLY operator residents: their relays take OPERATOR_RESIDENTS_MAX ports per world after the worlds' own)
  // (TEST-ONLY war world: exactly its one word, only with operator residents and the march trial (their marches are the
  //  page's own trial sends). Any natural world — kept, plain, fresh-map, wide or the capture demo (loop-play4 B-6: it was
  //  the demo's only, so `scripts/play-local.sh` could never show the AI nations at war))
  if (out['operator-war'] !== undefined && out['operator-war'] !== OPERATOR_WAR_MODE) throw fault('InvalidOperatorWar');
  if (out['operator-war'] !== undefined && (out['operator-residents'] === undefined || out['march-trial'] === undefined)) throw fault('OperatorWarNeedsResidentsTrial');
  // (`--operator-nations <csv>`, TEST-ONLY: one resident per named nation, up to six, OPERATOR_NATIONS_MAX ports per world;
  //  never with `--operator-residents`: one of the two says who the residents are)
  const operatorNations = out['operator-nations'] === undefined ? undefined : parseOperatorNations(out['operator-nations']);
  if (operatorNations === null || (operatorNations !== undefined && out['operator-residents'] !== undefined)) throw fault('InvalidOperatorResidents');
  const operatorResidents = operatorNations ? operatorNations.length : out['operator-residents'] === undefined ? undefined : parseOperatorResidents(out['operator-residents'], { war: out['operator-war'] !== undefined });
  if (operatorResidents === null) throw fault('InvalidOperatorResidents');
  const opWidth = operatorNations ? OPERATOR_NATIONS_MAX : OPERATOR_RESIDENTS_MAX;
  // (TEST-ONLY external residents: public addresses only; their proxies and relays take ports after the operators')
  const externalResidents = out['external-residents'] === undefined ? undefined : parseExternalResidents(out['external-residents']);
  if (externalResidents === null) throw fault('InvalidExternalResidents');
  const port = Number(out.port ?? 41920), worldPort = Number(out['world-port'] ?? 41924), span = WORLD_LIMIT * 5 + (operatorResidents ? WORLD_LIMIT * Math.max(opWidth, operatorSlotPorts(operatorResidents)) : 0) + (externalResidents ? externalSpan(WORLD_LIMIT) : 0);
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
  // (B16, loop-play3: the pair is no longer the capture demo's only — any natural world, kept or not, may be for two people)
  if (out['contest-pair'] !== undefined && (out['contest-pair'] !== CONTEST_PAIR_MODE || (out['capture-demo'] === undefined && !natural))) throw fault('InvalidContestPair');
  // (the test-only compact herald output: exactly its one word, and only for capture-demo test worlds)
  if (out['herald-output'] !== undefined && !HERALD_OUTPUT_MODES.includes(out['herald-output'])) throw fault('InvalidHeraldOutput');
  // (also with the TEST-ONLY wide land: its herald writes a 129-ring map every turn of a TEST clock up to x60, which the
  //  plain output takes past the world's 128 MiB guard in about 20 minutes — wide-local-playable run 3, `output-limit`)
  if (out['herald-output'] !== undefined && out['capture-demo'] === undefined && out['wide-land'] === undefined) throw fault('HeraldOutputNeedsCaptureDemo');
  // (the test-only land preview: exactly its one word, and only with the capture demo)
  if (out['world-option'] !== undefined && out['world-option'] !== LAND_PREVIEW_OPTION) throw fault('InvalidWorldOption');
  if (out['world-option'] !== undefined && out['capture-demo'] === undefined) throw fault('WorldOptionNeedsCaptureDemo');
  // (the test-only continuous preset and persistence: exactly their one word each; natural worlds without the demo only)
  if (out.continuous !== undefined && out.continuous !== CONTINUOUS_MODE) throw fault('InvalidContinuous');
  if (out.persist !== undefined && out.persist !== PERSIST_MODE) throw fault('InvalidPersist');
  if ((out.continuous !== undefined || out.persist !== undefined) && (!natural || out['capture-demo'] !== undefined)) throw fault('PersistNeedsNaturalWorld');
  // (the test-only fresh map: exactly its one word, natural worlds only)
  if (out['fresh-map'] !== undefined && out['fresh-map'] !== FRESH_MAP_MODE) throw fault('InvalidFreshMap');
  if (out['fresh-map'] !== undefined && !natural) throw fault('FreshMapNeedsNaturalWorld');
  // (the test-only wide land: exactly its one word; natural worlds without the demo, the pair, the land preview or a kept world)
  if (out['wide-land'] !== undefined && out['wide-land'] !== WIDE_LAND_MODE) throw fault('InvalidWideLand');
  if (out['wide-land'] !== undefined && (!natural || out['capture-demo'] !== undefined || out['world-option'] !== undefined || out.continuous !== undefined || out.persist !== undefined || out['contest-pair'] !== undefined)) throw fault('WideLandNeedsNaturalWorld');
  if (out['wide-scale'] !== undefined && (out['wide-land'] === undefined || parseWideScale(out['wide-scale']) === null)) throw fault('InvalidWideLand');
  // (TEST-ONLY world4-pacing-impl: the next world's pacing bytes on the wide world, exactly its one word)
  if (out.pacing !== undefined && (out.pacing !== PACING_MODE || out['wide-land'] === undefined)) throw fault('InvalidPacing');
  // (the TEST-ONLY coexist lane: exactly its one word; natural worlds (kept, or the capture demo's TEST clock) without the wide land)
  if (out.coexist !== undefined && out.coexist !== COEXIST_MODE) throw fault('InvalidCoexist');
  if (out.coexist !== undefined && (!natural || out['wide-land'] !== undefined)) throw fault('CoexistNeedsNaturalWorld');
  if (operatorResidents !== undefined && !natural) throw fault('OperatorResidentsNeedNatural');
  // (`--operator-nations` is not for a persisted world: `--persist` keeps the residents' keys by resident index, and a
  //  resumed world given another nation order would name a nation its kept Citizen is not of)
  if (operatorNations !== undefined && out.persist !== undefined) throw fault('InvalidOperatorResidents');
  // (fix-loop16, owner Q-LP16-2 (b): `--operator-near operator-near-v1`, TEST-ONLY, only with `--wide-land` and
  //  `--operator-residents` — never `--operator-nations`, whose order names resident 0's nation: resident 0 joins no
  //  nation until the player has a first village, then settles the nearest rim site of another nation)
  if (out['operator-near'] !== undefined && (out['operator-near'] !== OPERATOR_NEAR_MODE || out['wide-land'] === undefined || out['operator-residents'] === undefined)) throw fault('InvalidOperatorNear');
  // (`--operator-max-acts <1-9999>`, TEST-ONLY, only with residents: each resident's send budget for a long recording;
  //  without it the residents' own default, OPERATOR_DEFAULTS.maxActs = none; one action per bell either way (Q16-2). The cadence, gap and refusal limit are unchanged)
  if (out['operator-max-acts'] !== undefined && (operatorResidents === undefined || !/^[1-9][0-9]{0,3}$/.test(out['operator-max-acts']))) throw fault('InvalidOperatorResidents');
  const operatorPace = out['operator-max-acts'] === undefined ? undefined : { maxActs: Number(out['operator-max-acts']) };
  if (operatorResidents !== undefined && Array.from({ length: span }, (_, i) => worldPort + i).includes(41970)) throw fault('InvalidPorts');
  if (externalResidents !== undefined && (!natural || out['contest-pair'] !== undefined)) throw fault('ExternalResidentsNeedNatural');
  if (externalResidents !== undefined && Array.from({ length: span }, (_, i) => worldPort + i).includes(41970)) throw fault('InvalidPorts');
  // (B13: the TEST-ONLY co-op board, asked for in exactly its one word)
  if (out['coop-board'] !== undefined && out['coop-board'] !== COOP_BOARD_MODE) throw fault('InvalidCoopBoard');
  // (the TEST-ONLY world goals judge, asked for in exactly its one word; its three TEST overrides only with it)
  if (out['world-goals'] !== undefined && !WORLD_GOALS_MODES.includes(out['world-goals'])) throw fault('InvalidWorldGoals');
  if (out['world-goals'] === undefined && ['flag-keeps-hold', 'flag-keeps-need', 'flag-keeps-member'].some(k => out[k] !== undefined)) throw fault('InvalidWorldGoals');
  const worldGoals = out['world-goals'] === undefined ? undefined : goalRulesOf({ hold: out['flag-keeps-hold'], need: out['flag-keeps-need'], member: out['flag-keeps-member'] });
  // (a world's life: the default two hours, or the operator's whole minutes; refused, never rounded, when malformed)
  const worldTtlMs = parseWorldTtl(out['world-ttl-minutes']);
  const c = { ...out, port, worldPort, worldTtlMs, artifactSha: out['artifact-sha'], ...(prepareScale !== undefined ? { prepareScale } : {}), ...(worldPreset !== undefined ? { worldPreset } : {}), ...(out['natural-runner'] !== undefined ? { naturalRunner: out['natural-runner'] } : {}), ...(out['march-trial'] !== undefined ? { marchTrial: true } : {}), ...(out.continuous !== undefined ? { continuous: true } : {}), ...(out.persist !== undefined ? { persist: true } : {}), ...(out['fresh-map'] !== undefined ? { freshMap: true } : {}), ...(out['coop-board'] !== undefined ? { coopBoard: true } : {}), ...(worldGoals ? { worldGoals } : {}), ...(out['operator-war'] !== undefined ? { operatorWar: true } : {}), ...(out['wide-land'] !== undefined ? { wideLand: true } : {}), ...(out.coexist !== undefined ? { coexist: true } : {}), ...(out['wide-scale'] !== undefined ? { wideScale: parseWideScale(out['wide-scale']) } : {}), ...(out.pacing !== undefined ? { pacing: true } : {}), ...(out['capture-demo'] !== undefined ? { captureDemo: { scale: parseDemoScale(out['demo-scale']) } } : {}), ...(out['contest-pair'] !== undefined ? { contestPair: true } : {}), ...(out['herald-output'] !== undefined ? { heraldOutput: out['herald-output'] } : {}), ...(out['world-option'] !== undefined ? { landPreview: true } : {}), ...(operatorResidents !== undefined ? { operatorResidents } : {}), ...(operatorNations ? { operatorNations } : {}), ...(out['operator-near'] !== undefined ? { operatorNear: true } : {}), ...(operatorPace ? { operatorPace } : {}), ...(externalResidents !== undefined ? { externalResidents } : {}), web: await fs.realpath(path.join(out.root, 'permutation-server/web')) };
  for (const file of [c.runner, c.herald, c.depart, c.preview, c.resident, c.artifact, ...(c.conquest ? [c.conquest] : []), ...(c.naturalRunner ? [c.naturalRunner] : []), path.join(c.root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs')]) if (!(await fs.stat(file).catch(() => null))?.isFile()) throw fault('MissingFile');
  await fs.mkdir(c.data, { recursive: true });
  // (persisted worlds: their parent is private, made so here, and a looser one refuses the launcher's start)
  if (c.persist) { try { await ensurePrivateDir(path.join(c.data, 'persist')); } catch { throw fault('PersistNotPrivate'); } }
  return c;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config;
  try { config = await parseConfig(process.argv.slice(2)); } catch (e) { console.error(`local-play launcher: ${e?.code ?? e?.message ?? 'cannot start'}\n${USAGE}`); process.exit(2); }
  const { server, manager, ownerProof } = createLauncherServer(config);
  server.once('error', e => { console.error(`local-play launcher: ${e?.code === 'EADDRINUSE' ? `port ${config.port} is in use` : 'cannot listen'}`); process.exit(2); });
  server.listen(config.port, '127.0.0.1', () => console.log(JSON.stringify({ origin: `http://localhost:${config.port}`, open: `http://localhost:${config.port}/#owner=${ownerProof}`, mode: 'new-world-per-wallet', worlds: WORLD_LIMIT, ttl_seconds: (config.worldTtlMs ?? WORLD_TTL_MS) / 1000, ttl_source: config['world-ttl-minutes'] === undefined ? 'default' : '--world-ttl-minutes',
    prepare: config.prepareScale ? { clock_scale: config.prepareScale, chain_seconds_max: PREPARE_CHAIN_MAX, then: '1x, read back, before the world is handed over' } : 'natural 1x',
    world_preset: config.worldPreset ?? null, continuous: config.continuous === true, fresh_map: config.freshMap === true ? FRESH_MAP_MODE : null, lane: config.coexist === true ? COEXIST_MODE : 'plain', wide_land: config.wideLand === true ? WIDE_LAND_MODE : null, wide_scale: config.wideScale ?? null, persist: config.persist ? { mode: PERSIST_MODE, dir: path.join(config.data, 'persist'), test_only: true, not_for_production: true } : null, herald_output: config.heraldOutput ?? 'default', conquest_cli: config.conquest ? 'configured (reaches a relay only with that start\'s capability)' : null,
    ports: { launcher: config.port, worlds: Array.from({ length: WORLD_LIMIT }, (_, slot) => worldPorts(config.worldPort, slot)) } })));
  // (local-perf, 2026-11-21: a line on stderr — the launcher's log — every LAUNCHER_HEARTBEAT_MS: the worlds it runs, its
  //  memory and how late its event loop ran. An owner's page that went white after ~9 hours left nothing to read; the
  //  next time, the log says whether the launcher was alive, busy or growing then)
  const lag = monitorEventLoopDelay({ resolution: 50 }); lag.enable();
  setInterval(() => {
    process.stderr.write(`${JSON.stringify({ launcher_heartbeat: new Date().toISOString(), worlds: manager.list().map(w => ({ state: w.state, startedAt: w.startedAt, expiresAt: w.expiry?.expiresAt ?? null })), rss_mb: Math.round(process.memoryUsage().rss / 1048576), loop_lag_ms: { p99: Math.round(lag.percentile(99) / 1e6), max: Math.round(lag.max / 1e6) } })}\n`);
    lag.reset();
  }, LAUNCHER_HEARTBEAT_MS).unref();
  // Ctrl-C (or a closed terminal): every world of this launcher is ended first, then the launcher.
  // (fix-loop6, LP6-3: bounded — launcherShutdown; a second Ctrl-C ends it at once)
  const end = launcherShutdown({ server, manager });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => end(signal));
}
