# Cooperation board read adapter (read-only, opt-in)

`src/coop-read-adapter.mjs` reads one workstream 01 cooperation board
(`workstreams/01-national-strategy/coop/board.mjs`) for one authenticated owner. It returns a fixed, safe
projection. It is **dependency-free** and uses the **fetch the caller passes in**.

Since 2026-11-17 UTC it is wired into the MCP server as the opt-in tool `get_cooperation_status`, which is **off by
default** (see "MCP wiring" below).

## Status: be honest about what this is

- **Wired in code, off by default; fixture integration verified.** `src/server.mjs`, `src/tools.mjs`, `bin/wylls-mcp.mjs` and the new
  `bin/coop-read-settings.mjs` connect the adapter to the server's existing dispatch. No real server has been started
  with it on, and no real env or settings were changed. Nothing was tried against a live board, hosted MCP client or game
  world. The official SDK client/transport was tested in-process with injected HTTP and authentication fixtures. The CLI is still the local test stack only (`WYLLS_MCP_TEST_AS=1`).
- **Two test suites, with different evidence:**
  - `test/coop-read-adapter.test.mjs` (the adapter unit suite): **independently verified, 34/34 passed**
    (coordinator, 2026-11-17 UTC). It uses fake fetch, fake streamed bodies and fake timers only. Both JS files
    also passed `node --check`. This is unit evidence, not real-board, MCP-client or game-world evidence.
  - `test/coop-read-integration.test.mjs` (the new wiring suite): **independently verified, 31/31 passed**
    (coordinator, 2026-11-17 UTC), including the real HTTP handler with fake request/response streams.
    No live socket, real OAuth flow or game-world deployment was exercised. This includes five official-SDK
    transport/bridge tests with injected HTTP (see "Official SDK transport tests").
- **Not a permission source.** The adapter grants nothing. It cannot make `send_caravan` accept another owner's
  place. It derives no recipient or target list, score, selection, role or send authority.
- **Principal shape:** `{owner, scopes}`. The server passes only these two fields of its authenticated principal.
  The adapter does not import `auth.mjs`, because its imports reach the gateway, so `COOP_READ_SCOPE`
  (`'wylls.read'`) restates `SCOPES.READ`.

## MCP wiring (get_cooperation_status)

### Configuration (`bin/coop-read-settings.mjs`, pure, checked before start-up)

| env | meaning |
|---|---|
| `WYLLS_MCP_COOP_PUBLIC_BOARD=1` | Explicit opt-in: this specific board's `/coop/*` is meant to be public. Unset or empty means **off** (the default). Any other value is an error. |
| `WYLLS_MCP_COOP_BOARD=<url>` | The board's base URL: http(s), no user, password, query, fragment or surrounding spaces, and an optional plain path prefix. Required when on. |
| `WYLLS_MCP_COOP_CLUSTER=<cluster>` | The cluster the board must report (`/^[a-z][a-z0-9-]{0,31}$/`). Required when on, with **no default**. |

- Setting the board or the cluster without the opt-in is an error, not a silent off.
- Errors name the setting and the rule, never its value.
- `bin/wylls-mcp.mjs` exits with code 2 on a settings error before it opens the store, relay or anything else.
- When the read is on, the bin builds the adapter with `publicViewConfirmed: true`, the configured base and the
  process fetch, then passes `coopRead: {adapter, cluster}` to `createWyllsMcp`. It logs `cooperation board read:
  on (<origin>, cluster <c>; …)` or `cooperation board read: off`.

### Server (`src/server.mjs`, `src/tools.mjs`)

- **New option:** `createWyllsMcp({ …, coopRead = null })`.
  - `null`, `undefined`, or an adapter with `enabled: false` means off.
  - On means `{adapter, cluster}`: an enabled adapter (from `createCoopReadAdapter`) plus a valid cluster.
  - Any other shape throws `TypeError` (a deployment error, never a quiet off).
- **Visibility agrees with enablement:**
  - Off: `tools/list` answers exactly the existing `TOOLS`. `tools/call get_cooperation_status` is the existing
    unknown-tool error (-32602). Nothing is fetched and `game.context()` is not called.
  - On: `tools/list` answers `[...TOOLS, COOP_TOOL]`. `COOP_TOOL` is exported from `tools.mjs` but is not part of
    `TOOLS`, so the existing list and its consumers are unchanged.
