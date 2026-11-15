# Lane C — economy display regression (2026-11-16)

A display-only check: the economy figures the page works out in browser code, set against the Rust rules they copy. Nothing in a page or rules file was changed.

- **Branch:** `claude/lane-c-economy-display-20261116`. It was cut from round 49 `68e8548d`, the last checked canonical commit, not from the unverified tip `bcc63a24`.
- **Test:** `permutation-gateway/test/web-frontier-economy-display.test.mjs` (sha256 `4a7209d6…687fd35e` at commit `3efadfe6`; first version `42e881a4`).
- **Run:** `node --test test/web-frontier-economy-display.test.mjs`, from `permutation-gateway/`. Only this file was run.
- **Result:** 10 tests. 9 pass, 0 fail, 1 todo (E1). Exit code 0.
- **Rust side:** the test reads `permutation-rules/src/frontier/{catalog,arms,holding}.rs` and `src/units.rs` as text. It never builds Rust.
  - It first checks that each formula it re-implements still reads as it does in the Rust source (`base_production`, `ore_around`, `duplicate_cost`, `build_secs`, `train`, `train_v2`, `train_v3`).
  - It then rebuilds each figure from the parsed tables and compares it with what the page's own functions return.
- **Dependencies:** none. The test loads no SDK, needs no node_modules, downloads nothing and opens no ports.

## Figures checked — all match unless marked

