// The rings a first village may be placed in are counted from the Concord WITHOUT A GAP (map/world.mjs
// contiguousRings), the same count at every reader: the planner, the confirm, the map tap, the nation choice and the
// ticket plan. Never the season record's length: a sparse world that seeds ring 128 alone has one entry and no ring 0
// (measured in a local conquest-preset world, 2026-11-15: record.rings = [{d:128}], heartlandMaxRing 3).
// Pure: record and season vectors; no network, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { worldOf, contiguousRings } from '../../permutation-server/web/frontier/map/world.mjs';
import { homeRingsOpen } from '../../permutation-server/web/frontier/home.mjs';

const seed = '00'.repeat(32);
const recordOf = ds => ({ rings: ds.map(d => ({ d, seed })) });
const season = { conquestParams: { heartlandMaxRing: 3 } };
const homeCount = ds => homeRingsOpen(season, contiguousRings(worldOf(recordOf(ds))));

test('the measured sparse world (ring 128 alone) has no ring open for a first village', () => {
  assert.equal(contiguousRings(worldOf(recordOf([128]))), 0);
  assert.equal(homeCount([128]), 0);
  // the record's length would have said "ring 0 is open": the meaning this alignment removes
  assert.equal(recordOf([128]).rings.length, 1);
});

test('a contiguous world 0..3 opens its heartland (capped at heartland + 1); a gap ends the run', () => {
  assert.equal(contiguousRings(worldOf(recordOf([0, 1, 2, 3]))), 4);
  assert.equal(homeCount([0, 1, 2, 3]), 4);
  assert.equal(homeCount([0, 1, 2, 3, 4, 5]), 4, 'never past the heartland');
  assert.equal(contiguousRings(worldOf(recordOf([0, 1, 3]))), 2, 'the gap at ring 2 ends the run');
  assert.equal(homeCount([0, 1, 3]), 2);
});

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const SAME = 'FS.record ? contiguousRings(FS.world ?? worldOf(FS.record)) : 0';

test('every home and ticket reader counts the same way, none by the record\'s length', () => {
  const ctl = read('controller.mjs'), join = read('screens/join.mjs'), app = read('app.mjs');
  // the planner and the confirm: the map tap's own expression
  assert.ok(ctl.includes(`planHomes({ overviews: FS.overviews, faction, nowBell: nowBell(), place: seasonPlace(FS.season), ringsOpen: homeRingsOpen(FS.season, ${SAME}),`), 'planner');
  assert.ok(ctl.includes(`ringsOpen: homeRingsOpen(FS.season, ${SAME}), place: seasonPlace(FS.season) }).some(s => sameHome(s, site))`), 'confirm');
  assert.ok(app.includes('ringsOpen: homeRingsOpen(FS.season, FS.record ? contiguousRings(worldNow()) : 0), place: seasonPlace(FS.season) }).find(s => s.tile === hit.idx)'), 'map tap');
  // the ticket plan: the same count, its fallback of 1 kept for a missing record
  assert.ok(ctl.includes('faction: FS.citizen.faction, ringsOpen: FS.record ? contiguousRings(FS.world ?? worldOf(FS.record)) : 1,'), 'ticket plan');
  // the nation choice's free count: the same count (undefined without a record, as before)
  assert.ok(join.includes('const open = FS.record ? contiguousRings(FS.world ?? worldOf(FS.record)) : undefined;'), 'nation choice');
  // no home or ticket reader reads the record's length (the overview loop's own count is not a home reader)
  for (const [name, src] of [['controller.mjs', ctl], ['screens/join.mjs', join], ['app.mjs', app]]) {
    for (const line of src.split('\n').filter(l => /homeRingsOpen|homeSites|planHomes|planTicket|freeByNation|const open = /.test(l))) {
      assert.doesNotMatch(line, /rings\?\.length/, `${name}: ${line.trim().slice(0, 120)}`);
    }
  }
});
