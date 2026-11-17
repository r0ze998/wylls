# Wide generation kernels: terrain past ring 128 and a mixed-nation placement candidate

Status: experimental code, 2026-11-07, worktree `preserve/wide-world-tiles-20261107` on `647dfadf`. Two **shared generation kernels**, pure and opt-in, written while the integrator verifies the integration base for the actual ABI and write handlers. Neither is wired into a runtime, neither opens land, neither persists anything, and no playable expansion is claimed. Both keep the deployed ABI, every ruleset hash and every byte of existing terrain and ownership.

Owner decisions this work rests on: outer lands **mix nations** rather than form six wedges (confirmed). Not approved, and not changed here: probability distributions, prizes, the randomness oracle, a new Season parameter, any account or instruction number.

## 1. Files

| file | change |
|---|---|
| `permutation-rules/Cargo.toml` | feature `wide-terrain-experimental = []` (default off, no dependency) |
| `permutation-rules/src/frontier/terrain.rs` | `canonical` factored into `shape_province` (gates, carving, sites) and `generate_province` into `turn_canonical` (wedge rotation); `pub mod wide` behind the feature; a test with the verbatim pre-factoring text as oracle |
| `permutation-rules/src/frontier/terrain/wide.rs` | new: the wide terrain kernel |
| `frontier-abi/src/world_index/placement.rs` | new: the candidate mixed-nation rule (behind the existing `world-index-experimental`) |
| `frontier-abi/src/world_index/mod.rs` | `pub mod placement`, re-exports, one table row |
| this note | |

Nothing else was touched: no runtime wiring, no survey account, no vector, no hash input, no `KERNEL_VERSIONS` entry. `TERRAIN_VERSION` is still 1, `GEOMETRY_VERSION` still 1.

## 2. Wide terrain kernel (`frontier::terrain::wide`)

### Interface

```rust
pub const WIDE_TERRAIN_VERSION: u16 = 1;            // candidate; not in KERNEL_VERSIONS
pub const WIDE_NOISE_DOMAIN:   &[u8] = b"PSF-WIDE-TERRAIN-v1/noise";
pub const WIDE_BASE_DOMAIN:    &[u8] = b"frontier/terrain/wide-v1";
pub const WIDE_FEATURE_DOMAIN: &[u8] = b"frontier/feat/wide-v1";
pub const WIDE_BOUND: i64 = 1 << 62;                 // = world_index::WIDE_BOUND
pub const LEGACY_DISK_RING: u128 = 128;              // = R_MAX_HARD

pub enum WideTerrainError { OutOfBounds }
pub enum TerrainPath { Legacy, WideV1 }

pub fn terrain_path(p: i64, q: i64) -> Result<TerrainPath, WideTerrainError>;
pub fn generate_province_wide(ring_seed: &Seed, p: i64, q: i64)
    -> Result<ProvinceTerrain, WideTerrainError>;
```

`ring_seed` is the caller's proof-bound ring seed, exactly as for `generate_province`. The kernel selects no seed, derives no seed and names no oracle.

### The two paths

**Ring ≤ 128 (`Legacy`).** `generate_province_wide` calls `generate_province` on the exact `i32` pair (a coordinate of ring ≤ 128 has |P|, |Q| ≤ 128; the narrowing is `try_from`, refused on failure, never truncated). Existing terrain bytes are kept **by construction**: there is no second derivation to drift. The test `inside_the_legacy_disk_every_byte_is_generate_province` pins this over rings 0–10, the whole of rings 127 and 128, and every 97th province of the dense index, for two seeds.

**Ring ≥ 129 (`WideV1`).** The parent kernel's own private functions do the shaping, so there is one terrain rules engine, not two:

- `shape_province(concord, sample)`: the 18 gate tiles forced passable, every gate carved to the centre (`carve_path`, nearer-tile / passable-first / lower-index rule), greedy sites by `site_score` with ties to the lower index and at least 2 apart, every site carved to the centre. This is the former body of `canonical` with the per-tile sampling lifted out as a closure.
- `turn_canonical(canon, k)`: the wedge-`k` copy from the canonical wedge-0 copy, tile by tile and site by site. This is the former tail of `generate_province`.
- `classify`, `CELL_COARSE = 7`, `CELL_FINE = 3`, the thresholds, the `3:1` octave weights, the `% 16` resource roll and the terrain-to-resource table are the parent's constants and functions.

