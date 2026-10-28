// The Wylls prize pool (permutation-prize; local test tokens only), for the
// relay, the settle tooling, agents and the web client:
//
//   addresses   the pool PDA of (game program, season), its vault, a wallet's Entry
//   decoding    Pool, Entry, an SPL token account's amount
//   building    Pay, Tally, Finalize, SetShares, Claim, WithdrawOps; the paid Join
//               (one atomic transaction: budget prefix, Pay, the game's Join)
//   shares      the merkle tree over (wallet, nation, points) the program checks
//   x402        `joinViaX402`: one request, a 402 with the price, the paid retry
//
// Layouts and tags are permutation-prize/src/lib.rs's (`tag`, `pool`,
// `entry`); test/frontier-prize.test.mjs checks the hashes against vectors
// computed by that crate.
import { decode as fromBase58, encode as toBase58 } from '../base58.mjs';
import { concat, fromBase64, toBase64, u64le, utf8 } from '../bytes.mjs';
import { ata, TOKEN_PROGRAM } from '../player.mjs';
import { sha256 } from '../sha256.mjs';
import { compileMessage, findProgramAddress, parseTransaction, pubkeyBytes, wireTransaction } from '../solana-tx.mjs';
import { SYSTEM_PROGRAM } from './addresses.mjs';
import { budgetOf, budgetPrefix, parseComputeBudgetIx, setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit } from './budgets.mjs';
import { classify, frontierIx, JOIN_TAG } from './shapes.mjs';

export { ata, TOKEN_PROGRAM };

export const PRIZE_TAG = Object.freeze({ INIT_POOL: 0, PAY: 1, TALLY: 2, FINALIZE: 3, SET_SHARES: 4, CLAIM: 5, WITHDRAW_OPS: 6 });
export const POOL_SIZE = 640;
export const ENTRY_SIZE = 128;
export const POOL_STATE = Object.freeze({ OPEN: 0, FINAL: 1, SHARES: 2 });
export const SHARE_MODE = Object.freeze({ SHARES: 1, REFUND: 2 });
export const FACTIONS = 6;
/** permutation-prize's errors (`Custom(code)`). */
export const PRIZE_ERRORS = Object.freeze({ 0x100: 'BadData', 0x101: 'BadAccount', 0x102: 'BadParams', 0x103: 'NotOperator', 0x104: 'WrongState', 0x105: 'AlreadyPaid',
  0x106: 'SeasonNotEnded', 0x107: 'ProvinceNotFinal', 0x108: 'NoKeep', 0x109: 'TallyIncomplete', 0x10A: 'BadShares', 0x10B: 'BadProof', 0x10C: 'NotWinner',
  0x10D: 'AlreadyClaimed', 0x10E: 'NothingToPay', 0x10F: 'Overflow', 0x110: 'WrongExpectedCount', 0x111: 'TooLate' });
/** What Pay adds to a Join's compute-unit and loaded-data limits (the prize and token programs, five more accounts). */
export const PAID_JOIN_EXTRA_CU = 80_000;
export const PAID_JOIN_EXTRA_LOADED = 524_288;
/** The x402 network name of a cluster. */
export const x402Network = cluster => (cluster === 'devnet' ? 'solana-devnet' : cluster === 'mainnet' ? 'solana' : 'solana-localnet');

