// ai-early-mine (owner 2026-11-25 17:58 JST, Q-AOR-1 (b)): each operator AI resident builds ONE mine early — its
// village's first command, the page's own Build item 3 at the page's own price. Key-free, pure: the numbers against
// the rules' tables, the mine count from a village's record, and the policy over a stated view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResidentMemory, decideNext, noteOutcome, residentView, OPERATOR_EARLY_MINE, OPERATOR_COOLDOWN, OPERATOR_ROTATION, OPERATOR_VILLAGE_SAVING, OPERATOR_WIDE_CLAIMS } from '../src/frontier/local-play-operator-policy.mjs';
import { savingCapsTrain, TRAIN_COST_PER_100 } from '../src/frontier/local-play-operator-reserve.mjs';
import { MUSTER_MIN } from '../src/frontier/local-play-operator-war.mjs';
import { MINE_COST, MINE_PER_HOUR_MILLI, ORE_BASE_MILLI, minesOf, coversMine, earlyMineDue, noteEarlyMine } from '../src/frontier/local-play-operator-mine.mjs';

// stores by resource index: Food, Wood, Stone, Ore, Horses, Gold, Science, Influence
const STARTER = [300, 300, 200, 100, 0, 100, 0, 0];
const FREE = { doneAt: 0n, kind: 0, arg: 0, delta: 0n };
/** A village's record as the page's decoder gives it: `ore` thousandths an hour, `terrain` its recorded terrain ore. */
const record = ({ ore = 4000n, terrain = 4000n, tier = 0, queue = [FREE, FREE, FREE, FREE] } = {}) => ({ tier, terrainOre: terrain, production: [40000n, 30000n, 20000n, ore, 0n, 15000n, 5000n, 0n], queue });
const viewOf = (decoded, extra = {}) => ({ joined: true, faction: 1, holding: Object.defineProperty({ p: 128, q: 0, site: 2, tile: 30 }, 'decoded', { value: decoded, enumerable: false }), wide: 0, ...extra });
const wideOf = (stores = STARTER, extra = {}) => ({ targets: [], canClaim: false, ore: stores[3], stores, ...extra });
const warOf = (extra = {}) => ({ nowBell: 50, reserve: 0, hostCount: 0, march: null, settling: false, army: 0, threatened: false, ...extra });

