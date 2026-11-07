# Wide writer / reader layout integration (2026-11-07)

This is read-side compatibility and refusal testing, not a completed wide
march, a live world run, replay acceptance or deployment. Wide departure debit
remains disabled (`DEPART_DEBIT_ENABLED = false`). All test inputs are synthetic
fixed-byte data. No keypair was generated, no transaction signed and no chain
write sent.

## Inputs combined without conflicts

- Writer `641b1b15`: staged interprovince handlers, PSW1 body version `0x82`,
  full host plus standing-province attribution, Holding `open_transits` field.
- Reader guards `c055c81d` and keeper guards `84bf34b5`.
- Captured-wide read view `38c4d52d`.

The ABI decoder returns `RetiredVersion(0x81)` for the retired body. Legacy
fclient refuses PSW1 under 0x81, 0x82 and future 0x83. Findex preserves the
unsupported raw archive but refuses index progress and reopening it as
supported history. Keeper write gates remain closed after unsupported or
incomplete discovery.

## Read-side changes

- The literal Holding fixture initializes `open_transits`. The field occupies
  offset 1286; the 1344-byte size and world/coordinate offsets are unchanged.
  A captured full-host-identity Holding with one open transit stays present.
  Unknown layout replacements are refused, never shown as closed or empty.
  Raw capture bytes retain the new field.
- A 0x82 ABI wire shape constructed with literal chain heads attributes a host
  event to its standing province while retaining a distinct home. This tests
  format attribution, not validity of a game event chain.
- A recorded-world walk checks its manifest count before accepting a terminal
  page. Missing entries give `IncompleteRecordedWorld`; excess entries or a
  contradictory continuation give `RecordedCountMismatch`. A refused page is
  not partially applied. A page-budget cutoff stays explicitly truncated.
- The browser herald client no longer turns malformed event responses into
  successful empty history. Its v1 envelope, array, decimal sequence order,
  matching next cursor and explicit fullness flag are required. This is not
  full event-body replay or proof of history coverage.
- `/h/me` requires the holdings and arrival arrays. An undecodable ArrivalSlot
  fails the read rather than disappearing. Explicit null Holding captures
  retain their old meaning. The synthetic event fixture now carries the
  current server's v1/fullness envelope and remains synthetic.

## Verification on the combined tree

Passed, with only the named keyless tests executed:

- Herald feature-on: `wide` 3/3, `wide_capture` 6/6.
- Herald feature-off: `wide` 1/1, routes explicitly unavailable.
- Fclient `wide_log_boundary` 2/2, including old/current/future prefixes.
- Findex `store_failure` 7/7, archive rejection under both event versions.
- Keeper `wide_feed_guard` 11/11, including durable and pending-retry gates.
- JavaScript: 28/28 across `web-frontier-herald`,
  `web-frontier-read-completeness`, and `web-frontier-wide-world`.
- Four-crate library clippy passed with warnings denied:
  `cargo clippy --locked -p fclient -p findex -p keeper -p herald
  --features herald/wide-world-experimental --lib -- -D warnings`.
- Edited Rust formatting, changed JS syntax and `git diff --check` passed.

Rust commands ran from frontier-node under its pinned Rust 1.95 toolchain.
Dependencies compiled but their other suites did not run. No root program
runtime tests, signing suites, browser visual acceptance, live ingestion or
deployment were performed here.

## Remaining boundary

The ordinary archive still deliberately refuses PSW1. This integration has
not enabled supported wide gameplay ingestion. The captured read-only sheet
is not the normal playable terrain/holding UI. Future writer revisions must
rerun these checks against their exact layouts. Nothing here enables the debit
gate or turns a fixture into a live-game result.
