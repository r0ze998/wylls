// Seat eligibility fix: the REAL chain I/O of the seat finaliser (`makeChainFinaliserIO` in citizens/ab/seat.mjs), end to end against
//  - the REAL Frontier relay (src/frontier, its public listener on 127.0.0.1:0) over a scripted chain (the double of web-frontier-relay.test.mjs:
//    signatures are verified at simulation, the fee payer's post-balance is reported; the chain is NOT the program), and
//  - a herald double on 127.0.0.1:0 that serves the web fixtures (test/fixtures/frontier: a season record, a Province, a Citizen and a Holding in
//    the ABI's byte layout), the Holding made PROVISIONAL (state 1) with a final_ts and a ticket bell.
// It shows what the unit tests with injected I/O cannot: the seat's session key signs a Build of walls that passes the relay's allowlist with the
// accounts the page would recompute (the instruction that runs the program's lazy finality: it names the holding's Province), `readSeat` decodes the
// herald's bytes (state, final_ts, the stone store at chain time, the cohort rule of fland.finalityDue) and `quotaLeft` reads the relay's quota.
// NOT shown: the program's own flip (the Rust program is not run here; `permutation-frontier/src/proc/holding.rs` was read) and a live stack.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { encode as base58 } from '../client/src/base58.mjs';
import { CLOCK_SYSVAR, FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { encodeAccount as encodeClient, decodeIxData } from '../client/src/frontier/codec.mjs';
import { parseTransaction } from '../client/src/solana-tx.mjs';
import { verifyTalk } from '../client/src/talk-node.mjs';
import { createFrontierApps } from '../src/frontier/app.mjs';
import { InviteBook } from '../src/frontier/invites.mjs';
import { PayerPool } from '../src/frontier/payers.mjs';
import { PROGRAM, SEASON_ID, GENESIS_TS, LATEST_UNIX, BELL, encodeAccount, fixtures } from './fixtures/frontier/make-fixtures.mjs';
import * as seat from '../citizens/ab/seat.mjs';

const A = new FrontierAddresses({ programId: PROGRAM, seasonId: BigInt(SEASON_ID) });
const FILES = fixtures();
const SEASON_REC = JSON.parse(FILES.get('season.json').toString());
const PROVINCE_ENV = JSON.parse(FILES.get('province-2,0-40.json').toString());
const HOLD = { p: 2, q: 0, site: 3, gen: 0 };
const u8 = (n, v) => new Uint8Array(n).fill(v);
const wallet = await keyFromSeed(u8(32, 31));
const session = await keyFromSeed(u8(32, 32));
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

// ---- the real relay over a scripted chain
function fakeChain() {
  const c = {
    accounts: new Map(), sent: [], statuses: new Map(), height: 100, landAll: true,
    set(key, v) { c.accounts.set(String(key), { lamports: v.lamports ?? 1_000_000_000, data: Buffer.from(v.data ?? []) }); },
    getAccountInfo: async key => c.accounts.get(new PublicKey(key).toBase58()) ?? null,
    getMultipleAccountsInfo: async keys => keys.map(k => c.accounts.get(new PublicKey(k).toBase58()) ?? null),
    getBalance: async key => c.accounts.get(new PublicKey(key).toBase58())?.lamports ?? 0,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 150 }),
    getBlockHeight: async () => c.height,
    getSlot: async () => 77,
    simulateTransaction: async (vtx, cfg) => {
      const tx = parseTransaction(vtx.serialize());
      for (const [i, s] of tx.signers.entries()) if (!verifyTalk(tx.message, tx.signatures[i], new PublicKey(s).toBytes())) return { value: { err: 'SignatureFailure', logs: [] } };
      const payer = tx.signers[0];
      const post = BigInt(c.accounts.get(payer)?.lamports ?? 0) - 5_000n * BigInt(tx.signers.length);
      return { value: { err: null, logs: [], unitsConsumed: 9_000, accounts: cfg.accounts.addresses.map(a => (a === payer ? { lamports: Number(post), data: ['', 'base64'] } : null)) } };
    },
    sendRawTransaction: async raw => { const tx = parseTransaction(new Uint8Array(raw)); c.sent.push(tx); const sig = base58(tx.signatures[0]); if (c.landAll) c.statuses.set(sig, { slot: 88, confirmationStatus: 'confirmed', err: null }); return sig; },
    getSignatureStatuses: async sigs => ({ value: sigs.map(s => c.statuses.get(s) ?? null) }),
  };
  return c;
}
const clockAccount = unix => { const b = Buffer.alloc(40); b.writeBigUInt64LE(77n, 0); b.writeBigInt64LE(BigInt(unix), 32); return b; };

