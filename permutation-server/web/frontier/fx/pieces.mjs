// The parts the set pieces are assembled from (UX-DESIGN §8.3), beyond the
// first vocabulary of effects.mjs. fx/stage.mjs composes them when the page
// reports an event; the demo switch plays the same compositions.
//
//   mark      a round tick or cross over a tile (an action landed / was refused)   top
//   pending   a ring turning on a tile while an action is tracked                  top
//   pulse     a tile beats in a colour (red: refused; ember: a warning)            ground
//   stamp     a wax seal comes down at 56 px with squash and a brass ring          top
//   route     the route of an own march draws on as a ribbon                       top
//   sealed    the same ribbon at rest with its seal, until the turn                ground (still)
//   walker    a short column steps off along a path                                top
//   unseal    a seal breaks open on a tile (an own arrival revealed)               top
//   swords    crossed swords strike over a tile (an own battle resolved)           top
//   alarm     ember rings close on a tile (an attack may come)                     ground + top
//   pillar    a shaft of light where a building has just been finished             top
//   forming   a mustered host runs out and forms a line                            top
//   raise     a standard goes up on a tile (a village changed hands)               top
//   fly       icons fly from a tile to an element of the HUD (a harvest)           hud
//   pip       the far view's form of any of these: a dot with rings                top
//
// Positions as in effects.mjs: `{x, y}`, `{q, r}` or `{p, q, tile}`.
// Reduced motion: nothing travels; each shows its end state with a 200 ms
// opacity change. With effects off none of these is drawn (labels, numbers
// and banners carry the information).
import { RADIUS, FLATTEN } from '../../map.mjs';
import { paintMini } from '../people/minis.mjs';
import { baseDisc, unitFigure } from '../people/units.mjs';
import { battleScale, crossedSwords } from '../people/battle.mjs';
import { clamp01, lerp, span, inQuad, inCubic, outQuad, outCubic, outExpo, outBack, envelope } from './ease.mjs';
import { REDUCED_FADE } from './motion.mjs';
import { TONE, rgba, pointOf, hexPath, groundRing, radial, lighter, viewportPoint, setVars, node } from './effects.mjs';
import { waxSeal, ribbon, smoothPath, pathAt, roundMark, farPip, standard, isFar } from './draw.mjs';
import { burn } from './battle.mjs';

const R = RADIUS, TAU = Math.PI * 2;
/** The wax seal's size on screen when it stamps (px across). */
export const SEAL_PX = 56;

// ------------------------------------------------------------------ mark: landed / refused
/** `{…position, kind: 'ok' | 'no', color, size (px radius, default 19), lift (tiles, default 0.95)}` */
function mark(a, env) {
  const { x, y } = pointOf(a);
  const kind = a.kind === 'no' ? 'no' : 'ok', color = a.color ?? (kind === 'no' ? TONE.ember : TONE.you);
  const r = a.size ?? 19, lift = (a.lift ?? 0.95) * R, dur = 1.35;
  const full = env.mode === 'full';
  return { layer: 'top', dur, draw(ctx, s) {
    const t = s.t, px = s.px;
    if (!full) { roundMark(ctx, x, y - lift, r * px, { kind, color, k: 1, alpha: envelope(t, dur, REDUCED_FADE, REDUCED_FADE) }); return; }
    const out = span(t, dur - 0.3, dur);
    // a refusal shudders; an acceptance lands with one rebound
    const shudder = kind === 'no' ? Math.sin(t * 46) * 4 * px * (1 - span(t, 0.08, 0.42)) : 0;
    roundMark(ctx, x + shudder, y - lift - 8 * px * inQuad(out), r * px, { kind, color, k: span(t, 0.06, 0.4), alpha: span(t, 0, 0.05) * (1 - inQuad(out)), scale: lerp(0.3, 1, outBack(span(t, 0, 0.2), 2.4)) });
    if (kind === 'ok' && t < 0.5) {
      lighter(ctx);
      const k = span(t, 0.08, 0.5), rr = lerp(r, r * 2.4, outExpo(k)) * px;
      ctx.strokeStyle = rgba(color, 0.8 * (1 - k) ** 1.5); ctx.lineWidth = lerp(4, 1, k) * px;
      ctx.beginPath(); ctx.arc(x, y - lift, rr, 0, TAU); ctx.stroke();
    }
  } };
}

