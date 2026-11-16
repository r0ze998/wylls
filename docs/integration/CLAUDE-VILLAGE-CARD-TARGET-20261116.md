# The village a bar card shows vs the village its order acts on (2026-11-16, Claude; static, NOT run)

Branch `claude/village-card-target-20261116`, cut from `claude/first-session-resume-20261116` @ ef727cf2.
All new test runs are paused: nothing here was executed, syntax-checked or imported; `git diff --check` only.

## Responsibilities (read)
- `FS.activeHolding` — the open village. controller.mjs `harvest`, `build`, `train` (`trainOrder`), `muster`
  (`musterOrder`), `garrison` act on `activeHolding(FS)`.
- `FS.selected` (a tile) + `FS.hand.host` → `hud/subject.mjs subjectOf`: the subject — the tile's own village, or a host
  standing there — with its OWN `holdingIndex`. `hud/hand.mjs` draws the subject's village card
  (`villageModel` → `holdingModel({ ...FS, activeHolding: sub.holdingIndex })`).
- Paths that open the subject's village: `selectHost`, `selectVillage`, the plain tap on a village's own tile, the map
  tap's march, 「村へ戻す」, 探索, `cg-go` (first-play branch). `FS.compose` fixes its village when composed; the draft's
  「やめる」 (`compose-close`) cancels a waiting send first.

## Mismatch (read from the code)
`handHost` (`hand-host`: a host chip, the 「村」 chip; and the second tap on a tile, `mapTap`) changed only
`FS.hand.host`. Path: village A open; a host of A selected on village B's tile (`selectHost` opens A); the chip of B's
own host there, then the 「村」 chip (or a second tap) → `handHost(null)`: the subject is village B while A stayed open —
**B's card, its 建設 / 訓練 / 編成 / 収穫 ordered for village A.**

## Fix (UI only; controller unchanged)
`app.mjs handHost`: after the hand changes, the subject's own village is opened (`hand.subjectOf`), as `selectHost`
does. No rule, no safety guard changed.

## Regression (SOURCE ONLY, not run)
- New `permutation-gateway/test/web-frontier-hand-chip-village.test.mjs`: the precondition by `subjectOf` (village B the
  subject with A open), and `handHost`'s switch pinned as text, with the controller's `activeHolding` reads pinned.
- `web-frontier-dissolve-other-village.test.mjs`: its pin "a chip does not switch the village" now pins the switch
  (dissolve's own switch stays for the plain tap on a host's tile, which does not go through `handHost`).

## Not verified
Any run; the screen in a browser; a world with two villages.

## Same family: the village plate and the rail (2026-11-16, static; NOT run)
- `home` (the village plate; pressed again at a village it goes to the next — `map/fmap.mjs home`, read only, sets the
  logical view at once) and `holding-go` (a village of the rail) set `FS.activeHolding` and left `FS.selected` / `FS.hand`
  as they were: with village B's card in the bar, the open village became C — B's card, orders for C.
- Fix (`app.mjs`): `dropOtherVillageCard(i)` after either change — a VILLAGE card of a village other than the new open
  one is put away (`endPick`, hand and selection cleared). A host in hand keeps its own village's card. `goToItem` /
  `cycleHolding` already cleared the hand; the other switches (`selectHost`, `selectVillage`, the plain tap on a village,
  the march / return / explore / `cg-go` presses, `handHost` now) open the subject's own village.
- Regression: pinned as text in `web-frontier-hand-chip-village.test.mjs` — SOURCE ONLY, not run.

## Review: the switches against drafts, waiting sends and orders in flight (2026-11-16, static; NOT run) — no change
- Orders in flight: `act` fixes `v.holding` at the press (train: `activeHolding(FS)` read then; build: `h` read then;
  muster: `musterOrder` takes a frozen village and refuses another — NotOwner); the order record's tile is taken then
  (`orderOf`). `handOrder` closes only the card it was given from; the busy flags are global. A switch during the flight
  cannot redirect the order or misplace its record.
- The march draft and its waiting send: `marchNow` reads the draft's own village (`c.holding`); the driver compares
  `FS.compose === card`. Neither reads `FS.selected` (nor does `hud/marchcard.mjs`). `dropOtherVillageCard` clearing the
  selection while a draft is open removes a highlight only; the draft and its send are unchanged.
- The local muster wait: frozen village; `look` needs the open muster card of that same village. Closing that card
  (`dropOtherVillageCard`, or a host chip) withdraws it as a cancel — 「送信待ちを取り消しました。命令は送られていません。」
  (`why === 'changed' && FS.hand?.pop !== 'muster'`). Before these changes a switch under an open card withdrew it too
  (`HoldingMismatch` → 'problem'); nothing is ever sent for another village; no cancel protection is weakened.
- No proven inconsistency, so no code change. The properties are pinned as text in
  `web-frontier-hand-chip-village.test.mjs` — SOURCE ONLY, not run.
