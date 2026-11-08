// Map growth, ring 4 → ring 5, on the S1 rules module the page loads (workstream 08): the growth stages of
// test/fixtures/frontier/growth-route.mjs read through the page's own modules —
//   map/world.mjs  worldOf / placeOf            the place state of the new ring at each stage
//   fconquest.mjs  kernelFile                    which kernel an S1 season (layout 2, program_version 4) loads
//   wasm.mjs       loadKernel                    frontier-v3.wasm, checked against its published sha256 and the S1
//                                                ruleset hash (abi-v2-presets ruleset_hash_v3)
//   fmarch.mjs     planRoute                    the route, with the seeds the page passes (the record's `rings`)
//   map/terrain.mjs createTerrain               the page's terrain reader, on the record's seeds
//   fgeo.mjs       ringOf / wedgeOf / regionOf / tileHex   the page's geometry, against the kernel's
// A ring with no seed in the record has no route and no terrain; once its seed is listed, its Provinces are read
// and routed by the same rules as the rings before it. The only account bytes are the S1 Season and Frontier
// (layout 2, the SDK's encoder), read by the page's herald and fcodec; Province / Holding bytes are workstream 19's.
// No M1 account, no key. The existing live-map route evidence runs on frontier.wasm (M1); this is the S1 one.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as W from '../../permutation-server/web/frontier/map/world.mjs';
import * as Wasm from '../../permutation-server/web/frontier/wasm.mjs';
import { kernelFile } from '../../permutation-server/web/frontier/fconquest.mjs';
import { planRoute } from '../../permutation-server/web/frontier/fmarch.mjs';
import { createTerrain } from '../../permutation-server/web/frontier/map/terrain.mjs';
import { ringOf, wedgeOf, regionOf, tileHex, provinceCentre, ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { PRESETS } from '../../permutation-server/web/sdk/frontier/abi-v2-presets.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import * as G from './fixtures/frontier/growth-route.mjs';

const S1 = { layoutVersion: 2, programVersion: 4 };
let k = null;

before(async () => {
  const file = kernelFile(S1);
  assert.equal(file, 'frontier-v3.wasm', 'an S1 season loads the v3 rules module');
  const dir = new URL('../../permutation-server/web/frontier/wasm/', import.meta.url);
  const bytes = readFileSync(new URL(file, dir));
  const published = readFileSync(new URL(`${file}.sha256`, dir), 'utf8').trim().split(/\s+/)[0];
  k = await Wasm.loadKernel({ url: 'frontier-v3.wasm', sha256Hex: published, ruleset: PRESETS.ruleset_hash_v3,
    fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
});

/** The page's seeds for a record (app.mjs seedsNow / controller.mjs). */
const seedsOf = rec => (rec.rings ?? []).map(r => ({ ring: r.d, seed: r.seed }));
const route = rec => planRoute(k, { from: G.ORIGIN, to: G.TARGET, unit: 0, seeds: seedsOf(rec) });

test('each stage: the new ring\'s place state, its seed in the record, and the route across the old edge', () => {
  for (const stage of G.STAGE_ORDER) {
    const rec = G.withGrowth({ v: 1, season: '71' }, stage), want = G.EXPECT[stage];
    const w = W.worldOf(rec);
    assert.equal(W.placeOf(w, G.TARGET.p, G.TARGET.q), want.place, stage);
    assert.equal(W.placeOf(w, G.ORIGIN.p, G.ORIGIN.q), 'open', `${stage}: ring 4 stays open`);
    assert.equal(rec.rings.some(r => r.d === 5), want.seed5, stage);
    const r = route(rec);
    if (typeof want.route === 'string') assert.deepEqual(r, { ok: false, code: want.route }, `${stage}: no seed, no route`);
    else {
      assert.ok(r.ok, `${stage}: ${r.code}`);
      const { dirs, pathLen, hexes, secs, provinces } = r.route;
      assert.deepEqual({ dirs, pathLen, hexes, secs, provinces }, want.route, stage);
    }
  }
});

test('the record\'s stage fields: effective rMax, ceiling and hard limit as chapter 28 states them', () => {
  assert.equal(G.growthFields('before').rMax, 4);
  assert.equal(G.growthFields('extended').rMax, 5, 'max(Season r_max 4, Frontier R_MAX_EXT 5)');
  const w = W.worldOf(G.growthFields('grown'));
  assert.equal(W.placeOf(w, 6, 0), 'extendable', 'ring 6: under the ceiling, past the grown edge');
  assert.equal(W.placeOf(w, 7, 0), 'beyondCeiling');
  assert.equal(W.placeOf(w, 129, 0), 'beyondHard');
  // a record whose bytes the fixture does not touch keeps them (withGrowth replaces only the growth fields)
  const golden = { v: 1, bytes_b64: 'AAAA', genesisTs: 1, bellSecs: 600, rMax: 4 };
  const g = G.withGrowth(golden, 'grown');
  assert.equal(g.bytes_b64, 'AAAA'); assert.equal(g.bellSecs, 600); assert.equal(g.rMax, 5);
});

test('a ring with no seed has no route anywhere in it, even inside one Province; its seed gives one', () => {
  const inner = seeds => planRoute(k, { from: G.TARGET, to: { ...G.TARGET, tile: 1 }, unit: 0, seeds });
  assert.deepEqual(inner(G.plannerSeeds(5)), { ok: false, code: 'NoPath' });
  assert.equal(inner(G.plannerSeeds(6)).ok, true);
  // the same at the next edge: ring 6 unseeded, then seeded (tile 0 of (6,0) is not passable; tile 1 is)
  const out = seeds => planRoute(k, { from: G.TARGET, to: { p: 6, q: 0, tile: 1 }, unit: 0, seeds });
  assert.deepEqual(out(G.plannerSeeds(6)), { ok: false, code: 'NoPath' });
  assert.equal(out(G.plannerSeeds(7)).ok, true);
});

test('the grown ring is read by the same rules: geometry (page = kernel) and terrain from its seed', async () => {
  for (const [key, want] of Object.entries(G.GEOMETRY)) {
    const [p, q] = key.split(',').map(Number);
    assert.equal(ringOf(p, q), want.ring); assert.equal(k.call('ring_of', { p, q }).value, want.ring);
    assert.equal(wedgeOf(p, q), want.wedge); assert.equal(k.call('wedge_of', { p, q }).value, want.wedge);
    assert.equal(regionOf(p, q), want.region); assert.equal(k.call('region_of', { p, q }).value, want.region);
    assert.deepEqual(provinceCentre(p, q), want.centre);
    assert.deepEqual(tileHex(p, q, 0), want.tile0);
  }
  // every Province of rings 4 and 5: the page's geometry agrees with the kernel's (one rule across the old edge)
  for (const d of [4, 5]) for (const { p, q } of ringProvinces(d)) {
    assert.equal(k.call('ring_of', { p, q }).value, d);
    assert.equal(k.call('wedge_of', { p, q }).value, wedgeOf(p, q), `${p},${q}`);
    assert.equal(k.call('region_of', { p, q }).value, regionOf(p, q), `${p},${q}`);
  }
  // the page's terrain reader on each stage's record: nothing for ring 5 until its seed is listed
  for (const stage of G.STAGE_ORDER) {
    const rec = G.growthFields(stage);
    let ready;
    const done = new Promise(r => { ready = r; });
    const terrainOf = createTerrain({ load: () => k, seedOf: d => rec.rings.find(r => r.d === d)?.seed ?? null, onReady: () => ready() });
    assert.equal(terrainOf(4, 0), null, 'first ask: the module loads');
    await done;
    for (const [key, want] of Object.entries(G.GEOMETRY)) {
      const [p, q] = key.split(',').map(Number), t = terrainOf(p, q);
      if (want.ring === 5 && !G.EXPECT[stage].seed5) { assert.equal(t, null, `${stage}: ring 5 has no terrain without its seed`); continue; }
      assert.ok(t, `${stage} ${key}`);
      assert.equal(createHash('sha256').update(Uint8Array.from(t.terrain)).digest('hex'), want.terrainSha256, `${stage} ${key}`);
      assert.deepEqual(t.sites, want.sites);
      assert.equal(t.passable, want.passableMask);
    }
  }
});

test('the S1 bytes: the page\'s herald decodes the Season at layout 2 / v4 with the v3 ruleset; rMax = max(Season, Frontier)', async () => {
  for (const stage of G.STAGE_ORDER) {
    const rec = G.seasonRecord(stage);
    const fetch = async url => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => rec, text: async () => JSON.stringify(rec), arrayBuffer: async () => new ArrayBuffer(0), url });
    const r = await createHerald({ base: 'http://h', fetch }).season();
    assert.ok(r.ok, `${stage}: ${r.code}`);
    const s = r.season, cq = [s.conquestParams].flat()[0];
    assert.equal(Buffer.from(rec.bytes_b64, 'base64').length, 2048, 'a layout-2 Season (not a layout-1 one)');
    assert.deepEqual([s.layoutVersion, s.programVersion], [2, 4]);
    assert.equal(kernelFile(s), 'frontier-v3.wasm');
    assert.equal(Buffer.from(s.rulesetHash).toString('hex'), PRESETS.ruleset_hash_v3, 'the kernel the before() hook loaded is the one this Season names');
    assert.deepEqual([cq.rMaxCeiling, cq.placement, cq.continuous, cq.heartlandMaxRing], [G.CEILING, 0, 0, 3]);
    assert.equal(s.rMax, G.SEASON_R_MAX, 'the extension does not rewrite the Season');
    const fb = G.frontierBytes(stage), f = decode('Frontier', fb, { seasonId: G.SEASON_ID });
    assert.equal(fb.length, 512);
    assert.equal(f.ringsOpened, rec.ringsOpened, stage);
    assert.equal(Math.max(s.rMax, f.rMaxExt), rec.rMax, `${stage}: the herald's rMax is the effective one`);
    assert.equal(rec.rMaxCeiling, cq.rMaxCeiling);
  }
});
