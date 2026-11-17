# ①'s board page: each request keeps its saved sends, arrivals and counts, whatever its state (2026-11-17)

**Branch:** `claude/ws01-request-history-20261117`, one commit **on `ddab4ea2`** (the board-composition unit, unchanged).

**Adoption:** take this unit's own diff `ddab4ea2..<this tip>`, after `81b07cee..ddab4ea2`.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, RPC, signature, send or world;
- nothing tried in a browser or on a chain.

## The gap

- **What the page drew:** a request's send state only inside the "accepted, open, destination checked" branch: the pending-send or pending-link button.
- **Who lost the trail:** a request that was cancelled or expired, or an answer that was withdrawn. The saved sends could not be followed from that request.
- **Where the rest was:** arrivals were only in the page-wide table, so a player arriving by the village card's deep link could not see that request's trail in one place.

## The producer contract (adopted, unchanged)

- **`view.requests[]`** (`goal.mjs` `coopView`): **every** request in the fold, with `stateNow`.
  - **`sendings[]`:** each saved `sending` record with `outcome`. `board.mjs` `checks()` runs `sendingStatus` → `chain.mjs` `sendOutcome` for every request on each view and keeps the finished ones; without a chain the outcome is `unknown`, "まだ確かめていない".
  - **`links`:** from the fold.
  - **`arrivals[]`:** the linked caravans' arrivals, with `state`, `counted` (lower bound, or null), `notCountedWhy` and `countFinal`.
  - **`fulfilment`:** already drawn for every request.
- **Kept across reloads:** the records are append-only in the board's store, so a reload or a board restart gives the same records.

## The fix

| Part | Change |
|---|---|
| `coop/history.mjs` (new, pure) | **`requestHistory(q, me)`:** the request's sends as `mine`, responder, number, source, cargo, outcome status, known or not, why, and for a landed send whether it is linked to this request. Its arrivals as caravan, state, counted (`null` when not counted), why, and final or not. **A missing field is `null` (unread, not "none").** A send without an outcome is `unknown`. A status outside `sendOutcome`'s six is kept as itself and marked unknown. **A counted that is not an amount is not made one.** **`OUTCOME_JA`:** the words for the six outcomes; "landed" says it is not an arrival. |
| request card (`coop/coop-ui.mjs`) | **Every request**, outside every open, accepted or destination condition, gets a closed `<details>` "この依頼の記録（送信 n・到着 m）". It lists: the sends, with the source village, cargo and outcome (landed is ok; unknown and unrecognised are warn; failed, mismatch, expired and seq-taken are bad), plus linked or "まだ結び付けていない（結び付けるまで数えない）"; then the arrivals with their state, ④'s delivered text, and "数えた量 …（下限）" or "数えていない（理由）". Unread is said as unread. With no arrival: "まだない（…届かなかったとは言わない）". |
| open state | kept across the 4 s re-reads (a set of request ids, updated by the `toggle` event) |
| deep link | the request the village card pointed at (`applyFocus`, after its checks) opens its record the first time |
| `coop/index.html` | the record's small style |

**Read only:**
- **No button in the record.** It never calls `followSend` (which posts a link record), `post`, `sendOnce` or `sendPlanned`, and adds no new fetch.
- **Unchanged:**
  - the existing buttons and where they appear (open requests only);
  - re-send, link and pending rules;
  - signing and authorization;
  - the five-panel apply and rollback, and the viewer and world boundaries (the same applied view is drawn).

## Regression (written, NOT run): `workstreams/01-national-strategy/test/coop.request-history.test.mjs` (new)

- **A closed (expired) request:**
  - sends that are unknown, landed and linked, landed and unlinked, failed by another player, and with no outcome (unknown);
  - arrivals counted and not counted, with the reasons and the final flags kept.
- **Nothing made up:**
  - missing sendings or arrivals → null;
  - an unrecognised status stays itself (`known: false`);
  - empty lists stay empty;
  - a non-object counted → null;
  - no viewer → nothing is "mine".
- **`OUTCOME_JA`:** its keys are exactly the statuses in `chain.mjs` `sendOutcome` (read as text). "Landed" is not "arrived"; "unknown" is not "not sent".
- **The page:**
  - the record sits outside every condition;
  - neither the record nor `history.mjs` calls post, follow, send, sign or fetch;
  - the unread texts;
  - the open state kept;
  - the focus opens it once, and `applyFocus` still sends nothing.

## Hand-over (Lane D)

**Unit:** `claude/ws01-request-history-20261117`, one commit on `ddab4ea2`, all `100644`:
- `workstreams/01-national-strategy/coop/history.mjs` (A)
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `workstreams/01-national-strategy/coop/index.html` (M)
- `workstreams/01-national-strategy/test/coop.request-history.test.mjs` (A)
- `docs/integration/CLAUDE-WS01-REQUEST-HISTORY-20261117.md` (A)

**Not run:** anything.
