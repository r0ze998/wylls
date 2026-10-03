#!/usr/bin/env node
// The playtest's numbers for the pitch (PT-C), from the relay's event log and nothing else.
//
//   node scripts/playtest-metrics.mjs [RELAY-EVENTS.jsonl] [--run-dir DIR] [--exclude-labels bots]
//        [--tz-offset-hours 9] [--session-gap-min 30] [--since ISO] [--until ISO]
//        [--herald http://127.0.0.1:41117] [--gaps status/gaps.jsonl] [--json out.json] [--people]
//
// Without a file it reads <run-dir>/relay/relay-events.jsonl (default run-dir: the playtest's real run,
// $PLAYTEST_DATA/runs/<run_id>, i.e. .claude/data/playtest/runs/playtest-1).
//
// THE LOG. permutation-gateway/src/frontier/eventlog.mjs writes one JSON object per line, no name, no e-mail,
// no IP: invites_issued {label, count, nonces}  join {invite: nonce, wallet, citizen, signature}
//                        action {citizen, kind, signature}  seen {citizen}
//   * `join` is written when the relay SENT a gated Join transaction (the relay simulates it first, so it
//     lands except in a rare race; --herald checks each joined wallet on the chain and reports how many exist);
//   * `action` is written for every sponsored (non-Join) transaction the relay sent for a Citizen: build,
//     train, muster, march, explore, settle... A move that goes through a keeper route (/f/reveal, /f/nudge)
//     is not in the log; nor is anyone who only opened the link.
//   * `seen` is written when a page of that Citizen asked for its quota (at most once per 5 minutes per Citizen).
//     Anyone can ask for any Citizen's quota, so `seen` is advice, never proof, and is NOT used by the headline
//     figures (only by the "incl. visits" variants).
//
// DEFINITIONS (literal; every figure is a count of those lines; "day" = the calendar date of the line's `t`
// at UTC+<tz-offset-hours>, JST = 9 by default):
//   N_invited      sum of `count` over `invites_issued` lines whose label is not excluded (default: bots). It is the
//                  number of invitation CODES ISSUED, which is the number of people invited only if each code was
//                  given to one person (who got a code is the operator's to remember, not the log's).
//   N_joined       number of DISTINCT invite nonces in `join` lines whose nonce belongs to a non-excluded batch
//                  (= invitation codes that completed a join). A join whose nonce is in no batch of the log is
//                  not counted and is reported as joins_unknown_batch.
//   person         the Citizen of such a join line (a Citizen joined once: a second join with the same Citizen
//                  does not make a second person).
//   activity       a `join` or `action` line of a person (a signed, sponsored move).
//   D              number of distinct days on which any person has an activity line (days are those that exist in
//                  the log: a day nobody did anything is not counted, and the days need not be consecutive).
//   per-day active distinct persons with an activity line on that day (a join counts as activity on its day).
//   N_returned     persons with an `action` line on a day later than the day of their join ("joined on day d and
//                  active on a later calendar day"). The join itself does not count as the return.
//   sessions       a person's activity lines (join + action), in time order; a new session starts at the first
//                  line and after every gap longer than --session-gap-min (default 30) minutes. The headline is the
//                  MEDIAN of the sessions per joined person (lower median for an even count). The same with
//                  `seen` lines added is reported as sessions_incl_visits.
// Everything not in the log is not claimed. The headline figures never use `seen`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(`--${k}`);

export const dayOf = (ms, tzHours = 9) => new Date(ms + tzHours * 3_600_000).toISOString().slice(0, 10);
const lowerMedian = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const sessionsOf = (times, gapMs) => { let n = 0; let prev = null; for (const t of [...times].sort((a, b) => a - b)) { if (prev === null || t - prev > gapMs) n++; prev = t; } return n; };

