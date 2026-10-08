// Idle life at the near view (UX-DESIGN §8.3): the land is not a still
// picture while nothing happens.
//
//   water shimmer    a few glints on every water tile, each on its own slow beat   (ground pass)
//   cloud shadows    large soft shadows drifting over land and props               (over the props)
//   chimney smoke    a thin plume over every village that is drawn                 (over the props)
//
// All three are painted inside the tile painter (engine.onPaint), so they
// cost one small pass over the tiles in view and nothing when the map is
// not painting tiles. They are functions of the effects clock and a tile's
// own position: no state, the same picture for the same time. While they
// show and nothing else repaints the map, it is asked for another frame
// about six times a second (the tile view repaints more often than that by
// itself whenever a host is in view, and then nothing is asked); when the
// page is hidden, the view is far, or motion is reduced, nothing is asked
// and nothing is drawn. They are decoration only: never the only sign
// of anything.
import { RADIUS, FLATTEN } from '../../map.mjs';
import { hash01, noise1 } from './rand.mjs';

const R = RADIUS, TAU = Math.PI * 2;
/** Idle life is drawn from this many screen px of hex radius (about zoom 0.8). */
export const IDLE_MIN_R = 34;
/** The longest the land stands still while idle life shows, ms (about six frames a second when nothing else repaints the map). */
export const IDLE_FRAME_MS = 160;
/** The cloud shadows repeat over this much world, and drift this fast (world px a second). */
const CLOUD_SPAN = Object.freeze({ x: R * 46, y: R * 30 });
const CLOUD_DRIFT = Object.freeze({ x: 15, y: 5 });
const CLOUDS = Object.freeze([[0.06, 0.18, 3.6, 0.6], [0.24, 0.62, 4.6, 0.52], [0.42, 0.3, 3.0, 0.66], [0.58, 0.82, 4.2, 0.55], [0.74, 0.14, 3.4, 0.62], [0.9, 0.56, 4.8, 0.5], [0.34, 0.96, 2.8, 0.64]]);   // x, y (shares of the span), radius (tiles), flatness

const inView = (st, x, y, pad) => Math.abs(x - st.view.x) < st.size.width / 2 / st.zoom + pad && Math.abs(y - st.view.y) < st.size.height / 2 / st.zoom + pad;
const visible = t => !t.cloud && t.fog !== 'unopened' && t.fog !== 'distant';

