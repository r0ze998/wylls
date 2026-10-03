// PT-B: the playtest's relay parts. Catch-up on a NotResident refusal (the 2026-10-01 Depart 409),
// the invite check and the player cap, errors that carry nothing internal on the public listener, the
// operator surface unreachable through the public listener, and one origin hammering the public routes.
// No network except 127.0.0.1:0 fixtures (none here: the chain and the keeper are scripted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { toBase64 } from '../client/src/bytes.mjs';
import { encode as base58 } from '../client/src/base58.mjs';
import { CLOCK_SYSVAR, FrontierAddresses, hostId } from '../client/src/frontier/addresses.mjs';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import { minTipLamports } from '../client/src/frontier/fees.mjs';
import { commit, encodePath, pack, saltOf } from '../client/src/frontier/seal.mjs';
import { shapeMessage } from '../client/src/frontier/shapes.mjs';
import { parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk, verifyTalk } from '../client/src/talk-node.mjs';
import { createFrontierApps } from '../src/frontier/app.mjs';
import { catchUpProvince } from '../src/frontier/catchup.mjs';
import { InviteBook } from '../src/frontier/invites.mjs';
import { PayerPool } from '../src/frontier/payers.mjs';
import { seasonPhase } from '../src/frontier/routes/playtest.mjs';
import { call } from './gateway-fixtures.mjs';

const PROGRAM = Keypair.generate().publicKey.toBase58();
const SEASON_ID = 5n;
const A = new FrontierAddresses({ programId: PROGRAM, seasonId: SEASON_ID });
const GENESIS = 1_800_000_000;
const BELL = 600;
const MARCH_FEE = 10_000n;
const SEAL_BOND = 20_000n;
const TIP_MIN = minTipLamports(433, 26_000, 1_048_576);
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const HOLD = [-3, 7, 11];
const wallet = Keypair.generate();
const session = Keypair.generate();

const seasonAccount = (over = {}) => encodeAccount('Season', { SEASON_ID, STATUS: 3, GENESIS_TS: BigInt(GENESIS), BELL_SECS: BELL, JOIN_CLOSE_BELL: 756, END_BELL: 1008,
  MARCH_FEE, SEAL_BOND, MIN_REVEAL_PRIORITY_MILLI: 433, REVEAL_CU_LIMIT: 26_000, REVEAL_LOADED_LIMIT: 1_048_576, JOIN_GATE: new Uint8Array(32), ...over });
const provinceAccount = resolvedNext => encodeAccount('Province', { SEASON_ID, P: HOLD[0], Q: HOLD[1], RESOLVED_NEXT: resolvedNext });
const clockAccount = unix => { const b = Buffer.alloc(40); b.writeBigUInt64LE(77n, 0); b.writeBigInt64LE(BigInt(unix), 32); return b; };
const bellClock = bell => GENESIS + bell * BELL + 5;

/** A scripted chain: accounts, a simulation that fails with `fail(tx, n)` (n = simulations so far), a send log. */
function fakeChain({ fail = () => null } = {}) {
  const c = {
    accounts: new Map(), sent: [], simulated: 0, height: 100,
    set(key, v) { c.accounts.set(String(key), { lamports: v.lamports ?? 1_000_000_000, data: Buffer.from(v.data ?? []) }); },
    getAccountInfo: async key => c.accounts.get(new PublicKey(key).toBase58()) ?? null,
    getBalance: async key => c.accounts.get(new PublicKey(key).toBase58())?.lamports ?? 0,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 150 }),
    getBlockHeight: async () => c.height,
    getSlot: async () => 77,
    simulateTransaction: async (vtx, cfg) => {
      c.simulated++;
      const tx = parseTransaction(vtx.serialize());
      for (const [i, s] of tx.signers.entries()) if (!verifyTalk(tx.message, tx.signatures[i], new PublicKey(s).toBytes())) return { value: { err: 'SignatureFailure', logs: [] } };
      const err = fail(tx, c.simulated);
      if (err) return { value: { err, logs: ['Program log: refused'] } };
      const payer = tx.signers[0];
      const pre = BigInt(c.accounts.get(payer)?.lamports ?? 0);
      const moved = tx.instructions[3]?.data?.[0] === 0x50 ? TIP_MIN + MARCH_FEE + SEAL_BOND : 0n;
      return { value: { err: null, logs: [], unitsConsumed: 9_000, accounts: cfg.accounts.addresses.map(a => (a === payer ? { lamports: Number(pre - 5_000n * BigInt(tx.signers.length) - moved), data: ['', 'base64'] } : null)) } };
    },
    sendRawTransaction: async raw => { const tx = parseTransaction(new Uint8Array(raw)); c.sent.push(tx); return base58(tx.signatures[0]); },
    getSignatureStatuses: async sigs => ({ value: sigs.map(() => null) }),
  };
  return c;
}

