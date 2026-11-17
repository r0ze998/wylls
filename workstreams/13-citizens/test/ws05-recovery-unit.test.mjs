// W1 review (2026-11-08): the restart reconciliation's wallet side, one state at a time, against a FIXTURE cost port
// (a stand-in that answers recover() with chosen states; it is not workstream 5 and says nothing about 5's behaviour,
// which ws05-recovery.test.mjs checks against 5's own ledger). Small set-up (one resident, no demo), halted with the
// operator's halt file so that no decision, no model call and no new hold happens: only the reconciliation runs.
// Keyless: no key is made or used (`markSending` gets a fixed text, not a signature).
//
// What must hold: only a well-formed answer naming the hold's own amount closes a hold (released → released; settled →
// settled at exactly the given amount, once); anything missing, malformed, mismatched, undecided or thrown leaves the
// hold unresolved and the record on file, never charged in full, never refunded; a failure is retried a bounded number
// of times, and kept records are re-checked at most once a game day; other categories are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { small } from './helpers.mjs';
import { openResident } from '../world/harness.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';
import { BELLS_PER_DAY } from '../world/rules.mjs';

const ID = 'ren', Q = '10000';

/** A hold of `category` in `state` as a stopped process would have left it, with (or without) its record. */
function plant(r, { category = 'inference', state = 'running', amount = Q, phase = 'calling', record = true, turn = 90 } = {}) {
  const l = r.ledger;
  const h = l.hold(ID, { category, amount, key: `${ID}:t${turn}:${category === 'inference' ? 'infer' : 'act'}`, policyVersion: 1, modeEpoch: l.get(ID).modeEpoch });
  if (state === 'running' || state === 'unresolved') l.markRunning(ID, h.id);
  if (state === 'unresolved') l.markUnresolved(ID, h.id, 'fixture');
  if (state === 'sending') l.markSending(ID, h.id, 'fixture-not-a-signature');
  const key = `${ID}:t${turn}:infer:${h.id}`;
  if (record) (r.state.costCalls ??= {})[key] = { holdId: h.id, phase, bell: 0 };
  r.save();
  return { holdId: h.id, key };
}

/** A fixture cost port: recover() answers `answer` (a value, or a function of the call count); counts its calls. */
function fixtureCost(answer) {
  const calls = [];
  return { kind: 'fixture-cost-ledger', calls, quote: () => Q, settle: () => ({ charge: Q }),
    recover(callKey, o) { calls.push([callKey, o]); return typeof answer === 'function' ? answer(calls.length, callKey, o) : answer; } };
}

/** The process after a stop: reopened from its files, halted (no decisions), with the given cost port. */
function reopen(env, cost) {
  writeFileSync(path.join(env.dir, ID, 'HALT'), 'test: only the restart reconciliation runs\n');
  const r = openResident(path.join(env.dir, ID), { world: env.world, board: env.board, provider: fixtureProvider() });
  r.ports.cost = cost;
  return r;
}

const spent = r => BigInt(r.ledger.get(ID).bal.spent.inference ?? 0);
const holdOf = (r, id) => r.ledger.get(ID).holds[id] ?? null;
const recordOf = (r, key) => r.state.costCalls?.[key] ?? null;
const fresh = () => small({ residents: [{ id: ID, pos: { q: 0, r: 0 } }] });

test('settled with the hold\'s amount: settled at exactly the given amount, once; the record is closed', async () => {
  const env = await fresh();
  const p = plant(env.rs[ID], { phase: 'calling' });
  const before = spent(env.rs[ID]);
  const r = reopen(env, fixtureCost({ state: 'settled', amount: Q, settled: '4000' }));
  await r.step();
  assert.equal(holdOf(r, p.holdId), null);
  assert.equal(spent(r) - before, 4000n, 'charged the settled amount, not the full hold');
  assert.equal(recordOf(r, p.key), null);
  const again = reopen(env, fixtureCost({ state: 'settled', amount: Q, settled: '4000' }));
  await again.step();
  assert.equal(spent(again) - before, 4000n, 'a second restart charges nothing more');
  assert.equal(again.ports.cost.calls.length, 0, 'nothing left to ask about');
});

for (const [name, answer] of [
  ['settled without a settled amount', { state: 'settled', amount: Q }],
  ['settled with settled null', { state: 'settled', amount: Q, settled: null }],
  ['settled with a non-decimal settled amount', { state: 'settled', amount: Q, settled: 'abc' }],
  ['settled with a negative settled amount', { state: 'settled', amount: Q, settled: '-1' }],
  ['settled above the hold', { state: 'settled', amount: Q, settled: '20000' }],
  ['settled with a number, not a decimal string', { state: 'settled', amount: Q, settled: 4000 }],
  ['settled without an amount', { state: 'settled', settled: '1' }],
  ['settled for another amount', { state: 'settled', amount: '9999', settled: '1' }],
  ['released without an amount', { state: 'released' }],
  ['released for another amount', { state: 'released', amount: '9999' }],
  ['undecided', { state: 'undecided', amount: Q }],
  ['absent although the record says reserved', { state: 'absent' }],
  ['reserved left over', { state: 'reserved', amount: Q }],
  ['an unknown state', { state: 'refunded', amount: Q }],
  ['null', null],
  ['a string', 'released'],
  ['a state that is not a string', { state: 5, amount: Q }],
  ['an empty object', {}],
]) {
  test(`kept, never charged or refunded: ${name}`, async () => {
    const env = await fresh();
    const p = plant(env.rs[ID], { phase: 'reserved' });
    const before = spent(env.rs[ID]);
    const r = reopen(env, fixtureCost(answer));
    await r.step(); // must not throw
    assert.equal(holdOf(r, p.holdId)?.state, 'unresolved', 'the hold stays, unresolved');
    assert.equal(holdOf(r, p.holdId).amount, Q);
    assert.equal(spent(r), before, 'nothing charged');
    assert.ok(recordOf(r, p.key)?.costState, 'the record stays on file, with what the cost ledger said');
  });
}

