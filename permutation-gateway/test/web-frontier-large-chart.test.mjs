// Narrow original-map regression. Import closure: original-page audit in
// docs/integration/CODEX-LOCAL-BROWSER-AUDIT-20261108.md. Re-reviewed calls:
// camera geometry/Camera, fgeo tile projection, map prototype camera methods,
// and paintScene with inert canvas + explicit marker/backdrop stubs only.
// No FrontierMap constructor, app boot, assets, network, worker, WASM, timers,
// wallet, signer, or guard self-test. Terrain/hydration/cloud callbacks below
// count and return null; no blocked operation is invoked even as a test.
import { keyCalls } from '../screens/codex/no-key-node.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, chartZoomMin, fitView, freeBox, landBox } from '../../permutation-server/web/frontier/map/camera.mjs';
import { FrontierMap, COARSE_CHART_PX, CHART_BATCH_CELLS, coarseChart, chartSurveyLevels, chartKeepView, paintChartCells, lodFor, pick, worldToScreen } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from '../../permutation-server/web/frontier/map/layers.mjs';
import { tileHex, ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { buildSurvey, hexKey } from '../../permutation-server/web/frontier/map/survey.mjs';
import { KeepBoard, provinceGeo } from '../../permutation-server/web/frontier/map/keeps.mjs';

const desktop = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function mapAt(size, inset, rings = 129) {
  const m = Object.create(FrontierMap.prototype);
  m.rings = rings; m.size = () => size; m.inset = () => inset;
  m.source = () => ({ ringsOpen: rings }); m.lod = 'tile';
  m.cam = new Camera({ view: { x: 123, y: -45, zoom: 1.15 }, reduced: () => true });
  m.setView = v => { m.cam.set(m.limitView(v)); m.lod = lodFor(m.cam.view.zoom, m.lod, m.edges()); };
  return m;
}
test('radius128 fits desktop, phone and covered phone; live clamp cannot crop it', () => {
  for (const size of [desktop, phone, {width: 320, height: 568}]) for (const inset of [null, {top: 90, bottom: 420, left: 0, right: 0}, {right: 420}]) {
    const m = mapAt(size, inset), v = m.farView(), b = landBox(129), f = freeBox(size, inset);
    assert.ok(v.zoom < .02); assert.ok(m.zoomMin() < v.zoom);
    assert.equal(m.clampZoom(v.zoom), v.zoom);
    assert.ok(2 * b.x * v.zoom <= f.width * .7 + 1e-8);
    assert.ok(2 * b.y * v.zoom <= f.height * .7 + 1e-8);
    close(-v.x * v.zoom, f.x); close(-v.y * v.zoom, f.y);
    assert.equal(lodFor(v.zoom, 'tile', m.edges()), 'world');
    assert.ok(coarseChart('world', v.zoom));
    assert.equal(m.flatZoom(), fitView(129, size).zoom);
  }
});
test('near-world framing unchanged; repeated chart trips restore exact camera', () => {
  for (const rings of [1, 3, 9]) for (const size of [desktop, phone]) {
    const m = mapAt(size, null, rings), full = fitView(rings, size).zoom;
    assert.equal(m.zoomMin(), Math.max(.02, full * .8));
    assert.equal(m.farView().zoom, Math.max(.02, full));
  }
  for (const size of [desktop, phone]) {
    const m = mapAt(size, {bottom: 350}), original = {...m.cam.view};
    for (let i = 0; i < 3; i++) {
      m.worldChart(); assert.equal(m.chartOn(), true); assert.deepEqual(m.back, original);
      m.worldChart(); assert.equal(m.back, null); assert.deepEqual(m.cam.view, original);
    }
    const c = provincePixel(125, -40), s = worldToScreen(m.farView(), size, c.x, c.y);
    const hit = pick(m.farView(), size, s.x, s.y);
    assert.deepEqual([hit.p, hit.q], [125, -40]);
  }
  assert.equal(chartZoomMin(129, {width: 0, height: 0}), .02);
  assert.equal(coarseChart('province', .001), false);
  assert.equal(coarseChart('world', COARSE_CHART_PX / (2 * PROVINCE_CIRCUMRADIUS) + 1e-8), false);
});
test('coarse visibility agrees with real survey maximum, including mixed tile knowledge', () => {
  const h = tileHex(-4, 2, 30), known = tileHex(3, -1, 17);
  const survey = buildSurvey({ringsOpen: 129, anchors: [{...h, radius: 2, level: 3}], memory: new Set([hexKey(known.q, known.r)])});
  const levels = chartSurveyLevels(survey);
  for (const [p,q] of [[-4,2],[3,-1],[0,0],[128,0]]) assert.equal(levels.get(`${p},${q}`) ?? 1, survey.province(p,q).max);
});

test('only coarse chart trips use wall-clock animation and finish after a slow frame', () => {
  for (const rings of [3,129]) {
    const m = mapAt(desktop, null, rings), original = {...m.cam.view};
    m.cam.reduced = () => false;
    let opts;
    m.setView = (v,o) => { opts = o; m.cam.set(m.limitView(v),o); m.lod = lodFor(m.cam.view.zoom,m.lod,m.edges()); };
    m.worldChart();
    assert.equal(opts.real,rings===129);
    assert.ok(m.cam.moving);
    m.cam.step(1000); m.cam.step(1000+opts.ms+1000);
    if (rings===129) {
      assert.equal(m.cam.moving,false,'coarse outbound arrives on elapsed wall time');
      assert.deepEqual(m.cam.drawn,m.cam.view);
    } else {
      assert.equal(m.cam.moving,true,'near-world trip still advances only one capped step');
      m.cam.finish();
    }
    m.worldChart();
    assert.equal(opts.real,rings===129);
    m.cam.step(5000); m.cam.step(5000+opts.ms+1000);
    if (rings===129) {
      assert.equal(m.cam.moving,false,'coarse return also arrives on elapsed wall time');
      assert.deepEqual(m.cam.drawn,original);
    } else assert.equal(m.cam.moving,true);
  }
  assert.deepEqual(keyCalls,[]);
});
function context() {
  const counts = { fills: 0, strokes: 0, vertices: 0, maxFillVertices: 0, fillPasses: [] };
  let pathVertices = 0;
  const ctx = { save(){}, restore(){}, setTransform(){}, beginPath(){pathVertices=0;}, closePath(){},
    arc(){},
    moveTo(){counts.vertices++;pathVertices++;}, lineTo(){counts.vertices++;pathVertices++;},
    fill(){counts.fills++;counts.maxFillVertices=Math.max(counts.maxFillVertices,pathVertices);counts.fillPasses.push({colour:this.fillStyle,alpha:this.globalAlpha});}, stroke(){counts.strokes++;} };
  return {ctx, counts};
}
test('batched chart keeps fog/control/selection without per-cell fill calls', () => {
  const {ctx, counts} = context();
  const cells = Array.from({length: 1000}, (_, p) => ({p, q: 0, fog: 'distant', rec: null, control: p % 6, selected: p === 5}));
  const work = paintChartCells(ctx, cells, .005);
  assert.deepEqual(work, {cells: 1000, fills: 14});
  assert.equal(counts.fills, 14); assert.equal(counts.strokes, 1);
  assert.equal(counts.vertices, 1000 * 6 * 3 + 6);
  assert.equal(counts.maxFillVertices, CHART_BATCH_CELLS * 6);
  assert.deepEqual(counts.fillPasses.map(p=>p.alpha), [...Array(4).fill(1),...Array(4).fill(.55),...Array(6).fill(.46)]);
});
test('actual radius128 scene has zero terrain/province hydration, far bitmaps or cloud pieces', t => {
  for (const size of [desktop, phone]) for (const showAll of [false, true]) {
    const {ctx, counts} = context(), calls = {terrain: 0, province: 0, survey: 0, bitmap: 0, cloud: 0, own: 0, top: 0};
    const view = fitView(129, size), survey = {showAll, tiles: new Map(), province(){calls.survey++; return {max: 3};}};
    const src = {ringsOpen: 129, survey, overviews: new Map(), terrainOf(){calls.terrain++; return null;}, provinceOf(){calls.province++; return null;}};
    const m = mapAt(size, null);
    Object.assign(m, {art: {misses: 0, paintFar(){calls.bitmap++;}}, keeps: {on: false, rows: new Map()},
      sea: {paint(){calls.cloud++; return {};}}, backdrop(){}, youFrame(){return {};}, keepsOn(){return false;},
      farPass(){calls.own++; return [];}, topPass(){calls.top++;}, dpr(){return 1;}});
    const out = m.paintScene(ctx, src, view, 'world', size, 1, {now: 1000});
    assert.deepEqual(calls, {terrain: 0, province: 0, survey: 0, bitmap: 0, cloud: 0, own: 1, top: 1});
    assert.equal(out.pending, 0); assert.equal(out.rough, 0);
    assert.ok(counts.fills <= 2 * Math.ceil(49537 / CHART_BATCH_CELLS) + Math.ceil(774 / CHART_BATCH_CELLS));
    assert.ok(counts.vertices >= 49537 * 6);
    assert.ok(counts.maxFillVertices <= CHART_BATCH_CELLS * 6);
    t.diagnostic(`${size.width}x${size.height} showAll=${showAll}: ${counts.fills} fills, ${counts.vertices} vertices; zero hydration/bitmaps/cloud pieces`);
    // Crossing back toward the near world restores the old source and cloud
    // calls. Stub callbacks remain inert; this is not an asset or network test.
    const nearer = {...view, zoom: COARSE_CHART_PX / (2 * PROVINCE_CIRCUMRADIUS) * 1.01};
    m.paintScene(ctx, src, nearer, 'world', size, 1, {now: 1000});
    assert.ok(calls.terrain > 0); assert.ok(calls.survey > 0);
    assert.equal(calls.cloud, 1); assert.equal(calls.own, 2); assert.equal(calls.top, 2);
  }
  assert.deepEqual(keyCalls, []);
});

// Additional audited calls: KeepBoard constructor only creates Maps/KeepBook;
// initial frame reads fixed public rows with no events or changes, producing no
// effect-bus moments. far/over draw into the inert context; selected rows alone
// reach public provinceGeo. No assets, WebCrypto, wallet or WASM invocation.
test('dense keep state stays whole while coarse drawing and hit testing retain useful markers only', t => {
  const recs = new Map();
  for (let d = 0; d <= 128; d++) for (const {p,q} of ringProvinces(d)) recs.set(`${p},${q}`, {
    p, q, control: d % 6, keepTile: 30, keepTroops: 0, contender: null, contestProgress: 0, contestRequired: 72,
    sites: Array(12).fill(0), owners: Array(12).fill(255),
  });
  const board = new KeepBoard(), size = desktop, view = fitView(129, size);
  const selected = {p: 0, q: 0}, own = {p: 10, q: 0}, reachable = {p: 20, q: 0};
  // setReach only updates public presentation fields and calls its inert
  // default invalidation callback; it sends no order or external message.
  board.setReach([{...reachable, reachable: true}]);
  const src = {ringsOpen: 129, selected, own: [own], viewerFaction: 0, overviews: new Map([[0, {provinces: [...recs.values()]}]]),
    survey: {showAll: true, tiles: new Map()}, terrainOf(){assert.fail('coarse terrain');}, provinceOf(){assert.fail('coarse hydration');}};
  const m = mapAt(size, null), {ctx} = context();
  let placements = 0, drawnRows = 0;
  const place = board.place;
  board.place = function(...args) { placements++; return place.apply(this, args); };
  Object.assign(m, {keeps: board, art: {misses: 0}, sea: {paint(){assert.fail('coarse cloud');}}, backdrop(){},
    youFrame(){return {src, survey: src.survey, villages: [], z: view.zoom, lod: 'world', fx: 1000, still: true};},
    farPass(g, F) { drawnRows = F.KB.visible(F).length; F.KB.far(g, F); F.KB.over(g, F, () => true); return []; },
    topPass(){}, dpr(){return 1;}, invalidateSoon(){}, standAt(){return null;},
    project(x,y){return worldToScreen(view, size, x, y);},
  });
  m.paintScene(ctx, src, view, 'world', size, 1, {now: 1000});
  assert.equal(board.rows.size, 49537); assert.equal(drawnRows, 3); assert.equal(placements, 6);
  assert.equal(m.chartKeeps.rows, board.rows, 'presentation proxy keeps authoritative board rows');
  const signature = board.sig, rows = board.rows;
  board.frame(recs, {viewer: 0}, {fx: 1001, still: true});
  assert.equal(board.sig, signature); assert.equal(board.rows, rows, 'unchanged records keep the original book');
  // Coarse hit boxes follow the three actual marks, not 49,537 hidden ones.
  m.cam.set(view); placements = 0;
  const p = place.call(board, board.rows.get('20,0'), view.zoom), screen = m.project(p.x, p.y);
  assert.deepEqual(m.keepAt(screen.x, screen.y), {...reachable, tile: 30});
  assert.equal(placements, 3);
  // Retain own host and village positions; discard unrelated/unreachable
  // markers. Refusal expiration writes through to the original board.
  board.note = {key: '40,0', at: 0};
  const filtered = chartKeepView(board, src, {villages: [{p: 30, q: 0}], board: {hosts: [{p: 35, q: 0}]}}, 1000);
  assert.equal(filtered.visible({}).length, 6);
  filtered.note = null; assert.equal(board.note, null);
  board.captures.set('45,0', {t0: 1000, mine: true});
  board.captures.set('46,0', {t0: 1000, lost: true});
  board.captures.set('47,0', {t0: 1000});
  board.captures.set('48,0', {t0: -1e6, mine: true});
  const moments = chartKeepView(board, src, {}, 1000).visible({}).map(r => r.key);
  assert.ok(moments.includes('45,0') && moments.includes('46,0'));
  assert.ok(!moments.includes('47,0') && !moments.includes('48,0'));
  assert.equal(board.captures.has('48,0'), false, 'aggregated expired moments do not keep repainting');
  const empty = chartKeepView(new KeepBoard(), {}, {}, 1000);
  assert.deepEqual(empty.visible({}), []);
  assert.deepEqual(keyCalls, []);
  t.diagnostic('49,537 full keep rows; 3 retained marks; far+over 6 placements; coarse hit test 3 placements; ordinary far marks need no tile geometry');
});

test('dense keep culling preserves exact centre/pad selection without building province geometry', t => {
  const recs = new Map();
  for (let d = 0; d <= 128; d++) for (const {p,q} of ringProvinces(d)) recs.set(`${p},${q}`, {p,q,keepTile:30,control:d%6});
  const board = new KeepBoard();
  board.frame(recs, {viewer: 0}, {fx: 1000, still: true});
  const all = [...board.rows.values()];
  const boxes = [null, {x0:-800,x1:800,y0:-600,y1:600}, {x0:1e7,x1:1e7+100,y0:0,y1:100}];
  for (const [p,q] of [[0,0],[128,0],[-128,0],[0,128],[64,-128],[-7,4]]) {
    const c = provincePixel(p,q);
    boxes.push({x0:c.x-200,x1:c.x+200,y0:c.y-180,y1:c.y+180});
    boxes.push({x0:c.x,x1:c.x+100,y0:c.y-100,y1:c.y+100});
  }
  const inside = (c,s,pad) => !s || (c.x>s.x0-pad && c.x<s.x1+pad && c.y>s.y0-pad && c.y<s.y1+pad);
  for (const seen of boxes) for (const pad of [0, 132, PROVINCE_CIRCUMRADIUS, -1]) {
    const expected = all.filter(r => inside(provincePixel(r.p,r.q),seen,pad));
    assert.deepEqual(board.visible({seen},pad), expected, 'dense membership, row identity and order');
  }
  // Bounded legacy oracle checks the actual old provinceGeo.c, including
  // exact boundaries and both pad values used by the production painters.
  const sample = [all[0], all[1], all[20], all[61], all[100], all[1000], all[10000], all.at(-1)];
  const small = new KeepBoard(); small.book.rows = new Map(sample.map(r => [r.key,r]));
  for (const r of sample) assert.deepEqual(provinceGeo(r.p,r.q).c, provincePixel(r.p,r.q));
  for (const seen of boxes) for (const pad of [0,132,PROVINCE_CIRCUMRADIUS]) {
    assert.deepEqual(small.visible({seen},pad), sample.filter(r => inside(provinceGeo(r.p,r.q).c,seen,pad)));
  }
  // Source-shape check is instrumentation, not the correctness oracle above.
  const source = KeepBoard.prototype.visible.toString().replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(source, /provinceGeo\(/);
  assert.match(source, /provincePixel\(r\.p, r\.q\)/);
  // The actual far painter ran above on ordinary records. Its only geometry
  // call is now conditional on a capture, whose flood needs the tile outline.
  const farSource = KeepBoard.prototype.far.toString().replace(/\/\/[^\n]*/g, '');
  assert.equal((farSource.match(/provinceGeo\(/g) ?? []).length, 1);
  assert.match(farSource, /geo = cap \? provinceGeo\(row\.p, row\.q\) : null/);
  assert.equal(board.rows.size,49537);
  assert.deepEqual(keyCalls, []);
  t.diagnostic('49,537 cheap centre checks per cull; no provinceGeo calls; exact parity across 60 dense box/pad cases and 45 bounded legacy cases');
});
