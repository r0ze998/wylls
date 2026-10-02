# Integration W1 (MC "Contested Ground"): merges, Gate CQ1, measurements

- **Date:** 2026-10-01. **Role:** MC integrator, wave 1 (CONQUEST-CONTRACT v1.1 → **v1.2** §4.2, §11, §12, §18).
- **Round 3 (Wave-1 close, 2026-10-02; §10):** the owner package (DECISIONS CQ-H) merged with `codex/frontier` `5ed36fa` and the three close units; Gate CQ1 re-run in full under contract **v1.3**, overnight lines included: **green** (§10.2, §10.3). §10.5 sets each headline number of the decision sheet beside the merged code. Sections 1–9 below are rounds 1–2 and are kept as they were.
- **Round 2 (after the review of Wave 1):** every blocker, major and missing item of the review was checked against the code; the real ones are fixed with tests, the owner-level ones escalated (§9). Gate CQ1 was re-run line by line on the fixed tree (§3; logs `(session scratch)/scratchpad/cqinteg/logs2/`). **The gate is still not green** and Wave 2 stays blocked (§5, §6). One pass condition that passed in round 1 now fails by a hair: the best-response margin (0.990229 vs the 0.990170 bound, §5, PO-8).
- **Branch:** `frontier/cq-integ` (worktree `.claude/worktrees/cq-integ`). Local commits only; nothing pushed; **`codex/frontier` not fast-forwarded by MC**. It gained one unrelated commit from another session at 20:15 JST (`1304685`, the Gemma spike report: two files under `docs/frontier/ai-agents/gemma4/`); `39ff369` is its parent. It was not merged into `frontier/cq-integ` in this window (no MC file is affected).
- **CQ0 = `39ff369`** (codex/frontier with the contract, the owner summary and the area designs). The contract's gate preamble writes `CQ0=d11d058`; `39ff369` was used everywhere instead. `codex/frontier` had not moved since `39ff369` when the wave started, so no merge of it was needed.
- **Owner decisions:** OD-1…OD-16 are the contract's **working defaults** (§15, SUMMARY.ja.md §6: 1–12 yes, 13–15 no, 16 = stop and ask), recorded as such in DECISIONS part CQ by CQ1-D. Nothing here is an owner approval.
- **Hashes:** M1 `RULESET_HASH` = `72c6b5835ded6418ed98b0c00b2ae45ce4c4b082d9614447dbce2c9d2e654bd9` (**unchanged**). **`RULESET_HASH_V2` = `1607f62ffb0201f113c4c3d8ea35ffd0c9c88c9c8e48b33f0daa567075452a5a`**, pinned once in `frontier_abi::v2::presets::RULESET_HASH_V2` and in CQ1-A's `cq_m1_ruleset_hash_unchanged_and_v2_pinned` (both green).
- **Logs:** round 1 `(session scratch)/scratchpad/cqinteg/logs/`, round 2 `…/cqinteg/logs2/` (`<id>.log`, `<id>.rc` = exit code, wall seconds, command).
- **Machine:** 16 cores, shared with the Gemma spike (llama-server on 41900–41901) and a design-chat browser; load average 9–210 during the runs (wall times in the logs are inflated accordingly). No port was bound (in-process tests use 127.0.0.1:0). No install, no download (node_modules is an APFS clone of m1-integ's, same lockfile, as CQ1-D and the M1 close did). No chain transaction.

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
| `277fa9c` | these notes, round 1 |
| `5d0858a` | **review fixes, frontier-sim:** `may_besiege_v3`, `keep_tile`, `capture_effects`, `may_found_outpost`, `lowest_free_slot` from the kernels; plan-time `TooLate`; the independent D9 audit; 12 holding-contest tests; `--check` on the bot rates; `--keep-stay` (D-8) |
| `8cc6395` | both thresholds files re-derived by their defining commands on that simulator |
| `7afe92f` | `skip_gate` per active bell (§5.4) |
| `42b22f0` | `conquest_model` shares the kernel vectors (6 tests); occupation stake owed from completion (A-5); Respite `end + respite_bells` (§3.5); Build's Province `Wr::Either`; kernel constants; two model tests; `vectors/v2/{conquest,tags}.json` regenerated |
| `e51fef6` | `cq-ownership-check.sh`: every parent, strict hook markers, footprint report-only (20-case self-test) |
| `2dc382a` | herald `cqfmt` codes from the control kernel; DESIGN §24 criterion 10 = §13.4 |
| `c0d7080` | **contract v1.2** (§18 A-1…A-7), DECISIONS part CQ-F |
| `f8486ce` | CQ1-B-NOTES pointer to these figures, deviation D-8 |
| (this commit) | these notes, round 2 |

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

**Deviation from §11's "every v1 generated output byte-identical":** the WASM artefact is the one v1 output whose **bytes** changed. It links the shared clash and camp kernel code (CQ1-A: `MAX_UNITS` 84 → 85 for the 13th garrison, `camp::place` routed through `place_inner`) and `frontier-abi`'s v1 modules (CQ1-C: `Acc::KindV2`, the budgets arm). A build of CQ0 in a scratch worktree reproduces CQ0's committed WASM exactly, and reverting `MAX_UNITS` alone does not restore it, so the change is code layout, not environment. **Its behaviour is unchanged:** `frontier-wasm/vectors/wasm-vectors.json` (one recorded call per export) is byte-identical, and `web-frontier-wasm.test.mjs` replays every recorded answer through the new artefact (6/6). Every other v1 generated output (`abi.mjs`, the SDK, `abi-*.mjs`, `frontier-vectors.json`, `frontier-abi/vectors/*.json`, rules vectors) is byte-identical to CQ0. **Round 2:** `cq-regen.sh --check` exit 0 at `c0d7080` (237 s; `vectors/v2/{conquest,tags}.json` were regenerated in `42b22f0`, v1 vectors untouched); `--v1-unchanged 39ff369` still differs only in the WASM artefact, whose bytes are the same as after round 1 (205,686 B): the round-2 `frontier-abi` changes did not move it.

## 3. Gate CQ1, line by line (round 2)

Code lines ran at `c0d7080` (root workspace, frontier-node, gateway, scripts; the later commits are docs only) and at `8cc6395` (frontier-sim; no frontier-sim file changed after it). Round 1's result is in brackets where it differs. Preamble: `CQ_PORTS` empty (no port bound); `git diff --quiet 39ff369 -- permutation-server/web/session.mjs permutation-chain/src` **exit 0**; `scripts/cq-regen.sh --check` **exit 0** (237 s); `scripts/cq-ownership-check.sh <every frontier/cq-* except cq-integ>` **exit 0** (four branches, 0 violations; footprint reported, not enforced, per contract v1.2 A-2); `--self-test` **PASS 20/20**.

| # | Command (§12) | Exit | Result |
|---|---|---|---|
| 1 | `cargo fmt --all -- --check` | 0 | |
| 2 | `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` | 0 | |
| 3 | `cargo test --locked --release -p permutation-rules` | 0 | 467 passed (M1 digests, the 4,320-input equivalence, the `cq_*`) |
| 4 | `cargo test --locked -p frontier-abi` | 0 | **104** passed [96]: + `cq_kernel_vectors` (6), two model tests |
| 5 | `abi-vectors -- --check` | 0 | 16 files fresh |
| 6 | `cargo test --locked -p permutation-chain` | 0 | 157 passed |
| 7 | `(cd frontier-sim && fmt && clippy -D warnings && cargo test --locked --release)` | 0 | **52** passed [41]: + 12 holding-contest tests; incl. `cq_m1_rules_keep_the_cq0_digest` and the release-only M1 doctrine tests; 1,210 s |
| 8 | `criterion --best-response … --gate` (M1) | 0 | worst **0.985170** (6-decimal scratch copy of `8cc6395`, table byte-identical to the gate log) |
| 9 | `doctrine-gate --controls` (M1) | 0 | max \|Δ index\| 0.060%, 4/6 in the proxy band; draft (−1.319%), Knight (−0.242%), A boost (+0.326%) rejected — unchanged |
| 10 | `criterion … --rules mc --policy campaign --gate` | 0 | worst **0.990229** (6 decimals, same scratch method) [0.990143]. The line exits 0 (< 1.0), but **MC − M1 = +0.005059 > +0.005: the §12 margin fails by 0.000059** (§5, PO-8) |
| 11 | `doctrine-gate --set kernel --rules mc --controls` | **1** | **FAIL**: A +0.309%, B −0.417%, C +0.227%, F −0.327% (±0.2%); win rates A 22.8, B 11.4, C 18.6, D 14.7, E 18.6, F 13.9% (3 of 6 in the band) [2/6]; 1,857 s |
| 12 | `mapmove … --bot-profile cq … --check thresholds/mc-7d-1k.json` | 0 | no drift (now also the p50 bot rates) |
| 13 | `mapmove-gate … --bot-profile cq … --controls` | **1** | **MC rules FAIL** (10e 0/5, occupations 1/5, liberations 1/5; every other figure 5/5); **both negative controls FAIL, as they must** — unchanged |
| 14 | `mapmove … --bot-profile m1` (reported) | 0 | §4.2 |
| 15 | `--keep-aggr 0.25/0.5/1.0` (reported) | 0 | §4.3 |
| 16 | `--sizes 3,1,1,1,1,1` (reported) | 0 | faction 0 ends p50 22.1%, ≤ 22% on 4/10 seeds (§4.4) |
| 17 | `--policy campaign:0,lone:1-5 --check-leader-max 0.22` (**OD-16**) | 0 | **PASS 10/10** (p50 7.6%) |
| 18 | `--forward` (reported) | 0 | §4.3 |
| 19 | `doctrine-gate --set kernel --rules mc,bannerdom --controls --report-only` | 0 (report-only) | verdict FAIL: A +0.298, B −0.411, C +0.220, F −0.321% (3/6); draft, Knight and A boost rejected; 3,729 s |
| 20 | `(cd frontier-node && fmt && clippy && cargo test --locked --workspace)` | 0 | **442** passed, 0 failed, 11 ignored (545 s, `N02b`). The first run at load ≈ 200 failed only the wall-clock assertion of `herald --test fold checkpoints_save_in_the_background` (1.4 s bound; file unchanged since CQ0), which then passed 3/3 alone and in the full re-run |
| 21 | `(cd permutation-gateway && npm ci --ignore-scripts && npm test)` | 0 (`npm test`) | 546/546; `npm ci` not run (an install), node_modules as in round 1 |
| 22 | `cargo check --locked -p permutation-frontier` | 0 | |
| 23 | `scripts/cq-ownership-check.sh … 'refs/heads/frontier/cq-1*'` | 0 | PASS |
| O-A | overnight `doctrines --agents 10000 --seeds 250 … --rules mc --policy lone --gate` | **1** | **FAIL, 2 of 6**: A 19.7, B 11.5, C 20.9, D 18.2, E 18.5, F 11.1% (Δ index A +0.274, B −0.394, C +0.245, F −0.355%); 1,500/1,500 conserve; 3,964 s |
| O-B | overnight `mapmove-gate … --agents 10000 --days 28 --seeds 4 … mc-28d-10k.json` | **1** | **FAIL**: banner changes a day 4.86 / 4.93 / 5.07 / 4.96 (1/4 ≥ 5); Marches ≥ 2 banners 0.148 / 0.154 / 0.157 / 0.170 (3/4); the other rows 4/4 |

## 4. Map movement (criterion 10) — measured next to the floors

### 4.1 Thresholds file `thresholds/mc-7d-1k.json` (`--bot-profile cq`, 1,000 agents, 99% bots, 7 days, seeds 2002–2011, real kernels)

| Figure | Floor (§13.4, gated) | p10 | p50 | p90 | 2 × floor | p10 ≥ 2 × floor | CQ1-B mirror p10 |
|---|---|---|---|---|---|---|---|
| 10a lasting changes | ≥ 60 | 92.8 [93.7] | 105 | 118 | 120 | **no** | 97.4 |
| 10b days 2–7 with a change | 6/6 | 6 | 6 | 6 | fixed | – | 6 |
| 10c share of P with ≥ 2 controllers | ≥ 0.15 | 0.289 | 0.311 | 0.357 | 0.30 | **no** | 0.289 |
| 10d banner changes | ≥ 6 | 50 | 59.5 | 74 | 12 | yes | 47.8 |
| 10d Marches with ≥ 2 banners | ≥ 0.10 | 0.241 | 0.282 | 0.349 | 0.20 | yes | 0.244 |
| 10e net movement (bell 287 → end) | ≥ 0.10 | 0.061 | 0.106 | 0.123 | 0.20 | **no** | 0.067 |
| 10f breadth | ≥ 4 | 6 | 6 | 6 | fixed | – | 6 |
| 10g largest / smallest share | ≤ 0.30 / ≥ 0.08 | 0.175 / 0.149 | 0.177 / 0.156 | 0.180 / 0.160 | fixed | – | |
| 10h sieges declared / completed / failed | 20 / 10 / 3 | 126 / 77.3 / 39.6 | 137 / 93.5 / 46.5 | | 40 / 20 / 6 | yes | |
| 10h occupations / liberations | 3 / 1 | **0 / 0** | 0 / 0 | 1 / 1 | 6 / 2 | **no** | 0 / 0 |
| 10h captures / outposts | 5 / 10 | 77.3 / 1,672 | 92.5 / 1,697 | | 10 / 20 | yes | |
| 10i D9 transfers (round 2: the independent audit) | 0 | 0 | 0 | 0 | – | – | 0 |

Per bot-day (p50, cq, round 2): Departs **0.158** [0.140], keep marches 0.041 [0.034], keep captures 0.015, DeclareSieges 0.020 [0.019]: once the planner no longer launches strikes that cannot finish, the dropped holding campaigns are replaced by others (more keep marches late in the season). Keeps taken 15.0 a day; re-taken within 3 days 2.8%. The file's `note` states the cq cadence (military decisions per hourly epoch; economy, defence and outposts at M1's session cadence), and `--check` now drift-checks these four p50s.

