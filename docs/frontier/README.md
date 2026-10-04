# Wylls: design, decisions and milestone records

The documents behind Wylls, the open-world civilization game on Solana: six nations, a village placed for you, real-time economy, combat resolved at 10-minute bells, sealed marches. Start with the unified game design (canonical), then the overview.

**Canonical source for the game design: [../GAME-DESIGN.ja.md](../GAME-DESIGN.ja.md)** (Japanese, the unified design with the current state beside every item; draft of 2026-10-04, not yet confirmed by the project owner). The list of 48 discrepancies between the older documents, with how each is resolved: [../GAME-DESIGN-DISCREPANCIES.ja.md](../GAME-DESIGN-DISCREPANCIES.ja.md). Where a document in this folder differs from the unified design, the unified design wins. The owner's decisions of 2026-10-04 are recorded in [DECISIONS.md](DECISIONS.md), part Y.

Status words used across these documents: **[measured]** (a result with its source), **[built this week]**, **[designed]** (not built). The unified design uses five state tags instead: built and run (動いている), in progress for this hackathon (作成中), design only (設計のみ), plan (計画), dropped (やめた). M1 (first playable, no money) is complete and was tested only on a local test chain, played by rule bots; nobody outside the project has played. Conquest exists as code on branch `frontier/cq-integ` (Gate CQ2 green; Waves 3 to 5 not started) and is not in this tree. Money (M2) and society (M3) are design only. AI citizens: contract v1.3 is in this tree; the code is on branch `frontier/ai-integ` (smoke test with 6 AIs run, not merged into this tree); results are marked `[AS-BUILT: pending]` until the merge and the runs.

Identifiers keep their historical names (decision V1): crate, folder, file and package names (for example `permutation-rules`, `permutation-frontier`, `frontier-node`), hash and signature domains, and seeds were not renamed. Paths written as `(session scratch)/…` point to lab files from the working session; they are not in the repository.

## Start here

