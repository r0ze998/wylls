// ⑭'s tower is an optional input: everything works without it, and with it
// only the tower's own personal goal opens; nothing else changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { load } from './helpers.mjs';

test('without the tower: the scout goal is not offered, and no option mentions it', () => {
  const v = evaluate(RULESETS.B, load('coop-north-fort'));
  assert.equal(v.achievements.personal.find(p => p.goal === 'P-scout').status, 'not_offered');
  assert.ok(Object.values(v.options.byActor).every(o => !o.options.some(x => x.kind === 'report-sighting')));
});

test('with the tower: the scout goal opens; the other verdicts are the same', () => {
  const a = evaluate(RULESETS.B, load('coop-north-fort'));
  const b = evaluate(RULESETS.B, load('coop-with-tower'));
  assert.equal(b.achievements.personal.find(p => p.goal === 'P-scout' && p.subject === 'n4-0').status, 'achieved');
  const strip = v => ({ joint: v.achievements.joint, national: v.achievements.national, prize: v.prize, scores: v.scores, period: v.period });
  assert.deepEqual(strip(b), strip(a));
});
