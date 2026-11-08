# Local destination preparation for a chosen-destination march (2026-11-08)

**v4 update (worktree `wylls-chosen-march-20261108`; validated in the supervisor's 91/91 run):**
- **Now called:** protocol v4 (`chosen_march.rs`) calls `prepare_destination` at a chosen march's `post_reveal`, and `arrival_plan` with `dispatch_sub_map` for every later arrival-phase instruction; see `LOCAL-CHOSEN-MARCH-20261108.md`.
- **Naming fix:** default names of planned accounts are now `march_dest_{p}_{q}_{role}` (`default_name`, `ACCOUNT_PREFIX`). The old `{province}_{role}` names (for example `land_province_129_-2_roster`) would, once persisted, have been read as opened provinces by the prefix-based engine and land code. The names in the guidance below are the old ones. Behaviour is otherwise unchanged; one test line uses `default_name`.

**Status: declared, not called.** One new file,
`permutation-frontier/examples/local_march_demo/destination_stage.rs`,
declared in `main.rs`. **Observed:** the supervisor compiled and ran all 73
exact example tests and all passed, including the first nine
`destination_stage` tests below. **Unrun:** the sub-map dispatch helper
(option (a), added after that run) and its five new tests are written but
not yet compiled or run. Nothing calls the module. The
author executed no command, build, test, network, key or signing operation.

## Problem

A march to a province opened by `land_bootstrap` (for example (129,−2),
opened at session bell 6 with `resolved_next = 6`) cannot reach the arrival
resolve of bell 20 until that province has been resolved for every bell from
6 through 19. Each of those resolves needs:

- THE anchor and a SeedCache of `(bell, region)`;
- the province's roster, ArrivalDay and ClashInputs positions, which are
  absent but must sit at canonical addresses.

The exporter did this for the original destination before export, by
resolving bells 1–19 at `w.at(21, 300)` and then rewinding the clock to bell
6 (`wide_land_runtime_tests.rs:6292-6303`). The sandbox has one clock and must
never rewind it. The bell-20 arrival material (PostAnchor/PostSeed over the
public signatures) is the engine's job with `order_material`.

## What the module does

### `prepare_destination(images, p, q, now, slot)`

1. **Target.** Exactly one image at `province_address(ctx, (p, q))`. It must
   be program-owned, pass `WideProvince::read`, belong to this Season and
   world, and have region `wide_region(coord)` (the configured candidate).
   Its name must start with `land_province_`, so only real
   `land_bootstrap` openings qualify. Other refusals: a cursor of 20
   (`DEST_STAGE_ALREADY_PREPARED`), a cursor not in 1..=19
   (`DEST_STAGE_CURSOR`), live entries (`DEST_STAGE_OCCUPIED`).
2. **Time.** The supplied `now` must lie in a bell after 20 and be at or
   after `reveal_close(19, A₁₉)`. With the fixture Season that is
   `bell_start(21) + 30`. The module never computes or moves a time; every
   dispatch uses the caller's `now`/`slot`.
3. **Plan every bell before any dispatch.** For each bell from the cursor
   through 19, five accounts (`plan_account`):
   - `{province}_roster`, `{province}_day` and `{province}_inputs_{bell}` at
     `roster_address`, `arrival_day_address(day_of(bell))` and
     `clash_inputs_address`. These are absent temporaries, or the existing
     image at that key (aliased and judged by the handler).
   - `{province}_cache_{bell}` and `{province}_anchor_{bell}` at
     `seed_cache(bell, r, 0)` and `bell_anchor(bell, r)`. These hold the
     **synthetic pair**, or an existing image at that key **only if
     byte-identical** to it (`DEST_STAGE_CONFLICT:<name>` otherwise).
   - A default name already used by another key is refused
     (`DEST_STAGE_NAME_CONFLICT`). Two images at one planned key are refused
     (`DEST_STAGE_ALIAS`). Nothing existing is ever overwritten or
     duplicated.
4. **Resolve, bell by bell, on one staged copy of the whole map.** For each
   bell:
   - `stage_temporaries` adds that bell's temporaries. The staged map is
     never above 96.
   - The real WideResolve runs over
     `[payer s,w] [season r] [province w] [roster w] [cache r] [anchor r]
     [inputs r] [day r] [system r]`, the harness's `resolve_full_as`
     (`:1779-1800`), with beneficiary `[0xd4;32]` as the engine uses.
   - `judge_resolve` requires:
     - the same names;
     - every image but the province byte-identical: temporaries, payer,
       Season, holding, Citizen, origin, rosters, rules config, ring seed
       and funds;
     - the province's key, owner, lamports and size unchanged, and every
       `land_bootstrap::GATED` range unchanged (header identity, prefix
       identity, opened bell, terrain, trailer);
     - the cursor going from `bell` to `bell + 1`;
     - **exactly one** `PSW1` receipt, of kind Resolve, for this bell and
       keyed by this province;
     - the province chain advanced by exactly that receipt
       (`event::verify_chain`);
     - lamports conserved.
   - `drop_unchanged_temporaries` removes the temporaries. Any changed
     temporary fails (`DEST_STAGE_TEMPORARY_WRITE`).
5. **Whole-sequence check, then commit.**
   - Same names as the input map; only the province changed.
   - `resolved_next = 20`.
   - The chain from the original province to the final one equals all the
     receipts in order.
   - Then `*images = staged`.
   - Any refusal at any bell, or any failed judgement, returns before the
     commit, so `images` is byte-identical.
6. **Report.** `PreparedDestination` with the bell range, cursor,
   `score_next_bell`, time, the receipts (one per bell, for the engine's
   record log) and one `PairEvidence` per bell: rounds, `A`, keys, and
   whether the pair was aliased.

### Synthetic non-arrival pairs: provenance

`synthetic_pair(ctx, season_id, clock, bell, region)` is the exporter's
`stage_seed(bell, region, BELL_SEED)` under the T model, byte for byte
(`wide_land_runtime_tests.rs:428-446`, `:567-609`):

- **anchor:** `ROUND = T(bell)`, `A = round_time(T) + 30`, `SLOT = 1`, no
  `SIG48`, no network;
- **cache:** nonce 0, `ROUND = S(bell, A)`, `SEED = [0x5a;32]`, the anchor's
  key, `A`;
- both program-owned, with the fixture balance `10,000,000,000`.

The handler accepts them because `holding::bell_seed` checks key, bell,
region, anchor key, `A` and `ROUND = seed_round(bell, A)`
(`proc/holding.rs:1064-1117`), and `clash::window_closed` checks
`now ≥ reveal_close(bell, A)` (`proc/clash.rs:380-395`). **No signature is
claimed or made.** The pairs are temporary: never retained, and rebuildable
deterministically from the Season clock. The golden test shows the builder
reproduces the exported fixture pairs (`destination_*_21..23`,
`origin_*_5..6`) byte for byte.

### `arrival_plan(images, p, q)`: the engine's later phase

This is read-only. For any canonical wide province it returns 40 planned
accounts, each with a role, a name (an existing alias when an image already
has the key) and, if missing, the image to stage:

| Bell | Accounts |
|---|---|
| 20 | THE anchor and nonce-0 cache: absent until the real PostAnchor/PostSeed, which reuse `order_material::arrival_beacon` |
| 20 | the archive (absent) and the region's beacon log (`beacon_log_fixture`, the exporter's `beacon_log(region)`, `:1563-1578`, when none exists) |
| 20 | ClashInputs, ArrivalDay, roster and the 24 ArrivalSlots, all absent |
| 21, 22, 23 | ClashInputs (absent) and the synthetic pair |

