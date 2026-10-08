// The map's camera and opening view (UX brief §4;
// permutation-server/web/frontier/map/{camera,opening,dressing,probe}.mjs and
// the camera side of fmap.mjs). The rule every test here leans on: the
// LOGICAL view changes at once, the DRAWN view travels to it; reduced motion
// jumps. Then: where the map opens for each kind of viewer, home and the
// world chart, the limits, the phone sheet, and the small helpers of the
// depth dressing, the far bitmaps and the frame probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cam from '../../permutation-server/web/frontier/map/camera.mjs';
import * as opening from '../../permutation-server/web/frontier/map/opening.mjs';
import * as fmap from '../../permutation-server/web/frontier/map/fmap.mjs';
import * as layers from '../../permutation-server/web/frontier/map/layers.mjs';
import { nearness, paintDressing } from '../../permutation-server/web/frontier/map/dressing.mjs';
import { PROBE } from '../../permutation-server/web/frontier/map/probe.mjs';
import { FAR_RES, farRes, farSoftness } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { tileHex, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { project, RADIUS } from '../../permutation-server/web/map.mjs';

const size = { width: 1000, height: 800 };
const phone = { width: 390, height: 734 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const tilePoint = (p, q, i) => { const h = tileHex(p, q, i); return project(h.q, h.r); };
/** A camera that always animates (no media query in node, but be explicit). */
const camera = (view, extra = {}) => new cam.Camera({ view, reduced: () => false, ...extra });

test('the logical view changes at once; the drawn view travels there and arrives', () => {
  const c = camera({ x: 0, y: 0, zoom: 0.1 });
  c.set({ x: 500, y: -200, zoom: 1.3 }, { ms: 1000, kind: 'fly' });
  assert.deepEqual(c.view, { x: 500, y: -200, zoom: 1.3 }, 'where the camera is going, now');
  assert.deepEqual(c.drawn, { x: 0, y: 0, zoom: 0.1 }, 'the picture has not moved yet');
  assert.equal(c.moving, true);
  assert.equal(c.step(1000), true, 'the first frame starts the clock');
  let last = c.drawn.zoom, frames = 0;
  for (let t = 1016; c.moving && frames < 200; t += 16) {
    c.step(t); frames++;
    assert.ok(c.drawn.zoom >= last - 1e-12, 'a descent only descends');
    last = c.drawn.zoom;
  }
  assert.ok(frames > 30 && frames < 70, `${frames} frames for a 1000 ms move`);
  assert.deepEqual(c.drawn, c.view, 'arrived exactly');
  assert.equal(c.step(9999), false, 'nothing left to do: no more redraws');
});

test('a slow frame slows a move instead of skipping it; a frozen clock still animates', () => {
  const c = camera({ x: 0, y: 0, zoom: 1 });
  c.set({ x: 1000 }, { ms: 400, ease: cam.EASE.linear });
  c.step(0);
  c.step(5000);   // one frame five seconds late
  assert.ok(c.moving && c.drawn.x < 200, `after one late frame the picture is at ${c.drawn.x}`);
  const f = camera({ x: 0, y: 0, zoom: 1 });
  f.set({ x: 100 }, { ms: 200 });
  for (let i = 0; i < 40 && f.moving; i++) f.step(777);   // performance.now() never advances
  assert.equal(f.moving, false, 'frame by frame, it arrives');
  assert.equal(f.drawn.x, 100);
});

test('reduced motion: no travel, every move is a jump', () => {
  const c = new cam.Camera({ view: { x: 0, y: 0, zoom: 0.1 }, reduced: () => true });
  c.set({ x: 500, y: 100, zoom: 1.3 }, { ms: 1400, kind: 'fly' });
  assert.deepEqual(c.drawn, c.view);
  assert.equal(c.moving, false);
  c.from({ zoom: 0.5 }, { ms: 1400 });
  assert.equal(c.drawn.zoom, 1.3, 'no start from above either');
  assert.equal(c.fling(2, 0), false, 'no glide');
  assert.equal(cam.reducedMotion(), false, 'no window here: guarded, and motion is allowed');
});

test('a finger stops a move where the picture is; keys and buttons add up on the logical view', () => {
  const c = camera({ x: 0, y: 0, zoom: 1 });
  c.set({ x: 800 }, { ms: 800, ease: cam.EASE.linear });
  c.step(0); c.step(16); c.step(32); c.step(48);
  const mid = c.drawn.x;
  assert.ok(mid > 0 && mid < 800);
  assert.equal(c.halt(), true);
  assert.equal(c.view.x, mid, 'the logical view is where the picture stopped');
  assert.equal(c.moving, false);
  assert.equal(c.halt(), false, 'nothing to stop');
  // two key presses while the first is still easing: 80 + 80, whatever the picture is doing
  c.set({ x: c.view.x + 80 }, { ms: 150 });
  c.step(100);
  c.set({ x: c.view.x + 80 }, { ms: 150 });
  assert.equal(c.view.x, mid + 160);
  for (let t = 116; c.moving; t += 16) c.step(t);
  assert.equal(c.drawn.x, mid + 160);
});

test('a zoom about the pointer keeps the point under the pointer all the way; a fly keeps its target in the picture', () => {
  const from = { x: 100, y: 50, zoom: 0.5 };
  const to = fmap.zoomAround(from, size, 2, 700, 250);
  const anchor = { x: 700 - size.width / 2, y: 250 - size.height / 2 };
  const under = v => fmap.screenToWorld(v, size, 700, 250);
  const w0 = under(from);
  for (const e of [0.1, 0.33, 0.5, 0.8, 0.97]) {
    const v = cam.between(from, to, e, 'anchor', anchor), w = under(v);
    assert.ok(near(w.x, w0.x, 1e-6) && near(w.y, w0.y, 1e-6), `e=${e}`);
    assert.ok(v.zoom > from.zoom && v.zoom < to.zoom);
  }
  // a descent from the world view to a village: the village is on screen from the first frame to the last
  const high = { x: 0, y: 0, zoom: 0.1 }, home = { x: 876, y: -351, zoom: 1.3 };
  assert.deepEqual(cam.between(high, home, 0, 'fly'), high);
  assert.deepEqual(cam.between(high, home, 1, 'fly'), home);
  let prev = Infinity;
  for (const e of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const v = cam.between(high, home, e, 'fly'), s = fmap.worldToScreen(v, size, home.x, home.y);
    assert.ok(s.x >= 0 && s.x <= size.width && s.y >= 0 && s.y <= size.height, `e=${e}: the target is in the picture`);
    const d = Math.hypot(s.x - size.width / 2, s.y - size.height / 2);
    assert.ok(d < prev, 'and it glides toward the middle');
    prev = d;
  }
  // a climb back out keeps where it left in the picture
  for (const e of [0.25, 0.5, 0.75]) {
    const v = cam.between(home, high, e, 'fly'), s = fmap.worldToScreen(v, size, home.x, home.y);
    assert.ok(s.x >= 0 && s.x <= size.width && s.y >= 0 && s.y <= size.height, `climb e=${e}`);
  }
});

test('the glide after a drag: the logical view is where it will end; too slow a release does not glide', () => {
  const c = camera({ x: 0, y: 0, zoom: 2 });
  assert.equal(c.fling(0.05, 0), false, `slower than ${cam.FLING_MIN} px/ms`);
  assert.equal(c.fling(1, -0.5), true);
  assert.ok(near(c.view.x, -(1 * cam.FLING_TAU) / 2) && near(c.view.y, (0.5 * cam.FLING_TAU) / 2), 'release speed × time constant, in world px');
  c.step(0);
  let px = 0, speed = Infinity, frames = 0;
  for (let t = 16; c.moving && frames < 400; t += 16) {
    c.step(t); frames++;
    const d = Math.abs(c.drawn.x - px);
    assert.ok(d <= speed + 0.11, 'it only slows down (the last fifth of a screen pixel is snapped)');
    speed = d; px = c.drawn.x;
  }
  assert.deepEqual(c.drawn, c.view);
  assert.ok(frames <= Math.ceil((cam.FLING_TAU * 6) / 16) + 1, `over within six time constants (${frames} frames)`);
  // a short glide ends early: its long tail is cut once nothing moves on screen
  const b = camera({ x: 0, y: 0, zoom: 1 });
  b.fling(cam.FLING_MIN, 0);
  b.step(0);
  let n = 0;
  for (let t = 16; b.moving && n < 400; t += 16) { b.step(t); n++; }
  assert.ok(n < frames, `${n} frames for a short glide`);
});

test('the pan is kept over the opened world plus a margin: softly during a drag, firmly after it', () => {
  const R = cam.worldRadius(3);
  assert.ok(near(R, Math.hypot(layers.provincePixel(3, 0).x, layers.provincePixel(3, 0).y) + layers.PROVINCE_CIRCUMRADIUS));
  const inside = { x: 800, y: -300, zoom: 1.3 };
  assert.equal(cam.clampCentre(inside, { ringsOpen: 3, size }), inside, 'inside: untouched');
  const out = { x: 40_000, y: 0, zoom: 1.3 };
  const hard = cam.clampCentre(out, { ringsOpen: 3, size });
  assert.ok(hard.x < R + layers.PROVINCE_CIRCUMRADIUS && hard.x > R * 0.8, `the centre stops near the rim (${hard.x} of ${R})`);
  assert.equal(hard.zoom, 1.3);
  const soft = cam.clampCentre(out, { ringsOpen: 3, size, soft: 1 });
  assert.ok(soft.x > hard.x && soft.x < hard.x * 1.6, 'a drag gives, within reason');
  const a = cam.clampCentre({ x: hard.x + 30, y: 0, zoom: 1.3 }, { ringsOpen: 3, size, soft: 1 });
  const b = cam.clampCentre({ x: hard.x + 300, y: 0, zoom: 1.3 }, { ringsOpen: 3, size, soft: 1 });
  assert.ok(b.x > a.x && b.x - a.x < 270, 'the further the pull, the stiffer');
  // zoomed out to the far view the world stays near the middle
  const far = cam.fitView(3, size);
  const wide = cam.clampCentre({ x: 40_000, y: 0, zoom: far.zoom }, { ringsOpen: 3, size });
  assert.ok(wide.x < R * 0.4, `at the far view the centre may leave the middle by ${Math.round(wide.x)} of ${Math.round(R)} only`);
  // more open rings, more room
  assert.ok(cam.clampCentre(out, { ringsOpen: 6, size }).x > hard.x);
});

test('the uncovered part of the canvas: the far view fits it, a place is centred in it', () => {
  const sheet = { top: 0, right: 0, bottom: 367, left: 0 };
  const free = cam.freeBox(phone, sheet);
  assert.deepEqual([free.width, free.height], [390, 367]);
  assert.ok(near(free.y, 367 / 2 - 734 / 2), 'its middle is above the canvas centre');
  const pt = { x: 876, y: -351 };
  const v = cam.centreOn(pt, 1.3, phone, sheet);
  const s = fmap.worldToScreen(v, phone, pt.x, pt.y);
  assert.ok(near(s.x, 195) && near(s.y, 367 / 2), `the place lands at ${s.x},${s.y}: the middle of the part above the sheet`);
  const f = cam.focusOf(v, phone, sheet);
  assert.ok(near(f.x, pt.x) && near(f.y, pt.y), 'focusOf is the inverse');
  // a full sheet never pushes the map off the screen: at least 40% of the height counts as free
  assert.equal(cam.freeBox(phone, { bottom: 720 }).height, 734 * 0.4);
  // the far view: the opened world in the smaller side of the free part, lifted above the sheet
  const far = cam.fitView(3, phone, { inset: sheet, cap: 0.114 });
  assert.ok(near(far.zoom, (0.9 * 367) / (2 * cam.worldRadius(3))));
  const centre = fmap.worldToScreen(far, phone, 0, 0);
  assert.ok(near(centre.y, 367 / 2), 'the Concord in the middle of the free part');
  assert.equal(cam.fitView(1, { width: 2000, height: 2000 }, { cap: 0.114 }).zoom, 0.114, 'never nearer than the cap');
  // a drawer over the map's right side on a wide screen
  const d = cam.freeBox(size, { right: 360 });
  assert.deepEqual([d.width, d.x], [640, -180]);
});

test('what the page\'s panel covers: a bottom sheet from below, a drawer from the side, a column beside the map nothing', () => {
  const page = (panel, position) => {
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 60, right: 390, bottom: 794, width: 390, height: 734 }) };
    canvas.ownerDocument = { getElementById: id => (id === 'panel' ? { getBoundingClientRect: () => panel } : null), defaultView: { getComputedStyle: () => ({ position }) } };
    return canvas;
  };
  assert.deepEqual(fmap.coveredInsets({}), { top: 0, right: 0, bottom: 0, left: 0 }, 'no page');
  const sheet = page({ left: 0, top: 427, right: 390, bottom: 794, width: 390, height: 367 }, 'absolute');
  assert.deepEqual(fmap.coveredInsets(sheet), { top: 0, right: 0, bottom: 367, left: 0 });
  assert.equal(fmap.coveredBelow(sheet), 367);
  assert.equal(fmap.coveredBelow(page({ left: 0, top: 427, right: 390, bottom: 794, width: 390, height: 367 }, 'static')), 0, 'a panel in the flow covers nothing');
  const wide = { getBoundingClientRect: () => ({ left: 0, top: 52, right: 1440, bottom: 900, width: 1440, height: 848 }) };
  wide.ownerDocument = { getElementById: () => ({ getBoundingClientRect: () => ({ left: 1080, top: 52, right: 1440, bottom: 900, width: 360, height: 848 }) }), defaultView: { getComputedStyle: () => ({ position: 'absolute' }) } };
  assert.deepEqual(fmap.coveredInsets(wide), { top: 0, right: 360, bottom: 0, left: 0 }, 'a drawer over the right side');
});

