#!/usr/bin/env node
// The playtest's health report and monitor (PT-A). Node built-ins only.
//
//   playtest-watch.mjs status [--json]   probe everything now and print it (no side effects);
//                                        exit 0 healthy, 1 an alarm is active, 2 the stack is down
//   playtest-watch.mjs tick              what the supervisor runs every 30 s: probe, write
//                                        status/status.json + history.jsonl, raise or clear the
//                                        alarm files, rotate logs, start a backup when one is due
//
// Environment (set by the shell wrappers, scripts/playtest-lib.sh):
//   PT_DATA (data root), PT_RUN (the run directory), PT_BACKUP (backup script), PT_RUN_ID
//
// Every number in the report is read from a process, a file or the chain the
// moment it is printed; the definitions of the lag figures are in
// docs/frontier/playtest/PT-A-OPS.md section 4. Nothing here reads or prints
// a secret value: tokens are read to authenticate loopback requests only.
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync, truncateSync, copyFileSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.PT_DATA ?? path.resolve(HERE, '../../../data/playtest');
const RUN_ID = process.env.PT_RUN_ID ?? 'playtest-1';
const RUN = process.env.PT_RUN ?? path.join(DATA, 'runs', RUN_ID);
const BACKUP_SCRIPT = process.env.PT_BACKUP ?? path.join(HERE, 'playtest-backup.sh');
const STATUS_DIR = path.join(DATA, 'status');
const LOGS = path.join(DATA, 'logs');

