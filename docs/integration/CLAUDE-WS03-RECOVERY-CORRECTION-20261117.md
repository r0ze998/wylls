# ③ MCP: correcting two recovery texts of 20061e81 against the real paths (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, ninth commit on `20061e81`, built with a temporary git index (no branch
switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched). `df5f9bcd` and the candidate are
not touched.

**Static, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed; the two
guard-refused frontier tests were not run in any form. `server.mjs` is identical to `df5f9bcd`'s (checked with `cmp`).

## 1. RunConflict — 20061e81 was wrong

- 20061e81 advised "send again with that runId, or prepare again with a new requestId". The first cannot be done:
  - `resume` (`server.mjs` ~314-316): registry `Conflict` with `attempts === 0` → `definite` → `failed`, `retryable:
    false` (`definite` ~262-266).
  - `send` with the same requestId and another runId → `IdempotencyConflict` ("the run is fixed for the requestId");
    with the same runId → the prior operation is terminal, `track` returns it, `answer` repeats `RunConflict`.
- Now: "nothing was sent and this request has ended: its run is fixed and it is not sent again (the same requestId
  returns this answer); error.message names the run that holds the key in workstream 04's registry. A new decision is a
  new plan: prepare_caravan, the person confirms, then send_caravan with a new requestId." K3 now asserts this and that
  the old text is gone.

## 2. DuplicateOfOperation — 20061e81 was incomplete

- The other operation is found among **all** of the server's operations (`resume` ~356: `Object.values(db.operations)`),
  but `get_operation_status` shows only this connection's (`opStatus`: `mineOp` → `UnknownOperation`). The owner's
  wallet-signed view (`POST /owner/operations`, ~692) shows them across connections.
- Now: follow that operation — get_operation_status on the connection that sent it, or the owner's view from any other;
  do not prepare again. K2 updated.

## 3. Reviewed, no change

| Answer | Path | Verdict |
|---|---|---|
| `RequestIdUsedOnAnotherConnection` | `send`, no prior op on this link; the owner's other links used it | names the operation; offers get_run_status on its run (other connections' acts appear only when a registry is configured) **or the owner's view** (always) — an executable path exists |
| `IdempotencyConflict` (another plan) | same requestId, other planId | "use a new requestId" — executable |
| `IdempotencyConflict` (another runId) | same requestId, other runId | returns the fixed `runId`; sending with it returns the same operation — executable |
| reconnect | a new owner consent creates a new link (`auth.mjs:302`); a refresh keeps it (`:322`) | `list_operations` / `get_operation_status` say "this connection's"; an earlier link's operation answers `UnknownOperation` "for this connection"; its requestId on send is `RequestIdUsedOnAnotherConnection` — consistent |
| route unknown / 404 | already in `9275e9d4` | not repeated |

## Regression source (written, NOT run)

`mcp/test/recovery-codes.test.mjs` (K2, K3 updated). Imports `ports.mjs` only.

## Checks NOT run

The test and every ③ test; no syntax check, import or guard scan.
