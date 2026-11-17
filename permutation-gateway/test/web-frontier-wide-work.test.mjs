// The work of one picture of a very wide world is bounded by the screen, not by the world's area: the cloud sea,
// the paper sheet and the minimap, for 129 rings (full) and for a world that seeds ring 128 alone.
// Counts of work against a stub canvas: no browser, no keys, no timing thresholds.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const count = { canvases: 0, images: 0, draws: 0, hexes: 0 };
const reset = () => { for (const k of Object.keys(count)) count[k] = 0; };
const g2d = () => new Proxy(g2dBase(), { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[a-z]/.test(k) && !['then', 'canvas'].includes(k) ? () => {} : undefined), set: (t, k, v) => { t[k] = v; return true; } });
const g2dBase = () => ({ canvas: null, createImageData: (w, h) => { count.images++; return { data: new Uint8ClampedArray(w * h * 4) }; }, putImageData() {}, drawImage() { count.draws++; },
  save() {}, restore() {}, beginPath() {}, closePath() { count.hexes++; }, moveTo() {}, lineTo() {}, arc() {}, rect() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {},
  getTransform: () => null, setTransform() {}, translate() {}, scale() {}, createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }), createPattern: () => ({ setTransform() {} }) });
globalThis.Path2D = class { constructor() { this.points = 0; } moveTo() { this.points++; } lineTo() { this.points++; } closePath() {} };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; count.canvases++; } getContext() { return g2d(); } };

const web = '../../permutation-server/web/frontier/';
const cam = await import(`${web}map/camera.mjs`);
const sea = await import(`${web}map/cloudsea.mjs`);
const { sheetOf } = await import(`${web}map/table.mjs`);
const chart = await import(`${web}map/chart.mjs`);
const minimap = await import(`${web}hud/minimap.mjs`);
const { tileHex } = await import(`${web}fgeo.mjs`);

const SIZE = { width: 1440, height: 900 };
const fit = rings => { const view = cam.fitView(rings, SIZE, {}), hw = SIZE.width / view.zoom / 2, hh = SIZE.height / view.zoom / 2; return { view, box: { x0: -hw, y0: -hh, x1: hw, y1: hh } }; };

test('the sea\'s finenesses: SEA_STEPS as they were, and far steps below them that keep a picture to a few pieces', () => {
  assert.deepEqual([...sea.SEA_STEPS], [0.125, 0.18, 0.25, 0.36, 0.5, 0.71, 1]);
  assert.equal(sea.seaRes(0.01), 0.125, 'seaRes itself is unchanged');
  for (const z of [1.5, 0.57, 0.2, 0.13, 0.125]) assert.equal(sea.seaResFar(z), sea.seaRes(z), `zoom ${z}: the same step as ever`);
  assert.equal(sea.seaResFar(0.05), 0.0625); assert.equal(sea.seaResFar(0.0054), 0.0078); assert.equal(sea.seaResFar(0.0001), sea.SEA_FAR_STEPS[0]);
  // pieces a 1440 × 900 picture needs, at every zoom down to the fit of 129 rings
  for (const z of [1, 0.3, 0.125, 0.06, 0.02, 0.0054]) {
    const side = sea.PIECE / sea.seaResFar(z), n = Math.ceil(SIZE.width / z / side + 1) * Math.ceil(SIZE.height / z / side + 1);
    assert.ok(n <= 40, `zoom ${z}: ${n} pieces`);
  }
});

