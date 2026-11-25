// The opening world view of a big world (fix-opening-view-perf): a `--wide --operator-residents 5` world shows about
// 13,800 provinces at zoom 0.02 before joining. Its frames had to fit three stores and two whole-view passes: the
// terrain store (map/terrain.mjs, its own test: web-frontier-terrain-frame), the far bitmaps (FAR_RES / FAR_PIXELS), the
// realms (buildRealms read 61 tiles of every province each time the view moved) and the survey (province() read 61
// tiles and their rims of every province each time the survey was made). The pictures are the same. No browser, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { buildRealms, realmNeighbourhood, REALM_REACH, FAR_RES, FAR_RES_FALLBACK, FAR_PIXELS, farRes, farResFor, farSize } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { PROVINCE_CIRCUMRADIUS } from '../../permutation-server/web/frontier/map/layers.mjs';
import { DIRECTIONS, hexDistance, locate, ringProvinces, tileHex, PROVINCE_TILES } from '../../permutation-server/web/frontier/fgeo.mjs';
import { RADIUS } from '../../permutation-server/web/map.mjs';

/** survey.province as it was before the shortcut: every tile and its rim read (map/survey.mjs, main fa184b720). */
function provinceSlow(sv, p, q) {
  let max = S.L1, min = S.L3, near = false, rim = S.L3, sig = '', sig2 = '';
  for (let i = 0; i < PROVINCE_TILES; i++) {
    const h = tileHex(p, q, i);
    const lv = sv.tiles.get(S.hexKey(h.q, h.r)) ?? S.L1;
    if (lv > max) max = lv;
    if (lv < min) min = lv;
    sig += lv; sig2 += lv >= S.L2 ? 1 : 0;
    for (const [dq, dr] of DIRECTIONS) {
      const nq = h.q + dq, nr = h.r + dr, at = locate(nq, nr);
      if (at.p === p && at.q === q) continue;
      const nl = sv.levelAt(nq, nr);
      if (nl >= S.L2) near = true;
      if (nl !== S.L0 && nl < rim) rim = nl;
      sig += nl; sig2 += nl >= S.L2 ? 1 : 0;
    }
  }
  const kind = max < S.L2 && !near ? 'chart' : min === S.L3 && rim === S.L3 ? 'sight' : 'mixed';
  return kind === 'chart' ? { kind, max, min, sig: '1', sig2: '1' } : kind === 'sight' ? { kind, max, min, sig: '3', sig2: '3' } : { kind, max, min, sig, sig2 };
}

test('survey.province: a province with no surveyed tile in it or on its rim is the chart at once, and every answer is the one the full read gives', () => {
  const rings = 7, provinces = []; for (let d = 0; d < rings; d++) provinces.push(...ringProvinces(d));
  // nothing surveyed (the opening view before joining): every open province is the chart
  const none = S.buildSurvey({ ringsOpen: rings, anchors: [] });
  for (const { p, q } of provinces) assert.deepEqual(none.province(p, q), provinceSlow(none, p, q), `${p},${q}`);
  // sight, a surveyed memory and a survey that reaches one tile over a province's border (its neighbour's rim)
  const a = tileHex(3, -1, 30), b = tileHex(-2, 4, 0), edge = tileHex(1, 1, 60);
  const memory = new Set(); for (let i = 0; i < PROVINCE_TILES; i += 5) { const h = tileHex(-4, 2, i); memory.add(S.hexKey(h.q, h.r)); }
  const sv = S.buildSurvey({ ringsOpen: rings, anchors: [{ q: a.q, r: a.r, radius: 6, level: S.L3 }, { q: b.q, r: b.r, radius: 3, level: S.L2 }, { q: edge.q, r: edge.r, radius: 0, level: S.L3 }], memory });
  const kinds = {};
  for (const { p, q } of provinces) { const got = sv.province(p, q); kinds[got.kind] = (kinds[got.kind] ?? 0) + 1; assert.deepEqual(got, provinceSlow(sv, p, q), `${p},${q}`); }
  assert.ok(kinds.chart > 0 && kinds.mixed > 0, JSON.stringify(kinds));
  // a ring that is not open is cloud, as before
  assert.equal(sv.province(ringProvinces(rings)[0].p, ringProvinces(rings)[0].q).kind, 'cloud');
});

const NAMES = ['Grassland', 'Plains', 'Forest', 'Hills', 'Mountain', 'Water'];
const terrainOf = (p, q) => ({ terrain: Array.from({ length: PROVINCE_TILES }, (_, i) => ((i * 7 + p * 3 + q) % 11 === 0 ? 5 : (i + p + q) % 4)), sites: [7, 20, 45, 3], names: NAMES });
const held = (p, q, owners) => ({ p, q, ...terrainOf(p, q), rec: { owners: [...owners, 7, 7, 7, 7, 7, 7, 7, 7], sites: owners.map(f => (f < 6 ? 1 : 0)).concat([0, 0, 0, 0, 0, 0, 0, 0]) }, tiers: [1, 2, 0, 3] });
class Rec { constructor() { this.ops = []; } moveTo(x, y) { this.ops.push(['m', x, y]); } lineTo(x, y) { this.ops.push(['l', x, y]); } closePath() { this.ops.push(['z']); } }
const picture = R => JSON.stringify({ fill: R.fill.map(f => f?.ops ?? null), edge: R.edge.map(f => f?.ops ?? null), holdings: R.holdings });

