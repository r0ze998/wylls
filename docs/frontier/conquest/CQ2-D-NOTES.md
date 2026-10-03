# CQ2-D keeper-cq: notes

- **Unit:** CQ2-D keeper-cq, wave 2 of MC "Contested Ground" (contract v1.3, §11 Wave 2; the project is now named Wylls, the contract text still says Frontier).
- **Branch:** `frontier/cq-2d-keeper`, cut from `frontier/cq-integ` at `3751173` (the wave-2 base, Gate CQ1 green after the Wave-1 close). `CQ0` = `39ff369`.
- **Owned paths touched:** `frontier-node/crates/fclient/**`, `frontier-node/crates/keeper/**` and this file. No manifest, lockfile, toolchain file or `.gitignore` changed. No design-chat file touched. Local commits only, nothing pushed. No download, no install, no chain transaction, no service started (every test binds nothing or `127.0.0.1:0` through the existing harness).
- **Owner decisions:** OD-1…OD-16 are taken as the working defaults the contract and `SUMMARY.ja.md` §6 state (1–12 yes, 13–15 no, 16 stop and ask); nothing here depends on an open one. They are working defaults the owner may revise, not explicit approvals. No doctrine table was touched.
- **Dependencies on sibling units:** none at compile time. CQ2-D codes against the pinned ABI v2 of `frontier-abi` (Wave 1: `v2::*`, `conquest_model`) only, not against CQ2-A's stub commit (the keeper sends no instruction the stubs would change). The in-process tests on the test-beacon `.so` wait for CQ2-A/B/C (§5 below).

## 1. What landed

### fclient (§8.1; R-16, R-22)

