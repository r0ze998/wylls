# External AI resident (⑤ option B) — plug your own AI into a local TEST world

**Local TEST worlds only. TEST keys only. No real wallet, no devnet/mainnet, no paid API.**

An *external resident* is a program **you** run, in **your own process**, with **your own key**. It joins a local
play world under the same rules as a person: it signs its own transactions for the same route a human page uses,
reads the same public records, and is refused by the relay and the program exactly as a person is. The world's
operator never sees its key and gives it no privilege. MCP is for **observation only** (read tools; no write tool).

Owner decision (2026-11-18): ⑤ = A (operator AI residents, PR #40) then **B** (this). C — a proxy AI holding a
person's session key — is **not built**.

## What the pieces are

| Piece | Who runs it | What it does |
|---|---|---|
| `permutation-gateway/src/frontier/local-play-launcher.mjs --external-residents <address>[,<address>]` | the world's operator | admits up to two **public addresses**; each new world gives each one the newcomer set-up a second person gets: the player's own funding amount (fees and rent only), a relay pinned to that wallet (payer = actor = sole signer), and a public world proxy of its own |
| `bin/wylls-mcp-local-play.mjs` | the world's operator | the ③ MCP server, **read-only**: only `wylls.read`, only read tools, a link is the resident's own (`agentId` = owner), nothing goes anywhere but reads of the world's public proxy (GETs; in a `--wide` world `get_territory_status` also uses the page's read-only account read on the relay: the resident's own land, tiles and upkeep, other tiles only in its sight) |
| `examples/external-resident/agent.mjs` | **you** | the reference resident: key → discover → observe (herald + MCP) → decide → sign → submit → follow |
| `examples/external-resident/rule.mjs` | **you** | the "mind": a fixed offline rule. **Replace this with your own AI.** |

## Run it (local)

1. Make your TEST key (the file is created `0600`, refused if it exists):

   ```sh
   cd workstreams/03-composability/mcp && npm ci
   node -e "import('./examples/external-resident/key.mjs').then(m => console.log(m.createKeyFile('/path/to/my-resident.json').address))"
   ```

   Give **only the printed public address** to the operator of the TEST world.

2. The operator starts the launcher with `--external-residents <your address>` (natural preset; see the launcher's
   usage), and the read-only MCP server for the world:

   ```sh
   WYLLS_MCP_TEST_AS=1 WYLLS_MCP_PORT=41440 WYLLS_MCP_HERALD=http://localhost:41412 WYLLS_MCP_RELAY=http://localhost:41412/gw \
     node bin/wylls-mcp-local-play.mjs
   ```

3. You start your resident (before or after the owner of the world presses "Start a new world"; it waits):

   ```sh
   node examples/external-resident/agent.mjs --launcher http://localhost:41400 --key /path/to/my-resident.json \
     --mcp http://127.0.0.1:41440/mcp --nation 3 --max-sends 40
   ```

It prints one JSON line per step (`key`, `discover`, `mcp`, `decide`, `act`, `stopped`).

## How it finds, reads and acts — the same routes as a page

- **Discover:** `POST <launcher>/local-play/start {wallet}` with the launcher page's `Origin` — the page's own button.
  An admitted address never starts a world of its own: the answer is `{residentWaiting: true}` until a world has it,
  then `{herald: <your proxy>, external: {role: 'resident'}}`. It cannot stop the world (`403 NotWorldOwner`: a stop
  takes the launcher's owner proof, which only the launcher's own printed address carries, never an address) or read
  the owner's views.
- **Observe:** the public herald through your proxy (`/h/me/<you>`, `/h/status`, `/h/season`, `/h/province/P,Q/latest`
  — the page's reads, decoded with the page's codec; first-home sites by the page's own `homeSites`), and the MCP read
  tools over an OAuth link **you** sign (`get_connection`, `get_village_status`, `check_resource_shortfall`, …). The
  official MCP TypeScript SDK client does the OAuth (discovery, DCR, PKCE S256, resource indicator); your key signs the
  link statement in place of a browser wallet.
- **Act:** the page's own `flocalplay-act.mjs` `submitLocalAct` — context, the game's builder, **one** signature by
  your key, **one** submit to `/gw/f/local-play/act/{context,submit,status}` of your proxy — then `followLocalAct` by
  the signature, never sending it again. Six orders exist: Join, PlaceHome, Harvest, Build, Train, Muster.
- **Muster waits for its province:** the program refuses a Muster with `NotResident` (code 26) until the village's
  province is resolved through the turn before last (`resolvedNext + 1 >= turn`, frontier-abi `prologue::resident_ok`;
  of the six orders only Muster checks it). As the page does, the client reads its own province
  (`/h/province/P,Q/latest`) and the turn (`/h/season` genesis + `/h/status`) first, and waits (`decide` line with
  `hold: "Muster"`) instead of sending; an unread province is held, never guessed. After 5 such rounds in a row it skips
  the Muster for this pass of the rotation (the other orders go on, still one per round) and waits for it again next pass.
- **Refusals by name:** when the relay answers `LocalActRejected` with the program's code (its `program_code`, or the
  runner's `Custom(N)`), the `act` line adds `programCode` and `programError` (the name from the ABI error table, e.g.
  `26` → `NotResident`). `NotResident` is retried on a later turn (`retry: "later turn"`, no cooldown); other refusals
  cool that order down for 3 rounds, as before.
- **Limits:** the relay's and the program's, as for a person. The reference client adds its own (at most
  `--max-sends`, one per `--min-gap-ms`); the world adds none.

## Plug in your own AI

Replace `decide(mem, {obs, homes, nowSecs, village})` in `rule.mjs`. You get:

- `obs` — `{joined, faction, holding: {p, q, site, tile?} | null}` from the public herald;
- `homes` — free first-home sites of your nation (only while you have no village);
- `nowSecs` — the chain's clock (for the Join's session expiry, as the page counts it);
- `village` — MCP `get_village_status` (stores, production, caps) once you have a village;
- `province` — `{bell, resolvedNext}`: the turn and how far your own province is resolved (null fields when unread);
  a Muster sent while `resolvedNext + 1 < bell` is refused `NotResident`.

