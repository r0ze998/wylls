// Map growth and dispersed placement, end to end on the page's side
// (workstream 08): the herald's season record → the decoded Season → the
// join panel's candidates; the place states of a season with an extension
// ceiling (open · pending · unopened · extendable · beyondCeiling ·
// beyondHard) and the unchanged four of every other season; a march planned
// by the rules module (frontier.wasm) from an inner province into a ring
// added by ExtendFrontier; the hex keys of the program's outermost ring.
// The map is bounded (ring 128 at most): nothing here is "infinite".
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import * as Wasm from '../../permutation-server/web/frontier/wasm.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { homeNation, ringProvinces, ringOf, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { planHomes, seasonPlace } from '../../permutation-server/web/frontier/home.mjs';
import { planRoute } from '../../permutation-server/web/frontier/fmarch.mjs';
import { hexKey, keyHex } from '../../permutation-server/web/frontier/map/survey.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const SEASON_ID = 71;
/** A v2 Season account as the program writes it: the fields this path reads. */
function seasonBytes({ placement = 0, ceiling = 0, seed = 1, hmr = 3, rMax = 6 } = {}) {
  const b = new Uint8Array(2048);
  b.set([...'PSF1SEAS'].map(c => c.charCodeAt(0)), 0);
  new DataView(b.buffer).setBigUint64(8, BigInt(SEASON_ID), true);
  b[16] = 2; b[17] = 0;
  new DataView(b.buffer).setUint16(138, 4, true);
  new DataView(b.buffer).setUint16(68, rMax, true);
  b.fill(seed, 240, 272);
  b[896 + 1] = hmr; b[896 + 77] = placement;
  new DataView(b.buffer).setUint16(896 + 78, ceiling, true);
  return b;
}
/** The herald's /h/season record around those bytes (views.rs season_json). */
const record = (opts = {}) => ({
  v: 1, season: String(SEASON_ID), rMax: opts.rMax ?? 6, rings: Array.from({ length: 4 }, (_, d) => ({ d, seed: '00'.repeat(32) })),
  ringsOpened: 4, ringProvinces: [1, 6, 12, 18], placement: opts.placement ?? 0, heartlandMaxRing: 3, rMaxCeiling: opts.ceiling ?? 0,
  rMaxHard: 128, prizeMaxRing: 17, genesisSeed: '01'.repeat(32), bytes_b64: Buffer.from(seasonBytes(opts)).toString('base64'),
});
const fetchOf = rec => async url => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => rec, text: async () => JSON.stringify(rec), arrayBuffer: async () => new ArrayBuffer(0), url });

const province = (p, q) => ({ p, q, siteCount: 2, sites: [5, 14], siteMirror: [{ state: 0, gen: 0 }, { state: 0, gen: 0 }], ticketCohorts: [] });
const overviews = () => new Map([2, 3].map(ring => [ring, { ring, provinces: ringProvinces(ring).map(p => ({ ...p, sites: [0, 0], owners: [7, 7] })) }]));
// permutation-rules home_nation_dispersed_pinned_vector (seed 1, rings 2 and 3)
const PINNED = [4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4];

test('the herald\'s season record carries the placement and seed the join panel uses (placement 1)', async () => {
  const h = createHerald({ base: 'http://h', fetch: fetchOf(record({ placement: 1, ceiling: 9 })) });
  const r = await h.season();
  assert.ok(r.ok, String(r.code));
  const place = seasonPlace(r.season);
  assert.equal(place.placement, 1);
  assert.equal(place.heartlandMaxRing, 3);
  const cells = [...ringProvinces(2), ...ringProvinces(3)];
  assert.deepEqual(cells.map(c => homeNation(c.p, c.q, place)), PINNED, 'the program\'s rule, from the decoded Season');
  for (let f = 0; f < 6; f++) {
    const got = await planHomes({ overviews: overviews(), read: async (p, q) => province(p, q), faction: f, ringsOpen: 4, seed: 'x', place, max: 5 });
    assert.equal(got.candidates.length, 5);
    for (const s of got.candidates) assert.equal(PINNED[cells.findIndex(c => c.p === s.p && c.q === s.q)], f);
    assert.ok(new Set(got.candidates.map(s => wedgeOf(s.p, s.q))).size >= 3, 'small groups in several wedges');
  }
  assert.equal(r.record.placement, 1);
  assert.equal(r.record.genesisSeed, '01'.repeat(32));
});

test('placement 0 (every season before the parameter): the wedge rule, unchanged', async () => {
  const h = createHerald({ base: 'http://h', fetch: fetchOf(record()) });
  const r = await h.season();
  assert.equal(seasonPlace(r.season), undefined);
  const got = await planHomes({ overviews: overviews(), read: async (p, q) => province(p, q), faction: 2, ringsOpen: 4, seed: 'x', place: seasonPlace(r.season), max: 5 });
  assert.ok(got.candidates.length > 0 && got.candidates.every(s => wedgeOf(s.p, s.q) === 2));
});

const rings = n => Array.from({ length: n }, (_, d) => ({ d, seed: '00' }));