| # | Figure on screen | Page side | Rust side | Range checked | Result |
|---|---|---|---|---|---|
| 1 | Resource order of the stores | `frontier/resources.mjs` `RESOURCE_ORDER` | `holding.rs:67` `enum Resource` | 8 resources | match |
| 2 | Unit order | `fland.mjs:28` `UNIT_ORDER` | `units.rs` `UNIT_STATS` | 8 units | match |
| 3 | Base production per hour | `fland.mjs:110` `BASE_PROD` and `fland.mjs:113` `baseProduction` | `catalog.rs:43` `BASE_PROD`, `catalog.rs:46` `tier_bonus_pct`, `catalog.rs:151` `base_production` | 4 tiers | match |
| 4 | S1 terrain ore, as a village's ore base | `fs1.mjs` `s1OreBase` and `seasonBase` | `arms.rs:126` `base_production`, `arms.rs` `ore_around`; `ORE_BASE_PER_HOUR`, `ORE_TERRAIN_MAX` | 4 tiers × terrain extra 0, 1, 7, 30, 31, 60 | match |
| 5 | Map's terrain-ore reading (hills 2, mountain 3, iron 4, radius 2, cap 30) | `map/sprites.mjs:63` and `map/sprites.mjs` `oreAround` (checked as text) | `arms.rs:171–180` | — | match |
| 6 | 収穫 button **毎時 +N**: the sum of what the stores gain in an hour | `hud/hand.mjs:97` `harvestModel`, `hud/hand.mjs:138` | sum of `catalog::base_production(t)` (M1/MC) or `arms::base_production` (S1) | new village at each of 4 tiers, M1/MC and S1 (terrain +9) | match: 125 / 186 / 250 / 342 on M1/MC |
| 7 | Harvest **+N** an hour later | `harvestModel` `total` (from `rulebook.grownSince`) | each store's whole units | same 8 cases | match |
| 8 | Harvest figure with a store full (a full store adds nothing) | `harvestModel` | — | Town with food full | match (186 − 60) |
| 9 | Resource strip: rate and cap of each store | `hud/hud.mjs:64` `resourceModel` (over `fland.storesAt`) | `base_production`; `holding.rs:135` `storage_cap` | same 8 cases | match |
| 10 | Store cap, things under way at once, worked land | `hud/rulebook.mjs` `STORE_CAP`, `QUEUE_SLOTS`, `WORKED_RADIUS` | `holding.rs:110` `worked_radius`, `holding.rs:127` `queue_slots`, `holding.rs:135` `storage_cap` | 4 tiers | match |
| 11 | Building's next copy: copy number, cost, build time and **+N/時** yield | `hud/rulebook.mjs` `buildOffers`, `copyNumber`, `duplicateCost`, `buildSecs`; `fland.mjs` `BUILD_ITEMS` | `catalog.rs:66` `BUILDINGS`, `holding.rs:198` `duplicate_cost`, `catalog.rs:106` `build_secs` | 6 buildings × 4 tiers × copies 1–4; duplicate rule and time for copies 1–64 | match |
| 12 | S1 workshop: cost, time, arms per hour, ore and wood per arm | `fs1.mjs` `WORKSHOP` and the `buildOffers` workshop offer | `arms.rs:48–67` | 4 tiers × copies 1–4 | match |
| 13 | S1 ore mine's copy number, counted from the terrain base | `rulebook.copyNumber` together with `fs1.seasonBase` | `permutation-frontier/src/proc/holding.rs:531` `copy_number` (`arms::base_production`) | 4 tiers, 2 mines built | match |
| 14 | Walls: +100 for 300 stone in 4 h, 1,200 at most | `rulebook.WALLS` and the walls offer | `catalog.rs:130–132`, `holding.rs:180` | neutral doctrine | match. Not checked: the doctrine's `wall_cost_bps` (Aster's 95%) |
| 15 | Promotion card: cost, time, bonus % from → to, cap, slots, land | `rulebook.promotionOffer`, `TIER_UP`; `fland.mjs:51` `TIER_UPGRADES` (a second copy of the same table) | `catalog.rs:112` `tier_up`, `tier_bonus_pct`, holding.rs tier tables | 3 promotions, plus none at Stronghold | match |
| 16 | Promotion `gives.base` (gain per resource) | `rulebook.mjs:200` | difference of `catalog::base_production` | 3 promotions | match for M1/MC. Not drawn on screen: the hand shows % only, and `screens/holding.mjs:91` `upgradeModel` has no caller. On S1 the ore entry would be wrong, as in E1 |
| 17 | Strip after a promotion is done, before the next record (M1/MC) | `fland.mjs:267` `projectedHolding` | `catalog::base_production` gain; `storage_cap` | 3 promotions | match (but see O1) |
| 18 | **Strip after a promotion is done, on S1** | `fland.mjs:302` | `permutation-frontier/src/proc/holding.rs:498–502` `settle_tiered` → `arms.rs:126` | 3 promotions, terrain +9 | **MISMATCH — E1** (todo) |
| 19 | Clamps used by the projection: production 1,000/h, upkeep 10⁸/h, caps at a tier-up | `fland.mjs` `projectedHolding` (checked as text) | `holding.rs:186` `MAX_PRODUCTION_PER_HOUR`, `holding.rs:193` `MAX_UPKEEP_PER_HOUR`, `storage_cap` | — | match |
| 20 | Training cost (food, ore, gold, S1 arms), in both page copies | `hud/rulebook.mjs` `trainCost`; `fland.mjs:34` `trainingCost` | `catalog.rs:245` `train` (M1), `catalog.rs:314` `train_v2` and `TRAIN_PROD_COST_V2` (MC), `arms.rs:147` `train_v3` and `TRAIN_ARMS_PER_100` (S1); `units.rs` `prod_cost` | units 0–7 × v1/v3/v4 × n = 1, 99, 100, 101, 250, 1,000, 30,000 | match (the Settler is refused on both sides) |
| 21 | Training max ("最大 N") | `rulebook.maxTrain` | the largest hundred whose `train*` cost fits | 7 units × 3 versions | match |
| 22 | Unit strength (強さ N) | `rulebook.UNIT_STATS`; `orderparts.unitStrength` | `units.rs` `UNIT_STATS` (class, strength, move, prod) | 8 units | match |
| 23 | S1 siege arms | `fs1.mjs` `SIEGE_ARMS` | `arms.rs:156` | — | match |
| 24 | Settler cost of the next village | `fconquest.mjs` `settlerCost` | `catalog.rs:136` `SETTLER_COST` × `duplicate_cost` (`permutation-frontier/src/proc/citizen.rs:644` `settler_cost`) | n = 1–6 | match |

Figures not checked here, because they are not computed by the page:

- **Current upkeep (現在の維持費).** `screens/holding.mjs:239` shows the account's own `UPKEEP` divided by 1,000. It mirrors no table.
- **Troop upkeep.** `holding.rs:224` `troop_upkeep_per_hour` has no copy on the page.
- **Siege stake gold, 500.** This is a season parameter (presets), not a permutation-rules table.

On S1 a rate can be a half under a tier bonus, for example ore 13 × 150 / 100 = 19.5 an hour. The figure then shows a decimal (毎時 +183.5) while the stores grow by whole units (+183). That is faithful to the record, not a mismatch.

## English

The test checks each economy line, both ways:

