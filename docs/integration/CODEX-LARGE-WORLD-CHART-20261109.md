# Original-game large-world chart and progressive startup

This continues `96bfe7a8`. It changes the original `frontier/index.html` /
`spectate.html` map, not a separate demo, and does not raise any gameplay limit.

## Product changes

- The live camera's lower zoom bound follows the fitted world and uncovered
  screen area. The radius-128 chart can fit above a phone sheet instead of
  being cropped by the old fixed `0.02` minimum. M still returns to the exact
  prior camera. Farthest-chart flights use the existing wall-clock camera mode
  so expensive frames do not stretch a short trip into tens of seconds.
  The existing near-world minimum, flight timing and detailed art remain.
- Below eight CSS pixels across a province at world LOD, provinces are batched
  into chart polygons, at most 256 polygons / 1,536 vertices per fill path.
  Existing province colours, survey fog, public keep
  ownership and selection remain. Terrain generation, province-account
  hydration, per-province bitmaps and cloud-piece baking are skipped there.
- Tiny keep icons and their hit targets use the same presentation-only
  relevance filter. Selected/reachable keeps, own places and active own
  capture/loss/refusal marks remain available. Full keep records and capture
  bookkeeping are retained. Zooming nearer restores the original keep view.
  All keep views now cull by the same cheap province centre before any tile
  geometry is built; ordinary far marks no longer build unused tile geometry.
- Boot starts viewer setup while ring overviews stream in. Boot and controller
  refreshes share four concurrent read slots, coalesce duplicate work and
  prioritize the active village, selected province and camera ring. A newer
  season read rebases pending work and retries stale in-flight reads without
  letting an older response acquire a newer province-count stamp. Equivalent
  unchanged extent/count snapshots are accepted, preventing slow responses
  from being starved by frequent polls. Same-bell controller callers share
  the pending promise, with failed/partial reads remaining retryable. Ticket
  planning still awaits its overview requests.

## Safety and executable-path audit

The baseline browser/import/dependency review remains
[CODEX-LOCAL-BROWSER-AUDIT-20261108.md](CODEX-LOCAL-BROWSER-AUDIT-20261108.md).
No package lifecycle script, Rust build, guard self-test, signing, private-key
operation, chain transaction, seal worker or CI job is part of this change.

New Node execution is limited to the two focused test files and the previously
reviewed explicit regression list. The overview closure imports public
geometry/world/decoder definitions; tests call the queue with injected replies
and `applySeasonRecord` with no external service. Source-text assertions do not
execute app/controller. A separate controller regression extracts only the
reviewed refresh function and executes it in an isolated function scope with
explicit injected read callbacks; its review hash also pins controller.mjs
and its import closure through `targets=`. It never boots the controller.
The static scanner now conservatively classifies `new Function` as an
indirect execution path, so this review pin is mandatory rather than being
rejected as unnecessary. No scanner/guard self-test is executed.
The large-chart test calls real geometry, map prototype
methods, survey and keep presentation code with inert canvas / explicit data.
It does not construct the app, a wallet, worker or kernel. Tests use only
`screens/codex/no-key-node.mjs`, which replaces prohibited methods without ever
calling them. The broader SDK-loading guard is not used.

The browser runner uses the same already installed Playwright Core 1.58.2,
Chromium sandbox, fresh storage, native secure loopback origin and read-only
fixture server. The new startup gate only delays overview GET responses.
The new chart stress replaces **only the renderer's source** with public-shaped
radius-128 records. `FS.world`, real herald records, six-ring fixture, wallet,
clock and controller state are unchanged. M, resize and camera restoration call
only the original camera/drawing handlers. `onView` updates local LOD/minimap;
no action is submitted. The renderer source is restored before completion.
It is synthetic load QA of the original renderer, not an on-chain growth test.
Timing wrappers delegate unchanged to native canvas fill/stroke, backdrop and
keep frame methods, and are restored afterward. They do not alter their data.

## Verified results

- **99/99 focused Node tests passed**, using the explicit twelve-file list:
  map-contract, growth-route, map-arrival, dev-wallet-optout, route-preview,
  viewer-own-citizen, want-province, free-city, land-bounds, viewport,
  large-chart and overview-queue. No broad suite ran.
- **2/2 original-page browser checks passed** at 1440×900 desktop and 390×844
  touch phone, including prior route/palisade/KEEP/Free City/fog/reload checks.
- On both pages the real player's identity and holdings became available
  while every overview response was still held by the server. Four overview
  requests were in flight; no summaries had yet been stored.
