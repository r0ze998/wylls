// The A/B pilot reader (contract 9.3 "Pilot and threshold T", 11.5 I-B; unit AC9 follow-up). Local test chain only. READS ONLY: it GETs the
// herald's public files and reads the run's own files; it sends nothing, signs nothing and changes no result.
//
//   node citizens/ab/pilot.mjs --ai-dir .local/frontier/ai/<run id> --herald http://127.0.0.1:41940 [--rep 1] [--stack-dir DIR]
//                              [--out pilot.json] [--md pilot.md]
//
// What it answers for every council period of nation 0 whose Strike Order was adopted and opened (`open.invited` is public from S + 2):
//   - the invited hosts (the council's list: nation 0's resident combat hosts within 2 provinces of the target, voters' hosts first), whose
//     they are (AI, the seat, a script bot), and for every bell C0 + 5 .. S - 1 whether the host could depart: in the province files near the
//     target, on the roster, mustered, past its ready bell, with the stamina a Depart charges (74 = march_stamina(32)). The hosts ready at
//     C0 + 6 are the pilot's "ready invited hosts"; T = min(3, that count), never below 2 (run-ab.mjs computeT);
//   - what they did: the DEPART rows of nation 0 that arrive at S and the REVEAL rows at the target, the council file's own result;
//   - the pivot condition (>= 1 nation-0 AI ballots the winning option, so the seat's ballot decides under the human-present rule);
//   - what the AIs of nation 0 saw and chose in the follow window (operator side: the mind's private records and the stored request bodies:
//     was a candidate flagged "Strike Order" offered, was it chosen);
//   - the brain's follow counters (the AI fleet's and the script bots').
//
// Limits (printed in the report): readiness comes from the province files (roster state, mustered, ready bell, stamina); a pending order
// (`pend_op`) and a host in transit are not in that view, so "ready" can be an over-count by those, and a host that is not in the files near
// the target is reported as "away". The count never credits a host that the files do not show.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBallot, fromBase64, toBase58 } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { ball } from '../watcher/council_gen.mjs';
import { computeT, NATION } from './run-ab.mjs';

export const DEPART_STAMINA = 74; // frontier march_stamina(MAX_PATH_STEPS = 32) = 10 + 2 * 32
export const STAMINA_CAP = 120;
export const INVITE_RADIUS = 2;
const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

export const staminaAt = (e, bell) => Math.min(STAMINA_CAP, Number(e.stamina ?? 0) + Math.max(0, bell - Number(e.stamina_bell ?? bell)));

/** Could this province-file host entry depart at `bell`? `e` = a feed `hosts[]` row or null (not in the files near the target). */
export function hostStatus(e, bell) {
  if (!e) return { ready: false, why: 'away', text: 'not in the province files near the target (in transit or elsewhere)' };
  if (e.state !== 1) return { ready: false, why: 'not_roster', text: `not on the roster (state ${e.state})` };
  if (Number(e.from_bell) > bell) return { ready: false, why: 'not_mustered', text: `not mustered yet (from bell ${e.from_bell})` };
  if (Number(e.ready_bell) > bell) return { ready: false, why: 'not_ready', text: `not ready yet (ready bell ${e.ready_bell})` };
  const st = staminaAt(e, bell);
  if (st < DEPART_STAMINA) return { ready: false, why: 'resting', text: `resting (stamina ${st} of ${DEPART_STAMINA} needed)`, stamina: st };
  return { ready: true, why: 'ready', text: 'ready', stamina: st };
}

/**
 * The invited hosts of one Call, bell by bell. `hostAt(id, bell)` -> a feed host row or null; `kindOf(id)` -> 'ai' | 'seat' | 'script' | 'unknown'.
 * Returns {rows: [{host_id, kind, by_bell: {bell: {ready, why, text}}, ready_at_c0_plus_6}], ready_at_c0_plus_6: n, ready_in_window: n, invited: n}.
 */
export function invitedTrace({ invited, c0, s, hostAt, kindOf = () => 'unknown' }) {
  const rows = [];
  for (const id of invited ?? []) {
    const byBell = {};
    for (let b = c0 + 5; b <= s - 1; b++) byBell[b] = hostStatus(hostAt(String(id), b), b);
    rows.push({ host_id: String(id), kind: kindOf(String(id)), by_bell: byBell, ready_at_c0_plus_6: Boolean(byBell[c0 + 6]?.ready), ready_in_window: Object.entries(byBell).some(([b, v]) => Number(b) >= c0 + 6 && v.ready) });
  }
  return { rows, ready_at_c0_plus_6: rows.filter((r) => r.ready_at_c0_plus_6).length, ready_in_window: rows.filter((r) => r.ready_in_window).length, invited: rows.length };
}

