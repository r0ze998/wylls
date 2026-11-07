// A nation's home region as the map shows it (UX brief §7.2, §11.9, §13.6):
// the provinces whose first homes are that nation's, in the open rings. One
// reading for everything the map draws of it: the wash and line on the chart
// (map/chart.mjs paintWedge), the camera of the nation choice and of the
// wait (map/opening.mjs), the standard's place and the surveyors' marks of
// the wait (map/fmap.mjs wedgeHome, map/waitview.mjs wedgeSites), the
// nation's name over its land. The rule is fgeo `homeNation` under the
// season's placement (home.mjs seasonPlace), the same rule the home planner
// and the automatic ticket read: the map never says a province is a
// nation's where the planner would not place a village there.
//
//   placement 0, or no placement      the wedge in rings 1 .. ringsOpen − 1 (as the map always drew it)
//   placement 1 with its 32-byte seed the provinces whose homeNation is the nation: in the heartland rings
//                                     (2 .. heartlandMaxRing) the dispersed set, in ring 1 and past the
//                                     heartland the wedge (the outer territory keeps its wedge)
//   placement 1 without its seed, or  nothing: no region, no camera, no standard, no mark. Never the
//   a placement the page does not know wedge: that would show land the program would refuse
//
// The rings are the season's open rings only (the page's `ringsOpen`; the
// map's extent, its rMax and ceiling, is map/world.mjs's): nothing here
// reaches past the open land. Pure: no DOM. Regions are kept per (nation,
// rings open, placement, seed): a season with another seed is another map.
import { PLACEMENT_DISPERSED, PLACEMENT_WEDGE, R_MAX_HARD, homeNation, ringOf, ringProvinces } from '../fgeo.mjs';
import { homeWedge } from '../fland.mjs';
import { FLATTEN, PROVINCE_CIRCUMRADIUS, provincePixel } from './layers.mjs';

const int = Number.isInteger;
const nation = f => int(f) && f >= 0 && f < 6;

/** The bytes of a seed as hex (a plain array or a Uint8Array; the decoded Season's `genesisSeed` is the latter). */
export const seedHex = seed => Array.from(seed ?? [], b => (Number(b) & 255).toString(16).padStart(2, '0')).join('');

/**
 * What the map can read of the season's placement (home.mjs seasonPlace): 'wedge' (no placement, or placement 0),
 * 'dispersed' (placement 1 with a 32-byte genesis seed), 'none' (placement 1 without its seed, or a placement the
 * page does not know). The same test as the home planner's (planHomes, planTicket): what they call unavailable the
 * map shows as nothing.
 */
export function placeMode(place) {
  if (place == null || Number(place.placement) === PLACEMENT_WEDGE) return 'wedge';
  const seed = place.genesisSeed;
  if (Number(place.placement) === PLACEMENT_DISPERSED && seed && typeof seed !== 'string' && seed.length === 32) return 'dispersed';
  return 'none';
}

/** The placement as a cache key: `wedge`, `none`, or `d1:<heartland ring>:<seed hex>` (another seed is another region). */
export function placeKey(place) {
  const mode = placeMode(place);
  if (mode !== 'dispersed') return mode;
  return `d${PLACEMENT_DISPERSED}:${Number(place.heartlandMaxRing ?? 3)}:${seedHex(place.genesisSeed)}`;
}

/** The nation whose first homes province (p, q) takes under `place` (fgeo homeNation), or null where the map can read nothing. */
export function homeNationOf(p, q, place) {
  const mode = placeMode(place);
  if (mode === 'none') return null;
  return mode === 'wedge' ? homeNation(p, q) : homeNation(p, q, place);
}

const regions = new Map();
/**
 * The provinces of `faction`'s home region in the open rings (rings 1 .. ringsOpen − 1, at least ring 1):
 * `[{p, q, ring}]` in ring order, then index order; `[]` for a nation with none there; null where the map can read
 * no placement (placeMode 'none') or `faction` is no nation. Under the wedge rule the list is the wedge, exactly
 * as the map drew it before placements.
 */
