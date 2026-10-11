// The units as painted miniatures (design session 2026-10-02: "the silhouettes and the touch
// do not fit the world"). The figures are rendered in the map art's own pipeline — Blender
// Cycles, the map camera's elevation, the same sun and world light, vertex-colour materials
// with AO (docs/frontier/art/units/) — one sheet per people:
//   art/units/<size>/units_<faction>.webp
//   rows = MINI_KINDS, columns = (face +1, face −1) × (standing, step A, step B)
// A cell is MINI_CELL_U figure heights square; the feet stand at MINI_ANCHOR of the cell.
// `paintMini` draws one and says whether it could (until a sheet loads the caller draws the
// canvas figure of units.mjs instead).
//
// THE HANDOVER FIGURES (owner's pack of 2026-10-10, art/README.md): where the season runs the conquest program
// (art/pack.mjs artPackOn) the sheets and the cards are the pack's three-heads-tall soldiers in the six characters'
// cloth colours, art/units/mobs-v1/. They were rendered to this file's own layout (the same cells, columns, rows and
// feet anchor), so only the folder differs; a sheet of the pack that fails to load falls back to the earlier one.
import { FACTION_FILL } from './avatar.mjs';
import { artPackOn, linkArtCss } from '../art/pack.mjs';

export const MINI_KINDS = Object.freeze(['spearman', 'archer', 'horseman', 'pikeman', 'crossbowman', 'knight', 'scout', 'settler']);
/** The sheets by cell size (px): @1x for small tokens, @2x from about 150 device px a cell. */
export const MINI_SIZES = Object.freeze([{ key: '@1x', cell: 160 }, { key: '@2x', cell: 320 }]);
/** A cell spans 2.0 figure units; a standing figure is 0.95 of a unit tall: the cell in token heights. */
export const MINI_CELL_U = (2.0 / 0.95) * 1.15;
export const MINI_ANCHOR = Object.freeze([0.42, 0.74]);
/** The base's radius in token heights (the render's 0.3 units, 1.5 × for riders). */
/** The folder of the handover figures under art/units/ (the earlier sheets stay beside it: the basic game's, and the stand-in if one of these fails). */
export const MOB_PACK = 'mobs-v1';
export const miniBaseR = kind => (0.235 / 0.95) * 1.15 * (kind === 'horseman' || kind === 'knight' ? 1.5 : 1);

const BASE = new URL('../art/units/', import.meta.url);
const sheets = new Map();
let redraw = () => {};
/** The map asks to be redrawn when a sheet arrives. */
export function onMiniLoad(fn) { redraw = typeof fn === 'function' ? fn : () => {}; }

/** A sheet by its path under art/units/: the image once it has loaded with the layout's own size, else null (and the load starts). */
function sheetAt(key, size) {
  const have = sheets.get(key);
  if (have) return have.ok ? have.img : null;
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  const rec = { img, ok: false };
  sheets.set(key, rec);
  img.onload = () => {
    // (a sheet of the pack is checked against the layout: a file of another shape would be cut into wrong cells)
    const cell = MINI_SIZES.find(s => s.key === size)?.cell;
    rec.ok = !key.startsWith(MOB_PACK) || !cell || !img.width || (img.width === cell * 6 && img.height === cell * MINI_KINDS.length);
    rec.failed = !rec.ok;
    redraw();
  };
  img.onerror = () => { rec.failed = true; if (key.startsWith(MOB_PACK)) redraw(); };
  img.src = new URL(`${key}.webp`, BASE).href;
  return null;
}
/** The sheet of a people at a size: the image once it has loaded, else null (and the load starts). */
export function miniSheet(faction, size) {
  const legacy = `${size}/units_${faction}`;
  if (!artPackOn()) return sheetAt(legacy, size);
  const key = `${MOB_PACK}/${legacy}`, img = sheetAt(key, size);
  // (while the pack's sheet is on its way the caller draws its stand-in; only one that failed asks for the earlier sheet)
  return img ?? (sheets.get(key)?.failed ? sheetAt(legacy, size) : null);
}

/** A sheet of the handover figures that is here already (the pack's, or the earlier one where the pack's failed): never starts a load. */
function miniHere(faction, size) {
  const legacy = `${size}/units_${faction}`, rec = sheets.get(`${MOB_PACK}/${legacy}`);
  if (rec?.ok) return rec.img;
  const old = rec?.failed ? sheets.get(legacy) : null;
  return old?.ok ? old.img : null;
}

/** The cell of a frame: column by facing and step, row by unit type. */
export function miniCell(kind, { face = 1, walking = false, step = 0 } = {}) {
  const row = Math.max(0, MINI_KINDS.indexOf(kind));
  const frame = walking ? (step % 1 < 0.5 ? 1 : 2) : 0;
  return { row, col: (face < 0 ? 3 : 0) + frame };
}

