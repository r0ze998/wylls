# Stage 1e: forts, palisades, stances, expulsion, domestic raids, siege arms (contract)

Design: `docs/design/redesign/31-stage1e-plan.ja.md` (decisions K1–K4,
2026-10-23), `14-land-and-nation.ja.md` §2 and §4, `18-stage1-play.ja.md`
§11, `12-structures.ja.md` §2, `30-stage1-build-plan.ja.md` §2 row 1e.
Before this: [stage 1d](../stage1d/S1-1D-CONTRACT.md). Every number
marked [phase 6] is a placeholder; [proposal] marks a choice the design
left open (listed in §10).

## 0. Scope

| In | Out (later) |
|---|---|
| Structures: towers (1d), **palisades**, **forts**, one account kind | Gates, bridges, markets, shared buildings (stage 2) |
| A Nation account per faction; votes on **stances** and **expulsion** (K1) | Votes on building rights and the nation's share (stage 2) |
| The expelled state (K2): stopped by the nation's own works, no vote | Leaving a nation, nationless villages (the war-period work) |
| **Domestic raids** by "a host stood there" (K4); a `domestic` flag on raid records | A newcomer's protection period (with newcomer fairness) |
| **Siege arms**: DeclareSiege burns arms in an S1 season | Arms for other conquest steps |

## 1. Who a work stops

One rule decides who a tower wears (1d), who a palisade stops and who a
fort fights: **`stops(N, f, x)`** for a work of nation `N` and a walker of
faction `f`, `x` true when the walker is expelled from its nation:

