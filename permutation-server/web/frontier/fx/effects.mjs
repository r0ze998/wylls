// The first vocabulary of effects on the engine (UX-DESIGN §8.2): small,
// reusable pieces the set pieces (the bell, the seal, a battle) are built
// from. Each is written as beats, never one linear fade:
//
//   anticipation  a short wind-up that tells the eye where to look
//   impact        the brightest, fastest frames (60 to 100 ms)
//   decay         a long ease-out tail
//
//   flash   one tile flashes                       ground
//   ripple  rings spread on the ground from a tile  ground
//   dust    a burst of dust and pebbles             top (particles) + ground
//   spark   a burst of sparks from a point of contact  top
//   label   a number or word rises from a tile      hud  (information)
//   tag     a caption on a small bell-metal tag with a leader to its tile  hud  (information)
//   glow    a set of tiles lights, rolled out by distance  ground
//   banner  a title across the map                  hud  (information)
//   toll    a brass ripple across the whole map     top + screen
//   number  a number rises from a point of the HUD  hud  (information)
//   chip    a ring bursts from a HUD element        hud
//   burst   particles of one named kind             top
//
// Reduced motion (§8.5): nothing travels, scatters or shakes; what carries a
// state shows at once with a 200 ms opacity change. With effects off only
// the three information effects are shown, plainly.
//
// Positions: `{x, y}` world px, `{q, r}` a tile's axial hex, or `{p, q, tile}`
// (province and tile index). Colours are `#rrggbb`.
import { hexPoints, project, RADIUS, FLATTEN } from '../../map.mjs';
import { tileHex, hexDistance } from '../fgeo.mjs';
import { clamp01, lerp, span, phase, envelope, inQuad, inCubic, outCubic, outQuart, outExpo, outBack, inOutQuad } from './ease.mjs';
import { REDUCED_FADE } from './motion.mjs';

/** The redesign's colour tokens (UX-DESIGN §6), for canvas use. */
export const TONE = Object.freeze({ brass: '#c9a24a', brassHi: '#f0d48a', brassLo: '#7d6428', ivory: '#f4efe0', you: '#f3d58a', ember: '#e2553d', sky: '#7fc4e8', reach: '#d8f3ea', ink: '#0c1614', white: '#ffffff' });

const R = RADIUS;
const TAU = Math.PI * 2;

/** `#rrggbb` (or `#rgb`) with an alpha → `rgba(…)`. */
export function rgba(hex, a) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** A position argument as a world point {x, y} (and its hex when it names a tile). */
export function pointOf(a = {}) {
  if (Number.isFinite(a.x) && Number.isFinite(a.y)) return { x: a.x, y: a.y, q: null, r: null };
  if (Number.isInteger(a.tile) && Number.isInteger(a.p) && Number.isInteger(a.q)) { const h = tileHex(a.p, a.q, a.tile); return { ...project(h.q, h.r), q: h.q, r: h.r }; }
  if (Number.isInteger(a.q) && Number.isInteger(a.r)) return { ...project(a.q, a.r), q: a.q, r: a.r };
  return { x: 0, y: 0, q: 0, r: 0 };
}

/** Every hex within `radius` steps of (q, r), nearest first. */
export function hexDisc(q, r, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) out.push({ q: q + dq, r: r + dr });
  return out.sort((a, b) => hexDistance(q, r, a.q, a.r) - hexDistance(q, r, b.q, b.r));
}

export function hexPath(ctx, x, y, inset = 0) {
  ctx.beginPath();
  hexPoints(x, y, inset).forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
}
/** A circle lying on the ground (an ellipse under the map's camera). */
export function groundRing(ctx, x, y, r) { ctx.beginPath(); ctx.ellipse?.(x, y, Math.max(0.01, r), Math.max(0.01, r * FLATTEN), 0, 0, TAU); }
/** A radial gradient, or its middle colour where the context makes none (a test proxy). */
export function radial(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient?.(x, y, Math.max(0, r0), x, y, Math.max(0.01, r1));
  if (!g?.addColorStop) return stops[Math.min(1, stops.length - 1)][1];
  for (const [o, c] of stops) g.addColorStop(clamp01(o), c);
  return g;
}
/** Additive blending from here on (light adds up; the engine restores the context after each effect). */
export const lighter = ctx => { ctx.globalCompositeOperation = 'lighter'; };

// ------------------------------------------------------------------ flash: one tile
/** `{…position, color}`: a rim closes on the tile, it burns white for a few frames, the colour drains away. */
function flash(a, env) {
  const { x, y } = pointOf(a);
  const color = a.color ?? TONE.brassHi;
  if (env.mode !== 'full') {
    const dur = 0.55;
    return { layer: 'ground', dur, draw(ctx, s) {
      const o = envelope(s.t, dur, REDUCED_FADE, REDUCED_FADE);
      hexPath(ctx, x, y, 1); ctx.fillStyle = rgba(color, 0.46 * o); ctx.fill();
      ctx.strokeStyle = rgba(color, 0.9 * o); ctx.lineWidth = 2.5 * s.px; ctx.stroke();
    } };
  }
  const beats = [['wind', 0.07], ['hit', 0.09], ['decay', 0.52]];
  return { layer: 'ground', dur: 0.68, draw(ctx, s) {
    const b = phase(s.t, beats);
    if (b.name === 'wind') {
      // the tile dips and a rim closes in from outside: the eye is led to the spot before it burns
      hexPath(ctx, x, y, 0); ctx.fillStyle = rgba(TONE.ink, 0.2 * b.k); ctx.fill();
      hexPath(ctx, x, y, lerp(-R * 0.42, 0, inQuad(b.k)));
      ctx.strokeStyle = rgba(color, 0.35 * b.k); ctx.lineWidth = 6 * s.px; ctx.stroke();
      ctx.strokeStyle = rgba(TONE.white, 0.5 + 0.5 * b.k); ctx.lineWidth = lerp(1.5, 3, b.k) * s.px; ctx.stroke();
      return;
    }
    if (b.name === 'hit') {
      lighter(ctx);
      ctx.fillStyle = radial(ctx, x, y, R * 0.2, R * 1.9, [[0, rgba(TONE.white, 0.6 * (1 - b.k * 0.5))], [0.5, rgba(color, 0.32 * (1 - b.k * 0.4))], [1, rgba(color, 0)]]);
      groundRing(ctx, x, y, R * 1.9); ctx.fill();
      hexPath(ctx, x, y, 0); ctx.fillStyle = rgba(TONE.white, lerp(0.72, 0.5, b.k)); ctx.fill();
      ctx.strokeStyle = rgba(TONE.white, 1); ctx.lineWidth = 3 * s.px; ctx.stroke();
      return;
    }
    // decay: the colour is left behind and drains fast, then slowly; the rim lets go and drifts outward
    const body = 1 - outExpo(b.k);
    hexPath(ctx, x, y, 0); ctx.fillStyle = rgba(color, 0.2 * (1 - b.k) + 0.5 * body); ctx.fill();
    lighter(ctx);
    hexPath(ctx, x, y, 0); ctx.fillStyle = rgba(TONE.white, 0.5 * (1 - outQuart(b.k * 2.5))); ctx.fill();
    hexPath(ctx, x, y, lerp(0, -8, outCubic(b.k)));
    ctx.strokeStyle = rgba(color, 0.9 * (1 - inQuad(b.k))); ctx.lineWidth = lerp(3, 1, b.k) * s.px; ctx.stroke();
  } };
}