const W = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const R = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const rdU64 = (d, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
const rdU = (d, o, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + d[o + i]; return v; };
const key = (d, o) => toBase58(d.subarray(o, o + 32));
const magic = (d, text) => utf8(text).every((b, i) => d[i] === b);

// ------------------------------------------------------------------ addresses

export const poolAddress = (prizeProgram, gameProgram, seasonId) => findProgramAddress([utf8('pool'), pubkeyBytes(gameProgram), u64le(seasonId)], prizeProgram)[0];
export const vaultAddress = (prizeProgram, pool) => findProgramAddress([utf8('vault'), pubkeyBytes(pool)], prizeProgram)[0];
export const entryAddress = (prizeProgram, pool, wallet) => findProgramAddress([utf8('entry'), pubkeyBytes(pool), pubkeyBytes(wallet)], prizeProgram)[0];

/** Everything a client needs to name a season's pool: `{program, pool, vault, mint}` (base58). */
export function prizeAddresses({ prizeProgram, gameProgram, seasonId, mint }) {
  const pool = poolAddress(prizeProgram, gameProgram, seasonId);
  return { program: prizeProgram, pool, vault: vaultAddress(prizeProgram, pool), mint };
}

// ------------------------------------------------------------------ decoding

/** A Pool account's data, decoded (amounts bigint, keys base58), or null if it is not one. */
export function decodePool(data) {
  const d = Uint8Array.from(data ?? []);
  if (d.length !== POOL_SIZE || !magic(d, 'WYPRPOOL')) return null;
  const six = (o, n) => Array.from({ length: FACTIONS }, (_, f) => (n === 8 ? rdU64(d, o + 8 * f) : rdU(d, o + n * f, n)));
  const winnersMask = d[12];
  return {
    state: d[10], decimals: d[11], winnersMask, winners: [...Array(FACTIONS).keys()].filter(f => winnersMask & (1 << f)), mode: d[13], shareNations: d[14],
    seasonId: rdU64(d, 16), gameProgram: key(d, 24), season: key(d, 56), operator: key(d, 88), mint: key(d, 120), vault: key(d, 152),
    fee: rdU64(d, 184), opsBps: rdU(d, 192, 2), expectedKeeps: rdU(d, 194, 2), counted: rdU(d, 196, 2), paramsHash: d.slice(200, 232),
    entries: rdU(d, 232, 4), claims: rdU(d, 236, 4), collected: rdU64(d, 240), prize: rdU64(d, 248), ops: rdU64(d, 256), opsWithdrawn: rdU64(d, 264),
    claimed: rdU64(d, 272), area: six(280, 2), bells: six(296, 8), totalPoints: six(344, 8), sharesRoot: d.slice(392, 424), ledgerHash: d.slice(424, 456),
    endBell: rdU(d, 456, 4),
  };
}

/** An Entry account's data, decoded, or null. */
export function decodeEntry(data) {
  const d = Uint8Array.from(data ?? []);
  if (d.length !== ENTRY_SIZE || !magic(d, 'WYPRENTR')) return null;
  return { claimed: d[9] !== 0, pool: key(d, 16), wallet: key(d, 48), amount: rdU64(d, 80), paidSlot: rdU64(d, 88), claimAmount: rdU64(d, 96) };
}

/** The amount of an SPL token account (0n for an absent or foreign account), and its mint and owner. */
export function decodeTokenAccount(data) {
  const d = Uint8Array.from(data ?? []);
  if (d.length < 72) return { amount: 0n, mint: null, owner: null };
  return { amount: rdU64(d, 64), mint: key(d, 0), owner: key(d, 32) };
}

/** `fee × opsBps / 10,000` rounded down: the operator's part; the prize takes the rest. */
export const opsPart = (fee, opsBps) => BigInt(fee) * BigInt(opsBps) / 10_000n;

/** A claim's amount, as the program computes it (null when it would refuse). */
export function claimAmount(pool, { points = 0n, nation = 0, paid = 0n }) {
  if (pool.mode === SHARE_MODE.REFUND) return pool.collected > 0n && paid <= pool.collected ? pool.prize * BigInt(paid) / pool.collected : null;
  const total = pool.totalPoints[nation] ?? 0n;
  if (!pool.shareNations || total === 0n || BigInt(points) > total) return null;
  return (pool.prize / BigInt(pool.shareNations)) * BigInt(points) / total;
}

// ------------------------------------------------------------------ shares

export const leafHash = (pool, wallet, nation, points) => sha256([0], pubkeyBytes(pool), pubkeyBytes(wallet), [nation], u64le(points));
const less = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i]; return true; };
export const nodeHash = (a, b) => (less(a, b) ? sha256([1], a, b) : sha256([1], b, a));

/**
 * The merkle tree over `leaves` (32-byte hashes, any order; sorted here so
 * the root does not depend on it): `{root, proof(leaf) → [sibling…]}`. An
 * odd node is carried up unchanged; no leaves: the zero root.
 */
