// The land preview on the map (TEST-ONLY worlds started with `--world-option land-preview-v1`): who holds each tile of
// a province that has a land record (frontier/land.mjs parseLand), drawn so that a change of owner is seen at the
// distance the game is played at:
//
//   held land     a fill of the holder's colour on each tile and the holder's line where its land ends (a dark line
//                 under it, so it reads on any ground). Another nation's land is also hatched in its colour, so "not
//                 yours" reads at a glance whatever the colours; the viewer's own land is solid (and carries the gold
//                 line of map/ownland.mjs: recordLands)
//   a count       a tile another nation's host is pressing: a dashed rim in the presser's colour and a solid line that
//                 runs round the tile's edge as the turns run (of 72) — on the edge, where a host standing on the tile
//                 does not cover it; a tile cut off from its nation's land: the same in grey (of 36)
//
// Only tiles in sight are drawn (current ownership is shown only where the viewer sees now, as the territory wash);
// nothing is drawn in a world without land records. The painter only reads; the program decides every tile.
import { RADIUS, hexPoints, project } from '../../map.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { tileHex } from '../fgeo.mjs';
import { landTile } from '../land.mjs';

/** The look: fill alpha (the viewer's own land, others'), the holder's line and its dark under-line (px at zoom 1). */
export const LANDMARK_LOOK = Object.freeze({ fill: Object.freeze({ mine: 0.36, other: 0.3 }), hatch: Object.freeze({ gap: 9, width: 1.7, alpha: 0.7 }), line: 3.2, under: 5.8, dash: Object.freeze([7, 5]), run: 4.2, fade: '#c9c3b4' });

const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const lineScale = zoom => (0.72 + 0.28 * Math.min(1.8, Math.max(0.3, zoom))) / zoom;
const keyOf = (q, r) => `${q},${r}`;

/**
 * The tiles to draw from `provinces` [{p, q, land}] (land = parseLand's record): `[{q, r, x, y, owner, village, count}]`
 * for every tile in sight (`levelAt(p, q, idx)` 3) that a nation holds, and `owners` Map "q,r" → nation of those tiles.
 * Village land is drawn by the villages' own painters (map/ownland.mjs, the territory wash): it is not filled or lined
 * here, only counted as its nation's land where a claimed tile's edge is decided.
 */
export function landMarks(provinces, { levelAt = () => 3 } = {}) {
  const tiles = [], owners = new Map();
  for (const { p, q, land } of provinces ?? []) {
    if (!land) continue;
    for (let idx = 0; idx < land.owners.length; idx++) {
      if (levelAt(p, q, idx) !== 3) continue;
      const info = landTile(land, idx), h = tileHex(p, q, idx);
      if (!info || info.owner === null || !h) continue;
      const c = project(h.q, h.r);
      tiles.push({ q: h.q, r: h.r, x: c.x, y: c.y, p, pq: q, idx, owner: info.owner, village: info.village, count: info.count });
      owners.set(keyOf(h.q, h.r), info.owner);
    }
  }
  return { tiles, owners };
}

/** A signature of what landMarks would draw (a kept layer is painted again when it changes). */
export const landMarksKey = marks => marks.tiles.map(t => `${t.q},${t.r}:${t.owner}${t.count ? `${t.count.kind[0]}${t.count.by}.${t.count.turns}` : ''}`).join('|');

/** The two corners of tile `t` that face its neighbour at (nq, nr): the corners nearest that neighbour's centre. */
function edgeToward(pts, nq, nr) {
  const n = project(nq, nr);
  const d = pts.map(([x, y], i) => ({ i, d: (x - n.x) ** 2 + (y - n.y) ** 2 })).sort((a, b) => a.d - b.d);
  return [pts[d[0].i], pts[d[1].i]];
}

