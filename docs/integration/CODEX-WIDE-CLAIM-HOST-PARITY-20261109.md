# Actual host claims against the independent checker

Date: 2026-11-09. Base: `685596f8`.

The new `wide_defence_parity_runtime_tests.rs` directly dispatches the actual
WideClaimDefence handler, captures its exact account images and log fields,
and passes those results to the independent `verify::wide_defence` checker.
This strengthens the preceding literal-state checks without exporting or
regenerating fixtures, adding dependencies, or changing program behavior.

## Captured evidence and limits

The test-only child path-includes the actual independent checker source.
It does not copy its implementation or import the frontier-node dependency
graph. The existing root ABI, rules and standard library satisfy its imports.
Its fee arithmetic remains independent of the handler and keeper planner.

Each call snapshots full data, balances, public keys, owners, executable flags
and invocation signer/writable flags before and after real host dispatch.
AccountInfo 3.1.1 exposes deprecated `_unused` in the former rent-epoch ABI
position; this value is copied exactly into the checker's legacy field. It is
padding evidence, not an assertion that a real rent epoch was observed.

A child-local syscall stub copies every `sol_log_data` field before judging
it. Each success must emit one call with exactly two fields. Both the prefix
and body passed to the checker are the captured bytes, not reconstructed
receipts. Every CPI attempt panics. All claims are already present, so the
audited successful branch cannot allocate or invoke another program.

The tests supply Clock timestamp/slot through the existing host clock hook;
the other unused Clock fields remain explicit literals. Rent is pinned to
the installed root program's 4.4 default (6,960, threshold 1.0, burn 50), and
the test asserts those values and the pool floor against that default.
Neither mechanism proves live sysvar provenance.

Synthetic signer flags are not cryptographic signatures. This evidence does
not establish chain-runtime enforcement, source authentication, allocation
CPI, transaction fees, full SettleTransit, receipt-to-history authentication
or full-Season replay. Production/SBF, departure-debit, automatic-write and
mixed-family gates are unchanged.

## Eight focused cases

1. Six actual slots, repeated live-anchor positions, exact post-images and
   captured receipt agree with the independent checker.
2. Three consecutive calls share the same keeper/pool/claim images and pay
   17, 8 and 0 against the existing 25 daily allowance. Region allowance
   resets each call; zero payment still consumes evidence.
3. A partial 7 payment, an explicitly supplied external refill, and a later
   17 payment leave actual-paid usage at 24. The refill is not represented
   as a verified transfer.
4. Region/day exhaustion and empty-pool cases distinguish the actual partial
   flag while preserving the required slot consumption and count increments.
5. Recorded created-day evidence increases the refund; the settled flag does
   not change its amount.
6. Every captured account data byte and each metadata/balance field is
   individually mutated in a copy and rejected by the checker.
7. Every captured receipt prefix/body byte, truncation and extension is
   rejected.
8. At the exact grace deadline, one slot below required lateness and zero
   eligible refund, both dispatcher and checker refuse. Account images stay
   unchanged, no log is emitted, and no rollback wrapper is involved. Empty
   receipt inputs confirm the checker rejects eligibility first.

## Source/build audit and results

The selected closure was inspected before execution: literal fixture/header
construction, public Season/address/world hashes, existing instruction
dispatch, the existing-claim handler, byte codecs, integer fee/cap/rent math,
AccountInfo borrow/copy operations, in-memory log capture and the independent
checker. No fixture exporter, lifecycle executor, private-key constructor or
derivation, signer, native proof, RPC or actual transaction is called.

No manifest, lock, feature, dependency, build-script or procedural-macro
change is introduced. The existing root audit
`CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md` covers the unchanged build graph;
the included checker adds ordinary Rust source, not a new build target or
runtime initializer. Root Cargo.lock remains
`87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.

With a non-login shell, native Apple aarch64 and two build jobs:

```sh
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 \
  cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_garrison::wide_defence_runtime_tests::wide_defence_parity:: \
  -- --test-threads=1
```

Result: **8 passed, 0 failed**, 0.17 seconds. The previously reviewed Garrison,
defence and cleanup prefix was then rerun with the new child included:
**61 passed, 0 failed**, 0.25 seconds. This also checks isolation from the
other host syscall stubs. Only the pre-existing unused `Wide::at` warning
appeared. No broad workspace/native-crypto suite or guard self-test ran.

The accompanying read-only Rent precision fix is documented in
`CODEX-WIDE-SNAPSHOT-RENT-20261109.md`: 8 pure arithmetic tests plus 18 claim
planner and 11 preview regressions passed. Together these are **98 unique
selected tests**, not a full game, production or whole-Season pass. Rustfmt
and `git diff --check` pass. No signing, transaction submission, deployment
or CI was executed.