test('the opening view depends on who is looking: village, candidate sites, home wedge, or the world', () => {
  const src = { ringsOpen: 3, own: [] };
  // not joined, a watcher, practice: the open rings, as before
  for (const hint of [undefined, opening.openHint({ mode: 'spectate' }), opening.openHint({ mode: 'practice' }), opening.openHint({ mode: 'play', land: { stage: 'none' } })]) {
    const p = opening.openingPlan(hint, src, size);
    assert.equal(p.kind, 'fit');
    assert.deepEqual([p.view.x, p.view.y], [0, 0]);
    assert.ok(p.view.zoom < fmap.LOD_EDGES.provinceOut, 'world LOD');
  }
  // the play page before the viewer's record answered: no plan yet (the map waits; never the world first)
  assert.equal(opening.openHint({ mode: 'play' }).ready, false);
  assert.equal(opening.openingPlan(opening.openHint({ mode: 'play' }), src, size), null);
  assert.equal(opening.openHint({ mode: 'play' }, { ready: true }).ready, true, 'the page says when nobody is coming');
  // joined, no land: the home wedge of the nation, whole, in the picture
  const joined = opening.openHint({ mode: 'play', land: { stage: 'joined' }, citizen: { faction: 2 } });
  const w = opening.openingPlan(joined, src, size);
  assert.equal(w.kind, 'wedge');
  const box = opening.wedgeBox(2, 3);
  const tl = fmap.worldToScreen(w.view, size, box.x - box.width / 2, box.y - box.height / 2), br = fmap.worldToScreen(w.view, size, box.x + box.width / 2, box.y + box.height / 2);
  assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= size.width && br.y <= size.height, 'the whole wedge fits');
  assert.equal(wedgeOf(...Object.values(fmap.pick(w.view, size, size.width / 2, size.height / 2)).slice(2, 4)), 2, 'and its middle is in wedge 2');
  // a ticket: the first candidate's province, at tile detail
  const ticket = opening.openHint({ mode: 'play', land: { stage: 'ticket', ticket: { sites: [{ p: 2, q: 0, site: 3 }, { p: 1, q: 1, site: 0 }] } }, citizen: { faction: 0 } });
  const cnd = opening.openingPlan(ticket, src, size);
  assert.equal(cnd.kind, 'candidates');
  assert.deepEqual([cnd.view.x, cnd.view.y], [layers.provincePixel(2, 0).x, layers.provincePixel(2, 0).y]);
  assert.ok(cnd.view.zoom >= fmap.LOD_EDGES.tileIn && cnd.view.zoom <= opening.heroZoom(1), 'its tiles are drawn');
  // a village: its tile at the hero zoom; the active village when there are several
  const own = [{ p: 2, q: 0, tile: 7 }, { p: 1, q: 1, tile: 30 }];
  const lord = opening.openHint({ mode: 'play', land: { stage: 'final' }, citizen: { faction: 0 }, activeHolding: 1 });
  const h = opening.openingPlan(lord, { ...src, own }, size, { dpr: 2 });
  assert.equal(h.kind, 'home');
  assert.equal(h.view.zoom, opening.heroZoom(2));
  assert.deepEqual([h.view.x, h.view.y], [tilePoint(1, 1, 30).x, tilePoint(1, 1, 30).y], 'the active village');
  assert.ok(opening.heroZoom(2) <= opening.heroZoom(1) && opening.heroZoom(2) * RADIUS >= 52, 'the dense-screen hero zoom keeps every village\'s name tag');
  assert.ok(h.rank > cnd.rank && cnd.rank > w.rank && w.rank > opening.openingPlan(undefined, src, size).rank, 'village > candidates > wedge > world');
  // on a phone: in the part of the map above the sheet
  const sheet = { bottom: 367 };
  const m = opening.openingPlan(lord, { ...src, own: own.slice(0, 1) }, phone, { inset: sheet });
  const s = fmap.worldToScreen(m.view, phone, tilePoint(2, 0, 7).x, tilePoint(2, 0, 7).y);
  assert.ok(near(s.x, 195) && near(s.y, 367 / 2));
});

