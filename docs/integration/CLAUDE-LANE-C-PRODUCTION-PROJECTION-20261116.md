# Lane C — the holding projection after a promotion or a completed building (2026-11-16)

Base: `claude/canonical-candidate-20261116` @ `d16048aa` (remote checked). Branch: `claude/lane-c-production-projection-20261116`.

**What changed:**
- `permutation-server/web/frontier/fland.mjs`, in `projectedHolding` only.
- New file `permutation-gateway/test/web-frontier-production-projection.test.mjs`.
- This report.

**No test, syntax check, import, world, server or browser was run.** All new test runs were paused when this was written. The regression file is **written, not run**: its expected figures are paper cases, worked by hand from the Rust below. E1 was not re-applied, and its code is unchanged.

## P1 — the workshops' use of ore and wood was lost after any rate change (fixed)

**The rules.** `permutation-rules/src/frontier/holding.rs` sets every store's rate through `apply_rates`:
- **`full_rates`** is `net_rate` (production, halved when dormant, less upkeep), then two adjustments:
  - ore is reduced by the workshops' output × `ORE_PER_ARM` (2), and wood by the output × `WOOD_PER_ARM` (1);
  - arms is reduced by `lent_arms`, the lent copies' share (`lent_workshops × WORKSHOP_DELTA`).
- **`limited_rates`** applies when an input would go below 0 within the second. The workshops then run at the share (in bps, rounded down) that the scarcer input's own net production sustains.
- **The dry moment.** `Holding::settle` treats the moment an input runs dry (`dry_at`) as an event of its own. On a tie the order is completion, then dormancy, then dry.

**The page.** After any completion or dormancy, `projectedHolding` set every rate to production − upkeep. So for an S1 village with workshops:

| | Page before | Program |
|---|---|---|
| After a completed building (one workshop, terrain ore 13) | ore 13/h, wood 30/h | ore **5**/h, wood **26**/h |
| Two workshops, one lent | arms 8/h | arms **4**/h |
| Ore 4/h and one workshop, from 2 ore, after 1 h | arms 4, wood 126 | arms **3**, wood **127** (limited from +1800 s) |

The effect reaches the strip, training affordability (`trainQuote`) and `screens/s1.mjs` `oreStarved`. `oreStarved` reads `ore.perHour <= 0`, and the page showed a positive ore rate there.

**The fix.** `net_rate`, `full_rates`, `limited_rates`, `lent_arms`, `dry_after`, `dry_at` and the event order are written over BigInt, line for line with the Rust:
- Every division is a non-negative truncation, the same as Rust's.
- `lentWorkshops` is read from the decoded v2 Holding (`LENT_WORKSHOPS`), and is 0 when absent.

**Unchanged for a holding without arms production** (every M1 and MC holding): `full_rates` reduces to the plain net rates, and no dry event exists. Dormancy uses `prod*5000/10000`, which equals the old `prod/2` for a non-negative value.

## P2 — a promotion took the ore base from the map, not from the holding (fixed; this is O2)

**The program.** On S1, `settle_tiered` applies `arms::base_production(tier, terrain_ore)`:
- `terrain_ore` is the value **stored on the holding**: `holding2::TERRAIN_ORE`, read by `proc/holding.rs` `terrain_ore(&hd)` at every caller.
- It is written at founding or capture from the Province's stored terrain.

**The page.** It used the map's reading (`seasonBase` → `oreExtraFor`). While the map is unread it fell back to the M1 base. That is the O2 fallback: a guessed number shown as settled.

**Example.** Terrain ore 13 (4 + 9), Hamlet → Village:

| | Ore after the promotion |
|---|---|
| Program | 13 × 150/100 = **19.5**/h |
| Page, map unread | 15 → 22, so **20**/h |
| Page, map reading +20 | **25**/h |