For the fixture destination (129,−1), every planned account resolves to the
exported image, with the exported names (tested). That pins every address
derivation.

### Generic staging helpers

- `stage_temporaries(images, planned)`: adds the planned temporaries to a
  copy. It refuses a name or key that already exists, and a map above
  `MAX_TOTAL_IMAGES` (96).
- `drop_unchanged_temporaries(stage, planned)`: removes temporaries still
  exactly as staged, and returns the names an instruction changed. Those are
  now real state the caller must judge and keep.

## Account budget decision

**Decision: bounded temporary staging. The 96 bound is not changed or
weakened**, either for the committed map or for any staged map this module
builds.

- **Committed map.** 61 (fixture) + 8 (land records) + up to 4 provinces
  gives at most 73. `prepare_destination` adds **zero** persistent images.
- **Per resolve dispatch.** The map plus at most 5 temporaries gives at most
  78, which is ≤ 96 and within the runtime's 128 (`runtime.rs:17`).
  Retaining all 14 pairs plus inputs plus roster and day would add
  14 × 3 + 2 = 44 (73 + 44 = 117 > 96). This design never retains them.

**Engine arrival phase (reported, not implemented).** For a fresh
destination, only the accounts an instruction *creates* become persistent:

- THE anchor and cache of bell 20 (PostAnchor, PostSeed);
- the ArrivalDay and one ArrivalSlot (Reveal);
- the ClashInputs of bell 20 (Gather);
- the roster, if survivors stay (arrival Resolve).

