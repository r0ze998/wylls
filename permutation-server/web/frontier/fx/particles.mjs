// Particles for effects (UX-DESIGN §8.1): a fixed pool, seeded by the id of
// the event that caused them, living in the map's world space.
//
// A particle is not simulated step by step. `emit` writes its launch (where,
// how fast, how long) into the pool once; `draw` computes where it is at the
// clock's time in closed form (drag on the ground plane, a ballistic arc
// with up to two bounces or a buoyant rise for its height). So a frozen,
// slowed or rewound clock (fx/clock.mjs) shows exactly the same picture, the
// same event paints the same burst on every device, and a frame costs one
// pass over the pool with no allocation.
//
// World space: x, y are the map's world pixels on the ground plane (the same
// numbers as map.mjs project()), z is height above the ground (drawn at
// y - z). Ground speed is squashed by FLATTEN on y, so a burst spreads as the
// ellipse a circle on the ground makes under the map's camera.
//
// Kinds: dust, spark, ember, smoke, shard, leaf, coin, mist, ink.
import { hashSeed, rng } from './rand.mjs';

/** The map's vertical squash (web/map.mjs FLATTEN; repeated so this file needs no map import). */
export const GROUND_FLATTEN = 0.76;
const R = 44;   // the hex radius in world px (web/map.mjs RADIUS): sizes below are in parts of a tile

/**
 * Each kind's launch ranges and look. Speeds in world px/s, sizes in world px,
 * life in seconds. `g` > 0 is gravity (ballistic, lands and bounces by `bounce`);
 * `rise` is a steady climb (buoyant kinds). `add` draws with additive blending.
 */
export const KINDS = Object.freeze({
  dust:  { add: false, shape: 'puff',   speed: [50, 190],  up: [8, 40],    drag: 4.2, g: 0,   rise: 10, bounce: 0,    life: [0.55, 1.0], size: [R * 0.12, R * 0.23], grow: 1.9,  alpha: 0.56, fadeIn: 0.05, fadeOut: 0.22, sway: 0,   colors: ['#ecdfbf', '#dfcda4', '#f4ead2'] },
  spark: { add: true,  shape: 'streak', speed: [90, 330],  up: [120, 380], drag: 1.3, g: 760, rise: 0,  bounce: 0.34, life: [0.32, 0.8], size: [1.3, 2.4],           grow: 0.4,  alpha: 1,    fadeIn: 0,    fadeOut: 0.55, sway: 0,   colors: ['#ffd27a', '#ffb347', '#ff8a3c'] },
  ember: { add: true,  shape: 'dot',    speed: [8, 46],    up: [26, 80],   drag: 1.6, g: 0,   rise: 30, bounce: 0,    life: [0.9, 1.9],  size: [1.6, 3.2],           grow: 0.5,  alpha: 0.95, fadeIn: 0.05, fadeOut: 0.5,  sway: 5,   colors: ['#ffb347', '#ff7a3c', '#e2553d'] },
  smoke: { add: false, shape: 'puff',   speed: [4, 20],    up: [22, 52],   drag: 1.0, g: 0,   rise: 34, bounce: 0,    life: [1.3, 2.4],  size: [R * 0.1, R * 0.19],  grow: 2.5,  alpha: 0.52, fadeIn: 0.1,  fadeOut: 0.35, sway: 5,   colors: ['#6a645b', '#857e75', '#57524b'] },
  shard: { add: false, shape: 'poly',   speed: [70, 230],  up: [140, 340], drag: 1.0, g: 820, rise: 0,  bounce: 0.38, life: [0.6, 1.15], size: [2.6, 5.2],           grow: 1,    alpha: 1,    fadeIn: 0,    fadeOut: 0.75, sway: 0,   colors: ['#6b6253', '#857c6b', '#544d41'] },
  leaf:  { add: false, shape: 'leaf',   speed: [20, 90],   up: [50, 150],  drag: 2.2, g: 150, rise: 0,  bounce: 0,    life: [1.2, 2.2],  size: [3.4, 5.8],           grow: 1,    alpha: 0.98, fadeIn: 0.04, fadeOut: 0.7,  sway: 9,   colors: ['#8fc257', '#b5cf5a', '#e0bd52', '#d38d3f', '#5f9a4a'] },
  coin:  { add: false, shape: 'coin',   speed: [40, 150],  up: [200, 400], drag: 1.2, g: 860, rise: 0,  bounce: 0.5,  life: [0.75, 1.3], size: [3.2, 4.6],           grow: 1,    alpha: 1,    fadeIn: 0,    fadeOut: 0.8,  sway: 0,   colors: ['#f0d48a', '#c9a24a', '#ffe9ae'] },
  mist:  { add: false, shape: 'puff', flat: true, speed: [10, 46],   up: [0, 6],     drag: 0.9, g: 0,   rise: 3,  bounce: 0,    life: [1.6, 3.0],  size: [R * 0.34, R * 0.6],  grow: 1.9,  alpha: 0.24, fadeIn: 0.25, fadeOut: 0.4,  sway: 3,   colors: ['#f4f1e8', '#e3e8ea'] },
  ink:   { add: false, shape: 'blot',   speed: [0, 26],    up: [0, 0],     drag: 6,   g: 0,   rise: 0,  bounce: 0,    life: [0.9, 1.7],  size: [R * 0.05, R * 0.13], grow: 2.4,  alpha: 0.6,  fadeIn: 0.03, fadeOut: 0.5,  sway: 0,   colors: ['#4a3b22', '#6b5630', '#3a2e1c'] },
});
export const KIND_NAMES = Object.freeze(Object.keys(KINDS));
const KIND_LIST = KIND_NAMES.map(k => KINDS[k]);

