// The money of a prize pool as accounts, read from the chain at any time
// (permutation-prize; test tokens only). Nothing here asks whether the game's
// Season has ended: the pool's deposits, the operator's part, the claims and
// the vault are reconciled in every pool state, and each payer's position
// says what exit the program offers it now (or that it offers none yet).
//
//   collected = Σ Entry.amount              (Pay writes both)
//   collected = prize + ops                 (80/20, ops rounded down)
//   claimed   = Σ Entry.claimAmount (claimed Entries), claims = their count
//   vault     = collected − claimed − opsWithdrawn  (+ anything sent to the vault from outside: `surplus`)
//
// Exits, as the program has them (lib.rs): a fee leaves the vault only by
// Claim (state shares) or WithdrawOps (state final or shares). Final needs
// Finalize, which needs the game's Season Ended; there is no other way out.
import { POOL_STATE, SHARE_MODE, claimAmount } from '../../client/src/frontier/prize.mjs';

const STATE = ['open', 'final', 'shares'];

/**
 * `pool` (decodePool), `vault` (the vault's token amount), `entries`
 * (decodeEntry of every Entry of this pool), optional `shares` (the posted
 * ledger's `shares.members`: wallet, nation, points) for the amounts in
 * shares mode. Returns `{state, totals, checks, positions, ok}`.
 */
export function poolAccounts({ pool, vault, entries, shares = null }) {
  const sum = xs => xs.reduce((a, b) => a + b, 0n);
  const claimedEntries = entries.filter(e => e.claimed);
  const totals = {
    entries: entries.length, collected: pool.collected, prize: pool.prize, ops: pool.ops, opsWithdrawn: pool.opsWithdrawn,
    opsOutstanding: pool.ops - pool.opsWithdrawn, claimed: pool.claimed, claims: pool.claims, prizeOutstanding: pool.prize - pool.claimed,
    vault, expectedVault: pool.collected - pool.claimed - pool.opsWithdrawn,
  };
  totals.surplus = vault - totals.expectedVault;
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, ...detail });
  check('pool.entries = Entry accounts', pool.entries === entries.length, { pool: pool.entries, entries: entries.length });
  check('collected = Σ Entry.amount', pool.collected === sum(entries.map(e => e.amount)), { collected: pool.collected, sum: sum(entries.map(e => e.amount)) });
  check('collected = prize + ops', pool.collected === pool.prize + pool.ops, {});
  check('claimed = Σ claimed Entry.claimAmount', pool.claimed === sum(claimedEntries.map(e => e.claimAmount)), { claimed: pool.claimed, sum: sum(claimedEntries.map(e => e.claimAmount)) });
  check('claims = claimed Entries', pool.claims === claimedEntries.length, { claims: pool.claims, entries: claimedEntries.length });
  check('claimed ≤ prize, opsWithdrawn ≤ ops', pool.claimed <= pool.prize && pool.opsWithdrawn <= pool.ops, {});
  check('vault ≥ collected − claimed − opsWithdrawn', totals.surplus >= 0n, { vault, expected: totals.expectedVault });

  const state = STATE[pool.state] ?? 'unknown';
  const member = w => shares?.find(m => m.wallet === w) ?? null;
  const positions = entries.map(e => {
    const p = { wallet: e.wallet, paid: e.amount, claimed: e.claimed, received: e.claimed ? e.claimAmount : 0n };
    if (e.claimed) return { ...p, exit: 'claimed' };
    if (pool.state === POOL_STATE.OPEN) return { ...p, exit: 'none yet: the fee stays in the vault until the pool is finalised (Tally and Finalize need the game\'s Season Ended)' };
    if (pool.state === POOL_STATE.FINAL) return { ...p, exit: 'none yet: the operator\'s SetShares opens claims' };
    if (pool.mode === SHARE_MODE.REFUND) return { ...p, exit: 'Claim (refund; needs only the Entry)', owed: claimAmount(pool, { paid: e.amount }) };
    if (!shares) return { ...p, exit: 'Claim (shares; needs the wallet\'s Citizen of a winning nation and its proof); the amount needs the published ledger' };
    const m = member(e.wallet);
    if (!m) return { ...p, exit: 'none: not in the posted shares', owed: 0n };
    return { ...p, exit: 'Claim (shares; needs the wallet\'s Citizen of a winning nation and its proof)', owed: claimAmount(pool, { points: BigInt(m.points), nation: m.nation }) ?? 0n };
  });
  const owed = sum(positions.map(p => p.owed ?? 0n));
  if (pool.state === POOL_STATE.SHARES && (shares || pool.mode === SHARE_MODE.REFUND)) {
    // What the open claims can still take never exceeds what the prize has left; the rest is rounding or unclaimable.
    check('open claims ≤ prize − claimed', owed <= totals.prizeOutstanding, { owed, prizeOutstanding: totals.prizeOutstanding });
    totals.owedToOpenClaims = owed;
    totals.unassigned = totals.prizeOutstanding - owed;
  }
  return { state, totals, checks, positions, ok: checks.every(c => c.ok) };
}
