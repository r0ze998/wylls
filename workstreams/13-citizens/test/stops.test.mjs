// Three different ways to stop, kept apart (keyless; the test world; the fixture provider):
//   halt file          the operator's pause: nothing new is sent, results are still read; removed, the journal goes on
//                      under the SAME keys
//   cancelAction(key)  one action cancelled: unsent → dropped; sent → the port is asked; if it did not take effect it
//                      ends `cancelled` with NO new attempt; if it landed anyway it is `landed`
//   revocation         the owner revokes the resident's authority (the agent wallet's policy `revoked`): nothing is
//                      sent again, not even under the same key; no model call, no reservation; unsent lines are
//                      `revoked` and stay so after the revocation is lifted
// The revocation is written to the wallet ledger directly here: in the game only a signed owner command changes it,
// and checking that signature needs a key, which keyless tests do not use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { small, run } from './helpers.mjs';
import { openResident } from '../world/harness.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';

/** Ren, stopped right after writing its first intent (a build), reopened; every submit, model call and hold counted. */
async function intentWritten() {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 }, crash: { at: 'after-intent', turn: 1 } }] });
  await assert.rejects(env.rs.ren.step(), /crash injected/);
  return reopen(env);
}
function reopen(env) {
  const ren = openResident(path.join(env.dir, 'ren'), { world: env.world, board: env.board, provider: fixtureProvider() });
  env.rs.ren = ren;
  return watch(env);
}
function watch(env) {
  const ren = env.rs.ren;
  const log = { submits: [], calls: 0 };
  const p = ren.ports.execution;
  ren.ports.execution = { ...p, async submit(req) { log.submits.push(req.idempotencyKey); return p.submit(req); } };
  const prov = ren.ports.provider;
  ren.ports.provider = { ...prov, async decide(req) { log.calls++; return prov.decide(req); } };
  return { env, ren, log, line: () => Object.values(ren.state.journal).find(j => j.purpose?.type === 'build') };
}
const family = (keys, base) => keys.filter(k => k === base || k.startsWith(`${base}#`));
const inferenceHolds = ren => Object.values(ren.ledger.get('ren').holds).filter(h => h.category === 'inference').length;

test('halt file: a pause; nothing sent while it is there; removed, the same key is sent once', async () => {
  const { env, ren, log, line } = await intentWritten();
  const it = line();
  assert.equal(it.state, 'intended');
  writeFileSync(ren.charter.haltFile, 'operator halt');
  const halted = await run(env, 10);
  assert.ok(halted.every(r => r.stopped === 'halted-by-operator'));
  assert.deepEqual(log.submits, [], 'nothing sent while halted');
  assert.equal(log.calls, 0, 'no model call while halted');
  assert.equal(line().state, 'intended', 'kept, not dropped');
  rmSync(ren.charter.haltFile);
  await run(env, 6);
  assert.deepEqual(family(log.submits, it.key), [it.key], 'the same key, once');
  assert.equal(line().state, 'landed');
});

test('halt file: results of earlier sends are still read while halted', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const { ren, line } = watch(env);
  await run(env, 1, { each: () => writeFileSync(ren.charter.haltFile, 'operator halt') }); // sent, then halted before it lands
  assert.equal(line().state, 'sent');
  await run(env, 3);
  assert.equal(line().state, 'landed', 'read and settled during the halt');
});

test('cancel, unsent: dropped and never sent', async () => {
  const { env, ren, log, line } = await intentWritten();
  const key = line().key;
  const r = await ren.cancelAction(key, { by: 'owner' });
  assert.equal(r.state, 'cancelled');
  await run(env, 20);
  assert.deepEqual(family(log.submits, key), [], 'that key and no new attempt of it was ever sent');
  assert.equal(Object.values(ren.state.journal).find(j => j.key === key)?.state ?? 'cancelled', 'cancelled');
});

test('cancel, sent and still queued: the world withdraws it; it ends cancelled, with no new attempt', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const { ren, log, line } = watch(env);
  let res = null;
  await run(env, 1, { each: async () => { res = await ren.cancelAction(line().key, { by: 'operator' }); } });
  assert.deepEqual(res.port, { cancelled: true });
  const key = line().key;
  await run(env, 20);
  assert.equal(Object.values(ren.state.journal).find(j => j.key === key)?.state ?? 'cancelled', 'cancelled');
  assert.deepEqual(family(log.submits, key), [key], 'no #a2');
  assert.equal(env.world.status(key, ren.address).fate, 'cancelled');
});

/** A port that cannot cancel (workstream 4: signed bytes cannot be recalled), whose first send ends `fate`. */
function cannotCancel(ren, fate, { until = () => true } = {}) {
  const real = ren.ports.execution;
  const log = { submits: [], first: null };
  ren.ports.execution = {
    ...real,
    async submit(req) { log.submits.push(req.idempotencyKey); if (log.first === null) { log.first = req.idempotencyKey; return { ok: true, status: 'sent' }; } return real.submit(req); },
    async status(k) { return k === log.first ? (until() ? { ok: true, status: 'sent', fate } : real.status(k)) : real.status(k); },
    async cancel() { return { cancelled: false, reason: 'NotSupported' }; },
  };
  return log;
}

