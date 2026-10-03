# Wylls: technical demo script (3 minutes or less)

**Date:** 2026-10-03 · **Length:** 178 s planned, hard limit 180 s · **Language:** English only, on screen and in narration · **Audience:** engineers (judges). Base game: real recordings. AI council block: planned, recorded only after AI citizens are built; until then it stays a diagram. The pitch video (2 minutes) is a separate piece.

> **Status card text (verbatim, first and last frames):** Local test chain only (never devnet or mainnet) · no outside person has played yet · every number comes from tests, rule-bot runs, the Gemma 4 spike or simulation · AI citizens are designed, not built [AS-BUILT: pending] · money, governance and markets are not built.

## Labels on screen

| Label | Where | Text |
|---|---|---|
| **Banner, variant A (AI citizens built and recorded)** | first 3 s, last 3 s, and fixed over the whole AI block | "Local test chain — not devnet or mainnet — AI citizens are labelled — Gemma 4 runs locally". In the council block add "— the presenter is the operator" (contract §9.4). The council page draws its own banner when the chain is local; it cannot be hidden |
| **Banner, variant B (AI citizens not built at the freeze)** | first 3 s, last 3 s | "Local test chain — not devnet or mainnet — AI citizens: designed, not built yet". Never show variant A without the built, recorded AI block |
| Corner, replay, verifier and load shots | S5, S6, S10 | "Local test chain · rule bots" |
| Corner, single-player shots (recorded on a fresh one-player stack, not the 1,000-bot season) | S2 to S4 | "Local test chain · scripted player" |
| Corner, clock | S2 to S4 | "Clock at 20x" (state the real scale of the recording; change the label if it is not 20x) |
| Diagram caption until built | S7 fallback, S9 | "AI citizens: designed, not built yet" |
| AI badge | every frame that shows an AI actor | the AI badge of the council page (contract G9); no badge, no shot |
| Results card | S8 | "[AS-BUILT: pending]" in the draft; replaced by the run id, commit and numbers after the run, never before |

Narration is spoken at about 2 words a second. If a generated voice is used, say "Narration: synthetic voice" in the first or last frame and in the video description.

## Shot list and script

| ID | Time | Picture | Narration (English) | Type | Source |
|---|---|---|---|---|---|
| **S1** | 0:00-0:12 | Status card, then the repo map: rules kernels, program, off-chain crates, web client (from `docs/DESIGN-OVERVIEW.md` §4). Banner first 3 s | "Wylls is a shared strategy world on Solana. It has run only on a local test chain, and no outside person has played it." | planned-diagram | `docs/DESIGN-OVERVIEW.md` §4 |
| **S2** | 0:12-0:30 | Join: on the local chain with the page's built-in dev wallet (a random key kept in the browser; the in-game key is derived from that wallet's signature), one choice, the nation; the village is placed; the first bell. Caption: "One choice: your nation. Your first village is placed for you." | "You make one choice: your nation. The client places your first village. It appears at the next bell, about eleven to twenty-one minutes later, in our model." | real | play-flow recording, English run, fresh stack (the recorder is not in this repository) |
| **S3** | 0:30-0:52 | Queue a farm; send a scout; seal a march. The composer shows "The destination is inside the seal: others see only the arrival bell". Caption: "Sealed marches: destination hidden until the bell" | "A farm takes ninety minutes of game time. Then a sealed march: everyone sees where it left, how large it is and which bell it arrives in. The destination is time-locked to a drand round and opens at the arrival bell." | real | same recording, build, explore and march steps |
| **S4** | 0:52-1:12 | The bell resolves; the clash report; "verify in this browser" turns green. Caption: "Every clash is checked in your browser" | "At the bell, everything that arrives in a province fights one simultaneous clash, seeded by drand. The report checks itself: the rules kernel re-runs in WebAssembly and matches the chain's record." | real | same recording, bell, report and verify steps |
| **S5** | 1:12-1:24 | Season replay of `m1-exit`: seven days in about twelve seconds, villages and clashes per nation, bell by bell. Caption: "7 game days, 1,000 rule bots, local test chain". No conquest on screen | "One exit season: seven game days, one thousand rule bots, replayed bell by bell. No conquest yet; villages are not captured." | replay | season replay of `m1-exit` (the replay page is not in this tree) |
| **S6** | 1:24-1:42 | Terminal: verifier PASS over 144,300 transactions; tamper table 30 of 30 detected; the criteria pass table | "The replay verifier read all 144,300 transactions and passed. We then tampered with the record thirty different ways, and it caught all thirty. It is our own verifier; anyone can run it." | real (recorded output) | `docs/frontier/m1/runs/m1-exit/` (`verify.md`, `tamper.md`, `criteria.md`) |
| **S7** | 1:42-2:07 | **AI council block.** The council page: AI citizens with badges, names and public cards; banner fixed. The Conqueror AI moves option X with a speech; the Diplomat AI argues against; the presenter's seat casts a ballot; "Call adopted ... target sealed". Caption: "AI citizens: always labelled as AI" | Written after the recording, from what the page shows. Draft: "Now the part we are adding: AI citizens, always labelled, under the same rules and limits as people. Code offers three targets. One AI proposes, another argues back, a human votes. The adopted target stays sealed until the strike bell." | planned (real after built) | `council.html` on the AI run (contract §9.4); recorded only after build |
| **S8** | 2:07-2:19 | Results card: valid choices, fallbacks, latency, injection suite, A/B pairs, `verify-minds` verdict; run id and commit on the card. Draft shows "[AS-BUILT: pending]" in each cell | Written from the run record only: "On the local test chain, [N] AI citizens made [X] decisions: [valid] valid, [hijacks] hijacks in the injection suite, [pairs] valid A/B pairs." Never a number without a record | planned (real after the run) | the run's `PUB` files and `verify-minds.json`; contract §9.3, §10 |
| **S9** | 2:19-2:32 | Architecture: program, keepers, herald, relay, verifier, bots; the AI layer as a dashed box (contract diagram). Caption: "AI citizens: designed, not built yet" (until built) | "One program on chain judges. Keepers, herald, relay and verifier pay, move, show or check, but none can change a result. AI citizens would use the same relay as a person." | planned-diagram | `docs/DESIGN-OVERVIEW.md` §6 "Where the AI layer sits"; Appendix A |
| **S10** | 2:32-2:42 | Spectator page; caption: "5,000 simulated viewers (a load generator), 0 errors in 3.46 million requests" | "Five thousand simulated viewers, from a load generator, not people: zero errors in three point four six million requests." | real | `spectate.html` or the load record in `runs/m1-exit/` |
| **S11** | 2:42-2:55 | Limits card (text) | "Limits. Local test chain only. No human has played. Devnet is unverified. Conquest is not merged. Money, governance and markets are not built." If AI is not built, add: "AI citizens: designed, not built yet." | planned-diagram | `docs/DESIGN-OVERVIEW.md` §1, §8 |
| **End** | 2:55-2:58 | Status card, repo link. Banner last 3 s | none, or "Narration: synthetic voice" if applicable | card | |

