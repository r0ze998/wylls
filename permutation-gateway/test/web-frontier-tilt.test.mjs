// The tabletop tilt (UX brief §4 and §11.1; permutation-server/web/frontier/map/tilt.mjs
// and the tilt side of fmap.mjs). The rule every test here leans on: the map
// knows in numbers what the one CSS transform of #map-stage does, so a point
// of the world and a point of the screen are told from each other without
// asking the browser: project and unproject are exact inverses, the four
// corners of the picture are the trapezoid the board shows, the ground canvas
// covers that trapezoid at every angle, and with no tilt everything is the
// flat map it always was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tilt from '../../permutation-server/web/frontier/map/tilt.mjs';
import * as fmap from '../../permutation-server/web/frontier/map/fmap.mjs';
import { edgePointer } from '../../permutation-server/web/frontier/map/homepointer.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { project } from '../../permutation-server/web/map.mjs';

const desk = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** What `transform: perspective(P) rotateX(deg)` about the middle of `size` does to a point of the plane, worked out as a browser does (4 × 4 matrices, then the divide). */
function css(size, deg, x, y, P = tilt.TILT.perspective) {
  const a = (deg * Math.PI) / 180, dx = x - size.width / 2, dy = y - size.height / 2;
  // rotateX: y' = y cos − z sin, z' = y sin + z cos (z = 0 on the plane); perspective: w = 1 − z' / P
  const y1 = dy * Math.cos(a), z1 = dy * Math.sin(a), w = 1 - z1 / P;
  return { x: size.width / 2 + dx / w, y: size.height / 2 + y1 / w };
}

test('?tilt= gives the angle, clamped to what the art allows; anything else says nothing', () => {
  assert.equal(tilt.tiltFromQuery('?tilt=12'), 12);
  assert.equal(tilt.tiltFromQuery('?art=1&tilt=16.5&x=2'), 16.5);
  assert.equal(tilt.tiltFromQuery('?tilt=0'), 0, 'the flat map is asked for by name');
  assert.equal(tilt.tiltFromQuery('?tilt=80'), tilt.TILT.max);
  assert.equal(tilt.tiltFromQuery('?tilt=-4'), 0);
  assert.equal(tilt.tiltFromQuery('?tilted=9'), null);
  assert.equal(tilt.tiltFromQuery(''), null);
  assert.equal(tilt.tiltFromQuery(undefined), null);
  assert.ok(tilt.TILT.deg >= 14 && tilt.TILT.deg <= 20, 'the constant is in the brief\'s range');
});

test('the angle follows the zoom: the chart lies flat, the diorama is tilted, and it never goes back on the way in', () => {
  assert.equal(tilt.tiltAt(0.05, { far: 0.26 }), 0);
  assert.equal(tilt.tiltAt(0.26, { far: 0.26 }), 0, 'flat at the far view');
  assert.equal(tilt.tiltAt(tilt.TILT_NEAR, { far: 0.26 }), tilt.TILT.deg);
  assert.equal(tilt.tiltAt(2.2, { far: 0.26 }), tilt.TILT.deg);
  let last = 0;
  for (let z = 0.1; z < 1.4; z += 0.01) { const d = tilt.tiltAt(z, { far: 0.26 }); assert.ok(d >= last - 1e-12 && d <= tilt.TILT.deg); last = d; }
  assert.equal(tilt.tiltAt(1.3, { deg: 0 }), 0, 'the flat fallback has no angle at any zoom');
  // a far view that is itself close up (a very small world) still leaves the board room to tilt
  assert.equal(tilt.tiltAt(0.45, { far: 0.9 }), 0);
  assert.equal(tilt.tiltAt(tilt.TILT_NEAR, { far: 0.9 }), tilt.TILT.deg);
});

test('the geometry is the CSS transform: stage to box as a browser works it out, and back', () => {
  for (const size of [desk, phone]) for (const deg of [6, 12, 16, 17, 20, 22]) {
    const g = tilt.tiltGeo(size, deg);
    for (const [x, y] of [[0, 0], [size.width, 0], [size.width, size.height], [0, size.height], [size.width / 2, size.height / 2], [123, 456], [size.width * 0.9, size.height * 0.1], [-200, -180], [size.width + 150, size.height + 90]]) {
      const b = g.toBox(x, y), want = css(size, deg, x, y);
      assert.ok(near(b.x, want.x, 1e-9) && near(b.y, want.y, 1e-9), `${deg}°: (${x}, ${y}) is seen where CSS puts it`);
      const s = g.toStage(b.x, b.y);
      assert.ok(near(s.x, x, 1e-7) && near(s.y, y, 1e-7), `${deg}°: the round trip of (${x}, ${y})`);
    }
    // the middle does not move; what is above it is further away and smaller, what is below nearer and larger
    assert.deepEqual(g.toBox(size.width / 2, size.height / 2), { x: size.width / 2, y: size.height / 2 });
    assert.ok(g.scaleAt(0) < 1 && g.scaleAt(size.height) > 1 && near(g.scaleAt(size.height / 2), 1));
    assert.ok(g.scaleAt(0) < g.scaleAt(size.height * 0.25));
  }
});