That is about 6 images, giving at most 73 + 6 = 79 committed, which fits.
Each instruction needs these temporaries:

- **Reveal:** 4 faction slots, inputs, day, archive and, for a region
  without a fixture log, a beacon log; about 8 temporaries, ≈ 82, which
  fits.
- **Resolves of bells 21–23:** 5 temporaries each, as here; fits.
- **Gather lists all 24 slots.** For a fresh destination, 23 are still
  absent, plus the bell-20 inputs: 24 temporaries over a map of 74 or more
  is about 98–101, **above 96**. It cannot run on the whole map under the
  current bound, even with temporary staging (the test
  `..._temporaries_are_bounded...` shows the full arrival plan does not
  fit).

Two options were considered:

- **(a) Recommended, no bound change: now implemented as
  `dispatch_sub_map` (below, unrun).** Dispatch Gather, and optionally every
  arrival instruction, over a **sub-map** holding only the listed accounts
  plus permitted temporaries. Merge back the changed images and judge them.
  The runtime needs only the listed accounts; its `holding` transfer
  special case reads the `"holding"` name, which the helper adds exactly
  when an image at the holding's key is listed.
- **(b) An explicit demo transport bound for transient dispatch maps**, for
  example the runtime's own 128, kept separate from the 96 persistent-map
  bound. Not implemented; not needed with (a).

## Sub-map dispatch (option (a)) — unrun

```rust
pub const RUNTIME_MAX_IMAGES: usize = 128; // restated from runtime.rs:17, not changed
pub const RUNTIME_MAX_METAS: usize = 96;   // restated from runtime.rs:18, not changed
pub struct SubMapCall<'a> { metas: &'a [Meta], instruction: &'a [u8], now: i64, slot: u64,
                            allow_beacon_logs: bool }
pub struct SubMapDispatch { receipts, sub_map_len, changed, created, dropped }
pub fn dispatch_sub_map<J>(images: &mut Images, permitted: &[PlannedAccount],
                           call: &SubMapCall, judge: J) -> Result<SubMapDispatch, String>
where J: FnOnce(&Images /*before*/, &Images /*after*/, &[Vec<u8>] /*receipts*/)
              -> Result<(), String>;
```

**Inputs.** Everything comes from the trusted engine: the metas, the
instruction, the time, the slot and the beacon flag. `permitted` is the
explicit set of planned accounts, usually a subset of `arrival_plan`. Nothing
else is read from the caller.

**Steps:**

