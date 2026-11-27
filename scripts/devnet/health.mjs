#!/usr/bin/env node
// health: a READ-ONLY health check of the live devnet stack on the operator's Mac
// (reports/devnet-deploy-2.md: season driver, gateway, herald, keeper A, Cloudflare
// quick tunnel, join check). Prints one line per check:
//
//   2026-11-24 19:41:00 JST OK   herald.lag        herald live slot 525…  rpc 525…  lag 3 slots
//
// and a last line `overall OK|WARN|FAIL (ok N warn N fail N)`. Exit 0 = all OK,
// 1 = at least one WARN, 2 = at least one FAIL.
//
// What it does NOT do, ever: stop, signal or start a process; write any file of
// the stack; read a key, keeper.seed or keeper.token; send a transaction. Keeper
// A's /v1/status needs the bearer token, so keeper A is checked by "the port
// answers 401 without a token" plus its log, and by `keeper.landed`: its journal
// read with `sqlite3 -readonly` (newest landed write vs the herald live slot; WARN
// > 7,500 slots ≈ 30 min, FAIL > 22,500 ≈ 90 min at devnet's ≈ 0.24 s/slot;
// keeper-stall-investigate, 11-26 21:04 → 11-27 nothing landed). Devnet RPC (owner approval B5): only
// getGenesisHash / getSlot / getBalance / getAccountInfo, only to
// https://api.devnet.solana.com (never mainnet), one call per --rpc-gap-ms
// (default 1100), the genesis hash checked before any other call.
//
// usage: node scripts/devnet/health.mjs [--no-rpc] [--no-public] [--json]
//          [--state FILE] [--report FILE] [--log-lines N] [--run-dir DIR] [--logs DIR]
//          [--restart-warn-min N]
//          [--rpc-gap-ms N (>= 1000, default 1100)] [--timeline] [--no-world-yet]
//          [--slot-s S (seconds a slot, for herald.lag's ≈ seconds; default 0.4)]
//   --state FILE   remember the first time each milestone was seen (CreateSeason,
//                  Seeded, Running, keeper start, WideSetRules, join check) across runs
//                  and each process's PID, so a restart is seen as "the PID of the
//                  previous run is gone"
//   --restart-warn-min N  how long a restart stays a WARN, in minutes [30]
//   --report FILE  keep an `ALERT …` line at the top of FILE while/after a check fails
//   --timeline     print the milestone timeline from --state and exit
//   --no-world-yet world creation is postponed on purpose (see below)
//
// "World creation postponed / no world yet" (owner decision 2026-11-24 12:07: the
// scheduled CreateSeason is not sent; the driver was stopped by hand). The mode is on
// with --no-world-yet, or while one of these marker files exists (read-only; the first
// line is shown as the reason; delete the file to return to the default checks):
//   <run-dir>/world-postponed     or     <logs>/devnet-create-postponed
// In this mode, and only in it:
//   - one extra line `world.creation` says so (OK);
//   - season driver not running = OK. Driver RUNNING = FAIL (it would send
//     CreateSeason); gateway starter / join check may be running or not (both only wait);
//   - gateway, keeper A: not expected (as before a world exists);
//   - season.phase: an Announced world past its CreateSeason time is OK and says
//     "creation postponed", with the two on-chain deadlines: AbortSeason returns the
//     creation bond only before the genesis round time (t_create_min + ≈11 min), and
//     CreateSeason can land until t_create_min + 7 days (after that: WARN, a new
//     AnnounceSeason is needed). Aborted is OK ("no world yet");
//   - the authority's balance is judged by its plain thresholds (CreateSeason's need
//     is only quoted);
//   - --state keeps `postponed: {since, src, reason}` and --timeline prints
//     "world creation POSTPONED" instead of the scheduled time.
// If the chain or the driver log shows the world was created after all, the marker is
// stale: `world.creation` is a WARN and every check runs as by default.
// Herald, tunnel, caffeinate, the public page, balances, disk and logs are checked as
// always. Without the flag and the marker nothing changes.
//
// Processes are matched by command pattern only; no PID is written in this file.
// A wanted process that is not running is a FAIL. "restarted" is a WARN only:
//   with --state    on the run that finds a different PID than the previous run did,
//                   and after that until the new process is N minutes old; then OK
//                   with its current PID and uptime. A process the state file has
//                   not seen before is OK (a first start is not a restart).
//   without --state while the process is younger than N minutes (there is no previous
//                   run to compare with, so a first start shows the same WARN).
// Optional overrides, read-only, in <run-dir>/health-procs.json (absent = none):
//   { "restartWarnMin": 30,
//     "procs": { "proc.herald": { "pid": 12345 },
//                "proc.keeper": { "pidfile": "keeper-a/keeper.pid" } } }
// A key with an expected PID (given, or read from the pidfile, path relative to
// --run-dir) is OK only with that PID at any age and a WARN with any other; a
// bad file or entry is one `proc.overrides` WARN line and is otherwise ignored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const RPC_METHODS = Object.freeze(['getGenesisHash', 'getSlot', 'getBalance', 'getAccountInfo']);

// Public addresses only (reports/devnet-deploy-2.md). Thresholds in SOL: below warn = WARN, below fail = FAIL.
export const DEPLOY = Object.freeze({
  program: 'GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr',
  // devnet-continuous-1: the continuous world, season 2 (S1_DEVNET_WIDE_CONTINUOUS, AnnounceSeason 2026-11-24 02:15 JST,
  // sig HogAwvWz…dDy). Season 1 (HgP9VNZJ…jSXk, the 7-day preset) was announced, never created, and aborted 2026-11-24 (bond returned).
  season: '47GBAC71CZXDMBsrGLntFDWJbLPRPwtcD2wXGfsXDxnP',
  createAt: 1795540804, // CreateSeason opens (t_create_min as stored on chain), 2026-11-25 02:20:04 JST; the driver sends at +90 s of its own 1795540802 argument
  wallets: [
    { name: 'deployer', address: 'DdnUv5yCGirFwtpWiN5PzYZfmEEFnasdxT6mfKRpFQuP', warn: 5, fail: 1 },
    { name: 'authority', address: '7sVNs9v5E3Euv5A2aeZEwmzABwc6zhDHskzqo8jz9CbA', warn: 0.02, fail: 0.005, preCreateNeed: 56.13 },
    { name: 'funder-1', address: 'DuEwqvmqj5wBxPcBbCDpfGWeHRvwzQCUCKoiG3NC8xhE', warn: 1, fail: 0.2 },
    { name: 'funder-2', address: '4c1L2BL9ht2s2rSPbPk98mkRDusCSMVSKr66QxaHDj73', warn: 1, fail: 0.2 },
    { name: 'funder-3', address: 'F9yDQanc9QeAEySSyj7Tfk6L13xJ8MSasbUynUpwCBz4', warn: 1, fail: 0.2 },
    { name: 'funder-4', address: '4sfN5RNbj49qhna6CHgeZjZ7M2EtCNdEtsiR7cPbES8N', warn: 1, fail: 0.2 },
  ],
  ports: { herald: 41140, gateway: 41130, gatewayPublic: 41133, keeper: 41150 },
});

