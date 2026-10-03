# Wylls: pitch

> **Status 2026-10-03:** local test chain only (never devnet or mainnet) · no outside person has played yet · every number comes from tests, rule-bot runs, the Gemma 4 spike or simulation · AI citizens are designed, not built [AS-BUILT: pending] · money, governance and markets are not built.

Wylls is a shared Civilization-style world on Solana. You choose one of six nations (国); a village (村) is placed for you; your economy runs in real time; armies march under sealed orders; every province's fights resolve together at a 10-minute bell (鐘), with a public record anyone can replay and check. Everything ends with the season. The full design, with every claim tagged, is [docs/DESIGN-OVERVIEW.md](docs/DESIGN-OVERVIEW.md) ([日本語](docs/DESIGN-OVERVIEW.ja.md)). Tags used below: **[measured]** a recorded run or test, **[built this week]** merged and checked by tests and screen fixtures only, **[designed]** written down, not built, **[sim]** simulator output with assumed behaviour, **[model]** a cost or scale model, **[estimate]** a back-of-envelope figure.

## The problem

A new online strategy world starts empty, and an empty world is not fun. [our premise: not measured here, no outside evidence is cited in this repository] One way to fill it is with bots that pretend to be people; we refuse that (decision W2: AI is labelled, never hidden). We also want a game that ends cleanly, so a season ends for everyone and only its chronicle carries over (T1).

## The thesis

**Wylls is the English spelling of will (意志).** The question the game asks is a thought experiment: *how does a game behave when AI has will?* The test: let labelled **AI citizens** play under the same rules, keys and limits as people, give them lasting goals, recorded promises and memory in code, and report what happens, including failure. [designed: [DESIGN-OVERVIEW §2](docs/DESIGN-OVERVIEW.md)]

## What is built, and what is not

| Part | Status | Evidence |
|---|---|---|
| First playable (M1): one 7-game-day season, 1,008 bells at 20x, **1,000 rule bots** of 13 profiles, real drand quicknet rounds replayed from an archive, **local test chain** | [measured] every gating criterion passed | [M1-EXIT-NOTES](docs/frontier/m1/M1-EXIT-NOTES.md), [runs/m1-exit](docs/frontier/m1/runs/m1-exit/) |
| On-chain program (50 instructions, 17 account kinds), keepers, herald, relay, bots, web client (JA/EN) | [measured] on the M1 closing tree `864b622` (not re-run on this branch): 248 program tests, 529 web tests, 51 screen tests passing | [M1-EXIT-NOTES](docs/frontier/m1/M1-EXIT-NOTES.md) §2, §6 |
| Replay verifier | [measured] passed 144,300 transactions; **30 of 30** deliberate tampers caught | [verify.md](docs/frontier/m1/runs/m1-exit/verify.md), [tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md) |
| Joining is one choice (a nation); the first village is placed for you | [built this week] fixtures only, never with people | [DECISIONS V2](docs/frontier/DECISIONS.md) |
| Conquest (keeps, sieges, occupation) | in progress on branches `frontier/cq-*`, **not in this branch**, no result quoted | [conquest contract](docs/frontier/conquest/CONQUEST-CONTRACT.md) |
| **AI citizens** | [designed], nothing built yet [AS-BUILT: pending] | [contract v1.1](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md) |
| Money (M2), society (M3: governance, markets, the shared Engine) | [designed], not built | [DESIGN-OVERVIEW §8](docs/DESIGN-OVERVIEW.md) |

In the balance simulator the first draft let one nation win 99.5 percent of 600 seasons; after tuning, six nations won 15.6 to 17.4 percent of 1,500 paired seasons at 10,000 simulated wallets. [sim: player behaviour is assumed, not measured] ([M0-FINAL](docs/frontier/m0/M0-FINAL.md))

## Why a chain

The program, not an operator, resolves every clash. By design no one can read or change a sealed order before its arrival bell: the departure is public, the destination is hidden by a drand time-lock. (In the exit season the drand rounds were replayed from an archive, so secrecy itself was not tested; the measured results show liveness and settlement.) The whole season is a public log that anyone can replay and check; our verifier replayed the exit season and caught every deliberate tamper (our own verifier, run on a local chain). That, not speed or cost, is the reason for a chain here. [measured + designed rule] Nothing ran on devnet; devnet costs and rent are unverified.

## The AI-citizen idea

AI citizens are designed, not built yet. [AS-BUILT: pending] The design: labelled AI players, 2 per nation, on a local Gemma 4 model, under the same rules, keys and limits as people; **the code offers legal options, the model chooses, the code checks the choice, and a rule autopilot plays if anything fails.** AI never holds keys; no paid API. Each has a persona, a creed, goals, memory and a public card; they argue and vote in their nation's council on one of three code-made targets. [designed]

We designed it this way because of what we measured: in our spike, the bare local model was **not a better player than the rule bot**. It chose a march in 1, 9 or 12 of 20 decisions depending on the setup, against 18 of 20 for the rule bot; its best setup gave 79 percent valid actions; it needs about 5 s of compute per decision. So the guarantees live in code and the model only chooses among legal options. [measured: [Gemma 4 spike](docs/frontier/ai-agents/gemma4/REPORT.md)] Failure is defined in advance: under 95 percent valid choices over at least 300 decisions, more than 5 percent fallbacks, any hijack in the 17-case injection suite, or an A/B test that does not reproduce. Results: **[AS-BUILT: pending]**.

## The plan

| When | What | Status |
|---|---|---|
| to 2026-10-12 (freeze 23:59 JST) | AI citizens: personas, council, sealed Call, audit, A/B test, recording. If the runs are incomplete, the submission says "AI citizens: not implemented in this submission; design only." | designed, scheduled |
| in parallel | Conquest wave 2, so the map moves through play | in progress |
| first after the hackathon | Shared civilisation: the Engine (the central shared building), tech ceiling, diplomacy | designed |
| later | Money (M2: entry fees, stakes, prize pools), society (M3). Seasons without money come first. There is no player-paid money in the game today. | designed, not built |

**People.** No outside person has played Wylls. A small invite-only local playtest is being prepared and has not run. [PLAYTEST RESULT pending] A larger private devnet playtest has a runbook only: not approved, not run.

**Builder.** r0ze, solo (the owner's statement, not checkable in the repository). Earlier onchain games 0xCiv and 0xARK exist; see [SUBMISSION.md](SUBMISSION.md) for what is prior work. The earlier prototype of this repository, a different game that ran a full season on Solana devnet, is history on branch `codex/magicblock-playable` ([docs/earlier-prototype/](docs/earlier-prototype/INDEX.md)).

**Links:** [README](README.md) · [design overview](docs/DESIGN-OVERVIEW.md) · [submission](SUBMISSION.md) · [demo script](docs/pitch/DEMO_SCRIPT.md) · [decisions log](docs/frontier/DECISIONS.md)
