// The season's prize pool on the relay (permutation-prize; local test
// tokens only — nothing here has value):
//
//   GET  /f/prize [?wallet=]   the pool read from the chain: fee, 80/20 split, collected, prize, state, area and
//                              winners after the tally; with `wallet`: its token balance, Entry and Citizen
//   GET  /f/prize/ledger       the published contribution ledger (scripts/prize-settle.mjs), or 404
//   POST /f/faucet {wallet}    test tokens for a wallet, once (localnet only; the relay holds the test mint's authority)
//   POST /f/x402/join {wallet, faction}
//        no X-PAYMENT → 402 + PaymentRequirements (scheme "exact": the entry fee, the vault, the test mint)
//        X-PAYMENT    → the wallet-signed transaction. The relay co-signs as fee payer and with the season's join
//                       gate ONLY when the payment is certain:
//                         * atomic: `[budget prefix, Pay, Join]` in one transaction (sdk prize.mjs `classifyPaidJoin`), or
//                         * settled: a plain sponsored Join by a wallet whose Entry already exists on chain.
//                       Then it simulates the exact bytes, sends them, waits for the result and answers
//                       200 + X-PAYMENT-RESPONSE {success, transaction, network, payer}.
//   POST /f/prize/claim {tx}   a wallet-signed Claim (one instruction), the relay as fee payer → {ok, signature}
//
// The relay cannot change the amount or the payee: Pay moves exactly the
// pool's fee into the pool's vault, and the relay only adds signatures.
// Without the gate's signature the game refuses the Join (JoinGate), so a
// wallet that has not paid cannot join. Operator-run AI citizens join
// through POST /f/join with an operator invite; they have no Entry and
// cannot claim.
import { existsSync, readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { encode as base58 } from '../../../client/src/base58.mjs';
import { fromBase64, toHex } from '../../../client/src/bytes.mjs';
import { createAtaIdempotentIx } from '../../../client/src/player.mjs';
import { baseFee, rent } from '../../../client/src/frontier/fees.mjs';
import { profileForSeason } from '../../../client/src/frontier/profile.mjs';
import { ata, claimIx, classifyPaidJoin, decodeEntry, decodePool, decodeTokenAccount, ENTRY_SIZE, entryAddress, paidJoinBudget, POOL_STATE, PRIZE_ERRORS,
  TOKEN_PROGRAM, x402Encode, x402Network } from '../../../client/src/frontier/prize.mjs';
import { classify, JOIN_TAG } from '../../../client/src/frontier/shapes.mjs';
import { compileMessage, parseTransaction, wireTransaction } from '../../../client/src/solana-tx.mjs';
import { signTalk as signEd25519 } from '../../../client/src/talk-node.mjs';
import { signedBy } from '../../cosign.mjs';
import { RouteError } from '../../routes/errors.mjs';
import { simulateWatching } from '../chain.mjs';
import { signAs, sponsor } from './relay.mjs';

const ENTRY_RENT = rent(ENTRY_SIZE);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isKey = s => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };

function requirePrize(ctx) {
  if (!ctx.prize) throw new RouteError(404, 'this season has no prize pool', 'NoPrizePool');
  return ctx.prize;
}

const account = async (ctx, address) => (await ctx.connection.getAccountInfo(new PublicKey(address), 'confirmed'))?.data ?? null;

/** The decoded pool, or 503 while it does not exist. */
async function readPool(ctx) {
  const pool = decodePool(await account(ctx, requirePrize(ctx).pool));
  if (!pool) throw new RouteError(503, 'the prize pool account does not exist (yet)', 'PrizeUnavailable');
  return pool;
}