// ------------------------------------------------------------------ ripple: rings on the ground
/** `{…position, color, radius (tiles, default 2.6), layer}`: a breath in, a point of light, three rings that burst out and slow. */
function ripple(a, env) {
  const { x, y } = pointOf(a);
  const color = a.color ?? TONE.brassHi;
  const maxR = (a.radius ?? 2.6) * R;
  const layer = a.layer ?? 'ground';
  if (env.mode !== 'full') {
    const dur = 0.6;
    return { layer, dur, draw(ctx, s) {
      const o = envelope(s.t, dur, REDUCED_FADE, REDUCED_FADE);
      groundRing(ctx, x, y, maxR * 0.55); ctx.strokeStyle = rgba(color, 0.85 * o); ctx.lineWidth = 2.5 * s.px; ctx.stroke();
    } };
  }
  const WIND = 0.09;
  return { layer, dur: 1.0, draw(ctx, s) {
    const t = s.t;
    if (t < WIND) {
      const k = t / WIND;
      groundRing(ctx, x, y, lerp(R * 0.62, R * 0.16, inQuad(k)));
      ctx.strokeStyle = rgba(color, 0.55 * k); ctx.lineWidth = 1.5 * s.px; ctx.stroke();
      lighter(ctx);
      ctx.fillStyle = radial(ctx, x, y, 0, R * 0.3, [[0, rgba(TONE.white, 0.9 * k)], [1, rgba(color, 0)]]);
      groundRing(ctx, x, y, R * 0.3); ctx.fill();
      return;
    }
    lighter(ctx);
    // the point of light the rings leave from
    const kf = span(t, WIND, WIND + 0.26);
    if (kf < 1) {
      const rr = lerp(R * 0.3, R * 0.95, outCubic(kf));
      ctx.fillStyle = radial(ctx, x, y, 0, rr, [[0, rgba(TONE.white, 0.95 * (1 - kf) * (1 - kf))], [0.45, rgba(color, 0.5 * (1 - kf) * (1 - kf))], [1, rgba(color, 0)]]);
      groundRing(ctx, x, y, rr); ctx.fill();
    }
    for (let i = 0; i < 3; i++) {
      const start = WIND + i * 0.13, life = 0.66 - i * 0.07;
      if (t < start) continue;
      const k = (t - start) / life;
      if (k >= 1) continue;
      const r = lerp(R * 0.16, maxR * (1 - i * 0.2), outExpo(k));
      const o = (1 - k) ** 1.6 * [1, 0.62, 0.36][i];
      const lw = lerp(5.5, 1.2, outCubic(k)) * s.px;
      groundRing(ctx, x, y, r); ctx.strokeStyle = rgba(color, 0.24 * o); ctx.lineWidth = lw * 3.4; ctx.stroke();
      groundRing(ctx, x, y, r); ctx.strokeStyle = rgba(color, o); ctx.lineWidth = lw; ctx.stroke();
      if (i === 0 && k < 0.35) { groundRing(ctx, x, y, r); ctx.strokeStyle = rgba(TONE.white, 0.9 * (1 - k / 0.35)); ctx.lineWidth = Math.max(1, lw * 0.4); ctx.stroke(); }
    }
  } };
}

// ------------------------------------------------------------------ dust: something landed
/** `{…position, power (default 1), color, ring (tiles: a skirt from the rim of a disc this wide, round something that stands there)}`: the ground is pressed, a low pale shock runs out, dust and pebbles fly and settle. */
function dust(a, env) {
  if (env.mode !== 'full') return null;
  const { x, y } = pointOf(a);
  const power = a.power ?? 1;
  const HIT = 0.05;
  // a skirt that races out along the ground, a head that boils up in the middle, pebbles thrown clear
  if (a.ring > 0) {
    // round something that stands there (a village whose building is done): a low skirt from its foot outward, thin,
    // in the colour of the earth; nothing boils up over the houses (the second review: a grey fur-ball on the town)
    env.fx.emit('dust', { x, y, n: Math.round(26 * power), seed: env.seed, t: env.now + HIT, radius: R * a.ring, ring: true, power: 0.55 * power, up: 0.35, size: 0.8, alpha: 0.7, life: 0.9, color: a.color ?? null, colors: a.color ? null : ['#ead9ae', '#e2cc98', '#f1e6c6'] });
    env.fx.emit('shard', { x, y, n: Math.round(5 * power), seed: env.seed, t: env.now + HIT, radius: R * a.ring, ring: true, power: 0.5 * power, up: 0.6, size: 0.55, life: 0.7 });
    const rim = R * a.ring;
    return { layer: 'ground', dur: 0.55, draw(ctx, s) {
      const k = span(s.t, HIT, 0.55);
      if (s.t < HIT) return;
      groundRing(ctx, x, y, lerp(rim, rim + R * 0.9 * Math.sqrt(power), outExpo(k)));
      ctx.strokeStyle = rgba('#efe6cc', 0.45 * (1 - k) * (1 - k)); ctx.lineWidth = lerp(6, 1, outCubic(k)) * s.px; ctx.stroke();
    } };
  }
  env.fx.emit('dust', { x, y, n: Math.round(22 * power), seed: env.seed, t: env.now + HIT, radius: R * 0.26, power: 1.15 * power, up: 0.5, color: a.color ?? null });
  env.fx.emit('dust', { x, y, n: Math.round(9 * power), seed: `${env.seed}|head`, t: env.now + HIT + 0.03, radius: R * 0.14, power: power * 0.4, up: 2.1, size: 1.15, stagger: 0.09, color: a.color ?? null });
  env.fx.emit('shard', { x, y, n: Math.round(7 * power), seed: env.seed, t: env.now + HIT, radius: R * 0.15, power: 0.8 * power, up: 0.7, size: 0.62, life: 0.8 });
  return { layer: 'ground', dur: 0.55, draw(ctx, s) {
    const t = s.t;
    if (t < HIT) {
      const k = t / HIT;
      groundRing(ctx, x, y, lerp(R * 0.42, R * 0.26, k)); ctx.fillStyle = rgba(TONE.ink, 0.3 * k); ctx.fill();
      return;
    }
    const k = span(t, HIT, 0.55);
    groundRing(ctx, x, y, R * 0.3); ctx.fillStyle = rgba(TONE.ink, 0.26 * (1 - outCubic(k))); ctx.fill();
    const r = lerp(R * 0.24, R * 1.3 * Math.sqrt(power), outExpo(k));
    groundRing(ctx, x, y, r);
    ctx.strokeStyle = rgba('#efe6cc', 0.5 * (1 - k) * (1 - k)); ctx.lineWidth = lerp(7, 1, outCubic(k)) * s.px; ctx.stroke();
  } };
}

