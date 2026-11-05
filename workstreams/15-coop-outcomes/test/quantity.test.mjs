// Arrival quantities: lower bound, zero and unknown are kept apart, and a
// summed requirement is met, short or undecided (④'s quantity contract §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { baseState } from '../scenarios/world.mjs';

/** n2-0's palisade (wood 200, stone 100, gold 20): stone and gold put in exactly; wood by the given arrivals. */
function palisade(arrivals) {
  const ev = [];
  let seq = 0;
  const add = (at, kind, f, verified = 'chain') => ev.push({ id: `c:${seq}`, stream: 'c', seq: seq++, at, kind, verified, ...f });
  add(1, 'project.open', { project: 'P', goal: 'own', structure: 'palisade', steward: 'n2-0' });
  add(2, 'contribute', { project: 'P', actor: 'n2-0', lot: 'init:n2-0:stone', qty: 100 });
  add(2, 'contribute', { project: 'P', actor: 'n2-0', lot: 'init:n2-0:gold', qty: 20 });
  arrivals.forEach(([qty, qtyKind, verified], i) => {
    add(3, 'ship.send', { ship: `w${i}`, from: 'n3-0', to: 'project:P', resource: 'wood', qty: Math.max(qty, 1), fromOutside: true });
    add(5, 'ship.arrive', { ship: `w${i}`, qty, qtyKind }, verified);
  });
  add(10, 'build.complete', { project: 'P', structure: 'S' });
  const v = evaluate(RULESETS.B, { state: baseState(), events: ev });
  const sup = v.achievements.personal.find(p => p.goal === 'P-supplier' && p.subject === 'n3-0');
  return { v, wood: null, sup };
}
/** The wood stage of the palisade as the joint judge would read it, via creditInputs through a project of the joint kind. */
import { creditInputs } from '../src/goals.mjs';
const stage = inputs => creditInputs({ requires: { wood: 200 }, deadline: null, inputs: inputs.map(([qty, qtyKind, verified], i) => ({ id: `i${i}`, at: 5, resource: 'wood', qty, qtyKind, verified: verified ?? 'chain', origin: { actor: 'x', nation: 'n0' } })) }, { opensAt: 0, closeAt: 100 });

test('lower bounds that reach the requirement: met', () => {
  const c = stage([[100, 'lower_bound', 'chain_lower_bound'], [100, 'lower_bound', 'chain_lower_bound']]);
  assert.equal(c.per.wood.status, 'met');
  assert.equal(c.met, true);
});

test('④ §4: Σb short of the requirement but Σb + n above it is undecided, not short', () => {
  const c = stage([[100, 'lower_bound', 'chain_lower_bound'], [99, 'lower_bound', 'chain_lower_bound']]);
  assert.equal(c.per.wood.lo, 199);
  assert.equal(c.per.wood.hi, 201);
  assert.equal(c.per.wood.status, 'undecided');
  assert.equal(c.undecided, true);
});

test('Σb + n at most the requirement is provably short (an open bound is never reached)', () => {
  const c = stage([[199, 'lower_bound', 'chain_lower_bound']]);
  assert.equal(c.per.wood.hi, 200);
  assert.equal(c.per.wood.status, 'short');
});

test('zero is exactly nothing: it adds no upper bound (a logged 0 alone is not zero)', () => {
  const z = stage([[199, 'lower_bound', 'chain_lower_bound'], [0, 'zero', 'chain']]);
  assert.equal(z.per.wood.status, 'short');
  const u = stage([[199, 'lower_bound', 'chain_lower_bound'], [0, 'lower_bound', 'chain_lower_bound']]);
  assert.equal(u.per.wood.status, 'undecided', 'a logged 0 as a lower bound may hide a fraction');
});

test('unknown is between 0 and cargo + 1: undecided if that could close the gap, short if not', () => {
  assert.equal(stage([[160, 'exact', 'chain'], [50, 'unknown', 'unverified']]).per.wood.status, 'undecided');
  assert.equal(stage([[160, 'exact', 'chain'], [30, 'unknown', 'unverified']]).per.wood.status, 'short');
  assert.equal(stage([[160, 'exact', 'chain'], [50, 'unknown', 'unverified']]).per.wood.credited, 160, 'unknown is never credited');
});

test('through the world: a zero arrival creates no goods; an unknown one is never credited to the sender', () => {
  const z = palisade([[0, 'zero', 'chain']]);
  assert.equal(z.v.resources.wood.arrived.exact, 0);
  assert.equal(z.sup, undefined, 'nothing arrived from n3-0');
  const u = palisade([[200, 'unknown', 'unverified']]);
  assert.equal(u.v.resources.wood.arrived.unverified, 200);
  assert.ok(!u.sup || u.sup.status !== 'achieved');
  const l = palisade([[200, 'lower_bound', 'chain_lower_bound']]);
  assert.equal(l.sup.status, 'achieved');
});

test('a lower-bound lot put in over several inputs carries its fraction once, not once per input', () => {
  const ev = [];
  let seq = 0;
  const add = (at, kind, f, verified = 'chain') => ev.push({ id: `c:${seq}`, stream: 'c', seq: seq++, at, kind, verified, ...f });
  add(1, 'project.open', { project: 'P', goal: 'own', structure: 'palisade', steward: 'n2-0' });
  add(2, 'ship.send', { ship: 'w', from: 'n3-0', to: 'n2-0', resource: 'wood', qty: 199, fromOutside: true });
  add(3, 'ship.arrive', { ship: 'w', qty: 199, qtyKind: 'lower_bound' }, 'chain_lower_bound');
  add(4, 'contribute', { project: 'P', actor: 'n2-0', lot: 'w#0', qty: 100 });
  add(4, 'contribute', { project: 'P', actor: 'n2-0', lot: 'w#0', qty: 99 });
  const state = { ...baseState(), lots: baseState().lots.filter(l => !(l.owner === 'n2-0' && l.resource === 'wood')) };
  const v = evaluate({ ...RULESETS.B, joint: [{ ...RULESETS.B.joint[0], id: 'J-pal', structure: 'palisade', requires: { wood: 200 } }] },
    { state, events: ev.map(e => (e.kind === 'project.open' ? { ...e, goal: 'J-pal' } : e)) });
  const t = v.achievements.joint[0].projects[0].stages.inputs.perResource.wood;
  assert.deepEqual([t.lo, t.hi, t.hiOpen, t.status], [199, 200, true, 'short'], 'real < 199 + 1 = 200: provably short');
});
