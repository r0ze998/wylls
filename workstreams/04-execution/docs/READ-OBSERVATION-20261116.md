# WS04: held, read-only findex observations (2026-11-16)

Base d16048aa. Independent branch codex/ws04-read-observation-20261116.
WRITTEN, NOT COMPILED OR TESTED. No syntax checker, imports, RPC, launcher,
world, signing, authentication, executor or receipt writer was run. Not complete.

## Scope and interface

`observation::read_observations(path, after, limit)` reads a bounded page from
an EXISTING findex database with SQLITE_OPEN_READ_ONLY, in one read transaction.
Only CARAVAN_SETTLED and CARAVAN_RAIDED are selected. The existing ABI's
`frontier_abi::v2::log::decode` and named-field table are reused. No fclient
Cargo dependency (which would bring keypair/signer/transaction dependencies),
new dependency or lock-file change. No change to findex or the executor.

Output `ws04-observation/0`: basis unproven; world/finality/complete null;
observations carry tx slot, signature, archive seq, PS2 ordinal, body hash,
local row locator, and decoded Settle or Raid. credited is always None.
ALL observations remain held for world binding, finality, transaction-record
identity and committed-frame provenance. This is NOT a receipt export.
The decoder alone does not verify program attribution or transaction identity.
The reader is not registered on the runexec CLI and has no runtime consumer yet.

## Source audit: ordinal is NOT instruction/log index

`frontier-node/crates/findex/src/index.rs::index_one`:
- top-level tx error returns before records;
- legacy mode obtains `bodies_from_logs(logs, program)`, then enumerates those
  filtered PS2 bodies. That enumeration is record.idx. It is NOT the original
  instruction index, log-line offset, or archive transaction ordinal;
- expedition mode enumerates typed records into typed_observation.ordinal,
  filters to PS2, then enumerates AGAIN for record.idx. These ordinals differ;
- (seq,idx) is the DB primary key. tx.sig has a NON-UNIQUE index, so DB schema
  alone does not prove a signature occurs once;
- event.ev depends on archive order; rollback/rebuild is not admitted as the
  same cursor epoch by this slice. next_local_cursor is local pagination only.
For identical raw logs, program, extraction implementation and mode, enumeration
is deterministic. Those premises are not certified by a row in this database.
No signature+idx stable chain ID is issued. local_locator is diagnostic only.

## Source audit: binding and finality are missing

Index::open receives program and optional AddrCtx in memory; its meta schema
stores integer markers, not program/season/cluster/commitment. Snapshots may
contain account bytes, but selecting one is not proof of which world every row
belongs to. A max slot is not finality. This slice accepts no caller flag that
turns either into proof. strict_ps2_v2_reject_psw1=1 and strict_ps2_blocked=0
are necessary local index checks, NOT chain authenticity/finality/completeness.
Unknown schema, blocked index and expedition mode are refused as a whole.

Additional provenance limitation: legacy fclient/src/log.rs::bodies_from_logs
pushes PS2 on the innermost matching frame and pops success/failed frames, but
never removes earlier output of a failed CPI subtree. A successful outer tx
can catch that failure. The newer typed_log::decode_transaction removes failed
subtrees, but this legacy index marker does not prove that decoder was used.
Therefore committed_frame_unproven is an unconditional held reason here.

## Units and intentionally unsupported routes

WS04 Res is whole units, matching logged u32 cargo/taken. Account stores/cargo
are milli units. Settlement logs do not contain credited inventory: never fill
credited from cargo. Slot comes from tx.slot, never log bell or block time.
The program's Caravan ARRIVE_TS (s1.rs @180, i64) is Unix time whereas WS04's
CaravanView/Event::CaravanSent has arrive_slot and executor compares to slots.
No conversion or arrival prediction is made; Sent and CaravanView are excluded.
raid_open requires route ArrivalSlot reads; no false default is invented.
Absent rows/accounts are not settlement, not not_sent, and not permission to retry.

## Contract with WS12/13

The current main lane uses readWs04Store -> connectCanonical. This output is
NOT that store and MUST NOT be silently converted to its receipts, chain source
labels, coverage or finality attestation. Consumer may display held reasons.
Future admission requires raw transaction/frame proof, world/source binding,
finalized context and an identity/replay contract; then a separate adapter can
map admitted positive events without a synthetic accepted run or auth bypass.
There is no current live source admission in this patch.

## Acceptance still open

Tests in tests/observation.rs are written only: ABI SETTLED/RAIDED mapping,
credited None, tx slot, mismatched/short/trailing records and unknown choices.
Still needed before merge: compile/type/lint checks; read-only DB tests for
markers/modes/corrupt rows/failed tx/limits/snapshot consistency; repeated tx
and conflicting body diagnostics; explicit cursor-epoch admission; integration
with WS12 held reporting. No test result is claimed. No source has become trusted.
