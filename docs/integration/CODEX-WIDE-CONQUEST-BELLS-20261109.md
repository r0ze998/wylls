# Wide Free City combat and settlement primitives — 2026-11-09

Base: d102a21c347e0f5c9ed64a67ce8ad33b463edf74.
This increment connects actual wide combat to the existing siege rules and
prepares captured Holding initialization and terminal inventory cleanup.
It does not dispatch declaration, settlement, conquest-aware Resolve or close
commands. Original user-playable gameplay remains radius 128.

## Actual combat progression

`world_index::resolve::resolve_bell_with_conquest` is a separate opt-in pure
model API. It authenticates the table's full ProvinceKey/season against the
wide province, every prefix/entry pairing, canonical site mirrors, site_count,
initial-Free-City generation zero and the exact resolution cursor. Occupied
Holdings may have generation 254; capture of an occupied Holding is not added.
The caller still owes account owners/addresses, authenticated parameters and
seed/window evidence.

Execution preserves the original sequence: build and actual full-identity
clash, apply, reports, pending settlement, starting-owner territory score,
site transitions, keep transition, hourly snapshot, finish. Site reports are
matched to actual clash garrisons by full identity, never synthetic test reports.
A host removed by pending settlement still contributes its preceding combat
result, matching legacy semantics. Success uses the unchanged shared capture
writes; failure clears the source while retaining the rent/slot obligation.

Province and roster writes occur on scratch copies and the returned table is
validated again at the next cursor before either mutable input is committed.
The immutable table argument is never modified. Caller integration must commit
its returned table with the other account changes. Output is deliberately a
separate type; existing Resolve receipts/digests and old result structures are
unchanged. Old public build/step/resolve APIs still refuse active and CaptureDue
records and now also refuse failed KIND_NONE obligations/noncanonical context.
Canonical completed immunity is retained. Forts, caravans, packed/legacy host
identities and unsupported split/absorb operations remain refused.

## Captured Holding and inventory

`WideHolding::captured_free_city` returns a fresh 1,344-byte final Holding with
the existing Free City settlement kernel sequence, terrain-derived production,
tier storage caps/rates, captured generation/metadata, zero shield, current
Citizen faction and expelled flag. Full coordinates remain in the wide trailer;
no placement Decision is fabricated. The rent payer is an explicit authenticated
WideCaptureEscrow funder, never Citizen.TICKET_FUNDER. The constructor does not
bind a slot, debit escrow, settle a conquest, or authenticate external accounts.
It checks ring/site/generation/slot, faction/tier/tile and kernel timestamp
representability. Caller account/tag, mirror, terrain and capture-state checks
remain required. No new nation field or economic rule is introduced.

`WideCaptureEscrow::validate_inventory` checks exact season/world/Citizen/tag,
all escrow-owned reservation bits, empty active slots and incompatible pending
wide tickets, including empty escrow before first reservation. Existing paired
validation reuses it and retains both table-to-escrow and escrow-to-table checks.
`terminal_citizen_plan` returns scratch Citizen bytes clearing only owned pairs.
It preserves every unrelated byte, including legacy reservations and NFT data.
Active escrow requires a present authenticated Citizen; absent empty escrow is
a future handler case, not a fabricated Citizen. The existing terminal status
and grace checks and atomic account closure remain caller duties. No lamports
or actual accounts move in these helpers.

## Selected verification

Independent static review preceded every new test target. New test runtime
paths use literal public identities and terrain, byte codecs, scalar inventory
and economy arithmetic, shared conquest rules, full-identity combat, public
SHA256 and deterministic game randomness. The eleven selected existing Resolve
unit tests also invoke deterministic public terrain/camp generation. No private
key generation/derivation/signing, native-crypto test, fixture exporter, external
process or network call is reachable from these selected tests.

Compile-time graph audit remains `CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md`.
Manifests, dependencies, lockfiles, build scripts and configuration are unchanged;
the full cached archive rehash was not repeated. Non-login shell, installed
Cargo/Rust 1.89.0, offline/locked, two jobs and the existing native aarch64 target
cache were used without an explicit --target. No SBF, CI or deployment ran.

Passed on the final sources:

