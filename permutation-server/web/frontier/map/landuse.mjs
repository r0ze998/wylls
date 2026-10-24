// The land a village works, worked (docs/design/uplift/06-MAP-REST): fields, a woodcutter's yard, a quarry and a mine
// laid on the tiles of a village's own land, in the number its record gives. A village is not a stamp on one hexagon:
// the country round it is farmed.
//
// What stands behind each picture (nothing is drawn that the record does not carry):
//   fields     every village produces food by its tier (fland.mjs BASE_PROD, raised by TIER_BONUS_PCT): 1 + tier
//              fields for any village; the viewer's own village one more for every farm it has built (map/board.mjs
//              buildingsOf, from its Holding's production)
//   timber     the viewer's own village, a woodcutter built: a yard of felled logs beside a wood
//   quarry     the viewer's own village, a quarry built: cut faces on a hill
//   mine       the viewer's own village, a mine built: an adit and its spoil on a hill or under a mountain
// Buildings have no tile in the rules (Build names an item, not a place): which tile of the village's land carries a
// picture is chosen by the picture (the nearest tiles of the fitting kind, the same every time), and says nothing about
// that tile. Other villages' buildings are not known to the page (their Holdings are not read): only their tier's fields.
//
// Flat on the ground (the props pass of map/sprites.mjs paints them first, under what stands). Pure drawing;
// context-tolerant.
import { FLATTEN, RADIUS, hexPoints } from '../../map.mjs';
import { WORKED_RADIUS } from './survey.mjs';

/** What kind of land each picture wants. */
const WANTS = Object.freeze({ field: ['plains', 'grassland'], timber: ['grassland', 'plains', 'hills'], quarry: ['hills'], mine: ['hills', 'mountain'] });
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
const hash = (q, r, n = 0) => { const v = Math.sin(q * 127.1 + r * 311.7 + n * 74.7) * 43758.5453; return v - Math.floor(v); };

/**
 * The pictures of the land use on `tiles`: `[{t, kind, seed}]`. `villages` are the tiles of the villages that stand
 * (`{q, r, tier, own, built}`: `built` the viewer's own village's buildings by kind, else null); `tileAt(q, r)` the
 * painted tile of a hex (null where none: not surveyed, cloud); a tile carries one picture at most.
 */
export function landUse(villages, tileAt) {
  const out = [], taken = new Set();
  // nearer villages first claim the tiles between them (the same answer whatever order the villages come in)
  const vs = [...villages].sort((a, b) => a.q - b.q || a.r - b.r);
  for (const v of vs) taken.add(`${v.q},${v.r}`);
  for (const v of vs) {
    const rad = WORKED_RADIUS[v.tier ?? 0] ?? 1;
    const near = [];
    for (let dq = -rad; dq <= rad; dq++) for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad); dr++) {
      if (!dq && !dr) continue;
      const t = tileAt(v.q + dq, v.r + dr);
      if (t && t.site === undefined && !t.river) near.push(t);
    }
    near.sort((a, b) => dist(a, v) - dist(b, v) || hash(a.q, a.r) - hash(b.q, b.r));
    const want = [];
    const b = v.own && v.built ? v.built : null;
    for (let i = 0; i < 1 + Math.min(3, v.tier ?? 0) + Math.min(4, b?.[0] ?? 0); i++) want.push('field');
    if (b?.[1] > 0) want.push('timber');
    if (b?.[2] > 0) want.push('quarry');
    if (b?.[3] > 0) want.push('mine');
    for (const kind of want) {
      // the yard of a woodcutter stands where a wood is next to it
      const fits = t => WANTS[kind].includes(t.name) && !taken.has(`${t.q},${t.r}`) && (kind !== 'timber' || [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]].some(([dq, dr]) => tileAt(t.q + dq, t.r + dr)?.name === 'forest'));
      const t = near.find(fits);
      if (!t) continue;
      taken.add(`${t.q},${t.r}`);
      out.push({ t, kind, seed: Math.floor(hash(t.q, t.r, 9) * 1e6) });
    }
  }
  return out;
}

function rng(seed) {
  let a = (seed | 0) || 1;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hexClip = (g, x, y, inset) => { g.beginPath(); hexPoints(x, y, inset).forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); g.clip(); };
