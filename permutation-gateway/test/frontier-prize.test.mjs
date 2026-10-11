// The prize pool on the relay and in the SDK (permutation-prize; test
// tokens only): addresses and share hashes against the program's vectors,
// the paid-Join shape, the x402 handshake of POST /f/x402/join over a
// scripted chain (atomic and settled payments, refusals that send nothing),
// the faucet, the sponsored Claim, and the agent helper `joinViaX402`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encode as base58 } from '../client/src/base58.mjs';
import { fromBase64, toBase64, toHex, u64le } from '../client/src/bytes.mjs';
import { CLOCK_SYSVAR, FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import { rent } from '../client/src/frontier/fees.mjs';
import { ata, claimAmount, claimIx, classifyPaidJoin, decodeEntry, decodePool, ENTRY_SIZE, entryAddress, joinViaX402, leafHash, merkleTree, nodeHash, opsPart, paidJoinBudget,
  paidJoinMessage, payIx, POOL_SIZE, prizeAddresses, x402Decode, x402Encode } from '../client/src/frontier/prize.mjs';
import { shapeMessage } from '../client/src/frontier/shapes.mjs';
import { compileMessage, parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk, verifyTalk } from '../client/src/talk-node.mjs';
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
/** The owner's fee: 25 test USDC (6 decimals). */
const FEE = 25_000_000n;
const gate = Keypair.generate();

const put = (d, o, bytes) => d.set(bytes, o);
function poolData({ fee = FEE, opsBps = 2000, entries = 0, state = 0, counted = 0, winnersMask = 0, mode = 0, shareNations = 0, totals = [0, 0, 0, 0, 0, 0], area = [0, 0, 0, 0, 0, 0] } = {}) {
  const d = new Uint8Array(POOL_SIZE);
  put(d, 0, new TextEncoder().encode('WYPRPOOL'));
  d[10] = state; d[11] = 6; d[12] = winnersMask; d[13] = mode; d[14] = shareNations;
  put(d, 16, u64le(SEASON_ID)); put(d, 24, new PublicKey(PROGRAM).toBytes()); put(d, 56, new PublicKey(A.season).toBytes());
  put(d, 120, new PublicKey(MINT).toBytes()); put(d, 152, new PublicKey(PRIZE.vault).toBytes());
  put(d, 184, u64le(fee)); d[192] = opsBps & 255; d[193] = opsBps >> 8; d[194] = 54; d[196] = counted;
  d[232] = entries;
  const collected = fee * BigInt(entries);
  put(d, 240, u64le(collected)); put(d, 248, u64le(collected - opsPart(collected, opsBps))); put(d, 256, u64le(opsPart(collected, opsBps)));
  area.forEach((a, f) => { d[280 + 2 * f] = a; });
  totals.forEach((t, f) => put(d, 344 + 8 * f, u64le(t)));
  return d;
}
function entryData(wallet, { amount = FEE, claimed = false } = {}) {
  const d = new Uint8Array(ENTRY_SIZE);
  put(d, 0, new TextEncoder().encode('WYPRENTR'));
  d[9] = claimed ? 1 : 0;
  put(d, 16, new PublicKey(PRIZE.pool).toBytes()); put(d, 48, new PublicKey(wallet).toBytes()); put(d, 80, u64le(amount));
  return d;
}
function clockAccount(unix) {
  const b = Buffer.alloc(40);
  b.writeBigUInt64LE(77n, 0);
  b.writeBigInt64LE(BigInt(unix), 32);
  return b;
}

/** A scripted chain (as test/frontier-relay.test.mjs): simulate checks every signature and debits the fee payer; a sent transaction is confirmed at once. */
function fakeChain({ debit = () => 0n, fail = () => null, onSent = () => {} } = {}) {
  const c = {
    accounts: new Map(), sent: [], simulated: 0, statuses: new Map(), height: 100,
    set(key, v) { c.accounts.set(String(key), { lamports: v.lamports ?? 1_000_000_000, data: Buffer.from(v.data ?? []) }); },
    getAccountInfo: async key => c.accounts.get(new PublicKey(key).toBase58()) ?? null,
    getMultipleAccountsInfo: async keys => keys.map(k => c.accounts.get(new PublicKey(k).toBase58()) ?? null),
    getBalance: async key => c.accounts.get(new PublicKey(key).toBase58())?.lamports ?? 0,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 150 }),
    getBlockHeight: async () => c.height,
    getSlot: async () => 77,
    simulateTransaction: async (vtx, cfg) => {
      c.simulated++;
      const tx = parseTransaction(vtx.serialize());
      assert.equal(cfg.sigVerify, true, 'simulated with signatures');
      for (const [i, s] of tx.signers.entries()) {
        if (!verifyTalk(tx.message, tx.signatures[i], new PublicKey(s).toBytes())) return { value: { err: 'SignatureFailure', logs: [] } };
      }
      const f = fail(tx);
      if (f) return { value: f };
      const payer = tx.signers[0];
      const post = BigInt(c.accounts.get(payer)?.lamports ?? 0) - 5_000n * BigInt(tx.signers.length) - BigInt(debit(tx));
      return { value: { err: null, logs: [], unitsConsumed: 9_000, accounts: cfg.accounts.addresses.map(a => (a === payer ? { lamports: Number(post), data: ['', 'base64'] } : null)) } };
    },
    sendRawTransaction: async raw => {
      const tx = parseTransaction(new Uint8Array(raw));
      c.sent.push(tx);
      const sig = base58(tx.signatures[0]);
      c.statuses.set(sig, { slot: 78, err: null, confirmationStatus: 'confirmed' });
      onSent(tx, c);
      return sig;
    },
    getSignatureStatuses: async sigs => ({ value: sigs.map(s => c.statuses.get(s) ?? null) }),
  };
  return c;
}

