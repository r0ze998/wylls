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

## ②'s later commits, read only: ce24417f, 20061e81, f2dc4de6 (2026-11-17, not integrated, not run)

On `claude/ws03-chatgpt-flow-20261117`, after the fixed `df5f9bcd` that this branch contains, there are three commits, ending at `f2dc4de6a3fcc538874ce2dfd68683f4f0a5e7d9`. D's session had stopped when this was read.

**The range in numbers:**
- **7 files:** `src/ports.mjs`; the tests `list-result-unknown` (M), `unknown-result-display` (M) and `recovery-codes` (A); three reports.
- **Unchanged:** `server.mjs`, `game.mjs`, `tools.mjs` and `receipt-port.mjs`.
- **Checks:** 0 paths shared with ①; `diff --check` clean; no secret patterns in added lines.
- **Test imports:** the three tests import only `node:test`, `node:assert/strict`, `node:fs` and `src/ports.mjs`. They read `server.mjs` or `tools.mjs` as text. This is the same class as group P.

**ce24417f: "result unknown" decided by state.** Checked against `server.mjs` at that commit:
- **`requested` + `unknownSince`:** set only on the transport-failure path (`r.transport`). There the state stays `requested`, with `RelayUnreachable`, and a retry with the same requestId is safe.
- **`accepted` + `uncertain`:** every `uncertain()` call, and the two direct writes, also step the state to `accepted`.
- **`processing`:** reached only on evidence that the caravan landed: its own signed record, finalized, or a landed transaction.
- **Never cleared:** neither `uncertain` nor `unknownSince` is ever cleared, so the old rule (`hold || uncertain`) called a landed caravan unknown.
- **Verdict:** the new rule matches these transitions. A hold still holds in any non-terminal state. A lost answer's advice keeps the same-requestId contract.

**Observation for D (not changed here):** `receipt-port.mjs` (④'s view) computes its own `held` from `op.uncertain` and does not use `resultUnknown`. After ce24417f the two disagree in two cases:
- **`processing` with `uncertain` history:** `resultUnknown` is false (on its way), but `held` is `Indeterminate`.
- **`requested` + `unknownSince` (a lost answer):** `resultUnknown` is true, but `held` is null. This case already disagreed before ce24417f.

Whether ④'s `Indeterminate` should follow the same rule is a decision for ③ and ④.

**20061e81 → f2dc4de6: recovery advice.** 20061e81's RunConflict advice ("send again with that runId") contradicted the fixed contract; f2dc4de6 corrects it. Checked against `server.mjs`:
- **RunConflict ends the operation:** before any attempt, it ends `failed` (`definite`, line 316).
- **Another runId is refused:** the same requestId under a different runId is `IdempotencyConflict` ("the run is fixed for the requestId", line 183).
- **The same runId:** returns the ended operation.

The corrected text ("this request has ended; a new decision is a new plan … a new requestId") matches. The DuplicateOfOperation text, which names the owner's view for another connection, is wording only.

**Candidate for intake (not done):** take `f2dc4de6` (`df5f9bcd..f2dc4de6`, 7 files) onto this branch.
- **Conflict:** none expected. The paths this branch changed since `df5f9bcd` are only `docs/integration/CLAUDE-INTEG-*` and `docs/integration/logs/`.
- **Evidence does not carry over:** the group P run (15/15) is for the `6666ae68` versions of `ports.mjs`, `list-result-unknown` and `unknown-result-display`, and all three change in this range. After intake, those files and the new `recovery-codes` are not run.
- **Next run:** one run of those four, the same way as group P (extracted blobs, Node 23, no-key guard), needs its own approval.

## Acceptance checklist: the six ③ MCP steps (2026-11-17)

**Basis:** `CLAUDE-WS03-CHATGPT-FLOW-20261117.md` (the 10/29 instruction's six steps).
- **✅** means a run passed, with the evidence named. **⏸** means held or not run. **⬜** means not checked on a device.
- **Not decided here:** no choice about permissions, publishing, the identity provider, authentication or plans is made in this checklist.

| Step | What has a passing run | Held or not run | Not checked on a device |
|---|---|---|---|
| Before 1: can a client connect | ✅ `preflight` library and command, 13/13 (fake `fetch`, loopback rules, no redirect, no credential in output), `5f67eb17` | — | ⬜ a real server; ⬜ ChatGPT or Claude connecting; ⬜ any approved deployment (`--allow-remote` never run) |
| 1 see my village (`get_village_status`) | — (no new test) | ⏸ ③'s existing tests not run in this round | ⬜ |
| 2 resources short (`check_resource_shortfall`) | — | ⏸ `shortfall-coverage` (group G, held: shared web-frontier closure) | ⬜ |
| 3 prepare (`prepare_caravan`) | — | ⏸ `place-unknown`, `road-unknown` (group G, held) | ⬜ |
| 4 confirm (`destructiveHint`) | — | — | ⬜ ChatGPT's confirmation dialog not seen |
| 5 send (`send_caravan`), refusal advice | ✅ ActionNotAllowed advice follows the relay's message, A1–A6, at `6666ae68` | ⏸ `recovery-codes` (f2dc4de6, not taken in, not run) | ⬜ |
| 6 arrived / failed / unknown (`get_operation_status`, `list_operations`) | ✅ unknown result not shown as on its way, `list_operations` carries `hold`/`resultUnknown`, L1–L4 and D1–D5, at `6666ae68` | ⏸ ce24417f's state rule (L1 cases changed; D6, D7) is not taken in and not run; `receipt-port`'s `held` disagrees (above) | ⬜ how ChatGPT shows `next` and `hold` |

**Still outside any run:**
- **The server:** the MCP server running, its HTTP/OAuth endpoint, the relay, the herald, a world, and a real send.
- **Connection prerequisites:** the identity provider, a tunnel or deployment, whether the wallet appears in the OAuth window, and the plan. These are owner decisions, listed in ①'s report.
