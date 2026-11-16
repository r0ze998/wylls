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
