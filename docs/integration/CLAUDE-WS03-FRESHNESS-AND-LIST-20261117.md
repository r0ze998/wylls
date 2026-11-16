# ③ MCP: plan freshness from prepare to send (no gap found) and list_operations' unknown results (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, sixth commit on `9275e9d4`, built with a temporary git index (no branch
switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched).

**Static, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed; the two
guard-refused frontier tests were not run in any form. preflight/http/auth/gateway/herald not edited.

## 1. Plan freshness, prepare → confirm → send (read; no change)

`server.mjs` `send` (9275e9d4, around lines 161-230), in order:

| Case | Answer | Recovery |
|---|---|---|
| the owner's world cannot be read | the read's refusal (e.g. `HeraldUnavailable`, retryable): nothing sent | read again |
| unknown plan / another connection's | `PlanUnknown` | prepare_caravan first |
| plan already used | `PlanUsed` + the operation that used it | follow that operation |
| plan past 5 min (`expiresAt` returned at prepare) | `PlanExpired` | prepare again |
| another world context | `PlanStale` (+ contexts) | prepare again |
| caravan number or village moved | `PlanStale` | prepare again |
| policy / mode changed since the plan | the relay refuses (`StalePolicy` / `StaleMode`: the plan carries its versions) | read village_status again and prepare again (`ports.mjs` RECOVERY) |
| the same requestId again | the same operation, never a second send (`NotResent` when the wallet cannot say) | follow it |

The caravan-number check reads `v.citizen?.caravans ?? -1`; a null Citizen cannot reach it: `/h/me` lists holdings only
when it has the Citizen (`frontier-node/crates/herald/src/views.rs` `me_json`), so `game.view` refuses with `NoVillage`
first. No automatic re-send and no skipped confirmation exist on this path. **No gap found; nothing changed.**

## 2. list_operations told result-unknown operations as "accepted" (fixed)

- `list_operations` (picking up after a reconnect) returned `state`, `outcome`, dates and the plan summary from the store
  — not read again, and without `hold` — so a held / uncertain operation showed only as `accepted`, which a consumer
  reads as "sent" (08 state table: accepted also covers an unknown result). Its description promised the "current
  state".
- Now each operation also carries `hold` (code or null) and `resultUnknown` (`ports.mjs resultUnknown`, the predicate
  `receiptOf` uses, now shared); the description says "last recorded state" and that `get_operation_status` reads one
  again now. States, holds, tracking, retries and authorization unchanged.
- Pins read on paper: `archive.test.mjs:52`, `play.test.mjs:134,254`, `context.test.mjs:69`, `receipt-port.test.mjs:33`
  map named fields only — unchanged.

## Regression source (written, NOT run)

`mcp/test/list-result-unknown.test.mjs` L1–L4 (imports `ports.mjs` only; reads `server.mjs`, `tools.mjs` as text).

## Checks NOT run

The new test and every ③ test; no syntax check, import or guard scan.
