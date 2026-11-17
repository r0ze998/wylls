# ① request board: public-readiness P1/P3 in the board server (2026-11-17)

**Branch:** `claude/ws01-board-public-prep-20261117`, on the aggregate `claude/aggregate-approved-20261117` at `186e46b5`. It does not include `e3de2695` or `19f171e2`.

**Static change, NOT run:**
- no test, syntax check, import, start, bind, HTTP/RPC, signature or world;
- every edit is a text replacement.
- Nothing here is "verified", and **nothing was published**.

## What the board server is (`workstreams/01-national-strategy/coop/board.mjs`)

- **Where it listens:** on `127.0.0.1` only. It serves `/coop/*` (its records, view, config, a read-only RPC proxy) and `/ws01/*` (its page).
- **Everything else** goes to the herald over plain HTTP, including upgrades. The relay is reached as the herald's `/gw`.
- **The game's entry** (`hud/coopboard.mjs`) reads `/coop/config` on the same origin.
- **Not changed:** no public bind. A public deployment puts a TLS reverse proxy in front of the board on the same machine.

## P1: before anything is made, the settings are checked (the public profile)

| Fixed | Before | Now |
|---|---|---|
| **`X-Forwarded-For` to the herald** (real defect) | The board passed the client's own headers on. The herald trusts the **last** `X-Forwarded-For` address whenever its peer is loopback (`herald/src/server.rs` `client_ip`), and the relay trusts that from the herald. So **any client of the board could choose the address the relay sees**. | `upstreamHeaders`/`forwardedFor` apply the herald's own rule at the board: a loopback peer (the reverse proxy in front) gives its **last** address; any other peer gives the peer itself. Exactly that one address is sent on. The client's `Forwarded` and `X-Real-IP` are dropped. Both the HTTP and the upgrade paths. |
| **`--profile public`** (new option; the default `local` is unchanged) | No check before start; cluster default `localnet`; data folder default inside the repository; any herald or RPC URL. | `checkPublicStart` runs **before the board, its folder or its listener are made**: `--cluster` given and not `localnet` (the Dev Wallet is enabled only on localnet, so it stays out); `--data` given and outside the repository; `--herald` and `--rpc` are `http` on this machine's loopback. Then one read of the herald's `/h/season` must name **the same program, Season and cluster** (`worldOfSeason`). Any problem: `{error: 'public start refused', problems}` and exit 2. |
| **The herald's inside address in `/coop/config`** | published to every page | not published in the public profile (the page never reads it); unchanged in local |

**Not in the board, nothing to refuse there:** a faucet or test keys. The board signs nothing.

## P3: health and records that survive a failure

| Fixed | Before | Now |
|---|---|---|
| **`observed.json`** (first-seen times; real defect) | written in place (`writeFileSync`). A crash mid-write left a cut file; at the next start it failed to parse and was **silently reset to empty**, then overwritten. | Written atomically: temporary file, `fsync`, `rename`. An unreadable file is **renamed aside** (`observed.json.unreadable-<ms>`, bytes unchanged, never deleted) and the reason is said. If it cannot be renamed, the board does not write that file again (nothing is overwritten). |
| **`/coop/health`** (new; GET) | none | `{ok, profile, parts: {herald, chain, store, observed}, world, store, observed, chain}`. Each part is `ok`, `missing` or `unknown`; `ok` is true only when all are `ok`. 200 when ok, 503 otherwise. |

**What each health part means:**
- **herald:** the herald's world is the board's (`ok`), differs (`missing`), or could not be read or names no cluster (`unknown`).
- **chain:** `missing` without `--rpc`: nations and destinations stay unverified. Never reported as ok.
- **store:** a segment problem or a damaged line gives `missing`. The record store itself (`store.mjs`, append-only segments, the manifest by rename) is unchanged.

## Regression (written, NOT run): `workstreams/01-national-strategy/test/coop.public-profile.test.mjs`

- **The forwarded address:** a direct client cannot choose it; a proxy's last address is used; `Forwarded`/`X-Real-IP` are dropped.
- **Each public-start refusal,** and the passing case.
- **`worldOfSeason`:** same, different and unknown.
- **Health:** the parts, the missing chain without `--rpc`, an unreachable herald (`unknown`), another program (`missing`); public config without the herald, local config with it.
- **An unreadable `observed.json`:** kept aside byte for byte, reported, then a new file written whole (no `.tmp` left).
- **Its folders:** made by `mkdtemp` and removed only by the test.

**Existing tests:** no test compares the whole config (`git grep`). The fields the page and the tests read are unchanged. The test proxy (`coop.test.mjs`) ignores headers.

## Public readiness: what is ready, what is not

| | State |
|---|---|
| The board refuses a public start with localnet, a repository folder, a non-loopback herald or RPC, or another world | **implemented, not run** |
| The relay sees the real client address through the board | **implemented, not run** |
| Health tells ok, missing and unknown apart; the observed times survive a crash | **implemented, not run** |
| A TLS reverse proxy in front, and where it runs (host, domain) | **not decided** (not chosen here) |
| A public herald, relay, RPC and program for one world | **not started** (no world, publish or external URL here) |
| ⑮'s verdict in the game (ruleset A/B/C) | **owner decision** |
| **Blockers held by others** (not changed here): no general HTTPS POST path; keeper main fixed to localnet | **blocked**, owned elsewhere |
| The retry and re-press rules of unconfirmed orders | **unchanged, undecided** |

**Next concrete work:**
1. An approved run of the new test and ①'s existing tests under the key guard.
2. A choice of host and reverse proxy.
3. The two blockers above, by their owners.
4. A public herald, relay and program for one world, then a `--profile public` start against it.

## Hand-over (Lane D)

**Unit:** `claude/ws01-board-public-prep-20261117` on `186e46b5`, all `100644`:
- `workstreams/01-national-strategy/coop/board.mjs` (M)
- `workstreams/01-national-strategy/test/coop.public-profile.test.mjs` (A)
- `docs/integration/CLAUDE-WS01-BOARD-PUBLIC-PREP-20261117.md` (A)

**Not run:** anything.
