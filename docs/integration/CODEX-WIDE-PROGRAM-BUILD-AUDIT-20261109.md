# Wide program host-build source audit — 2026-11-09

Base: `a18a23c3d0d27580797c48a6c0279bae69a9dd87`, Apple aarch64 host.
This supplements the prior Rust map and wide-verifier audit reports. It covers
compile-time execution for root-workspace Cargo 1.89.0, package
`permutation-frontier`, feature `wide-world-experimental`, library tests.
Runtime tests need separate review. No build or test was run by this audit.

## Dependency and cache review

Offline locked Cargo metadata/tree discovery selected **170 packages**, with
**167 external packages, 18 build scripts and 12 proc-macro crates**. The
previous verifier graph had 385 packages; 43 program-graph package identities
are absent from it, including the local root. That earlier audit cannot be
applied unchanged.

All 167 selected cached `.crate` archives match root `Cargo.lock` SHA256 values.
All **4,692 regular archive members** match extracted source files. There are
no unexpected files, archive links or extracted-tree symlinks; Cargo markers
are excluded. Root lock SHA256:
`87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.
No selected package declares a minimum Rust version above 1.89. Counts are
dependency-graph counts, not a compiler unit-plan trace.

## Changed compile-time paths

- memoffset0.9.1 uses autocfg compiler-version/capability checks. Probe outputs
  are compiled but not run.
- blake3 1.5.5, rather than verifier1.8.7, compiles bundled ARM NEON C through
  cc on this target. Generated objects are not executed at build time.
- cc1.4.7, rather than1.5.1, inspects compiler/SDK identity, compiles objects
  and archives them. Flag probes contain an empty main and are not run.
  find-msvc-tools0.1.13 deltas concern inactive Windows paths.
- thiserror/thiserror-impl2.0.20, rather than2.0.21, writes a private-module
  declaration and compiles a trait probe to metadata. Macro changes concern
  syntax parsing, not execution of supplied expressions.
- zerocopy0.8.57, rather than0.8.59, reads package/compiler versions and emits
  configuration flags.
- Different TOML parser/editor/datetime and indexmap versions support Borsh's
  existing manifest/crate-name lookup. Its external effects remain manifest
  reads and trusted Cargo locate-project.

Other build-script/proc-macro families were compared against the previous
audited paths, with current source/cache and feature/toolchain checks. Their
work is configuration probes, public constant generation and syntax emission.
Arkworks computes public field constants; derives emit code rather than call
runtime serialization hooks. The selected local crates have no build script
or proc-macro target. Local wide-terrain and Solana serialization/message
feature deltas add no new private-key-producing compile-time operation.

## Native dependency and startup boundary

Even with `native-crypto-tests` disabled, the host dev-dependency
`solana-bls12-381-syscall` brings blst/blstrs into the graph. Feature absence
alone is not safety evidence. The blst build compiles bundled C/assembly;
server.c includes key-generation implementation source, but compiling it does
not execute it. No unexpected prebuilt archive is used.

The Apple aarch64 C constructor, if retained by the linker, only sets
`__blst_platform_cap = 1` for SHA256 capability. It performs no cryptography.
No local runtime constructor registration was found. Selected runtime tests
must still avoid every prohibited entrypoint independently.

## Environment and limits

Use installed Rust/Cargo1.89.0, target aarch64-apple-darwin and a non-login
shell. Inspected ancestor/Cargo-home configuration only sets the output path
`permutation-chain/target`; no compiler wrapper, linker, native-build,
dynamic-library or Cargo override variables were present. cc/clang/ar/xcrun
resolve under `/usr/bin`; emcc is absent. No selected package source or lock
was changed by the audit.

Source tracing found no private-key generation, private-key derivation or
signing in reviewed compile-time paths. This is not independent certification
of installed Rust/Apple binaries, exhaustive compiler/standard-library
internals or authorization for unreviewed runtime tests. Recheck changed
source, features, lockfiles, configuration, environment and cache state.
Native-crypto tests, fixture exporters, guard self-tests, SBF, transactions,
deployment and policy-gate changes remain outside scope.
