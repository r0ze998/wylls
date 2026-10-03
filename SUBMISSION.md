# Wylls: hackathon submission record (repository side)

**Repository:** <https://github.com/r0ze998/wylls> · **Date of this record:** 2026-10-03 · **Project freeze:** 2026-10-12 23:59 JST · **Submit by:** 2026-10-13 15:59 JST · **Demo video:** [link pending] · **Pitch video:** [link pending]

This file is the repository's own record: what the project is, where each part lives, how to run and check it, what was built when, and where the evidence stops. The submission form text is written separately by the owner. If anything here disagrees with a recorded run, the run wins.

> **Status 2026-10-03:** local test chain only (never devnet or mainnet) · no outside person has played yet · every number comes from tests, rule-bot runs, the Gemma 4 spike or simulation · AI citizens are designed, not built [AS-BUILT: pending] · money, governance and markets are not built.

Tags: **[measured]** a recorded run or test, with its source; **[code]** a rule read from tested code, not a play result; **[sim]** simulator output with assumed behaviour; **[model]** a cost or scale model; **[estimate]** a back-of-envelope figure; **[built this week]** merged since the M1 exit (2026-10-01) and checked by tests and screen fixtures only; **[designed]** written down, not built; **[in progress]** on branches, not in this tree; **[AS-BUILT: pending]** a placeholder for a result that does not exist yet (removed at the freeze, 2026-10-12; the full list of markers to clear is in the freeze checklist at the end).

## 1. What the project is

Wylls is a Civ-like world on Solana that everyone shares. You choose one of six nations (国) and a village (村) is placed for you. Your economy runs in real time. Armies march under sealed orders (the departure is public, the destination is hidden by a drand time-lock until the arrival bell), and every province's fights resolve together at a 10-minute bell (鐘) with public randomness, in a record anyone can replay and check. Everything ends with the season; only the chronicle carries over. The name is the English spelling of will (意志); the question the game asks is how a game behaves when AI has will, and the plan is to let labelled AI citizens play under the same rules as people. One-page pitch: [PITCH.md](PITCH.md). Demo script: [docs/pitch/DEMO_SCRIPT.md](docs/pitch/DEMO_SCRIPT.md). Ten-minute design tour: [docs/DESIGN-OVERVIEW.md](docs/DESIGN-OVERVIEW.md) ([日本語](docs/DESIGN-OVERVIEW.ja.md)).

| | Status | Evidence |
|---|---|---|
| M1 first playable: a 7-game-day season (1,008 bells, 20x, 8 h 39 min) with 1,000 rule bots of 13 profiles, real drand quicknet rounds replayed from an archive, on a local test chain; every gating criterion passed; M1 formally complete 2026-10-01 | [measured] | [M1-EXIT-NOTES](docs/frontier/m1/M1-EXIT-NOTES.md), [runs/m1-exit/](docs/frontier/m1/runs/m1-exit/), [DECISIONS U1 to U10](docs/frontier/DECISIONS.md) |
| Replay verifier: 144,300 transactions pass; 30 of 30 deliberate tampers caught | [measured] | [verify.md](docs/frontier/m1/runs/m1-exit/verify.md), [tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md) |
| Joining is one choice (a nation); the first village is placed for you and appears at the next bell (about 11 to 21 minutes, a model figure) | [built this week] fixtures only | [DECISIONS V2](docs/frontier/DECISIONS.md) |
| Conquest (keeps, sieges, occupation) | in progress on branches `frontier/cq-*`; **not in this branch**, no result quoted | [conquest contract](docs/frontier/conquest/CONQUEST-CONTRACT.md) |
| AI citizens: 12 labelled AIs (2 per nation) on a local Gemma 4, council, sealed Call, audit | [designed]; implementation scheduled before the freeze; nothing built yet [AS-BUILT: pending] | [contract v1.1](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md) |
| Money (M2), governance, the Engine, markets (M3) | [designed], not built | [DESIGN-OVERVIEW §8](docs/DESIGN-OVERVIEW.md) |

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

