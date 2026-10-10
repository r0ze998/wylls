> Historical development record from 2026-10-04. The current pitch and submission are in PITCH.md and SUBMISSION.md.

# Wylls: hackathon submission record (repository side)

**Repository:** <https://github.com/r0ze998/wylls> (the submission branch `frontier/unify` is local and nothing is pushed; `origin/main` still shows the earlier prototype's README, so the address is not yet the entry point) · **Date of this record:** 2026-10-04 · **Project freeze:** 2026-10-12 23:59 JST · **Submit by:** 2026-10-13 15:59 JST · **Demo video:** [link pending] · **Pitch video:** [link pending]

This file is the repository's own record: what the project is, where each part lives, how to run and check it, what was built when, and where the evidence stops. The submission form text is written separately by the owner. If anything here disagrees with a recorded run, the run wins. What is submitted is the pitch, the demo, the README and this repository. By the owner's decision of 2026-10-04, development does not have to be finished by the deadline: what is built stays what it is, and the decisions of that day are the target design, written as design (section 1.1). This record therefore separates what is built from what is designed.

> **Status 2026-10-04:** local test chain only (never devnet or mainnet) · nobody outside the project has played · every number comes from tests, rule-bot runs, the Gemma 4 spike, the records of the AI runs on a separate branch (a 6-AI smoke run, `smoke-b3`, is the only run that completed with `verify-minds` passing), or simulation · AI citizens: in progress on branch `frontier/ai-integ`, not merged into this tree, the 12-AI and 18-AI runs not yet run [AS-BUILT: pending] · conquest (code on another branch, not merged), score, instant land, the 14-day season, money, governance and markets: design only.

Status tags, the same five in the same English words as in the [README](README.md): **[Running]** code exists and was actually run (for code on another branch, the text names the branch and the run); **[In progress]** being implemented or run for this hackathon; **[Design only]** written down, not built; **[Planned]** intended, no date; **[Dropped]** removed by a decision; **[Confirm]** the owner's answer is needed (question numbers refer to `docs/GAME-DESIGN.ja.md`, appendix A). In the Japanese documents they are 【動いている】【作成中】【設計のみ】【計画】【やめた】【確認】. A number that is simulator output, a model figure or an estimate is called so in words. **[AS-BUILT: pending]** is a placeholder for a result that does not exist yet (removed at the freeze, 2026-10-12; the markers to clear are listed in the freeze checklist at the end). **[OWNER: ...]** marks a fact only the owner can confirm. Sources are written 〔Source: path:line〕, paths from the repository root, with a branch prefix when the file is not on `frontier/unify`.

## 1. What the project is

**Wylls is the first playable slice of a Civ-like shared world on Solana, and a game in which AI behaves like a player.** You choose one of six nations (国) and a village (村) is given to you. Your economy runs in real time. Every province's fights resolve together at a 10-minute turn (the step at which the world resolves everything together; called a bell in the code) with public randomness, in a record anyone can replay and check, and armies march under sealed orders: the departure is public, the destination is hidden by a drand time-lock until the arrival turn. Everything ends with the season; the design is that only a chronicle carries over [Design only]. The name is the English spelling of will (意志); the question the game asks is how a game behaves when AI has will. The design lets AI citizens play under the same keys, relay quotas and fog as people, plus safety limits, with goals, a memory they can cite and a nation council; an AI citizen's own march is the headline and the council's Strike Order (攻撃命令) the second showpiece [In progress]. Tech, diplomacy, markets, governance, score and shared civilisation are designed and not built. One-page pitch: [PITCH.md](PITCH.md). Demo script: [docs/pitch/DEMO_SCRIPT.md](docs/pitch/DEMO_SCRIPT.md). Ten-minute design tour: [docs/DESIGN-OVERVIEW.md](docs/DESIGN-OVERVIEW.md) ([日本語](docs/DESIGN-OVERVIEW.ja.md)). The full game design, with a status beside every item (Japanese, awaiting the owner's confirmation): [docs/GAME-DESIGN.ja.md](docs/GAME-DESIGN.ja.md); the 48 discrepancies it resolves: [docs/GAME-DESIGN-DISCREPANCIES.ja.md](docs/GAME-DESIGN-DISCREPANCIES.ja.md).

