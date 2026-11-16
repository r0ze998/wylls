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

## ⑭ → ⑮: where the centre facts are actually read (static trace, 2026-11-17, at 48ea7162)

Nothing was run, imported or compiled for this section.

**The producer.** `workstreams/14-central-tower/game/centre-cli.mjs` is ⑭'s only non-test caller of `centreFacts`. It reads a herald (`--herald`, public GETs with `/h/status` before and after) or saved files (`--caravans`, `--structures`), and prints `wylls.ws14.centre-facts/1` to stdout. It writes no file.

**The reader.** ⑮'s only reader is `readCentreFacts` (`workstreams/15-coop-outcomes/src/adapters/ws14-centre.mjs`).

**Who calls it.**
- `readCentreFacts`: only `workstreams/15-coop-outcomes/test/contract-ws14-centre.test.mjs`.
- ⑮'s entry points (`bin/eval.mjs`, `bin/compare.mjs`, `play/play.mjs`, `play/serve.mjs`) import `evaluate`, `rulesets` and `contract`, but neither ⑭ adapter.
- Outside ⑭ and ⑮, nothing in the repository names `centre-facts` or `centreFacts`.
- The only cross-workstream caller of ⑮'s code is ④'s `tools/chain-flow/stages-cde.mjs`, and it reads the ④ adapter, not the centre one.

**What the adopted contracts allow.**
- ⑮'s `docs/08-peer-contracts.ja.md` §5f says the centre facts are reported only. They never become evaluator events, and no goal, award, score or prize reads them. The reader returns `counted: false`.
- ⑭'s `CONTRACT.ja.md` names no consumer other than ⑮.
- So `evaluate()` is not a valid place to connect them: that needs a rule saying what the centre is worth, and that rule is undecided.

**Candidates, and what stands in the way of each.**