- **Same dispatch as every tool:** the own-name lookup, the `Unauthenticated` refusal, the per-connection rate limit
  (30 burst, 1/s), and InternalError on a throw. No existing tool, scope, grant, auth flow, store record or write
  path changed.
- **One deliberate dispatch difference (review fix, 2026-11-18):** `tools/call` runs `archiveFinished()` (which may
  move old finished operations to the archive and save the store) after every tool. It now skips that sweep **only**
  for `get_cooperation_status`, whatever the outcome (ok or any refusal). So the tool really stores nothing locally.
  Every other tool keeps the sweep exactly as before.
- **The tool:**
  - Input schema: `{type: 'object', properties: {}, additionalProperties: false}`.
  - Security: `oauth2` with `wylls.read`.
  - Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`
    (it reaches a separate public board).
  - The description says: the board's GET may refresh and save the board's own observation cache; this server
    stores nothing; there is no recipient or target list, score, role or send authority; listed entries are not
    arrivals.
- **Per call:**
  1. Check `wylls.read`. Without it the answer is the existing `InsufficientScope` step-up error.
  2. Accept only empty arguments (`{}`, or omitted). Anything else (viewer, owner, world, url, an array) is
     `BadRequest`.
  3. Read `game.context()` and require `{programId, seasonId}` consistent with its `key`. If it can't be read, the
     answer is `ContextUnavailable` (retryable).
  4. Call `adapter.read({principal: {owner, scopes}, context: {programId, seasonId, cluster: <configured>}})`. The
     viewer is always the authenticated owner. The world is always the server's current context plus the
     configured cluster. The caller chooses neither.
  5. Read `game.context()` again. If it is now another world, or can't be read, the answer is `ContextChanged`
     (retryable) and nothing is shown.
  6. On `ok`, the adapter's result is the tool result (`structuredContent` plus the same JSON as text). Otherwise
     it is an error with the adapter's result in `error.cooperation` (`nation`/`mine` are null) and this code:

| adapter status | tool error code | retryable |
|---|---|---|
| `unavailable` | `CoopBoardUnavailable` | yes |
| `changed` | `CoopBoardChanged` | yes |
| `mismatch` (world, cluster or owner) | `CoopBoardMismatch` | no |
| `unsupported` | `CoopBoardUnsupported` | no |
| `damaged` | `CoopBoardDamaged` | no |
| `malformed` | `CoopBoardMalformed` | no |
| `refused` | `CoopReadRefused` | no |
| `disabled` | `CoopReadDisabled` | no |

### What the wiring does not do

- It adds no scope, grant, credential, signature or persisted record, and changes no authorization semantics.
- The result is not a permission source. `send_caravan` still accepts only the owner's own places.
- It does not make the board authenticated. `viewer` is still display context on a public board, and the owner
  binding rests on this server's OAuth principal.
- `SERVER_INSTRUCTIONS` is unchanged, so it does not mention the tool. The tool's own description carries the
  rules.

## API

### `createCoopReadAdapter(config)` → `{enabled, origin, read}`

`config` must come from trusted deployment config only, never from a tool caller.

| field | meaning |
|---|---|
| `publicViewConfirmed` | Must be exactly `true`. This confirms that this specific board's `/coop/*` is meant to be public. Any other value returns `{enabled: false, origin: null, read}`, and that `read` always answers `status: 'disabled'` **with zero fetches**. This is the default. |
| `baseUrl` | The board's base URL: http(s), no userinfo, query or fragment, and an optional plain path prefix (`normaliseBoardBase`). Required when enabled. |
| `fetch` | Injected fetch. Required when enabled. `globalThis.fetch` is never used. |
| `timeoutMs` | One deadline per request, covering the fetch and the whole body read. 1..60000, default 5000. |
| `maxBytes` | Body limit per request. 1 KiB..16 MiB, default 1 MiB. |
| `timers` | `{setTimeout, clearTimeout}`. Defaults to the global timers. Tests inject fakes. |

When `publicViewConfirmed === true`, a missing fetch or a bad base/limit throws `TypeError`. That is a deployment
error and is never reported as a read result.

### `adapter.read({principal, context})` → result

- `principal`: the **authenticated** caller, `{owner: <base58 wallet>, scopes: [...]}`. `scopes` must include
  `wylls.read`. `owner` is the only wallet ever sent to the board, as `viewer`.
- `context`: the **trusted current world** as the server knows it, `{programId, seasonId, cluster}`. Any other
  field (for example `viewer` or `wallet`) is refused. The caller cannot choose a viewer or a foreign wallet.

Principal and context are validated before any fetch. A failure returns `status: 'refused'` with zero fetches.

### Requests made (when enabled and validated)

1. `GET <base>/coop/config`
2. `GET <base>/coop/view?viewer=<principal.owner>` (no other query field)
3. `GET <base>/coop/config` again

Every request is `method: 'GET'`, `redirect: 'manual'`, `credentials: 'omit'`, `cache: 'no-store'`, with only an
`accept` header. No auth header and no cookies are sent. The adapter refuses:

- 3xx responses, `redirected: true`, `opaqueredirect`, and a `res.url` that differs from the requested URL;
- any status other than 200;
- a declared `content-length` above `maxBytes`.

The body is read **as a stream** (`res.body.getReader()`), one chunk at a time. Reading stops and the stream is
cancelled as soon as the bytes received exceed `maxBytes`. `res.text()` and `res.json()` are never called. A
response without a readable body stream is refused; the adapter never falls back to an unbounded read. Bytes are
decoded as strict UTF-8 and must parse to a JSON object.

**Side effects:** the adapter writes nothing locally and never POSTs. The remote GET is **not** free of side effects:
the board's `view()` calls `caravans()`, which may refresh and save the board's own observation cache
(`observed.json`).

### Fail-closed checks

| condition | status |
|---|---|
| config/view season or `contexts[0]` is not `context.programId/seasonId`, or the config `cluster` is not `context.cluster` (a missing cluster counts) | `mismatch` |
| `personal.viewer !== principal.owner` | `mismatch` |
| a request listed in the owner's lists has a `ctx` from another world | `mismatch` |
| `contexts.length !== 1` (the board keeps previous worlds) | `unsupported` |
| `damaged.length > 0` or `store.problems.length > 0` (config or view) | `damaged` |
| the second config differs from the first (season, cluster, contexts, damaged/problem counts, judge), or the view's contexts/store disagree with config | `changed` |
| missing or ill-typed fields; `personal.nation` differs from `nation.nation`; an owner's request not among `view.requests`, not the owner's, or duplicated; an owner's response the board does not record; an entry of another responder listed as the owner's; non-integer amounts | `malformed` |
| network error, timeout, non-200, redirect, oversize, no stream, non-UTF-8, non-JSON | `unavailable` |

Nothing is ever shown partially. On any status other than `ok`, `nation` and `mine` are `null`.

### Result

```js
{
  ok: boolean,                 // status === 'ok'
  status: 'ok'|'disabled'|'refused'|'unavailable'|'mismatch'|'changed'|'unsupported'|'damaged'|'malformed',
  why: string|null,            // the adapter's own wording, never board free text
  source: { kind: 'coop-board', origin, readOnly: true, judge: string|null, heraldFeed: 'read'|'unavailable'|null } | null,
  world: { programId, seasonId: string, cluster } | null,
  owner: string|null,          // principal.owner
  nation: {
    status: 'verified'|'unknown',
    nation: string|null,
    requests: number|null,              // null when unknown, never 0 for unknown
    deliveredFromNation: number|null,
    note: string|null,                  // fixed adapter text; the board's nation.why/nationWhy is never copied
  } | null,
  mine: {
    requests:  [{ id, state, need: {Resource: whole}, entries: { listed, counted }, fulfilment: string|null }],
    responses: [{ id, responded: true, myEntries: { listed, counted } }],
    verified:  { Resource: positive whole },   // board's myVerified (counted arrivals the owner delivered)
    left:      [goalId],
  } | null,
  limitations: COOP_READ_LIMITATIONS,
}
```

`status: 'ok'` with zero counts and empty lists is a **valid empty** board. It is distinct from `unknown` (nation
not verified), `disabled`, `refused` and the failure statuses.

## What the board actually provides, and the limits

- `nation` is the board's aggregate for the owner's **verified** nation over the whole single-context board:
  `requests` counts the requests whose requester the board verified as that nation, and `deliveredFromNation`
  counts the counted arrivals whose responder it verified as that nation. The board has no per-request verified
  requester nation. So the adapter does **not** invent same-nation recipient or target lists, scores, selections,
  roles or send authority.
- That aggregate is only safe on a single-context board, because it would otherwise mix historical contexts.
  Multi-context boards are therefore refused.
- `entries.counted` and `myEntries.counted` are board-verified counted arrivals (duplicates excluded).
  `entries.listed` and `myEntries.listed` count **every** entry the board lists, in any state (moving, raided,
  delivered-but-unproven, duplicates). They are **not** arrivals and not success. A response or a sending is never
  reported as an arrival or a success.
- Amounts are whole-unit lower bounds as the board reports them.
- `viewer` is display context, not authentication. The board is public and would answer for any wallet. The
  binding to the owner rests on the caller's authentication, not on the board.
- The output excludes: raw config/view spreads, other wallets (requesters, responders, contributors), signatures,
  tokens, proofs, response/request notes, the board's `why`/`note`/`nationWhy` text, herald/relay/rpc URLs, page
  paths, store segment paths, `joint`, `rejected`, `sendings`, and caravan ids.
- An object `fulfilment` without a recognisable `status` word becomes `null` (not known), not an error.

## Tests

### Integration suite: `test/coop-read-integration.test.mjs` (26/26 independently passed; later SDK tests not executed)

It uses the real `createWyllsMcp(...).handle`, the real adapter and the real settings module. The principal, game
(`context`/`view`), store, auth stub and fetch are fixtures with fake streamed bodies and idle fake timers. There are
no keys, signatures, network, child processes or filesystem writes. It covers:

- settings: off by default, explicit opt-in, half or bad configurations, and errors that don't echo values;
- off: an unchanged `tools/list`, the tool unknown, zero fetches (both with no `coopRead` and with a disabled
  adapter);
- a malformed `coopRead` throws;
- on: discovery is `TOOLS` plus the honestly annotated tool;
- refused before any fetch: unauthenticated calls, a missing `wylls.read` (step-up), any argument;
- the exact viewer URL for the authenticated owner and the trusted world/cluster, with no store writes and no leaks;
- fail closed on: a board answering for another wallet; a context that is unavailable or malformed (no fetch); a
  board of another world or cluster; the world changing during the read; malformed, changed, multi-context, damaged
  and unreachable boards;
- the rate limit applies;
- existing tools answer identically with the read on or off and fetch nothing from the board;
- regression for the archive fix: with an old finished operation in the store, successful and refused cooperation
  reads (`BadRequest`, `InsufficientScope`, `Unauthenticated`, a board mismatch) cause no `save()` and no
  `archive()`. A control test shows `list_operations` still archives that operation and saves, as before;
- in-process HTTP through the real `createHandler`, using fake request/response objects (an async-iterable body,
  `writeHead`/`end` recorded), a stub auth that accepts one fixed fake bearer string, and no socket, `listen`,
  network, keys or child process. It covers: 401 with `www-authenticate` for a missing or bad token (no board
  read); `tools/list` with the read on and off; a successful call (exact viewer URL, no save or archive); an
  extra-argument refusal; the unknown tool when off; and the scope step-up;
- `initialize` and `ping` are unchanged.

Status of the suite above: the coordinator reported **60/60 passed** (34 adapter + 26 integration) and five syntax
checks, before the SDK tests below were added.

#### Official SDK transport tests (added 2026-11-18, written, NOT executed)

These use the pinned `@modelcontextprotocol/sdk` 1.32.1 (installed by the coordinator):
`Client` from `client/index.js` and `StreamableHTTPClientTransport` from `client/streamableHttp.js`.

- The transport is constructed with an injected `fetch` (`bridgeFetch`) and
  `requestInit.headers.Authorization = 'Bearer fake-test-token'`, the one fixed fake value the stub auth accepts.
- `bridgeFetch` turns each request into a call to the real `createHandler`, using the same fake request/response
  objects as the HTTP tests, and returns a native `Response` with the handler's status, headers and body (a null
  body when empty, as for 202 and 405).
- `bridgeFetch` accepts a string, `URL` or `Request`. It accepts only the test origin `http://127.0.0.1:41960` and
  the path `/mcp`, only POST, GET and DELETE, and bodies of at most 64 KiB. Anything else throws.
- `globalThis.fetch` is replaced by a thrower during each SDK test, so any fallback to global fetch fails the test.
- Each request has a 5 s SDK timeout, and every client is closed in `finally`.

The tests cover:

- **Enabled:** `connect` (initialize 200, `notifications/initialized` 202, the optional GET answered 405), discovery
  of the existing tools plus `get_cooperation_status`, and a successful `callTool` bound to the authenticated owner
  and the current world (exact board URLs, no save or archive).
- **Disabled:** the tool isn't discovered, and calling it rejects with -32602 and no board fetch.
- **Refusals:** extra arguments (`BadRequest`) and a missing `wylls.read` scope (`InsufficientScope`) are tool
  errors, with no board fetch.
- **Unauthenticated:** with no or a wrong bearer, `connect` rejects on a 401 and there is no board fetch.
- **The bridge itself:** it refuses other origins, paths, queries, methods and inputs, and answers DELETE `/mcp`
  with 405.

What they prove: the official SDK client transport interoperates with this server's HTTP handler in-process.

What they don't prove: a live client/server, a socket, real OAuth (the stub auth accepts a fixed fake string, with
no tokens, wallets or signatures), a real board, or a game world. The implementation session wrote these tests
without running them. The coordinator subsequently ran the complete suites: 65/65 passed, including all five SDK/bridge tests.

Run with `node --test workstreams/03-composability/mcp/test/coop-read-integration.test.mjs`. It imports
`src/server.mjs`, so it loads the same gateway and frontier modules the existing server tests load.

### Adapter unit suite: `test/coop-read-adapter.test.mjs` (34/34 independently passed)

It covers:

- disabled by default with zero fetches;
- factory config errors;
- a missing `wylls.read` scope, a malformed owner, and a missing, unknown-field or malformed context (all before
  any fetch);
- the exact URLs and request options;
- owner mismatch;
- world/cluster mismatch, a view of another world, and a request of another world;
- a config that changed between reads;
- multi-context boards, and damaged records or store problems;
- malformed or partial views;
- HTTP errors, non-JSON and failed fetches;
- redirects;
- declared and streamed oversize bodies (the read stops and the stream is cancelled), a missing stream, bad chunks
  and bad UTF-8;
- timeouts during the fetch and during the body (fake timers);
- unknown nation (null counts, no board free text);
- valid empty and valid populated snapshots, checked exactly;
- the safe-projection exclusions.

The implementation CLI wrote these tests without running them. The coordinator subsequently audited the imports and
side effects and ran the completed suite: 34 tests, 34 pass, 0 fail, 0 skipped. No real network, key, signature,
transaction, filesystem write or game-world operation was exercised.

## Final coordinator verification (2026-11-17 UTC)

After the implementation session completed, the coordinator ran both suites together: **60 tests, 60 pass, 0 fail, 0 skipped** (adapter 34 + integration 26). All five changed/new JavaScript wiring files passed `node --check`. The integration worktree initially lacked the existing SDK peer dependency; the test run used the already installed local dependencies (`@magicblock-labs/ephemeral-rollups-sdk` 0.17.2 and `@solana/web3.js` 1.99.0), without a package or lockfile change. The real server logic and HTTP handler ran with fixtures only. Live OAuth, board networking, a real MCP client, the game world, deployment and the complete pre-existing regression suite remain untested.

### Official SDK follow-up verification (2026-11-17 UTC)

After the final CLI correction, independent execution passed **65/65 tests**, zero failures/skips (34 adapter + 31 integration, including five SDK/bridge cases). The real `@modelcontextprotocol/sdk` 1.32.1 Client and StreamableHTTPClientTransport performed initialization, tool discovery and calls through injected fetch into the real HTTP handler. Global network fetch was guarded against use. SDK request timeout timers and the server initialization session identifier were exercised; no wallet keys, signatures, external network, socket listener, real OAuth or world process was used. Dependencies were installed from the existing lockfile with lifecycle scripts disabled; package/lockfile contents were unchanged. No live MCP/board/world process was found. Live-world startup remains held because earlier startup refusals are unresolved, not bypassed by these tests.
