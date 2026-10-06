# CQ1-C abi-v2: notes

- **Unit:** CQ1-C abi-v2, wave 1 of MC "Contested Ground" (contract v1.1, §11).
- **Branch:** `frontier/cq-1c-abi`, cut from `frontier/cq-integ` at `39ff369` (CQ0 as instructed; the contract's preamble writes `d11d058`).
- **Owned paths touched:** `frontier-abi/**` and this file only. No manifest, lockfile, toolchain file or `.gitignore` changed. Nothing pushed.
- **Owner decisions:** OD-1…OD-16 are taken as the working defaults the contract and `SUMMARY.ja.md` §6 state; nothing here depends on an open one. OD-8 (Frontier-7 timers) and OD-12 (4,736-B Province) are built as written.

## 1. What landed

ABI v2 is published **under new names beside v1** (R-16). Every v1 name keeps its value, and every v1 vector file is byte-identical (`git diff frontier-abi/vectors/*.json` is empty; `abi-vectors --check` reports 16 files fresh).

| Path | Contract | Content |
|---|---|---|
| `src/v2/layout/{mod,province,player,world}.rs` | §5.2 | Province v2 (4,736 B: the 640-B conquest block, site-mirror v2 fields, conquest record, keep, snapshot); Holding / Citizen / JoinShard reserve fields; Season v2 (conquest block at 896); MarchState (256 B, `PSF1MRCH`); `AccountKind` v2 (18 kinds, MarchState = 18); `write_header` with `layout_version = 2` |
| `src/v2/tags.rs` | §5.4 | `v2::Ix` (57 = M1's 50 + 0xA0–0xA3, 0xA5–0xA7), classes, reserved 0xA4 and 0xA8–0xAF, relay shapes (§8.3); **`tags::Ix::ALL_V2`** |
| `src/v2/error.rs` | §5.3 | `CqError` 62–78 and the union `Code` with keeper actions |
| `src/v2/log.rs` | §6 | kinds 80–88 (89 reserved), entity kind 8, a v2 decoder over M1 and MC kinds, chains, CONQUEST payload codec, event codes |
| `src/v2/ix.rs` | §5.5, §5.6 | DeclareSiege, SettleSiege, SettleCapture, FileOutpost, FoldMarch, RetireHost, CloseMarch; CreateSeason v2 |
| `src/v2/presets.rs` | §3.12, §5.2.5 | `ConquestParams` (128 B), `SeasonParamsV2`, validation, `FRONTIER_7`, `FRONTIER_28`, `MC_LOCAL_7D`, `MC_SEASON_28`, `MC_TEST`, `params_hash_v2`, `RULESET_HASH_V2` with its pin test |
| `src/v2/budgets.rs` | §5.4, §13.1 | budget placeholders, tx ceilings, the v2 `L(kind)` set at a 1-MiB `.so` estimate |
| `src/v2/prologue.rs` | §5.5, §5.6 | v2 account lists, `check_present_v2` (exact v2 size and `layout_version = 2`), the capture lock |
| `src/v2/entry.rs` | §3.1, §3.2 | lead-host ranking, the retire-style Leave (`op_a = 1`) |
| `src/v2/addr.rs` | §5.2.6 | the `mc` seed, March members |
| `src/v2/kernel.rs` | §7 | **temporary bridge** to the CQ1-A kernels (§3 below) |
| `src/conquest_model.rs` | §5.7, §3.2–§3.6, §3.10 | `step`, `report_from_outcome`, `report_quiet`, `control_weights`, `snapshot_slot`, `fold`, `apply_fold`, `first_hour`, `decode_records`, keep codec, CONQUEST payload |
| `src/clash_model.rs` (appended) | §5.6, §5.7, K-21 | `build_v2`, `apply_v2`, `camp_check_v2`, `trivially_quiet_v2`, `tile_masks`, `input_digest_v2` (`PSF-CLASH-INPUT-v2`), `quiet_digest_v2` (`PSF-QUIET-v2`). The v1 functions are untouched |
| `src/bin/abi-vectors.rs` | §4.4 | + `vectors/v2/{layouts,tags,errors,logs,presets,budgets,conquest}.json` |
| `tests/cq_conquest_model.rs`, `tests/cq_v2_contract.rs` | §4.4, §13.3 | `cq_*` tests (§4 below) |

Two v1 files changed additively, and only these: `prologue::Acc` gains the variant `KindV2(v2::AccountKind)` (no M1 table uses it; `check_flags` treats it like `Kind`), and `budgets::position_data` gains its arm. No crate outside `frontier-abi` matches `Acc` exhaustively (grep of `permutation-frontier`, `frontier-node`, `frontier-wasm`), and `cargo check -p permutation-frontier` and the `frontier-node` line pass (§5).

### The calling order the shared models pin (for CQ2-B)

```text
resolve:  build_v2 → kernel clash → apply_v2 → report_from_outcome
          → settle_bell(b) → conquest_model::step(b, report) → finish_bell(b, changed || step.roster_changed)
skip:     camp_check_v2 → quiet test (trivially_quiet_v2, else the kernel's is_quiet on build_v2)
          → report_quiet(b) → settle_bell(b) → step(b, report) → finish_bell
```

`report_quiet` reads the roster as the clash of b would, so it runs before the bell's settle. `StepOut::quiet_inputs_changed` tells a SkipQuiet to recompute its quiet test: a keep changed hands, a mirror flipped at a capture, or the donor left. `StepOut::emits()` decides the CONQUEST record, and `conquest_payload` builds it.

`BuiltV2::base` lists the keep last in `garrisons` and leaves it out of `gar_site`. v1's `apply` walks `garrisons.zip(gar_site)`, so it writes back every site, the Free Cities included, and the camp, and stops before the keep. `apply_v2` then writes the keep (whole troops, as the camp's). `apply_v2` refuses a `BuiltV2` whose lengths break this.

## 2. Measurements

All figures come from the model and the vector writer. No SBF build was run; CU is CQ2's G1.

| Item | Value |
|---|---|
| Province v2 rent | 24,709,120 lamports (+3,251,200 over M1) [computed] |
| MarchState rent | 1,950,720 lamports [computed] |
| CONQUEST body without tail | 137 B (D-4) |
| tx worst estimate (B; §5.4's value in brackets) | DeclareSiege 595 [640], SettleSiege 397 [480], SettleCapture 594 [720], FileOutpost 616 [640], FoldMarch 606 [720], **RetireHost 494 [480]**, **CloseMarch 330 [300]**; changed rows Harvest 460 [360], Build 461 [400], Train 465 [360], SettleTransit 924 [1,022] (D-11) |
| `L(kind)` at the 1-MiB placeholder `.so` (programdata 1,310,720) | 1,343,488 for every new kind except FoldMarch 1,376,256 (7 Provinces of 4,736 B); SkipQuiet 1,474,560 |
| SkipQuiet v2 limit at 24 bells, every bell with active records (12 records + keep) | 894,000 CU (90k + 24 × 30k + **24** × 3.5k; §5.4 charges 3.5k per active *bell*). *integ-W1 correction:* this row first read "288 × 3.5k", which is 1,818,000 CU, and `skip_gate` took record-bells; `skip_gate(bells, active_bells)` now charges active bells (capped at `bells`) and its test asserts `skip_gate(24, 24) == 894,000 == budget(SkipQuiet).cu_limit ≤ CU_LADDER_MAX` |
| `RULESET_HASH_V2` | `594027561c…d035bf`, **[placeholder]** (stand-in, R1) |
| M1 `RULESET_HASH` | `72c6b583…4bd9`, unchanged and still pinned |

## 3. Dependency requests (integrator)

- **R1, the kernel bridge switch (after CQ1-A merges).** CQ1-A had not started when this unit ran: its branch was at CQ0, with no kernels and no vectors. So that this unit compiles and tests on its own, every call into a new kernel goes through `frontier-abi/src/v2/kernel.rs`. It is written to the §7 signatures and to the §3 rule text, and it is the only file that names a stand-in. After CQ1-A merges:
  1. replace `kernel::{keep, control}` with `pub use permutation_rules::frontier::{keep, control};`, `siege3` with the siege v3 functions, `camp2::place_v2`, `is_heartland_in` and `ruleset_hash_v2` with the kernel items, and adapt in that file wherever CQ1-A's types differ from §7 (`Controller`, `OccupationEnd`, the capturer tuple's troop unit);
  2. delete the stand-in bodies, because no second copy of a rule survives the merge (M1 §3.3);
  3. regenerate `RULESET_HASH_V2` once (`ruleset_hash_v2_is_the_kernels` prints the value) and the v2 vectors (`cargo run -p frontier-abi --bin abi-vectors`), and record the hash in `integ-CQ1-NOTES.md`;
  4. run `cargo test -p frontier-abi`. The `cq_*` scenario tests are expected to stay green, because the stand-ins implement the contract's text. A difference is a CQ1-A/CQ1-C reconciliation in the integration window, and the contract text decides it.
  `MAX_GARRISONS_WITH_KEEP` is in the bridge too. Until CQ1-A's `clash::validate` accepts 13 garrisons, a Province with 12 site garrisons and a keep cannot be resolved by the M1 kernel. The tests use fewer site garrisons.
- **No manifest or lockfile change is requested.** `frontier-abi` still depends only on `permutation-rules` (I-03).
- **cq-regen.sh:** v2 vector files live in `frontier-abi/vectors/v2/`. The generator creates the directory; `abi-vectors --check` covers all 16 files.

## 4. Tests (all `cq_*`, `frontier-abi`)

- **`tests/cq_conquest_model.rs`** (11). Every scenario drives the resolve path through the real M1 clash kernel and the skip path through the quiet model, on two copies of one Province, and requires them byte-identical after every bell. This is G11 extended, at model level, over the whole 4,736 B. The scenarios:
  - keep taken after 72 bells, with the donor handoff (10,000 troops to the keep, 10,000 home through a retire-style Leave);
  - a contest broken by a defender;
  - a heartland keep that never counts;
  - a Free City siege completing into the reserved slot, credited, with `held_since_hour` = ⌈47/6⌉;
  - a siege broken by the defender: stake owed to the holding at `owed_gen`, the attacker's faction barred for 36 bells, the slot owed back;
  - a deserted siege that grants nothing;
  - occupation with the owner's vigil pausing the count from bell 144 to 192; liberation by walking away, without Respite;
  - expiry at tenure with Respite;
  - snapshots and the March fold: strict controller, `FoldTooEarly`, `FoldOutOfOrder`, a lost hour;
  - `build_v2`: Free City garrisons, the keep last, the v2 input digest, `trivially_quiet_v2`;
  - the CONQUEST payload.
- **`tests/cq_v2_contract.rs`** (4):
  - offsets transcribed from §5.2's text;
  - v1 names keep their values (R-16);
  - 20,000 arbitrary inputs to every v2 decoder and to the models (errors, never a panic);
  - a seeded random walk: 24 Provinces × 59 bells of quiet rosters with sieges, occupations, Free Cities, Scouts and keep contests, requiring resolve ≡ skip and equal reports every bell.
- **Unit tests** in `src/v2/**` and `src/conquest_model.rs`, among them `ruleset_hash_v2_is_the_kernels`, `cq_keep_handoff_is_capped` (six 30,000-troop capturers: one donor pays 15,000, R-01), `cq_controller_is_strict`, `cq_siege_v3_and_bounds` and `cq_lead_host_ranks_troops_then_id`.

## 5. Gate CQ1 lines run on this branch

| Line | Result |
|---|---|
| `cargo fmt --all -- --check` | pass |
| `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` | pass |
| `cargo test --locked --release -p permutation-rules` | pass (437 passed, 0 failed, 29 test binaries; 1 min 31 s). The crate is unchanged by this unit |
| `cargo test --locked -p frontier-abi` | pass (76 unit + 2 + 3 + 11 + 4 integration) |
| `cargo run --locked -p frontier-abi --bin abi-vectors -- --check` | pass (16 files fresh) |
| `cargo test --locked -p permutation-chain` | pass (157 passed, 0 failed) |
| `cargo check --locked -p permutation-frontier` | pass |
| `(cd frontier-node && fmt --check && clippy -D warnings && cargo test --workspace)` | fmt and clippy pass. `cargo test --workspace --no-fail-fast`: **423 passed, 1 failed, 11 ignored**. The failure is `herald --test fold checkpoints_save_in_the_background`, a wall-clock assertion ("ingest < 1.4 s": measured 1.54 s, then 5.8 s for the binary), run while the machine's load average was ≈ 36–44 (other wave-1 units and the Gemma spike). Run alone it **passed 3 of 3**. herald reads only v1 `frontier-abi` items, and none of them changed. This needs a rerun on a quiet machine at the gate |
| `(cd permutation-gateway && npm ci --ignore-scripts && npm test)` | **not run**: `npm ci` downloads packages (no installs approved, and this worktree has no `node_modules`). Instead, `node --test test/web-frontier-codec.test.mjs` passed 8 of 8 and `node --test test/frontier-sdk.test.mjs` passed 18 of 18. The v1 vectors they read are byte-identical |
| frontier-sim lines, `scripts/cq-ownership-check.sh` | not CQ1-C's (CQ1-B, CQ1-D) |

## 6. Deviations and interpretations (the contract leaves these open)

- **D-1, kernel bridge.** See R1. `RULESET_HASH_V2` is a placeholder: `sha256("PSF-RULESET-v2-STANDIN" ‖ RULESET_HASH ‖ §3.13 versions ‖ §3.14 constants)`.
- **D-2, camp v2 stand-in.** A daily camp draw that lands on the keep tile gives no camp that day. CQ1-A's `place_v2` may draw among the other tiles instead; only the bridge changes.
- **D-3, dormancy timers.** They appear in both M1's `SeasonParams` part and the conquest block (§5.2.5 lists them in the block). `SeasonParamsV2::validate` requires the two copies to be equal.
- **D-4, CONQUEST size.** The body is 137 B, over the 128-B soft ceiling of §6. It is a listed exception, as M1's CLASH and DEPART are. The fields are exactly §6's.
- **D-5, event encoding.** Bit 7 of an event's `code` is the detail bit of §6. The `progress` byte carries:
  - SIEGE_FAILED: the progress reached;
  - OCCUPIED and CAPTURE_DUE: `required`;
  - KEEP_CONTEST: 1;
  - KEEP_BROKEN: the progress lost;
  - **KEEP_TAKEN: the previous holder**;
  - LIBERATED and EXPIRED: 0.
- **D-6, SettleSiege account.** SettleSiege gets an optional trailing `[ticket_funder w]`. The escrow refund needs a destination account, and §5.5's list has none.
- **D-7, budget base values.** GatherClash keeps M1's 49,000 gate and SkipQuiet its 90,000 base, where §5.4 quotes 40k and 60k (older M1 numbers). Lowering a gate is not MC's to do. The 3.5k per active bell (a bell with at least one active record or keep contest, §5.4) is added; *integ-W1:* `skip_gate` first charged it per record-bell, corrected (§2).
- **D-8, SettleTransit account.** `[prev_home_holding w]` is an optional trailing group. §5.6 asks for "a fixed position"; CQ2-C may pin another place.
- **D-9, stake after an occupation (revised by the integrator, integ-W1).** §3.5 does not say where the stake goes after an occupation. The step first owed it back to the source holding (flags bit 2) only when the occupation ended, so an occupation still running at `end_bell` never returned it (occupations end with the season; SettleSiege's season-end case covers kind 1 only). **Now** the occupation record carries flags bit 2 from the completion bell (the simulator returns the stake at completion too): SettleSiege may pay it while the occupation runs (`SIEGE_SETTLED` reason 1), an unpaid bit is carried into the kind-0 record when the occupation ends, and `Record::owes()` covers kind 2. Contract text to amend (§5.2.1 record table: kind 2 uses flags bit 2; §5.5 SettleSiege applies to it): listed in integ-CQ1-NOTES §7.
- **D-10, provisional holdings.** The snapshot and `control_weights` count every site in state 1, provisional holdings included. The Province carries no finality bit, and a provisional holding exists for at most about 24 bells. Excluding them would need a mirror bit (an amendment before the layout freezes at Gate CQ1). *integ-W1:* this contradicts normative §3.10 ("each final holding … Provisional … sites add nothing"); finality is a Holding fact (`final_ts`, the cohort) that the lazy flip writes only when the owner acts, so a mirror bit would lag it. **Escalated as PO-7** (integ-CQ1-NOTES §6): amend §3.10 to count provisional holdings, or reserve a finality bit with CQ2-A's write paths. `frontier-abi/src/layout/**` does not freeze until it is decided.
- **D-11, tx ceilings.** RetireHost (two signers, 494 B), CloseMarch (330 B) and the changed Harvest, Build and Train rows estimate above §5.4's tx column. The ceiling is raised to the estimate by M1's own rule (`tx_ceiling`).
- **D-12, immunity and Respite end bell (Respite part withdrawn, integ-W1).** Post-siege and post-capture immunity end at `b + 1 + immunity_bells` (§3.4, §3.6 as written). Respite now ends at `end + respite_bells` exactly as §3.5 writes (the simulator's rule); the step first wrote `b + 1 + respite_bells`. Model test `cq_occupation_expires_with_respite` and vector `liberated_by_owner` follow.
- **D-13, donor handoff.** The step runs after `settle_bell(b)`, so it settles the donor's retire-style Leave at once: state Departed, `op_a = 1`, `pend_bell = b`, the rest's troops. A rest below `MIN_HOST_TROOPS` frees the entry. Candidates are the contender's roster hosts on the tile with no pending op, a non-civilian unit and `from_bell ≤ b + 1`, so the bell's arrivals that stayed are included.
- **D-14, capture flip.** At the completion bell the mirror becomes the captor's holding (state 1, `order` = the reserved slot, `gen + 1`), and the Holding is created later by SettleCapture. Committed walls are halved unless the captor's doctrine `keeps_walls_on_capture`; queued wall items are left alone, because the queue stays (§3.6).
- **D-15, active records.** "Active" means a siege or an occupation, or a keep contest. A capture-due record is open but waiting, so it does not emit CONQUEST every bell or count in SkipQuiet's per-record term.
- **D-16, separate v2 enums.** `v2::Ix` and `CqError` are new enums, because the M1 program dispatch and the svm coverage table match `tags::Ix` exhaustively. `tags::Ix::ALL_V2` names the v2 set.
- **D-17, extra validation ranges.** `ConquestParams::validate` adds sanity ranges §5.2.5 does not list: `outpost_range` 1–8, `outpost_tier_min` ≤ 3, `outpost_close_bells < end_bell`, `retire_hosts` ≤ 1, a non-zero Dominion. Remove any the integrator does not want.
- **D-18, preset funding.** `MC_LOCAL_7D.pfund_initial` rises to 21 SOL, test SOL, so that ring 16 is funded at the 4,736-B rent. `MC_SEASON_28`'s M1 fields other than its length, join close and dormancy are `MC_LOCAL_7D`'s, as placeholders for the M2 sheet.

## 7. Pending (later units)

- OpenProvince's keep placement and genesis Free City need `terrain::free_city_site` (CQ1-A) and belong to CQ2-A. `kernel::keep::open` and `keep_tile` are already here.
- The program's use of the models, G1 budgets and the 290k/300k decision belong to CQ2-B. Model fixes it finds are CQ2-B's: `conquest_model.rs` and `clash_model.rs` are CQ2-B's files in wave 2 (R-21).
- `budgets.rs` and `vectors/budgets.json` are regenerated from the MC release `.so` by CQ4-A.


## 8. Integration-window changes (integ-W1, after the review of CQ1-C)

The integrator changed these in `frontier/cq-integ` (one commit, vectors regenerated in it):

- `skip_gate(bells, active_bells)` charges 3.5k per active **bell**, capped at `bells` (§5.4); `skip_gate(24, 24) = 894,000 = budget(SkipQuiet).cu_limit ≤ CU_LADDER_MAX`.
- D-9 revised and the Respite part of D-12 withdrawn (above).
- Build's `[province]` is `Wr::Either` (§5.6: `r`, `w` only for a tier-up), as M1's Reveal; `vectors/v2/tags.json` shows `r|w`.
- Hand copies replaced by the kernel: `ConquestParams::validate` and `MAX_TIMER_BELLS` / `MAX_GUARD_TROOPS` read `permutation_rules::frontier::conquest_bounds`; `Record::bars` is `siege::immunity_bars`; `capture_flip`'s hour is `siege::held_since_hour_from`; `tier_of` is `control::tier_from_u8`. The capture flip's wall rule stays inline (`holding::capture_effects` takes a `Holding`, which the step does not have); it equals the kernel's for every walls value ≤ `MAX_WALLS`.
- New tests: `tests/cq_kernel_vectors.rs` (6 `cq_*`) replays `permutation-rules/vectors/{keep,control}-vectors-v1.json` through the model's byte path (keep codec, `step` with the capturers as roster entries, the quiet run, `control_weights` with the 1-based order, `dominion_lead`, the bridge's `keep_tile`); `cq_owner_liberation_gives_respite_against_the_occupier_only`; `cq_twelve_sites_and_the_keep_drop_the_camp_and_write_the_keep` (13 garrisons, the camp dropped, `apply_v2` writes the keep).
- **Open for CQ2-B (not changed):** the hour snapshot reads the mirror garrison after the bell's clash losses and `settle_bell(b)`, while §3.10 writes "committed garrison at `bell_start(b)`". Every reader shares the model, so they agree with each other; CQ2-B either snapshots before the clash/settle or the integrator amends §3.10 (integ-CQ1-NOTES §7).
- **PO-6 note:** `prologue::Acc::KindV2` and the `budgets::position_data` arm are CQ1-C's additions to v1 modules; they are among the causes of the v1 WASM artefact's changed bytes (behaviour identical, integ-CQ1-NOTES §2). Moving them to v2-local types is the fix if the owner requires the M1 bytes back.