// ------------------------------------------------------------------ pending: tracked
/** `{…position, color, dur (default 75: until it is cancelled)}`: three arcs turn on the tile while an action is on its way. */
function pending(a, env) {
  const { x, y } = pointOf(a);
  const color = a.color ?? TONE.brassHi, dur = a.dur ?? 75;
  const full = env.mode === 'full';
  return { layer: 'top', dur, draw(ctx, s) {
    const t = s.t, px = s.px, o = span(t, 0, 0.2) * (1 - span(t, dur - 0.3, dur));
    const rr = R * 0.66, ry = rr * FLATTEN;
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba('#0c1614', 0.4 * o); ctx.lineWidth = 6 * px; ctx.beginPath(); ctx.ellipse?.(x, y, rr, ry, 0, 0, TAU); ctx.stroke();
    const turn = full ? t * 2.6 : 0;
    for (let i = 0; i < 3; i++) {
      const a0 = turn + (i / 3) * TAU;
      ctx.strokeStyle = rgba(color, (i === 0 ? 1 : 0.6) * o); ctx.lineWidth = (i === 0 ? 3.4 : 2.6) * px;
      ctx.beginPath(); ctx.ellipse?.(x, y, rr, ry, 0, a0, a0 + TAU * 0.2); ctx.stroke();
    }
    if (full) { lighter(ctx); ctx.fillStyle = radial(ctx, x, y, 0, rr, [[0, rgba(color, 0.16 * o * (0.6 + 0.4 * Math.sin(t * 3.2)))], [1, rgba(color, 0)]]); groundRing(ctx, x, y, rr); ctx.fill(); }
  } };
}

// ------------------------------------------------------------------ pulse: a tile beats
/** `{…position, color (default ember), beats (default 2)}` */
function pulse(a, env) {
  const { x, y } = pointOf(a);
  const color = a.color ?? TONE.ember, beats = Math.max(1, a.beats ?? 2), GAP = 0.24;
  if (env.mode !== 'full') {
    const dur = 0.6;
    return { layer: 'ground', dur, draw(ctx, s) {
      const o = envelope(s.t, dur, REDUCED_FADE, REDUCED_FADE);
      hexPath(ctx, x, y, 1); ctx.fillStyle = rgba(color, 0.42 * o); ctx.fill(); ctx.strokeStyle = rgba(color, 0.95 * o); ctx.lineWidth = 3 * s.px; ctx.stroke();
    } };
  }
  const dur = (beats - 1) * GAP + 0.6;
  return { layer: 'ground', dur, draw(ctx, s) {
    for (let i = 0; i < beats; i++) {
      const u = s.t - i * GAP;
      if (u < 0 || u > 0.6) continue;
      const k = u / 0.6, hit = 1 - outCubic(span(u, 0, 0.34));
      hexPath(ctx, x, y, 1); ctx.fillStyle = rgba(color, 0.6 * hit); ctx.fill();
      ctx.strokeStyle = rgba(color, 0.95 * (1 - k)); ctx.lineWidth = lerp(4.5, 1.5, k) * s.px; ctx.stroke();
      // a ring that closes on the tile: the refusal comes back to where it was asked
      groundRing(ctx, x, y, lerp(R * 1.7, R * 0.78, outCubic(span(u, 0, 0.3))));
      ctx.strokeStyle = rgba(color, 0.8 * (1 - span(u, 0.1, 0.4))); ctx.lineWidth = 2.5 * s.px; ctx.stroke();
    }
  } };
}

// ------------------------------------------------------------------ stamp: the wax seal
/**
 * `{…position, size (px across, default 56), lift (tiles, default 0), caption, hold (s, default 1.5), rest (the scale it shrinks to as it leaves, default 0.5)}`:
 * the seal comes down fast, lands with squash and a white flash, a brass ring
 * leaves it, drops of wax and a little dust fly; it holds, then settles small.
 */