/** The figures from parsed log lines. Pure: the same lines give the same numbers. */
export function computeMetrics(lines, { exclude = ['bots'], tzHours = 9, gapMin = 30, since = null, until = null } = {}) {
  const ex = new Set(exclude);
  const inWindow = l => Number.isFinite(l.t) && (since === null || l.t >= since) && (until === null || l.t < until);
  const L = lines.filter(inWindow);
  const labelOf = new Map(); // nonce -> label
  const batches = {};
  let nInvited = 0;
  for (const l of L) {
    if (l.event !== 'invites_issued') continue;
    batches[l.label] = (batches[l.label] ?? 0) + Number(l.count ?? 0);
    for (const n of l.nonces ?? []) labelOf.set(n, l.label);
    if (!ex.has(l.label)) nInvited += Number(l.count ?? 0);
  }
  const people = new Map(); // citizen -> {nonce, wallet, joinT, label, actions: [t], seen: [t], kinds}
  const nonces = new Set();
  let joinsUnknownBatch = 0; let joinsExcluded = 0; let joinsNoInvite = 0;
  for (const l of L) {
    if (l.event !== 'join') continue;
    if (!l.invite) { joinsNoInvite++; continue; }
    const label = labelOf.get(l.invite);
    if (label === undefined) { joinsUnknownBatch++; continue; }
    if (ex.has(label)) { joinsExcluded++; continue; }
    if (nonces.has(l.invite) || (l.citizen && people.has(l.citizen))) continue; // one nonce, one person
    nonces.add(l.invite);
    people.set(l.citizen ?? `nonce:${l.invite}`, { nonce: l.invite, wallet: l.wallet ?? null, joinT: l.t, label, actions: [], seen: [], kinds: {} });
  }
  for (const l of L) {
    const p = people.get(l.citizen);
    if (!p) continue;
    if (l.event === 'action') { p.actions.push(l.t); p.kinds[l.kind] = (p.kinds[l.kind] ?? 0) + 1; }
    else if (l.event === 'seen') p.seen.push(l.t);
  }
  const gapMs = gapMin * 60_000;
  const day = t => dayOf(t, tzHours);
  const perDay = {};
  const row = d => (perDay[d] ??= { active: new Set(), joined: new Set(), actions: 0, visiting: new Set() });
  const out = [];
  for (const [citizen, p] of people) {
    const jd = day(p.joinT);
    row(jd).active.add(citizen); row(jd).joined.add(citizen); row(jd).visiting.add(citizen);
    for (const t of p.actions) { const d = day(t); row(d).active.add(citizen); row(d).visiting.add(citizen); row(d).actions++; }
    for (const t of p.seen) row(day(t)).visiting.add(citizen);
    const actionDays = [...new Set(p.actions.map(day))].sort();
    const visitDays = [...new Set([...p.actions, ...p.seen].map(day))].sort();
    out.push({ citizen, nonce: p.nonce, wallet: p.wallet, label: p.label, joinDay: jd, actions: p.actions.length, activeDays: [...new Set([jd, ...actionDays])].sort(),
      returned: actionDays.some(d => d > jd), returnedVisit: visitDays.some(d => d > jd),
      sessions: sessionsOf([p.joinT, ...p.actions], gapMs), sessionsInclVisits: sessionsOf([p.joinT, ...p.actions, ...p.seen], gapMs) });
  }
  const days = Object.keys(perDay).sort();
  const table = days.map(d => ({ day: d, activeCitizens: perDay[d].active.size, joined: perDay[d].joined.size, actions: perDay[d].actions, withVisits: perDay[d].visiting.size }));
  const visitDaysAll = new Set();
  for (const l of L) if (l.event === 'seen' && people.has(l.citizen)) visitDaysAll.add(day(l.t));
  return {
    definitions: 'see the header of scripts/playtest-metrics.mjs',
    window: { tzOffsetHours: tzHours, sessionGapMin: gapMin, excludeLabels: [...ex], since: since === null ? null : new Date(since).toISOString(), until: until === null ? null : new Date(until).toISOString() },
    log: { lines: lines.length, linesInWindow: L.length, firstT: L.length ? new Date(Math.min(...L.map(l => l.t))).toISOString() : null, lastT: L.length ? new Date(Math.max(...L.map(l => l.t))).toISOString() : null },
    batches,
    N_invited: nInvited,
    N_joined: nonces.size,
    D: days.length,
    days,
    perDay: table,
    N_returned: out.filter(o => o.returned).length,
    medianSessions: lowerMedian(out.map(o => o.sessions)),
    secondary: {
      N_returned_incl_visits: out.filter(o => o.returnedVisit).length,
      medianSessions_incl_visits: lowerMedian(out.map(o => o.sessionsInclVisits)),
      D_incl_visits: new Set([...days, ...visitDaysAll]).size,
      N_joined_never_acted: out.filter(o => o.actions === 0).length,
      actionsPerPersonMedian: lowerMedian(out.map(o => o.actions)),
      joins_unknown_batch: joinsUnknownBatch, joins_excluded_labels: joinsExcluded, joins_without_invite: joinsNoInvite,
    },
    people: out,
  };
}

function readLines(file) {
  const lines = []; let bad = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) { if (!raw.trim()) continue; try { lines.push(JSON.parse(raw)); } catch { bad++; } }
  return { lines, bad };
}

