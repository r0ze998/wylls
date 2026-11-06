// The herald → page path of a map that grows on chain (map growth: ExtendFrontier,
// then OpenRing, then OpenProvince), with no reload and no fixture swapped in:
// each poll of the season record goes through map/world.mjs applySeasonRecord,
// which moves the record, the world's extent and the partly created rings'
// lists together; overviewRings names the rings whose overview is wanted now.
//
// Two stale-cache faults these tests pin (both found by reading the page):
//   1. controller.refreshOverviews set FS.record without FS.world, so the
//      inspector and the border kept the boot's extent until the page's own
//      poll (the inspector called a ring the herald had just put inside the
//      map "outside").
//   2. The overviews were loaded once at boot over the rings open then: a
//      ring opened later had its terrain (its seed came with the record) but
//      no records on it (owners, sites, camps) until a reload.
// Pure: no DOM, no fetch; the herald is a stub answering ring lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { ringProvinces, ringSize } from '../../permutation-server/web/frontier/fgeo.mjs';

const rings = n => Array.from({ length: n }, (_, d) => ({ d, seed: '00' }));
const counts = n => Array.from({ length: n }, (_, d) => ringSize(d));
const tick = () => new Promise(r => setTimeout(r, 0));

/** A herald stub: `worldRing(d)` answers the "p,q" of ring d that `present(d)` lists; every ask is recorded. */
function heraldStub(present = () => null) {
  const asked = [];
  return {
    asked,
    async worldRing(d) {
      asked.push(d);
      const list = present(d);
      return list ? { ok: true, present: new Set(list) } : { ok: false, code: 'NotFound' };
    },
  };
}

test('worldSync: the world follows the record; ring lists are dropped once whole and kept while partial', () => {
  // rings 0–4 open and whole, ring 5 opened and half created
  const half = ringSize(5) / 2;
  const rec = { rings: rings(6), ringsOpened: 6, rMax: 8, ringProvinces: [...counts(5), half] };
  const held = new Map([[3, new Set()], [5, new Set(['5,0'])]]);
  const s = W.worldSync(rec, held);
  assert.equal(s.world.rMax, 8);
  assert.equal(s.world.ringsOpen, 6);
  assert.deepEqual(s.partial, [5]);
  assert.deepEqual(s.drop, [3], 'a list of a ring the record no longer calls partial is dropped; the partial one stays');
  // whole again: nothing partial, every list dropped
  const whole = W.worldSync({ ...rec, ringProvinces: counts(6) }, held);
  assert.deepEqual(whole.partial, []);
  assert.deepEqual(whole.drop.sort(), [3, 5]);
  // no lists held at all
  assert.deepEqual(W.worldSync(rec, null).drop, []);
});

test('applySeasonRecord: a grown map reaches the inspector on the next record, with no reload (fault 1)', async () => {
  // Boot: the season ends at ring 6, every ring open.
  const FS = { mode: 'play', selected: { p: 7, q: 0 } };
  const boot = { rings: rings(7), ringsOpened: 7, rMax: 6, ringProvinces: counts(7) };
  W.applySeasonRecord(FS, boot);
  assert.equal(FS.record, boot);
  assert.equal(W.placeNow(FS, 7, 0), 'outside');
  assert.match(String(inspect.render(FS, null)), /第7輪（このシーズンの地図の外）/);

  // ExtendFrontier(7) landed: the herald's rMax is 7. The controller's re-read used to set FS.record alone;
  // applySeasonRecord moves FS.world with it, so the inspector answers from the new extent at once.
  const raised = { ...boot, rMax: 7 };
  W.applySeasonRecord(FS, raised);
  assert.equal(FS.record, raised);
  assert.equal(FS.world.rMax, 7);
  assert.equal(W.placeNow(FS, 7, 0), 'unopened');
  assert.match(String(inspect.render(FS, null)), /第7輪（まだひらいていません）/);

  // OpenRing(7) landed: ring 7 is opened, its seed on its way → pending.
  W.applySeasonRecord(FS, { ...raised, ringsOpened: 8 });
  assert.equal(W.placeNow(FS, 7, 0), 'pending');

  // The seed is out and the keeper creates ring 7: 10 of 42 Provinces on chain. The ring is partial: its list is
  // asked of the herald, and the Provinces not yet on it are pending, the ones on it open.
  const r7 = ringProvinces(7).map(c => `${c.p},${c.q}`);
  const on = r7.slice(0, 10);
  const herald = heraldStub(d => (d === 7 ? on : null));
  let told = 0;
  W.applySeasonRecord(FS, { rings: rings(8), ringsOpened: 8, rMax: 7, ringProvinces: [...counts(7), 10] }, { herald, onRings: () => told++ });
  await tick(); await tick();
  assert.deepEqual(herald.asked, [7]);
  assert.equal(told, 1);
  assert.equal(FS.worldRings.get(7).size, 10);
  const [p0, q0] = on[0].split(',').map(Number), [p1, q1] = r7[20].split(',').map(Number);
  assert.equal(W.placeNow(FS, p0, q0), 'open');
  assert.equal(W.placeNow(FS, p1, q1), 'pending');

  // Whole: the list is dropped and every Province of ring 7 is open; ring 8 is outside (rMax 7).
  W.applySeasonRecord(FS, { rings: rings(8), ringsOpened: 8, rMax: 7, ringProvinces: counts(8) }, { herald });
  await tick();
  assert.equal(FS.worldRings.has(7), false);
  assert.equal(W.placeNow(FS, p1, q1), 'open');
  assert.equal(W.placeNow(FS, 8, 0), 'outside');
  assert.deepEqual(herald.asked, [7], 'a whole ring is not asked for its list');
});

