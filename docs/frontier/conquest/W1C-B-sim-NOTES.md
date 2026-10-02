# W1C-B-sim: the decision-sheet package in the simulator (Wave-1 close)

- **Date:** 2026-10-02. **Unit:** W1C-B-sim of the Wave-1 close of MC "Contested Ground" (DECISIONS CQ-H; `OWNER-OPTIONS-W1.md` PO-1, PO-2, PO-3, PO-4, PO-5, PO-8).
- **Branch:** `frontier/cq-w1c-sim`, cut from `frontier/cq-integ` at `f1a5510`, worktree `.claude/worktrees/cq-w1c-sim`. Local commits only.
- **Owned paths:** `frontier-sim/**` and this file. No other file changed. No manifest, lockfile, toolchain or `.gitignore` change. No dependency request.
- **Commits:** `6ef7bcc` (code, tests and both re-derived thresholds files), `74a0a01` (rally stay limited to campaign factions again, §3.1), then these notes. Every figure below ran on a frozen release binary. `fs-c` is `6ef7bcc`. `fs-d` is the final code, which differs from `fs-c` only in rally stay for lone factions. Lines that can depend on that difference (lone or mixed policies: the doctrine lines, OD-16, the lone gate) were re-run on `fs-d`. Campaign-only lines are identical on both binaries: `--check` of both thresholds files reports no drift, and the 7-day gate tables are byte-identical. Their `fs-c` figures stand.
- **Logs:** `(session scratch)/scratchpad/cqclose/B-sim/` holds `<id>.log` and `<id>.rc` (exit code, wall seconds, command). The queue scripts are `q1.sh`…`q4.sh`.
- **Machine:** 16 cores, shared with the kernels unit's frontier-sim tests and builds. The load average reached 160, so wall times are inflated. No port was bound. No install and no download (`cargo --offline --locked`, own `CARGO_TARGET_DIR`s under `w1c-target/B-sim{,-node}`).

## 1. What changed in `frontier-sim`

The package is now the **default MC behaviour**. It is not behind scratch knobs. The experiment flags of E2/E3/P1 (`--planner`, `--e3`, `--alt-10e`, `--floor`, `--drop`, `--seeds-csv`, `--keep-sym`) were **not** ported. M1 paths are untouched.

| Item | Where | What |
|---|---|---|
| PO-1 (a), CQH1(1): occupation slot | `sim_campaign.rs` (`plan`), `mc.rs` `OCC_SLOTS = 1`, `config.rs` `occ_slots` | One campaign per faction is kept for a legal first holding to occupy. The weakest defence goes first, and the slot counts against `holding_slots`. This is E1's `18962c7`, unchanged. |
| PO-1 (a): hold rule | `sim_campaign.rs` `occ_retreat`, applied at group launch and to every host that joins an occupation strike later | `retreat_bps = clamp(10,000 × group ÷ own, 6,667, RETREAT_MAX_BPS = 60,000)`. |
| PO-1 (a): rally stay | `sim.rs` clash fates | Under MC, an arriving `Rally` host **of a campaign faction** stays while the target's MC siege is live or the campaign strike is pending. This is E1's rule. It is **not** P1's `stay=2` (every policy): see §3.1. |
| PO-1 (b), CQH1(1): 10e′ | `mapmove.rs` `net_movement_open`, gated figure `10e_net_movement_open` | The figure covers every province outside the heartlands that is open at bell 287 or opens later (by `end_bell − 1`). It compares the holder at `max(open, 287)` with the holder at `end_bell − 1`, and both must be factions. This is E2's strict reading (its laxer "first controller" variant was not ported). The floor is **0.06**, with `doubling` on. |
| Old 10e | `reported()` `net_movement_p2` | Contract v1.2's P₂-only 10e is reported in both thresholds files. It is no longer gated. |
| 7-day floors | `mapmove::floors_c10` | 10a **45**, 10c **0.13**, occupations **10**, liberations **1**. The rest are unchanged. The 2× rule (`doubling`) is kept for every map figure and every 10h count. |
| PO-3, CQH1(3): 28-day floors | `mapmove::floors_28d` | Banner changes **3.5** a day and Marches with ≥ 2 banners **0.10**. Largest ≤ 0.22, smallest ≥ 0.12 and days without a change ≤ 0.30 are unchanged. |
| PO-2, CQH1(2): K2 | `sim.rs` `send_at`, `w1c_shim.rs` | Under MC, the per-march variant surcharge is what the **MC train-cost table** charges above a Spearman for `k × 100` troops. The Horseman line pays 0. The table is a **marked shim** (§2). |
| PO-5, CQH1(5): symmetric keep | `sim_mc.rs` `keep_tile` | The keep tile is `keep::keep_tile_symmetric(terrain, sites, site_count, province wedge)`. This is the real kernel function, already in `permutation-rules`. |
| PO-8, CQH2: ceiling | `main.rs` `criterion --best-response`, `suite.rs` `CRITERION_MC_CEILING = 0.995` | Under `--rules mc`, `--gate` exits 1 if any cell is ≥ 1.0 (kept) **or the worst cell is > 0.995**. The command prints the worst cell to 6 decimals with its position. It then runs the M1 control on the same seeds and prints `MC − M1` (report only). |
| PO-4, CQH1(4): size stress | `main.rs` `--check-leader-max` | The existing ≥ 8/10 check prints "size stress check (PO-4, sizes …)" when the sizes are unequal. With equal sizes it still prints "coordination check (OD-16)". |
| Exploration overrides | `config.rs` `set_rules` | `--mc occ_slots=N,siege_hold=0,rally_stay=0` exist for attribution rows only. Like every `--mc` key, they set the preset to `custom`, so such a run drifts against the thresholds files. |
| Tests | `cq_close_tests.rs` (4), `w1c_shim.rs` (2), `mapmove.rs` (2), `cq_tests.rs` | The tests cover: the package defaults and overrides; the hold-rule formula; a 1k / 7-day `cq` season that plans, launches, holds and stays, then occupies ≥ 10 and liberates ≥ 1 with D9 0; every keep on the symmetric kernel tile; the K2 table (it equals the M1 per-march formula with the v1 table, and the Horseman pays 0); 10e′ on a hand-made series; the new floors; `net_movement_p2` in the 7-day file. |

