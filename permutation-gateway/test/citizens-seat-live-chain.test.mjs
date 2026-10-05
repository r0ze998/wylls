// Live seat as a PROCESS (`node citizens/ab/seat.mjs --live 1`), end to end against the REAL Frontier relay over a scripted chain and a herald double
// (the infrastructure of citizens-seatfix2-chain.test.mjs), and a social-service double that RECORDS every request. It shows what the in-process tests
// cannot: from its flags the live seat finalises its village through the real relay (one Build of walls, signed by the seat's session key), writes
// KEYS/presenter-key.json (the page's key form, no wallet secret), prints where the council stands with the run harness's label, writes its log and
// PUB/seat/live.json, posts NOTHING to the social service, and ends on the stop file. NOT shown: the program's own flip (the Rust program is not run
// here), a live stack, a browser.
// NOT shown: the program's own flip (the Rust program is not run here; `permutation-frontier/src/proc/holding.rs` was read) and a live stack.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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


// ---- the social double: the council of nation 0 in period 1, motion window open at the herald's bell; every POST is recorded and refused
const socialRequests = [];
const BELL_NOW = Math.floor((LATEST_UNIX - GENESIS_TS) / 600);
const socialSrv = http.createServer((req, res) => {
  socialRequests.push(`${req.method} ${req.url}`);
  const send = (code, j) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
  if (req.method === 'GET' && req.url.startsWith('/f/ai/council?faction=0')) return send(200, { v: 1, period: 1, faction: 0, c0: BELL_NOW, closes_bell: BELL_NOW + 6, state: 'motions', options: [{ option: 1 }, { option: 2 }], motions: [], ballots_cast: 0, adopted: false, strike_bell: null });
  send(req.method === 'POST' ? 500 : 404, {});
});
await new Promise(r => socialSrv.listen(0, '127.0.0.1', r));
const SOCIAL = `http://127.0.0.1:${socialSrv.address().port}`;
after(() => socialSrv.close());

test('the live seat process: finalises its village through the real relay, writes the presenter key, prints the council and the harness label, writes its log, posts nothing, ends on the stop file', async () => {
  state.holdingState = 1; state.finalTs = GENESIS_TS + 6000; state.now = LATEST_UNIX;
  const dir = mkdtempSync(join(tmpdir(), 'seatlive-cli-'));
  const keyFile = join(dir, 'seat.txt');
  writeFileSync(keyFile, JSON.stringify({ index: 1012, wallet: wallet.publicKey, wallet_keypair_b58: 'WALLET-SECRET-NOT-FOR-THE-PAGE', session: session.publicKey, session_keypair_b58: base58(Uint8Array.from([...u8(32, 32), ...session.publicKeyBytes])) }));
  const stopFile = join(dir, 'seat.stop');
  const before = chain.sent.length;
  const reqBefore = socialRequests.length;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../citizens/ab/seat.mjs', import.meta.url)), '--live', '1', '--ai-dir', dir, '--herald', HERALD, '--social', SOCIAL, '--relay', RELAY, '--key-file', keyFile, '--stop-file', stopFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  try {
    const t0 = Date.now();
    while ((chain.sent.length === before || !/council of nation 0, period 1: OPEN/.test(out)) && Date.now() - t0 < 20_000) await new Promise(r => setTimeout(r, 100));
    assert.equal(chain.sent.length, before + 1, `the live seat sent one transaction: ${out}`);
    assert.equal(decodeIxData(chain.sent.at(-1).instructions.at(-1).data).name, 'Build');
    state.holdingState = 2; state.now = LATEST_UNIX + 600; // the herald now shows the village final, one bell later (the finaliser looks once per bell)
    const t1 = Date.now();
    while (!/its village is final/.test(out) && Date.now() - t1 < 20_000) await new Promise(r => setTimeout(r, 100));
    writeFileSync(stopFile, '1');
    assert.equal(await exited, 0, out);
  } finally { child.kill('SIGKILL'); }
  assert.match(out, /live seat \(run harness\): finalising its village/);
  assert.doesNotMatch(out, /scripted seat: finalising|scripted seat ballot/);
  assert.match(out, /the presenter key for the council page is \S+presenter-key\.json/);
  assert.match(out, /seat: live seat: the presenter casts the ballot on the council page \(origin 0\); this process casts no ballot/);
  assert.match(out, new RegExp(`council of nation 0, period 1: OPEN at bell ${BELL_NOW}\\. Motions until the end of bell ${BELL_NOW + 2}; BALLOT WINDOW bells ${BELL_NOW + 3} to ${BELL_NOW + 5}`));
  assert.match(out, /"casts_ballots":false/);
  assert.equal(out.includes('session_keypair'), false, 'the key is never printed');
  assert.equal(out.includes('WALLET-SECRET'), false);
  assert.equal(chain.sent.length, before + 1, 'one action, no more');
  assert.deepEqual(socialRequests.slice(reqBefore).filter(r => r.startsWith('POST')), [], 'the live seat posted nothing to the social service');
  // the files
  const pk = JSON.parse(readFileSync(join(dir, 'presenter-key.json'), 'utf8'));
  assert.deepEqual(Object.keys(pk).sort(), ['session', 'session_keypair_b58', 'wallet']);
  assert.equal(pk.wallet, wallet.publicKey);
  assert.equal(readFileSync(join(dir, 'presenter-key.json'), 'utf8').includes('WALLET-SECRET'), false);
  const log = JSON.parse(readFileSync(join(dir, 'seat/seat-live-log.json'), 'utf8'));
  assert.deepEqual({ kind: log.kind, scripted: log.scripted, casts_ballots: log.casts_ballots, final: log.finalise.final, mode: log.finalise.mode }, { kind: 'seat-live-log', scripted: false, casts_ballots: false, final: true, mode: 'live' });
  assert.equal(log.councils[0].state, 'motions');
  const pub = JSON.parse(readFileSync(join(dir, 'pub/seat/live.json'), 'utf8'));
  assert.deepEqual({ scripted: pub.scripted, casts_ballots: pub.casts_ballots, by: pub.finalise.by }, { scripted: false, casts_ballots: false, by: 'run harness' });
  assert.equal(existsSync(join(dir, 'seat/seat-script-log.json')), false);
  assert.equal(existsSync(join(dir, 'pub/seat/ballots.json')), false);
});

test('the live seat process refuses --arm (the A/B script casts the ballot) and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seatlive-cli2-'));
  const keyFile = join(dir, 'seat.txt');
  writeFileSync(keyFile, '{}');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../citizens/ab/seat.mjs', import.meta.url)), '--live', '1', '--arm', 'A', '--rep', '1', '--ai-dir', dir, '--herald', HERALD, '--social', SOCIAL, '--key-file', keyFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const code = await new Promise(r => child.on('exit', c => r(c)));
  assert.equal(code, 2, out);
  assert.match(out, /--live \(the presenter votes on the page\) cannot be combined with --arm/);
});
