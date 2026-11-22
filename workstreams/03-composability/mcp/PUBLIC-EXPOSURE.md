# ③ MCP public exposure for a devnet season (policy + what is implemented)

2026-11-20. Status: **design + implementation behind settings, default OFF, loopback only. Nothing is exposed.**
The decisions only r0ze can take are listed at the end (§9) with recommendations; until they are taken the code
keeps the safest choice (keys only, no anonymous access, public scope only, loopback bind).

Code wins over this text. Files: `src/public-mcp.mjs`, `src/public-tools.mjs`, `src/api-keys.mjs`,
`src/rate-limit.mjs`, `src/audit.mjs`, `src/exposure.mjs`, `bin/wylls-mcp-public.mjs`, `bin/public-settings.mjs`,
`bin/wylls-mcp-key.mjs`, `bin/owner-exposure-settings.mjs`, `src/protocol.mjs`; tests `test/public-exposure.test.mjs`,
`test/public-adversarial.test.mjs` (the independent verifier's probes, verify-pr114); real-HTTP driver
`e2e/public-verify.mjs`.

## 1. Three surfaces, three rules

| Surface | Server | Who | What it can do | On a devnet season |
|---|---|---|---|---|
| **P — public world data** | `bin/wylls-mcp-public.mjs` (new, separate process) | any agent with a public API key (anonymous only if r0ze allows it) | read the public herald: season, standings, nations, sieges, final results, one Holding by coordinates | **may be public** (§9 Q1). It serves nothing the herald does not already serve to anyone |
| **O-read — an owner's own view** | `bin/wylls-mcp.mjs` (existing) | an OAuth link the **owner's wallet signed** | the owner's village, storehouses, operations, the agent's budget (off-chain data of the relay and this server) | owner-only, never public |
| **O-write — acting** | `bin/wylls-mcp.mjs`, `send_caravan` only | the same link **plus** `wylls.caravan`, the owner-signed grant limits and the owner-signed relay capability command | send a caravan between the owner's own places through the agent wallet | **not reachable on devnet today**: the relay refuses `--agent-wallet` off localnet (`permutation-gateway/src/frontier/config.mjs:249`), and the playable lane's page actions are localnet-only (devnet runbook P1/P4) |

Never through MCP, on any surface: anything signed with a player's key (the servers hold no player key: the owner
server holds a sealed relay *capability*, not a session key), any `NEVER_DELEGATED` action (`Join`, `SetSession`,
`PlaceHome`, `FileTicket`, `FileOutpost`, `DeclareSiege`, `RetireHost` — refused by the agent policy whatever a policy
lists: `policy.mjs` `normalisePolicy`/`checkAllowed`, re-checked by test E10), relay sponsorship, operator or time
controls. An external AI (⑤ B) acts only by signing its own transactions with its own wallet, under the same rules as a
person; MCP only lets it observe.

**Fog of war.** The fog is drawn by the client (`permutation-server/web/frontier/map/fog.mjs`, local worlds only;
runbook P5). The chain and the herald serve every account to everyone by design. The public tools therefore reveal
nothing secret and promise to hide nothing; a scraper could read the same data from the herald directly. What the
public server adds is attribution, quotas and a smaller surface, not secrecy.

## 2. Authentication