/** Thresholds (documented in PT-A-OPS.md; every one is a number you can change here). */
export const LIMITS = Object.freeze({
  tickSecs: 30,
  /** A gap between ticks this long is a suspended machine or a stopped monitor, not a stalled chain. */
  gapSecs: 100,
  /** The chain makes 2.5 slots a second; below this many per wall second over a tick the chain is stalled. */
  minSlotsPerSec: 1.0,
  /** Idle provinces are skipped in batches of 24 bells: lag up to ~27 is normal. */
  worldLagWarn: 28,
  worldLagAlarm: 36,
  anchorLagAlarm: 3,
  heraldLagSlots: 150,
  keeperPendingAlarm: 100,
  minRelayEligible: 20,
  diskWarnGB: 40,
  diskAlarmGB: 20,
  logRotateBytes: Number(process.env.PT_LOG_ROTATE_BYTES) || 64 << 20,
  logKeep: 8,
  backupEverySecs: 3600,
  backupStaleSecs: 3 * 3600,
});

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const readTrim = p => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
const fmtBytes = n => (n == null ? '?' : n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`);
const sh = (cmd, args, timeout = 6000) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };

async function getJson(url, headers = {}, ms = 4000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: String(e.cause?.code ?? e.message ?? e), ms: Date.now() - t0 };
  }
}
async function getBytes(url, ms = 5000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch { return null; }
}
async function rpc(port, method, params = []) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    return j.result ?? null;
  } catch { return null; }
}
const tcpOpen = (port, ms = 1500) => new Promise(resolve => {
  const s = net.connect({ port, host: '127.0.0.1' });
  const done = v => { s.destroy(); resolve(v); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

function psTable() {
  const out = sh('ps', ['-axo', 'pid=,ppid=,etime=,pcpu=,rss=,command=']);
  const m = new Map();
  for (const line of (out ?? '').split('\n')) {
    const x = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (x) m.set(Number(x[1]), { pid: Number(x[1]), ppid: Number(x[2]), etime: x[3], cpu: Number(x[4]), rssKB: Number(x[5]), command: x[6] });
  }
  return m;
}

/** Listeners of the given ports: `{port: [bind addresses]}` from lsof. */
function listeners(ports) {
  const out = sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']) ?? '';
  const res = Object.fromEntries(ports.map(p => [p, []]));
  let pid = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const m = /^n(.*):(\d+)$/.exec(line);
      if (m && res[Number(m[2])]) res[Number(m[2])].push({ addr: m[1], pid });
    }
  }
  return res;
}

/** `sqlite3 -readonly -json db sql` rows, or null. */
function sqlite(db, sql) {
  if (!existsSync(db)) return null;
  const out = sh('sqlite3', ['-readonly', '-json', db, sql], 5000);
  if (out == null) return null;
  try { return out.trim() ? JSON.parse(out) : []; } catch { return null; }
}

function dirBytes(p) {
  const out = sh('du', ['-sk', p], 20000);
  const k = Number((out ?? '').split(/\s+/)[0]);
  return Number.isFinite(k) && out ? k * 1024 : null;
}

const percentile = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))] : null);

/** The overview binaries of every ring: `{provinces, resolvedNext: [..]}`. */
async function overview(herald, rings) {
  const resolved = [];
  for (const ring of rings) {
    const b = await getBytes(`${herald}/h/overview/${ring}/latest.bin`);
    if (!b || b.length < 32 || b.toString('latin1', 0, 6) !== 'PSFOV1') continue;
    const n = b.readUInt16LE(18); // header: magic 8, season u64, ring u16, n u16, bell u32, slot u64
    for (let i = 0; i < n; i++) {
      const o = 32 + i * 24;
      if (o + 24 > b.length) break;
      resolved.push(b.readUInt32LE(o + 20));
    }
  }
  return resolved;
}

const KEEPERS = [['keeper-a', 'keeper-a'], ['keeper-b', 'keeper-b']];

/** Probes everything; returns the report object (no side effects). */
export async function collect({ prev = null, debounce = false } = {}) {
  const now = Date.now();
  const out = { v: 1, wall_ms: now, wall: new Date(now).toISOString(), run_id: RUN_ID, host: os.hostname(), alarms: [], warnings: [], notes: [] };
  const warn = (kind, detail) => out.warnings.push({ kind, detail });
  const state0 = readJson(path.join(RUN, 'state.json'));
  // While the stack is starting (first `up`: season setup and funding take about a minute; `resume`: the chain
  // re-executes its ledger) a closed port is news, not an alarm: for the first 15 minutes of that phase.
  const starting = !!state0 && ['setup', 'resuming'].includes(state0.phase) && now - (state0.updated_wall_ms ?? 0) < 15 * 60_000;
  // The supervisors restart a dead process within seconds, so a process or port that is down on ONE tick is a warning;
  // the same kind on two ticks in a row (the monitor's `debounce`) is an alarm. `status` (live, one look) alarms at once.
  const SOFT = /^(down:|port-closed:|supervisor-down|.*-unreachable|.*-status$|herald-lag)/;
  const seenBefore = new Set(prev?.candidates ?? []);
  out.candidates = [];
  const alarm = (kind, detail, cls = 'health') => {
    out.candidates.push(kind);
    if (starting && !/^(disk|relay-pool|gate-open|babysitter)/.test(kind)) return warn(`starting:${kind}`, detail);
    if (debounce && SOFT.test(kind) && !seenBefore.has(kind)) return warn(`once:${kind}`, `${detail} (first sighting; an alarm if it is still so in 30 s)`);
    return out.alarms.push({ kind, class: cls, detail });
  };
  const state = state0;
  if (!state) {
    out.state = 'no-run';
    out.alarms.push({ kind: 'no-run', class: 'health', detail: `no state.json in ${RUN}` });
    return out;
  }
  const ports = state.ports ?? {};
  const ps = psTable();
  out.phase = state.phase;
  out.resumes = state.resumes ?? 0;
  out.program = state.program;
  out.so_sha256 = state.so?.sha256 ?? null;
  out.gate_pubkey = state.playtest?.gate_pubkey ?? null;

  // ---- processes
  const procs = [];
  for (const [name, c] of Object.entries(state.components ?? {})) {
    const p = c.pid ? ps.get(c.pid) : null;
    const prog = path.basename(c.spec?.program ?? '');
    const alive = !!p && (p.command.includes(prog) || (name === 'relay' && p.command.includes('server.mjs')));
    procs.push({ name, pid: c.pid ?? null, alive, starts: c.starts ?? 0, up: alive ? p.etime : null, cpu: alive ? p.cpu : null, rss_mb: alive ? Math.round(p.rssKB / 1024) : null, last_exit: c.last_exit ?? null, done: !!c.done });
  }
  const sup = state.supervisor_pid ? ps.get(state.supervisor_pid) : null;
  const supAlive = !!sup && sup.command.includes('frontier-stack');
  procs.unshift({ name: 'stack-supervisor', pid: state.supervisor_pid ?? null, alive: supAlive, starts: (state.resumes ?? 0) + 1, up: supAlive ? sup.etime : null, cpu: supAlive ? sup.cpu : null, rss_mb: supAlive ? Math.round(sup.rssKB / 1024) : null });
  const babyPid = Number(readTrim(path.join(DATA, 'supervise.pid')));
  const baby = babyPid ? ps.get(babyPid) : null;
  const babyAlive = !!baby && baby.command.includes('playtest-supervise');
  procs.unshift({ name: 'babysitter', pid: babyPid || null, alive: babyAlive, up: babyAlive ? baby.etime : null });
  out.processes = procs;
  const stopped = existsSync(path.join(DATA, 'STOP'));
  out.stop_requested = stopped;
  const component = n => procs.find(p => p.name === n);
  const expected = Object.keys(state.components ?? {}).filter(n => !(n === 'bots' && component(n)?.done));
  const dead = expected.filter(n => !component(n)?.alive);
  if (!stopped) {
    if (!supAlive) alarm('supervisor-down', 'the stack supervisor is not running (the babysitter restarts it with `resume`)');
    for (const n of dead) alarm(`down:${n}`, `${n} is not running (last exit: ${component(n)?.last_exit ?? 'unknown'})`);
    if (!babyAlive) alarm('babysitter-down', 'playtest-supervise.sh is not running: nothing restarts the stack if it dies (start it with scripts/playtest-up.sh)');
  }
  // the babysitter's own caffeinate (`caffeinate -w <babysitter pid>`) holds the assertion for as long as the babysitter lives
  out.keep_awake = !!babyPid && (sh('pmset', ['-g', 'assertions']) ?? '').includes(`caffeinate asserting on behalf of Process ID ${babyPid}`);
  if (babyAlive && !out.keep_awake && !stopped) warn('keep-awake', 'no caffeinate assertion is held for the babysitter: the Mac may go to sleep (the game clock then stops)');
  const tun = [...ps.values()].find(p => /cloudflared.*tunnel/.test(p.command) && !/grep/.test(p.command));
  out.tunnel = { running: !!tun, pid: tun?.pid ?? null, url: null };
  const tlog = readTrim(path.join(LOGS, 'cloudflared.log'));
  if (tlog) {
    const m = [...tlog.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)].pop();
    out.tunnel.url = m ? m[0] : null;
  }

  // ---- ports
  const names = [['localnet', 'localnet'], ['drand-replay', 'drand-replay'], ['relay-operator', 'relay-operator'], ['relay-public', 'relay-public'], ['herald', 'herald'], ['keeper-a', 'keeper-a'], ['keeper-b', 'keeper-b'], ['bots', 'bots']];
  const portList = names.map(([, k]) => ports[k]).filter(Boolean);
  const lis = listeners(portList);
  out.ports = [];
  for (const [n, k] of names) {
    const port = ports[k];
    if (!port) continue;
    const open = await tcpOpen(port);
    const binds = (lis[port] ?? []).map(l => l.addr);
    const loopbackOnly = binds.length > 0 && binds.every(a => a === '127.0.0.1' || a === '[::1]' || a === '::1');
    out.ports.push({ name: n, port, open, bind: binds.join(',') || null, loopback_only: binds.length ? loopbackOnly : null, exposed: n === 'herald' });
    if (!stopped && !open && !(n === 'bots' && component('bots')?.done)) alarm(`port-closed:${n}`, `${n} ${port} does not accept connections`);
    if (binds.length && !loopbackOnly) alarm(`port-exposed:${n}`, `${n} ${port} listens on ${binds.join(',')}, not loopback only`);
  }

  // ---- chain, bell
  const cs = await rpc(ports.localnet, 'frontier_status');
  const season = await getJson(`http://127.0.0.1:${ports.herald}/h/season`);
  const genesis = Number(state.season?.genesis_ts ?? season.body?.genesisTs ?? 0);
  const bellSecs = Number(state.season?.bell_secs ?? season.body?.bellSecs ?? 600);
  out.chain = cs ? { slot: cs.slot, game_unix: cs.unixTimestamp, game_time: new Date(cs.unixTimestamp * 1000).toISOString(), scale: cs.scale, paused: !!cs.paused } : null;
  out.season = { id: state.season_id, genesis_ts: genesis, bell_secs: bellSecs, end_bell: state.season?.end_bell ?? null, join_close_bell: state.season?.join_close_bell ?? null,
    play_end: state.play?.play_end ?? null };
  let bellNow = null;
  if (cs && genesis > 0) {
    const dt = cs.unixTimestamp - genesis;
    bellNow = Math.floor(dt / bellSecs);
    out.bell = { now: bellNow, day: Math.floor(bellNow / 144), bell_of_day: ((bellNow % 144) + 144) % 144, genesis_in_secs: dt < 0 ? -dt : 0, into_bell_secs: ((dt % bellSecs) + bellSecs) % bellSecs };
  } else if (!cs && !stopped) alarm('chain-unreachable', `frontier-localnet ${ports.localnet} does not answer`, 'lag');
  // L1 the chain advances (not judged across a gap: a sleeping machine stops the chain too)
  out.gap = null;
  if (prev?.chain && cs && prev.wall_ms) {
    const dWall = (now - prev.wall_ms) / 1000;
    const dSlot = cs.slot - prev.chain.slot;
    out.slot_rate = dWall > 0 ? Number((dSlot / dWall).toFixed(2)) : null;
    if (dWall > LIMITS.gapSecs) {
      out.gap = { wall_secs: Math.round(dWall), slots: dSlot, game_secs: cs.unixTimestamp - prev.chain.game_unix, from: prev.wall, to: out.wall };
    } else if (!cs.paused && dWall >= 20 && out.slot_rate < LIMITS.minSlotsPerSec) {
      alarm('chain-stalled', `${dSlot} slots in ${Math.round(dWall)} s (${out.slot_rate}/s; a healthy chain makes 2.5/s)`, 'lag');
    }
  }
  if (cs?.paused) alarm('chain-paused', 'the chain is paused (frontier_pause): the game clock is stopped', 'lag');

  // ---- herald
  const hs = await getJson(`http://127.0.0.1:${ports.herald}/h/status`);
  const prog = state.program;
  const newest = cs ? await rpc(ports.localnet, 'getSignaturesForAddress', [prog, { limit: 1 }]) : null;
  const newestSlot = Array.isArray(newest) && newest[0] ? newest[0].slot : null;
  if (hs.ok && hs.body) {
    const b = hs.body;
    const foldLag = newestSlot != null && b.lastSlot != null ? Math.max(0, newestSlot - b.lastSlot) : null;
    out.herald = { ok: true, live_slot: b.live?.[0] ?? null, last_folded_slot: b.lastSlot ?? null, fold_lag_slots: foldLag, provinces: b.provinces, rings: b.rings, ws_open: b.ws?.open, ws_total: b.ws?.total, ws_dropped_slow: b.ws?.droppedSlow,
      alarms: b.alarms };
    for (const [k, v] of Object.entries(b.alarms ?? {})) if (v > 0 && ['badRecords', 'clashMismatch', 'writeErrors'].includes(k)) alarm(`herald-${k}`, `herald alarm ${k} = ${v}`);
    if (foldLag != null && foldLag > LIMITS.heraldLagSlots) {
      if ((prev?.herald?.fold_lag_slots ?? 0) > LIMITS.heraldLagSlots) alarm('herald-lag', `the herald is ${foldLag} slots (${Math.round(foldLag * 0.4)} s) behind the chain`, 'lag');
      else warn('herald-lag', `${foldLag} slots behind`);
    }
  } else {
    out.herald = { ok: false, error: hs.error ?? `http ${hs.status}` };
    if (!stopped) alarm('herald-unreachable', `herald ${ports.herald} /h/status: ${hs.error ?? hs.status}`);
  }

  // ---- world resolved bell and lag
  const rings = out.herald?.rings ?? [];
  if (bellNow != null && bellNow >= 0 && rings.length) {
    const rn = (await overview(`http://127.0.0.1:${ports.herald}`, rings)).sort((a, b) => a - b);
    if (rn.length) {
      const through = rn.map(x => x - 1); // resolved through bell (resolved_next - 1)
      const lags = through.map(x => Math.max(0, bellNow - x)).sort((a, b) => a - b);
      out.world = { provinces: rn.length, resolved_through_min: through[0], resolved_through_max: through[through.length - 1], lag_p50: percentile(lags, 0.5), lag_p99: percentile(lags, 0.99), lag_max: lags[lags.length - 1],
        lagging_over_2: lags.filter(l => l > 2).length };
      out.last_resolved_bell = through[0];
      out.lag_bells = lags[lags.length - 1];
      if (lags[lags.length - 1] > LIMITS.worldLagAlarm) alarm('world-lag', `a province is ${lags[lags.length - 1]} bells behind (the keeper skips idle provinces in 24-bell batches; > ${LIMITS.worldLagAlarm} means the skip duty is stuck)`, 'lag');
      else if (lags[lags.length - 1] > LIMITS.worldLagWarn) warn('world-lag', `${lags[lags.length - 1]} bells behind`);
    }
  }

  // ---- keepers
  out.keepers = {};
  for (const [n, k] of KEEPERS) {
    const port = ports[k];
    if (!port || !state.components?.[n]) continue;
    const tok = readTrim(path.join(RUN, n, 'keeper.token'));
    const r = await getJson(`http://127.0.0.1:${port}/v1/status`, tok ? { authorization: `Bearer ${tok}` } : {}, 4000);
    if (!r.ok || !r.body) {
      out.keepers[n] = { ok: false, error: r.error ?? `http ${r.status}`, ms: r.ms };
      if (!stopped) alarm(`${n}-status`, `${n} /v1/status: ${r.error ?? r.status}`);
      continue;
    }
    const b = r.body;
    const kk = { ok: true, ms: r.ms, slot: b.slot, bell: b.bell, pending: b.pending, alerts: b.alerts, season_status: b.season?.status, reveal_effective_n: b.pools?.reveal?.effective_n, reveal_n: b.pools?.reveal?.n,
      delay_effective_n: b.pools?.delay?.effective_n, delay_n: b.pools?.delay?.n, funders_sol: b.pools?.funders ? Number(b.pools.funders.lamports) / 1e9 : null, reveal_floor_lamports: b.pools?.reveal?.floor, delay_floor_lamports: b.pools?.delay?.floor,
      anchor_latency_p99: b.duties?.anchor_latency_slots_p99 ?? null, seed_latency_p99: b.duties?.seed_latency_slots_p99 ?? null, contested_bells: b.duties?.contested_bells?.length ?? 0, tickets_open: b.duties?.tickets_open,
      writes: Object.fromEntries(Object.entries(b.kinds ?? {}).map(([kn, v]) => [kn, { landed: v.landed, failed: v.failed, dead: v.dead }])), play: { resolves: b.play?.resolves, skips: b.play?.skips, reveals_sent: b.play?.reveals_sent, reveals_landed: b.play?.reveals_landed,
        reveals_missed: b.play?.reveals_missed, nudges_recent: b.play?.nudges_recent?.length ?? 0 } };
    out.keepers[n] = kk;
    if (kk.reveal_effective_n != null && kk.reveal_effective_n < 150 && out.bell?.now >= 0) warn(`${n}-reveal-n`, `effective reveal payers ${kk.reveal_effective_n} < 150`);
    if (kk.pending >= LIMITS.keeperPendingAlarm) alarm(`${n}-queue`, `${n} has ${kk.pending} writes pending`, 'lag');
    // alerts that mean a duty is not landing: only new ones since the last tick are news
    const dead = Object.values(kk.writes).reduce((s, v) => s + (v.dead ?? 0), 0);
    if (dead > (prev?.keepers?.[n]?.dead_total ?? dead)) warn(`${n}-dead-writes`, `${dead} dead writes (was ${prev?.keepers?.[n]?.dead_total})`);
    kk.dead_total = dead;
  }
  // journal facts (read-only): the newest anchored and resolved bells, unfinished attempts
  const jdb = path.join(RUN, 'keeper-a', 'keeper.journal.sqlite');
  const anch = sqlite(jdb, "select max(bell) as b from attempts where kind in ('anchor-multi','anchor') and status='landed'");
  const resv = sqlite(jdb, "select max(bell) as b from attempts where kind='resolve' and status='landed'");
  const open = sqlite(jdb, "select status, count(*) as n from attempts where status != 'landed' group by status");
  out.journal = { last_anchored_bell: anch?.[0]?.b ?? null, last_clash_resolved_bell: resv?.[0]?.b ?? null, not_landed: Object.fromEntries((open ?? []).map(x => [x.status, x.n])) };
  if (bellNow != null && bellNow >= 1 && out.journal.last_anchored_bell != null && bellNow - out.journal.last_anchored_bell > LIMITS.anchorLagAlarm) {
    alarm('anchor-lag', `the newest anchored bell is ${out.journal.last_anchored_bell}, ${bellNow - out.journal.last_anchored_bell} bells before the current one (beacon duty, keeper A)`, 'lag');
  }

  // ---- relay
  const tokFile = path.join(RUN, 'relay', 'operator.token');
  const optok = readTrim(tokFile);
  const pool = await getJson(`http://127.0.0.1:${ports['relay-operator']}/f/operator/pool`, optok ? { authorization: `Bearer ${optok}` } : {});
  const rs = await getJson(`http://127.0.0.1:${ports['relay-public']}/f/season`);
  out.relay = { ok: !!(pool.ok && rs.ok), invite_required: rs.body?.inviteRequired ?? null, join_gate: rs.body?.joinGate ?? null };
  if (pool.ok && pool.body) {
    out.relay.pool_sol = Number(BigInt(pool.body.total)) / 1e9;
    out.relay.pool_eligible = pool.body.eligible;
    out.relay.pool_size = pool.body.size;
    if (pool.body.eligible < LIMITS.minRelayEligible) alarm('relay-pool', `only ${pool.body.eligible} of ${pool.body.size} relay payers are above the minimum`);
  } else if (!stopped) alarm('relay-unreachable', `relay operator ${ports['relay-operator']}: ${pool.error ?? pool.status}`);
  if (rs.body && out.relay.invite_required === false && state.playtest?.gated) alarm('gate-open', 'the season is NOT invite-gated but this run was started gated');
  const ev = readEvents(path.join(RUN, 'relay', 'relay-events.jsonl'));
  out.invites = ev;

  // ---- bots
  const bh = await getJson(`http://127.0.0.1:${ports.bots}/health`, {}, 2500);
  out.bots = { ok: bh.ok, process: !!component('bots')?.alive, health: bh.body ?? null };

  // ---- disk, logs, backups
  const freeKB = Number((sh('df', ['-k', DATA]) ?? '').split('\n')[1]?.split(/\s+/)[3]);
  out.disk = { free_gb: Number.isFinite(freeKB) ? Math.round(freeKB / 1048576) : null };
  if (out.disk.free_gb != null) {
    if (out.disk.free_gb < LIMITS.diskAlarmGB) alarm('disk-low', `${out.disk.free_gb} GB free on the data volume (alarm below ${LIMITS.diskAlarmGB})`);
    else if (out.disk.free_gb < LIMITS.diskWarnGB) warn('disk-low', `${out.disk.free_gb} GB free`);
  }
  const logsDir = path.join(RUN, 'logs');
  out.logs = {};
  try { for (const f of readdirSync(logsDir)) out.logs[f] = statSync(path.join(logsDir, f)).size; } catch { /* none yet */ }
  out.sizes = { run: dirBytes(RUN), localnet: dirBytes(path.join(RUN, 'localnet')), backups: dirBytes(path.join(DATA, 'backups')) };
  const bks = listBackups();
  out.backups = { count: bks.length, last: bks.at(-1)?.name ?? null, last_age_secs: bks.length ? Math.round((now - bks.at(-1).mtime) / 1000) : null };
  if (!stopped && out.bell?.now >= 1 && (out.backups.last_age_secs == null || out.backups.last_age_secs > LIMITS.backupStaleSecs)) warn('backup-stale', `last backup ${out.backups.last_age_secs == null ? 'never' : `${Math.round(out.backups.last_age_secs / 60)} min ago`}`);
  out.load = os.loadavg().map(x => Number(x.toFixed(2)));
  out.alarm_files = { lag: existsSync(path.join(DATA, 'LAG-ALARM')), health: existsSync(path.join(DATA, 'HEALTH-ALARM')) };
  out.state = out.alarms.length ? 'ALARM' : supAlive ? 'up' : stopped ? 'stopped' : 'down';
  if (!supAlive && !stopped && !out.alarms.length) out.state = 'down';
  return out;
}

