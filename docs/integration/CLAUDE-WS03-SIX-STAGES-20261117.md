# ③ MCP: the owner's six stages against the aggregate, an update of `ef2ae7a8` (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `51daba36`. Read with `git show`, `git grep` and `git cat-file` only.

**Not done:** no test, import, syntax check, server start, HTTP, RPC, authentication, bind, signing, money, account action or secret read.

**What it updates:** `CLAUDE-WS03-REAL-CONNECTION-BLOCKERS-20261117.md` (`ef2ae7a8`). The client is **ChatGPT** (the owner's choice), so the client question is closed.

**What it follows:** the existing real-device procedure, which already exists and is not repeated here: `10-handoff.ja.md` §5.3 steps 1–7, and `12-device-runbook.ja.md` (approvals A1–A6, B1–B4).

## Corrections to `ef2ae7a8`

1. **A2 was too strong** ("a public HTTPS origin"). The adopted documents give **Secure MCP Tunnel** as the recommended route: ChatGPT connects without the server being published (`10-handoff.ja.md:293`, `:315`; `11-claude-chatgpt.ja.md:32`). Public HTTPS is the alternative. **Whether a tunnel is set up is not checked here.**
2. **A3 (which client) is closed:** ChatGPT.
3. **A8 is not a blocker.** These are optional follow-ups:
   - whether an id-less `tools/call` should run;
   - partial lists;
   - absolute-form request targets;
   - full 2025-11-25 conformance;
   - requiring and remembering the session id.

   A client that follows the specification does not depend on any of them.
4. **B1 and B2 are done:** the `/docs` metadata link was removed (`3c8729bc`), and the bad-target guard is taken in (`0fe84f1e`). Both are in `51daba36`.

## In the aggregate now (`51daba36`), from this lane

| Fix | Tip |
|---|---|
| ④ registry settings: all three or none | `68a512fa` |
| store: torn tail and short writes | `51dddcaf` |
| notifications get no response | `d590b3d9` |
| bad request targets get `400` | `0fe84f1e` |
| no `/docs` in the metadata | `3c8729bc` |
| request id type | `e111e339` |
| `initialize` params | `0f2e5b57` |
| session id only on success | `26978f00` |

**Checked:** each tip's regression file or helper is present at `51daba36` (`git cat-file -e`).

## The six stages

| # | Stage | Code (aggregate) | Verified by a run | Not verified / what it still needs |
|---|---|---|---|---|
| 1 | **ChatGPT connects to the MCP server** | `src/http.mjs` (MCP endpoint, OAuth routes, consent page), `src/auth.mjs` (DCR, PKCE, wallet-signed link, capability), `src/server.mjs` (`initialize`, `tools/list`), `bin/wylls-mcp.mjs` | preflight against a **fake** server, 13/13; launcher settings helper, 4/4 | a real ChatGPT custom MCP connection; the consent page signed in a real browser wallet; the route (tunnel); the running server |
| 2 | **The village** (`get_village_status`) | `src/game.mjs` (the relay's `/f/agent`, the herald's `/h/me` and holdings), `src/tools.mjs` | — (the tests that import `game.mjs` load the refused group G's modules, and stay held) | a running relay (agent wallet on) and herald for a world |
| 3 | **What is short** (`check_resource_shortfall`) | `Game.shortfall` (Lane C's fixes in the aggregate) | — (same reason) | stage 2's data |
| 4 | **Prepare** (`prepare_caravan`, with its confirmation text) | `src/server.mjs` `prepare`, `src/tools.mjs` | — | stage 2's data; ChatGPT showing the confirmation (`10` §5.3 step 6) |
| 5 | **Send after the owner's yes** (`send_caravan`) | `send`/`resume` (grant, plan, idempotency, `requestId` guards; write-ahead save) | ports and budget, **fake**, 15/15 (group P); store, 12/12 | the write scope consented in the wallet; the agent's capability (patch 0008 or rotation); a policy allowing transport; the budget; a relay that accepts SendCaravan from an agent (patch 0005, which Lane D reports the tree contains) |
| 6 | **Arrival or failure** (`get_operation_status`, `list_operations`) | `track` (chain, herald events, the wallet's fate), store archive | ports' unknown-result display, **fake** (in group P); store, 12/12 | real herald events; a caravan actually settling |

**Never verified for any stage:** a real client session, a real OAuth flow, a running relay, herald or world, a real send or arrival.

## What is really still missing, and from whom

**Owner decisions or actions** (`10-handoff.ja.md` §5.3 numbering):

| Item | Owner's part | Status here |
|---|---|---|
| §5.3-1 | a ChatGPT account or workspace that can create a custom MCP server (plan and role) | not confirmed |
| §5.3-2 | start the local stack (test USDC, the patched relay, the herald) and the MCP server on a verification machine; this lane does not start worlds or runners | not done |
| §5.3-3 | open the route: Secure MCP Tunnel (recommended) or a development tunnel, exposing only `/mcp` and the OAuth paths; set `WYLLS_MCP_ISSUER` to it | not done |
| — | a 32-byte `WYLLS_MCP_SEAL_KEY` for a persistent store, generated and kept by the owner (never in a repository or a chat) | not done |
| — | running with `WYLLS_MCP_TEST_AS=1`, the wallet-signed test authorization server (`12-device-runbook` A1–A6 limit it to test wallets, test data, 1–2 sends and an hour) | an approval |
| §5.3-4–5 | create the connection in ChatGPT (DCR), and sign the consent twice with a **test** wallet in a browser extension | not done |
| §5.3-6–7 | the conversation checks, then removal, revocation, rotation and stopping | not done |

**Implementable here:** nothing further found in this pass. The code-side gaps found earlier are in the aggregate.

## The shortest next step

- **The owner:** decide §5.3-1 to §5.3-3: a ChatGPT plan that allows a custom MCP server; who starts the local stack and MCP server, and on which machine; and Secure MCP Tunnel (or another tunnel). Then generate the seal key locally.
- **This lane, now:** nothing to run. Everything that would exercise stages 2–6 loads `game.mjs` (the refused group G's closure) or needs the running stack. Once the owner has started the server, the next step here is the preflight against it: `node bin/wylls-mcp-preflight.mjs <tunnel URL>/mcp chatgpt --allow-remote`. That needs its own approval at that time.
