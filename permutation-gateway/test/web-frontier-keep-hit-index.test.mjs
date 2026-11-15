// The near-view keep hit test (map/keeps.mjs KeepBoard.at) through its bucket index (map/keepindex.mjs): the same
// answer as a scan of every keep row (KeepBoard.atScan), including which of two equally near keeps wins, at every
// zoom and tilt; at the legacy radius 128 (49,537 provinces) a hit test looks at a handful of rows, not all of
// them; a new reading, a removed province, a reset (another world) and a Map changed in place never leave a keep
// behind. Pure: explicit rows, no canvas, no records from outside, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeepBoard, KEEP_LOOK } from '../../permutation-server/web/frontier/map/keeps.mjs';
import { KeepHitIndex, keepHitBox, KEEP_INDEX_MAX_CELLS, KEEP_INDEX_SLACK } from '../../permutation-server/web/frontier/map/keepindex.mjs';
import { provinceFromIndex, provincesWithin, PROVINCE_TILES, R_MAX_HARD } from '../../permutation-server/web/frontier/fgeo.mjs';
import { RADIUS, FLATTEN } from '../../permutation-server/web/map.mjs';

const row = (p, q, tile, holder = 0) => ({ key: `${p},${q}`, p, q, tile, holder, troops: null, contender: null, held: 0, of: 72, heartland: false });
const rand = seed => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const worldRows = (rings, tileOf) => Array.from({ length: provincesWithin(rings) }, (_, i) => { const { p, q } = provinceFromIndex(i); return row(p, q, tileOf(p, q, i)); });
const boardOf = rows => { const b = new KeepBoard(); b.book.rows = new Map(rows.map(r => [r.key, r])); return b; };
const ZOOMS = [0.02, 0.05, 0.12, 0.3, 0.6, 1, 1.7, 3];
const RISES = [1, 1.08, 0.5, 2.2, 0];
const uAt = zoom => Math.max(RADIUS * KEEP_LOOK.unit, KEEP_LOOK.minPx / zoom);

test('indexed hit test equals the full scan across zooms, tilts and points round the keeps', () => {
  const r = rand(0x5eed);
  const rows = worldRows(7, () => Math.floor(r() * PROVINCE_TILES));
  const board = boardOf(rows);
  let hits = 0, indexed = 0, cases = 0;
  for (const zoom of ZOOMS) for (const rise of RISES) {
    const u = uAt(zoom);
    for (let n = 0; n < 60; n++) {
      const P = board.place(rows[Math.floor(r() * rows.length)], zoom);
      const pts = [
        [P.cx, P.cy], [P.x, P.y], [P.x, P.y - P.u],
        // the walls' and the tile's very edges, and just beyond them
        [P.x + P.u * 0.95, P.y - P.u * 0.4], [P.x - P.u * 0.95 - 1e-9, P.y], [P.x, P.y - P.u * 1.5 * rise], [P.x, P.y + P.u * 0.5],
        [P.x + RADIUS * 0.9, P.y], [P.x, P.y + RADIUS * 0.9 * FLATTEN],
        [P.x + (r() - 0.5) * 4 * u, P.y + (r() - 0.5) * 4 * u],
      ];
      for (const [wx, wy] of pts) {
        const want = board.atScan(wx, wy, zoom, rise), got = board.at(wx, wy, zoom, rise);
        assert.deepEqual(got, want, `zoom ${zoom} rise ${rise} at ${wx},${wy}`);
        cases += 1; if (want) hits += 1; if (!board.hits.last?.full) indexed += 1;
      }
    }
  }
  // (the comparison means something: many points hit a keep, and most were answered from the buckets)
  assert.ok(hits > cases / 3, `${hits} hits of ${cases}`);
  assert.ok(indexed > cases / 2, `${indexed} indexed of ${cases}`);
  // one build for the whole run: the rows Map did not change
  assert.equal(board.hits.builds, 1);
});

test('of two equally near keeps the first in the rows\' order wins, as in the full scan', () => {
  // (no two real keeps stand exactly level and close: the places are given, in integers, so the tie is exact. The
  // unit 50 is within the one the index's box is made for at zoom 1, as the board's own place always is)
  const a = row(1, 0, 30), b = row(2, 0, 30), at = new Map([[a.key, -30], [b.key, 30]]);
  const place = r => ({ x: at.get(r.key), y: 0, cx: at.get(r.key), cy: 0, u: 50, q: 0, r: 0 });
  assert.ok(50 <= uAt(1));
  for (const order of [[a, b], [b, a]]) {
    const two = boardOf(order);
    two.place = place;
    assert.deepEqual(two.at(0, -20, 1, 1), two.atScan(0, -20, 1, 1));
    assert.deepEqual(two.at(0, -20, 1, 1), { p: order[0].p, q: 0, tile: 30 });
    assert.equal(two.hits.last.candidates, 2);
  }
  // the same Map, the same row deleted and set again: the size and the row are the same, only the order (which breaks
  // the tie) changed. The index cannot see that, so the contract is rowsChanged; then it answers as the scan does
  const two = boardOf([a, b]);
  two.place = place;
  assert.deepEqual(two.at(0, -20, 1, 1), { p: 1, q: 0, tile: 30 });
  const builds = two.hits.builds;
  two.rows.delete(a.key); two.rows.set(a.key, a);
  assert.deepEqual([...two.rows.keys()], [b.key, a.key]);
  two.rowsChanged();
  assert.deepEqual(two.at(0, -20, 1, 1), two.atScan(0, -20, 1, 1));
  assert.deepEqual(two.at(0, -20, 1, 1), { p: 2, q: 0, tile: 30 });
  assert.equal(two.hits.builds, builds + 1);
});

