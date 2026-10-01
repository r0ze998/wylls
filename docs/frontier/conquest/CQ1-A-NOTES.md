# CQ1-A rules-conquest: notes

- **Unit:** CQ1-A (MC wave 1), branch `frontier/cq-1a-rules`, cut from `frontier/cq-integ` at `39ff369` (CQ0 for this run; the contract text says `d11d058`).
- **Contract:** CONQUEST-CONTRACT v1.1, §3, §5.1, §7, §11 (CQ1-A row), §12 Gate CQ1, §13.
- **Owned paths touched:** `permutation-rules/src/frontier/{keep,control,siege,holding,geometry,terrain,camp,clash,mod}.rs`, `permutation-rules/tests/frontier_conquest.rs` (new), `permutation-rules/tests/frontier_shared.rs` (one test adjusted), `permutation-rules/vectors/{keep,control}-vectors-v1.json` (new), this file.
- **Dependency requests:** none. No manifest, lockfile, toolchain or `.gitignore` change.
- **Owner decisions:** built to the working defaults OD-1…OD-16 (CQ1-D records them in DECISIONS as working defaults).

## What landed

Everything is **additive** (MC §5.1, R-16). Every v1 name keeps its M1 value, so M1's `RULESET_HASH` (`72c6b583…4bd9`) is unchanged. `permutation-frontier`, `frontier-abi` v1 and `frontier-sim` compile against the crate without changes.

