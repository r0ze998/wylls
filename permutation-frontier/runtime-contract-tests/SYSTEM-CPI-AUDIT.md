# Native System CPI audit, 2026-11-09

This extends the isolated native runtime-contract tests only. Production/root
manifests and locks, public dispatch and DEPART/EXPEDITION/CONQUEST gates remain
unchanged. No transaction object, private signing key, keypair, signature, RPC,
validator, SBF artifact, CI job or deployment is created or used.

## Actual mechanism and limits

`system_cpi::run` owns a disposable official TransactionContext and aligned
ABIv1 serialization. A bounded native SDK helper uses a temporary process-global
syscall hook; exact filtered tests run serially. The hook first validates that
all supplied AccountInfos point into the original official allocation, that
every CPI meta has a supplied info, and that the System fixture is executable
and native-loader owned. The System account must also be in the caller's roles.

Official `deserialize_parameters` validates caller mutations before each CPI.
Official `InvokeContext::native_invoke_signed` derives the Season PDA address
from the real caller program and seed slices, checks privilege escalation and
calls the cached `solana_system_program::system_processor::Entrypoint`. Only
Transfer (2) and AllocateWithSeed (9) are admitted by this audited adapter.
The official processor validates balances, seed-address equality, allocation,
owner assignment and conservation. It is not replaced with successful stubs.

Successful native System output is copied back into the same SDK AccountInfos
using the SDK resize/assign APIs. Original serialized growth limits remain in
force. Final official writeback and TransactionContext pop must succeed before
snapshots are returned. Any CPI failure poisons this disposable run, even if a
helper catches the returned error. The original fixture remains outside it.
This is isolation, not bank rollback. The helper cannot retain any AccountInfo,
borrow, reference or pointer beyond its closure and must release every borrow
before CPI.

This remains an unsafe native SDK ABI exercise, not a Rust soundness proof.
The custom synchronization bridge is not the SBF CPI syscall or VM memory
mapping. Wallet signer flags are unauthenticated fixture privileges. A fresh
InvokeContext budget is used per CPI, so transaction-wide compute metering is
not tested. Native program/account setup, prior season/anchor state and clock
are synthetic. Historical producer validity, live bank/signature validation,
SBF execution and production gameplay are outside this evidence.

## Dependency and execution review

Offline metadata resolution changed only the independent harness lock:
- Added solana-bincode 3.1.0, solana-nonce-account 4.1.1,
  solana-packet 4.2.0 and solana-system-program 4.2.2.
- Selected solana-fee-calculator 3.2.2 instead of 3.4.0 to satisfy official
  System program 4.2.2's published range.
- Added serde/wincode features on solana-nonce and sha2 on solana-pubkey.
- Added direct optional references to already-present SVM callback/feature-set
  crates. No dependency test/bench target or dev-context utility was selected.

The target graph is 226 packages, 23 build-script roots and 16 procedural-macro
roots. No new build script or macro crate was introduced. All five changed/new
registry archives matched lock checksums; all 28 regular archive members matched
extracted source files and contained no links. New library sources and selected
serialization derives were reviewed. Prior audited compiler/build-helper and
macro paths are unchanged. The actual native call path reviewed includes
InvokeContext preparation/push/process/pop, builtin cache registration,
System Transfer/AllocateWithSeed/address checks and SDK writeback.

Standard randomized collection state and the official runtime's VM-pointer
obfuscation integer may be initialized. They are runtime bookkeeping, never
wallet/cryptographic signing keys or fixture/seal entropy. No private key
creation, derivation or signing function is selected. PDA/create-with-seed
address derivation is program authorization, not private-key derivation.
Only the existing immutable public Quicknet verification and explicitly
allowed symmetric recovery are used by the separate proof/settlement tests.

Builds used installed Rust 1.95.0 for aarch64-apple-darwin, cached dependencies,
offline locked Cargo, explicit isolated target directory, a clean environment
and fixed compiler/clang/ar paths. No package/toolchain was fetched or installed.
Compilation caught ordinary trait import and fixture naming/lifetime errors;
the corrected exact targets compiled before execution. This is source review,
not independent certification of the compiler, runtime binaries or OS.

Current independent Cargo.lock SHA256:
`28dfe243061f12835bdca8eaaf8bf84248f34da8ed79a2dc892e0146408dc251`

Unchanged root Cargo.lock SHA256:
`87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`

## Verified tests

Three exact System CPI test functions passed. They cover actual departure with
zero, short and excess prefunding; bridge owner/length/balance, payer/escrow,
original Spend entry, receipt emission and replay refusal; official missing
signer/writable privilege, bad PDA seed, wrong seeded target and insufficient
funds refusal; official pre-CPI caller-write refusal; adapter missing-info,
forged-key-backing and invalid System fixture checks; failed-helper disposal.
The two prior settlement/runtime integrity functions also passed on this graph.
Each function contains several scenarios; these are not real transactions.

The contiguous lifecycle child has a separate review/result report. Do not
expand a test filter without auditing newly selected test and initializer paths.
