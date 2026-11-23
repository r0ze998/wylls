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
// answers 401 without a token" plus its log. Devnet RPC (owner approval B5): only
// getGenesisHash / getSlot / getBalance / getAccountInfo, only to
// https://api.devnet.solana.com (never mainnet), one call per --rpc-gap-ms
// (default 1100), the genesis hash checked before any other call.
//
// usage: node scripts/devnet/health.mjs [--no-rpc] [--no-public] [--json]
//          [--state FILE] [--report FILE] [--log-lines N] [--run-dir DIR] [--logs DIR]
//   --state FILE   remember the first time each milestone was seen (CreateSeason,
//                  Seeded, Running, keeper start, WideSetRules, join check) across runs
//   --report FILE  keep an `ALERT …` line at the top of FILE while/after a check fails
//   --timeline     print the milestone timeline from --state and exit
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
  season: 'HgP9VNZJnWGECaT1ubc8FSJdkUrWNsSG7MuKp8u5jSXk',
  createAt: 1795516707, // CreateSeason opens (t_create_min), 2026-11-24 19:38:27 JST; the driver sends at +90 s
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
  if (!buf || buf.length < 376) return null;
  const magic = buf.subarray(0, 8).toString('latin1');
  const stored = buf[64];
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

/** Herald lag in slots → level (≈0.4 s a slot: 150 ≈ 1 min, 1500 ≈ 10 min). */
export function lagLevel(lag) {
  if (!Number.isFinite(lag)) return 'FAIL';
  if (lag > 1500) return 'FAIL';
  if (lag > 150) return 'WARN';
  return 'OK';
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

/** The last *.trycloudflare.com name in the tunnel log. */
export function tunnelHost(text) {
  const all = [...text.matchAll(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/g)];
  return all.length ? all[all.length - 1][1] : null;
}

/** Processes the stack should have now, given what the logs say happened. */
export function expectedProcs(ms, joinDone) {
  const setup = Boolean(ms.setupComplete);
  const stop = Boolean(ms.driverStop);
  return [
    { key: 'proc.season-driver', re: /season-driver\.sh/, want: !setup && !stop, pid: 92587, gone: setup ? 'finished (setup complete)' : 'STOPPED (see driver log)' },
    { key: 'proc.gateway-starter', re: /gateway-starter\.sh/, want: !ms.gatewayStarted, pid: 95878, gone: 'finished (gateway started)' },
    { key: 'proc.gateway-supervisor', re: /run-gateway\.sh/, want: Boolean(ms.gatewayStarted), notYet: 'not yet (starts once the herald has a rulesetHash, after CreateSeason)' },
    { key: 'proc.gateway', re: /permutation-gateway\/src\/frontier\/server\.mjs.*--port 41130/, want: Boolean(ms.gatewayStarted), notYet: 'not yet' },
    { key: 'proc.herald-supervisor', re: /run-herald\.sh/, want: true, pid: 94338 },
    { key: 'proc.herald', re: /frontier-herald .*--listen 127\.0\.0\.1:41140/, want: true, pid: 94463 },
    { key: 'proc.keeper-supervisor', re: /run-keeper\.sh/, want: Boolean(ms.keeperStarted), notYet: 'not yet (the driver starts it after CreateSeason)' },
    { key: 'proc.keeper', re: /frontier-keeper --config keeper-a\/keeper\.toml/, want: Boolean(ms.keeperStarted), notYet: 'not yet' },
    { key: 'proc.join-check', re: /join-check\.sh/, want: !joinDone && !stop, pid: 14077, gone: 'finished' },
    { key: 'proc.tunnel', re: /cloudflared tunnel .*127\.0\.0\.1:41140/, want: true, pid: 93889 },
    { key: 'proc.caffeinate', re: /caffeinate -is/, want: true, pid: 92887 },
  ];
}

/** `ps -axo pid=,etime=,command=` text → [{pid, etime, cmd}]. */
export function parsePs(text) {
  return text.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), etime: m[2], cmd: m[3] }));
}

/** One process check → {level, detail}. */
export function procCheck(spec, procs) {
  const hits = procs.filter((p) => spec.re.test(p.cmd) && !/\bgrep\b|health\.mjs/.test(p.cmd));
  if (hits.length === 0) {
    if (spec.want) return { level: 'FAIL', detail: 'not running' };
    return { level: 'OK', detail: spec.gone && !spec.notYet ? spec.gone : (spec.notYet ?? 'not running (not expected)') };
  }
  const p = hits[0];
  const moved = spec.pid && !hits.some((h) => h.pid === spec.pid);
  const more = hits.length > 1 ? ` (+${hits.length - 1} more: ${hits.slice(1).map((h) => h.pid).join(',')})` : '';
  if (!spec.want) return { level: 'OK', detail: `pid ${p.pid} up ${p.etime} (still running)${more}` };
  if (moved) return { level: 'WARN', detail: `pid ${p.pid} up ${p.etime} — was ${spec.pid} (restarted)${more}` };
  return { level: 'OK', detail: `pid ${p.pid} up ${p.etime}${more}` };
}

