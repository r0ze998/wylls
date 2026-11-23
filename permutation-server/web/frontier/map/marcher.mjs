// The viewer's own sealed march as figures walking the road (UX design 14.3;
// found on the merged screens, 2026-10-11: at the zoom the board is played
// at, and one step out, the march was a small hexagon portrait on its ribbon
// and read as a marker). Where the column is by the clock (map/board.mjs
// marchShare) the player's character walks at the head of a short file of
// the host's own figures, facing the way the road goes, never smaller on
// screen than a figure reads at. A host the character does not lead is the
// file alone. Only this browser draws it: the destination of a sealed march
// is no one else's to see (the tag over it says so: map/hostmarks.mjs).
import { RADIUS } from '../../map.mjs';
import { MOTION_LEADERS, BOARD_CHARACTER_SCALE, LEADER_FIGURE } from '../leader-motion-data.mjs';
import { paintLeaderMotion, paintContactShadow, leaderCellWidth } from '../people/leader-motion.mjs';
import { MINI_KINDS, paintMini } from '../people/minis.mjs';
import { pathAt } from '../fx/draw.mjs';

/**
 * The marching figures: the character's unit on the board (the same as beside its village) and the least its figure
 * is tall on screen (px); the file behind it: how many figures, how far apart along the road (corner radii), their
 * unit and the least they are tall on screen; how fast they step (cycles a second).
 */
export const MARCHER = Object.freeze({
  unit: RADIUS * 0.66 * BOARD_CHARACTER_SCALE, minPx: 64,
  file: 3, gap: 0.62, lead: 0.5, miniUnit: RADIUS * 0.6, miniMinPx: 30,
  pace: 1.15, miniPace: 1.9, shade: 0.5,
});
/** How tall a character's figure stands in the unit `u`. */
const tall = u => leaderCellWidth(u) * LEADER_FIGURE.up;
/** The character's unit at `zoom`: as on the board, and never under MARCHER.minPx tall on screen. */
export const marcherUnit = zoom => Math.max(MARCHER.unit, MARCHER.minPx / (zoom * tall(1)));
/** How tall the marching figure is drawn at `zoom` (world px): the tag over it hangs above this. */
export const marcherTop = (zoom, lead = true) => (lead ? tall(marcherUnit(zoom)) : Math.max(MARCHER.miniUnit, MARCHER.miniMinPx / zoom) * 1.5);

/**
 * Where the figures of a march stand: `path` (fx/draw.mjs smoothPath of the road), `share` 0..1 how far the column
 * has come. `[{x, y, face, kind: 'lead' | 'mini', i}]`, the head first; the file follows the road behind it.
 */
export function marcherSpots(path, share, { zoom = 1, lead = true, file = MARCHER.file } = {}) {
  const total = path?.total ?? 0, head = pathAt(path, share);
  if (!head) return [];
  const face = (head.dx ?? 1) >= 0 ? 1 : -1, out = [];
  // (the file keeps its spacing on screen from afar, where the figures are drawn larger than the road's own scale)
  const gap = Math.max(RADIUS * MARCHER.gap, (MARCHER.miniMinPx * 0.72) / zoom), first = lead ? Math.max(RADIUS * MARCHER.lead, (MARCHER.minPx * 0.42) / zoom) : 0;
  if (lead) out.push({ x: head.x, y: head.y, face, kind: 'lead', i: 0 });
  for (let i = 0; i < file; i++) {
    const back = first + gap * (lead ? i + 0.4 : i), k = total > 0 ? share - back / total : share;
    if (k < 0) break;
    const at = pathAt(path, k);
    if (at) out.push({ x: at.x, y: at.y, face: (at.dx ?? face) >= 0 ? 1 : -1, kind: 'mini', i });
  }
  return out;
}

/**
 * Paint one figure of a march at its spot (in the plane; the caller stands it upright: map/tilt.mjs standing).
 * `walking` false: the column has arrived and waits for its seal to be opened. Returns false when the figure's
 * art is not here yet (the caller draws the old marker in its place).
 */
export function paintMarcher(g, spot, { zoom = 1, faction = 0, unit = 0, now = 0, still = false, walking = true } = {}) {
  if (!g?.save || !spot) return false;
  const t = now / 1000, go = walking && !still;
  if (spot.kind === 'lead') {
    const u = marcherUnit(zoom), key = MOTION_LEADERS[faction]?.key;
    if (!key) return false;
    paintContactShadow(g, spot.x, spot.y, u, 0.9);
    return paintLeaderMotion(g, spot.x, spot.y, u, { leader: key, motion: go ? 'walk' : 'idle', share: go ? (t * MARCHER.pace) % 1 : 0, looping: true, face: spot.face, own: true });
  }
  const s = Math.max(MARCHER.miniUnit, MARCHER.miniMinPx / zoom), kind = MINI_KINDS[unit] ?? MINI_KINDS[0];
  return paintMini(g, spot.x, spot.y, s, kind, { faction, face: spot.face, walking: go, step: go ? t * MARCHER.miniPace + spot.i * 0.37 : 0, shade: MARCHER.shade, own: true });
}

/**
 * (territory-video-2) Where a march's column stands aside so it does not stand in another's heap: `heads` the column
 * heads already placed this frame (world px; this one is added), `at` this column's head, `path`/`k` its road and how far
 * along. A head within a figure's width of an earlier one steps across its road (the normal of the road there) by a
 * figure's width per column already there, alternating sides. → `{dx, dy}` world px (0, 0 when it stands clear).
 */
export function columnLane(heads, at, { zoom = 1, path = null, k = 0 } = {}) {
  const w = Math.max(MARCHER.unit * 0.9, (MARCHER.minPx * 0.62) / Math.max(zoom, 1e-9));
  const near = heads.filter(h => Math.hypot(h.x - at.x, h.y - at.y) < w).length;
  let dx = 0, dy = 0;
  if (near > 0) {
    const a = pathAt(path, Math.max(0, k - 0.01)), b = pathAt(path, Math.min(1, k + 0.01));
    let tx = b && a ? b.x - a.x : 1, ty = b && a ? b.y - a.y : 0;
    const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
    const side = near % 2 ? 1 : -1, step = Math.ceil(near / 2) * w;
    dx = -ty * step * side; dy = tx * step * side;
  }
  // (kept where the road has it, not where it stepped to: the next column at the same place counts it)
  heads.push({ x: at.x, y: at.y });
  return { dx, dy };
}

/** (territory-video-2) A marching figure's box about its foot (world px at `zoom`): what the words keep clear of. */
export function marcherBox(spot, zoom = 1) {
  const h = spot.kind === 'lead' ? marcherTop(zoom, true) : marcherTop(zoom, false), w = h * 0.55;
  return { x: spot.x - w / 2, y: spot.y - h, w, h };
}
