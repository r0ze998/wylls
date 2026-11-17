// Workstream 07: a caravan as it would go, before it is sent (brief item 3).
//
// The page today finds the road only when "send" is pressed
// (controller.mjs s1Caravan) and says nothing of when it arrives, of the
// towers that wear its cargo or of the turns it stands where it may be
// raided. Everything here is the program's own rule, ported and pinned by
// the rules crate's vectors (tests/caravan-preview.test.mjs, s1walk.test.mjs):
//   the road         caravan.rs fastest_path over the lands with the
//                    stopped palisades removed (S1-1E-CONTRACT §2.5; the
//                    program refuses a road through one, `Path`)
//   the time         caravan.rs walk (fcaravan.mjs stepSecsOf), the owner's
//                    doctrine caravan_time_bps (DOCTRINES_V3: B Tide 0.8)
//   the turns        caravan.rs schedule: the tile it stands on at the
//                    start of each turn, one run per Province (a run longer
//                    than SLOT_TILES is refused `Path`)
//   the wear         structure.rs caravan_watch, wear_bps, wear
// and what is known of the danger is told apart from what is not: a host of
// another nation the viewer sees standing on a tile of the road now is
// "known"; sealed marches, and Provinces the viewer does not have in
// sight, are "unknown" and named as such, never guessed.
import { fastestPath, stepSecsOf, landsWanted, BPS_ONE, MAX_PATH_STEPS, MAX_PATH_PROVINCES } from '../../../permutation-server/web/frontier/fcaravan.mjs';
import { bellAt, bellStart } from '../../../permutation-server/web/frontier/clock.mjs';
import { watchOf, structuresIn, avoidingPalisades, caravanWatch, stepTiles, wear, wearBps } from './s1walk.mjs';

/** caravan.rs SLOT_TILES: the most turns a caravan may stand in one Province. */
export const SLOT_TILES = 8;
/** doctrine.rs DOCTRINES_V3 caravan_time_bps by nation (only B Tide differs; pinned by the test). */
export const CARAVAN_TIME_BPS = Object.freeze([10000, 8000, 10000, 10000, 10000, 10000]);
/** Entry and site states the danger reads (Province layout): a host in the roster; a village; a Free City. */
const ENTRY_ROSTER = 1, SITE_HOLDING = 1, SITE_FREE_CITY = 5;
/** Units that never hold a tile in a clash (units.rs civilians: Scout, Settler). */
const CIVILIAN = 6;

/**
 * caravan.rs `schedule`: for steps `[{p, q, tile, atSecs}]` from `origin`
 * departing at `departTs`, the runs `[{p, q, firstBell, tiles}]` (the tile
 * at the start of each turn after the departure and before the arrival), or
 * `'tooSlow'` when a run would be longer than SLOT_TILES or a Province
 * would have two.
 */
export function schedule(genesisTs, departTs, origin, steps) {
  const total = steps.length ? steps[steps.length - 1].atSecs : 0;
  const runs = [];
  let b = (bellAt(genesisTs, departTs) ?? 0) + 1, k = 0;
  for (;;) {
    const t = bellStart(genesisTs, b) - departTs;
    if (t <= 0) { b++; continue; }
    if (t >= total) break;
    while (k < steps.length && steps[k].atSecs <= t) k++;
    const at = k === 0 ? origin : steps[k - 1];
    const last = runs[runs.length - 1];
    if (last && last.p === at.p && last.q === at.q) {
      if (last.tiles.length >= SLOT_TILES) return 'tooSlow';
      last.tiles.push(at.tile);
    } else {
      if (runs.some(r => r.p === at.p && r.q === at.q)) return 'tooSlow';
      runs.push({ p: at.p, q: at.q, firstBell: b, tiles: [at.tile] });
    }
    b++;
  }
  return runs;
}

/** The cargo worn by `bps` (milli-units in, as the program wears each amount). */
export const wornCargo = (cargo, bps) => cargo.map(c => (c > 0 ? wear(c, bps) : c));

/**
 * The preview of a caravan from `from` to `to` (`{p, q, tile}`) with
 * `cargo` (whole units by resource): `{ok: true, road, avoided, travelSecs,
 * depart, arrive: {ts, bell, bellIfLate}, wear: {bps, secs, cargo},
 * turns: [{bell, p, q, tile, known: [...], sheltered, unknown}], unknown}`
 * or `{ok: false, why}` — `why` 'NoRoad' (none within MAX_PATH_STEPS steps
 * and MAX_PATH_PROVINCES Provinces), 'OnlyThroughPalisade' (the one road
 * crosses a palisade that stops this caravan), 'TooSlow' (schedule).
 *
 * `world`: `{lands: [{p, q, passable, rough, road}], structures (the
 * herald's), stances, faction, expelled, genesisTs, now, margin (seconds a
 * send may take to land), provinces: Map "p,q" → decoded Province,
 * sight(p, q, tile) → 0..3 (3: the viewer sees who stands there), ownHost(entry) →
 * whether a host is the viewer's own (else its nation's other villages' hosts are
 * only "possibly" domestic raiders)}`.
 */
