// ⑯ independent verification, phase 2 (⑰ settlement): the Frontier
// rebuild's x402 entry (`POST /f/x402/join`, src/frontier/routes/prize.mjs)
// over the scripted chain of test/frontier-prize.test.mjs. The real route
// and SDK run; the chain is the fixture's (no SBF program): what the prize
// program itself would refuse (AlreadyPaid, AlreadyClaimed) is scripted
// where the test says so.
//
// Questions pinned here:
//   T17-1  does a GENERIC x402 client (Coinbase/x402.org "exact" on Solana:
//          one SPL TransferChecked of maxAmountRequired to payTo, the
//          facilitator as fee payer) get through, or only this repo's SDK
//          (`[budget prefix, Pay, Join]`)?
//   T17-2  the client paid, the 200 was lost, the same X-PAYMENT is resent:
//          does the answer tell the client the payment settled?
//   T17-3  the relay answered 504 SettlementPending (no result in time), the
//          transaction landed later, the client retries with a fresh
//          transaction: is it told "refused" although it is a paid member?
//   T17-4  a payment whose `network` is another cluster's is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encode as base58 } from '../client/src/base58.mjs';
import { toBase64, u64le } from '../client/src/bytes.mjs';
import { CLOCK_SYSVAR, FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import { rent } from '../client/src/frontier/fees.mjs';
import { ata, claimIx, ENTRY_SIZE, entryAddress, opsPart, paidJoinMessage, POOL_SIZE, prizeAddresses, x402Encode } from '../client/src/frontier/prize.mjs';
import { compileMessage, parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk, verifyTalk } from '../client/src/talk-node.mjs';
import { transferCheckedIx } from '../src/frontier/agent/custody.mjs';
import { createFrontierApps } from '../src/frontier/app.mjs';
import { InviteBook } from '../src/frontier/invites.mjs';
import { PayerPool } from '../src/frontier/payers.mjs';
import { call } from './gateway-fixtures.mjs';

const PROGRAM = Keypair.generate().publicKey.toBase58();
const PRIZE_PROGRAM = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const SEASON_ID = 5n;
const A = new FrontierAddresses({ programId: PROGRAM, seasonId: SEASON_ID });
const PRIZE = prizeAddresses({ prizeProgram: PRIZE_PROGRAM, gameProgram: PROGRAM, seasonId: SEASON_ID, mint: MINT });
const GENESIS = 1_800_000_000;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const FEE = 25_000_000n;
const gate = Keypair.generate();
const put = (d, o, bytes) => d.set(bytes, o);

function poolData({ fee = FEE, opsBps = 2000, entries = 0, state = 0, counted = 0 } = {}) {
  const d = new Uint8Array(POOL_SIZE);
  put(d, 0, new TextEncoder().encode('WYPRPOOL'));
  d[10] = state; d[11] = 6;
  put(d, 16, u64le(SEASON_ID)); put(d, 24, new PublicKey(PROGRAM).toBytes()); put(d, 56, new PublicKey(A.season).toBytes());
  put(d, 120, new PublicKey(MINT).toBytes()); put(d, 152, new PublicKey(PRIZE.vault).toBytes());
  put(d, 184, u64le(fee)); d[192] = opsBps & 255; d[193] = opsBps >> 8; d[194] = 54; d[196] = counted;
  d[232] = entries;
  const collected = fee * BigInt(entries);
  put(d, 240, u64le(collected)); put(d, 248, u64le(collected - opsPart(collected, opsBps))); put(d, 256, u64le(opsPart(collected, opsBps)));
  return d;
}
function entryData(wallet, { amount = FEE } = {}) {
  const d = new Uint8Array(ENTRY_SIZE);
  put(d, 0, new TextEncoder().encode('WYPRENTR'));
  put(d, 16, new PublicKey(PRIZE.pool).toBytes()); put(d, 48, new PublicKey(wallet).toBytes()); put(d, 80, u64le(amount));
  return d;
}
const clockAccount = unix => { const b = Buffer.alloc(40); b.writeBigUInt64LE(77n, 0); b.writeBigInt64LE(BigInt(unix), 32); return b; };

/** The scripted chain of frontier-prize.test.mjs, plus `confirm` (false: a sent transaction has no status until `c.land(sig)`). */
function fakeChain({ debit = () => 0n, fail = () => null, onSent = () => {}, confirm = true } = {}) {
  const c = {
    accounts: new Map(), sent: [], simulated: 0, statuses: new Map(), height: 100,
    set(key, v) { c.accounts.set(String(key), { lamports: v.lamports ?? 1_000_000_000, data: Buffer.from(v.data ?? []) }); },
    land(sig) { c.statuses.set(sig, { slot: 78, err: null, confirmationStatus: 'confirmed' }); },
    getAccountInfo: async key => c.accounts.get(new PublicKey(key).toBase58()) ?? null,
    getMultipleAccountsInfo: async keys => keys.map(k => c.accounts.get(new PublicKey(k).toBase58()) ?? null),
    getBalance: async key => c.accounts.get(new PublicKey(key).toBase58())?.lamports ?? 0,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 150 }),
    getBlockHeight: async () => c.height,
    getSlot: async () => 77,
    simulateTransaction: async (vtx, cfg) => {
      c.simulated++;
      const tx = parseTransaction(vtx.serialize());
      for (const [i, s] of tx.signers.entries()) if (!verifyTalk(tx.message, tx.signatures[i], new PublicKey(s).toBytes())) return { value: { err: 'SignatureFailure', logs: [] } };
      const f = fail(tx, c);
      if (f) return { value: f };
      const payer = tx.signers[0];
      const post = BigInt(c.accounts.get(payer)?.lamports ?? 0) - 5_000n * BigInt(tx.signers.length) - BigInt(debit(tx));
      return { value: { err: null, logs: [], unitsConsumed: 9_000, accounts: cfg.accounts.addresses.map(a => (a === payer ? { lamports: Number(post), data: ['', 'base64'] } : null)) } };
    },
    sendRawTransaction: async raw => {
      const tx = parseTransaction(new Uint8Array(raw));
      c.sent.push(tx);
      const sig = base58(tx.signatures[0]);
      if (confirm) c.land(sig);
      onSent(tx, c, sig);
      return sig;
    },
    getSignatureStatuses: async sigs => ({ value: sigs.map(s => c.statuses.get(s) ?? null) }),
  };
  return c;
}