// ------------------------------------------------------------------ burst: particles of one kind
/** `{…position, kind (a particle kind), n (default 20), power, height (tiles), radius (tiles), life, size, color | colors}`: a plain burst, for kinds the pieces above do not use yet (leaf, coin, smoke, mist, ink, ember). */
function burst(a, env) {
  if (env.mode !== 'full') return null;
  const p = pointOf(a);
  const kind = a.kind ?? 'dust';
  const n = env.fx.emit(kind, { x: p.x, y: p.y, z: (a.height ?? 0) * R, n: a.n ?? 20, seed: env.seed, t: env.now, power: a.power ?? 1, radius: (a.radius ?? 0.15) * R,
    life: a.life ?? 1, size: a.size ?? 1, up: a.up ?? 1, stagger: a.stagger ?? 0, color: a.color ?? null, colors: a.colors ?? null, layer: a.layer ?? 'top' });
  // the particles are the effect; this entry only gives the burst a handle and a name in the live count
  return n ? { layer: 'top', dur: 0.05, draw() {} } : null;
}

// ------------------------------------------------------------------ spark: a point of contact
/** `{…position, height (tiles above the ground, default 0.42), color, power, shake (px)}`: a glint gathers, a white core and a star, sparks arc and bounce, embers drift up. */
function spark(a, env) {
  const p = pointOf(a);
  const color = a.color ?? '#ffb347';
  const z = (a.height ?? 0.42) * R;
  const x = p.x, y = p.y - z;
  const power = a.power ?? 1;
  if (env.mode !== 'full') {
    const dur = 0.5;
    return { layer: 'top', dur, draw(ctx, s) {
      const o = envelope(s.t, dur, REDUCED_FADE, REDUCED_FADE);
      ctx.fillStyle = radial(ctx, x, y, 0, R * 0.7, [[0, rgba(TONE.white, 0.85 * o)], [0.4, rgba(color, 0.5 * o)], [1, rgba(color, 0)]]);
      ctx.beginPath(); ctx.arc(x, y, R * 0.7, 0, TAU); ctx.fill();
    } };
  }
  const WIND = 0.06;
  // the volley, a fine fast spray across it, a few heavy drops that land and skip, and embers that hang
  env.fx.emit('spark', { x: p.x, y: p.y, z, n: Math.round(24 * power), seed: env.seed, t: env.now + WIND, power, life: 1.15, colors: [color, '#ffd27a', '#ff8a3c'] });
  env.fx.emit('spark', { x: p.x, y: p.y, z, n: Math.round(10 * power), seed: `${env.seed}|fine`, t: env.now + WIND + 0.02, power: power * 1.6, size: 0.6, life: 0.6, up: 0.45, colors: ['#fff6dc', '#ffe2a0'] });
  env.fx.emit('spark', { x: p.x, y: p.y, z, n: Math.round(8 * power), seed: `${env.seed}|drop`, t: env.now + WIND + 0.01, power: power * 0.7, size: 1.25, life: 1.5, up: 0.5, colors: ['#ffb347', '#ff8a3c'] });
  env.fx.emit('ember', { x: p.x, y: p.y, z, n: Math.round(12 * power), seed: env.seed, t: env.now + WIND + 0.03, radius: R * 0.14, power: 1.4 * power, size: 1.3, stagger: 0.14 });
  if (a.shake) env.fx.shake(a.shake, 140, { seed: env.seed, delay: WIND });
  const rays = [[0, 1], [Math.PI / 2, 0.62], [Math.PI / 4, 0.4], [-Math.PI / 4, 0.4]];
  return { layer: 'top', dur: 0.8, draw(ctx, s) {
    const t = s.t;
    lighter(ctx);
    if (t < WIND) {
      const k = t / WIND;
      ctx.beginPath(); ctx.arc(x, y, lerp(R * 0.6, R * 0.08, inCubic(k)), 0, TAU);
      ctx.strokeStyle = rgba(color, 0.8 * k); ctx.lineWidth = lerp(1, 2.4, k) * s.px; ctx.stroke();
      ctx.fillStyle = radial(ctx, x, y, 0, R * 0.2, [[0, rgba(TONE.white, k)], [1, rgba(color, 0)]]);
      ctx.beginPath(); ctx.arc(x, y, R * 0.2, 0, TAU); ctx.fill();
      return;
    }
    const kb = span(t, WIND, WIND + 0.2);
    if (kb < 1) {
      const rr = lerp(R * 0.42, R * 1.35 * Math.sqrt(power), outCubic(kb));
      ctx.fillStyle = radial(ctx, x, y, 0, rr, [[0, rgba(TONE.white, (1 - kb) * (1 - kb))], [0.3, rgba('#ffe2a0', 0.8 * (1 - kb) * (1 - kb))], [0.62, rgba(color, 0.4 * (1 - kb))], [1, rgba(color, 0)]]);
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    }
    // the star: four thin rays that stab out past their length and die back
    const ks = span(t, WIND, WIND + 0.3);
    if (ks < 1) {
      const len = R * 1.5 * Math.sqrt(power) * outBack(Math.min(1, ks * 2.4), 2.2) * (1 - inQuad(ks));
      ctx.lineCap = 'round';
      for (const [ang, m] of rays) {
        const dx = Math.cos(ang) * len * m, dy = Math.sin(ang) * len * m;
        ctx.strokeStyle = rgba('#fff3d0', 0.9 * (1 - ks)); ctx.lineWidth = Math.max(1, 2.2 * (1 - ks)) * s.px;
        ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
      }
    }
    // what is left glowing where it happened
    const kg = span(t, WIND + 0.1, 0.8);
    ctx.fillStyle = radial(ctx, x, y, 0, R * 0.55, [[0, rgba(color, 0.42 * (1 - outCubic(kg)))], [1, rgba(color, 0)]]);
    ctx.beginPath(); ctx.arc(x, y, R * 0.55, 0, TAU); ctx.fill();
  } };
}

