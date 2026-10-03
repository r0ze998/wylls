# CQ2-A prog-core-land: notes

- **Unit:** CQ2-A prog-core-land, Wave 2 of MC "Contested Ground" (contract v1.3, §11 Wave 2).
- **Branch:** `frontier/cq-2a-core`, cut from `frontier/cq-integ` at `3751173` (Gate CQ1 green after the Wave-1 close). Worktree `.claude/worktrees/cq-2a-core`. Local commits only; nothing pushed.
- **Base facts used:** `RULESET_HASH_V2 = b6dd0f3f…8274` (A-28), `CQ0 = 39ff369`, the project name Wylls.
- **Owner decisions:** OD-1…OD-16 are taken as the working defaults the contract (§15) and `SUMMARY.ja.md` §6 state; the owner may revise them. The ones this unit builds: OD-4 (outposts by ticket), OD-5 (genesis Free Cities, released homes stay plain free sites), OD-7 (heartland rings 2–3, no heartland sieges or keep contests), OD-8 (Frontier-7 timers), OD-12 (the 4,736-B Province). `DECISIONS.md` is not a CQ2-A path in Wave 2, so it is not edited here.
- **No install or download**; `cargo --offline --locked` throughout; no port bound (LiteSVM in process); no chain transaction.

## 0. Commits

