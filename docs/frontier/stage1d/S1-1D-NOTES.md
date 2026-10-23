# Stage 1d: watchtowers (notes)

Contract: [S1-1D-CONTRACT.md](S1-1D-CONTRACT.md). Design:
`docs/design/redesign/13-hidden-information.ja.md` §6-1 (plan B),
`30-stage1-build-plan.ja.md` §1 item 8 and §2 row 1d, decision J4. Before
this: [stage 1b/1c](../stage1b/S1-1B-NOTES.md).

Stage 1e generalised the tower into a structure (towers, palisades,
forts) and "hostile" into the stop rule; see
[S1-1E-NOTES.md](../stage1e/S1-1E-NOTES.md).

## What a tower does

Until zk hides marches, a tower cannot see a sealed march on the road. It
does the two things plan B decided:

1. **It wears down whoever walks through its range**, once the walk is known:
   - a march when its seal opens (Reveal), judged by the towers standing then;
   - a caravan when its route is fixed (send, or a raid's take).
   Wear is 1 % a minute walked in hostile coverage, at most 30 % [phase 6].
   A march waiting at its destination is off the road and never worn (J4).
2. **It watches public events in its range** and the herald publishes
   them as sightings (`h/towers.json`): departures, caravans, arrivals,
   raids.

A tower covers the tiles of its own Province within 2 hexes. Every other
faction is worn (there is no diplomacy yet).

## What changed

**The rules (`RULESET_HASH_V3 = 77a8383f…94cf`):**

- New kernel `permutation_rules::frontier::tower` (`TOWER_VERSION` 1):
  coverage table, the Province list entry, `hostile`, `wear_bps`, `wear`,
  `march_secs_in_range`, `caravan_secs_in_range`, cost and limits.
- Bound into the v3 hash (`KERNEL_VERSIONS_V3` + `tower::write_tables`).

**ABI v2, S1 part:**

- Tower account (kind 21, 256 B, seed `tw`), entity kind 11.
- Province `TOWERS @4044`: 12 entries of `state, tile, faction, gen`
  (a list, not per-faction masks: a mask cannot be cleared when one of
  two overlapping towers goes).
- ArrivalSlot `RSV_54` read as `WORN_BPS` in S1 (`v2::layout::s1::arrival`;
  the v1 table is unchanged).
- Citizen `TOWERS @313`.
- Tags 0xB7 BuildTower, 0xB8 SeizeTower, 0xB9 CloseTower; kinds 95–97
  (TOWER_BUILT, TOWER_SEIZED, TOWER_CLOSED); CARAVAN_SENT gains
  `worn_bps` and `path`; codes 87–89 (TowerSite, TowerLimit, TowerFull).
- **S1 Reveal CU limit 28,000** (below). Vectors regenerated.

**The program:**

| Where | What |
|---|---|
| `proc/tower.rs` | BuildTower, SeizeTower, CloseTower (the Tower and its list entry kept in step) |
| `proc/reveal.rs` | Each walked Province's hostile coverage; the walk sums the seconds of covered steps; the slot gets `WORN_BPS`. Host test: the program's walk equals the kernel's over random paths, terrain and towers |
| `proc/clash.rs` (GatherClash) | The first stamp wears the transit's `TROOPS_AFTER` and the record takes it; a re-gather reads it as it is |
| `proc/caravan.rs` | SendCaravan and a take wear the cargo by the route's coverage; CARAVAN_SENT logs the wear and the path |

**Off-chain:**

- **fclient:** tower address and builders; typed `TowerBuilt`,
  `TowerSeized`, `TowerClosed`; `CaravanSent` with `worn_bps` and `path`;
  the S1 budgets with Reveal's own CU limit.
- **Verifier:** V24 `towers` judges the three instructions, every S1
  Reveal's `WORN_BPS` (recomputed from the plaintext's path and the tower
  lists before) and every GatherClash's worn records and transits. V23
  checks a send's and a take's worn cargo. V7 accepts BuildTower's holding
  write. Codes `TowerMismatch`, `TowerWearMismatch`; tamper classes T52
  (wear zeroed), T53 (a gather that skipped the wear), T54 (seized
  without a host).
- **Herald:** `h/towers.json` (towers with their coverage, the newest 256
  sightings), kept in the checkpoint.
- **Gateway:** BuildTower may move a tower's rent, the others nothing; an
  S1 day's lamport cap adds one tower's rent; Japanese and English texts
  for codes 87–89; profile 3 reads `cu_limit_s1`.
- **Keeper:** no new duty (Reveal and GatherClash take the same accounts).

## Decisions made in implementation

- **The S1 Reveal limit is 28,000 CU.**
  - Measured: the worst walk with full hostile lists in all four
    Provinces costs 26,454 CU; the MC worst is 25,889, 111 CU under its
    26,000.
  - The range test a step alone takes about that, so no representation
    fits the old limit.
  - S1 seasons run their own program and already have their own loaded
    limits; the CU limit follows the same path. The build plan foresaw it
    (§5: "足りなければ、上限の修正が要ります").
  - Tips in S1 seasons rise in the same proportion (`tip_min` scales with
    the limit).
- **BuildTower's holding Province is `r|w`**: when the tower stands in the
  holding's own Province, the two positions are one account.
- **CloseTower logs TOWER_CLOSED** (chaining the Province whose entry it
  clears) before the Tower's CLOSE.
- **The quota ranks arrivals by troops before wear**, and a displaced
  march (never gathered) is not worn.

## Tests run

| Suite | Result |
|---|---|
| `permutation-rules` | all pass, including the tower kernel (5) and the re-pinned v3 hash |
| `frontier-abi` | 119, vectors regenerated |
| `permutation-frontier` unit tests | 95, including `walk_counts_tower_seconds_as_the_kernel` |
| LiteSVM | see below; `tests/tower.rs` (7) and `g01_s1_reveal_worst_with_towers` |
| `frontier-node` | see below; V24's unit test and the herald's tower feed test |
| `permutation-gateway` | 2,374 pass, 0 fail |
| `frontier-sim` | 61 |

## Still open

- **Fuel and upkeep** for towers (`13` §3) — not in stage 1.
- **Notification by setting** (owner / faction / paid readers): `NOTIFY` is
  stored and published; filtering and paid reading belong to stage 3's
  signals.
- **A tower sees only its own Province**; a border pass may want two.
- **The web client and the bots** (1f): the tower layer on the map, the
  build and seize orders, the sighting feed, route choice around towers.
