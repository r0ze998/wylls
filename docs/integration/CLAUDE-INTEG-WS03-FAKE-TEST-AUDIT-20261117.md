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
