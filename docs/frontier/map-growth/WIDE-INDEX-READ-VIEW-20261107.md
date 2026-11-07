# Read-only typed-index serving and history view

This checkpoint builds on typed reader/index `f7601106` and incorporates
keeper discovery `d44a2299` as `593ff3c5` (keeper files were not edited here).
It connects a real SQLite reader to herald HTTP routes and the existing
wide sheet. It does not enable wide gameplay, replace captures with events,
or establish complete/authentic source history.

## Explicit setup, without an ingest/write side effect

Herald feature: `wide-index-read-experimental` (off by default).
Configuration: `--wide-index PATH` names an existing schema-2 dedicated
`wide-index.sqlite`. `WideReader` uses SQLite READ_ONLY, checks its schema,
program and full world namespace, and neither creates the file nor alters
its schema, clears blockers, rebuilds it, or advances its index.

For a checkpoint-only origin use `--source read-only`, `--data DIR`, the
matching `--program` and `--season`, and `--wide-index PATH`. No RPC argument
is needed in this mode. A valid matching `DIR/herald.ckpt` is required;
missing/damaged state is an error, not a new empty world. It serves existing
captures conservatively with `exact_post=false`; ingest reports stopped with
unknown coverage. It does not open the legacy ingest store, checkpoint or
rewrite files, contact a chain, or mount a relay destination. The ordinary
localnet/RPC modes and legacy PSW1 rejection remain unchanged.

The CLI was compile/lint checked, not run against a user's checkpoint or
live index. Tests invoke the real reader, loader and loopback HTTP origin
with the established fixture season and explicitly synthetic wide records.

## HTTP and snapshot contract

- `GET /h/wide-index/status`: scope, `observed|incomplete|blocked`,
  `indexedThrough` as a decimal string, content `snapshot` hex,
  `sourceCoverage=unknown`, `captureVerification=unverified`, and
  `automaticWrites=false`.
- `GET /h/wide-index/events?through=...&snapshot=...&after=...&limit=...`:
  at most 256 observations (UI requests 20), with raw tagged bodies,
  full province/holding/host keys, decimal archive/event sequences, next
  cursor and an explicit `more` flag. No chained head or body creates land.

Status can explicitly report a blocked/incomplete cache, but its event
endpoint refuses to return a successful empty page. Missing path/file,
wrong scope, corrupt metadata/body/key attribution, stale snapshot or cursor
are errors. Fixture-labelled origins refuse these routes. Default builds
return `WideIndexUnavailable`. All responses are no-store.

Dedicated index schema 2 adds a domain-separated cumulative SHA-256 stamp
of each full archived TxRecord JSON plus the preceding stamp. It includes
order, sequence, slot, signature, runtime logs/raw bodies, and captured post
bytes, rather than only chained-event heads. Full keys are derived from the
raw body and checked again before serving. Each read page pins metadata and
rows in one SQLite read transaction and requires both cursor-through and
content stamp. A replacement index with the same world and cursor but a
different observed prefix is rejected. This is snapshot identity, not
source authentication, signature verification or replay acceptance.

Schema 1 caches are refused without automatic migration/deletion. Retain
the archive and construct a separate schema-2 WideIndex from archive replay;
do not remove the old evidence to make a read succeed. Read-only serving
never performs that replay. WideFindex remains an explicit separate ingest
API, not a newly enabled default herald ingester.

## Small UI extension and boundaries

The wide sheet has a separate observed-history section with bounded next
pages. It labels records as obtained but unverified, with unknown source
completeness/account agreement, and explicitly says they do not establish
land or playability. The existing captured-unverified map remains distinct.

Client validation pins program/season/world, through and content snapshot;
checks canonical integer coordinates and full binary key fields, including
holding generation and host sequence; and matches those keys and event names
to the raw wire body's attribution. Malformed/unknown data is an error,
not empty success. This lightweight format check is not event-chain replay
or proof of gameplay validity.

When season/source pins become invalid or a non-network map-read error
occurs, the old history is removed and its pending request is invalidated.
Late answers cannot restore that scope. A normal later load can recover.
No transaction construction, signing, submission or new terrain rendering
is added by this section.

## Focused checks on the integrated candidate

Only the listed audited keyless suites were executed:

- fclient: `typed_log_boundary` 4 and `wide_log_boundary` 2.
- findex: `wide_typed_index` 12 and `store_failure` 7.
- herald feature-on: `wide_index_read` 4, `wide` 3, `wide_capture` 9.
- herald default feature-off: `wide_index_read` 1 and `wide` 1.
- keeper: opt-in `wide_discovery` 14 and default `wide_feed_guard` 12.
- Total: 69 Rust tests. Named JavaScript suites
  `web-frontier-wide-world`, `web-frontier-herald`, and
  `web-frontier-read-completeness`: 32 tests.

Negative cases cover missing/blocked/incomplete/wrong-scope indexes,
read-only file preservation, stale through/content snapshots, same-cursor
replacement content, old-schema refusal, false coordinate/body metadata,
source loss, late responses and recovery, and no event-to-land conversion.
The index tests now use a process-local atomic temporary-name suffix to
avoid parallel test collisions at coarse clock resolution.

Four feature-on libraries, the new reader tests and herald binary were
linted with warnings denied; the default herald binary was compile checked.
Edited Rust formatting, JS syntax and `git diff --check` were checked.
These are fixed fixture/SQLite/loopback HTTP and DOM-contract results, not
real-browser visual acceptance, a live chain run, deployment, or evidence
that wide movement is enabled. No keypair generation or signing occurred.
