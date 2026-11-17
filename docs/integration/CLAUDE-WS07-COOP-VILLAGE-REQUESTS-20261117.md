# Village card: the requests to this village, from ①'s board (2026-11-17)

**Branch:** `claude/ws07-coop-village-requests-20261117`, on the aggregate `claude/aggregate-approved-20261117` at `5314e12e`. It is separate from `e3de2695`, `19f171e2` and `b40be705`.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, signature or world;
- every edit is a text replacement.

## What was missing

**The game's entry to ①'s board** (`hud/coopboard.mjs`, in the village card's slot `hud/coopentry.mjs`) read only `/coop/config` and opened the board's page.

**What it did not show:** ①'s board view (`/coop/view`, `goal.mjs` `coopView`) already holds every request with:
- its context (`ctx {programId, seasonId}`);
- its destination (`to {p, q, site, gen}`);
- its state now (`stateNow`, with expiry);
- its fulfilment (`ws04.mjs` `fulfilmentOf`: `fulfilled` proven by the counted lower bound, `not-reached` proven by the upper bound once all ended, `undetermined`, `none`).

None of that reached the game.

## What it does now

| Part | Change |
|---|---|
| `hud/coopboard.mjs` `probeView` | GET `/coop/view`, `{read: 'ok', requests}` or `{read: 'unread', code}`. **A view whose requests are not all of ①'s shape is not read** (`BadView`), so an incomplete list is never shown as "none". |
| `hud/coopboard.mjs` `villageRequests` | Shown only when the slot is available (`boardState`: the board's present Season and program are the page's, and a village is chosen). It counts only requests whose own `ctx` is the board's present context and whose `to` is **the active village** (p, q, site, gen). Lines: "この村あての依頼 n 件（受付中 k）" and "依頼量に届いた（下限で証明）·判定できない·届かなかった·まだ隊商がない", in **①'s own fulfilment meanings**. "Reached" is the proven lower bound, never a caravan's cargo. Not read yet: "読み込んでいます…". Not readable: "読み込めませんでした（code）". |
| `installCoopBoard` | The view is read **when the card asks** (no timer of its own), once per world while in flight, and marked due again at each config read (every 60 s, as before). **An older read, an answer for a world the board has since left, or an answer after stop is dropped.** The card is drawn again when it comes. |
| `hud/coopentry.mjs` `renderCoopSlot` | An entry may give `detail(FS)` → `{lines}`; the lines are shown under the button. The entry API is otherwise unchanged; without `detail`, the slot is as before. |
| `lang/en-frontier-play.mjs` | 5 keys, **inside the existing cooperation block** (after `村を選ぶと…`, mid-file; Lane C appends at the end, and was told before the edit). No banned English word. |

**Unchanged:**
- the board's page link and its destination (`?to=p,q,site,gen`);
- `boardState`'s refusals (no board, unread, another Season or program, no village);
- every send, signature and permission.
- No ⑮ verdict is shown (not adopted).

## Regression (written, NOT run)

**New file `permutation-gateway/test/web-frontier-ws07-coop-village-requests.test.mjs`:**
- `probeView` reads only a well-formed view: missing `ctx`, short `to`, no fulfilment, a non-array, HTTP errors and network errors are all unread;
- `villageRequests` counts only this world's and this village's requests (another village, gen, site, Season or program is not counted), uses ①'s words, and says loading or unreadable, never "none", until a good view;
- the card reads once while in flight, is drawn again when the view comes, and ignores it after stop.

**The existing `web-frontier-ws07-coop.test.mjs` stays consistent:**
- it asserts one redraw before drawing the slot (the view is read only on drawing);
- its unavailable cases give no detail;
- its open case shows the extra loading line, and its assertions (`Open requests across nations`, not `disabled`) still hold.

## Next in the same loop (adopted parts only)

- **The caravan sent from the game is linked to a request on ①'s page.** ①'s U4/U5 are implemented there. The game's card now shows the request's fulfilment; it does not link caravans itself.
- **⑮'s outcome:** held, since no ruleset is adopted.
- **Board deployment** (`/coop/*` on the game's origin) and the public world: open (`7ee9a892`, `b40be705`).

## Hand-over (Lane D)

**Unit:** `claude/ws07-coop-village-requests-20261117` on `5314e12e`, all `100644`:
- `permutation-server/web/frontier/hud/coopboard.mjs` (M)
- `permutation-server/web/frontier/hud/coopentry.mjs` (M)
- `permutation-server/web/lang/en-frontier-play.mjs` (M)
- `permutation-gateway/test/web-frontier-ws07-coop-village-requests.test.mjs` (A)
- `docs/integration/CLAUDE-WS07-COOP-VILLAGE-REQUESTS-20261117.md` (A)

**Not run:** anything.
