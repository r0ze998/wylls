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
| `src/local-play-game.mjs`, `bin/wylls-mcp-local-play.mjs` | (⑤ B, 2026-11-18) The **read-only** observation server of one local-play TEST world: `wylls.read` only, read tools only, a link is the resident's own (agentId = owner). |
| `examples/external-resident/` | (⑤ B) A reference external AI resident with its own TEST key: discovers its world like a page, observes over this server, acts on the page's own route. [README](examples/external-resident/README.md) — how to plug in your own AI. |
| `e2e/external-resident-probes.mjs` | (⑤ B) What an external resident cannot do, checked against a running local world. |

## Test

```sh
cd workstreams/03-composability/mcp && npm ci
npm test                                                         # this repository's gateway has patch 0005 since 31ceb016: the write tests run (test/fixture.mjs PATCHED)
WS03_GATEWAY_ROOT=/path/to/another/permutation-gateway npm test  # another gateway tree (one without patch 0005 skips the write tests)
```

Run the server (local only):

```sh
WYLLS_MCP_TEST_AS=1 WYLLS_MCP_RELAY=http://127.0.0.1:41740/gw WYLLS_MCP_HERALD=http://127.0.0.1:41740 node bin/wylls-mcp.mjs
```

### Exposure (2026-11-18)

The server listens on loopback only (`WYLLS_MCP_HOST` must be `127.0.0.1`, `localhost` or `::1`) unless
`WYLLS_MCP_ALLOW_REMOTE_BIND=1`: the only authorization server here is the local **test** one, and with an `http`
issuer its codes and tokens would cross the network in plaintext. A tunnel (an `https` issuer) still connects to
`127.0.0.1` and needs no opt-in. The `Host` header is checked against the loopback names, the issuer's host name and
`WYLLS_MCP_ALLOWED_HOSTS` (DNS rebinding, as the MCP SDKs' `hostHeaderValidation` / `TransportSecuritySettings` do);
any other `Host` is answered 403 before a route runs. See `test/exposure.test.mjs`.

### Over real HTTP

`e2e/http-stack.mjs` serves the real relay routes (agent wallet, scripted chain) and the fixture herald on one loopback
port, with test-only oracles standing in for the owner's wallet. `e2e/http-verify.mjs` drives a running
`bin/wylls-mcp.mjs` through discovery, DCR, PKCE, the owner's signed consent, tokens, refresh rotation and every tool,
with bad-auth, bad-input and replay cases, and writes a redacted transcript:

```sh
node e2e/http-stack.mjs --port 41510 &
node ../../01-national-strategy/coop/board.mjs --herald http://127.0.0.1:41510 --program <programId from the stack> --season 5 --port 41520 --data /tmp/board --cluster localnet &
WYLLS_MCP_TEST_AS=1 WYLLS_MCP_PORT=41530 WYLLS_MCP_RELAY=http://127.0.0.1:41510 WYLLS_MCP_HERALD=http://127.0.0.1:41510 \
  WYLLS_MCP_COOP_PUBLIC_BOARD=1 WYLLS_MCP_COOP_BOARD=http://127.0.0.1:41520 WYLLS_MCP_COOP_CLUSTER=localnet node bin/wylls-mcp.mjs &
node e2e/http-verify.mjs --mcp http://127.0.0.1:41530 --stack http://127.0.0.1:41510 --board http://127.0.0.1:41520 --out /tmp/t.jsonl
```

The server's per-address limit (20, then 1 every 2 s) applies to the driver too: it waits out a 429 (`--phase rate-limit`
counts them instead). The chain is scripted (`[SIMULATED CHAIN]`): what the program would do is not executed.