const canvas = (w = 1000, h = 800) => ({ clientWidth: w, clientHeight: h });
const lordSrc = { overviews: new Map(), ringsOpen: 3, own: [{ p: 2, q: 0, tile: 7 }, { p: 1, q: 1, tile: 30 }], open: opening.openHint({ mode: 'play', land: { stage: 'final' }, citizen: { faction: 0 } }) };

test('the map opens once the viewer is known, upgrades when a village lands, and never overrides a moved camera', () => {
  let src = { overviews: new Map(), ringsOpen: 3, own: [], open: opening.openHint({ mode: 'play' }) };
  const seen = [];
  const m = new fmap.FrontierMap(canvas(), { source: () => src, onView: (v, lod) => seen.push(lod) });
  assert.equal(m.open(src, size, { dpr: 1, now: 0 }), false, 'the viewer is not known: wait');
  assert.equal(m.open(src, size, { dpr: 1, now: opening.OPEN_WAIT_MS - 1 }), false);
  assert.deepEqual(seen, [], 'no view was placed while waiting');
  // joined, no land: the wedge
  src = { ...src, open: opening.openHint({ mode: 'play', land: { stage: 'joined' }, citizen: { faction: 0 } }) };
  assert.equal(m.open(src, size, { dpr: 1, now: 500 }), true);
  assert.equal(m.opened.kind, 'wedge');
  const wedge = { ...m.view };
  assert.equal(m.open(src, size, { dpr: 1, now: 600 }), true);
  assert.deepEqual(m.view, wedge, 'the same answer places nothing again');
  // the village lands: fly from where the picture is to the village (the logical view is there at once)
  m.cam.finish();
  src = { ...lordSrc };
  m.open(src, size, { dpr: 1, now: 5000 });
  assert.equal(m.opened.kind, 'home');
  assert.equal(m.lod, 'tile');
  assert.deepEqual([m.view.x, m.view.y, m.view.zoom], [tilePoint(2, 0, 7).x, tilePoint(2, 0, 7).y, 1.3]);
  assert.deepEqual(m.cam.drawn, wedge, 'the picture starts from the wedge');
  assert.equal(m.cam.moving, true);
  assert.equal(m.cam.userMoved, false, 'the opening is not a person\'s move');
  // a person moves the camera: the opening is over, whatever arrives later
  m.setView({ x: 0, y: 0, zoom: 0.5 });
  assert.equal(m.cam.userMoved, true);
  src = { ...lordSrc, own: [{ p: 1, q: 1, tile: 30 }] };
  m.open(src, size, { dpr: 1, now: 9000 });
  assert.deepEqual(m.view, { x: 0, y: 0, zoom: 0.5 });
  m.destroy();
  // the viewer's record never comes: after the wait, the world
  const lost = new fmap.FrontierMap(canvas(), { source: () => ({ ringsOpen: 3, open: opening.openHint({ mode: 'play' }) }) });
  const s2 = lost.source();
  assert.equal(lost.open(s2, size, { now: 0 }), false);
  assert.equal(lost.open(s2, size, { now: opening.OPEN_WAIT_MS + 1 }), true);
  assert.equal(lost.opened.kind, 'fit');
  assert.equal(lost.lod, 'world');
  lost.destroy();
});

