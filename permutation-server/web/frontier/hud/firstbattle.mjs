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
import { provinceInReach } from '../fkeepreach.mjs';

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
 * route ENTERS at most MAX_ROUTE_PROVINCES provinces, the starting one not counted (fkeepreach.mjs provinceInReach, the
 * rules' path_cost: so the camp's province is at most 4 provinces away; fix-campreach-4, Q-TG4-1 — it said 3) and takes
 * at most MAX_PATH_STEPS steps (so the camp's tile is at most 32 hexes away). False only when it certainly cannot: a rim
 * village (ring 128) was guided to a ring-3 camp 125 rings away, whose march card said "No path there was found".
 */
export function campInBounds(r, { p, q, tile }) {
  if (!r || !Number.isInteger(p) || !Number.isInteger(q)) return false;
  const rp = r.p ?? p, rq = r.q ?? q;
  if (!provinceInReach({ p: rp, q: rq }, { p, q })) return false;
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
 * routed. The fog is unchanged: an unseen camp is never a candidate — save the one exception (fix-loop25, Q-PM2-1 (a)):
 * with `own(p, q)` (ownProvinceOf), a camp in a province of the viewer's own village is a candidate under the fog too,
 * and its answer says `camp.fogged` (the lines then leave its defender count out).
 * Answer: `{camp: {p, q, tile, troops, fogged?}, winnable, odds, need, passed}` or null (no fighting camp in sight and in reach,
 * or no fighting host). `passed`: the camps in sight that sit battles out and are nearer than the pick (nearest first).
 */
export function campChoice(FS, r, opts = {}) {
  if (!r || r.unit === SCOUT || r.unit === SETTLER || !(Number(r.troops) > 0)) return null;
  const { seen = () => true, rough = () => true, reach = () => null, own } = opts;
  const camps = [];
  for (const x of fightingCampsInSight(FS, r, { seen, own })) {
    const o = campArrival({ unit: r.unit, troops: Math.floor(Number(r.troops)), campTroops: x.troops, rough: !!rough(x.p, x.q, x.tile) });
    camps.push({ camp: { p: x.p, q: x.q, tile: x.tile, troops: x.troops, ...(x.fogged ? { fogged: true } : {}) }, odds: o.odds, need: o.need, d: x.d });
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
  const passed = campsSittingOut(FS, r, { seen, own }).filter(x => x.d < pick.d);
  return { camp: pick.camp, winnable: pick.odds === 'good', odds: pick.odds, need: pick.need, passed };
}

/**
 * (fix-camp-reach) The camps in sight of host row `r` that would fight (`campFights`), nearest first:
 * `[{p, q, tile, troops, d}]` — reachable or not. With `campChoice` null, a non-empty list means every fighting camp in
 * sight is out of the host's reach (the guide then offers the practice battle, #261).
 */
export function fightingCampsInSight(FS, r, { seen = () => true, own } = {}) {
  if (!r) return [];
  return campsInSight(FS, r, seen, own).filter(x => campFights(x.pr))
    .map(({ pr, c, d, fogged }) => ({ p: pr.p, q: pr.q, tile: c.tile, troops: Number(c.troops), d, fogged }))
    .sort((a, b) => a.d - b.d || a.p - b.p || a.q - b.q);
}

/**
 * The camps in sight of host row `r` that sit battles out (`campFights` false while standing: 12 holdings in their
 * province), nearest first: `[{p, q, tile, troops, garrisons, d}]`. The guide names them so the newcomer knows why the
 * camp next door is not the first battle.
 */
export function campsSittingOut(FS, r, { seen = () => true, own } = {}) {
  if (!r) return [];
  return campsInSight(FS, r, seen, own).filter(x => !campFights(x.pr))
    .map(({ pr, c, d, fogged }) => ({ p: pr.p, q: pr.q, tile: c.tile, troops: Number(c.troops), garrisons: garrisonsIn(pr), d, fogged }))
    .sort((a, b) => a.d - b.d || a.p - b.p || a.q - b.q);
}

/**
 * (fix-loop25, owner r0ze 2026-11-27 09:00, Q-PM2-1 (a)) THE ONE FOG EXCEPTION OF THE GUIDE: the camp of a province where
 * the viewer has a village of its OWN (`FS.holdings`, the viewer's own record — never a nation-mate's village, never a
 * neighbouring province) may be named by the march-first guide even when its tile is under the fog. A rim village sees
 * 4–6 tiles round itself, and the only camp in its reach stood in its own province out of sight (pacing-measure-2): the
 * guide named an unreachable camp 125 rings away, or none. What the exception lets through is exactly what the guide
 * needs: the camp's POSITION (its tile, for the guide's line, its map mark and the march card's destination) and THAT IT
 * FIGHTS (`campFights`; a camp of a province of 12 villages is passed by and said so). Nothing else: the fog view
 * (map/fog.mjs) is not touched, so the province's other tiles, sites, hosts and the camp's own tile stay fogged on the
 * map, the minimap and every list; the march card says no defenders for a tile out of sight (hud/marchcard.mjs
 * `sight`), and the guide says none either (`fogged`: its lines leave the defender count out). The guide's odds and the
 * troops it advises are still the page's own copy of the clash (as for every camp), so the advice stays right.
 * → `(p, q) => boolean`.
 */
export function ownProvinceOf(FS) {
  const own = new Set();
  for (const h of Array.isArray(FS?.holdings) ? FS.holdings : []) if (Number.isInteger(h?.p) && Number.isInteger(h?.q)) own.add(`${h.p},${h.q}`);
  return (p, q) => own.has(`${p},${q}`);
}

/**
 * The standing camps whose tile the viewer may see (`seen`) — or that stand in a province of the viewer's own village
 * (`own`, the one exception above; such a camp is marked `fogged` when `seen` says no) —, with their province distance
 * from host row `r`.
 */
function campsInSight(FS, r, seen, own = () => false) {
  const out = [];
  for (const env of FS?.provinces?.values?.() ?? []) {
    const pr = env?.province, c = pr?.camp;
    if (c?.state !== 1 || !Number.isInteger(c.tile) || !(Number(c.troops) >= 0)) continue;
    let ok = false, mine = false;
    try { ok = !!seen(pr.p, pr.q, c.tile); } catch { ok = false; }
    if (!ok) { try { mine = !!own(pr.p, pr.q); } catch { mine = false; } }
    if (!ok && !mine) continue;
    out.push({ pr, c, d: hexDist(pr, { p: r.p ?? pr.p, q: r.q ?? pr.q }), fogged: !ok });
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

// ------------------------------------------------------------------ (fix-loop26) an arrival with no battle
// loop-play26 BREAK-1 (Q-LP26-1 rec (a), Grok): in a `--demo` world the camp the guide named had fewer than 12 villages
// in its province when it was picked, and 12 by the arrival turn (demo settlers), so it sat the battle out. The report
// read "Held: the enemy is still on the field too" (300→300 vs 196→196) with no reason, the guide counted the march
// as the first battle and moved on, and the 「一致」 attached to a fight that never happened. The rule's own word for
// it is the CLASH record's `engagements` (permutation-rules frontier/clash.rs: one per attacker–defender pairing on a
// tile; 0 = nobody fought anywhere in the province that turn). Page only: nothing here changes a rule.

/** The `engagements` of the CLASH record of (p, q, bell) the page holds (FS.chronicle), or null when none is read. */
export function clashEngagements(FS, p, q, bell) {
  const list = FS?.chronicle ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]?.record ?? list[i];
    if (r?.name === 'CLASH' && Number(r.p) === p && Number(r.q) === q && Number(r.bell) === bell) {
      const n = Number(r.engagements);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/**
 * (fix-loop26) The engagements of the viewer's OWN clash at (p, q, bell): the CLASH record the page holds, else what the
 * page's own clash list kept of it once read (hud/feed.mjs ownClashesFrom — the record leaves the chronicle's last 400
 * records), else null.
 */
export function ownEngagements(FS, p, q, bell) {
  const n = clashEngagements(FS, p, q, bell);
  if (n !== null) return n;
  const k = (FS?.ownClashes ?? []).find(c => c?.p === p && c?.q === q && c?.bell === bell && Number.isFinite(c.engagements));
  return k ? k.engagements : null;
}

/**
 * Why the camp of decoded Province `pr` did not fight an arrival on `tile`: 'garrisons' — it stands on that tile but
 * CAMP_GARRISON_CAP holdings stand in its province (`campFights` false) —, else null (no camp there, or it would fight).
 */
export function campSatOutOn(pr, tile) {
  const c = pr?.camp;
  if (!c || c.state !== 1 || !Number.isInteger(tile) || c.tile !== tile) return null;
  return garrisonsIn(pr) >= CAMP_GARRISON_CAP ? 'garrisons' : null;
}

/**
 * The viewer's own resolved arrivals the page knows (its march rows whose turn is resolved, and hud/feed.mjs
 * ownClashesFrom's list), newest first, each with what the CLASH record says: `[{p, q, tile, bell, engagements,
 * why}]` — `engagements` null while the record is not read; `why` (only for engagements 0) 'garrisons' when the camp
 * stands on the arrival tile in a province of 12 villages (the page's copy of the province now), else 'none'.
 */
export function ownArrivals(FS) {
  const out = [];
  const add = (d, bell) => {
    if (!d || !Number.isInteger(d.p) || !Number.isInteger(d.q) || !Number.isInteger(bell)) return;
    const tile = Number.isInteger(d.tile) ? d.tile : null;
    const was = out.find(x => x.p === d.p && x.q === d.q && x.bell === bell);
    if (was) { if (was.tile === null && tile !== null) was.tile = tile; return; }
    out.push({ p: d.p, q: d.q, tile, bell });
  };
  for (const m of FS?.marches ?? []) if (m?.facts?.pipeline === 'resolved') add(m.dest, m.entry?.arriveBell ?? m.transit?.arriveBell);
  for (const c of FS?.ownClashes ?? []) add(c, c?.bell);
  return out.map(a => {
    const engagements = ownEngagements(FS, a.p, a.q, a.bell);
    const pr = FS?.provinces?.get?.(`${a.p},${a.q}`)?.province ?? null;
    const why = engagements === 0 ? (campSatOutOn(pr, a.tile) ?? 'none') : null;
    return { ...a, engagements, why };
  }).sort((a, b) => b.bell - a.bell);
}

/**
 * (fix-loop26) Whether the viewer's first battle has still not happened although its march(es) arrived: every own
 * arrival the page knows was resolved with no engagement (the CLASH record says 0), no other march of the viewer is
 * out or sealed, and the Citizen counts no more arrivals than those. → the newest such arrival (`ownArrivals` row),
 * or null. The guide then keeps the camp step open and says why; anything unknown (a record not read yet, a march
 * still out) counts as the first battle, as before.
 */
export function firstBattleStillAhead(FS) {
  const all = ownArrivals(FS);
  if (!all.length || all.some(a => a.engagements !== 0)) return null;
  const seen = a => all.some(x => x.p === a.p && x.q === a.q && x.bell === a.bell);
  const out = (FS?.marches ?? []).some(m => m?.facts?.pipeline !== 'resolved');
  const sealed = (FS?.orders ?? []).some(o => o?.kind === 'march' && o.state !== 'refused' && !o.home
    && !(o.dest && seen({ p: o.dest.p, q: o.dest.q, bell: Number(o.arriveBell) })));
  if (out || sealed) return null;
  if (Number(FS?.citizen?.arrivals ?? 0) > all.length) return null;
  return all[0];
}
