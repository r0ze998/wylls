# Stage 1b: vaults and caravans (contract)

Design: `docs/design/redesign/18-stage1-play.ja.md` §2, §8–§9, and
`30-stage1-build-plan.ja.md` §1 items 7, 9–13, §2 rows 1b and 1c,
decisions J1 and J2. This contract fixes the accounts, instructions,
records and checks before the code. Every number marked [phase 6] is a
placeholder.

**Tags.** [proposal] marks a choice this contract makes where the design
left it open. These are listed for the owner in §9.

## 0. Scope

1b and 1c are specified together. 1c (the raid and the escort) changes the
clash, and the caravan's province record exists only so that the clash
can see it.

| In | Out (later stages) |
|---|---|
| Vault: build, hold goods, be seized | Shares, claims and use rights on a vault (stage 2) |
| Caravan: send goods along a public hex path; arrive; be raided | Conditional or repeated sends (stage 3) |
| Raid: take the caravan (it becomes the raider's), or burn its cargo | Escrowed exchange (stage 2) |
| Escort: a host waiting on a path tile defends the caravan (J1) | Hiding cargo (after zk) |
| The taken caravan travels to the raider as a visible caravan (J2) | Watchtowers (1d), domestic-raid log and expulsion (1e) |

## 1. Accounts

Both are ABI v2 chained accounts (64-byte header), created with
`init_with_seed` by the Season PDA and funded by the relay's payer.

### 1.1 Vault (kind 19, entity kind 9, seed `va` ‖ P i16 ‖ Q i16 ‖ tile u8; 512 B)

| Field | Off | Type | Meaning |
|---|---|---|---|
| P, Q | 64, 66 | i16 | Province |
| TILE | 68 | u8 | Tile index 0..61 |
| STATE | 69 | u8 | 0 none, 1 live |
| FACTION | 70 | u8 | The owner's faction when built or seized |
| GEN | 71 | u8 | +1 at every seizure (a caravan to an earlier generation does not deliver) |
| OWNER_CITIZEN | 72 | [u8;32] | Owner Citizen |
| OWNER_TAG | 104 | u64 | `citizen_tag` of the owner |
| BUILT_TS | 112 | i64 | |
| STORES | 120 | [i64;8] | Goods, milli-units (no production, no decay) |
| CAP | 184 | i64 | Capacity per resource, milli [phase 6] |
| SENT | 192 | u32 | Caravans sent from this vault (caravan sequence) |
| SEIZED_BELL | 196 | u32 | Last seizure, `NO_BELL` if never |
| RENT_TO | 200 | [u8;32] | Rent refund at close |
| RSV | 232 | 280 | Reserved (stage 2: shares) |

Rules:
- **Where:** any passable tile of an opened Province that is not a
  settlement site, not the keep tile and not the camp tile; at most one
  vault per tile. Own land, nation land and beyond the border are all
  allowed (redesign 12, 14).
- **Limit:** at most `MAX_VAULTS = 3` per citizen [phase 6]. The count is
  kept in `Citizen` v2 `VAULTS @312` (u8, from the Citizen reserve).
- **Cost:** `VAULT_COST = [0, 200, 200, 0, 0, 50, 0, 0]` units [phase 6],
  paid from one of the owner's holdings. The rent is paid by the relay's
  payer and refunded at close.

### 1.2 Caravan (kind 20, entity kind 10, seed `cv` ‖ owner_tag u64 ‖ seq u32; 320 B)

| Field | Off | Type | Meaning |
|---|---|---|---|
| OWNER_CITIZEN | 64 | [u8;32] | |
| OWNER_TAG | 96 | u64 | |
| SEQ | 104 | u32 | `Citizen.CARAVANS` at send (`Citizen` v2 `CARAVANS @313`, u32) |
| FACTION | 108 | u8 | |
| STATE | 109 | u8 | 1 moving, 2 delivered, 3 lost (cargo burned or the destination gone) |
| STEPS | 110 | u8 | Path length 1..=32 |
| N_PROV | 111 | u8 | Provinces on the path, 1..=4 |
| SRC | 112 | rec:Place | Origin (§1.3) |
| DST | 128 | rec:Place | Destination |
| PATH | 144 | [u8;12] | 3-bit directions (`seal` packing) |
| PROVINCES | 156 | [(i16,i16);4] | In entry order |
| DEPART_TS | 172 | i64 | |
| ARRIVE_TS | 180 | i64 | Departure + path time |
| LAST_BELL | 188 | u32 | The last bell the caravan stands on a tile |
| CARGO | 192 | [i64;8] | milli |
| FEE | 256 | u64 | Settle fee escrowed (lamports) |
| RENT_TO | 264 | [u8;32] | |
| RSV | 296 | 24 | |

### 1.3 Place (16 B), the origin or destination of a caravan

`KIND u8` (1 holding, 2 vault), `P i16`, `Q i16`, `SITE_OR_TILE u8`
(holding: site; vault: tile), `GEN u8`, `TILE u8` (the hex tile), `RSV`
(9). A holding place is its site's holding; a vault place is the vault on
the tile.

### 1.4 Province: caravan slots (in `RSV @3864`, 232 B → 180 B used)

`CARAVANS @3864 rec:CaravanSlot x5` (36 B each), then `TOWERS @4044
[u64;6]` (48 B, reserved for 1d: per-nation tile coverage). 4 bytes stay
reserved.

CaravanSlot (36 B):

| Field | Off | Type | Meaning |
|---|---|---|---|
| ID | 0 | u64 | `caravan_id(owner_tag, seq)` (§2.2); 0 = free |
| FACTION | 8 | u8 | |
| N | 9 | u8 | Bells the caravan stands in this province (0..=8) |
| RAID_OFF | 10 | u8 | 0xFF none, else the bell offset of the raid |
| RAID_POS | 11 | u8 | The winning arrival's ClashInputs position |
| FIRST_BELL | 12 | u32 | The bell of `TILES[0]` |
| TILES | 16 | [u8;8] | The tile the caravan stands on at the start of each bell |
| RSV_24 | 24 | 4 B | Reserved (zero) |
| RAIDER | 28 | u64 | The winning host id (its holding names the raider) |

The raider is recorded in the slot because the ClashInputs account can
close within a bell or two of the clash. The raid settles later, within
`RAID_DECIDE_BELLS`, without it.

- A slot is reusable once `ID = 0`, or once `FIRST_BELL + N ≤
  RESOLVED_NEXT` and the raid, if any, is settled (`RAID_OFF = 0xFE` marks
  "settled").
- SendCaravan claims one free slot in every province where `N > 0`. It
  refuses `ProvinceBusy` when none is free [proposal: 5 slots per
  province].

The bytes are outside M1's state block. **The S1 clash digests include
them** (§4.3).

## 2. Kernels (`permutation-rules/src/frontier/caravan.rs`, `CARAVAN_VERSION` 1)

### 2.1 Path and schedule

- The path is a hex walk from the origin tile to the destination tile:
  the same 3-bit step encoding, `MAX_PATH_STEPS` 32 and
  `MAX_PATH_PROVINCES` 4 as sealed marches.
- Step time: `travel::hex_secs(terrain, road, Spearman) ×
  CARAVAN_SLOW_BPS (15,000) [phase 6]`, then × the owner's doctrine
  `caravan_time_bps` (B Tide 0.8).
- `schedule(depart_ts, steps, secs[]) -> Vec<(bell, province, tile)>`:
  the tile the caravan stands on at the start of each bell from `bell_at(depart_ts) + 1`
  to the bell after arrival.
  - A caravan that crosses a province between two bell starts has `N = 0`
    there: no slot, and nobody can meet it there.
  - At most 8 bells per province (`SLOT_TILES`); a longer stay is refused
    (`TooSlow`). A long route is split into several sends (redesign 30
    §1-9).

### 2.2 Ids

- `caravan_id(owner_tag, seq) = (1 << 63) | ((owner_tag & 0x7FFF_FFFF_FFFF)
  << 16) | (seq & 0xFFFF)`.
  - Bit 63 set: never a host id (`mk_host_id` keeps it clear), and never
    the camp id (`u64::MAX − gen` sets every high bit).
  - [proposal] A clash needs ids unique only within its province and bell.
- There is no carrying capacity: a take moves the whole caravan (J2;
  amended 2026-10-23, see §3.5).

## 3. Instructions (tags 0xB0–0xB7)

| Tag | Name | Class | Signer | Accounts after the player prologue |
|---|---|---|---|---|
| 0xB0 | BuildVault | P | session ok | `[holding w] [holding_province r] [province r] [vault w] [system]` |
| 0xB1 | SendCaravan | P | session ok if the destination is the actor's; else **wallet** (§3.3) | `[src w] [src_province r] [dst r] [caravan w] [system] [path_province w ×1..4]` |
| 0xB2 | SettleCaravan | D | anyone | `[fee_payer s] [season] [caravan w] [dst w] [beneficiary w] [rent_to w] [path_province r ×1..4]` |
| 0xB3 | RaidCaravan | P | the raider (session ok) | `[caravan w] [raider_holding r] [dst r] [path_province w ×1..7]`: the new walk's Provinces first (`n_path`, the raid's first), then the old route's others |
| 0xB4 | SeizeVault | P | the captor (session ok) | `[vault w] [province r] [host_holding r] [owner_citizen w]` |
| 0xB5 | CloseVault | P | the owner (wallet) | `[vault w] [rent_to w]` (empty vault only) |
| 0xB6 | DefaultRaid | D | anyone, after the raider's window | `[fee_payer s] [season] [caravan w] [raider_holding r] [raider_citizen r] [beneficiary w] [path_province w ×1..7]`: the caravan to the raider's host holding |

