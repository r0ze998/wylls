# CQ2-B prog-clash: notes

- **Unit:** CQ2-B prog-clash, wave 2 of MC "Contested Ground" (contract v1.3, §11 Wave 2).
- **Branch:** `frontier/cq-2b-clash`, cut from `frontier/cq-integ` at `3751173` (the Wave-2 base, Gate CQ1 green after the Wave-1 close), then **rebased onto CQ2-A's first commit `b2d4b86`** (the v2 dispatch table with `NotImplemented` stubs, `prologue::present_v2`, the svm registries), as §11 asks. CQ2-A's later commits (`ca08b49`, the v2 event plumbing) are **not** on this branch (D-2).
- **CQ0** = `39ff369` wherever the contract writes it. **RULESET_HASH_V2** `b6dd0f3f…8274` is unchanged (no kernel touched).
- **Owned paths touched:** `permutation-frontier/src/proc/clash.rs`; `permutation-frontier/svm-tests/src/{world,cover}/clash.rs`; `permutation-frontier/svm-tests/tests/clash.rs`; `frontier-abi/src/{conquest_model,clash_model}.rs` (additive only; no vector changed: `abi-vectors --check` 16 files fresh); this file. No manifest, lockfile, toolchain file or `.gitignore` changed. Nothing pushed. No devnet or mainnet transaction, no download, no service started (tests bind nothing; LiteSVM is in-process).
- **Owner decisions:** OD-1…OD-16 are the working defaults the contract and `SUMMARY.ja.md` §6 state (1–12 yes, 13–15 no, 16 stop and ask); nothing here depends on an open one, and none was decided by this unit.

## 1. What landed

### Program (`proc/clash.rs`)

| Item | Contract | What |
|---|---|---|
| Version dispatch | §5.1, R-22 | A 4,736-B Province is an MC Province (`prologue::present_v2`: exact size, magic, season, `layout_version = 2`) and takes the v2 path; any other size is checked as M1's and keeps M1's path byte for byte (D-1) |
| ResolveFromInputs v2 (0x61) | §5.6, §5.7 | `input_digest_v2` (`PSF-CLASH-INPUT-v2` over `province[SITE_MIRROR..TICKET_COHORTS] ‖ province[4096..4736]`) → `build_v2` (Free City and keep garrisons, the keep 13th) → kernel → `report_from_outcome` → `apply_v2` → `settle_bell(b)` → `conquest_model::step(b)` → `finish_bell(b, changed ∨ step.roster_changed)`; also on the `oracle` ResolveClash |
| SkipQuiet v2 (0x63) | §5.6, §5.7, §5.4 | `camp_check_v2` (never on the keep tile), `trivially_quiet_v2`, the kernel's `is_quiet` on `build_v2` at the transaction's first bell; per bell the quiet model's report from the **tile masks, cached** until the roster changes or a roster entry's `from_bell` arrives (`tile_masks_horizon`), then settle, step, finish; the quiet test is re-run after a roster, garrison or camp change and after a step's `quiet_inputs_changed`; the prefix commits before a bell that would take `Σ active records` past 288 (`SKIP_RECORD_BELLS_MAX`; D-6); `quiet_digest_v2` (`PSF-QUIET-v2`) |
| GatherClash `prev_gen` (0x60) | §5.6, §5.8 | a slot whose host id names a captured Holding's previous generation (`capture_flags` bit 0 and `prev_gen`) gathers as present (and its transit is stamped); an M1 Holding's reserve bytes are zero, so M1 behaviour is unchanged |
| The season's step parameters | §5.2.5 | `StepParams::of_season`; `conquest_version ≠ 1` is `BadAccount` |
| MC records | §6 | CONQUEST (82) for every bell whose step `emits()`; at a keep taken KEEP (84, cause 1) and, when the donor goes home with a rest, the donor's RETIRE (86, `by` 2). Each chains the Province. Written by `proc::clash::cqlog` (D-2) |
| The return settle | §3.2 step 5, K-19 | unchanged code; with the v2 Province check it frees the keep donor's retire-style Leave and credits its rest to the donor's Holding (as RetireHost's will be; the captured-Holding `prev_home` branch is CQ2-C's) |

