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

## The map tap and the host bar for a host of another village (2026-11-16, Claude)
Static trace of the entries a player presses (app.mjs, hud/hand.mjs, controller.mjs), each for a host of the viewer's
OTHER village:
- Map tap → march (`mapTap` → `orderMarch`): switches to the actor's own village (`A.actor.holdingIndex`) before
  `ACTIONS.compose`; the order fixes that village. Correct.
- 「村へ戻す」 (`hand-return`): switches to `sub.holdingIndex` before `march-home`; the return's destination is that
  village's tile. Correct.
- 探索 (`setPop('explore')`), 砦へ進軍 (`cq-march`, round 28), 次の軍勢 / `selectHost`: switch first. Correct.
- 解散 (`hand-pop` → `dissolve`): **mismatch, fixed.** A plain tap on the host's tile (the selection switches only on a
  village's own tile) or its chip on a tile shared with the open village (`hand-host` → `handHost`, no switch) leaves
  the open village as it was. The bar offered 解散 (`dissolveCheck` reads the host's own village), but
  `controller.mjs dissolve` built the order from the OPEN village (`activeHolding`, `hostRow`), which the program
  refuses (`host.rs dissolve_as` → `resident_host`). The same after a march draft was put away with the village left
  switched (a stale village). Fix (integration 98ea5c52, candidate merge 9dd64905): `dissolve` first switches to the
  host's own village (`holdingIndexOfHost`), as the other entries do. No rule changed, no test-only hook.
- Test `permutation-gateway/test/web-frontier-dissolve-other-village.test.mjs`, run alone from the single export:
  6/6 with the fix; 2/6 on the unchanged controller (plain tap, chip and a repeated choice, put-away draft, source pin
  fail). It drives the bar's model (`handModel`) and the real controller action; the app.mjs handlers are pinned as text
  (app.mjs is the DOM module). KEY-FREE: no key made, nothing signed or sent (no pin: the order stops at NoPin before
  anything is built); `fetch` stubbed and never called (asserted); nothing stored. Its import closure is that of the
  keyless `web-frontier-cq-march-other-village` test plus itself. `node-keyfree.sh` was not used (it refuses on the
  stale reviews; not changed).
- Not covered: the press in a browser, the order landing on a chain, a world. Display only, not fixed: 次の軍勢's
  figure counts the open village's hosts, so it reads 1/N for a host of the other village.

## 次の軍勢 for a host of another village (2026-11-16, Claude; follows the section above)
- Mismatch (the display item left above, checked against the press): with a host of the viewer's OTHER village in hand
  (plain tap or chip; the open village unchanged), the bar's figure counted the OPEN village's hosts — 1/N, the host
  in hand not among them — and with fewer than two hosts there the button was refused as 「ほかに軍勢はいません」.
  The press (app.mjs `nextHost`, also the keyboard's `cycleHost`) jumped to the open village's first host.
- Fix (integration aded7996, candidate merge d9986330): `hud/hand.mjs hostModel` and `app.mjs nextHost` use the hosts of
  the subject's own village (`ownHosts({ ...FS, activeHolding: sub.holdingIndex })`); `selectHost` then switches to it as
  before. A host of the open village, or the village in hand: unchanged.
- Test `permutation-gateway/test/web-frontier-next-host-other-village.test.mjs`, alone from the single export: 6/6 with
  the fix; 3/6 on the unchanged code (figure, refused button, source pin). The repeated-press test applies the press as
  written in app.mjs, so on the old code the press itself is caught by the source pin only. KEY-FREE: no key made, no
  signing, `fetch` stub unused (asserted), nothing stored. Import closure within the keyless cq-march test's.
- The existing `web-frontier-hand` case for 「ほかに軍勢はいません」 has one village (subject village = open village):
  unaffected by reading; not run.
- Next looked at: the bar's other paths for such a host (local-play answer, 砦へ進軍 list, 探索, expedition / outbound
  read-only checks) read the host's own village; `cg-go` lists the open village's hosts on both sides. No further clear
  mismatch found in this family.

## The land chip's per-hour figure after a building or promotion is done (2026-11-16, Claude)
- Mismatch: ClaimLandYield credits `yield_for(production, bonus, bells)` with the village's production AFTER
  `settle_tiered(now)` (`permutation-frontier/src/proc/land.rs`); the strip reads the village the same way
  (app.mjs `settledHolding` → hud/rulebook.mjs `settled`), but the land chip (`landSummary` → `landYieldPerHour`) read the
  stored record, so its 「毎時 +N」 lagged from a building's or promotion's completion until an instruction landed on
  the village.
- Fix (integration e87faba3, candidate merge 372f778b): the chip call in app.mjs passes `settledHolding(lh, now)`;
  land.mjs only gains a doc line. No rule, formula or new path; map/minimap not touched.
- Test `permutation-gateway/test/web-frontier-land-chip-settled.test.mjs`, alone from the single export: 5/5 with the
  fix; 4/5 on the unchanged page (the app.mjs call is pinned as text, app.mjs being the DOM module; tests 2–3 show the
  stored record's figure 20 short after a +200 Food building, and the Hamlet figure after a promotion). KEY-FREE: no key
  made, no signing, no request, nothing stored; synthetic records. Its import closure reaches the vendored curve
  library (names only; not called).
- Lane C E1 (S1 promotion ore in the strip) is separate and already in (41fb12a8); `settled` includes it.
- Not covered: the chip in a world; how soon the crank's ClaimLandYield refreshes the record (not measured).

## Minimap camera frame, integrated from the parallel owner (2026-11-16, Claude)
- `codex/minimap-frame-20261116` @ 0a58fa44 (parent: integration 3f3372b8): `hud/minimap.mjs` draws the camera frame
  only where it meets the minimap (a camera beyond the map gave a negative width/height, which the canvas reverses into
  a false frame); `web-frontier-minimap-cache.test.mjs` gains the wholly-outside and partial-edge cases.
- Checked here: diff read; no file shared with the integration commits since 3f3372b8 (land chip fix, ledger);
  `git diff --check` and `node --check` pass; that test alone from the single export on the commit's files: 6/6.
  No key, signing, request or storage in the test.
- Integration merge 84469802, candidate merge fccaf09e; the land chip fix (e87faba3) is still in.

## Scout muster wording (Sakurai review), integrated from the parallel owner (2026-11-16, Claude)
- `codex/sakurai-scout-wait-20261116` @ fc6e8b68 (parent: integration 3f3372b8): the scout guide's muster line no longer
  says 「約11〜21分」; it says the scouts stand once the turn ends, its seals are opened and it is resolved, and that
  the village can keep building meanwhile (`screens/onboarding.mjs renderScoutAction`, EN in `lang/en-frontier-play.mjs`,
  the owner's doc, and new asserts in `web-frontier-first-village-ui.test.mjs`). No game logic changed.
- Checked here, statically only: diff read; no file shared with the integration commits since 3f3372b8; `git diff
  --check` and `node --check` (3 code/test files) pass; the new English has no word of the play screen's banned list.
- **Dynamically NOT verified**: `web-frontier-first-village-ui.test.mjs` was not run (the owner's run was refused by the
  key-free runner's stale reviews; not retried, not bypassed, runner unchanged). Other 「約11〜21分」 lines remain for
  the village application (join), a separate context not in this change.
- Integration merge 5877d468, candidate merge a0b3cf99; the dissolve, 次の軍勢, land chip and minimap fixes are still in.

## The forming scout card and the shared phase-aware line (2026-11-16, Claude; the follow-up named in CODEX-SAKURAI-SCOUT-WAIT)
- Mismatch: `screens/onboarding.mjs renderScoutAction`, scouts forming, counted down to `ticketTimes(...).resultAbout`
  (the village ticket's one estimated total wait). After the muster turn ended, with the key or the draw later than
  that, the countdown ran out while the scouts still waited. The first-session review's shared rule
  (`hud/firststeps.mjs`) shows a countdown only where the turn's pipeline names a time, and the conquest guide says a
  forming host's phase with `formingLine`.
- Fix (integration c7533214, candidate merge d5800fca): the scout card uses the same `formingLine`; its status line and
  its "explore from here" line stay. No new words (every JA string has its EN entry), no rule or timer. Static trace:
  turn running → the turn's end; key awaited → no time; seals opened → their deadline; draw awaited → its scheduled
  time; resolved → stands on the map once the record is read, then the explore button. The line is redrawn when the
  panel is (turn change, refresh), as in the conquest guide.
- `web-frontier-first-village-ui.test.mjs`: the estimate assertion now expects the phase line and no deadline.
  **Not run** (key-free runner refusal not bypassed). Checked: node --check, git diff --check, the source trace.
- EN entries 「反映の目安まで（ゲーム内）」 / 「編成の反映の目安まで {0}」 left in place (no deletion).
