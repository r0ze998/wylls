#!/usr/bin/env node
// The playtest's numbers for the pitch (PT-C, rules fixed by PT-E BEFORE the first invitation goes out), from the
// relay's event log and nothing else.
//
//   node scripts/playtest-metrics.mjs [RELAY-EVENTS.jsonl] [--run-dir DIR] [--include-labels 'friends-*']
//        [--exclude-labels ops] [--exclude-codes FILE] [--invited-sent N] [--replacement-codes R]
//        [--return-hours 12] [--reminders ISO,ISO] [--final] [--tz-offset-hours 9] [--session-gap-min 30]
//        [--since ISO] [--until ISO] [--herald http://127.0.0.1:41117] [--gaps status/gaps.jsonl] [--json out.json] [--people]
//
// Without a file it reads <run-dir>/relay/relay-events.jsonl (default run-dir: the playtest's real run,
// $PLAYTEST_DATA/runs/<run_id>, i.e. .claude/data/playtest/runs/playtest-1).
//
// THE LOG. permutation-gateway/src/frontier/eventlog.mjs writes one JSON object per line, no name, no e-mail,
// no IP: invites_issued {label, count, nonces}  join {invite: nonce, wallet, citizen, signature}
//                        action {citizen, kind, signature}  seen {citizen}
//   * `join` is written when the relay SENT a gated Join transaction (the relay simulates it first, so it
//     lands except in a rare race; --herald checks each joined wallet on the chain and reports how many exist);
//   * `action` is written for every sponsored (non-Join) transaction the relay sent for a Citizen. Some of those
//     nobody chose to send: the page files the first site ticket (FileTicket) by itself right after every join and
//     again for a refugee, rebuilds the in-game key (SetSession) after a change of address, and settles marches
//     (SettleTransit, SettleExplore) by itself. They are NOT counted as play (below).
//     A move through a keeper route (/f/reveal, /f/nudge) is not in the log; nor is anyone who only opened the link.
//   * `seen` is written when a page of that Citizen asked for its quota (at most once per 5 minutes per Citizen).
//     Anyone can ask for any Citizen's quota, so `seen` is advice, never proof, and is never used in a headline figure.
//
// DEFINITIONS (literal; fixed before the first invitation; every figure is a count of those lines; "day" = the
// calendar date of the line's `t` at UTC+<tz-offset-hours>, JST = 9):
//   label rule     a batch counts only if its label matches --include-labels (default `friends-*`; `*` at the end
//                  matches anything) and is not in --exclude-labels. EVERY label found in the log is printed with
//                  its codes issued and its joins and whether it was counted, so an unexpected label cannot hide.
//                  With --final the run FAILS (exit 3) if the log holds any label that is not `friends-*`, `bots`
//                  or `ops`.
//   deliberate     an `action` whose kind is one of Harvest, Build, Train, Muster, Garrison, Dissolve, Depart,
//     action       Explore, SetVigil (a person chose it). Join, FileTicket, SetSession, SettleTransit,
//                  SettleExplore and any kind not listed are never counted as play.
//   N_invited      codes issued in counted batches (minus codes removed by --exclude-codes). It is the number of
//                  people invited only if each code went to a different person; --invited-sent N (the operator's
//                  own note of codes actually sent) is printed beside it, and the pitch quotes the SENT number;
//                  --replacement-codes R is printed as the number of replacement codes among them.
//   N_joined       number of DISTINCT invite nonces in `join` lines of counted batches (minus --exclude-codes). A
//                  join whose nonce is in no batch is not counted and is reported as joins_unknown_batch.
//   person         the Citizen of such a join line (one Citizen joined once).
//   N_returned     persons with a deliberate action that came at least --return-hours (default 12) after the
//   (headline)     person's previous deliberate action, or after their join if there is none before it, i.e. a
//                  person who took a game action after a break of at least 12 hours (so someone who plays
//                  22:00 to 01:00 in one sitting is NOT counted, whatever the date). The 18 and 24 hour versions
//                  are printed beside it.
//   N_acted_late   persons with a deliberate action at least --return-hours after their JOIN (even if they played
//                  all the time in between): "took a game action at least 12 hours after joining". Weaker; labelled so.
//   activity       a person's join and deliberate actions (a signed, sponsored move chosen by them).
//   elapsed        hours from the first counted join to the last deliberate action of a counted person; the
//                  per-day table gives the people and deliberate actions of each calendar day.
//   D_calendar_days   (secondary; not for the pitch) distinct calendar days with any activity.
//   N_returned_calendar_day   (secondary; INFLATED by a night start and by automatic actions; kept only to validate
//                  against an independent record) persons with ANY `action` line on a later calendar day than their join.
//   sessions       a person's join and deliberate actions in time order; a new session starts at the first and after
//                  every gap longer than --session-gap-min (default 30) minutes. The headline is the MEDIAN of the
//                  sessions per joined person (lower median for an even count).
//   reminders      --reminders lists the times the operator sent a reminder; returns whose action came within 6 hours
//                  after one are counted separately (they are prompted, not organic). The operator's notes are the
//                  record of when reminders were sent.
// Everything not in the log is not claimed. The headline figures never use `seen`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(`--${k}`);

