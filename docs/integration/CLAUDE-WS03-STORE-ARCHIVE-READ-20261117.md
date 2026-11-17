# ③ MCP store: a failed archive read, and what the readers do with it (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `7058faab` (`src/store.mjs` SHA-256 `89a84c0c…ea72a`, the fixed `51dddcaf` version). Read with `git show` and `git grep` only.

**Not done:**
- No test, import, syntax check, server start, network, key or send.
- No real archive, store or user data was opened.
- Not touched: Lane D (the dispatcher) and Lane C (the shortfall schema).

**Verdict:** **no code change.**
- A failed or short archive read already fails closed, and no path within the store's contract returns a wrong record as a success.
- A list that fails as a whole when one archived record cannot be read is the existing fail-closed behaviour. Returning a partial list instead would be a new specification.

## How an archived record is read (`store.mjs` `operation(id)`)

`operation(id)` uses the main state first. Otherwise it takes the index entry `{offset, length}` and reads `length` bytes at `offset` into `Buffer.alloc(length)` (zero-filled), then `JSON.parse`s them. `readSync`'s returned count is not checked.

| Case | What happens | Success claimed? |
|---|---|---|
| a full read | the record, parsed | yes, correctly |
| **a short read** (fewer bytes than `length`) | the rest of the buffer stays `0x00`. `JSON.parse` does not accept NUL, as data or as whitespace, so it **throws**: partial text followed by NUL, or NUL only for a zero-length read, is never valid JSON | **no:** it throws |
| `openSync` or `readSync` throws | it throws | no |
| the bytes are valid JSON but **another record** | only if the index points to another line: see the next section | — |

**Is the count check missing a defect?** Not as a wrong success: every short read becomes an exception, because the buffer is zero-filled and `JSON.parse` refuses NUL. A count check would change the error's text, not the outcome.

## Can the index point to the wrong record?

- **Where the index comes from:** `#indexArchive` parses the very bytes it indexes, `(offset, length)` from the same buffer. `archive()` records the offset it just wrote at, after a full, counted write (`51dddcaf`).
- **The file never moves under the index:** it is append-only, and no code rewrites or truncates it.
- **So within the contract,** an entry always points to the line it was made from. Pointing to another valid record would need someone outside the store to rewrite or truncate the archive. That is outside `16-continuing-world.ja.md` §4 (l.60: append only; l.108: the archive's existing bytes are never rewritten), and no code path does it.
- **Not added:** an id check after the parse (`record.id === id`). Within the contract there is nothing for it to catch, so it would be hardening against outside tampering, not a fix.

## The readers (server, read only)

**How an exception reaches the client** (`server.mjs:818`, the tool dispatcher):
- The client gets the **fixed text** `internal error` (code `InternalError`).
- The log line is `scrub(e.message)`, which hides runs of 43 or more `[A-Za-z0-9_-]` characters. A `JSON.parse` error message can quote part of the record, but records hold no secret in the clear (`store.mjs` header).
- **The HTTP owner path** (`http.mjs:231-234`) answers `{error: 'server_error'}`.

| Reader | A read that throws | Fail-closed? |
|---|---|---|
| `send` → `store.operation(opId)` (`:174`) | the call throws, so `InternalError`; **nothing is sent** (it is thrown before `resume`) | **yes:** never a second send; the same `requestId` stays blocked until the archive is readable again |
| `send` → `operationsWithRequestId` (`:180`) | reads the **index only** (no record read), so it cannot fail this way | — |
| `get_operation_status` → `store.operation` (`:747-748`), then `mineOp` (`:750`, `op.linkId`) | `InternalError` | yes |
| `list_operations` → `operationsOf(…, 20)` (`:788`) | one unreadable archived record makes the whole call `InternalError` | yes |
| `get_run_status` → `operationsOf(…, 1000)` (`:758`) | the same | yes |
| owner's view → `operationsOf(…, 50)` (`:729`), over HTTP | `server_error` | yes |

**About the ownership check:**
- `operationsOf` filters by the index's `linkId` and then returns the parsed records.
- `mineOp` checks the parsed record's `linkId`.
- Both come from the same line (previous section), so they cannot disagree within the contract.

## What would need a decision (not made)

- **Partial lists:** listing the readable operations and marking the unreadable ones (by id, say), instead of failing the whole call. `16-continuing-world.ja.md` promises that the history stays readable (§4, the "履歴（一覧）はすべて残る" row). It gives no partial-list form, and leaving a record out silently would present an incomplete history as complete. **This is a specification choice for ③'s owner,** so it is not implemented.
- **An id or count check on read,** as hardening against outside changes to the archive. It is optional, and not needed within the contract.

## Static counter-review (once)

- The zero-fill argument holds for every short count, 0 included, and for every byte length. `length` is the record's byte length without its newline, as indexed.
- `JSON.parse` would accept a leading or trailing space, tab or newline, but the zero fill is never one of those.
- The memory store (`memoryArchive[i]`, a string) has no short reads.

**Separation for the hand-over:**
- **Existing safe failures, unchanged:** a short or failed read throws; the lists fail as a whole; `send` refuses to send.
- **Fixes made:** none in this round. The store's fixes are in `51dddcaf`, on the aggregate at `7058faab`.
- **Not verified:** nothing was run. The arguments above come from the source.
