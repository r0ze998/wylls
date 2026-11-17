# Solana crypto boundary: bounded local improvement

This change fixes the pairing FFI input boundary without admitting any new
instruction or making the experimental wide program deployable.

## Finding and implementation

`permutation-frontier/src/crypto/sys.rs` previously narrowed the caller's `u64`
pair count to `usize` and multiplied it by 96/192 before checking buffer lengths.
Very large counts could overflow. The native test adapter separately enforced
the SIMD-0388 maximum of eight pairs, so its preflight differed from production.

`crypto/pairing_contract.rs` now supplies the same pure validator to both
adapters. It bounds the count before narrowing or multiplying, then checks the
G1/G2 byte lengths. Zero pairs and buffers with unused trailing bytes retain
their previous meaning. The production wrapper stages its 576-byte result and
copies it to the caller only after syscall success, matching the native adapter.

The limit and call shape were checked against locally cached, pinned sources:

- `solana-bls12-381-syscall 0.1.1`, `src/pairing.rs`: maximum eight pairs; zero
  pairs return the identity; point validation remains inside the implementation.
- `solana-syscalls 4.2.2`, `SyscallCurvePairingMap`: five arguments (curve,
  count, G1 address, G2 address, result address), with the same BE curve IDs.

No test adapter was enabled in linked host libraries or on Solana. No dependency,
feature, entrypoint, public parser, debit gate or compile-time deployment block
was changed.

## Validation performed

The native host target `crypto_syscall_boundary` passed all three tests. It
checks oversized counts (including `u64::MAX`), exact and short buffers, zero
and eight pairs, unchanged output on refusal, and fail-closed linked host code.
It performs no cryptographic operation: the linked library uses host stubs.

```text
cargo test -p permutation-frontier --no-default-features \
  --test crypto_syscall_boundary --target aarch64-apple-darwin \
  --offline --locked -j2
```

`cargo check` of the single `public_seal_verification` test target also passed,
confirming that its direct inclusion of the native adapter still compiles. That
target was not executed; no seal was opened and no signature operation occurred.
Both commands used the direct Rust 1.95 toolchain and an isolated temporary
target directory. Existing fixture-module unused/dead-code warnings remained.

## Remaining Solana conditions

1. `lib.rs` deliberately rejects `target_os = "solana"` with
   `wide-world-experimental`. Wide numbers, ruleset/version and complete lifecycle
   admission remain unallocated/unreviewed. Removing that block is not a port.
   The closed resident/member/camp/failure/terminal proposals must remain
   rejected by public decoders until an approved exact schema and account table
   can route through the existing validated dispatch and prologue.
2. Production `crypto/sys.rs` already selects raw Solana syscalls; native BLS
   math is test-only. The runtime must actually enable the BLS12-381 feature:
   cached Agave 4.2.2 registers decompress/pairing under
   `enable_bls12_381_syscall`, and its group-operation handler checks that feature
   for BLS curve IDs. Group syscall registration also depends on the existing
   curve25519 syscall feature. No target cluster's feature state was queried.
3. Official native account serialization/writeback and the separate
   `runtime-contract-tests/support/system_cpi.rs` adapter already exercise
   important account ownership, privilege, System allocation and assignment
   contracts. Their documented limits still apply: they are not SBF memory
   mapping/syscalls, wallet authentication, a bank transaction, or a shared
   transaction compute budget. Account resizing, closure, duplicate accounts,
   failure rollback and System CPI need those actual runtime boundaries before
   deployment can be claimed.
4. The real entrypoint is Solana-only and calls `dispatch`. Host success through
   private helpers does not establish that an externally encoded instruction
   reaches those helpers. `DEPART_DEBIT_ENABLED` remains false outside the
   pre-existing native unit-test experiment; `CONQUEST_LIFECYCLE_ENABLED` remains
   false. This change does not widen either gate.
5. SBF stack/heap/CU costs, including the pairing result scratch buffer, syscall
   linking and the complete departure/return transaction remain unmeasured here.
   No SBF build, chain process, deployment, key operation, signing, new seal,
   transaction submission or CI run was performed.