test("cancel where the port cannot cancel, then 'expired': ends cancelled, NOT re-attempted (without the cancel it would be)", async () => {
  for (const cancel of [true, false]) {
    const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
    const ren = env.rs.ren;
    const log = cannotCancel(ren, 'expired');
    let res = null;
    await run(env, 1, { each: async () => { if (cancel && log.first) res = await ren.cancelAction(log.first); } });
    await run(env, 20);
    const sent = family(log.submits, log.first);
    if (cancel) {
      assert.deepEqual(res.port, { cancelled: false, reason: 'NotSupported' });
      assert.deepEqual(sent, [log.first], 'no new attempt after a cancelled one expired');
      assert.equal(Object.values(ren.state.journal).find(j => j.key === log.first)?.state ?? 'cancelled', 'cancelled');
    } else {
      assert.deepEqual(sent, [log.first, `${log.first}#a2`], 'without a cancel, expired means a new attempt');
    }
  }
});

test('cancel where the port cannot cancel and the result arrives late as landed: landed, recorded as cancel-requested', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  let early = true;
  const real = ren.ports.execution;
  const log = cannotCancel(ren, 'unknown', { until: () => early });
  let first = null;
  await run(env, 1, { each: async () => { first = log.first; await ren.cancelAction(first); } });
  await run(env, 10);
  const it = () => Object.values(ren.state.journal).find(j => j.key === first);
  assert.equal(it().state, 'sent', 'unknown: held');
  // the late answer: it did land (the swallowed send is replayed into the world, as a chain would have kept it)
  await real.submit({ idempotencyKey: first, action: it().action });
  early = false;
  await run(env, 30);
  assert.equal(it().state, 'landed');
  assert.ok(it().cancelRequested, 'the cancel request is kept on the line');
  assert.deepEqual(family(log.submits, first), [first], 'never sent again');
});

test('cancel: a delivery owed to someone is not cancelled by a cancel', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) { if (bell === 1) await me.post({ kind: 'request', to: 'c1', want: { Food: 40 }, offer: { Ore: 40 }, deadlineBell: 40 }); } }] });
  const ren = env.rs.ren;
  let refused = null;
  await run(env, 12, { each: async () => {
    const d = Object.values(ren.state.journal).find(j => j.purpose?.type === 'deliver' && j.state !== 'landed');
    if (d && !refused) refused = await ren.cancelAction(d.key);
  } });
  assert.ok(refused, 'a delivery was planned');
  assert.equal(refused.refused, 'Owed');
});

test('revocation: unsent lines are revoked, nothing is sent, no model call, no reservation', async () => {
  const { env, ren, log, line } = await intentWritten();
  const key = line().key;
  const holds = inferenceHolds(ren);
  ren.ledger.setPolicy('ren', { ...ren.ledger.get('ren').policy, revoked: { by: 'owner', note: 'test: written to the wallet ledger directly (signature not exercised keyless)' } });
  const out = await run(env, 30);
  assert.equal(out[0].stopped, 'authority-revoked');
  assert.deepEqual(out[0].revoked, [key]);
  assert.equal(line().state, 'revoked');
  assert.deepEqual(log.submits, [], 'nothing sent');
  assert.equal(log.calls, 0, 'no model call');
  assert.equal(inferenceHolds(ren), holds, 'no new reservation');
});

test('revocation: a send whose reply was lost is only read, never sent again (it would be re-sent without the revocation)', async () => {
  for (const revoke of [true, false]) {
    const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
    const ren = env.rs.ren;
    const real = ren.ports.execution;
    const log = { submits: [] };
    let lose = true;
    ren.ports.execution = { ...real, async submit(req) { log.submits.push(req.idempotencyKey); if (lose) { lose = false; throw new Error('connection reset before the request arrived'); } return real.submit(req); } };
    await run(env, 1);
    const it = Object.values(ren.state.journal).find(j => j.purpose?.type === 'build');
    assert.equal(it.lastError, 'Transport');
    if (revoke) ren.ledger.setPolicy('ren', { ...ren.ledger.get('ren').policy, revoked: { by: 'owner' } });
    await run(env, 20);
    const same = log.submits.filter(k => k === it.key).length;
    if (revoke) assert.equal(same, 1, 'only the lost one: not re-sent under the revocation');
    else assert.equal(same, 2, 'without it: re-sent once under the same key');
  }
});

test("revocation: an 'expired' result under it is not re-attempted; lifting it does not bring revoked lines back", async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  const log = cannotCancel(ren, 'expired');
  await run(env, 1);
  ren.ledger.setPolicy('ren', { ...ren.ledger.get('ren').policy, revoked: { by: 'owner' } });
  await run(env, 10);
  const it = () => Object.values(ren.state.journal).find(j => j.key === log.first);
  assert.equal(it().state, 'revoked');
  const policy = { ...ren.ledger.get('ren').policy };
  delete policy.revoked;
  ren.ledger.setPolicy('ren', policy);
  await run(env, 20);
  assert.deepEqual(family(log.submits, log.first), [log.first], 'never re-attempted, also after the revocation was lifted');
  assert.equal(it()?.state ?? 'revoked', 'revoked');
});
