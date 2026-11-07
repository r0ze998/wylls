// The rings a first village may be placed in (home.mjs homeRingsOpen) and
// every reader of them. PlaceHome refuses a ring above the Season's
// heartland_max_ring (ReservedSite) whether or not the ring is open, so once
// the map has grown past the heartland (OpenRing, ExtendFrontier) the open
// rings are not the home rings. Found in the integration of map growth with
// the home flow: the tap on a tile, the confirm's re-check, the nation
// choice's count and the wait view's site marks read the open rings alone,
// and offered or counted land the program refuses. Now the planner, the
// confirm, the tap, the count and the marks all stop at the heartland; a
// Season without the conquest block (M1 tickets) keeps its open rings; the
// lit region and the camera keep the nation's whole open land.
// Pure: no canvas, no chain, no keys, no addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ringProvinces, ringOf, wedgeOf, homeNation } from '../../permutation-server/web/frontier/fgeo.mjs';
import { freeByNation, freeByWedge, FIRST_TICKET_RING } from '../../permutation-server/web/frontier/fland.mjs';
import { homeRingsOpen, homeSites, planHomes, seasonPlace } from '../../permutation-server/web/frontier/home.mjs';
import { factionCards } from '../../permutation-server/web/frontier/screens/join.mjs';
import { wedgeSites } from '../../permutation-server/web/frontier/map/waitview.mjs';
import * as HL from '../../permutation-server/web/frontier/map/homeland.mjs';
import * as opening from '../../permutation-server/web/frontier/map/opening.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const source = f => readFileSync(new URL(f, WEB), 'utf8');
const seed = n => new Array(32).fill(n);
/** A v2 Season (instant homes; the heartland is rings 2 .. 3) under the wedge rule, and under the dispersed rule with its seed. */
const v2 = { layoutVersion: 2, programVersion: 4, conquestParams: { placement: 0, heartlandMaxRing: 3 } };
const v2d = { ...v2, conquestParams: { placement: 1, heartlandMaxRing: 3 }, genesisSeed: Uint8Array.from(seed(1)) };
/** An M1 Season (tickets): no conquest block, no heartland. */
const m1 = { layoutVersion: 1, programVersion: 1 };
const HEART = 3;
const province = (p, q) => ({ p, q, siteCount: 2, sites: [5, 14], siteMirror: [{ state: 0, gen: 0 }, { state: 0, gen: 0 }], ticketCohorts: [] });
const six = v => [0, 1, 2, 3, 4, 5].map(() => v);

test('homeRingsOpen: the open rings, no further than the heartland on a v2 Season; the open rings on a Season without one', () => {
  for (const open of [0, 1, 2, 3, 4, 5, 8]) {
    assert.equal(homeRingsOpen(v2, open), Math.min(open, HEART + 1), `v2, ${open} open`);
    assert.equal(homeRingsOpen(v2d, open), Math.min(open, HEART + 1), `v2 dispersed, ${open} open`);
    assert.equal(homeRingsOpen(m1, open), open, `m1, ${open} open`);
    assert.equal(homeRingsOpen(null, open), open);
    assert.equal(homeRingsOpen(undefined, open), open);
  }
  assert.equal(homeRingsOpen({ ...v2, conquestParams: { placement: 0, heartlandMaxRing: 5 } }, 8), 6, 'a wider heartland');
  assert.equal(homeRingsOpen({ heartlandMaxRing: 2 }, 8), 3, 'the field at the top (a season record) counts too');
  assert.equal(homeRingsOpen(v2, undefined), 0, 'no count of open rings: no home ring');
  assert.equal(homeRingsOpen(v2, -3), 0);
  assert.equal(homeRingsOpen(v2, 2.5), 0);
});

test('a free site in an open ring past the heartland: offered by the open rings, refused by the home rings (PlaceHome: ReservedSite)', () => {
  const open = 6;   // rings 0 .. 5 open: the map has grown two rings past the heartland
  for (const season of [v2, v2d]) {
    const place = seasonPlace(season);
    for (const d of [2, 3, 4, 5]) {
      const pr = ringProvinces(d)[0], f = homeNation(pr.p, pr.q, place);
      const byOpen = homeSites(province(pr.p, pr.q), { faction: f, ringsOpen: open, place });
      const byHome = homeSites(province(pr.p, pr.q), { faction: f, ringsOpen: homeRingsOpen(season, open), place });
      assert.equal(byOpen.length, 2, `ring ${d} is open`);
      assert.equal(byHome.length, d <= HEART ? 2 : 0, `ring ${d}: ${d <= HEART ? 'a home ring' : 'past the heartland, no home'}`);
    }
  }
  // tickets (no heartland): the open rings are the home rings
  const pr = ringProvinces(5)[0];
  assert.equal(homeSites(province(pr.p, pr.q), { faction: wedgeOf(pr.p, pr.q), ringsOpen: homeRingsOpen(m1, open) }).length, 2);
});