function relay({ chain = fakeChain(), prize = true, gated = true, pool = {}, faucetKey = null, cluster = 'localnet' } = {}) {
  const payers = new PayerPool({ masterSeed: Buffer.alloc(32, 7), n: 150 });
  for (const k of payers.publicKeys()) chain.set(k, { lamports: 2_000_000_000 });
  chain.set(A.season, { data: encodeAccount('Season', { SEASON_ID, STATUS: 2, GENESIS_TS: BigInt(GENESIS), MARCH_FEE: 10_000n, SEAL_BOND: 20_000n, MIN_REVEAL_PRIORITY_MILLI: 433,
    REVEAL_CU_LIMIT: 26_000, REVEAL_LOADED_LIMIT: 1_048_576, JOIN_GATE: gated ? gate.publicKey.toBytes() : new Uint8Array(32) }) });
  chain.set(CLOCK_SYSVAR, { data: clockAccount(GENESIS + 3_600) });
  if (prize) chain.set(PRIZE.pool, { data: poolData(pool) });
  const store = { state: {}, save() { store.saves = (store.saves ?? 0) + 1; } };
  const cfg = { cluster, programId: PROGRAM, seasonId: String(SEASON_ID), heraldPeer: '127.0.0.1', heraldUrl: 'http://127.0.0.1:41040', minPoolSol: 1, operatorToken: 'op',
    prizeProgram: prize ? PRIZE_PROGRAM : null, prizeMint: prize ? MINT : null, faucetAmount: 100_000_000, prizeLedgerFile: null };
  const invites = new InviteBook({ secret: Buffer.alloc(32, 3), seasonId: SEASON_ID, store });
  const logs = [];
  const apps = createFrontierApps({ cfg, connection: chain, pool: payers, invites, gateKey: gated ? gate : null, faucetKey, store, log: m => logs.push(m) });
  return { ...apps, chain, payers, store, logs };
}