/** The ballots of an opened council file (the ballots' bytes are public from S + 2), with whether the wallet is a nation-0 AI. */
export function openedBallots(file, aiWallets) {
  const out = [];
  for (const b of file?.open?.ballots ?? []) {
    if (!b.bytes_b64) continue;
    try { const d = decodeBallot(fromBase64(b.bytes_b64)); const w = toBase58(d.wallet); out.push({ wallet: w, option: d.option, origin: d.origin, ai: aiWallets.has(w) }); } catch { /* skipped */ }
  }
  return out;
}

/** Pivot condition of 9.3: >= 1 nation-0 AI ballots the adopted option (the human-present rule then makes the seat's ballot decide). */
export const pivotCondition = (ballots, option) => ballots.filter((b) => b.ai && b.option === option).length >= 1;

/**
 * What the nation-0 AIs saw and chose in the follow window [c0 + 6, s - 1]: for each session record of theirs in the window, whether the
 * stored request lists a candidate flagged "Strike Order" and whether the choice named it. `records` = the private record entries
 * ({id, full: {ai, bell, kind, mode, reason, choice}}); `requestOf(id)` -> the stored request body or null.
 */
export function aiFollowTrace({ records, requestOf, aiTags, c0, s }) {
  const rows = [];
  for (const r of records) {
    const f = r.full ?? r;
    if (!aiTags.has(f.ai) || f.bell < c0 + 6 || f.bell > s - 1) continue;
    const body = requestOf(r.id ?? f.id);
    const user = (body?.messages ?? []).filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
    const flagged = [...user.matchAll(/^\s*(c\d+) \[[^\]]*Strike Order[^\]]*\]/gm)].map((m) => m[1]);
    const ids = f.choice?.ids ?? [];
    rows.push({ bell: f.bell, ai: f.ai, kind: f.kind, mode: f.mode, reason: f.reason ?? null, request_stored: Boolean(body), strike_order_candidates: flagged, chose_strike_order: flagged.some((c) => ids.includes(c)), choice_ids: ids });
  }
  return rows.sort((a, b) => a.bell - b.bell || (a.ai < b.ai ? -1 : 1));
}

const num = (x) => (Number.isFinite(x) ? x : 0);
const followCounters = (j) => (j ? Object.fromEntries(Object.entries(j.counters ?? {}).filter(([k]) => /^follow|^model_marches|^v6_|^quota/.test(k)).sort()) : null);
const dedup = (a) => [...new Map(a.map((x) => [x.host_id, x])).values()];

/**
 * One adopted period -> its report row. All chain reads are injected (`hostAt`, `eventsAt`, `factionOf`), so a test needs no herald.
 * `eventsAt(bell)` -> the feed's normalised events logged in that bell; `factionOf(host id)` -> the host owner's nation or null.
 */
export function periodReport({ file, roster, hostAt, eventsAt, factionOf, kindOf, records = [], requestOf = () => null }) {
  const c0 = file.c0;
  const s = file.strike_bell;
  const aiNation = (roster.ai ?? []).filter((a) => a.faction === NATION);
  const aiWallets = new Set(aiNation.map((a) => a.wallet));
  const aiTags = new Set(aiNation.map((a) => a.tag));
  const open = file.open ?? null;
  const ballots = open ? openedBallots(file, aiWallets) : [];
  const invited = (open?.invited ?? []).map(String);
  const trace = invitedTrace({ invited, c0, s, hostAt, kindOf });
  const departs = [];
  for (let b = c0 + 5; b <= s + 2; b++) {
    for (const ev of eventsAt(b)) {
      if (ev.kind !== 'DEPART' || Number(ev.arrive_bell) !== s || factionOf(String(ev.host_id)) !== NATION) continue;
      departs.push({ host_id: String(ev.host_id), depart_bell: Number(ev.depart_bell), in_follow_window: Number(ev.depart_bell) >= c0 + 6, kind: kindOf(String(ev.host_id)), invited: invited.includes(String(ev.host_id)) });
    }
  }
  const reveals = [];
  for (let b = s - 1; b <= s + 3; b++) {
    for (const ev of eventsAt(b)) {
      if (ev.kind === 'REVEAL' && Number(ev.arrive) === s && ev.faction === NATION && open && ev.p === open.p && ev.q === open.q) reveals.push({ host_id: String(ev.host_id), kind: kindOf(String(ev.host_id)) });
    }
  }
  const dep = dedup(departs);
  return {
    period: file.period, c0, strike_bell: s, follow_from: file.follow_from ?? c0 + 6,
    option: open?.option ?? null, target: open ? { p: open.p, q: open.q, tile: open.tile } : null,
    options: (file.candidates ?? []).map((o) => ({ option: o.option, kind: o.kind, p: o.p, q: o.q, ratio: o.ratio })),
    options_hash: file.options_hash ?? null, candidates_hash: file.candidates_hash ?? null,
    ai_motions: (file.motions ?? []).filter((m) => aiWallets.has(m.wallet)).map((m) => ({ name: m.name?.en ?? null, option: m.option })),
    ballots: ballots.map((b) => ({ ai: b.ai, option: b.option, origin: b.origin })),
    tally_split: file.tally_split ?? null,
    pivot_condition: open ? pivotCondition(ballots, open.option) : null,
    invited: trace,
    ready_invited_at_c0_plus_6: trace.ready_at_c0_plus_6,
    nation0_departs_arriving_at_s: dep,
    invited_hosts_departing: dep.filter((d) => d.invited && d.in_follow_window).length,
    nation0_revealed_at_target_at_s: dedup(reveals),
    result: file.result ? { present: num(file.result.present), bounced: num(file.result.bounced), clash: file.result.clash ?? null, present_hosts: file.result.present_hosts ?? [] } : null,
    ai_follow_window: aiFollowTrace({ records, requestOf, aiTags, c0, s }),
  };
}

