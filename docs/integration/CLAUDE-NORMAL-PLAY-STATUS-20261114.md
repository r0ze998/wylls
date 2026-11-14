# Normal play from the ordinary entry: status, regression plan, open items (2026-11-14)

Goal: two people in one test world, each operating their own page by hand, can go Train → Form a host → choose a fort →
seal → hold → capture (and later retake) on the real screen, with no state-watch timing and no presses aimed at
coordinates measured the instant before. TEST-ONLY local worlds; no rule, resource or send-safety change in any round below.

## Status
| step (ordinary entry, English, 1280 px) | fixture / real browser | recorded ×30 world (one operator, both sides) | state |
|---|---|---|---|
| Start a new world, choose a nation, first village | — | each by one press | works |
| Train (bar → Max → Train) | — | one press each | works |
| Form a host (muster) | — | bar press 1 opened nothing; bar press 2 met it disabled; guide opened the card; confirm 1 sent and refused (NotResident 26); confirm 2 landed | **open: weak under ×30** |
| March on a keep → forts card | round 16/19/20 screen checks pass | one press | works |
| Forts row stays put (settling wait comes/goes) | round 16+19 check: row 445 → 445 → 445 | — | fixed (19) |
| Forts row stays put (forming host stands) | round 20 check fails on 19, passes on 20 | 12 px shift seen (before round 20) | fixed in source (20), not yet seen in a world |
| Press on a row survives a card redraw | round 17a check passes | — | fixed (17a) |
| Order card before the first-village welcome | round 18 check passes | seen: the order card came in front | works |
| Seal ("Send this order") | — | ONE press; sent at once | works |
| Hold 72 turns → capture, counters and colours | — | capture at turn 105 on both screens; "Provinces held" 5/6 → 6/5; province recoloured; Territory rank 1 | works |
| Host bar fits the screen with the first-village panel open | round 20 check fails on 19, passes on 20 | last button cut off (before round 20) | fixed in source (20) |
| Retake after the 288 protected turns | — | shown in an earlier ×30 world | works (earlier world) |

## Regression plan (short, ordinary operation)
1. Unit: `node --test test/web-frontier-*.test.mjs` in permutation-gateway (compare the failure list with the base
   commit's: the same set means nothing new broke).
2. Real browser on the screens fixture, no chain and no key: `node --test screens/conquest-press.screen.mjs` (5 checks:
   rounds 16, 17a, 18 and the two round-20 checks; person-like presses — down, hold, up — with no retry). Run each new
   check once against the previous code: it must fail there.
3. Only after the NFT lane's world is down and capacity is agreed (start ≥ 21 GiB free, unchanged guards, no heavy build):
   one ×30 contest-pair world from the published commit, recorded from each page; operate Train → Form a host → fort →
   seal by looking at the screen and pressing; log every press with its delay after the last look; write down every
   press that did not do what the screen offered.

## Open items
- **Form a host under the ×30 clock**: the confirm was disabled about half of each 20 s turn ("province still
  resolving"), and one sent muster was refused by the program with NotResident (26).
  - Fact: Muster returns 26 only when the province's resolved turn is two or more behind the chain's turn; the province
    is moved on only by the test keeper's FastForward transactions, and the refused muster landed between two of them
    (8 slots after one, 16 before the next).
  - Inference, not measured: the page judged "ready" from a view one step behind the chain.
  - Not measured in a natural-time world; the share is a ×30 condition and must not be assumed there.
  - Candidate (separate round, layout/flow only): open the card always (read only, as the guide already does) and hold
    a person's confirm until the province is in step, then send it once — the same pattern as the march's waiting send;
    the program's own check stays the gate.
- The bar's first "Form a host" press opened nothing (near a turn change); not reproduced on the fixture yet.
- The first-village panel showed empty for a moment behind the "sealed" notice.
- Round 20 not yet seen in a world (needs the next recorded world).
- The two sides were operated by one operator; two independent people remain the end goal.
