// Adapters for ①, ④ and ⑭, on synthetic inputs shaped like their relayed
// contracts (their own files were not in this checkout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromWs01Board } from '../src/adapters/ws01.mjs';
import { fromRunReceipts } from '../src/adapters/ws04.mjs';
import { fromTowerFacts, SCHEMA } from '../src/adapters/ws14.mjs';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { baseState } from '../scenarios/world.mjs';

const actorOf = s => s.replace(/^wallet:/, '');
const board = {
  requests: [
    { id: 'r-stone', goalId: 'north-fort', requester: 'wallet:n1-0', need: { stone: 500 }, at: 20, expiresAt: 400, state: 'open',
      links: [{ responder: 'wallet:n2-0', caravan: { ownerTag: '21', seq: 1 }, at: 31 }, { responder: 'wallet:n3-0', caravan: { ownerTag: '31', seq: 1 }, at: 41 }] },
    { id: 'r-dup', goalId: 'north-fort', requester: 'wallet:n1-0', need: { stone: 100 }, at: 21, state: 'open',
      links: [{ responder: 'wallet:n2-0', caravan: { ownerTag: '21', seq: 1 }, at: 32 }] },
    { id: 'r-other', goalId: 'crossing-storehouse-v1', requester: 'wallet:n4-0', need: { wood: 200 }, at: 22, state: 'open', links: [] },
  ],
};
const map = {
  projectOf: r => (r.goalId === 'north-fort' ? { project: 'P-north', goal: 'J-north-fort', structure: 'fort' } : null),
  actorOf, bellOf: at => at,
};

test('①: requests open one project; a caravan linked twice counts for the first request only', () => {
  const { events, linkResolver, rejected } = fromWs01Board(board, map);
  assert.deepEqual(events.map(e => e.kind), ['project.open']);
  assert.equal(events[0].deadline, 400);
  assert.deepEqual(rejected.map(r => r.why).sort(), ['duplicateOf', 'no project for this goal']);
  const dest = linkResolver();
  assert.deepEqual(dest({ kind: 1 }, '21', 1), { actor: 'n1-0', project: 'P-north', kind: 'village' });
  assert.equal(dest({ kind: 1 }, '99', 1), null);
});

const TAGS = { 11: 'n1-0', 12: 'n1-1', 21: 'n2-0', 22: 'n2-1', 31: 'n3-0', 66: 'n0-2' };
const cargo = o => ['food', 'wood', 'stone', 'ore', 'arms', 'gold', 'x', 'y'].map(r => o[r] ?? 0);
const receipts = [
  { run_id: 'r1', kind: 'caravan_sent', subject: 'cv:21:1', source: 'sig:a', slot: 30, body: { owner_tag: 21, seq: 1, cargo: cargo({ stone: 300, gold: 50 }), dst: 'fort' } },
  { run_id: 'r2', kind: 'caravan_sent', subject: 'cv:31:1', source: 'sig:b', slot: 40, body: { owner_tag: 31, seq: 1, cargo: cargo({ wood: 200, stone: 200, arms: 20, gold: 50 }), dst: 'fort' } },
  { run_id: 'r1', kind: 'caravan_settled', subject: 'cv:21:1', source: 'sig:c', slot: 40, body: { owner_tag: 21, seq: 1, cargo: cargo({ stone: 300, gold: 50 }), verification: 'Recorded', credited: cargo({ stone: 300, gold: 50 }) } },
  { run_id: 'r2', kind: 'caravan_settled', subject: 'cv:31:1', source: 'sig:d', slot: 55, body: { owner_tag: 31, seq: 1, cargo: cargo({ wood: 200, stone: 200, arms: 20, gold: 50 }), verification: 'RuleDerived' } },
];
const wmap = {
  bellOfSlot: s => s, actorOfTag: t => TAGS[t] ?? null,
  destination: () => ({ actor: 'n1-0', project: 'P-north', kind: 'village' }), cargoSent: () => null,
};

function judged(ruleDerivedAs) {
  const { events } = fromRunReceipts([...receipts, receipts[0]], wmap, { ruleDerivedAs });
  const own = ['wood:300', 'stone:300', 'arms:30', 'gold:100'].map((x, i) => { const [r, q] = x.split(':'); return { id: `b:${i}`, stream: 'b', seq: i + 1, at: 25, kind: 'contribute', verified: 'chain', project: 'P-north', actor: 'n1-0', lot: `init:n1-0:${r}`, qty: Number(q) }; });
  const open = { id: 'b:open', stream: 'b', seq: 0, at: 20, kind: 'project.open', verified: 'chain', project: 'P-north', goal: 'J-north-fort', structure: 'fort', steward: 'n1-0' };
  const tail = [
    { id: 'c:0', stream: 'c', seq: 0, at: 100, kind: 'build.complete', verified: 'chain', project: 'P-north', structure: 'S' },
    { id: 'c:1', stream: 'c', seq: 1, at: 110, kind: 'use', verified: 'chain', structure: 'S', actor: 'n1-1', how: 'garrison' },
    { id: 'c:2', stream: 'c', seq: 2, at: 120, kind: 'use', verified: 'chain', structure: 'S', actor: 'n2-1', how: 'garrison' },
  ];
  return evaluate(RULESETS.B, { state: baseState(), events: [open, ...own, ...events, ...tail] });
}

test('④: receipts become caravans; a repeated receipt is dropped; RuleDerived is the caller\'s choice', () => {
  const lower = judged('chain_lower_bound');
  const exact = judged('chain');
  const p = v => v.achievements.joint[0].projects[0].stages.inputs.perResource;
  assert.equal(lower.achievements.joint[0].status, 'achieved');
  assert.equal(p(lower).wood.lowerBound, 200, '①: lower bound');
  assert.equal(p(exact).wood.lowerBound, 0, '④: exact');
  assert.notEqual(lower.verdictHash, exact.verdictHash, 'the choice is visible in the verdict');
});

test('⑭: tower facts are optional; a wrong schema is refused, posts used by others open the scout goal', () => {
  assert.match(fromTowerFacts({ schema: 'other' }, {}).refused, /not wylls\.ws14/);
  const facts = { schema: SCHEMA, events: [
    { kind: 'tower.board_post', hour: 50, actor: 'w:n4-0', id: 'post-1' },
    { kind: 'tower.board_taken', hour: 55, by: 'w:n1-1', of: 'post-1' },
    { kind: 'tower.stage_opened', hour: 60 },
  ] };
  const { events, skipped } = fromTowerFacts(facts, { bellOfHour: h => h, actorOf: s => s.slice(2) });
  assert.deepEqual(events.map(e => e.kind), ['tower.sighting', 'tower.report.used', 'position']);
  assert.deepEqual(skipped.map(s => s.kind), ['tower.stage_opened']);
  const v = evaluate(RULESETS.B, { state: { ...baseState(), streams: { ws14: { from: 0 } } }, events });
  assert.equal(v.achievements.personal.find(p => p.goal === 'P-scout' && p.subject === 'n4-0').status, 'achieved');
  assert.equal(v.prize.newMoney, 0);
});
