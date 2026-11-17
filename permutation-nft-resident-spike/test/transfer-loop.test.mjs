// The one loop the brief asks for, and the races around it:
//   A acquires → waitlist → test publish → A logs in → A changes the village
//   → A transfers to B → B logs in to the same data → A's new operations and
//   A's old delegations are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/errors.mjs';
import { signTx } from '../src/mock-chain.mjs';
import { A, B, C, AGENT, acquire, login, op, rejects, stack, transfer } from './fixtures.mjs';

test('the loop: acquire, waitlist, publish, log in, act, transfer, the buyer continues the same resident, the seller is out', async () => {
  const s = stack();
  // 1. A acquires: the asset is the waitlist entry. No separate registration.
  const a = await acquire(s, A);
  assert.deepEqual(s.registry.waitlist().map(r => [r.holder, r.status]), [[A.publicKey, 'eligible']]);
  assert.equal(s.registry.entitlement(A.publicKey).canLogin, false);
  // 2. The test publish switch: the record is the same object as before.
  const before = JSON.stringify(s.registry.resident(a.assetId));
  s.registry.publish();
  assert.equal(JSON.stringify(s.registry.resident(a.assetId)), before);
  // 3. A logs in and changes the village (the village is created by A's first operation, not by publish or login).
  const ta = await login(s, A, a.assetId);
  assert.equal(s.world.snapshot(a.residentId), null, 'no village before the first operation');
  const r1 = await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'A-1' });
  assert.equal(r1.status, 'sent');
  await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Build', { kind: 'farm' }), idempotencyKey: 'A-2' });
  const villageA = s.world.snapshot(a.residentId);
  assert.equal(villageA.stores.food, 110);
  assert.equal(villageA.buildings.length, 1);
  assert.equal(villageA.createdAt.signature, r1.signature);
  // A hands a capability to a tool and a delegation to an agent; both work while A holds.
  const cap = await s.auth.issueCapability({ loginToken: ta.token, label: 'mcp' });
  s.gateway.holdAgentKey(AGENT);
  await s.auth.recordDelegation({ loginToken: ta.token, agentKey: AGENT.publicKey });
  s.chain.send(signTx(s.chain.buildSetSession({ assetId: a.assetId, holder: A.publicKey, session: AGENT.publicKey, expiry: s.chain.now() + 86_400 }), [A]));
  assert.equal((await s.gateway.submit({ credential: cap.token, signer: A, op: op(a.residentId, 'Chop'), idempotencyKey: 'A-cap-1' })).status, 'sent');
  assert.equal((await s.gateway.submit({ credential: { agentKey: AGENT.publicKey, assetId: a.assetId }, op: op(a.residentId, 'Chop'), idempotencyKey: 'A-agent-1' })).status, 'sent');
  // 4. A transfers to B.
  const t = await transfer(s, a.assetId, A, B);
  assert.equal(t.ingested.applied, 'confirmed');
  // 5. B logs in to the same resident and sees A's village as it is.
  const tb = await login(s, B, a.assetId);
  assert.equal(tb.residentId, a.residentId);
  assert.equal(tb.epoch, 1);
  const seen = s.world.snapshot(a.residentId);
  assert.equal(seen.stores.food, 110);
  assert.equal(seen.stores.wood, 40);
  assert.equal(seen.buildings.length, 1);
  assert.equal(seen.history.length, 4, 'the history A made is B\'s to read now');
  const rb = await s.gateway.submit({ credential: tb.token, signer: B, op: op(a.residentId, 'Harvest'), idempotencyKey: 'B-1' });
  assert.equal(rb.status, 'sent');
  assert.equal(s.world.snapshot(a.residentId).stores.food, 120);
  // 6. A's new operations: the login token, the capability, the agent delegation, and A's own key straight at the chain.
  const viaToken = await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'A-3' });
  assert.deepEqual([viaToken.status, viaToken.code], ['refused', ERR.BAD_CREDENTIAL], 'revoked when the registry confirmed the transfer');
  const viaCap = await s.gateway.submit({ credential: cap.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'A-cap-2' });
  assert.deepEqual([viaCap.status, viaCap.code], ['refused', ERR.BAD_CREDENTIAL]);
  const viaAgent = await s.gateway.submit({ credential: { agentKey: AGENT.publicKey, assetId: a.assetId }, op: op(a.residentId, 'Harvest'), idempotencyKey: 'A-agent-2' });
  assert.deepEqual([viaAgent.status, viaAgent.code], ['refused', ERR.BAD_CREDENTIAL]);
  // Around the relay: A's wallet signs an op itself → the program's prologue refuses (A is not the owner).
  await rejects(() => s.chain.send(signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest') }), [A])), ERR.NOT_OWNER);
  // Around the relay: the agent key A delegated on chain → refused, because the session was set by A, who no longer owns the asset.
  await rejects(() => s.chain.send(signTx(s.chain.buildOp({ assetId: a.assetId, actor: AGENT.publicKey, op: op(a.residentId, 'Harvest') }), [AGENT])), ERR.NOT_OWNER);
  assert.equal(s.world.snapshot(a.residentId).stores.food, 120, 'nothing of A\'s landed after the transfer');
  // A cannot log in again either; B can delegate afresh (a new SetSession by B) and the agent then acts for B.
  await rejects(() => login(s, A, a.assetId), ERR.NOT_HOLDER);
  s.chain.send(signTx(s.chain.buildSetSession({ assetId: a.assetId, holder: B.publicKey, session: AGENT.publicKey, expiry: s.chain.now() + 86_400 }), [B]));
  await s.auth.recordDelegation({ loginToken: tb.token, agentKey: AGENT.publicKey });
  assert.equal((await s.gateway.submit({ credential: { agentKey: AGENT.publicKey, assetId: a.assetId }, op: op(a.residentId, 'Chop'), idempotencyKey: 'B-agent-1' })).status, 'sent');
});

