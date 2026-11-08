# wylls-mcp (workstream 03)

A remote MCP server for the Wylls local test stack. An MCP client such as ChatGPT can use it to:

1. read the connected owner's village;
2. find what the village lacks;
3. prepare a caravan between the owner's own places;
4. send it through the agent wallet gateway;
5. follow it until it is delivered, lost, or raided.

Local test assets only. Nothing here is deployed or published. **It has not been tried in ChatGPT.**

The design and the facts are in [../07-mcp.ja.md](../07-mcp.ja.md) (Japanese). The contracts are in [../08-mcp-contracts.ja.md](../08-mcp-contracts.ja.md), and the run, results and video plan are in [../09-mcp-run-and-video.ja.md](../09-mcp-run-and-video.ja.md).

| Path | What |
|---|---|
| `src/server.mjs` | The tools, plans, operations and tracking (transport-free JSON-RPC). |
| `src/tools.mjs` | Tool definitions: annotations, schemas and OAuth `securitySchemes`. |
| `src/auth.mjs` | OAuth 2.1 resource server and the **local test** authorization server (RFC 9728, RFC 8414, PKCE S256, RFC 8707, RFC 7591, RFC 9207). |
| `src/http.mjs` | Streamable HTTP at `/mcp`, the OAuth endpoints and the owner's consent page. |
| `src/game.mjs` | Reads from the relay and herald, using the web client's own modules (stores, roads, place data). |
| `src/ports.mjs` | ② Grant **MOCK** and ④ RunReceipt **MOCK**. ⑤ budget is the agent wallet's own and is not reimplemented here. |
| `src/events.mjs` | Decodes CARAVAN_SENT, CARAVAN_SETTLED and CARAVAN_RAIDED from the herald's `/h/events` bodies. |
| `src/store.mjs`, `src/seal.mjs` | Atomic JSON store (mode 0600) and AES-256-GCM sealing of the agent capability. |
| `test/` | Contract tests on a scripted chain (protocol and OAuth, the play, attacks) and the official MCP SDK client. |
| `e2e/local-stack.mjs` | The play end to end on a real local stack (frontier-stack). |

## Test

```sh
cd workstreams/03-composability/mcp && npm ci
npm test                                                                    # this repository's gateway (no patch 0005): the write tests are skipped
WS03_GATEWAY_ROOT=/path/to/a/tree/with/patch-0005/permutation-gateway npm test  # every test
```

Run the server (local only):

```sh
WYLLS_MCP_TEST_AS=1 WYLLS_MCP_RELAY=http://127.0.0.1:41740/gw WYLLS_MCP_HERALD=http://127.0.0.1:41740 node bin/wylls-mcp.mjs
```