function relay({ chain = fakeChain(), season = {}, clock = bellClock(10), keeper = null, gateKey = null, maxPlayers = 0, log = () => {} } = {}) {
  const pool = new PayerPool({ masterSeed: Buffer.alloc(32, 7), n: 150 });
  for (const k of pool.publicKeys()) chain.set(k, { lamports: 2_000_000_000 });
  chain.set(A.season, { data: seasonAccount(season) });
  chain.set(CLOCK_SYSVAR, { data: clockAccount(clock) });
  const store = { state: {}, save() {} };
  const cfg = { cluster: 'localnet', programId: PROGRAM, seasonId: String(SEASON_ID), heraldPeer: '127.0.0.1', heraldUrl: 'http://127.0.0.1:41040', minPoolSol: 1, operatorToken: 'op-token', maxPlayers };
  const invites = new InviteBook({ secret: Buffer.alloc(32, 3), seasonId: SEASON_ID, store });
  const apps = createFrontierApps({ cfg, connection: chain, pool, keeper, invites, gateKey, store, log });
  return { ...apps, chain, pool, store, invites };
}

function playerTx({ name, fields = {}, feePayer, signer = session, accounts = {} }) {
  const base = { actor: signer.publicKey.toBase58(), season: A.season, citizen: A.citizen(wallet.publicKey.toBase58()), holding: A.holding(...HOLD), province: A.province(HOLD[0], HOLD[1]), frontier: A.frontier };
  const message = shapeMessage({ programId: PROGRAM, name, accounts: { ...base, ...accounts }, fields, feePayer, recentBlockhash: BLOCKHASH });
  return toBase64(wireTransaction(message, { [signer.publicKey.toBase58()]: signTalk(message, signer) }));
}
const departFields = tip => {
  const p = encodePath([0, 1]);
  const plain = pack({ hostId: hostId(...HOLD, 0, 1), arriveBell: 147, destP: -2, destQ: 7, destTile: 30, stance: 1, retreatBps: 0, pathLen: p.pathLen, path: p.path });
  return { host_id: hostId(...HOLD, 0, 1), commit: commit(plain, saltOf(new Uint8Array(16).fill(1))), seal: new Uint8Array(165).fill(0xc0), arrive_bell: 147, tip, transit_slot: 1 };
};
const feePayerOf = async r => (await call(r.public, 'GET', '/f/relay', { ip: '203.0.113.9' })).json.feePayer;
const NOT_RESIDENT = { InstructionError: [3, { Custom: 26 }] };

// ------------------------------------------------------------------ catch-up

/** A keeper that resolves the province `after` ms after a nudge (by moving the province account on the chain). */
function keeperThatCatchesUp(chain, { resolveTo, delayMs = 20, status = 200 } = {}) {
  const k = { nudges: [], async nudge(body) {
    k.nudges.push(body);
    if (status < 300) setTimeout(() => chain.set(A.province(...HOLD), { data: provinceAccount(resolveTo) }), delayMs);
    return { status, body: status < 300 ? { queued: true, blocking: [] } : { code: 'Nope' } };
  } };
  return k;
}

