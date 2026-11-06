# History evidence in the verifier (V0H) — handoff, 2026-11-07

Base: `6984acfa4c0f9919c8c424a9bd5f2d59193d1639`. Verifier-side only (`frontier-node/crates/verify`, plus one field at the two `Input` construction sites in `stack` and `itest`). Workstream 19's coverage bundle (`4ee79ecc`, ws19-on-8e96f24d) has **not** been received and nothing here simulates it. The findex fix of `d8c876e4` (archive first; every failed store write poisons the ingester) is untouched.

## Why

Every check judges the transactions it is given. None can tell whether those are all of the season's. A findex archive proves its own integrity (sealed segments by hash, contiguous sequence numbers), not that the ingest saw every transaction. One node's `getSignaturesForAddress` cannot show a gap on its first pull, after a missing or old cursor, or in a range its own history lacks (`findex::ingest` module note). A fixture is whatever was recorded. Before this change a PASS over a partial archive or RPC history read as a PASS over the season.

## What the input now carries

`Input.history: HistoryEvidence` (`src/input.rs`), three parts:

| part | values |
|---|---|
| `source` | `Unstated`, `Dataset{label}`, `Archive{dir}`, `RpcPoll{url}`, `LocalnetFeed{url}` |
| `observation` | `Unstated`, `NotFetched{reason}`, `Fetched{records, first_slot, last_slot}`, `Gap{detail}`, `Malformed{detail}` |
| `cross_checked` | list of strings naming independent observations compared with this one; context only |

There is deliberately **no "complete" variant and no completeness flag**. `assurance` is derived (`HistoryEvidence::assurance()`), never read from a file; a file that writes `"assurance": "complete"` is ignored on that point.

A `Fetched` observation must be one a read can produce (`input::bounds_coherent`): zero records with no bounds; exactly one record with both bounds present and equal (one record has one slot; second review of 2026-11-07); two or more records with both bounds present and `first_slot <= last_slot` (several records may share a slot). One-sided or reversed bounds, bounds on an empty read, no bounds on a non-empty read, or a single record spanning two slots are `malformed`, both when read from a file and when built by hand.

Derivation (`Assurance`):

| observation / source | assurance | V0H finding (all `Unverifiable` severity) |
|---|---|---|
| `Malformed`, or `Fetched` with incoherent bounds | `malformed` | `HistoryEvidenceMalformed` |
| `NotFetched`, any source | `not-observed` | `HistoryNotObserved` |
| `Unstated` from `LocalnetFeed`, `Archive` or `RpcPoll` (a read source with no observation) | `not-observed` | `HistoryNotObserved` |
| `Gap` | `gap` | `HistoryGap` |
| `Fetched{records: 0}`, any source | `empty-observation` | `HistoryCoverageUnverifiable` |
| `Fetched` from `Archive` or `RpcPoll` | `unverifiable` | `HistoryCoverageUnverifiable` |
| `Unstated` or `Fetched` from `Unstated` or `Dataset` | `dataset-only` | none; report labels the scope |
| `Fetched` from `LocalnetFeed` | `local-feed` | none; report labels the scope |

`cross_checked` never changes the row. The finding's detail and the report line say an agreeing second observation is not proof of completeness or finality.

Reading a block from a file (`HistoryEvidence::from_json`) is strict: every named field must be present with its type (string `label`/`dir`/`url`/`reason`/`detail`, unsigned integer `records`, slot bounds absent or `null` only where coherent, `cross_checked` absent, `null` or an array of strings). Any deviation makes the whole block `Malformed`; the load itself still succeeds, so a broken block is judged, not skipped.

## Loader behaviour (`src/main.rs`, `src/input.rs`)

| path | evidence | verdict ceiling |
|---|---|---|
| `--fixture FILE` without a `history` block (every committed fixture) | `Unstated` | PASS, labelled dataset-only |
| `--fixture FILE` with a block | as recorded, read fail-closed (`HistoryEvidence::from_json`, above) | as the block says, never better |
| `--archive DIR` | `read_archive_observed`: `Archive{dir}`, `Fetched` with count and slot bounds | UNVERIFIABLE (exit 2) |
| `--rpc URL` | `observe_txs`: `RpcPoll{url}`, `Fetched` | UNVERIFIABLE (exit 2) |
| `--rpc URL --localnet` | `LocalnetFeed{url}`, `Fetched` | PASS, labelled local-feed |
| `--rpc URL` where `RpcPoll` refuses with `history gap …` | nothing verified: message and exit 2 (`input::is_history_gap`) | — |
| `--save FILE` | the block is written, so the saved run verifies the same way later | — |

`fetch_txs` and `read_archive` keep their signatures and now wrap the observed forms.

## Report (`src/report.rs`)

`report.json` gains `history` (`source`, `observation`, `cross_checked`, `assurance`). `report.md` gains a line `History evidence (<assurance>): <source>; <observation and bounds>[; cross-checked …]` and, for `dataset-only` and `local-feed`, a `Scope:` line saying the verdict judges the transactions given as a dataset, not the season's whole on-chain history. `checks_run` lists `V0H`. Findings go through the existing `Ctx::unverifiable` path (entity `history`), so the verdict rule is unchanged: any `Unverifiable` finding without a FAIL is UNVERIFIABLE.

