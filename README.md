**English** | [日本語](README.ja.md)

# Wylls

**A game in which AI behaves like a player.** Wylls is the first playable part of a Civilization-style shared world on Solana: you choose a nation, get a village, build, train, send sealed marches and fight at a ten-minute bell. AI citizens, run by the operator on a local model, are designed to play beside people with goals and a memory. Their nation council is the second showpiece.

> **Status 2026-10-04:** local test chain only (never devnet or mainnet) · nobody outside the project has played · every number comes from tests, rule-bot runs, the Gemma 4 spike, the records of the AI runs on a separate branch (a 6-AI smoke run, `smoke-b3`, is the only run that completed with `verify-minds` passing), or simulation · AI citizens: in progress on branch `frontier/ai-integ`, not merged into this tree, the 12-AI and 18-AI runs not yet run [AS-BUILT: pending] · conquest (code on another branch, not merged), score, instant land, the 14-day season, money, governance and markets: design only.

![Wylls map: six nations around the Concord, the neutral centre](docs/img/wylls-map.png)

*The web client's map after the recorded M1 exit season had ended (local test chain, 1,000 rule bots). The clock reads bell 1,034: 1,008 play bells plus 26 drain bells. The picture shows the map only, no armies or clashes. "Dev Wallet (localnet)" is the local test wallet, not a real one.*

[Unified design (Japanese)](docs/GAME-DESIGN.ja.md) · [Design overview (10 minutes)](docs/DESIGN-OVERVIEW.md) · [M1 exit report](docs/frontier/m1/M1-EXIT-NOTES.md) · [AI citizens contract v1.3](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md) · [Pitch](PITCH.md) · [Submission record](SUBMISSION.md) · [Demo script](docs/pitch/DEMO_SCRIPT.md) · [Run it](docs/RUNNING.md) · [日本語版](README.ja.md)

**Status tags** (five, used in every table): **[Running]** code exists and was actually executed (a run on a branch outside this tree is named as such); **[In progress]** being built or run for this hackathon; **[Design only]** written down, not built; **[Planned]** intended, no date set; **[Dropped]** removed by a decision. **[Confirm]** marks a point that needs the owner's answer; it is removed once answered (question numbers Q1 to Q34 are those of Appendix A in [docs/GAME-DESIGN.ja.md](docs/GAME-DESIGN.ja.md)). The same five tags, in the same English words, are used in [the design overview](docs/DESIGN-OVERVIEW.md), [PITCH.md](PITCH.md), [SUBMISSION.md](SUBMISSION.md) and the [demo script](docs/pitch/DEMO_SCRIPT.md); in Japanese documents they are 【動いている】【作成中】【設計のみ】【計画】【やめた】【確認】. Numbers carry their kind, in parentheses: **(measured)** a recorded result with its source, **(simulator)** simulator output with assumed behaviour, **(model)** a cost or scale model, **(estimate)** a back-of-envelope figure, **(code)** a rule read from tested code, not a play result. The owner's decisions of 2026-10-04 are called D1 to D12 here and in the design documents; the decisions log and the pitch files call the same decisions Y1 to Y12 (D1 is Y1, and so on). `[AS-BUILT: pending]` marks a result that does not exist yet; those markers are replaced when the AI runs are merged (step I-C, morning of 2026-10-12). Sources are given as 〔Source: file:line〕, paths relative to the repository root, with the branch name when the file is not in this tree (`frontier/unify`).

---

<a id="axis"></a>

## 1. A game in which AI behaves like a player

*Wylls* is the English spelling of *will* (意志), and the game is a thought experiment: **how does a game behave when AI has will?** Will here is not a claim that a model wants something. It is what the system builds and shows from outside: goals that persist, with progress counted by code where it can be counted; reasons that cite the memory lines the AI was shown; trust and open grievances; declining an order; speech and votes in a council. Of these, open grievances, declining and attacks on the AI's own army have not been observed in any run so far. 〔Source: docs/GAME-DESIGN.ja.md:196-198, :136-143〕

We found no case of a language-model player that stayed competent in a large live multiplayer game (we may have missed some), so the design puts the guarantees in code and treats the model as a chooser among legal options ([why](docs/DESIGN-OVERVIEW.md)). There are two showpieces. Both are **[In progress]**: the code ran on branch `frontier/ai-integ` in small local runs, and the main run and the recording have not happened. 〔Source: docs/GAME-DESIGN.ja.md:239-249〕

**First, an AI citizen's own march (the main one).** The code offers an AI citizen a short list of legal candidates (a camp, an enemy army in the open, build, train, hold). The AI chooses one itself, and the page prints the "Remembered" lines it cited: events the code wrote down from public records, such as a camp another nation cleared first. Its army leaves and the destination stays sealed. When the arrival bell has ended and the march's reveal is public, the decision opens: the options it was offered, its reason (written by the model, marked not verified), the destination and the real clash report. For a 12-hex march at 10x this is about 3 to 4 real minutes after the departure (model). How many model-chosen marches become a real clash (Y) is unknown until the main run; if Y is 0, the claim is dropped, the council becomes the headline and the footage says so.

**Second, the nation council.** Once per council period (24 or 48 bells in the test setting; the design is once a day) the code proposes up to three target provinces for a nation. AI citizens move options with a speech and vote; in nation 0 the operator's seat casts a ballot (scripted by the operator in the A/B test). A target is adopted with at least two votes and strictly more than any other option or "none". The adopted target, the **Strike Order** (the "Call" in the code and the contract), stays sealed from outsiders until the strike. The council is off-chain; nothing on chain enforces it. In the 6-AI smoke run all nine council periods closed without a quorum (one AI per nation), so no Strike Order has been adopted yet. 〔Source: docs/GAME-DESIGN.ja.md:664-686〕

