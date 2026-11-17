// Public geometry only. The camera import closure was audited with the original
// page (CODEX-LOCAL-BROWSER-AUDIT-20261108.md); no renderer or herald is invoked.
import { keyCalls } from '../screens/codex/no-key-node.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { landBox as shippedLandBox } from '../../permutation-server/web/frontier/map/camera.mjs';
import { tileHex as shippedTileHex, ringProvinces as shippedRingProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { project as shippedProject } from '../../permutation-server/web/map.mjs';

const source = readFileSync(new URL('../../permutation-server/web/frontier/map/camera.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function landBox('), source.indexOf('/** The far view shows'));
assert.ok(body.startsWith('export function landBox('));
assert.ok(!/\bimport\b/.test(body));
const RADIUS = 44, FLATTEN = 0.76;
const offsets = [];
for (let q = -4; q <= 4; q++) for (let r = Math.max(-4, -q - 4); r <= Math.min(4, -q + 4); r++) offsets.push({ q, r });
const tileHex = (p, q, i) => ({ q: 9 * p + 4 * q + offsets[i].q, r: -4 * p + 5 * q + offsets[i].r });
const project = (q, r) => ({ x: Math.sqrt(3) * RADIUS * (q + r / 2), y: RADIUS * 1.5 * r * FLATTEN });
// Independent axial enumeration; order does not affect a maximum.
function ringProvinces(d) {
  const out = [];
  for (let p = -d; p <= d; p++) for (let q = -d; q <= d; q++) {
    if (Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q)) === d) out.push({ p, q });
  }
  return out;
}
function subject() {
  let calls = 0;
  const landBox = runInNewContext(`const boxes = new Map(); ${body.replace('export function', 'function')} landBox;`, {
    RADIUS, FLATTEN, PROVINCE_TILES: offsets.length, tileHex, ringProvinces,
    project: (q, r) => { calls++; return project(q, r); },
  });
  return { landBox, count: () => calls };
}

test('exact legacy bounds at every supported opened-ring count; constant projection cost', t => {
  const { landBox, count } = subject();
  let x = 0, y = 0, legacyCount = 0;
  // Incrementally accumulate the exhaustive old algorithm, not the new hull.
  for (let ring = 0; ring <= 128; ring++) {
    for (const pr of shippedRingProvinces(ring)) for (let i = 0; i < offsets.length; i++) {
      const h = shippedTileHex(pr.p, pr.q, i), c = shippedProject(h.q, h.r);
      x = Math.max(x, Math.abs(c.x)); y = Math.max(y, Math.abs(c.y)); legacyCount++;
    }
    const before = count(), actual = landBox(ring + 1);
    assert.equal(actual.x, x + RADIUS * Math.sqrt(3) / 2, `x, ring ${ring}`);
    assert.equal(actual.y, y + RADIUS * FLATTEN, `y, ring ${ring}`);
    const shipped = shippedLandBox(ring + 1);
    assert.equal(shipped.x, actual.x, 'actual imported camera x');
    assert.equal(shipped.y, actual.y, 'actual imported camera y');
    assert.equal(count() - before, ring === 0 ? 61 : 366);
    assert.ok(Object.isFrozen(actual));
    assert.equal(landBox(ring + 1), actual, 'cached object identity');
    assert.equal(count() - before, ring === 0 ? 61 : 366, 'cache adds no projections');
  }
  assert.equal(legacyCount, 3_021_757);
  t.diagnostic('129 exact bounds comparisons; radius128: legacy 3,021,757 projections, optimized 366; cached 0');
  assert.deepEqual(keyCalls, []);
});

test('default, zero and negative rings retain the central province; cache eviction retains values', () => {
  const landBox = shippedLandBox;
  const one = landBox(1);
  for (const value of [undefined, null, 0, -1, -128]) assert.equal(landBox(value), one);
  for (let d = 2; d <= 20; d++) landBox(d);
  const again = landBox(1);
  assert.equal(again.x, one.x); assert.equal(again.y, one.y);
  assert.notEqual(again, one);
  assert.deepEqual(keyCalls, []);
});