function stamp(a, env) {
  const p = pointOf(a);
  const size = a.size ?? SEAL_PX, x = p.x, y = p.y - (a.lift ?? 0) * R;
  const hold = a.hold ?? 1.5, rest = a.rest ?? 0.5, caption = a.caption ? String(a.caption) : '';
  const HIT = 0.16, dur = HIT + hold + 0.3;
  const text = (ctx, s, o) => {
    if (!caption || o <= 0.01) return;
    ctx.save();
    ctx.translate(x, y + (size * 0.5 + 15) * s.px); ctx.scale(s.px, s.px);
    ctx.globalAlpha = o; ctx.font = '700 13px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba('#0c1614', 0.92); ctx.lineWidth = 4; ctx.strokeText?.(caption, 0, 0);
    ctx.fillStyle = TONE.ivory; ctx.fillText?.(caption, 0, 0);
    ctx.restore();
  };
  if (env.mode !== 'full') {
    return { layer: 'top', dur, info: !!caption, draw(ctx, s) {
      const o = envelope(s.t, dur, REDUCED_FADE, REDUCED_FADE);
      waxSeal(ctx, x, y, (size / 2) * s.px, { alpha: o });
      text(ctx, s, o);
    } };
  }
  env.fx.emit('shard', { x, y, n: 9, seed: `${env.seed}|wax`, t: env.now + HIT, radius: R * 0.1, power: 0.75, up: 0.55, size: 0.7, life: 0.7, colors: ['#9a2617', '#d2533c', '#5a130b'] });
  if (a.dust) env.fx.emit('dust', { x, y, n: 10, seed: `${env.seed}|dust`, t: env.now + HIT, radius: R * 0.2, power: 0.7, up: 0.5 });
  if (a.shake !== 0) env.fx.shake(a.shake ?? 3, 130, { seed: env.seed, delay: HIT });
  return { layer: 'top', dur, draw(ctx, s) {
    const t = s.t, px = s.px, r = (size / 2) * px;
    if (t < HIT) {
      // it comes down: larger, a little above, its shadow gathering under it
      const k = inCubic(t / HIT);
      ctx.fillStyle = rgba('#0c1614', 0.3 * k); ctx.beginPath(); ctx.ellipse?.(x, y + r * 0.1, r * lerp(1.5, 1.05, k), r * lerp(1.4, 1, k), 0, 0, TAU); ctx.fill();
      waxSeal(ctx, x, y - lerp(30, 0, k) * px, r * lerp(1.9, 1.02, k), { alpha: span(t, 0, 0.05), rot: lerp(-0.5, -0.14, k) });
      return;
    }
    const u = t - HIT;
    const out = span(t, dur - 0.3, dur);
    // squash on landing, one rebound, then still
    const sq = u < 0.06 ? 1 : 1 - outBack(span(u, 0.06, 0.3), 2.2);
    const scale = lerp(1, rest, inQuad(out));
    waxSeal(ctx, x, y, r * scale, { sx: 1 + 0.2 * sq, sy: 1 - 0.24 * sq, alpha: 1 - 0.15 * out });
    text(ctx, s, span(u, 0.25, 0.5) * (1 - out));
    lighter(ctx);
    // the white of the blow
    const kf = span(u, 0, 0.14);
    if (kf < 1) { ctx.fillStyle = radial(ctx, x, y, 0, r * 2.2, [[0, rgba(TONE.white, 0.95 * (1 - kf) * (1 - kf))], [0.5, rgba(TONE.brassHi, 0.5 * (1 - kf))], [1, rgba(TONE.brassHi, 0)]]); ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, TAU); ctx.fill(); }
    // the brass ring: wide and soft under, thin and bright over
    const kr = span(u, 0, 0.55);
    if (kr < 1) {
      const rr = lerp(r * 1.0, r * 2.5, outExpo(kr)), o = (1 - kr) ** 1.6;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU);
      ctx.strokeStyle = rgba(TONE.brass, 0.4 * o); ctx.lineWidth = lerp(11, 3, kr) * px; ctx.stroke();
      ctx.strokeStyle = rgba(TONE.brassHi, o); ctx.lineWidth = lerp(4, 1.2, kr) * px; ctx.stroke();
    }
  } };
}

