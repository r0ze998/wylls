# Stage 1d: watchtowers (contract)

Design: `docs/design/redesign/13-hidden-information.ja.md` §6-1 (plan B,
decided), `30-stage1-build-plan.ja.md` §1 item 8 and §2 row 1d, decision
J4, `12-structures.ja.md` (the tower's settings). This contract fixes the
accounts, instructions, records and checks before the code. Every number
marked [phase 6] is a placeholder; [proposal] marks a choice the design
left open (listed for the owner in §9).

Before this: [stage 1b/1c](../stage1b/S1-1B-CONTRACT.md).

**Stage 1e renames the tower.** Its account, instructions, records, codes
and the Province list are now the structure's (towers, palisades, forts):
`Tower` → `Structure`, `BuildTower` → `BuildStructure` (with a `kind`),
`TOWER_*` → `STRUCTURE_*`, `TowerSite` → `StructureSite` and so on, and
"hostile" became the stop rule of the Season's stances. The numbers here
are unchanged; read the names through
[S1-1E-CONTRACT.md](../stage1e/S1-1E-CONTRACT.md) §1–§2.

## 0. Scope

Until zk hides marches, a tower cannot *see* a sealed march on the road
(its path opens only at the arrival). Plan B gives the tower two jobs that
work with the seals as they are:

1. **Watch public events** in its range and tell its owner (and whoever
   the setting names): departures, caravans, arrivals, raids. The events
   are public anyway; the tower's value is the watching and the feed.
2. **Wear down whoever walks through its range**, when that walk becomes
   known: a march when its seal opens (Reveal), a caravan when its route
   is fixed (it is public from the start).

| In | Out (later) |
|---|---|
| Tower: build, stand on a tile, be seized, be closed | Fuel and upkeep (`13` §3: "towers run on fuel") [proposal: later] |
| Coverage in the Province data; Reveal reads it | Seeing hidden marches early (after zk) |
| Marches: wear by the minutes walked in range (J4: not while waiting) | Wear targets by diplomacy (at war / not allied): stage 2 has no diplomacy yet; every other faction is worn |
| Caravans: wear when the route is fixed | The tower's sightings as stage-3 signals |
| The herald's tower feed (`h/towers.json`) | Paid notification (the "paid readers" setting) |

## 1. Accounts and layout

### 1.1 Tower (kind 21, entity kind 11, seed `tw` ‖ P i16 ‖ Q i16 ‖ tile u8; 256 B)

ABI v2 chained account (64-byte header), created with `init_with_seed`
by the Season PDA, its rent paid by the relay's payer.

| Field | Off | Type | Meaning |
|---|---|---|---|
| P, Q | 64, 66 | i16 | Province |
| TILE | 68 | u8 | Tile 0..61 |
| STATE | 69 | u8 | 0 none, 1 live |
| FACTION | 70 | u8 | The owner's faction (built or seized) |
| GEN | 71 | u8 | +1 at every seizure |
| OWNER_CITIZEN | 72 | [u8;32] | |
| OWNER_TAG | 104 | u64 | |
| BUILT_TS | 112 | i64 | |
| SEIZED_BELL | 120 | u32 | `NO_BELL` if never |
| NOTIFY | 124 | u8 | Who the herald tells: 0 the owner, 1 the owner's faction |
| ENTRY | 125 | u8 | Its index in the Province's tower list |
| RSV_126 | 126 | 2 | |
| RENT_TO | 128 | [u8;32] | Rent refund at close |
| RSV | 160 | 96 | |

Rules (as a vault's, `S1-1B` §1.1):
- **Where:** a passable tile of an opened Province that is not a
  settlement site, not the keep tile and not a present camp's tile. One
  tower a tile. A vault may share the tile.
- **Limit:** `MAX_TOWERS = 2` a citizen [phase 6], kept in Citizen v2
  `TOWERS @313` (u8, from the reserve); at most `PROVINCE_TOWERS = 12` live
  towers a Province (the list below; `TowerFull`).
- **Cost:** `TOWER_COST = [0, 300, 400, 0, 20, 100, 0, 0]` units (wood,
  stone, 20 arms, gold) [phase 6], from one of the owner's holdings (an
  owner touch, as BuildVault).

### 1.2 Province: the tower list (`TOWERS @4044`, 48 B)

Twelve 4-byte entries replace 1b's reserved `[u64;6]`:

| Field | Off | Type |
|---|---|---|
| STATE | 0 | u8: 0 empty, 1 live |
| TILE | 1 | u8 |
| FACTION | 2 | u8 |
| GEN | 3 | u8 (the Tower's) |

The plan (§1 item 8) asked for "each faction's coverage" in the spare
bytes. A list of towers is stored instead, and the coverage is derived
from it when read: a mask per faction cannot be cleared when one of two
overlapping towers goes (a seizure or a close would need every other
tower's account). Reading 12 entries costs a few hundred CU. An MC
Province's bytes are zero: no towers.

**Coverage** of a tower: the tiles of **its own Province** within
`TOWER_RANGE = 2` hexes of it (at most 19) [phase 6]. A tower near the
border does not see across it [proposal]: Reveal and the caravan routes
read only the Provinces the path enters, and a tower writing into its
neighbours' data would make BuildTower and SeizeTower take up to 4
Provinces.

**Hostile coverage** for a faction `f` in a Province: the union of the
coverage of its live towers whose faction is not `f` (and not NEUTRAL;
free cities build none).

### 1.3 ArrivalSlot: `WORN_BPS @54` (u16, S1)

The slot's reserved `RSV_54` carries the march's wear in an S1 season.
The v1 ABI table keeps the name `RSV_54` (the MC layout tables are not
changed); `v2::layout::s1::arrival::WORN_BPS = 54` names it.

## 2. Kernel (`permutation-rules/src/frontier/tower.rs`, `TOWER_VERSION` 1)

| Item | Rule |
|---|---|
| `coverage(tile) -> u64` | tiles of the Province within `TOWER_RANGE` (const table, 61 masks) |
| `TowerEntry` | the 4-byte entry, encode/decode |
| `hostile(entries, faction) -> u64` | the union above |
| `wear_bps(secs_in_range) -> u16` | `min(TOWER_WEAR_CAP_BPS, secs × TOWER_WEAR_BPS_PER_MIN / 60)`: 1 % a minute, at most 30 % [phase 6] |
| `wear(v, bps) -> v'` | `v − ⌊v × bps / 10_000⌋` (the loss rounds down) |
| `MAX_TOWERS`, `PROVINCE_TOWERS`, `TOWER_COST`, `TOWER_RANGE` | constants |

`tower::write_tables` is appended to the v3 ruleset hash input and
`KERNEL_VERSIONS_V3` gains `("tower", 1)`: `RULESET_HASH_V3` is re-pinned.

**Seconds in range.** A walk's step that *enters* a covered tile counts
its step seconds. The origin tile does not count (the walk has not
started); the destination tile does (the last step is on the road). A
foot step is 120 s flat, 180 s rough, half on a road; so crossing a
tower's 5-tile diameter on flat ground costs about 10 %, ending a march on
a tower's own ring about 4–6 %.

## 3. Rules

### 3.1 Marches: wear at Reveal (J4)

- Reveal already reads every Province the path enters (the destination
  and 0–3 others). For each, it derives the hostile coverage for the
  host's faction from the tower list **standing at the Reveal** (plan §1
  item 8: judged when the seal opens, not when the march passed).
- The walk sums the seconds of the steps entering a covered tile (before
  the doctrine's travel bias, the same seconds the walk already adds).
- `WORN_BPS = wear_bps(secs)` is written into the ArrivalSlot with the
  rest of the slot. A displacement rewrites it with the new arrival's.
- **J4:** a late-arriving march waits at its destination off the road;
  the walk ends at the destination, so waiting is never counted.
- The quota ranks arrivals by their troops before wear (the admit rule is
  not changed) [proposal].

### 3.2 Marches: the wear lands at GatherClash

- GatherClash builds the arrival's record from the holding's transit
  (`TROOPS_AFTER`). With `WORN_BPS > 0`, the first gather that stamps the
  transit (`FLAG_GATHERED` not yet set for this destination) writes
  `TROOPS_AFTER = wear(TROOPS_AFTER, WORN_BPS)` into the transit **and**
  uses it in the record. A later gather of the same position (already
  stamped) reads the worn value: the wear is applied once.
- So the loss reaches the clash, and the host's return (SettleTransit
  reads the transit for routed hosts, the record's `troops_after` for the
  others) does not restore it (plan §1 item 8).
- Worn below `DESTROYED_BELOW`: the record's fate is Destroyed, as for
  any arrival below it.
- A march displaced from the quota (never gathered) is not worn
  [proposal: its return carries no loss, as it does now].

### 3.3 Caravans: wear when the route is fixed

- SendCaravan and a raid's take (RaidCaravan, DefaultRaid: the new route
  from the raid tile) compute the caravan walk's seconds in hostile
  coverage for the caravan's faction, from the path Provinces' tower
  lists **at that instruction** (the caravan's route is public from its
  send, so the wear is known then; a settle-time judgement would depend on
  whether the route's slots were reused).
- The cargo is worn: each resource `wear(c, bps)`; the source is debited
  the full cargo (SendCaravan) and the loss is gone.
- CARAVAN_SENT logs `worn_bps` and the packed `path` (§4).

### 3.4 BuildTower (0xB7)

`P + [holding w] [holding_province r|w] [province w] [tower w] [system]`
(the holding's Province is writable when it is also the tower's: the same
account twice);
data `tile u8, notify u8`. As BuildVault: an owner touch of a live final
holding that pays `TOWER_COST`; the tile rule (`TowerSite`); `MAX_TOWERS`
(`TowerLimit`); a free entry in the Province list (`TowerFull`). Writes
the Tower (GEN 1, `ENTRY` = the free entry) and the entry. Record
TOWER_BUILT.

### 3.5 SeizeTower (0xB8)

`P (captor) + [tower w] [province w] [host_holding r] [owner_citizen w]`;
data `entry u8` (the captor's roster entry in the Province). As
SeizeVault: the captor's roster host stands on the tower's tile since a
resolved bell, no roster host of the owner's holdings is on it
(`NotOnTile`); the captor is under `MAX_TOWERS` (`TowerLimit`). The tower
becomes the captor's: owner, faction, GEN + 1, `SEIZED_BELL`, and the
Province entry's faction and gen. Record TOWER_SEIZED (`domestic` when
the factions are equal: 1e's domestic-raid log reads it).

### 3.6 CloseTower (0xB9)

`P + [tower w] [province w] [rent_to w]`; no data. The owner, by wallet
(`WalletRequired` with a session key, as CloseVault). Clears the entry,
closes the Tower to `RENT_TO`, decrements the Citizen's `TOWERS`. Records
TOWER_CLOSED (chains the Province, whose entry it cleared), then CLOSE
(chains the Tower; `close_key_tower`).

### 3.7 Errors (S1 codes)

`TowerSite = 87`, `TowerLimit = 88`, `TowerFull = 89`.

## 4. Records (S1 kinds)

| Kind | Key | Payload |
|---|---|---|
| TOWER_BUILT = 95 | p 4, q 4, tile 1 | owner_tag 8, faction 1, gen 1, entry 1, notify 1, holding_key 8, cost_digest 32 |
| TOWER_SEIZED = 96 | p 4, q 4, tile 1 | captor_tag 8, prev_tag 8, new_gen 1, faction 1, domestic 1, host_id 8 |
| TOWER_CLOSED = 97 | p 4, q 4, tile 1 | owner_tag 8, entry 1 |
| CARAVAN_SENT = 91 (amended) | as before | as before, then `worn_bps 2`, `path 12` |

TOWER_BUILT chains the Citizen, the Holding, the Province and the Tower;
TOWER_SEIZED the two Citizens, the Province and the Tower; TOWER_CLOSED the
Province; CLOSE the Tower.

## 5. Verifier, digests, keeper, herald, relay

### 5.1 Verifier (`verify`, check V24 towers; V23 amended)

- **Build, seize, close:** re-judged from the states before (tile rule,
  limits, the entry written, the cost paid, owner and gen moves).
- **Reveal:** an S1 slot's `WORN_BPS` is recomputed from the plaintext's
  path over the tower lists of the path Provinces in the state before the
  Reveal (`TowerWearMismatch`).
- **Gather:** an arrival record's troops are `wear(transit troops,
  WORN_BPS)` at the first stamp, and the transit's `TROOPS_AFTER` was
  written so; unchanged at a re-stamp (`TowerWearMismatch`).
- **Caravans (V23):** the cargo stored is the worn cargo for the logged
  `worn_bps`, and `worn_bps` is recomputed from the path and the tower
  lists before the send or take.
- **Tamper classes:** T52 (a slot's wear zeroed), T53 (a gather that
  skipped the wear), T54 (a tower seized without a host).

### 5.2 Digests

The tower list sits inside the Province's state block only where the S1
digests already read it: `quiet_digest_v2`/`input_digest_v2` hash the
Province's CQ block and state block, and `TOWERS @4044` lies outside both
(between the caravan slots and the CQ block). Towers do not change a
clash: wear lands before the gather. No digest change.

### 5.3 Keeper

No new duty: Reveal and GatherClash pass the same accounts. Its Reveal
builder needs no tower account (the coverage is in the Provinces it
already lists).

### 5.4 Herald: `h/towers.json` (the "relay's notices", plan B ①)

```json
{"v": 1,
 "towers": [{"p": 3, "q": 0, "tile": 20, "faction": 1, "ownerTag": "…",
   "gen": 1, "notify": 1, "cover": [12, 13, 19, 20, 21, 27, 28]}],
 "sightings": [{"seq": 41, "bell": 290, "tower": {"p": 3, "q": 0, "tile": 20},
   "towerFaction": 1, "notify": 1, "ownerTag": "…",
   "what": "depart" | "caravan" | "arrival" | "raid",
   "faction": 2, "p": 3, "q": 0, "tile": 21, "subject": "…"}]}
```

- A sighting is a public record whose place lies in a live tower's
  coverage, by a faction other than the tower's: DEPART (the origin
  tile), CARAVAN_SENT (every tile of the caravan's walk, from the logged
  path; one sighting per tower), REVEAL (the destination tile), CARAVAN_RAIDED
  (the raid's Province: towers there).
- The newest 256 sightings are kept; the feed is rewritten when a record
  changes it and kept in the checkpoint. Readers filter by `ownerTag`
  (notify 0) or `towerFaction` (notify 1). Everything in it is public:
  the feed is a convenience (`13` §6-1: no reader gains an edge).

### 5.5 Relay (gateway)

BuildTower, SeizeTower, CloseTower are player shapes. Allowance:
BuildTower = the Tower's rent; the others 0. An S1 season's daily
lamport cap counts one tower's rent. Texts for codes 87–89.

### 5.6 Budgets (measured)

Reveal gains up to 4 × 12 entry reads and a range test a step. The worst
walk (32 steps, 4 Provinces) with a full list of hostile towers in every
Province measured **26,454 CU** at the worst fill, against the MC row's
26,000 (the MC worst stays 25,889: MC Provinces have no towers, and the
reads cost little when the list is empty). No representation fits the old
limit: the range test a step alone takes most of the 111 CU the MC worst
leaves. So **an S1 season has its own Reveal CU limit,
`REVEAL_CU_LIMIT_S1 = 28,000`** (the S1 presets' `reveal_cu_limit`;
`budgets::cu_limit_for`; the vectors' `cu_limit_s1`; fclient
`Budgets::canonical_s1`; the client's profile 3), as it already has its
own loaded limits (`30-stage1-build-plan` §5 foresaw it: "足りなければ、上限
の修正が要ります"). A higher limit raises `tip_min` in S1 seasons in the
same proportion. GatherClash, SendCaravan and the raids stay within
their rows.

## 6. Tests

- Kernel: coverage table (sizes, symmetry, clipping), `wear_bps`, `wear`.
- LiteSVM (`tests/tower.rs`): build (cost, tile rule, limits, full list),
  seize (host rule, domestic flag, entry moved), close (wallet, rent);
  Reveal through a hostile tower's range writes `WORN_BPS`, a friendly one
  does not, a march ending in range is worn, J4 (an early arrival waiting
  is worn the same as an on-time one); GatherClash wears the record and
  the transit once (a second gather of the same bell keeps it); a caravan
  sent through range carries less and logs it; a take rerouted through
  range is worn.
- ABI: layout, tags, kinds, vectors regenerated; `RULESET_HASH_V3`.
- Verifier: V24 judges; tampers T52–T54.
- Herald: sightings for each kind; the checkpoint round-trips.
- Gateway: the shapes and the allowance.

## 7. Work order

Kernel and hash → ABI (layout, tags, kinds, errors, budgets, vectors) →
program (three handlers, Reveal, GatherClash, caravan routes) → LiteSVM
tests and CU → fclient → verifier → herald → gateway → notes.

## 8. Not changed

The seal, the quota rule, the clash kernel, the digests, MC seasons (no
tower can exist outside S1: the tags are S1's and MC Provinces' bytes are
zero).

## 9. For the owner: choices this contract makes

1. **Towers are standalone, like vaults,** not a building of a holding:
   the design's towers stand on passes (`12` §2), not only at
   settlements.
2. **A tower sees only its own Province.** Simpler and cheaper; a border
   pass may want towers on both sides.
3. **Wear is by minutes in range** (1 %/min, cap 30 %), the same rule for
   troops and cargo: cavalry and roads cross faster and lose less.
4. **Every other faction is worn** (no diplomacy yet); NOTIFY chooses the
   owner or the faction as the herald's audience.
5. **Caravans are worn when the route is fixed** (send or take), by the
   towers standing then.
6. **Displaced marches are not worn**; the quota ranks by troops before
   wear.
7. **No fuel yet.**
8. **S1 Reveal limit 28,000 CU** (§5.6), measured, not a guess.
9. **CloseTower logs TOWER_CLOSED** before CLOSE so that the Province
   write (the cleared entry) is chained.
