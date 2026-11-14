// TEST ONLY shares ledger (⑰, 2026-11-15): a ledger in the shape the relay serves (GET /f/prize/ledger) and the
// page reads (fprize.passShareOf / passClaimModel), built from a GIVEN member list instead of the achievements.
// It exists to exercise the claim path (SetShares → ClaimResident through the relay and the page) in a short local
// test world where passes may not have earned points. It is NOT a prize allocation: it decides no weight, rule or
// product split, and the achievements → points path stays unproven by it. Every ledger it makes says so.
//
// Pure: no chain, no key. The CLI that may post its root (SetShares, the operator's real instruction on a
// loopback chain) is scripts/prize-nft-test-shares.mjs.
import { toHex } from '../client/src/bytes.mjs';
import { FACTIONS, leafHash, leafResidentHash, merkleTree, POOL_STATE } from '../client/src/frontier/prize.mjs';

export const TEST_ONLY_LABEL = 'TEST ONLY shares ledger: points given by the test, not derived from achievements; not a prize allocation and not the provisional rules';
const PASS = 'pass:';

/**
 * `members`: [{ asset } | { wallet }, nation, points] (points a positive integer ≤ u64). The pool (decodePool) must be
 * Final, every member's nation one of its winners, no member twice. Returns { ledger, root, totals, ledgerText }.
 */
export function testSharesLedger({ prize, pool, members }) {
  if (!pool || pool.state !== POOL_STATE.FINAL) throw new Error('the pool must be Final (tallied and finalized) before shares');
  if (!Array.isArray(members) || members.length === 0) throw new Error('members: at least one');
  const seen = new Set();
  const rows = members.map((m, i) => {
    const hasAsset = typeof m.asset === 'string' && m.asset.length > 0, hasWallet = typeof m.wallet === 'string' && m.wallet.length > 0;
    if (hasAsset === hasWallet) throw new Error(`member ${i}: exactly one of asset or wallet`);
    const id = hasAsset ? PASS + m.asset : m.wallet;
    if (seen.has(id)) throw new Error(`member ${i}: ${id} twice`);
    seen.add(id);
    if (!Number.isInteger(m.nation) || m.nation < 0 || m.nation >= FACTIONS) throw new Error(`member ${i}: nation 0–${FACTIONS - 1}`);
    if (!pool.winners.includes(m.nation)) throw new Error(`member ${i}: nation ${m.nation} is not a winner (${pool.winners.join(',')})`);
    const points = BigInt(m.points);
    if (points <= 0n || points > 0xffff_ffff_ffff_ffffn) throw new Error(`member ${i}: points 1–u64`);
    const leaf = hasAsset ? leafResidentHash(prize.pool, m.asset, m.nation, points) : leafHash(prize.pool, m.wallet, m.nation, points);
    return { wallet: id, asset: hasAsset ? m.asset : null, nation: m.nation, points, leaf };
  });
  const totals = Array(FACTIONS).fill(0n);
  for (const r of rows) totals[r.nation] += r.points;
  const tree = merkleTree(rows.map(r => r.leaf));
  // Points travel as decimal strings unless they are safe integers (the page's pointsOf rule).
  const pts = p => (p <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(p) : p.toString());
  const ledger = {
    version: 1, testOnly: true, label: TEST_ONLY_LABEL, testAssetsOnly: true, provisional: true,
    provisionalRules: [TEST_ONLY_LABEL], prize,
    result: { area: pool.area, winners: pool.winners, state: 'final' },
    kinds: {}, lines: [],
    players: rows.map(r => ({ wallet: r.wallet, asset: r.asset, nation: r.nation, kind: 'testFixture', prizeEligible: true })),
    shares: { mode: 'shares', totalPoints: totals.map(String), root: toHex(tree.root),
      members: rows.map(r => ({ wallet: r.wallet, asset: r.asset, nation: r.nation, points: pts(r.points), proof: tree.proof(r.leaf).map(toHex) })) },
    estimate: { label: `ESTIMATE of a ${TEST_ONLY_LABEL}`, split: [] },
  };
  const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
  return { ledger, root: tree.root, totals, ledgerText };
}
