// LOCAL PLAY, TEST-ONLY — operator AI residents: the ORE RESERVE (owner 2026-11-25 09:33 JST, Q-LP15-4 (b): "AI keeps
// an ore reserve — don't starve its armies"). Key-free, pure: nothing here reads, signs or sends.
//
// Why (loop-play15 LP15-5): in a territory world tiles and troops are both paid in the first village's ore. The policy
// asked for Train first, and bought a tile whenever the ore covered it; so tiles were bought in the turns a refused
// Train was cooling, the ore never reached a training batch again, and in 38 minutes "Train" was refused 174 times
// (32 landed) while 71 tile claims landed and no AI took a wide keep.
//
// The rule (behaviour only — the same commands and prices as a player's, §8; no rule of the world changes):
//   1. A Train is asked for only when the village's stores cover it (no refusal spent on a known shortage).
//   2. A tile is claimed only when the ore covers its price AND the reserve stays behind:
//        reserve = the ore of OPERATOR_ORE_RESERVE.trainBatches training batches
//                + the ore of the troops still missing for the resident's next host (its upcoming expedition)
//                + the ore of its next village's settler cost (0 today: the settler pays food, wood, stone, gold).
//   3. Troops first while the resident is threatened (an own nation's keep near it is under contest — no tile then) or
//      its army is below one attack-capable host (armyFloor).
//   4. With the army at the floor and no threat, land and troops take turns: a tile (the reserve stays), then the
//      batch the reserve pays, then the next tile. The land's turn lasts only while a tile can actually be claimed.
// Every number is derived from the cost tables: the tile's price and the settler cost from the page's own modules
// (flocalplay-territory.mjs claimCostV1, flocalplay-wide.mjs settlerCost), the training cost from TRAIN_COST_PER_100
// below — the Spearman's row of permutation-rules catalog.rs TROOP_COST_PER_100 (the page's hud/rulebook.mjs
// TRAIN_PER_100), pinned against both by test/frontier-local-play-operator-ore-reserve.test.mjs. (rulebook.mjs itself
// is not imported: its closure reaches the march composer, and the key-free CI lane would then drop the policy's tests.)
//
// References compared (reports/ai-ore-reserve.md): Freeciv's default AI keeps a gold reserve before spending
// (dai_gold_reserve); 0 A.D. Petra gives each queue (military, economy …) its own account by priority and raises the
// military priority under attack; Unciv scores what to build and raises military when threatened. This is the first
// (a fixed reserve), with the third's threat switch; per-queue accounts were not needed for two spenders.
import { settlerCost } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { claimCostV1 } from '../../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';
import { MUSTER_MIN, TRAIN_BATCH } from './local-play-operator-war.mjs';

export const ORE = RESOURCE_ORDER.indexOf('Ore');
/** What a started hundred of Spearmen costs, by resource index (catalog.rs TROOP_COST_PER_100 = [food 60, ore 20, gold 10]). */
export const TRAIN_COST_PER_100 = Object.freeze(RESOURCE_ORDER.map(r => ({ Food: 60, Ore: 20, Gold: 10 })[r] ?? 0));
/** The cost of training `troops` Spearmen, by resource index (a started hundred is a whole one: catalog.rs train()). */
export const trainCostOf = troops => TRAIN_COST_PER_100.map(c => c * Math.ceil(Math.max(0, troops) / 100));
/**
 * The reserve's settings (the AI's own choice, not a rule of the world):
 *   trainBatches — training batches whose ore always stays behind a tile claim;
 *   batchTroops  — one batch (the war step's TRAIN_BATCH: 100 Spearmen);
 *   armyFloor    — troops (reserve + hosts) below which troops come before land (the war step's MUSTER_MIN: one host
 *                  that may march on a fresh keep).
 */
export const OPERATOR_ORE_RESERVE = Object.freeze({ trainBatches: 1, batchTroops: TRAIN_BATCH, armyFloor: MUSTER_MIN });

/** The ore (whole units) of training `troops` of the residents' unit, at today's cost table. */
export function trainOre(troops) {
  return trainCostOf(troops)[ORE];
}

/**
 * The ore that stays behind a tile claim. `army`: the resident's troops (reserve + hosts), or null when not known;
 * `hostGoal`: the troops its next host needs (0: none planned); `villagesHeld`: the villages it holds before its next
 * village claim, or null when none is planned; `threatened`: an own keep near it is under contest → Infinity (no tile).
 */
export function oreReserve({ army = null, hostGoal = 0, villagesHeld = null, threatened = false } = {}, cfg = OPERATOR_ORE_RESERVE) {
  if (threatened) return Infinity;
  const missing = Number.isFinite(army) ? Math.max(0, hostGoal - army) : hostGoal;
  const village = Number.isInteger(villagesHeld) ? settlerCost(villagesHeld)[ORE] ?? 0 : 0;
  return cfg.trainBatches * trainOre(cfg.batchTroops) + trainOre(missing) + village;
}

/** Whether `ore` pays the next tile of a resident owning `tiles` and leaves `reserve`. An unknown ore read does not block (as before). */
export function tilePays(ore, tiles, reserve) {
  return !Number.isFinite(ore) || ore >= claimCostV1(tiles) + reserve;
}

/** Whether `stores` (whole units by resource index) cover training `n` troops. Unknown stores do not block (as before). */
export function coversTrain(stores, n) {
  if (!Array.isArray(stores)) return true;
  return trainCostOf(n).every((x, i) => x <= (Number(stores[i]) || 0));
}

/**
 * Whose turn the ore is, for a resident that wants to train now: 'troops' | 'land'.
 * 'land' only when its army is at the floor, nothing threatens it, the ore is known, a tile can be claimed
 * (`landWanted`) and the last ore went to troops (`troopsTurn` false: a tile landed since → the troops' turn).
 */
export function oreTurn({ army = null, threatened = false, ore = null, landWanted = false, troopsTurn = false } = {}, cfg = OPERATOR_ORE_RESERVE) {
  if (threatened || !landWanted || troopsTurn || !Number.isFinite(ore)) return 'troops';
  if (!Number.isFinite(army) || army < cfg.armyFloor) return 'troops';
  return 'land';
}
