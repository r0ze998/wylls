# Wide economy scope: S1 parity preview over wide holdings (2026-11-08)

Engineering report for branch `work/wide-economy-scope-20261108`, base `17b8ffaa`.

Files in the slice, and nothing else:

- `permutation-frontier/src/proc/wide_economy.rs` (new module)
- `permutation-frontier/src/proc/wide_economy_tests.rs` (new fixed-data tests)
- `permutation-frontier/src/proc/mod.rs` (module registration only)
- this report

No keeper, live-wide, legacy handler, existing test, UI or chain artefact was
modified. This is a source report, not a product spec: it records what was
researched, what was built, how it was checked, and what remains before any
wide economic action can execute.

## 1. Researched S1 parity

The active S1 build is `RULESET_HASH_V3`, program 4, with the wide bit `0x4000`.
Custody and wide together are a compile error, so the wide economy has exactly
one ruleset to match.

The S1 owner-action bodies the wide preview reuses, by source slice:

- `proc/holding.rs` 482-520 `touch` (settle stores, dormancy, owner-action fields);
  528-548 `copy_number`.
- `proc/holding.rs` 710-795 Build: costs and seconds from `arms::building`,
  doctrine from `of_faction_v3`; the intro-build flag is "existing only", never
  set anew by this path.
- `proc/holding.rs` 931-935 Train: uses `arms::train_v3`. A stale comment still
  names `train_v2`; the comment is not governing behaviour and was not changed.
- Wide founding `proc/wide.rs` 1798-1819 calls `citizen::founded_outpost`
  (`proc/citizen.rs` 1520-1527) with terrain ore and no starter kit.
- Wide holding record: 1,280-byte Holding v2 prefix, unchanged layout, plus a
  64-byte trailer.

Parity finding: arithmetic, costs, yields, queue order, dormancy, workshop
conversion and the immediate whole-troop reserve credit are identical between a
legacy holding and the wide prefix. The economics of this slice uniquely reuse
S1; no new economic rule was needed to stage the three actions over a wide
record. No balance bug was found in the reused source.

## 2. Implementation

`wide_economy::preview(holding, province, pins, clock, action)` stages one
action over detached `Vec` copies and returns a `Preview`. Inputs are
immutable byte slices plus a `Pins` struct carrying every identity field
(season, world, coordinate, site, generation, slot, owner Citizen) and a
`Clock` (genesis and now). Pins are compared to the bytes; a mismatch refuses,
it never corrects.

Validation, in the preview's own order: both records decode via
`WideHolding::read` and `WideProvince::read`; every pin equals the record;
province and holding name the same season, world and coordinate; prefix
`order` equals the slot; holding is live; the v2 capture lock on the site mirror
is clear; the mirror shows this holding at this generation; the bell exists.
Then `finality_due` is evaluated over the staged copy and the action body runs.
The deployed handlers interleave account loading, authorisation and argument
checks, so which refusal wins for a given invalid input can differ between a
preview and execution. The preview does not claim the deployed order.

Actions: Harvest, all nine Build items (0-5 buildings, 6 walls, 7 tier-up,
8 workshop) and Train. Walls and tier-up also stage the province site mirror
write, so `Preview.province` is `Some` only for those two items. Outputs carry
cost in milli-units, `done_at` for Build, post-credit `reserve` for Train,
`became_final` and `now_bell`. No transaction bytes are produced.

### Mirror consumption (reviewer verified)

- `world_index/resolve.rs` 510-512 reads the wall flag; 1018-1019 `write_snapshot`
  feeds `conquest_model.rs` 585-598 `control_weights`, then 879-885 applies
  `TIER_NEXT` when effective bell is at or before the current bell.
- Real caller: `proc/wide.rs` 3221 resolve, 3332 `resolve_bell`, commit at 3406.
- Wall bonus is combat only. Forts, caravans and conquest records remain refused
  at `resolve.rs` 286-299.
- Tier affects the control snapshot, not the direct keep province-bell score in
  `score_territory`.
- Pending mirror records are interpreted on read. Build folds at
  `resolved_next`; no new schedule is introduced.

## 3. Identity, snapshot and purity caveats

A passing preview proves only that the bytes pass the listed identity and
state checks against the caller's pins. It is not a proof that every field of
either record is self-consistent, that either account exists at its canonical
address, that the snapshot is fresh, that the named Citizen owns anything now,
or that anyone is authorised to act.

Explicitly not performed: Season authentication (PDA, Running status, ruleset
hash, end bell, wide marker, bound world); canonical address derivation;
program-owner check; Citizen binding, action bucket, flags or last action;
signature, session or NFT resident proof; freshness against the chain; event
emission; any dispatch route.

The all-action mirror match (holding and generation shown on the site mirror)
is structural malformed-snapshot validation. That one check is stricter than
the deployed Harvest and Train, which do not read the mirror. This does not
make the preview as a whole at least as strict as execution: the
authorisation, live-season and action-bucket checks above are omitted, so a
passing preview can correspond to an execution that refuses, and a preview
refusal is not proof that execution would refuse.

Purity: the module is a host-only, detached preview. No state is mutated, no
CPI, signature or transaction is performed, and the caller's slices are never
written. The kernel diagnostic calls reachable through the existing helpers
(`error.rs` 112-117) are no-ops on the native host, and the wide feature is
forbidden on the Solana target (`lib.rs` 49-50). Any future target support
must revisit this purity claim rather than inherit it.

## 4. Unfinished execution integration