test('the title card: the opening drifts in slowly behind it and flies the rest when it closes', () => {
  let src = { ...lordSrc, open: { ...lordSrc.open, title: true } };
  const m = new fmap.FrontierMap(canvas(), { source: () => src });
  m.open(src, size, { dpr: 1, now: 0 });
  assert.equal(m.opened.kind, 'home', 'a player\'s title card ends on the player\'s village');
  assert.equal(m.cam.tween.ms, opening.TITLE_MS);
  assert.ok(near(m.cam.drawn.zoom, 1.3 * opening.TITLE_FROM), 'from far above');
  m.cam.step(0); m.cam.step(40); m.cam.step(80);
  const mid = { ...m.cam.drawn };
  src = { ...lordSrc };   // the card closed
  m.open(src, size, { dpr: 1, now: 100 });
  assert.deepEqual(m.cam.drawn, mid, 'from where the drift was');
  assert.ok(m.cam.tween.ms <= 1000, 'quickly now');
  assert.equal(m.view.zoom, 1.3);
  m.destroy();
});

test('home flies to the active village and cycles; the world chart goes out and comes back; keys act at once', () => {
  let src = { ...lordSrc, open: { ...lordSrc.open, active: 1 } };
  const m = new fmap.FrontierMap(canvas(), { source: () => src });
  m.setView({ x: 0, y: 0, zoom: 0.2 });
  m.cam.finish();
  m.home();
  assert.deepEqual([m.view.x, m.view.y], [tilePoint(1, 1, 30).x, tilePoint(1, 1, 30).y], 'the active village first');
  assert.equal(m.view.zoom, opening.heroZoom(1));
  assert.equal(m.lod, 'tile', 'the LOD follows the logical view at once');
  assert.ok(m.cam.moving && m.cam.drawn.zoom === 0.2, 'the picture flies');
  m.home();
  assert.deepEqual([m.view.x, m.view.y], [tilePoint(2, 0, 7).x, tilePoint(2, 0, 7).y], 'pressed again: the next village');
  m.home();
  assert.deepEqual([m.view.x, m.view.y], [tilePoint(1, 1, 30).x, tilePoint(1, 1, 30).y], 'and round');
  m.setView({ zoom: 2 });
  m.home();
  assert.equal(m.view.zoom, 2, 'a closer zoom is kept');
  // the world chart: out, and back to exactly where the camera was
  const before = { ...m.view };
  assert.equal(m.chartOn(), false);
  m.worldChart();
  assert.equal(m.lod, 'world');
  assert.equal(m.chartOn(), true);
  assert.ok(near(m.view.zoom, cam.fitView(3, size, { cap: fmap.FAR_ZOOM_CAP }).zoom));
  m.worldChart();
  assert.deepEqual(m.view, before);
  assert.equal(m.chartOn(), false);
  // from a world view reached by zooming, the button leads home
  m.setView({ x: 0, y: 0, zoom: 0.1 });
  m.worldChart();
  assert.equal(m.lod, 'tile');
  // without a village home is this viewer's opening view
  src = { overviews: new Map(), ringsOpen: 3, own: [], open: opening.openHint({ mode: 'play', land: { stage: 'joined' }, citizen: { faction: 4 } }) };
  m.home();
  assert.deepEqual(m.view, opening.openingPlan(src.open, src, size).view);
  m.destroy();
});