### Shared models (R-21: fixes CQ2-B is the first to execute; no rule changed)

- `conquest_model::report_from_masks(pd, &mask)` (the skip's report from a cached mask; `report_quiet` calls it) and `conquest_model::active_count(pd)` (sieges + occupations + a running keep contest, from the kind bytes; `step`'s `active` now uses it: same value, D-15 unchanged).
- `clash_model::tile_masks_horizon(pd, b)` (the mask and the first later `from_bell`; `tile_masks` calls it).
- Unit test `conquest_model::tests::cq_cached_masks_and_active_count`.
- **No defect was found in the shared models**: every program run below equals them byte for byte.

### LiteSVM (`svm-tests`)

- `world/clash.rs`: on a Season carrying a conquest block (`conquest_version` 1) `craft_fill` crafts the destination as a **Province v2** (4,736 B, `layout_version = 2`, no keep until a test writes one) and `craft_transit_holding` writes v2 headers; `World::{is_mc, conquest, set_conquest, fill_province_bytes_v2, fill_bytes}`, `mc_keep` (the MC keep tile `keep_tile_symmetric` of the fill), `MC_BELL` = 300 (hour 50). On this branch the World's Season is M1's and a test crafts the block; once CQ2-A's World creates v2 Seasons every crafted fill is v2 automatically.
- `tests/clash.rs`, new tests (all pass on the release / test-beacon / trace builds of this branch):

| Test | What it shows |
|---|---|
| `cq_resolve_runs_the_conquest_step_as_the_shared_models` | 124 fills of every kind, each with a keep one bell from taken by six capturers and a siege on every site: the program's Province v2 = the shared models' (every byte but the header chain, last digest, quiet cache and summary), the outcome digest, the CONQUEST payload, KEEP and RETIRE; 661 completions, 110 keeps taken |
| `g01_cq_resolve_worst` | G1 (§13.1) over the 1,244 fills in two shapes, program = models in each (table §2) |
| `g01_cq_resolve_forced_completions` | the 40 heaviest fills with their site owners forced so that as many sieges complete as the clash allows (§2) |
| `g01_cq_skip_worst` | SkipQuiet's worst (§13.1): 12 occupations + an empty-garrison keep contest + 48 residents + 4 hour boundaries (prefix at 22 bells); 11 occupations + the keep (24 bells, exactly 288 record-bells) |
| `g11_cq_skip_equals_resolve_with_records_and_a_keep` | G11 extended: 48 bells skipped vs gathered and resolved every bell, byte-identical over the 4,736 B and the same CONQUEST record every bell, through an occupation expiring, one liberated, a deserted siege failing, a capture completing mid-run, the keep taken mid-run (donor home), 8 snapshots; 3 seeds |
| `cq_keep_taken_sends_the_donor_home_through_the_return_settle` | the donor (lead host: 9,000 troops) pays 4,500 to the keep, its entry becomes a retire-style Leave (`op_a = 1`), KEEP and RETIRE logged, the next bell is quiet, the return settle credits 4,500 whole troops to its Holding, then `AlreadyDone` |
| `cq_snapshot_counts_a_provisional_holding_before_its_final_ts` | **A-29 (PO-7):** a holding whose Holding is provisional with `final_ts` 30 bells ahead is in `snap[h mod 6]` at its strength weight, on the resolve and the skip path, and in the CONQUEST record's snapshot |
| `cq_gather_reads_a_captured_holdings_previous_generation` | `prev_gen` gathers as present (transit stamped); the same host of a re-founded Holding (no capture flag) as absent |
| `g13_cq_clash_refusals` | `Kernel` for an unknown record kind (resolve and skip) and for a siege on a free site (S2); `BadAccount` for a Season without a conquest block (resolve and skip) and for a 4,736-B Province with an M1 header (skip and gather) |

- Host tests in `proc/clash.rs`: `cq_records_are_the_abis` (the MC bodies and chain links are `frontier_abi::v2::log`'s; every MC kind's widths; wrong widths and kinds outside 80–89 refused).
- `cover/clash.rs`: rows for the new tests (GatherClash, ResolveFromInputs, SkipQuiet).