const joinAccounts = (w, withGate = true) => ({ wallet: w, season: A.season, frontier: A.frontier, citizen: A.citizen(w), joinshard: A.joinShardFor(2, w), ...(withGate ? { join_gate: gate.publicKey.toBase58() } : {}) });
const joinFields = { faction: 2, session: Keypair.generate().publicKey.toBytes(), session_expiry: BigInt(GENESIS + 86_400) };
const paidMessage = (w, feePayer, over = {}) => paidJoinMessage({ programId: PROGRAM, prize: PRIZE, wallet: w, joinAccounts: joinAccounts(w), joinFields, feePayer, recentBlockhash: BLOCKHASH, ...over });
const signedBy = (message, ...keys) => wireTransaction(message, Object.fromEntries(keys.map(k => [k.publicKey.toBase58(), signTalk(message, k)])));
const payment = wire => ({ 'x-payment': x402Encode({ x402Version: 1, scheme: 'exact', network: 'solana-localnet', payload: { transaction: toBase64(wire) } }) });
const post = (r, headers = {}, body = {}) => call(r.public, 'POST', '/f/x402/join', { body, headers, ip: '203.0.113.9' });
const requirements = async r => (await post(r)).json.accepts[0];

// ------------------------------------------------------------------ SDK

test('prize SDK: the pool, vault and entry are PDAs of the prize program; decoders read the program\'s layouts', () => {
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), new PublicKey(PROGRAM).toBuffer(), Buffer.from(u64le(SEASON_ID))], new PublicKey(PRIZE_PROGRAM));
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), pool.toBuffer()], new PublicKey(PRIZE_PROGRAM));
  const w = Keypair.generate().publicKey;
  const [entry] = PublicKey.findProgramAddressSync([Buffer.from('entry'), pool.toBuffer(), w.toBuffer()], new PublicKey(PRIZE_PROGRAM));
  assert.deepEqual([PRIZE.pool, PRIZE.vault, entryAddress(PRIZE_PROGRAM, PRIZE.pool, w.toBase58())], [pool.toBase58(), vault.toBase58(), entry.toBase58()]);
  const p = decodePool(poolData({ entries: 2 }));
  assert.deepEqual([p.fee, p.opsBps, p.entries, p.collected, p.prize, p.ops, p.mint, p.vault, p.expectedKeeps], [FEE, 2000, 2, 50_000_000n, 40_000_000n, 10_000_000n, MINT, PRIZE.vault, 54]);
  assert.equal(decodePool(new Uint8Array(POOL_SIZE)), null);
  const e = decodeEntry(entryData(w.toBase58()));
  assert.deepEqual([e.wallet, e.pool, e.amount, e.claimed], [w.toBase58(), PRIZE.pool, FEE, false]);
  // 25 test USDC: 20 to the prize, 5 to the operator.
  assert.equal(opsPart(FEE, 2000), 5_000_000n);
});

test('prize SDK: share hashes are permutation-prize\'s (its unit test pins the same vectors); the tree proves every leaf', () => {
  const pool = base58(new Uint8Array(32).fill(7));
  const a = leafHash(pool, base58(new Uint8Array(32).fill(1)), 2, 10n);
  const b = leafHash(pool, base58(new Uint8Array(32).fill(2)), 2, 3n);
  assert.equal(toHex(a), 'ae1f8f256f5c65762ac65c7a2bf12f69d6e7e4fdc870d74fd0da943da34c6e64');
  assert.equal(toHex(nodeHash(a, b)), 'fc71c2545a8a38c0bc74f5b24ab1d559fdfb6d0385fb5a594b4c9d78bc83c0e3');
  assert.deepEqual(nodeHash(a, b), nodeHash(b, a));
  const leaves = [1, 2, 3, 4, 5].map(i => leafHash(pool, base58(new Uint8Array(32).fill(i)), 1, BigInt(i)));
  const tree = merkleTree(leaves);
  for (const l of leaves) assert.deepEqual(tree.proof(l).reduce((h, s) => nodeHash(h, s), l), tree.root);
  assert.deepEqual(merkleTree([...leaves].reverse()).root, tree.root, 'the root does not depend on the order');
  assert.equal(tree.proof(new Uint8Array(32)), null);
  // The claim arithmetic of the program.
  const p = decodePool(poolData({ entries: 3, state: 2, mode: 1, shareNations: 1, totals: [0, 16, 0, 0, 0, 0] }));
  assert.equal(claimAmount(p, { points: 10n, nation: 1 }), 60_000_000n * 10n / 16n);
  assert.equal(claimAmount(p, { points: 17n, nation: 1 }), null);
  assert.equal(claimAmount(decodePool(poolData({ entries: 2, state: 2, mode: 2 })), { paid: FEE }), 20_000_000n);
});

