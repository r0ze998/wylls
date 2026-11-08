# Wide tiles: exact province ↔ tile geometry past ring 128, and a bounded route check

Status: experimental code, 2026-11-07, worktree `preserve/wide-world-reader-20261107` on `9387b63c`. One prerequisite for "actual wide land and movement", built under the bounds of `UNBOUNDED-IDENTIFIERS.md` and on the foundation of `WIDE-WORLD-INDEX.md`. It is **not** connected to any runtime, it generates **no** land, and it dispatches **no** march.

## 1. What was added

One file, `frontier-abi/src/world_index/tiles.rs`, behind the existing cargo feature `world-index-experimental` of `frontier-abi` (`default = []`, no new dependency, no new crate; `Cargo.lock` unchanged). `world_index/mod.rs` gains the `pub mod tiles;` line, the re-exports, one table row, and a corrected trust statement: the module's only consumers are the read-only herald `wide` module and the web `map/wide.mjs` reader of `WIDE-WORLD-INDEX.md` §4.4 (the previous "no consumer" wording was stale). No other file changed. `frontier-abi/src/lib.rs` still says "no consumer" in its module table and was deliberately not touched by this change.

| piece | what |
|---|---|
| `WideTile` | a tile of one world by global axial `(q, r)` as **`i128`**, with its province (`WideCoord`) and local index (`u8`, `0..61`) resolved at construction; `checked(world, q, r)`, `of(TileAddress)`, `from_legacy(world, Hex)`, `legacy_hex()`, `province()`, `local()`, `address()`, `distance()`, `is_adjacent()`, `neighbors()` |
| `TileAddress` | `(ProvinceKey, local index)`; `new` refuses an index ≥ 61 |
| `TILE_COORD_BOUND` | `13·2⁶² + 4`, the largest \|q\| or \|r\| of any tile of any province within `WIDE_BOUND` |
| `RouteBounds` | caller-stated `(max_steps, max_provinces)`, each `1..=` the legacy `travel::MAX_PATH_STEPS` (32) and `MAX_PATH_PROVINCES` (4); `RouteBounds::LEGACY` is exactly those |
| `ProvinceSource` | `fn reported(&ProvinceKey) -> Result<Lookup, IndexError>`; any closure of that shape is one, so an `OpenedProvinceIndex` is one as `\|k\| index.lookup(k)` |
| `verify_route` | `(world, start, steps, bounds, source) -> VerifiedRoute` or a named `RouteError` |

## 2. The geometry, exactly

The legacy world (`permutation_rules::frontier::geometry`) is one lattice of radius-4 hexagonal provinces of 61 tiles. Province (P, Q) is centred at tile `(9P + 4Q, −4P + 5Q)` (`cell_centre` with n = 4; the lattice basis A = (9, −4), B = (4, 5), determinant 61). A province's tiles are its centre plus the 61 offsets of `tile_offset`, numbered by `tile_index` in `hexes_within(4)` order. The tile → province direction is `cell_of`: the floored real coordinates of the tile in the lattice basis (inverse matrix `(5, −4; 4, 9) / 61`), then the nearest of the 3 × 3 lattice points around them, unique because radius-4 hexagons tile the plane.

`tiles.rs` is **that lattice with (P, Q) the `i64` pair of a `WideCoord`** (|P|, |Q| ≤ 2⁶²), and nothing else:

- The same centre formula, with the coefficients pinned at compile time against `PROVINCE_RADIUS = 4`, `PROVINCE_TILES = 61` and the determinant.
- The same local offsets: `tile_offset` and `tile_index` are **reused**, not reimplemented.
- The same `cell_of`, ported to `i128`. A tile coordinate reaches `13·2⁶² + 4`, past `i64` and far past the 2⁵³ a JS `Number` holds exactly; every intermediate of the nearest-cell search is below 2⁷¹, so `i128` has a wide margin, and no coordinate is ever an `f64`.
- No unchecked narrowing. The cell is narrowed to `i64` with `try_from`, checked against `WIDE_BOUND` with `WideCoord::checked`, and the offset is narrowed to `i32` with `try_from` and looked up with `tile_index`. Each failure is `TileError::OutOfWorld`, never a panic and never a wrapped coordinate.
- The world has an edge. A coordinate past `TILE_COORD_BOUND`, or inside it but nearest to a province past the bound, is refused; a `neighbors()` step that would leave the world is `None`.
- Every tile binds its `WorldId`. `distance` and `is_adjacent` between tiles of different worlds are `WorldMismatch`, and a `TileAddress` is a `ProvinceKey` (world-scoped) plus the local index.

