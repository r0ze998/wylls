// The fourth wave of the map (UX brief §13.3 to §13.6; permutation-server/web/frontier/map). What these tests hold:
// the opening is one picture from its first frame (a dive from the waiting sheet, the land out of the paper), the
// camera's new moves, and the pieces the opening is made with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tilt from '../../permutation-server/web/frontier/map/tilt.mjs';
import * as fmap from '../../permutation-server/web/frontier/map/fmap.mjs';
import * as cam from '../../permutation-server/web/frontier/map/camera.mjs';
import { INERT_CTX, SpriteArt } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { seaField } from '../../permutation-server/web/frontier/map/cloudsea.mjs';
import { locate, ringOf } from '../../permutation-server/web/frontier/fgeo.mjs';

const desk = { width: 1440, height: 900 };
const HOME = { p: 2, q: 0, tile: 7 };

/** A page with the stage whose elements can be made, laid out and painted: every context takes every call. */
function livePage(size, insets = null) {
  const ctxOf = () => { const calls = {}; const grad = { addColorStop() {} }; const t = { calls, createLinearGradient: () => grad, createRadialGradient: () => grad, measureText: () => ({ width: 10 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }; return new Proxy(t, { get: (o, k) => (k in o ? o[k] : (...a) => { calls[k] = (calls[k] ?? 0) + 1; return a; }), set: () => true }); };
  const style = () => { const vars = {}; return { vars, setProperty: (k, v) => { vars[k] = v; } }; };
  const el = (tag) => { const ctx = ctxOf(); return { tag, className: '', dataset: {}, style: style(), kids: [], width: 0, height: 0, ctx, getContext: tag === 'canvas' ? () => ctx : undefined, append(k) { this.kids.push(k); } }; };
  const stage = el('div'), ground = el('canvas'), dress = el('div');
  dress.querySelector = sel => dress.kids.find(k => `.${k.className}` === sel) ?? null;
  const listeners = {};
  const canvas = { ...el('canvas'), clientWidth: size.width, clientHeight: size.height, getBoundingClientRect: () => ({ left: 0, top: 0, width: size.width, height: size.height }), addEventListener: (n, f) => { listeners[n] = f; },
    ownerDocument: { createElement: el, getElementById: id => ({ 'map-stage': stage, 'map-ground': ground, 'map-dress': dress })[id] ?? null } };
  return { canvas, stage, ground, dress, listeners, insets };
}
const waitingSrc = () => ({ overviews: new Map(), ringsOpen: 3, own: [], open: { mode: 'play', ready: false, stage: 'none' } });
const homeSrc = (own = [{ ...HOME }]) => ({ overviews: new Map(), ringsOpen: 3, own, open: { mode: 'play', ready: true, stage: 'final', active: 0 } });

// ------------------------------------------------------------------ the camera's new moves
test('a flight can end somewhere else without starting again, says how far it has come, and may keep the clock\'s own time', () => {
  const c = new cam.Camera({ view: { x: 0, y: 0, zoom: 0.2 }, reduced: () => false });
  c.set({ x: 1000, y: 0, zoom: 1 }, { ms: 1000, kind: 'fly', ease: cam.EASE.outQuint, real: true });
  assert.equal(c.progress(), 0);
  c.step(0); c.step(400);
  const before = { ...c.drawn }, from = { ...c.tween.from }, elapsed = c.tween.elapsed;
  assert.equal(elapsed, 400, 'a real move takes a long frame whole (any other move is slowed to 50 ms of it)');
  assert.ok(c.progress() > 0.8 && c.progress() < 1, `eased out steeply: most of the way after two fifths of the time (${c.progress()})`);
  c.retarget({ x: 1040, y: 20 });
  assert.deepEqual(c.view, { x: 1040, y: 20, zoom: 1 }, 'the logical view is the new end at once');
  assert.deepEqual(c.tween.from, from);
  assert.equal(c.tween.elapsed, elapsed, 'the same flight: its start and the time flown are kept');
  c.step(416);
  assert.ok(Math.hypot(c.drawn.x - before.x, c.drawn.y - before.y) * c.drawn.zoom < 60, 'the picture goes on from where it was, toward the new end');
  for (let t = 432; c.moving && t < 3000; t += 16) c.step(t);
  assert.deepEqual(c.drawn, { x: 1040, y: 20, zoom: 1 });
  assert.equal(c.progress(), 1, 'no flight: all the way');
  // with no flight under way, retarget is a plain placement; under reduced motion too
  c.retarget({ x: 5 });
  assert.equal(c.drawn.x, 5);
  // an ordinary move is slowed by a slow frame, as before
  c.set({ x: 500 }, { ms: 1000 });
  c.step(5000); c.step(5400);
  assert.equal(c.tween.elapsed, 50);
});

// ------------------------------------------------------------------ the opening (UX brief §13.4)
test('the dive begins at the waiting picture as it was shown, even when the page\'s sheets moved with the answer', () => {
  let inset = { top: 60, right: 0, bottom: 0, left: 0 };
  const page = livePage(desk);
  let src = waitingSrc();
  const m = new fmap.FrontierMap(page.canvas, { source: () => src, insets: () => inset });
  m.draw(0);
  const shown = { ...m.waitAt };
  // the answer: not joined, and the nation choice now covers the foot of the map
  inset = { top: 60, right: 0, bottom: 420, left: 0 };
  src = { overviews: new Map(), ringsOpen: 3, own: [], open: { mode: 'play', ready: true, stage: 'none', frame: {} } };
  m.frameNo = (m.frameNo ?? 0) + 1;   // (the insets are read once a frame)
  m.draw(100);
  assert.ok(m.dive);
  assert.deepEqual(m.dive.from, shown, 'from the picture that was on screen');
  assert.deepEqual(m.cam.drawn, shown);
  assert.notDeepEqual(m.waitView(desk, inset), shown, '(where the sheets would put the waiting picture now is somewhere else)');
  m.destroy();
});

test('the end of a dive may move while it flies (the viewer became more, a sheet settled): the same flight, no new start', () => {
  const page = livePage(desk);
  let src = waitingSrc();
  const m = new fmap.FrontierMap(page.canvas, { source: () => src });
  m.draw(0);
  src = homeSrc();
  m.draw(100);
  for (let t = 116; t < 300; t += 16) m.frame(t);
  const tw = m.cam.tween, from = { ...tw.from }, elapsed = tw.elapsed, end = { ...m.view };
  assert.ok(elapsed > 150);
  // a second village arrives and is the active one
  src = { ...homeSrc([{ ...HOME }, { p: 1, q: 1, tile: 30 }]), open: { mode: 'play', ready: true, stage: 'final', active: 1 } };
  m.frame(316);
  assert.notDeepEqual(m.view, end, 'the opening frames the new subject');
  assert.equal(m.cam.tween, tw, 'in the same flight');
  assert.deepEqual(tw.from, from);
  assert.ok(tw.elapsed >= elapsed && tw.elapsed < elapsed + 40);
  m.destroy();
});

test('the board keeps the seat\'s angle through a dive to a village, and lies down evenly on a dive to the far view', () => {
  // to a village: the waiting picture's 26 degrees all the way (the zoom's own angle on the way would dip to nothing and rise again)
  const page = livePage(desk);
  let src = waitingSrc();
  const m = new fmap.FrontierMap(page.canvas, { source: () => src });
  m.draw(0);
  src = homeSrc();
  m.draw(100);
  const degs = [];
  for (let t = 116; m.cam.moving && t < 3000; t += 16) { m.frame(t); degs.push(Number(page.stage.style.vars['--map-tilt'].replace('deg', ''))); }
  assert.ok(degs.length > 20 && degs.every(d => d === 26), `26 all the way: ${Math.min(...degs)}`);
  assert.ok(m.tiltDeg(m.dive?.from?.zoom ?? 0.2) < 1, '(the far zoom\'s own angle is flat)');
  m.destroy();
  // to the far view (a watcher): from 26 down to flat, never back up
  const p2 = livePage(desk);
  const m2 = new fmap.FrontierMap(p2.canvas, { source: () => ({ overviews: new Map(), ringsOpen: 3, own: [], open: { mode: 'spectate', ready: true, stage: 'watch' } }) });
  m2.draw(0);
  assert.equal(m2.opened.kind, 'fit');
  assert.ok(m2.dive?.seat);
  const d2 = [Number(p2.stage.style.vars['--map-tilt'].replace('deg', ''))];
  for (let t = 16; m2.cam.moving && t < 3000; t += 16) { m2.frame(t); d2.push(Number(p2.stage.style.vars['--map-tilt'].replace('deg', ''))); }
  assert.equal(d2[0], 26);
  assert.ok(d2[d2.length - 1] < 1, `flat at the far view: ${d2[d2.length - 1]}`);
  assert.ok(d2.every((d, i) => i === 0 || d <= d2[i - 1] + 1e-9), 'it only lies down');
  m2.destroy();
});

test('under reduced motion nothing travels: the waiting picture stays until the land is made, then the picture changes once', () => {
  const page = livePage(desk);
  let src = waitingSrc();
  const m = new fmap.FrontierMap(page.canvas, { source: () => src });
  m.cam.reduced = () => true;
  m.draw(0);
  src = homeSrc();
  let pending = 2, shown = 0;
  const scene = m.paintScene.bind(m);
  const preps = [];
  m.paintScene = (ctx, s0, view, lod, size, dpr, o) => { if (ctx === INERT_CTX) preps.push({ view, size, o }); else shown++; return { ...scene(ctx, s0, view, lod, size, dpr, o), pending }; };
  m.draw(100);
  assert.ok(m.dive?.calm && m.openHold);
  assert.equal(m.cam.moving, false);
  assert.deepEqual(m.cam.drawn, m.view, 'the camera is where it will stay');
  assert.equal(shown, 0, 'and the waiting sheet is still what is on screen');
  assert.equal(page.stage.style.vars['--map-tilt'], '26.00deg');
  // what is made meanwhile is the resting picture itself: the canvas's own box, the part of the board the tilt shows
  const G = m.groundSize();
  assert.deepEqual(preps[0].size, G);
  assert.ok(Array.isArray(preps[0].o.quad) && preps[0].o.quad.length === 4);
  m.frame(116); m.frame(400);
  assert.equal(shown, 0);
  pending = 0;
  m.frame(416);
  assert.equal(shown, 1);
  assert.equal(m.landShown, 1, 'whole at once: no dissolve');
  assert.equal(m.dive, null);
  m.destroy();
});

test('the opening\'s numbers', () => {
  const D = fmap.DIVE;
  assert.ok(D.ms >= 800 && D.ms <= 1400, 'the dive is a second or so');
  assert.ok(D.land >= 250 && D.land <= 500);
  assert.ok(D.near > 0.6 && D.near < 0.9, 'the land comes when the picture is at most twice the area of the one the camera ends on');
  assert.ok(D.ground + D.sea <= 110, 'a frame of the dive that makes the land is a tenth of a second at most, by its own budget');
  assert.ok(D.rest < fmap.OPEN_HOLD_MS);
  assert.ok(D.lo > 0 && D.lo < 1 && D.sea0 > 0 && D.sea0 < 1);
  // the dive is steep: by a third of its time the camera has come most of its way down
  assert.ok(cam.EASE.outQuint(1 / 3) > 0.85);
});

// ------------------------------------------------------------------ what the opening is made with
test('the context that shows nothing takes every call, drops what is set on it, and gives gradients and measures', () => {
  const g = INERT_CTX;
  assert.doesNotThrow(() => {
    g.save(); g.setTransform(2, 0, 0, 2, 0, 0); g.fillStyle = '#123'; g.globalAlpha = 0.5; g.beginPath(); g.ellipse(0, 0, 1, 1, 0, 0, 7); g.fill(); g.clip(); g.restore();
    g.createLinearGradient(0, 0, 1, 1).addColorStop(0, '#000'); g.createRadialGradient(0, 0, 1, 0, 0, 2).addColorStop(1, '#fff');
    g.drawImage({}, 0, 0); g.drawImage(null, 0, 0, 10, 10); g.someCallOfALaterCanvas(1, 2, 3);
  });
  assert.equal(g.measureText('abc').width, 0);
  assert.deepEqual(g.getTransform(), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  assert.equal(g.canvas, null);
  assert.equal(g.createPattern({}, 'repeat'), null);
  assert.notEqual(g.fillStyle, '#123', 'nothing set on it is kept');
});

test('the sprites any land is made of are asked for ahead of the first picture, once a set; a sprite that fails is not waited for', () => {
  const made = [];
  const was = globalThis.Image;
  globalThis.Image = class { constructor() { made.push(this); } set src(v) { this.url = v; } decode() { this.decoded = true; return Promise.resolve(); } };
  try {
    const art = new SpriteArt({});
    art.warm('@2x');
    const names = made.map(i => i.url.split('/art/')[1]);
    assert.ok(names.every(n => n.includes('/@2x/') && n.endsWith('.webp')));
    for (const want of ['terrain/@2x/grassland_1.webp', 'terrain/@2x/water_3.webp', 'props/@2x/hills_2.webp', 'sites/@2x/plains_1.webp', 'sites_props/@2x/grassland_3.webp', 'overlays/@2x/shore_0.webp', 'overlays/@2x/beach_5.webp', 'holdings/@2x/site.webp', 'factions/@2x/wash_ember.webp', 'factions/@2x/border_verdant_5_own.webp']) assert.ok(names.includes(want), want);
    // (a mountain's and a wood's baked sprites are not asked for: their relief is drawn by code, their ground is a hill's and grass)
    assert.ok(!names.some(n => /terrain\/@2x\/(forest|mountain)_/.test(n)));
    assert.equal(new Set(names).size, names.length, 'each once');
    assert.equal(art.loading, names.length);
    assert.equal(art.misses, 0, 'asking ahead is not a miss of any picture');
    assert.ok(made.every(i => i.decoded), 'decoded as they arrive, off the page\'s own thread');
    const n = made.length;
    art.warm('@2x');
    assert.equal(made.length, n, 'a set is asked for once');
    art.warm('@1x');
    assert.equal(made.length, 2 * n);
    // one arrives, one fails: neither is waited for any longer
    made[0].onload(); made[1].onerror();
    assert.equal(art.loading, 2 * n - 2);
    made[1].onerror();
    assert.equal(art.loading, 2 * n - 2, 'counted once');
    assert.ok(art.image('terrain', '@2x', 'grassland_1'), 'the one that arrived is drawn');
  } finally { if (was === undefined) delete globalThis.Image; else globalThis.Image = was; }
});

test('the sea\'s field keeps what it has found out about a tile, and says the same as the map\'s own geometry', () => {
  const F = seaField(3);
  const open = (q, r) => { const at = locate(q, r); return ringOf(at.p, at.q) < 3; };
  for (const [q, r] of [[0, 0], [5, -3], [14, -7], [20, 0], [-22, 11], [30, -30], [9, 9]]) {
    const s = F.steps(q, r);
    assert.equal(s === 0, open(q, r), `${q},${r}`);
    assert.equal(F.steps(q, r), s, 'the same again');
  }
  // far out at sea every tile is as far as the search goes; asked for a whole patch, it answers quickly
  const t0 = Date.now();
  let far = 0;
  for (let q = 40; q < 80; q++) for (let r = -20; r < 20; r++) if (F.steps(q, r) >= 8) far++;
  assert.equal(far, 1600);
  assert.ok(Date.now() - t0 < 1500);
});

// ------------------------------------------------------------------ the wheel near the world's edge, the tilt on a phone (UX brief §13.6)
import { landBox } from '../../permutation-server/web/frontier/map/camera.mjs';
import { heroZoom } from '../../permutation-server/web/frontier/map/opening.mjs';

test('the sea keeps its third until the picture is nearly as wide as the land; a zoom may rest a little past the limit, a pan may not', () => {
  const b = landBox(3);
  assert.ok(cam.SEA_HOLD.from >= 0.8 && cam.SEA_HOLD.to > cam.SEA_HOLD.from && cam.SEA_HOLD.to <= 1.6);
  // at the seat's zoom and four wheel notches further out the limit is still a third of the picture beyond the land
  for (const zoom of [1.15, 0.85, 0.63]) {
    const halfW = desk.width / 2 / zoom;
    assert.ok(halfW / b.x < cam.SEA_HOLD.from, `zoom ${zoom}: the picture is narrower than the land`);
    const hard = cam.clampCentre({ x: 40_000, y: 0, zoom }, { ringsOpen: 3, size: desk });
    assert.ok(Math.abs((hard.x + halfW - b.x) / (2 * halfW) - cam.SEA_SHARE) < 1e-9, `zoom ${zoom}: a third`);
  }
  // toward the far view the world comes to the middle, as before
  const far = cam.fitView(3, desk);
  assert.ok(cam.clampCentre({ x: 40_000, y: 0, zoom: far.zoom }, { ringsOpen: 3, size: desk }).x < b.x * 0.2);
  // where a centre stands against the limit, and the give of a zoom
  const on = cam.clampCentre({ x: 40_000, y: 0, zoom: 0.63 }, { ringsOpen: 3, size: desk });
  assert.ok(Math.abs(cam.centreReach(on, { ringsOpen: 3, size: desk }).len - 1) < 1e-9);
  assert.ok(cam.centreReach({ x: 0, y: 0, zoom: 0.63 }, { ringsOpen: 3, size: desk }).len === 0);
  const given = cam.clampCentre({ x: 40_000, y: 0, zoom: 0.63 }, { ringsOpen: 3, size: desk, give: cam.ZOOM_GIVE });
  assert.ok(Math.abs(given.x / on.x - (1 + cam.ZOOM_GIVE)) < 1e-9, 'a zoom may rest that much past it');
  const inside = { x: on.x * 1.1, y: 0, zoom: 0.63 };
  assert.equal(cam.clampCentre(inside, { ringsOpen: 3, size: desk, give: cam.ZOOM_GIVE }), inside, 'and is left alone there');
  assert.ok(cam.ZOOM_GIVE > 0 && cam.ZOOM_GIVE <= 0.2, 'a little: the third is a guide, not a wall');
  // a drag's give is what it was, about the limit it is given
  const soft = cam.clampCentre({ x: on.x + 300, y: 0, zoom: 0.63 }, { ringsOpen: 3, size: desk, soft: 1 });
  assert.ok(soft.x > on.x && soft.x < on.x + 300);
});

/** A map on a plain canvas of `size` (no stage: the flat picture), three rings open, the camera at the seat over the village. */
function flatMap(size = desk) {
  const grad = { addColorStop() {} };
  const ctx = new Proxy({ createLinearGradient: () => grad, createRadialGradient: () => grad, measureText: () => ({ width: 10 }), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });
  const listeners = {};
  const cv = { clientWidth: size.width, clientHeight: size.height, width: 0, height: 0, dataset: {}, getContext: () => ctx, addEventListener: (n, f) => { listeners[n] = f; } };
  const m = new fmap.FrontierMap(cv, { source: () => ({ overviews: new Map(), ringsOpen: 3, own: [{ ...HOME }], open: { ready: true, active: 0 } }) });
  m.cam.reduced = () => false;
  m.rings = 3;
  return { m, listeners };
}
const under = (m, bx, by) => m.unproject(bx, by, { logical: true, box: true });

test('four wheel notches out from the village keep the point under the pointer; what the limit does not allow is a slow glide', () => {
  const { m } = flatMap();
  const seat = { x: 876.42, y: -399.06, zoom: heroZoom(1) };   // the opening view over the fixture's village, near the world's east edge
  const drift = (bx, by, factor) => {
    m.cam.set(seat, { ms: 0 });
    const w = under(m, bx, by);
    m.zoomAt(factor, bx, by, { ms: cam.MOVE_MS.wheel, tag: 'wheel' });
    const p = m.project(w.x, w.y, { logical: true, box: true });
    return { px: Math.hypot(p.x - bx, p.y - by), ms: m.cam.tween?.ms ?? 0 };
  };
  const four = Math.exp(-400 * 0.0015);
  // (the last check: 114 px at the top, 266 at the centre, 448 at the left, 272 at the bottom)
  for (const [name, x, y, most] of [['top', 930, 150, 1], ['centre', 720, 450, 1], ['bottom', 930, 780, 1], ['on the village', 720, 501, 1], ['left', 330, 450, 60]]) {
    const d = drift(x, y, four);
    assert.ok(d.px <= most, `${name}: ${d.px.toFixed(1)} px`);
    if (d.px < 1) assert.equal(d.ms, cam.MOVE_MS.wheel, `${name}: the zoom's own quick ease`);
  }
  // one notch, and any zoom in, hold exactly
  assert.ok(drift(330, 450, Math.exp(-100 * 0.0015)).px < 1e-6);
  assert.ok(drift(330, 450, Math.exp(400 * 0.0015)).px < 1e-6);
  // all the way out the world comes to the middle of the picture: the point must move, and it glides
  const out = drift(330, 450, 0.2);
  assert.ok(out.px > 200);
  assert.ok(out.ms >= cam.MOVE_MS.wheel + 300 && out.ms <= cam.MOVE_MS.wheel + cam.MOVE_MS.pull, `a glide of its own length: ${out.ms} ms`);
  assert.equal(m.cam.tween.ease, cam.EASE.inOutCubic);
  // the logical view is where it will rest, at once (state changes with the input; the glide is the picture's)
  assert.ok(cam.centreReach(m.view, { ringsOpen: 3, size: desk }).len <= 1 + cam.ZOOM_GIVE + 1e-9);
  m.destroy();
});

test('a step by the keys from a view a zoom left past the limit is not first pulled back inside', () => {
  const { m, listeners } = flatMap();
  m.opened = { kind: 'home' };   // (the map has opened: its keys answer)
  m.cam.set({ x: 876.42, y: -399.06, zoom: heroZoom(1) }, { ms: 0 });
  m.zoomAt(Math.exp(-400 * 0.0015), 330, 450, { ms: 0 });
  const rest = { ...m.view }, past = m.pastLimit();
  assert.ok(past > 0.01 && past <= cam.ZOOM_GIVE, `it rests ${past.toFixed(3)} past the limit`);
  // a step inland (left): exactly the step, no jump with it
  listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.ok(Math.abs((rest.x - m.view.x) - 80 / rest.zoom) < 1e-6 && Math.abs(m.view.y - rest.y) < 1e-6);
  // a step further out is held where the zoom left it
  m.cam.set(rest, { ms: 0 });
  listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.ok(cam.centreReach(m.view, { ringsOpen: 3, size: desk }).len <= 1 + past + 1e-9);
  m.destroy();
});

test('on a phone the board is fully tilted from a little over twice its far zoom: the wait views are seen from the seat', () => {
  assert.equal(tilt.tiltNear(0.3), tilt.TILT_NEAR, 'a desktop: as before');
  assert.ok(Math.abs(tilt.tiltNear(0.1) - 0.213) < 1e-9);
  assert.equal(tilt.tiltNear(0), tilt.TILT_NEAR);
  const phone = { width: 390, height: 844 };
  const page = livePage(phone);
  const m = new fmap.FrontierMap(page.canvas, { source: () => ({ overviews: new Map(), ringsOpen: 3, own: [], open: { ready: true } }) });
  m.rings = 3;
  // (the last check: 8.1 degrees at the joined wait view's zoom, 0.29, and 5.1 at the ticket's, 0.25)
  assert.equal(m.tiltDeg(0.29, phone), 26);
  assert.equal(m.tiltDeg(0.25, phone), 26);
  assert.ok(m.tiltDeg(m.flatZoom(phone), phone) === 0, 'the far view still lies flat');
  let last = 0;
  for (let z = 0.05; z < 1.3; z += 0.01) { const d = m.tiltDeg(z, phone); assert.ok(d >= last - 1e-9); last = d; }
  m.destroy();
  // a desktop's angles are what they were
  const p2 = livePage(desk), m2 = new fmap.FrontierMap(p2.canvas, { source: () => ({ overviews: new Map(), ringsOpen: 3, own: [], open: { ready: true } }) });
  m2.rings = 3;
  const far = m2.flatZoom(desk) * 1.05;
  for (const z of [0.3, 0.4, 0.5, 0.62, 1.15]) assert.ok(Math.abs(m2.tiltDeg(z, desk) - tilt.tiltAt(z, { far, deg: 26 })) < 0.25, `zoom ${z}`);
  m2.destroy();
});

// ------------------------------------------------------------------ one drawing hand (UX brief §13.5)
import * as relief from '../../permutation-server/web/frontier/map/relief.mjs';
import { CODE_RELIEF } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { luminance } from '../../permutation-server/web/frontier/palette.mjs';

/** A context that writes down every call and every style set on it. */
function recorder() {
  const calls = [], grads = [];
  const grad = () => { const g = { stops: [], addColorStop(k, c) { this.stops.push([k, c]); } }; grads.push(g); return g; };
  const t = { calls, grads, createLinearGradient: grad, createRadialGradient: grad };
  return new Proxy(t, { get: (o, k) => (k in o ? o[k] : (...a) => { calls.push([k, ...a]); }), set: (o, k, v) => { calls.push(['=' + String(k), v]); return true; } });
}

test('mountains and woods are in the ground\'s soft hand: no outline, faces that turn in a wash, the ground art\'s own colours; hills stay baked', () => {
  // the colours are the baked sprites' own, light to dark
  const P = relief.GROUND_PALETTE;
  for (const k of ['rock', 'snow', 'turf', 'fir', 'leaf']) {
    const tones = Object.values(P[k]).map(luminance);
    assert.ok(tones.every((v, i) => i === 0 || v < tones[i - 1]), `${k}: light to dark`);
  }
  // (rock: the render's greys, a warm grey and never the tan of the first drawn mountains; red, green and blue stay close)
  for (const hex of Object.values(P.rock)) { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); assert.ok(r >= g && g >= b && r - b < 40, hex); }
  for (let v = 0; v < 3; v++) {
    const g = recorder();
    relief.paintMountain(g, 0, 0, 100, { variant: v });
    // no outline: the only strokes are the grain's single short lines and a tree's light (no stroke runs along a silhouette)
    let lines = 0, worst = 0;
    for (const c of g.calls) { if (c[0] === 'beginPath') lines = 0; else if (c[0] === 'lineTo') lines++; else if (c[0] === 'stroke') worst = Math.max(worst, lines); }
    assert.ok(worst <= 1, `variant ${v}: a stroke along ${worst} points`);
    const widths = g.calls.filter(c => c[0] === '=lineWidth').map(c => c[1]);
    assert.ok(Math.max(...widths) <= 2.4, `variant ${v}: hair lines only (${Math.max(...widths)} of a radius of 100)`);
    // no ink: no stroke in the dark line colours of the first drawn relief
    assert.ok(!g.calls.some(c => c[0] === '=strokeStyle' && /rgba\(4[0-9],3[0-9],2[0-9]/.test(String(c[1]))));
    // the faces are gradients of the rock's tones, the foot is rubbed into the ground
    assert.ok(g.grads.length > 20);
    assert.ok(g.grads.some(x => x.stops.some(s => s[1] === P.rock.top)) && g.grads.some(x => x.stops.some(s => s[1] === P.rock.deep)));
    assert.ok(g.calls.some(c => c[0] === '=globalCompositeOperation' && c[1] === 'destination-out'), 'a foothill melts into the tile');
  }
  for (const kind of ['fir', 'leaf']) for (let v = 0; v < 3; v++) {
    const g = recorder();
    relief.paintTree(g, 0, 0, 60, { kind, variant: v });
    assert.ok(!g.calls.some(c => c[0] === '=strokeStyle' && /rgba\(26,36,20/.test(String(c[1]))), `${kind} ${v}: no ink line`);
    assert.ok(g.grads.length >= 3, `${kind} ${v}: it turns from light to shade`);
  }
  // the shade a wood and a mountain throw is soft to its edge: a gradient that ends in nothing
  const f = recorder();
  relief.paintWoodFloor(f, 0, 0, 44, relief.woodOf(0, 0, 1));
  assert.ok(f.grads.length >= 19 && f.grads.every(x => / ?0\)$/.test(x.stops[x.stops.length - 1][1].replace(/\s/g, ''))), 'every shadow of the floor fades out');
  const s = recorder();
  relief.paintMountainShadow(s, 0, 0, 100);
  assert.equal(s.grads.length, 1);
  assert.match(s.grads[0].stops[s.grads[0].stops.length - 1][1], /,0\)$/);
  // hills: tried again as soft upright mounds, and the baked ground won again (the code is gone)
  assert.equal(CODE_RELIEF.hills, undefined);
  assert.equal(relief.paintHill, undefined);
  assert.equal(relief.RELIEF.hill, undefined);
});

// ------------------------------------------------------------------ gold still means yours beside a yellow nation (UX brief §13.3)
import * as LAND from '../../permutation-server/web/frontier/map/ownland.mjs';
import { YOURS, strokeYours } from '../../permutation-server/web/frontier/map/chart.mjs';
import { NATION_FILL, contrast, nationPale } from '../../permutation-server/web/frontier/palette.mjs';

test('the viewer\'s own mark is told by how it is built: bright gold with an ivory core between dark keylines, whatever nation\'s colour runs beside it', () => {
  // the three tones stand well apart in lightness, so the build reads without colour (a grey picture, a colour-blind eye)
  assert.ok(contrast(YOURS.core, YOURS.gold) >= 1.3, `core on gold ${contrast(YOURS.core, YOURS.gold).toFixed(2)}`);
  assert.ok(contrast(YOURS.gold, YOURS.key) >= 10, `gold on its keyline ${contrast(YOURS.gold, YOURS.key).toFixed(1)}`);
  // and the keyline stands against every nation's cloth, the yellow and the orange and the white among them: at least 3:1 (a stroke)
  for (let f = 0; f < 6; f++) assert.ok(contrast(NATION_FILL[f], YOURS.key) >= 3, `nation ${f}: ${contrast(NATION_FILL[f], YOURS.key).toFixed(1)}`);
  assert.ok(YOURS.rail.key > 1.25 && YOURS.rail.key < 1.7 && YOURS.rail.core >= 0.3 && YOURS.rail.core <= 0.5);
  // the rail is three strokes of one path: key under, gold on it, the core in the gold; dashed as one when asked
  const g = recorder();
  strokeYours(g, null, 3, { dash: [9, 7] });
  const set = k => g.calls.filter(c => c[0] === '=' + k).map(c => c[1]);
  assert.deepEqual(set('strokeStyle'), [YOURS.key, YOURS.gold, YOURS.core]);
  assert.deepEqual(set('lineWidth'), [3 * YOURS.rail.key, 3, 3 * YOURS.rail.core]);
  assert.deepEqual(g.calls.filter(c => c[0] === 'setLineDash').map(c => c[1]), [[9, 7], []]);
  assert.equal(g.calls.filter(c => c[0] === 'stroke').length, 3);
  // nothing is drawn of a rail with no width or no strength
  const none = recorder(); strokeYours(none, null, 0); strokeYours(none, null, 3, { alpha: 0 });
  assert.equal(none.calls.length, 0);
  // the tile view's rim: the nation's colour is still in it, either side of the rail, on its dark underlay
  const R = LAND.OWN_RIM;
  assert.ok(R.ink > R.colour && R.colour > R.gold * YOURS.rail.key + 2.5, 'at least a pixel and a quarter of the nation\'s colour either side of the rail');
  assert.ok(R.ink <= 10, 'and the whole rim is no wider than a third of a hex side at the hero zoom');
  // from afar the rail alone, wide enough for its core to be a line
  assert.ok(LAND.OWN_FAR.gold * YOURS.rail.core >= 1);
  // a white nation's band is paint, not a cast (a cast of white on grass was faint)
  assert.ok(nationPale(4) && !nationPale(2) && !nationPale(5));
  assert.ok(LAND.OWN_PALE.rim > LAND.OWN_FILL.rim && LAND.OWN_PALE.rim <= 0.6 && LAND.OWN_PALE.body > 1);
  // the standard's finial and the far view's beacon are built the same way: key, gold, ivory heart
  for (const paint of [gg => LAND.paintStandard(gg, 0, 0, { u: 50, zoom: 1, faction: 2, still: true }), gg => LAND.paintBeacon(gg, 0, 0, { zoom: 0.3, still: true })]) {
    const p = recorder(); paint(p);
    const fills = p.calls.filter(c => c[0] === '=fillStyle').map(c => c[1]);
    assert.ok(fills.indexOf(YOURS.gold) >= 0 && fills.lastIndexOf(YOURS.core) > fills.indexOf(YOURS.gold), 'gold, then its ivory heart');
    assert.ok([...p.calls.filter(c => c[0] === '=fillStyle' || c[0] === '=strokeStyle').map(c => c[1])].includes(YOURS.key));
  }
});

// ------------------------------------------------------------------ the wait view's map side (UX brief §13.6)
import * as WAIT from '../../permutation-server/web/frontier/map/waitview.mjs';
import * as opening from '../../permutation-server/web/frontier/map/opening.mjs';
import { WEDGE_WAIT } from '../../permutation-server/web/frontier/map/chart.mjs';
import { wedgeOf, tileHex, ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as PEOPLE from '../../permutation-server/web/frontier/people/leaders.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { RADIUS, project } from '../../permutation-server/web/map.mjs';

/** A context that writes down what is written on it (text measured at 7 px a letter). */
function writer() {
  const calls = [];
  return new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : k === 'measureText' ? t => ({ width: String(t).length * 7 }) : k === 'canvas' ? null : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: () => true });
}
const said = g => g.calls.filter(c => c[0] === 'fillText').map(c => c[1]);

test('the surveyors\' marks stand on the free sites of the home wedge, from the first ring a village may be placed in, and nowhere else', () => {
  const faction = 0, rings = 3;
  const provs = ringProvinces(2).filter(pr => wedgeOf(pr.p, pr.q) === faction);
  assert.ok(provs.length >= 1);
  const P = provs[0];
  // an overview record: sites 0..11; 0 and 3 are free, 1 is a holding, 4 reserved; a free site that has an owner is not free
  const sites = [0, 1, 3, 4, 0, 0, 2, 0, 0, 0, 0, 0], owners = [7, 0, 7, 7, 7, 2, 7, 7, 7, 7, 7, 7];
  const recs = new Map([[`${P.p},${P.q}`, { p: P.p, q: P.q, sites, owners }], ['1,0', { p: 1, q: 0, sites: Array(12).fill(0), owners: Array(12).fill(7) }]]);
  const terrainOf = (p, q) => ({ sites: [5, 9, 14, 20, 27, 33, 38, 41, 46, 50, 55, 59] });
  const out = WAIT.wedgeSites(faction, rings, recs, terrainOf);
  assert.deepEqual(out.map(s => s.site), [0, 2, 4, 7, 8, 9, 10, 11], 'free and unowned, of the one province that has a record');
  assert.ok(out.every(s => s.p === P.p && s.q === P.q), 'ring 1 is never offered: no mark there, whatever its record says');
  for (const s of out) { const h = tileHex(s.p, s.q, s.tile), c = project(h.q, h.r); assert.deepEqual([s.x, s.y], [c.x, c.y]); }
  // until the rules module has said where the sites are, nothing is marked (never a guess)
  assert.deepEqual(WAIT.wedgeSites(faction, rings, recs, () => null), []);
  assert.deepEqual(WAIT.wedgeSites(faction, rings, new Map(), terrainOf), []);
  assert.deepEqual(WAIT.wedgeSites(faction, 2, recs, terrainOf), [], 'with two rings open there is none yet');
  // painted as small station marks, one a site, with a few fine sight lines from the standard; none from far away
  const g = writer();
  assert.equal(WAIT.paintSiteMarks(g, { x: out[0].x - 400, y: out[0].y }, out, { zoom: 0.7 }), out.length);
  assert.ok(g.calls.filter(c => c[0] === 'setLineDash' && c[1].length === 2).length >= 3, 'sight lines');
  assert.equal(WAIT.paintSiteMarks(writer(), null, out, { zoom: 0.1 }), 0);
  assert.equal(WAIT.paintSiteMarks(writer(), null, [], { zoom: 1 }), 0);
});

test('the tag under the standard says what the marks are; the nation\'s words carry no person\'s name', () => {
  setLang('ja');
  const at = { x: 100, y: 200 };
  const g = writer();
  WAIT.paintHomeTag(g, at, { zoom: 1, faction: 0, marks: true, say: WAIT.leaderWords(0, null) });
  const t = said(g);
  assert.deepEqual(t.slice(0, 3), ['アステル', 'あなたの国の土地', '村を置ける場所']);
  assert.ok(t.slice(3).join('').startsWith('「まずは村の申し込みだ'));
  // (the owner's decision of 2026-10-09: no leader names. Rewritten at the integration of wave 4: the people module
  // carries no name any more and the words name no speaker anywhere, so `who` is gone, on the page's card as well)
  assert.equal(PEOPLE.LEADERS, undefined);
  assert.equal(WAIT.leaderWords, WAIT.nationWords);
  for (let f = 0; f < 6; f++) {
    const w = WAIT.leaderWords(f, 'ticket');
    assert.deepEqual(Object.keys(w), ['text'], 'the words alone: no speaker');
    const h = writer();
    WAIT.paintHomeTag(h, at, { zoom: 1, faction: f, say: w });
    assert.deepEqual(said(h).slice(0, 2).map(x => typeof x), ['string', 'string']);
    assert.ok(said(h).slice(2).join('').startsWith('「') && said(h).slice(2).join('').endsWith('」'), `nation ${f}: after the name and the caption, the words and nothing else`);
    assert.ok(!said(h).some(x => /^—/.test(String(x))), 'and no line that names a speaker');
  }
  assert.equal(WAIT.leaderWords(9), null);
  setLang('en');
  const e = writer();
  WAIT.paintHomeTag(e, at, { zoom: 1, faction: 0, marks: true });
  assert.deepEqual(said(e), ['Aster', 'Your nation\'s land', 'Room for a village']);
  setLang('ja');
});

test('a clear spot beside the standard is kept for the player\'s character, and the map says where it is', () => {
  const at = { x: 500, y: -100 };
  for (const zoom of [0.25, 0.73, 1.15]) {
    const s = WAIT.waitSpotAt(at, zoom), flag = WAIT.standardBox(at, zoom), u = WAIT.waitUnit(zoom);
    assert.ok(s.x < at.x && s.box.x + s.box.w <= flag.x + 1e-9, 'to the left of the pole: the cloth flies to the right');
    assert.ok(s.y >= at.y && s.y - at.y < 0.1 * u, 'its feet on the ground beside the standard\'s foot');
    assert.ok(s.box.h * zoom >= 44, `room for a figure of at least 44 px on screen at zoom ${zoom}: ${(s.box.h * zoom).toFixed(0)}`);
    assert.ok(s.box.h < 1.5 * u, 'under the height of the pole');
    assert.ok(s.box.y + s.box.h <= at.y + 12 / zoom, 'and above the tag, which hangs under the standard\'s foot');
  }
  // the map's own answer: null when nobody waits, else the feet in world and page px, the tile, the room on screen
  const waiting = { overviews: new Map(), ringsOpen: 3, own: [], open: { mode: 'play', ready: true, stage: 'joined', faction: 2 }, survey: { showAll: false, faction: 2, stage: 'joined', province: () => ({ max: 1, sig: '' }), levelAt: () => 1, levelOf: () => 1, candidates: [], villages: [], rev: 0 } };
  const { m } = flatMap();
  assert.equal(m.waitSpot(), null, 'a viewer with a village: nobody waits');
  m.source = () => waiting;
  m.cam.set({ ...m.view, zoom: 0.7 }, { ms: 0 });
  const spot = m.waitSpot();
  assert.equal(spot.faction, 2);
  assert.equal(wedgeOf(spot.tile.p, spot.tile.q), 2, 'in the nation\'s home wedge');
  const home = m.wedgeHome(2, 3);
  assert.ok(spot.world.x < home.x && Math.abs(spot.world.y - home.y) < RADIUS);
  const p = m.project(spot.world.x, spot.world.y);
  assert.deepEqual([spot.client.x, spot.client.y], [p.x, p.y]);
  assert.ok(spot.height >= 44 && spot.scale === 1, 'on a flat board the row is drawn at its own size');
  m.source = () => ({ ...waiting, survey: { ...waiting.survey, stage: 'final' } });
  assert.equal(m.waitSpot(), null);
  m.destroy();
});

test('the wait is seen with room about the wedge, the camera a little to its outer side; the wedge is lit, not outlined', () => {
  const src = { ringsOpen: 3, own: [] };
  for (let f = 0; f < 6; f++) {
    const hint = opening.openHint({ mode: 'play', land: { stage: 'joined' }, citizen: { faction: f } });
    const w = opening.openingPlan(hint, src, desk), box = opening.wedgeBox(f, 3);
    assert.equal(w.kind, 'wedge');
    const tl = fmap.worldToScreen(w.view, desk, box.x - box.width / 2, box.y - box.height / 2), br = fmap.worldToScreen(w.view, desk, box.x + box.width / 2, box.y + box.height / 2);
    assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= desk.width && br.y <= desk.height, `nation ${f}: the whole wedge is in the picture`);
    // the picture's middle lies beyond the wedge's own middle, away from the Concord
    assert.ok(Math.hypot(w.at.x, w.at.y) > Math.hypot(box.x, box.y), `nation ${f}: the camera looks to the outer side`);
  }
  assert.ok(opening.WEDGE_VIEW.fill > 0.7 && opening.WEDGE_VIEW.fill < 0.92 && opening.WEDGE_VIEW.out > 0 && opening.WEDGE_VIEW.out <= 0.08);
  assert.ok(WEDGE_WAIT.fill < WEDGE_WAIT.glow && WEDGE_WAIT.glow <= 0.5, 'a wash over all of it, and a stronger light about the standard: softly');
});
