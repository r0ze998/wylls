// What the board shows of the redesign's stage 1 (S1; docs/frontier/stage1*),
// from the herald's S1 feeds (herald.mjs parseCaravans / parseStructures,
// read into FS.s1 by controller.mjs refreshS1):
//
//   vaults       a strongbox on its tile, in its owner's nation colour
//   structures   a watchtower, a palisade or a fort on its tile; a tower of
//                the viewer's nation also rims the tiles it watches
//   caravans     a cart on the road: where it is is an estimate (the feed
//                names the provinces it passes through and when, not its
//                tiles), so the cart is set on the line from where it left to
//                where it goes by the bells gone, and its tag says when it
//                arrives
//
// The viewer's own things wear a gold rim. Everything here is public. The
// model (`s1Marks`) is pure; the painters are context-tolerant; words go
// through L.
import { RADIUS, project, hexPoints } from '../../map.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { tileHex } from '../fgeo.mjs';
import { YOURS } from './chart.mjs';

const KINDS = { 1: 'tower', 2: 'palisade', 3: 'fort' };
/** The province's centre tile (fgeo.mjs TILE_OFFSETS: the offset (0, 0)). */
export const CENTRE_TILE = 30;

/** The words of the marks. */
export const S1_WORDS = Object.freeze({
  vault: () => L`倉庫`,
  tower: () => L`物見櫓`,
  palisade: () => L`柵`,
  fort: () => L`要塞`,
  caravan: () => L`隊商`,
  raided: () => L`襲われた隊商`,
});
/** A caravan's tag: when it arrives. */
export const caravanTagText = (bell, raided = false) => (raided ? L`襲われた隊商 ターン ${fmtNum(bell)} 着` : L`隊商 ターン ${fmtNum(bell)} 着`);

/** The bell a caravan arrives at: after its last run (the bells it spends in each province on its way). */
export function caravanArriveBell(c) {
  const last = c.runs?.[c.runs.length - 1];
  return last ? last.firstBell + last.n : null;
}

/**
 * Where a caravan stands at `bell` as a share of its road (0 at its origin,
 * 1 at its destination), from its runs; `null` without runs.
 */
export function caravanShare(c, bell) {
  const runs = c.runs ?? [];
  if (!runs.length || !Number.isFinite(bell)) return null;
  const from = runs[0].firstBell, to = caravanArriveBell(c);
  if (to <= from) return 1;
  return Math.max(0, Math.min(1, (bell - from) / (to - from)));
}

const isOwn = (tag, own) => own !== null && own !== undefined && BigInt(tag) === BigInt(own);

/**
 * The marks of the S1 feeds: `{vaults, structures, caravans}`, each item with
 * its tile (`p, q, tile`) and `faction`, `own` (the viewer's) and its kind;
 * a caravan also has `from`/`to` (tiles), `share` and `arriveBell`; a tower
 * `cover` (tile indices of its province). `own` is the viewer's citizen tag
 * (bigint) or null; `bell` the bell now.
 */
export function s1Marks(s1, { own = null, bell = null } = {}) {
  const out = { vaults: [], structures: [], caravans: [] };
  if (!s1) return out;
  for (const v of s1.caravans?.vaults ?? []) out.vaults.push({ kind: 'vault', p: v.p, q: v.q, tile: v.tile, faction: v.faction, own: isOwn(v.ownerTag, own), ownerTag: v.ownerTag });
  for (const s of s1.structures?.structures ?? []) {
    const kind = KINDS[s.kind];
    if (!kind) continue;
    out.structures.push({ kind, p: s.p, q: s.q, tile: s.tile, faction: s.faction, own: isOwn(s.ownerTag, own), ownerTag: s.ownerTag, cover: s.cover, sent: s.sent, notify: s.notify });
  }
  for (const c of s1.caravans?.moving ?? []) {
    const end = x => ({ p: x.p, q: x.q, tile: x.tile });
    out.caravans.push({
      kind: 'caravan', ownerTag: c.ownerTag, seq: c.seq, faction: c.faction, own: isOwn(c.ownerTag, own), raided: c.raided,
      from: end(c.src), to: end(c.dst), cargo: c.cargo, share: caravanShare(c, bell), arriveBell: caravanArriveBell(c),
    });
  }
  return out;
}

/** A caravan's place in world px at its share of the road (straight between its two tiles); null when a tile is unknown. */
export function caravanPoint(c) {
  const a = tileHex(c.from.p, c.from.q, c.from.tile), b = tileHex(c.to.p, c.to.q, c.to.tile);
  if (!a || !b) return null;
  const A = project(a.q, a.r), B = project(b.q, b.r), t = c.share ?? 0;
  return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, a: A, b: B };
}