for (const [label, rings, seeded] of [['129 full rings', 129, null], ['ring 128 alone', 129, [128]]]) {
  test(`the cloud sea at the fit view of ${label}: a few pieces, none worked out by a picture that only asks, done in a few frames`, () => {
    const { view, box } = fit(rings), sheet = sheetOf(rings), name = sea.seaExtent(rings, seeded);
    const s = new sea.CloudSea({ image: () => null }), res = sea.seaResFar(view.zoom);
    reset();
    const ask = s.paint(g2d(), { box, res, ringsOpen: name, sheet, part: 'still', budget: -1 });
    assert.ok(ask.pending > 0 && ask.pending <= 40, `${ask.pending} pieces in the picture (1,360 at the old coarsest step)`);
    assert.deepEqual([count.canvases, count.images, ask.rough, s.pieces.size, s.roughs.size], [0, 0, 0, 0, 0], 'asking makes nothing: no piece, no stand-in body');
    // (with the drift too: nothing is made for it either)
    const askAll = s.paint(g2d(), { box, res, ringsOpen: name, sheet, part: null, budget: -1 });
    assert.deepEqual([count.canvases, count.images, askAll.rough], [0, 0, 0], 'asking for the drift makes no texture');
    let frames = 0, last = ask;
    while (last.pending > 0 && frames < 12) { last = s.paint(g2d(), { box, res, ringsOpen: name, sheet, part: 'still' }); frames++; assert.ok(last.rough <= 40); }
    assert.equal(last.pending, 0, 'the picture is whole'); assert.ok(frames <= Math.ceil(ask.pending / sea.SEA_BAKES) + 1, `${frames} frames`);
    assert.ok(s.pieces.size <= 40 && s.pixels <= sea.SEA_PIXELS_MAX, 'every piece of the picture is kept: none is made twice');
    reset();
    s.paint(g2d(), { box, res, ringsOpen: name, sheet, part: 'still' });
    assert.deepEqual([count.canvases, count.images], [0, 0], 'the next frame makes nothing');
  });
}

test('the sea of a sparse world: its unseeded inner rings are under cloud, its seeded ring is land, and its name says all of it', () => {
  const home = tileHex(128, 0, 0), centre = tileHex(0, 0, 0), mid = tileHex(64, 0, 0);
  const full = sea.seaField(sea.seaExtent(129, null)), only = sea.seaField(sea.seaExtent(129, [128]));
  assert.equal(sea.seaExtent(129, null), 129); assert.equal(sea.seaExtent(129, [128]), '129|128'); assert.equal(sea.seaExtent(129, []), '129|');
  assert.equal(full.steps(centre.q, centre.r), 0); assert.equal(full.steps(mid.q, mid.r), 0); assert.equal(full.steps(home.q, home.r), 0);
  assert.equal(only.steps(home.q, home.r), 0, 'ring 128 is land');
  assert.equal(only.steps(centre.q, centre.r), 8, 'the centre does not exist: deep sea'); assert.equal(only.steps(mid.q, mid.r), 8);
  assert.notEqual(full, only); assert.equal(sea.seaField('129|128'), only, 'one field a name');
  // many other worlds come and go (the kept fields are dropped): the sparse name still reads as sparse
  for (let d = 2; d < 20; d++) sea.seaField(d);
  const again = sea.seaField(sea.seaExtent(129, [128]));
  assert.equal(again.steps(centre.q, centre.r), 8); assert.equal(again.steps(home.q, home.r), 0);
  assert.equal(sea.seaField(sea.seaExtent(129, [])).steps(home.q, home.r), 8, 'a sparse world with no ring has no land');
  // far sampling reaches tiles more than 4,096 apart: none answers for another (the old key gave (q, r) and
  // (q + 1, r − 4096) one answer, so a far sample of sea could later be read as the land's own tile, or the reverse)
  const f3 = sea.seaField(sea.seaExtent(3, null)), land = tileHex(1, 0, 0);
  assert.equal(f3.steps(land.q + 1, land.r - 4096), 8, 'far out: deep sea'); assert.equal(f3.steps(land.q, land.r), 0, 'the land tile is still land');
  const g3 = sea.seaField(sea.seaExtent(4, null));
  assert.equal(g3.steps(land.q, land.r), 0); assert.equal(g3.steps(land.q + 1, land.r - 4096), 8, 'and the other way round');
  assert.equal(g3.inland(0, 0), true); assert.equal(only.inland(0, 0), false);
  // nor at any other width a packed number might have had: 2^12, 2^16, 2^20, 2^21, 2^26 and beyond 2^31
  const g5 = sea.seaField(sea.seaExtent(5, null));
  for (const w of [4096, 65536, 1048576, 2097152, 67108864, 4294967296]) for (const [dq, dr] of [[1, -w], [-1, w], [w, 0], [0, w], [-w, w], [w, -2 * w]]) {
    assert.equal(g5.steps(land.q + dq, land.r + dr), 8, `(${dq}, ${dr}) from the land: deep sea`);
  }
  assert.equal(g5.steps(land.q, land.r), 0, 'after all of them the land tile is land'); assert.equal(g5.steps(0, 0), 0); assert.equal(g5.inland(0, 0), true);
  // beyond the last ring the full world's sea is as deep as ever
  const out = tileHex(128, 0, 0); assert.equal(sea.seaField(3).steps(out.q, out.r), 8);
});

