// H6: newcomers, small nations, losing nations and people who do not
// cooperate have a choice other than waiting or following.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { load } from './helpers.mjs';

const ROLES = {
  newcomer: 'new-0', // joined n5 at bell 80 with 50 food
  small: 'n5-0', // n5: one member before the newcomer, no keep
  losing: 'n4-1', // n4: one keep, smallest standing with goods
  nonCooperator: 'n2-2', // never put anything in
};

for (const k of ['A', 'B', 'C']) {
  test(`${k}: every role has an independent option at bell 90`, () => {
    const v = evaluate(RULESETS[k], load('roles-midway'));
    assert.equal(v.options.at, 90);
    for (const [role, id] of Object.entries(ROLES)) {
      const o = v.options.byActor[id];
      assert.ok(o, `${role} ${id} is known`);
      assert.ok(o.independent >= 1, `${role}: ${JSON.stringify(o.options.map(x => x.kind))}`);
      if (k !== 'A') assert.ok(o.independentWithGoal >= 1, `${role} has an independent option toward a goal of ${k}`);
    }
  });
}

test('A has no goal behind any option (cooperation earns nothing there): the difference D6', () => {
  const v = evaluate(RULESETS.A, load('roles-midway'));
  for (const id of Object.values(ROLES)) assert.equal(v.options.byActor[id].independentWithGoal, 0);
  assert.equal(v.awards.length, 0);
});

test('the newcomer\'s only goods (50 food) fit no project, yet they are not left with wait', () => {
  const v = evaluate(RULESETS.B, load('roles-midway'));
  const o = v.options.byActor['new-0'].options;
  assert.equal(o.filter(x => x.category === 'follow').length, 0);
  assert.ok(o.some(x => x.kind === 'use-foreign-structure'));
  assert.ok(o.some(x => x.kind === 'open-project'));
});

test('after the period has closed only waiting is left (options are per period)', () => {
  const v = evaluate(RULESETS.C, load('coop-north-fort'), { asOf: 200 });
  assert.equal(v.period.closeAt, 144);
  assert.ok(Object.values(v.options.byActor).every(o => o.options.length === 1 && o.options[0].kind === 'wait'));
});