export const dayOf = (ms, tzHours = 9) => new Date(ms + tzHours * 3_600_000).toISOString().slice(0, 10);
const lowerMedian = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const sessionsOf = (times, gapMs) => { let n = 0; let prev = null; for (const t of [...times].sort((a, b) => a - b)) { if (prev === null || t - prev > gapMs) n++; prev = t; } return n; };

/** What a person chose to do (everything else the page or the relay sends by itself, or is not play). */
export const DELIBERATE_KINDS = Object.freeze(['Harvest', 'Build', 'Train', 'Muster', 'Garrison', 'Dissolve', 'Depart', 'Explore', 'SetVigil']);
/** Labels the final check accepts besides the counted ones. */
export const KNOWN_OTHER_LABELS = Object.freeze(['bots', 'ops']);
const HOUR = 3_600_000;

/** `pattern` ("friends-*": a trailing `*` matches anything) against a label. */
export const labelMatches = (pattern, label) => (pattern.endsWith('*') ? String(label).startsWith(pattern.slice(0, -1)) : pattern === label);

/** The nonce (24 hex) of an invitation code (base64url: its first 12 bytes), or the argument if it already is a nonce. */
export const nonceOfCode = c => (/^[0-9a-f]{24}$/.test(c) ? c : Buffer.from(c, 'base64url').subarray(0, 12).toString('hex'));

/**
 * The returns of one person: `times` = their deliberate actions' times, `joinT`. A return is a deliberate action
 * at least `hours` after the previous deliberate action (or after the join). `{returned, firstReturnT, actedLate}`.
 */
export function returnsOf(joinT, times, hours) {
  const gap = hours * HOUR;
  const ts = [...times].sort((a, b) => a - b);
  let prev = joinT;
  let firstReturnT = null;
  for (const t of ts) { if (firstReturnT === null && t - prev >= gap) firstReturnT = t; prev = t; }
  return { returned: firstReturnT !== null, firstReturnT, actedLate: ts.some(t => t - joinT >= gap) };
}

