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
| P1–P13 (`p_cq_*`) | `svm-tests/tests/{conquest,host,transit}.rs` | all present; scope of each in §6 |
| `g01_cq_`, `g02_cq_`, `g03_cq_`, `g13_cq_` rows | same | present; one G1 line fails §5.4 as written (§3, FoldMarch) |
| cover rows | `svm-tests/src/cover/{conquest,host,transit}.rs` | real rows for the six instructions, the P3 lock row on five host instructions, K-27, SettleTransit prev_home; two ignored gap tests in `PENDING` |
| worlds | `svm-tests/src/world/conquest.rs` (+ `ix/conquest.rs`) | crafted MC state: Season conquest block, Province / Citizen / Holding / JoinShard v2, outposts, Free Cities, the resolve as the shared `conquest_model` runs it |

Commits (this run): `640c28c` (Free City Holding pre-funding-safe, G3 and G2 tests, committed from the working tree), `a5cb881` (the two blockers, the P tests, the rows), `b4628ff` (notes draft), `89f951d` and `1a50f0a` (the tests request `L(kind)` at the deployed programdata length), and the commit of this file's final text. Earlier: `0b2262f`, `fa54f68`, `06934d2`, `a232c43` (merge of CQ2-A's first commit `b2d4b86`), `1e7ae01` (WIP of the interrupted run), `f50cbdf` (CQ2-A stub copy, superseded by `a232c43`).

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

Options, both amendments to §5.4/§13.1 (not mine): **(a) FoldMarch 36,000 CU** (measured max 33,903 + 6%, the rule the other budgets use); tx 594 B (720) and 13 locks are unchanged. **(b)** keep 20,000 and cap `count`: at most **1 hour** for the first fold (18,116 with the init; 2 hours = 21,329) and at most **2 hours** for the steady state (17,925; 3 hours = 21,136), which triples the calls a keeper needs to catch a March up. (a) is the smaller change. Until decided, `g01_cq_fold_worst` gates 36,000 and `g01_cq_fold_worst_at_the_contract_20k` (ignored, in `PENDING`) holds §5.4's number and fails today. **Gate CQ2's "every new kind within §5.4" does not hold for FoldMarch until the contract is amended.**

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

### P9 failing-first against M1's transit code