export function readEvents(file) {
  const r = { issued: {}, joined: {}, joined_by_label: {}, total_issued: 0, total_joined: 0 };
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return r; }
  const label = new Map();
  for (const l of text.split('\n')) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.event === 'invites_issued') {
      r.issued[e.label] = (r.issued[e.label] ?? 0) + e.count;
      r.total_issued += e.count;
      for (const n of e.nonces ?? []) label.set(n, e.label);
    } else if (e.event === 'join') {
      const lab = label.get(e.invite) ?? (e.invite ? 'unknown' : 'open');
      r.joined_by_label[lab] = (r.joined_by_label[lab] ?? 0) + 1;
      r.total_joined += 1;
    }
  }
  r.joined = r.joined_by_label;
  return r;
}

function listBackups() {
  try {
    return readdirSync(path.join(DATA, 'backups'), { withFileTypes: true }).filter(d => d.isDirectory() && /^\d{8}T\d{6}/.test(d.name))
      .map(d => ({ name: d.name, mtime: statSync(path.join(DATA, 'backups', d.name)).mtimeMs })).sort((a, b) => a.mtime - b.mtime);
  } catch { return []; }
}

// ------------------------------------------------------------------ the report

export function render(r) {
  const L = [];
  const yn = v => (v ? 'yes' : 'NO');
  L.push(`Wylls playtest ${r.run_id} on ${r.host}   ${r.wall}`);
  L.push(`STATE   ${r.state}${r.phase ? `   (stack phase ${r.phase}, ${r.resumes} resume${r.resumes === 1 ? '' : 's'})` : ''}${r.stop_requested ? '   STOP requested' : ''}`);
  if (r.alarms?.length) for (const a of r.alarms) L.push(`ALARM   [${a.class}] ${a.kind}: ${a.detail}`);
  if (r.warnings?.length) for (const w of r.warnings) L.push(`warn    ${w.kind}: ${w.detail}`);
  if (r.bell) {
    const b = r.bell;
    L.push(`BELL    ${b.now < 0 ? `season starts in ${Math.round(b.genesis_in_secs)} s` : `bell ${b.now} (game day ${b.day}, bell ${b.bell_of_day}/144, ${Math.round(b.into_bell_secs)} s into it)`}   season ${r.season.id}, joins close at bell ${r.season.join_close_bell}, ends at bell ${r.season.end_bell}`);
  }
  if (r.last_resolved_bell != null) L.push(`RESOLVED  every province resolved through bell ${r.world.resolved_through_min} (newest ${r.world.resolved_through_max}); lag ${r.lag_bells} bells (p50 ${r.world.lag_p50}, p99 ${r.world.lag_p99}; ${r.world.lagging_over_2} of ${r.world.provinces} provinces behind by more than 2)`);
  if (r.journal) L.push(`          last bell anchored ${r.journal.last_anchored_bell ?? '-'}; last clash resolved at bell ${r.journal.last_clash_resolved_bell ?? '-'}; attempts not landed ${JSON.stringify(r.journal.not_landed)}`);
  if (r.chain) L.push(`CHAIN   slot ${r.chain.slot}  game time ${r.chain.game_time}  scale ${r.chain.scale}${r.chain.paused ? '  PAUSED' : ''}${r.slot_rate != null ? `  ${r.slot_rate} slots/s` : ''}${r.gap ? `  [gap ${r.gap.wall_secs} s wall, ${r.gap.game_secs} s game since the last tick]` : ''}`);
  else L.push('CHAIN   unreachable');
  if (r.herald) L.push(r.herald.ok ? `HERALD  fold lag ${r.herald.fold_lag_slots ?? '?'} slots; ${r.herald.provinces} provinces in rings ${JSON.stringify(r.herald.rings)}; ${r.herald.ws_open} websockets open (${r.herald.ws_total} total, ${r.herald.ws_dropped_slow} dropped slow)` : `HERALD  unreachable: ${r.herald.error}`);
  for (const [n, k] of Object.entries(r.keepers ?? {})) {
    L.push(k.ok ? `${n.toUpperCase().padEnd(7)} pending ${k.pending}  alerts ${k.alerts}  reveal payers ${k.reveal_effective_n}/${k.reveal_n}  delay ${k.delay_effective_n}/${k.delay_n}  funders ${k.funders_sol?.toFixed(0)} SOL  anchor p99 ${k.anchor_latency_p99 ?? '-'} seed p99 ${k.seed_latency_p99 ?? '-'} slots  ${k.ms} ms  (resolves ${k.play.resolves}, skips ${k.play.skips}, reveals ${k.play.reveals_landed}/${k.play.reveals_sent}, nudges ${k.play.nudges_recent})`
      : `${n.toUpperCase().padEnd(7)} unreachable: ${k.error}`);
  }
  if (r.relay) {
    L.push(`RELAY   ${r.relay.ok ? 'ok' : 'unreachable'}  pool ${r.relay.pool_sol?.toFixed(0) ?? '?'} SOL, ${r.relay.pool_eligible ?? '?'}/${r.relay.pool_size ?? '?'} payers eligible  invite required: ${r.relay.invite_required}  gate ${r.relay.join_gate ?? '-'}`);
    const i = r.invites;
    L.push(`INVITES issued ${i.total_issued} ${JSON.stringify(i.issued)}  joins ${i.total_joined} ${JSON.stringify(i.joined_by_label)}`);
  }
  if (r.bots) L.push(`BOTS    process ${r.bots.process ? 'up' : 'DOWN'}  control ${r.bots.ok ? 'ok' : 'no answer'}${r.bots.health?.bots != null ? `  ${r.bots.health.bots} bots` : ''}`);
  L.push('PROCESSES');
  for (const p of r.processes ?? []) L.push(`  ${p.name.padEnd(17)} ${String(p.pid ?? '-').padEnd(7)} ${p.alive ? 'up' : p.done ? 'done' : 'DOWN'}${p.up ? `  ${p.up}` : ''}${p.cpu != null ? `  cpu ${p.cpu}%` : ''}${p.rss_mb != null ? `  ${p.rss_mb} MB` : ''}${p.starts > 1 ? `  starts ${p.starts}` : ''}${p.last_exit && !p.alive && !p.done ? `  last exit: ${p.last_exit}` : ''}`);
  L.push('PORTS');
  for (const p of r.ports ?? []) L.push(`  ${p.name.padEnd(15)} ${p.port}  ${p.open ? 'open' : 'CLOSED'}  ${p.bind ?? '-'}${p.exposed ? '  <- the one port the tunnel points at' : ''}${p.loopback_only === false ? '  NOT LOOPBACK ONLY' : ''}`);
  if (r.disk) L.push(`DISK    ${r.disk.free_gb ?? '?'} GB free; run dir ${fmtBytes(r.sizes?.run)} (chain ${fmtBytes(r.sizes?.localnet)}); backups ${r.backups.count} (${fmtBytes(r.sizes?.backups)}), last ${r.backups.last_age_secs == null ? 'never' : `${Math.round(r.backups.last_age_secs / 60)} min ago`}; logs ${fmtBytes(Object.values(r.logs ?? {}).reduce((a, b) => a + b, 0))}`);
  L.push(`MACHINE load ${r.load?.join(' ')}   keep-awake assertion ${yn(r.keep_awake)}   tunnel (cloudflared) ${r.tunnel?.running ? `running${r.tunnel.url ? ` ${r.tunnel.url}` : ''}` : 'not running'}`);
  L.push(`FILES   LAG-ALARM ${r.alarm_files?.lag ? 'PRESENT' : 'absent'}   HEALTH-ALARM ${r.alarm_files?.health ? 'PRESENT' : 'absent'}`);
  return L.join('\n');
}

