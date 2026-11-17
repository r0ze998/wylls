# Village orders (build, train): an answer stays with its viewer and world, and an unknown outcome is not "refused" (2026-11-17)

**Branch:** `claude/ws07-order-scope-20261117`, on the aggregate `claude/aggregate-approved-20261117` at `837af08b`. The aggregate ref is Lane D's and is not changed.

**Static change, NOT run:**
- no test;
- no import of the app;
- no CLI, send, signature, wallet, RPC or world.
- A static comparison of the controller's existing regex pins was made (old text vs new text, below). That is not a test run.

## The path traced

**Village selection and the drawer:**
- `screens/holding.mjs` `buildCards`, `trainingQuote`;
- the hand: `hud/hand.mjs` `trainDraft`/`trainPop`, the build offers of `hud/rulebook.mjs` `buildOffers`.

**Their numbers equal the program's** (checked in the previous round):
- `catalog.rs` `train()`;
- `arms::train_v3`;
- `duplicate_cost` with `MAX_DUPLICATES` (shown as `AboveCap`);
- `Tier::{queue_slots, storage_cap}`.

**The click to the redraw** (`controller.mjs`):
- `ACTIONS.build` / `ACTIONS.train` → `orderOf` (the order record: kind, village tile, turn) → `act` (double-send guard `sendKey`, or local play's scoped ledger) → `actOnce` → `tx.submit` → `tx.track` (`fplay.mjs`: `landed` / `failed` / `expired` / `unknown` / `unqueryable`);
- then the notice (`done` / `failed`), the order record (`orderAnswered` → `FS.orders`, `order:*`), the effects bus (`action:*`), `refresh()` at once for an order, and `refreshSoon()`;
- then `refresh` reads the Holding again: stores, queue and reserve. `refresh` already drops replies for another viewer or world (`currentViewer`: wallet, `providerWorld()`).

## What was wrong (ordinary path; local play already handled both)

1. **A late answer reached another viewer or world.**
   - **The gap:** `actOnce` waits for `tx.track` (up to its polls). If the wallet, the NFT viewer or the pinned world changed meanwhile, the landing still showed "done", recorded the order (with the **old** village's tile) into the **new** viewer's `FS.orders` (turn list, hand counter), emitted `order:accepted`, and ran `after`.
   - **What was already scoped:** `resetViewer` empties `FS.orders` and the notice. Local play checks its scope (`stillScope`).
   - **The fix:** the ordinary path did not, and now does.
2. **An unknown outcome was recorded as refused.**
   - **The gap:** a sent transaction whose status is `unknown` or `unqueryable` went to `failed(t)`, and the `finally` block wrote the order as `state: 'refused'` (`sent: true`).
   - **Why it matters:** it may still land, and a player who believes the turn list presses again: a second build or train.
   - **The fix:** local play records "sent, not confirmed" with the signature (`orderUnconfirmed`); the ordinary path now does the same.

## The fix (one product path: `permutation-server/web/frontier/controller.mjs`)

- **`orderScope()`** = the viewer key (`viewerKey()`: the NFT's asset or the wallet) and `providerWorld()` (pin generation, cluster, program, Season): the same identity `refresh` compares. `orderOf` stores it in each order (`scope`).
- **`orderAnswered` and `orderUnconfirmed`** write and emit only for an order of the current scope (`orderHere`). An order without a scope behaves as before.
- **`actOnce`**, ordinary path:
  - the scope is taken before anything is sent;
  - after the follow, an `unknown`/`unqueryable` outcome is recorded with `orderUnconfirmed(order, signature, code)`;
  - **if the scope changed, nothing of the answer is shown on the page:** no "done", no failure notice, no record, no `after`, no immediate refresh. A busy notice is cleared.
  - **The effects bus is told as before:** `action:landed` for a landing, `action:refused` otherwise, so a pending busy effect settles. Ending a scene of another world is the stage's, which is Lane C's and not touched.
- **The `finally` block** no longer writes a refused record over an unconfirmed one.
- **Unchanged:**
  - the notice texts, what is sent and how;
  - the double-send guard;
  - the province catch-up retry;
  - every rule, cost, permission and send condition;
  - local play's own path.
  - `orderUnconfirmed`'s pinned record line stays verbatim: the ordinary path's code is set on the next line.

## Checked against what exists

- **The controller's text pins are unaffected:** all 40 whole-file regex pins in `permutation-gateway/test/*.mjs` (`assert.match` / `doesNotMatch` on `ctl`/`ctrl`) give the same answer on the old and the new text. The local-play send-part pins (`web-frontier-local-play-act.test.mjs` `:455-480`) match unchanged lines.
- **Lane C's reserved hunks are not touched:** `peopleSource`, battles, fx, stage, `sheetfx`, world cleanup. The fix is inside `orderOf` / `orderAnswered` / `orderUnconfirmed` / `actOnce` only. The merge checks with Lane C's open tips are in the hand-over.

## Found, not changed

**`sendKey(name, fields)` does not include the village:**
- **The case:** training the same unit and number in village B while village A's identical train is in flight is answered "already sending", and nothing is sent.
- **Why not changed:** that is a false block, not a mix. Making the key per village would change the guard's meaning, so it is left for the owner.

## Regression (written, NOT run): `permutation-gateway/test/web-frontier-order-scope.test.mjs`

Text pins, as the other controller tests:
- the scope's definition and its use in `orderOf`, `orderAnswered` and `orderUnconfirmed`;
- in `actOnce`: the scope taken before the send, and the order of the branches (unknown recorded, then moved shows nothing, then the failure notice, then the landing);
- the moved branch's content (effects as before, busy cleared, no `done`/`failed`/record/`after`/refresh);
- the `finally` guard;
- local play's own unconfirmed branch still first.

**Running it needs its own approval.**

## Still not connected (next units of this flow)

- **Re-confirming a held order (ordinary path):** a press on an order recorded as unconfirmed builds and sends a new transaction. Local play asks its signature first; the ordinary path has no such held ledger. Adding one would be a new rule for the ordinary path, so it is the owner's decision.
- **Real sending:** not done here (no signature, wallet or world). The flow is static.

## Hand-over (Lane D)

**Unit:** `claude/ws07-order-scope-20261117` on `837af08b`, all `100644`:
- `permutation-server/web/frontier/controller.mjs` (M)
- `permutation-gateway/test/web-frontier-order-scope.test.mjs` (A)
- `docs/integration/CLAUDE-WS07-ORDER-SCOPE-20261117.md` (A)

**Not run:** anything.
