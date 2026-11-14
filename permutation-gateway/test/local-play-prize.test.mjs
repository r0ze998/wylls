// ⑰ (2026-11-15): the TEST ONLY local-play prize relay module (src/frontier/local-play-prize.mjs). Pure: literal keys,
// a mocked loopback RPC (no network, no chain, no key). Public PDAs are derived (hashes). A successful submit needs a
// real wallet signature and is NOT exercised here (the no-keys guard); every refusal around it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { pubkeyBytes } from '../client/src/solana-tx.mjs';
import { POOL_SIZE, entryResidentAddress, poolAddress } from '../client/src/frontier/prize.mjs';
import { policyAddress } from '../client/src/frontier/resident.mjs';
import { LOCAL_LANE_PROGRAMS } from '../src/frontier/local-lane-versions.mjs';
import { createLocalPlayPrize, localPrizeConfigProblems, OPEN_TTL_MS, PREPARE_SCHEMA, SUBMIT_SCHEMA } from '../src/frontier/local-play-prize.mjs';
import { fixtureEntryBytes } from '../scripts/prize-nft-fixture-entry.mjs';

const k = n => b58(new Uint8Array(32).fill(n));
const PROGRAM = LOCAL_LANE_PROGRAMS.conquestNftCandidate, PRIZE = k(0x50), WALLET = k(0xa1), OTHER = k(0xb2), ASSET = k(0x5a), RES = k(0x33);
const SEASON_ID = 11;
const POOL = poolAddress(PRIZE, PROGRAM, SEASON_ID);
const RUN = '0123456789abcdef0123456789abcdef';
const cfg = { testOnly: true, rpc: 'http://127.0.0.1:41101', programId: PROGRAM, seasonId: SEASON_ID, prizeProgram: PRIZE, wallet: WALLET, runId: RUN };

function poolBytes({ state = 2, mode = 1, game = PROGRAM, seasonId = SEASON_ID } = {}) {
  const d = new Uint8Array(POOL_SIZE);
  d.set(new TextEncoder().encode('WYPRPOOL'), 0);
  d[10] = state; d[11] = 6; d[13] = mode; d[14] = 1; d[12] = 2; // winners mask: nation 1
  new DataView(d.buffer).setBigUint64(16, BigInt(seasonId), true);
  d.set(pubkeyBytes(game), 24); d.set(pubkeyBytes(k(0x72)), 120); d.set(pubkeyBytes(k(0x71)), 152);
  return d;
}
function policyBytes() {
  const d = new Uint8Array(136);
  d.set(new TextEncoder().encode('PSFNP002'), 0);
  d.set(pubkeyBytes(k(0x44)), 8); d.set(pubkeyBytes(RES), 40); d.set(pubkeyBytes(k(0x55)), 72); d.set(pubkeyBytes(k(0x66)), 104);
  return d;
}
const entryBytes = (extra = {}) => {
  const d = fixtureEntryBytes({ bump: 255, pool: POOL, asset: ASSET, amount: 25_000_000n, paidBy: WALLET });
  if (extra.claimedBy) { d[9] = 1; d.set(pubkeyBytes(extra.claimedBy), 136); new DataView(d.buffer).setUint32(168, extra.claimGeneration ?? 0, true); }
  return d;
};
const ENTRY = entryResidentAddress(PRIZE, POOL, ASSET);
const ledger = { testOnly: true, shares: { mode: 'shares', members: [{ wallet: `pass:${ASSET}`, asset: ASSET, nation: 1, points: 10, proof: ['00'.repeat(32)] }] } };

