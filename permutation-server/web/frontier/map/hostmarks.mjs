// What the board shows of a host away from home (UX design 14.2 to 14.4), over
// the records of map/board.mjs:
//
//   watched land     the sight of each standing host of the viewer: a dashed
//                    rim in the nation's colour and a very light wash. It is
//                    named 見張っている土地. It moves with the host and leaves
//                    with it. Never a fill like the village's land and never a
//                    gold line: gold and the solid band are the village's.
//   the held tile    a small pennon in the nation's colour beside the host
//                    (people/units.mjs paints it with the token); no fill on
//                    the ground, so it is not read as land
//   stamina          a ring on the host's pill: how much of 120 it has, a mark
//                    where a march's 74 stands, a brass pip when it can be
//                    given an order this turn
//   a ghost          a host that forms up next turn: 「次のターンで整列」
//   surveyors' flags on tiles whose exploration has not been answered yet
//   the sealed march the viewer's own ribbon, with a marker that advances by
//                    the clock (the character's hexagon face when the host is
//                    the one it leads), tagged as visible only to the viewer
//
// Painters are context-tolerant; the words go through L.
import { FLATTEN, RADIUS, hexPoints, project } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { landShape } from './ownland.mjs';
import { outerLoops } from './actions.mjs';
import { YOU, fxNow } from './chart.mjs';
import { ribbon as clothRibbon, smoothPath, pathAt, waxSeal } from '../fx/draw.mjs';
import { upright } from './tilt.mjs';

const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const lineScale = zoom => (0.72 + 0.28 * Math.min(1.8, Math.max(0.3, zoom))) / zoom;
const clamp01 = x => Math.max(0, Math.min(1, x));

// ------------------------------------------------------------------ words
/** The names of the four things a new player must read apart (UX design 14.1; the legend and the tips say the same). */
export const LAND_WORDS = Object.freeze({
  village: () => L`村のまわり`,
  held: () => L`軍勢が押さえているマス`,
  watch: () => L`見張っている土地`,
  surveyed: () => L`測量した土地`,
});
export const formingText = () => L`次のターンで整列`;
// (the result is told when the exploration's turn has been settled, two turns or so after the order: the flag names no turn it cannot keep)
export const exploreFlagText = () => L`探索中 · 結果を待っています`;
export const marchTagText = bell => (Number.isInteger(bell) ? L`ターン ${fmtNum(bell)} に到着 · あなたにだけ見えます` : L`封印済み · あなたにだけ見えます`);
export const awayText = bell => (Number.isInteger(bell) ? L`軍勢は進軍中 · ターン ${fmtNum(bell)} に到着` : L`軍勢は進軍中`);
export const awaitKeyText = () => L`到着 · 開封を待っています（あなたにだけ見えます）`;
export const gainText = n => L`+${fmtNum(n)} マス測量`;
export const watchTipText = () => L`見張っている土地：軍勢が立っているあいだ見えている範囲です。軍勢が去れば消えます。`;

// ------------------------------------------------------------------ watched land
/** The watch's look: a dashed rim (screen px) with a dark line under it, and a wash far lighter than the village's band (map/ownland.mjs OWN_FILL.rim 0.38). */
export const WATCH_LOOK = Object.freeze({ wash: 0.07, rim: 2.2, under: 4.2, dash: Object.freeze([9, 6]), glow: 0.12 });
const shapes = new Map();
/** The shape of a watch `{q, r, radius, tiles}` (made once): `{fill, edge}` Path2D, or null without Path2D. */
function watchShape(w) {
  if (typeof Path2D === 'undefined' || !w?.tiles?.length) return null;
  const key = `${w.q},${w.r},${w.radius},${w.tiles.length}`;
  const hit = shapes.get(key);
  if (hit) return hit;
  const shape = landShape(w.tiles);
  const fill = new Path2D(), edge = new Path2D();
  for (const t of w.tiles) { const c = project(t.q, t.r); hexPoints(c.x, c.y, 0).forEach(([x, y], i) => (i ? fill.lineTo(x, y) : fill.moveTo(x, y))); fill.closePath(); }
  for (const loop of outerLoops(shape.loops)) { loop.forEach(([x, y], i) => (i ? edge.lineTo(x, y) : edge.moveTo(x, y))); edge.closePath(); }
  const v = { fill, edge, key };
  if (shapes.size > 32) shapes.clear();
  shapes.set(key, v);
  return v;
}
/**
 * The land a host watches, on the ground (after the land, before what stands on it): the light wash and the
 * dashed rim. `age` (ms since the watch came to stand here, or null): it draws on from the host outward.
 */