Randomness and seals: drand quicknet (BLS12-381; time-lock encryption with the `tlock` crate). Local chain: LiteSVM 0.16. Toolchains: Rust 1.89.0 (root) and 1.95.0 (`frontier-node`, `svm-tests`); program builds need the Agave 3.1.9 `cargo-build-sbf`; web tests need Node 20 or later. Designed AI layer (not built): llama.cpp with Gemma 4 26B A4B (Apache 2.0), run locally; the spike report used llama.cpp build b11146.

**Repo map note (decision V1).** The rename to Wylls did not touch code identifiers, crate, package or folder names, hash and signature domains, or seeds. They keep their historical `permutation-*` and `frontier-*` names; the root also holds two older folders (`permutation-state-prototype/`, `permutation-state-solana-receipt-spike/`) that CI still references.

## 3. How to run and check it

Everything below is local. Nothing needs a wallet, a devnet account or a paid service. Counts quoted are from the M1 closing tree (`864b622`); they were **not re-run on this branch for this page**, so run them yourself. A later `npm test` on this tree reported 574 of 574 (not recorded in a file).

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

On the local chain you join with the page's built-in dev wallet (a random key kept in the browser, local only); the in-game key is derived from that wallet's signature. No real wallet is involved. The entry URL `/` and `/frontier` still redirect to an older page; use the `/frontier/frontier/` path (open item, DECISIONS U6). Known issue: the herald does not serve the painted art (its file handler rejects the `@` in `art/*/@1x/`), so the map on the herald URL is plainer than the README screenshot; see [docs/RUNNING.md](docs/RUNNING.md#2-the-full-local-stack-the-game-on-a-local-test-chain).

**What cannot be re-run from this repository.** The 144,300-transaction ledger of the exit season is not committed (size), so that verification is checked as a **record** ([verify.md](docs/frontier/m1/runs/m1-exit/verify.md), [tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md), [criteria.md](docs/frontier/m1/runs/m1-exit/criteria.md)), not re-run. The verifier does run on any season you start yourself (step 7).

## 4. What was built when

Disclosure: the oldest commit in this repository is dated 2026-09-21; nothing in the repository predates that date. The hackathon window opened on [OWNER: confirm the start date from the Colosseum page]. Prior work exists outside the repository.

| Period | What | Where it stands |
|---|---|---|
| **Before this repository** | The builder's earlier onchain games **0xCiv** and **0xARK** exist as separate projects. Neither is in this repository (apart from this page and [PITCH.md](PITCH.md), a text search of it finds no mention) and no part of it is submitted as hackathon work. [OWNER: confirm that no code was carried over] | Prior work, not part of this submission |
| 2026-09-21 to 09-26 | An earlier prototype, a different game (earlier-game terms: six nations, "officers", "30-second ticks", a MagicBlock rollup, "test USDC"), built and run on Solana devnet | History, section 6 |
| 2026-09-27 | Pivot to the new open-world design; rules kernels and the balance simulator (M0) | [M0-FINAL](docs/frontier/m0/M0-FINAL.md); simulator results are [sim] |
| 2026-09-27 to 10-01 | M1 "First Bell": program, keeper, herald, relay, verifier, 1,000 bots, local chain, web client. Exit season 2026-09-30 17:45 to 10-01 02:25 JST; M1 closed on `864b622` (2026-10-01) | [measured] |
| 2026-10-02 to 10-03 | The name Wylls and the nation / village wording; joining is one choice | [built this week] |
| 2026-10-01 to 10-03 | Gemma 4 spike (a measurement on the bare model, not AI citizens); AI-citizen contract v1.1; design overview and design record rev 4 | spike [measured]; contract [designed] |
| 2026-10-03 to 10-12 | AI citizens: personas, council, sealed Call, audit, A/B test, recording. Conquest wave 2 in parallel on `frontier/cq-*` | [designed] / in progress; not built today |

The project was built with AI coding assistants under the owner's direction; design decisions are the owner's and are logged in [DECISIONS](docs/frontier/DECISIONS.md) (parts A and T to W). [OWNER: confirm this wording]

## 5. Evidence and honest limits

Evidence, all [measured] unless marked: the exit season record ([report](docs/frontier/m1/runs/m1-exit/report.md), [criteria](docs/frontier/m1/runs/m1-exit/criteria.md), [run](docs/frontier/m1/runs/m1-exit/run.md)): 1,712 due marches all settled once, 0 stuck province-bells; 0 valid sealed marches unrevealed; 43 process kills and 43 restarts with no crash; 5,000 **simulated** viewers (a load generator) for 24 game hours with 0 errors in 3.46 million requests; every instruction within its compute budget (whole-transaction compute units for Reveal: p50 19,389, p99 22,951, max 24,050). Balance in the simulator: six nations won 15.6 to 17.4 percent of 1,500 paired seasons at 10,000 simulated wallets, after a first draft that let one nation win 99.5 percent of 600 [sim; behaviour is assumed]. Gemma 4 spike: [REPORT](docs/frontier/ai-agents/gemma4/REPORT.md).

Limits:

1. **Local only.** The exit season ran at 20x; nightlies and smoke runs at 100x; all on a local test chain. Nothing ran on devnet or mainnet; devnet cryptography costs and rent are unverified.
2. **No human has played.** The scripted onboarding ran with a test key, not with people. A small invite-only local playtest is being prepared and has not run. [PLAYTEST RESULT pending] The runbook for a larger private devnet playtest (50 to 200 people) is a document only: not approved, not run. No registration, demand or traction figure exists.
3. **Bots, not people.** The 1,000 bots are 13 team-written profiles. Bots versus the balance simulator is not measured. 2 of 9 adversary hold kinds found nothing pending, so they were not exercised.
4. **The verifier is ours.** Anyone can run it; it is not an independent audit. 784 of the 144,300 transactions were failed transactions, reported (9 unclassified).
5. **Seal secrecy was not tested.** The exit season replayed real drand rounds from an archive (quick stacks use a test key), so the round signatures were already known; the measured seal results show liveness and settlement, not secrecy.
6. **Scale.** The design point is thousands to about 50,000 players [model]; the largest test is 1,000 bots.
7. **Conquest is not in this branch** (the `frontier/cq-*` branches are local until pushed). **AI citizens are designed, not built.** Money (M2), governance, the Engine and markets (M3) are not built. There is no player-paid money and there are no prizes.
8. **If AI-citizen runs are incomplete at the freeze,** this record is changed to: "AI citizens: not implemented in this submission; design only." Results will be listed with run id and commit, aborted runs included.

## 6. History: the earlier prototype

An earlier prototype of this repository (then called Permutation State; six nations, officers, 30-second ticks, a MagicBlock rollup) ran a full season on Solana devnet (rules v8, season 1790355636798) and re-verified 14 of 14 checks. It is a different game and is not evidence for Wylls. Its code is on branch `codex/magicblock-playable`; its old documents are kept in [docs/earlier-prototype/](docs/earlier-prototype/INDEX.md) with their historical wording.

## 7. Freeze checklist (2026-10-12)

Markers and open items that must be cleared or resolved before this record is final:

- Every `[AS-BUILT: pending]` (here, in the README, PITCH and the design overview): replace with the run's result, or, if the AI-citizen runs are incomplete, replace the AI-citizen text with "AI citizens: not implemented in this submission; design only."
- `[VIDEO LINK pending]` / `[link pending]` (demo and pitch videos) and `[PLAYTEST RESULT pending]`: fill in or delete the line.
- `[OWNER: confirm that no code was carried over]`, `[OWNER: confirm this wording]` and `[OWNER: confirm the start date ...]` in section 4: owner statements that this repository cannot check. The builder statements in PITCH.md (solo; 0xCiv, 0xARK) are likewise the owner's, not checkable here.
- The conquest branches `frontier/cq-*`: push them, or keep the "local until pushed" wording.
- Counts from the M1 closing tree (248 program tests, 529 npm tests, 51 screen tests, the `d85e1bd7` hash): re-run on the final tree or keep the "not re-run" wording.
- CI: a green run on the final tree, or the honest-limits paragraph in the README stays.

**Links:** [README](README.md) · [PITCH.md](PITCH.md) · [DEMO_SCRIPT](docs/pitch/DEMO_SCRIPT.md) · [design overview](docs/DESIGN-OVERVIEW.md) · [docs index](docs/frontier/README.md) · [M1 exit report](docs/frontier/m1/M1-EXIT-NOTES.md) · [AI citizens contract](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md)