export function merkleTree(leaves) {
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const sorted = leaves.map(l => Uint8Array.from(l)).sort((a, b) => (hex(a) < hex(b) ? -1 : 1));
  const levels = [sorted];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1);
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return {
    root: sorted.length ? levels.at(-1)[0] : new Uint8Array(32),
    proof(leaf) {
      let i = sorted.findIndex(l => hex(l) === hex(leaf));
      if (i < 0) return null;
      const out = [];
      for (const level of levels.slice(0, -1)) {
        const sib = i ^ 1;
        if (sib < level.length) out.push(level[sib]);
        i >>= 1;
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------ instructions

/** Pay: the wallet's fee into the vault and its Entry (`payer` pays the Entry's rent). */
export function payIx({ prize, wallet, payer, walletToken = null }) {
  return { programId: prize.program, data: Uint8Array.of(PRIZE_TAG.PAY), keys: [R(wallet, true), W(payer, true), W(prize.pool), W(entryAddress(prize.program, prize.pool, wallet)),
    W(walletToken ?? ata(wallet, prize.mint)), W(prize.vault), R(prize.mint), R(TOKEN_PROGRAM), R(SYSTEM_PROGRAM)] };
}

/** Tally: count `provinces` (Province account addresses) once each. */
export const tallyIx = ({ prize, season, provinces }) => ({ programId: prize.program, data: Uint8Array.of(PRIZE_TAG.TALLY), keys: [W(prize.pool), R(season), ...provinces.map(p => R(p))] });

/** Finalize: `season` and the game's six ProvinceFunds, wedges 0–5 in order (their opened provinces give the keeps to count). Before `end + 72 h`. */
export const finalizeIx = ({ prize, season, provinceFunds }) => {
  if (provinceFunds?.length !== 6) throw new Error('finalizeIx: the six ProvinceFunds, wedges 0–5');
  return { programId: prize.program, data: Uint8Array.of(PRIZE_TAG.FINALIZE), keys: [W(prize.pool), R(season), ...provinceFunds.map(f => R(f))] };
};

/** SetShares (the operator, once, after Finalize): `totals` per nation, the merkle root, the ledger file's sha256. */
export function setSharesIx({ prize, operator, mode, totals, root, ledgerHash }) {
  if (totals.length !== FACTIONS || root.length !== 32 || ledgerHash.length !== 32) throw new Error('SetShares: six totals, a 32-byte root and a 32-byte ledger hash');
  return { programId: prize.program, data: concat([PRIZE_TAG.SET_SHARES, mode], ...totals.map(u64le), root, ledgerHash), keys: [R(operator, true), W(prize.pool)] };
}

/** Claim: `citizen` is the wallet's Citizen of the game; in refund mode nation, points and proof are ignored. */
export function claimIx({ prize, wallet, citizen, nation = 0, points = 0n, proof = [], dest = null }) {
  return { programId: prize.program, data: concat([PRIZE_TAG.CLAIM, nation], u64le(points), [proof.length], ...proof),
    keys: [R(wallet, true), W(prize.pool), W(entryAddress(prize.program, prize.pool, wallet)), R(citizen), W(prize.vault), W(dest ?? ata(wallet, prize.mint)), R(prize.mint), R(TOKEN_PROGRAM)] };
}

export const withdrawOpsIx = ({ prize, operator, dest = null }) => ({ programId: prize.program, data: Uint8Array.of(PRIZE_TAG.WITHDRAW_OPS),
  keys: [R(operator, true), W(prize.pool), W(prize.vault), W(dest ?? ata(operator, prize.mint)), R(prize.mint), R(TOKEN_PROGRAM)] });

// ------------------------------------------------------------------ the paid Join

/** The compute-budget limits of a paid Join. */
export function paidJoinBudget(profile = 1) {
  const b = budgetOf('Join', profile);
  return { cuLimit: b.cuLimit + PAID_JOIN_EXTRA_CU, loadedLimit: b.loadedLimit + PAID_JOIN_EXTRA_LOADED };
}

/**
 * The message of a paid Join: `[limit, price 0, loaded, Pay, Join]`, fee
 * payer the relay's. `joinAccounts`/`joinFields` are the Join's (shapes.mjs
 * `frontierIx`), with `join_gate` named.
 */
export function paidJoinMessage({ programId, prize, wallet, joinAccounts, joinFields, feePayer, recentBlockhash, profile = 1, walletToken = null }) {
  const b = paidJoinBudget(profile);
  return compileMessage({ feePayer, recentBlockhash, instructions: [
    setComputeUnitLimit(b.cuLimit), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(b.loadedLimit),
    payIx({ prize, wallet, payer: feePayer, walletToken }),
    frontierIx(programId, 'Join', { ...joinAccounts, payer: feePayer }, joinFields, profile),
  ] });
}

const refuse = problem => ({ ok: false, problem });

/**
 * Check a parsed transaction against the paid-Join shape for `prize` and
 * the game `programId`: exactly `[limit, price 0, loaded, Pay, Join]` with
 * the paid-Join limits; Pay for this pool, vault and mint, its payer the
 * fee payer, its wallet the Join's wallet; the Join a valid sponsored Join
 * shape on its own (shapes.mjs `classify`); the signers exactly the fee
 * payer, the wallet and the Join's gate; no key beyond the two
 * instructions'. Returns `{ok: true, wallet, walletToken, join}` (`join`:
 * the Join's classified shape) or `{ok: false, problem}`.
 */
export function classifyPaidJoin(tx, { programId, prize, profile = 1 }) {
  const ixs = tx.instructions;
  if (ixs.length !== 5) return refuse('exactly five instructions: the compute-budget prefix, the prize program\'s Pay and the game\'s Join');
  const cb = ixs.slice(0, 3).map(parseComputeBudgetIx);
  const b = paidJoinBudget(profile);
  if (cb.some(x => !x) || cb[0].kind !== 'limit' || cb[1].kind !== 'price' || cb[2].kind !== 'loaded') return refuse('the prefix must be SetComputeUnitLimit, SetComputeUnitPrice, SetLoadedAccountsDataSizeLimit');
  if (cb[0].value !== b.cuLimit || cb[1].value !== 0n || cb[2].value !== b.loadedLimit) return refuse(`the prefix must be limit ${b.cuLimit}, price 0, loaded data ${b.loadedLimit}`);
  const [pay, join] = [ixs[3], ixs[4]];
  if (pay.programId !== prize.program || pay.data.length !== 1 || pay.data[0] !== PRIZE_TAG.PAY) return refuse('the fourth instruction must be the prize program\'s Pay');
  if (join.programId !== programId || join.data[0] !== JOIN_TAG) return refuse('the fifth instruction must be the game\'s Join');
  const feePayer = tx.signers[0];
  const wallet = pay.keys[0]?.pubkey;
  const want = payIx({ prize, wallet: wallet ?? feePayer, payer: feePayer, walletToken: pay.keys[4]?.pubkey });
  if (pay.keys.length !== want.keys.length) return refuse('Pay takes nine accounts');
  for (let i = 0; i < want.keys.length; i++) {
    const [w, h] = [want.keys[i], pay.keys[i]];
    if (w.pubkey !== h.pubkey) return refuse(`Pay account ${i} is not this season's pool, vault, mint or the wallet's entry`);
    if (w.isSigner && !h.isSigner) return refuse(`Pay account ${i} must sign`);
  }
  if (wallet === feePayer) return refuse('the fee payer never pays the entry fee');
  // The Join alone, as the sponsored Join shape it would be.
  const alone = parseTransaction(wireTransaction(compileMessage({ feePayer, recentBlockhash: tx.recentBlockhash,
    instructions: [...budgetPrefix('Join', { profile }), { programId: join.programId, keys: join.keys, data: join.data }] })));
  const shape = classify(alone, { programId, profile });
  if (!shape.ok) return refuse(`the Join is not a sponsored Join: ${shape.problem}`);
  if (shape.authority !== wallet) return refuse('Pay\'s wallet must be the Join\'s wallet');
  const signers = [feePayer, wallet, ...(shape.accounts.join_gate ? [shape.accounts.join_gate] : [])];
  if (tx.signers.length !== signers.length || signers.some(k => !tx.signers.includes(k))) return refuse('the fee payer, the wallet and the join gate sign, nobody else');
  const used = new Set([feePayer, ...pay.keys.map(k => k.pubkey), ...join.keys.map(k => k.pubkey), pay.programId, join.programId, cb.length ? ixs[0].programId : null]);
  if (tx.accountKeys.some(k => !used.has(k))) return refuse('the message names account keys no instruction uses');
  return { ok: true, wallet, walletToken: pay.keys[4].pubkey, join: { ...shape, signers: tx.signers } };
}

// ------------------------------------------------------------------ x402

const b64json = v => toBase64(utf8(JSON.stringify(v)));
const fromB64json = s => JSON.parse(new TextDecoder().decode(fromBase64(s)));
export { b64json as x402Encode, fromB64json as x402Decode };

/** An error of the x402 join: `code` is the relay's (`InvalidPayment`, `InsufficientFunds`, `AlreadyPaid`…). */
export class X402Error extends Error {
  constructor(code, message, extra = {}) { super(message); Object.assign(this, { code, ...extra }); }
}

/**
 * Join a season by paying its entry fee over HTTP 402 (test tokens on the
 * local test chain): one request, the 402's price, the paid retry.
 *
 *   1. POST {relay}/f/x402/join {wallet, faction} → 402 + `accepts[0]` (scheme "exact": the fee, the vault, the mint)
 *   2. build `[budget prefix, Pay, Join]`, sign it with the wallet (the relay pays the SOL fee and signs the join gate)
 *   3. POST again with X-PAYMENT → 200 + X-PAYMENT-RESPONSE {success, transaction, payer}
 *
 * @param {string} relay    the relay's base URL (the herald's `/gw`, or the relay itself)
 * @param {object} o
 * @param {string} o.wallet            the wallet's address (base58)
 * @param {function} o.sign            async (message bytes) → 64-byte signature, or
 * @param {function} [o.signTransaction] async (wire) → the wire with the wallet's signature (a wallet adapter)
 * @param {number} o.faction           the nation to join
 * @param {Uint8Array} o.session       the session key's 32 bytes
 * @param {bigint} o.sessionExpiry     unix seconds (game time)
 * @param {number} [o.maxFee]          refuse a price above this (base units)
 * @returns {Promise<{ok, signature, requirements, paymentResponse, body}>}
 */
export async function joinViaX402(relay, { wallet, sign, signTransaction, faction, session, sessionExpiry, maxFee = null, fetch: f = (...a) => globalThis.fetch(...a) }) {
  const { FrontierAddresses, joinShardOf } = await import('./addresses.mjs');
  const url = `${String(relay).replace(/\/+$/, '')}/f/x402/join`;
  const post = async headers => {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ wallet, faction }) });
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) };
  };
  const first = await post({});
  if (first.status !== 402) throw new X402Error(first.body.code ?? 'X402Unavailable', first.body.error ?? `the relay answered ${first.status}, not 402`, { status: first.status });
  const req = first.body.accepts?.[0];
  if (!req || req.scheme !== 'exact') throw new X402Error('X402Scheme', 'the relay did not offer the "exact" scheme');
  const x = req.extra;
  if (maxFee !== null && BigInt(req.maxAmountRequired) > BigInt(maxFee)) throw new X402Error('X402TooExpensive', `the entry fee ${req.maxAmountRequired} is above the limit ${maxFee}`);
  // Never sign for another pool, vault or season than the ones derived here.
  const addresses = new FrontierAddresses({ programId: x.programId, seasonId: BigInt(x.seasonId) });
  const prize = prizeAddresses({ prizeProgram: x.prizeProgram, gameProgram: x.programId, seasonId: BigInt(x.seasonId), mint: req.asset });
  if (addresses.season !== x.season || prize.pool !== x.pool || prize.vault !== req.payTo) throw new X402Error('X402Mismatch', 'the payment requirements do not match the season\'s addresses');
  const message = paidJoinMessage({ programId: x.programId, prize, wallet, feePayer: x.feePayer, recentBlockhash: x.recentBlockhash, profile: x.profile,
    joinAccounts: { wallet, season: addresses.season, frontier: addresses.frontier, citizen: addresses.citizen(wallet),
      joinshard: addresses.joinShard(faction, joinShardOf(wallet)), ...(x.joinGate ? { join_gate: x.joinGate } : {}) },
    joinFields: { faction, session, session_expiry: BigInt(sessionExpiry) } });
  const wire = signTransaction ? await signTransaction(wireTransaction(message)) : wireTransaction(message, { [wallet]: await sign(message) });
  const payment = { x402Version: 1, scheme: 'exact', network: req.network, payload: { transaction: toBase64(wire) } };
  const second = await post({ 'X-PAYMENT': b64json(payment) });
  if (second.status !== 200) throw new X402Error(second.body.code ?? 'X402Refused', second.body.error ?? `the relay answered ${second.status}`, { status: second.status, body: second.body });
  const header = second.headers.get?.('x-payment-response');
  return { ok: true, signature: second.body.signature, requirements: req, paymentResponse: header ? fromB64json(header) : null, body: second.body };
}

export { fromBase58 };