// ------------------------------------------------------------------ label: a number or a word over a tile
/** The serif of names, titles and captions (UX-DESIGN §6). */
export const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", Georgia, "Times New Roman", serif';
/** A number or a word pops from 1.3 to 1.0 in this long (s), at full opacity from its first frame (UX-DESIGN §11.14). */
export const POP_SECS = 0.12;
export const POP_FROM = 1.3;
/** The size of a box of text nobody has measured yet (no layout: tests, the first frame): full-width glyphs 1 em, others 0.6. */
const textBox = (text, px) => ({ w: [...String(text)].reduce((w, ch) => w + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u30ff]/.test(ch) ? 1 : 0.6), 0) * px, h: px * 1.3 });
const boxOf = (el, text, px) => { const w = el?.offsetWidth, h = el?.offsetHeight; return w > 0 && h > 0 ? { w, h } : textBox(text, px); };

/**
 * `{…position, text, color, size (screen px, default 28), lift (tiles above the
 * tile, default 0.75), rise (screen px, default 36), dur (default 1.25), serif}`:
 * a number or a word over a tile, ivory with an ink outline. It is there at
 * full opacity and 1.3 times its size on its first frame, settles to 1.0 in
 * 120 ms, rises fast then slowly, holds, lets go upward. A node of the HUD
 * layer placed through the engine's `anchor`, so it is upright under a tilted
 * map and never leaves what the HUD leaves free.
 */
function label(a, env) {
  const { x, y } = pointOf(a);
  const text = String(a.text ?? '');
  if (!text) return null;
  const sizePx = Math.max(14, a.size ?? 28);
  const lift = (a.lift ?? 0.75) * R;
  const rise = a.rise ?? 36;
  const dur = Math.max(0.6, a.dur ?? 1.25);
  const full = env.mode === 'full';
  return { layer: 'hud', dur, info: true, dom: {
    make(doc) {
      const el = node(doc, 'span', 'fx-word', text);
      if (a.serif) el.dataset.serif = 'true';
      if (a.color) el.style.setProperty('--fx-c', a.color);
      el.style.setProperty('--fx-fs', `${sizePx}px`);
      return el;
    },
    update(el, s) {
      const t = s.t;
      let scale = 1, alpha = 1, up = rise;
      if (full) {
        scale = lerp(POP_FROM, 1, outCubic(span(t, 0, POP_SECS)));
        up = rise * outQuart(span(t, 0, dur * 0.8));
        const ko = span(t, dur - 0.34, dur);
        alpha = 1 - inQuad(ko);
        up += 9 * inQuad(ko);
      } else alpha = envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
      const p = s.anchor(x, y - lift), box = boxOf(el, text, sizePx);
      const at = s.free.place(p.x, p.y - up, box.w, box.h, 4);
      setVars(el, { '--fx-x': `${at.x.toFixed(1)}px`, '--fx-y': `${at.y.toFixed(1)}px`, '--fx-s': scale.toFixed(3), '--fx-o': alpha.toFixed(3) });
    },
  } };
}

// ------------------------------------------------------------------ tag: a caption on a small bell-metal tag
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The HUD's icon sprite, relative to the page (hud/icons.mjs SPRITE: the three pages sit beside it). */
export const TAG_SPRITE = 'art/ui/icons.svg';
/** How long a caption stands when nothing says otherwise (s). */
export const TAG_SECS = 2.2;

/**
 * `{…position, text, icon (a symbol of the HUD's sprite), tone: 'brass' | 'ember' | 'gold' | 'ivory', color (the
 * accent, e.g. a nation's), lift (tiles above the tile's centre where the tag sits, default 1.35), foot (tiles
 * above the centre where its leader starts, default 0.3), dur (default 2.2)}`: a caption of the map. A small
 * bell-metal tag in the serif stands above its tile on a thin brass leader; when the HUD or the edge of the
 * map is in the way the tag moves aside and the leader still points at the tile. A caption whose tile is not
 * on the map on screen is not shown.
 */
function tag(a, env) {
  const { x, y } = pointOf(a);
  const text = String(a.text ?? '');
  if (!text) return null;
  const lift = (a.lift ?? 1.35) * R, foot = (a.foot ?? 0.3) * R;
  const dur = Math.max(0.8, a.dur ?? TAG_SECS);
  const full = env.mode === 'full';
  return { layer: 'hud', dur, info: true, dom: {
    make(doc) {
      const el = node(doc, 'span', 'fx-tag');
      el.dataset.tone = a.tone ?? 'brass';
      if (a.color) el.style.setProperty('--fx-c', a.color);
      const plate = node(doc, 'span', 'fx-tag-plate');
      if (a.icon && /^[\w-]+$/.test(a.icon) && doc.createElementNS) {
        const svg = doc.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'fx-tag-ic'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const use = doc.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `${TAG_SPRITE}#${a.icon}`);
        svg.append(use); plate.append(svg);
      }
      plate.append(node(doc, 'span', 'fx-tag-text', text));
      el.append(node(doc, 'span', 'fx-tag-lead'), node(doc, 'span', 'fx-tag-dot'), plate);
      el.plate = plate;
      return el;
    },
    update(el, s) {
      const t = s.t;
      const A = s.anchor(x, y - foot), P = s.anchor(x, y - lift);
      const box = boxOf(el.plate, text, 14);
      if (!(el.plate?.offsetWidth > 0)) { box.w += 22 + (a.icon ? 18 : 0); box.h = 26; }
      // above its tile by the leader's length (never a stub), then wherever the HUD lets it stand
      const want = { x: P.x, y: Math.min(P.y, A.y - 20) - box.h / 2 };
      const at = s.free.place(want.x, want.y, box.w, box.h, 5, A);
      // the leader runs from the tile to the nearest point of the tag's edge
      const ex = Math.min(at.x + box.w / 2 - 6, Math.max(at.x - box.w / 2 + 6, A.x)), ey = Math.min(at.y + box.h / 2, Math.max(at.y - box.h / 2, A.y));
      const len = Math.hypot(ex - A.x, ey - A.y), ang = Math.atan2(ey - A.y, ex - A.x);
      const st = s.stage, off = A.x < st.left - 24 || A.x > st.left + st.width + 24 || A.y < st.top - 24 || A.y > st.top + st.height + 24;
      // (not on the map on screen: the tag takes no place on the page at all, so its leader never reaches past the screen's edge)
      if (el.hidden !== off) el.hidden = off;
      if (off) { setVars(el, { '--fx-o': '0.000' }); return; }
      let o, lead = 1, pop = 1;
      if (full) {
        const out = span(t, dur - 0.22, dur);
        o = 1 - inQuad(out);
        lead = outCubic(span(t, 0, 0.12));
        pop = lerp(1.18, 1, outCubic(span(t, 0.04, 0.04 + POP_SECS)));
      } else o = envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
      setVars(el, {
        '--fx-x': `${at.x.toFixed(1)}px`, '--fx-y': `${at.y.toFixed(1)}px`, '--fx-ax': `${A.x.toFixed(1)}px`, '--fx-ay': `${A.y.toFixed(1)}px`,
        '--fx-len': `${(len * lead).toFixed(1)}px`, '--fx-ang': `${ang.toFixed(4)}rad`,
        '--fx-o': (off ? 0 : o).toFixed(3), '--fx-po': (full ? span(t, 0.04, 0.09) : 1).toFixed(3), '--fx-s': pop.toFixed(3),
      });
    },
  } };
}

