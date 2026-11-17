# Cooperation board read adapter (read-only, opt-in, not wired)

`src/coop-read-adapter.mjs` reads one workstream 01 cooperation board
(`workstreams/01-national-strategy/coop/board.mjs`) for one authenticated owner. It returns a fixed, safe
projection. It is **dependency-free** and uses the **fetch the caller passes in**.

## Status: be honest about what this is

- **Not integrated.** No MCP tool is registered. `src/tools.mjs`, the scopes in `src/auth.mjs`, the HTTP server
  and the bin are unchanged. No live MCP support exists. A future authenticated MCP integration can call the
  exported factory and `read()`. That integration (tool entry, schema, wiring the principal and the current world
  from the server's own state, deployment config) is separate work and has not been done.
- **Independently verified after CLI completion (2026-11-17 UTC): 34/34 tests passed.** The coordinator ran
  `node --test workstreams/03-composability/mcp/test/coop-read-adapter.test.mjs` against the completed output.
  The suite uses fake fetch, fake streamed bodies and fake timers only. Both JS files also passed `node --check`.
  This is unit evidence, not real-board, MCP-client or game-world integration evidence.
- **Not a permission source.** The adapter grants nothing. It cannot make `send_caravan` accept another owner's
  place. It derives no recipient or target list, score, selection, role or send authority.
- **Assumed principal shape:** `{owner, scopes}`. Check this against the server's real authenticated principal
  when you integrate. The adapter does not import `auth.mjs`, because its imports reach the gateway, so
  `COOP_READ_SCOPE` (`'wylls.read'`) restates `SCOPES.READ`.

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

## Tests (34/34 independently passed)

`test/coop-read-adapter.test.mjs` covers:

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