/** A relay transaction of its own: `ixs(payer)` paid by a pool key, signed by it and `signers`; waits for the result. */
async function sendOwn(ctx, ixs, signers = []) {
  const payer = ctx.pool.draw();
  const { blockhash } = await ctx.blockhashes.latest();
  const message = compileMessage({ feePayer: payer.publicKey.toBase58(), recentBlockhash: blockhash, instructions: ixs(payer.publicKey.toBase58()) });
  const wire = wireTransaction(message, Object.fromEntries([payer, ...signers].map(k => [k.publicKey.toBase58(), signEd25519(message, k)])));
  const signature = await ctx.connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 5 });
  await landed(ctx, signature);
  return signature;
}

/** Waits until `signature` has a result; throws 402-able RouteErrors for a failure, 504 for none in time. */
export async function landed(ctx, signature, { tries = 60, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = (await ctx.connection.getSignatureStatuses([signature]))?.value?.[0] ?? null;
    if (st?.err) throw new RouteError(400, `the transaction failed on chain: ${JSON.stringify(st.err)}`, prizeErrorOf(st.err) ?? 'SettlementFailed', { signature });
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
    await sleep(every);
  }
  throw new RouteError(504, 'the transaction was sent but has no result yet (GET /f/tx/{signature})', 'SettlementPending', { signature });
}

/** permutation-prize's error name in a transaction error (`{InstructionError: [i, {Custom: n}]}`), or null. */
export function prizeErrorOf(err) {
  const c = err?.InstructionError?.[1]?.Custom;
  return typeof c === 'number' ? PRIZE_ERRORS[c] ?? null : null;
}

/** The pool as the routes publish it (amounts as strings; all of them test tokens). */
export function poolView(prize, pool) {
  return {
    testAssetsOnly: true, ...prize, decimals: pool.decimals, operator: pool.operator,
    fee: String(pool.fee), opsBps: pool.opsBps, prizeBps: 10_000 - pool.opsBps, paramsHash: toHex(pool.paramsHash),
    entries: pool.entries, collected: String(pool.collected), prize: String(pool.prize), ops: String(pool.ops), opsWithdrawn: String(pool.opsWithdrawn),
    state: ['open', 'final', 'shares'][pool.state] ?? 'unknown', expectedKeeps: pool.expectedKeeps, counted: pool.counted,
    area: pool.counted ? pool.area : null, territoryBells: pool.counted ? pool.bells.map(String) : null,
    winners: pool.state >= POOL_STATE.FINAL ? pool.winners : null,
    shares: pool.state === POOL_STATE.SHARES ? { mode: pool.mode === 2 ? 'refund' : 'shares', shareNations: pool.shareNations, totalPoints: pool.totalPoints.map(String),
      root: toHex(pool.sharesRoot), ledgerHash: toHex(pool.ledgerHash), claims: pool.claims, claimed: String(pool.claimed) } : null,
  };
}

/** The keeps Finalize counts against: the game's six ProvinceFunds' opened provinces less the 7 keepless ones (null if one is missing). */
async function keepsToCount(ctx) {
  const funds = await Promise.all([0, 1, 2, 3, 4, 5].map(w => account(ctx, ctx.addresses.provinceFund(w))));
  if (funds.some(d => !d || d.length < 24)) return null;
  return Math.max(0, funds.reduce((n, d) => n + Buffer.from(d).readUInt32LE(20), 0) - 7);
}

