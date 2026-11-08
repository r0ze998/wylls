import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLayout, localTilePoint, phaseMarker } from '../screens/wide-march-local/local-map.mjs';
import { originAt } from '../../permutation-server/web/frontier/map/wide.mjs';
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
