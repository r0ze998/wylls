// The agent wallet through its routes and gateway (docs/agent-wallet/DESIGN.md):
// owner commands (create, policy, mode, withdraw, action, rotate-capability),
// deposits, the one action path from every entry point, and every refusal
// the design names: a stopped agent, a stale policy or epoch, an action the
// policy or the game never delegates, another village, an undelegated
// session key, a repeated or conflicting idempotency key, a capability
// that is wrong or rotated, and an agent key sent around the gateway.
// After every step the ledger's books balance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encode as base58 } from '../client/src/base58.mjs';
import { toBase64 } from '../client/src/bytes.mjs';
import { shapeMessage } from '../client/src/frontier/shapes.mjs';
import { wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk, verifyTalk } from '../client/src/talk-node.mjs';
import { ERR, NEVER_DELEGATED } from '../src/frontier/agent/contract.mjs';
import { A, actionRequest, call, createAgent, delegate, deposit, fakeChain, ownerCommand, policy, relay, sound, VILLAGE } from './agent-wallet-fixtures.mjs';

// Loopback: the per-address limits do not apply (they are the relay tests' subject, not this file's).
const IP = '127.0.0.1';
const post = (r, path, body, ip = IP) => call(r.public, 'POST', path, { body, ip });
const get = (r, path, ip = IP) => call(r.public, 'GET', path, { ip });

test('without --agent-wallet every agent route is 404 AgentWalletDisabled; with it, the terms are public', async () => {
  const off = relay();
  off.ctx.agents = null;
  for (const [m, p] of [['GET', '/f/agent/terms'], ['GET', '/f/agent?id=x'], ['POST', '/f/agent/command'], ['POST', '/f/agent/action'], ['POST', '/f/agent/deposit']]) {
    const res = await call(off.public, m, p, { body: {}, ip: IP });
    assert.equal(res.status, 404, `${m} ${p}`);
    assert.equal(res.json.code, 'AgentWalletDisabled');
  }
  const r = relay({ prices: { inference: '10000', game: { Harvest: '0' } } });
  const t = await get(r, '/f/agent/terms');
  assert.equal(t.status, 200);
  assert.equal(t.json.prices.inference, '10000');
  assert.equal(t.json.prices.autopilot, '0');
  assert.equal(t.json.custodyAccount, r.custody.account);
  assert.equal(t.json.testAssetsOnly, true);
  assert.equal(t.json.networkFees.paidBy, 'relay');
  // The reconcile route is the operator's.
  assert.equal((await post(r, '/f/agent/reconcile', {})).status, 404);
  assert.equal((await call(r.operator, 'POST', '/f/agent/reconcile', { body: {}, headers: { authorization: 'Bearer op-token' } })).json.ok, true);
});

