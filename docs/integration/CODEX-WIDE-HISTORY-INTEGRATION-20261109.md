# Wide history and verifier integration — 2026-11-09

Base: `590dcd23f81ccc557d0e7309867fa51048f591bc`.

## Shipped scope

The existing original-game recorded-world view rejected every history page
containing the already implemented wide economy event kinds 15/16. The browser
reader now accepts their canonical holding-only identities and fixed receipts:
Harvest, all nine Build items, and all seven Train units. It verifies exact
record width, action padding/ranges, receipt version/boolean, and the kind's
ordered entity links. Province coordinates, signed timestamps and unsigned
link sequences remain exact. The page shows the existing Japanese/English
action names and the historical holding site/generation.

These rows have `host: null`. They cannot open a host action review or gain a
send control. Existing world/season/snapshot/pagination checks remain. The UI
continues to say that source coverage and account agreement are unverified,
and that history does not establish land or a playable state.

Whole-page testing also found and fixed three existing presentation defects:

- The ordinary desktop drawer covered the recorded-world Close control.
- Pale history text was rendered over a pale sheet. The sheet now uses its
  documented opaque dark-metal surface, with matching readable controls.
- A phone's percentage-height history pane was nearly collapsed. Explicit
  bounded grid rows now retain a usable independently scrolling history area.

The independent wide-chain verifier now removes failed CPI subtrees before
decoding their records, including successful descendants rolled back with a
failed parent. Final account chains are matched using complete world-scoped
canonical identities, not a coordinate-based display label. Malformed frame
checks apply to retained target-program PSW1 observations; foreign, legacy-only,
empty and known rolled-back records do not become wide findings by themselves.

## Verification

- New focused economy-history suite: **9/9 passed**. Five immutable existing
  host-dispatch exports are read unchanged: harvest, building, wall, tier and
  train. Every byte truncation, trailing bytes, retired/unknown versions,
  invalid links/actions/identities, phantom hosts, exact extreme integers,
  all action labels, both languages and malformed-page recovery are covered.
- Existing wide-world suite: **24/24 passed**, including host-history and
  unsigned review regression. No signer or seal is invoked.
- The previously audited original-map focused regression files: **99/99
  passed**, including route, Free City, overview queue and chart checks.
- Original complete player/spectator page, desktop 1440×900 and touch phone
  390×844: **2/2 passed**. The real recorded-world button/client/sheet exercises
  20+5 history pagination, close/reopen, aborted old response, malformed new
  response and recovery. It asserts no host controls, unchanged six-ring
  canonical world, readable colors, an uncovered Close control and a usable
  scroll area. Screenshots were visually reviewed.
- The browser run also repeats prior route/KEEP/Free City and synthetic R128
  chart checks. Observed chart redraw medians were 124 ms desktop and 123 ms
  phone, with no province or terrain callbacks. These are local measurements,
  not a production frame-rate guarantee.
- Selected Rust verifier tests are documented separately in
  `CODEX-WIDE-VERIFY-AUDIT-20261109.md`, including build/runtime audit and result.

The first browser attempt exposed the layout/contrast defects above. After
the scoped CSS fix, both original-page tests pass without hiding the drawer,
forcing a click or relaxing the test timeout.

## Audit and fixture boundaries

Every executed path was statically reviewed first. The new Node suite's 45
local-module closure executes only fixed fixture reads, public PDA/hash
arithmetic, codecs, fake GET responses, fake DOM, existing translations and
bounded UI timers. Inert key-related exports are not called. The builtin
Node guard and existing page guard only install refusals; no guard self-test
is run. Prior map tests were re-reviewed for the pure parser/display delta.
Static review hashes were updated; the scanner reads files and never runs the
tests it classifies.

The browser extension preserves the secure loopback and installed Playwright
1.58.2 boundary from `CODEX-LOCAL-BROWSER-AUDIT-20261108.md`. It introduces only
fixed file reads, public world hashing, copied bytes, GET-only fixture replies,
UI interactions and computed-style/hit-test reads. No build, fixture exporter,
new dependency, private-key operation, signer, real transaction or CI runs.
Final Node/browser key counts, session/dev-key storage, server/browser writes,
outside-origin app requests and page exceptions are zero.

The browser's history envelopes are explicitly **synthetic presentation data**:
copies of the five receipt bodies are rebound to the original page fixture's
public world namespace, and repeated to exercise pagination. Their chain heads
are not recomputed or claimed valid. The manifest reports zero captured
provinces. The unchanged binary-vector Node tests, not this presentation
fixture, establish compatibility with canonical host-dispatch output. No
binary fixture is modified or regenerated.

## Exact remaining limits

This is read-only original-game integration, not radius >128 gameplay or a
true infinite map. Legacy radius/packed-ID constraints, experimental SBF
exclusion, debit and automatic-send gates, and mixed legacy/wide policy remain
unchanged. Wide read coordinates remain bounded to ±2^62 and recorded-world
walks retain their existing page cap. The verifier still reports
`WideUnmodelled`; this is not complete season replay or authentication. No
gameplay rule, migration decision, private NFT prize code or production gate
was changed.

Local artifacts: `/tmp/wylls-route-preview-20261108/` contains
`wide-economy-browser.log`, its pre-layout failure log,
`wide-economy-regression-node.log`, and desktop/phone wide-economy screenshots.

Focused repeat commands, after re-reviewing changed source/dependencies:

```sh
node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test \
  permutation-gateway/test/web-frontier-wide-economy-history.test.mjs \
  permutation-gateway/test/web-frontier-wide-world.test.mjs
node --test permutation-gateway/screens/codex-route-preview.screen.mjs
node scripts/ci/scan-node-key-tests.mjs --check
```