## 2. Measurements (LiteSVM 0.16, SBPF v2 builds of this branch; `.so` 935,432 B release)

**ResolveFromInputs, G1 (§13.1), every bell an hour boundary (bell 300):**

| Shape | Fills | CU max (release) | CU mean | heap max (trace) |
|---|---|---|---|---|
| M1 path, M1's 1,244 fills (reference, base `3751173`) | 1,244 | 271,673 (`wide#235`) | 225,719 | 15,352 B |
| **keep13**: the keep as 13th garrison (100 troops, walls), no record | 1,244 | **279,283** (`wide#235`, +7,610 over M1 on the same fill) | 234,205 | 15,416 B |
| **conquest**: keep one bell from taken by six 30,000-troop capturers + a siege on every site (completing where a hostile faction alone holds the hex, else failing) | 1,244 | **285,645** (`random#286`) | 232,987 | 14,912 B |
| forced owners (40 heaviest fills) | 40 | 229,549 | 211,871 | 12,408 B |

- In the conquest shape: completions per fill 0–12 (mean 5), **292 fills with all 12 sites completing**, the keep taken in 1,138 of 1,244; the heaviest with 12 completions **and** the keep taken: 264,549 CU (`random#210`).
- **The conquest increment** (the same clash with and without the records and the contest; records are not clash inputs): max **5,683 CU** for 12 completions + a keep taken + CONQUEST/KEEP/RETIRE (`spread12n#197`); the lab estimated 6.6k.
- **Worst = max(keep13 max + increment max = 284,966, measured max 285,645) = 285,645 CU ≤ 290,000 (margin 4,355, 1.5%).** The first figure is the bound for §13.1's literal row ("12 completions and the keep taken on top of the worst Phase B fill"), which no single clash produces (D-8).
- **Decision (290k / 300k): 290,000 holds; the 300,000 amendment and the 410k → 420k clash restatement are not needed.**
- After every keep taken, the next bell's clash builds and validates (`clash::validate` with the keep's garrison ≤ `MAX_HOST_TROOPS`; R-01, P13's program side).
- Trace breakdown of the keep13 worst (`wide#235`, `PSF_TRACE=1`): kernel 224,210; `report_from_outcome` + `apply_v2` + settle ≈ 10.5k; **conquest step 3,287** (no record: the snapshot and the keep); finish 1,338; digests and ClashInputs ≈ 7.6k; CAMP/CLASH/CONQUEST logs 5,060. Conquest worst (`random#286`): kernel 218,569, step **7,873**, logs 7,103.
- Loaded data within the **v2** `L(ResolveFromInputs)` (640 B over M1's); tx 453 B (unchanged).

**SkipQuiet, G1 (§13.1, §5.4: gate 90k + 30k a bell + 3.5k an active bell):**

| Fill | Bells | CU release | gate | per bell | heap (trace) | tx |
|---|---|---|---|---|---|---|
| 12 occupations + keep contest (13 active a bell), 48 residents | 22 (prefix: 22 × 13 = 286; the 23rd would pass 288) | 266,591 | 827,000 | 12,118 | 13,648 B | 1,148 B |
| 11 occupations + keep contest (12 a bell) | 24 (288) | 282,351 | 894,000 | 11,765 | 13,648 B | 1,148 B |

- Per bell after the first (trace): loop 1,290 + 218, step and CONQUEST ≈ 6,540 (8,886 at an hour boundary); the first bell carries the kernel's quiet test (57k at 48 residents).

**`.so`:** release 935,432 B on this branch (base `3751173` 876,280 B; +59 KB, of which `conquest_model`, the v2 clash functions and the MC records). `--max-len` 1,171,456.

## 3. Deviations and interpretations

- **D-1, version dispatch.** The program takes the v2 path on a 4,736-B Province and keeps M1's path on any other size, so this branch's M1 tests run unchanged on M1 Provinces while the MC tests run on v2 ones. Once every Province is v2 (CQ2-A's OpenProvince and the harness's v2 Seasons), the M1 path is unreachable in an MC season: the integrator or CQ4-A may remove it (≈ .so bytes) or keep it as the record. The v2 Province check is CQ2-A's `prologue::present_v2`.
- **D-2, MC record emitter.** `proc::clash::cqlog` writes kinds 80–89 chained to the Province (widths evaluated at compile time from `CQ_SPECS`, no pointer table; host test against the ABI's writer and decoder). CQ2-A's `ca08b49` adds `events::emit_cq` with the same body and chain rule; it was committed after this unit had written `cqlog` and is not CQ2-A's first commit, so this branch does not build on it. **Integrator:** after merging CQ2-A, replace the three `cqlog::emit` calls in `emit_conquest` by `events::emit_cq` and delete `cqlog` (the bytes are identical; `cq_records_are_the_abis` then moves to the events test).
- **D-3, the hour snapshot's timing (CQ1-C's open item, integ-W1).** The step writes `snap[]` after the bell's clash write-back and settle, i.e. from the state bell `b` leaves (the shared models' order); §3.10 says "committed garrison at `bell_start(b)`". Kept as the models run it: (1) every reader shares the model, so the herald, verifier, WASM and program agree; (2) the snapshot is then a pure function of the Province bytes after bell b, which a verifier replaying a skip has; (3) carrying a pre-clash weight vector through the resolve would cost CU and heap at the worst fill. **Amendment request (§3.10, integrator):** "the strength weight of the garrison the bell leaves (after its clash and settle)". The weight differs from the `bell_start` reading only by that bell's garrison losses and its settled garrison changes.
- **D-4, record order.** Resolve: CAMP (spawn, clear), CLASH, then CONQUEST, KEEP, RETIRE. Skip: CONQUEST (and KEEP, RETIRE) in bell order inside the loop, then the CAMP spawns, then SKIP. A reader keys CONQUEST by its bell.
- **D-5, units.** KEEP's `troops` is the keep's garrison in whole troops (the keep record's unit). RETIRE's `troops` is the donor's rest in milli-troops (the entry's unit, as M1's DEPARTURE_SETTLED and STRANDED); its `home_key` is the donor's Holding key (`host_id & !0xFFFF_FFFF`). CQ2-C's RetireHost should use the same units.
- **D-6, the prefix rule.** "Commit once bells × active records > 288" is read as: before every bell but the first, stop if the active records counted so far plus this bell's would exceed 288. The first bell always runs (a Province with 13 active records still advances).
- **D-7, conquest block check.** The v2 path requires the Season's `conquest_version` = 1 (else `BadAccount`); CreateSeason v2 validates the rest.
- **D-8, §13.1's literal RFI row.** "12 completing sieges and a keep taken on top of the worst Phase B fill" cannot be one clash: a siege completes only where a hostile faction alone holds the hex with no defender, which removes the fight there. The gate is therefore taken as the larger of the measured worst (the conquest shape over all 1,244 fills, 292 of them with 12 completions) and the bound (the heaviest keep13 fill plus the largest measured increment). Forcing the site owners to raise completions makes the clash cheaper (229,549 max), not dearer.

## 4. Dependency requests and integrator items

- **R1 (svm harness, `src/records.rs`, frozen in wave 2):** `records::records`/`one`/`of_kind` decode with the M1 decoder and panic on an MC kind. Once the harness's Provinces are v2, any M1 test that reads the logs of a skip crossing an hour boundary (CONQUEST at every snapshot) or of a resolve with a keep or records will panic there. Switch the decoder to `frontier_abi::v2::log::decode` (this unit's tests use a local `v2_records`).
- **R2 (svm harness, `src/chain.rs` `Profile`):** `L(kind)` comes from M1's budgets table. A Province v2 is 640 B larger: the return settle (SettleDeparture) on a v2 Province needs 423 B more than M1's `L(SettleDeparture)` at this branch's programdata length (`MaxLoadedAccountsDataSizeExceeded`); ResolveFromInputs and SkipQuiet still fit under the 1-MiB working default. The harness should take `frontier_abi::v2::budgets` for an MC season (this unit's tests send with `loaded_v2`).
- **R3 (`tests/g01_loaded_limit.rs` `g01_loaded_limit_table_covers_the_release_so`):** fails on this branch: the release `.so` (935,432 B, max_len 1,171,456) has outgrown M1's budgets table (`PLACEHOLDER_SO_LEN` 884,736). Expected for the MC program; the v2 table's placeholder (1 MiB) covers it. Switch the test to `frontier_abi::v2::budgets` or regenerate (CQ4-A). This is the only failing test of the full suite (§5).
- **R4 (CQ4-A, budgets):** the v2 row's ResolveFromInputs client limit is the gate (290,000) until regenerated; the M1 rule "measured max + 5%" would give ≈ 299,927, above the gate. CQ4-A decides (limit = gate, or a smaller margin); the gate itself holds (§2).
- **R5 (D-2):** swap `cqlog` for CQ2-A's `events::emit_cq` after the merge.
- **R6 (D-3):** §3.10 snapshot wording.
- No manifest, lockfile or toolchain change requested.

