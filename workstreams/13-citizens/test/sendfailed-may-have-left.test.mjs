// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. It uses the same harness as
// transport-uncertain.test.mjs (helpers.mjs, world/harness.mjs); run it only with its own approval.
//
// resident.mjs #run: a send's own answer that says it may have left (the agent wallet's `failed` + SendFailed with
// `sent: true` and a signature, or SendFailed for a key with no final response) keeps THIS key and is read back; it is
// never retried under a new key (④ EXECUTION-CONTRACT §1; 08 R4). A SendFailed that says `sent: false` with no
// signature stays transient, as before. Duplicate keeps its existing handling (its signature is another send's).
// Answer shapes follow permutation-gateway/src/frontier/agent/gateway.mjs (#run, sendFacts); the answers are made up
// here and nothing is signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { small, run } from './helpers.mjs';

const firstBuild = r => Object.values(r.state.journal).find(it => it.purpose?.type === 'build');

/**
 * Replaces the first submit's answer; `reach` says whether the send reaches the world first. As in
 * transport-uncertain.test.mjs, the first two status reads answer null (no record yet), so the first tick shows the
 * line as #run left it before #reconcile reads its fate.
 */
function answerOnce(ren, { reach, answer, hidden = 2 }) {
  const real = ren.ports.execution;
  const submitted = [];
  let once = true;
  let hiddenStatuses = hidden;
  ren.ports.execution = {
    ...real,
    async status(key) { return hiddenStatuses-- > 0 ? null : real.status(key); },
    async submit(req) {
      submitted.push(req.idempotencyKey);
      if (!once) return real.submit(req);
      once = false;
      if (reach) await real.submit(req);
      return answer;
    },
  };
  return submitted;
}

const MAY_HAVE_LEFT = {
  'signed, then the send threw (sent: true, signature)': { ok: false, status: 'failed', error: { code: 'SendFailed', message: 'rpc dropped after signing' }, sent: true, signature: 'FAKE-SIG-1', lastValidBlockHeight: 150, slotFloor: 10, charges: [] },
  'a key with a saved request and no final response (no sent field)': { ok: false, status: 'failed', error: { code: 'SendFailed', message: 'this action key has a saved request without a final response' }, signature: 'FAKE-SIG-2' },
  'SendFailed without any sent field or signature': { ok: false, status: 'failed', error: { code: 'SendFailed', message: 'no final response' } },
};

for (const [name, answer] of Object.entries(MAY_HAVE_LEFT)) test(`may have left — ${name}: the same key is kept and read back`, async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  const submitted = answerOnce(ren, { reach: true, answer });
  await run(env, 1);
  const it = firstBuild(ren);
  assert.ok(it, 'the first build was attempted');
  assert.deepEqual([it.state, it.sendKey, it.attempts], ['sent', it.key, 1], 'held under its own key, no new attempt');
  assert.equal(it.lastError, 'SendFailed');
  assert.equal(it.signature, undefined, 'no signature is recorded as this line\'s proven send');
  assert.deepEqual(it.counted, [it.key], 'counted once for its key');
  await run(env, 8);
  assert.equal(submitted.filter(k => k.startsWith(it.key)).length, 1, 'no second key for the same action');
  assert.equal(it.state, 'landed', 'decided by the key\'s own fate');
  assert.deepEqual(it.counted, [it.key], 'still counted once');
});

test('SendFailed with sent: false and no signature stays transient (unchanged)', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  answerOnce(ren, { reach: false, answer: { ok: false, status: 'failed', error: { code: 'SendFailed', message: 'rpc down before building' }, sent: false, charges: [] } });
  await run(env, 1);
  const it = firstBuild(ren);
  assert.ok(it);
  assert.deepEqual([it.state, it.attempts, it.lastError], ['intended', 2, 'SendFailed'], 'a new attempt later, as before');
  assert.equal(it.counted, undefined, 'nothing left: not counted');
});

test('sent: false contradicted by a signature is not proof that nothing left', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  answerOnce(ren, { reach: true, answer: { ok: false, status: 'failed', error: { code: 'SendFailed', message: 'x' }, sent: false, signature: 'FAKE-SIG-3' } });
  await run(env, 1);
  const it = firstBuild(ren);
  assert.deepEqual([it.state, it.sendKey, it.attempts], ['sent', it.key, 1]);
});

test('Duplicate keeps its existing handling (its signature is another send\'s, not this key\'s)', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  answerOnce(ren, { reach: false, answer: { ok: false, status: 'failed', error: { code: 'Duplicate', message: 'x' }, sent: null, duplicateOf: 'FAKE-SIG-4', signature: 'FAKE-SIG-4' } });
  await run(env, 1);
  const it = firstBuild(ren);
  assert.equal(it.state, 'failed', 'as before this change');
  assert.equal(it.counted, undefined);
});

test('a definite refusal stays as before (BucketEmpty: transient; another code: failed)', async () => {
  for (const [code, want] of [['BucketEmpty', 'intended'], ['ActionNotAllowed', 'failed']]) {
    const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
    const ren = env.rs.ren;
    answerOnce(ren, { reach: false, answer: { ok: false, status: 'refused', error: { code, message: 'x' }, charges: [] } });
    await run(env, 1);
    assert.equal(firstBuild(ren).state, want, code);
  }
});

// (2026-11-17, counter-check) An answer OUTSIDE the ActionResult contract: a submit answer never carries `fate`, and
// the only Transport in ⑬ is the resident's own catch (status 'unknown', no signature), which is ambiguous first. If a
// caller's send still returned Transport + fate 'failed' + a signature, the new branch keeps it under its key with
// lastError 'Transport', so #reconcile's same-key resubmit can apply after a "no record" wait (R1/R2: the same key, not a
// new one). These cases pin what must hold then: one key only, counted once, and no resubmit once a cancel is asked.
const OUT_OF_CONTRACT = { ok: false, status: 'failed', error: { code: 'Transport', message: 'x' }, fate: 'failed', signature: 'FAKE-SIG-5' };

test('out of contract (Transport + fate failed + signature): only the same key, counted once, across the resubmit wait', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  const submitted = answerOnce(ren, { reach: true, answer: OUT_OF_CONTRACT, hidden: 8 });
  await run(env, 1);
  const it = firstBuild(ren);
  assert.deepEqual([it.state, it.sendKey, it.attempts], ['sent', it.key, 1]);
  await run(env, 16);
  const mine = submitted.filter(k => k.startsWith(it.key));
  assert.ok(mine.length >= 1 && mine.every(k => k === it.key), 'every submit of this action is under its first key');
  assert.equal(it.attempts, 1, 'no new attempt');
  assert.deepEqual(it.counted, [it.key], 'counted once');
});

test('out of contract, then a cancel: no resubmit after the cancel, the key and count kept', async () => {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
  const ren = env.rs.ren;
  const submitted = answerOnce(ren, { reach: true, answer: OUT_OF_CONTRACT, hidden: 8 });
  await run(env, 1);
  const it = firstBuild(ren);
  await ren.cancelAction(it.key);
  assert.ok(it.cancelRequested, 'the cancel is recorded');
  const mine = () => submitted.filter(k => k.startsWith(it.key)).length;
  const before = mine();
  await run(env, 16);
  assert.equal(mine(), before, 'this action is not submitted again after the cancel');
  assert.deepEqual([it.sendKey, it.attempts], [it.key, 1]);
  assert.deepEqual(it.counted, [it.key]);
});
