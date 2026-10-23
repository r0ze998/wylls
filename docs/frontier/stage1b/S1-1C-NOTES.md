# Stage 1c: caravans in the clash (notes)

Contract: [S1-1B-CONTRACT.md](S1-1B-CONTRACT.md) §3.5 (1b and 1c are specified together). Design: `docs/design/redesign/30-stage1-build-plan.ja.md` §2 (1c), decisions J1 and J2. Before this: [stage 1b](S1-1B-NOTES.md).

## What changed

**The shared clash model** (`frontier_abi::clash_model`, the one copy the program, the verifier's V7 and the herald run):

- **A caravan joins the clash.** Each caravan standing in the Province at a bell's start (`CaravanSlot::tile_at(b)`) joins as a **0-troop garrison** of its faction on its tile, Hold.
  - Order: after the site garrisons and the camp, before the keep.
  - Only while fewer than 12 garrisons stand, so the worst case is unchanged.
- **The escort and the raid.**
  - A 0-troop garrison never fights. Its escort is whoever of its faction stands on the tile: a resident that arrived earlier (J1's waiting escort) or an arrival.
  - When the kernel reports `attackers_hold`, the slot records the raid:
    - the bell offset;
    - the raider: the lowest id among the non-scout hosts of the holding factions that stay on the tile;
    - its ClashInputs position, or `0xFF` for a resident.
  - Ambushes by residents count. That is the raider's own "waiting on the road".
- **Shelter.** Garrisons never share a tile. A caravan standing on a site's hex, the camp's, the keep's or an earlier caravan's is not in the clash and cannot be raided there.
  - This includes its origin holding's hex at the first bell, if it has not left yet.
  - In play terms: a settlement protects a caravan inside it.
- **Quiet.** SkipQuiet must never pass a raid, so there is now a shared `is_quiet_v2` that the program, the verifier's skip replay and the herald's fixtures all use.
  - The kernel's `is_quiet` ignores 0-troop garrisons. `is_quiet_v2` adds: no caravan in the clash with a hostile non-civilian host on its tile.
  - `trivially_quiet_v2` refuses any host of another faction on an exposed caravan's tile.
  - The keeper already answers `NotQuiet` with a gather and a resolve.
- **Digests.** `input_digest_v2` and `quiet_digest_v2` append `PSF-CARAVAN-v1 ‖ CARAVANS[5]` when a slot is in use.
  - An MC Province's slots are zero, so MC digests, outcomes and vectors are unchanged (checked: the vectors did not move).

**Raids settle as decision J2 decided** (1b, realigned in this round): a take makes the raided caravan the raider's and reroutes it; a burn empties it.

## Tests

| Where | What |
|---|---|
| `frontier-abi/tests/s1_caravan_clash.rs` | A waiting host raids an unescorted caravan (slot, raider, resident position). An escort that holds keeps it. A friendly tile is quiet. A caravan on a taken tile is sheltered. The digests take the slots only when used, and every slot byte counts. |
| `svm-tests/tests/caravan.rs`, `g13_s1_clash_raids_a_caravan_and_the_raider_takes_it` | Through the program: SkipQuiet refuses (`NotQuiet`); GatherClash and ResolveFromInputs raid the caravan; RaidCaravan takes it; it is delivered to the raider's holding. |
| `g13_s1_clash_escort_holds_and_the_caravan_arrives` | Through the program: the escort holds, no raid, and the cargo reaches A's vault. |
| `svm-tests/tests/clash.rs`, `g01_s1_resolve_from_inputs_with_caravans` | The CU worst case (below). |

**CU, contract §4.6.** All 1,240 adversarial fills were run with five site garrisons replaced by five exposed caravans. That keeps 12 garrisons, 24 arrivals and 48 residents, and produced 2,520 raids.

| | Max CU (gate 290,000) | Max heap (gate 28 KiB) |
|---|---|---|
| ResolveFromInputs with caravans | **280,855** | 15,328 B |
| Same fills without caravans | 275,254 | 15,368 B |

The margin is about 9k CU (3%). 1d's watchtowers add to GatherClash and the arrival records, so the two are measured together again then.

Totals: LiteSVM 366/366 on the four builds; `frontier-abi` 119; `frontier-node` 680; `permutation-frontier` 94.

## Still open

- **Herald:** it does not yet show an open raid. A slot's raid is in the Province bytes; the feed shows only settled raids (CARAVAN_RAIDED). The map's view comes with 1f.
- **Two raids at once:** a caravan raided in one province can still be raided at a later bell in another before the first raid settles. A take clears the old route's slots, the other raid's included: the first settlement wins.
- **Stage 1d (watchtowers)** changes GatherClash and the arrival records. The CU is measured together then (build plan §2).
