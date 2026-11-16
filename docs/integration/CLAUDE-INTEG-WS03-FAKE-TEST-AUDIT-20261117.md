# Static audit of ②'s six fake tests at the integration tip (2026-11-17)

**Scope:** the six new tests from `claude/ws03-chatgpt-flow-20261117` (`df5f9bcd`), read on the integration branch `claude/integ-mcp-preflight-ws03-flow-20261117` at `6666ae68b86df26ff9f3c6dc51fbecea170d7cd3`. Blobs were read with `git show` only.
- **Nothing was run.** No test, `node` import, syntax check, server, HTTP or OAuth request.
- **Nothing was checked out.** No source branch, the candidate, or D's in-progress game work was changed.
- **The import walk** is a static text walk: a Python script run with `-I`, sha256 `1ac7c576…6ac4`, over `git show` blobs. It reads `import … from`, bare `import '…'`, `export … from`, `import(…)` and `require(…)`.

**Verdict:**
- **Group P (3 tests): a run candidate**, under the plan below.
- **Group G (3 tests): held.** It loads 60 modules, 50 of which are also loaded by the refused `web-frontier-build-walls-items` test and 33 by the refused `web-frontier-muster-province-full` test. I cannot establish that running it is not a way around those refusals.

## Group P: ports and budget only (candidate)

| Test | sha256 at 6666ae68 | Imports |
|---|---|---|
| `test/action-not-allowed-advice.test.mjs` | `ff37162f…354a` | `node:test`, `node:assert/strict`, `src/ports.mjs`, `src/budget-port.mjs` |
| `test/list-result-unknown.test.mjs` | `8c8b66c7…e0c1` | `node:test`, `node:assert/strict`, `node:fs`, `src/ports.mjs` |
| `test/unknown-result-display.test.mjs` | `f84d93f4…478f` | `node:test`, `node:assert/strict`, `node:fs`, `src/ports.mjs` |

**Import closure:**
- **Sources:** `src/ports.mjs` (`08b29b5b…02d`) and `src/budget-port.mjs` (`3f00673f…8b2`). **Neither imports anything.**
- **External imports:** `node:` builtins only. There are no bare package names, so nothing resolves through an ancestor `node_modules`. That excludes the `@solana/web3.js` copy that put WS13 on hold, and any native addon.
- **Dynamic imports:** none.

**Top-level side effects:** none. Both modules hold only frozen constants, a class and pure functions. `Date.now` appears only as a default parameter of `MockGrantPort`, which these tests do not construct.

**Run-time effects:**
- **Inputs:** plain objects only. No `fetch`, crypto, subprocess, key, signing, network or file write.
- **File reads:** `readFileSync` reads `src/server.mjs` (`ee334312…eada`) and `src/tools.mjs` (`41bd1f1b…1cc5`) as text, as source pins. Neither file is imported.
- **The four pins** (L3, L4, D5, and the second part of L4) each occur exactly once in those blobs. That is a static match, not a test result.

**No unknown is turned into a known value (`resultUnknown` and `receiptOf`):**
- A terminal state stays terminal, even with a left-over hold.
- A held or uncertain non-terminal operation is never reported as on its way.
- A known send keeps its arrival guidance.
- Nothing is counted as 0 or as delivered.

## Group G: through `Game` (held)

| Test | Calls at run time |
|---|---|
| `place-unknown` | `Game.placeOf` (static) on plain views |
| `shortfall-coverage` | `Game.shortfall` (static) on plain views; reads `src/tools.mjs` as text |
| `road-unknown` | `new Game({relay: 'http://relay.invalid', herald: 'http://herald.invalid', fetch: <throws>})`, then `g.herald = {province: stub}`, then `g.plan` or `g.province` |

**`Game` construction and where the fakes take over:**
- **`fetch`:** the constructor takes `fetch` from its argument, so the throwing fake is in place before anything runs. `globalThis.fetch` is never the default here.
- **The real herald:** the constructor calls the real `createHerald({base, fetch: (...a) => f(...a)})`. At construction this only builds closures (an LRU and the pinned season); it makes no request.
- **The stub herald:** the test then replaces `g.herald` with its stub. `plan` and `province` use `this.herald` only.
- **Not reached:** `context()`, `json()`, `addressesFor` (address derivation), `placeData`/`cargoBytes` and the relay are not reached on any path these tests take. Every case throws before `fastestPath`'s result is used, or `fastestPath` runs on an empty list of lands.
- **Signing and keys:** no signing or key code is called.

