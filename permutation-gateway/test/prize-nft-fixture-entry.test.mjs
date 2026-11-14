// ⑰ (2026-11-15): the TEST ONLY NFT Entry fixture tool (scripts/prize-nft-fixture-entry.mjs). Pure: literal
// addresses, a mocked fetch standing for a loopback frontier-localnet (no network, no chain, no key). The pool and
// Entry addresses are public PDAs (a hash; no key).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { decodeEntryResident, ENTRY_RESIDENT_SIZE, POOL_SIZE, poolAddress } from '../client/src/frontier/prize.mjs';
import { pubkeyBytes } from '../client/src/solana-tx.mjs';
import { fixtureEntryBytes, isLoopbackRpc, main, sameAccount } from '../scripts/prize-nft-fixture-entry.mjs';

const k = n => b58(new Uint8Array(32).fill(n));
const PRIZE = k(0x50), GAME = k(0x60), ASSET = k(0x5a), A = k(0xa1), SEASON_ID = 7n;
const POOL = poolAddress(PRIZE, GAME, SEASON_ID);
const RUN = 'ab12cd34ef56ab12cd34ef56ab12cd34';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Pool bytes as decodePool reads them: magic, state, season id, game program. */
function poolBytes({ state = 0, game = GAME, seasonId = SEASON_ID } = {}) {
  const d = new Uint8Array(POOL_SIZE);
  d.set(new TextEncoder().encode('WYPRPOOL'), 0);
  d[10] = state;
  new DataView(d.buffer).setBigUint64(16, seasonId, true);
  d.set(pubkeyBytes(game), 24);
  return d;
}
const acct = (owner, data) => ({ owner, lamports: 1, executable: false, data: [Buffer.from(data).toString('base64'), 'base64'] });

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

const base = ['--rpc', 'http://127.0.0.1:42110', '--expect-run-id', RUN, '--prize', PRIZE, '--game', GAME, '--season-id', String(SEASON_ID),
  '--pool', POOL, '--asset', ASSET, '--paid-by', A, '--amount', '25000000'];
const run = (extra = []) => main(['--tamper-fixture-test-only', ...base, ...extra]);

test('it refuses before any request without the TEST ONLY flag, with a non-loopback RPC, or a missing argument', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no request expected'); };
  await assert.rejects(main(base), /--tamper-fixture-test-only is required/);
  await assert.rejects(main(['--tamper-fixture-test-only', ...base.map(a => a === 'http://127.0.0.1:42110' ? 'https://api.devnet.solana.com' : a)]), /not a loopback RPC/);
  for (const drop of ['--amount', '--expect-run-id', '--game', '--season-id']) {
    const i = base.indexOf(drop);
    await assert.rejects(main(['--tamper-fixture-test-only', ...base.slice(0, i), ...base.slice(i + 2)]), new RegExp(`${drop} is required`));
  }
  assert.equal(calls, 0);
});

/**
 * A mocked loopback localnet. `mutate(params)` may alter what frontier_setAccount stores (to stand for a chain that
 * does not keep what was sent). Every request must ask fetch not to follow redirects.
 */
function localnet(accounts, { runId = RUN, mutate = null } = {}) {
  const set = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:42110');
    assert.equal(init.redirect, 'error', 'redirects are never followed');
    const { method, params } = JSON.parse(init.body);
    const ok = result => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    if (method === 'frontier_status') return ok({ runId, slot: 1 });
    if (method === 'getAccountInfo') return ok({ value: accounts.get(params[0]) ?? null });
    if (method === 'getMinimumBalanceForRentExemption') return ok(2_227_200);
    if (method === 'frontier_setAccount') { set.push(params); accounts.set(params[0], mutate ? mutate(structuredClone(params[1])) : params[1]); return ok(true); }
    throw new Error(`unexpected ${method}`);
  };
  return set;
}
const world = (pool = poolBytes()) => new Map([[POOL, acct(PRIZE, pool)], [ASSET, acct(k(0x44), new Uint8Array(1))]]);

