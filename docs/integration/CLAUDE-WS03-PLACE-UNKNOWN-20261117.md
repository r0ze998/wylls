# ③ MCP: an unread storehouse is "not known", not "not yours" — and still refused (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, fourth commit on `6779bb34`, built with a temporary git index (no branch
switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched).

**Static change, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed; the two
guard-refused frontier tests were not run in any form. `http.mjs`, `auth.mjs`, `preflight.mjs`, the gateway and the
herald were not touched.

## Source facts (6779bb34)

- `game.mjs view`: the village comes from the owner's record (`/h/me`); the storehouses only from the caravan feed —
  with the feed down, `places` holds the village alone and `feedOk: false`.
- `Game.placeOf` answered `NotYourPlace` for any id not in `places`, so with the feed down the owner's own storehouse was
  reported as another player's (`prepare_caravan` → `game.plan` → `placeOf`).
- `send_caravan` (`server.mjs:203-209`) re-reads the view but checks only the world context, the caravan number and the
  village; it does not resolve places again, so a feed failure at send time is not turned into NotYourPlace there.
  Unchanged (no send, retry or authorization rule was touched; ownership on chain is the program's check).

## The change (③ `game.mjs`, `tools.mjs`)

- `placeOf`: a listed place resolves as before; an unlisted `vault:` id while `feedOk === false` → `Unknown`
  (`retryable: true`, `reason: 'CaravanFeedUnavailable'`), message: read village_status again, then prepare again —
  fail closed, nothing is planned on an unverified place, no send is suggested. Every other miss stays `NotYourPlace`
  (the feed read; a village, field or malformed id).
- `prepare_caravan` description says so.

## Tests read on paper

`connect.test.mjs:79`, `play.test.mjs:81,478`, `sdk-client.test.mjs:77` expect NotYourPlace with the feed working:
unchanged.

## Regression source (written, NOT run)

`mcp/test/place-unknown.test.mjs` P1–P5 (imports `src/game.mjs`; the frontier-module closure was not re-checked for it —
not claimed key-free; run only through the repository's guard).

## Checks NOT run

The new test and every ③ test; no syntax check, import or guard scan.
