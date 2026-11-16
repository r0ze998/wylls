# ③ MCP: the ChatGPT caravan flow — evidence by layer, wiring, and what is left (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117` at `f2dc4de6` (this report is the next commit; no code change). Static
reading only: nothing was run (no test, syntax check, import, scanner, server, world, browser or runner); no account,
key, tunnel, publication or send. `receipt-port.mjs` and its tests, preflight/http/auth/gateway were read only.

## Real call path (non-test)

`bin/wylls-mcp.mjs` → `Game({relay, herald})` → `Auth({issuer, store, sealer, game, …})` (exits unless
`WYLLS_MCP_TEST_AS=1`: only the local test authorization server is implemented) → `receiptPortFor(WYLLS_MCP_RECEIPT_PORT
?? 'local')` (`local` | `ws04-mapped`, both MOCK; ④'s ledger adapter absent by design) → optional ④ act registry through
④'s own `clients/acts.mjs` (`WYLLS_MCP_WS04_*`) → `createWyllsMcp({auth, game, store, log, receipts, acts})` — `grants`
is not passed, so the default `MockGrantPort` (② MOCK limits) is used → `http.mjs` serves `/mcp`, the OAuth routes and
the owner's view (`GET /owner`, `POST /owner/statement`, `POST /owner/operations`, `http.mjs:193-206`).
The agent budget shown is ⑤'s real one read from the relay (`budget-port.mjs budgetOf`); MOCKs are labelled in output.

## Evidence by layer

| Step | Code (this branch) | Local run (③'s own record, `11-claude-chatgpt.ja.md` §2) | External HTTPS + OAuth | ChatGPT device |
|---|---|---|---|---|
| connection | `get_connection` | run on a real chain (earlier ③ runs; not re-run) | not done | not checked |
| 1 village | `get_village_status` (feed marked: `caravanFeed`) | same | not done | not checked |
| 2 shortfall | `check_resource_shortfall` + `storehouseCoverage` (6779bb34) | same (the coverage field: not run) | not done | not checked |
| 3 prepare | `prepare_caravan` (unread storehouse → Unknown c48f0b4f; road read failures 9275e9d4) | same (the new refusals: not run) | not done | not checked |
| 4 confirm | `destructiveHint: true`; the chat's yes is not authority (07) | — | not done | the dialog not seen |
| 5 send | `send_caravan` (planId, requestId; relay has patch 0005; ActionNotAllowed advice 5c7fe63b) | same | not done | not checked |
| 6 result | `get_operation_status` / `list_operations` (unknown by state ce24417f; list marks df5f9bcd; recovery f2dc4de6) | same (the new texts: not run) | not done | not checked |

"Run on a real chain" is ③'s earlier record, not this session's; this session ran nothing.

## Wiring gaps checked

| Item | State | Kind |
|---|---|---|
| owner's view routes named in recovery texts | served | ok |
| ② signed limits | `MockGrantPort` (MOCK) | ② contract not adopted — not implemented here |
| receipts | MOCK ports; ④ ledger adapter refused by design | ④ contract — not adopted |
| production authorization server / CIMD | not implemented (test AS only) | auth (read only here) + an owner/ops decision |
| public HTTPS / tunnel, ChatGPT custom connector | not done | the owner's account and settings |
| push notifications (MCP events) | not implemented (polling) | not an adopted requirement |
No body wiring gap inside adopted contracts was found that this lane can implement.

## Ports-only regression candidates (static audit, not run)

| File (at f2dc4de6) | Imports | Reads | Key-API pattern (`node-keyfree.sh pat`) | Listed in node-key-tests.txt |
|---|---|---|---|---|
| `mcp/test/unknown-result-display.test.mjs` | node:test, node:assert/strict, node:fs, ../src/ports.mjs | ../src/tools.mjs | 0 | no |
| `mcp/test/list-result-unknown.test.mjs` | same | ../src/server.mjs, ../src/tools.mjs | 0 | no |
| `mcp/test/recovery-codes.test.mjs` | same | ../src/server.mjs | 0 | no |
| `mcp/test/action-not-allowed-advice.test.mjs` | node:test, node:assert/strict, ../src/ports.mjs, ../src/budget-port.mjs | — | 0 | no |

`ports.mjs` and `budget-port.mjs` import nothing. No network, child process, key, write or large file. Guarded path:
`scripts/ci/node-keyfree.sh workstreams/03-composability/mcp 'test/<file>'` (runs `scan-node-key-tests.mjs --check`
first — in this tree it refused earlier with exit 5, stale review — then `--covers`, then `node --import
scripts/ci/no-keys-guard.mjs --test`). Not run here; a run needs the guard's check to pass, which is not this lane's to
change.

## Decisions left (not this lane's)

Production authorization server; public endpoint and connector in the owner's ChatGPT; ② and ④ contracts replacing the
MOCK ports; `get_run_status` cross-sender visibility; whether ⑤'s stop should switch the relay to manual.