export const STATUS_NAMES = ['Announced', 'Created', 'Seeded', 'Running', 'Ended', 'Closed', 'Aborted'];
const LAMPORTS = 1e9;

// ---------- pure helpers (tested) ----------

/** Season account bytes → {status, statusName, genesisTs, tCreateMin, endBell, bellSecs} (frontier-abi layout/world.rs). */
export function decodeSeason(buf, now = Math.floor(Date.now() / 1000)) {
  if (!buf || buf.length < 65) return null;
  const magic = buf.subarray(0, 8).toString('latin1');
  const stored = buf[64];
  // CloseSeason shrinks the account to a 128-byte tombstone (layout/world.rs TOMBSTONE_SIZE): status only
  if (buf.length < 376) return { magic, stored, status: stored, statusName: STATUS_NAMES[stored] ?? 'Unknown', bellSecs: null, genesisTs: null, endBell: null, tCreateMin: null, size: buf.length };
  const genesisTs = Number(buf.readBigInt64LE(144));
  // Seeded with now >= genesis_ts is Running (never stored)
  const status = stored === 2 && now >= genesisTs ? 3 : stored;
  return {
    magic, stored, status, statusName: STATUS_NAMES[status] ?? 'Unknown',
    bellSecs: buf.readUInt32LE(140), genesisTs, endBell: buf.readUInt32LE(164),
    tCreateMin: Number(buf.readBigInt64LE(368)), size: buf.length,
  };
}

/** Level from a value and {warn, fail} lower bounds. */
export function lowerBound(v, { warn, fail }) {
  if (v < fail) return 'FAIL';
  if (v < warn) return 'WARN';
  return 'OK';
}

/**
 * keeper.landed (keeper-stall-investigate): how long ago keeper A's newest write LANDED, from its journal (read-only).
 * `/v1/status` needs the token, and the keeper log has no per-tick lines, so neither showed that nothing had landed
 * for 14 h (11-26 21:04 → 11-27 11:04, FAIL 0 all the while). Slots, not minutes: devnet ran ≈ 0.24 s a slot then.
 * `j` = {maxLanded, maxSent, sent} (null fields when the journal has no such row); `live` = herald live slot.
 */
export const KEEPER_LANDED_SLOTS = Object.freeze({ warn: 7_500, fail: 22_500 });
export function keeperLandedCheck(j, live) {
  if (!j) return { level: 'WARN', detail: 'keeper journal not readable' };
  if (!Number.isFinite(live)) return { level: 'WARN', detail: `no herald live slot to compare; newest landed slot ${j.maxLanded ?? 'none'}` };
  const ago = (s) => (s == null ? null : live - s);
  const landedAgo = ago(j.maxLanded);
  const sentAgo = ago(j.maxSent);
  const min = (n) => `≈${Math.round((n * 0.24) / 60)} min`;
  let level = 'OK';
  if (landedAgo == null || landedAgo > KEEPER_LANDED_SLOTS.fail) level = 'FAIL';
  else if (landedAgo > KEEPER_LANDED_SLOTS.warn) level = 'WARN';
  const landed = landedAgo == null ? 'no landed write' : `newest landed write ${landedAgo} slots ago (${min(landedAgo)})`;
  const sent = sentAgo == null ? 'no write sent' : `newest send ${sentAgo} slots ago (${min(sentAgo)})`;
  return { level, detail: `${landed}; ${sent}; ${j.sent ?? '?'} sends unresolved` };
}

/**
 * Reads {maxLanded, maxSent, sent} from the keeper journal with the sqlite3 CLI, read-only (null if unreadable).
 * A WAL reader never blocks the keeper's writes. While the keeper runs, its `-shm` exists and `mode=ro` reads in place.
 * When the keeper is stopped (a clean close removes `-wal` and `-shm`), macOS's /usr/bin/sqlite3 (3.54 "aapl") refuses
 * a read-only open of a WAL database ("unable to open database file", verify-pr281); with neither file present nothing
 * has the journal open and nothing is unflushed, so it is read again with `immutable=1` (no lock, no -shm).
 */
export function readKeeperJournal(file, run = (args) => execFileSync('sqlite3', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })) {
  if (!fs.existsSync(file)) return null;
  const q = "SELECT (SELECT max(landed_slot) FROM attempts WHERE status = 'landed'), (SELECT max(sent_slot) FROM attempts), (SELECT count(*) FROM attempts WHERE status = 'sent');";
  const read = (uri) => {
    const [l, s, n] = run(['-readonly', '-separator', ' ', uri, q]).replace(/\r?\n$/, '').split(' ');
    const num = (x) => (x === '' || x == null ? null : Number(x));
    return { maxLanded: num(l), maxSent: num(s), sent: num(n) };
  };
  try { return read(`file:${file}?mode=ro`); } catch { /* below */ }
  try {
    if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)) return null;
    return read(`file:${file}?mode=ro&immutable=1`);
  } catch { return null; }
}

/** Herald lag in slots → level (≈0.4 s a slot: 150 ≈ 1 min, 1500 ≈ 10 min). */
export function lagLevel(lag) {
  if (!Number.isFinite(lag)) return 'FAIL';
  if (lag > 1500) return 'FAIL';
  if (lag > 150) return 'WARN';
  return 'OK';
}

/** Seconds a slot for herald.lag's "≈ N s" (devnet measured 0.240 on 11-27; `--slot-s` gives a measured value). */
export const SLOT_S_DEFAULT = 0.4;

/**
 * herald-pull-chunk: herald.lag from /h/status. A herald that reports `ingest.backlog` (listed − archived) reads its
 * Clock on its own timer, so `live` stays current while it catches up: a backlog > 0 is "behind, progressing" (WARN)
 * when `ingest.lastArchivedSlot` advanced since the previous run (--state), "behind, not progressing" (FAIL) when it
 * did not, and WARN when there is no previous run to compare. No backlog (0, "unknown", or an older herald without
 * the field): the live-slot lag in slots decides, as before. → {level, note}
 */
