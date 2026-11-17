# Original-map large-world geometry — 2026-11-09

Continues `3f898a9f`. These are changes to the original game's renderer and
camera, not a separate map demo, new fixture world, or a gameplay-rule change.
The playable legacy map remains bounded by radius 128. No claim of a truly
infinite playable world is made.

## Shipped improvements

### Close-up rendering no longer scans every opened province

`map/fmap.mjs` now imports/re-exports the original `visibleProvinces` API from
`map/viewport.mjs`. The implementation inverts the expanded pixel viewport to a
conservative axial window, enumerates only candidates in that window and the
requested ring, then retains the same pixel/tilted-quad predicates and distance
ordering. Equal distances preserve the original ring-index order.

At the tested desktop close view (1440×900, zoom 1, centred on the Concord),
**81 candidates** are considered at both radius 8 and radius 128. The old radius 128
loop visited **49,537 provinces**. This measures that culling loop's work, not
an end-to-end FPS gain; other renderer work can still scale with world size.

Nonfinite geometry, unsafe radius values and overflowing derived bounds fail
closed. A one-cell padding protects candidate enumeration at floating-point
boundaries; original pixel predicates decide final inclusion.

### The outer cloud margin no longer uses gameplay host indices

The old exhaustive culling called `ringProvinces`, whose `provinceFromIndex`
returns null beyond 128. The renderer requests additional cloud rings, so a
valid maximum-size season could reach a null province and throw. The new axial
enumeration and stable ring ordering handle the cloud margin directly.

This does not open those cells, assign host IDs, or supply terrain seeds.
Existing fog, world state and action checks still treat them as unopened or
outside the game's extent.

### Growth bounds use the exact hull

`camera.landBox` evaluates the 61 tile offsets at only six extreme province
vertices. Projection arithmetic and cached results are preserved. At radius 128,
cold work falls from **3,021,757 to 366 projections**. The centre-only case uses
61; a cache hit uses zero. Actual imported results exactly equal the exhaustive
old algorithm, without tolerance, for every opened-ring count 1–129.

## Checks

- **8/8 new guarded geometry tests** pass: exhaustive culling/order comparisons,
  desktop/phone/apron/thin viewports, six outer corners, negative coordinates,
  out-of-world views, tilted quads in both orientations, exact boundary points,
  fractional ring counts, cloud margin and malformed geometry.
- **74/74 explicit focused Node tests** pass, including previous original-map,
  route/arrival/controller and Free City regressions.
- **2/2 original-page browser scenarios** pass on desktop and touch phone.
  Actual play/spectator rendering, camera movement, KEEP panels, route previews,
  repeated compose/cancel and Free City fog/display checks remain intact.
- Browser key-use/storage/write/outside-origin checks are empty. No signing,
  key generation/derivation, transaction, guard self-test or CI was run.
- Static test inventory is current. The two new test closures and changed
  camera dependency in the Free City tests were reviewed before execution.

The geometry tests import the shipped modules. Camera projection-count
instrumentation additionally evaluates only its pinned, reviewed `landBox`
source with public geometry callbacks; correctness is checked against the
actual imported camera. No application boot, renderer, wallet, worker, WASM or
network request is invoked by these pure tests.

Commands:

```sh
node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test \
  permutation-gateway/test/web-frontier-land-bounds.test.mjs \
  permutation-gateway/test/web-frontier-viewport.test.mjs
node scripts/ci/scan-node-key-tests.mjs --check
node --test permutation-gateway/screens/codex-route-preview.screen.mjs
```

The combined 74-test run adds these two files to the eight explicitly listed in
[the Free City report](CODEX-FREE-CITY-INTEGRATION-20261109.md). Local logs are
`/tmp/wylls-route-preview-20261108/large-map-{geometry,node,browser}.log`.
No Rust/game-rule files or golden router data changed in this step.

## Remaining large-world gaps

These improvements do not remove all scaling limits:

- The fixed minimum zoom prevents the whole-map view from fitting a radius 128
  world on common screens. Lowering it needs a rendering-cost review.
- Startup waits for sequential ring overview requests before player setup.
- Some pending provinces can look like generated ordinary land although the
  inspector correctly says they are pending.
- Other world-wide record/painting work remains; a full radius 128 live-world
  browser load and FPS benchmark have not been established here.
- Wide-world records are still separate read-only experimental data. Actual
  infinite-world gameplay, transactions and deployment are not established.
