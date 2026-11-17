// Required check: late arrivals, unverified quantities, duplicated, missing
// and reordered records. A verdict that may stand on a missing record is
// `indeterminate`, never `achieved` or `not_achieved` (prediction H8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { codes, joint, load, project, withEvents, without } from './helpers.mjs';

const coop = load('coop-north-fort');

test('an arrival after the window closes does not count for it; the caravan is in transit at the close and carries on', () => {
  const v = evaluate(RULESETS.B, load('late-arrival'));
  assert.equal(joint(v).status, 'not_achieved');
  assert.ok(codes(joint(v).reasons).includes('late'));
  const t = project(v).stages.inputs.perResource.wood;
  assert.deepEqual([t.credited, t.late], [300, 200]);
  assert.deepEqual(v.world.atClose.inTransit, ['c-n3-wood']);
  assert.equal(v.world.ends, false);
  assert.ok(Object.values(v.world.atClose.goods).every(g => g.balanced));
});

test('unverified arrivals are not credited; a shortfall they could close is indeterminate', () => {
  const v = evaluate(RULESETS.B, load('unverified-storehouse'));
  assert.equal(joint(v).status, 'indeterminate');
  assert.ok(codes(joint(v).reasons).includes('unverified_qty'));
  const t = project(v).stages.inputs.perResource;
  assert.deepEqual([t.wood.credited, t.wood.unverified], [300, 200]);
  // The lower-bound arrival (to a village) is credited at its bound.
  assert.deepEqual([t.stone.credited, t.stone.lowerBound], [800, 300]);
  // If even the unverified goods could not close the gap, it is plainly not achieved.
  const short = evaluate(RULESETS.B, without(load('unverified-storehouse'), e => e.ship === 'c-n3-stone'));
  assert.equal(joint(short).status, 'not_achieved');
});

test('a record repeated with the same content is counted once; with other content, neither is used', () => {
  const arrival = coop.events.find(e => e.kind === 'ship.arrive' && e.ship === 'c-n3-wood');
  const dup = evaluate(RULESETS.B, withEvents(coop, es => [...es, { ...arrival }]));
  assert.equal(joint(dup).status, 'achieved');
  assert.deepEqual(dup.diagnostics.duplicates, [arrival.id]);
  const conflict = evaluate(RULESETS.B, withEvents(coop, es => [...es, { ...arrival, qty: 150 }]));
  assert.deepEqual(conflict.records.conflicts, [arrival.id]);
  assert.equal(conflict.records.gaps[0].stream, 'chain');
  assert.equal(joint(conflict).status, 'indeterminate');
  assert.ok(codes(joint(conflict).reasons).includes('missing_records'));
});

test('a missing record makes the dependent verdicts indeterminate, not failed', () => {
  const arrival = coop.events.find(e => e.kind === 'ship.arrive' && e.ship === 'c-n3-wood');
  const v = evaluate(RULESETS.B, withEvents(coop, es => es.filter(e => e !== arrival && e.id !== arrival.id)));
  assert.deepEqual(v.records.gaps, [{ stream: 'chain', missing: [String(arrival.seq)] }]);
  assert.equal(joint(v).status, 'indeterminate');
  // The same stream carries keeps: a keep record may be missing too, so the prize is not decided either.
  assert.equal(v.scores.status, 'indeterminate');
  // A gap in a stream declared to carry only the board's records leaves the prize decided.
  const board = coop.events.find(e => e.stream === 'ws01' && e.kind === 'contribute');
  const streams = { ...coop.state.streams, ws01: { from: 0, kinds: ['project.open', 'contribute'] } };
  const v2 = evaluate(RULESETS.B, { state: { ...coop.state, streams }, events: coop.events.filter(e => e !== board) });
  assert.equal(joint(v2).status, 'indeterminate');
  assert.equal(v2.scores.status, 'decided');
  // A trailing gap: the source says it sent through seq 30, the evaluator saw fewer.
  const trailing = evaluate(RULESETS.B, { ...coop, state: { ...coop.state, streams: { ...coop.state.streams, chain: { from: 0, through: 30 } } } });
  assert.equal(trailing.records.gaps[0].stream, 'chain');
});

test('a gap in the stream that carries keeps makes the prize indeterminate', () => {
  const input = load('chapter-no-sabotage');
  const firstKeep = input.events.find(e => e.kind === 'keep.set');
  const v = evaluate(RULESETS.B, withEvents(input, es => es.filter(e => !(e.stream === 'chain' && e.seq === firstKeep.seq - 1))));
  assert.equal(v.scores.status, 'indeterminate');
  assert.equal(evaluate(RULESETS.A, withEvents(input, es => es.filter(e => !(e.stream === 'chain' && e.seq === firstKeep.seq - 1)))).prize.status, 'indeterminate', 'A: the legacy prize reading too');
});

test('impossible order (an arrival without its send, an input before its lot exists) is refused as causality', () => {
  const v = evaluate(RULESETS.B, without(coop, e => e.kind === 'ship.send' && e.ship === 'c-n3-wood'));
  const r = v.records.refused.find(x => x.kind === 'ship.arrive');
  assert.equal(r.code, 'causality');
  const early = evaluate(RULESETS.B, withEvents(coop, es => es.map(e => (e.kind === 'use' ? { ...e, at: 90 } : e))));
  assert.ok(early.records.refused.every(x => x.code === 'causality'));
  assert.equal(joint(early).status, 'not_achieved');
});
