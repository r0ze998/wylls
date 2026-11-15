// The original map's press on a keep (map/fmap.mjs FrontierMap.keepAt) through the keep board's bucket index
// (map/keepscreen.mjs, map/keepindex.mjs): the same keep as the old scan of every keep (keepAtScan, and a verbatim
// copy of the old loop below), including the first of two equally near, flat and at 26°, desktop and phone, fine and
// coarse pointers, presses at the picture's edges and beyond, a camera between two views, and the legacy radius
// 128; near presses test a few rows, not 49,537. The real prototype methods project / unproject / standAt run on a
// map made with Object.create (no constructor, DOM, canvas, assets, network, WASM, wallet or keys); its size, client
// rect and tilt are given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrontierMap, coarseChart } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { Camera } from '../../permutation-server/web/frontier/map/camera.mjs';
import { tiltGeo, TILT } from '../../permutation-server/web/frontier/map/tilt.mjs';
import { KeepBoard } from '../../permutation-server/web/frontier/map/keeps.mjs';
import { keepScreenRect, keepRowsNear, keepUnit, KEEP_SCREEN_SLACK } from '../../permutation-server/web/frontier/map/keepscreen.mjs';
import { provinceFromIndex, provincesWithin, PROVINCE_TILES, R_MAX_HARD } from '../../permutation-server/web/frontier/fgeo.mjs';
import { PROVINCE_CIRCUMRADIUS } from '../../permutation-server/web/frontier/map/layers.mjs';

const desktop = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };
const RECTS = [{ left: 0, top: 0 }, { left: 37, top: 112 }];
const row = (p, q, tile) => ({ key: `${p},${q}`, p, q, tile, holder: 0, troops: null, contender: null, held: 0, of: 72, heartland: false });
const rand = seed => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const worldRows = (rings, tileOf) => Array.from({ length: provincesWithin(rings) }, (_, i) => { const { p, q } = provinceFromIndex(i); return row(p, q, tileOf(p, q, i)); });
const boardOf = rows => { const b = new KeepBoard(); b.book.rows = new Map(rows.map(r => [r.key, r])); b.on = true; return b; };

/** A FrontierMap without its constructor: the real camera, projection and keepAt; the size, rect and tilt given. */
function mapOf({ size, rect, deg, board, view, drawn = view, persp = TILT.perspective }) {
  const m = Object.create(FrontierMap.prototype);
  m.size = () => size; m.rect = () => rect; m.persp = persp;
  m.geo = (zoom, s = size) => tiltGeo(s, deg, persp);
  m.keeps = board; m.chartKeeps = null;
  m.cam = new Camera({ view, reduced: () => true });
  m.cam.drawn = { ...drawn };
  return m;
}
/** The old keepAt outside the coarse chart, line for line (before the index). */
function legacyKeepAt(m, clientX, clientY, coarse) {
  if (!m.keeps.on || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const z = m.cam.drawn.zoom, min = coarse ? 22 : 12;
  let best = null, bd = Infinity;
  for (const row of m.keeps.rows.values()) {
    const P = m.keeps.place(row, z);
    if (!P) continue;
    const k = m.standAt(P.x, P.y)?.k ?? 1, at = m.project(P.x, P.y), s = P.u * z * k;
    const dx = clientX - at.x, dy = clientY - at.y, hw = Math.max(min, s * 0.95), up = Math.max(min * 2, s * 1.55), down = Math.max(min * 0.6, s * 0.6);
    if (Math.abs(dx) > hw || dy < -up || dy > down) continue;
    const d = Math.hypot(dx, dy + up * 0.3);
    if (d < bd) { bd = d; best = { p: row.p, q: row.q, tile: row.tile }; }
  }
  return best;
}
/** Run `fn` with the page's pointer reported fine or coarse (keepAt reads matchMedia('(pointer: coarse)')). */
function pointer(coarse, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'matchMedia'), old = globalThis.matchMedia;
  globalThis.matchMedia = q => ({ matches: q === '(pointer: coarse)' ? coarse : false });
  try { return fn(); } finally { if (had) globalThis.matchMedia = old; else delete globalThis.matchMedia; }
}
/** Presses round keeps (their centres, their boxes' very edges and beyond) and at the picture's edges and outside it. */
function presses(m, rows, r, n, coarse) {
  const z = m.cam.drawn.zoom, min = coarse ? 22 : 12, s = m.size(), R = m.rect(), out = [];
  for (let i = 0; i < n; i++) {
    const P = m.keeps.place(rows[Math.floor(r() * rows.length)], z);
    if (!P) continue;
    const at = m.project(P.x, P.y), k = m.standAt(P.x, P.y)?.k ?? 1, sc = P.u * z * k;
    const hw = Math.max(min, sc * 0.95), up = Math.max(min * 2, sc * 1.55), down = Math.max(min * 0.6, sc * 0.6);
    out.push([at.x, at.y], [at.x + hw, at.y - up], [at.x - hw, at.y + down], [at.x + hw + 1e-7, at.y], [at.x, at.y + down + 1e-7],
      [at.x + (r() * 2 - 1) * hw * 1.6, at.y + (r() * 2 - 1) * up * 1.4]);
  }
  out.push([R.left, R.top], [R.left + s.width, R.top + s.height], [R.left + s.width / 2, R.top], [R.left, R.top + s.height / 2],
    [R.left + s.width - 0.5, R.top + 0.5], [R.left - 30, R.top + s.height + 30], [R.left + s.width / 2, R.top - 200]);
  return out;
}