export function homeRegion(faction, ringsOpen, place = undefined) {
  if (!nation(faction) || placeMode(place) === 'none') return null;
  const rings = Math.min(R_MAX_HARD + 1, Math.max(2, int(ringsOpen) ? ringsOpen : 1));
  const key = `${faction}|${rings}|${placeKey(place)}`;
  if (regions.has(key)) return regions.get(key);
  const mine = homeWedge(faction), out = [];
  for (let d = 1; d < rings; d++) for (const pr of ringProvinces(d)) if (homeNationOf(pr.p, pr.q, place) === mine) out.push({ p: pr.p, q: pr.q, ring: d });
  Object.freeze(out);
  regions.set(key, out);
  return out;
}

/** The "p,q" keys of a region, for a membership test (null where there is no region). */
export function homeRegionKeys(faction, ringsOpen, place = undefined) {
  const r = homeRegion(faction, ringsOpen, place);
  return r ? new Set(r.map(x => `${x.p},${x.q}`)) : null;
}

/** The box (world px) around the provinces of `faction`'s home region in the open rings: `{x, y, width, height}`, or null. */
export function homeBox(faction, ringsOpen, place = undefined) {
  const r = homeRegion(faction, ringsOpen, place);
  if (!r?.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pr of r) {
    const c = provincePixel(pr.p, pr.q);
    x0 = Math.min(x0, c.x - PROVINCE_CIRCUMRADIUS); x1 = Math.max(x1, c.x + PROVINCE_CIRCUMRADIUS);
    y0 = Math.min(y0, c.y - PROVINCE_CIRCUMRADIUS * FLATTEN); y1 = Math.max(y1, c.y + PROVINCE_CIRCUMRADIUS * FLATTEN);
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: x1 - x0, height: y1 - y0 };
}

/**
 * The province the region is told by: under the wedge rule its first province in ring 1 (where the nation's Seat
 * stands: the point the nation choice turns the camera to); under the dispersed rule the nation's first province of
 * ring 2, the first heartland ring (a dispersed region has no near side: its provinces stand round the whole ring).
 * `{p, q}`, or null where the map can read no placement. (Whatever rings are open, as the look point always was.)
 */
export function homeAnchor(faction, place = undefined) {
  const mode = placeMode(place);
  if (!nation(faction) || mode === 'none') return null;
  const mine = homeWedge(faction);
  const d = mode === 'dispersed' ? 2 : 1;
  return ringProvinces(d).find(pr => homeNationOf(pr.p, pr.q, place) === mine) ?? null;
}

/**
 * Where the region is looked at (world px): under the wedge rule its box's middle (`near`: the point `reach` of the
 * way from the bell to its ring-1 province, the look of the nation choice); under the dispersed rule the anchor
 * province's middle, near or far (the box's middle of a region spread round the ring would be the Concord, no
 * nation's land). Null where there is no region.
 */
export function homeLook(faction, ringsOpen, place = undefined, { near = false, reach = 1 } = {}) {
  if (placeMode(place) === 'dispersed') {
    const a = homeAnchor(faction, place);
    return a ? provincePixel(a.p, a.q) : null;
  }
  if (near) {
    const a = homeAnchor(faction, place);
    if (!a) return null;
    const c = provincePixel(a.p, a.q);
    return { x: c.x * reach, y: c.y * reach };
  }
  const box = homeBox(faction, ringsOpen, place);
  return box ? { x: box.x, y: box.y } : null;
}

/** Whether `faction`'s home region is the dispersed kind (scattered provinces: no wedge, no near side). */
export const dispersedPlace = place => placeMode(place) === 'dispersed';

/** The provinces of the region from ring `from` on (the rings a village may be placed in: fland FIRST_TICKET_RING). */
export const homeRegionFrom = (faction, ringsOpen, place, from) => (homeRegion(faction, ringsOpen, place) ?? []).filter(pr => ringOf(pr.p, pr.q) >= from);
