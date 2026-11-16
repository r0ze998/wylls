# One ordinary gap from ①–⑳, picked and fixed: the S1 tile card and the capture lock (Claude, 2026-11-16)

## Looked at first (read only)
- ⑭ central tower: its own README — "a proposal and verification record, not an adopted spec"; the tower is a picture only
  (no chain data), and the old design tied it to prize shares. No ordinary gap to fix without inventing rules: not touched.
- ⑨ capacity (borrowing a workshop): the `capacity-preview` feature, off by default; not adopted: not touched.
- ① national strategy: a local prototype with a proposed rule; not adopted: not touched.
- Existing S1 building rules (the ones ⑭'s notes point at: storehouses and structures on any passable tile): the page's
  pre-checks vs the program's refusals, rule by rule — site (Impassable/Site/Keep/Camp), Taken, StructureLimit/VaultLimit,
  StructureFull (12 entries, 2 forts), Insufficient: all mirrored. **One missing: CapturePending.**

## The gap
`proc/caravan.rs build_vault_as` and `proc/structure.rs build_structure_as` call `hold::own_province_unlocked` →
`capture_lock` → `CqError::CapturePending` while the village in hand's site is mirrored as the next generation's holding
(`frontier_abi::v2::prologue::capture_locked`). The page had the same rule (`fconquest.mjs capturePending`) and the
sentence (`fi18n` CapturePending), but `screens/s1.mjs s1TileModel` never used it: the card offered both builds and only
the send was refused.

## Fix and acceptance
- File: `permutation-server/web/frontier/screens/s1.mjs` (s1TileModel adds 'CapturePending' to the shared blocks).
- Acceptance: locked → vault and all three structures blocked with CapturePending, button disabled, the existing sentence
  shown (JA/EN); not locked → exactly as before; other blocks still listed beside it; the page rule = the Rust rule.
- Evidence: `permutation-gateway/test/web-frontier-s1-capture-lock.test.mjs` (Rust rule pinned as text: both builds take
  the lock, CapturePending, `state == STATE_HOLDING (1) && gen == holding_gen + 1` wrapping); with web-frontier-s1 and
  web-lang 52/52; ordinary-only subset 1765 tests, 1764 pass, 0 fail. Unit level; not seen in a world.

## Follow-up done (2026-11-16): the lock in every action pre-check
Program, per action (pinned as text in `web-frontier-capture-lock-actions.test.mjs`):
| action | lock | Province |
|---|---|---|
| Build, Train, Harvest (`holding.rs`, Harvest via `harvest_body`) | always | the village's own |
| Muster, Garrison (`host.rs lock_own`) | always | the village's own |
| FortGarrison (`structure.rs`) | always | the village's own |
| Explore (`holding.rs explore_as`) | only when the Scout stands in the village's own Province | the host's |
| Dissolve, Depart (`host.rs`) | only when the host's Province is the village's own | the host's |
| SendCaravan (`caravan.rs`) | only from a village source (a storehouse is not locked) | the source's own |
Muster, Garrison, Dissolve and Depart were found while checking (the first note missed `lock_own`): they go through the same
`actionBlocks` and are covered too. Page: `fland.mjs captureLocked` / `mirrorLocked` / `CAPTURE_LOCKED_ACTIONS` in
`actionBlocks` (the lock first, as the program orders it), `fconquest capturePending` on the same rule, the S1 caravan
source and fort form, and the controller's refusals before signing. Existing sentence (fi18n CapturePending), JA/EN.
Evidence: the test above 6/6; with conquest-state, s1 and s1-capture-lock 41/41; ordinary-only subset 1771/1770/0 fail;
screens map tap 5, block reasons 16, first session 2, conquest press 10, land/arrival 4. Unit/fixture only, not in a world.

## Next gap done (2026-11-16): the S1 fort form against FortGarrison's refusals
Audit of the S1 operations after the capture lock: SendCaravan's refusals (cargo, same place, wallet for another's place,
route) were already pre-checked. FortGarrison's were not: NotFinal (after the lazy flip), NotResident, StructureLimit (the
selected fort's room after pending troops) and Insufficient (reserve), in that order. Fixed in `screens/s1.mjs`
(fortBlocks, `fortGarrisonProblem`, `fortProblemText`) and the controller (before signing); `fi18n` texts for the form's
own codes. Evidence: `web-frontier-s1-fort-checks.test.mjs` 4/4; related + errors + lang 82/82; ordinary subset
1775/1774/0 fail. Unit/fixture only.
Not yet audited the same way: Raid, Seize (seizeOffer), Siege (siegeOffer), Expel, the nation proposals and votes.

