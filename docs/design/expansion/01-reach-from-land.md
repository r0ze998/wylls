# Expansion: reach from the nation's land (expansion-gameplay-1)

Status: implemented on a branch for **local play only** (draft PR, 2026-11-24). Not deployed anywhere. Devnet needs a
program upgrade before it has the rule, and that is r0ze's decision.

## 1. The problem

r0ze's observations, 2026-11-24 (t489u–t494u):

- Armies move, but a nation's territory barely changes from where it started, so play feels static.
- Other strategy games spread: settlers travel, found cities, and borders grow.
- "Make it like that" — as a change to game design and gameplay, not to the camera.
- t494u: judge the design on its merits, not because r0ze suggested it.

Goal: in one normal play session, a nation should take ground well away from its start, and its shape on the map should
change. Players, and the operator AI who plays like a player, should face real choices about where to expand.

## 2. What limits expansion today (code study, origin/main c6c9eb17)

| # | Limit | Where |
|---|---|---|
| L1 | A wide claim (0xD9, the 2nd/3rd village) must be within `outpost_range` = 3 provinces of the claimer's **first home**. The anchor is always slot 1 and never moves. | `permutation-frontier/src/proc/wide.rs` `claim_site_as` (`anchor_coord.distance(coord)`); `permutation-rules/src/frontier/holding.rs` `may_found_outpost`; `frontier-abi/src/v2/presets.rs` `FRONTIER_7.outpost_range: 3` |
| L2 | At most 3 holdings per citizen (home + 2). No instruction lets a player give one up. | `holding.rs` `MAX_HOLDINGS_PER_WALLET = 3`; no abandon instruction in the program |
| L3 | A local wide world opens 108 wide provinces in setup (6 per wedge on rings 129–131) and **never opens another**. play-local runs no keeper crate; on devnet the keeper opens land on demand. | `frontier-node/crates/itest/src/wide_land.rs` (`WIDE_RINGS = 3`, `PER_WEDGE = 6`) |
| L4 | Every wide keep opens already held by some nation, interleaved (owner decision ⑧ wide land (i)). The opening map is a mosaic of all six colours, so a capture flips one tile of an existing mosaic. | `wide.rs` `open_province`; `frontier-abi/src/world_index/rules.rs` `KeepHolderRule::MixedInterleaved` |
| L5 | A capture sets the keep holder and nothing else. It gives the captor no right to settle; the 50 % share rule is a refusal, not a grant. | `permutation-rules/src/frontier/keep.rs`; `holding.rs` `OutpostRefusal::Share` |
| L6 | Expedition and march routes enter at most 4 provinces. A keep needs `keep_bells` = 72 turns of holding. | `permutation-rules/src/frontier/travel.rs` `MAX_PATH_PROVINCES = 4`; `FRONTIER_7.keep_bells` |
| L7 | AI: claims the **nearest** opened province within 3 of home; its rim→wide expeditions land on the first tile, not the keep; war marches skip wide keeps (ring ≥ 129); wide→wide marches are at most 2 per village. | `permutation-gateway/src/frontier/local-play-operator-policy.mjs`, `local-play-operator-march.mjs:118`, `local-play-operator-wide-march.mjs`, `permutation-server/web/frontier/flocalplay-wide-plan.mjs` |
| L8 | The page's claim card offers only provinces within 3 of the first home, from the launcher's fixed list of opened provinces. | `permutation-server/web/frontier/screens/holding.mjs` `wideClaimModel`; `flocalplay-wide.mjs` `claimTargets` |

Together these mean a nation's villages can never stand more than 3 provinces from its first homes, and its armies
reach about 4 more. On top of that, the colours were dealt out at the start. L1 and L3 are the hard walls; L4 is why
even the movement that does happen is hard to read.

## 3. How open-source 4X games handle it

All read from source; links are pinned to a commit.

