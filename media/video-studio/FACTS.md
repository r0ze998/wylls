# Wylls: facts sheet for video authors

Compiled 2026-10-24 from the repository (branch at merge `79c8068`, PR #12). **Accuracy beats excitement.** Every fact carries one status tag. Never upgrade a tag, and never drop it when you shorten a line.

| Tag | Meaning |
|---|---|
| **[DEVNET]** | Ran on Solana devnet. Only the *earlier prototype* has this tag. |
| **[LOCAL RUN]** | Ran on a local test chain (LiteSVM). It has never run on devnet or mainnet. |
| **[CODE]** | Implemented and tested as code. No recorded season exercised it, or only a scripted or driven one did. |
| **[DESIGN]** | Written down, not built. |
| **[PLANNED]** | Intended, with no date. |
| **[DROPPED]** | Removed by a decision. |

Sources are repository paths. "README" means `/README.md`, "OVERVIEW" means `docs/DESIGN-OVERVIEW.md`, and "CQ3" means `docs/frontier/conquest/CQ3-A-NOTES.md`.

---

## 1. One-line pitch and thesis

- **"Play the agent economy."** This is the README tagline. Next line: "a strategy game where people and AI citizens can fight for one map." (README:3)
- **「AIがプレイヤーのように振る舞うゲーム」 / "A game in which AI behaves like a player."** This is the opening axis (owner decision D12/Y12). The headline showpiece is an AI citizen's own march. The nation council is the second showpiece. (PITCH.md; GAME-DESIGN-SUMMARY.ja.md §2)
- **Wylls = will (意志).** The thought experiment is *"How does a game behave when AI has will?"* The game makes "will" visible from outside in five forms (section 5). The project does **not** claim that the model wants or intends anything. (OVERVIEW §2; PITCH "The thesis")
- **Setting.** A Civilization-style shared world. Six nations (国) share one hex map around a neutral centre, **The Concord**. You choose a nation, grow a village (村), train troops and send sealed armies (軍). The game is played in the browser (Japanese and English). (README §1; docs/frontier/DESIGN.md:53)
- **Why a chain.** The program, not an operator, resolves every clash. The season is a public log that anyone can replay and check. The project's stated reason for a chain is this, "not speed or cost". (PITCH "Why a chain")
- Say: "The first playable slice of a Civ-like shared world, where AI citizens play beside people." Don't say: "A finished Civilization on Solana." Tech, eras, diplomacy, markets and governance are [DESIGN].
- Say: "People and AI citizens **can** fight for one map." Don't say: "People and AI already play together." **No run has had people and AI citizens in the same world.** (PITCH status line; SUBMISSION §7)

## 2. The six nations (国)

The nation names and order come from `fi18n.mjs:19` and `i18n.mjs:16`. The colours come from `permutation-server/web/frontier/palette.mjs` (NATION_FILL). The sigils come from `map/layers.mjs:85` and `people/avatar.mjs:25`. The doctrines come from `fi18n.mjs:73` and `lang/en-frontier.mjs`. The pitches come from `people/leaders.mjs` DOCTRINE_PITCH and `lang/en-frontier-play.mjs:363-367, 902`.

| # | Nation (JA) | Colour (hex) | Sigil | Doctrine (JA / EN) | Character's look | Doctrine one-liner (UI text) |
|---|---|---|---|---|---|---|
| 0 | **Aster** アステル | red `#cc303b` | circle | 石の守り手 / Wardens of Stone | red marshal's coat, gold epaulettes, red hair | "Cheaper walls, and pikemen who excel in Brace. Its heartland is slow to take." |
| 1 | **Borealis** ボレアリス | sky cyan `#31bedb` | triangle | 潮 / Tide | sky-cyan coat and hood, brass mask and goggles | "Faster caravans and roving light cavalry. More Waystones on its roads." |
| 2 | **Cinder** シンダー | yellow `#eac21b` | square | 炎 / Flame | yellow cape over bronze plate, grey hair and beard | "Shock infantry that hits hardest on the turn it arrives. Its war horn announces war." |
| 3 | **Dunmar** ダンマール | purple `#a34cd8` | diamond | 新緑 / Verdant | purple hooded mantle, silver circlet | "Half the supply attrition. Rangers who are strong in Flank and range far." |
| 4 | **Ember** エンバー | white `#edeee7` (on maps its land is drawn in blue slate `#58727e`) | cross (plus) | 光明 / Lumen | white surveyor's coat, white hair, goggles | "Faster marches. Engineers build roads twice as far, and exploring also shows the tiles around." |
| 5 | **Fjordal** フィヨルダル | orange `#f19232` | hexagon | 鉄 / Iron | orange coat with a white fur collar, chestnut hair | "Heavy cavalry with cheaper upkeep. Captured Free Cities keep their walls." |

- **Characters have no names and no titles.** This is owner decision ZP1 (2026-10-09). Each nation has one character, and choosing a nation means choosing that character. "Marshal / captain / herald / surveyor / jarl" in `palette.mjs` are descriptions of the coats, not titles. (people/leaders.mjs:1-18)
  - Don't invent leader names, titles or lore. The repo has no lore or backstory text for the nations.
- **A nation is never told by colour alone.** The sigil goes with the colour everywhere. "Yours" is shown with a gold ring `#ffd24d`. (palette.mjs)
- **Doctrines are asymmetric, but none multiplies a scored fact.** In the balance simulator the first draft table let Lumen win 99.5% of 600 seasons. (permutation-rules/src/frontier/doctrine.rs:1-30)
- **Doctrine one-liners.** These are UI copy. Some name mechanisms that the doctrine kernel marks "not simulated" or that are not built: Waystones, war horn and road-building, and caravans before S1. Don't present each one-liner as a tested feature. (doctrine.rs:26-30) [CODE / partly DESIGN]
- **Neutral (中立):** barbarian camps and Free Cities. (fi18n.mjs:18)

## 3. The core loop (M1 basic game, plus later additions)

**Status:** the M1 loop is [LOCAL RUN] with script bots, and the web client is real. Instant land (`PlaceHome`) is [LOCAL RUN] in conquest-program seasons.

- **Join = choose a nation.** This is the only choice. (README §2) [LOCAL RUN]
  - **Instant village (`PlaceHome`).** The village is placed at once, final, in the nation's own wedge, with no ticket or lottery. It is the join flow of every conquest-program season. The time from joining to the first march has not been measured with people. (PITCH table; permutation-frontier/src/proc/citizen.rs:1150) [LOCAL RUN]
  - The completed M1 season used the older flow: a site ticket and a lottery. The village appeared about 11–21 min later (a model figure) and stayed provisional for up to about 4 h. (OVERVIEW §3.1)
- **Village tiers:** 集落 Hamlet → 町 Town → 都市 City → 城塞 Stronghold. (fi18n.mjs:71)
  - Hamlet→Town upgrade: 1,000 wood, 600 stone and 300 gold, 6 h. A Town has 3 build slots, storage 6,000 and +50% production. (OVERVIEW §3.1)
- **Starter kit:** 300 food, 300 wood, 200 stone, 100 ore and 100 gold. The village gets a 48-game-hour shield (M1 value). (OVERVIEW §3.1)
- **Eight resources (kernel order):** 食料 Food, 木材 Wood, 石材 Stone, 鉱石 Ore, 馬 Horses, 金 Gold, 学術 Science, 影響力 Influence. (resources.mjs; fi18n.mjs:22)
- **Buildings:** 農場 Farm, 伐採場 Lumber camp, 石切り場 Quarry, 鉱山 Mine, 造幣所 Mint, 書庫 Library, 城壁 Walls. (fi18n.mjs:354)
  - A Farm costs 80 wood + 40 stone and gives +12 food/h. It takes 90 min (the n-th copy costs more). (OVERVIEW §3.1)
- **Eight troop types:** 槍兵 Spearman, 弓兵 Archer, 騎兵 Horseman, 長槍兵 Pikeman, 弩兵 Crossbowman, 騎士 Knight, 斥候 Scout, 開拓者 Settler. (fi18n.mjs:29)
  - 100 Spearmen cost 60 food, 20 ore and 10 gold. Training is immediate. A host (軍) is 100–30,000 troops of one type. (OVERVIEW §3.1)
- **Stances:** 待機の構え Hold, 突撃 Assault, 側撃 Flank, 迎撃 Brace (plus 混乱 Disarray as a state). (fi18n.mjs:45)
- **Clash outcomes in reports:** 勝利 won, 撃退 repelled, 持ちこたえた held, 壊滅 fell, 野営地を制圧 camp cleared, and others. (fi18n.mjs:57)
- **Real-time economy, turn-based combat.** Resources accrue continuously and are computed lazily. There is no waiting for the economy. (README §2) [LOCAL RUN]
- **The 10-minute turn (ターン; called "bell" / 鐘 in code).** There are 144 turns a day. Fights, marches and scouting resolve together per province. Sending a minute earlier gives no advantage. (README §2) [LOCAL RUN]
- **Scouting (斥候 / explore).** The result arrives at the next turn. (README §2)
- **Sealed marches (進軍・封印・開封).** Departure, size and arrival turn are public. The destination is hidden by a **drand time-lock (tlock)** until the arrival turn ends. A march needs at least 2 turns (at most 72), and it **cannot be recalled**. Anyone holding the reveal can open it, so closing the tab does not void the march. (README §2; OVERVIEW §3, §7) [LOCAL RUN]
  - Say: "Sealed by a time-lock." Don't say: "Provably secret." **Seal secrecy was not tested.** The M1 run replayed archived drand rounds, and the AI and demo runs used a test key. (README §6)
- **Barbarian camps** hold 100–400 troops. Clearing one gives 10 "Works", which are points with no use yet. In M1, beating another nation gains nothing (no loot, no land). (OVERVIEW §3)
- **Battle reports re-run in the browser.** The client re-runs the shared Rust rules kernel compiled to WebAssembly (`frontier-wasm`) to check the report. (README §2; SUBMISSION §2) [LOCAL RUN]
  - In the `own1` demo the browser showed six passing checks and a lower **`Match`**, while an upper **`Unverified`** badge stayed stale. Describe the recomputation result, not a "verified" badge. (SUBMISSION §5)
- **Pacing (everyone):** 30 actions/hour on chain (burst 60). The relay's sponsored quota is 40 actions per game day. (OVERVIEW §3.1)
- **Practice battle:** `practice.html` runs with no chain (Python http.server). (README §5) [CODE]
- Say: "Every 10 minutes the whole world resolves at once." Don't say: "Fully on-chain real-time strategy on Solana mainnet."

## 4. Conquest (征服)

**Status:** [LOCAL RUN]. This includes the integrated program and web flow, one human-operated capture recording, bot seasons and one driven season.

- **Keeps (砦 in the UI; "keep" in EN).** Each province outside the heartland has a keep, and the map colour follows who holds the keeps. (docs/frontier/conquest/SUMMARY.ja.md §2.1, an older v1.1 plan)
  - Current preset: a keep is taken after **72 turns (12 h)** of holding its tile. After capture there is a 288-turn consolidate window. (frontier-abi/src/v2/presets.rs:429-434) [CODE]
  - Heartland = rings ≤ 3. Only ring 4's **Free Cities (自由都市)** and outposts can be besieged. (CQ3)
- **Sieges (包囲).** A sealed march takes the target tile, then the lead host declares a siege (`DeclareSiege`). A siege needs 36+ turns, outside the defender's 8-hour vigil. Default: 2 sieges per day. (permutation-rules/src/frontier/siege.rs:46-57; presets.rs) [CODE]
- **Occupation and capture.** Captured holdings change owner. The first holding (home) is never transferred (verifier V16). (CQ3) [CODE]
- **Towns and outposts (前哨).** An outpost needs the anchor village at Town tier (`FileOutpost`). Outpost filing has run only in a driven season, never in a bot season. (CQ3) [LOCAL RUN, driven]
- **The `own1` recorded capture (season 100).** This is human-operated and local. [LOCAL RUN]
  - **Aster** seals a **500-Spearman** march on **Fjordal's keep**. The clash is at **turn 43**.
  - The clock was then advanced **72 turns** locally, and the keep transferred at **turn 110**. **This advance must be disclosed** in any cut.
  - Standings were Aster 10 and Fjordal 8 provinces. The test-USDC prize panel was active, and the season was still running: no winner, no payout.
  - The world had **no AI and no bots**.
  - Source: docs/pitch/DEMO_SCRIPT.md, SUBMISSION §5.
- **Season-winner rule.** After the season ends, the prize program counts each keep once for its holder. **The nation holding the most keeps wins** (this rule is decided). Ties go to more territory time, then an equal share; the tie rules are *provisional*. (permutation-prize/src/lib.rs; PITCH) [CODE, run to the end locally]
  - A wider nation score (territory time + prosperity + knowledge) is [DESIGN], and its formula is open (Q6).
- **14-day preset `MC_LOCAL_14D`:** 2,016 turns, with joining closing at turn 1,512. Since S1 the stack uses `S1_LOCAL_14D` (the same timings with program version 4). (presets.rs:500-504, 580; commit 1db5a32) [CODE]
- **The 14-day local run `sc-14d`** (started 2026-10-17 10:41 JST, ended 2026-10-18 03:48 JST). [LOCAL RUN] (CQ3 "The 14-day season"; README status table)
  - Setup: 20x speed, **120 rule bots**, and **3 paid test wallets** joining over x402 (25 test USDC each; pool 75 = prize 60 + ops 15, test units).
  - **272,004 transactions.** The final verify PASSED (V1–V22 and CQ1–CQ3, with 2 usual warnings). The tamper suite detected every required class.
  - Tally: keeps 10/9/9/9/10/7. Nations 0 (Aster) and 4 (Ember) tied at 10, and territory time (19,968 vs 19,936 turns) chose **nation 4, Ember**.
  - Ember had no paid member, so the payout ran in **refund mode**: each paid wallet got 20 of its 25 test units back.
  - The bots raised **0 sieges and 0 outposts** all season, with 149 clashes and 2 keeps taken.
  - One `Train` transaction used 17,505 CU against a 17,500 budget, so stack criterion 2 failed. That is an open item.
- **Other conquest runs** (CQ3). [LOCAL RUN]
  - `sc-cq2d`: 48 game hours, 120 bots, **32,687 tx**, 72 clashes. One keep was taken (nation 3 from nation 2 at turn 237). Tally/Finalize named nation 3 with a 0 test-USDC pool. 30/30 M1 tamper classes were detected.
  - `sc-drive`: 120 game hours, one dev wallet driven by script. It covered a Free City siege and capture, the Town tier-up, an outpost and the season's end. 82,037 tx, verify PASS, and Tally → Finalize → SetShares → Claim landed (test tokens).
- Say: "In a recorded local demo, Aster takes Fjordal's keep (with a disclosed 72-turn clock advance)." Don't say: "AI conquered a nation," "the map moves by itself," or "a player won the prize."

## 5. AI citizens (AI市民)

**Status:** [LOCAL RUN]. The code is in the tree, and the saved `take-1` run passed `verify-minds`. The formal A/B comparison and a completed 18-AI main run are **pending**. (README §3)

- **Model.** Local **Gemma 4 26B A4B** through llama.cpp, with thinking off, temperature 0 and JSON-schema output. **No paid API.** A run refuses to start if an Anthropic or OpenAI key is set. (OVERVIEW §6, §6.6)
- **「コードが候補を出し、モデルが選び、コードが確かめる」 / "The code offers, the model chooses, the code checks."**
  - The code offers **at most 12 legal candidates** in a 12-province window.
  - The model picks one.
  - The code validates the pick (schema, caps, a fresh re-check), and the program refuses anything illegal. (README §3; OVERVIEW §6.1)
- **Autopilot (自動運転).** If the model is late, invalid or refused, a rule autopilot plays. It runs only the economy and routine duties (and follows Strike Orders). It **never starts a march of its own**, so every voluntary AI march is the model's choice or a council Strike Order. Most AI actions are the autopilot's. (README §3)
- **Safety limits** ("same rules" may only be said *with* these). (OVERVIEW §6.1, §6.5)
  - At most 12 candidates.
  - At most 60% of home troops per decision and per day, and at least 40% kept home (the daily cap and floor are waived under 200 troops).
  - At most **4 model-chosen marches a day**.
  - Speech: 3 messages per turn and 40 per game day.
  - The same 30/h bucket, relay quota, keys and fog as people.
- **Keys.** Say: "**The model never sees keys**." The bot-side "brain" signs, and the keyless "mind" calls the model. Don't say: "AI holds no keys." The local test keys derive from a public seed, so this is structure, not secrecy. (OVERVIEW §6.5)
- **Memory and citation (記憶・引用).** (OVERVIEW §6.3)
  - Code writes short templated **episode** lines from public records. The model never writes them.
  - Retrieval shows the model "Remembered" lines (top 8, plus grudge records, plus the latest 3; at most 750 tokens).
  - The model may **cite** lines it was shown. A citation shows that a line was shown and named, **not that it caused the choice**.
  - Memory ends with the season and is not shared between AIs.
  - Say: "cited." Don't say: "remembers," "holds a grudge," or "memory makes it smarter."
- **Senasha's take-1 trace (the headline AI scene).** (SUBMISSION §5; DEMO_SCRIPT) [LOCAL RUN]
  - The run was six local Gemma 4 AI citizens plus six separate script bots, at commit `aae47bdb…`.
  - At turn 65, the AI citizen **Senasha** made a `by: model` decision (`mode:model`, `reason:ok`; id `881d797c…`). It chose a **400-troop march to a barbarian camp** plus a **science build**.
  - The saved decision result links the sent transactions to a **turn-68 clash and camp clear**.
  - The page shows the offered options, the cited memory, the model-written reason (marked not verified) and the local-chain transactions.
  - `verify-minds` = **PASS**.
  - No human action triggered it; the page says "Decisions that began with a person's action: None yet."
- **Council (評議会) and Strike Order (攻撃命令).** (OVERVIEW §6.4) [LOCAL RUN; adoptions recorded, mostly AI votes only, no human ballot]
  - The code proposes up to 3 targets. Citizens file motions with speech and vote; a target needs ≥ 2 votes and more than every other option.
  - The adopted target stays sealed until 2 turns after the strike.
  - The council is **off-chain**, and the chain enforces nothing. An AI may decline publicly.
  - **CORRECTED 2026-10-24:** an earlier version of this sheet said no Strike Order was ever adopted. That is wrong. In smoke-b3 all 9 councils closed without a quorum, but in four later completed local runs (smoke-r4, ai-pilot-A1, ai-record-2, ai-record-3) councils **adopted 39 Strike Orders** (r4 2, pilot 18, record-2 11, record-3 8); **18 of the 39 targets recorded a clash**, and some orders moved armies (e.g. record-3 nation 0 period 1: two AI votes, a host at the target, 7 engagements, camp cleared). (docs/frontier/ai-citizens/RESULTS-2026-10.md §0, §2 G6, §2.2)
  - Votes were almost all **AI votes only**. The nation-0 seat's ballots were **scripted** by the operator (3 orders). **No human ballot exists in any of the 96 council files.** So never say "people and AI decided together."
  - The formal **A/B was not run** (0 pairs); the 18-AI main run was not run to completion. The take-1 footage shows no council vote.
  - Say: "In local test runs, AI councils adopted Strike Orders, mostly by AI votes alone." Don't say: "No Strike Order has ever been adopted," "players and AI voted together," or "the council is enforced on-chain."
- **Valid-choice rate (G1) in the 12-AI runs:** 82.4%, 84.8% and 88.7% (n = 187, 197, 266), **below the 95% gate**. smoke-r4's 57/57 was 6 Conqueror AIs and is not representative. Don't present 52/52 (smoke-b3) as the general validity rate. (RESULTS-2026-10.md §0)
- **Personas.** Six types exist in the library: conqueror, guardian, diplomat, avenger, founder, opportunist. (AI-CITIZENS-CONTRACT.md:116-127)
  - Each has 7 temperament numbers, a creed (EN/JA) and 4 goals.
  - The fixed decks are deck-1 = conqueror (smoke runs), deck-2 = avenger + diplomat (12-AI), and deck-3 = avenger + diplomat + conqueror (18-AI).
  - Creeds:
    - Conqueror: "My nation's spears answer first; I lead the march others hesitate to make." / 我が国の槍は真っ先に応える。
    - Diplomat: "A good neighbour is worth more than a won battle." / 良き隣人は、勝った戦より価値がある。
    - Avenger: "Every wrong done to my people is answered." / 同胞が受けた仕打ちには、必ず報いる。
- **Wyll card (Wyllカード).** A public JSON card per AI. It holds the persona, creed, goals with progress (or "progress not computed"), trust, a memory excerpt, recent reasons with citations, the model-vs-autopilot share and budgets. (OVERVIEW §6.2) [LOCAL RUN; smoke-b3 wrote cards]
- **Five visible forms of will:**
  1. Lasting goals.
  2. Reasons that cite memory.
  3. Trust and unanswered grievances.
  4. The right to decline an order.
  5. A voice and a vote in the council.
  - The formal main run has **not** confirmed the grievance or refusal claims. A 12-AI pilot recorded six `attacked_own` episodes, which is not a formal result. (PITCH thesis; OVERVIEW §2)
- **smoke-b3** (2026-10-04, 6 AIs, all conquerors, 86 closed turns at 10x, local). (PITCH; OVERVIEW §6) [LOCAL RUN]
  - 52/52 model decisions were valid, with 0 fallbacks. n = 52 is far below the gate's 300, so this is not a gate result.
  - p50 latency was 3.2 s.
  - At most **29.8%** of AI actions were model-chosen; 64.3% were autopilot economy.
  - 10 model marches, all at camps; 9 have a clash episode (a proxy for the gate quantity Y).
  - 26/52 decisions cited memory. The oldest cited line was 32 turns old.
  - `verify-minds` PASS, before a later verifier fix.
- **Gemma 4 spike** (bare model on recorded scenes; not the AI-citizen code). (docs/frontier/ai-agents/gemma4/REPORT.md:11-37) [LOCAL lab measurement]
  - The model chose a march in **1 or 9 of 20** decisions depending on one instruction line. The report's verdict line also says 12, which the body doesn't confirm. The rule bot chose a march in **18 of 20**.
  - Best setup: **79% valid** actions (EN 88%, JA 71%).
  - About **5 s** of compute per decision.
  - This is why guarantees live in code. Don't say: "AI plays better than bots."
- **Run list** (all local; append-only in docs/frontier/ai-citizens/RUNS.md).
  - Aborted: slice-1, slice-2, slice-3, smoke-b1.
  - Completed with `verify-minds` FAIL: smoke-b2, smoke-b4, smoke-r2, ai-pilot-A1.
  - Completed with PASS: slice-4, smoke-b3, smoke-b5, smoke-r1, smoke-r3, smoke-r4, ai-record-2/3/4, ai-pilot-A2.
  - **ai-main (18 AI) was aborted.**
  - Later: take-1 PASS. take-2 FAILED one item (council speech was published early); this was fixed after submission in PR #6. No season has run on the fixed code, and take-3 has not run.
- **Pending:** the formal A/B (12 AI), a completed 18-AI main run, the injection suite on real Gemma, persona-difference measurement, a run with people and AI in one world, and legal review of AI disclosure.
- **Display:** the design shows AI citizens like human players, with no mark (D2) [DESIGN]. Today the audit page and `roster.json` label `ai`, `script` and `seat`. The main map client doesn't display AI citizens at all yet. Don't say: "AI is always labelled," or "AI is indistinguishable from humans."

## 6. Chain and verification

- **Stack.** A Solana program (SBPF v2) runs on a **local LiteSVM test chain** (400 ms slots). drand quicknet (BLS12-381) provides randomness and tlock seals; local demos use a test beacon. (SUBMISSION §2; OVERVIEW §4)
- **The program decides every outcome.** Keepers are permissionless, the herald is read-only and recomputable, and the relay can refuse to sponsor but cannot change an outcome. (OVERVIEW §4)
- **The replay verifier is the team's own, not an independent audit.** Anyone can run it. (README §6)
- **M1 exit season `m1-exit`** (2026-09-30 17:45 → 10-01 02:25 JST). (docs/frontier/m1/M1-EXIT-NOTES.md §3; SUBMISSION §1) [LOCAL RUN]
  - **1,000 script/rule bots** of **13 profiles**, including cheaters and spammers.
  - **7 game days = 1,008 play turns + 26 closing turns**, run in **8 h 39 min at 20x**, with real drand quicknet rounds replayed from an archive.
  - **The verifier passed 144,300 transactions and caught 30/30 deliberate tampers.** The verify took 11 s (41 s for the whole command).
  - 1,712 due marches settled, with 0 stuck. 43 kill -9 restarts caused no crash.
  - 5,000 *simulated* viewers made 3.46 M requests with 0 errors.
  - Reveal used at most 24,050 CU.
  - M1 was formally complete on 2026-10-01.
- **Other verifier figures:** 32,687 tx (`sc-cq2d`), **272,004 tx (14-day `sc-14d`)** and 82,037 tx (`sc-drive`), all PASS. (CQ3)
- **Program counts.**
  - At M1/submission: 50 instruction tags (49 usable in release) and 17 account kinds, with 248 program tests, 529 web tests and 51 screen tests on the M1 closing tree. (PITCH table)
  - After the S1 merge (2026-10-24): **73 v2 instruction tags** (M1 51 + conquest 7 + S1 15) and new account kinds 19 Vault, 20 Caravan, 21 Structure and 22 Nation.
  - At the merge: the LiteSVM suite has **389 tests**, and the gateway and web suite has **2,379 tests**, all passing. (commits 6ea5e32, bb2ce3c)
- Say: "Anyone can replay the season log; our verifier caught every planted tamper." Don't say: "Audited," "cheating is impossible," or "tested on mainnet."

## 7. Architecture (components, one line each)

The folder names are historical: `permutation-*` and `frontier-*` were not renamed (decision V1). (README §7; SUBMISSION §2; OVERVIEW §4)

| Component | Path | Role |
|---|---|---|
| Rules kernels | `permutation-rules/src/frontier/` | Deterministic `no_std` Rust: the single source of rules for the program, simulator, verifier, bots and browser |
| **permutation-frontier** | `permutation-frontier/` | The Solana game program, the only judge of outcomes; LiteSVM tests in `svm-tests/` |
| **permutation-prize** | `permutation-prize/` | Test-USDC entry, pool, Tally/Finalize/SetShares/Claim; no live-money deployment |
| frontier-abi | `frontier-abi/` | The program's ABI, presets and shared clash and conquest models |
| **frontier-wasm** | `frontier-wasm/` | The rules built to WebAssembly so the browser can recompute clash reports |
| frontier-sim | `frontier-sim/` | Balance simulator and CI balance gate |
| **frontier-node / stack** | `frontier-node/crates/stack` | The stack runner (`frontier-stack up/verify/tamper/down`) with localnet and drand-replay |
| **keeper** | `frontier-node/crates/keeper` | Permissionless helper: posts beacons, opens seals, reveals marches, resolves clashes, settles |
| **herald** | `frontier-node/crates/herald` | Read-only: folds the transaction log into JSON files and a WebSocket feed |
| **verify** | `frontier-node/crates/verify` | Replays a finished season and judges every rule, with tamper classes |
| bots | `frontier-node/crates/bots` | Script bots (13 profiles) |
| **gateway / relay** | `permutation-gateway/` | Quota-limited relay paying fees, x402 test-USDC joining, JS SDK, prize scripts |
| **citizens** | `permutation-gateway/citizens/` | AI citizen service: mind (model-facing, keyless), personas, memory, council page, `verify-minds` |
| **web client** | `permutation-server/web/frontier/` | Map, village, march composer, clash report with WASM recomputation, conquest, prize panel, onboarding, practice, spectator; JA/EN |

## 8. Money

- **Locally:** a **25 test-USDC** entry over x402 and a prize program, using **valueless test tokens** only. (README §4) [LOCAL RUN]
  - The 14-day run used three paid test wallets and paid out in refund mode.
- **Planned:** the next public season on **Solana mainnet** with **live USDC**: a 25 USDC entry, with **80%** of fees to the prize pool and **20%** to the operator, **subject to legal review**. (README §4) [PLANNED]
  - A free public season is not required first (D4, updated 2026-10-11).
- **Nothing is live.** No real entry fee, prize or payout exists, and no real money has moved. There are no registration, waitlist, demand or revenue figures. Staking is a later idea. "AI citizens for game studios" is [PLANNED]: **no studio conversation is on record**. (PITCH "Business plan")
- Whether the business plan may be said in videos is open (Q18). By default it is **not** said in the pitch video or slides. (GAME-DESIGN-SUMMARY.ja.md §6)
- Don't say: "Win USDC now," "prize pool live," or "studios are adopting it."

## 9. Balance simulator

All figures are **simulator output with assumed behaviour; not measured with people.** (docs/frontier/m0/M0-FINAL.md:61; M0-FIRST-PASS.md:52; doctrine.rs)

- The first draft let one nation (doctrine Lumen) win **99.5% of 600** simulated seasons.
- After tuning, all six nations won between **15.6% and 17.4%** of **1,500 paired seasons** at **10,000 simulated wallets**: A 15.6, B 15.7, C 16.9, D 17.4, E 17.4 and F 17.0. The largest gap is 1.1 points.
- Bots versus the simulator was not measured. The design point is thousands to about 50,000 players (a model figure). The largest test was 1,000 bots.
- Say: "In simulation, every nation wins about 1 season in 6." Don't say: "proven balanced."

## 10. Timeline and roadmap

All dates are JST unless noted. (SUBMISSION §4, §7; PITCH; git log)

| When | What | Status |
|---|---|---|
| before the repo | The builder's earlier onchain games 0xCiv and 0xARK. They are prior work, not part of this repo. | — |
| 2026-09-21–26 | **Earlier prototype "Permutation State"**: six nations, officers, 30-second ticks, a **MagicBlock** ephemeral rollup, **x402**, test USDC. **One 180-turn season on Solana devnet** with **14 members (12 operator-run rule-based + 2 people)**; the verifier passed 14/14 (season 1790355636798). Code is on branch `codex/magicblock-playable`. | [DEVNET], a *different game* |
| 2026-09-27 | Pivot to the open-world rebuild: rules kernels and the balance simulator (M0). | [CODE] |
| 2026-09-27 → 10-01 | **M1 "First Bell"**: program, keeper, herald, relay, verifier, 1,000 bots and web client. The exit season ran 09-30 → 10-01, and M1 closed 10-01. | [LOCAL RUN] |
| 10-02 → 10-03 | Name **Wylls**; 国/村 (nation/village) wording; joining is one choice. | |
| 10-01 → 10-04 | Gemma 4 spike, AI-citizen contract v1.1–v1.3 (memory in, pacts out), conquest Waves 1–2 on a branch, smoke-b3. | |
| 10-05 → 10-11 | 6-AI smoke runs and 12-AI pilot/recording runs; the 18-AI main run was aborted. **take-1** (10-11) recorded Senasha's march, PASS. **own1** recorded a keep capture. take-2 failed one item. | [LOCAL RUN] |
| 2026-10-12 03:32 | **PR #4**: the integrated code (conquest, AI citizens, test-USDC prize path) merged into `main`. | |
| **2026-10-13 06:50** | **Submitted to Colosseum's Crypto World's Fair, Gaming track** (`main` = `5a0ea945`). Demo video https://www.youtube.com/watch?v=M3KXncQcIJg; pitch video https://youtu.be/WMAESO0xbek; site https://wylls-site.vercel.app/ | Done |
| 2026-10-13 20:58 | **PR #6** (after submission): a sealed AI decision no longer carries council speech early, plus two viewer fixes. | No season run on it |
| 10-17 → 10-18 | Verifier on conquest seasons; sc-cq2d, sc-drive and the **14-day sc-14d** run to its end. | [LOCAL RUN] |
| 10-22 → 10-23 | **Redesign discussion** (docs/design/redesign/, Japanese). Ideas include a persistent world with "war periods" (戦期) instead of wiping seasons, player-built structures, zk-hidden marches, an own token "back on the table", and AI roles. | [DESIGN], **under discussion** |
| 2026-10-23 → 10-24 | **Stage S1** built and merged into `main` (PRs #9, #11, #12). Details below. | [CODE] |

**What S1 adds** (sources: docs/frontier/stage1a, stage1b, stage1d and stage1e notes; git log):

- **Arms economy.** The Workshop (工房) turns 2 ore + 1 wood into 1 arm. Arms are 兵器 in the design docs. Pikemen, Crossbowmen and Knights cost arms, and a siege burns 50 arms. Hills and mountains give terrain ore.
- **Vaults (倉).**
- **Caravans (荷車 / 隊商).** Caravans join clashes. Raids either take the cargo or burn it; a taken caravan changes hands.
- **Watchtowers (見張り塔).** A tower wears down marches and caravans that pass through its range (1% per minute, at most 30%) and reports public events nearby.
- **Palisades (柵).** A palisade blocks its tile.
- **Forts (砦; note that the UI also uses 砦 for "keep").** A fort can be garrisoned with up to 2,000 Spearmen, fights, falls and can be seized.
- **Nations (国) with on-chain proposals and votes.**
  - One vote per village.
  - A village can vote 288 turns after joining.
  - Proposals are open for 144 turns and pass if yes > no and yes ≥ 3.
  - Votes decide the stance toward other nations and **expulsion/readmission** of a member.
  - **Domestic raids** are recorded.
- **Off-chain support.** The verifier gained checks V23–V25, and the keeper and herald gained feeds.
- **Status of S1:**
  - Many numbers are placeholders ("[phase 6]").
  - The **web client UI for caravans and vaults is not built** (stage "1f"), and the bots do not use S1 features.
  - One S1 season was run end to end in a session, stated only in commit `1db5a32`. There is **no run record**.
  - In videos, present S1 as "implemented in code, not yet playable in the client".

**Roadmap** (an order, not a promise; OVERVIEW §8.2; PITCH; README §6):

- Shared civilisation: tech, eras, the **Engine** (a shared central building), diplomacy. It was the top priority after the hackathon (W8). [DESIGN; content not designed]
- A wider nation score; governance, markets, bring-your-own AI (M3). [DESIGN]
- The next public season on Solana mainnet with live USDC. [PLANNED]
- The formal AI A/B, the 18-AI main run, and a people-plus-AI season. [PLANNED]
- Note: the 10-22/23 redesign may reshape the roadmap. Its decisions are owner decisions on *design*, not built features.

## 11. Not claimed: a video must never imply any of these

1. That the rebuild ran on **devnet or mainnet**. Only the *earlier prototype* ran on devnet, and it is a different game. The rebuild is local test chain only.
2. That **real money** moved, or that a prize or payout is live. Everything is test USDC; mainnet USDC is planned, subject to legal review.
3. That **people played** the rebuild at scale. The 1,000 players were script bots. Only `own1` had a human: the operator. There are no demand, registration or traction figures.
4. That **people and AI citizens played in the same world.** The demo joins **two separate runs** (own1 and take-1), and that must be disclosed.
5. That the **AI is stronger** than bots, **indistinguishable** from people, or **exactly replayable**. Replay is by sample.
6. That the AI **wants, intends, remembers or holds grudges**. Say "cited," and say "model-written reason (not verified)."
7. That **memory caused** a choice, or improves play.
8. That **people voted** on a Strike Order, that people and AI decided together, or that the council is enforced on-chain. (Strike Orders *were* adopted in local AI runs, by AI votes and scripted seat ballots only; never say none was adopted.)
9. That "**AI conquered**" anything, or that the map "moves by itself".
10. That a **season winner was paid**. The 14-day local run named Ember by tiebreak and refunded the test tokens.
11. That **seals were proven secret**. They were not tested, because the runs used archived or test-key drand.
12. That **randomness was public** in AI runs. AI runs used an operator test key.
13. That the verifier is an **independent audit**.
14. That "**cheating is impossible**," or that "**AI is always labelled**".
15. That a **game studio** was approached, or that there is any partnership.
16. That the **Civilization-style game is finished**. Tech, eras, Engine, diplomacy, markets and governance are design only.
17. That S1 (caravans, forts, votes) is **playable in the web client**.
18. That the own1 capture happened in **real time**. There was a 72-turn clock advance, and the upper "Unverified" badge in the recording was stale.
19. **Leader names, titles or nation lore.** There is none: characters are deliberately nameless.

## 12. Asset inventory (images for video)

The root is `permutation-server/web/frontier/art/`; the provenance record is `art/README.md`. Licences: the models were generated with Hunyuan3D-2, and the motion uses Kimodo (NVIDIA Open Model licence). **The pack says not to label all assets MIT.** Check before publishing. (art/README.md "Licences")

**Style.** The six characters are glossy stylised 3D figures with an anime-like face (chibi proportions in the standing poses). Units are matte low-poly 3D tabletop miniatures in nation colours. Map tiles are isometric hex dioramas. Icons are painted, semi-realistic UI art. All `.webp` files under `art/` are RGBA with transparent backgrounds.

**Best for video** (transparent, highest resolution):

| Asset | Path | Size | What it shows |
|---|---|---|---|
| ★ Leader portraits ×6 | `leaders3d/portrait-v1/<key>.webp` | 320×320 | Bust of each nation's character, transparent. The cleanest hero shots, but small: upscale at most about 2x. |
| ★ Leader motion sheets ×6 ×5 clips | `leaders3d/motion-v2/sprite@2x/<key>_{idle,walk,attack,hit,victory}.webp` | 512 px frames in one row: idle 8, walk 8, attack 8, hit 4, victory 12 (e.g. victory 6144×512) | Full-body character animations in a high three-quarter top-down view. The victory clip suits a "nation wins" beat. The 256 px set in `motion-v2/sprite/` has idle 4, walk 8, attack 8, hit 4 and victory 12 frames (art/README.md; leader-motion-data.mjs: idle 2 s loop, walk 1 s loop, attack 1 s, hit 0.55 s, victory 1.7 s). |
| ★ Leader stage strips ×6 | `leaders3d/stage-v1/<key>.webp` (288×360 still), `<key>_idle.webp` (1152×360 = 4 frames), `<key>_attack.webp` (2304×360 = 8 frames) | 288×360 cells | Front-facing full-body chibi figures. These look better on screen than the motion sheets. |
| Leader hexagon icons ×6 | `leaders3d/hex-v1/<key>@128.webp` | 128×128 | Bust in a hexagon badge with a nation-colour rim. Good for small badges and standings lists. |
| ★ Soldier cards (8 kinds × 6 nations) | `units/mobs-v1/cards/<0-5>_<kind>.webp` | 240×300 | Miniature figures on a base ringed in nation colour: spearman, pikeman, archer, crossbowman, horseman, knight, scout, settler. |
| Soldier atlases | `units/mobs-v1/@2x/units_<0-5>.webp` | 1920×2560, 320 px cells | Each unit in several facings and poses. The older set is `units/@2x/`. |
| Capture effect ×6 nations | `vfx/first-v1/capture/<key>/atlas-256.webp` | 2048×1024, 8 cols, 24 fps | A hexagon outline traced in nation colour. Use it for a "keep captured" moment. |
| Other effects | `vfx/first-v1/{select,depart,impact,hit,build_complete}/neutral/atlas-{128,256}.webp` | 8 cols, 24 fps | Small sparks and rings. |
| Map tiles | `terrain/@2x/{plains,grassland,forest,hills,mountain,water}_{1-3}.webp` | 176×208 | Isometric hex terrain blocks. Good for building a stylised map in motion graphics. |
| Map specials | `specials/@2x/*.webp` | 176×208 | `engine_0..5` (Engine build stages: plaza → pillars → gold frame; **the Engine is [DESIGN]**), `freecity_town`, `barbarian_1` (camp), `concord_plaza`, `seat_/relic_/waystone_<doctrine>` |
| Villages | `holdings/@2x/{hamlet,city}_{o,w}_<doctrine>.webp`, `shield.webp` | 176×208 | Top-down village clusters; `shield` is a translucent dome. |
| Fog | `fog/@2x/cloud_*`, `bank_*`, `mist_*` | 176×208 | Cloud tiles for fog-of-war reveals. |
| UI icons | `ui/illustrated/<name>-{32,64,128}.webp` | ≤128 px | Food, wood, stone, ore, horse, gold, science, influence, troops, stamina, walls, works, territory. Small: use them at icon size only. |
| Logo | `ui/logo.svg`, `ui/icons.svg` | vector | |
| Citizen portrait concept atlas | `people/wylls-citizens-v1.png`, `-v2.png` | 1448×1086, **opaque RGB**, 4×3 grid | 12 claymation-style faces in six colour-coded uniforms with sigil badges. **Older colour scheme, not the current palette** (teal, blue and magenta appear), and in a different style from the leaders. Prompt files sit beside them. Use with care. |

**Screenshots** (`docs/img/`):

- `wylls-world.png` (1440×900): the current client's world view. It shows the six-nation map around The Concord, nation standings, the spectate panel and turn 42. It is a **screen fixture with test data, not a live season**; the README's caption says so. This is the best real-UI still.
- `wylls-map.png` (1600×900): an **older M1-era client** ("Bell 1,034 · ended", different nation colours). It is not referenced by any doc. Avoid it, or label it "earlier build".

Other notes:

- `docs/pitch/` holds only DEMO_SCRIPT.md: no images.
- The tile art in `holdings/`, `factions/`, `hosts/` and `specials/` uses older sprite keys, not nation names. The client maps them by nation index: 0 Aster→`ember`, 1 Borealis→`tide`, 2 Cinder→`lumen`, 3 Dunmar→`iron`, 4 Ember→`stone`, 5 Fjordal→`verdant`. (map/sprites.mjs:275 ART_FACTIONS)
  - These keys do **not** match the doctrine names. The painted colours of these older tiles may not match the current palette, so check before you use them as nation-coloured.
- **Size limits:** apart from the soldier atlases (1920×2560) and the motion sheets, most single assets are ≤ 360 px tall. Plan for small on-screen use, or for deliberate upscaling with a stylised treatment.