Gate seeds 1102–1106 (line 13), p50: lasting 103, 10c 0.333, banner changes 53, Marches 0.282, **10e 0.091 (0.076–0.098)**, occupations 0 (one seed 3), liberations 0 (one seed 3); `TooLate` refusals 0 per season [9–22].

### 4.2 The realistic bot profile (`--bot-profile m1`, calibrated to M1's measured ≈ 0.24 Departs per bot-day), beside cq

| Profile (99% bots, 7 days) | Departs / bot-day | lasting p10 / p50 | 10c p50 | banner p50 | Marches ≥ 2 p50 | 10e p10 / p50 | occupations p50 | gate seeds 1102–1106 |
|---|---|---|---|---|---|---|---|---|
| **cq** (thresholds) | 0.158 | 92.8 / 105 | 0.311 | 59.5 | 0.282 | 0.061 / 0.106 | 0 | FAIL: 10e 0/5, occupations 1/5, liberations 1/5 |
| **m1** (M1 cadence) | **0.272** [0.253] | 128.5 / 138.5 | 0.450 | 57 | 0.288 | 0.276 / 0.348 | 0 | **FAIL only on occupations 0/5 and liberations 0/5**; every map figure 5/5 (p10 lasting 131.8, 10c 0.380, banners 52.6, 10e 0.283) |

With the realistic cadence **the keeps do move the map**, by ≥ 2 × every map floor at p10 (10a 2.2×, 10c 2.5×, 10d 8.8× / 2.4×, 10e 2.8×). What fails under both profiles is the holding-contest floor for occupations and liberations: the campaign planner almost never besieges a first holding (CQ1-B §4.4).

### 4.3 Keep interest and forward staging (human mix, 1,000 agents, seeds 2002–2011, p50)

| Row | lasting | 10c | banners | 10e | largest share |
|---|---|---|---|---|---|
| `--keep-aggr 0.25` | 37.5 | 0.167 | 6 | 0.076 | 0.182 |
| `--keep-aggr 0.5` | 43 | 0.222 | 9 | 0.075 | 0.182 |
| `--keep-aggr 1.0` | 48 | 0.228 | 12 | 0.099 | 0.182 |
| `--forward` | 33 | 0.150 | 8 | 0.045 | 0.180 |

