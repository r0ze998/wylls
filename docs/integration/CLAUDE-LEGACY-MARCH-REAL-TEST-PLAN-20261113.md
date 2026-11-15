# Legacy march: real-program in-process test — plan, approval and RESULT (PASS)

2026-11-13. Approved by the user and run within the plan's scope; the results are in the last section.

## What it proves, and what it does not
- **Proves:** the keeper's legacy march steps (`itest::legacy_march`, together with the origin driver) run against the REAL program. The steps are SettleDeparture, Decrypt, Reveal, gather/seed/resolve and SettleTransit. The march is an ordinary Depart arriving at the home province (the same-home case from the review).
- **Does not prove:**
  - the page's own Depart: the test builds it in Rust with the game's builder (`ix::v2::depart`);
  - an arrival in another province;
  - combat, capture, or anything on a natural clock.

## Approval items
| Item | This test |
|---|---|
| New chains / worlds | **One** memory-only test chain inside the test process (`natural_play::prepare`: a new Season built by its own instructions). It does not go through the launcher and uses no existing world or data directory. |
| Test keys | **One** player wallet `Keypair::new()`, in memory only. It is never printed or written, and is dropped when the test ends. The keeper's fee payers (three `fund_fresh` keys) and the runner's setup keys are also in memory only and end with the process. No real wallet and no real funds. |
| Player-signed instructions (test key) | Join, PlaceHome, Train 100, Muster 100, and **one** Depart (0x50 v2 form, sealed to the home province, one step, arriving at bell + 3). |
| World setup (runner, automatic) | Deploy the artefact, AnnounceSeason, CreateSeason, InitBeaconLogs, InitShards, ConsumeGenesisSeed, OpenRing, OpenProvince (heartland), and localnet airdrops to the test and keeper keys. |
| Keeper-sent (automatic) | PostAnchor / PostAnchorMulti, FastForward, GatherClash, PostSeed, ResolveFromInputs, SettleDeparture, Reveal, SettleTransit. Each is simulated first or sent as the origin driver already does. An unknown outcome is never resent. |
| Clock compression | **Yes, on this test chain only, unlike the natural trial.** Before genesis it is synthetic (as in `prepare`). After genesis `destination_real::advance` moves the clock with the node's scale control, by 60–120 s per step and at most 2 h per call. No game rule or duration changes: bells are still 600 s and windows the program's. The chain's dates (from g0, August 2026) stay months behind real time, so every round it needs is already published. |
| Public drand | Read-only HTTPS GETs to `api.drand.sh` (Quicknet): the genesis round, one round per anchored bell, the seal round T(arrive) and seed rounds. Each is BLS-verified against the pinned key. Expected under ~60 GETs. Nothing is sent and no account is involved. |
| Ports | Two loopback ports from 41940–41947 (RPC and WS of the test chain), 127.0.0.1 only. 41904–41907 are never used. |
| Maximum time | The guard stops at **30 minutes**. Expected 3–10 minutes. Stop rules: 4 GiB target, under 20 GiB free, or 30 min, killing the process group and deleting nothing. |
| Disk | Reuses the existing build target `target-resident-fix`, checked unused first. Preflight needs ≥ 21 GiB free; 24–26 GiB is free now. |
| Records kept | Only the scratchpad log `real-legacy-march.<time>.log`: cargo output, the landed step names and signatures, and pass/fail. No key, plaintext or salt is printed. The chain itself is memory-only and is gone with the process. |
| Cleanup | The test calls `world.running.stop()`, and the process exit ends the in-process chain. The script then checks that ports 41940–41947 have no listener. On a guard stop, the cargo process group is killed. |
| Existing worlds | None used or touched. No launcher and no canonical file. |
| Gates | No conquest flag. No readiness flag changes. |

