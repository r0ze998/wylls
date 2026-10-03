# Wylls: design, decisions and milestone records

The documents behind Wylls, the open-world civilization game on Solana: six nations, a village placed for you, real-time economy, combat resolved at 10-minute bells, sealed marches. Start with the overview, then the design.

Status words used across these documents: **[measured]** (a result with its source), **[built this week]**, **[designed]** (not built). M1 (first playable, no money) is complete and was tested only on a local test chain. Conquest is in progress. Money (M2) and society (M3) are not built. AI citizens are designed, not built.

Identifiers keep their historical names (decision V1): crate, folder, file and package names (for example `permutation-rules`, `permutation-frontier`, `frontier-node`), hash and signature domains, and seeds were not renamed. Paths written as `(session scratch)/…` point to lab files from the working session; they are not in the repository.

## Start here

Three documents, about ten minutes: [../DESIGN-OVERVIEW.md](../DESIGN-OVERVIEW.md) ([日本語](../DESIGN-OVERVIEW.ja.md)) (the game, its evidence and its limits), [m1/M1-EXIT-NOTES.md](m1/M1-EXIT-NOTES.md) (what is built, with every item's evidence) and [ai-citizens/AI-CITIZENS-CONTRACT.md](ai-citizens/AI-CITIZENS-CONTRACT.md) (what is designed). Everything else below is reference.

## Reference

- [SUMMARY.ja.md](SUMMARY.ja.md): the short plain-Japanese status summary. The earlier revision 3.1 summary is kept as history in [SUMMARY.ja.rev3.1.md](SUMMARY.ja.rev3.1.md).
- [DESIGN.md](DESIGN.md): the engineering specification (English), revision 4 (2026-10-03): revision 3.1 and the M1 amendments (§0.4-§0.6, §18-§23) with nation / village terms and AI citizens in place of the retired hidden bots.
- [DECISIONS.md](DECISIONS.md): the decisions log. Parts T–W are the latest: T (everything ends with the season), U (the M1 exit), V (the name Wylls; joining is choosing a nation), W (one game; labelled AI citizens replace hidden bots; words nation / village).
- [m1/runs/m1-exit/](m1/runs/m1-exit/): the exit season's record.

## Milestone records

- **M1, "First Bell" (complete, 2026-10-01):**
  - [m1/M1-EXIT-NOTES.md](m1/M1-EXIT-NOTES.md): the exit report (every item with its evidence, findings, open items before a playtest).
  - [m1/M1-EXIT.ja.md](m1/M1-EXIT.ja.md): the same, in plain Japanese.
  - [m1/runs/m1-exit/](m1/runs/m1-exit/): the exit season's record (7 game days, 1,000 rule bots, local test chain).
  - [m1/M1-CONTRACT.md](m1/M1-CONTRACT.md): the implementation contract (v1.13). `m1/*-NOTES.md` are the unit and integration reports.
  - [m1/RUN-A-KEEPER.md](m1/RUN-A-KEEPER.md): how to run a keeper on the local stack, and what a public network still needs.
  - [m1/PLAYTEST-RUNBOOK.md](m1/PLAYTEST-RUNBOOK.md): the private devnet playtest's configuration and steps. **Not approved, not run** (a larger devnet playtest of 50 to 200 people; a small invite-only local playtest is being prepared and has not run).
  - [m1/c4-v3/](m1/c4-v3/): the fee-attack cost model v3 with the measured Reveal compute cost.
- **Conquest (in progress):** [conquest/](conquest/). Keeps, sieges and occupation, so that the map moves through play. [conquest/SUMMARY.ja.md](conquest/SUMMARY.ja.md) is the plain-Japanese summary, [conquest/CONQUEST-CONTRACT.md](conquest/CONQUEST-CONTRACT.md) the contract, `conquest/design/` the area designs. Not merged into the main line.
- **AI citizens (designed, not built):** [ai-citizens/](ai-citizens/). [ai-citizens/SUMMARY.ja.md](ai-citizens/SUMMARY.ja.md) (plain Japanese), [ai-citizens/RULES-AND-AI-CITIZENS.ja.md](ai-citizens/RULES-AND-AI-CITIZENS.ja.md) (the rules explained and the design the project owner approved on 2026-10-03), [ai-citizens/AI-CITIZENS-CONTRACT.md](ai-citizens/AI-CITIZENS-CONTRACT.md) (the implementation contract). Measured results will be marked `[AS-BUILT: pending]` until they exist.
- **AI agents (earlier plan and the Gemma 4 spike):** [ai-agents/](ai-agents/). [ai-agents/AI-AGENTS-PLAN.md](ai-agents/AI-AGENTS-PLAN.md), [ai-agents/SUMMARY.ja.md](ai-agents/SUMMARY.ja.md), [ai-agents/gemma4/](ai-agents/gemma4/) (the local-model test, [REPORT.ja.md](ai-agents/gemma4/REPORT.ja.md)), [ai-agents/models-prices.md](ai-agents/models-prices.md), [ai-agents/old-game-inventory.md](ai-agents/old-game-inventory.md). **Superseded where it differs:** it describes hidden operator bots, which the project no longer does. `ai-citizens/` and decisions W1–W11 win.
- **UI shell notes:** [ui-shell/](ui-shell/). [ui-shell/UNITS-REDESIGN.md](ui-shell/UNITS-REDESIGN.md) (units, movement and building on the map) and [ui-shell/HANDOFF-replay.md](ui-shell/HANDOFF-replay.md) (the season replay hand-off).
- **Art:** [art/](art/). [art/units/README.md](art/units/README.md): the painted unit miniatures, one look for each of the six nations.
- **M0 (preparation and checks):** [m0/M0-FINAL.ja.md](m0/M0-FINAL.ja.md), [m0/M0-FINAL.md](m0/M0-FINAL.md) (status), [m0/M0-CLOSE.md](m0/M0-CLOSE.md) (how the remaining items were closed in M1's first weeks); the first-pass report, simulator results and spike results are also in `m0/`.

## Research and history

- `research/`: Eternum, other on-chain MMOs, an earlier game of this project, and the scale study.
- `audit-v8/`: the chain audit of the earlier prototype (Japanese) and the MagicBlock randomness spike. The earlier prototype (branch `codex/magicblock-playable`) is a separate, older game, kept as history; it is not the game these documents describe.

## Code

The rules kernels are in `permutation-rules/src/frontier/`, the balance simulator is in `frontier-sim/`, the on-chain program is `permutation-frontier/`, and the off-chain services (keeper, herald, relay, bots, verifier) are in `frontier-node/`. Names are historical (decision V1).
