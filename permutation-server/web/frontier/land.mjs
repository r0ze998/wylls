// The land preview's record ("Standing Ground" in reduced form; TEST-ONLY worlds started with the launcher's
// `--world-option land-preview-v1`): the program's own land record of a province, as the herald carries it in the
// province envelope (`env.land`, PSFLAND1, 272 bytes; frontier-abi/src/land_preview.rs). This file only reads it:
// which nation holds each tile, which tiles are village land, the bell the record has folded to. Nothing here is a
// rule (the program folds the land; permutation-rules/src/frontier/land.rs); a world without the option sends no
// `land` and every function here answers null.
import { fromBase64 } from '../sdk/bytes.mjs';
import { L, fmtNum } from '../lang.mjs';
import { html } from '../util.mjs';

export const LAND = Object.freeze({ MAGIC: 'PSFLAND1', SIZE: 272, SEASON_ID: 8, VERSION: 16, NEXT_BELL: 20, VILLAGE: 24, P: 32, Q: 34, OWNER: 36, OPEN: 255, TILES: 61 });

const KEY = /^ld:(-?\d+),(-?\d+)$/;

/**
 * The land record of an envelope, or null when absent or not this province's (`p`, `q`) and season (`seasonId`):
 * `{p, q, nextBell, owners[61] (0..5 or 255 open), village: Set of tile indices, totals[6], claimed[6]}`. A record the
 * program has made but not yet folded (version 0) is null too: it holds no land yet.
 */
export function parseLand(value, { p, q, seasonId } = {}) {
  if (!value || typeof value !== 'object' || typeof value.bytes !== 'string') return null;
  const k = KEY.exec(value.key ?? '');
  if (!k || +k[1] !== p || +k[2] !== q) return null;
  let b;
  try { b = fromBase64(value.bytes); } catch { return null; }
  if (!(b instanceof Uint8Array) || b.length !== LAND.SIZE) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(...b.subarray(0, 8)) !== LAND.MAGIC) return null;
  if (seasonId !== undefined && seasonId !== null && dv.getBigUint64(LAND.SEASON_ID, true) !== BigInt(String(seasonId))) return null;
  if (dv.getInt16(LAND.P, true) !== p || dv.getInt16(LAND.Q, true) !== q) return null;
  if (dv.getUint16(LAND.VERSION, true) === 0) return null;
  const owners = Array.from(b.subarray(LAND.OWNER, LAND.OWNER + LAND.TILES));
  if (!owners.every(x => x === LAND.OPEN || x < 6)) return null;
  const vmask = dv.getBigUint64(LAND.VILLAGE, true), village = new Set();
  for (let t = 0; t < LAND.TILES; t++) if ((vmask >> BigInt(t)) & 1n) village.add(t);
  const totals = Array(6).fill(0), claimed = Array(6).fill(0);
  owners.forEach((f, t) => { if (f < 6) { totals[f]++; if (!village.has(t)) claimed[f]++; } });
  return { p, q, nextBell: dv.getUint32(LAND.NEXT_BELL, true), owners, village, totals, claimed };
}

/** The land of province `(p, q)` as this page last read it, or null. */
export const landOf = (FS, p, q) => FS?.provinces?.get?.(`${p},${q}`)?.land ?? null;

/** The tiles of nation `f` over every province this viewer has read: `{tiles, claimed}` (never the whole world). */
export function landTotals(FS, f) {
  let tiles = 0, claimed = 0;
  for (const env of FS?.provinces?.values?.() ?? []) if (env?.land) { tiles += env.land.totals[f] ?? 0; claimed += env.land.claimed[f] ?? 0; }
  return { tiles, claimed };
}

/** The rule's numbers for the bonus (the program build's `LandParams::PREVIEW`; the runner states them, the launcher checks). */
export const BONUS = Object.freeze({ PER_TILE_BPS: 200, CAP_BPS: 3000 });

/**
 * What the viewer's holding `h` (`{p, q}` of its province) has of the land preview, or null without a land record
 * there: `{claimed, tiles, bonusPct}` — ONLY that province's record: the tiles the viewer's nation has claimed there
 * (not village land), all its tiles there, and the production bonus the program pays this holding:
 * `min(claimed × 2% / its nation's villages there, 30%)`. It never depends on how many other provinces the page has
 * read (the line once summed every province read, so it jumped when the camera moved).
 */
export function landSummary(FS, h, f) {
  if (!h || !Number.isInteger(f)) return null;
  const env = FS?.provinces?.get?.(`${h.p},${h.q}`);
  if (!env?.land) return null;
  const villages = (env.province?.siteMirror ?? []).filter(s => s?.state === 1 && s?.faction === f).length;
  const claimed = env.land.claimed[f] ?? 0;
  const bps = villages > 0 ? Math.min(Math.floor(claimed * BONUS.PER_TILE_BPS / villages), BONUS.CAP_BPS) : 0;
  return { claimed, tiles: env.land.totals[f] ?? 0, bonusPct: bps / 100 };
}

/** The strip's land line: "Claimed here: 9 tiles · production +1.5%" (nothing without a land record). */
export function renderLandChip(s) {
  if (!s) return '';
  return html`<span class="land-chip" data-land-claimed="${s.claimed}" data-land-tiles="${s.tiles}" data-land-bonus="${s.bonusPct}" title="${L`領土の試験（テスト用の世界）：この村の州で軍勢が立って広げたマスと、その分の生産の上乗せです。`}">${L`この州で獲得 ${fmtNum(s.claimed)} マス · 生産 +${fmtNum(s.bonusPct)}%`}</span>`;
}
