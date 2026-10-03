// One page of numbers for one rehearsal directory (PT-C): the crowd's report with the drills' freeze windows taken
// out, the drills in a table with what the crowd saw during each, CPU and memory of every process (sample.mjs),
// lag and queues from the monitor's history, and error rates.
//
//   node scripts/playtest/run-summary.mjs --run DIR [--json out.json]
//
// DIR is what scripts/playtest/rehearse.sh was given as --out. Everything is read from files that run left there:
//   crowd/crowd-events.jsonl  drills.jsonl  sys.jsonl  data/status/history.jsonl  data/status/gaps.jsonl
//   data/runs/<run>/relay/relay-events.jsonl (counts only)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { summarise, pct } from './crowd-report.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const RUN = arg('run', '');
if (!RUN) { console.error('usage: run-summary.mjs --run DIR [--json out.json]'); process.exit(2); }
const jl = f => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const events = jl(path.join(RUN, 'crowd/crowd-events.jsonl'));
const drills = jl(path.join(RUN, 'drills.jsonl'));
const sys = jl(path.join(RUN, 'sys.jsonl')).filter(r => r.procs);
const histFile = path.join(RUN, 'data/status/history.jsonl');
const hist = jl(histFile);

// ---- freeze windows (pause drills) and drill windows
const frozen = drills.filter(d => d.ev === 'pause_start').map(d => [d.t, d.t + d.minutes * 60_000]);
const crowd = summarise(events, { frozen });
const inWin = (t, w) => t >= w[0] && t <= w[1];
const winOf = d => {
  if (/^kill/.test(d.drill ?? '')) return [d.t - 45_000, d.t + 5_000];
  if (/^pause/.test(d.drill ?? '')) { const p = drills.find(x => x.ev === 'pause_start' && x.t < d.t && d.t - x.t < (d.frozenS + 600) * 1000); return p ? [p.t, d.t] : [d.t - 40 * 60_000, d.t]; }
  return [d.t - (d.ms ?? 40_000) - 5_000, d.t + 5_000];
};
const drillRows = drills.filter(d => d.ev === 'drill').map(d => {
  const w = winOf(d);
  const fails = events.filter(e => e.ev === 'http_fail_agg' && e.last >= w[0] && e.first <= w[1] && !/^GET \/h\/(province|bell)\/.* (404|ERR)/.test(e.key)); // the 404s of bell files that do not exist yet are the herald's normal NotYet answer
  const relayBad = events.filter(e => e.ev === 'relay_http' && inWin(e.t, w) && (e.status >= 500 || e.status === 0));
  const unreachable = events.filter(e => e.ev === 'visit_unreachable' && inWin(e.t, w)).length;
  const terrors = events.filter(e => e.ev === 'tester_error' && inWin(e.t, w)).length;
  const byKey = {};
  for (const e of fails) { const k = e.key.replace(/^(GET|POST) \S+ /, '$1 '); byKey[k] = (byKey[k] ?? 0) + e.n; }
  return { drill: d.drill, window: w.map(t => new Date(t).toISOString()), restart: { pidMs: d.pidMs ?? null, portMs: d.portMs ?? null, healthyMs: d.healthyMs ?? null }, chainSlotsAdvanced: d.slotAdvancedBy ?? d.slotAdvancedWhileFrozenAndAfter1min ?? null,
    frozenS: d.frozenS ?? null, alarms: d.alarmsSeen ?? (d.alarmsAfter3min ? Object.entries(d.alarmsAfter3min).filter(([, v]) => v).map(([k]) => k) : null), monitorGap: d.monitorGapLines?.[0] ?? null,
    crowdSaw: { failedRequests: Object.values(byKey).reduce((a, b) => a + b, 0), byStatus: byKey, relay5xx: relayBad.length, visitsUnreachable: unreachable, testerErrors: terrors },
    abuse: d.drill === 'abuse' ? { burstExit: d.burstExit, abuseCheckPass: d.abuseCheckPass, abuseCheckFail: d.abuseCheckFail, burst: d.burst } : undefined };
});
const drillWins = drillRows.map(r => r.window.map(Date.parse));

