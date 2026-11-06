import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeNation, ringProvinces, wedgeOf, PLACEMENT_DISPERSED } from '../../permutation-server/web/frontier/fgeo.mjs';
import { homeSites, planHomes, seasonPlace } from '../../permutation-server/web/frontier/home.mjs';

const seed = n => new Array(32).fill(n);
const place = { placement: PLACEMENT_DISPERSED, heartlandMaxRing: 3, genesisSeed: seed(1) };

test('homeNation equals the program rule (vector pinned by permutation-rules home_nation_dispersed_pinned_vector)', () => {
  const got = [...ringProvinces(2), ...ringProvinces(3)].map(x => homeNation(x.p, x.q, place));
  assert.deepEqual(got, [4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4]);
});

test('the wedge placement, the Concord and rings outside the heartland are the wedge', () => {
  for (let d = 1; d <= 6; d++) for (const x of ringProvinces(d)) {
    assert.equal(homeNation(x.p, x.q), wedgeOf(x.p, x.q));
    if (d < 2 || d > 3) assert.equal(homeNation(x.p, x.q, place), wedgeOf(x.p, x.q));
  }
  assert.equal(homeNation(0, 0, place), null);
});

test('dispersed: every nation takes d provinces of ring d in d wedges; neighbours differ', () => {
  for (let s = 0; s < 8; s++) for (let hmr = 2; hmr <= 6; hmr++) for (let d = 2; d <= hmr; d++) {
    const ring = ringProvinces(d), n = ring.map(x => homeNation(x.p, x.q, { ...place, heartlandMaxRing: hmr, genesisSeed: seed(s) }));
    for (let f = 0; f < 6; f++) {
      assert.equal(n.filter(x => x === f).length, d);
      assert.equal(new Set(ring.filter((_, i) => n[i] === f).map(x => wedgeOf(x.p, x.q))).size, Math.min(d, 6));
    }
    n.forEach((x, i) => assert.notEqual(x, n[(i + 1) % n.length]));
  }
});

const province = (p, q) => ({ p, q, siteCount: 2, sites: [5, 14], siteMirror: [{ state: 0, gen: 0 }, { state: 0, gen: 0 }], ticketCohorts: [] });
const overviews = () => new Map([2, 3].map(ring => [ring, { ring, provinces: ringProvinces(ring).map(p => ({ ...p, sites: [0, 0], owners: [7, 7] })) }]));

test('homeSites and planHomes follow the placement: a joined player is offered only its nation\'s provinces, in several wedges', async () => {
  for (const x of ringProvinces(2)) {
    const f = homeNation(x.p, x.q, place);
    assert.equal(homeSites(province(x.p, x.q), { faction: f, ringsOpen: 4, place }).length, 2);
    assert.deepEqual(homeSites(province(x.p, x.q), { faction: (f + 1) % 6, ringsOpen: 4, place }), []);
  }
  for (let f = 0; f < 6; f++) {
    const r = await planHomes({ overviews: overviews(), read: async (p, q) => province(p, q), faction: f, ringsOpen: 4, seed: 'p', place, max: 5 });
    assert.equal(r.candidates.length, 5);
    assert.ok(r.candidates.every(s => s.faction === f && homeNation(s.p, s.q, place) === f));
    assert.ok(new Set(r.candidates.map(s => wedgeOf(s.p, s.q))).size >= 3);
  }
});

test('seasonPlace: legacy fields keep the wedge rule but dispersed evidence is retained', () => {
  assert.equal(seasonPlace(null), undefined);
  assert.equal(seasonPlace({ conquestParams: { placement: 1 } }).placement, 1); // missing seed is retained as unavailable, not legacy
  assert.equal(seasonPlace({ conquestParams: { placement: 0 }, genesisSeed: seed(1) }), undefined);
  assert.deepEqual(seasonPlace({ conquestParams: { placement: 1, heartlandMaxRing: 3 }, genesisSeed: seed(1) }), place);
});


test('missing dispersed seed and unknown modes never offer wedge fallback homes', async () => {
  for (const fields of [{placement: 1}, {placement: 1, genesisSeed: [1]}, {placement: 2, genesisSeed: seed(1)}]) {
    const place = seasonPlace({conquestParams: fields});
    assert.notEqual(place, undefined);
    assert.equal(homeNation(2, 0, place), null);
    let reads = 0;
    const result = await planHomes({overviews: new Map(), place, read: async () => { reads++; return null; }});
    assert.deepEqual(result, {candidates: [], error: 'Unavailable', reads: 0});
    assert.equal(reads, 0);
  }
});

test('legacy ticket planning agrees inside dispersed heartland and preserves external overflow', async () => {
  const { planTicket, overflowCandidates } = await import('../../permutation-server/web/frontier/fjoin.mjs');
  for (let faction = 0; faction < 6; faction++) {
    const result = await planTicket({overviews: overviews(), faction, ringsOpen: 4, seed: 'fixture', nowBell: 1, read: async (p,q) => province(p,q), place});
    assert.equal(result.ok, true);
    assert.ok(result.sites.every(s => homeNation(s.p,s.q,place) === faction));
    assert.ok(overflowCandidates(overviews(),faction,4,place).every(s => homeNation(s.p,s.q,place) === faction));
    const outer = new Map([[4,{ring:4,provinces:ringProvinces(4)}]]);
    assert.deepEqual(overflowCandidates(outer,faction,5,place),overflowCandidates(outer,faction,5));
  }
  const unavailable = await planTicket({place:{placement:1},read:async()=>{throw Error('must not read');}});
  assert.deepEqual(unavailable,{ok:false,why:'readfail',reads:0,full:[]});
});
