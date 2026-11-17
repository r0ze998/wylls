# Gated wide siege and capture runtime — 2026-11-09

Base: `70e6addd7a38eb22474480b6d2cf9b2e637b3c78`.
This increment implements the authenticated account handlers for the complete
initial-Free-City siege lifecycle. It does not activate player transactions.
`CONQUEST_LIFECYCLE_ENABLED` remains false, with no argument or configuration
bypass. Existing default, SBF, departure-debit, mixed-family and automatic-send
gates remain unchanged. Original user-playable gameplay remains radius 128.

## Runtime scope

Six experimental commands now have wire schemas and closed dispatch routes:

- DA FF01 op5: DeclareSiege, class P.
- DE FF01 op5: SettleSiege, class N. DC op7 remains unassigned and rejected.
- DC FF01 op8: SettleCapture, class D.
- DC FF01 op9: ResolveWithConquest, class D, top-level only.
- DE FF01 op3: CloseConquest, class N.
- DE FF01 op4: CloseCaptureEscrow, class N.

These identifiers are provisional internal allocations, not a finalized external
ABI. SettleSiege matches the legacy permissionless class N rule. Its first
account is any Wallet signer, read-only. An active source Holding, when required,
is the last optional account, never a dummy System or target placeholder.

Declaration authenticates the final source Holding and full issued host identity,
source/target Province pairing, target initial Free City generation zero, absent
canonical destination Holding, current roster membership and full-identity lead.
It uses the existing daily cap, lowest free inventory slot, arms burn, gold stake,
walls duration and season-end window. Rent reservation is isolated in the wide
capture escrow. Pending wide tickets and incompatible inventory are refused.
Existing table and escrow funders are retained, not overwritten by later payers.

Conquest-aware Resolve shares the old handler's account, window, seed, arrival
and writeback path. It runs actual combat through resolve_bell_with_conquest and
stages the Province, roster, arrivals and conquest table together. Old Resolve
still refuses obligations that require this lifecycle.

SettleSiege handles a failed owed obligation or a resolved active siege at the
season end, never CaptureDue. Active lapse requires the canonical initial Free
City mirror. A failed obligation can refund rent after current target ownership
has changed, matching legacy behavior. Active source gold is credited with the
existing cap, or burned when the original source is absent/stale; failed stake
is burned. Wrong addresses or malformed source accounts are not treated as
absence. Exact reservation bits and table bindings are cleared once.

SettleCapture authenticates the table, escrow, Citizen, JoinShard and target
mirror. It creates the captured Holding with the existing checked constructor,
funds only an absent/prefunded destination's rent shortfall from isolated escrow,
clears the reservation before binding the inventory slot, increments holdings,
EXTRA_HOLDINGS and CAPTURED_IN once, and preserves the existing immunity rule.
Original source stake is capped-credit or burn; arms are not refunded. Repeated
settlement is rejected before effects.

Terminal close uses the existing Ended plus 72-hour grace, Aborted or tombstone
conditions. Conquest-table close needs no live Province/source. Active escrow
close requires the authenticated Citizen; empty escrow may follow Citizen close.
Only escrow-owned reservation bits are cleared. Refund aliases are aggregated
safely, immutable payers/funders retained, and self-recipient, overflow and borrow
conflicts are refused before resize.

The ResidentAct declaration wrapper binds the exact outer command, generation
and complete 16-account manifest, including four proof accounts. It validates
the main 12 accounts separately. The Wallet-shaped private core refuses a
Resident auth value, preventing a stripped receipt. Tests cover this provenance
contract and refusal, not successful real NFT/Core authentication.

## Atomicity and evidence boundary

Full before/after account snapshots, duplicate-role synchronization, borrow
preflight, arithmetic checks and receipts are staged before live writes. The
host tests exercise real AccountInfo handlers with literal identities and a
bounded System AllocateWithSeed stub. Public PDA hashing/address validation is
used; no private keys or actual signing occur. Unexpected System CPI failures
still rely on real transaction rollback. These tests do not prove rollback of
unexpected syscalls in a host process without a transaction runtime.

All successful lifecycle handler tests call private authenticated implementations.
Public dispatch is tested as closed, not claimed playable or production-enabled.
No real transaction, SBF validation, deployment, wallet use or browser gameplay
was performed by this increment.

## Receipts and readers

WideKind 18–24 represent declaration, source debit, conquest Resolve, settlement,
capture, source credit and table close. MAX_LINKS stays two with at most one
Holding. Existing event encodings and digests remain unchanged.