test('the paper of a whole sheet: at most PAPER_STAINS stains however wide the world; a small box is laid as ever', () => {
  const box = s => ({ x0: -s.x, y0: -s.y, x1: s.x, y1: s.y });
  const naive = b => (Math.floor((b.x1 + 400) / 620) - Math.floor((b.x0 - 400) / 620) + 1) * (Math.floor((b.y1 + 400) / 620) - Math.floor((b.y0 - 400) / 620) + 1) * 2;
  const small = box(sheetOf(3)), wide = box(sheetOf(129));
  assert.ok(naive(small) <= chart.PAPER_STAINS); assert.ok(naive(wide) > 100_000, `${naive(wide)} stains were laid for 129 rings`);
  reset(); chart.paintPaper(g2d(), small, 1); const a = count.draws;
  assert.ok(a > 0 && a <= naive(small), 'a small sheet: every stain of the lattice that touches it');
  reset(); chart.paintPaper(g2d(), wide, 0.01); const b = count.draws;
  assert.ok(b > 0 && b <= chart.PAPER_STAINS, `${b} stains for 129 rings`);
  // a hard cap, whatever the box: wide and low, tall and narrow, off-centre, all in negative coordinates, just over the cap
  for (const bx of [{ x0: -400000, y0: -300, x1: 400000, y1: 300 }, { x0: -300, y0: -400000, x1: 300, y1: 400000 }, { x0: -350000, y0: -260000, x1: -10000, y1: -9000 },
    { x0: 12345, y0: -98765, x1: 345678, y1: 87654 }, { x0: -33480, y0: -27590, x1: 33480, y1: 27590 }, { x0: -34000, y0: -27000, x1: 34200, y1: 27100 }, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }]) {
    reset(); chart.paintPaper(g2d(), bx, 0.01);
    assert.ok(count.draws > 0 && count.draws <= chart.PAPER_STAINS, `${JSON.stringify(bx)}: ${count.draws} stains`);
  }
  reset(); chart.paintPaper(g2d(), { x0: 60000, y0: -500, x1: 62000, y1: 500 }, 1);
  assert.ok(count.draws > 0 && count.draws <= 60, 'a screen-sized box far out in the wide world: its own few stains');
});

test('the minimap of a sparse world paints its seeded ring and the rim, not the full disk', () => {
  const paint = seeded => { reset(); minimap.paintMinimap(g2d(), { recs: new Map(), rings: 129, seeded, px: 180, dpr: 1 }); return count.hexes; };
  const rim = 6 * 129;
  assert.equal(paint(null), 1 + 3 * 128 * 129 + rim, 'a full world of 129 rings: every province, as before');
  assert.equal(paint([128]), 1 + 6 * 128 + rim, 'ring 128 alone: 768 provinces, the centre mark and the rim');
  assert.equal(paint([2, 128]), 1 + 12 + 6 * 128 + rim);
  assert.equal(paint([]), 1 + rim);
});

test('the sheet\'s outline: walked at 16 px as ever while that is within SHEET_OUTLINE_POINTS, and never more points than that for any world', async () => {
  const table = await import(`${web}map/table.mjs`);
  assert.equal(table.SHEET_OUTLINE_POINTS, 4096);
  // the sheets of ordinary worlds: the same points as before (the 16 px walk)
  for (const [rings, points] of [[1, null], [3, 836], [12, 3276]]) {
    const s = sheetOf(rings);
    if (points !== null) assert.equal(s.points.length, points, `${rings} rings`);
    assert.equal(s.path.points, s.points.length);
    const [a, b] = [s.points[10], s.points[11]];
    assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 16) < 6, `${rings} rings: a 16 px step`);
  }
  // wide worlds: 36,346 points for 129 rings at the 16 px walk; now within the cap, for every ring count up to the most a season opens
  let most = 0;
  // (129 is the most rings a season opens: the camera's land box, camera.mjs landBox, reads no ring beyond 128)
  for (const rings of [17, 18, 33, 64, 100, 127, 128, 129]) {
    const s = sheetOf(rings); most = Math.max(most, s.points.length);
    assert.ok(s.points.length <= table.SHEET_OUTLINE_POINTS, `${rings} rings: ${s.points.length} points`); assert.equal(s.path.points, s.points.length);
    // the outline still goes round the whole sheet: its points reach all four sides
    const xs = s.points.map(pt => pt[0]), ys = s.points.map(pt => pt[1]);
    assert.ok(Math.min(...xs) < -s.x + 40 && Math.max(...xs) > s.x - 40 && Math.min(...ys) < -s.y + 40 && Math.max(...ys) > s.y - 40, `${rings} rings: all four sides`);
  }
  assert.ok(most > 4000, `the cap is used (${most})`);
  assert.equal(sheetOf(129).points.length, 4090);
});

