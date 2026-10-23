# Stage 1a: the arms economy bound into the S1 rules

Design: `docs/design/redesign/30-stage1-build-plan.ja.md` §2 (1a), decisions
J3, J5 and J6. Earlier work on this stage: [J3-NOTES.md](J3-NOTES.md) (the
unbound kernel and the doctrine search).

## What changed

**A new rules version, S1** (program version 4, rules version 12,
`RULESET_HASH_V3 = d0efcb86…1697`). The program is the S1 program: it
embeds `RULESET_HASH_V3`, refuses M1 and MC seasons, and MC seasons keep
the MC release `.so` (J5: stage 1 runs in a new season). The M1 and MC
hashes, tables and outcomes are unchanged (pinned by
`permutation-rules/tests/frontier_s1.rs`).

| Part | Where |
|---|---|
| Ruleset hash v3: the MC input with the v3 head (`frontier` 12, `catalog` 3, `doctrine` 3, `holding` 4, `arms` 1), then `S1-TABLES-v1`, the arms tables, the S1 catalog and doctrine tables | `permutation-rules/src/frontier/mod.rs` (`ruleset_hash_input_v3`) |
| Arms in the Horses store slot (index 4) | `frontier/arms.rs` (`ARMS`) |
| Workshop: build item 8, `Effect::Production { Arms, 4/h }` per copy | `arms::building`, `arms::ITEM_WORKSHOP` |
| Workshop conversion: 2 ore + 1 wood per arm | `holding.rs` (module note, `full_rates`, `limited_rates`, `dry_at`) |
| Strong units cost arms (Pikeman 50, Crossbowman 70, Knight 40 per 100) | `arms::train_v3` |
| Terrain ore, stored per holding | `arms::terrain_ore_per_hour(_bytes)`, `arms::base_production`; Holding v2 `TERRAIN_ORE @1272` (was `RSV_1272`) |
| S1 doctrine table: A Pikeman, C Crossbowman, F Knight (variant ×1.0) | `doctrine::DOCTRINES_V3` |
| Presets `S1_LOCAL_7D`, `S1_LOCAL_14D`, `S1_TEST` (the MC presets with program version 4) | `frontier-abi/src/v2/presets.rs` |

## The workshop conversion (how it settles)

A holding converts while it has arms production. Its workshops use ore and
wood in proportion to that production (`ORE_PER_ARM`, `WOOD_PER_ARM`), and
the rates change only at fixed times, so settling stays path independent:

- **Full speed** while both inputs last.
- **Dry:** a store's exact amount is `value × 3600 + frac`, which moves by
  exactly `rate` each second. The time an input would go below 0 is
  therefore fixed by the stores, whatever the settle path. It is an event
  in `Holding::settle`, like queue completions and dormancy (ties: queue,
  dormancy, then dry).
- **Limited** from that time: the workshops run at the share (basis points,
  rounded down) that the scarcer input's own net production sustains, so
  neither input goes below 0.
- **Back to full** at the next rate change, once the input has stock again:
  an owner action, a completed build, or a **credit** (loot, refunds, and
  in 1b the caravans). `Holding::credit` re-applies the rates when the
  holding makes arms.
- **Dormancy** halves the workshops' output and their input use together.
- A holding without arms production (every M1 and MC holding) settles
  exactly as before: `production[Arms]` is 0 and no item produces arms.

The arms store has the tier's storage cap like every store; at the cap the
inputs are still used (as production at the cap is lost today). Phase 6
may revisit this.

## Terrain ore

- `terrain_ore_per_hour` = 4/h base + hills 2, mountains 3, iron 4 per
  tile within radius 2 in the same province, the terrain part capped at
  30/h.
- The program computes it at founding (SettleTicket, PlaceHome, outposts)
  and at a Free City's capture, from the Province's stored terrain block,
  and writes it to the Holding's `TERRAIN_ORE`.
- Base production at every tier is `arms::base_production(tier,
  terrain_ore)`: the M1 base with the ore entry replaced by the terrain ore
  under the tier bonus.
- The copy number of the ore building counts the production above that
  base.
- J6: an outpost on rich ore is how a citizen works the veins beyond home.

Readers that serve every version (the verifier, the agents) use
`arms::holding_base_production(tier, terrain_ore)`. A holding's
`TERRAIN_ORE` is 0 in M1 and MC (reserved bytes) and at least 4,000 in S1,
so the field itself tells which base applies.

## Verifier, bots, simulator

- **Verifier** (`frontier-node/crates/verify`):
  - `Rules` (M1 / MC / S1) replaces the `conquest: bool` of the holding
    replay.
  - `cx.s1` is set by `conquest::s1_applies` (a Season with program version
    ≥ 4, or the configured hash `RULESET_HASH_V3`).
  - Build accepts the workshop under S1; Train pays `train_v3`; doctrines
    are `DOCTRINES_V3`.
  - The founding replay computes the site's terrain ore from the Province
    and checks `TERRAIN_ORE`. V17 checks a captured Free City's terrain ore
    and base production.
- **Bots** (`frontier-node/crates/agents`, `bots`):
  - `agents::rules::Rules` picks the train cost, the build items and the
    doctrine table from the Season's `program_version`.
  - This also fixes the brain's M1 train cost (plan §1-14).
  - Under S1, a holding whose doctrine fields a strong unit builds its
    first workshop first, and trains Spearmen while it has no arms.
  - The conquest planner predicts with the S1 doctrine table.
- **Simulator:**
  - `frontier-sim doctrines --set s1 --rules mc --arms` plays
    `DOCTRINES_V3` (identical seasons to J3's `--dx` layout, checked).
  - The `arms` map report runs the holding kernel's own conversion.

## Tests run

- `permutation-rules`: all 30 suites, including the new
  `tests/frontier_s1.rs` and the conversion tests in `arms.rs`.
- `frontier-abi`: 81 unit tests, and the vectors regenerated.
- `permutation-frontier`: 94 unit tests. LiteSVM suite: 350/350 on the S1
  `.so`. Changed for S1: founding with terrain ore, Train with arms, item 8
  is the workshop, the v3 hash, and an MC season (program version 3)
  refused by CreateSeason.
- `verify`: 84, including `s1_founding_workshop_and_arms_training`.
- `frontier-sim`: 55 (`--skip doctrine_balance_gate`; the gate plays the
  MC table, which is unchanged) and `catalog_equality`.

## Still open

- **J3's balance band is not met.** With `DOCTRINES_V3` and 50/70/40, B
  Tide sits near −0.7% of mean index; the gate is ±0.2%
  ([J3-NOTES.md](J3-NOTES.md)). The S1 table is bound as measured. The arms
  costs are phase-6 numbers.
- **Web client** (1f):
  - Load the S1 module (`scripts/build-wasm.sh --s1` →
    `frontier-v3.wasm`) when `programVersion >= 4`.
  - Update the cost tables in `fland.mjs` and `hud/rulebook.mjs`, the
    workshop as build item 8, and "Arms" for the Horses slot.
  - Project a converting holding past its dry time.
- **Siege arms** (`arms::SIEGE_ARMS`) is bound in the tables but not
  charged yet (1e: it needs a season parameter, a record field and the
  verifier).
