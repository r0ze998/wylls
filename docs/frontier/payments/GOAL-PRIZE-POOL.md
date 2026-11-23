# World goals' prize pool (feature `goals`; test USDC, localnet and devnet only)

**Status (2026-11-24).** This implements §10.1 of the design record
[`docs/design/win-conditions/01-proposal.ja.md`](../../design/win-conditions/01-proposal.ja.md) in the prize program,
as decided by r0ze (2026-11-24 00:21 JST t481u and 01:04 JST t485u, every recommendation of #191 rev 2 accepted). It is
**test USDC only, localnet and devnet only**. A real-money prize needs a legal review first (owner, 2026-11-18 t351u).
Nothing was deployed. No SOL was spent and no real key was used.

The off-chain judge and the "would-have-won" card are PR #198 (`world-goals.mjs`). This program is the next step: the
same judge on chain for the flag keeps, and real test-USDC payouts.

## 1. What changed and why

The ⑰ epoch pool needs an end bell, and it counts every keep of rings 0–17 in a bitmap (`RING_17`). A world goal has no
deadline. It is achieved whenever a nation meets it, and the devnet playable world reaches ring 128. So the goal pool is
a new kind of pool, not a new kind of epoch.

| §10.1 | Before | Now (feature `goals`, `permutation-prize/src/goals.rs`) |
|---|---|---|
| P1 | The winner is set at `end_bell` | `Achieve` judges at the achievement bell from the keeps as they are now. There is no freeze and no end bell. |
| P2 | Bitmap of rings 0–17 | Only the posted flag provinces are read, on any ring (Q18). Wide-land keeps are not read (§6). |
| P3 | One pool per window | One **goal pool** per season with four per-kind treasuries, and one **goal** account per (kind, round). |
| P4 | `prize ÷ nations × points` | `payout = treasury[kind] × payout_bps`, fixed at posting and taken at the achievement. The rest stays for the next round. |
| P5 | SetShares once per pool | `SetGoalShares` once per goal (merkle root + ledger sha256), with one receipt PDA per (goal, wallet). |
| P6 | An Entry per window | A **30-day pass** (E2). The program checks that it was valid at the achievement bell's time. |
| P7 | Sweep to a later epoch | `GoalSweep` returns the unclaimed rest to the kind's treasury after `claim_secs`. |
| P8 | Only keeps can be read | Science, wonder and exploration use `AttestAchieve` (winners + evidence hash) and a dispute window, during which the operator may `VoidGoal`. |
| P9 | `NO_OPERATOR_AI` refuses Pay/Claim | The same ExcludeWallet mark refuses `BuyPass` and `GoalClaim`. The ledger leaves AI points out of the totals (Q17 b). |
| P10 | `VOID_AFTER_CLOSE` | Not used. |
| P11 | Feature `epochs` | Feature **`goals`**, OFF by default, with the marker `PRZ_GOALS_TEST_USDC_BUILD`. |
| P12 | Ledger at the season's end | The ledger is computed at the achievement (PR #198 `pointsOf`). See `goalShares` in `client/src/frontier/goal-prize.mjs`. |

## 2. Instructions (tags 13–23)

| tag | instruction | who |
|---|---|---|
| 13 | InitGoalPool(pass_fee, ops_bps, pass_secs, claim_secs, member_bells, dispute_secs, retire_secs, min_payout, kind_bps[4], params_hash) | the season's authority, continuous world, running |
| 14 | BuyPass | any wallet without an operator-member mark |
| 15 | PostGoal(kind, round, need, hold_bells, payout_bps, posting_hash, flags) | operator; the round must be the kind's next, and none of that kind may be live |
| 16 | Achieve | anyone (hegemony) |
| 17 | AttestAchieve(winners, achieved_bell, evidence_hash) | operator (the other three kinds) |
| 18 | VoidGoal | operator, during the dispute window |
| 19 | SetGoalShares(mode SHARES/RETURN, totals[6], root, ledger_hash) | operator, after the dispute window |
| 20 | GoalClaim(nation, points, proof) | the wallet |
| 21 | GoalSweep | anyone, after the claim window |
| 22 | RetireGoal | operator, `retire_secs` (30 days) after posting, unachieved (Q5) |
| 23 | GoalWithdrawOps | operator |
| 12 | ExcludeWallet (now built with `epochs` or `goals`) | the season's join gate |

**The flag-keeps judge** is `judge_flags` in `goals.rs`, PR #198's `progressOf` + `achievementOf`:

1. A flag held by nation n counts from `max(since_bell, posted_bell)`. It is held long at that bell plus `hold_bells`.
2. It is taken as known only when its province has resolved that far (`long_at ≤ resolved_next`).
3. A nation reaches the goal at its need-th earliest held-long bell. The earliest such bell wins, and nations at the same bell tie.
4. `ProvinceNotFinal` is returned while any flag province lags behind that bell, because a tie there could still be unseen.

**Eligibility checked on chain at GoalClaim (§7.4).** A claim needs all of these:

- The pass covered the achievement bell's time. The pass keeps its current and its previous validity span.
- The wallet's Citizen is of a winning nation.
- The Citizen's `join_bell + member_bells ≤ achieved_bell` (24 h, Q19).
- The wallet has no operator-member mark.
- The share is at least `min_payout`.
- The claim window is open.
- No receipt exists yet for this wallet and goal.

**Split (§7.3 a).** The program uses `share_amount(payout, number of winning nations, points, nation's total)`. A winning
nation with no eligible member leaves its part to the sweep (§7.3 "その達成の分は賞金庫に戻す"; #198 `splitPrize`).

**Money in (§7.1, §7.2).** The program takes `ops_bps` of each pass (20%). The rest goes to the four treasuries by
`kind_bps` (40/20/20/20). A kind that has never been posted sends its part to hegemony. The treasuries are counters over
one vault, and the test checks `vault == Σ treasuries` after every flow.

## 3. Legal gate

These gates keep the prize to test assets:

- The default and `epochs` builds contain no goal instruction. `scripts/build-prize.sh` refuses a goals marker in any
  build other than `--features goals`, and refuses a goals build without it.
- `InitGoalPool` refuses Circle's mainnet USDC mint (`RealMoneyMint`). It also needs a continuous world (`FiniteSeason`
  otherwise).
- Nothing in this change deploys anything. The devnet profile (`scripts/devnet/devnet-profile.json`) is unchanged: its
  prize section stays `enabled: false` and names only the epochs marker.

## 4. Comparable open-source designs

| Design | Claim record | Amount in leaf? | Expiry | What we took |
|---|---|---|---|---|
| [Uniswap merkle-distributor](https://github.com/Uniswap/merkle-distributor) (EVM) | a claimed **bitmap by index** in the contract | yes (index, account, amount) | none in v1 | Sorted-pair merkle proofs; one root per distribution. |
| [Jito / Saber merkle-distributor](https://github.com/jito-foundation/distributor) ([Saber](https://github.com/saber-hq/merkle-distributor)) (Solana, Anchor) | a **ClaimStatus PDA** `["ClaimStatus", claimant, distributor]` created with `init`, so a second claim fails | yes (unlocked, locked) | `clawback_start_ts` → `clawback` to a receiver | **Per-claim receipt PDA** for double-claim refusal; **clawback** after a deadline, here back into the kind's treasury. |
| [Morpho Universal Rewards Distributor](https://github.com/morpho-org/universal-rewards-distributor) (EVM) | per-account **claimed so far**; the root carries **cumulative** amounts, updated over time | yes (cumulative) | root updates with a timelock | Not taken: one cumulative root fits a stream of rewards, but each goal needs its own eligibility (pass at the achievement, tenure, winners). The timelock matches our dispute window for attested goals. |

The main difference from all three: our leaf is `(wallet, nation, points)`, not an amount (the existing `crate::leaf`,
keyed by the goal's address). The program computes the amount with `share_amount`. So a ledger can never authorise more
than the goal's payout, and the on-chain eligibility checks still run. A wallet signs its own claim and pays its own
receipt rent, as in Jito's distributor.

## 5. Tests

| Suite | What | Where it runs |
|---|---|---|
| `cargo test --features goals` (permutation-prize) | layouts; init params; fee split into kinds; pass renew/lapse; the flag judge (ties, lag, overflow); payout; data builders | CI `prize-program` (add `--features goals`, see the PR) |
| `workstreams/04-execution/e2e-native/tests/chain_goals.rs` | the program's own code on the host: passes, PostGoal, Achieve, shares, claims with every refusal, sweep, ops, attested kinds (dispute, void, return, tie), retire, legal gate | CI `exec-native` (key-free) |
| `permutation-gateway/test/frontier-goal-prize.test.mjs` | SDK addresses against web3.js, instruction bytes, decoders, `goalShares` eligibility and split | local (`node-key-tests.txt`) |
| `permutation-gateway/scripts/goal-prize-localnet-e2e.mjs` | the SBF `--features goals` build on frontier-localnet, real signed transactions, 37 checks, compute units | local (needs the `.so` and `frontier-localnet`) |

## 6. Not done here

- **Wide-land keeps** are not read as flags. They live in the world index's records, not in Province accounts. PR #198's
  judge reads Province keeps only, too.
- No stack, launcher or relay integration (`--prize-goals`), and no page UI for passes or claims.
- External AI residents cannot be told from people on chain. The ledger leaves them out until the legal review (Q7).
- Contribution lines for wonder (caravan deliveries), science (pledges) and exploration (expedition troops) do not exist
  yet (§4.2–§4.4). Those kinds can only be attested.