Return one order `{name, v, fields}` (the page's shapes; see `rule.mjs`) or `{wait: true, why}`. A model, a planner or
a script may sit here; keep any model call outside these TEST worlds' rules (no paid API is used by this repository's
tests). Whatever it returns is only a request: your key signs it, and the relay and the program decide.

A fuller example: workstream ⑬'s resident (`workstreams/13-citizens/resident/local/`) keeps this client's path —
`agent.mjs` exports `discoverWorld` (step 2) and `sendOrder` (step 5, with an optional `sign` hook so a journal can
save the signature before the one submit) — and replaces only the mind: ⑬'s goals and limits, a restart-safe journal
(one action per turn, never sent twice), and reads of its own records from the public herald.

### Optional: workstream 12's public-evidence reader (off unless you call it)

If your AI chooses between other residents (a partner, a trade), it MAY ask workstream 12 what the public records say
about them: `createPublicEvidenceReader({heraldUrl, io})` from `workstreams/12-memory/adapters/public-evidence-reader.mjs`
reads nothing until you call `advise({about: [wallet, …]})`; or run
`node workstreams/12-memory/tools/advise.mjs --herald <your proxy> --about <wallet>[,<wallet>]` from any language.
It is read-only (herald GETs; an RPC `getSlot(finalized)` and workstream 4's store only when you declare them), bounded
(a few counterparties, facts and lines per answer), and returns evidence with its sources — never a decision. Records
it cannot place are `held` (unknown), never "did not". The reference rule does not use it (its six orders have no
counterparty), and the operator residents (⑤ A) never do. See `workstreams/12-memory/13-optional-reader-5b.ja.md`.

## What it cannot do (checked by `e2e/external-resident-probes.mjs` against a running world)

- start, stop or read the owner's world views; get a second world; reach `/operators.json`, `/externals.json`, the
  runner's RPC or time control, the agent-wallet routes (`/gw/f/agent*`), through its proxy;
- write without the page's Origin; have its relay forward a transaction signed by another key, or for another wallet;
  use the owner's relay;
- get a write scope, a write tool, a capability or a link for another wallet from the MCP server;
- on the chain: every transaction it signed has exactly one signature — its own, as fee payer — and is one of the
  signatures in its own log (the only other transaction touching it is the world's newcomer funding).

## Not decided here (blocked on r0ze)

- Whether an external resident must say it is an AI anywhere (Y2's truthful-answer rule is written for operator AI;
  this client has no channel where it could be asked).
- Whether external residents may join a money season, and under which W4-like conditions.
- Q16-2 (two actions per turn per resident): an external resident has **one writer, itself** — MCP is read-only and no
  operator process signs for it — but how many orders one resident may send per turn is a game rule for r0ze.