test('prize SDK: the paid Join is exactly [limit, price 0, loaded, Pay, Join]; anything else is refused', () => {
  const w = Keypair.generate();
  const fp = Keypair.generate().publicKey.toBase58();
  const wallet = w.publicKey.toBase58();
  const ok = classifyPaidJoin(parseTransaction(wireTransaction(paidMessage(wallet, fp))), { programId: PROGRAM, prize: PRIZE });
  assert.equal(ok.ok, true, ok.problem);
  assert.deepEqual([ok.wallet, ok.walletToken, ok.join.name, ok.join.accounts.join_gate, ok.join.signers.length], [wallet, ata(wallet, MINT), 'Join', gate.publicKey.toBase58(), 3]);
  const refused = (message, re) => {
    const r = classifyPaidJoin(parseTransaction(wireTransaction(message)), { programId: PROGRAM, prize: PRIZE });
    assert.equal(r.ok, false);
    assert.match(r.problem, re);
  };
  const other = prizeAddresses({ prizeProgram: PRIZE_PROGRAM, gameProgram: PROGRAM, seasonId: 6n, mint: MINT });
  refused(paidMessage(wallet, fp, { prize: other }), /not this season's pool/);
  refused(paidMessage(wallet, fp, { prize: { ...PRIZE, vault: Keypair.generate().publicKey.toBase58() } }), /not this season's pool, vault/);
  refused(paidMessage(wallet, fp, { prize: { ...PRIZE, mint: Keypair.generate().publicKey.toBase58() } }), /not this season's pool, vault, mint/);
  // A plain Join (no Pay), a Pay by another wallet, the fee payer paying, another budget.
  refused(shapeMessage({ programId: PROGRAM, name: 'Join', accounts: joinAccounts(wallet), fields: joinFields, feePayer: fp, recentBlockhash: BLOCKHASH }), /exactly five instructions/);
  const b = paidJoinBudget();
  const parts = parseTransaction(wireTransaction(paidMessage(wallet, fp))).instructions;
  const stranger = Keypair.generate().publicKey.toBase58();
  refused(compileMessage({ feePayer: fp, recentBlockhash: BLOCKHASH, instructions: [...parts.slice(0, 3), payIx({ prize: PRIZE, wallet: stranger, payer: fp }), parts[4]] }), /Pay's wallet must be the Join's wallet/);
  refused(compileMessage({ feePayer: fp, recentBlockhash: BLOCKHASH, instructions: [...parts.slice(0, 3), payIx({ prize: PRIZE, wallet: fp, payer: fp }), parts[4]] }), /fee payer never pays/);
  refused(paidMessage(wallet, fp, { profile: 2 }), /the prefix must be limit/);
  assert.ok(b.cuLimit > 13_500 && b.loadedLimit > 1_146_880);
});

// ------------------------------------------------------------------ x402

test('POST /f/x402/join without a payment: 402 with the price (25 test USDC to the vault, in the test mint)', async () => {
  const r = relay();
  const a = await post(r);
  assert.equal(a.status, 402);
  assert.equal(a.json.x402Version, 1);
  const q = a.json.accepts[0];
  assert.deepEqual([q.scheme, q.network, q.maxAmountRequired, q.payTo, q.asset], ['exact', 'solana-localnet', '25000000', PRIZE.vault, MINT]);
  assert.deepEqual([q.extra.programId, q.extra.season, q.extra.pool, q.extra.prizeProgram, q.extra.joinGate, q.extra.opsBps, q.extra.testAssetsOnly],
    [PROGRAM, A.season, PRIZE.pool, PRIZE_PROGRAM, gate.publicKey.toBase58(), 2000, true]);
  assert.ok(r.payers.has(q.extra.feePayer));
  assert.equal(r.chain.sent.length, 0);
  // GET /f/season names the pool; a relay without one says so and has no x402 route.
  assert.equal((await call(r.public, 'GET', '/f/season')).json.prize.pool, PRIZE.pool);
  const none = relay({ prize: false });
  assert.equal((await call(none.public, 'GET', '/f/season')).json.prize, null);
  assert.deepEqual([(await post(none)).status, (await call(none.public, 'GET', '/f/prize')).json.code], [404, 'NoPrizePool']);
});

test('POST /f/x402/join with Pay and Join in one transaction: the relay adds the fee payer and the gate, sends, answers X-PAYMENT-RESPONSE', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  const chain = fakeChain({ debit: () => rent(384) + rent(ENTRY_SIZE), onSent: (_, c) => c.set(PRIZE.pool, { data: poolData({ entries: 1 }) }) });
  const r = relay({ chain });
  const q = await requirements(r);
  const a = await post(r, payment(signedBy(paidMessage(wallet, q.extra.feePayer), w)));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual([a.json.mode, a.json.wallet, a.json.paid, a.json.pool.prize, a.json.pool.ops], ['atomic', wallet, '25000000', '20000000', '5000000']);
  const pr = x402Decode(a.headers['X-PAYMENT-RESPONSE']);
  assert.deepEqual([pr.success, pr.transaction, pr.network, pr.payer], [true, a.json.signature, 'solana-localnet', wallet]);
  // What was sent: the wallet's bytes, with the fee payer's and the gate's signatures added.
  assert.equal(chain.sent.length, 1);
  const sent = chain.sent[0];
  assert.deepEqual(sent.signers, [q.extra.feePayer, ...[wallet, gate.publicKey.toBase58()].sort((x, y) => sent.signers.indexOf(x) - sent.signers.indexOf(y))]);
  for (const [i, s] of sent.signers.entries()) assert.ok(verifyTalk(sent.message, sent.signatures[i], new PublicKey(s).toBytes()), `${s} signed`);
  assert.deepEqual(sent.instructions.slice(3).map(ix => ix.programId), [PRIZE_PROGRAM, PROGRAM]);
  // The same bytes again are refused (replay), and nothing more is sent.
  assert.notEqual((await post(r, payment(signedBy(paidMessage(wallet, q.extra.feePayer), w)))).status, 200);
  assert.equal(chain.sent.length, 1);
});

test('POST /f/x402/join never signs the gate for an unpaid Join; a wallet whose entry is confirmed on chain may join with a plain Join', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  const chain = fakeChain({ debit: () => rent(384) });
  const r = relay({ chain });
  const q = await requirements(r);
  const plain = () => signedBy(shapeMessage({ programId: PROGRAM, name: 'Join', accounts: joinAccounts(wallet), fields: joinFields, feePayer: q.extra.feePayer, recentBlockhash: BLOCKHASH }), w);
  const a = await post(r, payment(plain()));
  assert.deepEqual([a.status, a.json.code], [402, 'PaymentRequired']);
  assert.equal(a.json.accepts[0].maxAmountRequired, '25000000');
  // An entry of another pool, or for less than the fee, is no payment.
  chain.set(entryAddress(PRIZE_PROGRAM, PRIZE.pool, wallet), { data: entryData(wallet, { amount: FEE - 1n }) });
  assert.equal((await post(r, payment(plain()))).json.code, 'PaymentRequired');
  // The free route does not open the gate either: it needs an operator invite.
  assert.equal((await call(r.public, 'POST', '/f/join', { body: { tx: toBase64(plain()) }, ip: '203.0.113.9' })).json.code, 'InviteRequired');
  assert.deepEqual([chain.sent.length, chain.simulated], [0, 0]);
  chain.set(entryAddress(PRIZE_PROGRAM, PRIZE.pool, wallet), { data: entryData(wallet) });
  const ok = await post(r, payment(plain()));
  assert.deepEqual([ok.status, ok.json.mode, ok.json.paid], [200, 'settled', '0']);
  assert.ok(chain.sent[0].signers.includes(gate.publicKey.toBase58()));
});

test('POST /f/x402/join refuses a payment to another vault or mint, a forged wallet, a failing transfer, and a closed pool; nothing is sent', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const chain = fakeChain({ fail: () => ({ err: { InstructionError: [3, { Custom: 1 }] }, logs: [`Program ${TOKEN} invoke [2]`, 'Program log: Error: insufficient funds', `Program ${TOKEN} failed: custom program error: 0x1`] }) });
  const r = relay({ chain });
  const q = await requirements(r);
  const fp = q.extra.feePayer;
  const bad = async (message, code, re) => {
    const a = await post(r, payment(signedBy(message, w)));
    assert.deepEqual([a.status, a.json.code], [402, code], JSON.stringify(a.json));
    if (re) assert.match(a.json.error, re);
    assert.equal(a.json.accepts.length, 1);
  };
  await bad(paidMessage(wallet, fp, { prize: { ...PRIZE, vault: Keypair.generate().publicKey.toBase58() } }), 'InvalidPayment', /vault/);
  await bad(paidMessage(wallet, fp, { prize: { ...PRIZE, mint: Keypair.generate().publicKey.toBase58() } }), 'InvalidPayment');
  await bad(paidMessage(wallet, fp, { joinAccounts: joinAccounts(wallet, false) }), 'InvalidPayment', /join gate/);
  // Not signed by the wallet.
  const forged = await post(r, payment(wireTransaction(paidMessage(wallet, fp))));
  assert.deepEqual([forged.status, forged.json.code], [402, 'InvalidPayment']);
  // Not base64 JSON.
  assert.deepEqual([(await post(r, { 'x-payment': '%%%' })).status, (await post(r, { 'x-payment': x402Encode({ payload: {} }) })).json.code], [400, 'InvalidPayment']);
  // The wallet has no test USDC: the simulation fails in the token program.
  await bad(paidMessage(wallet, fp), 'InsufficientFunds', /payment refused/);
  assert.equal(chain.sent.length, 0);
  // After the tally started the pool takes no entry.
  const closed = relay({ pool: { counted: 3 } });
  const q2 = await requirements(closed);
  assert.equal((await post(closed, payment(signedBy(paidMessage(wallet, q2.extra.feePayer), w)))).json.code, 'EntriesClosed');
});

