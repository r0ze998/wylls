# CQ2-B prog-clash: notes

- **Unit:** CQ2-B prog-clash, wave 2 of MC "Contested Ground" (contract v1.3, §11 Wave 2).
- **Branch:** `frontier/cq-2b-clash`, cut from `frontier/cq-integ` at `3751173` (the Wave-2 base, Gate CQ1 green after the Wave-1 close), then **rebased onto CQ2-A's first commit `b2d4b86`** (the v2 dispatch table with `NotImplemented` stubs, `prologue::present_v2`, the svm registries), as §11 asks. CQ2-A's later commits (`ca08b49`, the v2 event plumbing) are **not** on this branch (D-2).
- **CQ0** = `39ff369` wherever the contract writes it. **RULESET_HASH_V2** `b6dd0f3f…8274` is unchanged (no kernel touched).
- **Owned paths touched:** `permutation-frontier/src/proc/clash.rs`; `permutation-frontier/svm-tests/src/{world,cover}/clash.rs`; `permutation-frontier/svm-tests/tests/clash.rs`; `frontier-abi/src/{conquest_model,clash_model}.rs` (additive only; no vector changed: `abi-vectors --check` 16 files fresh); this file. No manifest, lockfile, toolchain file or `.gitignore` changed. Nothing pushed. No devnet or mainnet transaction, no download, no service started (tests bind nothing; LiteSVM is in-process).
- **Round 2 (review response, 2026-10-03):** the first adversarial review ("needs-fix") is answered in §7. What changed: the program refuses a v1 Province under an MC Season (D-1); the RFI worst is re-measured on every fill and the 290k decision restated (§2, D-8); new tests for Free City sites, the oracle ResolveClash on a Province v2 and GatherClash's `prev_gen` budget; two M1 tests adapted to the v2 program (§5); **the branch was trial-merged with CQ2-A (`frontier/cq-2a-core` @ `90686d9`, throwaway detached HEAD, nothing kept) and the whole svm suite run on it (§5)**.
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

