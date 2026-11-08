# Local land bootstrap for the keyless march sandbox (2026-11-08)

**Status (2026-11-08):**
- **Module:** the supervisor built it and ran its 14 exact-name tests, all passed (golden re-open included).
- **Integration:** `Sandbox::new` (`engine.rs`) calls `install`, and protocol v3's `open_province` command calls `open_province` (`protocol.rs`; see `LOCAL-MARCH-DEMO-PROTOCOL-20261108.md`).
  - The supervisor's 73 exact-name example tests, which include the integration tests, all passed.
  - A raw host smoke (`get` → open (129,−2) → quote → `get`) was accepted by the browser model.
  - A Chrome localhost run opened (129,−2) at bell 6, quoted into it, and completed the economy-and-march loop. Reset then re-opening also worked.
  - The full JS suite awaits a rerun after one map-test correction.

The module is one new file, `permutation-frontier/examples/local_march_demo/land_bootstrap.rs`, plus `mod land_bootstrap;` in `main.rs`. Its authors executed no command, build, test, network, key or signing operation. Everything below about behaviour is what the source is written to do; only the module's own test runs above have been observed.

## Purpose

The local march sandbox (`examples/local_march_demo`) holds Season, holding
and two wide provinces, (129,0) and (129,−1), but none of the records a real
WideOpenProvince needs: the wide ring-129 seed, the Season's rules
configuration, the wedge funds. This module adds those as **explicit LOCAL
synthetic records** reconstructed from the exported public data and the
original harness's fixed literals, proves them against the existing provinces
with a golden re-opening, and then lets a controller open a small number of
additional ring-129 provinces with the **real handler at the current simulated
time**.

It makes no game decision. Every value is either read from exported bytes or
copied from the original harness's literals, and each is labelled.

## Non-goals (never done here)

- No WideRequestRingSeed, WideConsumeRingSeed or WideSetRules call, and no
  claim that one ran. The records are written through the ABI codecs, as the
  original harness's `seed_as_consume_would` and fixture helpers did.
- No key generation or derivation, no signature, no seal production, no
  march order. Public PDA / with-seed arithmetic only. The payer's signer flag
  is the runtime's local fixture flag.
- No network, no file writes at runtime (the fixtures are compiled in and
  only read), no exporter call, no production or rule change.
- No precomputed successful output: every new province is the handler's
  output at the caller-supplied `now`/`slot`.
- No ring other than 129.

## Records and their evidence

| Image name | Content | Source | UI label |
|---|---|---|---|
| `land_ring_seed_129` | `WideRingSeed{season 11, world, ring 129, Seeded, opened_bell 1, t_open = bell_start(1), round 32,547,581, seed [0x81;32], provinces_created 3, payer [0xd4;32]}`, 192 B, rent-exempt, program-owned, at `ring_seed_address(ctx, 129)` | seed and round: both exported province trailers (`land.rs` `RING_SEED`, `SEED_ROUND`), seed = `RING129_SEED` (`wide_land_runtime_tests.rs:125`); status as `seed_as_consume_would` (`:822-829`); opened_bell / t_open from `w.at(1, 0)` before `land()` (`:6116`, `:2334`); provinces_created 3 = origin, destination and the exporter's third province (`:6125-6135`, not exported); payer = `PAYER` | `LOCAL_SYNTHETIC_RING_SEED` (request fields source-inferred) |
| `land_rules_config` | `WideRulesConfig{v1, keep 1 MixedInterleaved, free city 2 CanonicalHashV1, camp 2 SortKeyDrawV1, region 1 SortKeyHashV1, authority}` at `rules_config_address(ctx)` | `RULES` (`wide_land_runtime_tests.rs:142-148`, "a test choice, not a product decision"); authority read from the exported Season (`S::AUTHORITY`, pinned `[0xaa;32]`) | `PROTOTYPE_CANDIDATE_RULES_V1` |
| `land_fund_0` … `land_fund_5` | ProvinceFund header, `WEDGE = w`, **all counters zero**, lamports `rent(128) + 4 × rent(4,864)` at `ctx.province_fund(w)` | none: the exporter's fund state was never exported | `LOCAL_FIXTURE_FUNDS` (no provenance) |
| `land_province_{p}_{q}` | the real handler's output | WideOpenProvince executed in-process | `REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME` |

