# Integration W1 (MC "Contested Ground"): merges, Gate CQ1, measurements

- **Date:** 2026-10-01. **Role:** MC integrator, wave 1 (CONQUEST-CONTRACT v1.1 §4.2, §11, §12).
- **Branch:** `frontier/cq-integ` (worktree `.claude/worktrees/cq-integ`). Local commits only; nothing pushed; **`codex/frontier` not fast-forwarded by MC**. It gained one unrelated commit from another session at 20:15 JST (`1304685`, the Gemma spike report: two files under `docs/frontier/ai-agents/gemma4/`); `39ff369` is its parent. It was not merged into `frontier/cq-integ` in this window (no MC file is affected).
- **CQ0 = `39ff369`** (codex/frontier with the contract, the owner summary and the area designs). The contract's gate preamble writes `CQ0=d11d058`; `39ff369` was used everywhere instead. `codex/frontier` had not moved since `39ff369` when the wave started, so no merge of it was needed.
- **Owner decisions:** OD-1…OD-16 are the contract's **working defaults** (§15, SUMMARY.ja.md §6: 1–12 yes, 13–15 no, 16 = stop and ask), recorded as such in DECISIONS part CQ by CQ1-D. Nothing here is an owner approval.
- **Hashes:** M1 `RULESET_HASH` = `72c6b5835ded6418ed98b0c00b2ae45ce4c4b082d9614447dbce2c9d2e654bd9` (**unchanged**). **`RULESET_HASH_V2` = `1607f62ffb0201f113c4c3d8ea35ffd0c9c88c9c8e48b33f0daa567075452a5a`**, pinned once in `frontier_abi::v2::presets::RULESET_HASH_V2` and in CQ1-A's `cq_m1_ruleset_hash_unchanged_and_v2_pinned` (both green).
- **Logs** of every command below: `(session scratch)/scratchpad/cqinteg/logs/` (`<id>.log`, `<id>.rc` = exit code, wall seconds, command).
- **Machine:** 16 cores, shared with the Gemma spike (llama-server on 41900–41901) and a design-chat browser; load average 9–190 during the runs (wall times in the logs are inflated accordingly). No port was bound (in-process tests use 127.0.0.1:0). No install, no download (node_modules is an APFS clone of m1-integ's, same lockfile, as CQ1-D and the M1 close did). No chain transaction.

## 1. Merges (§11 order) and integration-window commits

| Commit | What |
|---|---|
| `f0d15b2` | merge CQ1-A rules-conquest (`e17e8f5`). Same merge regenerates the WASM artefact (see §2) |
| `0506732` | `scripts/cq-regen.sh`, the integrator's generator run (§4.1, §4.2) |
| `eabe86a` | merge CQ1-C abi-v2 (`45c06f1`) |
| `cd2a61f` | **R1**: `frontier-abi/src/v2/kernel.rs` switched from CQ1-C's stand-ins to the CQ1-A kernels; stand-in bodies deleted; `conquest_model` uses `SiegeV3`; `RULESET_HASH_V2` pinned; v2 presets vector and WASM regenerated |
| `7b475d2` | merge CQ1-B sim-conquest (`136f972`). CQ1-B request 1: the build shim `88cd5eb` is dropped by resolving `permutation-rules/src/frontier/clash.rs` to CQ1-A's text (same `MAX_GARRISONS_WITH_KEEP = 13`, same `MAX_UNITS`) |
| `9c9974d` | **CQ1-B request 2**: `frontier-sim --rules mc` on the real kernels (the `cqk` mirror replaced by re-exports and thin unit adapters), new test `cq_lasting_changes_equal_the_control_kernel` |
| `8caedf2` | merge CQ1-D formats-docs (`0b9a75e`); request D-1 accepted (`pub mod cqfmt;` in an `// MC hook` … `// MC hook end` block of `herald/src/lib.rs`) |
| `40ae53e` | both thresholds files re-derived by their defining commands on the real kernels |
| `69b3d75` | Gate CQ1 frontier-node line: `agents/tests/profile_equality.rs` compiles again against CQ1-B's `config.rs` (it `#[path]`-includes the simulator's files; 16 × E0433 after the CQ1-B merge) |
| (this commit) | these notes |

Dependency requests: **no manifest, lockfile, `package.json`, toolchain or `.gitignore` change was requested or made** by any unit or by the integrator.

### 1.1 What the kernel switches changed (the kernel decides)

- **frontier-abi (R1):** every `cq_*` scenario of `cq_conquest_model` (11) and `cq_v2_contract` (4) stayed green on the real kernels. Only `vectors/v2/presets.json` changed (the hash and its status line). Differences that the stand-ins had and the kernels do not: camp v2 draws among the other tiles instead of skipping the day (CQ1-C D-2); tenure wins over liberation on one bell (CQ1-A deviation 9); the donor loses exactly `garrison × 1,000` milli-troops (CQ1-A deviation 4); `KeepEvent::Paused` is emitted once (M3 only).
- **frontier-sim (request 2):** `Keep.troops` is now whole troops (the clash garrison is `troops × 1,000`, floored back with `keep::troops_after_clash`); capturers and lead-host candidates pass milli-troops; the genesis Free City site uses the kernel's `PSF-FREE-CITY` domain (the mirror hashed `frontier/free-city`, so Free Cities now sit on other sites); `occupation_ends`, `can_complete_before`, `capture_credited`, `held_since_hour_from`, `is_heartland_in`, `controller` and `march_banner` are the kernel's. The holding-weight **negative controls** keep CQ1-B's banner reading (an opened province without a controller counts as open; the keep series always has a holder, where the wrapper equals the kernel exactly). The criterion-10 figures moved by a few percent (§4.1); no verdict changed.

