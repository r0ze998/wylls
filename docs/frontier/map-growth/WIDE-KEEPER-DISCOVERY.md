# Wide keeper discovery model (2026-11-07, on `b7b93a79` + `db24789e`)

A **read-only, bounded observation** model of the wide world for the keeper:
`frontier-node/crates/keeper/src/wideindex.rs`, behind the keeper feature
`wide-world-experimental` (which turns on `frontier-abi/world-index-experimental`
and `fclient/wide-records-experimental`). Not compiled or run by its author;
the parent runs the named tests.

## What it is, and is not

From captured `PSW1` records (body version 0x82) it models, for **one world**,
the provinces touched, the holdings and hosts by **full reference** (56-byte
`WideHostRef`, 50-byte `ProvinceKey`; the `Muster` payload's `u64` alias is
never read), each host's transit slot, departure, reveal, departure settlement,
settlement and close, the arrival slots, days and inputs by exact identity, and
the closes of slots, days, inputs, transits, rosters and provinces. From that it
derives **read-account requirements** (canonical addresses by public PDA
arithmetic, with reasons) and a per-host list of what a future settlement still
lacks.

It is **not** a duty and it authorizes nothing. The legacy land and play
indexes still stop at the first `PSW1` record (`feedguard`), the legacy
cursors and their durable blocker are untouched, the production debit gate
stays closed, and every status and observation carries `automatic_writes:
false` and `source_complete: false`. The model never knows the history it was
given is the whole history, and it never says so.

## Interface (`keeper_core::wideindex`)

- `Scope { program, season, world, source }`: the provenance a caller asserts;
  recorded verbatim, never widened.
- `WideBatch { seq, slot, signature, bodies }`: one successful transaction's
  `PSW1` bodies, already authenticated by the caller.
- `Limits { max_bodies_per_batch, max_body_bytes, max_batch_bytes,
  max_provinces, max_holdings, max_hosts, max_slots, max_days, max_inputs,
  max_anomalies, max_nested_entries, max_superseded_per_host, max_fingerprints }` with
  conservative defaults (64 bodies, 4,096 provinces, 65,536 hosts, 4,096
  fingerprints, 262,144 aggregate nested entries, 8 superseded marches per host).
- `WideDiscovery::new(scope, limits)`, `apply(&batch) -> Result<Applied,
  Refusal>`, `observe_horizon(through_seq, source)`, `cursor()`, `blocked()`,
  `coverage()`, `block_external(..)`, and the state maps `provinces`,
  `holdings`, `hosts`, `slots`, `days`, `inputs`, `anomalies`.
- Queries, all returning an `Observation { seen, observed_through, horizon,
  source_complete: false, blocked }`: `reveals_at(dest, bell)`,
  `open_transits(holding_ref)`; plus `read_plan() -> Vec<ReadRequirement>` and
  `settlement_inputs(host)`.
- The adapter: `observe_tx(&TxRecord, &program) -> Result<TxObservation,
  fclient::typed_log::DecodeError>` with `TxObservation::{Legacy, RolledBack,
  Wide(WideBatch)}`, and `WideObserver { model, counts… }` with
  `observe_page(&[TxRecord], &program)` and `status()`.
- Keeper: `Keeper::enable_wide_observation(limits)` sets the optional field
  `wide_observer`; `refresh_discovery` shows it every feed page it pulls, before
  the legacy guard ingests the page; `/v1/status` gains `wide`.

## Rules

- **Caps before any change.** The input caps (bodies per batch, bytes per
  body, bytes per batch) are checked first; the state caps (every map, the
  anomalies, the superseded marches of one host, and the aggregate entries in
  province record/bell/host collections, holding host sets and day bell sets)
  on a staged copy of the model
  before it replaces the live one. A cap exceeded refuses the batch and
  **blocks** the model: nothing is evicted, no identity or cursor history is
  dropped. (Only the replay fingerprint window is bounded by forgetting its
  oldest entries, and a replay of a forgotten sequence blocks.)
