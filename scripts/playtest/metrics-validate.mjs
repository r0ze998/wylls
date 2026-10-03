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
// so "an action" is any transaction the page had sponsored, not only a click). The crowd's record has no transaction kind,
// so it validates the PIPELINE (who joined, which days each person's sponsored transactions fell on, how many, the
// calendar-day return and the all-action sessions: the secondary, inflated figures). The PT-E headline (returned after a
// break of 12 hours, deliberate actions only) is checked by a second, independent implementation below that reads the
// raw relay log with no code shared with playtest-metrics.mjs. Times differ by the round trip, so a
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
const m = computeMetrics(relay, { include: String(arg('include-labels', 'friends-*')).split(','), exclude: String(arg('exclude-labels', '')).split(',').filter(Boolean), tzHours: TZ });
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
  if (p.actions + p.autoActions !== t.actions) { dn++; notes.push(`tester ${t.tester}: ${p.actions} actions in the log, ${t.actions} answered 200 in the browser (a response lost to a freeze or a closing page is not counted by the browser)`); }
  const logDays = [...new Set([p.joinDay, ...p.allActionDays])].sort();
  const same = JSON.stringify([...new Set([t.joinDay, ...t.actionDays])].sort()) === JSON.stringify(logDays);
  if (!same && !t.edge && p.actions + p.autoActions === t.actions) { da++; fail(`active days of tester ${t.tester}: log ${logDays}, crowd ${[t.joinDay, ...t.actionDays]}`); }
  if (p.returnedCalendarDay !== t.returned && !t.edge && p.actions + p.autoActions === t.actions) { dr++; fail(`calendar-day returned for tester ${t.tester}: log ${p.returned}, crowd ${t.returned}`); }
  if (p.sessionsAnyAction !== t.sessions && !t.edge && p.actions + p.autoActions === t.actions) { ds++; fail(`sessions of tester ${t.tester}: log ${p.sessions}, crowd ${t.sessions}`); }
}
pass(`per person: join day, active days, returned, sessions compared for ${truth.length} testers (${dj + da + dr + ds} differences)`);
const returned = truth.filter(t => t.returned).length;
(returned === m.secondary.N_returned_calendar_day ? pass : fail)(`calendar-day returned (secondary): crowd ${returned}, log ${m.secondary.N_returned_calendar_day}`);
const dTruth = new Set(truth.flatMap(t => [t.joinDay, ...t.actionDays]));
const dLog = new Set(m.people.flatMap(p => [p.joinDay, ...p.allActionDays]));
(dTruth.size === dLog.size ? pass : fail)(`calendar days with any sponsored transaction (secondary): crowd ${dTruth.size} (${[...dTruth].sort().join(', ')}), log ${dLog.size}`);
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
(med(truth.map(t => t.sessions)) === med(m.people.map(p => p.sessionsAnyAction)) ? pass : fail)(`median sessions over all sponsored transactions (secondary): crowd ${med(truth.map(t => t.sessions))}, log ${med(m.people.map(p => p.sessionsAnyAction))}`);
const perDayTruth = {}; for (const t of truth) for (const d of new Set([t.joinDay, ...t.actionDays])) perDayTruth[d] = (perDayTruth[d] ?? 0) + 1;
const perDayLog = {}; for (const p of m.people) for (const d of new Set([p.joinDay, ...p.allActionDays])) perDayLog[d] = (perDayLog[d] ?? 0) + 1;
const perDayOk = JSON.stringify(Object.entries(perDayLog).sort()) === JSON.stringify(Object.entries(perDayTruth).sort());
(perDayOk ? pass : fail)(`per-day people with any sponsored transaction (secondary): log ${Object.entries(perDayLog).sort().map(([d, n]) => `${d}=${n}`).join(' ')}; crowd ${Object.entries(perDayTruth).sort().map(([d, n]) => `${d}=${n}`).join(' ')}`);

// ---- the PT-E headline, recomputed from the raw relay log by a second implementation (no shared code)
{
  const HOURS = Number(arg('return-hours', 12)) * 3_600_000;
  const DELIB = new Set(['Harvest', 'Build', 'Train', 'Muster', 'Garrison', 'Dissolve', 'Depart', 'Explore', 'SetVigil']);
  const countedLabel = l => String(arg('include-labels', 'friends-*')).split(',').some(p => (p.endsWith('*') ? l.startsWith(p.slice(0, -1)) : p === l)) && !String(arg('exclude-labels', '')).split(',').filter(Boolean).includes(l);
  const labelOfNonce = {}; for (const l of relay) if (l.event === 'invites_issued') for (const n of l.nonces ?? []) labelOfNonce[n] = l.label;
  const joinOf = {}; for (const l of relay) if (l.event === 'join' && l.invite && labelOfNonce[l.invite] !== undefined && countedLabel(labelOfNonce[l.invite]) && !(l.citizen in joinOf)) joinOf[l.citizen] = l.t;
  let ret = 0; let late = 0; let deliberate = 0; let automatic = 0;
  for (const [citizen, jt] of Object.entries(joinOf)) {
    const ts = relay.filter(l => l.event === 'action' && l.citizen === citizen && DELIB.has(l.kind)).map(l => l.t).sort((a, b) => a - b);
    automatic += relay.filter(l => l.event === 'action' && l.citizen === citizen && !DELIB.has(l.kind)).length;
    deliberate += ts.length;
    let last = jt; let back = false;
    for (const t of ts) { if (t - last >= HOURS) back = true; last = t; }
    if (back) ret++;
    if (ts.some(t => t - jt >= HOURS)) late++;
  }
  (ret === m.N_returned ? pass : fail)(`N_returned (break of ${HOURS / 3_600_000} h, deliberate actions only): independent recount ${ret}, script ${m.N_returned}`);
  (late === m.N_acted_late ? pass : fail)(`N_acted_late: independent recount ${late}, script ${m.N_acted_late}`);
  (deliberate === m.deliberate_actions_total && automatic === m.automatic_actions_total ? pass : fail)(`deliberate / automatic actions: independent recount ${deliberate} / ${automatic}, script ${m.deliberate_actions_total} / ${m.automatic_actions_total}`);
}
const bots = relay.filter(l => l.event === 'join').length - m.N_joined - m.secondary.joins_unknown_batch - m.secondary.joins_without_invite;
console.log(`info  joins in the log from labels not counted: ${m.secondary.joins_excluded_labels} (${Object.entries(m.labels).filter(([, v]) => !v.counted).map(([k, v]) => `${k}: ${v.joined}`).join(', ') || 'none'}); unknown batch: ${m.secondary.joins_unknown_batch}; duplicates/other: ${bots - m.secondary.joins_excluded_labels}`);
const invitedCsv = codes.length;
(m.N_invited === invitedCsv ? pass : fail)(`N_invited: invitations CSV has ${invitedCsv} codes, the log says ${m.N_invited}`);
for (const n of notes) console.log(`note  ${n}`);
console.log(bad ? `metrics-validate: ${bad} FAILED` : 'metrics-validate: all agree');
process.exit(bad ? 1 : 0);