## 2. Generated outputs (`scripts/cq-regen.sh`, §4.2)

`scripts/cq-regen.sh` runs, in order: rules vectors (`PSF_WRITE_VECTORS`), `abi-vectors` (v1 and `v2/`), fclient `frontier-vectors.json`, herald `fixtures/cq/formats` (once `cqfmt.rs` exists), `web/frontier/abi.mjs`, `sync-web-sdk.mjs`, `build-wasm.sh`, `frontier-wasm` vectors. `--check` runs only the freshness checks; `--v1-unchanged REF` diffs every M1 generated output against REF.

| After | `cq-regen.sh` | `--check` | v1 outputs vs CQ0 |
|---|---|---|---|
| CQ1-A merge | rewrote `frontier.wasm` + `.sha256` only | 0 | **WASM bytes differ** (205,623 → 205,684 B), everything else byte-identical |
| R1 (after CQ1-C) | rewrote `v2/presets.json`, `frontier.wasm` + `.sha256` | 0 | WASM bytes differ (205,686 B, sha256 `38df2c14…08f1`), everything else byte-identical |
| CQ1-B, CQ1-D merges, final tree | no change | **0** | as above |

**Deviation from §11's "every v1 generated output byte-identical":** the WASM artefact is the one v1 output whose **bytes** changed. It links the shared clash and camp kernel code (CQ1-A: `MAX_UNITS` 84 → 85 for the 13th garrison, `camp::place` routed through `place_inner`) and `frontier-abi`'s v1 modules (CQ1-C: `Acc::KindV2`, the budgets arm). A build of CQ0 in a scratch worktree reproduces CQ0's committed WASM exactly, and reverting `MAX_UNITS` alone does not restore it, so the change is code layout, not environment. **Its behaviour is unchanged:** `frontier-wasm/vectors/wasm-vectors.json` (one recorded call per export) is byte-identical, and `web-frontier-wasm.test.mjs` replays every recorded answer through the new artefact (6/6). Every other v1 generated output (`abi.mjs`, the SDK, `abi-*.mjs`, `frontier-vectors.json`, `frontier-abi/vectors/*.json`, rules vectors) is byte-identical to CQ0.

## 3. Gate CQ1, line by line

Preamble: ports — none bound (`CQ_PORTS` empty); `git diff --quiet 39ff369 -- permutation-server/web/session.mjs permutation-chain/src` **exit 0** (also against `d11d058`); `scripts/cq-regen.sh --check` **exit 0**; `scripts/cq-ownership-check.sh <every frontier/cq-* except cq-integ>` **PASS** (`--self-test` PASS; the integration branch itself with `--fork 39ff369` also PASS). Re-run at `69b3d75` after the restart (logs `P01b`, `P02`, `P03`): ownership exit 0, protected diff exit 0, `cq-regen.sh --check` exit 0 (451 s).

All lines below ran at `69b3d75` (the HEAD these notes are committed on; the notes commit changes no code). Lines 11 and 19 and overnight O-A were killed by the 18:46 restart and re-run from 18:50 in the background (`nohup`, same log/rc convention); every other line's log is from before the restart at the same HEAD.

