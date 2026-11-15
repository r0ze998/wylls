// The land preview on the map (TEST-ONLY worlds started with `--world-option land-preview-v1`): who holds each tile of
// a province that has a land record (frontier/land.mjs parseLand), drawn so that a change of owner is seen at the
// distance the game is played at:
//
//   held land     a light fill of the holder's colour on each tile, and the holder's line where its land ends (a dark
//                 line under it, so it reads on any ground)
//   a count       a tile another nation's host is pressing: a dashed rim in the presser's colour and an arc that fills
//                 as the turns run (of 72); a tile cut off from its nation's land: a grey dashed rim and its arc (of 36)
//
// Only tiles in sight are drawn (current ownership is shown only where the viewer sees now, as the territory wash);
// nothing is drawn in a world without land records. The painter only reads; the program decides every tile.
import { FLATTEN, RADIUS, hexPoints, project } from '../../map.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { tileHex } from '../fgeo.mjs';
import { landTile } from '../land.mjs';

/** The look: fill alpha (the viewer's own land, others'), the holder's line and its dark under-line (px at zoom 1). */
export const LANDMARK_LOOK = Object.freeze({ fill: Object.freeze({ mine: 0.2, other: 0.26 }), line: 2.4, under: 4.6, dash: Object.freeze([7, 5]), arc: 3, fade: '#c9c3b4' });

const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const lineScale = zoom => (0.72 + 0.28 * Math.min(1.8, Math.max(0.3, zoom))) / zoom;
const keyOf = (q, r) => `${q},${r}`;

/**
 * The tiles to draw from `provinces` [{p, q, land}] (land = parseLand's record): `[{q, r, x, y, owner, count}]` for every
 * tile in sight (`levelAt(p, q, idx)` 3) that a nation holds, and `owners` Map "q,r" → nation of those tiles.
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
      tiles.push({ q: h.q, r: h.r, x: c.x, y: c.y, p, pq: q, idx, owner: info.owner, count: info.count });
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

/** Paints `marks` (landMarks) on `g` in world coordinates. `viewer`: the viewer's nation (its own land a little lighter). */
export function paintLandMarks(g, marks, { zoom = 1, viewer = null } = {}) {
  if (!g?.save || !marks?.tiles?.length) return;
  const k = lineScale(zoom), K = LANDMARK_LOOK;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  // the fill, tile by tile
  for (const t of marks.tiles) {
    const col = FACTION_COLORS[t.owner] ?? '#8a8f86';
    g.globalAlpha = t.owner === viewer ? K.fill.mine : K.fill.other;
    g.fillStyle = col; g.beginPath();
    hexPoints(t.x, t.y, 0.6).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath(); g.fill();
  }
  // the holder's line where its land ends (towards another holder, open ground or what is not drawn)
  const edges = new Map();
  for (const t of marks.tiles) {
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
    const r = RADIUS * 0.34, share = Math.max(0, Math.min(1, t.count.turns / t.count.of));
    if (g.ellipse) {
      g.globalAlpha = 0.5; g.strokeStyle = 'rgba(16,22,20,1)'; g.lineWidth = (K.arc + 2) * k;
      g.beginPath(); g.ellipse(t.x, t.y, r, r * FLATTEN, 0, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = K.arc * k;
      g.beginPath(); g.ellipse(t.x, t.y, r, r * FLATTEN, 0, -Math.PI / 2, -Math.PI / 2 + share * Math.PI * 2); g.stroke();
    }
  }
  g.restore();
}