/**
 * A frame of a sheet with its baked cast shadow let through: the render throws each figure's shadow on the
 * ground as pure black at up to 0.73, which is right for one token on the map and heavy where figures stand
 * shoulder to shoulder (a battle's lines, a column setting off: the shadows pile into one dark mass). The
 * shadow is exactly the sheet's black, translucent pixels; their alpha is multiplied by `shade`. One small
 * canvas per frame used, kept; null where there is no canvas (the frame is then drawn as it is).
 */
const softCells = new Map();
function softCell(img, cell, row, col, shade) {
  const key = `${img.src}|${row}|${col}|${shade}`;
  if (softCells.has(key)) return softCells.get(key);
  let cv = null;
  try {
    cv = typeof globalThis.OffscreenCanvas === 'function' ? new globalThis.OffscreenCanvas(cell, cell) : globalThis.document?.createElement?.('canvas') ?? null;
    if (cv) {
      cv.width = cell; cv.height = cell;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, cell, cell);
      const im = g.getImageData(0, 0, cell, cell), d = im.data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i + 3] < 250 && d[i] < 8 && d[i + 1] < 8 && d[i + 2] < 8) d[i + 3] = Math.round(d[i + 3] * shade);
      g.putImageData(im, 0, 0);
    }
  } catch { cv = null; }
  softCells.set(key, cv);
  return cv;
}

/**
 * A miniature's frame as light to add to it (the hit tint): its own picture with warm light mixed in, the base
 * it stands on and its shadow left out. Drawn additively (people/battle.mjs HIT_TINT) it lifts the figure's colours and keeps
 * its drawing and its nation's colour: never a white silhouette. Null where there is no canvas or the sheet has not loaded.
 */
const tints = new Map();
function tintCell(faction, kind, face, walking, step) {
  const img = faction >= 0 && faction < 6 ? miniSheet(faction, MINI_SIZES[0].key) : null;
  if (!img) return null;
  const { row, col } = miniCell(kind, { face, walking, step });
  const key = `${img.src}|${row}|${col}`;
  if (tints.has(key)) return tints.get(key);
  let cv = null;
  try {
    const cell = Math.round(img.width / 6);
    cv = typeof globalThis.OffscreenCanvas === 'function' ? new globalThis.OffscreenCanvas(cell, cell) : globalThis.document?.createElement?.('canvas') ?? null;
    if (cv) {
      cv.width = cell; cv.height = cell;
      const g = cv.getContext('2d');
      g.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, cell, cell);
      // its own colours with warm light mixed in: added to the figure it brightens every colour toward that light
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(255,238,206,0.16)'; g.fillRect(0, 0, cell, cell);
      // the figure only: the base it stands on and its shadow stay as they are
      const m = g.createLinearGradient(0, cell * (MINI_ANCHOR[1] - 0.2), 0, cell * (MINI_ANCHOR[1] - 0.06));
      m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalCompositeOperation = 'destination-in'; g.fillStyle = m; g.fillRect(0, 0, cell, cell);
    }
  } catch { cv = null; }
  tints.set(key, cv);
  return cv;
}

/** The nation whose miniatures stand in for the neutral camp's fighters, drawn drained of colour and washed in leather. */
const CAMP_SHEET = 5;
const camps = new Map();
/** A camp fighter's frame: a miniature greyed and washed brown (the camp has no sheet of its own); null until the sheet has loaded or where there is no canvas. */
function campCell(kind, face, walking, step) {
  const img = miniSheet(CAMP_SHEET, MINI_SIZES[0].key);
  if (!img) return null;
  const { row, col } = miniCell(kind, { face, walking, step });
  const key = `${img.src}|${row}|${col}`;
  if (camps.has(key)) return camps.get(key);
  let cv = null;
  try {
    const cell = Math.round(img.width / 6);
    cv = typeof globalThis.OffscreenCanvas === 'function' ? new globalThis.OffscreenCanvas(cell, cell) : globalThis.document?.createElement?.('canvas') ?? null;
    if (cv) {
      cv.width = cell; cv.height = cell;
      const g = cv.getContext('2d');
      if ('filter' in g) g.filter = 'grayscale(0.85) brightness(1.02) contrast(1.05)';
      g.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, cell, cell);
      if ('filter' in g) g.filter = 'none';
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(112,78,44,0.3)'; g.fillRect(0, 0, cell, cell);
    }
  } catch { cv = null; }
  camps.set(key, cv);
  return cv;
}

/** Start loading a nation's sheets, both sizes (`faction` null: the sheet the camp's fighters are made from). */
export function preloadMinis(faction) {
  const f = faction >= 0 && faction < 6 && faction !== null ? faction : CAMP_SHEET;
  for (const size of MINI_SIZES) miniSheet(f, size.key);
}