test('the mine is the rules\' own: Build item 3, its cost and yield pinned against catalog.rs and the page\'s list', () => {
  const catalog = readFileSync(new URL('../../permutation-rules/src/frontier/catalog.rs', import.meta.url), 'utf8');
  const m = /resource: Resource::Ore,\s+per_hour: (\d+),\s+cost: \[([\d, ]+)\],/.exec(catalog);
  assert.ok(m, 'catalog.rs BUILDINGS has the ore building');
  assert.equal(BigInt(m[1]) * 1000n, MINE_PER_HOUR_MILLI);
  assert.deepEqual(m[2].split(',').map(s => Number(s.trim())), [...MINE_COST]);
  // (the ore building is the fourth of BUILDINGS: item id 3)
  const kinds = [...catalog.slice(catalog.indexOf('pub const BUILDINGS'), catalog.indexOf('pub const ITEM_WALLS')).matchAll(/resource: Resource::(\w+)/g)].map(x => x[1]);
  assert.equal(kinds.indexOf('Ore'), OPERATOR_EARLY_MINE.item);
  const fland = readFileSync(new URL('../../permutation-server/web/frontier/fland.mjs', import.meta.url), 'utf8');
  assert.ok(fland.includes(`{ item: 3, resource: 'Ore', perHour: 6, cost: [${MINE_COST.join(', ')}] }`), 'the page offers the same building at the same price');
  assert.match(fland, /export const BASE_PROD = Object\.freeze\(\[40, 30, 20, 15, /);
  assert.equal(ORE_BASE_MILLI, 15000n);
  assert.deepEqual({ ...OPERATOR_EARLY_MINE }, { item: 3, copies: 1, tries: 3 }, 'one mine, at most three asks');
  assert.deepEqual([...MINE_COST], [40, 80, 20, 0, 0, 0, 0, 0], 'today: food 40, wood 80, stone 20');
  assert.ok(!OPERATOR_ROTATION.some(a => a.name === 'Build' && a.item === 3), 'the rotation itself is unchanged: farm, woodcutter, quarry');
});

test('minesOf: built mines above the village\'s own ore base, plus the ones under way; null when the record does not tell', () => {
  assert.equal(minesOf(record()), 0, 'a fresh village: 4 ore an hour, all terrain');
  assert.equal(minesOf(record({ ore: 34000n, terrain: 34000n })), 0, 'rich terrain is not a mine');
  assert.equal(minesOf(record({ ore: 10000n })), 1);
  assert.equal(minesOf(record({ ore: 46000n, terrain: 34000n })), 2);
  assert.equal(minesOf(record({ queue: [{ doneAt: 99n, kind: 1, arg: 3, delta: 6000n }, FREE, FREE, FREE] })), 1, 'a mine under way counts');
  assert.equal(minesOf(record({ queue: [{ doneAt: 99n, kind: 1, arg: 0, delta: 12000n }, { doneAt: 0n, kind: 1, arg: 3, delta: 0n }, FREE, FREE] })), 0, 'a farm under way and a free slot do not');
  assert.equal(minesOf(record({ ore: 15000n, terrain: 0n })), 0, 'no terrain ore recorded: the catalog\'s 15 an hour');
  assert.equal(minesOf(record({ ore: 21000n, terrain: 0n })), 1);
  assert.equal(minesOf(record({ tier: 1 })), null, 'a promoted village: its base carries the tier\'s bonus, not read here');
  assert.equal(minesOf(record({ ore: 3000n })), null, 'ore below the base: not understood');
  assert.equal(minesOf({ tier: 0 }), null);
  assert.equal(minesOf(null), null);
  assert.equal(minesOf(undefined), null);
});

test('earlyMineDue: a known count below one, stores that pay, no threat, no cooling, at most three asks', () => {
  const m = createResidentMemory(0);
  assert.equal(earlyMineDue(m, { mines: 0, stores: STARTER }), true);
  assert.equal(earlyMineDue(m, { mines: 0, stores: null }), true, 'unknown stores do not block (as everywhere in the policy)');
  assert.equal(earlyMineDue(m, { mines: null, stores: STARTER }), false, 'the record does not tell: no mine on a guess');
  assert.equal(earlyMineDue(m, { mines: 1, stores: STARTER }), false);
  assert.equal(earlyMineDue(m, { mines: 0, stores: STARTER, threatened: true }), false);
  assert.equal(earlyMineDue(m, { mines: 0, stores: STARTER, cooling: true }), false);
  for (const [i, short] of [[0, 39], [1, 79], [2, 19]]) {
    const s = STARTER.slice(); s[i] = short;
    assert.equal(coversMine(s), false); assert.equal(earlyMineDue(m, { mines: 0, stores: s }), false);
    s[i] = short + 1; assert.equal(coversMine(s), true);
  }
  noteEarlyMine(m, 'refused'); noteEarlyMine(m, 'failed');
  assert.equal(earlyMineDue(m, { mines: 0, stores: STARTER }), true, 'two asks: one more');
  noteEarlyMine(m, 'unknown');
  assert.deepEqual(m.mine, { asks: 3, landed: 0 });
  assert.equal(earlyMineDue(m, { mines: 0, stores: STARTER }), false, 'three asks: given up');
  const l = createResidentMemory(1); noteEarlyMine(l, 'landed');
  assert.equal(earlyMineDue(l, { mines: 0, stores: STARTER }), false, 'landed by its own memory: not again while the herald\'s record lags');
});

test('a resident\'s first village command is the mine — at war or not, in a wide world or not — then everything as before', () => {
  for (const [label, war, opts] of [
    ['peaceful, not wide (stores unknown)', false, {}],
    ['peaceful, wide', false, { wide: wideOf() }],
    ['war, wide', true, { war: warOf(), wide: wideOf() }],
    ['war, wide, a ready host and an attack chosen', true, { war: warOf({ reserve: 300, army: 300, march: { kind: 'attack', row: { p: 1, q: 0, troops: 50, origin: { troops: 300 } } } }), wide: wideOf() }],
  ]) {
    const m = createResidentMemory(0, undefined, { war });
    const fresh = viewOf(record());
    const d = decideNext(m, fresh, { homes: [], ...opts });
    assert.equal(d.name, 'Build', label);
    assert.deepEqual(d.fields, { item: 3 }, label);
    assert.deepEqual(d.v, { holding: { p: 128, q: 0, site: 2 }, item: 3 }, 'the page\'s own Build order shape');
    assert.equal(d.earlyMine, true);
    assert.equal(d.rotationStep, undefined, 'not a rotation step: the rotation starts where it did');
    noteOutcome(m, d, 'landed');
    assert.deepEqual(m.mine, { asks: 1, landed: 1 });
    assert.equal(m.step, 0);
    // the herald still shows the old record (a turn's lag): no second mine
    const stale = decideNext(m, fresh, { homes: [], ...opts });
    assert.notEqual(stale.earlyMine, true, label);
    // the record shows the mine under way, then built: never again, even for a resident with no memory of it (a restart)
    for (const rec of [record({ queue: [{ doneAt: 77n, kind: 1, arg: 3, delta: 6000n }, FREE, FREE, FREE] }), record({ ore: 10000n })]) {
      const after = decideNext(createResidentMemory(0, undefined, { war }), viewOf(rec), { homes: [], ...opts });
      assert.notEqual(after.earlyMine, true, label);
      assert.deepEqual(after, decideNext(createResidentMemory(0, undefined, { war }), viewOf(undefined), { homes: [], ...opts }), `${label}: with its mine, exactly the decision of before this rule`);
    }
  }
});

test('not while threatened, not when the stores do not pay, not on an unreadable record', () => {
  const fresh = viewOf(record());
  const war = () => createResidentMemory(0, undefined, { war: true });
  const defend = { kind: 'defend', row: { p: 1, q: 0, troops: 50, origin: { troops: 300 } } };
  assert.equal(decideNext(war(), fresh, { homes: [], war: warOf({ reserve: 300, army: 300, march: defend }), wide: wideOf() }).name, 'Depart', 'a defence march first');
  assert.notEqual(decideNext(war(), fresh, { homes: [], war: warOf({ threatened: true }), wide: wideOf() }).earlyMine, true, 'an own keep nearby under contest: troops first');
  const poor = STARTER.slice(); poor[1] = 79;
  assert.notEqual(decideNext(war(), fresh, { homes: [], war: warOf(), wide: wideOf(poor) }).earlyMine, true, 'wood 79 of 80: no refusal spent');
  poor[1] = 80;
  assert.equal(decideNext(war(), fresh, { homes: [], war: warOf(), wide: wideOf(poor) }).earlyMine, true);
  for (const v of [viewOf(undefined), viewOf(record({ tier: 1 })), viewOf({})])
    assert.notEqual(decideNext(war(), v, { homes: [], war: warOf(), wide: wideOf() }).earlyMine, true);
  // no village yet: the home first, as before
  assert.equal(decideNext(createResidentMemory(0), { joined: true, faction: 1, holding: null, wide: 0 }, { homes: [{ p: 0, q: 1, nation: 1 }] }).name, 'PlaceHome');
});

test('a refused mine cools like any Build and is asked at most three times; an unknown answer is never followed blindly', () => {
  const m = createResidentMemory(0);
  const fresh = viewOf(record());
  const opts = { homes: [], wide: wideOf() };
  for (let ask = 1; ask <= OPERATOR_EARLY_MINE.tries; ask++) {
    const d = decideNext(m, fresh, opts);
    assert.equal(d.earlyMine, true, `ask ${ask}`);
    noteOutcome(m, d, ask === 2 ? 'unknown' : ask === 1 ? 'refused' : 'failed', { code: 'Insufficient' });
    assert.equal(m.mine.asks, ask);
    for (let k = 0; k < OPERATOR_COOLDOWN; k++) {
      const other = decideNext(m, fresh, opts);
      assert.notEqual(other.earlyMine, true, `cooling after ask ${ask}`);
      noteOutcome(m, other, 'landed');
    }
  }
  for (let k = 0; k < 12; k++) {
    const d = decideNext(m, fresh, opts);
    assert.notEqual(d.earlyMine, true, 'given up after three asks');
    noteOutcome(m, d, 'landed');
  }
  assert.deepEqual(m.mine, { asks: 3, landed: 0 });
});

test('residentView carries the village\'s record to the policy: a decoded fresh village asks for its mine', () => {
  const rec = { ...record(), p: 128n, q: 0n, site: 2, tile: 30 };
  const decode = kind => (kind === 'Citizen' ? { faction: 1 } : rec);
  const view = residentView({ v: 1, citizen: { bytes_b64: '' }, holdings: [{ bytes_b64: '' }] }, decode);
  assert.equal(minesOf(view.holding.decoded), 0);
  assert.equal(decideNext(createResidentMemory(0), view, { homes: [] }).earlyMine, true);
});

// ---- owner 2026-11-25 20:03 Q-AEM-1 (b): until the next wide-land village is built, troops are capped at one host
// (300) and the food and gold are saved for the village; after it, the resident trains freely again.

test('Q-AEM-1 (b) savingCapsTrain: one host is the cap, only while the first wide village is still to come', () => {
  assert.deepEqual({ ...OPERATOR_VILLAGE_SAVING }, { troopCap: 300 });
  assert.equal(OPERATOR_VILLAGE_SAVING.troopCap, MUSTER_MIN, 'one host: the war step\'s own muster size');
  assert.equal(savingCapsTrain({ villagePlanned: true, wideVillages: 0, army: 300 }), true);
  assert.equal(savingCapsTrain({ villagePlanned: true, wideVillages: 0, army: 1200 }), true);
  assert.equal(savingCapsTrain({ villagePlanned: true, wideVillages: 0, army: 299 }), false, 'below the cap: it still trains');
  assert.equal(savingCapsTrain({ villagePlanned: true, wideVillages: 0, army: 0 }), false);
  assert.equal(savingCapsTrain({ villagePlanned: true, wideVillages: 1, army: 300 }), false, 'the village is built: free again');
  assert.equal(savingCapsTrain({ villagePlanned: false, wideVillages: 0, army: 300 }), false, 'no village to save for');
  assert.equal(savingCapsTrain({ villagePlanned: true, wideVillages: 0, army: null }), false, 'an unknown troop count does not block');
  assert.equal(savingCapsTrain(), false);
});

test('Q-AEM-1 (b) a war resident with one host and no wide village yet does not train: it saves for the village', () => {
  const built = viewOf(record({ ore: 10000n }));            // its mine stands
  const rich = [900, 900, 500, 200, 0, 300, 0, 0];           // stores that pay a training, not asked about
  const target = { p: -66, q: 130 };
  const war = () => createResidentMemory(0, undefined, { war: true });
  const opts = (army, wideExtra = {}, warExtra = {}) => ({ homes: [], war: warOf({ reserve: 0, army, hostCount: 1, ...warExtra }), wide: wideOf(rich, { targets: [target], ...wideExtra }) });
  // below the cap: the war step's Train, as before
  for (const army of [0, 100, 299]) {
    const d = decideNext(war(), built, opts(army));
    assert.equal(d.name, 'Train', `army ${army}`); assert.equal(d.war, true); assert.deepEqual(d.fields, { unit: 0, n: 100 });
  }
  // at the cap and above: no Train; the wide step saves (Harvest) until the stores cover the settler cost
  for (const army of [300, 400, 900]) {
    const d = decideNext(war(), built, opts(army));
    assert.equal(d.name, 'Harvest', `army ${army}`);
    assert.match(d.why, /saving for a wide claim/);
  }
  // the stores cover the village: it is claimed
  const claim = decideNext(war(), built, opts(300, { canClaim: true }));
  assert.equal(claim.name, 'WideClaim');
  // the cap is not a rule against fighting: a march the war step chose still departs, a reserve still musters
  assert.equal(decideNext(war(), built, opts(300, {}, { march: { kind: 'attack', row: { p: 1, q: 0, troops: 50, origin: { troops: 300 } } } })).name, 'Depart');
  assert.equal(decideNext(war(), viewOf(record({ ore: 10000n })), opts(600, {}, { reserve: 300, hostCount: 1 })).name, 'Muster');
  // a host on the march counts (the village's transit record carries its troops at departure, thousandths)
  const away = (state, depMass) => viewOf({ ...record({ ore: 10000n }), transit: [{ state, depMass }, { state: 0, depMass: 0 }] });
  assert.equal(decideNext(war(), away(2, 300000), opts(0)).name, 'Harvest', 'its one host is marching: no second one is trained');
  assert.equal(decideNext(war(), away(2, 200000), opts(100)).name, 'Harvest', '200 marching + 100 at home');
  assert.equal(decideNext(war(), away(2, 200000), opts(99)).name, 'Train', '299 in all: below the cap');
  assert.equal(decideNext(war(), away(0, 300000), opts(0)).name, 'Train', 'a free transit record counts nothing');
  // settling turn: the war step's Train is capped the same way
  assert.notEqual(decideNext(war(), built, opts(300, {}, { settling: true })).name, 'Train');
  assert.equal(decideNext(war(), built, opts(200, {}, { settling: true })).name, 'Train');
});

test('Q-AEM-1 (b) with the village built — or none claimable — the resident trains freely again', () => {
  const rich = [900, 900, 500, 200, 0, 300, 0, 0];
  const target = { p: -66, q: 130 };
  const war = () => createResidentMemory(0, undefined, { war: true });
  const wopts = (targets = [target]) => ({ homes: [], war: warOf({ reserve: 0, army: 300, hostCount: 1 }), wide: wideOf(rich, { targets }) });
  // the herald's record counts a wide village
  assert.equal(decideNext(war(), viewOf(record({ ore: 10000n }), { wide: 1 }), wopts()).name, 'Train');
  // its own landed claim (the record may lag): through noteOutcome, as live
  const m = war();
  const c = decideNext(m, viewOf(record({ ore: 10000n })), { ...wopts(), wide: wideOf(rich, { targets: [target], canClaim: true }) });
  assert.equal(c.name, 'WideClaim');
  noteOutcome(m, c, 'landed');
  assert.equal(m.claims, 1);
  for (let k = 0; k < 8; k++) m.decisions += 1;             // (past the claim's settle wait)
  assert.equal(decideNext(m, viewOf(record({ ore: 10000n })), wopts()).name, 'Train', 'after its village: troops again, above one host');
  // no wide land in reach: nothing to save for
  assert.equal(decideNext(war(), viewOf(record({ ore: 10000n })), wopts([])).name, 'Train');
  // not a wide world at all
  assert.equal(decideNext(war(), viewOf(record({ ore: 10000n })), { homes: [], war: warOf({ reserve: 0, army: 300, hostCount: 1 }) }).name, 'Train');
  // every site of the reachable land was refused: no village can come, so no cap for ever
  const tried = war(); tried.triedClaims = Array.from({ length: 12 }, (_, site) => `${target.p},${target.q},${site}`);
  assert.equal(decideNext(tried, viewOf(record({ ore: 10000n })), wopts()).name, 'Train');
  // both claims used
  const done = war(); done.claims = OPERATOR_WIDE_CLAIMS;
  assert.equal(decideNext(done, viewOf(record({ ore: 10000n })), wopts()).name, 'Train');
});

test('Q-AEM-1 (b) what the cap saves: a training is food 60 and gold 10 a hundred (catalog.rs), the village food and gold', () => {
  assert.deepEqual([...TRAIN_COST_PER_100], [60, 0, 0, 20, 0, 10, 0, 0]);
});
