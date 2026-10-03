# Integration W2 (MC "Contested Ground"): merges, Wave-2 review items, Gate CQ2

- **Date:** 2026-10-03. **Role:** MC integrator, wave 2 (CONQUEST-CONTRACT v1.3 → **v1.4**, §20 A-30…A-45; DECISIONS part CQ-J).
- **Branch:** `frontier/cq-integ` (worktree `.claude/worktrees/cq-integ`), base `3751173` (Gate CQ1 green, contract v1.3). Local commits only; nothing pushed; **`codex/frontier` not fast-forwarded** (its merge-base with this branch is `5ed36fa`).
- **Units merged** (`--no-ff`, §11 order; each unit worktree was clean at its tip): CQ2-A `8b8223a` → `d655fc0`, CQ2-B `935b619` → `a7d7e0f`, CQ2-C `6efa621` → `4aa4e91`, CQ2-D `ba5c3d2` → `f83d1b9`, CQ2-E `3674c88` → `06c4ad9`, CQ2-F `592019a` → `12d0f2a`. Every merge was textually clean (ort): CQ2-A's stub commit and the stand-in stubs of CQ2-B and CQ2-C resolved to CQ2-A's, as the contract says; the manifests and `frontier-node/Cargo.lock` came in with CQ2-F (the `agents` and `bots` manifests gain `frontier-abi`, no new external crate).
- **Hashes:** M1 `RULESET_HASH` `72c6b583…4bd9` unchanged; `RULESET_HASH_V2` `b6dd0f3f260d9ef3e9a71c5010b56c42693578f4d8c394623d56deb9fed98274` (the v2 program embeds it and refuses any other Season; `cq_an_m1_season_is_refused`). Release `.so`: **1,132,312 B**, sha256 `d121461c21a4e4e7c937a59320f0939c3716b8ee1315ae70fbd76708e7cca6ca` (both `--twice` builds), program hash `e7fb05dd…7e7f`, e_flags 2, `max_len` 1,417,216 (M1: 875,824 B).
- **Machine / logs:** 16 cores; the AI-citizens work does not start until 10-07, so the whole machine was used (load 40–150 from the simulator lines). Logs: `(session scratch)/scratchpad/cqw2/integ/logs/<id>.log`, `<id>.rc` = exit code, wall seconds, command; queues `qS.sh` (simulator), `qX.sh` (program), `qN.sh`, `qN2.sh` (node, gateway). No port bound (tests use 127.0.0.1:0), no install, no download (`npm test` over the existing `node_modules`), no chain transaction, no network.

## 1. The merge and the integration-window commits