function relay({ chain = fakeChain(), pool = {} } = {}) {
  const payers = new PayerPool({ masterSeed: Buffer.alloc(32, 7), n: 150 });
  for (const k of payers.publicKeys()) chain.set(k, { lamports: 2_000_000_000 });
  chain.set(A.season, { data: encodeAccount('Season', { SEASON_ID, STATUS: 2, GENESIS_TS: BigInt(GENESIS), MARCH_FEE: 10_000n, SEAL_BOND: 20_000n, MIN_REVEAL_PRIORITY_MILLI: 433,
    REVEAL_CU_LIMIT: 26_000, REVEAL_LOADED_LIMIT: 1_048_576, JOIN_GATE: gate.publicKey.toBytes() }) });
  chain.set(CLOCK_SYSVAR, { data: clockAccount(GENESIS + 3_600) });
  chain.set(PRIZE.pool, { data: poolData(pool) });
  const store = { state: {}, save() {} };
  const cfg = { cluster: 'localnet', programId: PROGRAM, seasonId: String(SEASON_ID), heraldPeer: '127.0.0.1', heraldUrl: 'http://127.0.0.1:41040', minPoolSol: 1, operatorToken: 'op',
    prizeProgram: PRIZE_PROGRAM, prizeMint: MINT, faucetAmount: 100_000_000, prizeLedgerFile: null };
  const invites = new InviteBook({ secret: Buffer.alloc(32, 3), seasonId: SEASON_ID, store });
  const logs = [];
  const apps = createFrontierApps({ cfg, connection: chain, pool: payers, invites, gateKey: gate, faucetKey: null, store, log: m => logs.push(m) });
  return { ...apps, chain, payers, store, logs };
}

