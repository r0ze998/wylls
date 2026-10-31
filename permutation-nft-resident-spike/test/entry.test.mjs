// Payment, mint and eligibility are three records: a payment that is not
// known to have settled mints nothing; one payment mints at most one asset;
// eligibility is read from the chain, never from the payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/errors.mjs';
import { A, B, rejects, stack } from './fixtures.mjs';

test('pay then mint: a double click and a retry return the recorded result; one asset', async () => {
  const s = stack();
  const [p1, p2] = await Promise.all([s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k1' }), s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k1' })]);
  assert.equal(p1.id, p2.id);
  assert.equal(p1.state, 'settled');
  const m1 = await s.desk.mintFor({ paymentRecordId: p1.id, to: A.publicKey });
  const m2 = await s.desk.mintFor({ paymentRecordId: p1.id, to: A.publicKey });
  assert.equal(m1.assetId, m2.assetId);
  assert.equal(m2.replayed, true);
  assert.equal(s.chain.events.filter(e => e.kind === 'mint').length, 1);
  assert.equal(s.registry.entitlement(A.publicKey).onWaitlist, true);
  await rejects(() => s.desk.pay({ wallet: B.publicKey, idempotencyKey: 'k1' }), ERR.IDEMPOTENCY_CONFLICT);
});

test('a payment with an unknown outcome mints nothing; when the rail later confirms it, exactly one mint follows', async () => {
  const s = stack();
  s.rail.script('k2', 'unknown');
  const p = await s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k2' });
  assert.equal(p.state, 'unknown');
  await rejects(() => s.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey }), ERR.PAYMENT_UNKNOWN);
  assert.equal(s.registry.entitlement(A.publicKey).onWaitlist, false, 'no eligibility from a payment of unknown outcome');
  // The client retries the same key: the desk asks the rail again and learns it settled.
  const again = await s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k2' });
  assert.equal(again.state, 'settled');
  const m = await s.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey });
  await s.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey });
  assert.ok(m.assetId);
  assert.equal(s.chain.events.filter(e => e.kind === 'mint').length, 1);
});

test('a failed payment mints nothing and confers nothing', async () => {
  const s = stack();
  s.rail.script('k3', 'failed');
  const p = await s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k3' });
  assert.equal(p.state, 'failed');
  await rejects(() => s.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey }), ERR.PAYMENT_FAILED);
  assert.equal(s.registry.residents().length, 0);
});

test('the process dies after the mint was sent and before it was recorded: recovery finds it by memo and never mints twice', async () => {
  const s = stack();
  const p = await s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k4' });
  s.desk.crashAfterSend = true;
  await assert.rejects(() => s.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey }), /simulated crash/);
  assert.equal(s.desk.db.mints[p.id].state, 'sent');
  assert.equal(s.registry.residents().length, 0, 'not registered yet: the registry did not hear of it');
  // Restart: a new desk over the same state file sees the intent and recovers.
  const s2 = stack({ store: s.store.reopen(), chain: s.chain });
  const m = await s2.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey });
  assert.equal(m.recovered, true);
  assert.equal(s2.chain.events.filter(e => e.kind === 'mint').length, 1);
  assert.equal(s2.registry.entitlement(A.publicKey).onWaitlist, true);
});

test('a mint whose outcome is unknown and not findable is left unknown, not retried blindly', async () => {
  const s = stack();
  const p = await s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k5' });
  s.desk.db.mints[p.id] = { paymentRecordId: p.id, intent: 'intent_lost', to: A.publicKey, state: 'sent', assetId: null };
  await rejects(() => s.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey }), ERR.MINT_UNKNOWN);
  assert.equal(s.chain.events.filter(e => e.kind === 'mint').length, 0);
});

test('a duplicate mint notification does not make a second resident', async () => {
  const s = stack();
  const p = await s.desk.pay({ wallet: A.publicKey, idempotencyKey: 'k6' });
  const m = await s.desk.mintFor({ paymentRecordId: p.id, to: A.publicKey });
  const d = await s.registry.ingest({ kind: 'mint', assetId: m.assetId, signature: m.signature, slot: m.slot, to: A.publicKey });
  assert.equal(d.applied, 'duplicate');
  assert.equal(s.registry.residents().length, 1);
});
