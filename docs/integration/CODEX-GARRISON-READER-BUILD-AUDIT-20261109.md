# Garrison reader build-path audit — 2026-11-09

Base `b7f733b545b06a311b76f8285d30149e52412910`, Apple aarch64 host.
This supplements `CODEX-RUST-MAP-AUDIT-20261109.md` and
`CODEX-WIDE-VERIFY-AUDIT-20261109.md`. Runtime tests require separate review.
No build or test was executed by this audit.

## Selected dependency graphs

Offline, locked Cargo tree/metadata inspection included dev dependencies:

- keeper + wide-world-experimental: 380 packages, 33 build scripts,
  31 procedural-macro crates.
- findex + wide-records-experimental: 378 packages, 32 build scripts,
  31 procedural-macro crates.
- verify + wide-world-experimental: 385 packages, 33 build scripts,
  31 procedural-macro crates.

Compared with the prior audited herald graph, there are no new external
packages or external feature changes. Keeper adds local agents and removes
herald plus five compression dependencies. Findex additionally removes keeper;
verify substitutes itself for herald. New local features enable fclient typed
logs, findex wide readers and keeper wide modules. ABI world-index was already
reviewed. No manifest, lockfile or agents source/build-script change was found.

## Newly reached local build script

`agents/build.rs` was read in full. It reads fixed frontier-sim source files,
transforms Rust source text and writes OUT_DIR/frontier_sim_lifted.rs. It uses
only std, with no subprocess, network, cryptography, signing, fixture exporter
or execution of generated simulator code. Only agents/tests/campaign_equality.rs
includes that output, not the selected targets. Compiling the agents library's
key-related functions does not execute them.

No new constructors, initializer sections, thread-local or lazy initialization
were found in added local paths. Existing fclient LazyLocks assemble and sort
public instruction metadata only.

## Cache and environment

All 378 selected external crate archives matched Cargo.lock checksums. All
11,365 regular archive members matched extracted source, with no unexpected
files, symlinks or archive special entries. Cargo configuration only selects
output directories. Inspected override environment contained only RUST_LOG;
native tools resolve to /usr/bin and emcc is absent.

Use installed Cargo/Rust 1.95.0, non-login shell, native aarch64-apple-darwin,
offline/locked, CARGO_BUILD_JOBS=2, unchanged configuration/features/cache.
Unset WS19_GOLDEN_WRITE and WYLLS_WIDE_ECONOMY_FIXTURES_DIR. Integration targets
may compile package binaries but do not run their main functions.

The final isolated economy-rejection regression uses verify's separate
`wide-economy-experimental` feature. Manifest inspection confirms that it
enables only the same ABI world-index feature, with no new dependency or build
hook. The newly compiled local module has no runtime initializer or custom
procedural macro. Its selected test calls only literal constructors, canonical
event encoding and the explicit unsupported-kind refusal, not economy replay.

This source/feature/cache review is not binary certification or a compiler
unit-plan trace. The entire v28 test module contains legacy tests as well as
wide ones; use only separately audited selected filters. New keeper/findex
test source and concurrent local edits need final runtime review. No test,
exporter, key operation, transaction, deployment or CI is authorized merely
by this build-path report.