`config.rs` still compiles inside `frontier-node/crates/agents/tests/profile_equality.rs`. `OCC_SLOTS` lives in `mc.rs` because that test compiles `mc.rs` as is.

## 2. Shim: the K2 train-cost table (until W1C-A merges)

`frontier-sim/src/w1c_shim.rs` contains `train_v2(unit: u8, n: u32) -> Option<Cost>`. It follows the kernels unit's work-in-progress table as `.claude/worktrees/cq-w1c-kernels` showed it during this unit (uncommitted there): `catalog::train_v2`, `TRAIN_PROD_COST_V2 = [6, 7, 6, 12, 14, 16, 10]`. Only the **Horseman line** costs a Spearman's ore and gold. **The Knight keeps its M1 cost**, and the Knight bound is `validate_table_v2`.

**At the merge, the integrator:**

1. Replaces `train_v2` in `march_surcharge_mc` with `permutation_rules::frontier::catalog::train_v2`. The signature is the same.
2. Deletes `w1c_shim.rs`, or keeps its two tests against the kernel function.
3. Removes `mod w1c_shim;` from `main.rs`.

If W1C-A's final table differs from `[6, 7, 6, 12, 14, 16, 10]`, the doctrine lines must be re-run. No Season-1 doctrine fields anything but the Spearman or Horseman line. So only the doctrine gate's **Knight negative control** depends on the Knight entry (rejected both ways, §5.2).

**Trial merge (scratch worktree, discarded).** W1C-A has since committed `c1d4fec` on `frontier/cq-w1c-kernels`, with the same `train_v2` signature and table. I merged it into this branch in a scratch worktree and pointed `march_surcharge_mc` at `catalog::train_v2`. The simulator builds; its only warning is the now-unused shim `train_v2`. `cq_k2_*`, `cq_keep_tile_is_the_symmetric_kernel`, `cq_occupation_objective_occupies_with_cq_bots` and `cq_thresholds_files_are_complete` pass. `mapmove … --check thresholds/mc-7d-1k.json` reports exactly one drift, `run.kernels` ("keep v1" → "keep v2"): every gated percentile and checked rate is unchanged. W1C-A touches no `frontier-sim` file.

