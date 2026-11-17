# Cooperation board read adapter (read-only, opt-in)

`src/coop-read-adapter.mjs` reads one workstream 01 cooperation board
(`workstreams/01-national-strategy/coop/board.mjs`) for one authenticated owner. It returns a fixed, safe
projection. It is **dependency-free** and uses the **fetch the caller passes in**.

Since 2026-11-17 UTC it is wired into the MCP server as the opt-in tool `get_cooperation_status`, which is **off by
default** (see "MCP wiring" below).

## Status: be honest about what this is

- **Real-board contract bug fixed on 2026-11-17 UTC; the corrected output is independently verified, 74/74 passed.** Until this fix the adapter
  required a string nation name and capitalised resource names. The real board sends a numeric zero-based faction
  and lowercase resource names, so the adapter would have answered `malformed` for every healthy real board with a
  verified viewer or any request. All 65 earlier passing tests used invented fixtures (`'North'`, `'Stone'`) and so
  could not see this. See "Real-board contract" below. The coordinator has now rerun the corrected final suites:
  **41 adapter + 33 integration = 74/74 passed, zero failures/skips**, including actual pure coopView/fold output.
  Earlier 34/26/31/60/65 pass counts retained below are historical, not live-board evidence.
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

## Real-board contract (corrected 2026-11-17 UTC)

### What was wrong

The adapter and both test suites were written against fixtures that the implementation session invented, not
against the board's source. Two shapes were wrong, and the adapter enforced the wrong ones:

| field | adapter required (wrong) | the real board sends | source |
|---|---|---|---|
| `view.nation.nation`, `view.personal.nation` | a string name matching `/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/` (fixtures: `'North'`) | the verified Citizen's `faction`: a **number**, zero-based; `null` when unverified | `coop/goal.mjs` `coopView` (`nation: vf.faction`; `personal.nation: vf.status === 'verified' ? vf.faction : null`); `coop/chain.mjs` `citizenOf` returns the decoded Citizen `faction` |
| resource keys in `need`, `myVerified` | capitalised, `/^[A-Z][A-Za-z]{1,15}$/` (fixtures: `Stone`, `Wood`) | lowercase: `food`, `wood`, `stone`, `ore`, `arms`, `gold` | `coop/record.mjs` `RESOURCES`; `needOf` accepts only these keys |

Effect: a real, healthy board was refused as `malformed` (`CoopBoardMalformed`) whenever the viewer's nation was
verified (a number is not a string) or the viewer had any request (lowercase keys failed the capitalised pattern).
Only an unverified viewer with no requests and no verified amounts could have been read. The 65 passing tests did
not show this because their fixtures matched the adapter's wrong expectation, not the board.

### What the adapter requires now

- **Nation:** `nation.nation` is `null` (unknown) or a faction number: `typeof 'number'`, a whole number, `0..5`,
  not `-0`. `0` is the first faction and is a verified nation; it is compared with `null`, never by truthiness.
  Nothing is coerced: `'0'`, `'North'`, `1.5`, `6`, `-1`, `true` are `malformed`. The number is passed through
  unchanged as `nation.nation`. It is the zero-based id; a screen may show it 1-based (`chain.mjs` prints
  `faction + 1`), the adapter does not.
- **The bound 0..5** comes from source, not from a guess:
  - `permutation-rules/src/frontier/geometry.rs`: `pub const FACTIONS: u8 = 6;` ("Player factions"), and
    `valid_faction`: "a player faction `0..=5`, or also `clash::NEUTRAL` (6: barbarians and Free Cities)". A
    citizen's nation is a player faction, so 6 is refused.
  - `permutation-server/web/sdk/frontier/abi-v2-layouts.mjs`: Citizen `FACTION` is a `u8` at offset 136 (so the
    decoder yields an integer), and the per-faction tables are six wide (for example `CAPTURES_BY [u16;6]`).
  - `coop/record.mjs` bounds the declared nation of a record the same way: `isInt(rec.nation, 0, 5)`.
  - Not read: the on-chain program's own join check. `citizenOf` itself does not range-check the decoded byte, so
    a Citizen account holding a faction above 5 (which the rules above do not allow) would be refused here as
    `malformed` rather than shown.
- **`personal.nation`** must be present and strictly equal to `nation.nation` (the board always sends both). A
  missing value is no longer read as `null`.
- **Resources:** keys of `need` and `myVerified` must be one of the six lowercase names exactly
  (`COOP_RESOURCES`). `Stone`, `science`, `influence`, `__proto__` and anything else are `malformed`. Amounts stay
  whole, non-negative (`myVerified`: positive) safe integers; a string amount is not coerced.