test('the zoom range is useful: never much past the far view, never past the sprites; flights and zooms keep their promises', () => {
  const m = new fmap.FrontierMap(canvas(), { source: () => ({ overviews: new Map(), ringsOpen: 3 }) });
  const far = cam.fitView(3, size, { cap: fmap.FAR_ZOOM_CAP }).zoom;
  assert.ok(near(m.zoomMin(size), far * 0.8), 'a little past the far view');
  m.setView({ zoom: 1e-9 });
  assert.equal(m.view.zoom, m.zoomMin(size));
  assert.equal(m.lod, 'world', 'the far view is world LOD');
  m.setView({ zoom: 99 });
  assert.equal(m.view.zoom, fmap.ZOOM_MAX);
  assert.ok(fmap.ZOOM_MAX >= 2.1, 'the battle focus zoom is inside the range');
  // sixteen steps out from the nearest view reach the world; four steps in from the far view are province LOD
  for (let i = 0; i < 16; i++) m.zoomBy(0.8);
  assert.equal(m.lod, 'world');
  m.fit({ ringsOpen: 3 }, size);
  const z0 = m.view.zoom;
  m.zoomBy(1.25);
  assert.ok(near(m.view.zoom, z0 * 1.25), 'a step is a step, at once');
  assert.equal(m.cam.moving, true, 'and eased on screen');
  // a place flown to lands in the middle; the trip takes longer when it is longer, never long
  m.flyTo({ p: 2, q: 0, tile: 7, zoom: 1 });
  assert.deepEqual(m.view, { x: tilePoint(2, 0, 7).x, y: tilePoint(2, 0, 7).y, zoom: 1 });
  assert.equal(m.cam.userMoved, true, 'the page placing the camera counts as moved');
  const short = fmap.flightMs({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 0, zoom: 1 }, size), long = fmap.flightMs({ x: 0, y: 0, zoom: 0.1 }, { x: 900, y: -350, zoom: 1.3 }, size);
  assert.ok(short >= 400 && short < long && long <= 1200, `${short} ms, ${long} ms`);
  // a pan by a person stays over the world; a place the page asks for is trusted
  m.setView({ x: 1e6, y: 0 }, { clamp: true });
  assert.ok(m.view.x < cam.worldRadius(3) + layers.PROVINCE_CIRCUMRADIUS);
  m.setView({ x: 1e6, y: 0 });
  assert.equal(m.view.x, 1e6);
  m.destroy();
});