Unchanged in round 2. **10k / 28 days, 10 seeds** (round 2; the review found CQ1-B's 4-seed reduction), campaign, 5% sim bots, seeds 2002–2011, p10 / p50:

| `--keep-aggr` | banner changes a day (floor 5) | Marches ≥ 2 banners (floor 0.15) | keeps taken a day (p50) | re-taken ≤ 3 days (p50) |
|---|---|---|---|---|
| 0.25 | 3.19 / 3.66 | 0.105 / 0.117 | 13.2 | 23% |
| 0.5 | 3.76 / 4.39 | 0.123 / 0.131 | 15.5 | 27% |
| 1.0 | 4.65 / 5.27 | 0.138 / 0.154 | 18.1 | 29% |

**Deviation D-8 measured both ways** (`--keep-stay`, K-19's "other hosts stay"; cq, 99% bots, seeds 2002–2011): lasting p10 / p50 97.8 / 105.5 (default 92.8 / 105), 10e p50 0.110 (0.106), banner changes 56.5 (59.5), re-taken within 3 days **0.9%** (2.8%); `mapmove-gate` on 1102–1106 still FAILS (10e 0/5, occupations 0/5, liberations 2/5). Staying hosts make taken keeps harder to retake; they do not change any verdict.

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

**Measured in round 1 at `69b3d75` (before the round-2 simulator fixes) and not re-run**; the round-2 fixes moved the base row's gate-seed figures by less than 1% (§3 line 13). Logs `X-tune-*.log`. p10 here is over the 5 gate seeds (the thresholds file's p10 is over seeds 2002–2011); "2×" is the Gate CQ1 rule p10 ≥ 2 × floor (10a 120, 10c 0.30, 10e 0.20, occupations 6, liberations 2).

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

Re-derived in round 2 (`8cc6395`): the gated percentiles are unchanged to 3 decimals. Reported p50: keeps taken 18.1 a day, re-taken within 3 days 29%, Departs 1.53 per bot-day (sim profile), homes released 1,453 per season (casual 141). The overnight gate (O-B) sits on these floors and fails by a hair (§3).

### 4.7 Why 10e and the occupations stay low: floor definition, bot policy or rules?

Round 1, at `69b3d75` (round 2 re-ran the decisive rows on the fixed simulator: the lone human mix still passes the whole gate with 30 occupations p50, p10 26.6, liberations p10 2; the m1 profile still fails only on occupations and liberations). Same gate seeds (1102–1106), 1,000 agents, 7 days, `MC_LOCAL_7D`, the HEAD binary (logs `X-attr-*.log`, `FRONTIER_SIM_DEBUG=1` counters), plus a 10e decomposition from a **scratch copy** of HEAD's `frontier-sim` with a stderr-only diagnostic in `mapmove::metrics` (log `X-diag-10e.log`; the repository is unchanged, the metrics it prints are identical to HEAD's).

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

- **CI proxy (line 11, 360 seasons):** round 2 FAIL, 3 of 6 in the band; A +0.309%, B −0.417%, C +0.227%, F −0.327% (bound ±0.2%) [round 1: 2/6; A +0.328, B −0.436, C +0.212, F −0.326]. The deviations sit mostly in the Concord-per-capita column (A 1.0067, B 0.9905, F 0.9916), Dominion within ±0.0022: an economic edge, the cavalry doctrines B and F behind (their hosts pay a horse and ore surcharge per march, and MC makes every faction march far more).
- **CQ1-B's ablations (mirror kernels, same harness; `CQ1-B-NOTES` §5.1)** put most of the edge in the MC holding contest (with `sieges_per_day=0` only B −0.240% remains outside; with keeps frozen at `keep_home_guard=30000` it still fails 1/6). The real kernels did not change the verdict (A +0.313 → +0.328, B −0.406 → −0.436, F −0.304 → −0.326).
- **Overnight 1,500 seasons (O-A):** round 2 FAIL, **2 of 6** in the band (A 19.7, B 11.5, C 20.9, F 11.1% out; D 18.2, E 18.5% in) [round 1: B 11.3, F 11.2, C 20.8]. With a 1-point standard error the B and F deficits (≈ 5.5 points) are not noise. The balance lab's keep package (R) had kept 6/6 on 1,500 seasons; the v1.1 holding contest is what it did not model.
- **Integrator ablation (360 seasons, `--rules mc --mc free_city_min_ring=0 --report-only`, log `X-doct-nofc`):** without any genesis Free City the table barely moves (A +0.283, B −0.419, C +0.236, F −0.333%; 3/6 in the band). **Free Cities are not the cause**; with CQ1-B's `sieges_per_day=0` row, the remaining suspects are the sieges themselves (500-Gold stake, captures of holdings 2–3 with stores kept, occupations) and the outposts.
- **OD-14 `bannerdom` (line 19, report-only):** round 2 A +0.298, B −0.411, C +0.220, F −0.321% (3/6 in the band) [A +0.314, B −0.426, C +0.201, F −0.323]: banner-hour Dominion moves each doctrine by ≤ 0.014 points of index. It neither repairs nor further breaks the band, so OD-14 stays a free choice of the owner on other grounds (default off).

## 5. Pass beyond exit codes (Gate CQ1, round 2)

| Condition | Status |
|---|---|
| M1 digests identical | **PASS** (rules tests, frontier-sim `cq_m1_rules_keep_the_cq0_digest`; M1 criterion 0.985170 and M1 doctrine table unchanged) |
| `mapmove-gate`: MC rules pass on ≥ 4 of 5 seeds | **FAIL** (10e 0/5, occupations 1/5, liberations 1/5) |
| `mapmove-gate`: both negative controls FAIL | **PASS** |
| Thresholds p10 ≥ 2 × every floor (`--bot-profile cq`) | **FAIL** for 10a (92.8 < 120), 10c (0.289 < 0.30), 10e (0.061 < 0.20), occupations (0 < 6), liberations (0 < 2) |
| Doctrine band 6/6 | **FAIL**: overnight 1,500 seasons 2/6; CI proxy 3/6, exit 1 |
| Overnight lines (must pass before Gate CQ2 opens) | **FAIL**: O-A 2/6; O-B banner changes 1/4, Marches 3/4 |
| Best-response worst cell ≤ M1 control + 0.005 | **FAIL by 0.000059** (round 1: pass by 0.000027): MC 0.990229 vs 0.985170 + 0.005 = 0.990170. The criterion line itself exits 0 (every cell < 1.0); the cell is 1%, day 0, stake, bots in office, as before (PO-8) |
| M1 `RULESET_HASH` unchanged; `RULESET_HASH_V2` pinned once | **PASS** (no kernel changed in round 2) |
| Coordination run: campaign faction ≤ 22% on ≥ 8/10 | **PASS** (10/10, p50 7.6%) |
| `codex/frontier` not fast-forwarded | **PASS** (still `1304685`; MC did not move it) |
| Every v1 generated output byte-identical (§11) | **FAIL for the WASM bytes only**, as in round 1 (PO-6) |
| If `mapmove-gate` fails, Wave 2 does not start | **Wave 2 does not start** (§6) |

## 6. PENDING-OWNER (Wave 2 is blocked until the owner decides)

Gate CQ1 is **not green** after round 2. Five pass conditions fail (plus the WASM-bytes condition, PO-6), and each needs a choice the contract leaves to the owner (rules or floors amended before CQ2, never after; §3.13, §12). The integrator changed no rule, floor, preset or owner default in either round. Round 2 fixed the review's code defects (§9), including one planner defect (strikes launched that could not finish, `TooLate`); none of them moved a gate verdict except the best-response margin (PO-8).

**PO-1 — `mapmove-gate` 7d/1k fails and p10 ≥ 2 × floors fails (§4.1, §4.5, §4.7).**
- Gate seeds 1102–1106, `cq`: 10e net movement 0/5 seeds (0.076–0.098 vs floor 0.10), occupations 1/5 (floor 3), liberations 1/5 (floor 1); everything else 5/5. Both negative controls fail as they must.
- Thresholds file p10 (`cq`) vs 2 × floor: 10a 92.8 vs 120, 10c 0.289 vs 0.30, 10e 0.061 vs 0.20, occupations 0 vs 6, liberations 0 vs 2 (10d, 10h sieges/captures/outposts clear 2×).
- With M1's measured cadence (`m1` profile, 0.253 Departs per bot-day) every map figure clears 2× at p10 (10a 131, 10c 0.38, 10e 0.283), and only occupations and liberations fail.
- Cause: 10e = the campaign plan follows the ring openings outward, so only 10–13 of 132 P₂ provinces change after bell 287 (floor definition + bot policy); occupations = the campaign plan almost never besieges a home and its bots retreat from the few sieges they start (bot policy). Under the same rules the lone human mix passes the whole gate with 30 occupations.
- Best inside §3.12 (`keep_home_guard` 50, `keep_consolidate_bells` 144, `free_city_min_ring` 6): 10e floor met 5/5, 10a and 10c over 2×, but 10e p10 0.126 < 0.20 and occupations 0.
- Options: (a) **bot policy**: give the campaign planner an occupation objective (a holding slot for first holdings, siege hosts that hold while their siege counts), re-derive the thresholds and re-run the gate, before CQ2-F ports the planner; (b) **amend the floors before CQ2**: 10e measured over every province outside the heartlands open at bell 287 *and later* (or a lower floor such as 5%), occupations and liberations gated on the human-mix row or reported only for a 99%-bot exit, 2× applied to the map figures only; (c) **rules**: adopt some of the §3.12 levers by amendment (fixes the 10e floor and 10a/10c at 2×, not occupations); or a combination, e.g. (a)+(c).

