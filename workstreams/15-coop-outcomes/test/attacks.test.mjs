// Abuse cases: a leading nation rushing the end, a losing nation
// obstructing, a fixed coalition shutting others out, and unlabelled
// alternate accounts. Predictions H3, H4, H5 and H7 were written down before
// these ran (docs/02-preregistration.ja.md); the assertions state what was
// observed, including where a variant fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { all, codes, joint, load, project } from './helpers.mjs';

test('H3: one leading nation alone cannot end the period early in C', () => {
  const v = all(load('rush-solo'));
  assert.equal(joint(v.C).status, 'not_achieved');
  assert.deepEqual(codes(joint(v.C).reasons), ['diversity']);
  assert.equal(v.C.period.closedBy, 'schedule');
  assert.deepEqual(v.C.prize.winners, v.A.prize.winners);
});

test('H4 (shipped goods): goods n0 passes to client nations still count as n0\'s', () => {
  const v = evaluate(RULESETS.C, load('rush-clients-laundered'));
  assert.equal(joint(v).status, 'not_achieved');
  assert.deepEqual(project(v).stages.diversity.qualifying, ['n0']);
  assert.equal(v.period.closedBy, 'schedule');
  // The same input with holder attribution would let it through: the protection is the origin rule.
  const holder = { ...RULESETS.C, joint: [{ ...RULESETS.C.joint[0], attribution: 'holder' }] };
  const h = evaluate(holder, load('rush-clients-laundered'));
  assert.equal(joint(h).status, 'achieved');
});

test('H4 (own goods, paid off in food): C cannot tell, and the leader ends the period while ahead (failure of C, as predicted)', () => {
  const v = all(load('rush-clients-own'));
  assert.equal(joint(v.C).status, 'achieved');
  assert.equal(v.C.period.closedBy, 'joint:J-north-fort');
  assert.equal(v.C.period.closeAt, 96);
  assert.deepEqual(v.C.prize.winners, ['n0']);
  assert.deepEqual(v.A.prize.winners, ['n1'], 'without the early close n1 overtakes at 300');
  assert.deepEqual(v.B.prize.winners, ['n1'], 'B: the same cooperation does not move the prize');
});

test('H5: unlabelled alternate accounts pass the diversity check (not preventable on model data alone)', () => {
  const u = all(load('sybil-unlabelled'));
  assert.equal(joint(u.C).status, 'achieved');
  assert.deepEqual(u.C.prize.winners, ['n0']);
  assert.equal(u.C.identity.productionGuarantee, false);
  const l = evaluate(RULESETS.C, load('sybil-labelled'));
  assert.equal(joint(l).status, 'not_achieved');
  assert.deepEqual(codes(joint(l).reasons), ['diversity']);
});

test('H7: obstruction by the losing nation moves the close (and the prize) in C, only the achievement in B', () => {
  const ok = all(load('chapter-no-sabotage'));
  const sab = all(load('chapter-sabotage'));
  assert.equal(ok.C.period.closeAt, 144);
  assert.deepEqual(ok.C.prize.winners, ['n1']);
  assert.equal(sab.C.period.closeAt, 480);
  assert.deepEqual(sab.C.prize.winners, ['n0']);
  assert.deepEqual(ok.B.prize.winners, sab.B.prize.winners, 'B: the prize does not depend on the obstruction');
  assert.equal(joint(sab.B).status, 'not_achieved');
  assert.ok(codes(joint(sab.B).reasons).includes('seized'));
  // The raid itself is a legitimate path for the raider (non-domestic).
  assert.equal(sab.B.achievements.personal.find(p => p.goal === 'P-raider' && p.subject === 'n0-2').status, 'achieved');
});

test('fixed coalition: outsiders\' late goods are surplus or arrive after completion; outsiders keep independent options', () => {
  const v = evaluate(RULESETS.B, load('coalition-exclusion'));
  const p = project(v);
  assert.deepEqual(p.stages.diversity.qualifying, ['n0', 'n1', 'n2']);
  assert.equal(p.stages.inputs.perResource.stone.surplus, 200, 'n3\'s stone came after the requirement was met');
  assert.ok(!p.credits.some(c => ['n3', 'n4', 'n5'].includes(c.nation)));
  assert.equal(v.records.refused.length, 0);
  for (const a of ['n3-0', 'n4-0', 'n5-0']) {
    const o = v.options.byActor[a];
    assert.ok(o.independentWithGoal >= 1, `${a} has an independent option toward a goal`);
    assert.ok(o.options.some(x => x.kind === 'use-foreign-structure'), `${a} can still use the coalition's fort for a personal goal`);
  }
});