### 3.1 BuildVault

1. Checks:
   - The holding is the actor's, live and not capture-locked.
   - The tile qualifies (§1.1) and the vault account is absent.
   - The citizen has `VAULTS < MAX_VAULTS`.
2. Effects:
   - The holding pays `VAULT_COST`.
   - The vault is created: owner, faction, gen 1, `CAP`.
   - `Citizen.VAULTS += 1`.
3. Log `VAULT_BUILT` (kind 90).

### 3.2 SendCaravan(path, steps, cargo [u32;8] units, fee, dst Place)

1. The source is the actor's: a live holding (touched and paid from like a
   Build) or a live vault (its stores debited).
2. The destination exists and is live at the given gen.
3. The path:
   - Walks from the source tile to the destination tile over the listed
     provinces (`PASSABLE`, `ROUGH` and `ROAD` masks, as Reveal's walk;
     the walk moves to a shared function).
   - The provinces are listed in first-entered order and must be exactly
     the provinces the walk crosses.
4. `fee ≥ CARAVAN_FEE` is moved from the payer into the caravan; the rent
   comes from the payer.
5. The schedule (§2.1) is written into a free slot of every province with
   `N > 0`. All four provinces are writable, so the caravan is in place
   before its first bell.
6. Log `CARAVAN_SENT` (kind 91). Its fields:
   - the id and both places
   - the path, the cargo and the times
   - the slots written: (P, Q, first bell, n)