| # | Command (as §12 writes it; run from `$R` or `frontier-sim/`) | Exit | Result |
|---|---|---|---|
| 1 | `cargo fmt --all -- --check` | 0 | |
| 2 | `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` | 0 | |
| 3 | `cargo test --locked --release -p permutation-rules` | 0 | 467 passed, 0 failed, 30 binaries; incl. `m1_rules_keep_the_phase_b_digests`, `occupancy_empty_keeps_the_phase_b_digests`, `phase_a_equals_the_reference_on_4320_inputs`, the 28 `cq_*` |
| 4 | `cargo test --locked -p frontier-abi` | 0 | 96 passed (M1 `ruleset_hash_is_the_kernels`, `ruleset_hash_v2_is_the_kernels`, `cq_*`) |
| 5 | `cargo run --locked -p frontier-abi --bin abi-vectors -- --check` | 0 | v1 and v2 files fresh |
| 6 | `cargo test --locked -p permutation-chain` | 0 | 157 passed |
| 7 | `(cd frontier-sim && cargo fmt -- --check && cargo clippy … -D warnings && cargo test --locked --release)` | 0 | fmt and clippy clean; 41 passed, 0 failed (incl. the `cq_*` tests, `cq_lasting_changes_equal_the_control_kernel`, `cq_m1_rules_keep_the_cq0_digest` and the three release-only M1 doctrine tests CQ1-B had to stop); 1,759 s |
| 8 | `criterion --best-response --seeds 3 --first-seed 30001 --gate` (M1) | 0 | worst cell **0.985** (0.985170; 1%, days 1–7, stake, bots in office), as at M1; 356 s |
| 9 | `doctrine-gate --controls` (M1) | 0 | gate passes: largest \|Δ index\| 0.060% (bound ±0.2%), win-rate gap 3.1 points, 4 of 6 win rates in the 60-seed proxy's band (CQ1-B measured the same at CQ0); draft (−1.319% A), Knight (−0.242% F) and A boost (+0.326% A) each rejected as they must be; 2,122 s |
| 10 | `criterion … --rules mc --policy campaign --gate` | 0 | worst cell **0.990** (1%, day 0, stake, bots in office), < 1.0 in every cell; 1,577 s. Because the §12 margin rule sits at the third decimal, both criterion lines were re-run from a scratch copy of HEAD's `frontier-sim` that prints the worst cell with 6 decimals (tables byte-identical to the gate logs): **M1 0.985170, MC 0.990143**, so MC − M1 = **+0.004973 ≤ 0.005** (margin 0.000027) |
| 11 | `doctrine-gate --set kernel --rules mc --controls` | **1** | **FAIL** (re-run after the restart, 1,922 s): A Wardens of Stone **+0.328%**, B Tide **−0.436%**, C Ember **+0.212%**, F Iron **−0.326%** (gate ±0.2%); win rates A 23.6, B 11.9, C 18.9, D 15.0, E 17.8, F 12.8% (**2 of 6** in the band, gap 6.9 points); 360/360 seasons conserve. The controls are not reached (the gate exits on the main failure, as at M1). CQ1-B's mirror gave A +0.313, B −0.406, F −0.304: the real kernels did not change the verdict (§4.8) |
| 12 | `mapmove … --bot-profile cq … --check thresholds/mc-7d-1k.json` | 0 | no drift (after the re-derivation, §4) |
| 13 | `mapmove-gate … --bot-profile cq … --seeds 5 --first-seed 1101 … --controls` | **1** | **MC rules FAIL** (10e 0/5, occupations 1/5, liberations 1/5; every other figure 5/5). **Both negative controls FAIL, as they must** |
| 14 | `mapmove … --bot-profile m1 …` (reported) | 0 | §4.2 |
| 15 | `for k in 0.25 0.5 1.0: mapmove … --keep-aggr $k …` (reported) | 0 | §4.3 |
| 16 | `mapmove … --sizes 3,1,1,1,1,1 …` (reported) | 0 | §4.4 |
| 17 | `mapmove --policy campaign:0,lone:1-5 … --check-leader-max 0.22` (**OD-16**) | 0 | **PASS 10/10** (§4.4) |
| 18 | `mapmove … --forward …` (reported) | 0 | §4.3 |
| 19 | `doctrine-gate --set kernel --rules mc,bannerdom --controls --report-only` | 0 (report-only) | run after the restart (it had never run with `--controls`), 5,224 s. Report verdict **FAIL**: A +0.314, B −0.426, C +0.201, F −0.323% (3/6 in the band, gap 7.2 points). Draft (−2.724% A), Knight (−1.291% A) and A boost (+0.722% A) each rejected as they must be (§4.8) |
| 20 | `(cd frontier-node && cargo fmt --all -- --check && cargo clippy --locked --workspace --all-targets -- -D warnings && cargo test --locked --workspace)` | 0 | after `69b3d75`: 441 passed, 0 failed, 11 ignored (the load-sensitive `herald --test fold checkpoints_save_in_the_background` passed in this run). Before `69b3d75`: clippy exit 101 (agents `profile_equality`, §1) |
| 21 | `(cd permutation-gateway && npm ci --ignore-scripts && npm test)` | 0 (`npm test`) | **546/546**. `npm ci` **not run** (an install; not approved): node_modules is an APFS clone of `m1-integ`'s, whose `package-lock.json` is byte-identical |
| 22 | `cargo check --locked -p permutation-frontier` | 0 | the M1 program compiles against the additive kernels |
| 23 | `scripts/cq-ownership-check.sh $(… 'refs/heads/frontier/cq-1*')` | 0 | PASS (four branches, each from fork `39ff369`); re-run after the restart, exit 0 |
| O-A | overnight `doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --rules mc --policy lone --gate` (1,500 seasons) | **1** | **FAIL, 2 of 6 in the band** (re-run after the restart, 4,834 s): win rates A 19.7, B 11.3, C 20.8, D 18.5, E 18.6, F 11.2% (band 16.7 ± 2; binomial SE 1.0 point); Δ index A +0.277, B −0.399, C +0.256, D +0.080, E +0.142, F −0.355%; 1,500/1,500 seasons conserve |
| O-B | overnight `mapmove-gate --rules mc --policy campaign --agents 10000 --days 28 --seeds 4 --first-seed 1101 --thresholds thresholds/mc-28d-10k.json` | **1** | **FAIL**: banner changes a day 4.86 / 4.93 / 5.07 / 4.93 (1/4 ≥ 5); Marches with ≥ 2 banners 0.148 / 0.154 / 0.157 / 0.170 (3/4 ≥ 0.15; the rule needs 4/4 with 4 seeds); largest 0.170–0.173, smallest 0.160–0.162, days without a change 0.04–0.15 pass 4/4 |

## 4. Map movement (criterion 10) — measured next to the floors