/**
 * THE painter of a host's figure (the one function through which the host art reaches the board, the set pieces
 * and the battle scene: people/units.mjs paintToken, fx/pieces.mjs figureFlat, people/battle.mjs paintFigureFlat).
 * Draw one miniature, feet at (x, y), `s` the token's height (world px); `{faction, face, step, walking, alpha,
 * lunge, own, pulse, shade, camp, flash}`. `shade` (0..1, default 1): how much of the baked cast shadow is kept
 * (figures that stand in a group pass less). `camp`: a fighter of the neutral camp (a miniature drained of colour
 * and washed in leather: the camp has no sheet of its own). `flash` (0..1): light added to the figure for a frame
 * or two when a blow lands. Returns false when its sheet has not loaded yet (the caller draws its stand-in).
 * New host art is plugged in here and nowhere else (people/README.md, "Host art").
 */
export function paintMini(ctx, x, y, s, kind, { faction = 0, face = 1, step = 0, walking = false, alpha = 1, lunge = 0, own = false, pulse = 0, shade = 1, camp = false, flash = 0 } = {}) {
  if (!camp && !(faction >= 0 && faction < 6)) return false;
  const w = s * MINI_CELL_U;
  const { row, col } = miniCell(kind, { face, walking, step });
  const lx = x + (face < 0 ? -1 : 1) * lunge * s * 0.12;
  const bob = walking ? Math.abs(Math.sin(step * Math.PI * 2)) * s * 0.02 : 0;
  const dx = lx - w * MINI_ANCHOR[0], dy = y - bob - w * MINI_ANCHOR[1];
  const a0 = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  if (camp) {
    const cell = campCell(kind, face, walking, step);
    if (!cell || !ctx.drawImage) return false;
    ctx.save();
    ctx.globalAlpha = a0 * alpha;
    ctx.drawImage(cell, dx, dy, w, w);
  } else {
    const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const scale = m && Number.isFinite(m.a) ? Math.hypot(m.a, m.b) : 1;
    const size = w * scale > 150 ? MINI_SIZES[1] : MINI_SIZES[0];
    const otherSize = size === MINI_SIZES[1] ? MINI_SIZES[0] : MINI_SIZES[1];
    // (the handover figures: the sheet the drawn size calls for is asked for, and the other one is drawn meanwhile only if
    // it is here already; it is never fetched as a stand-in, so a board at rest loads one sheet of 0.2 MB a nation and
    // not the 0.65 MB one with it. The earlier sheets keep their way: both asked for.)
    const img = artPackOn() ? miniSheet(faction, size.key) ?? miniHere(faction, otherSize.key) : miniSheet(faction, size.key) ?? miniSheet(faction, otherSize.key);
    if (!img) return false;
    const cell = img.width / 6;
    ctx.save();
    ctx.globalAlpha = a0 * alpha;
    const soft = shade < 1 ? softCell(img, Math.round(cell), row, col, shade) : null;
    if (soft) ctx.drawImage(soft, dx, dy, w, w);
    else ctx.drawImage(img, col * cell, row * cell, cell, cell, dx, dy, w, w);
    if (own) {   // the viewer's own: a gold ring around the base
      const r = s * miniBaseR(kind) * 1.18;
      ctx.globalAlpha = a0 * alpha * (0.75 + pulse * 0.25);
      ctx.strokeStyle = '#f3d58a'; ctx.lineWidth = s * 0.035;
      ctx.beginPath(); ctx.ellipse(lx, y, r, r * 0.76, 0, 0, Math.PI * 2); ctx.stroke();
    }
  }
  // the blow: light added to the figure for a frame or two (it keeps its colours and its drawing)
  if (flash > 0.02) {
    const tint = tintCell(camp ? CAMP_SHEET : faction, kind, face, walking, step);
    if (tint && ctx.drawImage) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a0 * alpha * flash;
      ctx.drawImage(tint, dx, dy, w, w);
    }
  }
  ctx.restore();
  return true;
}

/** The unit portrait (the miniature on its base, for the UI): art/units/cards/<faction>_<kind>.webp; the handover figures' cards (art/units/mobs-v1/cards/) where the pack is shown. */
export const miniCardUrl = (faction, kind) => new URL(`${artPackOn() ? (linkArtCss(), `${MOB_PACK}/`) : ''}cards/${faction >= 0 && faction < 6 ? faction : 0}_${MINI_KINDS.includes(kind) ? kind : 'spearman'}.webp`, BASE).href;
/** The card's backdrop colour (the faction's). */
export const miniCardColour = f => FACTION_FILL[f] ?? '#8a8a80';