test('transfer versus operation: the chain\'s order decides; an operation after the transfer fails in the prologue even if the relay had authorized it', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const ta = await login(s, A, a.assetId);
  // A signs an operation now (valid for 150 slots) but it is not sent yet.
  const presigned = signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest') }), [A]);
  // The transfer lands first, in the same slot.
  await transfer(s, a.assetId, A, B);
  // The relay refuses it before sending (the holder changed) …
  const viaRelay = await s.gateway.submit({ credential: ta.token, op: op(a.residentId, 'Harvest'), idempotencyKey: 'late-1', presigned });
  assert.deepEqual([viaRelay.status, viaRelay.code], ['refused', ERR.BAD_CREDENTIAL]);
  // … and had it been sent straight to the chain, the program refuses it: the signature is A's, the owner is B.
  await rejects(() => s.chain.send(presigned), ERR.NOT_OWNER);
  assert.equal(s.world.snapshot(a.residentId), null);
  // The other order: the operation lands first, then the transfer; the operation stands and B inherits its result.
  const a2 = await acquire(s, A);
  const ta2 = await login(s, A, a2.assetId);
  const r = await s.gateway.submit({ credential: ta2.token, signer: A, op: op(a2.residentId, 'Harvest'), idempotencyKey: 'early-1' });
  assert.equal(r.status, 'sent');
  await transfer(s, a2.assetId, A, B);
  assert.equal(s.world.snapshot(a2.residentId).stores.food, 110);
  // A retry of the earlier request under its key replays the recorded result and sends nothing.
  const again = await s.gateway.submit({ credential: ta2.token, signer: A, op: op(a2.residentId, 'Harvest'), idempotencyKey: 'early-1' });
  assert.deepEqual([again.status, again.replayed, again.signature], ['sent', true, r.signature]);
  assert.equal(s.world.snapshot(a2.residentId).stores.food, 110);
});

