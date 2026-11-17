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

## Correction (third tip): every exit after the scope may change

The parent's review of `1c543100` found two remaining paths. Reading every exit of the ordinary path found two more of the same kind. All four are fixed in `controller.mjs` (`actOnce`):

| Exit (ordinary path) | Before | Now |
|---|---|---|
| **a refused send** (`r.ok` false) after the page moved | `return failed(r)` ran **before** the moved check, so the old world's refusal was said on the new page | `if (!r.ok && moved())` first: nothing said, only this order's own busy notice cleared |
| **the moved branch's busy notice** | `if (FS.notice?.busy) setNotice(null)` could clear **another** order's busy notice on the new page | `quiet()`: clears only **this** order's busy notice (`myBusy`, the object this order set; updated when the catch-up retry sets its own) |
| **the NFT generation read** (the one `await` before the `try`) | a late `NftNotHeld` notice, and a write of `FS.resident` for whichever viewer is now shown; a rejection reached the new page's handler | the scope is taken **first** in `actOnce` (before any await). After the read, a moved page returns `ScopeChanged` with no notice and no write. A rejection is thrown as before unless the page moved. |
| **an exception** inside the `try` after the page moved | rethrown to the new page's handler (its error notice) | logged to the console and returned (`scopeChanged`). Before a move, it is thrown as before. |
| **the catch-up retry** | its busy notice could go to a moved page | **the retry and its resend are unchanged.** Only the busy notice is skipped for a moved page, and it counts as this order's. |

**Unchanged:**
- what is sent, when, and how often (the retry's resend included);
- the double-send guard;
- local play;
- the effects bus (landed/refused as before);
- every rule, permission and signature;
- unknown outcomes still say what the chain answered, and stay "sent, not confirmed".

**Not done:** no unknown is treated as settled, and no new re-send rule is added.

**This tip is static only.** No syntax check, script, import or test was run. One combined command that included `node --check` and a regex comparison script was refused by the session's safety check, ran nothing, and was not retried. Every edit after that was made by text replacement only. The earlier pin comparison (40 regexes, old vs new text) covered the second tip, not this one; this tip was checked by reading:
- **The verbatim pin is kept:** `if (!local && !t.ok && retryAfterCatchUp(name, t.code)) {` (`web-frontier-local-play-act.test.mjs`).
- **No pin is touched:** none of the gateway tests' controller pins mention the other lines touched (`git grep`).

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
- the moved branch's content (effects as before, only this order's busy cleared, no `done`/`failed`/record/`after`/refresh);
- (third tip) the scope taken before the first await; `myBusy`/`quiet`; the generation read's guard; a refused send's moved check before its notice; the retry line verbatim with its busy gated; the `catch` returning for a moved page;
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

**Merge checks (objects only):**
- with the aggregate: on its tip.
- with Lane C's open tips: several already conflict with the aggregate on their own (`app.mjs`, `web-frontier-ws07-season-order-text.test.mjs`, `07-player-experience/CONTRACTS.ja.md`), for example `26e174ef` and `30d6c549`. **None of those conflicts is in `controller.mjs`.**
- Lane C's controller hunks (`startPlay`, around `:2926`) are far from this unit's (`orderOf`…`actOnce`, `:300-560`). So this unit adds no conflict of its own there.