## 5. Gate lines run on this branch

| Line | Result |
|---|---|
| `cargo fmt --all -- --check`; `(cd permutation-frontier/svm-tests && cargo fmt -- --check)` | pass |
| `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` | pass |
| `cargo clippy --locked -p permutation-frontier --all-targets -- -D warnings` | pass |
| `(cd permutation-frontier/svm-tests && cargo clippy --locked --release --all-targets)` | no warning |
| `cargo test --locked -p frontier-abi` | pass (78 unit + 2 + 3 + 14 + 6 + 4 integration) |
| `cargo run --locked -p frontier-abi --bin abi-vectors -- --check` | pass (16 files fresh) |
| `cargo test --locked -p permutation-frontier --no-default-features` | pass (39) |
| `cargo test --locked -p permutation-frontier` | pass (86, incl. `cq_records_are_the_abis`) |
| `scripts/build-frontier.sh` (+ `--features oracle`, `trace`, `test-beacon`) | pass (deployable release; every build passes the relocation check) |
| `(cd permutation-frontier/svm-tests && ./run.sh --release -- g01_cq_ g11_cq_ g13_cq_)` (this unit's prefixes; `g02_cq_`, `g03_cq_`, `p_cq_` are CQ2-A's and CQ2-C's) | pass |
| `(cd permutation-frontier/svm-tests && ./run.sh --release --no-fail-fast)` (every test) | **256 passed, 1 failed, 4 ignored** (the 4 ignored by design: the drill and three `zz_profile_*`). The failure is `g01_loaded_limit_table_covers_the_release_so` (R3) |
| `(cd permutation-frontier/svm-tests && PSF_TRACE=1 ./run.sh --release -- g01_cq_resolve_worst g01_cq_skip_worst --nocapture)` | pass; figures in §2 (`g01_cq_fold`, `g01_cq_declare`, `g01_cq_settle_capture` are CQ2-C's) |
| `(cd frontier-node && cargo test --locked --release --workspace -- cq_)` | pass (18 passed, 0 failed; the workspace builds against the changed models) |
| `scripts/cq-regen.sh --check` | pass (`cq-regen (check): done`, exit 0: every generated output fresh, the WASM included) |
| `scripts/build-frontier.sh --twice` | pass: both builds `bfe914ce…78cd`, 935,432 B |
| Gate CQ1's simulator lines | **not run**: this unit changes no kernel and nothing `frontier-sim` links (it depends on `permutation-rules` only); the integrator's re-run of Gate CQ1 covers them |

## 6. Pending (later units)

- P1–P13 (`p_cq_*`), DeclareSiege, SettleSiege, SettleCapture, FoldMarch, RetireHost, CloseMarch, the `prev_home` transit path and the return settle's captured-Holding branch: CQ2-C.
- `budgets.rs` / `vectors/budgets.json` regenerated from the MC release `.so`: CQ4-A (R4).
- The herald (CQ2-E) and the verifier (CQ3-A) read CONQUEST, KEEP and RETIRE as D-4 and D-5 describe.
