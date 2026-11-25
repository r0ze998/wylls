// ai-early-mine (owner 2026-11-25 17:58 JST, Q-AOR-1 (b)): each operator AI resident builds ONE mine early — its
// village's first command, the page's own Build item 3 at the page's own price. Key-free, pure: the numbers against
// the rules' tables, the mine count from a village's record, and the policy over a stated view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResidentMemory, decideNext, noteOutcome, residentView, OPERATOR_EARLY_MINE, OPERATOR_COOLDOWN, OPERATOR_ROTATION } from '../src/frontier/local-play-operator-policy.mjs';
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