| Path | Contract | Content |
|---|---|---|
| `src/abi.rs` | §5.3, §5.4, §6 | v2 tags `0xA0`–`0xA7` (0xA4 reserved), `INSTRUCTIONS_V2` (57 rows, §5.4's budgets for the changed rows, M1's for the rest; CQ1-C D-7 kept: GatherClash 49k, SkipQuiet 90k), `ix_info_v2`, `ix_info_for(program_version, tag)`, `ERRORS_V2` (62–78) with `error_name` over both ABIs, `err::` constants for the codes the keeper acts on, `err::is_done` + FoldMarch `FoldOutOfOrder`, log kinds 80–89 (`kind::ALL_V2`), `entity::MARCH_STATE` / `MAX_V2`, `magic::MARCH_STATE`, `size::PROVINCE_V2` / `MARCH_STATE`, `PROGRAM_VERSION_V2`, `LAYOUT_VERSION_V2` |
| `src/abi.rs` twin tests | R-16, R-22 | **switched to compare both ABIs:** `instructions_are_frontier_abis` over `Ix::ALL` (v1 budgets) and `Ix::ALL_V2` (v2 budgets; unchanged M1 rows must equal v1's), `magics_and_rent_are_frontier_abis` over v1 and v2 `AccountKind::ALL` (MarchState, Province v2 4,736 B, rents 24,709,120 and 1,950,720), plus `cq_errors_v2_are_frontier_abis`, `cq_log_kinds_are_frontier_abis` |
| `src/decode.rs` | §5.2 | **version-dispatching readers:** `Season.conquest` (`ConquestParams`, read when `program_version ≥ 2`), `Province.cq` (`ProvinceCq`: records, keep, snapshots, `captures_by`, `keeps_taken_by`, the named site-mirror bytes; read when `layout_version ≥ 2` and 4,736 B, through `conquest_model`'s readers), `Holding.cq`, `Citizen.cq`, `JoinShard.cq`, `MarchState`, `AnyAccount::MarchState`, `layout_is_v2`. The M1 prefix decodes identically in both versions |
| `src/log.rs` | §6 | `Record::decode_v2` (frontier-abi's exact widths, tail entities 1–8); `LogError::Abi` |
| `src/ix/v2.rs` (new) | §5.5, §5.6 | builders: DeclareSiege, SettleSiege (+ D-6 `ticket_funder`), SettleCapture, FileOutpost, FoldMarch, RetireHost, CloseMarch; v2 shapes of Harvest, Build, Train (`[province r/w]`), SettleTransit (+ `prev_home_holding`), CreateSeason v2. Data from `frontier_abi::v2::ix`; every list checked **position by position** (signer, writable) against `frontier_abi::v2::prologue::accounts_of`, within the packet, lock and tx-ceiling limits |
| `src/addr.rs` | §5.2.6 | `Addresses::march_state(m, n)` (twin-tested against frontier-abi), `holding_of_key` |
| `src/budgets.rs` | §5.4 | `CANONICAL_JSON_V2` (`frontier-abi/vectors/v2/budgets.json`), `Budgets::canonical_v2`, `canonical_for(program_version)`: **`L(kind)` for the new kinds** (1,343,488; FoldMarch 1,376,256) |
| `src/conquest.rs` (new) | §6, §8.2 | typed MC log records (`CqEvent`, `parse`), `horns`, the contested-province test `contest(pd, bell)` (records, keep contest, hostile residents through `conquest_model::report_quiet`), `siege_settles`, `fold_ready` (count, lost hours, laggards; first hour when no MarchState), `unfolded_age_hours` |

### keeper (§8.2)

| Duty | Where | Rule as built | Class / role |
|---|---|---|---|
| Contested bells | `play.rs` `read_provinces` → `conquest::observe` | a v2 Province with a siege, an occupation, a keep contest, or a hostile non-civilian resident (`from_bell ≤ resolved_next`) on a holding, Free City or keep hex is `contested`: gathered (fast path) and resolved every bell, never in a skip | D / gather, resolve |
| Idle provinces | `play.rs` `clashes` | unchanged M1 batch rule: a SkipQuiet at least every 24 bells (4 game hours); **fold-driven (R-23):** a March whose oldest unfolded hour is ≥ 3 game hours old (counted from the hour's end) puts its lagging idle members in `fold_urgent`, and they skip at once with the closed run they have | D / skip |
| Capture settlement | `conquest::captures` | every kind-3 record; captor = the `src` Holding's owner when its tag is the record's `actor`, else the land index's Citizen with that tag; victim = the target Holding's owner and rent payer (Free City: D-2) | D / settle |
| Stakes and slots | `conquest::siege_settles` | kind 0 owing (bit 1 → the site's Holding, bit 2 → `src`), kind 2 owing its stake (A-5), and after `end_bell` every kind-1 siege; a slot owed (bit 5, or a lapsed capture siege) names the actor's Citizen and its `ticket_funder` | N / settle |
| March folds | `conquest::folds` | per March with an opened member: MarchState read every 8 slots; FoldMarch from `next_hour` (first hour when absent) over every hour (≤ 6) whose members resolved past `6h` and, after the season, `6h < end_bell`; waits while an opened member is unread | D / fold |
| Horn watcher | `playindex` → `conquest::on_log` | SIEGE_DECLARED and CONQUEST's KEEP_CONTEST, OCCUPIED, CAPTURE_DUE, LIBERATED, KEEP_TAKEN: the Province is read at once and planned in the same tick (`cq_front`; §7 item 8), counted per name and per bell, journalled, an alert `horn-rate` above 48 horns in one bell. CAPTURE_SETTLED records the captured site | — |
| Season-end flush | `conquest::plan` after `end_bell` | M1's last resolves and skips (unchanged); FoldMarch for the last hours; SettleCapture; SettleSiege for lapsed sieges and owed stakes and slots; **RetireHost** (any actor, `retire_hosts == 1`) for every roster entry with no pending op whose host is the previous generation of a captured Holding (`id.gen == prev_gen ≠ gen`), victim = `prev_home`'s owner | D / N, fold, settle |
| Closes | `conquest::housekeeping` | CloseMarch from `end + 72 h` for a present MarchState, rent to its `rent_to` | N / close |
| Status, metrics, journal | `lib.rs`, `journal.rs` | `/v1/status` `conquest {sieges_active, keeps_contested, occupations, settle_pending, fold_lag_hours_p99, horns_last_bell, …}`; Prometheus `fk_contested_resolve_latency_slots`, `fk_fold_lag_hours`, `fk_capture_settle_pending`, `fk_horns_total`; journal table `conquest(slot, bell, event, object, detail)` (horns and conquest writes landed) | — |
| ABI follow (R-22) | `lib.rs` `follow_abi` | an MC season swaps the engine to the v2 budgets table and reprices the reveal floor at its Reveal; an M1 season keeps (or returns to) v1's; `budgets_file` stays the operator's | — |

Order of operations (§8.2): the play duty's resolve, SettleDeparture, gather and resolve run first in the tick; the conquest plan follows on the same Province reads (captures of bell b after its resolve landed and the Province was re-read; folds after the hour's last member resolve). Crash safety is unchanged: the conquest view is rebuilt from Province and MarchState reads and the feed (re-read from cursor 0).

**No new keeper role** (deviation, §4 D-4 below).

## 2. Tests (`cq_*`, §4.4)

fclient (16, three added in the review round: `cq_placeholders_are_never_a_site_holding`, `cq_return_target_binds_a_retire_leave_to_its_home`, `cq_fold_lag_counts_from_the_hour_start`): `cq_errors_v2_are_frontier_abis`, `cq_log_kinds_are_frontier_abis`, `cq_march_state_address_is_frontier_abis`, `cq_province_reader_dispatches_on_the_version`, `cq_march_state_season_and_holding_v2`, `cq_decode_v2_reads_both_abis`, `cq_builders_match_the_v2_lists_and_fit_a_packet`, `cq_builders_recompute_canonical_keys`, `cq_v2_budgets_cover_every_v2_kind`, `cq_contest_reads_records_keep_and_hostiles`, `cq_siege_settles_and_season_end`, `cq_fold_ready_waits_for_the_laggard_and_counts_lost_hours`, `cq_parse_typed_records`; plus the switched twin tests `instructions_are_frontier_abis`, `magics_and_rent_are_frontier_abis`.

keeper (15), over the **native `conquest_model`** and a fake chain (six added in the review round: `cq_settle_transit_of_a_previous_generation_host_names_prev_home`, `cq_return_of_a_retire_leave_names_the_home_holding`, `cq_horn_replay_after_a_restart_is_not_journalled_twice`, `cq_close_march_does_not_need_the_fold_role`, `cq_season_end_retires_waiting_leaves_and_waits_for_the_last_resolve`, `cq_land_index_takes_a_free_city_capture`; `cq_settle_siege_stakes_slots_and_season_end` and `cq_settle_capture_names_captor_and_victim` were extended; the keep test now checks the native model's taking bell and the first idle bell independently of `contest`):

- `cq_keep_contest_resolves_every_bell_then_idles`: a keep contest on a v2 Province is gathered every bell (never skipped) while the native `step` advances it; the keep is taken after `keep_bells` (MC_TEST 24) bells, the Province goes idle and gets one 24-bell SkipQuiet.
- `cq_settle_capture_names_captor_and_victim`: holding and Free City captures; captor via the src Holding or the land index; backoff; latency; not re-planned after landing.
- `cq_settle_siege_stakes_slots_and_season_end`: bit 1, bit 2 + bit 5 (funder), and the lapsed siege after `end_bell`.
- `cq_fold_march_folds_ready_hours_and_skips_laggards`: first fold with no MarchState (hours 0–4 of 5), the laggard holds hour 5, R-23 puts it in `fold_urgent`, the play duty skips it at once (5 bells, not a 24-bell batch).
- `cq_horn_watcher_fronts_counts_and_alerts`, `cq_season_end_retires_previous_generation_hosts`, `cq_close_march_after_end_plus_72h`, `cq_m1_season_plans_no_conquest_write`, `cq_keeper_follows_the_season_abi`.

## 3. Gate CQ2 lines run (my files)

All from `frontier-node` in this worktree, `CARGO_BUILD_JOBS=6`, `--offline --locked`, on the final commit of the review round (logs and exit codes in the session scratchpad `cqw2/CQ2-D/`):

| Command | Result |
|---|---|
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo test --locked -p fclient -p keeper` (debug, full) | exit 0: fclient 81, keeper lib 59, archive_returns_rent 1, held_accounts 2, land 3, latency 2, one_day_beacons 1, play 6 (+1 ignored, as on the base), reveal_accept 1 |
| `cargo test --locked --release --workspace -- cq_` (Gate CQ2 line) | exit 0: fclient 16, keeper 15, and the other crates' existing `cq_` tests (10 and 8) green |
| `cargo test --locked --workspace` (Gate CQ1 frontier-node line) | exit 0: 474 passed, 0 failed, 11 ignored (the base's ignored tests) |
| `scripts/cq-ownership-check.sh frontier/cq-2d-keeper` | PASS (4 commits since the fork) |

The other Gate CQ2 lines (program clippy and tests, `build-frontier.sh --twice`, svm-tests) concern CQ2-A/B/C's files; not run here. The measured budgets are the static ones this unit owns: `L(kind)` 1,343,488 B (the new kinds) and FoldMarch 1,376,256 B, equal to `frontier-abi/vectors/v2/budgets.json` (`cq_v2_budgets_cover_every_v2_kind`). Latencies (contested resolve p99 ≤ 8 slots, SettleCapture p99 ≤ 12 slots, FoldMarch lag p99 ≤ 5 game hours, zero lost hours) are **counted** by the keeper and **not measured** on a chain here (§5).

## 4. Deviations and interpretations (D-n)

- **D-1 (revised in the review round), DeclareSiege's open accounts.** `owner_citizen` for a Free City and `nearby_province` when no proof is needed: §5.5 says "absent at its canonical address" / "any absent canonical address". The first run passed the target's Holding there (present for a holding target, so CQ2-C's `presence_v2(nearby, …, Province)` answers `BadAccount`). Now both are `Addresses::absent(n)`: a with-seed address of the Season (seed `zz‖hex(n)`, a tag outside §4.1) that no instruction ever creates, hence System-owned with no data. `owner_citizen` is still the caller's (`free_city` passes `absent(0)`); `nearby: None` passes `absent(1)`. Tests: `cq_placeholders_are_never_a_site_holding`.
- **D-2 (revised), SettleCapture's Free City placeholders.** Positions 6–8 get three **distinct** absent placeholders `absent(3..=5)` (the first run passed the Holding being initialised at position 2 four times). Tests: `cq_builders_match_the_v2_lists_and_fit_a_packet`, `cq_settle_capture_names_captor_and_victim`.
- **D-3 (revised), SettleSiege's slot Citizen when no slot is owed.** Position 4 is `absent(2)` (the first run passed the site Holding, present for every holding site; CQ2-C answers `BadAccount`, so every stake settle failed). `settle_siege`'s `slot_citizen` is now an `Option`. The trailing `ticket_funder` (CQ1-C D-6) is still the slot Citizen's. Test: `cq_settle_siege_stakes_slots_and_season_end` runs with the site Holding present and asserts position 4 is neither it nor present on the chain.
- **D-4, no new role.** `stack::up::keeper_core_roles` pins `config::ROLES` in a test the stack owns, so the conquest writes ride existing roles: SettleCapture, SettleSiege and RetireHost `settle`, FoldMarch `fold`, CloseMarch `close`. NotImplemented (99) turns off only the conquest write kind that met it, never the role.
- **D-5, KEEP (84) is not a separate horn.** Its take rides the same transaction as CONQUEST's KEEP_TAKEN event, which is counted; counting both doubled it.
- **D-6, RetireHost only when `retire_hosts == 1`** (§5.5 check), else nothing is planned (DisbandStranded stays M1's fallback).
- **D-7, "≥ 3 game hours old"** (the R-23 skip trigger) is counted from the end of the unfolded hour (`now_bell / 6 − (h + 1)`), the later of the two readings. **Revised:** the gated metric (`fk_fold_lag_hours`, `fold_lag_hours_p99`, "p99 ≤ 5 game hours") now counts from the hour's start `6h` (`fclient::conquest::fold_lag_hours`, one hour stricter); the end-counted reading is published beside it as `fold_lag_hours_from_end_p99`.
- **D-8 (revised), SettleTransit and the return settle.** `prev_home_holding` is appended after the optional camp Citizen (CQ1-C D-8's trailing group, CQ2-C D-9). **The first run never used it** (`play::settles` built M1's list): now `read_holdings` detects `id.gen == prev_gen ≠ gen` on a captured Holding (`TransitState.prev_home`) and `settles` builds `ix::v2::settle_transit` with it. The return settle (SettleDeparture `0xFF`) now follows CQ2-C's `host::return_target`: a retire Leave bound by RetireHost (`op_a = 1`, `op_ref ≠ 0`) names the **home** Holding `op_ref` binds; an unbound previous-generation Leave of a live captured Holding is not returned while `retire_hosts = 1` (the program waits for RetireHost and answers `AlreadyDone`), and is returned to the issuing Holding when it is 0. `ProvState.leave_ops` carries `(op_a, op_ref)`; `ConquestDuty::refresh_captured` reads the captured Holdings (every 8 slots, at once on a new capture) into `cap_info`. Tests: `cq_settle_transit_of_a_previous_generation_host_names_prev_home`, `cq_return_of_a_retire_leave_names_the_home_holding`.
- **D-9, SkipQuiet's CU** stays M1's `cu_gate` (90k + 30k per recomputed bell): a skipped Province is never contested, so its active-record term is 0. A siege declared between the read and the skip meets the retry ladder.
- `Engine::preview` was added (tests, a dry run); `pools::reveal_floor_for` was factored out of `Payers::with_budgets` (same value).

## 5. Pending (for the integrator and later units)

- **In-process tests on the test-beacon `.so`** (§11 CQ2-D brief: "once CQ2-A/B/C merge"): not written here, since no v2 program exists on this branch. After the merge, a keeper `play`-style test (or CQ3-E's `inproc_cq_day`) should run `CreateSeason v2` on `MC_TEST` and check: a keep taken with the keeper resolving every contested bell, SettleCapture p99 ≤ 12 slots, FoldMarch with zero lost hours, the season-end flush. The account choices of D-1, D-2, D-3 and D-8 must be confirmed against CQ2-C's `proc/conquest.rs` then.
- The relay and bots use `fclient::ix::v2` for DeclareSiege, FileOutpost and RetireHost (CQ2-F, CQ3-C).
- The criterion-3 contested latency and criterion-12 settle latency are only counted here (`contested_resolve_latency_slots_p99`, `capture_settle_latency_slots_p99`); the stack deciders (CQ3-B) read them from `/v1/status`.

## 6. Dependency requests

None. No manifest, lockfile or toolchain change.

## 7. Review round (wave 2): `review:CQ2-D keeper-cq` (needs-fix at `906dd95`)

The reviewer read CQ2-A/B/C's branches by hand; I re-read CQ2-C's `proc/conquest.rs`, `proc/host.rs` and `proc/transit.rs` (branch `frontier/cq-2c-conquest` at `640c28c`) before each fix. Status words are the workflow's.

| # | Severity | Item | Status | What / evidence |
|---|---|---|---|---|
| 1 | blocker | SettleSiege position 4 is the site Holding when no slot is owed (`BadAccount` on CQ2-C) | **fixed** | `Addresses::absent(2)`; test with the site Holding present (§4 D-3). **Cross-unit:** the integrator pins the placeholder as a §19 amendment ("any address no instruction creates; fclient uses the Season's with-seed `zz‖hex(n)`"); CQ2-C's `absent()` accepts it as is |
| 2 | blocker | DeclareSiege `nearby_province` is the target Holding when not needed | **fixed** | `absent(1)`; owner for a Free City `absent(0)` (D-1). `cq_placeholders_are_never_a_site_holding` |
| 3 | major | The season-end lapse of a kind-1 siege is planned before `rn ≥ end_bell`, so SettleSiege can lapse a siege §3.4 lets complete at `end_bell − 1` | **fixed (keeper side)** | `fclient::conquest::siege_settles(…, rn)` plans the lapse only when `now_bell ≥ end_bell && rn ≥ end_bell`; `cq_settle_siege_stakes_slots_and_season_end` (rn 300, 1,007, 1,008) and `cq_siege_settles_and_season_end`. **Cross-unit:** CQ2-C's `settle_plan` lapses on `bell ≥ end_bell` without checking `rn`; a third party (not this keeper) can still land the settle early. The integrator should ask CQ2-C for `NotDue` while `rn < end_bell` (§5.9) |
| 4 | major | The return settle of a RetireHost Leave names the wrong Holding | **fixed** | D-8: `leave_ops`, `fclient::conquest::return_target` / `return_waits` (twin of CQ2-C `host::return_target` / `return_fate`), `cap_info`. `cq_return_of_a_retire_leave_names_the_home_holding`, `cq_return_target_binds_a_retire_leave_to_its_home`. The season-end flush also binds a previous-generation Leave already departed (D-6 of CQ2-C) and plans a roster host's RetireHost only once `rn ≥ end_bell` (D-5, else `TooEarly`): `cq_season_end_retires_waiting_leaves_and_waits_for_the_last_resolve` |
| 5 | major | SettleTransit never appends `prev_home_holding` | **fixed** | D-8; `cq_settle_transit_of_a_previous_generation_host_names_prev_home` (14 accounts, last = `prev_home`; the ordinary transit keeps 13) |
| 6 | major | Criterion-12 latency starts at the first plan, not at CAPTURE_DUE | **fixed** | the base is the CAPTURE_DUE event's slot from the feed (`ConquestDuty.due_slots`, cleared by CAPTURE_SETTLED), else the first read that saw the record; captures that had to wait for their accounts (captor or victim unresolved at least once) are reported apart (`capture_latency_held`, `/v1/status` `capture_settle_held_latency_slots_p99`, §13.4 R-24). Hold windows themselves are the stack decider's (CQ3-B) to attribute |
| 7 | minor | Fold lag counted from the hour's end | **fixed** | D-7: the gated metric counts from `6h`; the old reading is `fold_lag_hours_from_end_p99`. The R-23 trigger keeps its documented reading |
| 8 | minor | "Front of the resolve queue" only reorders `ensure()` | **rebutted, wording fixed** | `Engine::send_kinds` sends every pending write of a tick in that slot (no per-slot cap), so the order inside a tick has no effect on landing; what a horn changes is the immediate Province read (`read_slot = 0`) and the planning pass of this tick. The module table now says "read at once and planned in the same tick". No priority queue added (it would be a new engine rule without a measured need; CQ3-E's rehearsal measures criterion 3) |
| 9 | minor | A restart replays the feed: duplicated journal rows and horn alerts; the 100,000 cap drops records silently | **fixed** | `Journal::max_horn_slot` gives a floor read once; a horn at or below it is counted, not journalled, not alerted, not fronted; `PlayIndex.cq_dropped` → `/v1/status` `conquest.logs_dropped`. `cq_horn_replay_after_a_restart_is_not_journalled_twice` |
| 10 | minor | The land index ignores CAPTURE_SETTLED | **fixed (narrowly)** | the index keeps no owner per Holding (every duty reads the Holding itself), so an owner change leaves nothing stale; only a Free City capture (outcome 2) founds a Holding, which now joins `holdings`. `cq_land_index_takes_a_free_city_capture` |
| 11 | minor | SettleCapture's Free City form repeats one address four times | **fixed** | D-2: three distinct absent placeholders. The `init_funded` on position 2 with these is exercised by CQ2-C's own `Free City` svm tests (`absent(holding)` then `init_funded`); the in-process run on the `.so` is pending (§5) |
| 12 | minor | CloseMarch needs the `fold` role | **fixed** | the Marches come from the opened Provinces (`known_marches`); `cq_close_march_does_not_need_the_fold_role` |
| m1 | missing | In-process keeper tests on the test-beacon `.so` | **deferred (integrator)** | no v2 program exists on this branch; CQ2-A/B/C are unmerged. The account shapes were instead checked against CQ2-C's source (items 1–5, 11). To run after the merge: §5 |
| m2 | missing | Tests driving SettleSiege / DeclareSiege / SettleCapture against a chain where the site Holding exists; the season-end lapse; retire-Leave return; prev-generation SettleTransit | **fixed** | the tests of items 1–5 |
| m3 | missing | No live-chain latency | **deferred (integrator, CQ3-E)** | counted here, measured on the rehearsal |
| m4 | missing | Partly circular keep-contest oracle | **fixed** | the keep test asserts the native `step`'s taking bell and the first idle bell independently of `contest` |
| m5 | missing | Nothing was built or run by the reviewer | n/a | §3 re-run on the final commit |

**Open for the owner (stop_for_owner):** none. No player-visible rule changed.
