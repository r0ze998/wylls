// The playtest's numbers, from the relay's event log and nothing else (PT-B):
//
//   node scripts/playtest/activity.mjs <relay-events.jsonl> [--exclude-labels bots] [--session-gap-min 30] [--json out.json]
//
// The log (permutation-gateway/src/frontier/eventlog.mjs, one JSON object per line, written by the
// relay) holds four kinds of line, all pseudonymous (a Citizen address, a wallet public key, an invite
// nonce, a transaction signature; no IP, no name, no e-mail):
//   invites_issued {label, count, nonces}   when the operator issued a batch of invites, and its label
//   join           {invite, wallet, citizen, signature}   a Join the relay sent (invite = the nonce used)
//   action         {citizen, kind, signature}   a sponsored transaction the relay sent for that Citizen
//   seen           {citizen}   the Citizen's page asked for its quota (at most one line per 5 minutes)
//
// Definitions (literal; every figure below is a count of these lines):
//   day            the calendar date in Japan (UTC+9) of the line's `t`
//   person         a Citizen whose join used an invite from a batch whose label is not in --exclude-labels
//                  (default: "bots"). Citizens that never appear in a `join` line are not counted.
//   joined         persons with a `join` line
//   active day     a day on which the person has at least one `action` line (a signed, sponsored move)
//   visit day      a day on which the person has at least one `action` or `seen` line
//   returned       a person with an active day later than the day of their join ("came back on a later day")
//   returned (visit) the same with visit days (weaker: `seen` lines can be asked for by anyone)
//   session        the person's lines (join, action, seen) in time order, a new session starting after
//                  a gap of more than --session-gap-min minutes (default 30)
//   invited        the sum of `count` over the non-excluded `invites_issued` lines (invitations made, which
//                  is not the number of people the operator sent one to)
// The numbers are only what the log shows; people who opened the link and never joined are not in it.
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const MAIN = import.meta.url === `file://${process.argv[1]}`;
const file = MAIN ? process.argv[2] : null;
if (MAIN && (!file || file.startsWith('--'))) { console.error('usage: activity.mjs <relay-events.jsonl> [--exclude-labels bots] [--session-gap-min 30] [--json out.json]'); process.exit(2); }
const EXCLUDE = new Set(String(arg('exclude-labels', 'bots')).split(',').map(s => s.trim()).filter(Boolean));
const GAP = Number(arg('session-gap-min', 30)) * 60_000;
const OUT = arg('json', '');

export const jstDay = ms => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/** Everything the report says, from the parsed lines. Pure. */
export function summarise(lines, { exclude = EXCLUDE, gapMs = GAP } = {}) {
  const labelOf = new Map(); // nonce -> label
  let invited = 0;
  const batches = {};
  for (const l of lines) {
    if (l.event !== 'invites_issued') continue;
    batches[l.label] = (batches[l.label] ?? 0) + Number(l.count ?? 0);
    for (const n of l.nonces ?? []) labelOf.set(n, l.label);
    if (!exclude.has(l.label)) invited += Number(l.count ?? 0);
  }
  const people = new Map(); // citizen -> {joinT, label, events: [t]}
  for (const l of lines) {
    if (l.event !== 'join' || !l.citizen) continue;
    const label = labelOf.get(l.invite) ?? (l.invite ? 'unknown' : 'none');
    if (exclude.has(label)) continue;
    if (!people.has(l.citizen)) people.set(l.citizen, { joinT: l.t, label, actions: [], seen: [], kinds: {} });
  }
  for (const l of lines) {
    const p = people.get(l.citizen);
    if (!p) continue;
    if (l.event === 'action') { p.actions.push(l.t); p.kinds[l.kind] = (p.kinds[l.kind] ?? 0) + 1; }
    if (l.event === 'seen') p.seen.push(l.t);
  }
  const days = new Set();
  const perDay = {};
  const row = d => (perDay[d] ??= { active: new Set(), visit: new Set(), joined: new Set(), actions: 0, sessionStarts: 0 });
  const out = [];
  for (const [citizen, p] of people) {
    const jd = jstDay(p.joinT);
    row(jd).joined.add(citizen);
    const times = [p.joinT, ...p.actions, ...p.seen].sort((a, b) => a - b);
    let prev = null;
    for (const t of times) { if (prev === null || t - prev > gapMs) row(jstDay(t)).sessionStarts++; prev = t; }
    for (const t of p.actions) { const d = jstDay(t); row(d).active.add(citizen); row(d).visit.add(citizen); row(d).actions++; days.add(d); }
    for (const t of p.seen) { const d = jstDay(t); row(d).visit.add(citizen); days.add(d); }
    days.add(jd);
    const activeDays = [...new Set(p.actions.map(jstDay))].sort();
    const visitDays = [...new Set([...p.actions, ...p.seen].map(jstDay))].sort();
    out.push({ citizen, label: p.label, joinDay: jd, actions: p.actions.length, activeDays, visitDays,
      returned: activeDays.some(d => d > jd), returnedVisit: visitDays.some(d => d > jd) });
  }
  const all = [...days].sort();
  const table = all.map(d => ({ day: d, joined: row(d).joined.size, activePersons: row(d).active.size, visitPersons: row(d).visit.size, actions: row(d).actions, sessionStarts: row(d).sessionStarts }));
  const acts = out.map(o => o.actions).sort((a, b) => a - b);
  const med = acts.length ? acts[Math.floor((acts.length - 1) / 2)] : 0;
  return {
    invited, batches, joined: people.size, days: all.length, firstDay: all[0] ?? null, lastDay: all.at(-1) ?? null,
    returned: out.filter(o => o.returned).length, returnedVisit: out.filter(o => o.returnedVisit).length,
    neverActed: out.filter(o => o.actions === 0).length, actionsMedian: med, actionsMax: acts.at(-1) ?? 0,
    perDay: table, people: out,
  };
}

if (MAIN) {
  const text = readFileSync(file, 'utf8');
  const lines = [];
  let bad = 0;
  for (const raw of text.split('\n')) { if (!raw.trim()) continue; try { lines.push(JSON.parse(raw)); } catch { bad++; } }
  const s = summarise(lines);
  console.log(`log ${file}: ${lines.length} lines${bad ? `, ${bad} unreadable` : ''}; days (JST) with any person activity: ${s.days} (${s.firstDay ?? '-'} .. ${s.lastDay ?? '-'})`);
  console.log(`invited (non-excluded batches): ${s.invited}   joined: ${s.joined}   never acted: ${s.neverActed}`);
  console.log(`returned on a later JST day (signed action): ${s.returned}   (with visits counted: ${s.returnedVisit})`);
  console.log(`actions per joined person: median ${s.actionsMedian}, max ${s.actionsMax}`);
  console.log('\nday         joined  active  visiting  actions  session-starts');
  for (const r of s.perDay) console.log(`${r.day}  ${String(r.joined).padStart(6)}  ${String(r.activePersons).padStart(6)}  ${String(r.visitPersons).padStart(8)}  ${String(r.actions).padStart(7)}  ${String(r.sessionStarts).padStart(14)}`);
  if (OUT) { writeFileSync(OUT, JSON.stringify({ ...s, people: s.people.map(({ citizen, ...p }, i) => ({ id: i + 1, ...p })) }, null, 1)); console.log(`\nwrote ${OUT} (citizen addresses replaced by numbers)`); }
}