test('depth without a tilt: the dressing is strong at the diorama and gone at the far view', () => {
  assert.equal(nearness(0.05), 0);
  assert.equal(nearness(cam.LOD_NEAR.from), 0);
  assert.equal(nearness(cam.LOD_NEAR.to), 1);
  assert.equal(nearness(1.3), 1);
  assert.ok(nearness(0.3) > 0 && nearness(0.3) < nearness(0.45));
  const fills = [];
  const grad = () => ({ stops: [], addColorStop(o, c) { this.stops.push([o, c]); } });
  const ctx = { save() {}, restore() {}, createLinearGradient: grad, createRadialGradient: grad, set fillStyle(v) { fills.push(v); }, fillRect() {} };
  paintDressing(ctx, size, { zoom: 1.3 });
  assert.equal(fills.length, 3, 'haze, vignette, the near edge');
  const alpha = c => Number(/,([\d.]+)\)$/.exec(c)[1]);
  assert.ok(alpha(fills[0].stops[0][1]) > 0.3 && alpha(fills[0].stops.at(-1)[1]) === 0, 'the haze is strongest at the top edge and fades out');
  assert.equal(alpha(fills[1].stops[0][1]), 0, 'the middle of the picture is untouched');
  fills.length = 0;
  paintDressing(ctx, size, { zoom: 0.08 });
  assert.equal(fills.length, 1, 'the far view is a chart lying flat: the vignette only');
  paintDressing({}, size, { zoom: 1 });   // a context without gradients: nothing, no throw
});

