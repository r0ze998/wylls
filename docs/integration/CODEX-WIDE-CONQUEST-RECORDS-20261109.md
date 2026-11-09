# Wide Free City conquest records and rent boundary

Date: 2026-11-09. Base: `fb00f3d84a7c51f9f5b17e933dbd9156e6d6c27a`.

## Scope and activation boundary

This is the next storage/accounting increment toward a complete host-only
wide Free City siege, not an enabled siege command. It adds full-reference
records and pure lifecycle plans, and connects reservation guards to the
actual existing legacy ticket/conquest/close paths. No command writes either
new record yet. Wide Resolve still refuses all nonzero conquest records.
Declaration, actual wide bell integration, funded capture settlement, terminal
close dispatch, event commitments and replay must land together before that
refusal can be narrowed. No production, SBF, departure, mixed-family or
sending gate changes here.

## Provisional storage contract

- WideConquest: 1,664 bytes, one table per wide province, 128-byte header and
  twelve 128-byte site entries. Magic PSFXWCQ1, version 1. Header stores Season,
  full ProvinceKey and immutable rent payer. An entry stores SiteRecordRules,
  full Citizen address, optional full source Holding reference with sequence
  zero, matching Citizen tag, reserved slot, original target generation, and
  an immutable declaration bell. Unused bytes must be zero.
- WideCaptureEscrow: 320 bytes, one per Citizen. Magic PSFXWCE1, version 1.
  It stores Season/world/Citizen, immutable account-rent payer, current escrow
  funder, retained escrow, and exact target/generation/declaration bindings for
  slots 2 and 3. Duplicate active targets and noncanonical inactive slots fail.
- Provisional tags wq and we use separate PSF-WIDE-CONQUEST-SEED-v1 and
  PSF-WIDE-CAPTURE-ESCROW-SEED-v1 domains. Source searches found no collision.
  These are experimental draft identifiers, not stable ABI allocations.
- Citizen SLOTS bits 4/5 provisionally identify wide ownership of the existing
  slot-2/3 reservation bits 2/3. The ordinary low bits continue to exclude a
  reserved slot from all existing lowest-free-slot calculations. A wide bit
  without its corresponding reservation is malformed. NFT bytes are untouched.

Prefix Record rule fields and actor tag must match their table entry, with
src always zero: no full source is packed, narrowed or replaced by a hash in
the legacy source field. Empty table positions permit only canonical
no-obligation prefix immunity. Entry sources must name a same-world wide
Holding generation accepted by the current Holding codec. Targets whose next
generation would be 0 or 255 fail before a declaration plan: this is the
existing record representability limit, not a change to capture wrapping.
Generated Free Cities start at generation 0 and capture to generation 1.

Three-way validation binds the table, escrow and authenticated Citizen
position. It checks the entire wide reservation mask, every active empty
inventory slot, immutable declaration identity through failure/completion,
and matching same-province obligations in both directions. A foreign
province binding requires that province table at the operation handling it;
this helper does not pretend to authenticate an account not supplied to it.

## Existing rules and lifecycle plans

The shared original-game site_transition advances the rule state. Its effects
are returned for atomic application alongside the full-reference table and
prefix mirror. The caller must authenticate and advance the province bell
cursor; a record alone is not a replay or clock authority.

- Declaration admits only a Free City and preserves HELD | NEUTRAL. Free
  Cities skip ordinary holding immunity, as in the existing handler.
- Failed Free City siege burns the resource stake, clears the source, and
  leaves the Citizen slot owed. It does not invent a source-stake refund.
- A successful siege becomes CaptureDue and retains full source/Citizen
  context. The later capture plan returns the source stake and leaves
  post-capture immunity measured from completion, not settlement time.
- Active siege lapse requires an ended Season and a province resolved through
  end_bell. A late unresolved final bell cannot be converted into failure.
- There is no ordinary player cancellation.
- Escrow top-ups target one wide Holding rent per active reservation. The
  funder changes only on top-up; retained funds keep their existing funder.
  Failure/lapse refunds up to one wide rent. Successful capture consumes only
  the actual rent shortfall of the destination, retaining any excess.
