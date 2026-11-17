// A → B → A: no old authority may come back, also when the relay saw none
// of it. What makes this certain on chain is the transfer guard: a guarded
// asset can only change hands through the resident program, which bumps the
// holder generation and clears the session in the same transaction. The
// unguarded case is kept as the documented hole (CONTRACT §10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/errors.mjs';
import { signTx } from '../src/mock-chain.mjs';
import { A, B, AGENT, acquire, login, op, rejects, stack, transfer } from './fixtures.mjs';

/** A's full set of authorities, taken while A holds the resident. */
async function arm(s, a) {
  const ta = await login(s, A, a.assetId);
  const cap = await s.auth.issueCapability({ loginToken: ta.token, label: 'mcp' });
  s.gateway.holdAgentKey(AGENT);
  await s.auth.recordDelegation({ loginToken: ta.token, agentKey: AGENT.publicKey });
  s.chain.send(signTx(s.chain.buildSetSession({ assetId: a.assetId, holder: A.publicKey, session: AGENT.publicKey, expiry: s.chain.now() + 86_400 }), [A]));
  const presignedWallet = signTx(s.chain.buildOp({ assetId: a.assetId, actor: A.publicKey, op: op(a.residentId, 'Harvest') }), [A]);
  const presignedSession = signTx(s.chain.buildOp({ assetId: a.assetId, actor: AGENT.publicKey, op: op(a.residentId, 'Harvest') }), [AGENT]);
  // Everything works now.
  assert.equal((await s.gateway.submit({ credential: ta.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'arm-1' })).status, 'sent');
  assert.equal((await s.gateway.submit({ credential: cap.token, signer: A, op: op(a.residentId, 'Chop'), idempotencyKey: 'arm-2' })).status, 'sent');
  assert.equal((await s.gateway.submit({ credential: { agentKey: AGENT.publicKey, assetId: a.assetId }, op: op(a.residentId, 'Chop'), idempotencyKey: 'arm-3' })).status, 'sent');
  return { ta, cap, presignedWallet, presignedSession, food: s.world.snapshot(a.residentId).stores.food };
}

test('guarded asset, A→B→A unobserved by the relay: every old authority of A is refused; A logs in afresh at a new generation', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const old = await arm(s, a);
  assert.equal(s.registry.resident(a.assetId).epoch, 0);
  // The relay sees nothing of the two transfers: no notification, no read in between.
  await transfer(s, a.assetId, A, B, { notify: false });
  await transfer(s, a.assetId, B, A, { notify: false });
  assert.equal(s.chain.ownerOf(a.assetId), A.publicKey);
  assert.equal(s.chain.residentOf(a.assetId).gen, 2, 'the program bumped the generation twice');
  assert.equal(s.chain.sessionOf(a.assetId), null, 'the session was cleared by the transfer');
  // Relay-side: the same holder as before, but the chain's generation moved; everything issued at generation 0 is refused.
  const viaToken = await s.gateway.submit({ credential: old.ta.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'bb-1' });
  assert.deepEqual([viaToken.status, viaToken.code], ['refused', ERR.OWNER_CHANGED]);
  assert.equal(viaToken.message.includes('changed hands'), true);
  await rejects(() => s.auth.authorize({ credential: old.cap.token }), ERR.BAD_CREDENTIAL);
  await rejects(() => s.auth.authorize({ credential: { agentKey: AGENT.publicKey, assetId: a.assetId } }), ERR.BAD_CREDENTIAL);
  assert.equal(s.registry.resident(a.assetId).epoch, 2);
  assert.equal(s.registry.resident(a.assetId).bypassed, undefined);
  // Chain-side, around the relay: the old session key (cleared), A's pre-signed op (stale generation), the session's pre-signed op.
  await rejects(() => s.chain.send(signTx(s.chain.buildOp({ assetId: a.assetId, actor: AGENT.publicKey, op: op(a.residentId, 'Harvest') }), [AGENT])), ERR.NOT_OWNER);
  await rejects(() => s.chain.send(old.presignedWallet), ERR.STALE_GEN);
  await rejects(() => s.chain.send(old.presignedSession), ERR.NOT_OWNER);
  assert.equal(s.world.snapshot(a.residentId).stores.food, old.food, 'nothing landed');
  // A, as the holder again, logs in afresh: a credential of generation 2; the data is the same resident's.
  const fresh = await login(s, A, a.assetId);
  assert.equal(fresh.epoch, 2);
  assert.equal((await s.gateway.submit({ credential: fresh.token, signer: A, op: op(a.residentId, 'Harvest'), idempotencyKey: 'bb-2' })).status, 'sent');
  assert.equal(s.world.snapshot(a.residentId).stores.food, old.food + 10);
  // A can delegate again, by a new SetSession in generation 2; the same agent key then works for generation 2 only.
  s.chain.send(signTx(s.chain.buildSetSession({ assetId: a.assetId, holder: A.publicKey, session: AGENT.publicKey, expiry: s.chain.now() + 86_400 }), [A]));
  await s.auth.recordDelegation({ loginToken: fresh.token, agentKey: AGENT.publicKey });
  assert.equal((await s.gateway.submit({ credential: { agentKey: AGENT.publicKey, assetId: a.assetId }, op: op(a.residentId, 'Chop'), idempotencyKey: 'bb-3' })).status, 'sent');
  // Even with the agent key delegated again, an operation it signed against generation 0 is stale: the generation is in the message.
  await rejects(() => s.chain.send(signTx(s.chain.buildOp({ assetId: a.assetId, actor: AGENT.publicKey, op: op(a.residentId, 'Harvest'), gen: 0 }), [AGENT])), ERR.STALE_GEN);
});