1. **Bounds on entry.** The persistent map must be at most 96 images, and the
   metas between 1 and 96.
2. **Plan check.** Each temporary must carry an image at its own key. Its
   name and key must exist neither in the map nor in another temporary
   (`SUBMAP_PLANNED:<name>`). An alias, with no temporary, must name an
   existing image at its key (`SUBMAP_PLANNED_ALIAS:<name>`).
3. **Sub-map.** Exactly the names the metas list: existing images or
   permitted temporaries (`SUBMAP_UNKNOWN_META:<name>`). Every temporary must
   be listed (`SUBMAP_UNUSED_PLANNED:<name>`). `"holding"` is added when an
   image at its key is listed. The sub-map must be at most 128 images.
4. **Dispatch.** `runtime::dispatch` on a copy of the sub-map
   (`SUBMAP_REFUSED:<runtime>` on any runtime or handler refusal).
5. **Runtime consistency.** Same names and keys, aliases identical,
   lamports conserved over the sub-map (`SUBMAP_RUNTIME_*`,
   `SUBMAP_LAMPORTS`).
6. **Merge into a staged copy of the whole map.**
   - A changed existing image updates **every** persistent name at its key,
     including unlisted aliases.
   - A changed temporary becomes persistent (`created`).
   - An unchanged temporary is dropped (`dropped`).
   - Every unlisted image is carried over untouched, and no key is
     duplicated.
7. **Persistent bound** after the merge: at most 96
   (`SUBMAP_PERSISTENT_BOUND:<n>>96`).
8. **Caller's judge**, over the whole map before and after plus the
   receipts: this is where receipt kinds, chains and allowed writes are
   checked.
9. **Commit.** Any failure in steps 1–8 leaves the map byte-identical.

**The bell-20 anchor in the tests.** A no-arrival Gather needs THE anchor of
`(20, region)` present, with its reveal window closed
(`proc/wide.rs:4511-4520`). In the engine that anchor comes from the real
PostAnchor over the public `sig_t` (`order_material`). The isolated tests
instead stage the T-model `synthetic_pair(20, region)` anchor and cache as
**explicit local fixtures**: no march arrives at that bell, no signature is
made or claimed, and they are dropped after use. The Gather tests' window
therefore closes at `bell_start(22) + 30`, and they run at
`bell_start(22) + 300`, the engine's resolve_arrival instant.

## Integration guidance (for after the engine work)

1. `mod destination_stage;` is declared in
   `examples/local_march_demo/main.rs`. Remove `#![allow(dead_code)]` once it
   is called.
2. **When.** Call
   `destination_stage::prepare_destination(&mut images, p, q, now, slot)`
   once the chosen destination is known and the clock has reached at least
   `bell_start(21) + 30`. With the current engine timings that is the start
   of `post_reveal` (`GENESIS + 21×600 + 213`, slot 1,021), before the
   PostAnchor. It must run before Gather and the bell-20 Resolve; Reveal
   accepts both cursors 6 and 20 (`proc/wide.rs:4905`). Stage the call on
   the engine's own copy, as it does for other commands, append the returned
   `receipts` to its record log, and commit only if the command succeeds.
3. **Names.** Use the `PlannedAccount.name`s from `arrival_plan`, not
   formatted names. For (129,−1) they are the existing fixture names. For a
   new province with no alias they are `{province}_{role}`, e.g.
   `land_province_129_-2_inputs_20`, `land_province_129_-2_slot_2_0`,
   `land_province_129_-2_cache_21`. Region-keyed pairs, logs and archives
   alias across provinces of the same region automatically.
4. Run each arrival-phase instruction through `dispatch_sub_map`, with the
   permitted subset of `arrival_plan` it lists and its receipt and
   allowed-write checks in `judge`. Only what an instruction created is
   kept. Gather in particular needs this, since its 24 slots do not fit a
   whole-map staging under 96.
