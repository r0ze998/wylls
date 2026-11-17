// Success condition 1: replay. Same ruleset and input → same verdict, in
// any order and with any repetition; another ruleset version or another
// input → another hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { load, shuffled, withEvents } from './helpers.mjs';

const input = load('chapter-sabotage');

test('reordered and repeated input gives the same verdict hash, for each ruleset', () => {
  for (const k of ['A', 'B', 'C']) {
    const base = evaluate(RULESETS[k], input);
    for (const seed of [1, 2, 3]) {
      const v = evaluate(RULESETS[k], withEvents(input, es => shuffled(es, seed)));
      assert.equal(v.verdictHash, base.verdictHash, `${k} seed ${seed}`);
      assert.ok(v.diagnostics.inputInversions > 0, 'the input really was out of order');
    }
    const doubled = evaluate(RULESETS[k], withEvents(input, es => [...es, ...shuffled(es, 9).slice(0, 10)]));
    assert.equal(doubled.verdictHash, base.verdictHash);
    assert.equal(doubled.diagnostics.duplicates.length, 10);
  }
});

test('the verdict names the ruleset version and the input it was made from', () => {
  const v = evaluate(RULESETS.B, input);
  assert.equal(v.ruleset.id, 'B-separate-tracks');
  assert.match(v.ruleset.hash, /^[0-9a-f]{64}$/);
  assert.match(v.inputHash, /^[0-9a-f]{64}$/);
  const bumped = { ...RULESETS.B, version: RULESETS.B.version + 1 };
  assert.notEqual(evaluate(bumped, input).ruleset.hash, v.ruleset.hash);
  assert.notEqual(evaluate(bumped, input).verdictHash, v.verdictHash);
  const other = withEvents(input, es => es.filter(e => e.kind !== 'structure.seized'));
  assert.notEqual(evaluate(RULESETS.B, other).inputHash, v.inputHash);
});

test('a replay of the stored verdict is byte-identical (no clock, no randomness)', () => {
  const a = JSON.stringify(evaluate(RULESETS.C, input));
  const b = JSON.stringify(evaluate(RULESETS.C, structuredClone(input)));
  assert.equal(a, b);
});
