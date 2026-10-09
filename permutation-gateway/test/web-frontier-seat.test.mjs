// The third wave of the map (UX brief §12.1 to §12.3; permutation-server/web/frontier/map): the everyday frame is a
// view from a seat (the camera further back, the board at 26 degrees, the far rows paling into a horizon, the
// village a little below the middle), and mountains and woods are upright art drawn by code. What these tests hold:
// the numbers of that frame, that the haze lies on the sheet and nowhere else, that the relief is the same picture
// every time, and that a tile's wood stands inside its tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as tilt from '../../permutation-server/web/frontier/map/tilt.mjs';
import * as fmap from '../../permutation-server/web/frontier/map/fmap.mjs';
import * as relief from '../../permutation-server/web/frontier/map/relief.mjs';
import { CODE_RELIEF, RELIEF_SCALE } from '../../permutation-server/web/frontier/map/sprites.mjs';
import * as opening from '../../permutation-server/web/frontier/map/opening.mjs';
const { heroZoom } = opening;
import { sheetOf } from '../../permutation-server/web/frontier/map/table.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { FLATTEN, RADIUS, project } from '../../permutation-server/web/map.mjs';

const desk = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const css = readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');

/** A canvas inside a page that has the tilted stage; the dressing's element takes children and custom properties. */
function staged(size) {
  const style = () => { const vars = {}; return { vars, setProperty: (k, v) => { vars[k] = v; } }; };
  const kids = [];
  const stage = { dataset: {}, style: style() }, ground = { style: style(), getContext: () => null, width: 0, height: 0 };
  const dress = { style: style(), kids, querySelector: sel => kids.find(k => `.${k.className}` === sel) ?? null, append: k => kids.push(k) };
  const canvas = { clientWidth: size.width, clientHeight: size.height, dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: size.width, height: size.height }),
    ownerDocument: { createElement: tag => ({ tag, className: '' }), getElementById: id => ({ 'map-stage': stage, 'map-ground': ground, 'map-dress': dress })[id] ?? null } };
  return { canvas, stage, ground, dress };
}
const HOME = { p: 2, q: 0, tile: 7 };
const homePoint = (() => { const h = tileHex(HOME.p, HOME.q, HOME.tile); return project(h.q, h.r); })();
function mapOn(size, extra = {}) {
  const page = staged(size);
  const m = new fmap.FrontierMap(page.canvas, { source: () => ({ overviews: new Map(), ringsOpen: 3, own: [{ ...HOME }], open: { ready: true, active: 0 } }), ...extra });
  m.cam.reduced = () => true;
  m.rings = 3;
  return { m, ...page };
}
/** A context that takes every call (and counts them). */
function rec() {
  const calls = [], grad = { addColorStop() {} };
  return new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : k === 'canvas' ? null : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => grad : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: () => true });
}

// ------------------------------------------------------------------ the seat's frame
test('the seat: 26 degrees, a hex some 85 px wide, the far row three quarters of the middle one', () => {
  assert.equal(tilt.TILT.deg, 26);
  assert.equal(tilt.TILT.max, 26, 'and no trial goes past it');
  assert.equal(tilt.tiltFromQuery('?tilt=40'), 26);
  assert.equal(tilt.tiltFromQuery('?tilt=0'), 0, 'the flat map stays one word away');
  for (const size of [desk, phone]) {
    const g = tilt.tiltGeo(size, tilt.TILT.deg);
    assert.ok(g.scaleAt(0) < 0.9 && g.scaleAt(0) > 0.7, `${size.width}: the row at the box's top edge is ${g.scaleAt(0).toFixed(3)} of the middle one`);
    // the picture's own top edge shows a row further still
    const top = g.toStage(size.width / 2, 0);
    assert.ok(g.scaleAt(top.y) < 0.8 && g.scaleAt(top.y) > 0.7, `${size.width}: at the picture's top ${g.scaleAt(top.y).toFixed(3)}`);
  }
  assert.ok(near(Math.sqrt(3) * RADIUS * heroZoom(1), 87.6, 0.1) && near(Math.sqrt(3) * RADIUS * heroZoom(2), 83.8, 0.1));
});

