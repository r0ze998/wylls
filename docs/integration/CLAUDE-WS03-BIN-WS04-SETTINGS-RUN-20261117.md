# ③ MCP launcher: one run of the ④ settings test at `68a512fa` (2026-11-17)

**Result: 4/4 passed** (S1–S4), exit 0, run once on 2026-11-17 at 00:19 UTC. There was no retry and no other test.

**What ran:**
- `workstreams/03-composability/mcp/test/ws04-acts-settings.test.mjs` only.
- **How:** in a freshly extracted tree, with the no-key guard preloaded.
- **Not involved:** the launcher was not started (the test reads it as text), and `npm test`'s wildcard was not used.
- **Not touched:** ③'s `game.mjs`, the seal worker, web frontier, ⑬, walls, muster, world and runner code. Group G, H and ⑬'s guard tests stay as they were (not run and not traced).

## Inputs (each checked as a hard condition before node started)

| Item | SHA-256 |
|---|---|
| node `/opt/homebrew/opt/node/bin/node` (v23.11.0) | `01ca46d5dbf4e6fd39e2cca6154b24e867fae029512b125b1b108ecfbcc1b462` |
| `workstreams/12-memory/tools/nokey-guard.mjs` | `cf4518176289a45755a831140c85705093e9352825d3a6e80c75d91cf4f9862f` |
| `mcp/bin/ws04-acts-settings.mjs` | `fb95e1f94efc9925156bf681c025dfb3953300d9f979935f85b5527fe4d4e39d` |
| `mcp/test/ws04-acts-settings.test.mjs` | `867b8d45c244023a3084aa8cefe98f0dfcbba1673400004af46abc2119f6be0b` |
| `mcp/bin/wylls-mcp.mjs` (read as text) | `692eef7edfe8c07ee7e888a61ed653de0a70b727535aa0da005d932036d86825` |
| the run script (scratchpad `scripts/run-ws04-settings-68a512fa.sh`) | `4275f8f73ece6196a30c160c415d30d3c6d20729af7099f1a63ba7c2441625c7` |

**Commit:** `68a512fa6cf6f16cfdbc5751c29fa169e140972e`.

## Checks around the run

**Before:**
- **The worktree:** HEAD `9fe9018e`, nothing staged, the 13 media deletions present, status hash `382fc9aa…00b8`.
- **Environment:** `NODE_USE_SYSTEM_CA` was set and was cleared for the run (`env -u NODE_OPTIONS -u NODE_USE_SYSTEM_CA -u NODE_PATH`). No `LD_*` or `DYLD_*` was set.
- **Disk:** 49 GiB free (floor 21).

**The tree:**
- A new folder, `ws03-settings-run-68a512fa` (created with `mkdir`; it did not exist).
- `git archive 68a512fa` of the four files, extracted with `tar -x -k`.
- 4 files, 0 symlinks, no `node_modules` or `package.json` in any ancestor.

**The command:**
`node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test workstreams/03-composability/mcp/test/ws04-acts-settings.test.mjs`

**After:**
- **The run folder:** still 4 files and 8 directories; the four files' hashes are unchanged. The run wrote nothing, and the folder is kept as evidence.
- **The worktree:** HEAD, the status hash, the empty index and the 13 media deletions are the same as before.

**Log:** scratchpad `logs/ws03-settings-run-68a512fa.log`, 1,020 bytes, SHA-256 `ef4d78bd6583b3d6506828ccca8b64280ed21d06388e27dce7c2ed735f482117`.

## Output

```
✔ S1 none, or all three: no error (unchanged)
✔ S2 every partial combination is refused
✔ S3 an empty value counts as not given, as the launcher reads them
✔ S4 bin: checked with the other settings, before the store, the relay and the registry
ℹ tests 4 · pass 4 · fail 0 · cancelled 0 · skipped 0 · todo 0
```

## What this does and does not show

**Shown:** the pure helper's answers for every combination of the three settings, with and without a gateway port and with empty values; that no setting's value appears in an error text; and, in the launcher's **text**, that the check comes before the store, `Game` and the registry import, and that the `readVia` line is unchanged.

**Not shown:**
- The launcher was not started, so its exit code 2 and its stderr on a real partial setting are read from the source, not observed.
- No other test was run (no `ws04-readvia.test.mjs`, no `npm test`).
- No HTTP, RPC, authentication, key, signing or send.
