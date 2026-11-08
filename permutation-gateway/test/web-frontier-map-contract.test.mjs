// The original map's read contract, end to end (⑲, 2026-11-08): the herald's
// own answers for a map that grows on chain (frontier-node/crates/herald
// tests/ws19_map_contract.rs serves fixture::growth through the real router
// and commits them as tests/golden/ws19-map-growth.json) read by the page's
// own client: herald.mjs createHerald (season, worldRing, province, me,
// wideWorld, wideIndexStatus) and map/world.mjs (applySeasonRecord, placeNow).
// No hand-written herald answer: every byte below is the router's.
//
// Stages: S0 rings 0–1 open, (1,−1) never on chain; S1 OpenRing(2) landed,
// its seed missing; S2 the seed out, (2,0) and (1,1) on chain. rMax 3.
// Key-free: the fetch is a stub over the golden; the addresses are public
// with-seed PDAs (faddr.seasonAddresses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { blockedHexes } from '../../permutation-server/web/frontier/s1walk.mjs';
import { DIRECTIONS, tileHex, ringSize } from '../../permutation-server/web/frontier/fgeo.mjs';
import { decodeRoster, createRoster } from '../../permutation-server/web/frontier/people/roster.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth.json', import.meta.url), 'utf8'));
// The S1 golden (ring 4 → 5; used from the wide test on and in the S1 section below).
const S1 = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url), 'utf8'));
const tick = () => new Promise(r => setTimeout(r, 0));

