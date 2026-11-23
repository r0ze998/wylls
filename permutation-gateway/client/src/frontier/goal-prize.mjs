// World goals' prize pool (permutation-prize feature `goals`, tags 13–23; TEST USDC, localnet and devnet only — design
// record docs/design/win-conditions/01-proposal.ja.md §7 and §10.1, owner r0ze 2026-11-24 00:21 t481u / 01:04 t485u):
//
//   addresses   the goal pool of (game program, season), a wallet's pass, a goal (kind, round), a claim's receipt
//   decoding    GoalPool, Goal, Pass
//   building    InitGoalPool, BuyPass, PostGoal, Achieve, AttestAchieve, VoidGoal, SetGoalShares, GoalClaim, GoalSweep,
//               RetireGoal, GoalWithdrawOps
//   ledger      `goalShares`: from an achievement and the contribution ledger in PR #198's shapes (world-goals.mjs
//               `pointsOf().byWallet`, the members list of `splitPrize`) to the published ledger, its sha256, the merkle
//               root the program checks and every eligible wallet's proof — the same eligibility the program enforces
//
// Layouts and tags are permutation-prize/src/goals.rs's; the leaf and the tree are prize.mjs's (`leafHash` keyed by the
// GOAL's address). Browser-safe (no node:*); copied to web/sdk/frontier (FRONTIER_MODULES).
import { encode as toBase58 } from '../base58.mjs';
import { concat, u16le, u32le, u64le, utf8 } from '../bytes.mjs';
import { ata, TOKEN_PROGRAM } from '../player.mjs';
import { sha256 } from '../sha256.mjs';
import { findProgramAddress, pubkeyBytes } from '../solana-tx.mjs';
import { SYSTEM_PROGRAM } from './addresses.mjs';
import { exclusionAddress, FACTIONS, leafHash, merkleTree, PRIZE_TAG, vaultAddress } from './prize.mjs';

export const GOAL_KINDS = Object.freeze({ HEGEMONY: 0, SCIENCE: 1, WONDER: 2, EXPLORATION: 3 });
export const GOAL_STATE = Object.freeze({ POSTED: 1, ACHIEVED: 2, SHARES: 3, CLOSED: 4 });
export const GOAL_MODE = Object.freeze({ SHARES: 1, RETURN: 2 });
export const GOAL_POOL_SIZE = 448;
export const GOAL_SIZE = 448;
export const PASS_SIZE = 96;
export const MAX_FLAGS = 32;
/** The design record's initial values (§7.1–§7.4; Q5, Q13, Q14, Q19) for a 6-decimal test mint. */
export const RECOMMENDED = Object.freeze({ passFee: 25_000_000n, opsBps: 2000, passSecs: 30 * 86_400, claimSecs: 14 * 86_400, memberBells: 144,
  disputeSecs: 3 * 86_400, retireSecs: 30 * 86_400, minPayout: 10_000n, kindBps: Object.freeze([4000, 2000, 2000, 2000]) });

