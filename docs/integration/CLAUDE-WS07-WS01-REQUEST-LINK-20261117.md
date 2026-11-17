# Village card → one request on ①'s board, checked on both ends (2026-11-17)

**Branch:** `claude/ws07-ws01-request-link-20261117`, one commit **on `c296c41a`** (the board-page-reads unit's final tip, unchanged).

**Adoption order:**
- `c18eee20` → `64dda7b8` → `6a77007d` → `c296c41a` → this.
- `c18eee20` and `64dda7b8` are already in the aggregate as their own commits. The add/add of `web-frontier-ws07-coop-village-requests.test.mjs` resolves to this chain's blob, a superset.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, signature, send or world;
- text replacements only;
- nothing verified on a real board.

## What was missing

The card showed counts and one general link to the board. A player could not go from the card to **a particular request** to this village (its answers, its prepared or sent caravans, its fulfilment) without finding it again in the board's list.

## What it does now

| End | Change |
|---|---|
| **Card** (`hud/coopboard.mjs` `villageRequests`) | `links`: one per request **already counted**: this world (its own `ctx`, and the board's program must be named) and this village (`to` = p, q, site, gen). Open ones first, **at most five**. The text is "依頼 n を板で開く（受付中/受付は終わった・①'s fulfilment word）". An unknown fulfilment status gets the "cannot be judged" word. |
| **Card** (`boardHref(FS, b, requestId)`) | adds `&request=<id>` (URL-encoded), **only when the page's world is sent too**. Without a world, no request is named. The general link is unchanged (the third argument is optional). |
| **Slot** (`hud/coopentry.mjs`) | an entry's `detail` may give `links: [{href, text}]`. They are drawn as `<a target="_blank" rel="noopener">`, **for paths on this origin only** (`/…`, not `//…`, no backslash). The text and the href are escaped by `html`. Without `links`, the slot is as before. |
| **Board page** (`coop/coop-ui.mjs`) | `request=` is kept **only when the entry's village is of this board's world** (the same rule as the destination). After **every applied view** (a reload too), the page checks that the named request is present, is of this board's world (`ctx`), and is to the entry's village (`to`). Only then does it mark it (class `focus`) and scroll to it, once. |

**When the check fails, the page says why** (its own line, `#focusState`) and asks the player to choose from the list:
- not on the board (gone, or of another world);
- no longer in the view (the records changed);
- not to this village or not of this world;
- the world could not be checked.

**Nothing is accepted, signed, prepared or sent by following a link:** the request's own buttons are the only way, as before.

**Unchanged:**
- the counts and their unknown handling;
- the world hand-over and the read state;
- every rule, permission and send. No ⑮ verdict is involved.

**Language:** 7 keys in the same cooperation block of `lang/en-frontier-play.mjs` (mid-file; Lane C appends at the end). No banned word.

## Regression (written, NOT run)

**`web-frontier-ws07-coop-village-requests.test.mjs`** (appended):
- **the links:** only counted requests, open first, at most five, the id encoded (`a b&c`); no links without a named program;
- **no `request=`** without a world;
- **the slot:** draws same-origin links only (`//evil`, `https://evil` dropped), with their text escaped.

**`workstreams/01-national-strategy/test/coop.entry-world.test.mjs`** (appended):
- the named request is kept only for this world;
- the three checks (present, `ctx`, `to`) and every reason text;
- nothing is posted or sent by `applyFocus`;
- it runs after every applied view.

## Hand-over (Lane D)

**Unit:** `claude/ws07-ws01-request-link-20261117`, one commit on `c296c41a`, all `100644`:
- `permutation-server/web/frontier/hud/coopboard.mjs` (M)
- `permutation-server/web/frontier/hud/coopentry.mjs` (M)
- `permutation-server/web/lang/en-frontier-play.mjs` (M)
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `permutation-gateway/test/web-frontier-ws07-coop-village-requests.test.mjs` (M)
- `workstreams/01-national-strategy/test/coop.entry-world.test.mjs` (M)
- `docs/integration/CLAUDE-WS07-WS01-REQUEST-LINK-20261117.md` (A)

**Not run:** anything.
