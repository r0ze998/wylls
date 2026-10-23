// Fixtures for the agent wallet tests: the relay over a scripted chain (as
// test/frontier-relay.test.mjs) with the agent wallet attached, token
// accounts, scripted deposit transactions and signed owner commands. No
// network, no files unless a test asks for a keyring directory.
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encode as base58 } from '../client/src/base58.mjs';
import { CLOCK_SYSVAR, FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import { ata, TOKEN_PROGRAM } from '../client/src/frontier/prize.mjs';
import { compileMessage, parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk, verifyTalk } from '../client/src/talk-node.mjs';
import { toBase64 } from '../client/src/bytes.mjs';
import { createAtaIdempotentIx } from '../client/src/player.mjs';
import { transferCheckedIx } from '../src/frontier/agent/custody.mjs';
import { createFrontierApps } from '../src/frontier/app.mjs';
import { BlockhashBook } from '../src/send.mjs';
import { Custody } from '../src/frontier/agent/custody.mjs';
import { attachAgentWallet } from '../src/frontier/agent/gateway.mjs';
import { AgentKeyring } from '../src/frontier/agent/keyring.mjs';
import { signCommand } from '../src/frontier/agent/owner-auth.mjs';
import { InviteBook } from '../src/frontier/invites.mjs';
import { PayerPool } from '../src/frontier/payers.mjs';
import { tokenAccountData } from './gateway-fixtures.mjs';

export { call } from './gateway-fixtures.mjs';

export const PROGRAM = Keypair.generate().publicKey.toBase58();
export const SEASON_ID = 5n;
export const A = new FrontierAddresses({ programId: PROGRAM, seasonId: SEASON_ID });
export const GENESIS = 1_800_000_000;
export const BLOCKHASH = Keypair.generate().publicKey.toBase58();
export const MINT = Keypair.generate().publicKey.toBase58();
export const OPERATOR = 'op-token';
export const VILLAGE = [-3, 7, 11];

export function seasonAccount(over = {}) {
  return encodeAccount('Season', { SEASON_ID, STATUS: 2, GENESIS_TS: BigInt(GENESIS), MARCH_FEE: 10_000n, SEAL_BOND: 20_000n, MIN_REVEAL_PRIORITY_MILLI: 433, REVEAL_CU_LIMIT: 26_000,
    REVEAL_LOADED_LIMIT: 1_048_576, JOIN_GATE: new Uint8Array(32), ...over });
}

export function clockAccount(unix) {
  const b = Buffer.alloc(40);
  b.writeBigUInt64LE(77n, 0);
  b.writeBigInt64LE(BigInt(unix), 32);
  return b;
}

/**
 * A scripted chain: accounts (base58 → {lamports, data}); simulate checks
 * every signature and debits the fee payer; `confirm` (default true)
 * confirms a sent transaction at once; `transactions` answers getTransaction.
 */
export function fakeChain({ debit = () => 0n, fail = () => null, confirm = true } = {}) {
  const c = {
    accounts: new Map(), sent: [], simulated: 0, statuses: new Map(), transactions: new Map(), height: 100, confirm,
    set(key, v) { c.accounts.set(String(key), { lamports: v.lamports ?? 1_000_000_000, data: Buffer.from(v.data ?? []) }); },
    getAccountInfo: async key => c.accounts.get(new PublicKey(key).toBase58()) ?? null,
    getMultipleAccountsInfo: async keys => keys.map(k => c.accounts.get(new PublicKey(k).toBase58()) ?? null),
    getBalance: async key => c.accounts.get(new PublicKey(key).toBase58())?.lamports ?? 0,
    // A fresh blockhash per read (as a live chain): two identical actions are distinct transactions.
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 150 }),
    getBlockHeight: async () => c.height,
    getSlot: async () => 77,
    simulateTransaction: async (vtx, cfg) => {
      c.simulated++;
      const tx = parseTransaction(vtx.serialize());
      assert.equal(cfg.sigVerify, true, 'simulated with signatures');
      for (const [i, s] of tx.signers.entries()) {
        if (!verifyTalk(tx.message, tx.signatures[i], new PublicKey(s).toBytes())) return { value: { err: 'SignatureFailure', logs: [] } };
      }
      const err = fail(tx);
      if (err) return { value: { err, logs: ['Program log: refused'] } };
      const payer = tx.signers[0];
      const post = BigInt(c.accounts.get(payer)?.lamports ?? 0) - 5_000n * BigInt(tx.signers.length) - BigInt(debit(tx));
      return { value: { err: null, logs: [], unitsConsumed: 9_000, accounts: cfg.accounts.addresses.map(a => (a === payer ? { lamports: Number(post), data: ['', 'base64'] } : null)) } };
    },
    sendRawTransaction: async raw => {
      const tx = parseTransaction(new Uint8Array(raw));
      c.sent.push(tx);
      const sig = base58(tx.signatures[0]);
      if (c.confirm) {
        c.statuses.set(sig, { slot: 78, err: null, confirmationStatus: 'finalized' });
        // As a node reports it back (no token balances, as frontier-localnet): the message with compiled instructions.
        const keys = tx.accountKeys;
        c.transactions.set(sig, { meta: { err: null, preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { staticAccountKeys: keys.map(k => new PublicKey(k)), header: tx.header,
          compiledInstructions: tx.instructions.map(ix => ({ programIdIndex: keys.indexOf(ix.programId), accountKeyIndexes: ix.keys.map(k => keys.indexOf(k.pubkey)), data: Uint8Array.from(ix.data) })) } } });
      }
      return sig;
    },
    getSignatureStatuses: async sigs => ({ value: sigs.map(s => c.statuses.get(s) ?? null) }),
    getTransaction: async sig => c.transactions.get(sig) ?? null,
  };
  return c;
}

