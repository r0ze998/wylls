# keeper `tests/play.rs::claim_after_late_reveal`: cause measured, regression patch drafted (not yet run)

Status:
- **Cause measured (2026-11-15).** It fails at base `20adb087` and since `0147a885`, ⑱'s 2-version Reveal cap. The cap alone explains it.
- **Regression patch verified (2026-11-15, agreed slot, script `keeper-fix.sh` sha `1d0f85b4`, candidate head `9fab82f0`, rustc 1.95.0, offline/locked, fresh target, unchanged guard):** the 3 touched tests pass (`claim_after_late_reveal`, `late_reveal_under_the_default_w_cap_is_not_claimed`, `ws04_no_reveal_before_anchor_retries`), and the full `cargo test -p keeper` passes (`tests/play.rs` 15 passed / 1 ignored; every other target ok). Whether to take it into canonical is the keeper owner's call (⑱ / territory).
- Nothing is skipped, and the original test's expected values are unchanged.

## Measured (one cargo at a time, rustc 1.95.0, offline/locked, fresh target, unchanged guard, script `cd92f1c1`)

| Run | Tree | Result |
|---|---|---|
| a | unchanged `20adb087` (detached worktree, clean) | **FAIL**: faction 0 reveals at 713, `no claim` |
| b1 | `70843bb5` (parent of `0147a885`) | **PASS**: claim 166,180 lamports |
| b2 | `0147a885` | **FAIL**, identical |
| probe | `20adb087` + env override `max_unknown_w_versions = 0` in the test's `keeper_cfg` only (4 lines, never committed) | **PASS**: claim 166,180 |
| c | candidate head `1e2d79a7`, twice | **FAIL ×2**, identical (deterministic) |

Conclusion:
- `0147a885` introduced the failure, and the anchor wait from `0bf02548` is not needed to explain it (H1 confirmed; H2 and H3 are not needed).
- This branch does not cause it: the candidate fails identically to base.
- Logs: `scratchpad/logs/bisect-*.log`.
- Trees: `/Users/r0ze/Projects/wylls-keeper-bisect-{base-20adb087,pre-0147a885,at-0147a885,probe-20adb087}`, kept as evidence. The probe tree holds the uncommitted 4-line override.

## Regression patch (candidate commit `cfa98ae8`; `CLAUDE-KEEPER-CLAIM-AFTER-LATE-REVEAL-20261115.patch` = `git diff 20adb087 cfa98ae8 -- frontier-node/crates/keeper/tests/play.rs`, sha256 `1c6db8e538d3655a…`)

- A new `Opts::w_version_cap` is threaded through `new_keeper`.
  - `None` keeps the config default. Every other test is unchanged.
- `claim_after_late_reveal` sets `w_version_cap: Some(0)`, with a comment explaining why. Its expected values are unchanged: a late Reveal above the tip level opens a claim, and the claim lands with a positive refund.
- New test `late_reveal_under_the_default_w_cap_is_not_claimed`. It uses the same hold with the default cap (2) and pins the trade-off the owner accepted:
  - the held group's four Reveals land late (≥ `lateness_slots` after THE anchor);
  - no claim opens.
- Also seen: `ws04_no_reveal_before_anchor_retries` uses the same hold and says "versions escalate". It passes, because it checks reveal timing only, but with the default cap its versions stop after 2. The comment is left for the owner.
- To verify, in a slot:
  - `cargo test --offline --locked -p keeper --test play -- claim_after_late_reveal late_reveal_under_the_default_w_cap_is_not_claimed ws04_no_reveal_before_anchor_retries`;
  - then the whole `cargo test -p keeper`.

---

Earlier diagnosis (kept as written before the runs):

## What was observed (2026-11-15, candidate branch, host slot agreed with the territory owner)

- `cargo test -p keeper` fails on this test in two builds:
  - default features;
  - `--features conquest-dispatch-experimental`.
  - Every other keeper test passes.
- Panic message: `no claim`.
  - Keeper status: `claims 0`, `reveals_landed 7`, `reveals_refused 2`, `bad_seals 2`, `closes 14`, `settled 10`.
- The test's own diagnostics:
  - THE anchor of the destination bell is at slot 703.
  - The un-held factions 1, 2 and 4 reveal at slot 704.
  - Faction 0 is held at 1.9 for 10 slots from T(arrive). All four of its slots reveal at **slot 713, exactly when the hold ends**.
  - No `ArrivalSlot` line printed: by the end of the run the slots were closed.
- With features off, none of this branch's keeper code is compiled. This suggests the failure is not from this branch. It does **not** prove that base `20adb087` fails; that run is pending (below).
- History: `docs/frontier/m1/W4-C-NOTES.md` (2026-09-28) records this test passing, with the keeper's ClaimDefence landing for 162,844 lamports and the slots closing after it.

## What the claim needs (source trace)

`keeper/src/play.rs` `claims()`, every 4th slot, for each arrival slot whose beneficiary is this keeper:
1. THE anchor of (bell, region) is known.
2. `now < reveal_close + CLAIM_GRACE_BELLS` (6 bells).
3. `fclient::play::open_claim`:
   - `claimed == 0`;
   - `ev_slot ≥ anchor_slot + lateness_slots`;
   - inside the grace;
   - `fees::defence_refund(ev) > 0`.
