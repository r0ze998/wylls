# ③ MCP server: a request id that is not a string or an integer is refused before dispatch (2026-11-17)

**Branch:** `claude/ws03-request-id-type-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `cb65bed4`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged.

**Static change, NOT run:**
- **Not done:** no test, import, syntax check, server start, HTTP, bind, RPC, key or signing.

## The contract and the gap

**The contract:** MCP 2025-06-18, basic, Requests (<https://modelcontextprotocol.io/specification/2025-06-18/basic>): "Requests MUST include a string or integer ID. Unlike base JSON-RPC, the ID MUST NOT be null."
- That is the protocol this server speaks (`PROTOCOL_VERSIONS`).
- Base JSON-RPC 2.0 allows a null id (discouraged), but MCP does not. Only MCP's rule is applied.

**The gap** (at `cb65bed4`):
- `server.handle` checked `jsonrpc` and `method` only.
- Any id other than "absent" was taken as a request, dispatched, and **echoed** in the response (`reply`/`error`: `id: msg.id`): `null`, `true`, `1.5`, `[…]`, `{…}`.

**Reachability:** `http.mjs` `POST /mcp` parses the body as JSON and passes any non-array value to `handle`, so every JSON id type reaches it. This was read from the source; no request was sent.

**Callers:** none in the tree sends such an id. `test/fixture.mjs` `client.rpc` and `test/keyfree/harness.mjs` use integer ids.

## The change (`src/server.mjs` `handle`, before the envelope check)

```js
const badId = msg !== null && typeof msg === 'object' && msg.id !== undefined && typeof msg.id !== 'string' && !Number.isInteger(msg.id);
if (badId) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: id must be a string or an integer' } };
```

**Refused before anything is dispatched:** an id that is present and is `null`, a boolean, a non-integer number, an array or an object.
- **The answer:** `-32600` with `id: null`. **The bad id is not echoed.**
- **Why before the envelope check:** an invalid message with a bad id is no longer answered with that id echoed (`invalid()` echoes `msg?.id ?? null`).

**Kept as before:**
- **Ids:** every string, the empty string included, and every integer (`Number.isInteger`), including `0`, negatives and large integers. **No safe-integer limit is added.**
- **An absent id:** a notification, handled as before (no response).
- **The rest:** `invalid()`, `reply`, `error` and Lane D's own-property dispatcher (the `-32602` pin), plus sending, confirmation, authentication, budget and `requestId` handling.

**One behaviour that changes on purpose:** a request with `id: null` used to run and be answered with `id: null`. It is now refused before it runs. MCP forbids that id. The notification report's sentence "`id: null` … answered with `id: null`, as before" no longer holds after this change.

## Regression (written, NOT run): `test/request-id-type.test.mjs`

**How:** it reads `src/server.mjs` as text; importing it would load `game.mjs` and the web frontier. The one predicate line is evaluated on its own with `new Function`, with no import and no I/O.

| Case | What is checked |
|---|---|
| R1 | refused: `null`, `true`, `false`, `1.5`, `-0.25`, `[]`, `[1]`, `{}`, `{a: 1}` |
| R2 | kept: `''`, `'a'`, `'1'`, `0`, `1`, `-1`, `2**53+2`, `1e21`; no id (a notification); non-object messages are left to the envelope check |
| R3 | the refusal comes before the envelope check, before `notification` and before the dispatch; it answers `id: null` |
| R4 | unchanged: `invalid()`, `reply` and Lane D's `-32602` line |

**Existing text pins still match** (checked as text with equivalent regular expressions, not by running them): `notification-no-response.test.mjs` N1–N3 (the new literal is before the `notification` line, outside N2's slice) and `dispatch-own-tools.test.mjs` T4.

## Static counter-review (once)

- **`msg` is not an object** (a JSON number, string, boolean or `null`): `badId` is `false`, and the envelope check answers `-32600` as before.
- **`__proto__` as a key:** `JSON.parse` makes it an own property, and `msg.id` reads only `id`.
- **`-0`:** `Number.isInteger(-0)` is true. It is kept, and `JSON.stringify` writes it as `0`, as before.
- **Very large integers** (`1e21`): kept. JSON may write them in exponent form, as before. No limit is invented.
- **A non-integer** (`1.0` in JSON is the integer `1`): only a real fraction is refused.

**Fixed tip:** the commit that adds this report on `claude/ws03-request-id-type-20261117`. It changes 3 paths on `cb65bed4`: `src/server.mjs`, `test/request-id-type.test.mjs`, and this report.

**Not verified:** nothing was run; no real client or HTTP request was used.
