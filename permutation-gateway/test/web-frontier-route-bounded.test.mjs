// The page's route when the kernel's own planner finds none (froute-bounded.mjs, used by fmarch.planRoute): the kernel
// chooses the fastest route by hex alone and checks the 4-province limit only afterwards, so a legal slower route was
// hidden (a test world of 2026-11-14: from tile 38 of (1,1) to the keep tile 18 of (-2,4), "届く砦 0"). The bounded
// search keeps the limits in its state and every answer is checked by the kernel's own path_cost. The real kernel and
// that world's ring seeds (public test data) are used; nothing is sent.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Wasm from '../../permutation-server/web/frontier/wasm.mjs';
import { planRoute } from '../../permutation-server/web/frontier/fmarch.mjs';
import { planBounded, BOUNDED_MAX_STEPS, BOUNDED_MAX_PROVINCES, BOUNDED_STATE_BUDGET } from '../../permutation-server/web/frontier/froute-bounded.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';

const SEEDS = [
  { ring: 0, seed: '4180c38788c477c5a4b68b13b92f26a44f9e5333bc3f7ac58ee8fc9c2c0632bb' },
  { ring: 1, seed: '30cf4ab07ee8fed364c21a0b3bd8c8cef73a11ddbf23415f52495cd5f4bf6467' },
  { ring: 2, seed: '6efc28152a2bffd8798a507f88cd78f142bdbb68fea4a6b9b819c050ad0694d8' },
  { ring: 3, seed: '1b5637bdfaf6cd844e591ba2725478a5e2fc80b08788b7b43fc9cc7cd1a127a0' },
  { ring: 4, seed: 'b833395921cfd79eef3feda514a1f1e5ee852da56e16580189d3f776bd4d08f3' },
];
const RULESET = '234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d';
const FROM = { p: 1, q: 1, tile: 38 }, KEEP = { p: -2, q: 4, tile: 18 };
let k;
before(async () => {
  const dir = new URL('../../permutation-server/web/frontier/wasm/', import.meta.url);
  const bytes = readFileSync(new URL('frontier-v3.wasm', dir));
  const published = readFileSync(new URL('frontier-v3.wasm.sha256', dir), 'utf8').trim().split(/\s+/)[0];
  k = await Wasm.loadKernel({ url: 'frontier-v3.wasm', sha256Hex: published, ruleset: RULESET,
    fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
});
const accepted = (from, route) => {
  const c = k.call('path_cost', { start: tileHex(from.p, from.q, from.tile), dirs: route.dirs, unit: 0, seeds: SEEDS });
  return c.ok && c.value;
};

test('the case of the test world: the kernel finds no route; the bounded search finds a legal one the kernel accepts', () => {
  assert.equal(k.call('plan_path', { start: tileHex(FROM.p, FROM.q, FROM.tile), dest: tileHex(KEEP.p, KEEP.q, KEEP.tile), unit: 0, blocked: [], seeds: SEEDS }).value, null, 'the kernel alone: none');
  const b = planBounded(k, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.ok(b.route.dirs.length <= BOUNDED_MAX_STEPS && b.route.provinces.length <= BOUNDED_MAX_PROVINCES);
  const c = accepted(FROM, b.route);
  const end = tileHex(KEEP.p, KEEP.q, KEEP.tile);
  assert.ok(c && c.end.q === end.q && c.end.r === end.r, "the kernel's path_cost accepts it and it ends on the keep tile");
  assert.equal(b.route.bounded, true);
  // and the page's planRoute now answers it (the fallback), with the same directions
  const r = planRoute(k, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS });
  assert.equal(r.ok, true); assert.deepEqual(r.route.dirs, b.route.dirs);
});

test('a route the kernel finds itself is returned unchanged (no fallback)', () => {
  // (a destination the kernel routes on its own, found in this terrain; asserted, never skipped)
  const kernelRoute = to => k.call('plan_path', { start: tileHex(FROM.p, FROM.q, FROM.tile), dest: tileHex(to.p, to.q, to.tile), unit: 0, blocked: [], seeds: SEEDS }).value;
  const near = [...Array(61).keys()].map(tile => ({ p: 1, q: 1, tile })).find(to => to.tile !== FROM.tile && kernelRoute(to));
  assert.ok(near, 'the kernel routes at least one tile of the home province');
  const kr = kernelRoute(near);
  const r = planRoute(k, { from: FROM, to: near, unit: 0, seeds: SEEDS });
  assert.equal(r.ok, true); assert.deepEqual(r.route.dirs, kr.dirs); assert.equal(r.route.bounded, undefined);
});

test('a spent budget is "not known", never "no route": planRoute says PlannerBudget and the keep list keeps it apart', async () => {
  const { reachableKeeps } = await import('../../permutation-server/web/frontier/fkeepreach.mjs');
  // a kernel whose planner finds none and whose bounded search runs out at once
  const tiny = { call: (name, a) => name === 'plan_path' ? { ok: true, value: null } : k.call(name, a) };
  const Bounded = await import('../../permutation-server/web/frontier/froute-bounded.mjs');
  assert.equal(Bounded.planBounded(tiny, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS }, { budget: 1 }).code, 'PlannerBudget');
  // (planRoute with the real budget finds it; the keep list over a real reachable keep and an impossible one)
  const keeps = [{ p: -2, q: 4, tile: 18, holder: 1, troops: 100 }, { p: -4, q: 4, tile: 0, holder: 1, troops: 100 }];
  const r = reachableKeeps({ kernel: k, keeps, origins: [{ ...FROM, unit: 0 }], seeds: SEEDS, faction: 0 });
  assert.deepEqual(r.rows.map(x => `${x.p},${x.q}`), ['-2,4'], 'the fort of the test world is listed');
  assert.deepEqual(r.unreachable, ['-4,4']); assert.deepEqual(r.undetermined, []);
  const src = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/fmarch.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(b\.code === 'PlannerBudget'\) return \{ ok: false, code: 'PlannerBudget' \};/);
  const kr = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/fkeepreach.mjs', import.meta.url), 'utf8');
  assert.match(kr, /else if \(budget\) undetermined\.push/);
});