**PO-2 — the doctrine band fails on the MC rules (§4.8).** Round 2: CI proxy 3/6 in the band (A +0.309%, B −0.417%, C +0.227%, F −0.327%; bound ±0.2%); overnight 1,500 seasons 2/6 (B 11.5%, F 11.1%, C 20.9%, A 19.7% outside 16.7 ± 2); without Free Cities still 3/6. The edge is economic and mostly from the MC holding contest (CQ1-B's ablations). Options: re-tune the doctrines on the MC simulator (an amendment to the doctrine table, re-running both M1 and MC doctrine lines), or change the holding-contest economics (stake, capture effects, outposts; Free Cities are excluded by the ablation) and re-measure. Not decidable by the integrator.

**PO-3 — the overnight 10k/28-day gate fails by a hair (O-B).** Banner changes a day 4.86–5.07 (1/4 seeds ≥ 5; round 2 identical), Marches with ≥ 2 banners 0.148–0.170 (3/4 ≥ 0.15; 4 seeds need 4/4). The defining run's own p10 is below both floors (4.65 < 5, 0.138 < 0.15): the floors are the balance lab's, measured with lone players, and the campaign policy sits on them. Options: amend the two floors (e.g. to the thresholds file's ½ × p10 or a round 4 a day / 12%), or change the planner as in PO-1 (a).

**PO-4 — the 3:1 size stress crosses 22% (§4.4; with OD-16).** The gated coordination check passes 10/10 (campaign faction ends at 7.6% p50), so OD-16 itself does not stop the wave. But a faction three times the others' size ends above 22% on 6/10 seeds (human-mix campaign, p50 22.1%), 9/10 (cq bots, 22.4%) and 9/10 (lone, 23.5%), rising from Q1. §8.7 says the owner is told before Wave 2: size snowballs a little, coordination does not.

**PO-5 — before CQ2-A (not a gate failure):** CQ1-A finding 1, keep tile not wedge-symmetric (§7). Integrator recommendation: adopt `keep_tile_symmetric`; changing it later re-runs Gate CQ1's simulator lines.

**PO-6 — v1 generated output not byte-identical (§2):** the WASM artefact's bytes changed (behaviour identical: recorded vectors byte-identical, 6/6 replays). Accept as a code-layout change, or require CQ1-A/CQ1-C to restore the M1 bytes (likely by moving the shared clash/camp changes behind a separate build of the M1 artefact).

**PO-7 — §3.10 counts "each final holding"; `conquest_model` counts provisional ones too (CQ1-C D-10; review major).** A provisional holding lasts ≈ 24 bells. Finality is a Holding fact (`final_ts` and the ticket cohort) that M1's lazy flip writes only when an instruction carries the Province, so a mirror bit would lag it, and the v2 site mirror has no free byte (bytes 5–7 and 28–31 are taken by v2 fields). `frontier-abi/src/layout/**` freezes at Gate CQ1, so this must be settled before the gate closes. Options: (a) **amend §3.10** to count every holding in state 1, provisional included (no code change; integrator recommendation: the effect is ≤ 24 bells per new holding, the same for every faction); (b) reserve a finality flag (e.g. a high bit of the mirror's `order` byte) set by SettleTicket and cleared by the lazy flip and an OpenProvince/resolve-time due check, with CQ2-A's write paths and a regenerated vector set.

**PO-8 — the best-response margin now fails by 0.000059 (§5).** Round 2's correct simulator fixes (plan-time `TooLate`, the kernels' Frontier-protection boundary) moved the MC worst cell from 0.990143 to 0.990229, past the 0.990170 bound; the criterion's own test (every cell < 1.0) still passes. Round 1 warned that any outcome-changing change would likely cross it. Options: accept a margin of +0.006 for MC (the difference is far below the criterion's seed noise), or treat it as part of PO-2's economic re-tune and re-measure.

## 7. Other findings for later waves

