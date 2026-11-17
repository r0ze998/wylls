# Original expedition terminal rent cleanup

The existing original `stage_terminal` contract now has a private exact-byte
writer. `[0xFF, 'T', 'C', 1, slot]` is an isolated five-byte draft, not an
allocated instruction or a member/camp settlement version. Generic dispatch
continues to reject it. Its exact roles are Season, original Holding position,
owned bridge and the bridge's immutable rent recipient; the last three require
write privilege. It is permissionless and accepts no outcome, recipient,
balance, retained authorization or proof verdict from the caller.

This implements the already-defined season-terminal rule: Aborted, Ended after
its existing 72-hour grace, or canonical Closed tombstone. In the same call it
re-authenticates the Season, public addresses, strict original owned bridge-v2,
slot and matching marker when the Holding remains. A closed Holding must be
the canonical absent position. It clears only the matching marker, closes the
external bridge and refunds all its lamports to its immutable recipient.
Embedded escrow, reserve, ownership, existing Holding chain and all other
Holding bytes remain unchanged. Existing CloseHolding still owns escrow sweep.

Every mutable borrow and recipient overflow is checked before effects. Duplicate
keys and synthetic cross-key storage aliases refuse. After staging, resize is
the sole remaining fallible mutation; all other output borrows stay held. Host
success/writeback checks establish refusal inertness, not SBF failure rollback.

The separate 248-byte `PSFT` version-1 receipt records full original host/owner,
slot, Holding presence, rent recipient/amount, time and complete ordered
before/after account manifests. Its domain-separated digest binds the runtime
program and Season. It is a standalone terminal observation, not PS2/PSW1 or an
active gameplay-chain advancement. No existing kind, receipt or fixture is
repurposed. The codec checks exact shape, scope and digest; a receipt alone does
not prove account provenance, authorization, terminal status or seal validity.
Generic readers do not yet index PSFT; public admission remains unavailable.

## Continuous failure evidence

A new native lifecycle variant uses the unchanged existing retreat=0 public
proof/body path. Only initial world configuration differs: the enemy is at the
kernel's valid maximum strength and the finite Season ends at bell13. Actual
original departure, original Resolve and SettleOrigin produce zero survivors
and `DestroyedAtOrigin`. Actual EndSeason then changes the Season to Ended.
Terminal closure refuses while Running and one second before the grace deadline,
succeeds at the deadline through encoded bytes, and rejects replay with exact
unchanged successful writeback. No account data or balance is injected after
departure. No Reveal/Gather/destination combat is claimed for this dead host.

The initial test enemy exceeded the existing troop cap and correctly failed
Kernel validation. The fixture was corrected to `MAX_HOST_TROOPS`; no runtime
validation, damage rule or production limit changed.

## Verification

Seven selected exact tests passed, with no ignored tests:

- ABI `world_index::expedition_terminal_ix::tests::terminal_wire_is_exact_closed_and_separate_from_settlement`.
- Native `proc::wide::expedition_return::terminal::tests::terminal_wire_closes_rent_only_with_present_or_closed_original_holding`.
- Native `proc::wide::expedition_return::terminal::tests::terminal_wire_requires_actual_end_grace_or_canonical_closed_tombstone`.
- Native `proc::wide::expedition_return::terminal::tests::terminal_wire_refusals_are_inert_after_successful_native_writeback`.
- Native `proc::wide::expedition_gather::exec::lifecycle_tests::contiguous_original_destroyed_departure_and_terminal_rent_cleanup`.
- Existing native `proc::wide::expedition_gather::exec::lifecycle_tests::contiguous_original_boundary_camp_loot_settlement`.
- Existing native `proc::wide::expedition_gather::exec::lifecycle_tests::contiguous_original_boundary_capture_and_resident_home_return`.

The terminal tests cover present/closed Holding, aborted/ended/closed Season,
wrong addresses and owners, wrong slot, missing/extra roles, missing writable
flags, aliases, recipient overflow, marker mismatch, replay, corrupted receipt
bytes, and exclusive/shared borrow conflicts. Refusals are caught inside the
invocation, followed by successful official writeback with unchanged account
snapshots and zero logs/CPIs. Shared borrows also test late preflight, after
read-only authentication/staging has completed. Success checks full lamport
conservation, exact rent transfer, exact marker-only mutation and full manifest
readback. The two regressions retain immutable trace/role snapshots.

Commands used installed Rust1.95, cached `--offline --locked` dependencies,
`--target aarch64-apple-darwin`, `-j 2`, `CARGO_INCREMENTAL=0`, one full test name
and `--exact --test-threads=1`. ABI used its own manifest with
`--lib --features world-index-experimental`. Native execution used the existing
runtime-contract manifest/target directory and
`--lib --features public-proof-tests,system-cpi-tests`. Four pre-existing
unused-code warnings remain. There was no full suite, new cryptographic fixture,
private-key operation, signing, new sealing, SBF, chain, service or CI run.

## Remaining failure contracts

This is terminal rent cleanup, not live-season bad-seal or nonmember settlement.
Destroyed-origin Gather rows are `present=false`; treating them as ordinary
members would change existing routed/nonmember tip allocation. Correct live
settlement needs separately versioned outcome/receipt contracts covering
reward payout, pool diversion, final-set membership, destination roster
forfeiture and exact rent/retained-slot cleanup. These effects cannot be inferred
from the existing member-v1 receipt's fate-only contract. Continuous worlds
also do not end through EndSeason, so this does not make a continuously running
world's failed expedition settle. Public activation, live browser submission,
reverse sealed movement and Solana-target validation remain incomplete.
