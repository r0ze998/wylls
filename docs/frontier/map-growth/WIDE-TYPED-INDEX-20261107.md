# Opt-in typed wide log index

This checkpoint starts from `b7b93a79`. It adds a separate archive/index path,
not a switch that disables existing safety gates. Nothing was deployed, no
live feed was ingested, and no keypair or transaction signature was produced.
The checks below use fixed-byte observations and public SHA chain arithmetic.

## Interfaces and file boundary

Enable `wide-records-experimental` on fclient or findex. Default builds keep
their existing behavior. `fclient::log::bodies_from_logs`, ordinary Findex,
keeper, herald, ABI layouts and the writer are unchanged.

`fclient::typed_log::decode_transaction(&TxRecord, &Address)` returns:

- `TransactionRecords::Committed(Vec<ProgramRecord>)`, or
- `TransactionRecords::RolledBack` for a transaction reported failed.

A `ProgramRecord` is either `Ps2 { body, record }` (the existing owned PS2
record) or `Psw1 { body }`. `body()` retains the bytes, `format()` identifies
the wire format, and `wide()` revalidates and borrows the canonical ABI
WideRecord. These are not signed/authenticated source objects: runtime frame
attribution is checked inside the supplied logs, but source authenticity and
coverage are not established by this parser.

Complete invocation depth and matching exits are required. Only the target
program's innermost frame can contribute records. A failed CPI drops its
whole buffered subtree, including successful grandchildren. A failed
transaction contributes no events. A top-level failed invocation paired with
a successful transaction status is inconsistent and refused. Unknown tags,
versions, kinds, malformed data, truncated logs and missing frames return
errors, never successful empty history. Malformed `Program data:` boundaries
are retained until rollback filtering and rejected if committed.

## Dedicated index and store

`findex::wide_index::WideIndex` owns separate `wide_meta`, `wide_tx`,
`wide_event`, `wide_link` and `wide_chain` tables. PS2 bodies are retained as
PS2 observations without being inserted into legacy tables. All 14 current
PSW1 kinds remain separate observations. Full canonical World/ProvinceKey,
holding reference (including generation) and host reference bytes are
retained. Standing province attribution and the host's home holding are not
conflated. No dense index, shortened coordinate or legacy host alias is used.

Each wide link must match the next sequence and domain-separated head from
the preceding observed link, starting at zero. A missing chain prefix,
conflicting link, wrong world, replay, duplicate transaction signature,
archive gap or slot regression refuses the entire batch. ProvinceClosed is
a terminal province link; later chained province records are refused.
Unchained records remain observations and do not manufacture a chain proof.
The decoder checks wire shape, not game-state transition semantics.

A failed batch rolls back all its SQLite writes, retains the prior cursor,
and persists a blocker. Later pages and reads refuse while blocked. Catch-up
must be marked against the local archive end before serving any page. Even
when caught up, `source_coverage` is always `unknown` and
`capture_verification` is always `unverified`. No `verified` or complete-world
claim is available. An unknown entity is not proof that it does not exist.
Event pages are bounded to 256; all raw bodies and canonical keys survive a
cache reopen. Archive sequence storage explicitly rejects values beyond
SQLite's signed integer capacity; coordinates and chain sequence bytes are
not narrowed to that type.

`findex::wide_store::WideFindex` connects the existing `Source`/`Archive` to
this dedicated cache (`wide-index.sqlite`). It archives before indexing,
replays a durable unindexed tail on reopen and resumes the archived source
cursor. Index failures stop further pulls and preserve the raw archive. An
index ahead of the durable archive is refused. A durable blocker requires
retaining the archive and explicitly rebuilding a new compatible cache;
this implementation never automatically removes it. The store's recorded
account post-state remains raw archive data, not a verified capture.

## Focused evidence

Named keyless suites passed:

- fclient `typed_log_boundary`: 4 tests.
- fclient existing `wide_log_boundary`: 2 tests, still refusing PSW1.
- findex `wide_typed_index`: 11 tests, including full coordinates beyond
  2^53, all 14 wire kinds, chain mismatch, wrong world, missing prefix,
  terminal close, rollback, malformed/missing logs, bounded pages, durable
  reopen/catch-up, SQLite failure and archive preservation.
- findex existing `store_failure`: 7 tests, ordinary Findex still refuses
  PSW1 and cannot claim its coverage.

The two libraries passed clippy with warnings denied with the feature on,
and compile checks with it off. New-test clippy and edited Rust formatting
were checked separately. No blanket library tests or program-runtime suites
were run. The earlier browser tests were not rerun because no browser file
changed; no live-game/browser acceptance is implied.

## Next boundary

The dedicated API is ready for explicit consumers, but is not yet selected
by the herald CLI or served through its existing HTTP routes. Keeper's
future full-ID discovery adapter is separate work; automatic duties must
remain stopped until supported. There is no capture/account-head anchoring,
source signature verification, proof of absence, complete history proof or
wide replay verdict here. Matching a chain computed from supplied logs must
not promote raw captures to verified state.

## Later read-only serving checkpoint

The follow-on `WIDE-INDEX-READ-VIEW-20261107.md` connects an explicit
read-only herald path and separate UI history section. It also requires
schema 2 with an observed-content snapshot stamp; schema 1 is refused and
retained for an explicit separate replay, never silently migrated. The
source/capture verification limits above remain unchanged.