test('catch-up: a Depart refused NotResident is retried once after the keeper has been nudged; one send, charged once', async () => {
  // bell 10; the province is resolved only through 5 (resolved_next 5: lag). The first simulation says NotResident.
  const chain = fakeChain({ fail: (tx, n) => (n === 1 ? NOT_RESIDENT : null) });
  const keeper = keeperThatCatchesUp(chain, { resolveTo: 10 });
  const r = relay({ chain, keeper });
  chain.set(A.province(...HOLD), { data: provinceAccount(5) });
  const fp = await feePayerOf(r);
  const res = await call(r.public, 'POST', '/f/relay', { body: { tx: playerTx({ name: 'Depart', feePayer: fp, fields: departFields(TIP_MIN) }) }, ip: '203.0.113.9' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  assert.deepEqual(keeper.nudges, [{ province: [HOLD[0], HOLD[1]], bell: 10 }]);
  assert.equal(chain.simulated, 2, 'simulated twice');
  assert.equal(chain.sent.length, 1);
  const q = r.store.state.quota[`citizen:${A.citizen(wallet.publicKey.toBase58())}`];
  assert.equal(q.left, 39, 'one transaction charged');
});

test('catch-up: without a keeper, with a keeper that refuses, or when the province is not behind, the refusal stands (409 NotResident, nothing charged)', async () => {
  for (const [label, mk] of [
    ['no keeper', () => ({ keeper: null, province: 5 })],
    ['keeper refuses', chain => ({ keeper: keeperThatCatchesUp(chain, { resolveTo: 10, status: 403 }), province: 5 })],
    ['not behind', chain => ({ keeper: keeperThatCatchesUp(chain, { resolveTo: 10 }), province: 9 })],
  ]) {
    const chain = fakeChain({ fail: () => NOT_RESIDENT });
    const o = mk(chain);
    const r = relay({ chain, keeper: o.keeper });
    chain.set(A.province(...HOLD), { data: provinceAccount(o.province) });
    const fp = await feePayerOf(r);
    const res = await call(r.public, 'POST', '/f/relay', { body: { tx: playerTx({ name: 'Depart', feePayer: fp, fields: departFields(TIP_MIN) }) }, ip: '203.0.113.9' });
    assert.equal(res.status, 409, label);
    assert.equal(res.json.code, 'NotResident', label);
    assert.equal(chain.sent.length, 0, label);
    assert.equal(r.store.state.quota?.[`citizen:${A.citizen(wallet.publicKey.toBase58())}`]?.left ?? 40, 40, `${label}: not charged`);
  }
});

test('catch-up: concurrent actions on one province share one nudge, and a scripted loop cannot hammer the keeper', async () => {
  const chain = fakeChain();
  const keeper = keeperThatCatchesUp(chain, { resolveTo: 10, delayMs: 60 });
  const r = relay({ chain, keeper });
  chain.set(A.province(...HOLD), { data: provinceAccount(5) });
  const shape = { name: 'Depart', accounts: { province: A.province(...HOLD) } };
  const ctx = r.ctx;
  const all = await Promise.all([1, 2, 3, 4].map(() => catchUpProvince(ctx, shape, { pollMs: 10 })));
  assert.deepEqual(all, [true, true, true, true]);
  assert.equal(keeper.nudges.length, 1);
  // Right after: the answer of the last catch-up, no new nudge (a province that is not behind is not nudged either).
  assert.equal(await catchUpProvince(ctx, shape, { pollMs: 10 }), true);
  assert.equal(keeper.nudges.length, 1);
  // Only resident shapes with a province are nudged.
  assert.equal(await catchUpProvince(ctx, { name: 'Harvest', accounts: { province: A.province(...HOLD) } }), false);
  assert.equal(await catchUpProvince(ctx, { name: 'Depart', accounts: {} }), false);
});

test('catch-up gives up after waitMs when the keeper does not resolve the province (false, one nudge)', async () => {
  const chain = fakeChain();
  const keeper = { nudges: [], async nudge(b) { keeper.nudges.push(b); return { status: 200, body: { queued: true } }; } };
  const r = relay({ chain, keeper });
  chain.set(A.province(...HOLD), { data: provinceAccount(5) });
  const t0 = Date.now();
  assert.equal(await catchUpProvince(r.ctx, { name: 'Muster', accounts: { province: A.province(...HOLD) } }, { waitMs: 150, pollMs: 20 }), false);
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(keeper.nudges.length, 1);
});

// ------------------------------------------------------------------ invite check, player cap

test('seasonPhase: not started, open, join closed, ended', () => {
  const s = over => ({ STATUS: 3, GENESIS_TS: BigInt(GENESIS), BELL_SECS: BELL, JOIN_CLOSE_BELL: 756, END_BELL: 1008, ...over });
  const at = unixTimestamp => ({ unixTimestamp });
  assert.equal(seasonPhase(s({ STATUS: 1 }), at(GENESIS + 99)), 'notStarted');
  assert.equal(seasonPhase(s(), at(GENESIS - 5)), 'notStarted');
  assert.equal(seasonPhase(s(), at(GENESIS + 5)), 'open');
  assert.equal(seasonPhase(s(), at(GENESIS + 756 * BELL)), 'joinClosed');
  assert.equal(seasonPhase(s(), at(GENESIS + 1008 * BELL)), 'ended');
  assert.equal(seasonPhase(s({ STATUS: 4 }), at(GENESIS + 5)), 'ended');
  assert.equal(seasonPhase(s({ STATUS: 6 }), at(GENESIS + 5)), 'ended');
});

test('POST /f/invite-check: ok / used / invalid / notNeeded, the season phase and the cap; nothing is consumed', async () => {
  const gate = Keypair.generate();
  const r = relay({ gateKey: gate, season: { JOIN_GATE: gate.publicKey.toBytes() }, maxPlayers: 1 });
  const issued = r.invites.issue(2);
  const check = async invite => (await call(r.public, 'POST', '/f/invite-check', { body: { invite }, ip: '203.0.113.9' })).json;
  assert.deepEqual(await check(issued[0]), { ok: true, gated: true, invite: 'ok', season: 'open', full: false });
  assert.equal((await check(issued[0])).invite, 'ok', 'checking does not use it up');
  assert.equal((await check('nonsense')).invite, 'invalid');
  assert.equal((await check(undefined)).invite, 'invalid');
  assert.equal((await check(`${issued[0]}x`)).invite, 'invalid');
  // Used (as a Join would leave it) and the cap of one player.
  r.invites.consume(r.invites.verify(issued[1]));
  assert.equal((await check(issued[1])).invite, 'used');
  assert.equal((await check(issued[0])).full, true);
  // An open (ungated) season needs no invite.
  const open = relay();
  assert.equal((await call(open.public, 'POST', '/f/invite-check', { body: {}, ip: '203.0.113.9' })).json.invite, 'notNeeded');
  // Phases.
  for (const [season, clock, want] of [[{ STATUS: 1 }, bellClock(1), 'notStarted'], [{}, bellClock(800), 'joinClosed'], [{}, bellClock(1100), 'ended']]) {
    const x = relay({ season, clock });
    assert.equal((await call(x.public, 'POST', '/f/invite-check', { body: {}, ip: '203.0.113.9' })).json.season, want);
  }
  // No season account: unavailable, not a crash.
  const none = relay();
  none.chain.accounts.delete(A.season);
  assert.equal((await call(none.public, 'POST', '/f/invite-check', { body: {}, ip: '203.0.113.9' })).json.season, 'unavailable');
});

test('the player cap: a Join past --max-players is 403 SeasonFull before any invite is looked at', async () => {
  const gate = Keypair.generate();
  const r = relay({ gateKey: gate, season: { JOIN_GATE: gate.publicKey.toBytes() }, maxPlayers: 1 });
  const [a] = r.invites.issue(1);
  r.invites.consume(r.invites.verify(r.invites.issue(1)[0]));
  const fp = await feePayerOf(r);
  const tx = playerTx({ name: 'Join', signer: wallet, feePayer: fp,
    accounts: { wallet: wallet.publicKey.toBase58(), citizen: A.citizen(wallet.publicKey.toBase58()), joinshard: A.joinShardFor(2, wallet.publicKey.toBase58()), join_gate: gate.publicKey.toBase58() },
    fields: { faction: 2, session: session.publicKey.toBytes(), session_expiry: BigInt(GENESIS + 86_400) } });
  const res = await call(r.public, 'POST', '/f/join', { body: { tx, invite: a }, ip: '203.0.113.9' });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'SeasonFull');
  assert.equal(r.chain.sent.length, 0);
});

// ------------------------------------------------------------------ nothing internal on the public listener

test('the public listener answers an unexpected failure with a bare "Internal", the operator listener keeps the detail; the log has it', async () => {
  const lines = [];
  const chain = fakeChain();
  chain.getLatestBlockhash = async () => { throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:41112 (/Users/someone/secret/path)'); };
  const r = relay({ chain, log: l => lines.push(l) });
  const pub = await call(r.public, 'GET', '/f/relay', { ip: '203.0.113.9' });
  assert.equal(pub.status, 500);
  assert.deepEqual(pub.json, { error: 'internal error', code: 'Internal' });
  assert.ok(!JSON.stringify(pub.json).includes('127.0.0.1'));
  assert.ok(lines.some(l => l.includes('ECONNREFUSED')), 'the log keeps the cause');
});

test('the operator surface is not reachable through the public listener, however the path is written', async () => {
  const r = relay();
  const auth = { authorization: 'Bearer op-token' };
  for (const path of ['/f/operator/pool', '/f/operator/invites', '/f/operator/pool/', '/f/tx/%2e%2e/operator/pool', '/f/tx/../operator/pool', '//f/operator/pool', '/F/operator/pool', '/f/operator/pool?x=1']) {
    for (const method of ['GET', 'POST']) {
      const res = await call(r.public, method, path, { body: method === 'POST' ? { count: 1 } : undefined, headers: auth, ip: '203.0.113.9' });
      assert.ok([404, 400].includes(res.status), `${method} ${path} -> ${res.status}`);
      assert.ok(!res.json?.invites && !res.json?.payers, `${method} ${path} leaked`);
    }
  }
});

// ------------------------------------------------------------------ one origin hammering the public routes

test('abuse: one address sending joins, relays, nudges and checks is limited per route; another address is unaffected; no pool lamports move', async () => {
  const chain = fakeChain();
  const r = relay({ chain, keeper: { nudge: async () => ({ status: 200, body: { queued: true } }) } });
  const ip = '198.51.100.7';
  const counts = {};
  const bump = (k, status) => { (counts[k] ??= {})[status] = (counts[k][status] ?? 0) + 1; };
  for (let i = 0; i < 80; i++) {
    bump('join', (await call(r.public, 'POST', '/f/join', { body: { tx: 'AAAA' }, ip })).status);
    bump('relay', (await call(r.public, 'POST', '/f/relay', { body: { tx: 'AAAA' }, ip })).status);
    bump('nudge', (await call(r.public, 'POST', '/f/nudge', { body: { province: [0, 0], bell: 1 }, ip })).status);
    bump('check', (await call(r.public, 'POST', '/f/invite-check', { body: { invite: 'x' }, ip })).status);
    bump('quota', (await call(r.public, 'GET', `/f/quota?citizen=${A.citizen(wallet.publicKey.toBase58())}`, { ip })).status);
  }
  assert.ok(counts.join[400] <= 10 && counts.join[429] >= 70, JSON.stringify(counts.join));
  assert.ok(counts.relay[400] <= 40 && counts.relay[429] >= 38, JSON.stringify(counts.relay));
  assert.ok(counts.nudge[200] <= 10 && counts.nudge[429] >= 70, JSON.stringify(counts.nudge));
  assert.ok(counts.check[200] <= 10 && counts.check[429] >= 70, JSON.stringify(counts.check));
  assert.ok(counts.quota[200] <= 20 && counts.quota[429] >= 58, JSON.stringify(counts.quota));
  assert.equal(chain.sent.length, 0);
  assert.equal(chain.simulated, 0);
  // Another address is not throttled by the first one's flood.
  assert.equal((await call(r.public, 'POST', '/f/invite-check', { body: { invite: 'x' }, ip: '198.51.100.8' })).status, 200);
});

// ------------------------------------------------------------------ the per-citizen activity record

test('activity record: a sponsored action writes {citizen, kind, signature}; /f/quota writes "seen" at most once per 5 minutes for an existing Citizen only', async () => {
  const lines = [];
  const events = { write: (event, f) => lines.push({ event, ...f }) };
  let t = 1_000_000;
  const chain = fakeChain();
  const pool = new PayerPool({ masterSeed: Buffer.alloc(32, 7), n: 150 });
  for (const k of pool.publicKeys()) chain.set(k, { lamports: 2_000_000_000 });
  chain.set(A.season, { data: seasonAccount() });
  chain.set(CLOCK_SYSVAR, { data: clockAccount(bellClock(10)) });
  const store = { state: {}, save() {} };
  const apps = createFrontierApps({ cfg: { cluster: 'localnet', programId: PROGRAM, seasonId: String(SEASON_ID), heraldPeer: '127.0.0.1', heraldUrl: 'x', minPoolSol: 1, operatorToken: 'op' },
    connection: chain, pool, store, log: () => {}, events, now: () => t });
  const citizen = A.citizen(wallet.publicKey.toBase58());
  const fp = (await call(apps.public, 'GET', '/f/relay', { ip: '203.0.113.9' })).json.feePayer;
  const res = await call(apps.public, 'POST', '/f/relay', { body: { tx: playerTx({ name: 'Harvest', feePayer: fp }) }, ip: '203.0.113.9' });
  assert.equal(res.json.ok, true);
  const act = lines.filter(l => l.event === 'action');
  assert.equal(act.length, 1);
  assert.deepEqual({ citizen: act[0].citizen, kind: act[0].kind, signature: act[0].signature }, { citizen, kind: 'Harvest', signature: res.json.signature });
  assert.ok(!JSON.stringify(lines).includes('203.0.113.9'), 'no address of the client in the record');
  // seen: unknown Citizen -> nothing; existing -> one line, then none for 5 minutes, then one more.
  const quota = () => call(apps.public, 'GET', `/f/quota?citizen=${citizen}`, { ip: '203.0.113.9' });
  await quota();
  assert.equal(lines.filter(l => l.event === 'seen').length, 0, 'no such Citizen yet');
  chain.set(citizen, { data: encodeAccount('Citizen', { SEASON_ID }) });
  await quota(); await quota(); await quota();
  assert.equal(lines.filter(l => l.event === 'seen').length, 1);
  t += 4 * 60_000; await quota();
  assert.equal(lines.filter(l => l.event === 'seen').length, 1);
  t += 2 * 60_000; await quota();
  assert.deepEqual(lines.filter(l => l.event === 'seen').map(l => l.citizen), [citizen, citizen]);
});

test('scripts/playtest/activity.mjs: returned = a signed action on a later JST day; bots excluded; sessions split by the gap; JST day boundary', async () => {
  const { summarise, jstDay } = await import('../../scripts/playtest/activity.mjs');
  const t = (iso) => Date.parse(iso);
  // 23:50 UTC on the 6th is 08:50 JST on the 7th.
  assert.equal(jstDay(t('2026-10-06T23:50:00Z')), '2026-10-07');
  assert.equal(jstDay(t('2026-10-06T14:59:00Z')), '2026-10-06');
  assert.equal(jstDay(t('2026-10-06T15:00:00Z')), '2026-10-07');
  const L = [
    { t: t('2026-10-06T10:00:00Z'), event: 'invites_issued', label: 'friends', count: 3, nonces: ['n1', 'n2', 'n3'] },
    { t: t('2026-10-06T10:00:00Z'), event: 'invites_issued', label: 'bots', count: 2, nonces: ['b1', 'b2'] },
    { t: t('2026-10-06T11:00:00Z'), event: 'join', invite: 'n1', wallet: 'w1', citizen: 'c1' },
    { t: t('2026-10-06T11:00:00Z'), event: 'join', invite: 'n2', wallet: 'w2', citizen: 'c2' },
    { t: t('2026-10-06T11:00:00Z'), event: 'join', invite: 'b1', wallet: 'wb', citizen: 'cb' },
    { t: t('2026-10-06T11:05:00Z'), event: 'action', citizen: 'c1', kind: 'Build' },
    { t: t('2026-10-06T11:06:00Z'), event: 'action', citizen: 'cb', kind: 'Build' },
    { t: t('2026-10-06T12:00:00Z'), event: 'seen', citizen: 'c1' }, // 55 min after the last line: a new session
    { t: t('2026-10-07T01:00:00Z'), event: 'action', citizen: 'c1', kind: 'Train' }, // 10:00 JST on the 7th: a later day
    { t: t('2026-10-07T02:00:00Z'), event: 'seen', citizen: 'c2' }, // visit only
  ];
  const s = summarise(L, { exclude: new Set(['bots']), gapMs: 30 * 60_000 });
  assert.equal(s.invited, 3);
  assert.equal(s.joined, 2, 'the bot is not a person');
  assert.equal(s.returned, 1, 'c1 acted on a later day; c2 only visited');
  assert.equal(s.returnedVisit, 2);
  assert.equal(s.neverActed, 1);
  const d6 = s.perDay.find(r => r.day === '2026-10-06');
  const d7 = s.perDay.find(r => r.day === '2026-10-07');
  assert.deepEqual([d6.joined, d6.activePersons, d6.actions, d6.sessionStarts], [2, 1, 1, 3], 'c1 two sessions, c2 one');
  assert.deepEqual([d7.activePersons, d7.visitPersons, d7.sessionStarts], [1, 2, 2]);
});
