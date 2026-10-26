// The decision bench's situations (scripts/agent-decision-bench.mjs) are well posed: every situation that expects
// an action has one the stores can pay under its own rules, and the S1 ones test what they say they test — the
// strong units' arms, the workshop, a stores-cannot-pay rest — under the S1 catalog (runner.mjs catalogFor(3)).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affordable, catalogFor } from '../src/frontier/agent/runner.mjs';
import { SITUATIONS, SITUATIONS_S1 } from '../scripts/agent-decision-bench.mjs';

const trains = (state, cat, units = cat.train.map(u => u.unit)) => units.filter(unit => affordable({ name: 'Train', fields: { unit, n: 100 } }, state, cat));
const builds = (state, cat) => cat.build.map(b => b.item).filter(item => affordable({ name: 'Build', fields: { item } }, state, cat));
const find = (list, start) => { const s = list.find(x => x.name.startsWith(start)); assert.ok(s, start); return s; };

test('the MC situations are the ten of every earlier run (profile 2); the S1 ones are four (profile 3)', () => {
  assert.equal(SITUATIONS.length, 10);
  assert.ok(SITUATIONS.every(s => s.profile === 2));
  assert.equal(SITUATIONS_S1.length, 4);
  assert.ok(SITUATIONS_S1.every(s => s.profile === 3 && s.name.startsWith('S1 ')));
});

test('every situation that expects only actions has an answer its stores can pay under its own rules', () => {
  for (const s of [...SITUATIONS, ...SITUATIONS_S1]) {
    if (s.expect.includes('rest')) continue;
    const cat = catalogFor(s.profile);
    const ok = s.expect.some(a => (a === 'Train' ? trains(s.state, cat).some(unit => !s.fields?.Train || s.fields.Train({ unit, n: 100 }))
      : a === 'Build' ? builds(s.state, cat).some(item => !s.fields?.Build || s.fields.Build({ item })) : true));
    assert.ok(ok, `${s.name}: no affordable answer in ${s.expect}`);
  }
});

test('S1: without arms only the basic units can be paid; with arms a strong unit can', () => {
  const s1 = catalogFor(3);
  const none = find(SITUATIONS_S1, 'S1 train without arms');
  assert.ok(none.state.threat?.outnumbered, 'a threat the village must answer');
  assert.deepEqual(trains(none.state, s1), [0, 1, 2], 'Spearman, Archer, Horseman; no Pikeman, Crossbowman, Knight without arms');
  assert.deepEqual(trains(none.state, catalogFor(2)), [0, 1, 2, 3, 4, 5], 'under MC the same stores would pay every unit: the arms are what the situation tests');
  const armed = find(SITUATIONS_S1, 'S1 train with arms');
  assert.ok(armed.state.threat?.outnumbered);
  assert.ok(trains(armed.state, s1, [3, 4, 5]).length > 0, 'a strong unit is affordable with 150 arms');
});

test('S1: the workshop situation can pay the workshop (item 8), wastes ore at the cap, and offers no workshop under MC', () => {
  const w = find(SITUATIONS_S1, 'S1 workshop');
  assert.ok(builds(w.state, catalogFor(3)).includes(8));
  assert.ok(!builds(w.state, catalogFor(2)).includes(8));
  assert.ok(w.state.stores.Ore >= w.state.store_cap - 10, 'ore at the cap');
  assert.equal(w.state.threat, undefined, 'no threat');
  assert.equal(w.fields.Build({ item: 8 }), true);
  assert.equal(w.fields.Build({ item: 0 }), false);
});

test('S1: the rest situation can pay nothing, though it is threatened', () => {
  const r = find(SITUATIONS_S1, 'S1 rest');
  assert.ok(r.state.threat);
  const s1 = catalogFor(3);
  assert.deepEqual(trains(r.state, s1), []);
  assert.deepEqual(builds(r.state, s1), []);
});