test('the four corners of the picture are a trapezoid of the stage: wider and further at the top', () => {
  const g = tilt.tiltGeo(desk, 17), q = g.quad();
  // each corner of the quad is seen exactly at a corner of the box
  const corners = [[0, 0], [desk.width, 0], [desk.width, desk.height], [0, desk.height]];
  q.forEach((p, i) => { const b = g.toBox(p.x, p.y); assert.ok(near(b.x, corners[i][0], 1e-7) && near(b.y, corners[i][1], 1e-7), `corner ${i}`); });
  assert.ok(q[0].y < 0 && q[1].y < 0, 'the far edge lies above the box');
  assert.ok(q[0].x < 0 && q[1].x > desk.width, 'and is wider than it');
  assert.ok(q[2].y <= desk.height + 1e-9 && q[3].y <= desk.height + 1e-9, 'the near edge is inside it');
  assert.ok(q[1].x - q[0].x > q[2].x - q[3].x, 'more of the world along the far edge than along the near one');
  assert.ok(near(q[0].y, q[1].y) && near(q[3].y, q[2].y) && near(q[0].x + q[1].x, desk.width) && near(q[3].x + q[2].x, desk.width), 'symmetric about the middle');
});

test('no tilt is the flat map: the same numbers in and out', () => {
  const g = tilt.tiltGeo(desk, 0);
  assert.equal(g.flat, true);
  assert.deepEqual(g.toBox(17, 29), { x: 17, y: 29 });
  assert.deepEqual(g.toStage(17, 29), { x: 17, y: 29 });
  assert.equal(g.scaleAt(5), 1);
  assert.deepEqual(g.quad(), [{ x: 0, y: 0 }, { x: 1440, y: 0 }, { x: 1440, y: 900 }, { x: 0, y: 900 }]);
  assert.deepEqual(tilt.overscan(desk, 0), { left: 0, top: 0, right: 0, bottom: 0 });
  assert.deepEqual(tilt.groundBox(desk, 0), { left: 0, top: 0, width: 1440, height: 900, dx: 0, dy: 0 });
  assert.deepEqual(tilt.groundView({ x: 5, y: 6, zoom: 1.3 }, tilt.groundBox(desk, 0)), { x: 5, y: 6, zoom: 1.3 });
});

test('the ground canvas covers the trapezoid at every angle up to its own, and its flat view is the map\'s', () => {
  for (const size of [desk, phone, { width: 2560, height: 1300 }, { width: 800, height: 380 }]) {
    const box = tilt.groundBox(size, 17);
    for (const deg of [0, 4, 9, 13, 17]) for (const p of tilt.tiltGeo(size, deg).quad()) {
      assert.ok(p.x >= box.left && p.x <= box.left + box.width && p.y >= box.top && p.y <= box.top + box.height, `${size.width}x${size.height} at ${deg}°: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) is on the canvas`);
    }
    // not wastefully: under a fifth more pixels than the box at the brief's sizes
    if (size === desk || size === phone) assert.ok((box.width * box.height) / (size.width * size.height) < 1.26, `${size.width}: ${(box.width * box.height / (size.width * size.height)).toFixed(3)} of the box`);
    // a world point's place on the ground canvas, by the canvas's own flat view, is its stage point less the canvas's corner
    const view = { x: 812.5, y: -340.25, zoom: 1.3 }, gv = tilt.groundView(view, box), w = { x: 600, y: -700 };
    const stage = fmap.worldToScreen(view, size, w.x, w.y), onCanvas = fmap.worldToScreen(gv, { width: box.width, height: box.height }, w.x, w.y);
    assert.ok(near(onCanvas.x, stage.x - box.left, 1e-9) && near(onCanvas.y, stage.y - box.top, 1e-9));
  }
});

