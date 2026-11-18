// Probe (workstream 04): what workstream 05's shared patch 0002b ("rebuild an action whose bytes collided with
// another request's") does to two SendCaravan requests of identical content — the same owner, seq, source,
// destination and cargo — built with the same blockhash and the same fee payer. Runs on either tree:
//
//   without 0002b (ws04/integration-20261030): the second request is refused `Duplicate` before anything of it is
//     sent; one transaction reaches the chain.
//   with 0002b and SEQ_ACTIONS (the gateway in this repository since AUTH-ROUTES §4): 0002b rebuilds other actions,
//     but never SendCaravan (it carries the Citizen's seq). The second request goes back `failed` with `sent: null`,
//     code Duplicate and `duplicateOf` = the first request's signature (follow it, do not resend); one transaction
//     reaches the chain.
//   with 0002b WITHOUT SEQ_ACTIONS (an isolated copy, never adopted): the second was built again with another fee
//     payer and sent too: two transactions, two fees, for one seq. (2026-11-18: this probe used to expect that,
//     and failed against the current gateway, which refuses it as described above.)
//
// MOCK: the agent wallet tests' scripted chain (it does not run the program, so it does not refuse the second seq;
// what it shows is how many transactions and signatures leave the relay). No network, keys made in memory.
//
//   node --test workstreams/04-execution/bridge/probe-0002b-sendcaravan.test.mjs   (needs permutation-gateway/node_modules)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as gw from '../../../permutation-gateway/src/frontier/agent/gateway.mjs';
import { PRESETS as V2 } from '../../../permutation-gateway/client/src/frontier/abi-v2-presets.mjs';
import { placeData, cargoBytes } from '../../../permutation-server/web/frontier/fplay.mjs';
import { VILLAGE, call, createAgent, delegate, ownerCommand, policy, relay, sound } from '../../../permutation-gateway/test/agent-wallet-fixtures.mjs';

const require = createRequire(new URL('../../../permutation-gateway/package.json', import.meta.url));
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const hexBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const S1 = { RULESET_HASH: hexBytes(V2.ruleset_hash_v3), LAYOUT_VERSION: 2, PROGRAM_VERSION: 4 };
const [P, Q] = VILLAGE;
const VAULT = { kind: 'vault', p: P, q: Q, tile: 20 };
const route = { dst: VAULT, provinces: [{ p: P, q: Q }] };
const fields = seq => ({ seq, ...placeData({ ...VAULT, gen: 1 }), steps: 3, path: Array.from(new Uint8Array(12)), cargo: Array.from(cargoBytes([0, 100, 0, 0, 0, 0, 0, 0])), fee: '50000' });
const HAS_0002B = 'DUPLICATE_REBUILDS' in gw;
const SEQ_EXEMPT = gw.SEQ_ACTIONS?.has?.('SendCaravan') === true;

async function ready() {
  const r = relay({ season: S1 });
  // One blockhash for every read (the relay's book shares one read between concurrent callers).
  const one = Keypair.generate().publicKey.toBase58();
  r.chain.getLatestBlockhash = async () => ({ blockhash: one, lastValidBlockHeight: 150 });
  const owner = Keypair.generate();
  const made = await createAgent(r, owner, { policy: policy(['transport']) });
  delegate(r, owner.publicKey.toBase58(), made.agentKey);
  await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }), ip: '127.0.0.1' });
  const act = key => call(r.public, 'POST', '/f/agent/action', { body: { capability: made.capability, request: { agentId: made.agentId, source: 'mcp', idempotencyKey: key, policyVersion: 1, action: { name: 'SendCaravan', holding: VILLAGE, fields: fields(4), route } } }, ip: '127.0.0.1' });
  return { r, act };
}

test(`two SendCaravan requests for the same seq, colliding bytes (${HAS_0002B ? (SEQ_EXEMPT ? 'with 0002b, SendCaravan exempt' : 'with 0002b') : 'without 0002b'})`, async () => {
  const { r, act } = await ready();
  const draws = [0, 0, 1, 2]; // both first builds draw the same fee payer: identical bytes
  r.pool.randomIndex = () => draws.shift() ?? 3;
  const [a, b] = (await Promise.all([act('ws04:probe:4:0'), act('ws04:probe:4:1')])).map(x => x.json);
  const sigs = r.chain.sent.map(t => bs58.encode(Buffer.from(t.signatures[0])));
  if (HAS_0002B && SEQ_EXEMPT) {
    const [sent, dup] = a.status === 'sent' ? [a, b] : [b, a];
    assert.deepEqual([sent.status, dup.status], ['sent', 'failed'], JSON.stringify([a.error, b.error]));
    assert.equal(dup.error.code, 'Duplicate');
    assert.equal(dup.sent, null, 'not proof that nothing of it left: the same bytes left in the first request');
    assert.equal(dup.duplicateOf, sent.signature, 'the duplicate names the transaction to follow');
    assert.equal(r.chain.sent.length, 1, 'one transaction for one seq: no rebuild with another fee payer');
    assert.deepEqual(sigs, [sent.signature]);
  } else if (HAS_0002B) {
    assert.deepEqual([a.status, b.status], ['sent', 'sent'], JSON.stringify([a.error, b.error]));
    assert.equal(r.chain.sent.length, 2, 'two transactions for one seq');
    assert.notEqual(a.signature, b.signature);
    assert.deepEqual(new Set(sigs), new Set([a.signature, b.signature]), 'each request knows the signature it sent');
  } else {
    assert.deepEqual([a.status, b.status].sort(), ['refused', 'sent']);
    const refused = [a, b].find(x => x.status === 'refused');
    assert.equal(refused.error.code, 'Duplicate');
    assert.equal(refused.signature, undefined, 'a refusal names no signature');
    assert.equal(r.chain.sent.length, 1, 'one transaction; the refused request sent nothing');
  }
  sound(r);
});