export function caravanPreview(from, to, cargo, world) {
  const { lands, structures = [], stances = null, faction, expelled = false, genesisTs, now, margin = 90, provinces = new Map(), sight = () => 0, ownHost = null } = world;
  const watchAt = (p, q) => watchOf(structuresIn(structures, p, q), stances, faction, expelled);
  const raw = fastestPath(from, to, lands);
  const road = fastestPath(from, to, avoidingPalisades(lands, watchAt));
  if (!road || !road.dirs.length) return { ok: false, why: raw?.dirs?.length ? 'OnlyThroughPalisade' : 'NoRoad', limits: { steps: MAX_PATH_STEPS, provinces: MAX_PATH_PROVINCES } };
  const bps = CARAVAN_TIME_BPS[faction] ?? BPS_ONE;
  const onRoad = road.provinces.map(pc => lands.find(l => l.p === pc.p && l.q === pc.q)).filter(Boolean);
  const secs = stepSecsOf(from, road.dirs, onRoad, bps);
  const steps = stepTiles(from, road.dirs).map((s, i) => ({ ...s, atSecs: secs[i] }));
  const travelSecs = steps[steps.length - 1].atSecs;
  const watched = caravanWatch(steps, watchAt);
  const wornBps = typeof watched === 'number' ? wearBps(watched) : 0;
  const runs = schedule(genesisTs, now, from, steps);
  if (runs === 'tooSlow') return { ok: false, why: 'TooSlow' };
  const late = schedule(genesisTs, now + margin, from, steps);
  const turns = [];
  for (const r of runs) r.tiles.forEach((tile, i) => turns.push({ bell: r.firstBell + i, p: r.p, q: r.q, tile }));
  for (const t of turns) {
    const pv = provinces.get(`${t.p},${t.q}`)?.province ?? null;
    const seen = !!pv && sight(t.p, t.q, t.tile) >= 3;
    // (a tile a garrison holds — a village, a Free City, the camp, a manned fort — keeps the caravan out of the clash, so
    // out of another nation's raid: clash_model build_v2. The keep's tile is left out until checked: this errs on the
    // side of saying less is safe. A raid by the caravan's own nation, RaidDomestic, has no such shelter)
    const sites = pv ? Array.from(pv.sites ?? []).slice(0, Number(pv.siteCount ?? 0)) : [];
    const j = sites.indexOf(t.tile), st = j >= 0 ? Number(pv.siteMirror?.[j]?.state) : null;
    const fort = (pv?.forts ?? []).some(f => Number(f.state) !== 0 && Number(f.tile) === t.tile && Number(f.troops) > 0);
    const camp = Number(pv?.camp?.state) === 1 && Number(pv.camp.tile) === t.tile;
    t.sheltered = !!pv && (st === SITE_HOLDING || st === SITE_FREE_CITY || fort || camp);
    const here = seen ? (pv.entries ?? []).filter(e => Number(e.state) === ENTRY_ROSTER && Number(e.tile) === t.tile && Number(e.troops) > 0 && Number(e.unit ?? 0) < CIVILIAN) : [];
    const whole = e => ({ faction: Number(e.faction), troops: Math.floor(Number(e.troops) / 1000) });
    t.known = t.sheltered ? [] : here.filter(e => Number(e.faction) !== faction).map(whole);
    // (caravan.rs RaidDomestic: another village of the same nation may raid it there, unless one of the owner's hosts stands on the tile)
    const mineHere = here.some(e => Number(e.faction) === faction && ownHost?.(e));
    t.domestic = mineHere ? [] : here.filter(e => Number(e.faction) === faction && !ownHost?.(e)).map(e => ({ ...whole(e), sure: !!ownHost }));
    t.unknown = !seen;
  }
  const arriveTs = now + travelSecs;
  return {
    ok: true, road: { dirs: road.dirs, provinces: road.provinces, steps },
    avoided: !!raw && JSON.stringify(raw.dirs) !== JSON.stringify(road.dirs),
    travelSecs, depart: now,
    arrive: { ts: arriveTs, bell: bellAt(genesisTs, arriveTs), bellIfLate: bellAt(genesisTs, arriveTs + margin) },
    wear: { bps: wornBps, secs: typeof watched === 'number' ? watched : 0, cargo: wornCargo(cargo.map(c => c * 1000), wornBps).map(c => Math.floor(c / 1000)) },
    turns, unknown: turns.some(t => t.unknown), lateTurns: late === 'tooSlow' ? null : late.reduce((n, r) => n + r.tiles.length, 0),
  };
}

/** The lands a preview needs between two places (fcaravan.mjs landsWanted). */
export { landsWanted };