test('culling by the trapezoid: a place in the canvas\'s unseen corner is not in the picture', () => {
  const q = [{ x: -70, y: -70 }, { x: 1510, y: -70 }, { x: 1440, y: 900 }, { x: 0, y: 900 }];
  assert.equal(tilt.nearQuad(q, 720, 400), true);
  assert.equal(tilt.nearQuad(q, -60, 800), false, 'left of the slanted side, near the bottom');
  assert.equal(tilt.nearQuad(q, -60, 800, 80), true, 'unless its own reach comes into view');
  assert.equal(tilt.nearQuad(q, -60, -60), true, 'the far corners are seen');
  assert.equal(tilt.nearQuad(null, 1e6, 1e6), true, 'no quad: no opinion');
  // the same test whichever way round the corners are given
  assert.equal(tilt.nearQuad([...q].reverse(), -60, 800), false);
  // on the map: the provinces of a tilted picture are those of the flat canvas less the ones in its corners
  const view = { x: 0, y: 0, zoom: 0.5 }, size = { width: 1600, height: 1000 };
  const all = fmap.visibleProvinces(view, size, 4);
  const cut = fmap.visibleProvinces(view, size, 4, [{ x: -1600, y: -1000 }, { x: 1600, y: -1000 }, { x: 400, y: 1000 }, { x: -400, y: 1000 }]);
  assert.ok(cut.length > 0 && cut.length < all.length);
  assert.ok(cut.every(c => all.some(a => a.p === c.p && a.q === c.q)));
  assert.deepEqual(fmap.visibleProvinces(view, size, 4, null), all);
});

test('upright: on the label canvas a painter\'s anchor lands where the board shows it, at the map\'s zoom; elsewhere it just draws', () => {
  const calls = [];
  const ctx = { save: () => calls.push(['save']), restore: () => calls.push(['restore']), setTransform: (...m) => calls.push(['set', ...m]) };
  // not armed: the painter runs under whatever transform the context has
  assert.equal(tilt.upright(ctx, 10, 20, () => 'drawn'), 'drawn');
  assert.deepEqual(calls, []);
  assert.equal(tilt.upright(null, 1, 2, () => 7), 7);
  assert.equal(tilt.isUpright(ctx), false);
  tilt.armUpright(ctx, { place: (x, y) => ({ x: x / 2 + 100, y: y / 2 + 50 }), zoom: 1.3, ratio: 2 });
  assert.equal(tilt.isUpright(ctx), true);
  let inside = null;
  assert.equal(tilt.upright(ctx, 400, 200, () => { inside = calls.length; return 'up'; }), 'up');
  assert.equal(calls[0][0], 'save');
  const [, a, b, c, d, e, f] = calls[1];
  assert.deepEqual([a, b, c, d], [2.6, 0, 0, 2.6], 'the zoom times the pixel ratio, and nothing else: no squash, no shear');
  // the anchor itself: world (400, 200) through this transform is place(400, 200) in device px
  assert.ok(near(a * 400 + e, 2 * 300) && near(d * 200 + f, 2 * 150));
  assert.equal(inside, 2, 'the painter ran between the transform and the restore');
  assert.equal(calls[2][0], 'restore');
  tilt.disarmUpright(ctx);
  assert.equal(tilt.isUpright(ctx), false);
  // a recorder that answers every name with a function is not mistaken for an armed context
  const proxy = new Proxy({}, { get: () => () => {} });
  let ran = false;
  tilt.upright(proxy, 1, 2, () => { ran = true; });
  assert.equal(ran, true);
});

// ------------------------------------------------------------------ the map itself, with a stage
/** A canvas inside a page that has the tilted stage (the three pages do); `at` is its corner in the viewport. */
function staged(size, { at = { left: 0, top: 0 } } = {}) {
  const style = () => { const vars = {}; return { vars, setProperty: (k, v) => { vars[k] = v; } }; };
  const stage = { dataset: {}, style: style() }, ground = { style: style(), getContext: () => null, width: 0, height: 0 }, dress = { style: style() };
  const canvas = { clientWidth: size.width, clientHeight: size.height, dataset: {}, getBoundingClientRect: () => ({ left: at.left, top: at.top, width: size.width, height: size.height }),
    ownerDocument: { getElementById: id => ({ 'map-stage': stage, 'map-ground': ground, 'map-dress': dress })[id] ?? null } };
  return { canvas, stage, ground, dress };
}
const HOME = { p: 2, q: 0, tile: 7 };
const homePoint = (() => { const h = tileHex(HOME.p, HOME.q, HOME.tile); return project(h.q, h.r); })();
function mapOn(size, opts = {}, extra = {}) {
  const page = staged(size, opts);
  const m = new fmap.FrontierMap(page.canvas, { source: () => ({ overviews: new Map(), ringsOpen: 3, own: [{ ...HOME }], open: { ready: true, active: 0 } }), ...extra });
  m.cam.reduced = () => true;   // every move is a jump: the picture is where the camera is
  return { m, ...page };
}

