// Required check: double consumption of the same goods and an improper
// second award in one reward slot are refused; one input serving several
// different goals is legitimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaims, evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { load, personal } from './helpers.mjs';

test('the same lot cannot be put in or sent twice', () => {
  const v = evaluate(RULESETS.B, load('double-spend'));
  const refused = Object.fromEntries(v.records.refused.map(r => [r.id, r.code]));
  assert.equal(refused['ws01:6'], 'insufficient', '200 more wood from a lot with 100 left');
  assert.equal(refused['chain:15'], 'insufficient', 'a send from the emptied lot');
  assert.equal(v.resources.wood.inProjects['P-pal-n1'], 100, 'the remaining 100 went in');
});

test('one input counts for the joint goal, the nation and the person (legitimate), each once', () => {
  const v = evaluate(RULESETS.B, load('coop-north-fort'));
  const slots = v.awards.filter(a => a.beneficiary === 'n2-0').map(a => a.goal);
  assert.deepEqual(slots.sort(), ['J-north-fort', 'P-supplier']);
  // n2's nation goal: joint share would count the same input too, when the nation chose it.
  const voted = { ...load('coop-north-fort') };
  voted.events = [...voted.events, { id: 'vote-n2', stream: 'chain', seq: 999, at: 5, kind: 'nation.goal', verified: 'chain', nation: 'n2', goal: 'N-joint-share' }];
  voted.state = { ...voted.state, streams: { ...voted.state.streams, chain: { from: 0 } } };
  const v2 = evaluate(RULESETS.B, { ...voted, events: voted.events.map(e => (e.id === 'vote-n2' ? { ...e, seq: voted.events.filter(x => x.stream === 'chain').length - 1 } : e)) });
  assert.equal(v2.achievements.national.find(n => n.subject === 'n2').status, 'achieved');
  assert.ok(v2.awards.some(a => a.goal === 'N-joint-share' && a.beneficiary === 'n2'));
  assert.ok(v2.awards.some(a => a.goal === 'J-north-fort' && a.beneficiary === 'n2-0'));
  assert.ok(v2.awards.some(a => a.goal === 'P-supplier' && a.beneficiary === 'n2-0'));
});

test('a second claim on one slot is refused; claims on different slots of one fact are not', () => {
  const v = evaluate(RULESETS.B, load('coop-north-fort'));
  const r = checkClaims(v, [
    { slot: 'J-north-fort|P1|n2-0', beneficiary: 'n2-0' },
    { slot: 'P-supplier|P1|n2-0', beneficiary: 'n2-0' },
    { slot: 'J-north-fort|P1|n2-0', beneficiary: 'n2-0' },
    { slot: 'J-north-fort|P1|n2-0', beneficiary: 'n4-0' },
  ]);
  assert.deepEqual(r.map(x => x.code), [null, null, 'same_slot', 'not_awarded']);
});

test('one person with labelled alternate accounts gets one personal slot, not three', () => {
  const v = evaluate(RULESETS.B, load('sybil-labelled'));
  const sup = v.achievements.personal.filter(p => p.goal === 'P-supplier');
  const awarded = sup.filter(p => p.status === 'achieved').map(p => p.subject);
  const refused = sup.filter(p => p.status === 'not_awarded');
  assert.equal(awarded.filter(a => ['n0-0', 'alt-n4', 'alt-n5'].includes(a)).length, 1);
  assert.equal(refused.length, 2);
  assert.ok(refused.every(p => p.reasons[0].code === 'same_slot'));
  assert.equal(personal(v, 'P-supplier', 'n0-1').status, 'achieved', 'another member of n0 keeps their own slot');
});