test('keepAt through the index equals the old scan: flat and 26°, desktop and phone, fine and coarse, edges, a moving camera', () => {
  const r = rand(0xa11ce);
  const rows = worldRows(12, () => Math.floor(r() * PROVINCE_TILES)), board = boardOf(rows);
  let cases = 0, hits = 0, indexed = 0;
  for (const size of [desktop, phone]) for (const rect of RECTS) for (const deg of [0, 26]) for (const coarse of [false, true])
    for (const zoom of [0.02, 0.05, 0.14, 0.4, 0.62, 1, 1.6, 2.2]) {
      const P = board.place(rows[Math.floor(r() * rows.length)], 1), view = { x: P.x, y: P.y, zoom };
      // (the picture on its way: drawn is not yet the logical view; keepAt reads the picture)
      const drawn = { x: P.x + (r() - 0.5) * 600, y: P.y + (r() - 0.5) * 400, zoom: zoom * (0.8 + 0.4 * r()) };
      if (coarseChart('world', drawn.zoom)) continue;
      const m = mapOf({ size, rect, deg, board, view, drawn });
      pointer(coarse, () => {
        for (const [x, y] of presses(m, rows, r, 8, coarse)) {
          const stats = {}, got = m.keepAt(x, y, { stats });
          assert.deepEqual(got, m.keepAtScan(x, y), `${size.width} deg ${deg} coarse ${coarse} zoom ${drawn.zoom} at ${x},${y}`);
          assert.deepEqual(got, legacyKeepAt(m, x, y, coarse));
          cases += 1; if (got) hits += 1; if (stats.full === false) indexed += 1;
        }
      });
    }
  assert.ok(cases > 3000, `${cases} cases`);
  assert.ok(hits > cases / 4, `${hits} hits of ${cases}`);
  // (the farthest zooms here may span more than 64 buckets and are scanned in full, as they must be)
  assert.ok(indexed > cases * 0.6, `${indexed} indexed of ${cases}`);
});