test('a season with a ceiling: extendable, beyond the ceiling and beyond ring 128 are told apart', () => {
  const w = W.worldOf({ rings: rings(7), ringsOpened: 7, rMax: 6, rMaxCeiling: 9, rMaxHard: 128, ringProvinces: [1, 6, 12, 18, 24, 30, 36] });
  assert.equal(w.rMaxCeiling, 9);
  assert.equal(W.placeOf(w, 6, 0), 'open');
  assert.equal(W.placeOf(w, 7, 0), 'extendable');
  assert.equal(W.placeOf(w, 9, 0), 'extendable');
  assert.equal(W.placeOf(w, 10, 0), 'beyondCeiling');
  assert.equal(W.placeOf(w, 129, 0), 'beyondHard');
  // after ExtendFrontier(7): ring 7 is on the map (not opened yet), ring 8 may still be added
  const up = W.worldOf({ rings: rings(7), ringsOpened: 7, rMax: 7, rMaxCeiling: 9, ringProvinces: [1, 6, 12, 18, 24, 30, 36] });
  assert.equal(W.placeOf(up, 7, 0), 'unopened');
  assert.equal(W.placeOf(up, 8, 0), 'extendable');
  // the ceiling reached: nothing extendable any more
  const top = W.worldOf({ rings: rings(10), ringsOpened: 10, rMax: 9, rMaxCeiling: 9 });
  assert.equal(top.rMaxCeiling, undefined);
  assert.equal(W.placeOf(top, 10, 0), 'outside');
});

test('without a ceiling every season keeps its four states and its old words', () => {
  for (const ceiling of [undefined, 0, 6, 3]) {
    const w = W.worldOf({ rings: rings(5), ringsOpened: 6, rMax: 6, rMaxCeiling: ceiling, ringProvinces: [1, 6, 12, 18, 24] });
    assert.deepEqual(Object.keys(w), ['ringsOpen', 'ringsOpened', 'rMax', 'ringProvinces']);
    assert.equal(W.placeOf(w, 7, 0), 'outside');
    assert.equal(W.placeOf(w, 200, 0), 'outside');
  }
});

test('the words of the new states, in both languages; the hard limit is named as ring 128', () => {
  assert.equal(W.ringText('extendable', 8), '第8輪（広げられるが、まだ地図の外）');
  assert.equal(W.ringText('beyondCeiling', 10), '第10輪（このシーズンの上限の外）');
  assert.equal(W.ringText('beyondHard', 129), '第129輪（プログラムの上限・第128輪の外）');
  assert.match(W.PLACE_NOTE.extendable(), /広げられます/);
  setLang('en');
  assert.equal(W.ringText('extendable', 8), 'Ring 8 (may be added, not on the map yet)');
  assert.equal(W.ringText('beyondCeiling', 10), 'Ring 10 (beyond this season’s limit)');
  assert.equal(W.ringText('beyondHard', 129), 'Ring 129 (beyond the program’s limit, ring 128)');
  assert.equal(W.PLACE_NOTE.beyondHard(), 'This is beyond the program’s limit (ring 128)');
  for (const k of ['extendable', 'beyondCeiling', 'beyondHard']) assert.doesNotMatch(W.PLACE_NOTE[k]() + W.ringText(k, 1), /[ぁ-んァ-ン一-龯]|infinite/i);
});

test('the ceiling\'s border: drawn faint from the same sides as the season border', () => {
  assert.equal(W.edgeSegments(9).length, 12 * 9 + 6);
  const calls = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { calls.push([this.strokeStyle, this.lineWidth]); }, setLineDash() {} };
  W.paintEdge(ctx, W.edgeSegments(9), 1, { faint: true });
  assert.equal(calls[1][1], 1.5);
  W.paintEdge(ctx, W.edgeSegments(6), 1);
  assert.equal(calls[3][1], 2.5);
});

test('the program\'s outermost ring fits the page\'s hex keys (ring 128 is far inside ±2047)', () => {
  for (const { p, q } of ringProvinces(128).filter((_, i) => i % 64 === 0)) {
    // the province's centre P·(9,−4) + Q·(4,5) and a tile four hexes off it
    const cq = 9 * p + 4 * q, cr = -4 * p + 5 * q;
    for (const [dq, dr] of [[0, 0], [4, 0], [-4, 4], [0, -4]]) assert.deepEqual(keyHex(hexKey(cq + dq, cr + dr)), { q: cq + dq, r: cr + dr });
  }
});

const WASM = new URL('../../permutation-server/web/frontier/wasm/frontier.wasm', import.meta.url);
test('a march across the old edge: the rules module routes from ring 4 into ring 5 once ring 5 is seeded', async t => {
  if (!existsSync(WASM)) { t.skip('frontier.wasm not built'); return; }
  const bytes = readFileSync(WASM);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const k = await Wasm.loadKernel({ url: WASM.href, sha256Hex: sha, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
  const seeds = d => Array.from({ length: d }, (_, r) => ({ ring: r, seed: createHash('sha256').update(`ring${r}`).digest('hex') }));
  let crossed = null;
  for (let a = 0; a < 61 && !crossed; a += 5) for (let b = 0; b < 61 && !crossed; b += 5) {
    const r = planRoute(k, { from: { p: 4, q: 0, tile: a }, to: { p: 5, q: 0, tile: b }, unit: 0, seeds: seeds(6) });
    if (r.ok) crossed = r.route;
  }
  assert.ok(crossed, 'some tile of ring 4 reaches ring 5 once its seed is known');
  assert.deepEqual(crossed.provinces.map(x => ringOf(x.p, x.q)), [4, 5], 'from ring 4 into the extended ring 5');
  // without ring 5's seed (the ring not opened yet) the planner has no land there
  const none = planRoute(k, { from: { p: 4, q: 0, tile: 0 }, to: { p: 5, q: 0, tile: 30 }, unit: 0, seeds: seeds(5) });
  assert.equal(none.ok, false);
});
