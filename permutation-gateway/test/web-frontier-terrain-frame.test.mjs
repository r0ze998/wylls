// The terrain a map frame makes anew is bounded, what a frame asks for is not dropped under it, and a picture painted
// while a neighbour's terrain waits is not kept as the final one (map/terrain.mjs, map/sprites.mjs, map/fmap.mjs).
// The far tile view of ring 128 asked for 653 provinces a frame from a store that kept 256. No browser, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTerrain, TERRAIN_CACHE, TERRAIN_FRAME_MS, TERRAIN_FRAME_MIN } from '../../permutation-server/web/frontier/map/terrain.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));

/** A terrain module whose every generation takes `cost` ms of the injected clock. */
function rig({ cost = 1 } = {}) {
  const log = { made: 0, ready: 0, clock: 0, deferred: [] };
  const k = { call: (name, { p, q }) => { log.made++; log.clock += cost; return { ok: true, value: { terrain: { terrain: new Array(61).fill((p + q) & 3), sites: [1, 2, 3], siteCount: 3 }, passableMask: 1n } }; } };
  const terrainOf = createTerrain({ load: () => k, seedOf: () => 'ab'.repeat(32), onReady: () => { log.ready++; }, now: () => log.clock, defer: f => { log.deferred.push(f); } });
  return { log, terrainOf };
}
const RING = ringProvinces(128);

test('outside a map frame every ask is answered at once and kept: all 768 provinces of ring 128, asked round and round, are made once', async () => {
  const { log, terrainOf } = rig();
  assert.equal(TERRAIN_CACHE >= 768, true, 'the widest ring fits');
  assert.equal(terrainOf(128, 0), null, 'first ask: the module loads'); await pause(1); assert.equal(log.ready, 1);
  for (let round = 0; round < 3; round++) for (const { p, q } of RING) assert.ok(terrainOf(p, q), `${p},${q}`);
  assert.equal(log.made, 768, 'made once each: nothing was dropped and made again (11,829 asks a frame from a store of 256)');
  assert.equal(log.deferred.length, 0);
});

test('inside a map frame new terrain is made within the frame\'s budget; the rest waits for the next frame, which is asked for once', async () => {
  const { log, terrainOf } = rig({ cost: 2 });
  terrainOf(128, 0); await pause(1);
  let frames = 0, got = 0;
  while (got < RING.length && frames < 400) {
    frames++; terrainOf.frame(); terrainOf.frame();
    const before = log.made; got = 0;
    for (let round = 0; round < 2; round++) for (const { p, q } of RING) if (terrainOf(p, q)) got += round;
    const made = log.made - before;
    assert.ok(made <= Math.max(TERRAIN_FRAME_MIN, Math.ceil(TERRAIN_FRAME_MS / 2)), `frame ${frames}: ${made} provinces made`);
    if (got < RING.length) { assert.equal(log.deferred.length, 1, 'one request for another frame'); log.deferred.splice(0).forEach(f => f()); }
    await Promise.resolve(); await Promise.resolve();   // the frame's task ends
  }
  assert.equal(got, RING.length, 'every province has its terrain in the end'); assert.equal(log.made, 768, 'each made once');
  assert.ok(frames > 100 && frames < 400, `${frames} frames`); assert.ok(log.ready >= frames - 1, 'the map was asked to draw again after each short frame');
  // a slow module still makes TERRAIN_FRAME_MIN a frame; and after the frame's task every ask is answered again
  const slow = rig({ cost: 500 }); slow.terrainOf(128, 0); await pause(1);
  slow.terrainOf.frame(); let n = 0; for (const { p, q } of RING.slice(0, 50)) if (slow.terrainOf(p, q)) n++;
  assert.equal(n, TERRAIN_FRAME_MIN);
  await Promise.resolve(); await Promise.resolve();
  for (const { p, q } of RING.slice(0, 50)) assert.ok(slow.terrainOf(p, q)); assert.equal(slow.log.made, 50);
  // a province with no seed is no answer and costs nothing of the budget
  const none = createTerrain({ load: () => ({ call: () => { throw new Error('not asked'); } }), seedOf: () => null });
  none(0, 0); await pause(1); none.frame(); assert.equal(none(5, 0), null);
});

test('the map begins a terrain frame when it draws, after the page\'s own source has been read', () => {
  const fmap = readFileSync(new URL('../../permutation-server/web/frontier/map/fmap.mjs', import.meta.url), 'utf8');
  assert.match(fmap, /const src = this\.source\(\);\n    \/\/ [^\n]*\n    \(src\.terrainOf \?\? this\.terrainOf\)\?\.frame\?\.\(\);\n    this\.rings = src\.ringsOpen \?\? 1;/);
});