- `N ≠ f` and `stance[N][f] = WAR`; or
- `N = f` and `x` (the nation's own expelled villages).

`stance[N][f]` is **N's** stance toward `f` (one-sided): `0 WAR`, `1 PASS`,
`2 ALLY`. ALLY behaves as PASS in stage 1 (stage 2's relations read it)
[proposal]. A fresh season's stances are all WAR, so stage 1d's behaviour
(every other faction worn) is the default.

**Where the stances live:** the Season account, `STANCES @516` (36 B,
`[u8; 6×6]`, row `N`), from the `RSV_M2M3` reserve. Reveal, the caravan
instructions, GatherClash, ResolveFromInputs and SkipQuiet all read the
Season already; no instruction gains an account for it.

**Where the expelled state lives:** Citizen `EXPELLED_SINCE` (below) and a
Holding flag `FLAG_EXPELLED = 4` on each of the citizen's holdings
(Reveal reads the march's Holding, not its Citizen).

Tower wear (1d) now uses `stops` instead of "every other faction".

## 2. Structures (1d's Tower generalised)

### 2.1 Structure account (kind 21, seed `tw` ‖ P ‖ Q ‖ tile; 256 B)

1d's Tower account, renamed, with `KIND @126` (u8: 1 tower, 2 palisade,
3 fort) taken from its reserve. One structure a tile, of any kind. The
1d instructions become **BuildStructure (0xB7)**, **SeizeStructure
(0xB8)**, **CloseStructure (0xB9)**; BuildStructure's data is `kind, tile,
notify`. Records TOWER_* become STRUCTURE_BUILT (95), STRUCTURE_SEIZED
(96), STRUCTURE_CLOSED (97), with `kind` in their payloads. Codes
TowerSite/TowerLimit/TowerFull become StructureSite (87), StructureLimit
(88), StructureFull (89).

### 2.2 Province: the structure list (`STRUCTURES @4044`, 12 × 4 B)

Entry `kind ‖ tile ‖ faction ‖ gen` (`kind 0` empty). Every kind shares
the 12 entries. Forts keep their troops in a second block (2.4).

### 2.3 Limits and costs [phase 6]

| Kind | Per citizen | Per Province | Cost (wood, stone, arms, gold) |
|---|---|---|---|
| Tower | 2 | 12 (shared) | 300, 400, 20, 100 |
| Palisade | 4 | 12 (shared) | 200, 100, 0, 20 |
| Fort | 1 | 2 | 500, 800, 50, 200 |

Citizen counters `TOWERS @313`, `PALISADES @314`, `FORTS @315` (the
`RSV_314` reserve).

### 2.4 Forts' troops: `FORTS @4708` (2 × 14 B, from `RSV_CQ`)

`tile u8, faction u8, gen u8, state u8 (0 none, 1 live), troops u32
(milli), pend_bell u32, pend u16 (whole troops)`. The effective troops at
bell `b` are `troops + (pend_bell ≤ b ? pend × 1,000 : 0)`. The block is in
the conquest block, so the clash digests already hash it; an MC Province's
bytes are zero.

### 2.5 Palisades

A palisade's tile is impassable to every walker it stops:

- **Reveal:** a step entering it is `Path` (the march is not revealed and
  settles as a march whose walk the rules refuse, as any `Path`) — judged
  by the palisades standing at the Reveal, as towers are.
- **SendCaravan, RaidCaravan's take, DefaultRaid's take:** `Path`.
- `fastest_path` callers (keeper, clients) remove the stopped palisade
  tiles from the passable mask.

### 2.6 Forts

- **FortGarrison (0xBA)** `P + [holding w] [province w] [structure r]`,
  data `troops u32` (whole): an owner touch of a live final holding **in
  the fort's Province**, paying Spearmen from its reserve. The fort's
  pending troops grow by `troops` from `now_bell + 1` (a pending part
  already due is folded first). At most `FORT_MAX_TROOPS = 2,000` whole
  troops [phase 6].
- **In the clash at bell `b`:** a live fort with effective troops ≥ 1,000
  joins as a garrison of its faction when **a host of a faction it stops
  stays on or arrives at its tile** (residents and arrivals, as caravans'
  raiders are read). Order: sites, camp, **forts**, caravans, keep; only
  while the garrisons are fewer than 12. Once in, the kernel fights every
  other faction there (the clash has no alliances) [proposal].
- **Write-back:** the fort's troops after the clash (the pending part
  folded); a fort at 0 is **fallen**.
- **Shelter:** a caravan on a joined fort's tile is sheltered (1c's rule:
  a tile already used by a garrison).
- **Seizure:** SeizeStructure of a fort needs it fallen (`FortManned`,
  code 90, otherwise).
- **Quiet:** `is_quiet_v2` is false when a manned fort would join; the
  quiet and input digests append `PSF-FORT-v1 ‖ STANCES` when a fort is
  live (a stance change can wake a fort).

## 3. Nations (K1, K2)

### 3.1 Nation account (kind 22, seed `na` ‖ faction u8; 384 B)

| Field | Off | Type |
|---|---|---|
| FACTION | 64 | u8 |
| NEXT_ID | 68 | u32 (proposal ids from 1) |
| PROPOSALS | 72 | 4 × 64 B |

Proposal (64 B): `id u32, state u8 (0 none, 1 open, 2 passed, 3 failed),
kind u8 (1 stance, 2 expel, 3 readmit), target_faction u8, value u8,
open_bell u32, close_bell u32, yes u16, no u16, proposer_tag u64,
target_tag u64, target [u8;32] (the target Citizen)`.

Created at the first Propose (the payer pays its rent).

### 3.2 Citizen: `NATION @320` (28 B of `RSV_320`)

`EXPELLED_SINCE i64` (0: member), `VOTED [u32;4]` (the proposal id voted
in each slot), `PROPOSED u32` (the id of the citizen's open proposal).

### 3.3 Rules [phase 6]

- **1 village, 1 vote:** one vote a Citizen (outposts do not add votes).
- **Eligible:** a member (not expelled) whose `JOIN_BELL + 288 ≤ now_bell`
  (2 days of 10-minute bells).
- **Propose (0xBB)** `P + [nation w] [target r] [system]`; data `kind,
  target_faction, value`. Eligible; no other open proposal of the
  proposer; a free slot (`none`, `passed` or `failed`; `ProposalsFull`,
  code 91). Stance: `target_faction ≠ own`, `value ≤ 2`, target = the
  Nation. Expel: target a member of this nation. Readmit: target expelled
  since at least 432 bells (3 days). Window 144 bells (1 day).
- **Vote (0xBC)** `P + [nation w]`; data `slot, id, yes`. Eligible; open
  (`now_bell < close_bell`); not voted on this id (`AlreadyDone`).
- **SettleProposal (0xBD)** permissionless after `close_bell`: `[fee_payer
  s] [season w] [nation w] [target w] [holding w ×0..3]`; data `slot, id`.
  **Passed** when `yes > no` and `yes ≥ 3`. Stance: `STANCES[N][g] =
  value`. Expel: `EXPELLED_SINCE = now`, `FLAG_EXPELLED` on every live
  holding of the target (all must be listed). Readmit: cleared. Failed:
  nothing. The slot becomes passed or failed.
- **The expelled** cannot propose or vote; their nation's palisades stop
  them and its towers wear them; they lose the nation's prize share (the
  prize code reads `EXPELLED_SINCE`; stage 1 has no prize change).
- Codes: `NotEligible` (92), `ProposalState` (93).

## 4. Domestic raids (K4)

- **RaidDomestic (0xBE)** `P + [caravan r] [province w] [host_holding r]`;
  data `bell u32, entry u8`. The caravan's slot in the Province stood on a
  tile at `bell` (`tile_at(bell)`), the bell is resolved (`bell <
  RESOLVED_NEXT`) and no older than `RAID_DECIDE_BELLS`; the actor's roster
  host `entry` stands on that tile with `from_bell ≤ bell`; the caravan is
  of the actor's own faction; no roster host of the caravan owner's
  holdings is on the tile (`NotOnTile`). The slot's raid opens as the
  clash opens it (`raid_off`, `raider`, `raid_pos` resident).
- Then 1c's RaidCaravan / DefaultRaid settle it.
- **Records:** RAID_OPENED (101): key `owner_tag, seq`; payload `p, q,
  bell, raider_host, raider_tag, domestic`. CARAVAN_RAIDED gains
  `domestic u8` (raider faction = caravan faction).

## 5. Siege arms

- Conquest params `SIEGE_ARMS @77` (u32 whole arms, from the reserve);
  `0` in every MC preset (MC unchanged), **20** in the S1 presets [phase 6].
- DeclareSiege pays `SIEGE_ARMS` arms with the stake from the source
  holding; arms are **burned** (never returned).
- No record change: the Season holds the amount and V7 judges the paid
  arms with the stake.

## 6. Records (S1 kinds)

| Kind | Key | Payload |
|---|---|---|
| STRUCTURE_BUILT 95 | p, q, tile | owner_tag, faction, gen, entry, notify, kind, holding_key, cost_digest |
| STRUCTURE_SEIZED 96 | p, q, tile | captor_tag, prev_tag, new_gen, faction, domestic, host_id, kind |
| STRUCTURE_CLOSED 97 | p, q, tile | owner_tag, entry, kind |
| NATION_PROPOSED 98 | faction, id | slot, kind, target_faction, value, proposer_tag, target_tag, close_bell |
| NATION_VOTED 99 | faction, id | voter_tag, yes |
| NATION_DECIDED 100 | faction, id | passed, kind, target_faction, value, target_tag, yes, no |
| RAID_OPENED 101 | owner_tag, seq | p, q, bell, raider_host, raider_tag, domestic |
| FORT_GARRISONED 102 | p, q, tile | owner_tag, troops, pend_bell, holding_key |
| CARAVAN_RAIDED 93 (amended) | as before | as before, then `domestic` |

## 7. Off-chain

- **Verifier:** V24 (structures) gains palisades, forts and FortGarrison;
  the stop rule in the Reveal and caravan judgements; V25 `nations`
  (propose, vote, settle, the stance and expulsion writes); V23 judges
  RaidDomestic; V7's clash replay covers forts (shared clash model); V7
  accepts the siege arms. Tamper classes T55–T58.
- **Keeper:** settles closed proposals; DefaultRaid's path avoids
  palisades.
- **Herald:** `h/nations.json` (stances, proposals, the expelled, the
  domestic raids); `h/towers.json` becomes `h/structures.json` (towers,
  palisades, forts with their troops; tower sightings).
- **Gateway:** the new player shapes (BuildStructure by kind, Propose,
  Vote, RaidDomestic, FortGarrison), SettleProposal a settle shape;
  allowances (structure rent; Nation rent on a first Propose); texts for
  codes 87–93.

## 8. Budgets

Reveal and the caravan routes gain the palisade test beside the tower
test; ResolveFromInputs and SkipQuiet the fort join test. All measured in
LiteSVM against the S1 limits. (Step 1: Reveal is gated at the S1 limit, 28,000, in
every season, since the program runs S1 seasons only; the stance and list
reads take the worst no-structure walk to 26,181. See the notes.)

## 9. Work order

1. Structures (rename, palisades, the stop rule, Season stances read).
2. Nations (accounts, proposals, votes, settlement, expulsion flags).
3. Domestic raids.
4. Siege arms.
5. Forts (garrison, clash, seizure).
Each through the kernel, ABI, program, LiteSVM, fclient, verifier,
keeper, herald and gateway, committed on its own.

## 10. For the owner: choices this contract makes

1. Stances are one-sided, and ALLY behaves as PASS in stage 1.
2. A march through a palisade that stops it is refused at Reveal (it
   settles as a walk the rules refuse), judged by the palisades standing
   then.
3. A fort fights every other faction once it joins (the clash has no
   alliances); it joins only for a faction it stops.
4. One vote a Citizen; a quorum of 3 yes votes.
5. Fort troops come from a holding in the same Province.
6. Expelled villages lose the prize share in principle; stage 1 has no
   prize code to change.
