# Wylls: hackathon submission record (repository side)

**Repository:** <https://github.com/r0ze998/wylls> (earlier devnet version and integrated local rebuild) · **Original record:** 2026-10-04; evidence update: 2026-10-11 · **Project freeze:** 2026-10-12 23:59 JST · **Submit by:** 2026-10-13 15:59 JST · **Final demo video:** [link pending] · **Final pitch video:** [link pending]

This file is the repository's own record: what the project is, where each part lives, how to run and check it, what was built when, and where the evidence stops. The submission form text is written separately by the owner. If anything here disagrees with a recorded run, the run wins. What is submitted is the pitch, the demo, the README and this repository. By the owner's decision of 2026-10-04, development does not have to be finished by the deadline: what is built stays what it is, and the decisions of that day are the target design, written as design (section 1.1). This record therefore separates what is built from what is designed.

> **Status checked 2026-10-11:** the earlier version ran on Solana devnet with test USDC and 12 operator-run rule-based members, not Gemma AI. This integrated rebuild has run conquest, a test-USDC prize path and real-Gemma AI citizens on local test chains only. The human-operated `own1` season 100 and six-AI/six-script-bot `take-1` are separate recordings. `take-1` has a `verify-minds` PASS; formal A/B and a completed 18-AI main run remain pending. Live USDC on Solana mainnet, a 25 USDC entry and 80% prize / 20% operator split are plans subject to legal review; neither version has run on mainnet.

Status tags: **[Running]** code and a recorded run exist; **[In progress]** an implementation or evaluation is unfinished; **[Design only]** written down but not built; **[Planned]** intended for a later season; **[Dropped]** removed by a decision; **[Confirm]** the owner's answer is needed. Model figures and simulations are labelled as such. **[AS-BUILT: pending]** remains only where a particular formal result is still absent. **[OWNER: ...]** marks a fact only the owner can confirm. Sources use repository paths and branch names; the raw recordings and run state are deliberately outside this repository.

## 1. What the project is

**Wylls is a shared strategy world where AI citizens can act as players.** Choose one of six nations (国), grow a village (村), and send armies under sealed orders. Fights resolve together at a ten-minute game turn; the program decides the result and the browser can recompute a clash report. Conquest changes who holds a keep. AI citizens use a local model to choose among legal actions, with a code-run fallback and an audit trail; a cited memory line shows what the model saw and named, not why it chose. The `take-1` recording shows a model-chosen march and later camp clear. The nation council exists in code, but an adopted Strike Order is not shown in the selected footage. A wider shared civilisation, final nation score, live money and governance remain plans. See the [pitch](PITCH.md), [demo record](docs/pitch/DEMO_SCRIPT.md), [design overview](docs/DESIGN-OVERVIEW.md) and [design document](docs/GAME-DESIGN.ja.md).

| | Status | Evidence |
|---|---|---|
| M1 first playable: a 7-game-day season (1,008 turns, 20x, 8 h 39 min) with 1,000 rule bots of 13 profiles, real drand quicknet rounds replayed from an archive, on a local test chain; every gating criterion passed; M1 formally complete 2026-10-01 | [Running] | [M1-EXIT-NOTES](docs/frontier/m1/M1-EXIT-NOTES.md), [runs/m1-exit/](docs/frontier/m1/runs/m1-exit/), [DECISIONS U1 to U10](docs/frontier/DECISIONS.md); 〔Source: docs/frontier/m1/M1-EXIT-NOTES.md:57-58〕 |
| Replay verifier: 144,300 transactions pass; 30 of 30 deliberate tampers caught | [Running] | [verify.md](docs/frontier/m1/runs/m1-exit/verify.md), [tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md); 〔Source: docs/frontier/m1/runs/m1-exit/criteria.md:18〕 |
| Joining: choose a nation, then use the local browser's test wallet | [Running] locally; the recorded `own1` world includes a human-operated player | [RUNNING](docs/RUNNING.md); `permutation-server/web/frontier/` |
| AI citizens: legal options, local Gemma 4 choice, coded fallback, cited public records, council and `verify-minds` | [Running] locally: six AI plus six script bots in saved `take-1`; `verify-minds` PASS. Formal A/B and completed 18-AI main result remain [In progress] | `permutation-gateway/citizens/`; recorded source map in section 5 |
| Conquest: sealed march, clash, occupation and keep transfer | [Running] locally in integrated program and web client; human-operated `own1` season 100 recorded a keep capture | `permutation-frontier/`; `frontier-node/`; [RUNNING](docs/RUNNING.md) |
| Local test-USDC entry and prize path | [Running] with valueless test tokens only; the recorded season remained active, with no final winner or payout shown | `permutation-prize/`; `permutation-gateway/scripts/prize-e2e.mjs`; [RUNNING](docs/RUNNING.md) |
| Final score per nation, target 14-day public season, instant land, shared civilisation, governance and markets | [Planned / incomplete] | [GAME-DESIGN.ja.md](docs/GAME-DESIGN.ja.md) |

