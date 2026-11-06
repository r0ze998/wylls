# Design note: identifiers for a world past ring 128

Status: a note for a future decision, 2026-11-07. Nothing here is implemented, and nothing here chooses an economy. It records what the current identifiers can and cannot hold, so that a later "unbounded region" or "many worlds" design starts from the code's facts.

The program today grows a map one ring at a time (ExtendFrontier, OpenRing, OpenProvince) up to a per-season ceiling, with these bounds kept on purpose:

| bound | value | where it is enforced |
|---|---|---|
| outermost ring any season may reach | 128 (`R_MAX_HARD`) | `geometry::ProvinceCoord::checked`, `SeasonParamsV2::validate` (`r_max_ceiling ≤ 128`) |
| the keeper's own extension policy | off (`extend = false`), cap 17 (`extend_max_ring`) | `keeper/src/config.rs`; a local candidate, not a program rule |
| the prize tally | rings 0–17 (`permutation_prize::MAX_RING`, a 1,024-bit bitmap) | `permutation_prize` InitPool refuses `r_max` or a ceiling above 17 |
| a province in a host id | 20 bits (`province_index << 44`) | `frontier_abi::addr::host_id` |
| instruction coordinates | `i16` P and Q | `frontier_abi::ix::OpenProvince` and every P,Q instruction |
| tile coordinates | \|q\|, \|r\| ≤ 2¹⁶ | `geometry::check_hex` |
| ring and `r_max` | `u16` | Season `R_MAX`, Frontier `RINGS_OPENED`, `R_MAX_EXT` |

The host harness `permutation-frontier/src/map_growth_runtime_tests.rs` (`map_growth_expansion_*`) is designed to check the growth path running through the program's `dispatch` and these bounds holding. This note is about what a design would have to decide to go past them.

## 1. What is bounded and why

**Ring 128 is the current validated protocol limit, not the capacity of the 20-bit identifier field.** A Province account lives at `with_seed(season, "pv" ‖ P ‖ Q, program)`, so the chain could hold a province at any (P, Q) an `i16` names. What stops at ring 128 is the *dense index* `ProvinceCoord::index()` (49,537 provinces within ring 128), which is packed into:

- the **host id** (`province_index` in 20 bits, then site, generation and sequence): every host, march, arrival slot and clash input is keyed by it, and the verifier, keeper, herald and web client all split it back;
- the herald's **control file** and `provinces_within(R)` arrays (R ≤ 127), which are one entry per province in dense order;
- the prize program's **tally bitmap** (1,024 bits, rings 0–17 whole).

Ring 128 is also the practical reach of a wire format: `i16` P,Q names provinces to about ring 32,000, and `u16` rings to 65,535, so the coordinate types are not the first wall. The first wall is the 20-bit province field in `host_id` (2²⁰ = 1,048,576 provinces ≈ ring 590), and before that, the prize bitmap at ring 17.

**Why the identifiers are dense.** The dense index gives a stable, order-preserving, gap-free number to every province of a hex disk, which the control file and the overview binary use as an array position. It is exactly what makes a bounded disk cheap to scan and exactly what an unbounded world cannot have.

## 2. What "unbounded" could mean (three readings)

The word covers different designs with different costs. The note separates them because a decision on one is not a decision on the others.

1. **A larger disk.** Raise `R_MAX_HARD` (and the prize ring) while keeping one origin and one dense index. Costs: the host id's 20 bits (ring ≈ 590 is the ceiling of this reading), the control file size (quadratic in R), the keeper's per-turn walk of every open province (already linear in provinces, measured in `README.ja.md` §5), and the prize bitmap. Cheapest, and still bounded.

2. **Several regions on one chain, each a bounded disk.** A region id joins (P, Q) in every key. Each region keeps today's dense index and today's files; the cross-region parts are new. This is the reading most of the existing code tolerates, because every account address, record key and feed path is already derived from a per-season base and a seed string.

3. **One unbounded lattice.** No disk at all: provinces are named by (P, Q) alone with no dense index, and nothing anywhere is an array over "all provinces". This is the cleanest statement and the largest change: every consumer of `index()` has to become a map keyed by coordinate or hash.

## 3. Where a region or world id would have to go

A survey of the places an identifier for "which world" would need to appear, with the alternatives at each.

### 3.1 Account addresses

Today: `season PDA → with_seed(seed string)`; the season is the only PDA. A region id could be

- **(a) part of the seed string** (`"pv" ‖ region ‖ P ‖ Q`): no new PDA, every existing address stays valid with region 0 implied; the verifier's address recomputation (`AddrCtx`) grows one field;
- **(b) a new per-region base** (a Region account derived from the season, provinces derived from the region): isolates a region's accounts under one base, which suits a "many worlds, one program" deployment, at the cost of a second derivation hop in every reader;
- **(c) one season per region**: no program change at all; regions are seasons, and "cross-region" is "cross-season", which the program does not have.

(c) is what the code does today if two seasons run side by side. It gives no shared economy and no travel.

### 3.2 The host id (20-bit province)

Today: `province_index << 44 | site << 40 | gen << 32 | seq`. Alternatives:

