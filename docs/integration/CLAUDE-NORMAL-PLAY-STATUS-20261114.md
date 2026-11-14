# Normal play from the ordinary entry: status, regression plan, open items (2026-11-14)

Goal: two people in one test world, each operating their own page by hand, can go Train → Form a host → choose a fort →
seal → hold → capture (and later retake) on the real screen, with no state-watch timing and no presses aimed at
coordinates measured the instant before. TEST-ONLY local worlds; no rule, resource or send-safety change in any round below.

## Status
| step (ordinary entry, English, 1280 px) | fixture / real browser / real controller | recorded ×30 world (one operator, both sides) | state |
|---|---|---|---|
| Start a new world, choose a nation, first village | — | each by one press | works |
| Start page wording | round 22: "settlement" (a word kept off the play screen) replaced | the old wording was on screen | fixed in source (22) |
| Train (bar → Max → Train) | — | one press each | works |
| Form a host: the bar button | round 21 screen check: one press opens the card while the province is still finishing its turn (fails on round 20) | press 1 opened nothing; press 2 met it refused | fixed in source (21), not yet seen in a world |
| Form a host: the confirm (local play) | round 21: one press sends when ready, or holds ONE send until the province is in step (real-controller test, see below) | confirm 1 sent and refused (NotResident 26); confirm 2 landed | fixed in source (21), not yet seen in a world |
| March on a keep → forts card | rounds 16/19/20 screen checks pass | one press | works |
| Forts row stays put (settling wait comes/goes) | round 16+19 check: row 445 → 445 → 445 | — | fixed (19) |
| Forts row stays put (forming host stands) | round 20 check fails on 19, passes on 20 | 12 px shift seen (before round 20) | fixed in source (20), not yet seen in a world |
| Press on a row survives a card redraw | round 17a check passes | — | fixed (17a) |
| Order card before the first-village welcome | round 18 check passes | seen: the order card came in front | works |
| First-village welcome stays visible | round 21 check: full opacity after a same-view rewrite (0 on round 20) | the panel stood blank under its title once | fixed in source (21) |
| Seal ("Send this order") | — | ONE press; sent at once | works |
| Hold 72 turns → capture, counters and colours | — | capture at turn 105 on both screens; "Provinces held" 5/6 → 6/5; province recoloured; Territory rank 1 | works |
| Host bar fits the screen with the first-village panel open | round 20 check fails on 19, passes on 20 | last button cut off (before round 20) | fixed in source (20) |
| Local play's own messages in English | round 22 test (read-only refusal, sent-but-unconfirmed, checking the outcome, identity changed) | — | fixed in source (22) |
| Retake after the 288 protected turns | — | shown in an earlier ×30 world | works (earlier world) |

## Round 21: what the muster's waiting send is, and what its tests prove
- The bar's Form a host opens its card at any time (reading sends nothing). In an ordinary session the card's confirm is
  refused while the province finishes its turn, as before.