The fund counters are **not** a reconstruction of the exporter's funds and
must not be presented as such. OpenProvince only increments them (checked
arithmetic) and needs the lamports to cover `rent(fund) + rent(province)`.

All addresses are recomputed from the Season key and `PROGRAM`
(`AddrCtx::of` with-seed); the Season key itself is checked against
`season_pda(id, bump, PROGRAM)`.

## Public API (`land_bootstrap`)

All operate on `BTreeMap<String, runtime::Image>` (`Images`) and the committed
`metadata.tsv` pairs (`Metadata`), and call only `runtime::dispatch`.

```rust
pub fn verify_initial_evidence(images: &Images, meta: &Metadata) -> Result<InitialEvidence, String>;
pub fn bootstrap_records(ev: &InitialEvidence) -> Result<Images, String>;
pub fn golden_gate(images: &Images, ev: &InitialEvidence, records: &Images) -> Result<GoldenReport, String>;
pub fn install(images: &mut Images, meta: &Metadata) -> Result<LandInstall, String>;
pub fn open_province(images: &mut Images, p: i64, q: i64, now: i64, slot: u64) -> Result<OpenedProvince, String>;
pub fn opened_provinces(images: &Images) -> Result<Vec<(String, WideProvince)>, String>;
pub fn season_context(images: &Images) -> Result<LandContext, String>;
pub fn ring_seed_record(ev: &InitialEvidence) -> WideRingSeed;
pub fn fund_lamports() -> u64;
pub fn fund_name(wedge: u8) -> String;
pub fn province_name(coord: WideCoord) -> String;
pub const EVIDENCE_LABELS: [(&str, &str); 8];
pub const GATED: [(&str, Range<usize>); 5];
pub const INFORMATIONAL: [(&str, Range<usize>); 7];
pub const MAX_EXTRA_PROVINCES: usize = 4;   // demo budget, not a rule
pub const MAX_TOTAL_IMAGES: usize = 96;     // the engine's fixture load bound
pub const PROVENANCE_OPENED: &str = "REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME";
```

`OpenedProvince` reports `name, p, q, key, wedge, region, opened_bell,
site_count, funded_lamports, provenance`. `GoldenReport` lists, per original
province, the gated ranges (all equal) and each informational range's
equality as a plain boolean, plus whether lamports happen to match.

## Audit call chain

**Install** (`install`):

1. Refuse if any `land_*` image exists (`LAND_ALREADY_INSTALLED`).
2. `verify_initial_evidence`, which reads only:
   - `season_context` checks that the Season is program-owned, has the
     Season magic, sits at `season_pda(id, bump, PROGRAM)`, has stored status
     Seeded/Running and the `0x4000` wide version bit, and derives
     `WorldId::derive_legacy_season(season, PROGRAM)`. The PDA equality is a
     canonical-address consistency check only; it does not authenticate the
     snapshot's bytes.
   - Pins: season id 11, authority `[0xaa;32]`, metadata `world`, `genesis`,
     `origin_p/q`, `destination_p/q`, payer `[0xd4;32]` system-owned with no
     data, system program id.
   - `original_province` (origin and destination) checks
     `WideProvince::read`, the canonical address and owner, coordinate,
     season, world, ring seed `[0x81;32]`, seed round 32,547,581, opened
     bell 1, wedge, region equal to the metadata *and* to `wide_region`, and
     funded lamports equal to `rent(4,864)`.
   - It recomputes `ring_seed_round(SeasonClock::beacon(), bell_start(1),
     seed_margin)`, which must give 32,547,581.
3. `bootstrap_records`: the ABI codecs (`WideRingSeed::write`,
   `WideRulesConfig::new/write`, `v2::layout::write_header`) at their
   canonical addresses.
4. Refuse key collisions and the image bound.
5. `golden_gate` (below), in a scratch map.
6. Commit: `images.extend(records)`. Nothing is written before this step.

**Open** (`open_province`):

