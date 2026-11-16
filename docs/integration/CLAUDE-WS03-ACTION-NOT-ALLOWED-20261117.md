# ③ MCP: ActionNotAllowed advice follows the relay's message, not an old patch-0005 assumption (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, second commit on `f1063294`. Built from that commit's tree with a temporary
git index (no branch switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched).

**Static change, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed (no test old
or new, syntax check, import, scanner, server, world, browser or runner); the two guard-refused frontier tests were not
run in any form. The relay (`permutation-gateway`) was read only.

## Source facts

`permutation-gateway/src/frontier/agent` at the candidate (read only):

| Message | Where | What it means |
|---|---|---|
| `<name> is not allowed for this agent` | `policy.mjs:49-52` `checkAllowed` | the policy does not allow it — and also any action not in `AGENT_ACTIONS` (a relay without patch 0005 has no SendCaravan there: the same message) |
| `SendCaravan exists in S1 seasons only` | `gateway.mjs:118` | the season is not S1; no policy change helps |
| `<name> is not an action an agent sends` | `gateway.mjs:130` | the relay's action table has no SendCaravan (an older relay); no policy change helps |

The candidate's relay has the transport group (`contract.mjs:37` `transport: ['SendCaravan']`, `gateway.mjs:115-119`).
③ stores the relay's message on the failed operation (`server.mjs` `definite(op, link, code, res.error?.message …)`).

## Before

`ports.mjs` `RECOVERY.ActionNotAllowed`: "…until patch 0005 is in the relay, SendCaravan is not an agent action at all"
for every ActionNotAllowed, and `budget-port.mjs` boundary: "(and the relay needs patch 0005)" — an unconditional claim
about the relay, and a policy-only remedy also for the season and old-relay causes.

## After (③ only)

- `ports.mjs actionNotAllowedNext(message)`: the policy message → allow the transport group, noting a relay without
  patch 0005 has none to allow; the season message → a policy change does not help; the not-an-agent-action message →
  this relay does not take SendCaravan from an agent, a policy change does not help; anything else → the generic advice
  naming the three causes and pointing at `error.message`. `receiptOf` uses it for a failed ActionNotAllowed.
- `budget-port.mjs` boundary `next` for ActionNotAllowed names the three causes; `by`/`kind`/`retrySame` unchanged.
- Unchanged: the prepare warning (`server.mjs:135`, already conditional: "until the owner allows the transport group (and
  the relay has patch 0005)"), authorization, sending, costs, states.

## Tests read on paper

- `play.test.mjs:91-101` (the old-relay scenario, skipped where the gateway tree has 0005): `warnings` still mention
  patch 0005 (unchanged warning); `next` matches `/patch 0005/` for both messages an older relay can give, and for any
  other wording through the generic advice. No test string updated.
- `budget-port.test.mjs:37` checks `by`/`kind` only.

## Regression source (written, NOT run)

`mcp/test/action-not-allowed-advice.test.mjs` A1–A6. Imports `ports.mjs` and `budget-port.mjs` (no imports in either).

## Checks NOT run

The new test, `play.test.mjs`, `budget-port.test.mjs` and every ③ test; no syntax check, import or guard scan.
