// The differences between the variants (D1, D6) and what is kept apart:
// achievements, scores, resources and the prize; no new money anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, joint, load } from './helpers.mjs';

const names = readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));

test('A judges no goal and mixes in no unadopted rule', () => {
  for (const n of names) {
    const { A } = all(load(n));
    assert.deepEqual(A.achievements, { joint: [], national: [], personal: [] }, n);
    assert.equal(A.period.closedBy, 'schedule');
    assert.equal(A.period.closeAt, A.period.endsAt);
  }
});

test('no variant adds money; achievements never feed the prize', () => {
  for (const n of names) for (const v of Object.values(all(load(n)))) {
    assert.equal(v.prize.newMoney, 0);
    assert.equal(v.prize.fromAchievements, 0);
    assert.deepEqual(Object.keys(v).filter(k => ['achievements', 'scores', 'resources', 'prize'].includes(k)).sort(), ['achievements', 'prize', 'resources', 'scores']);
  }
});

test('D1: B never changes who the prize names; C does exactly when its close moves', () => {
  for (const n of names) {
    const { A, B, C } = all(load(n));
    assert.deepEqual(B.prize.winners, A.prize.winners, `B on ${n}`);
    if (C.period.closedBy === 'schedule') assert.deepEqual(C.prize.winners, A.prize.winners, `C on ${n}`);
  }
});

test('D6: the cooperative fort is an achievement with reasons in B and C, nothing in A', () => {
  const { A, B, C } = all(load('coop-north-fort'));
  assert.equal(A.awards.length, 0);
  for (const v of [B, C]) {
    assert.equal(joint(v).status, 'achieved');
    assert.ok(joint(v).reasons[0].evidence.length > 3);
    assert.deepEqual(v.awards.filter(a => a.track === 'joint').map(a => a.beneficiary), ['n1-0', 'n2-0', 'n3-0']);
  }
});

test('C names what ends and what continues at its close', () => {
  const { C } = all(load('coop-north-fort'));
  assert.equal(C.period.closedBy, 'joint:J-north-fort');
  assert.equal(C.period.closeAt, 120 + 24);
  assert.ok(C.period.scope.ends.length >= 3);
  assert.ok(C.period.scope.continues.some(s => s.includes('建物')));
  assert.equal(C.period.trigger.achievedAt, 120);
});
