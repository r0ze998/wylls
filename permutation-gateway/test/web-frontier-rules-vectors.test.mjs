// The rule figures the web client computes itself (to explain an action
// before it is sent) against the rules crate: frontier-abi's
// vectors/v2/web-rules.json, written by `abi-vectors` from
// permutation-rules. A rule change the page does not follow fails here
// instead of showing a wrong price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trainingCost } from '../../permutation-server/web/frontier/fland.mjs';
import { settlerCost, siteWeight } from '../../permutation-server/web/frontier/fconquest.mjs';

const V = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/web-rules.json', import.meta.url), 'utf8'));
const units = milli => milli && milli.map(x => x / 1000);

test('training prices: fland.trainingCost is the rules catalog (M1 train, conquest train_v2)', () => {
  assert.ok(V.train_milli.length > 0);
  for (const r of V.train_milli) {
    assert.deepEqual(trainingCost(r.unit, r.n, 1), units(r.m1), `M1 unit ${r.unit} × ${r.n}`);
    assert.deepEqual(trainingCost(r.unit, r.n, 3), units(r.cq), `conquest unit ${r.unit} × ${r.n}`);
  }
});

test('settler cost: fconquest.settlerCost is duplicate_cost(SETTLER_COST, holdings)', () => {
  for (const r of V.settler_cost) assert.deepEqual(settlerCost(r.holdings), r.units, `${r.holdings} holdings`);
});

test('strength weights: fconquest.siteWeight is laurel::strength_weight', () => {
  for (const r of V.strength_weight) {
    assert.equal(siteWeight(r.tier, r.garrison_milli, r.order0), r.weight, `tier ${r.tier}, garrison ${r.garrison_milli}, order ${r.order0}`);
  }
});
