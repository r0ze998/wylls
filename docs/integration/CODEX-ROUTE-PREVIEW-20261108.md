# Original map route preview refresh

Base: `claude/gallant-ride-cunptv` at `f293a684` (2026-11-08).

## Fixed behavior

The original game map's preview could retain a path through an obsolete set of
palisades because its cache counted obstacles instead of identifying them. A
failed route could also remain cached after a ring gained its seed. Its arrival
turn was frozen until the current turn changed, and a stationary pointer kept
its ribbon even after the relevant feed changed.

- Geometry is cached by kernel, both endpoints, unit, actual ring seeds and
  blocked hexes. The cache is bounded to the 96 most recently used routes.
- Arrival is calculated from the current clock, rate and lead window each time.
- A map draw refreshes stationary hover without requesting another draw.
- Survey visibility is refreshed before the hover path. Losing the acting host
  or access to the target removes the old ribbon.

This changes the existing game page. It adds no separate game, rules, wallet,
transaction, account layout or fixture world.

## Verification and limits

- `node --check permutation-server/web/frontier/app.mjs`: pass.
- `node --test permutation-gateway/test/web-frontier-route-preview.test.mjs`:
  13/13 pass.
- Before the fix, five app-level checks fail: obstacle movement, newly seeded
  ring, arrival within a turn, unchanged-pointer refresh and renderer wiring.
- `node scripts/ci/scan-node-key-tests.mjs --check`: pass, no list changes.
- `git diff --check`: pass.
- Read-only review found survey-before-hover ordering; corrected and covered.

The test imports only Node built-ins and the dependency-free route cache. It
reads the original app as text and evaluates only the reviewed routeTo and
hoverPlan section with pure substitutes for the planner, clock, map and store.
Its optional `WYLLS_ROUTE_APP` input was used only for the checked-out baseline
source during the before/after comparison. It does not boot the app or invoke
wallet, network, worker, SDK, WASM or signing code. The scanner itself reads
source and invokes only `git ls-files`.

These are focused behavior regressions, not a whole-page browser or live-chain
pass. Rendering performance, real rules-kernel behavior and march submission
were not revalidated by this change. No key-generation, key-derivation, signing
or key-guard self-test was run. Broad suites were not run, and the publication
commit uses `[skip ci]`.
