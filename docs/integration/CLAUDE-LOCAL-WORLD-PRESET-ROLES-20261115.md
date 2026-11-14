# Local-play world presets: who can join, where a first village may go (measured, 2026-11-15)

The normal wallet game only. No NFT, transfer or territory claim is made here.

## The rule a first village follows (program and page agree)

- **Program:** PlaceHome is accepted only on a free site of an **opened** province in ring **2 … heartland_max_ring** of the joiner's nation. Above the heartland it is refused (ReservedSite).
- **Page:**
  - `home.mjs` `homeSites` needs ring ≥ 2 and ring < the open-ring count;
  - `homeRingsOpen(season, n)` caps that count at `heartlandMaxRing + 1`;
  - `planHomes` reads up to 24 candidate provinces and offers free sites, or says `NoFreeHome`.

## The two presets

| Preset | How the world is made | Rings seeded / provinces opened | Can a NEW player join and place a first village? |
|---|---|---|---|
| `local-natural-v1` (natural) | the runner's own Season by real instructions (Announce → Create → beacon → shards → genesis seed → OpenRing up to the heartland → **OpenProvince for every heartland home province**); the player's **real Join and PlaceHome** from the page | rings 0 … heartland, contiguous; every heartland home province opened | **Yes**, by the normal rule (this is that preset's purpose) |
| `local-conquest-test-v1` (conquest) | the runner's Season and a **synthetic** home for the world's wallet at ring 128 (Citizen, Holding written by the runner), opened by a real OpenProvince; the siege's free city prepared | **only ring 128** (`record.rings = [{d:128}]`) and the one province (128, 0); Season `heartlandMaxRing 3`, `genesisRing 3`, `placement 0` | **No**. No ring 2–3 province is opened, and ring 128 is above the heartland. The page's `NoFreeHome` is correct (measured in world 5) |

**Roles:**
- The **natural** preset is the world for new players: Join, a first village, then the economy.
- The **conquest** preset is a siege test around the world wallet's own synthetic home. It takes no new joiner, and nothing should be added to it to make one possible (an isolated ring-2 province without seeds for rings 0–2 would break the contiguous-ring meaning the page and the keeper rely on).

## The page's ring count (an inconsistency to fix; agreed in principle with the main CC)

| Reader | Count it uses | Sparse `[{d:128}]` | Natural rings 0–3 |
|---|---|---|---|
| map tap (`app.mjs:4106`) | `contiguousRings(world)` (the unbroken run from ring 0) | 0 | 4 |
| planner, confirm (`controller.mjs:1552`, `:1647`) | `record.rings.length` | **1** ("ring 0 open": meaningless here) | 4 |
| ticket (`controller.mjs:1732`) | `record.rings.length` | **1** | 4 |

- All three should read `contiguousRings`, the same rule as the map tap and the overview loop's own comment ("never counted from the record's length").
- In world 5 both readings give no candidate, so this was not the cause of `NoFreeHome`. It is a wrong meaning that a gap world (rings 0, 1, 3) would expose.
- To be fixed as a small page round with pure fixture tests (sparse, contiguous and gap vectors); owner and handshake with the main CC.

## Not done (kept as is)

- An NFT and its territory operations in one world: not proven. Worlds 4 and 5 proved mint → transfer → JoinResident on the conquest preset; its first village is impossible there by the rule above, so Build / Train / Muster as the NFT were not reached.
- Nothing here restarts NFT, transfer or variant tests on any preset.
