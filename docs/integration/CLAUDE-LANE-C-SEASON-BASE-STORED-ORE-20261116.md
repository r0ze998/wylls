# Lane C — P3: `seasonBase` reads the terrain ore stored on the holding first (2026-11-16)

- **Base:** `claude/canonical-candidate-20261116` @ `d16048aa` (remote checked).
- **Branch:** `claude/lane-c-season-base-stored-ore-20261116`.
- **Changed:** `permutation-server/web/frontier/fs1.mjs` only (`seasonBase`, plus the new `storedTerrainOre`).
- **New:** `permutation-gateway/test/web-frontier-season-base-stored-ore.test.mjs` (**written, not run**) and this report.

**Nothing was run.** That covers tests, syntax checks, imports, worlds, servers and browsers.

**Not touched:** `fland.mjs` (P1 and P2 stay on their own branch, unchanged), `rulebook.mjs`, `onboarding.mjs`, `board.mjs`, the controller, the app, the map, the dictionaries, the server and the other tests.

## Re-verified from the code (it is real)

**The program.** `permutation-frontier/src/proc/holding.rs` `copy_number`:
- `base = arms::base_production(h.tier, terrain_ore)[resource]`
- `built = (production − base).max(0) / per`
- the result is `built + queued + 1`.

`terrain_ore` is always the holding's stored `holding2::TERRAIN_ORE` (`terrain_ore(d)`), written at founding or capture. `settle_tiered` takes the same value.

**The page (candidate).**
- `fs1.mjs` `seasonBase` set `b[3]` only from the map (`oreExtraFor`, or a passed `oreExtra`), else null.
- `hud/rulebook.mjs` `copyNumber` then falls back to `baseProduction(tier)[3]`, which is 15000.

**Example: S1 Hamlet, stored ore 13000, one mine (6000/h), so ore production 19000, map unread.**

| Reader | Page before | Program / now |
|---|---|---|
| `copyNumber(h, 3)` | (19000 − 15000) / 6000 = 0 → copy **1** (first-copy price) | (19000 − 13000) / 6000 = 1 → copy **2** |
| `board.mjs` `buildingsOf` | ore null, so the mine is not drawn: **0** | **1** |
| `onboarding.mjs` `hasBuilt` | ore null, so ignored: **false** | **true** |
| `fland.mjs` promotion (candidate `tierBase` goes through `seasonBase`) | M1 base: 20/h after Hamlet → Village | 13000 × 150 / 100 = **19.5/h** |

## The change

`seasonBase`, on S1 only:
- **Stored value present:** `b[3] = stored × (100 + bonusPct) / 100`, with BigInt truncation. This is `arms::base_production`'s ore line.
- **No stored value:** the old path, the map's reading (registered or passed) via `s1OreBase`.
- **Neither:** `null`, as before.

`storedTerrainOre(h)` accepts:
- a BigInt (the decoded i64);
- a safe-integer Number (hand-built fixtures).

It returns null in three cases:
- the value is absent (a v1 record, a fixture);
- it is not an integer;
- it is not above 0.

**Why 0 counts as "none".** A written value is at least `ORE_BASE_PER_HOUR × 1000` (4000). Zeros are the field's reserved bytes in an older record, and `arms.rs` `holding_base_production` likewise reads `terrain_ore > 0` as "has terrain ore". So no ore base is guessed from a 0.

**Decoding (read, not run).** In the v2 layout, Holding is `chained` and its size is 1280. `fcodec` decode picks profile 2 when `LAYOUT_VERSION` is 2. `TERRAIN_ORE` then decodes as the BigInt `terrainOre`, for `/h/me` and the province holdings in `herald.mjs`.

## Existing contracts (counter-review, on paper)

- **Off S1 (M1/MC):** `seasonBase` returns `baseOfTier` unchanged, as before.
- **No stored value** (every existing fixture: only `web-frontier-economy-display.test.mjs:136` names `terrainOre`, as a function parameter): results are identical. That includes:
  - the `seasonBase(…, { tile: 30 }, { oreExtra: 9 })` pin;
  - the uplift cases (registered map reading, explicit `oreExtra: 6`, "terrain not known" → 0 / false).
- **Explicit map `oreExtra`** still decides when the holding has no stored value.
  - When it has one, the stored value wins, because the program uses no other.
  - This is the only behaviour change for a holding that carries `terrainOre`, and it brings the page in line with `copy_number`.
- **Tier bonus:** the same `TIER_BONUS_PCT` the callers pass (`catalog::tier_bonus_pct`), with `| 0` as in `s1OreBase`.
- **The non-ore entries** are untouched.
- **The P2 branch** (`claude/lane-c-production-projection-20261116`) is compatible.
  - For a stored value above 0 it gives the same number. With this change, its P2 part is redundant but harmless.
  - The two differ only for a stored 0: P2 uses 0, this change treats it as none. A real S1 holding never stores 0.
- **Not exercised:** none of the above was executed. The existing tests were read, not run.

## Paper cases (in the new file; not run)

1. **The Rust read:** `copy_number`'s base, built and +1 lines; `terrain_ore` from `H2::TERRAIN_ORE`; the `base_production` ore line; `holding_base_production`'s `> 0`.
2. **Stored 13000 with production 19000:** copy 2, one mine drawn, `hasBuilt` true. With 13000 alone: copy 1, 0, false.
3. **A map reading of +20, registered or passed:** the stored value still decides (copy 2, mine 1).
4. **The tier bonus:**

   | Tier | Stored ore | Ore base | Production | Result |
   |---|---|---|---|---|
   | Village | 13000 | 19500 | 25500 | copy 2 |
   | Town | 13000 | 26000 | 38000 | copy 3, two mines |
   | Stronghold | 13001 | 35752 (truncated) | — | — |

5. **Contracts:**
   - Off S1: unchanged.
   - No stored value: the map path, else null.
   - `0n`, `-5n`, `0`, `'13000'`, `1.5`, null, undefined: no stored value.
   - A Number 13000 is read like the BigInt.
   - The non-ore entries are untouched.
6. **The effect on candidate `fland.projectedHolding`:** Hamlet → Village with stored 13000 gives ore 19.5/h.

## What this adds toward ① to ⑳

**This branch's change:** the S1 build card's copy number and price, the village picture's building count, and the guide's "built" step. With the map not yet read, these now follow the program's stored terrain ore (P3).

**Side effect, unchanged code:** the candidate's promotion projection in `fland.mjs` gets the right ore base through `seasonBase` (the P2 number), without touching `fland.mjs`.

**Not claimed:** none of this has been seen working in a live S1 world or a browser, and no test has run. It counts toward the display items only as a static, paper-checked fix.

## Not verified

- No run of any kind, including the new file.
- Real herald holdings carrying `terrainOre` (decoding is read from the layout and codec only).
- Screen fixtures (`permutation-gateway/screens/*`) that might hand-build S1 holdings with `terrainOre`: none found by grep. Not run.
