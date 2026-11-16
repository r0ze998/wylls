# Independent integration: MCP preflight ① + ③ ChatGPT flow ② (2026-11-17)

**What this is:** a new integration branch, `claude/integ-mcp-preflight-ws03-flow-20261117`. It takes two fixed branch tips onto their shared base, in the order ① then ②.

**What it is not:**
- It is not the canonical candidate.
- No source branch was changed. The canonical checkout was not changed either.
- No new test was run for this integration.
- No ChatGPT or Claude connection was made, and nothing was published.

## Inputs, rechecked just before the merge

| | Branch | Fixed tip | Commits from base | Files |
|---|---|---|---|---|
| base | — | `d16048aa76399124affebeb38f7fc4f447857d00` | — | — |
| ① | `claude/mcp-preflight-loopback-20261117` | `9fe9018e260d70ff869afff2de869ea31c1e7df0` | 9 | 5 |
| ② | `claude/ws03-chatgpt-flow-20261117` | `df5f9bcd48433b61850f3c1419d7b3a46e76f3a2` | 6 | 17 |

**Remote and base:**
- The remote branches equalled both fixed tips at the time of the check.
- `merge-base(base, tip)` is `d16048aa` for both, and `git diff --check base..tip` is clean for both.

**Path overlap between ① and ② is 0:**
- ① covers `src/preflight.mjs`, `bin/wylls-mcp-preflight.mjs`, two preflight tests, and its report.
- ② covers:
  - `src/{budget-port,game,ports,server,tools}.mjs`;
  - six new tests: `action-not-allowed-advice`, `list-result-unknown`, `place-unknown`, `road-unknown`, `shortfall-coverage`, `unknown-result-display`;
  - six reports, `CLAUDE-WS03-*-20261117.md`.

**Not the earlier refused work:**
- **Paths:** neither file list contains `land`, `en-frontier`, `walls`, `muster`, `runner`, `world` or `ws13` paths. That covers the refused C G1-generations land set and the D english-r3 en-frontier set.
- **Commits:** ②'s six commits are the result-unknown, ActionNotAllowed, shortfall-coverage, place-unknown, road-unknown and list_operations work. None of them is the earlier refused work.

**Dependencies:**
- No ② source file names `preflight`.
- ①'s two source files import only `node:url` and `../src/preflight.mjs`, and the library imports nothing.
- Neither side imports the other.

**Secrets and binaries:**
- **Secrets:** added lines on both sides were scanned for private-key blocks, `sk-…`, `ghp_…`, `AKIA…`, `xox[bp]-…`, `privateKey`, `secretKey`, `mnemonic`, and 80+ character base58 strings. There were no matches. The only credential-like text is ①'s made-up fixtures `zq1`, `zq2`, `zq9` and `hunter2`.
- **Binaries:** none on either side.

## How it was built (no checkout)

1. **Private index:** a separate index file in the session scratchpad (`GIT_INDEX_FILE`) was used throughout. The working tree, its index and its 13 unstaged media deletions were not touched (rechecked after: 13 D, nothing else, HEAD unchanged).
2. **Reading the trees:**
   - `git read-tree 9fe9018e` loaded ①'s tree.
   - ②'s 17 paths were added from `git ls-tree df5f9bcd` through `update-index --index-info`. All 17 are additions or modifications; there are no deletions.
3. **Writing the tree:** `git write-tree` gave tree `3092f0917727ba18eb56e996aaa6c2ec7f29fd53`.
   - Against ①, it differs in exactly ②'s 17 paths.
   - Against ②, it differs in exactly ①'s 5 paths.
   - `diff --check` from base is clean.
4. **The merge commit:** `git commit-tree` with parents ① then ② gave `e34f44bec7f683deedf44bbaa6af48cc3ec1cafd`.
5. **This report:** added as a second commit on top, through the same private index.

`git merge-tree` was not used, and nothing was checked out, restored, stashed or reset. Free disk was 48 GiB (floor 21).

## What has been verified, and what has not

- **① preflight:** `preflight-loopback.test.mjs` 8/8 and `preflight-cli.test.mjs` 5/5. Each file was run once at `5f67eb17` with Node 23 and the no-key guard. The run used a fake `fetch`, `print` and `warn` only, and the test files are unchanged at `9fe9018e`. No real server or connection was used.
- **② ③ ChatGPT flow:** its six new tests are **written, not run**. That holds both on ② and in this integration.
- **The integration itself:** **not run.** The paths are disjoint and neither side imports the other, but no combined test has been run.
- **No real ChatGPT or Claude connection** was made. What a real connection still lacks is listed in ①'s report: identity provider, tunnel or deployment, the wallet in the OAuth window, the plan, and the client itself.

## Next candidate (static, not done here): the dependency and side-effect audit of D's six fake tests

Before any run of ②'s tests is proposed, read statically:

- **Import closure:**
  - Three tests import only `node:test`, `node:assert/strict`, `node:fs`, and `src/ports.mjs` or `src/budget-port.mjs`. Neither of those modules imports anything.
  - Three tests import `src/game.mjs`. It imports six modules from `permutation-server/web/frontier/`: `herald`, `faddr`, `fland`, `resources`, `fcaravan` and `fplay`.
  - Their transitive closure has **not** been read. It must be traced to the end before a run, including whether anything reaches `@solana/web3.js` (the ancestor `node_modules` copy that held WS13) or a native addon.
- **Network:** `Game` defaults `fetch` to `globalThis.fetch` and `now` to `Date.now`. Check that every `new Game(` in the three tests passes a fake `relay`, `herald` and `fetch`, so that no default can make a request.
- **File reads:** three tests read `src/server.mjs` or `src/tools.mjs` as text, as source pins. They write nothing; this still needs to be confirmed for the rest of each file.
- **Then:** list the exact command (Node 23, `--import ./workstreams/12-memory/tools/nokey-guard.mjs`, the six files only) and the hashes, for approval.