| Candidate | What it would be | What stands in the way |
|---|---|---|
| 1. A ⑮ report command | A file-only command, `bin/centre.mjs <centre-facts.json>`, printing `readCentreFacts(doc)`. Within §5f ("report only") | No reader of that report is named. It would add an entry point, not fill a gap in an existing call path. It also inherits gap G1 below |
| 2. ⑮'s evaluator | Centre facts as events | Refused by §5f and by the undecided outcome rules, goals and prizes. Not done |
| 3. A player screen | A centre panel | The screen and its owner are not decided. It would touch `web-frontier` (refused routes) or ⑬ (main's area). Not done |
| 4. ⑫ memory or ⑬ citizens | A feed into their readers | Main's areas (⑫, ⑬). Not done |

**Conclusion.** No minimal slice can be connected under the existing permissions and contracts alone: the consumer of the report is undecided. Nothing was connected and no code was changed.

**Gap G1 (concrete; recorded, not changed).**
- `readCentreFacts` takes the producer's `provenance.stable === true` as `'snapshot'` without checking `before` and `after` itself.
- ⑮'s committed fixture `scenarios/fixtures/ws14-centre-88cf67c0.json` (output of ⑭ at 88cf67c0) has `still` with `events: 900`, a JSON number.
- The herald writes `events` as a decimal string (`frontier-node/crates/herald/src/server.rs:311`, `f.st.events.to_string()`). So the fixture's status is not in the herald's shape, although `gen-ws14-centre.mjs` describes its feed as written "in the herald's shape".
- At 48ea7162, `centreFacts` would give that same input `stable: null`, and ⑮ would report `'between'`. The fixture keeps the old `true`, and ⑮ reports `'snapshot'`.
- **The limited fix:** ⑮ re-checks the fold fields with the same rule as ⑭ (`foldedThrough` and `lastSlot` are safe non-negative integers, `events` is a canonical u64 decimal string) before saying `'snapshot'`, and reports anything else as `'between'` with a reason. No new status value is needed.
- **Why it was not applied:**
  - ⑮'s existing test (`contract-ws14-centre.test.mjs`, the first test) asserts `'snapshot'` for `O.still`. Applying the fix means either changing that existing expectation, or regenerating the fixture by running ⑭'s code. Both need the coordinator's decision, and the second needs a run.
  - The status is reported only (`counted: false`), so no score or prize depends on it.

### Final pre-run audit of `centre-provenance.test.mjs` (static, no run)

| Item | Finding |
|---|---|
| Hashes (sha256) | `centre-provenance.test.mjs` `2727430e…3617`, `centre.mjs` `7f2fa256…156e`, `proto/geometry.mjs` `7ed7c309…cebb` |
| Import closure | Unchanged: `node:test`, `node:assert/strict`, `./centre.mjs` → `../proto/geometry.mjs`. Only `centre.mjs:26` imports (`ringOf`); `geometry.mjs` imports nothing and has no dynamic `import()` |
| Package scope | No `package.json` at the repository root or in `workstreams/14-central-tower`. The files are ES modules by their `.mjs` extension, with no loader hooks, `imports` maps or `node_modules` |
| Node | CI pins Node 20 or 22 (`.github/workflows/ci.yml`). The `node` on the shell path here is Homebrew's `node@20`; the version was read from the path only, and `node` was not executed. The file uses only `node:test` default `test`, `assert.equal`, `notEqual`, `match` and BigInt, all present in Node 20. **Corrected (2026-11-17):** "Node 20" is wrong for the run that was made. The coordinator's run used Homebrew's `node`, which resolves to Node 23.11.0 (the symlink target, read directly). The `node@20` above is only the first `node` on this session's shell path |
| Environment | `NODE_OPTIONS`, `NODE_PATH` and `NODE_TEST_CONTEXT` are unset in this shell. No `.nvmrc` or `.node-version` |
| CI | No CI job runs ⑭'s tests. `centre.test.mjs` appears only in `scripts/ci/node-key-tests.txt` (the key-scan list). The new file needs no entry, and the lists are unchanged |
| Side effects | None at load or at run: no file, process, network, key, world or write. The behaviour is pure functions on hand-made objects |
| The candidate command (for the coordinator; not run) | `node --test workstreams/14-central-tower/game/centre-provenance.test.mjs` |

## G1 applied: ⑮ re-checks the fold position (branch `claude/lane-c-ws15-g1-provenance-20261117`, from 6d4e27fc)

Written, not run. Nothing was run, imported or compiled.

**The change** (`workstreams/15-coop-outcomes/src/adapters/ws14-centre.mjs`, sha256 `9ec318d3…1732`).
- `readCentreFacts` no longer takes `provenance.stable === true` on its word. It reports `'snapshot'` only when all of these hold:
  - `before` and `after` are objects;
  - `foldedThrough` and `lastSlot` are safe non-negative integers;
  - `events` is a canonical u64 decimal string, at most 20 characters and at most `18446744073709551615`;
  - all three fields are equal on both reads.
- These are the same checks as ⑭'s `provenanceOf`.
- Anything else stated stable is `'between'`, with the reason "… not taken as a snapshot".
- Unchanged:
  - `stable: false` or `null` still give `'between'` with the producer's `why`;
  - a missing source is still `'source_unknown'`;
  - the status words, `counted: false`, the counts, cargo, sightings and refusals.

**The fixture.** `scenarios/fixtures/ws14-centre-88cf67c0.json` is kept byte-identical as historical evidence, and was not regenerated.

**The existing test** (`test/contract-ws14-centre.test.mjs`, sha256 `fdff4f39…39bb2`).
- The first test's wrong expectation, `'snapshot'` for `O.still` (whose `events` is the number 900), is corrected to `'between'` with the reason check. Its title says why.
- No test was removed, and no other assertion was changed.

**The new pure regression** (`test/contract-ws14-centre-provenance.test.mjs`, sha256 `81ed3968…f9963`). It has five tests:
- a herald-shaped, equal pair is `'snapshot'`, including zero and u64::MAX;
- a missing read, `{v:1}`, and fifteen missing or mistyped fields on one or both reads are `'between'`;
- reads that differ in `events`, `lastSlot` or `foldedThrough` are `'between'`;
- `events` above u64::MAX is `'between'`;
- unchanged: `false` and `null` keep the producer's reason, and `from: null` is `'source_unknown'`.

**The ⑮ contract** (`docs/08-peer-contracts.ja.md` §5f) now states the re-check and the fixture's status.

**Static audit (no run)**

| Item | Finding |
|---|---|
| Import closure | New test → `node:test`, `node:assert/strict`, `../src/adapters/ws14-centre.mjs` → `./s1-chain.mjs` (sha256 `60c1d573…6eb4`, no imports). No fixture file, package or other workstream |
| Top-level code | Declarations only in `ws14-centre.mjs` and `s1-chain.mjs`; the test file has imports, two `const` helpers and `test(...)` calls |
| I/O, keys, network | No `fs`, `fetch`, `process`, `child_process`, `worker_threads`, dynamic `import()`, `new Function` or key or sign API in the closure. Nothing for the key scan to flag, so it needs no `node-key-tests.txt` entry; the lists are unchanged |
| The existing test | Reads its fixture with `readFileSync` (a read only), as before |
| Refused work | It touches no walls, muster, G, runner, `web-frontier` or world code, and it is not a substitute for any refused run |
| Unchanged | ⑭'s code; the formal specification, permissions, rewards and outcomes; the ⑨/⑩ branches; the candidate and canonical tree; the 25 deleted media files |
| Candidate commands (for the coordinator; not run) | `node --test workstreams/15-coop-outcomes/test/contract-ws14-centre-provenance.test.mjs`; the corrected existing file: `node --test workstreams/15-coop-outcomes/test/contract-ws14-centre.test.mjs` |

**Not complete.** ⑮ still has no real consumer of the centre facts: only its tests call `readCentreFacts`. This fix makes the reader fail-closed; it does not connect anything.

## Run record (the coordinator's run; Lane C ran nothing)

| Item | Result |
|---|---|
| Who and when | The coordinator, once, at `4cc361bc`, after reading the whole dependency closure and checking the environment, side effects, and that this is not the same as any refused test. Not to be rerun |
| Command | `node --test workstreams/14-central-tower/game/centre-provenance.test.mjs workstreams/15-coop-outcomes/test/contract-ws14-centre-provenance.test.mjs`, with Homebrew's `node` (Node 23.11.0) |
| Test files (sha256) | `centre-provenance.test.mjs` `2727430ea60960f2f875be0e47c67d53096b709f179083b1f40ac5828e793617`; `contract-ws14-centre-provenance.test.mjs` `81ed3968d8050a621d1d4e7e0bcf37cb420edb43131de810da666b6df85f9963` |
| Result | 9/9 pass (⑭ 4, ⑮ 5); fail 0, cancelled 0, skipped 0; exit 0; duration 51.678291 ms |
| Working tree before and after | Only the 25 deleted media files (unstaged `D`); nothing staged; 53,600,000 KiB free |

**What this does and does not show.**
- It shows that the pure functions pass: ⑭'s `provenanceOf` and ⑮'s `readCentreFacts` re-check.
- It is not a real world, a real consumer, or a completed integration.
- The corrected existing test (`workstreams/15-coop-outcomes/test/contract-ws14-centre.test.mjs`, the first test now expecting `'between'`) was **not** part of this run, and remains unrun.
