# ③ MCP intake candidate: reverse review, and readVia from this server's own ④ client configuration (2026-11-17)

**Branch:** `claude/ws03-registry-intake-20261117`, second commit (after `36e5ceac`). It was built with a temporary git
index: no branch switch, no merge.

**Not touched:**
- main, the canonical candidate and other trees;
- `claude/ws03-chatgpt-flow-20261117`, `eaf2b97d` and ⑤'s branches;
- `17f4cca4`, which is not included;
- the owner's 25 deleted media, the 19 untracked files, and the worktree's HEAD and index.

**Static, NOT run, NOT integrated, no device.** Nothing was executed: no test, syntax check, import, scanner, server,
world, browser or runner, and no HTTP, RPC, auth, signing or send. The guard's stale-review refusal (exit 5) was not
retried or worked around.

## 1. Reverse review of 36e5ceac

| Case | Code path | Verdict |
|---|---|---|
| known Duplicate (`duplicateOf: P`) | `ws04CancelPhase` `duplicate` true → relay path, no own signature → `until: null` | ok |
| null Duplicate (`duplicateOf: null`) | `Object.hasOwn` → excluded | ok |
| unknown Duplicate (lost answer, no own signature) | `own === null` → registry `until` not used | ok |
| unqueryable after a success | `ws04ActAfterFailedRead`: `state`, `next`, `cancel`, `signature`, `at` kept; marker and time set | ok |
| first registration, then unqueryable | no `at` made up | ok |
| failure → success | the success drops `readError`, `readErrorAt`, `registryUnqueryable` | ok |
| another key | `Inconsistent` → failed read, prior kept; the message passes `scrub` | ok |
| **`get_run_status` re-read** | a non-final row re-read by `status` whose own state was `unqueryable` **replaced** the stored row (`unknown`/`hold` → `unqueryable`/`read-again`) | **inconsistent with `consult`** (option B). Corrected below. |

## 2. readVia: the configured path, wired to the two real consumers

Words as in main's `844fc371` and ⑤'s `fada02f9`: `'gateway'`, `'store-only'`, or `null` (not told). `readViaOf`
accepts only those two strings. The value comes from this server's configuration, **never from ④'s receipt**: a
receipt field of that name is ignored.

**`bin/wylls-mcp.mjs`:**
- `gatewayPort` is computed once (`Number(env…)` or `null`) and given to ④'s `createActsClient`.
- `actsReadVia = gatewayPort ? 'gateway' : 'store-only'`. That is the same truthiness ④'s
  `status` tests (`read && gatewayPort`), so a non-number or `0` is `store-only`. It is not decided by whether the
  variable is present. This loader never asks for ④'s bridge.

**`server.mjs`:**
- **Configuration:** `createWyllsMcp({…, actsReadVia = null})` → `statusVia = readViaOf(actsReadVia)`. The harness
  and other callers that do not pass it get `null`.
- **`register`:** `ws04Act.registeredVia = 'store-only'` (④'s register answers from its store).
- **`consult`, a status read that answered:** `readVia: statusVia`, stored beside `at`.
- **`consult`, a failed attempt:** `readErrorVia` is stored beside `readErrorAt`. It is `'store-only'` when
  registration failed, otherwise `statusVia`.
- **`consult`, an unqueryable receipt:** `readErrorVia: statusVia`. The kept `readVia` stays the earlier answering
  read's, so it is never shown as this attempt's. A stale `readErrorVia` is removed whenever a new failure has no path,
  and on every answering read.
- **`get_run_status`:**
  - list rows → `readVia: 'store-only'`; final rows likewise;
  - a non-final re-read → `{...status, readVia: statusVia}`;
  - a re-read that is `unqueryable` → **the stored row kept** with `readError: WS04_UNQUERYABLE`,
    `readErrorVia: statusVia` and ④'s `lastReadError`/`why` through `scrub`;
  - a thrown re-read → the stored row with `readError`, `readErrorVia`.
- **New note:** readVia is a path, not freshness, success or chain finality; `source` is who registered the act.

**`receipt-port.mjs`:**
- `readViaOf`;
- `ws04ActAfterRead(…, {readVia})`;
- `ws04ActAfterFailedRead(prev, err, at, readVia?)`. Without the fourth argument it behaves as before, except that
  a stale `readErrorVia` is dropped.

**Not changed:**
- send, grants, auth, owner checks, signing, cancellation rules;
- `applyFate`, `markDuplicate`, `recover`, `ws04CancelPhase`;
- ④'s receipt shape or contract; ⑤'s branches;
- RPC or reads: no new calls, and the same `status`/`list` calls as before.

## Regression source (written, NOT run)

- **`mcp/test/ws04-readvia.test.mjs`, new:**
  - V1: the two words only.
  - V2: beside `at`; never from the receipt.
  - V3: unqueryable and failed attempts go to `readErrorVia`; the next answer clears it; a first unqueryable makes up
    no `readVia` or `at`.
  - V4: no stale `readErrorVia`.
  - V5: bin, from the same port value.
  - V6: server wiring (source text).
  - **Paper check:** the V5/V6 patterns match the new sources (Python regex).
- **`mcp/test/ws04-act-read.test.mjs`:** R7's comparison now separates `readErrorVia`, which is `null` when not told.
  R1–R6, R8 and R9 hold on paper.

**Existing pins:** `keyfree/run.test.mjs:51,78,112,139` and `ws04-acts.test.mjs:65-71,123-128` read fields from
answering reads and are unaffected by the added fields. Nothing deep-compares a whole `ws04Act` or registry row.

**Test safety (dependencies read only):**
- **Imports:** `ws04-readvia` imports `node:test`, `node:assert/strict`, `node:fs`, and `receipt-port.mjs` (→
  `ports.mjs`, which imports nothing).
- **What it touches:** it reads `bin/wylls-mcp.mjs` and `server.mjs` as text and never imports them (the bin starts a
  server). No network, process, key, signature or write.

## Not verified

- No test (new or existing) was run; no syntax check, import or merge was done.
- ④'s runexec was not run, so how it actually emits unqueryable receipts was read from `acts.rs`, not observed.
- No ChatGPT or Claude Code client was used.