- **Atomic batches.** Every body is decoded and parsed before any state
  changes; a batch with one refused body applies nothing.
- **Monotonic sequence with fingerprints.** A batch at or below the cursor is
  matched against the fingerprint recorded at its sequence (slot, signature,
  sha256 of the bodies): identical → an idempotent no-op (`Applied::replay`);
  different → `ReplayConflict`, **blocks**; no fingerprint held (older than the
  first batch or beyond the window) → `ReplayUnknown`, **blocks**. The model
  never stays in a trusted state after a replay it cannot judge. Sequence zero
  is rejected because it denotes the feed start cursor, not a transaction.
- **Blocking refusals.** Another version (the retired 0x81 by name, or an
  unknown one), a malformed body, a key of another world than the scope's, a
  cap, a replay conflict or an unjudgeable replay. A blocker is sticky; there is
  no reset. The adapter also blocks on a log structure the reader refuses.
- **The horizon is not completeness.** `observe_horizon` records the feed
  horizon the caller observed (an empty page at a sequence, on a named
  source). It changes no answer: `source_complete` is always `false`, and an
  observation with nothing seen is "none observed in the applied history",
  never "none exist". The arrival evidence is the ArrivalDay account, which the
  plan asks to read.
- **Terminal evidence is kept.** A record attributed to a closed province, a
  reveal into a closed slot, a reveal or gather into a closed day, a gather
  into closed inputs, a stage of a settled
  or closed march, or a second close of the same account never overwrites the
  first close or terminal record: the later activity is counted on the account
  (`after_close`) and recorded as an anomaly. A close whose reveal or gather is
  not in the applied history still creates the account's entry with its exact
  identity and rent facts, and the plan asks to read it.
- **Attribution by full key.** A host record is attributed to the province
  it happened in, never to the host's home; its holding is the host's issuing
  holding (`holding_ref`). A `TransitSettled` keeps the sealed destination
  beside the province it was judged at.
- **No inference from omitted fields.** A `Revealed` record's bell is the
  bell it was logged at; the slot is keyed by the arrival bell of the host's
  `Departed` record of the same transit slot when present, else not indexed
  (an anomaly). A stage without its departure is a shell transit with an
  anomaly. A `Resolve` is recorded on the province without claiming it consumed
  a gathered record. The `displaced` flag is kept as a flag.
- **Plans are reads.** Identity, canonical address, reason; deduplicated, in
  address order; closed accounts listed to confirm they are gone. Nothing in a
  plan is an instruction, a signer or a write.

## The feed adapter and the keeper

`observe_tx` uses `fclient::typed_log::decode_transaction`: a failed
transaction is `RolledBack` (never a wide event), a committed transaction
without `PSW1` bodies attributed to the program is `Legacy`, a committed one
with `PSW1` bodies — failed CPI subtrees already removed by the reader — is a
`WideBatch` at the feed sequence. `WideObserver::observe_page` applies the
pages in strictly increasing sequence order. It rejects zero sequences and
unordered or duplicate sequences within a page before applying that page.
Ordered overlap across pages is checked against a separate bounded SHA-256
fingerprint window of full, deterministic `TxRecord` debug bytes, covering
legacy, rolled-back and wide outcomes and every field, not only decoded
bodies. Identical overlap changes no state or counters; conflicting or
forgotten overlap blocks permanently. Both fingerprint windows respect
`max_fingerprints` (including zero). The observer rejects a program argument
that differs from the model scope before decoding. Non-contiguous forward
sequences count as gaps, and reader refusals block the model. These observations
still make no completeness claim.

The keeper shows the observer **the same pages** its legacy discovery pulls,
in `refresh_discovery`, before the legacy guard ingests them. Consequences,
stated: when the legacy cursors disagree (the separate-pull branch) the
observer is shown nothing that tick; when the legacy indexes are blocked no
page is pulled, so the observer sees nothing new (it has seen the page that
contained the first `PSW1` transaction, and no later one); on a process start
the observer is empty and is shown the pages again from the legacy cursor's
replay; the legacy durable blocker is never cleared by this. All of that is why
`source_complete` is `false`. No network path, signing, duty or write was
added.