test('the opening on a village is the seat\'s frame: the village a little below the middle of the free part, on both sizes', () => {
  for (const size of [desk, phone]) {
    const inset = size === desk ? { top: 64, right: 0, bottom: 84, left: 0 } : { top: 56, right: 0, bottom: 230, left: 0 };
    const { m } = mapOn(size, { insets: () => inset });
    assert.equal(m.open(m.source(), size), true);
    const free = size.height - inset.top - inset.bottom, c = m.project(homePoint.x, homePoint.y, { box: true, logical: true });
    assert.ok(near(c.x, size.width / 2, 1e-6) && near(c.y, inset.top + free / 2 + fmap.SEAT_DROP * free, 1e-6), `${size.width}: the village is seen at ${c.x.toFixed(1)}, ${c.y.toFixed(1)}`);
    assert.equal(m.view.zoom, heroZoom(1));
    // H from there changes nothing: it is the same frame
    const was = { ...m.view };
    m.home();
    assert.ok(near(m.view.x, was.x, 1e-6) && near(m.view.y, was.y, 1e-6) && m.view.zoom === was.zoom, 'home is the opening view');
    // and any other place a list sends the camera to is seen in the middle (the seat's frame is the village's own)
    m.flyTo({ x: 300, y: 200, zoom: 1.15 });
    const d = m.project(300, 200, { box: true, logical: true });
    assert.ok(near(d.y, inset.top + free / 2, 1e-6));
  }
});

// ------------------------------------------------------------------ the horizon
test('the haze lies on the sheet: no clip while the picture is all sheet; where the sheet\'s edge is in the picture, its outline as it is seen', () => {
  const { m } = mapOn(desk);
  const G = m.groundLayout(desk), sheet = sheetOf(3);
  const clipAt = v => m.sheetClip(v, desk, m.geo(v.zoom, desk), G);
  assert.equal(clipAt({ x: 0, y: 0, zoom: 1.15 }), 'none', 'inland: the whole picture is paper');
  // the camera near the sheet's far edge: the edge is a level line across the picture, the haze stops a little inside it
  const v = { x: 0, y: -sheet.y + 200, zoom: 1.15 }, clip = clipAt(v);
  const pts = /^polygon\((.+)\)$/.exec(clip)?.[1].split(', ').map(p => p.split(' ').map(parseFloat));
  assert.equal(pts?.length, 4, clip);
  const edge = m.geo(v.zoom, desk).toBox(720, (-sheet.y + fmap.HAZE_INSET - v.y) * v.zoom + 450);
  assert.ok(near(pts[0][1], edge.y, 0.06) && near(pts[1][1], edge.y, 0.06), 'its top is the sheet\'s far edge as the tilt shows it');
  assert.ok(edge.y > 0 && edge.y < 450, 'which is in the picture');
  assert.ok(pts[2][1] >= 900 && pts[3][1] >= 900, 'and it reaches the picture\'s foot');
  // far off the sheet (never in play: the pan stops long before): nothing to haze
  assert.equal(clipAt({ x: 0, y: -sheet.y - 4000, zoom: 1.15 }), 'polygon(0 0)');
  // a flat board has no haze and no clip
  const flat = mapOn(desk, { tilt: 0 });
  assert.equal(flat.m.sheetClip(v, desk, flat.m.geo(v.zoom, desk), flat.m.groundLayout(desk)), 'none');
});

