// Workstream 04 AUTH-ROUTES B1, by workstream 05: one lane per Citizen in the relay process; and a SendCaravan
// Duplicate is never "not sent". No key is generated, derived or used and nothing is signed: the lanes are tested on
// plain functions, submit on agent records of plain data in manual mode (every request stops at the gate), and the
// Duplicate record through actionFateView (the code path that writes it builds and signs, so it is not run here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLedger } from '../src/frontier/agent/ledger.mjs';
import { AgentGateway, CitizenLanes, actionFateView, laneOf } from '../src/frontier/agent/gateway.mjs';
import { normalisePolicy } from '../src/frontier/agent/policy.mjs';

const tick = () => new Promise(r => setImmediate(r));

test('a lane runs one Citizen\'s work one at a time, in order; other Citizens go on; a failure frees the lane', async () => {
  const lanes = new CitizenLanes();
  const log = [];
  let open = 0, most = 0;
  const job = (name, { fail = false, wait = 3 } = {}) => async () => {
    open++; most = Math.max(most, open); log.push(`start ${name}`);
    for (let i = 0; i < wait; i++) await tick();
    log.push(`end ${name}`); open--;
    if (fail) throw new Error(`${name} failed`);
    return name;
  };
  const a = [lanes.run('C1', job('a1')), lanes.run('C1', job('a2', { fail: true })), lanes.run('C1', job('a3'))];
  assert.equal(lanes.waiting('C1'), 3);
  const r = await Promise.allSettled(a);
  assert.deepEqual(r.map(x => x.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(log, ['start a1', 'end a1', 'start a2', 'end a2', 'start a3', 'end a3']);
  assert.equal(most, 1, 'never two at once in one lane');
  assert.equal(lanes.waiting('C1'), 0);
  // Two Citizens: their work overlaps.
  most = 0; open = 0;
  await Promise.all([lanes.run('C1', job('x', { wait: 5 })), lanes.run('C2', job('y', { wait: 5 }))]);
  assert.equal(most, 2);
  assert.equal(lanes.tails.size, 0, 'nothing is kept once a lane is empty');
});

test('submit goes through the owner\'s lane: two agents of one owner share it; another owner has its own', async () => {
  const seen = [];
  const lanes = new CitizenLanes();
  const orig = lanes.run.bind(lanes);
  lanes.run = (key, fn) => { seen.push(key); return orig(key, fn); };
  const ledger = new AgentLedger({ store: { state: {}, save() {} } });
  const pol = normalisePolicy({ allowed: ['Train'], budget: { total: '1000', perDay: '100' } });
  const mk = (agentId, owner) => ledger.create({ agentId, owner, agentKey: `Key${agentId}`.padEnd(44, '1'), village: [1, 2, 3], policy: pol });
  mk('a1', 'OwnerA'.padEnd(44, '1')); mk('a2', 'OwnerA'.padEnd(44, '1')); mk('b1', 'OwnerB'.padEnd(44, '1'));
  const g = new AgentGateway({ ctx: { addresses: { citizen: () => 'Citizen' } }, ledger, keyring: null, lanes });
  const req = (agentId, n) => ({ agentId, source: 'ai', idempotencyKey: `ai:${agentId}:${n}`, policyVersion: 1, action: { name: 'Train', holding: [1, 2, 3], fields: { unit: 0, n: 1 } } });
  const rs = await Promise.all([g.submit(req('a1', 1), { runner: true }), g.submit(req('a2', 1), { runner: true }), g.submit(req('b1', 1), { runner: true })]);
  assert.deepEqual(rs.map(r => r.error?.code), ['AgentStopped', 'AgentStopped', 'AgentStopped'], 'manual mode: refused at the gate');
  assert.deepEqual(seen, [laneOf({ owner: 'OwnerA'.padEnd(44, '1') }), laneOf({ owner: 'OwnerA'.padEnd(44, '1') }), laneOf({ owner: 'OwnerB'.padEnd(44, '1') })]);
  // A replay of a remembered key does not queue again.
  const again = await g.submit(req('a1', 1), { runner: true });
  assert.equal(again.replayed, true);
  assert.equal(seen.length, 3);
});

test('a SendCaravan Duplicate is recorded as failed with sent: null: followed by the earlier transaction\'s signature, held while unknown', () => {
  // The record #run writes for a seq action's Duplicate (with and without the relay's signature of the earlier send).
  const withSig = { type: 'action', key: 'mcp:c1', status: 'failed', code: 'Duplicate', sent: null, duplicateOf: 'sigEarlier', signature: 'sigEarlier', lastValidBlockHeight: 150, slotFloor: 400 };
  const noSig = { type: 'action', key: 'mcp:c2', status: 'failed', code: 'Duplicate', sent: null };
  assert.equal(actionFateView(noSig).state, 'unknown', 'no signature: result unknown, never not-sent');
  const fate = f => actionFateView(withSig, { fate: f, why: f, commitment: null, queryFailed: false });
  assert.equal(fate('pending').state, 'pending');
  assert.equal(fate('unknown').state, 'unknown', 'the earlier send cannot be proved absent: hold');
  assert.equal(actionFateView(withSig, { fate: 'pending', why: 'rpc down', commitment: null, queryFailed: true }).state, 'unqueryable');
  assert.equal(fate('landed').state, 'landed', 'the same bytes landed: this act\'s effect happened');
  assert.equal(fate('expired').state, 'expired', 'only a proved absence frees it for a new attempt');
  assert.equal(actionFateView(withSig).signature, 'sigEarlier');
  // A refusal that is not a Duplicate stays not-sent.
  assert.equal(actionFateView({ type: 'action', key: 'k', status: 'refused', code: 'StalePolicy' }).state, 'not-sent');
});