The following are required before any wide economic action can run on chain.
None is started in this slice.

- Canonical wide loading with `player_start_as` and `require_wide_season`.
- Failure-atomic action-bucket effects on the Citizen.
- Wire, account and resident protocol for the three actions over wide records.
- Wide economic event definitions, with replay, verifier, herald and UI support.
  Numeric event and wire allocation was not attempted here; it is an engineering
  integration boundary.
- Never route wide actions through legacy tags, magic, PQ0 or PS2.

DEPART gates and all current UI read-only guards are unchanged. The result is
not a playable wide economy and carries no chain proof.

## 5. Rules outside this slice

No new wide bonus, prices, starter kit or training schedule was introduced.
Broader rules on keep, FreeCity, camp, region, prize and funding are untouched
and outside this slice; nothing here decides or reopens them. The legacy
`train_v2` comment was left as found.

## 6. Tests

The fixed-data tests in `proc::wide_economy::tests` use literal wide holding
and province byte images. Qualifications that apply to all of them:

- The province helper is a minimal decoder/preview fixture, not a generated or
  gameplay-valid Province: terrain, site count and the other mirrors start
  at zero. Cohorts start empty and finality tests populate them explicitly;
  finality reads those records. The tier-next field starts at zero rather
  than the generated sentinel. These are not Resolve integration fixtures.
- Comparisons against the "deployed" helpers reconstruct the economic substeps
  with the same `proc::holding` helpers the module calls. They are neither
  handler execution nor an independent oracle.
- Some wall-cap mirror states are synthetic branch states for the fold cap,
  not shown reachable through the deployed writers.
- The preserved stale payload of a free transit record shows the transit block
  is not written. It is not a test of an active transit's lifecycle.
- The field-preservation test covers one representative action of each kind,
  not every item or branch, and is named accordingly.

Three regression tests were added in this revision. They are part of the 27
that passed in section 7:

- `build_walls_and_tier_up_refuse_a_mirror_bell_overflow_after_pay_and_enqueue`:
  genesis chosen so `now` is bell `u32::MAX`; walls and tier-up return
  `Overflow` after pay and enqueue on the copy, both snapshots unchanged; a
  building still previews.
- `due_provisional_flip_is_discarded_with_a_refused_action_and_the_snapshot_keeps_its_state`:
  a due provisional flip followed by an insufficient-store or bad-item refusal
  returns `Err`, with the caller's bytes and state byte exactly as supplied.
- `build_workshop_and_tier_up_keep_the_intro_flag_an_ordinary_building_consumes`:
  the workshop and the tier-up leave an existing intro-build flag set and take
  their own time; an ordinary building takes the intro time and clears it.

## 7. Validation (final, honest)

Verified after the last source edit and after rustfmt, offline, `--locked`,
with the dedicated target directory `/tmp/wylls-wide-economy-target-20261108`
without modifying or repurposing an existing shared build target:

- Rust 1.89.0: `proc::wide_economy::tests`, 27 of 27 passed. This is the 24
  baseline tests plus the 3 regression tests listed in section 6.
- Rust 1.89.0: `proc::holding::tests`, 4 of 4 passed. These are the existing
  pure codec, copy, tier and geometry tests in the holding module. They are
  unchanged regression checks, not new coverage or executions of handlers.
- Rust 1.89.0: library clippy with `--features wide-world-experimental --lib
  -- -D warnings` passed.
- Rust 1.89.0: library `check` with default features passed.
- Rust 1.95 (earlier, before the final edits): library `check` passed with the
  feature on and with default features.
- rustfmt 1.89 was applied only to the new module, the new tests and the
  module registration, with `skip_children = true`. `git diff --check` passed.
- Dedicated target directory size after the runs: 515 MiB. Free disk: 14 GiB.

Independent source review covered S1 reuse, failure atomicity, identity
checks, mirror consumption and the final three regressions. No blocking
issue remained after the documentation refinements. The reviewer did not
execute tests; the run results above were verified separately.

Known noise, none of it in the new code and none fixed here:

- The native test build reports 9 unused-code warnings in unchanged
  `crypto/quick.rs` and `wide_land_runtime_tests.rs`.
- Rust 1.95 clippy fails on 7 `manual_is_multiple_of` lints, a newer lint, in
  unchanged `permutation-rules` source. The pinned 1.89 clippy is the gate.

Not run, and not claimed:

- No full suite, CI, SBF build, browser fixture or chain test. "All tests
  clean" and "CI green" are not asserted by this report.
- No keys, signatures, dispatch, send, deploy or push. The tests use the
  synthetic fixtures qualified in section 6, and the execution integration in
  section 4 remains unfinished.

Reproduction, pinned to 1.89.0, with the dedicated target directory:

```
cargo +1.89.0 test --locked --offline -p permutation-frontier \
  --features wide-world-experimental --lib proc::wide_economy::tests:: \
  --target-dir /tmp/wylls-wide-economy-target-20261108 -- --test-threads=1

cargo +1.89.0 test --locked --offline -p permutation-frontier \
  --features wide-world-experimental --lib proc::holding::tests:: \
  --target-dir /tmp/wylls-wide-economy-target-20261108 -- --test-threads=1

cargo +1.89.0 clippy --locked --offline -p permutation-frontier \
  --features wide-world-experimental --lib \
  --target-dir /tmp/wylls-wide-economy-target-20261108 -- -D warnings

cargo +1.89.0 check --locked --offline -p permutation-frontier --lib \
  --target-dir /tmp/wylls-wide-economy-target-20261108
```
