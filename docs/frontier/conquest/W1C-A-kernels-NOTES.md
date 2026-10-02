# W1C-A kernels and ABI v2: notes (Wave-1 close)

- **Unit:** W1C-A-kernels, branch `frontier/cq-w1c-kernels`, cut from `frontier/cq-integ` at `f1a5510` (DECISIONS CQ-H recorded).
- **Sources:** `OWNER-OPTIONS-W1.md` / `.ja.md` (PO-2, PO-5, PO-7), DECISIONS CQ-H (CQH1(2), (5), (7); CQH3), contract v1.2 §3.1, §3.2, §3.10, §3.13, §3.14, §5.1, §7, §12.
- **Owned paths touched:** `permutation-rules/src/frontier/{keep,catalog,doctrine,mod}.rs`, `permutation-rules/tests/frontier_conquest.rs`, `permutation-rules/vectors/keep-vectors-v1.json` (note line only), `frontier-abi/src/v2/{kernel,presets}.rs`, `frontier-abi/src/bin/abi-vectors.rs` (v2 parts), `frontier-abi/tests/cq_{conquest_model,kernel_vectors,v2_contract}.rs`, `frontier-abi/vectors/v2/{conquest,presets}.json`, this file.
- **Not touched:** every M1 name, table and version; `catalog::train`; `frontier-sim/**`; `frontier-node/**`; manifests and lockfiles; the design chat's files.
- **Dependency requests:** none.

## 1. What changed