| | Founding far away | Border growth | Forward bases | Distance cost |
|---|---|---|---|---|
| **Freeciv** (civ2civ3) | Settlers walk anywhere unclaimed or own. `citymindist` 3, **no maximum distance** ([game.ruleset#L827](https://github.com/freeciv/freeciv/blob/57f130ecac4db5dd89371c6891db15cc94641697/data/civ2civ3/game.ruleset#L827), [city.c#L1518](https://github.com/freeciv/freeciv/blob/57f130ecac4db5dd89371c6891db15cc94641697/common/city.c#L1518-L1531)) | City radius grows with size ([borders.c#L31](https://github.com/freeciv/freeciv/blob/57f130ecac4db5dd89371c6891db15cc94641697/common/borders.c#L31-L63)) | Fortress border claim: on in classic (`border_sq` 5), off in civ2civ3 ([terrain.ruleset](https://github.com/freeciv/freeciv/blob/57f130ecac4db5dd89371c6891db15cc94641697/data/classic/terrain.ruleset#L1993-L1996)) | Waste grows per tile of distance from the nearest gov centre; unhappiness grows with city count ([city.c#L3355](https://github.com/freeciv/freeciv/blob/57f130ecac4db5dd89371c6891db15cc94641697/common/city.c#L3355-L3377)) |
| **Unciv** | Settler founds anywhere not foreign. Min distance 3, **no maximum** ([Tile.kt#L687](https://github.com/yairm210/Unciv/blob/ffe8af9142a240c527162d1a82db596b0bdce517/core/src/com/unciv/logic/map/tile/Tile.kt#L687-L698)) | Culture buys tiles; the cost grows with tiles owned; tiles can also be bought ([CityExpansionManager.kt](https://github.com/yairm210/Unciv/blob/ffe8af9142a240c527162d1a82db596b0bdce517/core/src/com/unciv/logic/city/managers/CityExpansionManager.kt#L45-L104)) | Citadel claims the ring around it | −3 happiness per city ([CityStats.kt#L398](https://github.com/yairm210/Unciv/blob/ffe8af9142a240c527162d1a82db596b0bdce517/core/src/com/unciv/logic/city/CityStats.kt#L398-L407)) |
| **Widelands** | You can build **only inside your own land** ([player.cc#L558](https://github.com/widelands/widelands/blob/ed17072e0203b0718e882dc2acc686db0dab3a4d/src/logic/player.cc#L558-L578)) | Borders grow **only** from manned military sites, radius 6–12 ([militarysite.cc](https://github.com/widelands/widelands/blob/ed17072e0203b0718e882dc2acc686db0dab3a4d/src/logic/map_objects/tribes/militarysites/militarysite.cc#L673-L678)) | The core mechanic: a sentry claims radius 6 | Logistics only (carriers on roads) |
| **FreeCol** | Any colonist, anywhere settleable, not next to a colony ([Player.java#L3465](https://github.com/FreeCol/freecol/blob/29a78cdbd58da452fa928ad49a98e684a6ccbf18/src/net/sf/freecol/common/model/Player.java#L3465-L3473)) | Colony claims radius 1 ([specification.xml#L2973](https://github.com/FreeCol/freecol/blob/29a78cdbd58da452fa928ad49a98e684a6ccbf18/data/rules/classic/specification.xml#L2973-L2974)) | Forts defend only (not verified as a claim source) | None found |

Lessons:

1. Civ-likes have **no maximum distance from the capital**. The limit is the settler's walk and its danger, plus a
   smooth cost per tile or per city.
2. Widelands makes the frontier **walk**: you may only build inside your land, and land grows only from what you hold.
   Expansion is contiguous and readable at a glance.
3. Military sites that claim land (Widelands sentries, classic Freeciv fortresses) tie armies to territory.

## 4. Options considered

| Option | Verdict | Why |
|---|---|---|
| A. Raise `outpost_range` (e.g. 3 → 12) | Rejected alone | A larger fixed circle around home. Villages scatter inside it instead of spreading; the footprint still cannot move past the circle; the `未踏の印` goal (an ever-farther mark) stays out of reach on an infinite map. It also changes a rule every preset shares. |
| B. Civ settlers: a settler unit walks to the site and founds there | Rejected for now | The faithful port. But Wylls founds by a ticket and a lottery at turn end, not by a unit, so this needs a whole new on-chain lifecycle (transit, interception, a civilian unit in the clash) that would largely duplicate expeditions. It is far from minimal and fights the existing ticket model. |
| C. Wide land opens **neutral** (no nation holds its keep) | Not decided here: question for r0ze (Q-1) | The best fix for readability (L4): the map would start empty past the heartland, and every coloured province would be one a nation took. But it reverses owner decision ⑧ wide land (i), so it is not mine to change. |
| D. Let a player give up a village and found again (relocation) | Not decided here: question for r0ze (Q-2) | Over a long continuous world, three holdings per player caps how far a player's own villages can move. Relocation would fix that, but it is a new rule with balance effects (it might be abused to dodge sieges). |
| E. Culture: border growth over time | Rejected | Wylls territory is keeps, taken by armies, and the program has no per-province culture. A timer that recolours land would bypass the war design and the flag-keeps goal. |
| **F. Reach from the nation's land, plus land that opens where nations go, plus AI that pushes outward** | **Chosen** | Below. |

## 5. The design

### 5.1 The rule (on-chain, `0xD9` WideClaimSite)

A wide claim may name one more, read-only wide province: the **reach witness** (optional 13th account,
`frontier-abi/src/world_index/wide_ix.rs` `CLAIM_SITE`). If the witness is the claimer's **nation's land**, the outpost
rule measures the range from whichever is nearer, the first home or the witness. The witness is the nation's land when:

- **settled**: a village of *any* citizen of the nation stands there (the nation's strength weight in the province's
  site mirror is above 0; the share rule already reads the same weight), or
- **won**: its keep is held by the nation **and has been taken at least once** (`keep.changes > 0`). A keep the
  province opened with does not count. Otherwise the opening mosaic (L4) would give every nation reach almost everywhere.

A witness that is writable, not this world's wide province, not the nation's land, or out of range is refused before
any write (`BadAccount` / `OutpostRule`). Everything else in the outpost rule is unchanged: three holdings, slot order,
tier, heartland, the 50 % share rule (outposts go where the nation is not already dominant), the land gate, and the
settler cost paid from the first home. A claim without a witness is exactly the 12-account instruction it always was.

The pure rule is `frontier-abi/src/world_index/reach.rs` (`is_nation_land`, `claim_range`). The program
(`proc/wide.rs` `reach_witness_distance`) and the verifier (`vwl_wide_claims.rs`) call the same functions.

### 5.2 The map grows where nations go (local runner)

`frontier-node/crates/itest/src/wide_frontier.rs` is the local stand-in for the devnet keeper's on-demand opening. Every
turn it finds the wide land some nation has gone to (a village, or a keep taken at least once) and opens the absent wide
provinces within 2 of it, nearest first. It opens at most 3 a turn and 150 a world, using the program's own
permissionless WideOpenProvince. The setup now seeds wide rings up to 134, not 131, so land can open outward. The genesis
strip does not count as gone-to, so land appears only after a village or a capture. A quiet wide province costs the
world nothing per turn: the wide crank drives only provinces with hosts, arrivals or marches.

### 5.3 Players

The village screen's wide-claim card (`screens/holding.mjs`) now lists two groups:

- provinces near the first home (as before), and
- provinces reached **from your nation's land**, each showing which land it is reached from
  (「国の土地（P, Q）から」 / "from your nation's land (P, Q)").

The opened list is the herald's live record, so land the runner opens appears without a restart.

How a player expands:

1. Found a village beside your rim home (as before).
2. That village is now your nation's land. The card offers provinces up to 3 beyond it, and the runner opens new land
   around it.
3. Take a keep with an expedition or a wide march (72 turns). A **won** keep is your nation's land too: a forward base
   3 provinces deep.
4. Nation-mates' villages count as well, so a nation advances as a group. The frontier moves wherever its people go.

Where to go is now a real choice:

- **Outward**: toward unexplored rings and the `未踏の印` mark.
- **Sideways**: toward a neighbour's land and their flag keeps.
- **Stay and consolidate**: the share rule stops stacking, so a nation cannot pile villages onto one province.

A far village is exposed. It sits next to other nations' keeps and hosts, and its expeditions start far from home.

### 5.4 Operator AI (same rule)

`permutation-gateway/src/frontier/local-play-operator-expansion.mjs`:

- Residents read the live wide land (the page's own walk) and compute targets with the same reach rule.
- They rank targets by distance from their own home (push the frontier), plus half a point per step along their
  **heading**: outward, clockwise or counter-clockwise, by resident index, so a nation fans out.
- A province where the nation already has a village scores 3 points lower.

The policy files the claim with its witness (`local-play-operator-policy.mjs`). The AI keeps its two wide claims and two
wide→wide marches per village; with reach, those marches start from villages that are themselves farther out.

## 6. Disagreements and caveats (stated, not hidden)

- **With a naive Civ port.** Civ's "found anywhere you can walk to" is not what makes Civ maps readable. Unit travel
  makes that rule fair, and Wylls has no settler units; teleporting tickets with no maximum distance would scatter
  villages across the map. The contiguous-frontier rule (Widelands) fits Wylls's ticket model better, and it fits keeps
  (land is won by holding). So the design takes Widelands' "you extend from what you hold" over Civ's "anywhere".
- **With "the footprint moves" as a goal.** It mostly **grows**; it does not slide. The first homes never move, and a
  player has three holdings with no way to give one up. Over one session a nation visibly reaches 6+ provinces out (two
  chained villages, plus won keeps around them), where before the limit was 3. Over a long continuous world, the
  footprint moves only as new players arrive and keeps change hands. True relocation is Q-2.
- **Readability.** As long as wide keeps open in an interleaved mosaic (⑧ (i)), a nation's shape is partly hidden by
  colours nobody earned. Villages are drawn with their nation's sigil and new land appears at the frontier, which helps.
  Neutral wide land (Q-1) would help most.
- **Balance not touched.** No change to capture time (72), route length (4), combat, settler cost, or the economy. Reach
  extends where a claim may go, never what it costs.

## 7. Fit with the continuous world and the permanent goals

- **No seasons.** The rule reads only current state (who has a village; who holds a keep and whether it was ever
  taken). There is no end bell, and `outpost_close_bells` never applies in a continuous world.
- **Flag keeps (覇権).** Unchanged. They are judged on keep holders and `since_bell`. A won flag keep is now also a
  forward base, which makes contesting it worth more. Holding it is not made easier, because reach adds no garrison.
- **未踏の印 (unexplored mark).** Before this change the mark was **unreachable**: a village could never stand more than
  3 provinces from a first home, and first homes sit on the rim. Now a nation can chain villages and won keeps toward
  it. The proposal's note still applies: the land around a mark must be opened (on devnet a keeper duty; locally the
  frontier duty opens land next to villages and won keeps, not around a mark).
- **World-first tech, wonders.** Unaffected.

## 8. Devnet

This is an on-chain rule. The deployed devnet program does not have it, and the devnet page sends no witness (the card
offers reach only in local wide worlds). Bringing it to devnet means a program upgrade, which needs r0ze's decision; it
was not deployed. 12-account claims are byte-for-byte unchanged, so the upgrade would not break existing clients.

## 9. Questions for r0ze (blocked on r0ze; not implemented)

- **Q-1** Should wide land open **neutral** (no nation holds its keep until someone takes it), reversing ⑧ wide land (i)?
  This would make every coloured province earned and a nation's shape readable at a glance.
- **Q-2** Should a player be able to **give up a village** to found one farther out (relocation)? If so, with what
  cooldown or cost, so it cannot be used to dodge a siege?
- **Q-3** Should a won keep give reach to the whole nation (as built) or only to the citizens who took part in the
  capture?