| | Status | Evidence |
|---|---|---|
| M1 first playable: a 7-game-day season (1,008 turns, 20x, 8 h 39 min) with 1,000 rule bots of 13 profiles, real drand quicknet rounds replayed from an archive, on a local test chain; every gating criterion passed; M1 formally complete 2026-10-01 | [Running] | [M1-EXIT-NOTES](docs/frontier/m1/M1-EXIT-NOTES.md), [runs/m1-exit/](docs/frontier/m1/runs/m1-exit/), [DECISIONS U1 to U10](docs/frontier/DECISIONS.md); 〔Source: docs/frontier/m1/M1-EXIT-NOTES.md:57-58〕 |
| Replay verifier: 144,300 transactions pass; 30 of 30 deliberate tampers caught | [Running] | [verify.md](docs/frontier/m1/runs/m1-exit/verify.md), [tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md); 〔Source: docs/frontier/m1/runs/m1-exit/criteria.md:18〕 |
| Joining is one choice (a nation). Joining files a site ticket and a lottery is drawn each turn; the village appears about 11 to 21 minutes later (a model figure) and stays provisional for up to 24 turns (about 4 hours), during which it cannot muster, explore or depart | [Running]: fixtures and screen tests in this tree; run end to end on the chain only by 20 scripted browser visitors (not people) on branch `frontier/playtest` | [DECISIONS V2](docs/frontier/DECISIONS.md); 〔Source: GAME-DESIGN.ja.md §2.2; playtest:docs/frontier/playtest/PT-C-NOTES.md:31〕 |
| AI citizens: personas, memory, an AI's own march, a nation council and a sealed Strike Order, audit pages and `verify-minds`; equal numbers per nation (6 in the smoke run, 12 in the A/B test and the live recording, 18 in the main run) on a local Gemma 4; pacts and betrayal are out of the build (decision X2) | [In progress]: code on branch `frontier/ai-integ`, not in this tree; one 6-AI smoke run (`smoke-b3`) completed with `verify-minds` passing (section 5); the 12-AI A/B test and the 18-AI main run have not been run [AS-BUILT: pending] | [contract v1.3](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md); 〔Source: ai-integ:docs/frontier/ai-citizens/RUNS.md:8-37〕 |
| Conquest (keeps, sieges, occupation); territory counts in the score | [Design only] as a product. Code on branch `frontier/cq-integ` (contract v1.5, program v2): Gate CQ2 passed in that branch's tests (342 svm, 534 workspace, 573 npm); **not merged into this tree**; Waves 3 to 5 (verifier, relay, web, soak) not started; nobody and no AI has played it | [conquest contract](docs/frontier/conquest/CONQUEST-CONTRACT.md); 〔Source: cq-integ:docs/frontier/conquest/integ-CQ2-NOTES.md:226-237〕 |
| One score per nation, 14-day season, instant land, shared civilisation (tech, eras, the Engine, diplomacy), money (M2), governance and markets (M3) | [Design only]; money and the business plan [Planned] | [GAME-DESIGN.ja.md §3.13, §6, §7](docs/GAME-DESIGN.ja.md); [DESIGN-OVERVIEW §8](docs/DESIGN-OVERVIEW.md) |

### 1.1 Owner decisions of 2026-10-04 that change what this record says

Source: the owner, answers in the chat, one question at a time, evening JST; recorded as DECISIONS part Y ([Y1 to Y12](docs/frontier/DECISIONS.md); the same decisions are D1 to D12 in the design document). Standing instruction: the submission is the pitch, the demo and the README; nothing is pushed. 〔Source: docs/frontier/DECISIONS.md part Y〕