1. Prechecks, before any dispatch:
   - `WideCoord::checked` (`LAND_COORD_BOUNDS`); ring 129 only
     (`LAND_NOT_RING_129`).
   - `season_context`, then `installed`: ring seed, config and six funds at
     canonical addresses with the right owner and size; config bytes =
     `RuleBytes{1,2,2,1}`, authority and world.
   - Ring seed `Seeded` (`LAND_RING_UNSEEDED`); time not before genesis.
   - Duplicate by name or address (`LAND_DUPLICATE_OPEN`).
   - Budget (`LAND_BUDGET`); image bound.
2. `stage_open` clones the whole map, adds the absent target (System-owned,
   0 lamports, no data) and calls `runtime::dispatch` with the deployed list
   `[payer s,w] [season r] [land_ring_seed_129 w] [land_fund_w w] [target w]
   [land_rules_config r] [system r]` and `allow_beacon_logs = false`. The
   runtime emulates only the handler's `AllocateWithSeed` signed by the Season
   PDA (`runtime.rs:299-334`). It faults on any `sol_log`, any non-PSW1 data
   log or any unexpected CPI, and checks lamport conservation, owners and
   read-only accounts before it commits into the **copy**.
3. `execute_open` requires zero receipts (`LAND_UNEXPECTED_RECEIPT`):
   OpenProvince logs nothing.
4. `judge_open` checks the whole staged map against the map before it:
   - Name set: exactly the target added, nothing removed (`LAND_NAME_SET`).
   - Every image other than the ring seed and that wedge's fund is
     byte-identical (`LAND_FOREIGN_WRITE:<name>`).
   - Ring seed: key, owner and lamports unchanged; record =
     `before.with_province_created()` (`LAND_RING_SEED_DELTA`).
   - Target: canonical address, `PROGRAM` owner, 4,864 B, lamports =
     `rent(4,864)` (`LAND_TARGET_SHAPE`). Identity: season, world,
     coordinate, wedge, `wide_region`, `opened_bell = resolved_next =
     score_next_bell = bell_at(now)`, ring seed and round from the record,
     `funded_lamports` = lamports, fresh chain (`LAND_TARGET_IDENTITY`).
     Terrain block equal to `generate_province_wide` + `encode_terrain`
     (`LAND_TARGET_TERRAIN`; same kernel as the handler, so a consistency
     check, not an independent one).
   - Fund: canonical address; lamports down by exactly the target's;
     data = before + `OPEN_SITES += site_count`, `PROVINCES_OPENED += 1`,
     `PROVINCES_FUNDED += 1`, `SPENT_TOTAL += lamports`, nothing else
     (`LAND_FUND_DELTA`).
   - Lamports conserved by key (`LAND_LAMPORTS`).
5. Commit: `*images = stage`. Any failure before this leaves `images`
   byte-identical, including funds and ring seed counters. Handler refusals
   come back as `LAND_OPEN_REFUSED:Refused_<code>`.

Duplicate commands and stale revisions are the future controller's concern;
this module refuses a duplicate by state only.

## The golden gate: what it proves and what it does not

`golden_gate` builds a scratch map from only the exported Season, payer,
system program and the proposed records. It re-opens (129,0), then (129,−1),
with the real handler at `bell_start(1)` and slot 1,001. That is the
exporter's `w.at(1, 0)`, and the same order. Each opening goes through the
same stage/judge path. The resulting bytes are compared with the exported
`origin` and `destination` images. The scratch map is discarded.

**Gated (must be equal):**

| Field | Range | Why it is immutable after opening |
|---|---|---|
| `header_identity` | 0..24 (magic, season id, layout version, reserved) | written by `write_identity` only; the event chain (24..64) is excluded |
| `prefix_identity` | `P..RESOLVED_NEXT` (P, Q, RING = 0, WEDGE, REGION) | `write_identity` only |
| `opened_bell` | `OPENED_BELL..RELATIONS` | `write_identity` only |
| `terrain` | `TERRAIN..ROAD_MASK` (terrain, resources, sites, site count, reserved byte, passable and rough masks) | `encode_terrain` is the only writer in the crate (grep of `PV::TERRAIN/RESOURCE/SITES/SITE_COUNT/PASSABLE_MASK/ROUGH_MASK`) |
| `trailer` | 4,736..4,864 (family, status, readiness, world, sort key, seed round, ring seed, funded lamports, reserved) | `write_identity` only |

