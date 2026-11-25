// ai-ore-reserve (owner 2026-11-25 09:33 JST, Q-LP15-4 (b); loop-play15 LP15-5): operator AI residents keep an ore
// reserve for their troops before they buy land. Key-free, pure: the reserve's numbers and the policy over a stated view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentMemory, decideNext, noteOutcome, OPERATOR_ORE_RESERVE, WIDE_HOST_TROOPS } from '../src/frontier/local-play-operator-policy.mjs';
import { oreReserve, trainOre, trainCostOf, tilePays, coversTrain, oreTurn, ORE, TRAIN_COST_PER_100 } from '../src/frontier/local-play-operator-reserve.mjs';
import { MUSTER_MIN, TRAIN_BATCH } from '../src/frontier/local-play-operator-war.mjs';
import { readFileSync } from 'node:fs';
import { claimCostV1 } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { settlerCost } from '../../permutation-server/web/frontier/flocalplay-wide.mjs';

const RIM = { joined: true, faction: 1, holding: { p: 128, q: 0, site: 2, tile: 30 }, wide: 0 };
const TERR = { siteTiles: [5, 9, 14, 20, 25, 33, 40, 44, 48, 52, 56, 60], keepTile: 30 };
// stores by resource index: Food, Wood, Stone, Ore, Horses, Gold, Science, Influence
const stores = ore => [500, 500, 500, ore, 0, 500, 0, 0];
const OWN = [{ p: '129', q: '0', tile: 5 }, { p: '129', q: '0', tile: 6 }];
const wideOf = (ore, extra = {}) => ({ targets: [{ p: '129', q: '0', territory: TERR }], canClaim: false, ore, stores: stores(ore), ...extra });
const warOf = (extra = {}) => ({ nowBell: 50, reserve: 0, hostCount: 0, march: null, settling: false, army: 0, threatened: false, ...extra });
/** A war resident past its village claims, owning two tiles (growth is its only land step). */
const grower = () => { const m = createResidentMemory(0, undefined, { war: true }); m.ownTiles = OWN.map(o => ({ ...o })); m.claims = 2; m.decisions = 4; return m; };

test('the reserve is derived from the cost tables: one batch, the missing host, the next village', () => {
  // the training cost is the rules' own: catalog.rs TROOP_COST_PER_100 [food, ore, gold] and the page's rulebook
  const catalog = readFileSync(new URL('../../permutation-rules/src/frontier/catalog.rs', import.meta.url), 'utf8');
  const [food, oreC, gold] = /pub const TROOP_COST_PER_100: \[i64; 3\] = \[(\d+), (\d+), (\d+)\];/.exec(catalog).slice(1).map(Number);
  assert.deepEqual([...TRAIN_COST_PER_100], [food, 0, 0, oreC, 0, gold, 0, 0]);
  const rulebook = readFileSync(new URL('../../permutation-server/web/frontier/hud/rulebook.mjs', import.meta.url), 'utf8');
  assert.match(rulebook, new RegExp(`TRAIN_PER_100 = Object\\.freeze\\(\\{ food: ${food}, ore: ${oreC}, gold: ${gold}, baseProd: 6 \\}\\)`));
  assert.deepEqual(trainCostOf(101), TRAIN_COST_PER_100.map(c => 2 * c), 'a started hundred is a whole one');
  const batch = trainCostOf(TRAIN_BATCH)[ORE];
  assert.equal(OPERATOR_ORE_RESERVE.trainBatches, 1);
  assert.equal(OPERATOR_ORE_RESERVE.batchTroops, TRAIN_BATCH);
  assert.equal(OPERATOR_ORE_RESERVE.armyFloor, MUSTER_MIN);
  assert.equal(trainOre(TRAIN_BATCH), batch);
  assert.equal(batch, 20, 'today: 100 Spearmen cost 20 ore');
  assert.equal(oreReserve(), batch, 'nothing planned: one batch');
  assert.equal(oreReserve({ army: 0, hostGoal: MUSTER_MIN }), batch + trainCostOf(MUSTER_MIN)[ORE], 'no army: the whole host too');
  assert.equal(oreReserve({ army: 250, hostGoal: MUSTER_MIN }), batch + trainCostOf(50)[ORE], 'a started hundred is a whole batch');
  assert.equal(oreReserve({ army: 900, hostGoal: MUSTER_MIN }), batch);
  assert.equal(oreReserve({ villagesHeld: 1 }), batch + settlerCost(1)[ORE], 'the next village (no ore today)');
  assert.equal(oreReserve({ threatened: true }), Infinity);
  assert.equal(oreReserve({}, { ...OPERATOR_ORE_RESERVE, trainBatches: 3 }), 3 * batch, 'the setting is the one knob');
  assert.equal(tilePays(claimCostV1(5) + batch - 1, 5, batch), false);
  assert.equal(tilePays(claimCostV1(5) + batch, 5, batch), true);
  assert.equal(tilePays(null, 5, batch), true, 'an unknown ore read does not block (as before)');
  assert.equal(coversTrain(null, 100), true, 'unknown stores do not block (as before)');
  assert.equal(coversTrain(stores(19), 100), false);
  assert.equal(coversTrain(stores(20), 100), true);
  assert.equal(coversTrain([59, 0, 0, 20, 0, 10, 0, 0], 100), false, 'food short counts too');
  assert.equal(oreTurn({ army: MUSTER_MIN, ore: 40, landWanted: true }), 'land');
  assert.equal(oreTurn({ army: MUSTER_MIN - 1, ore: 40, landWanted: true }), 'troops');
  assert.equal(oreTurn({ army: 999, ore: 40, landWanted: true, threatened: true }), 'troops');
  assert.equal(oreTurn({ army: 999, ore: 40, landWanted: true, troopsTurn: true }), 'troops');
  assert.equal(oreTurn({ army: 999, ore: 40, landWanted: false }), 'troops');
  assert.equal(oreTurn({ army: 999, ore: null, landWanted: true }), 'troops');
});