test('joinViaX402: one request, the 402, the paid retry; it refuses requirements that are not this season\'s or above the caller\'s limit', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  const chain = fakeChain({ debit: () => rent(384) + rent(ENTRY_SIZE), onSent: (_, c) => c.set(PRIZE.pool, { data: poolData({ entries: 1 }) }) });
  const r = relay({ chain });
  const seen = [];
  const viaHandler = tamper => async (url, init) => {
    const a = await call(r.public, init.method, new URL(url).pathname, { body: init.body, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), ip: '203.0.113.9' });
    seen.push(a.status);
    const json = tamper && a.status === 402 ? tamper(a.json) : a.json;
    return { status: a.status, headers: { get: k => a.headers[Object.keys(a.headers).find(h => h.toLowerCase() === k.toLowerCase())] ?? null }, json: async () => json };
  };
  const args = { wallet, sign: async m => signTalk(m, w), faction: 2, session: joinFields.session, sessionExpiry: joinFields.session_expiry };
  await assert.rejects(joinViaX402('http://relay', { ...args, maxFee: 24_999_999n, fetch: viaHandler() }), e => e.code === 'X402TooExpensive');
  const elsewhere = j => ({ ...j, accepts: [{ ...j.accepts[0], payTo: Keypair.generate().publicKey.toBase58() }] });
  await assert.rejects(joinViaX402('http://relay', { ...args, fetch: viaHandler(elsewhere) }), e => e.code === 'X402Mismatch');
  assert.equal(chain.sent.length, 0);
  const done = await joinViaX402('http://relay/', { ...args, maxFee: FEE, fetch: viaHandler() });
  assert.deepEqual([done.ok, done.paymentResponse.payer, done.paymentResponse.transaction, done.requirements.maxAmountRequired], [true, wallet, done.signature, '25000000']);
  assert.deepEqual(seen.slice(-2), [402, 200]);
  assert.equal(chain.sent.length, 1);
  // A wallet adapter (signTransaction) works the same way.
  const w2 = Keypair.generate();
  const viaAdapter = await joinViaX402('http://relay', { ...args, wallet: w2.publicKey.toBase58(), fetch: viaHandler(),
    signTransaction: async wire => { const tx = parseTransaction(wire); return wireTransaction(tx.message, { [w2.publicKey.toBase58()]: signTalk(tx.message, w2) }); } });
  assert.equal(viaAdapter.body.wallet, w2.publicKey.toBase58());
});

