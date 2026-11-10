# Original boundary route: captured terrain and timing

The original `frontier/index.html` boundary card now reads the exact Province
captures needed by its selected route. “地形・時間を確認” calls the bounded
Herald route endpoint, validates its scope and public addresses, and computes
recorded passage, travel seconds, tower wear and an arrival-turn window.
There is no page scan, generated-terrain fallback or new send action.

The requested route remains at most 32 steps and four entered provinces.
Coordinates remain canonical decimal strings, including values beyond 2^53.
The client checks request order/count, program/season/world identity, canonical
PDA/with-seed public addresses, capture slot/archive bounds, exact byte lengths
and canonical base64. Responses are capped at 64 KiB; the composer times out
after 12 seconds. Missing and closed captures stay unavailable. Unsupported
wide structures/forts are refused, including live forts with zero troops.

The calculation follows the existing Rust route rules: passability, rough
terrain, roads, mounted units, faction doctrine, Season stances, original
Holding expulsion, tower wear and palisades. Timing uses the observed chain
clock plus the existing departure margin, ceiling arrival, two-turn minimum,
72-turn maximum and the strict Season end bound. A missing or nonnumeric clock
cannot become timestamp zero. The source faction comes from the actual
standing entry, not the HUD's abbreviated host row.

Edits, closing, source/owner/clock/Season changes and repeated requests discard
old responses. A source invalidation during a pending read also requests a
render, so a loading message cannot remain after the draft has been cleared.
The result retains `observationOnly: true`, `coherentSnapshotVerified: false`,
`provenanceVerified: false`, `executable: false` and all existing closed gates.
Captured accounts may come from different transactions; the observation does
not prove live ownership, current terrain, coherent time or successful travel.

The card's desktop height cap now overrides the more specific ordinary-host
CSS rule. Results stay in a scrollable card capped at 300px on desktop and
260px on phones, leaving the original canvas available for the next step.

## Browser evidence

The existing screen runner serves the real original page, controller, painter
and committed WASM from its own loopback GET/HEAD-only fixture server. It uses
temporary Chromium contexts, `devWallet=off`, browser/Node key-operation guards
and a blocked sealing worker. Existing services are not stopped or replaced.

The two boundary cases still construct an explicitly synthetic original HOST
observation at province128,0 tile60 and hold normal later fixture reads. The
new route request goes through the real client/HTTP/parser/controller path;
its response contains a copied public wide Province fixture rebound to this
synthetic page's public scope. The immutable fixture files are unchanged.
This tests the browser workflow, not a player reaching the boundary or an
authenticated historical departure.

Both desktop1440x900 mouse and phone390x844 touch cases verify:

- Canvas steps enter ring129 without changing the selected host or normal
  march state; Undo, Reset and direction controls still work.
- The real read button displays a recorded 120-second route and turn2..72
  window. A missing arrival proposal is explained; an entered turn2 passes
  only the observation calculation.
- Changing the path removes the old result. An unknown capture displays the
  missing-land explanation and does not fabricate a traversable route.
- The card stays within its height cap and another canvas step remains
  accessible after results appear.
- Close/reopen, source/clock invalidation and reload discard the old draft.
- No page errors, key operations, private/session seeds, session, HTTP writes
  or external-origin requests occur.

Screenshots were visually inspected at
`/tmp/wylls-boundary-browser-20261110/desktop-boundary-route.png` and
`/tmp/wylls-boundary-browser-20261110/phone-boundary-route.png`. They show
synthetic observations, not live gameplay.

## Selected verification

```sh
node --import ./scripts/ci/no-keys-guard.mjs \
  --import ./permutation-gateway/screens/codex/no-key-node.mjs \
  --test permutation-gateway/test/web-frontier-expedition-map.test.mjs \
  permutation-gateway/test/web-frontier-expedition-compose.test.mjs \
  permutation-gateway/test/web-frontier-expedition-route.test.mjs \
  permutation-gateway/test/web-frontier-expedition-route-read.test.mjs

node --import ./scripts/ci/no-keys-guard.mjs \
  --test permutation-gateway/screens/codex-route-preview.screen.mjs
```

Final results: 52/52 selected Node tests and 4/4 browser cases (60.4 seconds).
The latter includes the two existing ordinary-map/history/wide-inventory
cases. All four browser cases reported empty key-operation/server-write
lists and no stored session seeds. The screen runner uses the previously
audited installed Playwright1.58.2 and local Chromium; no package install was
performed. The temporary dependency symlink is excluded from the commit.

The same development increment includes seven exact Herald tests, documented
in [the endpoint record](CODEX-OUTBOUND-ROUTE-CAPTURES-20261110.md), and twelve
distinct ABI/fclient/native test functions across
[camp bytes](CODEX-CAMP-V2-WIRE-RUNTIME-20261110.md) and
[conquest bytes](CODEX-CONQUEST-WIRE-RUNTIME-20261110.md). Two native functions
were repeated after conquest integration; they are counted once. Total:
75 distinct selected checks, not a full suite or CI result.

## Remaining execution blockers

The browser still cannot submit an original-to-wide departure. Source/terrain
and clock observations are not a verified execution context; sealing,
signing and transaction submission remain disconnected. The public lifecycle
gates remain false, and `permutation-frontier/src/lib.rs` deliberately rejects
the wide feature for the Solana target. No deployable target or VM resource
budget has been established.

Native return currently means the implemented voluntary Dissolve, Resolve
Leave and reserve-return path. Reverse sealed travel, original-destination
arrival and mixed Gather contracts remain incomplete. The successful native
camp/capture paths use synthetic initial accounts and existing public proof
fixtures, not a live wallet or chain. No key creation/private derivation,
signing, sealing, chain startup, deployment or CI was performed.