The program was rebuilt (`scripts/build-frontier.sh --features test-beacon`) with `proc/transit.rs` replaced by `git show 3751173:permutation-frontier/src/proc/transit.rs` (M1's SettleTransit) and everything else as on this branch (variant `.so` sha256 `b2d249f3f750730e2b3d1a210a59798e6a4738ee53ada4af5b24b64e8c336339`), and `./run.sh --release --test transit -- cq_` was run with `PSF_SO_TEST_BEACON` pointing at it: **5 of the 6 `cq_` transit tests fail**. `p_cq_p9_the_transit_of_a_captured_holding_settles` fails at its first settle with `BadAccount` (code 2): M1's SettleTransit refuses a host id of another generation than the Holding's, the permissionless freeze of `program.md` §6.2. `p_cq_p9_without_the_capture_flag_the_generation_trap_holds` passes on both builds (the trap is what an uncaptured Holding with a foreign generation hits). With this branch's `transit.rs`: 6 of 6 pass. The source was restored and the `.so` rebuilt afterwards (`git status` clean).

## 7. Measurements (release `.so` of this branch)

Release `.so` of this branch: 1,021,448 B (sha256 `881bcd8a2964c3efeba8163603c589315354f6cf3ca66e7aad73682853d7247f`; max_len 1,277,952; M1's was 875,824 B). On the trial merge with CQ2-A and CQ2-B (§11) the release `.so` is 1,132,752 B.

| Instruction | G1 fill (§13.1) | CU | §5.4 budget | tx B (§5.4) | locks | heap (trace) |
|---|---|---|---|---|---|---|
| DeclareSiege | Frontier-28, 48 entries / 6 on the tile, nearby proof, capture target with reservation and escrow top-up, `end_bell − now` = 287 (the scan) | **22,130** | 30,000 | 487 (640) | 11 | 1,864 B |
| DeclareSiege | same, ≥ 288 bells left (O(1)) | 20,499 | 30,000 | 487 | 11 | 1,864 B |
| SettleSiege | stake to the defender + slot release with the escrow refund | 13,297 | 25,000 | 385 (480) | 8 | |
| SettleCapture | holding capture, 4 bonds refunded, the rent swap | 26,614 | 30,000 | 582 (720) | 13 | 2,128 B |
| SettleCapture | Free City capture with the Holding's init (after the pre-funding-safe change, D-12) | **19,726** (was measured on the pre-change `.so` in the first run) | 30,000 | 582 | 13 | 2,128 B |
| FoldMarch | 7 members, first-fold init, 6 hours, one lost hour | **33,903 ✗** | **20,000** | 594 (720) | 13 | 2,128 B |
| RetireHost | the victim's session key | 8,313 | 17,000 | 386 (480) | 8 | |
| CloseMarch | | 5,497 | 8,000 | 318 (300) | 6 | |
| SettleTransit | a returning host of a captured Holding with `prev_home` (new G1 row) | 60,362 | 85,000 | 783 (1,022) | 13 | |

- Heap max over the rows on the trace build: **2,128 B** (gate 28 KiB).
- Trace-build CU is 440–1,100 higher than the plain build's (the markers); only the heap is gated there.
- CloseMarch's 318 B is above §5.4's 300: `frontier_abi::v2::budgets::tx_ceiling` raises the ceiling to the worst-case estimate for RetireHost and CloseMarch (CQ1-C's D-11); the table is regenerated at Gate CQ4.
- On the trial merge (§11): SettleCapture 25,920 / 19,032, DeclareSiege 21,783 / 20,152, FoldMarch unchanged 33,903.

## 8. Review of the first run, item by item

| # | Severity | Item | Disposition |
|---|---|---|---|
| 1 | blocker | SettleSiege lapses on `bell ≥ end_bell`, ignores `resolved_next` | **Fixed + test** (§3.1) |
| 2 | blocker | SettleTransit prev-gen path with 13 accounts loses the troops | **Fixed + tests** (§3.2) |
| 3 | blocker | G1 FoldMarch 33,903 vs 20,000 | **Cross-unit** (R-C3): measured, explained (§4), the test gates the proposed 36,000 and an ignored test holds 20,000 |
| 4 | major | capture lock only on the Holding's own Province | **Cross-unit** (R-C1): needs an account-list change in CQ2-A / CQ1-C / `fclient`; recorded with a failing ignored repro (`host::p_cq_p3_foreign_province_gap`); the own-Province case is a real P3 test |
| 5 | major | two capture locks (D-7 vs `capture_locked`) | **Cross-unit** (R-C2). CQ2-A's review round has since moved its lock to the generation test (`mirror.gen ≠ holding.gen`, flag ignored, its D-14), which agrees with D-7 on every reachable state; at the merge use CQ2-A's `proc::holding::own_province_unlocked` in `host.rs` and drop `lock_own` |
| 6 | major | required work uncommitted | **Fixed**: committed (`640c28c`), clippy and fmt re-run, `.so` rebuilt, SettleCapture Free City re-measured (19,726) |
| 7 | major | missing P tests, transit/host rows, cover rows, notes, Gate CQ2 not run, no run with the real A/B handlers | **Fixed** except the items in §6 marked "not covered" (P2(b) with SettleTicket, P12's ReleaseDormant / SettleTicket / FileOutpost steps, P5/P13 at program level): the tests, the rows, this file, the gate lines (§9) and a trial merge with CQ2-A and CQ2-B (§11) |
| 8 | minor | return-settle entries wait forever | **Partly fixed** (D-11: `prev_home == 0`); **deferred**: a `prev_home` that is no longer live (released after the capture): RetireHost refuses it (`BadAccount`) and DisbandStranded refuses it (K-27), so the entry stays until the Province closes. Proposed: after `end_bell` let RetireHost (or DisbandStranded) strand an entry whose home is not live. Needs a decision on K-27's wording |
| 9 | minor | D-2, D-4, Free City funding, stake-recipient lock | **Recorded** (§2, R-C5); contract wording kept in code |
| 10 | minor | finality flip when the source is in `nearby` | **Deferred** (R-C7): `nearby` is `r` in §5.5 |
| 11 | minor | in-season RetireHost hand-rolls the wallet/session check | **Recorded** (D-13) |
| 12 | minor | previous-generation `BounceUnranked` tip goes to the captor's funder | **Deferred** (R-C6): the contract is silent; a rule is the integrator's |
| 13 | minor | `clash::settle_return` dead code in CQ2-B's file | **Cross-unit** (R-C4) |
| m | missing | P1, P2(a,b,c), P3, P4, P5, P6, P9, P12, P13; P11's second half; tests/transit.rs and tests/host.rs rows; cover rows; notes; the Gate CQ2 lines; the end_bell − 1 test; amendments / decisions for 20k, D-7, D-1, D-2, D-4 | **Done / listed** as above; the amendments are requests R-C1…R-C7 |

## 9. Gate CQ2 lines of this unit's files

| Line (Gate CQ2 / §12) | Result on this branch |
|---|---|
| `cargo fmt --all -- --check` | pass (the program crate); `svm-tests` is its own workspace: `cargo fmt -- --check` pass |
| `cargo clippy --locked -p permutation-frontier --all-targets -- -D warnings` | pass |
| `cargo test --locked -p permutation-frontier --no-default-features` | 39 passed |
| `scripts/build-frontier.sh --twice` | pass: both builds hash `881bcd8a…7247f` (reproducible), e_flags 2, overflow panics present, `deployable yes`; program_hash `eb5e1095…6725` |
| `(cd permutation-frontier/svm-tests && ./run.sh --release -- g01_cq_ g02_cq_ g03_cq_ g11_cq_ g13_cq_ p_cq_)` | **49 passed, 0 failed, 2 ignored** (`conquest::g01_cq_fold_worst_at_the_contract_20k` and `host::p_cq_p3_foreign_province_gap`, which fail on purpose under `--include-ignored`: §4, §5). No `g11_cq_` row exists here (CQ2-B's) |
| `(cd permutation-frontier/svm-tests && ./run.sh --release)` (every M1 test still green) | 298 passed, **1 failed**, 6 ignored. The failure is `g01_loaded_limit_table_covers_the_release_so`: the release `.so` (1,021,448 B, max_len 1,277,952) outgrew the budgets table's placeholder programdata length (1,105,920 B, `frontier_abi::budgets`). The table is regenerated from the release `.so` at Gate CQ4 (§5.4 "Every `L(kind)` is regenerated"); the program grew by the whole MC surface, not by this unit alone. Cross-unit; not mine. My tests request `L(kind)` at the deployed programdata length so they do not depend on the table |
| `PSF_TRACE=1 … g01_cq_declare g01_cq_settle_capture g01_cq_fold (+ settle_siege, settle_transit)` | pass; heap ≤ 2,128 B. `g01_cq_resolve_worst` / `g01_cq_skip_worst` are CQ2-B's (they pass on the trial merge, §11) |
| `scripts/cq-ownership-check.sh frontier/cq-2c-conquest` | PASS (two report-only footprint warnings: CQ2-A's first commit touched `permutation-frontier/src/lib.rs`, a path the design chat's branch also touched) |
| `cq-regen.sh --check` | not run: this unit changes no layout, tag, vector or generated output |
| `frontier-node` `cq_` (keeper, herald, bots) | not this unit |

Pass conditions of Gate CQ2 that concern this unit:

- **"every new kind within §5.4": not met for FoldMarch** (33,903 > 20,000); every other new row is within budget (§7).
- heap ≤ 28 KiB: met (2,128 B).
- P1–P13 green: green, with the scope limits of §6; **P9 failing-first** recorded in §6 below.
- G11, ResolveFromInputs ≤ 290,000: CQ2-B's.

## 10. Merge history

- `b2d4b86` (CQ2-A's first commit: v2 dispatch table, stubs) was merged as `a232c43`; CQ2-A's files resolved to `b2d4b86`. `f50cbdf` was the earlier copy of the same stub commit made on this branch and is superseded. `1e7ae01` is the saved work of the interrupted first run. A trial merge with `frontier/cq-2a-core` and `frontier/cq-2b-clash` was textually clean (`git merge-tree`) in the first review; the trial result of this run is in §11.

## 11. Trial merge with CQ2-A and CQ2-B

A trial merge was run on a temporary local branch (since deleted; nothing is merged, nothing pushed): this branch, then `frontier/cq-2b-clash` (`935b619`), then `frontier/cq-2a-core` (`8b8223a`). Both merges were textually clean and the program compiled. All four `.so` builds succeed; the release `.so` is **1,132,752 B** (CQ2-A + CQ2-B + this unit). Results of `./run.sh --release --no-fail-fast`:

- **334 passed, 3 failed, 6 ignored.** The three failures are not in this unit's tests:
  1. `cq::g01_cq_file_outpost_three_provinces_full_cohorts` (CQ2-A's R4: FileOutpost 26,449 CU > 24,000).
  2. `g01_loaded_limit_table_covers_the_release_so` (the budgets table's placeholder length, §9).
  3. `season_records_and_chain_through_the_lifecycle` (`tests/season_records.rs:42`): the SEASON_CREATED record's `ruleset_hash` is the v2 hash after CQ2-A's switch while the test compares M1's `RULESET_HASH`. `tests/season_records.rs` is an M1 file no Wave-2 unit owns (frozen); the integrator updates it at the merge (or CQ2-A takes it).
- **Every `g01_cq_` / `g02_cq_` / `g03_cq_` / `g13_cq_` / `p_cq_` test of this unit passes on the merged tree** (conquest 42, host 2, transit 5), including `g01_cq_resolve_worst` and `g01_cq_skip_worst` of CQ2-B. The first run failed 40 of them with `MaxLoadedAccountsDataSizeExceeded`: the budgets table's placeholder `L(kind)` is smaller than the grown program needs. Fixed in the tests (they request `L(kind)` at the deployed programdata length, the way a client does), not by relaxing a gate.
- Numbers on the merged `.so`: SettleCapture 25,920 (holding) / 19,032 (Free City), DeclareSiege 21,783 / 20,152, FoldMarch unchanged (33,903); trace heap max 2,128 B for this unit's rows.
- **Not exercised** (the crafted worlds still stand in for CQ2-A's instructions): the real CreateSeason / OpenProvince / Join in the worlds, P2(b) across a SettleTicket, P12's walk with ReleaseDormant, SettleTicket and FileOutpost (S1, S3 on the real handlers), and the swap of this file's `cqlog` for CQ2-A's `events::emit_cq` (CQ2-B's R5; the bytes are identical, `cq_records_are_the_abis` pins them) — the integrator does the swap at the merge.
- At the merge: add CQ2-A's capture-lock test (`holding::…g13_cq_capture_lock_refuses_the_resident_actions`) to the `EXPLORE` row of `cover/host.rs` (CQ2-A's R8; this unit's file); use CQ2-A's `own_province_unlocked` in `host.rs` instead of `lock_own` (§5, R-C2). SettleCapture of a Free City adds no `n_sites_used` count (CQ2-A's note 7 asks CQ2-C to agree): this handler does not touch it.