## Raid / Seize / Siege / Expel audit (2026-11-16)
- Seize: one gap fixed — a fort with only pending troops counts as manned (structure.rs fort_troops = troops + pending);
  seizeOffer read troops only (integration cb88dcea; test web-frontier-s1-seize-fort). "No owner's host on the tile"
  (NotOnTile) needs the owner's villages, which the page does not hold: left to the program, as its comment says.
- Siege: NotFinal (source final; the lazy flip only in the target Province) and NotResident (target resolved) added
  (test web-frontier-s1-siege-ready; the S1/ws07 siege fixtures moved to a resolved target, expectations unchanged).
  Left to the program by design: the lead host (NotLead), protection/immunity, the target's generation (CapturePending
  for the target), NotBesiegeable/ReservedSite/TooLate.
- Raid: no gap — the program's decision window (RaidWindow: now_bell > raid_bell + RAID_DECIDE_BELLS) is the page's
  `open` flag (bell <= raidBell + RAID_DECIDE_BELLS), which disables both buttons.
- Expel: one gap fixed — an already expelled village was offered for expulsion (Propose KIND_EXPEL requires the target's
  expelled_since == 0); the page now reads the nation's expelled list (its holdings). With an older herald that names
  no holdings, the program decides. Test web-frontier-s1-expel-target.
- Proposals and votes: no gap — eligibility (join + 288, not expelled), the stance form (other nations, values 0–2 =
  stance_ok), slots (a proposal occupies its slot until settled: free() = not OPEN, the page counts state open), one
  open proposal per proposer, votes (open_at: now < close; voted once), readmission (the herald's `since` is a turn,
  the program's bell_of(since) the same).

## Village Build / Train / Harvest / Muster / Garrison audit (2026-11-16)
Beyond the capture lock (already done), the village actions' cost, slot and queue refusals against the page:
- Build, walls: one gap fixed. build_as → wall_item writes each walls order into one of the TWO wall items of the
  village's site mirror; an item is free once its effective bell is ≤ the province's resolved_next; both waiting →
  QueueFull. The page checked only the queue slots and the 1,200 cap, so a third walls order was offered and only the
  send was refused. `hud/rulebook.mjs` `wallItemsBusy` + buildOffers `mirror`/`resolvedNext`; `screens/holding.mjs`
  buildCards passes the village's own mirror (its province, site and generation); reason 'WallsBusy' (JA/EN).
  Integration ceba1d61, candidate merge d9e12b9d. Test `web-frontier-build-walls-items.test.mjs` 5/5; related 83/83
  (export) and 85/85 (candidate tree); ordinary subset 1789: 1788 pass, 0 fail, 1 skipped. Unit/fixture only.
- Build, buildings and promotion: no gap — queue slots by tier (enqueue QueueFull), one promotion at a time (QueueFull
  → the page's 'Promoting'), TopTier, Insufficient (pay), copy number (built above base + queued same resource + 1),
  more than 64 copies (catalog building None → BadData; the page's AboveCap). Not mirrored: the program's production cap
  (MAX_PRODUCTION_PER_HOUR 1,000/h → AboveCap), not reachable at prices the stores can pay before 64 copies.
- Train: no gap — train_v3 (n ≥ 1, unit trains, arms for the strong units), pay → Insufficient; the page's trainCost and
  its 30,000 limit match.
- Harvest: no refusal beyond ownership, live, the capture lock and finality, all already mirrored.
- Muster: one gap fixed. muster_as refuses with ProvinceFull when the village's own Province has 48 hosts standing or
  forming (entry states 1–2), 8 of the village's nation, or no free entry; the page did not check it. `fland.mjs`
  `provinceFull` + actionBlocks('Muster') after NotFinal/NotResident; the existing sentence (fi18n ProvinceFull, JA/EN).
  The free-entry part only on a full decode (56 entries); otherwise the program decides. Integration 3ba74174,
  candidate merge 228ec445. Test `web-frontier-muster-province-full.test.mjs` 4/4; ordinary subset 1793: 1792 pass,
  0 fail, 1 skipped. Unit/fixture only. Already mirrored: NotFinal, NotResident, CapturePending, the reserve (the
  drawer form is disabled when short; the hand says NoReserve below 100 musterable). Not re-audited in this round: the
  troop count's own 100–30,000 range per form, and the muster tile (passable, inside the Province).
- Garrison: NotFinal / NotResident / CapturePending mirrored. Open (next): the form does not check the Spearman reserve
  (Insufficient) or the garrison's room (30,000 after pending changes, TooLarge); the page holds both (reserve, the
  site mirror's garrison and pending items).
