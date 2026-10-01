# CQ1-B sim-conquest: notes

> **Integrator's note (integ-W1, 2026-10-01): the figures below are CQ1-B's, measured on its mirror kernels at `136f972`.** Since then the simulator runs on the CQ1-A kernels (`9c9974d`), and after the wave-1 review on the remaining kernels with the plan-time `TooLate` check, an independent D9 audit and the drift-checked bot rates (`5d0858a`, thresholds re-derived in `8cc6395`). **The current figures are in `integ-CQ1-NOTES.md` §3–§4** (for example thresholds p10 10a 92.8 and 10e 0.061, criterion worst cell from the re-run there), not in the tables below. Deviation **D-8** (added by the integrator): when a keep is taken, the taking faction's other hosts on the keep tile go home (one stays with `--forward`), where K-19 / §3.2 step 5 say "other hosts stay"; `--keep-stay` measures K-19's reading (integ-CQ1-NOTES §4.3). The `cq` profile's cadence: military decisions per hourly epoch, economy, defence and outposts at M1's session cadence (the thresholds file's `note`).

- **Unit:** CQ1-B (wave 1, CONQUEST-CONTRACT v1.1 §11). Branch `frontier/cq-1b-sim`, cut from `frontier/cq-integ` at **`39ff369`** (= CQ0 for this wave; the gate preamble's `d11d058` is the docs-only parent).
- **Owned paths touched:** `frontier-sim/**`, this file. **One file outside ownership:** `permutation-rules/src/frontier/clash.rs` (a build shim, its own commit, see "Deviations" D-1). No manifest, lockfile, toolchain or `.gitignore` change.
- **Status of every number:** [sim]. The simulator's player behaviour is an assumption (`frontier-sim/src/model.rs`, and the planner port in `src/sim_campaign.rs`). Every run below is deterministic (`--check` reproduces bit for bit on any thread count).
- **Owner decisions:** OD-1…OD-16 are the contract's working defaults (§15), not owner approvals. This unit built to them and measured OD-14, OD-15 and OD-16.

## 0. Answer first (what the wave note asked)

1. **Keeps make the faction map move, with the realistic profile too.** With `--bot-profile cq` (the stack's cadence: one decision per bot per hourly planner epoch, attacks only from the campaign plan), 1,000 agents, 99% bots, 7 days, seeds 2002–2011: **104 lasting province changes (p10 97), 59 March banner changes (p10 48), 31% of the population P had two controllers, 29% of Marches flew two banners, every day 2–7 had a lasting change, all six factions both gained and lost**. The holding-weight map does not move (both negative controls fail, §2).
2. **`mapmove-gate` with `--bot-profile cq`: FAIL.** The map figures 10a–10d, 10f, 10g pass on 5/5 seeds; three figures fail:
   - **10e net movement** (control at `end_bell − 1` vs bell 287): 0.079–0.091 on the gate seeds 1102–1106 against the 10% floor (0/5 seeds). Over the 10 threshold seeds p50 is 0.110, p10 0.067. The map moves on the borders and back (§3.2's expectation) but the week's net change sits just under the floor.
   - **10h occupations** (floor 3): 0–1 per season; **10h liberations** (floor 1): 0–1. The cq planner rarely besieges a first holding (0–7 declarations a season: its holding slot prefers holdings 2–3 and Free Cities, value 1.5 vs 1.0), and about half of those sieges fail when the besiegers retreat under the garrison's retaliation (§4.4).
   - **Both negative controls FAIL as required** (`--rules m1 --policy lone`: 0–2 lasting changes, 0 banner changes; `--rules mc-weightmap --policy campaign`: 0–1 lasting changes, 0 banner changes).
3. **"p10 ≥ 2 × every floor" (Gate CQ1): not met.** It holds for 10d (both rows) and for 10h declared, completed, failed, captures and outposts. It fails for **10a** (p10 97.4 < 120), **10c** (0.289 < 0.30), **10e** (0.067 < 0.20), **10h occupations** (0 < 6) and **liberations** (0 < 2). Per §12, "the rules or floors are amended before CQ2, never after": this is an integrator/owner decision; §6 gives the tuning rows the gate rule names.
4. **Bot activity (R-11).** Departs per bot-day: **cq 0.136**, **m1 0.258** (calibrated to M1's measured 0.24), sim-profile bots under the campaign plan 0.38, sim-profile lone bots (the balance lab's bot row) 4.2. **The stack-cadence planner is less active than M1's stack bots were**, so the m1 row (cq plan plus unplanned lone rolls at M1's rate) moves the map *more* than cq: 139 lasting changes, 10e 0.32. The thresholds file is derived from cq as the contract says.
5. **OD-16 coordination check: PASS** (`campaign:0,lone:1-5`, human mix): the campaign faction ends at 8.0% of provinces (p50; ≤ 22% on 10/10 seeds) and *falls* from 13.0% at Q1; lone factions take far more keeps. With cq bots in all factions the lone factions' bots never attack (cq bots act only on a plan), the campaign faction ends at 20.2% (10/10 ≤ 22%).
   **But the 3:1:1:1:1:1 size stress crosses 22%:** the three-times faction ends at 22.1% (human mix, campaign), 22.7% (cq bots) and 22.6% (lone) at p50, ≤ 22% on only 4/10, 4/10 and 2/10 seeds, rising from Q1 (17.9–20.9%). The balance lab's lone keep model gave 21.2% for this cell. This is size, not coordination (lone shows it too), but it crosses the contract's 22% line, so **the integrator should put it to the owner with OD-16 before Wave 2** (§5.3).
6. **The v1.1 rule package moves the map more than the balance lab's K-01 package** in every cand.md cell (lone players, same seeds): 1k/7d 10.5 vs 8.2 March changes a day, 59% vs 36% of provinces ever changed; 10k/28d 34.5 vs 12.8, with more ping-pong at 28 days (69% vs 45% re-taken within 3 days) and the 3:1 faction at 23.5% (worst seed 25.6%) vs 21.2% at 1k/7d (§3). The main cause is the v1.1 keep: no declaration, so the defenders' standing order now fires at the first counted bell (KEEP_CONTEST) instead of at the attacker's departure as in the lab.
7. **The doctrine CI proxy FAILS on the MC rules** (A +0.313%, B −0.406%, F −0.304% against ±0.2%; 2 of 6 in the band), confirmed on fresh seeds by the reduced overnight run (2 of 6). The M1 rules still pass. Ablations point at the MC holding contest, not at the keeps (§5.1). `bannerdom` (OD-14) changes nothing material. **The bot best-response criterion passes** on MC with campaigns (worst cell 0.989 vs the M1 control 0.985, inside +0.005). The 10k/28d `mapmove-gate` (campaign policy) FAILS narrowly (banner changes a day 3/4 seeds, Marches with two banners 2/4).

## 1. What landed

| Item (§8.7, §11) | Where | Notes |
|---|---|---|
| `--rules m1\|mc\|mc-weightmap[,bannerdom[=N]][,keepdom]`, `--preset` | `src/mc.rs`, `src/config.rs`, `src/main.rs` | default `m1` = CQ0's simulator bit for bit (test `cq_m1_rules_keep_the_cq0_digest`; `run` reports for 3 configurations byte-identical to a CQ0 build) |
| `--rules mc` = §3 with the v1.1 rules | `src/sim_mc.rs` | keeps and the contest (§3.2) with the donor handoff (K-19, R-01: largest host, 50%, donor home, remainder < 100 joins, troops ≤ 30,000 asserted); sieges declared from the hex by the lead host's owner (K-04, K-24); 500 Gold stake from the source holding; ≤ 2 declarations a day (K-20); slots 2–3 reserved at the horn (K-25), released on failure and at the season end; faction-scoped post-siege immunity and Respite (K-06, K-09, R-05); capture credit (K-26: held ≥ 144 / 288 bells, else no Dominion and stores zeroed); capture effects (garrison 0, walls halved unless F Iron); genesis Free Cities from ring 4 (§3.7); released homes become free sites (R-07, R-14), never under a live record (S3); outposts (§3.8: ring > 3, within 3 provinces, faction < 50% of the province's strength weight, Town, 20% land gate, closes at `end_bell − 24`); Frontier-7 / Frontier-28 / MC_TEST timers; Dominion folded hourly as points with the strict controller (§3.10), `bannerdom` (OD-14) and `keepdom` variants; the season end (open sieges lapse, stakes and slots back). No laurel share for occupation and no capture transfer under MC (K-16) |
| launch-floor fix under `mc` | `src/sim_campaign.rs` (`mc_war_lone`) | a siege host is ≥ 100 troops |
| `--policy lone\|campaign\|campaign:0,lone:1-5` | `src/sim_campaign.rs` | the §8.6 planner ported (§4) |
| `--bot-profile sim\|cq\|m1`, `--m1-act-p` | `src/mc.rs`, `src/sim_campaign.rs` | R-11 (§4.3) |
| `--keep-aggr`, `--forward`, `--days`, `--sizes` | | `--days N`: 60% join on day 0, the rest on days 1…min(21, N − 2) (deviation D-4) |
| `mapmove` (`--json`, `--check`, `--check-leader-max`, `--gate-28d`) and `mapmove-gate` (`--thresholds`, `--controls`) | `src/mapmove.rs` | criterion 10's figures from the per-bell control series (§13.4), p10/p50/p90 (linear interpolation), the 10k/28d gate's figures |
| `thresholds/mc-7d-1k.json`, `thresholds/mc-28d-10k.json` | `frontier-sim/thresholds/` | exactly the `--json` output of their defining runs (§2.1) |
| doctrine and criterion on `mc` | `src/balance.rs` (`gate_run_base`), `src/main.rs` | `doctrine-gate` and `criterion` run on the configured rules |
| the balance lab's `--cq` levers and `conquest` / `curve` commands | `src/conquest.rs` | kept so `out/cand.md` reproduces exactly (it does, §3) |
| tests `cq_*` | `src/mc.rs`, `src/mapmove.rs`, `src/cq_tests.rs` | 20 tests: keep contest, donor, cap, heartland, strict controller, capture credit, occupation end, vigil bound, lasting changes, banner changes, percentiles and JSON, CQ0 digest, an MC season's invariants (D9, slots, reservations, keep cap, no clash refused, conservation), campaign determinism, holding-weight maps vs keeps, 7-day joins, presets = §3.12, thresholds files complete, `--policy` parsing |
| `--threads` / `FRONTIER_SIM_THREADS` | every parallel runner | the machine was shared; runs used 3–6 threads |

## 2. The criterion-10 figures and the thresholds

### 2.1 `thresholds/mc-7d-1k.json` (`--bot-profile cq`, 1,000 agents, 99% bots, 7 days, seeds 2002–2011)

Defining command (Gate CQ1's `--check` line with `--json` instead of `--check`):
`frontier-sim mapmove --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 10 --first-seed 2001 --json thresholds/mc-7d-1k.json`

| figure | floor (§13.4, gated) | p10 | p50 | p90 | ½ × p10 (reported) | p10 ≥ 2 × floor |
|---|---|---|---|---|---|---|
| 10a lasting changes | ≥ 60 | 97.4 | 104 | 110.7 | 48.7 | **no** |
| 10b days 2–7 with a lasting change | 6 of 6 | 6 | 6 | 6 | 3 | n.a. (fixed) |
| 10c share of P with ≥ 2 controllers | ≥ 15% | 28.9% | 31.1% | 35.7% | 14.4% | **no** (0.289 < 0.30) |
| 10d banner changes | ≥ 6 | 47.8 | 59 | 72.7 | 23.9 | yes |
| 10d Marches with ≥ 2 banners | ≥ 10% | 24.4% | 28.8% | 33.5% | 12.2% | yes |
| 10e net movement (P₂, bell 287 → `end_bell − 1`) | ≥ 10% | 6.7% | 11.0% | 12.3% | 3.3% | **no** |
| 10f factions with a gain and a loss | ≥ 4 | 6 | 6 | 6 | 3 | n.a. (fixed) |
| 10g largest share at `end_bell − 1` | ≤ 30% | 17.5% | 17.7% | 18.2% | – | n.a. (fixed) |
| 10g smallest share | ≥ 8% | 14.9% | 15.4% | 16.0% | 7.5% | n.a. (fixed) |
| 10h sieges declared | ≥ 20 | 122.7 | 136.5 | 142.5 | 61.4 | yes |
| 10h sieges completed | ≥ 10 | 81.4 | 95.5 | 104.1 | 40.7 | yes |
| 10h sieges failed | ≥ 3 | 35.9 | 41 | 45.1 | 18.0 | yes |
| 10h occupations | ≥ 3 | 0 | 0 | 1 | 0 | **no** |
| 10h liberations | ≥ 1 | 0 | 0 | 1 | 0 | **no** |
| 10h captures (holdings 2–3 and Free Cities) | ≥ 5 | 80.4 | 95.5 | 104.1 | 40.2 | yes |
| 10h outposts founded | ≥ 10 | 1,669 | 1,695 | 1,707 | 834 | yes |
| 10i first holdings that changed owner | 0 | 0 | 0 | 0 | – | n.a. |

Reported in the same file (p50): keeps taken 14.9 a day; **Departs 0.136, keep marches 0.032, keep captures 0.015, DeclareSieges 0.020 per bot-day** (the §8.8 bot-activity gate's reference: the nightlies and the rehearsal fail below 50% of these); re-taken by the previous holder within 3 days 1%; homes released 0 (Frontier-7 releases none, R-14).

Population and definitions as §13.4: P = rings > `heartland_max_ring` (3) opened by bell 144; P₂ by bell 288. 10e counts a province that a faction controls at both bells (with keeps that is every province; for the holding-weight controls a first claim of empty land is not movement). "Lasting" = the new faction holds bells b … b + 5 (or to `end_bell − 1`).

### 2.2 `mapmove-gate` with `--bot-profile cq` (Gate CQ1 line; seeds 1102–1106)

`frontier-sim mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json --controls` → **exit 1**.

| | MC rules | control `--rules m1 --policy lone` | control `--rules mc-weightmap --policy campaign` |
|---|---|---|---|
| verdict | **FAIL** (10e 0/5, occupations 0/5, liberations 2/5; every other figure 5/5) | **FAIL, as it must** (fails 10a–10f, 10h) | **FAIL, as it must** (fails 10a, 10b, 10d, 10f, occupations, liberations; 10c 3/5, 10e 4/5) |
| 10a lasting changes, p50 | 105 | 1 | 1 |
| 10d banner changes, p50 | 54 | 0 | 0 |
| 10e net movement, p50 | 0.091 | 0 | 0.116 |
| 10h sieges / completed / occupations, p50 | 135 / 102 / 1 | 0 / 0 / 0 | 199 / 134 / 0 |

Note: under `--rules m1` the bot profile does not apply (the M1 code path is unchanged), so the control is the M1 simulator's lone play at 99% bots: its sieges need 5 laurels and an M0-sized host and almost never happen in 7 days (the balance lab's M0 row: 0.1 captures and occupations a day). The holding-weight control does play the MC holding contest (199 sieges) and still does not move the map.

### 2.3 `thresholds/mc-28d-10k.json` (10,000 agents, 28 days, `--policy campaign`, 5% sim-profile bots, seeds 2002–2011)

`frontier-sim mapmove --rules mc --policy campaign --agents 10000 --days 28 --seeds 10 --first-seed 2001 --gate-28d --json thresholds/mc-28d-10k.json`

| figure (§8.7 item 4) | floor | p10 | p50 | p90 |
|---|---|---|---|---|
| March banner changes a day | ≥ 5 | 4.37 | 4.91 | 5.60 |
| Marches with ≥ 2 banners | ≥ 15% | 14.1% | 15.4% | 16.4% |
| largest faction at the end | ≤ 22% | 16.9% | 17.0% | 17.3% |
| smallest faction at the end | ≥ 12% | 16.0% | 16.2% | 16.4% |
| days (3–28) without a banner change | ≤ 30% | 3.8% | 11.5% | 15.8% |

The campaign policy sits on the 10k/28d floors (p50 4.91 vs 5 banner changes a day): the overnight `mapmove-gate` line (4 seeds 1102–1105) is in §5. With lone players the same cell gives far more (§3). Reported (p50): keeps taken 17.6 a day, re-taken within 3 days 29%, Departs 1.54 per bot-day (sim profile), **homes released 1,451 per 10k season (casual 144)**, nearly all from idle wallets after 10 days (R-14's count for Frontier-28; Frontier-7 releases none).

## 3. The K-01 package against the balance lab (`out/cand.md`)

The `conquest` sweep, cand.md's seeds and columns (1k cells 8 seeds from 1101, 10k cells 4 seeds), lone players, human mix unless stated. **"R (lab)" reproduces cand.md's `g100,sh288` row exactly in every cell** (the lab levers are kept); "mc v1.1" is `--rules mc --policy lone`.

| cell | config | March changes / day | Marches ever changed | province flips / day | provinces ever changed | changed vs 7 d before | keep captures / day | holding captures + occupations / day | re-taken < 3 d | max share at end (worst seed) | faction 0 Q1 → mid → end | days w/o March flip |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1k / 7 d | M0 | 0.1 | 1% | 0.1 | 0% | – | 0.0 | 0.1 | – | 17.0% (17.3%) | 16.7 → 16.7 → 16.6 | 88% |
| | R (lab) | 8.2 | 42% | 27.8 | 36% | – | 28.2 | 5.8 | 42% | 18.0% (18.6%) | 17.1 → 15.7 → 16.9 | 22% |
| | **mc v1.1** | **10.5** | **50%** | **46.4** | **59%** | – | **47.2** | **20.8** | **43%** | **18.7% (20.8%)** | 16.5 → 17.9 → 15.8 | **0%** |
| 1k bots 99% / 7 d | R (lab) | 10.1 | 46% | 42.6 | 47% | – | 48.2 | 6.1 | 38% | 18.0% (19.4%) | 16.6 → 17.5 → 16.7 | 3% |
| | **mc v1.1** | **19.0** | **61%** | **88.4** | **66%** | – | **93.9** | **21.1** | **43%** | **17.7% (18.6%)** | 16.9 → 16.6 → 16.6 | **0%** |
| 1k / 28 d | R (lab) | 5.3 | 47% | 29.0 | 51% | 21.1% | 29.3 | 8.1 | 45% | 18.3% (20.1%) | 17.9 → 16.4 → 16.3 | 6% |
| | **mc v1.1** | **12.2** | **72%** | **60.5** | **73%** | **36.6%** | **60.7** | **14.8** | **63%** | **18.6% (20.1%)** | 17.3 → 16.7 → 16.7 | **0%** |
| 10k / 7 d | R (lab) | 16.2 | 19% | 110.1 | 22% | – | 111.8 | 24.9 | 39% | 17.0% (17.2%) | 16.6 → 16.5 → 16.4 | 0% |
| | **mc v1.1** | **25.9** | **25%** | **170.0** | **29%** | – | **172.6** | **61.8** | **49%** | **17.3% (17.6%)** | 16.7 → 16.9 → 16.9 | 0% |
| 10k / 28 d | R (lab) | 12.8 | 23% | 102.2 | 24% | 11.4% | 102.8 | 26.1 | 45% | 17.1% (17.2%) | 16.5 → 16.6 → 16.8 | 0% |
| | **mc v1.1** | **34.5** | **39%** | **225.8** | **44%** | **22.4%** | **226.4** | **93.7** | **69%** | **17.4% (17.7%)** | 16.7 → 16.8 → 16.7 | 0% |
| sizes 3:1 / 1k / 7 d | R (lab) | 6.0 | 24% | 34.1 | 27% | – | 34.2 | 3.2 | 36% | 21.2% (22.1%) | 21.2 → 20.6 → 21.2 | 3% |
| | **mc v1.1** | **8.9** | **37%** | **44.2** | **41%** | – | **44.4** | **16.4** | **37%** | **23.5% (25.6%)** | **20.5 → 22.3 → 23.5** | 0% |
| sizes 3:1 / 10k / 28 d | R (lab) | 11.4 | 10% | 89.6 | 12% | 5.6% | 90.2 | 18.9 | 40% | 18.2% (18.5%) | 19.1 → 18.9 → 18.2 | 0% |
| | **mc v1.1** | **29.3** | **20%** | **199.2** | **24%** | **10.8%** | **199.6** | **73.1** | **66%** | **20.3% (20.3%)** | **19.9 → 20.2 → 20.3** | 0% |

(The lab's "changed vs 7 d before" is 0 by construction in 7-day seasons; criterion 10e's 7-day net movement is in §2 and §4.)

**Reading.**
- The v1.1 package moves the map about 1.3–2.7× as much as the lab's. Causes, from the code paths: (a) the keep has no declaration (§3.2), so the lone defenders' standing order now starts at KEEP_CONTEST (the first counted bell); in the lab it was sent at the attacker's departure and often arrived with it; (b) a contest only breaks on a defender or an empty hex, never on "not held within 72 bells"; (c) genesis Free Cities, outposts in contested provinces and sieges from the hex add holding captures and occupations (20.8 vs 5.8 a day at 1k/7d). Defence is the lever (§6 rows).
- No snowball at equal sizes (leader ≤ 18.7%, worst seed 20.8%), but **the 3:1 faction keeps more than in the lab and trends up** (20.5 → 23.5% at 1k/7d; 19.9 → 20.3% at 10k/28d), and ping-pong at 28 days is higher (63–69% vs 45%).
- Bot criterion and doctrine band on the package: §5.

## 4. The campaign planner port and the bot profiles

### 4.1 The planner (§8.6, off-chain design §7.1), as ported

- **Epoch:** every game hour (bell `6h`); state read = the public state the herald files carry (keep holders, contests, holdings, sieges). Pure: the same seed gives the same plan and the same season (`cq_campaign_policy_is_deterministic`; `--check` agrees across thread counts).
- **Campaigns:** ≤ ⌈members / 40⌉ per faction; kept until won, failed twice, or illegal; **a campaign nobody can launch for 24 bells is dropped** (otherwise an infeasible target holds a slot forever). Targets by value ÷ estimated defence: contestable enemy keeps adjacent to the faction's controlled provinces or holdings (value 1.2, ×3 if taking it tips the March banner, ×1.5 if the faction already holds keeps there, ×2 in the Herald's Call March); holdings 2–3 and Free Cities (1.5); first holdings outside heartlands (1.0). Estimated defence: garrison ×10 (×1.5 behind walls), the holder's hosts on the hex, the standing auto-reinforce (4 largest 25% shares of the March within 2 provinces).
- **One slot per faction is kept for a player holding when one is legal** (`holding_slots` = 1; addition D-6): by value ÷ defence alone a player holding never outranks a keep or a Free City, and 10h's holding contest would not be played at all.
- **Assignment:** members within one march (≤ 3 provinces) ranked by spare troops; ≤ 4 hosts a wave (the arrival slots); the group aims at 1.2 × (1.5 × the estimated defence); every member's boldness margin (very skilled 1.3, skilled 1.5, daily 2.0, casual 3.0, bot 1.5, idle never) must hold for the group; one common arrival bell (`max(earliest) + 1`, ≤ `end_bell − 1`). A holding's leader (largest host) must be able to declare (Gold, daily cap, a free slot); helpers stay smaller, so the lead-host rule gives the horn to the planned leader. A keep campaign adds a **siege group** on the province's weakest legal player holding one bell after the assault.
- **Defence:** each own keep under contest and own holding under siege gets the standing order (25% of the 4 largest garrisons of skilled-and-up and bot owners in the March) that can arrive before 25% progress. Automation: needs no session.
- **Who acts when:** epoch-driven = bots under `cq` / `m1` (one decision per bot per epoch); session-driven = humans and `sim`-profile bots, who read the plan as a board when online (join a campaign in reach that needs strength, at its muster bell, or start one) with probability = their aggression (× keep interest for a keep).
- **`--forward` (OD-15):** after a keep is taken the largest remaining host of a campaign faction stays as a forward base; targets within 2 provinces of it are in reach and it marches on from there.
- **Not ported:** the Herald's Call Rally variant for the weakest faction; reserves beyond one wave; counter-attacks; per-Company structure. Lone policy keeps the balance lab's behaviour (per-session rolls, rallies of ≤ 3).

### 4.2 Bot profiles (R-11)

| profile (1k agents, 99% bots, 7 days, campaign, seeds 2002–2011) | Departs / bot-day | keep marches / bot-day | keep captures / bot-day | DeclareSieges / bot-day | lasting changes p50 | banner changes p50 | 10e p50 |
|---|---|---|---|---|---|---|---|
| `sim` (24 sessions a day, aggression 0.5; lone) | 4.21 | 3.16 | 0.081 | 0.077 | 565 | 147 | 0.163 |
| `sim` under the campaign plan | 0.381 | 0.028 | 0.011 | 0.015 | 76.5 | 38.5 | 0.087 |
| **`cq` (thresholds)** | **0.136** | **0.032** | **0.015** | **0.020** | **104** | **59** | **0.110** |
| `m1` (cq + lone rolls at p = 0.06 per bot-epoch) | 0.258 | 0.040 | 0.020 | 0.023 | 139 | 57.5 | 0.322 |
| M1 exit, stack bots [measured, M1-EXIT-NOTES] | ≈ 0.24 | – | – | – | – | – | – |

Calibration of `m1` (seeds 2001–2010, Departs per bot-day, mean): p = 0.045 → 0.230, 0.05 → 0.234, 0.06 → **0.248**, 0.065 → 0.257. `M1_ACT_P = 0.06`. Since the planner alone is below M1's rate, "matched to 0.24" means adding unplanned activity; the profile is documented as such in `src/mc.rs`.

### 4.3 Keep interest, forward staging, coordination (§8.7 item 7; 1k / 7 d, seeds 2002–2011 unless stated)

| row (Gate CQ1 command) | lasting | 10c | banner changes | 10e net | largest share | keeps taken / day | faction 0 Q1 → end |
|---|---|---|---|---|---|---|---|
| `--bot-profile cq --keep-aggr 0.25` (human mix, 5% cq bots) | 37.5 | 0.172 | 5.5 | 0.080 | 0.182 | 5.4 | 0.160 → 0.167 |
| `--keep-aggr 0.5` | 43 | 0.222 | 11.5 | 0.081 | 0.178 | 6.1 | 0.167 → 0.170 |
| `--keep-aggr 1.0` | 47.5 | 0.217 | 10 | 0.095 | 0.178 | 6.8 | 0.167 → 0.167 |
| campaign, human mix (no forward) | 35 | 0.150 | 7.5 | 0.053 | 0.180 | 5.0 | 0.167 → 0.163 |
| `--forward`, human mix | 32 | 0.150 | 8 | 0.045 | 0.182 | 4.6 | 0.167 → 0.165 |
| campaign, cq 99% bots (no forward) | 104 | 0.311 | 59 | 0.110 | 0.177 | 14.9 | 0.159 → 0.165 |
| `--forward`, cq 99% bots | 100.5 | 0.317 | 60.5 | 0.110 | 0.179 | 14.4 | 0.160 → 0.163 |
| `--sizes 3,1,1,1,1,1`, campaign, human mix | 72 | 0.274 | 15.5 | 0.182 | **0.221** | 10.3 | **0.179 → 0.221** |
| `--sizes 3,1,1,1,1,1`, cq 99% bots | 82.5 | 0.288 | 20 | 0.135 | **0.227** | 11.8 | **0.194 → 0.227** |
| `--sizes 3,1,1,1,1,1`, lone, human mix | – | – | – | – | 0.226 | – | 0.209 → 0.226 |
| `--policy campaign:0,lone:1-5 --check-leader-max 0.22` (human mix) | 238 | 0.894 | 62.5 | 0.397 | 0.216 | 34.0 | **0.130 → 0.080**: PASS 10/10 |
| the same with cq 99% bots | 16.5 | 0.044 | 7.5 | 0.015 | 0.202 | 2.4 | 0.191 → 0.202: PASS 10/10 |
| lone, human mix | 283.5 | 0.983 | 68 | 0.360 | 0.186 | 40.5 | 0.160 → 0.165 |

Keep interest at 10k / 28 days (`mapmove --rules mc --policy campaign --keep-aggr K --agents 10000 --days 28 --seeds 4 --first-seed 2001 --gate-28d`; a reduced 4-seed version of §8.7's row), p50:

| keep interest | banner changes / day | Marches with ≥ 2 banners | largest / smallest share | days without a banner change | keeps taken / day | re-taken < 3 d |
|---|---|---|---|---|---|---|
| 0.25 | 3.93 | 12.5% | 17.1% / 16.3% | 7.7% | 13.3 | 21% |
| 0.5 | 4.36 | 12.8% | 17.1% / 16.3% | 5.8% | 15.0 | 25% |
| 1.0 | 4.93 | 15.4% | 17.1% / 16.2% | 11.5% | 17.7 | 31% |
| lone players (for scale) | 54.3 | 40.3% | 17.2% / 16.1% | 0% | 222.7 | 69% |

Readings:
- **Keep interest scales movement roughly linearly at low interest and saturates**: at 0.25 the human-mix campaign map still has 37 lasting changes (floor 60 fails), at 1.0 47.5. With humans only following a plan, movement is low; the lone human mix (each session rolls its own attack, the lab's assumption) gives 6× more.
- **`--forward` changes nothing measurable** (100.5 vs 104 lasting with cq bots; 32 vs 35 with humans), and no snowball (leader 17.9–18.2%). OD-15's default (bots do not stage forward) costs nothing; enabling it gains nothing in this model either.
- **Coordination does not snowball here**: a single campaign faction among lone factions ends *smaller* (8%) because lone players attack far more often than one faction's ≤ 5 campaigns. With cq bots the lone factions' bots never attack, which is a degenerate worst case for the check, and the campaign faction still ends at 20.2%.
- **Size does**: the three-times faction ends above 22% on most seeds under every policy. §5.3.

### 4.4 Why occupations stay near zero under `cq`

Diagnostics (`FRONTIER_SIM_DEBUG=1`, gate seeds 1102–1106, first holdings only):

| | first-holding sieges declared / season | failed with a defender on the hex | failed with the hex left | lead host at the failure: destroyed / on its way home / elsewhere |
|---|---|---|---|---|
| `cq`, 99% bots, campaign | 7, 2, 4, 0, 0 | 1, 0, 1, 0, 0 | 5, 1, 2, 0, 0 | 0 / 9 / 1 |
| lone, human mix | 48, 36, 34, 31, 38 | 6, 2, 3, 3, 2 | 6, 5, 4, 3, 3 | 0 / 36 / 1 |

- **The plan rarely chooses a first holding.** Its one holding slot (D-6) goes to the best player holding by value ÷ defence, and holdings 2–3 (value 1.5, 2-hour shield, small garrisons) beat first holdings (value 1.0, full garrisons, 24-hour shield, Frontier protection). Raising `holding_slots` adds failed sieges on holdings 2–3 but no occupations (§6).
- **A siege that is declared often fails by attrition, not by the owner.** The besieged garrison retaliates every bell of a 36–60-bell siege; a host carries `retreat_bps` 6,667 with probability q (0.6 for bots, `model.rs`) and goes home below two thirds of its troops, which fails the siege with the hex left. The lone human mix declares 5–10× more first-holding sieges and completes most of them (27.5 occupations, p50).
- So 10h's occupation and liberation floors are met by players who attack homes often (the lone assumption), not by the §8.6 plan as specified. Whether the plan should value occupation more (Dominion points: the occupier's faction gets the home's strength weight, §3.10) is a planner decision for CQ2-F / the owner; this unit did not tune it.

## 5. Gate CQ1 lines run by this unit

All from `frontier-sim/` in the worktree, release build, `FRONTIER_SIM_THREADS` 3–6 (results do not depend on it). Logs: `(session scratchpad)/cq1b/logs/`.

| # | command | result |
|---|---|---|
| 1 | `cargo fmt -- --check && cargo clippy --locked --release --all-targets -- -D warnings && cargo test --locked --release` | fmt and clippy **exit 0**; `cargo test --locked --release`: **33 of 36 tests ok** (all 20 `cq_*`, every M1 suite test, `doctrine_balance_gate_rejects_the_draft`); I stopped the run during the three remaining release-only M1 doctrine tests (`doctrine_balance_gate`, `…_rejects_the_knight`, `…_rejects_a_quiet_a_boost`) after 37 minutes on the shared machine: they compute exactly row 3's `doctrine-gate --controls` (same seeds, same M1 code path, CQ0 digest pinned), which passed. **The integrator should run the full line** |
| 2 | `criterion --best-response --seeds 3 --first-seed 30001 --gate` (M1 rules) | **exit 0**, worst cell **0.985** (1%, days 1–7, stake, bots in office), unchanged from the M1 record |
| 3 | `doctrine-gate --controls` (M1 rules) | **pass** (the log shows no `gate failed` and every control rejected; its exit status was lost when I stopped the wrapper script around it): gate passes (largest \|Δ index\| 0.060%, win gap 3.1 points, 4 of 6 in the band at this 60-seed proxy, as at CQ0); the draft, Knight and A-boost controls are each rejected as they must be (−1.319%, −0.242%, +0.326%) |
| 4 | `criterion --best-response --seeds 3 --first-seed 30001 --rules mc --policy campaign --gate` | **exit 0**, worst cell **0.989** (1%, day 0, stake, bots in office): M1 control 0.985 + **0.004**, inside the ≤ +0.005 rule, with 0.1 point to spare |
| 5 | `doctrine-gate --set kernel --rules mc --controls` | **exit 1, FAIL**: A Wardens of Stone **+0.313%** (gate ±0.2%); B Tide **−0.406%**, F Iron **−0.304%**; win rates A 23.3%, B 10.0%, C 18.1%, D 19.7%, E 16.7%, F 12.2% (**2 of 6 in the band**, gap 6.7 points); 360 of 360 seasons conserve. The controls are not reached (the gate exits on the main failure, as at M1). Details and ablations: §5.1 |
| 6 | `mapmove --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 10 --first-seed 2001 --check thresholds/mc-7d-1k.json` | **exit 0**, "no drift" |
| 7 | `mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json --controls` | **exit 1**: MC rules FAIL (10e, occupations, liberations); both controls FAIL as required (§2.2) |
| 8 | `mapmove --rules mc --policy campaign --bot-profile m1 …` (reported) | exit 0 (§4.2) |
| 9 | `for k in 0.25 0.5 1.0: mapmove … --bot-profile cq --keep-aggr $k …` (reported) | exit 0 (§4.3) |
| 10 | `mapmove … --sizes 3,1,1,1,1,1 …` (reported) | exit 0 (§4.3) |
| 11 | `mapmove --rules mc --policy campaign:0,lone:1-5 … --check-leader-max 0.22` (**the OD-16 check**) | **exit 0, PASS 10/10** |
| 12 | `mapmove … --forward …` (reported) | exit 0 (§4.3) |
| 13 | `doctrine-gate --set kernel --rules mc,bannerdom --report-only` (OD-14; run without `--controls`, see §5.1) | report-only **FAIL**: A +0.295%, B −0.384%, F −0.298%; win rates A 23.3%, B 11.1%, C 18.6%, D 20.0%, E 15.8%, F 11.1% (2 of 6 in the band). Banner-hour Dominion at 1 control-bell per banner-hour changes the table by ≤ 0.03 points of index: it neither breaks the band further nor repairs it |
| overnight A | `doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --rules mc --policy lone --gate` (1,500 seasons; ≈ 2 h of CPU on this shared machine, more than the ~2 h the brief allows for one line) | **reduced version run:** `doctrines --agents 10000 --seeds 60 --first-seed 10000 --set kernel --rules mc --policy lone --gate` (360 seasons, seeds 10001–10060): **exit 1, FAIL, 2 of 6 in the band** (A 20.0%, B 10.8%, C 21.4%, D 18.1%, E 16.9%, F 12.8%; Δ index A +0.282%, B −0.370%, C +0.246%, F −0.379%; 28.6 min wall). The full 1,500-season line is the integrator's; with B and F ≈ 6 points below the band at 360 seasons it is not expected to pass |
| overnight B | `mapmove-gate --rules mc --policy campaign --agents 10000 --days 28 --seeds 4 --first-seed 1101 --thresholds thresholds/mc-28d-10k.json` | **exit 1, FAIL**: banner changes a day 5.11 / 4.93 / 6.00 / 5.89 on seeds 1102–1105 (3/4 ≥ 5); Marches with ≥ 2 banners 14.8% / 13.6% / 16.7% / 16.4% (2/4 ≥ 15%); largest 16.9–17.7%, smallest 15.9–16.5%, days without a banner change 0–11.5% pass 4/4. With 4 seeds the rule (⌈0.8 × seeds⌉) needs 4/4. The campaign policy sits right on the balance lab's 10k/28d floors; lone players clear them tenfold (§4.3) |

### 5.1 The doctrine CI proxy on the MC rules

This is the most consequential result of the wave besides criterion 10: **with the v1.1 MC rules and lone players, the doctrine proxy fails**, where the balance lab's keep package (R) kept the band 6/6 on 1,500 seasons (`out/doct_R.md`). The deviations are largest in the *Concord* column (Concord per capita ÷ civ: A 1.0063, B 0.9908, F 0.9923; Dominion stays within ±0.0015), so the edge is economic, not Dominion: B Tide and F Iron (the cavalry doctrines, whose every host pays a horse and ore surcharge, `sim.rs` `send`) fall behind, A Wardens of Stone gains.

Ablations (same harness, 360 seasons, `--report-only`, `--mc` overrides; exploration, not candidate rules):

| configuration | A | B | C | D | E | F | in band | verdict |
|---|---|---|---|---|---|---|---|---|
| M1 rules (row 3) | +0.036% | −0.020% | −0.034% | −0.021% | +0.060% | −0.020% | 4/6 | PASS |
| `--rules mc` (row 5) | **+0.313%** | **−0.406%** | +0.154% | +0.123% | +0.120% | **−0.304%** | 2/6 | FAIL |
| `--rules mc,bannerdom` | +0.295% | −0.384% | +0.165% | +0.118% | +0.104% | −0.298% | 2/6 | FAIL |
| `--rules mc --mc sieges_per_day=0` (no holding sieges, captures or occupations; keeps on) | +0.117% | **−0.240%** | +0.106% | +0.009% | +0.165% | −0.157% | 4/6 | FAIL (B only) |
| `--rules mc --mc keep_home_guard=30000` (keeps never fall; holding contest on) | **+0.287%** | **−0.363%** | +0.085% | +0.072% | +0.178% | **−0.259%** | 1/6 | FAIL |

Reading: **the keeps are not the main cause.** With keeps frozen the proxy fails almost as badly; with the holding contest switched off it nearly passes (B −0.240% just outside ±0.2%). So the edge comes mostly from the MC holding contest (sieges from the hex with a 500-Gold stake, captures into reserved slots with stores kept or zeroed, occupations, genesis Free Cities) on top of a smaller keep-and-outpost part. A measured attribution inside the holding contest (stake, capture effects, Free Cities, outposts) needs more ablations than this wave had time for; the balance lab never ran its doctrine set on these v1.1 holding rules (its R used laurel stakes, no slots, no Free Cities). **Per §3.13 the doctrine band is a Gate CQ1 pass condition, so this blocks Wave 2 until the integrator and the owner decide** (a doctrine re-tune on the MC simulator, or changing the holding-contest economics).

Also run (my shim touches `permutation-rules`): `cargo test --locked --release -p permutation-rules` **exit 0** (29 test binaries, including `m1_rules_keep_the_phase_b_digests`, `occupancy_empty_keeps_the_phase_b_digests`, `phase_a_equals_the_reference_on_4320_inputs`); `cargo clippy --locked -p permutation-rules --all-targets -- -D warnings` **exit 0**; `cargo fmt --all -- --check` **exit 0**.

Not run (not this unit's files; the integrator's lines): `frontier-abi`, `permutation-chain`, `frontier-node`, `permutation-gateway`, `cargo check -p permutation-frontier`, the ownership check.

## 6. Tuning rows (exploration, `--mc` overrides; not gated, not amendments)

Gate CQ1's failure rule names `keep_home_guard` (100 → 50), `keep_consolidate_bells` (288 → 144) and `free_city_min_ring`. `cq` profile, 99% bots, gate seeds 1102–1106, p50 (code before the strike-pause fix, D-7; directionally valid):

| override | lasting | 10c | banner | 10e | occupations |
|---|---|---|---|---|---|
| none | 97 | 0.333 | 54 | 0.076 | 0 |
| `keep_home_guard=50` | 120 | 0.371 | 61 | 0.106 | 0 |
| `keep_consolidate_bells=144` | 103 | 0.356 | 50 | 0.121 | 0 |
| both | 124 | 0.371 | 57 | 0.114 | 0 |
| `holding_slots=2` (planner) | 74 | 0.322 | 36 | 0.068 | 0 |
| `holding_slots=3` (planner) | 48 | 0.322 | 23 | 0.030 | 0 |

Halving the opening guard or the consolidation lifts 10e over 10% at p50; neither produces occupations. Choosing among these (or amending 10e's floor, which §13.4 says is "confirmed or amended at Gate CQ1 from CQ1-B's 7-day net-movement measurement") and deciding what 10h's occupation/liberation floors should measure with hourly bot owners is the integrator's and the owner's call.

## 7. Deviations

- **D-1 (out-of-ownership build shim).** `permutation-rules/src/frontier/clash.rs`: `MAX_GARRISONS_WITH_KEEP = 13` used by `validate` and `MAX_UNITS`, exactly §7's pinned name; `MAX_GARRISONS` stays 12. Without it every clash of a province with 12 site garrisons and a keep is refused and the keep contest silently disappears there. Commit `88cd5eb`, its own commit so the integrator can drop it when CQ1-A's version merges (precedent: M1's W1-A "build shim" commit). M1 digests, the 4,320-input equivalence and `RULESET_HASH` input are unchanged.
- **D-2 (kernel mirror).** §8.7 item 1 says `mc` calls the real `keep`, `control`, `siege` v3 and `holding` v3 kernels. They are CQ1-A's and did not exist when this unit ran. `src/mc.rs` (`cqk`) implements §3.2/§3.3/§3.4/§3.6 and §7's semantics under §7's names (`open`, `advance`, `lead_host`, `controller`, `march_banner`, `capture_credited`, `occupation_ends`, `can_complete_before`, `is_heartland_in`, `free_city_site`), with unit tests. `may_besiege` v3 and the outpost rule are in `src/sim_mc.rs`. `lasting_changes` is in `src/mapmove.rs` over the sparse per-province series (the §7 signature takes a fixed-width array; the sim's province count is dynamic). The runs' `run.kernels` field says "CQ1-B mirror", so `--check` will report drift when the integrator switches to the real kernels: that is intended (re-derive and compare).
- **D-3 (holding sieges in the sim).** The DeclareSiege of the lead host's owner lands at the first bell its host is resident on the hex (client automation armed at departure). Humans, who play 1–4 sessions a day, would declare later.
- **D-4 (`--days`).** §8.7 item 2 writes "join days clamp to min(21, N − 1)" and "the 7-day schedule joins 60% on day 0 and the rest over days 1–5"; the two disagree at N = 7. The code uses days 1…min(21, N − 2): days 1–5 at 7 days (the stated schedule and the balance lab's), 1–21 at 28 (unchanged).
- **D-5 (abstractions).** Outpost tickets settle at filing (the cohort lottery is abstracted as M1's first-holding tickets are); SettleCapture runs at the completion bell; the capturing lead host garrisons the captured holding at once (the contract leaves the garrison at 0 and the captor's host on the hex); dormancy for conquest decisions uses the preset's `dormant_after_secs`, while the holding's economic dormancy stays the M1 kernel's 5 days (holding v3's `LifecycleParams` are CQ1-A's); genesis Free City sites use the mirror `free_city_site`; keep garrison ids are simulator ids; the Dominion fold is computed every hour from the season state (no lost hours in the sim).
- **D-6 (planner additions).** `holding_slots` (1 by default), stale-campaign dropping (24 bells), the board for session-driven members, and the defence plan as the standing order. All are in `src/sim_campaign.rs`, named constants, and recommended to CQ2-F, whose `agents::campaign` must reproduce the planner field for field (§8.7 item 6).
- **D-7 (honest outposts).** An attacker files no outpost while its own capture strike marches (the slot it will reserve at the horn); without it bots filled the slot on the way and the horn was refused `HoldingsFull` (the `capture_cap` persona's refusal).

## 8. Dependency requests and hand-offs

1. **Integrator, CQ1-A merge:** drop `88cd5eb` in favour of CQ1-A's `clash.rs` (same constant and use), or resolve the trivial conflict to CQ1-A's text.
2. **Integrator (or CQ1-B in the integration window), after CQ1-A merges:** replace `frontier-sim/src/mc.rs`'s `cqk` bodies with re-exports of `permutation_rules::frontier::{keep, control}` and siege/holding v3 (`is_heartland_in`, `can_complete_before`, `capture_credited`, `occupation_ends`, `may_besiege`, `may_found_outpost`, `terrain::free_city_site`), add a field-equality test against the mirror's vectors, re-derive both thresholds files and re-run Gate CQ1's simulator lines. No manifest change is needed (`frontier-sim` already depends on `permutation-rules`).
3. **CQ2-F (bots):** the planner rules of §4.1 (incl. D-6, D-7) and the per-bot-day rates of §2.1 are what `--bot-profile cq` measured; the §8.8 bot-activity gate's reference is Departs 0.136, keep marches 0.032, keep captures 0.015 per bot-day.
4. **Owner (via the integrator), before Wave 2:** (0) the doctrine proxy fails on the MC rules (§5.1), a Gate CQ1 pass condition; (a) mapmove-gate fails on 10e and 10h occupations/liberations with the cq profile (§0, §4.4, §6); (b) the 3:1 size stress ends above 22% (§0 item 5, §4.3); (c) OD-14 bannerdom result (§5); (d) OD-15: `--forward` neither helps nor hurts.

## 9. Reproduce

```sh
cd frontier-sim
cargo build --release
export FRONTIER_SIM_THREADS=6
cargo run --release -- mapmove --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 10 --first-seed 2001 --check thresholds/mc-7d-1k.json
cargo run --release -- mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json --controls
R=floor,occ,target,keeps,kbells=72,rally=3,khome=100,kshield=288
CQ_SHORT=1 CQ_SET="M0:;R(lab):$R" cargo run --release -- conquest --agents 1000 --days 7 --seeds 8 --first-seed 1100
CQ_SHORT=1 CQ_SET="mc v1.1 lone:" cargo run --release -- conquest --rules mc --agents 1000 --days 7 --seeds 8 --first-seed 1100
FRONTIER_SIM_DEBUG=1 cargo run --release -- mapmove --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 --days 7 --seeds 5 --first-seed 1101   # planner diagnostics
```
