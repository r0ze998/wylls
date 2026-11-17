# Closed original-to-wide arrival producers, 2026-11-09

Base: `0b1f3e0f8e00efec4e1d4cc066eb40245d131356`.
This checkpoint adds actual private Reveal and Gather writers, actual destination
combat coverage, proof-pending return staging, and an isolated real public-seal
verification target. It does not activate public gameplay or claim a complete
original-game chain/browser lifecycle.

## Concrete runtime progress

- Dedicated ExpeditionReveal authenticates the original Holding/owned-v2 pair,
  original Citizen, mixed route, commitment, timing, shields, quota and evidence.
  It prepares complete raw before/after manifests and a bounded kind147 receipt
  before effects. Existing day/slot records are actually written in host tests;
  existing rent recipients and day bits survive, and replay refuses.
- Dedicated ExpeditionGather authenticates explicit slot/original Holding/owned
  bridge triples. Route wear applies once to real post-origin survivors while
  original DEP_MASS remains unchanged. Destroyed-origin zero stamina and worn
  subthreshold survivors reproduce exactly on repeat. Claimed defence-refund
  status is independent of combat eligibility; an erroneous rejection was fixed.
- Gather's writer checks addresses, storage aliases, privileges, sizes and all
  mutable borrows before effects. All output buffers are held before copying any.
  Complete raw manifests include every ordered role and readonly input. Existing
  inputs and bridges are actually updated, and repeated writes preserve bytes.
- Actual production wide Resolve accepts a canonical original ring128 host into
  ring129 combat, removes the opposing resident and retains the survivor under
  its full original identity in WideRoster. This executes the real combat kernel
  and account writeback, not a supplied outcome. Gather staging is materialized
  as fixture input in that test; it is not a full atomic producer replay.
- Return staging authenticates original identity, actual resolved final-set
  membership, retained slots and the surviving generation history. It projects
  original-ID muster return or whole-unit Reserve fallback, captured PREV_HOME
  credit, current-marker finances and terminal rent-only cleanup. These copied
  states are deliberately not executable settlement authorization: actual seal
  proof, timing, claim/payment execution, receipts and commit remain missing.

Original-only operations are unchanged. Boundary ownership preserves the full
original departure Citizen after capture; it does not substitute the captor.
This is not byte-for-byte parity with the legacy Reveal's mutable owner-tag quota.

## Provisional wire and record

See `workstreams/04-execution/contracts/ABI-EXPEDITION-PRODUCERS-20261109.md`.
EE FF01 op1 and DC FF01 op11 are conflict-scanned provisional technical choices,
not finalized external allocations. New PS2 kind147 has exact314/161-byte records
and zero chain tails because only unchained records/balances change. Existing
145/146 and old strict decoders remain unchanged. No fictitious entity chain is
advanced; every raw source/target account and actual funding delta is committed.

Both new public dispatch arms unconditionally return NotImplemented. Original
expedition and conquest lifecycle gates remain false; default/SBF and ResidentAct
admission are not expanded. The ordinary host build does not enable native-crypto-tests.

## Real public proof, isolated from gameplay gates

`permutation-frontier/tests/public_seal_verification.rs` includes unchanged real
arithmetic/opener sources and the existing real native arithmetic adapter. It
pins the immutable published Quicknet round32551361 legacy165-byte ciphertext
and hints, verifies the public signature, recovers the symmetric opening key,
opens/judges the seal and checks published plaintext, salt, commitment and root.
It does not generate a keypair/signature/ciphertext, use recorded key material
instead of recovery, or export recovered keys. This proves shared IBE/FO and
legacy opening, not a wide264-byte seal or bridge settlement.

The target is explicitly harness=false. Its small main runs only this proof;
imported unit tests are not auto-registered/executed. Default and exact-name runs
pass; --list only lists, and an unrelated exact filter skips the proof. Unsupported
arguments fail before proof. Cargo1.89's no-libtest / cfg(test) behavior was checked.
This avoids the earlier experimental harness importing incompatible unrelated tests.
The manifest change adds only this test target; no dependencies, lock, features,
production crypto source or gameplay gate changes.

## Verification actually run

Static runtime closure and dependency/build-path review preceded each selected
run. Final combined selected results:

- ABI transport6 + departure receipts5 + departure wire2 + producer wire/receipts5:
  18 passed.
- Program host library expedition prefix:71 passed. This is exec/origin combat15,
  routes11, Reveal14, Gather staging9, actual destination combat1, Gather writer6,
  and proof-pending return15.
- Isolated public proof:1 passed. Total90 distinct selected tests, not a full suite.
- Default library check and wide-world-experimental,nft-experimental library
  check passed. Private unused candidates and imported-source warnings remain.
- Diff whitespace check passed. Compile-only integration mistakes (SysError
  visibility, Result collection types and a test expected-error conversion) were
  corrected before affected test execution. Impossible precursor timings and
  several fixture constants were corrected during static review, without rule changes.

Used Cargo/Rust1.89, native Apple host, non-login shell, offline/locked, two build
jobs and existing native cache. No explicit --target, exporter, broad suite,
key-guard self-test, native-crypto-tests, SBF, CI, transaction or deployment.
The build baseline is CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md; the new custom
target adds no build scripts/proc macros/dependencies. The cache was not exhaustively
rehashed again. Root Cargo.lock remains
87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9.
Unrelated pending work and its review metadata remain unchanged.

## Exact remaining boundaries

All successful writer tests use already allocated accounts, with zero allocation
payment. Real init_with_seed exists and validates resulting owner/size/balances;
its allocation/payment CPI branch was not executed or replaced by a success stub.
CPI failure atomicity relies on actual transaction rollback, not host evidence.
Precursor accounts and beacon seeds are literal fixtures, not historical producer
proof. Destination combat uses flat isolated terrain without a keep/site/camp.

Still needed: complete wide-format proof and settlement, claims and terminal
record handling for v2 slots, paired lifecycle receipt replay, creation/payment
runtime validation, and original-game UI/keeper integration. This checkpoint is
not production-ready, unlimited-world gameplay, or evidence of a real transaction.