test('a page without the stage is the flat map: no angle, the ground is the canvas itself', () => {
  const m = new fmap.FrontierMap({ clientWidth: 800, clientHeight: 600 }, { source: () => ({ overviews: new Map(), ringsOpen: 3 }) });
  assert.equal(m.stage, null);
  assert.equal(m.ground, m.canvas);
  assert.equal(m.tiltMax, 0);
  assert.equal(m.tiltDeg(1.3), 0);
  m.setView({ x: 100, y: 50, zoom: 1.3 });
  assert.deepEqual(m.project(100, 50), { x: 400, y: 300 });
  assert.deepEqual(m.unproject(400, 300), { x: 100, y: 50 });
  assert.deepEqual(m.groundSize(), { width: 800, height: 600 });
  assert.deepEqual(m.groundView(), m.shown);
});

test('map.project and map.unproject: exact inverses in client px, at every zoom, with the map anywhere on the page', () => {
  for (const size of [desk, phone]) {
    const { m, canvas } = mapOn(size, { at: { left: 30, top: 48 } });
    assert.equal(m.tiltMax, tilt.TILT.deg);
    for (const zoom of [0.2, 0.33, 0.5, 0.8, 1.3, 2.1]) {
      m.setView({ x: homePoint.x + 40, y: homePoint.y - 25, zoom });
      const z = m.view.zoom;
      // the middle of the box is the view's own point, whatever the angle
      const mid = m.project(m.view.x, m.view.y);
      assert.ok(near(mid.x, 30 + size.width / 2, 1e-9) && near(mid.y, 48 + size.height / 2, 1e-9), `zoom ${z}: the middle`);
      for (const [dx, dy] of [[0, 0], [300, -200], [-500, 260], [77, 311], [-640, -400]]) {
        const w = { x: m.view.x + dx / z, y: m.view.y + dy / z }, c = m.project(w.x, w.y), back = m.unproject(c.x, c.y);
        assert.ok(near(back.x, w.x, 1e-6) && near(back.y, w.y, 1e-6), `zoom ${z}: round trip of a point ${dx}, ${dy} px from the middle`);
        const b = m.project(w.x, w.y, { box: true });
        assert.ok(near(b.x, c.x - 30, 1e-9) && near(b.y, c.y - 48, 1e-9), 'box px are client px less the map\'s corner');
      }
      // the four corners of the box are the four corners of the world in the picture
      const quad = m.viewQuad(), corners = [[0, 0], [size.width, 0], [size.width, size.height], [0, size.height]];
      quad.forEach((w, i) => { const c = m.project(w.x, w.y, { box: true }); assert.ok(near(c.x, corners[i][0], 1e-6) && near(c.y, corners[i][1], 1e-6), `zoom ${z}: corner ${i}`); });
      const u = m.unproject(30, 48);
      assert.ok(near(u.x, quad[0].x, 1e-6) && near(u.y, quad[0].y, 1e-6));
    }
    void canvas;
  }
});

test('the board is tilted close up and flat at the far view; ?tilt=0 is flat everywhere', () => {
  const { m, stage } = mapOn(desk);
  const far = m.farView().zoom;
  assert.equal(m.tiltDeg(far), 0, 'the chart lies flat');
  assert.equal(m.tiltDeg(m.zoomMin()), 0);
  assert.equal(m.tiltDeg(1.3), tilt.TILT.deg);
  assert.ok(m.tiltDeg(0.45) > 0 && m.tiltDeg(0.45) < tilt.TILT.deg, 'between them it eases');
  assert.equal('flat' in stage.dataset, false);
  // tilted: the far tiles are smaller. The same distance on the ground is shorter on screen above the middle than below
  m.setView({ x: 0, y: 0, zoom: 1.3 });
  const span = y => m.project(60, y).x - m.project(-60, y).x;
  assert.ok(span(-250) < span(0) && span(0) < span(250));
  const flat = mapOn(desk, {}, { tilt: 0 });
  assert.equal(flat.m.tiltMax, 0);
  assert.equal(flat.m.tiltDeg(1.3), 0);
  assert.equal('flat' in flat.stage.dataset, true, 'the stage drops its transform');
  flat.m.setView({ x: 0, y: 0, zoom: 1.3 });
  assert.deepEqual(flat.m.project(100, -100, { box: true }), { x: 720 + 130, y: 450 - 130 });
  assert.deepEqual(flat.m.groundSize(), desk, 'no overscan without a tilt');
  // an angle given by hand is kept inside what the art allows
  assert.equal(mapOn(desk, {}, { tilt: 40 }).m.tiltMax, tilt.TILT.max);
});

