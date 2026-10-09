// Sprite art for the Frontier map (art: docs/frontier/art/tiles, rules: its LOD.md). Opt-in: the
// page passes `art` to FrontierMap when the URL has ?art=1; the vector painters in layers.mjs stay
// the default.
//
// Tile LOD: every visible province's tiles are drawn together, back to front — pass 1 ground,
// shore/beach, territory wash, then a thin vector hex grid; pass 2 props and holdings. Sprites are
// shifted so each tile's top face sits exactly on the game's hex (the art's anchor is the ground
// plane; its top face is H above it). Province boundaries follow the tile edges (not the province
// cell), and fog veils the same outline.
//
// Province / world LOD: a Civ-style strategic view — each province is a cached bitmap of flat hexes
// in muted terrain colours with small marks, under a translucent owner tint, the tile-edge
// boundary, the sigil and the clash ring. A province without terrain yet uses the vector cell.
//
// Cost (UX brief §9). The tile view is painted in three parts — 'ground' (the land and what
// lies flat on it), 'props' (what stands on it) and 'live' (hosts, people, moments, battles,
// fog, labels) — so the map can keep the first two still while the camera rests and repaint
// only the third on the animation timer (fmap.mjs paintLayered). The still ground of a
// province (ground sprites, shores, roads and the hex grid) is also kept in a bitmap of its
// own in world space (the ground part of paint), so a moving camera copies a few bitmaps
// instead of drawing every ground sprite; it holds the territory wash and borders too and is
// painted again when the province's roads or territory change.
// The tiles of a frame are built once and kept while nothing changed (model), indexed by
// hex, by province and by tile. Hosts stand in the scene: a tall thing on a tile in front of
// a host (a mountain, a wood, a town) covers it.
import { COLORS, FLATTEN, RADIUS, hexPoints, polygon, project, shade } from '../../map.mjs';
import { PROVINCE_TILES, locate, provinceCentre, ringOf, ringProvinces, tileHex, wedgeOf } from '../fgeo.mjs';
import { FACTION_COLORS } from '../fi18n.mjs';
import { majorityOwner } from '../herald.mjs';
import { paintPeople, PEOPLE_FRAME_MS, zoomBoost } from '../people/crowds.mjs';
import { activitiesFor } from '../people/activity.mjs';
import { lifeAt } from '../people/life.mjs';
import { paintBattle, battleTiles } from '../people/battle.mjs';
import { provinceTokens, paintToken } from '../people/units.mjs';
import { onMiniLoad, MINI_ANCHOR, MINI_CELL_U } from '../people/minis.mjs';
import { paintMoments } from '../people/moments.mjs';
// (the effects engine's ground pass comes through the map's `between` hook: fx/index.mjs startFx)
import { paintOver as fxOver } from '../fx/engine.mjs';
import { BOUNDARY_HALO, BOUNDARY_INK, FOG, UNOPENED_FILL, paintSigil, provincePixel, PROVINCE_CIRCUMRADIUS } from './layers.mjs';
import { applySurvey, fxNow, mutedSprite, paintChart, paintReveal } from './chart.mjs';
import { standing, upright } from './tilt.mjs';
import { FOG_OF_LEVEL, L2, L3, hexKey } from './survey.mjs';
import { reducedMotion } from './camera.mjs';
import { landShape } from './ownland.mjs';
import { HERO, paintPlates, scaffoldAt, villagePlace } from './plates.mjs';
import { villageSprite } from './village.mjs';
import { OPEN_PASS } from './labelpass.mjs';
import { paintBellTower, towerSprite } from './belltower.mjs';

const BASE = new URL('../art/', import.meta.url);
/** The far bitmaps' resolutions (device px per world px) and their cache budget in pixels. */
export const FAR_RES = Object.freeze([0.1, 0.2, 0.36, 0.56, 0.8, 1]);
export const FAR_PIXELS = 24_000_000;
/** The ground bitmaps of the tile view: their cache budget in pixels, and how many may be painted in one frame. */
export const GROUND_PIXELS = 12_000_000;
export const GROUND_BAKES = 2;
/** How strong another nation's territory is drawn for a viewer who has a nation (its wash, its borders): quieter than the viewer's own nation's. */
export const OTHER_WASH = 0.6;
export const OTHER_BORDER = 0.82;
/** The hex grid's line (world px): it is part of the board and scales with it. */
export const GRID_WORLD = 0.9;
/** Milliseconds a frame may spend painting new far bitmaps (the rest wait for the next frame). */
export const FAR_BUDGET_MS = 8;
/** Dark inks of the six factions (borders), after the portraits' palette. */
const FACTION_DARK_INK = Object.freeze(['#7d2c27', '#1b5a53', '#7d5a14', '#4b3874', '#24497b', '#6f2d4c']);

