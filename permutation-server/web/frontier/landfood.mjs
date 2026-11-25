// (food-net-caravan, owner 2026-11-25 21:22 Q-LP17-2: display only) The land upkeep in the food rate.
//
// A territory world charges the upkeep of a player's tiles to the food of the FIRST village (the Citizen's slot 1;
// frontier-abi world_index/territory.rs settle_upkeep, once a turn by the world's keeper/runner). The village's own
// record does not carry it: its stores' rate is production minus the village's own upkeep, so the screens said
// "Food +40/h" while the land took 72.27 (loop-play17 LP17-3). Here the rate a screen shows becomes the NET one,
// with the land's part beside it: "−32.27/h (land −72.27)".
//
// The number is the program's: `FS.ownLand.player.upkeepMilliPerHour` is TerritoryPlayer::upkeep_per_hour as the
// page's mirror computes it from the viewer's own territory record (flocalplay-territory.mjs decodeTerritoryPlayer /
// fdevnet-territory.mjs landOfSummary: tiles × TERRITORY_V1.upkeep.flat + perDistance × Σ excess — the ×30 constants).
// Nothing is read here that the village card's land line does not already show; no record, no tile: nothing changes.
import { L, fmtNum } from '../lang.mjs';

/** The resource the land upkeep is paid in (TERRITORY_V1.upkeepResource 0). */
export const LAND_UPKEEP_RESOURCE = 'Food';

/** The viewer's first village (the one the land upkeep is charged to): slot 1 of `FS.holdings`, or null. */
export const landPayer = FS => (FS?.holdings ?? []).find(h => h.order === 1 || h.order === undefined) ?? null;

/**
 * The land upkeep charged to `holding`, in milli-food per hour: the viewer's own territory record's rate when
 * `holding` is the first village and the record holds a tile; else 0 (another village, no territory world, the record
 * not read yet).
 */
export function landUpkeepMilli(FS, holding) {
  const milli = Number(FS?.ownLand?.player?.upkeepMilliPerHour ?? 0);
  if (!holding || !(milli > 0) || !(Number(FS.ownLand.player.tiles ?? 0) > 0)) return 0;
  const home = landPayer(FS);
  return home && home.p === holding.p && home.q === holding.q && home.site === holding.site ? milli : 0;
}

/**
 * One store row/token (`{resource, perHour, …}`) with the land's part taken off: for the food of the paying village
 * `{…, perHour: net, villagePerHour: as recorded, landPerHour: the land's food per hour}`; any other row unchanged.
 */
export function withLand(row, milli) {
  if (!row || row.resource !== LAND_UPKEEP_RESOURCE || !(milli > 0)) return row;
  const landPerHour = milli / 1000;
  // (two exact-in-thousandths numbers: the difference is rounded back to thousandths, never 39.730000000000004)
  return { ...row, perHour: Math.round((row.perHour - landPerHour) * 1000) / 1000, villagePerHour: row.perHour, landPerHour };
}

const num = n => fmtNum(Math.abs(n), { maximumFractionDigits: 3 });
/** "+40" / "−32.27": a signed rate with up to three decimals (the land line's own precision). */
export const signedNet = n => `${n >= 0 ? '+' : '−'}${num(n)}`;
/** The land's part of a rate, in words: "（土地 −72.27）" / " (land −72.27)"; '' for a row the land takes nothing from. */
export const landPart = row => (row?.landPerHour > 0 ? L`（土地 −${num(row.landPerHour)}）` : '');
/** The hover text's part: "（村 +40 · 土地 −72.27）". */
export const landSplit = row => (row?.landPerHour > 0 ? L`（村 ${signedNet(row.villagePerHour)} · 土地 −${num(row.landPerHour)}）` : '');
