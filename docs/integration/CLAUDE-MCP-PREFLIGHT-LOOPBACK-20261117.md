# ③'s MCP preflight: "this machine only" now holds for every request (2026-11-17)

**Branch:** `claude/mcp-preflight-loopback-20261117`, cut from candidate d16048aa.

**Changed:**
- `workstreams/03-composability/mcp/src/preflight.mjs`;
- a new test, `workstreams/03-composability/mcp/test/preflight-loopback.test.mjs`;
- this report.

**Not changed:** auth, HTTP, the game, server, ports and tools (lane D's), `bin/`, the other tests.

**Nothing was run:** no test, server, OAuth registration, ChatGPT setting, network, key or world.

## The defect

The preflight's own contract (its header, and the error the CLI shows) is "a server on this machine only (it registers OAuth clients); `allowRemote` is for an approved deployment". But only the first URL (the MCP endpoint as entered) was checked. The server under test then names every next URL itself, and each was fetched as named:

| Step | URL comes from | Request |
|---|---|---|
| 1 | as entered | `POST` the MCP endpoint |
| 2 | the 401's `WWW-Authenticate: resource_metadata="…"` | `GET` the protected resource metadata |
| 3 | that metadata's `authorization_servers[0]` | `GET {issuer}/.well-known/oauth-authorization-server` |
| 4 | that metadata's `registration_endpoint` | `POST` a client registration (DCR), once per redirect URI |
| 5 | that metadata's `token_endpoint` | `POST` a bad refresh token |

**And `fetch` follows redirects by default.** So a server on this machine could send the preflight to any host, and make it **register OAuth clients there**, against the stated contract.

## The fix (minimal: no new permission)

One helper, `reach(step, target, init)`, now makes every request. Before the request it checks, in order:
1. the target parses as a URL;
2. its scheme is `http:` or `https:`;
3. it carries no user name or password;
4. unless `allowRemote`, its host is in the existing loopback list (`localhost`, `127.0.0.1`, `[::1]`, `::1`; unchanged, not widened).

It sends with `redirect: 'manual'`, and a 3xx answer is a failed check (`<step>: no redirect`).

**On any refusal:** a failed check names the step, and the preflight returns at once (`ok: false`) with nothing after it requested. A refusal's detail never repeats a URL's credentials.

**Also:**
- an `authorization_servers[0]` that is not a string is now a failed check, instead of a thrown `TypeError`;
- a missing `registration_endpoint` / `token_endpoint` is refused before any request, instead of `fetch(undefined)`.

**What did not change:**
- the checks themselves and their names;
- the result shape `{client, url, ok, checks, unverified}`;
- the first URL's existing check (it still throws for a URL off this machine without `allowRemote`);
- the clients and their redirect URIs.

`allowRemote` gains nothing: with it, redirects, credentials in a URL and other schemes are still refused, and only the host check is lifted (as before, for an approved deployment).

**Callers:**
- `bin/wylls-mcp-preflight.mjs` prints the result as before.
- `test/connect.test.mjs` (not run here: it starts a server and uses its fixtures) runs a real loopback server whose URLs are all on this machine, so its chain takes the healthy path, where no check is added.

## The test (written, not run)

`test/preflight-loopback.test.mjs`, 6 cases. A fake `fetch` records each request and answers from a table; an unexpected request throws.
1. A healthy loopback chain still passes. The six requests in order: endpoint, resource metadata, AS metadata, two registrations, token. Every one is sent with `redirect: 'manual'`.
2. A server-named URL off this machine is refused before it is requested, at each step:
   - resource metadata, authorization server, registration, token;
   - an IPv6 host that is not loopback;
   - `0.0.0.0`.

   Nothing outside is requested, and the preflight stops at that check.
3. A redirect (302 on the endpoint, the resource metadata, or a registration) stops it, and the redirect is the last request.
4. Credentials in a URL, `file:` / `ftp:`, or a missing or non-string endpoint: refused before any request, with and without `allowRemote`. A credential never comes back.
5. `allowRemote` adds no permission: a 307 is still refused, and the first URL off this machine is still refused without it.
6. Pinned as text: one `fetch` call in the file, inside `reach`, with `redirect: 'manual'`; the file imports nothing.

**What running it would touch:** it imports `node:test`, `node:assert/strict`, `node:fs` (to read `src/preflight.mjs` for the pin) and `../src/preflight.mjs`, which imports nothing. There is no network, server, file write, key or subprocess. It is not one of the refused tests (`web-frontier-build-walls-items`, `web-frontier-muster-province-full`), not `connect.test.mjs`, not a runner, not a world.

**Not shown by any of this:** that ChatGPT, Claude or Claude Code connect. The preflight never runs a client.

## Static falsification of the fix (2026-11-17)

**Host spellings (WHATWG URL parsing, as Node uses it):**
- `127.0.0.1.nip.io`, `localhost.` (trailing dot), `0.0.0.0`, `[::ffff:127.0.0.1]` and any other host are not in the list, so they are refused.
- `LOCALHOST`, and the numeric spellings of 127.0.0.1 (`0177.0.0.1`, `2130706433`), are normalised by the parser to a listed host. They are this machine, so nothing is widened.

**Redirects:**
- Node's `fetch` with `redirect: 'manual'` returns the 3xx answer itself, which is refused.
- In a browser it would return an opaque response with status 0. That is not refused as a redirect, but it is not followed either, so nothing outside is requested.
- The preflight is a Node command (`bin/wylls-mcp-preflight.mjs`). No change was made for browsers.

**Remaining limits:**
- **DNS:** what `localhost` resolves to (for example, a changed hosts file) is the machine's own setting, as before.
- **The first URL:** if it carries credentials and is on this machine, it passes the existing check, but the preflight refuses to request it. Its `url` field returns it as the caller entered it.
- **`allowRemote`:** it lifts only the host check, as before, and it is meant for an approved deployment.
