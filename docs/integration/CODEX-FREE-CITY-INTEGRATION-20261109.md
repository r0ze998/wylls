# Original-map Free City integration — 2026-11-09

## Product changes

Continues the original game at `0d252f0f`, rather than a standalone demo.
No new game rule is introduced.

- Names and sprite models now use ABI **state5** for Free Cities. Released
  state3 no longer appears as a Free City; reserved state4 remains unoccupied.
- A known Free City is an attack target under the existing neutral-target rule.
  L0/L1 land remains a movement target without leaking an attack marker.
- PSFOV2 `siteKinds=2` works when no live Province mirror is loaded. Kind-only
  changes invalidate the model, far-map and realm cache keys.
- The inspector shows a visible city's garrison and does not offer an outpost
  on it. Released free land retains its existing outpost behavior.
- Destination naming respects survey visibility for Free Cities, even when a
  larger Province account containing the hidden city has already been read.

## Canonical fixture and actual router data

`cqfixture/growth.rs` now applies the same `free_city_site` public hash rule and
minimum-ring condition as `permutation-frontier/src/proc/map.rs`. Mirrors use
state5, faction6, Hamlet0, zero genesis fields, and the preset's 300 whole troops
stored as 300000 milli-troops. HOME's city is site11/tile43; the new ring5 target
province's city is site8/tile48. Existing fixture holdings are protected against
a future site collision by an assertion.

OpenProvince-shaped records now include NEUTRAL after KEEP, using the canonical
nine-byte key, six-byte payload, Province chain link and genesis bell0. No real
OpenProvince transaction is executed. Signatures remain fixed public byte
patterns, not signatures produced by a key.

The real herald ingest/router regenerated the two S1 goldens. The M1 golden is
unchanged. Reviewed semantic differences are limited to:

- 24 unique ring4 Free Cities before/extended/opened; 54 including ring5 when grown.
- Matching day0 conquest events and overview2 site-kind bits.
- City mirror bytes and Province sequence/head; existing event sequence shifts.
- Season headSeq 145/146/147/238 (palisade239), with all other metadata unchanged.

## Validation

- **66/66 focused Node tests pass.** This includes 10 Free City UI regressions,
  the real Province/PSFOV2/NEUTRAL client contract, and the earlier route, arrival,
  config and controller checks. Test import/call paths were statically reviewed.
- **3/3 offline Rust map-contract tests pass**, both at the original baseline
  and after reviewed regeneration with `WS19_GOLDEN_WRITE` unset. See the
  [build/runtime audit](CODEX-RUST-MAP-AUDIT-20261109.md).
- **2/2 original-page browser scenarios pass**, desktop1440×900 and touch
  phone390×844, on secure localhost with devWallet off and Chromium sandbox on.
  Both scenarios cover play and the original spectator page.
- Existing KEEP history, same-count palisade movement, same-turn arrival update,
  repeated compose/cancel and clean reload checks continue to pass.
- 120 stationary source samples require zero additional path-plan calls. In the
  final run source median0ms, p95/max1ms; this is source-call timing, not an FPS
  or broad hardware benchmark.

The player fixture does not see tile43: it is outside the village/host's sight.
The actual player inspector hides its identity/defenders; the actual order card
names its terrain, with no attack marker. A route to it can be composed and
cancelled without sending. No survey field is overridden.

The original `spectate.html` intentionally uses full public visibility. Native
map selection and phone sheet expansion show **自由都市** and **守備隊300**,
with no outpost action. Wallet/session remain null and no order is composed.
This is legitimate observer visibility, not proof of a player's scouting or
capture. Visible player classification/defender display is covered separately by
pure UI tests, not falsely claimed as an in-game scouting result.

Browser checks require no key calls, seed/session storage, write requests,
outside-fixture requests, or unexpected page errors. All final checks were empty.
The guard is defense in depth after static review; no key-API guard self-test
was executed. No real wallet, seal, send, transaction, private prize code or CI
was used.

## Reproduction

Use the audited installed toolchain/dependencies and the same selected target;
do not substitute a broad npm or Cargo test command.

```sh
node scripts/ci/scan-node-key-tests.mjs --check
node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test \
  permutation-gateway/test/web-frontier-map-contract.test.mjs \
  permutation-gateway/test/web-frontier-growth-route.test.mjs \
  permutation-gateway/test/web-frontier-map-arrival.test.mjs \
  permutation-gateway/test/web-frontier-dev-wallet-optout.test.mjs \
  permutation-gateway/test/web-frontier-route-preview.test.mjs \
  permutation-gateway/test/web-frontier-viewer-own-citizen.test.mjs \
  permutation-gateway/test/web-frontier-want-province.test.mjs \
  permutation-gateway/test/web-frontier-free-city.test.mjs
node --test permutation-gateway/screens/codex-route-preview.screen.mjs
cd frontier-node
env -u WS19_GOLDEN_WRITE CARGO_BUILD_JOBS=2 cargo +1.95.0 test -p herald --offline --locked --test ws19_map_contract
```

Local output is under `/tmp/wylls-route-preview-20261108/`: free-city-node.log,
free-city-browser.log, rust-free-city-compare.log, desktop/phone-free-city-fog.png,
desktop/phone-free-city-order.png and desktop/phone-free-city-spectator.png.
Screenshots/logs are local QA evidence, not shipped game assets.

## Remaining boundaries

This establishes original map/read-path and pre-send UI behavior, not complete
live-game validation. Actual scouting, signing/sealing, transaction execution,
landing/combat/capture, and CI are untested here. The preexisting fixture's camp
and other synthetic-world simplifications remain; no live deployment was made.