Identity with the legacy geometry, as the tests pin it:

- for **every tile of every province of ring ≤ 128** (49,537 × 61): the wide tile at `(key, local)` has the coordinates of `ProvinceCoord::tile(local)`; `WideTile::checked` of those coordinates gives back the same province and local index; `legacy_hex()` is the legacy `Hex`; and the legacy `locate` agrees;
- on a sample lattice in the box |q|, |r| ≤ 1,800 (every tile of ring ≤ 138): province and local index equal `locate`, the six neighbours equal `Hex::neighbors` in `DIRECTIONS` order, and distances equal `Hex::distance`.

## 3. Past the legacy disk

- **Ring 129.** Every tile of every ring-129 province round-trips and agrees with the legacy `locate` (the legacy lattice arithmetic is exact there; only the dense index is missing, and `LegacyAdapter::dense_index_of` refuses it with `BeyondLegacyDisk { ring: 129 }`). Every tile-level crossing from a ring-128 tile into a ring-129 tile is checked both ways, and the set of ring-129 provinces reached by some crossing is all 774 of them.
- **Past 2⁵³.** Provinces (2⁵³ + 1, −3), (−2⁵³ − 7, 2⁵³), (2⁵³, 2⁵³) and (2⁴⁰, −2⁴¹): every tile round-trips, has no legacy `Hex`, and for at least one tile of each `(q as f64) as i128 != q`, which is why the client side must carry tiles as BigInt or decimal strings, as `map/wide.mjs` already does for provinces.
- **The far corners.** Provinces (±2⁶², ±2⁶²), (2⁶², 0), (0, −2⁶²): every tile round-trips; the tile of (2⁶², 2⁶²) at offset (4, 0) is exactly `(TILE_COORD_BOUND, 2⁶²)`; of its six neighbours the three that would lie in provinces (2⁶² + 1, 2⁶²) and (2⁶², 2⁶² + 1) are `None` and the other three exist; `(TILE_COORD_BOUND + 1, ·)`, `i128::MAX`, `i128::MIN` and two coordinates inside the box but nearest to a province past the bound are `OutOfWorld`; the mirror corner behaves alike; the two extreme tiles are `2·TILE_COORD_BOUND + 2·2⁶²` apart.
- **Malformed input.** Local indices 61, 62, 100 and 255 are `LocalIndex(n)` for keys at ring 0, 128, 129 and the bound.

## 4. The route check, and what it is not

`verify_route(world, start, steps, bounds, source)` runs the checks of `travel::path_cost` in the same order, and no others except openness:

1. an empty route is `EmptyRoute`; more than `bounds.max_steps` steps is `TooLong` (before any tile is looked at);
2. the start must be a tile of `world`, and its province must be **reported open** by `source` (`Lookup::Known` with `ReportedState::Open`): `Unknown` is `UnknownProvince`, `Closed` is `ClosedProvince`, a source refusal (for instance an `OpenedProvinceIndex` of another world) is `Source(IndexError)`;
3. step by step: a tile of another world is `WorldMismatch`; a step not at distance 1 from the previous tile is `NotAdjacent { step }` (standing still is not a step); a step entering a new province when `bounds.max_provinces` are already entered is `TooManyProvinces { step, max_provinces }`; a newly entered province must be reported open, asked of the source once.

