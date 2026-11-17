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
- Garrison: one gap fixed. The form sent any number; garrison_as refuses n ≤ 0 (BadData), a short Spearman reserve
  (Insufficient) and, in GarrisonState::change, a change above the room (30,000 less the troops and the changes still
  pending, after the changes of turns before resolved_next are applied; HOST_TOO_LARGE). `fland.mjs` `garrisonRoom`,
  `screens/holding.mjs` `garrisonProblem`/`garrisonProblemText`, the controller before signing (not under the wide
  card: WideReadOnly answers first); texts BadTroops (own words), GarrisonFull (JA/EN). Without a reserve read or the
  village's own mirror the program decides. Its NotFinal / NotResident / CapturePending were already mirrored
  (actionBlocks, which disables the form). HostBusy (no pending slot) is not reachable once NotResident passes (the
  pending turns left are b−1 and b; the same turn merges). Integration 80c51b92, candidate merge edafa56b. Test
  `web-frontier-garrison-checks.test.mjs` 5/5; with wide-holding-ui, errors and lang 56/56; ordinary subset 1798:
  1797 pass, 0 fail, 1 skipped. (A first version also held the action's blocks and refused before the wide card's
  WideReadOnly — web-frontier-wide-holding-ui failed; narrowed before commit.) Unit/fixture only.

## Muster troop count and tile; Explore tiles (2026-11-16) — no refusal gap
- Muster troop count: muster_as → Host::muster refuses below 100 and above 30,000 (MIN/MAX_HOST_TROOPS, kernel
  HOST_TOO_SMALL/LARGE), a short reserve (Insufficient) and a Settler (NotAHostUnit). The drawer form's input is
  min 100, max 30,000, step 1 and the page's submit handler runs only after the browser's validation (app.mjs
  `submit` listener); the button is disabled when the reserve is short (musterShown). The hand's draft clamps to
  100…min(30,000, reserve) (hud/hand.mjs musterDraft). Settlers are left out of both lists (reserveOf, f.reserve
  filter). No gap.
- Muster tile: the program needs a tile inside the Province (< 61) and passable. The drawer sends the village's own
  tile (a site: passable by construction, permutation-rules terrain.rs); the hand offers only passable tiles of the
  own Province (musterTiles). No gap.
- Explore tiles: the program takes 1–2 distinct tiles within one hex of the host (its own tile included) and not yet
  explored; the page offers the passable neighbours not yet explored (exploreTargets). No refusal gap.
- Stricter on the page than the program (not changed; for the owner, since loosening would be a design choice):
  musterTiles leaves out tiles with 6 hosts standing or forming ("six to a tile": clash slots per tile, clash.rs
  §6.1; muster_as has no per-tile limit); exploreTargets leaves out the host's own tile and impassable tiles.

## Key-free check of two fix tests (2026-11-16) — static boundary read; guarded run REFUSED, nothing ran
Test runs were stopped after a key-using test (web-frontier-local-play-return) had been run, and the ordinary subset
was found to include 15 key-using and 78 possibly key-using files (list in CLAUDE-PC-PLAY-FIXTURE-GAPS-20261116 notes,
scratchpad list). This step concerns only web-frontier-build-walls-items and web-frontier-muster-province-full.
- Static read (import closure, own read-only script; relative static imports and literal dynamic imports): 118 / 52
  files; external specifiers only node:test, node:assert/strict, node:fs; no non-literal dynamic import.
  - Key API names: the vendored noble BLS12-381 / weierstrass files, reached only through seal.mjs `sealMarch`'s
    `import('./seal-worker.mjs')` (called when a march is sealed; neither test calls it); map/tilt.mjs `Math.sign`
    (not a key). Neither test file names a key API.
  - Network: `fetch` only inside herald.mjs `createHerald` and people/leader-art.mjs `holdArt` (walls test's closure
    only), neither called by the tested functions (buildOffers, wallItemsBusy, buildCards, whyText; actionBlocks,
    provinceFull, errorText).
  - Processes/workers: none started (seal-worker's top-level block is guarded by WorkerGlobalScope and not loaded).
  - Import-time effects: callback registrations (fstate onLangChange → invalidate, leader-sprite onArtWanted), table
    set-up in sdk/base58 and sdk/bytes, lang.mjs's browser-only block. `setLang` writes `globalThis.localStorage`
    (absent in Node 20: nothing written) and marks renderers dirty (none registered in these closures).
  - Restricted-area words (session, resident, …) occur in loaded modules' definitions; the tested functions do not call
    them. Reads of repository Rust/ABI files are local text reads.
- Guarded run: `bash scripts/ci/node-keyfree.sh permutation-gateway <the two files>` from the single export (the
  export's scripts/ci, web and the two tests byte-identical to the integration worktree; no WS*_ROOT/RUNEXEC set).
  REFUSED at its first step, the scanner's --check: exit 5, `scripts/ci/node-key-reviewed.txt`: 10 "stale review"
  entries (the reviewed closure hashes of other test files no longer match — e.g. web-frontier-map-arrival,
  -growth-route, -viewport, -overview-queue, -free-city, -land-bounds, -large-chart, -want-province,
  -viewer-own-citizen, workstreams/06-creation connect-live). Also printed: "fatal: not a git repository" (the export
  has no .git; the scanner walked the files). No test started; not a success. Not retried; the list, the reviews and
  the guard were not changed; no direct node run. Whether today's page edits caused the staleness: not confirmed.
- How far the fixes are confirmed key-free: the 2026-11-16 normal-game fixes (capture lock, fort, seize, siege, expel,
  walls items, Muster ProvinceFull, Garrison) were tested only by unguarded node runs earlier today; none is confirmed
  under the key-free runner. The static boundary above covers the walls and Muster tests only.
