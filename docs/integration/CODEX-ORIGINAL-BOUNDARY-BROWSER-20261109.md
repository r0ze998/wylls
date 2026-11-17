# Original boundary editor: browser follow-up

## What changed

The original `frontier/index.html` now keeps the observed original HOST and adjacent boundary tiles above its route card. Opening the card no longer immediately restores the prior camera position. The card measures after layout, folds proposal internals into Details, and keeps source-invalidation feedback visible. On phones, the six direction buttons share one row and the host's other orders temporarily fold away; closing the card restores them. Phone framing accounts for visible notifications.

The minimap now enumerates only recorded original rings 0..128. The cloud edge is geometry, never an attempted ring129 record lookup. Its static background is cached against an explicit revision token and relevant layout/survey/ownership inputs. The app supplies a stable token while overview envelopes are unchanged, so camera motion redraws the camera frame and pins without repainting all original provinces. Callers without an explicit revision retain uncached behavior.

Camp-v2 observation readback was completed separately through typed logs, the wide index, keeper, herald and the original history sheet. Evidence and its limits are in [CODEX-CAMP-V2-READBACK-20261109.md](CODEX-CAMP-V2-READBACK-20261109.md).

## Browser evidence and its limits

The committed screen runner serves the actual original page and committed WASM from a loopback-only, GET/HEAD-only fixture server. It uses a temporary browser context, no developer wallet, and the existing browser/Node key-operation guards. Normal animations remain enabled. Existing unrelated local services are untouched.

The two new boundary cases construct public account bytes for an original HOST observed at province128,0 tile60. They set a consistent synthetic landed state and synthetic ring seeds, hold later fixture reads while inspecting it, and then reload the unchanged fixture feed. This is explicitly a synthetic observation; no claim is made that a player reached that province, that its terrain is authentic, or that a host actually moved into ring129.

The real canvas, painter, camera, controller and DOM handlers run unchanged. Desktop1440×900 uses mouse clicks; phone390×844 uses touch. The cases check:

- A visible canvas candidate accepts a step into ring129; selected HOST and normal march state remain intact.
- A second step, Undo, Reset and direction buttons operate on the same draft.
- Details can be opened and an arrival proposal entered, while session/executable/admitted remain false.
- Close restores ordinary host controls; reopen starts an empty draft.
- Clock/source changes remove the overlay and show the explanation outside Details; reload removes the synthetic observation.
- No page errors, key operations, stored private/session seeds, session, HTTP writes or outside-origin requests occur.

Local screenshot evidence: `/tmp/wylls-boundary-browser-20261109/desktop-boundary-route.png` and `phone-boundary-route.png`. These are synthetic browser snapshots, not public-gameplay evidence.

The same runner also retains the two existing original-map route, wide-history, wide-village and large-chart cases. The large-chart probe changes only the map source and does not establish real wide account state.

## Selected checks

```sh
node --import ./scripts/ci/no-keys-guard.mjs \
  --test permutation-gateway/screens/codex-route-preview.screen.mjs

node --import ./scripts/ci/no-keys-guard.mjs \
  --import ./permutation-gateway/screens/codex/no-key-node.mjs \
  --test permutation-gateway/test/web-frontier-expedition-map.test.mjs \
  permutation-gateway/test/web-frontier-expedition-compose.test.mjs

node --import ./scripts/ci/no-keys-guard.mjs \
  --import ./permutation-gateway/screens/codex/no-key-node.mjs \
  --test --test-name-pattern='what the HUD covers' \
  permutation-gateway/test/web-frontier-shell.test.mjs
```

The final browser run passed4/4 in61.7s, including both new boundary cases and both existing original-map cases. All four reported empty key-operation and server-write lists and no stored session seeds. The route/composer checks passed31/31; the exact existing HUD coverage check passed1/1. The separate readback/minimap work passed11 selected Rust,8 history and5 minimap tests. These are selected tests, not a whole-repository or CI result. JavaScript syntax checks and `git diff --check` also passed.

## Still incomplete

Original-to-wide departure from this browser, authentic wide movement/combat, reverse sealed movement, generic/public admission and deployable Solana-target integration remain incomplete. The public execution gates remain closed. The native camp lifecycle and readback work do not make the browser route executable. No key generation/derivation, signing, sealing, transaction submission, chain startup, deployment or CI was performed.
