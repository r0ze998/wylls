# Candidate worlds 2–4 (2026-11-15): from a refused gate to mint → transfer → JoinResident on the chain

LOCAL TEST CANDIDATE only: program [0x4C; 32], version 0xC804; not an allocation, never deployable.
- Loopback only; test keys only. No real wallet, no public chain, no real funds.
- Every world ran in a slot agreed with the territory owner (main CC) and ⑰, on my band: launcher 41920, world slots 41980–41989, mint 41996.
- Each world was stopped and checked down: no listener on 41900–41999 (41996 included), no world process, df printed.

## World 2: stopped by the launcher, `startup-failed:PrepareNotSettled`

- The herald now ran: it was built from this branch with `local-play-bootstrap` (extraction `79a75cad` plus the candidate pair `e50b3cc0`). Then:
  - the NFT setup ran (Core collection, InitConfig, the TEST sale, CreateResidentPolicy);
  - the mint page started;
  - the runner opened the destination province (`conquest_world` line).
- **Exact cause:**
  - The launcher's prepare-settle polls `GET /h/world/wide/route?at=P,Q` on the herald.
  - A herald built without `wide-world-experimental` answers that registered route with **`503 WideWorldUnavailable`**.
  - So "captured" never came, and the launcher stopped the world.
  - The page's gate then showed `data-phase="refused"`. The check waited out its 15-minute timeout; now fixed to fail at once with the gate's own words.
- **Fix:** the world herald is built with `--features local-play-bootstrap,wide-world-experimental` (`f88b5564`).
  - `local_play` tests: 10/10 (8 copied plus 2 exact-pair).
  - At `79a75cad` alone: default `cargo test -p herald --lib` 65/65, `local_play` 8/8.

## World 3: the world handed over; the check misread the gate's success

- The prepare step settled: destination (129, 0) captured, 716 chain seconds in 40 s wall time, back to 1x.
- The relay reported `[0x4C]`, `programVersion "51204"` and wallet B.
- The check waited for the gate to leave the DOM, but on success `flocalplay.mjs` only hides it (`root.hidden` in phase `connected`).
- Fixed: success now needs all of:
  - phase `connected`, and the gate hidden;
  - the game's dock visible;
  - the world relay's own `/gw/f/local-play/info` naming the candidate program, 51204, the Season and B.

## World 4: PASSED — start, mint, transfer, join

