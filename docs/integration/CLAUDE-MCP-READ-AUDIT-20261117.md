# What a user's MCP client can read of their village today (2026-11-17, static audit)

**Branch:** `claude/gateway-mcp-read-display-20261117`, cut from candidate d16048aa.

**Never run:** no test, server, relay, herald, RPC or world.

**Not touched:**
- `workstreams/03-composability/mcp/*`: another owner's (lane D);
- the candidate, other branches, the deleted media in the worktree.

**The intent this is measured against** (the owner's): a user connects MCP from their own ChatGPT and plays. In ③'s flow, that is: see my village → find what I am short of → prepare a caravan → confirm and send → see it arrive or fail.

**Where this file sits:** `permutation-gateway/mcp/agent-mcp.mjs` is the **agent wallet's** MCP entry. It acts for one agent within its owner's policy, with a capability token, a prepaid test-USDC budget and on-chain delegation. It is not ③'s user MCP entry (`03-composability/mcp`), and neither is a resident's entry. Nothing here changes authentication, policy, budget, delegation, sending or `agent_act`.

## What reaches the MCP user (read only)

| Need in the flow | Tool → source | Reaches the user? |
|---|---|---|
| my village | `agent_view` → relay `GET /f/agent?id=` → `gateway.view`: `village: [p, q, site]`, the citizen address, mode, policy, budget, balances, history, delegation, quota | **coordinates only** |
| what is in it (stores, production, cap, queue) | none. `gateway.view` has no stores. The relay decodes a holding only inside the operator runner (`AgentObserver` / `villageState`, `src/frontier/server.mjs:164`), on no route | **no** |
| what I am short of | none (needs the stores and the item's cost; the runner's `affordable(choice, state)` exists, also only inside the runner) | **no** |
| the world around it | `world_read` → herald `/h/season`, `/h/province/{p},{q}/latest` (JSON: `views::province_latest`) | yes, as the herald writes it |
| the holding's account bytes | herald `/h/holding/{P},{Q},{site}.json` (conquest seasons only; 404 for an M1 season), or `/h/me/{wallet}` `holdings[].bytes_b64` | **not offered by any tool** |

**So:** step 1 of the flow (see my village) reaches the user only as coordinates, and step 2 (what I am short of) does not reach them at all. Nothing is misread there; the information is simply absent.

## Fixed: a misdisplay in the four reads

**The defect:** `agent-mcp.mjs`'s `http()` turns a body that is not JSON into `json: null`. For a 200 answer, `agent_view`, `agent_terms`, `agent_whoami` and `world_read` then returned `ok(null)`: a **successful** result whose content is `null`.
- **When it happens:** a misconfigured relay or herald URL, a proxy's HTML page, or an empty body.
- **What it does:** the user's AI read "null" as the agent's view or the world record.

**The fix:** a 200 that is not a JSON object is now `RelayError` (or `HeraldError` for `world_read`): "answered HTTP 200 without a JSON object".
- A JSON object passes through unchanged, as before.
- `agent_act`, the tool list, the schemas, the capability handling, and every authentication and budget path are unchanged.

**Tests (written, not run):** `permutation-gateway/test/agent-mcp-read-not-json.test.mjs`, 3 cases.
- Six non-object bodies (HTML, empty, `null`, an array, a string, a number) give an error for all five read calls. The capability never comes back, and only the usual requests are asked.
- A JSON object passes through unchanged.
- `agent_act` and the tool list are unchanged (pinned as text).

**What running it would touch:** the file imports only `mcp/agent-mcp.mjs` (Node's `readline` and `url`) and a fake `fetch`. It does not import `@solana/web3.js` or the gateway's fixtures (the existing `agent-wallet-mcp.test.mjs` imports `@solana/web3.js`, which here would resolve to an unaudited tree in the home directory). It is not one of the refused tests (`web-frontier-build-walls-items`, `web-frontier-muster-province-full`), nor a runner or a world.

## Candidates (new tools or contracts: not adopted)

To give the MCP user step 1 and step 2:
1. **A read of the agent's own village state**, for example a `village_read` tool, or a `world_read` `what: "village"`. It reads the herald's `/h/holding/{P},{Q},{site}.json` for the agent's own `village` (from `agent_view`), decodes it with the client codec (`decodeAccount`), and projects it with the runner's existing `villageState` (S1 names, whole units, projected to `latestUnix` as the owner's page does).
   - This is a **new tool or schema** (a public MCP contract) and needs a decision.
   - It works only in conquest seasons, where `/h/holding` exists; an M1 season would need `/h/me` instead, which is per wallet, not per agent.
2. **What the village lacks for an action:** the runner's `affordable(choice, state, catalog)` over that state.
   - Informational only (the program decides). Also a new tool or contract.
3. **Where these go:** either in this agent MCP (an agent's owner's village), or in ③'s user MCP (`03-composability/mcp`, lane D's). Which one is ③'s and the owner's choice. A user MCP that reads the user's own village by wallet would use `/h/me/{wallet}`.

Code existing for any of these is not a live ChatGPT connection: none of it has been run against a real relay, herald or client.