test('a race inside the relay: the holder changes between authorization and send → beforeSend refuses, nothing sent', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const ta = await login(s, A, a.assetId);
  // Hook the registry so that the transfer happens right after the first (authorizing) read.
  const orig = s.registry.holderNow.bind(s.registry);
  let reads = 0;
  s.registry.holderNow = async (...args) => { const h = await orig(...args); if (++reads === 1) await transfer(s, a.assetId, A, B); return h; };
  const r = await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'race-1' });
  assert.deepEqual([r.status, r.code], ['refused', ERR.OWNER_CHANGED]);
  assert.equal(s.chain.events.filter(e => e.kind === 'op').length, 0);
});

test('pre-signed operations outlive nothing: an expired blockhash is refused, a replayed signature is refused', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const presigned = signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest'), validUntilSlot: s.chain.slot + 2 }), [A]);
  s.chain.send(presigned);
  await rejects(() => s.chain.send(presigned), ERR.ALREADY_PROCESSED);
  const late = signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest'), validUntilSlot: s.chain.slot + 2 }), [A]);
  s.chain.tick(3);
  await rejects(() => s.chain.send(late), ERR.BLOCKHASH_EXPIRED);
  // A signature by someone else over A's message is refused before anything runs.
  const forged = { message: s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest') }), signatures: {} };
  forged.signatures[A.publicKey] = signTx({ ...forged.message, signers: [B.publicKey] }, [B]).signatures[B.publicKey];
  await rejects(() => s.chain.send(forged), ERR.BAD_SIGNATURE);
  assert.equal(s.world.snapshot(a.residentId).stores.food, 110);
});

test('what is in flight at the transfer: caravans and orders belong to the resident and reach the buyer; the seller\'s cost approval is void', async () => {
  const s = stack();
  const a = await acquire(s, A);
  const other = await acquire(s, C);
  s.registry.publish();
  const ta = await login(s, A, a.assetId);
  // A caravan needs a cost approval: the first submit opens one.
  const ask = await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'SendCaravan', { food: 30, to: a.residentId }), idempotencyKey: 'cv-1' });
  assert.equal(ask.status, 'awaiting-approval');
  await s.gateway.approve({ credential: ta.token, approvalId: ask.approvalId });
  const sent = await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'SendCaravan', { food: 30, to: a.residentId }), idempotencyKey: 'cv-1-send', approvalId: ask.approvalId });
  assert.equal(sent.status, 'sent');
  await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'PlaceOrder'), idempotencyKey: 'od-1' });
  // A second caravan is waiting for A's approval when the transfer happens.
  const waiting = await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'SendCaravan', { food: 10, to: a.residentId }), idempotencyKey: 'cv-2' });
  assert.equal(waiting.status, 'awaiting-approval');
  // Goods held for C and a debt owed to C are recorded on A's resident.
  await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'HoldForOther', { owner: other.residentId, food: 25 }), idempotencyKey: 'hf-1' });
  await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Promise', { to: other.residentId, food: 15 }), idempotencyKey: 'ow-1' });
  // A reward A's wallet earned stays keyed to A's wallet (as the prize Entry is today).
  s.world.creditWalletReward(A.publicKey, 7, 'season reward (test units)');
  const inFlight = s.world.snapshot(a.residentId);
  assert.equal(inFlight.caravans.length, 1);
  assert.equal(inFlight.orders.length, 1);
  await transfer(s, a.assetId, A, B);
  // A's pending approval is void: A cannot give it, B cannot use it.
  await rejects(() => s.gateway.approve({ credential: ta.token, approvalId: waiting.approvalId }), ERR.BAD_CREDENTIAL);
  assert.equal(s.world.approval(waiting.approvalId).state, 'waiting', 'nobody could give it; B\'s attempt below voids it');
  const tb = await login(s, B, a.assetId);
  const reuse = await s.gateway.submit({ credential: tb.token, signer: B, op: op(a.residentId, 'SendCaravan', { food: 10, to: a.residentId }), idempotencyKey: 'cv-2-by-B', approvalId: waiting.approvalId });
  assert.deepEqual([reuse.status, reuse.code], ['refused', ERR.APPROVAL_VOID]);
  await rejects(() => s.gateway.approve({ credential: tb.token, approvalId: waiting.approvalId }), ERR.APPROVAL_VOID);
  assert.equal(s.world.approval(waiting.approvalId).state, 'void');
  // Time passes: the caravan arrives and the order finishes, credited to the resident B now holds.
  s.world.tick(3);
  const after = s.world.snapshot(a.residentId);
  assert.equal(after.caravans.length, 0);
  assert.equal(after.orders.length, 0);
  assert.equal(after.stores.food, 100 - 30 + 30);
  assert.equal(after.stores.arms, 4);
  // Obligations are not erased by the transfer: C's goods are still held, the debt to C is still owed.
  assert.deepEqual(after.heldForOthers.map(h => [h.owner, h.food]), [[other.residentId, 25]]);
  assert.deepEqual(after.owed.map(o => [o.to, o.food]), [[other.residentId, 15]]);
  // The wallet reward stayed with A's wallet; B's wallet has none.
  assert.equal(s.world.walletReward(A.publicKey).unclaimed, 7);
  assert.equal(s.world.walletReward(B.publicKey).unclaimed, 0);
});

