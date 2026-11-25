# Expansion 2: player territory instead of "villages + the 3-holding cap" (owner Q-2)

Status (2026-11-24 evening): **implemented** on PR #209 (territory-impl) from the owner decisions of 12:07 (U3),
12:09 (T-1 … T-8, E-Q1) and the numbers of 13:15 (TQ-1 … TQ-8). Local `--wide` worlds play it; nothing is deployed.
§9 is what was built, §10 the devnet upgrade and new-world checklist. §1–§7 are the design history (written while
T-1 … T-13 were open).

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
- Feature gating: (written before §9; superseded) the program now changes — §9 and §10 give the built instructions,
  the .so size and the upgrade steps.
- #206's reach witness and the `Neutral` wide-rules candidate ride the same upgrade. Devnet's wide-rules config is
  write-once (E-Q4).


(§8 intentionally absent: the section numbers follow the earlier drafts.)

## 9. What is implemented (territory-impl)

| Decision | Code |
|---|---|
| T-1 one tile | `frontier-abi/src/world_index/territory.rs` `TerritoryProvince` (record `wn‖hash(sort key)`, 672 B: 61 owner Citizen tags + each tile's distance) |
| T-2 / TQ-4 reach | WideClaimTile's witness: none (3 provinces from the first home), a nation-land province (own or teammates' village, a keep the nation won: `reach::is_nation_land`), or a territory record where the claimer owns a tile |
| T-3 / TQ-3 claim | 0xDA op 7 WideClaimTile: instant, 10 ore + 2 % per tile owned from the first home, 1 per turn (bell), first transaction wins (the owner field) |
| T-4 / TQ-1 / TQ-2 upkeep | `TerritoryPlayer` summary (`wu‖hash(citizen)`, 320 B): tiles × 990 + 480 × Σ max(0, distance − 3) milli-food/h (×30 the decided 33/16: owner Q-CUF-1 (b), 2026-11-25 12:04, replacing the ×10 of Q-LP15-1 (b)); distance = provinces to the claimer's nearest OWN village (home or a named own wide village), fixed at the claim (the page and the AI name an own wide village nearer than home: verify-pr206-209); 0xDC op 12 WideTerritorySettle charges the first home's food — when the store cannot cover the owed amount, what it holds is taken and the rest forgiven (**Q-LP17-1 (b), owner decision 2026-11-25 21:22**; before: all-or-nothing, nothing taken on a short turn, so the next turn's food cleared the unpaid mark and the 24-turn decay never fired below ~23× the village's food) — the sub-unit remainder carried; a first home that is gone pays nothing (unpaid) |
| T-5 / TQ-5 unpaid | claims refused (NotEligible) while unpaid; an unpaid player counts as paying again only when the home store also holds one turn's upkeep (with (b): a turn's food beyond the turn's own upkeep is never left behind on a short turn, so this means the village's food per turn covers the land's upkeep per turn) (a same-second settle owes nothing and used to clear it: verify-pr206-209); the missed food is forgiven (TQ-11 default); 0xDC op 13 WideTerritoryDecay after 24 unpaid turns releases one tile of the farthest distance bucket per turn (the summary's 64-bucket histogram proves "farthest") |
| T-6 / TQ-6 villages | WideClaimSite in a territory world needs the site's tile to be the claimer's (13th account = the territory record) and no village on a site within 3 tiles (`SITE_NEIGHBOUR_TILES`); the 3-village cap stays (uncap staged next) |
| T-7 | an owned tile is never claimable (SiteTaken) |
| T-8 / TQ-7 conquest | WideResolve records the capturing host's home village in the province trailer (`land::KeepCaptor`); 0xDC op 14 WideTerritoryConquer moves every tile of one non-teammate owner to that village's owner (distance from the capturing village), except tiles with a village on them: they stay with their village (verify-pr206-209); the captor Citizen may be writable in the transaction (a WideTerritorySettle of the captor before it), so a captor's second and later conquests land (owner Q-VT-1 (b), conquest-upkeep-fix) |
| E-Q1 / TQ-8 | `KeepHolderRule::NeutralTerritoryV1` (byte 4, rules table v3): every wide keep unowned with 50 troops, 72-turn hold unchanged; the same byte turns territory V1 on (trailer byte `RSV_53`) |
| U3 | `RELEASE_DORMANT_NEVER`; ReleaseDormant refused; preset `S1_DEVNET_TERRITORY` |
| Local play | itest `wide_land` sets the bundle; `wide_territory` duty settles / decays / transfers; page card claims the site's tile first; operator AI residents do the same and, when idle, grow one more tile inside a province where they already own one (every other decision after a cooldown, up to 24 tiles); a player's page claims only village sites' tiles (no free-tile growth card yet) |

## 10. Devnet upgrade and the new world (do not deploy without r0ze; never 01:30–03:30 JST)

1. Build: `scripts/build-frontier-devnet-playable-sbf.sh --twice` on the merged commit. Measured on this branch
   (2f1dc354 + later JS-only commits): 3,511,888 B, under the deployed `max_len` 4,308,992 (≈ 797 KB spare; no
   extend needed). sha256 of that build: 603544700edb… (report territory-impl). Rebuild on the merged commit.
2. Upgrade the program in place (the world is not created yet; U2 12:07).
3. AnnounceSeason / CreateSeason with `S1_DEVNET_TERRITORY` (continuous, no idle-home release).
4. WideSetRules with keep holder `NeutralTerritoryV1` (4), config version 3, free city / camp / region as the
   operator's current bytes (`stack/src/operator.rs` still sends `MixedInterleaved`: change it before the create).
5. Keeper: add a territory role (settle each summary once a turn, settle+decay when due, settle+settle+conquer after a
   capture; builders in `keeper::widelane::territory`); the local runner's `itest::wide_territory` is the model.
6. Gateway devnet act list: add `TerritoryClaim` (DEVNET_ACT_NAMES) so the page can claim tiles there.
7. Verifier: the four ops are re-run and compared byte for byte by VWL part 6 (`frontier-node/crates/verify/src/checks/vwl_wide_territory.rs`, verifier-territory 2026-11-25).