- wide_conquest_resolve: 9 new tests. Real neutral combat, success through next
  bell, defeat, cursor/retry refusal, full-identity/header/mirror negatives,
  before-settlement reports, old API gates, immunity and generation 254.
- world_index::resolve::tests: 11 existing selected tests.
- wide_captured_holding: 4 new tests, including all tiers, both slots, generations
  1/254, expelled states, terrain variants, distinct legacy/wide funders, bounds
  and day/timestamp handling.
- wide_conquest: 11 tests (3 new inventory/terminal tests plus the existing 8).
- conquest_site_transition (8), cq_conquest_model (14), cq_kernel_vectors (6):
  passed with world-index-experimental and again with no default features.
- wide_capture_guard_tests: 2 program tests passed; 239 unrelated tests filtered.
- Total: 65 distinct selected tests, 93 successful executions, zero failures.
- permutation-frontier library checks passed for default and
  wide-world-experimental. Existing unused Wide::at test-helper warning remains.
- Scoped formatting and git diff --check passed.

Commands, all prefixed with `cargo +1.89.0` and `--offline --locked`:

1. `test -p frontier-abi --features world-index-experimental --test wide_conquest_resolve -- --test-threads=1`
2. `test -p frontier-abi --features world-index-experimental --lib world_index::resolve::tests -- --test-threads=1`
3. `test -p frontier-abi --features world-index-experimental --test wide_captured_holding --test wide_conquest --test conquest_site_transition --test cq_conquest_model --test cq_kernel_vectors -- --test-threads=1`
4. `test -p frontier-abi --no-default-features --test conquest_site_transition --test cq_conquest_model --test cq_kernel_vectors -- --test-threads=1`
5. `test -p permutation-frontier --features wide-world-experimental --lib wide_capture_guard_tests -- --test-threads=1`
6. `check -p permutation-frontier --lib`, then with `--features wide-world-experimental`.

Reviewed and executed SHA256:

- conquest_model.rs: 7595aa46df4ee4c8f3609f6d1c5275e77e14a0ce6332d0b932753d534eae0da7
- world_index/resolve.rs: afc30f4a837003f2579cfa8e9fd160d458c5bc4134c70c17fb898c5d9d2d21a2
- tests/wide_conquest_resolve.rs: 58ea1be55c5a06667c24c16d93974ddae314e9cd0b7c197228abfb7acee690a1
- world_index/holding.rs: f2da3c4c325adfed879613e060c11d608a5da71c0ec9ac234d306bb3a593b770
- tests/wide_captured_holding.rs: d2b342968b08ca802acd630f66e7131bb196706e63272ad3fad23a4274715728
- world_index/conquest.rs: 3266b7981a54c1fb3e4e9df0bee72ee28ab4fbde24a87e5035a54dbd892b08dc
- tests/wide_conquest.rs: 06ed7d59ab547581f478c643ace9bfa2fe6a3e093772d7d206e8621a59a22cb7
- Cargo.lock: 87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9

## Remaining coherent runtime integration

Do not activate declaration by itself: an unresolved siege would freeze old
Resolve and orphan reservations. The complete initial-Free-City slice needs
canonical account validation, source economy/stake debit, lead selection by
full WideHostRef, paired rent reservation, actual conquest-aware Resolve with
arrival writes, failed/end-lapse settlement, successful capture with destination
funding and JoinShard counters, capped source gold credit, and terminal closes.
No ordinary cancellation or new economic decision is implied.

Current free provisional envelope positions are DA op5, DC op7/8/9 and DE
op3/4 (FF01 versioned envelopes, not the existing bare Close what3/4). These are
planning positions, not an external allocation. Successful capture changes two
Holdings: keep existing receipt attribution and use a target Province+Holding
receipt plus a separate source-Holding credit receipt, cross-bound by one
operation and complete commitments. An escrow-only close must not invent a
fake Province attribution. Its Citizen identity needs an explicit sidecar log
format. All relevant decoder, indexer and verifier consumers must be reviewed.

The existing Ended+72h/Aborted/tombstone cleanup guard applies. Escrow cleanup
clears active Citizen markers before CloseCitizen; source/province/table may
already be closed. Later settlement must never recreate a missing escrow.
Default/SBF, departure-debit, mixed-family and automatic-send gates are unchanged.
The separately held UI/Herald files and Node key-review metadata are unchanged.