| Kernel | Additions |
|---|---|
| `keep` (new, `KEEP_VERSION` 1) | `KeepParams` (+ `DEFAULT`, `MC_TEST`), `Keep`, `KeepReport` (+ `from_mask`, the quiet model), `KeepEvent`, `KeepError`, `keep_tile`, `open` / `try_open`, `garrison` / `garrison_id`, `troops_after_clash`, `lead_host`, `advance`, `advance_quiet` (a closed form over a quiet run) and `QuietRun`, and `keep_tile_symmetric` (a proposal, see finding 1) |
| `control` (new, `CONTROL_VERSION` 1) | `SIDES`, `site_weight_centi`, `tier_from_u8`, `Controller` / `controller` (strict majority), `ProvinceControl` / `province_control`, `Banner` / `march_banner`, `Change` / `lasting_changes`, `BannerChange` / `banner_changes`, `ControlMap` / `MapProvince` / `Call` / `herald_call` / `herald_call_detail`, plus the PSFCT1 code constants |
| `siege` v3 (`SIEGE_VERSION_V3` 3; `SIEGE_VERSION` stays 2) | `SiegeCheckV3` / `may_besiege_v3`, `SiegeV3` (`declare`, `advance`, `advance_quiet`), `can_complete_before` (+ `_counted`, the test hook), `earliest_completion_bell`, `broken_by_defender`, `immunity_bars` (+ `BARRED_ALL` / `BARRED_NONE`), `occupation_ends` / `OccupationEnd`, `capture_credited`, `held_since_hour_from`, `VIGIL_WINDOW_BOUND` 288 / `VIGIL_WINDOW_MIN_OUTSIDE` 96 |
| `holding` v3 (`HOLDING_VERSION_V3` 3) | `LifecycleParams` (+ `FRONTIER_7`, `FRONTIER_28`, `shield_secs_for`, `is_dormant`, `is_released`), `OutpostCheck` / `OutpostRefusal` / `may_found_outpost`, `LAND_GATE_BPS`, `lowest_free_slot`, `CaptureEffects` / `capture_effects` |
| `geometry` v2 (`GEOMETRY_VERSION_V2` 2) | `is_heartland_in(p, f, max_ring)`, `HEARTLAND_MAX_RING_DEFAULT` 3 |
| `terrain` v2 (`TERRAIN_VERSION_V2` 2) | `free_city_site(ring_seed, p, site_count)`, `FREE_CITY_DOMAIN` |
| `camp` v2 (`CAMP_VERSION_V2` 2) | `place_v2(…, keep_tile)`, which never returns the keep tile (`place` is unchanged; `place_v2(…, None) == place`) |
| `clash` v4 (`CLASH_VERSION_V4` 4) | `MAX_GARRISONS_WITH_KEEP` 13, used by `validate`; `MAX_GARRISONS` stays 12; the Phase A body's unit arrays are resized (finding 2) |
| `mod` | `RULES_VERSION_FRONTIER_V2` 11, `KERNEL_VERSIONS_V2` (25 entries: M1's 23 with the §3.13 bumps, then `keep` and `control`), `conquest_bounds` (the §5.2.5 validation ranges), `KERNEL_CONSTANTS_V2` (27), `ruleset_hash_input_v2()`, `ruleset_hash_v2()` |

**`RULESET_HASH_V2` = `1607f62ffb0201f113c4c3d8ea35ffd0c9c88c9c8e48b33f0daa567075452a5a`.** It is pinned in `cq_m1_ruleset_hash_unchanged_and_v2_pinned`. CQ1-C pins the same value as `frontier_abi::presets::RULESET_HASH_V2`.

The v2 input layout is M1's input with the domain `PSF-RULESET-v2` and `KERNEL_VERSIONS_V2` in place of the M1 head. After that it is byte-for-byte M1's remainder (combat digest, catalog, camp, explore, seal, office, doctrine and stance tables, the 40 M1 constants), followed by the length-prefixed `PSF-FREE-CITY` and `PSF-HERALD-CALL` domains and the 27 conquest constants.

## Tests (`cq_*`, `permutation-rules/tests/frontier_conquest.rs`, 28 tests)

| Test | What it checks |
|---|---|
| `cq_m1_ruleset_hash_unchanged_and_v2_pinned` | M1 hash golden; v2 hash golden; the v2 input layout; every §3.13 bump; every other module version unchanged |
| `cq_heartland_in_matches_m1_at_3_and_follows_the_parameter` | `is_heartland == is_heartland_in(…, 3)` for rings 0–9 and all factions; max ring 2 and 6 |
| `cq_keep_tile_is_the_lowest_passable_non_site_and_reachable` | 3,888 generated provinces (24 seeds × rings 2–7): passable, not a site, lowest such index, reachable from the centre and from every site; the symmetric variant is the same tile in every wedge; edge cases |
| `cq_free_city_site_is_the_same_canonical_site_in_every_wedge` | 16 seeds × rings 2–8: canonical in every wedge, the same tile turned, never the keep tile |
| `cq_camp_v2_never_on_the_keep_and_is_m1_without_one` | `place_v2(None) == place`; never the keep; same spawn draw and troops |
| `cq_clash_takes_the_keep_as_a_13th_garrison_at_full_fill` | 40 inputs of 48 residents, 24 arrivals and 13 garrisons (85 units): accepted; Phase A body digest = reference digest; a 14th garrison is refused `TooManyGarrisons` |
| `cq_keep_states_validate` (R-01) | 150 handoffs: guards 0…30,000, bps 0…10,000, up to six 30,000-troop capturers, `MIN_HOST_TROOPS` remainders. Each keep's garrison goes into a clash with 12 neutral 30,000-troop garrisons and 6 attackers at the cap: accepted by both bodies. Cap refusals in `garrison`, `advance` and `try_open` |
| `cq_keep_opens_in_rings_two_and_up_with_the_heartland_flag` | rings 0–1 give none; holder, guard, required, heartland flag (max ring 3 and 2); garrison id, walls, Hold |
| `cq_keep_is_taken_at_its_72nd_held_bell` | progress 71 after 71 bells (T34); taken at the 72nd; donor and garrison; `gen`, `changes`, `since_bell`; consolidation of 288 bells, then a new contest |
| `cq_keep_contest_broken_by_a_defender_and_restarted_by_another_faction` | the §8.5 honest-but-adverse case; an emptied hex breaks the contest; a contender switch restarts it; the holder's own bit is ignored |
| `cq_keep_in_a_heartland_never_counts_and_m3_pause_is_reported_once` | heartland safety over 500 bells; the M3 pause |
| `cq_keep_donor_handoff_follows_the_simulator` | six 30,000-troop capturers: the donor alone pays 15,000; a rest below 100 troops joins the keep; the 100-troop edge; sub-troop rounding; 100%; no capturer; a capturer above the cap |
| `cq_keep_quiet_equals_bells` | 20,000 random keeps, masks and runs: the closed form equals bell by bell in state, events, end bell and capturers (> 1,000 takes) |
| `cq_controller_is_the_strict_majority_rule` | 50,000 random vectors against the definition; ties |
| `cq_site_weight_centi_is_the_strength_weight_in_snapshot_units` | the formula; 25…300 per site; ≤ 3,600 per province fits u16; a 300-troop Hamlet Free City = 115 |
| `cq_province_control_and_march_banner` | rings 0/1/≥2; codes; banner > half; Seats never count; 3 of 6 is contested |
| `cq_lasting_changes_on_hand_built_series` | six hand-built series (lasting, flicker, neutral/unopened, the end of the series, gaps, two provinces); the `[u8; N]` and `Vec<u8>` forms agree |
| `cq_banner_changes_pass_through_contested_intervals` | |
| `cq_herald_call_is_deterministic_and_rallies_the_smallest` | determinism; the Rally; targets are enemy contestable keeps; no target gives `None` |
| `cq_may_besiege_v3_uses_the_season_parameters` | each refusal; heartland max ring; the War lever kept for M3; Frontier protection by seconds (edges at 12 h and 36 h); `MC_TEST` with 0; Free City |
| `cq_siege_v3_is_declared_from_the_hex_and_fails_at_the_first_unheld_bell` | no start window; Free City without a vigil; the defender pause; a third faction fails it; the vigil count equals `earliest_completion_bell` |
| `cq_siege_v3_quiet_equals_bells` | 4,000 random runs: closed form = bell by bell |
| `cq_vigil_window_bound` (R-08) | 12,000 windows of 288 bells over random schedules with up to two pending changes: **minimum 192 bells outside** (≥ 96 pinned); equal to `bells_outside_vigil` |
| `cq_covers_bound` (R-08) | 20,000 random cases: `can_complete_before` equals the brute-force count, **≤ 287 `covers()` calls** (the scan path ran with ≥ 200 calls); `earliest_completion_bell` = brute force |
| `cq_occupation_respite_immunity_and_credit` | expiry before liberation; Respite only on expiry or the owner's own liberation; faction-scoped immunity; `broken_by_defender`; capture credit at the 144-bell edge; `held_since_hour` |
| `cq_outpost_rules_in_order` | each refusal and the check order |
| `cq_slots_capture_effects_and_lifecycle` | `lowest_free_slot`; walls halved, Iron keeps them; Frontier-7/28 timers (no release inside 7 days) |
| `cq_vectors_are_fresh` | `keep-vectors-v1.json`, `control-vectors-v1.json` (one producer, one freshness test; `PSF_WRITE_VECTORS=1` rewrites them) |

`frontier_shared::ruleset_hash_binds_versions_and_catalog` was adjusted. It now requires every `pub mod` to have an entry in `KERNEL_VERSIONS_V2`, and requires v2 to be v1 followed by `keep` and `control`. The M1 golden value is unchanged.

The full-fill clash test was mutation-checked. With `MAX_UNITS` reverted to `… + MAX_GARRISONS`, it panics (index out of bounds at `clash.rs:1699`).

## Commands run (worktree `cq-1a-rules`, `CARGO_BUILD_JOBS=6`)

| Gate CQ1 line | Result |
|---|---|
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` | PASS (after two test-file lint fixes) |
| `cargo test --locked --release -p permutation-rules` | PASS, 30 test binaries. Includes `m1_rules_keep_the_phase_b_digests`, `occupancy_empty_keeps_the_phase_b_digests`, `phase_a_equals_the_reference_on_4320_inputs` and the 28 `cq_*` tests |
| `cargo test --locked -p frontier-abi` | PASS (M1 `ruleset_hash_is_the_kernels` unchanged) |
| `cargo run --locked -p frontier-abi --bin abi-vectors -- --check` | PASS (v1 vectors byte-identical) |
| `cargo test --locked -p permutation-chain` | PASS |
| `cargo check --locked -p permutation-frontier` | PASS (the M1 program compiles against the additive kernels) |
| `(cd frontier-sim && cargo test --locked --release)` | PASS (16 + 4 tests, 1,213 s; the simulator is unchanged and compiles against the new crate) |

M1 sim lines not run here: `criterion --best-response … --gate` and `doctrine-gate --controls`. Under M1 rules their outcomes cannot move, because every M1 kernel path is bit-identical (the digest tests above). They run with CQ1-B's merge.

**Not run by this unit:**

- The `--rules mc`, `mapmove`, `mapmove-gate`, coordination, `bannerdom` and overnight lines. They belong to CQ1-B's simulator code, which does not exist on this branch.
- The frontier-node workspace line and `npm test`. They do not read any file this unit changed, except through `permutation-rules`, whose v1 API and hash are unchanged. `npm ci` would also be an install.
- The ownership-check script, which arrives with CQ1-D.

## Deviations and interpretations (for the integrator)

1. **Names of the v3 siege API.** The contract writes "`SiegeCheck` { M1 fields + … }" and `advance(&mut self, b, start, r, vigil: Option<&Vigil>)`. Changing `SiegeCheck` or `Siege` in place would break `frontier-sim` (it builds `SiegeCheck` literals) and the M1 tests, so the v3 types are **`SiegeCheckV3`, `may_besiege_v3` and `SiegeV3`**. `SiegeCheckV3` drops M1's `founded_day`. Frontier protection applies when `founded_ts − genesis_ts > frontier_protect_after_secs`, for `frontier_protect_secs` after the shield. `SiegeV3::advance` returns `SiegeStatus` and does not check bell order (the record has no `last_bell`; the conquest step counts bells in order). `SiegeV3::advance_quiet(b0, b1, genesis, r, vigil) -> (status, end_bell)`.
2. **`RULES_VERSION_FRONTIER` stays 10.** §11 says "`RULES_VERSION_FRONTIER` 11", but §5.1 and R-16 require v1 names to keep their values (it is in M1's hash and in `frontier_abi::presets::RULES_VERSION`). The bump lives in `RULES_VERSION_FRONTIER_V2 = 11` and in the `_V2`/`_V3`/`_V4` module constants, bound only into `ruleset_hash_input_v2`.
3. **`keep::open` keeps its pinned `-> Option<Keep>`.** It also returns `None` when `home_guard > 30,000`; `try_open` tells the two cases apart with `Err(TroopsAboveCap)`. CreateSeason refuses such a guard anyway.
4. **Units.** `Keep.troops` is whole troops (§5.2.1). The `capturers` tuples carry **milli-troops** (the Province entries' unit). The keep gets `⌊⌊donor × bps / 10,000⌋ / 1,000⌋` whole troops, and the donor loses exactly that × 1,000. When the rest is below `MIN_HOST_TROOPS`, it joins as `⌊rest / 1,000⌋` and the sub-troop fraction is lost. `troops_after_clash` floors, as the camp does.
5. **`KeepEvent::Paused`** (M3 only) is returned once, on entering the pause. That lets the closed form match bell by bell.
6. **Taken without capturers** (never in an honest input: `holders` counts non-civilian hosts only) gives an empty keep and `donor = 0xFF`.
7. **`lasting_changes`** is generic over `M: AsRef<[u8]>`. The pinned `&[(u32, [u8; N])]` call compiles unchanged, and the simulator can pass `Vec<u8>` maps. A change counts only from a faction to a different faction (codes 0–5).
8. **`broken_by_defender(r) = r.defender_present`.** program.md defines "the owner's side holds" as `defender && holders == 0`, a subset of it. A garrison alone does not count, because it also stands after a deserted siege (the F1 farming case).
9. **`occupation_ends`:** when tenure and liberation fall in the same bell, expiry wins (event `OCCUPATION_EXPIRED`, with Respite).
10. **`free_city_site(ring_seed, p, site_count) -> u8`** takes `site_count` (the hash is taken mod it) and returns `0xFF` for a province without sites. It canonicalises `p` itself.
11. **`can_complete_before`** for `required > 96` with ≥ 288 bells left uses the closed-form `bells_outside_vigil` (exact). This never happens in MC, where `required ≤ 84`. Every other path is O(1) or a scan of ≤ 287 calls.
12. **Herald's Call details**, which §3.10 leaves open:
    - Candidates are Marches with ≥ 1 member holding a contestable enemy keep within distance 2. Distance is the province distance minus 1 from the faction's own controlled provinces (adjacent = 0).
    - The score is `enemy / (1 + d)`; ties go to the lowest `sha256("PSF-HERALD-CALL" ‖ day_seed ‖ f ‖ m ‖ n)`.
    - The Rally goes to the faction with the fewest controlled provinces (lowest id on a tie), among factions with land or a recorded loss. It targets the nearest of its `recently_lost` Marches.
    - The caller supplies `recently_lost` (2 days of banner history) in `ControlMap`.
13. **`may_found_outpost` check order:** count, prerequisite, ring, range, share, land gate, close (the §3.8 table order). `LandGate` is its own variant (M1's land-gate refusal); every other variant except `HoldingsFull` maps to `OutpostRule`.
14. **`site_weight_centi(tier, garrison, order)`** takes the 1-based holding order (it calls `strength_weight(…, order − 1)`) and `laurel::Tier`. `control::tier_from_u8` maps the mirror byte.

## Findings

1. **The keep tile is not wedge-symmetric (open; needs a decision).**
   - The pinned rule (the lowest-index passable non-site tile, as in the balance lab) scans the province's own tile indices. Index order is by world coordinate, so the keep sits in the same world direction in every province. Its place relative to the wedge therefore differs between wedges: in 5,400 of 6,480 sampled ring-2..7 provinces (40 seeds), it is not the wedge-0 keep turned. That is every province outside wedge 0.
   - DESIGN §3.2 gives all six wedges the same terrain and sites; the keep breaks that.
   - Reachability is not a problem: 0 of 6,480 keeps were unreachable, and the test checks 3,888 more against the centre and every site.
   - I kept the pinned rule. I added `keep::keep_tile_symmetric(terrain, sites, site_count, wedge)` (the canonical copy's keep, turned into the wedge; tested symmetric, reachable, and equal to `keep_tile` in wedge 0).
   - **Recommendation:** amend §3.1 to the symmetric rule before CQ1-B freezes the thresholds and CQ2-A writes OpenProvince. Its signature needs the wedge, which OpenProvince has. If the integrator decides not to, nothing changes.
2. **The clash's Phase A body would have panicked at 13 garrisons (fixed).** `clash.rs` sized its per-unit arrays with `MAX_UNITS = PROVINCE_HOST_CAP + MAX_ARRIVALS + MAX_GARRISONS` (84). A full roster with the keep is 85 units, which indexes out of bounds: a permanent province freeze of the same kind as R-01. `MAX_UNITS` now uses `MAX_GARRISONS_WITH_KEEP`. It is an array size, not a rule, and the M1 digest and equivalence tests stay green. **CQ2-B:** the SBF stack frame of `resolve_clash` grows by one slot in four arrays (≈ 11 B); check the stack and heap in G1.
3. **The vigil bound is stronger than pinned.** The minimum over 12,000 sampled 288-bell windows with pending changes is 192 bells outside, as CL-09 implies (≤ 48 covered bells in any 144). So 144 bells would already guarantee ≥ 96. The contract's 288 is kept.

## Vectors

- `permutation-rules/vectors/keep-vectors-v1.json` contains:
  - 8 keep-tile / Free-City-site rows (ring seed, terrain bytes, sites, both keep-tile rules, the Free City site index);
  - 6 scripted contests bell by bell (inputs, event, capturers after, keep state);
  - one quiet run.
- `permutation-rules/vectors/control-vectors-v1.json` contains 32 controller cases, 8 banner cases, 48 site weights, 6 lasting-change series, one banner-change series and one Herald's Call map with its 6 calls (one Rally).
- Consumers: CQ1-C's `conquest_model` unit tests, CQ3-D's `fcontrol.controlChanges` and CQ3-B's report decider.
