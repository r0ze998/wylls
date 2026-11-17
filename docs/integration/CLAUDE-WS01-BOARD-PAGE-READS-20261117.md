# ①'s request board page: a failed read is a failure, a view is shown whole, actions use the shown snapshot (2026-11-17)

**Branch:** `claude/ws01-board-page-reads-20261117`, one commit **on `6a77007d`** (unchanged). Adoption order: `c18eee20` → `64dda7b8` → `6a77007d` → this.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, signature, send or world;
- every edit is a text replacement.

## The defects (`workstreams/01-national-strategy/coop/coop-ui.mjs`)

1. **A failed read looked like data.**
   - `api()` returned `r.json()` for **any** status. A 500 or 404 with a JSON body, or the config read, became the page's `view` or `cfg`.
   - An HTML error page made `r.json()` throw. The 4-second timer swallowed that (`refresh().catch(() => {})`), so a failing board was silent.
2. **A view could be half applied.**
   - `refresh` set `view`/`feed`, **then** rendered five panels in turn (`joint`, `nationPanel`, `personal`, `requests`, `arrivals`).
   - A malformed or partial answer, or a render that throws, left some panels new and others old, with `view` already replaced. **The next click then acted on a snapshot no panel showed.**
3. **Actions could use another viewer's snapshot.**
   - After connecting another wallet, the click handler used whatever `view` stood until the next successful read.
   - With no view yet (a first read that failed), `view.requests` threw.
4. **`post()` mislabelled failures.**
   - One `try` around signing, the POST and the refresh called **every** failure "署名できない", including a network failure of the POST itself and a failed re-read **after** the board had accepted the record.

## The fix

| Part | Change |
|---|---|
| `apiRead(path)` (GETs: `/coop/config`, `/coop/view`) | only a 2xx JSON is an answer; anything else throws (`HTTP n`, not JSON, not reached) |
| `api()` (POSTs of records) | **unchanged**: the board refuses a record with 400 `{ok: false, why}`, which `post()` reads as before |
| `viewShapeOk` | the shape `goal.mjs` `coopView` + `board.mjs` `view` return (`requests`, `arrivals`, `joint` arrays; `nation`, `personal` null or objects). Anything else is not applied. |
| `refresh()` | **never throws.** It applies only a newer read, for the same viewer, with a good shape, **and only if all five renders succeed.** On a render failure, `view`, `feed` and the five panels' HTML are restored. Then `shownFor` (viewer) and `shownAt` (time) are set. |
| read state line (`#readState`, made under `#msg` if absent) | on any failed read, it says why. With an older view still shown: "表示は HH:MM の読み込みのまま（古い）". With nothing shown yet: "まだ表示できるものがありません". Cleared on the next success. The timer no longer swallows anything. |
| click handler | **acts only on the snapshot shown for the current viewer.** With no view, or a view of another viewer: "表示を読み直しています…" and nothing is done. With a request not in the shown view: said, and nothing is done. |
| `post()` | the outcomes are now told apart. **Not signed:** "署名できない". **The POST failed in transit:** "板に届いたか分からない…" (it may have arrived), and the page reads again. **Refused:** "受け付けられなかった". **Accepted:** the done message, then a re-read whose failure goes to the read state line, **never** "cannot sign" or "not sent". |

**Unchanged:**
- signing, sending (`sendOnce`/`followSend`), re-sends and authorization;
- the board server.
- Nothing is sent automatically, and nothing new is resent.

## Regression (written, NOT run): `workstreams/01-national-strategy/test/coop.entry-world.test.mjs`

The page runs in a browser; its source is pinned as text, as ①'s other page checks.

- **Updated:** the previous unit's refresh pins (`return false`; applied only after the renders).
- **New:**
  - GET reads fail on non-2xx or non-JSON (the config too); the record POST keeps `api()`;
  - the shape check;
  - the five-panel save and restore;
  - "applied" set only after the five renders;
  - the "old" and "nothing yet" lines;
  - the timer not swallowing;
  - the click guard before the snapshot is used;
  - `post()`'s four outcomes, with "署名できない" used only for signing.

**① browser tests** (`coop.browser.mjs` with keys, `coop.browser.nokey.mjs`) are **not run**. They read the action messages in `#msg`, which keeps its meaning. The new line has its own element.

## Hand-over (Lane D)

**Unit:** `claude/ws01-board-page-reads-20261117`, one commit on `6a77007d`, all `100644`:
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `workstreams/01-national-strategy/test/coop.entry-world.test.mjs` (M)
- `docs/integration/CLAUDE-WS01-BOARD-PAGE-READS-20261117.md` (A)

**Not run:** anything.