export function heraldLag({ lag, backlog, lastArchived, prevArchived }) {
  if (Number.isFinite(backlog) && backlog > 0) {
    if (!Number.isFinite(prevArchived)) return { level: 'WARN', note: `behind: backlog ${backlog} txs, archived through slot ${lastArchived ?? '?'} (no previous run to compare)` };
    if (Number.isFinite(lastArchived) && lastArchived > prevArchived) return { level: 'WARN', note: `behind, progressing: backlog ${backlog} txs, archived through slot ${lastArchived} (+${lastArchived - prevArchived} slots since the last run)` };
    return { level: 'FAIL', note: `behind, NOT progressing: backlog ${backlog} txs, archived through slot ${lastArchived ?? '?'} (same as the last run)` };
  }
  return { level: lagLevel(lag), note: null };
}

export const LOG_PATTERNS = Object.freeze({
  fatal: /\bSTOP:|\bpanicked\b|\bpanic\b/,
  restart: /\bexited rc=|\bkeeper exited\b/,
  error: /\b(ERR|ERROR|error|Error|failed|FAIL)\b|\b429\b|Too Many Requests|rate.?limit/,
});

/** Counts of the last `n` lines of a log text. */
export function scanLog(text, n = 500) {
  const lines = text.split('\n').filter((l) => l.length > 0).slice(-n);
  const c = { lines: lines.length, fatal: 0, restart: 0, error: 0, lastFatal: null, lastError: null };
  for (const l of lines) {
    if (LOG_PATTERNS.fatal.test(l)) { c.fatal++; c.lastFatal = l; }
    if (LOG_PATTERNS.restart.test(l)) c.restart++;
    if (LOG_PATTERNS.error.test(l)) { c.error++; c.lastError = l; }
  }
  return c;
}

/** Level of a log scan: fatal → FAIL; restarts or > 10 % error lines → WARN. */
export function logLevel(c) {
  if (c.fatal > 0) return 'FAIL';
  if (c.restart > 0 || (c.lines > 0 && c.error / c.lines > 0.1)) return 'WARN';
  return 'OK';
}

/** Milestones the season driver / gateway starter / join check write to their logs, with their own timestamps. */
export const MILESTONES = Object.freeze([
  { key: 'driverCreateRun', file: 'devnet-season-driver.log', re: /operator run \(create\)/ },
  { key: 'createLanded', file: 'devnet-season-driver.log', re: /operator exit (3|0)$/ },
  { key: 'keeperStarted', file: 'devnet-season-driver.log', re: /keeper supervisor started/ },
  { key: 'gatewayStarted', file: 'devnet-season-driver.log', re: /rulesetHash [0-9a-f]{64}; starting gateway/ },
  { key: 'setupComplete', file: 'devnet-season-driver.log', re: /setup complete/ },
  { key: 'driverStop', file: 'devnet-season-driver.log', re: /STOP:/ },
  { key: 'joinCheckStart', file: 'devnet-join-check.log', re: /setup complete seen/ },
  { key: 'joinCheckDone', file: 'devnet-join-check.log', re: /join driver exit/ },
  { key: 'keeperFirstStart', file: 'devnet-keeper-a.log', re: /supervisor start pid/ },
]);

/** First line matching each milestone → {key: {at, line}} (the line's leading `YYYY-MM-DD HH:MM:SS ZZZ`). */
export function milestonesFrom(texts) {
  const out = {};
  for (const m of MILESTONES) {
    const t = texts[m.file];
    if (!t) continue;
    const line = t.split('\n').find((l) => m.re.test(l));
    if (!line) continue;
    const ts = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [A-Z]{2,5})/);
    out[m.key] = { at: ts ? ts[1] : null, line: line.slice(0, 200) };
  }
  return out;
}

/** Marker files that turn the "world creation postponed" mode on: [dir option, file name]. */
export const POSTPONED_MARKERS = Object.freeze([['runDir', 'world-postponed'], ['logs', 'devnet-create-postponed']]);

/**
 * "World creation postponed / no world yet": on with o.noWorldYet (--no-world-yet) or while a marker file exists.
 * `readFile(path)` returns the text or null. → null (default checks) or {src, reason} (reason: the marker's first line).
 */
export function postponedFrom(o, readFile) {
  for (const [opt, name] of POSTPONED_MARKERS) {
    if (!o[opt]) continue;
    const t = readFile(path.join(o[opt], name));
    if (t == null) continue;
    const reason = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    return { src: `marker ${opt === 'runDir' ? '<run-dir>' : '<logs>'}/${name}`, reason: reason.slice(0, 160) };
  }
  if (o.noWorldYet) return { src: '--no-world-yet', reason: '' };
  return null;
}

/** The marker is stale once the driver log shows a CreateSeason run: the world exists (or is being made). */
export function postponedStale(ms) {
  return Boolean(ms.driverCreateRun || ms.createLanded || ms.keeperStarted || ms.setupComplete);
}

/** CreateSeason must land within 7 days of t_create_min (frontier-abi presets::CREATE_WINDOW_SECS). */
export const CREATE_WINDOW_SECS = 7 * 86400;
const QUICKNET = Object.freeze({ genesis: 1692803367, period: 3 }); // permutation-rules frontier::clash::QUICKNET
/**
 * Until when the authority's AbortSeason returns the creation bond of a season still Announced (after it the bond is
 * burned): the genesis round time, round_time(first_round_from(t_create_min + 600 + 60)) (proc/season.rs abort_season,
 * genesis_round_time; SEED_LEAD_SECS 600, SEED_MARGIN_SECS 60).
 */
export function bondRefundDeadline(tCreateMin) {
  const t = tCreateMin + 600 + 60;
  if (t <= QUICKNET.genesis) return QUICKNET.genesis;
  return QUICKNET.genesis + Math.ceil((t - QUICKNET.genesis) / QUICKNET.period) * QUICKNET.period;
}

