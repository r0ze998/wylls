# ③ MCP: per-operation recovery for every way an operation can end (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, eighth commit on `ce24417f`, built with a temporary git index (no branch
switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched).

**Static, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed; the two
guard-refused frontier tests were not run in any form.

## Review (ce24417f)

Codes the server ends an operation with itself (`definite(op, link, '<Code>', …)` in `server.mjs`) and the advice
`receiptOf` gives (`RECOVERY[code]`, else "prepare again"):

| Code | Where / meaning | Advice before | Verdict |
|---|---|---|---|
| GrantRevoked | the connection was revoked | its own | right |
| TransactionFailed | failed at finalized | its own | right |
| NotLanded | proven never to land | prepare again | right |
| ContextChanged (definite) | ended in an old world context | prepare again | right |
| **DuplicateOfOperation** | `resume` ~356-358: the same transaction was sent by another operation of this server, which carries the effect | prepare again | **wrong: a second caravan** |
| **RunConflict** | `resume` ~316: ④'s registry has the key under another run, nothing sent | prepare again | **vague** (the plan is used; the same requestId would conflict) |

Terminal display otherwise: `completed` + `delivered` → no next step, `arrival.quantity` says whether the amount is known
(unverified); `lost` / `taken` / `burned` → "nothing can be recovered for this caravan"; failed relay codes → their
`RECOVERY` entries (ActionNotAllowed by message, commit `5c7fe63b`). No other change needed.

## The change (③ `ports.mjs` only)

- `RECOVERY.DuplicateOfOperation`: follow the other operation (named in `error.message`) with get_operation_status; do
  not prepare again for this.
- `RECOVERY.RunConflict`: nothing was sent; send again with that run's id, or prepare again with a new requestId for a new
  decision.
- No state, retry, send, authorization or cost change.

## Regression source (written, NOT run)

`mcp/test/recovery-codes.test.mjs` K1–K3: every literal definite code in `server.mjs` (read as text) has advice or is
one of the two right fallbacks; the two new texts. Imports `ports.mjs` only.

## Checks NOT run

The new test and every ③ test; no syntax check, import or guard scan.