test('applySeasonRecord: a failed ring list leaves the page\'s answer to the herald, never a wrong state', async () => {
  const FS = {};
  const herald = heraldStub(() => null);
  W.applySeasonRecord(FS, { rings: rings(6), ringsOpened: 6, rMax: 9, ringProvinces: [...counts(5), 3] }, { herald });
  await tick(); await tick();
  assert.deepEqual(herald.asked, [5]);
  assert.equal(FS.worldRings?.get?.(5), undefined);
  assert.equal(W.placeNow(FS, 5, 0), 'open', 'without the list a partly created ring counts as open (the province answer decides)');
});

test('overviewRings: a ring opened after boot wants its overview; a ring filling with Provinces wants it again (fault 2)', () => {
  const taken = new Map();
  // Boot over rings 0–4: every ring wants one; once taken (with its count), none does.
  const w0 = W.worldOf({ rings: rings(5), ringsOpened: 5, rMax: 8, ringProvinces: counts(5) });
  assert.deepEqual(W.overviewRings(w0, taken), [0, 1, 2, 3, 4]);
  const FS = { world: w0, overviewTaken: taken };
  for (const d of [0, 1, 2, 3, 4]) W.overviewTaken(FS, d);
  assert.deepEqual(W.overviewRings(w0, taken), []);
  // Ring 5 opened and seeded, 4 of its 30 Provinces on chain: only ring 5 wants an overview.
  FS.world = W.worldOf({ rings: rings(6), ringsOpened: 6, rMax: 8, ringProvinces: [...counts(5), 4] });
  assert.deepEqual(W.overviewRings(FS.world, taken), [5]);
  W.overviewTaken(FS, 5);
  assert.equal(taken.get(5), 4);
  assert.deepEqual(W.overviewRings(FS.world, taken), [], 'taken at 4 of 30: nothing wanted until the count moves');
  // More of ring 5 landed: it wants its overview again; the whole rings do not.
  FS.world = W.worldOf({ rings: rings(6), ringsOpened: 6, rMax: 8, ringProvinces: [...counts(5), 30] });
  assert.deepEqual(W.overviewRings(FS.world, taken), [5]);
  W.overviewTaken(FS, 5);
  assert.deepEqual(W.overviewRings(FS.world, taken), []);
  // An older herald without counts: each ring is asked once and then left alone.
  const old = W.worldOf({ rings: rings(2), rMax: 8 });
  const t2 = new Map();
  assert.deepEqual(W.overviewRings(old, t2), [0, 1]);
  const FS2 = { world: old, overviewTaken: t2 };
  W.overviewTaken(FS2, 0); W.overviewTaken(FS2, 1);
  assert.deepEqual([...t2.values()], [null, null]);
  assert.deepEqual(W.overviewRings(old, t2), []);
  // No world yet (the season did not load): nothing wanted, nothing thrown.
  assert.deepEqual(W.overviewRings(null, t2), []);
  assert.deepEqual(W.overviewRings(w0, null), [0, 1, 2, 3, 4], 'no record of what was taken: everything open is wanted');
});

test('the hard limit and the ceiling stay what the program says: nothing on the page grows the world past them', () => {
  assert.equal(W.R_MAX_HARD, 128);
  // a season with a ceiling of 17 (the prize tally's last ring): ring 17 extendable, 18 beyond the ceiling
  const w = W.worldOf({ rings: rings(5), ringsOpened: 5, rMax: 4, rMaxCeiling: 17 });
  assert.equal(W.placeOf(w, 5, 0), 'extendable');
  assert.equal(W.placeOf(w, 17, 0), 'extendable');
  assert.equal(W.placeOf(w, 18, 0), 'beyondCeiling');
  // a record claiming a ceiling past 128 is clamped to the program's hard limit
  const far = W.worldOf({ rings: rings(5), ringsOpened: 5, rMax: 4, rMaxCeiling: 200 });
  assert.equal(far.rMaxCeiling, 128);
  assert.equal(W.placeOf(far, 128, 0), 'extendable');
  assert.equal(W.placeOf(far, 129, 0), 'beyondHard');
});


test('late partial-ring response cannot restore an obsolete ring list', async () => {
  const FS = { worldRings: new Map() };
  let finish;
  const rec = { rings: rings(2), ringsOpened: 2, rMax: 3, ringProvinces: [1, 1] };
  W.applySeasonRecord(FS, rec, { herald: { worldRing: () => new Promise(r => { finish = r; }) } });
  await Promise.resolve();
  W.applySeasonRecord(FS, { ...rec, ringProvinces: [1, 6] });
  finish({ ok: true, present: new Set(['old']) });
  await tick();
  assert.equal(FS.worldRings.has(1), false);
});

test('an old overview cannot be marked complete for a newer world snapshot', () => {
  const FS = {};
  const rec = { rings: rings(2), ringsOpened: 2, rMax: 3, ringProvinces: [1, 1] };
  W.applySeasonRecord(FS, rec);
  const requested = FS.world;
  W.applySeasonRecord(FS, { ...rec, ringProvinces: [1, 6] });
  assert.equal(W.overviewTaken(FS, 1, requested), false);
  assert.ok(W.overviewRings(FS.world, FS.overviewTaken).includes(1));
  assert.equal(W.overviewTaken(FS, 1, FS.world), true);
  assert.equal(FS.overviewTaken.get(1), 6);
});