| Commit | What |
|---|---|
| `d655fc0` … `12d0f2a` | the six merges (above) |
| `1431c32` | **A-30** one capture lock: `frontier_abi::v2::prologue::capture_locked(province, site, holding_gen)` loses its `capture_flags` argument and tests `mirror.state == 1 ∧ mirror.gen == holding.gen + 1`; `proc/holding.rs` and CQ2-C's `proc/conquest.rs::capture_lock` both call it; the registry's `EXPLORE` row gains CQ2-A's capture-lock test (CQ2-A R8) |
| `38bb485` | **A-31** FileOutpost 28,000 CU, **A-32** FoldMarch 36,000 CU, **A-33** the v2 `L(kind)` placeholder re-rounded to the measured `.so` (1 MiB → 1,179,648 B); `vectors/v2/budgets.json` regenerated; `g01_loaded_limit_table_covers_the_release_so` reads the v2 table (CQ2-A R2), `season_records` compares `RULESET_HASH_V2` (R3); `g01_cq_fold_worst` gates the table and the ignored 20,000 test is removed; the keeper test's literal `L(kind)` derives from the table |
| `ca9d0ed` | CQ2-B's dead M1 `clash::settle_return` deleted (CQ2-C R-C4); `RETURN_SLOT` / `RETURN_MAX` kept |
| `35bc10e` | `scripts/cq-regen.sh` runs herald `cq_json_vectors_fresh` (CQ2-E R-7) |
| `dfef588` | clippy: the placeholder bound is a const assertion |
| `cc44c10` | fclient's v2 instruction table follows A-31 / A-32 (the keeper requests its CU limit from the v2 budgets table; `instructions_are_frontier_abis` caught rows still at 24,000 and 20,000) |
| `c358ceb` | `svm-tests` clippy-clean (CQ2-C's `tests/conquest.rs`) |
| (docs) | contract v1.4 (§20), DECISIONS CQ-J, this file |

## 2. What the six units delivered (as merged)

Each unit's own notes carry the detail (`CQ2-A-NOTES.md` … `CQ2-F-NOTES.md`); the figures below were re-measured on the merged tree (§5).

- **CQ2-A (program core, land):** the v2 program (`RULESET_HASH_V2`, Province 4,736 B), CreateSeason v2, OpenRing / OpenProvince with keeps on `keep_tile_symmetric` and genesis Free Cities, FoldOccupancy, FileOutpost, SettleTicket into slots 2–3, ReleaseDormant with S3, the capture lock and `[province]` on Harvest, Build, Train, Explore, `train_v2`.
- **CQ2-B (program, clash):** the conquest step inside ResolveFromInputs and SkipQuiet, keep and Free City garrisons, snapshots, CONQUEST log, digests v2, GatherClash `prev_gen`, `g01_cq_` RFI worst over all 1,244 fills, `g11_cq_`.
- **CQ2-C (program, conquest):** DeclareSiege, SettleSiege, SettleCapture, FoldMarch, RetireHost, CloseMarch, the `prev_gen` / `prev_home` transit path, the capture lock on the host instructions, P1–P13.
- **CQ2-D (keeper, fclient):** v2 builders and readers, the contested-bell planner, settles, folds, horn watcher, season-end flush, status and metrics.
- **CQ2-E (herald):** kinds 80–89, the control layer `PSFCT1`, sieges, standings, Call, final.json, `--fixture conquest`, v1/v2 dispatch.
- **CQ2-F (bots):** `agents::campaign`, the conquest layer (`--conquest`), personas, the report additions.

## 3. Cross-unit review items and how each was closed

Every "cross-unit", "deferred" and "owner" item of the first-run reviews and of the six unit reports. **Closed** = changed or ratified here with a test or a gate line; **owner** = a player-visible rule, an owner default or an ABI change beyond the contract (§7, not decided); **later** = belongs to a later unit, with a named owner.

| Item | Disposition |
|---|---|
| CQ2-A / CQ2-C capture lock split (D-14, D-7, R-C2) | **Closed (A-30).** One helper in `frontier-abi`; `capture_flags` is not part of the rule. The test of CQ2-A's re-captured case (flag 1, mirror one generation ahead → `CapturePending`) and CQ2-C's P3 both pass on it; V17's wording and §5.6/§5.8 amended |
| FileOutpost 26,458 vs 24,000 (CQ2-A R4) | **Closed (A-31)** 28,000; merged tree measures 26,449 CU |
| FoldMarch 33,903 vs 20,000 (CQ2-C R-C3) | **Closed (A-32)** 36,000; merged tree measures 33,903 CU (Trace build 34,999, also inside). The count-cap alternative is a keeper-cost choice and triples the keeper's calls to catch a March up; the owner is told (§7, item 9) |
| `g01_loaded_limit_table_covers_the_release_so`, `season_records` (CQ2-A R2, R3) | **Closed (A-33)** both fixed; the v2 placeholder `.so` length moves with the measurement (the §5.4 estimate was 0.98–1.02 MB, the merged `.so` is 1.13 MB) |
| CQ2-B snapshot timing wording (D-3, R6) | **Closed (A-34)** §3.10 and §3.14 |
| CQ2-B / CQ2-C `emit_cq` (R5): three emitters after the merge | **Later (CQ4-A).** The bytes are identical (`cq_records_are_the_abis`), but the swap changes the measured code path of the tightest budget (RFI worst 286,224 against 290,000, margin 1.30%), so it is done with a re-measure in CQ4-A, not in this window |
| CQ2-B A-29 end-to-end test (a provisional holding's weight in `snap[]` before `final_ts`, through FileOutpost / SettleTicket) | **Later (CQ3-E).** CQ2-B's crafted-Holding test is a structural pin; the end-to-end form needs a keeper-driven world, which CQ3-E's `inproc_cq_day` / `g14_cq_` build. Not a gate line of CQ2 |
| CQ2-C dead `settle_return` (R-C4) | **Closed.** Deleted |
| CQ2-C D-4, D-12 (Free City capture: stake, funding) | **Closed (A-36)**, stated to the owner (§7, item 8): the simulator returns the stake on every capture |
| CQ2-C D-5, D-8, D-9, D-13; CQ2-D D-1…D-3 (placeholders, `prev_home`, lapse guard, RetireHost prologue) | **Closed (A-35)**; CQ2-D's builders were checked against CQ2-C's source (account counts, absent placeholders); an in-process keeper test over the program is Gate CQ3 (`keeper --test play`) |
| CQ2-E header bell vs step bell (blocker 1) | **Closed (A-37).** `proc/clash.rs` writes the landing bell in the header and `(P, Q, step bell)` in the key; the herald reads the key (test `cq_conquest_step_bell_is_the_key_bell`); verified by reading the program's `emit_conquest` |
| CQ2-E R-1, R-8, R-10; CF-9…CF-19 | **Closed (A-41)** except CF-16 (owner) |
| CQ2-E R-7 (`cq_json_vectors_fresh` in cq-regen) | **Closed.** |
| CQ2-E R-9 (field equality `control::movement` ↔ `mapmove`) | **Later (CQ3-B).** Needs `frontier-sim` as a herald dev-dependency or the helpers moved into `permutation-rules` |
| CQ2-F D-4 (`siege_seat` code) | **Closed (A-38)** `NotBesiegeable` |
| CQ2-F D-2 (`cqtx.rs` → fclient builders), personas against the merged program | **Later (CQ3-E)** (A-42); `cq_tx_shapes_follow_the_v2_tables` pins the shapes meanwhile |
| CQ2-A R5, R6 (settler cost, `OUTPOST_SETTLED.anchor_key`) | **Owner** (§7, item 3) |
| CQ2-A Q-1, Q-2; D-4 (a captured holding cannot anchor; slot 3 accepts a provisional slot 2) | **Owner** (§7, items 1, 2) |
| CQ2-A D-3 (Free City not counted in `n_sites_used`) | **Owner** (§7, item 4) |
| CQ2-C D-2 (declare from a shielded home) | **Owner** (§7, item 5) |
| CQ2-C R-C1 (capture lock across Provinces) | **Owner** (§7, item 6): an ABI change; one test is ignored and listed in `PENDING` |
| CQ2-C R-C6, R-C7, K-27 wording (prev-gen tip, finality flip of a source in `nearby`, released `prev_home`) | **Owner** (§7, items 7, 10, 11) |
| CQ2-E CF-16 (Warden of the Marches counts attackers' keep bells) | **Owner** (§7, item 12) |

## 4. Amendments (contract §20) in one line each

A-30 one capture lock · A-31 FileOutpost 28,000 · A-32 FoldMarch 36,000 · A-33 v2 `L(kind)` placeholder at the measured `.so` · A-34 snapshot reads the garrison the bell leaves · A-35 placeholders, `prev_home`, SettleSiege lapse guard, RetireHost prologue · A-36 a Free City capture returns the stake · A-37 header bell = landing bell, event bell in the key · A-38 `siege_seat` = `NotBesiegeable` · A-39 `BadParams` struck · A-40 CQ2-A's pinned FileOutpost behaviour · A-41 CF-9…CF-19 ratified (CF-16 and CF-14's timing aside) · A-42 bots' `cqtx.rs` replaced in CQ3-E · A-43 dependency requests applied · A-44 Gate CQ2 read against §5.4 as amended · A-45 reported figures.

## 5. Gate CQ2, line by line

Run from `$R` = this worktree on `frontier/cq-integ`, `PATH` with the Solana tools, `CARGO_BUILD_JOBS=6`, `cargo --offline --locked`. Code lines ran on the final code tree (the last program or ABI change is `c358ceb`; later commits are documents). Ids are log names under `cqw2/integ/logs/`. "Exit" is the command's exit code.

**Preamble** (`CQ_PORTS` empty: no port bound)

| Line | Exit | Result |
|---|---|---|
| `scripts/cq-ownership-check.sh <every frontier/cq-* except cq-integ>` (`P01`) | 0 | PASS; 16 footprint warnings, report-only (A-2): `permutation-frontier/src/lib.rs` (CQ2-A's first commit), `herald/src/views.rs` (CQ2-E), the docs and `permutation-rules/src/frontier/mod.rs` of the close units |
| `git diff --quiet $(git merge-base HEAD codex/frontier) -- permutation-server/web/session.mjs permutation-chain/src` | 0 | merge-base `5ed36fa` |
| `scripts/cq-regen.sh --check` (`R01`, again `G03` on the final tree) | 0, 0 | every generated output fresh with the v2 outputs (57 s, 40 s) |
| `scripts/cq-regen.sh --v1-unchanged 5ed36fa` / `39ff369` | 1, 1 | as at the Wave-1 close, **only the v1 WASM artefact and its `.sha256` differ** (205,623 → 205,686 B; A-13 accepts them: `wasm-vectors.json` byte-identical, `web-frontier-wasm.test.mjs` replays every recorded answer in `npm test`, green); against `39ff369` also the header comment of `web/sdk/codec.mjs` (the Wylls rename, A-27). Every other v1 output byte-identical |

**Gate CQ1 lines (everything except the overnight ones)**

| # | Line | Exit | Result |
|---|---|---|---|
| 1 | `cargo fmt --all -- --check` and `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` (`F01`) | 0 | clean |
| 2 | `cargo test --locked --release -p permutation-rules` (`N02`) | 0 | **470** passed |
| 3 | `cargo test --locked -p frontier-abi` and `abi-vectors --check` (`F01`, `N03`) | 0 | **107** passed; vectors fresh (only `v2/budgets.json` changed: A-31, A-32, A-33) |
| 4 | `cargo test --locked -p permutation-chain` (`N04`) | 0 | **157** passed |
| 5 | `(cd frontier-sim && fmt && clippy --release --all-targets -- -D warnings && cargo test --locked --release)` (`S01`) | 0 | **61** passed (485 s) |
| 6 | M1 `criterion --best-response --seeds 3 --first-seed 30001 --gate` (`S02`) | 0 | worst cell **0.985170**, unchanged |
| 7 | M1 `doctrine-gate --controls` (`S03`) | 0 | the M1 table unchanged (|Δ| 0.060%); the three controls rejected |
| 8 | MC `criterion --best-response … --rules mc --policy campaign --gate` (`S04`) | 0 | worst cell **0.989299** ≤ 0.995 (CQH2); MC − M1 +0.004129 reported |
| 9 | `doctrine-gate --set kernel --rules mc --controls` (`S05`) | 0 | max |Δ index| **0.106%** (gate ≤ 0.2%); the three controls rejected (largest |Δ index| draft 7.339%, Knight 1.935%, A boost 0.502%; 1,165 s) |
| 10 | `mapmove … --check thresholds/mc-7d-1k.json` (`S06`) | 0 | "no drift"; p10 10a 98.4 against floor 45 |
| 11 | `mapmove-gate … --controls` (`S07`) | 0 | rules mc PASS, every row 5/5 seeds; **both controls FAIL as they must** (`m1 lone`, `mc-weightmap`); 10h occupations ½ × p10 19.75 (floor 10), liberations 12.95 (floor 1) |
| 12 | size stress 2:1, human mix and cq (`S08`, `S09`) | 0, 0 | 10/10 and 9/10 seeds ≤ 22% (need 8): PASS |
| 13 | reported rows: `--bot-profile m1`, `--keep-aggr 0.25 / 0.5 / 1.0`, 3:1, `campaign:0,lone:1-5` coordination, `--forward` (`S10`…`S14`) | 0 | coordination (OD-16) 10/10 PASS; 3:1 leader end share p50 0.219; forward leader 0.178; the others as at the close |
| 14 | `doctrine-gate --set kernel --rules mc,bannerdom --controls --report-only` (`S15`) | 0 | report-only: verdict PASS, max |Δ index| 0.111%; draft (−3.101%), Knight (−1.457%), A boost (+0.498%) rejected; 978 s |
| 15 | `(cd frontier-node && fmt && clippy --workspace --all-targets -D warnings && cargo test --locked --workspace)` (`G01`, `N07`, final fmt/clippy `G01`) | 0 | fmt and clippy clean; **529** passed, 0 failed, 11 ignored (528 s, `--no-fail-fast`). The first run (`N07-first`) failed one test, `fclient abi::twin_tests::instructions_are_frontier_abis`: its v2 table still had FileOutpost 24,000 and FoldMarch 20,000; fixed |
| 16 | `(cd permutation-gateway && npm test)` (`N08`; no `npm ci`: the existing `node_modules`) | 0 | 573 ok, 0 not ok |
| 17 | `cargo check --locked -p permutation-frontier` | 0 | |

**Gate CQ2 lines**

| # | Line | Exit | Result |
|---|---|---|---|
| 18 | `cargo clippy --locked -p permutation-frontier --all-targets -- -D warnings` (`G02`) | 0 | clean (the `svm-tests` workspace, not a gate line, is clippy-clean too since `c358ceb`: CQ2-C's `tests/conquest.rs` had 12 warnings) |
| 19 | `cargo test --locked -p permutation-frontier --no-default-features` (`G02`) | 0 | 41 passed |
| 20 | `scripts/build-frontier.sh --twice` (`F02`, also `B01`) | 0 | both builds `d121461c21a4e4e7c937a59320f0939c3716b8ee1315ae70fbd76708e7cca6ca`, 1,132,312 B, program hash `e7fb05dd…7e7f`, e_flags 2, overflow panics present, `deployable yes` |
| 21 | `(cd permutation-frontier/svm-tests && ./run.sh --release -- g01_cq_ g02_cq_ g03_cq_ g11_cq_ g13_cq_ p_cq_)` (`X02`) | 0 | **69 passed, 0 failed, 1 ignored** (`host::p_cq_p3_foreign_province_gap`, R-C1: an owner question, §7 item 6) |
| 22 | `(cd permutation-frontier/svm-tests && ./run.sh --release)` (`X03`, `F04`) | 0 | **337 passed, 0 failed, 5 ignored**: every M1 test is green on v2. The unit trial merges had 334 passed, 3 failed (R2, R3, R4), all closed here |
| 23 | `PSF_TRACE=1 ./run.sh --release -- g01_cq_resolve_worst g01_cq_skip_worst g01_cq_fold g01_cq_declare g01_cq_settle_capture --nocapture` (`X04`) | 0 | 5 tests pass (RFI, SkipQuiet, fold, declare, settle-capture); figures in §6 |
| 24 | `(cd frontier-node && cargo test --locked --release --workspace -- cq_)` (`N06`) | 0 | **104** passed (keeper, herald, bots, agents, fclient, …) |

## 6. Pass conditions of Gate CQ2

| Condition | Result |
|---|---|
| ResolveFromInputs worst ≤ 290,000 CU | **286,224 CU**, margin 3,776 (1.30%): the literal §13.1 row (heaviest conquest-shape clash 280,310 + the 13-unit increment 5,914). Measured maxima over all 1,244 fills: conquest shape 285,649 (random#286), keep as 13th garrison 279,225 (wide#235). Trace-build conquest max 289,829 (checkpoints add ≈ 4k; heap only is gated there). **The 300,000 amendment is not needed.** Identical on the merged tree and on CQ2-B's branch |
| heap ≤ 28 KiB | max **15,416 B** (RFI, trace build); SkipQuiet 13,648; DeclareSiege 1,864; FoldMarch and SettleCapture 2,128 |
| every new kind within §5.4 (as amended) | DeclareSiege 21,783 / 20,152 (scan / O(1)) of 30,000; SettleSiege 12,950 of 25,000; SettleCapture 25,920 (holding) / 19,032 (Free City) of 30,000; **FileOutpost 26,449 of 28,000** (A-31); **FoldMarch 33,903 of 36,000** (A-32; trace 34,999); RetireHost 8,313 of 17,000; CloseMarch 5,497 of 8,000 (tx 318 B above §5.4's 300: the ceiling is raised to the estimate, CQ1-C D-11); SettleTransit with `prev_home` 60,346 of 85,000; GatherClash `prev_gen` 46,557 of 49,000; SettleTicket (outpost, 3 Provinces) 24,771 of 40,000; OpenProvince worst 152,326 of 220,000; Harvest 16,984 of 19,000; SkipQuiet 12 occupations + keep, 22 bells, 266,638 (gate 827,000), 11 + keep, 24 bells, 282,411 (gate 894,000). Tx sizes and loaded-data limits asserted in the same tests. The loaded-data need of every v2 kind is below `L(kind)` of the re-rounded table (`g01_loaded_limit_table_covers_the_release_so`) |
| P1–P13 green, P9 failing-first against M1's transit code | all green (`X02`); P3's foreign-Province half is the ignored R-C1 test. **P9 failing-first** is recorded in `CQ2-C-NOTES.md` §6 (with M1's `transit.rs` 5 of 6 `cq_` transit tests fail, `BadAccount`; with CQ2-C's all 6 pass); not re-run here, the `.so` it needs is a variant build |
| `cq-regen.sh --check` green with the v2 generated outputs | exit 0 |
| G11 byte-identical over 4,736 B | `g11_cq_skip_equals_resolve_with_records_and_a_keep` and the M1 G11 tests green; `g01_cq_resolve_forced_completions` (40 fills, max 229,460) |
| keeper, herald and bots `cq_*` green | 104 passed (release), and in the debug workspace run |

Measured, not gated: GatherClash `prev_gen` tx 1,218 B; DeclareSiege tx 487 B and 11 locks; FoldMarch steady state 14,984 CU for one hour, 27,558 for five; first fold with the init 18,116 for one hour. RFI increment by units (completions + keep taken): 1,866–2,012 for none up to 5,914 for 13.

**PENDING rows left** (`cover::*::PENDING`, for CQ4-A's `RELEASE_CHECK=1`): `host::p_cq_p3_foreign_province_gap` (R-C1). The FoldMarch row is closed. Not covered by a test yet (listed by the units): P2(b) across a SettleTicket, P12's walk with ReleaseDormant, SettleTicket and FileOutpost on the real handlers, the A-29 end-to-end test (CQ3-E), the real CreateSeason / OpenProvince / Join in CQ2-C's worlds, and the in-process keeper over the program (`keeper --test play`, Gate CQ3).

## 7. Owner questions (not decided; each keeps the working default stated)

None of these blocks Gate CQ2. Each changes a player-visible rule, an owner default, the ABI beyond what the contract allows, or a display rule, so it is the owner's. "Default in force" is what the merged program does today.

| # | Question | Numbers and exposure | Options | Default in force |
|---|---|---|---|---|
| 1 | **Q-1 (CQ2-A).** May an outpost holding anchor a new outpost ticket when its own Province is not one of the ticket's Provinces? | The capture lock cannot be checked on such an anchor (the instruction cannot read its Province). A victim whose outpost capture has completed (before SettleCapture) can pay one settler cost per ticket from stores the captor should receive | (a) refuse an order-2/3 anchor unless its Province is listed (restricts which anchors a player may use); (b) add `[anchor_province r]` to 0xA3 (an ABI change: `frontier-abi` v2 prologue, fclient, the relay shapes) | allowed; the lock is checked when the Province is listed (tested) |
| 2 | **Q-2 (CQ2-A).** Slot-3 and Town prerequisites on an outpost anchor | The program cannot see slot 2's finality (the Citizen records none) nor the first holding's tier: slot 3 accepts a provisional slot 2 (§3.8 says final); a Frontier-28 citizen with a re-founded Hamlet home can file from an old outpost | (a) require the anchor to be the slot-2 holding (slot 3) and the first holding (Town); (b) record slot-2 finality and the first holding's tier in the ABI | accepted as stated (tier read from the touched anchor, D-15) |
| 3 | **R5 / R6 (CQ2-A).** The settler cost (`duplicate_cost(SETTLER_COST, n − 1)`) is paid at filing and never refunded; `OUTPOST_SETTLED.anchor_key` is logged as 0 | §3.8 says "refunded if the ticket expires or is displaced"; the simulator charges only a settled outpost, so this is an economic divergence the 7-day floors were not measured with | (a) amend §3.8 / §5.5 to "paid at filing, not refunded" and re-check the simulator (charge at filing) and V22; (b) change the ABI: record the anchor at filing (`Citizen.slots` bits 4–5 or Holding reserve 1,272) and add an optional trailing `[anchor_holding w]` on SettleTicket for an unfounded or displaced ticket, and log the anchor key | paid at filing, not refunded |
| 4 | **D-3 (CQ2-A).** Is a genesis Free City an occupied site? | The simulator counts it as used (`take_site` at genesis); the program keeps it in the fund's `open_sites` and out of what the fold counts as occupied, so the land gate and OpenRing's fill trigger see about **1 site in 12 more free land from ring 4** than the simulator | (a) align the program with the simulator (recommended: the gates were measured on it): count the Free City at OpenProvince; SettleCapture of a Free City must then add no second count, and ReleaseDormant already subtracts one; (b) align the simulator and re-derive both thresholds files (every Gate CQ1 simulator line re-runs); (c) keep both and write §3.7 as "a Free City is free land that cannot be ticketed" | the program's behaviour (not occupied) |
| 5 | **D-2 (CQ2-C).** DeclareSiege checks the shield of the **source Holding** whose host sounds the horn, not of the declarer's first holding (§3.4 step 8, the simulator) | A player whose home is shielded can declare from an unshielded outpost. An outpost needs a final first holding at Town or better, so the window is whatever of the first holding's shield remains after that | (a) require the first holding as the source (changes where a player may declare from); (b) add the first holding as an account (an ABI change); (c) accept and amend §3.4 to "the source holding" | the source Holding |
| 6 | **R-C1 (CQ2-C).** The capture lock cannot see a Holding's own Province when an instruction names another | Between a completion and SettleCapture, a return settle or SettleDeparture of the victim's Leave in a *foreign* Province credits the troops into the captured Holding (its generation still matches) and SettleCapture then zeroes the reserve; if SettleCapture runs first the entry waits and the victim retires it home: the outcome depends on settle order, against §3.6 ("never into the captured Holding") and "settles choose nothing". In the same window DeclareSiege lets a victim pay a 500-Gold stake out of its capture-locked Holding. `host::p_cq_p3_foreign_province_gap` reproduces it (ignored, in `PENDING`) | (a) an optional trailing `[holding_province r]` on the return settle and SettleDeparture, mandatory when the Holding's Province differs from the named one, and DeclareSiege's `nearby` must be the source's Province when the source is not in the target Province (an ABI change in `frontier-abi` v2 prologue, `fclient`, the relay); (b) accept and document | the gap stands (documented, tested, ignored) |
| 7 | **R-C6 (CQ2-C).** The previous-generation `BounceUnranked` tip | Paid to the captured Holding's current rent payer (the captor's funder); only the bond is refunded to the victim (P8). The contract is silent | refund the tip to the victim's recorded funder, or keep | to the captor's funder |
| 8 | **A-36 (ratified; tell me if not).** A Free City capture returns the 500-Gold stake to the source Holding | the contract was silent for the success case ("a Free City's stake is always burned" is the failure case); the simulator returns it on every capture (`sim_mc.rs mc_stake_back`) | burn it instead (changes the simulator and the bot economy) | returned |
| 9 | **A-32 (FoldMarch budget; informed).** 36,000 CU instead of 20,000 | a fold of seven members is 14,984 CU for one hour in steady state and 33,903 CU for six hours with the first fold's init; the per-hour `MARCH_FOLD` record (≈ 3.2k) is normative | cap the count at 1 for the first fold and 2 afterwards and keep 20,000 (triples a keeper's calls to catch a March up) | 36,000 |
| 10 | **K-27 wording (CQ2-C).** A returning previous-generation host whose `prev_home` was released after the capture | RetireHost refuses it (`BadAccount`) and DisbandStranded refuses it (K-27), so the entry waits until the Province closes | after `end_bell` let RetireHost or DisbandStranded strand it (changes K-27's wording) | waits |
| 11 | **R-C7 (CQ2-C).** DeclareSiege's lazy finality flip runs only when the source is in the target Province (`nearby` is read-only) | otherwise the source is refused `NotFinal` until a Muster or Garrison in its own Province flips it | make `nearby` writable (an ABI change) or accept | accepted |
| 12 | **CF-16 (CQ2-E, display).** The keep-bells counter behind Warden of the Marches counts the bells a host of the *counting contender* (the attacker) stood on the keep tile | §3.2's "a keep its faction held while a contender counted" cannot happen when a defender is present, so the title goes to keep attackers, not defenders | count defenders' bells on a held keep instead, or both | attackers |

Also for the owner's information: CQ2-E touched `frontier-node/crates/herald/src/views.rs`, a path the design chat's `frontier/ui-shell` also touched (report-only footprint, A-2); the merge of `codex/frontier` into `frontier/cq-integ` will need a look there.

## 8. Reproduce

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"; R=.claude/worktrees/cq-integ; cd $R
scripts/build-frontier.sh --twice
(cd permutation-frontier/svm-tests && ./run.sh --release -- g01_cq_ g02_cq_ g03_cq_ g11_cq_ g13_cq_ p_cq_ && PSF_SKIP_BUILD=1 ./run.sh --release --no-fail-fast)
(cd permutation-frontier/svm-tests && PSF_SKIP_BUILD=1 PSF_TRACE=1 ./run.sh --release -- g01_cq_resolve_worst g01_cq_skip_worst g01_cq_fold g01_cq_declare g01_cq_settle_capture --nocapture)
(cd frontier-node && cargo test --locked --release --workspace -- cq_ && cargo test --locked --workspace)
scripts/cq-regen.sh --check
```

Wave 3 starts from this commit's gate commit (`frontier/cq-integ`), after the owner has answered §7 items 1–6 (they change account lists or program behaviour that CQ3-C, CQ3-D and CQ3-E code against) or said to keep the defaults.