test('guarded asset, A→B observed and B→A unobserved: the credentials revoked at A→B stay dead; nothing of generation 0 or 1 works at 2', async () => {
  const s = stack();
  const a = await acquire(s, A);
  s.registry.publish();
  const old = await arm(s, a);
  await transfer(s, a.assetId, A, B);                       // observed
  assert.equal(s.auth.peek(old.cap.token), null);
  const tb = await login(s, B, a.assetId);
  assert.equal(tb.epoch, 1);
  await transfer(s, a.assetId, B, A, { notify: false });    // unobserved
  await rejects(() => s.auth.authorize({ credential: old.ta.token }), ERR.BAD_CREDENTIAL);
  await rejects(() => s.auth.authorize({ credential: tb.token }), ERR.OWNER_CHANGED);
  await rejects(() => s.chain.send(old.presignedWallet), ERR.STALE_GEN);
  assert.equal((await login(s, A, a.assetId)).epoch, 2);
});

test('the guard itself: a plain Core transfer of a guarded asset is refused (permanently frozen); only the holder\'s TransferResident moves it; nobody else can call it', async () => {
  const s = stack();
  const a = await acquire(s, A);
  await rejects(() => transfer(s, a.assetId, A, B, { plain: true }), ERR.FROZEN);
  assert.equal(s.chain.ownerOf(a.assetId), A.publicKey);
  // B (not the owner) cannot move it through the program either; a forged signature is refused before the program runs.
  await rejects(() => s.chain.send(signTx(s.chain.buildTransferResident({ assetId: a.assetId, from: B.publicKey, to: B.publicKey }), [B])), ERR.NOT_OWNER);
  const forged = { message: s.chain.buildTransferResident({ assetId: a.assetId, from: A.publicKey, to: B.publicKey }), signatures: {} };
  forged.signatures[A.publicKey] = signTx({ ...forged.message, signers: [B.publicKey] }, [B]).signatures[B.publicKey];
  await rejects(() => s.chain.send(forged), ERR.BAD_SIGNATURE);
  const t = await transfer(s, a.assetId, A, B);
  assert.equal(t.gen, 1);
  assert.equal(s.chain.ownerOf(a.assetId), B.publicKey);
});

test('the hole, documented: an UNGUARDED asset moved by plain Core transfers A→B→A revives A\'s old session and pre-signed operation; the relay flags the bypass', async () => {
  const s = stack();
  const a = await acquire(s, A, { guard: false });
  s.registry.publish();
  const old = await arm(s, a);
  await transfer(s, a.assetId, A, B, { notify: false });
  await transfer(s, a.assetId, B, A, { notify: false });
  assert.equal(s.chain.residentOf(a.assetId).gen, 0, 'the program never ran: no generation bump');
  // On chain, the setter check passes again: the setter (A) is the owner (A) and the generation did not move.
  const revived = s.chain.send(signTx(s.chain.buildOp({ assetId: a.assetId, actor: AGENT.publicKey, op: op(a.residentId, 'Harvest') }), [AGENT]));
  assert.equal(revived.ok, true);
  assert.equal(s.chain.send(old.presignedWallet).ok, true);
  // The relay that observed nothing cannot tell either: A's token still authorizes.
  assert.equal((await s.auth.authorize({ credential: old.ta.token })).epoch, 0);
  // Had the relay observed one hop, it would count a bypass (a holder change with no generation bump) and flag the resident.
  const s2 = stack();
  const a2 = await acquire(s2, A, { guard: false });
  await transfer(s2, a2.assetId, A, B);
  const rec = s2.registry.resident(a2.assetId);
  assert.deepEqual([rec.bypassed, rec.observedBypasses, rec.chainGen, rec.epoch], [true, 1, 0, 1]);
});
