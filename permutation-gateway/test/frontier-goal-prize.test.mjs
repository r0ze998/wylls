// World goals' prize pool SDK (client/src/frontier/goal-prize.mjs; permutation-prize feature `goals`): addresses against
// @solana/web3.js's own PDA search, instruction bytes against permutation-prize/src/goals.rs's layouts, and the ledger
// adapter's eligibility (design record §7.3, §7.4, Q7, Q17 b, Q19) — the program refuses exactly the rows the ledger
// leaves out (workstreams/04-execution/e2e-native/tests/chain_goals.rs runs the program's side).
import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { u32le, u64le } from '../client/src/bytes.mjs';
import { leafHash, nodeHash, PRIZE_ERRORS, PRIZE_TAG } from '../client/src/frontier/prize.mjs';
import {
  achieveIx, buyPassIx, decodeGoal, decodeGoalPool, decodePass, GOAL_MODE, goalAddress, goalClaimIx, goalPoolAddress, goalPoolAddresses, goalShares,
  initGoalPoolIx, passAddress, passValidAt, postGoalIx, receiptAddress, RECOMMENDED, setGoalSharesIx, shareAmount,
} from '../client/src/frontier/goal-prize.mjs';

const pk = n => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const PRIZE = pk(1), GAME = pk(2), MINT = pk(3), OP = pk(4), SEASON = pk(5);
const pda = (seeds, program = PRIZE) => PublicKey.findProgramAddressSync(seeds.map(s => Buffer.from(s)), new PublicKey(program))[0].toBase58();

test('goal pool addresses: ["gpool", game, le64(season)], ["gpass", gpool, wallet], ["goal", gpool, kind, le32(round)], ["gclaim", goal, wallet]', () => {
  const gpool = goalPoolAddress(PRIZE, GAME, 9n);
  assert.equal(gpool, pda([Buffer.from('gpool'), new PublicKey(GAME).toBuffer(), u64le(9n)]));
  assert.equal(passAddress(PRIZE, gpool, pk(11)), pda([Buffer.from('gpass'), new PublicKey(gpool).toBuffer(), new PublicKey(pk(11)).toBuffer()]));
  const goal = goalAddress(PRIZE, gpool, 0, 1);
  assert.equal(goal, pda([Buffer.from('goal'), new PublicKey(gpool).toBuffer(), [0], u32le(1)]));
  assert.notEqual(goal, goalAddress(PRIZE, gpool, 1, 1));
  assert.notEqual(goal, goalAddress(PRIZE, gpool, 0, 2));
  assert.equal(receiptAddress(PRIZE, goal, pk(11)), pda([Buffer.from('gclaim'), new PublicKey(goal).toBuffer(), new PublicKey(pk(11)).toBuffer()]));
  const gp = goalPoolAddresses({ prizeProgram: PRIZE, gameProgram: GAME, seasonId: 9n, mint: MINT });
  assert.equal(gp.vault, pda([Buffer.from('vault'), new PublicKey(gpool).toBuffer()]));
});

test('the SDK names the goal tags and errors (permutation-prize lib.rs)', () => {
  assert.deepEqual([PRIZE_TAG.INIT_GOAL_POOL, PRIZE_TAG.BUY_PASS, PRIZE_TAG.POST_GOAL, PRIZE_TAG.ACHIEVE, PRIZE_TAG.GOAL_CLAIM, PRIZE_TAG.GOAL_WITHDRAW_OPS], [13, 14, 15, 16, 20, 23]);
  assert.deepEqual([0x118, 0x119, 0x11a, 0x11b, 0x11c, 0x11d, 0x11e].map(c => PRIZE_ERRORS[c]),
    ['NotAchieved', 'PassNotValid', 'MemberTooRecent', 'BelowMinimum', 'DisputeOpen', 'ClaimClosed', 'RealMoneyMint']);
});

