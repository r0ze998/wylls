# adoptHoldings and a host in hand: the cross-review's boundary retracted (2026-11-16, Claude; static, NOT run)

Branch `claude/host-card-adopt-20261116`, cut from `claude/village-card-target-20261116` @ 0845a31c. The G1b / G1c branch
and Lanes C / D are untouched. Comparisons by `git diff` / `git show` only (no `merge-tree`). Nothing was run.

## The question (cross-review 4e09c05e, boundary 2)
`adoptHoldings` puts away a VILLAGE card of a village other than the open one, deciding through `hud/subject.mjs
subjectOf`, which finds a held host (`FS.hand.host`) among `ownHostsAt` — the envelopes in `FS.provinces`. Could an
envelope that has not yet "arrived" make a valid held host fall back to the tile's village and close its card?

## Evidence (source)
- Every writer of `FS.hand.host` (app.mjs): `handHost(id)` (a chip / the same-tile cycle — ids from `ownHostsAt`),
  `selectHost(row)` (rows of `hand.ownHosts`; on this branch also `cg-go`'s lookup in each village), `selectVillage`
  (null), `goToItem`'s item host (attention items built on `hostRows`). All come from rows built on `FS.provinces`.
- `adoptHoldings` never writes `FS.provinces`; in `refresh()` it runs (via `applyMeResult`, line ~1347) before the
  envelope loads (line ~1350); in `cq-outpost` before that action's loads.
- `ownHostsAt` iterates `FS.holdings` and keeps a host by `hostsIn` → `hostOfHolding` (the village's identity, gen
  included), states 1–2 on that tile.
So at the adoption the held host is in the very envelope it was chosen from, or a newer one already loaded. It is lost
to `subjectOf` only when (a) a newer envelope no longer has it on that tile — moved, dissolved, in transit — and the bar
shows the same with no adoption at all; or (b) its village is no longer held — lost, another generation, another
viewer — where dropping the card is right, and another viewer's host can never be kept (its id cannot match the new
viewer's villages). **No reachable case closes a valid host card: the boundary is retracted. No code change.**

## Regression (SOURCE ONLY, not run)
`permutation-gateway/test/web-frontier-adopt-host-card.test.mjs`: a reordered list keeps the host card (new position);
a lost village, another generation, a moved / in-transit host fall back to the tile's village; the sources pinned —
`adoptHoldings` does not touch `FS.provinces` and runs before the loads, the four `FS.hand.host` writers, `ownHostsAt`'s
lookup through the holdings.

## Still unrun (unchanged checklist)
The checklist in `CLAUDE-VILLAGE-LAND-CROSS-REVIEW-20261116.md` (on `claude/g1b-land-presence-20261116`) stays unrun,
with this file added: `web-frontier-adopt-host-card.test.mjs`.
