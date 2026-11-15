// A nation's home region on the map (map/chart.mjs wedgePaths / paintWedge, map/homeland.mjs): its paths are bounded
// whatever the world's size. One nation's region of a 129-ring world is 8,256 provinces; laid out tile by tile it was
// 3,539,136 path commands, filled, clipped to and stroked four times on every frame. No browser, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const count = { commands: 0, paths: 0 };
globalThis.Path2D = class { constructor() { count.paths++; this.n = 0; } moveTo() { count.commands++; this.n++; } lineTo() { count.commands++; this.n++; } closePath() { count.commands++; this.n++; } };
const web = '../../permutation-server/web/frontier/';
const chart = await import(`${web}map/chart.mjs`);
const H = await import(`${web}map/homeland.mjs`);
const { provincePixel, PROVINCE_CIRCUMRADIUS } = await import(`${web}map/layers.mjs`);
const { ringOf } = await import(`${web}fgeo.mjs`);
const built = fn => { count.commands = 0; count.paths = 0; const v = fn(); return { v, commands: count.commands, paths: count.paths }; };

test('a small world\'s region is laid out by its tiles, exactly as before', () => {
  const r = H.homeRegion(0, 3);
  assert.equal(r.length, 3);
  const { v, commands } = built(() => chart.wedgePaths(0, 3));
  assert.equal(commands, 1497, 'the same path, command for command'); assert.equal(v.coarse, false);
  assert.equal(chart.wedgePaths(0, 3), v, 'kept');
  assert.equal(chart.wedgeNear(v, 1, { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 }), null, 'a region laid out whole has no near paths of its own');
  // every ring count whose region is within WEDGE_TILE_PROVINCES is laid out whole
  for (const rings of [2, 4, 6, 8]) { const n = H.homeRegion(1, rings).length; assert.ok(n <= chart.WEDGE_TILE_PROVINCES); assert.equal(chart.wedgePaths(1, rings).coarse, false, `${rings} rings`); }
});

test('a wide world\'s region is outlined province by province: 59,328 commands for 8,256 provinces, not 3,539,136', () => {
  const r = H.homeRegion(0, 129);
  assert.equal(r.length, 8256);
  const { v, commands } = built(() => chart.wedgePaths(0, 129));
  assert.equal(v.coarse, true); assert.equal(v.list, r);
  assert.ok(commands <= 8256 * 7 + 8256 * 2 * 2, `${commands} commands`); assert.equal(v.fill.n, 8256 * 7, 'every province, as a hexagon');
  assert.ok(v.edge.n > 0 && v.edge.n < 8256 * 2, `the rim only: ${v.edge.n / 2} sides face a province outside the region`);
  assert.equal(built(() => chart.wedgePaths(0, 129)).commands, 0, 'kept: nothing is built again');
  // from afar, with no box, or with too many provinces in the picture: the outline alone
  const all = { x0: -2e5, y0: -2e5, x1: 2e5, y1: 2e5 };
  assert.equal(chart.wedgeNear(v, 0.0054, all), null, 'the fit view');
  assert.equal(chart.wedgeNear(v, 0.05, all), null, 'a province under WEDGE_NEAR_PX on screen');
  assert.equal(chart.wedgeNear(v, 1, null), null, 'no box');
  assert.equal(chart.wedgeNear(v, 1, all), null, 'more provinces than WEDGE_NEAR_PROVINCES in the box');
  // from near: the tiles of the provinces in the picture, and only those
  const mid = r[4000], c = provincePixel(mid.p, mid.q), zoom = 0.575, hw = 1440 / zoom / 2, hh = 900 / zoom / 2;
  const seen = { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh };
  const near = built(() => chart.wedgeNear(v, zoom, seen));
  const inBox = r.filter(pr => { const at = provincePixel(pr.p, pr.q), m = PROVINCE_CIRCUMRADIUS; return at.x >= seen.x0 - m && at.x <= seen.x1 + m && at.y >= seen.y0 - m && at.y <= seen.y1 + m; }).length;
  assert.ok(inBox >= 4 && inBox <= 40, `${inBox} provinces in a 1440 × 900 picture at zoom ${zoom}`);
  assert.equal(near.v.fill.n, inBox * 61 * 7, 'their 61 tiles each'); assert.ok(near.commands < 40 * 61 * 7 * 2);
  assert.equal(built(() => chart.wedgeNear(v, zoom, seen)).commands, 0, 'kept while the same provinces are in the picture');
  assert.equal(built(() => chart.wedgeNear(v, zoom, { ...seen, x0: seen.x0 + 3, x1: seen.x1 + 3 })).commands, 0, 'a small pan: the same provinces');
  // deep inside the region no tile side faces outside: no rim there; at the region's edge there is one
  assert.equal(near.v.edge.n, 0, 'inside the region: no rim in the picture');
  const rim = r.find(pr => pr.ring === 128), rc = provincePixel(rim.p, rim.q);
  const edgeNear = chart.wedgeNear(v, zoom, { x0: rc.x - hw, y0: rc.y - hh, x1: rc.x + hw, y1: rc.y + hh });
  assert.ok(edgeNear.edge.n > 0, 'at the outer ring: the rim, tile side by tile side');
  // a picture with none of the region's provinces: empty paths, not the whole outline in tiles
  const none = built(() => chart.wedgeNear(v, zoom, { x0: 3e5, y0: 3e5, x1: 3e5 + 2 * hw, y1: 3e5 + 2 * hh }));
  assert.equal(none.v.fill.n, 0); assert.equal(none.commands, 0);
});