const chain = fakeChain();
const pool = new PayerPool({ masterSeed: Buffer.alloc(32, 7), n: 150 });
for (const k of pool.publicKeys()) chain.set(k, { lamports: 2_000_000_000 });
chain.set(A.season, { data: Buffer.from(SEASON_REC.bytes_b64, 'base64') });
chain.set(CLOCK_SYSVAR, { data: clockAccount(LATEST_UNIX) });
chain.set(A.citizen(wallet.publicKey), { data: encodeClient('Citizen', { SEASON_ID: BigInt(SEASON_ID), WALLET: wallet.publicKeyBytes, SESSION: session.publicKeyBytes, SESSION_EXPIRY: BigInt(LATEST_UNIX + 86_400), FACTION: 0, TICKET_BELL: 0xffffffff }) });
const store = { state: {}, save() {} };
const cfg = { cluster: 'localnet', programId: PROGRAM, seasonId: String(SEASON_ID), heraldPeer: '127.0.0.1', heraldUrl: 'http://127.0.0.1:41040', minPoolSol: 1, operatorToken: 'op' };
const keeper = { reveal: async () => ({ status: 202, body: { accepted: true } }), nudge: async () => ({ status: 200, body: { queued: true } }) };
const apps = createFrontierApps({ cfg, connection: chain, pool, keeper, invites: new InviteBook({ secret: Buffer.alloc(32, 3), seasonId: BigInt(SEASON_ID), store }), gateKey: null, store, log: () => {} });
const relaySrv = http.createServer(apps.public);
await new Promise(r => relaySrv.listen(0, '127.0.0.1', r));
const RELAY = `http://127.0.0.1:${relaySrv.address().port}`;

// ---- the herald double: the web fixtures, with a provisional holding of the seat
const acc = (units) => ({ value: units * 1000, frac: 0, rate: 20_000, cap: 1_000_000, t0: GENESIS_TS });
const state = { holdingState: 1, finalTs: GENESIS_TS + 600 * 10, now: LATEST_UNIX };
const citizenBytes = () => encodeAccount('Citizen', { wallet: wallet.publicKeyBytes, session: session.publicKeyBytes, sessionExpiry: GENESIS_TS + 30 * 86_400, faction: 0, flags: 1, holdingsN: 1, holding: [HOLD], ticketBell: 0xffffffff, citizenTag: 77n });
const holdingBytes = () => encodeAccount('Holding', { ...HOLD, tile: 14, state: state.holdingState, faction: 0, order: 1, tier: 0, foundedTs: GENESIS_TS + 600 * 5, finalTs: state.finalTs, ticketBell: 6, stores: [acc(300), acc(300), acc(200), acc(100), acc(0), acc(100), acc(0), acc(0)] });
const b64 = b => Buffer.from(b).toString('base64');
const heraldSrv = http.createServer((req, res) => {
  const send = (j) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
  if (req.url === '/h/season') return send({ ...SEASON_REC, latestUnix: state.now });
  if (req.url === `/h/me/${wallet.publicKey}`) return send({ v: 1, wallet: wallet.publicKey, citizen: { address: A.citizen(wallet.publicKey), bytes_b64: b64(citizenBytes()) }, holdings: [{ address: A.holding(HOLD.p, HOLD.q, HOLD.site), bytes_b64: b64(holdingBytes()) }], slots: [], quota: { left: 38 } });
  if (req.url === '/h/province/2,0/latest') return send(PROVINCE_ENV);
  res.statusCode = 404; res.end('{}');
});
await new Promise(r => heraldSrv.listen(0, '127.0.0.1', r));
const HERALD = `http://127.0.0.1:${heraldSrv.address().port}`;
after(() => { relaySrv.close(); heraldSrv.close(); });

const keyFor = () => ({ wallet: wallet.publicKey, sessionB58: session.publicKey });
const makeIo = () => seat.makeChainFinaliserIO({ herald: HERALD, relay: RELAY, key: keyFor(), seed: u8(32, 32), track: { tries: 3, every: 1 } });

test('readSeat: the seat\'s provisional village, from the herald\'s own bytes: state 1, whether the program would take the flip now, the stone it holds at chain time', async () => {
  const io = await makeIo();
  state.holdingState = 1; state.finalTs = GENESIS_TS + 600 * 10; state.now = LATEST_UNIX;
  const r = await io.readSeat();
  assert.equal(r.holding.state, 1);
  assert.deepEqual({ p: r.holding.p, q: r.holding.q, site: r.holding.site }, { p: 2, q: 0, site: 3 });
  assert.equal(r.holding.final_ts, GENESIS_TS + 6000);
  assert.equal(r.due, true, 'final_ts has passed and the fixture Province holds no open ticket cohort');
  // 200 stone at t0 = genesis, +20 an hour: (LATEST_UNIX - GENESIS) / 3600 hours later
  assert.equal(r.stone, Math.floor(200 + (20 * (LATEST_UNIX - GENESIS_TS)) / 3600));
  assert.ok(r.stone >= seat.WALL_STONE_NEEDED);
  // before final_ts: not due
  state.finalTs = LATEST_UNIX + 3_600;
  assert.equal((await io.readSeat()).due, false);
  // final: state 2
  state.holdingState = 2;
  assert.equal((await io.readSeat()).holding.state, 2);
  state.holdingState = 1; state.finalTs = GENESIS_TS + 6000;
});

