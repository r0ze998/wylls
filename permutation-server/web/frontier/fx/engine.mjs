// The effects engine (UX-DESIGN §8.1). Three places an effect can be drawn:
//
//   ground  inside the tile painter, after the territory wash and before the
//           props, so trees and buildings stand on it (`paintGround`, called
//           from map/sprites.mjs). When the map is not painting tiles (far
//           view, vector tiles) the same effects are drawn on the top canvas.
//   top     a second, transparent canvas laid exactly over #frontier-map, in
//           the map's world space (it reads the map's drawn view every frame,
//           so it follows pan and zoom), plus `screen` effects in CSS pixels
//           of that canvas. Its frame loop runs only while something is live.
//   hud     `#fx-hud`, a persistent aria-hidden layer of DOM nodes over the
//           whole viewport (appended to <body> by script, pointer-events
//           none) for screen-space things (a result title, floating numbers,
//           the bell's overlay, a status-chip burst). Its nodes are driven by
//           the same clock through CSS custom properties, never by CSS
//           animations, so a frozen clock freezes them too.
//
// The world shake moves the two canvases only (CSS `translate` through two
// custom properties): the HUD never moves.
//
// Under a tilted map (UX-DESIGN §11.1) the top canvas lives inside the tilted
// stage with the ground canvas (`mount({parent})` or `mount(stageEl)`), and a
// world point is found on screen through ONE function, `anchor(x, y)`, which
// asks `map.project` when the map has it. Words keep inside what the HUD
// leaves free (`free()`, fx/safe.mjs). While a set piece plays the map is told
// (`map.setPiece`, `map.hideLabelsAt`) so its labels make way.
//
// Everything is tolerant of what it is given: no DOM (node tests), a context
// whose methods do nothing (the map tests draw into a proxy), no map.
import { clock as defaultClock } from './clock.mjs';
import { createParticles } from './particles.mjs';
import { motion as defaultMotion } from './motion.mjs';
import { hashSeed, noise1 } from './rand.mjs';
import { bus as defaultBus } from './bus.mjs';
import { audio as defaultAudio } from './audio.mjs';
import { freeOf } from './safe.mjs';

export const SHAKE_PX = Object.freeze([2, 8]);
export const SHAKE_MS = Object.freeze([120, 250]);
/** The device pixel ratio the canvases use (the map's own cap). */
export const DPR_CAP = 2;

