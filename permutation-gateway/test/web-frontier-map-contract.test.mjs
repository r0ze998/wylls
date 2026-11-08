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