/** Season phase vs the clock → {level, detail}. */
export function phaseCheck(season, now, ms) {
  if (!season) return { level: 'FAIL', detail: 'Season account not read' };
  const t = season.tCreateMin || DEPLOY.createAt;
  const mins = (now - t) / 60;
  const at = `CreateSeason opens ${jst(t)} (${mins < 0 ? `in ${fmtDur(-mins)}` : `${fmtDur(mins)} ago`})`;
  const s = season.statusName;
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
    else if (k === '--state') o.state = v();
    else if (k === '--report') o.report = v();
    else if (k === '--log-lines') o.logLines = Number(v());
    else if (k === '--run-dir') o.runDir = v();
    else if (k === '--logs') o.logs = v();
    else if (k === '--rpc-gap-ms') o.rpcGapMs = Math.max(1000, Number(v()));
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0]); process.exit(0); }
    else throw new Error(`unknown option ${k}`);
  }
  return o;
}

/** A devnet-only, read-only, rate-limited JSON-RPC caller. */
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

export async function runChecks(o) {
  const out = [];
  const add = (level, key, detail) => out.push({ level, key, detail });
  const now = Math.floor(Date.now() / 1000);
  const P = DEPLOY.ports;

  // logs and milestones (head of the small driver logs, so the first line wins)
  const texts = {};
  for (const m of MILESTONES) if (!(m.file in texts)) texts[m.file] = readText(path.join(o.logs, m.file));
  const ms = milestonesFrom(texts);
  const joinResult = readText(path.join(os.homedir(), 'Projects/wylls-grok-state/evidence/devnet-deploy-2/join-check/result.json'));
  const joinDone = Boolean(ms.joinCheckDone) || Boolean(joinResult);

  // processes
  let procs = [];
  try { procs = parsePs(execFileSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 })); }
  catch (e) { add('FAIL', 'proc.ps', `ps failed: ${e.message}`); }
  for (const spec of expectedProcs(ms, joinDone)) { const r = procCheck(spec, procs); add(r.level, spec.key, r.detail); }

  // RPC (read-only): genesis first, then slot, season account, balances
  let rpcSlot = null;
  let season = null;
  if (o.rpc) {
    const rpc = makeRpc({ gapMs: o.rpcGapMs });
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
        if (w.preCreateNeed && pre) { lv = sol < w.preCreateNeed ? 'WARN' : 'OK'; note = `CreateSeason needs ≈${w.preCreateNeed}`; }
        if (w.name === 'deployer' && sol < 21.9) note += '; a program upgrade needs ≈21.9 free (faucet top-up first)';
        add(lv, `balance.${w.name}`, `${sol.toFixed(6)} SOL ${w.address.slice(0, 8)}… (${note})`);
      }
    } catch (e) {
      if (e.message !== 'stop') add('WARN', 'rpc', `devnet RPC read failed: ${e.message}`);
    }
    add('OK', 'rpc.calls', `${rpc.count()} read-only calls`);
    const ph = phaseCheck(season, now, ms);
    add(ph.level, 'season.phase', ph.detail);
  }

  // herald
  try {
    const s = await getJson(`http://127.0.0.1:${P.herald}/h/season`);
    if (s.body?.code === 'NoSeasonYet') add(season && season.status >= 1 ? 'WARN' : 'OK', 'herald.season', `NoSeasonYet (${s.ms} ms)${season && season.status >= 1 ? ' but the chain says ' + season.statusName : ''}`);
    else if (s.status === 200 && s.body) add('OK', 'herald.season', `${s.body.statusName ?? '?'}; rings ${s.body.rings?.length ?? 0}, ringsOpened ${s.body.ringsOpened ?? '?'}, rMax ${s.body.rMax ?? '?'}, ruleset ${String(s.body.rulesetHash ?? '').slice(0, 12)}… (${s.ms} ms)`);
    else add('FAIL', 'herald.season', `HTTP ${s.status} ${s.text.slice(0, 120)}`);
  } catch (e) { add('FAIL', 'herald.season', `no answer: ${e.message}`); }
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
      if (rpcSlot != null) {
        const lag = rpcSlot - live;
        add(lagLevel(lag), 'herald.lag', `herald live slot ${live}, rpc ${rpcSlot}, lag ${lag} slots (≈${Math.round(lag * 0.4)} s)`);
      } else add('OK', 'herald.lag', `herald live slot ${live} (no RPC slot to compare)`);
    }
  } catch (e) { add('FAIL', 'herald.status', `no answer: ${e.message}`); }

  // gateway (public listener; the herald's /gw/ forwards to it)
  if (ms.gatewayStarted) {
    try {
      const g = await getJson(`http://127.0.0.1:${P.gatewayPublic}/f/season`);
      add(g.status === 200 ? 'OK' : 'FAIL', 'gateway.health', `GET :${P.gatewayPublic}/f/season HTTP ${g.status} (${g.ms} ms)${g.status === 200 ? '' : ' ' + g.text.slice(0, 120)}`);
    } catch (e) { add('FAIL', 'gateway.health', `no answer on :${P.gatewayPublic}: ${e.message}`); }
  } else add('OK', 'gateway.health', 'not started yet (starts after CreateSeason)');

  // keeper A: the token is not ours to read → 401 without it means the API is up
  if (ms.keeperStarted) {
    try {
      const k = await getJson(`http://127.0.0.1:${P.keeper}/v1/status`, 5000);
      add(k.status === 401 ? 'OK' : 'WARN', 'keeper.api', `/v1/status without token → HTTP ${k.status}${k.status === 401 ? ' (API up; duties/rent/lag need the token, read from the log below)' : ''}`);
    } catch (e) { add('FAIL', 'keeper.api', `no answer on :${P.keeper}: ${e.message}`); }
  } else add('OK', 'keeper.api', 'not started yet (the driver starts it after CreateSeason)');

  // tunnel name vs the herald's public host, and the public URL from outside (Cloudflare edge)
  const host = (readText(path.join(o.runDir, 'public-host')) ?? '').trim();
  const tlog = tailText(path.join(o.logs, 'devnet-tunnel.log')) ?? '';
  const th = tunnelHost(tlog);
  if (!host) add('FAIL', 'tunnel.host', 'no public-host file');
  else if (th && th !== host) add('FAIL', 'tunnel.host', `tunnel now serves ${th} but the herald allows ${host}: the tunnel restarted, the public URL changed`);
  else add('OK', 'tunnel.host', `${host}`);
  if (o.public && host) {
    try {
      const p = await getJson(`https://${host}/frontier/frontier/`, 15000);
      add(p.status === 200 && /<html/i.test(p.text) ? 'OK' : 'FAIL', 'public.page', `https://${host}/frontier/frontier/ HTTP ${p.status} (${p.ms} ms)`);
    } catch (e) { add('FAIL', 'public.page', `unreachable: ${e.message}`); }
    try {
      const p = await getJson(`https://${host}/h/season`, 15000);
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
  else add('OK', 'join.check', ms.joinCheckStart ? `running since ${ms.joinCheckStart.at}` : 'waiting for "setup complete"');

  // disk
  try {
    const df = execFileSync('df', ['-k', '/System/Volumes/Data'], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/);
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

  return { at: now, out, ms, season };
}

export function overallOf(out) {
  const n = { OK: 0, WARN: 0, FAIL: 0 };
  for (const r of out) n[r.level]++;
  return { level: n.FAIL ? 'FAIL' : n.WARN ? 'WARN' : 'OK', n };
}

/** Merge first-seen milestone times into the state file. */
export function mergeState(state, { at, ms, season }) {
  const s = { ...state, firstSeen: { ...(state.firstSeen ?? {}) }, fromLogs: { ...(state.fromLogs ?? {}) } };
  const seen = (k) => { if (!s.firstSeen[k]) s.firstSeen[k] = jst(at); };
  if (season) {
    seen(`status:${season.statusName}`);
    if (season.status >= 2) s.genesisTs = jst(season.genesisTs);
  }
  for (const [k, v] of Object.entries(ms)) if (!s.fromLogs[k]) s.fromLogs[k] = v.at;
  s.lastRun = jst(at);
  return s;
}

export function timelineText(state) {
  const L = [`last run ${state.lastRun ?? '-'}`, `scheduled CreateSeason opens ${jst(DEPLOY.createAt)} (driver sends at +90 s)`];
  for (const [k, v] of Object.entries(state.fromLogs ?? {})) L.push(`log   ${k.padEnd(18)} ${v}`);
  for (const [k, v] of Object.entries(state.firstSeen ?? {})) L.push(`chain ${k.padEnd(18)} first seen ${v} (by this monitor; ±1 poll)`);
  if (state.genesisTs) L.push(`chain genesisTs          ${state.genesisTs}`);
  return L.join('\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.timeline) {
    const st = o.state ? JSON.parse(readText(o.state) ?? '{}') : {};
    console.log(timelineText(st));
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
