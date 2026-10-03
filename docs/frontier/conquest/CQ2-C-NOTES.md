# CQ2-C notes — prog-conquest (Wave 2)

Unit: `proc/{conquest,transit,host}.rs` and their svm worlds, builders, rows and tests (§11).
Branch `frontier/cq-2c-conquest`, cut from `frontier/cq-integ` `3751173` (contract v1.3). Local commits only.
Status of this file: second run (after the interrupted first run and its adversarial review). Numbers are measured on this branch's release `.so` unless marked.

## 1. What landed

| Deliverable (§11) | Where | State |
|---|---|---|
| DeclareSiege 0xA0, SettleSiege 0xA1, SettleCapture 0xA2, FoldMarch 0xA5, RetireHost 0xA6, CloseMarch 0xA7 | `proc/conquest.rs` | done, on CQ2-A's v2 plumbing (stub commit `b2d4b86`) |
| `prev_gen` / `prev_home` transit path | `proc/host.rs` (return settle, SettleDeparture), `proc/transit.rs` (SettleTransit) | done; the 13-account hole closed (§3) |
| Capture lock on Muster, Dissolve, Garrison, Depart, the settles | `proc/host.rs`, `proc/transit.rs`, `proc/conquest.rs::capture_lock` | done for the Holding's own Province; foreign Province is a contract gap (§5, R-C1) |
| v1.1: lead-host check, slot reservations and their release, faction-scoped immunity, victim-only RetireHost, donor Leave path | `proc/conquest.rs`, `proc/host.rs` | done |
| P1–P13 (`p_cq_*`) | `svm-tests/tests/{conquest,host,transit}.rs` | all present; scope of each in §4 |
| `g01_cq_`, `g02_cq_`, `g03_cq_`, `g13_cq_` rows | same | present; one G1 line fails §5.4 as written (§3, FoldMarch) |
| cover rows | `svm-tests/src/cover/{conquest,host,transit}.rs` | real rows for the six instructions, the P3 lock row on five host instructions, K-27, SettleTransit prev_home; two ignored gap tests in `PENDING` |
| worlds | `svm-tests/src/world/conquest.rs` (+ `ix/conquest.rs`) | crafted MC state: Season conquest block, Province / Citizen / Holding / JoinShard v2, outposts, Free Cities, the resolve as the shared `conquest_model` runs it |