test('of two equally near keeps the first in the rows\' order wins, as before', () => {
  // (places given in integers on a flat board so that the tie is exact. A board whose `place` is replaced is a
  // transform the index cannot vouch for: keepAt scans as before, and the first wins there; the index's own order
  // for ties is web-frontier-keep-hit-index.test.mjs's)
  const a = row(1, 0, 30), b = row(2, 0, 30), xs = new Map([[a.key, 100], [b.key, 140]]);
  for (const order of [[a, b], [b, a]]) {
    const board = boardOf(order);
    board.place = (rw, z) => ({ x: xs.get(rw.key), y: 0, cx: xs.get(rw.key), cy: 0, u: keepUnit(z), q: 0, r: 0 });
    const m = mapOf({ size: desktop, rect: { left: 0, top: 0 }, deg: 0, board, view: { x: 120, y: 0, zoom: 1 } });
    pointer(false, () => {
      const x = desktop.width / 2, y = desktop.height / 2, stats = {};
      assert.deepEqual(m.keepAt(x, y, { stats }), { p: order[0].p, q: 0, tile: 30 });
      assert.equal(stats.full, 'board');
      assert.deepEqual(m.keepAt(x, y), legacyKeepAt(m, x, y, false));
    });
  }
  // the same two keys over real places in both orders: the index's candidates keep the rows' order
  const r = rand(11), rows = worldRows(5, () => Math.floor(r() * PROVINCE_TILES));
  for (const order of [rows, [...rows].reverse()]) {
    const board = boardOf(order), P = board.place(order[7], 1);
    const m = mapOf({ size: desktop, rect: RECTS[1], deg: 26, board, view: { x: P.x, y: P.y, zoom: 0.4 } });
    pointer(true, () => {
      for (const [x, y] of presses(m, order, r, 30, true)) { const stats = {}; assert.deepEqual(m.keepAt(x, y, { stats }), legacyKeepAt(m, x, y, true)); }
    });
  }
});

test('uncertain transforms scan every keep: replaced methods, missing geo / unproject, another tilt, a throwing geometry', () => {
  const r = rand(5), rows = worldRows(5, () => Math.floor(r() * PROVINCE_TILES)), board = boardOf(rows), P = board.place(rows[12], 1);
  const view = { x: P.x, y: P.y, zoom: 1 }, size = desktop, rect = RECTS[0];
  const check = (m, why, coarse = false) => pointer(coarse, () => {
    for (const [x, y] of [[size.width / 2, size.height / 2], [size.width / 2 + 30, size.height / 2 - 20], [5, 5]]) {
      const stats = {}, got = m.keepAt(x, y, { stats });
      assert.equal(stats.full, why);
      assert.deepEqual(got, legacyKeepAt(m, x, y, coarse));
    }
  });
  // the old minimal fixture: project and standAt alone (no geo, no unproject, no rect)
  const bare = Object.create(FrontierMap.prototype);
  Object.assign(bare, { keeps: board, chartKeeps: null, cam: new Camera({ view, reduced: () => true }),
    project: (x, y) => ({ x: (x - view.x) + size.width / 2, y: (y - view.y) + size.height / 2 }), standAt: () => null });
  check(bare, 'transform');
  // the prototype's project and unproject but standAt replaced (another row scale than the one the bound assumes)
  const scaled = mapOf({ size, rect, deg: 26, board, view });
  scaled.standAt = () => ({ k: 3, sh: 0, vs: 1 });
  check(scaled, 'transform');
  // geo answers another perspective than the map's: not the tilt the bound was proved for
  const other = mapOf({ size, rect, deg: 26, board, view });
  other.geo = (zoom, s = size) => tiltGeo(s, 26, 600);
  check(other, 'geo');
  // geo missing altogether (the prototype's project would need it): keepRowsNear itself refuses, it does not throw
  const noGeo = mapOf({ size, rect, deg: 26, board, view });
  noGeo.geo = undefined;
  assert.equal(keepRowsNear(noGeo, 700, 450, 1, 12, null, { exact: true }), null);
  { const stats = {}; keepRowsNear(noGeo, 700, 450, 1, 12, stats, { exact: true }); assert.equal(stats.full, 'map'); }
  const noUnproject = mapOf({ size, rect, deg: 26, board, view });
  noUnproject.unproject = null;
  { const stats = {}; assert.equal(keepRowsNear(noUnproject, 700, 450, 1, 12, stats, { exact: true }), null); assert.equal(stats.full, 'map'); }
  // a geometry that throws while candidates are worked out: null, never an exception out of the candidate step
  const throwing = mapOf({ size, rect, deg: 26, board, view });
  throwing.geo = () => { throw new Error('no geometry'); };
  { const stats = {}; assert.equal(keepRowsNear(throwing, 700, 450, 1, 12, stats, { exact: true }), null); assert.equal(stats.full, 'error'); }
  // and without keepAt's word that the methods are the prototype's
  { const stats = {}; assert.equal(keepRowsNear(mapOf({ size, rect, deg: 26, board, view }), 700, 450, 1, 12, stats), null); assert.equal(stats.full, 'transform'); }
});

