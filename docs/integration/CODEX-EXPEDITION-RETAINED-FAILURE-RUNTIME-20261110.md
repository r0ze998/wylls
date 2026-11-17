# Retained original expedition failure evidence

The independent private v3 draft supports current-generation original resolved
members with Destroyed, Stays or Withdrew fate, a real bad-seal verdict and a
present canonical **expedition-v2** ArrivalSlot. Absent slots remain v1/v2;
legacy native-v1 slots, other fates, nonmembers and PREV_HOME are refused here.
The 301-byte `[0xff, 'F', 'S', 3, slot, commitment, ciphertext]` envelope has the
same explicit 15 roles as failure v2, including a distinct destination roster.
No account count selects a version, no existing instruction number is reused,
and the raw draft remains private. A separate opt-in host outer revision is
verified below.

Beyond failure v2's 15-role table no additional input is required: Season,
anchor/archive, slot and payment/refund roles already provide the evidence and
immutable recipients. Destroyed also uses this explicit roster role, unlike its
14-role absent-slot v1 path. Subsequent defence claiming separately supplies its
existing public pool/claim/System roles.
The consumer repeats real seal opening, marker/owned-bridge pairing, original
ownership/issuance, unique unsettled final-set membership and complete slot
identity/owner authentication. The slot must be a strict expedition-v2 record;
its representation, original owner and wear are preserved when retained.

The economic plan remains the existing BadSeal table: all embedded escrow is
the settle beneficiary's reward, with the existing pool diversion policy.
Stays/Withdrew use the existing `stage_roster_forfeit`; Destroyed makes no roster
change. Escrow/marker release, settled bit, bridge close and immutable bridge
rent follow failure v1/v2. The new slot branch reproduces wide/member settlement:

- `wide_claim_eligible` requires a live anchor slot, unclaimed evidence, remaining
  claim grace, sufficient lateness and a positive existing defence refund.
- Eligible evidence is retained and marked settled.
- Ineligible evidence closes to its immutable `rent_to` only when that address
  occurs in the existing payer/slot beneficiary/resolver/holding rent payer/
  settle beneficiary/bridge rent recipient roles, in the existing search order.
- Without a listed recipient it remains settled. No rent is redirected, no
  beneficiary is inferred and no claim is silently consumed.

All payment, forfeiture, slot and bridge changes are staged before mutation.
Repeated recipient roles share all balance/data updates. Every eventual mutable
borrow is acquired before the first resize; two-account close uses the existing
committer. This proves native refusal inertness through successful writeback,
not bank rollback or SBF execution.

PSFF v3 is a separate 462-byte observation with independent v3 hash domains.
Alongside fate/forfeiture and reward/bridge rent, it records slot retention,
claim eligibility, immutable slot rent recipient and actual slot rent refunded.
Full ordered 15-role input/output manifests and both chain advances bind the
real state transition. Only output chain headers are normalized. v1/v2 codecs
and meanings remain unchanged. A receipt digest is not proof of authority or
complete producer history.

## Verification scope

The selected native fixture path uses the existing immutable public Quicknet
signature and corrupted public ciphertext. It does not invoke recover_key,
synthetic valid-body creation, new sealing, private-key derivation or signing.
Declared initial slot/roster/Season/pool/claim records remain fixture snapshots.

The test cases cover all three supported fates, exact reward and two rents,
claimed and claim-deadline branches, unlisted immutable recipient retention,
reward/rent recipient alias and program-owned reward diversion, full manifest
readback and previous-chain verification, replay, absent/native-v1/mismatched/
already-settled slot refusal, missing write privilege, roster alias, overflow,
late slot-data and recipient-balance borrow conflicts and v1/v2/public refusal.

