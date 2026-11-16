# ③ MCP: prepare → confirm → send → operation lookup, descriptions against the code (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, commit after `8037d496`, built with a temporary git index (no branch switch;
the worktree's checkout stays on the ⑤ branch, the owner's 25 deleted media untouched).

**Static, NOT run, NOT integrated; no ChatGPT or Claude Code connection, no device.** Nothing was executed (no test,
syntax check, import, scanner, server, world, browser or runner); the guard-refused frontier tests were not run in any
form. Scopes, signed limits, budget, signing, sending and retry rules are unchanged. `ports.mjs` (`receiptOf`, the
unknown/held/cancel receipt display, which main is working on) and `server.mjs` were read only.

## Compared

| Step | Description / instruction | Code (`server.mjs`, `ports.mjs`) | Verdict |
|---|---|---|---|
| prepare | `prepare_caravan`: "returns a planId … with a summary to show the person"; instructions: "show its confirm text" | prepare returns `planId`, `expiresAt`, `summary` (object), `cost` and `confirm` (the sentence to show) | **gap**: the description did not name `confirm`, the field the instructions point at — fixed |
| confirm | instructions: send only after the person says yes; the yes is not authority | `send_caravan` has `destructiveHint: true` (implementation fact); whether a client shows a confirmation is not verified | consistent; no claim that a client confirms |
| send | `send_caravan`: requestId is the retry key; never sent twice; new decision = new requestId + new plan | `send`: prior op → other planId/runId `IdempotencyConflict`; `requested` → consult the wallet, resend only if it holds nothing (`NotResent` otherwise); other states → `track`, never a resend; no prior op but used on another link → `RequestIdUsedOnAnotherConnection`; `PlanUnknown/Used/Expired/Stale` | consistent |
| lookup | `get_operation_status`: "requested, accepted (… not to be sent again) …" | `receiptOf`: `requested` with `unknownSince` (lost answer) → "not known yet … a retry may only reuse the same requestId" | **gap**: `requested` had no word on the lost-answer case — added |
| list | `list_operations`: resultUnknown → "not to be sent again" | `resultUnknown` is also true for `requested` + lost answer, where the same-requestId retry is the contract (`send` consults first) | **gap**: same over-breadth as 82e7c487's instruction — reworded: never a new plan or requestId; a lost-answer one only with its same requestId |
| accepted + hold | "not to be sent again" | a same-requestId `send` of an accepted op goes to `track`, never a resend | consistent, kept |

Left as found (not this change): the comment above `listOps` in `server.mjs` (~752) still says "not to be sent again"
for every result-unknown operation; it is a comment, not served text. Left for the owner of `server.mjs` / main's
receipt-display work.

## Change (`mcp/src/tools.mjs` descriptions only)

- `prepare_caravan`: "… a planId valid for 5 minutes, a summary, and confirm: the text to show the person before send_caravan."
- `get_operation_status`: "requested (not sent yet, or an attempt whose answer was lost: next says the result is not
  known and only the same requestId may be retried), accepted …" — the rest unchanged.
- `list_operations`: "… not delivered, not failed; never prepared or sent again as a new plan or requestId (one requested
  with a lost answer may be retried only with its same requestId: get_operation_status says so)."
- `SERVER_INSTRUCTIONS` unchanged (500 characters).

## Regression source (written, NOT run)

`mcp/test/instructions-flow.test.mjs` I5 added (I1–I4 unchanged). Paper check only (a Python regex over the new file
text, no product code): I1–I5 match; the existing pins `list-result-unknown.test.mjs` L4 and
`unknown-result-display.test.mjs` D5 still match.

## Independent regression candidates: dependencies and side effects (static audit, not run)

| File | Imports | Reads | Side effects |
|---|---|---|---|
| `mcp/test/instructions-flow.test.mjs` | node:test, node:assert/strict, node:fs | `../src/tools.mjs` as text (not imported: it imports `auth.mjs`) | none: no network, child process, key, write, timer |
| `mcp/test/list-result-unknown.test.mjs` | same + `../src/ports.mjs` | `server.mjs`, `tools.mjs` as text | none (`ports.mjs` imports nothing) |
| `mcp/test/unknown-result-display.test.mjs` | same + `../src/ports.mjs` | `tools.mjs` as text | none |

Guarded path when runs are allowed: `scripts/ci/node-keyfree.sh workstreams/03-composability/mcp 'test/<file>'`; its
`--check` step refused earlier in this tree (exit 5, stale review) — not this lane's to change.

## Checks NOT run

These tests, `protocol-auth.test.mjs` and every ③ test; no syntax check, import or guard scan. No client's
confirmation UI was seen.
