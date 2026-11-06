// The dispersed first-home placement on the game map (map/homeland.mjs and
// the call sites that read it: map/chart.mjs wedgePaths and paintWedge,
// map/opening.mjs lookPoint, wedgeBox and openingPlan, map/waitview.mjs
// wedgeSites, map/fmap.mjs wedgeHome, people/ui.mjs highlights). The
// overlays, cameras, the standard's place and the site marks follow fgeo
// `homeNation` under the season's placement (home.mjs seasonPlace), the
// same rule the home planner reads; the wedge rule draws exactly what it
// drew; a placement whose seed the page does not have shows nothing, never
// the wedge; the caches tell placements and seeds apart. Pure: no canvas,
// no chain, no keys, no addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLACEMENT_DISPERSED, R_MAX_HARD, homeNation, ringOf, ringProvinces, tileHex, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { FIRST_TICKET_RING } from '../../permutation-server/web/frontier/fland.mjs';
import { seasonPlace } from '../../permutation-server/web/frontier/home.mjs';
import * as HL from '../../permutation-server/web/frontier/map/homeland.mjs';
import * as opening from '../../permutation-server/web/frontier/map/opening.mjs';
import * as fmap from '../../permutation-server/web/frontier/map/fmap.mjs';
import { paintWedge, wedgePaths } from '../../permutation-server/web/frontier/map/chart.mjs';
import { wedgeSites } from '../../permutation-server/web/frontier/map/waitview.mjs';
import { FLATTEN, PROVINCE_CIRCUMRADIUS, provincePixel } from '../../permutation-server/web/frontier/map/layers.mjs';
import { highlights } from '../../permutation-server/web/frontier/people/ui.mjs';
import { inverseHex, project } from '../../permutation-server/web/map.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const source = f => readFileSync(new URL(f, WEB), 'utf8');

const seed = n => new Array(32).fill(n);
/** The dispersed placement with seed 1 (the vector web-frontier-placement.test.mjs pins against the rules crate). */
const dispersed = { placement: PLACEMENT_DISPERSED, heartlandMaxRing: 3, genesisSeed: seed(1) };
/** The same placement as the decoded Season carries it (fcodec: a Uint8Array), through home.mjs seasonPlace. */
const fromSeason = seasonPlace({ conquestParams: { placement: 1, heartlandMaxRing: 3 }, genesisSeed: Uint8Array.from(seed(1)) });
/** Placements the map must read as nothing: no seed, a short seed, a placement the page does not know. */
const unreadable = [{ placement: 1 }, { placement: 1, genesisSeed: [1] }, { placement: 2, genesisSeed: seed(1) }, seasonPlace({ conquestParams: { placement: 1 } })];
const size = { width: 1000, height: 800 };
const legacyLoop = (f, rings) => { const out = []; for (let d = 1; d < Math.max(2, rings); d++) for (const pr of ringProvinces(d)) if (wedgeOf(pr.p, pr.q) === f) out.push({ p: pr.p, q: pr.q, ring: d }); return out; };
const inPicture = (view, at) => { const s = fmap.worldToScreen(view, size, at.x, at.y); return s.x >= 0 && s.x <= size.width && s.y >= 0 && s.y <= size.height; };

