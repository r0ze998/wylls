// The village at work, on the board (UX design 14.2, 14.4), over the record
// map/board.mjs keeps of the viewer's active village:
//
//   building   a scaffold with a ring timer for every item of the queue (2, 3,
//              4 or 4 slots by tier). The queue is serial: the first is being
//              built (its ring fills), the others wait their turn (a staked
//              plot, an empty ring)
//   built      one small addition to the village's own picture for each kind
//              of building it has (map/village.mjs annexes)
//   the fields sheaves stand on the village's fields in proportion to what
//              has grown since the last settling (stores grow by the clock;
//              the Harvest instruction only settles them). At a Harvest they
//              fly to the resource strip (fx/stage.mjs) and the fields are
//              bare again, because the record's own clock was set anew
//   promotion  the village's coloured land floods one ring further when its
//              tier rises (`promotionAt`: the landing's flood for the new
//              ring alone), and its picture is the next tier's
//
// Buildings have no tile in the rules (Build names an item, not a place), so
// nothing here stands on a hex of its own: it is all part of the village.
import { FLATTEN, RADIUS } from '../../map.mjs';
import { villageWork } from './board.mjs';
import { LANDING } from './ownland.mjs';

/** How flat a village's ground is drawn (map/village.mjs F). */
const F = FLATTEN * 0.8;
/**
 * Where the scaffolds of the viewer's own village stand, by queue slot (world px from the tile's centre): the first
 * where a building going up always stood (map/plates.mjs HERO.scaffold), the others beside it, outside the wall on
 * the left and clear of the left-hand host and the gate road.
 */
export const SCAFFOLD_SLOTS = Object.freeze([
  Object.freeze({ x: -RADIUS * 1.16, y: -RADIUS * 0.1 }),
  Object.freeze({ x: -RADIUS * 1.58, y: RADIUS * 0.2 }),
  Object.freeze({ x: -RADIUS * 1.2, y: RADIUS * 0.5 }),
  Object.freeze({ x: -RADIUS * 1.72, y: -RADIUS * 0.26 }),
]);
/** A scaffold that waits its turn is drawn this much smaller and fainter than the one being built. */
export const QUEUED = Object.freeze({ scale: 0.74, alpha: 0.78 });

/**
 * The scaffolds of a village at chain time `now`: `[{p, q, site, slot, item, kind, share, queued, doneAt}]` (the
 * shape the people's painter and the plates take for a construction, one for each queue item).
 */
export function scaffoldsOf(work, now = 0) {
  if (!work) return [];
  let w = null;
  try { w = villageWork(work, now); } catch { w = null; }
  return (w?.queue ?? []).map((q, i) => ({ p: work.p, q: work.q, site: work.site, slot: i, item: q.item, kind: q.kind, queued: i > 0, share: i > 0 ? 0 : q.share, doneAt: q.doneAt }));
}

/**
 * The fields of a village picture, in units of `u` from the middle of its ground (map/village.mjs paintVillage: the
 * strips it draws by tier, and the farm's own when it has one): `[[gx, gy, half width]]`.
 */
export function fieldSpots(tier = 0, { farm = false } = {}) {
  const t = Math.max(0, Math.min(3, tier | 0));
  const base = [[[-0.86, 0.34, 0.26], [0.9, -0.3, 0.24], [0.84, 0.44, 0.2]], [[-1.06, 0.42, 0.24], [1.1, 0.4, 0.22]], [[-1.2, 0.36, 0.2]], []][t];
  const k = [0.6, 0.78, 0.9, 0.96][t] / 0.78;
  // (the farm's own strip, map/village.mjs ANNEX_AT[0] and its first field: the yards keep their side in a mirrored
  // village, so it is not mirrored: its fourth entry says so)
  return farm ? [...base, [(-1.2 + 0.04) * k, (-0.62 + 0.26) * k, 0.22, true]] : base;
}
/** How many sheaves stand on a field that is `share` (0..1) grown: none on a field just settled, `max` on a full one. */
export const sheafCount = (share, max = 5) => (share > 0.02 ? Math.max(1, Math.min(max, Math.round(share * max))) : 0);

