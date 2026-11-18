// fix-stale-tooltip (2026-11-19): the real-client six-nation video showed "The list of villages in this ring is not
// loaded (select a province to load it again)" twice over the World chart for the whole 85 s. Those were rings 0 and 1,
// which the natural world's herald refuses (404 NoSuchRing, PR #46): the overview queue stopped asking for them, but the
// page's FS.overviewMisses still held them, and readMarksNow put the words on each ring's first province for ever.
// map/overviews.mjs ringMissMarks now decides which ring misses are said: never a refused ring, never a ring outside the
// open land, never one whose overview is held, and only the ring the person is looking at, on the place looked at.
//
// THIS FILE MAKES NO KEY: the overview queue over an injected read-only herald stand-in. No page, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOverviews, ringMissMarks } from '../../permutation-server/web/frontier/map/overviews.mjs';
import { worldOf } from '../../permutation-server/web/frontier/map/world.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';

const liveRecord = (ringProvinces = [1, 6, 12, 18, 24]) => ({ rings: ringProvinces.map((_, i) => ({ seed: String(i + 1).repeat(64) })), ringProvinces });
/** rings 0 and 1 refused (404 → client NotFound), ring 3 failing transiently (network), the others served. */
function herald({ refused = new Set([0, 1]), failing = new Set([3]) } = {}) {
  const answer = ring => refused.has(ring) ? { ok: false, code: 'NotFound', httpStatus: 404 }
    : failing.has(ring) ? { ok: false, code: 'Network', error: 'fetch failed' } : { ok: true, ring, bell: 0, provinces: [] };
  return { refused, failing, h: { overview: async r => answer(r), overview2: async r => answer(r) } };
}
const KEY = 'w#1';
const stateOf = record => ({ world: worldOf(record), overviews: new Map(), holdings: [] });
/** what app.mjs loadOverviews notes after a read: the asked rings still without an overview (any reason) */
const note = (FS, asked) => {
  const rings = FS.overviewMisses?.rings ?? new Map();
  for (const d of asked) if (!FS.overviews.has(d)) rings.set(d, ringProvinces(d)[0]); else rings.delete(d);
  FS.overviewMisses = { world: KEY, rings };
};
const at = d => ringProvinces(d)[0];

async function boot() {
  const FS = stateOf(liveRecord()), s = herald();
  await readOverviews(FS, { herald: s.h, v2: true });
  note(FS, [0, 1, 2, 3, 4]);
  assert.deepEqual([...FS.overviewMisses.rings.keys()].sort(), [0, 1, 3], 'the misses as before: refused 0, 1 and the failed 3');
  return { FS, s };
}

test('nothing looked at: no ring label at all (the World chart of the video)', async () => {
  const { FS } = await boot();
  assert.deepEqual(ringMissMarks(FS, { key: KEY, looking: [] }), []);
  assert.deepEqual(ringMissMarks(FS, { key: KEY }), []);
});

test('a ring the herald refused (NoSuchRing) is never labelled, even when looked at', async () => {
  const { FS } = await boot();
  assert.deepEqual(ringMissMarks(FS, { key: KEY, looking: [at(0), at(1), ringProvinces(1)[3]] }), []);
});

test('a transient miss is said only on the ring looked at, on the place looked at, once per ring', async () => {
  const { FS } = await boot();
  const a = ringProvinces(3)[2], b = ringProvinces(3)[5];
  assert.deepEqual(ringMissMarks(FS, { key: KEY, looking: [a, b, at(2)] }), [{ p: a.p, q: a.q, ring: 3 }]);
});

test('the label goes once the quiet retry brings the overview', async () => {
  const { FS, s } = await boot();
  const a = ringProvinces(3)[0];
  assert.equal(ringMissMarks(FS, { key: KEY, looking: [a] }).length, 1);
  s.failing.delete(3);
  await readOverviews(FS, { herald: s.h, v2: true });            // the season poll's quiet retry (overviewRings: 3 is still wanted)
  assert.ok(FS.overviews.has(3));
  assert.deepEqual(ringMissMarks(FS, { key: KEY, looking: [a] }), [], 'held: no label, even before the miss list is noted again');
  note(FS, [3]);
  assert.equal(FS.overviewMisses.rings.has(3), false);
});

test('outside the open land, or another world: no label', async () => {
  const { FS } = await boot();
  FS.overviewMisses.rings.set(7, at(7));                          // a stale entry for a ring past ringsOpen (5)
  assert.deepEqual(ringMissMarks(FS, { key: KEY, looking: [at(7)] }), []);
  assert.deepEqual(ringMissMarks(FS, { key: 'other#2', looking: [at(3)] }), [], 'misses noted in another pinned world');
  assert.deepEqual(ringMissMarks({ ...FS, world: null }, { key: KEY, looking: [at(3)] }), []);
  assert.deepEqual(ringMissMarks(FS, { key: KEY, looking: [null, { p: 1.5, q: 0 }] }), []);
});