**Informational (reported, never gating):** event chain, `RESOLVED_NEXT`,
road and explored masks (`EXPLORED_MASK` is written by Explore,
`proc/holding.rs:1016-1025`; the road mask has no writer in the crate but is
excluded conservatively), site mirror, camp, keep, `SCORE_NEXT_BELL`, and
lamports. The exporter resolved both provinces and staged residents after
opening, so these legitimately differ.

**It proves** that, with these reconstructed records and the exported Season,
the current handler and kernels reproduce the opening-time bytes of both
exported provinces:

- The current wide terrain kernel and encoder still give the exported
  terrain, resources and sites for both coordinates from `[0x81;32]`, with
  no drift since the fixture's commits 86b293e8 and 4b34fd67. This is the
  strongest non-circular part.
- The region candidate `SortKeyHashV1` gives the stored regions 8 and 6.
- World derivation, sort-key encoding, readiness bits and canonical
  addresses agree.
- Funded lamports equal the sandbox rent.
- The records are acceptable to the real handler's own checks: Seeded,
  world, season, canonical fund and config, rule bytes known.

**It does not prove:**

- **The keep-holder, Free City and camp candidates.** Their outputs live in
  the excluded keep, site mirror and camp ranges. Those three bytes of the
  configuration are pinned from source (`RULES`), not re-derived from data.
  The informational booleans may hint, but they are not evidence.
- **The ring seed's request fields** (opened bell, `t_open`,
  `provinces_created`, payer). No exported byte holds them. Only the round
  is recomputed, as a consistency check of `t_open`.
- **Anything about beacon provenance.** The seed is a literal, never a
  verified quicknet output. The trailer's seed and round flow from the
  record, so that part of the trailer comparison is circular.
- **The fund counters**, or any other state of the exporter's world (its
  third province, the legacy RingSeed 128, the Frontier).
- **That a new province is playable as a march destination.** It has no
  resolve history or staged beacon pairs.
- **Any SBF, chain or compute-budget behaviour.** The host emulation is not
  an independent verifier of every handler write; the judge covers the
  bytes it names.

## Error codes

Evidence:
`LAND_MISSING:<name>`, `LAND_EVIDENCE_SEASON_KIND`, `_SEASON_ADDRESS`,
`_SEASON_STATUS`, `_SEASON_VERSION`, `_SEASON_ID`, `_AUTHORITY`, `_WORLD`,
`_GENESIS`, `_META:<key>`, `_PAYER`, `_SYSTEM`, `_COORD`,
`_PROVINCE:<name>`, `_ADDRESS:<name>`, `_IDENTITY:<name>`,
`_RING_SEED:<name>`, `_SEED_ROUND:<name>`, `_OPENED_BELL:<name>`,
`_REGION:<name>`, `_FUNDED:<name>`, `_SEASON_CLOCK`, `_ROUND_RECOMPUTE`.

Install:
`LAND_ALREADY_INSTALLED`, `LAND_RECORD_RING_SEED|RULES|FUND`,
`LAND_RECORD_COLLISION`, `LAND_IMAGE_BOUND`, `LAND_GOLDEN_OPEN:<label>:<e>`,
`LAND_GOLDEN_MISMATCH:<label>:<field>`.

Open:
`LAND_COORD_BOUNDS`, `LAND_NOT_RING_129`, `LAND_RING_SEED_RECORD`,
`LAND_RULES_CONFIG`, `LAND_FUND_RECORD:<w>`, `LAND_RING_UNSEEDED`,
`LAND_TIME_BEFORE_GENESIS`, `LAND_DUPLICATE_OPEN`, `LAND_BUDGET`,
`LAND_OPEN_REFUSED:<runtime>`, `LAND_UNEXPECTED_RECEIPT`.

Judge:
`LAND_TARGET_PRESENT`, `LAND_NAME_SET`, `LAND_FOREIGN_WRITE:<name>`,
`LAND_RING_SEED_DELTA`, `LAND_TARGET_SHAPE`, `LAND_TARGET_IDENTITY`,
`LAND_TARGET_TERRAIN`, `LAND_FUND_DELTA`, `LAND_LAMPORTS`.