test('a frame that asks for more provinces than the store keeps still ends: what a frame asks for is not dropped under it', async () => {
  const { TERRAIN_CACHE_MAX } = await import('../../permutation-server/web/frontier/map/terrain.mjs');
  const { log, terrainOf } = rig({ cost: 1 });
  const many = []; for (let d = 30; many.length < 3000; d++) many.push(...ringProvinces(d));
  many.length = 3000; assert.ok(many.length > TERRAIN_CACHE && many.length < TERRAIN_CACHE_MAX);
  terrainOf(128, 0); await pause(1);
  let frames = 0, got = 0;
  while (got < many.length && frames < 800) {
    frames++; terrainOf.frame(); got = 0;
    for (const { p, q } of many) if (terrainOf(p, q)) got++;
    log.deferred.splice(0).forEach(f => f());
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(got, many.length, `whole after ${frames} frames`); assert.equal(log.made, 3000, 'each province made once: none was dropped and made again');
  assert.equal(terrainOf.kept(), 3000, 'the store holds the frame, past its usual size');
  // two more such frames make nothing and ask for no further frame
  for (let i = 0; i < 2; i++) { terrainOf.frame(); for (const { p, q } of many) assert.ok(terrainOf(p, q)); await Promise.resolve(); await Promise.resolve(); }
  assert.equal(log.made, 3000); assert.equal(log.deferred.length, 0);
  // an ask from outside a frame (a panel, the viewer's own land) while such frames are drawn drops none of them
  // (fix-opening-view-perf: after joining, one such ask emptied the store to TERRAIN_CACHE under the world view)
  for (const { p, q } of ringProvinces(128)) terrainOf(p, q);
  assert.equal(terrainOf.kept(), 3000 + 768, `${terrainOf.kept()} kept`);
  terrainOf.frame(); for (const { p, q } of many) assert.ok(terrainOf(p, q)); await Promise.resolve(); await Promise.resolve();
  assert.equal(log.made, 3000 + 768, 'nothing of the frame was made again');
  // once such frames are over (two frames that ask for none of them), the store goes back to its size as other provinces are asked for
  for (let i = 0; i < 2; i++) { terrainOf.frame(); await Promise.resolve(); await Promise.resolve(); }
  for (const { p, q } of ringProvinces(127)) terrainOf(p, q);
  assert.ok(terrainOf.kept() <= TERRAIN_CACHE, `${terrainOf.kept()} kept`);
});

test('the store follows the view past TERRAIN_CACHE_MAX (the opening world view of a 129-ring world, 13,800 provinces) up to TERRAIN_CACHE_CEIL', async () => {
  const { TERRAIN_CACHE_MAX, TERRAIN_CACHE_CEIL } = await import('../../permutation-server/web/frontier/map/terrain.mjs');
  assert.ok(TERRAIN_CACHE_CEIL >= 41000, 'the widest far view (the coarse chart\'s edge, 1280×800) fits');
  // (provinces on a square of the lattice: the rig's every province has a seed)
  const rings = (from, n) => { const out = []; for (let p = from; out.length < n; p++) for (let q = 0; q < 400 && out.length < n; q++) out.push({ p, q }); return out; };
  // a frame of 13,800: held whole, made once, and the next frames make nothing
  const big = rig({ cost: 0 }); big.terrainOf(128, 0); await pause(1);
  const view = rings(40, 13800); assert.ok(view.length > TERRAIN_CACHE_MAX);
  for (let i = 0; i < 3; i++) { big.terrainOf.frame(); for (const { p, q } of view) assert.ok(big.terrainOf(p, q)); await Promise.resolve(); await Promise.resolve(); }
  assert.equal(big.log.made, 13800, 'each province made once: none was dropped and made again');
  assert.equal(big.terrainOf.kept(), 13800);
  // the stated limit: a frame of more than TERRAIN_CACHE_CEIL provinces is not held whole (it drops, and may make again); it does not grow without end
  const huge = rig({ cost: 0 }); huge.terrainOf(128, 0); await pause(1);
  const more = rings(10, TERRAIN_CACHE_CEIL + 500);
  for (let i = 0; i < 2; i++) { huge.terrainOf.frame(); for (const { p, q } of more) huge.terrainOf(p, q); await Promise.resolve(); await Promise.resolve(); }
  assert.ok(huge.terrainOf.kept() <= TERRAIN_CACHE_CEIL + 1, `${huge.terrainOf.kept()} kept`);
});

test('a neighbour whose terrain waits for the next frame is told apart from land that has none', async () => {
  const { terrainLookup } = await import('../../permutation-server/web/frontier/map/sprites.mjs');
  const { tileHex } = await import('../../permutation-server/web/frontier/fgeo.mjs');
  const log = { made: 0, clock: 0 };
  const k = { call: () => { log.made++; log.clock += 100; return { ok: true, value: { terrain: { terrain: new Array(61).fill(1), sites: [], siteCount: 0 }, passableMask: 1n } }; } };
  const terrainOf = createTerrain({ load: () => k, seedOf: d => (d === 128 ? 'ab'.repeat(32) : null), now: () => log.clock, defer: () => {} });
  terrainOf(128, 0); await pause(1);
  let waits = 0; const at = terrainLookup(terrainOf, () => { waits++; }), tile = (p, q) => { const h = tileHex(p, q, 30); return at(h.q, h.r); };
  // outside a frame: answered; land with no seed: no answer, and not a wait
  assert.ok(tile(128, 0)); assert.equal(tile(5, 0), null); assert.equal(waits, 0);
  terrainOf.frame();
  for (const pr of ringProvinces(128).slice(1, 1 + TERRAIN_FRAME_MIN)) assert.ok(tile(pr.p, pr.q));
  assert.equal(waits, 0);
  const late = ringProvinces(128)[40];
  assert.equal(tile(late.p, late.q), null); assert.equal(waits, 1, 'the frame had made its share: a wait');
  assert.equal(tile(5, 0), null); assert.equal(waits, 1, 'unseeded land is still not a wait');
  assert.ok(tile(128, 0), 'what is already kept is answered inside a starved frame too'); assert.equal(waits, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(tile(late.p, late.q), 'answered once the frame is over'); assert.equal(waits, 1);
  assert.equal(terrainLookup(terrainOf)(0, 0), null, 'no onWait: as before');
});

test('a far bitmap painted while a neighbour\'s terrain waits is shown, not kept; the next frame paints and keeps the finished one', async () => {
  const ctx = () => { const grad = { addColorStop() {} }; const t = { createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => ({ setTransform() {} }), measureText: () => ({ width: 8 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
    return new Proxy(t, { get: (o, key) => (key in o ? o[key] : () => {}), set: (o, key, v) => { o[key] = v; return true; } }); };
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; this.c = ctx(); this.c.canvas = this; } getContext() { return this.c; } };
  globalThis.Image = class { set src(v) { this.width = this.height = this.naturalWidth = this.naturalHeight = 64; this.complete = true; queueMicrotask(() => this.onload?.()); } };
  const { SpriteArt, terrainLookup } = await import('../../permutation-server/web/frontier/map/sprites.mjs');
  const log = { made: 0, clock: 0, ready: 0, deferred: [] };
  const k = { call: (n, { p, q }) => { log.made++; log.clock += 100; return { ok: true, value: { terrain: { terrain: Array.from({ length: 61 }, (_, i) => (p + q + i) % 4), sites: [3, 9], siteCount: 2 }, passableMask: (1n << 61n) - 1n } }; } };
  const terrainOf = createTerrain({ load: () => k, seedOf: d => (d === 128 ? 'ab'.repeat(32) : null), now: () => log.clock, defer: f => { log.deferred.push(f); }, onReady: () => { log.ready++; } });
  terrainOf(128, 0); await pause(1);
  const art = new SpriteArt({ onLoad: () => {} });
  const terrainAt = terrainLookup(terrainOf, () => { art.misses++; });
  const survey = { showAll: false, province: () => ({ kind: 'chart', max: 1, min: 1, sig: '1', sig2: '1' }), levelOf: () => 1, levelAt: () => 1, tiles: new Map() };
  // the province in the middle of the ring's side: its own terrain is known (asked outside a frame); its neighbours' is not yet
  const mid = ringProvinces(128)[64], own = terrainOf(mid.p, mid.q);
  const entry = () => ({ ...mid, ...own, rec: null, fog: 'distant', selected: false });
  const opts = { res: 0.05, dpr: 1, terrainAt, fogAt: () => 'clear', survey };
  const asks = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  // frame 1: the frame's share of new terrain is used up at once (each generation takes 100 ms of the clock)
  terrainOf.frame();
  for (const pr of ringProvinces(128).slice(200, 200 + TERRAIN_FRAME_MIN)) terrainOf(pr.p, pr.q);
  const waited = terrainOf.waited();
  const first = art.farBitmap(entry(), opts);
  assert.ok(first?.cv, 'a picture is shown'); assert.ok(terrainOf.waited() > waited, 'its chart asked for a neighbour that waits');
  assert.equal(art.farCache.size, 0, 'and it is not kept as the province\'s picture');
  assert.equal(log.deferred.length, 1, 'another frame was asked for');
  log.deferred.splice(0).forEach(f => f()); assert.equal(log.ready, 2);
  await asks();
  // following frames: the neighbours' terrain is made, a few a frame; the picture is painted again each time until none waits, then kept
  let frames = 0, kept = null;
  while (!kept && frames < 40) {
    frames++; terrainOf.frame();
    const v = art.farBitmap(entry(), opts);
    if (art.farCache.size) kept = v; else { assert.notEqual(v, first, 'painted again, not the unfinished one'); log.deferred.splice(0).forEach(f => f()); }
    await asks();
  }
  assert.ok(kept, `kept after ${frames} more frames`); assert.ok(frames >= 1);
  const madeAt = log.made;
  terrainOf.frame(); assert.equal(art.farBitmap(entry(), opts), kept, 'the finished picture is the one handed out from now on'); assert.equal(log.made, madeAt); assert.equal(log.deferred.length, 0);
});

test('the tile view\'s ground: an unsurveyed province\'s chart bitmap painted while a neighbour\'s terrain waits is not kept; the finished one is', async () => {
  const ctx = () => { const grad = { addColorStop() {} }; const t = { createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => ({ setTransform() {} }), measureText: () => ({ width: 8 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
    return new Proxy(t, { get: (o, key) => (key in o ? o[key] : () => {}), set: (o, key, v) => { o[key] = v; return true; } }); };
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; this.c = ctx(); this.c.canvas = this; } getContext() { return this.c; } };
  globalThis.Image = class { set src(v) { this.width = this.height = this.naturalWidth = this.naturalHeight = 64; this.complete = true; queueMicrotask(() => this.onload?.()); } };
  const { SpriteArt, terrainLookup } = await import('../../permutation-server/web/frontier/map/sprites.mjs');
  const log = { made: 0, clock: 0, deferred: [] };
  // (the ring seed of the local test world is all zeros; the stand-in module takes any seed)
  const k = { call: (n, { p, q }) => { log.made++; log.clock += 100; return { ok: true, value: { terrain: { terrain: Array.from({ length: 61 }, (_, i) => (p + q + i) % 4), sites: [3, 9], siteCount: 2 }, passableMask: (1n << 61n) - 1n } }; } };
  const store = () => createTerrain({ load: () => k, seedOf: d => (d === 128 ? '00'.repeat(32) : null), now: () => log.clock, defer: f => { log.deferred.push(f); } });
  const art = new SpriteArt({ onLoad: () => {} });
  const survey = { showAll: false, rev: 1, province: () => ({ kind: 'chart', max: 1, min: 1, sig: '1', sig2: '1' }), levelOf: () => 1, levelAt: () => 1, tiles: new Map(), away: new Map(), anchors: [] };
  const mid = ringProvinces(128)[64];
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  // (the sprites are asked for once with a store outside any frame, so that only the terrain is still to come below)
  const warm = store(); warm(128, 0); await pause(1);
  const own = warm(mid.p, mid.q);
  const entries = () => [{ ...mid, ...own, rec: null, fog: 'distant', selected: false, prov: null }];
  const opts = terrainAt => ({ zoom: 1, dpr: 1, artZoom: 1, terrainAt, fogAt: () => 'clear', survey, ringsOpen: 129 });
  art.paint(ctx(), entries(), opts(terrainLookup(warm, () => { art.misses++; }))); await settle();
  const neighbours = log.made;
  assert.ok(neighbours > 1, 'the chart reads its neighbours\' terrain');
  assert.equal(art.groundCache.size, 1, 'with every neighbour answered the chart bitmap is kept, as ever');
  art.groundCache.clear(); art.groundPixels = 0;
  // a starved frame of a store that has none of them yet: the frame's share is used up before the province is painted
  const fresh = store(); fresh(128, 0); await pause(1); fresh(mid.p, mid.q);
  const at = terrainLookup(fresh, () => { art.misses++; });
  fresh.frame(); for (const pr of ringProvinces(128).slice(300, 300 + TERRAIN_FRAME_MIN)) fresh(pr.p, pr.q);
  const waited = fresh.waited();
  art.paint(ctx(), entries(), opts(at));
  assert.ok(fresh.waited() > waited, 'the chart asked for a neighbour whose terrain waits');
  assert.equal(art.groundCache.size, 0, 'the bitmap painted across it is not kept');
  assert.ok(log.deferred.length >= 1, 'another frame was asked for');
  // the frames after: a few neighbours a frame, painted again each time, kept once none waits
  let frames = 0;
  while (art.groundCache.size === 0 && frames < 60) { frames++; log.deferred.splice(0).forEach(f => f()); await settle(); fresh.frame(); art.paint(ctx(), entries(), opts(at)); }
  assert.equal(art.groundCache.size, 1, `kept after ${frames} more frames`); assert.ok(frames >= 1);
  const kept = [...art.groundCache.values()][0], made = log.made;
  await settle(); fresh.frame(); art.paint(ctx(), entries(), opts(at));
  assert.equal([...art.groundCache.values()][0], kept, 'the finished bitmap stays'); assert.equal(log.made, made, 'and nothing is made again');
});