### 3.3 Sends to another player (plan §1-11)

- A destination that is not the actor's own holding or vault requires the
  **wallet** to sign. The session key is refused (`WalletRequired`).
- A stolen session key can then move goods only between the victim's own
  places.

### 3.4 SettleCaravan (permissionless, after `ARRIVE_TS`)

1. Every path province must have resolved past the caravan's last bell
   there.
2. No slot of this caravan may hold an open raid (§3.5).
3. Delivery:
   - The destination is credited with the cargo: a holding through
     `Holding::credit` (S1 workshops restart); a vault up to `CAP`, any
     excess lost.
   - A destination that is gone, or of another generation, loses the
     cargo: `STATE 3`, logged.
4. The fee goes to the beneficiary (`pay_or_divert`).
5. The caravan closes to `RENT_TO`, and its slots are freed.
6. Log `CARAVAN_SETTLED` (kind 92).

### 3.5 The raid: clash rule (1c) and RaidCaravan

**In the clash** (`clash_model::build_v2`, S1 only):
- After the site garrisons and the camp, each live caravan slot of this
  province with `FIRST_BELL ≤ b < FIRST_BELL + N` and no raid joins as a
  **0-troop garrison**: on `TILES[b − FIRST_BELL]`, of the caravan's
  faction, Hold.
- It joins **only while `garrisons.len() < MAX_GARRISONS`**, so the worst
  case stays 12 garrisons plus the keep (plan §1-7).
- Its escort is whoever of its faction stands on that tile: residents
  (J1: a sealed march that arrived there earlier) or arrivals.
- **Raided** when the kernel reports `attackers_hold` for it. The slot
  then records:
  - `RAID_OFF` = the bell offset;
  - `RAID_POS` = the lowest ClashInputs position among the holders that
    stay on the tile;
  - `RAIDER` = that arrival's host id.
- An escort that holds the tile keeps the caravan safe.
- A caravan of the same faction cannot be raided here: the clash treats a
  faction as friendly. Domestic raids are 1e's.

