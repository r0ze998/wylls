// The owner's finer limits for AI staking (workstreams/05-ai-participation, patch 0001): a cap on one hold
// (perCall), caps per spending category apart from the whole (byCategory), an end to the owner's permission
// (expiresAt), and a model call held at its own quote and settled at its measured cost. Each is enforced by
// the gateway and the ledger, where no caller (the runner, an MCP client, a model) can go around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { normalisePolicy } from '../src/frontier/agent/policy.mjs';
import { actionRequest, call, createAgent, delegate, deposit, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: '127.0.0.1' });

async function ready(r, p) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  await deposit(r, o, made.agentId, 1_000_000n);
  delegate(r, o, made.agentKey);
  assert.equal((await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }))).status, 200);
  return { owner, o, ...made, act: (over = {}) => r.gateway.submit(actionRequest(made.agentId, over), { capability: made.capability }) };
}

test('the policy keeps the new limits only when given, and refuses malformed ones', () => {
  assert.deepEqual(normalisePolicy(policy()), { allowed: ['Build', 'Garrison', 'Harvest', 'Muster', 'Train'], budget: { total: '1000000', perDay: '1000000' } }, 'an old policy is unchanged');
  const p = normalisePolicy({ allowed: ['economy'], budget: { total: '9', perDay: '9', perCall: '5', byCategory: { inference: { perDay: '3' }, game: { total: '4' } } }, expiresAt: 1_900_000_000_000 });
  assert.deepEqual(p.budget, { total: '9', perDay: '9', perCall: '5', byCategory: { inference: { perDay: '3' }, game: { total: '4' } } });
  assert.equal(p.expiresAt, 1_900_000_000_000);
  assert.throws(() => normalisePolicy({ allowed: [], budget: { total: '1', perDay: '1', perCall: '-1' } }), /perCall/);
  assert.throws(() => normalisePolicy({ allowed: [], budget: { total: '1', perDay: '1', byCategory: { network: { total: '1' } } } }), /network is not/);
  assert.throws(() => normalisePolicy({ allowed: [], budget: { total: '1', perDay: '1' }, expiresAt: 'soon' }), /expiresAt/);
});

test('perCall: one priced action or one model call above the cap is refused before anything is held or sent', async () => {
  const r = relay({ prices: { inference: '10000', game: { Harvest: '7000', Train: '12000' } } });
  const a = await ready(r, { allowed: ['economy'], budget: { total: '1000000', perDay: '1000000', perCall: '10000' } });
  const big = await a.act({ name: 'Train', fields: { unit: 0, n: 100 }, key: 'pc-train' });
  assert.deepEqual([big.status, big.error.code], ['refused', ERR.PER_CALL_LIMIT]);
  assert.equal(r.chain.sent.length, 0);
  const ok = await a.act({ key: 'pc-harvest' });
  assert.equal(ok.status, 'sent');
  // A model call held at a quote above the cap is never made.
  let ran = false;
  await assert.rejects(r.gateway.meterInference(a.agentId, async () => { ran = true; }, { price: '10001' }), e => e.code === ERR.PER_CALL_LIMIT);
  assert.equal(ran, false);
  sound(r);
});

test('byCategory: model calls and game spending have their own day and total caps, under the whole budget', async () => {
  const r = relay({ prices: { inference: '10000', game: { Harvest: '7000' } } });
  const a = await ready(r, { allowed: ['economy'], budget: { total: '1000000', perDay: '1000000', byCategory: { inference: { perDay: '20000' }, game: { total: '14000' } } } });
  const call1 = await r.gateway.meterInference(a.agentId, async () => 'x');
  const call2 = await r.gateway.meterInference(a.agentId, async () => 'y');
  assert.deepEqual([call1.charged, call2.charged], ['10000', '10000']);
  await assert.rejects(r.gateway.meterInference(a.agentId, async () => 'z'), e => e.code === ERR.CATEGORY_LIMIT && e.extra?.category === 'inference');
  // Game: two harvests of 7,000 fit the game total of 14,000 (reserved counts); the third does not, whatever the model spent.
  assert.equal((await a.act({ key: 'g1' })).status, 'sent');
  assert.equal((await a.act({ key: 'g2' })).status, 'sent');
  const third = await a.act({ key: 'g3' });
  assert.deepEqual([third.status, third.error.code, third.error.category], ['refused', ERR.CATEGORY_LIMIT, 'game']);
  // Settled game spending keeps counting after the chain answers.
  await r.gateway.reconcile();
  assert.equal((await a.act({ key: 'g4' })).error.code, ERR.CATEGORY_LIMIT);
  sound(r);
});

test('expiresAt: past the owner\'s permission no action is sent and no model call is made; the owner can extend it', async () => {
  let now = Date.now();
  const r = relay({ now: () => now });
  const a = await ready(r, { allowed: ['economy'], budget: { total: '1000000', perDay: '1000000' }, expiresAt: now + 60_000 });
  assert.equal((await a.act({ key: 'e1' })).status, 'sent');
  now += 60_000;
  const late = await a.act({ key: 'e2', policyVersion: 1 });
  assert.deepEqual([late.status, late.error.code], ['refused', ERR.POLICY_EXPIRED]);
  let ran = false;
  await assert.rejects(r.gateway.meterInference(a.agentId, async () => { ran = true; }), e => e.code === ERR.POLICY_EXPIRED);
  assert.equal(ran, false);
  assert.equal(r.chain.sent.length, 1);
  const ext = await post(r, '/f/agent/command', ownerCommand(a.owner, 'policy', { agentId: a.agentId, params: { policy: { allowed: ['economy'], budget: { total: '1000000', perDay: '1000000' }, expiresAt: now + 60_000 } }, expiresAt: now + 30_000 }));
  assert.equal(ext.status, 200, JSON.stringify(ext.json));
  assert.equal(ext.json.agent.policy.expiresAt, now + 60_000);
  assert.equal((await a.act({ key: 'e3', policyVersion: 2 })).status, 'sent');
});

test('a metered model call: held at its quote, settled at its measured cost, the rest comes back; the served model is recorded next to the configured one', async () => {
  const r = relay({ prices: { inference: '10000' } });
  const a = await ready(r, policy());
  const m = await r.gateway.meterInference(a.agentId, async () => ({ usage: { cost: 1234 }, servedModel: 'gemma-3-4b-it' }), { key: 'metered', price: '5000', actual: res => res.usage.cost, served: res => res.servedModel, model: 'gemma-4-26b-a4b-it' });
  assert.equal(m.charged, '1234');
  const v = r.gateway.view(a.agentId);
  assert.equal(v.balance.spent.inference, '1234');
  const line = v.history.find(h => h.type === 'spend' && h.key === 'metered');
  assert.deepEqual([line.amount, line.model, line.servedModel, line.metered], ['1234', 'gemma-4-26b-a4b-it', 'gemma-3-4b-it', true]);
  // A measured cost above the hold is cut to the hold; a failing call without a measure is charged its hold.
  const over = await r.gateway.meterInference(a.agentId, async () => ({ c: 99_999 }), { key: 'over', price: '3000', actual: res => res.c });
  assert.equal(over.charged, '3000');
  const failed = await r.gateway.meterInference(a.agentId, async () => { throw new Error('boom'); }, { key: 'fail', price: '2000', actual: (res, err) => (err ? undefined : 0) });
  assert.deepEqual([failed.ok, failed.charged], [false, '2000']);
  sound(r);
});
