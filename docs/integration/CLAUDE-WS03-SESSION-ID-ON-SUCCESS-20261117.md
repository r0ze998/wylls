# ③ MCP HTTP: `Mcp-Session-Id` only on a successful `initialize` (2026-11-17)

**Branch:** `claude/ws03-session-id-on-success-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `f7052216`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged.

**Static change, NOT run:**
- **Not done:** no test, import, syntax check, server start, HTTP, bind, RPC, key or signing.
- **No real client was connected.**

## The inconsistency

- **The contract:** MCP 2025-06-18 transports, session management (<https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>). A server **may** assign a session id at initialization, on the HTTP response that contains the `InitializeResult`.
- **What the server did:** `src/http.mjs` `POST /mcp` added `Mcp-Session-Id` to **every** response whose request method was `initialize` (`:229` at `f7052216`). That included an error response, for example `-32602` invalid params since `0f2e5b57`, or a `-32600` refusal of a bad id since `e111e339`.

## The change (`src/http.mjs`, that one line)

`msg.method === 'initialize'` becomes `msg.method === 'initialize' && out.result !== undefined`:
- **A successful `initialize`** (a response with `result`) still gets a fresh random id, as before.
- **An error response** gets none.
- **A notification** returns `null` and gets `202` with no header, before this line, unchanged.

**Unchanged:**
- Authentication, permissions and the version header check.
- Whether later requests must carry the id (they need not, as before). No session state, expiry, re-initialization or retry is added.

## Readers

- **`test/protocol-auth.test.mjs:65`** checks that a successful `initialize` carries the id. It still holds.
- **Nothing else** in the tree reads `mcp-session-id`.

## Regression (written, NOT run): `test/session-id-on-success.test.mjs`

**How:** it reads `src/http.mjs` as text; the header condition is evaluated on its own with `new Function`.

| Case | What is checked |
|---|---|
| S1 | `initialize` with `result` → an id |
| S2 | `initialize` with `error` (`-32602`, `-32600`) → none; other methods with `result` → none |
| S3 | `out === null` → `202` still comes before the header choice; the `200` send is unchanged |

**Existing pins on `http.mjs` still match** (checked as text, not run): `notification-no-response.test.mjs` N4 and `http-bad-target.test.mjs` U2.

## Static counter-review (once)

- **A thrown handler** cannot reach this line: an exception goes to the outer `catch`, which answers `500` with no session header, as before.
- **`out` is always** `null` (handled above) or an object with `result` or `error`, so `out.result` is safe to read.
- **The id stays random** (`randomBytes(16)`) and is never stored or logged, as before.

## Sources for the `initialize` params fix (`0f2e5b57`): who checked what

The report on `claude/ws03-initialize-params-20261117` (`0f2e5b57`) said the schema page was not fetched in that session. That is still true of this session. **The coordinating session reports having fetched these pages directly. These are its findings, not checked again here:**
- **`https://modelcontextprotocol.io/specification/2025-11-25/schema`:**
  - `InitializeRequestParams` = `protocolVersion: string`, `capabilities: ClientCapabilities`, `clientInfo: Implementation`;
  - `Implementation` requires string `name` and `version`.
- **`https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle`:** the client's version, capabilities and implementation information are required in `initialize`.

**This matches** what `0f2e5b57` enforces. The tip `0f2e5b57` is not changed; this section only records the sources.

**Fixed tip:** the commit that adds this report on `claude/ws03-session-id-on-success-20261117`. It changes 3 paths on `f7052216`: `src/http.mjs`, `test/session-id-on-success.test.mjs`, and this report.