test('instruction bytes follow goals.rs (init 78 B, post 45 + 4n B, claim 10 + 32n B; account order)', () => {
  const gp = goalPoolAddresses({ prizeProgram: PRIZE, gameProgram: GAME, seasonId: 9n, mint: MINT });
  const init = initGoalPoolIx({ gp, operator: OP, season: SEASON, paramsHash: new Uint8Array(32).fill(9) });
  assert.equal(init.data.length, 1 + 78);
  assert.equal(init.data[0], 13);
  assert.deepEqual([...init.data.subarray(1, 9)], [...u64le(25_000_000n)]);
  assert.deepEqual([...init.data.subarray(39, 47)], [0xa0, 0x0f, 0xd0, 0x07, 0xd0, 0x07, 0xd0, 0x07]); // 4000, 2000 ×3
  const post = postGoalIx({ gp, operator: OP, season: SEASON, kind: 0, round: 1, need: 3, holdBells: 144, payoutBps: 3000, postingHash: new Uint8Array(32), flags: [{ p: 2, q: 0 }, { p: 40, q: -10 }] });
  assert.equal(post.data.length, 1 + 45 + 8);
  assert.deepEqual([...post.data.subarray(50, 54)], [40, 0, 0xf6, 0xff]);
  assert.equal(post.keys[2].pubkey, goalAddress(PRIZE, gp.gpool, 0, 1));
  const buy = buyPassIx({ gp, wallet: pk(11) });
  assert.equal(buy.keys.length, 10);
  assert.equal(buy.keys[3].pubkey, passAddress(PRIZE, gp.gpool, pk(11)));
  const goal = goalAddress(PRIZE, gp.gpool, 0, 1);
  const claim = goalClaimIx({ gp, goal, wallet: pk(11), citizen: pk(12), nation: 2, points: 30n, proof: [new Uint8Array(32)] });
  assert.equal(claim.data.length, 1 + 10 + 32);
  assert.equal(claim.keys.length, 12);
  assert.ok(claim.keys[0].isSigner && claim.keys[0].isWritable, 'the wallet pays its receipt');
  assert.equal(achieveIx({ gp, goal, season: SEASON, provinces: [pk(20), pk(21)] }).keys.length, 5);
  const ss = setGoalSharesIx({ gp, operator: OP, goal, mode: GOAL_MODE.SHARES, totals: [0n, 0n, 55n, 0n, 0n, 0n], root: new Uint8Array(32), ledgerHash: new Uint8Array(32) });
  assert.equal(ss.data.length, 1 + 1 + 48 + 64);
});

test('decoders read goals.rs offsets; a pass is checked against both spans', () => {
  const g = new Uint8Array(448);
  g.set(Buffer.from('WYPRGOAL'));
  g[9] = 0; g[10] = 2; g[11] = 0b100; g[14] = 3; g[15] = 2;
  g.set(u32le(1), 16); g.set(u32le(144), 20); g.set(u32le(400), 24); g.set(u32le(564), 28);
  g.set(u64le(30_000_000n), 136);
  g.set([2, 0, 0, 0, 40, 0, 0xf6, 0xff], 312);
  const d = decodeGoal(g);
  assert.deepEqual([d.state, d.winners, d.need, d.round, d.holdBells, d.postedBell, d.achievedBell, d.payout], [2, [2], 3, 1, 144, 400, 564, 30_000_000n]);
  assert.deepEqual(d.flags, [{ p: 2, q: 0 }, { p: 40, q: -10 }]);
  assert.equal(decodeGoal(new Uint8Array(448)), null);
  const gp = new Uint8Array(448);
  gp.set(Buffer.from('WYPRGPOL'));
  gp.set(u64le(70_000_000n), 248);
  assert.equal(decodeGoalPool(gp).treasury[0], 70_000_000n);
  const p = new Uint8Array(96);
  p.set(Buffer.from('WYPRGPAS'));
  p.set(u64le(1000n), 48); p.set(u64le(2000n), 56); p.set(u64le(100n), 64); p.set(u64le(500n), 72);
  const pass = decodePass(p);
  assert.ok(passValidAt(pass, 1000) && passValidAt(pass, 499) && !passValidAt(pass, 500) && !passValidAt(pass, 2000) && !passValidAt(null, 1000));
});

const verify = (root, leaf, proof) => proof.reduce((h, s) => nodeHash(h, s), leaf).every((b, i) => b === root[i]);

