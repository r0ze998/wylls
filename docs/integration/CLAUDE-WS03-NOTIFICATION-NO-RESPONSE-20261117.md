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

- **`reply(result)`** and **`error(code, message)`** give `null` when `notification`. Otherwise they give the same response as before. For a request, `id: msg.id` is the same as the earlier `msg?.id ?? null`, because `msg` is known to be an object at that point.
- **`invalid()`** (new, local) answers `-32600` with `id: msg?.id ?? null`. It is used only by the envelope check, which runs **before** `notification` is decided, so an invalid message is answered as JSON-RPC requires.
- **Lines kept exactly** (other tests pin them):
  - `if (!fn) return error(-32602, unknownToolText(name));` (Lane D's `dispatch-own-tools.test.mjs` T4);
  - `default: return notification ? null : error(-32601, …)`;
  - the two `notifications/*` cases.
- **Requests** (with `id`): the same `id`, `result` and `error` as before.
- **Unchanged:** Lane D's own-property lookup, the rate limit, authentication and every tool.

**First attempt, corrected:** the first commit (`8694a128`) introduced an `answer()` helper and changed Lane D's pinned `-32602` line, which its T4 would have rejected. The second commit restores that line and puts the null into `error` instead.

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
| N1 | `reply` and `error` give `null` for a notification; `notification = msg.id === undefined` |
| N2 | past the envelope check, no literal response object and no `invalid()`; Lane D's `-32602` pin, the `-32601` default and the two `notifications/*` lines are unchanged |
| N3 | `invalid()` (`-32600`, `id: msg?.id ?? null`) is the envelope answer, before `notification` is decided; `error()` is never called before it |
| N4 | `http.mjs`: `null` → `202` with no body; batches are still refused |

## Static counter-review (once, read only)

1. **Pins on `server.mjs` in the tests:**
   - Lane D's `dispatch-own-tools.test.mjs` T4 pins the `-32602` line. The first commit broke it; the second commit restores it exactly. The second commit's text matches T4's regex (checked as text with an equivalent regular expression, not by running the test).
   - `ws04-readvia.test.mjs` V6 and the others pin lines outside `handle`.
2. **Callers that send id-less messages and expect an answer:** none in the tree. `test/fixture.mjs` `client.rpc` and `test/keyfree/harness.mjs` always send an `id`, and `e2e/local-stack.mjs`'s `rpc` is the chain's RPC, not MCP.
3. **`id: null`** (a request with a null id, which MCP forbids clients to send): not a notification, so it is answered with `id: null`, as before.
4. **The transport:** `http.mjs:223-224` is unchanged (`null` → `202`). A JSON array is still refused as a batch (`:222`).
5. **Not covered:** the server receiving a JSON-RPC *response* from a client (no `method`) is answered `-32600`, as before. This server sends no requests to clients, so no client response is expected.

## Fixed tip

`claude/ws03-notification-no-response-20261117`: the commit that adds this section. It changes 3 paths on `8a1d799f`: `src/server.mjs`, `test/notification-no-response.test.mjs`, and this report.

**Response rule, now:** a valid notification → `null` → `202`, no body; a request → its response; an invalid message → `-32600`, `id: null`.

**What runs:** unchanged. An id-less `tools/call` still runs its tool (an owner's choice, above).

**Not verified:**
- Nothing was run. The regression checks the source as text.
- No real MCP client, ChatGPT, Claude Code or HTTP request was used.