| Decision | What this record says as a result |
|---|---|
| Y1 One score per nation ranks nations at season end (territory held over time + prosperity + knowledge) | [Design only]. M1 has no score and no winner. The formula is open (weights, per-capita question) |
| Y2 AI citizens are displayed exactly like human players in the game UI, no mark (changes W2 "AI is always labelled") | [Design only]. This record does not claim that AI is always labelled. Today the main map client shows no AI mark and no AI citizens; the council/audit page and `roster.json` carry labels (`ai`, `script`, `seat`), and whether they stay is open [Confirm Q2]. Kept until the owner objects: an AI answers truthfully when sincerely asked, and the README and rules say the world contains AI-operated citizens. Legal review (for example EU AI Act Art. 50) is needed and not done. "Same rules as people" is written only with its qualification: same keys, quotas and fog, plus safety limits (12 candidates, 60 percent and 40 percent troop caps, 4 model marches a day, an autopilot that never marches) |
| Y3 Land is given at once when a player joins | [Design only]; the program is not changed. The wait described in section 1 is the current behaviour |
| Y4 A free season first, then a season with money | [Planned]; no money exists in M1 |
| Y5 Business plan written in full, with a status beside each part | Own seasons and free first [Planned]; a later entry fee in USDC with an operator share [Design only]; later AI citizens offered to game studios [Planned]; the shares and fees are under consideration until legal review; **no conversation with any studio is on record, and none is claimed** [Confirm Q18: whether the plan is also said in the pitch video and slides; it is written here under decision Y5] |
| Y6 Season length 14 days | [Design only]. Only a 7-game-day season has run; the AI main run is 3 game days at 10x; the earlier 28 days is [Dropped] |
| Y7 Conquest is part of the product design | [Design only] as a product; code on `frontier/cq-integ`, not merged (section 1) |
| Y8 to Y10 The 15 open conquest rule questions | Left open; the implemented defaults stay in force (`docs/GAME-DESIGN.ja.md` §5.7) |
| Y11a The friends' playtest is not held | [Dropped]. Nobody outside the project has played (section 5) |
| Y11b AI main run size | 18 AIs in the main run, 12 in the A/B test and the recording, 6 in the smoke run (contract v1.3). [In progress]; only the smoke run has been run |
| Y12 Opening axis: a game in which AI behaves like a player; the nation council is the second showpiece | README and PITCH open with this; the AI's own march is the headline. Nothing is claimed beyond what the runs record |

Still valid beside part Y: memory is the core of the AI citizens and is in the hackathon build (X1); pacts and betrayal are out (X2); contract v1.3 on `frontier/ai-integ` is the AI line's normative spec, its documents are in this tree (commit `19fe89c`; the copy on `frontier/ai-integ` carries later amendments, R12 and FB1 to FB5); no push, no devnet or mainnet, no paid API.

## 2. Stack and where each part lives