5. Route provinces are unchanged by this module. The route walked by Reveal
   must enter only provinces present in the map.
6. Show `DESTINATION_EVIDENCE_LABELS` beside a prepared destination:
   `SYNTHETIC_NON_ARRIVAL_BEACON_PAIRS`, `REAL_WIDE_RESOLVE_AT_SUPPLIED_TIME`,
   `CLOCK_NOT_MOVED`, `LOCAL_FIXTURE_BEACON_LOG`,
   `NO_KEY_NO_SIGNATURE_NO_NEW_CRYPTO`.

## Error codes

- **Target:** `DEST_STAGE_COORD`, `DEST_STAGE_TARGET_MISSING`,
  `DEST_STAGE_TARGET_ALIAS`, `DEST_STAGE_TARGET`,
  `DEST_STAGE_ALREADY_PREPARED`, `DEST_STAGE_CURSOR`, `DEST_STAGE_OCCUPIED`.
- **Time and clock:** `DEST_STAGE_CLOCK`, `DEST_STAGE_TOO_EARLY`,
  `DEST_STAGE_TIME`.
- **Planning and staging:** `DEST_STAGE_CONFLICT:<name>`,
  `DEST_STAGE_NAME_CONFLICT:<name>`, `DEST_STAGE_ALIAS:<role>`,
  `DEST_STAGE_TEMPORARY_CONFLICT:<name>`,
  `DEST_STAGE_ACCOUNT_BOUND:<n>>96`, `DEST_STAGE_PAIR_ENCODE`,
  `DEST_STAGE_LOG_ENCODE`.
- **Dispatch and judge:** `DEST_STAGE_REFUSED:<bell>:<runtime>`,
  `DEST_STAGE_NAME_SET`, `DEST_STAGE_FOREIGN_WRITE:<name>`,
  `DEST_STAGE_PROVINCE_SHAPE`, `DEST_STAGE_IDENTITY:<field>`,
  `DEST_STAGE_RECEIPTS`, `DEST_STAGE_CHAIN`, `DEST_STAGE_LAMPORTS`,
  `DEST_STAGE_TEMPORARY_WRITE`.

## Tests (in the module)

The first nine are **observed passing** (supervisor run of all 73 exact
example tests). The five sub-map tests after them are **unrun**.

Setup: the committed fixtures are parsed in the test (no engine, exporter or
signing code), then `land_bootstrap::install`, then
`land_bootstrap::open_province(129, −2)` at bell 6.