// ------------------------------------------------------------------ glow: a set of tiles lights up
/**
 * `{tiles: [{q, r}] | …position + radius (tiles, default 2), origin: {q, r},
 * color, hold (seconds lit, default 1.5), gain (0..1, default 1)}`: each tile catches, overshoots
 * bright, settles and breathes; the set rolls out from the origin 30 ms a
 * step (UX-DESIGN §5.2) and lets go together.
 */
function glow(a, env) {
  const c = pointOf(a);
  const color = a.color ?? TONE.reach;
  const list = (Array.isArray(a.tiles) && a.tiles.length ? a.tiles : hexDisc(c.q ?? 0, c.r ?? 0, a.radius ?? 2)).filter(h => Number.isInteger(h.q) && Number.isInteger(h.r));
  if (!list.length) return null;
  const o = a.origin ?? (c.q !== null ? { q: c.q, r: c.r } : list[0]);
  const full = env.mode === 'full';
  const STEP = full ? 0.03 : 0;
  const cells = list.map(h => ({ ...project(h.q, h.r), d: hexDistance(o.q, o.r, h.q, h.r) }));
  const far = cells.reduce((m2, h) => Math.max(m2, h.d), 0);
  const hold = Math.max(0.5, a.hold ?? 1.5);
  const dur = hold + far * STEP;
  // `gain` < 1: a lighter pass (over tiles that carry a light of their own: the map's lit tiles)
  const gain = Math.max(0, Math.min(1, a.gain ?? 1));
  const OUT = full ? 0.42 : REDUCED_FADE;
  return { layer: 'ground', dur, draw(ctx, s) {
    const t = s.t;
    const gone = (1 - inQuad(span(t, dur - OUT, dur))) * gain;
    for (const h of cells) {
      const u = t - h.d * STEP;
      if (u < 0) continue;
      let f, rim = 1, white = 0;
      if (!full) { f = 0.4 * span(u, 0, REDUCED_FADE); rim = span(u, 0, REDUCED_FADE); }
      else if (u < 0.06) { const k = u / 0.06; f = 0.1 * k; rim = k; }
      else if (u < 0.2) { const k = (u - 0.06) / 0.14; f = lerp(0.1, 0.56, outCubic(k)); white = 0.16 * Math.sin(k * Math.PI); }
      else if (u < 0.55) f = lerp(0.56, 0.4, inOutQuad((u - 0.2) / 0.35));
      else f = 0.4 + 0.05 * Math.sin((u - 0.55) * 4.2);
      hexPath(ctx, h.x, h.y, 2 * s.px);
      ctx.fillStyle = rgba(color, f * gone); ctx.fill();
      if (white > 0.01) { ctx.save?.(); lighter(ctx); ctx.fillStyle = rgba(TONE.white, white * gone); ctx.fill(); ctx.restore?.(); }
      // the rim: a soft wide stroke under a crisp 2.5 px one (the glow outside the line)
      ctx.strokeStyle = rgba(color, 0.26 * rim * gone); ctx.lineWidth = 7 * s.px; ctx.stroke();
      ctx.strokeStyle = rgba(color, 0.96 * rim * gone); ctx.lineWidth = 2.5 * s.px; ctx.stroke();
    }
  } };
}

// ------------------------------------------------------------------ toll: brass across the whole map
/**
 * `{…position (the Engine, or home when the Engine is off screen), color}`:
 * the map hushes and light gathers at the origin; at the stroke it blooms,
 * a brass ring leaves with a wide wake and two echoes behind it and crosses
 * everything in view, slowing as it goes; the warmth drains from the screen.
 */
