# Playable wide world: compatibility review

Status: implementation preparation, not an approved new game protocol. Reviewed against `9387b63` and the tile/route prerequisite `76c48d09`. No new world, ownership rule, reward rule, instruction tag or account kind is selected here. In particular, a separate non-playable terrain experiment is not the next deliverable.

## Existing contracts that must not be silently reinterpreted

| Contract | Actual code boundary | Consequence |
|---|---|---|
| Land creation | `permutation-frontier/src/proc/map.rs::open_province` | Creates terrain, sites, keep, camp, Free City, ownership metadata; debits ProvinceFund and changes opening counters. A terrain-only record is not equivalent. |
| Land identity | `geometry::checked/index`, `addr::host_id` | Ring 128 is the accepted domain. Dense host province field is 20 bits; even removing 128 would only fit whole rings through 590. Never modulo or truncate a wide coordinate into it. |
| Citizen holdings | `layout/player.rs::holding_ref`, `v2/layout/player.rs::citizen` | Three 6-byte refs contain i16 P,Q, site and generation. The three-slot ownership invariant must cover old and new storage together. A wide-only side table cannot independently grant three more slots. |
| Holding and outgoing transit | `layout/player.rs::holding/transit/explore` | i16 P,Q and 8-byte host IDs occur in current holdings, four transit records and explore records. Updating only destination coordinates leaves identity and settlement broken. |
| Arrivals and combat | `layout/clash.rs::arrival_slot/clash_inputs` and v2 wrappers | ArrivalSlot has a u64 host ID and i16 destination; clash input rows also carry the host ID. Departure, reveal, gather, resolution and return must share one new reference format. |
| Terrain domain | `geometry::check_hex`, `terrain::generate_province`, `mapgen::noise` | Existing validated tile components are bounded to 65536. Full province rings through 7281 fit (9d+4 <= 65536); this is not a wide i64 terrain kernel. Noise has a 2^40 period and an i32 tile key. Reusing it by coordinate truncation is forbidden. |
| Ring randomness | `map.rs::open_ring/consume_ring_seed`, RingSeed layout | Existing ring identity is u16 and random seed proof/round binding is part of game fairness. A caller-supplied seed or a genesis-known seed is not automatically equivalent. |
| National placement | `geometry::home_nation` | Dispersed placement applies only inside configured heartland rings. Outside them it currently returns the wedge. Extending dispersed placement to the entire world is a separate rule decision. |
| Prize tally | `permutation-prize/src/lib.rs::tally/finalize` | 1024-bit bitmap; whole rings only through 17; COUNTED and AREA are u16. Land opening cannot safely outgrow this tally without a new authenticated sparse accounting path. |

## Recommended technical invariants, pending protocol choice

These are safety constraints, not choices about nations or rewards:

1. Preserve all deployed layouts, addresses, u64 host IDs and asset quantities. Introduce a separately versioned wire/layout family rather than enlarging fields in place.
2. Use canonical world + province + site + generation + sequence identity throughout the new path. `ProvinceKey` and `WideHostRef` already encode this exactly. Conversion back to legacy must remain fallible; a caller cannot choose an alias encoding.
3. Authenticate owner/program/world/version/derived address before accepting any account. A new land kind must not masquerade as the old Province magic merely to pass old handlers.
4. There must be one active representation of each holding and outgoing host. Any migration/bridge must atomically deactivate or lock the source before crediting the destination, preserve generation/sequence and resources, and be idempotent under retries. Do not add a shadow sidecar without updating every old writer that could still spend the source.
5. The same three-slot limit, pending claims and reservations must be checked across the selected version transition. NFT ownership/generation checks should call the existing shared holder contract, not a second definition.
6. A cross-boundary march must be implemented as a complete lifecycle. A quoted route is insufficient: origin debit/reservation, departure settlement, seal, destination reveal, gather, clash, transit settlement and return/expiry must use the same identity and replay keys. Do not enable only Depart and leave the destination unable to settle it.
7. Land existence and passability come from authenticated captured accounts at a consistent snapshot. Unknown, closed, missing or different-world records are refusal conditions, not default plains. The pure route/quote primitives enforce report matching but do not authenticate reports.
8. Wide prize accounting needs an authenticated, frozen eligible-land inventory and deduplicated per-land tally receipts. Count equality alone is not proof unless every counted identity belongs to that inventory. Closing land must retain its terminal score or prevent closure before recording it; missing land must not silently count as zero. Allocation, funding and claimant rules remain separate owner decisions.
9. Keeper/indexer work should be bounded per transaction and per tick, and cursor/snapshot replay must survive restart. Merely widening counts while repeatedly enumerating all land is not autonomous scalable growth.
10. Default builds and existing worlds must not opt into the new protocol. New tags, kinds, seed domains, version and ruleset hash require an integration allocation and cross-reader verification before any publication.

## Implementation order after rule confirmation

- Freeze the smallest new protocol contract and allocation with the integrator: one world versus regions, continuing placement rule, seed proof, eligible reward domain and migration boundary. Do not infer these from a technical coordinate type.
- Implement wide terrain arithmetic plus deterministic proof-bound seed input. Preserve old terrain bytes in the legacy domain, or version the difference explicitly. Test seams, rotation, full coordinate bytes, overflow and no periodic/truncation aliases.
- Implement versioned land and holding storage plus the one-active-asset invariant. Exercise the real dispatcher on literal host accounts; no keypairs or signatures are needed for these host tests, but they are not signed-chain acceptance.
- Connect the complete march lifecycle, then sparse prize accounting and the verifier. Only then expose writable game UI/keeper flows. UI must distinguish captured state from provisional data and must never treat fixture land as live land.
- Run one pinned-tree scenario: actual land creation beyond128, claim/ownership, outbound and return march across128/129, duplicate/lost-response/restart cases, closure and final reward accounting. Separate mocks/syscall stubs from executed program code, and leave signed-chain/SBF verification explicitly unperformed under the current rule.

## Implemented prerequisites (not completion)

`world_index::tiles` provides exact i128 tile geometry and bounded reported-open route checks. `world_index::movement` adds a quote using the unchanged `travel::hex_secs` schedule; unknown/impassable/substituted tile reports are refused. It does not define new prices, perform permission checks, resolve battles, debit assets or submit instructions. The same-snapshot requirement belongs to the caller and is not a cryptographic finality guarantee.

Tests compare every legacy tile, all eight units across passable terrain/road combinations, ring128/129 boundary crossings, coordinates above2^53, and world-edge refusal. No writer, migration, wide land creation or playable expansion is claimed by these tests.
