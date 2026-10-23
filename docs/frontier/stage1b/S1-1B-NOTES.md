# Stage 1b: vaults and caravans (notes)

Contract: [S1-1B-CONTRACT.md](S1-1B-CONTRACT.md). Design: `docs/design/redesign/30-stage1-build-plan.ja.md` §2 (1b), plan §1-7, §1-10, §1-11. Before this: [stage 1a](../stage1a/S1-1A-NOTES.md).

## What changed

**The rules (`RULESET_HASH_V3 = 984c9a08…3f70`):**

- The caravan kernel `permutation_rules::frontier::caravan` (`CARAVAN_VERSION` 1).
- It is bound into the v3 hash input: `KERNEL_VERSIONS_V3` gains `caravan`, and `caravan::write_tables` is appended.

| Part | Where |
|---|---|
| Walk (the sealed march's, ×1.5 slower × the doctrine's `caravan_time_bps`) | `caravan::walk` |
| Schedule: the tile at each bell start, one run per province | `caravan::schedule` |
| The fastest path any client finds (Dijkstra over base step time, ties by direction) | `caravan::fastest_path` |
| Slots (5 per Province, 8 bells each, 36 B) | `caravan::CaravanSlot` |
| Ids (bit 63), carry (0.1 unit a troop), the proportional split | `caravan_id`, `carry`, `split` |
| Vault cost, cap, limit; caravan fee; raid window; burn delay | constants (all [phase 6]) |

**ABI v2, S1 part:**

- Accounts: Vault (kind 19, 512 B) and Caravan (kind 20, 320 B).
- Province `CARAVANS @3864 ×5` and `TOWERS @4044` (for 1d).
- Citizen `VAULTS @312` and `CARAVANS @316`.
- Tags 0xB0–0xB6, log kinds 90–94, error codes 79–86.
- The account tables and the budgets.
- The vectors are regenerated.

**The program, in `proc/caravan.rs`:**

| Tag | Instruction | Notes |
|---|---|---|
| 0xB0 | BuildVault | It is an owner touch that pays `VAULT_COST`. The tile is refused if impassable, a site, the keep or a present camp. |
| 0xB1 | SendCaravan | From a holding (touch and pay) or from a vault (debit). It claims one slot in every province the caravan stands in at a bell start. The fee is escrowed. A send to another player needs the wallet. |
| 0xB2 | SettleCaravan | Permissionless, after the arrival and the resolve of every slot bell. It delivers if the destination stands at the named generation, and the cargo is lost otherwise. The fee goes to the settler and the rent to `RENT_TO`. |
| 0xB3 | RaidCaravan | The raider takes or burns within `RAID_DECIDE_BELLS`. A take becomes a loot caravan of the raider, starting from the raid tile. |
| 0xB4 | SeizeVault | The captor's roster host stands on the vault's tile and no host of the owner is there. |
| 0xB5 | CloseVault | The owner closes it, by wallet, when it is empty. |
| 0xB6 | DefaultRaid | Permissionless, after the window. It takes the loot home to the raiding host's holding. |

**Decisions made in implementation** (now in the contract):

- **A raid never stays open for good.**
  - If the raiding holding is gone (closed, or a later generation), DefaultRaid burns.
  - If no walk reaches home (beyond 32 steps or 4 provinces), DefaultRaid may burn, but only `RAID_BURN_AFTER_BELLS` (144) after the window. Keepers get a day to deliver when a path exists, so a burn is not a cheap grief.
- **A loot raided on its destination's own tile walks no step.** It arrives at once and has no slot. This happens when a caravan crosses the raider's site hex.
- **DefaultRaid's fees:**
  - The keeper fronts the loot's rent and fee. Its `RENT_TO` is the keeper, and both come back when the keeper settles the loot.
  - The keeper is paid the raided caravan's fee.
- **CLOSE of a Vault or a Caravan chains the closed account**, as M1's CLOSE rule does (`v2::log::chains_of`).
- **The S1 release `.so` is its own program, larger than the MC one** (1,272,440 B).
  - S1 seasons have their own loaded-limit table: `PLACEHOLDER_SO_LEN_S1` = 1.375 MiB, `loaded_limit_s1`, `loaded_limit_for(program_version)`.
  - The S1 presets carry `REVEAL_LOADED_LIMIT_S1`.
  - The MC table and presets are unchanged.
- **Tamper classes** are numbered T49–T51, after the conquest's T25–T48.

## Off-chain

- **fclient:**
  - Vault and caravan addresses, and the seven builders (`ix::v2`, `PlaceRef`).
  - Typed S1 log events (`conquest::CqEvent::{VaultBuilt, CaravanSent, …}`).
  - The S1 rows of the ABI twin tables.
  - `Budgets::canonical_s1`, used by `canonical_for(4)`.
