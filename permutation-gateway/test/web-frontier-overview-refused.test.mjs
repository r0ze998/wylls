// PR #46 round 3 (2026-11-18, the verifier's live natural world): the season record opens rings 0..4 with no `d` on its
// rings — so the page's world model (map/world.mjs) has no `seeded` list and holds every ring 0..4 seeded — but the
// herald serves no overview of rings 0 and 1: `/h/overview{,2}/{0,1}/latest.bin` → 404 {"code":"NoSuchRing"} (the
// client's `NotFound`). The page asked again on every refresh (125 times each in 15 min), and the reach list waited for
// those rings for ever. Now the overview queue remembers a ring the herald refused under the extent it was refused under:
// `overviewRefused` says so, the ring is not asked again while that extent stands, and an explicit re-read or a changed
// extent asks again.
//
// THIS FILE MAKES NO KEY: the overview queue over an injected read-only herald stand-in. No page, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readOverviews, overviewRefused, forgetOverviewRefusals } from '../../permutation-server/web/frontier/map/overviews.mjs';
import { worldOf, ringSeeded } from '../../permutation-server/web/frontier/map/world.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** The LIVE natural world's season record shape: five rings, none carrying `d`. */
const liveRecord = (ringProvinces = [1, 6, 12, 18, 24]) => ({ rings: ringProvinces.map((_, i) => ({ seed: String(i + 1).repeat(64) })), ringProvinces });
/** The herald as the live one answered: rings 0 and 1 refused with 404 (client `NotFound`), the others served. */
function herald(refused = new Set([0, 1])) {
  const calls = [];
  const answer = ring => (refused.has(ring) ? { ok: false, code: 'NotFound', error: 'HTTP 404', httpStatus: 404 } : { ok: true, ring, bell: 0, provinces: [] });
  return { calls, refused, h: { overview: async ring => { calls.push(['v1', ring]); return answer(ring); }, overview2: async ring => { calls.push(['v2', ring]); return answer(ring); } } };
}
const stateOf = record => ({ world: worldOf(record), overviews: new Map(), holdings: [] });

test('the live record shape: no `seeded`, every ring 0..4 counts as seeded to the page', () => {
  const w = worldOf(liveRecord());
  assert.equal(w.seeded, undefined, 'rings without `d`: map/world.mjs sparseRings gives null');
  assert.equal(w.ringsOpen, 5);
  for (const d of [0, 1, 2, 3, 4]) assert.equal(ringSeeded(w, d), true, `ring ${d}`);
});

test('a ring the herald refused (404 NoSuchRing) is remembered, and is not asked again while the extent stands', async () => {
  const FS = stateOf(liveRecord()), s = herald();
  const first = await readOverviews(FS, { herald: s.h, v2: true });
  assert.deepEqual(first, [false, false, true, true, true]);
  assert.deepEqual([...FS.overviews.keys()].sort(), [2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map(d => overviewRefused(FS, d)), [true, true, false, false, false]);
  const asked = s.calls.length;
  // every later refresh (the page's season poll asks all missing rings): rings 0 and 1 are not asked again
  for (let i = 0; i < 5; i++) assert.deepEqual(await readOverviews(FS, { herald: s.h, v2: true, rings: [0, 1, 2] }), [false, false, true]);
  assert.deepEqual(s.calls.slice(asked).map(c => c[1]), [2, 2, 2, 2, 2], 'only ring 2 was read again; 0 and 1 never');
  // a poll that makes a new world object with the SAME extent keeps the refusal (the page does this on every poll)
  FS.world = worldOf(liveRecord());
  assert.equal(overviewRefused(FS, 0), true);
  await readOverviews(FS, { herald: s.h, v2: true, rings: [0, 1] });
  assert.equal(s.calls.filter(c => c[1] <= 1).length, 2, 'still asked only once each');
});

test('an explicit re-read asks a refused ring again; a ring the herald then serves is no longer refused', async () => {
  const FS = stateOf(liveRecord()), s = herald();
  await readOverviews(FS, { herald: s.h, v2: true });
  s.refused.delete(1);                                            // the herald now has ring 1
  forgetOverviewRefusals(FS);
  assert.deepEqual(await readOverviews(FS, { herald: s.h, v2: true, rings: [0, 1] }), [false, true]);
  assert.equal(overviewRefused(FS, 0), true, 'still refused: asked again and refused again');
  assert.equal(overviewRefused(FS, 1), false, 'served now: held, not refused');
  assert.ok(FS.overviews.has(1));
  // the page's explicit re-read ('province-reread') is the one that passes it
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /'province-reread': d => \{[^\n]*\{ forgetOverviewRefusals\(FS\); loadOverviews\(heraldRef\)\.then\(/);
  assert.equal(app.split('forgetOverviewRefusals(FS)').length - 1, 1, 'and no other caller');
});

test('a changed extent asks a refused ring again (a ring that gains Provinces may now have an overview)', async () => {
  const FS = stateOf(liveRecord()), s = herald();
  await readOverviews(FS, { herald: s.h, v2: true });
  FS.world = worldOf(liveRecord([1, 6, 12, 18, 24, 30]));       // ring 5 opened
  assert.equal(overviewRefused(FS, 0), false, 'refused under another extent: not known now');
  s.refused.clear();
  await readOverviews(FS, { herald: s.h, v2: true, rings: [0, 1] });
  await flush();
  assert.ok(FS.overviews.has(0) && FS.overviews.has(1));
  assert.equal(overviewRefused(FS, 0), false);
});

test('only a 404 is a refusal: a network failure or another error is asked again as before', async () => {
  const FS = stateOf(liveRecord()), calls = [];
  let answer = { ok: false, code: 'network', error: 'network', httpStatus: 0 };
  const h = { overview2: async ring => { calls.push(ring); return answer; }, overview: async () => answer };
  await readOverviews(FS, { herald: h, v2: true, rings: [0] });
  assert.equal(overviewRefused(FS, 0), false);
  answer = { ok: false, code: 'HTTP503', error: 'HTTP 503', httpStatus: 503 };
  await readOverviews(FS, { herald: h, v2: true, rings: [0] });
  assert.equal(overviewRefused(FS, 0), false);
  await readOverviews(FS, { herald: h, v2: true, rings: [0] });
  assert.deepEqual(calls, [0, 0, 0], 'asked every time');
  // a thrown read is a failure too, never a refusal
  const thrown = { overview2: async () => { throw new Error('x'); } };
  const FS2 = stateOf(liveRecord());
  await readOverviews(FS2, { herald: thrown, v2: true, rings: [0] });
  assert.equal(overviewRefused(FS2, 0), false);
});

test('another herald client forgets the refusals (another source may serve the ring)', async () => {
  const FS = stateOf(liveRecord()), a = herald(), b = herald(new Set());
  await readOverviews(FS, { herald: a.h, v2: true });
  assert.equal(overviewRefused(FS, 0), true);
  await readOverviews(FS, { herald: b.h, v2: true, rings: [0, 1] });
  assert.equal(overviewRefused(FS, 0), false);
  assert.ok(FS.overviews.has(0));
});
