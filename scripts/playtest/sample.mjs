// CPU and memory of a playtest rehearsal, sampled from `ps` (PT-C): one JSON line per interval.
//
//   node scripts/playtest/sample.mjs --state RUN/state.json --out sys.jsonl [--interval 30]
//        [--supervise-pid-file DATA/supervise.pid] [--crowd-pid PID] [--extra NAME=PID ...] [--until-file FILE]
//
// Line: {t, load:[1m,5m,15m], freeGB, procs:{name:{pid,cpu,rssMB}}, crowd:{procs,cpu,rssMB}, stack:{cpu,rssMB}}
//   procs   each component of the run (state.json: localnet, drand-replay, keeper-a, keeper-b, relay, herald, bots, plus
//           the stack supervisor and the babysitter);
//   crowd   the crowd's node process and every descendant (the headless Chromium tree);
//   cpu     `ps` %cpu: the scheduler's recent estimate of the process's CPU use, in percent of ONE core (100 = one core
//           busy; Activity Monitor's column);
//   rssMB   resident set, megabytes.
// Reads only; stops when --until-file appears or the process is killed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const STATE = arg('state', ''); const OUT = arg('out', ''); const EVERY = Number(arg('interval', 30)) * 1000;
const SUP = arg('supervise-pid-file', ''); const CROWD = Number(arg('crowd-pid', 0)); const UNTIL = arg('until-file', '');
if (!STATE || !OUT) { console.error('usage: sample.mjs --state state.json --out sys.jsonl [--interval 30] [--crowd-pid PID]'); process.exit(2); }
const extras = []; for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--extra') { const [n, p] = process.argv[i + 1].split('='); extras.push([n, Number(p)]); }

function table() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss='], { encoding: 'utf8' });
  const m = new Map();
  for (const l of out.split('\n')) { const [pid, ppid, cpu, rss] = l.trim().split(/\s+/).map(Number); if (pid) m.set(pid, { pid, ppid, cpu, rss }); }
  return m;
}
const tree = (m, root) => { const out = []; const stack = [root]; while (stack.length) { const p = stack.pop(); if (m.has(p)) out.push(m.get(p)); for (const x of m.values()) if (x.ppid === p) stack.push(x.pid); } return out; };
const sum = xs => ({ cpu: +xs.reduce((a, x) => a + x.cpu, 0).toFixed(1), rssMB: Math.round(xs.reduce((a, x) => a + x.rss, 0) / 1024) });

while (!(UNTIL && existsSync(UNTIL))) {
  try {
    const m = table();
    const procs = {};
    let st = {}; try { st = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* being rewritten */ }
    for (const [n, c] of Object.entries(st.components ?? {})) if (c.pid && m.has(c.pid)) procs[n] = { pid: c.pid, cpu: m.get(c.pid).cpu, rssMB: Math.round(m.get(c.pid).rss / 1024) };
    if (st.supervisor_pid && m.has(st.supervisor_pid)) procs['stack-supervisor'] = { pid: st.supervisor_pid, cpu: m.get(st.supervisor_pid).cpu, rssMB: Math.round(m.get(st.supervisor_pid).rss / 1024) };
    if (SUP && existsSync(SUP)) { const p = Number(readFileSync(SUP, 'utf8').replace(/\D/g, '')); if (m.has(p)) procs.babysitter = { pid: p, cpu: m.get(p).cpu, rssMB: Math.round(m.get(p).rss / 1024) }; }
    for (const [n, p] of extras) if (m.has(p)) procs[n] = { pid: p, cpu: m.get(p).cpu, rssMB: Math.round(m.get(p).rss / 1024) };
    const stackAll = Object.entries(procs).filter(([n]) => n !== 'fake-tunnel').map(([, v]) => ({ cpu: v.cpu, rss: v.rssMB * 1024 }));
    const crowd = CROWD && m.has(CROWD) ? tree(m, CROWD) : [];
    appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), load: os.loadavg().map(x => +x.toFixed(2)), freeGB: +(os.freemem() / 2 ** 30).toFixed(1), procs, stack: sum(stackAll), crowd: { procs: crowd.length, ...sum(crowd) } })}\n`);
  } catch (e) { appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), error: String(e.message).slice(0, 100) })}\n`); }
  await new Promise(r => setTimeout(r, EVERY));
}
