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

## Close-writer integration checkpoint

Writer `d8c62f2d` (including the opt-in test-only native crypto checkpoint
`a78a50f1`) was merged normally into the read integration as `d2d50f8a`.
The merge had no conflicts. This reader pass did not run cryptographic or
program-runtime suites; it compiled and exercised only the named read-side
suites below. Departure debit is still disabled.

The additional writer events remain PSW1 body version 0x82: `RecordClosed`
(kind 12) and `TransitClosed` (13) have no event-chain links;
`ProvinceClosed` (14) has the terminal Province link. Full-sized synthetic
bodies decode with those shapes, yet fclient explicitly refuses all three
as unsupported history. Prefix probes for kinds 12–14 also leave findex's
index cursor unadvanced, preserve its raw archive and refuse reopening it
as supported history. Both keeper indexes stop before those probes. These
probes are not evidence that an event chain or a real close was verified.

The wide Close instruction's account tables were checked for all new
variants: ArrivalSlot takes 4–5 accounts, ArrivalDay and ClashInputs take
5 each, Transit takes 5 (including the canonical Holding position), and
Province takes 4. The account codecs in `land.rs`, `holding.rs`, and
`arrival.rs` did not change between writer `641b1b15` and `d8c62f2d`.
Existing fixed capture/DOM fixtures remain compatible. Explicit captured
Province and Holding removals in either order leave the province closed;
removing the Holding after the Province cannot reopen it. No log omission
is interpreted as an account close.

Checks on this combined tree passed: herald feature-on 12/12 (including
nine capture tests), feature-off 1/1, fclient 2/2, findex 7/7, keeper 12/12
(34 named Rust tests total), and the same 28 JavaScript tests. Four-library
clippy with warnings denied, edited Rust formatting and `git diff --check`
passed. No signing, key generation, live writes, deployment or browser
visual acceptance was performed. PSW1 indexing remains deliberately disabled.

## Final test-only checkpoint

Writer test checkpoint `6e15d6bb` was merged normally as `5df7cffb`, with
no conflicts. Its changes are documentation, wide runtime tests, and
helpers inside the `cfg(test)` quicknet/seal test modules. A static diff
against read checkpoint `1b02dfad` confirms that frontier-abi, frontier-node,
the browser reader/fixtures, and production handlers are byte-for-byte
unchanged. Accordingly, the 34 Rust and 28 JavaScript read results above
are inherited evidence from `1b02dfad`, not a new execution after this merge.
The writer reported 18 native-host tests, 16 native-crypto tests and 17
ordinary tests passing for `6e15d6bb`; those suites were not rerun by this
reader integration task. PostSeed/Sseed/depart fixture limitations remain,
as do the disabled debit gate and unsupported PSW1 indexing boundary.

## Native departure dispatcher checkpoint

Writer `85cf47f0` was merged normally as `800ad5a5`, without conflicts.
Static comparison confirms that frontier-abi, frontier-node and all browser
read code/fixtures are still identical to the preceding integration. The
34 Rust and 28 JavaScript read-test results remain inherited evidence from
`1b02dfad`; no read suites were rerun for this merge.

Unlike the prior test-only checkpoint, this writer changes `depart_as`:
Citizen ARRIVALS overflow is now checked before escrow movement and account
creation. `DEPART_DEBIT_ENABLED` is true only under the conjunction of
`cfg(test)`, `native-crypto-tests` and a non-Solana target. It remains false
in production, ordinary unit tests, linked libraries and SBF. No reader or
PSW1 indexing gate has been opened.

The writer reports 18 native-host, 17 ordinary and 6 default tests passing,
plus library lint. Its native-host experiment now executes actual Depart,
T/S beacon posting, arrival, settlement and return through the dispatcher
using public signature vectors rather than the earlier staged-departure
shortcut. This is still host-test evidence, not a deployed game or live
world run. These writer suites were not run by this reader integration
pass; no keys, signatures, live writes or deployment were performed here.