/** The first `share` (0..1) of the closed outline `pts`, from its topmost corner, as a polyline. */
export function runAlong(pts, share) {
  if (!(share > 0) || !pts?.length) return [];
  const top = pts.reduce((b, p, i) => (p[1] < pts[b][1] ? i : b), 0);
  const ring = [...pts.slice(top), ...pts.slice(0, top), pts[top]];
  const seg = ring.slice(1).map((p, i) => Math.hypot(p[0] - ring[i][0], p[1] - ring[i][1]));
  let left = share * seg.reduce((a, b) => a + b, 0);
  const out = [ring[0]];
  for (let i = 0; i < seg.length && left > 0; i++) {
    const f = Math.min(1, left / seg[i]);
    out.push([ring[i][0] + (ring[i + 1][0] - ring[i][0]) * f, ring[i][1] + (ring[i + 1][1] - ring[i][1]) * f]);
    left -= seg[i];
  }
  return out;
}

/** Paints `marks` (landMarks) on `g` in world coordinates. `viewer`: the viewer's nation (its own land a little lighter). */
export function paintLandMarks(g, marks, { zoom = 1, viewer = null } = {}) {
  if (!g?.save || !marks?.tiles?.length) return;
  const k = lineScale(zoom), K = LANDMARK_LOOK;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  // the fill, tile by tile; another nation's land hatched in its colour
  for (const t of marks.tiles) {
    if (t.village) continue;
    const col = FACTION_COLORS[t.owner] ?? '#8a8f86', mine = t.owner === viewer;
    const hex = () => { g.beginPath(); hexPoints(t.x, t.y, 0.6).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
    g.globalAlpha = mine ? K.fill.mine : K.fill.other;
    g.fillStyle = col; hex(); g.fill();
    if (!mine) {
      g.save(); hex(); g.clip?.();
      g.globalAlpha = K.hatch.alpha; g.strokeStyle = col; g.lineWidth = K.hatch.width * k;
      const R = RADIUS, step = K.hatch.gap * Math.max(0.7, k * 0.9);
      g.beginPath();
      for (let d = -2 * R; d <= 2 * R; d += step) { g.moveTo(t.x + d - R, t.y + R); g.lineTo(t.x + d + R, t.y - R); }
      g.stroke(); g.restore();
    }
  }
  // the holder's line where its land ends (towards another holder, open ground or what is not drawn)
  const edges = new Map();
  for (const t of marks.tiles) {
    if (t.village) continue;
    const pts = hexPoints(t.x, t.y, 1.2);
    for (const [dq, dr] of DIRS) {
      const o = marks.owners.get(keyOf(t.q + dq, t.r + dr));
      if (o === t.owner) continue;
      const list = edges.get(t.owner) ?? edges.set(t.owner, []).get(t.owner);
      list.push(edgeToward(pts, t.q + dq, t.r + dr));
    }
  }
  for (const [f, list] of edges) {
    const path = () => { g.beginPath(); for (const [[ax, ay], [bx, by]] of list) { g.moveTo(ax, ay); g.lineTo(bx, by); } };
    g.globalAlpha = 0.55; g.strokeStyle = 'rgba(16,22,20,1)'; g.lineWidth = K.under * k; path(); g.stroke();
    g.globalAlpha = 1; g.strokeStyle = FACTION_COLORS[f] ?? '#8a8f86'; g.lineWidth = K.line * k; path(); g.stroke();
  }
  // the counts: a dashed rim and an arc of how far the turns have come
  for (const t of marks.tiles) {
    if (!t.count) continue;
    const col = t.count.kind === 'take' ? FACTION_COLORS[t.count.by] ?? '#8a8f86' : K.fade;
    const pts = hexPoints(t.x, t.y, 5);
    g.setLineDash?.([K.dash[0] * k, K.dash[1] * k]);
    g.globalAlpha = 0.6; g.strokeStyle = 'rgba(16,22,20,1)'; g.lineWidth = (K.line + 1.6) * k;
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
    g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = K.line * k; g.stroke();
    g.setLineDash?.([]);
    // how far the turns have come: a solid line round the tile's edge, from its top corner, clockwise
    const run = runAlong(hexPoints(t.x, t.y, 9), Math.max(0, Math.min(1, t.count.turns / t.count.of)));
    if (run.length > 1) {
      const line = () => { g.beginPath(); run.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
      g.globalAlpha = 0.6; g.strokeStyle = 'rgba(16,22,20,1)'; g.lineWidth = (K.run + 2.2) * k; line(); g.stroke();
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = K.run * k; line(); g.stroke();
    }
  }
  g.restore();
}
