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

## One run of the test (2026-11-17, at 5dc7ab6a)

**Command, from the repository root, run once:**

```
/opt/homebrew/opt/node/bin/node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test workstreams/03-composability/mcp/test/preflight-loopback.test.mjs
```

**Checked just before:**
- HEAD `5dc7ab6a`, equal to the remote;
- `test/preflight-loopback.test.mjs` sha256 `6134ee14f0d9bb72…`, `src/preflight.mjs` `55070d74b45f6497…`, both as committed;
- the guard `workstreams/12-memory/tools/nokey-guard.mjs` `cf4518176289a45755a831140c85705093e9352825d3a6e80c75d91cf4f9862f`, unchanged (built-ins only);
- Node v23.11.0 (`01ca46d5dbf4e6fd…`);
- `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TEST_CONTEXT`, `LD_PRELOAD`, `LD_LIBRARY_PATH` and the `DYLD_*` preload variables all unset;
- no other `node --test` running;
- 48.8 GiB free;
- the worktree status recorded (the unstaged media deletions, which are not this work's), nothing staged.

**Not involved:** `connect.test.mjs`, the refused gateway tests, WS13's guard, any runner or world, any HTTP, OAuth registration or key.

**Result, 02:16:34 (+0900):**
- **6 / 6 passed**, `rc=0`, 46 ms, no warning:
  - the healthy loopback chain;
  - off-machine URLs refused at every step;
  - redirects stop it;
  - credentials, other schemes and missing URLs refused;
  - `allowRemote` adds no permission;
  - the one checked fetch path.
- **After:** no test process left, the status identical to before, nothing staged, 48.8 GiB free.

**Limits:** a fake `fetch` only. Nothing about a real MCP server, OAuth server, ChatGPT, Claude or Claude Code.

## Before a real ChatGPT connection: what ③'s MCP entry needs, and what is missing (2026-11-17, read only)

**Read, not changed:** `workstreams/03-composability/mcp/bin/wylls-mcp.mjs`, `bin/wylls-mcp-preflight.mjs`, `src/auth.mjs`, `src/http.mjs`, `README.md`. The game, server, ports and tools are lane D's. The README says plainly that it "has not been tried in ChatGPT".

**What the launcher (`bin/wylls-mcp.mjs`) needs:**
- `WYLLS_MCP_RELAY` (a relay with the agent wallet on) and `WYLLS_MCP_HERALD`.
- `WYLLS_MCP_ISSUER`: the public origin. The server listens on `127.0.0.1` over HTTP, and the comment says the HTTPS origin comes "behind a tunnel". `resource` is `${issuer}/mcp`.
- `WYLLS_MCP_TEST_AS=1`, without which it exits: "only the local test authorization server is implemented".
- `WYLLS_MCP_STORE` with `WYLLS_MCP_SEAL_KEY` (it exits without the key).
- `WYLLS_MCP_REDIRECT_PROFILES`, which defaults to `chatgpt,loopback`.

**What the authorization server offers ChatGPT** (`src/auth.mjs`):
- protected resource metadata, and `WWW-Authenticate` on 401;
- authorization server metadata with PKCE `S256` only;
- DCR (`/oauth/register`) and public clients;
- `authorization_response_iss_parameter_supported: true`;
- refresh-token rotation;
- ChatGPT's redirect URIs.

CIMD (ChatGPT's preferred registration) is not implemented; DCR, which ChatGPT still supports, is.

**The consent step:** `GET /oauth/authorize` serves a consent page (`src/http.mjs`) on which a browser wallet signs with `signMessage` (`window.solana` / Phantom); no key is typed. The test authorization server has no accounts: it authorizes a link the owner's wallet signs.

**Missing or unverified, each a decision rather than a code fix:**
1. **How ChatGPT reaches the server.** *Corrected 2026-11-17:* an earlier version of this item said a public HTTPS origin was required, which was too strong. The owner cites OpenAI's guide (`developers.openai.com/api/docs/guides/custom-mcp-server`), which describes a Server URL and also a Secure MCP Tunnel path; that page was not read here (no network).
   - **What this repository implements:** the server listens on `127.0.0.1` over HTTP, and `WYLLS_MCP_ISSUER` names the origin it advertises (the launcher's comment: "https behind a tunnel for ChatGPT").
   - **What it does not include:** any tunnel, any deployment, or any configuration for either path.
   - **Not verified:** which path fits this server (its issuer and resource URL must match what ChatGPT is given) and how. This is a decision.
2. **A production identity or authorization server.** `auth.mjs` says "a production deployment would put this behind a real identity provider", and only the test one exists. Whether the wallet-signed link may be used against ChatGPT is a policy decision.
3. **The wallet in ChatGPT's OAuth window.** The consent page needs a browser wallet extension in whatever browser ChatGPT opens for OAuth. A desktop browser with the extension can, but a mobile app's in-app browser may not. Unverified.
4. **Which ChatGPT plans and roles may add a custom MCP server.** The preflight already lists this as unverified.
5. **An independent gap in an adopted contract: the shipped preflight command cannot check the public deployment.**
   - The library's contract is "`allowRemote` is for an approved deployment".
   - But `bin/wylls-mcp-preflight.mjs` passes only `{client}`. So it refuses any URL that is not on this machine, and on loopback the `chatgpt` profile fails the scheme check "by design".
   - So there is no shipped way to preflight a deployment off this machine (whichever path reaches it).
   - **Candidate (not done):** an explicit `--allow-remote` flag on that command, never a default, used only for an approved deployment. It would get the same per-request checks, with redirects refused. This changes the command's interface (`bin/`, ③'s area), so it needs a decision.

Nothing here was run, published, configured in ChatGPT, or connected to any account.

## The preflight command: `--allow-remote`, JSON errors and exit codes (2026-11-17, written, not run)

**Changed:** `workstreams/03-composability/mcp/bin/wylls-mcp-preflight.mjs` (now an exported `main(argv, {print, warn, fetch})`, run when it is the entry script), and a new `test/preflight-cli.test.mjs`. `src/preflight.mjs` is unchanged by this step.

### Before, read statically

| Case | Old behaviour |
|---|---|
| no URL | usage on stderr, exit 2 |
| extra arguments | silently ignored (`url --allow-remote` made `--allow-remote` the client) |
| unknown client, a URL that does not parse, a URL off this machine, a failed request | the library throws, nothing catches it: **a stack trace and exit 1**, the same code as "a check failed", and no JSON |
| a URL off this machine for an approved deployment | no way to give `allowRemote`: the library's opt-in had no command-line form |

### Now

- **Arguments:** `<mcp url> [claude-code|claude|chatgpt] [--allow-remote]`.
  - The only flag is exactly `--allow-remote`, given at most once; any other flag, a second flag, extra or missing positionals, an unknown client, or a URL that does not parse is usage.
  - Usage means exit 2, on stderr, with nothing on stdout and nothing requested.
- **Output and exit codes:**
  - one JSON document on stdout;
  - exit 0 when every check passed;
  - exit 1 when a check failed, or when the preflight stopped with an error, printed as `{client, ok: false, error}` (for example the library's "this machine only" refusal, or a request that failed). A request that failed after others were made (registrations) is not undone, and the command says so in its header.
- **`--allow-remote`** passes `allowRemote: true` to the library, **and nothing else.**
  - It lifts the "on this machine" check for the URL given and for every URL the server under test names. Every request is still checked first (http or https, no credentials), redirects are still refused, and a refusal still stops it.
  - It is never a default, and the command says on stderr that it is for an approved deployment only.

### Who decides what

- **The person running the command** chooses the opt-in by typing it. Nothing else can turn it on: there is no environment variable and no configuration file.
- **The server under test** names the next URLs, as before. With the opt-in, those URLs may be any http(s) host, including private addresses reachable from this machine. That is the library's existing `allowRemote` meaning ("for an approved deployment"), not widened. Choosing which deployments are approved stays a decision for whoever runs it; no policy is invented here.

**Compatibility:**
- a healthy loopback run prints the same JSON and exits 0, as before;
- callers that relied on extra arguments being ignored now get usage (exit 2);
- callers that relied on a crash now get JSON with exit 1.

### Static falsification of the command's contract

- **Usage never requests anything:** the arguments are checked before `preflight` is called.
- **Library refusals also come before any request** (the client, the URL, and off-machine without the flag), so they request nothing.
- **The only way to reach a host off this machine is the typed flag:** `--allowRemote`, `--allow-remote=1`, `-x` and a repeated flag are usage.
- **No credential is printed** from a refusal. The result's `url` field is the URL as the caller entered it, as before.
- **An error message is cut to 300 characters**, and no stack is printed.
- **Limit:** with the flag, the server under test can make this machine request hosts it names (the library's `allowRemote`). Use it only against a deployment someone approved.

### Test (written, not run)

`test/preflight-cli.test.mjs`, 4 cases with a fake `fetch`:
1. **Nine usage errors:** exit 2, nothing on stdout, nothing requested.
2. **Without the flag:** an off-machine URL is JSON with exit 1 and nothing requested; a healthy loopback run is exit 0.
3. **With the flag:** an approved-deployment chain passes; a redirect and a credential URL are still refused, and the credential is never printed.
4. **A failed request:** JSON `{client, ok: false, error: 'fetch failed'}` with exit 1, not a crash.

**What running it would touch:** the test imports `node:test`, `node:assert/strict` and the command (which imports `node:url` and `src/preflight.mjs` only). The command's own entry check does not fire under the test runner. There is no network, server, file write, key or subprocess.

Nothing here connects ChatGPT or any client.

## One run of the command's test (2026-11-17, at 8f8b7961)

**Command, from the repository root, run once:**

```
/opt/homebrew/opt/node/bin/node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test workstreams/03-composability/mcp/test/preflight-cli.test.mjs
```

**Checked just before:**
- HEAD `8f8b7961`, equal to the remote;
- `test/preflight-cli.test.mjs` `f34fdfa7d8f6741f…`, `bin/wylls-mcp-preflight.mjs` `ee6c25b046e053c1…` and `src/preflight.mjs` `55070d74b45f6497…`, all as committed;
- the guard `nokey-guard.mjs` `cf4518176289a45755a831140c85705093e9352825d3a6e80c75d91cf4f9862f`, unchanged;
- Node v23.11.0;
- the preload variables unset;
- no other `node --test` running;
- 49.6 GiB free;
- the worktree status recorded (the unstaged media deletions, which are not this work's), nothing staged.

**Not involved:** `connect.test.mjs`, the refused gateway tests, WS13's guard, any world or runner, any HTTP, OAuth registration or key.

**Result, 02:32:40 (+0900):**
- **4 / 4 passed**, `rc=0`, 45 ms, no warning:
  - usage errors;
  - off-machine refusal without the flag, with loopback still exit 0;
  - `--allow-remote` with redirects and credentials still refused;
  - a failed request as JSON.
- **After:** no test process left, the status identical, nothing staged, 49.6 GiB free.

**Limits:** a fake `fetch` only. No real server, deployment, tunnel or client.
