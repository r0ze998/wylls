# ③ MCP `check_resource_shortfall`: `hoursByProduction` can be 0 while something is short (Lane C, 2026-11-17)

Branch `claude/lane-c-ws03-shortfall-hours-20261117`, from the shared aggregate `claude/aggregate-approved-20261117` at `aec7074490ccb42bc0fa4b3fd20542c719aa5d86` (the same on origin when read). The aggregate is not changed, and neither is the fixed ① branch.

**Report only: no code change.** The mismatch is real, but fixing it means choosing a rounding rule, and no adopted document fixes one.

Nothing was run: no test, syntax check, import, server or world. Scope is reserved by agreement with D: `hoursByProduction` in `Game.shortfall` only. Not touched:
- main's bin settings helper;
- D's runbook, package and HTTP path;
- auth, the server, sending and permissions.

## The code (at `aec70744`)

`workstreams/03-composability/mcp/src/game.mjs:222`, `Game.shortfall`:

```js
hoursByProduction: short === 0 ? 0 : s.perHour > 0 ? Math.round((short / s.perHour) * 10) / 10 : null
```

## The facts

| Item | Source | What it says |
|---|---|---|
| `have` | `game.mjs:173` → `permutation-server/web/frontier/fland.mjs:333` `storesAt` | `Number(accrualAt(a, t) / 1000n)`: a BigInt division, so a whole number |
| `need` | `game.mjs` `shortfall` | `VAULT_COST`, or the goal's amounts, accepted only when they are whole numbers ≥ 0 |
| `short` | `game.mjs:221` | `max(0, need − have)`: a whole number, so when it is above 0 it is at least 1 |
| `perHour` | `fland.mjs:333` | `Number(BigInt(a.rate)) / 1000`: may be a fraction and may be large |
| The meaning of 0 in the code | `game.mjs:222` | `short === 0 ? 0`: 0 is what the code returns for "nothing short" |
| The tool's description | `mcp/src/tools.mjs:35-40` (`check_resource_shortfall`) | "Returns need, have, short, **the hours production would take**, …" |
| `null` | `game.mjs:222` | `perHour ≤ 0`: production will not cover it |
| Adopted contract | `docs/integration/CLAUDE-WS03-SHORTFALL-COVERAGE-20261117.md:24` | Lists `hoursByProduction` as an unchanged field. No document states its unit precision or rounding |
| Consumers | Repository-wide search at `aec70744` | No code reads it. The MCP clients (the person's assistant) read the tool output. `test/shortfall-coverage.test.mjs:45` pins one exact case: `short` 200, `perHour` 10 → 20 |

**The mismatch.** `Math.round(x * 10) / 10` is 0 whenever `short / perHour < 0.05`, that is when `perHour > 20 × short`. Then a row with `short > 0` reports `hoursByProduction: 0`. That is the value the code itself uses for "nothing short", and against the description it says production takes no time while the village is still short.

Concrete cases (computed by hand, not run):

| `short` | `perHour` | `short/perHour` | `×10` | `Math.round` | `hoursByProduction` |
|---|---|---|---|---|---|
| 1 | 40 (the recorded stack's Food rate, `results/mcp-local-stack.json`) | 0.025 | 0.25 | 0 | **0** |
| 1 | 21 | 0.0476… | 0.476… | 0 | **0** |
| 1 | 20 | 0.05 | 0.5 | 1 | 0.1 |
| 2 | 40 | 0.05 | 0.5 | 1 | 0.1 |
| 200 | 10 | 20 | 200 | 200 | 20 (the pinned test case) |

`enough` is computed from `short` (`rows.every(r => r.short === 0)`), so `enough: false` is still correct. Only the hours field disagrees with `short` and with the description.

## Options (not chosen; the owner of ③ or the coordinator decides)

| Option | Expression for `short > 0`, `perHour > 0` | Effect | Notes |
|---|---|---|---|
| **A. Never 0: a floor of 0.1, rounding kept** | `Math.max(0.1, Math.round((short / perHour) * 10) / 10)` | Every value that is already ≥ 0.1 stays byte-identical, including the pinned 20 and the recorded 25 and 2.5. Only the cases that now give 0 become 0.1 | The smallest change. It slightly overstates very fast production (an hour count under 0.05 shows as 0.1). It is not a new rounding rule; it closes the 0 hole |
| B. Round up to the next tenth | `Math.ceil((short / perHour) * 10) / 10` | Never underestimates. Values that are not exact tenths move up by up to 0.1 | **Floating-point hazard:** `perHour` is `rate / 1000` in binary floating point, so an exact tenth can come out a hair above, for example `3 / 0.3 * 10 = 100.00000000000001` → `ceil` → 10.1. A safe version needs whole-number arithmetic from the raw `rate`, which the view does not carry, so it is a larger change |
| C. No rounding | `short / perHour` | Exact for the given inputs | Noisy floating values in the tool output; a change of form, not just a fix |
| D. Keep 0 and document it | — | No code change | Contradicts the description and the code's own "nothing short" meaning of 0. Not recommended |

**Recommendation:** A. It keeps every currently non-zero value and the existing rounding, removes the only case that disagrees with the description, and has no floating-point hazard.

**If A is chosen, the regression to add** (not written, not run). In `workstreams/03-composability/mcp/test/` there would be a pure case on `Game.shortfall` with hand-made `view` values:
- `short` 1, `perHour` 40 → 0.1, never 0;
- `short` 1, `perHour` 20 → 0.1;
- `short` 200, `perHour` 10 → 20 (unchanged);
- `short` 0 → 0;
- `perHour` 0 → `null`.

The file must be checked first, by reading, for what `game.mjs` imports (`permutation-server/web/frontier` modules) and for the key-scan list, before anyone decides to run it.

## Not verified

- No run of anything.
- The real MCP output for a fast-producing village was not observed; the cases above are hand calculations from the source.

## Decision C applied: `hoursByProduction` is `short / perHour`, not rounded (2026-11-17; nothing run)

The coordinator chose option C. **This is a change of precision for MCP clients:** the field was rounded to 0.1 h and is now the unrounded number `short / perHour`.

**The change** (`workstreams/03-composability/mcp/src/game.mjs`, `Game.shortfall`, sha256 `4e41f28d…f51ef10f`). It is one expression, with a comment giving the reason:

```js
hoursByProduction: short === 0 ? 0 : s.perHour > 0 ? short / s.perHour : null
```

- **Kept:**
  - nothing short → `0`;
  - no production (`perHour ≤ 0`) → `null`;
  - `enough` (computed from `short`), `rows`, the storehouse fields and the tool's inputs.
- **Not changed:**
  - `tools.mjs`: the description says "the hours production would take" and names no rounding, so it still holds;
  - the server, auth, permissions, sending and the budget;
  - main's store and bin, D's start-up docs;
  - the shared aggregate and the fixed ① branch.

**Compatibility with existing expectations and records (read, not run).**
- `test/shortfall-coverage.test.mjs:45` expects `short` 200 at 10/h → `20`. Unrounded it is still exactly 20.
- The recorded outputs (`results/mcp-local-stack*.json`/`.out`: 500 at 20/h → 25, 100 at 40/h → 2.5) are exact and would not change.
- **Values that are not whole tenths now show more digits.** For example, 1 at 21/h is 0.047619047619047616, where 0.1 h rounding gave 0. MCP clients receive a JSON number, so no client code in the repository reads this field.

**The regression** (`workstreams/03-composability/mcp/test/shortfall-hours.test.mjs`, sha256 `3d2e0eaf…2e213798`, written, not run). It builds plain `view` objects, like `shortfall-coverage.test.mjs`:
- H1: `short` 1 at 40, 21 and 1000/h gives 1/40, 1/21 and 1/1000, always above 0, with `enough: false`.
- H2: the exact cases (200 at 10/h → 20, with the full row; 500 at 20/h → 25; 100 at 40/h → 2.5).
- H3: nothing short → 0 with `enough: true`; `perHour` 0 or −5 → `null`.
- A fractional rate (0.3/h): hours × rate gives back the shortfall within floating point.

**Pre-run judgement (static; the coordinator decides; not run).**
- **The test is not independent and not key-free.** It imports `src/game.mjs`, whose static closure is 76 files (read with a literal-import walk, no execution, and no `child_process`, `worker_threads`, `process.env` or non-literal `import()` in it). That closure includes:
  - `permutation-server/web/frontier/fland.mjs` and `web/lang.mjs`, the subjects of the refused muster test;
  - files that match the key scan's `PAT`: `web/frontier/fplay.mjs`, `web/session.mjs` and the vendored noble curves (`web/sdk/vendor/noble/curves/…`).
  
  So this test is **not** claimed to be independent of the refused work or key-free. Whether it may run at all, and only through `scripts/ci/node-keyfree.sh` with `no-keys-guard.mjs`, is the coordinator's prior decision. It must not run by another route, and it is not a substitute for any refused test.
- **The key-scan list looks stale already at `aec70744` (an observation for its owner).**
  - `scripts/ci/scan-node-key-tests.mjs` follows every relative import, `src/` included, and excludes a test whose closure names a key API unless `node-key-reviewed.txt` names it.
  - `play.test.mjs` (which imports `game.mjs`) is listed in `node-key-tests.txt`.
  - `place-unknown.test.mjs`, `road-unknown.test.mjs` and `shortfall-coverage.test.mjs`, which also import `game.mjs`, are in neither list. So `scan-node-key-tests.mjs --check` would presumably not pass at `aec70744` (inferred, not run).
  - The new `shortfall-hours.test.mjs` is a fourth such file. The lists are **not** changed here: they are generated by the scan (`--write`), and rewriting them is the list owner's call.

**Not verified:** any run, including the existing `shortfall-coverage.test.mjs` with the change, and the real MCP output.