test('quotaLeft reads the relay\'s per-citizen quota', async () => {
  const io = await makeIo();
  await io.readSeat(); // pins the season
  assert.equal(await io.quotaLeft(), 40, 'a fresh citizen has the early-days allowance');
});

test('sendWalls: the seat\'s session key signs a Build of walls through the real relay; the instruction names the holding AND its Province, and lands', async () => {
  const io = await makeIo();
  await io.readSeat();
  const before = chain.sent.length;
  const r = await io.sendWalls();
  assert.equal(r.ok, true, `${r.code} ${r.error}`);
  assert.equal(r.state, 'landed');
  assert.equal(chain.sent.length, before + 1);
  const tx = chain.sent.at(-1);
  const ix = tx.instructions.at(-1);
  const d = decodeIxData(ix.data);
  assert.equal(d.name, 'Build');
  assert.equal(d.item, 6, 'the walls item');
  const keys = ix.keys.map(k => k.pubkey);
  assert.equal(keys[0], session.publicKey, 'signed by the seat\'s session key');
  assert.deepEqual(tx.signers.slice(1), [session.publicKey], 'nobody else signs but the relay\'s fee payer');
  assert.equal(keys[3], A.citizen(wallet.publicKey));
  assert.equal(keys[4], A.holding(2, 0, 3));
  assert.equal(keys.at(-1), A.province(2, 0), 'the holding\'s own Province is the last account: the program runs finality() there');
  assert.equal(keys.length, 6);
  assert.equal(base58(tx.signatures[0]), r.signature);
});

test('sendWalls says why when the relay refuses (no holding read yet, a lost transaction)', async () => {
  const io = await makeIo();
  assert.equal((await io.sendWalls()).code, 'NoHolding', 'nothing is sent before the seat\'s holding has been read');
  await io.readSeat();
  chain.landAll = false;
  try {
    const r = await io.sendWalls();
    assert.equal(r.ok, false);
    assert.equal(r.state, 'unknown');
    assert.equal(r.code, 'Unconfirmed');
  } finally { chain.landAll = true; }
});

test('the whole finaliser over the real chain I/O: nothing before the flip is due, one Build of walls at the first due bell, then it waits to see the village final', async () => {
  const io = await makeIo();
  const lines = [];
  const f = seat.createSeatFinaliser({ ...io, log: (m) => lines.push(m) });
  state.holdingState = 1; state.finalTs = LATEST_UNIX + 3_600; // not due yet
  const sent0 = chain.sent.length;
  await f.step({ bell: BELL });
  assert.equal(chain.sent.length, sent0, 'not due: nothing sent');
  assert.equal(f.state().status, 'waiting_final_due');
  state.finalTs = GENESIS_TS + 6000; // due now
  await f.step({ bell: BELL + 1 });
  assert.equal(chain.sent.length, sent0 + 1, 'due: one Build of walls');
  assert.equal(f.state().status, 'sent');
  assert.ok(lines.some(l => /^scripted seat: finalising its village/.test(l)));
  state.holdingState = 2; // the program's flip, as the herald would show it
  await f.step({ bell: BELL + 2 });
  assert.equal(f.state().final, true);
  assert.equal(chain.sent.length, sent0 + 1, 'final: nothing more is sent');
});

test('the seat process (node citizens/ab/seat.mjs, the council script) starts the finaliser from its flags, touches its village once through the relay and ends on the stop file', async () => {
  state.holdingState = 1; state.finalTs = GENESIS_TS + 6000; state.now = LATEST_UNIX;
  const dir = mkdtempSync(join(tmpdir(), 'seatfix2-cli-'));
  const keyFile = join(dir, 'seat.txt');
  writeFileSync(keyFile, JSON.stringify({ index: 1012, wallet: wallet.publicKey, wallet_keypair_b58: 'unused', session: session.publicKey, session_keypair_b58: base58(Uint8Array.from([...u8(32, 32), ...session.publicKeyBytes])) }));
  const stopFile = join(dir, 'seat.stop');
  const before = chain.sent.length;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../citizens/ab/seat.mjs', import.meta.url)), '--ai-dir', dir, '--herald', HERALD, '--social', 'http://127.0.0.1:9', '--relay', RELAY, '--key-file', keyFile, '--stop-file', stopFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  try {
    const t0 = Date.now();
    while (chain.sent.length === before && Date.now() - t0 < 20_000) await new Promise(r => setTimeout(r, 100));
    assert.equal(chain.sent.length, before + 1, `the seat process sent one transaction: ${out}`);
    assert.equal(decodeIxData(chain.sent.at(-1).instructions.at(-1).data).name, 'Build');
    state.holdingState = 2; // the herald now shows the village final
    writeFileSync(stopFile, '1');
    assert.equal(await exited, 0, out);
  } finally { child.kill('SIGKILL'); }
  assert.match(out, /scripted seat: finalising its village/);
  assert.equal(chain.sent.length, before + 1, 'one action, no more');
  assert.equal(out.includes('session_keypair'), false, 'the key is never printed');
  assert.ok(existsSync(join(dir, 'seat/seat-script-log.json')));
});