/** Glints on the water: `paintWater(ctx, {t, zoom, px, tiles, view, size})` → how many tiles it touched. */
export function paintWater(ctx, st) {
  let n = 0;
  ctx.lineCap = 'round';
  for (const tile of st.tiles) {
    if (tile.name !== 'water' || !visible(tile) || !inView(st, tile.x, tile.y, R)) continue;
    n++;
    for (let i = 0; i < 3; i++) {
      const h = hash01(tile.q * 31 + i, tile.r * 17 + 5), h2 = hash01(tile.q * 13 + 7, tile.r * 29 + i);
      // each glint keeps its own time: it opens, travels a little, and closes
      const period = 2.6 + h * 2.4, k = ((st.t + h2 * period) % period) / period;
      const lit = k < 0.5 ? Math.sin((k / 0.5) * Math.PI) : 0;
      if (lit < 0.03) continue;
      const x = tile.x + (h - 0.5) * R * 1.05 + k * R * 0.14, y = tile.y + (h2 - 0.5) * R * 0.8 * FLATTEN;
      const w = R * (0.1 + 0.1 * h2) * lit;
      ctx.strokeStyle = `rgba(255,255,255,${(0.5 * lit).toFixed(3)})`; ctx.lineWidth = Math.max(1, 1.5 * st.px);
      ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x + w, y); ctx.stroke();
      ctx.strokeStyle = `rgba(190,232,246,${(0.34 * lit).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(x - w * 0.6 + R * 0.05, y + 2.4 * st.px); ctx.lineTo(x + w * 0.6 + R * 0.05, y + 2.4 * st.px); ctx.stroke();
    }
  }
  return n;
}

/** Slow cloud shadows over what is in view. */
export function paintClouds(ctx, st) {
  const hw = st.size.width / 2 / st.zoom, hh = st.size.height / 2 / st.zoom;
  if (!(hw > 0)) return 0;
  let n = 0;
  for (const [cx, cy, rad, flat] of CLOUDS) {
    const r = rad * R;
    // where this cloud's shadow is now, wrapped so one copy is always near the view
    const wx = cx * CLOUD_SPAN.x + st.t * CLOUD_DRIFT.x, wy = cy * CLOUD_SPAN.y + st.t * CLOUD_DRIFT.y;
    const x = st.view.x + ((((wx - st.view.x) % CLOUD_SPAN.x) + CLOUD_SPAN.x * 1.5) % CLOUD_SPAN.x) - CLOUD_SPAN.x / 2;
    const y = st.view.y + ((((wy - st.view.y) % CLOUD_SPAN.y) + CLOUD_SPAN.y * 1.5) % CLOUD_SPAN.y) - CLOUD_SPAN.y / 2;
    if (Math.abs(x - st.view.x) > hw + r || Math.abs(y - st.view.y) > hh + r * flat) continue;
    ctx.save();
    ctx.translate(x, y); ctx.scale(1, flat);
    const g = ctx.createRadialGradient?.(0, 0, r * 0.15, 0, 0, r);
    if (g?.addColorStop) { g.addColorStop(0, 'rgba(10,24,30,0.26)'); g.addColorStop(0.55, 'rgba(10,24,30,0.2)'); g.addColorStop(0.82, 'rgba(10,24,30,0.08)'); g.addColorStop(1, 'rgba(10,24,30,0)'); ctx.fillStyle = g; }
    else ctx.fillStyle = 'rgba(12,26,30,0.06)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.restore();
    n++;
  }
  return n;
}

/** A thin plume over every village in view. */
export function paintSmoke(ctx, st) {
  let n = 0;
  for (const tile of st.tiles) {
    if (tile.site === undefined || tile.state !== 1 || !(tile.owner < 6) || !visible(tile) || !inView(st, tile.x, tile.y, R * 2)) continue;
    n++;
    const seed = (tile.q * 73 + tile.r * 151) | 0;
    // from the roofs at the middle of the village (the sprite's centre is the tile's)
    const x0 = tile.x + (hash01(seed, 1) - 0.5) * R * 0.24 + R * 0.06, y0 = tile.y - R * 0.08;
    for (let i = 0; i < 7; i++) {
      const k = ((st.t * 0.2 + i / 7 + hash01(seed, 2)) % 1);
      const rise = k * R * 1.25, drift = k * k * R * 0.55 + noise1(st.t * 0.5 + i * 3.1, seed & 255) * R * 0.08 * k;
      const r = R * (0.15 + 0.34 * k), o = Math.sin(Math.min(1, k * 7) * Math.PI / 2) * (1 - k) ** 0.8 * 0.92;
      const x = x0 + drift, y = y0 - rise;
      // a soft shade under each puff, so it reads on pale ground too
      const sh = ctx.createRadialGradient?.(x + r * 0.15, y + r * 0.2, 0, x + r * 0.15, y + r * 0.2, r);
      if (sh?.addColorStop) { sh.addColorStop(0, `rgba(70,74,72,${(o * 0.3).toFixed(3)})`); sh.addColorStop(1, 'rgba(70,74,72,0)'); ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(x + r * 0.15, y + r * 0.2, r, 0, TAU); ctx.fill(); }
      const g = ctx.createRadialGradient?.(x, y, 0, x, y, r);
      if (g?.addColorStop) { g.addColorStop(0, `rgba(252,250,246,${o.toFixed(3)})`); g.addColorStop(0.6, `rgba(238,234,226,${(o * 0.7).toFixed(3)})`); g.addColorStop(1, 'rgba(214,208,196,0)'); ctx.fillStyle = g; }
      else ctx.fillStyle = `rgba(238,234,224,${(o * 0.4).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
  }
  return n;
}

/** Put idle life on an engine. Returns its remover. */
export function installIdle(fx) {
  let timer = null;
  const hidden = () => { try { return !!globalThis.document?.hidden; } catch { return false; } };
  const on = st => st.mode === 'full' && st.zoom * R >= IDLE_MIN_R && st.size.width > 0 && !hidden();
  // Another frame, but only when the map is not repainting on its own account anyway (it does about fourteen
  // times a second whenever a host is in view): the timer looks at when the painter last ran and asks only if
  // nothing has painted for a whole interval.
  let last = 0;
  const wall = () => globalThis.performance?.now?.() ?? Date.now();
  const again = st => {
    last = wall();
    if (timer || !globalThis.setTimeout) return;
    const wake = () => {
      timer = null;
      const quiet = wall() - last;
      if (quiet >= IDLE_FRAME_MS - 8) st.invalidate();
      else timer = globalThis.setTimeout(wake, IDLE_FRAME_MS - quiet);
    };
    timer = globalThis.setTimeout(wake, IDLE_FRAME_MS);
  };
  const offs = [
    fx.onPaint('ground', (ctx, st) => (on(st) ? paintWater(ctx, st) : 0)),
    fx.onPaint('over', (ctx, st) => {
      if (!on(st)) return 0;
      const n = paintClouds(ctx, st) + paintSmoke(ctx, st);
      again(st);
      return n;
    }),
  ];
  return () => { offs.forEach(f => f()); if (timer) globalThis.clearTimeout?.(timer); timer = null; };
}