/** The last *.trycloudflare.com name in the tunnel log. */
export function tunnelHost(text) {
  const all = [...text.matchAll(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/g)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * A shell script run as `[/path/]zsh|bash|sh [-flags] [path/]NAME.sh [args]`. Every pattern is anchored to the
 * program being run, so a line that only mentions the name (`pgrep -f run-herald.sh`, the season driver's own
 * `pgrep -f "frontier-keeper --config …"`, `tail -f …`, an editor) is not taken for the process.
 */
const shRe = (name) => new RegExp(`^(?:\\S*\\/)?(?:ba|z|da|k)?sh(?:\\s+-\\S+)*\\s+(?:\\S*\\/)?${name}\\.sh(?:\\s|$)`);

/**
 * Processes the stack should have now, given what the logs say happened. Matched by command pattern only:
 * no PID is written here (a planned restart changes the PID; see procCheck for what counts as "restarted").
 */
export function expectedProcs(ms, joinDone, postponed = null) {
  const setup = Boolean(ms.setupComplete);
  const stop = Boolean(ms.driverStop);
  // creation postponed: nothing that makes or waits for the world is wanted; the driver must not run at all
  const pp = Boolean(postponed);
  const off = 'world creation postponed';
  return [
    { key: 'proc.season-driver', re: shRe('season-driver'), want: !setup && !stop && !pp,
      gone: setup ? 'finished (setup complete)' : pp ? `not running — expected: ${off}` : 'STOPPED (see driver log)',
      ...(pp && !setup ? { forbid: `RUNNING although ${off}: it would send CreateSeason — stop it, or remove the marker / flag if creation is on again` } : {}) },
    { key: 'proc.gateway-starter', re: shRe('gateway-starter'), want: !ms.gatewayStarted && !pp, gone: ms.gatewayStarted ? 'finished (gateway started)' : `not running — not needed: ${off}` },
    { key: 'proc.gateway-supervisor', re: shRe('run-gateway'), want: Boolean(ms.gatewayStarted), notYet: pp ? `not expected: ${off}` : 'not yet (starts once the herald has a rulesetHash, after CreateSeason)' },
    { key: 'proc.gateway', re: /^(?:\S*\/)?node(?:\s+-\S+)*\s+(?:\S*\/)?permutation-gateway\/src\/frontier\/server\.mjs\s.*--port 41130(?!\d)/, want: Boolean(ms.gatewayStarted), notYet: pp ? `not expected: ${off}` : 'not yet' },
    { key: 'proc.herald-supervisor', re: shRe('run-herald'), want: true },
    { key: 'proc.herald', re: /^(?:\S*\/)?frontier-herald\s.*--listen 127\.0\.0\.1:41140(?!\d)/, want: true },
    { key: 'proc.keeper-supervisor', re: shRe('run-keeper'), want: Boolean(ms.keeperStarted), notYet: pp ? `not expected: ${off}` : 'not yet (the driver starts it after CreateSeason)' },
    { key: 'proc.keeper', re: /^(?:\S*\/)?frontier-keeper\s+--config keeper-a\/keeper\.toml(?:\s|$)/, want: Boolean(ms.keeperStarted), notYet: pp ? `not expected: ${off}` : 'not yet' },
    { key: 'proc.join-check', re: shRe('join-check'), want: !joinDone && !stop && !pp, gone: joinDone || !pp ? 'finished' : `not running — not needed: ${off}` },
    { key: 'proc.tunnel', re: /^(?:\S*\/)?cloudflared\s+tunnel\s.*127\.0\.0\.1:41140(?!\d)/, want: true },
    { key: 'proc.caffeinate', re: /^(?:\S*\/)?caffeinate\s+-is(?:\s|$)/, want: true },
  ];
}

/** `ps -axo pid=,etime=,command=` text → [{pid, etime, cmd}]. */
export function parsePs(text) {
  return text.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), etime: m[2], cmd: m[3] }));
}

/** ps etime (`[[dd-]hh:]mm:ss`) → seconds, or null when it is not in that form. */
export function etimeSeconds(etime) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? ''));
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export const RESTART_WARN_MIN = 30;
export const OVERRIDES_FILE = 'health-procs.json';

/**
 * The optional `<run-dir>/health-procs.json`, read-only:
 *   { "restartWarnMin": 30, "procs": { "proc.herald": { "pid": 12345 }, "proc.keeper": { "pidfile": "keeper-a/keeper.pid" } } }
 * `readFile(path)` returns the text or null. → {restartWarnMin?, expect: {key: {pid, src}}, problems: [text]}.
 * A pidfile path is taken relative to the run dir; only a decimal PID is read from it.
 */
export function procOverrides(runDir, readFile) {
  const r = { expect: {}, problems: [] };
  const text = readFile(path.join(runDir, OVERRIDES_FILE));
  if (text == null) return r;
  let j;
  try { j = JSON.parse(text); } catch (e) { r.problems.push(`${OVERRIDES_FILE} is not JSON (${e.message}); ignored`); return r; }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) { r.problems.push(`${OVERRIDES_FILE} is not an object; ignored`); return r; }
  if (j.restartWarnMin != null) {
    if (Number.isFinite(j.restartWarnMin) && j.restartWarnMin >= 0) r.restartWarnMin = j.restartWarnMin;
    else r.problems.push(`restartWarnMin ${JSON.stringify(j.restartWarnMin)} is not a number >= 0; ignored`);
  }
  const isPid = (n) => Number.isSafeInteger(n) && n > 0;
  for (const [key, v] of Object.entries(j.procs && typeof j.procs === 'object' ? j.procs : {})) {
    if (v && isPid(v.pid)) r.expect[key] = { pid: v.pid, src: OVERRIDES_FILE };
    else if (v && typeof v.pidfile === 'string' && v.pidfile) {
      const t = readFile(path.resolve(runDir, v.pidfile));
      const m = /^\s*(\d{1,10})\s*$/.exec(t ?? '');
      if (m && isPid(Number(m[1]))) r.expect[key] = { pid: Number(m[1]), src: `pidfile ${v.pidfile}` };
      else r.problems.push(`${key}: pidfile ${v.pidfile} ${t == null ? 'not readable' : 'holds no PID'}; ignored`);
    } else r.problems.push(`${key}: needs "pid" (a number) or "pidfile" (a path); ignored`);
  }
  return r;
}

/**
 * One process check → {level, detail, rec}. `rec` ({pid, restarted, was}) is what --state keeps for the next run.
 * ctx (all optional):
 *   expect   {pid, src}  an expected PID from health-procs.json: any other PID is a WARN, that PID is OK at any age
 *   tracked  true when --state is in use; prev = this key's record from the previous run. Then "restarted" = the
 *            PID the previous run saw is gone (WARN on that run), and it stays a WARN until the new process is
 *            warnMin minutes old. A process first seen by this state file is not a restart.
 *   warnMin  minutes [30]. Without --state there is no previous run, so a wanted process younger than this is
 *            the WARN ("restarted or first start").
 */
