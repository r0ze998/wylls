# Provisional paired original-to-wide member settlement receipts

This is a closed experiment, not an external ABI allocation or deployment
approval. All public lifecycle, mixed-world, departure-debit, SBF and autosend
gates remain false. No new economics, instruction opcode, account layout,
entity, signature flow or WideHolding is introduced.

## Reservation and reader boundary

The current repository's original/v2/resident event definitions, PSW1 enum,
allocation inventory, proposal documents and tracked patch text were inspected
for semantic collisions. PS2 kind 148 and PSW1 kind 25 have no existing event
allocation. Existing PS2 GARRISON 25 and CapacityPool AccountKind 25 are different
namespaces. Reservations through 147 and PSW1 through 24 stay unchanged.
These two identifiers are provisionally reserved only by this experimental
contract. Recheck before merge with another allocation branch.

Only world_index::expedition_settlement_event decodes these records. Existing
strict original, v2, client and generic PSW1 readers remain fail-closed. An
unknown event is not a skipped successful replay. Integration must explicitly
select this bounded decoder and require both records from the same transaction.
Changing an old kind or coercing the source to a WideHolding is forbidden.

## Wire format

Each body is exactly 454 bytes before its tail:

- Original version 1/kind 148 or wide version 0x82/kind 25, then bell u32 LE.
- Settlement version 1, flags u8, transit slot u8, zero reserved u8.
- Host reference 56, immutable original Citizen account address 32, original Holding 32,
  external owned bridge 32, destination key 50, destination Province address 32.
- Changed original home key 50, changed PREV_HOME Holding address 32,
  optional original Citizen address 32. Absent values are all zero.
- Shared operation ID 32, input digest 32, output digest 32.

Flags bit 0 denotes changed original home Province, bit 1 changed PREV_HOME
Holding, and bit 2 optional original Citizen. Bits 0 and 1 are mutually
exclusive. Other flags, reserved bytes, noncanonical absent values, lengths,
identities, zero tail sequences and trailing bytes refuse. Source owner is the
full-width original Citizen address, never its wallet key, PREV_OWNER_TAG or
current captor. Optional Citizen equals that address without deriving it again.
Home is the host's issuing
province. PREV_HOME is an original Holding, not a Province or WideHolding.

Tail starts with one byte count. Each link is entity u8, seq u64 LE, head 32.
Original order is issuer Holding, optional changed home Province or distinct
PREV_HOME Holding, optional Citizen. Repeated Holding entity codes refer to
distinct explicit addresses in that fixed order; generic entity-deduplicating
readers cannot handle this record. Wide tail is exactly destination Province.
Maximum conservative bound is 619 bytes, below the explicit 800-byte emitter
buffer. Real mutually-exclusive variants use at most three original links.

Original links use the unchanged log::advance algorithm; wide link uses the
unchanged domain-separated event::advance. Sequence overflow refuses before
effects. Both records carry identical identity, bell and operation receipt.
Decoding and pair checking are structural; verify_previous recomputes links
against authenticated address-matched histories, which callers must supply in
the specified order. Neither records nor their hashes prove those histories.

## Preparation and full commitments

prepare receives borrowed complete before/staged-after AccountSnapshots,
Identity, Context and fixed Outcomes. It returns both record byte vectors,
ordered original links and destination wide link. It reads previous chain
headers from before snapshots. Staged after headers must remain unchanged;
the caller installs returned links only after successful preparation.

The exact manifest order is Season, original Holding, owned bridge, original
home, wide destination, resolved inputs, slot, immutable bridge rent recipient,
optional captured PREV_HOME, anchor/archive, signer payer, slot beneficiary,
resolver, Holding rent payer, settle beneficiary: 14 or 15 entries. No alias
is removed. One-based role order, address, owner, presence, signer/writable
flags, lamports, length and complete bytes are hashed. Aliases must have equal
observed state; role and observed privileges remain individually committed.
The private command is transit slot followed by commitment32 and full sealed
bytes, not a new wire instruction. Context includes program, Season address,
identity, exact command, time, slot, bell, full Season and length-delimited
evidence. Evidence must include all additional authenticated settlement inputs.

Input hashes preserve raw chain headers. Output hashes normalize only issuer,
actually changed original home/PREV_HOME and destination Province headers.
All aliases of each advanced address normalize equally. Unchained inputs,
slots, bridge, account versions, owner identity, absent accounts and all other
header/state bytes remain committed. Streaming per-account hash folds preserve
order without copying the complete manifest into one allocation.

Outcomes commit fate, credited milli-troops, three ordered tip/fee/bond payment
legs (intended recipient, amount, diversion), POOL_OWED increase, bridge and
slot rent refunds, slot refund recipient and retention. Diversion preserves
the intended recipient but transfers no lamports; the Holding liability is
committed by its complete post-state. Summed diverted amounts must equal the
reported pool increase. Per-address balances must match all legs and refunds,
including repeated recipients. Closure snapshots are absent, system-owned,
zero-lamport and empty. No absent slot is credited or spuriously closed.

The preparation API initially refuses any Citizen flag because this private
member path rejects camp winners. The bounded wire codec can describe the
optional original Citizen chain but does not enable camp Works or its writer.
Its use requires a separately reviewed complete account table and policy.

## Trust and tests

This codec is a commitment and consistency layer, never a proof of permission,
seal opening, economic legitimacy, issuance, route history, full producer
history, account authenticity or transaction rollback. The runtime must perform
real proof and current state checks in the same invocation, authenticate all
addresses/owners/layouts, stage unchanged economics and acquire every distinct
mutable borrow before any actual write, close, assignment or log emission.

Eight pure key-free tests cover pairing and chain recomputation, strict
truncation/trailing/reserved mutations, distinct PREV_HOME/Citizen attribution,
manifest/header/alias commitments, malformed tails, diversion/retention and
full preparation with balance/privilege refusals, and malformed public Record
values (missing/wrong-side links, wrong context and receipt checksum).
verify_previous revalidates identity, receipt checksum and exact side shape
even for records constructed directly without decoding. All eight passed after independent static audit, using the exact library
namespace only. No gameplay or runtime close is executed by these codec tests.