test('the far view of a sparse world lists its seeded ring and the rings beyond the map, before anything is measured or sorted', async () => {
  const { visibleProvinces, provinceCandidates } = await import(`${web}map/viewport.mjs`);
  const { ringOf } = await import(`${web}fgeo.mjs`);
  const { view } = fit(129), maxRing = 128 + 2;
  const all = visibleProvinces(view, SIZE, maxRing);
  assert.ok(all.length > 49_537, `${all.length} cells of the full disk and its cloud rings`);
  let asked = 0;
  const keep = (p, q) => { asked++; const d = ringOf(p, q); return d >= 129 || d === 128; };
  const listed = visibleProvinces(view, SIZE, maxRing, null, keep);
  assert.equal(listed.length, 6 * 128 + 6 * 129 + 6 * 130, 'ring 128 and the two cloud rings');
  assert.equal(asked, [...provinceCandidates(view, SIZE, maxRing)].length, 'asked once a candidate');
  // the same cells, in the same order, as the full list filtered afterwards
  assert.deepEqual(listed, all.filter(c => keep(c.p, c.q)));
  assert.deepEqual(visibleProvinces(view, SIZE, maxRing, null, null), all, 'no predicate: as before');
});

test('the renderer itself, a world that seeds ring 128 alone: a far frame behind the opening paints its 768 provinces\' cells, not the disk\'s 49,537', async () => {
  const fmap = await import(`${web}map/fmap.mjs`);
  const tally = { hexes: 0, all: 0 };
  const ctxOf = () => { const grad = { addColorStop() {} }; const t = { createLinearGradient: () => grad, createRadialGradient: () => grad, measureText: () => ({ width: 10 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), createPattern: () => ({ setTransform() {} }) };
    return new Proxy(t, { get: (o, k) => (k in o ? o[k] : () => { tally.all++; if (k === 'closePath') tally.hexes++; }), set: (o, k, v) => { o[k] = v; return true; } }); };
  const el = tag => { const ctx = ctxOf(); const e = { tag, className: '', dataset: {}, style: { setProperty() {} }, kids: [], width: 0, height: 0, getContext: tag === 'canvas' ? () => ctx : undefined, append(k) { this.kids.push(k); } }; ctx.canvas = e; return e; };
  const stage = el('div'), ground = el('canvas'), dress = el('div'); dress.querySelector = () => null;
  const canvas = { ...el('canvas'), clientWidth: SIZE.width, clientHeight: SIZE.height, getBoundingClientRect: () => ({ left: 0, top: 0, width: SIZE.width, height: SIZE.height }), addEventListener() {},
    ownerDocument: { createElement: el, getElementById: id => ({ 'map-stage': stage, 'map-ground': ground, 'map-dress': dress })[id] ?? null } };
  const src = { overviews: new Map(), ringsOpen: 129, seeded: [128], own: [{ p: 128, q: 0, tile: 60 }], open: { mode: 'play', ready: true, stage: 'final', active: 0 } };
  const m = new fmap.FrontierMap(canvas, { source: () => src });
  let far = null;
  for (let f = 0; f <= 130; f++) { tally.hexes = 0; tally.all = 0; m.draw(f * 16); if (m.cam.drawn.zoom < 0.02 && tally.hexes > 0) far = { ...tally, f }; }
  assert.ok(far, 'a far frame with the land on it was painted');
  assert.ok(far.hexes >= 768 && far.hexes <= 768 + 6 * 129 + 6 * 130 + 64, `${far.hexes} cells in frame ${far.f} (50,311 before)`);
  assert.ok(far.all < 20_000, `${far.all} canvas calls in that frame (352,586 before)`);
});