/** The page's fetch over one stage of the golden; a path the golden has not is a 404 NotFound (as the router's fallback). */
function stageFetch(stage) {
  const answers = GOLDEN.stages[stage];
  const asked = [];
  const f = async url => {
    const path = new URL(url, 'http://h').pathname;
    asked.push(path);
    const a = answers[path] ?? { status: 404, body: { ok: false, code: 'NotFound' } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
  return { f, asked };
}

function heraldAt(stage) {
  const { f, asked } = stageFetch(stage);
  const h = createHerald({ fetch: f, seasonId: GOLDEN.season });
  h.pin(GOLDEN.season, seasonAddresses(GOLDEN.program, BigInt(GOLDEN.season)));
  return { h, asked };
}

// What each place is, per stage, as the page decides it.
const WANT = {
  S0: { '0,0': 'open', '1,0': 'open', '1,-1': 'pending', '2,0': 'unopened', '0,2': 'unopened', '3,0': 'unopened', '4,0': 'outside' },
  S1: { '0,0': 'open', '1,0': 'open', '1,-1': 'pending', '2,0': 'pending', '0,2': 'pending', '3,0': 'unopened', '4,0': 'outside' },
  S2: { '0,0': 'open', '1,0': 'open', '1,-1': 'pending', '2,0': 'open', '0,2': 'pending', '3,0': 'unopened', '4,0': 'outside' },
};

test('the golden is the router\'s three stages', () => {
  assert.deepEqual(Object.keys(GOLDEN.stages), ['S0', 'S1', 'S2']);
});

test('one page polling a growing map: the season record, ring lists and places follow each stage with no reload', async () => {
  const FS = {};
  for (const stage of ['S0', 'S1', 'S2']) {
    const { h, asked } = heraldAt(stage);
    const s = await h.season();
    assert.ok(s.ok, `${stage}: ${s.code} ${s.message ?? ''}`);
    const sync = W.applySeasonRecord(FS, s.record, { herald: h });
    await tick(); await tick(); await tick();
    // Partly created rings are asked for their lists: ring 1 always ((1,−1) missing), ring 2 once seeded and partial.
    assert.deepEqual(sync.partial, stage === 'S2' ? [1, 2] : [1], stage);
    for (const d of sync.partial) assert.ok(FS.worldRings?.get(d) instanceof Set, `${stage}: ring ${d} list held`);
    assert.ok(asked.includes('/h/world/ring/1'), stage);
    // The world manifest agrees with what the page took from the season record.
    const w = GOLDEN.stages[stage]['/h/world'].body;
    assert.equal(FS.world.ringsOpened, w.ringsOpened, stage);
    assert.equal(FS.world.rMax, w.rMax, stage);
    assert.equal(FS.world.ringsOpen, w.rings.filter(r => r.seed === 'seeded').length, `${stage}: open = seeded prefix`);
    for (const [pq, want] of Object.entries(WANT[stage])) {
      const [p, q] = pq.split(',').map(Number);
      assert.equal(W.placeNow(FS, p, q), want, `${stage} (${pq})`);
    }
  }
});

test('a ring requested but not seeded: its list is not asked, and the herald\'s list says requested', async () => {
  const { h, asked } = heraldAt('S1');
  const FS = {};
  const s = await h.season();
  W.applySeasonRecord(FS, s.record, { herald: h });
  await tick(); await tick();
  assert.ok(!asked.includes('/h/world/ring/2'), 'a pending ring is pending whole; no list wanted');
  const r2 = await h.worldRing(2);
  assert.ok(r2.ok);
  assert.equal(r2.present.size, 0);
  assert.equal(GOLDEN.stages.S1['/h/world/ring/2'].body.seed, 'requested');
  assert.ok(!s.record.rings.some(r => r.d === 2), 'the season record lists seeded rings only');
});

test('provinces: an open one decodes, one never on chain is NotFound (pending, not an error of the page)', async () => {
  for (const stage of ['S0', 'S1', 'S2']) {
    const { h } = heraldAt(stage);
    const home = await h.province(1, 0);
    assert.ok(home.ok, `${stage}: ${home.code} ${home.message ?? ''}`);
    const never = await h.province(1, -1);
    assert.equal(never.ok, false);
    assert.equal(never.code, 'NotFound', stage);
    const r2 = await h.province(2, 0);
    assert.equal(r2.ok, stage === 'S2', `${stage}: (2,0) ${r2.code ?? 'ok'}`);
  }
});

test('me: the wallet\'s Citizen and its Holding at (1,0) site 0, checked against the public PDAs', async () => {
  for (const stage of ['S0', 'S1', 'S2']) {
    const { h } = heraldAt(stage);
    const me = await h.me(GOLDEN.wallet);
    assert.ok(me.ok, `${stage}: ${me.code} ${me.message ?? ''}`);
    assert.ok(me.citizen, stage);
    assert.equal(me.holdings.length, 1, stage);
    assert.deepEqual([me.holdings[0].p, me.holdings[0].q, me.holdings[0].site], [1, 0, 0], stage);
  }
});

test('the wide world and the wide index: explicit unavailability on a herald built without them, never a dense fallback', async () => {
  const { h } = heraldAt('S2');
  // The golden is the default build: both routes answer 503 with their own code (pinned, so no branch is skipped).
  for (const [path, code] of [['/h/world/wide', 'WideWorldUnavailable'], ['/h/wide-index/status', 'WideIndexUnavailable']]) {
    for (const g of [GOLDEN.stages.S2, S1.stages.grown]) {
      assert.equal(g[path].status, 503, path);
      assert.deepEqual(g[path].body, { ok: false, code }, path);
    }
  }
  const ww = await h.wideWorld();
  assert.equal(ww.ok, false);
  assert.equal(ww.code, 'WideWorldUnavailable');
  const wi = await h.wideIndexStatus();
  assert.equal(wi.ok, false);
  assert.equal(wi.code, 'WideIndexUnavailable');
});

// ------------------------------------------------------------------ S1: ring 4 → 5 with ExtendFrontier (8's contract)
// tests/golden/ws19-map-growth-s1.json: herald cqfixture::growth (layout 2, season 71, ceiling 6) through the same
// router; workstream 8's stages and coordinates (permutation-gateway/test/fixtures/frontier/growth-route.mjs on
// claude/festive-tesla-iwwc5t: before / extended / opened / grown, (4,0) → (5,0)).
const S1_STAGES = ['before', 'extended', 'opened', 'grown'];
const S1_PLACE = {
  before:   { '4,0': 'open', '5,0': 'extendable', '6,0': 'extendable', '7,0': 'beyondCeiling' },
  extended: { '4,0': 'open', '5,0': 'unopened',   '6,0': 'extendable', '7,0': 'beyondCeiling' },
  opened:   { '4,0': 'open', '5,0': 'pending',    '6,0': 'extendable', '7,0': 'beyondCeiling' },
  grown:    { '4,0': 'open', '5,0': 'open',       '6,0': 'extendable', '7,0': 'beyondCeiling' },
};
// 8's GEOMETRY: what the rules give both sides of the old edge.
const S1_GEOMETRY = {
  '4,0': { sites: [4, 33, 49, 53, 0, 11, 13, 17, 26, 28, 38, 43], passable: 2305843009188528127n, terrainSha256: 'de18bbc8320f96db3c9f0f222b91292d49d92b5f28789ab8c2e7536b69333f53' },
  '5,0': { sites: [18, 28, 45, 30, 53, 1, 4, 17, 48, 12, 35, 50], passable: 2305843009213693951n, terrainSha256: 'ab335170b74b22b6c14efb7864f645e721bc97e15617efb1fae788b55858bb51' },
};

function s1Herald(stage) {
  const answers = S1.stages[stage];
  const asked = [];
  const f = async url => {
    const path = new URL(url, 'http://h').pathname;
    asked.push(path);
    const a = answers[path] ?? { status: 404, body: { ok: false, code: 'NotFound' } };
    const body = a.body?.b64 !== undefined ? Buffer.from(a.body.b64, 'base64') : JSON.stringify(a.body);
    return new Response(body, { status: a.status, headers: { 'content-type': a.body?.b64 !== undefined ? 'application/octet-stream' : 'application/json' } });
  };
  const h = createHerald({ fetch: f, seasonId: S1.season });
  h.pin(S1.season, seasonAddresses(S1.program, BigInt(S1.season)));
  return { h, asked };
}

test('S1: the layout-2 Season decodes, and the page\'s world follows before → extended → opened → grown', async () => {
  const FS = {};
  for (const stage of S1_STAGES) {
    const { h } = s1Herald(stage);
    const s = await h.season();
    assert.ok(s.ok, `${stage}: ${s.code} ${s.message ?? ''}`);
    assert.equal(s.season.layoutVersion, 2, stage);
    W.applySeasonRecord(FS, s.record, { herald: h });
    await tick(); await tick();
    assert.equal(FS.world.rMaxCeiling, 6, stage);
    for (const [pq, want] of Object.entries(S1_PLACE[stage])) {
      const [p, q] = pq.split(',').map(Number);
      assert.equal(W.placeNow(FS, p, q), want, `${stage} (${pq})`);
    }
    const seed5 = s.record.rings.find(r => r.d === 5)?.seed ?? null;
    assert.equal(seed5 !== null, stage === 'grown', `${stage}: ring 5's seed listed only once revealed`);
    if (seed5) assert.equal(seed5, createHash('sha256').update('ring5').digest('hex'));
  }
});

test('S1: Provinces (4,0) and (5,0) decode at layout 2 with 8\'s sites, passable mask and terrain', async () => {
  for (const stage of S1_STAGES) {
    const { h } = s1Herald(stage);
    for (const key of ['4,0', '5,0']) {
      const [p, q] = key.split(',').map(Number);
      const r = await h.province(p, q);
      if (key === '5,0' && stage !== 'grown') { assert.equal(r.code, 'NotFound', `${stage} ${key}`); continue; }
      assert.ok(r.ok, `${stage} ${key}: ${r.code} ${r.message ?? ''}`);
      const pv = r.province;
      const want = S1_GEOMETRY[key];
      assert.deepEqual([...pv.sites].slice(0, pv.siteCount ?? 12), want.sites, `${stage} ${key} sites`);
      assert.equal(BigInt(pv.passableMask), want.passable, `${stage} ${key} passable`);
      assert.equal(createHash('sha256').update(Uint8Array.from(pv.terrain)).digest('hex'), want.terrainSha256, `${stage} ${key} terrain`);
    }
  }
});

test('S1: me names the wallet\'s Holding at (4,0) and its host on tile 0; overviews of rings 3–5 decode', async () => {
  for (const stage of S1_STAGES) {
    const { h } = s1Herald(stage);
    const me = await h.me(S1.wallet);
    assert.ok(me.ok, `${stage}: ${me.code} ${me.message ?? ''}`);
    assert.deepEqual([me.holdings[0].p, me.holdings[0].q, me.holdings[0].site], [4, 0, 0], stage);
    const host = me.record.hosts.find(x => x.id === S1.host);
    assert.ok(host, stage);
    assert.deepEqual([host.province, host.tile], [[4, 0], 0], stage);
    for (const d of [3, 4, 5]) {
      const o = await h.overview2(d);
      if (d === 5 && stage !== 'grown') { assert.equal(o.ok, false, `${stage}: ring ${d}`); continue; }
      assert.ok(o.ok, `${stage} ring ${d}: ${o.code} ${o.message ?? ''}`);
    }
  }
});

test('S1: the router\'s seeds and growth fields are 8\'s (growth-route.mjs ringSeed, growthFields) at every stage', async () => {
  const G = await import('./fixtures/frontier/growth-route.mjs');
  for (const stage of S1_STAGES) {
    const { h } = s1Herald(stage);
    const s = await h.season();
    assert.ok(s.ok, stage);
    const want = G.growthFields(stage);
    assert.deepEqual(s.record.rings, want.rings, `${stage}: seeded rings and seeds`);
    for (const k of ['rMax', 'ringsOpened', 'ringProvinces', 'rMaxCeiling', 'rMaxHard', 'placement', 'heartlandMaxRing']) {
      assert.deepEqual(s.record[k], want[k], `${stage} ${k}`);
    }
  }
});

test('S1: an NFT resident\'s /h/me (workstream 20): its Citizen at the resident-id address, accepted for its own asset', async () => {
  for (const stage of S1_STAGES) {
    const { h } = s1Herald(stage);
    const me = await h.me(S1.residentAsset);
    assert.ok(me.ok, `${stage}: ${me.code} ${me.message ?? ''}`);
    assert.equal(me.citizen.residentAsset !== undefined && me.citizen.residentAsset !== null, true, stage);
    assert.equal(me.record.citizen.address, S1.residentCitizen, stage);
    assert.deepEqual([me.holdings[0].p, me.holdings[0].q, me.holdings[0].site], [4, 0, 1], stage);
    // The wallet's own read is still the wallet Citizen.
    const w = await h.me(S1.wallet);
    assert.ok(w.ok && w.record.citizen.address !== S1.residentCitizen, stage);
  }
});

test('S1: the structures feed is the router\'s real empty answer at every stage, so the route has no palisade to avoid', async () => {
  for (const stage of S1_STAGES) {
    assert.equal(S1.stages[stage]['/h/structures.json'].status, 200, stage);
    const { h, asked } = s1Herald(stage);
    const r = await h.structures();
    assert.ok(r.ok, `${stage}: ${r.code} ${r.message ?? ''}`);
    assert.deepEqual(r.structures, { v: 1, structures: [], sightings: [] }, stage);
    assert.ok(asked.includes('/h/structures.json'), stage);
    // What the page's route planner is given as blocked hexes (s1walk.mjs blockedHexes → fmarch planRoute `blocked`).
    assert.deepEqual(blockedHexes(r.structures.structures, {}, 1, false), [], stage);
  }
});

// ------------------------------------------------------------------ S1 with a palisade on 8's route (a separate case)
// tests/golden/ws19-map-growth-s1-palisade.json: cqfixture::growth::palisade_case through the same router: the grown
// world, then one BuildStructure(palisade) by the faction-2 Citizen on a hex of 8's route (4,0) t0 → (5,0) t0.
// The empty-world golden above is unchanged; this one only adds the palisade.
const S1P = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1-palisade.json', import.meta.url), 'utf8'));
const ROUTE_DIRS = [0, 0, 0, 0, 1, 1, 0, 1, 1]; // 8's ROUTE.dirs (growth-route.mjs)

function s1pHerald(stage) {
  const answers = S1P.stages[stage];
  const f = async url => {
    const a = answers[new URL(url, 'http://h').pathname] ?? { status: 404, body: { ok: false, code: 'NotFound' } };
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return createHerald({ fetch: f, seasonId: S1P.season });
}

test('S1 palisade case: the router\'s structures and nations feeds give the page one blocked hex, on 8\'s route', async () => {
  // 8's route as hexes, from (4,0) tile 0 (the page's fgeo).
  let [hq, hr] = (() => { const h = tileHex(4, 0, 0); return [h.q, h.r]; })();
  const routeHexes = ROUTE_DIRS.map(d => { hq += DIRECTIONS[d][0]; hr += DIRECTIONS[d][1]; return `${hq},${hr}`; });
  const at = S1P.palisade;
  const pal = tileHex(at.p, at.q, at.tile);
  assert.ok(routeHexes.slice(0, -1).includes(`${pal.q},${pal.r}`), 'the palisade is on 8\'s route, not its destination');
  for (const stage of ['grown', 'palisade']) {
    const h = s1pHerald(stage);
    const st = await h.structures();
    assert.ok(st.ok, `${stage}: ${st.code}`);
    const na = await h.nations();
    assert.ok(na.ok, `${stage}: ${na.code}`);
    const blocked = blockedHexes(st.structures.structures, na.nations.stances, 1, false);
    if (stage === 'grown') { assert.deepEqual(blocked, [], 'no structure before the build'); continue; }
    assert.equal(st.structures.structures.length, 1);
    const s0 = st.structures.structures[0];
    assert.deepEqual([s0.p, s0.q, s0.tile, s0.kind, s0.faction], [at.p, at.q, at.tile, 2, 2]);
    // The faction-1 viewer's march must not be planned through it (stance war, read from the nations feed) …
    assert.deepEqual(blocked.map(x => `${x.q},${x.r}`), [`${pal.q},${pal.r}`]);
    // … and its own nation's (faction 2, not expelled) is not stopped: the existing rule, nothing new.
    assert.deepEqual(blockedHexes(st.structures.structures, na.nations.stances, 2, false), []);
  }
});

test('S1 palisade case: the stance is read from the nations feed, not defaulted (a pass stance stops nothing)', async () => {
  // The router's nations answer is all war, which is also stanceOf's default for a missing table; here the same answer
  // with nation 2 → faction 1 set to pass (STANCE index 1) shows the verdict follows the table read.
  const h = s1pHerald('palisade');
  const st = await h.structures();
  const na = await h.nations();
  assert.ok(st.ok && na.ok);
  const stances = na.nations.stances.map(row => [...row]);
  stances[2][1] = 1;
  assert.deepEqual(blockedHexes(st.structures.structures, stances, 1, false), [], 'pass: not stopped');
  stances[2][1] = 0;
  assert.equal(blockedHexes(st.structures.structures, stances, 1, false).length, 1, 'war: stopped');
});

// ------------------------------------------------------------------ the reads the golden lacked (4's §19, 7's ABSENT list)
// The router's own answers for the record feed, the rosters of rings 0–5, the inner overviews, the Provinces round the
// origin and the two other S1 feeds, read with the page's own decoders. A 404 the router gives stays a 404.
const S1_RECORDS = { before: 67, extended: 68, opened: 69, grown: 100 };

test('S1 golden-absent reads: the record feed, as herald.mjs events() reads it', async () => {
  for (const stage of S1_STAGES) {
    const { h } = s1Herald(stage);
    const e = await h.events(0);
    assert.ok(e.ok, `${stage}: ${e.code} ${e.message ?? ''}`);
    assert.equal(e.events.length, S1_RECORDS[stage], stage);
    assert.equal(e.next, String(S1_RECORDS[stage]), stage);
    assert.equal(e.full, false, stage);
  }
});

test('S1 golden-absent reads: rosters 0–5 decode for every open ring; ring 5 is the router\'s 404 until its Provinces exist', async () => {
  for (const stage of S1_STAGES) {
    for (let d = 0; d <= 5; d++) {
      const a = S1.stages[stage][`/h/roster/${d}/latest.bin`];
      if (d === 5 && stage !== 'grown') {
        assert.equal(a.status, 404, `${stage} ring 5`);
        assert.deepEqual(a.body, { ok: false, code: 'NoSuchRing' }, `${stage} ring 5`);
        continue;
      }
      assert.equal(a.status, 200, `${stage} ring ${d}`);
      const r = decodeRoster(Buffer.from(a.body.b64, 'base64'));
      assert.equal(r.season, 71n, `${stage} ring ${d}`);
      assert.equal(r.ring, d, `${stage} ring ${d}`);
      assert.equal(r.provinces.size, ringSize(d), `${stage} ring ${d}: one record per Province on chain`);
    }
    // The page's roster store over the same answers: the holders of (4,0) sites 0 and 1, none on site 2.
    const { f } = stageFetch2(stage);
    const store = createRoster({ fetch: f, now: () => 1e12 });
    store.ensure(4);
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(store.ownerOf(4, 0, 0), `${stage}: (4,0) site 0 held`);
    assert.ok(store.ownerOf(4, 0, 1), `${stage}: (4,0) site 1 held`);
    assert.equal(store.ownerOf(4, 0, 2), null, `${stage}: (4,0) site 2 free`);
  }
});

test('S1 golden-absent reads: overviews of rings 0–2, the Provinces round the origin, caravans and nations', async () => {
  for (const stage of S1_STAGES) {
    const { h } = s1Herald(stage);
    for (let d = 0; d <= 2; d++) {
      const o = await h.overview(d);
      assert.ok(o.ok, `${stage} overview ${d}: ${o.code} ${o.message ?? ''}`);
      const o2 = await h.overview2(d);
      assert.ok(o2.ok, `${stage} overview2 ${d}: ${o2.code} ${o2.message ?? ''}`);
    }
    for (const [p, q] of [[3, 0], [3, 1], [4, -1]]) {
      const pv = await h.province(p, q);
      assert.ok(pv.ok, `${stage} (${p},${q}): ${pv.code} ${pv.message ?? ''}`);
      assert.deepEqual([pv.province.p, pv.province.q], [p, q]);
    }
    const c = await h.caravans();
    assert.ok(c.ok, `${stage}: ${c.code}`);
    const n = await h.nations();
    assert.ok(n.ok, `${stage}: ${n.code}`);
  }
});

/** A plain fetch over one S1 stage (b64 bodies as bytes), for modules that take a fetch (people/roster.mjs). */
function stageFetch2(stage) {
  const answers = S1.stages[stage];
  const f = async url => {
    const a = answers[new URL(url, 'http://h').pathname] ?? { status: 404, body: { ok: false, code: 'NotFound' } };
    const body = a.body?.b64 !== undefined ? Buffer.from(a.body.b64, 'base64') : JSON.stringify(a.body);
    return new Response(body, { status: a.status });
  };
  return { f };
}
