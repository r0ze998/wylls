# Unsigned native runtime-contract checks

This isolated workspace compiles the actual `../src/lib.rs` as a library test
crate, so private closed handlers can be checked without public API or dispatch
changes. Its separate lock and Rust1.95 toolchain do not change the production
workspace's Rust1.89 dependency resolution.

The support crate builds literal AccountSharedData and TransactionContext,
uses official Solana runtime4.2.2 ABIv1 serialization, invokes a bounded helper
through SDK3.1.1 AccountInfo, then performs official writeback and pop balance
checks. No Transaction is constructed or submitted. Signer bits are fixture
privileges, not cryptographic signatures. Duplicate keys must use one transaction
account index; inconsistent duplicate privileges and oversized data refuse.

The run API is explicitly unsafe: official backing satisfies SDK layout
contracts, but native resize/assign still rely on SDK pointer/aliasing assumptions.
No AccountInfo, guard, clone or pointer may escape its closure. Failed disposable
contexts are dropped with no returned snapshots. This is not proof of rollback,
Rust soundness, SBF execution, bank processing or historical producer provenance.
Clock/default rent come from existing test providers. The default settlement
tests forbid CPI. The optional `system-cpi-tests` feature adds a separate native
SDK bridge to the official System program, described in `SYSTEM-CPI-AUDIT.md`.

## Verified scope

The two selected settlement test functions passed (also rerun with System support enabled):
- Actual member settlement with proof reopening, original home/PREV_HOME credit,
  ordered/diverted payments, shared recipients, exact paired/DIVERT logs, bridge
  closing and rent refund; retained claimed v2 slot followed by actual slot close.
- Support round-trip, duplicate alias, owned mutation, conflicting privileges,
  readonly/external-owner writeback refusal, unbalanced lamports, helper failure
  discard and SDK excessive-growth refusal.

The constant-only gate test also passed. DEPART, EXPEDITION and CONQUEST remain
false. No public instruction is activated. The expected full post-state is made
by the same prepare implementation, so those comparisons verify writer/writeback
consistency, not an independent proof of all game economics. Dedicated assertions
also check escrow, marker, closure, rent totals, masks and conservation.

Three additional `system_cpi_tests` functions passed: actual departure through
native System transfers and AllocateWithSeed for empty, short-prefunded and
excess-prefunded records; replay, signer/writable privilege and bad seed refusal;
unauthorized caller debit; missing CPI infos, spoofed key backing, wrong seeded
address, missing caller System account and invalid System executable/owner.
Failed helpers return no snapshots. This is disposal, not rollback evidence.

Only immutable public Quicknet signature/hints and an existing published IBE
block are used. Existing symmetric-key recovery and a deterministic memory-only
wide body are real proof operations. This reused public key/keystream is unsafe
for production sealing and provides no new confidentiality or timelock. No new
keypair, signing, fixture RNG, real transaction, SBF or CI was used.

## Narrow reproducible command

Use an already installed Rust1.95 native Apple toolchain and cached dependencies.
Do not run the broad library suite or enable native-crypto-tests/test-beacon/oracle.
From this directory, after auditing any changed source/dependency path:

```sh
cargo +1.95.0 test --offline --locked \
  -p permutation-frontier-runtime-contract-tests --lib \
  --features public-proof-tests --target aarch64-apple-darwin \
  --target-dir target \
  'proc::wide::expedition_return::proof::settlement::runtime_contract_tests::' \
  -- --test-threads=1
```

Add `--no-run` before the filter for compilation only; use `-- --list` to confirm
exactly two tests before running. The optional System adapter is selected with
`--features public-proof-tests,system-cpi-tests`. Run these filters individually
and serially, never the unrestricted library suite:
- `proc::wide::expedition_exec::tests::system_cpi_tests::`
- `proc::wide::expedition_return::proof::settlement::runtime_contract_tests::`

The reviewed contiguous producer/combat/return child passed two functions:
`proc::wide::expedition_gather::exec::lifecycle_tests::`. See
`../../docs/integration/CODEX-BOUNDARY-LIFECYCLE-20261109.md` for exact scope.
The configuration-only filter `proc::wide::public_proof_config_tests::` passed
one function. Across these four disjoint final selections, eight functions
passed; none is a real transaction or a whole-repository test pass. No test feature
is added to the production manifest and no public gameplay gate is enabled.

Root checks used a clean environment with fixed
Cargo/rustc/clang/ar paths, offline mode and two build jobs.

## Build audit evidence

The original no-CPI graph contained 222 packages, 23 build scripts and 16 proc-macro roots.
All 218 registry archives matched the lock checksum and 5,871 regular archive
members matched extracted files, with no unexpected files/symlinks. Scripts,
macro/helper entrypoints and native startup were statically reviewed before build.
Compile probes are not run. blst compiles keygen implementation but does not invoke
it; the relevant Apple constructor only sets the CPU capability flag. autocfg/cc
use randomized collection state for temporary filename bookkeeping, not fixture
randomness or cryptographic key generation.

The System-support graph contains 226 packages, with the same 23 build scripts
and 16 proc-macro roots. The five new/changed cached package archives and all
28 regular members matched the lock/source trees. See `SYSTEM-CPI-AUDIT.md`.

Current independent lock SHA256:
28dfe243061f12835bdca8eaaf8bf84248f34da8ed79a2dc892e0146408dc251

The production root lock remains:
87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9

This source review is not independent certification of compiler/OS binaries.
Machine-specific metadata, build output and raw resolution inventories are local
and ignored. Re-audit active dependencies and helpers after any lock/source change.
