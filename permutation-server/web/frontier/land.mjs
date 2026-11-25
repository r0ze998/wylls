// The land preview's record ("Standing Ground" in reduced form; TEST-ONLY worlds started with the launcher's
// `--world-option land-preview-v1`): the program's own land record of a province, as the herald carries it in the
// province envelope (`env.land`, PSFLAND1, 272 bytes; frontier-abi/src/land_preview.rs). This file only reads it:
// which nation holds each tile, which tiles are village land, the bell the record has folded to. Nothing here is a
// rule (the program folds the land; permutation-rules/src/frontier/land.rs); a world without the option sends no
// `land` and every function here answers null.
import { fromBase64 } from '../sdk/bytes.mjs';
import { L, fmtNum } from '../lang.mjs';
import { html } from '../util.mjs';

export const LAND = Object.freeze({ MAGIC: 'PSFLAND1', SIZE: 272, SEASON_ID: 8, VERSION: 16, NEXT_BELL: 20, VILLAGE: 24, P: 32, Q: 34, OWNER: 36, BY: 97, COUNT: 158, OPEN: 255, TILES: 61 });

/**
 * The rule's turn counts as the program build has them (`LandParams::PREVIEW`; the runner states them and the launcher
 * checks them, `runnerLandAgrees`): turns a host stands to claim, turns of pressing to take a claimed tile, turns a
 * cut-off tile lasts. Read here only to say how far a count has come; the program decides.
 */
export const RULE = Object.freeze({ STAND: 6, SEIZE: 72, FRAY: 36 });

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
  // the counts running on tiles: `by` the nation pressing tile t (its owner when the tile is cut off and fading), `count`
  // the turns so far (land.rs: by/count; 255 = nobody)
  const by = Array.from(b.subarray(LAND.BY, LAND.BY + LAND.TILES)), count = Array.from(b.subarray(LAND.COUNT, LAND.COUNT + LAND.TILES));
  return { p, q, nextBell: dv.getUint32(LAND.NEXT_BELL, true), owners, village, totals, claimed, by, count };
}

/**
 * What the land record says of one tile `idx`: `{owner (0..5 or null), village, claimed, count: null |
 * {kind: 'take' | 'fade', by, turns, of}}` — `take`: another nation's host has pressed it `turns` of `of` turns;
 * `fade`: it is cut off from its nation's land and lasts `of − turns` more. Null without a record.
 */
export function landTile(land, idx) {
  if (!land || !Number.isInteger(idx) || idx < 0 || idx >= LAND.TILES) return null;
  const o = land.owners[idx], owner = o < 6 ? o : null, village = land.village.has(idx);
  const b = land.by?.[idx], n = land.count?.[idx] ?? 0;
  let count = null;
  if (owner !== null && Number.isInteger(b) && b < 6 && n > 0) count = b === owner ? { kind: 'fade', by: b, turns: n, of: RULE.FRAY } : { kind: 'take', by: b, turns: n, of: RULE.SEIZE };
  return { owner, village, claimed: owner !== null && !village, count };
}

/**
 * The selection's lines for a tile of a land record (`landTile`), for the inspector: `[{text, tone}]`, tone 'you'
 * (the viewer's nation), 'bad' (the viewer's land being taken or fading), '' else. `nameOf(f)` names a nation.
 */