/** A mocked loopback RPC over `accounts` (address → {owner, data}). */
function chain(accounts) {
  const sent = [];
  // fetchRpc's contract: { result } | { error }.
  const rpc = async (method, params) => {
    if (method === 'getAccountInfo') { const a = accounts.get(params[0]); return { result: { value: a ? { owner: a.owner, data: [Buffer.from(a.data).toString('base64'), 'base64'] } : null } }; }
    if (method === 'getLatestBlockhash') return { result: { value: { blockhash: k(0x09), lastValidBlockHeight: 100 } } };
    if (method === 'frontier_status') return { result: { runId: RUN } };
    if (method === 'sendTransaction') { sent.push(params); return { result: 'x' }; }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, sent };
}
const world = (pool = poolBytes(), entry = entryBytes()) => new Map([[POOL, { owner: PRIZE, data: pool }], [ENTRY, { owner: PRIZE, data: entry }], [policyAddress(PROGRAM), { owner: PROGRAM, data: policyBytes() }]]);
const make = (accounts, extra = {}) => { const c = chain(accounts); return { ...c, prize: createLocalPlayPrize({ cfg, rpc: c.rpc, readLedger: async () => ledger, ...extra }) }; };

test('it exists only TEST ONLY, on loopback, for the candidate program', () => {
  assert.deepEqual(localPrizeConfigProblems(cfg), []);
  assert.match(localPrizeConfigProblems({ ...cfg, testOnly: false }).join(), /testOnly/);
  assert.match(localPrizeConfigProblems({ ...cfg, rpc: 'https://api.devnet.solana.com' }).join(), /loopback/);
  assert.match(localPrizeConfigProblems({ ...cfg, programId: b58(new Uint8Array(32).fill(0x45)) }).join(), /candidate program/);
  assert.throws(() => createLocalPlayPrize({ cfg: { ...cfg, testOnly: undefined }, rpc: async () => null }), /testOnly/);
});

test('the view serves the pool as GET /f/prize does, and the pass with ?asset=; another world\'s pool is not served', async () => {
  const { prize } = make(world());
  const v = await prize.view({ asset: ASSET });
  assert.equal(v.testOnly, true);
  assert.equal(v.pool.state, 'shares');
  assert.equal(v.pool.pool, POOL);
  assert.equal(v.pool.pass.asset, ASSET);
  assert.deepEqual([v.pool.pass.entry.claimed, v.pool.pass.entry.paidBy, v.pool.pass.entry.claimedBy, v.pool.pass.entry.claimGeneration], [false, WALLET, null, null]);
  await assert.rejects(make(world(poolBytes({ game: k(0x61) }))).prize.view(), e => e.code === 'LocalPrizeNoPool');
  await assert.rejects(make(world(poolBytes({ seasonId: 12 }))).prize.view(), e => e.code === 'LocalPrizeNoPool');
  await assert.rejects(make(new Map()).prize.view(), e => e.code === 'LocalPrizeNoPool');
  await assert.rejects(make(world()).prize.view({ asset: 'not-a-key' }), e => e.code === 'BadAsset');
});

const req = (asset = ASSET, generation = 0) => ({ schema: PREPARE_SCHEMA, asset, generation });

test('prepare refuses before shares, in refund mode (undecided), without an Entry or a share, and a malformed request', async () => {
  await assert.rejects(make(world(poolBytes({ state: 1 }))).prize.prepare(req()), e => e.code === 'SharesNotPosted');
  await assert.rejects(make(world(poolBytes({ mode: 2 }))).prize.prepare(req()), e => e.code === 'ResidentRefundUndecided');
  const noEntry = world(); noEntry.delete(ENTRY);
  await assert.rejects(make(noEntry).prize.prepare(req()), e => e.code === 'ResidentNoEntry');
  await assert.rejects(make(world(), { readLedger: async () => ({ testOnly: true, shares: { members: [] } }) }).prize.prepare(req()), e => e.code === 'ResidentNoShare');
  await assert.rejects(make(world(), { readLedger: async () => ({ ...ledger, testOnly: false }) }).prize.prepare(req()), e => e.code === 'ResidentNoShare', 'a non-TEST ONLY ledger is not used');
  for (const bad of [{}, { ...req(), extra: 1 }, { ...req(), schema: 'x' }, req('nope'), req(ASSET, -1), req(ASSET, 2 ** 32)]) {
    await assert.rejects(make(world()).prize.prepare(bad), e => e.code === 'BadRequest');
  }
});