## Command (only after approval; the env var is set only on the user's yes)
```bash
WYLLS_LEGACY_MARCH_APPROVED=1 <scratchpad>/real-legacy-march-run.sh
```
- **Script** `real-legacy-march-run.sh` (`bd107a6f`). Before starting, it checks:
  - the approval variable;
  - the artefact hash (`b64a539a…`, the natural trial's artefact);
  - ≥ 21 GiB free;
  - ports 41940–41947 free;
  - the target unused.
- **Test:** `itest legacy_march::real_legacy::a_real_ordinary_march_departs_arrives_at_home_and_settles` (ignored; compiled in both feature sets).

## Expected result (PASS)
- **Landed, in order:**
  - the player's five transactions;
  - the keeper forming the host: anchor, then GatherClash, PostSeed and ResolveFromInputs of the muster bell;
  - SettleDeparture;
  - **Reveal**;
  - at home: gather (the real arrival part), PostSeed, ResolveFromInputs of the arrival bell;
  - **SettleTransit**.
- **No unknown outcome, no driver stop.** The Holding's transit slot 0 is free at the end.
- **Printed:** the `landed: […]` list.

## Failure is a finding, not a retry
- Any refusal (Depart rules, a slot rule, the gather form) fails the test with the program's code. That is reported, and nothing is rerun automatically.
- Likely points if it fails:
  - the new host's cooldown or stamina at the depart bell (game rule: then the test needs a later departure, not a rule change);
  - the arrival window bound;
  - the same-home gather with the origin driver.
- Each fix would be code plus pure tests first, and a rerun only on a new approval.

## Result (2026-11-13, run after the user's approval; same scope as above)
The approval came from the user in chat: "ccで完了まで開発して", within this scope. Each run used one memory-only chain,
one in-memory test wallet, loopback 41940–41941, and public drand GETs only. The 30 min guard was never reached.

### Before the run: the review's order finding
- The test's end now runs `landed_order::check` (pure, 4 tests in this module) instead of four name checks:
  - the departure bell's resolve, if the origin driver did it (a quiet one is the keeper's FastForward), comes before
    SettleDeparture, and at most once;
  - then Reveal (slot 0, the arrival bell);
  - the arrival bell's gather, at least one, between Reveal and its resolve;
  - **exactly one** `ResolveFromInputs` of the ARRIVAL bell, by either driver, after Reveal and before SettleTransit.
- Labels are matched with their closing punctuation: bell 1 never matches bell 12, and the departure resolve can never
  count as the arrival's.
- The script now also pins the four test sources (`real-legacy-src.sha256`, passed as `REAL_LEGACY_SRC_PIN`).

### The runs
| Run | Result | Finding / change |
|---|---|---|
| 1 | FAILED at the first player step: `Join` unknown after 60 s, **not resent** | `natural_play::prepare` returns the chain paused, and the natural run unpauses it at ready-for-join. The test now unpauses it the same way. No program, game rule or clock rule changed. |
| 2 | PASS | The log listed the origin driver before the legacy driver, though within a tick the Pilot runs the legacy driver first. The log now follows the real order. |
| 3 | PASS (same-home only) | — |
| 4 | **PASS, both tests** (54 s for both, 2.1 GB peak build) | Added: the same march one step into a neighbouring province. |

Source pin of run 4: `c96ff641…`. Sources: `legacy_march.rs` `ac177623`, `origin_driver.rs` `3a7f4cd3`,
`keeper_loop.rs` `4822ec33`, `local_keeper.rs` `ff99fdcd`. Script `05902101`, artefact `b64a539a…`.

**Landed, same-home march** (−2,0) tile 0 → tile 6, departure bell 3, arrival bell 6:

GatherClash(bell 3) · PostSeed(bell 3) · ResolveFromInputs(bell 3) · SettleDeparture(slot 0) · Reveal(slot 0, bell 6)
· GatherClash(destination bell 6, from 0) · GatherClash(bell 6, from 20) · PostSeed(destination bell 6)
· **ResolveFromInputs(bell 6)** · SettleTransit(slot 0, bell 6)

At home, the two drivers gathered the two parts of the arrival bell between them. Each read the chain fresh, in turn
within the tick. Then the legacy driver posted the seed and the origin driver resolved, once.

**Landed, another province** (−2,0) tile 0 → (−2,−1) tile 34, same bells:

GatherClash(bell 3) · PostSeed(bell 3) · ResolveFromInputs(bell 3) · SettleDeparture(slot 0) · Reveal(slot 0, bell 6)
· PostAnchor(bell 0..5, region 8) and FastForward(destination 0→1 … 5→6) · GatherClash(destination bell 6, from 0)
· GatherClash(destination bell 6, from 20) · PostSeed(destination bell 6) · **ResolveFromInputs(destination bell 6)**
· SettleTransit(slot 0, bell 6)

The untouched neighbour was caught up by the legacy driver from bell 0. Every one of its quiet bells passed
FastForward's simulation. The origin driver touched none of its bells (asserted).

Both tests: no unknown outcome, no driver stop, and transit slot 0 free at the end. The program and the game rules
were not changed.

**Cleanup:** after each run, no listener on 41940–41947. The chains ended with the process. The logs stay at
`scratchpad/real-legacy-march.20261113*.log`, with no key, plaintext or salt in them.

### What this does not prove
- No battle: neither destination had a defender.
- No capture: capture is the siege, which stays closed (`heapConfirmed` / `pageBinding` false; see
  `FABLE-CONQUEST-OPENING-CONDITIONS-20261112.md`).
- Not the page's own Depart: the page side is tested key-free.
- Not the natural clock: the test chain's clock was moved by `advance`.
