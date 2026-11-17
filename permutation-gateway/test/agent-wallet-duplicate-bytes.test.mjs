// Two different requests for the same action, built concurrently (one shared blockhash read) with the same randomly
// drawn fee payer, are byte-identical transactions: the relay's replay guard refused the second as Duplicate although
// it was a request of its own (about 1 in 150 such pairs). The gateway now builds it again with another fee payer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { DUPLICATE_REBUILDS } from '../src/frontier/agent/gateway.mjs';
import { actionRequest, call, createAgent, delegate, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

async function ready() {
  const r = relay();
  // One blockhash for every read, as the relay's book hands out within its cache window (1 s in production).
  const one = Keypair.generate().publicKey.toBase58();
  r.chain.getLatestBlockhash = async () => ({ blockhash: one, lastValidBlockHeight: 150 });
  const owner = Keypair.generate();
  const { agentId, agentKey, capability } = await createAgent(r, owner, { policy: policy(['economy']) });
  await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'mode', { agentId, params: { mode: 'auto' } }), ip: '127.0.0.1' });
  delegate(r, owner.publicKey.toBase58(), agentKey);
  return { r, agentId, capability, act: key => r.gateway.submit(actionRequest(agentId, { key, modeEpoch: 1 }), { capability }) };
}

test('two requests whose first builds collide byte for byte are both sent, each with its own fee payer', async () => {
  const { r, act } = await ready();
  const draws = [0, 0, 1, 2]; // the first two builds draw the same payer
  r.pool.randomIndex = () => draws.shift() ?? 3;
  const [a, b] = await Promise.all([act('dup-a-000001'), act('dup-b-000001')]);
  assert.deepEqual([a.status, b.status], ['sent', 'sent'], JSON.stringify([a.error, b.error]));
  assert.notEqual(a.signature, b.signature);
  const payers = r.chain.sent.map(tx => String(tx.signers[0]));
  assert.equal(new Set(payers).size, 2);
  sound(r);
});

test('a collision that persists after the rebuilds is still refused as Duplicate, nothing sent twice, nothing charged', async () => {
  const { r, agentId, act } = await ready();
  r.pool.randomIndex = () => 0; // every draw the same payer: no rebuild can differ
  const [a, b] = await Promise.all([act('dup-a-000002'), act('dup-b-000002')]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['refused', 'sent']);
  const refused = [a, b].find(x => x.status === 'refused');
  assert.equal(refused.error.code, 'Duplicate');
  assert.deepEqual(refused.charges, []);
  assert.equal(r.chain.sent.length, 1);
  assert.ok(DUPLICATE_REBUILDS >= 1);
  assert.equal(r.gateway.view(agentId).balance.reserved, '0');
  sound(r);
});

test('the same request asked twice is still one send (idempotency, not a rebuild)', async () => {
  const { r, act } = await ready();
  r.pool.randomIndex = () => 0;
  const [a, b] = await Promise.all([act('dup-same-0001'), act('dup-same-0001')]);
  assert.equal(a.signature, b.signature);
  assert.equal([a, b].filter(x => x.replayed).length, 1);
  assert.equal(r.chain.sent.length, 1);
  sound(r);
});