test('radius 128: every province kept, a near hit test looks at a few rows only', () => {
  const rows = worldRows(R_MAX_HARD, () => 30);
  assert.equal(rows.length, 49537);
  const board = boardOf(rows);
  const probes = [[125, -40], [0, 0], [128, 0], [-128, 64], [0, -128], [64, 64]];
  for (const zoom of [0.6, 1, 2]) for (const [p, q] of probes) {
    const k = rows.find(x => x.p === p && x.q === q), P = board.place(k, zoom);
    for (const [wx, wy] of [[P.cx, P.cy], [P.x, P.y - P.u]]) {
      const got = board.at(wx, wy, zoom, 1.08);
      assert.deepEqual(got, { p, q, tile: 30 });
      const last = board.hits.last;
      assert.ok(!last.full, 'answered from the buckets');
      assert.ok(last.cells <= KEEP_INDEX_MAX_CELLS, `${last.cells} cells`);
      assert.ok(last.candidates >= 1 && last.candidates <= 8, `${last.candidates} candidate rows of ${rows.length}`);
      assert.deepEqual(got, board.atScan(wx, wy, zoom, 1.08));
    }
  }
  // a point far outside the world: nothing, from no candidate at all
  assert.equal(board.at(1e7, 1e7, 1, 1), null);
  assert.equal(board.hits.last.candidates, 0);
  assert.equal(board.hits.builds, 1);
  assert.equal(board.hits.entries, 49537);
});

test('a new reading, a removed province and a reset leave no keep behind', () => {
  const zoom = 1, rows = worldRows(3, () => 10), board = new KeepBoard();
  board.book.read({ rows, viewer: null });
  const gone = rows.find(x => x.p === 2 && x.q === -1), P = board.place(gone, zoom);
  assert.deepEqual(board.at(P.cx, P.cy, zoom), { p: 2, q: -1, tile: 10 });
  const builds = board.hits.builds;
  // the next reading names every province but that one
  board.book.read({ rows: rows.filter(x => x !== gone), viewer: null });
  assert.equal(board.at(P.cx, P.cy, zoom), null);
  assert.equal(board.hits.builds, builds + 1);
  // its keep comes back on another tile
  const moved = row(2, -1, 50);
  board.book.read({ rows: [...rows.filter(x => x !== gone), moved], viewer: null });
  const M = board.place(moved, zoom);
  assert.equal(board.at(P.cx, P.cy, zoom), board.atScan(P.cx, P.cy, zoom));
  assert.deepEqual(board.at(M.cx, M.cy, zoom), { p: 2, q: -1, tile: 50 });
  // another world (the board's reset, as a sample taken away does): no keep at all
  board.setSample(null);
  assert.equal(board.rows.size, 0);
  assert.equal(board.at(M.cx, M.cy, zoom), null);
  // a sample: its own keeps only
  const other = boardOf([]);
  other.book.rows = new Map([[moved.key, moved]]);
  assert.deepEqual(other.at(M.cx, M.cy, zoom), { p: 2, q: -1, tile: 50 });
});

test('a Map changed in place: a replaced or moved candidate is caught; a keep moved from afar needs rowsChanged', () => {
  const zoom = 1, rows = worldRows(3, () => 10), board = boardOf(rows), map = board.rows;
  const a = map.get('1,0'), A = board.place(a, zoom);
  assert.deepEqual(board.at(A.cx, A.cy, zoom), { p: 1, q: 0, tile: 10 });
  // the same key, another row (same size): seen as the candidate is no longer the Map's
  const a2 = row(1, 0, 40);
  map.set(a.key, a2);
  assert.deepEqual(board.at(A.cx, A.cy, zoom), board.atScan(A.cx, A.cy, zoom));
  const A2 = board.place(a2, zoom);
  assert.deepEqual(board.at(A2.cx, A2.cy, zoom), { p: 1, q: 0, tile: 40 });
  // a row's own tile changed: seen when the old place is asked
  const b = map.get('0,1'), B = board.place(b, zoom);
  board.at(B.cx, B.cy, zoom);
  b.tile = 55;
  assert.deepEqual(board.at(B.cx, B.cy, zoom), board.atScan(B.cx, B.cy, zoom));
  // moved again with nothing asked at its old place: the caller says so, and both places answer as the scan does
  const B2 = board.place(b, zoom);
  b.tile = 5;
  board.rowsChanged();
  const B3 = board.place(b, zoom);
  for (const [x, y] of [[B.cx, B.cy], [B2.cx, B2.cy], [B3.cx, B3.cy]]) assert.deepEqual(board.at(x, y, zoom), board.atScan(x, y, zoom));
  assert.deepEqual(board.at(B3.cx, B3.cy, zoom), { p: 0, q: 1, tile: 5 });
  // a row added in place (size changed): rebuilt
  const c = row(5, 0, 30); map.set(c.key, c);
  const C = board.place(c, zoom);
  assert.deepEqual(board.at(C.cx, C.cy, zoom), { p: 5, q: 0, tile: 30 });
  map.delete(c.key);
  assert.equal(board.at(C.cx, C.cy, zoom), board.atScan(C.cx, C.cy, zoom));
});