test('the depth dressing: a haze clipped to the sheet, the dark of the room above it, both gone with the tilt', () => {
  const { m, dress } = mapOn(desk);
  assert.equal(dress.kids.length, 1, 'the map makes the one element the pages do not carry');
  assert.equal(dress.kids[0].className, 'map-dusk');
  m.dressPage(26, { near: 1, shown: 1, haze: 1, sheet: 'polygon(1px 2px, 3px 4px, 5px 6px)' });
  assert.equal(dress.style.vars['--map-haze'], '1.000');
  assert.equal(dress.style.vars['--map-dusk'], '1.000');
  assert.equal(dress.style.vars['--map-sheet'], 'polygon(1px 2px, 3px 4px, 5px 6px)');
  m.dressPage(0, { near: 0, shown: 1, haze: 1 });
  assert.equal(dress.style.vars['--map-haze'], '0.000', 'the chart lies flat: no far rows');
  assert.equal(dress.style.vars['--map-dusk'], '0.000');
  assert.equal(dress.style.vars['--map-sheet'], 'none');
  // (while the waiting picture shows, the dark above the horizon is there although the board's own haze is not)
  m.dressPage(0, { near: 1, shown: 1, haze: 0, dusk: 1 });
  assert.deepEqual([dress.style.vars['--map-haze'], dress.style.vars['--map-dusk']], ['0.000', '1.000']);
  const flat = mapOn(desk, { tilt: 0 });
  flat.m.dressPage(0, { near: 1, shown: 1, haze: 0, dusk: 1 });
  assert.equal(flat.dress.style.vars['--map-dusk'], '0.000', 'a flat board has no horizon');
  // the style sheet: the haze is clipped by that property, the dusk fades with the same strength, neither takes a press
  const haze = /\.map-dress::before \{([^}]+)\}/.exec(css)?.[1] ?? '', dusk = /\.map-dusk \{([^}]+)\}/.exec(css)?.[1] ?? '';
  assert.match(haze, /clip-path: var\(--map-sheet, none\)/);
  assert.match(haze, /opacity: var\(--map-haze, 0\)/);
  assert.match(dusk, /opacity: var\(--map-dusk, 0\)/);
  assert.match(dusk, /pointer-events: none/);
  // the band: the haze is thickest in the top 10 to 14% of the map and never opaque (the land is still seen through it)
  const stops = [...haze.matchAll(/rgba\(\d+,\d+,\d+,([\d.]+)\)(?: (\d+)%)?/g)].map(x => [Number(x[1]), x[2] === undefined ? null : Number(x[2])]);
  const high = Number(/height: (\d+)%/.exec(haze)[1]) / 100;
  assert.ok(stops.length >= 6 && Math.max(...stops.map(s => s[0])) <= 0.92);
  const thick = stops.filter(s => s[0] >= 0.85 && s[1] !== null).map(s => s[1] * high);
  assert.ok(Math.max(...thick) >= 10 && Math.max(...thick) <= 14, `the band ends ${Math.max(...thick).toFixed(1)}% down the map`);
  // and warm: more red than blue in every stop
  for (const x of haze.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) assert.ok(Number(x[1]) > Number(x[3]) + 20);
});

// ------------------------------------------------------------------ the relief
test('mountains and woods are drawn by code; hills keep their baked ground', () => {
  assert.equal(CODE_RELIEF.mountain, true);
  assert.equal(CODE_RELIEF.forest, true);
  assert.equal(CODE_RELIEF.hills, undefined);
  assert.ok(RELIEF_SCALE.mountain >= 0.9 && RELIEF_SCALE.mountain <= 1.2 && RELIEF_SCALE.tree > 0.8);
  // a mountain: every variant is a picture (faces, snow, foothills), the same calls every time, and it stays inside its box
  for (let v = 0; v < 3; v++) {
    const a = rec(), b = rec();
    relief.paintMountain(a, 0, 0, 100, { variant: v });
    relief.paintMountain(b, 0, 0, 100, { variant: v });
    assert.ok(a.calls.length > 300, `variant ${v}: ${a.calls.length} calls`);
    assert.deepEqual(a.calls.map(c => c[0]), b.calls.map(c => c[0]), 'seeded: the same mountain');
    const B = relief.RELIEF.mountain;
    for (const [k, x, y] of a.calls) if ((k === 'moveTo' || k === 'lineTo') && Number.isFinite(x)) assert.ok(x >= -B.left * 100 && x <= B.right * 100 && y >= -B.top * 100 && y <= B.bottom * 100, `variant ${v}: ${k} ${x.toFixed(1)}, ${y.toFixed(1)} is in the box`);
    // it stands: its summit is more than a hex radius above the middle of its footprint
    assert.ok(Math.min(...a.calls.filter(c => c[0] === 'lineTo' || c[0] === 'moveTo').map(c => c[2])) < -120);
  }
  assert.notDeepEqual((g => { relief.paintMountain(g, 0, 0, 100, { variant: 0 }); return g.calls.length; })(rec()), (g => { relief.paintMountain(g, 0, 0, 100, { variant: 2 }); return g.calls.length; })(rec()), 'the variants differ');
  // trees: two kinds, three variants each
  for (const kind of ['fir', 'leaf']) for (let v = 0; v < 3; v++) { const g = rec(); relief.paintTree(g, 0, 0, 60, { kind, variant: v }); assert.ok(g.calls.length > 20); }
  // without a canvas to keep it on, no bitmap (the caller paints it straight or leaves it)
  assert.equal(relief.reliefSprite('mountain', 60, 0), null);
});