### 1.1 Owner decisions of 2026-10-04, with the money-order update of 2026-10-11

Source: the owner's decisions of 2026-10-04, updated for the money order on 2026-10-11, recorded in [DECISIONS part Y](docs/frontier/DECISIONS.md). The later authorization to publish a repository PR supersedes the earlier no-push instruction for that operation.

| Decision | What this record says as a result |
|---|---|
| Y1 One score per nation ranks nations at season end (territory held over time + prosperity + knowledge) | [Design only] as a final score. The local conquest UI has territory standings and provisional prize parameters; the target formula remains open |
| Y2 AI citizens are displayed exactly like human players in the game UI, no mark (changes W2 "AI is always labelled") | [Design only] as a presentation policy. The current council audit page and `roster.json` label actor types (`ai`, `script`, `seat`); whether those labels stay is open [Confirm Q2]. This record does not claim AI is always labelled. Legal review of AI disclosure has not been done. AI actions use the same keys, relay quotas and fog as people, with additional candidate, troop and march limits and a coded fallback |
| Y3 Land is given at once when a player joins | [Design only]; current joining still uses a ticket and placement flow |
| Y4 Money order, updated 2026-10-11 | [Planned] The next public season is planned for Solana mainnet with live USDC; a free public season is not required first. The rebuild's current test-USDC mechanics are local only; live payments have not launched |
| Y5 Business plan written in full, with a status beside each part | Own public seasons [Planned]; 25 live USDC entry and 80% prize pool / 20% operator split for the next mainnet season [Planned], subject to legal review. Staking and offering AI citizens to game studios are later plans, not current features; no studio conversation is claimed. Whether the plan appears in the fixed pitch video or slides remains [Confirm Q18] |
| Y6 Season length 14 days | [Design only]. Only a 7-game-day season has completed; the planned 18-AI main run is 3 game days at 10x; the earlier 28 days is [Dropped] |
| Y7 Conquest is part of the product design | [Running] in the integrated local build; a keep transfer is visible in `own1` |
| Y8 to Y10 The 15 open conquest rule questions | Left open; the implemented defaults stay in force (`docs/GAME-DESIGN.ja.md` §5.7) |
| Y11b AI main run size | Six AI and six script bots are documented in the saved `take-1` run; other 6-AI and 12-AI runs exist. The formal A/B and completed 18-AI main result are still [In progress] |
| Y12 Opening axis: a game in which AI behaves like a player; the nation council is the second showpiece | README and PITCH open with this; the AI's own march is the headline. Nothing is claimed beyond what the runs record |

Still valid beside part Y: memory is part of the AI build (X1), without a proven causal effect on a choice; pacts and betrayal are out (X2). The rebuild has not run on devnet or mainnet and uses no paid model API. The AI contract and later amendments remain in [the AI-citizen documents](docs/frontier/ai-citizens/).

## 2. Stack and where each part lives

