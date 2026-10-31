// The shares a pool's SetShares posts, computed from public inputs, and the
// check of a posted SetShares against them (permutation-prize; test tokens
// only). scripts/prize-settle.mjs computes the shares with `sharesOf` before
// the operator posts them; `--verify-shares` recomputes them from the
// chain and the published ledger with the same functions and compares.
//
// What the program does NOT check (so this check is the only one): that the
// root's leaves follow from the ledger, that `totals` are the sums of the
// leaves' points, and that the ledger behind `ledger_hash` is the one
// published. It does check, on chain: a claim needs a paid Entry, a Citizen
// of a winning nation and a proof against the posted root; points ≤ the
// nation's total; the sum of claims ≤ the prize.
import { createHash } from 'node:crypto';
import { toHex } from '../../client/src/bytes.mjs';
import { leafHash, merkleTree, SHARE_MODE } from '../../client/src/frontier/prize.mjs';
import { scoreLines } from './achievements.mjs';

const NATIONS = 6;
const sha256hex = text => createHash('sha256').update(text).digest('hex');

/**
 * The season's members, as prize-settle reads them: every wallet a ledger
 * line names (its nation from the line), then every other wallet of
 * `extraWallets` (the pool's Entry wallets, a members file) that has a
 * Citizen (its nation from the Citizen). `hasEntry(w)` and `factionOf(w)`
 * (null without a Citizen) read the chain.
 */
export async function membersOf({ lines, extraWallets = [], hasEntry, factionOf }) {
  const members = [];
  const paid = new Set();
  for (const w of [...new Set(lines.map(l => l.wallet).filter(Boolean))]) {
    const e = await hasEntry(w);
    if (e) paid.add(w);
    members.push({ wallet: w, nation: lines.find(l => l.wallet === w && l.kind === 'capture')?.detail.ownerNation ?? lines.find(l => l.wallet === w)?.detail.supplierNation, paid: e });
  }
  for (const w of extraWallets) {
    if (members.some(m => m.wallet === w)) continue;
    const nation = await factionOf(w);
    const e = await hasEntry(w);
    if (e) paid.add(w);
    if (nation !== null) members.push({ wallet: w, nation, paid: e });
  }
  return { members, paid };
}

/** Points, totals, mode and the merkle tree for `pool.pool` from `lines` under `params` (scoreLines' rules). */
export function sharesOf({ lines, params, winners, paid, members, poolAddress }) {
  const scored = scoreLines(lines, { params, winners, paid, members });
  const totals = Array(NATIONS).fill(0n);
  for (const v of scored.points.values()) totals[v.nation] += BigInt(v.points);
  const leaves = [...scored.points].map(([wallet, v]) => ({ wallet, ...v, leaf: leafHash(poolAddress, wallet, v.nation, BigInt(v.points)) }));
  const tree = merkleTree(leaves.map(l => l.leaf));
  return {
    scored, totals, leaves, tree, shareNations: totals.filter(t => t > 0n).length,
    mode: scored.mode === 'refund' ? SHARE_MODE.REFUND : SHARE_MODE.SHARES,
    // A refund posts no root (claims carry no proof).
    root: scored.mode === 'refund' ? new Uint8Array(32) : tree.root,
  };
}

/**
 * Compare a pool's posted shares (decodePool) with `recomputed` (sharesOf),
 * the published ledger text and the params file text. Returns
 * `{ok, checks: [{name, ok, posted, recomputed}]}`.
 */
export function checkPostedShares({ pool, recomputed, ledgerText, paramsText }) {
  const checks = [];
  const add = (name, posted, want) => checks.push({ name, ok: posted === want, posted, recomputed: want });
  add('pool is in the shares state', ['open', 'final', 'shares'][pool.state], 'shares');
  add('params_hash = sha256(prize-params.json)', toHex(pool.paramsHash), sha256hex(paramsText));
  add('ledger_hash = sha256(published ledger)', toHex(pool.ledgerHash), sha256hex(ledgerText));
  add('mode', pool.mode, recomputed.mode);
  add('share nations', pool.shareNations, recomputed.shareNations);
  add('total points per nation', pool.totalPoints.map(String).join(','), recomputed.totals.map(String).join(','));
  add('merkle root', toHex(pool.sharesRoot), toHex(recomputed.root));
  // The ledger's own list of members, points and proofs is the one recomputed.
  let ledger = null;
  try { ledger = JSON.parse(ledgerText); } catch { /* reported below */ }
  const listed = (ledger?.shares?.members ?? []).map(m => `${m.wallet}:${m.nation}:${m.points}`).sort().join(' ');
  add('ledger members and points', listed, recomputed.leaves.map(l => `${l.wallet}:${l.nation}:${l.points}`).sort().join(' '));
  const proofsOk = recomputed.leaves.every(l => {
    const m = ledger?.shares?.members?.find(x => x.wallet === l.wallet);
    return m && JSON.stringify(m.proof) === JSON.stringify(recomputed.tree.proof(l.leaf).map(toHex));
  });
  add('ledger proofs', proofsOk, true);
  return { ok: checks.every(c => c.ok), checks };
}
