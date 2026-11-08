import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLayout, localTilePoint, phaseMarker, viewLayout, cameraAt, panCamera, resizeCamera, jumpCamera, VIEW_RADIUS_MAX, VIEW_PROVINCES_MAX, PAN_STEPS } from '../screens/wide-march-local/local-map.mjs';
import { originAt, WIDE_BOUND } from '../../permutation-server/web/frontier/map/wide.mjs';
test('actual coordinates retain precision beyond Number safe integers', () => {
  const p = '9007199254740993';
  const a = localTilePoint(originAt(p, '0'), { p, q: '0', tile: 30 });
  const b = localTilePoint(originAt('0', '0'), { p: '0', q: '0', tile: 30 });
  assert.equal(a.x, b.x); assert.equal(a.y, b.y); assert.match(a.label, /9007199254740993/);
});
test('two relative provinces have 122 tiles and exact supplied route', () => {
  const m = mapLayout({ origin: { p: '9007199254740993', q: '0' }, provinces: [{ p: '9007199254740993', q: '0' }, { p: '9007199254740994', q: '0' }], route: [{ p: '9007199254740993', q: '0', tile: 30 }, { p: '9007199254740994', q: '0', tile: 30 }] });
  assert.equal(m.tiles.length, 122); assert.equal(m.path.length, 2); assert.ok(m.bounds.every(Number.isFinite));
});
test('invalid or absent coordinates never become fabricated terrain', () => {
  const origin = originAt('0', '0');
  for (const place of [{ p: '01', q: '0', tile: 0 }, { p: '0', q: '0', tile: 61 }, { p: '2147483648', q: '0', tile: 0 }]) assert.throws(() => localTilePoint(origin, place));
  assert.throws(() => mapLayout({ origin: { p: '0', q: '0' }, provinces: [{ p: '0', q: '0' }], route: [{ p: '1', q: '0', tile: 0 }] }));
});

test('reveal does not imply arrival and returned troops are reserves, not a remustered host',()=>{
 const s={map:{origin:{p:'129',q:'0'},destination:{p:'129',q:'-1'}},host:{originTile:1,destinationTile:2},holding:{tile:3}};
 assert.equal(phaseMarker({...s,phase:'travelling'}).place,null);
 assert.equal(phaseMarker({...s,phase:'revealed'}).place,null);
 assert.deepEqual(phaseMarker({...s,phase:'resolved'}).place,{p:'129',q:'-1',tile:2});
 assert.deepEqual(phaseMarker({...s,phase:'returned'}).place,{p:'129',q:'0',tile:3});
});

const known = [{ p: '129', q: '0', passableMask: '3' }, { p: '129', q: '-1', passableMask: '0' }];
const route = [{ p: '129', q: '0', tile: 2 }, { p: '129', q: '0', tile: 1 }, { p: '129', q: '0', tile: 0 }, { p: '129', q: '-1', tile: 34 }];

test('the camera view is bounded: at most 19 provinces and 1,159 hexes', () => {
  assert.equal(VIEW_PROVINCES_MAX, 19);
  for (const [r, n] of [[0, 1], [1, 7], [2, 19]]) {
    const v = viewLayout({ camera: cameraAt('129', '0', r), provinces: known, route });
    assert.equal(v.cells.length, n);
    assert.equal(v.cells.reduce((s, c) => s + c.tiles.length, 0), n * 61);
    assert.ok(v.bounds.every(Number.isFinite));
  }
  for (const r of [-1, 3, 1.5, '1']) assert.throws(() => cameraAt('0', '0', r));
  assert.throws(() => resizeCamera(cameraAt('0', '0', VIEW_RADIUS_MAX), VIEW_RADIUS_MAX + 1));
});