async function chainCheck(m, herald) {
  let exist = 0; let unreachable = 0; const missing = [];
  for (const p of m.people) {
    if (!p.wallet) continue;
    try {
      const r = await fetch(`${herald}/h/me/${p.wallet}`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.citizen) exist++; else missing.push(p.nonce);
    } catch { unreachable++; }
  }
  return { joinedWalletsFoundOnChain: exist, notFound: missing.length, unreachable };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pos = process.argv[2] && !process.argv[2].startsWith('--') ? [process.argv[2]] : [];
  let file = pos[0];
  if (!file) {
    const data = process.env.PLAYTEST_DATA ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../data/playtest');
    const runDir = arg('run-dir', path.join(data, 'runs', 'playtest-1'));
    file = path.join(runDir, 'relay', 'relay-events.jsonl');
  }
  if (!existsSync(file)) { console.error(`no event log at ${file}`); process.exit(2); }
  const { lines, bad } = readLines(file);
  const parseIso = s => (s ? Date.parse(s) : null);
  const m = computeMetrics(lines, {
    exclude: String(arg('exclude-labels', 'bots')).split(',').map(s => s.trim()).filter(Boolean),
    tzHours: Number(arg('tz-offset-hours', 9)), gapMin: Number(arg('session-gap-min', 30)), since: parseIso(arg('since', '')), until: parseIso(arg('until', '')),
  });
  if (bad) m.log.unreadableLines = bad;
  const herald = arg('herald', '');
  if (herald) m.chainCheck = await chainCheck(m, herald.replace(/\/$/, ''));
  const gaps = arg('gaps', '');
  if (gaps && existsSync(gaps)) {
    const g = readLines(gaps).lines;
    m.machineGaps = { count: g.length, totalMinutes: +(g.reduce((a, x) => a + Number(x.wall_secs ?? x.gap_s ?? 0), 0) / 60).toFixed(1), note: 'intervals the monitor saw as frozen or asleep (status/gaps.jsonl); the game clock stopped for them' };
  }
  const tzName = m.window.tzOffsetHours === 9 ? 'JST' : `UTC${m.window.tzOffsetHours >= 0 ? '+' : ''}${m.window.tzOffsetHours}`;
  console.log(`event log ${file}: ${m.log.lines} lines (${m.log.firstT} .. ${m.log.lastT})${bad ? `, ${bad} unreadable` : ''}`);
  console.log(`N_invited   ${m.N_invited}   invitation codes issued (labels not excluded: ${JSON.stringify(m.batches)}; excluded: ${m.window.excludeLabels.join(',')})`);
  console.log(`N_joined    ${m.N_joined}   distinct invite codes that completed a join${m.chainCheck ? `  (on chain: ${m.chainCheck.joinedWalletsFoundOnChain} of ${m.people.length} found${m.chainCheck.unreachable ? `, ${m.chainCheck.unreachable} unreachable` : ''})` : ''}`);
  console.log(`D           ${m.D}   calendar days (${tzName}) with any activity: ${m.days.join(', ') || '-'}`);
  console.log(`N_returned  ${m.N_returned}   joined on day d and had a signed action on a later ${tzName} day`);
  console.log(`median sessions per joined person  ${m.medianSessions}   (gap ${m.window.sessionGapMin} min; join + actions)`);
  console.log(`\nday         active citizens   joined that day   actions   (with visits)`);
  for (const r of m.perDay) console.log(`${r.day}  ${String(r.activeCitizens).padStart(14)}  ${String(r.joined).padStart(15)}  ${String(r.actions).padStart(8)}  ${String(r.withVisits).padStart(10)}`);
  const s = m.secondary;
  console.log(`\nsecondary: returned incl. visits ${s.N_returned_incl_visits}; median sessions incl. visits ${s.medianSessions_incl_visits}; D incl. visits ${s.D_incl_visits}; joined but never acted ${s.N_joined_never_acted}; median actions per person ${s.actionsPerPersonMedian}`);
  if (s.joins_unknown_batch || s.joins_without_invite) console.log(`NOTE: ${s.joins_unknown_batch} join lines name an invite from no batch in this log and ${s.joins_without_invite} have no invite; they are not counted`);
  if (m.machineGaps) console.log(`machine gaps: ${m.machineGaps.count}, ${m.machineGaps.totalMinutes} min`);
  const out = arg('json', '');
  if (out) {
    const pseudo = flag('people') ? m.people.map(({ citizen, wallet, nonce, ...p }, i) => ({ id: i + 1, ...p })) : undefined;
    writeFileSync(out, JSON.stringify({ ...m, people: pseudo }, null, 1));
    console.log(`wrote ${out}${pseudo ? ' (with one row per joined person; Citizen, wallet and invite nonce replaced by a number)' : ''}`);
  }
}