### 4.1 Thresholds file `thresholds/mc-7d-1k.json` (`--bot-profile cq`, 1,000 agents, 99% bots, 7 days, seeds 2002–2011, real kernels)

| Figure | Floor (§13.4, gated) | p10 | p50 | p90 | 2 × floor | p10 ≥ 2 × floor | CQ1-B mirror p10 |
|---|---|---|---|---|---|---|---|
| 10a lasting changes | ≥ 60 | 93.7 | 105 | 118 | 120 | **no** | 97.4 |
| 10b days 2–7 with a change | 6/6 | 6 | 6 | 6 | fixed | – | 6 |
| 10c share of P with ≥ 2 controllers | ≥ 0.15 | 0.289 | 0.311 | 0.357 | 0.30 | **no** | 0.289 |
| 10d banner changes | ≥ 6 | 50 | 59.5 | 74 | 12 | yes | 47.8 |
| 10d Marches with ≥ 2 banners | ≥ 0.10 | 0.241 | 0.282 | 0.349 | 0.20 | yes | 0.244 |
| 10e net movement (bell 287 → end) | ≥ 0.10 | 0.061 | 0.106 | 0.123 | 0.20 | **no** | 0.067 |
| 10f breadth | ≥ 4 | 6 | 6 | 6 | fixed | – | 6 |
| 10g largest / smallest share | ≤ 0.30 / ≥ 0.08 | 0.175 / 0.149 | 0.177 / 0.156 | 0.180 / 0.160 | fixed | – | |
| 10h sieges declared / completed / failed | 20 / 10 / 3 | 125.8 / 77.3 / 38.6 | 134.5 / 92.5 / 45 | | 40 / 20 / 6 | yes | |
| 10h occupations / liberations | 3 / 1 | **0 / 0** | 0 / 0 | 1 / 1 | 6 / 2 | **no** | 0 / 0 |
| 10h captures / outposts | 5 / 10 | 77.3 / 1,674 | 91.5 / 1,698 | | 10 / 20 | yes | |
| 10i D9 transfers | 0 | 0 | 0 | 0 | – | – | 0 |

Per bot-day (p50, cq): Departs **0.140**, keep marches 0.034, keep captures 0.015, DeclareSieges 0.019. Keeps taken 15.0 a day; re-taken within 3 days 2.8%.

Gate seeds 1102–1106 (line 13), p50: lasting 103, 10c 0.333, banner changes 53, Marches 0.282, **10e 0.091 (0.076–0.098)**, occupations 0 (one seed 3), liberations 0 (one seed 3).

### 4.2 The realistic bot profile (`--bot-profile m1`, calibrated to M1's measured ≈ 0.24 Departs per bot-day), beside cq

| Profile (99% bots, 7 days) | Departs / bot-day | lasting p10 / p50 | 10c p50 | banner p50 | Marches ≥ 2 p50 | 10e p10 / p50 | occupations p50 | gate seeds 1102–1106 |
|---|---|---|---|---|---|---|---|---|
| **cq** (thresholds) | 0.140 | 93.7 / 105 | 0.311 | 59.5 | 0.282 | 0.061 / 0.106 | 0 | FAIL: 10e 0/5, occupations 1/5, liberations 1/5 |
| **m1** (M1 cadence) | **0.253** | 128.5 / 138.5 | 0.450 | 57 | 0.282 | 0.276 / 0.337 | 0 | **FAIL only on occupations 0/5 and liberations 0/5**; every map figure 5/5 (p10 lasting 131.4, 10c 0.380, banners 52.6, 10e 0.283) |

With the realistic cadence **the keeps do move the map**, by ≥ 2 × every map floor at p10 (10a 2.2×, 10c 2.5×, 10d 8.8× / 2.4×, 10e 2.8×). What fails under both profiles is the holding-contest floor for occupations and liberations: the campaign planner almost never besieges a first holding (CQ1-B §4.4).

### 4.3 Keep interest and forward staging (human mix, 1,000 agents, seeds 2002–2011, p50)

| Row | lasting | 10c | banners | 10e | largest share |
|---|---|---|---|---|---|
| `--keep-aggr 0.25` | 37.5 | 0.167 | 6 | 0.076 | 0.182 |
| `--keep-aggr 0.5` | 43 | 0.222 | 9 | 0.075 | 0.182 |
| `--keep-aggr 1.0` | 48 | 0.228 | 12 | 0.099 | 0.182 |
| `--forward` | 33 | 0.150 | 8 | 0.045 | 0.180 |

The human-mix campaign map stays below the 10a floor (60) at every keep interest: humans who only follow a plan do not move the map enough on their own (OD-14 "should keeps score" is the lever the contract names). `--forward` (OD-15) gains nothing.

### 4.4 OD-16 coordination check and the size stress

| Run (1,000 agents, 7 days, seeds 2002–2011) | faction 0 share Q1 → end (p50) | ≤ 22% at the end |
|---|---|---|
| **`campaign:0,lone:1-5 --check-leader-max 0.22`** (Gate CQ1 line, human mix) | 0.130 → **0.076** | **10/10: PASS** |
| the same with cq bots (99%) | 0.191 → 0.202 | 10/10 |
| `--sizes 3,1,1,1,1,1`, campaign, human mix (Gate CQ1 reported line) | 0.179 → **0.221** | **4/10** |
| `--sizes 3,1,1,1,1,1`, campaign, cq bots 99% | 0.194 → **0.224** | **1/10** |
| `--sizes 3,1,1,1,1,1`, lone, human mix | 0.191 → **0.235** | **1/10** |

