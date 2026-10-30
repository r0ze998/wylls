// Regression cases for the faults an independent review reproduced
// (docs/05-results.ja.md §4). Each case is the failing input, now judged as
// the contract requires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromWs01Board } from '../src/adapters/ws01.mjs';
import { fromRunReceipts } from '../src/adapters/ws04.mjs';
import { codes, joint, load, personal, withEvents, without } from './helpers.mjs';

const coop = load('coop-north-fort');
const chainLen = coop.events.filter(e => e.stream === 'chain').length;

test('R1: the missing record is the deciding one (the second use): indeterminate, not not_achieved', () => {
  const second = coop.events.find(e => e.kind === 'use' && e.actor === 'n2-1');
  const late = { id: 'later', stream: 'chain', seq: chainLen, at: 300, kind: 'keep.set', verified: 'chain', keep: 'k0', nation: 'n0' };
  const v = evaluate(RULESETS.B, withEvents(coop, es => [...es.filter(e => e.id !== second.id), late]));
  assert.equal(joint(v).status, 'indeterminate');
  const t = evaluate(RULESETS.B, { ...withEvents(coop, es => es.filter(e => e.id !== second.id)), state: { ...coop.state, streams: { ...coop.state.streams, chain: { from: 0, through: second.seq } } } });
  assert.equal(joint(t).status, 'indeterminate');
});

test('R2: a conflict at a sub-position leaves a gap even when a sibling survives', () => {
  const first = coop.events.find(e => e.stream === 'chain' && e.seq === 0);
  const sib = { ...first, id: 'chain:0:1', sub: 1, ship: 'other', qty: 1 };
  const v = evaluate(RULESETS.B, withEvents(coop, es => [...es.map(e => (e.id === first.id ? { ...e, sub: 0 } : e)), sib, { ...sib, qty: 2 }]));
  assert.deepEqual(v.records.conflicts, ['chain:0:1']);
  assert.equal(v.records.gaps[0].stream, 'chain');
  assert.equal(joint(v).status, 'indeterminate');
});

test('R3: rejected records do not change the hash by repetition or order', () => {
  const bad1 = { id: 'bad', stream: 'x', seq: 0, at: 1, kind: 'nope', verified: 'chain' };
  const bad2 = { id: 'bad', stream: 'x', seq: 0, at: 1, kind: 'use', verified: 'chain' };
  const h = es => evaluate(RULESETS.B, withEvents(coop, x => [...x, ...es])).verdictHash;
  assert.equal(h([bad1]), h([bad1, bad1]));
  assert.equal(h([bad1, bad2]), h([bad2, bad1]));
});

test('R4: an input recorded as unverified is not credited, whatever the lot', () => {
  const v = evaluate(RULESETS.B, withEvents(coop, es => es.map(e => (e.kind === 'contribute' ? { ...e, verified: 'unverified' } : e))));
  assert.notEqual(joint(v).status, 'achieved');
  assert.equal(v.achievements.joint[0].projects[0].stages.inputs.perResource.wood.unverified, 300);
  assert.notEqual(personal(v, 'P-supplier', 'n1-0')?.status, 'achieved');
});

test('R5/R6: the founder goal is undecided behind a gap, and own goods passed through others do not count', () => {
  const gap = evaluate(RULESETS.B, withEvents(coop, es => es.filter(e => !(e.stream === 'chain' && e.seq === 3))));
  assert.equal(personal(gap, 'P-founder', 'n1-0').status, 'indeterminate');
  const input = withEvents(coop, es => {
    const n = { chain: chainLen, ws01: es.filter(e => e.stream === 'ws01').length };
    const add = (at, kind, f, stream = 'chain') => es.push({ id: `${stream}:${n[stream]}`, stream, seq: n[stream]++, at, kind, verified: 'chain', ...f });
    add(130, 'project.open', { project: 'P-own', goal: 'own', structure: 'palisade', steward: 'n2-0' }, 'ws01');
    for (const who of ['n4-0', 'n5-0']) { add(131, 'ship.send', { ship: `g-${who}`, from: 'n2-0', to: who, resource: 'wood', qty: 100 }); add(132, 'ship.arrive', { ship: `g-${who}`, qty: 100 }); }
    for (const who of ['n4-0', 'n5-0']) add(133, 'ship.send', { ship: `c-${who}`, from: who, to: 'project:P-own', resource: 'wood', qty: 100, lot: `g-${who}#0` });
    for (const who of ['n4-0', 'n5-0']) add(134, 'ship.arrive', { ship: `c-${who}`, qty: 100 });
    add(135, 'contribute', { project: 'P-own', actor: 'n2-0', lot: 'init:n2-0:stone', qty: 100 }, 'ws01');
    add(135, 'contribute', { project: 'P-own', actor: 'n2-0', lot: 'init:n2-0:gold', qty: 20 }, 'ws01');
    add(140, 'build.complete', { project: 'P-own', structure: 'S-own' });
    return es;
  });
  const v = evaluate(RULESETS.B, input);
  assert.notEqual(personal(v, 'P-founder', 'n2-0')?.status, 'achieved');
  assert.equal(personal(v, 'P-supplier', 'n4-0').status, 'not_achieved');
  assert.deepEqual(codes(personal(v, 'P-supplier', 'n4-0').reasons), ['not_own_goods']);
});