First [../GAME-DESIGN.ja.md](../GAME-DESIGN.ja.md) (the canonical game design, Japanese; its chapter 0 says what to read) and its discrepancy table [../GAME-DESIGN-DISCREPANCIES.ja.md](../GAME-DESIGN-DISCREPANCIES.ja.md). Then three documents, about ten minutes: [../DESIGN-OVERVIEW.md](../DESIGN-OVERVIEW.md) ([日本語](../DESIGN-OVERVIEW.ja.md)) (the game, its evidence and its limits), [m1/M1-EXIT-NOTES.md](m1/M1-EXIT-NOTES.md) (what is built, with every item's evidence) and [ai-citizens/AI-CITIZENS-CONTRACT.md](ai-citizens/AI-CITIZENS-CONTRACT.md) (what is designed). Everything else below is reference.

## Reference

- [../GAME-DESIGN.ja.md](../GAME-DESIGN.ja.md): the unified game design (canonical); [../GAME-DESIGN-DISCREPANCIES.ja.md](../GAME-DESIGN-DISCREPANCIES.ja.md): the 48 discrepancies and their resolution.
- [SUMMARY.ja.md](SUMMARY.ja.md): the short plain-Japanese status summary, aligned with the unified design. The earlier revision 3.1 summary is kept as history in [SUMMARY.ja.rev3.1.md](SUMMARY.ja.rev3.1.md).
- [DESIGN.md](DESIGN.md): the engineering specification (English), revision 4 (2026-10-03): revision 3.1 and the M1 amendments (§0.4-§0.6, §18-§23) with nation / village terms and AI citizens in place of the retired hidden bots. It is the technical reference. Its sections on loot, raids, occupation tribute, up to three villages per wallet, Shades, the daily council and 28-day prices are superseded or target design; see the banner at the top of the file and the unified design.
- [DECISIONS.md](DECISIONS.md): the decisions log. Parts T–Y are the latest: T (everything ends with the season), U (the M1 exit), V (the name Wylls; joining is choosing a nation), W (one game; AI citizens replace hidden bots; words nation / village; W2, always labelling AI, is changed by Y2), X (2026-10-04: AI-citizen memory is in the build, pacts and betrayal between AIs are out, machine windows, the main run of 3 game days with 18 AIs), Y (the owner's decisions of 2026-10-04: total score per nation, AI shown without a mark, immediate first land, free season first, business plan, 14-day season, conquest in the design, friends' playtest cancelled, 18 AIs, opening axis).
- [m1/runs/m1-exit/](m1/runs/m1-exit/): the exit season's record.

## Milestone records

- **M1, "First Bell" (complete, 2026-10-01):**
  - [m1/M1-EXIT-NOTES.md](m1/M1-EXIT-NOTES.md): the exit report (every item with its evidence, findings, open items before a playtest).
  - [m1/M1-EXIT.ja.md](m1/M1-EXIT.ja.md): the same, in plain Japanese.
  - [m1/runs/m1-exit/](m1/runs/m1-exit/): the exit season's record (7 game days, 1,000 rule bots, local test chain).
  - [m1/M1-CONTRACT.md](m1/M1-CONTRACT.md): the implementation contract (v1.13). `m1/*-NOTES.md` are the unit and integration reports.
  - [m1/RUN-A-KEEPER.md](m1/RUN-A-KEEPER.md): how to run a keeper on the local stack, and what a public network still needs.
  - [m1/PLAYTEST-RUNBOOK.md](m1/PLAYTEST-RUNBOOK.md): the private devnet playtest's configuration and steps. **Not approved, not run** (a larger devnet playtest of 50 to 200 people). The small invite-only friends' playtest is cancelled (decision Y11a); nobody outside the project has played.
  - [m1/c4-v3/](m1/c4-v3/): the fee-attack cost model v3 with the measured Reveal compute cost.
- **Conquest (design; code on a branch):** [conquest/](conquest/). Keeps, sieges and occupation, so that the map moves through play. Conquest is in the product design and territory counts in the score (decision Y7). The code is on branch `frontier/cq-integ` (contract v1.5, program v2, Gate CQ2 green); Waves 3 to 5 are not started; it is not merged into this tree. The files here ([conquest/SUMMARY.ja.md](conquest/SUMMARY.ja.md), [conquest/CONQUEST-CONTRACT.md](conquest/CONQUEST-CONTRACT.md), `conquest/design/`) are an older copy (v1.1); the `frontier/cq-integ` copy is authoritative. See the unified design, chapter 5.
- **AI citizens (in progress; code on a branch):** [ai-citizens/](ai-citizens/). [ai-citizens/AI-CITIZENS-CONTRACT.md](ai-citizens/AI-CITIZENS-CONTRACT.md) (the implementation contract, v1.3 of 2026-10-04: memory in the build, pacts and betrayal out, an AI's own march, the Strike Order; the code is on branch `frontier/ai-integ`, a 6-AI smoke test has run, the 12-AI and 18-AI runs have not, not merged into this tree), [ai-citizens/GAME-DESIGN-CORE.ja.md](ai-citizens/GAME-DESIGN-CORE.ja.md) (the design spine, plain Japanese), [ai-citizens/SUMMARY.ja.md](ai-citizens/SUMMARY.ja.md) (the contract in plain Japanese), [ai-citizens/RULES-AND-AI-CITIZENS.ja.md](ai-citizens/RULES-AND-AI-CITIZENS.ja.md) (the rules explained and the design the project owner approved on 2026-10-03; its pact, betrayal and Renown items are superseded by decision X2). Measured results will be marked `[AS-BUILT: pending]` until they exist.
- **AI agents (earlier plan and the Gemma 4 spike):** [ai-agents/](ai-agents/). [ai-agents/AI-AGENTS-PLAN.md](ai-agents/AI-AGENTS-PLAN.md), [ai-agents/SUMMARY.ja.md](ai-agents/SUMMARY.ja.md), [ai-agents/gemma4/](ai-agents/gemma4/) (the local-model test, [REPORT.ja.md](ai-agents/gemma4/REPORT.ja.md)), [ai-agents/models-prices.md](ai-agents/models-prices.md), [ai-agents/old-game-inventory.md](ai-agents/old-game-inventory.md). **Superseded where it differs (replaced):** it describes hidden operator bots (Shades) and operator-LLM agents, which the project no longer does. `ai-citizens/`, decisions W1–W11 and Y1–Y12, and the unified design win.
- **UI shell notes:** [ui-shell/](ui-shell/). [ui-shell/UNITS-REDESIGN.md](ui-shell/UNITS-REDESIGN.md) (units, movement and building on the map) and [ui-shell/HANDOFF-replay.md](ui-shell/HANDOFF-replay.md) (the season replay hand-off).
- **Art:** [art/](art/). [art/units/README.md](art/units/README.md): the painted unit miniatures, one look for each of the six nations.
- **M0 (preparation and checks):** [m0/M0-FINAL.ja.md](m0/M0-FINAL.ja.md), [m0/M0-FINAL.md](m0/M0-FINAL.md) (status), [m0/M0-CLOSE.md](m0/M0-CLOSE.md) (how the remaining items were closed in M1's first weeks); the first-pass report, simulator results and spike results are also in `m0/`.

## Research and history

- `research/`: Eternum, other on-chain MMOs, an earlier game of this project, and the scale study.
- `audit-v8/`: the chain audit of the earlier prototype (Japanese) and the MagicBlock randomness spike. The earlier prototype (branch `codex/magicblock-playable`) is a separate, older game, kept as history; it is not the game these documents describe.

## Code

The rules kernels are in `permutation-rules/src/frontier/`, the balance simulator is in `frontier-sim/`, the on-chain program is `permutation-frontier/`, and the off-chain services (keeper, herald, relay, bots, verifier) are in `frontier-node/`. Names are historical (decision V1).