// ------------------------------------------------------------------ route / sealed: the ribbon of an own march
/** `{points: [{x, y}] (world), color, dur (default 90: until it is replaced), drawn}`: the ribbon draws on from the origin; while the order waits a glint runs along it. `drawn`: it is there already and only the glint crosses it once. */
function route(a, env) {
  const path = smoothPath(a.points);
  if (path.pts.length < 2) return null;
  const color = a.color ?? TONE.you, dur = a.dur ?? 90;
  const full = env.mode === 'full';
  return { layer: 'top', dur, draw(ctx, s) {
    if (isFar(s)) return;
    const t = s.t, o = span(t, 0, full ? 0.08 : REDUCED_FADE) * (1 - span(t, dur - 0.3, dur));
    const k = full && !a.drawn ? outCubic(span(t, 0, 0.6)) : 1;
    const glint = !full ? -1 : a.drawn ? outCubic(span(t, 0, 0.5)) * 1.12 : t < 0.6 ? k : ((t - 0.6) % 1.8) / 1.1;
    ribbon(ctx, path, { k, px: s.px, color, level: o, glint });
    // the far end: a ring where the order will be sealed
    if (k > 0.98 && !a.drawn) { const e = path.pts[path.pts.length - 1]; groundRing(ctx, e.x, e.y + R * 0.1, R * 0.44); ctx.strokeStyle = rgba(TONE.you, 0.9 * o); ctx.lineWidth = 2.4 * s.px; ctx.stroke(); }
  } };
}

/**
 * `{points, color, caption, dur}`: the ribbon at rest on the ground (props
 * stand on it) with its seal at the far end. A still effect: it is drawn
 * with every map paint and wakes nothing; the caller cancels it at the turn.
 */
function sealed(a, env) {
  const path = smoothPath(a.points);
  if (path.pts.length < 2) return null;
  const color = a.color ?? TONE.you, dur = a.dur ?? 660, caption = a.caption ? String(a.caption) : '';
  const born = env.now;
  return { layer: 'ground', dur, still: true, draw(ctx, s) {
    const o = span(s.now - born, 0, 0.3), late = span(s.now - born, a.captionAfter ?? 0, (a.captionAfter ?? 0) + 0.4);
    ribbon(ctx, path, { k: 1, px: s.px, color, level: o, sealed: true });
    const e = path.pts[path.pts.length - 1];
    waxSeal(ctx, e.x, e.y, 15 * s.px, { alpha: o * late });
    if (caption && late > 0.01) {
      ctx.save();
      ctx.translate(e.x, e.y + 25 * s.px); ctx.scale(s.px, s.px);
      ctx.globalAlpha = 0.95 * o * late; ctx.font = '700 12px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.strokeStyle = rgba('#0c1614', 0.9); ctx.lineWidth = 3.5; ctx.strokeText?.(caption, 0, 0);
      ctx.fillStyle = TONE.ivory; ctx.fillText?.(caption, 0, 0);
      ctx.restore();
    }
  } };
}

const figure = (ctx, x, y, s, kind, o) => { if (!paintMini(ctx, x, y, s, kind, o)) { baseDisc(ctx, x, y, s, o.faction, { alpha: o.alpha }); unitFigure(ctx, x, y - s * 0.02, s, kind, o); } };

/** `{points, kind, faction, reach (tiles, default 0.8), n (default 3)}`: a short column steps off along the path and is gone into the march. */
function walker(a, env) {
  if (env.mode !== 'full') return null;
  const path = smoothPath(a.points);
  if (path.pts.length < 2) return null;
  const n = Math.max(1, Math.min(4, a.n ?? 3)), reach = Math.min(1, ((a.reach ?? 0.8) * R * 1.6) / Math.max(1, path.total)), dur = 1.7;
  const o0 = path.pts[0];
  env.fx.emit('dust', { x: o0.x, y: o0.y + R * 0.1, n: 14, seed: `${env.seed}|off`, t: env.now + 0.05, radius: R * 0.25, power: 0.8, up: 0.6 });
  env.fx.emit('dust', { x: o0.x, y: o0.y + R * 0.1, n: 8, seed: `${env.seed}|trail`, t: env.now + 0.3, radius: R * 0.2, power: 0.4, up: 0.5, stagger: 0.8 });
  return { layer: 'top', dur, draw(ctx, s) {
    if (isFar(s)) return;
    const t = s.t, size = battleScale(s.zoom) * 0.82;
    const list = [];
    for (let i = 0; i < n; i++) {
      const k = outQuad(span(t, i * 0.14, 1.3 + i * 0.14)) * reach - 0;
      const p = pathAt(path, Math.max(0, k));
      if (!p) continue;
      list.push({ ...p, a: span(t, i * 0.14, i * 0.14 + 0.15) * (1 - span(t, dur - 0.45, dur)), i });
    }
    list.sort((u, v) => u.y - v.y);
    for (const p of list) figure(ctx, p.x, p.y + R * 0.1, size, a.kind ?? 'spearman', { faction: a.faction ?? 0, face: p.dx < 0 ? -1 : 1, step: (t * 1.9 + p.i * 0.3) % 1, walking: true, alpha: p.a });
  } };
}

