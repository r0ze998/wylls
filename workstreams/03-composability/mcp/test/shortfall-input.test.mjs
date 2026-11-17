// WRITTEN, NOT RUN (Lane C, 2026-11-17): no part of this file has been executed. It imports src/game.mjs, whose static
// closure (read, not run) reaches permutation-server/web/frontier/fland.mjs and web/lang.mjs (subjects of refused tests)
// and files that name key APIs (fplay.mjs, session.mjs, the vendored noble curves). It is therefore NOT claimed
// independent or key-free: whether and how it may run is the coordinator's decision, through the repository's key-free
// guard only, never by another route.
//
// check_resource_shortfall's goal.amounts follows the tool's schema (tools.mjs cargoSchema: an object of known resources,
// each an integer 0..1000000; omitted resources are 0). tools/call does not check the schema, so Game.shortfall does:
//   I1 a value outside the schema is BadRequest, never read as 0 (before: -5, 1.5, "300" became 0 and could say enough)
//   I2 an amounts that is not an object (an array, null, text) is BadRequest
//   I3 unchanged: an unknown resource is BadRequest with the same message; omitted resources are 0; valid amounts,
//      the vault goal, hoursByProduction and enough behave as before
// Views are plain objects (Game.shortfall reads view.resources, view.village.stores, view.places, view.feedOk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.mjs';

const R = ['Food', 'Wood', 'Stone', 'Ore', 'Arms', 'Gold', 'Science', 'Influence'];
const stores = have => R.map((r, i) => ({ resource: r, have: have[i] ?? 0, perHour: i === 2 ? 10 : 0, cap: 100000 }));
const view = have => ({ resources: R, village: { kind: 'holding', placeId: 'holding:1,1,0', stores: stores(have) }, places: [], feedOk: true });
const V = view([0, 0, 100]);
const refused = (amounts, re) => assert.throws(() => Game.shortfall(V, { kind: 'amounts', amounts }), e => e?.code === 'BadRequest' && re.test(e.message), JSON.stringify(amounts));

test('I1 a value outside the schema is BadRequest, never 0', () => {
  for (const v of [-5, -1, 1.5, '300', '', null, true, NaN, Infinity, 1_000_001, 2 ** 53, [], {}]) {
    refused({ Stone: v }, /^amounts\.Stone must be a whole amount from 0 to 1000000$/);
  }
  refused({ Stone: 300, Wood: -1 }, /^amounts\.Wood must be/);
});

test('I2 amounts that is not an object is BadRequest', () => {
  for (const amounts of [[], [300], null, 'Stone', 300]) {
    assert.throws(() => Game.shortfall(V, { kind: 'amounts', amounts }), e => e?.code === 'BadRequest', JSON.stringify(amounts));
  }
});

test('I3 unchanged: unknown resource message, omitted = 0, bounds 0 and 1000000 accepted', () => {
  refused({ Mana: 1 }, /^unknown resource Mana \(one of Food, Wood, Stone, Ore, Arms, Gold, Science, Influence\)$/);
  const s = Game.shortfall(V, { kind: 'amounts', amounts: { Stone: 300 } });
  assert.deepEqual(s.rows, [{ resource: 'Stone', need: 300, have: 100, short: 200, perHour: 10, hoursByProduction: 20 }]);
  assert.equal(s.enough, false);
  const zero = Game.shortfall(V, { kind: 'amounts', amounts: { Stone: 0 } });
  assert.deepEqual([zero.rows, zero.enough], [[], true], 'need 0 is no row; nothing short');
  const top = Game.shortfall(V, { kind: 'amounts', amounts: { Stone: 1_000_000 } });
  assert.equal(top.rows[0].short, 999_900);
  const empty = Game.shortfall(V, { kind: 'amounts', amounts: {} });
  assert.deepEqual([empty.rows, empty.enough], [[], true]);
});

test('I3 unchanged: the vault goal, and a goal that is neither', () => {
  const s = Game.shortfall(V, { kind: 'vault' });
  assert.ok(s.rows.length > 0);
  assert.equal(s.enough, false);
  for (const goal of [undefined, null, {}, { kind: 'other' }, { kind: 'amounts' }]) {
    assert.throws(() => Game.shortfall(V, goal), e => e?.code === 'BadRequest', JSON.stringify(goal));
  }
});
