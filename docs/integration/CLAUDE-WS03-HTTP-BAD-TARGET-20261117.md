# ③ MCP HTTP: a request target the URL parser refuses is answered 400, not an unhandled rejection (2026-11-17)

**Branch:** `claude/ws03-http-bad-target-20261117`, from the fixed aggregate `claude/aggregate-approved-20261117` at `8a1d799f`. The aggregate, canonical, `main`, Lane C and Lane D refs are unchanged.

**Static change, NOT run:**
- **Not done:** no test, import, syntax check, server start, bind, HTTP request, key or signing.
- **Not touched:** Lane D's `listen` change (`c678c64d`: `http.mjs` line 7 and lines 239–244, plus `listen.mjs`), which is a separate hunk.

## The defect (traced at `8a1d799f`)

**Why a parse error escapes:**
- `createHandler` returns `async function handler(req, res)`. Its **first line** was `const url = new URL(req.url, auth.issuer);`, **before** the `try` (`src/http.mjs:125-127`).
- `listen` passes the handler straight to `http.createServer(handler)` (`:241`). `node:http` calls it and ignores the returned promise.
- `bin/wylls-mcp.mjs` installs no `unhandledRejection` handler.

**What happens:** a target that `new URL` refuses makes the promise reject **unhandled**, outside the handler's `catch` (`:231-235`). Under Node's default since v15 (`--unhandled-rejections=throw`), that ends the process. The request also gets no answer.

**Which targets throw:** a relative target resolves against the base without error, including odd paths like `/%zz`. What throws even with a base:
- an absolute-form target with an invalid host or port, e.g. `http://a:70000/` or `http://[::1/`;
- a scheme-relative one with an invalid host, e.g. `//[`.

**Reachability:**
- **Who can send it:** any client that can reach the port, with no authentication needed; the parse comes before every check.
- **What it rests on:** that Node's HTTP parser accepts such a request target, since it allows absolute-form targets and these characters. **That rests on the parser's documented behaviour and has not been tried here.** The premise about `URL` is in U1 below, written but not run.

## The change (`src/http.mjs`, the handler's first line only)

```js
let url;
try { url = new URL(req.url, auth.issuer); } catch { return send(res, 400, { error: 'invalid_request', error_description: 'the request target could not be parsed' }); }
```

- **A refused target:** gets `400` with fixed JSON. Nothing of the target, query or headers is logged or echoed.
- **Unchanged:**
  - every target that parsed before (the same `url`, `route` and switch);
  - the Origin check and the rate limit (both run after the parse, as before);
  - authentication, every route, the outer `catch` and the `500`.
- **The `400` comes before the Origin check,** as the parse always did. There is no route to authorize, and the answer carries no data.
- **Not decided:** any wider policy on which targets to accept, for example refusing all absolute-form targets.

## Regression (written, NOT run): `test/http-bad-target.test.mjs`

**How:** it reads `src/http.mjs` as **text**; importing it would load `server.mjs` and `game.mjs`. The premise is checked with the built-in `URL` only. There is no server, socket or request.

| Case | What is checked |
|---|---|
| U1 | `new URL(t, base)` throws for `http://a:70000/`, `//[`, `http://[::1/` and `http://exa mple/`; it does not throw for `/mcp`, a query, the well-known path and `/%zz` |
| U2 | the handler parses the target inside its own `try`, before building the route, and answers the fixed `400`; nothing before the route logs or puts `req.url` in a string |
| U3 | unchanged: the main `try` still starts with the Origin check; the `OAuthError` catch is still there; there is exactly one parse of `req.url` |

## Static counter-review (once)

- **Other code before the main `try`:** only the route string, from `req.method` and `url.pathname`. It cannot throw.
- **Other unawaited promises in the handler:** none found. The rest is inside the `try` or `await`ed there.
- **`send`** can throw only if headers were already sent; nothing was sent before this point.
- **Lane D's `listen` change** sits in other hunks (line 7, lines 239–244): a later intake of both applies without overlap. **Not tried here.**

**Fixed tip:** the commit that adds this report, on `claude/ws03-http-bad-target-20261117` (3 paths on `8a1d799f`: `src/http.mjs`, `test/http-bad-target.test.mjs`, this report).

**Next, a finite list, not pursued:**
1. With Lane D's `listen` change, a start-up error now rejects. The bin's top-level `await listen(...)` then ends the process with that error, which is the intended visible failure.
2. Whether to accept absolute-form targets at all is a policy question for ③'s owner.