test('the planner never offers a village past the heartland, however many rings are open', async () => {
  const overviews = new Map([2, 3, 4, 5].map(ring => [ring, { ring, provinces: ringProvinces(ring).map(p => ({ ...p, sites: [0, 0], owners: [7, 7] })) }]));
  const read = async (p, q) => province(p, q);
  for (const season of [v2, v2d]) for (let f = 0; f < 6; f++) {
    const place = seasonPlace(season);
    const wide = await planHomes({ overviews, read, faction: f, ringsOpen: 6, seed: 'x', place, max: 12 });
    assert.ok(wide.candidates.some(s => ringOf(s.p, s.q) > HEART), 'by the open rings alone: sites past the heartland, which the program refuses');
    const home = await planHomes({ overviews, read, faction: f, ringsOpen: homeRingsOpen(season, 6), seed: 'x', place, max: 12 });
    assert.equal(home.candidates.length, 2 + 3, 'by the home rings: the heartland\'s provinces (two of ring 2, three of ring 3)');
    assert.ok(home.candidates.every(s => ringOf(s.p, s.q) >= 2 && ringOf(s.p, s.q) <= HEART && homeNation(s.p, s.q, place) === f));
  }
});

test('the nation choice counts places for a village in the home rings only: land a grown map opened past the heartland is not one', () => {
  const ov = new Map([1, 2, 3, 4, 5].map(ring => [ring, { ring, provinces: ringProvinces(ring).map(pr => ({ p: pr.p, q: pr.q, sites: Array(12).fill(0), owners: Array(12).fill(7) })) }]));
  // every site free: a nation has d provinces in ring d under either rule, 12 sites each; ring 1 never counts
  const whole = six(12 * (2 + 3 + 4 + 5)), heart = six(12 * (2 + 3));
  assert.deepEqual(freeByWedge(ov), whole);
  assert.deepEqual(freeByNation(ov), whole, 'unbounded by default, as before');
  assert.deepEqual(freeByNation(ov, undefined, { ringsOpen: Infinity }), whole);
  assert.deepEqual(freeByNation(ov, { placement: 0 }, { ringsOpen: 4 }), heart, 'the wedge rule, rings 0 .. 3');
  assert.deepEqual(freeByNation(ov, seasonPlace(v2d), { ringsOpen: 4 }), heart, 'the dispersed rule, rings 0 .. 3');
  assert.deepEqual(freeByNation(ov, seasonPlace(v2d), { ringsOpen: 6 }), freeByNation(ov, seasonPlace(v2d)), 'every open ring: the unbounded count');
  assert.deepEqual(freeByNation(ov, undefined, { ringsOpen: 2 }), six(0), 'rings 0 .. 1 open: nothing');
  assert.equal(freeByNation(ov, { placement: 1 }, { ringsOpen: 4 }), null, 'no seed: still unavailable, never a number');
  assert.deepEqual(freeByWedge(ov), whole, 'the program\'s per-wedge accounting is untouched');
  // the cards: a v2 Season with rings 0 .. 5 open counts the heartland; with no season record yet, all the overviews hold; tickets, every open ring
  const base = { overviews: ov, joinDraft: { faction: 2 }, wallet: { address: 'w' } };
  const rec = { rings: Array.from({ length: 6 }, (_, d) => ({ d })) };
  assert.deepEqual(factionCards({ ...base, season: v2, record: rec }).map(c => c.free), heart);
  assert.deepEqual(factionCards({ ...base, season: v2d, record: rec }).map(c => c.free), heart);
  assert.deepEqual(factionCards({ ...base, season: v2 }).map(c => c.free), whole, 'no season record yet: the overviews alone bound the count');
  assert.deepEqual(factionCards({ ...base, season: m1, record: rec }).map(c => c.free), whole, 'tickets: every open ring');
  assert.deepEqual(factionCards({ ...base, season: v2, record: { rings: rec.rings.slice(0, 3) } }).map(c => c.free), six(12 * 2), 'rings 0 .. 2 open: ring 2 alone');
  assert.ok(factionCards({ ...base, season: { ...v2, conquestParams: { placement: 1, heartlandMaxRing: 3 } }, record: rec }).every(c => c.free === null), 'no seed: no number');
});