test('radius 128: the same keep as the scan from a handful of candidate rows', t => {
  const rows = worldRows(R_MAX_HARD, () => 30), board = boardOf(rows);
  assert.equal(rows.length, 49537);
  let most = 0, n = 0;
  for (const size of [desktop, phone]) for (const deg of [0, 26]) for (const coarse of [false, true]) for (const [p, q] of [[125, -40], [0, 0], [-128, 64]]) for (const zoom of [0.62, 1.4]) {
    const k = board.rows.get(`${p},${q}`), P = board.place(k, zoom);
    const m = mapOf({ size, rect: RECTS[1], deg, board, view: { x: P.x + 40, y: P.y - 25, zoom } });
    pointer(coarse, () => {
      const at = m.project(P.x, P.y);
      for (const [x, y] of [[at.x, at.y], [at.x, at.y - 20], [at.x + 300, at.y + 200]]) {
        const stats = {}, got = m.keepAt(x, y, { stats });
        assert.deepEqual(got, m.keepAtScan(x, y));
        assert.equal(stats.full, false);
        assert.ok(stats.candidates <= 8, `${stats.candidates} candidates`);
        most = Math.max(most, stats.candidates); n += 1;
      }
      assert.deepEqual(m.keepAt(at.x, at.y), { p, q, tile: 30 });
    });
  }
  assert.equal(board.hits.builds, 1);
  t.diagnostic(`${n} presses on 49,537 keeps: at most ${most} candidate rows each`);
});

test('the coarse chart still tests only the marks it draws; uncertain cases scan everything with the same answer', () => {
  const r = rand(7), rows = worldRows(6, () => Math.floor(r() * PROVINCE_TILES)), board = boardOf(rows);
  // coarse chart: only chartKeeps' rows, and the index is not asked
  const zc = (8 / (2 * PROVINCE_CIRCUMRADIUS)) * 0.5, m0 = mapOf({ size: desktop, rect: RECTS[0], deg: 0, board, view: { x: 0, y: 0, zoom: zc } });
  assert.ok(coarseChart('world', zc));
  // (one drawn mark: at this zoom neighbouring provinces stand a few px apart, so every hidden keep is under the press)
  const shown = [rows[3]];
  m0.chartKeeps = { visible: () => shown };
  pointer(false, () => {
    for (const target of [rows[3], rows[0], rows[30]]) {
      const P = board.place(target, zc), at = m0.project(P.x, P.y), stats = {}, got = m0.keepAt(at.x, at.y, { stats });
      assert.ok(got === null || (got.p === rows[3].p && got.q === rows[3].q), 'only the drawn mark is taken');
      assert.deepEqual(stats, {}, 'the index is not asked on the coarse chart');
    }
    const P = board.place(rows[3], zc), at = m0.project(P.x, P.y);
    assert.deepEqual(m0.keepAt(at.x, at.y), { p: rows[3].p, q: rows[3].q, tile: rows[3].tile });
  });
  // a perspective it cannot be sure of, a press far above the horizon, a zoom that is not a plain number
  const P = board.place(rows[10], 1);
  for (const [opts, x, y, why] of [
    [{ persp: null }, null, null, 'tilt'],
    [{}, desktop.width / 2, -1e5, 'rect'],
  ]) {
    const m = mapOf({ size: desktop, rect: RECTS[0], deg: 26, board, view: { x: P.x, y: P.y, zoom: 1 }, ...opts });
    pointer(false, () => {
      const at = m.persp === null ? { x: 0, y: 0 } : m.project(P.x, P.y), px = x ?? at.x, py = y ?? at.y, stats = {};
      const got = m.keepAt(px, py, { stats });
      assert.equal(stats.full, why);
      if (m.persp !== null) assert.deepEqual(got, legacyKeepAt(m, px, py, false));
    });
  }
  const m = mapOf({ size: desktop, rect: RECTS[0], deg: 0, board, view: { x: P.x, y: P.y, zoom: 1 } });
  m.cam.drawn = { ...m.cam.drawn, zoom: NaN };
  pointer(false, () => { const stats = {}; assert.deepEqual(m.keepAt(700, 450, { stats }), legacyKeepAt(m, 700, 450, false)); assert.equal(stats.full, 'numbers'); });
  // a row that has no place, and a press that is not a number
  const odd = boardOf([row(0, 0, PROVINCE_TILES + 2), rows[10]]), mo = mapOf({ size: phone, rect: RECTS[1], deg: 26, board: odd, view: { x: P.x, y: P.y, zoom: 1 } });
  pointer(true, () => {
    const at = mo.project(P.x, P.y);
    assert.deepEqual(mo.keepAt(at.x, at.y), legacyKeepAt(mo, at.x, at.y, true));
    assert.equal(mo.keepAt(NaN, 3), null);
  });
});

