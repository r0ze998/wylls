# Village card → one request on ①'s board, checked on both ends (2026-11-17)

**Branch:** `claude/ws07-ws01-request-link-20261117`, **on `c296c41a`** (the board-page-reads unit's final tip, unchanged).
- `c4e9ecb0` is the first tip.
- The correction (the second tip) is on top of it.
- **Adopt the final tip only.**

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

## Correction (second tip): the parent's review of `c4e9ecb0`

**Do not adopt `c4e9ecb0` alone.**

1. **A regression in the page's start-up** (`coop/coop-ui.mjs`).
   - **The cause:** the named-request lines were inserted between the destination's fill line (`if (to && format && sameWorld) …`) and its `else if (to && format)` warning. The `else if` was then bound to the new `if (reqParam !== null && !focus)`.
   - **The effect:** a correct same-world entry, with or without a request, fell into the `else if` and showed "入口の村は別の世界…の村のため、届け先に入れていない" (or "どの世界か分からない"), although the destination was filled.
   - **The fix:** the destination chain is again exactly as in `c296c41a` (fill → another world / no world → broken `?to=`). The named request is decided **after** it, on its own (`entryOk`, `sameWorld`, the id), and gives its own reason:
     - no or broken entry village: "入口の村が渡されていないか読めない";
     - another or unnamed world: "この板の世界の村だと確かめられない";
     - an unreadable id: "依頼の名前が読めない".
2. **The mark was invisible** (`coop/index.html`).
   - **Before:** the page's style had no `.focus` rule, so the request was only scrolled to.
   - **Now:** `.req.focus` has a tinted background, a left bar in the page's own `--warn` colour, and the label "入口で選んだ依頼" (not by colour alone).

**Traced statically after the fix:**

| Entry | Destination | Notice | Named request |
|---|---|---|---|
| this world, `request=` | filled | none | kept, checked on each view |
| this world, no `request=` (the old link) | filled | none | none, nothing said |
| another world | not filled | "別の世界" | refused, with the reason |
| world not named | not filled | "どの世界か分からない" | refused, with the reason |
| broken `?to=` | not filled | "読めない" | refused, with the reason |

**Reviewed again, no other change:**
- **The request's checks:** present, `ctx` of this world, `to` the entry's village.
- **Each applied view:** the mark is set again, but the page scrolls only once per page load (a reload scrolls again).
- **When a read fails:** the old display keeps its mark, and its age is said by the read state line.
- **When the request disappears:** said, and the mark goes with the re-render.
- **Nothing is accepted, signed or sent.**

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
- **(second tip)** the request's three reasons;
- **(second tip)** the destination chain is unbroken (fill → another world → broken, then the request; the `else if` follows the fill line directly; no request code inside the chain, and no destination code after it);
- **(second tip)** the `.req.focus` style and label in `coop/index.html`.

## Hand-over (Lane D)

**Unit:** `claude/ws07-ws01-request-link-20261117`, two commits on `c296c41a` (`c4e9ecb0`, then the correction). Take the final tip's diff from `c296c41a`, all `100644`:
- `workstreams/01-national-strategy/coop/index.html` (M, second tip)
- `permutation-server/web/frontier/hud/coopboard.mjs` (M)
- `permutation-server/web/frontier/hud/coopentry.mjs` (M)
- `permutation-server/web/lang/en-frontier-play.mjs` (M)
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `permutation-gateway/test/web-frontier-ws07-coop-village-requests.test.mjs` (M)
- `workstreams/01-national-strategy/test/coop.entry-world.test.mjs` (M)
- `docs/integration/CLAUDE-WS07-WS01-REQUEST-LINK-20261117.md` (A)

**Not run:** anything.