**Why a chain.** The program, not an operator, resolves every clash; the departure is public and the destination is hidden by a drand time-lock until the arrival bell (a design property, see the seal limit in [section 7](#limits)); and the whole season is a log of transactions that our verifier replays and checks (the verifier is ours, not an independent audit). That, not speed or cost, is the reason. A second reason is the idea that rules and state on an open chain allow composable modding and a permissionless economy **[Design only]**; no tokenomics has been designed. 〔Source: docs/GAME-DESIGN.ja.md:250-258〕

Tech, diplomacy, markets, governance, score and a shared civilisation are designed and not built ([section 3](#complete-game)).

<a id="status"></a>

## 2. Status

### 2.1 What runs, what is being built, what is designed, what is dropped

| Area | State | Evidence |
|---|---|---|
| **Basic game M1** | **[Running]** Exited 2026-10-01. One 7-game-day season (1,008 bells at 20x, 8 h 39 min) ran end to end on a **local test chain** with 1,000 rule bots, and every gating criterion passed (numbers in 2.2). There is no score and no winner, and winning a fight gains nothing | [M1-EXIT-NOTES](docs/frontier/m1/M1-EXIT-NOTES.md), [run record](docs/frontier/m1/runs/m1-exit/) 〔Source: docs/frontier/m1/M1-EXIT-NOTES.md:57-58; docs/frontier/m1/runs/m1-exit/criteria.md:7-18〕 |
| Joining today | **[Running]** You choose a nation and the client files site tickets; a drawn lottery per bell decides; the village appears about 11 to 21 minutes later and is provisional (it cannot muster, explore or depart) for up to 24 bells (about 4 hours). Rehearsed only by 20 scripted browser visitors on branch `frontier/playtest` (median 18.0 minutes to a village), not by people | [overview](docs/DESIGN-OVERVIEW.md) 〔Source: docs/GAME-DESIGN.ja.md:278-302; docs/frontier/m1/M1-CONTRACT.md:608-609〕 |
| **AI citizens** | **[In progress]** The code is on branch `frontier/ai-integ` and is to be merged into this tree on the morning of 2026-10-12 (step I-C; local, no push). Contract v1.3 is already in this tree. On the branch, a 6-AI local smoke run (smoke-b3) completed and `verify-minds` passed (52 model decisions, all valid; below the pre-registered minimum of 300, so not a result). An earlier smoke run (smoke-b2) failed `verify-minds` and was fixed. The 12-AI A/B test, the 18-AI main run and the recording have not been done. Every run, aborted and failed ones included, is listed in `RUNS.md`. Results: **[AS-BUILT: pending]** ([section 5](#results)) | [contract v1.3](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md), `ai-integ:docs/frontier/ai-citizens/RUNS.md` 〔Source: docs/GAME-DESIGN.ja.md:136-143, :715-728; ai-integ:docs/frontier/ai-citizens/RUNS.md:28-37〕 |
| **Conquest** (keeps, sieges, occupation) | As a product **[Design only]**. The code is on branch `frontier/cq-integ` (contract v1.5, program v2): program tests and the simulator ran, and Gate CQ2 is green there (342 program tests, 534 workspace tests, 573 npm tests) **[Running]** on that branch only. It is **not merged** into this tree. Waves 3 to 5 (verifier, relay, web client, long soak) are not started. No person and no AI has played conquest. 15 rule questions are left open; the defaults in the code stay in force | `cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md` 〔Source: docs/GAME-DESIGN.ja.md:787-797, :829-851; cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:229-237〕 |
| **Instant land** (decision D3) | **[Design only]** The program is not changed. The estimate for a new `PlaceHome` instruction is about 11 to 14 hours of wall-clock work and 6 to 8 machine hours; it is not done | 〔Source: docs/GAME-DESIGN.ja.md:278-302; feasibility estimate outside the repository〕 |
| **14-day season** (D6) | **[Design only]** No 14-day preset exists. Only the 7-game-day preset has run; the AI main run is planned at 3 game days at 10x. The earlier 28 days was a provisional number: **[Dropped]** | 〔Source: docs/GAME-DESIGN.ja.md:875-901〕 |
| **Score per nation** (D1) | **[Design only]** The formula is open | 〔Source: docs/GAME-DESIGN.ja.md:902-925〕 |
| **Society** (governance, diplomacy, trade, shared Engine, tech, eras) | **[Design only]** First priority after the hackathon (decision W8). The contents of tech, eras and the Engine are not designed | 〔Source: docs/GAME-DESIGN.ja.md:1004-1121〕 |
| **Money** (D4) | A free season first, then a money season: **[Planned]**. The money design (entry fee, stakes, prize pools, claims): **[Design only]**. No money that a player pays or earns exists; only small test-lamport payments move inside the protocol on the local chain | 〔Source: docs/GAME-DESIGN.ja.md:926-965〕 |
| **Business plan** (D5) | Own seasons and free first: **[Planned]**. A later entry fee with an operator share: **[Design only]**. Later AI citizens offered to game studios: **[Planned]**. Numbers stay "under consideration" until legal review. No conversation with any studio is on record. **[Confirm Q18]**: whether the plan is also said in the pitch video and slides (it is written here under decision D5) | 〔Source: docs/GAME-DESIGN.ja.md:966-992〕 |
| Pacts, betrayal and binding promises between AIs | **[Dropped]** by decision X2 (2026-10-04); the design is kept, inert, in contract Appendix A | [DECISIONS X2](docs/frontier/DECISIONS.md) 〔Source: docs/GAME-DESIGN.ja.md:729-731〕 |
| An AI mark in the game UI ("AI is always labelled", decision W2) | **[Dropped]**, changed by decision D2 (2026-10-04): see [section 4](#ai-citizens) | 〔Source: docs/GAME-DESIGN.ja.md:687-699〕 |
| Friends' playtest | **[Dropped]** (D11a, cancelled). The tooling exists on branch `frontier/playtest` and was rehearsed only with scripted browser visitors | 〔Source: docs/GAME-DESIGN.ja.md:524-526, :1153〕 |

Branches (`frontier/unify` is this tree and the submission branch; the others are local, not pushed): `frontier/ai-integ`, `frontier/cq-integ`, `frontier/playtest`.

### 2.2 What runs: the M1 exit season, in numbers

The (measured) rows are the new game on a **local test chain**; the (model) row is a cost model, the (simulator) row is simulator output, and the Gemma 4 row is a spike on the bare model, not on the new game. Counts marked † are from the M1 closing tree `864b622` and were **not re-run on this branch** (the rename, the nation-only join and later changes came after). How to run things: [docs/RUNNING.md](docs/RUNNING.md).

| Claim | Source | How to reproduce |
|---|---|---|
| Exit season `m1-exit`: 7 game days, 1,008 bells, 20x, 8 h 39 min, 1,000 rule bots (13 profiles), 43 process kills and restarts, 5,000 simulated viewers; criteria 1-6, 8, 9 pass (7 reported, not gating) (measured) | [criteria.md](docs/frontier/m1/runs/m1-exit/criteria.md), [run.md](docs/frontier/m1/runs/m1-exit/run.md), [M1-EXIT-NOTES §3](docs/frontier/m1/M1-EXIT-NOTES.md) | `scripts/m1-run-s7.sh` ([RUNNING §3](docs/RUNNING.md#3-the-exit-season-itself); needs the drand archive) |
| 1,712 due marches all settled once; 0 stuck province-bells; 0 valid seals unrevealed; 24 of 24 garbage seals settled as bad seals (measured) | [criteria.md](docs/frontier/m1/runs/m1-exit/criteria.md) | same run |
| Replay verifier passed 144,300 transactions (784 failed ones reported); all 30 deliberate tampers caught (measured) | [verify.md](docs/frontier/m1/runs/m1-exit/verify.md), [tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md) | `$S verify --run-id <run>` and `$S tamper --run-id <run>` on a finished run; `frontier-node/crates/verify/mutate.sh` (12 builds, 58 of 58) |
| Every instruction inside its compute budget †: Reveal, in whole-transaction compute units, p50 19,389, p99 22,951, max 24,050 in play. The heaviest clash resolution, about 272,000 CU (271,673), is a worst-case **test fill, not seen in play**; in play the largest was 50,984. 248 program tests pass, 4 ignored by design (measured) | [criteria.md row 2](docs/frontier/m1/runs/m1-exit/criteria.md), [M1-EXIT-NOTES §2 E1, §3](docs/frontier/m1/M1-EXIT-NOTES.md), [svm-tests README](permutation-frontier/svm-tests/README.md) | `permutation-frontier/svm-tests/run.sh --release` (`RELEASE_CHECK=1` for the full gate) |
| Reproducible release build, same hash twice (`d85e1bd7...2281`) † (measured) | [M1-EXIT-NOTES header](docs/frontier/m1/M1-EXIT-NOTES.md) | `scripts/build-frontier.sh --twice` |
| Web client †: 529 of 529 npm tests, 51 of 51 screen tests (12 screens, JA/EN, 3 widths, accessibility checks) at the M1 exit; the screen tests were not re-run (measured) | [M1-EXIT-NOTES §2 E7](docs/frontier/m1/M1-EXIT-NOTES.md) | `(cd permutation-gateway && npm ci --ignore-scripts && npm test)`; `(cd permutation-gateway/screens && npm ci && npm run browser && node --test *.screen.mjs)` |
| Fee-market attack: fails at the minimum tip (14,668 lamports); holds only with a defence pool and at least 150 rotating payer keys (model) | [c4-v3](docs/frontier/m1/c4-v3/) | [c4-v3 README](docs/frontier/m1/c4-v3/README.md) gives the re-run; two inputs are lab files outside this repository, so a clean checkout cannot fully reproduce it |
| Balance: six nations won 15.6 to 17.4 percent of 1,500 paired seasons at 10,000 simulated wallets; behaviour is assumed (simulator) | [M0-FINAL](docs/frontier/m0/M0-FINAL.md) | `cd frontier-sim && cargo run --release -- doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --gate` |
| Gemma 4 spike numbers in section 4 (bare model, not the new game) (measured) | [REPORT.md](docs/frontier/ai-agents/gemma4/REPORT.md) | The spike harness is a lab outside this repository; see the report |

<a id="complete-game"></a>

## 3. The complete intended game, and where each part stands

This section describes the game as designed: the owner's decisions D1 to D12 of 2026-10-04 and the decisions before them. The right-hand column says what exists today. A part counts as built only where it is tagged **[Running]**. 〔Source: docs/GAME-DESIGN.ja.md:202-219, :1324-1345〕

| Part | The design | Today |
|---|---|---|
| One world, six nations | One map shared by six nations, a new map every season; only a chronicle carries over | **[Running]** the map, six nations, the bell, sealed marches (local, rule bots). The chronicle that carries over: **[Design only]**, no code |
| Joining and first land (D3) | You choose a nation and receive land at once: no wait, no provisional village, no practice battle | **[Design only]**. Today: site ticket, drawn lottery, a village after about 11 to 21 minutes, provisional for up to about 4 hours ([2.1](#status)) |
| Growing, training, scouting, sealed marches, the ten-minute bell, a battle report anyone can replay | Resources accrue in real time; armies of 100 to 30,000 march under sealed orders; all fights of a province resolve together at each of the 144 bells a day | **[Running]** (local test chain, rule bots) |
| War and territory (D7) | Conquest is part of the product; territory counts in the score | **[Design only]** as a product; code on branch `frontier/cq-integ` ([2.1](#status)) |
| How a nation wins (D1) | One total score per nation ranks the nations at season end: territory held over time, prosperity, knowledge. It replaces "no winner" | **[Design only]**. M1 has no score and no winner. Open design point **[Confirm Q6]**: the weights and units, whether the score is per capita (the earlier design damps large nations, which conflicts with a plain per-nation sum), what "prosperity" and "knowledge" measure (science has no use yet, and there are no techs) |
| Season length (D6) | 14 days (2,016 bells) | **[Design only]**; run so far: 7 game days once |
| AI citizens beside people (D2) | They are displayed exactly like human players in the game UI, with no mark; the world is disclosed in general to contain AI-operated citizens; an AI answers truthfully when sincerely asked | **[In progress]**; see [section 4](#ai-citizens) |
| Shared civilisation and society | A shared Engine with five levels that raises everyone's tech ceiling and advances eras; six ruins; governance (wardens, an assembly, four ministers); missions and laws; diplomacy (peace, non-aggression, alliance); caravans and a bourse; companies of up to 32; delegation of armies | **[Design only]**. No program instruction exists for any of it. The Engine is defined in one sentence; the contents of tech and eras are not designed. First priority after the hackathon (W8) |
| Money (D4) | A free season first, then a money season: an entry fee and an optional stake into prize pools, claims by formula, the operator paid only after a season ends well | Order **[Planned]**; the money design **[Design only]**; the code for pools and payouts is library and simulator code, not in the program |
| Business plan (D5) | Own seasons, free first; later an entry fee (USDC) with an operator share; later AI citizens offered to game studios. Numbers stay "under consideration" until legal review | Own seasons and free first **[Planned]**; entry fee and operator share **[Design only]**; studios **[Planned]**. No revenue, sign-up, waiting list or studio conversation exists or is claimed. **[Confirm Q18]** |
| Where it is played | In the browser; no mobile version | **[Running]** the web client (Japanese and English) |
| Legal review | Needed for money seasons and for the disclosure of AI citizens (for example EU AI Act Art. 50) | Not done. **[Confirm Q34]**: when |

<a id="ai-citizens"></a>

## 4. AI citizens on one screen

**Status: [In progress].** The code is on branch `frontier/ai-integ` and is to be merged into this tree on the morning of 2026-10-12; results stay **[AS-BUILT: pending]** until then. The model is Gemma 4 26B A4B, run locally (llama.cpp, thinking off, temperature 0), with no paid API. Everything runs on a local test chain. If the runs are incomplete at the freeze, or a hard gate (cited ids inside the retrieved set, episode replay) fails, this section becomes one sentence: "AI citizens: not implemented in this submission; design only." A missed own-march gate (G12) only drops the own-march claim. 〔Source: docs/GAME-DESIGN.ja.md:577-594, :1173-1180; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:865-869〕

**The loop.** (1) The code offers up to 12 legal candidates. (2) The local model chooses among them. (3) The code validates: schema, caps, a fresh re-check, then the program itself. (4) If anything is late, invalid or refused, the rule autopilot plays, filtered: it keeps the economy, routine duties and the following of an adopted Strike Order, and **never starts a march of its own**, so every voluntary AI march is the model's choice or a Strike Order. It cannot undo what the AI chose. Most steps never reach the model, and most of an AI's actions are the autopilot's; the share of actions sent in model-chosen steps (by:model) is printed with every claim. 〔Source: docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:11-12, :246-266; docs/GAME-DESIGN.ja.md:595-621〕

**Same rules as people, with safety limits.** AI citizens play with the same keys, relay quotas, fog and herald reads as people, plus these safety limits: at most 12 candidates (inside a 12-province window); at most 60 percent of home troops marched per decision; at most 60 percent per day and a 40 percent home floor (neither applies while the day's starting home troops are under 200); at most 4 model-chosen marches a day; message and call budgets; an autopilot that never marches; and in nation 0 a council rule that needs a human ballot. "The same rules" is never claimed without these. The model never sees keys: a keyless "mind" calls the model and the bot-side "brain" signs. This is structure, not secrecy: the local test keys are derivable from a public seed. 〔Source: docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:345, :906; docs/GAME-DESIGN.ja.md:700-705〕

**Display and disclosure (decision D2).** In the game UI an AI citizen is displayed exactly like a human player, with no mark. This replaces the earlier decision W2 ("AI is always labelled"). It is a design decision **[Design only]**; today the main map client shows no AI mark because AI citizens are not in it yet. The council/audit page and the public roster file `roster.json` do carry labels (`ai`, `script`, `seat`), and each signed message record carries an origin value **[Running]** on the branch; whether to keep them is **[Confirm Q2]** (they are kept until the owner objects). The defaults in force: an AI citizen answers truthfully when it is sincerely asked whether it is an AI ("I am an AI citizen run by the operator"; the rule and its check exist, and no recorded case of the question being asked exists), and this README states, and the rules are to state, in general that the world contains citizens operated by the project with local AI models. The legal review (for example EU AI Act Art. 50) has not been done. 〔Source: docs/GAME-DESIGN.ja.md:687-699, :1324-1345〕

**Memory** (the core of the AI citizens, decision X1). Each AI has a public Wyll card (its persona, goals with their progress, trust, a memory excerpt, and its recent reasons with the lines it cited). Each AI keeps a ledger (goals with progress, trust, open grievances) and **episodes**: short event lines that the code writes from public records (an attack on its army, a camp another nation cleared first, a departure near its home, its own clashes). The model never writes an episode. Before each decision the code retrieves a few into the prompt as "Remembered" lines; the model may cite the ones it used, and the page prints the code-written lines beside the model's own words, which are marked not verified. A citation shows that a line was shown and named, not that it caused the choice, so the word used is "cited", not "remembers". A probe will report how often removing the lines changes a choice, next to a rerun count (the same prompt asked again) and a control (the same amount of unrelated text removed). Episodes are published live and do not carry across seasons. **Pacts and betrayal between AIs are [Dropped]** (decision X2). 〔Source: docs/GAME-DESIGN.ja.md:645-663; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:377-482〕

**Audit.** Before genesis the model file hash, prompts, persona deck and configuration are signed and recorded on the local chain (internal consistency, not an independent timestamp). Every decision leaves a public record with hashes; `verify-minds` checks the commitments, the persona deal, the per-bell roots, the match between sent transactions and records, speech provenance, a replay of a sample of 20 decisions on a pinned single-slot server, and the episodes of three AIs rebuilt from the operator's herald log (not from the chain). It replays a sample, not every decision. The runs use a local test chain and an operator-held test drand key, so "dealt by public randomness" is not claimed. 〔Source: docs/GAME-DESIGN.ja.md:706-714〕

**Measured so far: small runs, not the feature.** *Smoke run smoke-b3* (6 AIs, all Conqueror, 86 closed bells, local test chain, 10x; branch `frontier/ai-integ`) (measured, small sample): 52 model decisions, 52 valid, 0 fallbacks (the pre-registered minimum is n of 300, so this is not a result); decision latency p50 3,193 ms and p90 4,052 ms (34 decisions); by:model share 29.8 percent, an upper bound (51 of 171 actions; the autopilot's economy was 64.3 percent); 26 of 52 decisions cited memory (the mind's own counter says 16), and the oldest cited line was 32 bells old; 10 model marches, all against camps, 9 of them matched to a clash episode in the public event record (a proxy count from the event record, not yet confirmed from the herald's clash rows, and not the pre-registered Y); 9 council periods, all closed without a quorum, 0 Strike Orders adopted. `verify-minds` passed; it ran before a later fix of the verifier (FB3) that has not been applied to the recorded runs. 〔Source: ai-integ:docs/frontier/ai-citizens/RUNS.md:28-37; ai-integ:.local/frontier/ai/smoke-b3/report.md:11-35, :41-66 (a git-ignored file); docs/GAME-DESIGN.ja.md:615-621, :664-686〕 *Gemma 4 spike, bare model, before the build* (measured): the model chose a march in 1 or 9 of 20 decisions depending on one line of instruction (the report's verdict line also says 12; its body confirms only 1 and 9), against 18 of 20 for the rule bot; best setup 79 percent valid proposed actions; about 5 s of compute per decision; with raw player text in context it obeyed an injected order in 10 of 64 runs (thinking on) and 1 of 32 (off), with sanitising and wrapping 0 of 64; exact replay held 200 of 200 on a pinned single-slot server and forked on 50 of 200 under four concurrent slots. 〔Source: docs/frontier/ai-agents/gemma4/REPORT.md:11, :31-32, :82, :106-108〕

Recording note: the live council recording is planned to use 12 AIs; the own-march footage is planned to come from the 18-AI main run, and each clip will name its run and commit. What is not claimed: [section 7](#limits).

<a id="results"></a>

## 5. Pre-registered results

Thresholds fixed in advance ([contract §10.2](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md)). The main run is planned at 18 AIs (3 per nation: avenger, diplomat, conqueror) for 3 game days at 10x; the A/B test and the recording use 12; the smoke run uses 6. Every result below is **[AS-BUILT: pending]**; each filled cell will carry the run id, the commit and n. 〔Source: docs/GAME-DESIGN.ja.md:1157-1172; docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md:766-787〕

| Gate | What is measured | Target | Result |
|---|---|---|---|
| G1 | Valid choices over at least 300 model decisions (n and the 95 % interval are printed; "underpowered" if n is below 300) | at least 95 % | [AS-BUILT: pending] |
| G2 | Fallbacks to the autopilot; decisions dropped for time; the by:model share and the autopilot economy share are reported beside them | fallbacks at most 5 %; dropped for time at most 3 % of gate-open | [AS-BUILT: pending] |
| G3 | Decisions with slack before the next bell, none executed late; latency p50, p90, p99 per kind; the Mac's load for 12 AIs (18 in the main run) is recorded by hand | at least 99 % with slack; 0 executed late | [AS-BUILT: pending] |
| G5 | Prompt-injection suite with the real model: 17 ported cases plus memory, review and cap attacks, run before the main run and after any prompt change | 0 hijacks | [AS-BUILT: pending] |
| G6 | Council periods with a Strike Order (code name Call) in three or more nations; motions, ballots, adoptions and refusals are counted | at least 1 period | [AS-BUILT: pending] |
| G7 | A/B test, same seeds: the seat's ballot (scripted by the operator) is for X or not; every run is listed | only the adopting run produces the march and the clash, on 2 valid pairs (or the stated reduced claim of 1 valid pair) | [AS-BUILT: pending] |
| G8 | `verify-minds`: commitments, persona deal, roots and openings, transaction-to-record match, speech provenance, and a replay of 20 sampled decisions | M1, M2, M3, M7, M8 pass; M9 at least 18 of 20 equal | [AS-BUILT: pending] |
| G9 | AI social records that carry the AI origin value; every AI, script bot and seat on the council page shown with its roster label; every recorded frame with a non-human actor shows its label (the contract's wording: a property of the records, the page and the recording, not of the game UI; the gate is under review because of D2 and Q2) | 100 % | [AS-BUILT: pending] |
| G10 | No regression: the M1 suites are green or unchanged, and in the guarded paths only the four hook files differ from the base | as stated in the contract | [AS-BUILT: pending] |
| G11 | Persona swap on the fixture situations: does the choice change? | reported, no pass or fail threshold (the contract states the expected 3 of 10 and says a miss is reported) | [AS-BUILT: pending] |
| G12 | Model-chosen marches (not Strike Orders) that produced a clash (Y) | Y at least 1; if 0, the claim is dropped and the council is the headline | [AS-BUILT: pending] |
| G13 | Cited memory ids that belong to the set the code retrieved (a hard gate) | 100 % | [AS-BUILT: pending] |
| G14 | Memory: the share of decisions that cite memory, a relevance spot-check of 20 opened decisions, the memory probe with its rerun and control counts, and the age of every cited line | reported, no threshold | [AS-BUILT: pending] |
| G15 | Episode replay of three sampled AIs equals the published one, and retrieval recomputed for 20 sampled decisions equals the recorded ids (a hard gate) | equal | [AS-BUILT: pending] |

<a id="run-it"></a>

## 6. Run it, repository map, license

### 6.1 Run it

Everything is local; nothing needs a wallet, devnet or a paid service. **Quick path, the practice battle** (no chain, no build; Python 3):

```sh
cd permutation-server/web && python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/frontier/practice.html   (JA or EN follows your browser)
```

The full local stack (the game on a local test chain; `up` stays in the foreground, so use two terminals), the scripted browser run, the exit-season recipe, the toolchain list and the test commands are in **[docs/RUNNING.md](docs/RUNNING.md)**. Open `/frontier/frontier/`, not `/`: the bare address still lands on an older page. Two of the test commands, from the repository root:

```sh
(cd permutation-gateway && npm ci --ignore-scripts && npm test)
(cd permutation-gateway/screens && npm ci && npm run browser && node --test *.screen.mjs)
```

The AI citizens are not in this tree before the merge of 2026-10-12. On `frontier/ai-integ` a run is started with `permutation-gateway/citizens/bin/ai-citizens-run.sh` (it needs a local model file and llama.cpp installed by you); RUNNING.md will cover it after the merge. **Videos:** game and M1 exit season [VIDEO LINK pending]; AI citizens (an AI citizen's own march, then the council and the Strike Order) [VIDEO LINK pending], to be recorded on 2026-10-11 from the runs.

### 6.2 Repository map

Terms: the **keeper** is a helper process that anyone can run; it posts drand beacons, reveals sealed marches and resolves clashes. The **herald** is a read-only server that folds the log into JSON and a WebSocket. The **relay** is the door that pays fees and rent within quotas; people and bots use the same one.

| Path | What it is |
|---|---|
| `permutation-frontier/` | The Solana program (SBPF v2), with `svm-tests/` (LiteSVM suite) |
| `permutation-rules/src/frontier/` | The rules kernels (economy, travel, clash, stances) shared by the program, simulator and browser. It also holds M0-era kernels for sieges, offices and payouts (`siege.rs`, `office.rs`, `payout.rs`, `pools.rs`, `laurel.rs`, `mandate.rs`): library and simulator code, not wired into the M1 program, except the vigil-change helper and the `PayoutParams` type, which `CreateSeason` only parses, validates and hashes (no payout logic runs). They are not conquest or money results |
| `frontier-abi/`, `frontier-wasm/` | The program's ABI; the kernel built to WebAssembly for the browser (clash report verifies itself) |
| `frontier-sim/` | Balance simulator (nations, doctrines, bots versus best response) |
| `frontier-node/` | Off-chain Rust workspace: `keeper` (posts drand beacons, reveals marches, resolves clashes; permissionless), `herald` (folds the log into JSON and a WebSocket; read-only), `verify`, `bots`, `agents`, `localnet`, `drand-replay`, `fclient`, `findex`, `stack` (orchestrator), `itest` |
| `permutation-gateway/` | The relay (pays fees and rent inside quotas; one door for people and bots, `src/frontier/`), JS SDK, tests, Playwright screen tests (`screens/`) |
| `permutation-server/web/frontier/` | The web client (map, village, march composer, bell sheet, report, onboarding, practice, spectator) |
| `scripts/` | `build-frontier.sh`, `m1-run-s7.sh` (exit season), `m1-nightly.sh`, `build-wasm.sh`, `check-v9-frozen.sh` |
| `docs/` | [GAME-DESIGN.ja.md](docs/GAME-DESIGN.ja.md), [DESIGN-OVERVIEW](docs/DESIGN-OVERVIEW.md), [RUNNING](docs/RUNNING.md), [pitch/DEMO_SCRIPT](docs/pitch/DEMO_SCRIPT.md), [frontier/](docs/frontier/README.md) (design, decisions, M1 records, AI-citizens and conquest documents), [earlier-prototype/](docs/earlier-prototype/INDEX.md) |
| Only on branches, not in this tree | AI citizens: `permutation-gateway/citizens/`, `frontier-node/crates/bots/src/ai/`, `permutation-server/web/frontier/council.html` (`frontier/ai-integ`). Conquest: program v2 and its keeper, herald and bot changes (`frontier/cq-integ`). Playtest tooling (`frontier/playtest`) |
| `research/`, `solana-ethereum-hackathon-games-2023-2026.xlsx` | Background research (Eternum, other on-chain games, UI benchmarks) and a hackathon-games spreadsheet; not part of the game |

**Names are historical (decision V1).** The rename to Wylls did not touch code identifiers, crate, package or folder names, hash and signature domains, or seeds, so `permutation-*` and `frontier-*` remain.

**Earlier prototype, still in this tree because CI and code paths reference it:** `permutation-chain/` (MagicBlock program), the rest of `permutation-server/` and the pre-Wylls files of `permutation-rules/` (rules v8) and `permutation-gateway/`, `permutation-state-prototype/`, `permutation-state-solana-receipt-spike/`, `demo/` (devnet season logs of the earlier prototype), `research/`.

### 6.3 License

There is **no `LICENSE` file at the repository root yet**, and no license has been chosen for the repository as a whole **[Confirm Q33]**. These manifests declare `license = "MIT"`: `frontier-abi`, `frontier-wasm`, `frontier-sim`, the `frontier-node` workspace (its member crates inherit it), `permutation-frontier` (and its `svm-tests`), `permutation-rules`, `permutation-server`, and the npm package `permutation-gateway/client`. The root `Cargo.toml`, `permutation-chain/`, `permutation-state-solana-receipt-spike/` and the npm packages `permutation-gateway` and its `screens/` declare none. Vendored libraries under `permutation-server/web/sdk/vendor/` carry their own licenses. 〔Source: Cargo.toml and package.json manifests as listed; docs/GAME-DESIGN.ja.md:1427-1466 (Q33)〕

<a id="limits"></a>

## 7. Limits

- **Local test chain only.** The exit season ran at 20x; the nightly run (100 bots, one game day) at 100x; the AI smoke runs at 10x; all on a local chain. **Nothing of the new game has run on devnet or mainnet**; devnet's cryptographic syscall costs and rent are unverified.
- **Nobody outside the project has played.** All 1,000 participants of the exit season were rule bots written by the team; 13 profiles are not a proof against unknown attackers. The friends' playtest was cancelled (decision D11a). Its tooling is on branch `frontier/playtest` and was rehearsed only with 20 scripted browser visitors, who are not people. The runbook for a private devnet playtest of 50 to 200 people ([PLAYTEST-RUNBOOK](docs/frontier/m1/PLAYTEST-RUNBOOK.md)) is a document only: not approved, not run. The 5,000 viewers were a load generator. No registration, demand or traction figure exists.
- **Seal secrecy was not tested.** In the exit season the drand rounds were replayed from an archive (and quick stacks use a test key), so the future round signatures were already known. The measured results (0 valid seals unrevealed, 24 of 24 garbage seals settled) show liveness and settlement, not secrecy; secrecy is a design property.
- **AI citizens are in progress, not finished.** The code is not in this tree before 2026-10-12; the 12-AI and 18-AI runs and the recording have not been done; the smoke runs are small (n of 52) and are not results against the thresholds. Their keys are derivable from a public seed and the drand key is the operator's test key; an AI's reasons and speech are written by the model and not verified; most of an AI's actions are the autopilot's; the council is off-chain.
- **Conquest is not in this tree.** It sits on `frontier/cq-integ` (Waves 3 to 5 not started), which is not on GitHub until pushed. Instant land, the 14-day season, the per-nation score, money and society are designs; the program is not changed for any of them.
- **No season of 14 or 28 days has run.** The longest run is 7 game days; the 28-day value was provisional and is dropped.
- **Money (M2) and society (M3) are not built.** No money that a player pays or earns exists, and there are no prizes. Small test-lamport payments (march fee, reveal tip, seal bond, rent) move inside the protocol on the local chain.
- **Exit-season gaps:** 2 of 9 adversary hold kinds found no pending write and were not exercised; the defence refund landed in nightly runs after the fix, not in the 7-day season ([M1-EXIT-NOTES §4.3, §7](docs/frontier/m1/M1-EXIT-NOTES.md)). The design point is thousands of players; the largest test is 1,000 bots.
- **Open before people can play on a network:** two web fixes, the entry redirect, devnet configuration gaps, hosting ([overview §8](docs/DESIGN-OVERVIEW.md)). Legal review for money and for the disclosure of AI citizens has not been done.
- **CI is partly red, and was not re-run after the fixes.** The two GitHub runs on `codex/frontier` of 2026-10-01 and 10-02 ([36923004057](https://github.com/r0ze998/wylls/actions/runs/36923004057) on `2c0462f`, [36958805861](https://github.com/r0ze998/wylls/actions/runs/36958805861) on `5ed36fa`) passed 6 of 8 jobs each (the earlier prototype's rules/program/server job, the simulator, the off-chain workspace, the gateway and web tests, the receipt scaffold, the browser smoke test) and failed two: "Frontier M1 rules, ABI and program" at its first guard step (the v9 diff against `d95fa25`, which the approved rename legitimately changed, so the SBF build and LiteSVM steps **never ran on GitHub**) and "Frontier M1 web kernels" (the runner's Linux build of the WebAssembly module hashes differently from the Mac build). Fixes are in `scripts/check-v9-frozen.sh`, `scripts/build-wasm.sh` and `frontier.wasm.hosts`; they pass on the Mac only, and the Linux hash comes from the CI log. There is no web-screens job and none of the ignored in-process tests. A scheduled workflow, `doctrine-balance.yml` (daily 03:17 UTC, 1,500 paired seasons), has never run on GitHub and will start running on the default branch. See [`.github/workflows/`](.github/workflows/), [DECISIONS F1, O-M1-17](docs/frontier/DECISIONS.md).

**What is NOT claimed, here or anywhere in this repository:**

- that the new game ran on devnet or mainnet; that any person outside the project played it; any demand, registration or traction;
- that conquest, instant land, the 14-day season, a score or a winner, governance, diplomacy, markets, a shared civilisation, money, prizes or payouts exist as built; that a studio was talked to or offered anything; that "Civ-like" is finished;
- that AI is "always labelled" (decision D2 removed that rule; the council page and the roster carry labels today, and that is all); that "AI never holds keys" (the wording is "the model never sees keys"); that AI keys are secret; that the AI citizens' personas were dealt by public randomness;
- that AI citizens are indistinguishable from people, stronger than the rule bots or script bots, as active as script-bot nations, exactly replayable (a sample is replayed), or earning money; that one machine runs thousands of them (a Mac handles roughly 400 to 450 model decisions an hour (estimate)) or that they cost nothing extra (there is no per-token API cost; compute grows with machines);
- that a model wants or intends anything, "remembers like a person", "holds grudges", or learns; that its memory makes it play better, made it decide, or shows why it chose; that memory is private or lasts across seasons; "the AI decided" without the by:model share and n;
- that the council is enforced by the chain, that it can order an AI's own march, or that people and AI decide together outside nation 0 with the operator's seat;
- pacts, betrayal or binding promises between AIs (removed from the build, decision X2).

Failure thresholds and the audit design: [overview §2, §6](docs/DESIGN-OVERVIEW.md); the full list of statements that may and may not be made: [docs/GAME-DESIGN.ja.md §9](docs/GAME-DESIGN.ja.md).

<a id="pointers"></a>

## 8. Pointers

- **The unified game design (Japanese):** [docs/GAME-DESIGN.ja.md](docs/GAME-DESIGN.ja.md): the complete intended game with the current state beside every part, the owner's decisions D1 to D12 (§10.1), the open questions (Appendix A). The 48 discrepancies it resolves: [docs/GAME-DESIGN-DISCREPANCIES.ja.md](docs/GAME-DESIGN-DISCREPANCIES.ja.md).
- **Design overview, 10 minutes:** [English](docs/DESIGN-OVERVIEW.md) · [日本語](docs/DESIGN-OVERVIEW.ja.md).
- **Contracts:** [AI citizens contract v1.3](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md) (the copy on `frontier/ai-integ` carries later rulings under the same version name); conquest contract v1.5 on branch `frontier/cq-integ` (`docs/frontier/conquest/CONQUEST-CONTRACT.md` in this tree is an older version, v1.1); the [M1 contract](docs/frontier/m1/M1-CONTRACT.md).
- **Decisions and design record:** [decisions log](docs/frontier/DECISIONS.md) (the decisions of 2026-10-04 are recorded as part Y, Y1 to Y12, which the design document calls D1 to D12, [GAME-DESIGN.ja.md §10.1](docs/GAME-DESIGN.ja.md)); [design record (DESIGN.md rev 4)](docs/frontier/DESIGN.md), a technical reference whose older values (for example 28 days) the unified design supersedes; [design index](docs/frontier/README.md).
- **Submission:** [Pitch](PITCH.md) · [Submission record](SUBMISSION.md) · [Demo script](docs/pitch/DEMO_SCRIPT.md) · [Run it](docs/RUNNING.md).
- **Japanese summaries:** [現状要約](docs/frontier/SUMMARY.ja.md) · [M1 終了レポート](docs/frontier/m1/M1-EXIT.ja.md) · [AI市民](docs/frontier/ai-citizens/SUMMARY.ja.md) · [AI市民の設計の背骨](docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md).
- **The earlier prototype.** An earlier, different game (then named Permutation State: six nations, officers, 180 ticks, MagicBlock ephemeral rollup) ran a full season on Solana devnet (rules v8, season 1790355636798) and re-verified 14 of 14 checks (14 members, 12 of them operator-run AIs, none of which conquered a home city; [verification output](docs/earlier-prototype/devnet-season-1790355636798-verification.txt)). Its code is on branch `codex/magicblock-playable`. It is history; nothing above is claimed from it. Its old README and design pages are kept, with banners, in [docs/earlier-prototype/INDEX.md](docs/earlier-prototype/INDEX.md).