// ------------------------------------------------------------------ the turn's own results
/** `{…position, color, size (px, default 44)}`: a seal appears on the tile and breaks open in a flash. */
function unseal(a, env) {
  const p = pointOf(a);
  const color = a.color ?? TONE.you, size = a.size ?? 44, x = p.x, y = p.y - R * 0.55, dur = 1.5;
  if (env.mode !== 'full') {
    return { layer: 'top', dur: 1.2, draw(ctx, s) { if (isFar(s)) return; waxSeal(ctx, x, y, (size / 2) * s.px, { alpha: envelope(s.t, 1.2, REDUCED_FADE, REDUCED_FADE), split: 0.7 }); } };
  }
  const BREAK = 0.3;
  env.fx.emit('mist', { x: p.x, y: p.y, n: 9, seed: `${env.seed}|mist`, t: env.now, radius: R * 0.4, power: 1.3, life: 0.6 });
  env.fx.emit('shard', { x, y: p.y, z: R * 0.55, n: 8, seed: `${env.seed}|wax`, t: env.now + BREAK, power: 0.7, up: 0.6, size: 0.7, colors: ['#9a2617', '#d2533c', '#5a130b'] });
  env.fx.emit('spark', { x, y: p.y, z: R * 0.55, n: 14, seed: `${env.seed}|sp`, t: env.now + BREAK, power: 0.8, colors: ['#fff6dc', TONE.brassHi, color] });
  return { layer: 'top', dur, draw(ctx, s) {
    if (isFar(s)) { farPip(ctx, s, p.x, p.y, color, s.t); return; }
    const t = s.t, px = s.px, r = (size / 2) * px;
    const pop = lerp(0.3, 1, outBack(span(t, 0, 0.16), 2.4));
    if (t < BREAK) { waxSeal(ctx, x, y, r * pop, { alpha: span(t, 0, 0.05), sx: 1 + 0.06 * Math.sin(t * 60) * span(t, 0.16, BREAK), sy: 1 }); return; }
    const u = t - BREAK, k = outCubic(span(u, 0, 0.6));
    waxSeal(ctx, x, y, r, { split: k, alpha: 1 - inQuad(span(u, 0.25, 0.8)) });
    lighter(ctx);
    const kf = span(u, 0, 0.3);
    if (kf < 1) {
      ctx.fillStyle = radial(ctx, x, y, 0, r * 3, [[0, rgba(TONE.white, (1 - kf) * (1 - kf))], [0.4, rgba(TONE.brassHi, 0.6 * (1 - kf))], [1, rgba(color, 0)]]); ctx.beginPath(); ctx.arc(x, y, r * 3, 0, TAU); ctx.fill();
      const len = r * 3.2 * outBack(Math.min(1, kf * 2.2), 2) * (1 - inQuad(kf));
      ctx.lineCap = 'round'; ctx.strokeStyle = rgba('#fff3d0', 0.9 * (1 - kf)); ctx.lineWidth = 2.2 * px;
      for (const ang of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) { const m = ang % (Math.PI / 2) === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(x - Math.cos(ang) * len * m, y - Math.sin(ang) * len * m); ctx.lineTo(x + Math.cos(ang) * len * m, y + Math.sin(ang) * len * m); ctx.stroke(); }
    }
  } };
}