export function procCheck(spec, procs, ctx = {}) {
  const { expect, tracked = false, prev, warnMin = RESTART_WARN_MIN } = ctx;
  const hits = procs.filter((p) => spec.re.test(p.cmd) && !/^\S*(?:grep|pkill)\s|health\.mjs/.test(p.cmd));
  if (hits.length === 0) {
    if (spec.want) return { level: 'FAIL', detail: 'not running', rec: prev };
    return { level: 'OK', detail: spec.gone && !spec.notYet ? spec.gone : (spec.notYet ?? 'not running (not expected)'), rec: prev };
  }
  const known = [expect?.pid, prev?.pid].filter(Boolean);
  const p = known.map((pid) => hits.find((h) => h.pid === pid)).find(Boolean) ?? hits[0];
  const rest = hits.filter((h) => h !== p);
  const more = rest.length ? ` (+${rest.length} more: ${rest.map((h) => h.pid).join(',')})` : '';
  const up = etimeSeconds(p.etime);
  const young = up != null && up < warnMin * 60;
  const age = up == null ? '' : `${Math.floor(up / 60)} min ago`;
  const here = `pid ${p.pid} up ${p.etime}`;
  const sameAsPrev = prev?.pid === p.pid;
  const rec = { pid: p.pid, restarted: sameAsPrev ? Boolean(prev.restarted) : Boolean(tracked && prev?.pid), ...(sameAsPrev ? (prev.was ? { was: prev.was } : {}) : (prev?.pid ? { was: prev.pid } : {})) };
  if (spec.forbid) return { level: 'FAIL', detail: `${here} — ${spec.forbid}${more}`, rec };
  if (!spec.want) return { level: 'OK', detail: `${here} (still running)${more}`, rec };
  if (expect) {
    if (p.pid === expect.pid) return { level: 'OK', detail: `${here} (expected pid, ${expect.src})${more}`, rec };
    return { level: 'WARN', detail: `${here} — expected pid ${expect.pid} (${expect.src}) (restarted)${more}`, rec };
  }
  if (tracked) {
    if (prev?.pid && !sameAsPrev) return { level: 'WARN', detail: `${here} — was ${prev.pid} at the previous run (restarted)${more}`, rec };
    if (sameAsPrev && prev.restarted && young) return { level: 'WARN', detail: `${here} — restarted ${age}${prev.was ? `, was ${prev.was}` : ''} (WARN until ${warnMin} min old)${more}`, rec };
    return { level: 'OK', detail: `${here}${more}`, rec };
  }
  if (young) return { level: 'WARN', detail: `${here} — started ${age} (restarted or first start; WARN until ${warnMin} min old)${more}`, rec };
  return { level: 'OK', detail: `${here}${more}`, rec };
}

/** Season phase vs the clock → {level, detail}. */
export function phaseCheck(season, now, ms, postponed = null) {
  if (!season) return { level: 'FAIL', detail: 'Season account not read' };
  const t = season.tCreateMin || DEPLOY.createAt;
  const mins = (now - t) / 60;
  const at = `CreateSeason opens ${jst(t)} (${mins < 0 ? `in ${fmtDur(-mins)}` : `${fmtDur(mins)} ago`})`;
  const s = season.statusName;
  if (postponed) {
    const rel = (u) => (u > now ? `in ${fmtDur((u - now) / 60)}` : `${fmtDur((now - u) / 60)} ago`);
    if (s === 'Announced') {
      const bond = bondRefundDeadline(t);
      const end = t + CREATE_WINDOW_SECS;
      const bondTxt = now < bond
        ? `AbortSeason returns the creation bond only before ${jst(bond)} (${rel(bond)})`
        : `the creation bond is no longer returned by AbortSeason (deadline was ${jst(bond)})`;
      if (now >= end) return { level: 'WARN', detail: `Announced, creation postponed, and the create window closed ${jst(end)} (${rel(end)}): this announcement can no longer be created, a new AnnounceSeason is needed; ${bondTxt}` };
      return { level: 'OK', detail: `Announced, creation postponed (CreateSeason not sent on purpose; it opened / opens ${jst(t)}, ${rel(t)}); it can still land until ${jst(end)} (${rel(end)}); ${bondTxt}` };
    }
    if (s === 'Aborted') return { level: 'OK', detail: 'Aborted (announcement cancelled); no world yet, creation postponed — a new AnnounceSeason comes first' };
    if (s === 'Created' || s === 'Seeded' || s === 'Running') {
      const d = phaseCheck(season, now, ms);
      return { level: d.level === 'FAIL' ? 'FAIL' : 'WARN', detail: `${d.detail} — but creation is marked postponed (${postponed.src}): the world exists, remove the marker / flag` };
    }
  }
  if (s === 'Announced') {
    if (mins > 15) return { level: 'FAIL', detail: `Announced, ${at}: CreateSeason has not landed` };
    return { level: 'OK', detail: `Announced (waiting), ${at}` };
  }
  if (s === 'Created') {
    if (mins > 45) return { level: 'FAIL', detail: `Created, ${at}: keeper A has not seeded the genesis round (expected ≈21 min after)` };
    if (mins > 30) return { level: 'WARN', detail: `Created, ${at}: genesis seed late` };
    return { level: 'OK', detail: `Created, ${at}; keeper A seeds the genesis ≈21 min after` };
  }
  if (s === 'Seeded' || s === 'Running') {
    const gen = `genesis ${jst(season.genesisTs)}`;
    if (!ms.setupComplete && mins > 60) return { level: 'WARN', detail: `${s}, ${gen}, but the driver has not logged "setup complete" (WideSetRules)` };
    return { level: 'OK', detail: `${s}, ${gen}${ms.setupComplete ? ', WideSetRules done (joinable)' : ', WideSetRules pending'}` };
  }
  if (s === 'Ended' || s === 'Closed') return { level: 'WARN', detail: `${s}` };
  return { level: 'FAIL', detail: `status ${season.stored} (${s})` };
}

export function jst(unix) {
  const d = new Date((unix + 9 * 3600) * 1000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} JST`;
}
function fmtDur(mins) {
  if (mins < 90) return `${Math.round(mins)} min`;
  return `${(mins / 60).toFixed(1)} h`;
}

/** Rewrite FILE's first line as an ALERT line (or update an existing one); keeps the rest. */
export function alertedReport(text, { failing, runAt, overall }) {
  const lines = text.split('\n');
  const has = lines[0]?.startsWith('ALERT');
  if (failing.length === 0 && !has) return text;
  let prevFail = '';
  if (has) {
    const m = lines[0].match(/last failing run (.*?): (.*?) — latest run/);
    if (m) prevFail = `last failing run ${m[1]}: ${m[2]}`;
    lines.shift();
  }
  const failPart = failing.length ? `last failing run ${runAt}: ${failing.join(', ')}` : prevFail;
  const line = `ALERT (devnet-health) ${failPart} — latest run ${runAt} ${overall} (see logs/devnet-health.log)`;
  return [line, ...lines].join('\n');
}

// ---------- I/O ----------

function parseArgs(argv) {
  const home = os.homedir();
  const o = {
    rpc: true, public: true, json: false, state: null, report: null, logLines: 500, timeline: false,
    runDir: path.join(home, 'wylls-devnet-run'), logs: path.join(home, 'Projects/wylls-grok-state/logs'), rpcGapMs: 1100,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    if (k === '--no-rpc') o.rpc = false;
    else if (k === '--no-public') o.public = false;
    else if (k === '--json') o.json = true;
    else if (k === '--timeline') o.timeline = true;
    else if (k === '--no-world-yet') o.noWorldYet = true;
    else if (k === '--state') o.state = v();
    else if (k === '--report') o.report = v();
    else if (k === '--log-lines') o.logLines = Number(v());
    else if (k === '--run-dir') o.runDir = v();
    else if (k === '--restart-warn-min') { o.restartWarnMin = Number(v()); if (!(o.restartWarnMin >= 0)) throw new Error('--restart-warn-min needs a number >= 0'); }
    else if (k === '--logs') o.logs = v();
    else if (k === '--rpc-gap-ms') o.rpcGapMs = Math.max(1000, Number(v()));
    else if (k === '--slot-s') { o.slotS = Number(v()); if (!(o.slotS > 0 && o.slotS < 10)) throw new Error('--slot-s needs seconds a slot (0 < S < 10)'); }
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0]); process.exit(0); }
    else throw new Error(`unknown option ${k}`);
  }
  return o;
}

/** A devnet-only, read-only, rate-limited JSON-RPC caller (fetchFn: tests only; the URL stays devnet). */
export function makeRpc({ url = DEVNET_RPC, gapMs = 1100, fetchFn = fetch } = {}) {
  if (url !== DEVNET_RPC) throw new Error('health.mjs reads only https://api.devnet.solana.com');
  let last = 0;
  let calls = 0;
  const call = async (method, params = []) => {
    if (!RPC_METHODS.includes(method)) throw new Error(`method ${method} is not on the read-only list`);
    const wait = last + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    calls++;
    const r = await fetchFn(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${j.error.code} ${j.error.message}`);
    return j.result;
  };
  return { call, count: () => calls };
}