/** The war lens: per province, the hosts of each faction present (the overview's counts) as banners with a number. */
export function paintWarLens(ctx, entries, zoom) {
  const k = 1 / zoom;
  ctx.save();
  ctx.font = `700 ${11 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const e of entries) {
    const hosts = e.rec?.hosts;
    if (!hosts) continue;
    const list = hosts.map((n, f) => ({ n, f })).filter(x => x.n > 0);
    if (!list.length) continue;
    const c = provincePixel(e.p, e.q);
    const w = 26 * k, h = 16 * k, gap = 3 * k, x0 = c.x - (list.length * (w + gap) - gap) / 2;
    list.forEach((x, i) => {
      const bx = x0 + i * (w + gap), by = c.y - h / 2 - 14 * k;
      ctx.fillStyle = x.f === 6 ? '#5b3b2a' : FACTION_COLORS[x.f]; ctx.strokeStyle = '#1b1a16'; ctx.lineWidth = 1.2 * k;
      ctx.beginPath(); ctx.roundRect?.(bx, by, w, h, 4 * k); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fffaf0'; ctx.fillText(`\u2694${x.n}`, bx + w / 2, by + h / 2 + 0.5 * k);
    });
  }
  ctx.restore();
}

/** The settle lens: every free site as a ring of light (where a new holding could go). */
export function paintSettleLens(ctx, entries, zoom, levelAt = null) {
  const k = 1 / zoom;
  ctx.save();
  for (const e of entries) {
    if (!e.rec || !e.sites) continue;
    e.sites.forEach((idx, j) => {
      if (e.rec.sites[j] !== 0) return;
      const h = tileHex(e.p, e.q, idx), c = project(h.q, h.r);
      if (levelAt && levelAt(h.q, h.r) < L2) return;
      ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(RADIUS * 0.45, 5 * k), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(244,239,224,.3)'; ctx.fill(); ctx.strokeStyle = '#f4efe0'; ctx.lineWidth = 2 * k; ctx.stroke();
    });
  }
  ctx.restore();
}

/** House positions of a settlement by tier (units of its size; x right, y down). */
const SETTLEMENT = [
  [[-0.32, 0.05, 0.42], [0.22, -0.12, 0.48], [0.1, 0.28, 0.38]],
  [[-0.42, 0.1, 0.4], [0.3, 0.12, 0.42], [-0.05, 0.32, 0.4], [0.02, -0.18, 0.5]],
  [[-0.46, 0.08, 0.38], [0.42, 0.08, 0.38], [-0.2, 0.34, 0.38], [0.22, 0.34, 0.38], [0, -0.18, 0.52]],
  [[-0.4, 0.12, 0.38], [0.4, 0.12, 0.38], [0, 0.32, 0.38], [0, -0.16, 0.56]],
];
/**
 * A settlement in vector for the far view: a shadow, little houses with
 * roofs in the faction's colour, a tower for a town and up, walls for a city
 * and a stronghold. `s` is its width in world px.
 */
export function paintSettlement(ctx, x, y, s, f, tier = 0) {
  const roof = FACTION_COLORS[f] ?? '#8a8f86', ink = FACTION_DARK_INK[f] ?? '#3a3a34';
  ctx.save();
  ctx.globalAlpha = 0.35; ctx.fillStyle = '#120f0c';
  ctx.beginPath(); ctx.ellipse(x, y + s * 0.18, s * 0.62, s * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  if (tier >= 2) { // walls
    ctx.fillStyle = '#d9d2c0'; ctx.strokeStyle = '#5a5246'; ctx.lineWidth = s * 0.05;
    ctx.beginPath(); ctx.ellipse(x, y + s * 0.1, s * 0.66, s * 0.36, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  const houses = SETTLEMENT[Math.max(0, Math.min(3, tier))].slice().sort((a, b) => a[1] - b[1]);
  for (const [hx, hy, hs] of houses) {
    const w = s * hs, cx = x + hx * s, cy = y + hy * s;
    const tower = hy < 0 && tier >= 1;
    const bodyH = tower ? w * 1.1 : w * 0.55;
    ctx.fillStyle = '#efe6d2'; ctx.strokeStyle = '#3b3328'; ctx.lineWidth = s * 0.035;
    ctx.beginPath(); ctx.rect(cx - w * 0.38, cy - bodyH, w * 0.76, bodyH); ctx.fill(); ctx.stroke();
    ctx.fillStyle = roof; ctx.strokeStyle = ink;
    ctx.beginPath(); ctx.moveTo(cx - w * 0.5, cy - bodyH + w * 0.02); ctx.lineTo(cx, cy - bodyH - w * (tower ? 0.55 : 0.42)); ctx.lineTo(cx + w * 0.5, cy - bodyH + w * 0.02); ctx.closePath(); ctx.fill(); ctx.stroke();
    if (tower && tier >= 3) { ctx.fillStyle = roof; ctx.beginPath(); ctx.moveTo(cx, cy - bodyH - w * 0.55); ctx.lineTo(cx + w * 0.3, cy - bodyH - w * 0.45); ctx.lineTo(cx, cy - bodyH - w * 0.35); ctx.closePath(); ctx.fill(); }
  }
  ctx.restore();
}

/** The realms of a set of far entries: per faction a fill path and a border path, and the holdings' marks. */
export function buildRealms(entries, { grow = 0, levelAt = null, own = null } = {}) {
  // `own`: a Set "P,Q,tile" of the viewer's own villages: they keep their mark and claim no realm land here
  // (the viewer's land is painted as the viewer's own, in its true size: map/ownland.mjs)
  // with a survey: only the villages the viewer has surveyed, and their land only as far as it is surveyed
  const seen = (q, r) => !levelAt || levelAt(q, r) >= L2;
  if (typeof Path2D === 'undefined') return null;
  const owner = new Map(), holdings = [];
  const hexOf = new Map(), water = new Set();
  for (const e of entries) {
    if (!e.terrain) continue;
    for (let i = 0; i < PROVINCE_TILES; i++) if (e.names?.[e.terrain[i]] === 'Water') { const h = tileHex(e.p, e.q, i); water.add(keyOf(h.q, h.r)); }
  }
  for (const e of entries) {
    if (!e.rec || !e.sites) continue;
    e.sites.forEach((idx, j) => {
      if (e.rec.sites[j] !== 1 || !(e.rec.owners[j] < 6)) return;
      const f = e.rec.owners[j];
      const tier = e.prov?.siteMirror?.[j]?.state === 1 ? e.prov.siteMirror[j].tier : (e.tiers?.[j] ?? 0);
      const h = tileHex(e.p, e.q, idx);
      if (!seen(h.q, h.r)) return;
      const c = project(h.q, h.r);
      holdings.push({ x: c.x, y: c.y, f, tier });
      if (own?.has(`${e.p},${e.q},${idx}`)) return;
      const rad = ([1, 2, 2, 3][tier] ?? 1) + grow;
      for (let dq = -rad; dq <= rad; dq++) for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad); dr++) {
        const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        const k = keyOf(h.q + dq, h.r + dr);
        if ((d > 0 && water.has(k)) || !seen(h.q + dq, h.r + dr)) continue;
        const cur = owner.get(k);
        if (!cur || d < cur.d) { owner.set(k, { f, d }); hexOf.set(k, { q: h.q + dq, r: h.r + dr }); }
      }
    });
  }
  // close the small pockets a realm leaves (land with at least 4 of its 6 neighbours of one faction), twice
  const land = new Set();
  for (const e of entries) if (e.terrain) for (let i = 0; i < PROVINCE_TILES; i++) { const h = tileHex(e.p, e.q, i); const k = keyOf(h.q, h.r); if (!water.has(k)) { land.add(k); if (!hexOf.has(k)) hexOf.set(k, { q: h.q, r: h.r }); } }
  for (let pass = 0; pass < 2 && grow > 0; pass++) {
    const add = [];
    for (const k of land) {
      if (owner.has(k)) continue;
      const h = hexOf.get(k);
      if (!seen(h.q, h.r)) continue;
      const n = Array(6).fill(0);
      for (const [dq, dr] of EDGE_DIRS) { const o = owner.get(keyOf(h.q + dq, h.r + dr)); if (o) n[o.f]++; }
      const best = n.indexOf(Math.max(...n));
      if (n[best] >= 4) add.push([k, best]);
    }
    for (const [k, f] of add) owner.set(k, { f, d: 9 });
  }
  const fill = [], edge = [];
  for (const [k, o] of owner) {
    const h = hexOf.get(k);
    const c = project(h.q, h.r);
    if (!fill[o.f]) fill[o.f] = new Path2D();
    hexPoints(c.x, c.y, 0).forEach(([x, y], i) => (i ? fill[o.f].lineTo(x, y) : fill[o.f].moveTo(x, y)));
    fill[o.f].closePath();
    for (const [dq, dr] of EDGE_DIRS) {
      const nk = keyOf(h.q + dq, h.r + dr);
      const n = owner.get(nk);
      if (n && n.f === o.f) continue;
      if (!n && water.has(nk)) continue;   // a coast is not a frontier
      const e2 = sharedEdge(c, project(h.q + dq, h.r + dr));
      if (!e2) continue;
      if (!edge[o.f]) edge[o.f] = new Path2D();
      edge[o.f].moveTo(e2[0][0], e2[0][1]); edge[o.f].lineTo(e2[1][0], e2[1][1]);
    }
  }
  return { fill, edge, holdings };
}

export const farRes = pxPerWorld => FAR_RES.find(r => r >= pxPerWorld * 0.85) ?? FAR_RES[FAR_RES.length - 1];
/** How much a far bitmap made for zoom `z` (CSS px per world px) softens its ground: 1 from afar, almost 0 next to the tile view. */
export const farSoftness = z => { const k = Math.max(0, Math.min(1, (0.46 - z) / 0.28)); return 0.08 + 0.92 * k * k * (3 - 2 * k); };
/** Sprite sets by tile radius (px); anchor = the tile centre on the ground plane. */
export const ART_SIZES = Object.freeze([
  { key: '@0.5x', r: 22, w: 44, h: 52, ax: 22, ay: 31 },
  { key: '@1x', r: 44, w: 88, h: 104, ax: 44, ay: 62 },
  { key: '@2x', r: 88, w: 176, h: 208, ax: 88, ay: 124 },
]);
/** World px from the art's ground-plane anchor down to its top face (H 0.24 × cos(asin 0.76) × R). */
export const TOP_LIFT = 0.24 * Math.sqrt(1 - FLATTEN * FLATTEN) * RADIUS;
const TERRAIN_KEY = { Grassland: 'grassland', Plains: 'plains', Forest: 'forest', Hills: 'hills', Mountain: 'mountain', Water: 'water' };
const SITE_LAND = new Set(['grassland', 'plains', 'forest', 'hills']);
/** Faction index 0..5 (CIV_COLORS order) -> sprite name. */
export const ART_FACTIONS = Object.freeze(['ember', 'tide', 'lumen', 'iron', 'stone', 'verdant']);
/** Neighbour across edge k (axial, r grows downward); edge 0 is the upper-left one. */
const EDGE_DIRS = [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]];
/** Strategic-view colours (muted, after Eternum's biome palette and Civ VI's strategic view). */
export const FLAT = Object.freeze({
  grassland: ['#7d9651', '#6d8546'], plains: ['#bfae6c', '#a8985c'], forest: ['#4d6a3b', '#3c5530'],
  hills: ['#8e9a5c', '#737d49'], mountain: ['#8a847a', '#6c675f'], water: ['#467f8c', '#3a6c78'],
});
const GRID_INK = 'rgba(24,34,26,0.32)';
/** A ground bitmap's box around its province's centre (world px): the tiles and their sprites' cells. */
const GROUND_BOX = Object.freeze({ left: 352, right: 352, top: 258, bottom: 252 });
/** A nation's land from afar: how strong its wash is on the world chart and nearer, and its one rim (screen px). */
export const REALM_FAR = Object.freeze({ fill: 0.22, fillNear: 0.18, colour: 3.6, ink: 1.4 });
/** The relief of the tile view: how much wider and taller than its sprite a mountain or a wood is drawn, about a foot `foot` hex radii below its tile's centre, and how dark its cast shadow is. */
export const RISE = Object.freeze({ mountain: Object.freeze({ w: 1.22, h: 1.42, foot: 0.3, shadow: 0.2 }), forest: Object.freeze({ w: 1.06, h: 1.2, foot: 0.34, shadow: 0 }) });
/** Terrain whose props stand tall enough to cover a host on the tile behind. */
const TALL = new Set(['mountain', 'forest']);
const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
/** Holding tiers by the account's TIER byte (0..3). */
export const ART_TIERS = Object.freeze(['hamlet', 'town', 'city', 'stronghold']);
/** Host sprites (1x: 32 x 34, anchor 16,22 on the ground plane) and the six slots around a hex centre (hosts.py). */
const HOST_SIZES = { '@1x': { w: 32, h: 34, ax: 16, ay: 22 }, '@2x': { w: 64, h: 68, ax: 32, ay: 44 } };
const SLOT_ANG = [270, 210, 330, 150, 30, 90].map((d) => (d * Math.PI) / 180);
const SLOT_R = 0.46;
/** Below this on-screen tile radius hosts are chips, not figures (LOD.md, tile S). */
export const HOST_FIGURE_MIN_R = 35;
/** Stance by its plaintext byte (0..3, rules stance.rs); fates 3 bounced, 4 retreated, 5 destroyed read as disarray. */
export const ART_STANCES = Object.freeze(['hold', 'assault', 'flank', 'brace']);
const BROKEN_FATES = new Set([3, 4, 5]);
/** Ring-open moment: 8 dissolve frames of 90 ms, the gold edge glow levels per frame (fog.py). */
const OPEN_FRAME_MS = 90;
const OPEN_GLOW = [null, 0, 1, 2, 2, 3, 3, 3, 2, 1, 0];
const now = () => (globalThis.performance?.now?.() ?? Date.now());
/** Relations (clash.rs): bit a*8+b set = a and b are not hostile (peace, NAP or alliance). */
const peaceful = (rel, a, b) => { try { return ((BigInt(rel ?? 0) >> BigInt((a % 8) * 8 + (b % 8))) & 1n) === 1n; } catch { return false; } };
const roadBit = (mask, i) => { try { return mask !== undefined && mask !== null && ((BigInt(mask) >> BigInt(i)) & 1n) === 1n; } catch { return false; } };

/** Axial hexes from a to b inclusive (cube lerp). */
function hexLine(a, b) {
  const n = Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    const x = a.q + (b.q - a.q) * t + 1e-6, z = a.r + (b.r - a.r) * t + 1e-6, y = -x - z;
    let rx = Math.round(x), rz = Math.round(z), ry = Math.round(y);
    const dx = Math.abs(rx - x), dz = Math.abs(rz - z), dy = Math.abs(ry - y);
    if (dx > dz && dx > dy) rx = -rz - ry; else if (dz > dy) rz = -rx - ry;
    out.push({ q: rx, r: rz });
  }
  return out;
}

/** The edge (0..5) whose direction from (x, y) points closest to (tx, ty). */
function edgeToward(x, y, tx, ty) {
  let best = 3, dot = -Infinity;
  EDGE_DIRS.forEach(([dq, dr], k) => {
    const o = project(dq, dr);
    const d = (o.x * (tx - x) + o.y * (ty - y)) / Math.hypot(o.x, o.y);
    if (d > dot) { dot = d; best = k; }
  });
  return best;
}

export function artSize(r) {
  return ART_SIZES.find((s) => s.r >= r) ?? ART_SIZES[ART_SIZES.length - 1];
}
export const artVariant = (q, r) => 1 + ((((q * 7 + r * 13) % 3) + 3) % 3);
const keyOf = (q, r) => `${q},${r}`;

/** The two corners two neighbouring hexes share (world px), or null. */
function sharedEdge(a, b) {
  const pa = hexPoints(a.x, a.y, 0), pb = hexPoints(b.x, b.y, 0);
  const out = pa.filter(([x, y]) => pb.some(([u, v]) => Math.abs(u - x) < 0.5 && Math.abs(v - y) < 0.5));
  return out.length === 2 ? out : null;
}

export class SpriteArt {
  /** `onLoad`: something still changed (art arrived): repaint all. `onTick`: an animation frame is due. */
  constructor({ onLoad = () => {}, onTick = onLoad, base = BASE } = {}) {
    this.onLoad = onLoad;
    this.onTick = onTick;
    onMiniLoad(onLoad);
    this.base = base;
    this.images = new Map();
    this.outlines = new Map();
    this.thumbs = new Map();
    this.misses = 0;
    this.farCache = new Map();   // "P,Q@res|state" → {cv, x, y, w, h, px}
    this.farLast = new Map();    // "P,Q" → the last bitmap painted for it (shown while a newer one waits)
    this.farPixels = 0;
    this.groundCache = new Map();   // "P,Q@set|state" → {cv, x, y, w, h, px}
    this.groundPixels = 0;
  }

  /** The newest bitmap this province had, at any resolution or state (a stand-in while a new one waits its turn). */
  farStale(e) { return this.farLast.get(`${e.p},${e.q}`) ?? null; }
  /** A ground bitmap of the tile view for this province, of any sprite set and state (the newest), or null. */
  groundStale(e) {
    const pre = `${e.p},${e.q}@`;
    let hit = null;
    for (const [k, v] of this.groundCache) if (k.startsWith(pre)) hit = v;
    return hit;
  }

  /**
   * The far view of one province (world and province LOD): the real tile
   * art — terrain, shores, rivers, roads, forests and peaks, holdings and the
   * factions' territory with its borders — painted once into a bitmap at
   * `res` device px per world px and kept until its holdings change. A
   * bitmap painted while some art was still loading is used but not kept.
   * The cache holds at most FAR_PIXELS pixels (oldest dropped first).
   *
   * With a survey (map/survey.mjs) a province is one of three things. Nothing
   * of it surveyed: a sheet of chart (with the Engine on the Concord's),
   * cheap, painted at once. All of it in sight: the painted bitmap, as ever.
   * Else: the painted bitmap of its surveyed tiles is kept on its own (it
   * changes only when a tile becomes surveyed), and the survey is laid over a
   * copy of it — the muted land out of sight, the chart, the soft edge — so a
   * host that moves repaints no land, only that overlay.
   */
  farKey(e, res, stateKey, sv) {
    const raw = `${e.p},${e.q}@${res}|${!sv ? e.fog : sv.kind === 'mixed' ? `m${sv.sig2}` : sv.kind}|${sv?.kind === 'chart' ? '' : stateKey}`;
    return { raw, key: sv?.kind === 'mixed' ? `${raw}|${sv.sig}` : raw };
  }
  farBitmap(e, { res, dpr = 1, terrainAt, fogAt, alliedPairs = [], stateKey = '', canPaint = () => true, survey = null }) {
    const sv = survey && !survey.showAll && e.fog !== 'unopened' ? survey.province(e.p, e.q) : null;
    const { raw: rk, key: k } = this.farKey(e, res, stateKey, sv);
    const hit = this.farCache.get(k);
    if (hit) { this.farCache.delete(k); this.farCache.set(k, hit); return hit; }
    // painting is costly: within the frame's budget only (the rest next frame, an older bitmap or the flat one meanwhile)
    if (!canPaint() && sv?.kind !== 'chart') return this.farStale(e, res) ?? null;
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
    const c = provincePixel(e.p, e.q);
    const half = PROVINCE_CIRCUMRADIUS * 1.08 + RADIUS * 1.6;
    const size = Math.max(8, Math.ceil(2 * half * res));
    const box = { x: c.x - half, y: c.y - half, w: 2 * half, h: 2 * half };
    const canvas = () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size }));
    const world = g => g.setTransform(res, 0, 0, res, (half - c.x) * res, (half - c.y) * res);
    const keep = (key, v) => {
      v.key = key;
      this.farCache.set(key, v);
      this.farPixels += v.px;
      while (this.farPixels > FAR_PIXELS && this.farCache.size > 1) { const [ok, ov] = this.farCache.entries().next().value; this.farCache.delete(ok); this.farPixels -= ov.px; }
    };
    const sheet = (ink = true) => {
      const cv = canvas(), g = cv.getContext('2d');
      world(g);
      const names = (q, r) => { const n = terrainAt(q, r); return n === 'cloud' ? null : n; };
      paintChart(g, Array.from({ length: PROVINCE_TILES }, (_, i) => { const h = tileHex(e.p, e.q, i), at = project(h.q, h.r); return { q: h.q, r: h.r, x: at.x, y: at.y, name: TERRAIN_KEY[e.names?.[e.terrain?.[i]]] ?? 'plains' }; }), { res, nameAt: names, own: true, ink });
      return { cv, g };
    };
    if (sv?.kind === 'chart') {
      const { cv, g } = sheet();
      const had = this.misses;
      this.misses = 0;
      this.paint(g, [e], { zoom: res, dpr: 1, terrainAt, fogAt, alliedPairs, far: 'props', survey });   // the Engine, where this is the Concord
      const v = { cv, ...box, px: size * size };
      if (this.misses === 0) keep(k, v);
      this.misses += had;
      this.farLast.set(`${e.p},${e.q}`, v);
      return v;
    }
    let rawBitmap = this.farCache.get(rk) ?? null;
    if (!rawBitmap) {
      const cv = canvas();
      const g = cv.getContext('2d');
      world(g);
      this.misses = 0;
      // the ground on its own, softened so the tiles melt into land (no hex mosaic), then the props, holdings and territory sharp on top
      const gcv = canvas();
      const gg = gcv.getContext('2d');
      world(gg);
      this.paint(gg, [e], { zoom: res, dpr: 1, terrainAt, fogAt, alliedPairs, far: 'ground', survey });
      // how soft: a land from afar; toward the near view the softening lets go, so the picture is already
      // close to the tiles when the level of detail changes (no blurred band before the diorama)
      const soft = farSoftness(res / dpr);
      const blur = Math.max(0.6, Math.min(7 * dpr, RADIUS * res * 0.32 * soft));
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(gcv, 0, 0);   // sharp underneath: the province's edge stays solid where it meets the next
      if ('filter' in g && soft > 0.05) { g.filter = `blur(${blur.toFixed(2)}px) saturate(1.08)`; g.globalAlpha = 0.9 * Math.sqrt(soft); g.drawImage(gcv, 0, 0); g.filter = 'none'; g.globalAlpha = 1; }
      g.restore();
      this.paint(g, [e], { zoom: res, dpr: 1, terrainAt, fogAt, alliedPairs, far: 'props', survey });
      rawBitmap = { cv, ...box, px: size * size, whole: this.misses === 0 };
      if (rawBitmap.whole) keep(rk, rawBitmap);
    }
    let v = rawBitmap;
    if (sv?.kind === 'mixed') {
      // the survey over a copy of the painted province
      const cv = canvas(), g = cv.getContext('2d');
      g.drawImage(rawBitmap.cv, 0, 0);
      applySurvey(g, { box, res, survey, sig: sv.sig, chart: sheet().cv, plain: sheet(false).cv });
      v = { cv, ...box, px: size * size };
      if (rawBitmap.whole !== false) keep(k, v);
    }
    this.farLast.set(`${e.p},${e.q}`, v);
    return v;
  }

  /**
   * A sprite: the image once it has loaded. Until then the same sprite of another size that is already
   * here stands in (every size has the same cell, so it is drawn into the same place), and the miss is
   * counted: a picture painted with stand-ins is shown but not kept.
   */
  image(set, size, name) {
    const key = `${set}/${size}/${name}`;
    const have = this.images.get(key);
    if (have?.ok) return have.img;
    this.misses++;
    if (!have && typeof Image !== 'undefined') {
      const img = new Image();
      const rec = { img, ok: false };
      this.images.set(key, rec);
      img.onload = () => { rec.ok = true; this.onLoad(); };
      img.src = new URL(`${key}.webp`, this.base).href;
    }
    for (const o of ART_SIZES) { const other = o.key === size ? null : this.images.get(`${set}/${o.key}/${name}`); if (other?.ok) return other.img; }
    return null;
  }

  /** The province's outline along its tile edges, as segments (world px); cached. */
  outline(p, q) {
    const k = keyOf(p, q);
    if (this.outlines.has(k)) return this.outlines.get(k);
    const segs = [];
    for (let i = 0; i < PROVINCE_TILES; i++) {
      const h = tileHex(p, q, i);
      const a = project(h.q, h.r);
      for (const [dq, dr] of EDGE_DIRS) {
        const n = { q: h.q + dq, r: h.r + dr };
        const at = locate(n.q, n.r);
        if (at.p === p && at.q === q) continue;
        const e = sharedEdge(a, project(n.q, n.r));
        // (for the survey: the higher level of the two tiles the segment lies between)
        if (e) { e.lv = sv => Math.max(sv.levelAt(h.q, h.r), sv.levelAt(n.q, n.r)); segs.push(e); }
      }
    }
    const path = typeof Path2D === 'undefined' ? null : new Path2D();
    const fill = typeof Path2D === 'undefined' ? null : new Path2D();
    if (path) for (const [[x0, y0], [x1, y1]] of segs) { path.moveTo(x0, y0); path.lineTo(x1, y1); }
    if (fill) for (let i = 0; i < PROVINCE_TILES; i++) {
      const h = tileHex(p, q, i);
      const { x, y } = project(h.q, h.r);
      hexPoints(x, y, -0.3).forEach(([px, py], j) => (j ? fill.lineTo(px, py) : fill.moveTo(px, py)));
      fill.closePath();
    }
    const v = { path, fill, segs };
    this.outlines.set(k, v);
    return v;
  }

  /**
   * Boundary (halo, then ink) along the tile edges, plus the fog veil over the tiles. With a survey
   * (`sv` the province's summary) the part of the boundary that runs over the chart is a quiet sepia
   * line, as a chart draws a border; a selected province keeps the whole two-tone line.
   */
  frame(ctx, { p, q, fog, selected, zoom, sv = null, survey = null }) {
    const o = this.outline(p, q);
    if (!o.path) return;
    const a = FOG[fog] ?? 0;
    if (a > 0 && fog !== 'unopened') { ctx.fillStyle = `rgba(233,229,216,${a})`; ctx.fill(o.fill); }
    const ink = selected ? 4 : 1.25;
    let over = o.path, chart = null;
    if (sv && !selected && sv.kind !== 'sight' && typeof Path2D !== 'undefined') {
      if (sv.kind === 'chart') { over = null; chart = o.path; }
      else {
        // which segments have paint on either side (kept until the province's survey changes)
        if (o.parts?.sig !== sv.sig) {
          const on = new Path2D(), off = new Path2D();
          for (const sg of o.segs) { const t = sg.lv(survey) >= L2 ? on : off; t.moveTo(sg[0][0], sg[0][1]); t.lineTo(sg[1][0], sg[1][1]); }
          o.parts = { sig: sv.sig, on, off };
        }
        over = o.parts.on; chart = o.parts.off;
      }
    }
    ctx.lineCap = 'round';
    if (chart) { ctx.strokeStyle = 'rgba(96,80,48,0.5)'; ctx.lineWidth = 1.5 / zoom; ctx.stroke(chart); }
    if (over) {
      // over painted land a border is quiet ink with a breath of pale beside it (it read as a white crack across
      // the diorama); the selected province keeps the whole two-tone line
      const was = ctx.globalAlpha;
      ctx.globalAlpha = was * (selected ? 1 : 0.26); ctx.strokeStyle = BOUNDARY_HALO; ctx.lineWidth = (ink + (selected ? 2 : 1.5)) / zoom; ctx.stroke(over);
      ctx.globalAlpha = was * (selected ? 1 : 0.6); ctx.strokeStyle = BOUNDARY_INK; ctx.lineWidth = ink / zoom; ctx.stroke(over);
      ctx.globalAlpha = was;
    }
    ctx.lineCap = 'butt';
  }

  /** A cached strategic bitmap of a province: flat hexes with small terrain marks. */
  thumb(p, q, t, pxPerWorld) {
    const res = pxPerWorld > 0.3 ? 0.6 : 0.22;
    const k = `${p},${q}@${res}`;
    if (this.thumbs.has(k)) return this.thumbs.get(k);
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
    const c = provincePixel(p, q);
    const half = PROVINCE_CIRCUMRADIUS * 1.12;
    const size = Math.ceil(2 * half * res);
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const g = cv.getContext('2d');
    g.setTransform(res, 0, 0, res, (half - c.x) * res, (half - c.y) * res);
    for (let i = 0; i < PROVINCE_TILES; i++) {
      const h = tileHex(p, q, i);
      const { x, y } = project(h.q, h.r);
      const name = TERRAIN_KEY[t.names?.[t.terrain[i]]] ?? 'plains';
      const [fill, dark] = FLAT[name];
      polygon(g, hexPoints(x, y, -0.4), fill, null);
      g.fillStyle = dark; g.strokeStyle = dark; g.lineWidth = 3;
      if (name === 'forest') for (const [dx, dy] of [[-12, 4], [0, -6], [12, 4]]) { g.beginPath(); g.moveTo(x + dx, y + dy - 9); g.lineTo(x + dx + 7, y + dy + 5); g.lineTo(x + dx - 7, y + dy + 5); g.closePath(); g.fill(); }
      else if (name === 'mountain') { g.beginPath(); g.moveTo(x - 16, y + 9); g.lineTo(x - 2, y - 14); g.lineTo(x + 6, y - 2); g.lineTo(x + 10, y - 8); g.lineTo(x + 20, y + 9); g.closePath(); g.fill(); g.fillStyle = '#e9e6de'; g.beginPath(); g.moveTo(x - 6, y - 7); g.lineTo(x - 2, y - 14); g.lineTo(x + 2, y - 7); g.closePath(); g.fill(); }
      else if (name === 'hills') { g.beginPath(); g.arc(x - 7, y + 6, 9, Math.PI, 0); g.arc(x + 9, y + 7, 7, Math.PI, 0); g.stroke(); }
      else if (name === 'water') { g.beginPath(); g.moveTo(x - 12, y); g.quadraticCurveTo(x - 6, y - 5, x, y); g.quadraticCurveTo(x + 6, y + 5, x + 12, y); g.stroke(); }
      polygon(g, hexPoints(x, y, 0), null, GRID_INK, 1.2 / res);
    }
    const v = { cv, x: c.x - half, y: c.y - half, w: 2 * half, h: 2 * half };
    this.thumbs.set(k, v);
    if (this.thumbs.size > 400) this.thumbs.delete(this.thumbs.keys().next().value);
    return v;
  }

  /** Province/world LOD: a far bitmap per province (the land itself), then the labels a map has. */
  paintFar(ctx, entries, { zoom, dpr = 1, terrainAt, fogAt, alliedPairs = [], recs = new Map(), lod = 'world', lens = 'realm', passing = false, resZoom = zoom, survey = null }) {
    const limited = !!survey && !survey.showAll;
    const svOf = e => (limited && e.fog !== 'unopened' ? survey.province(e.p, e.q) : null);
    // `passing`: the camera is on its way through this zoom: a province that has any bitmap keeps it for now,
    // and what must be painted is painted for `resZoom` (the further of here and where the camera is going)
    const res = farRes(resZoom * dpr);
    const t0 = now(), budget = FAR_BUDGET_MS;
    let deferred = 0;
    let stale = false;
    const canPaint = () => !(passing && stale) && now() - t0 < budget;
    // nearest the centre of the view first, so what the eye is on is painted first
    for (const e of entries.slice().sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0))) {
      const state = e.rec ? `${e.rec.owners.join('')}${e.rec.sites.join('')}` + (e.prov ? (e.prov.siteMirror ?? []).map(m => `${m.state}${m.tier}`).join('') : (e.tiers ?? []).join('')) : '';
      stale = !!this.farStale(e);
      // (the cloud sea is pale from the first frame: while its sprites are on their way the table must not show through as a dark hole)
      if (e.fog === 'unopened') { const o = this.outline(e.p, e.q); if (o?.fill) { ctx.fillStyle = '#dfe4e3'; ctx.fill(o.fill); } }
      const b = this.farBitmap(e, { res, dpr, terrainAt, fogAt, alliedPairs, stateKey: state, canPaint, survey });
      if (!b) {
        deferred++;
        // not painted yet: the tile view's ground of this province when it is at hand (coming out of the tile
        // view it is), else the flat stand-in
        const near = this.groundStale(e);
        if (near) { ctx.imageSmoothingEnabled = true; ctx.drawImage(near.cv, near.x, near.y, near.w, near.h); }
        else if (e.t ?? e.terrain) { const th = this.thumb(e.p, e.q, e.t ?? e, zoom * dpr); if (th) ctx.drawImage(th.cv, th.x, th.y, th.w, th.h); }
        continue;
      }
      if (b.key !== this.farKey(e, res, state, svOf(e)).key) deferred++;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(b.cv, b.x, b.y, b.w, b.h);
    }
    /** How many provinces of the last far view still wait for their bitmap (the map holds a dissolve for them). */
    this.farPending = deferred;
    if (deferred && !this.farTimer) this.farTimer = setTimeout(() => { this.farTimer = null; this.onLoad(); }, 16);
    // province edges only where provinces are the unit of play (faint, never a board grid)
    if (lod === 'province') for (const e of entries) {
      if (e.fog === 'unopened') continue;
      const o = this.outline(e.p, e.q);
      if (!o.path) continue;
      // (on the chart a border is a sepia line)
      ctx.strokeStyle = svOf(e)?.kind === 'chart' ? 'rgba(96,80,48,0.34)' : 'rgba(24,30,26,0.22)'; ctx.lineWidth = 1.4 / zoom; ctx.stroke(o.path);
      // (the selected province: ivory over ink; gold is kept for what is the viewer's own)
      if (e.selected) { ctx.strokeStyle = 'rgba(14,22,20,.7)'; ctx.lineWidth = 5.5 / zoom; ctx.stroke(o.path); ctx.strokeStyle = '#f4efe0'; ctx.lineWidth = 2.6 / zoom; ctx.stroke(o.path); }
    }
    // realms, hosts and free sites: of the land the viewer has surveyed (hosts: of provinces in sight)
    const levelAt = limited ? survey.levelAt : null;
    const own = limited && survey.villages?.length ? new Set(survey.villages.map(v => `${v.p},${v.q},${v.tile}`)) : null;
    if (lens !== 'land') this.paintRealms(ctx, entries, { zoom, lod, lens, levelAt, rev: limited ? survey.rev : 0, own });
    if (lens === 'war') paintWarLens(ctx, limited ? entries.filter(e => svOf(e)?.max === L3) : entries, zoom);
    if (lens === 'settle') paintSettleLens(ctx, entries, zoom, levelAt);
    // a clash this bell: a small crossed-swords mark, at province detail only (the world view stays a map)
    if (lod === 'province') for (const e of entries) {
      // (the mark stands on the province's centre: it is drawn when that tile is in the viewer's sight)
      if (!e.rec?.clash || (limited && (c0 => survey.levelAt(c0.q, c0.r))(provinceCentre(e.p, e.q)) !== L3)) continue;
      const c = provincePixel(e.p, e.q), r = 7 / zoom;
      ctx.save(); ctx.translate(c.x, c.y);
      ctx.fillStyle = 'rgba(120,28,18,.85)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffe2d8'; ctx.lineWidth = 1.6 / zoom; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.5); ctx.lineTo(r * 0.5, r * 0.5); ctx.moveTo(r * 0.5, -r * 0.5); ctx.lineTo(-r * 0.5, r * 0.5); ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The factions' lands over the far view: every held site claims its tile
   * and a radius by tier (as the tile view's territory), computed over all
   * drawn provinces together so a realm reads as one region; a translucent
   * wash, a crisp two-tone border where it meets another realm or the wild,
   * and each holding as a mark in its faction's colour (larger for a city or
   * a stronghold). Cached until the drawn provinces' holdings change.
   */
  paintRealms(ctx, entries, { zoom, lod, lens = 'realm', levelAt = null, rev = 0, own = null }) {
    const key = entries.map(e => (e.rec ? `${e.p},${e.q}:${e.rec.owners.join('')}${e.rec.sites.join('')}${e.prov ? (e.prov.siteMirror ?? []).map(m => m.tier).join('') : (e.tiers ?? []).join('')}` : '')).join('|');
    const rk = `${lod}|${rev}|${key}`;
    if (this.realmKey !== rk) { this.realm = buildRealms(entries, { grow: 1, levelAt, own }); this.realmKey = rk; }
    const R = this.realm;
    if (!R) return;
    ctx.save();
    for (let f = 0; f < 6; f++) {
      if (!R.fill[f]) continue;
      ctx.globalAlpha = (lod === 'world' ? REALM_FAR.fill : REALM_FAR.fillNear) * (lens === 'realm' ? 1 : 0.4); ctx.fillStyle = FACTION_COLORS[f]; ctx.fill(R.fill[f]);
    }
    ctx.globalAlpha = 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let f = 0; f < 6; f++) {
      if (!R.edge[f]) continue;
      // one rim: the nation's colour, and its dark ink in it (the second review: three nested lines read as a blob's crust)
      ctx.globalAlpha = 0.9; ctx.strokeStyle = FACTION_COLORS[f]; ctx.lineWidth = REALM_FAR.colour / zoom; ctx.stroke(R.edge[f]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = FACTION_DARK_INK[f]; ctx.lineWidth = REALM_FAR.ink / zoom; ctx.stroke(R.edge[f]);
    }
    // holdings: a mark per site, white-rimmed (a town is read from afar by its mark, Civ's city banner in miniature)
    const unit = 1 / zoom;
    // province detail: each holding as a small settlement, crisp at any size (roofs in the faction's colour;
    // a town adds a tower, a city and a stronghold their walls), so a settled land reads as settled from afar
    if (lod === 'province') {
      const list = R.holdings.slice().sort((a, b) => a.y - b.y);
      const size = Math.max(RADIUS * 0.7, 15 / zoom);
      for (const h of list) paintSettlement(ctx, h.x, h.y + RADIUS * 0.15, size * (h.tier >= 2 ? 1.25 : 1), h.f, h.tier);
    }
    for (const h of R.holdings) {
      if (lod !== 'world' || h.tier < 1) continue;   // the world view marks towns and up; nearer, the holdings' own art shows
      const r = (h.tier >= 2 ? 4.2 : h.tier === 1 ? 3.2 : 2.4) * unit * (lod === 'world' ? 1 : 1.3);
      ctx.beginPath(); ctx.arc(h.x, h.y, r + 1.2 * unit, 0, Math.PI * 2); ctx.fillStyle = '#fffaf0'; ctx.fill();
      ctx.beginPath(); ctx.arc(h.x, h.y, r, 0, Math.PI * 2); ctx.fillStyle = FACTION_COLORS[h.f]; ctx.fill();
      if (h.tier >= 3) { ctx.lineWidth = 1.2 * unit; ctx.strokeStyle = FACTION_DARK_INK[h.f]; ctx.stroke(); }
    }
    ctx.restore();
  }

  /** Province/world LOD: strategic bitmap, owner tint, boundary, sigil, clash. */
  paintStrategic(ctx, entries, { zoom, dpr = 1 }) {
    for (const e of entries) {
      const th = this.thumb(e.p, e.q, e.t, zoom * dpr);
      if (!th) continue;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(th.cv, th.x, th.y, th.w, th.h);
      const o = this.outline(e.p, e.q);
      const owner = e.rec ? majorityOwner(e.rec) : null;
      if (owner !== null && o.fill) { ctx.globalAlpha = 0.3; ctx.fillStyle = FACTION_COLORS[owner]; ctx.fill(o.fill); ctx.globalAlpha = 1; }
      this.frame(ctx, { p: e.p, q: e.q, fog: e.fog, selected: e.selected, zoom });
      const c = provincePixel(e.p, e.q);
      if (owner !== null) paintSigil(ctx, { x: c.x, y: c.y, r: Math.min(8 / zoom, PROVINCE_CIRCUMRADIUS / 5), faction: owner, scale: zoom });
      if (e.rec?.clash) { ctx.beginPath(); ctx.arc(c.x, c.y, 14 / zoom, 0, Math.PI * 2); ctx.strokeStyle = '#b3402f'; ctx.lineWidth = 3 / zoom; ctx.stroke(); }
    }
  }

  /** An unopened province: parchment with its hex grid only (after Eternum's unexplored hexes). */
  paintUnopened(ctx, entries, { zoom }) {
    for (const e of entries) {
      const o = this.outline(e.p, e.q);
      if (!o.fill) continue;
      ctx.fillStyle = '#e3ddcb'; ctx.fill(o.fill);
      ctx.strokeStyle = 'rgba(90,82,60,0.18)'; ctx.lineWidth = 1 / zoom; ctx.stroke(o.fill);
      ctx.strokeStyle = 'rgba(90,82,60,0.45)'; ctx.lineWidth = 1.25 / zoom; ctx.setLineDash([4 / zoom, 3 / zoom]); ctx.stroke(o.path); ctx.setLineDash([]);
    }
  }

  /**
   * The tiles of a frame: `{tiles (back to front), byHex "q,r", byId "P,Q,idx", byProv "P,Q", owner
   * (territory: "q,r" → {f, d, s: the claiming site's tile}), war, washSig "P,Q" → text, lands}`; each
   * tile carries `wash` ({f, edges, mine} or null: its nation, its border kinds, and whether the site
   * that claims it is one of the viewer's own villages). `lands` are the viewer's own lands
   * (`[{key "P,Q,tile", village, tiles, shape, provisional}]`, map/ownland.mjs paints them). Built once
   * and kept while the same entries, options and map stamp come again (an animation frame builds nothing).
   */
  model(entries, { demoRoads = false, relics = [], waystones = [], demoSpecials = false, rivers = [], demoRivers = false, ringsOpen = null, alliedPairs = [], stamp = undefined, survey = null }) {
    const sig = [stamp, survey, demoRoads, demoSpecials, demoRivers, ringsOpen, alliedPairs.join('|'), relics.length ? relics : 0, waystones.length ? waystones : 0, rivers.length ? rivers : 0];
    for (const e of entries) sig.push(e.p, e.q, e.fog, e.terrain, e.sites, e.names, e.rec, e.prov, e.clash, e.tiers);
    const old = this.modelSig;
    if (old && old.length === sig.length && sig.every((x, i) => x === old[i])) return this.modelNow;
    const allied = new Set(alliedPairs.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
    const calm = (rel, a, b) => peaceful(rel, a, b) || allied.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
    const tiles = [];
    const byHex = new Map(), byId = new Map(), byProv = new Map();
    for (const e of entries) {
      const siteOf = new Map();
      (e.sites ?? []).forEach((idx, j) => siteOf.set(idx, j));
      const pk = `${e.p},${e.q}`, mine = [];
      byProv.set(pk, mine);
      for (let i = 0; i < PROVINCE_TILES; i++) {
        const h = tileHex(e.p, e.q, i);
        const { x, y } = project(h.q, h.r);
        const cloud = e.fog === 'unopened';
        const name = cloud ? 'cloud' : TERRAIN_KEY[e.names?.[e.terrain[i]]] ?? 'plains';
        // the survey (map/survey.mjs): what is not surveyed is terrain and nothing else (no site, village, camp or
        // shield reaches any painter, tag or tip); what is surveyed but out of sight keeps its villages only
        const lv = cloud ? 0 : survey ? survey.levelAt(h.q, h.r) : L3;
        const j = lv >= L2 ? siteOf.get(i) : undefined;
        const m = j === undefined ? null : e.prov?.siteMirror?.[j] ?? null;
        const t = { q: h.q, r: h.r, x, y, name, cloud, lv, fog: cloud ? e.fog : survey?.showAll || !survey ? e.fog : FOG_OF_LEVEL[lv], v: artVariant(h.q, h.r), p: e.p, pq: e.q, pk, idx: i, site: j,
          state: j === undefined ? undefined : m ? (m.state === 3 ? 5 : m.state === 4 ? 0 : m.state) : e.rec?.sites?.[j],
          owner: j === undefined ? undefined : m ? m.faction : e.rec?.owners?.[j],
          tier: m && m.state === 1 ? m.tier : (j !== undefined ? e.tiers?.[j] ?? 0 : 0), walls: !!(m && m.wallsCommitted > 0),
          // (the garrison is told where the village is in the viewer's sight: whole troops, as the inspector says it)
          garrison: lv === L3 && m && m.state === 1 && m.garrison !== undefined ? Math.floor(Number(m.garrison) / 1000) : null,
          camp: !!(lv === L3 && e.prov?.camp?.state === 1 && e.prov.camp.tile === i && j === undefined),
          shield: !!(lv === L3 && m && m.shieldUntilBell > 0 && m.shieldUntilBell !== 0xffffffff && m.shieldUntilBell >= (e.prov?.resolvedNext ?? 0)) };
        t.road = lv >= L2 && SITE_LAND.has(name) && roadBit(e.prov?.roadMask, i);
        t.res = e.prov?.resource?.[i] ?? 0;
        t.ring = ringOf(e.p, e.q);
        t.rel = e.prov?.relations ?? 0;
        const pc = provinceCentre(e.p, e.q);
        t.centre = h.q === pc.q && h.r === pc.r;
        tiles.push(t);
        mine.push(t);
        byHex.set(keyOf(h.q, h.r), t);
        byId.set(`${pk},${i}`, t);
      }
    }
    // preview only (?roads=1): a sample road from every held site to its nearest other site, when the account has none
    if (demoRoads) for (const e of entries) {
      if (!e.prov || BigInt(e.prov.roadMask ?? 0) !== 0n) continue;
      const mine = (byProv.get(`${e.p},${e.q}`) ?? []).filter((t) => t.site !== undefined);
      for (const a of mine.filter((t) => t.state === 1)) {
        const b = mine.filter((t) => t !== a).sort((u, v) => Math.hypot(u.x - a.x, u.y - a.y) - Math.hypot(v.x - a.x, v.y - a.y))[0];
        if (b) for (const h of hexLine(a, b)) { const t = byHex.get(keyOf(h.q, h.r)); if (t && SITE_LAND.has(t.name)) t.road = true; }
      }
    }
    // Relic Sites and Waystones: from the page ({p, q, tile, holder|faction}); none in M1, so the
    // preview (?relics=1) places samples: one Relic Site per wedge on the outermost open ring, and a
    // Waystone next to every town-or-larger holding.
    const at = (p, q, idx) => byId.get(`${p},${q},${idx}`);
    for (const r of relics) { const t = at(r.p, r.q, r.tile); if (t) t.relic = { holder: r.holder ?? null }; }
    for (const w of waystones) { const t = at(w.p, w.q, w.tile); if (t) t.waystone = { faction: w.faction }; }
    if (demoSpecials) {
      // the same province each time: per wedge, the first province of the outermost open ring
      const outer = Math.max(1, (ringsOpen ?? 2) - 1);
      const pick = new Map();
      for (const pr of ringProvinces(outer)) { const w = wedgeOf(pr.p, pr.q); if (w !== null && !pick.has(w)) pick.set(w, `${pr.p},${pr.q}`); }
      for (const e of entries) {
        const w = wedgeOf(e.p, e.q);
        if (e.fog === 'unopened' || w === null || pick.get(w) !== `${e.p},${e.q}`) continue;
        const pc = provinceCentre(e.p, e.q);
        const cand = (byProv.get(`${e.p},${e.q}`) ?? []).filter((u) => u.site === undefined && SITE_LAND.has(u.name) && !u.centre)
          .sort((a, b) => Math.hypot(a.q - pc.q - 2, a.r - pc.r + 1) - Math.hypot(b.q - pc.q - 2, b.r - pc.r + 1))[0];
        if (!cand) continue;
        cand.relic = { holder: w % 2 ? w : null };
      }
      for (const t of tiles) {
        if (t.state !== 1 || !(t.owner < 6) || (t.tier ?? 0) < 1) continue;
        for (const [dq, dr] of [EDGE_DIRS[3], EDGE_DIRS[4], EDGE_DIRS[2], EDGE_DIRS[5], EDGE_DIRS[1], EDGE_DIRS[0]]) {
          const n = byHex.get(keyOf(t.q + dq, t.r + dr));
          if (n && n.site === undefined && SITE_LAND.has(n.name) && !n.relic) { n.waystone = { faction: t.owner }; break; }
        }
      }
    }
    // Rivers: tiles from the page ({p, q, tile}; none in M1), or preview samples (?rivers=1): in each
    // province with water, from its first hills/mountain tile to the nearest water, avoiding sites.
    const river = new Set();
    for (const r of rivers) { const t = at(r.p, r.q, r.tile); if (t && SITE_LAND.has(t.name) && t.site === undefined) river.add(t); }
    if (demoRivers) for (const e of entries) {
      if (e.fog === 'unopened') continue;
      const mine = byProv.get(`${e.p},${e.q}`) ?? [];
      const seas = mine.filter((u) => u.name === 'water');
      if (!seas.length) continue;
      const rank = { mountain: 0, hills: 1, forest: 2, grassland: 3, plains: 3 };
      const starts = mine.filter((u) => u.name !== 'water').sort((a, b) => (rank[a.name] - rank[b.name]) || (a.idx - b.idx));
      for (const src of starts.slice(0, 12)) {
        const sea = seas.slice().sort((a, b) => Math.hypot(a.x - src.x, a.y - src.y) - Math.hypot(b.x - src.x, b.y - src.y))[0];
        const path = hexLine(src, sea).map((h) => byHex.get(keyOf(h.q, h.r))).filter(Boolean);
        const land = path.filter((u) => SITE_LAND.has(u.name));
        if (land.length < 3 || path.some((u) => u.site !== undefined || u.camp || u.centre)) continue;
        for (const u of land) river.add(u);
        break;
      }
    }
    for (const t of river) {
      let mask = 0;
      EDGE_DIRS.forEach(([dq, dr], k) => { const n = byHex.get(keyOf(t.q + dq, t.r + dr)); if (n && river.has(n)) mask |= 1 << k; });
      // a river end next to water flows into it (one mouth)
      if ([0, 1, 2, 3, 4, 5].filter((k) => mask >> k & 1).length <= 1) {
        const k = EDGE_DIRS.findIndex(([dq, dr]) => byHex.get(keyOf(t.q + dq, t.r + dr))?.name === 'water');
        if (k >= 0) { mask |= 1 << k; t.mouth = k; }
      }
      if (mask) t.river = mask;
    }
    tiles.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const list of byProv.values()) list.sort((a, b) => a.y - b.y || a.x - b.x);   // back to front within a province too
    // the rim of the surveyed land: chart tiles next to it lie under the paint that bleeds out over the ink
    if (survey && !survey.showAll) for (const t of tiles) t.fringe = t.lv === 1 && EDGE_DIRS.some(([dq, dr]) => survey.levelAt(t.q + dq, t.r + dr) >= L2);
    // territory: a held site owns itself and its ring-1 tiles (a hamlet's worked radius); nearer site wins
    const owner = new Map();
    for (const t of tiles) {
      if (t.cloud || t.state !== 1 || !(t.owner < 6)) continue;
      const rad = [1, 2, 2, 3][t.tier] ?? 1;
      for (let dq = -rad; dq <= rad; dq++) for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad); dr++) {
        const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        const key = keyOf(t.q + dq, t.r + dr);
        const nb = byHex.get(key);
        if (!nb || nb.cloud || nb.lv < L2 || (d > 0 && nb.name === 'water')) continue;
        const cur = owner.get(key);
        if (!cur || d < cur.d) owner.set(key, { f: t.owner, d, s: t, q: t.q + dq, r: t.r + dr });
      }
    }
    // the viewer's own villages: the land each of them claims (map/ownland.mjs), told from a nation-mate's by the claiming site
    const mine = new Map();
    if (survey && !survey.showAll) for (const v of survey.villages ?? []) { const t = byId.get(`${v.p},${v.q},${v.tile}`); if (t && t.state === 1) mine.set(t, { key: `${v.p},${v.q},${v.tile}`, village: v, tiles: [], provisional: v.state === 1 }); }
    if (mine.size) for (const o of owner.values()) mine.get(o.s)?.tiles.push({ q: o.q, r: o.r, d: o.d });
    // the viewer's own villages are the heroes of the picture (map/plates.mjs HERO): drawn larger, their hosts in front of them
    for (const [t, x] of mine) { t.hero = true; t.provisional = x.provisional; }
    const lands = [...mine.values()].map(x => ({ ...x, shape: landShape(x.tiles) }));
    const viewer = survey && !survey.showAll && Number.isInteger(survey.faction) ? survey.faction : null;
    const war = new Set();
    for (const e of entries) {
      const fs = new Set((e.clash?.arrivals ?? []).filter((a) => a.present && a.faction < 6).map((a) => a.faction));
      if (!fs.size) continue;
      for (const t of byProv.get(`${e.p},${e.q}`) ?? []) if (t.state === 1 && t.owner < 6) fs.add(t.owner);
      const list = [...fs];
      for (const a of list) for (const b of list) if (a < b && !calm(e.prov?.relations, a, b)) war.add(`${e.p},${e.q}:${a}-${b}`);
    }
    // territory as it is drawn: per tile the nation and the kind of border on each edge; per province a
    // signature of it (a province's ground bitmap is kept until this changes)
    const washSig = new Map();
    for (const [pk, list] of byProv) {
      let text = viewer === null ? '' : `v${viewer}`;
      for (const t of list) {
        const o = t.cloud ? undefined : owner.get(keyOf(t.q, t.r));
        const f = o?.f;
        if (f === undefined) { t.wash = null; text += '-'; continue; }
        const edges = EDGE_DIRS.map(([dq, dr]) => {
          const g2 = owner.get(keyOf(t.q + dq, t.r + dr))?.f;
          return g2 === f ? null : g2 === undefined ? 'own' : calm(t.rel, f, g2) ? 'ally' : war.has(`${t.p},${t.pq}:${Math.min(f, g2)}-${Math.max(f, g2)}`) ? 'war' : 'own';
        });
        t.wash = { f, edges, mine: mine.has(o.s), quiet: viewer !== null && f !== viewer };
        text += (t.wash.mine ? 'm' : '') + f + edges.map(e => (e ? e[0] : '=')).join('');
      }
      washSig.set(pk, text);
    }
    this.modelSig = sig;
    this.modelNow = { tiles, byHex, byId, byProv, owner, war, washSig, lands };
    return this.modelNow;
  }

  /**
   * Tile LOD: the tiles of every entry {p, q, terrain, names, sites, rec, fog, selected} together.
   * An entry with fog 'unopened' (no terrain) is drawn as cloud sea.
   * `part` paints one part of the picture: 'ground' (land, shores, roads, grid, territory), 'props'
   * (what stands on the land), 'live' (hosts, people, moments, battles, fog, frames, the selection) or
   * 'world' (those three in order); null paints the world and then its labels (labels()).
   * `between(ctx)` is called after the ground and before the props (ground-level effects).
   * `stamp` (the map's change counter) lets the tile model be kept between animation frames.
   * `sea`: the caller paints the cloud sea itself (map/cloudsea.mjs): cloud tiles carry no sprite here.
   */
  paint(ctx, entries, { zoom, dpr = 1, artZoom = zoom, terrainAt = () => null, fogAt = () => null, selected = null, viewerFaction = null, demoRoads = false,
    ringsOpen = null, replayRing = null, replayEvery = 6000, engineStage = 0,
    relics = [], waystones = [], demoSpecials = false, rivers = [], demoRivers = false, alliedPairs = [], people = null, far = false,
    part = null, between = null, stamp = undefined, survey = null, sea = false, up = null }) {
    // the sprite set of the nearer of the picture and where the camera is going (no change of set at the end of a flight)
    const s = artSize(RADIUS * Math.max(zoom, artZoom) * dpr);
    // the ring-open moment starts when the open ring count grows (or, in the preview, on a timer)
    const t0 = now();
    if (ringsOpen !== null && this.lastRings !== undefined && ringsOpen > this.lastRings) this.opening = { ring: ringsOpen - 1, at: t0 };
    if (ringsOpen !== null) this.lastRings = ringsOpen;
    if (replayRing !== null && (!this.opening || t0 - this.opening.at > replayEvery)) this.opening = { ring: replayRing, at: t0 };
    // preload every frame of the moment for this size so none is skipped on the first play
    if (this.opening && this.opening.preloaded !== s.key) {
      for (let f = 0; f < 8; f++) this.image('fog', s.key, `cloud_1_open_${f}`);
      for (let k = 0; k < 6; k++) for (let l = 0; l < 4; l++) this.image('fog', s.key, `ringglow_${k}_${l}`);
      this.opening.preloaded = s.key;
    }
    const openFrame = this.opening ? Math.floor((t0 - this.opening.at) / OPEN_FRAME_MS) : Infinity;
    const opening = this.opening && openFrame < OPEN_GLOW.length ? this.opening.ring : null;
    const k = RADIUS / s.r;
    const { tiles, byHex, byId, byProv, washSig } = this.model(entries, { demoRoads, relics, waystones, demoSpecials, rivers, demoRivers, ringsOpen, alliedPairs, stamp, survey });
    const nameAt = (q, r) => byHex.get(keyOf(q, r))?.name ?? terrainAt(q, r);
    // the survey of this frame: a province's kind and signature, and what of a tile is painted
    const svOf = (e) => (survey && e.fog !== 'unopened' ? survey.province(e.p, e.q) : null);
    const painted = (t) => t.lv >= L2 || t.fringe;
    const chartName = (q, r) => { const n = nameAt(q, r); return n === 'cloud' ? null : n; };
    // every sprite goes to `g`: the canvas, a province's ground bitmap, or a host's scratch when a prop covers it
    let g = ctx;
    const draw = (img, t) => g.drawImage(img, t.x - s.ax * k, t.y - s.ay * k + TOP_LIFT, s.w * k, s.h * k);
    // what stands on surveyed land out of sight is muted (the far bitmap is muted whole, afterwards: farBitmap)
    // what stands on a tile stands upright on the tilted board (map/tilt.mjs standing): about the tile's middle, through `up`
    const raise = (x, y, fn) => (up && !far ? standing(g, up(x, y), x, y, fn) : fn());
    const stand = (img, t) => raise(t.x, t.y, () => draw(t.lv === L2 && !far ? mutedSprite(img) : img, t));
    const nearCentre = (t) => { const pc = provinceCentre(t.p, t.pq); return Math.max(Math.abs(t.q - pc.q), Math.abs(t.r - pc.r), Math.abs(t.q + t.r - pc.q - pc.r)) <= 1; };
    const siteGround = (t) => t.site !== undefined && SITE_LAND.has(t.name);
    // the still ground of one tile: its sprite, the Concord's paving, shores and beaches, roads
    const groundOf = (t) => {
      const img = t.river ? this.image('rivers', s.key, `${t.name}_${String(t.river).padStart(2, '0')}`)
        : this.image(siteGround(t) ? 'sites' : 'terrain', s.key, `${t.name}_${t.v}`);
      if (!img) { polygon(g, hexPoints(t.x, t.y, 0), FLAT[t.name][0], null); return; }
      draw(img, t);
      if (t.ring === 0 && t.name !== 'water' && t.name !== 'mountain') { const pv = this.image('specials', s.key, 'concord_paving'); if (pv) draw(pv, t); }
      EDGE_DIRS.forEach(([dq, dr], e) => {
        const nb = nameAt(t.q + dq, t.r + dr);
        if (!nb || nb === 'cloud') return;
        if (t.name === 'water' && nb !== 'water') {
          const o = this.image('overlays', s.key, `shore_${e}`); if (o) draw(o, t);
          const rt = byHex.get(keyOf(t.q + dq, t.r + dr));
          if (rt?.river && (rt.river >> ((e + 3) % 6) & 1)) { const m = this.image('overlays', s.key, `mouth_${e}`); if (m) draw(m, t); }
        }
        else if (t.name !== 'water' && nb === 'water') { const o = this.image('overlays', s.key, `beach_${e}`); if (o) draw(o, t); }
      });
      if (t.road && !t.river) {
        const pre = `${t.name}_${t.v}`;
        EDGE_DIRS.forEach(([dq, dr], e) => {
          const nb = byHex.get(keyOf(t.q + dq, t.r + dr));
          if (nb?.road) { const o = this.image('roads', s.key, `${pre}_${e}`); if (o) draw(o, t); }
        });
        const c = this.image('roads', s.key, `${pre}_c`); if (c) draw(c, t);
      }
    };
    // territory over the ground of one tile: the nation's wash, and its border where the realm ends
    const washOf = (t) => {
      const w = t.wash;
      // the viewer's own land is painted over the ground, alive (map/ownland.mjs); a nation-mate's keeps the
      // nation's quiet wash; another nation's is quieter still (UX brief §5.1)
      if (!w || w.mine) return;
      if (w.quiet) g.globalAlpha = OTHER_WASH;
      const o = this.image('factions', s.key, `wash_${ART_FACTIONS[w.f]}`); if (o) draw(o, t);
      if (w.quiet) g.globalAlpha = OTHER_BORDER;
      w.edges.forEach((style, e) => { if (style) { const b = this.image('factions', s.key, `border_${ART_FACTIONS[w.f]}_${e}_${style}`); if (b) draw(b, t); } });
      if (w.quiet) g.globalAlpha = 1;
    };
    const gridOf = (list) => {
      g.beginPath();
      for (const t of list) if (!t.cloud) hexPoints(t.x, t.y, 0).forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.strokeStyle = GRID_INK; g.lineWidth = GRID_WORLD; g.stroke();
    };
    const has = (name) => part === null || part === name || part === 'world';
    if (has('ground') && far !== 'props') {
      // pass 1: ground and flat overlays (a far bitmap paints them on their own, then softens them: farBitmap)
      const baked = new Set();
      if (!far) {
        // tile view: a province's still ground comes from its bitmap when there is one (north first: a tile's
        // skirt is covered by the tiles in front of it); a few new bitmaps a frame, the rest drawn tile by tile
        let bakes = GROUND_BAKES, charts = 8;
        const bake = (e, list) => {
          const sv = svOf(e), chartOnly = sv?.kind === 'chart';
          const key = `${e.p},${e.q}@${s.key}|${e.prov?.roadMask ?? ''}|${ringsOpen ?? ''}|${washSig.get(`${e.p},${e.q}`) ?? ''}|${sv?.sig ?? ''}`;
          const hit = this.groundCache.get(key);
          if (hit) { this.groundCache.delete(key); this.groundCache.set(key, hit); return hit; }
          // (a sheet of chart is cheap: it does not wait for its turn as painted ground does)
          if (bakes <= 0 && !(chartOnly && charts > 0)) return null;
          const c = provincePixel(e.p, e.q), res = s.r / RADIUS, B = GROUND_BOX;
          const cv = spare(Math.ceil((B.left + B.right) * res), Math.ceil((B.top + B.bottom) * res)), gg = cv?.getContext?.('2d');
          if (!gg) return null;
          if (chartOnly) charts--; else bakes--;
          gg.setTransform(res, 0, 0, res, (B.left - c.x) * res, (B.top - c.y) * res);
          const box = { x: c.x - B.left, y: c.y - B.top, w: B.left + B.right, h: B.top + B.bottom };
          if (chartOnly) {
            // nothing of this province is surveyed: its ground is the chart
            paintChart(gg, list, { res, nameAt: chartName, own: true });
            const v = { cv, x: box.x, y: box.y, w: box.w, h: box.h, px: cv.width * cv.height };
            this.groundCache.set(key, v);
            this.groundPixels += v.px;
            while (this.groundPixels > GROUND_PIXELS && this.groundCache.size > 1) { const [ok, ov] = this.groundCache.entries().next().value; this.groundCache.delete(ok); this.groundPixels -= ov.px; }
            return v;
          }
          const had = this.misses;
          this.misses = 0;
          g = gg;
          for (const t of list) if (painted(t)) groundOf(t);
          // a skirt that hangs over a tile of the next province belongs under that tile: cut it away (the
          // neighbour's own bitmap has the tile), a hair inside the hex so no seam opens between the two;
          // then the territory and the grid, which stay inside this province's own hexes
          gg.globalCompositeOperation = 'destination-out'; gg.fillStyle = '#000'; gg.beginPath();
          for (const t of list) for (const [dq, dr] of [EDGE_DIRS[2], EDGE_DIRS[3]]) {
            const nq = t.q + dq, nr = t.r + dr, nb = byHex.get(keyOf(nq, nr));
            // the tile in front: this province's own (drawn here), cloud or no land (the skirt shows), or the next province's land
            if (nb ? nb.pk === t.pk || nb.cloud : !terrainAt(nq, nr)) continue;
            const at = project(nq, nr);
            hexPoints(at.x, at.y, 0.8).forEach(([px, py], j) => (j ? gg.lineTo(px, py) : gg.moveTo(px, py)));
            gg.closePath();
          }
          gg.fill(); gg.globalCompositeOperation = 'source-over';
          for (const t of list) washOf(t);
          gridOf(list.filter(painted));
          g = ctx;
          // the survey over the paint: the muted land out of sight, the chart over what is not surveyed, the soft edge
          if (sv?.kind === 'mixed') {
            const sheet = spare(cv.width, cv.height), sg = sheet?.getContext?.('2d');
            if (sg) {
              sg.setTransform(res, 0, 0, res, (B.left - c.x) * res, (B.top - c.y) * res);
              paintChart(sg, list, { res, nameAt: chartName, own: true });
              // (the same sheet without its ink: the chart is quiet next to painted land)
              const bare = spare(cv.width, cv.height), bg = bare?.getContext?.('2d');
              if (bg) { bg.setTransform(res, 0, 0, res, (B.left - c.x) * res, (B.top - c.y) * res); paintChart(bg, list, { res, nameAt: chartName, own: true, ink: false }); }
              applySurvey(gg, { box, res, survey, sig: sv.sig, chart: sheet, plain: bg ? bare : null });
            }
          }
          const whole = this.misses === 0;
          this.misses += had;
          const v = { cv, x: c.x - B.left, y: c.y - B.top, w: B.left + B.right, h: B.top + B.bottom, px: cv.width * cv.height };
          if (whole) {
            this.groundCache.set(key, v);
            this.groundPixels += v.px;
            while (this.groundPixels > GROUND_PIXELS && this.groundCache.size > 1) { const [ok, ov] = this.groundCache.entries().next().value; this.groundCache.delete(ok); this.groundPixels -= ov.px; }
          }
          return v;
        };
        const bare = demoRoads || demoRivers || rivers.length > 0;   // preview roads and rivers change with the holdings: no bitmap
        if (!bare) for (const e of entries.slice().sort((a, b) => provincePixel(a.p, a.q).y - provincePixel(b.p, b.q).y)) {
          if (e.fog === 'unopened' || !e.terrain) continue;
          const pk = `${e.p},${e.q}`, v = bake(e, byProv.get(pk) ?? []);
          if (!v) continue;
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(v.cv, v.x, v.y, v.w, v.h);
          baked.add(pk);
        }
      }
      const rest = baked.size ? tiles.filter(t => !baked.has(t.pk)) : tiles;
      for (const t of rest) if (!t.cloud && painted(t)) groundOf(t);
      for (const t of rest) washOf(t);
      // the hex grid, exactly on the game's hexes, under the props (not in the far view: land, not a board)
      if (!far) gridOf(rest.filter(painted));
      // land that waits for its bitmap: what is not surveyed is chart from the first frame (its soft edge comes with the bitmap)
      if (!far && survey && !survey.showAll) { const sheet = rest.filter(t => !t.cloud && t.lv < L2); if (sheet.length) paintChart(ctx, sheet, { res: s.r / RADIUS, nameAt: chartName }); }
      if (!far) between?.(ctx);
    }
    if (far === 'ground' || part === 'ground') return tiles.length;
    // what stands on one tile: cloud sea, the Engine, a Seat, relics, the terrain's props, a camp, a holding
    const propsOf = (t) => {
      if (t.cloud) {
        // (`sea`: the map paints the cloud sea as one body over the tiles: map/cloudsea.mjs; no stamp per hex)
        if (sea) return;
        const c = this.image('fog', s.key, `cloud_${t.v}`);
        if (c) draw(c, t);
        EDGE_DIRS.forEach(([dq, dr], e) => {
          const nb = byHex.get(keyOf(t.q + dq, t.r + dr));
          const open = nb ? !nb.cloud : fogAt(t.q + dq, t.r + dr) !== 'unopened';
          if (!open) return;
          const b = this.image('fog', s.key, `bank_${e}`); if (b) draw(b, t);
        });
        return;
      }
      const paved = t.ring === 0 && t.name !== 'water' && t.name !== 'mountain';
      // the Engine stands over the Concord's centre and its six neighbours
      if (t.centre && t.ring === 0) {
        const es = ART_SIZES[Math.min(ART_SIZES.length - 1, ART_SIZES.indexOf(s) + 1)], kk = RADIUS / es.r, m = 2.4;
        const stage = Math.max(0, Math.min(5, engineStage | 0));
        const en = this.image('specials', es.key, `engine_${stage}`);
        // (stage 0 is a ring of markers lying on the ground; a raised Engine stands)
        if (en) (stage > 0 ? raise : (x, y, fn) => fn())(t.x, t.y, () => g.drawImage(en, t.x - es.ax * kk * m, t.y - es.ay * kk * m + TOP_LIFT * m, es.w * kk * m, es.h * kk * m));
        // the bell's tower stands inside the ring of markers until the Engine itself is raised (map/belltower.mjs): the chart's one landmark
        if (stage === 0) {
          const tw = towerSprite(RADIUS * zoom * dpr);
          raise(t.x, t.y, () => {
            if (tw) { const was = g.imageSmoothingEnabled; g.imageSmoothingEnabled = true; g.drawImage(tw.cv, t.x - tw.ox * RADIUS, t.y - tw.oy * RADIUS, tw.w * RADIUS, tw.h * RADIUS); g.imageSmoothingEnabled = was; }
            else paintBellTower(g, t.x, t.y, RADIUS);
          });
        }
        return;
      }
      // the chart carries nothing that stands: the Engine above is its one landmark (everyone hears the bell)
      // (a ring that has just opened still sheds its cloud: the chart comes out from under it)
      if (t.lv < L2) { if (opening !== null && t.ring === opening && openFrame < 8) { const c = this.image('fog', s.key, `cloud_1_open_${openFrame}`); if (c) draw(c, t); } return; }
      if (t.ring === 0 && nearCentre(t)) return;
      // a Seat's camp spreads over its province's centre and six neighbours
      if (t.centre && t.ring === 1) {
        const es = ART_SIZES[Math.min(ART_SIZES.length - 1, ART_SIZES.indexOf(s) + 1)], kk = RADIUS / es.r, m = 1.8;
        const st0 = this.image('specials', es.key, `seat_${ART_FACTIONS[wedgeOf(t.p, t.pq)] ?? 'ember'}`), st = st0 && t.lv === L2 && !far ? mutedSprite(st0) : st0;
        if (st) raise(t.x, t.y, () => g.drawImage(st, t.x - es.ax * kk * m, t.y - es.ay * kk * m + TOP_LIFT * m, es.w * kk * m, es.h * kk * m));
        return;
      }
      if (t.ring === 1 && nearCentre(t)) return;
      if (t.relic) {
        const f = t.relic.holder;
        const img = this.image('specials', s.key, f === null || f === undefined ? 'relic_open' : `relic_${ART_FACTIONS[f]}`);
        if (img) stand(img, t);
        return;
      }
      if (t.waystone) { const img = this.image('specials', s.key, `waystone_${ART_FACTIONS[t.waystone.faction] ?? 'ember'}`); if (img) stand(img, t); return; }
      const decor = ((t.q * 5 + t.r * 11) % 3 + 3) % 3 === 0;
      const pr = paved ? (t.site === undefined && decor ? this.image('specials', s.key, `concord_plaza_${1 + (t.v % 2)}`) : null)
        : t.river ? this.image('rivers_props', s.key, `${t.name}_${String(t.river).padStart(2, '0')}`)
        : this.image(siteGround(t) ? 'sites_props' : 'props', s.key, `${t.name}_${t.v}`);
      // (the Concord's paving and what floats on water lie in the plane)
      if (pr) {
        if (paved || t.name === 'water') draw(t.lv === L2 && !far ? mutedSprite(pr) : pr, t);
        else if (!far && (t.name === 'mountain' || t.name === 'forest') && !t.river) risen(pr, t);
        else stand(pr, t);
      }
      if (opening !== null && t.ring === opening && openFrame < 8) { const c = this.image('fog', s.key, `cloud_1_open_${openFrame}`); if (c) draw(c, t); }
      if (t.camp) { const c = this.image('specials', s.key, 'barbarian_1'); if (c) stand(c, t); }
      if (t.site === undefined) return;
      let img = null;
      if (t.state === 1 && t.owner < 6) {
        // a village is drawn by code at the size the screen asks for (map/village.mjs): never a stretched sprite.
        // (the far bitmaps keep the baked art: there a village is a few px; the viewer's own are drawn last, `heroes`)
        if (!far) { if (!t.hero || g !== ctx) villageOf(t); return shieldOf(t); }
        const tier = ART_TIERS[t.tier] ?? 'hamlet';
        img = this.image('holdings', s.key, `${tier}_${tier === 'stronghold' || t.walls ? 'w' : 'o'}_${ART_FACTIONS[t.owner]}`);
      } else if (t.state === 2) img = this.image('specials', s.key, 'barbarian_1');
      else if (t.state === 5) img = this.image('specials', s.key, 'freecity_town');
      else if (SITE_LAND.has(t.name)) img = this.image('holdings', s.key, 'site');
      if (img) stand(img, t);
      shieldOf(t);
    };
    // a mountain and a wood are the relief of the board: drawn larger than their tile's sprite about their foot, with
    // a shadow cast on the ground toward the lower right (the light of every prop comes from the upper left)
    const risen = (img, t) => {
      const M = RISE[t.name], fy = t.y + RADIUS * M.foot, pic = t.lv === L2 ? mutedSprite(img) : img;
      if (M.shadow && g.ellipse) {
        g.save(); g.translate(t.x, fy); g.rotate(0.3);
        g.fillStyle = `rgba(26,22,14,${M.shadow})`; g.beginPath(); g.ellipse(RADIUS * 0.58, RADIUS * 0.02, RADIUS * 0.92, RADIUS * 0.3, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = `rgba(26,22,14,${M.shadow * 0.8})`; g.beginPath(); g.ellipse(RADIUS * 0.36, 0, RADIUS * 0.6, RADIUS * 0.2, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      raise(t.x, fy, () => { g.save(); g.translate(t.x, fy); g.scale(M.w, M.h); g.translate(-t.x, -fy); draw(pic, t); g.restore(); });
    };
    const shieldOf = (t) => { if (t.shield) { const d = this.image('holdings', s.key, 'shield'); if (d) stand(d, t); } };
    // a village: its picture for this size on screen (the tilt draws the near rows larger: the picture is made for that)
    const villageOf = (t) => {
      const pl = villagePlace(t), U = RADIUS * pl.scale, cx = t.x + pl.x, cy = t.y + pl.y;
      const v = villageSprite(U * Math.max(zoom, artZoom) * dpr, { tier: t.tier ?? 0, faction: t.owner, walls: !!t.walls, variant: ((t.q * 7 + t.r * 13) & 1) });
      if (!v) return;
      const pic = t.lv === L2 ? mutedSprite(v.cv) : v.cv;
      raise(cx, cy, () => { const was = g.imageSmoothingEnabled; g.imageSmoothingEnabled = true; g.drawImage(pic, cx - v.ox * U, cy - v.oy * U, v.w * U, v.h * U); g.imageSmoothingEnabled = was; });
    };
    // pass 2: props, holdings, cloud sea
    if (has('props')) { for (const t of tiles) propsOf(t); for (const t of tiles) if (t.hero && !t.cloud && t.state === 1 && t.owner < 6 && t.lv >= L2 && !far) villageOf(t); }
    // the far view's bitmap stops here: land, props, holdings, territory (map/sprites.mjs farBitmap)
    if (far || part === 'props') return tiles.length;
    fxOver(ctx, { zoom, tiles });   // idle life over the props, under the hosts: cloud shadows, chimney smoke (fx/idle.mjs)
    // pass 2b: hosts on their tiles, back to front (hidden under fog unless the viewer's own)
    const hosts = [], tokens = [], pills = [];
    this.tokens = tokens; this.tokensMoving = false;
    const ownHosts = survey?.ownHosts ?? new Set();
    const limited = !!survey && !survey.showAll;
    const lvAt = (p, q, idx) => byId.get(`${p},${q},${idx}`)?.lv ?? (limited ? 0 : L3);
    const seesTile = (e, idx) => lvAt(e.p, e.q, idx) === L3;
    // a battle scene plays where the viewer has it in sight, or when the viewer's own hosts fought in it
    const shown = (b) => !limited || (b.scene?.tiles ?? []).some(t => lvAt(b.scene.p, b.scene.q, t.idx) === L3 || [...(t.attackers ?? []), ...(t.defenders ?? [])].some(x => ownHosts.has(String(x.id))));
    // tiles seen for the first time dissolve out of the chart, under everything that moves (map/chart.mjs)
    if (survey?.reveals?.size && !reducedMotion()) {
      const byKey = new Map();
      for (const key of survey.reveals.keys()) byKey.set(key, null);
      for (const t of tiles) { const key = hexKey(t.q, t.r); if (byKey.has(key)) byKey.set(key, t); }
      if (paintReveal(ctx, { reveals: survey.reveals, byKey: key => byKey.get(key), res: s.r / RADIUS, now: fxNow(), nameAt: chartName }) > 0 && !this.revealTimer) this.revealTimer = setTimeout(() => { this.revealTimer = null; this.onTick(); }, 33);
    }
    // (the survey is in the ground and the sprites already: muted land, the chart and their edge; nothing veils the frame)
    // province borders: ink with its halo over painted land, a quiet sepia line on the chart. Under the hosts, the
    // people and their labels (a border used to run through a label that stood on it)
    for (const e of entries) if (e.fog !== 'unopened') this.frame(ctx, { p: e.p, q: e.q, fog: 'clear', selected: e.selected, zoom, sv: svOf(e), survey });
    // a tile whose battle is playing shows the scene's figures, not the hosts' sprites (UI plan D4)
    const fightingAt = battleTiles((people?.battles ?? []).filter(shown), (globalThis.performance?.now?.() ?? Date.now()) / 1000);
    for (const e of entries) {
      if (!e.prov?.entries || e.fog === 'unopened') continue;
      const byTile = new Map();
      // a host is drawn where the viewer has it in sight; the viewer's own hosts always
      const hidden = (h) => !seesTile(e, h.tile) && !ownHosts.has(String(h.hostId ?? h.id));
      const push = (tile, h) => { if (!byTile.has(tile)) byTile.set(tile, []); byTile.get(tile).push(h); };
      // the last resolved clash: survivors keep the stance they fought in, broken arrivals show as disarray
      const last = new Map();
      for (const a of e.clash?.arrivals ?? []) if (a.present) last.set(String(a.hostId), a);
      const resident = new Set();
      for (const h of e.prov.entries) {
        if (h.state !== 1 && h.state !== 2) continue;
        if (hidden(h)) continue;
        const a = last.get(String(h.id));
        resident.add(String(h.id));
        push(h.tile, { faction: h.faction, stance: a ? ART_STANCES[a.stance] ?? 'hold' : 'hold', troops: Math.floor(Number(h.troops) / 1000), stamina: Number(h.staminaValue ?? 120) });
      }
      for (const a of last.values()) {
        if (resident.has(String(a.hostId)) || !BROKEN_FATES.has(a.fate) || hidden(a)) continue;
        push(a.tile, { faction: a.faction, stance: 'disarray' });
      }
      // arrivals of the latest bell that are not resolved yet: their revealed stance
      const pend = e.pending;
      if (pend && !pend.resolvedTs) for (const a of pend.arrivals ?? []) {
        if (!a.present || hidden(a) || resident.has(String(a.hostId))) continue;
        push(a.tile, { faction: a.faction, stance: ART_STANCES[a.stance] ?? 'hold', arriving: true });
      }
      // the flags' groups (province detail, when the figures are too small): one entry per host
      for (const [idx, list] of byTile) {
        if (fightingAt.has(`${e.p},${e.q},${idx}`)) continue;
        const hx = tileHex(e.p, e.q, idx), c = project(hx.q, hx.r);
        for (const h of list) hosts.push({ x: c.x, y: c.y, h, cx: c.x, cy: c.y, key: `${e.p},${e.q},${idx}` });
      }
      // the tokens (tile detail): one soldier per faction per tile (people/units.mjs, after the Eternum benchmark)
      const holdingTiles = new Set((byProv.get(`${e.p},${e.q}`) ?? []).filter(u => u.state === 1 && u.site !== undefined).map(u => u.idx));
      const all = [];
      for (const h of e.prov.entries) {
        if (h.state < 1 || h.state > 3 || hidden(h)) continue;
        const a = last.get(String(h.id));
        all.push({ id: h.id, faction: h.faction, unit: h.unit, tile: h.tile, state: h.state, troops: Math.floor(Number(h.troops) / 1000), stamina: Number(h.staminaValue ?? 120), broken: !!a && BROKEN_FATES.has(a.fate) });
      }
      if (pend && !pend.resolvedTs) for (const a of pend.arrivals ?? []) {
        if (!a.present || hidden(a) || resident.has(String(a.hostId))) continue;
        all.push({ id: a.hostId, faction: a.faction, unit: a.unit, tile: a.tile, state: 1, troops: Math.floor(Number(a.troops) / 1000), stamina: Number(a.stamina ?? 120), arriving: true });
      }
      const skip = new Set([...fightingAt].filter(k => k.startsWith(`${e.p},${e.q},`)).map(k => Number(k.split(',')[2])));
      // (on the viewer's own village the hosts stand in front of the houses, not on them: map/plates.mjs HERO)
      const heroTiles = new Set((byProv.get(`${e.p},${e.q}`) ?? []).filter(u => u.hero).map(u => u.idx));
      for (const tok of provinceTokens({ p: e.p, q: e.q, hosts: all, holdingTiles, heroTiles, heroSpots: HERO.hosts, viewerFaction, exploring: people?.exploringHosts ?? new Set(), marching: people?.marchingHosts ?? new Set(), restBelow: people?.restBelow ?? 0, skipTiles: skip })) {
        // the gold ring is the viewer's own hosts, never a whole nation's (gold means "yours": UX brief §5.3)
        if (limited) tok.own = (tok.hosts ?? []).some(id => ownHosts.has(String(id)));
        tokens.push(tok);
      }
    }
    tokens.sort((a, b) => a.y - b.y || a.x - b.x);
    if (RADIUS * zoom >= HOST_FIGURE_MIN_R) {
      const t = (globalThis.performance?.now?.() ?? Date.now()) / 1000;
      const size = RADIUS * 0.66 * zoomBoost(RADIUS * zoom);
      // a host stands in the scene: a mountain, a wood or a town on a tile in front of it covers it. The figure
      // is drawn on a scratch, the things in front are cut out of it, and what is left goes onto the map
      const m = ctx.getTransform?.() ?? null, sc = m && m.a > 0 ? this.scratch ??= spare(8, 8) : null, sg = sc?.getContext?.('2d') ?? null;
      const tall = (u) => !!u && !u.cloud && (TALL.has(u.name) || u.camp || (u.site !== undefined && u.state !== undefined && u.state !== 0) || (u.centre && u.ring <= 1));
      for (const tok of tokens) {
        const h = tileHex(tok.p, tok.q, tok.tile);
        // in front: the two tiles below (lower left, lower right); the Engine and a Seat reach further up
        const front = h ? [byHex.get(keyOf(h.q - 1, h.r + 1)), byHex.get(keyOf(h.q, h.r + 1)), byHex.get(keyOf(h.q - 1, h.r + 2))].filter((u, i) => tall(u) && (i < 2 || u.centre)) : [];
        if (!front.length || !sg) { paintToken(ctx, tok, { s: size, k: 1 / zoom, t, label: false, up }); pills.push({ tok, s: size }); continue; }
        // the scratch holds the miniature's whole cell (its cast shadow too) and the lunge of a fight
        // (a figure that stands upright on the tilted board is drawn taller and leaning in the plane: room for that)
        const cw = size * MINI_CELL_U, pad = size * 0.2 + (up ? cw * 0.34 : 0);
        const x0 = Math.floor((tok.x - cw * MINI_ANCHOR[0] - pad) * m.a + m.e), y0 = Math.floor((tok.y - cw * MINI_ANCHOR[1] - pad) * m.d + m.f);
        const w = Math.ceil((cw + pad * 2) * m.a) + 2, hgt = Math.ceil((cw + pad * 2) * m.d) + 2;
        if (sc.width < w || sc.height < hgt) { sc.width = Math.max(sc.width, w); sc.height = Math.max(sc.height, hgt); }
        sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, sc.width, sc.height);
        sg.setTransform(m.a, 0, 0, m.d, m.e - x0, m.f - y0);
        paintToken(sg, tok, { s: size, k: 1 / zoom, t, label: false, up });
        sg.globalCompositeOperation = 'destination-out';
        g = sg; for (const u of front) propsOf(u); g = ctx;
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(sc, 0, 0, w, hgt, x0, y0, w, hgt); ctx.restore();
        pills.push({ tok, s: size });
      }
      if (tokens.length) this.tokensMoving = true;
    }
    // pass 2c: people (people/crowds.mjs): townsfolk, carriers, departing columns at their origin, scouts
    // what every tile is doing (people/activity.mjs); kept for the page's hover tip
    const activities = people ? activitiesFor(entries, { bell: people.bell ?? 0, departures: people.departures ?? [], explores: people.explores ?? [], own: people.own ?? [] }) : null;
    // preview only (?art=1&acts=1): sample activities on the drawn holdings
    if (activities && people.demo) for (const t of tiles) {
      if (t.state !== 1 || !(t.owner < 6) || t.fog === 'unopened') continue;
      const k = ['walls', 'muster', 'rest', 'battle', 'garrison', 'depart', 'explore', null][((t.q * 7 + t.r * 3) % 8 + 8) % 8];
      if (!k) continue;
      const key = `${t.p},${t.pq},${t.idx}`;
      if (k === 'depart') { people.departures = [...(people.departures ?? []), { p: t.p, q: t.pq, tile: t.idx, faction: t.owner, troops: 2000, arriveBell: (people.bell ?? 0) + 3 }]; }
      if (k === 'explore') { people.explores = [...(people.explores ?? []), { p: t.p, q: t.pq, tiles: [t.idx], faction: t.owner }]; }
      activities.set(key, [{ kind: k, faction: t.owner, until: (people.bell ?? 0) + 2, n: 400 }, ...(activities.get(key) ?? [])]);
    }
    // what happens on a tile is told (the badge, the hover tip, the inspector) only where the viewer has it in sight
    const siteLv = (p, q, site) => (byProv.get(`${p},${q}`) ?? []).find(u => u.site === site)?.lv ?? (limited ? 0 : L3);
    if (activities && limited) for (const key of [...activities.keys()]) if ((byId.get(key)?.lv ?? 0) < L3) activities.delete(key);
    this.activities = activities;
    this.tiles = tiles;
    // (other people's scouts, works and moments are live things: in sight only; the viewer's own always)
    const explores = !limited ? people?.explores ?? [] : (people?.explores ?? []).filter(x => (x.host && ownHosts.has(String(x.host))) || (x.tiles ?? []).some(idx => lvAt(x.p, x.q, idx) === L3));
    // (a building's ring is a label: drawn upright with the plates, on the scaffold that stands here)
    const moving = people ? paintPeople(ctx, { tiles, zoom, explores, marches: people.marches ?? [], constructions: people.constructions ?? [], pills, ring: false, scaffoldAt, up }) : 0;
    // one-shot moments: harvest yields, a building done, a host setting out, an arrival out of the mist
    const moments = !limited ? people?.moments ?? [] : (people?.moments ?? []).filter(m => (Number.isInteger(m.tile) ? lvAt(m.p, m.q, m.tile) : siteLv(m.p, m.q, m.site)) === L3);
    if (moments.length && RADIUS * zoom >= HOST_FIGURE_MIN_R * 0.8 && paintMoments(ctx, moments, { tiles, k: 1 / zoom, now: (globalThis.performance?.now?.() ?? Date.now()) / 1000 })) this.tokensMoving = true;
    // pass 2d: battle scenes playing (people/battle.mjs)
    let fighting = 0;
    for (const b of people?.battles ?? []) if (shown(b) && paintBattle(ctx, b, { zoom, lossText: people.lossText, fateText: people.fateText })) fighting++;
    if (opening !== null) {
      const lvl = OPEN_GLOW[openFrame];
      if (lvl !== null && lvl !== undefined) for (const t of tiles) {
        if (t.ring !== opening || t.cloud) continue;
        EDGE_DIRS.forEach(([dq, dr], e) => {
          const at = locate(t.q + dq, t.r + dr);
          if (ringOf(at.p, at.q) >= opening) return;
          const gl = this.image('fog', s.key, `ringglow_${e}_${lvl}`); if (gl) draw(gl, t);
        });
      }
      this.onLoad();   // keep frames coming until the moment is over
    }
    // (the selected tile's ring is drawn by the map: bright, on the ground and again over what stands there: map/actions.mjs)
    void selected;
    // the next animation frame while figures move: only the animated layers repaint (onTick)
    if ((moving || fighting || this.tokensMoving) && !this.peopleTimer) this.peopleTimer = setTimeout(() => { this.peopleTimer = null; this.onTick(); }, fighting ? 33 : PEOPLE_FRAME_MS);
    // what the labels need of this frame (labels()); a whole painting draws them now
    this.liveNow = { hosts, pills, tiles, constructions: people?.constructions ?? [] };
    if (part === null) this.labels(ctx, { zoom, people });
    return tiles.length;
  }

  /**
   * the hosts' flags (Civ's unit flags): one per faction per hex — the faction's colour, its troops and the
   * weakest host's stamina as a bar (green, amber when it cannot march yet, red when spent); above the
   * figures when they show, in their place when the map is further out
   */
  flags(ctx, hosts, zoom) {
    const groups = new Map();
    for (const o of hosts) {
      const key = `${o.cx},${o.cy},${o.h.faction}`;
      const g = groups.get(key) ?? { cx: o.cx, cy: o.cy, f: o.h.faction, n: 0, troops: 0, stamina: 120, arriving: false };
      g.n++; g.troops += o.h.troops ?? 0; g.stamina = Math.min(g.stamina, o.h.stamina ?? 120); g.arriving ||= !!o.h.arriving;
      groups.set(key, g);
    }
    const perHex = new Map();
    const figures = RADIUS * zoom >= HOST_FIGURE_MIN_R;
    if (figures) return;   // the tokens carry their own labels at tile detail
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const g of groups.values()) {
      const hk = `${g.cx},${g.cy}`;
      const i = perHex.get(hk) ?? 0; perHex.set(hk, i + 1);
      const k = 1 / zoom, w = 44 * k, h = 15 * k;
      const x = g.cx - w / 2 + i * (w + 3 * k), y = figures ? g.cy - RADIUS * 0.95 - h : g.cy + 4 * k;
      const fill = FACTION_COLORS[g.f] ?? '#8a8f86';
      // (a flag stands upright over its hex whatever the board's tilt: map/tilt.mjs)
      upright(ctx, g.cx, g.cy, () => {
      ctx.beginPath(); ctx.roundRect?.(x - 1.5 * k, y - 1.5 * k, w + 3 * k, h + 7 * k, 6 * k); ctx.fillStyle = '#1a1d22'; ctx.fill();
      ctx.beginPath(); ctx.roundRect?.(x, y, w, h, 5 * k); ctx.fillStyle = fill; ctx.fill();
      if (g.arriving) { ctx.setLineDash([3 * k, 2 * k]); ctx.strokeStyle = '#fffaf0'; ctx.lineWidth = 1.2 * k; ctx.stroke(); ctx.setLineDash([]); }
      ctx.fillStyle = '#fffaf0'; ctx.font = `700 ${11 * k}px system-ui, sans-serif`;
      const t = g.troops <= 0 ? '?' : g.troops >= 1000 ? `${(g.troops / 1000).toFixed(g.troops >= 10000 ? 0 : 1)}k` : String(g.troops);
      ctx.fillText(`\u2694${t}`, x + w / 2 - (g.n > 1 ? 5 * k : 0), y + h / 2 + 0.5 * k);
      // more than one host: their number in a small dot at the flag's corner (never read as part of the troops)
      if (g.n > 1) { ctx.fillStyle = '#1a1d22'; ctx.beginPath(); ctx.arc(x + w - 1 * k, y + 1 * k, 6.5 * k, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fffaf0'; ctx.font = `700 ${9 * k}px system-ui, sans-serif`; ctx.fillText(String(g.n), x + w - 1 * k, y + 1.5 * k); }
      const st = Math.max(0, Math.min(1, g.stamina / 120));
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(x, y + h + 1.5 * k, w, 3 * k);
      ctx.fillStyle = g.stamina < 40 ? '#e0533d' : g.stamina < 74 ? '#e0a83d' : '#5fbf6a'; ctx.fillRect(x, y + h + 1.5 * k, w * st, 3 * k);
      });
    }
    ctx.restore();
  }

  /**
   * The labels of the last tile view painted (paint's 'live' part): the hosts' flags when the figures are too
   * small, one nameplate per village (its name, tier, garrison and hosts: map/plates.mjs), a ring on a building
   * going up, the pills of the hosts in the field. Text: it goes over the depth dressing, so the haze never takes
   * its contrast (the map calls this after the dressing; a whole `paint` calls it itself). `pass`: the frame's
   * label pass (map/labelpass.mjs): the labels keep clear of the HUD and of each other.
   */
  labels(ctx, { zoom, people = null, pass = OPEN_PASS }) {
    if (!this.liveNow) return;
    const { hosts, pills, tiles, constructions } = this.liveNow;
    // the hosts that stand on a village of their own nation are told by that village's plate (one badge), not by a flag or a pill of their own
    const owner = new Map(), garrisoned = new Map();
    for (const u of tiles) if (u.state === 1 && u.owner < 6 && u.site !== undefined && !u.cloud) owner.set(`${u.p},${u.pq},${u.idx}`, u.owner);
    const afield = [];
    for (const o of hosts) {
      if (o.key && owner.get(o.key) === o.h.faction && !o.h.arriving && o.h.stance !== 'disarray') garrisoned.set(o.key, (garrisoned.get(o.key) ?? 0) + (o.h.troops ?? 0));
      else afield.push(o);
    }
    this.flags(ctx, afield, zoom);
    const figures = RADIUS * zoom >= HOST_FIGURE_MIN_R;
    paintPlates(ctx, { tiles, pills: figures ? pills : [], constructions, hostsOn: garrisoned, zoom, centre: people?.centre ?? null, pass, t: (globalThis.performance?.now?.() ?? Date.now()) / 1000 });
  }
}

/** A `terrainAt(q, r)` for tiles outside the drawn entries, from the page's terrainOf(p, q). */
export function terrainLookup(terrainOf) {
  return (q, r) => {
    const at = locate(q, r);
    const t = terrainOf?.(at.p, at.q);
    return t ? TERRAIN_KEY[t.names?.[t.terrain[at.idx]]] ?? null : null;
  };
}

export { UNOPENED_FILL, COLORS, shade };
