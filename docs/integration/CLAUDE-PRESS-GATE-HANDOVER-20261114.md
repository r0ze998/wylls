# Handover: drawer press gate, caret restore, troops-form order (round-only patch)

From branch `claude/nft-pass-mint-20261114`. Base `3e3ba225`, commits `36bf1edf` (holding.mjs troopsOrder) and `07e8fb3f` (app.mjs makePressGate / drawerPress / keepState caret, cards test, screens/press-redraw.screen.mjs). No other commit on this branch touches these four files.

- Patch: `CLAUDE-PRESS-GATE-HANDOVER-20261114.patch` (sha256 `a7a48015a409b8f76d302790a139e3e72042e94a4bb3eceaedc6693adce17d83`), `git diff 3e3ba225 cea293fd` limited to:
  - `permutation-server/web/frontier/app.mjs`
  - `permutation-server/web/frontier/screens/holding.mjs`
  - `permutation-gateway/test/web-frontier-cards.test.mjs`
  - `permutation-gateway/screens/press-redraw.screen.mjs`
- File sha256 at `cea293fd` (first 16): app.mjs `3b61318ce0068c22`, cards test `3a4021e38a3b3396`, press-redraw `755be66250cd7d18`.
- The canonical checkout was not touched by this branch's session. Whether and how this lands there is the canonical integrator's decision; apply it against canonical's own HEAD (it has rounds this branch does not have) and run the cards test and the screen test there.
- Verified: unit tests (cards test), the local browser test on the fixture's live world (LOCAL-WORLD §5h). **Not verified: a person's press or typing in a real world.** The gate covers the drawer (`#panel-body`) only; the hand pop-ups are not covered by this patch.