test('LP15-5: a war resident below its army floor trains with the ore, and buys no tile with it', () => {
  const m = grower();
  // ore for one batch: Train (before: a tile was bought whenever a refused Train was cooling)
  let d = decideNext(m, RIM, { homes: [], war: warOf(), wide: wideOf(20) });
  assert.equal(d.name, 'Train');
  // a refused Train cools; meanwhile 30 ore would pay a tile + one batch, but the host is still missing 300 troops
  m.cooldown['war:Train'] = 60;
  d = decideNext(m, RIM, { homes: [], war: warOf(), wide: wideOf(30) });
  assert.notEqual(d.name, 'TerritoryClaim');
  // only with the tile, one batch and the whole missing host covered
  const need = claimCostV1(2) + oreReserve({ army: 0, hostGoal: MUSTER_MIN });
  assert.notEqual(decideNext(m, RIM, { homes: [], war: warOf(), wide: wideOf(need - 1) }).name, 'TerritoryClaim');
  assert.equal(decideNext(m, RIM, { homes: [], war: warOf(), wide: wideOf(need) }).name, 'TerritoryClaim');
});

test('a Train the stores do not cover is not asked for (no refusal spent): the economy instead', () => {
  const m = grower();
  const d = decideNext(m, RIM, { homes: [], war: warOf(), wide: wideOf(19) });
  assert.ok(d.name === 'Harvest' || d.name === 'Build', `got ${d.name}`);
  // unknown stores: Train as before
  assert.equal(decideNext(m, RIM, { homes: [], war: warOf(), wide: { targets: [], canClaim: false } }).name, 'Train');
  // a resident with no host for the wide land (not at war): the same check
  const p = createResidentMemory(0);
  p.claims = 2;
  const need = { needHost: { reserve: 0 } };
  assert.notEqual(decideNext(p, RIM, { homes: [], wide: wideOf(trainOre(WIDE_HOST_TROOPS) - 1, need) }).wideHost, true);
  const t = decideNext(p, RIM, { homes: [], wide: wideOf(trainOre(WIDE_HOST_TROOPS), need) });
  assert.equal(t.name, 'Train');
  assert.equal(t.fields.n, WIDE_HOST_TROOPS);
});