What differs past the disk is only how a tile is sampled, and that is versioned:

- Centre `(9P + 4Q, −4P + 5Q)` and tile `centre + offset` in `i128`; the wedge and canonical copy by the legacy sextant rule in `i128` (`canonical_copy`), so six-fold symmetry holds past the disk exactly as inside it.
- Planar noise coordinates by the legacy `plane` formula in `i128`.
- A lattice value is `sha256(len ‖ WIDE_NOISE_DOMAIN ‖ LE64(base) ‖ LE64(salt) ‖ LE128(x) ‖ LE128(y))[..8]` as a little-endian `u64`, top 10 bits, with `base = rand(ring_seed, WIDE_BASE_DOMAIN, [])`. All 16 bytes of each coordinate enter the hash. The legacy lattice mixes `x as u64`, `y as u64`; the legacy tile key packs `q as u32 ‖ r as u32`. Neither is used here.
- Interpolation is the legacy `mapgen::noise` smoothstep with **no period**: the rows are `y0` and `y0 + 1` themselves. The legacy call passes a 2⁴⁰-cell period that no legacy coordinate reaches, so legacy bytes do not depend on it; past the disk the period is simply absent.
- The resource roll is `rand(ring_seed, WIDE_FEATURE_DOMAIN, LE128(q) ‖ LE128(r)) % 16` with the same table.
- Lattice values are memoised per province (a province's 61 tiles share a few cells per octave); memoisation is pure and tested as such.

The 1-line smoothstep `3t² − 2t³` is restated in `i128` because `mapgen::smooth` is private to a sibling module that was not in scope to edit. It is the only duplicated formula, and it is pinned by endpoint and monotonicity checks.

### What the terrain kernel does not do

- It is not called by `OpenProvince`, the keeper, the verifier or the web client; the feature is off by default; `KERNEL_VERSIONS`, `_V2` and `_V3` do not mention it (`candidate_constants_are_pinned_and_outside_every_ruleset_hash`).
- It has no ring seed past ring 128. `addr::ring_seed` is `u16`-keyed and the RingSeed account and its proof/round binding are deployed ABI and game fairness. Supplying a seed for ring 129 is the writer's `verified-dr-and` task, not this kernel's.
- It has no wide Free City rule: `free_city_site` hashes `LE32(P) ‖ LE32(Q)` and is left untouched. A wide variant would be a separate versioned decision.
- It is not a terrain *demo*: it emits the same `ProvinceTerrain` type the program stores, from the same shaping code, so a future writer re-derives it bit for bit. It still creates no land.

## 3. Candidate mixed-nation placement (`world_index::placement`)

### Interface

```rust
pub const MIXED_PLACEMENT_VERSION: u16 = 1;          // candidate; not a Season parameter
pub const MIXED_PLACEMENT_DOMAIN_WIDE: &[u8] = b"PSF-PLACEMENT-WIDE-v1";
pub const LEGACY_OFFSET_MAX_RING: u64 = 65_535;

pub enum RingOffsetDomain { LegacyU16, WideU64 }
pub const fn ring_offset_domain(ring: u64) -> RingOffsetDomain;
pub fn ring_offset(ring: u64, genesis_seed: &[u8; 32]) -> u8;      // 0..6
pub fn mixed_home_nation(c: WideCoord, genesis_seed: &[u8; 32]) -> Option<u8>;
```

### The rule

Based on `geometry::home_nation`'s `PLACEMENT_DISPERSED` branch, extended from the heartland to every ring:

- ring 0: `None` (the Concord is neutral);
- ring 1: the wedge (seat `k` is nation `k`'s; `seat_of(f)` gives `Some(f)`);
- ring `r ≥ 2`: `(i + o_r) mod 6`, `i = wedge · r + position` in ring order (the `ring_provinces` walk), computed in `u128`.

The offset `o_r`:

- `r ≤ 65,535`: `u64(sha256(PLACEMENT_DOMAIN ‖ seed ‖ le16(r))[..8]) mod 6`, **bit for bit the deployed offset**, so inside any configurable heartland (rings 2..=hmr, hmr 2..=6) the candidate equals `home_nation(p, PLACEMENT_DISPERSED, hmr, seed)`, and the pinned heartland vector of `geometry` is reproduced;
- `r > 65,535`: `u64(sha256(MIXED_PLACEMENT_DOMAIN_WIDE ‖ seed ‖ le64(r))[..8]) mod 6`. The domain is chosen by `u16::try_from(ring)`; the ring is never narrowed.

Properties the tests pin: each nation takes exactly `r` of the `6r` provinces of ring `r`; ring order is a walk (consecutive provinces, and the wrap, are neighbours) along which the nation changes at every step; every wedge holds `min(r, 6) ≥ 2` nations, so no wedge is one nation's; same seed, same map; different seeds differ.

### What the placement candidate is not

- Not a Season parameter: there is no new `placement` value; `PLACEMENT_WEDGE` and `PLACEMENT_DISPERSED` keep their meaning; `home_nation` is unchanged and outside the heartland still returns the wedge (asserted in `candidate_constants_are_pinned_and_the_deployed_rule_is_untouched`).
- Not wired into any legacy season, keep, heartland, control or prize rule; existing ownership is not relabelled.
- **Texture note for the owner:** this is *evenly interleaved individual provinces* (nation changes every step round the ring). *Clustered nation patches* (runs of several provinces per nation, or 2-D blobs) would be a different rule, with different fairness and frontier properties, and need another owner decision. Nothing here chooses between them beyond implementing the one the existing dispersed rule already defines.

## 4. Tests

`permutation-rules` (`frontier::terrain`), default features:

- `factoring_into_shape_and_turn_changes_no_byte` — the Concord, rings 1–8, a stride of ring 128, the rim corners and far `i32` coordinates, 5 seeds, against the verbatim pre-factoring text of `canonical` and `generate_province`
- `gates_are_the_middle_of_each_border` (existing)

`permutation-rules` (`frontier::terrain::wide`), `--features wide-terrain-experimental`:

- `inside_the_legacy_disk_every_byte_is_generate_province`
- `past_ring_128_the_versioned_wide_path_is_used`
- `six_fold_symmetry_holds_past_the_disk_as_inside_it`
- `far_coordinates_are_exact_and_the_bound_is_refused_not_wrapped`
- `wide_lattice_reads_every_coordinate_byte_and_has_no_period`
- `wide_centre_and_wedge_agree_with_the_legacy_geometry`
- `candidate_constants_are_pinned_and_outside_every_ruleset_hash`

`frontier-abi` (`world_index::placement`), `--features world-index-experimental`:

- `inside_the_heartland_the_candidate_is_the_deployed_dispersed_rule`
- `the_concord_is_neutral_and_the_six_seats_keep_their_wedges`
- `outer_rings_are_balanced_and_every_wedge_mixes_nations` (rings 2–6, 17, 128, 129, 130, 300)
- `reproducible_and_the_seed_turns_the_ring`
- `rings_past_u16_and_past_2_53_use_the_wide_domain_without_overflow` (rings 65,535, 65,536, 2⁵³ + 5, 2⁶², 2⁶³)
- `candidate_constants_are_pinned_and_the_deployed_rule_is_untouched`

Commands for the native worker (nothing was compiled or run here):

```sh
cargo test --locked -p permutation-rules frontier::terrain
cargo test --locked -p permutation-rules --features wide-terrain-experimental frontier::terrain::wide
cargo test --locked -p frontier-abi --features world-index-experimental world_index::placement
cargo test --locked -p frontier-abi --features world-index-experimental world_index
cargo clippy --locked -p permutation-rules --features wide-terrain-experimental --all-targets -- -D warnings
cargo clippy --locked -p frontier-abi --features world-index-experimental --all-targets -- -D warnings
cargo check --locked --offline -p permutation-rules --no-default-features --lib
cargo run --locked -p frontier-abi --bin abi-vectors -- --check
rustfmt --edition 2021 --check permutation-rules/src/frontier/terrain.rs permutation-rules/src/frontier/terrain/wide.rs frontier-abi/src/world_index/placement.rs frontier-abi/src/world_index/mod.rs
```

The ring-129 terrain test runs 774 wide generations plus 774 legacy ones and the legacy-disk test about 9,500 legacy generations; both are the slow ones in a debug build.

## 5. Implemented vs pending

Implemented (pure, tested in source, off by default):

- wide terrain kernel with exact legacy delegation inside ring 128 and a versioned `WideV1` path past it;
- shared shaping helpers factored out of the legacy kernel, pinned byte-identical;
- candidate mixed-nation placement over `WideCoord` with the legacy offset inside `u16` rings and a versioned domain past them.

Pending (not started, out of scope for these files):

- a proof-bound **ring seed past ring 128**: a wide RingSeed identity, its round binding and its account are ABI and oracle work for the writer;
- a **wide Free City** site rule (`free_city_site` is `LE32`-keyed);
- any **wiring**: `OpenProvince`, the keeper, the verifier, the web client, `KERNEL_VERSIONS`, a ruleset hash input, a Season parameter;
- a `frontier-abi` test pinning `terrain::wide::WIDE_BOUND == world_index::WIDE_BOUND` (both are `1 << 62`; `permutation-rules` cannot depend on `frontier-abi`, and a cross-feature test needs a feature in `frontier-abi` that was not in scope to add).

## 6. Specification risks

1. **Symmetric terrain under mixed nations is not automatically fair.** Terrain is six-fold symmetric per ring (both kernels). Under the cyclic placement, nation `f` in ring `r` takes positions `i ≡ c_f (mod 6)`; in wedge `k` those are canonical positions `j ≡ c_f − k·r (mod 6)`. When `gcd(r, 6) = 1` the six wedges together give every nation each canonical position exactly once: perfectly fair. When `6 | r` every nation gets six copies of only `r/6` canonical positions, and nations see **different** canonical land. Rings 2, 3, 4 and 6 of the *deployed* dispersed heartland already have this property, so it is not introduced here, but extending it to every ring makes it a season-wide fact. Options (owner decision): accept; shift the offset per wedge; or generate terrain per nation-class. The native review added the orbit-balanced alternative below; none is selected for a live world.
2. **Ring seed past 128.** The kernel takes a caller seed. If the writer's wide RingSeed derivation differs per ring in a way the current `generate_province` contract does not (e.g. seeds per region rather than per ring), six-fold symmetry past the disk would need the same seed for all six wedges of a ring, as inside it.
3. **Compute cost.** `WideV1` is about 60–110 sha256 per province for lattice values plus 61 for resource rolls (memoised), against 61 sha256 and cheap mixes for the legacy kernel. Acceptable for a verifier and the host simulator; a per-transaction budget on Solana for a ring-129 `OpenProvince` has not been measured.
4. **Refactor footprint in the default build.** `shape_province` and `turn_canonical` are the former bodies behind a generic closure. Bytes are pinned by the verbatim-oracle test; compute units on Solana for the legacy path were not measured and could move by inlining.
5. **Placement past `u16` rings** changes domain at ring 65,536. That boundary is chosen to keep the deployed offset bit for bit wherever it is defined; if the owner prefers one domain for all rings ≥ 2 outside the heartland, the `LegacyU16` arm would be confined to the heartland and `MIXED_PLACEMENT_VERSION` bumped.
6. **"Mixed" texture.** Interleaved single provinces are implemented because the existing dispersed rule defines them. If the owner wants patches, this module becomes a different rule rather than an extension.

## Native validation

Native execution: terrain suite 9/9 and world_index suite 56/56 passed before adding the orbit-balanced comparison. No keypair or signing operation was executed.

## Native review: fair-terrain comparison candidate

`placement::orbit_balanced_outer_nation` uses `(wedge + canonical_position + ring_offset) mod 6` only past ring 128; it refuses the deployed disk. For each canonical province, its six rotated copies belong one each to the six nations. Therefore every nation receives exactly the same terrain/resource multiset, under the six-fold terrain kernel and a common ring seed, even at rings divisible by six. Every outer wedge still mixes all six nations. This preserves terrain fairness, not equality of strategic adjacency, routes, player density or future captures.

The alternative is executable comparison code, not an approved product rule. Neither placement candidate changes existing owners or is called by the program. Tests cover all six nations per terrain orbit, balanced counts, wedge mixing, large coordinates and refusal to relabel legacy land.

Final native checks before commit: mixed placement 7/7 (including the orbit comparison), both new libraries clippy clean, and permutation-rules no-default-features check passed. The original broad world_index run was 56/56; the added seventh placement test passed separately. No ABI vector regeneration, SBF measurement, live writer or signed-chain run was performed.
