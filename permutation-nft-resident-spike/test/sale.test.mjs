// The dedicated sale path: payment, transfer, generation bump and session
// clear in one instruction; nothing partial survives a failure; no double
// payment or double execution under a retry, a lost answer or a race.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/errors.mjs';
import { signTx } from '../src/mock-chain.mjs';
import { SaleDesk } from '../src/sale.mjs';
import { A, B, C, AGENT, acquire, login, op, rejects, stack } from './fixtures.mjs';

const MINT = 'TestUSDC1111111111111111111111111111111111';
const PRICE = 25_000_000n; // TEST VALUE (25 units of a 6-decimal test token); not a price decision

function saleStack() {
  const s = stack();
  s.desk2 = new SaleDesk({ store: s.store, chain: s.chain, registry: s.registry, now: s.clock });
  s.chain.mintTokens(MINT, B.publicKey, 100_000_000n);
  s.chain.mintTokens(MINT, C.publicKey, 100_000_000n);
  return s;
}
const bal = (s, w) => s.chain.balance(MINT, w.publicKey);
const snapshot = (s, assetId) => ({ owner: s.chain.ownerOf(assetId), gen: s.chain.residentOf(assetId).gen, session: s.chain.sessionOf(assetId), listed: s.chain.listings.has(assetId), a: bal(s, A), b: bal(s, B), c: bal(s, C), op: s.chain.balance(MINT, s.chain.operator) });

test('a buy moves the payment, the asset, the generation and the session together; the seller\'s delegation and session end in the same transaction', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  s.registry.publish();
  const ta = await login(s, A, a.assetId);
  s.chain.send(signTx(s.chain.buildSetSession({ assetId: a.assetId, holder: A.publicKey, session: AGENT.publicKey, expiry: s.chain.now() + 86_400 }), [A]));
  s.desk2.list({ assetId: a.assetId, seller: A, price: PRICE, mint: MINT });
  const before = snapshot(s, a.assetId);
  const r = await s.desk2.buy({ idempotencyKey: 'buy-1', assetId: a.assetId, buyer: B });
  assert.deepEqual([r.state, r.gen, r.price, r.fee], ['landed', 1, String(PRICE), String((PRICE * 250n) / 10_000n)]);
  const after = snapshot(s, a.assetId);
  const fee = (PRICE * 250n) / 10_000n;
  assert.deepEqual([after.owner, after.gen, after.session, after.listed], [B.publicKey, before.gen + 1, null, false]);
  assert.equal(after.b, before.b - PRICE);
  assert.equal(after.a, before.a + PRICE - fee);
  assert.equal(after.op, before.op + fee);
  // The relay learned of it through the desk; A's login is dead, B logs in.
  await rejects(() => s.auth.authorize({ credential: ta.token }), ERR.BAD_CREDENTIAL);
  assert.equal((await login(s, B, a.assetId)).epoch, 1);
});

test('a failure after the payment leg leaves no payment, no transfer, no generation change; the listing stays', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  s.desk2.list({ assetId: a.assetId, seller: A, price: PRICE, mint: MINT });
  const before = snapshot(s, a.assetId);
  s.chain.failInside = 'afterPayment';
  const r = await s.desk2.buy({ idempotencyKey: 'buy-fail', assetId: a.assetId, buyer: B });
  assert.deepEqual([r.state, r.code], ['failed', ERR.BAD_DATA]);
  assert.deepEqual(snapshot(s, a.assetId), before, 'all or nothing');
  // The failed signature is a processed transaction: a resend is AlreadyProcessed, not a second attempt.
  const again = await s.desk2.buy({ idempotencyKey: 'buy-fail', assetId: a.assetId, buyer: B });
  assert.deepEqual([again.state, again.replayed], ['failed', true]);
  // A fresh key buys normally afterwards.
  assert.equal((await s.desk2.buy({ idempotencyKey: 'buy-ok', assetId: a.assetId, buyer: B })).state, 'landed');
});

