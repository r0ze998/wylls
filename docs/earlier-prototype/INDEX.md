# Earlier prototype: index

These pages describe the **earlier prototype**, a different game that was then named **Permutation State**, not the current game (Wylls). Page titles say so; the page bodies were renamed mechanically and still describe devnet, test USDC, ticks, officers and hidden operator AI members. None of that is a claim about Wylls. The current game is described in [../DESIGN-OVERVIEW.md](../DESIGN-OVERVIEW.md) ([日本語](../DESIGN-OVERVIEW.ja.md)). Every page here keeps its historical wording and carries a banner saying so. File names are unchanged from when they sat in the repository root.

Two earlier generations exist:

- **V5 game** (6 nations, 180 ticks, MagicBlock ephemeral rollup, devnet rules v8 season 1790355636798 verified 14/14, [verification output](devnet-season-1790355636798-verification.txt), a read-only replay run on 2026-10-03). The matching code is on branch `codex/magicblock-playable` (crates `permutation-rules`, `permutation-chain`, `permutation-server`, `permutation-gateway`).
- **Handoff proof prototype** (local multi-client proof, not Solana). The matching code is `permutation-state-prototype/` and `permutation-state-solana-receipt-spike/` on `main`. Both folders are also still present in this branch, because CI and code paths reference them.

Code folders, crate names and identifiers keep their historical `permutation-*` names; they were not moved or renamed.

## Entry pages

| File | What it is | Code |
|---|---|---|
| [README-V5-game.md](README-V5-game.md) | The root README of the V5 game, as it stood before the unify (328 lines). | `codex/magicblock-playable` |
| [README-handoff-prototype.md](README-handoff-prototype.md) | The oldest root README: the Handoff proof prototype (`origin/main` before the V5 work). | `main`: `permutation-state-prototype/` |

## V5 game

| File | What it is | Code |
|---|---|---|
| [PERMUTATION_STATE_GAME_DESIGN_V5.md](PERMUTATION_STATE_GAME_DESIGN_V5.md) | Game design V5 (Japanese): nations as small on-chain states, prize split by contribution, USDC market, agents. | `codex/magicblock-playable` |
| [PERMUTATION_STATE_RULES_SPEC_v0.2.md](PERMUTATION_STATE_RULES_SPEC_v0.2.md) | Numeric rules of the V5 world as implemented, rules versions 6 to 8. | `codex/magicblock-playable`: `permutation-rules` |
| [IMPLEMENTATION_STATUS.ja.md](IMPLEMENTATION_STATUS.ja.md) | Status log of the V5 implementation (Japanese). | `codex/magicblock-playable` |
| [SUBMISSION.md](SUBMISSION.md) | Hackathon submission text for the V5 game. | `codex/magicblock-playable` |
| [PITCH.md](PITCH.md) | Pitch for the V5 game. | `codex/magicblock-playable` |
| [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | 3-minute demo video script for the V5 game (Japanese). | `codex/magicblock-playable` |
| [PERMUTATION_STATE_EVIDENCE_LEDGER.md](PERMUTATION_STATE_EVIDENCE_LEDGER.md) | Evidence ledger for the earlier hackathon submission (2026-09-21). | `main`: `permutation-state-solana-receipt-spike/` |

## Earlier design iterations (superseded by V5)

| File | What it is | Code |
|---|---|---|
| [PERMUTATION_STATE_GAME_DESIGN_V4.md](PERMUTATION_STATE_GAME_DESIGN_V4.md) | Game design V4: one civilization, one save for everyone, three victory tracks. | none (design only) |
| [PERMUTATION_STATE_GAME_DESIGN_V4.1.md](PERMUTATION_STATE_GAME_DESIGN_V4.1.md) | V4.1 revision draft with bot-simulation evidence. | `codex/magicblock-playable`: `permutation-server` |
| [PERMUTATION_STATE_RULES_SPEC_v0.1.md](PERMUTATION_STATE_RULES_SPEC_v0.1.md) | Rules specification v0.1, superseded by v0.2. | `codex/magicblock-playable`: `permutation-rules` |
| [PERMUTATION_STATE_RULES_SPEC_v0.2_CHANGES.md](PERMUTATION_STATE_RULES_SPEC_v0.2_CHANGES.md) | Change list v0.1 to v0.2, merged into v0.2. | none (design only) |
| [PERMUTATION_STATE_DESIGN_V3.md](PERMUTATION_STATE_DESIGN_V3.md) | Design V3, "Proof of Consequence" (Japanese); not adopted. | none (design only) |

## Handoff proof and `/civilization/` prototype

| File | What it is | Code |
|---|---|---|
| [PERMUTATION_STATE_GAME_CONSTITUTION.md](PERMUTATION_STATE_GAME_CONSTITUTION.md) | Game constitution, Season Zero: the Handoff / East Sluice design. | `main`: `permutation-state-prototype/` |
| [PERMUTATION_STATE_HANDOFF_PROOF.md](PERMUTATION_STATE_HANDOFF_PROOF.md) | Multi-citizen handoff proof, 10/10 local browser scenarios (not Solana). | `main`: `permutation-state-prototype/` |
| [PERMUTATION_STATE_SIMULATION_PIVOT.md](PERMUTATION_STATE_SIMULATION_PIVOT.md) | Archived walking-and-repair design. | `main`: `permutation-state-prototype/` |
| [PERMUTATION_STATE_REBUILD.md](PERMUTATION_STATE_REBUILD.md) | Map-first rebuild contract for the `/civilization/` prototype. | `main`: `permutation-state-prototype/` |
| [PERMUTATION_STATE_PLAYTEST_KIT.md](PERMUTATION_STATE_PLAYTEST_KIT.md) | Two-player playtest kit for Season Zero (a kit, not a record of playtests). | `main`: `permutation-state-prototype/` |
| [PERMUTATION_STATE_QA_REPORT.md](PERMUTATION_STATE_QA_REPORT.md) | QA report of the `/civilization/` prototype, 2026-09-21. | `main`: `permutation-state-prototype/` |
| [PLAY_GUIDE.ja.md](PLAY_GUIDE.ja.md) | Play guide for the `/civilization/` prototype (Japanese). | `main`: `permutation-state-prototype/` |
| [ARCHIVED_REPAIR_DEMO.md](ARCHIVED_REPAIR_DEMO.md) | README of the superseded walking-and-repair demo. | `main`: `permutation-state-prototype/` |