export function renderPilot(r) {
  const L = [];
  const v = (x) => (x == null ? 'n/a' : String(x));
  L.push(`# A/B pilot reader: ${r.run_id}`, '', 'Local test chain only. Read from the run\'s public files, the herald\'s immutable province files and (operator side, labelled) the mind\'s private records. The seat\'s ballot is scripted (origin 2).', '');
  const mr = r.motion_rate;
  L.push(`Nation 0 council files: ${mr.periods_total}; with options: ${mr.periods_with_options}; with an AI motion: ${mr.periods_with_ai_motion}; adopted: ${mr.periods_adopted}; opened: ${mr.periods_opened}. Seat ballots: ${JSON.stringify(r.seat?.ballots ?? [])}; periods the seat could not vote in (NotEligible): ${JSON.stringify(r.seat?.ineligible_periods ?? [])}.`, '');
  for (const p of r.periods) {
    L.push(`## Period ${p.period} (C0 ${p.c0}, strike bell ${p.strike_bell}): ${p.option == null ? 'adopted, not opened yet' : `option ${p.option} at (${p.target.p},${p.target.q})`}`, '');
    L.push(`- options: ${JSON.stringify(p.options)}; options_hash ${v(p.options_hash)}; AI motions ${JSON.stringify(p.ai_motions)}; ballots by origin ${JSON.stringify(p.tally_split)}; pivot condition (>= 1 AI ballot for the winning option): ${v(p.pivot_condition)}`);
    L.push(`- invited hosts: ${p.invited.invited}; ready at C0 + 6: **${p.invited.ready_at_c0_plus_6}**; ready at some bell of the window: ${p.invited.ready_in_window}; invited hosts that departed in the window for the strike bell: **${p.invited_hosts_departing}**; nation 0 departures arriving at S (any host): ${p.nation0_departs_arriving_at_s.length}; nation 0 hosts revealed at the target at S: ${p.nation0_revealed_at_target_at_s.length}`);
    for (const h of p.invited.rows) L.push(`  - host ${h.host_id} (${h.kind}): ${Object.entries(h.by_bell).map(([b, s]) => `b${b} ${s.why}`).join(', ')}`);
    L.push(`- council file result: ${JSON.stringify(p.result)}`);
    if (p.ai_follow_window.length) { L.push('- nation-0 AI records in the follow window (operator side):'); for (const a of p.ai_follow_window) L.push(`  - bell ${a.bell} AI ${a.ai.slice(0, 8)} ${a.kind}/${a.mode}: Strike Order candidate offered ${a.strike_order_candidates.length ? a.strike_order_candidates.join(',') : 'no'}${a.request_stored ? '' : ' (request body not stored)'}; chosen ${a.chose_strike_order}; ids ${a.choice_ids.join(',')}`); }
    L.push('');
  }
  L.push(`T (contract 9.3) from the first opened Strike Order: ${v(r.T)} (ready invited hosts at C0 + 6: ${v(r.ready_for_T)}).`, '');
  L.push('## Brain follow counters', '', `AI fleet: ${JSON.stringify(r.counters_ai_fleet)}`, '', `script bots: ${JSON.stringify(r.counters_script_bots)}`, '');
  L.push('## Limits', '', ...r.limits.map((x) => `- ${x}`), '');
  return L.join('\n');
}

