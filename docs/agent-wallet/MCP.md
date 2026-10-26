# The agent wallet's MCP connection (contract, 2026-10-23)

*Local test assets only. Nothing here connects to an outside service or account; an MCP client runs the server as its own subprocess.*

`permutation-gateway/mcp/agent-mcp.mjs` is an MCP server (stdio, JSON-RPC 2.0, one message per line) for **one** agent. It is one more caller of `POST /f/agent/action`: the same `AgentGateway.submit` checks as the owner's browser and the operator's runner. There is no MCP balance, payment path or permission of its own (DESIGN.md §3, §11).

## What it holds and what it can do

| | |
|---|---|
| Holds | the relay URL, the agent id, the agent's **capability token** (from the environment, never argv), optionally the herald URL |
| Never holds | the owner's wallet key, the agent's key, the custody key, the operator token |
| Can | read the agent's view and the relay's terms, read public world records, ask for an action inside the owner's policy |
| Cannot | create, fund, re-scope (policy), stop or start (mode), withdraw, rotate the token, settle a call, choose another agent or village |

## Tools

| Tool | Input | Answer |
|---|---|---|
| `agent_view` | — | the relay's view (`GET /f/agent?id=`): mode, `policy.version`, `modeEpoch`, allowed actions, budget, balance apart (available / reserved / unresolved / spent by category), history, `driver` |
| `agent_terms` | — | `GET /f/agent/terms`: inference price, the game price table (empty), network fees paid by the relay |
| `agent_act` | `requestId`, `policyVersion`, `modeEpoch`, `action {name, fields}`, `reason?` | the gateway's ActionResult; `isError` unless `status: sent` |
| `world_read` | `what: season` or `province` with `p, q` | the herald's public JSON |

## Rules a caller must follow (and what enforces them)

1. **Decide under what you read.** `agent_act` requires the `policyVersion` and `modeEpoch` read with `agent_view`. An owner's policy change or stop/restart since then is refused (`StalePolicy`, `StaleMode`, `AgentStopped`) by the gateway, also right before the bytes leave (`beforeSend`).
2. **One `requestId` per decision.** It becomes the idempotency key `mcp:<requestId>`. A retry with the same id returns the recorded result (`replayed: true`) and never sends twice, also after the MCP server restarts. A different action under a used id is `IdempotencyConflict`. `RelayUnreachable` (`retrySameRequestId: true`) means the relay was not reached: retry with the same id.
3. **The village is not the caller's to choose.** The server reads the agent's village from the view; extra fields in the arguments are ignored; the gateway refuses another village (`WrongVillage`).
4. **Refusals are answers, not faults.** `refused` = nothing sent, nothing charged. Codes are the stable `ERR` list (`contract.mjs`).
5. **The token is the owner's to revoke.** `rotate-capability` (owner command) makes the old token fail at once (`BadCapability`). Rate limits: 40 burst / 2 per second per address, 30 burst / 1 per second per agent.

What is enforced where is DESIGN.md §5.1: the budget, the allowed actions, the stop and the epochs are enforced by the operator's relay (trusted); the delegation (SetSession) and its expiry by the chain.

## Contract tests

`permutation-gateway/test/agent-wallet-mcp.test.mjs` (no network; the relay fixture of the gateway tests): no owner command is a tool; a send and its replays (same server, a fresh server, concurrent) send once; a conflicting reuse is refused; stopped, stale policy, stale epoch, not allowed, never delegable, unpaid price and a revoked delegation are each refused with nothing sent or charged; the token never appears in any answer; a rotated token and another agent's token are refused; an unreachable relay and bad arguments; the stdio framing.

## Running it by hand (local stack only)

```sh
WYLLS_AGENT_RELAY=http://127.0.0.1:41930 WYLLS_AGENT_ID=<id> WYLLS_AGENT_CAPABILITY=<token> \
WYLLS_AGENT_HERALD=http://127.0.0.1:41940 node permutation-gateway/mcp/agent-mcp.mjs
```

Registering it in an AI app (an MCP client configuration) is the user's step; nothing in this repository does it.
