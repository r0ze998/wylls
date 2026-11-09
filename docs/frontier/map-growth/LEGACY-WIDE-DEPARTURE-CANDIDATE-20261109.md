# Closed legacy expedition departure candidate

This is the first movement segment, not playable boundary crossing. Original
homes and already-issued legacy troops remain authoritative. Route walking,
wide admission, return, stranded recovery, terminal cleanup and strict node
reader acceptance are not established. No public activation, SBF enablement,
transaction, signing or deployment is part of this change.

## Private candidate and account contracts

`proc/wide_expedition_exec.rs` separates authenticated, read-only staging from
private candidate commits. The explicit expedition gate remains false. There
is no feature/argument override. Ordinary legacy-only combat remains unchanged.

Departure uses a distinct provisional command, with the full original host
reference, one of the original four slots, arrival bell, tip, commitment and
wide seal. Accounts are the legacy Depart eight positions (actor, payer,
Season, Citizen, original Holding, standing legacy Province, System, issuer
legacy Province), followed by that slot's external bridge address.

Authentication includes original canonical account family, player authority,
Citizen's original slot binding, current generation, `seq < HOST_SEQ` (zero is
valid), capture lock, resident entry, finality, arrival/tip/funding checks and
the four embedded-slot host interlock. The existing Host `depart` kernel stages
its ordinary Spend on the original entry. No WideRoster or new army is made.
The embedded marker alone owns fee/bond/tip escrow. External troop result
fields remain zero until actual origin settlement; its financial fields stay
zero and its rent recipient is immutable.

Origin settlement takes a slot and the legacy SettleDeparture five positions
(payer, Season, origin Province, original Holding, issuer Province), followed
by the external bridge. It authenticates the current marker and exact external
pair, requires the departure bell resolved and exact original departed entry,
then obtains survivors from `Host::march_values`. It frees that entry and
advances the external state on one staged output. Destroyed results are zero.
Repeated settlement refuses rather than transferring twice.

Capture can clear the original marker's bond flag independently. Origin
settlement preserves current marker bytes and all financial ledgers. Current
generation issuance checks use current HOST_SEQ; captured generations do not
use the captor's reset counter. No troops are credited to either owner's
reserves here. Later previous-generation return must still use the existing
PREV_GEN/PREV_HOME rules; this candidate does not implement that recovery.

## Receipts and atomicity

Distinct provisional PS2 kind 146 continues original chains: Citizen, Holding
and Province on departure; Holding and Province on origin settlement. Full
ordered input/output snapshots include account identities, owners, privileges,
balances, current flags, external bytes and legitimate issuer/standing aliases.
Input chain headers remain bound; output chain headers are normalized before
their next links are prepared. No PSW1 record advances a legacy header.

Deterministic checks, output buffers and receipt links precede live effects.
Origin commit acquires all mutable borrows and validates lengths before the
first copy, then logs the receipt. Departure uses standard transfer/allocation
CPIs before copying its prepared bytes; CPI failure requires normal transaction
rollback. Public admission is closed regardless of these private candidates.

## Evidence boundary

The dedicated literal AccountInfo tests begin with an original legacy roster,
not a prepositioned wide resident. Focused tests cover Spend staging, unchanged
issued identity, refusal snapshots, survivor conservation, destroyed-at-origin,
replay, current capture-cleared flags, receipt chains/prefunds and atomic origin
commit refusals. These cases use real Host apply_clash and settle kernels with
an isolated combat result.

A separate nested test invokes the full original ResolveFromInputs instruction
against an opposing resident. The real clash kernel computes casualties, the
ordinary pending Spend is settled, and execute_origin transfers exactly those
resulting troops/stamina once. Repeating Resolve or origin settlement refuses
without further state changes. Public seed/cache and gathered input accounts
are prior-state fixtures: this does not verify PostSeed or Gather provenance.
Departure allocation/payment CPI is not exercised successfully by this harness.

Selected executions and static-audit boundaries are recorded in
../../integration/CODEX-EXPEDITION-DEPARTURE-20261109.md. Public activation,
complete crossing/admission/return and browser gameplay remain unverified.
