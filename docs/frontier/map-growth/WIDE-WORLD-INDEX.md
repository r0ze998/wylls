# Wide world index: an opt-in foundation past ring 128, and what it does not do

Status: experimental code, 2026-11-07, worktree `work/autonomous-map-growth-20261107` on `30d60d27`. Companion to `UNBOUNDED-IDENTIFIERS.md`, which records the bounds; this note records one compatibility-preserving piece built under them and reviews, honestly, how far it is from an unbounded live game.

## 1. What was added

`frontier-abi/src/world_index/` behind the cargo feature `world-index-experimental` of `frontier-abi` (`default = []`, no new dependency, no new crate, so `Cargo.lock` is unchanged and every `--locked` build is as before). Four files, one concern each, tests inside each:

| file | content |
|---|---|
| `coord.rs` | `WideCoord`: `i64` (P, Q) bounded to ±2⁶², all arithmetic in `i128`; ring (≤ 2⁶³), wedge, position; a 17-byte canonical sort key `ring ‖ wedge ‖ position` (big-endian) whose byte order is ring order; `ordinal()` as `u128`; checked neighbours and rotation |
| `key.rs` | `WorldId` (32 bytes, zero reserved; `derive_legacy_season(season_pda, program)` = sha256 of public bytes under a domain); `ProvinceKey` = world + coordinate, 50-byte versioned layout; `WideHostRef` = key + site + gen + seq, 56-byte versioned layout |
| `legacy.rs` | `LegacyAdapter` of one world: `ProvinceCoord` ↔ wide exact for any `i32` pair; dense index and `u64` host id only within ring 128 and only in the adapter's world; `BeyondLegacyDisk`, `BeyondI32`, `InvalidHostId`, `WorldMismatch` otherwise |
| `index.rs` | `OpenedProvinceIndex`: one `BTreeMap<sort key, record>` per world; `insert` (revision 1, unknown key), `update` (exactly the next revision); `lookup` → `Unknown` or `Known`; ring windows; `first_page`/`next_page` with `limit ∈ 1..=256`; a `Cursor` bound to world, window, epoch and content fingerprint; `snapshot`/`restore` in a canonical byte form |
| `mod.rs` | the trust statement, re-exports, a composition test and a test that the pinned production limits are unchanged |

The existing `host_id` (`u64`, 20-bit province field), `ProvinceCoord::index`, every account layout, seed string, record format, `RULESET_HASH` input, `R_MAX_HARD = 128`, the keeper's `extend = false` / cap 17 and the prize bitmap are untouched. `grep -r world_index` finds the new module, the gated `pub mod` line and doc row in `frontier-abi/src/lib.rs`, the feature comment in `frontier-abi/Cargo.toml`, this note and one paragraph of `UNBOUNDED-IDENTIFIERS.md`; no program, keeper, herald, verifier, prize or web file.

## 2. Invariants the tests pin (all deterministic, no key material, no network)