test('it refuses another world (runId), a pool off its address or of another game/season, a closed pool, an absent asset, an existing Entry', async () => {
  localnet(world(), { runId: 'ffff' });
  await assert.rejects(run(), /runId ffff is not --expect-run-id/);
  localnet(world());
  await assert.rejects(main(['--tamper-fixture-test-only', ...base.map(a => a === POOL ? k(0x71) : a)]), /is not poolAddress/);
  localnet(new Map());
  await assert.rejects(run(), /pool .* absent, not owned/);
  localnet(new Map([[POOL, acct(k(0x99), poolBytes())]]));
  await assert.rejects(run(), /pool .* absent, not owned/);
  localnet(world(new Uint8Array(POOL_SIZE)));
  await assert.rejects(run(), /not a pool/);
  localnet(world(poolBytes({ game: k(0x61) })));
  await assert.rejects(run(), /names game .* season/);
  localnet(world(poolBytes({ seasonId: 8n })));
  await assert.rejects(run(), /names game .* season 8/);
  localnet(world(poolBytes({ state: 1 })));
  await assert.rejects(run(), /no longer Open/);
  localnet(new Map([[POOL, acct(PRIZE, poolBytes())]]));
  await assert.rejects(run(), /asset .* does not exist/);
  const accounts = world();
  const set = localnet(accounts);
  await run();
  await assert.rejects(run(), /already exists/);
  assert.equal(set.length, 1, 'only the first run wrote');
});

test('it writes only the Entry, owned by the prize program, rent-exempt, and says it is not a deposit', async () => {
  const set = localnet(world());
  const out = await run(['--pay-generation', '2']);
  assert.equal(set.length, 1, 'one account written');
  const [entry, a] = set[0];
  assert.equal(entry, out.entry);
  assert.notEqual(entry, POOL); assert.notEqual(entry, ASSET);
  assert.deepEqual([a.owner, a.executable, a.lamports], [PRIZE, false, 2_227_200]);
  const e = decodeEntryResident(Buffer.from(a.data[0], 'base64'));
  assert.deepEqual([e.asset, e.pool, e.paidBy, e.payGeneration, e.amount, e.claimed], [ASSET, POOL, A, 2, 25_000_000n, false]);
  assert.match(out.testOnly, /NOT a deposit/);
  assert.equal(out.feeInPool, false, 'the fee is not added to the pool or the vault');
  assert.equal(out.runId, RUN);
});

test('a read-back that differs from what was written in ANY byte, the owner, the lamports or the executable flag is refused', async () => {
  const flip = (offset, value) => a => { const d = Buffer.from(a.data[0], 'base64'); d[offset] = value; a.data[0] = d.toString('base64'); return a; };
  const mutations = {
    'amount (byte 80)': flip(80, 0x99),
    'pay_generation (byte 12)': flip(12, 0x07),
    'paid_by (byte 104)': flip(104, 0x00),
    'claimed (byte 9)': flip(9, 1),
    'a reserved byte (191)': flip(191, 1),
    'the magic (byte 0)': flip(0, 0x58),
    'a truncated account': a => { a.data[0] = Buffer.from(a.data[0], 'base64').subarray(0, 191).toString('base64'); return a; },
    'the owner': a => ({ ...a, owner: k(0x99) }),
    'the lamports': a => ({ ...a, lamports: a.lamports - 1 }),
    'executable': a => ({ ...a, executable: true }),
    'the encoding': a => ({ ...a, data: [a.data[0], 'base58'] }),
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    localnet(world(), { mutate });
    await assert.rejects(run(), /not exactly what was written/, what);
  }
  // sameAccount itself: identical passes; one byte off fails.
  const data = fixtureEntryBytes({ bump: 1, pool: POOL, asset: ASSET, amount: 1n, paidBy: A });
  const good = { owner: PRIZE, lamports: 5, executable: false, data: [Buffer.from(data).toString('base64'), 'base64'] };
  assert.equal(sameAccount(good, { data, owner: PRIZE, lamports: 5 }), true);
  const bad = Buffer.from(data); bad[100] ^= 1;
  assert.equal(sameAccount({ ...good, data: [bad.toString('base64'), 'base64'] }, { data, owner: PRIZE, lamports: 5 }), false);
});
