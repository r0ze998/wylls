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
  - The order is unchanged: append, then fsync, then index, then delete the hot copy (the caller saves). An exception before or during the write leaves the hot copy in place (`archiveFinished` logs "nothing moved").
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