test('a claimed Entry is answered by the shared rule: the claimer at its generation "already", anyone else "claimedByOther"; no message', async () => {
  const mine = await make(world(poolBytes(), entryBytes({ claimedBy: WALLET, claimGeneration: 2 }))).prize.prepare(req(ASSET, 2));
  assert.equal(mine.status, 'already');
  assert.equal(mine.message_b64, undefined);
  const prior = await make(world(poolBytes(), entryBytes({ claimedBy: OTHER, claimGeneration: 1 }))).prize.prepare(req(ASSET, 2));
  assert.deepEqual([prior.status, prior.claimedBy, prior.claimGeneration], ['claimedByOther', OTHER, 1]);
  const sameWalletOldGen = await make(world(poolBytes(), entryBytes({ claimedBy: WALLET, claimGeneration: 0 }))).prize.prepare(req(ASSET, 2));
  assert.equal(sameWalletOldGen.status, 'claimedByOther', 'A → B → A: an earlier generation\'s claim is not this one');
});

test('prepare builds one ClaimResident for the pinned wallet as fee payer; submit refuses anything but that message, signed once by it', async () => {
  let t = 1_000;
  const { prize, sent } = make(world(), { now: () => t });
  const p = await prize.prepare(req(ASSET, 3));
  assert.equal(p.status, 'prepared');
  assert.equal(p.schema, SUBMIT_SCHEMA);
  const msg = Buffer.from(p.message_b64, 'base64');
  // The message's first account (the fee payer) is the pinned wallet.
  const nKeysAt = 3, firstKey = msg.subarray(nKeysAt + 1, nKeysAt + 33);
  assert.equal(b58(firstKey), WALLET);
  const wire = sig => Buffer.concat([Buffer.from([1]), sig, msg]).toString('base64');
  const sub = (extra = {}) => ({ schema: SUBMIT_SCHEMA, message_digest: p.message_digest, transaction_b64: wire(Buffer.alloc(64, 7)), ...extra });
  await assert.rejects(prize.submit({ ...sub(), message_digest: '00'.repeat(32) }), e => e.code === 'LocalPrizeUnknownMessage');
  const changed = Buffer.from(msg); changed[changed.length - 10] ^= 1; // one byte of the instruction data flipped
  await assert.rejects(prize.submit(sub({ transaction_b64: Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), changed]).toString('base64') })), e => e.code === 'LocalPrizeMessageChanged');
  await assert.rejects(prize.submit(sub({ transaction_b64: Buffer.concat([Buffer.from([2]), Buffer.alloc(128, 7), msg]).toString('base64') })), e => e.code === 'LocalPrizeBadTransaction');
  await assert.rejects(prize.submit(sub()), e => e.code === 'LocalPrizeBadSignature', 'a signature that is not the pinned wallet\'s');
  for (const bad of [{}, { ...sub(), extra: 1 }, { ...sub(), schema: 'x' }]) await assert.rejects(prize.submit(bad), e => e.code === 'BadRequest');
  // Expiry: a prepared claim is submittable for PREPARED_TTL_MS only.
  t += OPEN_TTL_MS + 1;
  await assert.rejects(prize.submit(sub()), e => e.code === 'LocalPrizeMessageExpired');
  assert.equal(sent.length, 0, 'nothing was sent');
});

test('an RPC { error } (or no result) is a refusal, never "nothing there"', async () => {
  for (const answer of [{ error: { code: -32000, message: 'boom' } }, {}, null]) {
    const prize = createLocalPlayPrize({ cfg, rpc: async () => answer, readLedger: async () => ledger });
    await assert.rejects(prize.view(), e => e.code === 'LocalPrizeRpcUnavailable', JSON.stringify(answer));
  }
  const throwing = createLocalPlayPrize({ cfg, rpc: async () => { throw new Error('down'); } });
  await assert.rejects(throwing.view(), e => e.code === 'LocalPrizeRpcUnavailable');
});