| Part | What it is | Where |
|---|---|---|
| Rules kernels | Deterministic Rust (`no_std`); the one source of rules for the program, simulator, verifier, bots and the browser (WebAssembly) | `permutation-rules/src/frontier/` |
| Game program | Solana program (SBPF v2); settles clashes and conquest on the local chain | `permutation-frontier/`; ABI in `frontier-abi/`; wasm in `frontier-wasm/` |
| Prize program | Local test-USDC entry, pool and claim mechanics; no live-money deployment | `permutation-prize/` |
| Balance simulator | Host-side simulator and the balance gate | `frontier-sim/` |
| Keeper | Permissionless helper: posts drand beacons, opens seals, reveals marches, resolves clashes, settles | `frontier-node/crates/keeper` ([RUN-A-KEEPER](docs/frontier/m1/RUN-A-KEEPER.md)) |
| Herald | Folds the transaction log into JSON files and a WebSocket stream; read-only | `frontier-node/crates/herald` |
| Verifier | Replays a finished season from the log; 30 tamper classes | `frontier-node/crates/verify` |
| Bots, local chain, stack | Script bots, AI fleet integration, a LiteSVM local chain and the stack runner | `frontier-node/crates/{bots,localnet,drand-replay,stack,...}` |
| Relay, x402 and AI service | Quota-limited relay, test-USDC joining, AI decisions, council, `verify-minds` | `permutation-gateway/` |
| Web client | Map, village, conquest, prize panel, clash report with browser recomputation, onboarding and practice; JA and EN | `permutation-server/web/frontier/` |
| Design records | Design (rev 4), decisions, milestone records, contracts | `docs/frontier/` |
| Unified game design | The target design with a status beside every item, and the discrepancy table (Japanese; awaiting the owner's confirmation) | `docs/GAME-DESIGN.ja.md`, `docs/GAME-DESIGN-DISCREPANCIES.ja.md` |

Randomness and seals: drand quicknet (BLS12-381; time-lock encryption with `tlock`); recorded local demos use a test beacon. Local chain: LiteSVM. Toolchains: Rust 1.89.0 (root) and 1.95.0 (`frontier-node`, `svm-tests`), Agave 3.1.9 `cargo-build-sbf` for both programs, and Node 20 or later. AI runs additionally need an external Gemma 4 GGUF and llama.cpp server; no paid model API is used. See [RUNNING.md](docs/RUNNING.md) for the current prerequisites.

**Repo map note (decision V1).** The rename to Wylls did not touch code identifiers, crate, package or folder names, hash and signature domains, or seeds. They keep their historical `permutation-*` and `frontier-*` names; the root also holds two older folders (`permutation-state-prototype/`, `permutation-state-solana-receipt-spike/`) that CI still references.

## 3. How to run and check it

The current build and local stack commands are in [RUNNING.md](docs/RUNNING.md). They use a browser test wallet and valueless test tokens, not a production wallet, devnet account or paid service. The real-model run needs an external GGUF and llama.cpp; do not start a long AI season merely to inspect the saved demo. The commands below are checks to run on the submission tree, not a claim that they all passed this revision:

```bash
# 1. Rules kernels (no chain)
cargo test --locked --release -p permutation-rules
# 2. Balance simulator and its gate
(cd frontier-sim && cargo test --locked --release)
# 3. Relay, SDK, prize and web client tests
(cd permutation-gateway && npm ci --ignore-scripts && npm test)
# 4. Browser screens (installs a browser first)
(cd permutation-gateway/screens && npm ci && npm run browser && node --test *.screen.mjs)
# 5. Both local-chain programs and their tests
scripts/build-frontier.sh --twice
permutation-frontier/svm-tests/run.sh --release
scripts/build-prize.sh
(cd permutation-prize/svm-tests && cargo test --locked)
# 6. Off-chain workspace tests
(cd frontier-node && cargo test --locked --workspace)
# 7. WebAssembly build consistency
scripts/build-wasm.sh --check
```

The M1 exit season's program hash remains in [so.sha256](docs/frontier/m1/runs/m1-exit/so.sha256). This submission adds substantial program, rules, ABI, keeper and web code after M1; that historical hash does not identify the new local demos.

**Look at the integrated game.** [RUNNING.md](docs/RUNNING.md) gives the conquest and local test-USDC stack, the optional combined AI stack, browser address and verification steps. The older 100-bot M1 nightly has a separate recipe in `scripts/m1-nightly.sh`; its herald address is:

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

On the local chain, the page's built-in dev wallet is a random key kept in the browser. Use `/frontier/frontier/` for the game. A prize-enabled local world has a faucet for test USDC; AI and script bots join by operator invitation and are not prize-eligible. See [RUNNING.md](docs/RUNNING.md) for the current paths and flags.

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
| 2026-10-01 to 10-04 | Conquest Waves 1 and 2 on `frontier/cq-integ` (Gate CQ1 on 10-02, Gate CQ2 on the branch's final tree) | Historical development branches; the current integrated tree includes later conquest work |
| 2026-10-04 snapshot | AI-citizen code, waves A and B, on `frontier/ai-integ`; eight run records through the then-current `smoke-b3` (6 AIs) | [In progress]; later runs in section 5 |
| 2026-10-05 to 10-11 | Later 6-AI smoke and 12-AI pilot/recording runs; an 18-AI main attempt aborted. The integrated local `take-1` six-AI/six-script-bot run recorded a model-chosen march and `verify-minds` PASS; a separate human-operated `own1` run recorded conquest and a test-USDC prize panel | [Running] locally for the recorded scenes; formal A/B and a completed 18-AI main result remain [In progress] |

The project was built with AI coding assistants under the owner's direction; design decisions are the owner's and are logged in [DECISIONS](docs/frontier/DECISIONS.md) (parts A and T to Y). [OWNER: confirm this wording]

## 5. Evidence and limits

### Recorded demo sources (local test chains)

| Scene source | Code revision | What the saved record supports |
|---|---|---|
| Human-operated `own1`, season 100 | `fa13d486be4a01547eced3bbb8977aad2f106e6f` | A browser player built, sent a sealed march, saw clashes and a keep transfer; browser recomputation showed six passing checks and a lower `Match`. This world had no bots or AI. Its prize panel used test USDC; the season was still active, with no final winner or payout shown. |
| AI `take-1` | `aae47bdbaf0c3c00883ec5d7e7befad0120917dd` | Six local Gemma 4 AI citizens and six separate script bots. Senasha's turn-65 `by: model` decision `881d797c0aa5dc3e72951a9d5e946afc845e08de5c5c211da29ccfb5bc256183` sent a march and build; its result links a turn-68 clash and camp clear. The saved `verify-minds` verdict is PASS. No human action triggered this decision. |

The silent seven-scene editing preview combines those **separate** worlds. Its no-added-text candidate has SHA-256 `a584ee6ade11c14947f9ea1a39d01d972e111d3972b3b0c326280b86ab3637b2` and is not an uploaded final demo. In the `own1` scene, a deliberate 72-turn local clock advance separates clash from keep capture and must be disclosed with any published cut. The proof panel's upper `Unverified` badge remained stale despite its passing checks and lower `Match`; describe the recomputation result, not a verified badge. The AI cited memory from earlier public events, but that alone does not prove memory caused its choice. No same-world human-to-AI response, adopted Strike Order, final winner or payout is shown. The final demo and pitch URLs remain pending. The video files, local run state and credentials are not part of this repository.

Evidence, all recorded runs or tests unless marked: the exit season record ([report](docs/frontier/m1/runs/m1-exit/report.md), [criteria](docs/frontier/m1/runs/m1-exit/criteria.md), [run](docs/frontier/m1/runs/m1-exit/run.md)): 1,712 due marches all settled once, 0 stuck province-turns; 0 valid sealed marches unrevealed; 43 process kills and 43 restarts with no crash; 5,000 **simulated** viewers (a load generator) for 24 game hours with 0 errors in 3.46 million requests; every instruction within its compute budget (whole-transaction compute units for Reveal: p50 19,389, p99 22,951, max 24,050). Balance in the simulator: six nations won 15.6 to 17.4 percent of 1,500 paired seasons at 10,000 simulated wallets, after a first draft that let one nation win 99.5 percent of 600 (simulator output; behaviour is assumed). Gemma 4 spike: [REPORT](docs/frontier/ai-agents/gemma4/REPORT.md) (recorded scenes, not the AI-citizen code; the model chose a march in 1 or 9 of 20 decisions depending on one instruction line, the rule bot in 18 of 20).

Earlier AI-citizen runs (local test chain only; the append-only list on `frontier/ai-run` includes aborted and failed runs): `slice-1`, `slice-2`, `slice-3` aborted; `slice-4` complete; `smoke-b1` aborted; `smoke-b2` complete, `verify-minds` FAIL (fixed afterwards); `smoke-b3` complete, `verify-minds` PASS (before a later fix to the verifier, which has not been run on it); `smoke-b4` later completed with `verify-minds` FAIL. Later 6-AI smoke and 12-AI pilot/recording runs include completed PASS results; an 18-AI main attempt was aborted, so the formal A/B comparison and completed main result remain pending. As an early example, `smoke-b3` had 6 AIs of one persona, 86 closed turns at 10x; 52 of 52 model decisions valid, 0 fallbacks, n = 52 against the 300 the gate requires (not a gate result); by:model share at most 29.8 percent of AI actions (the rest is the autopilot's economy and duties); 10 model-chosen marches, all at camps, 9 with a clash episode in the public record (a proxy for the gate quantity Y, not yet checked against the herald's clash rows); no Strike Order adopted in that run (9 councils closed without a quorum). 〔Source: ai-run:docs/frontier/ai-citizens/RUNS.md:8-86; ai-run:docs/frontier/ai-citizens/RESULTS-2026-10.md §0; ai-integ:.local/frontier/ai/smoke-b3/report.md:13, :28, :41, :61-63 (generated, not in git)〕

Limits:

1. **Rebuild local only.** M1, conquest, test-USDC and real-model AI results here come from local test chains. The rebuild has not run on devnet or mainnet; mainnet live-USDC operation is planned. The earlier version's devnet/test-USDC run is recorded in section 6.
2. **Onboarding and playtest runbook.** The scripted onboarding ran with a test key and, on branch `frontier/playtest`, with 20 scripted browser visitors, which are not people. The runbook for a larger private devnet playtest (50 to 200 people) is a document only: not approved, not run. No registration, demand or traction figure exists.
3. **Bots, not people.** The 1,000 bots are 13 team-written profiles. Bots versus the balance simulator is not measured. 2 of 9 adversary hold kinds found nothing pending, so they were not exercised.
4. **The verifier is ours.** Anyone can run it; it is not an independent audit. 784 of the 144,300 transactions were failed transactions, reported (9 unclassified).
5. **Seal secrecy was not tested.** The exit season replayed real drand rounds from an archive (quick stacks use a test key), so the round signatures were already known; the recorded seal results show liveness and settlement, not secrecy. The AI runs use an operator-held test drand key, so their personas are not dealt by public randomness.
6. **Scale.** The design point is thousands to about 50,000 players (a model figure); the largest test is 1,000 bots.
7. **Built locally versus planned.** This tree includes conquest, AI citizens, x402 joining and a test-USDC prize path. Formal AI A/B and a completed 18-AI main result remain pending. The final per-nation score, target 14-day public season, instant land, shared civilisation, governance, markets, staking and live-USDC deployment are not demonstrated by these runs. No studio conversation is claimed.
8. **AI display and legal review.** The planned game presentation of AI citizens (Y2) is distinct from the council audit page and `roster.json`, which label actor types today (open: Q2). No claim of "AI is always labelled" is made. Legal review of disclosure and live money has not been done.
9. **Run verdicts are scoped.** `take-1` passed its saved `verify-minds` checks. A later `take-2` was reported to fail one item after early speech publication and is not used as a PASS example; no `take-3` result is claimed. This does not complete the formal A/B or 18-AI gate.

## 6. History: the earlier prototype

An earlier prototype of this repository (then called Permutation State; six nations, officers, 30-second ticks, a MagicBlock rollup) ran 180 turns on Solana devnet with test USDC (rules v8, season 1790355636798) and re-verified 14 of 14 checks. Its 12 operator-run members followed fixed rules; they were not the current Gemma AI citizens. This history is not evidence that the rebuild ran on devnet. Its code is on `codex/magicblock-playable`; [historical documents](docs/earlier-prototype/INDEX.md) retain their original wording.


## 7. Freeze checklist (2026-10-12)

Open items before the submission record can be frozen:

- Add the final demo and pitch URLs only after the owner provides and checks them. The local preview and older samples are not substitutes.
- Report the CI result for this exact submission revision and keep any failing check visible. Historical M1 test counts and hashes do not prove this revision passed.
- Keep the formal AI A/B and completed 18-AI main result pending unless their own run records support a result. Do not turn the recorded `take-1` PASS into a claim about those larger gates.
- Resolve owner-only facts in section 4, including earlier-code carryover, the hackathon start date and AI-assistant wording, from the owner. Do not infer them from this repository.
- Recheck status text across README, the demo record and other current documents before publishing. Keep local keys, model files, run state and video assets out of the Git diff.

**Links:** [README](README.md) · [PITCH.md](PITCH.md) · [DEMO_SCRIPT](docs/pitch/DEMO_SCRIPT.md) · [game design (JA)](docs/GAME-DESIGN.ja.md) · [design overview](docs/DESIGN-OVERVIEW.md) · [docs index](docs/frontier/README.md) · [M1 exit report](docs/frontier/m1/M1-EXIT-NOTES.md) · [AI citizens contract v1.3](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md)
