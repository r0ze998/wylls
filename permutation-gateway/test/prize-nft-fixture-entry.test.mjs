// ⑰ (2026-11-15): the TEST ONLY NFT Entry fixture tool (scripts/prize-nft-fixture-entry.mjs). Pure: literal
// addresses, a mocked fetch standing for a loopback frontier-localnet (no network, no chain, no key). The success
// path derives the Entry's public PDA (a hash; no key).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { decodeEntryResident, ENTRY_RESIDENT_SIZE } from '../client/src/frontier/prize.mjs';
import { fixtureEntryBytes, isLoopbackRpc, main } from '../scripts/prize-nft-fixture-entry.mjs';

const k = n => b58(new Uint8Array(32).fill(n));
const PRIZE = k(0x50), POOL = k(0x70), ASSET = k(0x5a), A = k(0xa1);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('the Entry bytes decode to what was asked: unclaimed, no nation, the pool, asset, payer, generation and amount', () => {
  const d = fixtureEntryBytes({ bump: 254, pool: POOL, asset: ASSET, amount: 25_000_000n, paidBy: A, payGeneration: 3 });
  assert.equal(d.length, ENTRY_RESIDENT_SIZE);
  assert.equal(d[8], 254, 'bump');
  const e = decodeEntryResident(d);
  assert.deepEqual([e.claimed, e.nationRecorded, e.nation, e.pool, e.asset, e.paidBy, e.payGeneration, e.amount, e.claimedBy, e.claimGeneration, e.paidSlot, e.claimAmount],
    [false, false, null, POOL, ASSET, A, 3, 25_000_000n, null, null, 0n, 0n]);
  assert.ok(d.slice(172).every(b => b === 0), 'reserved bytes are zero');
  assert.throws(() => fixtureEntryBytes({ bump: 256, pool: POOL, asset: ASSET, amount: 1n, paidBy: A }), /bump/);
  assert.throws(() => fixtureEntryBytes({ bump: 1, pool: POOL, asset: ASSET, amount: -1n, paidBy: A }), /amount/);
  assert.throws(() => fixtureEntryBytes({ bump: 1, pool: POOL, asset: ASSET, amount: 1n, paidBy: A, payGeneration: -1 }), /payGeneration/);
});

test('only a loopback RPC is accepted', () => {
  for (const u of ['http://127.0.0.1:42110', 'http://127.4.5.6:1', 'http://localhost:8899', 'http://[::1]:8899']) assert.equal(isLoopbackRpc(u), true, u);
  for (const u of ['https://api.devnet.solana.com', 'http://192.168.1.2:8899', 'http://127.0.0.1.example.com', 'file:///x', 'not a url', 'http://0.0.0.0:8899'])
    assert.equal(isLoopbackRpc(u), false, u);
});

const base = ['--rpc', 'http://127.0.0.1:42110', '--prize', PRIZE, '--pool', POOL, '--asset', ASSET, '--paid-by', A, '--amount', '25000000'];

test('it refuses before any request without the TEST ONLY flag or with a non-loopback RPC', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no request expected'); };
  await assert.rejects(main(base), /--tamper-fixture-test-only is required/);
  await assert.rejects(main(['--tamper-fixture-test-only', ...base.map(a => a === 'http://127.0.0.1:42110' ? 'https://api.devnet.solana.com' : a)]), /not a loopback RPC/);
  await assert.rejects(main(['--tamper-fixture-test-only', ...base.slice(0, -2)]), /--amount is required/);
  assert.equal(calls, 0);
});

/** A mocked loopback localnet: accounts by address; records frontier_setAccount. */
function localnet(accounts) {
  const set = [];
  globalThis.fetch = async (url, { body }) => {
    assert.equal(url, 'http://127.0.0.1:42110');
    const { method, params } = JSON.parse(body);
    const ok = result => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    if (method === 'getAccountInfo') return ok({ value: accounts.get(params[0]) ?? null });
    if (method === 'getMinimumBalanceForRentExemption') return ok(2_227_200);
    if (method === 'frontier_setAccount') { set.push(params); accounts.set(params[0], params[1]); return ok(true); }
    throw new Error(`unexpected ${method}`);
  };
  return set;
}

test('it refuses an absent or foreign pool, an absent asset, and an Entry that already exists', async () => {
  const run = () => main(['--tamper-fixture-test-only', ...base]);
  localnet(new Map());
  await assert.rejects(run(), /pool .* absent or not owned/);
  localnet(new Map([[POOL, { owner: k(0x99), data: ['', 'base64'], lamports: 1 }]]));
  await assert.rejects(run(), /pool .* absent or not owned/);
  localnet(new Map([[POOL, { owner: PRIZE, data: ['', 'base64'], lamports: 1 }]]));
  await assert.rejects(run(), /asset .* does not exist/);
  // An existing Entry: the first run creates it, a second run refuses and writes nothing.
  const accounts = new Map([[POOL, { owner: PRIZE, data: ['', 'base64'], lamports: 1 }], [ASSET, { owner: k(0x44), data: ['', 'base64'], lamports: 1 }]]);
  const set = localnet(accounts);
  await run();
  await assert.rejects(run(), /already exists/);
  assert.equal(set.length, 1, 'only the first run wrote');
});

test('it writes only the Entry, owned by the prize program, rent-exempt, and says it is not a deposit', async () => {
  const accounts = new Map([[POOL, { owner: PRIZE, data: ['', 'base64'], lamports: 1 }], [ASSET, { owner: k(0x44), data: ['', 'base64'], lamports: 1 }]]);
  const set = localnet(accounts);
  const out = await main(['--tamper-fixture-test-only', ...base, '--pay-generation', '2']);
  assert.equal(set.length, 1, 'one account written');
  const [entry, acct] = set[0];
  assert.equal(entry, out.entry);
  assert.notEqual(entry, POOL); assert.notEqual(entry, ASSET);
  assert.deepEqual([acct.owner, acct.executable, acct.lamports], [PRIZE, false, 2_227_200]);
  const e = decodeEntryResident(Buffer.from(acct.data[0], 'base64'));
  assert.deepEqual([e.asset, e.pool, e.paidBy, e.payGeneration, e.amount, e.claimed], [ASSET, POOL, A, 2, 25_000_000n, false]);
  assert.match(out.testOnly, /NOT a deposit/);
  assert.equal(out.feeInPool, false, 'the fee is not added to the pool or the vault');
});