export const MASTER = Buffer.alloc(32, 7);

/**
 * The relay with the agent wallet attached: `{ctx, public, operator, chain,
 * pool, store, agentStore, gateway, custody, custodyKey}`. `prices`: the
 * gateway's; `withCustody: false` leaves deposits and withdrawals out.
 */
export function relay({ chain = fakeChain(), season = {}, clock = GENESIS + 3_600, poolSize = 150, prices = {}, withCustody = true, keyringDir = null, keyring = null, now = Date.now, log = null, agentState = null, unresolvedReleaseMs = null } = {}) {
  const pool = new PayerPool({ masterSeed: MASTER, n: poolSize, dev: poolSize < 150 });
  for (const k of pool.publicKeys()) chain.set(k, { lamports: 2_000_000_000 });
  chain.set(A.season, { data: seasonAccount(season) });
  chain.set(CLOCK_SYSVAR, { data: clockAccount(clock) });
  const store = { state: {}, save() { store.saves = (store.saves ?? 0) + 1; } };
  const cfg = { cluster: 'localnet', programId: PROGRAM, seasonId: String(SEASON_ID), heraldPeer: '127.0.0.1', heraldUrl: 'http://127.0.0.1:41040', minPoolSol: 1, operatorToken: OPERATOR, prizeMint: MINT };
  const invites = new InviteBook({ secret: Buffer.alloc(32, 3), seasonId: SEASON_ID, store });
  const logs = [];
  const apps = createFrontierApps({ cfg, connection: chain, pool, invites, store, log: m => { logs.push(m); log?.(m); }, now, blockhashes: new BlockhashBook(chain, { ttlMs: 0, now }) });
  const agentStore = { state: agentState ?? {}, saves: 0, save() { agentStore.saves++; agentStore.json = JSON.stringify(agentStore.state); } };
  const custodyKey = Keypair.generate();
  const custody = withCustody ? new Custody({ connection: chain, keypair: custodyKey, mint: MINT, pool, blockhashes: apps.ctx.blockhashes }) : null;
  if (custody) chain.set(custody.account, { data: tokenAccountData({ mint: MINT, owner: custody.authority, amount: 0n }) });
  const gateway = attachAgentWallet(apps.ctx, { store: agentStore, keyring: keyring ?? new AgentKeyring({ dir: keyringDir }), custody, prices, waits: { withdraw: { tries: 3, every: 1 } }, unresolvedReleaseMs, log: m => { logs.push(m); log?.(m); }, now });
  return { ...apps, chain, pool, store, agentStore, gateway, custody, custodyKey, logs, invites };
}

/** A signed owner command `{command, signature}` for `op` by `keypair`. */
export function ownerCommand(keypair, op, { agentId, params = {}, nonce = Keypair.generate().publicKey.toBase58().slice(0, 16), expiresAt = Date.now() + 60_000 } = {}) {
  const command = { op, owner: keypair.publicKey.toBase58(), nonce, expiresAt, params, ...(agentId ? { agentId } : {}) };
  return { command, signature: signCommand(command, keypair) };
}

/** The owner's Citizen account with `session` as its live session key (`expiry` unix seconds). */
export function citizenAccount(owner, { session = null, expiry = GENESIS + 86_400, faction = 2 } = {}) {
  return encodeAccount('Citizen', { SEASON_ID, WALLET: new PublicKey(owner).toBytes(), SESSION: session ? new PublicKey(session).toBytes() : new Uint8Array(32), SESSION_EXPIRY: BigInt(expiry), FACTION: faction });
}

