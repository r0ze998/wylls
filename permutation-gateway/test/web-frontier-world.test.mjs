// The world's extent (map growth; permutation-server/web/frontier/map/world.mjs
// and the herald's /h/world/ring/{d}). The rule: what a place IS comes before
// what the viewer has seen of it —
//   outside (ring > rMax) · unopened (ring not opened) · pending (ring opened,
//   seed or Province on its way) · open (on chain; fog is then the survey's)
// and an older herald without ringsOpened / ringProvinces still answers
// open / unopened exactly as before.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { locate, ringOf, ringProvinces, ringSize } from '../../permutation-server/web/frontier/fgeo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const rings = n => Array.from({ length: n }, (_, d) => ({ d, seed: '00' }));
// rings 0–4 seeded, ring 5 opened (its seed on its way), the map ends at ring 6
const REC = { rings: rings(5), ringsOpened: 6, rMax: 6, ringProvinces: [1, 6, 12, 18, 24] };

test('the four states of a place, from the season record', () => {
  const w = W.worldOf(REC);
  assert.deepEqual(w, { ringsOpen: 5, ringsOpened: 6, rMax: 6, ringProvinces: [1, 6, 12, 18, 24] });
  assert.equal(W.placeOf(w, 0, 0), 'open');
  assert.equal(W.placeOf(w, 4, 0), 'open');
  assert.equal(W.placeOf(w, 5, 0), 'pending', 'ring 5 opened, seed on its way');
  assert.equal(W.placeOf(w, 6, 0), 'unopened', 'inside rMax, not opened');
  assert.equal(W.placeOf(w, 7, 0), 'outside', 'beyond rMax');
  assert.equal(W.placeOf(w, -3, -4), 'outside', 'every direction');
});

test('an older herald (no ringsOpened, no ringProvinces) answers as before', () => {
  const w = W.worldOf({ rings: rings(5), rMax: 16 });
  assert.equal(w.ringsOpened, 5);
  assert.equal(W.placeOf(w, 4, 0), 'open');
  assert.equal(W.placeOf(w, 5, 0), 'unopened');
  assert.equal(W.placeOf(W.worldOf({ rings: rings(5) }), 99, 0), 'unopened', 'no rMax: nothing is called outside');
  assert.equal(W.placeNow({}, 1, 0), null, 'no season record: the caller keeps its own answer');
});

test('a ring partly on chain: its missing Provinces are pending once its list is known', () => {
  const rec = { rings: rings(6), ringsOpened: 6, rMax: 16, ringProvinces: [1, 6, 12, 18, 24, 28] };
  const w = W.worldOf(rec);
  assert.deepEqual(W.partialRings(w), [5]);
  const ring5 = ringProvinces(5).map(c => `${c.p},${c.q}`);
  const present = new Set(ring5.slice(2));
  const [a, b] = ring5.slice(0, 2).map(k => k.split(',').map(Number));
  assert.equal(W.placeOf(w, a[0], a[1]), 'open', 'without the list the herald decides');
  assert.equal(W.placeOf(w, a[0], a[1], d => (d === 5 ? present : null)), 'pending');
  assert.equal(W.placeOf(w, b[0], b[1], d => (d === 5 ? present : null)), 'pending');
  const [c] = ring5.slice(2, 3).map(k => k.split(',').map(Number));
  assert.equal(W.placeOf(w, c[0], c[1], d => (d === 5 ? present : null)), 'open');
  assert.deepEqual(W.partialRings(W.worldOf({ ...rec, ringProvinces: [1, 6, 12, 18, 24, 30] })), [], 'whole again');
});

test('the season border: the outward sides of ring rMax, 12·rMax + 6 of them, each facing a ring beyond', () => {
  for (const R of [1, 2, 4, 6, 16]) {
    const segs = W.edgeSegments(R);
    assert.equal(segs.length, 12 * R + 6, `rMax ${R}`);
    for (const [x0, y0, x1, y1] of segs) {
      // the middle of a border side is shared by a province of ring R and one beyond
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const inner = W.hexAtPixel(mx * 0.98, my * 0.98), outer = W.hexAtPixel(mx * 1.02, my * 1.02);
      const ri = ringOf(locate(inner.q, inner.r).p, locate(inner.q, inner.r).q), ro = ringOf(locate(outer.q, outer.r).p, locate(outer.q, outer.r).q);
      assert.ok(ri <= R && ro > R, `rMax ${R}: side at ${mx.toFixed(0)},${my.toFixed(0)} rings ${ri}/${ro}`);
    }
  }
  assert.deepEqual(W.edgeSegments(null), []);
  assert.equal(W.edgeNear(6, 5), true, 'two rings past the open land');
  assert.equal(W.edgeNear(16, 5), false, 'far off the sheet');
  assert.equal(W.edgeNear(null, 5), false);
});

test('the words: each state says itself, in both languages', () => {
  assert.equal(W.ringText('outside', 7), '第7輪（このシーズンの地図の外）');
  assert.equal(W.ringText('unopened', 6), '第6輪（まだひらいていません）');
  assert.equal(W.ringText('pending', 5), '第5輪（生まれるところです）');
  assert.equal(W.ringText('open', 4), '第4輪');
  assert.equal(W.PLACE_NOTE.outside(), 'ここはこのシーズンの地図の外です');
  assert.equal(W.PLACE_NOTE.unopened(), 'まだひらいていない土地です');
  setLang('en');
  assert.equal(W.ringText('outside', 7), 'Ring 7 (outside this season’s map)');
  assert.equal(W.ringText('pending', 5), 'Ring 5 (being made)');
  assert.equal(W.PLACE_NOTE.outside(), 'This is outside this season’s map');
  assert.equal(W.PLACE_NOTE.pending(), 'This land is being made (a moment, please)');
});

test('the inspector names the state of the ring under the selection', () => {
  const FS = { record: REC, world: W.worldOf(REC), selected: { p: 7, q: 0 }, mode: 'play' };
  assert.equal(inspect.inspectModel(FS, null).place, 'outside');
  assert.match(String(inspect.render(FS, null)), /第7輪（このシーズンの地図の外）/);
  FS.selected = { p: 6, q: 0 };
  assert.match(String(inspect.render(FS, null)), /第6輪（まだひらいていません）/);
  FS.selected = { p: 5, q: 0 };
  assert.match(String(inspect.render(FS, null)), /第5輪（生まれるところです）/);
  FS.selected = { p: 3, q: 0 };
  const m = inspect.inspectModel(FS, null);
  assert.equal(m.place, 'open');
  assert.equal(m.opened, true, 'open land: the survey chip (未測量 / 測量済み) speaks for the fog');
});

test('the herald client reads a ring list and refuses a province outside the ring', async () => {
  const ok = { v: 1, d: 5, seed: 'seeded', size: 30, provinces: [{ p: 5, q: 0, region: 3, wedge: 0, openedBell: 12 }, { p: 4, q: 1, region: 1, wedge: 0, openedBell: 12 }] };
  const answer = body => async url => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer, url });
  const h = createHerald({ fetch: answer(ok) });
  const r = await h.worldRing(5);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...r.present].sort(), ['4,1', '5,0']);
  const bad = createHerald({ fetch: answer({ ...ok, provinces: [{ p: 1, q: 0 }] }) });
  assert.equal((await bad.worldRing(5)).ok, false);
  assert.equal(ringSize(5), 30);
});
