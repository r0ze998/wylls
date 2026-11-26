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
import { tileHex, hexDistance } from '../fgeo.mjs';
import { MAX_PATH_STEPS } from '../seal.mjs';
import { MAX_ROUTE_PROVINCES } from '../fkeepreach.mjs';

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
 * Garrisons a clash takes (`clash::MAX_GARRISONS`, screens/report.mjs MAX_GARRISONS): the camp joins a province's
 * clash only while FEWER than this many holdings stand there (frontier-abi clash_model.rs `camp.present() &&
 * garrisons.len() < MAX_GARRISONS`; permutation-frontier proc/clash.rs: "12 holdings and a camp: the camp sits the bell
 * out"). Kept equal to report.mjs's by a test.
 */
export const CAMP_GARRISON_CAP = 12;

/**
 * The site garrisons standing in decoded Province `pr`, as the rule counts them before the camp: site mirrors among
 * `siteCount` in state 1 (a holding) or 5 (a v2 genesis Free City — clash_model.rs `v2_garrison_state`,
 * world_index/resolve.rs; state 5 never occurs in a v1 Province). (verify-pr265: Free Cities were missed.)
 */
const SITE_HOLDING = 1, SITE_FREE_CITY = 5;
export function garrisonsIn(pr) {
  const m = Array.isArray(pr?.siteMirror) ? pr.siteMirror : [];
  const n = Math.min(Number.isInteger(pr?.siteCount) ? pr.siteCount : m.length, CAMP_GARRISON_CAP);
  let k = 0;
  for (let i = 0; i < n; i++) if (m[i]?.state === SITE_HOLDING || m[i]?.state === SITE_FREE_CITY) k++;
  return k;
}

/**
 * Whether the camp of decoded Province `pr` would fight a march arriving now, by the rule's own conditions: it stands
 * (state 1 — a beaten camp is state 0 until the daily check places a new one) and fewer than CAMP_GARRISON_CAP holdings
 * stand in its province (else it sits every bell out: the `--demo` home province with 12 villages, loop-play22 LP22-1).
 * A Province without site mirrors has no holdings the page knows of.
 */
export const campFights = pr => pr?.camp?.state === 1 && garrisonsIn(pr) < CAMP_GARRISON_CAP;

/**
 * (fix-camp-reach, pacing-measure-2 D-pacing-measure-2-4 / Q-PM2-1 (c)) Whether a march of host row `r` could reach the
 * camp on tile `tile` of province (p, q) at all, by the planner's own hard limits, without asking the rules module: a
 * route crosses at most MAX_ROUTE_PROVINCES provinces (so the camp's province is at most 3 provinces away) and takes at
 * most MAX_PATH_STEPS steps (so the camp's tile is at most 32 hexes away). False only when it certainly cannot: a rim
 * village (ring 128) was guided to a ring-3 camp 125 rings away, whose march card said "No path there was found".
 */
export function campInBounds(r, { p, q, tile }) {
  if (!r || !Number.isInteger(p) || !Number.isInteger(q)) return false;
  const rp = r.p ?? p, rq = r.q ?? q;
  if (hexDist({ p, q }, { p: rp, q: rq }) > MAX_ROUTE_PROVINCES - 1) return false;
  if (!Number.isInteger(r.tile) || !Number.isInteger(tile)) return true;
  const a = tileHex(rp, rq, r.tile), b = tileHex(p, q, tile);
  return !a || !b || hexDistance(a.q, a.r, b.q, b.r) <= MAX_PATH_STEPS;
}

/**
 * The barbarian camp for a first march of host row `r` (screens/host.mjs hostRows): among the camps standing in the
 * provinces the page holds whose tile the viewer may see (`seen(p, q, tile)`, the fog's own test) and that would FIGHT
 * (`campFights`: a camp in a province of 12 holdings sits the battle out — a march there is a non-battle, "Held", no
 * losses, fix-firstcamp / Q-LP22-1 (a)), the nearest one the host beats even at the worst roll; else the nearest camp
 * with the troops it would take. `rough(p, q, tile)` says whether the camp's tile is forest or hills (unknown counts as
 * rough: the careful side).
 * (fix-camp-reach) Only a camp the host can REACH is ever chosen: `campInBounds` (the planner's limits, pure), then
 * `reach({p, q, tile})` — the march card's own route question (screens/conquestguide.mjs campReach: the rules' planner
 * and the arrival window) — `false` = no route / no arrival turn, `true` = a route, `null` = not known yet (no rules
 * module; kept, as the card asks again). Asked lazily, in the order of preference, so only the camps up to the pick are
 * routed. The fog is unchanged: an unseen camp is never a candidate.
 * Answer: `{camp: {p, q, tile, troops}, winnable, odds, need, passed}` or null (no fighting camp in sight and in reach,
 * or no fighting host). `passed`: the camps in sight that sit battles out and are nearer than the pick (nearest first).
 */
export function campChoice(FS, r, opts = {}) {
  if (!r || r.unit === SCOUT || r.unit === SETTLER || !(Number(r.troops) > 0)) return null;
  const { seen = () => true, rough = () => true, reach = () => null } = opts;
  const camps = [];
  for (const x of fightingCampsInSight(FS, r, { seen })) {
    const o = campArrival({ unit: r.unit, troops: Math.floor(Number(r.troops)), campTroops: x.troops, rough: !!rough(x.p, x.q, x.tile) });
    camps.push({ camp: { p: x.p, q: x.q, tile: x.tile, troops: x.troops }, odds: o.odds, need: o.need, d: x.d });
  }
  const reachable = x => {
    if (!campInBounds(r, x.camp)) return false;
    let ok = null;
    try { ok = reach(x.camp); } catch { ok = null; }
    return ok !== false;
  };
  const byNear = (a, b) => a.d - b.d || a.camp.troops - b.camp.troops || a.camp.p - b.camp.p || a.camp.q - b.camp.q;
  const good = camps.filter(x => x.odds === 'good').sort(byNear).find(reachable);
  const pick = good ?? [...camps].sort((a, b) => a.d - b.d || (a.need ?? Infinity) - (b.need ?? Infinity) || byNear(a, b)).find(reachable);
  if (!pick) return null;
  const passed = campsSittingOut(FS, r, { seen }).filter(x => x.d < pick.d);
  return { camp: pick.camp, winnable: pick.odds === 'good', odds: pick.odds, need: pick.need, passed };
}

/**
 * (fix-camp-reach) The camps in sight of host row `r` that would fight (`campFights`), nearest first:
 * `[{p, q, tile, troops, d}]` — reachable or not. With `campChoice` null, a non-empty list means every fighting camp in
 * sight is out of the host's reach (the guide then offers the practice battle, #261).
 */
export function fightingCampsInSight(FS, r, { seen = () => true } = {}) {
  if (!r) return [];
  return campsInSight(FS, r, seen).filter(x => campFights(x.pr))
    .map(({ pr, c, d }) => ({ p: pr.p, q: pr.q, tile: c.tile, troops: Number(c.troops), d }))
    .sort((a, b) => a.d - b.d || a.p - b.p || a.q - b.q);
}

/**
 * The camps in sight of host row `r` that sit battles out (`campFights` false while standing: 12 holdings in their
 * province), nearest first: `[{p, q, tile, troops, garrisons, d}]`. The guide names them so the newcomer knows why the
 * camp next door is not the first battle.
 */
export function campsSittingOut(FS, r, { seen = () => true } = {}) {
  if (!r) return [];
  return campsInSight(FS, r, seen).filter(x => !campFights(x.pr))
    .map(({ pr, c, d }) => ({ p: pr.p, q: pr.q, tile: c.tile, troops: Number(c.troops), garrisons: garrisonsIn(pr), d }))
    .sort((a, b) => a.d - b.d || a.p - b.p || a.q - b.q);
}

/** The standing camps whose tile the viewer may see, with their province distance from host row `r`. */
function campsInSight(FS, r, seen) {
  const out = [];
  for (const env of FS?.provinces?.values?.() ?? []) {
    const pr = env?.province, c = pr?.camp;
    if (c?.state !== 1 || !Number.isInteger(c.tile) || !(Number(c.troops) >= 0)) continue;
    let ok = false;
    try { ok = !!seen(pr.p, pr.q, c.tile); } catch { ok = false; }
    if (!ok) continue;
    out.push({ pr, c, d: hexDist(pr, { p: r.p ?? pr.p, q: r.q ?? pr.q }) });
  }
  return out;
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