The result lists the distinct provinces the steps **enter**, in first-entered order, the legacy `PathCost::provinces` rule (the start's province is listed only if a step enters it). The tests pin that the straight walk east from the Concord centre gives the same province list as `path_cost` over plains (four provinces in 23 steps: (0, 0), (1, 0), (1, 1), (2, 1)), the same refusal at the 24th tile (a fifth province, step 23, `TravelError::TooManyProvinces`), the same `TooLong` at 33 steps and the same `NotAdjacent(2)` for a skipped tile; that tighter explicit bounds bind; that a crossing from (128, 0) into (129, 0) passes only when (129, 0) is reported open; that a walk inside (2⁶², 2⁶²) passes and that no route can even name a tile past the edge.

`RouteBounds::new` refuses 0 and anything above 32 steps or 4 provinces: the verifier can only be asked for **less** than the legacy march, never more. These numbers are inputs, not a new rule of the game.

What the route check is **not**:

- not movement: no terrain, no road, no unit, no seconds, no bells, no stamina, no supply; `travel::path_cost` keeps all of that for the current ABI and is untouched;
- not dispatch: nothing is sealed, revealed, scheduled or settled; no Holding, ArrivalSlot or host is read or written;
- not evidence of land: `ReportedState::Open` means "a source said so", as in `index.rs`. A source that lies gets a route over lies. The verifier refuses what the source has not said; it cannot make the source honest;
- not an authority on worlds: `WorldId` is whatever the caller derived (`WorldId::derive_legacy_season` for the one legacy world); the verifier only checks that every tile, key and source agree on it.

## 5. What remains before actual wide land or movement

Unchanged from `WIDE-WORLD-INDEX.md` §4, and listed again so this note is not mistaken for more than it is:

- **Terrain past ring 128** does not exist: `ring_seed(d)` is `u16`-keyed and `terrain::generate` runs per legacy province; `WideTile` names where a tile would be, not what is on it.
- **Instructions** carry `i16` P, Q and tile indices as `u8` within a legacy province; a wide route has no wire encoding here (a `TileAddress` is 50 + 1 bytes of existing layouts, not a new ABI).
- **Accounts** (`Holding`, `ArrivalSlot`, `ClashInputs`) key hosts by the 20-bit `u64` host id; `WideHostRef` is convertible within ring 128 only.
- **The keeper, verifier and program** do not call anything in `world_index`; the only consumers are the read-only herald and web readers.
- **The economy** (what a march costs past the disk, supply, nations across wedges, the prize) is undecided and untouched.

## 6. Safe exact commands (for the native worker; nothing was run here)

```sh
cargo test --locked -p frontier-abi --features world-index-experimental world_index::tiles
cargo test --locked -p frontier-abi --features world-index-experimental world_index
cargo clippy --locked -p frontier-abi --features world-index-experimental --all-targets -- -D warnings
cargo check --locked --offline -p frontier-abi --no-default-features --lib
cargo run --locked -p frontier-abi --bin abi-vectors -- --check
rustfmt --edition 2021 --check frontier-abi/src/world_index/tiles.rs frontier-abi/src/world_index/mod.rs
```

The native worker formatted only the changed Rust files and compiled and ran the focused tests. Avoid `cargo fmt --all` in a shared integration checkout. The exhaustive ring ≤ 128 test visits 3,021,757 tiles four ways and is the slowest of the module in a debug build.

Tests in `tiles.rs` (fixed bytes for every world id, no keypair, no signature, no network):

- `lattice_constants_are_the_legacy_ones`
- `every_tile_of_the_legacy_disk_keeps_its_geometry`
- `tiles_in_a_box_locate_and_step_like_the_legacy_grid`
- `ring_129_crossings_locate_exactly_on_both_sides`
- `coordinates_past_2_53_stay_exact`
- `far_bound_corner_tiles_round_trip_and_refuse_to_leave_the_world`
- `malformed_local_indices_are_refused`
- `legacy_hex_narrows_only_what_fits_i32`
- `worlds_do_not_mix`
- `route_bounds_are_explicit_and_capped_at_the_legacy_limits`
- `a_bounded_route_over_reported_open_land_matches_the_legacy_path_check`
- `no_fake_land_unknown_closed_and_other_world_provinces_refuse_the_route`
- `routes_at_ring_129_and_at_the_far_corner_are_the_same_check`

## Native validation

The native review corrected two test inputs (ring 129 must use the wide ring iterator, and a precision-loss sample must actually exceed 2^53). It also made the route gate compare the returned record key with the requested province key: an open record from another province or world must not authorize this route. A regression test covers both substitutions. This remains a pure topology/report check, not proof of finality, terrain passability, authorization, or an executed march.

Final checks for this change: 47/47 `world_index::` tests passed (14 new tile/route tests), feature-enabled library/test Clippy passed with warnings denied, and default-feature-disabled `cargo check` passed. No keys, signatures, browser, CI or deployment were used. `abi-vectors --check` still reports the previously observed stale `v2/layouts.json` and `v2/logs.json`; no vector, generator, deployed layout or log definition was changed or regenerated. This is not an all-checks-pass claim.

## Existing movement schedule

`world_index::movement::quote_reported_route` now applies the unchanged `travel::hex_secs` function to exact wide tiles after the topology/report checks. It refuses unknown terrain, a report for another tile/world, and impassable water or mountain even when a road is claimed. This is a pure quote over caller-reported immutable snapshot data, not authentication, movement, battle or settlement. Three additional tests cover all eight unit types, passable terrain and road combinations against legacy `path_cost`, refusal cases, and ring129/far-coordinate crossings. The focused `world_index::` suite now has 50 passing tests. See `PLAYABLE-WIDE-COMPATIBILITY.md` for the actual write-path prerequisites.
