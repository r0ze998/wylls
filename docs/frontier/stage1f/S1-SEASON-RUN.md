# An S1 season played through the page by several players, with script bots and an AI fleet (2026-10-26)

Branch `s1/playable-season` (from PR #16 `integrate/s1-orders` merged with `main` d8007bd6). Local test chain
only (LiteSVM localnet, test-key beacon, test USDC over x402). Nothing here ran on devnet or mainnet.

## The worlds

| Run | Speed | Length | Who | What it was for |
|---|---|---|---|---|
| `s1-season-2` (season 74, base 41700) | 40x | 80 game hours, 480 turns | 4 people in separate browser origins (`p1`–`p4.localhost`, separate Dev Wallets, paid joins in test USDC), 6 script bots (`--s1`), an AI fleet of 6 driven through the brain by the **stand-in mind** (no model) | the whole season: economy, caravans, storehouses, raids, structures, sieges, votes, the end and the tally |
| `s1-normal-2` (season 75, base 41600) | 1x (one turn = 10 min) | 4 game hours | 1 person (`p5.localhost`) | the same transitions at normal speed: join, build, train, muster, a sealed march and its result |
| `s1-fix-1` (season 77, base 41500) | 40x | 12 game hours | 2 people of two nations | the fixes below, live, on the rebuilt program and herald |

Time compression: at 40x one turn lasts 15 s of wall time instead of 10 min, so a window of "6 turns" is 90 s. Every
rule and figure is the S1 preset's; only `--scale` differs. The normal-speed world checks that nothing depends on the
compression (sealing, arrival, the result report).

## What was played (s1-season-2 unless marked)

Every order below was sent from the page (its own action handler, its own form or tile card), signed by that
player's session key, and landed on the local chain unless it says refused.

| Order | Result |
|---|---|
| Join (paid, x402 test USDC), village, harvest, build, workshop, train, muster | four people, each in their own wallet; all landed |
| Sealed march to a camp, the battle report, "Verify in this browser" | landed; the browser's replay matched |
| Storehouse (BuildVault) | landed for two players |
| Caravan village → storehouse, storehouse → village | delivered by the keeper; the storehouse's stores in `h/caravans.json` |
| Seize a storehouse with a host standing on it (SeizeVault) | landed (12,024 CU); the herald's feed kept the old nation (fixed below) |
| Raid: a Borealis host on a tile an Astel caravan stood on at a turn start | the clash opened the raid (slot raid offset, raider = the host) |
| Raid decision: burn | landed within the window; the cargo never reached the storehouse |
| Raid decision: take | refused AccountBorrowFailed (fixed below); a take with no caravan road home is now refused by the page with the reason |
| Raid left undecided | the keeper's DefaultRaid failed 30 times for the same reason (fixed below) |
| Watchtower, palisade (BuildStructure) | landed; the tower's cover in the feed |
| Fort | not built: 800 stone, which no player reached; the page names the shortfall |
| Siege on a Borealis village (ring 2) with 500 gold and 50 arms | refused Heartland by the program; the page offered it (fixed below) |
| Stance proposal (Astel → Borealis: pass), 3 yes | passed at its close (turn 434); Astel's stance toward Borealis is 1 |
| A second vote by the same player | refused AlreadyDone |
| A vote by another nation's player | refused (BadAccount: no such proposal in that nation) |
| An expulsion while the proposer's own proposal is open | refused ProposalState; the page offered it (fixed below) |
| Expulsion proposed by another member, 2 yes 1 no | failed at its close (turn 444): 2 yes is below the quorum of 3; nobody expelled |
| Reload of a player's page mid-season | wallet, session key, village, proposals and own votes back as before |
| Season end and tally | the season ended at turn 480 and drained; Tally and Finalize landed; every nation held 9 keep provinces (nobody took a keep: the heartland keeps cannot be taken and no host went further), equal territory time (4,320 each): a six-way tie. Pool, chain and herald agree. The **estimate** under the provisional rules: equal split among the 4 paid members (nation 0: 3 × ≈13.33, nation 1: 1 × 40 test USDC); nothing was transferred. The first run of `prize-settle` said "refund" (fixed below) |
| verify and tamper on the whole season | `frontier-stack verify` PASS (58,287 transactions); `tamper` PASS, every required class detected, among them T49–T51, T53 and the votes' T55 (a vote counted twice) and T56 (a stance with no passed proposal) on the run's own records; T52, T54, T57, T28, T31, T39, T46 not applicable (no such record in the run) |

**s1-normal-2 (1x).** One person joined, built, trained 100 spearmen, mustered, and sealed a march (07:26 UTC, arrival
turn 7); at turn 10 (08:21 UTC) the host stood on the target tile with 100 troops and stamina 51.

**s1-fix-1.** A storehouse in the next province, a 13-step caravan to it standing at turn starts in both provinces
(runs in (2,0) and (1,1)), delivered; the other nation's host seized it and `h/caravans.json` names the new nation;
the herald's `badRecords` stayed 0; `frontier-stack verify` PASS (7,741 transactions) and `tamper` PASS with every
required class detected (T49, T50, T51, T53 among them).

**The AI fleet (stand-in mind, no model).** Six AI villages, one per nation, run by `frontier-bots --ai-slots` with
the brain calling `citizens/probe/mock-mind.mjs`. Every decision and outcome is in its JSONL log with `"mock": true`.
Over the season the stand-in answered 3,274 decisions; the sends that landed were 396 harvests, 170 builds, 94 trains,
159 musters, 3 departs and their 3 reveals (refused by the program: 27 trains and 3 musters, `WrongStatus` or
`Insufficient`, each backed off). The brain offered marches to camps (2,603), villages (837) and armies (237); it
never offered the S1 caravan, ambush or escort here: no AI village had a second place to send to, and no other
nation's caravan stood in a province an AI watched. Those three are covered by the brain's unit tests
(`bots/tests/ai_s1.rs`) only. It is a check of the brain's pipeline, **not** an AI result. The candidates the
brain offers under S1: build (with the workshop and an ore mine), walls, train, muster, march (camp, raid, field, call,
recall, ambush, escort), caravan. Not offered: storehouses, towers, palisades, forts, fort garrisons, raid decisions,
seizures, sieges, votes and proposals.

**The AI fleet with the model (`s1-model-1`, then `s1-model-2`).** `ai-citizens-run.sh` with
`stack/ai-cq-season.toml` (96 turns at 10x, the test-USDC prize path) and `config/smoke.json`: six AI citizens, one
per nation, on Gemma 4 26B A4B Q4_0 (ggml-org revision `bb4531cd`, sha256 `d208665a…`) and llama.cpp b11146
(`7fe450e19`, Homebrew), loopback only, measured into the run's commitments; the llama check passed against them.
In `s1-model-1`: 46 decisions by the model and 505 by the autopilot (the gate decides when the model is asked); the
fleet landed 6 joins and first homes, 48 builds, 27 trains, 21 musters, 10 explorations and 18 marches (all
model-chosen, all revealed), with no refusal; 3 ballots and 8 nation-hall posts. `verify-minds` PASS, `frontier-stack
verify` PASS (10,556 transactions), `tamper` PASS, the run report's failed transactions one keeper race. No person
joined, so the prize pool was empty and the estimate was a refund. The brain's sends were held back on 211 turns by
the relay's sponsored-transaction quota. The run showed the mind's prompt calling the S1 arms "horses"; fixed (the
brain now names the stores), and `s1-model-2` ran on the fix: the prompts read "arms 0", not "horses"; 45 model decisions, 6 joins and first homes, 49
builds, 26 trains, 20 musters, 10 explorations, 16 model-chosen marches (all revealed), 3 ballots, 16 hall posts, no
refusal and no failed transaction; `verify-minds`, `verify` (10,542 transactions) and `tamper` PASS. In neither run
did the brain offer the S1 caravan, ambush or escort (their conditions did not hold in 96 turns); the model was not
asked about storehouses, structures, raids or votes, which the brain does not offer.

## Faults found by playing, and fixed

1. **Program: a caravan standing in two provinces.** `province_links` read every listed province while an earlier
   run's was borrowed for writing, so SendCaravan, RaidCaravan (take) and DefaultRaid failed AccountBorrowFailed
   whenever the walk stood at turn starts in two provinces. The provinces are found first, then borrowed. New svm test
   `g13_s1_send_across_two_provinces_chains_both` (failed on the old build); seen working live in `s1-fix-1`.
2. **Program budgets.** The S1 settle (arms, ore, dormancy) made Harvest, Build and Train cost up to 32,371 CU against
   a 30,000 limit; `S1_SETTLE_EXTRA_CU` (+20,000) on the 14 instructions that settle first, measured in
   `g01_budget_s1_holding.rs`.
3. **Herald.** A seized storehouse kept its old nation in `h/caravans.json` (the vault's bytes now set it); every
   settled caravan's CLOSE was counted in `badRecords` (an M1 kind linking an S1 entity; now an event).
4. **Page.** A won raid's take-or-burn was only on a tile card the player was never sent to (now a to-do with its
   deadline that opens the card; the card says what happens if nobody decides); a held caravan was drawn on its way
   with an arrival long past (now at the raid's tile, tagged as held); a siege was offered on a heartland village and
   a proposal while the viewer's own was open (both now blocked with the reason); the S1 card did not show on an
   unsurveyed tile the viewer's own host stood on.
5. **Brain and stand-in.** The brain re-sent a refused intent every bell (now held back 6 bells); with every village's
   workshops eating its ore the AI could never train again (the brain now offers an ore mine first while arms are made
   and ore does not grow; see the balance note); the stand-in only marched on camps it could beat, which there were
   none of.

6. **Settlement estimate.** `prize-settle.mjs` knew the players only from achievement lines; with no keep taken it
   found no paid member and fell back to a refund. It now reads the pool's Entry accounts.
7. **Run report.** A keeper's late SettleProposal (the other keeper settled it first) is now the a/b race, not
   "unclassified". The 82 DefaultRaid AccountBorrowFailed in this run are fault 1 (the run's program predates the fix).

8. **The AI run's set-up.** `ai-citizens-run.sh` gave a conquest world's AI fleet `--conquest`, and the conquest stack
   configs gave the script bots the same: the MC budgets and no S1 candidates on a program that makes S1 seasons only.
   Both now use `--s1`. The mind's prompt named the S1 arms "horses"; the brain now sends the names.

## Balance found, not changed

A workshop uses 8 ore an hour against a village's base of 4, and every unit costs ore. A village that builds a workshop
before a mine can make arms but no longer train. These are [phase 6] placeholder numbers; the rules were not changed.
The page warns, the brain prefers an ore mine. Options for the owner: lower the workshop's ore use, raise the base
ore, or let units cost no ore below the strong tier.

## Not reached

- **A fort and a fort garrison**, live: no player gathered 800 stone. Covered by the svm tests.
- **A siege that runs**: the only enemy villages in reach lay in their owners' heartlands (refused), and the Free
  Cities hold 300 troops against hosts of 65–100. DeclareSiege and its progress are covered by the svm tests; in this
  run the siege tamper classes T28 and T46 were not applicable.
- **A raid taken home, live**: the take failed on the old program (fault 1); the fix is shown by the svm test and the
  two-province send in `s1-fix-1`, not by a take in a live world.
- **A readmission**: `READMIT_BELLS` (432) is longer than this season after an expulsion; nobody was expelled.
- **Seizing a structure** (no structure stood where an enemy host did).
- **The AI's S1 candidates with the model.** The model played two 96-turn S1 seasons, but the caravan, ambush and
  escort candidates were never offered in them; covered by the brain's unit tests only.
- **The page's caravans to another player.** The rules allow them; the page offers only the viewer's own places.
- **Public networks.** Nothing ran on devnet or mainnet; no real funds.