## Compatibility choices (for the coordinator to confirm)

1. **Legacy fixtures stay PASS.** A file without the block is `Unstated` → dataset-only. This keeps the committed fixtures, the tamper suite, `mutate.sh` and the stack's `tamper` (which re-reads its saved input) working. The cost is that a dataset-only PASS is not a chain claim; the report says so on every such run rather than raising a finding, because the unknown is the scope of the verdict, not missing evidence about a judged transaction.
2. **Local feed is judged as the harness's dataset**, labelled `local-feed`, distinct from a fixture. Rationale: the in-process chain and the stack's node are the whole ledger by construction; the verifier cannot prove that from the data and does not claim it. Flipping `LocalFeed` to `Unverifiable` is one arm in `HistoryEvidence::assurance()`, but it would make every honest stack `verify` exit 2; that is a product decision and was not taken here.
3. **Observed `records` is reported, not compared with `txs.len()`.** The tamper suite and the coverage tests add or drop transactions of a cloned input on purpose; a mismatch finding would break the mutate builds' "the tamper now PASSes" assertion on a saved run. The report prints both numbers.
4. **A live gap aborts without a report.** Judging the transactions read before a detected gap would raise chain FAILs that blame the program for missing data. A declared `Gap` observation in an input (API or file) is still judged: `HistoryGap`, UNVERIFIABLE.

## Limitations

- No path here can produce a real-chain PASS. That needs coverage evidence (a full-history source or a second node compared by the ingest), which this tree does not have. When workstream 19's bundle lands, its result should map onto `observation` / `cross_checked` and, only if it gives a genuine completeness witness, onto a new assurance row; none of the existing rows should be relaxed.
- `cross_checked` is free text by design because the bundle's shape is unknown; it is never interpreted.
- The archive manifest's cursor is not read into the evidence (it may name signatures; the bounds come from the records).

## Tests (written, **none run**; no shell was available)

**Plain-data pure (candidates for a later, audited execution).** The unit tests in `src/input.rs`, module `history_tests`, touch only literal byte arrays, JSON built with `json!`, `HistoryEvidence` and `Input::from_json` on an in-memory fixture whose program id is `Address::new_from_array([7; 32])` (base58 encoding of literal bytes, not a derivation), 96 zero bytes for the drand key and no transactions. No key is generated or derived, no PDA is derived, nothing is signed, no file or network is touched:

- `history_assurance_follows_source_and_observation` (source × observation rows above; not-observed for an unstated read source; hand-built incoherent bounds are malformed; `bounds_coherent`)
- `history_json_round_trips_and_never_declares_completeness`
- `history_unknown_or_broken_blocks_are_malformed_not_upgraded`
- `history_fetched_bounds_and_field_types_fail_closed` (regression for the review of 2026-11-07: negative, fractional, string, one-sided and reversed bounds; bounds on an empty read; no bounds on a read; non-string source, observation and `cross_checked` fields)
- `history_input_without_the_block_is_unstated_and_with_it_is_kept`

```sh
# only after the coordinator audits the above for purity; from frontier-node/
cargo +1.95.0 test --locked -p verify --lib history_
```

**Not pure, and prohibited under the current no-PDA restriction (unrun, must stay unrun for now).** `tests/history.rs` calls `verify_core::verify`, which builds `Facts` through `findex::addr_ctx` and so derives the season PDA (the checks derive more). The same holds for every existing verifier suite that runs the verifier (`unit`, `coverage`, `evidence`, `new_bands`, `missing_state`, `open_items`, `camp_clear`, `fixtures`, `tamper`, `record_*`), for `mutate.sh`, and for the stack and itest tests. Their names, for the coordinator's later decision:

- `history_legacy_fixtures_are_judged_as_datasets_and_labelled`
- `history_local_feed_is_judged_as_the_harness_dataset`
- `history_archive_and_rpc_without_coverage_evidence_are_unverifiable`
- `history_an_empty_observation_is_not_a_pass`
- `history_gap_unread_and_malformed_are_never_a_pass`
- `history_round_trips_through_the_fixture_form_without_upgrade`

What they would show, once execution is permitted: the committed fixtures stay PASS and are labelled dataset-only; archive and RPC inputs are UNVERIFIABLE with `HistoryCoverageUnverifiable`; the report JSON and Markdown carry the history block. Commands for that later stage (not to be run now):

```sh
cargo +1.95.0 test --locked -p verify --test history
cargo +1.95.0 test --locked -p verify --test unit --test coverage --test evidence --test new_bands --test missing_state --test open_items --test camp_clear
cargo +1.95.0 test --locked -p verify --test fixtures -- --skip march_fixture_is_fresh
cargo +1.95.0 clippy --locked -p verify -p stack -p itest --all-targets -- -D warnings
cargo +1.95.0 build --locked -p stack -p itest
```

Nothing in this change was compiled; the first build is where a type slip in `src/input.rs` would surface.