test('keepScreenRect: the bound holds every keep the old test can take, and refuses what it cannot bound', () => {
  // flat: the rectangle is the press widened by the largest box
  const flat = keepScreenRect({ x: 100, y: 200, min: 12, uz: 40, tilt: null });
  assert.equal(flat.kMax, 1);
  assert.ok(flat.x0 <= 100 - Math.max(12, 38) - KEEP_SCREEN_SLACK + 1e-9 && flat.y1 >= 200 + Math.max(24, 62) && flat.y0 <= 200 - Math.max(7.2, 24));
  // tilted: every keep whose row scale k satisfies the old test lies inside, by brute force along the column
  const t = Math.tan(26 * Math.PI / 180) / TILT.perspective, c = 450;
  for (const [y, min, uz] of [[450, 12, 57], [0, 22, 126], [900, 12, 24], [-300, 22, 80], [1600, 12, 126]]) {
    const R = keepScreenRect({ x: 0, y, min, uz, tilt: { t, c } });
    assert.ok(R, `rect for ${y}`);
    for (let ay = c - 1 / t + 0.5; ay < c + 6000; ay += 3) {
      const k = 1 + (ay - c) * t, s = uz * k, up = Math.max(2 * min, 1.55 * s), down = Math.max(0.6 * min, 0.6 * s), hw = Math.max(min, 0.95 * s);
      const dy = y - ay;
      if (dy > down || dy < -up) continue;   // (the old test: dy = y − at.y within [−up, down])
      assert.ok(ay >= R.y0 && ay <= R.y1 && k <= R.kMax && hw <= -R.x0, `keep at ${ay} (k ${k}) for press ${y}`);
    }
  }
  assert.equal(keepScreenRect({ x: 0, y: 0, min: 12, uz: 1e6, tilt: { t, c } }), null);   // 1.55 u z t ≥ 1: no bound
  assert.equal(keepScreenRect({ x: 0, y: c - 1 / t, min: 12, uz: 50, tilt: { t, c } }), null);   // at the horizon
  assert.equal(keepScreenRect({ x: NaN, y: 0, min: 12, uz: 50, tilt: null }), null);
  assert.equal(keepScreenRect({ x: 0, y: 0, min: 12, uz: 50, tilt: { t: 0, c } }), null);
  assert.equal(keepRowsNear({ keeps: null }, 0, 0, 1, 12), null);
});