test('create: an owner-signed command makes an agent with a fresh key and a one-time capability; forged, replayed and expired commands are refused', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const { agentId, agentKey, capability, res } = await createAgent(r, owner, { policy: policy(['economy', 'SetVigil'], '500000', '100000') });
  assert.ok(agentKey && new PublicKey(agentKey).toBase58() === agentKey, 'a public key');
  assert.equal(res.json.agent.owner, owner.publicKey.toBase58());
  assert.equal(res.json.agent.payout, owner.publicKey.toBase58(), 'the payout is the owner, fixed');
  assert.equal(res.json.agent.mode, 'manual');
  assert.deepEqual(res.json.agent.policy.allowed, ['Build', 'Garrison', 'Harvest', 'Muster', 'SetVigil', 'Train']);
  assert.equal(res.json.agent.policy.version, 1);
  assert.equal(res.json.sessionTerms.fields.session, agentKey);
  assert.equal(res.json.sessionTerms.citizen, A.citizen(owner.publicKey.toBase58()));
  assert.ok(capability.length >= 40);
  assert.equal(res.json.agent.capability, undefined);
  // The view never carries the token; the state file holds its hash only.
  const v = await get(r, `/f/agent?id=${agentId}`);
  assert.equal(v.status, 200);
  assert.equal(JSON.stringify(v.json).includes(capability), false);
  assert.equal(JSON.stringify(r.agentStore.state).includes(capability), false);
  assert.equal(r.logs.join('\n').includes(capability), false);
  assert.equal(r.gateway.ledger.get(agentId).capabilityHash.length, 64);
  // Refusals.
  const forged = ownerCommand(owner, 'create', { params: { village: VILLAGE, policy: policy() } });
  forged.command.owner = Keypair.generate().publicKey.toBase58();
  assert.equal((await post(r, '/f/agent/command', forged)).json.code, ERR.BAD_OWNER_SIGNATURE);
  const once = ownerCommand(owner, 'create', { params: { village: VILLAGE, policy: policy() } });
  assert.equal((await post(r, '/f/agent/command', once)).status, 200);
  assert.equal((await post(r, '/f/agent/command', once)).json.code, ERR.OWNER_COMMAND_REPLAYED);
  assert.equal((await post(r, '/f/agent/command', ownerCommand(owner, 'create', { params: { village: VILLAGE, policy: policy() }, expiresAt: Date.now() - 1 }))).json.code, ERR.OWNER_COMMAND_EXPIRED);
  assert.equal((await post(r, '/f/agent/command', ownerCommand(owner, 'create', { params: { village: VILLAGE, policy: policy() }, expiresAt: Date.now() + 3_600_000 }))).json.code, ERR.OWNER_COMMAND_EXPIRED, 'at most 10 minutes ahead');
  for (const n of NEVER_DELEGATED) {
    const bad = await post(r, '/f/agent/command', ownerCommand(owner, 'create', { params: { village: VILLAGE, policy: policy([n]) } }));
    assert.equal(bad.status, 400, n);
    assert.match(bad.json.error, /never be delegated/);
  }
  assert.equal((await post(r, '/f/agent/command', ownerCommand(owner, 'create', { params: { village: [1, 2], policy: policy() } }))).status, 400);
  assert.equal((await post(r, '/f/agent/command', { command: { op: 'nope' }, signature: 'x' })).status, 400);
  // Only the owner changes the policy, mode or capability.
  const other = Keypair.generate();
  for (const [op, params] of [['policy', { policy: policy() }], ['mode', { mode: 'auto' }], ['rotate-capability', {}], ['withdraw', { all: true }]]) {
    assert.equal((await post(r, '/f/agent/command', ownerCommand(other, op, { agentId, params }))).json.code, ERR.NOT_OWNER, op);
  }
  assert.equal((await post(r, '/f/agent/command', ownerCommand(owner, 'policy', { agentId: 'nope', params: { policy: policy() } }))).json.code, ERR.UNKNOWN_AGENT);
  // At most 8 agents per owner.
  for (let i = 0; i < 6; i++) await createAgent(r, owner);
  assert.equal((await post(r, '/f/agent/command', ownerCommand(owner, 'create', { params: { village: VILLAGE, policy: policy() } }))).json.code, ERR.TOO_MANY_AGENTS);
  sound(r);
});

test('deposit: a confirmed, owner-signed transfer into the custody account is credited once; anything else is refused', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const { agentId } = await createAgent(r, owner);
  const { sig, res } = await deposit(r, o, agentId, 250_000n);
  assert.deepEqual([res.credited, res.amount, res.balance.available, res.balance.deposited], [true, '250000', '250000', '250000']);
  const again = await post(r, '/f/agent/deposit', { agentId, signature: sig });
  assert.equal(again.status, 200);
  assert.deepEqual([again.json.credited, again.json.already, again.json.balance.available], [false, true, '250000']);
  // The same signature credited to a second agent of the owner: still once.
  const { agentId: second } = await createAgent(r, owner);
  const twice = await post(r, '/f/agent/deposit', { agentId: second, signature: sig });
  assert.equal(twice.json.credited, false);
  assert.equal(twice.json.agentId, agentId);
  assert.equal(r.gateway.view(second).balance.available, '0');
  // Not confirmed yet: 409, try again.
  const pending = await post(r, '/f/agent/deposit', { agentId, signature: base58(Buffer.alloc(64, 5)) });
  assert.equal(pending.status, 409);
  assert.equal(pending.json.code, ERR.DEPOSIT_PENDING);
  // Failed on chain, not signed by the owner, gain from another wallet, no gain.
  const stranger = Keypair.generate().publicKey.toBase58();
  for (const [what, over] of [['failed', { err: { InstructionError: [0, 'Custom'] } }], ['unsigned', { signers: [stranger] }], ['gain not from the owner', { gained: 300_000n }], ['nothing gained', { gained: 0n }]]) {
    const bad = await deposit(r, o, agentId, 100_000n, over).catch(e => ({ res: e }));
    assert.equal(bad.res.code, ERR.DEPOSIT_INVALID, what);
  }
  assert.equal(r.gateway.view(agentId).balance.available, '250000');
  assert.equal((await post(r, '/f/agent/deposit', { agentId: 'nope', signature: sig })).json.code, ERR.UNKNOWN_AGENT);
  sound(r);
});

