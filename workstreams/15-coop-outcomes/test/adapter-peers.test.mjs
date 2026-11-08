// ①'s board adapter on a synthetic board (its link rules). The contract tests against ①'s, ④'s and
// ⑭'s real outputs are test/contract-ws01, contract-ws04 and contract-ws14.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromWs01Board } from '../src/adapters/ws01.mjs';

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