**`KEEP_VERSION` becomes 2 with W1C-A.** `mapmove::describe` writes `kernels = "keep v{KEEP_VERSION} control v…"` into the thresholds files' `run` keys. On the merged tree, `mapmove --check` will therefore report a drift on `run.kernels` until the integrator re-derives both files (as planned). The keep-tile rule itself is already the kernel's `keep_tile_symmetric` here, so no figure should move from it.

## 3. Choices made inside the brief

### 3.1 Rally stay for campaign factions only (P1's `stay=2` not followed, measured reason)

The brief says to follow P1's rally stay for all policies unless there is a reason not to. I implemented it first (`6ef7bcc`, `fs-c`) and measured it. **It breaks the overnight doctrine band**, so the final code keeps E1's campaign-only rule:

| O-A, `doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --rules mc --policy lone --gate` | Exit | A | B | C | D | E | F | max \|Δ index\| |
|---|---|---|---|---|---|---|---|---|
| rally stay for every policy (`fs-c`, `OA-band-mc`) | **1** | 17.6 | 15.6 | 16.6 | 16.3 | **18.9** | 15.0 | 0.142% |
| rally stay off for lone factions (`fs-c --mc rally_stay=0`, `Y-band-mc-nostay`) | 0 | 17.0 | 15.5 | 17.3 | 16.6 | 16.5 | 17.1 | 0.102% |
| P1 `D03-band-K2-sym` (the sheet's [P1] "overnight 6/6, max \|Δ\| 0.102%") | 0 | 17.0 | 15.5 | 17.3 | 16.6 | 16.5 | 17.1 | 0.102% |

- In the doctrine runs every faction plays `lone`, so the second row is exactly the campaign-only rule. **It equals P1's band table to the printed digit.** So the sheet's 6/6 was measured without rally stay for lone factions, and K2 plus the symmetric keep reproduce it.
- With lone rally stay, E ends at 18.9% (band edge 18.67%, SE 1.0 point). Lone rally stay also moves the lone and mixed 7-day rows: the lone gate's 10a p10 is 278.4 with it and 286 without; OD-16 passes 10/10 either way.
- P1's own evidence that `stay=2` is neutral was `L01` against `L02` (the lone 7-day gate, byte-identical). On this branch the same comparison is **not** identical, so the `fs-p1b` binary those two runs used probably did not contain the `stay=2` path. P1 measured nothing else with `stay=2`.

Why this is inside the brief:

- The package the owner approved was measured with campaign-only stay (§6).
- The defect being fixed is the campaign strike's. Lone rally hosts behave as they did in every measurement since CQ1-B.
- No flag turns the stay on for lone factions. `--mc rally_stay=0` turns it off for campaigns too (exploration only).

If the owner wants lone rallies fixed too, that is a change to the measured package: the doctrine band would have to be re-tuned. This unit did not do that, and it needs no owner decision now.

### 3.2 Names

- The gated 10e′ is `10e_net_movement_open`.
- The old 10e is reported as `net_movement_p2`.
- The criterion ceiling is `suite::CRITERION_MC_CEILING`.

The contract unit should use these names in v1.3 §12/§13.4, or ask for a rename before the integrator re-derives.

### 3.3 The 3:1 rows at 7 days exit 1 when they carry `--check-leader-max`

I added the check to the reported 3:1 rows so the count is printed. Those rows are **reported** (PO-4), so the gate text should not treat their exit code as gating. Either leave them without the flag, as the v1.2 line did, or mark them report-only.

## 4. Gate CQ1 lines on my files (amended by the sheet)

"Exit" is the command's own exit code. Rows marked (d) ran on the final code (`74a0a01`, `fs-d`). The others ran on `6ef7bcc` (`fs-c`) and are campaign-only, so the two binaries give the same output (see the Commits line of the header).

| Line | Exit | Result |
|---|---|---|
| (d) `frontier-sim`: `cargo fmt -- --check && cargo clippy --locked --release --all-targets -- -D warnings && cargo test --locked --release` | 0 | **56 + 4 passed**, 0 failed (750 s; 1,217 s on `6ef7bcc`). This includes `cq_m1_rules_keep_the_cq0_digest` (the M1 digest is unchanged) and the release-only M1 doctrine tests. |
| (d) `frontier-node`: `cargo test --locked -p agents --test profile_equality` | 0 | 12 passed |
| `criterion --best-response --seeds 3 --first-seed 30001 --gate` (M1) | 0 | worst **0.985170**, unchanged |
| (d) `doctrine-gate --controls` (M1) | 0 | **Unchanged** from integ-W1 round 2: max \|Δ index\| 0.060%, 4/6 in the proxy band. The draft (−1.319%), Knight (F −0.242%) and A-boost (+0.326%) controls are rejected. |
| `criterion … --rules mc --policy campaign --gate` (30001) | 0 | worst **0.989299** ≤ 0.995 (1%, day 0, stake, bots in office). M1 control on the same seeds is 0.985170, so **MC − M1 = +0.004129** (reported). |
| (d) `doctrine-gate --set kernel --rules mc --controls` (CI proxy) | 0 | **max \|Δ index\| 0.106%** (≤ 0.2%). Win rates are A 14.4, B 16.7, C 19.7, D 17.5, E 15.8 and F 15.8%, the same table as P1's `D02-ci-K2-sym`. Four of six are within 16.7 ± 2 at 360 seasons (SE 2.0 points); this CI gate is the index bound. The draft (−2.872%), Knight (A −1.345%) and A-boost (+0.502%) controls are rejected. |
| `mapmove … --bot-profile cq … --check thresholds/mc-7d-1k.json` | 0 | no drift |
| `mapmove-gate … --bot-profile cq … --seeds 5 --first-seed 1101 --controls` | 0 | **PASS: every figure 5/5.** The `m1/lone` control FAILS. The `mc-weightmap` control FAILS: 10a, 10b and both 10d figures pass on 0/5 seeds and 10c on 3/5, but it **passes 10e′ (4/5), 10f (4/5) and every 10h count (5/5)**. |
| `mapmove … --bot-profile m1` (reported) | 0 | 10a p10/p50 129.8/138.5, 10c 0.431/0.456, 10e′ 0.208/0.221, occupations 40.8/43, 0.297 Departs per bot-day. Its `mapmove-gate` on 1101 PASSES 5/5. |
| `--keep-aggr 0.25 / 0.5 / 1.0` (human mix, reported) | 0 | 10a p50 35.5 / 40 / 46; 10e′ p50 0.094 / 0.098 / 0.115; occupations p50 32.5 / 33 / 34 |
| `--sizes 3,1,1,1,1,1` campaign, human mix (reported, PO-4) | 1 (check) | faction 0 Q1 → end p50 0.179 → 0.219; ≤ 22% on **5/10** |
| (d) `--policy campaign:0,lone:1-5 --check-leader-max 0.22` (OD-16) | 0 | **PASS 10/10**; campaign faction Q1 → end p50 0.130 → 0.070 |
| `--forward` (reported) | 0 | 10a p50 35.5; 10e′ 0.094 |
| (d) `doctrine-gate --set kernel --rules mc,bannerdom --controls --report-only` | 0 (report-only) | verdict PASS: max \|Δ\| 0.111%; win rates A 14.2, B 16.1, C 20.0, D 17.8, E 14.7, F 17.2%. Against the line above, OD-14's banner-hour Dominion shifts each doctrine's Δ index by 0.003–0.044 points (about one standard error at 360 seasons). It neither repairs nor breaks the gate. The draft (−3.101%), Knight (−1.457%) and A-boost (+0.498%) controls are rejected. |
| **New, PO-4 gated:** `mapmove --rules mc --policy campaign --sizes 2,1,1,1,1,1 --agents 1000 --days 7 --seeds 10 --first-seed 2001 --check-leader-max 0.22` (human mix) | 0 | **PASS 10/10**; end p50 0.188 |
| **New, PO-4 gated:** the same with `--bot-profile cq --bots 0.99` | 0 | **PASS 9/10**; end p50 0.206 |
| New, PO-4 reported: 3:1 with `cq` bots | 1 (check) | ≤ 22% on **3/10**; end p50 0.223 |
| (d) Overnight O-A: `doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --rules mc --policy lone --gate` | 0 | **6/6 in the band**: A 17.0, B 15.5, C 17.3, D 16.6, E 16.5, F 17.1%; max \|Δ index\| 0.102%; 1,500/1,500 conserve (3,229 s). The table is identical to P1's `D03-band-K2-sym`. On `fs-c` (lone rally stay) it was 5/6 and exit 1 (§3.1). |
| Overnight O-B: `mapmove-gate --rules mc --policy campaign --agents 10000 --days 28 --seeds 4 --first-seed 1101 --thresholds thresholds/mc-28d-10k.json --controls` | 0 | **PASS 4/4 on every figure**: banners a day 4.93–5.75, Marches 0.148–0.164, largest ≤ 0.173, smallest ≥ 0.159. **Both controls FAIL**: `m1/lone` fails banners, Marches and quiet days 0/4; `mc-weightmap` fails banners and Marches 0/4. |
| **New, PO-4 gated at 28 d:** `mapmove --rules mc --policy campaign --sizes 2,1,1,1,1,1 --agents 10000 --days 28 --seeds 10 --first-seed 2001 --gate-28d --check-leader-max 0.22` | 0 | **PASS 10/10**; end p50 0.189 |
| **New, PO-4 gated at 28 d:** the same with `--sizes 3,1,1,1,1,1` | 0 | **PASS 10/10**; end p50 0.200 (Q1 0.204). The run's own Marches p10 is 0.095 (p50 0.102): below the 0.10 floor at p10, but this line gates only the size check. |
| `mapmove … --agents 10000 --days 28 … --gate-28d --check thresholds/mc-28d-10k.json` | 0 | no drift |

Exploration rows (not gate lines):

- `mapmove-gate` `cq` PASSES on 10002–10021 (20/20 seeds on every figure), 13002–13021 and 6102–6106. Both controls FAIL on each.
- `mapmove-gate` with the `m1` profile PASSES on 10002–10021 (controls FAIL).
- (d) The lone human mix PASSES on 1102–1106 (10a p10 286, occupations p10 24.8, liberations ≥ 1 on 4/5 seeds).
- **The human-mix campaign gate FAILS on 1102–1106**: 10a 0/5, 10b 2/5, Marches 1/5, occupations 0/5, liberations 1/5. This is the sheet's known open risk (OD-14). It is not a gate line.
- The 28-day gate on 9102–9105 PASSES 4/4. Controls: `m1/lone` fails; `mc-weightmap` fails Marches 0/4 but passes banners on 2/4. As the sheet says, the Marches figure is the one that rejects it.

## 5. Measurements next to the floors

### 5.1 `thresholds/mc-7d-1k.json` (cq, 1,000 agents, 99% bots, 7 days, seeds 2002–2011; re-derived by its defining command)

| Figure | Floor | p10 | p50 | p90 | p10 ÷ floor | 2× rule |
|---|---|---|---|---|---|---|
| 10a lasting changes | 45 | 98.4 | 108.5 | 117.1 | 2.19 | yes |
| 10b days 2–7 | 6 | 6 | 6 | 6 | – | fixed |
| 10c ≥ 2 controllers | 0.13 | 0.289 | 0.311 | 0.357 | 2.22 | yes |
| 10d banner changes | 6 | 52.6 | 58.5 | 65.1 | 8.8 | yes |
| 10d Marches ≥ 2 banners | 0.10 | 0.250 | 0.288 | 0.321 | 2.50 | yes |
| **10e′ net movement (open ≥ 287)** | 0.06 | 0.150 | 0.166 | 0.192 | 2.50 | yes |
| 10f breadth | 4 | 6 | 6 | 6 | – | fixed |
| 10g largest / smallest | ≤ 0.30 / ≥ 0.08 | 0.177 / 0.146 | 0.182 / 0.154 | 0.189 / 0.158 | – | fixed |
| 10h declared / completed / failed | 20 / 10 / 3 | 110.7 / 94.9 / 13 | 125.5 / 105.5 / 17 | | 5.5 / 9.5 / 4.3 | yes |
| **10h occupations / liberations** | 10 / 1 | **39.5 / 25.9** | 42 / 29 | 46.3 / 31 | 3.95 / 25.9 | yes |
| 10h captures / outposts | 5 / 10 | 55.6 / 1,676 | 63 / 1,701 | | 11 / 168 | yes |
| 10i D9 transfers | 0 | 0 | 0 | 0 | – | – |

**Every p10 is ≥ 2 × its floor.**

The p10/floor ratios over the gate sets are:

| Seed set | 10a | 10c | 10e′ | occupations |
|---|---|---|---|---|
| 1102–1106 | 2.21 | 2.44 | 2.37 | 3.84 |
| 10002–10021 | 2.12 | 2.30 | 2.30 | 3.68 |
| 13002–13021 | 2.13 | 2.22 | 2.17 | 3.40 |
| 6102–6106 | 2.05 | 2.08 | 2.57 | 3.64 |

Reported p50 values:

- `net_movement_p2` (old 10e): 0.110 (p10 0.074).
- Departs per bot-day: **0.182** (was 0.158; +15%. The sheet's +5 to +12% is E1 without the symmetric keep).
- Keep marches: 0.042. Keep captures: 0.016. Declares: 0.018 per bot-day.
- Keeps taken: 15.5 a day, re-taken within 3 days 2.7%. Campaign defence still never breaks a keep contest (`keep_contests_broken` 0).

### 5.2 `thresholds/mc-28d-10k.json` (campaign, 5% sim bots, 10,000 agents, 28 days, seeds 2002–2011)

| Figure | Floor | p10 | p50 | p90 |
|---|---|---|---|---|
| banner changes a day | ≥ 3.5 | 4.78 | 5.14 | 5.38 |
| Marches ≥ 2 banners | ≥ 0.10 | 0.132 | 0.145 | 0.155 |
| largest / smallest share | ≤ 0.22 / ≥ 0.12 | 0.169 / 0.161 | 0.171 / 0.161 | 0.174 / 0.164 |
| days without a banner change | ≤ 0.30 | 0.035 | 0.077 | 0.115 |

Margins at p10 are 1.37× (banners) and 1.32× (Marches). The 28-day file has no 2× rule.

Reported p50 values: keeps taken 17.2 a day, re-taken within 3 days 30%, 1.39 Departs per bot-day (sim profile), `net_movement_p2` 0.038.

Keep interest at 28 d: banners p50 3.59 / 4.46 / 5.14 a day and Marches 0.119 / 0.133 / 0.145 at `--keep-aggr` 0.25 / 0.5 / 1.0. **At 0.25 the banner p10 (3.10) is below the 3.5 floor.** That row is reported, not gated.

### 5.3 Doctrine band and criterion

The figures are in §4: O-A 6/6, the CI proxy 0.106%, and the criterion ceiling with MC − M1 on three seed sets (§6). The MC worst cell sits at the same position on every set (bots in office, 1%, day 0, stake), as in round 2.

## 6. P1 reproduction ([P1] numbers of the sheet)

| Sheet figure [P1] | This unit | Verdict |
|---|---|---|
| Thresholds 10a p10 93.8 → 98.4 with the symmetric keep | 98.4; per-seed figures identical to P1's `S01-T-cq-sym` | **reproduced** |
| cq gate PASS on 1102–1106, 10002–10021, 13002–13021, 6102–6106; both controls FAIL | the same | **reproduced** |
| p10/floor 10a 2.08–2.17×, 10c 2.13–2.22×, 10e′ 2.37–2.63×, occupations ≥ 3.4× | 10a 2.05–2.21×, 10c 2.08–2.44×, 10e′ 2.17–2.57×, occupations 3.40–3.84× | **all ≥ 2×**; at the edges the ranges differ slightly. P1 quoted most map rows without the symmetric keep. |
| m1 profile PASS 20/20 | PASS 20/20 (10002–10021) | reproduced |
| 28-day gate PASS 4/4 on 1101 and 9101, with the symmetric keep; weightmap control fails Marches 0/4 | PASS 4/4 on both; weightmap Marches 0/4 on both | reproduced |
| 2:1 at 7 d with E1: 10/10 and 9/10 | 10/10 (human mix), 9/10 (cq) | reproduced |
| 3:1 at 7 d: 6/10 and 3/10 | 5/10 (human mix), 3/10 (cq) | human mix one seed lower; reported row |
| 3:1 at 28 d: 10/10, end p50 0.202 | 10/10, end p50 0.200 | reproduced |
| PO-8 E1 margins; MC worst cells ≤ 0.992770 | 30001: 0.989299 (= P1 `C05` with sym, to 6 decimals), M1 0.985170, **+0.004129**; 30101: 0.991243, M1 0.983107, +0.008136; 50001: 0.991452, M1 0.982948, +0.008504 | every cell < 1.0 and **every worst cell ≤ 0.995**; MC − M1 is reported only (CQH2) |
| K2 + symmetric keep: overnight 6/6, max \|Δ\| 0.102% | 6/6, max 0.102%; the table is identical to P1's `D03` | **reproduced** with campaign-only rally stay. With rally stay for lone factions too, the band is 5/6 (§3.1). |
| K2 CI proxy with the symmetric keep (P1 `D02`: 4/6 win rates, max 0.106%); A-boost control +0.502% (`D04`) | the same table; A boost +0.502% | reproduced. The Knight control differs: −1.345% here against −1.889% in P1, because the Knight keeps its M1 cost here and P1 zeroed every line. It is rejected either way. |

## 7. For CQ2-F (§8.6, §8.7 item 6: field equality)

CQ2-F's `agents::campaign` port must mirror the following, and its field-equality test should compare them:

1. **The occupation slot.** `occ_slots = 1` per faction. Its candidates are first holdings (`order ≤ 1`, not a Free City) in the planner's legal candidate list: `mc_target_legal` (may_besiege v3: outside the heartlands, unshielded, not Frontier-protected; record free; `can_complete_before` at plan time) and not dormant. They are taken in the planner's candidate order (value ÷ estimated defence, ties by target). The slot is filled only when the faction has fewer live occupation campaigns than `occ_slots`. Occupation picks count toward `holding_slots`; the player-holding fill then skips targets already picked.
2. **The hold rule.**
   - On launch, every host of an occupation strike group gets `retreat_bps = clamp(10,000 × Σ group ÷ own, 6,667, 60,000)`.
   - A host that joins a live occupation strike later gets the same, with group = the live hosts' troops + its own.
   - Other strikes keep the profile's retreat draw (6,667 with probability q).
3. **Rally stay (campaign factions only, §3.1).** An arriving rally host of a campaign faction stays on the hex while the target's MC siege is live or a campaign strike on it is pending. `pending[t] = max(arrival + 6)` over that strike's dispatches. Lone factions' rally hosts still go home on arrival under MC.
4. **K2.** Bots price training with `catalog::train_v2` under MC.
5. **The keep tile.** `keep_tile_symmetric(…, wedge)` wherever the planner reads a keep tile.
6. **Unchanged from v1.2 (A-6):** plan-time `TooLate` and D-6/D-7.

The simulator's debug counters `McStats::dbg[11..=14]` (plan fills with a legal first holding, occupation campaigns added, occupation groups launched, rally stays) can serve as the reference counts for that test (`FRONTIER_SIM_DEBUG=1`).

## 8. Open points (none needs the owner)

- The shim (§2) and the `kernels` run key (§2) go with the integrator's merge and re-derivation.
- The human-mix campaign row still does not move the map enough (10a p50 35–46 < 45 at every keep interest). The sheet already lists this as an open risk (OD-14). It is not a gate line.
- The `mc-weightmap` control passes 10e′ on 4/5 gate seeds (§4). The control still fails overall on 10a, 10b and 10d. 10e′ alone does not separate the weight map from keeps.

## 9. Reproduce

```sh
cd .claude/worktrees/cq-w1c-sim/frontier-sim
cargo run --release -- mapmove --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 10 --first-seed 2001 --check thresholds/mc-7d-1k.json
cargo run --release -- mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json --controls
cargo run --release -- mapmove --rules mc --policy campaign --sizes 2,1,1,1,1,1 --agents 1000 --days 7 --seeds 10 --first-seed 2001 --check-leader-max 0.22
cargo run --release -- mapmove --rules mc --policy campaign --bot-profile cq --bots 0.99 --sizes 2,1,1,1,1,1 --agents 1000 --days 7 --seeds 10 --first-seed 2001 --check-leader-max 0.22
cargo run --release -- criterion --best-response --seeds 3 --first-seed 30001 --rules mc --policy campaign --gate
cargo run --release -- mapmove-gate --rules mc --policy campaign --agents 10000 --days 28 --seeds 4 --first-seed 1101 --thresholds thresholds/mc-28d-10k.json --controls
for s in 2 3; do cargo run --release -- mapmove --rules mc --policy campaign --sizes $s,1,1,1,1,1 --agents 10000 --days 28 --seeds 10 --first-seed 2001 --gate-28d --check-leader-max 0.22; done
cargo run --release -- doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --rules mc --policy lone --gate
# attribution: P1's lone-policy behaviour (no rally stay)
cargo run --release -- doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --rules mc --policy lone --gate --mc rally_stay=0
```