export function paintWatch(g, w, { zoom = 1, faction = 0, age = null, still = false, covered = null, quiet = null } = {}) {
  const S = g?.save ? watchShape(w) : null;
  if (!S) return;
  // (`quiet` {colour, alpha, width}: while the banner prototype is on, land in the nation's colour is land that is
  // held; a watch is only a thin cream rim then, with no wash — washed in the nation's colour it read as owned land)
  if (quiet) {
    const k = lineScale(zoom), show = still || age === null ? 1 : clamp01(age / 500);
    if (show <= 0) return;
    g.save();
    g.lineJoin = 'round'; g.lineCap = 'butt';
    g.globalAlpha = 0.35 * show; g.strokeStyle = 'rgba(12,20,18,1)'; g.lineWidth = (quiet.width + 1.6) * k; g.stroke(S.edge);
    g.setLineDash?.([WATCH_LOOK.dash[0] * k, WATCH_LOOK.dash[1] * k]);
    g.globalAlpha = quiet.alpha * show; g.strokeStyle = quiet.colour; g.lineWidth = quiet.width * k; g.stroke(S.edge);
    g.setLineDash?.([]);
    g.restore();
    return;
  }
  // (`covered`: the tiles another watch of this frame has washed already ("q,r"). The wash and the soft light are laid
  // once on a tile however many hosts watch it: three hosts by a village stacked their washes into what read as
  // filled land, four or five times the village's own. The dashed rims stay whole: they are lines, not a colour)
  const free = covered ? w.tiles.filter(t => !covered.has(`${t.q},${t.r}`)) : w.tiles;
  let wash = S.fill;
  if (free.length !== w.tiles.length) {
    wash = new Path2D();
    for (const t of free) { const c = project(t.q, t.r); hexPoints(c.x, c.y, 0).forEach(([x, y], i) => (i ? wash.lineTo(x, y) : wash.moveTo(x, y))); wash.closePath(); }
  }
  const k = lineScale(zoom), col = FACTION_COLORS[faction] ?? YOU, K = WATCH_LOOK;
  const show = still || age === null ? 1 : clamp01(age / 500);
  if (show <= 0) return;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'butt';
  if (show < 1 && g.ellipse) {
    const c = project(w.q, w.r), rx = (w.radius + 0.9) * Math.sqrt(3) * RADIUS * (0.25 + 0.75 * show);
    g.beginPath(); g.ellipse(c.x, c.y, rx, rx * FLATTEN, 0, 0, Math.PI * 2); g.clip?.();
  }
  if (free.length) {
    g.globalAlpha = K.wash * show; g.fillStyle = col; g.fill(wash);
    // a soft light just inside the rim, so the dashes are found on land of any colour
    g.save(); g.clip?.(wash); g.globalAlpha = K.glow * show; g.strokeStyle = col; g.lineWidth = 16 * k; g.stroke(S.edge); g.restore();
  }
  g.globalAlpha = 0.5 * show; g.strokeStyle = 'rgba(12,20,18,1)'; g.lineWidth = K.under * k; g.stroke(S.edge);
  g.setLineDash?.([K.dash[0] * k, K.dash[1] * k]);
  g.globalAlpha = 0.95 * show; g.strokeStyle = col; g.lineWidth = K.rim * k; g.stroke(S.edge);
  g.setLineDash?.([]);
  g.restore();
}
/** And once more over what stands there, thin: a wood never hides where the watch ends. */
export function paintWatchTop(g, w, { zoom = 1, faction = 0, quiet = null } = {}) {
  const S = g?.save ? watchShape(w) : null;
  if (!S || quiet) return;
  const k = lineScale(zoom), K = WATCH_LOOK;
  g.save();
  g.lineJoin = 'round';
  g.setLineDash?.([K.dash[0] * k, K.dash[1] * k]);
  g.globalAlpha = 0.5; g.strokeStyle = FACTION_COLORS[faction] ?? YOU; g.lineWidth = 1.1 * k; g.stroke(S.edge);
  g.setLineDash?.([]);
  g.restore();
}
/** Where the watch's name stands: under the foot of its rim (world px): the chip that counts a survey rises over its top. */
export function watchTop(w) {
  let low = null;
  for (const t of w?.tiles ?? []) { const c = project(t.q, t.r); if (!low || c.y > low.y) low = { x: c.x, y: c.y }; }
  return low ? { x: low.x, y: low.y + RADIUS * FLATTEN } : null;
}

