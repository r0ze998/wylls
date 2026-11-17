# ③ MCP: check_resource_shortfall tells "no storehouse can help" from "storehouses not known" (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, third commit on `5c7fe63b`, built with a temporary git index (no branch
switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched).

**Static change, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed (no test old
or new, syntax check, import, scanner, server, world, browser or runner); the two guard-refused frontier tests were not
run in any form. `http.mjs`, `auth.mjs`, `preflight.mjs`, the gateway and the herald were not touched.

## Source facts (5c7fe63b)

- `game.mjs view`: when the herald's caravan feed fails, `vaults = []` and the view says `feedOk: false`; a storehouse
  whose stores the feed does not carry is `known: false` with `stores: null`.
- `get_village_status` already says it: `caravanFeed: 'ok' | 'unavailable'` (`server.mjs:104`).
- `Game.shortfall` built `storehouseSources` from known storehouses only and said nothing else: with the feed down, or
  every storehouse unknown, it returned `storehouseSources: []` — the same as "none of your storehouses holds it".
  Contract: `08-mcp-contracts.ja.md:13` (the shortfall and the owner's storehouses that can fill it); flow step 2
  (`11-claude-chatgpt.ja.md:64`).

## The change (③ `game.mjs`, `tools.mjs`)

- The shortfall adds `storehouseCoverage`: `unavailable` (feed not read), `partial` (some of the owner's storehouses
  have unknown stores: `storehousesUnknown` lists their placeIds, never counted as 0), `complete`. Everything it returned
  before is unchanged: `goal`, `rows` (need, have, short, perHour, hoursByProduction), `enough`, `storehouseSources`.
- The `check_resource_shortfall` description says an empty `storehouseSources` means "none can help" only when complete.
- Unchanged: authorization, sending, states, costs, prepare/send, other tools.

## Tests read on paper

- `play.test.mjs:54` pins `storehouseSources` only (unchanged); `mcp/e2e/local-stack.mjs:179,209` read fields that are
  unchanged.

## Regression source (written, NOT run)

`mcp/test/shortfall-coverage.test.mjs` C1–C5. It imports `src/game.mjs`, which imports permutation-server/web/frontier
modules (herald, faddr, fland, fcaravan, fplay) — the closure the existing ③ tests already load through the server; it
was not re-checked for this file, so it is not claimed key-free: run only through the repository's guard.

## Checks NOT run

The new test, `play.test.mjs`, every ③ test and the e2e script; no syntax check, import or guard scan.
