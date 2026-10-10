// The season's prize pool on the page (permutation-prize; テストUSDC on the
// local test chain, no value): what the relay reads from the chain
// (GET /f/prize), the test-token faucet, the paid Join over x402
// (sdk prize.mjs `joinViaX402`: one request, the 402's price, the paid
// retry signed by the wallet), the published achievements ledger and the
// ESTIMATED split. A season without a pool answers 404 NoPrizePool: the
// page then says nothing about prizes that is not true.
import * as io from './fchainio.mjs';
import { joinViaX402 } from '../sdk/frontier/prize.mjs';

/** Base units → a number string with up to `decimals` fraction digits ("25", "7.5"). */
export function tokenUnits(v, decimals = 6) {
  const x = BigInt(v ?? 0);
  const s = String(x < 0n ? -x : x).padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${x < 0n ? '-' : ''}${s.slice(0, -decimals)}${frac ? `.${frac}` : ''}`;
}

/** GET /f/prize[?wallet]: `{ok, pool}` with the pool view, `{ok: true, pool: null}` for a season without one. */
export async function loadPrize(wallet = null, opts) {
  const r = await io.request('GET', `/f/prize${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''}`, opts);
  if (!r.ok) return r.code === 'NoPrizePool' || r.httpStatus === 404 ? { ok: true, pool: null } : r;
  return { ok: true, pool: r };
}

/** POST /f/faucet: test tokens for `wallet`, once. */
export const faucet = (wallet, opts) => io.request('POST', '/f/faucet', { ...opts, body: { wallet } });

/** GET /f/prize/ledger: the published ledger, or `{ok: true, ledger: null}` before it is published. */
export async function loadLedger(opts) {
  const r = await io.request('GET', '/f/prize/ledger', opts);
  if (!r.ok) return r.code === 'LedgerNotPublished' || r.httpStatus === 404 ? { ok: true, ledger: null } : r;
  return { ok: true, ledger: r };
}

/**
 * The paid Join: `wallet` is the connected wallet (`{address,
 * signTransaction}`), `session` the in-game key. Returns `{ok, signature}`
 * or a failure `{ok: false, code, error}` (the relay's 402 reason:
 * InsufficientFunds, AlreadyPaid, InvalidPayment…).
 */
export async function payAndJoin({ wallet, faction, session, sessionExpiry, maxFee, fetch: f }) {
  try {
    const r = await joinViaX402(io.relay(), { wallet: wallet.address, signTransaction: w => wallet.signTransaction(w), faction, session: session.publicKeyBytes, sessionExpiry, maxFee, ...(f ? { fetch: f } : {}) });
    return { ok: true, signature: r.signature, paymentResponse: r.paymentResponse, paid: r.body?.paid ?? null, pool: r.body?.pool ?? null };
  } catch (e) {
    return io.fail(e?.code ?? 'X402Failed', String(e?.message ?? e), { httpStatus: e?.status ?? 0 });
  }
}

/**
 * The page's model of the pool: amounts in whole test USDC as strings, the
 * split, and after the end the area, the winners and whether the result is
 * final (the chain's, never the page's own count).
 */
export function prizeModel(pool) {
  if (!pool) return null;
  const d = pool.decimals ?? 6;
  const u = v => tokenUnits(v, d);
  return {
    fee: u(pool.fee), prizePct: pool.prizeBps / 100, opsPct: pool.opsBps / 100, entries: pool.entries,
    collected: u(pool.collected), prize: u(pool.prize), ops: u(pool.ops),
    feeToPrize: u(BigInt(pool.fee) - BigInt(pool.fee) * BigInt(pool.opsBps) / 10_000n), feeToOps: u(BigInt(pool.fee) * BigInt(pool.opsBps) / 10_000n),
    state: pool.state, counting: pool.state === 'open' && pool.counted > 0, final: pool.state !== 'open',
    counted: pool.counted, expectedKeeps: pool.expectedKeeps,
    area: pool.area ? pool.area.map((provinces, faction) => ({ faction, provinces, winner: !!pool.winners?.includes(faction) })) : null,
    winners: pool.winners ?? null,
    wallet: pool.wallet ? { address: pool.wallet.address, balance: u(pool.wallet.balance), paid: !!pool.wallet.entry, canPay: BigInt(pool.wallet.balance) >= BigInt(pool.fee),
      faction: pool.wallet.faction, claimed: !!pool.wallet.entry?.claimed, claimAmount: pool.wallet.entry ? u(pool.wallet.entry.claimAmount) : null } : null,
  };
}

/**
 * The ledger for the page: every line with its kind, player, province,
 * quantity, bell and first signature; the kinds that cannot be derived, with
 * the missing record; the ESTIMATED split (never a transfer).
 */
export function ledgerModel(ledger, { wallet = null, decimals = 6 } = {}) {
  if (!ledger) return null;
  const lines = (ledger.lines ?? []).map(l => ({ kind: l.kind, wallet: l.wallet, nation: l.nation, p: l.province.p, q: l.province.q, quantity: l.quantity, unit: l.unit, bell: l.bell,
    points: l.points ?? 0, eligible: !!l.eligible, signature: l.signatures?.[0] ?? null, mine: !!wallet && l.wallet === wallet }));
  return {
    provisional: ledger.provisional !== false, provisionalRules: ledger.provisionalRules ?? [],
    attackers: lines.filter(l => l.kind === 'capture'), supporters: lines.filter(l => l.kind === 'reinforcement'),
    notDerivable: Object.entries(ledger.kinds ?? {}).filter(([, k]) => !k.derivable).map(([kind, k]) => ({ kind, reason: k.reason, missingRecord: k.missingRecord })),
    estimate: (ledger.estimate?.split ?? []).map(s => ({ wallet: s.wallet, nation: s.nation, points: s.points, amount: tokenUnits(s.amount, decimals), mine: !!wallet && s.wallet === wallet })),
    mode: ledger.shares?.mode ?? null,
  };
}