Coordination does not snowball (the campaign faction shrinks among lone factions). **Size does**: a faction three times the size of the others ends above 22% on most seeds under every policy and rises from Q1. This is the reported 3:1 row, not the gated coordination check, but it crosses the contract's 22% line, so it goes to the owner with OD-16 (CQ1-B's request).

### 4.5 Tuning rows the gate's failure rule names (exploration, `--mc` overrides, gate seeds 1102–1106, cq profile; **not amendments**)

Logs `X-tune-*.log`. p10 here is over the 5 gate seeds (the thresholds file's p10 is over seeds 2002–2011); "2×" is the Gate CQ1 rule p10 ≥ 2 × floor (10a 120, 10c 0.30, 10e 0.20, occupations 6, liberations 2).

| Override (all inside §5.2.5's ranges) | 10a p10 / p50 | 10c p10 / p50 | banners p50 | 10e p10 / p50 | 10e seeds ≥ 0.10 | occupations p50 (seeds ≥ 3) | liberations seeds ≥ 1 |
|---|---|---|---|---|---|---|---|
| none (MC_LOCAL_7D) | 98.4 / 103 | 0.317 / 0.333 | 53 | 0.082 / 0.091 | 0/5 | 0 (1/5) | 1/5 |
| `keep_home_guard=50` | 118 / 126 | 0.353 / 0.371 | 67 | 0.091 / 0.106 | 2/5 | 0 (0/5) | 1/5 |
| `keep_consolidate_bells=144` | 97.6 / 107 | 0.320 / 0.333 | 47 | 0.114 / 0.121 | **5/5** | 0 (0/5) | 1/5 |
| both | 120.4 / 129 | 0.353 / 0.371 | 66 | 0.102 / 0.106 | 5/5 | 1 (0/5) | 3/5 |
| `free_city_min_ring=6` | 107.2 / 124 | 0.416 / 0.444 | 64 | 0.123 / 0.167 | **5/5** | 0 (0/5) | 0/5 |
| all three | **121.4** / 127 | **0.440** / 0.467 | 64 | 0.126 / 0.159 | 5/5 | 0 (0/5) | 1/5 |
| planner `holding_slots=2` (not a rule) | 68.6 / 74 | 0.317 / 0.333 | 34 | 0.059 / 0.068 | 0/5 | 0 (0/5) | 1/5 |
| `occupation_tenure_bells=24` (not in §12's list) | identical to "none" (no first-holding siege completes, so tenure never applies) | | | | 0/5 | 0 (1/5) | 1/5 |
| `heartland_max_ring=2` (not in §12's list; P grows to rings ≥ 3) | 95 / 98 | 0.189 / 0.213 | 56 | 0.056 / 0.100 | 3/5 | 0 (0/5) | 0/5 |

10e can be brought over its floor inside §3.12's levers (consolidation 144 bells, or Free Cities from ring 6), and "all three" also lifts 10a and 10c over 2×, **but no row reaches 2 × the 10e floor (best p10 0.126 < 0.20), and no lever produces occupations**: 10h's occupation (3) and liberation (1) floors fail in every row. The integrator did **not** amend any rule or floor (§6).

### 4.6 10k / 28 days (`thresholds/mc-28d-10k.json`, campaign, 5% sim-profile bots, seeds 2002–2011, real kernels)

| Figure | Floor | p10 | p50 | p90 |
|---|---|---|---|---|
| banner changes a day | ≥ 5 | 4.65 | 5.27 | 5.83 |
| Marches with ≥ 2 banners | ≥ 0.15 | 0.138 | 0.154 | 0.164 |
| largest / smallest share | ≤ 0.22 / ≥ 0.12 | 0.169 / 0.161 | 0.171 / 0.161 | 0.172 / 0.164 |
| days without a banner change | ≤ 0.30 | 0.035 | 0.077 | 0.081 |

Reported p50: keeps taken 18.1 a day, re-taken within 3 days 29%, Departs 1.53 per bot-day (sim profile), homes released 1,453 per season (casual 141). The overnight gate (O-B) sits on these floors and fails by a hair (§3).

### 4.7 Why 10e and the occupations stay low: floor definition, bot policy or rules?

Same gate seeds (1102–1106), 1,000 agents, 7 days, `MC_LOCAL_7D`, the HEAD binary (logs `X-attr-*.log`, `FRONTIER_SIM_DEBUG=1` counters), plus a 10e decomposition from a **scratch copy** of HEAD's `frontier-sim` with a stderr-only diagnostic in `mapmove::metrics` (log `X-diag-10e.log`; the repository is unchanged, the metrics it prints are identical to HEAD's).

**A. The same rules under different players.**

| Population | Policy | 10a p50 | 10c p50 | 10e p50 | first-holding sieges declared / season | occupations p50 (p10) | liberations p50 (p10) | `mapmove-gate` |
|---|---|---|---|---|---|---|---|---|
| 99% bots, `cq` | campaign | 103 | 0.333 | 0.091 | 1–5 | 0 (0) | 0 (0) | FAIL: 10e, occupations, liberations |
| 99% bots, `m1` | campaign + M1-rate lone rolls | 140 | 0.424 | 0.288 | 1–5 | 0 (0) | 0 (0) | FAIL: occupations 0/5, liberations 0/5 |
| human mix (5% sim bots) | campaign | 37 | 0.144 | 0.038 | 0–4 | 0 (0) | 0 (0) | FAIL: 10a, 10c, 10d Marches, 10e, occupations, liberations |
| human mix | **lone** | 288 | 0.978 | 0.394 | **34–44** | **30 (26.6)** | **4 (2)** | **PASS (exit 0)** |
| 99% bots, `cq` | lone | 0 | 0 | 0 | 0 | 0 | 0 | FAIL (`cq` bots act only on a plan: degenerate) |

**B. Where the movement after bell 287 goes** (P₂ = 132 provinces, rings 4–7; rings 8–12 open after bell 288; 432 provinces outside the heartlands at the end).

| Row | P₂ provinces at a different holder at the end (10e numerator) | P₂ provinces with any change after bell 287 | of those, back at their bell-287 holder | keep changes after bell 287: in P₂ / everywhere |
|---|---|---|---|---|
| `cq` | 10–13 | 10–13 | 0 | 10–13 / 61–83 |
| `cq`, `keep_consolidate_bells=144` | 15–17 | 15–18 | 0–1 | 15–19 / 66–86 |
| `cq`, `free_city_min_ring=6` | 15–24 | 15–25 | 0–1 | 15–26 / 64–102 |
| `m1` | 37–45 | 39–45 | 0–3 | 40–45 / 102–113 |

**Reading.**

- **10e is not lost to ping-pong.** Almost no P₂ province that changes after bell 287 ends back at its bell-287 holder. It is low because few P₂ keeps are attacked after day 2 at all: under `cq`, 80–85% of the keep changes after bell 287 happen in rings 8–12, which open after bell 288 and are outside P₂ by definition. The campaign plan picks targets within 2 provinces of the faction's holdings, and those move outward with the outposts, so the contest follows the ring openings and the ring 4–7 keeps rest. Both the **floor definition** (P₂ only, with one province ≈ 0.76 points) and the **bot policy** set the number; the **rules** allow far more (M1-rate lone rolls: 37–45 of 132; the lone human mix: 0.394).
- **Occupations are a bot-policy outcome, not a rules one.** Under the same preset the lone human mix declares 34–44 first-holding sieges a season and occupies 30 homes (p10 26.6, liberations p10 2), and the whole gate passes. The campaign plan almost never plays them: in 104–120 of its 107–124 keep strikes a season (`cq`) there is no legal player holding in the province (homes sit in heartlands, are shielded or Frontier-protected); its single holding slot prefers holdings 2–3 and Free Cities (value 1.5 vs 1.0, small garrisons); and the 1–5 first-holding sieges it does declare fail with the hex left, the lead host on its way home (bots retreat below two thirds of their troops with probability 0.6 under the garrison's retaliation through a 36–60-bell siege). The campaign human mix confirms it is the planner, not bot cadence: 0 occupations. No §3.12 lever changes it (§4.5).
- **So within §3.12's ranges the floors cannot be met at 2× with `--bot-profile cq`**: the best row (all three levers) still has 10e p10 0.126 < 0.20, and occupations and liberations are 0 in every row. The choice is the owner's (§6, PO-1).

### 4.8 The doctrine band on the MC rules

- **CI proxy (line 11, 360 seasons):** FAIL, 2 of 6 in the band; A +0.328%, B −0.436%, C +0.212%, F −0.326% (bound ±0.2%). The deviations sit mostly in the Concord-per-capita column (A 1.0067, B 0.9905, F 0.9916), Dominion within ±0.0022: an economic edge, the cavalry doctrines B and F behind (their hosts pay a horse and ore surcharge per march, and MC makes every faction march far more).
- **CQ1-B's ablations (mirror kernels, same harness; `CQ1-B-NOTES` §5.1)** put most of the edge in the MC holding contest (with `sieges_per_day=0` only B −0.240% remains outside; with keeps frozen at `keep_home_guard=30000` it still fails 1/6). The real kernels did not change the verdict (A +0.313 → +0.328, B −0.406 → −0.436, F −0.304 → −0.326).
- **Overnight 1,500 seasons (O-A):** FAIL, **2 of 6** in the band (A 19.7, B 11.3, C 20.8, F 11.2% out; D 18.5, E 18.6% in). With a 1-point standard error the B and F deficits (≈ 5.5 points) are not noise. The balance lab's keep package (R) had kept 6/6 on 1,500 seasons; the v1.1 holding contest is what it did not model.
- **Integrator ablation (360 seasons, `--rules mc --mc free_city_min_ring=0 --report-only`, log `X-doct-nofc`):** without any genesis Free City the table barely moves (A +0.283, B −0.419, C +0.236, F −0.333%; 3/6 in the band). **Free Cities are not the cause**; with CQ1-B's `sieges_per_day=0` row, the remaining suspects are the sieges themselves (500-Gold stake, captures of holdings 2–3 with stores kept, occupations) and the outposts.
- **OD-14 `bannerdom` (line 19, report-only):** A +0.314, B −0.426, C +0.201, F −0.323% (3/6 in the band): banner-hour Dominion moves each doctrine by ≤ 0.014 points of index. It neither repairs nor further breaks the band, so OD-14 stays a free choice of the owner on other grounds (default off).

## 5. Pass beyond exit codes (Gate CQ1)

| Condition | Status |
|---|---|
| M1 digests identical | **PASS** (`m1_rules_keep_the_phase_b_digests`, `occupancy_empty_keeps_the_phase_b_digests`, the 4,320-input equivalence, frontier-sim `cq_m1_rules_keep_the_cq0_digest`) |
| `mapmove-gate`: MC rules pass on ≥ 4 of 5 seeds | **FAIL** (10e 0/5, occupations 1/5, liberations 1/5) |
| `mapmove-gate`: both negative controls FAIL | **PASS** (m1-lone fails 10a–10f, 10h; mc-weightmap fails 10a, 10b, 10d, 10f, occupations, liberations, 10c 2/5, 10e 3/5) |
| Thresholds p10 ≥ 2 × every floor (`--bot-profile cq`) | **FAIL** for 10a (93.7 < 120), 10c (0.289 < 0.30), 10e (0.061 < 0.20), occupations (0 < 6), liberations (0 < 2) |
| Doctrine band 6/6 | **FAIL**: overnight 1,500 seasons 2/6 (O-A); CI proxy 2/6, exit 1 (line 11) |
| Overnight lines (must pass before Gate CQ2 opens) | **FAIL**: O-A 2/6; O-B 10k/28d banner changes 1/4, Marches 3/4 |
| Best-response worst cell ≤ M1 control + 0.005 | **PASS, at the edge**: 0.990143 ≤ 0.985170 + 0.005 = 0.990170 (margin 0.000027; CQ1-B's mirror gave 0.989). Any later outcome-changing kernel change will likely cross it |
| M1 `RULESET_HASH` unchanged; `RULESET_HASH_V2` pinned once | **PASS** |
| Coordination run: campaign faction ≤ 22% on ≥ 8/10 | **PASS** (10/10, p50 7.6%) |
| `codex/frontier` not fast-forwarded | **PASS** (MC did not move it; it is at `1304685` = `39ff369` + one unrelated docs commit by the AI-agents session) |
| If `mapmove-gate` fails, Wave 2 does not start | **Wave 2 does not start** (§6) |

## 6. PENDING-OWNER (Wave 2 is blocked until the owner decides)

Gate CQ1 is **not green**. Four pass conditions fail, and each needs a choice the contract leaves to the owner (rules or floors amended before CQ2, never after; §3.13, §12). The integrator changed no rule, floor, preset or planner in the integration window: none of the failures is a code defect a minimal commit could fix without changing a rule, a floor or the bot policy.

**PO-1 — `mapmove-gate` 7d/1k fails and p10 ≥ 2 × floors fails (§4.1, §4.5, §4.7).**
- Gate seeds 1102–1106, `cq`: 10e net movement 0/5 seeds (0.076–0.098 vs floor 0.10), occupations 1/5 (floor 3), liberations 1/5 (floor 1); everything else 5/5. Both negative controls fail as they must.
- Thresholds file p10 (`cq`) vs 2 × floor: 10a 93.7 vs 120, 10c 0.289 vs 0.30, 10e 0.061 vs 0.20, occupations 0 vs 6, liberations 0 vs 2 (10d, 10h sieges/captures/outposts clear 2×).
- With M1's measured cadence (`m1` profile, 0.253 Departs per bot-day) every map figure clears 2× at p10 (10a 131, 10c 0.38, 10e 0.283), and only occupations and liberations fail.
- Cause: 10e = the campaign plan follows the ring openings outward, so only 10–13 of 132 P₂ provinces change after bell 287 (floor definition + bot policy); occupations = the campaign plan almost never besieges a home and its bots retreat from the few sieges they start (bot policy). Under the same rules the lone human mix passes the whole gate with 30 occupations.
- Best inside §3.12 (`keep_home_guard` 50, `keep_consolidate_bells` 144, `free_city_min_ring` 6): 10e floor met 5/5, 10a and 10c over 2×, but 10e p10 0.126 < 0.20 and occupations 0.
- Options: (a) **bot policy**: give the campaign planner an occupation objective (a holding slot for first holdings, siege hosts that hold while their siege counts), re-derive the thresholds and re-run the gate, before CQ2-F ports the planner; (b) **amend the floors before CQ2**: 10e measured over every province outside the heartlands open at bell 287 *and later* (or a lower floor such as 5%), occupations and liberations gated on the human-mix row or reported only for a 99%-bot exit, 2× applied to the map figures only; (c) **rules**: adopt some of the §3.12 levers by amendment (fixes the 10e floor and 10a/10c at 2×, not occupations); or a combination, e.g. (a)+(c).

**PO-2 — the doctrine band fails on the MC rules (§4.8).** CI proxy 2/6 in the band (A +0.328%, B −0.436%, C +0.212%, F −0.326%; bound ±0.2%); overnight 1,500 seasons also 2/6 (B 11.3%, F 11.2%, C 20.8%, A 19.7% outside 16.7 ± 2); without Free Cities still 3/6. The edge is economic and mostly from the MC holding contest (CQ1-B's ablations). Options: re-tune the doctrines on the MC simulator (an amendment to the doctrine table, re-running both M1 and MC doctrine lines), or change the holding-contest economics (stake, capture effects, outposts; Free Cities are excluded by the ablation) and re-measure. Not decidable by the integrator.

**PO-3 — the overnight 10k/28-day gate fails by a hair (O-B).** Banner changes a day 4.86–5.07 (1/4 seeds ≥ 5), Marches with ≥ 2 banners 0.148–0.170 (3/4 ≥ 0.15; 4 seeds need 4/4). The defining run's own p10 is below both floors (4.65 < 5, 0.138 < 0.15): the floors are the balance lab's, measured with lone players, and the campaign policy sits on them. Options: amend the two floors (e.g. to the thresholds file's ½ × p10 or a round 4 a day / 12%), or change the planner as in PO-1 (a).

**PO-4 — the 3:1 size stress crosses 22% (§4.4; with OD-16).** The gated coordination check passes 10/10 (campaign faction ends at 7.6% p50), so OD-16 itself does not stop the wave. But a faction three times the others' size ends above 22% on 6/10 seeds (human-mix campaign, p50 22.1%), 9/10 (cq bots, 22.4%) and 9/10 (lone, 23.5%), rising from Q1. §8.7 says the owner is told before Wave 2: size snowballs a little, coordination does not.

**PO-5 — before CQ2-A (not a gate failure):** CQ1-A finding 1, keep tile not wedge-symmetric (§7). Integrator recommendation: adopt `keep_tile_symmetric`; changing it later re-runs Gate CQ1's simulator lines.

**PO-6 — v1 generated output not byte-identical (§2):** the WASM artefact's bytes changed (behaviour identical: recorded vectors byte-identical, 6/6 replays). Accept as a code-layout change, or require CQ1-A/CQ1-C to restore the M1 bytes (likely by moving the shared clash/camp changes behind a separate build of the M1 artefact).

Also recorded for the owner: the best-response margin is 0.000027 under the rule (§5).

## 7. Other findings for later waves

- **CQ1-A finding 1 (keep tile not wedge-symmetric)** is open: `keep::keep_tile` (pinned rule, kept) puts the keep in the same world direction in every province, so wedges differ (5,400 of 6,480 sampled provinces). `keep_tile_symmetric` exists as a proposal. It must be decided before CQ2-A writes OpenProvince; changing it later re-runs Gate CQ1's simulator lines (§3.13). Integrator recommendation: adopt the symmetric rule (DESIGN §3.2 gives all wedges the same land), but it is a player-visible rule, so it is listed for the owner.
- **CQ1-D D-4/D-5:** the `// MC hook end` marker (§4.5) and CF-1…CF-8 (§8.4, CF-5 fixes PSFSD1's 30-B field sum) should be written into the contract before CQ2-E starts; the integrator has not amended the contract in this window. Who extends `cqfmt.rs` in Wave 2 for the unpinned JSON files is open.
- **Design-chat footprint moved:** `frontier/ui-shell` touched `permutation-server/web/lang/en-frontier.mjs`, `web/frontier/flog.mjs`, `intro/title.mjs` and `test/web-frontier-wave4.test.mjs` since CQ0 (the ownership check protects them). `en-frontier.mjs` is in **CQ3-D's ownership list**: a Wave 3 conflict to settle before CQ3-D starts.
- **Campaign defence never breaks a keep contest** in the cq and human-mix campaign runs (`keep_contests_broken` 0 on every seed; lone and m1 runs break 1–2). With the standing-order defence of CQ1-B D-6 the attacker almost always wins (keeps re-taken within 3 days 2.8% at 7 days vs the contract's "about 40%" expectation). Not a gate item; CQ2-F should check its planner's defence before porting.
- **CQ1-C pending items** stay with their owners: OpenProvince keep / Free City placement (CQ2-A), the models in ResolveFromInputs / SkipQuiet and the 290k / 300k decision (CQ2-B), budgets from the MC `.so` (CQ4-A). CQ1-A's note for CQ2-B: the Phase A body's arrays grew by one slot (G1 stack check).

## 8. Reproduce

```sh
cd .claude/worktrees/cq-integ
scripts/cq-regen.sh --check && scripts/cq-regen.sh --v1-unchanged 39ff369   # the second exits 1 on the WASM bytes only (§2)
(cd frontier-sim && cargo run --release -- mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json --controls)
(cd frontier-sim && cargo run --release -- mapmove-gate --rules mc --policy campaign --bot-profile m1 --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json)
(cd frontier-sim && cargo run --release -- mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json --mc keep_consolidate_bells=144)
# §4.7 attribution: the same rules with the lone human mix (passes), and the planner's first-holding counters
(cd frontier-sim && cargo run --release -- mapmove-gate --rules mc --policy lone --agents 1000 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json)
(cd frontier-sim && FRONTIER_SIM_DEBUG=1 cargo run --release -- mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json)
# §4.8 ablation
(cd frontier-sim && cargo run --release -- doctrine-gate --set kernel --rules mc --mc free_city_min_ring=0 --report-only)
```