const joinAccounts = w => ({ wallet: w, season: A.season, frontier: A.frontier, citizen: A.citizen(w), joinshard: A.joinShardFor(2, w), join_gate: gate.publicKey.toBase58() });
const joinFields = { faction: 2, session: Keypair.generate().publicKey.toBytes(), session_expiry: BigInt(GENESIS + 86_400) };
const paidMessage = (w, feePayer, over = {}) => paidJoinMessage({ programId: PROGRAM, prize: PRIZE, wallet: w, joinAccounts: joinAccounts(w), joinFields, feePayer, recentBlockhash: BLOCKHASH, ...over });
const signedBy = (message, ...keys) => wireTransaction(message, Object.fromEntries(keys.map(k => [k.publicKey.toBase58(), signTalk(message, k)])));
const payment = (wire, network = 'solana-localnet') => ({ 'x-payment': x402Encode({ x402Version: 1, scheme: 'exact', network, payload: { transaction: toBase64(wire) } }) });
const post = (r, headers = {}, body = {}) => call(r.public, 'POST', '/f/x402/join', { body, headers, ip: '203.0.113.9' });
const requirements = async r => (await post(r)).json.accepts[0];

test('T17-1: a generic x402 "exact" Solana payment (one TransferChecked of maxAmountRequired to payTo) is refused; only this repo\'s [prefix, Pay, Join] shape pays', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  const r = relay();
  const q = await requirements(r);
  // What the public 402 says (x402.org fields): scheme exact, network, asset = mint, payTo = vault, maxAmountRequired.
  assert.deepEqual([q.scheme, q.network, q.asset, q.payTo, q.maxAmountRequired], ['exact', 'solana-localnet', MINT, PRIZE.vault, String(FEE)]);
  // A generic client builds the spec's payment: the fee payer the requirements name, one TransferChecked from the
  // wallet's token account to payTo for maxAmountRequired, signed by the wallet.
  const generic = compileMessage({ feePayer: q.extra.feePayer, recentBlockhash: q.extra.recentBlockhash,
    instructions: [transferCheckedIx({ source: ata(wallet, MINT), mint: MINT, dest: q.payTo, authority: wallet, amount: FEE, decimals: q.extra.decimals })] });
  const a = await post(r, payment(signedBy(generic, w)));
  // Recorded behaviour: refused before anything is sent. The 402's `extra.instruction` says what is accepted.
  assert.deepEqual([a.status, a.json.code], [402, 'InvalidPayment'], JSON.stringify(a.json));
  assert.equal(q.extra.instruction, 'Pay+Join', 'the requirements declare the repo-specific shape');
  assert.equal(r.chain.sent.length, 0);
});

test('T17-2: the 200 was lost; resending the same X-PAYMENT must tell the client the payment settled (the transaction), not only "duplicate"', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  const chain = fakeChain({ debit: () => rent(384) + rent(ENTRY_SIZE), onSent: (_, c) => { c.set(PRIZE.pool, { data: poolData({ entries: 1 }) }); c.set(entryAddress(PRIZE_PROGRAM, PRIZE.pool, wallet), { data: entryData(wallet) }); } });
  const r = relay({ chain });
  const q = await requirements(r);
  const header = payment(signedBy(paidMessage(wallet, q.extra.feePayer), w));
  const first = await post(r, header);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const settled = first.json.signature;
  // The client never saw `first`. It resends the identical payment (the x402 way to retry a facilitator call).
  const again = await post(r, header);
  assert.equal(chain.sent.length, 1, 'nothing is sent twice (holds today: 409 Duplicate)');
  const names = again.status === 200 ? again.json.signature === settled : (again.json.signature === settled || again.json.transaction === settled);
  assert.ok(names, `the retry must name the settled transaction ${settled}; got ${again.status} ${JSON.stringify(again.json)}`);
});