const CROPS = Object.freeze([['#e3c45e', 'rgba(146,112,30,.55)'], ['#9cc04e', 'rgba(70,108,30,.55)'], ['#b07f48', 'rgba(104,70,34,.55)'], ['#d6c57e', 'rgba(140,118,60,.5)'], ['#c9ad46', 'rgba(132,104,30,.55)'], ['#7fae4a', 'rgba(56,92,26,.55)']]);

/** Fields: a patchwork of strips with furrows and hedges, lying on the ground of a tile (centre x, y). */
export function paintFields(g, x, y, seed) {
  const R = rng(seed), turn = (R() - 0.5) * 1.2, c = Math.cos(turn), s = Math.sin(turn);
  g.save(); hexClip(g, x, y, RADIUS * 0.16);
  // the parcels: a grid of three to four strips across, each split once along its length
  const at = (i, j) => [x + (i * c - j * s), y + (i * s + j * c) * FLATTEN];
  const W = RADIUS * 0.34, cols = 6, rows = 2;
  for (let a = -cols / 2; a < cols / 2; a++) for (let b = -rows; b < rows; b++) {
    const crop = CROPS[Math.floor(R() * CROPS.length)], x0 = a * W, y0 = b * RADIUS * 0.55, x1 = x0 + W, y1 = y0 + RADIUS * 0.55;
    g.beginPath(); [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)].forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath();
    g.fillStyle = crop[0]; g.globalAlpha = 0.94; g.fill();
    g.globalAlpha = 1; g.strokeStyle = 'rgba(70,56,24,.35)'; g.lineWidth = 0.7; g.stroke();
    // furrows along the strip
    g.globalAlpha = 1; g.strokeStyle = crop[1]; g.lineWidth = 0.8;
    for (let k = 1; k < 5; k++) { const fx = x0 + (W * k) / 5; g.beginPath(); g.moveTo(...at(fx, y0)); g.lineTo(...at(fx, y1)); g.stroke(); }
  }
  // hedgerows between the parcels: dark green, broken
  g.strokeStyle = 'rgba(58,86,36,.75)'; g.lineWidth = 1.6; g.setLineDash?.([5, 2, 3, 2]);
  for (let a = -cols / 2; a <= cols / 2; a += 2) { g.beginPath(); g.moveTo(...at(a * W, -rows * RADIUS * 0.55)); g.lineTo(...at(a * W, rows * RADIUS * 0.55)); g.stroke(); }
  g.beginPath(); g.moveTo(...at(-cols / 2 * W, 0)); g.lineTo(...at(cols / 2 * W, 0)); g.stroke();
  g.setLineDash?.([]);
  // the field's edge melts into the grass round it (no hard hexagon): the grass's green over its rim, inside it
  if (g.createRadialGradient) {
    g.translate(x, y); g.scale(1, FLATTEN);
    const gr = g.createRadialGradient(0, 0, RADIUS * 0.42, 0, 0, RADIUS * 0.86);
    gr.addColorStop(0, 'rgba(112,146,62,0)'); gr.addColorStop(1, 'rgba(112,146,62,.6)');
    g.fillStyle = gr; g.fillRect(-RADIUS, -RADIUS, RADIUS * 2, RADIUS * 2);
  }
  g.restore();
}