- **Bounds.** ±2⁶² accepted inclusive; 2⁶² + 1, `i64::MIN`, `i64::MAX` refused. Rings at the four corners computed exactly (2⁶³ at (B, B)). A neighbour step or 60° turn that would leave the bound returns `None`/`OutOfBounds`, never a wrapped value.
- **Legacy order equality.** For all 49,537 provinces of ring ≤ 128 (every `ProvinceCoord::from_index(i)`): the wide `ordinal()` equals `i`, sort keys are strictly increasing in `i`, and every key decodes back to its coordinate. For rings ≤ 20 the wide (wedge, position) equals the legacy `(i / d, i % d)`.
- **Past every legacy limit.** Ring 129 (past the disk), ring 592 (first ordinal ≥ 2²⁰, the host id's province field; ring 591 still fits), ring 2⁴⁰ (ordinal > `u64`), and the bound itself: keys round-trip, the adapter refuses a dense index and a host id with `BeyondLegacyDisk { ring }`, and the legacy codec agrees (`addr::host_id` is `None`). No wide province can produce a `u64`, so none aliases a legacy one.
- **Canonical bytes.** Non-canonical sort keys (wedge ≥ 6, position ≥ ring, nonzero wedge/position at ring 0) and canonical positions that leave the bound are refused in both the position and byte forms. Key and host-reference bytes refuse wrong length, wrong version, the reserved world and a bad site. `ProvinceKey` byte order equals its `Ord` (world, then ring order).
- **Unknown versus closed.** A never-reported province is `Lookup::Unknown`; a province reported closed is `Known` with `ReportedState::Closed`; the two are distinct and a closed province is still listed by a walk.
- **Revisions.** Insert needs revision 1 and an unknown key (`InvalidFirstRevision`, `DuplicateInsert`); update needs a known key (`UnknownRecord`) and exactly `current + 1` (`StaleRevision`, `DuplicateRevision` for a byte-identical replay, `ConflictingRevision` for other content at the same revision, `RevisionGap`). A refusal never moves the epoch. Counter exhaustion is refused before any mutation, including after restoring an untrusted maximum-valued counter.
- **Worlds.** Insert, update, lookup and cursors of another world are refused with the world named; the adapter refuses keys and references of another world.
- **Pages.** `limit` 0 and > 256 refused. For limits 1, 2, 7, 64, 256 over 473 entries (all of rings 0–12 plus entries at ring 2⁴⁰ and at the bound, inserted in a seeded shuffle and in reverse), the concatenated walk equals the sorted set, every page is ≤ `limit`, a next cursor appears only after a full page, and a second index with another insertion order gives the same pages and the same snapshot bytes. Ring windows select exactly their rings (3..=5 → 72 entries); a window far from any entry returns an empty page with no cursor; an entry at ring 2⁴⁰ or 2⁶³ is found by a window at that ring without touching any other ring.
- **Cursors.** Valid while nothing changes, still valid after a refused mutation, `StaleCursor` after one successful mutation; cursor bytes round-trip (106 bytes) and refuse wrong length/version, the reserved world, `lo > hi`, a non-canonical last key and a last key outside the window.
- **Persistence.** `restore(snapshot())` equals the original (world, epoch, records, every page, every lookup) and re-snapshots to the same bytes. Tampering is refused by case: truncated header or entry, trailing byte, wrong magic, reserved world, count ≠ length, swapped or repeated entries (`Order`), non-canonical key, state byte 0/3/255, revision 0.
- **Composition.** A legacy host id → wide reference → index entry → lookup → legacy coordinate, dense index and host id, exact; a ring-129 entry in the same index has no legacy identity.
- **Production limits unchanged with the feature on**: `R_MAX_HARD = 128`, 49,537 < 2²⁰, `ABI_VERSION = 1`, `GEOMETRY_VERSION = 1`, `ADDR_VERSION = 1`, `host_id(129, 0, …) = None`.

## 3. Safe exact commands (for the supervisor; nothing was run here)

```sh
# the new module (compiled only with the feature)
cargo test --locked -p frontier-abi --features world-index-experimental world_index
cargo clippy --locked -p frontier-abi --features world-index-experimental --all-targets -- -D warnings
# the default build is unchanged
cargo check --locked --offline -p frontier-abi --no-default-features --lib
cargo run --locked -p frontier-abi --bin abi-vectors -- --check
rustfmt --edition 2021 --check frontier-abi/src/world_index/*.rs
```

The sources were written without running rustfmt; if `rustfmt --edition 2021 --check frontier-abi/src/world_index/*.rs` reports the four new files, `cargo fmt --all` is the fix and changes no behaviour.

## 4. Critical review: can an unbounded-world runtime use this?

As a pure library for a **reader** (herald, web client, a keeper's planning step, a verifier's cache), yes: it is the data structure such a reader would need instead of `provinces_within(R)` arrays, and the adapter lets it ingest today's PROVINCE_OPEN records and host ids losslessly. As a component of the **on-chain program or of any deployed state**, no, and not by a small margin. Precisely what remains:

### 4.1 ABI and state migration (none of it done here)

- **Instruction coordinates** are `i16` P, Q (`frontier_abi::ix`). A wide coordinate needs new instruction encodings (an `i64` pair, or the 17-byte sort key) under new tags: a new ABI version, with the prologue tables, `ix.rs`, the vectors and the web encoder all extended.
- **Account seeds** are `"pv" ‖ hex(le32(P) ‖ le32(Q))` under the Season PDA with a 15-byte raw-key limit (`addr.rs`). A world-scoped, wide province address does not fit the current seed grammar (32 + 16 bytes of raw key > 15). It needs either a hashed seed (`sha256(ProvinceKey bytes)` truncated, which loses "split it back") or a per-world base account (reading 3.1 (b) of the identifiers note). Either is a new `SeedKind`, a bump of `ADDR_VERSION`, and therefore a new `RULESET_HASH`. Not touched.
- **Province, Holding, ArrivalSlot, ClashInputs** store `i16` P, Q and `u64` host ids. `WideHostRef` is 56 bytes; every host-bearing layout (`Holding`, `ArrivalSlot`, `ClashInputs`, the `MARCH`/`RETIRE`/`CARAVAN_*` records, `faddr.hostParts` in the client) needs a v2 layout to carry it. The adapter proves the two are convertible within ring 128; it does not migrate a single account.
- **Season fields** `R_MAX`, `RINGS_OPENED`, `R_MAX_EXT` are `u16`; ring windows here are `u64`. A season past ring 65,535 needs new fields; a season past 128 needs the hard maximum changed on purpose, which this work deliberately did not do.
- **Records and feeds**: PROVINCE_OPEN, KEEP, NEUTRAL, RING_OPEN, FRONTIER_EXTENDED key by `i16` or by ring `u16`; `/h/world/...` paths and the control file are dense. New record versions and a sparse feed format are needed; the `ProvinceKey` byte form is a candidate key for them, nothing more.
- **Ordering semantics**: the index orders by ring, wedge, position. The legacy "walk round the ring" (`home_nation` placement, `ring_provinces`) is the same order, so a dispersed placement could in principle be computed per ring without a dense array, but `home_nation` itself still calls `index()` and is bounded at 128.

### 4.2 Resource, keeper and view costs

- **Memory**: one `BTreeMap` node per reported province (17-byte key, 8 + 8 + 1 + 8 + 16 bytes of record), independent of ring. 10⁶ provinces ≈ 60–100 MB in a host process; fine for a herald, not for an SBF account (10 MiB) without chunking into pages, which this module does not do.
- **Snapshot** is `56 + 34·n` bytes, written and read in O(n). There is no incremental or chunked persistence, so a keeper that restores on every start pays O(n) each time; a chunked, per-ring-band or per-epoch log format is a follow-up.
- **Page cost** is O(log n + limit) per page, never O(provinces in the window). The keeper's per-turn walk (`keeper-load.ja.md`) would become "walk the pages of the rings that changed", but *which rings changed* is not something this index knows: it has no change feed, only `epoch` as a coarse stamp. A delta log keyed by (epoch, key) is the missing piece for "proportional to what changed".
- **Cursor invalidation at every mutation** is correct and simple, and it is hostile to a live view: any insert during a walk forces a restart from the window's start. A production reader needs either snapshot isolation (walk a restored snapshot) or a weaker, documented resume rule. Chosen on purpose: the strict rule cannot serve stale or duplicated rows; the relaxed one is a design decision.
- **Trust at the edges**: nothing validates that an inserted entry corresponds to a chain record. The runtime that feeds the index must do what the herald does today (decode a PS2 record, check its chain and address), and the index must be understood as that runtime's memory, not as evidence.

### 4.3 Unresolved game decisions (not advanced here, deliberately)

- **Nations**: wedges are sextants of one origin. A second world has six wedges of its own; whether a nation is one body across worlds (shared votes, stances, expulsions, `ProvinceFunds` per wedge) or one per world is undecided. `WideCoord::wedge()` is defined for any ring, so "wedge k continues outward for ever" is a *possible* reading of one lattice, but the heartland, the funds and the keep rules are all bounded by `heartland_max_ring ≤ 6` and `free_city_min_ring ≤ 64`.
- **Travel**: marches are ≤ 4 provinces and 32 steps on one lattice. Within one wide lattice, `travel.rs` would work on wide coordinates only after its `i32` tile arithmetic (`check_hex`, bound 2¹⁶ tiles ≈ ring 1,800 in provinces) is widened; between worlds there is no lattice and no decision (none, portals, seams).
- **Prize**: `permutation_prize::MAX_RING = 17` and a 1,024-bit bitmap over the dense index. A prize over a sparse world is a different tally (per key, per ring band, or capped as now). The keeper's `extend_max_ring = 17` stays because of this.
- **World identity and asset identity**: whether `WorldId` is implied as "the legacy season" for every existing Holding/Citizen (additive) or every key changes (cut-over), and whether one NFT resident may be a resident of two worlds, are the questions of §3.4 of the identifiers note; `derive_legacy_season` only gives the additive reading a name.
- **Terrain and seeds**: `ring_seed(d)` is `u16`-keyed; terrain at ring 70,000 has no seed account today.

## 4.4 A first read-only consumer (2026-11-07, worktree `preserve/sparse-world-foundation-20261107` on `f898d8da`)

One narrow path, end to end, that shows **real captured land** through the adapter and invents nothing:

| piece | where | what |
|---|---|---|
| herald feature `wide-world-experimental` | `frontier-node/crates/herald/Cargo.toml` | enables `frontier-abi/world-index-experimental` for the herald only; default off |
| `herald::wide` | `frontier-node/crates/herald/src/wide.rs` | `WideIndex`: one `OpenedProvinceIndex` of `WorldId::derive_legacy_season(season PDA, program)`, fed from `Fold::index_account` (first capture of a Province → `Open` at its opened bell) and `unindex_account` (a closed account → `Closed`); a re-capture of the same Province is a no-op, so the snapshot does not move every bell. A per-mutation stamp (`sha256` chain) is the snapshot identity beside the epoch: no page hashes or scans the index |
| `GET /h/world/wide` | `server.rs` | the manifest: `world` (hex), `worldDomain`, `season`, `program`, `seasonAddress`, `snapshot {epoch, stamp, foldedThrough, lastSlot}`, `recorded`, `refused`, `legacy {rMax, rMaxHard, ringsOpened, provinces}`, `page {path, max 256, default 64}`, `experimental: true`, `readOnly: true`, `completeness: "captured"` |
| `GET /h/world/wide/page?limit=&after=` | `server.rs` | ≤ `limit` entries in ring order, each `{p, q, ring, pos}` as **decimal strings**, `wedge`, `state` (`open`/`closed`), `revision`, `observedAt`, `legacy {p, q, index, ring, region, openedBell, slot, address}` or `null`; `next` = the cursor's hex or `null`. Refusals by name: `400 BadLimit`, `400 BadCursor`, `409 WorldMismatch`, `409 StaleSnapshot`, `503 NoSeasonYet`; without the feature both routes answer `503 WideWorldUnavailable` |
| `map/wide.mjs` | `permutation-server/web/frontier/map/wide.mjs` | pure: strict BigInt decoding (canonical decimal only; `Number` never touches a global coordinate), `ringPosition` recomputed as `WideCoord::ring_position`, `worldIdOf` recomputed from the public addresses, `parseWideManifest` / `parseWidePage` (sample/proto marks, another world, another snapshot, a wrong `after`, repeats, disorder, a lying ring, a cursor after a short page: each refused by code), `WideWalk` (page state with a token; a reset or an abort drops a late page), `loadWide` (bounded: 64 pages × 256), a BigInt camera origin with `relativeTo` / `layoutWide` / `nearestTo` |
| `herald.mjs` `wideWorld`, `wideWorldPage` | the client | a 404 or the herald's `503 WideWorldUnavailable` comes back as `WideWorldUnavailable`; the caller's `AbortSignal` reaches `fetch` |
| `map/widemode.mjs` + a `記録` button in `.map-tools` | the `/frontier` page (`app.mjs` mounts it after the map) | a read-only sheet over the ordinary map: status (world, snapshot, recorded/shown/open/closed counts, truncation), the facts line ("captured records only; an unlisted place is unknown, not open; nothing is sent or signed"), exact coordinate readouts (origin, pointer, selection), a list of recorded provinces that recentres on click, drag/wheel/keyboard pan and zoom, "recentre here" / "Concord as origin", a manifest poll every 30 s that reloads on a new snapshot; refused on a sample world before any request; the ordinary map is untouched |

Tests (fixed data, no keys, no network beyond loopback): `herald/src/wide.rs` unit tests (namespace, no-op re-capture, close as revision 2, ring-ordered pages, cursor death, 2⁶² as a decimal string); `herald/tests/wide.rs` (the fixture archive's four Provinces recorded exactly with their capture slot and address, snapshot unmoved by every later transaction, the Concord unknown, pages of 3 + 1, world/stale/malformed cursors, a close → `closed` with `legacy: null`, the HTTP codes, and the `503 WideWorldUnavailable` of a default build); `permutation-gateway/test/web-frontier-wide-world.test.mjs` (precision past 2⁵³, legacy positions, namespace, manifest and page refusals, the walk's joins/cut/abort/reset/switch, the relative camera, the client codes).

Commands for the supervisor (nothing was run here):

```sh
cd frontier-node && cargo test --locked -p herald --features wide-world-experimental wide
cd frontier-node && cargo test --locked -p herald --test wide          # the 503 of a default build
cd frontier-node && cargo clippy --locked -p herald --features wide-world-experimental --all-targets -- -D warnings
cd permutation-gateway && node --test test/web-frontier-wide-world.test.mjs
```

Limits that stay: the herald's wide index is rebuilt from the checkpoint on restart (another stamp: a reader starts over); only the legacy season's one world exists (no second world is served or invented); every entry is within ring 128 because that is all the fold can capture; a walk is cut at 16,384 entries and says so; the mode's texts are Japanese (no English entries were added to the dictionary); the sheet is a presentation of captured records, not a game surface (no actions).

## 5. What this foundation is, in one sentence

A tested, lossless, world-scoped, sparse identifier and index layer that a reader could adopt now and that any future wide ABI could key on, with an exact adapter to every identifier the deployed program issues; it is not an unbounded game, it opens no land, and it decides none of the economy.

## Supervisor validation (2026-11-07)

- 33/33 pure `world_index::` tests passed with the experimental feature. No keypair generation, signing or network calls occur in these tests.
- Feature-enabled library/test clippy passed with `-D warnings`; formatting is limited to the five new Rust files.
- Review fixes: heterogeneous Result comparisons in tests, the far-coordinate refusal expectation, stale cursor slice length, checked epoch/revision increments, and same-world/equal-epoch fork rejection.
- The cursor includes a 32-byte content fingerprint (XOR of domain-separated hashes of full entries). This is an accidental snapshot-mixing guard, not authentication, finality, or completeness. It is maintained in constant work per mutation and recomputed during restore, so page retrieval remains O(log n + limit). Identical restored content accepts its cursor; a different same-epoch fork is rejected.
- The private count helpers are not exposed to arbitrary external u128 inputs.
- No gameplay consumer is wired to this module yet. JS must carry wide coordinates as BigInt or canonical strings, and render relative to a local camera origin rather than silently round values above 2^53. The 50/56-byte keys cannot be passed unchanged as Solana seeds (32-byte individual seed limit).
- This experimental layout is not a finalized product protocol. No land-opening, cross-world travel, nation ownership or prize eligibility rule has been changed.

Default `cargo check` passed. `abi-vectors --check` reports stale `v2/layouts.json` and `v2/logs.json`; they were not regenerated. The generator, existing ABI layout/log modules, rules source and checked-in vectors have no diff from parent `30d60d27`. A separate baseline execution was not performed; this check is not reported as passed.

### Read-path supervisor validation (2026-11-07)

- Feature-enabled herald pure tests 5/5 and Fold/HTTP fixture integration tests 3/3 passed. Default-feature route test 1/1 passed (explicit 503). Feature-enabled library and new integration-test clippy passed. Public PDA calculation only; no keypair generation or signing.
- New JS tests 14/14 passed under the key-operation guard, including two minimal-DOM tests calling the actual screen mount. They are not browser/visual acceptance tests. Existing client/map/word tests 24/24 and language tests 24/24 passed after punctuation fixes.
- Review corrected a precision-test expectation, missing error code, manifest-in-flight reset race, stale screen-source/poll races, unpinned reads before the season loaded, and inaccessible rows past the first 48. Each loaded row is now reachable through list paging. Localnet/other cluster names are visible as source claims, not proofs. Sample/prototype sources are refused.
- No browser was opened or restarted, no production service was enabled, and no real-chain generation was tested. The screen is a read-only overlay in the actual game page; the ordinary action map is unchanged. A server must be explicitly built with `wide-world-experimental` and ingest a real archive/feed for real records to appear. A default/older server answers unavailable.
- Current Fold input is still legacy i16/ring-128. The wide-coordinate screen is ready for exact large coordinates, but no wider on-chain producer exists here. Land generation, gameplay traversal, ownership, prize eligibility, wide account layouts and migration remain separate work.
