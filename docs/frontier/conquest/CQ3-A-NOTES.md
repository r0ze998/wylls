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
| V16 (partial, `V16:first-holding-owner`): a Holding of order 1 keeps its owner while its generation is unchanged; a CAPTURE_SETTLED into slot 1 fails (`FirstHoldingTransferred`) | `checks/v16_owner.rs`, `codes.rs` |
| V11: a conquest Province's daily camp check is `clash_model::camp_check_v2` with the keep tile (never on the keep); was M1's `camp_at`, which placed the day-1 respawn one tile off on four provinces (`CampMismatch` ×4 at bell 146) | `checks/v11_land.rs` |
| V20 (partial, `V20:season-end`): no OCCUPIED / CAPTURE_DUE / KEEP_TAKEN at a step bell ≥ `end_bell` (`CompletionAfterEnd`); an Ended season has no SIEGE_DECLARED without a SIEGE_SETTLED (`SiegeNotSettled`); no OUTPOST_SETTLED within 24 bells of `end_bell` (`OutpostAfterClose`, read at the settle, the contract bounds the filing) | `checks/v20_end.rs`, `codes.rs` |
| Tamper suite on a conquest run (`frontier-stack tamper --run-id sc-cq2d`): `rec_at` looked a record up by its position among the transaction's M1 records, but `find` numbers every body, conquest records included (T17 panicked on a SKIP behind a CONQUEST; now by `pos`); a class expecting V1's chain code (`ChainGap`, `HeadMismatch`, `DuplicateEvent`) is satisfied by the conquest audit's CQ1 names (`tamper::cq_equivalents`), since CQ1 walks the chains in V1's place on a conquest season | `tamper.rs` |
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

The rebuilt `frontier-stack verify` (with this verifier) reports the same: PASS, "conquest season: V2–V13 with the v2 rules, chains, final state, identity and territory time by the conquest audit (CQ1–CQ3)".

**Tamper suite on the 19,610-tx snapshot** (`frontier-stack tamper --run-id sc-cq2d`, 19 s): before the two `tamper.rs` fixes, 24 of 30 classes detected, 5 "missed" with verdict FAIL but CQ1's code names (T1, T6, T12, T14, T1b), T17 panicked. After: **30 of 30 detected** (27 on the run, 3 — T15, T18, T22 — on the committed M1 fixture because the run cannot express them). These are the M1 classes T1–T24 and the extras over the v2 records; no class tampers a conquest record yet (T25–T48 not written).

### After the season (planned)

Play ends at bell 288 (about 09:54 JST), the stack sends EndSeason and drains 26 bells, then leaves the services up ("complete"). Then, from the repository root (docs/RUNNING.md, "The province tally"):

```sh
U=(--rpc http://127.0.0.1:41710 --relay http://127.0.0.1:41733 --herald http://127.0.0.1:41740)
node permutation-gateway/scripts/prize-settle.mjs "${U[@]}" --out .local/prize/sc-cq2d --ledger-file frontier-node/.local/frontier/sc-cq2d/relay/prize-ledger.json
node permutation-gateway/scripts/prize-settle.mjs "${U[@]}" --check
frontier-node/target/release/frontier-stack verify --run-id sc-cq2d --runs-dir frontier-node/.local/frontier
```

## Next

1. The first CLASH records of sc-cq2d (marches began at bell ~157): V7's v2 clash replay, V5 seals, V6 quotas, V8 lag on them; fix what fails.
2. The season's end: EndSeason, the drain, `prize-settle.mjs` (Tally, Finalize, the recount), then the full-season verify (V13 payments with the prize program, V20 with an Ended season).
3. The rest of V14–V22 and the tampers T25–T48 (contract §8.5): V15 siege progress and V18 keep contests over the replayed bells, V19/V21 standings against the herald's `final.json`, V22 outpost legality. Tamper fixtures for the v2 paths (none exist: every v2 check above is exercised only by the live run).
4. Then a full 14-day season (`MC_LOCAL_14D`, about 17 h at 20x) verified end to end.
5. Update README / DESIGN-OVERVIEW wording on what the verifier covers for conquest seasons once 1–2 are done.