async function getJson(url, ms = 8000) {
  const t0 = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'devnet-health' } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body, text, ms: Date.now() - t0 };
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** The last `bytes` of a file (logs can be large). */
function tailText(p, bytes = 400_000) {
  try {
    const fd = fs.openSync(p, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return null; }
}

/**
 * All checks → {at, out: [{level, key, detail}], ms, season}. `o` is parseArgs's result; tests may also pass
 * ports, joinResult (path), psText, dfText, rpcFetch (a fake fetch for makeRpc), publicScheme and now.
 */
export async function runChecks(o) {
  const out = [];
  const add = (level, key, detail) => out.push({ level, key, detail });
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const P = o.ports ?? DEPLOY.ports;

  // logs and milestones (head of the small driver logs, so the first line wins)
  const texts = {};
  for (const m of MILESTONES) if (!(m.file in texts)) texts[m.file] = readText(path.join(o.logs, m.file));
  const ms = milestonesFrom(texts);
  const joinResult = readText(o.joinResult ?? path.join(os.homedir(), 'Projects/wylls-grok-state/evidence/devnet-deploy-2/join-check/result.json'));
  const joinDone = Boolean(ms.joinCheckDone) || Boolean(joinResult);

  // "world creation postponed / no world yet": flag or marker; stale once the driver log shows the world being made
  const marked = postponedFrom(o, readText);
  const postponed = marked && !postponedStale(ms) ? marked : null;
  if (postponed) add('OK', 'world.creation', `postponed, no world yet (${postponed.src}${postponed.reason ? `: ${postponed.reason}` : ''}): driver / gateway / keeper A are not expected`);
  else if (marked) add('WARN', 'world.creation', `marked postponed (${marked.src}) but the driver log shows CreateSeason was run: default checks apply — remove the marker / flag`);

  // processes
  let procs = [];
  try { procs = parsePs(o.psText ?? execFileSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 })); }
  catch (e) { add('FAIL', 'proc.ps', `ps failed: ${e.message}`); }
  // "restarted" is judged against the previous run (--state) or the process's age, never a PID written in this file
  const prevState = o.prevState ?? (o.state ? JSON.parse(readText(o.state) ?? '{}') : null);
  const ov = procOverrides(o.runDir, readText);
  if (ov.problems.length) add('WARN', 'proc.overrides', ov.problems.join('; '));
  const warnMin = o.restartWarnMin ?? ov.restartWarnMin ?? RESTART_WARN_MIN;
  const procState = {};
  for (const spec of expectedProcs(ms, joinDone, postponed)) {
    const r = procCheck(spec, procs, { expect: ov.expect[spec.key], tracked: prevState != null, prev: prevState?.procs?.[spec.key], warnMin });
    add(r.level, spec.key, r.detail);
    if (r.rec) procState[spec.key] = r.rec;
  }

  // RPC (read-only): genesis first, then slot, season account, balances
  let rpcSlot = null;
  let season = null;
  if (o.rpc) {
    const rpc = makeRpc({ gapMs: o.rpcGapMs ?? 1100, ...(o.rpcFetch ? { fetchFn: o.rpcFetch } : {}) });
    try {
      const g = await rpc.call('getGenesisHash');
      if (g !== DEVNET_GENESIS) { add('FAIL', 'rpc.genesis', `genesis ${g} is not devnet: no further RPC`); throw new Error('stop'); }
      add('OK', 'rpc.genesis', 'devnet');
      rpcSlot = await rpc.call('getSlot', [{ commitment: 'confirmed' }]);
      const a = await rpc.call('getAccountInfo', [DEPLOY.season, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 384 } }]);
      if (!a.value) add('FAIL', 'season.account', 'Season PDA not found');
      else {
        season = decodeSeason(Buffer.from(a.value.data[0], 'base64'), now);
        if (a.value.owner !== DEPLOY.program) add('FAIL', 'season.account', `owner ${a.value.owner} is not the program`);
      }
      const pre = !season || season.status === 0;
      for (const w of DEPLOY.wallets) {
        const lam = (await rpc.call('getBalance', [w.address, { commitment: 'confirmed' }])).value;
        const sol = lam / LAMPORTS;
        let lv = lowerBound(sol, w);
        let note = `< ${w.warn} WARN, < ${w.fail} FAIL`;
        if (w.preCreateNeed && pre && !postponed) { lv = sol < w.preCreateNeed ? 'WARN' : 'OK'; note = `CreateSeason needs ≈${w.preCreateNeed}`; }
        else if (w.preCreateNeed && postponed) note += `; creation postponed, CreateSeason will need ≈${w.preCreateNeed}`;
        if (w.name === 'deployer' && sol < 21.9) note += '; a program upgrade needs ≈21.9 free (faucet top-up first)';
        add(lv, `balance.${w.name}`, `${sol.toFixed(6)} SOL ${w.address.slice(0, 8)}… (${note})`);
      }
    } catch (e) {
      if (e.message !== 'stop') add('WARN', 'rpc', `devnet RPC read failed: ${e.message}`);
    }
    add('OK', 'rpc.calls', `${rpc.count()} read-only calls`);
    const ph = phaseCheck(season, now, ms, postponed);
    add(ph.level, 'season.phase', ph.detail);
  }

  // herald
  try {
    const s = await getJson(`http://127.0.0.1:${P.herald}/h/season`);
    if (s.body?.code === 'NoSeasonYet') add(season && season.status >= 1 ? 'WARN' : 'OK', 'herald.season', `NoSeasonYet (${s.ms} ms)${season && season.status >= 1 ? ' but the chain says ' + season.statusName : ''}`);
    else if (s.status === 200 && s.body) add('OK', 'herald.season', `${s.body.statusName ?? '?'}; rings ${s.body.rings?.length ?? 0}, ringsOpened ${s.body.ringsOpened ?? '?'}, rMax ${s.body.rMax ?? '?'}, ruleset ${String(s.body.rulesetHash ?? '').slice(0, 12)}… (${s.ms} ms)`);
    else add('FAIL', 'herald.season', `HTTP ${s.status} ${s.text.slice(0, 120)}`);
  } catch (e) { add('FAIL', 'herald.season', `no answer: ${e.message}`); }
  let heraldLive = NaN;
  let heraldRec = null;
  try {
    const s = await getJson(`http://127.0.0.1:${P.herald}/h/status`);
    if (s.status !== 200 || !s.body) add('FAIL', 'herald.status', `HTTP ${s.status}`);
    else {
      const b = s.body;
      const alarms = Object.entries(b.alarms ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
      const ingest = b.ingest ?? {};
      const lvl = alarms.length || ingest.state !== 'ok' || ingest.failures ? 'WARN' : 'OK';
      add(lvl, 'herald.status', `ingest ${ingest.state}${ingest.failures ? ` failures ${ingest.failures}` : ''}${ingest.error ? ` error ${String(ingest.error).slice(0, 80)}` : ''}; events ${b.events}, provinces ${b.provinces}, ws open ${b.ws?.open ?? 0}; alarms ${alarms.length ? alarms.join(' ') : 'none'}`);
      const live = Array.isArray(b.live) ? Number(b.live[0]) : NaN;
      heraldLive = live;
      const backlog = typeof ingest.backlog === 'number' ? ingest.backlog : NaN;
      const lastArchived = typeof ingest.lastArchivedSlot === 'number' ? ingest.lastArchivedSlot : NaN;
      if (Number.isFinite(lastArchived)) heraldRec = { lastArchivedSlot: lastArchived };
      const slotS = o.slotS ?? SLOT_S_DEFAULT;
      const hl = heraldLag({ lag: rpcSlot != null ? rpcSlot - live : NaN, backlog, lastArchived, prevArchived: prevState?.herald?.lastArchivedSlot });
      const tail = hl.note ? `; ${hl.note}` : '';
      if (rpcSlot != null) {
        const lag = rpcSlot - live;
        add(hl.level, 'herald.lag', `herald live slot ${live}, rpc ${rpcSlot}, lag ${lag} slots (≈${Math.round(lag * slotS)} s at ${slotS} s/slot)${tail}`);
      } else add(hl.note ? hl.level : 'OK', 'herald.lag', `herald live slot ${live} (no RPC slot to compare)${tail}`);
    }
  } catch (e) { add('FAIL', 'herald.status', `no answer: ${e.message}`); }

  // gateway (public listener; the herald's /gw/ forwards to it)
  if (ms.gatewayStarted) {
    try {
      const g = await getJson(`http://127.0.0.1:${P.gatewayPublic}/f/season`);
      add(g.status === 200 ? 'OK' : 'FAIL', 'gateway.health', `GET :${P.gatewayPublic}/f/season HTTP ${g.status} (${g.ms} ms)${g.status === 200 ? '' : ' ' + g.text.slice(0, 120)}`);
    } catch (e) { add('FAIL', 'gateway.health', `no answer on :${P.gatewayPublic}: ${e.message}`); }
  } else add('OK', 'gateway.health', postponed ? 'not started: world creation postponed' : 'not started yet (starts after CreateSeason)');

  // keeper A: the token is not ours to read → 401 without it means the API is up
  if (ms.keeperStarted) {
    try {
      const k = await getJson(`http://127.0.0.1:${P.keeper}/v1/status`, 5000);
      add(k.status === 401 ? 'OK' : 'WARN', 'keeper.api', `/v1/status without token → HTTP ${k.status}${k.status === 401 ? ' (API up; duties/rent/lag need the token, read from the log below)' : ''}`);
    } catch (e) { add('FAIL', 'keeper.api', `no answer on :${P.keeper}: ${e.message}`); }
    const kl = keeperLandedCheck(o.keeperJournal !== undefined ? o.keeperJournal : readKeeperJournal(path.join(o.runDir, 'keeper-a', 'keeper.journal.sqlite')), heraldLive);
    add(kl.level, 'keeper.landed', kl.detail);
  } else {
    add('OK', 'keeper.api', postponed ? 'not started: world creation postponed' : 'not started yet (the driver starts it after CreateSeason)');
    add('OK', 'keeper.landed', postponed ? 'not expected: world creation postponed' : 'not started yet (the driver starts keeper A after CreateSeason)');
  }

  // tunnel name vs the herald's public host, and the public URL from outside (Cloudflare edge)
  const host = (readText(path.join(o.runDir, 'public-host')) ?? '').trim();
  const tlog = tailText(path.join(o.logs, 'devnet-tunnel.log')) ?? '';
  const th = tunnelHost(tlog);
  if (!host) add('FAIL', 'tunnel.host', 'no public-host file');
  else if (th && th !== host) add('FAIL', 'tunnel.host', `tunnel now serves ${th} but the herald allows ${host}: the tunnel restarted, the public URL changed`);
  else add('OK', 'tunnel.host', `${host}`);
  if (o.public && host) {
    const base = `${o.publicScheme ?? 'https'}://${host}`;
    try {
      const p = await getJson(`${base}/frontier/frontier/`, 15000);
      add(p.status === 200 && /<html/i.test(p.text) ? 'OK' : 'FAIL', 'public.page', `${base}/frontier/frontier/ HTTP ${p.status} (${p.ms} ms)`);
    } catch (e) { add('FAIL', 'public.page', `unreachable: ${e.message}`); }
    try {
      const p = await getJson(`${base}/h/season`, 15000);
      const ok = p.status === 200 || p.body?.code === 'NoSeasonYet';
      add(ok ? 'OK' : 'FAIL', 'public.season', `/h/season HTTP ${p.status} ${p.body?.statusName ?? p.body?.code ?? ''} (${p.ms} ms)`);
    } catch (e) { add('FAIL', 'public.season', `unreachable: ${e.message}`); }
  }

  // join check outcome
  if (joinResult) {
    let j = null;
    try { j = JSON.parse(joinResult); } catch { /* keep null */ }
    const ok = j && (j.ok === true || j.pass === true || j.result === 'PASS' || j.joined === true);
    add(ok ? 'OK' : 'WARN', 'join.check', `result.json ${ok ? 'PASS' : 'not PASS'}: ${joinResult.replace(/\s+/g, ' ').slice(0, 160)}`);
  } else if (ms.joinCheckDone) add('WARN', 'join.check', `driver finished without result.json: ${ms.joinCheckDone.line}`);
  else add('OK', 'join.check', ms.joinCheckStart ? `running since ${ms.joinCheckStart.at}` : postponed ? 'not run: world creation postponed' : 'waiting for "setup complete"');

  // disk
  try {
    const df = (o.dfText ?? execFileSync('df', ['-k', '/System/Volumes/Data'], { encoding: 'utf8' })).trim().split('\n').pop().split(/\s+/);
    const gib = Number(df[3]) / (1024 * 1024);
    add(gib < 10 ? 'FAIL' : gib < 40 ? 'WARN' : 'OK', 'disk.free', `${gib.toFixed(1)} GiB free (< 40 WARN, < 10 FAIL)`);
  } catch (e) { add('WARN', 'disk.free', `df failed: ${e.message}`); }

  // log error rates (last N lines)
  for (const f of ['devnet-season-driver.log', 'devnet-herald.log', 'devnet-gateway.log', 'devnet-keeper-a.log', 'devnet-join-check.log', 'devnet-tunnel.log']) {
    const t = tailText(path.join(o.logs, f));
    if (t == null) { add('OK', `log.${f.replace(/^devnet-|\.log$/g, '')}`, 'no log yet'); continue; }
    const c = scanLog(t, o.logLines);
    const lv = f === 'devnet-tunnel.log' && c.fatal === 0 && c.restart === 0 && c.error / Math.max(1, c.lines) <= 0.3 ? 'OK' : logLevel(c);
    const last = c.lastFatal ?? c.lastError;
    add(lv, `log.${f.replace(/^devnet-|\.log$/g, '')}`, `last ${c.lines} lines: ${c.error} error, ${c.restart} restart, ${c.fatal} fatal${last ? ` | ${last.slice(0, 140)}` : ''}`);
  }

  return { at: now, out, ms, season, procs: procState, postponed, herald: heraldRec };
}

