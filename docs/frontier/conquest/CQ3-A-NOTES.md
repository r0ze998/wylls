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
| Diagnostic: `cargo run --release --example suites -- INPUT.json.gz` runs the two suites apart | `examples/suites.rs` |

All existing verifier tests pass (83, including the 58 M1 tamper tests).

## Live run used as input

`frontier-node/.local/frontier/sc-cq2d` (gitignored): conquest, test-USDC prize pool, 120 bots (`--bots-args "--conquest --conquest-personas 3"`), 48 game hours at 20x, season 201, base port 41700, started 2026-10-17 07:30 JST.

```sh
# snapshot the running chain into verify/input.json.gz (pauses it briefly)
frontier-node/target/release/frontier-stack verify --run-id sc-cq2d --runs-dir frontier-node/.local/frontier
frontier-node/target/release/examples/suites frontier-node/.local/frontier/sc-cq2d/verify/input.json.gz
frontier-node/target/release/frontier-stack down --run-id sc-cq2d --runs-dir frontier-node/.local/frontier
```

Note: `target/release/frontier-stack` was built before these changes; rebuild it (`cargo build --release -p stack`) so its own `verify` uses the new verifier.

Last result (968 txs, mid-season): V1–V13 FAIL only on **V7 HoldingReplayMismatch ×9, first at byte 272** (was 488 skip + 25 holding failures); conquest audit PASS.

## Next

1. V7 holdings, byte 272 of the Holding (`frontier-abi/src/layout/player.rs` holding map; likely the v2 train cost `catalog2::train_v2`, the intro build of PlaceHome, or the v2 production): compare `crates/verify/src/holding.rs` with `permutation-frontier/src/proc/holding.rs`.
2. V7 clashes on the v2 path (`input_digest_v2 → build_v2 → kernel → report_from_outcome → apply_v2 → settle → step → finish`, program `proc/clash.rs` module note): needs a later snapshot with CLASH records.
3. The rest of V1–V13 on a full season (V5 seals, V6 quotas, V8 lag, V13 payments with the prize program).
4. V14–V22 and tampers T25–T48 (contract §8.5), starting with V16 `FirstHoldingTransferred`, V20 season end, V19/V21 standings vs the herald's `final.json`.
5. Then a full 14-day season (`MC_LOCAL_14D`, about 17 h at 20x) verified end to end, with Tally/Finalize of the prize program.
6. Update README / DESIGN-OVERVIEW wording on what the verifier covers for conquest seasons once 1–3 pass.