test('a sparse world: the region is of the seeded rings only, and so are its box, its look and its paths', () => {
  const dense = H.homeRegion(0, 129), only = H.homeRegion(0, 129, undefined, [128]);
  assert.equal(only.length, 128, 'one nation\'s share of ring 128'); assert.ok(only.every(pr => pr.ring === 128 && ringOf(pr.p, pr.q) === 128));
  assert.notEqual(only, dense); assert.equal(H.homeRegion(0, 129, undefined, [128]), only, 'kept by its own key');
  assert.deepEqual(H.homeRegion(0, 129, undefined, [2, 128]).map(pr => pr.ring).filter((d, i, a) => a.indexOf(d) === i), [2, 128]);
  assert.deepEqual(H.homeRegion(0, 129, undefined, []), [], 'no seeded ring: no region');
  assert.equal(H.homeRegionKeys(0, 129, undefined, [128]).size, 128); assert.equal(H.homeRegionKeys(0, 129, undefined, [128]), H.homeRegionKeys(0, 129, undefined, [128]), 'the key set is kept with the region');
  // the box lies on ring 128; the dense world's box reaches the centre
  const box = H.homeBox(0, 129, undefined, [128]), wide = H.homeBox(0, 129);
  assert.ok(box.width < wide.width || box.height < wide.height); assert.equal(H.homeBox(0, 129, undefined, [128]), box);
  assert.deepEqual(H.homeLook(0, 129, undefined, { seeded: [128] }), { x: box.x, y: box.y });
  assert.equal(H.homeRegionFrom(0, 129, undefined, 2, [128]).length, 128);
  // its paths: 128 provinces is past WEDGE_TILE_PROVINCES, so the province outline; near, the tiles in the picture
  const { v, commands } = built(() => chart.wedgePaths(0, 129, undefined, [128]));
  assert.equal(v.coarse, true); assert.equal(v.fill.n, 128 * 7); assert.ok(commands < 128 * 7 + 128 * 6 * 2 + 1);
  assert.notEqual(v, chart.wedgePaths(0, 129), 'not the dense world\'s paths');
  const home = only[0], c = provincePixel(home.p, home.q);
  const near = chart.wedgeNear(v, 0.575, { x0: c.x - 1252, y0: c.y - 783, x1: c.x + 1252, y1: c.y + 783 });
  assert.ok(near.fill.n >= 61 * 7 && near.fill.n <= 12 * 61 * 7, `${near.fill.n / 427} provinces by their tiles`); assert.ok(near.edge.n > 0, 'ring 128 is all rim: inner and outer');
  // a contiguous record gives no `seeded`: the same region and paths as ever
  assert.equal(H.homeRegion(0, 3, undefined, null), H.homeRegion(0, 3));
});