export function overallOf(out) {
  const n = { OK: 0, WARN: 0, FAIL: 0 };
  for (const r of out) n[r.level]++;
  return { level: n.FAIL ? 'FAIL' : n.WARN ? 'WARN' : 'OK', n };
}

/** Merge first-seen milestone times into the state file. */
export function mergeState(state, { at, ms, season, procs, postponed, herald }) {
  const s = { ...state, firstSeen: { ...(state.firstSeen ?? {}) }, fromLogs: { ...(state.fromLogs ?? {}) } };
  if (procs) s.procs = { ...(state.procs ?? {}), ...procs };
  // herald-pull-chunk: the archive's newest slot, so the next run can tell "progressing" from "stuck"
  if (herald) s.herald = { ...herald, at: jst(at) };
  const seen = (k) => { if (!s.firstSeen[k]) s.firstSeen[k] = jst(at); };
  if (season) {
    seen(`status:${season.statusName}`);
    if (season.status >= 2 && season.genesisTs != null) s.genesisTs = jst(season.genesisTs);
  }
  for (const [k, v] of Object.entries(ms)) if (!s.fromLogs[k]) s.fromLogs[k] = v.at;
  // creation postponed: first run that saw it, and the first run that no longer did
  if (postponed) s.postponed = { since: state.postponed && !state.postponed.until ? state.postponed.since : jst(at), src: postponed.src, reason: postponed.reason };
  else if (state.postponed && !state.postponed.until) s.postponed = { ...state.postponed, until: jst(at) };
  s.lastRun = jst(at);
  return s;
}