test('wired to the real fetchRpc: never follows a redirect, unwraps { result }, and refuses { error }', async () => {
  const real = globalThis.fetch;
  const accounts = world();
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.redirect);
    assert.equal(url, cfg.rpc);
    const { method, params } = JSON.parse(init.body);
    let out;
    if (method === 'getAccountInfo') { const a = accounts.get(params[0]); out = { jsonrpc: '2.0', id: 1, result: { value: a ? { owner: a.owner, data: [Buffer.from(a.data).toString('base64'), 'base64'] } : null } }; }
    else if (method === 'frontier_status') out = { jsonrpc: '2.0', id: 1, result: { runId: RUN } };
    else out = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } };
    const body = Buffer.from(JSON.stringify(out));
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } });
  };
  try {
    const prize = createLocalPlayPrize({ cfg, readLedger: async () => ledger }); // default rpc = fetchRpc(cfg.rpc, …)
    const v = await prize.view({ asset: ASSET });
    assert.equal(v.pool.pool, POOL);
    assert.ok(seen.length > 0 && seen.every(r => r === 'error'), 'every request asks fetch not to follow redirects');
    await assert.rejects(prize.prepare(req()), e => e.code === 'LocalPrizeRpcUnavailable', 'getLatestBlockhash answered { error }');
  } finally { globalThis.fetch = real; }
});

test('the configuration is a snapshot: changing the caller\'s object afterwards redirects nothing', async () => {
  const real = globalThis.fetch;
  const urls = [];
  const accounts = world();
  globalThis.fetch = async (url, init) => {
    urls.push(url);
    const { method, params } = JSON.parse(init.body);
    const out = method === 'getAccountInfo'
      ? { result: { value: accounts.get(params[0]) ? { owner: accounts.get(params[0]).owner, data: [Buffer.from(accounts.get(params[0]).data).toString('base64'), 'base64'] } : null } }
      : { result: { runId: RUN } };
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, ...out }));
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  try {
    const mine = { ...cfg };
    const prize = createLocalPlayPrize({ cfg: mine, readLedger: async () => ledger });
    // After creation: point the caller's object at a public host, another wallet, another program and world.
    Object.assign(mine, { rpc: 'https://api.mainnet-beta.solana.com', wallet: OTHER, programId: k(0x45), seasonId: 99, prizeProgram: k(0x99), runId: 'f'.repeat(32), testOnly: false });
    const v = await prize.view({ asset: ASSET });
    assert.equal(v.pool.pool, POOL, 'the same pool (program, world)');
    assert.ok(urls.length > 0 && urls.every(u => u === cfg.rpc), 'every request still goes to the original loopback URL');
  } finally { globalThis.fetch = real; }
});

test('another runner on the same port (another run id): nothing is prepared', async () => {
  const c = chain(world());
  const rpc = async (m, p) => (m === 'frontier_status' ? { result: { runId: 'fedcba9876543210fedcba9876543210' } } : c.rpc(m, p));
  await assert.rejects(createLocalPlayPrize({ cfg, rpc, readLedger: async () => ledger }).prepare(req()), e => e.code === 'LocalPrizeRunnerChanged');
  const silent = async (m, p) => (m === 'frontier_status' ? { error: { message: 'no' } } : c.rpc(m, p));
  await assert.rejects(createLocalPlayPrize({ cfg, rpc: silent, readLedger: async () => ledger }).prepare(req()), e => e.code === 'LocalPrizeRunnerChanged', 'a runner that does not say who it is is not the pinned one');
  assert.match(localPrizeConfigProblems({ ...cfg, runId: undefined }).join(), /runId/);
  assert.match(localPrizeConfigProblems({ ...cfg, runId: '0'.repeat(32) }).join(), /runId/);
});