test('a wood is its trees: seeded by the tile, inside the tile, back to front; round a site it leaves the clearing free', () => {
  const hexR = (x, y) => Math.max(Math.abs(y / FLATTEN), Math.abs(y / FLATTEN) / 2 + Math.abs(x) * Math.sqrt(3) / 2);
  let firs = [0, 0, 0], all = [0, 0, 0];
  for (let q = -6; q <= 6; q++) for (let r = -6; r <= 6; r++) for (let v = 1; v <= 3; v++) {
    const w = relief.woodOf(q, r, v);
    assert.deepEqual(w, relief.woodOf(q, r, v), 'the same wood every time');
    assert.ok(w.length >= 18 && w.length <= relief.WOOD.trees, `${q},${r}: ${w.length} trees`);
    for (let i = 1; i < w.length; i++) assert.ok(w[i].y >= w[i - 1].y, 'back to front');
    for (const t of w) {
      assert.ok(hexR(t.x, t.y) <= 1.02, `${q},${r}: a tree at ${t.x.toFixed(2)}, ${t.y.toFixed(2)} stands on its own tile`);
      assert.ok((t.kind === 'fir' || t.kind === 'leaf') && [0, 1, 2].includes(t.variant) && t.s > 0.6 && t.s < 1.2);
    }
    firs[v - 1] += w.filter(t => t.kind === 'fir').length; all[v - 1] += w.length;
    const ring = relief.woodOf(q, r, v, { ring: true });
    assert.ok(ring.length >= 6 && ring.length < w.length);
    for (const t of ring) assert.ok(Math.hypot(t.x, t.y / FLATTEN) >= relief.WOOD.clearing);
  }
  // the three variants are three mixes: a fir wood, a leaf wood, and one between
  const share = firs.map((n, i) => n / all[i]);
  assert.ok(share[0] > 0.7 && share[1] < 0.42 && share[2] > share[1] && share[2] < share[0], share.map(x => x.toFixed(2)).join(' '));
  assert.notDeepEqual(relief.woodOf(1, 2, 1), relief.woodOf(2, 1, 1), 'two tiles, two woods');
  // its floor is laid on the ground: one fill for the shade, one for the trees' shadows
  const g = rec();
  relief.paintWoodFloor(g, 0, 0, RADIUS, relief.woodOf(0, 0, 1));
  assert.ok(g.calls.filter(c => c[0] === 'ellipse').length >= 20);
});