The continuous retained path uses actual settlement writeback for the existing
private expedition ClaimDefence and CloseArrivalSlot handlers. Pool, claim and
System accounts are declared before settlement; the claim account is already
allocated, so no allocation CPI occurs. It requires premature close refusal,
exact 98,852-lamport existing defence refund with only the slot's claimed byte
changed, repeat-claim refusal, immutable slot rent close and repeated-close
refusal. These two follow-up handlers retain their existing private typed entry
points; this patch does not allocate claim/close wire commands or public gates.

Independent read-only review found no concrete issue. Its additional coverage
suggestions for native-v1 slot rejection, rent/payee aliases, reward diversion
and roster alias were incorporated. The full original current-generation,
reserved-field and wear validations also remain exercised by their existing
strict codecs and common member authentication; no weakening is introduced.

All test commands use installed Rust 1.95, `--offline --locked`, aarch64 native,
`-j 2`, `CARGO_INCREMENTAL=0`, and one full exact name with
`--exact --test-threads=1`. Native uses the existing runtime-contract manifest/
target with `public-proof-tests,system-cpi-tests`; ABI uses its own manifest and
`world-index-experimental`. Six distinct selected exact tests passed:

- ABI `world_index::expedition_retained_failure_ix::tests::retained_wire_is_closed_exact_and_disjoint_from_failure_v1_v2`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::retained::retained_failure_closes_ineligible_slot_for_all_supported_fates`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::retained::retained_failure_keeps_eligible_evidence_then_claims_and_closes`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::retained::retained_failure_missing_recipient_and_late_refusals_preserve_state`.
- Existing v1 `proc::wide::expedition_return::proof::settlement::failure::tests::bad_destroyed_unsupported_proofs_roles_and_late_failures_are_inert`.
- Existing v2 `proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::forfeit_wire_scope_roster_proof_and_late_refusals_are_inert`.

The retained fixture uses the production `wide_region` result for both Province
and canonical anchor. The older settlement-only fixture had used region 0;
ClaimDefence correctly refused that mismatch. Only the new fixture's initial
metadata/address was corrected, with its public signature, round and invalid
ciphertext unchanged; no runtime validation was relaxed. A test-only System
owner literal typo and concurrent module-declaration compile conflicts were
also corrected before the successful final runs. No new warning comes from the
retained-failure files; existing/parallel-work warnings remain.

## Remaining boundaries

Public submission, nonmember routing/bounce, previous generations, full
continuous failure-producing history, generic PSFF v3 indexing and Solana-target
validation remain outside this closed contract. No valid seal, key, signature,
service, chain, CI, SBF, broad suite, commit or push is produced.


## Experimental outer dispatch integration

A subsequent opt-in host integration uses
`expedition_dispatch_ix::Kind::SettleRetainedFailure = 11`. Its exact outer
header is `[0xdc, 0xff, 2, 11]`, followed by the unchanged v3 inner draft. It
requires `expedition-dispatch-experimental` and exact Season/program revision
`0x4804`. Default/raw admission, deployed ABI and Solana submission are not
established by this integration.

One additional exact native test passed:
`proc::wide::expedition_return::proof::settlement::failure::tests::forfeiture::retained::experimental_dispatch_retained_failure_matches_private_writes_and_refuses_bad_flags_versions`.

It reuses the same corrupted-public-ciphertext fixture and compares actual
`crate::dispatch` writeback with the private consumer for both immediate slot
closure and eligible evidence retention. Every account and every emitted log
(including the full PSFF receipt) matches exactly; the private result also has
its full manifests and chain links checked. Each required writable privilege,
the payer signer privilege, outer version, kind/inner mismatch, inner v1/v2
version and wrong Season revision is refused inside a successful native
writeback with exact unchanged state and zero logs. The native signer flags are
fixture privileges, not generated signatures or signed-transaction evidence.

This additional run used the same installed/offline/locked/serial procedure,
with features
`expedition-dispatch-experimental,public-proof-tests,system-cpi-tests` and only
the full exact name above. No runtime or ABI source was changed by this test
integration; the dispatch owner supplied its codec/route. No keys, valid seals,
recover_key, signatures, chain, CI, SBF, commit or push were used.
