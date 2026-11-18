# From WS19 to WS4: can any held reason be lifted with what is adopted? (2026-11-17, source only)

**Branch:** `claude/ws19-ws4-evidence-gap-20261117`, cut from candidate d16048aa. Report only: no code changed.

**Nothing was run:** no test, build, syntax check, import, scanner, HTTP or RPC request, world, server or browser.

**Read, not changed:**
- WS4's `codex/ws04-read-observation-20261116` @ 7baa4d93 (the findex DB reader);
- `codex/ws04-frame-observation-20261116` @ bcd29aac (local): `fclient/src/read_observation.rs` `observe_supplied_transaction(tx, program)`;
- the candidate's `fclient` (`rpc.rs`, `lib.rs`, `Cargo.toml`) and `findex` (`ingest.rs`, `archive.rs`, `index.rs`, `provenance.rs`).

**Answer: no.** None of the held reasons can be lifted using only what is adopted and enabled today. Each one is traced below to the provider that exists, and to what it lacks.

## What exists

| Piece | Source | What it gives |
|---|---|---|
| finalized transactions of the program | `findex/src/ingest.rs` `RpcPoll`: `get_finalized_signatures_for_address(program)` then `get_finalized_transaction(sig)` (`fclient/src/rpc.rs:215`, `:262`, both `commitment: "finalized"`) | each transaction as the RPC answered it at finalized commitment |
| the transaction, kept with its logs | `rpc.rs` `parse_transaction`: `slot`, `signature`, `tx` bytes, `logMessages` → `logs`, `err`, `code` | raw logs and the error are kept (`post: []`: a public RPC has no post-state) |
| the append-only archive | `findex/src/archive.rs`: segments of `TxRecord` JSON frames (each with a sha256 prefix), a manifest `{version, segment_bytes, next_seq, cursor, segments}` | ordered transactions, and the source's cursor |
| coverage of what was archived | `RpcPoll::coverage`: `not_fetched` / `gap` / `unverifiable` / `cross_checked`, with an optional origin anchor and witness node | never "complete". The module says that passing the check does not prove a complete history, and that an archive without a record is no evidence that something did not happen |
| per-signature finalized status | `rpc.rs` `parse_finalized_status`: only `confirmationStatus: "finalized"` with a slot and an `err` field counts (used to end durable writes) | a current statement, per signature, from the RPC |
| failed inner calls removed from the logs | `fclient/src/typed_log.rs` `decode_transaction`, used by WS4's frame adapter | committed records only, relative to the supplied logs |

## Each held reason

| Held reason (4's) | Nearest provider | Why it is still held |
|---|---|---|
| `committed_frame_unproven` | `typed_log::decode_transaction` over an archived `TxRecord`'s logs (WS4 bcd29aac) | **`typed_log` is compiled only with `wide-records-experimental`** (`fclient/src/lib.rs:53–54`; `Cargo.toml` `default = []`). The default build's index uses the legacy `log.rs`, which does not drop a failed inner-call subtree (WS4's audit). RPC logs can be truncated, and the decoder then fails closed. So the frame is proven only in an experimental build, and only relative to the logs given |
| `finality_unproven` | `RpcPoll` fetches at `finalized`; `parse_finalized_status` per signature | **The archive does not record it.** The manifest has no `commitment`, no endpoint and no source kind. Only the cursor's shape (`rpc_last`, `rpc_coverage`, …) tells that `RpcPoll` wrote it, and that is an inference about the producer's code, not a recorded statement. A `LocalnetFeed` archive (`feed_after`) carries no finality at all. A per-signature status read is an RPC statement that only counts for the RPC's cluster (see world binding) |
| `world_binding_unproven` | the herald's `/h/season` (`programId`, `seasonAddress`, `cluster`, the Season account's `bytes_b64`) | **The archive does not name its program or cluster.** The program is the running findex's configuration; the manifest does not hold it, and the index's `meta` holds integer markers only. A declaration would be a label (12 already refuses to read a label as chain) |
| `transaction_record_identity_unproven` / `stable_event_identity_unproven` | the signature plus the typed-record ordinal after failed-frame removal (bcd29aac `typed_record_ordinal`) | **Deterministic only for the same logs, the same program and the same decoder version.** No contract between 4 and 12 says this is the record's identity or how a replay is matched. The legacy DB `idx` is the PS2 list position, not this; `tx.sig` is not unique in the index |
| `source_authenticity_unproven` | an RPC answer; 19's witness node | **An RPC answer is trusted only as far as the endpoint is.** 19's `cross_checked` compares signature lists, not what a transaction says, and is not completeness or finality |
| `coverage_unproven` | `RpcPoll::coverage` | **No state means complete** (19 never sets `complete: true`), so no absence and no `not_sent` follow |
| `not_executor_receipts`, `resume_cursor_not_admitted` | — | by 4's design: these are not receipts, and no cursor epoch is admitted |

**Conclusion.** No admitted path lifts any of them without a new statement from a producer, or a decision. So nothing is connected to receipts, and nothing is ingested. WS19's `complete` is not set to true, and no absence or `not_sent` is concluded.

## What would lift each one (the decisions it needs)

1. **Committed frame:** promote `typed_log` (or its failed-subtree removal) to the default build, or have findex record the decoder and version it used per archived record. *A build and feature decision (findex / 4).*
2. **Finality:**
   - Option 1: findex writes `{source: "rpc_poll", commitment: "finalized", endpoint}` into the manifest when it appends. *A findex manifest format change (version bump).*
   - Option 2: a reader re-checks each signature with `getSignatureStatuses` through the existing `parse_finalized_status`. *A reader design; it still rests on (3).*
3. **World binding:**
   - Option 1: findex records the program and the cluster's genesis hash (`getGenesisHash`) in the manifest.
   - Option 2: 12 corroborates the herald's Season (`/h/season` `bytes_b64` against `getAccountInfo(seasonAddress)` over a declared RPC).

   *Each is a rule someone must adopt; neither exists.*
4. **Record identity:** a contract between 4 and 12, for example `(signature, typed_record_ordinal, decoder version, body_sha256)`, with a replay and rebuild rule (cursor epochs). *4 and 12.*
5. **Source authenticity:** what corroboration counts, such as a second independent endpoint returning the same finalized transaction. *Owner and 19; it is not completeness.*
6. **Coverage:** stays as 19 states it. Absence is never concluded from it; no change is proposed.

These are independent of the resident's missing entry (13): admitting 4's records would not give a resident an entry, and the reverse also holds.

**Not changed:** 4's branches (7baa4d93, bcd29aac), 13's branch (5b2bed58), the candidate, C (9/10) and D (3/5).
