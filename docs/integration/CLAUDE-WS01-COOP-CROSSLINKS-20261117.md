# ①'s board page: my requests and answers ↔ each request's record ↔ its joint progress (2026-11-17)

**Branch:** `claude/ws01-coop-crosslinks-20261117`, one commit **on `99c8e479`** (the request-record unit's final tip, unchanged).

**Adoption:**
- after `ddab4ea2..99c8e479`;
- take this unit's own diff `99c8e479..<this tip>`.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, RPC, signature, send or world;
- not tried in a browser.

## The gap

- **"自分" (`view.personal`):** only drew counts: "自分の依頼 n 件・自分の応答 m 件".
- **The joint progress (`view.joint`):** drawn per host.
- **The requests:** a separate list.
- **Nothing on the page went from one to the other.** A player could not go from their own request or answer to that request's record, or to the progress it counts toward, and back.

## The producer keys (adopted, unchanged)

- **A request:** `id` (the record id, unique), `goalId`, `requester`, and `ctx` (`{programId, seasonId}`, set at the request; `record.mjs` fold).
- **`goal.mjs` `coopView` joint:** one entry per `goalId|requester`. It adds **every** request with that key, **across contexts**. So a request belongs to exactly one joint entry, but that entry may also contain requests of an earlier world.
- **`personal.myRequests[].id`, `personal.myResponses[].id` (+ `response`):** request ids.

## The fix (read only)

| Part | Change |
|---|---|
| `coop/crosslinks.mjs` (new, pure) | **`jointOfRequest(view, q, season)`:** `one` only when the request is of the board's present world (`ctx`), exactly one joint entry has its `goalId` and requester, the request is among that entry's requests, and **every** request of that entry is of the present world. Otherwise `other-world`, `mixed` (an earlier world mixed in: which world's progress is not one), `none` or `ambiguous`, each with the reason. **`requestsOfJoint`:** the entry's requests, the same way (`mixed` is not linked). **`personalLinks`:** my requests and answers by id, `found` only when that id is in the view; for an answer, its `answer` and `withdrawn`. Nothing is matched by coordinates or names. |
| request card | on **every** request (open or closed, answered or withdrawn): "協力の進捗（… の貯蔵庫）へ", or "協力の進捗とは結ばない：<why>"; and "自分の欄へ" when it is mine or I answered it |
| joint entry | `data-goal` added beside `data-host`. "この進捗の依頼 n 件：依頼 i（id）の記録へ…", or why not. |
| 自分 | my requests (id, state) and my answers (id, state, sending / withdrawn / declined), each a link to that request's record, or "いまの表示にない" |
| moving | `onNav`, on the three sections only. It finds the target by comparing data attributes (never by putting text in a selector), scrolls to it, and opens the request's record. |
| `coop/index.html` | the links' small style |

**Unchanged:**
- counting, judging, rewards and ⑮;
- the five-panel apply and rollback, and the viewer and world boundaries (everything is drawn from the same applied view);
- the action handler. It stays the only `document` click handler, so the existing pin on its slice is unchanged.

**Nothing new is done:** links only move within the page. No post, follow, link, send, sign or read.

## Regression (written, NOT run): `workstreams/01-national-strategy/test/coop.crosslinks.test.mjs` (new)

- **One in this world:** a closed request too, and both directions.
- **Not linked:**
  - another world;
  - an earlier world mixed into the progress;
  - none, two entries, or no joint;
  - the request not among the entry's requests;
  - no world named;
  - another goal.
- **My requests and answers:** found or not; withdrawn; no viewer → nothing.
- **The page:**
  - the helpers, `crosslinks.mjs` and `onNav` call no post, follow, send, sign, fetch or refresh;
  - targets compared as data;
  - the listener on the three sections;
  - one `document` click handler;
  - the links on every request, on the joint entries and in 自分, with the reasons.

## Hand-over (Lane D)

**Unit:** `claude/ws01-coop-crosslinks-20261117`, one commit on `99c8e479`, all `100644`:
- `workstreams/01-national-strategy/coop/crosslinks.mjs` (A)
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `workstreams/01-national-strategy/coop/index.html` (M)
- `workstreams/01-national-strategy/test/coop.crosslinks.test.mjs` (A)
- `docs/integration/CLAUDE-WS01-COOP-CROSSLINKS-20261117.md` (A)

**Not run:** anything.