| Test | Shows |
|---|---|
| `destination_stage_synthetic_pairs_match_exported_fixture_pairs_byte_for_byte` | the builder reproduces `destination_cache/anchor_21..23` (region 6) and `origin_cache/anchor_5..6` (region 8) with key, owner, lamports and data, and the T-model rounds; the beacon-log fixture equals `beacon_log` |
| `destination_stage_arrival_plan_aliases_every_existing_fixture_account` | for (129,−1), all 40 planned accounts resolve to the exported images under their exported names, at their keys |
| `destination_stage_prepares_opened_province_through_bell19_at_bell21` | 14 real resolves (bells 6–19) at bell 21 + 213 s; each receipt is Resolve for its bell; cursor 20, score bell 20 (the exporter's pin, `:6301-6302`), summary bell 19; no image added; only the province changed (source, economy, records, funds, rosters unchanged); gated ranges unchanged; a second call gives `ALREADY_PREPARED`, unchanged |
| `destination_stage_is_deterministic` | two runs give identical reports and maps |
| `destination_stage_refuses_early_time_without_mutation` | the earliest time is `bell_start(21) + 30`; bell 6, the end of bell 20, the start of bell 21 and one second early are refused, unchanged; exactly the close is accepted by the real handler |
| `destination_stage_refuses_invalid_targets_without_mutation` | the original destination and origin (not bootstrap), unopened (129,−3) and (128,1), and an out-of-bounds coordinate are refused, unchanged |
| `destination_stage_rolls_back_a_mid_sequence_handler_refusal` | a program-owned record at bell 12's ClashInputs key: bells 6–11 resolve on the copy, the real handler refuses bell 12 (`DEST_STAGE_REFUSED:12:`), the map is byte-identical and the cursor still 6 |
| `destination_stage_refuses_conflicting_existing_records_without_mutation` | a different record at a synthetic pair's key, and a planned name owned by another key, are refused, unchanged |
| `destination_stage_temporaries_are_bounded_and_dropped_only_when_unchanged` | the full arrival plan (40, unique names) cannot be staged under 96 (`ACCOUNT_BOUND`); five fit; only a changed temporary is retained; a temporary never replaces an existing name |

Sub-map tests (unrun). Their setup picks the first of (129,−2), (129,−3),
(128,1), (127,2) whose region differs from the fixture destination's, so no
fixture image aliases its bell-20 anchor. It opens that province at bell 6
and prepares it at bell 21.

| Test | Shows |
|---|---|
| `destination_stage_sub_map_real_gather_and_resolve_on_prepared_empty_destination` | the full 40-account plan does not fit (`DEST_STAGE_ACCOUNT_BOUND`). A **real Gather** of bell 20 over a sub-map (anchor fixture, absent inputs, day and 24 slots; 32 images from 56 metas) succeeds: one Gathered receipt keyed by the province; `created` = the ClashInputs (program-owned, rent-exempt, all positions gathered, `FLAG_NO_ARRIVALS`, none present); `changed` = payer only (debited exactly the rent); 26 temporaries dropped; persistent map +1; every other image unchanged. Then a **real bell-20 Resolve** over a sub-map (synthetic cache and anchor, absent roster and day, the created inputs aliased): `changed` = the province and the inputs; cursor 21; `FLAG_RESOLVED`; the judge verifies the province chain; holding, Citizen, origin, origin roster and original destination unchanged |
| `destination_stage_sub_map_enforces_bounds_without_mutation` | at exactly 96 images the Gather's created record would make 97, so it is refused after the dispatch and before the commit; 97 on entry is refused; 97 metas are refused; map unchanged |
| `destination_stage_sub_map_refuses_unknown_metas_and_malformed_plans_without_mutation` | an alias at a wrong key, a temporary on an existing name, on an existing key or at a key other than its own, a duplicated temporary, an unknown meta and an unlisted temporary are each refused by name; map unchanged |
| `destination_stage_sub_map_handler_or_judge_failure_preserves_whole_map` | the real Gather refused one second before bell 20's window closes (`SUBMAP_REFUSED:`), and a successful dispatch whose judge refuses, both leave the map byte-identical |
| `destination_stage_sub_map_keeps_unlisted_aliases_consistent_and_unrelated_images` | an unlisted alias of the payer is updated with it, so both stay identical; every other image unchanged; the same call on the same map is deterministic |

**For the supervisor to run:** (the module is already declared) build offline/locked
with feature `local-march-demo`, example `local_march_demo`, isolated target
`.local/wide-march-demo/target`; run each test above with
`--exact --test-threads=1`; run clippy on the example with `-D warnings`.

## Limits and what is not claimed

- Only provinces opened by `land_bootstrap`, with no live entries, from
  cursor ≥ 1 through 19. Bell 20 and later belong to the engine.
- The synthetic pairs carry a literal seed. The resolves are real handler
  outputs over that seed, so their camp, keep and score evolution is
  deterministic local test history, not beacon-derived.
- Only the existing configured candidate rules are used (the province's
  stored region is checked against `wide_region`; the resolve uses whatever
  the handler reads). No rule or record type is added.
- Uncertain until a run:
  - that the wide resolve of an empty province never writes outside the
    province (the judge fails closed if it does);
  - that the score cursor reaches 20 as it did for the exporter's
    destination (the test asserts it; the module reports it without gating
    on it).
