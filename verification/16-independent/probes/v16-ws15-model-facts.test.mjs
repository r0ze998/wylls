// ⑯ independent probe of ⑮ cb87e30c (CHECKS-for-16 item 8): ⑭'s model facts
// (`verified: 'model'`) never become facts of the game. For every ruleset and
// every ⑭ case, the awards and the prize verdict with ⑭'s facts are the same
// as with none of them. Literal fixtures only (⑭'s handoff bytes); no key, no
// network. Run from workstreams/15-coop-outcomes/test of ⑮'s tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromTowerFacts } from '../src/adapters/ws14.mjs';

const read = f => JSON.parse(readFileSync(new URL(`../scenarios/fixtures/${f}`, import.meta.url), 'utf8'));
const map = { actorOf: v => `v${v}` };
const WHOLE = { id: 'given', opensAt: 0, endsAt: 21 * 24 * 6 };

function input(facts, withFacts) {
  const { events, streams } = fromTowerFacts(facts, map);
  const villages = new Map();
  for (const f of facts.events) if (f.actor !== null) villages.set(f.actor, f.nation);
  const nations = [...new Set([...villages.values()])].sort().map(n => `n${n}`);
  return {
    state: { at: 0, nations, actors: [...villages].sort((a, b) => a[0] - b[0]).map(([v, n]) => ({ id: `v${v}`, nation: `n${n}` })), lots: [], keeps: [], streams: withFacts ? streams : {} },
    events: withFacts ? events : [], windows: [WHOLE],
  };
}

for (const c of ['A', 'B', 'C']) {
  const facts = read(`ws14-v1-bde8d1c1-case${c}.json`);
  for (const rs of Object.keys(RULESETS)) {
    test(`V16-15m ${rs}/case ${c}: ⑭'s model facts add no award and change no prize verdict`, () => {
      const withF = evaluate(RULESETS[rs], input(facts, true));
      const without = evaluate(RULESETS[rs], input(facts, false));
      assert.deepEqual(withF.awards, without.awards, 'awards differ when ⑭ facts are added');
      assert.deepEqual(withF.prize ?? null, without.prize ?? null, 'prize verdict differs');
      // No goal is 'achieved' on model facts alone: anything 'achieved' with them is achieved without them too.
      const ach = v => new Set((v.achievements?.personal ?? []).concat(v.achievements?.nations ?? [], v.achievements?.world ?? [])
        .filter(p => p.status === 'achieved').map(p => `${p.goal}|${p.subject ?? ''}`));
      const extra = [...ach(withF)].filter(k => !ach(without).has(k));
      assert.deepEqual(extra, [], `achieved only with ⑭ facts: ${extra.join(', ')}`);
    });
  }
}