test('goalShares: the eligible are paid by points; operator AI, external AI, late members and passless wallets are not', () => {
  const goal = { address: pk(30), kind: 0, round: 1, achievedBell: 564, achievedTs: 1_000_000 + 564 * 600, winners: [2], payout: 30_000_000n };
  const pass = { validFrom: 1_000_000, validUntil: 1_000_000 + 30 * 86_400, prevFrom: 0, prevUntil: 0 };
  const late = { validFrom: goal.achievedTs + 1, validUntil: goal.achievedTs + 30 * 86_400, prevFrom: 0, prevUntil: 0 };
  const members = [
    { wallet: pk(11), nation: 2, joinBell: 0 }, { wallet: pk(12), nation: 2, joinBell: 0 }, { wallet: pk(14), nation: 2, joinBell: 450 },
    { wallet: pk(15), nation: 2, joinBell: 0, operator: true }, { wallet: pk(16), nation: 2, joinBell: 0 }, { wallet: pk(17), nation: 2, joinBell: 0, external: true },
    { wallet: pk(18), nation: 2, joinBell: 0 }, { wallet: pk(13), nation: 1, joinBell: 0 },
  ];
  const points = new Map([[pk(11), { nation: 2, points: 30 }], [pk(12), { nation: 2, points: 10 }], [pk(14), { nation: 2, points: 5 }], [pk(15), { nation: 2, points: 20 }],
    [pk(16), { nation: 2, points: 5 }], [pk(17), { nation: 2, points: 5 }], [pk(18), { nation: 2, points: 5 }], [pk(13), { nation: 1, points: 50 }], [pk(19), { nation: 2, points: 3 }]]);
  const passes = new Map([[pk(11), pass], [pk(12), pass], [pk(14), pass], [pk(15), pass], [pk(17), pass], [pk(18), late], [pk(13), pass]]);
  const s = goalShares({ goal, points, members, passes, rules: { memberBells: 144, minPayout: RECOMMENDED.minPayout } });
  const why = Object.fromEntries(s.rows.map(r => [r.wallet, r.why]));
  assert.deepEqual([why[pk(11)], why[pk(12)], why[pk(14)], why[pk(15)], why[pk(16)], why[pk(17)], why[pk(18)], why[pk(19)]],
    [null, null, 'member-too-recent', 'operator-ai', 'no-valid-pass', 'external-ai-legal-review', 'no-valid-pass', 'not-a-member-read']);
  assert.equal(s.rows.some(r => r.wallet === pk(13)), false, 'a losing nation\'s member is not in the ledger');
  // Q17 (b): the operator AI's 20 points are not in the total — only a's 30 and b's 10.
  assert.deepEqual(s.totals, [0n, 0n, 40n, 0n, 0n, 0n]);
  const amt = Object.fromEntries(s.rows.map(r => [r.wallet, r.amount]));
  assert.equal(amt[pk(11)], 22_500_000n);
  assert.equal(amt[pk(12)], 7_500_000n);
  assert.equal(s.returned, 0n);
  assert.equal(s.leaves.length, 2);
  assert.ok(verify(s.root, leafHash(goal.address, pk(11), 2, 30n), s.proofs.get(pk(11))));
  assert.ok(verify(s.root, leafHash(goal.address, pk(12), 2, 10n), s.proofs.get(pk(12))));
  assert.equal(s.proofs.has(pk(15)), false);
  assert.equal(s.setShares.mode, GOAL_MODE.SHARES);
  // The ledger is published: its hash is over its canonical JSON.
  assert.equal(s.ledger.goal.payout, '30000000');
  assert.equal(s.ledgerHash.length, 32);
  assert.equal(shareAmount(30_000_000n, 1n, 30n, 40n), 22_500_000n);
});