function toll(a, env) {
  const { x, y } = pointOf(a);
  const color = a.color ?? TONE.brass;
  const hi = a.hi ?? TONE.brassHi;
  if (env.mode !== 'full') {
    const dur = 0.9;
    return [{ layer: 'screen', dur, draw(ctx, s) {
      const o = span(s.t, 0, REDUCED_FADE) * (1 - span(s.t, dur - 0.4, dur));
      ctx.fillStyle = rgba(hi, 0.14 * o); ctx.fillRect(0, 0, s.size.width, s.size.height);
    } }, { layer: 'top', dur, draw(ctx, s) {
      const o = span(s.t, 0, REDUCED_FADE) * (1 - span(s.t, dur - 0.4, dur));
      groundRing(ctx, x, y, R * 1.6); ctx.strokeStyle = rgba(hi, 0.9 * o); ctx.lineWidth = 3 * s.px; ctx.stroke();
    } }];
  }
  const WIND = 0.22, TRAVEL = 1.55, GAP = 0.4, DUR = WIND + 2 * GAP + TRAVEL + 0.1;
  if (a.shake !== 0) env.fx.shake(a.shake ?? 3, 200, { seed: env.seed, delay: WIND });
  // how far a ring must run to pass every corner in view, measured on the ground plane
  const reach = s => {
    const hw = s.size.width / 2 / s.zoom, hh = s.size.height / 2 / s.zoom;
    let far = 0;
    for (const [cx, cy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) far = Math.max(far, Math.hypot(s.view.x + cx - x, (s.view.y + cy - y) / FLATTEN));
    return Math.max(far + R * 2, R * 6);
  };
  const world = { layer: 'top', dur: DUR, draw(ctx, s) {
    const t = s.t;
    ctx.translate(x, y); ctx.scale(1, FLATTEN);
    lighter(ctx);
    if (t < WIND) {
      const k = t / WIND;
      // the breath in: a ring falls to the centre and light gathers there
      ctx.beginPath(); ctx.arc(0, 0, lerp(R * 4.2, R * 0.6, inCubic(k)), 0, TAU);
      ctx.strokeStyle = rgba(hi, 0.3 * k); ctx.lineWidth = 8 * s.px; ctx.stroke();
      ctx.strokeStyle = rgba(hi, 0.85 * k); ctx.lineWidth = 2 * s.px; ctx.stroke();
      ctx.fillStyle = radial(ctx, 0, 0, 0, R * 1.6, [[0, rgba(hi, 0.9 * inQuad(k))], [0.45, rgba(color, 0.4 * k)], [1, rgba(color, 0)]]);
      ctx.beginPath(); ctx.arc(0, 0, R * 1.6, 0, TAU); ctx.fill();
      return;
    }
    const u = t - WIND;
    const far = reach(s);
    // three strokes of light, each fainter: the first is the bell, the others its ring dying away
    for (let i = 0; i < 3; i++) {
      const v = u - i * GAP;
      if (v < 0) continue;
      const level = [1, 0.58, 0.32][i];
      // the bloom at the origin when each leaves
      const kb = span(v, 0, 0.45);
      if (kb < 1) {
        const rr = lerp(R * 1.2, R * (i ? 2.6 : 4), outCubic(kb));
        ctx.fillStyle = radial(ctx, 0, 0, 0, rr, [[0, rgba(TONE.white, 0.95 * level * (1 - kb) * (1 - kb))], [0.25, rgba(hi, 0.85 * level * (1 - kb) * (1 - kb))], [0.6, rgba(color, 0.4 * level * (1 - kb))], [1, rgba(color, 0)]]);
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.fill();
      }
      const k = v / TRAVEL;
      if (k >= 1) continue;
      // quick off the bell, then a steady crossing that slows a little: it is still in view when the next leaves
      const r = R * 0.6 + (far - R * 0.6) * (0.6 * k + 0.4 * outCubic(k));
      const o = (1 - k * k) * level;
      const band = Math.min(r, R * (i === 0 ? 5 : 3) * (0.4 + 0.6 * k));
      // the wake: brass light on the land behind the line, thinning toward the bell
      ctx.fillStyle = radial(ctx, 0, 0, r - band, r, [[0, rgba(color, 0)], [0.5, rgba(color, 0.12 * o)], [0.86, rgba(hi, 0.34 * o)], [1, rgba(hi, 0.62 * o)]]);
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      // the line itself: wide and soft under, thin and white-hot over
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
      ctx.strokeStyle = rgba(hi, 0.3 * o); ctx.lineWidth = (i === 0 ? 20 : 11) * s.px; ctx.stroke();
      ctx.strokeStyle = rgba(hi, 0.6 * o); ctx.lineWidth = (i === 0 ? 8 : 5) * s.px; ctx.stroke();
      ctx.strokeStyle = rgba(i === 0 ? '#fff6dc' : hi, 0.98 * o); ctx.lineWidth = (i === 0 ? 3 : 1.8) * s.px; ctx.stroke();
    }
    // the bell's own glow, last to go
    const kg = span(u, 0.1, DUR - WIND);
    ctx.fillStyle = radial(ctx, 0, 0, 0, R * 1.8, [[0, rgba(hi, 0.55 * (1 - outCubic(kg)))], [1, rgba(color, 0)]]);
    ctx.beginPath(); ctx.arc(0, 0, R * 1.8, 0, TAU); ctx.fill();
  } };
  const screen = { layer: 'screen', dur: DUR, draw(ctx, s) {
    const t = s.t, w = s.size.width, h = s.size.height;
    if (t < WIND) {
      // the hush: the edges darken a little before the stroke
      const k = inQuad(t / WIND);
      ctx.fillStyle = radial(ctx, w / 2, h / 2, Math.min(w, h) * 0.25, Math.hypot(w, h) * 0.6, [[0, rgba(TONE.ink, 0)], [1, rgba(TONE.ink, 0.34 * k)]]);
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const u = t - WIND;
    const dark = 0.34 * (1 - outCubic(span(u, 0, 0.5)));
    if (dark > 0.004) { ctx.fillStyle = radial(ctx, w / 2, h / 2, Math.min(w, h) * 0.25, Math.hypot(w, h) * 0.6, [[0, rgba(TONE.ink, 0)], [1, rgba(TONE.ink, dark)]]); ctx.fillRect(0, 0, w, h); }
    // the stroke lights everything warm for an instant, then the warmth drains
    const warm = 0.22 * (1 - outExpo(span(u, 0, 0.9))) + 0.07 * (1 - outExpo(span(u - GAP, 0, 0.7))) * (u >= GAP ? 1 : 0);
    if (warm > 0.004) { lighter(ctx); ctx.fillStyle = rgba(hi, warm); ctx.fillRect(0, 0, w, h); }
  } };
  return [screen, world];
}

// ------------------------------------------------------------------ HUD: banner, number, chip
export const setVars = (el, vars) => { for (const k in vars) el.style.setProperty(k, vars[k]); };
export const node = (doc, tag, cls, text) => { const el = doc.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };

/** When a banner begun at 0 and lasting `dur` s has faded under a tenth of its opacity (what follows it waits for this: UX-DESIGN §11.14). */
export const bannerGone = dur => dur - 0.02;
const BANNER_OUT = 0.42;

/**
 * `{title, sub, color (accent), tone: 'brass' | 'win' | 'loss', dur (default 2.8), y, vy, into}`:
 * a dark band opens across the map from its middle line, two brass rules
 * shoot outward, the title lands large and settles while its letters gather,
 * a glint crosses it; it leaves by the same door.
 *
 * Where: inside the stage the HUD leaves free (fx/safe.mjs `centre`), never
 * over the top strip, the dial or a phone's columns of buttons. `y` is its
 * place in that stage (0 = against its top, 1 = against its foot; default
 * 0.25); `vy` a middle line in client px (or a function of the state) that
 * is then kept inside the stage. Its width is the free stretch of the map at
 * that height, and the title is sized to it. `room: 'stage'`: the stage of a
 * set piece (the HUD's corner pieces have stepped back).
 */
function banner(a, env) {
  const title = String(a.title ?? '');
  if (!title) return null;
  const dur = Math.max(1.2, a.dur ?? 2.8);
  const full = env.mode === 'full';
  // the title's width in ems (full-width glyphs 1, others about 0.58, plus the letter spacing): it is sized to fit
  const emsOf = text => [...text].reduce((w, ch) => w + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u30ff]/.test(ch) ? 1 : 0.58) + 0.14, 0);
  const ems = emsOf(title);
  // a title of two parts ("the bell has tolled — Turn 43") breaks between them when it must take two lines
  const parts = title.split(' — ');
  const two = parts.length === 2 ? Math.max(emsOf(parts[0]), emsOf(parts[1])) : ems * 0.56;
  const narrow = width => width < 600;
  /** One line when it fits at a size worth reading; else two balanced lines (a phone, a long English title). */
  const fit = width => {
    const cap = narrow(width) ? Math.min(40, width * 0.15) : Math.min(60, width * 0.066);
    const one = Math.min(cap, (width * 0.86) / ems);
    const least = narrow(width) ? 22 : 30;
    if (one >= least || ems < 6) return { fs: Math.max(16, one), wrap: false };
    return { fs: Math.max(16, Math.min(cap, (width * 0.86) / two)), wrap: true };
  };
  const dress = (doc, el) => {
    el.dataset.tone = a.tone ?? 'brass';
    if (a.color) el.style.setProperty('--fx-c', a.color);
    el.replaceChildren?.();
    const head = node(doc, 'span', 'fx-banner-title');
    if (parts.length === 2) head.append(node(doc, 'span', 'fx-banner-part', parts[0]), node(doc, 'span', 'fx-banner-sep', ' — '), node(doc, 'span', 'fx-banner-part', parts[1]));
    else head.textContent = title;
    el.append(node(doc, 'span', 'fx-banner-band'), node(doc, 'span', 'fx-banner-rule fx-banner-rule-a'), node(doc, 'span', 'fx-banner-glint'), head);
    if (a.sub) el.append(node(doc, 'span', 'fx-banner-sub', String(a.sub)));
    el.append(node(doc, 'span', 'fx-banner-rule fx-banner-rule-b'));
    if (a.lang) el.lang = a.lang;
    return el;
  };
  // `into`: an element of the page that carries the banner for its life (the bell's toll line) instead of a node in #fx-hud
  const host = typeof a.into === 'string' ? globalThis.document?.querySelector?.(a.into) ?? null : a.into ?? null;
  const VARS = ['--fx-c', '--fx-cy', '--fx-fs', '--fx-o', '--fx-band', '--fx-rule', '--fx-ts', '--fx-to', '--fx-tl', '--fx-so', '--fx-gx', '--fx-go', '--fx-l', '--fx-w'];
  return { layer: 'hud', dur, info: true, dom: {
    el: host,
    on(el) { dress(el.ownerDocument, el); el.hidden = false; el.classList.add('fx-banner', 'fx-banner-host'); },
    // (handed back hidden: the page's resting style for it is an invisible line, and no frame of that style is to show)
    off(el) { el.hidden = true; el.classList.remove('fx-banner', 'fx-banner-host'); delete el.dataset.tone; delete el.dataset.wrap; for (const v of VARS) el.style.removeProperty?.(v); el.replaceChildren?.(); el.textContent = title; },
    make(doc) { return dress(doc, node(doc, 'div', 'fx-banner')); },
    update(el, s) {
      const t = s.t;
      // the stage the HUD leaves free; the band's height once it has been laid out (an estimate before)
      const onStage = a.room === 'stage';
      const fr = (onStage ? s.free.stage : null) ?? s.free.centre;
      const guess = fit(fr.width);
      const h = el.offsetHeight > 0 ? el.offsetHeight : guess.fs * 1.25 * (guess.wrap ? 2 : 1) + 42 + (a.sub ? 29 : 0);
      const want = a.vy !== undefined && a.vy !== null ? (typeof a.vy === 'function' ? a.vy(s, h) : a.vy) : fr.top + h / 2 + (fr.height - h) * (a.y ?? 0.25);
      const cy = fr.height > h + 8 ? Math.min(fr.bottom - h / 2 - 4, Math.max(fr.top + h / 2 + 4, want)) : fr.top + fr.height / 2;
      // as wide as the map is free at that height (a phone's two columns of buttons stand beside it)
      const sp = s.free.span(cy - h / 2, cy + h / 2, { stage: onStage });
      const w = sp.width > 120 ? sp : { left: fr.left, width: fr.width };
      const { fs, wrap } = fit(w.width);
      setVars(el, { '--fx-fs': `${fs.toFixed(1)}px`, '--fx-l': `${w.left.toFixed(1)}px`, '--fx-w': `${w.width.toFixed(1)}px`, '--fx-cy': `${cy.toFixed(1)}px` });
      const wrapped = wrap ? 'true' : 'false';
      if (el.dataset.wrap !== wrapped) el.dataset.wrap = wrapped;
      if (!full) {
        const o = envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
        setVars(el, { '--fx-o': o.toFixed(3), '--fx-band': '1', '--fx-rule': '1', '--fx-ts': '1', '--fx-to': '1', '--fx-tl': '0em', '--fx-so': '1', '--fx-gx': '-40%', '--fx-go': '0' });
        return;
      }
      const out = span(t, dur - BANNER_OUT, dur);
      const band = outCubic(span(t, 0, 0.16)) * (1 - inCubic(span(t, dur - 0.24, dur)));
      const rule = outExpo(span(t, 0.04, 0.5)) * (1 - inCubic(out));
      const kt = span(t, 0.1, 0.42);
      // lands from large with one small rebound, then drifts a hair larger while it is read
      // (a long title lands from less far out: it must not spill over the sides of the map on its way in)
      // (and never from so large that it leaves the free stretch: a phone's title lands almost in place)
      const line = fs * (wrap ? two : ems), amp = Math.max(0, Math.min(0.55 * Math.min(1, 6 / ems), (w.width * 0.98) / Math.max(1, line) - 1.04));
      const ts = (1 + amp * (1 - outBack(kt, 1.4))) * (1 + 0.025 * span(t, 0.42, dur)) * (1 + 0.04 * inQuad(out));
      const to = span(t, 0.1, 0.17) * (1 - inQuad(out));
      const tl = lerp(Math.min(0.5, 1.5 / ems), 0, outCubic(span(t, 0.1, 0.62))) + Math.min(0.14, 0.7 / ems) * inQuad(out);
      const kg = span(t, 0.3, 0.95);
      setVars(el, {
        '--fx-o': (1 - inQuad(out)).toFixed(3), '--fx-band': band.toFixed(3), '--fx-rule': rule.toFixed(3),
        '--fx-ts': ts.toFixed(3), '--fx-to': to.toFixed(3), '--fx-tl': `${tl.toFixed(3)}em`,
        '--fx-so': (span(t, 0.36, 0.6) * (1 - inQuad(out))).toFixed(3),
        '--fx-gx': `${lerp(-40, 140, inOutQuad(kg)).toFixed(1)}%`, '--fx-go': (Math.sin(kg * Math.PI) * 0.9).toFixed(3),
      });
    },
  } };
}