| Commit | What |
|---|---|
| `b2d4b86` | **The first commit (§11: pre-merged on day 1 for CQ2-B / CQ2-C).** The v2 dispatch table over `frontier_abi::v2::Ix` (57 tags); `proc/conquest.rs` with DeclareSiege, SettleSiege, SettleCapture, FoldMarch, RetireHost and CloseMarch as `NotImplemented` stubs (CQ2-C's file from then on); FileOutpost's stub in `proc/citizen.rs`; `Error::Cq` for codes 62–78; `layout/{conquest,march}.rs` re-exporting the frozen v2 layouts, `check_kind_v2`; `prologue::check_accounts` / `top_level` taking an M1 tag (M1's table) or a v2 tag (§5.5/§5.6's), `presence_v2` / `present_v2`; svm: the coverage registry over `v2::Ix` with `Code::Cq`, `cover/ix/world` `conquest.rs` stubs. No behaviour change for any M1 tag. |
| `ca08b49` | v2 event plumbing: `events::{WIDTHS_V2, write_body_v2, record_v2, emit_cq, emit_v2, ChainedV2}` (kinds 80–88, MarchState as entity 8; no pointer table). |
| `9744009` | **[dependency request]** svm harness on ABI v2: `records.rs`, `chain.rs`, `budget.rs` (W2-B's files; §3 below). |
| `7b7191b` | The ABI v2 program (§1). |
| `c425c06` | svm worlds, builders and the M1 tests on ABI v2. |
| `00def9a` | **[dependency request]** `chain::assert_code` takes MC codes. |
| `5405f5e` | svm `g01_cq_` / `g02_cq_` / `g03_cq_` / `g13_cq_` rows, MC world helpers, coverage registry; FileOutpost trace checkpoints, province weights over one slice, `write_holding` through one array view. |
| `5d44638` | **[dependency request]** `PSF_CU_LOG` names v2 kinds. |
| (last) | These notes. |

## 1. What landed (program, `permutation-frontier/src`)

- **The switch (§3.13, §5.1).** `RULESET_HASH = RULESET_HASH_V2`, `PROGRAM_VERSION = 2`, `RULES_VERSION = 11`; every chained header the program writes is `layout_version 2` (`init_header` → `frontier_abi::v2::layout::write_header`); a Province is 4,736 B. An M1 Season is refused by the ruleset check (`RulesetMismatch`, test `cq_an_m1_season_is_refused`). M1 seasons keep the M1 release `.so`.
- **CreateSeason v2 (§5.2.5, §5.6).** Data `SeasonParams v2 (352 B) ‖ PayoutParams`; `params_hash_v2`; `SeasonParamsV2::validate` (M1 ranges, `program_version 2`, the conquest ranges, dormancy timers equal in both parts); the season doctrine table must pass `doctrine::validate_table_v2` (the Knight bound, §3.16); the conquest block written at 896..1,024; failures `BadData` (D-1).
- **OpenRing / OpenProvince / FoldOccupancy (§3.2, §3.7, §5.2.1, §5.2.4, §5.6).** OpenRing's fund check `d × rent(4,736)`. OpenProvince writes the keep on `keep_tile_symmetric` (through the bridge `v2::kernel::keep::keep_tile(…, wedge)`, A-8/A-29) with the home guard and `heartland_safe` for rings `2..=heartland_max_ring` of its wedge (rings 0–1: `tile 0xFF`), the genesis Free City on `terrain::free_city_site` from `free_city_min_ring` (state 5, NEUTRAL, Hamlet, order 0, gen 0, `held_since_hour 0`, garrison in milli-troops), the camp via `camp::place_v2` (never on the keep tile); logs `KEEP` (cause 0) and `NEUTRAL` (kind 0). FoldOccupancy adds JoinShard `extra_holdings` to `occupied_sites`.
- **Slots (K-25, §5.2.3).** Join writes the three holding entries empty (`gen 0xFF`); `slots` bits 0–1 carry the open ticket's slot (FileTicket 1, FileOutpost 2/3); `holdings_n` counts non-empty entries; the escrow holds `rent(1,280) × (1 + reservations)`.
- **FileTicket** tags slot 1, refuses an open outpost ticket (`TransitState`) and a site whose conquest record is not zero (`SiegeBusy`, S1).
- **FileOutpost 0xA3 (§3.8, §5.5).** Player prologue; no open ticket (`TicketState`); the anchor at the canonical address of `anchor_site_key` (`BadAddress`), the citizen's (`NotOwner`), at the key's generation (`BadData`), final (`NotFinal`); `holding::may_found_outpost` (count / lowest free slot `HoldingsFull`; prerequisite, ring, range from the anchor, the share at filing, close `OutpostRule`; land gate `Capacity`); S1 (`SiegeBusy`); cohorts; the settler cost `duplicate_cost(SETTLER_COST, holdings_n)` from the anchor's stores as an owner touch (`Insufficient`); the escrow top-up. Logs `TICKET` (Citizen, the Provinces) and `HARVEST` of the anchor (D-4).
- **SettleTicket (§5.6).** Founds into the ticket's slot: slot 1 as M1 (starter kit) with the season's first-holding shield (§3.9: `shield_secs`, or `shield_late_secs` from `shield_late_after_secs`); slot 2–3 an outpost (`order` = slot, Hamlet base production, no starter kit, `outpost_shield_secs`, JoinShard `extra_holdings` and `outposts`, log `OUTPOST_SETTLED` beside `SETTLE`). The mirror gets `held_since_hour = ⌈now_bell / 6⌉`. A win moves exactly one `rent(1,280)` (the rest of the escrow is the reservations'), refuses a non-zero record (`SiegeBusy`), and a displaced holding is reverted by its own order.
- **ReleaseDormant (§3.15 S3).** Refused while the record is live (`SiegeBusy`) or owes (`StakeUnsettled`); the record is zeroed with the release; the citizen's outposts stay (slot 1 emptied, `holdings_n − 1`).
- **Resident actions (§5.6, §5.8, §3.16).** Harvest / Build / Train list the holding's own Province (`r`, Build `r|w`, writable required for walls and the tier-up) and refuse `CapturePending` while `mirror.gen ≠ holding.gen` and `capture_flags == 0`; they also run the lazy finality flip (D-11). Explore checks the lock when its Scout stands in the own Province (D-6). Build tier-up writes `tier_next` / `tier_next_bell` (D-12). Train pays `catalog::train_v2`. SettleExplore of another generation credits nothing. `write_holding` keeps the stored shield (D-10).
- **Helpers for CQ2-B / CQ2-C:** `prologue::{check_accounts, top_level}` with a v2 tag, `prologue::{presence_v2, present_v2}`, `layout::check_kind_v2`, `layout::init_header_v2`, `layout::conquest::{Record, season_cq, lifecycle}`, `events::{emit_cq, emit_v2, ChainedV2}`, `addr::v2`, `proc::holding::{capture_lock, own_province_unlocked}` (`pub(crate)`, usable by `host.rs`).

## 2. Measurements [measured, LiteSVM 0.16, SBPF v2]

| Item | Value |
|---|---|
| Release `.so` (`scripts/build-frontier.sh --twice`) | **959,176 B**, both builds `46d8e9cd529fb6d6…1dbc6e`, program hash `3250092c…0757`, e_flags 2, overflow checks on, `--max-len` 1,200,128 (programdata 1,200,173). M1: 875,824 B. Not the MC build of record (CQ4-A). |
| OpenProvince worst, rings 2..10 × 6 wedges, keep + Free City from ring 4 | **152,326 CU** ≤ 220,000 (M1 148.5k) |
| **FileOutpost**, 3 sites in 3 Provinces with 7 open cohorts each, anchor stores | **26,550 CU > §5.4's 24,000** (508 B ≤ 640; heap 1,864 B) — see dependency request R4 |
| SettleTicket, outpost fresh, 3 Provinces | 24,624 CU ≤ 40,000 |
| Harvest / Build / Train worst (City, 3 items, 2 due; walls; 30,000 Knights) | 17,001 / 18,859 / 17,257 CU ≤ 19,000 / 23,500 / 19,000 |
| Explore / SettleExplore | 19,353 / 8,258–8,358 CU ≤ 20,000 / 15,000 |
| CreateSeason v2 | 50,767 CU ≤ 70,000 (930 B) |
| FoldOccupancy (per part, + `extra_holdings`) | 28,918 CU ≤ 30,000 (close to the gate) |
| ReleaseDormant (S3 read + record reset) | 12,083 CU ≤ 25,000 |
| Heap (trace builds, every landed MC test tx) | max 8,336 B (InitBeaconLogs); FileOutpost 1,864, SettleTicket 2,200, ReleaseDormant 1,552 ≤ 28,672 |

FileOutpost's profile (trace build, per step): prologue 3.6k, anchor 1.5k, per Province ≈ 1.9k (address, presence, weights, checks, cohort), the anchor's touch and payment 4.5k, its write and digest 1.4k, the escrow transfer 2.3k, `TICKET` 3.4k, the anchor's `HARVEST` 1.7k. A fixed-array read of the Holding was tried and was **slower** on SBF (byte-wise assembly, +2.7k), so `read_holding` keeps the per-field accessors; the array view is kept for `write_holding` (−0.4k).

## 3. Dependency requests

- **R1 (svm harness, W2-B's files; commits `9744009`, `00def9a`, `5d44638`).** Once the program is the v2 program, every svm test needs: `records.rs` decoding with the v2 decoder (an M1 decoder panics on `KEEP` / `NEUTRAL` / `CONQUEST`), `ChainWatch` following MC links, `cq_records` / `one_cq`; `chain.rs` profiles and `L(kind)` from the v2 budgets and sizes (a Province is 640 B larger), `profile_of` decoding v2 tags, `assert_code` taking MC codes, `PSF_CU_LOG` naming v2 kinds; `budget.rs` ceilings from the v2 table. Done on this branch in separate commits; take or replace them (CQ2-B and CQ2-C need the same).
- **R2 (`tests/g01_loaded_limit.rs`, unowned): `g01_loaded_limit_table_covers_the_release_so` fails** — it compares the release `.so` (`max_len` 1,200,128) with **M1's** budget placeholder (1,105,920). It should read the v2 placeholder (`frontier_abi::v2::budgets::PLACEHOLDER_PROGRAMDATA_LEN_V2`, 1 MiB `.so`), or CQ4-A regenerates the table.
- **R3 (`tests/season_records.rs`, unowned): `season_records_and_chain_through_the_lifecycle` fails** — it compares the stored ruleset with M1's `RULESET_HASH`; under the v2 program it is `RULESET_HASH_V2` (`b6dd0f3f…8274`). A one-line change.
- **R4 (contract §5.4, budget amendment): FileOutpost measures 26,550 CU against an estimated 24,000.** Proposal: **28,000** (measured + 5%, the §5.4 rule for client limits). `g01_cq_file_outpost_three_provinces_full_cohorts` asserts the table and **fails on this one assertion** (every other assertion of it, the loaded-data check and SettleTicket's measurement pass first); `frontier_abi::v2::budgets` is not CQ2-A's, so the table is not changed here.
- **R5 (contract §3.8 / §5.5, settler-cost refund).** §3.8 says the settler cost is "refunded if the ticket expires or is displaced" and §5.5 that it is "escrowed in the anchor Holding's `pending` stores", but the Holding has no pending-store field and SettleTicket's account list (M1's, frozen in `frontier_abi::v2::prologue`) names no anchor. **Implemented: paid at filing, not refunded on chain** (D-4). To refund, the ABI needs (a) the anchor recorded at filing (e.g. `Citizen.slots` bits 4–5 = the anchor's slot, or Holding reserve 1,272 = the anchor key of an outpost) and (b) an optional trailing `[anchor_holding w]` on SettleTicket when an outpost ticket ends unfounded (and on the displacement path). Owner/integrator decision; V22 (CQ3-A) must follow whichever rule stands.
- **R6 (`OUTPOST_SETTLED.anchor_key`).** No field keeps the anchor past FileOutpost, so SettleTicket logs **0** (D-5); FileOutpost's `HARVEST` record carries the anchor's key. Same fix as R5 (a).
- **R7 (CQ2-D, fclient):** v2 builders: Harvest / Build / Train with `[province]` (Build `r|w`), FileOutpost, CreateSeason v2 (fclient's `create_season` takes raw bytes, so the 352-B v2 params pass through). The svm wraps them in `ix/holding.rs` and `ix/citizen.rs` meanwhile.
- **R8 (CQ2-C, `cover/host.rs`):** the registry lists Explore under `host`; add `holding::g13_cq_capture_lock_refuses_the_resident_actions` (CapturePending) to `EXPLORE` there.
- **R9 (CQ2-B, `world/clash.rs`):** its crafted Provinces are 4,096 B with a v1 header; the v2 program accepts them where it uses M1 presence checks, but `present_v2` (now used by `own_province`) refuses them. CQ2-A's `world/holding.rs` crafts v2 Provinces (no keep, no Free City).
- **R10 (contract §5.3 wording):** "M1 codes reused: … `BadParams`" — there is no M1 `BadParams`; CreateSeason uses `BadData` as M1 did (D-1).
- **Footprint (report-only):** `cq-ownership-check.sh` warns that `permutation-frontier/src/lib.rs` is on the design chat's `ui-shell` footprint (its Wylls rename of doc comments); expect a doc-comment conflict when `codex/frontier` is merged in.

## 4. Deviations and interpretations (the contract leaves these open)

- **D-1.** Invalid CreateSeason v2 parameters (any `SeasonParamsV2::validate` failure, a foreign beacon key, `program_version ≠ 2`, a doctrine table failing the Knight bound) are `BadData`, as M1's CreateSeason; the M1-shaped 224-B data is `BadData` (decode).
- **D-2.** FileOutpost's handler is in `proc/citizen.rs` beside FileTicket (CQ2-A owns it; `conquest.rs` is CQ2-C's).
- **D-3.** A genesis Free City stays in the fund's `open_sites` (a site a capture can occupy) and out of `n_sites_used` (holdings only); `NEUTRAL.garrison` is in whole troops, the mirror in milli-troops.
- **D-4. FileOutpost pinned rules.** (a) The Town prerequisite reads the anchor's tier when the anchor is the first holding; an outpost anchor (founded by ticket, so the first holding passed the prerequisite at its filing, and tiers never fall) proves it; a **captured** holding cannot anchor (`OutpostRule`). (b) Slot 3 needs a holding in slot 2 in the Citizen's list (a provisional one counts; the simulator settles outposts at once). (c) Count, prerequisite, land gate and close are judged before the sites (the simulator's order), then per site ring, range, share; S1 after them. (d) The land gate is `Capacity`. (e) The share counts every holding by its owner's faction and every Free City in the total, the tier in force at the bell. (f) The settler cost is an owner touch of the anchor (it resets the anchor's dormancy, as every resident action) and is not refunded (R5). (g) The anchor's stores change is logged as `HARVEST` (key the anchor, payload its stores digest).
- **D-5.** `OUTPOST_SETTLED.anchor_key` is 0 (R6).
- **D-6. Capture lock reach.** Explore names the Province its Scout stands in; it checks the lock only when that is the holding's own Province. FileOutpost checks it on the anchor only when the anchor's Province is one of the listed ticket Provinces. SettleExplore has no Province and applies the generation rule instead.
- **D-7.** An emptied holding entry (Join, displacement, release) is `(0, 0, 0, gen 0xFF)`; M1 wrote all zeros.
- **D-8.** `held_since_hour` at SettleTicket is `siege::held_since_hour_from(now_bell)` = `⌈now_bell / 6⌉` (the simulator's `held_since_hour(b)` at founding).
- **D-9.** svm crafted Provinces (`world/holding.rs`) carry no keep and no Free City; tests needing them open the Province with OpenProvince.
- **D-10.** The first-holding shield comes from the season (§3.9), written at founding; `write_holding` no longer rewrites `shield_until` from M1's constant on every owner action (in an M1 season the two agreed).
- **D-11.** Harvest, Build and Train now carry the own Province, so each runs the lazy finality flip (M1: Build with walls only); a Holding goes final at the first of them after `final_ts` with its cohort closed. The outpost flip leaves the Citizen's first-holding flags alone.
- **D-12.** A tier-up Build folds the previous tier-up into the mirror's `tier` (one tier-up at a time, so the previous one has finished). If it finished inside the current bell, the mirror shows the new tier one bell before `tier_next_bell` would have; the hourly snapshot (CQ2-B) reads it.
- **D-13.** The v2 svm world uses `MC_LOCAL_7D`'s M1 part (Frontier-7 dormancy 3 d / 7 d, the 21-SOL fund) for every M1 test; tests that need M1's own dormancy run on the 28-day season.

## 5. Tests (svm-tests, test-beacon build unless named)

New (`cq_*`, `g01_cq_*`, `g02_cq_*`, `g03_cq_*`, `g13_cq_*`): `map::cq::{cq_create_season_v2_writes_the_conquest_block, g13_cq_create_season_v2_refusals, cq_an_m1_season_is_refused, cq_open_province_places_keeps_and_free_cities, cq_fold_occupancy_counts_extra_holdings, g01_cq_open_province_with_keep_and_free_city}`; `citizen::cq::{cq_join_writes_empty_slots, cq_outpost_files_and_settles_into_slots_2_and_3, g13_cq_file_outpost_refusals, g13_cq_file_ticket_v2_refusals, g13_cq_release_dormant_s3_and_record_reset, g02_cq_prefund_outpost_holding, g03_cq_file_outpost_refuses_forged_accounts, g01_cq_file_outpost_three_provinces_full_cohorts}`; `holding::cq::{g13_cq_capture_lock_refuses_the_resident_actions, g03_cq_resident_actions_refuse_a_forged_province, cq_train_pays_the_v2_table, cq_build_tier_up_writes_tier_next, g01_cq_resident_actions_with_the_province_read, cq_settle_explore_of_another_generation_credits_nothing}`; `reveal::cq_reveal_targets_a_free_city_from_a_shielded_holding`. Program unit tests: v2 tags, `Error::Cq`, v2 headers, `check_kind_v2`, v2 event bodies and chains, conquest record reader, lifecycle timers.

M1 tests adjusted where v2 changes the outcome (CQ2-A files only): the Province rent 4,736 B, the season's shield, the emptied entry `gen 0xFF`, the flip at Harvest, Build's listed Province (`BadAccount` read-only for walls / tier-up), the keep and camp v2 in OpenProvince, `loaded_check` on v2 `L(kind)`.

## 6. Gate CQ2 lines run on this branch

| Line | Result |
|---|---|
| `cargo fmt --all -- --check` (+ `svm-tests` `cargo fmt -- --check`) | pass |
| `cargo clippy --locked -p permutation-frontier --all-targets -- -D warnings` | pass |
| `cargo test --locked -p permutation-frontier` / `--no-default-features` | pass (87 / 41 unit tests) |
| `scripts/build-frontier.sh --twice` | pass, `46d8e9cd…1dbc6e` both builds |
| `(cd permutation-frontier/svm-tests && ./run.sh --release -- g01_cq_ g02_cq_ g03_cq_ g11_cq_ g13_cq_ p_cq_)` (CQ2-A's rows; `g11_cq_`/`p_cq_` are CQ2-B/C's and none exist here) | **1 failure**: `g01_cq_file_outpost_three_provinces_full_cohorts` (26,550 CU > 24,000, R4); every other `cq` row passes |
| `(cd permutation-frontier/svm-tests && ./run.sh --release)` (every M1 test on v2) | 23 binaries; **3 failures**: the one above, `g01_loaded_limit_table_covers_the_release_so` (R2), `season_records_and_chain_through_the_lifecycle` (R3); all other M1 tests green on the v2 program (clash 34, transit 19, host 13, g13_complete 22, g02 10, g03 12, …) |
| `PSF_TRACE=1 … g01_cq_resolve_worst g01_cq_skip_worst g01_cq_fold g01_cq_declare g01_cq_settle_capture` | not CQ2-A's tests (CQ2-B / CQ2-C); not run. Heap of CQ2-A's instructions checked on the trace builds instead (§2) |
| `(cd frontier-node && cargo test --locked --release --workspace -- cq_)` | not run: no frontier-node crate depends on `permutation-frontier`, and this unit changes nothing under `frontier-node/` or `frontier-abi/` |
| Gate CQ1 lines | `cargo test -p frontier-abi` pass, `abi-vectors --check` 16 files fresh, `cargo check -p permutation-frontier` pass; the rules, chain, simulator, frontier-node and npm lines have no input this unit changed (no file outside `permutation-frontier/**` and this note), so they were not re-run; `npm ci` would download (not approved) |
| `scripts/cq-ownership-check.sh frontier/cq-2a-core` | PASS (2 footprint warnings, report-only: `lib.rs`) |
| `git diff --quiet $(git merge-base HEAD codex/frontier) -- permutation-server/web/session.mjs permutation-chain/src` | exit 0 |

## 7. Pending (later units)

- CQ2-B: the conquest step in ResolveFromInputs / SkipQuiet; its crafted Provinces (R9).
- CQ2-C: the six handlers in `proc/conquest.rs`; the capture lock in `host.rs` (Muster, Dissolve, Garrison, Depart) through `holding::own_province_unlocked`; R8.
- CQ2-D: fclient v2 builders (R7).
- CQ4-A: budgets and `L(kind)` from the MC release `.so` (R2, R4), `RELEASE_CHECK=1`.
- Owner / integrator: R4 (FileOutpost budget), R5 / R6 (settler-cost refund and the anchor's record).
