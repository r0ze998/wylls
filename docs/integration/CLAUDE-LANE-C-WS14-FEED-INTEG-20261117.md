# Lane C — WS14 feed fixes, integrated on their own, plus one provenance fix (2026-11-17)

**Branch:** `claude/lane-c-ws14-feed-integ-20261117`. It starts at `ed665b84`, which is `d16048aa` plus exactly the five WS14 feed commits, with their original SHAs:

| Commit | Change |
|---|---|
| `449d75e0` | The reader refuses broken feeds instead of throwing |
| `28618a83` | An unknown cargo is `null`, never zeros |
| `55a1f558` | A faction or moving seq, when given, must be a non-negative integer |
| `5986d94d` | Contract §6: an unknown cargo is `null` and counted in `cargoNotGiven` |
| `ed665b84` | The tie-break uses each collection's own field; the docs and ⑮'s test close the null-cargo contract |

All five are linear on `d16048aa`, and no media file is in the range.

**What this branch does not touch:** the candidate, the canonical tree, other owners' branches, and the earlier refused C/D integration. The working tree was switched within the existing Lane C worktree, so no media was regenerated; the user's 25 deleted media files stay deleted and unstaged.

**Nothing was run:** no test, import, HTTP server, process or world.

## The one added fix: `provenanceOf` called missing fold evidence a stable snapshot

**Defect.**
- `game/centre.mjs` `provenanceOf` picks `foldedThrough`, `events` and `lastSlot` with `?? null`, then compared before and after as `JSON.stringify(a) === JSON.stringify(b)`.
- So `before = after = { v: 1 }` (or any field missing on both sides) gave `null === null`, which is `stable: true`.
- ⑮'s adapter (`workstreams/15-coop-outcomes/src/adapters/ws14-centre.mjs:38`) maps `stable === true` to `'snapshot'`: a fold position that was never read was reported as a confirmed snapshot.

**Fix.**
- A fold position counts as evidence only in the shape the herald writes it (`frontier-node/crates/herald/src/server.rs:311–312`):
  - `foldedThrough`: a JSON number from u64, so a non-negative safe integer;
  - `events`: the u64 as a canonical decimal string;
  - `lastSlot`: a JSON number, so a non-negative safe integer.
- `stable: true` needs that evidence on **both** reads, with equal values.
- If both reads are `v: 1` but either lacks valid evidence, it is **`stable: null`**, with the reason "a /h/status read has no valid fold position … not known whether the fold moved".
- **Unchanged:** no status at all (`from: null`, `stable: null`); one read only (`false`, "only one"); still (`true`); moving (`false`).

**What ⑮ sees.** Its adapter maps anything other than `stable === true` to `'between'`, never `'snapshot'`. So the fix is fail-closed for ⑮ without changing ⑮. "between" is looser than "not known"; telling the two apart would be ⑮'s change (not made).

**Contract.** `workstreams/14-central-tower/CONTRACT.ja.md`'s provenance paragraph now states the `null` case and the herald's field types.

**Regression source** (`game/centre.test.mjs`, new test `provenance: missing or invalid fold evidence is never a stable snapshot`; **written, not run**):
- `{v:1}` on both sides gives `null`.
- Sixteen malformed fields: `foldedThrough` missing, `'9'`, −1, 1.5, `null`, 2^53; `events` missing, 27, `'027'`, `'-1'`, `'2.5'`, `''`; `lastSlot` missing, `'77'`, −1, `null`. Each, on both sides and on either side alone, gives `null`, never `true`.
- The normal cases (still, moving, `lastSlot` moved, zero is a position, one read only) keep their results.
- ⑮'s mapping line is pinned by reading the file as text (not imported).

**Running it later.** It is pure, but `centre.test.mjs` also contains tests that start an HTTP server and child processes. A run must select it alone, by name, for example:

```
node --test --test-name-pattern "missing or invalid fold evidence" workstreams/14-central-tower/game/centre.test.mjs
```

With a name pattern, Node skips the bodies of the tests that do not match. The file's top level, read line by line, defines only constants and small functions (`repo`, `place`, `caravan`, `FEEDS`, `STATUS`, `centreTransit`): no server, process or file access outside test bodies. Not run here.

## The consumer contract, as read

- The existing provenance and HTTP tests use valid `STATUS(...)` objects, so they are unaffected.
- **⑮'s side is not connected to anything real:** `readCentreFacts` is used only by ⑮'s own contract test (`contract-ws14-centre.test.mjs`). No page, gateway or other code imports it, so nothing here completes ⑭ → ⑮ in the product.
- Nothing about scores, prizes, goals, keys, the ABI or permissions is involved.