test('the wait view\'s site marks, 「村を置ける場所」, stop at the home rings; the lit region and the camera keep the nation\'s whole open land', () => {
  const recs = new Map();
  for (const d of [1, 2, 3, 4, 5]) for (const pr of ringProvinces(d)) recs.set(`${pr.p},${pr.q}`, { p: pr.p, q: pr.q, sites: Array(12).fill(0), owners: Array(12).fill(7) });
  const terrainOf = () => ({ sites: [5, 9, 14, 20, 27, 33, 38, 41, 46, 50, 55, 59] });
  for (const season of [v2, v2d]) {
    const place = seasonPlace(season), open = 6, home = homeRingsOpen(season, open);
    for (let f = 0; f < 6; f++) {
      const byOpen = wedgeSites(f, open, recs, terrainOf, place), byHome = wedgeSites(f, home, recs, terrainOf, place);
      assert.ok(byOpen.some(s => ringOf(s.p, s.q) > HEART), 'by the open rings: marks past the heartland');
      assert.equal(byHome.length, (2 + 3) * 12, 'by the home rings: the heartland\'s free sites');
      assert.ok(byHome.every(s => ringOf(s.p, s.q) >= FIRST_TICKET_RING && ringOf(s.p, s.q) <= HEART && homeNation(s.p, s.q, place) === f));
      assert.deepEqual(byHome, byOpen.filter(s => ringOf(s.p, s.q) <= HEART), 'the same marks, those past the heartland left out');
      // the region the chart lights and the wait's camera frames: the nation's land in every open ring, as before
      assert.ok(HL.homeRegion(f, open, place).some(pr => pr.ring === 5));
      assert.deepEqual(opening.wedgeBox(f, open, place), HL.homeBox(f, open, place));
    }
  }
  // tickets: the marks follow the open rings
  assert.ok(wedgeSites(0, homeRingsOpen(m1, 6), recs, terrainOf).some(s => ringOf(s.p, s.q) === 5));
});

test('every reader of the home candidates takes the home rings: the planner, the confirm, the tap on a tile, the nation choice, the map\'s marks', () => {
  const ctl = source('controller.mjs'), app = source('app.mjs'), map = source('map/fmap.mjs'), join = source('screens/join.mjs');
  assert.match(ctl, /planHomes\(\{ overviews: FS\.overviews, faction, nowBell: nowBell\(\), place: seasonPlace\(FS\.season\), ringsOpen: homeRingsOpen\(FS\.season, FS\.record\?\.rings\?\.length \?\? 0\),/);
  assert.match(ctl, /homeSites\(env\?\.province, \{ faction: site\.faction, nowBell: nowBell\(\), ringsOpen: homeRingsOpen\(FS\.season, FS\.record\?\.rings\?\.length \?\? 0\), place: seasonPlace\(FS\.season\) \}\)/);
  assert.match(app, /homeSites\(FS\.provinces\.get\(`\$\{hit\.p\},\$\{hit\.q\}`\)\?\.province, \{ faction: FS\.citizen\?\.faction \?\? null, nowBell: FS\.nowBell, ringsOpen: homeRingsOpen\(FS\.season, FS\.record\?\.rings\?\.length \?\? 0\), place: seasonPlace\(FS\.season\) \}\)/);
  for (const [name, src] of [['controller.mjs', ctl], ['app.mjs', app]]) assert.doesNotMatch(src, /homeSites\([^\n]*ringsOpen: FS\.record\?\.rings/, `${name}: no home read by the open rings alone`);
  assert.match(app, /homeRings: homeRingsOpen\(FS\.season, FS\.record\?\.rings\?\.length \?\? 1\),/, 'the map source carries the home rings beside the open rings');
  assert.match(app, /ringsOpen: FS\.record\?\.rings\?\.length \?\? 1, own, selected: FS\.selected, terrainOf,/, 'and the open rings themselves, unchanged');
  assert.match(map, /wedgeSites\(survey\.faction, src\.homeRings \?\? ringsOpen, recs, terrainOf, place\)/, 'the marks read the home rings, the region the open rings');
  assert.match(map, /this\.wedgeHome\(survey\.faction, ringsOpen, place\)/);
  assert.match(map, /wedgeBox\(survey\.faction, ringsOpen, place\)/);
  assert.match(join, /freeByNation\(FS\.overviews \?\? new Map\(\), seasonPlace\(FS\.season\), \{ ringsOpen: Number\.isInteger\(open\) \? homeRingsOpen\(FS\.season, open\) : Infinity \}\)/);
});
