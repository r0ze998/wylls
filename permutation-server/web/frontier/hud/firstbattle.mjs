// The first battle of a newcomer (owner r0ze 2026-11-26 15:48, inbox 2026-11-26-1548-r0ze-playtest-answers.md:
// Q-PT-1 (c) — world 3 does (b) —, Q-PT-2 yes, Q-PT-3 (a)). Page only: no rule, parameter or program is read here
// beyond what the page already holds, and nothing is sent.
//   - "march first": the nearest barbarian camp a ready host of the viewer can beat (`campChoice`), by the page's own
//     copy of the clash for a city-kind garrison without walls (hud/rulebook.mjs campArrival). The march card's forecast
//     (the rules' own run) still stands between the guide and the seal.
//   - when the viewer's OWN first battle report is expected (`ownReportDue`, `earliestReportAt`): the arrival turn's
//     end, the seals' window, the seed margin and about a minute for the keeper to resolve (clock.mjs `pipeline`'s
//     steps; the design report's ≈12 minutes after the arrival turn ends). "About": a lagging keeper is later.
//   - a battle the viewer may open and check in this browser now (`battleOffer`): the viewer's own resolved clashes
//     first, else the newest clash the fog lets the viewer read (app.mjs `clashHere` — the same rule a report link
//     obeys: the viewer's own, or a place in sight now; fog rules unchanged), else a PRACTICE battle, labelled so: a
//     seeded fight resolved in this browser and recomputed (screens/practice.mjs `recheckPractice`). Never a practice
//     result presented as a chain record.
import { bellEnd } from '../clock.mjs';
import { campArrival } from './rulebook.mjs';
import { SCOUT, SETTLER } from '../fland.mjs';

/** Seconds the keeper is given, after the seed round, to resolve the turn (a guide figure; the report is "about"). */
export const RESOLVE_SLACK_SECS = 60;
/** The rules' least arrival lead in turns (travel.rs MIN_ARRIVAL_LEAD_BELLS; the Season's `minLead` where it says one). */
export const MIN_LEAD_BELLS = 2;

/**
 * When the clash report of a march arriving on `arriveBell` is expected (chain seconds): the arrival turn ends, the
 * seals are opened in the reveal window, the seed round follows the margin, then the turn is resolved.
 * Null without a clock.
 */
export function reportEtaAt(clock, arriveBell) {
  if (!clock || !Number.isInteger(arriveBell) || arriveBell < 0) return null;
  const end = bellEnd(Number(clock.genesisTs), arriveBell);
  const w = Number(typeof clock.window === 'function' ? clock.window(arriveBell) : clock.window);
  const m = Number(clock.margin ?? 0);
  if (![end, w, m].every(Number.isFinite)) return null;
  return end + w + m + RESOLVE_SLACK_SECS;
}

/** The earliest a march sealed in turn `nowBell` can be reported: its earliest arrival turn's report (null without a clock). */
export function earliestReportAt(clock, nowBell, season = null) {
  if (!Number.isInteger(nowBell)) return null;
  const lead = Number.isInteger(season?.minLead) && season.minLead > 0 ? season.minLead : MIN_LEAD_BELLS;
  return reportEtaAt(clock, nowBell + lead);
}

/**
 * The viewer's march whose report is awaited, soonest first: `{arriveBell, at, pipeline, dest}` or null. Only the
 * viewer's own marches (FS.marches) — never another player's.
 */
export function ownReportDue(FS) {
  let best = null;
  for (const m of FS?.marches ?? []) {
    if (m?.expedition) continue;
    const bell = m?.entry?.arriveBell ?? m?.transit?.arriveBell;
    if (!Number.isInteger(bell) || m?.facts?.pipeline === 'resolved') continue;
    const at = reportEtaAt(FS.clock, bell);
    if (at === null) continue;
    if (!best || at < best.at) best = { arriveBell: bell, at, pipeline: m?.facts?.pipeline ?? null, dest: m?.dest ?? null };
  }
  return best;
}

/** Whether the viewer has a resolved march of its own (its first report is out). */
export const ownReportOut = FS => (FS?.marches ?? []).some(m => m?.facts?.pipeline === 'resolved');

const hexDist = (a, b) => { const dq = a.q - b.q, dp = a.p - b.p; return (Math.abs(dp) + Math.abs(dq) + Math.abs(dp + dq)) / 2; };

/**
 * The barbarian camp for a first march of host row `r` (screens/host.mjs hostRows): among the camps standing in the
 * provinces the page holds whose tile the viewer may see (`seen(p, q, tile)`, the fog's own test), the nearest one the
 * host beats even at the worst roll; else the nearest camp with the troops it would take. `rough(p, q, tile)` says
 * whether the camp's tile is forest or hills (unknown counts as rough: the careful side).
 * Answer: `{camp: {p, q, tile, troops}, winnable, odds, need}` or null (no camp in sight, or no fighting host).
 */
export function campChoice(FS, r, { seen = () => true, rough = () => true } = {}) {
  if (!r || r.unit === SCOUT || r.unit === SETTLER || !(Number(r.troops) > 0)) return null;
  const camps = [];
  for (const env of FS?.provinces?.values?.() ?? []) {
    const pr = env?.province, c = pr?.camp;
    if (c?.state !== 1 || !Number.isInteger(c.tile) || !(Number(c.troops) >= 0)) continue;
    let ok = false;
    try { ok = !!seen(pr.p, pr.q, c.tile); } catch { ok = false; }
    if (!ok) continue;
    const o = campArrival({ unit: r.unit, troops: Math.floor(Number(r.troops)), campTroops: Number(c.troops), rough: !!rough(pr.p, pr.q, c.tile) });
    camps.push({ camp: { p: pr.p, q: pr.q, tile: c.tile, troops: Number(c.troops) }, odds: o.odds, need: o.need, d: hexDist(pr, { p: r.p ?? pr.p, q: r.q ?? pr.q }) });
  }
  if (!camps.length) return null;
  const byNear = (a, b) => a.d - b.d || a.camp.troops - b.camp.troops || a.camp.p - b.camp.p || a.camp.q - b.camp.q;
  const good = camps.filter(x => x.odds === 'good').sort(byNear)[0];
  const pick = good ?? camps.sort((a, b) => a.d - b.d || (a.need ?? Infinity) - (b.need ?? Infinity) || byNear(a, b))[0];
  return { camp: pick.camp, winnable: pick.odds === 'good', odds: pick.odds, need: pick.need };
}

/**
 * The battle a newcomer can open and check now: `{kind: 'real', p, q, bell, mine}` — the viewer's own resolved clash
 * (`own`, newest first), else the first of `visible` (resolved clashes, newest first, that the caller has already let
 * through the fog: app.mjs `clashHere`) —, or `{kind: 'practice'}` when there is none. Pure.
 */
export function battleOffer({ own = [], visible = [] } = {}) {
  const ok = x => x && Number.isInteger(x.p) && Number.isInteger(x.q) && Number.isInteger(x.bell);
  const mine = own.find(ok);
  if (mine) return { kind: 'real', p: mine.p, q: mine.q, bell: mine.bell, mine: true };
  const other = visible.find(ok);
  if (other) return { kind: 'real', p: other.p, q: other.q, bell: other.bell, mine: false };
  return { kind: 'practice' };
}