/** Gives the owner's Citizen the agent's key as session key (what the owner's wallet-signed SetSession does on chain). */
export function delegate(r, owner, agentKey, over = {}) {
  r.chain.set(A.citizen(owner), { data: citizenAccount(owner, { session: agentKey, ...over }) });
}

/**
 * A confirmed deposit transaction as getTransaction reports it: `signers`
 * (default the owner) signed; one top-level TransferChecked of `amount` of
 * `mint` from the owner's token account to `dest` (default the custody
 * account) by `authority` (default the owner). `balances` adds the token
 * balance metadata a full validator reports (the custody account gaining
 * `gained`, default `amount`); the local frontier-localnet reports none.
 */
export function depositTx({ owner, custody, amount, gained = amount, signers = [owner], err = null, mint = MINT, authority = owner, dest = custody.account, transfer = true, balances = false }) {
  const ownerAta = ata(owner, MINT);
  const keys = [...new Set([...signers, ownerAta, dest, custody.account, mint, authority, TOKEN_PROGRAM])];
  const idx = k => keys.indexOf(k);
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, BigInt(amount), true);
  data[9] = 6;
  const bal = (i, amt, o) => ({ accountIndex: i, mint: MINT, owner: o, uiTokenAmount: { amount: String(amt) } });
  const meta = { err, preTokenBalances: [], postTokenBalances: [] };
  if (balances) {
    meta.preTokenBalances = [bal(idx(ownerAta), 1_000_000_000n, owner), bal(idx(custody.account), 0n, custody.authority)];
    meta.postTokenBalances = [bal(idx(ownerAta), 1_000_000_000n - BigInt(amount), owner), bal(idx(custody.account), BigInt(gained), custody.authority)];
  }
  return {
    meta,
    transaction: { message: { staticAccountKeys: keys.map(k => new PublicKey(k)), header: { numRequiredSignatures: signers.length },
      compiledInstructions: transfer ? [{ programIdIndex: idx(TOKEN_PROGRAM), accountKeyIndexes: [idx(ownerAta), idx(mint), idx(dest), idx(authority)], data }] : [] } },
  };
}

/** A fresh deposit signature registered on the chain and credited to the agent through the route. */
export async function deposit(r, owner, agentId, amount, over = {}) {
  const sig = base58(Buffer.from(Keypair.generate().secretKey.slice(0, 64)));
  r.chain.transactions.set(sig, depositTx({ owner, custody: r.custody, amount, ...over }));
  const res = await r.gateway.deposit(agentId, sig);
  return { sig, res };
}

export const policy = (allowed = ['economy'], total = '1000000', perDay = '1000000') => ({ allowed, budget: { total, perDay } });

/** Creates an agent for `owner` through the route; returns `{agentId, agentKey, capability, res}`. */
export async function createAgent(r, owner, { village = VILLAGE, policy: p = policy(), ip = '127.0.0.1' } = {}) {
  const { call } = await import('./gateway-fixtures.mjs');
  const res = await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'create', { params: { village, policy: p } }), ip });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { agentId: res.json.agent.agentId, agentKey: res.json.agent.agentKey, capability: res.json.capability.token, res };
}

export const actionRequest = (agentId, { name = 'Harvest', fields = {}, holding = VILLAGE, key = Keypair.generate().publicKey.toBase58().slice(0, 20), policyVersion = 1, modeEpoch, source = 'mcp' } = {}) => ({
  agentId, source, idempotencyKey: key, policyVersion, ...(modeEpoch !== undefined ? { modeEpoch } : {}), action: { name, holding, fields },
});

export const sound = r => assert.deepEqual(r.gateway.ledger.check(), [], 'the books balance');

/** A sponsored deposit transaction (base64 wire) signed by the owner's keypair: `[createAta?, TransferChecked]` paid by `feePayer`. */
export function sponsoredDeposit(r, ownerKeypair, amount, { feePayer, createAta = true, blockhash = Keypair.generate().publicKey.toBase58(), tamper = x => x } = {}) {
  const owner = ownerKeypair.publicKey.toBase58();
  const ixs = tamper([
    ...(createAta ? [createAtaIdempotentIx({ payer: feePayer, owner: r.custody.authority, mint: MINT })] : []),
    transferCheckedIx({ source: ata(owner, MINT), mint: MINT, dest: r.custody.account, authority: owner, amount, decimals: 6 }),
  ]);
  const message = compileMessage({ feePayer, recentBlockhash: blockhash, instructions: ixs });
  return { message, wire: toBase64(wireTransaction(message, { [owner]: signTalk(message, ownerKeypair) })) };
}