// ------------------------------------------------------------------ painters
const colourOf = (faction, own) => (own ? YOURS.gold : FACTION_COLORS[faction] ?? '#9a9a9a');
const ink = 'rgba(14,22,20,.88)';

function rim(g, own, u) {
  if (!own) return;
  g.strokeStyle = YOURS.gold; g.lineWidth = u * 0.07; g.stroke();
}

/** A strongbox. */
export function paintVault(g, x, y, u, { faction = 0, own = false } = {}) {
  if (!g?.save) return;
  g.save();
  g.lineJoin = 'round';
  const w = u * 0.62, h = u * 0.42;
  g.fillStyle = 'rgba(8,14,12,.3)'; g.beginPath(); g.ellipse?.(x, y + u * 0.02, w * 0.6, u * 0.08, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#7a5530'; g.strokeStyle = ink; g.lineWidth = u * 0.035;
  g.beginPath(); g.rect(x - w / 2, y - h, w, h); g.fill(); g.stroke();
  g.fillStyle = FACTION_COLORS[faction] ?? '#9a9a9a';
  g.beginPath(); g.rect(x - w / 2, y - h, w, h * 0.3); g.fill(); g.stroke();
  g.fillStyle = '#d9b25a'; g.beginPath(); g.rect(x - u * 0.05, y - h * 0.62, u * 0.1, h * 0.26); g.fill();
  g.beginPath(); g.rect(x - w / 2, y - h, w, h); rim(g, own, u);
  g.restore();
}

/** A watchtower, a palisade or a fort. */
export function paintStructure(g, x, y, u, { kind = 'tower', faction = 0, own = false } = {}) {
  if (!g?.save) return;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  const col = FACTION_COLORS[faction] ?? '#9a9a9a';
  g.fillStyle = 'rgba(8,14,12,.3)'; g.beginPath(); g.ellipse?.(x, y + u * 0.02, u * 0.4, u * 0.1, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink; g.lineWidth = u * 0.035;
  if (kind === 'tower') {
    const w = u * 0.3, h = u * 0.95;
    g.fillStyle = '#9a8f7c'; g.beginPath(); g.moveTo(x - w * 0.6, y); g.lineTo(x - w / 2, y - h); g.lineTo(x + w / 2, y - h); g.lineTo(x + w * 0.6, y); g.closePath(); g.fill(); g.stroke(); rim(g, own, u);
    g.fillStyle = col; g.beginPath(); g.rect(x - w * 0.7, y - h - u * 0.14, w * 1.4, u * 0.16); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(x, y - h - u * 0.14); g.lineTo(x, y - h - u * 0.42); g.stroke();
    g.fillStyle = col; g.beginPath(); g.moveTo(x, y - h - u * 0.42); g.lineTo(x + u * 0.24, y - h - u * 0.35); g.lineTo(x, y - h - u * 0.28); g.closePath(); g.fill();
  } else if (kind === 'palisade') {
    g.fillStyle = '#8a6a40';
    for (let i = -3; i <= 3; i++) {
      const sx = x + i * u * 0.12, top = y - u * (0.42 + (i % 2 ? 0.04 : 0));
      g.beginPath(); g.moveTo(sx - u * 0.05, y); g.lineTo(sx - u * 0.05, top + u * 0.06); g.lineTo(sx, top); g.lineTo(sx + u * 0.05, top + u * 0.06); g.lineTo(sx + u * 0.05, y); g.closePath(); g.fill(); g.stroke();
    }
    g.fillStyle = col; g.beginPath(); g.rect(x - u * 0.4, y - u * 0.26, u * 0.8, u * 0.07); g.fill();
    g.beginPath(); g.rect(x - u * 0.42, y - u * 0.5, u * 0.84, u * 0.5); if (own) rim(g, own, u);
  } else {
    const w = u * 0.8, h = u * 0.55;
    g.fillStyle = '#8f8676'; g.beginPath(); g.rect(x - w / 2, y - h, w, h); g.fill(); g.stroke(); rim(g, own, u);
    // the crenels
    g.fillStyle = '#8f8676';
    for (let i = 0; i < 4; i++) { g.beginPath(); g.rect(x - w / 2 + i * w / 3.5, y - h - u * 0.1, w / 7, u * 0.1); g.fill(); g.stroke(); }
    g.fillStyle = '#2a201a'; g.beginPath(); g.moveTo(x - u * 0.1, y); g.lineTo(x - u * 0.1, y - h * 0.45); g.arc(x, y - h * 0.45, u * 0.1, Math.PI, 0); g.lineTo(x + u * 0.1, y); g.closePath(); g.fill();
    g.fillStyle = col; g.beginPath(); g.rect(x - w / 2, y - h * 0.8, w, h * 0.14); g.fill();
  }
  g.restore();
}

/** A cart with its owner's pennon. */
export function paintCaravan(g, x, y, u, { faction = 0, own = false, raided = false } = {}) {
  if (!g?.save) return;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.fillStyle = 'rgba(8,14,12,.3)'; g.beginPath(); g.ellipse?.(x, y + u * 0.02, u * 0.36, u * 0.08, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink; g.lineWidth = u * 0.035;
  // the bed and its load (a raided cart is empty)
  g.fillStyle = '#7a5530'; g.beginPath(); g.rect(x - u * 0.32, y - u * 0.3, u * 0.64, u * 0.14); g.fill(); g.stroke();
  if (!raided) { g.fillStyle = '#d9c7a0'; g.beginPath(); g.ellipse?.(x, y - u * 0.36, u * 0.26, u * 0.1, 0, Math.PI, 0); g.fill(); g.stroke(); }
  // the wheels
  g.fillStyle = '#3a2a1c';
  for (const dx of [-0.2, 0.2]) { g.beginPath(); g.arc(x + dx * u, y - u * 0.1, u * 0.1, 0, Math.PI * 2); g.fill(); g.stroke(); }
  // the pennon
  g.beginPath(); g.moveTo(x + u * 0.3, y - u * 0.3); g.lineTo(x + u * 0.3, y - u * 0.72); g.stroke();
  g.fillStyle = colourOf(faction, own); g.beginPath(); g.moveTo(x + u * 0.3, y - u * 0.72); g.lineTo(x + u * 0.58, y - u * 0.63); g.lineTo(x + u * 0.3, y - u * 0.54); g.closePath(); g.fill(); g.stroke();
  if (raided) { g.strokeStyle = '#c8402f'; g.lineWidth = u * 0.06; g.beginPath(); g.moveTo(x - u * 0.2, y - u * 0.5); g.lineTo(x + u * 0.1, y - u * 0.2); g.moveTo(x + u * 0.1, y - u * 0.5); g.lineTo(x - u * 0.2, y - u * 0.2); g.stroke(); }
  g.restore();
}

/** The tiles a tower of the viewer's nation watches: a light dashed rim in its colour. */
export function paintCover(g, s, { zoom = 1 } = {}) {
  if (!g?.save || !s.cover?.length) return;
  g.save();
  g.strokeStyle = FACTION_COLORS[s.faction] ?? '#9a9a9a'; g.globalAlpha = 0.55; g.lineWidth = 1.4 / zoom; g.setLineDash?.([5 / zoom, 4 / zoom]);
  for (const idx of s.cover) {
    const h = tileHex(s.p, s.q, idx);
    if (!h) continue;
    const c = project(h.q, h.r), pts = hexPoints(c.x, c.y, RADIUS * 0.08);
    g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); g.stroke();
  }
  g.restore();
}

/**
 * Paints the marks (from `s1Marks`) over the board: cover rims first, then
 * the vaults, structures and caravans standing on their tiles. `stand(x, y,
 * fn)` stands a figure upright (map/tilt.mjs `standing`); `faction` is the
 * viewer's. Returns the caravans' points (for their tags).
 */
export function paintS1Marks(g, marks, { zoom = 1, faction = null, stand = (x, y, fn) => fn() } = {}) {
  const u = RADIUS * 0.62, tags = [];
  if (!marks) return tags;
  for (const s of marks.structures) if (s.kind === 'tower' && (s.own || s.faction === faction)) paintCover(g, s, { zoom });
  const at = (m, dx, dy) => { const h = tileHex(m.p, m.q, m.tile); if (!h) return null; const c = project(h.q, h.r); return { x: c.x + RADIUS * dx, y: c.y + RADIUS * dy }; };
  for (const v of marks.vaults) { const p = at(v, -0.22, 0.2); if (p) stand(p.x, p.y, () => paintVault(g, p.x, p.y, u, v)); }
  for (const s of marks.structures) { const p = at(s, 0.24, 0.18); if (p) stand(p.x, p.y, () => paintStructure(g, p.x, p.y, u, s)); }
  for (const c of marks.caravans) {
    const p = caravanPoint(c);
    if (!p) continue;
    stand(p.x, p.y, () => paintCaravan(g, p.x, p.y, u, c));
    tags.push({ c, x: p.x, y: p.y });
  }
  return tags;
}