// ------------------------------------------------------------------ pool view, faucet, claim

test('GET /f/prize reads the pool from the chain; POST /f/faucet gives a wallet test tokens once, on localnet only', async () => {
  const faucetKey = Keypair.generate();
  const chain = fakeChain();
  const r = relay({ chain, faucetKey, pool: { entries: 2 } });
  const w = Keypair.generate().publicKey.toBase58();
  const v = (await call(r.public, 'GET', `/f/prize?wallet=${w}`)).json;
  assert.deepEqual([v.testAssetsOnly, v.fee, v.opsBps, v.prizeBps, v.entries, v.collected, v.prize, v.ops, v.state, v.winners, v.area],
    [true, '25000000', 2000, 8000, 2, '50000000', '40000000', '10000000', 'open', null, null]);
  assert.deepEqual(v.wallet, { address: w, tokenAccount: ata(w, MINT), balance: '0', faction: null, entry: null });
  const f = await call(r.public, 'POST', '/f/faucet', { body: { wallet: w }, ip: '203.0.113.9' });
  assert.deepEqual([f.status, f.json.already, f.json.amount, f.json.tokenAccount], [200, false, '100000000', ata(w, MINT)]);
  const sent = chain.sent[0];
  assert.ok(sent.signers.includes(faucetKey.publicKey.toBase58()) && r.payers.has(sent.signers[0]));
  assert.equal(sent.instructions.at(-1).data[0], 7, 'MintTo');
  const again = await call(r.public, 'POST', '/f/faucet', { body: { wallet: w }, ip: '203.0.113.9' });
  assert.deepEqual([again.json.already, again.json.amount, chain.sent.length], [true, '0', 1]);
  assert.equal((await call(r.public, 'POST', '/f/faucet', { body: { wallet: 'x' }, ip: '203.0.113.9' })).status, 400);
  const none = relay({ pool: {} });
  assert.equal((await call(none.public, 'POST', '/f/faucet', { body: { wallet: w } })).json.code, 'NoFaucet');
  assert.equal((await call(r.public, 'GET', '/f/prize/ledger')).json.code, 'LedgerNotPublished');
});

