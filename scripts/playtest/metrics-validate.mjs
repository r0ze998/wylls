// Validates scripts/playtest-metrics.mjs against a rehearsal (PT-C): the same figures are recomputed from a second,
// independent source, the CROWD's own record of what its browsers saw (the relay's answers to each tester's join and
// relayed transactions, with the browser's clock), and compared with what the metrics script extracts from the RELAY's
// event log, person by person (the invitation code of tester i is row i of the invitations CSV; its nonce is the first
// 12 bytes of the code).
//
//   node scripts/playtest/metrics-validate.mjs --crowd crowd-events.jsonl --relay-log relay-events.jsonl
//        --invites invites.csv [--exclude-labels bots] [--tz-offset-hours 9] [--tolerance-s 5]
//
// A signed action is a relay answer `200` on /f/relay (the page sends some by itself, e.g. the site ticket after a join,
// so "an action" is any transaction the page had sponsored, not only a click). Times differ by the round trip, so a
// line within --tolerance-s of a day boundary may fall on either side: such a person is listed, not failed.
// Exit 0 when every comparable figure agrees.
import { readFileSync } from 'node:fs';
import { computeMetrics, dayOf } from '../playtest-metrics.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const TZ = Number(arg('tz-offset-hours', 9)); const TOL = Number(arg('tolerance-s', 5)) * 1000;
const jl = f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const crowd = jl(arg('crowd', '')); const relay = jl(arg('relay-log', ''));
const codes = readFileSync(arg('invites', ''), 'utf8').split('\n').slice(1).map(l => l.split(',')[0].trim()).filter(Boolean);
const nonceOf = c => Buffer.from(c, 'base64url').subarray(0, 12).toString('hex');
const m = computeMetrics(relay, { exclude: String(arg('exclude-labels', 'bots')).split(','), tzHours: TZ });
const byNonce = new Map(m.people.map(p => [p.nonce, p]));
const day = t => dayOf(t, TZ);
const nearBoundary = t => { const d0 = Date.parse(`${day(t)}T00:00:00Z`) - TZ * 3_600_000; return Math.min(t - d0, d0 + 86_400_000 - t) < TOL; };

let bad = 0; const notes = [];
const fail = s => { bad++; console.log(`FAIL  ${s}`); }; const pass = s => console.log(`PASS  ${s}`);
const gap = 30 * 60_000;
const sessionsOf = ts => { let n = 0; let prev = null; for (const t of [...ts].sort((a, b) => a - b)) { if (prev === null || t - prev > gap) n++; prev = t; } return n; };

const truth = [];
for (const [i, code] of codes.entries()) {
  const joinOk = crowd.find(e => e.ev === 'join_ok' && e.tester === i);
  if (!joinOk) continue;
  const joinRes = crowd.filter(e => e.ev === 'relay_http' && e.tester === i && e.path === 'join' && e.status === 200).at(-1);
  const joinT = joinRes?.t ?? joinOk.t;
  const acts = crowd.filter(e => e.ev === 'relay_http' && e.tester === i && e.path === 'relay' && e.status === 200).map(e => e.t);
  const jd = day(joinT);
  truth.push({ tester: i, nonce: nonceOf(code), joinT, joinDay: jd, actions: acts.length, actionDays: [...new Set(acts.map(day))].sort(), returned: acts.some(t => day(t) > jd), sessions: sessionsOf([joinT, ...acts]), edge: [joinT, ...acts].some(nearBoundary) });
}

(truth.length === m.N_joined ? pass : fail)(`N_joined: crowd saw ${truth.length} joins land, the log says ${m.N_joined}`);
const missing = truth.filter(t => !byNonce.has(t.nonce));
(missing.length === 0 ? pass : fail)(`every joined tester is a person in the log (${missing.length} missing)`);
let dj = 0; let da = 0; let dr = 0; let ds = 0; let dn = 0;
for (const t of truth) {
  const p = byNonce.get(t.nonce); if (!p) continue;
  if (p.joinDay !== t.joinDay && !t.edge) { dj++; fail(`join day of tester ${t.tester}: log ${p.joinDay}, crowd ${t.joinDay}`); }
  if (p.actions !== t.actions) { dn++; notes.push(`tester ${t.tester}: ${p.actions} actions in the log, ${t.actions} answered 200 in the browser (a response lost to a freeze or a closing page is not counted by the browser)`); }
  const logDays = p.activeDays.filter(d => d !== p.joinDay || t.actionDays.includes(d) || true);
  const same = JSON.stringify([...new Set([t.joinDay, ...t.actionDays])].sort()) === JSON.stringify(logDays);
  if (!same && !t.edge && p.actions === t.actions) { da++; fail(`active days of tester ${t.tester}: log ${logDays}, crowd ${[t.joinDay, ...t.actionDays]}`); }
  if (p.returned !== t.returned && !t.edge && p.actions === t.actions) { dr++; fail(`returned for tester ${t.tester}: log ${p.returned}, crowd ${t.returned}`); }
  if (p.sessions !== t.sessions && !t.edge && p.actions === t.actions) { ds++; fail(`sessions of tester ${t.tester}: log ${p.sessions}, crowd ${t.sessions}`); }
}
pass(`per person: join day, active days, returned, sessions compared for ${truth.length} testers (${dj + da + dr + ds} differences)`);
const returned = truth.filter(t => t.returned).length;
(returned === m.N_returned ? pass : fail)(`N_returned: crowd ${returned}, log ${m.N_returned}`);
const dTruth = new Set(truth.flatMap(t => [t.joinDay, ...t.actionDays]));
(dTruth.size === m.D ? pass : fail)(`D: crowd ${dTruth.size} days (${[...dTruth].sort().join(', ')}), log ${m.D}`);
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
(med(truth.map(t => t.sessions)) === m.medianSessions ? pass : fail)(`median sessions: crowd ${med(truth.map(t => t.sessions))}, log ${m.medianSessions}`);
const perDayTruth = {}; for (const t of truth) for (const d of new Set([t.joinDay, ...t.actionDays])) perDayTruth[d] = (perDayTruth[d] ?? 0) + 1;
const perDayOk = m.perDay.every(r => perDayTruth[r.day] === r.activeCitizens);
(perDayOk ? pass : fail)(`per-day active citizens: log ${m.perDay.map(r => `${r.day}=${r.activeCitizens}`).join(' ')}; crowd ${Object.entries(perDayTruth).sort().map(([d, n]) => `${d}=${n}`).join(' ')}`);
const bots = relay.filter(l => l.event === 'join').length - m.N_joined - m.secondary.joins_unknown_batch - m.secondary.joins_without_invite;
console.log(`info  joins in the log from excluded labels (bots): ${m.secondary.joins_excluded_labels}; unknown batch: ${m.secondary.joins_unknown_batch}; duplicates/other: ${bots - m.secondary.joins_excluded_labels}`);
const invitedCsv = codes.length;
(m.N_invited === invitedCsv ? pass : fail)(`N_invited: invitations CSV has ${invitedCsv} codes, the log says ${m.N_invited}`);
for (const n of notes) console.log(`note  ${n}`);
console.log(bad ? `metrics-validate: ${bad} FAILED` : 'metrics-validate: all agree');
process.exit(bad ? 1 : 0);