// ------------------------------------------------------------------ stamina ring and pip
const BRASS = '#c9a24a', BRASS_HI = '#f0d48a', METAL = 'rgba(13,24,22,.94)';
/**
 * A host's stamina as a ring (screen sized: `k` = 1 / zoom), centre (x, y): the ring fills with the share of the
 * cap, a brass mark stands where a march's cost is, the notches say that it returns a point a turn (one notch for
 * ten). Green when a march can be paid, amber while it cannot. `ring` = map/board.mjs staminaRing.
 */
export function paintStaminaRing(g, x, y, k, ring, { r = 10 } = {}) {
  if (!g?.save || !ring) return;
  const R = r * k, a0 = -Math.PI / 2, TAU = Math.PI * 2;
  g.save();
  g.lineCap = 'butt';
  g.fillStyle = 'rgba(4,10,9,.35)'; g.beginPath(); g.arc(x, y + 1.2 * k, R + 2.6 * k, 0, TAU); g.fill();
  g.fillStyle = METAL; g.beginPath(); g.arc(x, y, R + 2.2 * k, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,250,240,.16)'; g.lineWidth = 2.8 * k; g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
  g.strokeStyle = ring.ready ? '#7fd08a' : '#e0a83d'; g.beginPath(); g.arc(x, y, R, a0, a0 + TAU * Math.max(0.015, ring.share)); g.stroke();
  // the notches: one for every ten points
  g.strokeStyle = 'rgba(13,24,22,.9)'; g.lineWidth = 0.9 * k;
  for (let i = 0; i < ring.notches; i++) { const a = a0 + (TAU * i) / ring.notches; g.beginPath(); g.moveTo(x + Math.cos(a) * (R - 1.8 * k), y + Math.sin(a) * (R - 1.8 * k)); g.lineTo(x + Math.cos(a) * (R + 1.8 * k), y + Math.sin(a) * (R + 1.8 * k)); g.stroke(); }
  // where a march's cost stands: a brass mark across the ring, reaching outside it
  const an = a0 + TAU * ring.need;
  g.strokeStyle = BRASS_HI; g.lineWidth = 2 * k; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x + Math.cos(an) * (R - 3 * k), y + Math.sin(an) * (R - 3 * k)); g.lineTo(x + Math.cos(an) * (R + 3.4 * k), y + Math.sin(an) * (R + 3.4 * k)); g.stroke();
  // inside: the turns still to wait, or a tick
  g.fillStyle = ring.ready ? '#c9f0cf' : '#ffe7ae'; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (ring.ready) { g.strokeStyle = '#c9f0cf'; g.lineWidth = 1.7 * k; g.lineJoin = 'round'; g.beginPath(); g.moveTo(x - 2.8 * k, y + 0.2 * k); g.lineTo(x - 0.6 * k, y + 2.3 * k); g.lineTo(x + 3 * k, y - 2.2 * k); g.stroke(); }
  else { g.font = `700 ${(ring.wait > 9 ? 9.4 : 10.5) * k}px system-ui, -apple-system, sans-serif`; g.fillText?.(String(ring.wait), x, y + 0.4 * k); }
  g.restore();
}
/** The small brass pip of a host that can be given an order this turn (screen sized), centre (x, y). */
export function paintActPip(g, x, y, k, { r = 3.4 } = {}) {
  if (!g?.save) return;
  g.save();
  g.fillStyle = 'rgba(4,10,9,.5)'; g.beginPath(); g.arc(x, y + 0.8 * k, (r + 1.6) * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = BRASS; g.beginPath(); g.arc(x, y, (r + 1) * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = BRASS_HI; g.beginPath(); g.arc(x - 0.6 * k, y - 0.7 * k, r * 0.62 * k, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** The ring of a host that is selected, on the ground at its figure's feet (`s` the token's height): gold for the viewer's own, ivory for another's; it breathes. */
export function paintHostRing(g, x, y, s, { zoom = 1, own = true, now = fxNow(), still = false } = {}) {
  if (!g?.save || !g.ellipse) return;
  const k = lineScale(zoom), col = own ? YOU : '#f4efe0', breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 1000 * 3.2);
  const rx = s * (0.5 + 0.03 * breath), ry = rx * 0.5;
  g.save();
  g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.globalAlpha = 0.2 + 0.16 * breath; g.strokeStyle = col; g.lineWidth = 9 * k; g.stroke();
  g.globalAlpha = 0.85; g.strokeStyle = 'rgba(14,22,20,1)'; g.lineWidth = 5.2 * k; g.stroke();
  g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 2.6 * k; g.stroke();
  g.restore();
}

// ------------------------------------------------------------------ surveyors' flags
/** A surveyor's flag on a tile whose exploration is not answered yet: a ranging pole banded in ink and ivory, a small sky-blue flag (world px; `u` its height). */
export function paintSurveyFlag(g, x, y, u, { now = fxNow(), still = false } = {}) {
  if (!g?.save) return;
  const wave = still ? 0 : Math.sin(now / 1000 * 3.1 + x * 0.01) * u * 0.035;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.fillStyle = 'rgba(8,14,12,.3)'; g.beginPath(); g.ellipse?.(x + u * 0.05, y + u * 0.02, u * 0.2, u * 0.07, 0, 0, Math.PI * 2); g.fill();
  // the pole, banded
  const bands = 5, top = y - u;
  for (let i = 0; i < bands; i++) {
    g.strokeStyle = i % 2 ? '#f4efe0' : '#b5432f'; g.lineWidth = u * 0.075;
    g.beginPath(); g.moveTo(x, y - (u * i) / bands); g.lineTo(x, y - (u * (i + 1)) / bands); g.stroke();
  }
  g.strokeStyle = 'rgba(14,22,20,.75)'; g.lineWidth = u * 0.02; g.beginPath(); g.moveTo(x - u * 0.045, y); g.lineTo(x - u * 0.045, top); g.moveTo(x + u * 0.045, y); g.lineTo(x + u * 0.045, top); g.stroke();
  // the flag: sky blue (the colour of an exploration: map/actions.mjs ACTION_COLOURS.explore), an eye's dot on it
  g.fillStyle = '#7fc4e8'; g.strokeStyle = 'rgba(14,22,20,.85)'; g.lineWidth = u * 0.03;
  g.beginPath(); g.moveTo(x, top); g.lineTo(x + u * 0.52, top + u * 0.14 + wave); g.lineTo(x, top + u * 0.34); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#10201c'; g.beginPath(); g.arc(x + u * 0.17, top + u * 0.165 + wave * 0.4, u * 0.045, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ the viewer's own sealed march
/** The marker's size on screen (px across). */
export const MARKER_PX = 34;
/**
 * The viewer's own sealed march: its ribbon at rest (the same cloth as the order's route: map/actions.mjs
 * paintRibbon, sealed), a wax seal on its far end, and where the column is by the clock. `hexes` `[{q, r}]` from
 * the origin; `share` 0..1 (map/board.mjs marchShare). Returns the marker's place `{x, y}` (world px), or null.
 * Only this browser draws it: the destination of a sealed march is no one else's to see.
 */
export function paintSealedMarch(g, hexes, { zoom = 1, faction = null, share = 0 } = {}) {
  if (!g?.save || !(hexes?.length > 1)) return null;
  const pts = hexes.map(h => project(h.q, h.r));
  const px = lineScale(zoom), colour = FACTION_COLORS[faction] ?? YOU;
  const path = smoothPath(pts);
  if (!(path.pts?.length > 1)) return null;
  g.save();
  clothRibbon(g, path, { px, color: colour, level: 1, sealed: true });
  const e = pts[pts.length - 1];
  waxSeal(g, e.x, e.y, 13 * px, { alpha: 1 });
  g.restore();
  // (never on the seal itself: the marker rests a little short of the end once it has arrived)
  const k = Math.min(0.94, Math.max(0.03, share)), at = pathAt(path, k);
  // (`path`, `k`: the road and how far along it the column is, for the figures that walk it: map/marcher.mjs)
  return at ? { x: at.x, y: at.y, path, k } : null;
}

/** A hexagon medallion (the marker of a march whose character is elsewhere): bell metal rimmed in gold with the nation's colour inside, `d` world units across, centred. */
export function paintMarkerDisc(g, x, y, d, { faction = null } = {}) {
  if (!g?.save) return;
  const r = d / 2, col = FACTION_COLORS[faction] ?? YOU;
  const hex = rr => { g.beginPath(); for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 3; const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; if (i) g.lineTo(px, py); else g.moveTo(px, py); } g.closePath(); };
  g.save();
  g.lineJoin = 'round';
  hex(r); g.fillStyle = 'rgba(13,24,22,.96)'; g.fill();
  hex(r * 0.74); g.fillStyle = col; g.fill();
  hex(r); g.strokeStyle = 'rgba(14,22,20,1)'; g.lineWidth = d * 0.16; g.stroke();
  g.strokeStyle = YOU; g.lineWidth = d * 0.09; g.stroke();
  // a marching mark: an arrow
  g.strokeStyle = '#fffaf0'; g.lineWidth = d * 0.08; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x - r * 0.34, y); g.lineTo(x + r * 0.34, y); g.moveTo(x + r * 0.08, y - r * 0.24); g.lineTo(x + r * 0.34, y); g.lineTo(x + r * 0.08, y + r * 0.24); g.stroke();
  g.restore();
}

// ------------------------------------------------------------------ a bell-metal tag on the map's own canvas
const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", Georgia, "Times New Roman", serif';
/**
 * A short line on a small tag of bell metal (the look of the effects' captions: fx/draw.mjs canvasTag), on the
 * map's upright canvas at world point (x, y): `place` 'above' or 'below' the point by `gap` screen px, an accent
 * down its left edge. `anchor` the place on the board it belongs to; `pass` the frame's label pass (it slides out
 * from under the HUD). Returns its box in world px.
 */
export function paintBellTag(g, x, y, text, { zoom = 1, place = 'above', gap = 8, accent = BRASS, alpha = 1, anchor = null, pass = null, size = 13, hud = false } = {}) {
  if (!g?.save || !text || alpha <= 0.01) return null;
  const k = 1 / zoom;
  g.save();
  g.font = `600 ${size * k}px ${SERIF}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const tw = (g.measureText?.(text)?.width ?? String(text).length * size * k) + 22 * k, th = (size + 10) * k;
  const ax = anchor?.x ?? x, ay = anchor?.y ?? y;
  const top0 = place === 'below' ? y + gap * k : y - gap * k - th;
  // (`hud`: a tag that is never left out and that the player reads — when a sealed march arrives —: with no place free of
  // everything it stands clear of the HUD first, over another label, and may go a little farther for it. It stood under the
  // notices beside the order card, 「Arrives on turn 51 · only y…」: the English recording of 2026-10-11)
  const move = pass?.place(ax, ay, { x: x - tw / 2, y: top0, w: tw, h: th }, hud ? { keep: true, hud: true, reach: 220 } : { keep: true }) ?? { dx: 0, dy: 0 };
  const cx = x + move.dx, top = top0 + move.dy;
  upright(g, ax, ay, () => {
    g.globalAlpha = alpha;
    g.beginPath(); g.roundRect?.(cx - tw / 2, top, tw, th, 3 * k);
    const gr = g.createLinearGradient?.(0, top, 0, top + th);
    if (gr?.addColorStop) { gr.addColorStop(0, '#1d3a33'); gr.addColorStop(0.72, '#10221f'); g.fillStyle = gr; } else g.fillStyle = '#10221f';
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
    g.fill();
    g.shadowColor = 'rgba(0,0,0,0)'; g.shadowBlur = 0; g.shadowOffsetY = 0;
    g.strokeStyle = 'rgba(201,162,74,.92)'; g.lineWidth = 1 * k; g.stroke();
    g.fillStyle = accent; g.fillRect?.(cx - tw / 2 + 1 * k, top + 2 * k, 2.5 * k, th - 4 * k);
    g.fillStyle = '#f4efe0'; g.fillText?.(text, cx + 1.5 * k, top + th / 2 + 0.5 * k);
  });
  g.restore();
  return { x: cx - tw / 2, y: top, w: tw, h: th };
}
