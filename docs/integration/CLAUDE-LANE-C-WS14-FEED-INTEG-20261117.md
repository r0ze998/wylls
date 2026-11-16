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

**Regression source** (moved, 2026-11-17, into its own pure file; see the section below). `game/centre.test.mjs` is back to exactly its `ed665b84` content: no original test was removed or changed.

## The consumer contract, as read

- The existing provenance and HTTP tests use valid `STATUS(...)` objects, so they are unaffected.
- **⑮'s side is not connected to anything real:** `readCentreFacts` is used only by ⑮'s own contract test (`contract-ws14-centre.test.mjs`). No page, gateway or other code imports it, so nothing here completes ⑭ → ⑮ in the product.
- Nothing about scores, prizes, goals, keys, the ABI or permissions is involved.

## Correction and follow-up (2026-11-17; static only, nothing run, imported or compiled)

**Withdrawn: the name-pattern run.**
- The earlier suggestion was to run the new test inside `centre.test.mjs` with `--test-name-pattern`.
- That file also starts an HTTP server and child processes, and it is on `scripts/ci/node-key-tests.txt`: the key scan flags its `child_process` import.
- So the suggestion is **withdrawn**. The regression now lives in its own file, and `centre.test.mjs` is restored byte for byte to `ed665b84`.

**The new pure file: `workstreams/14-central-tower/game/centre-provenance.test.mjs`.**
- **Imports:** `node:test`, `node:assert/strict`, `./centre.mjs`, and nothing else. Its own `STATUS` helper builds hand-made status values.
- **Four tests:**
  - `{v:1}` alone;
  - sixteen missing or mistyped fold fields, on one read or both;
  - `events` above u64::MAX, with u64::MAX itself accepted;
  - the normal cases (still, moving, `lastSlot` moved, zero, one read, no status).
- **Written, not run.**

**Removed from the regression, kept here as a static observation.** ⑮'s adapter (`workstreams/15-coop-outcomes/src/adapters/ws14-centre.mjs:38`) maps `provenance.stable === true` to `'snapshot'` and anything else to `'between'`, or to `'source_unknown'` when `from` is null. So `stable: null` reaches ⑮ as "between", never "snapshot". **⑮ is not connected to a real consumer:** only its own contract test uses `readCentreFacts`.

**Fix: `events` above u64::MAX.**
- The canonical-digits check accepted any length, so a string above u64::MAX, equal on both reads, would have counted as a fold position and could give `stable: true`.
- `events` must now also be at most 20 characters and at most `18446744073709551615` (the BigInt comparison runs only after the digit and length checks, so it cannot throw).
- Same missing/invalid scope: such a read is `stable: null`.
- `foldedThrough` and `lastSlot` are JSON numbers: a value above 2^53 is not a safe integer and is already `null` (fail-closed).

### Pre-run audit of the new file (read-only)

| Item | Finding |
|---|---|
| Import closure | `centre-provenance.test.mjs` → `node:test`, `node:assert/strict`, `./centre.mjs` → `../proto/geometry.mjs` (no imports of its own). No package, `node_modules` or other workstream |
| Top-level code | `centre.mjs` and `geometry.mjs`: declarations only (`import`, `const`, functions, exports), nothing executed at load. The new file: imports, two `const` helpers, and `test(...)` calls |
| I/O | No `fs`, `fetch`, `process`, `child_process`, `net` or `http` in any of the three files |
| Keys | Nothing that `scripts/ci/scan-node-key-tests.mjs` flags (`PAT`: key and sign APIs; `UNFOLLOWED`: `child_process`, `worker_threads`, `new Function`, dynamic `import()`), so it needs no entry in `node-key-tests.txt`. The lists are not changed |
| Writes, network, world | None: pure functions on in-memory objects |
| Relation to refused work | It does not use the walls, muster, G or runner sources, or any `web-frontier` dependency, and it is not a substitute for any refused run |
| A candidate command (for the coordinator; not run) | `node --test workstreams/14-central-tower/game/centre-provenance.test.mjs`. Node's version and environment were not checked here |

**Unchanged:** the formal specification, permissions and rewards; the ⑨/⑩ branches; the candidate and canonical tree; the 25 deleted media files.