- Local play only: the confirm sends at once when the page sees it ready mid-turn; while only the province is finishing its
  turn (or in the turn's last 1.5 s — this lowers refusals, it does not promise the turn the send lands in) one press holds
  ONE send of the exact muster shown. It is frozen to the local-act scope (wallet, program, Season, relay), the runner's
  world instance, the page's herald, local-play identity and signer handle, the village (coordinates, site, generation),
  unit, troops and tile; checked at every look and again right before the send; sent through the ordinary single send for
  the frozen village; withdrawn (and said) on any change, the card closing, the selected village not being the active one,
  another world, relay or key, a closed gate, an unknown earlier muster, its two-turn limit, the page hidden, or a cancel.
- Proven by tests: the pure intent, guard and identity/village checks; the shared driver with a muster-shaped look; the
  REAL controller in local play through its own actions (arm, cancel, exactly one order for the frozen village, withdrawals
  on troops / village mismatch / relay / runner instance / card close, waiting at the turn's very end, nothing with no
  reserve or no gate); two real-browser checks.
- Not proven: the controller test cannot present a verified local-play identity, so its order is refused by the transport
  before signing — the relay's and the chain's answers are not exercised; an unknown outcome is covered by the ledger's and
  the driver's own tests, not driven through the controller; no world has run round 21 yet.

## Regression plan (short, ordinary operation)
1. Unit: `node --test test/web-lang.test.mjs test/frontier-local-play-*.test.mjs test/web-frontier-*.test.mjs` in
   permutation-gateway (compare the failure list with the base commit's: the same set means nothing new broke).
2. Real browser on the screens fixture, no chain and no key: `node --test screens/conquest-press.screen.mjs` (7 checks:
   rounds 16, 17a, 18, 20 ×2, 21 ×2; person-like presses — down, hold, up — with no retry). Run each new check once
   against the previous code: it must fail there.
3. Only when capacity allows (start ≥ 21 GiB free, unchanged guards, no heavy build): one ×30 contest-pair world from the
   published commit; operate Train → Form a host → fort → seal by looking at the screen and pressing; log every press with
   its delay after the last look; write down every press that did not do what the screen offered.

## Failures that stand at the base commit (classified 2026-11-14, read only)
- Environment, not code: three files need the npm package `@magicblock-labs/ephemeral-rollups-sdk`, which is not installed
  in the checkout used (agent, errors, relay tests).
- Failing source pins (the source changed, the pinned line did not); fix owner not assigned:
  - the conquest wiring line (web-frontier-conquest-wiring): source changed in 25ce9534 (the expedition cards excluded);
  - the map's `keepAt` (web-frontier-keep-board-march): source changed in 18823ad2 (an options argument); the test file was
    edited later (e7ad8d35) and the pin stayed;
  - the home and land records' session guard (web-frontier-resident-home; controller.mjs): source changed in 18823ad2
    (`!localPlay &&` first);
  - the home rings (web-frontier-home-rings), the expedition map's invalidation (web-frontier-expedition-map, 2 tests),
    the film frame (web-frontier-pretake-frame): source change not traced here.
- An uncommitted test in the working tree (never committed): web-frontier-outbound-arrival-pick (the boundary card's
  presses).
- Dictionary and wording gaps in other lanes' code: the expedition preparation section of the bar card (12 texts), one
  wallet text, the expedition return's unmarked Japanese and 精算 wording, the wide map's 鐘, one entry with two different
  English texts, stale English entries.
- In this lane, fixed in round 22: the four local-play controller texts without English, and 精算 on the start page.

## Update 2026-11-15: rounds 23–27 and three live checks

Published commits (one branch, fast-forward): 7880e845 / 84ec838c (round 19), a5e3b403 (round 20), 20adb087 (round 21),
b7d746e9 (round 22), a08a5539 (round 23: two stale source pins in this lane's tests), 984c924a (round 24: the forts card's
invisible stand-in always holds the settling sentence's height), edfc7a9d (round 25: local play's Dissolve says why on the
bar; the slow-clock plan), de118e29 (round 26: the same for March, Return, a march on a keep and Explore), and bb84f089 (round 27:
the local-play reason in full on the bar's line; the bar's March and Return ask the march gate for the host they show).

| live check (TEST-ONLY, one operator playing both sides, English, 1280 px) | clock | seen | not seen / limits |
|---|---|---|---|
| live23, rounds 20–23 | ×30 | one press each for Train, Form a host (card opens while the province resolves), its confirm, the fort row, the seal; host bar wraps; welcome stays visible after the seal; arrival on the keep | the forts row moved 42 px when the host stood while its province was catching up (fixed in round 24, reproduced on the fixture) |
| live24, round 24 | ×30 | the row stayed at one height across settling → in step; Dissolve was offered but refused after the press (fixed in rounds 25/26) | the forming → catching-up transition: the host had stood before the card was open |
| live26, rounds 24–26 | ×10 | the card opened while the host was still forming (the short forming line, round 24's case); watching with screenshots only, the row (y≈300) and the card top (y≈233) did not move through "stands" and "in step" — in live23 the same card started at 276 and grew; Dissolve's reason on the button; one press for row and seal | the middle state — stood while the province is still catching up — was not seen (the province had caught up within the ~10 s between looks): live shows forming → in step only; the full transition is shown on the fixture |

Tests standing at the base commit: 22 failures in the unit suites, all in other lanes' code or environment (see the
classification above); the two stale pins of this lane were fixed in round 23. The screens check suite (9 real-browser
checks) passes; each new check was run against the previous code and failed there.

## Open items
- **The catching-up state, live**: a host that stands while its province is still catching up has been shown on the
  fixture (round 24's check), not yet in a live world. A read-only watcher for the recording desk (position and text of
  named elements, every 0.1–5 s, no input of any kind) is ready and self-tested on the fixture (input events received by
  the page: unchanged during the watch; a single press as a positive control raises the count). It needs a world slot.
- **Local play's other refusals**: round 27 makes the bar's March and Return ask the march gate for the host they show
  (both switch to that host's village before composing). The March-on-a-keep button keeps the page-wide answer, because a
  march on a keep is composed for the page's active village. Remaining known differences: with the march trial closed, a
  map tap may still compose a march whose send is then refused (the bar's March says why; the map does not); and a march on
  a keep for a host of a village other than the active one composes nothing (an older behaviour, nothing is sent).
- **Form a host under the ×30 clock** (recorded world, before round 21): one sent muster was refused with NotResident (26);
  fact and inference as recorded in the round 21 section above. Not measured in natural time.
- The two sides were operated by one operator; two independent people remain the end goal.
