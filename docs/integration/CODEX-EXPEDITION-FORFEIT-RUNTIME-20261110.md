# Closed live Stays/Withdrew bad-seal forfeiture

This extends the private original expedition failure execution beyond destroyed
members, without changing PSFF v1. The existing `plan_settlement(BadSeal)` table
pays the complete escrow as a settle-beneficiary reward and requests forfeiture
only for Stays/Withdrew. The existing wide SettleTransit forfeiture block is now
`stage_roster_forfeit`; both the old wide handler and the new original bridge
consumer call this same implementation. The extraction preserves its conditions,
operation order, missing/busy no-op and wrapping roster-epoch increment.

The independent 301-byte `[0xff, 'F', 'S', 2, slot, commitment, ciphertext]`
draft requires the same 14 current-generation failure roles plus a distinct,
read-only canonical destination roster. Account count does not select a wire
version. The private entry repeats anchor/archive, grace, root/pair, real opener,
original ownership/issuance and unique unsettled final-set-member authentication.
Only bad-seal codes 1/2/4/5 with Stays or Withdrew and an absent canonical arrival
slot proceed. Destroyed remains v1; valid seals, other fates, nonmembers, retained
claims and PREV_HOME remain unsupported by this v2 entry.

The roster is authenticated by address, program owner, season, province and full
pairing with every live Province entry before a present roster is used. Matching
uses the full original host reference through the paired alias, not the alias
alone. If the host remains a non-busy STATE_ROSTER entry, the existing rule stages
`EntryOp::Forfeit`, `pend_bell = current_bell` and `ROSTER_EPOCH.wrapping_add(1)`.
This is the pending forfeiture operation, not immediate deletion or invented
troop accounting. A missing roster/host or already-busy host retains the existing
no-op. The roster side-table bytes are read-only throughout.

Reward/diversion, escrow and marker release, the exact settled bit, immutable
bridge rent refund and close use the same established rules as failure v1.
Destination changes are staged before alias-aware payments, manifests and chain
advances. All eventual output borrows are acquired before resize/assignment.
No CPI or public instruction dispatch is introduced.

The independent `PSFF/v2` receipt is 420 bytes. It adds the authenticated final-set
fate and whether forfeiture was actually staged, with v2 operation/manifest hash
domains. Its full ordered manifests include the 15th roster role. Only output
Holding/Province chain headers are normalized; all input bytes remain bound.
Both original Holding and wide destination chain links advance from this v2
body. The old v1 codec rejects v2 bytes and vice versa; no PS2/PSW1 kind or v1
meaning changes. Digests remain observations, not producer/seal authority.

## Evidence

Six selected exact tests passed under installed Rust 1.95, `--offline --locked`,
`--target aarch64-apple-darwin`, `-j 2`, `CARGO_INCREMENTAL=0`, and
`--exact --test-threads=1`:

- ABI `world_index::expedition_forfeit_ix::tests::forfeit_wire_is_closed_exact_and_disjoint_from_failure_v1`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::forfeit_wire_stays_and_withdrew_apply_existing_pending_operation_and_reward`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::forfeit_wire_preserves_existing_absent_busy_and_diversion_rules`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::forfeit_wire_scope_roster_proof_and_late_refusals_are_inert`.
- Existing v1 `proc::wide::expedition_return::proof::settlement::failure::tests::bad_destroyed_wire_pays_existing_reward_and_closes_during_running`.
- Existing v1 `proc::wide::expedition_return::proof::settlement::failure::tests::bad_destroyed_unsupported_proofs_roles_and_late_failures_are_inert`.

The native runs use the existing runtime-contract manifest/target and features
`public-proof-tests,system-cpi-tests`. The fixture path verifies the immutable
public Quicknet signature and corrupts existing public ciphertext. It performs
no recover_key, valid seal construction, key generation, signing or CPI. Initial
resolved-member and roster records are declared public-account snapshots; this
does not establish their complete producer history.

Tests cover both fates during Running, pending operation/current bell/epoch,
unchanged troops and home, exact reward/rent and total lamport conservation,
no-op absent/busy cases, destination payee diversion with duplicate account
views, complete receipt manifests against actual successful writeback, both
previous chain links, corrupt outcome/forfeiture observations, replay, other
fates, root mismatch, role count, wrong roster address/owner, unpaired live alias,
roster/payee alias, overflow, late shared borrow conflicts, version separation
and public dispatch refusal. Refusals return success from the enclosing native
invocation and require exact unchanged writeback and zero logs. Existing v1
success/refusal tests cover the proof helper's explicit mode split.

Independent read-only review found no concrete issue in the extraction, scope,
alias handling, manifests or preflight commit. The new ABI/runtime sources
introduced no warnings; existing and parallel-work warnings remain. No broad
suite, SBF, chain, service, CI, private-key operation, commit or push was run.

## Still incomplete

Live nonmember routing/bounce, retained-slot failure claims, previous generations,
full continuous failure-producing history, generic PSFF v2 indexing, public
activation and Solana-target execution remain incomplete. The current task does
not turn pending forfeiture into a proven downstream Resolve history or make the
browser submit this private draft.