Total 178 s. If time runs over, cut S10 first, then shorten S5. Never cut S6, the banner, the AI badges or the limits card.

**Fallback if AI citizens are not built or not recorded by the freeze (2026-10-12):** replace S7 and S8 by one 25-second diagram shot of the decision loop (the code offers up to 12 legal options, the model chooses, the code checks, a rule autopilot plays if anything fails; `docs/DESIGN-OVERVIEW.md` §6.1) with the caption "AI citizens: designed, not built yet", narration "AI citizens are designed, not built yet. The code offers legal options, a local model chooses, the code checks the choice, and a rule autopilot plays if anything fails.", and use banner variant B. The video then runs about 166 s.

## Recording rules for the AI block (contract §9.4)

1. A live run of the AI configuration with the presenter, or the main run's second day. Record only the council page unless the AI badge has shipped in the main client.
2. Every frame that shows an AI actor shows its badge. Check on the finished cut.
3. No wallet or key text on screen. Test keys are derivable from a public seed; do not describe them as secret.
4. Keep the run's `PUB` files and `verify-minds.json`; cite run id and commit on the results card and in the video description.
5. Say only what the claims list allows after the run (contract §12.2): labelled, same rules, code offers, model chooses, code checks, autopilot; measured figures with run id and commit. Report every run, aborted ones too.

## Must not appear (on screen, in narration, in captions)

- **Claims:** devnet or mainnet for Wylls; a human playtest, registration, waitlist, demand, traction or revenue; money, prizes, payouts, USDC, token, play to earn; AI indistinguishable from humans, hidden, stronger than people or the rule bots; exact replay of every AI decision; thousands of AIs per machine (state only the estimate with its assumptions); AI earns money; "5,000 viewers" without "simulated"; "1,000 players" (they are rule bots); "ran on Solana" without "local test chain"; the 85 audit findings fixed; lines of code or commit counts as quality; conquest, keeps or sieges as working.
- **Words:** say nation, village, hamlet, bell, AI citizen, Wylls. The old terms to search for are in the checklist at the end.
- **Footage:** any trailer, clip or still of the earlier prototype; any recording with the old names burned in; any frame that shows the old words "faction" or "holding"; any person or character of the earlier prototype (Hypatia, Aoi, and Aster the character; the nation Aster on the map is fine); AI-generated illustrations presented as game footage.
- **The earlier prototype** is not in this video. If one line is needed, speak it once: "Our earlier prototype, a different game, ran a full season on Solana devnet (rules v8, season 1790355636798) and re-verified 14 of 14 checks." Show no footage.

## Footage fallback

If the play-flow recording is not ready, capture `practice.html` and `spectate.html` on this tree for S2 to S4, label them so, and say in the description that they are not a full play-through.

## Before recording and before publishing

1. Record on a fresh stack built from this tree, on free ports in 41000 to 41999.
2. Search the finished frames, captions and subtitles for: faction, holding, Shade, Permutation, Sixfold, 六重, tick, devnet, mainnet, USDC.
3. Check that every number on screen is in the allowed list: 7 game days; 1,000 bots; 13 profiles; 1,712 marches settled once, 0 stuck; 144,300 transactions verified; 30 of 30 tampers caught; "5,000 simulated viewers"; 3.46 million requests, 0 errors. Anything else needs a record.
4. Disclose synthetic narration and any generated visuals in the video and its description. Illustrations are labelled "AI-generated illustration" and are never shown as game footage.
5. Put the status line, the repository link and (after the AI run) the run id and commit in the video description.

**Links:** [README](../../README.md) · [SUBMISSION.md](../../SUBMISSION.md) · [PITCH.md](../../PITCH.md) · [design overview](../DESIGN-OVERVIEW.md) · [AI citizens contract](../frontier/ai-citizens/AI-CITIZENS-CONTRACT.md) · [exit run record](../frontier/m1/runs/m1-exit/)