- **CQ1-A finding 1 (keep tile not wedge-symmetric)** is open: `keep::keep_tile` (pinned rule, kept) puts the keep in the same world direction in every province, so wedges differ (5,400 of 6,480 sampled provinces). `keep_tile_symmetric` exists as a proposal. It must be decided before CQ2-A writes OpenProvince; changing it later re-runs Gate CQ1's simulator lines (§3.13). Integrator recommendation: adopt the symmetric rule (DESIGN §3.2 gives all wedges the same land), but it is a player-visible rule, so it is listed for the owner.
- **CQ1-D D-4/D-5: done in round 2** — contract v1.2 ratifies the end marker (A-2) and CF-1…CF-8 (A-3), and gives the unpinned JSON shapes to CQ2-E as additions to `cqfmt.rs` (A-4).
- **Design-chat footprint moved:** `frontier/ui-shell` touched `permutation-server/web/lang/en-frontier.mjs`, `web/frontier/flog.mjs`, `intro/title.mjs`, `test/web-frontier-wave4.test.mjs` and `docs/frontier/ui-shell/*` since CQ0. Round 2: the ownership check reports these and enforces only §4.5's list (A-2), so CQ3-D can edit `en-frontier.mjs` as §11 and §9.1 require; CQ3-D should still coordinate the file with the design chat before it starts.
- **Campaign defence never breaks a keep contest** in the cq and human-mix campaign runs (`keep_contests_broken` 0 on every seed; lone and m1 runs break 1–2). With the standing-order defence of CQ1-B D-6 the attacker almost always wins (keeps re-taken within 3 days 2.8% at 7 days vs the contract's "about 40%" expectation). Not a gate item; CQ2-F should check its planner's defence before porting.
- **Contract v1.2 amendments (§18 A-1…A-7)** after the review: CQ0 = `39ff369` in §12, the ownership check rules, CF-1…CF-8, CQ2-E and `cqfmt.rs`, the occupation stake (§5.2.1/§5.5), plan-time `TooLate` and the drift-checked bot rates (§8.6–§8.8), the simulator on the remaining kernels. No rule, floor, preset or owner default changed.
- **For CQ2-B:** the hour snapshot reads the garrison after the bell's clash and settle, while §3.10 says "at `bell_start(b)`" (CQ1-C-NOTES §8): snapshot before the clash/settle, or the integrator amends §3.10.
- **For CQ2-F:** port the planner with D-6/D-7 and the plan-time `TooLate` check (A-6), and write §8.7 item 6's field-equality test.
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
# round 2: the holding-contest and kernel-vector tests
(cd frontier-sim && cargo test --release cq_)
cargo test -p frontier-abi --test cq_kernel_vectors --test cq_conquest_model
scripts/cq-ownership-check.sh --self-test
# §4.8 ablation
(cd frontier-sim && cargo run --release -- doctrine-gate --set kernel --rules mc --mc free_city_min_ring=0 --report-only)
```

## 9. Review of Wave 1: verdicts and what changed (integration window, round 2)

Each review item was checked against the code at `277fa9c`. **Fixed** = changed here with a test; **escalated** = an owner decision (§6); **deferred** = a real minor left to a named later unit; **rebutted** = the claim does not hold.

### 9.1 CQ1-B sim-conquest

| Sev. | Item | Verdict | Change / evidence |
|---|---|---|---|
| blocker | The unit cannot pass Gate CQ1 (10e, occupations, liberations, 2×, doctrine band, 10k/28d) | **Confirmed; escalated** (PO-1…PO-3) | Re-measured on the fixed simulator: same verdicts (§3, §4). Floors, rules and the planner's objectives are the owner's (§12: "amended before CQ2, never after") |
| major | No simulator test covers the MC holding contest | **Fixed** | `frontier-sim/src/cq_contest_tests.rs`, 12 `cq_*`: post-siege immunity bars only the besieging faction and the stake goes to the target; a deserted siege and a Free City siege burn it without immunity; a completed first-holding siege occupies without transfer and returns the stake; Respite on expiry and on the owner's own liberation, `end + respite_bells`, barring only the occupier; walk-away and third-faction liberations give none; capture credit (stores, Dominion), the slot move and ALL-faction immunity; a reserved slot released exactly once on failure, lapse and occupation; the D9 audit; a season with occupations and liberations. No bug found in the contest code itself |
| minor | The 10i D9 counter is unreachable | **Fixed** | `mc_d9_check`: each first holding's founding owner is recorded; a live first holding with another owner or order is counted once (daily and at the end); the unreachable counter is gone; `cq_d9_audit_detects_a_first_holding_transfer` |
| minor | Local mirrors of kernels (`may_besiege_v3`, outposts, capture effects, `keep_tile`, Herald's Call) | **Fixed except the Call** | `may_besiege_v3` (fixes the Frontier-protection boundary: sim `>=` vs kernel `founded − genesis >`), `keep::keep_tile`, `holding::capture_effects` (walls), `may_found_outpost`, `lowest_free_slot`. The Herald's Call stays the simulator's tie-breaker (needs a day seed; D-5) |
| minor | The planner launches strikes that are refused `TooLate` | **Fixed** | `can_complete_before` at plan time (legality from b + 1, the muster bell, the siege group's muster, a session lead's arrival). Gate seeds 1102–1106: `TooLate` refusals 22/10/13/17/9 → 0/0/0/0/0 per season (`FRONTIER_SIM_DEBUG`). Contract §8.6 amended (A-6) so CQ2-F ports it |
| minor | Keep taken: the taking faction's other hosts go home (K-19 says they stay) | **Recorded as deviation D-8 and measured both ways** | `--keep-stay` (K-19's reading): 7-day cq row lasting p10 97.8 / p50 105.5, 10e p50 0.110, re-taken within 3 days 0.9% (default 2.8%); gate verdict unchanged (10e 0/5, occupations 0/5, liberations 2/5). Default unchanged (CQ1-B's choice) |
| minor | `cq` profile limits only military decisions to the epoch | **Documented** | The thresholds files' `note` states each profile's cadence; CQ1-B-NOTES header; contract A-6 (CQ2-F/CQ3-B hand-off) |
| minor | `--check` ignores the per-bot-day rates | **Fixed** | `mapmove::check` also compares the p50 of departs, keep marches, keep captures and declares per bot-day |
| minor | frontier-node `profile_equality` broke | Already fixed (`69b3d75`) | `config.rs` changed again here (`keep_stay`); `agents --test profile_equality` re-run: 12 passed |
| minor | CQ1-B-NOTES stale | **Fixed** | Header points to §3–§4 here |
| missing | §8.7 item 6 field-equality test | **Deferred to CQ2-F** (needs `agents::campaign`) | With D-6/D-7 and the plan-time `TooLate` check (A-6) |
| missing | Keep-interest rows at 10k/28d with 4 seeds | **Fixed** | Re-run with 10 seeds (§4.3) |
| missing | Herald's Call Rally, RetireHost, lost Dominion hours not modeled | **Deferred, documented** (D-5, §4.1 of CQ1-B-NOTES) | Not a Gate CQ1 figure |
| missing | No assertion that occupations and liberations ever occur | **Fixed** | `cq_mc_season_has_occupations_and_liberations` |

### 9.2 CQ1-C abi-v2

| Sev. | Item | Verdict | Change / evidence |
|---|---|---|---|
| major | `skip_gate` per record-bell (1,818,000 at 24 × 12) | **Confirmed, fixed** | `skip_gate(bells, active_bells)`: 3.5k per active bell, capped at `bells`; test asserts `skip_gate(24,24) = 894,000 = cu_limit ≤ CU_LADDER_MAX`; CQ1-C-NOTES §2 corrected |
| major | D-10 contradicts §3.10 ("each final holding") | **Confirmed; escalated as PO-7** | Finality is a Holding fact (`final_ts` + cohort); the lazy flip writes it only when the owner acts, so a mirror bit would lag it; the mirror has no free byte. Options in §6. The layout does not freeze until PO-7 is decided |
| major | No test shares `{keep,control}-vectors-v1.json` | **Confirmed, fixed** | `frontier-abi/tests/cq_kernel_vectors.rs` (6 `cq_*`): keep codec over every recorded state, every keep scenario and the quiet run through `step` with roster capturers, the bridge's `keep_tile`, `control_weights` (1-based order, occupier and Free City sides) and `dominion_lead`. All pass: no disagreement found |
| minor | Build's Province always writable | **Fixed** | `Wr::Either` (§5.6), test; `vectors/v2/tags.json` regenerated |
| minor | Hand-copied constants and rules | **Fixed** | `conquest_bounds` in `validate`, `MAX_TIMER_BELLS`, `MAX_GUARD_TROOPS`; `immunity_bars`, `held_since_hour_from`, `tier_from_u8`. The flip's wall rule stays inline (`capture_effects` needs a `Holding`) |
| minor | Snapshot garrison after clash/settle vs "bell_start(b)" | **Plausible; deferred to CQ2-B** | Owner of the call order in Wave 2; CQ1-C-NOTES §8 |
| minor | D-12 Respite one bell longer than §3.5 | **Fixed** (D-12's Respite part withdrawn) | `end + respite_bells`, as §3.5 and the simulator |
| minor | Occupation stake never returned at season end | **Fixed** | Owed to `src` from the completion bell (flags bit 2 on the kind-2 record, carried if unpaid); contract A-5 |
| minor | `Acc::KindV2` changed v1 code (WASM bytes) | **Recorded** under PO-6 | CQ1-C-NOTES §8; `cq-regen --check` fresh; the WASM bytes are the same as before this round (205,686 B) |
| minor | Tests miss owner liberation, 12 sites + keep + camp | **Fixed** | `cq_owner_liberation_gives_respite_against_the_occupier_only`, `cq_twelve_sites_and_the_keep_drop_the_camp_and_write_the_keep` |

### 9.3 CQ1-D formats-docs

| Sev. | Item | Verdict | Change / evidence |
|---|---|---|---|
| major | Footprint enforcement conflicts with §11/§9.1 (CQ3-D's `en-frontier.mjs`) | **Confirmed, fixed** | Footprint report-only by default, `--footprint-strict` to enforce; contract §4.5 amended (A-2), DECISIONS CQF2 |
| major | Side-branch merges escape the check | **Confirmed, fixed** | Every parent walked; exempt only what merges of `codex/frontier` and `frontier/cq-integ` bring in; self-test case |
| minor | `evil(); // MC hook` passes | **Confirmed, fixed** | Markers alone on their line; unclosed block = violation; two self-test cases (20 cases, PASS) |
| minor | DESIGN §24 lists two negative controls | **Fixed** | Three, plus 10d's Marches clause, pointer to §13.4 |
| minor | `cqfmt` hand-copies kernel codes | **Fixed** | `control::CODE_*`, `travel::BELLS_PER_DAY`; `cq_psfct1_codes_are_the_kernels` |
| minor | March-order agreement pinned only at three ring counts | **Deferred** (no defect: the review's ad-hoc 15-value comparison agreed) | To CQ2-E with the `cqfmt` additions it now owns (A-4) |
| minor | CF-1…CF-8 and the end marker not ratified | **Fixed** | Contract v1.2 A-2, A-3 |
| missing | Unpinned JSON shapes have no owner | **Fixed** | Contract A-4: CQ2-E extends `cqfmt.rs` additively |

## 10. Round 3 (Wave-1 close): merges, Gate CQ1 re-run, the package against the merged code

- **Date:** 2026-10-02. **Role:** MC integrator, Wave-1 close (DECISIONS CQ-H: CQH1–CQH4; contract **v1.3** §12, §19 A-8…A-28).
- **Base:** `frontier/cq-integ` at `f1a5510` (DECISIONS CQ-H). Local commits only; nothing pushed; **`codex/frontier` not fast-forwarded** (still `5ed36fa`).
- **Logs:** `(session scratch)/scratchpad/cqclose/integ/` (`<id>.log`, `<id>.rc` = exit code, wall seconds, command; queue scripts `qA.sh`, `qB.sh`, `qC.sh`, `qX.sh`, `qY.sh`). Builds: `cargo --offline --locked`, `CARGO_TARGET_DIR` under `scratchpad/frontier/conquest/w1c-target/integ/`. No install, no download (`npm ci` not run: `permutation-gateway/node_modules` as in rounds 1–2), no port bound, no chain transaction.
- **Simulator binary:** every `cargo run --release -- …` line of §12 ran on one frozen release build of `frontier-sim` at `2f1a14b` (`bin/fs-integ`, sha256 `e027a2cf…2563`), with the same arguments, from `frontier-sim/` (the thresholds files are read at run time; no `frontier-sim` source changed after `2f1a14b`). The `cargo test` lines built their own binaries.
- **Machine:** 16 cores shared with other sessions; load average 85–160 during the heavy lines (wall times inflated). At most three heavy jobs of this session at a time.

### 10.1 Merges (contract §11, A-22) and integration commits

| Commit | What |
|---|---|
| `7cf2938` | merge `codex/frontier` `5ed36fa` (`--no-ff`, the start-of-round merge: Wylls rename, nation-only join, design work, herald wedge counters). One conflict, `docs/frontier/DECISIONS.md`: both sides appended a part after U (MC's part CQ, codex/frontier's part V); both kept. No design-chat file edited |
| `7f66f6c` | merge **W1C-A-kernels** (`c1d4fec`), no conflict |
| `a188fea` | merge **W1C-C-contract** (`1693c27`). One conflict, `DECISIONS.md`: part CQ-I placed after CQ-H inside part CQ, part V after it |
| `0eee859` | merge **W1C-B-sim** (`7a1cead`), no conflict |
| `2f1a14b` | **W1C-B's merge request applied:** `frontier-sim` K2 calls `catalog::train_v2` (kernel); the stand-in `train_v2` deleted; `w1c_shim.rs` → `k2.rs` with its two tests against the kernel function (both pass). Same table, so no behaviour change |
| `8384d55` | both thresholds files re-derived by their defining commands (`mapmove … --first-seed 2001 --json thresholds/<file>`): **only `run.kernels` changed** (`keep v1` → `keep v2`); every gated percentile and seed value is byte-identical to W1C-B's derivation |
| (this commit) | contract v1.3 §19 **A-26…A-28** (integrator reconciliation, §10.4), DECISIONS **CQI12 recorded, CQI16…CQI18**, these notes |

Dependency requests: none from any unit (no manifest, lockfile, toolchain or `.gitignore` change). W1C-B's request (the shim swap) is `2f1a14b`.

`scripts/cq-regen.sh` after each merge (logs `M0-regen` … `M3-check`): the write run changed **no file** after any of the four merges, and `--check` exit 0 after each (`M1-check`, `M2-check`, `M3-check`; the codex/frontier merge was checked by the gate's preamble). W1C-A's kernel changes do not move the v1 WASM artefact (sha256 `38df2c14…08f1`, as at `f1a5510`).

**Hashes:** M1 `RULESET_HASH` = `72c6b5835ded6418ed98b0c00b2ae45ce4c4b082d9614447dbce2c9d2e654bd9` (**unchanged**). **`RULESET_HASH_V2` = `b6dd0f3f260d9ef3e9a71c5010b56c42693578f4d8c394623d56deb9fed98274`** (re-pinned once by W1C-A; confirmed on the merged tree by `cq_m1_ruleset_hash_unchanged_and_v2_pinned` and `v2::presets::tests::ruleset_hash_v2_is_the_kernels`; recorded in DECISIONS CQI12/CQI18 and contract A-28). `KERNEL_VERSIONS_V2`: catalog 2, doctrine 2, keep 2; every other entry unchanged.

### 10.2 Gate CQ1 (contract v1.3 §12), line by line

Code lines ran at `8384d55` (= the code of this commit; the commits after it are docs only). Preamble: `CQ_PORTS` empty (no port bound).

| # | Command (§12, v1.3) | Exit | Result |
|---|---|---|---|
| P1 | `scripts/cq-ownership-check.sh <every frontier/cq-* except cq-integ>` | 0 | PASS: 0 violations over the eight branches (CQ1-A…D, W1C-A/B/C), 10 footprint warnings, report-only (A-2). `--self-test` PASS |
| P2 | `git diff --quiet "$(git merge-base HEAD codex/frontier)" -- permutation-server/web/session.mjs permutation-chain/src` (A-25) | 0 | merge-base `5ed36fa` |
| P3 | `scripts/cq-regen.sh --check` | 0 | every generated output fresh (211 s) |
| 1 | `cargo fmt --all -- --check` | 0 | |
| 2 | `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` | 0 | |
| 3 | `cargo test --locked --release -p permutation-rules` | 0 | **470** passed: `m1_rules_keep_the_phase_b_digests`, `occupancy_empty_keeps_the_phase_b_digests`, `phase_a_equals_the_reference_on_4320_inputs`, `cq_m1_ruleset_hash_unchanged_and_v2_pinned`, all `cq_*` |
| 4 | `cargo test --locked -p frontier-abi` | 0 | **106** passed (incl. `ruleset_hash_is_the_kernels`, `ruleset_hash_v2_is_the_kernels`) |
| 5 | `abi-vectors -- --check` | 0 | 16 files fresh |
| 6 | `cargo test --locked -p permutation-chain` | 0 | 157 passed |
| 7 | `(cd frontier-sim && fmt && clippy --release -D warnings && cargo test --locked --release)` | 0 | **60** passed, 0 failed (704 s): `k2::cq_k2_*` on the kernel table, `cq_close_tests` (4), `cq_m1_rules_keep_the_cq0_digest`, `cq_thresholds_files_are_complete`, the release-only M1 doctrine gates |
| 8 | `criterion --best-response --seeds 3 --first-seed 30001 --gate` (M1) | 0 | worst **0.985170** (days 1–7, stake, bots in office, 1%), unchanged |
| 9 | `doctrine-gate --controls` (M1) | 0 | **unchanged:** 4/6 in the display band, max \|Δ index\| 0.060%; draft (−1.319%), Knight (F −0.242%), A boost (+0.326%) rejected |
| 10 | `criterion … --rules mc --policy campaign --gate` | 0 | worst **0.989299** (bots in office, 1%, day 0, stake) **≤ 0.995: PASS**; every cell < 1.0; M1 control 0.985170, **MC − M1 = +0.004129** (reported) |
| 11 | `doctrine-gate --set kernel --rules mc --controls` (CI proxy) | 0 | **PASS:** every doctrine within the CI gate (`balance::gate_check`: \|Δ index\| ≤ 0.2%, win rate within 16.7 ± 10): **max \|Δ index\| 0.106%** (A +0.106, B −0.085, C +0.042, D −0.014, E −0.011, F −0.038%). Win rates A 14.4, B 16.7, C 19.7, D 17.5, E 15.8, F 15.8% (4/6 inside the ±2-point display band; SE 2.0 points at 360 seasons). Controls rejected: draft (A −2.872%), Knight (A −1.345%), A boost (+0.502%). 2,595 s |
| 12 | `mapmove … --bot-profile cq … --check thresholds/mc-7d-1k.json` | 0 | no drift |
| 13 | `mapmove-gate … --bot-profile cq … --seeds 5 --first-seed 1101 --controls` | 0 | **MC PASS, every figure 5/5** (p10 over 1102–1106: 10a 99.6, 10c 0.317, 10e′ 0.142, occupations 38.4, liberations 23). `m1/lone` control FAILS (13 figures 0/5); `mc-weightmap` control FAILS (10a, 10b, 10d 0/5; 10c 3/5; it passes 10e′ 4/5 and every 10h count) |
| 13a | 2:1 size stress, human mix (A-18, gated) | 0 | **PASS 10/10**; faction 0 end p50 0.188 |
| 13b | 2:1 size stress, `--bot-profile cq --bots 0.99` (gated) | 0 | **PASS 9/10**; end p50 0.206 |
| 14 | `--bot-profile m1` (reported) | 0 | 10a p10/p50 129.8/138.5, 10c 0.431/0.456, 10e′ 0.208/0.221, occupations 40.8/43; 0.297 Departs per bot-day |
| 15 | `--keep-aggr 0.25 / 0.5 / 1.0` (reported) | 0 | 10a p50 35.5 / 40 / 46; 10e′ p50 0.094 / 0.098 / 0.115; occupations p50 32.5 / 33 / 34; liberations p50 4 / 3 / 4 |
| 16 | 3:1 at 7 days, human mix (reported, A-18) | 0 | faction 0 Q1 → end p50 0.179 → 0.219; with `--check-leader-max 0.22` (extra row `X-s31-7d-hm-count`) **5/10** ≤ 22%; the cq row (`X-s31-7d-cq-count`) **3/10**, end p50 0.223 |
| 17 | `campaign:0,lone:1-5 --check-leader-max 0.22` (OD-16) | 0 | **PASS 10/10**; campaign faction Q1 → end p50 0.130 → 0.070 |
| 18 | `--forward` (reported) | 0 | 10a p50 35.5; 10e′ p50 0.094 |
| 19 | `doctrine-gate --set kernel --rules mc,bannerdom --controls --report-only` | 0 (report-only) | verdict PASS, max \|Δ\| 0.111%; win rates A 14.2, B 16.1, C 20.0, D 17.8, E 14.7, F 17.2%; draft (−3.101%), Knight (−1.457%), A boost (+0.498%) rejected (2,605 s) |
| 20 | `(cd frontier-node && fmt && clippy -D warnings && cargo test --locked --workspace)` | 0 | **443** passed, 0 failed, 11 ignored (550 s) |
| 21 | `(cd permutation-gateway && npm ci --ignore-scripts && npm test)` | 0 (`npm test`) | **584/584** (codex/frontier added tests since round 2's 546); `npm ci` not run (an install); the real `frontier.wasm` tests replay every recorded answer |
| 22 | `cargo check --locked -p permutation-frontier` | 0 | |
| 23 | `scripts/cq-ownership-check.sh <cq-1*, cq-w1c-*>` | 0 | PASS |
| O-A | overnight `doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --rules mc --policy lone --gate` | 0 | **6/6 in the band**: A 17.0, B 15.5, C 17.3, D 16.6, E 16.5, F 17.1%; max \|Δ index\| 0.102% (B −0.102%); 1,500/1,500 conserve (2,919 s) |
| O-B | overnight `mapmove-gate … --agents 10000 --days 28 --seeds 4 --first-seed 1101 … mc-28d-10k.json --controls` | 0 | **PASS 4/4 on every figure**: banner changes a day 4.93 / 4.93 / 5.75 / 5.39, Marches ≥ 2 banners 0.154 / 0.151 / 0.164 / 0.148. **Both controls FAIL**: `m1/lone` fails banners, Marches and quiet days 0/4; `mc-weightmap` fails banners and Marches 0/4 (banners ≤ 3.14 a day, Marches ≤ 0.046) |
| O-C | overnight 2:1 at 10k / 28 days `--check-leader-max 0.22` | 0 | **PASS 10/10**; end p50 0.189 |
| O-D | overnight 3:1 at 10k / 28 days `--check-leader-max 0.22` | 0 | **PASS 10/10**; end p50 0.200 (Q1 0.204) |

The O-C/O-D lines ran exactly as §12 writes them (without `--gate-28d`; W1C-B ran them with it): the size verdicts and shares are the same as W1C-B's.

### 10.3 Pass beyond exit codes (v1.3, A-20)

| Condition | Status |
|---|---|
| M1 digests identical; M1 criterion 0.985170 and M1 doctrine table unchanged | **PASS** (lines 3, 7, 8, 9) |
| `mapmove-gate` 7 d: MC rules pass on ≥ 4 of 5 seeds against the v1.3 floors, both negative controls FAIL | **PASS** (5/5 on every figure; both controls FAIL) |
| Thresholds p10 ≥ 2 × every floor (10e′ and every 10h count included) | **PASS**: 10a 98.4 (2.19×), 10c 0.289 (2.22×), 10d 52.6 (8.8×) / 0.250 (2.5×), 10e′ 0.150 (2.5×), declared / completed / failed 110.7 / 94.9 / 13 (5.5× / 9.5× / 4.3×), occupations 39.5 (3.95×), liberations 25.9, captures 55.6, outposts 1,676; D9 0 |
| Doctrine band 6/6 in the CI proxy and overnight, three controls rejected | **PASS** by the gate's definition: CI proxy every doctrine within the CI gate (max \|Δ index\| 0.106%; 4/6 inside the ±2-point display band at 360 seasons, as in P1's `D02`), overnight 6/6 in the ±2 band (1,500 seasons); draft, Knight and A boost rejected in both the M1 and MC proxies |
| Best-response (CQH2): every cell < 1.0, MC worst ≤ 0.995 on 30001; MC − M1 reported | **PASS**: 0.989299; MC − M1 +0.004129 |
| M1 `RULESET_HASH` unchanged; `RULESET_HASH_V2` re-pinned once, recorded | **PASS** (`b6dd0f3f…8274`; DECISIONS CQI12/CQI18, A-28) |
| Coordination run ≤ 22% on ≥ 8 of 10 | **PASS** 10/10 |
| Size stress: 2:1 at 7 d in both gated rows; 2:1 and 3:1 at 10k / 28 d | **PASS** (10/10, 9/10; 10/10, 10/10). 3:1 at 7 d reported: 5/10 (human mix), 3/10 (cq) |
| 28-day gate 4 of 4 at 3.5 a day / 10%, both controls FAIL | **PASS** |
| v1 generated outputs byte-identical except the v1 WASM bytes (with `wasm-vectors.json` byte-identical and every recorded answer replayed) | **PASS against `git merge-base HEAD codex/frontier` (`5ed36fa`)**: only `frontier.wasm` and its `.sha256` differ; `wasm-vectors.json` byte-identical to `39ff369`; the WASM tests replay every recorded answer. **The literal line `--v1-unchanged 39ff369` exits 1**: besides the accepted WASM bytes it lists `permutation-server/web/sdk/codec.mjs`, whose header comment the owner-approved Wylls rename (`8c1b5ea`, codex/frontier, not MC) changed ("PERMUTATION STATE" → "Wylls"). Amended by A-27 (the A-25 rule applied to this condition); the owner may prefer to see it as a one-line exception instead |
| `codex/frontier` not fast-forwarded | **PASS** (`5ed36fa`) |

**Verdict: Gate CQ1 is green on the merged Wave-1 close** (every exit-gated line exits 0, overnight lines included, and every pass condition holds; the v1-outputs condition holds under A-27, see the last row). By CQH3 Wave 2 can start as planned; the items in §10.6 are open but none is a gate line.

### 10.4 Integrator reconciliations at the merge (contract §19 A-26…A-28; DECISIONS CQI16…CQI18)

- **A-26, rally stay for campaign factions.** Contract v1.3 (A-14, A-15, §8.6, §8.7 item 1) wrote "every policy", after P1's `--planner stay=2`. The merged simulator keeps E1's campaign-only rule (W1C-B `74a0a01`), for a measured reason: the stay for every policy fails the overnight band 5/6 (E 18.9%), and P1's band table `D03` (the package's [P1] 6/6, 0.102%) is reproduced to the printed digit only without the stay for lone factions (O-A above is that table again). P1's lone `stay=2` rows were byte-identical to its base rows, so the P1 binary did not contain the path. The text now matches the package as measured; no rule, floor or default changed. CQ2-F ports the campaign-only rule.
- **A-27, the v1-outputs condition** compares against the last merged `codex/frontier` commit (§10.3 last row).
- **A-28, `RULESET_HASH_V2`** recorded; the simulator's K2 is the kernel table (`2f1a14b`).
- **Names:** the gated 10e′ is `10e_net_movement_open` (`Metrics::net_movement_open`, as §8.7 writes), the old 10e is reported as `net_movement_p2`; the kernels' names (`keep_tile_symmetric`, `train_v2`, `TRAIN_PROD_COST_V2`, `variant_surcharge_v2`, `validate_table_v2`, `DoctrineError::RefusedLine`) are §7's. No other reconciliation was needed.

### 10.5 The decision sheet's headline numbers against the merged code

[C] / [P1] as in the sheet. "Measured" = the merged tree (`2f1a14b` binary); the extra rows (`X-*` logs) are exploration, not gate lines.

| Sheet figure | Measured on the merged code | Verdict |
|---|---|---|
| PO-1: E1 occupations p10 36.8, liberations 25 on the thresholds seeds; 37.4 / 22.2 and 37.8 / 24.4 on two new sets [C] (without the symmetric keep) | thresholds seeds (with the symmetric keep) 39.5 / 25.9; 10002–10021 36.8 / 23; 13002–13021 34 / 20.9; 6102–6106 36.4 / 22.4 | reproduced (every set ≥ 3.4 × the occupation floor) |
| PO-1: package PASS on 1102–1106, 10002–10021, 13002–13021, 6102–6106, both controls FAIL on every set [P1] | PASS on all four sets (every figure on every seed), both controls FAIL on each | **reproduced** |
| PO-1: `m1` profile PASS 20/20 [P1] | PASS 20/20 (10002–10021), controls FAIL | reproduced |
| PO-1: p10 / floor 10a 2.08–2.17×, 10c 2.13–2.22×, 10e′ 2.37–2.63×, occupations ≥ 3.4× [P1] | over the four gate sets: 10a 2.05–2.21×, 10c 2.08–2.44×, 10e′ 2.17–2.57×, occupations 3.40–3.84×; thresholds file 2.19× / 2.22× / 2.50× / 3.95× | every value ≥ 2× (the operative rule); the ranges' edges differ (10a low 2.05 vs 2.08, 10e′ low 2.17 vs 2.37 on 13002–13021), because P1 quoted most gate-set rows without the symmetric keep (W1C-B §6). Same per-seed figures as W1C-B |
| PO-1: 10c at 14% only 1.98× on 4002–4011 [C] | p10 0.278 → 1.98× at 14%, 2.14× at 13% | reproduced |
| PO-1: Departs per bot-day 0.158 → 0.177 (+5 to +12%) [C] | 0.182 p50 (+15% on 0.158) | the [C] figure is E1 without the symmetric keep; with the package it is 0.182 (W1C-B measured the same). Cost slightly above the sheet's range |
| PO-1: E1 leaves contract 10e at p10 0.074 [C] | `net_movement_p2` p10 0.074, p50 0.110 (reported) | reproduced |
| PO-2: CI proxy 6/6, max \|Δ\| 0.100% [C] (without the symmetric keep); with it 0.106% (P1 `D02`) | max \|Δ index\| 0.106%, all six within the CI gate; win rates the same table as `D02` | reproduced |
| PO-2 / PO-5: overnight with K2 + symmetric keep 6/6, max \|Δ\| 0.102% [P1] | 6/6, max 0.102%, table A 17.0 … F 17.1% identical to `D03` | **reproduced** (with campaign-only rally stay, A-26) |
| PO-2: overnight 6/6 on seeds 20000 and 30000 [C]; seeds 40000 6/6 with B 14.8% [C] | not re-run (the gate runs 10000; each set is ≈ 50 min) | not re-measured |
| PO-2: three doctrine controls rejected [P1] | draft −2.872%, Knight −1.345%, A boost +0.502% (MC CI proxy) | reproduced (Knight −1.345% vs P1's −1.889%: the Knight keeps its M1 cost here, A-12; rejected either way) |
| PO-3: 28-day PASS 4/4 on 1101 and 9101 with the symmetric keep [P1]; weightmap control fails Marches 0/4 (max 0.046) [P1] | 1102–1105 PASS 4/4 (banners 4.93–5.75, Marches 0.148–0.164); 9102–9105 PASS 4/4 (4.82–5.32, 0.142–0.148); weightmap Marches max 0.046 on both sets | **reproduced** |
| PO-3: base p10 4.65 / 0.138 [C] | thresholds file (package) p10 4.78 / 0.132; margins 1.37× / 1.32× | consistent (the [C] base is before E1) |
| PO-3: the banner floor alone does not always reject the weightmap control (up to 5.21 a day) [C] | weightmap banners up to 3.14 (1101 set) and 4.07 (9101 set) a day; Marches reject it on every seed | consistent |
| PO-4: 2:1 with E1 10/10 and 9/10 [P1] | 10/10 (human mix), 9/10 (cq) | reproduced |
| PO-4: 3:1 at 7 d 6/10 and 3/10 [P1] | **5/10** (human mix), 3/10 (cq) | human mix one seed lower (reported row, not gated); W1C-B measured 5/10 too |
| PO-4: 3:1 at 28 d 10/10, end p50 0.202 [P1] | 10/10, end p50 0.200 | reproduced |
| PO-5: thresholds 10a p10 93.8 → 98.4 [P1] | 98.4 (per seed identical to P1's `S01-T-cq-sym`) | reproduced |
| PO-6: v1 WASM bytes changed, behaviour identical (205,686 B; vectors byte-identical; replays) [C] | 205,686 B, sha256 `38df2c14…08f1` (unchanged since `f1a5510`); `wasm-vectors.json` byte-identical to `39ff369`; npm 584/584 | reproduced |
| PO-7: `conquest_model` counts provisional holdings | `cq_control_weights_count_provisional_holdings` passes (line 4) | confirmed |
| PO-8: MC worst cells across four seed sets ≤ 0.992770; E1 margins +0.0023 / +0.0058 / +0.0074 / +0.0080 | 30001: 0.989299 (+0.004129); 30101: 0.991243 (+0.008136); 50001: 0.991452 (+0.008504) (`X-crit-mc-*`); fourth set not re-run | every worst cell ≤ 0.995 and < 0.992770; the MC − M1 margins move with the seed set as the sheet says (+0.0041 on 30001 vs the sheet's E1 values; report only, CQH2) |
| D9 audit 0 everywhere | 0 on every row of this round | reproduced |
| Keep re-taken within 3 days ≈ 2.7% p50 at 7 days [P1] (A-23) | 2.7% (thresholds seeds); 30% at 10k / 28 days | reproduced |
| Open risk: the human-mix campaign row does not move the map (OD-14) | `mapmove-gate` human mix on 1102–1106 FAILS: 10a 0/5, 10b 2/5, Marches 1/5, occupations 0/5, liberations 1/5 (`X-hc-gate7`) | still open (not a gate line) |

**No package number fails to reproduce in a way that changes a decision.** Two deviations are recorded: the Departs-per-bot-day cost is 0.182 (+15%) rather than +5 to +12% (the sheet's figure predates the symmetric keep), and the reported 3:1 human-mix row at 7 days is 5/10 rather than 6/10.

### 10.6 Open after the close (none is a Gate CQ1 line)

- OD-14: the human-mix campaign row stays below the 7-day floors (above). Unchanged open risk (CQI14).
- The `mc-weightmap` control passes 10e′ on 4/5 gate seeds and every 10h count; it fails overall on 10a, 10b, 10c and 10d. 10e′ alone does not separate the weight map from keeps.
- Campaign defence still never breaks a keep contest (`keep_contests_broken` 0; re-taken within 3 days 2.7% at 7 days). For CQ2-F before it ports the planner (§7).
- The 3:1 size stress at 7 days crosses 22% (5/10, 3/10; reported, PO-4). A member count in the faction picker is left to a later UI wave (optional).
- CQ2-F's field-equality test covers the E1 additions as W1C-B-sim-NOTES §7 lists them (occupation slot, hold rule, campaign-only rally stay, `train_v2`, `keep_tile_symmetric`; reference counters `McStats::dbg[11..=14]`).
- The ownership check's footprint lists `permutation-rules/src/frontier/mod.rs` on the design chat's side since `39ff369`: that is codex/frontier's rename commit `8c1b5ea` (a doc comment), not a design-chat edit; report-only.

### 10.7 Reproduce

```sh
cd .claude/worktrees/cq-integ
scripts/cq-regen.sh --check && scripts/cq-regen.sh --v1-unchanged "$(git merge-base HEAD codex/frontier)"   # the second differs in the WASM artefact only (A-13, A-27)
(cd frontier-sim && cargo run --release -- mapmove --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 10 --first-seed 2001 --json thresholds/mc-7d-1k.json)   # re-derivation (defining command)
(cd frontier-sim && cargo run --release -- mapmove --rules mc --policy campaign --agents 10000 --days 28 --seeds 10 --first-seed 2001 --gate-28d --json thresholds/mc-28d-10k.json)
# Gate CQ1: contract §12 v1.3 as written; package rows: the X-* commands in (session scratch)/scratchpad/cqclose/integ/*.rc
```
