# Wide snapshot Rent arithmetic alignment — 2026-11-09

## Confirmed defect and scope

Base publication: `685596f8`. The keeper's read-only
`widesnapshot::RentSysvar::minimum_balance` used an `f64` intermediate for
every threshold and only checked the particular account's integer product.
The program's root lock instead selects `solana-rent 4.4.0`, whose
`try_minimum_balance`:

- Refuses account data larger than 10,485,760 bytes, including free rent.
- For threshold 1.0, refuses rates above 1,759,197,129,867.
- For threshold 2.0, refuses rates above 879,598,564,933.
- Computes those two cases in integers, without an `f64` intermediate.

Those rate bounds are global: floor(`u64::MAX / (10 MiB + 128) / multiplier`),
not a bound based only on this account. For example, rate 1,759,197,129,868
with threshold 1.0 and zero data length previously produced a keeper minimum
of 225,177,232,623,104 even though the program's Rent helper rejects the rate.
At rate 1,073,741,825 and data length 8,388,609, the exact minimum is
9,007,337,775,825,025 for threshold 1.0 and 18,014,675,551,650,050 for 2.0.
The previous floating-point path loses one or two lamports respectively.

The changed helper returns `None` instead of admitting would-panic runtime
inputs, and preserves all integer bits for the standard thresholds. Its
`Option<u64>` interface and existing callers stay unchanged. The claim
planner, fee review and settlement planner already turn `None` into their
existing overflow refusals. No new error, rule, admission path or dependency
is introduced.

## Source comparison and compatibility boundary

The exact installed source reviewed was
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/solana-rent-4.4.0/src/lib.rs`.
Its SHA256 is
`84e53b630ec4be7d6fbf83bd9d04440f626f24f2086f803c7ec6ce055bb30a14`.
Both `try_minimum_balance` and `minimum_balance_unchecked`, their private
limits, and their threshold byte constants were inspected. The new
`verify/src/wide_defence.rs` model independently uses the same integer cases
and global bounds; it is not imported or called by the keeper tests.

Only exact 1.0 and 2.0 thresholds take the integer branch. Numeric equality
to these two finite nonzero values has the same classification as the
runtime's comparison of their little-endian bytes. The maximum-space check
applies to every threshold. For all other thresholds at supported lengths,
the previous keeper fallback is unchanged: checked `u64` multiplication,
conversion to `f64`, multiplication by the threshold, rejection of
non-finite/negative results or values at/above `u64::MAX as f64`, then
truncation. Overflow is not silently changed to saturation, and an
overflowing integer intermediate still refuses even with a zero threshold.
The standard-threshold rate caps are not newly applied to nonstandard cases.

This intentionally does not promise full nonstandard-threshold runtime
parity: solana-rent's host path permits saturating float-to-integer behavior
and its BPF branch panics for nonstandard thresholds. Broadening the
keeper's historical conservative fallback is outside this fix.

Rent encoding/decoding, field names, burn-percent treatment, snapshot
provenance/digest, sysvar validation, RPC and all callers are unmodified.
Out-of-range arithmetic parameters can still decode as well-formed Rent
bytes; they refuse only when a minimum is requested. The frontier-node lock
still has solana-rent 4.3.0 through localnet. This fix models the actual root
program's 4.4.0 source without changing either dependency graph.

## Focused runtime closure audit

The new `widesnapshot::rent_math_tests` module has eight tests:

1. Ordinary minima agree for the 6,960 × 1.0 and 3,480 × 2.0 defaults.
2. An odd per-year product above 2^53 retains its exact integer value.
3. Literal maximum rates are accepted at zero, one, maximum-minus-one and
   maximum data lengths, including results above `i64::MAX`.
4. Maximum-plus-one rates refuse even for empty accounts; `u64::MAX` rates
   also refuse.
5. All supported or legacy fractional thresholds refuse oversized accounts,
   including zero-rate cases and `usize::MAX`.
6. Fractional truncation, positive/negative zero and the conservative
   nonstandard intermediate/result overflow refusals remain unchanged.
7. NaN, infinite, negative and out-of-range floating results refuse.
8. A finite Rent record with an invalid rate still round-trips its bytes,
   then refuses arithmetic.

All eight test bodies and their only fixture helper, `rent`, were inspected.
`rent` is a literal struct constructor. The reachable implementation is
`minimum_balance` and, in the last test, the existing 17-byte `encode` and
`decode`. These perform scalar comparison, checked arithmetic, `u128`
reference arithmetic, fixed-array copies and numeric byte conversion only.
The tests use built-in Rust test/assertion macros and standard-library
conversion/float methods. No fixture file, public-address derivation,
hashing, private key, signing, randomness, testkit, account handler, native
crypto, live sysvar, RPC, socket, process, transaction or keeper runtime is
reached. No constructor section, procedural macro, build script, lazy global
or thread-local initializer is added. Existing unrelated keeper test bodies
are not selected by the unique module filter and are not authorized by this
review.

## Unchanged build graph and execution status

The selected feature and package are the previously audited keeper library
with `wide-world-experimental`. Read-only source comparisons against
`685596f8` show no manifest, lockfile, build script, Cargo configuration or
toolchain delta. Comparing those files against the reader-build audit base
`b7f733b545b06a311b76f8285d30149e52412910` shows only the already-reviewed
claim-preview binary registration, with no dependency or feature change.
The test command below selects `--lib`, not that binary.

The existing build review is
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md`, supplemented by
`CODEX-RUST-MAP-AUDIT-20261109.md` and
`CODEX-WIDE-CLAIM-PREVIEW-20261109.md`. The earlier selected graph contains
380 packages, 33 build scripts and 31 procedural-macro crates. Those are
previous audit counts, not a fresh Cargo resolution performed for this patch.
The unchanged local `agents/build.rs` was reread in full: it transforms fixed
simulator source text into an OUT_DIR file using only std. Its generated
simulator is not executed by this selected library test.

Current lock SHA256 values remain:

- Root: `87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.
- Frontier node: `ba8f0e3f3a6a1451ed90ea6567e828232899d352eafec2eccc35edcad9291499`.

After final static source/build/runtime review, **8 focused Rent tests
passed, 0 failed, 155 filtered out**. The previously audited claim planner
target (18 tests) and synthetic-source preview target (11 tests) also passed.
Rustfmt and `git diff --check` pass. No exporter, live sysvar/RPC, key operation,
signing, transaction, keeper daemon or CI ran. Prior build audits do not
certify changed external cache contents or environment overrides.

Executed exact command, after that final review, from `frontier-node`
in the inspected non-login shell on the native Apple aarch64 host:

```sh
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR \
  CARGO_BUILD_JOBS=2 cargo +1.95.0 test --offline --locked \
  -p keeper --lib --features wide-world-experimental \
  widesnapshot::rent_math_tests:: -- --test-threads=1
```

Selection: eight tests. Do not replace this filter with the full
keeper suite, a broad widesnapshot integration target, native-crypto tests,
transaction tests, guards, fixture exporters or CI. This report does not
authorize any such execution. The root host-parity changes are documented
separately in `CODEX-WIDE-CLAIM-HOST-PARITY-20261109.md`.