**RaidCaravan(choice, dst Place, n_path, path)**, signed by the citizen
whose holding the raiding host belongs to (decision J2, amended
2026-10-23: the first version of this contract moved a share of the cargo
into a new caravan; J2 as decided moves the caravan itself):
- **burn:** the whole cargo is destroyed. The empty caravan goes on to its
  destination and settles as usual.
- **take:** the raided caravan **becomes the raider's**:
  - `OWNER_CITIZEN` and `FACTION` become the raider's; `OWNER_TAG` (the
    address seed) and the cargo stay; `RENT_TO` and `FEE` stay.
  - It leaves the raid tile (origin: the field, place kind 3) for the
    raider's chosen holding or vault on a new public path, with slots like
    any caravan: a visible target that can be raided back.
  - Every slot of its old route is cleared (each old Province must be
    listed), so no clash sees it where it no longer goes. No new account,
    no new rent.
- The window is `RAID_DECIDE_BELLS = 6` [phase 6].
- After the window, **DefaultRaid** (permissionless) applies *take* to
  the raiding host's own holding along the fastest path
  (`caravan::fastest_path`, the keeper's; [proposal]: the raider gets the
  caravan where it would most likely want it).
  - The raiding holding gone (closed, or another generation): a burn.
  - No walk home given (`steps` 0 off the home tile, e.g. home beyond 32
    steps or 4 provinces): a burn, but only `RAID_BURN_AFTER_BELLS` (144
    [phase 6]) after the window. A raid never stays open for good, and a
    keeper has a day to take the caravan home when a path exists.
  - A caravan taken on its destination's own tile walks no step: it
    arrives at once with no slot (a send's two places never share a tile).
  - The keeper is paid the caravan's escrowed fee; the caravan then
    settles with none.
- A burn marks the slot settled (`RAID_OFF = 0xFE`); a take clears it.
- Log `CARAVAN_RAIDED` (kind 93): choice, by, raider, the cargo taken or
  burned, a take's destination, the old route's Provinces it cleared
  (each chained); then a take's new route as a `CARAVAN_SENT` (origin the
  field).

### 3.6 SeizeVault (plan §1-10)