- **Verifier, V23** (`checks/v23_caravans.rs`):
  - It re-judges every S1 instruction from the states before and after.
  - V7's holding continuity covers the S1 holding writes: a touch that pays, or a delivery as settle plus credit.
  - Codes: `CaravanMismatch`, `VaultMismatch`.
  - Tampers T49 (slots not written), T50 (cargo credited twice) and T51 (seized without a host). They are extras until an S1 fixture with caravans is committed.
- **Keeper** (`keeper/src/caravans.rs`):
  - SettleCaravan once the caravan has arrived, its path provinces have resolved and no raid is open on it.
  - DefaultRaid after the window, along `fastest_path`. It burns when home is gone, or after the delay when home is unreachable.
  - Both ride the `settle` role.
- **Herald:**
  - Publishes `h/caravans.json`: the caravans on the road (runs, cargo, raided) and the vaults. It is kept in the checkpoint.
  - S1 records are scoped by their province.
- **Gateway relay:**
  - The S1 player and settle shapes are allowed.
  - Allowances: a vault's rent, or one caravan's rent plus `CARAVAN_FEE`. A larger fee drains more than the allowance and is refused.
  - In an S1 season, caravans count like Departs in the daily lamport cap, plus one vault's rent.
  - JS profile 3 (S1, by `RULESET_HASH_V3`) uses the v2 tables with the S1 loaded limits.
  - Japanese and English texts for the S1 error codes.

## Stage 1b's question: does trade appear?

`frontier-sim trade --seed S [--only MAX_RING]` measures the incentive on the season's own map. It uses the program's kernels and masks: terrain ore, `fastest_path`, `walk`, `schedule`. It counts domestic trade only (a faction's own wedge). `FRONTIER_SIM_WORKSHOPS=K` sets the workshops a holding wants to run.

Seed 1, rings 2–4, 648 sites:

| Workshops a holding | Short of ore | With a surplus | Shortfall coverable | Trip p50 / p90 | Exposure p50 / p90 (bell starts) |
|---|---|---|---|---|---|
| 1 | 49.1% | 34.3% | 47.5% | 9 / 21 min | 1 / 2 |
| 2 | 75.9% | 20.4% | 12.0% | 13 / 21 min | 1 / 2 |
| 3 | 91.7% | 5.6% | 1.3% | 18 / 30 min | 2 / 3 |

Seeds 2 and 3 agree (at 2 workshops: 55.6% and 85.2% short).

1. **Dependence appears.**
   - From one workshop up, about half of the holdings or more are short of ore.
   - Every short holding has a supplier in its own wedge within a caravan's walk.
2. **Exchange is limited by supply, not distance.**
   - At two workshops, the whole map's surplus covers about 12% of the shortfall.
   - Ore becomes the contested good. That is the J6 intent: rich-ore outposts are worth holding.
3. **Caravans are short and lightly exposed.**
   - A domestic trip stands on 1–2 bell starts (p90 2–4).
   - A raid therefore needs a host waiting on exactly those tiles at those bells.
   - For stage 1c this means:
     - raids will be rare unless caravans are visible ahead of time (the herald's feed and 1d's watchtowers make them so);
     - longer, cross-wedge routes are the dangerous ones.

The simulator's players do not move on hexes, so they don't play caravans. The bots will (stage 1f), and these numbers are what they will face.

## Tests run

| Suite | Result |
|---|---|
| `permutation-rules` | 496, including the caravan kernel (9) and `fastest_paths_walk` |
| `frontier-abi` | 114, vectors regenerated |
| `permutation-frontier` unit tests | 94 |
| LiteSVM, 4 builds | 363/363, including `tests/caravan.rs` (13) over all seven instructions, covered in the G13 registry |
| `frontier-node` | 680 (verify 86, keeper with `s1_caravan_settles_and_default_raids`, herald 70, fclient 81) |
| `permutation-gateway` | 2,374, including `frontier-s1-relay.test.mjs` |
| `frontier-sim` | 55 (`--skip doctrine_balance_gate`) and the 2 trade tests |

## Still open

- **Stage 1c:**
  - The clash does not raid caravans yet: a caravan garrison in `clash_model::build_v2/apply_v2`, the S1 digests (`PSF-CARAVAN-v1`), V7's replay.
  - The LiteSVM raid tests craft the raid in the slot until then.
  - The ResolveFromInputs CU worst case needs re-measuring.
- **Budgets** (CU, tx sizes) are the contract's placeholders until measured.
- **The web client** (1f): S1 loader, caravan and vault views from `h/caravans.json`, the send and raid forms.
- **Bots** (1f): sends to vaults and holdings, escorts, raids.
- **A closed vault** stays in the herald's feed until read absent: its CLOSE carries no S1 kind.