export function landTileLines(info, { viewer = null, nameOf = f => String(f) } = {}) {
  if (!info) return [];
  const out = [];
  const mine = info.owner !== null && info.owner === viewer;
  if (info.owner === null) out.push({ text: L`どの国の土地でもない空き地（領土の試験）`, tone: '' });
  else if (info.village) out.push({ text: mine ? L`あなたの国の村の土地（領土の試験）` : L`${nameOf(info.owner)}の村の土地（領土の試験）`, tone: mine ? 'you' : '' });
  else out.push({ text: mine ? L`あなたの国が持つ土地（領土の試験）` : L`${nameOf(info.owner)}が持つ土地（領土の試験）`, tone: mine ? 'you' : '' });
  const c = info.count;
  if (c?.kind === 'take') out.push({ text: c.by === viewer ? L`あなたの国が奪取中：${fmtNum(c.turns)} / ${fmtNum(c.of)} ターン` : L`${nameOf(c.by)}が奪取中：${fmtNum(c.turns)} / ${fmtNum(c.of)} ターン`, tone: mine ? 'bad' : c.by === viewer ? 'you' : '' });
  else if (c?.kind === 'fade') out.push({ text: L`国の土地から切り離され減っています：${fmtNum(c.turns)} / ${fmtNum(c.of)} ターン`, tone: mine ? 'bad' : '' });
  return out;
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
 * read (the line once summed every province read, so it jumped when the camera moved). `h` is the village as the next
 * instruction finds it (app.mjs passes `settled`, as for the strip): its production is the one the program's yield reads.
 */
export function landSummary(FS, h, f) {
  if (!h || !Number.isInteger(f)) return null;
  const env = FS?.provinces?.get?.(`${h.p},${h.q}`);
  if (!env?.land) return null;
  const villages = (env.province?.siteMirror ?? []).filter(s => s?.state === 1 && s?.faction === f).length;
  const claimed = env.land.claimed[f] ?? 0;
  const bps = villages > 0 ? Math.min(Math.floor(claimed * BONUS.PER_TILE_BPS / villages), BONUS.CAP_BPS) : 0;
  return { claimed, tiles: env.land.totals[f] ?? 0, bonusPct: bps / 100, perHour: landYieldPerHour(h.production, bps) };
}

/**
 * What the land bonus pays this holding in an hour, in whole units over all its stores, or null without its production:
 * the program's `land_preview::yield_for(production, bonus_bps, 6 bells)` — each entry (milli per hour) × bps / 10 000,
 * rounded down —, summed and rounded down to whole units. ClaimLandYield credits it to the stores later (the crank); the
 * strip's rates do not include it, so the chip says it (2026-11-16: the chip said "+N%" with no figure).
 */
export function landYieldPerHour(production, bps) {
  if (!Array.isArray(production) || !production.length || !Number.isInteger(bps) || bps < 0) return null;
  let milli = 0n;
  try { for (const v of production) { const x = BigInt(v); if (x > 0n) milli += x * BigInt(bps) / 10_000n; } } catch { return null; }
  return Number(milli / 1000n);
}

/** The strip's land line: "Claimed here: 9 tiles · production +1.5%" (nothing without a land record). */
/**
 * The viewer's nation's CLAIMED land (not village land) in the provinces the page has read other than the holding's
 * own: `{tiles, provinces}`. Kept apart from landSummary (which stays this province's own, steady line) and said to
 * count only what the map has loaded, so a take far from home (land4/land5: (4,-2), two provinces out) is on the strip
 * at all; before, the line said 0 — or nothing, when the home province had no land record.
 */
export function landElsewhere(FS, h, f) {
  const out = { tiles: 0, provinces: 0 };
  if (!h || !Number.isInteger(f)) return out;
  for (const [key, env] of FS?.provinces?.entries?.() ?? []) {
    if (key === `${h.p},${h.q}` || !env?.land) continue;
    const n = env.land.claimed[f] ?? 0;
    if (n > 0) { out.tiles += n; out.provinces += 1; }
  }
  return out;
}

/** The strip's land chip: this province's line (landSummary) and, apart, the land elsewhere (landElsewhere), or ''. */
export function renderLandChip(s, far = null) {
  const el = far && far.tiles > 0 ? far : null;
  if (!s && !el) return '';
  const away = el ? html`<span class="land-chip land-chip-far" data-land-far="${el.tiles}" data-land-far-provinces="${el.provinces}" title="${L`地図で読み込んだほかの州だけを数えます（テスト用の世界）。地図を動かすと変わることがあります。`}">${L`ほかの州 ${fmtNum(el.tiles)} マス`}</span>` : '';
  if (!s) return away;
  return html`${homeChip(s)}${away}`;
}

function homeChip(s) {
  return html`<span class="land-chip" data-land-claimed="${s.claimed}" data-land-tiles="${s.tiles}" data-land-bonus="${s.bonusPct}" title="${L`村の耕地（テスト用の世界）：この村の州で軍勢が立って広げたマスと、その分の生産の上乗せです。自分の領土（広い土地で取るマス）とは別のものです。`}"><span class="land-chip-long">${L`この州の耕地 ${fmtNum(s.claimed)} マス · 生産 +${fmtNum(s.bonusPct)}%`}${s.perHour > 0 ? L`（毎時 +${fmtNum(s.perHour)}）` : ''}</span><span class="land-chip-short" aria-hidden="true">${L`耕地 ${fmtNum(s.claimed)} マス · +${fmtNum(s.bonusPct)}%`}</span></span>`;
  // (fix-loop16, owner 2026-11-25 12:04 Q-LP16-3 (a): the village's worked land is "Fields" / 「耕地」 — "Land … tiles" /
  //  「領土」 read as the player's own territory, which is the wide land's tiles, a different thing)
  // (fix-loop13, LP13-2: the top bar shows the short form — the long one took the resource strip's room at every width
  //  (verify-pr208: measured at 1280–1920 px); the long one stays for screen readers and in the title, frontier.css)
}
