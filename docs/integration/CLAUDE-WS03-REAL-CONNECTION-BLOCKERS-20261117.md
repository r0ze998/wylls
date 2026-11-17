# ③ MCP: what still stands between the owner and a real ChatGPT/Claude session (2026-11-17)

**The flow in question:** the owner connects ChatGPT or Claude to this MCP server, then:
1. reads their village (`get_village_status`);
2. checks what is short (`check_resource_shortfall`);
3. prepares a caravan (`prepare_caravan`, which returns a confirmation text);
4. says yes, and the client sends (`send_caravan`);
5. follows it to arrival or failure (`get_operation_status`, `list_operations`).

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `2b70ba9b`. Read with `git show` and `git grep` only.

**Not done:**
- No test, import, syntax check, server start, bind, HTTP, RPC, key, signing or money.
- Not changed: the aggregate, canonical, Lane D's `listen` and Lane C's `game`/`tools`.

**What exists in code:**
- all five steps as tools, with OAuth 2.1 (PKCE, DCR, RFC 9728/8414/8707/9207) and the wallet-signed consent page;
- the preflight command (`bin/wylls-mcp-preflight.mjs`);
- fake-transport tests for each part.

**What has never happened:** a real client connected to a real server over a real relay. Every item below is either an owner decision or outside setup, unless marked **implementable**.

## A. Decisions and outside setup the owner must provide (not implementable here)

| # | What | Why it blocks (source) | Who |
|---|---|---|---|
| A1 | **The authorization server** | `bin/wylls-mcp.mjs:28` refuses to start without `WYLLS_MCP_TEST_AS=1`: "only the local test authorization server is implemented". `auth.mjs:13-19`: it has no accounts; it authorizes a *link* signed by the owner's wallet; "a production deployment would put this behind a real identity provider". | owner: use the wallet-signed test authorization server for a personal session, or choose an identity provider |
| A2 | **A public HTTPS origin** (ChatGPT, or Claude in the browser) | The issuer defaults to `http://127.0.0.1:<port>` (`bin:36`). ChatGPT's redirects are `https://chatgpt.com/...` only (`auth.mjs:36`), and ChatGPT needs to reach the server, so `WYLLS_MCP_ISSUER` must be a public `https` origin (tunnel or deployment). `preflight`'s `chatgpt` profile fails on loopback by design. | owner: tunnel or deployment, domain, TLS |
| A3 | **Which client** | Claude in the browser (`https://claude.ai/api/mcp/auth_callback`) is in profile `claude`, which is **not** in the default `chatgpt,loopback` (`auth.mjs:39-45`). It needs `WYLLS_MCP_REDIRECT_PROFILES=…,claude` plus A2. Claude Code on the same machine uses a loopback redirect (default) and no public origin. | owner: ChatGPT, Claude (web) or Claude Code |
| A4 | **The relay and herald** | `bin:4-5`: the relay with the agent wallet on (`FRONTIER_AGENT_WALLET=1`) and the herald. Sending needs SendCaravan as an agent action (patch 0005: Lane D reports the tree already contains it, `a97309e1`). Per-sender capabilities (patch 0008) keep ⑤'s token working; without them a write connection rotates the agent's one capability, refused unless `WYLLS_MCP_ALLOW_GLOBAL_ROTATE=1` (`bin:13-14`). | owner: which relay, herald and world. Starting a world or runner is outside this lane |
| A5 | **The owner's wallet and agent** | Consent is signed by a browser wallet (`http.mjs` `GET /oauth/authorize` page, `signMessage`; `auth.mjs` verifies). A write scope also signs the agent wallet's owner command. The agent needs a policy that allows the transport group, and budget in the agent ledger. | owner: wallet, agent id, policy, limits, funding |
| A6 | **The store and its seal key** | A persistent store needs `WYLLS_MCP_STORE` and a 32-byte `WYLLS_MCP_SEAL_KEY` (`bin:8-9, 29`). The key seals the agent capability at rest. | owner/operator: generate and keep the key (a secret: never in a repository or a chat) |
| A7 | **The client plan or account** | A client must allow custom MCP connectors (ChatGPT's developer mode, Claude's connectors). | owner |
| A8 | **Open product decisions already reported** | an id-less `tools/call` (run, refuse, or `-32600`: `CLAUDE-WS03-NOTIFICATION-NO-RESPONSE-20261117.md`); partial lists (`CLAUDE-WS03-STORE-ARCHIVE-READ-20261117.md`); absolute-form request targets (`CLAUDE-WS03-HTTP-BAD-TARGET-20261117.md`) | owner |

**④'s act registry is optional:** all three settings or none (`bin`, `68a512fa`, in the aggregate). It is not needed for the flow above.

## B. Implementable gaps found in the adopted code (candidates, not changed here)

| # | Gap | Source | Minimal candidate |
|---|---|---|---|
| B1 | **The protected-resource metadata advertises a documentation URL that does not exist.** `resource_documentation: ${issuer}/docs` (`auth.mjs:120`), but the HTTP routes have no `/docs` (`http.mjs` routes: well-known, oauth, owner, link, mcp). A client that shows it gets a `404`. RFC 9728 makes the field optional. | `src/auth.mjs:119-120`; `src/http.mjs` route list | drop the field, or serve a static page at `GET /docs`. **Which one is the owner's choice**; `auth.mjs` was outside this round's scope. |
| B2 | **A fix not yet in the aggregate:** the HTTP bad-target guard | `claude/ws03-http-bad-target-20261117` at `0fe84f1e` (3 paths on `8a1d799f`; a `merge-tree` check found no conflict with `2b70ba9b`) | intake by Lane D |

**Nothing else found:** no other mismatch between the adopted code and its launch settings in this pass. The earlier ones (launcher settings, store archive and save, notification responses, `listen` start-up) are fixed in the aggregate or in B2.

## C. Verified versus not

- **Verified by a run, all with fakes:** the preflight against a fake server (13/13); the launcher's ④ settings helper (4/4); the store's archive and save (12/12); the ③ ports and budget group (15/15).
- **Never verified:**
  - a real server start;
  - a real OAuth flow with a real client;
  - a real relay or herald;
  - a real send or arrival;
  - the consent page in a real browser wallet;
  - any test that imports `server.mjs`/`game.mjs` (those load the refused group G's modules and stay held).

## D. Smallest order once the owner decides

1. **A1, A3 and A7 for Claude Code on this machine.** It needs no public origin.
2. **A4–A6:** the relay, herald, wallet, agent and seal key.
3. **The preflight:** `node bin/wylls-mcp-preflight.mjs http://127.0.0.1:<port>/mcp claude-code`, against the started server.
4. **Then the flow by hand,** with the confirmation step shown to the owner before `send_caravan`.
5. **ChatGPT or Claude in the browser** additionally needs A2.
