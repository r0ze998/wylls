// Workstream 03 patch 0005: SendCaravan as an agent action (the `transport` group). The agent sends a caravan from
// its own village to another of the owner's places through the same gateway checks as every other action; the
// source is always the village, the destination and the path Provinces come in `action.route`, and the session
// rule of the program (a send to another player needs the wallet) still holds on chain. Scripted chain, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { PRESETS as V2 } from '../client/src/frontier/abi-v2-presets.mjs';
import { accountsFor as pageAccountsFor, placeData, cargoBytes } from '../../permutation-server/web/frontier/fplay.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { accountsFor } from '../src/frontier/agent/gateway.mjs';
import { parseActionRequest } from '../src/frontier/agent/contract.mjs';
import { normalisePolicy } from '../src/frontier/agent/policy.mjs';
import { A, PROGRAM, SEASON_ID, VILLAGE, call, createAgent, delegate, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const hexBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const S1 = { RULESET_HASH: hexBytes(V2.ruleset_hash_v3), LAYOUT_VERSION: 2, PROGRAM_VERSION: 4 };
const [P, Q, SITE] = VILLAGE;
const VAULT = { kind: 'vault', p: P, q: Q, tile: 20 };
const route = { dst: VAULT, provinces: [{ p: P, q: Q }] };
const fields = (seq = 0, dst = VAULT) => ({ seq, ...placeData({ ...dst, gen: 1 }), steps: 3, path: Array.from(new Uint8Array(12)), cargo: Array.from(cargoBytes([0, 100, 0, 0, 0, 0, 0, 0])), fee: '50000' });

test('patch 0005: the transport group names SendCaravan; a policy may allow it', () => {
  assert.deepEqual(normalisePolicy(policy(['transport'])).allowed, ['SendCaravan']);
});

test('patch 0005: SendCaravan\'s accounts are the page\'s (fplay.accountsFor), key for key', () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const actor = Keypair.generate().publicKey.toBase58();
  const f = fields(3);
  const mine = accountsFor('SendCaravan', { addresses: A, actor, owner, holding: VILLAGE, fields: f, route, profile: 3 });
  const W = seasonAddresses(PROGRAM, SEASON_ID);
  const page = pageAccountsFor('SendCaravan', { addresses: W, wallet: owner, actor, profile: 3,
    seq: 3, src: { kind: 'holding', p: P, q: Q, site: SITE, gen: 1 }, dst: { ...VAULT, gen: 1 }, provinces: route.provinces });
  for (const k of ['actor', 'season', 'citizen', 'src', 'dst', 'caravan']) assert.equal(mine[k], page[k], k);
  assert.deepEqual([mine.path_province].flat(), [page.path_province].flat());
});

test('patch 0005: the route is checked against the data and the village', () => {
  const ok = { addresses: A, actor: 'x', owner: Keypair.generate().publicKey.toBase58(), holding: VILLAGE, fields: fields(), route, profile: 3 };
  assert.throws(() => accountsFor('SendCaravan', { ...ok, profile: 2 }), /S1 seasons only/);
  assert.throws(() => accountsFor('SendCaravan', { ...ok, route: null }), /needs action.route/);
  assert.throws(() => accountsFor('SendCaravan', { ...ok, fields: { ...fields(), dst_at: 21 } }), /dst_at does not match/);
  assert.throws(() => accountsFor('SendCaravan', { ...ok, route: { ...route, provinces: [{ p: P + 1, q: Q }] } }), /first path Province/);
  // From one of the owner's vaults to the village: the source is the vault's account, its Province first.
  const home = { kind: 'holding', p: P, q: Q, site: SITE };
  const back = accountsFor('SendCaravan', { ...ok, fields: fields(0, home), route: { src: VAULT, dst: home, provinces: [{ p: P, q: Q }] } });
  assert.equal(back.src, accountsFor('SendCaravan', ok).dst, 'the vault');
  assert.equal(back.dst, A.holding(P, Q, SITE));
  const req = a => parseActionRequest({ agentId: 'a', source: 'mcp', idempotencyKey: 'k', policyVersion: 1, action: a });
  assert.throws(() => req({ name: 'SendCaravan', holding: VILLAGE, fields: {} }), /needs action.route/);
  assert.throws(() => req({ name: 'SendCaravan', holding: VILLAGE, fields: {}, route: { dst: VAULT, provinces: [] } }), /1–4/);
  assert.deepEqual(req({ name: 'SendCaravan', holding: VILLAGE, fields: {}, route }).action.route, route);
  assert.throws(() => req({ name: 'SendCaravan', holding: VILLAGE, fields: {}, route: { ...route, src: { kind: 'holding', p: 1, q: 1, site: 1 } } }), /owner's vaults/);
});

async function ready(r, allowed = ['transport']) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: policy(allowed) });
  delegate(r, o, made.agentKey);
  await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }), ip: '127.0.0.1' });
  return { owner, o, ...made };
}

const act = (r, a, { key = Keypair.generate().publicKey.toBase58().slice(0, 20), f = fields(), rt = route } = {}) =>
  call(r.public, 'POST', '/f/agent/action', { body: { capability: a.capability, request: { agentId: a.agentId, source: 'mcp', idempotencyKey: key, policyVersion: 1, action: { name: 'SendCaravan', holding: VILLAGE, fields: f, route: rt } } }, ip: '127.0.0.1' });

test('patch 0005: an allowed agent sends SendCaravan from its village; the relay\'s own shape check passes; a retry sends once', async () => {
  const r = relay({ season: S1 });
  const a = await ready(r);
  const res = await act(r, a, { key: 'caravan-1' });
  assert.equal(res.json.status, 'sent', JSON.stringify(res.json));
  assert.equal(r.chain.sent.length, 1);
  const tx = r.chain.sent[0];
  const ix = tx.instructions.at(-1);
  assert.equal(ix.data[0], 0xb1, 'SendCaravan');
  assert.equal(ix.keys[0].pubkey, a.agentKey, 'the agent\'s key acts');
  assert.equal(ix.keys[4].pubkey, A.holding(P, Q, SITE), 'from the village');
  const again = await act(r, a, { key: 'caravan-1' });
  assert.equal(again.json.replayed, true);
  assert.equal(r.chain.sent.length, 1, 'sent once');
  sound(r);
});

test('patch 0005: without the transport group, SendCaravan is ActionNotAllowed and nothing is sent', async () => {
  const r = relay({ season: S1 });
  const a = await ready(r, ['economy']);
  const res = await act(r, a);
  assert.equal(res.json.status, 'refused');
  assert.equal(res.json.error.code, 'ActionNotAllowed');
  assert.equal(r.chain.sent.length, 0);
});
