# KEEP fixture integration and original-page checks

The original map now reads the S1 fixture's actual KEEP placement history.
This closes the missing `/h/keep/4,0.json` fixture answer without replacing
any route-preview work or importing the unverified recorder/browser runners.

## Integrated source

- `59f4a0644186f9360a55291f80390d3d9ca453a3` becomes `c16495d0`: emits
  OpenProvince's KEEP (PLACED) after PROVINCE_OPEN in the synthetic archive.
- `c2acd3a92d8b2be2d86362bfab1c9ce806db7263` becomes `07c00401`: the saved
  router goldens and their Rust/Node assertions. These goldens were not
  regenerated during this continuation.
- Both commits were cherry-picked on `81c632da`, preserving `f764d1fb`'s
  route invalidation and the secure-localhost browser verification.
- Only the two golden JSONs, growth fixture, Rust compare assertions and
  map-contract Node assertions are taken from that candidate. No private
  prize implementation, generated secret, signing test or recorder WIP is
  added.

The payload was compared with `permutation-frontier/src/proc/map.rs` and
`herald/src/conquest.rs`: PLACED, holder, previous holder NONE, troops,
consolidation bell and generation. Event counts grow by the number of keeps
opened. The parsed golden changes stay within events, keep response, Season
head count and Province envelopes.

## Executed checks

The explicitly audited Node subset passes **30/30**:

```sh
node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test \
  permutation-gateway/test/web-frontier-map-contract.test.mjs \
  permutation-gateway/test/web-frontier-growth-route.test.mjs \
  permutation-gateway/test/web-frontier-map-arrival.test.mjs
```

Herald requests are injected golden reads. Called operations are public
PDA/hash, account decoding, map/roster state, committed WASM path/terrain
planning, arrival/pre-seal checks and public beacon hashing. No seal, signer,
worker, real network service or transaction path is invoked. The guard is
supplementary and is not self-tested.

The final combined run of those three files plus the four focused config,
route-preview and controller regressions passes **55/55**.

The original-page runner passes **2/2**, desktop and touch phone:

- The keep inspector opens using the original host hand's information button,
  not a direct call into the renderer. The phone's original sheet handle is
  tapped to reveal its details.
- It shows internal tile 1 as **マス 2**, **100** defenders, **アステル** as
  holder, and its held-since-turn-0 history. The fixture viewer belongs to
  another nation, so this must not be labelled “your nation.”
- Open, read, close and reopen all pass, without composing an order or
  creating a session.
- The original stationary-pointer palisade and same-count movement checks
  still pass. A +350-second Date change stays within turn zero, checked using
  the actual ChainClock as well as the displayed turn. Arrival advances
  without recalculating the route geometry.
- Both viewports still compose and cancel the 1,320-second detour twice and
  reload cleanly. Send is never pressed.
- The final checks on success and failure require a readable single page,
  empty key-use arrays and seed/session storage, no write requests, and no
  outside-fixture requests. Final successful runs report all empty.
- 120 stationary-source samples cause zero extra path plans. Observed source
  time is 0–1 ms on this Mac with coarse browser timing, not a production FPS
  claim.

Local logs and order/keep screenshots are under
`/tmp/wylls-route-preview-20261108/`. See
`CODEX-LOCAL-BROWSER-AUDIT-20261108.md` for the boot, dependency and interaction
boundaries. This run adds only UI-state handlers (`hand-info`, `drawer-close`,
`mountSheet`) and same-turn clock arithmetic to that audit.

## Limits at the original 0d252f0f checkpoint

**At that checkpoint, Rust comparison had not been run on this Mac.** Its runtime fixture → ingest →
fold → loopback router path was reviewed, but a fresh build is needed here.
Herald's development dependencies pull in LiteSVM/Solana and many build
scripts/procedural macros. Their exact feature/host closure and every
compile-time helper are not fully audited. `--offline`, `--locked` or
`--no-run` would not remove that gap. No Cargo build or test was attempted.

The reviewed comparison command, only after that remaining audit, is:

```sh
cd frontier-node
env -u WS19_GOLDEN_WRITE cargo test -p herald --offline --locked --test ws19_map_contract
```

`WS19_GOLDEN_WRITE` must be absent: setting it to `0` still enables rewriting.
Do not regenerate merely to make a comparison pass.

At that checkpoint, the fixture omitted genesis Free City / NEUTRAL records. It uses synthetic
transactions with fixed public byte patterns and NO_BELL records, not a real
executed OpenProvince transaction. This is map/read-path and pre-send UI
verification, not full-game, sealing, transaction, landing or CI completion.

## Follow-up closed on 2026-11-09

The exact offline Rust build closure was subsequently audited, and the original
three map-contract tests passed before any Free City fixture edits. Canonical
Free City mirrors and NEUTRAL records were then added, regenerated through the
real router, reviewed semantically, and compared successfully with writes
unset. See [Free City integration](CODEX-FREE-CITY-INTEGRATION-20261109.md) and
[the Rust source audit](CODEX-RUST-MAP-AUDIT-20261109.md). The real-transaction,
sealing, landing and full-game limits still apply.
