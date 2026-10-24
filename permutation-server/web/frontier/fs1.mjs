// The redesign's stage 1 (S1) on this page: whether the pinned season plays
// the S1 rules (program_version 4; docs/frontier/stage1*). Under them the
// Horses store slot holds arms (permutation-rules arms.rs `ARMS`), the
// workshop is build item 8, and the strong units cost arms to train. The
// season is set once by app.mjs loadSeason; tables that name the Horses slot
// read `s1On()` so every surface agrees.

/** Whether a decoded Season account plays the S1 rules. */
export const s1Season = season => Number(season?.layoutVersion) === 2 && Number(season?.programVersion) >= 4;

/** Whether a decoded Season account plays the S2 rules (tickets; program_version 5; S1's too). */
export const s2Season = season => s1Season(season) && Number(season?.programVersion) >= 5;

let on = false;
let on2 = false;
/** Set from the pinned season (app.mjs loadSeason). */
export function setS1(season) { on = s1Season(season); on2 = s2Season(season); }
/** Whether the pinned season plays the S1 rules. */
export const s1On = () => on;
/** Whether the pinned season plays the S2 rules (tickets). */
export const s2On = () => on2;

/**
 * The S1 numbers this page shows (permutation-rules arms.rs, [phase 6]),
 * pinned by web-frontier-s1.test.mjs.
 */
export const ARMS = 4;
/** Arms per 100 troops trained, by unit id (Pikeman, Crossbowman, Knight need them). */
export const TRAIN_ARMS_PER_100 = Object.freeze([0, 0, 0, 50, 70, 40, 0]);
/** Arms a siege burns when declared. */
export const SIEGE_ARMS = 50;
/** The workshop: build item 8, arms production per copy and per hour, ore and wood used per arm, its first copy's cost. */
export const WORKSHOP = Object.freeze({
  item: 8, resource: 'Horses', perHour: 4, orePerArm: 2, woodPerArm: 1,
  cost: Object.freeze([60, 120, 80, 40, 0, 0, 0, 0]),
});
