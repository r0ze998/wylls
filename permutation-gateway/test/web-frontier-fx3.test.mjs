// The effects' second pass (UX-DESIGN §11.14; permutation-server/web/frontier/fx/
// safe.mjs, engine.mjs, effects.mjs, draw.mjs, pieces.mjs, stage.mjs, battle.mjs
// and people/battle.mjs): the HUD-free rectangle and how words keep inside it,
// the one way from the map to the screen (`anchor`, with a tilted map's
// `project`), the top canvas inside a stage element, what the map is told
// while a set piece plays, a battle sized to the stage, the hit as added
// light, loss numbers that are readable on their first frame, flat ribbons,
// the departing column, captions on tags, the toll's banner before the
// turn's results, and a sample for every ordinary action. What it looks like
// is judged from the demo switch's frame strips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../permutation-server/web/frontier/fx/clock.mjs';
import { createBus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { createEngine } from '../../permutation-server/web/frontier/fx/engine.mjs';
import { installEffects, bannerGone, POP_SECS, POP_FROM } from '../../permutation-server/web/frontier/fx/effects.mjs';
import { installStage, playSealed, playReveal, TOLL_BANNER_AT, TOLL_BANNER_SECS, TOLL_CLEAR } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { COLUMN_SECS, COLUMN_REACH, FORMING_SECS } from '../../permutation-server/web/frontier/fx/pieces.mjs';
import { smoothPath, ribbonEdges, ribbon, RIBBON_PX, RIBBON_DASH } from '../../permutation-server/web/frontier/fx/draw.mjs';
import { freeFrom, freeOf, placeBox, spanOf, normRect, hudOwnBoxes, HUD_PIECES, HUD_IDS } from '../../permutation-server/web/frontier/fx/safe.mjs';
import { stageBattle, battleFrame, dustColors, BATTLE_ZOOM } from '../../permutation-server/web/frontier/fx/battle.mjs';
import { SAMPLES, DEMO_SCENES } from '../../permutation-server/web/frontier/fx/demo.mjs';
import * as B from '../../permutation-server/web/frontier/people/battle.mjs';
import { RADIUS, project } from '../../permutation-server/web/map.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const WEB = fileURLToPath(new URL('../../permutation-server/web/frontier/', import.meta.url));

/** A context whose methods do nothing; it keeps the texts (with their size and alpha on screen), the ellipses (with their fill) and the dashes it was asked for. */
function recCtx(zoom = 1) {
  const calls = new Map(), texts = [], discs = [], dashes = [];
  const noop = () => {};
  let scale = 1, tx = 0;
  const stack = [];
  return new Proxy({}, {
    get: (o, k) => {
      if (k in o) return o[k];
      if (k === 'calls') return calls;
      if (k === 'texts') return texts;
      if (k === 'discs') return discs;
      if (k === 'dashes') return dashes;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (k === 'save') return () => { stack.push([scale, tx]); };
      if (k === 'restore') return () => { [scale, tx] = stack.pop() ?? [1, 0]; };
      if (k === 'scale') return sx => { scale *= sx; };
      if (k === 'translate') return x => { tx += x * scale; };
      if (k === 'setLineDash') return d => { dashes.push([...d]); };
      if (k === 'ellipse') return (x, y, rx, ry) => { discs.push({ x: tx + x * scale, y, rx, ry, fill: o.fillStyle }); };
      if (k === 'fillText') return text => { const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(o.font ?? '')?.[1] ?? '0'); texts.push({ text: String(text), px: px * scale * zoom, alpha: o.globalAlpha ?? 1, color: o.fillStyle }); };
      return (...a) => { calls.set(k, (calls.get(k) ?? 0) + 1); return undefined; };
    },
    set: (o, k, v) => { o[k] = v; return true; },
  });
}
function handClock() {
  let ms = 1000;
  const c = createClock({ now: () => ms });
  c.now();
  return { c, tick: d => { ms += d; } };
}

/** A page of `width` × `height` with a map canvas over all of it and HUD boxes by selector (`{'#topbar': [l, t, r, b], …}`). */
function fakePage({ width = 1440, height = 900, hud = {} } = {}) {
  const made = [];
  const doc = { head: null, body: null, defaultView: { innerWidth: width, innerHeight: height, getComputedStyle: e => ({ display: 'block', visibility: 'visible', position: e.id === 'panel' ? 'absolute' : 'static' }) } };
  const el = tag => {
    const vars = new Map(), attrs = new Map(), classes = new Set();
    const e = {
      tag, id: '', nodeType: 1, hidden: false, dataset: {}, children: [], parent: null, textContent: '', ownerDocument: doc, vars, classes, box: [0, 0, width, height],
      get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
      classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)), contains: c => classes.has(c) },
      style: { setProperty: (k, v) => vars.set(k, v), getPropertyValue: k => vars.get(k) ?? '', removeProperty: k => vars.delete(k) },
      setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: k => attrs.get(k) ?? null,
      append(...kids) { for (const k of kids) { k.parent?.children?.splice?.(k.parent.children.indexOf(k), 1); k.parent = e; e.children.push(k); } },
      replaceChildren(...kids) { e.children.length = 0; e.append(...kids); },
      after(k) { k.parent = e.parent; const list = e.parent?.children ?? []; list.splice(list.indexOf(e) + 1, 0, k); },
      remove() { const list = e.parent?.children ?? []; const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); e.parent = null; },
      getBoundingClientRect: () => ({ left: e.box[0], top: e.box[1], width: e.box[2] - e.box[0], height: e.box[3] - e.box[1], right: e.box[2], bottom: e.box[3] }),
      offsetLeft: 0, offsetTop: 0, clientWidth: width, clientHeight: height, width: 0, height: 0,
      getContext: () => (e.ctx ??= recCtx()),
      querySelector: () => null,
    };
    made.push(e);
    return e;
  };
  const find = sel => made.filter(e => e.parent && (sel.startsWith('#') ? e.id === sel.slice(1) : sel.startsWith('.') ? e.classes.has(sel.slice(1)) : sel === 'nav.tabs' ? e.tag === 'nav' && e.classes.has('tabs') : false));
  Object.assign(doc, { createElement: el, createElementNS: (_, t) => el(t), getElementById: id => find(`#${id}`)[0] ?? null, querySelector: sel => find(sel)[0] ?? null, querySelectorAll: sel => find(sel) });
  doc.head = el('head'); doc.body = el('body');
  const main = el('main'); doc.body.append(main);
  const canvas = el('canvas'); canvas.id = 'frontier-map'; main.append(canvas);
  const toll = el('p'); toll.id = 'bell-toll'; main.append(toll);
  for (const [sel, box] of Object.entries(hud)) {
    const h = el(sel === 'nav.tabs' ? 'nav' : 'div');
    if (sel.startsWith('#')) h.id = sel.slice(1); else h.className = sel.replace(/^nav\./, '').replace(/^\./, '');
    h.box = box; main.append(h);
  }
  return { doc, main, canvas, toll, width, height };
}