test('action: the one path refuses a stopped agent, a stale policy or epoch, a forbidden action, another village and an undelegated key, then sends the agent-signed shape through the relay', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const { agentId, agentKey, capability: first } = await createAgent(r, owner, { policy: policy(['economy']) });
  let capability = first;
  const act = (over = {}, cred = { capability }) => r.gateway.submit(actionRequest(agentId, over), cred);
  const refusedWith = async (code, over, cred) => {
    const res = await act(over, cred);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.status, 'refused');
    assert.equal(res.error.code, code, JSON.stringify(res.error));
    assert.deepEqual(res.charges, []);
    return res;
  };
  // Manual (the default): stopped.
  await refusedWith(ERR.AGENT_STOPPED, {});
  // Auto.
  const mode = await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId, params: { mode: 'auto' } }));
  assert.equal(mode.json.agent.mode, 'auto');
  assert.equal(mode.json.agent.modeEpoch, 1);
  await refusedWith(ERR.STALE_POLICY, { policyVersion: 2 });
  await refusedWith(ERR.STALE_MODE, { modeEpoch: 0 });
  await refusedWith(ERR.ACTION_NOT_ALLOWED, { name: 'Depart' });
  await refusedWith(ERR.ACTION_NOT_ALLOWED, { name: 'Join' });
  await refusedWith(ERR.ACTION_NOT_ALLOWED, { name: 'SetSession' });
  await refusedWith(ERR.WRONG_VILLAGE, { holding: [-3, 7, 10] });
  // No Citizen yet; then a Citizen whose session key is someone else's; then expired.
  await refusedWith(ERR.SESSION_NOT_DELEGATED, {});
  delegate(r, o, Keypair.generate().publicKey.toBase58());
  await refusedWith(ERR.SESSION_NOT_DELEGATED, {});
  delegate(r, o, agentKey, { expiry: 1 });
  await refusedWith(ERR.SESSION_NOT_DELEGATED, {});
  assert.equal(r.chain.sent.length, 0);
  assert.equal(r.chain.simulated, 0, 'nothing refused above reached the relay');
  // Delegated: Harvest goes out, signed by the agent key, paid by a pool key.
  delegate(r, o, agentKey);
  const res = await act({ key: 'k1', modeEpoch: 1 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.status, 'sent');
  assert.equal(r.chain.sent.length, 1);
  const sent = r.chain.sent[0];
  assert.ok(r.pool.has(sent.signers[0]), 'a pool fee payer');
  assert.equal(sent.signers[1], agentKey);
  assert.ok(verifyTalk(sent.message, sent.signatures[1], new PublicKey(agentKey).toBytes()), 'the agent signed');
  assert.equal(res.signature, base58(sent.signatures[0]));
  assert.deepEqual(res.charges, [], 'Harvest is free: nothing charged');
  assert.equal(r.store.state.quota[`citizen:${A.citizen(o)}`].left, 39, 'the citizen\'s quota, as a manual Harvest');
  const view = r.gateway.view(agentId);
  assert.ok(view.history.some(h => h.type === 'action' && h.name === 'Harvest' && h.status === 'sent' && h.signature === res.signature));
  assert.ok(view.history.some(h => h.type === 'network' && h.lamports === '10000' && h.paidBy === 'relay'), 'the fee is recorded in lamports, not charged');
  assert.equal(view.balance.spent.network, '0');
  assert.equal(r.ctx.sent.get(res.signature).kind, 'Harvest');
  // Idempotent: the same key and request replays the result; a different request under it conflicts.
  const replay = await act({ key: 'k1', modeEpoch: 1 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.signature, res.signature);
  assert.equal(r.chain.sent.length, 1);
  await assert.rejects(act({ key: 'k1', modeEpoch: 1, name: 'Train', fields: { unit: 1, n: 2 } }), e => e.code === ERR.IDEMPOTENCY_CONFLICT);
  // Fields: Train and Build (walls name the province), bad fields refused before anything is held or sent.
  assert.equal((await act({ key: 'k2', name: 'Train', fields: { unit: 1, n: '3' } })).status, 'sent');
  assert.equal((await act({ key: 'k3', name: 'Build', fields: { item: 6 } })).status, 'sent');
  assert.equal(r.chain.sent.at(-1).instructions[3].keys.length, 6, 'walls: the province is named');
  assert.equal((await act({ key: 'k4', name: 'Build', fields: { item: 1 } })).status, 'sent');
  assert.equal(r.chain.sent.at(-1).instructions[3].keys.length, 5);
  const badField = await act({ key: 'k5', name: 'Train', fields: { unit: 1, n: 2, extra: 1 } });
  assert.equal(badField.error.code, ERR.BAD_REQUEST);
  const missing = await act({ key: 'k6', name: 'Train', fields: { unit: 1 } });
  assert.equal(missing.error.code, ERR.BAD_REQUEST);
  assert.equal(r.chain.sent.length, 4);
  // Entry points: the capability route (source mcp/ai), the owner command route (source browser); the token is checked.
  const viaRoute = await post(r, '/f/agent/action', { capability, request: actionRequest(agentId, { key: 'r1', source: 'ai' }) });
  assert.equal(viaRoute.status, 200, JSON.stringify(viaRoute.json));
  assert.equal(viaRoute.json.status, 'sent');
  assert.equal((await post(r, '/f/agent/action', { capability: 'nope', request: actionRequest(agentId, { key: 'r2' }) })).json.code, ERR.BAD_CAPABILITY);
  assert.equal((await post(r, '/f/agent/action', { request: actionRequest(agentId, { key: 'r2' }) })).json.code, ERR.BAD_CAPABILITY);
  assert.equal((await post(r, '/f/agent/action', { capability, request: actionRequest(agentId, { key: 'r2', source: 'browser' }) })).status, 400);
  const viaOwner = await post(r, '/f/agent/command', ownerCommand(owner, 'action', { agentId, params: { idempotencyKey: 'o1', policyVersion: 1, action: { name: 'Harvest', holding: VILLAGE, fields: {} } } }));
  assert.equal(viaOwner.json.status, 'sent', JSON.stringify(viaOwner.json));
  const otherOwner = ownerCommand(Keypair.generate(), 'action', { agentId, params: { idempotencyKey: 'o2', policyVersion: 1, action: { name: 'Harvest', holding: VILLAGE, fields: {} } } });
  assert.equal((await post(r, '/f/agent/command', otherOwner)).json.code, ERR.NOT_OWNER);
  // Rotating the capability: the old token stops, the new one works, the owner's command signature is still needed for it.
  const rot = await post(r, '/f/agent/command', ownerCommand(owner, 'rotate-capability', { agentId }));
  assert.equal(rot.json.capability.version, 2);
  assert.equal((await post(r, '/f/agent/action', { capability, request: actionRequest(agentId, { key: 'r3' }) })).json.code, ERR.BAD_CAPABILITY);
  capability = rot.json.capability.token;
  assert.equal((await post(r, '/f/agent/action', { capability, request: actionRequest(agentId, { key: 'r3' }) })).json.status, 'sent');
  // The relay refuses the agent's key around the gateway: the same shape, agent-signed, on POST /f/relay.
  const feePayer = (await get(r, '/f/relay')).json.feePayer;
  const accounts = { actor: agentKey, season: A.season, citizen: A.citizen(o), holding: A.holding(...VILLAGE) };
  const message = shapeMessage({ programId: r.ctx.programId, name: 'Harvest', accounts, fields: {}, feePayer, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  const wire = wireTransaction(message, { [agentKey]: r.gateway.keyring.sign(agentId, message) });
  const direct = await post(r, '/f/relay', { tx: toBase64(wire) });
  assert.equal(direct.status, 403);
  assert.equal(direct.json.code, ERR.AGENT_KEY_DIRECT);
  // A new policy version refuses what was decided under the old one; manual stops everything.
  const pol = await post(r, '/f/agent/command', ownerCommand(owner, 'policy', { agentId, params: { policy: policy(['Harvest']) } }));
  assert.equal(pol.json.agent.policy.version, 2);
  await refusedWith(ERR.STALE_POLICY, { key: 'p1' });
  assert.equal((await act({ key: 'p2', policyVersion: 2 })).status, 'sent');
  await refusedWith(ERR.ACTION_NOT_ALLOWED, { key: 'p3', policyVersion: 2, name: 'Train', fields: { unit: 1, n: 1 } });
  await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId, params: { mode: 'manual' } }));
  await refusedWith(ERR.AGENT_STOPPED, { key: 'p4', policyVersion: 2 });
  assert.equal(r.gateway.view(agentId).modeEpoch, 2);
  // Credentials: the wrong agent id, a request without any credential.
  await assert.rejects(r.gateway.submit(actionRequest('nope'), { capability }), e => e.code === ERR.UNKNOWN_AGENT);
  await assert.rejects(r.gateway.submit(actionRequest(agentId), {}), e => e.code === ERR.BAD_CAPABILITY);
  await assert.rejects(r.gateway.submit({ agentId }, { capability }), e => e.code === ERR.BAD_REQUEST);
  sound(r);
});
