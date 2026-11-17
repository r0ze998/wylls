// Key-free regression for the original game's map route preview. The cache has
// no imports. The app functions are read, then only the bounded routeTo/hoverPlan
// section is evaluated with pure stubs: no boot, controller, wallet, browser,
// network, worker, dependency import or WASM execution. The exact evaluated
// source is the section between the two comments below (reviewed with this test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRouteCache } from '../../permutation-server/web/frontier/map/routecache.mjs';

const request = () => ({ from: { p: 4, q: 0, tile: 0 }, to: { p: 5, q: 0, tile: 0 }, unit: 0,
  seeds: [{ ring: 4, seed: '04' }, { ring: 5, seed: '05' }], blocked: [{ q: 33, r: -16 }] });
const counter = (limit = 96) => {
  const calls = [];
  const cached = createRouteCache((k, args) => { const result = { ok: true, route: calls.length }; calls.push({ k, args }); return result; }, { limit });
  return { cached, calls, k: {} };
};

test('equal route inputs reuse geometry, including reordered obstacle feeds', () => {
  const { cached, calls, k } = counter(), a = request();
  a.blocked.push({ q: 34, r: -17 });
  const first = cached(k, a), equal = request();
  equal.blocked = [...a.blocked].reverse();
  assert.equal(cached(k, equal), first);
  assert.equal(calls.length, 1);
});

test('a moved palisade invalidates the route even when the count stays one', () => {
  const { cached, calls, k } = counter(), a = request();
  const first = cached(k, a);
  a.blocked[0].q++;
  assert.notEqual(cached(k, a), first);
  assert.equal(calls.length, 2);
});

test('new ring seeds invalidate even a previously refused route', () => {
  let calls = 0;
  const cached = createRouteCache((k, a) => { calls++; return { ok: a.seeds.some(s => s.ring === 5) }; });
  const k = {}, a = request(); a.seeds.pop();
  assert.equal(cached(k, a).ok, false);
  assert.equal(cached(k, a).ok, false);
  a.seeds.push({ ring: 5, seed: '05' });
  assert.equal(cached(k, a).ok, true);
  assert.equal(calls, 2);
});

test('changed seed bytes, unit and either endpoint all invalidate', () => {
  const { cached, calls, k } = counter(), a = request();
  a.seeds[0].seed = new Uint8Array([4, 4]);
  cached(k, a);
  for (const change of [() => a.seeds[0].seed[0]++, () => a.unit++, () => a.from.tile++, () => a.to.tile++]) {
    change(); cached(k, a);
  }
  assert.equal(calls.length, 5);
});

test('switching the rules kernel does not reuse an old answer', () => {
  const { cached, calls, k } = counter(), a = request();
  cached(k, a); cached({}, a); cached(k, a);
  assert.equal(calls.length, 3);
});

test('bounded LRU retains recent routes and evicts the oldest', () => {
  const { cached, calls, k } = counter(2), a = request(), b = request(), c = request();
  b.to.tile = 1; c.to.tile = 2;
  const first = cached(k, a);
  cached(k, b); assert.equal(cached(k, a), first); cached(k, c);
  assert.equal(cached(k, a), first);
  cached(k, b);
  assert.equal(calls.length, 4);
});