// ------------------------------------------------------------------ no false state at load (UX brief §12.3)
/** A page with the stage whose elements can be made, laid out and painted: every context takes every call. */
function livePage(size) {
  const ctxOf = () => { const calls = {}; const grad = { addColorStop() {} }; const t = { calls, createLinearGradient: () => grad, createRadialGradient: () => grad, measureText: () => ({ width: 10 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }; return new Proxy(t, { get: (o, k) => (k in o ? o[k] : (...a) => { calls[k] = (calls[k] ?? 0) + 1; return a; }), set: () => true }); };
  const style = () => { const vars = {}; return { vars, setProperty: (k, v) => { vars[k] = v; } }; };
  const el = (tag) => { const ctx = ctxOf(); return { tag, className: '', dataset: {}, style: style(), kids: [], width: 0, height: 0, ctx, getContext: tag === 'canvas' ? () => ctx : undefined, append(k) { this.kids.push(k); } }; };
  const order = [];
  const stage = el('div'), ground = el('canvas'), dress = el('div');
  dress.querySelector = sel => dress.kids.find(k => `.${k.className}` === sel) ?? null;
  dress.before = k => order.push(k);
  const listeners = {};
  const canvas = { ...el('canvas'), clientWidth: size.width, clientHeight: size.height, getBoundingClientRect: () => ({ left: 0, top: 0, width: size.width, height: size.height }), addEventListener: (n, f) => { listeners[n] = f; },
    ownerDocument: { createElement: el, getElementById: id => ({ 'map-stage': stage, 'map-ground': ground, 'map-dress': dress })[id] ?? null } };
  return { canvas, stage, ground, dress, order, listeners };
}

test('until the viewer is known the map shows the bare sheet on its table, on a layer of its own; no input reaches it', () => {
  const page = livePage(desk);
  let src = { overviews: new Map(), ringsOpen: 3, own: [], open: { mode: 'play', ready: false, stage: 'none' } };
  const m = new fmap.FrontierMap(page.canvas, { source: () => src });
  const wait = page.order[0];
  assert.equal(wait?.className, 'map-stage map-wait', 'the map makes the waiting picture\'s stage, under the dressing');
  assert.equal(wait.kids[0].className, 'map-ground');
  m.draw(0);
  assert.equal(m.opened, undefined, 'nothing is framed: nobody knows who is looking');
  // the picture: painted on its own canvas (the ground canvas is only blanked), shown whole, at the seat's angle
  const wc = wait.kids[0];
  assert.ok(wc.width > desk.width && wc.height > desk.height, 'laid out as the ground canvas is');
  assert.deepEqual([wc.width, wc.height], [page.ground.width, page.ground.height]);
  assert.ok(wc.ctx.calls.fillRect >= 2, 'the table (its wood, its lamp)');
  assert.equal(wait.style.vars['--map-wait'], '1.000');
  assert.equal(wait.style.vars['--map-tilt'], '26.00deg');
  assert.equal(wc.style.vars['--map-gw'], page.ground.style.vars['--map-gw']);
  assert.equal(page.dress.style.vars['--map-dusk'], '1.000', 'the dark of the room above the horizon is there');
  assert.equal(page.dress.style.vars['--map-haze'], '0.000', 'the board\'s own haze is not: the picture carries its own');
  // painted once: a second frame of the same wait paints nothing more
  const n = wc.ctx.calls.fillRect;
  m.draw(16);
  assert.equal(wc.ctx.calls.fillRect, n);
  // the sheet is framed whole in the part nothing covers, whatever the world's size
  for (const rings of [1, 3, 6]) {
    m.rings = rings;
    const v = m.waitView(desk, { top: 0, right: 0, bottom: 0, left: 0 }), sh = sheetOf(rings), g = tilt.tiltGeo(desk, 26);
    for (const [x, y] of [[-sh.x, -sh.y], [sh.x, -sh.y], [sh.x, sh.y], [-sh.x, sh.y]]) { const p = g.toBox((x - v.x) * v.zoom + 720, (y - v.y) * v.zoom + 450); assert.ok(p.x > 0 && p.x < 1440 && p.y > 0 && p.y < 900, `${rings} rings: a corner of the sheet at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}`); }
  }
  m.rings = 3;
  // a wheel, a press and a key before the map has opened: nothing moves, and the opening is not called off
  const before = { ...m.view };
  page.listeners.wheel({ preventDefault() {}, deltaY: -300, clientX: 700, clientY: 400 });
  page.listeners.pointerdown({ pointerId: 1, clientX: 700, clientY: 400, timeStamp: 0 });
  page.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(m.view, before);
  assert.equal(m.cam.userMoved, false);
  assert.ok(opening.OPEN_WAIT_MS >= 10000, 'and the world is not shown instead after a few seconds of a slow connection');
  m.destroy();
});

test('the opening shows its first picture whole: the waiting picture stays, and the camera has not set off, while a part is still being made', () => {
  const page = livePage(desk);
  let src = { overviews: new Map(), ringsOpen: 3, own: [], open: { mode: 'play', ready: false, stage: 'none' } };
  const m = new fmap.FrontierMap(page.canvas, { source: () => src });
  const wait = page.order[0];
  m.draw(0);
  // the record answers: a village. Three squares of the first picture are still on their way
  src = { overviews: new Map(), ringsOpen: 3, own: [{ ...HOME }], open: { mode: 'play', ready: true, stage: 'final', active: 0 } };
  let pending = 3;
  const scene = m.paintScene.bind(m);
  m.paintScene = (...a) => ({ ...scene(...a), pending });
  m.draw(100);
  assert.ok(m.opened && m.openHold, 'the opening holds');
  assert.equal(wait.style.vars['--map-wait'], '1.000', 'the waiting picture covers the picture that is being made');
  assert.equal(m.cam.moving, true, 'the flight is ready');
  const start = { ...m.cam.drawn };
  m.frame(116); m.frame(132);
  assert.deepEqual(m.cam.drawn, start, 'and has not begun');
  assert.equal(wait.style.vars['--map-wait'], '1.000');
  // the last of it is made: the land comes out of the waiting picture, and the camera sets off
  pending = 0;
  m.frame(148);
  assert.equal(m.openHold, null);
  assert.equal(m.reveal, 148, 'the dissolve starts now, not when the record answered');
  m.frame(164); m.frame(300);
  const a = Number(wait.style.vars['--map-wait']);
  assert.ok(a > 0 && a < 1, `half way: ${a}`);
  assert.notDeepEqual(m.cam.drawn, start, 'the camera is on its way');
  assert.equal(page.dress.style.vars['--map-dusk'], '1.000', 'the dark above the horizon does not blink');
  m.frame(148 + fmap.REVEAL_MS + 20);
  assert.equal(wait.style.vars['--map-wait'], '0.000');
  assert.deepEqual([wait.kids[0].width, wait.kids[0].height], [0, 0], 'its pixels are let go');
  m.destroy();
  // a picture that never becomes whole is shown after OPEN_HOLD_MS all the same
  const p2 = livePage(desk);
  const m2 = new fmap.FrontierMap(p2.canvas, { source: () => src });
  const scene2 = m2.paintScene.bind(m2);
  m2.paintScene = (...a) => ({ ...scene2(...a), pending: 1 });
  m2.draw(0);
  assert.ok(m2.openHold);
  m2.draw(fmap.OPEN_HOLD_MS - 10);
  assert.ok(m2.openHold);
  m2.draw(fmap.OPEN_HOLD_MS + 10);
  assert.equal(m2.openHold, null);
  assert.ok(fmap.OPEN_HOLD_MS <= 2000);
  m2.destroy();
});

test('a square of the cloud sea that is not made yet shows the bank\'s soft body, from the first frame: never bare paper up to a straight edge', async () => {
  const sea = await import('../../permutation-server/web/frontier/map/cloudsea.mjs');
  const { landBox } = await import('../../permutation-server/web/frontier/map/camera.mjs');
  const s = new sea.CloudSea({});
  // what the kept pieces of one other fineness hold of a square
  s.pieces.set('a', { rings: 3, cv: {}, x: 0, y: 0, size: 1024 });
  s.pieces.set('b', { rings: 3, cv: {}, x: 1024, y: 0, size: 256 });
  assert.equal(s.covered(3, 0, 0, 512), true);
  assert.equal(s.covered(3, 512, 512, 512), true);
  assert.equal(s.covered(3, 1024, 0, 512), false, 'a quarter of it: not covered');
  assert.equal(s.covered(4, 0, 0, 512), false, 'another world\'s pieces do not count');
  assert.equal(s.covered(3, 4096, 0, 512), false);
  // the stand-in body: a coarse grid of the field, kept, drawn inside its square only
  let made = 0;
  const was = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { const cv = this; return { createImageData: (w, h) => { made++; return { data: new Uint8ClampedArray(w * h * 4) }; }, putImageData(img) { cv.img = img; } }; } };
  try {
    const sheet = sheetOf(3), land = landBox(3), calls = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, rect(...a) { calls.push(['rect', ...a]); }, clip() { calls.push(['clip']); }, drawImage(cv, ...a) { calls.push(['draw', cv, ...a]); } };
    const size = 512, x = Math.floor((land.x + 120) / size) * size, y = 0;
    assert.equal(s.rough(ctx, 3, x, y, size, sheet), true, 'out at sea: cloud');
    const draw = calls.find(c => c[0] === 'draw'), cv = draw[1], n = sea.ROUGH + 3;
    assert.deepEqual([cv.width, cv.height], [n, n]);
    assert.deepEqual(calls.find(c => c[0] === 'rect'), ['rect', x, y, size, size], 'clipped to its own square');
    assert.ok(draw[2] < x && draw[4] > size, 'the grid reaches past the square: its edge samples are whole');
    const alphas = [...cv.img.data].filter((_, i) => i % 4 === 3);
    assert.ok(Math.max(...alphas) > 150 && alphas.some(a => a > 0 && a < 240), 'a body with depth, not a flat fill');
    assert.equal(made, 1);
    assert.equal(s.rough(ctx, 3, x, y, size, sheet), true);
    assert.equal(made, 1, 'kept: worked out once');
    // deep in the land there is no cloud, and nothing is drawn
    calls.length = 0;
    assert.equal(s.rough(ctx, 3, -256, -256, size, sheet), false);
    assert.equal(calls.length, 0);
    assert.ok(n * n < 400, 'a few hundred samples');
    // a picture's paint says how many squares were shown that way
    assert.equal(new sea.CloudSea({}).paint(null, { box: { x0: 0, y0: 0, x1: 1, y1: 1 } }).rough, 0);
  } finally { globalThis.OffscreenCanvas = was; }
});