/** A woodcutter's yard: trodden ground, stacked logs, a sawhorse, a few stumps. */
export function paintTimber(g, x, y, seed) {
  const R = rng(seed);
  // the trodden yard
  if (g.createRadialGradient) {
    g.save(); g.translate(x, y); g.scale(1, FLATTEN);
    const gr = g.createRadialGradient(0, 0, 2, 0, 0, RADIUS * 0.6);
    gr.addColorStop(0, 'rgba(160,128,82,.75)'); gr.addColorStop(1, 'rgba(160,128,82,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, RADIUS * 0.6, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.save();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3 - i; j++) {
    const lx = x - 8 + j * 6 + i * 3, ly = y + 2 - i * 4.2;
    g.fillStyle = '#8a5f34'; g.strokeStyle = 'rgba(46,30,14,.85)'; g.lineWidth = 0.7;
    g.beginPath(); g.ellipse?.(lx, ly, 3.2, 2.4, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#d9b47a'; g.beginPath(); g.ellipse?.(lx, ly, 1.7, 1.2, 0, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 5; i++) { const sx = x + (R() - 0.5) * RADIUS * 1.0, sy = y + (R() - 0.5) * RADIUS * 0.6; g.fillStyle = '#6a4c30'; g.beginPath(); g.ellipse?.(sx, sy, 2.2, 1.4, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = '#c9a26a'; g.beginPath(); g.ellipse?.(sx, sy - 0.6, 1.6, 0.9, 0, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#5a3e22'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(x + 10, y + 4); g.lineTo(x + 14, y - 4); g.moveTo(x + 18, y + 4); g.lineTo(x + 14, y - 4); g.moveTo(x + 8, y - 3); g.lineTo(x + 20, y - 3); g.stroke();
  g.restore();
}

/** A quarry: pale terraces cut into a hill, squared blocks below. */
export function paintQuarry(g, x, y, seed) {
  const R = rng(seed);
  g.save();
  const steps = [[-16, -6, 30, 7], [-13, 1, 26, 6], [-9, 7, 20, 5]];
  for (const [dx, dy, w, h] of steps) {
    g.fillStyle = '#e4dcc4'; g.strokeStyle = 'rgba(96,84,60,.7)'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(x + dx, y + dy); g.lineTo(x + dx + w, y + dy - 2); g.lineTo(x + dx + w, y + dy + h - 2); g.lineTo(x + dx, y + dy + h); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = 'rgba(120,108,84,.55)'; g.fillRect(x + dx, y + dy + h - 1.6, w, 1.6);
  }
  for (let i = 0; i < 4; i++) { const bx = x + 12 + R() * 10, by = y + 6 + R() * 6; g.fillStyle = '#efe7d1'; g.strokeStyle = 'rgba(96,84,60,.7)'; g.fillRect(bx, by, 4, 3); g.strokeRect(bx, by, 4, 3); }
  g.restore();
}

/** A mine: an adit framed in timber in the hillside, its heap of spoil, a cart on its rail. */
export function paintMine(g, x, y, seed) {
  void seed;
  g.save();
  g.fillStyle = 'rgba(96,88,74,.85)'; g.beginPath(); g.ellipse?.(x + 8, y + 6, 13, 6, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(70,64,54,.9)'; g.beginPath(); g.ellipse?.(x + 10, y + 4, 7, 3.5, 0, Math.PI, 0); g.fill();
  g.fillStyle = '#1c1712'; g.beginPath(); g.moveTo(x - 9, y + 3); g.lineTo(x - 9, y - 5); g.quadraticCurveTo(x - 5, y - 9, x - 1, y - 5); g.lineTo(x - 1, y + 3); g.closePath(); g.fill();
  g.strokeStyle = '#b89260'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x - 10, y + 3); g.lineTo(x - 10, y - 6); g.lineTo(x, y - 6); g.lineTo(x, y + 3); g.stroke();
  g.strokeStyle = 'rgba(40,34,22,.75)'; g.lineWidth = 0.9; g.beginPath(); g.moveTo(x - 5, y + 4); g.lineTo(x + 16, y + 9); g.moveTo(x - 5, y + 6); g.lineTo(x + 16, y + 11); g.stroke();
  g.fillStyle = '#5b4a36'; g.fillRect(x + 6, y + 3, 6, 4); g.fillStyle = '#9fb0b8'; g.beginPath(); g.ellipse?.(x + 9, y + 3, 3, 1.4, 0, Math.PI, 0); g.fill();
  g.restore();
}

const PAINT = { field: paintFields, timber: paintTimber, quarry: paintQuarry, mine: paintMine };
/** Paint the land use (`landUse`'s list). `muted(t)`: the tile is surveyed but out of sight (drawn quieter). */
export function paintLandUse(g, list, { muted = () => false } = {}) {
  if (!g?.save) return;
  for (const { t, kind, seed } of list) {
    g.save();
    if (muted(t)) g.globalAlpha = 0.55;
    PAINT[kind]?.(g, t.x, t.y, seed);
    g.restore();
  }
}
