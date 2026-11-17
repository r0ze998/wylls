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

## One-time static falsification of the change (2026-11-17; nothing run)

Inputs as JSON delivers them (`JSON.parse` of `tools/call` arguments), against the schema (`tools.mjs` `cargoSchema`; the `goal` object needs `kind`, and `amounts` is optional) and the code at `ad1922e0`:

| Input | Schema says | Code at `ad1922e0` | Agrees? |
|---|---|---|---|
| `{"kind":"amounts","amounts":{"Stone":300}}` | Valid | `need` Stone 300, others 0 | Yes |
| A resource omitted (`{"Stone":300}` and nothing else) | Valid, omitted = 0 | `goal.amounts[r] ?? 0` gives 0 | Yes |
| `{"Stone":null}` (explicit `null`) | Invalid (integer) | `BadRequest` "amounts.Stone must be…" | Yes |
| `"amounts":null` | Invalid (object) | `BadRequest` "goal must be…" | Yes |
| `"amounts":[]` or `[300]` | Invalid (object, not array) | `BadRequest` "goal must be…" (before the change, `[]` passed as no need) | Yes (fixed) |
| `{"Stone":0}` / `{"Stone":1000000}` | Valid (the bounds) | Accepted | Yes |
| `{"Stone":1000001}`, `1e20`, `-1` | Invalid | `BadRequest` | Yes |
| `{"Stone":-0}` (JSON `-0`) | Valid (`-0 ≥ 0`) | `Number.isInteger(-0)`, `-0 < 0` is false, so it is accepted as 0 | Yes |
| `{"Stone":1e6}` | Valid (an integer value) | `JSON.parse` gives 1000000, accepted | Yes |
| `{"stone":1}` (other case), `{"Mana":1}`, `{"__proto__":1}` (an own key after `JSON.parse`) | Invalid (`additionalProperties: false`) | `BadRequest` "unknown resource …" | Yes |
| `{"kind":"vault"}` | Valid | Unchanged | Yes |

**Existing valid consumers:** as in the compatibility table above. `local-stack.mjs` (whole numbers), `play.test.mjs` (`Mana` → the same message) and the vault calls are unaffected.

**Result:** the change introduced no defect, and no further code change was made.

**Pre-existing mismatches (not introduced by `ad1922e0`; recorded, not changed):**
1. **Legacy programs (`programVersion < 4`).**
   - `Game.shortfall` checks keys against `view.resources`, which is `RESOURCE_ORDER` there (`permutation-server/web/frontier/resources.mjs:5`; index 4 is `Horses`).
   - The schema names `Arms`. So a schema-valid `{"Arms":5}` is refused as unknown, while the schema-invalid `{"Horses":5}` is accepted.
   - `prepare_caravan` (`server.mjs` `askedCargo`) checks against the fixed `RESOURCE_NAMES` (`Arms`), so the two tools disagree on such programs.
   - Fixing it means deciding whether legacy `Horses` stays accepted (an alias) or is refused. That is the owner's decision.
2. **`{"kind":"amounts"}` with no `amounts`.** The schema allows it, but it is refused with "goal must be …", unchanged since before. Whether it should mean "nothing needed" is also the owner's decision.

## Hand-over to D (for the aggregate; the aggregate is not changed here)

- **Base:** `claude/aggregate-approved-20261117` at `3780614871f80f73d481af61264f9cb5dbd46768`.
- **Code commit:** `ad1922e06645ce76445bc5ec197acae03a8f71f7`. The branch tip is the next commit (this report only), on `claude/lane-c-ws03-shortfall-input-20261117`.
- **Three paths:**
  - `workstreams/03-composability/mcp/src/game.mjs` (M, `Game.shortfall` `amounts` branch only);
  - `workstreams/03-composability/mcp/test/shortfall-input.test.mjs` (A, not run, not independent: see above);
  - `docs/integration/CLAUDE-LANE-C-WS03-SHORTFALL-INPUT-20261117.md` (A).

## The input schema now says what the runtime already does: `amounts` is required for `kind: "amounts"` (2026-11-17; nothing run)

**The mismatch (pre-existing item 2 above).** `check_resource_shortfall`'s `goal` schema required only `kind`, so `{"kind":"amounts"}` was schema-valid. But `Game.shortfall` refuses it ("goal must be …"), before and after `ad1922e0`. The schema is aligned to the runtime; the runtime is not changed.

