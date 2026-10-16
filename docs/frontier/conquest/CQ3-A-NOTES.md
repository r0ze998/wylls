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
| Diagnostic: `cargo run --release --example suites -- INPUT.json.gz [--detail]` runs the two suites apart; `--detail` prints every finding and the record counts by kind | `examples/suites.rs` |

All verifier tests pass (83 + 2 new in `holding.rs`, including the 58 M1 tamper tests).

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

The rebuilt `frontier-stack verify` (with this verifier) reports the same: PASS, "conquest season: V2–V13 with the v2 rules, chains, final state, identity and territory time by the conquest audit (CQ1–CQ3)".

## Next

1. V7 clashes on the v2 path (`input_digest_v2 → build_v2 → kernel → report_from_outcome → apply_v2 → settle → step → finish`, program `proc/clash.rs` module note): V7's CLASH branch still runs the M1 builder and `input_digest` v1 on a v2 Province, so the first CLASH of a conquest season will FAIL until it dispatches like the SKIP branch does. Needs a snapshot with CLASH records (none by bell 80).
2. The rest of V1–V13 on a full season (V5 seals, V6 quotas, V8 lag, V13 payments with the prize program).
3. V14–V22 and tampers T25–T48 (contract §8.5), starting with V16 `FirstHoldingTransferred`, V20 season end, V19/V21 standings vs the herald's `final.json`. Cheap first step: the OUTPOST_SETTLED payload's `shield_until` against `founding_shield`.
4. Then a full 14-day season (`MC_LOCAL_14D`, about 17 h at 20x) verified end to end, with Tally/Finalize of the prize program.
5. Update README / DESIGN-OVERVIEW wording on what the verifier covers for conquest seasons once 1–2 pass.