Commits (this run): `640c28c` (Free City Holding pre-funding-safe, G3 and G2 tests, committed from the working tree), `a5cb881` (the two blockers, the P tests, the rows). Earlier: `0b2262f`, `fa54f68`, `06934d2`, `a232c43` (merge of CQ2-A's first commit `b2d4b86`), `1e7ae01` (WIP of the interrupted run), `f50cbdf` (CQ2-A stub copy, superseded by `a232c43`).

## 2. Decisions pinned (D-n)

Kept from the first run; each is a place the contract was silent or ambiguous. None changes a player-visible rule or an owner default.

- **D-1** The capture lock (§5.8) is enforced when the Province an instruction names is the Holding's own. See the gap in §5 (R-C1).
- **D-2** DeclareSiege's "declarer's own first holding must not be shielded unless dormant" (§3.4 step 8) is checked on the **source Holding whose host sounds the horn**, not on the declarer's first holding. A player with a shielded home can therefore declare from an unshielded outpost. (Needs the contract's wording or the first holding as an account; recorded for the integrator.)
- **D-3** The vigil snapshot is the owner Citizen's stored schedule `(start, next, from_ts / 86,400)`, decoded by `siege3::vigil_of_snapshot` (incl. a change already requested). `p_cq_p1_*` checks 40 program-declared records against the stored schedule and shows a later change is not read again.
- **D-4** SettleCapture returns the stake to `src` for a holding capture **and for a Free City capture** (§3.6 states it for a holding capture only).
- **D-5** RetireHost after `end_bell` frees the host at once only when its Province resolved every bell of the season (`resolved_next ≥ end_bell`), else `TooEarly`. **Since this run SettleSiege's season-end lapse uses the same guard** (§3, blocker 1).
- **D-6** RetireHost also binds a departed Leave of the previous generation that is waiting for its return settle (`op_ref` = the home key's high word).
- **D-7** The capture lock reads the mirror alone: `mirror.state == 1 && mirror.gen == holding.gen + 1`. CQ2-A's `frontier_abi::v2::prologue::capture_locked` is `mirror.gen != gen && capture_flags == 0`, which leaves a **second** capture of an already captured Holding (`capture_flags = 1`) unlocked on Harvest, Build, Train, Explore and FileOutpost. D-7 is the rule that closes it; the other is CQ2-A's file (R-C2).
- **D-8** (CQ1-C's pinned account groups of SettleTransit) 13 fixed accounts, `[camp Citizen]` (0–1), `[prev_home_holding]` (0–1).
- **D-9** `prev_home_holding` is **mandatory exactly when `holding.gen ≠ id.gen` and the Holding is a captured one** (`prev_gen_transit`). 14 accounts are the camp Citizen on the ordinary path and `prev_home` on the previous-generation path; 13 on the previous-generation path is refused before any effect (§3, blocker 2).
- **D-10** (new) A running occupation whose stake to `src` is paid by SettleSiege keeps the stale `src` key in the record; the model copies it into the kind-0 record when the occupation ends. No flag names it and nothing reads it (checked in `frontier-abi`, keeper, verify, itest), so it is harmless, and `p_cq_p12`'s S6 check ignores `src` when no owed bit is set. A cleanup (zero it when the flag clears) is one line in `settle_plan` plus the model's step if the integrator wants byte-canonical records.
- **D-11** (new) A previous-generation Leave whose captured Holding has `prev_home == 0` (the victim's first holding was already gone at the capture) does not wait for RetireHost (which refuses it, `NotOwner`): the return settle strands it, M1's rule (`g12_cq_return_settle_strands_a_victim_without_a_home`). Before, such an entry occupied its Province forever.
- **D-12** SettleCapture of a Free City creates the Holding `init_funded` with 0 extra lamports: only the shortfall to rent-exempt moves from the captor's escrow (pre-funding-safe, §4.2); what is left stays escrowed for its funder (CloseCitizen). The contract says "created from the reservation's rent" (`g02_cq_settle_capture_prefunded_free_city_holding`).
- **D-13** In-season RetireHost checks the victim's wallet or live session key by hand, without the player prologue's bucket debit and `last_action_ts` (the victim Citizen is `r` in §5.5). §5.5's text says "player prologue on `victim_citizen`"; either make the Citizen writable and run `player_v2`, or amend the text to "signature check only".

## 3. The first review's blockers

1. **SettleSiege lapsed a running siege as soon as `bell ≥ end_bell`** and ignored the Province's `resolved_next`. A siege may legally complete at `end_bell − 1` (DeclareSiege's `TooLate` allows it) and that bell's resolve can land after `end_bell` has started; a third party could zero the record first and the capture or occupation would never happen (a last-look and a "lag only waits" break, P4). **Fixed:** a running siege lapses only when its Province has resolved every bell of the season (`resolved_next ≥ end_bell`), else `TooEarly` before any effect. Tests: `g13_cq_settle_siege_lapses_a_siege_at_season_end` (was encoding the bug; now needs `resolved_next = end` first and shows `TooEarly` while the Province lags), `p_cq_p4_a_lagging_province_cannot_be_lapsed_before_its_last_bell` (a siege that completes at `end_bell − 1` in a late resolve: the refused call leaves the Province byte-identical, the late resolve gives capture due, SettleCapture lands after the end).
2. **SettleTransit on the previous-generation path with 13 accounts had no `prev_home_holding`**, so the returning troops were lost to any third party's call (§5.6, §3.6, P9). **Fixed:** `(13, prev_path)` is `TooManyAccounts` before any effect. Tests: `g13_cq_settle_transit_prev_home_is_mandatory` (and "no effect"), `p_cq_p9_*`, `g03_cq_settle_transit_prev_home_forgeries`, `g12_cq_settle_transit_prev_home_released_loses_the_troops`, `g01_cq_settle_transit_with_prev_home`.
3. **FoldMarch G1 = 33,903 CU against §5.4's 20,000.** Real, measured, **not fixable in code** (§4). Amendment requested; the test gates the proposed number and an ignored test holds §5.4's.

P9 **failing-first against M1's transit code** — see §6.

## 4. FoldMarch budget finding (for the integrator)

`g01_cq_fold_worst` (7 present members, one opened late, one overwritten ring slot = one lost hour), release `.so`:

| hours in the call | first fold (init) | steady state (MarchState exists) |
|---|---|---|
| 1 | 18,116 | 14,984 |
| 2 | 21,329 | 17,925 |
| 3 | 24,270 | 21,136 |
| 4 | 27,481 | 24,347 |
| 5 | 30,692 | 27,558 |
| **6 (§13.1's fill)** | **33,903** | (≈ 30,800, extrapolated) |

Per hour ≈ 3,210 CU (fold of seven members ≈ 1,600, the normative `MARCH_FOLD` record with its chain advance ≈ 1,300, `apply_fold` ≈ 300). The fixed part is ≈ 11,700 CU steady and ≈ 14,900 with the first fold's pre-funding-safe init (v2 prologue, seven keyed Province derivations, the March derivation). **Even a zero-cost setup leaves 6 × 3,210 = 19,260 CU**, so 20,000 cannot hold at count 6 whatever is optimised; the per-hour log is normative.

Options, both amendments to §5.4/§13.1 (not mine): **(a) FoldMarch 36,000 CU** (measured max 33,903 + 6%, same rule as the other budgets), `tx` 720 B and 13 locks unchanged (594 B, 13 locks measured); **(b)** cap `count` at 1 for the first fold and ≤ 3 steady (≤ 21,136 still exceeds 20,000 at 3), i.e. a count cap of 2 in both cases to stay near 20k, which makes the keeper's catch-up slower. (a) is the smaller change. Until decided, `g01_cq_fold_worst` gates 36,000 and `g01_cq_fold_worst_at_the_contract_20k` (ignored, in `PENDING`) holds §5.4's number and fails today. **Gate CQ2's "every new kind within §5.4" does not hold for FoldMarch until the contract is amended.**

## 5. Contract gaps and requests (cross-unit; the integrator resolves)

| Id | What | Why / evidence | Needs |
|---|---|---|---|
| **R-C1** | The capture lock cannot see a Holding's own Province when the instruction names another. Affected: the return settle and SettleDeparture of a foreign Province, Depart and Dissolve from a forward hex, DeclareSiege's source Holding when it is in neither named Province, SettleCapture / SettleSiege's stake Holding. | Between a completion and SettleCapture, a return settle of the victim's Leave in another Province credits the troops into the captured Holding (its generation still matches); SettleCapture then zeroes `RESERVE`. If SettleCapture runs first the same entry waits and the victim retires it home. The outcome depends on settle order (breaks §3.6 "never into the captured Holding" and "settles choose nothing"). In the same window DeclareSiege lets a victim pay a 500-Gold stake out of its capture-locked Holding. `host::p_cq_p3_foreign_province_gap` (ignored) shows it. | An optional trailing `[holding_province r]` on the return settle and SettleDeparture, mandatory when the Holding's Province differs from the named one; DeclareSiege requires `nearby` to be the source's Province when the source is not in the target Province (tag/builders: CQ2-A, `fclient`: CQ2-D, `frontier-abi` account lists: CQ1-C/CQ2-A). Until then the gap is documented, not hidden. |
| R-C2 | Two capture locks after the merge (D-7 vs CQ2-A's `capture_locked`) | §2 D-7 | Amend §5.6/§5.8 to D-7's rule; switch `frontier_abi::v2::prologue::capture_locked` (CQ1-C/CQ2-A files) and add the P3 test of CQ2-A's instructions after a **second** capture |
| R-C3 | FoldMarch 20,000 CU | §4 | §5.4 / §13.1 amendment |
| R-C4 | `clash::settle_return` is dead code in CQ2-B's `clash.rs` (dispatch moved to `host.rs`) | `host.rs::settle_return` is the live path | delete at the B/C merge; keep the `RETURN_*` constants `host.rs` imports |
| R-C5 | D-2, D-4, D-12, D-13 wording | §2 | contract wording or owner decision where it is rule-like (D-2 is: a shielded home does not protect an unshielded outpost's declaration) |
| R-C6 | The remaining victim funds on the previous-generation SettleTransit path: a `BounceUnranked` tip is paid to the captured Holding's **current** rent payer (the captor's funder); only the bond is refunded to the victim (P8). | review minor; the contract is silent | state the rule (refund the tip to the victim's recorded funder) or leave; not done here |
| R-C7 | DeclareSiege runs the lazy finality flip on the source Holding only when its Province is the target Province | `nearby` is `r` in §5.5, so it cannot be written | accept (the source is refused `NotFinal` until a Muster/Garrison in its Province flips it) or make `nearby` writable |

**Dependency requests (manifests, locks, toolchain):** none. This branch changes no manifest, lockfile or toolchain file.

## 6. Properties (P1–P13), what each tests

| Id | Test | Scope |
|---|---|---|
| P1 | `p_cq_p1_siege_progress_is_the_kernels_over_1000_random_cases` | 1,000 crafted records (random vigils incl. a pending change, required 36–60, holders, defenders, Free City / first / capture targets) driven through `conquest_model::step` and replayed with `SiegeV3::advance`; 40 records declared **by the program** (the snapshot equals the Citizen's stored schedule; later changes are not read). The step is the function ResolveFromInputs and SkipQuiet call; this branch's resolve is crafted (CQ2-B's program path is `g11_cq_`). |
| P2 | `p_cq_p2a_*`, `p_cq_p2b_*`, `p_cq_p4_holding_the_inputs_past_completion_changes_nothing` | (a) all 6 orders of 3 declarers, with and without a troops tie: one winner (the lead host's owner), `NotLead` for the rest, no mark left by refused calls. (b) two completions of one citizen in one bell: 6 (order, delay) variants, up to 150 bells, equal owners, slots, immunity, credit, escrow. **Not covered:** "held across the captor's outpost SettleTicket" (SettleTicket is CQ2-A's; needs the merged tree). (c) FoldMarch in one call, one hour per call, or 5 hours late: equal MarchState. |
| P3 | `host::p_cq_p3_capture_lock_on_muster_dissolve_garrison_depart_and_the_settles` (+ ignored `p_cq_p3_foreign_province_gap`) | Muster, Garrison, Dissolve, Depart, SettleDeparture, the return settle: land before the completion, `CapturePending` after, own Province. CQ2-A's Harvest, Build, Train, Explore: not here (CQ2-A's rows; R-C2). The foreign-Province case is the open gap R-C1. |
| P4 | `p_cq_p4_*` (two) | delayed SettleCapture = immediate (owner, order, gen, immunity, slots); a lagging Province cannot be lapsed before its last bell; FoldMarch up to 5 hours late loses no hour |
| P5 | `p_cq_p5_the_keep_is_the_kernels_and_skip_equals_resolve` | model level: 30 random rosters, 12,550 quiet bells: the keep after every bell equals native `keep::advance` (28 takings, 20 breaks, consolidation, donor handoff); resolve ≡ skip byte for byte on every quiet bell (G11 extended). The program-level keep and G11 are CQ2-B's. |
| P6, P12 | `p_cq_p6_p12_every_record_terminates_and_the_site_invariants_hold` | 40 seeds × 40–90 random steps (DeclareSiege, SettleSiege, SettleCapture **through the program**; resolved bells with random reports through the shared step; clock jumps), then every bell to `end_bell` and permissionless drain: every record kind 0 (or an occupation with nothing owed), no reservation survives; S1, S2, S5, S6 and the reservation accounting (reserved bit ⇔ the record that holds it; `ticket_escrow = rent × reservations`) after **every** step. ≈ 210 declarations, ≈ 40 settled sieges, ≈ 48 settled captures per run. **Not in the walk:** ReleaseDormant, SettleTicket, FileOutpost (CQ2-A's, not on this branch). |
| P7 | `p_cq_p7_p11_retire_host_by_the_victim_returns_to_prev_home` | the captor cannot command the host; RetireHost sends it to `prev_home` only |
| P8 | `g13_cq_settle_capture_takes_the_outpost`, `p_cq_p8_bonds_and_rent_go_to_the_victims_funder` | bonds and the rent swap go to the Holding's `rent_payer` (a relayer), not the victim's wallet |
| P9 | `transit::p_cq_p9_*` | the transit of a captured Holding settles and credits `prev_home`; failing-first record below |
| P10 | `p_cq_p10_*` (two) | deserted siege burns the stake and grants nothing; Respite only on expiry or when the owner's side holds the hex; walking away or a third faction gives none; bars only the occupier |
| P11 | `p_cq_p7_p11_*`, `p_cq_p11_a_retire_after_the_end_changes_no_outcome` | only the victim's wallet or session during the season (others `NotLead` / `Auth`); a RetireHost after the end changes no scoring byte (the second half) |
| P13 | `p_cq_p13_every_garrison_is_within_the_cap_and_the_clash_input_validates` | model level, through the real kernel clash: 12 walks with 1–6 hosts of 30,000 troops on the keep tile and keep guards of 0 to 30,000, 12 takings, every `resolve_clash` input validates (including the bell after a taking) |

## 7. Measurements (release `.so` of this branch)

MEASURED_TABLE

## 8. Review of the first run, item by item

REVIEW_TABLE

## 9. Gate CQ2 lines of this unit's files

GATE_TABLE

## 10. Merge history

- `b2d4b86` (CQ2-A's first commit: v2 dispatch table, stubs) was merged as `a232c43`; CQ2-A's files resolved to `b2d4b86`. `f50cbdf` was the earlier copy of the same stub commit made on this branch and is superseded. `1e7ae01` is the saved work of the interrupted first run. A trial merge with `frontier/cq-2a-core` and `frontier/cq-2b-clash` was textually clean (`git merge-tree`) in the first review; the trial result of this run is in §11.

## 11. Trial merge with CQ2-A and CQ2-B

TRIAL_SECTION
