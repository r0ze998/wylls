# Independent Garrison replay and roster allocation

Date: 2026-11-09. Base: `269285b8e4255182046177bb9515d38ed89dafba`.
This slice adds one-transition verification and advances the existing gated
host lifecycle. It does not enable production wide worlds.

## Independent replay

`verify_core::wide_garrison::{stage, verify_transition}` is available only
under the existing `wide-economy-experimental` feature. It accepts only the
separate kind-17 Garrison receipt and checks:

- Exact record, snapshot identity, Season ruleset/version/status and bell.
- Citizen header, wide slot binding, holding state/order, site generation,
  capture lock, lazy finality, action bucket and owner-action timestamp.
- Unit-0 reserve debit, resident lag, chronological pending settlement with
  per-item clamps, garrison room/cap, same-bell merge and pending-slot insertion.
- Both receipt digests, both continued account chains, and every post-state
  byte, including fields the action must leave unchanged.

Garrison arithmetic is independently restated rather than calling the
program or `GarrisonState::change`. Existing independent verifier helpers
handle Season/bucket/finality and holding read/touch/write. The holding's
layout-version adapter changes only the two scratch version bytes, preserving
the wide trailer and shield. Numeric representability is checked before touch.

A successful result is about caller-supplied snapshots for one transition.
It does not prove account address/ownership, actor/session/NFT authority,
snapshot freshness or provenance, clock provenance, earlier/later transitions,
or the whole Season. `FULL_SEASON_REPLAY_SUPPORTED` and `Verified::full_season()`
remain false. The default whole-season verifier is unchanged and this module
is not installed as a passing season check.

## Actual-dispatch comparison without exporters

Six public receipt literals are pinned in
`frontier-node/crates/verify/tests/fixtures/wide_garrison_receipts.rs`.
They were captured from the audited direct host dispatch, then the host test
was changed to assert exact equality against the literals. No exporter ran
and no existing binary fixture was rewritten.

Both sides read the existing immutable `wide_economy/train` Season and post
snapshots as pre-state, setting only the Province's resolved-next bell to 723
in memory. Cases at bell 723 are:

1. Five troops queued from the trained reserve.
2. Another two troops queued in the same bell after case 1.
3. An intentionally reversed pair of older pending changes settles before
   five more troops are queued.
4. A due provisional holding becomes final while five troops are queued.
5. One older pending slot settles and the surviving current-bell slot merges
   with the new reinforcement without changing its slot position.
6. An extreme negative older delta safely clamps to zero, while the surviving
   current-bell slot retains its position and receives reinforcement.

Independent staging matches each actual receipt's input/output commitments
and chain links. Hash commitments bind the full synthetic states; this is
parity for these six exact fixtures, not universal or live-chain proof.
Other tests are explicitly self-consistency/adversarial checks, including
flipping every byte of all three supplied post-state accounts individually.

## Concrete handler fixes

### Prefunded roster rent

Resolve's preflight incorrectly required the payer to hold the full roster
rent even when the absent account was already prefunded. The new direct test
reproduced `Insufficient` on a target funded to rent minus 17 lamports with a
payer holding exactly 17. The allocator itself already uses the shortfall.

Preflight now uses `rent.saturating_sub(target.lamports())`, matching
`init::top_up`. The rent amount and immutable rent-recipient rule do not change.
Tests verify zero, partial, exact and excess prefunding. In this host Rent
configuration, a 3,248-byte roster needs 23,496,960 lamports.

Before allocation, Resolve also probes the eventual mutable Province,
ClashInputs and absent-roster data borrows, plus payer/roster lamport borrows.
Predictable conflicts now refuse before a funding transfer or allocation.
These probes are released before CPI, and actual output lengths/borrows are
checked again before the complete staged byte commit.

### Unrepresentable garrison room

The replay review exposed a malformed future pending delta of `i64::MIN`
that made the shared kernel's room subtraction overflow. A direct test
reproduced the panic in the old wide handler.

The wide handler now checks representability on a separate settled copy
before calling the original kernel change. Malformed unrepresentable state
returns `BadAccount` with no writes or logs. The shared kernel and ordinary
gameplay rules are unchanged. Regression coverage verifies that the check
does not reorder pending slots and still permits due extreme deltas that
the existing settle rule safely clamps.

## Allocation runtime coverage and safety audit

Three new tests reach actual Resolve dispatch and its optional allocation
through the existing host System-program stubs. They cover staying-arrival
identity pairing, new roster owner/size/rent, immutable rent recipient despite
a different resolver beneficiary, replay refusal, insufficient funds, chain
overflow and five retained data/lamport borrow conflicts followed by retry.

The newly reached allocator closure was statically reviewed before execution:
`init_with_seed -> top_up -> transfer -> invoke/invoke_signed` and
`allocate_with_seed`, the Solana CPI borrow checks and existing host stubs.
The stubs perform synthetic lamport arithmetic, backing-memory resizing and
owner assignment. PDA validation uses only public Season id/bump, SHA256 and
public-point decompression. No private key or cryptographic signature is
generated or derived. `invoke_signed` here is runtime PDA privilege checking,
not private-key signing.

The existing root Cargo 1.89 build audit and reader/verifier Cargo 1.95 build
audits apply to unchanged manifests, lockfiles, feature graph and config.
No new build script, procedural macro, constructor or runtime initializer was
added. Exact new verifier call paths use literal/immutable bytes, codecs,
independent arithmetic, public hashes and full byte comparison. Old fixtures
are included as bytes, not executed. Exporter variables stayed unset.

This remains a host simulation, not SBF/runtime enforcement or real drand,
signature, reveal or gather provenance. Allocation failures inside the
System operation itself retain the real runtime's transaction-rollback
boundary; the host stub is not a replacement for that runtime guarantee.

## Validation

- Final focused program aggregate: **22 passed**, 171 filtered out.
- Independent Garrison unit tests: **4 passed**.
- Independent Garrison integration tests: **7 passed**.
- Rustfmt and `git diff --check` pass. Only the pre-existing unused `Wide::at`
  warning remains in the host program target.

Commands, with `WS19_GOLDEN_WRITE` and `WYLLS_WIDE_ECONOMY_FIXTURES_DIR` unset,
`CARGO_BUILD_JOBS=2`, native aarch64, non-login shell:

```sh
# Repository root
cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_garrison:: -- --test-threads=1
# frontier-node
cargo +1.95.0 test --offline --locked -p verify \
  --features wide-economy-experimental --lib wide_garrison::tests::
cargo +1.95.0 test --offline --locked -p verify \
  --features wide-economy-experimental --test wide_garrison
```

No key generation/private derivation/signing, native-crypto suite, guard
self-test, fixture exporter, real transaction, deployment or CI ran. Browser
and Node source did not change and their suites were not rerun. SBF exclusion,
experimental version/Season creation, departure-debit, automatic-write and
mixed-family gates remain in place. Complete wide-world/Season replay and the
gated production lifecycle remain unfinished.
