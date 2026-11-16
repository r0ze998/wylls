# findex: the archive records what its source says of itself (2026-11-17, source only)

**Branch:** `claude/findex-observed-source-20261117`, cut from candidate d16048aa.

**Written, never compiled or run:** no `cargo build` or `cargo test`, syntax check, import or scanner, and no HTTP or RPC request, world, server or browser.

**Not touched:** WS4's 7baa4d93 and bcd29aac, WS13's 5b2bed58, the candidate, C (9/10) and D (3/5).

Follows `docs/integration/CLAUDE-WS19-WS4-EVIDENCE-GAP-20261117.md` (on `claude/ws19-ws4-evidence-gap-20261117`), which found that the archive records no commitment, program or source.

## What is recorded, and what is not

The manifest gets an optional **`observed`** list of epochs (`findex/src/archive.rs`, module note "Observed sources"):

```
"observed": [{ "from_seq": 3, "source": "rpc_poll", "program_configured": "<base58>", "commitment_requested": "finalized",
               "genesis_hash": null, "endpoint": null, "not_recorded": [ … ] }, … ]
```

| Field | Means | Does not mean |
|---|---|---|
| `from_seq` | records from this sequence on (until the next epoch) came through this source | — |
| `source` | the source's own word: `rpc_poll`, `localnet_feed`, `<inner>+enriched`, `unstated` | that the source is authentic |
| `program_configured` | the program the source was **given**: `RpcPoll.program`; `LocalnetFeed.program` (its filter, checked per record when set) | a program checked on chain |
| `commitment_requested` | what the source **asks** for: `RpcPoll` asks `finalized` for both its signature lists and its transactions (`get_finalized_signatures_for_address`, `get_finalized_transaction`); a local feed asks for none (`null`) | a proof that the answer was finalized |
| `genesis_hash` | always `null`: no source fetches it, so it is not observed | — |
| `endpoint` | always `null`: an RPC URL can carry a key (in the query, the path, the user info or the host), so no form of it is stored | — |

## Rules

- **Nothing is filled in backwards.** Records before the first epoch (an older archive, or appends from a source that said nothing) have no observation (`observed_for(seq) == None`).
- **No record is credited to a source it did not come from:**
  - another source starts a new epoch;
  - a source that says nothing, after one that did, starts an `unstated` epoch;
  - the same source continues its epoch;
  - an epoch no record was appended under is replaced (no empty epoch is left behind).
- **Backward compatibility:**
  - an archive whose sources never describe themselves has no `observed` key, so its manifest is byte for byte as before;
  - `MANIFEST_VERSION` stays 1;
  - older readers ignore the key (`from_json` reads named keys only);
  - a malformed `observed` list is refused when the archive is opened (fail closed).
- **Durability:** `observe_source` is called just before each append (`lib.rs` ingest, `wide_store.rs`), after a pull returned records. The epoch is written with the same manifest that names those records, so a crash loses both together.
- **Holds are untouched:** nothing here admits a record, states finality, completeness or a world, or lifts any of WS4's holds. Readers (12, 4) are not changed and do not read it yet.

## Changed files

- **`findex/src/archive.rs`:** `ObservedSource`, `ObservedEpoch` (to and from JSON), `Manifest.observed`, `Archive::observe_source`, `Archive::observed_for`, and the module note.
- **`findex/src/ingest.rs`:** `Source::observed()`, which defaults to `None` (so test sources and any other implementation compile unchanged); `LocalnetFeed`, `RpcPoll`, and `Enriched` (forwards, marked `+enriched`).
- **`findex/src/lib.rs`, `findex/src/wide_store.rs`:** `observe_source(src.observed().as_ref())` before the append; `pub use archive::{Archive, ObservedSource}`.