/** The viewport point an argument names: `{el: Element | selector}` (its centre), `{vx, vy}` viewport px, or a world position. */
export function viewportPoint(a, s, doc) {
  const el = typeof a.el === 'string' ? doc?.querySelector?.(a.el) : a.el;
  if (el?.getBoundingClientRect) { const r = el.getBoundingClientRect(); if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r, el }; }
  if (Number.isFinite(a.vx) && Number.isFinite(a.vy)) return { x: a.vx, y: a.vy, rect: null, el: null };
  const w = pointOf(a);
  return { ...s.anchor(w.x, w.y), rect: null, el: null };
}

/** `{text, color, size, el | vx, vy | …position, dy (px it rises, default 30), dur (default 1.1)}`: a number pops and rises from a point of the HUD. */
function number(a, env) {
  const text = String(a.text ?? '');
  if (!text) return null;
  const dur = Math.max(0.6, a.dur ?? 1.1);
  const full = env.mode === 'full';
  const dy = a.dy ?? 30;
  return { layer: 'hud', dur, info: true, dom: {
    make(doc) {
      const el = node(doc, 'span', 'fx-num', text);
      if (a.color) el.style.setProperty('--fx-c', a.color);
      if (a.size) el.style.setProperty('--fx-fs', `${Math.max(12, a.size)}px`);
      return el;
    },
    update(el, s) {
      const p = viewportPoint(a, s, el.ownerDocument);
      const t = s.t;
      let o, sc = 1, up = dy;
      if (full) {
        const ko = span(t, dur - 0.3, dur);
        o = span(t, 0, 0.05) * (1 - inQuad(ko));
        sc = lerp(0.4, 1, outBack(span(t, 0, 0.16), 2.4));
        up = dy * outQuart(span(t, 0, dur * 0.8)) + 6 * inQuad(ko);
      } else o = envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
      setVars(el, { '--fx-x': `${p.x.toFixed(1)}px`, '--fx-y': `${(p.y - (a.below ? -up : up)).toFixed(1)}px`, '--fx-s': sc.toFixed(3), '--fx-o': o.toFixed(3) });
    },
  } };
}