**The fix.** On S1, when the decoded Holding carries `terrainOre` (an i64, so a BigInt), the ore entry becomes `max(0, terrainOre) × (100 + bonus) / 100`, which is `arms::base_production`. In every other case the old path stays: off S1, or a holding without the field (v1 decode, hand-built fixtures). Nothing is guessed: the record's own number is used.

## Paper cases (in the new file; not run)

1. One workshop, a farm completes: food 50, ore 5, wood 26, arms 4.
2. Two workshops, one lent: ore 5, wood 26, arms 4.
3. Dry ore:
   - **The full rates:** ore −4/h from 2 ore.
   - **The dry moment:** it runs dry at +1800 s (2000 × 3600 / 4000).
   - **The share:** min(4000·10⁴/8000, 10⁴) = 5000.
   - **The limited rates:** ore 0, wood 28, arms 2.
   - **At +3600 s:** arms 3, wood 127, ore 0.
   - **Unchanged:** at +1799 s nothing has changed yet, and a holding already running limited stays limited.
4. No arms production (M1): plain net rates (ore +6 → 21).
5. Promotion with stored terrain ore 13000: ore 19.5 with the map unread, and still 19.5 with a different map reading. Food goes 40 → 60.
6. Text pins:
   - from the Rust: `CONVERSION_INPUTS`, the workshop constants, the `base_production` ore line, the dry filter, and `touch` on the stored `terrain_ore`;
   - from the page: the existing pins in `web-frontier-economy-display.test.mjs` (`clampBig(h.production[i],0n,1000000n)`, the upkeep clamp, the caps) are kept verbatim.

## Counter-review (read, not run)

- **Event order:** completion if `next ≤ dorm` and no dry moment before it; then dormancy; then dry. This matches `Holding::settle`. The page applies all completions at one time together, then sets the rates once. That gives the same result as the Rust's one-at-a-time loop, because a dry moment at that same time is not "before" it (strict `<`).
- **A promotion:** `settle_tiered` settles to the promotion's time, adds the base difference, then calls `set_upkeep`, which calls `apply_rates` with the dry check. The page's `rates(next)` does the same after the base difference.
- **The loop always ends:** after the dry branch the rates are the limited ones, so they differ from `full` for the dry input, and `dry_at` returns none (as in the Rust).
- **Projecting twice** (`storesAt(settled(h))`) is a no-op the second time.
- **Existing tests read on paper:**
  - `web-frontier-economy-display.test.mjs` uses villages with no arms production and no `terrainOre`, so its numbers are unchanged.
  - The text pins in `web-frontier-dispersed-map` and `web-frontier-join-free` cover other functions.
  - **None was run.**

## Outside this scope (found; not changed)

**P3 — the same map-only ore base in three read-only places.**
- `hud/rulebook.mjs` `copyNumber` (it also falls back to the M1 base), `onboarding.mjs` `hasBuilt` and `map/board.mjs` `buildingsOf` all take the ore base from `seasonBase`, which reads only the map.
- The program's `copy_number` uses the stored `terrain_ore`.
- **Example:** terrain ore 13 and one mine, so ore production is 19.
  - The program counts 1 built, so the next is copy 2 at `duplicate_cost`.
  - The page with the map unread counts (19 − 15) / 6 = 0 built, and offers copy 1 at the first copy's price.
- **Minimal proposal:** fix it once, in `fs1.mjs` `seasonBase` (its owner): when `typeof h?.terrainOre === 'bigint'`, set `b[3] = max(0, h.terrainOre) × (100 + bonusPct) / 100` before trying the map. The P2 branch here then becomes redundant but harmless.

## Not verified

- No run of any kind, including the new file: the regression cases are paper cases.
- That `/h/me` and wide holdings always reach `projectedHolding` with `terrainOre` and `lentWorkshops` decoded. Read: the v2 `Holding` layout has both, and the codec camel-cases them. Not observed.
- Real herald data and live S1 villages with workshops: not observed.
