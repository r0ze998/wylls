# Closed live-season destroyed-member failure settlement

The existing economic rule is `frontier-abi/world_index/settle.rs::plan_settlement`:
for a real bad-seal verdict, the escrowed tip + march fee + bond becomes the
settle beneficiary's reward. Destination forfeiture is needed only for a final
Stays/Withdrew host. The previous original member/camp consumers deliberately
refused every bad seal and had no failure receipt contract.

This patch implements the smallest subset that needs no new economic rule:
a current-generation original host that is a unique, unsettled, resolved
`FATE_DESTROYED` member and whose canonical arrival slot is absent. A private
301-byte draft `[0xff, 'F', 'S', 1, slot, commitment, ciphertext]` has the explicit
14-role current-generation table. It is not a member/camp version, an allocated
instruction or public admission. PREV_HOME, retained-slot claims, other fates,
nonmembers and valid-seal settlement remain unsupported by this entry.

The consumer repeats the production canonical anchor/archive selection,
settlement grace, stored root/pair checks and real wide opener. Only opener
codes 1/2/4/5 proceed. It then authenticates the strict owned bridge-v2, original
marker, current ownership/issuance, resolved final-set identity and absent slot.
It derives the original marker's financial input and calls the existing shared
BadSeal payment table. No caller may submit an outcome, reward, survivor amount,
plaintext or retained proof capability.

The writer removes exactly this escrow and marker, pays the reward (or applies
the existing rent/program-owned-account diversion into Holding pool_owed), sets
the exact member's settled bit, closes the external bridge and refunds its full
balance to its immutable recipient. Home and troop reserves do not change.
Repeated payee aliases share all staged balance/data updates. Every mutable
borrow is acquired before the closing resize; the existing member/camp writer's
unchanged commit loop is factored for reuse. No CPI is performed. Successful
native writeback demonstrates the effects and refusal inertness; it is not SBF
rollback or bank execution evidence.

The independent 418-byte `PSFF/v1` receipt binds program/Season, original host and
owner, destination, slot, actual seal code, reward/diversion, bridge rent, time,
full ordered input and output manifests, and both original Holding and wide
Province chain advances. Only output chain headers are normalized to avoid a
hash cycle; all input chain bytes remain committed. Both chain links are derived
from this separate body. No PS2/PSW1 event number or member/camp receipt is reused.
An existing PS2 zero-link DIVERT event is also emitted when required, with the
existing REWARD reason. PSFF is an explicit private observation contract: generic
readers do not index it and its digest alone proves neither proof authenticity
nor producer history. Consumers must verify prior links and manifests.

## Bounded verification

Four selected exact tests passed with installed Rust 1.95, cached dependencies,
`--offline --locked --target aarch64-apple-darwin -j 2`, `CARGO_INCREMENTAL=0`, and
`--exact --test-threads=1`:

- ABI `world_index::expedition_failure_ix::tests::failure_wire_is_closed_exact_and_disjoint`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::bad_destroyed_wire_pays_existing_reward_and_closes_during_running`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::bad_destroyed_reward_diversion_and_recipient_alias_are_exact`.
- Native `proc::wide::expedition_return::proof::settlement::failure::tests::bad_destroyed_unsupported_proofs_roles_and_late_failures_are_inert`.

Native tests use the existing runtime-contract manifest/target, features
`public-proof-tests,system-cpi-tests`, and one full exact name per invocation.
They verify the immutable public Quicknet signature, copy public ciphertext and
corrupt its compressed point. They perform no opening-key recovery, synthetic
valid body construction, new sealing, signing or private-key operation. The
existing valid fixture's synthetic branch is not invoked; public fixture files
are unchanged. All initial accounts remain declared snapshots, not a proven
continuous producer history from departure/Reveal/Gather/Resolve.

Checks include Running success, full reward and lamport conservation, rent
refund, pool diversion, shared rent/reward recipient, program-owned inputs as
payee, full manifest readback and previous-chain verification, corrupted receipt
and chain rejection, replay, all other member fates, nonmembership, retained
slot, grace, root mismatch, missing roles/privileges, closing-account alias,
recipient/chain overflow and late shared borrow conflicts. Refusals are caught
inside a successful official writeback and require exact unchanged accounts and
zero logs. Public dispatch and the old member consumer still refuse these bytes
or the bad seal respectively. The test harness initially rejected inconsistent
duplicate-role privileges; the fixture was corrected to change every duplicate
view together, with no production relaxation. Four pre-existing dead-code
warnings remain.

Existing valid member/camp lifecycle tests were not rerun in this batch because
their fixture helper constructs a valid encrypted body from a recovered public
opening key. Under the current no-new-seal instruction only the new invalid
ciphertext path was executed. The shared proof and commit extraction preserves
the old statements and order; static review plus the old member's bad-seal refusal
is the available regression evidence for this batch.

## Remaining execution gaps

This does not settle live nonmembers, destroy-at-origin rows (`present=false`),
Stays/Withdrew forfeitures, retained failure claims or previous generations.
Those need explicit bounded contracts and tests for their existing payment and
roster rules, not a guessed extension of this receipt. Original live departure
through complete failure-producing history, generic PSFF indexing, client draft
construction, public activation and Solana-target execution remain incomplete.
No service, chain, CI, SBF, full suite, commit or push was run.