/** `{el: Element | selector, color, fill (how white it flashes, default 0.95)}`: the element flashes and two rings leave its outline (a status chip that changed state). */
function chip(a, env) {
  const dur = env.mode === 'full' ? 0.75 : 0.5;
  const full = env.mode === 'full';
  return { layer: 'hud', dur, dom: {
    make(doc) {
      const el = node(doc, 'span', 'fx-chip');
      if (a.color) el.style.setProperty('--fx-c', a.color);
      el.append(node(doc, 'span', 'fx-chip-fill'), node(doc, 'span', 'fx-chip-ring fx-chip-ring-a'), node(doc, 'span', 'fx-chip-ring fx-chip-ring-b'));
      try {
        const target = typeof a.el === 'string' ? doc.querySelector(a.el) : a.el;
        const rad = target ? doc.defaultView?.getComputedStyle?.(target)?.borderTopLeftRadius : null;
        if (rad) el.style.setProperty('--fx-r', rad);
      } catch { /* a plain rounded box */ }
      return el;
    },
    update(el, s) {
      const p = viewportPoint(a, s, el.ownerDocument);
      const w = p.rect?.width ?? 44, h = p.rect?.height ?? 28;
      const t = s.t;
      const vars = { '--fx-x': `${(p.x - w / 2).toFixed(1)}px`, '--fx-y': `${(p.y - h / 2).toFixed(1)}px`, '--fx-w': `${w.toFixed(1)}px`, '--fx-h': `${h.toFixed(1)}px` };
      if (!full) {
        const o = envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
        setVars(el, { ...vars, '--fx-fo': '0', '--fx-ag': '0px', '--fx-ao': o.toFixed(3), '--fx-bg': '0px', '--fx-bo': '0' });
        return;
      }
      // a pinch inward, a white flash, then two rings that leave fast and slow down
      const wind = span(t, 0, 0.06), ka = span(t, 0.06, 0.55), kb = span(t, 0.16, 0.75);
      setVars(el, {
        ...vars,
        '--fx-fo': ((a.fill ?? 0.95) * (t < 0.06 ? 0.26 * wind : 1 - outCubic(span(t, 0.06, 0.4)))).toFixed(3),
        '--fx-ag': `${(t < 0.06 ? lerp(5, 0, wind) : lerp(0, 16, outExpo(ka))).toFixed(1)}px`,
        '--fx-ao': (t < 0.06 ? 0.7 * wind : (1 - ka) ** 1.5).toFixed(3),
        '--fx-bg': `${lerp(0, 26, outExpo(kb)).toFixed(1)}px`,
        '--fx-bo': (t < 0.16 ? 0 : 0.6 * (1 - kb) ** 1.5).toFixed(3),
      });
    },
  } };
}

/** The vocabulary by name. */
// (`waiting`: the same tag under its own name, for a state that lasts until it is settled: "sending…" over a tile)
export const EFFECTS = Object.freeze({ flash, ripple, dust, spark, label, glow, banner, toll, number, chip, burst, tag, waiting: tag });

/** Register the vocabulary on an engine. */
export function installEffects(fx) {
  for (const [name, make] of Object.entries(EFFECTS)) fx.define(name, make);
  return fx;
}
