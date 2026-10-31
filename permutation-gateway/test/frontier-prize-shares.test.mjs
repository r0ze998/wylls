// The shares SetShares posts, recomputed from public inputs (src/frontier/shares.mjs, prize-settle
// --verify-shares): what the operator posts must follow from the ledger lines, the Entry and Citizen
// accounts and the params file the pool is bound to; anything else is caught here, not by the program.
// Test tokens only; the amounts follow permutation-prize's share/refund arithmetic (claimAmount).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { toHex } from '../client/src/bytes.mjs';
import { claimAmount, leafHash, opsPart, SHARE_MODE } from '../client/src/frontier/prize.mjs';
import { checkPostedShares, membersOf, sharesOf } from '../src/frontier/shares.mjs';

const PARAMS_TEXT = readFileSync(new URL('../src/frontier/prize-params.json', import.meta.url), 'utf8');
const params = JSON.parse(PARAMS_TEXT);
const POOL = Keypair.generate().publicKey.toBase58();
const FEE = 25_000_000n;
const key = () => Keypair.generate().publicKey.toBase58();
const sha = t => createHash('sha256').update(t).digest();

/** A pool after Finalize with `n` paid entries (80/20) and `winners`. */
const finalPool = (n, winners) => {
  const collected = FEE * BigInt(n);
  return { state: 1, winners, collected, prize: collected - opsPart(collected, 2000), ops: opsPart(collected, 2000), paramsHash: sha(PARAMS_TEXT) };
};
/** What SetShares writes into the pool, and the ledger text whose hash it carries. */
function post(pool, shares, ledgerText) {
  return { ...pool, state: 2, mode: shares.mode, shareNations: shares.shareNations, totalPoints: shares.totals, sharesRoot: shares.root, ledgerHash: sha(ledgerText) };
}
const ledgerOf = (lines, shares) => `${JSON.stringify({ lines, shares: { members: shares.leaves.map(l => ({ wallet: l.wallet, nation: l.nation, points: l.points, proof: shares.tree.proof(l.leaf).map(toHex) })) } }, null, 2)}\n`;
async function members({ lines, entries, factions }) {
  return membersOf({ lines, extraWallets: entries, hasEntry: async w => entries.includes(w), factionOf: async w => factions.get(w) ?? null });
}

test('S1 as played (six-way tie, no capture or reinforcement line): equal split among the paid members; amounts, dust and the vault reconcile', async () => {
  const [a, b, c, d] = [key(), key(), key(), key()];
  const factions = new Map([[a, 0], [b, 0], [c, 0], [d, 1]]);
  const entries = [a, b, c, d];
  const pool = finalPool(4, [0, 1, 2, 3, 4, 5]);
  const { members: m, paid } = await members({ lines: [], entries, factions });
  const shares = sharesOf({ lines: [], params, winners: pool.winners, paid, members: m, poolAddress: POOL });
  assert.equal(shares.scored.mode, 'equal');
  assert.deepEqual([shares.mode, shares.shareNations, shares.totals.map(String)], [SHARE_MODE.SHARES, 2, ['3', '1', '0', '0', '0', '0']]);
  const ledgerText = ledgerOf([], shares);
  const posted = post(pool, shares, ledgerText);
  assert.equal(checkPostedShares({ pool: posted, recomputed: shares, ledgerText, paramsText: PARAMS_TEXT }).ok, true);
  // The claims the program would pay: prize 80 test USDC, 40 per nation with points, then by points.
  const amounts = shares.leaves.map(l => claimAmount(posted, { points: BigInt(l.points), nation: l.nation }));
  const byWallet = Object.fromEntries(shares.leaves.map((l, i) => [l.wallet, amounts[i]]));
  assert.deepEqual([byWallet[a], byWallet[b], byWallet[c], byWallet[d]], [13_333_333n, 13_333_333n, 13_333_333n, 40_000_000n]);
  const claimed = amounts.reduce((x, y) => x + y, 0n);
  assert.equal(pool.prize - claimed, 1n, 'one base unit of rounding stays in the vault (no instruction sweeps it)');
  // Vault after every claim and WithdrawOps: collected − claimed − ops = the dust.
  assert.equal(pool.collected - claimed - pool.ops, 1n);
});

