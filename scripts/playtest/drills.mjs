// The drills of the playtest rehearsals (PT-C): break the stack on a schedule while the crowd plays, and write what
// happened to a JSONL file. Local only, throw-away or real run directories alike (it signals only the pids the run's
// own state.json names, plus the babysitter's pid file, never a process by name).
//
//   node scripts/playtest/drills.mjs --data DIR --run RUNID --herald 41117 --relay 41116 --relay-op 41115
//        --out drills.jsonl --plan "kill:keeper-a@20,kill:herald@30,pause:30@60,abuse@120" [--asleep-file F]
//        [--tunnel https://wylls.test:41102] [--start-ms EPOCH]
//
// A plan item is `kind@minute` (minutes after --start-ms, default now):
//   kill:<component>  `kill -9` of keeper-a | keeper-b | herald | relay | localnet | bots | drand-replay. It records the old
//                     and new pid, how long until the supervisor has started a new process (pid), until its port accepts
//                     (port), until the whole front door answers (healthy: herald /h/status 200, relay /gw/f/season 200,
//                     chain slot advancing), the chain's slot before and after, and any alarm file that appeared.
//   pause:<minutes>   the stand-in for a sleeping Mac: the "tunnel" answers 530 (the file --asleep-file, read by
//                     fake-tunnel.mjs), every process of the run (components, stack supervisor, babysitter) gets SIGSTOP for the
//                     given minutes, then SIGCONT. It records the chain's slot and the bell before and after (the game clock
//                     is the slot count, so the game must not have moved while frozen), the time until healthy, and the alarm
//                     files and the monitor's gap line.
//   abuse             an invalid-invite and junk burst through the front door (see abuse-burst.mjs) while the crowd plays;
//                     it records the burst's own result and the crowd-visible effect is read afterwards from the crowd's events.
// `kill` and `abuse` never overlap a `pause`: the plan is run in order, and an item that is late runs when the previous finished.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const DATA = arg('data', ''); const RUN = arg('run', ''); const HERALD = Number(arg('herald', 0)); const RELAY = Number(arg('relay', 0)); const OUT = arg('out', '');
const PLAN = String(arg('plan', '')).split(',').filter(Boolean).map(x => { const [k, m] = x.split('@'); return { spec: k, at: Number(m) * 60_000 }; });
const ASLEEP = arg('asleep-file', ''); const TUNNEL = arg('tunnel', ''); const START = Number(arg('start-ms', Date.now()));
if (!DATA || !RUN || !HERALD || !RELAY || !OUT || !PLAN.length) { console.error('usage: drills.mjs --data DIR --run ID --herald PORT --relay PORT --out FILE --plan "kill:keeper-a@20,..."'); process.exit(2); }
for (const p of [HERALD, RELAY]) if (!(p >= 41100 && p <= 41139)) { console.error(`port ${p} is outside 41100-41139`); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(DATA, 'runs', RUN, 'state.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (ev, d = {}) => { const l = { t: Date.now(), ev, ...d }; appendFileSync(OUT, `${JSON.stringify(l)}\n`); console.log(`[${new Date().toISOString()}] ${ev} ${JSON.stringify(d).slice(0, 220)}`); };
const state = () => JSON.parse(readFileSync(STATE, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fetchJson = async (url, ms = 4000) => { const t = Date.now(); try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return { status: r.status, ms: Date.now() - t, json: await r.json().catch(() => null) }; } catch (e) { return { status: 0, ms: Date.now() - t, err: String(e.cause?.code ?? e.message).slice(0, 40) }; } };
const portOpen = (port, ms = 400) => new Promise(res => { const s = net.connect({ host: '127.0.0.1', port }); const done = ok => { s.destroy(); res(ok); }; s.setTimeout(ms, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false)); });

async function front() {
  const [h, r] = await Promise.all([fetchJson(`http://127.0.0.1:${HERALD}/h/status`), fetchJson(`http://127.0.0.1:${RELAY}/f/season`)]);
  return { herald: h.status, relay: r.status, slot: h.json?.live?.[0] ?? null, folded: h.json?.foldedThrough ?? null, wsOpen: h.json?.ws?.open ?? null };
}
const alarms = () => ({ lag: existsSync(path.join(DATA, 'LAG-ALARM')) ? readFileSync(path.join(DATA, 'LAG-ALARM'), 'utf8').slice(0, 240) : null, health: existsSync(path.join(DATA, 'HEALTH-ALARM')) ? readFileSync(path.join(DATA, 'HEALTH-ALARM'), 'utf8').slice(0, 240) : null });
async function healthyWithin(ms, since) {
  const end = Date.now() + ms;
  let prev = (await front()).slot; // healthy = both doors answer AND the chain's slot has moved since the first look
  while (Date.now() < end) {
    const f = await front();
    if (f.herald === 200 && f.relay === 200 && f.slot != null && (prev === null || f.slot > prev)) return Date.now() - since;
    prev = f.slot ?? prev;
    await sleep(500);
  }
  return null;
}

async function killDrill(name) {
  const st = state(); const c = st.components?.[name];
  if (!c?.pid) { log('drill_skip', { drill: `kill:${name}`, why: 'no such component' }); return; }
  const before = await front(); const oldPid = c.pid; const starts = c.starts;
  const seenAlarms = new Set();
  const t0 = Date.now();
  process.kill(oldPid, 'SIGKILL');
  let newPid = null; let pidMs = null; let portMs = null; let healthyMs = null;
  const wantPort = st.ports?.[name === 'relay' ? 'relay-public' : name] ?? null;
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const c2 = state().components?.[name];
    if (newPid === null && c2?.pid && c2.pid !== oldPid && alive(c2.pid)) { newPid = c2.pid; pidMs = Date.now() - t0; }
    if (newPid !== null && portMs === null && wantPort && await portOpen(wantPort)) portMs = Date.now() - t0;
    const f = await front();
    if (newPid !== null && healthyMs === null && f.herald === 200 && f.relay === 200) healthyMs = Date.now() - t0;
    const a = alarms(); if (a.lag) seenAlarms.add('LAG'); if (a.health) seenAlarms.add('HEALTH');
    if (newPid !== null && healthyMs !== null && (portMs !== null || !wantPort)) break;
    await sleep(250);
  }
  await sleep(20_000); // let the lag settle, then look again
  const after = await front();
  const a = alarms(); if (a.lag) seenAlarms.add('LAG'); if (a.health) seenAlarms.add('HEALTH');
  const c3 = state().components?.[name];
  log('drill', { drill: `kill:${name}`, oldPid, newPid, startsBefore: starts, startsAfter: c3?.starts, pidMs, portMs, healthyMs, before, after, slotAdvancedBy: before.slot != null && after.slot != null ? after.slot - before.slot : null, alarmsSeen: [...seenAlarms], alarmsNow: a });
}

async function allPids() {
  const st = state(); const pids = new Set();
  for (const c of Object.values(st.components ?? {})) if (c.pid && alive(c.pid)) pids.add(c.pid);
  if (st.supervisor_pid && alive(st.supervisor_pid)) pids.add(st.supervisor_pid);
  const bp = path.join(DATA, 'supervise.pid');
  if (existsSync(bp)) { const p = Number(readFileSync(bp, 'utf8').replace(/\D/g, '')); if (p && alive(p)) pids.add(p); }
  // children of those (a component may fork helpers)
  const ps = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n').map(l => l.trim().split(/\s+/).map(Number));
  for (let i = 0; i < 3; i++) for (const [pid, ppid] of ps) if (pids.has(ppid)) pids.add(pid);
  return [...pids];
}

async function pauseDrill(minutes) {
  const before = await front(); const pids = await allPids();
  const gapsFile = path.join(DATA, 'status', 'gaps.jsonl'); const gapsBefore = existsSync(gapsFile) ? readFileSync(gapsFile, 'utf8').split('\n').filter(Boolean).length : 0;
  const bellBefore = (await fetchJson(`http://127.0.0.1:${HERALD}/h/status`)).json;
  if (ASLEEP) writeFileSync(ASLEEP, 'asleep\n');
  const t0 = Date.now();
  for (const p of pids) { try { process.kill(p, 'SIGSTOP'); } catch { /* gone */ } }
  log('pause_start', { minutes, pids: pids.length, before });
  await sleep(minutes * 60_000);
  for (const p of pids) { try { process.kill(p, 'SIGCONT'); } catch { /* gone */ } }
  const t1 = Date.now();
  if (ASLEEP) rmSync(ASLEEP, { force: true });
  const healthyMs = await healthyWithin(300_000, t1);
  await sleep(60_000);
  const after = await front(); const a = alarms();
  await sleep(120_000);
  const a2 = alarms(); const after2 = await front();
  const gaps = existsSync(gapsFile) ? readFileSync(gapsFile, 'utf8').split('\n').filter(Boolean).slice(gapsBefore) : [];
  log('drill', { drill: `pause:${minutes}`, frozenS: Math.round((t1 - t0) / 1000), pids: pids.length, healthyMs, before, after, after3min: after2, slotAdvancedWhileFrozenAndAfter1min: before.slot != null && after.slot != null ? after.slot - before.slot : null, expectedSlotsIfRunning1min: 150, alarmsAfter1min: a, alarmsAfter3min: a2, monitorGapLines: gaps.slice(0, 3), bellBefore: bellBefore?.live ?? null });
}

async function abuseDrill() {
  const t0 = Date.now();
  const args = [path.join(HERE, 'abuse-burst.mjs'), '--herald', `http://127.0.0.1:${HERALD}`, ...(TUNNEL ? ['--tunnel', TUNNEL] : [])];
  const out = await new Promise(res => { const p = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] }); let s = ''; p.stdout.on('data', d => { s += d; }); p.stderr.on('data', d => { s += d; }); p.on('close', code => res({ code, s })); });
  const check = await new Promise(res => { const p = spawn('node', [path.join(HERE, 'abuse-check.mjs'), '--herald', `http://127.0.0.1:${HERALD}`], { stdio: ['ignore', 'pipe', 'pipe'] }); let s = ''; p.stdout.on('data', d => { s += d; }); p.stderr.on('data', d => { s += d; }); p.on('close', code => res({ code, s })); });
  const fails = check.s.split('\n').filter(l => l.startsWith('FAIL'));
  log('drill', { drill: 'abuse', burstExit: out.code, burst: out.s.split('\n').filter(Boolean).slice(-14), abuseCheckExit: check.code, abuseCheckPass: (check.s.match(/^PASS/gm) ?? []).length, abuseCheckFail: fails, ms: Date.now() - t0, after: await front() });
}

log('plan', { start: new Date(START).toISOString(), plan: PLAN.map(p => `${p.spec}@${p.at / 60000}m`) });
for (const item of PLAN) {
  const wait = START + item.at - Date.now();
  if (wait > 0) await sleep(wait);
  const [kind, what] = item.spec.split(':');
  try {
    if (kind === 'kill') await killDrill(what);
    else if (kind === 'pause') await pauseDrill(Number(what));
    else if (kind === 'abuse') await abuseDrill();
    else log('drill_skip', { drill: item.spec, why: 'unknown kind' });
  } catch (e) { log('drill_error', { drill: item.spec, message: String(e.message).slice(0, 200) }); }
}
log('plan_done');
