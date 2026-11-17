# ③ MCP: a Province the herald could not give is not "no road" (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, fifth commit on `c48f0b4f`, built with a temporary git index (no branch
switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched).

**Static change, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed; the two
guard-refused frontier tests were not run in any form. The herald (client and server), the gateway, `http.mjs`,
`auth.mjs` and `preflight.mjs` were read only or not at all.

## Source facts (c48f0b4f; herald read only)

- Herald server `GET /h/province/{P},{Q}/latest` (`frontier-node/crates/herald/src/server.rs:517-522`,
  `views.rs:118-122`): 404 `NoSuchProvince` whenever `province_latest` is None — the Province account is not in the
  herald's fold, or its bytes do not decode, or the envelope cannot be built. So a 404 covers "never opened" and also
  "opened but not recorded by this herald (yet)" and "unreadable here": **no contract makes a 404 a proof of an unopened
  Province.** (Whether some other record — e.g. the season's open rings — proves it is an open question; not used.)
- Herald client (`permutation-server/web/frontier/herald.mjs:27-39, 466-471`): `network`, `NotFound` (404), `TooEarly`
  (425), `HTTP<n>`, `BadBody`, and the envelope check's own code (`BadRecord` or the thrown code).
- ③ before: `Game.province` wrapped every failure as `HeraldUnavailable` (dropping the code), and `game.plan` caught
  every failure for every Province on the way as "an unopened Province: no road there" — so a herald outage or a 425 could
  end in a definite `NoRoad`.

## The change (③ `game.mjs` only)

- `Game.province` keeps `HeraldUnavailable` (retryable) and adds `heraldCode` (the client's code).
- `game.plan`: a `NotFound` Province is left out of the road (as before); any other failure stops the plan with
  `HeraldUnavailable` (retryable, its code) — fail closed, no search of a partial map; an unreadable land is
  `HeraldUnavailable` `BadRecord`. When no road is found and some Provinces were 404, the answer is `Unknown`
  (`reason: ProvincesNotFound`, `provinces`), not `NoRoad`. `NoRoad` stays for the case where every wanted Province was
  read; a road found through read Provinces is planned as before.
- Unchanged: authorization, sending, retry, states, other tools; no new tool.

## Tests read on paper

The fixtures (`mcp/test/fixture.mjs:103`, `keyfree/harness.mjs:133`) answer every Province: their roads and plans are
unchanged. No test pins `NoRoad`.

## Regression source (written, NOT run)

`mcp/test/road-unknown.test.mjs` R1–R4 (network, 425 / 5xx / BadBody / BadRecord, all-404 → Unknown, the kept herald
code). The Game's fetch throws; its herald is a stub. Imports `src/game.mjs` (frontier-module closure not re-checked —
not claimed key-free; run only through the repository's guard). With no lands `fastestPath` returns null
(`fcaravan.mjs:63`), so R3 reaches the new branch. Not covered: a found road and an all-read NoRoad (real envelopes).

## Open

- Whether any adopted record proves a Province unopened (so that "no road" could be stated with 404s present).

## Checks NOT run

The new test and every ③ test; no syntax check, import or guard scan.