// ------------------------------------------------------------------ soft sprites (one small canvas per colour)
const sprites = new Map();
const darker = (hex, f) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`; };
/**
 * A 64-px soft disc of `color` (null where there is no canvas: node, tests).
 * `shaded`: lit from above, its underside darker, so a puff of dust or smoke
 * reads as a volume and stays visible on ground of its own colour.
 */
function softSprite(color, shaded = false) {
  const key = shaded ? `${color}|s` : color;
  if (sprites.has(key)) return sprites.get(key);
  let c = null;
  try {
    c = typeof globalThis.OffscreenCanvas === 'function' ? new globalThis.OffscreenCanvas(64, 64) : globalThis.document?.createElement?.('canvas') ?? null;
    if (c) {
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      // the colour everywhere, then an alpha falloff cut into it: the hue stays true out to the rim
      g.fillStyle = color;
      g.fillRect(0, 0, 64, 64);
      if (shaded && /^#[0-9a-f]{6}$/i.test(color)) {
        const sh = g.createLinearGradient(0, 14, 0, 58);
        sh.addColorStop(0, 'rgba(255,255,255,0.28)'); sh.addColorStop(0.35, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(0,0,0,0)');
        g.fillStyle = sh; g.fillRect(0, 0, 64, 64);
        const lo = g.createLinearGradient(0, 30, 0, 60);
        lo.addColorStop(0, 'rgba(0,0,0,0)'); lo.addColorStop(1, darker(color, 0.5));
        g.globalAlpha = 0.75; g.fillStyle = lo; g.fillRect(0, 0, 64, 64); g.globalAlpha = 1;
      }
      g.globalCompositeOperation = 'destination-in';
      const a = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      if (shaded) { a.addColorStop(0, 'rgba(0,0,0,1)'); a.addColorStop(0.45, 'rgba(0,0,0,0.92)'); a.addColorStop(0.75, 'rgba(0,0,0,0.42)'); a.addColorStop(1, 'rgba(0,0,0,0)'); }
      else { a.addColorStop(0, 'rgba(0,0,0,1)'); a.addColorStop(0.25, 'rgba(0,0,0,0.82)'); a.addColorStop(0.6, 'rgba(0,0,0,0.3)'); a.addColorStop(1, 'rgba(0,0,0,0)'); }
      g.fillStyle = a; g.fillRect(0, 0, 64, 64);
    }
  } catch { c = null; }
  if (sprites.size > 96) sprites.clear();
  sprites.set(key, c);
  return c;
}

/** How many different puffs a colour has (a cloud of dust is never one stamp repeated). */
export const PUFF_VARIANTS = 4;
const shade = (hex, f) => { const n = parseInt(String(hex).slice(1), 16) || 0; const c = sh => Math.max(0, Math.min(255, Math.round(((n >> sh) & 255) * f + (f > 1 ? 255 * (f - 1) * 0.6 : 0)))); return `rgb(${c(16)},${c(8)},${c(0)})`; };
/**
 * A puff of dust or smoke in `color`, drawn by code (null where there is no canvas): a billow of many small
 * lobes of slightly different tone thrown together off-centre, each lit from above, the whole dark beneath,
 * its edge broken and a little darker earth carried in it, so it reads as churned dust and not as a soft
 * disc. Seeded by its colour and variant: the same puff on every device.
 */
function puffSprite(color, variant = 0) {
  const key = `${color}|p${variant}`;
  if (sprites.has(key)) return sprites.get(key);
  let c = null;
  try {
    const S = 96, cx = S / 2, cy = S * 0.54;
    c = typeof globalThis.OffscreenCanvas === 'function' ? new globalThis.OffscreenCanvas(S, S) : globalThis.document?.createElement?.('canvas') ?? null;
    if (c) {
      c.width = S; c.height = S;
      const g = c.getContext('2d'), r = rng(hashSeed(key));
      const plain = /^#[0-9a-f]{6}$/i.test(color);
      // the billow: a core and two rings of lobes, the outer ones smaller; wider than it is tall
      const lobes = [[cx + r.range(-3, 3), cy, r.range(17, 21)]];
      const n1 = 6 + (variant % 2), n2 = 8 + (variant % 3);
      for (let i = 0; i < n1; i++) { const a = (i / n1) * Math.PI * 2 + r.range(-0.4, 0.4), d = r.range(10, 17); lobes.push([cx + Math.cos(a) * d * 1.2, cy + Math.sin(a) * d * 0.72, r.range(10, 15)]); }
      for (let i = 0; i < n2; i++) { const a = (i / n2) * Math.PI * 2 + r.range(-0.4, 0.4), d = r.range(21, 31); lobes.push([cx + Math.cos(a) * d * 1.16, cy + Math.sin(a) * d * 0.66, r.range(5, 10)]); }
      // back to front (lower lobes over higher ones), each its own tone
      lobes.sort((p, q) => p[1] - q[1]);
      for (const [x, y, rad] of lobes) {
        const tone = plain ? shade(color, r.range(0.95, 1.04)) : color;
        const gr = g.createRadialGradient(x, y, 0, x, y, rad * 1.25);
        gr.addColorStop(0, tone); gr.addColorStop(0.3, tone); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = 0.8; g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
        if (plain) {
          // lit from above and a little to the left
          const hi = g.createRadialGradient(x - rad * 0.28, y - rad * 0.36, 0, x - rad * 0.28, y - rad * 0.36, rad * 0.8);
          hi.addColorStop(0, 'rgba(255,252,240,0.26)'); hi.addColorStop(1, 'rgba(255,252,240,0)');
          g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 1; g.fillStyle = hi; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
          g.globalCompositeOperation = 'source-over';
        }
      }
      g.globalAlpha = 1;
      if (plain) {
        // its own shadow beneath, and darker earth carried in it
        g.globalCompositeOperation = 'source-atop';
        const lo = g.createLinearGradient(0, S * 0.5, 0, S * 0.9);
        lo.addColorStop(0, 'rgba(0,0,0,0)'); lo.addColorStop(1, darker(color, 0.4));
        g.globalAlpha = 0.34; g.fillStyle = lo; g.fillRect(0, 0, S, S);
        g.fillStyle = darker(color, 0.7);
        for (let i = 0; i < 8; i++) { g.globalAlpha = r.range(0.04, 0.09); g.beginPath(); g.ellipse(r.range(22, S - 22), r.range(34, S - 24), r.range(0.8, 2.2), r.range(0.6, 1.4), r() * 3, 0, Math.PI * 2); g.fill(); }
        g.globalAlpha = 1;
      }
      // the edge breaks up: a few bites out of the rim, none out of the body
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 12; i++) {
        const a = r() * Math.PI * 2, d = r.range(30, 44);
        g.globalAlpha = r.range(0.25, 0.55);
        g.beginPath(); g.arc(cx + Math.cos(a) * d * 1.12, cy + Math.sin(a) * d * 0.7, r.range(2.5, 6), 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      // and feathered as a whole: no hard rim anywhere
      g.globalCompositeOperation = 'destination-in';
      const f = g.createRadialGradient(cx, cy, S * 0.16, cx, cy, S * 0.5);
      f.addColorStop(0, 'rgba(0,0,0,1)'); f.addColorStop(0.7, 'rgba(0,0,0,0.75)'); f.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = f; g.fillRect(0, 0, S, S);
    }
  } catch { c = null; }
  if (sprites.size > 160) sprites.clear();
  sprites.set(key, c);
  return c;
}

const smooth = k => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

/**
 * A pool of `capacity` particles. `emit` overwrites the oldest when full.
 * Layers: 'top' (the effects canvas) and 'ground' (inside the tile painter).
 */
export function createParticles({ capacity = 2048 } = {}) {
  const N = capacity;
  const born = new Float64Array(N), life = new Float32Array(N);
  const x0 = new Float32Array(N), y0 = new Float32Array(N), z0 = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
  const size = new Float32Array(N), rot = new Float32Array(N), spin = new Float32Array(N), ph = new Float32Array(N), al = new Float32Array(N);
  const kind = new Uint8Array(N), layer = new Uint8Array(N), used = new Uint8Array(N);
  const col = new Array(N).fill('');
  let head = 0, live = 0, last = -Infinity, first = Infinity;
  const out = { x: 0, y: 0, z: 0, size: 0, alpha: 0, rot: 0, k: 0, speed: 0, dx: 0, dy: 0 };

  /** Where particle i is at clock time t (null when not alive then). Fills and returns the shared `out`. */
  function state(i, t) {
    if (!used[i]) return null;
    const age = t - born[i];
    if (age < 0 || age >= life[i]) return null;
    const K = KIND_LIST[kind[i]];
    const k = age / life[i];
    const d = K.drag;
    const e = d > 0 ? (1 - Math.exp(-d * age)) / d : age;
    let x = x0[i] + vx[i] * e, y = y0[i] + vy[i] * e, z;
    let dz;   // vertical speed (for a streak's direction)
    if (K.g > 0) {
      const g = K.g, v = vz[i];
      const land = (v + Math.sqrt(v * v + 2 * g * z0[i])) / g;
      if (age < land) { z = z0[i] + v * age - 0.5 * g * age * age; dz = v - g * age; }
      else {
        let v1 = K.bounce * (g * land - v), tt = age - land;
        z = 0; dz = 0;
        for (let b = 0; b < 2 && v1 > 12; b++) {
          const T = (2 * v1) / g;
          if (tt < T) { z = v1 * tt - 0.5 * g * tt * tt; dz = v1 - g * tt; break; }
          tt -= T; v1 *= K.bounce;
        }
      }
    } else { z = z0[i] + vz[i] * e + K.rise * age; dz = vz[i] * Math.exp(-d * age) + K.rise; }
    if (K.sway) x += Math.sin(age * 3.1 + ph[i] * 6.283) * K.sway * smooth(k * 3);
    const fade = (K.fadeIn > 0 ? smooth(k / K.fadeIn) : 1) * (1 - smooth((k - K.fadeOut) / (1 - K.fadeOut)));
    const ex = Math.exp(-d * age);
    out.x = x; out.y = y; out.z = z; out.k = k;
    out.size = size[i] * (1 + (K.grow - 1) * (K.grow > 1 ? 1 - (1 - k) * (1 - k) : k));
    out.alpha = al[i] * fade;
    out.rot = rot[i] + spin[i] * age;
    out.dx = vx[i] * ex; out.dy = vy[i] * ex - dz;
    out.speed = Math.hypot(out.dx, out.dy);
    return out;
  }

  /**
   * Launch `n` particles of `kind` from (x, y, z) at clock time `t`.
   * `seed`: the event id (string or number). Options: `power` scales the
   * speeds, `dir` + `spread` (radians) aim the ground direction (default all
   * round), `radius` scatters the start on a ground disc, `stagger` spreads
   * the births over that many seconds, `life` and `size` scale those ranges,
   * `up` scales the upward launch, `color` (one) or `colors` (list) replace
   * the kind's own, `alpha` scales opacity, `layer` 'top' | 'ground'.
   * Returns the number launched.
   */
  function emit(kindName, { x = 0, y = 0, z = 0, n = 12, seed = 0, t = 0, power = 1, dir = 0, spread = Math.PI * 2, radius = 0, stagger = 0,
    life: lifeK = 1, size: sizeK = 1, up = 1, color = null, colors = null, alpha = 1, layer: lay = 'top', ring = false } = {}) {
    const ki = KIND_NAMES.indexOf(kindName);
    if (ki < 0 || !(n > 0)) return 0;
    const K = KIND_LIST[ki];
    const r = rng(hashSeed(`${seed}|${kindName}`));
    const palette = colors?.length ? colors : color ? [color] : K.colors;
    const count = Math.min(n | 0, N);
    for (let j = 0; j < count; j++) {
      const i = head; head = (head + 1) % N;
      if (!used[i]) { used[i] = 1; live++; }
      // launch from a disc on the ground, faster ones a little later in the fan: even coverage
      // (`ring`: from the rim of that disc, each one straight outward: a skirt round something that stands there)
      const ra = r() * Math.PI * 2, rr = ring ? radius * r.range(0.92, 1.08) : radius * Math.sqrt(r());
      const a = ring ? ra + (r() - 0.5) * 0.5 : dir + (r() - 0.5) * spread;
      const sp = r.range(K.speed[0], K.speed[1]) * power;
      born[i] = t + (stagger > 0 ? r() * stagger : 0);
      life[i] = r.range(K.life[0], K.life[1]) * lifeK;
      x0[i] = x + Math.cos(ra) * rr; y0[i] = y + Math.sin(ra) * rr * GROUND_FLATTEN; z0[i] = z;
      vx[i] = Math.cos(a) * sp; vy[i] = Math.sin(a) * sp * GROUND_FLATTEN;
      vz[i] = r.range(K.up[0], K.up[1]) * up * (0.6 + 0.4 * power);
      size[i] = r.range(K.size[0], K.size[1]) * sizeK;
      rot[i] = r() * Math.PI * 2; spin[i] = (r() - 0.5) * (K.shape === 'coin' ? 26 : K.shape === 'leaf' ? 9 : 14);
      ph[i] = r(); al[i] = K.alpha * alpha * r.range(0.75, 1);
      kind[i] = ki; layer[i] = lay === 'ground' ? 1 : 0;
      col[i] = palette[r.int(palette.length)];
      if (born[i] + life[i] > last) last = born[i] + life[i];
      if (born[i] < first) first = born[i];
    }
    return count;
  }

  function paintOne(ctx, i, s, zoom) {
    const K = KIND_LIST[kind[i]];
    const sx = s.x, sy = s.y - s.z;
    ctx.globalAlpha = s.alpha;
    switch (K.shape) {
      case 'puff': if (!K.flat) {
        // a textured puff: one of a few drawn clouds, turned, and drawn out along its way while it is still fast
        const img = puffSprite(col[i], i % PUFF_VARIANTS);
        const r = Math.max(s.size, 0.8 / zoom) * 2.1;
        if (img && ctx.drawImage && ctx.translate && ctx.rotate) {
          const stretch = 1 + Math.min(0.7, s.speed * 0.0042);
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(s.speed > 6 ? Math.atan2(s.dy, s.dx) * 0.6 + Math.sin(ph[i] * 6.283) * 0.5 : Math.sin(ph[i] * 6.283) * 0.5 + s.rot * 0.04);
          ctx.scale(stretch * (ph[i] > 0.5 ? 1 : -1), 0.8);
          ctx.drawImage(img, -r, -r, r * 2, r * 2);
          ctx.restore();
        } else { ctx.beginPath(); ctx.ellipse?.(sx, sy, r * 0.5, r * 0.36, 0, 0, Math.PI * 2); ctx.fillStyle = col[i]; ctx.fill(); }
        break;
      }
      // falls through: a flat puff (mist) is a soft disc
      case 'dot': {
        const hot = K.add && s.k < 0.22 ? '#fff6dc' : col[i];
        const img = softSprite(hot, false);
        const r = Math.max(s.size, 0.8 / zoom) * (K.shape === 'dot' ? 2.2 : 1.6);
        const ry = K.shape === 'puff' ? r * 0.76 : r;
        if (img && ctx.drawImage) ctx.drawImage(img, sx - r, sy - ry, r * 2, ry * 2);
        else { ctx.beginPath(); ctx.ellipse?.(sx, sy, r * 0.6, ry * 0.6, 0, 0, Math.PI * 2); ctx.fillStyle = hot; ctx.fill(); }
        break;
      }
      case 'streak': {
        // a line along the motion, longer the faster it flies; a hot core early in its life
        const len = Math.min(26, Math.max(2.5, s.speed * 0.045));
        const n = s.speed > 1 ? 1 / s.speed : 0;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(s.size, 1 / zoom);
        ctx.strokeStyle = s.k < 0.3 ? '#fff6dc' : col[i];
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - s.dx * n * len, sy - s.dy * n * len); ctx.stroke();
        break;
      }
      case 'poly': {
        const r = s.size, a = s.rot;
        ctx.fillStyle = col[i];
        ctx.beginPath();
        for (let v = 0; v < 4; v++) { const b = a + v * 1.5708 + (v & 1 ? 0.5 : 0); const rr = r * (v & 1 ? 0.62 : 1); if (v) ctx.lineTo(sx + Math.cos(b) * rr, sy + Math.sin(b) * rr); else ctx.moveTo(sx + Math.cos(b) * rr, sy + Math.sin(b) * rr); }
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'leaf': {
        const flip = Math.cos(s.rot * 1.7);
        // a dark underside as it turns over: it reads on grass of its own colour
        ctx.fillStyle = flip < -0.2 ? '#3d5a2c' : col[i];
        ctx.beginPath(); ctx.ellipse?.(sx, sy, s.size, Math.max(0.6, Math.abs(flip) * s.size * 0.5), s.rot, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'coin': {
        const flip = Math.abs(Math.cos(s.rot));
        ctx.fillStyle = flip > 0.75 ? '#fff3c4' : col[i];
        ctx.beginPath(); ctx.ellipse?.(sx, sy, s.size, Math.max(0.6, flip * s.size), 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#7d6428'; ctx.lineWidth = Math.max(0.6, 0.6 / zoom); ctx.stroke();
        break;
      }
      case 'blot': {
        // three overlapping discs from the particle's own phase: an uneven ink stain on the ground
        ctx.fillStyle = col[i];
        ctx.beginPath();
        for (let b = 0; b < 3; b++) {
          const a = ph[i] * 6.283 + b * 2.2, o = s.size * 0.45;
          const rb = s.size * (0.8 - b * 0.12), bx = sx + Math.cos(a) * o, by = sy + Math.sin(a) * o * GROUND_FLATTEN;
          ctx.moveTo(bx + rb, by);
          ctx.ellipse?.(bx, by, rb, rb * GROUND_FLATTEN, 0, 0, Math.PI * 2);
        }
        ctx.fill();
        break;
      }
      default: break;
    }
  }

  /**
   * Draw the particles alive at clock time `t` on `layer` ('top' | 'ground').
   * The context is in world space (the map's transform). Returns how many were drawn.
   */
  function draw(ctx, t, { layer: lay = 'top', zoom = 1 } = {}) {
    if (!live || t >= last || t < first) return 0;
    const L = lay === 'ground' ? 1 : 0;
    let n = 0;
    ctx.save?.();
    for (let pass = 0; pass < 2; pass++) {
      let any = false;
      for (let i = 0; i < N; i++) {
        if (!used[i] || layer[i] !== L || KIND_LIST[kind[i]].add !== (pass === 1)) continue;
        const s = state(i, t);
        if (!s || s.alpha <= 0.004) continue;
        if (!any) { ctx.globalCompositeOperation = pass ? 'lighter' : 'source-over'; any = true; }
        paintOne(ctx, i, s, zoom);
        n++;
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.restore?.();
    return n;
  }

  return {
    capacity: N,
    emit,
    draw,
    /** How many particles are alive at t (on a layer, or on any). */
    liveAt(t, lay = null) {
      if (!live || t >= last || t < first) return 0;
      let n = 0;
      const L = lay === 'ground' ? 1 : 0;
      for (let i = 0; i < N; i++) if (used[i] && (lay === null || layer[i] === L) && t >= born[i] && t < born[i] + life[i]) n++;
      return n;
    },
    /** The clock time after which nothing is alive (−∞ when empty). */
    get until() { return live ? last : -Infinity; },
    /** Every live particle at t as plain numbers (tests, and the proof that a seed fixes the picture). */
    snapshot(t) {
      const list = [];
      for (let i = 0; i < N; i++) { const s = state(i, t); if (s) list.push({ kind: KIND_NAMES[kind[i]], x: s.x, y: s.y, z: s.z, size: s.size, alpha: s.alpha, rot: s.rot, color: col[i] }); }
      return list;
    },
    clear() { used.fill(0); live = 0; head = 0; last = -Infinity; first = Infinity; },
    get count() { return live; },
  };
}
