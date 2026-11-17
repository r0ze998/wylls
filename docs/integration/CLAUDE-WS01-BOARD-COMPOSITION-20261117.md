# ①'s board and the game on one origin: what exists, what this unit adds, what is not decided (2026-11-17)

**Branch:** `claude/ws01-board-composition-20261117`, one commit **on `81b07cee`** (the send-source unit's final tip, unchanged).

**Adoption:** take this unit's own diff `81b07cee..<this tip>`, after `0f843db5..81b07cee`.

**Static change, NOT run:**
- no test, syntax check, import, start, bind, HTTP, RPC, signature, send, world or publication;
- nothing here is a public deployment, and nothing claims one.

## The one origin that already exists (adopted, unchanged)

`workstreams/01-national-strategy/coop/board.mjs`, as in the aggregate `d03879ec`, unchanged by this unit:

| Path on the board's origin | Served by |
|---|---|
| `/coop/config`, `/coop/view`, `/coop/records` (GET, POST), `/coop/rpc` (read-only methods) | the board |
| `/ws01/` → `/ws01/repo/workstreams/01-national-strategy/coop/` | the board page. Static files only from the `coop` folder and `permutation-server/web` (`SERVE`). |
| everything else, including `/frontier/frontier/` (the game), `/h/*` and `/gw` (the relay through the herald), and upgrades | passed to **its one herald** (`--herald`) |

- **Where it listens:** `127.0.0.1` only (`listen(port, '127.0.0.1')`). The data folder is `--data` (default `.local/ws01-coop/<program>` in the checkout), and the network is `--cluster` (default `localnet`).
- **What this gives:** opened through the board (`http://127.0.0.1:<port>/frontier/frontier/`), the game's village card (`hud/coopboard.mjs`) finds `/coop/config` and `/coop/view` on its own origin. Its links open the board page on that origin (`boardHref`, same-origin paths only). The page's records go to `/coop/records` on that origin. **This is a local, loopback composition.**
- **The board page's imports, checked statically at `81b07cee`:** all 84 modules resolve inside `SERVE`, with no bare or absolute specifier. The three `@noble/…` matches are comments in the vendored files.

## What was missing (and is added here, page side only)

**The gap:** the board passes the game to whatever herald it was started in front of. Nothing on the board page checked that this herald's world is the board's world: `--program`/`--season` are typed by hand, and the local profile makes no start check.

- **The village card is safe:** it already refuses a board of another world (adopted).
- **The board page is not:**
  - it planned and sent caravans for the board's world through the same origin's `/gw`, which goes to that herald's relay;
  - it had no way back to the game.

| Part | Change |
|---|---|
| `coop/composition.mjs` (new, pure) | **`compositionOf(seasonAnswer, cfg)`:** compares the herald's `/h/season` (`programId`, `season`, `cluster`, as `frontier-node/crates/herald/src/views.rs` writes them) with the board's `/coop/config` world (`season.programId`, `season.seasonId`, `cluster`). The result is `same`, `different` (with what differs), or `unknown` (not readable, not named, or no network to compare). **Unknown is never "same".** **`compositionText`:** the words. **`GAME_PAGE = '/frontier/frontier/'`**, the path the board's own start message names. |
| board page (`coop/coop-ui.mjs`) | **At start** (after `/coop/config`), one GET of `/h/season` **on this origin** (the board passes it to its herald). A line `#composeState`: same (with a link "ゲームを開く" to `GAME_PAGE`, a fixed same-origin path), different (bad), or unknown (warn). The link is shown only when the world is the same. |
| sending | **`sendOnce` reads `/h/season` again before `planSend`.** If the world is different, it does not plan or send and says why. `previewSource` refuses on a different world. **Unknown keeps the old behaviour** (not turned into a refusal or a success). Not gated: following an earlier send (`followSend`, checked before), and the board's records (`post`), which are the board's own world and never go to the herald. |

**Not changed:**
- `board.mjs`: start, routing, loopback, data, cluster, proxy, health;
- the village card and the game;
- signing, authorization, re-sends;
- `planSend`'s checks.
- **No new address, publication, trust or permission.**
- **`b40be705` (P1/P3, board public prep) is not in this unit and is not needed by it.** The `board.mjs` lines pinned here are the same in the aggregate and in `b40be705`. It is still **not adopted** (its test file is not in `d03879ec`) and stays a separate fixed unit.

## Ready vs not

| | State |
|---|---|
| Game, village card, board page and record API on **one loopback origin** through `board.mjs` | **exists (adopted), not run here** |
| The board page says whether that origin's game is the board's world, links the game only when it is, and does not send when it is another world | **implemented, not run** |
| `--profile public` start checks, forwarded address, health, durable observed times | **implemented in `b40be705`, not adopted**. Not mixed here. |
| A public origin: host, domain, TLS reverse proxy in front of the board | **not decided** |
| A public herald, relay, RPC and program for one world | **not deployed** (no public game server: G1) |
| A general HTTPS POST path; keeper main fixed to localnet | **blocked, owned elsewhere** (not changed) |
| Starting the board together with a world (a launcher) | **not done here**. The adopted launchers that start herald, relay and runner are in the reserved world/runner area and were not read further or changed. Today the board is started by hand in front of a running herald. |

## Regression (written, NOT run): `workstreams/01-national-strategy/test/coop.composition.test.mjs` (new)

- **`compositionOf`:**
  - same;
  - each difference alone and together;
  - a number Season;
  - every unreadable shape → unknown;
  - no network on either side → unknown;
  - a known difference stays different without a network.
- **The words:** same names the world; different says nothing is sent; unknown never says the same.
- **The page:**
  - a same-origin GET, with a failure → unknown;
  - text only;
  - the link is only `GAME_PAGE` and only when the world is the same;
  - read at start;
  - re-read before each send, with a different world refused before `planSend`;
  - the earlier send still followed first;
  - preview refused;
  - `followSend` and `post` not gated;
  - unknown not turned into a refusal.
- **The board's one-origin facts** (`board.mjs` pinned as text, unchanged): `/coop/config`, `/ws01/repo/`, everything else to the herald, `127.0.0.1`, `SERVE`, the game path.

① browser tests (`coop.browser.mjs`, `coop.browser.nokey.mjs`) are **not run**. They read `#msg`; the new line has its own element (`#composeState`). Where their board has no herald, `/h/season` answers 404, which is said as unknown and changes nothing.

## Hand-over (Lane D)

**Unit:** `claude/ws01-board-composition-20261117`, one commit on `81b07cee`, all `100644`:
- `workstreams/01-national-strategy/coop/composition.mjs` (A)
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `workstreams/01-national-strategy/test/coop.composition.test.mjs` (A)
- `docs/integration/CLAUDE-WS01-BOARD-COMPOSITION-20261117.md` (A)

**Not run:** anything.