4. `defence_refund = min(paid, cap) − (tip_min − 2,500)`, where `paid = priority_fee(ev_price, ev_limit)`. A Reveal that landed at a bid **below `p_tip`** pays less than `tip_min − 2,500`, so its refund is **0** and no claim opens.

`closes()` waits out the claim grace for unclaimed slots, so closing does not race the claim. The late slot (713 ≥ 703 + lateness) satisfies the lateness condition. The open question is therefore the **price** the faction-0 Reveals landed at.

## Hypotheses, ranked

**H1 (primary): the W-version cap `max_unknown_w_versions = 2` stops the escalation under the hold.**
- Introduced by `0147a885` (2026-11-05, owner decision, ⑱), which is in base.
- A Reveal write sends no new version while 2 of its versions have an unknown status and can still land. "Can still land" means within `EXPIRY_SLOTS = 151`.
- Under a 10-slot hold nothing lands, so after 2 versions the ladder stops:
  - with `--peace-start 0.25` and `p_tip = 433` milli, those 2 versions bid about 108 and 216 milli;
  - the hold is at 1,900;
  - one of them lands when the hold ends (slot 713) at a price below `p_tip`, so the refund is 0 and there is no claim.
- The commit names this trade-off itself ("under a long lock the bid stops rising"). It also says the send path was exercised only by signing tests that were not run at the time.
- The test's keeper takes this default: `keeper_config` → `KeeperConfig`, with `max_unknown_w_versions: 2`.
- `EngineParams::default()` keeps 0, so the engine's own ladder tests did not see it.

**H2 (contributing): Reveals now wait for THE anchor and T(arrive)'s signature (`0bf02548`, ⑱, in base).**
- The test's hold also starts at T(arrive), so escalation now starts when the hold is already on.
- Before this change, versions were already climbing by then.
- Without H1 the doubling ladder would still pass 1.9 in about 5 slots (108 → 216 → 433 → 866 → 1,732 → 2,000 cap), so H2 alone should not stop the claim.

**H3: something else between W4-C and base.** For example: the hold's units, the per-write spend cap (`per_write_cap_lamports` 20,000,000, far above these fees), or the one-version-per-chain-slot rule.
- The source reading gives no sign of any of these. Only the measurement can rule them out.

## Measurement plan (one cargo at a time, in the slot order agreed with the territory owner)

Script `keeper-bisect.sh` (sha256 `cd92f1c1…`). Each run:
- `cargo test --offline --locked -p keeper --test play -- --exact claim_after_late_reveal --nocapture`, with `RUST_BACKTRACE=1` and `nice -n 10`;
- the same toolchain (each tree's `rust-toolchain.toml`; the version is printed per run);
- a fresh target, the unchanged guard (free < 20 GiB, target > 4 GiB, 30 min), and the target deleted after the run.

| Run | Tree | Expected if H1 |
|---|---|---|
| a | unchanged `20adb087` (detached worktree) | fails like the candidate (if it passes, the failure is from this branch: investigate here) |
| b1 | `70843bb5` (parent of `0147a885`) | passes, or fails differently |
| b2 | `0147a885` | fails with `no claim` |
| c | candidate head, twice | fails the same way both times (rules out flakiness) |
| probe (only if a fails) | `20adb087` + diagnostic env override `PROBE_MAX_UNKNOWN_W_VERSIONS=0` in `keeper_cfg` (never committed) | passes: the cap alone explains it |

Also in this slot (NFT branch, not about this test): `cargo check -p permutation-frontier`, run three ways — default, `--features expedition-dispatch-experimental` and `--features localnet-conquest-nft-sbf`. This is the gated side of `5ff4c12d`. ⑰'s e2e-native rerun covers only the build without the wide features.

If b1 also fails, the cause is older than `0147a885`. Next step in that case: the parent of `0bf02548` (`16576826`) and `0bf02548` itself.

Observation points to read from each log:
- faction 0's Reveal slots;
- the number of Reveal versions per write and their bids. If the keeper does not print them, the probe adds a print, which is never committed;
- whether a claim lands, and for how much;
- whether the slots close only after the claim.

## Fix (after the evidence; not before)

- The expected result stays as it is: a late Reveal that paid above the tip level opens a claim that lands with a positive refund.
- If H1 is confirmed, the test no longer exercises what it says, because its keeper can no longer escalate under a lock. The owner decision of 2026-11-05 stands. Two options:
  - **(i)** this test configures the every-slot ladder explicitly (`max_unknown_w_versions = 0`) and says why; add a second test that pins the default-2 behaviour under the same hold (≤ 2 unknown versions, landing after the hold, no claim);
  - **(ii)** a hold length past the cap's resume point, so that one version expires and the ladder climbs again. This needs more than 151 slots and changes the scenario's meaning more than (i).
- Either option is the keeper owner's call (⑱ / territory). It would be handed over as a patch with SHAs and never written to canonical.
- If base passes (run a), the failure is from this branch and is fixed here instead.