/**
 * Sheaves on a village's fields: `share` 0..1 of how much has grown since the last settling (map/board.mjs
 * villageWork `sheaves`). (cx, cy) the middle of the village's ground, `U` its unit (RADIUS times the scale it is
 * drawn at), `flip` its picture is mirrored. Returns the world points of the fields that carry any (where a
 * harvest's goods fly from).
 */
export function paintSheaves(g, cx, cy, U, { tier = 0, farm = false, share = 0, flip = false } = {}) {
  const spots = fieldSpots(tier, { farm }), out = [];
  const n = sheafCount(share);
  if (!g?.save || !n) return out;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const [gx0, gy, w, fixed] of spots) {
    const gx = flip && !fixed ? -gx0 : gx0, x0 = cx + gx * U, y0 = cy + gy * F * U;
    out.push({ x: x0, y: y0 });
    for (let i = 0; i < n; i++) {
      // stooks in two rows along the furrows
      const col = (i % 3) - 1, row = i < 3 ? 0 : 1;
      const x = x0 + (col * 0.62 + row * 0.3) * w * U * 0.72, y = y0 + (row - 0.3) * 0.09 * U + col * 0.03 * U * (gx < 0 ? -1 : 1), s = 0.05 * U;
      g.fillStyle = 'rgba(30,26,14,.22)'; g.beginPath(); g.ellipse?.(x + s * 0.5, y + s * 0.08, s * 1.1, s * 0.4, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#e2c160'; g.strokeStyle = 'rgba(96,70,22,.85)'; g.lineWidth = Math.max(0.6, s * 0.12);
      g.beginPath(); g.moveTo(x - s * 0.62, y); g.lineTo(x - s * 0.2, y - s * 1.5); g.lineTo(x - s * 0.5, y - s * 2.1); g.lineTo(x, y - s * 1.75); g.lineTo(x + s * 0.5, y - s * 2.1); g.lineTo(x + s * 0.2, y - s * 1.5); g.lineTo(x + s * 0.62, y); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = '#8a5f34'; g.lineWidth = Math.max(0.7, s * 0.2); g.beginPath(); g.moveTo(x - s * 0.24, y - s * 1.45); g.lineTo(x + s * 0.24, y - s * 1.45); g.stroke();
    }
  }
  g.restore();
  return out;
}

/**
 * A promotion's flood (UX design 14.2: "at completion the village's coloured land floods one ring further, as at
 * the landing"): the state of a land `t` ms after its tier rose, in the shape map/ownland.mjs landingAt gives, for
 * a land that had rings 0..from and has rings 0..to now. The rings it had are simply there; the new ones flood in
 * the landing's own rhythm; the border draws on again; the standard stands as it stood.
 */
export function promotionAt(t, from = 1, to = 2) {
  const T = LANDING, clamp01 = x => Math.max(0, Math.min(1, x)), outCubic = k => 1 - Math.pow(1 - clamp01(k), 3);
  const fresh = Math.max(0, to - from);
  const ring = d => {
    if (d <= from) return { fill: 1, flash: 0 };
    const t0 = T.floodAt + (d - from - 1) * T.ring, u = (t - t0) / T.ringFade;
    return { fill: outCubic(u), flash: u <= 0 ? 0 : Math.max(0, 1 - (t - t0) / T.flash) };
  };
  const borderAt = T.floodAt + fresh * T.ring + T.borderGap;
  return { ring, border: clamp01((t - borderAt) / T.border), standard: { shown: true, lift: 0, alpha: 1 }, dust: null, done: t >= borderAt + T.border + 200 };
}
/** How long a promotion's flood lasts (ms). */
export const promotionMs = (from = 1, to = 2) => LANDING.floodAt + Math.max(0, to - from) * LANDING.ring + LANDING.borderGap + LANDING.border + 200;
