# Ordinary PC play: move → arrive → land colour/count → production — what is checked where (Claude, 2026-11-16)

PC 1440 first (owner). "Fixture" = the real page on the keyless fixture or a blank page with the real stylesheet; "unit" =
Node; "world" = a real local TEST-ONLY chain (none run since land5). Restricted areas are not in any of these.

| step | checked by (fixture / unit) | seen in a world | gap left |
|---|---|---|---|
| choose, train, form | `first-session.screen.mjs` 2/2 (cards and words, nothing pressed) | live23–34 | — |
| march order | `first-session` (to "Send this order", not sent), `local-march-maptap` 5/5, `march-block-reasons` 16/16 (every reason once, in sight), `conquest-press` 10/10 | live29–34, land4–5 | a send that lands is world-only |
| arrival / away | `web-frontier-away-tag` (unit), ws07 `away-entry` 4, `sendstates` 2, `unread` 3, `reveal` 1, `contracts` 8, `guide-s1` 3 (2026-11-16, each alone) | live32–34 | covered 2026-11-16 by `land-arrival.screen.mjs` B (fixture replay: the village's tag says on the march · turn N, then arrived on turn N, EN/JA); `ws07-away` itself not run (wallet/session words in it) |
| land colour on the map | `web-frontier-land-marks` 7 (painter calls on land4's real records: holder fill/line, take rim + arc, fade rim) | land5 (real page, recorded) | covered 2026-11-16 by `land-arrival.screen.mjs` A (fixture replay: the map's canvases move towards the viewer's colour at the tile; card owner + take count; chip) — a real world shows it only in land5's recording |
| land count | chip unit tests: home line (`landSummary`), far land (`landElsewhere`, c46b6768) | land5 (home line only) | far-land part not yet seen in a world |
| production | `web-frontier-economy-display` 10/10 (strip, harvest, promotion vs Rust tables), chip yield per hour (7e2ecdb9, `landYieldPerHour` = `yield_for`) | — | the credited amount against the stores (land doc item 2) and the chip figure in a world |

Done in this round: the chip's per-hour figure (the strip's rates do not include the land yield, so the chip now says it).
Both fixture gaps above are now covered by `land-arrival.screen.mjs` (4/4, EN/JA @ 1440). What remains is world-only: a send that
lands, the credited land yield against the stores, the far-land part and the per-hour figure seen in a world.

## March / arrival / return: what is left that can be checked without a world (2026-11-16, Claude)
Read from the records (this table, CLAUDE-FIRST-PLAYABLE-STATUS-20261115 "Unverified", CLAUDE-NORMAL-PLAY-STATUS-20261114
"Open items" and round 28) and checked against the candidate's code. No code change.
- Return (村へ戻す): a march like any other with the village as its destination (controller `march-home` → compose →
  setDestination), so its pre-checks are the march's own (`checkMarch`; the 16 block reasons already shown on the
  fixture). The bar's `hand-return` makes the host's own village the active one before `march-home`, so a host of
  another village returns to its own village. No mismatch.
- Round 28's "not covered": local play with the march gate OPEN for a host of another village. The pure part is
  covered: `localMarchOpen` reads the holding only for its ring (≤ 128) — the same answer for any of the viewer's
  villages — and `web-frontier-local-play-march-open` tests it; cq-march asks with the host's own village before the
  switch (round 28 tests and pins). The real controller with the gate open is NOT checked: opening it needs the
  page's memory-only test wallet connected (a key made in memory) and its capability read; key operations are outside
  this round. A keyless check would need a test seam in the controller (injecting the capability) — a production code
  change for testing only, not made without the owner's word.
- Candidate code, unit only: cq-march-other-village, local-play-march-open, away-tag, land-marks, local-march-pending
  30/30; expedition-return, local-play-return, return-card, marches 53/53. NOTE: `web-frontier-local-play-return` is a
  KEY-USING test (scripts/ci/node-key-tests.txt: a memory-only WebCrypto key signs a synthetic message; no network, no
  chain). It was run once here before its header was read; it is also inside the ordinary subset used all day
  (ordinary-suite.sh does not exclude it). Recorded so the owner can decide whether the subset should exclude it.
- Still world-only (unchanged): a send that lands, the credited land yield against the stores, the far-land part and
  the per-hour figure in a world, the catching-up state live, rounds 44–45 in a world, the natural-speed world.

## Round 28's open-gate case, checked (2026-11-16, Claude; owner's approval for in-memory test keys and synthetic signing)
`permutation-gateway/test/web-frontier-local-march-open-other-village.test.mjs` (integration bcc17068, candidate merge
f2c0f2a1): the REAL controller (`startPlay` in local play, then `ACTIONS['cq-march']`) with the march gate OPEN and a host
of the viewer's OTHER village. Result 5/5, run alone from the single export (`node --test <that file>`): the gate's
answer is open for a host of either village; the press switches to the host's own village and the composed order fixes
that village ({5,-1,4,0}, not the active one before); the send-time answer (FS.localMarch) is open; a host in none of
the viewer's villages composes nothing; the send's use of the composed village is pinned as text. No mismatch, no fix.
- Key: ONE Ed25519 key made by WebCrypto `subtle.generateKey`, extractable = false (fephemeral-wallet.mjs), in the test
  process; offered through Wallet Standard events on a plain EventTarget as `window`; destroyed after the tests.
- Signing: NONE. No order was sent (compose only); asserted: the only non-GET request is the capability POST, no
  submit and no act-context request.
- Network: every request went to a `fetch` stub (loopback relay origin http://127.0.0.1:41988; no socket); the
  capability answer is synthetic (TEST-ONLY trial: `trial: true` and the page's `trialEntry: true`; synthetic instance
  `ab`×32).
- Storage: none (Node has no localStorage — asserted; no file written).
- First run 2/5: the test's instance string was not 64 hex (instanceOk), so no capability was read — a fixture error,
  fixed in the test; no product change.
- Not covered: the send itself (sealing, prepare, the signature, the relay's and the chain's answers) and the map tap /
  bar buttons in app.mjs (pinned in round 28, not driven here); no world.
- The file names `subtle.generateKey` in its header, so `scripts/ci/node-keyfree.sh` refuses it (exit 3) rather than
  run it; scripts/ci/node-key-tests.txt was NOT changed (owner's instruction) and needs the owner's regeneration.