**No unknown is turned into a known value:**
- `placeOf` answers `Unknown` only when the feed was not read and the id is a storehouse, and it still refuses.
- `shortfall` gives `partial` or `unavailable`, never counts an unread storehouse as 0, and leaves the village rows unchanged.
- `plan` answers `Unknown` (`ProvincesNotFound`), never `NoRoad`, when Provinces were not found; any other herald failure is `HeraldUnavailable`.

**Why it is still held (what loads, not what runs):**
- **Import closure: 60 modules.** These are `game.mjs` plus `permutation-server/web/frontier/*` (herald, faddr, fland, fcaravan, fplay, fchainio, seal, …), `web/sdk/*` (`solana-tx`, `sha256`, `base58`, `bytes`, `frontier/*` ABIs), `web/session.mjs`, `web/util.mjs`, `web/lang.mjs` and eleven `web/lang/en-*` files, including the `en-frontier*` set.
  - There are no bare packages, so nothing reaches `node_modules`, `@solana/web3.js` or a native addon.
  - No top-level `await` and no top-level request.
- **What runs at load:** table-filling loops (`base58`, `bytes`); the line in `lang.mjs` that detects the language, reading `localStorage` (in a `try`) and `navigator.language`; and a block guarded by `inBrowser`, which is false under Node.
- **Code that loads but is not called by these tests:**
  - `session.mjs`: WebCrypto Ed25519 key generation, signing and `localStorage`;
  - `fplay.mjs`: `signTransaction`, `key.sign`;
  - `seal.mjs`: `new Worker('./seal-worker.mjs')`, and a dynamic `import('./seal-worker.mjs')` that the walk did not follow;
  - `bytes.mjs`: `crypto.getRandomValues`;
  - `util.mjs`: `document`;
  - `fchainio.mjs` and `herald.mjs`: `globalThis.fetch` as a default.