test('buildRealms reads only the provinces a realm can touch, and draws the same realms', () => {
  const was = globalThis.Path2D; globalThis.Path2D = Rec;
  try {
    const all = []; for (let d = 0; d < 9; d++) for (const { p, q } of ringProvinces(d)) all.push({ p, q, ...terrainOf(p, q) });
    // the opening view: nothing held anywhere: nothing to read
    assert.deepEqual(realmNeighbourhood(all), []);
    const empty = buildRealms(all, { grow: 1 });
    assert.deepEqual([empty.fill.length, empty.edge.length, empty.holdings.length], [0, 0, 0]);
    // two nations' holdings in two places, and one province of held territory tiles
    const at = (p, q) => all.findIndex(e => e.p === p && e.q === q);
    all[at(2, 0)] = held(2, 0, [0, 4, 7, 0]);
    all[at(-1, 3)] = held(-1, 3, [7, 2, 2, 7]);
    const tp = all[at(5, -5)]; all[at(5, -5)] = { ...tp, territoryMode: true, territory: { owners: Array.from({ length: PROVINCE_TILES }, (_, i) => (i % 3 ? 1 : null)) } };
    const near = realmNeighbourhood(all);
    assert.ok(near.length > 20 && near.length < all.length / 2, `${near.length} of ${all.length}`);
    // every province within two of a seed is in, every one further than three is out (province lattice distance)
    const seeds = [[2, 0], [-1, 3], [5, -5]], dist = e => Math.min(...seeds.map(([p, q]) => hexDistance(p, q, e.p, e.q)));
    for (const e of all) { if (dist(e) <= 2) assert.ok(near.includes(e), `${e.p},${e.q} near`); if (dist(e) > 3) assert.ok(!near.includes(e), `${e.p},${e.q} far`); }
    // the same realms as from every province of the view, with and without the viewer's own village, and grown or not
    const within = all.filter(e => dist(e) <= 3);
    for (const opts of [{ grow: 1 }, { grow: 0 }, { grow: 1, own: new Set(['2,0,7']) }]) {
      const a = buildRealms(all, opts), b = buildRealms(within, opts);
      assert.equal(picture(a), picture(b), JSON.stringify(opts));
      assert.ok(a.fill[0] && a.fill[2] && a.fill[4] && a.fill[1], 'the holdings and the held tiles are washed');
    }
  } finally { globalThis.Path2D = was; }
  assert.ok(REALM_REACH > 1.9 * PROVINCE_CIRCUMRADIUS * Math.sqrt(3));
});

test('the far bitmaps of the opening world view fit their store at once (no drop and paint again every frame)', () => {
  // the opening view: zoom 0.02 on a ground canvas at 1.4 px per CSS px (map/fmap.mjs groundRatio), 13,834 provinces
  const res = farRes(0.02 * 1.4);
  assert.ok(res < 0.1 && FAR_RES.includes(res), `res ${res}`);
  const half = PROVINCE_CIRCUMRADIUS * 1.08 + RADIUS * 1.6, px = Math.max(8, Math.ceil(2 * half * res)) ** 2;
  assert.ok(13834 * px < FAR_PIXELS, `${13834 * px} px against ${FAR_PIXELS}`);
  // (at 0.1, the smallest step before, only 3,029 of them fitted: the store dropped and painted again every frame)
  assert.ok(13834 * Math.ceil(2 * half * 0.1) ** 2 > FAR_PIXELS);
  // a bitmap is never coarser than the screen: every step is at least 0.85 of the pixels it is shown at
  for (const z of [0.012, 0.02, 0.03, 0.05, 0.1, 0.3]) assert.ok(farRes(z * 1.4) >= z * 1.4 * 0.85, `zoom ${z}`);
});

test('a far view too big for FAR_PIXELS at its step falls back to a smaller one (2 device px per CSS px, a wide page)', () => {
  // verify-pr239: on a screen of 2 device px per CSS px the ground canvas is 2 px per CSS px (no GROUND_FINER), the
  // opening view asks for step 0.05: ~14,200 bitmaps of 45x45 px, ~29M px against 24M, dropped and painted again
  // every frame (0.6 frames a second on the page)
  assert.equal(farRes(0.02 * 2), 0.05);
  assert.ok(14243 * farSize(0.05) ** 2 > FAR_PIXELS);
  const res = farResFor(0.02 * 2, 14243);
  assert.ok(res < 0.05 && 14243 * farSize(res) ** 2 <= FAR_PIXELS, `res ${res}`);
  // the widest far view (the coarse chart's edge, about 41,000 provinces: map/terrain.mjs) fits only at a fallback step
  const wide = farResFor(0.012 * 1.4, 41000);
  assert.ok(FAR_RES_FALLBACK.includes(wide) && 41000 * farSize(wide) ** 2 <= FAR_PIXELS, `res ${wide}`);
  // a view that fits keeps farRes exactly (the look of every view that fitted before is unchanged)
  for (const dpr of [1, 1.4, 2]) for (const z of [0.02, 0.03, 0.05, 0.1, 0.2, 0.4]) {
    const n = Math.floor(FAR_PIXELS / farSize(farRes(z * dpr)) ** 2);
    assert.equal(farResFor(z * dpr, n), farRes(z * dpr), `zoom ${z} dpr ${dpr} with ${n} provinces`);
    assert.equal(farResFor(z * dpr, 0), farRes(z * dpr));
  }
  // the fallback steps are never chosen by farRes alone, and the smallest step is the floor
  for (const r of FAR_RES_FALLBACK) assert.ok(!FAR_RES.includes(r));
  assert.equal(farResFor(0.02, 1e9), FAR_RES_FALLBACK[0]);
});
