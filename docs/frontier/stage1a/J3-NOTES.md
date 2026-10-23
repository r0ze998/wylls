# Stage 1a, J3: doctrines that field the strong units

Design: `design/redesign` branch, `docs/design/redesign/30-stage1-build-plan.ja.md` (J3).
The Pikeman, Crossbowman and Knight need arms to train, and the doctrines
are rebalanced so that some of them field these units.

## What was built

- **Kernel:** `permutation_rules::frontier_next::arms::train_v3` adds an arms
  cost to the strong units. The kernel is unbound: no ruleset hash, season
  or vector changes.
- **Simulator `--arms` / `--arms-per100 P,C,K` / `--arms-scale PCT` (MC
  only):** the per-march unit-variant surcharge becomes what `train_v3`
  charges above a Spearman.
  - The simulator has no workshops or arms stores, so arms are paid as the
    ore and wood a workshop needs to make them (2 ore + 1 wood per arm):
    `k2::march_surcharge_arms`.
- **Doctrine layouts:** tried with the existing `--dx` overrides. The kernel
  table is unchanged.

## Method

The `doctrines` command under `--rules mc`. The candidate search ran at 2,000
wallets × 8 to 16 seeds × 6 rotations. Confirmation ran at the CI gate's size:
10,000 wallets × 60 seeds (1..=60) × 6 rotations = 360 seasons, index SE
≈ 0.035%. The gate bounds every doctrine's mean index to ±0.2% of the mean.

## Results at the gate's size (Δ mean index vs the mean)

| Layout | Arms per 100 (P, C, K) | A | B | C | D | E | F | max \|Δ\| |
|---|---|---|---|---|---|---|---|---|
| A Pike, C Xbow, F Knight | 60, 80, 40 | −0.236 | −0.410 | −0.177 | +0.350 | +0.257 | +0.215 | 0.410 |
| same | 60, 80, 50 | −0.134 | −0.412 | −0.138 | +0.363 | +0.412 | −0.090 | 0.412 |
| same | **50, 70, 40** | +0.124 | **−0.724** | +0.217 | +0.142 | +0.185 | +0.055 | 0.724 |
| same, B arrival 1.05 | 50, 70, 40 | +0.131 | −0.620 | +0.147 | +0.198 | +0.187 | −0.043 | 0.620 |
| same, B drill Assault 1.10 | 50, 70, 40 | +0.097 | −0.702 | +0.165 | +0.155 | +0.215 | +0.069 | 0.702 |
| same, B drill Flank 1.10 | 50, 70, 40 | +0.091 | −0.682 | +0.242 | +0.224 | +0.145 | −0.021 | 0.682 |
| same, B variant 1.05 | 50, 70, 40 | +0.128 | −0.677 | +0.146 | +0.175 | +0.211 | +0.017 | 0.677 |
| same, B travel 0.9 or 0.8 | 50, 70, 40 | −0.032 | −0.672 | +0.195 | +0.176 | +0.280 | +0.053 | 0.672 |
| same, B arrival 1.05 | 60, 80, 45 | −0.202 | −0.440 | −0.130 | +0.343 | +0.363 | +0.066 | 0.440 |
| A Pike, E Xbow, F Knight | 50, 70, 40 | +0.067 | −0.268 | +1.328 | +0.342 | −1.053 | −0.417 | 1.328 |
| same | 60, 80, 40 | −0.326 | −0.112 | +1.279 | +0.554 | −1.502 | +0.107 | 1.502 |

For reference, the kernel table (A, C, D, E Spearman; B, F Horseman; no arms)
has a largest |Δ| of 0.063% at this size (`balance.rs`, `GATE_SEEDS`).

## Findings

1. **A single scale cannot balance the three units.** In the 2k runs, raising
   the arms cost for all three at once first fixed A and C, then sank F: the
   Knight is already the costliest unit to field. Each unit needs its own cost.
2. **Crossbowmen belong with C, not E.** E Lumen on the Crossbowman line loses
   about 1–1.5%, and C gains as much.
3. **With 50 / 70 / 40, five doctrines sit within ±0.28%, but B Tide is at
   about −0.7%.**
   - B does not respond to its own knobs: arrival, drill, variant and march
     speed all left it between −0.62% and −0.70%. March speed 0.9 and 0.8
     gave identical seasons, so that knob has no effect on B under these rules
     [inferred].
   - The likely cause is the matchups. Melee counters mounted (`units::
     counters`), and A's tier-2 Pikemen now counter B's tier-1 Horsemen
     [inferred].
   - Raising the arms costs reduces B's deficit (−0.41% at 60 / 80 / 40) but
     pushes D and E up (+0.35%).
4. **The gate (±0.2%) is not met by any layout tried.** The best maximum is
   0.41% (60 / 80 / 40).

## Next steps, in order

1. Find why B's knobs do not move it: trace B's matchups and its marches under
   MC.
2. Candidate levers:
   - a Pikeman–Horseman matchup rule;
   - B on a different line;
   - a fourth doctrine fielding a strong unit.
3. Re-check at the gate's size, then on ≥ 1,500 fresh seasons (the O5 band).

`TRAIN_ARMS_PER_100` in the kernel is set to the best values found (50, 70, 40);
they remain [phase 6] numbers.
