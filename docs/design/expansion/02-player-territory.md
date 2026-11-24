# Expansion 2: player territory instead of "villages + the 3-holding cap" (owner Q-2)

Status: **design + parameter seams only** (territory-q2, draft PR stacked on #206, 2026-11-24). No rule is live in
any world. Nothing is deployed. The open owner questions T-1 … T-13 block every number and most of the on-chain shape.
They are listed in full in `~/Projects/wylls-grok-state/inbox/2026-11-24-0933-territory-q2-questions.md` and in
§6 below.

## 1. What r0ze decided (2026-11-24 09:24 JST, Q-2)

- Each player owns a **territory** (a set of provinces or tiles), and it grows by **claiming**.
- **Exclaves are allowed** (a territory need not be contiguous).
- There is **no fixed holding cap**. Expansion is limited by **upkeep cost**.
- **Villages become buildings** placed inside one's territory.

Related decisions on #206 (t498u, 09:22):
- Q-1: wide land starts neutral and land keeps opening.
- Q-3: captured-keep reach counts for the whole nation.
- Q-4: the devnet upgrade is approved once verified. Never 01:30–03:30 JST on 11-25.

## 2. What the code has today (origin/grok/expansion-gameplay-1 1d7ebc4c)

| Fact | Where |
|---|---|
| One province is a hex of 61 tiles, with 12 village sites and one keep tile | `geometry::PROVINCE_TILES`, `layout/province.rs SITES_N` |
| A citizen holds at most 3 villages, as 3 `HoldingRef`s **inline in the Citizen account** (bytes 168–185) with a `slots` byte; 36 bytes are reserved at 348 | `frontier-abi/src/v2/layout/player.rs`, `holding.rs MAX_HOLDINGS_PER_WALLET` |
| A Holding's address is keyed by **location** (p, q, site), not by citizen slot | `frontier-abi/src/addr.rs holding` |
| A new village is a lottery ticket that settles at turn end, at a settler ore cost (800 for the 2nd, 1,200 for the 3rd) plus the Holding's SOL rent | `proc/wide.rs claim_site`, `proc/citizen.rs settler_cost` |
| Upkeep exists for **troops only**: a per-hour food rate on a Holding, with a food-shortfall path | `holding.rs troop_upkeep_per_hour`, `set_upkeep`, `Effect::Upkeep` |
| An opt-in **nation** land kernel ("Standing Ground", `land-preview`) already keeps one owner per tile per province in a side record `ld‖p‖q`. It is driven by standing hosts, not by claims, and is localnet only | `permutation-rules/src/frontier/land.rs`, `permutation-frontier/src/proc/land.rs` |
| #206's reach rule: a claim may be up to 3 from the first home **or** from a reach witness of the nation's land | `frontier-abi/src/world_index/reach.rs` |

## 3. How comparable games limit expansion

Open source, read from source and pinned (the same commits as `01-reach-from-land.md` §3):

- **Unciv** (Civ V rules). Tiles join a city through culture or a **gold purchase**. The cost grows with tiles already
  owned. There is −3 happiness per city.
  - [CityExpansionManager.kt#L45-L104](https://github.com/yairm210/Unciv/blob/ffe8af9142a240c527162d1a82db596b0bdce517/core/src/com/unciv/logic/city/managers/CityExpansionManager.kt#L45-L104)
  - [CityStats.kt#L398-L407](https://github.com/yairm210/Unciv/blob/ffe8af9142a240c527162d1a82db596b0bdce517/core/src/com/unciv/logic/city/CityStats.kt#L398-L407)
  - Lesson: price growth per tile owned is the brake. No hard cap.
- **Freeciv** (civ2civ3). Borders come from city radius and bases. **Waste grows with distance** from the nearest
  government centre.
  - [city.c#L3355-L3377](https://github.com/freeciv/freeciv/blob/57f130ecac4db5dd89371c6891db15cc94641697/common/city.c#L3355-L3377)
  - [borders.c#L31-L63](https://github.com/freeciv/freeciv/blob/57f130ecac4db5dd89371c6891db15cc94641697/common/borders.c#L31-L63)
  - Lesson: a distance cost makes far exclaves possible but dear. This is design doc 14's 「遠くへ建てるほど重い」.
- **Widelands**. You may build **only inside your own land**, and land comes only from manned military sites.
  - [player.cc#L558-L578](https://github.com/widelands/widelands/blob/ed17072e0203b0718e882dc2acc686db0dab3a4d/src/logic/player.cc#L558-L578)
  - Lesson: this is exactly "villages are buildings inside territory". The frontier is readable.

Commercial games, from their published rules (no source):

- **Humankind**:
  - a territory (a region) is claimed whole by an **outpost**, which costs influence;
  - outposts attach to cities;
  - exceeding the city cap costs influence and stability;
  - conquest takes territories by taking their outpost or city.
  - Closest to "claim a province, then build in it".
- **Endless Legend**: one region, one city. The region is the unit of land.
- **Old World**: cities stand on fixed city sites. Borders grow by culture. Orders and discontent are the expansion
  brake.
- **Civ VI**: tile purchase in gold, plus culture borders. There are no exclaves except via cities.

## 4. The seam this PR adds (answer-independent)

`permutation-rules/src/frontier/territory.rs` (feature `territory-preview`, off by default, in no hash).
It has a page and AI copy, `permutation-server/web/frontier/territory-rules.mjs`, checked against the committed
vectors `permutation-rules/vectors/territory-preview.json`.

| Open question | Parameter |
|---|---|
| T-1 unit | none: a *cell* is whatever the caller counts (tile or province); the kernel sees distances and bells |
| T-2 reach / sources | `ReachRule { range (0 = unlimited), sources: SRC_HOME \| SRC_OWN \| SRC_NATION_KEEPS \| SRC_NATION_LAND }` |
| T-3 cost / pace | `ClaimCost { base, per_owned_bps }`, `claims_per_turn` |
| T-4 upkeep curve | `UpkeepCurve { flat, per_rank, per_distance, free_distance }`: covers flat, count-growing, distance-growing, both |
| T-5 unpaid | `UnpaidRule { block_claims, production_bps, decay_after_bells, decay_every_bells }` + `DecayOrder::{Farthest, Newest}` |
| T-7 owned land | `claim_owned` |

Calibration aid for T-4: `cargo run -p permutation-rules --features std,territory-preview --example
territory_calibrate` prints how many cells a player keeps at a given spare food income under the four candidate
curves. For reference, a Hamlet makes 40 food/h, a Town 60, a City 80, and a farm adds 12. The table from this run is
`evidence/territory-q2/calibration-T4.md`.

Upkeep fits the existing holding economy. A territory's upkeep can be one more `Upkeep` rate of a holding (the same
cap `MAX_UPKEEP_PER_HOUR`), so the shortfall path, the settle-to-time model and path independence carry over. Which
holding pays is part of T-4.

## 5. On-chain shapes, by answer (not built: each depends on T-1 / T-6 / T-12 / T-13)

| Answer | Ownership storage | Village cap removal | Rent |
|---|---|---|---|
| T-1 province + T-12 (b) | one owner (Citizen tag, 8 B) + claimed bell + last-paid bell in the WideProvince's 128-byte trailer or reserved bytes | — | none new |
| T-1 tile | a per-province side record like `land-preview`'s `ld‖p‖q`: 61 × owner index + a per-province owner table | — | the first claimer in a province pays it (T-12) |
| T-6 (a) uncapped villages | — | Holding addresses are already per location; the Citizen's 3 inline refs stay for slots 1–3, and further villages need a per-citizen index (side account pages `cv‖wallet‖page`) or a counter in the 36 reserved bytes plus the Holding's own owner field as the truth | one more account per index page |
| T-6 (c) cap kept for now | — | none | none |

Per-player upkeep needs a per-player territory summary: the cell count and the Σ of the distance terms, so that a claim
does not read every owned cell. That fits in the Citizen's 36 reserved bytes (count u32, distance sum u64, unpaid-since
bell u32, claims-this-turn u8 + bell u32). That summary is a layout change, but not a size change.

## 6. Open questions (blocked on r0ze; t497u)

T-1 unit · T-2 reach and sources (also verify-pr206 V-Q1) · T-3 claim cost and pace · T-4 upkeep amount and curve
(also V-Q2) · T-5 unpaid upkeep · T-6 what a village-as-building can do, and the heartland · T-7 owned land, keeps and
teammates · T-8 conquest · T-9 fog and border drawing · T-10 voluntary release · T-11 migration (local and devnet S2) ·
T-12 SOL rent · T-13 relation to `land-preview`.
Options and recommendations: the inbox file named at the top.

## 7. What a devnet program upgrade will need (once answered; Q-4 approves the upgrade after verification)

- The territory instructions (claim, release, pay/settle upkeep, decay crank) on the wide band, plus their verifier
  checks. Every tag 0xD6–0xDF is already taken (`proc/wide.rs` header table), so a new tag or an op byte under an existing
  tag must be allocated.
- If T-1 is the province: the WideProvince trailer fields (no realloc). If tiles: a new record kind.
- If T-6 (a): the Citizen's reserved bytes get a meaning, and possibly index pages. Existing S2 citizens keep working,
  because the reserved bytes are zero, and zero = no territory.
- Feature gating: `territory-preview` is not enabled by any program build yet. The deployed .so is unchanged by this
  PR (no program file is touched), so CU and size are unchanged; to be measured when instructions exist.
- #206's reach witness and the `Neutral` wide-rules candidate ride the same upgrade. Devnet's wide-rules config is
  write-once (E-Q4).