test('unknown land is labelled unknown: only host-returned provinces are known, nothing is generated', () => {
  const v = viewLayout({ camera: cameraAt('129', '0', 1), provinces: known, route, marker: { place: { p: '129', q: '0', tile: 2 }, text: 'x' } });
  assert.deepEqual(v.counts, { known: 2, unknown: 5, outside: 0 });
  const unknown = v.cells.filter(c => c.state === 'unknown');
  assert.ok(unknown.every(c => c.tiles.every(t => t.passable === null)), 'no terrain is invented for unknown land');
  const origin = v.cells.find(c => c.key === '129,0');
  assert.deepEqual(origin.tiles.slice(0, 3).map(t => t.passable), [true, true, false], 'known passability is the host mask');
  assert.equal(v.path.length, 4); assert.ok(v.pathComplete); assert.ok(v.markerPoint);
  // a province the host did not return is not a legal route point
  assert.throws(() => viewLayout({ camera: cameraAt('129', '0', 1), provinces: known, route: [{ p: '130', q: '0', tile: 0 }] }));
});

test('panning far away keeps exact BigInt coordinates and reports the route as off camera', () => {
  let cam = cameraAt('129', '0', 1);
  for (let i = 0; i < 3; i++) cam = panCamera(cam, 0, 1000000000n);
  assert.equal(cam.centre.p, 3000000129n); assert.equal(cam.centre.q, 0n);
  const v = viewLayout({ camera: cam, provinces: known, route, marker: { place: { p: '129', q: '0', tile: 2 }, text: 'x' } });
  assert.equal(v.counts.known, 0); assert.equal(v.path.length, 0); assert.equal(v.offRoute, 4); assert.equal(v.markerOffCamera, true);
  assert.ok(v.cells.some(c => c.p === '3000000130' && c.q === '-1'));
  // and back exactly
  for (let i = 0; i < 3; i++) cam = panCamera(cam, 3, 1000000000n);
  assert.equal(cam.centre.p, 129n);
  assert.throws(() => panCamera(cam, 6, 1n)); assert.throws(() => panCamera(cam, 0, 7n)); assert.throws(() => panCamera(cam, 0, 1));
  assert.deepEqual([...PAN_STEPS], [1n, 1000n, 1000000000n]);
});

test('the coordinate bound is ±2^62, not infinity: no pan past it, cells beyond it are outside', () => {
  const edge = WIDE_BOUND.toString();
  const cam = cameraAt(edge, '0', 1);
  assert.equal(panCamera(cam, 0, 1n), null, 'P+1 past 2^62');
  assert.ok(panCamera(cam, 3, 1n), 'P-1 is inside');
  const v = viewLayout({ camera: cam, provinces: known });
  assert.ok(v.counts.outside >= 2);
  for (const c of v.cells.filter(c => c.state === 'outside')) assert.ok(BigInt(c.p) > WIDE_BOUND || BigInt(c.q) > WIDE_BOUND || BigInt(c.q) < -WIDE_BOUND);
  assert.ok(v.cells.every(c => c.state !== 'known'));
  assert.ok(v.cells.some(c => c.p === '4611686018427387904' && c.state === 'unknown'), 'exact text of 2^62');
  const neg = cameraAt(`-${edge}`, edge, 0);
  assert.equal(panCamera(neg, 5, 1n), null, 'Q+1 past 2^62');
});

test('view-only jumps accept canonical decimals within the bound and refuse everything else', () => {
  assert.equal(jumpCamera('-4611686018427387904', '4611686018427387904', 2).centre.p, -(1n << 62n));
  for (const [p, q] of [['1e3', '0'], ['01', '0'], ['4611686018427387905', '0'], [' 1', '0'], ['', '0'], ['-0', '0'], ['0x10', '0'], ['1.0', '0']]) assert.throws(() => jumpCamera(p, q), `${p},${q}`);
});

test('map source uses BigInt camera math and never converts a global coordinate to Number', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(resolve(here, '../screens/wide-march-local/local-map.mjs'), 'utf8');
  for (const bad of ['Number(p', 'Number(q', 'Number(P', 'Number(Q', 'parseInt(', 'parseFloat(', 'Number(camera', 'Number(c.p', 'fetch(', 'XMLHttpRequest', 'submit(']) assert.ok(!src.includes(bad), bad);
});