test('the ground canvas is told its place in the stage through custom properties, once per size', () => {
  const { m, ground } = mapOn(desk);
  const g = m.groundLayout();
  assert.ok(g.left < 0 && g.top < 0 && g.width > desk.width && g.height > desk.height);
  assert.deepEqual(ground.style.vars, { '--map-gl': `${g.left}px`, '--map-gt': `${g.top}px`, '--map-gw': `${g.width}px`, '--map-gh': `${g.height}px` });
  assert.equal(m.groundLayout(), g, 'kept');
  // a canvas laid over it shows a world point by its own flat view where the stage has it
  m.setView({ x: 500, y: -300, zoom: 1.3 });
  const gv = m.groundView(), gs = m.groundSize(), w = { x: 420, y: -610 };
  const on = fmap.worldToScreen(gv, gs, w.x, w.y), st = fmap.worldToScreen(m.shown, desk, w.x, w.y);
  assert.ok(near(on.x + g.left, st.x, 1e-9) && near(on.y + g.top, st.y, 1e-9));
});

test('zooming about a point keeps that point of the world under the pointer although the board\'s angle changes', () => {
  const { m } = mapOn(desk);
  // (from the middle of the world, so that the camera's own limits stay out of it)
  m.setView({ x: 0, y: 0, zoom: 0.3 });
  const at = { x: 860, y: 330 };   // px from the map's corner, away from the middle (near enough that the pan's limit stays out of it too)
  let turned = 0;
  for (const factor of [1.25, 1.6, 2, 0.8, 1.5]) {
    const before = m.unproject(at.x, at.y, { box: true, logical: true }), was = m.tiltDeg(m.view.zoom);
    m.zoomAt(factor, at.x, at.y);
    if (Math.abs(m.tiltDeg(m.view.zoom) - was) > 1) turned++;
    const seen = m.project(before.x, before.y, { box: true, logical: true });
    assert.ok(near(seen.x, at.x, 1e-6) && near(seen.y, at.y, 1e-6), `x${factor}: still under the pointer (the angle went from ${was.toFixed(1)} to ${m.tiltDeg(m.view.zoom).toFixed(1)})`);
  }
  assert.ok(turned >= 2, 'the board did turn on the way');
});

test('a fly puts the place in the middle of what the HUD leaves free, as it is seen', () => {
  const inset = { top: 48, right: 0, bottom: 320, left: 0 };
  const { m } = mapOn(phone, {}, { insets: () => inset });
  m.flyTo({ ...HOME, zoom: 1.2 });
  const c = m.project(homePoint.x, homePoint.y, { box: true, logical: true });
  assert.ok(near(c.x, phone.width / 2, 1e-6) && near(c.y, 48 + (phone.height - 48 - 320) / 2, 1e-6), `the village is seen at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}`);
  // home, pressed while there: the village stays in the middle of the free part (closer, at the hero zoom)
  m.home();
  const d = m.project(homePoint.x, homePoint.y, { box: true, logical: true });
  assert.ok(near(d.x, phone.width / 2, 1e-6) && near(d.y, 48 + (phone.height - 48 - 320) / 2, 1e-6));
  assert.ok(m.view.zoom >= 1.2);
});

test('the pointer home: under a tilt it judges by where home is seen', () => {
  const g = tilt.tiltGeo(desk, 17), view = { x: 0, y: 0, zoom: 1.3 };
  // a home whose flat place is just above the top edge of the box, but which the tilted board shows inside it
  const y = -(desk.height / 2 + 20) / view.zoom, home = { x: 0, y };
  assert.ok(g.toBox(720, 450 + y * view.zoom).y > 6, 'seen inside the picture');
  assert.notEqual(edgePointer(view, desk, home), null, 'flat: off the top');
  assert.equal(edgePointer(view, desk, home, { geo: g }), null, 'tilted: in the picture, no pointer');
  const far = edgePointer(view, desk, { x: 4000, y: -200 }, { geo: g });
  assert.ok(far && far.x > desk.width / 2 && far.tiles > 0);
});