export async function buildPilotReport({ aiDir, herald, rep = 1, stackDir = null }) {
  const { createFeed } = await import('../watcher/feed.mjs');
  const roster = readJson(path.join(aiDir, 'pub/roster.json'));
  const seat = readJson(path.join(aiDir, 'ab', `seat-A-${rep}.json`));
  const cdir = path.join(aiDir, 'pub/council');
  const files = (fs.existsSync(cdir) ? fs.readdirSync(cdir) : []).map((f) => /^(\d+)-0\.json$/.exec(f)).filter(Boolean).map((m) => readJson(path.join(cdir, m[0]))).filter(Boolean).sort((a, b) => a.period - b.period);
  const feed = createFeed({ herald, roster });
  let last = -2;
  for (let i = 0; i < 80; i++) { const r = await feed.poll(); const c = feed.completeThrough?.() ?? -1; if (!r?.ok || c === last) break; last = c; }
  const tagOfAi = new Map((roster.ai ?? []).map((a) => [a.tag, 'ai']));
  const kindOf = (id) => { const t = feed.owners?.citizenOfHost?.(id); if (!t) return 'unknown'; if (tagOfAi.has(t)) return 'ai'; if (roster.seat?.tag === t) return 'seat'; return 'script'; };
  const factionOf = (id) => feed.owners?.factionOfHost?.(id) ?? null;
  const recs = [];
  try { for (const l of fs.readFileSync(path.join(aiDir, 'state/records.jsonl'), 'utf8').split('\n')) { if (!l) continue; try { const j = JSON.parse(l); if (j.op === 'add' && j.entry) recs.push(j.entry); } catch { /* skipped */ } } } catch { /* no records */ }
  const requestOf = (id) => readJson(path.join(aiDir, 'state/requests', `${id}.json`));
  const periods = [];
  for (const file of files) {
    if (!file.adopted) continue;
    const c0 = file.c0;
    const s = file.strike_bell;
    const index = new Map(); // bell -> Map(host id -> entry)
    if (file.open) {
      const around = ball(file.open.p, file.open.q, INVITE_RADIUS);
      for (let b = c0 + 5; b <= s - 1; b++) {
        const m = new Map();
        for (const c of around) { let pv = null; try { pv = await feed.provinceAt(c.p, c.q, b); } catch { pv = null; } for (const h of pv?.hosts ?? []) m.set(String(h.id), h); }
        index.set(b, m);
      }
    }
    const eventsCache = new Map();
    const eventsAt = (b) => { if (!eventsCache.has(b)) eventsCache.set(b, feed.events(b) ?? []); return eventsCache.get(b); };
    periods.push(periodReport({ file, roster, hostAt: (id, b) => index.get(b)?.get(id) ?? null, eventsAt, factionOf, kindOf, records: recs, requestOf }));
  }
  const firstOpened = periods.find((p) => p.option != null);
  return {
    v: 1, kind: 'pilot-reader', run_id: path.basename(aiDir), rep,
    motion_rate: { periods_total: files.length, periods_with_options: files.filter((f) => (f.candidates ?? []).length > 0).length, periods_with_ai_motion: files.filter((f) => (f.motions ?? []).some((m) => (roster.ai ?? []).some((a) => a.wallet === m.wallet))).length, periods_adopted: files.filter((f) => f.adopted).length, periods_opened: files.filter((f) => f.open).length },
    seat: seat ? { period: seat.period, option_x: seat.option_x, ballots: seat.ballot ? [{ period: seat.period, option: seat.ballot.option, ok: seat.ballot.ok, bell: seat.ballot.bell }] : [], ineligible_periods: seat.ineligible_periods ?? [], skipped_periods: seat.skipped_periods ?? [], finalise: seat.finalise ?? null } : null,
    periods,
    ready_for_T: firstOpened ? firstOpened.ready_invited_at_c0_plus_6 : null,
    T: firstOpened ? computeT(firstOpened.ready_invited_at_c0_plus_6) : null,
    counters_ai_fleet: followCounters(readJson(path.join(aiDir, 'fleet/ai-brain.json'))),
    counters_script_bots: stackDir ? followCounters(readJson(path.join(stackDir, 'bots/ai-brain.json'))) : null,
    limits: ['readiness comes from the province files (roster state, mustered, ready bell, stamina); a pending order and a host in transit are not in that view, so "ready" can over-count by those; a host that is not in the files near the target counts as away',
      'host owners come from the public owners index; "script" means a citizen of nation 0 that is neither an AI nor the seat',
      'the AI follow-window rows are operator-side (the mind\'s private records and stored request bodies) and are not part of the public audit',
      'one pilot run: it sets T and says what happened, it is not a rate'],
  };
}

function isMain() { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }
if (isMain()) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  for (const k of ['ai-dir', 'herald']) if (!a[k]) { console.error(`pilot: --${k} is required`); process.exit(2); }
  const r = await buildPilotReport({ aiDir: path.resolve(a['ai-dir']), herald: a.herald, rep: Number(a.rep ?? 1), stackDir: a['stack-dir'] ? path.resolve(a['stack-dir']) : null });
  if (a.out) fs.writeFileSync(path.resolve(a.out), JSON.stringify(r, null, 1) + '\n');
  const md = renderPilot(r);
  if (a.md) fs.writeFileSync(path.resolve(a.md), md);
  if (!a.md) process.stdout.write(md);
}