/** `{…position, color (default ember)}`: crossed swords strike over the tile and a ring leaves them. */
function swords(a, env) {
  const p = pointOf(a);
  const color = a.color ?? TONE.ember, x = p.x, y = p.y - R * 0.6, dur = 1.5;
  const full = env.mode === 'full';
  if (full) env.fx.emit('spark', { x, y: p.y, z: R * 0.6, n: 12, seed: `${env.seed}|sp`, t: env.now + 0.14, power: 0.7, colors: ['#fff6dc', '#ffd27a', color] });
  return { layer: 'top', dur, draw(ctx, s) {
    const t = s.t, px = s.px;
    const far = isFar(s), cy = far ? p.y : y;
    const o = full ? span(t, 0, 0.05) * (1 - inQuad(span(t, dur - 0.35, dur))) : envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
    const pop = full ? lerp(1.9, 1, outBack(span(t, 0, 0.16), 1.6)) : 1;
    const r = (far ? 12 : 19) * px;
    ctx.globalAlpha = o;
    ctx.fillStyle = rgba('#0c1614', 0.9); ctx.beginPath(); ctx.arc(x, cy, r * pop, 0, TAU); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2.6 * px; ctx.stroke();
    crossedSwords(ctx, x, cy, r * 0.62 * pop);
    if (!full) return;
    lighter(ctx);
    for (let i = 0; i < 2; i++) {
      const u = (t - 0.14 - i * 0.16) / 0.6;
      if (u < 0 || u >= 1) continue;
      ctx.strokeStyle = rgba(color, (1 - u) ** 1.5 * (i ? 0.6 : 1)); ctx.lineWidth = lerp(4.5, 1, u) * px;
      ctx.beginPath(); ctx.arc(x, cy, lerp(r, r * 2.8, outExpo(u)), 0, TAU); ctx.stroke();
    }
    const kf = span(t, 0.14, 0.3);
    if (t >= 0.14 && kf < 1) { ctx.fillStyle = radial(ctx, x, cy, 0, r * 2, [[0, rgba(TONE.white, 0.9 * (1 - kf))], [1, rgba(color, 0)]]); ctx.beginPath(); ctx.arc(x, cy, r * 2, 0, TAU); ctx.fill(); }
  } };
}

/** `{…position, color (default ember)}`: three rings close on the tile, one after another, and its rim burns. */
function alarm(a, env) {
  const p = pointOf(a);
  const color = a.color ?? TONE.ember, dur = 1.6;
  const full = env.mode === 'full';
  const groundPart = { layer: 'ground', dur, draw(ctx, s) {
    const t = s.t;
    if (!full) { const o = envelope(t, dur, REDUCED_FADE, REDUCED_FADE); hexPath(ctx, p.x, p.y, 1); ctx.fillStyle = rgba(color, 0.3 * o); ctx.fill(); ctx.strokeStyle = rgba(color, 0.95 * o); ctx.lineWidth = 3 * s.px; ctx.stroke(); return; }
    for (let i = 0; i < 3; i++) {
      const u = (t - i * 0.3) / 0.7;
      if (u < 0 || u >= 1) continue;
      groundRing(ctx, p.x, p.y, lerp(R * 2.6, R * 0.8, outCubic(u)));
      ctx.strokeStyle = rgba(color, 0.3 * Math.sin(u * Math.PI)); ctx.lineWidth = lerp(8, 13, u) * s.px; ctx.stroke();
      ctx.strokeStyle = rgba(color, Math.min(1, 1.4 * Math.sin(u * Math.PI))); ctx.lineWidth = lerp(2.5, 5.5, u) * s.px; ctx.stroke();
    }
    const beat = Math.max(0, Math.sin(t * 9.5)) * (1 - span(t, 1.0, dur));
    hexPath(ctx, p.x, p.y, 1); ctx.fillStyle = rgba(color, 0.2 + 0.3 * beat); ctx.globalAlpha = 1 - span(t, dur - 0.3, dur); ctx.fill();
    ctx.strokeStyle = rgba(color, 0.5 + 0.5 * beat); ctx.lineWidth = 3 * s.px; ctx.globalAlpha = 1 - span(t, dur - 0.3, dur); ctx.stroke();
  } };
  const topPart = { layer: 'top', dur, draw(ctx, s) { if (isFar(s)) farPip(ctx, s, p.x, p.y, color, s.t); } };
  return [groundPart, topPart];
}