A canonical 100-byte receipt commits action, input/output and operation ID.
Inputs bind the exact command, time/bell, whole authenticated Season, operation
evidence and role-ordered full wire account manifest. Output normalization only
removes chain headers from accounts actually chained by that operation. Private
tables, Citizen, JoinShard, roster and escrow are never normalized. Aliased roles
must agree. Actual transfers/refunds and model results are part of the outcome.

PSWC records preserve escrow close separately with season/Citizen identity and
no fabricated Province or Holding chain. fclient retains them after the same
failed-transaction/subtree and foreign-frame filtering as other typed logs.
Findex preserves the raw sidecar, binds its world to the configured authenticated
program and receipt season, and rolls back/sticky-blocks a mismatched batch.

These are commitments, not semantic replay or authorization by themselves.
Keeper rejects lifecycle kinds and PSWC before mutation and remains blocked.
Wideproof explicitly refuses PSWC. VW recognizes canonical committed sidecars
as WIDE_UNMODELLED; malformed committed sidecars fail. No complete lifecycle
replay or cross-receipt pair completeness is claimed. The ResidentAct verifier
whitelist remains closed to DeclareSiege.

## Selected verification

Independent static call-path review preceded execution. Exact test closures use
literal public identifiers, public SHA-256/PDA operations, byte codecs, scalar
economy/inventory arithmetic, actual deterministic combat, memory account stubs
and, for node readers, temporary SQLite/filesystem operations. No prohibited key
generation, private derivation or signing, native-crypto tests, key-guard
self-tests, exporter, network or external subprocess is reached by the selected
runtime paths.

Compile-time audits are CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md and
CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md. Manifests, locks, build scripts and
configuration did not change. The previous full dependency-cache rehash was not
repeated, so reuse relies on the unchanged-cache assumption. Installed Cargo/Rust
1.89.0 (root) and 1.95.0 (node), non-login shells, offline/locked mode, two jobs
and the existing native aarch64 caches were used, without an explicit --target.
Both fixture-export variables were unset. No CI ran.

Final selected results: **60 distinct tests passed**.

- ABI: wide_conquest_events 5; wide_conquest_ix 4; wide_economy 8;
  world_index::event::tests 7. Total 24.
- Program: conquest_exec 6; conquest_settle_exec 16. Total 22.
- Existing program regressions: wide_garrison_resolve_atomicity 2;
  wide_garrison_allocation 3; actual_resolve_activates_reinforcement_after_its_bell_clash 1.
- Node: fclient typed_sidecar_log 2; keeper wide_conquest_index 2;
  verify wide_sidecar_chains 2; two exact findex wide_typed_index tests, 1 each.
- Compile-only permutation-frontier library checks passed for default,
  wide-world-experimental and wide-world-experimental,nft-experimental.
- Scoped formatting and git diff --check passed. Existing unused Wide::at
  test-helper warning remains.

The first new program compilation found an obsolete eighth AccountInfo::new
argument in a test helper. It was corrected before tests ran. SettleSiege was
initially assigned the wrong class; source review caught it and all four wire
tests were rerun after the class N correction. The six old-Resolve regressions
and three compile checks were repeated because earlier output was unavailable;
no concurrent Cargo process remained. Counts above are distinct final tests,
not a claim that all repository tests were run. Broad suites remain unexecuted.

Execution used cargo --offline --locked and --test-threads=1. Exact targets:

- Root ABI, --features world-index-experimental: --test wide_conquest_events,
  --test wide_conquest_ix, --test wide_economy and
  --lib world_index::event::tests.
- Program, --features wide-world-experimental --lib:
  proc::wide::conquest_exec::tests:: and proc::wide::conquest_settle_exec::tests::.
- Program old regressions under map_growth_runtime_tests::wide_land::wide_garrison:::
  wide_garrison_resolve_atomicity::, wide_garrison_allocation:: and exact
  actual_resolve_activates_reinforcement_after_its_bell_clash.
- Node fclient --features wide-records-experimental --test typed_sidecar_log.
- Node keeper --features wide-world-experimental --test wide_conquest_index.
- Node verify --features wide-world-experimental --test wide_sidecar_chains.
- Node findex --features wide-records-experimental --test wide_typed_index,
  exact every_kind_has_a_separate_wide_record_and_canonical_attribution and
  sidecar_is_preserved_without_chain_attribution_and_wrong_world_blocks_atomically.

## Remaining path to actual player access

