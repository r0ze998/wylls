# ③ MCP server: `initialize` version negotiation against the adopted protocol (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `29ce49c2`. Read with `git show` and `git grep` only.

**Not done:**
- No test, import, syntax check, server start, HTTP, bind, RPC, key or signing.
- No real client or OAuth connection.

**Verdict:** **no mismatch found, no code change.**

## What the server does (source)

- **The supported versions:** `src/server.mjs:19` `PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']`.
- **`initialize`** (`server.mjs:810-812`):
  - it answers `protocolVersion` equal to `params.protocolVersion` when that is one of the three, otherwise `PROTOCOL_VERSIONS[0]`;
  - it also answers `capabilities: {tools: {listChanged: false}}`, `serverInfo` (`name`, `title`, `version`) and `instructions`.
- **The HTTP transport** (`src/http.mjs`, `POST /mcp`):
  - authentication comes first (`401` with `WWW-Authenticate`);
  - then the `MCP-Protocol-Version` header: when present and not one of the three, `400` with a JSON-RPC error (the value is cut to 20 characters); when absent, accepted;
  - batches are refused;
  - a response to `initialize` carries a fresh `Mcp-Session-Id`;
  - `GET /mcp` and `DELETE /mcp` answer `405`.

## Against MCP (2025-06-18 lifecycle and transports; 2025-11-25 keeps the same negotiation)

| Rule | Server | Holds? |
|---|---|---|
| Server supports the requested version → answers the same version | `includes(asked) ? asked` | **yes** (`test/protocol-auth.test.mjs:63-64`, `2025-06-18` → `2025-06-18`) |
| Otherwise → another supported version, which SHOULD be the latest | `PROTOCOL_VERSIONS[0]`, `2025-11-25`, the newest of the three | **yes** (`:67`, `1999-01-01` → `2025-11-25`). The client decides whether to continue; the server does not refuse. |
| A non-string `protocolVersion` | not in the list → the latest | yes (the same fallback) |
| An `MCP-Protocol-Version` header that is invalid or unsupported → HTTP 400 | `v && !includes(v)` → `400` | **yes** |
| No header → the server SHOULD assume `2025-03-26` | accepted; the server keeps no per-version behaviour to switch | yes |
| Batching removed in 2025-06-18 | refused (`400`) | yes |
| `GET` on the MCP endpoint: an SSE stream or `405` | `405` | yes |
| The server MAY assign a session id; requiring it is the server's choice | assigned on `initialize`, not required later | allowed. **No session lifecycle is invented here.** |

## Not covered

- **Whether everything else in 2025-11-25 is met** (its other additions beyond negotiation): this pass covers negotiation and the header only. Advertising `2025-11-25` assumes the rest holds. That is not established here.
- **The negotiated version is not remembered:** a later request may carry any supported version in its header and is accepted. Remembering it would need the session state this server does not keep; not decided here.
- **No real client:** ChatGPT, Claude or Claude Code was not connected; OAuth was not exercised; nothing was run.

## Static counter-review (once)

- **The order of checks:** authentication comes before the version header. An unauthenticated client sees `401` first, which is what the preflight expects (step 1: a `401` with `resource_metadata`).
- **The `400` message** quotes at most 20 characters of a client-sent header. It is not a secret, and it is never logged.
- **A client asking for `2024-11-05`** gets `2025-11-25` and decides for itself. Refusing it would be the forbidden "refuse a legitimate fallback".

**Next, a finite list, not pursued:**
1. A full 2025-11-25 conformance pass, if the owner wants that version advertised with confidence.
2. Whether to require and remember `Mcp-Session-Id` and the negotiated version. That is session state, an owner's choice.
