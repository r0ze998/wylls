# Cross-review: the village-identity branch and the G1c/G1b land branch, if both are adopted (2026-11-16, Claude; static, NOT run)

Read-only comparison; no merge, no cherry-pick, no product edit. Branches (both from integration d8dad205):
- `claude/village-card-target-20261116` @ 0845a31c (on `claude/first-session-resume-20261116` @ ef727cf2): controller.mjs
  — imports (`flush`, `subjectOf`), new `adoptHoldings`, `applyMeResult` (two hunks), `cq-outpost`; plus app.mjs,
  hud/guide.mjs, screens/conquestguide.mjs.
- `claude/g1b-land-presence-20261116` @ b5cb3df2 (on `claude/g1c-land-order-20261116` @ f046b20b): controller.mjs —
  `latestEnvelope` only.
Textual overlap: `git merge-tree --write-tree 0845a31c b5cb3df2` → exit 0, no conflict (it writes a tree object only; no
ref, branch or worktree changed). The hunks are in different functions.

## Information sources and where they meet
| datum | source | updated by | identity |
|---|---|---|---|
| the viewer's villages `FS.holdings` | `/h/me` | `adoptHoldings` (applyMeResult, cq-outpost) | village (p, q, site, gen) |
| the open village `FS.activeHolding` | kept by identity | `adoptHoldings`; the UI's selection paths | village |
| the bar's card subject | `FS.selected` tile ∩ `FS.holdings` (+ hosts from `FS.provinces`) | the UI | village / host |
| a province's land `FS.provinces.get(k).land` | `/h/province/{p,q}/latest` | `loadEnvelope` → `latestEnvelope` (G1c / G1b tie rules) | province (p, q, seasonId) |
| the land chip | `landSummary(FS, settled open village, faction)` | every HUD tick | the open village's province |
| `FS.land` | `landState(citizen)` — the join stage | `applyMeResult` | (not the land record: same word, other datum) |

They meet only in the land chip: the open village (village side) picks the province; that province's envelope (land side)
supplies `siteMirror` (village count) and `land` (claimed tiles). Neither branch changes the other's inputs:
`adoptHoldings` never touches `FS.provinces`, and `latestEnvelope` never touches `FS.holdings` / `FS.activeHolding`.

## Compatibility, case by case
- Re-read with a shifted list: the open village kept by identity → the chip reads the same village's province as
  before; that province's land follows its own envelope rule. Consistent.
- The open village gone: position 0 opened, a mismatched card put away, the page drawn synchronously (`flush`) — BEFORE
  `refresh()` loads the envelopes. The chip then reads whatever envelope `FS.provinces` holds for the new open village's
  province (possibly older, or none yet) until the loads finish. Not introduced by either branch; it is Lane C's G1
  (holding newer than envelope) timing — its guard lives on Lane C's branch, not here.
- cq-outpost: `adoptHoldings` (and its flush) run before the envelope loads of that action; `outpostOffer` reads the
  provinces after those loads. Consistent.
- A tie kept by G1c / G1b returns a new object `{ ...next, land: held }`; app.mjs `landRevision` compares by content, so
  an unchanged land does not redraw the board again. Consistent.
- `adoptHoldings`'s put-away rule calls `subjectOf`, which finds a host in hand through `FS.provinces` (envelopes). With an
  envelope older than the hand's host (e.g. a host just formed), the host is not found and the subject falls back to the
  tile's village: the card may be put away though the player held a host. Fail-safe (nothing is ordered), but a
  possible surprise — **unresolved boundary**, recorded.

## Unresolved boundaries (not fixed here)
1. Village count vs holdings generation (Lane C G1): the chip's `siteMirror` comes from the envelope, the holding from
   `/h/me`; for one refresh they can differ. Lane C's guard is not on either branch.
2. The put-away rule's host lookup depends on envelopes (above).
3. One-sided land across a non-tie needs the server contract (`landPreview` / `landSeenThrough` + a herald identity).
4. A page with an unpinned herald (no play-page path found) would compare across seasons in the non-tie loop.

## Unrun checks (to run later, NOT run here — all new test runs are paused; the key-free runner needs its reviews refreshed first)
Node, by file, once allowed:
- [ ] `web-frontier-holdings-reload.test.mjs` (village branch)
- [ ] `web-frontier-hand-chip-village.test.mjs` (village branch)
- [ ] `web-frontier-dissolve-other-village.test.mjs` (its updated handHost pin)
- [ ] `web-frontier-guide-other-village.test.mjs` (the source-only cases since 67c95f02)
- [ ] `web-frontier-land-tie-order.test.mjs` (G1c / G1b)
- [ ] `web-frontier-land-freshness.test.mjs` (builds `latestEnvelope`'s body alone — must stay self-contained)
- [ ] `web-frontier-controller.test.mjs` (its `latestEnvelope` cases)
- [ ] `web-frontier-expedition-inspection.test.mjs`, `web-frontier-expedition-compose.test.mjs` (applyMeResult with a
  host in hand and a generation change)
- [ ] `web-frontier-wide-holding-ui.test.mjs`, `web-frontier-resident-home.test.mjs`, `web-frontier-delegation.test.mjs`,
  `web-frontier-viewer-own-citizen.test.mjs`, `web-frontier-ws07-me-answered.test.mjs` (applyMeResult callers)
- [ ] `web-frontier-first-village-ui.test.mjs` (its updated scout assertion — previously refused via the runner)
- [ ] `node --check` of every changed `.mjs` on each branch, and of the combined tree
Browser (fixture, keyless, only on the owner's word):
- [ ] `screens/first-guide-villages.screen.mjs` (its fixed set-up; the earlier run failed in set-up)
- [ ] `screens/land-redraw.screen.mjs` with the combined tree
Never as a substitute for the two guard-refused tests (`web-frontier-build-walls-items`, `web-frontier-muster-province-full`).