export const prizeRoutes = {
  'GET /f/prize': async (ctx, req) => {
    const prize = requirePrize(ctx);
    const body = { ...poolView(prize, await readPool(ctx)), keepsToCount: await keepsToCount(ctx) };
    const wallet = req.url.searchParams.get('wallet');
    if (wallet) {
      if (!isKey(wallet)) throw new RouteError(400, 'wallet must be a base58 address', 'BadRequest');
      const tokenAccount = ata(wallet, prize.mint);
      const [token, entry, citizen] = await Promise.all([account(ctx, tokenAccount), account(ctx, entryAddress(prize.program, prize.pool, wallet)), ctx.chain.citizen(ctx.addresses.citizen(wallet))]);
      const e = decodeEntry(entry);
      body.wallet = { address: wallet, tokenAccount, balance: String(decodeTokenAccount(token).amount), faction: citizen ? citizen.FACTION : null,
        entry: e ? { paid: String(e.amount), claimed: e.claimed, claimAmount: String(e.claimAmount) } : null };
    }
    return { body };
  },

  'GET /f/prize/ledger': async ctx => {
    requirePrize(ctx);
    const file = ctx.cfg.prizeLedgerFile;
    if (!file || !existsSync(file)) throw new RouteError(404, 'the contribution ledger is not published yet', 'LedgerNotPublished');
    return { body: JSON.parse(readFileSync(file, 'utf8')) };
  },

  'POST /f/faucet': async (ctx, req) => {
    const prize = requirePrize(ctx);
    if (!ctx.faucetKey || ctx.cfg.cluster !== 'localnet') throw new RouteError(404, 'the test-token faucet exists on the local test chain only', 'NoFaucet');
    const { wallet } = await req.json();
    if (!isKey(wallet)) throw new RouteError(400, 'wallet must be a base58 address', 'BadRequest');
    const state = ctx.store.state;
    state.faucet ??= {};
    ctx.faucetSending ??= new Map();
    const tokenAccount = ata(wallet, prize.mint);
    const done = state.faucet[wallet];
    if (done) return { body: { ok: true, already: true, amount: '0', tokenAccount, signature: done.signature, testAssetsOnly: true } };
    if (ctx.faucetSending.has(wallet)) throw new RouteError(409, 'a grant for this wallet is being sent', 'FaucetInFlight');
    const amount = BigInt(ctx.cfg.faucetAmount);
    const data = new Uint8Array(9);
    data[0] = 7; // SPL Token MintTo
    new DataView(data.buffer).setBigUint64(1, amount, true);
    const run = sendOwn(ctx, payer => [
      createAtaIdempotentIx({ payer, owner: wallet, mint: prize.mint }),
      { programId: TOKEN_PROGRAM, data, keys: [{ pubkey: prize.mint, isSigner: false, isWritable: true }, { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: ctx.faucetKey.publicKey.toBase58(), isSigner: true, isWritable: false }] },
    ], [ctx.faucetKey]);
    ctx.faucetSending.set(wallet, run);
    try {
      const signature = await run;
      state.faucet[wallet] = { amount: String(amount), signature, at: ctx.now() };
      ctx.store.save();
      ctx.log?.(`f/faucet ${wallet} +${amount} test tokens (${signature})`);
      return { body: { ok: true, already: false, amount: String(amount), tokenAccount, signature, testAssetsOnly: true } };
    } finally {
      ctx.faucetSending.delete(wallet);
    }
  },

  'POST /f/x402/join': async (ctx, req) => {
    const prize = requirePrize(ctx);
    await req.json().catch(() => ({}));
    const [pool, season] = [await readPool(ctx), await ctx.chain.season()];
    const profile = profileForSeason(season);
    const gated = season.JOIN_GATE.some(x => x !== 0);
    const gate = gated ? base58(season.JOIN_GATE) : null;
    if (gated && (!ctx.gateKey || ctx.gateKey.publicKey.toBase58() !== gate)) throw new RouteError(503, 'this relay does not hold the season\'s join-gate key', 'GateUnavailable');
    const { blockhash, lastValidBlockHeight } = await ctx.blockhashes.latest();
    const network = x402Network(ctx.cfg.cluster);
    const requirements = {
      scheme: 'exact', network, maxAmountRequired: String(pool.fee), resource: '/f/x402/join',
      description: `Entry to Wylls season ${ctx.addresses.seasonId} (test tokens on the local test chain; ${10_000 - pool.opsBps} of 10,000 parts go to the prize pool)`,
      mimeType: 'application/json', payTo: prize.vault, maxTimeoutSeconds: 60, asset: prize.mint,
      extra: {
        testAssetsOnly: true, feePayer: ctx.pool.draw().publicKey.toBase58(), recentBlockhash: blockhash, lastValidBlockHeight,
        programId: ctx.programId, seasonId: ctx.addresses.seasonId.toString(), season: ctx.addresses.season, profile, joinGate: gate,
        prizeProgram: prize.program, pool: prize.pool, decimals: pool.decimals, opsBps: pool.opsBps, instruction: 'Pay+Join', budget: paidJoinBudget(profile),
        entries: pool.entries, prize: String(pool.prize),
      },
    };
    const refuse402 = (error, code, extra = {}) => ({ status: 402, body: { x402Version: 1, error, code, ...extra, accepts: [requirements] } });
    const header = req.headers['x-payment'];
    if (!header) return refuse402('X-PAYMENT header is required', 'PaymentRequired');
    if (pool.state !== POOL_STATE.OPEN || pool.counted) throw new RouteError(409, 'the season\'s pool takes no more entries', 'EntriesClosed');
    let payment;
    let tx;
    let wire;
    try {
      payment = JSON.parse(new TextDecoder().decode(fromBase64(String(header))));
      wire = fromBase64(String(payment?.payload?.transaction ?? ''));
      tx = parseTransaction(wire);
    } catch {
      throw new RouteError(400, 'X-PAYMENT must be base64 JSON whose payload.transaction is a base64 legacy transaction', 'InvalidPayment', { x402Version: 1 });
    }
    if (payment.scheme !== 'exact' || payment.network !== network) return refuse402('invalid payment: scheme/network', 'InvalidPayment');
    // Atomic (Pay and Join in one transaction), or a plain Join of a wallet that has paid already.
    let shape;
    let mode;
    let extraAllowance = 0n;
    const paid = classifyPaidJoin(tx, { programId: ctx.programId, prize, profile });
    if (paid.ok) {
      [shape, mode, extraAllowance] = [paid.join, 'atomic', ENTRY_RENT];
    } else {
      const plain = classify(tx, { programId: ctx.programId, wireBytes: wire.length, profile });
      if (!plain.ok || plain.tag !== JOIN_TAG) return refuse402(`invalid payment: ${paid.problem}`, 'InvalidPayment');
      const entry = decodeEntry(await account(ctx, entryAddress(prize.program, prize.pool, plain.authority)));
      if (!entry || entry.wallet !== plain.authority || entry.pool !== prize.pool || entry.amount < pool.fee) {
        return refuse402('the Join carries no payment and this wallet has no confirmed entry in the pool', 'PaymentRequired');
      }
      [shape, mode] = [plain, 'settled'];
    }
    if ((shape.accounts.join_gate ?? null) !== gate) return refuse402('invalid payment: the Join must name the season\'s join gate as its last account', 'InvalidPayment');
    if (!signedBy(tx, shape.authority)) return refuse402('invalid payment: the wallet\'s signature is missing or invalid', 'InvalidPayment');
    let sent;
    try {
      sent = await sponsor(ctx, req, { tx, wire, shape, extraSigners: gated ? [ctx.gateKey] : [], limitKind: 'join', lastValidBlockHeight: payment.payload.lastValidBlockHeight, extraAllowance });
      await landed(ctx, sent.signature);
    } catch (e) {
      // What the simulation or the chain refused is a payment that did not settle: 402 with the reason.
      if (e instanceof RouteError && e.status === 400) {
        const logs = e.extra?.logs ?? [];
        const code = logs.some(l => /insufficient funds|custom program error: 0x1\b/i.test(l)) && logs.some(l => l.includes(TOKEN_PROGRAM)) ? 'InsufficientFunds'
          : PRIZE_ERRORS[Number(/custom program error: (0x1[0-9a-f]{2})\b/i.exec(logs.join('\n'))?.[1])] ?? e.code;
        return refuse402(`payment refused: ${e.message}`, code, { logs: logs.slice(-6), signature: e.extra?.signature });
      }
      throw e;
    }
    const after = await readPool(ctx);
    ctx.log?.(`f/x402 join ${shape.authority} (${mode}) ${sent.signature}: pool ${after.prize} prize, ${after.ops} ops, ${after.entries} entries`);
    return {
      headers: { 'X-PAYMENT-RESPONSE': x402Encode({ success: true, transaction: sent.signature, network, payer: shape.authority }) },
      body: { ok: true, signature: sent.signature, mode, wallet: shape.authority, faction: shape.data.faction, citizen: shape.accounts.citizen,
        paid: mode === 'atomic' ? String(pool.fee) : '0', pool: { entries: after.entries, collected: String(after.collected), prize: String(after.prize), ops: String(after.ops) }, testAssetsOnly: true },
    };
  },

  'POST /f/prize/claim': async (ctx, req) => {
    const prize = requirePrize(ctx);
    const b = await req.json();
    let tx;
    try { tx = parseTransaction(fromBase64(String(b.tx ?? ''))); } catch { throw new RouteError(400, 'tx must be a base64 serialized legacy transaction', 'InvalidTransaction'); }
    const bad = problem => new RouteError(400, `relay refused: ${problem}`, 'RelayRejected');
    const ix = tx.instructions.length === 1 ? tx.instructions[0] : null;
    if (!ix || ix.programId !== prize.program || ix.data[0] !== 5) throw bad('exactly one instruction: the prize program\'s Claim');
    const [feePayer, wallet] = [tx.signers[0], ix.keys[0]?.pubkey];
    if (!ctx.pool.has(feePayer)) throw bad('the fee payer is not one of this relay\'s (GET /f/relay names one)');
    if (tx.signers.length !== 2 || tx.signers[1] !== wallet) throw bad('the fee payer and the wallet sign, nobody else');
    const want = claimIx({ prize, wallet, citizen: ctx.addresses.citizen(wallet) });
    if (ix.keys.length !== want.keys.length || want.keys.some((k, i) => k.pubkey !== ix.keys[i].pubkey)) throw bad('Claim must name this season\'s pool, the wallet\'s entry, citizen and token account');
    if (tx.accountKeys.length !== new Set([feePayer, prize.program, ...want.keys.map(k => k.pubkey)]).size) throw bad('the message names account keys the Claim does not use');
    if (!signedBy(tx, wallet)) throw new RouteError(400, 'the wallet\'s signature is missing or invalid', 'BadSignature');
    ctx.limiter.check(`f-claim:${wallet}`, { burst: 3, perSecond: 0.05 }, 'claims for this wallet');
    const signed = signAs(tx, [ctx.pool.keypair(feePayer)]);
    const before = BigInt(await ctx.connection.getBalance(new PublicKey(feePayer), 'confirmed'));
    let sim;
    try {
      sim = await simulateWatching(ctx.connection, signed, [feePayer], ctx.programId);
    } catch (e) {
      const code = PRIZE_ERRORS[Number(/custom program error: (0x1[0-9a-f]{2})\b/i.exec((e.extra?.logs ?? []).join('\n'))?.[1])];
      if (e instanceof RouteError && code) throw new RouteError(code === 'AlreadyClaimed' ? 409 : 400, `the claim would fail: ${code}`, code, e.extra);
      throw e;
    }
    if (sim.post[0] === null || before - sim.post[0] > baseFee(2)) throw bad('the fee payer would lose more than the fee');
    const signature = await ctx.connection.sendRawTransaction(signed, { skipPreflight: true, maxRetries: 5 });
    await landed(ctx, signature);
    const entry = decodeEntry(await account(ctx, entryAddress(prize.program, prize.pool, wallet)));
    ctx.log?.(`f/prize claim ${wallet} ${signature}: ${entry?.claimAmount ?? '?'} test tokens`);
    return { body: { ok: true, signature, amount: String(entry?.claimAmount ?? 0n), testAssetsOnly: true } };
  },
};