test('the middle band is sharp: far bitmaps reach the screen\'s resolution and soften less toward the near view', () => {
  for (const dpr of [1, 2]) for (const zoom of [0.2, 0.3, 0.4, 0.49]) {
    const res = farRes(zoom * dpr);
    assert.ok(res >= zoom * dpr * 0.85, `zoom ${zoom} at dpr ${dpr}: bitmap ${res} px per world px (stretched at most 1.18x)`);
  }
  assert.equal(FAR_RES.at(-1), 1);
  assert.ok(farSoftness(0.1) > 0.95 && farSoftness(0.5) < 0.15, 'soft from afar, almost none next to the tiles');
  let last = 2;
  for (let z = 0.1; z <= 0.6; z += 0.05) { const s = farSoftness(z); assert.ok(s <= last + 1e-12); last = s; }
});

test('the frame probe: kinds, averages and percentiles; off unless asked for', () => {
  assert.equal(PROBE.mode(), 0, 'no ?probe= here');
  PROBE.reset();
  for (let i = 0; i < 10; i++) { PROBE.begin(); PROBE.end(i < 8 ? 'live' : 'full'); }
  const s = PROBE.stats();
  assert.equal(s.live.n, 8);
  assert.equal(s.full.n, 2);
  for (const k of ['avg', 'p50', 'p95', 'max', 'js']) assert.ok(s.live[k] >= 0, k);
  PROBE.paint({}, size);   // off, and a bare context: nothing
  PROBE.reset();
  assert.deepEqual(PROBE.stats(), {});
});