test('a two-instruction transaction [payment, transfer] is all or nothing too: a refused transfer rolls the payment back', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  const before = snapshot(s, a.assetId);
  // B pays A and A gives the resident to B in one transaction (both sign); here A's transfer names the wrong owner, so it fails.
  const tx = s.chain.buildTx([s.chain.ixTokenTransfer({ mint: MINT, from: B.publicKey, to: A.publicKey, amount: PRICE }), { ...s.chain.buildTransferResident({ assetId: a.assetId, from: C.publicKey, to: B.publicKey }) }]);
  await rejects(() => s.chain.send(signTx(tx, [B, C])), ERR.NOT_OWNER);
  assert.deepEqual(snapshot(s, a.assetId), before);
  // The same two instructions, correctly signed, land together.
  const ok = s.chain.send(signTx(s.chain.buildTx([s.chain.ixTokenTransfer({ mint: MINT, from: B.publicKey, to: A.publicKey, amount: PRICE }), s.chain.buildTransferResident({ assetId: a.assetId, from: A.publicKey, to: B.publicKey })]), [A, B]));
  assert.equal(ok.ok, true);
  assert.deepEqual([s.chain.ownerOf(a.assetId), bal(s, B)], [B.publicKey, before.b - PRICE]);
});

test('insufficient funds, a stale listing (gift after listing), a price above the buyer\'s maximum: refused, nothing moves', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  s.desk2.list({ assetId: a.assetId, seller: A, price: 500_000_000n, mint: MINT });
  const before = snapshot(s, a.assetId);
  assert.equal((await s.desk2.buy({ idempotencyKey: 'poor', assetId: a.assetId, buyer: B })).code, ERR.INSUFFICIENT_FUNDS);
  assert.equal((await s.desk2.buy({ idempotencyKey: 'cap', assetId: a.assetId, buyer: C, maxPrice: 1n })).code, ERR.PRICE_CHANGED);
  assert.deepEqual(snapshot(s, a.assetId), before);
  // A gives the resident to C after listing: the listing is gone (and would be stale by generation); B's buy pays nothing.
  s.chain.send(signTx(s.chain.buildTransferResident({ assetId: a.assetId, from: A.publicKey, to: C.publicKey }), [A]));
  const r = await s.desk2.buy({ idempotencyKey: 'stale', assetId: a.assetId, buyer: B });
  assert.equal(r.code, ERR.NO_LISTING);
  assert.equal(bal(s, B), before.b);
  // A listing made by an old holder is stale once the generation moved, even if the account were replayed.
  s.chain.listings.set(a.assetId, { seller: A.publicKey, price: '1', mint: MINT, gen: 0, slot: 1 });
  assert.equal((await s.desk2.buy({ idempotencyKey: 'stale2', assetId: a.assetId, buyer: B })).code, ERR.LISTING_STALE);
  assert.equal(bal(s, B), before.b);
});

test('double purchase: two buyers, one listing: exactly one pays and owns; the loser\'s resend and fresh retry pay nothing', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  s.desk2.list({ assetId: a.assetId, seller: A, price: PRICE, mint: MINT });
  const txB = signTx(s.chain.buildTx([s.chain.ixBuy({ assetId: a.assetId, buyer: B.publicKey })]), [B]);
  const txC = signTx(s.chain.buildTx([s.chain.ixBuy({ assetId: a.assetId, buyer: C.publicKey })]), [C]);
  const first = s.chain.send(txB);
  assert.equal(first.ok, true);
  await rejects(() => s.chain.send(txC), ERR.NO_LISTING);
  await rejects(() => s.chain.send(txC), ERR.ALREADY_PROCESSED);
  await rejects(() => s.chain.send(txB), ERR.ALREADY_PROCESSED);
  assert.deepEqual([s.chain.ownerOf(a.assetId), bal(s, B), bal(s, C)], [B.publicKey, 100_000_000n - PRICE, 100_000_000n]);
  assert.equal(s.chain.residentOf(a.assetId).gen, 1, 'one transfer, one generation');
  // A double click through the desk under one key is one purchase.
  const s2 = saleStack();
  const a2 = await acquire(s2, A);
  s2.desk2.list({ assetId: a2.assetId, seller: A, price: PRICE, mint: MINT });
  const [r1, r2] = await Promise.all([s2.desk2.buy({ idempotencyKey: 'dbl', assetId: a2.assetId, buyer: B }), s2.desk2.buy({ idempotencyKey: 'dbl', assetId: a2.assetId, buyer: B })]);
  assert.equal(r1.signature, r2.signature);
  assert.equal(bal(s2, B), 100_000_000n - PRICE);
});