test('load: the worst case the page can meet (every keep refused after a full search) stays bounded and is measured', () => {
  // an unreachable pair that the kernel refuses and the bounded search must exhaust within its budget
  const far = { p: -2, q: 4, tile: 0 };
  const t0 = performance.now();
  let worst = 0;
  for (let i = 0; i < 6; i++) {
    const s = performance.now();
    const r = planRoute(k, { from: FROM, to: { ...far, tile: (i * 7) % 61 }, unit: 0, seeds: SEEDS });
    worst = Math.max(worst, performance.now() - s);
    assert.ok(r.ok || ['NoPath', 'Path', 'PlannerBudget'].includes(r.code));
  }
  const total = performance.now() - t0;
  // (recorded, not a promise: one route was 11-17 ms on the test world; six keeps here took `total`)
  console.log(`six keeps: total ${total.toFixed(0)} ms, worst ${worst.toFixed(0)} ms (budget ${BOUNDED_STATE_BUDGET} states)`);
  assert.ok(worst < 5000, `one keep's search stays under 5 s on this machine (worst ${worst.toFixed(0)} ms)`);
});

test('every bounded answer over many pairs is one the kernel accepts, within 32 steps and 4 provinces', () => {
  let found = 0;
  for (const to of [{ p: -2, q: 4 }, { p: -1, q: 3 }, { p: 0, q: 3 }, { p: 0, q: 2 }, { p: -2, q: 3 }]) {
    for (let tile = 0; tile < 61; tile += 6) {
      const b = planBounded(k, { from: FROM, to: { ...to, tile }, unit: 0, seeds: SEEDS });
      if (!b.ok) { assert.ok(['NoPath', 'PlannerBudget'].includes(b.code), b.code); continue; }
      found++;
      const c = accepted(FROM, b.route);
      assert.ok(c, `${to.p},${to.q} tile ${tile}`);
      assert.ok(b.route.dirs.length <= BOUNDED_MAX_STEPS && c.provinces.length <= BOUNDED_MAX_PROVINCES);
    }
  }
  assert.ok(found > 5, `routes found: ${found}`);
});

test('no route is invented: impassable, blocked, too far, unknown ring, budget', () => {
  // an impassable destination tile (one the kernel's terrain marks so): none
  const g = k.call('generate_province', { ring_seed: Uint8Array.from(SEEDS[4].seed.match(/../g), x => parseInt(x, 16)), p: -2, q: 4 });
  const mask = BigInt(g.value.passableMask);
  const wall = [...Array(61).keys()].find(t => ((mask >> BigInt(t)) & 1n) === 0n);
  if (wall !== undefined) assert.equal(planBounded(k, { from: FROM, to: { p: -2, q: 4, tile: wall }, unit: 0, seeds: SEEDS }).code, 'NoPath');
  // a blocked destination: none
  const dest = tileHex(KEEP.p, KEEP.q, KEEP.tile);
  assert.equal(planBounded(k, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS, blocked: [dest] }).code, 'NoPath');
  // farther than 32 steps: none, without searching
  assert.equal(planBounded(k, { from: FROM, to: { p: -4, q: 4, tile: 0 }, unit: 0, seeds: SEEDS }).code, 'NoPath');
  // a ring without a seed: its terrain is unknown, so nothing passes through it
  assert.equal(planBounded(k, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS.filter(s => s.ring !== 4) }).code, 'NoPath');
  // the budget is explicit: a tiny one gives up, never a guess
  assert.equal(planBounded(k, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS }, { budget: 10 }).code, 'PlannerBudget');
  assert.equal(BOUNDED_STATE_BUDGET, 60000);
  // no kernel / bad tile
  assert.equal(planBounded(null, { from: FROM, to: KEEP }).code, 'NoKernel');
  assert.equal(planBounded(k, { from: FROM, to: { p: 0, q: 0, tile: 99 }, seeds: SEEDS }).code, 'BadTile');
});

test('a route the kernel would refuse is never offered (path_cost is the last word)', () => {
  const lying = { call: (name, a) => name === 'path_cost' ? { ok: false, reason: 'Impassable' } : k.call(name, a) };
  assert.equal(planBounded(lying, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS }).code, 'CostRefused');
  const elsewhere = { call: (name, a) => name === 'path_cost' ? { ok: true, value: { ...k.call(name, a).value, end: { q: 0, r: 0 } } } : k.call(name, a) };
  assert.equal(planBounded(elsewhere, { from: FROM, to: KEEP, unit: 0, seeds: SEEDS }).code, 'CostRefused', 'it must end on the destination');
});
