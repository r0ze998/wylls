// Sightings are an optional input with no source yet (the S1 watchtower writes no sighting record,
// and ⑭'s central tower has none): without them the scout goal is not offered; with hypothetical
// sightings only that goal opens and nothing else changes. ⑭'s real facts: contract-ws14.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { load } from './helpers.mjs';

test('without sightings: the scout goal is not offered (no source), and no option mentions it', () => {
  const v = evaluate(RULESETS.B, load('coop-north-fort'));
  assert.equal(v.achievements.personal.find(p => p.goal === 'P-scout').status, 'not_offered');
  assert.ok(Object.values(v.options.byActor).every(o => !o.options.some(x => x.kind === 'report-sighting')));
});

test('with hypothetical sightings: the scout goal opens; the other verdicts are the same', () => {
  const a = evaluate(RULESETS.B, load('coop-north-fort'));
  const b = evaluate(RULESETS.B, load('coop-with-sighting'));
  assert.equal(b.achievements.personal.find(p => p.goal === 'P-scout' && p.subject === 'n4-0').status, 'achieved');
  const strip = v => ({ joint: v.achievements.joint, national: v.achievements.national, prize: v.prize, scores: v.scores, window: v.window });
  assert.deepEqual(strip(b), strip(a));
});