A new player cannot bootstrap a first wide Holding: FRONTIER_7's heartland ring
and home-anchored outpost range are both three, while wide land begins beyond
radius 128. The implemented declaration already requires a wide source/host.
Synthetic test accounts do not solve this entry path. Legacy-source cross-boundary
expeditions need a coherent departure/transit/arrival/combat/return adapter and
an explicit choice of mixed-family destination ordering/quota/lead semantics.
No such rule choice is made here. The boundary decision remains pending.

Complete semantic replay, source authentication, receipt pairing, successful NFT
Core authentication coverage, SBF validation, original-game UI connection and
an approved activation review remain outstanding. The separate pending UI/Herald
changes and security-review metadata were neither changed nor included.

## Reviewed source SHA-256

- frontier-abi/src/world_index/conquest_event.rs: e503284f568f656b563b133eb25d3986adbb0ecfece0d5914a9279d4b9d99613
- frontier-abi/src/world_index/event.rs: b5b6a101143ce51dbb2819e5ab725b6ea7134b52a03cabf0da2d396472ba9561
- frontier-abi/src/world_index/wide_ix.rs: 30e55f2601a3dd7816346a30c5c5f28fa9efc853c5c7d3f1c51d475bedf97aa2
- frontier-abi/tests/wide_conquest_events.rs: 31171e4a015bdac2b15ff670dbefeb5264ccb7502022fded97d69f1e5e751703
- frontier-abi/tests/wide_conquest_ix.rs: 88aa98e92aa52ee8f84a5494711882953c189eb85793d0fd6773c3de41f7ae8d
- frontier-abi/tests/wide_economy.rs: 17e8fee3e6703fba9ee2d44da0d89e938ed3de99edb40816d076a066cc332444
- frontier-node/crates/fclient/src/typed_log.rs: 4b26c0df18ea9e8ddd9897b7eed1e81da93f27d78f635307f5b90c0bfafe6b32
- frontier-node/crates/fclient/tests/typed_sidecar_log.rs: 7dd8031244543064c2e7bf2eb5336099ce625063b19d40d256c248be3a7a30d6
- frontier-node/crates/findex/src/wide_index.rs: 7c12255bc5af1c167f62a4179b76206ba8f40b1dd2cd2e3758c1fe52449daf9c
- frontier-node/crates/findex/tests/wide_typed_index.rs: bd0637836c3d132e0c870d73ee09e8b300d5755b6d915095cfae92b7c96a07f7
- frontier-node/crates/keeper/src/wideindex.rs: 8854676f77b5319a65aa0449a8ff3e402b8b5b9dc92830e83afad4cc67a4d948
- frontier-node/crates/keeper/src/wideproof.rs: 7f79ffc86d8579c29c27d4643b1e114bd9f5b2022f1a4d4049182ecc6ed74836
- frontier-node/crates/keeper/tests/wide_conquest_index.rs: 9552835082810821f6b91d5f76b15f7142b6ec8c8449ff785157ffb105701ba6
- frontier-node/crates/verify/src/checks/vw_chains.rs: 929d567291f7f110ebad0ee555b6081e196a9cf0d8187b1709e00d336e9ca7af
- frontier-node/crates/verify/tests/wide_sidecar_chains.rs: 6a80db9ce017692847825266951e9eb78d94d7f0f3f0f219856fd5d85ef0dc61
- permutation-frontier/src/proc/conquest.rs: 88383504b8187cb9e93842c97a111b0ae52bc90a9b12c33f7aaaf15f1f9d6fc8
- permutation-frontier/src/proc/wide.rs: a5c704bc8a63563a5aa2c280a139c0fd7f7723997988943a55e919eafc37e14c
- permutation-frontier/src/proc/wide_conquest_exec.rs: a2283a2e2c897063119ab3343ca15de4a44ab20d932c7dfd9f483616b93a9e4b
- permutation-frontier/src/proc/wide_conquest_exec_tests.rs: 17bae113450d9f4009b0f5c343038f7a7af7900790af82f2c55c2a593057ba7d
- permutation-frontier/src/proc/wide_conquest_settle_exec.rs: ddbfe7705fd683b32f574f528745026dc07a7127fa92cb317557e7c0547915c6
- permutation-frontier/src/proc/wide_conquest_settle_tests.rs: a516f902e90a759c595e564785be70ab3c8b147155584ca8ec2b7c49ac729cc5
- Cargo.lock: 87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9
- frontier-node/Cargo.lock: ba8f0e3f3a6a1451ed90ea6567e828232899d352eafec2eccc35edcad9291499