const DESKTOP = { '#topbar': [0, 0, 1440, 48], '#bell-pill': [678, 3, 762, 87], '.dial-top': [708, 75, 732, 99], '#hud-tl': [12, 60, 316, 96], '#rail': [12, 702, 300, 888], '#minimap': [1260, 720, 1428, 888], '#lenses': [1243, 670, 1428, 704], '.map-tools': [1206, 718, 1244, 888], 'nav.tabs': [531, 826, 909, 888] };
// (integration of wave 2: the next-thing button is part of the strip's right plaque now, not a piece of its own on a phone)
const PHONE = { '#topbar': [0, 0, 390, 48], '#bell-pill': [217, 6, 283, 72], '.dial-top': [240, 65, 260, 85], '.map-tools': [338, 126, 382, 320], '#hud-tl': [8, 56, 330, 100], '#minimap': [8, 106, 52, 300], '#panel': [0, 575, 390, 786], 'nav.tabs': [0, 785, 390, 844] };

/** An engine with the vocabulary and the set pieces on a fake page, frames stepped by hand; `map` may carry project / setPiece / hideLabelsAt / flyTo. */
function staged({ motion = 'full', page = fakePage(), map: extra = {} } = {}) {
  const queue = [];
  const raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame, docWas = globalThis.document;
  globalThis.requestAnimationFrame = fn => { queue.push(fn); return queue.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = page.doc;
  const { c: clock, tick } = handClock();
  const bus = createBus();
  const sounds = [];
  const fx = installEffects(createEngine({ clock, motion: () => motion, bus, audio: () => ({ play: (name, o) => { sounds.push([name, o?.delay ?? 0]); return true; } }) }));
  const stage = installStage(fx, { bus });
  const map = { view: { x: 0, y: 0, zoom: 1.3 }, lod: 'tile', art: {}, size: () => ({ width: page.width, height: page.height }), invalidate() {}, ...extra };
  fx.mount({ map, canvas: page.canvas });
  const frames = n => { for (let i = 0; i < n && queue.length; i++) queue.shift()(0); };
  return { ...page, fx, bus, clock, tick, frames, map, sounds, stage, queue,
    run(ms, step = 50) { for (let t = 0; t < ms; t += step) { tick(step); frames(1); } },
    done() { fx.unmount(); stage.off(); globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = caf; if (docWas === undefined) delete globalThis.document; else globalThis.document = docWas; } };
}
const hudNodes = (s, cls) => (s.fx.hud?.children ?? []).filter(k => k.classes.has(cls));
const px = v => parseFloat(v);
/** The figures a context was asked to draw: without sheets (node) a figure stands on a base disc in its nation's colour (people/units.mjs baseDisc; Aster's red of palette.mjs). */
const figuresOf = (ctx, fill = '#cc303b') => ctx.discs.filter(d => d.fill === fill && Math.abs(d.ry / d.rx - 0.16 / 0.46) < 0.01);
const scene = (name, at = { q: 16, r: -7 }) => { const d = DEMO_SCENES[name](at); return { p: 2, q: 0, bell: 43, tiles: [{ idx: 7, hex: at, attackers: d.attackers, defenders: d.defenders }] }; };

// ================================================================== the HUD-free rectangle
test('safe: the HUD-free rectangle is measured from the HUD\'s pieces; a title gets the stage round the middle line, a set piece the stage without the corner pieces', () => {
  const box = (sel, b, kind) => ({ left: b[0], top: b[1], right: b[2], bottom: b[3], kind });
  const kindOf = sel => Object.entries(HUD_PIECES).find(([, list]) => list.includes(sel))?.[0];
  for (const sel of [...Object.keys(DESKTOP), ...Object.keys(PHONE)]) assert.ok(kindOf(sel), `${sel} is a known piece`);
  const boxes = set => Object.entries(set).map(([sel, b]) => box(sel, b, kindOf(sel)));
  // 1440 × 900: the strip is a band; the dial hangs into the stage; the plate, the minimap and the dock stand in its corners and at its foot
  const d = freeFrom({ left: 0, top: 0, width: 1440, height: 900 }, boxes(DESKTOP));
  assert.deepEqual([d.bounds.left, d.bounds.top, d.bounds.right, d.bounds.bottom], [0, 48, 1440, 900]);
  assert.deepEqual([d.centre.left, d.centre.top, d.centre.right, d.centre.bottom], [300, 99, 1206, 826], 'under the dial, over the dock, between the plate and the map buttons');
  assert.deepEqual([d.stage.left, d.stage.top, d.stage.right, d.stage.bottom], [0, 99, 1440, 826], 'a set piece: the corner pieces have stepped back');
  // 390 × 844: between the two columns of buttons, under the dial, over the sheet
  const p = freeFrom({ left: 0, top: 0, width: 390, height: 786 }, boxes(PHONE));
  assert.deepEqual([p.centre.left, p.centre.top, p.centre.right, p.centre.bottom], [52, 100, 338, 575]);
  assert.deepEqual([p.stage.left, p.stage.top, p.stage.right, p.stage.bottom], [0, 85, 390, 575]);
  // a band of heights: what a title may fill there
  assert.deepEqual(p.span(110, 190), { left: 52, right: 338, width: 286 });
  assert.deepEqual(p.span(110, 190, { stage: true }), { left: 0, right: 390, width: 390 });
  assert.deepEqual(d.span(105, 200), { left: 0, right: 1440, width: 1440 });
  // a caption keeps off every piece and inside the bounds, moved as little as it takes
  const off = d.place(150, 800, 120, 26);
  assert.ok(off.moved && !(off.x - 60 < 300 && off.x + 60 > 12 && off.y - 13 < 888 && off.y + 13 > 702), 'off the plate');
  assert.deepEqual(d.place(700, 400, 120, 26), { x: 700, y: 400, moved: false }, 'free land: where it wanted to be');
  const top = d.place(720, 20, 100, 26);
  assert.ok(top.y - 13 >= 48, 'never over the top strip');
  // a soft piece (the guide's chip on the map): a caption keeps off it, a title does not care; the leader never crosses it
  const s = freeFrom({ left: 0, top: 0, width: 1440, height: 900 }, [...boxes(DESKTOP), box('#ob-map', [586, 255, 854, 312], 'soft')]);
  assert.deepEqual([s.centre.top, s.centre.bottom], [99, 826]);
  const tag = s.place(700, 270, 120, 26, 5, { x: 700, y: 360 });
  assert.ok(tag.y - 13 >= 312, 'on the side of the chip its tile is on');
  assert.ok(s.place(700, 270, 120, 26).y + 13 <= 255, 'without a leader: the shortest way out');
  // pure helpers
  assert.deepEqual(placeBox(5, 5, 20, 10, { left: 0, top: 0, right: 100, bottom: 100 }, [], 0), { x: 10, y: 5, moved: true });
  assert.deepEqual(spanOf(0, 10, { left: 0, right: 100, top: 0, bottom: 100 }, [{ left: 0, right: 20, top: 0, bottom: 50 }]), { left: 20, right: 100, width: 80 });
  assert.equal(normRect({ x: 1, y: 2, width: 3, height: 4 }).right, 4);
  assert.equal(normRect(null), null);
});

test('safe: the HUD\'s own freeRect() is taken when it gives one; the page is measured otherwise', () => {
  const page = fakePage({ hud: DESKTOP });
  const measured = freeOf(page.doc, page.canvas);
  assert.deepEqual([measured.centre.left, measured.centre.top, measured.centre.right, measured.centre.bottom], [300, 99, 1206, 826]);
  const was = globalThis.__wyllsHud;
  try {
    globalThis.__wyllsHud = { freeRect: () => ({ left: 100, top: 120, right: 1100, bottom: 700 }) };
    const own = freeOf(page.doc, page.canvas);
    assert.equal(own.hud, true);
    for (const r of [own.bounds, own.centre, own.stage]) assert.deepEqual([r.left, r.top, r.right, r.bottom], [100, 120, 1100, 700]);
    assert.deepEqual(own.place(50, 50, 40, 20, 0), { x: 120, y: 130, moved: true });
    globalThis.__wyllsHud = { freeRect: () => ({ x: 10, y: 20, width: 300, height: 200 }) };
    assert.deepEqual(freeOf(page.doc, page.canvas).bounds.bottom, 220, 'a DOMRect shape is read too');
    globalThis.__wyllsHud = { freeRect: () => null };
    assert.equal(freeOf(page.doc, page.canvas).hud, undefined, 'nothing given: measured');
  } finally { if (was === undefined) delete globalThis.__wyllsHud; else globalThis.__wyllsHud = was; }
});

test('safe: the HUD\'s own list of its pieces (noGo) is read before the page is measured: the plaques are one band, the corner pieces step back for a set piece', () => {
  const page = fakePage({ hud: {} });
  const was = globalThis.__wyllsHud;
  try {
    // what hud/insets.mjs noGoRects gives at 1440 x 900 with a village (ids of NO_GO)
    const list = [['plaque-left', 8, 8, 561, 44], ['dial', 678, 3, 84, 84], ['plaque-right', 942, 8, 490, 44], ['search', 12, 64, 36, 36], ['todo', 26, 783, 210, 28], ['plate', 12, 810, 288, 78],
      ['dock', 529, 826, 382, 62], ['lenses', 1243, 670, 185, 34], ['minimap', 1260, 720, 168, 168], ['map-tools', 1206, 718, 38, 170]].map(([id, x, y, width, height]) => ({ id, x, y, width, height }));
    globalThis.__wyllsHud = { noGo: () => list };
    const st = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
    const boxes = hudOwnBoxes(page.doc, st);
    assert.deepEqual(boxes.find(b => b.width === 1440), { left: 0, top: 0, right: 1440, bottom: 52, width: 1440, height: 52, kind: 'fixed' }, 'the two plaques as one band');
    assert.deepEqual(boxes.filter(b => b.kind === 'ghost').length, HUD_IDS.ghost.filter(id => list.some(r => r.id === id)).length);
    const f = freeOf(page.doc, st);
    assert.equal(f.hud, 'list');
    assert.equal(f.bounds.top, 52, 'under the strip');
    assert.deepEqual([f.centre.left, f.centre.top, f.centre.right, f.centre.bottom], [48, 87, 1206, 783], 'under the dial, over the to-do tab and the plate, between the search button and the map buttons');
    assert.deepEqual([f.stage.left, f.stage.top, f.stage.right, f.stage.bottom], [0, 87, 1440, 826], 'a set piece: the corner pieces have stepped back');
    assert.ok(f.place(720, 20, 100, 26).y - 13 >= 52, 'a caption never stands between the plaques');
    // an open drawer stands 12 px from the side: it is a column, and everything keeps left of it
    globalThis.__wyllsHud = { noGo: () => [...list, { id: 'drawer', x: 1044, y: 64, width: 384, height: 824 }] };
    assert.equal(freeOf(page.doc, st).bounds.right, 1044);
    // nothing listed: the page is measured
    globalThis.__wyllsHud = { noGo: () => [] };
    assert.equal(hudOwnBoxes(page.doc, st), null);
    assert.equal(freeOf(page.doc, st).hud, undefined);
  } finally { if (was === undefined) delete globalThis.__wyllsHud; else globalThis.__wyllsHud = was; }
});

// ================================================================== the engine and a tilted stage
test('engine: one way from the map to the screen (anchor uses map.project when the map has it); the top canvas goes into the stage element it is given', () => {
  // a flat map: the view's own formula over the canvas's box
  let s = staged({ page: fakePage({ width: 800, height: 600 }) });
  try {
    assert.deepEqual(s.fx.anchor(0, 0), { x: 400, y: 300 });
    assert.deepEqual(s.fx.anchor(100, -50), { x: 400 + 130, y: 300 - 65 });
    const back = s.fx.unanchor(530, 235);
    assert.ok(Math.abs(back.x - 100) < 1e-9 && Math.abs(back.y + 50) < 1e-9);
    assert.equal(s.fx.top.parent, s.main, 'by default right after the map canvas, in whatever holds it');
    assert.equal(s.main.children.indexOf(s.fx.top), s.main.children.indexOf(s.canvas) + 1);
    // the integrator's one call: the top canvas moves into the tilted stage
    const stageEl = s.doc.createElement('div'); stageEl.id = 'map-stage'; s.main.append(stageEl);
    assert.equal(s.fx.mount(stageEl), s.fx);
    assert.equal(s.fx.top.parent, stageEl);
    assert.equal(s.fx.mounted, true);
  } finally { s.done(); }
  // a tilted map: its own projection, both ways (an array or a point)
  s = staged({ map: { project: (x, y) => ({ x: 720 + x * 2, y: 450 + y }), unproject: (x, y) => [(x - 720) / 2, y - 450] } });
  try {
    assert.deepEqual(s.fx.anchor(10, 20), { x: 740, y: 470 });
    assert.deepEqual(s.fx.unanchor(740, 470), { x: 10, y: 20 });
    // a caption of the map follows it: the tag is placed through that projection
    s.fx.play('tag', { x: 10, y: 20, text: 'Sealed', icon: 'seal' });
    s.run(300);
    const tag = hudNodes(s, 'fx-tag')[0];
    assert.equal(px(tag.vars.get('--fx-ax')), 740);
    assert.ok(px(tag.vars.get('--fx-ay')) < 470 && px(tag.vars.get('--fx-y')) < px(tag.vars.get('--fx-ay')) - 18, 'the tag stands over its tile on a leader');
  } finally { s.done(); }
  // mount({parent}): the canvas is made inside that element from the start
  const page = fakePage();
  const holder = page.doc.createElement('div'); page.main.append(holder);
  const eng = createEngine({ clock: handClock().c, motion: () => 'full', bus: createBus() });
  const raf = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = () => 0;
  try { eng.mount({ map: { view: { x: 0, y: 0, zoom: 1 }, size: () => ({ width: 100, height: 100 }) }, canvas: page.canvas, parent: holder }); assert.equal(eng.top.parent, holder); eng.unmount(); } finally { globalThis.requestAnimationFrame = raf; }
});

test('engine: while a set piece plays the map is told (setPiece, hideLabelsAt) and the page is marked; all of it is taken back when it ends', () => {
  const told = [];
  const s = staged({ map: { setPiece: on => told.push(['piece', on]), hideLabelsAt: (k, on) => told.push(['hide', k, on]) } });
  try {
    const pieces = [];
    s.bus.on('piece', p => pieces.push([p.name, p.on]));
    s.fx.piece('battle', { dur: 1, tiles: ['2,0,7'], stage: true });
    s.fx.hush({ p: 2, q: 0, tile: 9 }, 0.4, 0.2);
    s.run(100);
    assert.deepEqual(told, [['hide', '2,0,7', true], ['piece', true]]);
    assert.equal(s.doc.body.dataset.fxPiece, 'battle');
    s.run(200);
    assert.deepEqual(told.at(-1), ['hide', '2,0,9', true], 'a hushed tile joins when its effect starts');
    s.run(400);
    assert.deepEqual(told.at(-1), ['hide', '2,0,9', false], 'and is given back when it ends');
    s.run(600);
    assert.deepEqual(told.slice(-2), [['hide', '2,0,7', false], ['piece', false]]);
    assert.equal(s.doc.body.dataset.fxPiece, undefined);
    assert.deepEqual(pieces.filter(p => p[0] === 'battle' || p[1] === false).map(p => p[1]).at(-1), false);
    assert.equal(s.queue.length, 0, 'nothing keeps the frame loop awake afterwards');
    // a piece that is cut short (the engine is cleared) gives everything back at once
    s.fx.piece('battle', { dur: 5, tiles: ['3,1,2'], stage: true });
    s.run(100);
    s.fx.clear();
    assert.deepEqual(told.slice(-2), [['hide', '3,1,2', false], ['piece', false]]);
    assert.equal(s.fx.hush({ p: 1, q: 1 }, 1), null, 'no tile: nothing to hush');
  } finally { s.done(); }
  // the stylesheet: the HUD's corner pieces step back while a set piece has the stage, and nothing there is an animation
  const css = readFileSync(`${WEB}fx/fx.css`, 'utf8');
  // (integration of wave 2: the lens chips are inside #minimap, the next-thing button is part of a plaque that stays, the guide's chip is gone)
  assert.match(css, /body\[data-fx-piece\] :is\(#hud-tl, #rail, #minimap, \.map-tools, \.home-pointer\) \{ opacity: 0; \}/);
  assert.match(css, /body\[data-fx-piece\] :is\([^)]*\):focus-within \{ opacity: 1; \}/, 'a piece that holds the keyboard focus stays in sight');
  assert.doesNotMatch(css, /@keyframes|animation:(?!\s*none)|transition:/);
});

// ================================================================== the battle
test('battle: the scene is sized to the stage the HUD leaves free; a phone stands the sides closer so the figures can be larger', () => {
  const wide = B.battleLayout({ width: 1440, height: 727 }, { title: 128 });
  assert.equal(wide.px, B.FIGURE_PX_MAX);
  assert.equal(wide.rest, 1.6);
  assert.ok(wide.above + wide.below + 128 <= 727, 'title, numbers, figures and bars fit the stage');
  const phone = B.battleLayout({ width: 390, height: 490 }, { title: 96 });
  assert.ok(phone.px >= 60 && phone.px <= 66, `a phone's figures (${phone.px.toFixed(1)} px; 43 px before)`);
  assert.ok(phone.rest < wide.rest);
  assert.ok(2 * phone.bar + 150 <= 390 + 1e-9, 'the two strength bars and their sigils fit the width');
  assert.equal(B.battleLayout({ width: 0, height: 0 }), null);
  assert.ok(B.battleLayout({ width: 200, height: 200 }).px >= 40, 'never under 40 px a figure');
  // the stage follows the layout: the formation spans well over 40% of a 1440 px map
  const plan = B.battlePlan(scene('win'));
  const st = B.battleStage(plan.tiles[0], BATTLE_ZOOM, 1, wide);
  assert.ok(Math.abs(st.s * BATTLE_ZOOM - 120) < 1e-9);
  assert.ok(2 * (st.rest + 1.2) * 120 >= 0.4 * 1440, 'side to side');
  assert.equal(B.battleStage(plan.tiles[0], 1.3).s * 1.3, B.battleScale(1.3) * 1.3, 'without a layout: by the zoom, as before');
});

test('battle: the hit is light added for two frames with a star at the contact, never a white silhouette; loss numbers are ivory, 28 px, at full opacity on their first frame and settle from 1.3 in 120 ms', () => {
  assert.equal(B.HIT_TINT, 0.6);
  assert.equal(B.hitTint(0), 1); assert.equal(B.hitTint(0.033), 1);
  assert.equal(B.hitTint(B.HIT_TINT_SECS[1]), 0);
  assert.ok(B.HIT_TINT_SECS[0] <= 2 / 60 + 0.001 && B.HIT_TINT_SECS[1] <= B.HIT_STOP + 1e-9, 'two frames, gone before the hit-stop ends');
  assert.equal(B.hitTint(-0.01), 0);
  // (the host's figure and the light of a blow on it are drawn by the one painter of the host art, people/minis.mjs
  // paintMini: the battle hands it `flash` at HIT_TINT)
  const src = readFileSync(`${WEB}people/battle.mjs`, 'utf8'), minisSrc = readFileSync(`${WEB}people/minis.mjs`, 'utf8');
  assert.doesNotMatch(src + minisSrc, /whiteCell|fillStyle = '#ffffff'; g\.fillRect/, 'no white copy of a figure is made');
  assert.match(src, /flash: f\.flash > 0\.02 \? f\.flash \* HIT_TINT : 0/, 'the tint is asked for at HIT_TINT');
  assert.match(minisSrc, /globalCompositeOperation = 'lighter';\s*ctx\.globalAlpha = a0 \* alpha \* flash;/, 'and it is added as light');
  // the numbers
  assert.equal(B.LOSS_PX, 28); assert.ok(B.LOSS_PX_FINAL >= 28);
  assert.deepEqual(B.LOSS_POP, { from: 1.3, secs: 0.12 });
  const play = B.startBattle(scene('win'), 0);
  const zoom = 2.1, opts = { zoom, lossText: n => `−${n} 兵`, numText: n => String(n) };
  const first = recCtx(zoom);
  B.paintBattle(first, play, { ...opts, at: B.BATTLE_HITS[0] });
  const born = first.texts.filter(x => /^−\d/.test(x.text));
  assert.deepEqual(born.map(x => x.text), ['−43', '−195'], 'both sides, on the contact frame itself');
  for (const x of born) {
    assert.equal(x.alpha, 1, 'full opacity on its first frame');
    assert.ok(Math.abs(x.px - 28 * 1.3) < 0.01, `1.3 times its size (${x.px.toFixed(2)})`);
    assert.equal(x.color, '#f4efe0', 'ivory');
  }
  const settled = recCtx(zoom);
  B.paintBattle(settled, play, { ...opts, at: B.BATTLE_HITS[0] + 0.12 });
  for (const x of settled.texts.filter(y => /^−\d/.test(y.text))) assert.ok(Math.abs(x.px - 28) < 0.01, 'settled at 28 px after 120 ms');
  const half = recCtx(zoom);
  B.paintBattle(half, play, { ...opts, at: B.BATTLE_HITS[0] + 0.03 });
  for (const x of half.texts.filter(y => /^−\d/.test(y.text))) assert.ok(x.px > 28 && x.px < 28 * 1.3 && x.alpha === 1);
  // a number that would leave the free part of the screen is put back by the page's placer
  const moved = recCtx(zoom);
  const asked = [];
  B.paintBattle(moved, play, { ...opts, at: B.BATTLE_HITS[1] + 0.2, place: (x, y, hw, hh) => { asked.push([hw, hh]); return { x, y }; } });
  assert.equal(asked.length, 2);
  // dust: earth with each nation's colour in it, two different colours for two nations, none grey
  const a = dustColors(B.sideColors(0)), c = dustColors(B.sideColors(2));
  assert.notDeepEqual(a, c);
  for (const hex of [...a, ...c]) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; assert.ok(Math.max(r, g, b) - Math.min(r, g, b) >= 18, `${hex} is not a grey`); }
});

test('battle on the page: a battle the camera is sent to fills the free stage, puts its block in the middle of it and its title inside it, and clears the stage for itself', () => {
  for (const [name, hud, width, height] of [['1440', DESKTOP, 1440, 900], ['390', PHONE, 390, 786]]) {
    const flown = [], told = [];
    const s = staged({ page: fakePage({ width, height, hud }), map: { view: { x: 0, y: 0, zoom: BATTLE_ZOOM }, flyTo: (to, ms, o) => flown.push([to, ms, o]), setPiece: on => told.push(on), hideLabelsAt: (k, on) => told.push([k, on]) } });
    try {
      setLang('ja');
      const frame = battleFrame(s.fx);
      assert.ok(frame.layout.px >= (width > 760 ? 120 : 60), `${name}: figures of ${frame.layout.px.toFixed(0)} px`);
      const play = B.startBattle(scene('win'), 0);
      const h = stageBattle(s.fx, play, { focus: true, zoom: BATTLE_ZOOM, viewerFaction: 0 });
      assert.equal(h.dur, 7, 'still seven seconds');
      // the camera: the tile's centre where the whole block sits in the middle of the stage
      assert.equal(flown.length, 1);
      const [to, ms, o] = flown[0];
      assert.equal(ms, 500); assert.deepEqual(o, { exact: true }); assert.equal(to.zoom, BATTLE_ZOOM);
      const tile = project(16, -7), cy = tile.y + RADIUS * 0.12;
      const onScreen = { x: (tile.x - to.x) * BATTLE_ZOOM + width / 2, y: (cy - to.y) * BATTLE_ZOOM + height / 2 };
      assert.ok(Math.abs(onScreen.x - width / 2) < 0.5 && Math.abs(onScreen.y - frame.y) < 0.5, `${name}: the tile lands where the frame wants it`);
      const st = frame.stage;
      assert.ok(frame.y - frame.layout.above - frame.title >= st.top - 0.5 && frame.y + frame.layout.below <= st.bottom + 0.5, `${name}: the block is inside the stage`);
      // the map's labels make way and the page is marked for as long as it plays
      s.run(100);
      assert.deepEqual(told.slice(0, 2), [['2,0,7', true], true]);
      assert.equal(s.doc.body.dataset.fxPiece, 'battle');
      // the title: inside the stage, under the top strip and the dial, over the scene
      s.map.view = { ...to };
      s.run((B.PHASE.fates + 0.8) * 1000);
      const banner = hudNodes(s, 'fx-banner')[0];
      const mid = px(banner.vars.get('--fx-cy')), left = px(banner.vars.get('--fx-l')), w = px(banner.vars.get('--fx-w'));
      assert.ok(mid > st.top && mid < frame.y - frame.layout.above + 40, `${name}: the title's middle line (${mid.toFixed(0)}) is over the scene, under ${st.top}`);
      assert.ok(left >= st.left - 0.5 && left + w <= st.right + 0.5, `${name}: and between the sides of the stage`);
      s.run(4000);
      assert.equal(told.at(-1), false, 'the stage is given back');
      assert.equal(s.queue.length, 0);
    } finally { s.done(); }
  }
  // a battle that plays where the viewer already looks keeps to its tile: no camera, no layout
  const flown = [];
  const s = staged({ page: fakePage({ hud: DESKTOP }), map: { flyTo: (...a) => flown.push(a) } });
  try {
    stageBattle(s.fx, B.startBattle(scene('win'), 0), { viewerFaction: 0 });
    assert.equal(flown.length, 0);
  } finally { s.done(); }
});

// ================================================================== seal and depart
test('ribbons are flat bands: tapered to a point at both ends, a width that wanders a little, a stitched dash rhythm; never a tube with round caps', () => {
  const path = smoothPath([{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 160, y: 40 }, { x: 240, y: 40 }]);
  const { left, right, mid } = ribbonEdges(path, 10);
  const width = i => Math.hypot(left[i].x - right[i].x, left[i].y - right[i].y);
  assert.ok(width(0) < 0.01 && width(left.length - 1) < 0.01, 'a point at each end');
  const widths = left.map((_, i) => width(i));
  const body = widths.slice(6, -6);
  assert.ok(Math.max(...body) <= 10 * 1.17 && Math.min(...body) >= 10 * 0.83, 'about its width in between');
  assert.ok(Math.max(...body) - Math.min(...body) > 0.5, 'and not the same width all along');
  assert.ok(widths[1] < widths[2] && widths[2] < widths[4], 'the taper swells from the tip');
  assert.equal(mid.length, left.length);
  // drawn part-way: it ends in a point where the pen is
  const part = ribbonEdges(path, 10, { k1: 0.5 });
  assert.ok(Math.hypot(part.left.at(-1).x - part.right.at(-1).x, part.left.at(-1).y - part.right.at(-1).y) < 0.01);
  assert.deepEqual(ribbonEdges(smoothPath([{ x: 0, y: 0 }]), 10).left, []);
  // the painter: a filled band and a dash rhythm, no round caps
  const ctx = recCtx();
  ribbon(ctx, path, { px: 1, color: '#c1504a', k: 1 });
  assert.deepEqual(ctx.dashes[0], [RIBBON_DASH[0], RIBBON_DASH[1]]);
  assert.deepEqual(ctx.dashes.at(-1), [], 'the dash is put away after it');
  assert.equal(ctx.lineCap, 'butt');
  assert.ok((ctx.calls.get('fill') ?? 0) >= 2, 'a shadow and the cloth, as filled shapes');
  assert.ok(RIBBON_PX.sealed < RIBBON_PX.live && RIBBON_PX.live <= 12);
  const src = readFileSync(`${WEB}fx/draw.mjs`, 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export function ribbon('), src.indexOf('export function canvasTag(')), /lineCap = 'round'/);
});

test('seal and depart: the column is seen: a file of figures walks a good two tiles along the ribbon for 2.8 s; in reduced motion it stands on the route instead of being left out', () => {
  assert.ok(COLUMN_SECS >= 2.5 && COLUMN_REACH >= 2, 'long enough and far enough to be seen (it was 1.7 s and 0.8 of a tile)');
  const a = { id: 'Depart#1', name: 'Depart', faction: 0, unit: 0, tile: { p: 2, q: 0, tile: 7 }, dest: { p: 2, q: 0, tile: 32 }, route: { p: 2, q: 0, tile: 7, dirs: [0, 0, 1, 0] } };
  const s = staged();
  try {
    playSealed(s.fx, a);
    assert.deepEqual(s.fx.playing(), ['sealed', 'route', 'stamp', 'walker', 'pip']);
    // the figures: four of them, one behind another most of a figure apart (fix pass 2: five at half a figure ran their
    // ground shadows into one dark smear), spread along the route and moving on
    const origin = project(tileHex(2, 0, 7).q, tileHex(2, 0, 7).r);
    const spreadAt = ms => { s.run(ms); const ctx = recCtx(1.3); s.fx.drawTop(ctx, { t: s.clock.now(), view: s.map.view, size: s.map.size() }); const xs = figuresOf(ctx).map(i => i.x); return { n: xs.length, min: Math.min(...xs), max: Math.max(...xs) }; };
    const early = spreadAt(1200), late = spreadAt(900);
    assert.ok(early.n >= 3, 'the head of the file is on the map');
    assert.equal(late.n, 4, 'four figures on the map');
    assert.ok(early.max - early.min > RADIUS * 0.8, 'a file, not one spot');
    assert.ok(late.max > early.max + RADIUS * 0.5, 'and it walks on');
    assert.ok(late.max - origin.x > RADIUS * 2.2, 'well out of the village');
    s.run(3000);
    assert.deepEqual(s.fx.playing(), ['sealed'], 'the ribbon rests');
    // at rest: the ribbon, its seal and its caption on a tag (canvas: it lies on the land for minutes and wakes nothing)
    const ground = recCtx(1.3);
    s.fx.paintGround(ground, { zoom: 1.3 });
    assert.ok(ground.texts.some(x => x.text === '封印済み · あなたにだけ見えます' && /Mincho|serif/.test(String(ground.font))), 'the caption, in the serif');
    assert.ok((ground.calls.get('roundRect') ?? 0) >= 1, 'on a plate');
    assert.equal(s.queue.length, 0);
  } finally { s.done(); }
  const r = staged({ motion: 'reduced' });
  try {
    playSealed(r.fx, a);
    assert.ok(r.fx.playing().includes('walker'), 'reduced motion still shows that the host left');
    r.run(500);
    const ctx = recCtx(1.3);
    r.fx.drawTop(ctx, { t: r.clock.now(), view: r.map.view, size: r.map.size() });
    const xs = figuresOf(ctx).map(i => i.x);
    r.run(600);
    const again = recCtx(1.3);
    r.fx.drawTop(again, { t: r.clock.now(), view: r.map.view, size: r.map.size() });
    assert.ok(xs.length >= 3 && Math.abs(Math.max(...xs) - Math.max(...figuresOf(again).map(i => i.x))) < 1e-6, 'standing, not travelling');
    assert.equal(r.fx.particles.count, 0);
  } finally { r.done(); }
});

// ================================================================== captions and words
test('captions are tags (bell metal, the serif, a leader to the tile); words and tags keep inside what the HUD leaves free and are shown in every motion level', () => {
  for (const level of ['full', 'reduced', 'off']) {
    const s = staged({ motion: level, page: fakePage({ hud: DESKTOP }) });
    try {
      // a tile under the village plate (bottom left): the tag moves off the plate, the leader still starts at the tile
      const w = s.fx.unanchor(150, 800);
      const made = s.fx.play('tag', { x: w.x, y: w.y, text: '伐採場が完成', icon: 'hammer' });
      assert.equal(made.length, 1, `${level}: a caption is information`);
      s.run(400);
      const tag = hudNodes(s, 'fx-tag')[0];
      const plate = tag.children.find(k => k.classes.has('fx-tag-plate'));
      assert.ok(tag.children.some(k => k.classes.has('fx-tag-lead')) && tag.children.some(k => k.classes.has('fx-tag-dot')));
      assert.equal(plate.children.at(-1).textContent, '伐採場が完成');
      assert.equal(plate.children[0].children[0].getAttribute('href'), 'art/ui/icons.svg#hammer', 'the HUD\'s own icon');
      const x = px(tag.vars.get('--fx-x')), y = px(tag.vars.get('--fx-y'));
      assert.ok(!(x > 12 - 60 && x < 300 + 60 && y > 702 - 13 && y < 888 + 13), `${level}: off the plate (${x}, ${y})`);
      assert.equal(px(tag.vars.get('--fx-ax')), 150);
      assert.ok(px(tag.vars.get('--fx-len')) > 10, 'a leader of some length');
      assert.ok(Number(tag.vars.get('--fx-o')) > 0.9, `${level}: visible`);
      // a word over a tile near the top strip stays under it
      const top = s.fx.unanchor(700, 60);
      s.fx.play('label', { x: top.x, y: top.y, text: '−120', lift: 0 });
      s.run(100);
      const word = hudNodes(s, 'fx-word')[0];
      assert.ok(px(word.vars.get('--fx-y')) - 14 >= 48, `${level}: never over the strip`);
      if (level === 'full') assert.ok(Number(word.vars.get('--fx-o')) === 1 && Number(word.vars.get('--fx-s')) > 1, 'there at once, larger, settling');
      // a caption whose tile is not on the map on screen is not shown
      const away = s.fx.unanchor(-400, 400);
      s.fx.play('tag', { x: away.x, y: away.y, text: 'x' });
      s.run(200);
      assert.equal(Number(hudNodes(s, 'fx-tag').at(-1).vars.get('--fx-o')), 0);
      // (integration of wave 2: and it takes no place on the page: its leader would reach past the screen's edge to the tile)
      assert.equal(hudNodes(s, 'fx-tag').at(-1).hidden, true);
    } finally { s.done(); }
  }
  assert.equal(POP_SECS, 0.12); assert.equal(POP_FROM, 1.3);
  // words are nodes of the page: when the language changes, the ones written in the language before are taken down at once
  setLang('ja');
  const l = staged();
  try {
    l.fx.play('label', { q: 3, r: -2, text: 'ラマールの町', serif: true, dur: 3 });
    l.fx.play('tag', { q: 3, r: -2, text: '伐採場が完成', dur: 3 });
    l.fx.play('flash', { q: 3, r: -2 });
    l.run(200);
    assert.equal(hudNodes(l, 'fx-word').length + hudNodes(l, 'fx-tag').length, 2);
    setLang('en');
    assert.equal(hudNodes(l, 'fx-word').length + hudNodes(l, 'fx-tag').length, 0, 'no caption is left standing in the old language');
    assert.ok(l.fx.playing().includes('flash'), 'what is not words plays on');
  } finally { l.done(); setLang('ja'); }
  const css = readFileSync(`${WEB}fx/fx.css`, 'utf8');
  const plate = /\.fx-tag-plate\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(plate, /Mincho|serif/); assert.match(plate, /#10221f/, 'bell metal');
  assert.match(css, /\.turn-strip \{ background: linear-gradient\(180deg, #1b342e, #0d1d1a\); \}/, 'the turn card is opaque');
});

// ================================================================== the bell
test('the bell: the banner sits under the dial inside the free stage, breaks between its two parts on a phone, and has faded under a tenth before this turn\'s results begin', () => {
  assert.ok(Math.abs(TOLL_CLEAR - (TOLL_BANNER_AT + bannerGone(TOLL_BANNER_SECS))) < 1e-9);
  for (const [name, hud, width, height] of [['1440', DESKTOP, 1440, 900], ['390', PHONE, 390, 786]]) {
    const s = staged({ page: fakePage({ width, height, hud }) });
    try {
      setLang('ja');
      const got = [];
      s.bus.on('turn:results', p => got.push(p));
      s.bus.emit('bell', { turn: 43 });
      s.bus.emit('feed', { turn: 43, fresh: [{ id: 'rv:1', kind: 'march', p: 2, q: 0, tile: 7 }] });
      assert.ok(Math.abs(got[0].startsIn - TOLL_CLEAR) < 1e-6, 'the results (and their card) wait for the banner');
      s.run(1200);
      const mid = px(s.toll.vars.get('--fx-cy')), left = px(s.toll.vars.get('--fx-l')), w = px(s.toll.vars.get('--fx-w'));
      const free = s.fx.free();
      assert.ok(mid > free.centre.top && mid < free.centre.top + 120, `${name}: right under the dial (${mid.toFixed(0)})`);
      if (width < 760) {
        assert.equal(s.toll.dataset.wrap, 'true', 'two lines on a phone');
        assert.ok(left >= 52 - 0.5 && left + w <= 338 + 0.5, 'between the two columns of buttons');
        assert.ok(px(s.toll.vars.get('--fx-fs')) >= 22, 'at a size worth reading');
      } else assert.equal(s.toll.dataset.wrap, 'false');
      // the banner's own opacity when the results begin
      s.run((TOLL_CLEAR - 1.2) * 1000, 10);
      assert.ok(Number(s.toll.vars.get('--fx-o')) < 0.1 || s.toll.hidden, `${name}: under a tenth at ${TOLL_CLEAR.toFixed(2)} s`);
    } finally { s.done(); }
  }
});

// ================================================================== ordinary actions
test('every ordinary action has a demo sample; a muster forms up large beside its tile; land that comes out of the chart is counted once', () => {
  for (const n of ['built', 'harvest', 'muster', 'reveal', 'pending', 'refused', 'camp', 'village', 'action', 'landed']) assert.ok(typeof SAMPLES[n]?.run === 'function', `a sample for ${n}`);
  assert.ok(FORMING_SECS >= 2);
  const s = staged();
  try {
    setLang('ja');
    // the reveal: ink lifts off each tile as its paint comes, one caption counts the survey
    const tiles = [0, 1, 2, 3].map(i => ({ q: 10 + i, r: -4, at: 0.1 * i }));
    playReveal(s.fx, { tiles, seed: 'unit' });
    assert.ok(s.sounds.some(x => x[0] === 'shimmer'));
    assert.equal(s.fx.playing().filter(n => n === 'tag').length, 1);
    s.run(1200);
    assert.equal(hudNodes(s, 'fx-tag')[0].children.at(-1).children.at(-1).textContent, '新しく 4 マスを測量しました');
    s.fx.clear();
    playReveal(s.fx, { tiles: tiles.slice(0, 2) });
    assert.equal(s.fx.playing().filter(n => n === 'tag').length, 0, 'a tile or two: no caption');
    // (integration of wave 2) land that only came into the picture (the candidate sites of the wait) is not called a survey
    s.fx.clear();
    playReveal(s.fx, { tiles, caption: false });
    assert.equal(s.fx.playing().filter(n => n === 'tag').length, 0, 'no words');
    assert.ok(s.fx.playing().includes('ripple'), 'the land still comes out of the chart');
    // the page's own event: the tiles are read from the map's survey, each reveal once
    s.fx.clear();
    const reveals = new Map([[(12 + 2048) * 4096 + (-5 + 2048), 0], [(13 + 2048) * 4096 + (-5 + 2048), 80], [(14 + 2048) * 4096 + (-5 + 2048), 160]]);
    s.map.source = () => ({ survey: { reveals } });
    s.bus.emit('reveal', { n: 3 });
    assert.equal(s.fx.playing().filter(n => n === 'tag').length, 1);
    const before = s.fx.playing().length;
    s.bus.emit('reveal', { n: 3 });
    assert.ok(s.fx.playing().length - before <= 1, 'the same tiles are not played again');
    // a muster: seven figures at the size of the map's hosts, in front of the tile (not on it)
    s.fx.clear();
    s.bus.emit('moment', { kind: 'muster', p: 2, q: 0, tile: 7, faction: 0, unit: 0, own: true });
    s.run(1200);
    const ctx = recCtx(1.3);
    s.fx.drawTop(ctx, { t: s.clock.now(), view: s.map.view, size: s.map.size() });
    assert.equal(figuresOf(ctx).length, 7);
  } finally { s.done(); }
  // a harvest in reduced motion: nothing flies, a word says it
  const r = staged({ motion: 'reduced' });
  try {
    r.bus.emit('moment', { kind: 'harvest', p: 2, q: 0, tile: 7, faction: 0, own: true, site: 0 });
    assert.ok(r.fx.playing().includes('tag') && !r.fx.playing().includes('fly'));
  } finally { r.done(); }
  setLang('en');
  const e = staged({ motion: 'off' });
  try {
    playReveal(e.fx, { tiles: [0, 1, 2].map(i => ({ q: i, r: 0, at: 0 })) });
    e.run(600);
    assert.equal(hudNodes(e, 'fx-tag')[0].children.at(-1).children.at(-1).textContent, 'Surveyed 3 new tiles');
  } finally { e.done(); setLang('ja'); }
});
