// The redesign's stage 1 (S1) on this page: whether the pinned season plays
// the S1 rules (program_version 4; docs/frontier/stage1*). Under them the
// Horses store slot holds arms (permutation-rules arms.rs `ARMS`), the
// workshop is build item 8, and the strong units cost arms to train. The
// season is set once by app.mjs loadSeason; tables that name the Horses slot
// read `s1On()` so every surface agrees.

/** Whether a decoded Season account plays the S1 rules. */
export const s1Season = season => Number(season?.layoutVersion) === 2 && Number(season?.programVersion) >= 4;

let on = false;
/** Set from the pinned season (app.mjs loadSeason). */
export function setS1(season) { on = s1Season(season); }
/** Whether the pinned season plays the S1 rules. */
export const s1On = () => on;

/**
 * The S1 numbers this page shows (permutation-rules arms.rs, [phase 6]),
 * pinned by web-frontier-s1.test.mjs.
 */
export const ARMS = 4;
/** Arms per 100 troops trained, by unit id (Pikeman, Crossbowman, Knight need them). */
export const TRAIN_ARMS_PER_100 = Object.freeze([0, 0, 0, 50, 70, 40, 0]);
/** Arms a siege burns when declared. */
export const SIEGE_ARMS = 50;
/** A village's own ore an hour before any terrain (arms.rs ORE_BASE_PER_HOUR); the terrain part is capped at 30. */
export const ORE_BASE_PER_HOUR = 4;
/**
 * A village's base ore production in S1 (arms.rs `base_production`): its terrain ore, `(4 + min(extra, 30))` an hour in
 * thousandths, with the tier's bonus `× (100 + bonus) / 100`, rounded down as the rules do. `extra` is what the hills,
 * mountains and iron within 2 tiles add (map/sprites.mjs oreAround). BigInt thousandths.
 */
export const s1OreBase = (extra, bonusPct) => (BigInt(ORE_BASE_PER_HOUR + Math.min(30, Math.max(0, extra | 0))) * 1000n * BigInt(100 + (bonusPct | 0))) / 100n;
/**
 * What a village's terrain adds to its ore (`extra` of s1OreBase), as the map knows it: the page registers the map's
 * reading once (map/sprites.mjs oreAround), and every reader of a village's buildings (map/board.mjs buildingsOf,
 * hud/rulebook.mjs copyNumber, onboarding.mjs hasBuilt) takes it from here. `null` while not known.
 */
let oreExtraOf = () => null;
export function setOreExtraProvider(fn) { oreExtraOf = typeof fn === 'function' ? fn : () => null; }
export const oreExtraFor = h => { try { const v = h && Number.isInteger(h.tile) ? oreExtraOf(h.p, h.q, h.tile) : null; return Number.isInteger(v) ? v : null; } catch { return null; } };
/**
 * A village's base production as the season's rules give it (thousandths, by resource): the tier's, and on S1 the ore
 * from its terrain when that is known (`base[3]` null when not: its mines cannot be told from its terrain then).
 */
export function seasonBase(baseOfTier, h, { oreExtra = oreExtraFor(h), bonusPct = 0 } = {}) {
  if (!on) return baseOfTier;
  const b = baseOfTier.slice();
  // (lane C P3, 2026-11-16: the program reads the terrain ore stored on the holding (holding2 TERRAIN_ORE, proc/
  //  holding.rs terrain_ore) for arms::base_production in copy_number and settle_tiered, not the map. So a stored
  //  value is used first, as `terrain_ore × (100 + bonus) / 100`; the map's reading (registered or passed) only when
  //  the holding carries none. Without either the ore base stays unknown (null), as before.)
  const stored = storedTerrainOre(h);
  b[3] = stored !== null ? (stored * BigInt(100 + (bonusPct | 0))) / 100n : Number.isInteger(oreExtra) ? s1OreBase(oreExtra, bonusPct) : null;
  return b;
}
/**
 * The terrain ore stored on a decoded S1 Holding (`terrainOre`, i64 milli-units an hour, written at founding or capture),
 * or null when there is none to trust: absent (a v1 record, a hand-built fixture), not an integer, or not above 0 (a
 * written value is at least ORE_BASE_PER_HOUR × 1000; zeros are the field's reserved bytes in an older record, which
 * arms.rs holding_base_production also reads as "no terrain ore").
 */
export const storedTerrainOre = h => {
  const v = h?.terrainOre;
  const n = typeof v === 'bigint' ? v : Number.isSafeInteger(v) ? BigInt(v) : null;
  return n !== null && n > 0n ? n : null;
};
/** The workshop: build item 8, arms production per copy and per hour, ore and wood used per arm, its first copy's cost. */
export const WORKSHOP = Object.freeze({
  item: 8, resource: 'Horses', perHour: 4, orePerArm: 2, woodPerArm: 1,
  cost: Object.freeze([60, 120, 80, 40, 0, 0, 0, 0]),
});