- **The page source still holds the line:** `hud/hand.mjs`, `hud/hud.mjs`, `hud/orderparts.mjs` and `screens/holding.mjs`, plus resource and tier names.
- **The English reads correctly**, with real figures filled in:
  - no Japanese left in it;
  - no banned word (`settl*`, keeper, beacon, seed, "bell N", secret, site ticket, lamport);
  - no American spelling (color, center, neighbor, defense, favor, honor, armor, labor, gray, traveled, meter, liter, catalog, …).

Every line passes, for example "+186 per hour" and "Defence +100". The Pikeman's training cost reads "Cost: Food 60 · Ore 40 · Horses 50 · Gold 20" off S1 and "Cost: Food 60 · Ore 40 · Arms 50 · Gold 20" on S1: the Horses slot is named arms on S1 (`fi18n.mjs` `RESOURCES`).

## Mismatches

### E1 — the strip after an S1 promotion: the ore gain is the M1 one

- **Page:** `permutation-server/web/frontier/fland.mjs:302` (`projectedHolding`). When a finished promotion is projected, the page adds `baseProduction(new) − baseProduction(old)`, which is the 15-based ore of `catalog::base_production`. This happens on every season.
- **Rust:** `permutation-frontier/src/proc/holding.rs:498–502` (`settle_tiered`) adds `arms::base_production(new, terrain_ore) − arms::base_production(old, terrain_ore)` (`permutation-rules/src/frontier/arms.rs:126`). There, the ore entry is the village's terrain ore under the tier bonus.
- **Which side looks wrong:** the page. The Rust rule is the S1 design (redesign 30 §1-4: the base "is recomputed at tier-up"). The page already uses the terrain base elsewhere: `rulebook.copyNumber`, `map/board.mjs`, `onboarding.mjs`.
- **What a player sees:** after a promotion finishes, and until the next record arrives, the strip's ore rate is off. With terrain +9 (13 ore an hour):
  - Hamlet → Town: the page shows 13 + 7 = 20 an hour; the program gives 19.5.
  - Town → City: the page shows 26.5; the program gives 26.
- **In the test:** `todo: 'doc E1 …'` (test 7).
- **Proposed patch (not applied):** tried in a scratch copy. With it, test 7 passes and the other 9 still pass.

```diff
--- a/permutation-server/web/frontier/fland.mjs
+++ b/permutation-server/web/frontier/fland.mjs
@@ -6,7 +6,7 @@
-import { TRAIN_ARMS_PER_100, WORKSHOP, s1On } from './fs1.mjs';
+import { TRAIN_ARMS_PER_100, WORKSHOP, s1On, seasonBase } from './fs1.mjs';
@@ -299,7 +299,10 @@ export function projectedHolding(holding, now) {
     if(Number(h.tier)!==oldTier) {
-      const before=baseProduction(oldTier),after=baseProduction(Number(h.tier));
+      // (S1: the program's settle_tiered applies arms::base_production — the ore entry is the village's terrain ore under
+      // the tier bonus; while the terrain is not known the M1 base is used, as rulebook copyNumber does)
+      const tierBase=t=>{ const m1=baseProduction(t); return seasonBase(m1,holding,{bonusPct:TIER_BONUS_PCT[t]??0}).map((v,i)=>v ?? m1[i]); };
+      const before=tierBase(oldTier),after=tierBase(Number(h.tier));
       h.production=h.production.map((p,i)=>p+after[i]-before[i]);
     }
```

Once the patch lands, drop the `todo` option from test 7. Other suites that touch `projectedHolding` have not been run with the patch.

## Open (not asserted)

### O1 — which seasons get the terrain-ore base

At round 49 the program founds every first village and every outpost with the site's terrain ore. See `permutation-frontier/src/proc/citizen.rs:1301` and `:1505`/`:1524` (`arms::base_production(Hamlet, terrain_ore)`). It also always reads that terrain ore in `settle_tiered` and `copy_number` (`proc/holding.rs:485`, `:531`).

The page switches to the terrain base only when the season is S1: `fs1.mjs:9` `s1Season` needs layoutVersion 2 and programVersion ≥ 4.

If an MC season (programVersion 3) runs on this program, the page's non-S1 path disagrees with the program in three places:

- the ore mine's copy number, and so its cost;
- the strip after a promotion;
- the onboarding "built" count.

Whether such a season still exists needs the season matrix. That is outside this lane, so it was not asserted. The page's non-S1 path does match `catalog::base_production`, which is what the test pins.

### O2 — what the program uses when the terrain is unknown

While the map has not read the terrain, `seasonBase` returns `null` for ore and `copyNumber` falls back to the M1 base. The program never has this "unknown" state. The fallback is documented on the page and is left as it is.
