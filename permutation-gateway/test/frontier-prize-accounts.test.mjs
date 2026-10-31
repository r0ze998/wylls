// The prize pool's money as accounts, in every pool state (src/frontier/prize-accounts.mjs,
// prize-settle --accounts): deposits, the 80/20 parts, claims and the vault reconcile without
// asking whether the game's Season has ended, and each payer's exit is what the program offers
// now. Test tokens only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { opsPart, SHARE_MODE } from '../client/src/frontier/prize.mjs';
import { poolAccounts } from '../src/frontier/prize-accounts.mjs';

const FEE = 25_000_000n;
const show = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));
const key = () => Keypair.generate().publicKey.toBase58();
const entry = (wallet, { claimed = false, claimAmount = 0n } = {}) => ({ wallet, amount: FEE, claimed, claimAmount });
function pool(entries, over = {}) {
  const collected = FEE * BigInt(entries.length);
  const claimedEntries = entries.filter(e => e.claimed);
  return { state: 0, mode: 0, entries: entries.length, collected, prize: collected - opsPart(collected, 2000), ops: opsPart(collected, 2000), opsWithdrawn: 0n,
    claimed: claimedEntries.reduce((a, e) => a + e.claimAmount, 0n), claims: claimedEntries.length, shareNations: 0, totalPoints: Array(6).fill(0n), ...over };
}

test('an open pool while the world goes on: every deposit is accounted for and held in the vault; no payer has an exit yet', () => {
  const entries = [entry(key()), entry(key()), entry(key()), entry(key())];
  const r = poolAccounts({ pool: pool(entries), vault: 4n * FEE, entries });
  assert.equal(r.ok, true, show(r.checks));
  assert.deepEqual([r.state, r.totals.collected, r.totals.prize, r.totals.ops, r.totals.expectedVault, r.totals.surplus], ['open', 100_000_000n, 80_000_000n, 20_000_000n, 100_000_000n, 0n]);
  assert.ok(r.positions.every(p => p.exit.startsWith('none yet') && /Season Ended/.test(p.exit)), 'the only way out is the end of the Season: a dependency to resolve before a continuing world');
});

test('the vault short of what the counters say, an Entry missing, or the counters out of step: reported, not hidden', () => {
  const entries = [entry(key()), entry(key())];
  const p = pool(entries);
  assert.deepEqual(poolAccounts({ pool: p, vault: 2n * FEE - 1n, entries }).checks.filter(c => !c.ok).map(c => c.name), ['vault ≥ collected − claimed − opsWithdrawn']);
  assert.deepEqual(poolAccounts({ pool: p, vault: 2n * FEE, entries: entries.slice(1) }).checks.filter(c => !c.ok).map(c => c.name).sort(),
    ['collected = Σ Entry.amount', 'pool.entries = Entry accounts'].sort());
  // Tokens sent to the vault from outside are a surplus, not a payment: no Entry, no claim.
  const extra = poolAccounts({ pool: p, vault: 2n * FEE + 7n, entries });
  assert.deepEqual([extra.ok, extra.totals.surplus], [true, 7n]);
});

test('S1 as played, after SetShares (equal split, 3 + 1 members of two winning nations), three claims and WithdrawOps: vault, claims and the open claim reconcile to the base unit', () => {
  const [a, b, c, d] = [key(), key(), key(), key()];
  const shares = [{ wallet: a, nation: 0, points: 1 }, { wallet: b, nation: 0, points: 1 }, { wallet: c, nation: 0, points: 1 }, { wallet: d, nation: 1, points: 1 }];
  const entries = [entry(a, { claimed: true, claimAmount: 13_333_333n }), entry(b, { claimed: true, claimAmount: 13_333_333n }), entry(c), entry(d, { claimed: true, claimAmount: 40_000_000n })];
  const p = pool(entries, { state: 2, mode: SHARE_MODE.SHARES, shareNations: 2, totalPoints: [3n, 1n, 0n, 0n, 0n, 0n], opsWithdrawn: 20_000_000n });
  const vault = p.collected - p.claimed - p.opsWithdrawn;
  const r = poolAccounts({ pool: p, vault, entries, shares });
  assert.equal(r.ok, true, show(r.checks));
  assert.deepEqual([r.totals.claimed, r.totals.prizeOutstanding, r.totals.owedToOpenClaims, r.totals.unassigned, r.totals.opsOutstanding, vault],
    [66_666_666n, 13_333_334n, 13_333_333n, 1n, 0n, 13_333_334n]);
  assert.match(r.positions.find(x => x.wallet === c).exit, /Citizen/, 'a shares claim still needs the wallet\'s Citizen account');
});

test('refund mode: each open refund is 80% of the fee and needs only the Entry; the vault keeps the operator\'s part until WithdrawOps', () => {
  const [a, b] = [key(), key()];
  const entries = [entry(a, { claimed: true, claimAmount: 20_000_000n }), entry(b)];
  const p = pool(entries, { state: 2, mode: SHARE_MODE.REFUND });
  const r = poolAccounts({ pool: p, vault: p.collected - p.claimed, entries });
  assert.equal(r.ok, true, show(r.checks));
  const open = r.positions.find(x => x.wallet === b);
  assert.deepEqual([open.owed, /only the Entry/.test(open.exit), r.totals.opsOutstanding, r.totals.unassigned], [20_000_000n, true, 5_000_000n * 2n, 0n]);
});
