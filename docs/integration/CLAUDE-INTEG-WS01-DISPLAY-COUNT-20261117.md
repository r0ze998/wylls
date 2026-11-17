# ① display and count: a reviewable integration candidate (manifest, Lane C, 2026-11-17)

**This is a reviewable integration candidate. It is not adopted into the canonical candidate or canonical.**
- Nothing here was merged into `claude/canonical-candidate-20261116`, and nothing was cherry-picked.
- No test, syntax check, import, server, screen or world was run to make this branch.
- It is not "done": the existing board, chain and screen checks below have not been run.

## The branch

| Item | Value |
|---|---|
| Branch | `claude/integ-ws01-display-count-20261117` |
| Base | `claude/canonical-candidate-20261116` at `d16048aa76399124affebeb38f7fc4f447857d00` (the same on origin when this was made) |
| Content | The commits of `claude/lane-c-ws01-fulfil-bounds-20261117` up to `acd6a4120d133a16a1eed36d1d2d50f7ced16bc5`, taken as they are (the candidate is their ancestor: 8 commits, no merge commit, no cherry-pick), plus this manifest |
| Integration | A fast-forward of the candidate. The candidate has no commit on these paths after `d16048aa`, so there is no conflict |
| Scope | Only ①'s display and count work: the request-fulfilment wording, the joint `underBy` count and its wording, and the counted-aggregation helper. It is a different target and purpose from the earlier refused G1, ⑨/⑩ and C/D integrations, and it touches none of their files. It touches nothing of main's (④, ⑫, ⑬, ⑲) or D's (③, ⑤), and no walls, muster, G, runner or world code |

## Commits (oldest first)

| Commit | What |
|---|---|
| `e5f39a3c` | Request fulfilment: a zero upper bound reads "ちょうど 0", never "0 未満" (display only) |
| `71764e61` | `underBy` counts every counted arrival, including those recorded as 0 (④ `QUANTITY-CONTRACT` §3–4). Joint-precision wording. Two existing expectations corrected with reasons. A run record |
| `6e812809` | Joint-precision wording: only an explicit safe-integer 0 is "ちょうど 0"; missing or invalid counts are "精度が分からない" |
| `c38d3f57` | Report: a run record, the `ja` correction, a static audit |
| `d9f1acfc` | `addCounted` (an import-free helper with the same arithmetic) wired into `goal.mjs` `coopView` |
| `41e3382b` | Report: a run record |
| `796f55e2` | Report: a source check of how the board serves the new imports |
| `acd6a412` | Report: the adoption check and plan |
| (this commit) | This manifest |

## The 12 changed paths against `d16048aa` (git blob ids at `acd6a412`)

| Blob | Path | Kind |
|---|---|---|
| `bc5a14996240` | `workstreams/01-national-strategy/coop/coop-ui.mjs` | Screen (browser) |
| `7b671c267c50` | `workstreams/01-national-strategy/coop/fulfil-bounds.mjs` | New. Wording helpers, no imports |
| `ffff208178a8` | `workstreams/01-national-strategy/coop/goal.mjs` | Count (Node, the board) |
| `3db45222fe0c` | `workstreams/01-national-strategy/coop/joint-count.mjs` | New. Count helper, no imports |
| `a6ee88f493f8` | `workstreams/01-national-strategy/test/coop.test.mjs` | Existing test: one expectation corrected |
| `97b1001fe814` | `workstreams/01-national-strategy/test/coop.e2e.test.mjs` | Existing test: one fixture reading corrected; the fixture bytes are unchanged |
| `22e765e0b7f8` | `workstreams/01-national-strategy/test/coop.fulfil-bounds.test.mjs` | New pure test |
| `5d2177818b1a` | `workstreams/01-national-strategy/test/coop.joint-precision.test.mjs` | New pure test |
| `545fdb775d48` | `workstreams/01-national-strategy/test/coop.joint-count.test.mjs` | New pure test |
| `2e1fa3de202f` | `workstreams/01-national-strategy/docs/19-reconcile-04.ja.md` | ① document note |
| `b2cf18255980` | `workstreams/01-national-strategy/docs/22-ws04-current-e2e-ws15-fold.ja.md` | ① document note |
| `c6ceeb54e523` | `docs/integration/CLAUDE-LANE-C-WS01-FULFIL-BOUNDS-20261117.md` | The working report: details, audits, run records |

## The real consumers (read from the source; not run)

- **The ① request page** (`coop/index.html` → `coop-ui.mjs` → `fulfil-bounds.mjs`):
  - the request-fulfilment line (`fulfilBoundsText`);
  - the joint-precision line (`jointPrecisionText`).
- **The board process** (`coop/board.mjs` → `goal.mjs` `coopView` → `joint-count.mjs` `addCounted`):
  - feeds `/coop/view`: `joint[].progress` `verified` and `underBy`;
  - the verdict reads `perResource` and is unchanged.
- **Export to ⑮:** `test/scenario-e2e.mjs` `ws15Export` copies `joint[].progress` (with `underBy`) into the ⑮ export. No ⑮ source reads `underBy`.
- **Other importers of `board.mjs` (main's or `web-frontier`; read only):**
  - `permutation-gateway/screens/ws07-s1-pure.screen.mjs`;
  - `permutation-gateway/test/web-frontier-ws07-coop.test.mjs`.
- **Serving:** both new imports resolve. The browser fetches `fulfil-bounds.mjs` through `board.mjs` `serveStatic` under `/ws01/repo/` inside the served `coop` directory. Node loads `joint-count.mjs` from disk.

## What has run (each once, by the coordinator; nothing else)

| Test | Result | Covers |
|---|---|---|
| `test/coop.fulfil-bounds.test.mjs` at `e5f39a3c` | 5/5 pass, exit 0, Node 23.11.0 | `fulfilBoundsText` wording only. The module has changed since, but not that function |
| `test/coop.joint-precision.test.mjs` at `6e812809` | 8/8 pass, exit 0, Node 23.11.0 | `jointPrecisionText` wording only |
| `test/coop.joint-count.test.mjs` at `d9f1acfc` | 5/5 pass, exit 0, Node 23.11.0 | `addCounted` arithmetic only |

## Not run; needed before adoption

1. **`test/coop.test.mjs` and `test/coop.e2e.test.mjs`**, with their corrected expectations: stone `underBy` 0 → 2, and the fixture's wood `underBy` 4 → 5 applied in the test.
   - They start local HTTP servers, use a fixed signer, a fake chain and temporary files, and are on `scripts/ci/node-key-tests.txt`.
   - These are the only checks that `coopView` calls `addCounted` inside the right guards (duplicates skipped, `counted: null` not counted).
   - Run them only after the coordinator's own audit, as the ordinary ① subset.
2. **The screen:** the ① page and the board, or `test/coop.browser.nokey.mjs` after audit. Neither has been loaded or run.
3. **The `permutation-gateway` importers of `board.mjs`** listed above: their owners re-verify them.
4. **No real world** has been run.

## Decisions for others

- **① (owner):** whether to accept the new meaning of `underBy` (arrivals recorded as 0 are counted). It changes the screen and the ⑮ export, so the fixture's wood value reads 5 instead of 4. ① also decides whether to keep the fixture as history, with the stated correction in the test, or to regenerate it (`test/make-ws15-fixture.mjs`, a run).
- **The integrator (one integrator):** what to adopt:
  - **the display piece:** `e5f39a3c` alone, which changes no existing expectation;
  - **the count piece:** `71764e61`, `6e812809` and `d9f1acfc` together;
  - **or the whole branch.**
  
  Lane C does not write the candidate or canonical.
