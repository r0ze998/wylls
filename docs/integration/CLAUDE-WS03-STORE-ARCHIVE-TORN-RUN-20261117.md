# ③ MCP store: one run of `archive-torn-append.test.mjs` at `51dddcaf` (2026-11-17)

**Result: 12/12 passed** (T1–T12), exit 0, run once on 2026-11-17 at 01:03 UTC. There was no retry and no other test.

**What ran:**
- `workstreams/03-composability/mcp/test/archive-torn-append.test.mjs` only, in a freshly extracted tree, with the no-key guard preloaded and `TMPDIR` pointed at a new, dedicated folder.
- **What this is:** the store's own byte handling (archive appends, short writes, `save()`). It is **not** a server start, a real MCP connection, HTTP, RPC, authentication, a key or a send.
- **Not run in any form:** the refused tests and their family (G, H, ⑬'s guard tests, walls, muster, world, runner) and the existing `archive.test.mjs` with its `fixture.mjs`.

## Inputs (each checked as a hard condition before node started)

| Item | SHA-256 |
|---|---|
| the run script (scratchpad `scripts/run-store-torn-51dddcaf.sh`) | `7b600906c2eccd34692e302c6acb9c25eb352e4dd95e1480f379cc008b7c1c1a` |
| node `/opt/homebrew/opt/node/bin/node` (v23.11.0) | `01ca46d5dbf4e6fd39e2cca6154b24e867fae029512b125b1b108ecfbcc1b462` |
| `workstreams/12-memory/tools/nokey-guard.mjs` | `cf4518176289a45755a831140c85705093e9352825d3a6e80c75d91cf4f9862f` |
| `mcp/src/store.mjs` | `89a84c0c781e01f74d18ca14171c5417b6a41c7489fdb258c1a3bba7700ea72a` |
| `mcp/test/archive-torn-append.test.mjs` | `2a3545cd306a08ecddb839ab7e4bd19cc7f320b4d40a4d9fc04ce75c5f5b35cb` |

**Commit:** `51dddcaf6e57f07d3431ce6cf29cb7e58eabb3eb`.

## Checks around the run

**Before, outside the script:**
- the script's hash;
- the set of `NODE_*` variables is exactly `NODE_USE_SYSTEM_CA`, as at the audit (otherwise stop);
- no `LD_*` or `DYLD_*` is set.

**Inside the script:**
- **The worktree:** HEAD `9fe9018e`, nothing staged, 13 media deletions, status hash `382fc9aa…00b8`.
- **Node, disk and the tree:**
  - node's hash; 50 GiB free (floor 21);
  - new run and temp folders, with no `node_modules` or `package.json` above either;
  - `git archive 51dddcaf` of the three files only, `tar -x -k`: 3 files, 0 symlinks;
  - the three file hashes.
- **The command:** `env -u NODE_OPTIONS -u NODE_USE_SYSTEM_CA -u NODE_PATH TMPDIR=<dedicated folder> node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test workstreams/03-composability/mcp/test/archive-torn-append.test.mjs`.
  - `NODE_USE_SYSTEM_CA`, the only `NODE_*` set, was cleared. `NODE_OPTIONS` and `NODE_PATH` were unset to begin with.

**After:**
- **The extracted tree:** 3 files, hashes unchanged.
- **The dedicated `TMPDIR`:** 11 `wylls-mcp-torn-*` folders (one per file-backed case; T5 is in memory) holding 21 files and 0 symlinks:
  - 10 × `store.json`;
  - 8 × `store.json.archive.jsonl`;
  - 3 × `store.json.<pid>.tmp`, the partial temporary files left by the refused saves in T9, T10 and T12. T11's later save renamed its own. As designed, they are left and never read.
- **The system temp folder:** no `wylls-mcp-torn-*` entries.
- **The worktree:** HEAD, the status hash, the empty index and the 13 media deletions are the same as before.
- **Kept as evidence:** both folders.

**Log:** scratchpad `logs/ws03-store-torn-run-51dddcaf.log`, 1,934 bytes, SHA-256 `df71a6943e1824f8fc76b5ad4db8380e6c18584abcf232dd3f50aca9652189c4`.

## Output

```
✔ T1 torn tail, then a new archive, then a restart: the new record is found by id, requestId and in lists
✔ T2 a newline-terminated archive gets no extra newline (no blank lines)
✔ T3 an empty archive file: no separator
✔ T4 multi-byte text after a torn tail: byte offsets still read the exact record after a restart
✔ T5 in memory (no file): unchanged
✔ T6 a short write is refused: no index, the operation stays in the main state, the written bytes stay
✔ T7 a zero-length write is refused the same way
✔ T8 after a short write, the retry appends on its own line; a restart finds the operation once, by id and requestId
✔ T9 save: a short write throws and the last complete state file is unchanged; the next load reads it
✔ T10 save: a zero-length write throws the same way
✔ T11 save: the next save after a refused one writes the whole state (multi-byte text), and a restart reads it
✔ T12 archive then a refused save: after a restart the main copy and the archived line are both there, and the main copy is read
ℹ tests 12 · pass 12 · fail 0 · cancelled 0 · skipped 0 · todo 0
```

## What this does and does not show

**Shown, on this machine's filesystem:**
- `JsonStore`'s archive and save behaviour after a cut tail, a short write and a zero-length write;
- restarts after them (id, `requestId`, lists);
- byte offsets with multi-byte text.

**Not shown:**
- **The short writes were simulated** (a replaced `fs.writeSync` that writes fewer bytes for real), not produced by a full disk or a signal.
- **No crash, power loss or directory-fsync behaviour.**
- **Not run:** the server, the existing `archive.test.mjs`, and any other test.
- **No real MCP connection.**

## Adoption unit (for Lane D)

- **Code:** `claude/ws03-store-archive-torn-20261117` at `51dddcaf6e57f07d3431ce6cf29cb7e58eabb3eb`. Three paths on `aec70744`: `src/store.mjs`, `test/archive-torn-append.test.mjs`, `docs/integration/CLAUDE-WS03-STORE-ARCHIVE-TORN-20261117.md`.
- **This report:** on its own branch, `claude/ws03-store-archive-torn-run-20261117`, on top of `51dddcaf`.
