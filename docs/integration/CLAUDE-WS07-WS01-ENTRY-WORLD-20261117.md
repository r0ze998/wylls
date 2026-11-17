# Village card → request board: the destination keeps its world; the page applies no older answer (2026-11-17)

**Branch:** `claude/ws07-ws01-entry-world-20261117`, one commit **on `64dda7b8`** (which is on `c18eee20`; both unchanged). Adoption order: `c18eee20` → `64dda7b8` → this.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, signature, send or world;
- every edit is a text replacement.
- Nothing is called "verified".

## The defects (definite, under ①'s and ⑦'s same-world contract)

1. **The destination could land in another world.**
   - **The card side:** the card's link (`hud/coopboard.mjs` `boardHref`) carried only `?to=p,q,site,gen`.
   - **The page side:** ①'s page (`coop/coop-ui.mjs`) filled that into the destination unconditionally, against whatever world its board serves now (`cfg.season`).
   - **How it happens:** the card checks the board's world when it decides to offer the link (`boardState`), but a page opened later or in another tab reads `/coop/config` again. A board restarted on a new Season or program in the meantime then gets the **same coordinates in another world** as its destination. A request is always signed for the board's present world (`season: cfg.season`), so it would name another village.
2. **The page applied older answers.**
   - **The cause:** ①'s page reads `/coop/view` every 4 s and after each of its own posts, and applied the answers **in arrival order**.
   - **The effect:** a slower, older answer (the state before the user's own request or answer, or a view for the viewer before the wallet was connected) overwrote a newer one and was shown until the next read.

## The fix

| Where | Change |
|---|---|
| `hud/coopboard.mjs` `boardHref` | adds `&program=<this page's pin>&season=<this page's Season>`. If the page cannot name either, no world is sent. The page link itself and `?to=` are unchanged. |
| `coop/coop-ui.mjs` (init) | **fills the destination only when `program` and `season` equal the board's present world.** Another world: not filled, and it says "入口の村は別の世界（シーズン n）の村…この板の世界（シーズン m）の届け先の村を入れてください". No world named: not filled, with "どの世界の村か分からない…". A malformed `?to=`: unchanged text. The destination can still be typed by hand; the request's own checks are unchanged. |
| `coop/coop-ui.mjs` `refresh` | each read gets a number. **An answer is applied only if it is newer than the last one applied**, so a slow server still gets its new answers shown, and only if the wallet (viewer) is still the one it was read for. Rendering happens only after it is applied. |

**Unchanged:**
- every signature and send path, and the authorization;
- re-sends, ⑮, and the board server.
- Nothing is sent by this change.

**Tests updated to the new link** (same assertions, plus the world):
- `permutation-gateway/test/web-frontier-ws07-coop.test.mjs`: two exact link comparisons.
- `workstreams/01-national-strategy/test/coop.browser.mjs`: the two page URLs. This file signs with keys and is **not run**. `coop.browser.nokey.mjs` only tests a malformed `?to=`, whose text is unchanged.

## Regression (written, NOT run)

- **`web-frontier-ws07-coop-village-requests.test.mjs`** (appended): `boardHref` with the page's world, and without it when the page has no pin or no Season.
- **`workstreams/01-national-strategy/test/coop.entry-world.test.mjs`** (new). ①'s page runs in a browser, so its source is pinned as text:
  - the same-world condition, and the two refusal texts;
  - the malformed-`?to=` text unchanged;
  - the refresh rule (newer than applied, same viewer, rendered after).

## The rest of the same flow (traced, no other definite defect found)

| Step | Where | State |
|---|---|---|
| request, answer | ①'s page `post` (signed by the wallet, `season: cfg.season`), then `await refresh()` | correct: the refresh rule above now keeps it from being undone by an older answer |
| caravan prepared, send | ①'s `planSend` / `sendPlanned` (the game's `fplay`); a `sending` record before the send | unchanged (adopted; not exercised here) |
| send status | ①'s `sendOutcome`; the game's village card (`64dda7b8`) counts them | correct; unknown stays unknown |
| result, fulfilment | ①'s `fulfilmentOf` (bounds); the card (`c18eee20`) | correct; reached means the proven lower bound |
| reload, restart | the board refolds its signed records; the page and the card read again | correct; no state is carried by the card |

**Held (not invented):**
- ⑮'s verdict;
- the board's public deployment (`b40be705`).

## Hand-over (Lane D)

**Unit:** `claude/ws07-ws01-entry-world-20261117`, one commit on `64dda7b8`, all `100644`:
- `permutation-server/web/frontier/hud/coopboard.mjs` (M)
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `permutation-gateway/test/web-frontier-ws07-coop.test.mjs` (M)
- `permutation-gateway/test/web-frontier-ws07-coop-village-requests.test.mjs` (M)
- `workstreams/01-national-strategy/test/coop.browser.mjs` (M)
- `workstreams/01-national-strategy/test/coop.entry-world.test.mjs` (A)
- `docs/integration/CLAUDE-WS07-WS01-ENTRY-WORLD-20261117.md` (A)

**Not run:** anything.