test('T17-3: after a 504 SettlementPending the transaction landed; a retry with a fresh transaction is told AlreadyPaid instead of "you are in"', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  let pending = true;
  // The first send gets no status within the relay's wait (the chain is slow); the entry and the pool appear later.
  const chain = fakeChain({ confirm: false, debit: () => rent(384) + rent(ENTRY_SIZE),
    fail: tx => (pending ? null : { err: { InstructionError: [3, { Custom: 0x105 }] }, logs: [`Program ${PRIZE_PROGRAM} invoke [1]`, `Program ${PRIZE_PROGRAM} failed: custom program error: 0x105`] }) });
  const r = relay({ chain });
  const q = await requirements(r);
  const t0 = Date.now();
  const lost = await post(r, payment(signedBy(paidMessage(wallet, q.extra.feePayer), w)));
  assert.deepEqual([lost.status, lost.json.code], [504, 'SettlementPending'], JSON.stringify(lost.json));
  assert.ok(Date.now() - t0 >= 10_000, 'the relay waited its 60 × 250 ms');
  // Later the chain lands it: the wallet is a paid member.
  chain.land(base58(chain.sent[0].signatures[0]));
  chain.set(PRIZE.pool, { data: poolData({ entries: 1 }) });
  chain.set(entryAddress(PRIZE_PROGRAM, PRIZE.pool, wallet), { data: entryData(wallet) });
  // and the Join landed with it: the wallet's Citizen exists
  chain.set(A.citizen(wallet), { data: encodeAccount('Citizen', { SEASON_ID, WALLET: new PublicKey(wallet).toBytes(), SESSION: new Uint8Array(32), SESSION_EXPIRY: 0n, FACTION: 2 }) });
  pending = false;
  // The client retries as the 504 implies (a new transaction, since the old bytes would be a Duplicate). The prize
  // program refuses the second Pay (AlreadyPaid); the relay turns that into 402 "payment refused".
  const fresh = paidJoinMessage({ programId: PROGRAM, prize: PRIZE, wallet, joinAccounts: joinAccounts(wallet), joinFields, feePayer: q.extra.feePayer, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  const retry = await post(r, payment(signedBy(fresh, w)));
  // The invariant: a paid member who retries is told so (200, mode `settled`, or a code that says "you are in"), never
  // "payment refused". Today: 402 AlreadyPaid, with `accepts` asking for another payment.
  assert.ok(retry.status === 200 || retry.json.code === 'AlreadyJoined',
    `a paid member retrying must not read as a refused payment; got ${retry.status} ${JSON.stringify({ code: retry.json.code, error: retry.json.error })}`);
});

test('T17-4: a payment whose network is another cluster\'s is refused with the requirements (confirmation)', async () => {
  const w = Keypair.generate();
  const r = relay();
  const q = await requirements(r);
  const a = await post(r, payment(signedBy(paidMessage(w.publicKey.toBase58(), q.extra.feePayer), w), 'solana-devnet'));
  assert.deepEqual([a.status, a.json.code], [402, 'InvalidPayment']);
  assert.equal(r.chain.sent.length, 0);
});

test('T17-5: a Claim that landed but whose Entry cannot be read back is reported with amount "0" (an unknown amount shown as zero)', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  // The chain answers the Entry while the relay checks the claim, then (a lagging RPC, a pruned read) answers nothing for it after the send.
  let entryVisible = true;
  const chain = fakeChain();
  const realGet = chain.getAccountInfo;
  chain.getAccountInfo = async key => (!entryVisible && new PublicKey(key).toBase58() === entryAddress(PRIZE_PROGRAM, PRIZE.pool, wallet) ? null : realGet(key));
  const r = relay({ chain });
  chain.set(entryAddress(PRIZE_PROGRAM, PRIZE.pool, wallet), { data: entryData(wallet) });
  const fp = (await call(r.public, 'GET', '/f/relay')).json.feePayer;
  const good = claimIx({ prize: PRIZE, wallet, citizen: A.citizen(wallet), nation: 2, points: 10n, proof: [new Uint8Array(32)] });
  const wire = signedBy(compileMessage({ feePayer: fp, recentBlockhash: BLOCKHASH, instructions: [good] }), w);
  const origSend = chain.sendRawTransaction;
  chain.sendRawTransaction = async raw => { const sig = await origSend(raw); entryVisible = false; return sig; };
  const ok = await call(r.public, 'POST', '/f/prize/claim', { body: { tx: toBase64(wire) }, ip: '203.0.113.9' });
  assert.deepEqual([ok.status, ok.json.ok, chain.sent.length], [200, true, 1]);
  // The invariant: an amount the relay could not read is reported as unknown (null / absent), never as the number 0.
  assert.notEqual(ok.json.amount, '0', `the claim landed but its amount is unknown; the answer says ${JSON.stringify(ok.json)}`);
});