test('paintWedge paints the near paths when the picture is near and the outline from afar; the map hands it the seeded rings and the picture\'s box', () => {
  const used = [];
  const g = { save() {}, restore() {}, fill(p) { used.push(['fill', p.n]); }, stroke(p) { used.push(['stroke', p.n]); }, clip() {}, scale() {}, fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) };
  const r = H.homeRegion(0, 129, undefined, [128]), c = provincePixel(r[0].p, r[0].q);
  const whole = chart.wedgePaths(0, 129, undefined, [128]);
  chart.paintWedge(g, 0, 129, 0.0054, { seeded: [128], seen: { x0: -2e5, y0: -2e5, x1: 2e5, y1: 2e5 } });
  assert.deepEqual(used.map(u => u[1]), [whole.fill.n, whole.edge.n, whole.edge.n, whole.edge.n, whole.edge.n], 'from afar: one fill and four strokes of the province outline');
  used.length = 0;
  const seen = { x0: c.x - 1252, y0: c.y - 783, x1: c.x + 1252, y1: c.y + 783 }, near = chart.wedgeNear(whole, 0.575, seen);
  chart.paintWedge(g, 0, 129, 0.575, { seeded: [128], seen, wait: { x: c.x, y: c.y, r: 900 } });
  assert.deepEqual(used.map(u => u[1]), [near.fill.n, near.edge.n, near.edge.n, near.edge.n, near.edge.n], 'from near: the tiles of the provinces in the picture');
  assert.ok(Math.max(...used.map(u => u[1])) < 20_000, 'never a path of millions of commands');
  // a small world: its one whole path, with or without a box
  used.length = 0; chart.paintWedge(g, 0, 3, 1, { seen }); assert.equal(used[0][1], chart.wedgePaths(0, 3).fill.n);
  // the wiring
  const fmap = readFileSync(new URL(`${web}map/fmap.mjs`, import.meta.url), 'utf8');
  assert.match(fmap, /paintWedge\(ctx, survey\.faction, ringsOpen, z, \{ place, seeded: src\.seeded \?\? null, seen, wait:/);
  assert.match(fmap, /paintWedge\(ctx, looked, ringsOpen, z, \{ lit: true, place, seeded: src\.seeded \?\? null, seen \}\);/);
  assert.match(fmap, /this\.wedgeHome\(survey\.faction, ringsOpen, place, src\.seeded \?\? null\)/);
});

test('a sparse world\'s anchor, look and standard are on a seeded ring, under the wedge rule and under the dispersed one; a contiguous world\'s are as before', async () => {
  const { PLACEMENT_DISPERSED } = await import(`${web}fgeo.mjs`);
  const opening = await import(`${web}map/opening.mjs`);
  const dispersed = { placement: PLACEMENT_DISPERSED, heartlandMaxRing: 3, genesisSeed: new Uint8Array(32).fill(1) };
  for (const [name, place] of [['wedge', undefined], ['dispersed', dispersed]]) for (let f = 0; f < 6; f++) {
    // contiguous (no `seeded`): ring 1 (wedge) or ring 2 (dispersed), the first province in index order, as ever
    const a0 = H.homeAnchor(f, place);
    assert.equal(ringOf(a0.p, a0.q), name === 'dispersed' ? 2 : 1, `${name} nation ${f}`);
    assert.deepEqual(H.homeAnchor(f, place, null), a0);
    // sparse [128]: a province of ring 128, one of the nation's own, in the middle of them
    const a = H.homeAnchor(f, place, [128]), region = H.homeRegion(f, 129, place, [128]);
    assert.equal(ringOf(a.p, a.q), 128, `${name} nation ${f}: on the seeded ring`);
    assert.ok(region.some(pr => pr.p === a.p && pr.q === a.q), 'a province of the nation\'s own region');
    const c = provincePixel(a.p, a.q), pts = region.map(pr => provincePixel(pr.p, pr.q));
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    assert.ok(pts.every(p => Math.hypot(p.x - mx, p.y - my) >= Math.hypot(c.x - mx, c.y - my) - 1e-6), 'the one nearest the middle of them');
    // the near look (the nation choice): the anchor province itself, on land; not a point part of the way in
    const near = H.homeLook(f, 129, place, { near: true, reach: 0.6, seeded: [128] });
    assert.deepEqual(near, { x: c.x, y: c.y });
    assert.deepEqual(opening.lookPoint(f, 129, place, [128]), { x: c.x, y: c.y });
    // the far look: the dispersed rule's anchor; the wedge rule's box, of the seeded ring's provinces
    const far = H.homeLook(f, 129, place, { seeded: [128] });
    if (name === 'dispersed') assert.deepEqual(far, { x: c.x, y: c.y });
    else { const box = H.homeBox(f, 129, place, [128]); assert.deepEqual(far, { x: box.x, y: box.y }); }
    // several seeded rings: the innermost at or beyond the rule's own ring; none there: no anchor, no look
    const two = H.homeAnchor(f, place, [128, 40]); assert.equal(ringOf(two.p, two.q), 40);
    assert.equal(H.homeAnchor(f, place, []), null); assert.equal(H.homeAnchor(f, place, [0]), null);
    assert.equal(H.homeLook(f, 129, place, { near: true, seeded: [] }), null);
    if (name === 'dispersed') { assert.equal(H.homeAnchor(f, place, [1]), null, 'the dispersed rule\'s heartland begins at ring 2'); assert.equal(H.homeLook(f, 129, place, { seeded: [1] }), null); }
    // contiguous looks are unchanged by the new argument
    assert.deepEqual(H.homeLook(f, 3, place, { near: true, reach: 0.6 }), H.homeLook(f, 3, place, { near: true, reach: 0.6, seeded: null }));
    assert.deepEqual(opening.lookPoint(f, 3, place), opening.lookPoint(f, 3, place, null));
  }
  // the wedge rule with ring 1 seeded among others: ring 1, as a contiguous world
  const a1 = H.homeAnchor(2, undefined, [1, 128]); assert.equal(ringOf(a1.p, a1.q), 1);
  // the wiring: the opening plan, the map's look and its standard are handed the seeded rings
  const fmap = readFileSync(new URL(`${web}map/fmap.mjs`, import.meta.url), 'utf8'), op = readFileSync(new URL(`${web}map/opening.mjs`, import.meta.url), 'utf8');
  assert.match(fmap, /lookPoint\(f, ringsOpen, place, src\.seeded \?\? null\) : homeLook\(f, ringsOpen, place, \{ seeded: src\.seeded \?\? null \}\)/);
  assert.match(fmap, /homeLook\(looked, ringsOpen, place, \{ seeded: src\.seeded \?\? null \}\)/);
  assert.match(fmap, /wedgeHome\(faction, ringsOpen, place = undefined, seeded = null\) \{/, 'an explicit fourth argument');
  assert.doesNotMatch(fmap, /arguments\[/, 'never read from `arguments`');
  assert.match(op, /wedgeBox\(h\.faction, rings, place, src\?\.seeded \?\? null\)/); assert.match(op, /lookPoint\(frame\.nation, rings, place, src\?\.seeded \?\? null\)/);
});

test('the standard\'s place is kept by nation, rings, placement AND seeded rings: the same rings with other seeded rings is worked out again', async () => {
  const { FrontierMap } = await import(`${web}map/fmap.mjs`);
  const m = Object.create(FrontierMap.prototype);
  const full = m.wedgeHome(0, 129, undefined, null), fullKey = m.homeKey;
  assert.ok(full && Number.isFinite(full.x));
  assert.equal(m.wedgeHome(0, 129, undefined, null), full, 'the same world: the place kept');
  assert.equal(m.wedgeHome(0, 129), full, 'no fourth argument is a contiguous world'); assert.equal(m.homeKey, fullKey);
  // the same 129 rings, now a world that seeds ring 128 alone: another key, another place, on ring 128
  const sparse = m.wedgeHome(0, 129, undefined, [128]);
  assert.notEqual(m.homeKey, fullKey); assert.match(m.homeKey, /\|128$/);
  assert.notDeepEqual(sparse, full, 'worked out again');
  const box = H.homeBox(0, 129, undefined, [128]);
  assert.ok(Math.hypot(sparse.x - box.x, sparse.y - box.y) < 120, 'the tile at the middle of the seeded ring\'s region');
  assert.ok(Math.hypot(sparse.x, sparse.y) > Math.hypot(full.x, full.y), 'further out than the full wedge\'s middle');
  assert.equal(m.wedgeHome(0, 129, undefined, [128]), sparse, 'kept while nothing changes');
  // other seeded rings again, another nation, back to the full world: each its own
  const two = m.wedgeHome(0, 129, undefined, [40, 128]); assert.match(m.homeKey, /\|40,128$/); assert.notDeepEqual(two, sparse);
  assert.notDeepEqual(m.wedgeHome(3, 129, undefined, [128]), sparse);
  assert.deepEqual(m.wedgeHome(0, 129, undefined, null), full); assert.equal(m.homeKey, fullKey);
  // a sparse world with no ring for the region: no standard
  assert.equal(m.wedgeHome(0, 129, undefined, []), null);
  // a small world is as before
  const small = m.wedgeHome(0, 3); assert.ok(small); assert.deepEqual(m.wedgeHome(0, 3, undefined, null), small);
});