test('released with the hold\'s amount: an unresolved hold is released (the cost ledger says nothing was billed)', async () => {
  const env = await fresh();
  const p = plant(env.rs[ID], { phase: 'calling', state: 'unresolved' });
  const before = spent(env.rs[ID]);
  const r = reopen(env, fixtureCost({ state: 'released', amount: Q }));
  await r.step();
  assert.equal(holdOf(r, p.holdId), null);
  assert.equal(spent(r), before);
  assert.equal(recordOf(r, p.key), null);
});

test('absent with the record at reserving (never reserved there): released', async () => {
  const env = await fresh();
  const p = plant(env.rs[ID], { phase: 'reserving', state: 'held' });
  const r = reopen(env, fixtureCost({ state: 'absent' }));
  await r.step();
  assert.equal(holdOf(r, p.holdId), null);
  assert.equal(recordOf(r, p.key), null);
});

test('recover() throws: the step goes on, the hold stays unresolved, and the next step tries again (bounded)', async () => {
  const env = await fresh();
  const p = plant(env.rs[ID], { phase: 'reserved' });
  const r = reopen(env, fixtureCost(n => { if (n === 1) throw new Error('fixture: the cost ledger cannot be read'); return { state: 'released', amount: Q }; }));
  await r.step();
  assert.equal(holdOf(r, p.holdId)?.state, 'unresolved');
  assert.equal(recordOf(r, p.key)?.costState, 'error');
  await r.step();
  assert.equal(holdOf(r, p.holdId), null, 'reconciled at the retry');
  assert.equal(recordOf(r, p.key), null);
  assert.equal(r.ports.cost.calls.length, 2);
});

test('recover() keeps throwing: at most 3 tries in the process, then once a game day', async () => {
  const env = await fresh();
  const p = plant(env.rs[ID], { phase: 'reserved' });
  const r = reopen(env, fixtureCost(() => { throw new Error('fixture: the cost ledger cannot be read'); }));
  for (let i = 0; i < 6; i++) await r.step();
  assert.equal(r.ports.cost.calls.length, 3, 'bounded retries, not every step');
  assert.equal(holdOf(r, p.holdId)?.state, 'unresolved');
  for (let b = 0; b < BELLS_PER_DAY; b++) env.world.operator.tick();
  await r.step();
  assert.equal(r.ports.cost.calls.length, 4, 'looked at again after a game day');
});

test('undecided, later settled by the cost ledger: re-checked once a game day, settled once at that amount', async () => {
  const env = await fresh();
  const p = plant(env.rs[ID], { phase: 'calling' });
  const before = spent(env.rs[ID]);
  let answer = { state: 'undecided', amount: Q };
  const r = reopen(env, fixtureCost(() => answer));
  await r.step();
  assert.equal(recordOf(r, p.key)?.costState, 'undecided');
  answer = { state: 'settled', amount: Q, settled: '7000' };
  for (let i = 0; i < 3; i++) await r.step();
  assert.equal(r.ports.cost.calls.length, 1, 'not re-asked within the day');
  for (let b = 0; b < BELLS_PER_DAY; b++) env.world.operator.tick();
  await r.step();
  assert.equal(holdOf(r, p.holdId), null);
  assert.equal(spent(r) - before, 7000n);
  assert.equal(recordOf(r, p.key), null);
  await r.step();
  assert.equal(spent(r) - before, 7000n, 'once');
});

test('other categories are never touched: a sending game hold named by a record, a held game hold without one', async () => {
  const env = await fresh();
  const named = plant(env.rs[ID], { category: 'game', state: 'sending', phase: 'calling', turn: 91 });
  const loose = plant(env.rs[ID], { category: 'game', state: 'held', record: false, turn: 92 });
  const r = reopen(env, fixtureCost({ state: 'released', amount: Q }));
  await r.step();
  assert.equal(holdOf(r, named.holdId)?.state, 'sending');
  assert.equal(holdOf(r, loose.holdId)?.state, 'held');
  assert.match(recordOf(r, named.key)?.kept ?? '', /not an inference hold/);
});

test('without a record: a held inference hold is released once; running and unresolved ones stay unresolved', async () => {
  const env = await fresh();
  const held = plant(env.rs[ID], { state: 'held', record: false, turn: 93 });
  const running = plant(env.rs[ID], { state: 'running', record: false, turn: 94 });
  const unresolved = plant(env.rs[ID], { state: 'unresolved', record: false, turn: 95 });
  const r = reopen(env, fixtureCost({ state: 'released', amount: Q }));
  await r.step();
  assert.equal(holdOf(r, held.holdId), null, 'the orphan held hold is released');
  assert.equal(holdOf(r, running.holdId)?.state, 'unresolved');
  assert.equal(holdOf(r, unresolved.holdId)?.state, 'unresolved');
  assert.equal(r.ports.cost.calls.length, 0, 'no record: the cost ledger is not asked');
  const releases = r.ledger.get(ID).history.filter(e => e.type === 'release' && /never made/.test(e.reason ?? ''));
  assert.equal(releases.length, 1);
});