test('goalShares: ties split by nations first; a nation with no eligible member and shares under the minimum are left to the sweep', () => {
  const goal = { address: pk(31), kind: 0, round: 2, achievedBell: 600, achievedTs: 2_000_000, winners: [4, 1], payout: 1_000_000n };
  const pass = { validFrom: 0, validUntil: 3_000_000, prevFrom: 0, prevUntil: 0 };
  const members = [{ wallet: pk(41), nation: 4, joinBell: 0 }, { wallet: pk(42), nation: 4, joinBell: 0 }, { wallet: pk(43), nation: 1, joinBell: 590 }];
  const points = new Map([[pk(41), { nation: 4, points: 999 }], [pk(42), { nation: 4, points: 1 }], [pk(43), { nation: 1, points: 10 }]]);
  const s = goalShares({ goal, points, members, passes: new Map([[pk(41), pass], [pk(42), pass], [pk(43), pass]]), rules: { memberBells: 144, minPayout: 10_000n } });
  const amt = Object.fromEntries(s.rows.map(r => [r.wallet, r.amount]));
  assert.equal(amt[pk(41)], 500_000n * 999n / 1000n);
  assert.equal(amt[pk(42)], 0n, '500 under the 10,000 minimum');
  assert.equal(amt[pk(43)], 0n);
  assert.deepEqual(s.totals, [0n, 0n, 0n, 0n, 1000n, 0n]);
  assert.equal(s.returned, 1_000_000n - amt[pk(41)]);
  assert.equal(s.leaves.length, 1);
  assert.deepEqual(s.ledger.goal.winners, [1, 4]);
});

test('goalShares: all eligible points zero → one point each; nobody eligible → RETURN', () => {
  const goal = { address: pk(32), kind: 1, round: 1, achievedBell: 600, achievedTs: 2_000_000, winners: [0], payout: 900_000n };
  const pass = { validFrom: 0, validUntil: 3_000_000, prevFrom: 0, prevUntil: 0 };
  const members = [{ wallet: pk(51), nation: 0, joinBell: 0 }, { wallet: pk(52), nation: 0, joinBell: 0 }, { wallet: pk(53), nation: 0, joinBell: 0 }];
  const s = goalShares({ goal, points: new Map(), members, passes: new Map(members.map(m => [m.wallet, pass])), rules: { memberBells: 144, minPayout: 0n } });
  assert.deepEqual(s.rows.map(r => [r.mode, r.points, r.amount]), Array(3).fill(['equal', 1n, 300_000n]));
  const none = goalShares({ goal, points: new Map(), members, passes: new Map(), rules: { memberBells: 144, minPayout: 0n } });
  assert.equal(none.mode, 'return');
  assert.equal(none.setShares.mode, GOAL_MODE.RETURN);
  assert.deepEqual(none.setShares.totals, Array(6).fill(0n));
  assert.equal(none.returned, 900_000n);
});

test('goalShares: with the clock known, only lines while the pass was valid count (§7.4)', () => {
  const genesisTs = 1_000_000, bellSecs = 600;
  const goal = { address: pk(33), kind: 0, round: 1, achievedBell: 500, achievedTs: genesisTs + 500 * bellSecs, winners: [3], payout: 1_000_000n };
  // a's pass lapsed between bells 100 and 300; its line at bell 200 does not count.
  const pass = { validFrom: genesisTs + 300 * bellSecs, validUntil: genesisTs + 900 * bellSecs, prevFrom: genesisTs, prevUntil: genesisTs + 100 * bellSecs };
  const points = new Map([[pk(61), { nation: 3, points: 30, lines: [{ bell: 50, points: 10 }, { bell: 200, points: 10 }, { bell: 400, points: 10 }] }],
    [pk(62), { nation: 3, points: 10, lines: [{ bell: 450, points: 10 }] }]]);
  const members = [{ wallet: pk(61), nation: 3, joinBell: 0 }, { wallet: pk(62), nation: 3, joinBell: 0 }];
  const both = { validFrom: genesisTs, validUntil: genesisTs + 900 * bellSecs, prevFrom: 0, prevUntil: 0 };
  const s = goalShares({ goal, points, members, passes: new Map([[pk(61), pass], [pk(62), both]]), rules: { memberBells: 144, minPayout: 0n, genesisTs, bellSecs } });
  assert.deepEqual(s.rows.map(r => r.points), [20n, 10n]);
  assert.deepEqual(s.totals[3], 30n);
});