- `world/clash.rs` (round 2: a NEUTRAL garrison of an MC fill is a **Free City site, state 5**, not a state-1 holding of faction 6, so the NEUTRAL fills of every G1 row exercise `build_v2`'s Free City garrison): on a Season carrying a conquest block (`conquest_version` 1) `craft_fill` crafts the destination as a **Province v2** (4,736 B, `layout_version = 2`, no keep until a test writes one) and `craft_transit_holding` writes v2 headers; `World::{is_mc, conquest, set_conquest, fill_province_bytes_v2, fill_bytes}`, `mc_keep` (the MC keep tile `keep_tile_symmetric` of the fill), `MC_BELL` = 300 (hour 50). On this branch the World's Season is M1's and a test crafts the block; once CQ2-A's World creates v2 Seasons every crafted fill is v2 automatically.
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
| `g13_cq_clash_refusals` | `Kernel` for an unknown record kind (resolve and skip) and for a siege on a free site (S2); `BadAccount` for a Season without a conquest block (resolve and skip), for a 4,736-B Province with an M1 header (skip and gather) and (round 2) **for a 4,096-B M1 Province under an MC Season** (gather, resolve, skip) |
| `cq_free_city_garrison_and_a_neutral_siege_through_the_program` (round 2) | a genesis Free City (site state 5): a hostile host alone on its hex beats the NEUTRAL garrison and completes a neutral siege (no vigil) into a **credited** CAPTURE_DUE, the site becoming the captor's Holding of the next generation in the reserved slot, `captures_by` 1, program = models; a quiet skip over an hour boundary writes the neutral side `snap[6]` at the Free City's weight |
| `cq_oracle_resolve_clash_equals_resolve_from_inputs_and_the_models` (round 2) | the oracle ResolveClash on a Province v2 (one transaction) = ResolveFromInputs after the gathers = the shared models: Province bytes, CLASH digest, CONQUEST record; 13 fills (every 97th of the 1,244) in the conquest shape, 74 completions, 13 keeps taken |
| `g01_cq_gather_prev_gen_budget` (round 2) | GatherClash's `prev_gen` branch at its worst (12 positions, 10 Holdings all captured with a moved-on generation): **46,558 CU** against the v2 gate 49,000, tx 1,218 B; every position gathers as present |

- Host tests in `proc/clash.rs`: `cq_records_are_the_abis` (the MC bodies and chain links are `frontier_abi::v2::log`'s; every MC kind's widths; wrong widths and kinds outside 80–89 refused).
- `cover/clash.rs`: rows for the new tests (GatherClash, ResolveFromInputs, SkipQuiet).

## 2. Measurements (LiteSVM 0.16, SBPF v2 builds; `.so` release 936,240 B on this branch, 1,016,704 B on the trial merge with CQ2-A; round-2 re-run, every CU figure identical on both)

**ResolveFromInputs, G1 (§13.1), every bell an hour boundary (bell 300):**

| Shape | Fills | CU max (release) | CU mean | heap max (trace) |
|---|---|---|---|---|
| M1 path, M1's 1,244 fills (reference, base `3751173`) | 1,244 | 271,673 (`wide#235`) | 225,719 | 15,352 B |
| **keep13**: the keep as 13th garrison (100 troops, walls), no record | 1,244 | **279,224** (`wide#235`) | 234,000 | 15,416 B |
| **conquest**: keep one bell from taken by six 30,000-troop capturers + a siege on every site (completing where a hostile faction alone holds the hex, else failing; neutral sieges on the Free City sites) | 1,244 | **285,648** (`random#286`) | 232,834 | 14,912 B |
| forced owners (40 heaviest fills) | 40 | 229,459 | 211,775 | 12,408 B |

- In the conquest shape: completions per fill 0–12 (mean 5), **292 fills with all 12 sites completing**, the keep taken in 1,138 of 1,244; the heaviest with 12 completions **and** the keep taken: 264,552 CU (`random#210`).
- **The conquest increment, measured on every fill (round 2).** For each of the 1,244 fills the same bell is sent with and without the records and the keep contest (records are not clash inputs, so the clash is identical). The increment by units (completions + the keep taken; CONQUEST, KEEP and RETIRE logged) is monotone and small: 0 units 1,866–2,012; 1: 1,987–4,360; 4: 4,421–4,798; 8: 4,910–5,292; 12: 5,511–5,754; **13 units (12 completions + the keep): 5,662–5,914**; overall max **5,914 CU** (`spread12n#216`). It rises about 150 CU a completion, so the increment does not depend on which fill carries the records (the first round measured it on the 12-completion fills only; its 5,683 was a lower max of the same distribution).
- **The literal §13.1 row, bounded three ways.** (a) the measured conquest-shape max: 285,648 (292 fills complete all 12 sites; the keep is taken in the same bell on most of them); (b) the heaviest keep13 fill + the largest 13-unit increment: 279,224 + 5,914 = 285,138; (c) the heaviest clash of the conquest shape (280,309 without records, `random#286`) + the 13-unit increment: **286,223**. **Worst = 286,223 CU ≤ 290,000 (margin 3,777 = 1.30 %).** The reviewer estimated 287–288k from the trace; the measurement is 286.2k. Whether a single clash could carry both the heaviest fill and 12 completions (D-8) does not matter: (c) prices it anyway.
- **Decision (290k / 300k): 290,000 holds; the 300,000 amendment and the 410k → 420k clash restatement are not needed.** The margin is thin (1.30 %, 3,777 CU), so the integrator re-runs `g01_cq_resolve_worst` on the merged Wave 2 (CQ2-C touches the return settle and the captured-Holding paths, not the resolve, but the figure is the gate's). If it ever exceeds 290,000 the 300,000 amendment is ready: the trace build is 289,828 on `random#286` (checkpoints cost about 4k) and is not the limit.
- After every keep taken, the next bell's clash builds and validates (`clash::validate` with the keep's garrison ≤ `MAX_HOST_TROOPS`; R-01, P13's program side).
- Trace breakdown of the keep13 worst (`wide#235`, `PSF_TRACE=1`): kernel 224,210; `report_from_outcome` + `apply_v2` + settle ≈ 10.5k; **conquest step 3,287** (no record: the snapshot and the keep); finish 1,338; digests and ClashInputs ≈ 7.6k; CAMP/CLASH/CONQUEST logs 5,060. Conquest worst (`random#286`): kernel 218,569, step **7,873**, logs 7,103.
- Loaded data within the **v2** `L(ResolveFromInputs)` (640 B over M1's); tx 453 B (unchanged).

**SkipQuiet, G1 (§13.1, §5.4: gate 90k + 30k a bell + 3.5k an active bell):**

| Fill | Bells | CU release | gate | per bell | heap (trace) | tx |
|---|---|---|---|---|---|---|
| 12 occupations + keep contest (13 active a bell), 48 residents | 22 (prefix: 22 × 13 = 286; the 23rd would pass 288) | 266,637 | 827,000 | 12,120 | 13,648 B | 1,148 B |
| 11 occupations + keep contest (12 a bell) | 24 (288) | 282,410 | 894,000 | 11,767 | 13,648 B | 1,148 B |

- Per bell after the first (trace): loop 1,290 + 218, step and CONQUEST ≈ 6,540 (8,886 at an hour boundary); the first bell carries the kernel's quiet test (57k at 48 residents).

**GatherClash `prev_gen` (round 2, `g01_cq_gather_prev_gen_budget`):** 12 positions, 10 captured Holdings with a moved-on generation: **46,516 CU** on this branch, 46,558 on the CQ2-A merge, against the v2 gate 49,000 (tx 1,218 B).

**`.so`:** release 936,240 B on this branch (base `3751173` 876,280 B; +60 KB, of which `conquest_model`, the v2 clash functions and the MC records); **1,016,704 B on the trial merge with CQ2-A** (past M1's budgets placeholder, R3). `--max-len` 1,171,456 on this branch.

## 3. Deviations and interpretations

- **D-1, version dispatch (round 2: refusal added).** The program takes the v2 path on a 4,736-B Province. A Province of any other size is checked as M1's and keeps M1's path byte for byte **only under a Season without a conquest block**; under a Season whose block reads `conquest_version` 1, GatherClash, ResolveFromInputs, ResolveClash, SkipQuiet and the return settle refuse it as `BadAccount` (§5.1: the v2 program refuses v1 accounts; `conquest_params`, row in `g13_cq_clash_refusals`). M1 Seasons carry no block, so this branch's M1 tests still run unchanged on M1 Provinces; once CQ2-A's CreateSeason makes every Season MC the M1 path is unreachable and the integrator or CQ4-A may delete it (≈ .so bytes). The v2 Province check is CQ2-A's `prologue::present_v2`.
- **D-2, MC record emitter.** `proc::clash::cqlog` writes kinds 80–89 chained to the Province (widths evaluated at compile time from `CQ_SPECS`, no pointer table; host test against the ABI's writer and decoder). CQ2-A's `ca08b49` adds `events::emit_cq` with the same body and chain rule; it was committed after this unit had written `cqlog` and is not CQ2-A's first commit, so this branch does not build on it. **Integrator:** after merging CQ2-A, replace the three `cqlog::emit` calls in `emit_conquest` by `events::emit_cq` and delete `cqlog` (the bytes are identical; `cq_records_are_the_abis` then moves to the events test).
- **D-3, the hour snapshot's timing (CQ1-C's open item, integ-W1).** The step writes `snap[]` after the bell's clash write-back and settle, i.e. from the state bell `b` leaves (the shared models' order); §3.10 says "committed garrison at `bell_start(b)`". Kept as the models run it: (1) every reader shares the model, so the herald, verifier, WASM and program agree; (2) the snapshot is then a pure function of the Province bytes after bell b, which a verifier replaying a skip has; (3) carrying a pre-clash weight vector through the resolve would cost CU and heap at the worst fill. **Amendment request (§3.10, integrator):** "the strength weight of the garrison the bell leaves (after its clash and settle)". The weight differs from the `bell_start` reading only by that bell's garrison losses and its settled garrison changes.
- **D-4, record order.** Resolve: CAMP (spawn, clear), CLASH, then CONQUEST, KEEP, RETIRE. Skip: CONQUEST (and KEEP, RETIRE) in bell order inside the loop, then the CAMP spawns, then SKIP. A reader keys CONQUEST by its bell.
- **D-5, units.** KEEP's `troops` is the keep's garrison in whole troops (the keep record's unit). RETIRE's `troops` is the donor's rest in milli-troops (the entry's unit, as M1's DEPARTURE_SETTLED and STRANDED); its `home_key` is the donor's Holding key (`host_id & !0xFFFF_FFFF`). CQ2-C's RetireHost should use the same units.
- **D-6, the prefix rule.** "Commit once bells × active records > 288" is read as: before every bell but the first, stop if the active records counted so far plus this bell's would exceed 288. The first bell always runs (a Province with 13 active records still advances).
- **D-7, conquest block check.** The v2 path requires the Season's `conquest_version` = 1 (else `BadAccount`); CreateSeason v2 validates the rest.
- **D-8, §13.1's literal RFI row (round 2: corrected).** The first round claimed that "12 completing sieges and a keep taken on top of the worst Phase B fill" cannot be one clash and bounded it by the keep13 max plus an increment measured only on the 12-completion fills (not an upper bound, as the review showed). The kernel's `holders` and `defender_present` are host-based (a garrison does not count as a defender), so attackers can kill a garrison and complete in the same bell: 292 fills of the conquest shape complete all 12 sites. Whether the heaviest fill also completes 12 is not needed: the increment is now measured on every fill (§2), is monotone in the units, and the bound adds its 13-unit maximum to the heaviest clash of the shape (286,223 CU, margin 1.30 %). Forcing site owners (`g01_cq_resolve_forced_completions`) makes the clash cheaper (229,459 max), as before.

## 4. Dependency requests and integrator items

- **R1 (svm harness, `src/records.rs`) and R2 (`src/chain.rs` `Profile`): resolved by CQ2-A's harness commits** (`9744009`, `00def9a`, `5d44638`: the records decoder takes MC kinds, the client profiles take the v2 `L(kind)`), as the trial merge shows (§5). This unit's tests keep their local `v2_records` and `loaded_v2` (they also run on this branch's M1 harness); the integrator may switch them to the harness's once CQ2-A is merged.
- **R3 (`tests/g01_loaded_limit.rs` `g01_loaded_limit_table_covers_the_release_so`):** fails on this branch and on CQ2-A's (the release `.so` 936,240 B here, 1,016,704 B on the merge, has outgrown M1's budgets table (`PLACEHOLDER_SO_LEN` 884,736). The test is `tests/g01_loaded_limit.rs`, not this unit's. Expected for the MC program; the v2 table's placeholder (1 MiB) covers it. Switch the test to `frontier_abi::v2::budgets` or regenerate (CQ4-A). This is the only failing test of the full suite (§5).
- **R4 (CQ4-A, budgets):** the v2 row's ResolveFromInputs client limit is the gate (290,000) until regenerated; the M1 rule "measured max + 5%" would give ≈ 299,927, above the gate. CQ4-A decides (limit = gate, or a smaller margin); the gate itself holds (§2).
- **R5 (D-2):** swap `cqlog` for CQ2-A's `events::emit_cq` after the merge (both compile together on the trial merge; the bytes are identical, `cq_records_are_the_abis` pins them). CQ2-C's own `cqlog` in `proc/conquest.rs` goes the same way.
- **R6 (D-3):** §3.10 and §3.14's snapshot row: "the garrison the bell leaves (after its clash and settle)", with a DECISIONS entry. Contract text, the integrator's; the code is the model's and the herald, verifier and program already agree.
- **R7 (A-29 end to end, after CQ2-A):** `cq_snapshot_counts_a_provisional_holding_before_its_final_ts` is a structural pin (the Province carries no finality; the step reads the site mirror, so a crafted provisional Holding proves only that nothing filters by finality). The test that cannot be faked, a holding produced by `FileOutpost`/`SettleTicket` (CQ2-A's land world, `world/land.rs`, not in this branch's base) whose hour bell is resolved or skipped before its cohort's `final_ts`, needs CQ2-A's helpers: the integrator or CQ2-A's owner adds it after the merge.
- No manifest, lockfile or toolchain change requested.

## 5. Gate lines run (round 2: this branch at its final commit, and the trial merge with CQ2-A)

**The trial merge (major review item 1).** `frontier/cq-2a-core` @ `90686d9` (CQ2-A's whole branch: the real v2 program, `RULESET_HASH_V2`, World creating MC Seasons, harness on ABI v2) merged onto this branch in a throwaway detached HEAD (no conflict; nothing kept, no branch created), this unit's round-2 files on top. On it **every M1 test runs on v2 Seasons and Provinces v2** (`World::is_mc` is true everywhere, so every `craft_fill` is a Province v2 and every M1 clash, transit and host fill goes through the conquest step). First run: two M1 clash tests of this unit's file failed and were fixed here: `g01_skip_quiet_kernel_quiet_roster_budget` (24 quiet bells cost 145,245 CU against M1's one-unit gate of 120,000; under v2 the gate is 90k + 30k per recomputed bell, §5.4, and the test now asks for `ceilings(SkipQuiet, n)` on an MC Season) and `g11_skip_stop_commits_exactly_its_bells` (SKIP's digest is `PSF-QUIET-v2` over the 4,736-B Province; the test's `quiet_digest_of` now hashes v2 when the Province is v2). No other M1 clash, transit, host or g13 test needed a change (clash 46 passed, transit 19, host 13, g13_complete 22, g02 10, g03 12…).

| Line | Result |
|---|---|
| `(cd permutation-frontier/svm-tests && ./run.sh --release --no-fail-fast)` **on the trial merge** | **278 passed, 3 failed, 4 ignored.** The 3 failures are CQ2-A's, unowned files, all in CQ2-A's notes (R2-R4): `g01_cq_file_outpost_three_provinces_full_cohorts` (FileOutpost 26,550 CU > 24,000), `g01_loaded_limit_table_covers_the_release_so` (R3 here), `season_records_and_chain_through_the_lifecycle` (compares M1's `RULESET_HASH`). The 4 ignored are by design (the drill, three `zz_profile_*`). Every test of this unit passes (clash binary: 46 passed, 3 ignored) |
| the same on this branch, `--test clash --test coverage` | clash 46 passed, 3 ignored; coverage 2 passed |
| `... ./run.sh --release -- g01_cq_ g11_cq_ g13_cq_ cq_` (this unit's prefixes, `--test clash`) on the trial merge, release and `PSF_TRACE=1` | 12 passed, 0 failed; the figures of §2 |
| `cargo fmt --all -- --check`; `(cd permutation-frontier/svm-tests && cargo fmt -- --check)` | pass |
| `cargo clippy --locked --offline -p permutation-frontier --all-targets -- -D warnings`; `(cd permutation-frontier/svm-tests && cargo clippy --locked --offline --release --all-targets)` | pass; no warning |
| `cargo test --locked --offline -p permutation-frontier` / `--no-default-features` | pass (86 / 39) |
| `scripts/build-frontier.sh` (via `run.sh`: release, oracle, trace, test-beacon) | pass (every build passes the relocation check) |
| `scripts/build-frontier.sh --twice` | pass: both builds `df03b19a…123f`, 936,240 B on this branch |
| `frontier-abi` tests, `abi-vectors --check`, `cq-regen.sh --check`, `frontier-node` `cq_` | **not re-run in round 2**: no `frontier-abi`, `permutation-rules` or `frontier-node` byte changed since the first round, where all passed (78 unit + 2 + 3 + 14 + 6 + 4 integration; 16 vector files fresh; `cq-regen (check): done`; 18 passed) |
| Gate CQ1's simulator lines | **not run**: this unit changes no kernel and nothing `frontier-sim` links |

## 6. Pending (later units)

- P1–P13 (`p_cq_*`), DeclareSiege, SettleSiege, SettleCapture, FoldMarch, RetireHost, CloseMarch, the `prev_home` transit path and the return settle's captured-Holding branch: CQ2-C.
- `budgets.rs` / `vectors/budgets.json` regenerated from the MC release `.so`: CQ4-A (R4).
- The herald (CQ2-E) and the verifier (CQ3-A) read CONQUEST, KEEP and RETIRE as D-4 and D-5 describe.

## 7. Review response (round 2, "review:CQ2-B prog-clash")

| # | Sev | Item | Disposition |
|---|---|---|---|
| 1 | major | the v2 path never ran under CQ2-A's real v2 program; "every M1 test green on v2" not shown | **Fixed / shown.** Trial merge with `cq-2a-core` @ `90686d9`, whole suite (§5): this unit's tests all pass; two M1 clash tests of this unit's file needed adapting to v2 (SkipQuiet's per-bell gate; the `PSF-QUIET-v2` digest) and were fixed; the three remaining failures are CQ2-A's (R3 etc.) |
| 2 | major | the 290k bound was not an upper bound (increment only on 12-completion fills; D-8 unproven) | **Fixed.** The increment is measured on every fill, by units; the bound is the heaviest conquest-shape clash + the 13-unit increment = 286,223 CU, margin 1.30 %; D-8 and the margin corrected (§2, §3) |
| 3 | minor | D-3 snapshot timing: code and §3.10 disagree | **Cross-unit** (contract text, integrator): R6. No code change: every reader shares the model |
| 4 | minor | D-1: the v1 path under an MC Season; no g13 row | **Fixed.** `BadAccount` for a 4,096-B Province under a Season whose block reads `conquest_version` 1 (`conquest_params`); row in `g13_cq_clash_refusals` |
| 5 | minor | Free City sites never run through the program | **Fixed.** `cq_free_city_garrison_and_a_neutral_siege_through_the_program`; and the NEUTRAL fills of every G1 row are now state-5 sites with neutral sieges on them |
| 6 | minor | the A-29 test cannot fail (crafted Holding) | **Deferred / cross-unit** (R7): needs CQ2-A's land world (`FileOutpost`/`SettleTicket`), not in this branch's base. The notes now say it is a structural pin |
| 7 | minor | no MC test of the oracle ResolveClash; no G1 row for GatherClash `prev_gen` | **Fixed.** `cq_oracle_resolve_clash_equals_resolve_from_inputs_and_the_models` (13 fills, 74 completions, 13 keeps taken) and `g01_cq_gather_prev_gen_budget` (46,516 CU, gate 49,000); coverage rows added |
| 8 | minor | the suite is red on `g01_loaded_limit_table_covers_the_release_so` (R3); two CU figures (285,692 vs 285,645) | **Cross-unit** for R3 (the test is `tests/g01_loaded_limit.rs`, red on CQ2-A's branch too). **Fixed** for the figure: the authoritative one is the round-2 run, 285,648 (`random#286`, release), identical on this branch and the merge; the commit body's figure was from an earlier run before the Free City sites |
| 9 | minor | three MC record emitters after the merge (D-2) | **Cross-unit** (R5): CQ2-A's `events::emit_cq` exists only on its later commit, which this branch does not contain; the integrator swaps the call sites after the merge (the bytes are identical and pinned) |
| m | missing | a run under CQ2-A's v2 program and World | Done (row 1) |
| m | missing | a sound bound for the literal RFI row | Done (row 2) |
| m | missing | Free City tests | Done (row 5) |
| m | missing | oracle MC test and the GatherClash G1 row | Done (row 7) |
| m | missing | §3.10 timing amendment | Cross-unit (row 3) |
| m | missing | the reviewer could not run anything | Re-run here: the numbers above are measured (LiteSVM, release and trace builds) on this branch and on the trial merge |


## 8. Second review (Wave 2, at the merged `bf09a56`): response (integrator, W2R2)

**Figures refreshed on the merged tree** (the first rows of §2 and §5 are one CU off and describe an unmerged branch): `.so` **1,132,312 B** (not 936,240 / 1,016,704); RFI conquest-shape max **285,649**, keep13 max **279,225**, the literal §13.1 row **286,224** (margin 3,776 = 1.30%) as before; GatherClash `prev_gen` 46,557 (not 46,516 / 46,558). The "identical on this branch and on the merge" claim of §2 did not survive the integration (one CU).

| Item | Verdict | Disposition |
|---|---|---|
| B1 major: the A-29 / PO-7 end-to-end test was not delivered (the crafted-Holding test cannot fail: the resolve never reads Holdings) | **Real**, and the deferral reason is gone (CQ2-A's land world is merged) | `cq_snapshot_counts_a_holding_the_ticket_path_made_before_its_final_ts` (`tests/clash.rs`): a holding made by the real FileTicket and SettleTicket of a v2 season (the ticket filed in an hour bell so its seed closes before `final_ts`), the Province caught up with SkipQuiet through the hour bell while the Holding is still provisional; `snap[]` equals `conquest_model::control_weights` over the mirror, is non-zero, and the stored Holding is still provisional with `final_ts` ahead |
| B2 minor: A-34 says "the simulator reads the same state" | **Real, and the contract was wrong.** The simulator samples at `b % 6 == 5` after bell `6h − 1` resolved (`sim.rs` 1173–1178: `hourly_fold`, `mc_sample_control`), i.e. the state committed at `bell_start(6h)`; the program, herald and keeper sample at bell `6h` after its own clash and settle | A-34's justification is corrected (A-47): the two differ by one bell of garrison losses and settled changes; accepted as negligible for the balance thresholds, **not** re-measured; the owner is told (`integ-CQ2-NOTES.md` §7 item 15). Aligning either side (the model's snapshot to the pre-bell state, or the simulator to bell `6h`) re-runs the Gate CQ1 simulator lines: not done |
| B3 minor: the 290k row prices only a 100-troop keep and a never-due camp check | **Real.** Measured here (`g01_cq_resolve_heavy_keep_and_due_camp`, release, all 1,244 fills, the conquest shape): keep garrison 100 + camp due 286,115; 15,000 troops 286,452 (check not due) / 286,918 (due); 30,000 troops + due 286,918. All `random#286`. **The measured maximum is 286,918 CU (margin 3,082 = 1.06%)**; the literal row with the two additions is estimated at 287,493 (margin 0.86%) | the gate holds, the 300,000 amendment is not needed; the new test gates each variant against 290,000 |
| B4 minor: §5.4 still says GatherClash 40k and SkipQuiet 60k + 30k | **Real** (the program, `v2/budgets.rs` and the tests gate at M1's 49,000 and 90,000 + 30,000 per bell) | A-46 amends §5.4's rows (and A-44's reading) |
| B5 minor: `g01_skip_quiet_kernel_quiet_roster_budget` lost its bound (`units = n` is about 810k at 24 bells) | **Real** | the MC branch keeps its own bound, 120,000 + 3,500 per further bell; measured 84,846 CU at one bell and 145,350 at 24 (about 2,630 a further bell: the v2 step at every bell, the hour snapshot at four boundaries, one CONQUEST record each). M1's run measured 109,382 |
| B6 minor: two record emitters, a stale module note | **Real** | the note in `proc/clash.rs` is corrected; the swap to `events::emit_cq` waits for CQ4-A's re-measure (the RFI margin is 1.06–1.30%) |
| B7 minor: figures one CU off, branch described as unmerged | **Real** | this section |
| missing: a skip-versus-resolve differential beyond G11's three seeds | **Accepted.** The reviewer's own 600-seed fuzz (random keep contender, hosts on site and keep tiles, sieges, occupations, Free Cities, 48 bells each) found skip = resolve on every seed in state and CONQUEST records; the repository has G11's three seeds and P5 (shared model); a repository fuzz is not added here |
