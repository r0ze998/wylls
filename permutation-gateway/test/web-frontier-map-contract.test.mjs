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

const GOLDEN = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth.json', import.meta.url), 'utf8'));
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
  const ww = await h.wideWorld();
  const wantWide = GOLDEN.stages.S2['/h/world/wide'];
  if (wantWide.status === 200) assert.ok(ww.ok, ww.code);
  else { assert.equal(ww.ok, false); assert.equal(ww.code, 'WideWorldUnavailable'); }
  const wi = await h.wideIndexStatus();
  const wantIx = GOLDEN.stages.S2['/h/wide-index/status'];
  if (wantIx.status !== 200) { assert.equal(wi.ok, false); assert.match(wi.code, /^WideIndex|^[A-Za-z0-9]+$/); }
});

// ------------------------------------------------------------------ S1: ring 4 → 5 with ExtendFrontier (8's contract)
// tests/golden/ws19-map-growth-s1.json: herald cqfixture::growth (layout 2, season 71, ceiling 6) through the same
// router; workstream 8's stages and coordinates (permutation-gateway/test/fixtures/frontier/growth-route.mjs on
// claude/festive-tesla-iwwc5t: before / extended / opened / grown, (4,0) → (5,0)).
const S1 = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url), 'utf8'));
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