/** The canvas transform that puts world space on screen: the map's own formula (fmap.mjs draw). */
export const worldTransform = (view, size, dpr = 1) => [dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * (size.width / 2 - view.x * view.zoom), dpr * (size.height / 2 - view.y * view.zoom)];
/** A world point in CSS pixels of the map canvas. */
export const toScreen = (view, size, x, y) => ({ x: (x - view.x) * view.zoom + size.width / 2, y: (y - view.y) * view.zoom + size.height / 2 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const LAYERS = Object.freeze(['ground', 'top', 'screen', 'hud']);

/**
 * An engine. The page uses the default one (`fx` below); tests make their own
 * with a hand-driven clock.
 */
export function createEngine({ clock = defaultClock, motion = defaultMotion, bus = defaultBus, audio = defaultAudio, capacity = 2048 } = {}) {
  const particles = createParticles({ capacity });
  const effects = [];
  const shakes = [];
  const defs = new Map();
  const painters = { ground: [], over: [] };   // painters that live inside the tile painter for as long as the page does (idle life)
  let nextId = 1, version = 0;
  let m = null;            // the mount: {map, canvas, top, ctx, hud, camera, size, invalidate, groundInPainter}
  let running = false, lastSig = '', lastGroundAsk = 0;
  let keep = false;        // the demo: finished effects stay so the clock can be rewound
  const pieces = [];       // set pieces and hushed tiles: {name, t0, t1, tiles, stage}
  let pieceSig = '', hushed = new Set(), staging = false;
  let freeAt = -Infinity, freeNow = null;

  const view = () => {
    try { const v = m?.camera?.(); if (v && Number.isFinite(v.zoom) && v.zoom > 0) return v; } catch { /* a camera that is not ready */ }
    return { x: 0, y: 0, zoom: 1 };
  };
  const size = () => {
    try { const s = m?.size?.(); if (s && s.width > 0) return s; } catch { /* no layout yet */ }
    return { width: 0, height: 0 };
  };
  const inPainter = () => { try { return !!m?.groundInPainter?.(); } catch { return false; } };

  const ageOf = (e, t) => t - e.t0;
  const liveAt = (e, t) => { const a = ageOf(e, t); return a >= 0 && a < e.dur; };
  const pendingAt = (e, t) => ageOf(e, t) < 0;

  /**
   * A world point on screen, in client px: THE way from the map to the page (titles, captions, numbers,
   * tokens that fly to the HUD). The map's own `project` when it has one (a tilted stage, UX-DESIGN §11.1);
   * else the mount's `toViewport`; else the flat view over the canvas's box.
   */
  function anchor(x, y, v = view(), sz = size()) {
    try {
      const p = m?.map?.project?.(x, y);
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) return { x: p[0], y: p[1] };
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
    } catch { /* a map that is not ready */ }
    if (m?.toViewport) { const p = m.toViewport(x, y); if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p; }
    const p = toScreen(v, sz, x, y), r = m?.crect ?? m?.rect;
    return r ? { x: p.x + r.left, y: p.y + r.top } : p;
  }
  /** The other way: a client point in world px (the map's `unproject`, else the flat view). */
  function unanchor(cx, cy, v = view(), sz = size()) {
    try {
      const p = m?.map?.unproject?.(cx, cy);
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) return { x: p[0], y: p[1] };
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
    } catch { /* a map that is not ready */ }
    const r = m?.crect ?? m?.rect ?? { left: 0, top: 0 };
    return { x: (cx - r.left - sz.width / 2) / v.zoom + v.x, y: (cy - r.top - sz.height / 2) / v.zoom + v.y };
  }
  /**
   * What the HUD leaves free of the map, in client px (fx/safe.mjs): `{bounds, centre, boxes, place}`.
   * Measured at most four times a second (and again after a resize).
   */
  function free() {
    const w = clock.wall?.() ?? 0;
    if (freeNow && w - freeAt < 250) return freeNow;
    freeAt = w;
    const doc = m?.canvas?.ownerDocument ?? null;
    const sz = size(), st = m?.rect ?? { left: 0, top: 0, width: sz.width, height: sz.height };
    try { freeNow = freeOf(doc, st); } catch { freeNow = freeOf(null, st); }
    return freeNow;
  }

  function stateOf(e, t, v, sz) {
    const age = ageOf(e, t);
    return { t: age, k: e.dur > 0 ? clamp(age / e.dur, 0, 1) : 1, dur: e.dur, now: t, zoom: v.zoom, px: 1 / v.zoom, mode: e.mode, seed: e.seed, view: v, size: sz,
      // the map's box in the viewport (HUD nodes are placed in viewport pixels) and a world point in that frame
      stage: m?.rect ?? { left: 0, top: 0, width: sz.width, height: sz.height, free: sz.height },
      toScreen: (x, y) => toScreen(v, sz, x, y),
      anchor: (x, y) => anchor(x, y, v, sz), unanchor: (x, y) => unanchor(x, y, v, sz), toViewport: (x, y) => anchor(x, y, v, sz),
      get free() { return free(); } };
  }

  /**
   * Add one effect: `{layer, dur, draw(ctx, s), delay?, at?, seed?, info?, dom?, name?}`.
   * `draw` gets the context (world space for ground and top, CSS px for screen)
   * and `s` = {t (seconds since its start), k (0..1), dur, zoom, px (one screen
   * pixel in world units), mode, seed, view, size, toScreen}. `dom` = {make(doc)
   * → element, update(el, s)} puts a node in #fx-hud for the effect's life.
   * `info: true` marks what must be shown even with effects off (a number, a
   * verdict). Returns a handle {id, cancel()} or null when nothing was added.
   */
  function add(spec) {
    if (!spec || !(spec.dur > 0)) return null;
    const mode = spec.mode ?? motion();
    if (mode === 'off' && !spec.info) return null;
    const layer = LAYERS.includes(spec.layer) ? spec.layer : 'top';
    const now = clock.now();
    const e = {
      id: nextId++, name: spec.name ?? '', layer, mode,
      t0: (spec.at ?? now) + (spec.delay ?? 0), dur: spec.dur,
      draw: typeof spec.draw === 'function' ? spec.draw : null,
      dom: spec.dom ?? null, el: null, seed: typeof spec.seed === 'number' ? spec.seed : hashSeed(spec.seed ?? spec.name ?? nextId),
      info: !!spec.info, onEnd: spec.onEnd ?? null, still: !!spec.still, shown: false,
    };
    effects.push(e);
    version++;
    if (e.still) { try { m?.invalidate?.(); } catch { /* no map */ } }
    kick();
    return { id: e.id, cancel: () => remove(e) };
  }

  function remove(e) {
    const i = effects.indexOf(e);
    if (i < 0) return;
    effects.splice(i, 1);
    if (e.dom?.el) { if (e.shown) { try { e.dom.off?.(e.dom.el); } catch { /* the page's element is gone */ } } }
    else { try { e.el?.remove?.(); } catch { /* already gone */ } }
    e.el = null; e.shown = false;
    version++;
    if (e.still) { try { m?.invalidate?.(); } catch { /* no map */ } }
  }

  /** Launch particles (nothing in the reduced and off modes). Same options as particles.emit; `t` defaults to now. */
  function emit(kind, opts = {}) {
    if ((opts.mode ?? motion()) !== 'full') return 0;
    const n = particles.emit(kind, { ...opts, t: (opts.t ?? clock.now()) + (opts.delay ?? 0) });
    if (n) { version++; kick(); }
    return n;
  }

  /** Shake the world layer: 2 to 8 px for 120 to 250 ms (clamped), never the HUD; full motion only. */
  function shake(px = 4, ms = 180, { seed = 0, delay = 0 } = {}) {
    if (motion() !== 'full') return false;
    shakes.push({ t0: clock.now() + delay, dur: clamp(ms, SHAKE_MS[0], SHAKE_MS[1]) / 1000, amp: clamp(px, SHAKE_PX[0], SHAKE_PX[1]), seed: hashSeed(seed) & 0xffff });
    kick();
    return true;
  }

  /** The world layer's offset in CSS px at clock time t (the sum of the live shakes, at most 8 px). */
  function shakeAt(t) {
    let x = 0, y = 0;
    for (const s of shakes) {
      const k = (t - s.t0) / s.dur;
      if (k < 0 || k >= 1) continue;
      const a = s.amp * (1 - k) * (1 - k);
      x += a * noise1(t * 46, s.seed); y += a * 0.75 * noise1(t * 46 + 31.7, s.seed + 7);
    }
    const mag = Math.hypot(x, y);
    if (mag > SHAKE_PX[1]) { x *= SHAKE_PX[1] / mag; y *= SHAKE_PX[1] / mag; }
    return { x, y };
  }

  function counts(t) {
    let live = 0, pending = 0, ground = 0;
    for (const e of effects) {
      if (e.still) continue;   // a still effect is drawn whenever the map paints; it never keeps the frame loop awake
      if (liveAt(e, t)) { live++; if (e.layer === 'ground') ground++; }
      else if (pendingAt(e, t)) pending++;
    }
    const pl = particles.liveAt(t), pg = pl ? particles.liveAt(t, 'ground') : 0;
    let sh = 0;
    for (const s of shakes) if (t < s.t0 + s.dur) sh++;
    for (const p of pieces) { if (t >= p.t0 && t < p.t1) live++; else if (t < p.t0) pending++; }
    return { live: live + pl + sh, pending: pending + (t < particles.until && !pl ? 1 : 0), ground: ground + pg };
  }

  function drawLayer(ctx, layer, t, v, sz) {
    let n = 0;
    for (const e of effects) {
      if (e.layer !== layer || !e.draw || !liveAt(e, t)) continue;
      ctx.save?.();
      try { e.draw(ctx, stateOf(e, t, v, sz)); n++; } catch (err) { globalThis.console?.warn?.('fx:', e.name, err); e.draw = null; }
      ctx.restore?.();
    }
    return n;
  }

  /**
   * The ground pass, for the tile painter: `paintGround(ctx, {zoom})` with the
   * context already in the map's world space. Returns how many things it drew.
   */
  function paintGround(ctx, { zoom = 1, tiles = null } = {}) {
    let n = runPainters('ground', ctx, zoom, tiles);
    if (!effects.length && !particles.count) return n;
    const t = clock.now();
    const v = { ...view(), zoom }, sz = size();
    n += drawLayer(ctx, 'ground', t, v, sz) + particles.draw(ctx, t, { layer: 'ground', zoom });
    return n;
  }

  /**
   * The pass over the props, for the tile painter: `paintOver(ctx, {zoom, tiles})`
   * after the land's props and holdings, before the hosts. Only the standing
   * painters use it (cloud shadows, chimney smoke: fx/idle.mjs).
   */
  function paintOver(ctx, { zoom = 1, tiles = null } = {}) { return runPainters('over', ctx, zoom, tiles); }

  function runPainters(layer, ctx, zoom, tiles) {
    const list = painters[layer];
    if (!list.length) return 0;
    const mode = motion();
    const st = { t: clock.now(), zoom, px: 1 / zoom, tiles: tiles ?? [], mode, view: { ...view(), zoom }, size: size(), invalidate: () => { try { m?.invalidate?.(); } catch { /* no map */ } } };
    let n = 0;
    for (const fn of list) {
      ctx.save?.();
      try { n += fn(ctx, st) || 0; } catch (err) { globalThis.console?.warn?.('fx painter:', err); }
      ctx.restore?.();
    }
    return n;
  }

  /**
   * The top pass into `ctx` (the effects canvas, or any context): world-space
   * effects and particles through `view`, then screen-space effects in CSS
   * px. `ground: true` also draws the ground layer here (the map is not
   * painting tiles). Pure: no DOM, no clock read.
   */
  function drawTop(ctx, { t, view: v, size: sz, dpr = 1, ground = false }) {
    const w = worldTransform(v, sz, dpr);
    let n = 0;
    ctx.setTransform?.(w[0], w[1], w[2], w[3], w[4], w[5]);
    if (ground) n += drawLayer(ctx, 'ground', t, v, sz) + particles.draw(ctx, t, { layer: 'ground', zoom: v.zoom });
    n += drawLayer(ctx, 'top', t, v, sz);
    n += particles.draw(ctx, t, { layer: 'top', zoom: v.zoom });
    ctx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    n += drawLayer(ctx, 'screen', t, v, sz);
    return n;
  }

  // ------------------------------------------------------------------ the DOM side
  const setVar = (el, k, v) => { try { el?.style?.setProperty?.(k, v); } catch { /* not an element */ } };

  /**
   * Lay the top canvas exactly over the map canvas (same offset parent, its box in
   * custom properties) and tell the HUD layer, which covers the viewport, where the
   * map shows through: `--fx-l/t/w/h` and `--fx-free` (the height no bottom sheet covers).
   */
  function syncBox() {
    if (!m?.top) return;
    const c = m.canvas, st = m.stage ?? c;
    setVar(m.top, '--fx-l', `${c.offsetLeft ?? 0}px`); setVar(m.top, '--fx-t', `${c.offsetTop ?? 0}px`);
    setVar(m.top, '--fx-w', `${c.clientWidth ?? 0}px`); setVar(m.top, '--fx-h', `${c.clientHeight ?? 0}px`);
    const r = st.getBoundingClientRect?.() ?? { left: 0, top: 0, width: c.clientWidth ?? 0, height: c.clientHeight ?? 0 };
    let free = r.height;
    try {
      // a phone's bottom sheet (#panel laid over the map) hides the lower part: effects centre in what is left
      const doc = c.ownerDocument, panel = doc?.getElementById?.('panel'), win = doc?.defaultView;
      if (panel && win && win.getComputedStyle(panel).position === 'absolute') {
        const p = panel.getBoundingClientRect();
        if (p.top > r.top && p.top < r.top + r.height) free = Math.max(r.height * 0.3, p.top - r.top);
      }
    } catch { /* no layout */ }
    m.rect = { left: r.left, top: r.top, width: r.width, height: r.height, free };
    const cr = c.getBoundingClientRect?.();
    m.crect = cr ? { left: cr.left, top: cr.top, width: cr.width, height: cr.height } : null;
    freeAt = -Infinity;
    if (m.hud) {
      setVar(m.hud, '--fx-l', `${r.left}px`); setVar(m.hud, '--fx-t', `${r.top}px`);
      setVar(m.hud, '--fx-w', `${r.width}px`); setVar(m.hud, '--fx-h', `${r.height}px`); setVar(m.hud, '--fx-free', `${free}px`);
    }
  }

  function applyShake(t) {
    if (!m?.canvas) return;
    const s = shakes.length ? shakeAt(t) : { x: 0, y: 0 };
    const sx = `${s.x.toFixed(2)}px`, sy = `${s.y.toFixed(2)}px`;
    if (m.sx === sx && m.sy === sy) return;
    m.sx = sx; m.sy = sy;
    // while it shakes the layer swells by the offset on every side, so the page never shows at an edge
    const sz = size(), least = Math.max(120, Math.min(sz.width || 0, sz.height || 0));
    const mag = Math.hypot(s.x, s.y);
    const ss = mag > 0.01 ? (1 + (2 * mag + 1) / least).toFixed(4) : '1';
    for (const el of [m.canvas, m.top]) { setVar(el, '--fx-sx', sx); setVar(el, '--fx-sy', sy); setVar(el, '--fx-ss', ss); }
  }

  function updateDom(t, v, sz) {
    if (!m?.hud) return;
    for (const e of effects) {
      if (!e.dom) continue;
      const on = liveAt(e, t);
      if (e.dom.el) {
        // an element of the page itself (the bell's banner): driven while live, handed back after
        if (on !== e.shown) { e.shown = on; try { (on ? e.dom.on : e.dom.off)?.(e.dom.el); } catch (err) { globalThis.console?.warn?.('fx hud:', e.name, err); } }
        if (on) { try { e.dom.update?.(e.dom.el, stateOf(e, t, v, sz)); } catch (err) { globalThis.console?.warn?.('fx hud:', e.name, err); } }
        continue;
      }
      if (on && !e.el) {
        try { e.el = e.dom.make(m.hud.ownerDocument); if (e.el) m.hud.append(e.el); } catch (err) { globalThis.console?.warn?.('fx hud:', e.name, err); e.dom = null; continue; }
      }
      if (!e.el) continue;
      if (e.el.hidden !== !on) e.el.hidden = !on;
      if (on) { try { e.dom.update?.(e.el, stateOf(e, t, v, sz)); } catch (err) { globalThis.console?.warn?.('fx hud:', e.name, err); } }
    }
  }

  /**
   * A set piece is on stage: `piece(name, {dur, delay, tiles, stage})`. While it plays the map hides the label
   * pile of each of `tiles` ("p,q,tile": `map.hideLabelsAt(key, true)`), and with `stage: true` (a battle) it is
   * told that a set piece has the screen (`map.setPiece(true)`: every other label goes, the pointer home too);
   * `<body data-fx-piece>` and the bus event `piece {name, on}` say the same to the HUD. All of it is read from
   * the clock, so a frozen or rewound clock (the demo) is right too. Returns `{cancel()}`.
   */
  function piece(name, { dur = 1, delay = 0, tiles = [], stage = false } = {}) {
    if (!(dur > 0)) return null;
    const t0 = clock.now() + delay;
    const p = { name: String(name), t0, t1: t0 + dur, tiles: tiles.filter(k => typeof k === 'string' && k), stage: !!stage };
    pieces.push(p);
    version++;
    kick();
    return { cancel() { const i = pieces.indexOf(p); if (i >= 0) { pieces.splice(i, 1); version++; kick(); } } };
  }
  /** Tell the map and the page what is on stage at clock time t (only when it changed). */
  function syncPieces(t) {
    const on = pieces.filter(p => t >= p.t0 && t < p.t1);
    const keys = new Set(on.flatMap(p => p.tiles)), lead = on.find(p => p.stage) ?? null;
    const sig = `${lead?.name ?? ''}|${[...keys].sort().join(';')}`;
    if (sig !== pieceSig) {
      pieceSig = sig;
      const map = m?.map;
      for (const k of hushed) if (!keys.has(k)) { try { map?.hideLabelsAt?.(k, false); } catch { /* the map's own fault */ } }
      for (const k of keys) if (!hushed.has(k)) { try { map?.hideLabelsAt?.(k, true); } catch { /* the map's own fault */ } }
      hushed = keys;
      if (!!lead !== staging) {
        staging = !!lead;
        try { map?.setPiece?.(staging); } catch { /* the map's own fault */ }
      }
      const body = m?.canvas?.ownerDocument?.body;
      if (body?.dataset) { if (lead) body.dataset.fxPiece = lead.name; else delete body.dataset.fxPiece; }
      try { bus?.emit?.('piece', { name: lead?.name ?? null, on: !!lead, tiles: [...keys] }); } catch { /* no bus */ }
    }
    if (!keep) for (let i = pieces.length - 1; i >= 0; i--) if (t >= pieces[i].t1) pieces.splice(i, 1);
  }

  function prune(t) {
    if (keep) return;
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      if (ageOf(e, t) >= e.dur) { const end = e.onEnd; remove(e); try { end?.(); } catch { /* a callback's own fault */ } }
    }
    for (let i = shakes.length - 1; i >= 0; i--) if (t >= shakes[i].t0 + shakes[i].dur) shakes.splice(i, 1);
  }

  /** One frame now: draw the top canvas, move the HUD nodes, ask the map for a ground repaint. Returns what is live. */
  function frame() {
    const t = clock.now();
    const c = counts(t);
    if (!m) { prune(t); return c; }
    syncPieces(t);
    const v = view(), sz = size();
    const dpr = m.ratio?.() ?? Math.min(globalThis.devicePixelRatio || 1, DPR_CAP);
    const sig = `${t}|${v.x}|${v.y}|${v.zoom}|${sz.width}|${sz.height}|${dpr}|${version}`;
    if (sig !== lastSig) {
      lastSig = sig;
      const ground = !inPainter();
      if (m.top && m.ctx) {
        const W = Math.round(sz.width * dpr), H = Math.round(sz.height * dpr);
        if (m.top.width !== W || m.top.height !== H) { m.top.width = W; m.top.height = H; }
        m.ctx.setTransform(1, 0, 0, 1, 0, 0);
        m.ctx.clearRect(0, 0, W, H);
        if (c.live) drawTop(m.ctx, { t, view: v, size: sz, dpr, ground });
      }
      applyShake(t);
      updateDom(t, v, sz);
      // ground effects live inside the tile painter: ask it for a frame (30 a second is enough under the props)
      if (!ground && (c.ground || m.groundWas)) {
        const w = clock.wall();
        if (w - lastGroundAsk >= 30 || !c.ground) { lastGroundAsk = w; try { m.invalidate?.(); } catch { /* no map */ } }
      }
      m.groundWas = c.ground > 0;
      const mark = String(c.live);
      if (m.canvas?.dataset && m.canvas.dataset.fx !== mark) m.canvas.dataset.fx = mark;
    }
    prune(t);
    return c;
  }

  function loop() {
    const c = frame();
    if ((c.live || c.pending) && m) { m.raf = globalThis.requestAnimationFrame?.(loop); if (!m.raf) running = false; }
    else { running = false; lastSig = ''; if (m?.canvas?.dataset) m.canvas.dataset.fx = '0'; }
  }
  /** Start the frame loop if something is live (after an add, a seek, a resize). */
  function kick() {
    if (!m || running) return;
    if (!globalThis.requestAnimationFrame) return;
    running = true; lastSig = '';
    syncBox();
    m.raf = globalThis.requestAnimationFrame(loop);
  }

  /**
   * Attach to a page: `mount({map, canvas})` creates the top canvas right
   * after the map canvas and the `#fx-hud` layer after it (both by script:
   * the HTML pages carry nothing). Options: `camera()` → {x, y, zoom} (default
   * the map's drawn view, else its view), `size()` → {width, height} in CSS
   * px, `invalidate()` (default map.invalidate), `groundInPainter()` → true
   * while the tile painter calls paintGround (default: tile detail with art),
   * `parent`: the element the top canvas is put into (default: right after
   * the map canvas, so in whatever holds it; give the tilted stage,
   * `#map-stage`, when the map canvas is not its direct child),
   * `stage`: the element whose box is "the map on screen" for HUD effects
   * (default the map canvas; the clipping wrapper when the canvas is
   * overscanned or tilted), `toViewport(x, y)`: a world point in client px
   * for a map without `project` that is not a flat view either.
   *
   * `mount(stageEl)` on a mounted engine only moves the top canvas into that
   * element (the integrator's one call for the tilted stage).
   */
  function mount(arg = {}) {
    if (arg && typeof arg.append === 'function' && arg.nodeType !== undefined) { reparent(arg); return api; }
    const { map = null, canvas = null, camera = null, size: sizeOf = null, invalidate = null, groundInPainter = null, stage = null, parent = null, toViewport = null, ratio = null } = arg ?? {};
    if (m) unmount();
    const c = canvas ?? map?.canvas ?? null;
    m = {
      map, canvas: c, stage, toViewport, ratio, rect: null, crect: null, top: null, ctx: null, hud: null,
      camera: camera ?? (() => map?.drawn ?? map?.drawnView ?? map?.view),
      size: sizeOf ?? (() => (map?.size ? map.size() : { width: c?.clientWidth ?? 0, height: c?.clientHeight ?? 0 })),
      invalidate: invalidate ?? (() => map?.invalidate?.()),
      groundInPainter: groundInPainter ?? (() => map?.lod === 'tile' && !!map?.art),
    };
    const doc = c?.ownerDocument;
    if (doc?.createElement && c.after) {
      const top = doc.createElement('canvas');
      top.className = 'fx-top'; top.id = 'fx-top';
      top.setAttribute('aria-hidden', 'true');
      if (parent?.append) parent.append(top); else c.after(top);
      m.top = top; m.ctx = top.getContext?.('2d') ?? null;
      let hud = doc.getElementById?.('fx-hud');
      if (!hud) {
        hud = doc.createElement('div');
        hud.id = 'fx-hud'; hud.className = 'fx-hud';
        hud.setAttribute('aria-hidden', 'true');
        (doc.body ?? top.parentElement)?.append(hud);
      }
      m.hud = hud;
      syncBox();
      const resync = () => { syncBox(); lastSig = ''; kick(); };
      try { m.ro = new globalThis.ResizeObserver(resync); m.ro.observe(c); if (stage) m.ro.observe(stage); } catch { /* no ResizeObserver */ }
      m.onResize = resync;
      doc.defaultView?.addEventListener?.('resize', resync);
    }
    kick();
    return api;
  }

  /** Move the top canvas into `el` (the tilted stage that holds the ground canvas): it then shares that element's transform. */
  function reparent(el) {
    if (!m?.top || !el?.append) return false;
    el.append(m.top);
    syncBox(); lastSig = ''; kick();
    return true;
  }

  function unmount() {
    if (!m) return;
    pieces.length = 0; syncPieces(clock.now());
    if (m.raf) globalThis.cancelAnimationFrame?.(m.raf);
    try { m.ro?.disconnect(); } catch { /* none */ }
    m.canvas?.ownerDocument?.defaultView?.removeEventListener?.('resize', m.onResize);
    for (const e of effects) { if (e.dom?.el && e.shown) { try { e.dom.off?.(e.dom.el); } catch { /* gone */ } e.shown = false; } try { e.el?.remove?.(); } catch { /* gone */ } e.el = null; }
    m.top?.remove?.(); m.hud?.remove?.();
    m = null; running = false;
  }

  /** Name an effect: `define('flash', (args, env) => spec | [specs] | null)`; `env` = {mode, now, seed, fx}. */
  function define(name, make) { defs.set(name, { make }); return api; }

  /**
   * Play a named effect: `play('flash', {q, r, color, seed})`. Returns the
   * handles of what was added (empty when the mode shows none of it).
   */
  function play(name, args = {}) {
    const d = defs.get(name);
    if (!d) return [];
    const mode = args.mode ?? motion();
    const env = { mode, now: clock.now() + (args.delay ?? 0), seed: args.seed ?? name, fx: api };
    let made;
    try { made = d.make(args, env); } catch (err) { globalThis.console?.warn?.('fx:', name, err); return []; }
    const list = (Array.isArray(made) ? made : [made]).filter(Boolean);
    const handles = list.map(s => add({ name, seed: env.seed, mode, ...s, at: env.now + (s.delay ?? 0), delay: 0 })).filter(Boolean);
    return handles;
  }

  const offBus = bus?.on?.('fx', p => { if (p?.name) play(p.name, p); });

  const api = {
    clock, particles,
    add, emit, shake, shakeAt, play, define, piece, anchor, unanchor, free, reparent,
    /** Hide the label pile of one tile while something plays on it: `hush({p, q, tile}, seconds, delay)`. */
    hush(at, dur = 1.5, delay = 0) { return at && [at.p, at.q, at.tile].every(Number.isInteger) ? piece('hush', { dur, delay, tiles: [`${at.p},${at.q},${at.tile}`] }) : null; },
    names: () => [...defs.keys()],
    has: name => defs.has(name),
    paintGround, paintOver, drawTop, frame, kick, mount, unmount,
    /** A painter that runs inside the tile painter on every map paint: `onPaint('ground' | 'over', (ctx, {t, zoom, px, tiles, mode, view, size, invalidate}) => n)`. Returns its remover. */
    onPaint(layer, fn) { const list = painters[layer]; if (!list || typeof fn !== 'function') return () => {}; list.push(fn); return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; },
    /** The motion level in force ('full' | 'reduced' | 'off'). */
    motionLevel: () => motion(),
    /**
     * A sound on the effects clock: `sound('clash', {delay, seed, level})`. The delay is in effect
     * seconds (a slowed clock stretches it); a frozen clock plays nothing.
     */
    sound(name, { delay = 0, ...rest } = {}) {
      if (clock.frozen) return false;
      try { return audio().play(name, { ...rest, delay: delay / Math.max(0.05, clock.rate || 1) }); } catch { return false; }
    },
    /** The map this engine is mounted on (null before mount). */
    get map() { return m?.map ?? null; },
    /** The document of the page (null without one). */
    get doc() { return m?.canvas?.ownerDocument ?? null; },
    /**
     * This engine with every cue pushed `d` seconds later: `later(0.7).play(…)`. A composition written for "now"
     * (fx/stage.mjs) can be played as the second act of another, or staggered behind others.
     */
    later(d) {
      if (!(d > 0)) return api;
      const o = Object.create(api);
      o.play = (n, a = {}) => api.play(n, { ...a, delay: (a.delay ?? 0) + d });
      o.add = spec => api.add({ ...spec, delay: (spec?.delay ?? 0) + d });
      o.emit = (k, a = {}) => api.emit(k, { ...a, delay: (a.delay ?? 0) + d });
      o.sound = (n, a = {}) => api.sound(n, { ...a, delay: (a.delay ?? 0) + d });
      o.shake = (px, ms, a = {}) => api.shake(px, ms, { ...a, delay: (a.delay ?? 0) + d });
      o.piece = (n, a = {}) => api.piece(n, { ...a, delay: (a.delay ?? 0) + d });
      o.hush = (at, dur, delay = 0) => api.hush(at, dur, delay + d);
      o.later = more => api.later(d + more);
      return o;
    },
    /** The names of the effects that are playing or still to start, in the order they were added (still ones included). */
    playing() { const t = clock.now(); return effects.filter(e => liveAt(e, t) || pendingAt(e, t)).map(e => e.name); },
    /** What is live at the clock's time: {live, pending, ground}. */
    live: () => counts(clock.now()),
    /** Remove everything (effects, particles, shakes). */
    clear() { for (const e of [...effects]) remove(e); particles.clear(); shakes.length = 0; pieces.length = 0; syncPieces(clock.now()); version++; lastSig = ''; kick(); },
    /** Cut the life of the live effects of these names to end `at` seconds after they began (the demo ends a waiting state on its own clock). */
    trim(names, at) { for (const e of effects) if (names.includes(e.name) && e.dur > at) e.dur = at; version++; },
    /** Remove the effects of these names now (words in a language the page has just left). Returns how many went. */
    drop(names) { const gone = effects.filter(e => names.includes(e.name)); for (const e of gone) remove(e); if (gone.length) { lastSig = ''; kick(); } return gone.length; },
    /** Keep finished effects (the demo rewinds the clock). */
    set keep(v) { keep = !!v; }, get keep() { return keep; },
    get mounted() { return !!m; },
    get hud() { return m?.hud ?? null; },
    get top() { return m?.top ?? null; },
    view, size,
    toScreen: (x, y) => toScreen(view(), size(), x, y),
    /** Whether a world point is on the map on screen (through `anchor`, so under a tilt too); `margin` px of grace. */
    onStage(x, y, margin = 0) { const p = anchor(x, y), sz = size(), r = m?.rect ?? { left: 0, top: 0, width: sz.width, height: sz.height }; return p.x >= r.left - margin && p.y >= r.top - margin && p.x <= r.left + r.width + margin && p.y <= r.top + r.height + margin; },
    destroy() { offBus?.(); unmount(); },
  };
  return api;
}

/** The page's engine. */
export const fx = createEngine();
/** The ground pass for the tile painter (map/sprites.mjs): after the territory wash, before the grid and the props. */
export const paintGround = (ctx, opts) => fx.paintGround(ctx, opts);
/** The pass over the props for the tile painter (map/sprites.mjs): after the props and holdings, before the hosts. */
export const paintOver = (ctx, opts) => fx.paintOver(ctx, opts);