## Tests (in the module; status: **not run**)

The tests parse the committed `fixtures/accounts.tsv` and `metadata.tsv`
themselves. They never call the exporter or any signing code.

| Test | Shows |
|---|---|
| `land_bootstrap_golden_gate_reopens_both_original_provinces_at_bell1` | both originals re-open at bell 1 with every gated range equal; originals untouched; no `golden_*` image escapes; ring seed count stays 3; funds untouched |
| `land_bootstrap_golden_gate_ignores_gameplay_mutable_ranges` | flipping a byte in every informational range, and the lamports, does not gate |
| `land_bootstrap_golden_gate_refuses_tampered_terrain_without_mutation` | a flipped terrain, resource, site, site-count or mask byte gives `LAND_GOLDEN_MISMATCH:<label>:terrain`, map unchanged |
| `land_bootstrap_tampered_initial_evidence_is_refused_without_mutation` | authority, Season address, world, genesis, ring seed, seed round, province address, opened bell and region tampering are each refused by name, map unchanged |
| `land_bootstrap_install_adds_only_explicit_local_records` | exactly 8 records; exact ring seed, config and fund contents, addresses, owners and rents; labels present |
| `land_bootstrap_install_twice_is_refused_without_mutation` | second install refused |
| `land_bootstrap_another_ring129_province_opens_at_supplied_time` | (129,−2) opens at bell 6 and (128,1) at bell 21; seed, round, region, `resolved_next`, rent; count 3 → 4 → 5; fund down by rent; nothing else changed |
| `land_bootstrap_duplicate_open_is_refused_without_mutation` | a repeated or original coordinate is refused by the precheck; the handler alone also refuses `AlreadyDone` |
| `land_bootstrap_out_of_range_coordinates_are_refused_without_mutation` | rings 128, 130, 0 and an out-of-bounds coordinate refused; the handler alone gives `BadData` (ring 128) and `BadAddress` (ring 130) |
| `land_bootstrap_unseeded_ring_is_refused_without_mutation` | a Requested seed gives `LAND_RING_UNSEEDED`; the handler alone gives `SeedNotReady` |
| `land_bootstrap_insufficient_fund_is_refused_without_mutation` | one lamport short gives handler `Insufficient`, map unchanged; exactly enough opens and leaves the fund at its own rent |
| `land_bootstrap_budget_is_enforced_without_mutation` | four extra open; the fifth gives `LAND_BUDGET` |
| `land_bootstrap_judge_rejects_foreign_and_malformed_writes` | a real staged opening passes the judge; foreign Season and payer writes, ring seed delta, target owner, target terrain, fund reserve byte, added and removed names, and a different instant are each rejected |
| `land_bootstrap_noncanonical_or_tampered_records_are_refused` | a changed rule byte, a non-canonical fund key, a wrong ring and a missing config are refused, map unchanged |

## Integration notes for the supervisor

1. `mod land_bootstrap;` is declared in `examples/local_march_demo/main.rs`.
   Remove the module's `#![allow(dead_code)]` once a controller calls it.
2. Build and run, per the existing protocol (Rust 1.89, offline/locked,
   feature `local-march-demo`, example `local_march_demo`, isolated target
   `.local/wide-march-demo/target`). Select each test above by exact name with
   `--exact --test-threads=1`. Run clippy on the example with `-D warnings`.
3. The engine would call `install(&mut sandbox.images, &sandbox.meta)` after
   `Sandbox::new` (and again after Reset), and `open_province(..., now, slot)`
   with its own clock and `slot = 1000 + bell`. It should expose the
   `EVIDENCE_LABELS` beside any land shown. Added images raise the map from
   61 to at most 73; every runtime dispatch loads all of them (bound 128).
4. Existing handlers never list the new images, so their writable sets and
   judges are unaffected. The economy judge's "every other image
   byte-identical" still holds.
5. A new province is not yet a march destination. That needs staged beacon
   pairs and resolves up to the arrival bell, plus the public bell-20
   signature reuse, as in the earlier read-only finding. It is a separate
   slice.
