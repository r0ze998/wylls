// Regression cases for the faults a second independent review reproduced in
// the continuing-world evaluator (docs/07 §3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateSeries } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { hashOf } from '../src/canon.mjs';
import { normalize } from '../src/ledger.mjs';
import { buildWorld, goodsBalance, snapshotOf } from '../src/world.mjs';
import { baseState } from '../scenarios/world.mjs';
import { load } from './helpers.mjs';

const input = load('boundary-crossing');
const ev = (stream, seq, at, kind, f, sub) => ({ id: `${stream}:${seq}:${sub ?? 0}`, stream, seq, ...(sub === undefined ? {} : { sub }), at, kind, verified: 'chain', ...f });

test('V1: sub-events of one record at different bells are set aside (a restart could split them)', () => {
  const events = [ev('s', 0, 10, 'lot.produce', { lot: 'L1', owner: 'n1-0', resource: 'wood', qty: 5 }, 0), ev('s', 0, 20, 'lot.produce', { lot: 'L2', owner: 'n1-0', resource: 'wood', qty: 5 }, 1)];
  const n = normalize(events, { s: { from: 0 } });
  assert.deepEqual(n.notes.conflicts, ['s:0:0', 's:0:1']);
  assert.equal(n.events.length, 0);
  assert.deepEqual(n.notes.gaps, [{ stream: 's', missing: ['0'] }]);
});

test('V2: a structure built in W1 and first used by someone else in W2 counts for the nation in W2', () => {
  const moved = { ...input, events: input.events.map(e => (e.kind === 'use' && e.structure === 'S-pal' ? { ...e, at: 250 } : e)) };
  const s = evaluateSeries(RULESETS.B, moved);
  const n2 = id => s.verdicts.find(v => v.window.id === id).achievements.national.find(x => x.subject === 'n2');
  assert.equal(n2('W1').status, 'not_achieved');
  assert.equal(n2('W2').status, 'achieved');
});

test('V3: merging goods does not reorder first-in-first-out or change origins', () => {
  const state = { ...baseState(), period: undefined, at: 0, lots: [] };
  const events = [
    ev('c', 0, 1, 'ship.send', { ship: 'g1', from: 'n2-0', to: 'n1-0', resource: 'wood', qty: 10 }),
    ev('c', 1, 3, 'ship.arrive', { ship: 'g1', qty: 10 }),
    ev('c', 2, 4, 'lot.produce', { lot: 'own', owner: 'n1-0', resource: 'wood', qty: 200 }),
    ev('c', 3, 5, 'ship.send', { ship: 'g2', from: 'n2-0', to: 'n1-0', resource: 'wood', qty: 100 }),
    ev('c', 4, 6, 'ship.arrive', { ship: 'g2', qty: 100 }),
    ev('c', 5, 7, 'project.open', { project: 'P', goal: 'own', structure: 'palisade', steward: 'n3-0' }),
    ev('c', 6, 8, 'ship.send', { ship: 'g3', from: 'n1-0', to: 'project:P', resource: 'wood', qty: 150 }),
    ev('c', 7, 9, 'ship.arrive', { ship: 'g3', qty: 150 }),
  ];
  state.lots = [{ lot: 'seed', owner: 'n2-0', resource: 'wood', qty: 110 }];
  const W = buildWorld({ state, events, costs: RULESETS.B.costs, jointGoals: {} });
  const inputs = W.projects.get('P').inputs;
  // First in, first out: 10 of n2's wood, then 140 of n1's own; n2's later 100 was not drawn first.
  assert.deepEqual(inputs.map(i => `${i.origin.actor}:${i.qty}`), ['n2-0:10', 'n1-0:140']);
  assert.ok(Object.values(goodsBalance(W)).every(x => x.balanced));
});

test('V3b: a lot name can never spend more than was put under it, merged or not', () => {
  const state = { ...baseState(), period: undefined, at: 0, lots: [] };
  const events = [
    ev('c', 0, 1, 'lot.produce', { lot: 'a', owner: 'n1-0', resource: 'stone', qty: 300 }),
    ev('c', 1, 2, 'lot.produce', { lot: 'b', owner: 'n1-0', resource: 'stone', qty: 100 }),
    ev('c', 2, 3, 'project.open', { project: 'P', goal: 'own', structure: 'fort', steward: 'n1-0' }),
    ev('c', 3, 4, 'contribute', { project: 'P', actor: 'n1-0', lot: 'b', qty: 200 }),
    ev('c', 4, 5, 'contribute', { project: 'P', actor: 'n1-0', lot: 'b', qty: 100 }),
    ev('c', 5, 6, 'contribute', { project: 'P', actor: 'n1-0', lot: 'b', qty: 1 }),
  ];
  const W = buildWorld({ state, events, costs: RULESETS.B.costs, jointGoals: {} });
  assert.deepEqual(W.outcomes.filter(o => o.kind === 'contribute').map(o => o.code ?? 'ok'), ['insufficient', 'ok', 'insufficient']);
});

test('V4: events at exactly the close belong to the next window', () => {
  const joins = Array.from({ length: 6 }, (_, i) => ev('j', i, 240, 'actor.join', { actor: `late-${i}`, nation: 'n2' }));
  const with6 = { ...input, events: [...input.events, ...joins], state: { ...input.state, streams: { ...input.state.streams, j: { from: 0 } } } };
  const a = evaluate(RULESETS.B, input, { window: 'W1' }).achievements.national.find(x => x.subject === 'n2');
  const b = evaluate(RULESETS.B, with6, { window: 'W1' }).achievements.national.find(x => x.subject === 'n2');
  assert.equal(b.members, a.members);
  assert.equal(b.status, a.status);
});

test('V5: spans between windows are reported; an achievement reached in one is not hidden', () => {
  const gapped = { ...input, windows: [{ id: 'W1', opensAt: 0, endsAt: 240 }, { id: 'W2', opensAt: 300, endsAt: 480 }] };
  const s = evaluateSeries(RULESETS.B, gapped);
  assert.deepEqual(s.uncovered, [{ from: 240, to: 300 }]);
  const j = s.verdicts[1].achievements.joint[0];
  assert.equal(j.status, 'achieved_earlier');
  assert.equal(j.achievedAt, 280);
});

test('V6: duplicate window ids are refused', () => {
  assert.throws(() => evaluateSeries(RULESETS.B, { ...input, windows: [{ id: 'W', opensAt: 0, endsAt: 240 }, { id: 'W', opensAt: 240, endsAt: 480 }] }), /duplicate id/);
});

test('judging does not change the world; later nations are not part of an earlier window; carryInputs is honoured', () => {
  const s = evaluateSeries(RULESETS.B, input);
  const norm = normalize(input.events, input.state.streams);
  const W = buildWorld({ state: input.state, events: norm.events, costs: RULESETS.B.costs, jointGoals: { 'J-north-fort': RULESETS.B.joint[0] }, taint: norm.taint, gapFrom: norm.gapFrom });
  assert.equal(hashOf(snapshotOf(W)), s.finalDigest);
  const newNation = { ...input, events: [...input.events, ev('j', 0, 400, 'actor.join', { actor: 'x', nation: 'n9' })], state: { ...input.state, streams: { ...input.state.streams, j: { from: 0 } } } };
  assert.equal('n9' in evaluate(RULESETS.B, newNation, { window: 'W1' }).scores.keeps, false);
  const noCarry = { ...RULESETS.B, carryInputs: false };
  const w2 = evaluate(noCarry, input, { window: 'W2' }).achievements.joint[0];
  assert.equal(w2.status, 'not_achieved', 'without carrying W1\'s inputs the fort is short in W2');
});