export function timelineText(state, postponedNow = null) {
  // a flag / marker seen only now (postponedNow) does not count once the logs in the state show the world being made (stale marker)
  const pp = state.postponed && !state.postponed.until ? state.postponed : (postponedStale(state.fromLogs ?? {}) ? null : postponedNow);
  const L = [`last run ${state.lastRun ?? '-'}`];
  if (pp) L.push(`world creation POSTPONED, no world yet (${pp.since ? `first seen ${pp.since} by this monitor; ` : ''}${pp.src}${pp.reason ? `: ${pp.reason}` : ''}); CreateSeason was scheduled to open ${jst(DEPLOY.createAt)} — not sent`);
  else L.push(`scheduled CreateSeason opens ${jst(DEPLOY.createAt)} (driver sends at +90 s)`);
  if (state.postponed?.until) L.push(`creation was postponed ${state.postponed.since} → ${state.postponed.until} (as seen by this monitor)`);
  for (const [k, v] of Object.entries(state.fromLogs ?? {})) L.push(`log   ${k.padEnd(18)} ${v}`);
  for (const [k, v] of Object.entries(state.firstSeen ?? {})) L.push(`chain ${k.padEnd(18)} first seen ${v} (by this monitor; ±1 poll)`);
  if (state.genesisTs) L.push(`chain genesisTs          ${state.genesisTs}`);
  return L.join('\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.timeline) {
    const st = o.state ? JSON.parse(readText(o.state) ?? '{}') : {};
    console.log(timelineText(st, postponedFrom(o, readText)));
    return 0;
  }
  const r = await runChecks(o);
  const ov = overallOf(r.out);
  const stamp = jst(r.at);
  if (o.json) console.log(JSON.stringify({ at: stamp, overall: ov, checks: r.out }));
  else {
    for (const c of r.out) console.log(`${stamp} ${c.level.padEnd(4)} ${c.key.padEnd(24)} ${c.detail}`);
    console.log(`${stamp} overall ${ov.level} (ok ${ov.n.OK} warn ${ov.n.WARN} fail ${ov.n.FAIL})`);
  }
  if (o.state) {
    const st = mergeState(JSON.parse(readText(o.state) ?? '{}'), r);
    fs.writeFileSync(o.state, JSON.stringify(st, null, 2) + '\n');
  }
  if (o.report) {
    const t = readText(o.report);
    if (t != null) {
      const failing = r.out.filter((c) => c.level === 'FAIL').map((c) => c.key);
      const nt = alertedReport(t, { failing, runAt: stamp, overall: ov.level });
      if (nt !== t) fs.writeFileSync(o.report, nt);
    }
  }
  return ov.level === 'FAIL' ? 2 : ov.level === 'WARN' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), (e) => { console.error(`health.mjs: ${e.stack ?? e}`); process.exit(2); });
}