test('POST /f/prize/claim sponsors exactly one Claim of the signing wallet for this season\'s pool', async () => {
  const w = Keypair.generate();
  const wallet = w.publicKey.toBase58();
  const chain = fakeChain();
  const r = relay({ chain });
  chain.set(entryAddress(PRIZE_PROGRAM, PRIZE.pool, wallet), { data: entryData(wallet, { claimed: true }) });
  const fp = (await call(r.public, 'GET', '/f/relay')).json.feePayer;
  const tx = (ix, ...keys) => toBase64(signedBy(compileMessage({ feePayer: fp, recentBlockhash: BLOCKHASH, instructions: [ix] }), ...keys));
  const good = claimIx({ prize: PRIZE, wallet, citizen: A.citizen(wallet), nation: 2, points: 10n, proof: [new Uint8Array(32)] });
  const claim = body => call(r.public, 'POST', '/f/prize/claim', { body, ip: '203.0.113.9' });
  assert.equal((await claim({ tx: tx({ ...good, keys: good.keys.map((k, i) => (i === 5 ? { ...k, pubkey: Keypair.generate().publicKey.toBase58() } : k)) }, w) })).json.code, 'RelayRejected');
  assert.equal((await claim({ tx: tx(payIx({ prize: PRIZE, wallet, payer: fp }), w) })).json.code, 'RelayRejected');
  assert.equal((await claim({ tx: tx(good) })).json.code, 'BadSignature');
  assert.equal(chain.sent.length, 0);
  const ok = await claim({ tx: tx(good, w) });
  assert.deepEqual([ok.status, ok.json.ok, chain.sent.length], [200, true, 1]);
});