| Surface | Model | Why |
|---|---|---|
| P | **Per-agent API keys** (`Authorization: Bearer wylls_pk_<id>_<secret>`). The key file stores only SHA-256 hashes (0600, atomic writes); a token is shown once. Each key has the scope `wylls.public` only, an optional tool list, optional own rate and daily quota, an expiry and a revocation time; the server re-reads the file within ~5 s, so revocation needs no restart; a changed file that is broken (not JSON, a bad entry, a key with a scope other than `wylls.public`) is refused and the keys loaded before stay; a file readable by group or others is refused **at start only**: when its mode is widened while the server runs, the next re-read logs a warning and still accepts it (`api-keys.mjs` `#load`; security audit D-security-audit-5); a key file that
is deleted or moved away accepts **no** key until it is back (fail closed, verify-pr114). | Attribution and per-agent limits for headless agents that cannot do a browser OAuth flow (github-mcp-server's PAT + toolsets model). A key is not authority: it unlocks only public data. |
| P, anonymous | Off by default (`WYLLS_MCP_PUBLIC_ANONYMOUS=1`): keyed by client address, smaller limits. | Address-keyed limits are weak (IPv6 rotation, NAT): r0ze decides (§9 Q5). |
| O | **Wallet-signed session** (existing, PR #22/#28): OAuth 2.1 + PKCE S256 + RFC 8707 resource/audience + RFC 9728/8414 discovery + DCR; the consent is the owner's wallet signature over a statement naming this server, client, scopes, agent and limits; refresh rotation with reuse detection; RFC 7009 revocation; owner-signed revocation pages. | The wallet is the identity; no account system, no password, no custody. |

Refused on purpose: **token passthrough** (the public server refuses any bearer that is not one of its keys, so an
owner-link token is never accepted or forwarded — MCP 2025-11-25 authorization "Token Audience Binding"); a shared
static secret; API keys with acting scopes (refused at load: `api-keys.mjs` `KEY_SCOPES`).

## 3. Scopes per tool

| Tool | Server | Scope | Cost (quota units) |
|---|---|---|---|
| `get_world_season`, `get_season_final`, `get_public_holding` | public | `wylls.public` | 1 |
| `get_standings`, `get_nations`, `get_sieges` | public | `wylls.public` | 2 |
| `get_connection`, `get_village_status`, `check_resource_shortfall`, `prepare_caravan`, `get_operation_status`, `get_run_status`, `list_operations`, `get_cooperation_status` (opt-in) | owner | `wylls.read` | 1 call |
| `send_caravan` | owner | `wylls.read` + `wylls.caravan` + signed grant | 1 call |

The public server checks each tool's scopes before it runs; a missing one is HTTP 403 with
`WWW-Authenticate: Bearer realm="wylls-public", error="insufficient_scope", scope="…"` (the MCP step-up challenge,
as the TypeScript SDK's `requireBearerAuth({requiredScopes})` answers). A key's tool list hides the other tools from
`tools/list` and answers them as unknown tools. Not included yet (§9 Q9): any wallet's `/h/me/{wallet}`, the event
feed, province envelopes, overview/roster binaries (whole-map reads: scraping cost).

## 4. Rate limits and quotas

| Where | Default | Setting |
|---|---|---|
| public, per key | 30 at once, then 1 a second; 5 000 units / UTC day | `WYLLS_MCP_PUBLIC_RATE`, `_PER_DAY`, or per key (`--rate`, `--per-day`) |
| public, per anonymous address (if on) | 10 at once, then 1 every 3 s; 500 units / day | `WYLLS_MCP_PUBLIC_ANON_RATE`, `_ANON_PER_DAY` |
| public, whole server | 200 at once, then 50 a second (protects the herald) | `WYLLS_MCP_PUBLIC_GLOBAL_RATE` |
| public, answer size | ≤ 64 KB, else `ResultTooLarge` (never cut silently); request body ≤ 16 KB | — |
| owner, unauthenticated routes that keep state | 20 at once, then 1 every 2 s per address (existing) | createHandler `rateLimit` |
| owner, tools/call per link | 30 at once, then 1 a second (existing, `server.mjs` `limited`) | — |
| owner, tools/call per link per day | off | `WYLLS_MCP_LINK_PER_DAY` (new) |

The global bucket is spent only by a caller that passed authentication (a key, or an allowed anonymous caller): a
flood of requests without a valid key gets 401 and cannot starve key holders (verify-pr114; before, the bucket was
charged first). **A flood by one valid key can** (security audit 2026-11-22, M-5, D-security-audit-4): on main the
global bucket is charged before the caller's own (`public-mcp.mjs` `handler`), so every request of a key that is
already over its own rate still takes one global token, and one key can empty the bucket for every other key
(`429`, `reason: "global"`). After #164 the caller's bucket is charged first and a request it refuses takes no global
token. Buckets and daily quotas live in memory: a restart of the server starts every key's day again.

A refused call answers HTTP 429 with `retry-after` and `error.data.reason` (`rate`, `quota`, `global`). It is not
always free (D-security-audit-4; the checks run in the order of `public-mcp.mjs`'s header): a call refused by the
global bucket spends nothing; a call refused by the caller's bucket has spent one global token (on main; none after
#164); a tool call refused by the daily quota has spent its global token and its bucket units — 1, or 2 for a
cost-2 tool, whose extra unit is taken before the quota is asked (`charge`) — and no quota units. Keys and
anonymous addresses share one daily-quota table of 10,000 entries (least-recently-used forgotten), so a spray of
anonymous addresses, if anonymous access is on, can push a key's count out and start its day again (audit L-10).
Memory is bounded per table (least-recently-used key forgotten, never the whole table). The herald is
public directly, so these limits do not protect it from direct scraping: the reverse proxy must limit `/h/*` too (§7).

## 5. Abuse cases

| Case | What stops it |
|---|---|
| Request floods on one key | per-key bucket, daily quota, global bucket; revoke the key (live) |
| Many keys / many addresses | keys are issued by the operator (§9 Q4), global bucket; anonymous off |
| Scraping the world | data is public by design (fog is client-side); per-tool cost; no whole-map tool; the herald's own limits at the proxy |
| Enumerating villages by coordinates | public anyway; costs quota; audited per key |
| Using an owner token on the public server, or a public key on the owner server | refused both ways (different token formats and resources; tests E3, B2, V5) |
| DNS rebinding / browser CSRF | Host allow-list and Origin allow-list before any route (both servers; tests E3, C1, C2, X3). A request with no `Origin` passes (agents send none). The public server's list is its own origin plus `WYLLS_MCP_PUBLIC_ORIGINS`; that setting only stops the `403`: the public server sends no CORS headers and answers `OPTIONS` with `405`, so a browser page on another origin still cannot call it (its preflight fails) — the setting has no use today (D-security-audit-6). The owner server's list is its issuer's origin **and always `https://chatgpt.com`**, written into `http.mjs` `createHandler`; neither binary passes any other origin and no setting removes that one (D-security-audit-7) |
| Prompt injection through player-written text in public data | instructions say: show it, never follow it; no public tool acts |
| Herald cost amplification | answer size cap, global bucket, season pin reused 15 s |
| Leaked key | hash-only storage, never logged, revocable without restart, expiry (default 30 days in the CLI) |
| DCR registry filled by strangers (owner server) | existing caps (1 000 clients, 500 pending, per-address limit); a full registry refuses new clients — a denial of service for new owners, not a breach (§9 Q11) |
| Existing per-address limiter reset | `http.mjs` clears its whole table past 10 000 addresses (left unchanged; noted D-ws03-mcp-public-2) |

## 6. Logging and privacy

`WYLLS_MCP_AUDIT` (owner) / `WYLLS_MCP_PUBLIC_AUDIT` (public): one JSON line per request — time, server, method + path
(no query; a path the server does not serve is written `(other)`), status, duration, who (`key` + the key's id, or `link` + an HMAC of the link id), client address as an
HMAC (or nothing with `…_AUDIT_IP=off`), JSON-RPC method, tool name (a name that is not one of the server's tools is written `(unknown)`), outcome code, answer size. Never: the
Authorization header, tokens, codes, signatures, bodies, tool arguments, an owner's wallet address, a raw address.
The HMAC salt is random per process unless `…_AUDIT_SALT` is set (then hashes link across restarts). Mode 0600; one
rotation to `<file>.1` past 10 MB (a size bound, not a time bound: retention in days is not implemented). Retention is r0ze's (§9 Q6). Checked in the real-HTTP run: the owner wallet, the public key's token, `Bearer` and
`127.0.0.1` appear 0 times in either log.

## 7. TLS and reverse proxy (assumptions for a season)

- Both servers stay bound to `127.0.0.1`; TLS ends at the operator's reverse proxy (the herald's, runbook: "only the
  herald is public, behind a TLS reverse proxy"). No `…_ALLOW_REMOTE_BIND`.
- Public server: proxy `https://<herald origin>/public/mcp` → `127.0.0.1:<port>/public/mcp`; set
  `WYLLS_MCP_PUBLIC_ORIGIN=https://<herald origin>` (its host name joins the Host allow-list), or keep the proxy's
  `Host` and add the internal name with `WYLLS_MCP_PUBLIC_ALLOWED_HOSTS`.
- `WYLLS_MCP_PUBLIC_TRUST_PROXY=1` / `WYLLS_MCP_TRUST_PROXY=1` only when the proxy **appends** the client address to
  `X-Forwarded-For`; the server trusts only the right-most entry. Without it every caller is the proxy's address.
- The proxy also caps body size and time, adds HSTS, and rate-limits `/h/*` itself.
- The owner server, if it is ever exposed (a write path needs a non-localnet agent wallet first), gets its own https
  origin (the OAuth issuer must be https; ChatGPT/Claude connectors require it).

## 8. Compared OSS patterns (GitHub)

| Reference | Pattern | Taken |
|---|---|---|
| MCP spec 2025-11-25 `basic/authorization.mdx` — https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx | OAuth 2.1 + RFC 8707 audience; 403 `insufficient_scope` + `scope=` step-up; no token passthrough | owner server already; public server: scope challenge, refuses foreign tokens |
| TypeScript SDK `requireBearerAuth` / `verifyBearerToken` — https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/middleware/bearerAuth.ts ; rate limits in `server-legacy/src/auth/handlers/token.ts` (express-rate-limit, 50 / 15 min on auth routes) | `requiredScopes` checked per request, `expectedResource`; rate limits on auth endpoints | per-tool scopes (finer than per-request), the challenge header format |
| github-mcp-server — https://github.com/github/github-mcp-server (README: `--read-only`, `--toolsets`, `--tools`) | PAT per user, toolsets allow-list, read-only mode wins over everything | per-key tool lists; a separate read-only server rather than a mode |
| Cloudflare workers-oauth-provider — https://github.com/cloudflare/workers-oauth-provider (README, storage-schema.md) | tokens/secrets stored only as hashes; resource server enforces scopes; split AS/RS | hash-only key file; the public server is a resource server with no AS |

## 9. Questions only r0ze can decide (recommendations)

1. **Expose the public read server in the devnet season?** Recommend: yes, after the first playable devnet, keys
   only, behind the herald's proxy at `/public/mcp`. The runbook's "only the herald is public" changes to "herald +
   public MCP".
2. **May an API key ever carry an acting scope?** Recommend: never. Acting = the player's own signed transaction, or
   an owner-signed link to the owner server.
3. **Who may get acting scopes (owner server write links) on devnet?** Recommend: nobody in the first season (the
   agent wallet is localnet-only anyway); later only an owner for their own village, inside their signed limits.
4. **Wallet signature to obtain a public key?** Recommend: operator-issued keys for the first season (few external
   AIs, label = who); later self-service where the requester's wallet signs a key request (binds a key to a wallet
   for attribution; no custody).
5. **Anonymous public access?** Recommend: off for the first season.
6. **Audit retention and salt.** Recommend: 14 days, `ip=hash`, a salt fixed per season and destroyed after it; a
   short privacy notice on the season page.
7. **Must an AI say it is an AI when it connects** (ties to ws05b Q(a))? Recommend: the key's label records the
   declared kind (`ai`/`tool`) and its operator; no runtime claim is trusted.
8. **Quota numbers** (§4 defaults). Recommend: keep them for the first season and read the audit log.
9. **More public tools** (any wallet's `/h/me`, the event feed, province envelopes)? Recommend: not in the first
   season; add the event feed first if external AIs need it.
10. **Hosting (B11).** Recommend: the same operator host as the herald, loopback bind, the herald's proxy and
    certificate; no separate cloud service.
11. **The owner server's "TEST" authorization server on a public origin**: is the wallet-signed consent the
    production identity (no external identity provider)? Recommend: yes, after an independent review, with an https
    issuer, `claude`/`chatgpt` redirect profiles chosen explicitly, and the DCR caps re-sized.