// ------------------------------------------------------------------ moments
/** `{…position, color}`: a shaft of light where a building has just been finished: up fast, gone slowly. */
function pillar(a, env) {
  if (env.mode !== 'full') return null;
  const { x, y } = pointOf(a);
  const color = a.color ?? TONE.brassHi, dur = 0.95;
  return { layer: 'top', dur, draw(ctx, s) {
    if (isFar(s)) return;
    const t = s.t, up = outBack(span(t, 0, 0.2), 1.8), o = 1 - inQuad(span(t, 0.2, dur));
    const h = R * 2.3 * up, w0 = R * lerp(0.34, 0.14, span(t, 0.1, dur));
    lighter(ctx);
    // a narrow beam, soft at its edges: three nested columns, the innermost white
    for (const [wk, a0, c] of [[1, 0.28, color], [0.6, 0.4, color], [0.26, 0.7, TONE.white]]) {
      const w = w0 * wk;
      const g = ctx.createLinearGradient?.(0, y, 0, y - h);
      if (g?.addColorStop) { g.addColorStop(0, rgba(c, a0 * o)); g.addColorStop(0.5, rgba(c, a0 * 0.6 * o)); g.addColorStop(1, rgba(c, 0)); ctx.fillStyle = g; } else ctx.fillStyle = rgba(c, a0 * 0.4 * o);
      ctx.beginPath(); ctx.moveTo(x - w, y); ctx.lineTo(x - w * 0.7, y - h); ctx.lineTo(x + w * 0.7, y - h); ctx.lineTo(x + w, y); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = radial(ctx, x, y, 0, R * 1.0, [[0, rgba(TONE.white, 0.75 * o)], [0.4, rgba(color, 0.4 * o)], [1, rgba(color, 0)]]); groundRing(ctx, x, y, R * 1.0); ctx.fill();
  } };
}

/** `{…position, kind, faction, n (default 5)}`: the host runs out from the village and forms a line in front of it. */
function forming(a, env) {
  const { x, y } = pointOf(a);
  const n = Math.max(2, Math.min(7, a.n ?? 5)), dur = 1.7;
  const full = env.mode === 'full';
  if (full) env.fx.emit('dust', { x, y: y + R * 0.32, n: 16, seed: `${env.seed}|form`, t: env.now + 0.42, radius: R * 0.5, power: 0.6, up: 0.5 });
  return { layer: 'top', dur, draw(ctx, s) {
    if (isFar(s)) return;
    const t = s.t, size = battleScale(s.zoom) * 0.8;
    const out = full ? 1 - span(t, dur - 0.4, dur) : envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
    for (let i = 0; i < n; i++) {
      const k = full ? outBack(span(t, i * 0.05, 0.42 + i * 0.05), 1.3) : 1;
      const tx = x + (i - (n - 1) / 2) * size * 0.46, ty = y + R * 0.36 + (i % 2) * size * 0.06;
      const px = lerp(x, tx, k), py = lerp(y + R * 0.05, ty, k);
      const land = full ? Math.sin(span(t, 0.42 + i * 0.05, 0.62 + i * 0.05) * Math.PI) * size * 0.08 : 0;
      figure(ctx, px, py - land, size, a.kind ?? 'spearman', { faction: a.faction ?? 0, face: 1, step: (t * 2 + i * 0.3) % 1, walking: full && k < 0.98, alpha: (full ? span(t, i * 0.05, i * 0.05 + 0.12) : 1) * out });
    }
  } };
}

/** `{…position, fill, dark}`: a standard goes up on the tile. */
function raise(a, env) {
  const { x, y } = pointOf(a);
  const dur = 1.9, full = env.mode === 'full';
  if (full) env.fx.emit('dust', { x, y: y + R * 0.1, n: 12, seed: `${env.seed}|raise`, t: env.now + 0.12, radius: R * 0.2, power: 0.7, up: 0.6 });
  return { layer: 'top', dur, draw(ctx, s) {
    if (isFar(s)) return;
    const t = s.t;
    ctx.globalAlpha = full ? 1 - inQuad(span(t, dur - 0.4, dur)) : envelope(t, dur, REDUCED_FADE, REDUCED_FADE);
    standard(ctx, x + R * 0.3, y + R * 0.05, R * 1.7, { fill: a.fill ?? TONE.you, dark: a.dark ?? TONE.brassLo, up: full ? outBack(span(t, 0.06, 0.46), 1.7) : 1, t, px: s.px });
  } };
}

/** `{…position, color}`: the far view's form of a moment (nothing close up). */
function pip(a, env) {
  if (env.mode === 'off') return null;
  const { x, y } = pointOf(a);
  const color = a.color ?? TONE.brassHi;
  return { layer: 'top', dur: 1.4, draw(ctx, s) { farPip(ctx, s, x, y, color, s.t); } };
}

// ------------------------------------------------------------------ fly: from the map to the HUD
const SVG = 'http://www.w3.org/2000/svg';
/** Three small drawn icons (24 px grid, round strokes): grain, wood, stone. */
const FLY_ICONS = Object.freeze({
  grain: 'M12 21V8M12 9c-3-.6-4.4-2.6-4.4-5 2.8.2 4.4 2 4.4 5zM12 9c3-.6 4.4-2.6 4.4-5-2.8.2-4.4 2-4.4 5zM12 14.5c-3-.6-4.4-2.6-4.4-5 2.8.2 4.4 2 4.4 5zM12 14.5c3-.6 4.4-2.6 4.4-5-2.8.2-4.4 2-4.4 5z',
  wood: 'M5 14.5a3 3 0 0 1 3-3h9.5a3 3 0 0 1 0 6H8a3 3 0 0 1-3-3zM17.5 11.5a3 3 0 0 0 0 6M9 14.5h5',
  stone: 'M4.5 17.5l2.2-7 5.3-3.5 6 3 1.5 7.5zM12 7l1.2 5.2 6.3 5.3M6.7 10.5l6.5 1.7',
});
export const FLY_KINDS = Object.freeze(Object.keys(FLY_ICONS));

/**
 * `{…position (where they leave from), to: Element | selector, n (default 5), kinds: ['grain', …], onArrive}`:
 * small brass tokens leave the tile one after another, arc up and fall into
 * the HUD element, which is where the count lives. Returns nothing when the
 * target is not on the page.
 */
function fly(a, env) {
  if (env.mode !== 'full') return null;
  const doc = globalThis.document;
  const target = typeof a.to === 'string' ? doc?.querySelector?.(a.to) : a.to;
  const rect = target?.getBoundingClientRect?.();
  if (!rect || !(rect.width || rect.height) || target.hidden) return null;
  const n = Math.max(1, Math.min(8, a.n ?? 5)), kinds = a.kinds?.length ? a.kinds : FLY_KINDS;
  const FLIGHT = 0.72, GAP = 0.085, dur = FLIGHT + GAP * (n - 1) + 0.25;
  const w = pointOf(a);
  return { layer: 'hud', dur, dom: {
    make(d) {
      const el = node(d, 'span', 'fx-fly');
      for (let i = 0; i < n; i++) {
        const tok = node(d, 'span', 'fx-fly-token');
        const svg = d.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const path = d.createElementNS(SVG, 'path');
        path.setAttribute('d', FLY_ICONS[kinds[i % kinds.length]] ?? FLY_ICONS.grain);
        svg.append(path); tok.append(svg); el.append(tok);
      }
      return el;
    },
    update(el, s) {
      const from = s.toViewport(w.x, w.y - R * 0.5);
      const r = target.getBoundingClientRect();
      const to = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      [...el.children].forEach((tok, i) => {
        const u = (s.t - i * GAP) / FLIGHT;
        if (u <= 0 || u >= 1.25) { tok.style.setProperty('--fx-o', '0'); return; }
        const k = clamp01(u), e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
        // out sideways and up first, then pulled in: every token takes its own bow
        const side = ((i % 2) * 2 - 1) * (30 + 14 * (i % 3)), bow = Math.sin(k * Math.PI);
        const x = lerp(from.x, to.x, e) + side * bow * (1 - k), y = lerp(from.y, to.y, e) - 70 * bow * (1 - k * 0.5);
        const sc = u < 1 ? lerp(0.5, 1, outBack(span(k, 0, 0.2), 2)) * lerp(1, 0.72, inQuad(span(k, 0.7, 1))) : lerp(0.72, 1.5, (u - 1) / 0.25);
        setVars(tok, { '--fx-x': `${x.toFixed(1)}px`, '--fx-y': `${y.toFixed(1)}px`, '--fx-s': sc.toFixed(3), '--fx-o': (u < 1 ? span(k, 0, 0.08) : 1 - (u - 1) / 0.25).toFixed(3), '--fx-r': `${(k * 200 * (i % 2 ? 1 : -1)).toFixed(0)}deg` });
      });
    },
  }, onEnd: typeof a.onArrive === 'function' ? a.onArrive : null };
}
/** When the first token of a `fly` lands (seconds after it starts): the moment to count up. */
export const FLY_LANDS = 0.72;

/** The parts by name. */
export const PIECES = Object.freeze({ mark, pending, pulse, stamp, route, sealed, walker, unseal, swords, alarm, pillar, forming, raise, pip, fly, burn });

/** Register the parts on an engine. */
export function installPieces(fx) {
  for (const [name, make] of Object.entries(PIECES)) fx.define(name, make);
  return fx;
}