test('several NFTs, one wallet: residents are separate; a credential for one cannot act for another; a buy-back keeps the data apart and the old tokens dead', async () => {
  const s = stack();
  const a1 = await acquire(s, A);
  const a2 = await acquire(s, A);
  s.registry.publish();
  const t1 = await login(s, A, a1.assetId);
  const t2 = await login(s, A, a2.assetId);
  await s.gateway.submit({ credential: t1.token, signer: A, op: op(a1.residentId, 'Harvest'), idempotencyKey: 'm-1' });
  const cross = await s.gateway.submit({ credential: t1.token, signer: A, op: op(a2.residentId, 'Harvest'), idempotencyKey: 'm-2' });
  assert.deepEqual([cross.status, cross.code], ['refused', ERR.WRONG_RESIDENT]);
  // Straight at the chain: A's op for resident 2 signed by A, with asset 1 → the program refuses the mismatch.
  await rejects(() => s.chain.send(signTx(s.chain.buildOp({ assetId: a1.assetId, actor: A.publicKey, op: op(a2.residentId, 'Harvest') }), [A])), ERR.WRONG_RESIDENT);
  assert.equal(s.world.snapshot(a1.residentId).stores.food, 110);
  assert.equal(s.world.snapshot(a2.residentId), null);
  // A sells resident 1 to B and buys it back: the data is resident 1's, the epochs moved, every earlier token is dead.
  await transfer(s, a1.assetId, A, B);
  const tb = await login(s, B, a1.assetId);
  await s.gateway.submit({ credential: tb.token, signer: B, op: op(a1.residentId, 'Harvest'), idempotencyKey: 'b-1' });
  await transfer(s, a1.assetId, B, A);
  const back = await login(s, A, a1.assetId);
  assert.equal(back.epoch, 2);
  assert.equal(s.world.snapshot(a1.residentId).stores.food, 120, 'B\'s harvest is part of the resident A bought back');
  assert.equal(s.world.snapshot(a2.residentId), null, 'resident 2 untouched');
  await rejects(() => s.auth.authorize({ credential: t1.token }), ERR.BAD_CREDENTIAL);
  assert.equal((await s.auth.authorize({ credential: t2.token })).residentId, a2.residentId, 'the token for the other resident is unaffected');
  assert.equal(s.registry.residents().length, 2);
});

test('a frozen asset: the relay refuses operations while the chain refuses the transfer', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const ta = await login(s, A, a.assetId);
  s.chain.setFrozen(a.assetId, true);
  const r = await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'fz-1' });
  assert.deepEqual([r.status, r.code], ['refused', ERR.FROZEN]);
  await rejects(() => transfer(s, a.assetId, A, B), ERR.FROZEN);
});