test('boundaries: odd numbers and wide boxes fall back to the full scan with the same answer', () => {
  const rows = worldRows(3, () => 20), board = boardOf(rows), P = board.place(rows[4], 1);
  for (const [zoom, rise] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1, NaN], [1, Infinity], [1, -1], [1e-6, 1]]) {
    assert.deepEqual(board.at(P.cx, P.cy, zoom, rise), board.atScan(P.cx, P.cy, zoom, rise), `zoom ${zoom} rise ${rise}`);
    assert.deepEqual(board.at(P.x, P.y - P.u, zoom, rise), board.atScan(P.x, P.y - P.u, zoom, rise), `zoom ${zoom} rise ${rise}`);
  }
  for (const [wx, wy] of [[NaN, 0], [0, Infinity]]) assert.deepEqual(board.at(wx, wy, 1, 1), board.atScan(wx, wy, 1, 1));
  // an empty board, and one whose keep has no place (a tile index the province does not have)
  assert.equal(boardOf([]).at(0, 0, 1, 1), null);
  const odd = boardOf([row(0, 0, PROVINCE_TILES + 3), rows[4]]);
  assert.deepEqual(odd.at(P.cx, P.cy, 1, 1), odd.atScan(P.cx, P.cy, 1, 1));
  assert.equal(odd.hits.entries, 1);
});

test('keepHitBox holds every hit the exact test can take, and nothing for odd numbers', () => {
  const u = 40, rise = 1.3, box = keepHitBox(100, 200, { u, rise, radius: RADIUS, flatten: FLATTEN });
  assert.ok(box.x0 <= 100 - u * 0.95 - KEEP_INDEX_SLACK + 1e-9 && box.x1 >= 100 + u * 0.95 + KEEP_INDEX_SLACK - 1e-9);
  assert.ok(box.x1 - 100 >= RADIUS * 0.9);
  // an anchor at y stands on its walls for wy in [y − 1.5 u rise, y + 0.5 u]: so y in [wy − 0.5 u, wy + 1.5 u rise]
  assert.ok(box.y0 <= 200 - 0.5 * u && box.y1 >= 200 + 1.5 * u * rise);
  assert.ok(box.y0 <= 200 - RADIUS * 0.9 * FLATTEN && box.y1 >= 200 + RADIUS * 0.9 * FLATTEN);
  for (const bad of [{ u: NaN, rise: 1 }, { u: 10, rise: Infinity }, { u: Infinity, rise: 1 }]) assert.equal(keepHitBox(0, 0, { ...bad, radius: RADIUS, flatten: FLATTEN }), null);
  assert.equal(keepHitBox(0, 0, { u: 10, rise: 1, radius: RADIUS, flatten: 0 }), null);
});

test('KeepHitIndex: order kept, duplicates kept, cells bounded, rebuilt on another Map or size', () => {
  const pts = new Map([['a', { x: 5, y: 5 }], ['b', { x: 5, y: 5 }], ['c', { x: 95, y: 5 }], ['d', { x: 15, y: 6 }], ['e', null], ['f', { x: NaN, y: 0 }]]);
  const rows = new Map([...pts.keys()].map(k => [k, { key: k }]));
  const ix = new KeepHitIndex({ cell: 10, anchor: r => pts.get(r.key), maxCells: 9 });
  const got = ix.query(rows, { x0: 0, x1: 20, y0: 0, y1: 9 });
  assert.deepEqual(got.map(e => e.row.key), ['a', 'b', 'd']);
  assert.equal(ix.entries, 4);
  assert.equal(ix.query(rows, { x0: 0, x1: 100, y0: 0, y1: 9 }), null);   // 11 cells > 9
  assert.deepEqual(ix.last, { full: true });
  assert.equal(ix.query(rows, null), null);
  const builds = ix.builds;
  ix.query(rows, { x0: 0, x1: 9, y0: 0, y1: 9 });
  assert.equal(ix.builds, builds);
  const fewer = new Map([...rows].filter(([k]) => k !== 'a'));
  assert.deepEqual(ix.query(fewer, { x0: 0, x1: 9, y0: 0, y1: 9 }).map(e => e.row.key), ['b']);
  assert.equal(ix.builds, builds + 1);
  rows.delete('b');
  assert.deepEqual(ix.query(rows, { x0: 0, x1: 9, y0: 0, y1: 9 }).map(e => e.row.key), ['a']);
  assert.throws(() => new KeepHitIndex({ cell: 0, anchor: () => null }));
  assert.throws(() => new KeepHitIndex({ cell: 10 }));
});