**Tests (written, never compiled or run):**
- `archive.rs`: `observed_sources_are_epochs_never_filled_backwards` (no key while nothing is observed; epochs at 3, 5, 6; no backfill; unstated after observed; an empty epoch replaced; the reopen; genesis and endpoint null) and `a_malformed_observed_list_is_refused_and_an_old_manifest_reads_without_one`.
- `tests/observed_source.rs`:
  - `RpcPoll` gives its configured program and `finalized`, and no part of a URL carrying a user, a password, a host token, a path secret and an `api-key`;
  - `Enriched` forwards;
  - text pins: both ingesters note the source before their append, and the observation has no endpoint.

## Decisions this needs (not made here)

1. **The endpoint.** It is stored as nothing. Alternatives, each needing a decision:
   - (a) an operator-declared label (a config word, never derived from the URL);
   - (b) a keyed fingerprint (HMAC with an operator secret).

   Scheme plus host only was rejected: hosts can carry tokens.
2. **The genesis hash.** It stays `null` until a source fetches it. Option: `RpcPoll` reads `getGenesisHash` once per epoch and records it as `genesis_hash_observed` (still an RPC statement, not a proof). This is a new request in the ingest path.
3. **The commitment, as proof rather than request.** Option: a per-signature `getSignatureStatuses` (the existing `parse_finalized_status`) at append time, recorded per record. A new request, and a per-record field.
4. **The program, as checked rather than configured.** Options: check that each archived transaction's account keys include the program, or read the program account once per epoch.
5. **Whether to bump `MANIFEST_VERSION`.** Not bumped here, because the key is optional and ignored by older readers.
6. **Who reads `observed` and what it is worth.** 12 and 4 do not read it; admission rules (WS4's held reasons, WS19's coverage) are unchanged. An observation is not evidence until someone adopts a rule for it.

## Reverse review (2026-11-17, source only)

**Fixed** (evidence: 3b426c52's own source):
1. **`from_json` checked each epoch's fields, not the list.** A list out of order, repeated or past the end was accepted. `observed_for` then credited a record to the wrong source: with `[{5, X}, {3, Y}]`, record 6 was given Y.
   - Now: strictly increasing `from_seq`, each with `1 ≤ from_seq < next_seq`, or the archive is not opened.
2. **`observed_for` answered for records that do not exist** (`0`, and `next_seq` and above, i.e. under a pending epoch). It now returns `None`.
3. **A pending epoch could be made durable.** A source was noted, then the append failed or had nothing, and a `commit()` wrote an epoch that covered no record. The next writer could inherit it.
   - Now `to_json` writes only epochs that cover at least one record (`from_seq < next_seq`).
   - In memory, a pending epoch is still replaced or continued by the next `observe_source`.

**Checked, no change needed:**
- **A failed manifest write or a crash:** the epoch and its records are lost together; the manifest names only synced frames, and the cursor is still before them.
- **An older writer appending to a newer archive:** its `Manifest` has no `observed` field, so its rewrite drops the key. Observations are lost, never moved onto its records.
- **A newer writer after an older one:** it finds no key, and every record stays unobserved.
- **`Manifest` literals:** only in `archive.rs` (`from_json`, `open_with`), both updated.
- **Public API:** `Source::observed` defaults to `None`, so the test sources in `findex/tests` and `herald/tests` compile unchanged. `ObservedSource` is re-exported, and nothing outside findex constructs a `Manifest`.
- **Other readers:** the manifest is hand-written JSON, with no serde derive and no `deny_unknown_fields`. Nothing outside `archive.rs` parses findex's `manifest.json` (the drand-replay archive has a manifest of its own).

**Clarified in the API and the module note: an epoch is NOT an endpoint identity.** `ObservedSource` is the producer's kind and settings. Equal values (the same `rpc_poll`, program and requested commitment) from different endpoints continue one epoch, by design: no endpoint is stored, and nothing may infer that one verified source served the records. Readers must not read equal epochs as the same or a verified source.

**New regressions (written, not run):**
- `epochs_out_of_order_repeated_or_past_the_end_are_refused_whole`;
- `a_pending_epoch_is_never_made_durable_nor_inherited`;
- `equal_observations_do_not_identify_the_endpoint`.

**Not verified:** no compile, no run. An archive written by the earlier 3b426c52 code with a pending epoch would now be refused when opened; that code never ran.