test('threatened (an own keep near it under contest): troops only, no tile however much ore', () => {
  const m = grower();
  const war = warOf({ army: 900, reserve: 0, threatened: true });
  assert.equal(decideNext(m, RIM, { homes: [], war, wide: wideOf(5000) }).name, 'Train');
  m.cooldown['war:Train'] = 60;
  assert.notEqual(decideNext(m, RIM, { homes: [], war, wide: wideOf(5000) }).name, 'TerritoryClaim');
  // a defence march chosen counts as a threat too (the snapshot's flag may lag a turn)
  const m2 = grower();
  m2.cooldown['war:Depart'] = 60; m2.cooldown['war:Train'] = 60;
  const d = decideNext(m2, RIM, { homes: [], war: warOf({ army: 900, march: { kind: 'defend', row: { p: 1, q: 0 } } }), wide: wideOf(5000) });
  assert.notEqual(d.name, 'TerritoryClaim');
});

test('army at the floor, no threat: land and troops take turns, and the reserve always pays the batch', () => {
  const m = grower();
  const war = warOf({ army: MUSTER_MIN, reserve: 0, hostCount: 1 });
  const tile = claimCostV1(2), batch = trainOre(TRAIN_BATCH);
  // the land's turn: saving — no Train though the ore covers it, no tile yet
  let d = decideNext(m, RIM, { homes: [], war, wide: wideOf(tile + batch - 1) });
  assert.ok(d.name === 'Harvest' || d.name === 'Build', `saving, got ${d.name}`);
  // tile + reserve: the tile
  d = decideNext(m, RIM, { homes: [], war, wide: wideOf(tile + batch) });
  assert.equal(d.name, 'TerritoryClaim');
  noteOutcome(m, d, 'landed');
  assert.equal(m.troopsTurn, true);
  // the reserve left behind is the next batch
  d = decideNext(m, RIM, { homes: [], war, wide: wideOf(batch) });
  assert.equal(d.name, 'Train');
  noteOutcome(m, d, 'landed');
  assert.equal(m.troopsTurn, false);
  // and the land's turn again
  m.decisions = 8;
  d = decideNext(m, RIM, { homes: [], war, wide: wideOf(claimCostV1(3) + batch) });
  assert.equal(d.name, 'TerritoryClaim');
});

test('the land\'s turn never starves the troops: no tile to claim → Train', () => {
  const m = grower();
  m.ownTiles = [];                       // no land of its own and no village claim due: nothing to buy
  const war = warOf({ army: MUSTER_MIN, hostCount: 1 });
  assert.equal(decideNext(m, RIM, { homes: [], war, wide: wideOf(500) }).name, 'Train');
  // a claim cooling after a refusal is still the land's turn (it passes); a tile refused for good leaves the list
  const m2 = grower();
  let d = decideNext(m2, RIM, { homes: [], war, wide: wideOf(500) });
  assert.equal(d.name, 'TerritoryClaim');
  noteOutcome(m2, d, 'refused', { programCode: 29 });
  assert.notEqual(decideNext(m2, RIM, { homes: [], war, wide: wideOf(500) }).name, 'Train');
});

test('the site tile of the next village keeps the reserve too; the village claim itself is unchanged', () => {
  const m = createResidentMemory(0);
  const wide = ore => ({ targets: [{ p: '129', q: '0', territory: TERR, reach: { p: '129', q: '1' } }], canClaim: true, ore, stores: stores(ore) });
  const need = claimCostV1(0) + oreReserve({ villagesHeld: 1 });
  assert.equal(decideNext(m, RIM, { homes: [], wide: wide(need - 1) }).name, 'Harvest');
  const d = decideNext(m, RIM, { homes: [], wide: wide(need) });
  assert.equal(d.name, 'TerritoryClaim');
  noteOutcome(m, d, 'landed');
  assert.equal(decideNext(m, RIM, { homes: [], wide: wide(0) }).name, 'WideClaim', 'the settler cost has no ore: not held back');
});

test('deterministic: the same memory and view give the same decision', () => {
  const run = () => { const m = grower(); return JSON.stringify(decideNext(m, RIM, { homes: [], war: warOf({ army: MUSTER_MIN }), wide: wideOf(64) })); };
  assert.equal(run(), run());
});
