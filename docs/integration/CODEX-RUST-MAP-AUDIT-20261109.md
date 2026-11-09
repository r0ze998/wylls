# Rust map-contract source audit — 2026-11-09

## Scope and outcome

Reviewed checkout `0d252f0f3652344a1a2f4278ca2b3c602674c741` for the narrowly selected `herald` integration target `ws19_map_contract` on `aarch64-apple-darwin`. Source-level tracing found no private-key generation, private-key derivation, or signing in the selected build-script and procedural-macro execution paths. This report does not claim that a test passed. The audit itself did not compile, execute tests or macros, regenerate goldens, or perform key operations.

The comparison command is run from `frontier-node`:

```sh
env -u WS19_GOLDEN_WRITE cargo +1.95.0 test -p herald --offline --locked --test ws19_map_contract
```

## Dependency and cache evidence

Installed Cargo 1.95.0 was used only for offline, locked dependency discovery: `cargo tree --offline --locked -p herald --target aarch64-apple-darwin --edges normal,build,dev --prefix none` and `cargo metadata --offline --locked --format-version 1 --filter-platform aarch64-apple-darwin`. Identity/configuration probes are not compilation of repository code. The selected dependency graph contains **385 distinct packages, 33 build scripts, and 31 procedural-macro crates**. These are dependency-graph counts, not a compiler unit-plan trace or a claim that every macro entrypoint will execute.

For all **378 external packages**, the cached `.crate` archive SHA256 matched `Cargo.lock`. Every regular archive member matched the selected extracted source bytes. No missing archives, mismatched files, unexpected extra source files, or symlinks were found. Cargo metadata selected the `index.crates.io-1949cf8c6b5b557f` registry tree, rather than the other cached registry tree. Cargo marker files were excluded from the extra-file check.

## Compile-time paths reviewed

Review combined entrypoint/helper tracing, resolved features, manifests, and source-wide side-effect inspection, rather than relying on keyword matches alone.

- The 33 build scripts perform configuration/version selection, public constant or serialization-code generation, compiler capability probes, and native object compilation/archive creation.
- `libsecp256k1` builds fixed public multiplication tables. Its fixed curve generator, blinding constants, and public point construction do not generate or derive a wallet/private key.
- `blst` compiles bundled C/assembly through `cc`; BLAKE3 compiles its ARM NEON C source; SQLite uses bundled bindings and compiles `sqlite3.c`. Selected helper paths do not execute the resulting objects. Alternate prebuilt blst archive, SQLCipher, build-time bindgen, and external SQLite paths were inactive.
- `autocfg`, `feature-probe`, `anyhow`, `thiserror`, and `proc-macro2` compile small capability probes without running their outputs. Inspected probe bodies do not perform key operations. Incidental standard-library randomized hashing for temporary identifiers is not cryptographic key generation.
- The 31 proc-macro packages cover Arkworks assembly/field/serialization derives; borsh, bytemuck, serde, wincode and zeroize derives; cfg/darling/trait/enum/number derives; paste/pastey/qualifiers; Solana SDK macros; thiserror; Tokio; and tracing attributes.
- Their inspected execution paths parse or transform syntax and emit implementations. Arkworks calculates public field moduli, roots of unity, Montgomery constants and arithmetic templates. Solana SDK macros decode declared public IDs. Neither is private-key derivation.
- User expressions, serialization hooks, runtime construction, and instrumented functions are emitted as code rather than executed by these macro expanders. Their later execution belongs to runtime review.
- The borsh crate-name helper reads manifests and invokes trusted `$CARGO locate-project --workspace --message-format=plain --manifest-path=...`. Paste/pastey can read environment variables while constructing identifiers. These paths do not generate keys, sign, or send network requests.

## Environment and trust boundary

Use the inspected non-login shell and installed toolchain. Ancestor Cargo configuration only sets output directories; no relevant compiler, linker, native build, or Cargo override variables were present. `cc`, `clang`, `ar`, and `xcrun` resolve to Apple tools under `/usr/bin`. `libc` attempts an `emcc -dumpversion` probe even on Darwin; `emcc` was absent from the inspected PATH. `$CARGO` must remain the trusted installed Cargo. `CARGO_BUILD_JOBS=2` only limits build concurrency.

This is not independent certification of installed Rust/Apple toolchain binaries, exhaustive standard-library/compiler internals, or a formal per-line proof of every generic parsing utility. Recheck changed source, lockfiles, features, configuration, environment, and cache state before extending the conclusion. It does not cover other test targets, all repository tests, live transactions, or changed fixtures/runtime code.

## Runtime and golden-write boundary

The runtime safety review is separate: the selected test serves fixture-derived data through the actual herald router on loopback, with fixed byte-pattern fixture signatures, public addresses/PDAs and public drand constants. The compile-time audit does not substitute for that runtime review.

A second source review of the unchanged `ws19_map_contract.rs` found exactly three `WS19_GOLDEN_WRITE` branches (lines 145, 406 and 633 at the audited revision). Each serializes the already-computed router-result object `g` with `serde_json::to_string_pretty`, appends a newline and writes one fixed path beneath the herald manifest directory:

- `tests/golden/ws19-map-growth.json`
- `tests/golden/ws19-map-growth-s1.json`
- `tests/golden/ws19-map-growth-s1-palisade.json`

The first branch also ensures the existing golden directory exists. All three destinations were tracked regular files, with no symlink in their path. The switch adds no fixture generation, signing, key API, transaction submission, or new network path. It changes the golden-file side effects only; ordinary test setup still uses temporary directories and loopback serving.

Any valid Unicode value, including an empty string or `0`, enables these writes; comparison must unset the variable. Writes happen before subsequent assertions, are not atomic as a group, and can leave a partial update after a failure. The final equality assertion then reads the newly written file, so a write-mode pass is not independent evidence that the old golden was correct. Review all three diffs and rerun comparison with the variable unset after an authorized regeneration. No changed fixture or runtime implementation is covered sight unseen, and this report records no regeneration or test result.

## Subsequent execution and changed-fixture review

After this audit, the continuation worker ran the selected target with installed
Cargo/Rust 1.95.0, `CARGO_BUILD_JOBS=2`, a non-login shell, offline/locked flags,
and `WS19_GOLDEN_WRITE` unset. The unchanged baseline passed **3/3**.

A separate review then covered the exact Free City additions in `growth.rs` and
JSON assertions in `ws19_map_contract.rs`: public terrain hashing; canonical
state5/neutral6/Hamlet0/300000 milli-troop mirrors; NEUTRAL record encoding and
public chain hashes; conquest event collection/serialization; overview2 site-kind
classification. No new private-key or signing path, dependency, feature or build
script was introduced. Genesis NEUTRAL records use bell0, not NO_BELL.

Authorized write mode passed **3/3**. A semantic comparison found only the expected
changes: one city per ring4/5 province, matching NEUTRAL/day0 events and overview2
kind bits; Province sequence/head and city mirror bytes; season `headSeq`.
Existing event bodies are unchanged apart from shifted global record sequence
numbers. M1 golden is unchanged. Final comparison with the write variable unset
passes **3/3** after formatting. The original source audit remains bounded to
this selected target; it does not authorize other repository tests.
