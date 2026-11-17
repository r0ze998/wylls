# ③ MCP store: a record archived after a torn line stays on its own line (2026-11-17)

**Branch:** `claude/ws03-store-archive-torn-20261117`, from the fixed aggregate `claude/aggregate-approved-20261117` at `aec70744`. The aggregate, canonical, `main`, Lane D and Lane C refs are unchanged. The scope was agreed with Lane D and Lane C in advance.

**Static change, NOT run:**
- **Not done:** no test, import, syntax check, server start, HTTP or RPC.
- **No real data touched:** no store or user data was opened.

## The defect (traced at `aec70744`)

**How the archive works today:**
- `JsonStore.#indexArchive` indexes only lines that end with a newline. A crash-cut last line (no newline) is skipped (`src/store.mjs:28-39`).
- `archive()` appended the new record **directly after whatever ended the file** (`:50-62`: `openSync(..., 'a')`, offset = file size).

**The failure, after a crash cut the last line:**
1. The next finished operation's JSON is glued onto the cut bytes, making one line: `{"id":"op_3","torn{"id":"op_4",…}\n`.
2. In the same process it is still found (the index points to the new record's own offset).
3. `server.archiveFinished` then deletes the hot copy and saves (`server.mjs:707-718`).
4. **After a restart,** that glued line does not parse, so op_4 is in neither the main file nor the index.

**What depends on it:**
- `store.operation(opId)` in `send` (`server.mjs:174`): the same connection's retry with the same `requestId` no longer finds its operation. The guard "a retry of a decision already taken: the same operation, never a second send" then has nothing to hold it.
- `store.operationsWithRequestId` (`:180`): the reconnect guard ("never a second send under a new connection") misses it too.
- `get_operation_status`, `list_operations` and the owner's view lose it.

**Test coverage:** the existing `test/archive.test.mjs` "torn last line" case reads the archive once after the cut. It never appends after the cut and restarts.

## The change (`src/store.mjs` `archive()` only)

- **Opening:** the archive is opened `'a+'` (read and append; every write still goes to the end).
- **Before writing:**
  - if the file is not empty and its **last byte is not a newline**, one newline is written **before** the record, in the same `writeSync`;
  - the record's offset is `size + 1` in that case, otherwise `size` as before;
  - if the last byte cannot be read, `archive` throws before writing anything.
- **What is kept:**
  - No byte already in the file is changed, truncated or removed. The cut bytes become a separate line that the index still skips.
  - The order is unchanged: append, then fsync, then index, then delete the hot copy (the caller saves). For when an exception leaves the hot copy in place, see "Short writes" below.
  - A newline-terminated or empty archive gets no extra byte.
  - The in-memory store (no file) is unchanged.
  - Offsets stay in bytes (`fstat` size, `Buffer.byteLength`), so multi-byte text reads back exactly.

**Not changed:** `server`, `receipt-port`, `auth`, `game`, the bin, sending, signing and permissions.

## Regression (written, NOT run): `test/archive-torn-append.test.mjs`

Imports: `node:` builtins and `src/store.mjs` only. Writes: only in its own new temporary directory.

| Case | What is checked |
|---|---|
| T1 | torn tail, a new archive, then a restart: the new record is found by `operation(id)`, by `operationsWithRequestId` and in `operationsOf`; the bytes before are unchanged; one newline closes the cut line; the cut line is still not an operation |
| T2 | a newline-terminated archive: exactly one record's bytes are added, with no blank line |
| T3 | an empty archive file: no separator |
| T4 | multi-byte notes before and after a torn tail, two appends, then a restart: each record reads back exactly; no blank line |
| T5 | in memory: unchanged |
| T6 | a short write (half the bytes) throws; the operation stays in the main state; the bytes before are unchanged and the half record stays; after a save and a restart it is read from the main file, also by `requestId` |
| T7 | a zero-length write throws the same way |
| T8 | a write one byte short (a whole record without its newline) throws; the retry appends on its own line; after a restart the operation is found once, by id, by `requestId` and in lists, with its multi-byte note intact |

T6–T8 replace `fs.writeSync` for one archive call only (restored in `finally`, with `syncBuiltinESMExports` so that `store.mjs`'s imported binding sees it). The bytes are really written to the test's own temporary file.

## Short writes (added 2026-11-17, second commit)

`fs.writeSync` answers how many bytes it wrote ([Node docs](https://nodejs.org/api/fs.html#fswritesyncfd-string-position-encoding)), and the first commit did not check that. `archive()` now writes the separator and the record as one UTF-8 `Buffer` and compares the count with the buffer's byte length. **Anything less, zero included, throws** before `fsync`, the index and the delete.
- **What stays in the file:** the bytes that were written. Append-only: nothing is truncated, rolled back or removed. They form a cut tail, which the next archive closes with its separator (this commit's first fix).
- **Retry:** `archiveFinished` tries the operation again later. A short write that held the whole record without its newline becomes, once closed, a complete duplicate line of an operation that is still in the main state. The main copy wins, and the retry's later line replaces the index entry, so the operation is found once.

**When a failure leaves the operation in the main state** (exactly):
- an exception from `mkdirSync`, `openSync`, `fstatSync`, the last-byte `readSync` (or reading fewer than 1 byte), `writeSync`, a short or zero `writeSync`, or `fsyncSync`. All of these come before `#remember` and the delete.
- **After a full write, if `fsync` throws:** the line may be on disk while the operation stays in the main state. That is the existing "left in both places" case: the main copy wins.
- **Not covered:** `closeSync` throwing after a successful write and index (inside `finally`). The exception then propagates before the delete, so the operation also stays in the main state, but it is already indexed. This is again the "both places" case, and the main copy is read.
- **The server's side** (unchanged, read only): `archiveFinished` saves only after its loop (`server.mjs:707-718`). If `archive` throws for the second of several operations, the first is already archived and deleted in memory, and is saved by the next save. The caller's log line "archive failed (nothing moved)" (`:819`) is therefore not exact for that first operation. That wording is outside the store and is noted, not changed.

## Static counter-review (once, read only)

1. **A crash during the new write itself:**
   - **Only the newline written:** the file then ends in a newline, the cut line is closed and still skipped, and the next archive needs no separator.
   - **Part of the record written:** the file ends cut again, and the next archive adds the separator again.
   - **In both cases** the operation's hot copy was not deleted yet (delete comes after the write), so it is read from the main file.
2. **A cut tail that happens to be a whole record without its newline:**
   - The separator turns it into a complete line, so a restart indexes it.
   - That operation is still in the main file (the crash came before `delete` and `save`), so the main copy wins: `operation` reads `state.operations` first; `operationsWithRequestId` and `operationsOf` drop archived ids that are hot.
   - When it is archived again, its later line replaces the index entry with the same final record.
   - This is the existing "left in both places" rule (`archive()` doc, `archive.test.mjs:69-89`).
3. **Existing assertions still hold:**
   - `archive.test.mjs:47` counts the lines of a newline-terminated archive: no separator is added there.
   - `:64` compares the archive's first bytes before and after: no existing byte changes.
4. **Other callers:**
   - `server.mjs:712` (`archiveFinished`, inside its try/log at `:819`) and `bench/store-growth.mjs` are the only other callers of `archive()`.
   - The cost is one 1-byte positioned read per archived operation (the bench appends to its own new files).
   - No caller relies on the old open mode.
5. **The aggregate moved meanwhile** (`ebc59477`: two documents and `12-device-runbook.ja.md`). It changes no file on this branch.

**Result at that point:** no further defect found. A later review then found the unchecked `writeSync` count, which is fixed in the second commit ("Short writes").

## Not verified, and what remains

- **Nothing was run:** neither the new regression nor `archive.test.mjs` (which imports `test/fixture.mjs` and the gateway world).
- **No real store was opened.**
- **Remaining for the user's MCP:** a real ChatGPT or Claude Code connection still needs its outside prerequisites (identity provider, tunnel or deployment, the wallet in the OAuth window, the plan), as recorded in the preflight reports.

## Static counter-review of the short-write fix (once, read only)

1. **Byte lengths:** the comparison uses the UTF-8 `Buffer` actually passed to `writeSync`, so multi-byte text cannot make it pass short. The index's offset (`size + sep.length`; `sep` is ASCII) and length (`Buffer.byteLength(line) - 1`) are as before.
2. **Order:** the check sits between `writeSync` and `fsyncSync`. Nothing is indexed or deleted on a short count. The memory store's branch returns earlier and is untouched.
3. **Append-only:** no `truncate`, `ftruncate`, positioned overwrite or removal anywhere in `archive()`. `'a+'` writes always go to the end.
4. **No loop:** a short write is not continued with the rest. Continuing would make a record out of two writes with no way to tell, after a crash in between, which part belongs to which attempt. A refused archive is retried whole by the caller, and the cut tail is closed by the separator.
5. **Error text:** byte counts only; no record content, id or path. The server logs it through `scrub`.
6. **Other users of `writeSync` in `store.mjs`:** `save()` writes the main state to a temporary file and renames it. Its count is not checked either. That is outside this change and is noted: a short write there would make the next load's `JSON.parse` fail, not lose the archive. It is not changed here.

**Final fixed tip:** given in the commit that adds this section.