- **Fulfilment** (a third fixture mismatch, found while fixing the two above): the board's
  `coop/ws04.mjs` `fulfilmentOf` always returns an object whose `status` is `none`, `fulfilled`, `not-reached` or
  `undetermined`. The old fixtures used `{status: 'Partial'}` and the bare string `'Fulfilled'`, which the board
  never sends (those are names of ④'s per-caravan terminal states). The old adapter happened to accept the real
  shape too, so this did not refuse real boards; it now accepts only the real shape and the four statuses, and
  `mine.requests[].fulfilment` is always one of those four strings (never `null`).

`COOP_FACTIONS`, `COOP_RESOURCES` and `COOP_FULFILMENT_STATUSES` are exported. The adapter still imports nothing, so
these restate the board's constants; the unit suite compares `COOP_RESOURCES` with `coop/record.mjs` `RESOURCES`.

Privacy, bounds and authority are unchanged: the same fixed projection, the same limits, no recipient or target
list, no send authority. One limitation line was added to `COOP_READ_LIMITATIONS` (the nation is a zero-based
number, resource names are lowercase).

### Regression tests with the real coopView (independently passed)

Both suites now import the real `coopView` and `GOALS` (`coop/goal.mjs`) and the real `fold` and `recordId`
(`coop/record.mjs`), and build the `/coop/view` body the way `coop/board.mjs` `view()` does
(`{...coopView(...), heraldFeed, chain, damaged, contexts, store}`).

- **Not `createBoard`:** it creates the data directory and may write `observed.json`. No board process, HTTP
  server, socket, RPC or herald is started.
- **State:** the real `fold` of three unsigned fixture records (two requests with lowercase needs, one response).
  `fold` checks shape and state, not signatures; the board's signature check (`verifySig`) is not exercised. No
  `link` or `sending` records and no herald file, so neither `fold` nor `coopView` derives an address.
- **Nationality:** `checks.citizens` is given in the shape `citizenOf` returns (`{status: 'verified', faction: 0}`),
  keyed as `coopView` looks it up. `citizenOf` itself (an RPC read and account decode) is not called.
- **Cases:** verified nation `0` with lowercase needs (exact projection, no leaks, no authority fields); unknown
  nationality (status `unknown`, null counts, the board's Japanese `why`/`note` not copied); in the unit suite
  also an empty real board for each faction `0..5`. The integration suite passes the verified and unknown views
  through the real adapter and the real `createWyllsMcp(...).handle`.

What this still does not prove: a live board over HTTP, a real Citizen account decoded by `citizenOf`, arrivals
(`counted`) from real chain logs, or a game world.

### Other mismatches noticed (reported, not all changed)

- **Resource naming differs inside this server.** The board uses lowercase names; this server's caravan tools use
  capitalised names (`Food`, `Wood`, … in `src/tools.mjs` `cargoSchema` and `src/server.mjs`), and they also have
  `Science` and `Influence`, which the board does not. `get_cooperation_status` passes the board's lowercase names
  through. A client must not feed a cooperation `need` straight into `prepare_caravan` cargo. Not changed
  (outside the four files); the added limitation line says it.
- **`COOP_TOOL.description`** (`src/tools.mjs`) does not say that the nation is a number. Not changed (outside the
  four files).
- **Need amounts:** the board accepts `1..100000` per resource (`record.mjs` `MAX_QTY`); the adapter accepts any
  non-negative safe integer. Looser, never refuses real data. Not changed.
- **Request `state`:** the board sends `open`, `cancelled` or `expired`; the adapter accepts any short word. Looser,
  never refuses real data. Not changed.
- **Hand-written fixtures remain simplified** (ids like `req-000001`, a `g-vault` goal, arrival entries without
  the board's full fields). They no longer contradict the board's types, but only the real-coopView tests are
  evidence about the board's actual output.

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
- **One deliberate dispatch difference (review fix, 2026-11-17 UTC):** `tools/call` runs `archiveFinished()` (which may
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
  3. Read `game.context({fresh: true})` and require `{programId, seasonId}` consistent with its `key`. If it can't be
     read, the answer is `ContextUnavailable` (retryable). (Before 2026-11-18 this was a plain `game.context()`; see
     "Game context cache hole" below.)
  4. Call `adapter.read({principal: {owner, scopes}, context: {programId, seasonId, cluster: <configured>}})`. The
     viewer is always the authenticated owner. The world is always the server's current context plus the
     configured cluster. The caller chooses neither.
  5. Read `game.context({fresh: true})` again. If it is now another world, or can't be read, the answer is
     `ContextChanged` (retryable) and nothing is shown.
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

### Game context cache hole (independently verified 2026-11-17 UTC)

**What was wrong.** Steps 3 and 5 called `game.context()`, but the real `src/game.mjs` `Game.context()` reuses a relay
read for `contextTtlMs` (15 s). Within that window the "after" call returned the cached "before" answer without asking
the relay, so a world switch during the board read could never be seen. The coordinator reproduced this with the real
`Game`, a fake fetch and a fixed clock: before = season 3, the relay switches to 4, after = still 3, relay fetched
once. The fixture `fakeGame` in the integration suite answered each call afresh, so the 74 passing tests could not
show it.

**The change (`src/game.mjs`, `src/server.mjs`).**

- `Game.context({fresh = false} = {})`. `{fresh: true}` skips the TTL reuse and reads `GET /f/season` now. Without it
  (every other caller: `get_connection`, `resume`, `track`, `season()`/`view()`) the cache is unchanged.
- `get_cooperation_status` uses `{fresh: true}` at both boundaries; nothing else in the server changed.
- Publication is still build-first: the new context, addresses, herald pin, change history and `pinnedAt` are
  published together only after `addressesFor` succeeded. A failure leaves all of them as they were.
- **Overlapping reads** (corrected after review, 2026-11-18). Each relay read takes a number when it starts; a read
  *settles* when its relay call comes back, whatever the outcome (published, transport failure, non-200, unreadable
  answer, addresses not built). A read that settles after a read started later has already settled never publishes.
  It returns the published context only when that publication is the newest settled read's own
  (`contextPublishedSeq === contextSettledSeq`); otherwise it throws `ContextUnavailable` (retryable). So it never
  falls back to a world from before the latest failed observation (the first version did: it returned an older
  publication after a newer read failed to build, and a newer read's transport/HTTP failure did not count at all).
  A read that starts after a failure and succeeds publishes as usual. The guard applies to every read that reaches
  the relay; the TTL reuse of a published context (default callers) is intentionally unchanged.
- Fail closed: a relay failure at the first boundary is `ContextUnavailable` with no board read, even when a cached
  context exists; at the second it is `ContextChanged` with no data.

**Limits, honestly.**

- A fresh read is one observation of the relay at one moment. The two observations bracket the board read; they do
  not lock the remote world and are not linearizable with it. A switch and switch-back between the two reads, or a
  switch right after the second, is not seen. The board's own world is checked separately by the adapter.
- The relay itself may serve a stale or cached season; this change only removes this server's own 15 s reuse at the
  two boundaries.
- After a failed build, a default (non-fresh) `context()` within the TTL still returns the old cached context without
  asking the relay: that is the unchanged default cache semantics, not new behaviour.
- There is no remote lock and no "latest world" guarantee: the guard orders this process's own reads by start, it
  says nothing about the order in which the relay served them or what the relay serves now. After a failed newest
  read, overlapping older reads fail closed until a new read succeeds; a plain (non-fresh) call within the TTL
  still answers from the published cache.

**Regression tests** (end of `test/coop-read-integration.test.mjs`, real `Game` with a fake relay fetch answering only
`GET /f/season`, a fixed clock, `addressesFor` returning constants, `herald.pin` wrapped to record calls; no herald
request, no address derivation, no network). Written by the implementation session and **not executed by it**:

1. default `context()` still caches within 15 s (the reproduced hole), `{fresh: true}` sees the switch and publishes
   context, addresses, pin and history together; default caching resumes and re-reads after the TTL;
2. through `get_cooperation_status`: no switch is ok with two relay reads; a 3 → 4 switch during the board read is
   `ContextChanged` with no data; a warm season-3 cache does not stand in for the first boundary (`CoopBoardMismatch`;
   three relay reads: the warm one and both boundaries — the expectation of 2 was wrong and was corrected after the
   coordinator's run);
3. initial relay failure (transport, HTTP 503; cold and warm cache): `ContextUnavailable`, zero board fetches;
4. final relay failure (transport, HTTP 500): `ContextChanged`, no data;
5. addresses for the new context that cannot be built: old context, addresses, `pinnedAt`, pin and history kept,
   directly and through the tool at either boundary;
6. an older overlapping read answering last returns the newer context and does not re-pin; in-order reads publish as
   before;
7. an older read answering after a newer read that could not publish throws `ContextUnavailable`, old state kept;
8. exactly three overlapping reads: B publishes 4, C answers 5 but its addresses fail, then A answers 3: A throws
   `ContextUnavailable` (neither B's 4 nor its own 3); a later read recovers;
9. two overlapping reads where the newer fails at the relay (transport; HTTP 503): the older's answer is not
   published (`ContextUnavailable`), old state kept; a later successful fresh read recovers and publishes.

Coordinator run before the review fix: 81 tests, 80 pass, 1 fail (the relay-read count in case 2). The fix and
cases 8–9 were subsequently independently executed on the final output: **83/83 passed** (41 adapter + 42 integration), zero failures/skips.

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
| missing or ill-typed fields; a nation that is not `null` or a faction number `0..5` (no coercion); `personal.nation` missing or not strictly equal to `nation.nation`; a resource name that is not one of the board's six lowercase names; a fulfilment that is not the board's `{status}` object with one of its four statuses; an owner's request not among `view.requests`, not the owner's, or duplicated; an owner's response the board does not record; an entry of another responder listed as the owner's; non-integer amounts | `malformed` |
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
    nation: 0|1|2|3|4|5|null,           // the board's zero-based faction number (0 is a nation); null when unknown
    requests: number|null,              // null when unknown, never 0 for unknown
    deliveredFromNation: number|null,
    note: string|null,                  // fixed adapter text; the board's nation.why/nationWhy is never copied
  } | null,
  mine: {
    // resource = 'food'|'wood'|'stone'|'ore'|'arms'|'gold' (the board's lowercase names)
    requests:  [{ id, state, need: {resource: whole}, entries: { listed, counted },
                  fulfilment: 'none'|'fulfilled'|'not-reached'|'undetermined' }],
    responses: [{ id, responded: true, myEntries: { listed, counted } }],
    verified:  { resource: positive whole },   // board's myVerified (counted arrivals the owner delivered)
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
- `fulfilment` is the `status` of the board's fulfilment object. `fulfilled` and `not-reached` are the board's
  proofs from counted lower and upper bounds; `undetermined` and `none` assert nothing. Any other shape is
  `malformed` (changed 2026-11-17 UTC; before, an unrecognised object became `null`).

## Tests

**Read this first:** the pass counts in this section and in the two verification sections after it are historical.
They were obtained with the pre-fix fixtures (string nation, capitalised resources). After the 2026-11-17 UTC fix the
adapter suite has 41 tests: the earlier 34 with corrected fixtures, 4 new contract tests (faction numbers `0..5`;
wrong nation types and bounds; resource names; fulfilment shape) and 3 real-coopView tests. The integration suite
has 33: the earlier 31 with corrected fixtures (three malformed cases added to an existing test) and 2
real-coopView tests. The coordinator executed the final corrected suites: 74/74 passed, zero failures/skips.
On 2026-11-18 nine real-`Game` context tests were added to the integration suite (42 written there now; see "Game
context cache hole"). The coordinator's run of the first seven gave 81 tests, 80 pass, 1 fail; the corrected
expectation, the overlapping-read fix and the two new tests were subsequently rerun: **83/83 passed**, zero failures/skips.

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

#### Official SDK transport tests (added 2026-11-17 UTC, written, NOT executed)

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

## Historical pre-fix coordinator verification (2026-11-17 UTC)

After the implementation session completed, the coordinator ran both suites together: **60 tests, 60 pass, 0 fail, 0 skipped** (adapter 34 + integration 26). All five changed/new JavaScript wiring files passed `node --check`. The integration worktree initially lacked the existing SDK peer dependency; the test run used the already installed local dependencies (`@magicblock-labs/ephemeral-rollups-sdk` 0.17.2 and `@solana/web3.js` 1.99.0), without a package or lockfile change. The real server logic and HTTP handler ran with fixtures only. Live OAuth, board networking, a real MCP client, the game world, deployment and the complete pre-existing regression suite remain untested.

### Historical pre-fix official SDK verification (2026-11-17 UTC)

After the final CLI correction, independent execution passed **65/65 tests**, zero failures/skips (34 adapter + 31 integration, including five SDK/bridge cases). The real `@modelcontextprotocol/sdk` 1.32.1 Client and StreamableHTTPClientTransport performed initialization, tool discovery and calls through injected fetch into the real HTTP handler. Global network fetch was guarded against use. SDK request timeout timers and the server initialization session identifier were exercised; no wallet keys, signatures, external network, socket listener, real OAuth or world process was used. Dependencies were installed from the existing lockfile with lifecycle scripts disabled; package/lockfile contents were unchanged. No live MCP/board/world process was found. Live-world startup remains held because earlier startup refusals are unresolved, not bypassed by these tests.

### Final corrected-contract verification (2026-11-17 UTC)

After the official Opus task finished, the coordinator reran both corrected suites: **74 tests, 74 pass, 0 fail, 0 skipped**. Adapter 41, integration 33. All three modified JavaScript files passed syntax checks. This includes real pure coopView/fold-produced records passing through the adapter and MCP dispatch, plus the official SDK client/transport fixtures. No board server, world, actual OAuth, wallet signature or external network was run. The code remains opt-in and off by default.

### Final world-cache correction verification (2026-11-17 UTC)

After the official Opus session completed, independent validation passed **83/83 tests** (adapter 41 + integration 42), zero failures/skips. Syntax checks passed for game.mjs, server.mjs and coop-read-integration.test.mjs; the tracked source diff passed whitespace checks. The two review-discovered concurrency fallbacks are covered by deterministic, injected relay fixtures. No real network, socket, world process, wallet key, signature, or address derivation was exercised. Fresh observations are not a lock on the remote world.
