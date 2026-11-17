# ③ MCP `check_resource_shortfall`: `goal.amounts` is checked against the tool's own schema (Lane C, 2026-11-17)

Branch `claude/lane-c-ws03-shortfall-input-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `3780614871f80f73d481af61264f9cb5dbd46768` (the same on origin when read). At that tip, `mcp/src/game.mjs`, `tools.mjs` and `server.mjs` are byte-identical to `2bcc4bf2`. The aggregate and the fixed branches are not changed.

Written, not run: no test, syntax check, import, server or world.

## The real path (source, at `37806148`)

1. The schema: `mcp/src/tools.mjs:12-15` `cargoSchema` (`check_resource_shortfall` → `goal.amounts`).
   - `type: 'object'`, `additionalProperties: false`;
   - each of the 8 resources is `{type: 'integer', minimum: 0, maximum: 1000000}`;
   - "omitted resources are 0".
2. `mcp/src/server.mjs:811-818` `tools/call` passes `msg.params.arguments` to the tool function **without checking the input schema**.
3. `server.mjs:117-118` `shortfall` calls `Game.shortfall(await game.view(principal), args?.goal)`. A `GameError` becomes `fail(code, message)` (`server.mjs:84` `gameFail`).
4. **Before:** `game.mjs` `Game.shortfall`, `kind: 'amounts'`, read each value as `Number.isInteger(v) && v >= 0 ? v : 0`. So `-5`, `1.5`, `"300"`, `null` and `true` silently became 0. A goal made only of such values had no rows, which gave `enough: true` ("nothing is short"), although the schema forbids those values. An array `amounts` (`[]`) also passed, as an "object".

   `prepare_caravan`'s own check of the same schema (`server.mjs:39-45` `askedCargo`) already refuses these, with "must be a whole amount from 0 to 1000000".

## The change (`mcp/src/game.mjs`, `Game.shortfall`, `kind: 'amounts'` only; sha256 `16bc98b9…34cc11b7`)

- `amounts` must be a non-array object, or the existing "goal must be …" `BadRequest` is returned.
- The unknown-resource check runs first, with the message unchanged.
- Every given value must be `Number.isInteger(v)` and `0 ≤ v ≤ 1000000`. Otherwise it is `BadRequest` with "amounts.<Resource> must be a whole amount from 0 to 1000000", the same wording as `askedCargo`.
- `need = names.map(r => goal.amounts[r] ?? 0)`: omitted resources are 0, as before.

**Not changed:**
- the vault goal;
- `rows`, `hoursByProduction` (decision C), `enough` and the storehouse fields;
- the other tools;
- `tools/call` (no general validator was added);
- the server, auth, permissions, sending and the budget;
- main's store and bin, and D's aggregate ref.

## Compatibility (read, not run)

| Caller | Input | Effect |
|---|---|---|
| `mcp/e2e/local-stack.mjs:179, 209` | `{Stone: stoneHave + 500}`, `{Food: Math.floor(have) + carry}` | Whole numbers, so unchanged. It would now be refused only if the value went above 1,000,000, which the schema already forbids |
| `test/play.test.mjs:55` | `{Mana: 1}` | Still `BadRequest` with the same unknown-resource message (that check runs first) |
| `test/play.test.mjs:50, 63`, `test/sdk-client.test.mjs:65` | `{kind: 'vault'}` | Unchanged |
| `test/shortfall-coverage.test.mjs`, `test/shortfall-hours.test.mjs` | Valid whole amounts | Unchanged |
| An MCP client sending a value the schema forbids | e.g. `{Stone: -5}` | **Now `BadRequest`** (a tool error) instead of a silent 0 and possibly `enough: true`. This is the intended change |

## Regression (`mcp/test/shortfall-input.test.mjs`, sha256 `9c41a0f5…17687604`, written, not run)

- **I1:** 13 out-of-schema values for `Stone` (−5, −1, 1.5, "300", "", `null`, `true`, `NaN`, `Infinity`, 1,000,001, 2^53, `[]`, `{}`), and one bad value among good ones, are refused with the exact message.
- **I2:** an `amounts` that is not an object (`[]`, `[300]`, `null`, text, a number) is refused.
- **I3:**
  - the unknown-resource message is unchanged;
  - `{Stone: 300}` keeps the same full row (`hoursByProduction` 20) and `enough: false`;
  - the bounds 0 and 1,000,000 are accepted;
  - `{}` gives no rows and `enough: true`;
  - the vault goal is unchanged;
  - a missing or other `kind` is still refused.

## Pre-run judgement (static; the coordinator decides)

- **Not independent, not key-free.** The test imports `src/game.mjs`, whose static closure reaches:
  - `permutation-server/web/frontier/fland.mjs` and `web/lang.mjs`, the subjects of refused tests;
  - files that name key APIs (`fplay.mjs`, `session.mjs`, the vendored noble curves).
  
  So it is not claimed to be independent or key-free. Whether it may run, and then only through `scripts/ci/node-keyfree.sh` with `no-keys-guard.mjs`, is the coordinator's prior decision. It must not run by another route, and it is not a substitute for any refused test.
- **The key-scan list:** like `shortfall-coverage.test.mjs` and `shortfall-hours.test.mjs`, this new file is in neither `node-key-tests.txt` nor `node-key-reviewed.txt`. That staleness was already recorded in `CLAUDE-LANE-C-WS03-SHORTFALL-HOURS-20261117.md`. The lists are not changed here.
- **The test file itself:** it imports only `node:test`, `node:assert/strict` and `../src/game.mjs`. It has no I/O, no environment reads and no child processes.

## Limits

- Only the `kind: 'amounts'` input of this one tool is checked. Other tools' inputs, and a general `tools/call` schema check, are out of scope by instruction.
- Extra properties on `goal` itself, like `{kind: 'vault', amounts: …}`, are still ignored as before; the schema's `additionalProperties: false` on `goal` is not enforced here.
- Nothing was run, and the real MCP error output was not observed.