const app = readFileSync(process.env.WYLLS_ROUTE_APP ?? new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
function pagePlanner() {
  const start = app.indexOf('const cachedRoute = createRouteCache(') >= 0 ? app.indexOf('const cachedRoute = createRouteCache(') : app.indexOf('const routeCache = new Map();');
  const end = app.indexOf("/** The map's own answer", start);
  assert.ok(start >= 0 && end > start, 'only the reviewed routeTo/hoverPlan section is evaluated');
  const FS = { mode: 'play', record: { rings: [{ d: 4, seed: '04' }, { d: 5, seed: '05' }] }, nowBell: 10,
    clock: { genesisTs: 0 }, chain: { now: () => 6050, rate: 1 }, season: { minLead: 2, maxLead: 72 }, blocked: [{ q: 33, r: -16 }] };
  const A = { actor: { id: '7', unit: 0, march: { ok: true } }, origin: { p: 4, q: 0, tile: 0 }, mode: 'select', byHex: new Map() };
  let calls = 0, ticks = 0;
  const context = { FS, createRouteCache, wantKernel: () => kernel, actionsNow: () => A,
    seedsNow: () => FS.record.rings.map(s => ({ ring: s.d, seed: s.seed })),
    palisadeHexesOf: fs => fs.blocked,
    planRoute: (k, a) => { calls++; return a.seeds.some(s => s.ring === 5) ? { ok: true, route: { secs: 1320, hexes: a.blocked.map(h => ({ q: h.q + 1, r: h.r })) } } : { ok: false, code: 'NoPath' }; },
    earliestBell: (k, { departTs, secs }) => Math.ceil((departTs + secs) / 600),
    departMargin: rate => Math.max(90, rate * 2),
    arrivalWindow: (season, now, early) => ({ min: Math.max(now + season.minLead, early) }),
    marchCard: { routeHexes: c => c.route.hexes },
    mapRef: { tick: () => ticks++ },
  };
  const kernel = {};
  const api = runInNewContext(`${app.slice(start, end)}\n({routeTo, hoverPlan, hover: () => hoverRoute})`, context);
  return { ...api, FS, A, calls: () => calls, ticks: () => ticks };
}
const target = { p: 5, q: 0, tile: 0 };
const hit = { p: 5, q: 0, idx: 0, tileQ: 45, tileR: -20 };

test('the original page changes its preview after a same-count palisade move', () => {
  const p = pagePlanner(), first = p.routeTo(p.A, target);
  p.FS.blocked[0].q++;
  const next = p.routeTo(p.A, target);
  assert.notEqual(next.hexes[0].q, first.hexes[0].q);
  assert.equal(p.calls(), 2);
});

test('the original page retries a refused preview after the next ring gains its seed', () => {
  const p = pagePlanner(); p.FS.record.rings.pop();
  assert.equal(p.routeTo(p.A, target).ok, false);
  p.FS.record.rings.push({ d: 5, seed: '05' });
  assert.equal(p.routeTo(p.A, target).ok, true);
});

test('arrival advances within one turn without recalculating the geometry', () => {
  const p = pagePlanner(), first = p.routeTo(p.A, target);
  p.FS.chain.now = () => 6590;
  const next = p.routeTo(p.A, target);
  assert.equal(p.FS.nowBell, 10, 'same turn as the old cache key');
  assert.ok(next.arriveBell > first.arriveBell);
  assert.equal(p.calls(), 1, 'only the path is cached');
});

test('hovering the same tile refreshes its path and arrival from current state', () => {
  const p = pagePlanner();
  p.hoverPlan(hit); const first = p.hover();
  p.FS.blocked[0].q++; p.FS.chain.now = () => 6590;
  p.hoverPlan(hit, { redraw: false }); const next = p.hover();
  assert.notEqual(next.hexes[0].q, first.hexes[0].q);
  assert.ok(next.arriveBell > first.arriveBell);
  assert.equal(p.ticks(), 1, 'refreshing inside a draw never schedules another draw');
});

test('losing the hand clears the old hover ribbon without a pointer event', () => {
  const p = pagePlanner(); p.hoverPlan(hit); assert.ok(p.hover());
  p.A.actor.march.ok = false;
  p.hoverPlan(hit, { redraw: false });
  assert.equal(p.hover(), null);
});

test('a newly hidden target loses its hover ribbon', () => {
  const p = pagePlanner(); p.hoverPlan(hit); assert.ok(p.hover());
  p.FS.survey = { showAll: false, levelOf: () => 0 };
  p.hoverPlan(hit, { redraw: false });
  assert.equal(p.hover(), null);
});

test('the map source refreshes stationary hover before handing its ribbon to the renderer', () => {
  const source = app.slice(app.indexOf('map = new FrontierMap(canvas,'), app.indexOf('onSelect: hit0 =>'));
  assert.match(source, /hoverPlan\(hoverHit, \{ redraw: false \}\)/);
  assert.ok(source.indexOf('surveyNow()') >= 0 && source.indexOf('surveyNow()') < source.indexOf('hoverPlan('), 'refresh survey before deciding which route is visible');
  assert.ok(source.indexOf('hoverPlan(') < source.indexOf('hoverRoute,'));
});