test('a capture and reinforcements: points by the provisional weights; the posted root and totals are the recomputed ones', async () => {
  const [att, sup, other] = [key(), key(), key()];
  const lines = [
    { kind: 'capture', wallet: att, nation: 2, quantity: 1, unit: 'province', province: { p: 3, q: -1 }, detail: { ownerNation: 2 }, signatures: ['s1'] },
    { kind: 'reinforcement', wallet: sup, nation: 2, quantity: 650, unit: 'troops', province: { p: 3, q: -1 }, detail: { supplierNation: 2 }, signatures: ['s2'] },
    { kind: 'reinforcement', wallet: other, nation: 2, quantity: 900, unit: 'troops', province: { p: 3, q: -1 }, detail: { supplierNation: 4 }, signatures: ['s3'] },
  ];
  const factions = new Map([[att, 2], [sup, 2], [other, 4]]);
  const pool = finalPool(3, [2]);
  const { members: m, paid } = await members({ lines, entries: [att, sup, other], factions });
  const shares = sharesOf({ lines, params, winners: pool.winners, paid, members: m, poolAddress: POOL });
  assert.deepEqual(Object.fromEntries(shares.leaves.map(l => [l.wallet, l.points])), { [att]: 10, [sup]: 6 }, 'another nation\'s troops earn nothing');
  assert.deepEqual(shares.totals.map(String), ['0', '0', '16', '0', '0', '0']);
  const ledgerText = ledgerOf(lines, shares);
  const posted = post(pool, shares, ledgerText);
  assert.equal(checkPostedShares({ pool: posted, recomputed: shares, ledgerText, paramsText: PARAMS_TEXT }).ok, true);
});

test('what an operator could post and the program would accept is caught by the recomputation: inflated points, wrong totals, another ledger or params file', async () => {
  const [a, b, op] = [key(), key(), key()];
  const factions = new Map([[a, 1], [b, 1], [op, 1]]);
  const entries = [a, b, op];
  const pool = finalPool(3, [1]);
  const { members: m, paid } = await members({ lines: [], entries, factions });
  const honest = sharesOf({ lines: [], params, winners: pool.winners, paid, members: m, poolAddress: POOL });
  const ledgerText = ledgerOf([], honest);
  const failed = posted => checkPostedShares({ pool: posted, recomputed: honest, ledgerText, paramsText: PARAMS_TEXT }).checks.filter(c => !c.ok).map(c => c.name);
  // 1. A root that gives one paid member of the winning nation all the points (the program checks only the proof).
  const greedy = { ...honest, root: leafHash(POOL, op, 1, 3n) };
  assert.deepEqual(failed(post(pool, greedy, ledgerText)), ['merkle root']);
  // 2. Totals larger than the leaves (each claim smaller; the rest stays in the vault for good).
  assert.deepEqual(failed(post(pool, { ...honest, totals: [0n, 30n, 0n, 0n, 0n, 0n] }, ledgerText)), ['total points per nation']);
  // 3. Totals smaller than the leaves: the first claims take more, the last are refused (the program's sum ≤ prize).
  const short = post(pool, { ...honest, totals: [0n, 1n, 0n, 0n, 0n, 0n] }, ledgerText);
  assert.equal(claimAmount(short, { points: 1n, nation: 1 }), pool.prize, 'one claim would take the whole prize');
  assert.deepEqual(failed(short), ['total points per nation']);
  // 4. A ledger hash of another text than the published ledger; 5. a params file other than the pool's.
  assert.deepEqual(failed(post(pool, honest, `${ledgerText} `)), ['ledger_hash = sha256(published ledger)']);
  assert.deepEqual(checkPostedShares({ pool: post(pool, honest, ledgerText), recomputed: honest, ledgerText, paramsText: `${PARAMS_TEXT} ` }).checks.filter(c => !c.ok).map(c => c.name),
    ['params_hash = sha256(prize-params.json)']);
  // 6. A refund posted while there are eligible members.
  assert.deepEqual(failed(post(pool, { ...honest, mode: SHARE_MODE.REFUND, shareNations: 0, totals: Array(6).fill(0n), root: new Uint8Array(32) }, ledgerText)).sort(),
    ['merkle root', 'mode', 'share nations', 'total points per nation'].sort());
});

test('no paid member in the winning nation: refund mode, no root; each payer gets 80% of its fee back and the vault keeps the operator\'s 20% until WithdrawOps', async () => {
  const [a, b] = [key(), key()];
  const factions = new Map([[a, 0], [b, 1]]);
  const pool = finalPool(2, [5]);
  const { members: m, paid } = await members({ lines: [], entries: [a, b], factions });
  const shares = sharesOf({ lines: [], params, winners: pool.winners, paid, members: m, poolAddress: POOL });
  assert.deepEqual([shares.scored.mode, shares.mode, shares.shareNations, toHex(shares.root)], ['refund', SHARE_MODE.REFUND, 0, '00'.repeat(32)]);
  const ledgerText = ledgerOf([], shares);
  const posted = post(pool, shares, ledgerText);
  assert.equal(checkPostedShares({ pool: posted, recomputed: shares, ledgerText, paramsText: PARAMS_TEXT }).ok, true);
  const refund = claimAmount(posted, { paid: FEE });
  assert.equal(refund, 20_000_000n);
  assert.equal(pool.collected - 2n * refund, pool.ops);
});