- **Overlap with the refused tests:** 50 of the 60 modules are in the closure of the refused `permutation-gateway/test/web-frontier-build-walls-items.test.mjs` (102 modules), and 33 are in that of the refused `web-frontier-muster-province-full.test.mjs` (36). The purpose differs (③'s game logic, not building or mustering). Even so, running group G would load and run the same web-frontier code those refusals stopped. I cannot establish here that it is not a way around them.
- **Coverage is incomplete:** the walk did not follow `seal-worker.mjs`, and the top-level scan is a line-based heuristic, not a parser.

**To release group G, the owner must decide:** whether loading this shared web-frontier closure for ③'s own tests is allowed, apart from the walls-items and muster refusals. If yes, the next static step is a full audit of `seal-worker.mjs` and a parser-level top-level scan of all 60 modules.

## Plan for running group P (not run; for approval)

**Run tree:** an extraction of only the needed blobs, so that neither this worktree nor its 13 media deletions are touched and nothing else is unpacked.

```
R=<scratchpad>/ws03-p-run-6666ae68 ; mkdir "$R"
git archive 6666ae68 \
  workstreams/03-composability/mcp/test/action-not-allowed-advice.test.mjs \
  workstreams/03-composability/mcp/test/list-result-unknown.test.mjs \
  workstreams/03-composability/mcp/test/unknown-result-display.test.mjs \
  workstreams/03-composability/mcp/src/ports.mjs workstreams/03-composability/mcp/src/budget-port.mjs \
  workstreams/03-composability/mcp/src/server.mjs workstreams/03-composability/mcp/src/tools.mjs \
  workstreams/12-memory/tools/nokey-guard.mjs | tar -x -C "$R"
```

**Checks before the run:**
- the eight extracted files' sha256 equal the hashes above;
- no `node_modules` or `package.json` in `$R` or any of its ancestors (checked now: none up to `/`);
- `NODE_OPTIONS` unset; Node `/opt/homebrew/opt/node/bin/node` v23.11.0, sha256 `01ca46d5…b462`;
- free disk at or above 21 GiB (48 GiB now).

**The run** (in `$R`, once, these three files only):

```
/opt/homebrew/opt/node/bin/node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test \
  workstreams/03-composability/mcp/test/action-not-allowed-advice.test.mjs \
  workstreams/03-composability/mcp/test/list-result-unknown.test.mjs \
  workstreams/03-composability/mcp/test/unknown-result-display.test.mjs
```

**On a failure, a guard stop or a safety refusal:** stop, with no retry and no other route.

**Not included:** group G, `connect.test`, the refused walls-items and muster tests, any world, runner or WS13 held path, and any real ChatGPT connection.

## One run of group P (2026-11-17, blobs from 6666ae68)

Run once, in one batch, with the owner's approval. Nothing was retried, and group G was not run.

**Run tree:** a new, dedicated folder `<session scratchpad>/ws03-p-run-6666ae68`, 104 KiB. It was not deleted and is kept as evidence.
- It was created empty; the run would have stopped if it already existed.
- The eight blobs were extracted with `git archive 6666ae68 … | tar -x -k` (`-k`: no overwrite).

**Checked just before the run:**
- **Hashes:** all eight extracted files' sha256 equal the `6666ae68` blobs, the hashes in the audit above.
- **Run tree:** 8 files, 3 of them tests, and 0 symlinks. No `node_modules` or `package.json` in the tree or in any ancestor up to `/`.
- **Environment:** `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TEST_CONTEXT`, `LD_PRELOAD`, `LD_LIBRARY_PATH` and `DYLD_*` were unset.
  - `NODE_USE_SYSTEM_CA=1` was set in the shell. It only chooses the TLS certificate store and loads no code.
  - It was removed for this one process (`env -u NODE_USE_SYSTEM_CA`), so the run had no `NODE_*` variable at all.
- **Node:** `/opt/homebrew/opt/node/bin/node` v23.11.0, sha256 `01ca46d5dbf4e6fd39e2cca6154b24e867fae029512b125b1b108ecfbcc1b462`.
- **Guard:** `nokey-guard.mjs` sha256 `cf4518176289a45755a831140c85705093e9352825d3a6e80c75d91cf4f9862f`, the full known hash.
- **Disk and worktree:** 48 GiB free (floor 21). The working tree had the 13 media deletions unstaged, nothing else modified, the index empty, and HEAD `9fe9018e`.

**Command** (in the run tree):

```
env -u NODE_USE_SYSTEM_CA /opt/homebrew/opt/node/bin/node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test \
  workstreams/03-composability/mcp/test/action-not-allowed-advice.test.mjs \
  workstreams/03-composability/mcp/test/list-result-unknown.test.mjs \
  workstreams/03-composability/mcp/test/unknown-result-display.test.mjs
```

**Result: 15 tests, 15 passed**, 0 failed, 0 cancelled or skipped; exit 0; 47 ms.
- A1–A6: 6/6.
- L1–L4: 4/4.
- D1–D5: 5/5.
- No guard or safety refusal.
- The log is `docs/integration/logs/ws03-p-run-6666ae68.log`, 975 bytes, sha256 `7314ba4d…b94c`. It is the test runner's output plus the exit code.

**After the run:**
- **Processes:** no new `node` process; the set of PIDs before and after is equal.
- **Run tree:** still 8 files and 0 symlinks, with none newer than the extracted guard.
- **Disk and worktree:** 48 GiB free. The 13 media deletions, the empty index and HEAD `9fe9018e` are unchanged.
- **Branch tips:** the source branch ① and the candidate are unchanged. ② (`claude/ws03-chatgpt-flow-20261117`) has since moved to `ce24417f`; D is working on it. This integration and this run use only the fixed `df5f9bcd` content.
- **Not done:** a per-file hash recheck after the run was attempted in one command together with the group G trace below. A built-in safety check refused that command, and it was **not** run or retried.

**What this shows and does not show:**
- **Shows:** at `6666ae68`, `actionNotAllowedNext`, `receiptOf`, `resultUnknown` and `refusalOf` behave as the 15 cases state, and the three source pins in `server.mjs` and `tools.mjs` hold.
- **Does not show:** anything about group G, the MCP server running, the relay, or a real ChatGPT or Claude connection.

## Group G's open dependencies (static trace not done)

The static trace of what group G still lacks was refused by a built-in safety check and stopped, not retried. It covered `seal-worker.mjs`'s own closure and top-level code, and any `import.meta.url`, `new URL(…)`, `.wasm` or `WebAssembly` loads in the 60-module closure. Before group G can be considered, these remain open:
1. **The owner's decision** on loading the web-frontier closure it shares with the refused walls-items test (50 of 60 modules) and muster test (33 of 60).
2. **`seal-worker.mjs`:** its closure and top-level code (reached by `seal.mjs` through `new Worker(new URL(…))` and a dynamic `import()`).
3. **Load-time code:** a parser-level scan of all 60 modules, replacing the line heuristic.
4. **Resource loads:** a list of any loads by URL or of WebAssembly in the closure.

Group G's run approval is not extended by this report.
