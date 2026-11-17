# The first village's place drawn on the wide map: a provisional core and a test-only screen (2026-11-18)

**Branch:** `claude/home-draw-provisional-20261118` on the aggregate `0cc3ca30` (read only; nothing of it changed).
**New paths only.** No existing file is changed: not the controller, `home.mjs`, `confirmHome`, the join screens, the program, the herald, a profile or a world.

**Status: PROVISIONAL, NOT PRODUCTION, NOT ENABLED.** The first tip `6a4675fa` is corrected by the second `c8db35f1` and the third (below); adopt only the final tip, and only on the owner's word.
- **Written, NOT run:** no test, syntax check, import, page, herald, world, runner, signature, send or charge.
- **Not for automatic adoption:** Lane D aggregates it only on the owner's word.

## What the owner approved, and what this unit does with it

**The direction (2026-11-18):**
- joining puts the new village at a place drawn somewhere on the wide map of the existing world;
- nations are mixed;
- no new beginner shield;
- the map grows by exploration.
- The earlier options A, B and C stay on hold.

**This unit implements the draw as a provisional rule:** a place from the existing world key (the Season's `genesis_seed`) and the citizen key.
- **Reproducible only within a stated range (corrected):** each place's score is fixed by the world key, the citizen key and the place. The place drawn is the lowest score among the free places read. So the same world key, citizen key, candidate snapshot (which places the overviews and Province reads show free, taken or held) and parameters give the same place. When places are taken or freed, the map grows, or the parameters change, the same wallet in the same world can be drawn elsewhere.
- **Not a reservation:** nothing holds a drawn place, and nothing stops anyone from asking again.
- **Predictable:** anyone who knows the world key and reads the same map can work out any wallet's place before it joins.
- **Not resistant to many accounts:** wallets can be made until one lands where wanted.
- **Neither is solved.** Both are stated in the code and on the screen.

## What the existing world does (read, unchanged)

- **`geometry.rs` from line 434 (`home_nation`, placement 1):** placement 1 gives each heartland Province a nation. It is **not a personal random place**.
- **`proc/citizen.rs` `place_home_as` (from line 1247):** PlaceHome takes a place only when:
  - it is in rings `2..=heartland_max_ring`, below `rings_opened`;
  - its `home_nation` is the Citizen's nation;
  - the site is free or released (`home_site`);
  - the Province has no live ticket cohort.
- **So a drawn place outside the heartland, or of another nation, would be refused by the chain today.** The draw never says it would be accepted: `chainView` is `refused-by-rule` or `not-checked`, nothing else.
- **The existing protections are untouched.** These include the new village's capture shield (`shield_until`, lifecycle `shield_secs_for`). They are not a beginner shield and are not removed. No new shield is added.
- **Coordinates, terrain and fees are unchanged.** The draw reads places as the chain names them: `{p, q, site}`, the tile from the Province.

## 1. The core: `permutation-server/web/frontier/fhome-draw.mjs` (new)

Pure functions. No DOM, fetch, clock, randomness or storage.

**The score:** `placeScore` = `sha256("WYLLS-HOME-DRAW-PROVISIONAL-v0" ‖ genesis_seed ‖ utf8(citizen) ‖ 0x00 ‖ le32 P ‖ le32 Q ‖ site)`.
- **The lowest score among the free places wins.**
- **Candidates are sorted by score before anything is confirmed,** so the order rings or Provinces were read in never matters.
- **No nation filter.** The candidate step does not use `homeNation`, the wedge or a faction.

**The drawn rings** (`drawRings`): from `fromRing` up to the contiguous seeded rings (`contiguousRings`). `near` rings past the edge, up to `rMax` or the ceiling, are **shown only and never drawn**: there is no land there yet.

**The answers:**

| Answer | When |
|---|---|
| `assigned` | A place confirmed free by a Province read. |
| `full` | Every drawn ring is read, and **no candidate meets the provisional conditions** (the drawn rings, the density limit, opened Provinces). **It never says the map has no free place** (corrected in the third tip). |
| `unread` | A ring overview, the confirming Province, or a site or cohort state is not read. **Unknown is never free and never skipped.** The confirm reads can also run out on slots that do not exist. |
| `otherWorld` | An overview, a Province or the Season is of another Season, or names none. |
| `contested` | The places drawn first were taken since the overviews were read. |
| `held` | No world (cluster, program, Season, generation), no citizen key, no world key, no reader, or bad parameters. |

**The confirm:** sequential Province reads (`maxConfirmReads`).
- A taken site, a live cohort or a missing slot → the next place by score.
- A failed read stops with `unread`, so the answer never depends on which reads happened to fail.

**`siteNow`** follows the page's existing reading of `home_site` (`home.mjs` `homeSites`): state 0 or 3, and no cohort with `filed > settled` within `COHORT_BELLS` of its bell. An open cohort without the herald's turn is `unknown`.

**`recheck`** answers `free`, `takenSince`, `unknown`, or `otherDraw` (another wallet, world or generation).

**Provisional parameters (`PROVISIONAL_PARAMS`).** These are explicit, are not production values, and every answer carries them:

| Parameter | Value |
|---|---|
| `fromRing` | 2 (the existing first-home lower bound) |
| `nearRings` | 1 |
| `maxOccupiedBps` | 7500 (density: a Province with 75% or more of its 12 overview slots taken is not drawn into; an approximation, stated) |
| `maxConfirmReads` | 8 |

## 2. The screen consumer (new, test-only)

**`fhome-draw-view.mjs`:** the view state. It shows an answer only for the wallet and world it was asked for, and only the newest one.
- A late answer is dropped.
- Changing the wallet or the world clears what is shown at once.
- An answer naming another citizen or world is not shown.
- **Nothing is stored:** a reload shows nothing and asks again.

**`screens/home-draw.mjs`:** the card text (escaped, English only). It shows:
- the drawn place and its land's nation (nations are mixed);
- whether the current world would refuse the place, never "accepted";
- the limits, the rings past the edge, and map growth.

The play screen's banned words are kept out of the rendered text.

**`home-draw.html` and `home-draw-page.mjs`:** the test page.
- **Off unless** the page is on a loopback host (`config.mjs` `dev`) **and** its address carries `?provisional=home-draw`.
- **Not linked** from the play page, the controller or the app.
- **Reads only through the herald's GETs:** `/h/season`, `/h/overview/{ring}`, `/h/province/{P},{Q}`.
- **The wallet is an address typed in.** It is only the draw's citizen key and is never asked to sign.
- **It never imports or calls** the controller, `confirmHome`, PlaceHome, `fjoin`, `fplay`, the wallet, a signer or a sender. The normal join entry is not replaced.
- **Time is the herald's** `latestUnix` → `bellAt`, never this device's clock.

**No shared file is changed,** so there was nothing to send Lane C first.

## 3. Map growth, read only: `fhome-draw-frontier.mjs` (new)

`growthView` reads `proc/map.rs` `extend_frontier`'s conditions as far as the herald's season record and the decoded Season give them:

| Condition | How it is read |
|---|---|
| (1) ceiling above `rMax` | Read. |
| (2) every ring up to `rMax` opened | `ringsOpened === rMax + 1`. |
| (3) before the end bell | Read. |
| (4) a bell since the last opening | **Always not read:** the Frontier's `LAST_RING_OPEN_BELL` is not in the record. |
| (5) crowding | θ early or late by `latestUnix − genesisTs` against `thetaSwitchSecs`; `ringOccupancyMet` mirrors `ring_occupancy_met`. |

**The answer** is `none`, `unmet`, `maybe` or `unknown`. It is **never "will grow"**.

**Checked against exploration (finite, read only):** the existing Explore (`screens/explore.mjs`, contract §5.10) has a Scout explore tiles on open land, with finds. **It opens no ring.** No adopted rule links exploration to map growth.

**Not connected (stated in `NOT_CONNECTED` and on the screen; nothing is made up):**
- who sends ExtendFrontier or OpenRing, who pays, and any fee;
- any cost or cap beyond the program's ceiling;
- growth by exploration;
- any announcement.

## 4. Regression (written, NOT run): `permutation-gateway/test/web-frontier-home-draw.test.mjs` (new)

Fake overviews and Province envelopes in memory.

| Case | What it checks |
|---|---|
| D1 | Reproducible for the same snapshot and parameters, and independent of read order. |
| D2 | All nations are candidates; draws mix nations. |
| D3 | Unknown is never free. |
| D4 | Another world is refused, including another generation. |
| D5 | Full, and the density limit. |
| D6 | Taken places go to the next by score; all taken is `contested`; only absent slots is `unread`. |
| D7 | Cohorts. |
| D8 | The chain view never says accepted. |
| D9 | `recheck`. |
| D10 | The growth conditions. |
| D11 | Late, other-wallet and other-world answers are never shown; no storage. |
| D12 | The screen: escaped, no banned words, banner and limits. |
| D13 | The page as text: the gate, GET reads only, no join, confirm, signer or send, not linked. |
| D14 | The core as text: no clock, randomness, storage or fetch; sorted by score; no nation filter. |
| D15 | (correction) The page's requests: only the current Draw touches the page after each await; typing or a newer Draw ends it; each request has its own herald client and pin; a throw is its own failure; the view's `cancel`. |
| D16 | (correction) A changed snapshot moves the place; the texts claim no reservation and no sameness beyond the same snapshot and parameters. |

## Correction (second tip): the parent's review of `6a4675fa`

### 1. The page's requests

- **The defect:** the Draw handler awaited the season and the overviews with no request of its own. Only the view's own counter guarded the draw itself. An older Draw that finished late could still set the world and ask, over a newer Draw or a wallet just typed.
- **Now:**
  - each Draw takes a number when it starts, with the wallet typed at that moment;
  - typing in the wallet field, or a newer Draw, ends it (`current++`, and the view's new `cancel()` drops its answer under way without clearing what is shown);
  - after every await (season, overviews, draw), the request checks that it is still current, for the same wallet, before `herald.pin`, `view.setWorld`, `view.ask`, the failure note or the paint;
  - an ended request changes nothing, so an older answer or failure never replaces or clears a newer one;
  - **each request has its own herald client,** so no Season pin is shared between requests;
  - **a throw** is the request's own failure, shown (a fixed sentence) only while that request is current.

### 2. Reproducibility, stated exactly

- **The first tip said** the same world key and citizen key give the same place. **That was too broad.**
- **The score is fixed,** but the place drawn depends on the free places read and on the parameters.
- **Corrected in the core's header, its limits list, the screen's limits and its note, and this document:** the same place only for the same world key, citizen key, candidate snapshot and parameters.
- **No reservation and no protection against asking again** is claimed.

## Correction (third tip): the parent's review of `c8db35f1`

- **The defect:** the screen said "No free place in the open map right now" for `full`. That is a full map, but `full` only means no candidate met the provisional conditions (rings from 2 to the open edge, the 75% density limit, opened Provinces).
- **Now:**
  - the screen says no place meets this test draw's conditions, names them, and says this does not mean the whole map has no free place (`fullText`);
  - the core's two `full` reasons say "no candidate meets the provisional conditions … not a statement that the map has no free place";
  - the kind keeps its name `full`, documented as "no eligible candidate".
- **Unchanged:** the conditions, the draw, the chain view, and every other answer.

## Open (the owner's decisions; not decided here)

1. **Making the draw a rule the chain accepts.** PlaceHome's ring and nation checks would have to change. That is a program change, not done here.
2. **Resistance to many accounts, and unpredictability.** For example, a later random value at join. Not designed here.
3. **The near and density values,** and whether the overview's 12-slot density is enough.
4. **Growth by exploration:** its rule, cost, cap, who sends it, and any announcement.
5. **Localization of the screen,** and whether it ever moves into the join flow, which would need Lane C's controller.

## Hand-over (Lane D, NOT for automatic adoption)

Three commits on `0cc3ca30` (`6a4675fa`, `c8db35f1`, then the third-tip correction). Take the final tip's diff from `0cc3ca30`, all `100644`, all new (A):
- `permutation-server/web/frontier/fhome-draw.mjs`
- `permutation-server/web/frontier/fhome-draw-frontier.mjs`
- `permutation-server/web/frontier/fhome-draw-view.mjs`
- `permutation-server/web/frontier/screens/home-draw.mjs`
- `permutation-server/web/frontier/home-draw-page.mjs`
- `permutation-server/web/frontier/home-draw.html`
- `permutation-gateway/test/web-frontier-home-draw.test.mjs`
- `docs/integration/CLAUDE-HOME-DRAW-PROVISIONAL-20261118.md`