| Part | What it is | Where |
|---|---|---|
| Rules kernels | Deterministic Rust (`no_std`); the one source of rules for the program, simulator, verifier, bots and the browser (WebAssembly) | `permutation-rules/src/frontier/` |
| On-chain program | Solana program (SBPF v2, reproducible build); the only judge of clashes; no money | `permutation-frontier/`; ABI in `frontier-abi/`; wasm in `frontier-wasm/` |
| Balance simulator | Host-side simulator and the balance gate | `frontier-sim/` |
| Keeper | Permissionless helper: posts drand beacons, opens seals, reveals marches, resolves clashes, settles | `frontier-node/crates/keeper` ([RUN-A-KEEPER](docs/frontier/m1/RUN-A-KEEPER.md)) |
| Herald | Folds the transaction log into JSON files and a WebSocket stream; read-only | `frontier-node/crates/herald` |
| Verifier | Replays a finished season from the log; 30 tamper classes | `frontier-node/crates/verify` |
| Bots, local chain, stack | 1,000 rule bots; an in-process Solana-compatible chain (LiteSVM, 400 ms slots) with a replayable drand source; the stack runner | `frontier-node/crates/{bots,localnet,drand-replay,stack,...}` |
| Relay and SDK | Pays fees and rent inside quotas; one door for people and bots | `permutation-gateway/src/frontier` |
| Web client | Map, village, march composer, clash report that re-runs the kernel in the browser, onboarding, practice battle, spectator; JA and EN | `permutation-server/web/frontier/` |
| Design records | Design (rev 4), decisions, milestone records, contracts | `docs/frontier/` |
| Unified game design | The target design with a status beside every item, and the discrepancy table (Japanese; awaiting the owner's confirmation) | `docs/GAME-DESIGN.ja.md`, `docs/GAME-DESIGN-DISCREPANCIES.ja.md` |

Randomness and seals: drand quicknet (BLS12-381; time-lock encryption with the `tlock` crate). Local chain: LiteSVM 0.16. Toolchains: Rust 1.89.0 (root) and 1.95.0 (`frontier-node`, `svm-tests`); program builds need the Agave 3.1.9 `cargo-build-sbf`; web tests need Node 20 or later. AI layer [In progress], on branch `frontier/ai-integ` and not in this tree: llama.cpp with Gemma 4 26B A4B (Apache 2.0), run locally; the spike report used llama.cpp build b11146.

**Repo map note (decision V1).** The rename to Wylls did not touch code identifiers, crate, package or folder names, hash and signature domains, or seeds. They keep their historical `permutation-*` and `frontier-*` names; the root also holds two older folders (`permutation-state-prototype/`, `permutation-state-solana-receipt-spike/`) that CI still references.

## 3. How to run and check it

Everything below is local. Nothing needs a wallet, a devnet account or a paid service. Counts quoted are from the M1 closing tree (`864b622`); they were **not re-run on this branch for this page**, so run them yourself.

```bash
# 1. Rules kernels (no chain)
cargo test --locked --release -p permutation-rules
# 2. Balance simulator and its gate
(cd frontier-sim && cargo test --locked --release)
# 3. Relay, SDK and web client tests (529 passing at M1 close)
(cd permutation-gateway && npm ci --ignore-scripts && npm test)
# 4. Screens (51 passing at M1 close)
(cd permutation-gateway/screens && npm ci && node --test *.screen.mjs)
# 5. Program: reproducible build, then the program tests (248 passing, 4 ignored by design)
scripts/build-frontier.sh --twice          # prints the .so hash; the exit season ran d85e1bd7…2281
permutation-frontier/svm-tests/run.sh --release
# 6. Off-chain workspace tests
(cd frontier-node && cargo test --locked --workspace)
# 7. A season on the local chain, then the verifier and the tamper suite (100 bots, 1 game day)
scripts/m1-nightly.sh
```

The full `.so` hash of the exit season is in [so.sha256](docs/frontier/m1/runs/m1-exit/so.sha256). Since M1 closed, the program, ABI, rules and keeper sources changed only in doc comments (the rename), but this branch has not been rebuilt for this page, so compare the hash yourself.

**Look at the game.** This is the 100-bot nightly config (100x); the 20-bot quick stack with the scripted browser run is in [docs/RUNNING.md](docs/RUNNING.md). After the builds in `scripts/m1-nightly.sh` (`cd frontier-node && cargo build --locked --release --workspace` and `scripts/build-frontier.sh --features test-beacon`), start a stack and open the herald:

```bash
frontier-node/target/release/frontier-stack check-ports --config frontier-node/configs/nightly.toml
frontier-node/target/release/frontier-stack up --config frontier-node/configs/nightly.toml --run-id try
# in a browser, from a second terminal while `up` runs (about 15 to 20 minutes; ports 41000 to 41999 only):
#   http://127.0.0.1:41540/frontier/frontier/            the game
#   http://127.0.0.1:41540/frontier/frontier/practice.html   the practice battle
#   http://127.0.0.1:41540/frontier/frontier/spectate.html   the spectator view
frontier-node/target/release/frontier-stack verify --run-id try && frontier-node/target/release/frontier-stack tamper --run-id try
frontier-node/target/release/frontier-stack down --run-id try
```

On the local chain you join with the page's built-in dev wallet (a random key kept in the browser, local only); the in-game key is derived from that wallet's signature. No real wallet is involved. The entry URL `/` and `/frontier` still redirect to an older page; use the `/frontier/frontier/` path (open item, DECISIONS U6). See [docs/RUNNING.md](docs/RUNNING.md#2-the-full-local-stack-the-game-on-a-local-test-chain).

**What cannot be re-run from this repository.** The 144,300-transaction ledger of the exit season is not committed (size), so that verification is checked as a **record** ([verify.md](docs/frontier/m1/runs/m1-exit/verify.md), [tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md), [criteria.md](docs/frontier/m1/runs/m1-exit/criteria.md)), not re-run. The verifier does run on any season you start yourself (step 7).

## 4. What was built when

Disclosure: the oldest commit in this repository is dated 2026-09-21; nothing in the repository predates that date. The hackathon window opened on [OWNER: confirm the start date from the Colosseum page]. Prior work exists outside the repository.

| Period | What | Where it stands |
|---|---|---|
| **Before this repository** | The builder's earlier onchain games **0xCiv** and **0xARK** exist as separate projects. Neither is in this repository (apart from this page and [PITCH.md](PITCH.md), a text search of it finds no mention) and no part of it is submitted as hackathon work. [OWNER: confirm that no code was carried over] | Prior work, not part of this submission |
| 2026-09-21 to 09-26 | An earlier prototype, a different game (earlier-game terms: six nations, "officers", "30-second ticks", a MagicBlock rollup, "test USDC"), built and run on Solana devnet | History, section 6 |
| 2026-09-27 | Pivot to the new open-world design; rules kernels and the balance simulator (M0) | [M0-FINAL](docs/frontier/m0/M0-FINAL.md); simulator results are simulator output with assumed behaviour |
| 2026-09-27 to 10-01 | M1 ("First Bell" in the records): program, keeper, herald, relay, verifier, 1,000 bots, local chain, web client. Exit season 2026-09-30 17:45 to 10-01 02:25 JST; M1 closed on `864b622` (2026-10-01) | [Running] |
| 2026-10-02 to 10-03 | The name Wylls and the nation / village wording; joining is one choice | [Running] (fixtures and screen tests; scripted visitors only on `frontier/playtest`) |
| 2026-10-01 to 10-04 | Gemma 4 spike (a measurement on the bare model, not AI citizens); AI-citizen contract v1.1, v1.2 (memory in, pacts out) and v1.3 (wave-A rulings, 10-04); design overview and design record rev 4; the unified game design and the discrepancy table (10-04, awaiting the owner's confirmation) | spike [Running] (a lab measurement); contract and design documents [Design only] |
| 2026-10-01 to 10-04 | Conquest Waves 1 and 2 on `frontier/cq-integ` (Gate CQ1 on 10-02, Gate CQ2 on the branch's final tree) | [Running] on that branch only; not merged |
| 2026-10-04 | AI-citizen code, waves A and B, on `frontier/ai-integ`; eight run records, the last completed one `smoke-b3` (6 AIs) | [In progress]; section 5 |
| 2026-10-05 to 10-12 | Planned: A/B test (12 AIs, 10-09), main run (18 AIs, 3 game days at 10x, 10-09 to 10-10), report and `verify-minds`, recording with the presenter (10-11), local merge of `frontier/ai-integ` into this branch (10-12 morning, no push) | [In progress]; scheduled, not run |

The project was built with AI coding assistants under the owner's direction; design decisions are the owner's and are logged in [DECISIONS](docs/frontier/DECISIONS.md) (parts A and T to Y). [OWNER: confirm this wording]

## 5. Evidence and limits

Evidence, all recorded runs or tests unless marked: the exit season record ([report](docs/frontier/m1/runs/m1-exit/report.md), [criteria](docs/frontier/m1/runs/m1-exit/criteria.md), [run](docs/frontier/m1/runs/m1-exit/run.md)): 1,712 due marches all settled once, 0 stuck province-turns; 0 valid sealed marches unrevealed; 43 process kills and 43 restarts with no crash; 5,000 **simulated** viewers (a load generator) for 24 game hours with 0 errors in 3.46 million requests; every instruction within its compute budget (whole-transaction compute units for Reveal: p50 19,389, p99 22,951, max 24,050). Balance in the simulator: six nations won 15.6 to 17.4 percent of 1,500 paired seasons at 10,000 simulated wallets, after a first draft that let one nation win 99.5 percent of 600 (simulator output; behaviour is assumed). Gemma 4 spike: [REPORT](docs/frontier/ai-agents/gemma4/REPORT.md) (recorded scenes, not the AI-citizen code; the model chose a march in 1 or 9 of 20 decisions depending on one instruction line, the rule bot in 18 of 20).

AI-citizen runs (branch `frontier/ai-integ`, local test chain only; all runs are listed, aborted ones included; the file is append-only): `slice-1`, `slice-2`, `slice-3` aborted; `slice-4` complete; `smoke-b1` aborted; `smoke-b2` complete, `verify-minds` FAIL (fixed afterwards); `smoke-b3` complete, `verify-minds` PASS (before a later fix to the verifier, which has not been run on it); `smoke-b4` started 2026-10-04 21:07 JST, no end record. `smoke-b3`: 6 AIs of one persona, 86 closed turns at 10x; 52 of 52 model decisions valid, 0 fallbacks, n = 52 against the 300 the gate requires (not a gate result); by:model share at most 29.8 percent of AI actions (the rest is the autopilot's economy and duties); 10 model-chosen marches, all at camps, 9 with a clash episode in the public record (a proxy for the gate quantity Y, not yet checked against the herald's clash rows); no Strike Order adopted (9 councils closed without a quorum). 〔Source: ai-integ:docs/frontier/ai-citizens/RUNS.md:8-37; ai-integ:.local/frontier/ai/smoke-b3/report.md:13, :28, :41, :61-63 (generated, not in git)〕

Limits:

1. **Local only.** The exit season ran at 20x; the nightly run (100 bots, one game day) at 100x; the AI smoke runs at 10x; all on a local test chain. Nothing ran on devnet or mainnet; devnet cryptography costs and rent are unverified.
2. **Nobody outside the project has played.** The scripted onboarding ran with a test key and, on branch `frontier/playtest`, with 20 scripted browser visitors, which are not people. A friends' playtest was cancelled (decision Y11a); its tooling is on that branch and is not part of this tree. The runbook for a larger private devnet playtest (50 to 200 people) is a document only: not approved, not run. No registration, demand or traction figure exists.
3. **Bots, not people.** The 1,000 bots are 13 team-written profiles. Bots versus the balance simulator is not measured. 2 of 9 adversary hold kinds found nothing pending, so they were not exercised.
4. **The verifier is ours.** Anyone can run it; it is not an independent audit. 784 of the 144,300 transactions were failed transactions, reported (9 unclassified).
5. **Seal secrecy was not tested.** The exit season replayed real drand rounds from an archive (quick stacks use a test key), so the round signatures were already known; the recorded seal results show liveness and settlement, not secrecy. The AI runs use an operator-held test drand key, so their personas are not dealt by public randomness.
6. **Scale.** The design point is thousands to about 50,000 players (a model figure); the largest test is 1,000 bots.
7. **Not in this tree or not built.** Conquest is on `frontier/cq-integ`, not merged (the branches are local until pushed). AI citizens are in progress on `frontier/ai-integ`, not merged, with only a 6-AI smoke run completed. One score per nation, the 14-day season, instant land, shared civilisation, money (M2), governance and markets (M3) are design only. There is no player-paid money and there are no prizes. The business plan (section 1.1, Y5) is a plan: no studio conversation is on record and none is claimed.
8. **AI display and legal review.** The decision that AI citizens are displayed like human players (Y2) is design only; the main map client shows no AI mark and no AI citizens yet. No claim of "AI is always labelled" is made. The council/audit page and `roster.json` carry labels today (open: Q2). Legal review of how AI is disclosed (for example EU AI Act Art. 50) and of money has not been done.
9. **If AI-citizen runs are incomplete at the freeze,** or a hard gate fails (citation validity G13, episode replay G15), this record is changed to: "AI citizens: not implemented in this submission; design only." Results will be listed with run id and commit, aborted runs included.

## 6. History: the earlier prototype

An earlier prototype of this repository (then called Permutation State; six nations, officers, 30-second ticks, a MagicBlock rollup) ran a full season on Solana devnet (rules v8, season 1790355636798) and re-verified 14 of 14 checks. It is a different game and is not evidence for Wylls. Its code is on branch `codex/magicblock-playable`; its old documents are kept in [docs/earlier-prototype/](docs/earlier-prototype/INDEX.md) with their historical wording.


## 7. Freeze checklist (2026-10-12)

Markers and open items that must be cleared or resolved before this record is final:

- Every `[AS-BUILT: pending]` that stands for a result: after the merge, run `git grep -n AS-BUILT -- . ':!docs/earlier-prototype'`; replace each result placeholder with the run's result, or, if the AI-citizen runs are incomplete, replace the AI-citizen text with "AI citizens: not implemented in this submission; design only." Do not delete the lines that only explain the marker (the legends in this record, the design overview and the header table of `docs/frontier/DESIGN.md`, Appendix A of the overview, this checklist, and `docs/GAME-DESIGN.ja.md`). Files with result placeholders today: PITCH, this record, the DEMO_SCRIPT (status card and results card), the design overview (EN and JA), `docs/frontier/DESIGN.md`, the two Japanese summaries (`docs/frontier/SUMMARY.ja.md`, `docs/frontier/ai-citizens/SUMMARY.ja.md`), `docs/frontier/README.md`, DECISIONS, the contract, `docs/GAME-DESIGN.ja.md` and `docs/GAME-DESIGN-DISCREPANCIES.ja.md`. The README (EN and JA) has no result placeholder. The long status line is one string, repeated in PITCH, this record and the DEMO_SCRIPT status card (and in `pitch-materials/ONE-PAGE-BASE.md`, which lives outside this repository): change its AI clause in all of them together, compare them as text, and re-date it at every push and at the freeze. The README (EN and JA) carries a shorter status line of its own, with no placeholder: update its AI clause and date by hand at the same time.
- Every `[Confirm Qn]` / 【確認】 marker and every owner-addressed wording: run `git grep -nE '\[Confirm|【確認|owner objects|awaiting the owner|あなた' -- PITCH.md SUBMISSION.md docs/DESIGN-OVERVIEW.md docs/DESIGN-OVERVIEW.ja.md docs/pitch/DEMO_SCRIPT.md docs/frontier/SUMMARY.ja.md docs/frontier/ai-citizens/SUMMARY.ja.md`; resolve each one with the owner's answer (Q1 to Q34, Appendix A of `docs/GAME-DESIGN.ja.md`) and rewrite the sentence neutrally for a judge. The README (EN and JA) has none of these markers. Then compare the Japanese and English pairs again (README, design overview).
- `[VIDEO LINK pending]` (two placeholders, in the Videos line of README.md: the game and M1 video, and the AI-citizens video) and `[link pending]` (demo and pitch videos, in the header of this record): fill in or delete them. These are the only placeholders left in the README.
- `[OWNER: confirm that no code was carried over]`, `[OWNER: confirm this wording]` and `[OWNER: confirm the start date ...]` in section 4: owner statements that this repository cannot check. The builder statements in PITCH.md (solo; 0xCiv, 0xARK) are likewise the owner's, not checkable here [Confirm Q32].
- The contract version: at the merge of `frontier/ai-integ`, re-read line 3 of the merged contract and make every document name that version (the copy on `frontier/ai-integ` carries amendments after v1.3).
- The conquest branches `frontier/cq-*`: push them, or keep the "local until pushed" wording.
- Counts from the M1 closing tree (248 program tests, 529 npm tests, 51 screen tests, the `d85e1bd7` hash): re-run on the final tree or keep the "not re-run" wording.
- CI: a green run on the final tree, or the CI status text stays: the bullet "The CI is partly red" in the README's limits section (section 6 of README.md).
- Nothing is pushed. What a visitor sees on GitHub is `origin/main`, whose README is still the earlier prototype's; publishing `frontier/unify` needs the owner's explicit instruction [Confirm Q24]. Until then the repository address in the header of this record is not the entry point; after the push, state it as such. The repository root has an MIT `LICENSE` file (decided: MIT, Q33).

**Links:** [README](README.md) · [PITCH.md](PITCH.md) · [DEMO_SCRIPT](docs/pitch/DEMO_SCRIPT.md) · [game design (JA)](docs/GAME-DESIGN.ja.md) · [design overview](docs/DESIGN-OVERVIEW.md) · [docs index](docs/frontier/README.md) · [M1 exit report](docs/frontier/m1/M1-EXIT-NOTES.md) · [AI citizens contract v1.3](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md)