`/v1/status` → `wide`: `mode`, `automatic_writes: false`, `source_complete:
false`, the cursor and first sequence, the horizon if observed, the counts
(batches, records, wide/legacy/rolled-back/replayed transactions, decode
failures, gaps, provinces, holdings, hosts, slots, days, inputs, anomalies) and
the blocker; `{"mode": "disabled", …}` when not enabled.

## Missing provenance for a future keeper settlement

`settlement_inputs(host)` makes the gap explicit. From the records a settlement
has the host and holding references, the transit slot, the origin, the bells,
the escrowed amounts, the seal root, and — once a reveal is seen — the
destination and the slot. It does **not** have the **commitment** (32 bytes)
or the **sealed body** (264 bytes): the wide `Departed` record carries only
their root (the legacy `DEPART` carried both). They are in the Depart
instruction's data, which a feed reader would have to take from the
transaction, not the logs, or in the owner's request. THE anchor's round-T
signature and the ClashInputs, roster and holding state are account reads. No
keeper settlement of a wide march can be planned from this model.

## Validation at this checkpoint

`frontier-node/crates/keeper/tests/wide_discovery.rs` (literal bodies and
literal transaction logs; no key, no signature, no transaction, no network, no
program execution, no chain verification):

```sh
cargo test --locked --offline -p keeper --features wide-world-experimental --test wide_discovery
cargo clippy --locked --offline -p keeper --features wide-world-experimental --lib --test wide_discovery -- -D warnings
cargo test --locked --offline -p keeper --test wide_feed_guard
cargo clippy --locked --offline -p keeper --lib -- -D warnings
```

- `batches_apply_atomically_and_index_full_identities_only`
- `identical_replay_is_idempotent_and_any_other_replay_blocks`
- `wrong_world_version_and_malformed_bodies_refuse_the_whole_batch_and_block`
- `input_and_state_caps_refuse_before_applying_and_block`
- `observations_are_never_authoritative_and_the_horizon_claims_nothing`
- `stages_without_their_departure_are_kept_as_anomalies_not_inferred`
- `close_only_slots_days_and_inputs_keep_exact_identity_and_rent_and_are_planned`
- `activity_after_a_close_never_overwrites_the_close`
- `feed_transactions_are_frame_checked_and_rollbacks_are_never_wide_events`
- `observer_exact_replay_covers_every_transaction_outcome`
- `observer_unknown_replay_zero_and_bad_page_order_fail_closed`
- `observer_cannot_decode_a_foreign_program_under_its_scope`
- `aggregate_nested_caps_are_atomic`
- `reveal_and_gather_after_day_close_keep_terminal_evidence`

The default-feature keeper build compiles neither the module nor the field;
`wide_feed_guard` passed 12/12. The new `wide_discovery` suite passed 14/14. Feature-enabled library/test clippy, default library clippy, and feature-enabled binary compilation passed. No binary startup, real feed request, key generation or signing was executed; test transactions contain literal records and invocation logs. Static review found no remaining blocking issue in this scope.

## Touched files

`frontier-node/crates/keeper/Cargo.toml` (the feature), `src/lib.rs` (the
gated module export and table row, the optional `wide_observer` field,
`enable_wide_observation`, the page hook in `refresh_discovery`, the `wide`
status entry), `src/main.rs` (explicit opt-in only), `src/wideindex.rs`, `tests/wide_discovery.rs`, this document. No
fclient, findex, herald, web or ABI file.

## Explicit CLI opt-in

The feature-enabled binary accepts `--observe-wide` to call the read-only
observer setup before its normal tick loop. The default build rejects this
option. This does not authorize or enable wide sends, clear the durable feed
blocker, or alter normal keeper signing behavior. The binary itself was not
started for validation: normal keeper startup handles keys, which remains
outside the permitted test scope. Only compilation is checked.
