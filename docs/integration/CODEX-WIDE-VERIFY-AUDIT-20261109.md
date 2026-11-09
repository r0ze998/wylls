# Wide verifier source and execution audit — 2026-11-09

## Scope

Base checkout: `590dcd23f81ccc557d0e7309867fa51048f591bc`. This audit covers
the changed `frontier-node/crates/verify/src/checks/vw_chains.rs` and only its
14 named module tests on `aarch64-apple-darwin`. It supplements
`CODEX-RUST-MAP-AUDIT-20261109.md`; that report alone did not cover this target.

The read-only verifier now discards failed CPI subtrees before decoding their
PSW1 data, including successful grandchildren. Retained wide data requires
complete, matching invocation frames. Frame errors alone do not turn empty,
foreign, unframed, legacy-only, or known rolled-back data into a wide season.
Final chain headers are matched by entity type and complete canonical key,
including all 32 WorldId bytes, rather than by a display label. These changes
do not select gameplay rules or enable an execution path.

## Build-time delta

Read-only, offline, locked dependency discovery compared the prior target's
current graph (`herald`, default features) with `verify` plus
`wide-world-experimental`:

```sh
cargo +1.95.0 tree --offline --locked -p herald --target aarch64-apple-darwin --edges normal,build,dev --prefix none --format '{p}|{f}'
cargo +1.95.0 tree --offline --locked -p verify --features wide-world-experimental --target aarch64-apple-darwin --edges normal,build,dev --prefix none --format '{p}|{f}'
cargo +1.95.0 metadata --offline --locked --features verify/wide-world-experimental --format-version 1 --filter-platform aarch64-apple-darwin
```

- Each selected graph contains 385 packages. The only package substitution is
  the local root `herald` for local `verify`. There are no new external packages.
- All external package feature sets match. The only shared-package feature
  delta is `frontier-abi/world-index-experimental`, an empty feature enabling
  local Rust modules, with no dependency, build script or procedural macro.
- The graph still contains 33 build scripts and 31 procedural-macro crates.
  All seven selected local packages have neither kind of target. Their
  compile-time execution remains within the earlier audit's external paths.
- All 378 external cached archives were rechecked against their `Cargo.lock`
  SHA256. All 11,365 regular archive members matched the selected extracted
  sources. No missing archive, member mismatch, symlink or unexpected source
  file was found. Cargo marker files were excluded as in the earlier audit.
- No manifest, lockfile, compiler wrapper, linker override or native-build
  environment change is introduced. The inspected Cargo configuration only
  sets output directories. Cargo/Rust/Rustfmt use the installed 1.95.0
  toolchain; native tools resolve to `/usr/bin`, and `emcc` is absent.

This is source/feature/cache comparison against the previous audit, not an
independent certification of the installed compiler, Apple tools or standard
library, nor a new unrestricted build-script audit.

## Runtime closure

The filtered tests call this module's parser, `judge`, `walk`, identity helpers
and fixture helpers. Their reachable nonstandard code consists of ABI event
encoding/decoding and public chain hashing; coordinate/key codecs; wide holding
and province byte readers; and base64/hex conversion. Native public SHA256 uses
`permutation_rules::hash::sha256` and `sha2`. There is no key generation,
private-key derivation, signing, public-address derivation, program dispatch,
RPC, socket, process launch, account creation or transaction submission in
these runtime paths.

The world-isolation regression includes three existing immutable wall fixture
files with `include_bytes!`: `record.bin`, `holding_post.bin` and
`province_post.bin` under `verify/tests/fixtures/wide_economy/wall/`. Mutations
occur only in memory. No exporter is invoked and no fixture is regenerated.
Those fixtures originated in host dispatch with simulated signer flags; they
do not establish real-chain authentication.

No runtime constructor, initializer section, thread-local initializer or lazy
global was found in the selected verifier source or newly enabled ABI modules.
Other verifier tests and fixture helpers include key operations but are not
selected or called by these tests. This audit does not authorize them.

## Validation command and result

Run from `frontier-node`, with a non-login shell:

```sh
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 cargo +1.95.0 test --offline --locked -p verify --features wide-world-experimental --lib checks::vw_chains::tests:: -- --test-threads=1
```

After final source review, this exact command completed successfully:
**14 passed, 0 failed, 58 filtered out**. Compilation took 19.12 seconds;
the filtered test runtime reported 0.00 seconds. No warning or compilation
failure was reported. Rustfmt check and `git diff --check` also pass.
No other test target, native-crypto feature or fixture exporter was run.

## Boundaries

The suite checks rollback attribution, complete frames for retained PSW1,
scope exclusions, canonical wide records, full-world final matching, chain
tampering and whole/partial-history distinctions. `WideUnmodelled` remains:
this is not full-Season replay, authentication, canonical account-address
verification, native dispatch or complete gameplay validation. SBF, debit,
automatic-send and mixed-family policy gates are unchanged. No native-crypto
suite, real transaction, deployment, signing or key operation is authorized
by this report.