Screen (English, the page's own gate) and chain, public values only:

| Stage | Screen | Chain |
|---|---|---|
| start | gate `connected` and hidden, dock visible, relay pins [0x4C] / 51204 / B `4oHmApL8XCg38ynWNDRMqdD9kvLj7sbyrQLX4PKHEEzU` | — |
| mint | mint page: "Your pass is ready" | **MintResident** `5UisvTjwShVE3HX3iStBUrCuEuXuqPURnobUBrm852GbxdMK5AA3mZjhNpKhMSu8jT6VyD2MdvZdTdL5yu9rEAMh`, slot 125, ok; signed by A `CeiEnQPSnRg3jsNVtr2KmZ1qmUnfFjNHAh2d7UTGojLe` and the new asset key; resident program `0x50`; asset `2EvR2sUyWMd8QBPikt8gnqf96TNUe3pk2J3Wh54W6SfP` |
| transfer | the mint page's transfer screen: "Transferred (confirmed on the chain)" | **TransferResident** `3XDvosBaTkBmrWrH4CgMoAkyBK8iQ7ZpnJP5ZB8T5iKgJZ8WpzdZegYDE6roZtmskDt17owVZ3xPnKdGWofY9a7N`, slot 127, ok, signed by A (`0x51`). The asset's Core owner is now B, and the resident record `APJZLvaF…` is at **generation 1** |
| join | the village screen's candidate NFT card, nation chosen, "Join with this NFT", then the page plays as the NFT | **JoinResident** `wpdjQ4e2MUCydWScU1oWPusMJo7g56CjoCL4fRon1q8ngys6QNsTP6817kkj9PYPVufoLBQQMHvL216nTEQmUfk`, slot 135, ok, signed by **B**; candidate program `0xE1` with the compute-budget prefix. The NFT Citizen **`EpQKs22AFbC4gSY3tyHVYQsXr7FN4ymYNTdFistvBEXz`** exists, is owned by [0x4C] and carries this asset's resident mark; it is not B's own Citizen |

- The check printed `generation null` because of its own bug: the decoder's field is `gen`. That is fixed (`8bf4ff23`); the value read directly from the chain is 1.
- The page logged 12 `404` resource loads after the handover. They are not identified yet and did not block any stage; to look at next.
- This world is also the proof the herald pair `e50b3cc0` needed (herald `f88b5564`). The hashes are still to be agreed with the territory owner before that commit goes to canonical.

## Not done yet

- PlaceHome and Build as the NFT (0xE2 through the world relay): the check's `home` and `build` stages are written (`8bf4ff23`) and wait for the next agreed world.
- Train / Muster as the NFT; the march / territory (0xDD: only DeclareSiege's inner is a 0xDD player command); the pass sold away after play, with the old owner refused and the new owner acting (the page has no candidate transfer action yet).
- The 404 loads above.

## World 5 (2026-11-15): mint → transfer → join again; the first village is impossible in this preset (NoFreeHome)

Same band, slot agreed with the main CC and ⑰; stopped and checked down afterwards (0 listeners on 41900–41999 incl. 41996, no processes, df 23.21 GiB).

| Stage | Result |
|---|---|
| start | the gate `connected` and hidden, dock visible, relay pins [0x4C] / 51204 / B `HMsg5qEkrcFfS1zHQRAVQV3BBNZfcX1BUyxhQpcPC2vQ` |
| mint | MintResident slot 124, ok; asset `AaFD5r6spZpempUF9QFHQtVFkjYfbuN7FLvtqz58aXQq`; **generation 0**, asserted as a number |
| transfer | TransferResident slot 126, ok; owner B; **generation 1**, asserted |
| join | JoinResident (`0xE1` on [0x4C]) slot 134, ok, signed by B; NFT Citizen `AAAFVrVzjDf8xVCF3mSiaV1C9PSMuUejWdCzpJgusvDx` |
| home | **FAILED (timeout)**: the page said `NoFreeHome` right after the join (screenshot `3-joined.png`); no PlaceHome was sent |
| build / train / muster | **not reached, not proven** |

**Cause, measured on the live world before cleanup (not inferred from the screen):**
- The Season (decoded from `/h/season`): `heartlandMaxRing 3`, `genesisRing 3`, `placement 0`.
- The only opened province is the runner's home `(128, 0)`, ring **128**:
  - the runner's metadata says "opened by the REAL OpenProvince instruction";
  - its village was written by the runner (synthetic `Chain::set_account`), not by PlaceHome;
  - the herald's record has `rings: [{d: 128}]`, so `rings.length = 1`.
- The page's planner (`home.mjs`): `homeRingsOpen(season, 1) = 1`, and `homeSites` needs ring ≥ 2 and ring < 1, so no candidate exists.
- The program agrees: PlaceHome above `heartland_max_ring` is refused (ReservedSite). So the planner is right.
- Both Citizens (B's and the NFT's) are nation 0, so a nation mismatch is ruled out.
- **Not measured:** the free sites of `(128, 0)` (irrelevant to PlaceHome there, which the ring rule forbids anyway).
- **So:** in the conquest preset no newcomer (NFT or wallet) can place a first village. `NoFreeHome` is correct, not stale.
- What the preset needs, so a new player can join normally: an opened heartland province (ring 2–3) of the joiner's nation, created by the real OpenProvince. Proposed to the main CC: a candidate-only runner step that opens one, with nothing fabricated (the page's planner and PlaceHome decide). Not implemented.

**404s:** the page logged 404 resource loads in worlds 4 and 5, which are **not identified yet**. The check now records every 4xx/5xx by method, host and path (`summary.httpErrors`) for the next run.
