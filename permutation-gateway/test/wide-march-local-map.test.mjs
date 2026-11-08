import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLayout, localTilePoint, phaseMarker, marchRoute, boundDestination, viewLayout, cameraAt, panCamera, resizeCamera, jumpCamera, VIEW_RADIUS_MAX, VIEW_PROVINCES_MAX, PAN_STEPS } from '../screens/wide-march-local/local-map.mjs';
import { walkDirections, provincesEntered, tileOf, tileAt, TILE_COORD_BOUND } from '../screens/wide-march-local/local-route.mjs';
import { originAt, WIDE_BOUND } from '../../permutation-server/web/frontier/map/wide.mjs';
import { locate, tileHex, TILE_OFFSETS } from '../../permutation-server/web/frontier/fgeo.mjs';

test('route re-walk reproduces the host walks observed in v3 (recorded 222, and 12 × direction 2 into (129,-2) tile 60)', () => {
  // v3 real host: the recorded route is (129,0)#2 → #1 → #0 → (129,-1)#34, the quote of "222" ending at tile 34
  const rec = walkDirections({ p: '129', q: '0', tile: 2 }, '222');
  assert.equal(rec.offWorld, null);
  assert.deepEqual(rec.steps, [{ p: '129', q: '0', tile: 1 }, { p: '129', q: '0', tile: 0 }, { p: '129', q: '-1', tile: 34 }]);
  assert.deepEqual(provincesEntered(rec.steps), [{ p: '129', q: '0' }, { p: '129', q: '-1' }], 'the start province counts once a step stands in it');
  // v3 Chrome smoke: a 12-step direction-2 quote was reachable into (129,-2), tile 60
  const long = walkDirections({ p: '129', q: '0', tile: 2 }, '2'.repeat(12));
  assert.deepEqual(long.steps.at(-1), { p: '129', q: '-2', tile: 60 });
  assert.ok(long.steps.every(s => s.p === '129' && ['0', '-1', '-2'].includes(s.q)));
  for (const d of ['', '6', '2'.repeat(33), 2]) assert.throws(() => walkDirections({ p: '129', q: '0', tile: 2 }, d));
});
test('route geometry agrees with the production fgeo tables wherever Number is exact, and stays exact in BigInt beyond', () => {
  for (const [p, q] of [[0, 0], [129, 0], [129, -1], [-7, 3], [1000, -999]]) for (const local of [0, 1, 30, 59, 60]) {
    const t = tileOf(BigInt(p), BigInt(q), local), h = tileHex(p, q, local);
    assert.deepEqual([Number(t.q), Number(t.r)], [h.q, h.r]);
    const back = tileAt(t.q, t.r), l = locate(h.q, h.r);
    assert.deepEqual([Number(back.p), Number(back.pq), back.local], [l.p, l.q, l.idx]);
  }
  // every neighbour of every tile of (129,0) is a tile one step away, in this province or the next
  for (let local = 0; local < TILE_OFFSETS.length; local++) for (const d of '012345') {
    const w = walkDirections({ p: '129', q: '0', tile: local }, d);
    assert.equal(w.steps.length, 1);
  }
  // the world has an edge: past ±2^62 there is no tile, never a wrapped one
  const edge = WIDE_BOUND.toString();
  const off = walkDirections({ p: edge, q: edge, tile: 60 }, '0');
  assert.ok(off.offWorld === 0 || off.steps.every(s => BigInt(s.p) <= WIDE_BOUND && BigInt(s.q) <= WIDE_BOUND));
  assert.equal(tileAt(TILE_COORD_BOUND + 1n, 0n), null);
  const far = walkDirections({ p: '9007199254740993', q: '0', tile: 30 }, '000');
  assert.ok(far.steps.every(s => /^900719925474099[0-9]$/.test(s.p)), 'no precision is lost');
});
test('a chosen march draws its own host-walked route and marks its bound destination; otherwise the recorded fixture route', () => {
  const s = { map: { origin: { p: '129', q: '0' }, destination: { p: '129', q: '-1' }, route: [{ p: '129', q: '0', tile: 2 }, { p: '129', q: '-1', tile: 34 }] }, host: { originTile: 2, destinationTile: 34 }, holding: { tile: 3 }, marchBinding: null };
  assert.deepEqual(marchRoute(s), s.map.route);
  assert.deepEqual(boundDestination(s), { p: '129', q: '-1', tile: 34 });
  const chosen = { ...s, marchBinding: { kind: 'chosen', destination: { p: '129', q: '-2', tile: 60, accountKeyHex: 'x', source: 'opened' }, steps: [{ p: '129', q: '0', tile: 1 }, { p: '129', q: '-2', tile: 60 }] } };
  assert.deepEqual(marchRoute(chosen), [{ p: '129', q: '0', tile: 2 }, { p: '129', q: '0', tile: 1 }, { p: '129', q: '-2', tile: 60 }]);
  assert.deepEqual(phaseMarker({ ...chosen, phase: 'resolved' }).place, { p: '129', q: '-2', tile: 60 });
  assert.deepEqual(phaseMarker({ ...chosen, phase: 'settled' }).place, { p: '129', q: '-2', tile: 60 });
  assert.equal(phaseMarker({ ...chosen, phase: 'revealed' }).place, null, 'reveal never implies arrival');
  assert.deepEqual(phaseMarker({ ...chosen, phase: 'returned' }).place, { p: '129', q: '0', tile: 3 });
  const recorded = { ...s, marchBinding: { kind: 'recorded', destination: { p: '129', q: '-1', tile: 34 }, steps: [] } };
  assert.deepEqual(marchRoute(recorded), s.map.route);
});
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
  assert.deepEqual(v.counts, { known: 2, opened: 0, unknown: 5, outside: 0 });
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