- The dense chart used all 49,537 province coordinates with public-shaped
  control/keep rows, preserving canonical records in the fixture's six rings.
  Both viewports fit radius 128, picked province `(125,-40)` correctly,
  returned to the exact prior camera, and fit again after resizing to
  1180×760 / 320×568. Actual FS.world stayed at six rings throughout.
- Final forced full-draw samples: desktop **123 ms median / 135 ms max**
  (8 samples); phone **122 ms median / 236 ms max** (9 samples, including a
  114 ms backdrop refresh). Terrain and province callbacks: **zero** on both.
- Before bounding paths, the same dense desktop full draw was 2,384 ms median
  / 2,393 ms max. Bounded paths reduced the measured median by about **19×**.
  This is local synthetic load QA, not a production FPS guarantee.
- Dense keep tests retain all 49,537 state rows while drawing three relevant
  markers and testing only those three keep hit targets. Ordinary far marks
  require no province tile geometry. Sixty dense visibility/padding cases
  preserve exact membership/order; bounded legacy geometry comparisons agree.
- Queue tests cover 129 rings, progressive updates, priority changes, shared
  callers, repeated unchanged polls, changed counts, removed rings, client /
  format replacement, failures and actual extracted controller concurrency.
- Browser page/Node key-call counts, session/dev-key storage, browser/server
  writes and outside-origin requests were empty. No page exception occurred.
  Static review scanner and `git diff --check` passed.

The first dense browser attempts exposed both full keep-geometry construction
and frame-paced camera stretching. They failed the 30-second M-settle check;
the final test keeps that timeout unchanged. No guard self-test, transaction
or key operation occurred on failed or successful runs.

Local evidence remains under `/tmp/wylls-route-preview-20261108/`: final
`large-world-node.log`, `large-world-browser.log`, viewport performance JSON
and screenshots. The audit and fixtures in the repository suffice to repeat
the explicit tests; no user state or screenshot is required.

## Scale and remaining limits

Radius 128 contains 49,537 provinces. The previous keep visibility path could
materialize 3,021,757 tile geometry entries and tens of thousands of overlapping
minimum-size icons. The coarse path avoids that work, but still ingests and
indexes full overview/keep records and visits visible chart cells. It is not
constant-time and is not proof of smooth unlimited-world rendering. Near-view
keep hit testing still scans all rows (without tile geometry), large own /
reachable-marker lists remain costly, and full redraws are not 60 FPS.
Incremental overview indexing / stable chart-layer reuse are follow-up work.

The four-slot queue needs 33 response waves for 129 rings instead of 129 serial
waves in the deterministic response test. That is a concurrency bound and
latency model, not a production speed benchmark. Total overview bytes are not
reduced, and gameplay startup can still wait for conquest/planning reads.

## Why this is not an infinite gameplay world

The current legacy radius-128 boundary is a real protocol constraint:

- `permutation-rules/src/frontier/geometry.rs` enforces `R_MAX_HARD` in checked
  coordinates/indexing; the map processor uses those checked coordinates.
- `permutation-rules/src/frontier/addr.rs` packs province index (20 bits), site
  (4), generation (8) and sequence (32) into a host ID, and both directions
  reject coordinates beyond radius 128. Even removing that check would not
  make a 20-bit dense index unlimited (complete rings fit only through 590).
- `frontier-abi/src/v2/presets.rs` rejects ceilings beyond the hard bound.
  Legacy holdings and Citizen holding references also encode narrow
  coordinates; identity/transit migration must be addressed together.
- The legacy prize bitmap has its own smaller 1,024-province capacity. It is
  not the map's radius limit, and this change neither extends it nor publishes
  unresolved private-prize code.

The experimental wide implementation already contains substantial opening,
claiming, economy and march handlers. It is not simply absent, but is not
production-ready: `permutation-frontier/src/lib.rs` deliberately rejects
wide-feature SBF builds; `proc/wide.rs::DEPART_DEBIT_ENABLED` remains false
outside the explicit native-crypto crate-test build; keeper wide duties retain
`AUTOMATIC_SEND=false`; and the resolver refuses unported fort/caravan/conquest
states. Its i64 coordinate scheme is bounded too, not mathematically infinite.

[WIDE-LAND-WRITER.md](../frontier/map-growth/WIDE-LAND-WRITER.md) §−2.4i records
unresolved legacy/wide crossing, shared arrival and identity/accounting work.
Cross-family ordering/displacement and region-specific keep/Free City/camp/
beacon placement require explicit design decisions and reviewed production
ABI/ruleset allocation. This change does not choose those rules or remove the
gates. Safe next work includes bounded read/indexing and audited pure refusal /
lifecycle comparisons, followed by an explicit migration design.
