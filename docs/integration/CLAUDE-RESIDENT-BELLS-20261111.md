# Resident bells after arrival settlement (source only), 2026-11-11

Owner: claude2 map worktree (`/Users/r0ze/Projects/wylls-claude2-map-20261110`). Not built, not run, not
integrated, no commit or push. Fable owns the resident local-play route and UI; nothing of that is touched here.

## Purpose

The return path the program already has is: OwnerDissolve (the player's own signed resident Dissolve, sent by
the UI) → the wide Resolve of the Dissolve's bell, which departs the row (ResolveVoluntaryLeave) →
ReturnOriginalReserve. Return refuses `TooEarly` unless the standing province's `resolved_next > pend_bell`
(`permutation-frontier/src/proc/wide_expedition_resident.rs`, `execute_return`).

In local play, nothing resolved (129, 0) after the arrival. The keeper's FastForward serves only the home
(`keeper_loop.rs`, `fast_forward_ix(.., HOME.0, HOME.1, ..)`), and the destination driver ends at its member
settlement. This change adds that missing continuation as an independent driver.

## Change

- **New `frontier-node/crates/itest/src/resident_bells.rs`.** Each step sends at most one real transaction,
  simulated first:
  - `PostAnchor` of the ended bell in the destination region (a public Quicknet round, verified);
  - once the bell's reveal window has closed, `PostSeed`;
  - then the wide `Resolve` of `resolved_next` (the 9 accounts of `wide_ix::RESOLVE`).
- **Gates.** It acts only when both hold:
  - a resident of the watched Holding stands in (129, 0). This is read from the program-owned WideRoster,
    which must pass `validate_paired` against the Province entry table, and the resident host's canonical
    Holding must be the watched one;
  - no transit record of the watched Holding exists, so it never races the origin or destination driver.
- **Refusals.**
  - A bell with arrivals (a ClashInputs, or its ArrivalDay bit) is reported as `Blocked` and not driven.
  - Bells at or after the Season's `end_bell` are idle.
  - A program refusal or an unknown outcome stops this driver alone, for good; nothing is resent.
- **`keeper_loop.rs`.**
  - `Pilot` gets `resident: Option<ResidentBells>`, created with its own fresh faucet-funded in-memory payer
    whenever a holding is watched. It is stepped once per tick after the destination driver.
  - `Status.resident_step` is added to the status JSON.
- **`lib.rs`.** Declares the module (feature `localnet-expedition-play`).
- **Not changed (frozen):**
  - `destination_driver.rs` `f1264075…`
  - `expedition_play.rs` `a19c7ab7…`
  - every chain rule, every binary, and the SBF artifact.
- **Not added:**
  - no Gather;
  - no march to another province;
  - no wallet signing (the Dissolve stays the player's);
  - no direct state write;
  - no new game rule.

## Tests (unit, not yet compiled)

All three are pure planning or account-shape tests. They are not evidence that the program accepts these
transactions on real SBF.

| Test | What it checks |
|---|---|
| `only_quiet_ended_bells_of_a_settled_resident_are_driven` | Pure plan: Resolve, Seed, Anchor and Wait order; Idle for no resident, a live transit, or the season's end; Blocked for arrival bells. |
| `the_resolve_has_the_wide_resolve_tables_shape` | Each role key against `wide_ix::RESOLVE` via `position_in`; signer and writable roles. |
| `a_paired_roster_names_the_watched_holdings_resident_only` | Synthetic WideRoster and entry table written with the abi's own codecs; only the watched Holding's host counts; an unpaired table is refused. |
| `no_destination_no_roster_and_no_transit_mean_idle` | No destination, a foreign roster account refused, transit detection. |

Still unverified:

- A real-SBF ignored test of Dissolve → Resolve → Return. Its natural extension is `destination_real.rs`
  after SettleMember, with the test player's in-memory key signing the Dissolve as the player.
- That the voluntary-leave bell needs nothing beyond a quiet Resolve.

## Known follow-up

The `--keeper` metadata text in `expedition_play.rs` (frozen) does not yet mention the resident bells. Update it
when that file is unfrozen, or the runner's metadata understates what `--keeper` does.

## Hashes

Baseline, from the start snapshot, equal to main's current files:

- `keeper_loop.rs` `499ce4fb3839e540b4e440132539880c1832e5978d520258596b19516e3442cd`
- `lib.rs` `1f5f91f20e63be1222ffa0cd2bae4f8336faa8540766fa4863f42daaa8e97d97`

After:

- `resident_bells.rs` (new) `d11c609e8f0a40b59e22ef6f80d0866c759729255d73295990fb4af10bffc49f`
- `keeper_loop.rs` `20afbca83fad023783c5a0ff2076a1c338f0246a1222cd47870f01d7ee207579`
- `lib.rs` `daf83d0dc6dd89b06e31272068213c0d6a1cd5d2866b4bebc568a638810d9d05`

Patch, from the snapshot, three files only: `docs/integration/CLAUDE-RESIDENT-BELLS-20261111.patch`
`cac3ebf14fdb9e06f39b6f5975bef92dc35e5dcd73b84114197069419f609a5a`.

## Guarded check run, 2026-11-11 12:35–12:38 UTC (approved)

Run conditions:

- A NEW dedicated target, outside the repo:
  `/private/tmp/claude-501/-Users-r0ze-Projects-wylls-claude2-map-20261110/11b8895c-dfee-43bf-bfdb-871808b380c4/scratchpad/target-resident`.
- `CARGO_INCREMENTAL=0`, dev and test debuginfo off, `--offline --locked`.
- Guard: stop at 4 GiB of target, 20 GiB free, or 30 minutes. Delete nothing.
- The existing target, the binaries (runner `9e96afaf…`, herald, prepare), the SBF artifact and every runtime were
  untouched. No new SBF build.

Results:

- **Compile:** `cargo test -p itest --features localnet-expedition-play --lib --no-run` passed in 61 s with zero
  warnings. The target peaked at 810 MiB (829,672 KiB). Free space went from 38.8 to 38.0 GiB.
- **Focused tests:** `resident_bells:: keeper_loop:: destination_driver::` gave **24 passed, 0 failed,
  5 ignored**, in 0.62 s.
  - The 4 new resident tests passed.
  - All non-ignored keeper and driver tests passed, including `a_pilot_stopped_before_start_funds_nothing`
    with the new resident payer.
  - The 5 ignored tests (real artifact or public drand) were NOT run.
- Logs: `resident-compile.log` and `resident-tests.log` in the same scratchpad. Guard script: `resident-guard.sh`.

What this proves: type-correctness, and pure planning and account-shape behaviour on synthetic bytes. It does
NOT prove real-SBF acceptance of the resident PostAnchor, PostSeed or Resolve, nor the Dissolve → Resolve →
Return chain, nor any browser behaviour. None of those were run.

## Build needed (superseded by the guarded run above for the check; no runner relink was done)

The minimal check is the same shape as before: `cargo test --offline --locked -p itest --features
localnet-expedition-play --lib resident_bells:: --no-run -j1`, in the existing target, then the focused tests.

- Only the itest lib and its test harness recompile; no dependency changes.
- Previous comparable steps measured about 38 MiB for a compile stopped by errors, and 382 MiB cumulative peak
  for compile, test and runner relink.
- Expected increment: about 50–150 MiB without a relink. A runner relink to a NEW output path adds about 20 MiB.
- Do not relink over the `9e96afaf…` runner that is in use.
