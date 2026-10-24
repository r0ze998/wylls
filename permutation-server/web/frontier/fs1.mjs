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
/** The workshop: build item 8, arms production per copy and per hour, ore and wood used per arm, its first copy's cost. */
export const WORKSHOP = Object.freeze({
  item: 8, resource: 'Horses', perHour: 4, orePerArm: 2, woodPerArm: 1,
  cost: Object.freeze([60, 120, 80, 40, 0, 0, 0, 0]),
});