const W = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const R = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const rdU64 = (d, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
const rdI64 = (d, o) => BigInt.asIntN(64, rdU64(d, o));
const rdU = (d, o, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + d[o + i]; return v; };
const rdI16 = (d, o) => { const v = rdU(d, o, 2); return v >= 0x8000 ? v - 0x10000 : v; };
const key = (d, o) => toBase58(d.subarray(o, o + 32));
const magic = (d, text) => utf8(text).every((b, i) => d[i] === b);
const i16le = v => u16le(v < 0 ? v + 0x10000 : v);
const i64le = v => u64le(BigInt.asUintN(64, BigInt(v)));
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------ addresses

export const goalPoolAddress = (prizeProgram, gameProgram, seasonId) => findProgramAddress([utf8('gpool'), pubkeyBytes(gameProgram), u64le(seasonId)], prizeProgram)[0];
export const passAddress = (prizeProgram, gpool, wallet) => findProgramAddress([utf8('gpass'), pubkeyBytes(gpool), pubkeyBytes(wallet)], prizeProgram)[0];
export const goalAddress = (prizeProgram, gpool, kind, round) => findProgramAddress([utf8('goal'), pubkeyBytes(gpool), [kind], u32le(round)], prizeProgram)[0];
export const receiptAddress = (prizeProgram, goal, wallet) => findProgramAddress([utf8('gclaim'), pubkeyBytes(goal), pubkeyBytes(wallet)], prizeProgram)[0];

/** `{program, game, seasonId, gpool, vault, mint}` (base58) of a season's goal pool. */
export function goalPoolAddresses({ prizeProgram, gameProgram, seasonId, mint }) {
  const gpool = goalPoolAddress(prizeProgram, gameProgram, seasonId);
  return { program: prizeProgram, game: gameProgram, seasonId: String(seasonId), gpool, vault: vaultAddress(prizeProgram, gpool), mint };
}

// ------------------------------------------------------------------ decoding

export function decodeGoalPool(data) {
  const d = Uint8Array.from(data ?? []);
  if (d.length !== GOAL_POOL_SIZE || !magic(d, 'WYPRGPOL')) return null;
  const four = (o, n) => Array.from({ length: 4 }, (_, k) => (n === 8 ? rdU64(d, o + 8 * k) : rdU(d, o + n * k, n)));
  return {
    decimals: d[10], enabled: d[11], live: d[12], seasonId: rdU64(d, 16), gameProgram: key(d, 24), season: key(d, 56), operator: key(d, 88),
    mint: key(d, 120), vault: key(d, 152), passFee: rdU64(d, 184), opsBps: rdU(d, 192, 2), passSecs: rdU(d, 196, 4), claimSecs: rdU(d, 200, 4),
    memberBells: rdU(d, 204, 4), minPayout: rdU64(d, 208), disputeSecs: rdU(d, 216, 4), retireSecs: rdU(d, 220, 4), kindBps: four(224, 2),
    bellSecs: rdU(d, 232, 4), genesisTs: Number(rdI64(d, 240)), treasury: four(248, 8), collected: rdU64(d, 280), ops: rdU64(d, 288),
    opsWithdrawn: rdU64(d, 296), paid: rdU64(d, 304), returned: rdU64(d, 312), passes: rdU(d, 320, 4), nextRound: four(324, 4), paramsHash: d.slice(340, 372),
  };
}

export function decodeGoal(data) {
  const d = Uint8Array.from(data ?? []);
  if (d.length !== GOAL_SIZE || !magic(d, 'WYPRGOAL')) return null;
  const winnersMask = d[11];
  const n = d[15];
  return {
    kind: d[9], state: d[10], winnersMask, winners: [...Array(FACTIONS).keys()].filter(f => winnersMask & (1 << f)), mode: d[12], shareNations: d[13],
    need: d[14], round: rdU(d, 16, 4), holdBells: rdU(d, 20, 4), postedBell: rdU(d, 24, 4), achievedBell: rdU(d, 28, 4), gpool: key(d, 32),
    postingHash: d.slice(64, 96), payoutBps: rdU(d, 96, 2), judge: d[98] === 0 ? 'chain' : 'attested', postedTs: Number(rdI64(d, 104)),
    achievedTs: Number(rdI64(d, 112)), sharesOpenTs: Number(rdI64(d, 120)), deadlineTs: Number(rdI64(d, 128)), payout: rdU64(d, 136),
    claimed: rdU64(d, 144), claims: rdU(d, 152, 4), returned: rdU64(d, 160), totalPoints: Array.from({ length: FACTIONS }, (_, f) => rdU64(d, 168 + 8 * f)),
    root: d.slice(216, 248), ledgerHash: d.slice(248, 280), evidenceHash: d.slice(280, 312),
    flags: Array.from({ length: n }, (_, i) => ({ p: rdI16(d, 312 + 4 * i), q: rdI16(d, 314 + 4 * i) })),
  };
}

export function decodePass(data) {
  const d = Uint8Array.from(data ?? []);
  if (d.length !== PASS_SIZE || !magic(d, 'WYPRGPAS')) return null;
  return { wallet: key(d, 16), validFrom: Number(rdI64(d, 48)), validUntil: Number(rdI64(d, 56)), prevFrom: Number(rdI64(d, 64)), prevUntil: Number(rdI64(d, 72)),
    paid: rdU64(d, 80), count: rdU(d, 88, 4) };
}

/** permutation-prize goals `valid_at`: the current or the previous span covers `at` (unix seconds). */
export const passValidAt = (pass, at) => !!pass && ((pass.validFrom <= at && at < pass.validUntil) || (pass.prevFrom <= at && at < pass.prevUntil));

// ------------------------------------------------------------------ instructions

export function initGoalPoolIx({ gp, operator, season, params = RECOMMENDED, paramsHash }) {
  const p = { ...RECOMMENDED, ...params };
  if (paramsHash?.length !== 32 || p.kindBps.length !== 4) throw new Error('InitGoalPool: a 32-byte params hash and four kind shares');
  const data = concat([PRIZE_TAG.INIT_GOAL_POOL], u64le(p.passFee), u16le(p.opsBps), u32le(p.passSecs), u32le(p.claimSecs), u32le(p.memberBells),
    u32le(p.disputeSecs), u32le(p.retireSecs), u64le(p.minPayout), ...p.kindBps.map(u16le), paramsHash);
  return { programId: gp.program, data, keys: [W(operator, true), W(gp.gpool), W(gp.vault), R(gp.mint), R(season), R(gp.game), R(TOKEN_PROGRAM), R(SYSTEM_PROGRAM)] };
}

export const buyPassIx = ({ gp, wallet, payer = wallet, walletToken = null }) => ({ programId: gp.program, data: Uint8Array.of(PRIZE_TAG.BUY_PASS),
  keys: [R(wallet, true), W(payer, true), W(gp.gpool), W(passAddress(gp.program, gp.gpool, wallet)), W(walletToken ?? ata(wallet, gp.mint)), W(gp.vault), R(gp.mint),
    R(TOKEN_PROGRAM), R(SYSTEM_PROGRAM), R(exclusionAddress(gp.program, gp.game, BigInt(gp.seasonId), wallet))] });

/** PostGoal: hegemony carries `flags` `[{p, q}]`, `need`, `holdBells`; the other kinds none. */
export function postGoalIx({ gp, operator, season, kind, round, need = 0, holdBells = 0, payoutBps, postingHash, flags = [] }) {
  if (postingHash?.length !== 32 || flags.length > MAX_FLAGS) throw new Error('PostGoal: a 32-byte posting hash and at most 32 flags');
  const data = concat([PRIZE_TAG.POST_GOAL, kind], u32le(round), [need], u32le(holdBells), u16le(payoutBps), postingHash, [flags.length],
    ...flags.flatMap(f => [i16le(f.p), i16le(f.q)]));
  return { programId: gp.program, data, keys: [W(operator, true), W(gp.gpool), W(goalAddress(gp.program, gp.gpool, kind, round)), R(season), R(SYSTEM_PROGRAM)] };
}

/** Achieve (hegemony; anyone): `provinces` = the goal's flag provinces' addresses, in posted order. */
export const achieveIx = ({ gp, goal, season, provinces }) => ({ programId: gp.program, data: Uint8Array.of(PRIZE_TAG.ACHIEVE),
  keys: [W(goal), W(gp.gpool), R(season), ...provinces.map(p => R(p))] });

export const attestAchieveIx = ({ gp, operator, goal, season, winners, achievedBell, evidenceHash }) => ({ programId: gp.program,
  data: concat([PRIZE_TAG.ATTEST_ACHIEVE, winners.reduce((m, n) => m | (1 << n), 0)], u32le(achievedBell), evidenceHash),
  keys: [R(operator, true), W(goal), W(gp.gpool), R(season)] });

export const voidGoalIx = ({ gp, operator, goal }) => ({ programId: gp.program, data: Uint8Array.of(PRIZE_TAG.VOID_GOAL), keys: [R(operator, true), W(goal), W(gp.gpool)] });
export const retireGoalIx = ({ gp, operator, goal }) => ({ programId: gp.program, data: Uint8Array.of(PRIZE_TAG.RETIRE_GOAL), keys: [R(operator, true), W(goal), W(gp.gpool)] });

/** SetGoalShares: `shares` is `goalShares(...)`'s result (its `setShares` part). */
export function setGoalSharesIx({ gp, operator, goal, mode, totals, root, ledgerHash }) {
  if (totals.length !== FACTIONS || root.length !== 32 || ledgerHash.length !== 32) throw new Error('SetGoalShares: six totals, a 32-byte root and ledger hash');
  return { programId: gp.program, data: concat([PRIZE_TAG.SET_GOAL_SHARES, mode], ...totals.map(t => u64le(BigInt(t))), root, ledgerHash),
    keys: [R(operator, true), W(goal), W(gp.gpool)] };
}

export const goalClaimIx = ({ gp, goal, wallet, citizen, nation, points, proof = [], dest = null }) => ({ programId: gp.program,
  data: concat([PRIZE_TAG.GOAL_CLAIM, nation], u64le(BigInt(points)), [proof.length], ...proof),
  keys: [W(wallet, true), W(goal), W(gp.gpool), R(passAddress(gp.program, gp.gpool, wallet)), W(receiptAddress(gp.program, goal, wallet)), R(citizen),
    R(exclusionAddress(gp.program, gp.game, BigInt(gp.seasonId), wallet)), W(gp.vault), W(dest ?? ata(wallet, gp.mint)), R(gp.mint), R(TOKEN_PROGRAM), R(SYSTEM_PROGRAM)] });

export const goalSweepIx = ({ gp, goal }) => ({ programId: gp.program, data: Uint8Array.of(PRIZE_TAG.GOAL_SWEEP), keys: [W(goal), W(gp.gpool)] });
export const goalWithdrawOpsIx = ({ gp, operator, dest = null }) => ({ programId: gp.program, data: Uint8Array.of(PRIZE_TAG.GOAL_WITHDRAW_OPS),
  keys: [R(operator, true), W(gp.gpool), W(gp.vault), W(dest ?? ata(operator, gp.mint)), R(gp.mint), R(TOKEN_PROGRAM)] });

// ------------------------------------------------------------------ the ledger

/** permutation-prize `share_amount`: floor(floor(payout / nations) × points / total). */
export const shareAmount = (payout, nations, points, total) => (nations > 0n && total > 0n && points <= total ? (payout / nations) * points / total : null);

/**
 * The shares of one achieved goal, as the program will check them (§7.3 (a), §7.4, Q7, Q17 (b), Q19):
 *
 *   goal      `{address, kind, round, achievedBell, achievedTs, winners: [nation], payout (bigint)}` (decodeGoal + address)
 *   points    PR #198 `pointsOf(lines).byWallet`: Map(wallet → {nation, points, lines?: [{bell, points}]})
 *   members   PR #198 `splitPrize` members: `[{wallet, nation, joinBell, operator, external}]`
 *   passes    Map(wallet → decodePass(...)) — read from the chain
 *   rules     `{memberBells, minPayout, genesisTs?, bellSecs?}` (the goal pool's; genesis and bell length let a line count
 *             only while the wallet's pass was valid at its bell — §7.4; without them every line counts)
 *
 * Eligible: a person (not an operator AI resident — Q17 (b): its points leave the totals; not an external AI — Q7:
 * after the legal review), a member `memberBells` before the achievement (Q19), with a pass valid at the achievement
 * bell's time (§7.4). All eligible points zero: one point each (the provisional equal split). Nations are split equally
 * first (the program divides by the number of winning nations); a nation with no eligible member leaves its part to the
 * sweep, and so does a share under `minPayout` (PR #198 `splitPrize`). → `{mode, rows, totals, leaves, root, proofs:
 * Map(wallet → [Uint8Array]), ledger, ledgerHash, setShares: {mode, totals, root, ledgerHash}}`.
 */
export function goalShares({ goal, points, members, passes, rules }) {
  const winners = [...goal.winners].sort((a, b) => a - b);
  const nations = BigInt(winners.length);
  const payout = BigInt(goal.payout);
  const minPayout = BigInt(rules.minPayout ?? 0);
  const bellTs = b => (rules.genesisTs === undefined || !rules.bellSecs ? null : rules.genesisTs + b * rules.bellSecs);
  const rows = [];
  const totals = Array(FACTIONS).fill(0n);
  for (const n of winners) {
    const who = members.filter(m => m.nation === n).map(m => ({ ...m }));
    for (const [wallet, x] of points) if (x.nation === n && !who.some(w => w.wallet === wallet)) who.push({ wallet, nation: n, unknown: true });
    const judged = who.map(m => {
      const pass = passes.get(m.wallet) ?? null;
      const p = points.get(m.wallet);
      // §7.4: points only for lines while the pass was valid (when the line bells and the clock are known)
      const pts = p?.lines && bellTs(0) !== null ? p.lines.filter(l => passValidAt(pass, bellTs(l.bell))).reduce((a, l) => a + (l.points ?? 0), 0) : (p?.points ?? 0);
      const kind = m.unknown ? 'unknown' : m.operator ? 'operator-ai' : m.external ? 'external-ai' : 'person';
      const why = m.unknown ? 'not-a-member-read' : m.operator ? 'operator-ai' : m.external ? 'external-ai-legal-review'
        : !(Number.isInteger(m.joinBell) && m.joinBell + rules.memberBells <= goal.achievedBell) ? 'member-too-recent'
          : !passValidAt(pass, goal.achievedTs) ? 'no-valid-pass' : null;
      return { wallet: m.wallet, nation: n, kind, points: BigInt(pts), eligible: why === null, why };
    });
    const eligible = judged.filter(r => r.eligible);
    let total = eligible.reduce((a, r) => a + r.points, 0n);
    const mode = total > 0n ? 'points' : eligible.length ? 'equal' : 'none';
    if (mode === 'equal') { for (const r of eligible) r.points = 1n; total = BigInt(eligible.length); }
    totals[n] = total;
    for (const r of judged) {
      let amount = r.eligible ? shareAmount(payout, nations, r.points, total) ?? 0n : 0n;
      if (amount < minPayout) amount = 0n;
      rows.push({ ...r, mode, amount });
    }
  }
  const paidRows = rows.filter(r => r.amount > 0n);
  const leafOf = r => leafHash(goal.address, r.wallet, r.nation, r.points);
  const leaves = paidRows.map(leafOf);
  const tree = merkleTree(leaves);
  const proofs = new Map(paidRows.map((r, i) => [r.wallet, tree.proof(leaves[i])]));
  const shareMode = totals.some(t => t > 0n) ? 'shares' : 'return';
  const ledger = {
    kind: 'world-goal-shares', version: 1, asset: 'test USDC',
    goal: { address: goal.address, kind: goal.kind, round: goal.round, achievedBell: goal.achievedBell, achievedTs: goal.achievedTs, winners, payout: String(payout) },
    rules: { memberBells: rules.memberBells, minPayout: String(minPayout), split: 'proportional (Q15 a)', operatorAi: 'points out of the totals (Q17 b)', externalAi: 'after the legal review (Q7)' },
    mode: shareMode, totals: totals.map(String), root: hex(tree.root),
    rows: rows.map(r => ({ wallet: r.wallet, nation: r.nation, kind: r.kind, points: String(r.points), eligible: r.eligible, why: r.why, mode: r.mode, amount: String(r.amount) })),
  };
  const ledgerHash = sha256(utf8(JSON.stringify(ledger)));
  const returned = payout - paidRows.reduce((a, r) => a + r.amount, 0n);
  return { mode: shareMode, rows, totals, leaves, root: tree.root, proofs, ledger, ledgerHash, returned,
    setShares: { mode: shareMode === 'shares' ? GOAL_MODE.SHARES : GOAL_MODE.RETURN, totals: shareMode === 'shares' ? totals : Array(FACTIONS).fill(0n), root: tree.root, ledgerHash } };
}