/** A 2D context that accepts everything and counts what was called (gradients and text measured as stubs). */
function countingContext() {
  const calls = {};
  const grad = { addColorStop() {} };
  const target = { createLinearGradient: () => grad, createRadialGradient: () => grad, measureText: () => ({ width: 10 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const ctx = new Proxy(target, { get: (t, k) => (k in t ? t[k] : (...a) => { calls[k] = (calls[k] ?? 0) + 1; return a; }), set: () => true });
  return { ctx, calls };
}

test('a frame without a DOM: the bare table while the viewer is unknown, then the opening; the backing store follows a height-only resize', () => {
  const { ctx, calls } = countingContext();
  const cv = { clientWidth: 390, clientHeight: 734, width: 0, height: 0, dataset: {}, getContext: () => ctx };
  let src = { overviews: new Map(), ringsOpen: 3, own: [], open: opening.openHint({ mode: 'play' }) };
  const m = new fmap.FrontierMap(cv, { source: () => src });
  m.draw(0);
  assert.deepEqual([cv.width, cv.height], [390, 734]);
  assert.equal(cv.dataset.lod, 'world', 'nothing placed yet');
  assert.equal(calls.moveTo ?? 0, 0, 'no province was drawn: only the table');
  assert.ok(calls.fillRect >= 1);
  assert.equal(m.dirty, true, 'the map keeps asking until the viewer is known');
  // the viewer's record arrives: the village, tile LOD, the picture in flight
  src = { ...lordSrc };
  m.draw(100);
  assert.equal(cv.dataset.lod, 'tile');
  assert.equal(cv.dataset.terrain, 'pending', 'no terrain here: provinces as plain cells');
  assert.ok(calls.moveTo > 0, 'the land is drawn now');
  assert.equal(m.drawnLod, 'tile', 'the opening starts a little above its target, inside the tile view (no change of level on the way down)');
  for (let t = 116; m.cam.moving && t < 4000; t += 16) { m.cam.step(t); m.draw(t); }
  assert.deepEqual(m.cam.drawn, m.view, 'arrived');
  // the regression this replaces: a height-only change kept the old canvas.height (the width was the only thing compared)
  cv.clientHeight = 500;
  m.draw(5000);
  assert.deepEqual([cv.width, cv.height], [390, 500]);
  // and with the size the opening is framed again (nobody moved the camera)
  const at = fmap.worldToScreen(m.view, { width: 390, height: 500 }, tilePoint(2, 0, 7).x, tilePoint(2, 0, 7).y);
  assert.ok(near(at.x, 195) && near(at.y, 250), 'the village is in the middle of the new canvas');
  m.destroy();
});

test('the level of detail on screen follows the picture, the logical one the input; a resting view is recognised', () => {
  const { ctx } = countingContext();
  const cv = { clientWidth: 800, clientHeight: 600, width: 0, height: 0, dataset: {}, getContext: () => ctx };
  const m = new fmap.FrontierMap(cv, { source: () => ({ overviews: new Map(), ringsOpen: 3 }) });
  m.draw(0);
  assert.equal(m.lod, 'world');
  m.flyTo({ p: 2, q: 0, tile: 7, zoom: 1.3 }, 800);
  assert.equal(m.lod, 'tile', 'logical: at once');
  assert.equal(cv.dataset.lod, 'tile');
  m.cam.step(16); m.draw(16);
  assert.equal(m.drawnLod, 'world', 'on screen: still far out');
  m.cam.step(32); m.draw(32);
  const moving = m.sceneKey;
  for (let t = 48; m.cam.moving && t < 4000; t += 16) { m.cam.step(t); m.draw(t); }
  assert.equal(m.drawnLod, 'tile');
  assert.notEqual(m.sceneKey, moving);
  const rest = m.sceneKey;
  m.tick(); m.draw(5000);
  assert.equal(m.sceneKey, rest, 'an animation tick at rest: the same picture (the still layers are reused)');
  const stamp = m.stamp;
  m.invalidate();
  assert.equal(m.stamp, stamp + 1, 'a data change is told apart from a tick');
  m.tick();
  assert.equal(m.stamp, stamp + 1);
  m.destroy();
});