test('a lost answer: the signature was recorded before the send, recovery looks it up, nothing is sent twice', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  s.desk2.list({ assetId: a.assetId, seller: A, price: PRICE, mint: MINT });
  s.desk2.loseAnswer = true;
  await assert.rejects(() => s.desk2.buy({ idempotencyKey: 'lost', assetId: a.assetId, buyer: B }), /answer to the send was lost/);
  assert.equal(s.desk2.db.purchases.lost.state, 'sent');
  // A restarted desk over the same state: the client retries with the same key → recovery by signature, no second transaction.
  const s2 = { ...s, store: s.store.reopen() };
  const desk = new SaleDesk({ store: s2.store, chain: s.chain, registry: s.registry });
  const sent = s.chain.events.filter(e => e.kind === 'transfer').length;
  const r = await desk.buy({ idempotencyKey: 'lost', assetId: a.assetId, buyer: B });
  assert.deepEqual([r.state, r.recovered, r.replayed], ['landed', true, true]);
  assert.equal(s.chain.events.filter(e => e.kind === 'transfer').length, sent);
  assert.equal(bal(s, B), 100_000_000n - PRICE);
});

test('sale versus game operation: the chain\'s order decides; a seller\'s operation after the sale is StaleGen or NotOwner, one before it stands for the buyer', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  s.registry.publish();
  await login(s, A, a.assetId);
  const opByA = signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest') }), [A]);
  const opByA2 = signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Chop') }), [A]);
  s.desk2.list({ assetId: a.assetId, seller: A, price: PRICE, mint: MINT });
  // Operation first, then the sale: the harvest is the resident's and B inherits it.
  s.chain.send(opByA);
  await s.desk2.buy({ idempotencyKey: 'race-sale', assetId: a.assetId, buyer: B });
  assert.equal(s.world.snapshot(a.residentId).stores.food, 110);
  // A's other operation, signed before the sale, arrives after it: refused (A is not the owner; had A bought back, the generation would refuse it).
  await rejects(() => s.chain.send(opByA2), ERR.NOT_OWNER);
  assert.equal(s.world.snapshot(a.residentId).stores.food, 110);
});

test('bypass attempts on a guarded asset: plain transfer, owner-approved transfer delegate, owner thaw, permanent thaw: none moves it or its generation', async () => {
  const s = saleStack();
  const a = await acquire(s, A);
  const before = snapshot(s, a.assetId);
  await rejects(() => s.chain.send(signTx(s.chain.buildTransfer({ assetId: a.assetId, from: A.publicKey, to: B.publicKey }), [A])), ERR.FROZEN);
  s.chain.send(signTx(s.chain.buildTx([s.chain.ixApproveTransferDelegate({ assetId: a.assetId, owner: A.publicKey, delegate: C.publicKey })]), [A]));
  await rejects(() => s.chain.send(signTx(s.chain.buildTx([s.chain.ixTransferByDelegate({ assetId: a.assetId, delegate: C.publicKey, to: B.publicKey })]), [C])), ERR.FROZEN);
  await rejects(() => s.chain.send(signTx(s.chain.buildTx([s.chain.ixThaw({ assetId: a.assetId, by: A.publicKey, permanent: true })]), [A])), ERR.AUTH);
  await rejects(() => s.chain.send(signTx(s.chain.buildTx([s.chain.ixThaw({ assetId: a.assetId, by: s.authority.publicKey, permanent: true })]), [s.authority])), ERR.AUTH);
  // The owner-managed thaw succeeds but changes nothing about the permanent freeze: the delegate still cannot move it.
  s.chain.send(signTx(s.chain.buildTx([s.chain.ixThaw({ assetId: a.assetId, by: A.publicKey })]), [A]));
  await rejects(() => s.chain.send(signTx(s.chain.buildTx([s.chain.ixTransferByDelegate({ assetId: a.assetId, delegate: C.publicKey, to: B.publicKey })]), [C])), ERR.FROZEN);
  assert.deepEqual([s.chain.ownerOf(a.assetId), s.chain.residentOf(a.assetId).gen], [before.owner, before.gen]);
  // An UNGUARDED asset shows what the guard prevents: the owner's delegate moves it with no generation bump.
  const u = await acquire(s, A, { guard: false });
  s.chain.send(signTx(s.chain.buildTx([s.chain.ixApproveTransferDelegate({ assetId: u.assetId, owner: A.publicKey, delegate: C.publicKey })]), [A]));
  s.chain.send(signTx(s.chain.buildTx([s.chain.ixTransferByDelegate({ assetId: u.assetId, delegate: C.publicKey, to: B.publicKey })]), [C]));
  assert.deepEqual([s.chain.ownerOf(u.assetId), s.chain.residentOf(u.assetId).gen], [B.publicKey, 0]);
});
