# ③ MCP server: `initialize` with missing or mistyped params is invalid params, not a success (2026-11-17)

**Branch:** `claude/ws03-initialize-params-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `61fbcc44`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged.

**Static change, NOT run:**
- **Not done:** no test, import, syntax check, server start, HTTP, bind, RPC, key or signing.
- **No real client was connected:** not ChatGPT, Claude or Claude Code.

## The contract

`InitializeRequestParams` in the MCP schema for all three advertised versions (`2025-03-26`, `2025-06-18`, `2025-11-25`) requires:
- `protocolVersion` (string);
- `capabilities` (`ClientCapabilities`, an object);
- `clientInfo` (`Implementation`: `name` and `version`, both strings; later versions add optional fields such as `title`).

**Source of these facts:** the published schema as I know it. **The schema page (https://modelcontextprotocol.io/specification/2025-11-25/schema) was not fetched in this session** (no HTTP in scope), and no local copy exists (the SDK is not installed in the tree).

## The gap (at `61fbcc44`)

- **What it did:** `server.handle` `initialize` read only `params?.protocolVersion` and answered success for anything, including no `params` at all.
- **What JSON-RPC says:** invalid params are `-32602`.
- **The legitimate exception, which stays:** an unknown version **string** with valid params gets the latest supported version (MCP negotiation).

## The change (`src/server.mjs`, `case 'initialize'` only)

- **Before the version is chosen:** if `params` is not an object, or `protocolVersion` is not a string, or `capabilities` is not an object, or `clientInfo` is not an object with string `name` and `version`, the answer is `error(-32602, 'invalid params: …')`. For a notification that is `null`, as for every response.
- **Kept:**
  - an unknown version string gets the latest, `2025-11-25`;
  - extra fields (`_meta`, more capabilities, `title`, `icons`, …) are not checked or refused;
  - the version choice and the result's fields are unchanged.
- **Not changed:** notifications, authentication, the session id (still added by `http.mjs` to any `initialize` response: see below), sending and permissions.

## The existing test adjusted (`test/protocol-auth.test.mjs:67`, NOT run)

- **The problem:** its fallback case sent `{protocolVersion: '1999-01-01'}` only, which would now be invalid params.
- **The fix:** it now also sends `capabilities: {}` and `clientInfo: {name: 't', version: '0'}`, so it remains the fallback case it is meant to be.
- **Not affected:** line 42 (`initialize` without a token) stops at the `401` before `handle`.

## Regression (written, NOT run): `test/initialize-params.test.mjs`

**How:** it reads `src/server.mjs` as text; the condition is evaluated on its own with `new Function`.

| Case | What is checked |
|---|---|
| I1 | valid params pass, including an unknown version string and extra fields (`_meta`, `roots`, `sampling`, `title`, `icons`) |
| I2 | refused: no `params`, `null`, an array, a string; `protocolVersion` missing or a number; `capabilities` missing, `null` or an array; `clientInfo` missing, an array, or without a string `name` or `version` |
| I3 | the `-32602` text goes through `error()`, comes before `const asked`, and the negotiation line is unchanged |

**Earlier pins still match** (checked as text with equivalent regular expressions, not run): `notification-no-response.test.mjs` N2/N3, `request-id-type.test.mjs` R3, and Lane D's `-32602` dispatcher line.

## Static counter-review (once)

- **Real clients send all three** (the SDK client test, `test/sdk-client.test.mjs`, uses the official client). A client that follows the specification is unaffected. **Not confirmed with a real client.**
- **`http.mjs` adds `Mcp-Session-Id`** to any `initialize` response, an error included. This is harmless, but an error now carries a session id. **Left as it is** (`http.mjs` is outside this change); a candidate for later.
- **`capabilities` contents are not validated** (for example `sampling: 1`). Validating them would be stricter than the common contract this change keeps to.

**Fixed tip:** the commit that adds this report on `claude/ws03-initialize-params-20261117`. It changes 4 paths on `61fbcc44`:
- `src/server.mjs`
- `test/protocol-auth.test.mjs`
- `test/initialize-params.test.mjs`
- this report
