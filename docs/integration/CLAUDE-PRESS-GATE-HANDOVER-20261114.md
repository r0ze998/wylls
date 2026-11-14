# Handover: drawer press gate, caret restore, fold-before-focus, troops-form order (round-only patch)

**Revision 2 (supersedes a7a48015…)**: adds the fold-before-focus fix in `keepState` (typing in a folded form lost the focus at the first key; this was already the case on the base) and the revised `troopsOrder`, which keeps the order only while the focus is in the troops card (a reviewer objected to the per-page freeze). It also adds the fixture's `reserve` option (`screens/liveworld.mjs`) and three screen cases.

From branch `claude/nft-pass-mint-20261114`. Base `3e3ba225`, commits `36bf1edf` (holding.mjs troopsOrder) and `07e8fb3f` (app.mjs makePressGate / drawerPress / keepState caret, cards test, screens/press-redraw.screen.mjs). No other commit on this branch touches these four files.

- Patch: `CLAUDE-PRESS-GATE-HANDOVER-20261114.patch` (sha256 `e82480ff9c8d32f5af15057ac917dfb99620e8ae0a34a2d06a581a4def3a3b81`), `git diff 3e3ba225 <this commit>` limited to:
  - `permutation-server/web/frontier/app.mjs`
  - `permutation-server/web/frontier/screens/holding.mjs`
  - `permutation-gateway/test/web-frontier-cards.test.mjs`
  - `permutation-gateway/screens/press-redraw.screen.mjs`
  - `permutation-gateway/screens/liveworld.mjs` (the `reserve` option only)
- File sha256 (first 16): app.mjs `6f009e5cab6d5306`, holding.mjs `89a619373a57bddd`, cards test `e06285c864b7c115`, press-redraw `fc54bf4414adeec7`, liveworld `2e4668a66bab9fd6`. app.mjs alone does not depend on holding.mjs. The screen test's troops cases do depend on it.
- The canonical checkout was not touched by this branch's session. Whether and how this lands there is the canonical integrator's decision; apply it against canonical's own HEAD (it has rounds this branch does not have) and run the cards test and the screen test there.
- Verified: unit tests (cards test 8/8) and the local browser test on the fixture's live world (7/7, LOCAL-WORLD §5h/§5i). With the base holding.mjs, the Train reserve-crossing case fails as expected. **Not verified: a person's press or typing in a real world.** The gate covers the drawer (`#panel-body`) only; the hand pop-ups are not covered by this patch.