- keep the id and make `province_index` a *per-region* index (region in the key of the account that holds the host, not in the id): hosts never cross regions without re-issue;
- widen the id to 128 bits (`region ‖ host_id`): touches the ABI of every host-bearing account and record (`Holding`, `ArrivalSlot`, `ClashInputs`, `MARCH`, `RETIRE`, `CARAVAN_*`, the web client's `faddr.hostParts`), so this is an ABI version, not a patch;
- replace the id with a hash of (region, P, Q, site, gen, seq): opaque, unbounded, and loses the "split it back" property the keeper and verifier use for cheap routing.

Nothing in this note picks one. The constraint to carry forward: **the existing `host_id` and every account layout stay as they are for the current ABI**; a wider id is a new layout version.

### 3.3 Records and feeds

Record keys (`P,Q` in PROVINCE_OPEN, KEEP, NEUTRAL; `d` in RING_OPEN, FRONTIER_EXTENDED) would take a region field in a new record version. The herald's `/h/world` already names its identifiers (`ids.province`, `ids.tile`, `ids.site`, `ids.region`) so a page can tell which world it is reading; a region id is one more field there and one more path segment (`/h/world/{region}/ring/{d}`). The control file's dense array is the one feed that does not survive reading 3; readings 1 and 2 keep it per disk.

Note the name clash: the code already has a **`region`** (16 beacon regions, `sha256("frontier/region" ‖ P ‖ Q)[0] mod 16`, used for bell anchors and seed caches). A world identifier needs another word.

### 3.4 Migration and asset identity

What has to stay the same for a player's things to remain theirs across a change:

- a **Holding** is keyed by (P, Q, site) and held by a Citizen's tag; a Citizen by its wallet (or, in the experimental NFT path, by the resident id `sha256("PSF-RES" ‖ asset)`). None of these carries a world id today, so the first season with a world id has to say whether `world 0` is implied for every existing key (additive) or whether every key changes (a migration with a cut-over).
- the **NFT resident** path binds an asset to a Citizen of one season. A world id inside the resident id, or beside it, is the same decision as 3.1 (a) versus (b), and it decides whether one asset can be a resident of two worlds.
- **Province terrain** is a pure function of the ring seed and (P, Q). Two worlds with different seeds are different lands; two worlds with the same seed and offset coordinates are copies. Whether "the same land" may exist twice is a design question, not a code one.

### 3.5 Ownership and nation boundaries

Nations are wedges (six sextants of one origin), and first homes are placed by `home_nation` from the season seed in the heartland rings. A second disk has its own origin and its own six wedges, so with reading 2 a nation is per region unless the design says otherwise. The open questions, deliberately not answered here:

- Is a nation one body across regions (shared votes, stances, expulsions: `nation.rs` keys proposals per season) or one per region?
- Do the per-wedge **ProvinceFunds** (six per season) become six per region? OpenRing's fund check and FoldOccupancy's `wedge_open` are per fund.
- Is the prize per region, per season or per world? The prize program's InitPool reads one Season and counts one disk.

### 3.6 Cross-region travel

A march today is at most 4 provinces and 32 steps along one lattice, resolved by the destination province at its bell, with the departure held on the origin Holding. Between two disks there is no lattice. The alternatives a design could pick:

- **no travel**: regions are separate maps sharing a season (caravans and raids stay inside a region);
- **portals**: a named pair of provinces in two regions is adjacent for `travel.rs`; the route planner and the reveal (`reveal.rs`, the sealed destination) would take a region id in the destination;
- **a shared border**: the lattices are joined along a seam, which brings back one coordinate space and is reading 1 under another name.

Each has a different cost in the keeper's settlement and in the verifier's travel checks (`V` checks that recompute routes), and each is an economy decision.

## 4. What stays true whichever reading is chosen

- The program does not grow a season past its ceiling, and no ceiling can be above ring 128, until the hard maximum is changed on purpose. ExtendFrontier refuses without a ceiling (`BadData`) before any other check, so every preset's default is "the map ends at `r_max`".
- The keeper's `extend` policy is off by default and capped at ring 17 because the prize tally stops there; raising the keeper's cap does not raise the program's, and raising the program's does not change the prize's.
- `host_id`, the account layouts, the record formats and the feed paths keep their current shapes for the current ABI version. A world identifier is a new version of whatever it touches.
- The harness that shows growth (`map_growth_runtime_tests::map_growth_expansion_*`) runs the real `dispatch` on literal account bytes, derives only public addresses, and signs nothing. A world identifier would need the same kind of test, not a fixture.

## 4a. An opt-in foundation under these bounds (2026-11-07)

`frontier-abi/src/world_index/` (feature `world-index-experimental`, off by default, no consumer) implements wide `i64` coordinates with a lossless ring-ordered key, world-scoped keys and versioned host references, an exact adapter from `ProvinceCoord` / `host_id` within ring 128, and a sparse paginated opened-province index. It changes none of the bounds in the table above and decides none of §5. `WIDE-WORLD-INDEX.md` reviews what it can and cannot be used for.

## 5. Unknowns this note does not resolve

- Which of the three readings (larger disk, several disks, one lattice) is wanted, and whether more than one world shares a season.
- Whether a world id is additive (world 0 implied) or a full key change.
- Whether nations, funds and the prize are per world or shared.
- Whether anything may travel between worlds, and what it costs.
- The size and shape of a wider host id, and which ABI version carries it.
- How the keeper's per-turn walk and the herald's per-transaction scan are made proportional to "what changed" rather than "how large the world is" (`keeper-load.ja.md` holds the options; none is adopted).


## Validation of this change (2026-11-07)

- The six `map_growth_runtime_tests::` host cases passed, including three new expansion cases. They execute the real program dispatcher but use literal account pre-state, a clock/CPI stub and an injected post-beacon seed, not a signed chain transaction or a live keeper.
- The seven new web growth tests and eight existing world tests passed with `scripts/ci/no-keys-guard.mjs` preloaded. Two tests cover delayed ring/overview responses after a newer world snapshot. The 19 existing controller tests also passed with that guard. App and controller passed Node syntax checks; Clippy passed for the program library and test targets with warnings denied.
- Program limits, keeper defaults, deployed configuration and production state are unchanged. This is bounded expansion plus correct UI refresh, not an unbounded-world implementation.
