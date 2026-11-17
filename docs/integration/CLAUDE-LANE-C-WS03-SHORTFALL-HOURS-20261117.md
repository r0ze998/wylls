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
