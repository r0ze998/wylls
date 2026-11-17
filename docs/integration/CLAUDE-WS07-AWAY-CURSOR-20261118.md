# WS07 away reader: transport cursor over unreadable records (2026-11-18)

Scope: one UI pagination bug in `permutation-server/web/frontier/hud/awayread.mjs`. No game rule, endpoint, herald
validation, app wiring or other product file changed. Publication (commit/push/review) is the parent's.

## Defect (reproduced by the coordinator against blob 96a1d98a, local and remote)

`createAwayReader.readFrom` moved its cursor only to the newest *decoded* record. A page whose bodies decode to
`null` (a kind this page does not read) or fail to decode adds no record, so the cursor stayed put. With the page
`{ok:true, events:[{seq:"1", body_b64:"Af8AAAAA"}], next:"1", full:true}`, both `start` and every `more` asked
`after=0` again, for ever, and never reached the records after it.

## Change (awayread.mjs only)

- Two positions are kept apart: the **transport cursor** follows the page's raw `next`. The **records**, which make up
  the summary and its "seen" mark, are still only the decoded bodies (`decodePage` → `normalizeRecords`, unchanged).
  No record is made up, and `returnsum.summarize` still confirms only up to `records.at(-1)`, so the mark never lands
  on an unread event.
- `pageCursor(rows, next, at)` trusts `next` only when all of these hold:
  - `events` is an array, and every raw `seq` is a canonical decimal u64 (`^(0|[1-9][0-9]{0,19})$`, ≤ 2^64−1).
  - `next` is a canonical u64.
  - `next` equals the page's newest (maximum) raw seq; on an empty page it equals the cursor that was asked from.
  - `next` is not behind the current cursor.

  This check doesn't require the raw rows to be in order, so the overlapping and reversed pages (C5) are still mended
  by `normalizeRecords`. That matches herald.mjs `events` (lines 514–533), which already enforces the same `next`
  rule upstream. The endpoint's validation is unchanged.
- An untrusted cursor is a failed page: `failed: true`, no throw, and that page's records are not taken. The pages
  read before it stand, and the cursor stays at the last trusted value, so the next `more` asks from there.
- Unchanged behaviour:
  - `complete` only when a page says `full: false`.
  - A full page that does not move the cursor stops the read, bounded and not complete.
  - The `pages` budget still ends a read without calling it complete.
  - Stale handling is unchanged: a stale result leaves the cursor untouched.
- Additive: results carry `next`, the transport cursor reached (`null` when stale).

`app.mjs awayPump` was read and needs no change:
- The start summary passes `r.after` (the start position) as `read.after`, so moving the cursor past unreadable
  events opens no false gap.
- `more()` records go only to `itemsSince`, never to a mark.

## Tests

New: `permutation-gateway/test/web-frontier-away-cursor-regression.test.mjs`. It imports only `node:test`,
`node:assert/strict`, `sdk/frontier/abi-v2-logs.mjs`, `sdk/bytes.mjs`, `hud/returnsum.mjs` and `hud/awayread.mjs`.
It uses in-memory `events` callbacks and promises the tests resolve themselves: no timers, sockets, file writes,
spawning or keys. It covers:
- the reported page (`start` and `more` stop asking `after=0`)
- a full page of unsupported records, then a readable page
- a mixed page with an unsupported or undecodable suffix: the cursor goes to the raw end and "seen" stops at the last
  decoded record
- only unsupported records: confirm `nothing`, and the mark is not written
- an empty terminal page with `next` equal to the cursor
- a full page with no progress (bounded, not complete)
- the max-u64 cursor
- 15 untrusted-cursor variants (missing, null, number, leading zero, negative, exponent, space, past u64, behind or
  beyond the newest raw seq, regressing, empty-page mismatch, non-canonical raw seq, non-array events), each failing
  without losing prior pages and resuming from the last trusted cursor
- an untrusted cursor on the first page
- page failure, both `ok:false` and a throw
- the page budget over unsupported records, then `more`
- a scope overtaken by another scope, using controlled promises (stale, empty, the new scope's cursor kept)
- a reset while a page is in flight

Existing `permutation-gateway/test/web-frontier-ws07-away.test.mjs` (fixture correction approved by the parent): only
the mocked `next` contracts changed. `herald()` and the C5 overlap fixture now return `next` as the page's newest raw
seq, or the cursor asked from on an empty page, instead of `null`. The C5 rows are still overlapping and reversed,
and its assertions are unchanged.

## Separate baseline item, not caused by this change

The existing test "after "seen" a reload queues no head notice…" asserts an `awayPump` source line and a `quiet`
helper without `!s.bad`. The coordinator reports that both the current local `app.mjs` and old HEAD already have
`!s.bad` in that line (`app.mjs:2725`), so this assertion mismatch predates this work. The coordinator confirmed it in
the fetched remote line 2725, and old HEAD is the same. As approved, only the regex expectation and the `quiet` helper
were updated to include `!s.bad`. `app.mjs` is unchanged and nothing is skipped.

## Evidence status

- Baseline (the defect reproduced against 96a1d98a): run by the coordinator.
- New test `web-frontier-away-cursor-regression.test.mjs`: audited and run by the coordinator under normal approval.
  **27/27 pass, 0 failures, 0 skips, 64.491917 ms.**
- The parent ran the new test independently: **27/27 pass**.
- Updated `web-frontier-ws07-away.test.mjs` (the `next` fixture corrections and the `!s.bad` assertion and helper):
  audited, then run by the coordinator after a separate normal review
  (`node --test permutation-gateway/test/web-frontier-ws07-away.test.mjs`). **22/22 pass, 0 failures, 0 skips,
  116.006709 ms.**
- Syntax checks of `awayread.mjs` and the new test, and the scoped diff check, passed (coordinator).
- What the tests used:
  - No real browser, world, network, keys or real storage.
  - The new test has no timers.
  - The existing ws07 suite keeps its pre-existing local 20 ms `setTimeout` delay in the C6 fixture.
  - Wallets `W` and `V` are inert scope strings, and marks live only in an in-memory `Map`.
- This worker ran no commands (Read/Edit/Write only). All execution above was done by the coordinator or the parent.