// ------------------------------------------------------------------ tick: files, rotation, backups

function writeAtomic(p, text) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, text);
  renameSync(`${p}.tmp`, p);
}

function appendLine(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify(obj)}\n`);
}

/** Raises or clears LAG-ALARM and HEALTH-ALARM from the report's alarms; every change goes to alarms.jsonl. */
function alarmFiles(report, prev) {
  for (const [cls, file] of [['lag', 'LAG-ALARM'], ['health', 'HEALTH-ALARM']]) {
    const f = path.join(DATA, file);
    const now = report.alarms.filter(a => a.class === cls);
    const before = existsSync(f) ? readJson(f, { since: report.wall, reasons: [] }) : null;
    if (now.length) {
      const reasons = now.map(a => `${a.kind}: ${a.detail}`);
      const since = before?.since ?? report.wall;
      writeAtomic(f, `${JSON.stringify({ since, updated: report.wall, bell: report.bell?.now ?? null, game_time: report.chain?.game_time ?? null, reasons }, null, 2)}\n`);
      if (!before) appendLine(path.join(STATUS_DIR, 'alarms.jsonl'), { wall: report.wall, event: 'raised', class: cls, bell: report.bell?.now ?? null, reasons });
    } else if (before) {
      rmSync(f, { force: true });
      appendLine(path.join(STATUS_DIR, 'alarms.jsonl'), { wall: report.wall, event: 'cleared', class: cls, since: before.since, bell: report.bell?.now ?? null });
    }
  }
  void prev;
}

async function rotateLogs() {
  const dir = path.join(RUN, 'logs');
  const arch = path.join(DATA, 'logs-archive');
  let names = [];
  try { names = readdirSync(dir).filter(f => f.endsWith('.log')); } catch { return []; }
  const done = [];
  for (const f of names) {
    const p = path.join(dir, f);
    let size;
    try { size = statSync(p).size; } catch { continue; }
    if (size < LIMITS.logRotateBytes) continue;
    mkdirSync(arch, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const tmp = path.join(arch, `${f}.${stamp}`);
    // copy-truncate: the writers hold the file open with O_APPEND, so the next write lands at the new end
    copyFileSync(p, tmp);
    truncateSync(p, 0);
    await pipeline(createReadStream(tmp), createGzip(), createWriteStream(`${tmp}.gz`, { mode: 0o600 }));
    rmSync(tmp, { force: true });
    done.push({ file: f, bytes: size });
    const olds = readdirSync(arch).filter(x => x.startsWith(`${f}.`) && x.endsWith('.gz')).sort();
    for (const o of olds.slice(0, Math.max(0, olds.length - LIMITS.logKeep))) rmSync(path.join(arch, o), { force: true });
  }
  return done;
}

function maybeBackup(report) {
  if (report.state === 'no-run' || report.stop_requested) return null;
  if (report.phase !== 'running' || !report.chain) return null;
  const age = report.backups?.last_age_secs;
  if (age != null && age < LIMITS.backupEverySecs) return null;
  if (!existsSync(BACKUP_SCRIPT)) return null;
  mkdirSync(LOGS, { recursive: true });
  const log = createWriteStream(path.join(LOGS, 'backup.log'), { flags: 'a' });
  const c = spawn('bash', [BACKUP_SCRIPT], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  c.stdout.pipe(log, { end: false });
  c.stderr.pipe(log, { end: false });
  c.unref();
  return c.pid;
}

async function tick() {
  mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  const prev = readJson(path.join(STATUS_DIR, 'status.json'));
  let report;
  try { report = await collect({ prev, debounce: true }); } catch (e) { report = { v: 1, wall_ms: Date.now(), wall: new Date().toISOString(), state: 'ALARM', alarms: [{ kind: 'monitor-error', class: 'health', detail: String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ') }], warnings: [] }; }
  if (report.gap) appendLine(path.join(STATUS_DIR, 'gaps.jsonl'), report.gap);
  alarmFiles(report, prev);
  try { report.rotated = await rotateLogs(); } catch (e) { report.warnings.push({ kind: 'log-rotation', detail: String(e.message) }); }
  report.backup_started = maybeBackup(report);
  writeAtomic(path.join(STATUS_DIR, 'status.json'), `${JSON.stringify(report, null, 1)}\n`);
  appendLine(path.join(STATUS_DIR, 'history.jsonl'), { wall: report.wall, state: report.state, slot: report.chain?.slot ?? null, game_unix: report.chain?.game_unix ?? null, bell: report.bell?.now ?? null, lag: report.lag_bells ?? null,
    resolved_through: report.last_resolved_bell ?? null, pending_a: report.keepers?.['keeper-a']?.pending ?? null, pending_b: report.keepers?.['keeper-b']?.pending ?? null, fold_lag: report.herald?.fold_lag_slots ?? null,
    ws: report.herald?.ws_open ?? null, joins: report.invites?.total_joined ?? null, alarms: report.alarms.map(a => a.kind), free_gb: report.disk?.free_gb ?? null, load1: report.load?.[0] ?? null });
  return report;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'tick') {
    const r = await tick();
    process.stdout.write(`${r.wall} ${r.state} bell=${r.bell?.now ?? '-'} alarms=${r.alarms.map(a => a.kind).join(',') || 'none'}\n`);
    return;
  }
  if (cmd === 'status') {
    const prev = readJson(path.join(STATUS_DIR, 'status.json'));
    const r = await collect({ prev: prev && Date.now() - prev.wall_ms < 5 * 60_000 ? prev : null });
    if (rest.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 1)}\n`); else process.stdout.write(`${render(r)}\n`);
    process.exitCode = r.state === 'ALARM' ? 1 : r.state === 'up' ? 0 : 2;
    return;
  }
  process.stderr.write('usage: playtest-watch.mjs status [--json] | tick\n');
  process.exitCode = 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 70; });
}
void sleepMs;