| # | Change | Where | Source |
|---|---|---|---|
| 1 | **The keep tile of the v2 rules is `keep::keep_tile_symmetric(terrain, sites, site_count, wedge)`**: `keep_tile`'s scan over the canonical (wedge-0) copy's tile indices, turned into the wedge. It equals `keep_tile` in wedge 0, and all six wedges of a ring keep on the same tile. `keep_tile` (3 args) stays as the v1.2 scan (wedge 0's tile), documented as not the MC rule. `KEEP_VERSION` 1 → 2. The bridge `frontier_abi::v2::kernel::keep::keep_tile` now takes the wedge and is the symmetric rule. | `keep.rs`, `v2/kernel.rs` | PO-5, CQH1(5) |
| 2 | **K2, the MC train-cost table**: `catalog::TRAIN_PROD_COST_V2 = [6, 7, 6, 12, 14, 16, 10]` (unit ids 0..=6), `train_v2(unit, n)`, `train_prod_cost_v2(unit)`, `variant_surcharge_v2(unit)`, `write_tables_v2`, `CATALOG_VERSION_V2 = 2`. Only the Horseman line changes: it costs a Spearman's ore and gold (no variant surcharge). Every other unit, the Knight included, costs what M1's `train` charges. `catalog::train`, `CATALOG_VERSION` and every M1 table are unchanged. | `catalog.rs` | PO-2, CQH1(2) |
| 3 | **The Knight bound**: `doctrine::validate_table_v2` = `validate_table` and then the new refusal `DoctrineError::RefusedLine` for any doctrine on a line in `bounds::REFUSED_LINES_V2 = [Knight]`. `write_bounds_v2`, `DOCTRINE_VERSION_V2 = 2`. The Season 1 table passes unchanged. | `doctrine.rs` | PO-2, CQH1(2) |
| 4 | **§3.10 provisional holdings (PO-7)**: confirmed, no code change. `conquest_model::control_weights` (and the hourly snapshot it feeds) counts every site in state 1. Finality is a Citizen/Holding fact (`STATE_PROVISIONAL`, `final_ts`) that the Province never carries (CQ1-C D-10). New test `cq_control_weights_count_provisional_holdings`. | `cq_conquest_model.rs` | PO-7, CQH1(7) |
| 5 | **`KERNEL_VERSIONS_V2`**: only the touched modules moved: `catalog` 1 → 2, `doctrine` 1 → 2, `keep` 1 → 2. **`ruleset_hash_input_v2`** appends, after the 27 conquest constants, `b"MC-TABLES-v1"`, the train table (version, length, seven `i64`) and the Knight bound (version, count, `UnitType as u8`). The M1 input is unchanged. | `mod.rs` | CQH3 |
| 6 | **`RULESET_HASH_V2` re-pinned once**: `1607f62f…2a5a` → **`b6dd0f3f260d9ef3e9a71c5010b56c42693578f4d8c394623d56deb9fed98274`**, in `cq_m1_ruleset_hash_unchanged_and_v2_pinned` and `frontier_abi::v2::presets::RULESET_HASH_V2`. **M1 `RULESET_HASH` = `72c6b583…4bd9`, unchanged.** | `frontier_conquest.rs`, `v2/presets.rs` | CQH3 |
| 7 | **Vectors**: `frontier-abi/vectors/v2/conquest.json` (the fixture province (5, −1) now opens its keep on the symmetric tile, so every Province byte string and digest of that file moves), `v2/presets.json` (hash and status line), `keep-vectors-v1.json` (the note line only: the file already carried both `keep_tile` and `keep_tile_symmetric` columns). **No v1 vector changed** (`abi-vectors --check`: 16 files fresh; `frontier_shared` rewrote nothing). | generated | — |

### Why "refuse Knight lines" and also "keep the Knight's cost"

The English sheet says "validate_table v2 refuses Knight lines for MC doctrines (or keeps a Knight cost)". The Japanese sheet, which the owner read, says MC makes Knight lines unselectable (「MC では Knight 系ユニットを選べないようにします」). **The doctrine bound is therefore the refusal** (`validate_table_v2`).

The train table still has to price a Knight, because Train (0x42) takes any unit id 0..=6 on chain and is not tied to the doctrine's line. I kept the Knight's M1 cost (production cost 16) for three reasons:

- K2 was measured only on the Horseman line, the line B and F field. The simulator never trains a Knight, so no measurement supports a Knight price change.
- A Knight without its surcharge (tier 2, strength 22) would cost a Spearman's ore and gold. That is less than a Horseman's M1 price, so it would beat every tier-1 line for any player who trains on chain.
- Keeping the cost leaves M1's Knight price as it is, which is the conservative choice.

This is the sheet's "keeps a Knight cost" option on the train side, combined with its recommended refusal on the doctrine side. I see no new owner decision here. Contract v1.3 (W1C-C) should state both halves.

### The chain and the simulator agree under K2

The simulator charges the variant surcharge **per march** (`sim.rs` `send`, `prod_cost − 6`). The chain charges it **at training** (`catalog::train`). The sheet's "charging at training only gives 2/6" line rejected that difference in M1 terms. Under K2 the Horseman's surcharge is 0 at both points, so the measured package (E3 `all_bps = 0` under MC) and the chain's v2 train table describe the same cost.

The simulator's MC per-march surcharge should be `catalog::variant_surcharge_v2(doctrine unit) × per-100 rate` (0 for B and F). The Spearman doctrines pay 0 either way.

## 2. Tests (`cq_*`)

| Test | Checks |
|---|---|
| `cq_keep_tile_symmetric_is_the_rule_in_every_wedge` (new) | 3,888 generated provinces (24 seeds × rings 2–7). The tile is passable, off every site, and reachable from the centre and from every site. It equals the canonical copy's `keep_tile` turned into the wedge (so it is the same tile in all six wedges). It equals `keep_tile` in wedge 0, and the wedge is taken mod 6. The v1.2 scan differed in more than half of the provinces (CQ1-A finding 1). Water-only edge case. |
| `cq_keep_tile_is_the_lowest_passable_non_site_and_reachable` (kept, narrowed) | the v1.2 scan's own properties and edge cases (the wedge comparison moved to the test above, not dropped) |
| `cq_free_city_site_is_the_same_canonical_site_in_every_wedge`, `cq_camp_v2_never_on_the_keep_and_is_m1_without_one` | now against the MC keep tile (`keep_tile_symmetric`) |
| `cq_m1_ruleset_hash_unchanged_and_v2_pinned` | M1 hash golden. v2 hash re-pinned. The v2 input ends with the MC tables, preceded by the 27 constants. The train table and the Knight byte are present. Bumps: catalog 1→2 and doctrine 1→2 beside §3.13's, keep 2, control 1. Every other module unchanged. |
| `cq_train_v2_drops_only_the_horseman_surcharge` (lib) | The Horseman = Spearman cost, below its M1 cost. Every other unit (Knight included) is equal to M1 `train`. The Knight's surcharge stays 10. Refusals: n = 0, unit 7. |
| `cq_the_season_table_passes_the_knight_bound` (lib) | `validate_table_v2(DOCTRINES)` is OK. F on the Knight line passes M1's `validate_table` and is refused `RefusedLine` by v2. An M1 refusal (`Shape`) still comes first. |
| `cq_train_v2_and_the_knight_bound` (frontier-abi bridge) | the same through `v2::kernel::{catalog2, doctrine2}` |
| `cq_keep_tile_and_free_city_site_vectors_through_the_bridge` | The bridge `keep_tile(…, wedge)` = the vectors' `keep_tile_symmetric` column. The kernel scan = the `keep_tile` column, and the two are equal in wedge 0. |
| `cq_control_weights_count_provisional_holdings` (new) | A state-1 site (a holding founded this bell, whose owner is provisional) counts its `site_weight_centi`. Free, released, reserved and unused-camp sites add nothing. The hour-1 snapshot (bell 6) carries the same weight, with resolve ≡ skip. |
| `ruleset_hash_v2_is_the_kernels` (frontier-abi) | `RULESET_HASH_V2` = the kernels' |

## 3. Gate CQ1 lines for these files

Run in `.claude/worktrees/cq-w1c-kernels`, offline, with `CARGO_TARGET_DIR` in the scratchpad. Logs and `.rc` files are in `scratchpad/cqclose/W1C-A-kernels/`.

| Line | Result |
|---|---|
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --locked -p permutation-rules -p frontier-abi --all-targets -- -D warnings` | exit 0 |
| `cargo test --locked --release -p permutation-rules` | exit 0: 470 passed, 0 failed. Includes `m1_rules_keep_the_phase_b_digests`, `occupancy_empty_keeps_the_phase_b_digests`, `phase_a_equals_the_reference_on_4320_inputs` and all 29 `frontier_conquest` tests. |
| `cargo test --locked -p frontier-abi` | exit 0: 77 lib + 2 + 3 + 14 + 6 + 4 integration tests |
| `cargo run --locked -p frontier-abi --bin abi-vectors -- --check` | 16 files fresh |
| `cargo test --locked -p permutation-chain` | exit 0: 157 passed |
| `cargo check --locked -p permutation-frontier` | exit 0 (the M1 program compiles against the kernels) |
| `frontier-sim`: fmt, clippy `--release -D warnings`, `cargo test --release` | exit 0: 52 passed. Includes the M1 doctrine gates (`doctrine_balance_gate`, `…_rejects_the_knight`, `…_rejects_the_draft`, `…_rejects_a_quiet_a_boost`) and `catalog_equality`. 826 s. |
| `frontier-node`: fmt, clippy `--workspace -D warnings`, `cargo test --workspace` | exit 0: 442 passed, 11 ignored (the suite's own ignores) |
| `scripts/cq-regen.sh --check` | exit 0. Every generated output is fresh, including `build-wasm --check: fresh`: the committed `frontier.wasm` is byte-identical (sha256 `38df2c14…08f1`). |
| `scripts/cq-regen.sh --v1-unchanged f1a5510` | every v1 generated output is byte-identical |
| `permutation-gateway`: `npm test` (`node_modules` symlinked, no `npm ci`) | exit 0: 546 of 546 |

The simulator lines (criterion, doctrine gates, mapmove, overnight) belong to W1C-B and the integrator. They need the simulator to port K2 and the symmetric keep as the default MC behaviour. This unit leaves the simulator's code paths unchanged: `keep::keep_tile`, `catalog::train` and `doctrine::validate_table` keep their M1 behaviour.

## 4. Cross-crate checks

- **M1 bit-identical:** M1 `RULESET_HASH` unchanged; Phase B digests and the 4,320-input equivalence are green; every v1 vector and generated output is byte-identical to `f1a5510`; the v1 WASM bytes are unchanged too.
- **Nothing outside the owned paths changed.** `frontier-sim`, `frontier-node`, `permutation-frontier` and the web code compile and pass unchanged. The kernel functions they call (`keep::keep_tile`, `catalog::train`, `doctrine::validate_table`) behave as before.
- **No new owner question.** The [P1] package numbers are simulator measurements, so this unit does not reproduce them. The kernel side matches what P1 measured: `--keep-sym` called `keep_tile_symmetric` itself, and K2's surcharge is 0 for the Horseman line, as E3 `all_bps = 0` set it.

## 5. For the other units and the integrator

- **W1C-B (simulator), the signatures to call:**
  - `permutation_rules::frontier::keep::keep_tile_symmetric(&terrain_bytes, &sites, site_count, wedge) -> Option<u8>` (existing since CQ1-A, unchanged signature; P1's `--keep-sym` called exactly this);
  - `permutation_rules::frontier::catalog::variant_surcharge_v2(unit as u8) -> Option<i64>` (production per troop over a Spearman; 0 for Spearman and Horseman), or `train_v2(unit, n) -> Option<Cost>`;
  - `permutation_rules::frontier::doctrine::validate_table_v2(&table) -> Result<(), DoctrineError>` (`RefusedLine` for a Knight line).

  The doctrine gate's Knight control is a table that `validate_table_v2` refuses. Whether the MC doctrine gate keeps it as a negative control (as P1 did) or skips it as invalid is W1C-B's call. P1 measured it as rejected by the band.
- **W1C-C (contract v1.3):** §3.1 "keep tile" → `keep::keep_tile_symmetric(terrain, sites, site_count, wedge)`. §3.13 table: `KEEP_VERSION` 2, `CATALOG_VERSION_V2` 2, `DOCTRINE_VERSION_V2` 2. K2 and the Knight bound as in §1 (train table and doctrine bound). §3.10: provisional holdings count. The new `RULESET_HASH_V2` value.
- **CQ2-A (program):** OpenProvince places the keep with `keep_tile_symmetric` and the Province's wedge (the bridge `v2::kernel::keep::keep_tile(…, wedge)`). Train under v2 pays `catalog::train_v2` (bridge `v2::kernel::catalog2::train_v2`). CreateSeason v2, or the doctrine table's CI, runs `validate_table_v2`.
- **CQ3-A (verifier):** replays Train v2 with `train_v2` and keeps with the symmetric tile.
