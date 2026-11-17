# ③ MCP server: a JSON-RPC notification gets no response (2026-11-17)

**Branch:** `claude/ws03-notification-no-response-20261117`, from the fixed aggregate `claude/aggregate-approved-20261117` at `8a1d799f`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged. The server dispatcher was released by Lane D for this change.

**Static change, NOT run:**
- **Not done:** no test, import, syntax check, server start, HTTP, signing or send.
- **Not changed:** `auth`, `game`, `tools`, `http`, the bin and the store.

## The defect

**The rule:**
- JSON-RPC 2.0 and MCP 2025-06-18 (basic, Messages, <https://modelcontextprotocol.io/specification/2025-06-18/basic>) say a notification, a message without `id`, **must not** get a response.
- `server.mjs` `handle` says so itself ("→ the response (null for a notification)"), and computes `notification = msg.id === undefined`.

**What it did** (`8a1d799f`):
- `notifications/initialized` and `notifications/cancelled` → `null`, and an **unknown** method → `null` for a notification: correct.
- But `initialize`, `ping`, `tools/list` and `tools/call` returned a response (`reply(...)`, with `id: undefined`, which `JSON.stringify` drops).
- An unknown tool in `tools/call` returned an error with `id: null`.

**The transport** (`http.mjs:223-224`): `null` → `202` with no body; anything else → that body, as a JSON response. So those notifications got a response body that MCP forbids.

## The change (`src/server.mjs` `handle` only)

- **`reply(result)`** gives `null` when `notification`, otherwise the same `{jsonrpc, id: msg.id, result}` as before.
- **`answer(code, message)`** (new, local): `null` when `notification`, otherwise `error(code, message)`. It is used for the unknown tool (`-32602`) and the unknown method (`-32601`, which already returned `null` for a notification).
- **The envelope check is unchanged:** a message that is not `{jsonrpc: '2.0', method: string}` is answered `-32600` with `id: null`, before `notification` is decided. That is JSON-RPC's rule for an invalid request.
- **Requests** (with `id`): the same `id`, `result` and `error` as before.
- **Unchanged:** Lane D's own-property tool lookup (`toolNamed`), the rate limit, authentication and every tool.

## What a notification still runs (design choice, not changed)

The dispatch is unchanged, so a valid id-less message still runs its method; only the response is gone:

| Method without `id` | Runs | Side effects |
|---|---|---|
| `initialize`, `ping`, `tools/list` | the same computation | none (pure answers) |
| `tools/call` | `toolNamed` → authentication → the rate limit → **the tool itself** → `archiveFinished` | **whatever the tool does:** reads (`get_*`, `list_operations`, `check_resource_shortfall`), `prepare_caravan` (a plan), and `send_caravan`, which can send under the caller's `requestId`, with every existing guard (scopes, grant, plan confirmation, idempotency) |

**Not decided here:** whether an id-less `tools/call` should run at all.
- MCP defines `tools/call` as a request, and the specification gives no notification form of it.
- **Options for ③'s owner:**
  - (a) keep running it (today, now without a response);
  - (b) refuse it without running, which also means no response, so the client never learns of the refusal;
  - (c) treat it as an invalid request and answer `-32600` with `id: null`.
- (b) and (c) change what runs, and are therefore left to the owner. A client that follows the specification never sends it.

## Regression (written, NOT run): `test/notification-no-response.test.mjs`

**How:** it reads `src/server.mjs` and `src/http.mjs` **as text**. Importing the server would load `game.mjs` and the web frontier, which this test avoids. So it checks the source's shape, not a running server.

| Case | What is checked |
|---|---|
| N1 | `reply` and `answer` give `null` for a notification; `notification = msg.id === undefined` |
| N2 | past the envelope check, no bare `return error(` and no literal response object; the unknown-tool and unknown-method paths use `answer`; the two `notifications/*` still return `null` |
| N3 | the `-32600` envelope answer comes before `notification` is decided, with `id: msg?.id ?? null` |
| N4 | `http.mjs`: `null` → `202` with no body; batches are still refused |