// ---- error rates
const relay = events.filter(e => e.ev === 'relay_http');
const outside = e => !drillWins.some(w => inWin(e.t, w));
const klass = s => (s === 0 ? 'no answer' : s >= 500 ? '5xx' : s === 429 ? '429' : s >= 400 ? '4xx (a rule, answered)' : '2xx');
const tally = xs => xs.reduce((m, x) => { m[x] = (m[x] ?? 0) + 1; return m; }, {});
const minutes = crowd.run.minutes;
const failAgg = events.filter(e => e.ev === 'http_fail_agg');
const failBy = (pred) => failAgg.filter(pred).reduce((m, e) => { const k = e.key.replace(/^(GET|POST) (\S+) (\S+).*$/, '$1 $2 $3').replace(/#[#A-Za-z]*/g, '#').slice(0, 70); m[k] = (m[k] ?? 0) + e.n; return m; }, {});
const errors = {
  relayAnswersAll: tally(relay.map(r => klass(r.status))),
  relayAnswersOutsideDrills: tally(relay.filter(outside).map(r => klass(r.status))),
  relay5xxOutsideDrills: relay.filter(e => outside(e) && (e.status >= 500 || e.status === 0)).length,
  relayRefusalsByCode: tally(relay.filter(r => r.status >= 400).map(r => `${r.status} ${r.code ?? ''}`.trim())),
  pageRequestFailuresOutsideDrills: failBy(e => !drillWins.some(w => e.last >= w[0] && e.first <= w[1]) && !/^GET \/h\/(province|bell)\/.* (404|ERR)/.test(e.key)),
  immutableFile404sOutsideDrills: failAgg.filter(e => !drillWins.some(w => e.last >= w[0] && e.first <= w[1]) && /^GET \/h\/(province|bell)\/.* 404/.test(e.key)).reduce((a, e) => a + e.n, 0),
  pageErrors: Object.fromEntries(Object.entries(crowd.errors.console).filter(([k]) => /^pageerror/.test(k)).map(([k, v]) => [k.slice(0, 260), v])),
  testerErrorsOutsideDrills: events.filter(e => e.ev === 'tester_error' && outside(e)).length,
  testerErrorsAll: crowd.errors.testerErrors,
};

// ---- system
const q = (xs, p) => pct(xs, p);
const names = [...new Set(sys.flatMap(r => Object.keys(r.procs)))].sort();
const proc = {};
for (const n of names) {
  const c = sys.filter(r => r.procs[n]).map(r => r.procs[n].cpu); const m = sys.filter(r => r.procs[n]).map(r => r.procs[n].rssMB);
  proc[n] = { cpuP50: q(c, 0.5), cpuP99: q(c, 0.99), cpuMax: Math.max(...c), rssMBP50: q(m, 0.5), rssMBMax: Math.max(...m) };
}
const tot = k => ({ cpuP50: q(sys.map(r => r[k].cpu), 0.5), cpuP99: q(sys.map(r => r[k].cpu), 0.99), cpuMax: Math.max(...sys.map(r => r[k].cpu)), rssMBP50: q(sys.map(r => r[k].rssMB), 0.5), rssMBMax: Math.max(...sys.map(r => r[k].rssMB)) });
const load = sys.map(r => r.load[0]);
const lagOf = x => x.lag ?? 0;
const h = hist.filter(x => x.state === 'up');
const system = {
  samples: sys.length, processes: proc, stackTotal: sys.length ? tot('stack') : null, crowdBrowsers: sys.length ? tot('crowd') : null,
  machineLoad1: { p50: q(load, 0.5), p99: q(load, 0.99), max: Math.max(...load, 0) },
  monitor: h.length ? { samples: h.length, bellFirst: h[0].bell, bellLast: h.at(-1).bell, lagBellsMax: Math.max(...h.map(lagOf)), lagBellsP50: q(h.map(lagOf), 0.5), foldLagSlotsMax: Math.max(...h.map(x => x.fold_lag ?? 0)), foldLagSlotsP99: q(h.map(x => x.fold_lag ?? 0), 0.99), keeperAPendingMax: Math.max(...h.map(x => x.pending_a ?? 0)), keeperBPendingMax: Math.max(...h.map(x => x.pending_b ?? 0)), alarmsRaised: [...new Set(h.flatMap(x => x.alarms ?? []))], freeGBFirst: h[0].free_gb, freeGBLast: h.at(-1).free_gb } : null,
};
const alarmsFile = jl(path.join(RUN, 'data/status/alarms.jsonl'));
system.alarmChanges = alarmsFile.length;
system.alarmChangeSample = alarmsFile.slice(0, 12).map(a => JSON.stringify(a).slice(0, 160));

// ---- relay log counts
const runDirs = existsSync(path.join(RUN, 'data/runs')) ? readdirSync(path.join(RUN, 'data/runs')) : [];
const relayLog = runDirs.length ? jl(path.join(RUN, 'data/runs', runDirs[0], 'relay/relay-events.jsonl')) : [];
const relayLines = tally(relayLog.map(l => l.event));
const compLogs = path.join(RUN, 'results/component-logs/relay.log');
const catchups = existsSync(compLogs) ? readFileSync(compLogs, 'utf8').split('\n').filter(l => /NotResident/.test(l)) : [];

const out = { run: RUN, crowd, drills: drillRows, errors, system, relayEventLog: relayLines, relayCatchups: { lines: catchups.length, sample: catchups.slice(0, 3).map(l => l.replace(/[0-9A-Za-z]{40,}/g, '<id>').slice(0, 160)) }, freezeWindows: frozen.map(f => f.map(t => new Date(t).toISOString())), crowdMinutes: minutes };
const o = arg('json', '');
if (o) writeFileSync(o, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
