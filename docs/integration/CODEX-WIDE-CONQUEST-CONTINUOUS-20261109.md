# Continuous wide siege/capture host lifecycle — 2026-11-09

Base: 8579bdbd1c72aceffb9e37198c040561c44c7d62.
This test-only increment closes the gap between separately seeded declaration,
capture and terminal fixtures. It does not change runtime game behavior, public
activation, verification acceptance, or the separate pending UI changes.

## Continuous scenarios

Two new tests execute three successful scenarios:

1. An existing conquest table and retained capture escrow.
2. Both sidecars initially absent, with partial lamport prefunding.
3. Both sidecars initially absent, with more than their rent minimum prefunded.

The same backing Citizen, source Holding, Province, roster, conquest table,
capture escrow and destination Holding survive real private declaration,
actual combat Resolve bells, capture settlement, table close and escrow close.
No intermediate siege reports, CaptureDue state, ownership mirror or reservation
are injected. Canonical empty per-bell clash inputs, cache and anchor evidence
are fixture inputs; beacon provenance is not established. The terminal Season
status and clock are staged, rather than invoking EndSeason.

Assertions cover exact payer debit, retained immutable identities, actual
allocation ownership/size, unique-account lamport conservation, single source
gold credit with no arms refund, destination prefunding, Citizen slot binding,
holding counters, completion-based immunity, retained escrow refund and retry
refusal without writes/logs. Successful creation uses a narrowly bounded host
System stub for Transfer opcode2 and AllocateWithSeed opcode9. It validates
instruction account metadata, roles, permissions, exact allowed destinations,
empty Transfer seeds, the canonical public Season PDA tuple and three fixed
allocation sizes. No private signature is generated or checked.

Declaration and capture receipt commitments are recomputed from live before/
after manifests using the same production receipt helper. Their paired records
must match. Resolve receipts are counted and included in three complete event
chain checks; they are not separately recomputed. The final escrow-close sidecar
is decoded but not fully recomputed. This is handler integration coverage, not
independent semantic replay.

## Harness changes and scope

The declaration fixture now has runtime-compatible resize padding. Shared test
helpers have test-only visibility. Clock parameters are initialized before
first declaration and stay unchanged between subsequent operation receipts.
The only production-file diff is visibility of a cfg(test) module.

The public lifecycle gate remains false, including its dispatch refusal tests.
No production/SBF, departure-debit, mixed-family, automatic-send or security
review gate changed. Unexpected CPI failures still require transaction rollback;
this host stub does not simulate a complete chain runtime. Continuous defeat/
lapse branches, real NFT authentication, browser gameplay and legacy-to-wide
entry are not covered by these new successful scenarios.

## Static audit and execution

Independent read-only review verified all four source hashes below and traced
the two new tests, changed allocator/clock helpers, existing exec/settlement
calls and bounded syscall stubs. Runtime closure uses literal identities, public
PDA/with-seed/SHA256 operations, byte codecs, deterministic game combat/economy,
account memory and static signer flags. It reaches no private-key generation,
private derivation/signing, native-crypto test, guard self-test, exporter,
network or subprocess. The prior root build graph audit remains applicable;
no manifest, dependency, lock, build script or configuration changed. Full cache
rehashing was not repeated.

Executed with installed Rust/Cargo1.89.0, a non-login shell, offline/locked mode,
two jobs, existing native aarch64 cache and no explicit --target. Both fixture
export variables were unset. The following exact filters passed with
--test-threads=1 and --features wide-world-experimental --lib:

- proc::wide::conquest_exec::tests:: — 6 passed.
- proc::wide::conquest_settle_exec::tests:: — 18 passed, including the two new
  lifecycle tests and 16 existing settlement tests.

Total: 24 distinct selected tests passed, zero failures. This is two newly added
tests, not 24 new tests. Broad suites were not executed. Existing unused Wide::at
warning remains. Scoped rustfmt and git diff --check passed. No CI, SBF build,
transaction, signing or deployment ran.

## Source SHA-256

- permutation-frontier/src/proc/wide_conquest_exec.rs: 12281d2bcd3be1fdf2817d623c0d7478114b1e1994f8423876117006c2704026
- permutation-frontier/src/proc/wide_conquest_exec_tests.rs: fae1baff10609a619c7a73a2260701add148012299f73a5a0586950023b25499
- permutation-frontier/src/proc/wide_conquest_settle_tests.rs: 6971a75cfd1a4cfc6301450b1bead2edd257a0e44bd829487677583ac9324cf6
- permutation-frontier/src/proc/wide_conquest_lifecycle_tests.rs: a28da3b83aa89b42b4dba65c0b2524ab2407824d34b5e6248b6947ad591b31ef