test('opened provinces are drawn from their returned mask, and only unknown ring-129 cells are openable', () => {
  const withOpened = [...known, { p: '129', q: '-2', passableMask: '1', source: 'opened' }];
  // Centred on the opened (129,-2): its ring-129 neighbours are (129,-1) (a fixture) and (129,-3) (unknown); the
  // other four are rings 128 and 130. (Centred on (129,-1), both ring-129 neighbours are host provinces, so
  // nothing there is openable.)
  const v = viewLayout({ camera: cameraAt('129', '-2', 1), provinces: withOpened, route });
  assert.equal(v.counts.opened, 1);
  const opened = v.cells.find(c => c.key === '129,-2');
  assert.equal(opened.state, 'opened');
  assert.deepEqual(opened.tiles.slice(0, 2).map(t => t.passable), [true, false], 'the opened province\'s own mask');
  // every openable cell is unknown and on ring 129; host provinces and other rings are never offered
  for (const c of v.cells) {
    const ring = (BigInt(c.p) < 0n ? -BigInt(c.p) : BigInt(c.p)) + (BigInt(c.q) < 0n ? -BigInt(c.q) : BigInt(c.q)) + ((BigInt(c.p) + BigInt(c.q)) < 0n ? -(BigInt(c.p) + BigInt(c.q)) : BigInt(c.p) + BigInt(c.q));
    assert.equal(c.openable, c.state === 'unknown' && ring / 2n === 129n, c.key);
  }
  assert.deepEqual(v.openable.map(o => `${o.p},${o.q}`), ['129,-3']);
  assert.deepEqual(viewLayout({ camera: cameraAt('129', '-1', 1), provinces: withOpened, route }).openable, []);
  // far from ring 129 nothing is openable, and up to six host provinces are accepted, seven are not
  assert.equal(viewLayout({ camera: cameraAt('1000', '0', 1), provinces: known }).openable.length, 0);
  const six = [...known, ...['-2', '-3'].map(q => ({ p: '129', q, source: 'opened' })), { p: '128', q: '1', source: 'opened' }, { p: '127', q: '2', source: 'opened' }];
  // the full input of six (2 fixtures + 4 opened) is accepted; counts are only what the radius-2 camera shows:
  // (129,-3) is three provinces from (129,0), so 3 of the 4 opened provinces are visible
  const sixView = viewLayout({ camera: cameraAt('129', '0', 2), provinces: six });
  assert.equal(six.length, 6);
  assert.equal(sixView.counts.known, 2);
  assert.equal(sixView.counts.opened, 3);
  assert.ok(!sixView.cells.some(c => c.key === '129,-3'), 'outside the radius-2 view');
  // a seventh host province is refused whether or not it would be visible
  assert.throws(() => viewLayout({ camera: cameraAt('129', '0', 2), provinces: [...six, { p: '126', q: '3', source: 'opened' }] }));
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