A vault is not a site and cannot be besieged. It is seized by **standing on it**:
- The captor's host must be in the roster (state 1, `FROM_BELL ≤
  RESOLVED_NEXT`) on the vault's tile.
- No roster host of the vault's owner may be on that tile. The owner's
  holdings come from the owner Citizen's holding refs.
- The captor is not the owner.
- Effects:
  - The owner becomes the captor, the faction the captor's, `GEN += 1`.
  - Both citizens' `VAULTS` counters move. A captor at `MAX_VAULTS`
    cannot seize (`VaultLimit`).
- The goods stay in the vault.
- A same-faction seizure is allowed and logged as domestic (1e's record).
- Log `VAULT_SEIZED` (kind 94).

## 4. Verifier, digests, keeper, relay

### 4.1 Verifier (`verify`, check V23 caravans)

- **Replays:** BuildVault (the cost, the tile rules, the counter);
  SendCaravan (the walk, the schedule and the slots written, the source
  debit, the wallet rule); SettleCaravan (the delivery, the fee, the
  close); RaidCaravan and DefaultRaid (the take's owner, route and slots);
  SeizeVault (the roster condition).
- **Codes:** `CaravanMismatch`, `VaultMismatch`.
- RaidCaravan and DefaultRaid (J2): a take's new owner, faction, route and
  slots, and no slot of the old route left.
- **Tamper classes** (numbered after the conquest's T25–T48): T49 a
  caravan slot not written, T50 cargo delivered twice, T51 a vault seized
  without a host on its tile.
- V7's holding continuity: BuildVault and a holding source are owner
  touches that pay; a delivery is a settle and a credit (no touch).

### 4.2 The clash replay (V7)

V7 follows through the shared `clash_model`. The caravan garrison and the
slot write-back are part of the model.

### 4.3 Digests

- In an S1 season the clash and skip input digests append
  `PSF-CARAVAN-v1 ‖ CARAVANS[5]` to the v2 input.
- MC digests are unchanged: the model takes the rules version.

### 4.4 Keeper

- SettleCaravan: a D duty, after arrival and the path provinces' resolve.
- DefaultRaid: a D duty, after the window.
- Both are paid by the caravan's fee (DefaultRaid's from the raided
  caravan's fee).
- `keeper/src/caravans.rs`; the caravans come from the feed's
  CARAVAN_SENT records, the slots from the play duty's Province reads.

### 4.5 Relay (gateway)

- Allow-list: the player shapes BuildVault, SendCaravan, RaidCaravan,
  SeizeVault and CloseVault, and the settle shapes SettleCaravan and
  DefaultRaid.
- Allowance:
  - SendCaravan: caravan rent + `CARAVAN_FEE`
  - BuildVault: vault rent
  - RaidCaravan, DefaultRaid: nothing (a take reroutes the caravan itself)
- The allowance caps the fee: SendCaravan's and RaidCaravan's `fee` is
  the player's choice and comes from the payer (the pool key), so one
  above `CARAVAN_FEE` drains more than the allowance and is refused.
- Quota: SendCaravan counts like a Depart (`departsPerDay`): in an S1
  season the daily lamport cap is 24 × the larger of a Depart escrow and
  a caravan's cost, plus one vault's rent.
- **The S1 profile.** The S1 release `.so` is its own program, larger than
  the MC one, so S1 seasons have their own loaded limits
  (`v2::budgets::loaded_limit_s1`, `PLACEHOLDER_SO_LEN_S1` 1.375 MiB):
  fclient `Budgets::canonical_for(4)`, the JS SDK's profile 3 (by
  `RULESET_HASH_V3`; the v2 layouts and instructions otherwise).

### 4.6 Budgets [to be measured]

| Instruction | Compute budget |
|---|---|
| BuildVault | 40k |
| SendCaravan | 120k (a walk over up to 4 provinces) |
| SettleCaravan | 40k |
| RaidCaravan | 120k |
| SeizeVault | 30k |

The ResolveFromInputs worst case is re-measured with 12 garrisons, 24
arrivals and the caravan scan. If it goes over the 290k gate, the gate is
raised by amendment.

## 5. Layout amendments (ABI v2, S1)

- Province: `RSV @3864 (232)` → `CARAVANS @3864 x5 (180)`, `TOWERS @4044
  [u64;6] (48)`, `RSV_4092 (4)`.
- Citizen: `RSV @312 (72)` → `VAULTS @312 u8`, `RSV_313 (3)`, `CARAVANS
  @316 u32`, `RSV_320 (64)`.
- New kinds: Vault 19, Caravan 20.
- New entity kinds: Vault 9, Caravan 10.
- New log kinds: 90–94.
- `RULESET_HASH_V3` re-pinned with the caravan kernel (`caravan` 1) and
  its constants.

## 6. Tests

- **LiteSVM:**
  - Every instruction: the refusals, the happy path and the effects.
  - A raid end to end:
    - send;
    - a sealed march to a path tile at the caravan's bell;
    - gather and resolve: the slot shows the raid;
    - RaidCaravan take: the caravan the raider's, its new slots, no old slot left, delivered to the raider;
    - burn.
  - An escort that holds: no raid, delivered.
  - A seizure.
  - ResolveFromInputs CU at the worst case.
- **Kernels:** schedule determinism, slot limits, ids, proportional split.
- **Verifier:** replays on a recorded S1 run, and the three tamper classes.

## 7. Simulator

`frontier-sim` gains sends and hex paths (plan §2 1b), so 1b's question,
whether dependence and exchange appear, can be asked. Separate notes.

## 8. Work order

1. Kernels and ABI (layouts, tags, data, logs, account specs, budgets,
   vectors).
2. Program: BuildVault, SendCaravan, SettleCaravan, SeizeVault, CloseVault,
   with LiteSVM tests.
3. Clash integration and RaidCaravan / DefaultRaid, with LiteSVM tests and
   the CU measurement.
4. Verifier (V23, the digests, tampers), fclient builders, keeper duties,
   herald, relay.
5. Simulator.

## 9. For the owner: choices this contract makes

1. **Seizing a vault** = standing on it with a host while none of the
   owner's hosts stands there. There is no siege.
2. **5 caravan slots per province.** A busy province refuses more sends
   until a slot frees (`ProvinceBusy`).
3. A caravan is exposed only at **bell starts**. One that slips through a
   province between two bells has no slot there.
4. **The raider has 6 bells to choose** take or burn. After that the caravan
   is taken home to the raiding host's holding.
5. **A caravan's own guard is 0 troops.** Without an escort, any hostile
   host on its tile at a bell start raids it.
6. **Vault limit 3 per citizen**, cost and capacity [phase 6].
7. **A destination lost or seized** while the caravan travels: the cargo
   is lost.