/** A Path2D stand-in that counts what is drawn into it (node has none). */
class CountingPath { constructor() { this.moves = 0; this.closes = 0; } moveTo() { this.moves++; } lineTo() {} closePath() { this.closes++; } }
const withPath2D = fn => { const had = globalThis.Path2D; globalThis.Path2D = CountingPath; try { return fn(); } finally { if (had) globalThis.Path2D = had; else delete globalThis.Path2D; } };
/** A context that records every call; nothing else. */
const recorder = () => { const calls = []; return { calls, g: new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: () => true }) }; };
/** A flat map on a stub canvas (as web-frontier-wave4-map.test.mjs builds one). */
function flatMap(src) {
  const grad = { addColorStop() {} };
  const ctx = new Proxy({ createLinearGradient: () => grad, createRadialGradient: () => grad, measureText: () => ({ width: 10 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });
  const cv = { clientWidth: size.width, clientHeight: size.height, width: 0, height: 0, dataset: {}, getContext: () => ctx, addEventListener: () => {} };
  const m = new fmap.FrontierMap(cv, { source: () => src });
  m.cam.reduced = () => false;
  return m;
}

test('the map reads the placement as the home planner does: the wedge, the dispersed rule with its seed, or nothing', () => {
  assert.equal(HL.placeMode(undefined), 'wedge');
  assert.equal(HL.placeMode({ placement: 0 }), 'wedge');
  assert.equal(HL.placeMode(seasonPlace({ conquestParams: { placement: 0 }, genesisSeed: seed(1) })), 'wedge', 'placement 0 is the wedge whatever seed the season carries');
  assert.equal(HL.placeMode(dispersed), 'dispersed');
  assert.equal(HL.placeMode(fromSeason), 'dispersed');
  for (const p of unreadable) assert.equal(HL.placeMode(p), 'none', JSON.stringify(p));
  // the keys: the wedge is one key whatever object says it, a seed is in its key, another seed is another key
  assert.equal(HL.placeKey(undefined), 'wedge');
  assert.equal(HL.placeKey({ placement: 0 }), 'wedge');
  assert.equal(HL.placeKey(dispersed), `d1:3:${'01'.repeat(32)}`);
  assert.equal(HL.placeKey(fromSeason), HL.placeKey(dispersed), 'the decoded Season\'s Uint8Array seed keys as the array does');
  assert.notEqual(HL.placeKey({ ...dispersed, genesisSeed: seed(2) }), HL.placeKey(dispersed));
  assert.notEqual(HL.placeKey({ ...dispersed, heartlandMaxRing: 4 }), HL.placeKey(dispersed));
  for (const p of unreadable) assert.equal(HL.placeKey(p), 'none');
});

test('the wedge rule is unchanged: region, box, look point, site marks and opening are what the map always drew', () => {
  const recs = new Map(), terrainOf = () => ({ sites: [5, 9, 14, 20, 27, 33, 38, 41, 46, 50, 55, 59] });
  for (let d = 1; d <= 4; d++) for (const pr of ringProvinces(d)) recs.set(`${pr.p},${pr.q}`, { p: pr.p, q: pr.q, sites: Array(12).fill(0), owners: Array(12).fill(7) });
  for (let f = 0; f < 6; f++) for (const rings of [1, 2, 3, 5]) {
    const legacy = legacyLoop(f, rings);
    assert.deepEqual(HL.homeRegion(f, rings), legacy, `nation ${f}, ${rings} rings: the wedge in rings 1 .. ${rings - 1}`);
    assert.deepEqual(HL.homeRegion(f, rings, { placement: 0 }), legacy, 'placement 0 said explicitly is the same wedge');
    // the box the wedge view and the wait's light read
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pr of legacy) { const c = provincePixel(pr.p, pr.q); x0 = Math.min(x0, c.x - PROVINCE_CIRCUMRADIUS); x1 = Math.max(x1, c.x + PROVINCE_CIRCUMRADIUS); y0 = Math.min(y0, c.y - PROVINCE_CIRCUMRADIUS * FLATTEN); y1 = Math.max(y1, c.y + PROVINCE_CIRCUMRADIUS * FLATTEN); }
    assert.deepEqual(opening.wedgeBox(f, rings), { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: x1 - x0, height: y1 - y0 });
    assert.deepEqual(opening.wedgeBox(f, rings, { placement: 0 }), opening.wedgeBox(f, rings));
    // the surveyors' marks: the wedge's free sites from the first ring a village may be placed in
    const marks = wedgeSites(f, rings, recs, terrainOf);
    assert.deepEqual(marks.map(s => `${s.p},${s.q}`).filter((k, i, a) => a.indexOf(k) === i), legacy.filter(pr => pr.ring >= FIRST_TICKET_RING).map(pr => `${pr.p},${pr.q}`));
    assert.deepEqual(wedgeSites(f, rings, recs, terrainOf, { placement: 0 }), marks);
  }
  for (let f = 0; f < 6; f++) {
    // the nation choice's look point: toward the wedge's ring-1 province, LOOK.reach of the way
    const first = ringProvinces(1).find(pr => wedgeOf(pr.p, pr.q) === f), c = provincePixel(first.p, first.q);
    assert.deepEqual(opening.lookPoint(f, 3), { x: c.x * opening.LOOK.reach, y: c.y * opening.LOOK.reach });
    assert.deepEqual(opening.lookPoint(f, 3, { placement: 0 }), opening.lookPoint(f, 3));
    // the opening views, with and without the placement said
    const src = { ringsOpen: 3, own: [] }, none = opening.openHint({ mode: 'play', land: { stage: 'none' } });
    const joined = opening.openHint({ mode: 'play', land: { stage: 'joined' }, citizen: { faction: f } });
    assert.deepEqual(opening.openingPlan(joined, { ...src, place: { placement: 0 } }, size), opening.openingPlan(joined, src, size));
    assert.equal(opening.openingPlan(joined, src, size).kind, 'wedge');
    const look = opening.openingPlan({ ...none, frame: { nation: f } }, src, size, { inset: { top: 48, bottom: 450 } });
    assert.deepEqual(opening.openingPlan({ ...none, frame: { nation: f } }, { ...src, place: { placement: 0 } }, size, { inset: { top: 48, bottom: 450 } }), look);
    assert.equal(look.kind, 'frame');
  }
  // the chart's paths: one object per (nation, rings): the wedge said explicitly is the same object
  withPath2D(() => { for (let f = 0; f < 6; f++) { const w = wedgePaths(f, 3); assert.ok(w && w.fill.closes === 61 * legacyLoop(f, 3).length, 'every tile of the wedge is in the wash'); assert.equal(wedgePaths(f, 3, { placement: 0 }), w); } });
});

test('dispersed: a nation\'s region is its scattered heartland provinces, the wedge in ring 1 and past the heartland, never a neighbour\'s', () => {
  for (const place of [dispersed, fromSeason]) for (let f = 0; f < 6; f++) {
    const region = HL.homeRegion(f, 5, place);
    assert.ok(region.every(pr => homeNation(pr.p, pr.q, place) === f), 'every province of the region takes this nation\'s first homes');
    assert.deepEqual(region, [1, 2, 3, 4].flatMap(d => ringProvinces(d).filter(pr => homeNation(pr.p, pr.q, place) === f).map(pr => ({ p: pr.p, q: pr.q, ring: d }))), 'and every province that does is in it, in ring order');
    const byRing = d => region.filter(pr => pr.ring === d);
    assert.deepEqual([1, 2, 3, 4].map(d => byRing(d).length), [1, 2, 3, 4], 'ring 1: the wedge\'s one; the heartland rings: d provinces; ring 4 (past the heartland): the wedge\'s four');
    assert.deepEqual(byRing(1).concat(byRing(4)), legacyLoop(f, 5).filter(pr => pr.ring === 1 || pr.ring === 4), 'the outer territory keeps the wedge');
    for (const d of [2, 3]) {
      const mine = byRing(d);
      assert.equal(new Set(mine.map(pr => wedgeOf(pr.p, pr.q))).size, d, `ring ${d}: in ${d} different wedges`);
      for (const a of mine) for (const b of mine) if (a !== b) assert.ok(ringOf(a.p - b.p, a.q - b.q) >= 2, `ring ${d}: no two of the nation's provinces touch`);
      assert.notDeepEqual(mine, legacyLoop(f, 5).filter(pr => pr.ring === d), `ring ${d}: not the wedge`);
    }
    // the membership test the chart's edge reads
    const keys = HL.homeRegionKeys(f, 5, place);
    assert.equal(keys.size, region.length);
    for (const pr of ringProvinces(2)) assert.equal(keys.has(`${pr.p},${pr.q}`), homeNation(pr.p, pr.q, place) === f);
    // never past the open rings, never past the program's hard limit
    assert.ok(HL.homeRegion(f, 3, place).every(pr => pr.ring <= 2));
    assert.ok(HL.homeRegion(f, 1, place).length === 1 && HL.homeRegion(f, 1, place)[0].ring === 1, 'one ring open: ring 1, as the wedge rule shows it');
  }
  // the open rings are the page's; the map's extent (rMax, the ceiling: map/world.mjs) is read beside them, and nothing here grows past the program's hard limit
  const far = HL.homeRegion(0, 10000, { ...dispersed, heartlandMaxRing: 2 });
  assert.ok(far.length > 0 && far.every(pr => pr.ring <= R_MAX_HARD) && far.at(-1).ring === R_MAX_HARD, 'no infinite growth');
  // the two placements the planner and the map agree on: a province is lit for a nation exactly when homeSites would offer it
  for (let f = 0; f < 6; f++) for (const pr of [...ringProvinces(2), ...ringProvinces(3)]) assert.equal(HL.homeRegionKeys(f, 4, dispersed).has(`${pr.p},${pr.q}`), homeNation(pr.p, pr.q, dispersed) === f);
});

test('dispersed: the chart outlines the scattered provinces one by one, and keeps one set of paths per placement and seed', () => withPath2D(() => {
  for (let f = 0; f < 6; f++) {
    const w = wedgePaths(f, 4, dispersed), legacy = wedgePaths(f, 4);
    assert.ok(w && legacy);
    assert.equal(w.fill.closes, 61 * HL.homeRegion(f, 4, dispersed).length, 'the wash covers every tile of the region');
    assert.equal(legacy.fill.closes, 61 * legacyLoop(f, 4).length);
    assert.ok(w.edge.moves > legacy.edge.moves, `nation ${f}: scattered provinces have more edge than one wedge (${w.edge.moves} > ${legacy.edge.moves})`);
    assert.notEqual(w, legacy, 'the dispersed paths are not the wedge\'s');
    assert.equal(wedgePaths(f, 4, fromSeason), w, 'the same seed from the decoded Season: the same paths');
    assert.equal(wedgePaths(f, 4, { ...dispersed, genesisSeed: [...seed(1)] }), w, 'a copy of the seed: the same paths');
    assert.notEqual(wedgePaths(f, 4, { ...dispersed, genesisSeed: seed(2) }), w, 'another seed: other paths');
    assert.notEqual(wedgePaths(f, 5, dispersed), w, 'another ring open: other paths');
  }
  // painted: a wash and the four strokes, as the wedge is; with the wait's light the same strokes after it
  const { calls, g } = recorder();
  paintWedge(g, 2, 4, 1, { lit: true, place: dispersed });
  assert.deepEqual(calls.filter(c => c[0] === 'fill' || c[0] === 'stroke').map(c => c[0]), ['fill', 'stroke', 'stroke', 'stroke', 'stroke']);
}));

test('a placement whose seed the page does not have shows nothing: no region, no camera, no standard, no mark, never the wedge', () => withPath2D(() => {
  const src = { ringsOpen: 4, own: [] }, none = opening.openHint({ mode: 'play', land: { stage: 'none' } });
  for (const place of unreadable) for (let f = 0; f < 6; f++) {
    assert.equal(HL.homeRegion(f, 4, place), null);
    assert.equal(HL.homeRegionKeys(f, 4, place), null);
    assert.equal(HL.homeAnchor(f, place), null);
    assert.equal(HL.homeLook(f, 4, place), null);
    assert.equal(opening.wedgeBox(f, 4, place), null);
    assert.equal(opening.lookPoint(f, 4, place), null);
    assert.equal(wedgePaths(f, 4, place), null);
    const recs = new Map(ringProvinces(2).map(pr => [`${pr.p},${pr.q}`, { p: pr.p, q: pr.q, sites: Array(12).fill(0), owners: Array(12).fill(7) }]));
    assert.deepEqual(wedgeSites(f, 4, recs, () => ({ sites: Array.from({ length: 12 }, (_, i) => i * 5) }), place), []);
    const { calls, g } = recorder();
    paintWedge(g, f, 4, 1, { lit: true, place });
    paintWedge(g, f, 4, 1, { wait: { x: 0, y: 0, r: 100 }, place });
    assert.deepEqual(calls, [], 'nothing is painted');
    // the camera: a joined viewer sees the open world, not a wedge; a nation looked at keeps the bell, no turn
    const joined = opening.openHint({ mode: 'play', land: { stage: 'joined' }, citizen: { faction: f } });
    assert.equal(opening.openingPlan(joined, { ...src, place }, size).kind, 'fit');
    assert.deepEqual(opening.openingPlan({ ...none, frame: { nation: f } }, { ...src, place }, size), opening.openingPlan({ ...none, frame: {} }, { ...src, place }, size));
    assert.notDeepEqual(opening.openingPlan({ ...none, frame: { nation: f } }, { ...src, place }, size), opening.openingPlan({ ...none, frame: { nation: f } }, src, size), 'and not the turn toward the wedge');
  }
  // the standard and the player's spot on the board
  const waiting = { overviews: new Map(), ringsOpen: 4, own: [], place: unreadable[0], open: { mode: 'play', ready: true, stage: 'joined', faction: 2 }, survey: { showAll: false, faction: 2, stage: 'joined', province: () => ({ max: 1, sig: '' }), levelAt: () => 1, levelOf: () => 1, candidates: [], villages: [], rev: 0 } };
  const m = flatMap(waiting);
  try {
    assert.equal(m.wedgeHome(2, 4, unreadable[0]), null);
    assert.equal(m.waitSpot(), null, 'nobody stands on land the map cannot name');
    m.source = () => ({ ...waiting, place: undefined });
    assert.ok(m.waitSpot(), 'the same viewer under the wedge rule has a spot');
  } finally { m.destroy(); }
}));

test('dispersed: the camera frames all of the nation\'s provinces, the standard stands on the nation\'s anchor province, the name too', () => {
  const src = { ringsOpen: 4, own: [], place: dispersed }, none = opening.openHint({ mode: 'play', land: { stage: 'none' } });
  for (let f = 0; f < 6; f++) {
    const region = HL.homeRegion(f, 4, dispersed), box = opening.wedgeBox(f, 4, dispersed);
    // the anchor: the nation's first province of ring 2 (the first heartland ring), on the nation's own land
    const anchor = HL.homeAnchor(f, dispersed);
    assert.equal(ringOf(anchor.p, anchor.q), 2);
    assert.equal(homeNation(anchor.p, anchor.q, dispersed), f);
    assert.deepEqual(anchor, ringProvinces(2).find(pr => homeNation(pr.p, pr.q, dispersed) === f));
    const at = provincePixel(anchor.p, anchor.q);
    assert.deepEqual(HL.homeLook(f, 4, dispersed), at);
    assert.deepEqual(HL.homeLook(f, 4, dispersed, { near: true, reach: 0.72 }), at, 'near or far, the anchor: a scattered region has no near side');
    assert.deepEqual(opening.lookPoint(f, 4, dispersed), at);
    assert.ok(Math.hypot(box.x, box.y) < Math.hypot(at.x, at.y), 'the box\'s middle lies toward the Concord: not where the name or the standard may stand');
    // joined, waiting: every province of the region in the picture
    const joined = opening.openHint({ mode: 'play', land: { stage: 'joined' }, citizen: { faction: f } });
    const w = opening.openingPlan(joined, src, size);
    assert.equal(w.kind, 'wedge');
    for (const pr of region) assert.ok(inPicture(w.view, provincePixel(pr.p, pr.q)), `nation ${f}: province ${pr.p},${pr.q} is in the wait's picture`);
    assert.notDeepEqual(w.view, opening.openingPlan(joined, { ...src, place: undefined }, size).view, 'not the wedge\'s view');
    // the nation choice: the camera frames the scattered provinces (no near side to turn to) with the bell among them
    const look = opening.openingPlan({ ...none, frame: { nation: f } }, src, size);
    assert.equal(look.kind, 'frame');
    for (const pr of region) assert.ok(inPicture(look.view, provincePixel(pr.p, pr.q)), `nation ${f}: province ${pr.p},${pr.q} is in the nation choice's picture`);
    assert.ok(inPicture(look.view, { x: 0, y: 0 }), 'the bell too');
    assert.ok(look.view.zoom < opening.ENGINE_VIEW.min, 'from further out than the bell view');
    assert.notDeepEqual(look.view, opening.openingPlan({ ...none, frame: { nation: f } }, { ...src, place: undefined }, size).view, 'not the turn toward the wedge');
  }
  // the standard: on the anchor province's middle tile, and kept per placement and seed
  const waiting = { overviews: new Map(), ringsOpen: 4, own: [], place: dispersed, open: { mode: 'play', ready: true, stage: 'joined', faction: 2 }, survey: { showAll: false, faction: 2, stage: 'joined', province: () => ({ max: 1, sig: '' }), levelAt: () => 1, levelOf: () => 1, candidates: [], villages: [], rev: 0 } };
  const m = flatMap(waiting);
  try {
    const a = HL.homeAnchor(2, dispersed), at = provincePixel(a.p, a.q);
    assert.deepEqual(m.wedgeHome(2, 4, dispersed), at);
    assert.deepEqual(m.wedgeHome(2, 4, fromSeason), at, 'the same seed as the Season carries it');
    const legacyBox = opening.wedgeBox(2, 4), [q, r] = inverseHex(legacyBox.x, legacyBox.y).split(',').map(Number);
    assert.deepEqual(m.wedgeHome(2, 4), project(q, r), 'the wedge rule: the tile near the wedge\'s middle, as before');
    assert.notDeepEqual(m.wedgeHome(2, 4, dispersed), m.wedgeHome(2, 4), 'another placement: another standard (the cache key tells them apart)');
    assert.notDeepEqual(m.wedgeHome(2, 4, { ...dispersed, genesisSeed: seed(2) }), m.wedgeHome(2, 4, dispersed), 'another seed: another standard');
    m.cam.set({ ...m.cam.view, zoom: 0.7 }, { ms: 0 });
    const spot = m.waitSpot();
    assert.equal(spot.faction, 2);
    assert.equal(homeNation(spot.tile.p, spot.tile.q, dispersed), 2, 'the player stands on the nation\'s own province');
  } finally { m.destroy(); }
});

test('dispersed: the surveyors\' marks stand on the free sites of the nation\'s scattered provinces, and on no wedge province that is another nation\'s', () => {
  const recs = new Map();
  for (const d of [1, 2, 3]) for (const pr of ringProvinces(d)) recs.set(`${pr.p},${pr.q}`, { p: pr.p, q: pr.q, sites: Array(12).fill(0), owners: Array(12).fill(7) });
  const sites = [5, 9, 14, 20, 27, 33, 38, 41, 46, 50, 55, 59], terrainOf = () => ({ sites });
  for (let f = 0; f < 6; f++) {
    const out = wedgeSites(f, 4, recs, terrainOf, dispersed);
    const provs = new Set(out.map(s => `${s.p},${s.q}`));
    assert.deepEqual([...provs], HL.homeRegion(f, 4, dispersed).filter(pr => pr.ring >= FIRST_TICKET_RING).map(pr => `${pr.p},${pr.q}`), 'the heartland provinces of the region, ring 1 never');
    assert.equal(out.length, 5 * 12, 'two provinces of ring 2 and three of ring 3, every site free');
    assert.ok(out.every(s => homeNation(s.p, s.q, dispersed) === f));
    assert.ok([...ringProvinces(2), ...ringProvinces(3)].some(pr => wedgeOf(pr.p, pr.q) === f && !provs.has(`${pr.p},${pr.q}`)), 'a wedge province that is another nation\'s under the placement carries no mark');
    for (const s of out) { const h = tileHex(s.p, s.q, s.tile), c = project(h.q, h.r); assert.deepEqual([s.x, s.y], [c.x, c.y]); }
    assert.deepEqual(wedgeSites(f, 4, recs, () => null, dispersed), [], 'no terrain yet: no mark');
    assert.deepEqual(wedgeSites(f, 2, recs, terrainOf, dispersed), [], 'two rings open: none yet');
  }
});

test('a first home\'s founder is named by the placement: the chronicle\'s HOME_PLACED line follows homeNation, and is left out without a seed', () => {
  const pr = ringProvinces(2).find(x => homeNation(x.p, x.q, dispersed) !== wedgeOf(x.p, x.q));
  const records = [{ record: { name: 'HOME_PLACED', bell: 7, p: pr.p, q: pr.q, site: 0, citizen_tag: 9n } }];
  const roster = { ownerOf: () => null };
  assert.equal(highlights(records, new Map(), roster)[0].faction, wedgeOf(pr.p, pr.q), 'no placement: the wedge, as before');
  assert.equal(highlights(records, new Map(), roster, { place: dispersed })[0].faction, homeNation(pr.p, pr.q, dispersed), 'the dispersed placement: the nation whose province it is');
  assert.deepEqual(highlights(records, new Map(), roster, { place: { placement: 1 } }), [], 'no seed: the line names no nation and is left out');
});

test('the call sites carry the placement from the page\'s state; the geographic wedge accounting stays where it is meant', () => {
  const app = source('app.mjs'), map = source('map/fmap.mjs'), ctl = source('controller.mjs'), spec = source('screens/spectate.mjs');
  // the page's map source: the placement beside the world's extent (map/world.mjs reads rMax and the ceiling from the same source)
  assert.match(app, /place: seasonPlace\(FS\.season\),/, 'the map source carries the season\'s placement');
  assert.match(app, /rMax: FS\.world\?\.rMax \?\? null,\n\s*rMaxCeiling: FS\.world\?\.rMaxCeiling \?\? null,/, 'and still the season\'s outermost ring and ceiling');
  // the map reads it once a frame and hands it to every painter and camera of the home region
  assert.match(map, /const place = src\.place;/);
  for (const call of ['this.wedgeHome(survey.faction, ringsOpen, place)', 'wedgeSites(survey.faction, ringsOpen, recs, terrainOf, place)', 'wedgeBox(survey.faction, ringsOpen, place)', 'paintWedge(ctx, looked, ringsOpen, z, { lit: true, place })', 'homeLook(looked, ringsOpen, place)', 'lookPoint(f, ringsOpen, place)', 'this.wedgeHome(sv.faction, Math.max(1, src.ringsOpen ?? 1), src.place)']) assert.ok(map.includes(call), call);
  assert.match(map, /paintWedge\(ctx, survey\.faction, ringsOpen, z, \{ place, wait:/);
  assert.match(map, /wedgeHome\(faction, ringsOpen, place = undefined\) \{\n\s*const key = `\$\{faction\}\|\$\{ringsOpen\}\|\$\{placeKey\(place\)\}`;/, 'the standard\'s cache is keyed by placement and seed');
  // the guide's march province and the prototype's banner provinces are the nation's, not the wedge's
  assert.match(app, /homeNation\(pq\.p, pq\.q, place\) === FS\.citizen\.faction/);
  assert.match(ctl, /homeNation\(pq\.p, pq\.q, place\) === FS\.citizen\.faction/);
  assert.match(spec, /place: seasonPlace\(FS\.season\)/);
  // the map's home modules read no wedge of their own any more
  for (const f of ['map/chart.mjs', 'map/opening.mjs', 'map/waitview.mjs', 'map/homeland.mjs']) assert.doesNotMatch(source(f), /\bwedgeOf\b/, `${f} reads homeNation through map/homeland.mjs`);
  // what stays geographic on purpose: a nation's Seat in ring 1 (map/plates.mjs), a province's side of the frontier in
  // its name (hud/place.mjs), the siege's heartland (screens/s1.mjs: the program's is_heartland_in reads the wedge),
  // the free-land count per wedge (fland.mjs freeByWedge: the program's per-wedge counters)
  assert.match(source('map/plates.mjs'), /const f = wedgeOf\(u\.p, u\.pq\);/);
  assert.match(source('hud/place.mjs'), /const w = wedgeOf\(p, q\);/);
  assert.match(source('screens/s1.mjs'), /wedgeOf\(sel\.p, sel\.q\) === Number\(mirror\.faction\)/);
  assert.match(source('fland.mjs'), /const w = wedgeOf\(pr\.p, pr\.q\);\n\s*if \(w === null\) continue;/);
});