- Terminal refund plans work even with active bindings, so Aborted or expired
  Seasons do not strand rent waiting for impossible resolution. They return
  the exact active-slot cleanup mask, escrow refund and account remainder to
  their separate stored recipients. They grant no close authority and return
  no resource gold. A future close handler must reuse the existing Ended+72h,
  Aborted or tombstone guard, clear authenticated Citizen markers atomically,
  and reject later settlement against a missing/closed escrow. Cleanup cannot
  depend on a province/source/table that may already have closed.

A capture plan is not a funded holding creation. The future handler must
validate the authenticated target mirror, create the final wide Holding,
bind its inventory slot and counters, apply capped generation-aware source
credit, and commit every account effect together. None is claimed complete
by these pure plans.

## Integration into current writers

Wide rent is for a 1,344-byte Holding, while existing Citizen TICKET_ESCROW
uses 1,280-byte rent. Experimental legacy FileTicket/FileOutpost and
DeclareSiege now count only legacy-owned reservations in that escrow.
Legacy SettleSiege refuses a wide-owned slot before any source credit;
SettleCapture refuses it before any capture effect. CloseCitizen refuses
active wide reservations before refund/close. WideClaimSite refuses active
wide capture reservations, maintaining the unsupported pending-WideTicket
combination in both directions. Ordinary legacy tickets/reservations on the
other slot can coexist without pooling or redirecting the wide rent.

These paths do not create a reservation and do not enable wide capture. The
default build retains its previous masked reservation count and has no new
record writer. The narrow program tests cover helper/accounting behavior;
source review checks dispatch ordering, not an executed end-to-end capture.

## Verification

Independent pre-execution review traced the eight new ABI tests and two
program helper tests through their callees. They execute only literal data,
codecs, bounded collections, scalar arithmetic, public-data SHA256 seed
hashing and the shared siege transition. No private-key or signing path,
project subprocess, fixture exporter or native-crypto test is selected.
The existing compile-time audit in
`CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md` remains applicable: no dependency,
manifest, feature definition, build script or lockfile changed. The full cached
archive verification was not repeated. Non-login shell, Rust1.89.0, offline
locked Cargo and two jobs reused the existing native aarch64 target cache.

Results on the final sources:

- wide_conquest: 8 passed with world-index-experimental.
- wide_capture_guard_tests: 2 passed with wide-world-experimental, 239 unrelated
  program tests filtered out. The existing unused Wide::at warning remains.
- Existing conquest_site_transition (8), cq_conquest_model (14) and
  cq_kernel_vectors (6): all passed both with default features disabled and
  with world-index-experimental.
- Total: 38 distinct selected tests, 66 successful executions, zero failures.
- permutation-frontier library checks passed for default and
  wide-world-experimental builds. No SBF or compute-budget check was run.
- Formatting and git diff --check passed.

Selected new commands were `cargo +1.89.0 test --offline --locked -p
frontier-abi --features world-index-experimental --test wide_conquest` and
`cargo +1.89.0 test --offline --locked -p permutation-frontier --features
wide-world-experimental --lib wide_capture_guard_tests`, each with
`-- --test-threads=1`. Existing regression target selection is recorded in
`CODEX-CONQUEST-SITE-TRANSITION-20261109.md`.

Reviewed/executed SHA256:

- world_index/conquest.rs:
  `02121f78d9b776b01118f9041a0316ce22173f1ca30a00ce534075eed0363cc0`.
- tests/wide_conquest.rs:
  `3c928b37f58e334a81d08068a9f8fbad7a8bef3d03018aaef7687217c6f72fc2`.
- proc/citizen.rs:
  `96e203586c596ac812c74bd51b4544519032c846e1fad70fe6d3cd6c83468e31`.
- proc/conquest.rs:
  `d52fbe903d495fe157da1b3551416645cc2302c574a63f0bf845afdd3cffd4e3`.
- proc/wide.rs:
  `9828b5d6496cfadfd6cd0d5d353330594c9fb5d14a0680907a1f18a33b796c49`.
- Root Cargo.lock remains
  `87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.

The held 14-file observation/UI slice and node-key review metadata are not
changed. No private-key generation/derivation/signing, real transactions,
exporters, CI, deployment or SBF/compute-budget measurement is part of this
increment. Original user-playable gameplay remains radius 128.
