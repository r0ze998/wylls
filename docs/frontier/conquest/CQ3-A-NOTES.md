# CQ3-A notes: the verifier on conquest seasons (work in progress)

Branch `frontier/season-complete` (worktree `.claude/worktrees/season-complete`), started 2026-10-17. Local commits only, nothing pushed.

## Why

Before this branch, `verify_core::verify` ran **only** the conquest audit (`crates/verify/src/conquest.rs`: event chains, final state, identity, territory time) on a conquest-program season (program version 3). The M1 suite V1–V13 (seals, clash and skip replay, quotas, lag, land, payments) did not run at all, and the conquest rule checks V14–V22 of [the conquest contract §8.5](CONQUEST-CONTRACT.md) do not exist. So "the verifier replays the season" held only for the old M1 program.

## Done (verified on a live bot season, see below)

| Change | Where |
|---|---|
| World decodes records with the ABI v2 decoder; conquest records (80–88) kept in `World::cq_recs`; one in an M1 season is a V1 `Undecodable` FAIL | `world.rs`, `checks/mod.rs` |
| A conquest season: V1's chain walk is the conquest audit's CQ1; `verify()` merges both reports | `checks/mod.rs`, `lib.rs`, `report.rs` |
| CreateSeason v2 parameters (conquest block) in Facts; V2 hashes them with `params_hash_v2` | `facts.rs`, `checks/v2_program.rs` |
| V11: initial camp with `camp::place_v2` and the symmetric keep tile | `checks/v11_land.rs` |
| V7 skip: `skip::replay_v2` in the program's v2 order (camp_check_v2 → is_quiet on build_v2 at every bell → report from masks → settle → `conquest_model::step` → finish); `quiet_digest_v2`. Not independent: it calls the program's shared `frontier_abi::{clash_model, conquest_model}` | `skip.rs`, `checks/v7_replay.rs` |
| V7 holdings: a conquest Holding (header `layout_version` 2) keeps its stored `shield_until` | `holding.rs` |
| V7 holdings: a conquest season's Train is replayed with `catalog::train_v2` (K2: the Horseman at a Spearman's ore and gold); was `train` (the 9 × byte 272 = `stores[Ore].value`) | `holding.rs`, `checks/v7_replay.rs` |
| V7 continuity: a founding (HOME_PLACED, SETTLE fresh/displace) in a conquest season writes `shield_until = now + shield_secs_for(order, now, genesis)` from the CreateSeason conquest block (`holding::{lifecycle, founding_shield}`, a transcription of the program's `layout::conquest::lifecycle`); an outpost founding (OUTPOST_SETTLED beside the SETTLE: order 2–3) has no starter kit. Was: the shield compared against 0 (byte 144) | `holding.rs`, `checks/v7_replay.rs` |
| V7 clash: a CLASH on a v2 Province is replayed by `clash_v2::replay` in the program's v2 order (`input_digest_v2 → build_v2 → resolve_clash → report_from_outcome → apply_v2 → settle_bell → conquest_model::step → finish_bell`, then `last_digest`, the summary, the ClashInputs fate table, the resolved flag, the camp mask); the record's digests, engagements and fates, and the Province and ClashInputs written (every byte but the chain header and the resolver's own fields) must be the replay's. Not independent (the shared models), as the skip replay | `clash_v2.rs`, `checks/v7_replay.rs` |
| V7 continuity: an OUTPOST_SETTLED record's `shield_until` must be the season's founding shield | `checks/v7_replay.rs` |
| V14 (`V14:siege-declaration`): every SIEGE_DECLARED re-judged from the states before its transaction in the program's order (MC §3.4 steps 1–10: the season running, the source final and the citizen's, the target a holding at the mirror's generation or a Free City, the Province resident, the declaring entry the citizen's own non-civilian roster host on the tile and the hex's lead (`v2::entry::lead_host`), the record free / owing nothing / not immune (`immunity_bars`), the day's cap, the free slot of a capture, `may_besiege_v3` with the season's timers and the source unshielded, the walls' `required_bells` completable before the end over the owner's vigil snapshot, the stake in the source's settled gold) and the record's payload equal to what those facts give → `SiegeIllegal`, `SiegeAfterEndRule`. V7's continuity knows a DeclareSiege's source write (touch + stake) and leaves SettleSiege / SettleCapture / RetireHost Holding writes to V17 (unwritten). **Unexercised by a bot season** (no fleet ever declared); exercised by `conquest-drive.mjs` below | `checks/v14_sieges.rs`, `checks/v7_replay.rs` |
| V15 / V18 / V19 at the record level (`V15:conquest-records`): every CONQUEST, KEEP (cause TAKEN) and RETIRE (by the keep donor) record of a transaction, in order, equals what the replayed conquest step leaves (`cqrec::of_step` rebuilds them as the program's `emit_conquest` does, from `StepOut` and the Province after the bell; V7's v2 skip and clash replays collect them per transaction in `Ctx::cq_expected`). A site event differing is `SiegeProgressMismatch`, a keep event / keep fields / KEEP / RETIRE `KeepMismatch`, a snapshot `SnapshotMismatch`; records of a transaction V7 did not replay are `MissingData`. On sc-cq2d's final input: 2,988 CONQUEST and the one KEEP TAKEN all equal the replay's | `cqrec.rs`, `checks/v15_records.rs`, `skip.rs`, `clash_v2.rs`, `checks/v7_replay.rs` |
| V22 (partial, `V22:outpost-filing`): every FileOutpost re-judged from the states before its transaction with the kernel's `may_found_outpost` as the program does (no ticket open, the anchor a final first holding at the named generation, the free slot, the Town prerequisite on the anchor's tier after the touch, slot 3 over a final slot 2, each site in an opened ring ≥ 2 above the heartland, within `outpost_range`, the faction's share of the target's strength weight (`province_weights` transcribed) below `outpost_share_bps`, the land gate, the outpost close, the site's conquest record zero) → `OutpostIllegal`. V7's continuity knows a FileOutpost's anchor write (the touch and the settler cost, `holding::{settler_cost, touched_paid}`). **Unexercised**: no run has filed an outpost yet | `checks/v22_outposts.rs`, `holding.rs`, `checks/v7_replay.rs` |
| V16 (partial, `V16:first-holding-owner`): a Holding of order 1 keeps its owner while its generation is unchanged; a CAPTURE_SETTLED into slot 1 fails (`FirstHoldingTransferred`) | `checks/v16_owner.rs`, `codes.rs` |
| V11: a conquest Province's daily camp check is `clash_model::camp_check_v2` with the keep tile (never on the keep); was M1's `camp_at`, which placed the day-1 respawn one tile off on four provinces (`CampMismatch` ×4 at bell 146) | `checks/v11_land.rs` |
| V17 (partial, `V17:capture-settlement`): every CAPTURE_SETTLED against the states before and after, as `settle_capture` writes them: the record a capture due with the captor as actor and the slot reserved; the Holding after the captor's at the mirror's generation, of the slot's order, final, captured at the completion bell, unshielded, the doctrine's walls, stores zeroed unless credited, reserve and delegate cleared (a Free City: founded at the mirror's tier); the captor's Citizen (slot, `holdings_n`, reservation, escrow) and JoinShard; the victim's Citizen and JoinShard; the stake back to a live source (capped); the record's post-capture immunity; the payload; **the capture lock** (no player instruction on the Holding between the CONQUEST capture-due event and the settlement) → `CaptureRule`, `CaptureBookkeeping`, `CaptureLockBroken`. Not judged: the bond and rent lamports, RetireHost, the `prev_gen` transit path, a double capture. Exercised on sc-drive's Free City capture (a flipped expectation fails, the real one passes) | `checks/v17_captures.rs` |
| V19 (partial, `V19:march-folds`): every FoldMarch replayed from the states before its transaction with the shared model (`conquest_model::{fold, first_hour, apply_fold}`): the seven members' hour samples, the MarchState created at `first_hour` on the first fold, each hour applied; every MARCH_FOLD record of the transaction must be the fold's 44-byte log in order and the MarchState written the replay's (`MarchFoldMismatch`). Not judged: the Dominion sums of credited captures, the herald's files. On sc-drive (1,560 MARCH_FOLD), sc-cq2d (624) and sc-14d's snapshot (546): all equal (a flipped comparison fails them all) | `checks/v19_folds.rs` |
| V20 (partial, `V20:season-end`): no OCCUPIED / CAPTURE_DUE / KEEP_TAKEN at a step bell ≥ `end_bell` (`CompletionAfterEnd`); an Ended season has no SIEGE_DECLARED without a SIEGE_SETTLED (`SiegeNotSettled`); no OUTPOST_SETTLED within 24 bells of `end_bell` (`OutpostAfterClose`, read at the settle, the contract bounds the filing) | `checks/v20_end.rs`, `codes.rs` |
| Tamper suite on a conquest run (`frontier-stack tamper --run-id sc-cq2d`): `rec_at` looked a record up by its position among the transaction's M1 records, but `find` numbers every body, conquest records included (T17 panicked on a SKIP behind a CONQUEST; now by `pos`); a class expecting V1's chain code (`ChainGap`, `HeadMismatch`, `DuplicateEvent`) is satisfied by the conquest audit's CQ1 names (`tamper::cq_equivalents`), since CQ1 walks the chains in V1's place on a conquest season | `tamper.rs` |
| Six conquest tamper classes (contract §8.5), registered as extras (not required until a conquest fixture is committed; "not applicable" on an M1 run): T28 (+1 progress on a siege's CONQUEST event → `SiegeProgressMismatch`), T30 (a first holding's owner rewritten → `FirstHoldingTransferred`), T31 (a capture into an unreserved slot → `CaptureRule`), T36 (a MARCH_FOLD controller flipped → `MarchFoldMismatch`), T39 (an outpost filed in the anchor's own, heartland province → `OutpostIllegal`), T46 (the horn's entry moved to a non-lead → `SiegeIllegal`). Record and post-state edits are **not re-chained** (no v2-aware `rechain` yet), so CQ1's `ChainMismatch` is reported beside the named code for T28/T30/T36; T31/T39/T46 are instruction or pre-state edits and fail by the named code alone. On sc-drive all six detected (33 classes on the run); on sc-cq2d T30 and T36 detected, the rest not applicable | `tamper.rs` |
| Diagnostic: `cargo run --release --example suites -- INPUT.json.gz [--detail]` runs the two suites apart; `--detail` prints every finding and the record counts by kind | `examples/suites.rs` |

All verifier tests pass (83, including the 58 M1 tamper tests; 2 new unit tests in `holding.rs`). None of the new conquest paths has a tamper fixture yet: the live run below is their only exercise.

### The fleet did not march (fixed in the bots, commit `2978bae1`)

By bell 102 the run had no DEPART, no CLASH and no seal: every keep order of the campaign layer was dropped `no_path` (bots report: `skipped.order_no_path 24`, `hosts_sent 0`). Two causes in the fleet, found with a stderr line per drop added to `cqorder::step`:

1. `Bot::observe` loaded only the home province, its six neighbours and the marches' destinations; `path::plan` walks observed provinces only, so a keep two or more provinces away never had a path. The observation now adds an open order's target and the opened provinces on a shortest way from its source (`PROVINCE_LIMIT` 12 → 20).
2. An order is first stepped in the wake-up that issued it, over an observation taken before it existed. A `no_path` at the issue bell now keeps the order for the next observation (`order_no_path_retry`); a later one is final.

The fleet was restarted in place three times (the stack restarts a killed `frontier-bots` from the run's `bin/`; each counts as a crash in the run's state). First DEPART at bell ~157 (08:47 JST). One order still drops: a Horseman three provinces from its keep, beyond the 32-step path bound — the campaign planner's reach is coarser than the hex path. Not fixed.

## Live run used as input

`frontier-node/.local/frontier/sc-cq2d` (gitignored): conquest, test-USDC prize pool, 120 bots (`--bots-args "--conquest --conquest-personas 3"`), 48 game hours at 20x, season 201, base port 41700, started 2026-10-17 07:30 JST.

```sh
# snapshot the running chain into verify/input.json.gz (pauses it briefly)
frontier-node/target/release/frontier-stack verify --run-id sc-cq2d --runs-dir frontier-node/.local/frontier
frontier-node/target/release/examples/suites frontier-node/.local/frontier/sc-cq2d/verify/input.json.gz
frontier-node/target/release/frontier-stack down --run-id sc-cq2d --runs-dir frontier-node/.local/frontier
```

Note: `target/release/frontier-stack` was built before these changes; rebuild it (`cargo build --release -p stack`) so its own `verify` uses the new verifier.

Results so far (same run, snapshots as it goes):

| Snapshot | V1–V13 | Conquest audit | Notes |
|---|---|---|---|
| 968 txs, 10 bells (07:31) | FAIL: V7 HoldingReplayMismatch ×9 | PASS | before the two fixes above (3 Train, 6 founding shield) |
| 968 txs, after the fixes | PASS (2 informational warns) | PASS | V2 ProgramMismatch (tx#9, not the program) and V9 PrefundedAddress (61 accounts) |
| 8,772 txs, 80 bells (08:06) | PASS (same 2 warns) | PASS | 49 joins, 215 Build, 154 Train, 71 Harvest, 89 Muster, 67 Explore, 793 CONQUEST, 54 KEEP; **clashes 0, seals 0**: the v2 clash path is still unexercised |

| 11,211 txs, 102 bells (08:17) | PASS (same 2 warns) | PASS | 57 joins, 339 Build, 174 Train, 91 Muster, 1,037 CONQUEST; still no DEPART (see the fleet note above) |
| 19,610 txs, 178 bells (08:55), after the fleet fix | FAIL: V11 CampMismatch ×4 (day-1 camps one tile off) → **PASS** after the `camp_check_v2` fix (same 2 warns) | PASS | **10 CLASH, 2 DEPART / REVEAL / TRANSIT_SETTLED / DEPARTURE_SETTLED, 12 GATHER, 6 CAMP**; one keep contest open ((-4, 1), 3 against 2, ETA bell 237). V7's v2 clash replay, V5, V6 and V8 pass on these |
| 26,082 txs, 238 bells (09:25) | PASS (same 2 warns) | PASS | 70 CLASH, 72 GATHER; the keep contest at (-4, 1) at 70/72 |
| 27,943 txs, 256 bells (09:34) | PASS (same 2 warns) | PASS | 72 CLASH; **the keep at (-4, 1) taken by nation 3 from 2 at bell 237** (KEEP 55: one `cause` TAKEN; CQ3's keep-holder and territory-time checks pass over it) |

The rebuilt `frontier-stack verify` (with this verifier) reports the same: PASS, "conquest season: V2–V13 with the v2 rules, chains, final state, identity and territory time by the conquest audit (CQ1–CQ3)".

**Tamper suite on the 19,610-tx snapshot** (`frontier-stack tamper --run-id sc-cq2d`, 19 s): before the two `tamper.rs` fixes, 24 of 30 classes detected, 5 "missed" with verdict FAIL but CQ1's code names (T1, T6, T12, T14, T1b), T17 panicked. After: **30 of 30 detected** (27 on the run, 3 — T15, T18, T22 — on the committed M1 fixture because the run cannot express them). These are the M1 classes T1–T24 and the extras over the v2 records; no class tampers a conquest record yet (T25–T48 not written).

### After the season (done 10:04 JST)

Play ended at bell 288, the stack's EndSeason landed (1 attempt), the fleet exited 0, the drain ran to "complete" (game 1785818712; the chain paused, resumed with `scripts/demo-clock.sh 41700 resume`). Then, from the repository root (docs/RUNNING.md, "The province tally"):

```sh
U=(--rpc http://127.0.0.1:41710 --relay http://127.0.0.1:41733 --herald http://127.0.0.1:41740)
node permutation-gateway/scripts/prize-settle.mjs "${U[@]}" --out .local/prize/sc-cq2d --ledger-file frontier-node/.local/frontier/sc-cq2d/relay/prize-ledger.json
node permutation-gateway/scripts/prize-settle.mjs "${U[@]}" --check
frontier-node/target/release/frontier-stack verify --run-id sc-cq2d --runs-dir frontier-node/.local/frontier
```

| Step | Result |
|---|---|
| `prize-settle.mjs` (Tally in chunks, Finalize) | both landed; provinces held per nation chain 9 / 9 / 8 / 10 / 9 / 9 (54 of 54 counted, final), pool = chain, herald (control file, turn 287) = chain; **winner: nation 3**. Achievements recomputed from the chain: one capture ((-4, 1), nation 3, turn 237) and one reinforcement (78 troops, turn 169), both by script bots (not prize-eligible). Prize pool **0 test USDC** (the fleet joined by invite, nobody paid): mode "refund", nothing transferred. Written to `.local/prize/sc-cq2d/{ledger,settle}.json` and the relay's `prize-ledger.json` |
| `prize-settle.mjs --check` | `poolMatchesChain: true`, `winnerIsLargestArea: true`, herald `matchesChain: true` |
| **Final verify** (32,687 txs, 5 failed; 315 bells; 9,779 accounts; read 0.9 s, verify 5.6 s) | **PASS**, V1–V13 (V1 as CQ1), V16, V20 and CQ1–CQ3; the same 2 informational warns. 72 CLASH, 2 DEPART / REVEAL / TRANSIT_SETTLED, 55 KEEP (one taken), 2,988 CONQUEST, 835 CLOSE, 416 ARCHIVE, 1 SEASON_STATUS (Ended: V20's siege rule ran with no open siege) |
| Tamper suite on the final input (`frontier-stack tamper`) | **30 of 30 detected** (27 on the run, 3 on the M1 fixture), as on the 19,610-tx snapshot; `frontier-stack report` written to the run's `report.md` (M1's season criteria over this run; informational here) |

What this season did **not** exercise: sieges (0 declared: the fleet's siege personas were staged, none fired), captures of holdings, outposts (16 `FileOutpost` refused `QuotaExceeded`), Free Cities changing hands, a paid entry (pool 0) and so a real payout, the 14-day preset (this was 48 game hours with `--season-end-at-play-end`). The v2 checks for those paths are either partial (V16, V20) or unwritten (V14, V15, V17–V19, V21, V22).

## Driving the conquest paths by hand (sc-drive, `permutation-gateway/scripts/conquest-drive.mjs`)

The script fleet never files an outpost (its economy never builds the Town tier-up, `agents::policy::economy` iterates the six buildings only) and never declared a siege in two seasons (the campaign planner keeps choosing keeps; the heartland is rings ≤ 3, so only ring-4 Free Cities and outposts are besiegeable). So a disposable stack (`frontier-stack up --conquest … --game-hours 120 --season-end-at-play-end --bots 0 --prize-so … --run-id sc-drive --base-port 41900`) is driven by one dev wallet through the browser's own modules: x402 join, PlaceHome, Build, 36 game hours of stores, Train 1,000, Muster, a sealed march onto a ring-4 Free City's tile, DeclareSiege (a capture siege; the keeper resolves the contested bells and settles the capture), the Town tier-up, FileOutpost (settled by the keeper), the season's end. The test clock is advanced with `frontier_setScale` as `prize-e2e.mjs` does.

Run 4 (season 205, 13:44 JST): home (1, 2, 10) of nation 0, the Free City (1, 3) site 2; the host of 1,000 arrived at bell ~236 with 965 troops (the city's garrison 300 → 104); **DeclareSiege landed at bell 243** (required 36, record flags HELD|NEUTRAL); the CONQUEST events carried progress 2, 8, 14, 20, 26, 32 at the keeper's resolves; by bell 299 the mirror showed the wallet's holding of order 2 (CAPTURE_SETTLED), the record cleared with `faction` 254 (barred all); the tier-up built and the village a Town. FileOutpost then refused `Insufficient` (the settler cost after the tier-up and the stake); the script got a resume mode and an outpost retry, see below.

**Verify at that point** (35,900 txs, 347 bells; 160 failed txs = the keeper's retries): **PASS** — V14 re-judged the declaration and its payload, V15 the siege's CONQUEST events, V16 the first holding, V7 the stake write and the settlement writes, CQ1–CQ3; records SIEGE_DECLARED 1, CAPTURE_SETTLED 1, CONQUEST 3,570, CLASH 41. Tamper suite 30 of 30.

Resumed (`CQ_DRIVE_RESUME=1`, 13:58): FileOutpost refused `Insufficient` once more, landed after 60 bells of stores at bell 410 (site (4, 0, 0), anchor the home, slot 3 since slot 2 holds the captured city); the keeper's SettleTicket founded the outpost (OUTPOST_SETTLED, order 3, no starter kit); the clock ran to the end (bell 720), EndSeason landed, every province resolved.

**Full-season verify** (82,037 txs, 723 bells, 23,409 accounts; verify 19 s): two findings first — (1) V7 `HoldingReplayMismatch` at the FileOutpost: the program logs a HARVEST of the anchor (its touch and the settler cost) and V7 counted an owner-action record without an owner instruction → FileOutpost's anchor is now an owner action of V7's replay (`Action::OutpostAnchor`); (2) V20 `SiegeNotSettled`: a capture siege is closed by SettleCapture, never by SIEGE_SETTLED → V20 now judges the final Provinces' records (none live or owing once the season ended). After both: **PASS** (V1–V13 with V1 as CQ1, V14, V15, V16, V20, V22, CQ1–CQ3), records SIEGE_DECLARED 1, CAPTURE_SETTLED 1, TICKET 1, SETTLE 1, OUTPOST_SETTLED 1, CONQUEST 7,352, SEASON_STATUS 1; V22 judged the filing legal, V7 founded the outpost with the outpost shield and no kit. Tamper suite on the full input: 30 of 30.

**The prize on sc-drive** (one paid member, pool 25 test units): Tally and Finalize landed; every nation holds 9 keeps (the capture was a Free City, not a keep) → all six tie, `--check` agrees three ways; the provisional split's mode came out "refund" (prize 20, operator 5); `--set-shares` posted; `paid-claim.mjs`'s Claim landed and the wallet received its 20 test units back. So Tally → Finalize → SetShares → Claim ran end to end on a local season (test tokens; the provisional rules decided the mode).

## The 14-day season (sc-14d, started 10:41 JST 2026-10-17)

`frontier-node/.local/frontier/sc-14d`: `frontier-stack up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 20 --days 14 --season-end-at-play-end --drain-bells 26 --bots 120 --seed 11 --personas off --bots-args "--conquest --conquest-personas 3" --prize-so … --entry-fee 25000000 --no-chaos --no-adversary --run-id sc-14d --base-port 41800 --season 202`, with `FRONTIER_RELAY_TXS_PER_DAY=120` in the relay's environment (commit `49d8c442`: sc-cq2d's 16 FileOutpost refusals were the relay's 40-a-day sponsorship quota, contract D4, spent on the economy before `expand` fired). The preset is `MC_LOCAL_14D` (2,016 bells, join close 1,512; heartland rings ≤ 3, so only ring 4's Free Cities and outposts can be besieged; a first holding's shield is 24 h). Play ends about 03:30 JST on 10-18, complete about 03:45. **Paid members** (11:05 JST, `permutation-gateway/scripts/paid-join.mjs`): three dev wallets took test USDC from the faucet, joined over x402 (25 test USDC each) into nations 0, 1 and 2 and placed their villages ((2, 0, 0), (0, 2, 0), (-2, 2, 0)); pool collected 75, prize 60, ops 15 (test units). Their key seeds are in `.local/prize/sc-14d/wallets.json` for the claims after `prize-settle.mjs --set-shares --operator-seed-file frontier-node/.local/frontier/sc-14d/keys/operator.seed`. Snapshots every two hours (verify + suites + the fleet's conquest counters); the end-of-season steps as for sc-cq2d, then `--set-shares` and the paid members' claims (`paid-claim.mjs`), armed in the background. Log: `/private/tmp/claude-501/sc-14d-up.log`.

| Snapshot | V1–V13 + V15/V16/V20/V22 | Conquest audit | Fleet |
|---|---|---|---|
| 26,935 txs, 244 bells (12:44) | PASS (2 warns) | PASS | 149 CLASH, 7 DEPART; keeps: 2 taken, 3 contested, 1 broken, 2 lost; **0 sieges declared, 0 outposts filed** (`expand` never fired; `own.file_outpost` 0/0) |
| 59,690 txs, ~475 bells (14:46), with V14–V19 | PASS (2 warns) | PASS | still 149 CLASH and 8 departs: the fleet's keep orders go stale (`order_stale` 55, `owner_unknown` 67) after the early contests; no siege, no outpost |
| 86,899 txs, 682 bells (16:25), with V14–V22 and the conquest tamper classes in the binary | PASS (2 warns; verify 27 s) | PASS | fleet unchanged (149 CLASH, 8 departs, 2 keeps taken); no siege, no outpost |
| 145,962 txs, 1,107 bells (19:57, day 8 of 14) | PASS (2 warns; verify 39 s) | PASS | fleet unchanged (149 CLASH, 8 departs, 2 keeps taken); no siege, no outpost |

## Next

1. (done) The first CLASH records: V7's v2 clash replay, V5, V6, V8 pass; V11's day camp fixed.
2. (done) The season's end: EndSeason, the drain, `prize-settle.mjs`, the full-season verify.
3. (mostly done 10-17 afternoon) V14, V15/V18/V19 (record level), V16 (partial), V17 (partial), V19 folds, V20, V22 are written and exercised on sc-drive. Left: V16's occupation and liberation effects, V17's bond and rent lamports / RetireHost / the `prev_gen` transit path, V19's Dominion sums, V21 the herald's files, V22's SettleTicket escrow / Free City and keep placement / S1–S6; the rest of the tampers T25–T48 (six are in; a v2-aware `rechain` would make the record edits clean for the mutate builds, and T33/T34/T41/T43 need it or a holding-target siege). The fleet never declares sieges nor files outposts (no tier-up in its economy; the planner prefers keeps) — a fleet change if bot seasons are to exercise those paths.
4. (running) The 14-day season above; a paid entry (x402 joins by dev wallets, as `prize-e2e.mjs` does) before bell 1,512 so the payout path runs at the end.
5. (done) README / DESIGN-OVERVIEW wording: the 2026-10-17 status paragraphs name what the verifier covers on a conquest season and what this run showed.