/** The figures from parsed log lines. Pure: the same lines give the same numbers. */
export function computeMetrics(lines, { include = ['friends-*'], exclude = [], excludeCodes = [], invitedSent = null, replacementCodes = null, returnHours = 12,
  reminders = [], tzHours = 9, gapMin = 30, since = null, until = null } = {}) {
  const ex = new Set(exclude);
  const counted = label => include.some(p => labelMatches(p, label)) && !ex.has(label);
  const gone = new Set(excludeCodes.map(nonceOfCode)); // people who asked to be left out
  const inWindow = l => Number.isFinite(l.t) && (since === null || l.t >= since) && (until === null || l.t < until);
  const L = lines.filter(inWindow);
  const labelOf = new Map(); // nonce -> label
  const batches = {};
  const labels = {}; // every label: {issued, joined, counted}
  let nInvited = 0; let removedFromInvited = 0;
  for (const l of L) {
    if (l.event !== 'invites_issued') continue;
    const row = (labels[l.label] ??= { issued: 0, joined: 0, counted: counted(l.label) });
    row.issued += Number(l.count ?? 0);
    batches[l.label] = (batches[l.label] ?? 0) + Number(l.count ?? 0);
    for (const n of l.nonces ?? []) labelOf.set(n, l.label);
    if (counted(l.label)) {
      nInvited += Number(l.count ?? 0);
      for (const n of l.nonces ?? []) if (gone.has(n)) { nInvited--; removedFromInvited++; }
    }
  }
  const people = new Map(); // citizen -> {nonce, wallet, joinT, label, actions: [t], seen: [t], kinds, auto: n}
  const nonces = new Set();
  let joinsUnknownBatch = 0; let joinsExcluded = 0; let joinsNoInvite = 0; let removedJoined = 0;
  for (const l of L) {
    if (l.event !== 'join') continue;
    if (!l.invite) { joinsNoInvite++; continue; }
    const label = labelOf.get(l.invite);
    if (label === undefined) { joinsUnknownBatch++; continue; }
    labels[label].joined++;
    if (!counted(label)) { joinsExcluded++; continue; }
    if (gone.has(l.invite)) { removedJoined++; continue; }
    if (nonces.has(l.invite) || (l.citizen && people.has(l.citizen))) continue; // one nonce, one person
    nonces.add(l.invite);
    people.set(l.citizen ?? `nonce:${l.invite}`, { nonce: l.invite, wallet: l.wallet ?? null, joinT: l.t, label, actions: [], anyAction: [], seen: [], kinds: {}, auto: 0 });
  }
  for (const l of L) {
    const p = people.get(l.citizen);
    if (!p) continue;
    if (l.event === 'action') {
      p.anyAction.push(l.t);
      p.kinds[l.kind] = (p.kinds[l.kind] ?? 0) + 1;
      if (DELIBERATE_KINDS.includes(l.kind)) p.actions.push(l.t); else p.auto++;
    } else if (l.event === 'seen') p.seen.push(l.t);
  }
  const gapMs = gapMin * 60_000;
  const day = t => dayOf(t, tzHours);
  const perDay = {};
  const row = d => (perDay[d] ??= { active: new Set(), joined: new Set(), actions: 0, visiting: new Set() });
  const rmin = [...reminders].sort((a, b) => a - b);
  const out = [];
  let firstJoinT = null; let lastActionT = null; const kindTotals = {};
  for (const [citizen, p] of people) {
    const jd = day(p.joinT);
    firstJoinT = firstJoinT === null ? p.joinT : Math.min(firstJoinT, p.joinT);
    row(jd).active.add(citizen); row(jd).joined.add(citizen); row(jd).visiting.add(citizen);
    for (const t of p.actions) { const d = day(t); row(d).active.add(citizen); row(d).visiting.add(citizen); row(d).actions++; lastActionT = lastActionT === null ? t : Math.max(lastActionT, t); }
    for (const t of p.seen) row(day(t)).visiting.add(citizen);
    for (const [k, n] of Object.entries(p.kinds)) kindTotals[k] = (kindTotals[k] ?? 0) + n;
    const actionDays = [...new Set(p.actions.map(day))].sort();
    const anyDays = [...new Set(p.anyAction.map(day))].sort();
    const visitDays = [...new Set([...p.anyAction, ...p.seen].map(day))].sort();
    const r12 = returnsOf(p.joinT, p.actions, returnHours);
    const afterReminder = r12.firstReturnT !== null && rmin.some(t => r12.firstReturnT >= t && r12.firstReturnT - t <= 6 * HOUR);
    out.push({ citizen, nonce: p.nonce, wallet: p.wallet, label: p.label, joinDay: jd, actions: p.actions.length, autoActions: p.auto, activeDays: [...new Set([jd, ...actionDays])].sort(),
      returned: r12.returned, returned18: returnsOf(p.joinT, p.actions, 18).returned, returned24: returnsOf(p.joinT, p.actions, 24).returned, actedLate: r12.actedLate, afterReminder,
      returnedCalendarDay: anyDays.some(d => d > jd), returnedVisit: visitDays.some(d => d > jd), allActionDays: anyDays, sessionsAnyAction: sessionsOf([p.joinT, ...p.anyAction], gapMs),
      sessions: sessionsOf([p.joinT, ...p.actions], gapMs), sessionsInclVisits: sessionsOf([p.joinT, ...p.anyAction, ...p.seen], gapMs) });
  }
  const days = Object.keys(perDay).sort();
  const table = days.map(d => ({ day: d, activeCitizens: perDay[d].active.size, joined: perDay[d].joined.size, actions: perDay[d].actions, withVisits: perDay[d].visiting.size }));
  const visitDaysAll = new Set();
  for (const l of L) if (l.event === 'seen' && people.has(l.citizen)) visitDaysAll.add(day(l.t));
  const unexpectedLabels = Object.keys(labels).filter(k => !labels[k].counted && !KNOWN_OTHER_LABELS.includes(k) && !include.some(p => labelMatches(p, k)));
  const count = f => out.filter(f).length;
  return {
    definitions: 'see the header of scripts/playtest-metrics.mjs',
    window: { tzOffsetHours: tzHours, sessionGapMin: gapMin, returnHours, includeLabels: include, excludeLabels: [...ex], since: since === null ? null : new Date(since).toISOString(), until: until === null ? null : new Date(until).toISOString() },
    log: { lines: lines.length, linesInWindow: L.length, firstT: L.length ? new Date(Math.min(...L.map(l => l.t))).toISOString() : null, lastT: L.length ? new Date(Math.max(...L.map(l => l.t))).toISOString() : null },
    batches,
    labels,
    unexpectedLabels,
    N_invited: nInvited,
    N_invited_sent: invitedSent,
    replacement_codes: replacementCodes,
    removed_by_exclude_codes: { from_invited: removedFromInvited, joined: removedJoined, listed: gone.size },
    N_joined: nonces.size,
    N_returned: count(o => o.returned),
    N_returned_by_hours: { 12: count(o => o.returned), 18: count(o => o.returned18), 24: count(o => o.returned24) },
    N_acted_late: count(o => o.actedLate),
    N_returned_after_reminder: count(o => o.returned && o.afterReminder),
    elapsed_hours: firstJoinT !== null && lastActionT !== null ? Number(((lastActionT - firstJoinT) / HOUR).toFixed(1)) : null,
    first_join: firstJoinT === null ? null : new Date(firstJoinT).toISOString(),
    last_deliberate_action: lastActionT === null ? null : new Date(lastActionT).toISOString(),
    deliberate_actions_total: out.reduce((a, o) => a + o.actions, 0),
    automatic_actions_total: out.reduce((a, o) => a + o.autoActions, 0),
    kinds: kindTotals,
    perDay: table,
    medianSessions: lowerMedian(out.map(o => o.sessions)),
    secondary: {
      D_calendar_days: days.length,
      days,
      N_returned_calendar_day: count(o => o.returnedCalendarDay),
      N_returned_incl_visits: count(o => o.returnedVisit),
      medianSessions_incl_visits: lowerMedian(out.map(o => o.sessionsInclVisits)),
      D_incl_visits: new Set([...days, ...visitDaysAll]).size,
      N_joined_never_acted: count(o => o.actions === 0),
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
  const list = k => String(arg(k, '')).split(',').map(s => s.trim()).filter(Boolean);
  const codeFile = arg('exclude-codes', '');
  const excludeCodes = codeFile ? readFileSync(codeFile, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean) : [];
  const num = k => (arg(k, '') === '' ? null : Number(arg(k, '')));
  const m = computeMetrics(lines, {
    include: list('include-labels').length ? list('include-labels') : ['friends-*'], exclude: list('exclude-labels'), excludeCodes,
    invitedSent: num('invited-sent'), replacementCodes: num('replacement-codes'), returnHours: Number(arg('return-hours', 12)), reminders: list('reminders').map(Date.parse).filter(Number.isFinite),
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
  const rh = m.window.returnHours;
  console.log(`event log ${file}: ${m.log.lines} lines (${m.log.firstT} .. ${m.log.lastT})${bad ? `, ${bad} unreadable` : ''}`);
  console.log('LABELS      codes issued, joins, and whether the label is counted (counted = matches ' + m.window.includeLabels.join(',') + (m.window.excludeLabels.length ? `, not ${m.window.excludeLabels.join(',')}` : '') + ')');
  for (const [k, v] of Object.entries(m.labels).sort()) console.log(`            ${k.padEnd(24)} issued ${String(v.issued).padStart(4)}  joined ${String(v.joined).padStart(4)}  ${v.counted ? 'COUNTED' : KNOWN_OTHER_LABELS.includes(k) ? 'not counted' : m.window.excludeLabels.includes(k) ? 'not counted (--exclude-labels)' : 'NOT COUNTED (unexpected label)'}`);
  console.log(`N_invited   ${m.N_invited}   invitation codes ISSUED in counted batches${m.removed_by_exclude_codes.listed ? ` (${m.removed_by_exclude_codes.from_invited} removed by --exclude-codes)` : ''}`);
  console.log(`            codes SENT (the operator's note): ${m.N_invited_sent ?? 'not given (--invited-sent N)'}${m.replacement_codes != null ? `; replacement codes among them: ${m.replacement_codes}` : ''}   <- the pitch quotes SENT, not issued`);
  console.log(`N_joined    ${m.N_joined}   distinct invite codes that completed a join${m.removed_by_exclude_codes.joined ? ` (${m.removed_by_exclude_codes.joined} removed by --exclude-codes)` : ''}${m.chainCheck ? `  (on chain: ${m.chainCheck.joinedWalletsFoundOnChain} of ${m.people.length} found${m.chainCheck.unreachable ? `, ${m.chainCheck.unreachable} unreachable` : ''})` : ''}`);
  console.log(`N_returned  ${m.N_returned}   took a deliberate game action after a break of at least ${rh} hours (since their join or their previous deliberate action); at 18 h: ${m.N_returned_by_hours[18]}, at 24 h: ${m.N_returned_by_hours[24]}`);
  console.log(`N_acted_late ${m.N_acted_late}  took a deliberate game action at least ${rh} hours after joining (weaker: play in between is allowed)`);
  if (m.window && usedReminders(m)) console.log(`            returns within 6 h after a reminder: ${m.N_returned_after_reminder} of ${m.N_returned} (prompted, not organic)`);
  console.log(`elapsed     ${m.elapsed_hours ?? '-'} h from the first counted join (${m.first_join ?? '-'}) to the last deliberate action (${m.last_deliberate_action ?? '-'}); deliberate actions ${m.deliberate_actions_total}, automatic ones not counted ${m.automatic_actions_total}`);
  console.log(`median sessions per joined person  ${m.medianSessions}   (gap ${m.window.sessionGapMin} min; join + deliberate actions)`);
  console.log(`\nday ${tzName}    people active   joined that day   deliberate actions   (with visits)`);
  for (const r of m.perDay) console.log(`${r.day}  ${String(r.activeCitizens).padStart(14)}  ${String(r.joined).padStart(15)}  ${String(r.actions).padStart(18)}  ${String(r.withVisits).padStart(10)}`);
  const s = m.secondary;
  console.log(`\nsecondary, NOT for the pitch: calendar days with activity ${s.D_calendar_days} (${s.days.join(', ') || '-'}); returned on a later calendar day by ANY action (inflated by a night start and automatic actions) ${s.N_returned_calendar_day}; incl. visits ${s.N_returned_incl_visits}; joined but never took a deliberate action ${s.N_joined_never_acted}; median deliberate actions per person ${s.actionsPerPersonMedian}`);
  if (s.joins_unknown_batch || s.joins_without_invite) console.log(`NOTE: ${s.joins_unknown_batch} join lines name an invite from no batch in this log and ${s.joins_without_invite} have no invite; they are not counted`);
  if (m.machineGaps) console.log(`machine gaps: ${m.machineGaps.count}, ${m.machineGaps.totalMinutes} min`);
  if (m.unexpectedLabels.length) console.log(`WARNING: labels that are neither ${m.window.includeLabels.join('/')} nor ${KNOWN_OTHER_LABELS.join('/')}: ${m.unexpectedLabels.join(', ')}. Their codes and joins are NOT counted; decide what they were before quoting any figure.`);
  const out = arg('json', '');
  if (out) {
    const pseudo = flag('people') ? m.people.map(({ citizen, wallet, nonce, ...p }, i) => ({ id: i + 1, ...p })) : undefined;
    writeFileSync(out, JSON.stringify({ ...m, people: pseudo }, null, 1));
    console.log(`wrote ${out}${pseudo ? ' (with one row per joined person; Citizen, wallet and invite nonce replaced by a number)' : ''}`);
  }
  if (flag('final') && m.unexpectedLabels.length) { console.error('metrics: --final refused: unexpected labels in the log (see WARNING)'); process.exit(3); }
}
function usedReminders(m) { return m.window && m.N_returned_after_reminder !== undefined && process.argv.includes('--reminders'); }