test('R7: in C, an undecided joint goal leaves the close and the prize undecided', () => {
  const v = evaluate(RULESETS.C, without(load('chapter-no-sabotage'), e => e.id === 'ws01:1'));
  const g = evaluate(RULESETS.C, withEvents(load('chapter-no-sabotage'), es => es.filter(e => e.id !== 'ws01:1')));
  assert.equal(v.period.status, 'closed', 'without that input (renumbered) the fort is simply short');
  assert.equal(joint(g).status, 'indeterminate');
  assert.equal(g.period.status, 'close_indeterminate');
  assert.equal(g.prize.status, 'indeterminate');
});

test('R8: ①\'s first link wins by link time across requests', () => {
  const board = { requests: [
    { id: 'r-A', goalId: 'g', requester: 'n1-0', at: 10, state: 'open', links: [{ responder: 'n2-0', caravan: { ownerTag: '21', seq: 1 }, at: 50 }] },
    { id: 'r-B', goalId: 'g', requester: 'n3-0', at: 20, state: 'open', links: [{ responder: 'n2-0', caravan: { ownerTag: '21', seq: 1 }, at: 30 }] },
  ] };
  const { linkResolver, rejected } = fromWs01Board(board, { projectOf: r => ({ project: `P-${r.id}`, goal: 'J-north-fort', structure: 'fort' }), actorOf: s => s, bellOf: x => x });
  assert.equal(linkResolver()({ kind: 1 }, '21', 1).project, 'P-r-B');
  assert.deepEqual(rejected.map(r => r.request), ['r-A']);
});

test('R9: ④ receipts with one key and different content become a conflict, in either order', () => {
  const r = v => ({ run_id: v, kind: 'caravan_settled', subject: 'cv:21:1', source: 'sig:c', slot: 40, body: { owner_tag: 21, seq: 1, cargo: [0, 0, 300, 0, 0, 0, 0, 0], verification: v } });
  const map = { bellOfSlot: s => s, actorOfTag: () => 'n2-0', destination: () => ({ actor: 'n1-0' }), cargoSent: () => null };
  const a = fromRunReceipts([r('Recorded'), r('Unverifiable')], map).events;
  const b = fromRunReceipts([r('Unverifiable'), r('Recorded')], map).events;
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map(e => e.id)).size, 1, 'both under one id: the record check sets them aside');
});

test('R10: a completion of another kind of structure is refused', () => {
  const v = evaluate(RULESETS.B, withEvents(coop, es => es.map(e => (e.kind === 'build.complete' ? { ...e, structureKind: 'palisade' } : e))));
  assert.ok(v.records.refused.some(x => x.code === 'wrong_structure'));
  assert.notEqual(joint(v).status, 'achieved');
});

test('joint award slots are per participant (cluster), as personal ones', () => {
  const v = evaluate(RULESETS.B, load('sybil-unlabelled'));
  const l = evaluate(RULESETS.B, withEvents(load('sybil-unlabelled'), es => es));
  assert.deepEqual(v.awards, l.awards);
  const labelled = { ...load('sybil-unlabelled') };
  labelled.state = { ...labelled.state, actors: labelled.state.actors.map(a => (a.id.startsWith('alt-') ? { ...a, cluster: 'n0-0' } : a)) };
  const jointSlots = evaluate({ ...RULESETS.B, joint: [{ ...RULESETS.B.joint[0], minNations: 1 }] }, labelled).awards.filter(a => a.track === 'joint');
  assert.equal(jointSlots.filter(a => ['n0-0', 'alt-n4', 'alt-n5'].includes(a.beneficiary)).length, 1);
});