**The change** (`workstreams/03-composability/mcp/src/tools.mjs`, the `check_resource_shortfall` `inputSchema` only; sha256 `ad6aed30…37bd67c4`). One `anyOf` on `goal`, written with the `enum` keyword the file already uses (no `const`, `if` or `oneOf`):

```js
anyOf: [{ properties: { kind: { enum: ['vault'] } } }, { properties: { kind: { enum: ['amounts'] } }, required: ['amounts'] }]
```

- `kind: "vault"` requires nothing more, and an extra `amounts` on it stays allowed, as before.
- `kind: "amounts"` requires `amounts`.
- **Unchanged:**
  - `goal`'s `required: ['kind']`, its `kind` enum, `additionalProperties: false` and `amounts: cargoSchema`;
  - `cargoSchema` itself (the 8 resources, integers 0..1000000);
  - the description and the other tools;
  - `game.mjs` and `server.mjs` (`tools/call` still does not check schemas), sending and permissions;
  - the legacy `Horses`/`Arms` question, which is undecided.

**One-time falsification (by hand, JSON Schema semantics; nothing run).**

| `goal` | Before | After | Runtime (`Game.shortfall`) |
|---|---|---|---|
| `{"kind":"vault"}` | Valid | Valid (branch 1) | Accepted |
| `{"kind":"vault","amounts":{"Stone":1}}` | Valid | Valid (branch 1; `amounts` still a declared property) | Accepted; `amounts` ignored (unchanged) |
| `{"kind":"amounts","amounts":{"Stone":300}}` | Valid | Valid (branch 2) | Accepted |
| `{"kind":"amounts","amounts":{}}` | Valid | Valid (branch 2) | Accepted: no rows, `enough: true` |
| `{"kind":"amounts"}` | **Valid** | **Invalid** (branch 1: kind is not vault; branch 2: amounts missing) | Refused (`BadRequest`). Schema and runtime now agree |
| `{"kind":"other"}` or `{}` | Invalid | Invalid (`enum`, `required`) | Refused |
| `{"kind":"vault","x":1}` | Invalid | Invalid (`additionalProperties` sees only the sibling `properties`, so the `anyOf` branches neither widen nor narrow it) | Accepted at runtime (not checked); unchanged |

- **Compatibility:**
  - Inputs that were both schema-valid and accepted by the runtime remain schema-valid. Existing legacy-resource and extra-property mismatches are unchanged.
  - The only input that became schema-invalid is one the runtime already refused.
  - A client that checks schemas before calling now learns this before the call, not from the error.
- **Who reads the schema:** only `server.mjs` `tools/list` serves this `TOOLS`. The `permutation-gateway` `TOOLS` are a different file. `test/instructions-flow.test.mjs` and `test/shortfall-coverage.test.mjs` match `tools.mjs` text that is unchanged: `SERVER_INSTRUCTIONS`, the descriptions and the storehouse-coverage sentence.

**Regression** (`workstreams/03-composability/mcp/test/shortfall-schema.test.mjs`, sha256 `f0953ea3…430c5ed5`, written, not run).
- It is **key-free by the existing convention:** it imports only `node:test`, `node:assert/strict` and `node:fs`, and reads `tools.mjs` as text without importing it (as `instructions-flow.test.mjs` does, since `tools.mjs` imports `auth.mjs`).
- It does not reach `game.mjs` or any `permutation-server/web/frontier` file, so it does not touch the refused tests' subjects.
- It needs no key-list entry. The lists are unchanged.
- **S1:** exactly one `anyOf`, with the two branches as written, and `required: ['amounts']` only once.
- **S2:** the rest of the `goal` schema and `cargoSchema` are unchanged.
- **Limit:** it is a source-text check. It does not evaluate JSON Schema.
- Candidate command (for the coordinator; not run): `node --test workstreams/03-composability/mcp/test/shortfall-schema.test.mjs`.

## Hand-over to D (updated; the aggregate is not changed here)

- **Base:** `claude/aggregate-approved-20261117` at `3780614871f80f73d481af61264f9cb5dbd46768`.
- **Branch:** `claude/lane-c-ws03-shortfall-input-20261117`. The code commits are `ad1922e0` (`game.mjs` input check) and the next commit (`tools.mjs` schema); the tip is the latest report commit.
- **Five paths against the base:**
  - `mcp/src/game.mjs` (M);
  - `mcp/src/tools.mjs` (M);
  - `mcp/test/shortfall-input.test.mjs` (A; not independent: imports `game.mjs`);
  - `mcp/test/shortfall-schema.test.mjs` (A; key-free text check);
  - this report (A).
