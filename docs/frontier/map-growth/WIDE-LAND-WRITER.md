# Wide land writer: versioned identity, one inventory, and three closed gates

Status: experimental code, 2026-11-07, on `455f03af` (worktree `wylls-wide-game-integration-20261107`). Nothing here was compiled or run by its author; the native worker runs the commands in §6. No keypair, signature, network, browser, CI or deployment was used. This is a host-only preparatory implementation in the game program, not playable wide land. Most remaining work is engineering: connect existing game rules, readers and the complete asset lifecycle. Only changes to product rules require an owner decision.

## 1. What now works (through the real `dispatch`)

Behind the new program feature `wide-world-experimental` (default off; it enables `frontier-abi/world-index-experimental` and `permutation-rules/wide-terrain-experimental`; the build carries the provisional program-version bit `0x4000`, so its Seasons never mix with production Seasons, the way the NFT build uses `0x8000`):

| tag (provisional) | instruction | today |
|---|---|---|
| 0xD6 | WideRequestRingSeed(ring u64) | **writes** a `WideRingSeed` for ring `d ≥ 129`: the deployed OpenRing gates continued (the previous ring's seed seeded: the legacy RingSeed 128 for ring 129, the wide seed of `d − 1` after; a bell since it opened; θ on the folded Frontier; every wedge fund at `d × rent(wide province)`), `round = beacon::ring_seed_round(now)` (the kernel), paid by the payer as a legacy RingSeed is, no genesis path |
| 0xD7 | WideConsumeRingSeed(ring, round, sig48, hints) | **writes** the seed after the same `quick::verify` and `quick::seed_of` as the deployed ConsumeRingSeed; `WrongRound` before any signature; `AlreadyDone` once |
| 0xD8 | WideOpenProvince(P i64, Q i64) | validates (this build's Season; `WideCoord::checked` and ring ≥ 129; the ring's seed seeded, same world; the geometric wedge's fund; absence), then refuses **`NotImplemented`** at the readiness gate: `WideRules::UNDECIDED`. No fund lamport moves, no account is created |
| 0xD9 | WideClaimSite(P, Q, site, slot) | runs the deployed player authorization **read-only** (`player_prologue` steps 1–2: signers, Season at its PDA, Citizen at its wallet address, actor the wallet or its session), validates the wide province, the site and the one-inventory slot model on a scratch copy of the Citizen, then refuses **`NotImplemented`**: the claim rule is undecided. The Citizen is byte-identical afterwards (the bucket included) |
| 0xDA | WideDepart(host ref 56, slot, arrive_bell, tip, commit, seal) | the same authorization, the host reference canonical and of this world, the wide holding present and owned at the reference's generation, its province present, the seal's syntax, then refuses **`NotImplemented`**: `HOST_IDENTITY_UNALLOCATED`. No transit record, no escrow |

Host tests (`permutation-frontier/src/wide_land_runtime_tests.rs`, a child of the growth harness, `map_growth_runtime_tests::wide_land::`), all through the real dispatcher on literal accounts:

- `wide_land_ring_seed_is_requested_after_the_deployed_gates_and_bound_to_the_beacon_round`: every refusal (ring 128, a skipped ring, an unseeded previous ring, a production-version Season, θ unmet, a short fund, a duplicate), the record's fields, the round equal to the kernel's, the payer paying, no legacy account or fund moved, no record logged; the consume's wrong-round refusal and closed failure on the host; the chain to ring 130 and its bell rule.
- `wide_land_open_claim_and_depart_refuse_not_implemented_and_write_nothing`: the three gates with the deployed-order validations before them (BadData, SeedNotReady, BadAddress, BadAccount, Auth, TicketState, NotOwner) and before/after equality of the fund, payer, seed count, Citizen bytes and holding bytes.
- `wide_land_marked_slot_is_taken_for_the_deployed_writers_until_unbound`: with a Citizen slot bound to a wide holding, the deployed PlaceHome refuses `TicketState` through `dispatch`, `lowest_free_slot` skips the slot, `host_id` refuses the marker; after the unbind the same PlaceHome lands; three slots stay three.

Two **fixtures** in those tests are written by the test, not by the program: a wide province and a wide holding under *decided* rules (a model exercise so the claim and depart gates can be reached). No build can create them; the module doc says so.

## 2. The identity and transition models (`frontier-abi/src/world_index/`)

| module | content |
|---|---|
| `land.rs` | `WideRingSeed` (192 B, short header, provisional magic `PSFXWRS1`): world, `u64` ring, status, round, seed, count, payer; `request` (the deployed chain and bell rules as data, the kernel's round, no genesis path), `seed_with` (the round, once, nonzero). `WideProvince`: **the whole Province v2 layout (4,736 B, every v1/v2 offset identical) + a 128-byte trailer** (family version, status, readiness mask, world, canonical coordinate, seed round, ring seed, funded lamports); provisional magic `PSFXWPV1`, chained header with `layout_version 3`. The prefix `P`, `Q`, `RING` are **always zero**; the trailer is the only identity, so a wide province can never pass for legacy land, and every pure model the program runs over Province bytes (`clash_model`, `conquest_model`, `rest_model`, `encode_terrain`, `terrain_digest`, mirror and roster codecs) applies to it unchanged. `WideRules` carries the keep holder, Free City site, camp and region as `Decision`s; `open` refuses `NotReady { missing }` naming the undecided bits; `read` refuses any record whose readiness mask is incomplete, so a half-opened province cannot exist |
| `holding.rs` | the **one-inventory** rule. A wide holding takes slot 2 or 3 of the Citizen's deployed `holding[3]` by writing `WIDE_SLOT_MARKER = {P 0, Q 0, site 12, gen 0}`: impossible for a legacy holding on two counts (site ≥ 12, which `addr::host_id` refuses; gen 0, below every founded generation), and read as *taken* by every deployed writer (`gen ≠ 0xFF`: `lowest_free_slot`, `home_entitlement`, SettleTicket's empty-slot check), while every deployed reader that turns a ref into a host id or a Holding address refuses it (`host_id` → `None` → `BadAccount`). `bind`/`unbind` are one-field transitions with the ticket, reservation and count invariants; slot 1 (the first home, a heartland rule) is refused. `WideHolding`: **the whole Holding v2 layout (1,280 B) + a 64-byte trailer** (family version, status, slot, host identity version, world, coordinate), provisional magic `PSFXWHL1`; `read` refuses a record under `HOST_IDENTITY_UNALLOCATED` that shows any issued host, transit record or explore record (**no debit without a settle path**); `found` refuses `NotReady` while the claim rule is undecided |
| `march.rs` | `WideTransit` (256 B): the legacy transit fields over a `WideHostRef` and `ProvinceKey`, the legacy stage table (`Free → Departed → Settled | DestroyedAtOrigin → Gathered → Free`, each event once, same world, nothing else), and `depart` refusing `HostIdentityUnallocated` under version 0. It prices, times, resolves and settles nothing: the clash kernel, `host::march_values`, `travel::check_arrival_bell` and the seal stay the only rules |
| `wide_ix.rs` | the five instruction encodings (fixed width, `i64` coordinates, `u64` rings, 56-byte host refs), their account lists (the deployed shapes with wide positions), the band `0xD6..=0xDA` and the version bit, each pinned against every allocated and reserved number of `ABI-ALLOCATION-20261106.ja.md` rev 3 |

Pure tests in each module cover codecs, selected malformed byte forms, the slot model against the deployed free-slot rule, the readiness and identity gates, and the lifecycle table.

## 3. What still prevents opening, owning and marching past ring 128

These gates identify unfinished work. Their presence does not mean the full underlying game behavior is implemented.

| step | gate | the missing choice (owner) | the missing allocation (integrator) |
|---|---|---|---|
| open a wide province | `WideRules::UNDECIDED` → `NotImplemented` | the **nation that holds the keep** of a wide province: the owner confirmed mixing, not which mixing (`placement::mixed_home_nation` interleaves single provinces; `placement::orbit_balanced_outer_nation` gives each nation one copy of each terrain orbit; clustered patches would be a third rule); a **wide Free City rule**, a **wide camp rule** and a **wide region rule** (the deployed three hash `LE32(P) ‖ LE32(Q)`); who funds wide land (the geometric wedge fund, as drafted, or otherwise) and whether wide land counts in the legacy fund and Frontier counters, θ and Join capacity; prize eligibility | the magics `PSFXWRS1`, `PSFXWPV1`, the seed tags `wr`, `wp`, the layout version 3, the tags 0xD6–0xD8, the program-version bit; a Season field or ruleset input carrying the decided rules (today the handler has nothing to read them from) |
| claim a wide site | `Decision::Undecided` claim rule → `NotImplemented` | no new free-claim rule is authorized; port the existing capture/outpost entitlement, cost, escrow and shield rules. Only an intentional change to those rules needs an owner decision | the magic `PSFXWHL1`, the seed tag `wh`, the tag 0xD9; whether the marker ref needs a reader-side allocation note (the herald and verifier see a slot with site 12, gen 0) |
| march from or into wide land | `HOST_IDENTITY_UNALLOCATED` → `NotImplemented` | none beyond the above | the **wider host identity** (`UNBOUNDED-IDENTIFIERS.md` §3.2: a per-world alias slot inside the `u64`, a 128-bit `world ‖ id`, or a hash) and the ABI version that carries it through the roster entry, the transit, the ArrivalSlot, the ClashInputs row, the seal plaintext (`PLAIN_VERSION`, ruleset-bound) and the return target; then the wide forms of Reveal, GatherClash, Resolve and SettleTransit (the deployed ones refuse a wide destination by magic, which is correct today) |
| record anything for readers | no PS2 record is emitted | — | record kinds for the wide events (the free range after 144), entity kinds for the wide chains |

What is **not** blocked and was not built on purpose: a payer-funded terrain-only land account (refused as not the game), a side inventory of wide holdings (refused: it would be a fourth slot), a march that debits without a settle (refused by `WideHolding::read` and `WideTransit::depart`), a wide `OpenRing` on the legacy Frontier (the wide seed chain is self-contained so legacy readers never see a ring past 128), and any change to `R_MAX_HARD`, `host_id`, the deployed layouts, the verifier or the history checks.

## 4. Safety properties the tests pin

- **No alias.** Wide addresses use a separate domain from legacy Province, RingSeed and Holding addresses (the legacy grammar is untouched); tested samples do not alias, but this is not a proof against cryptographic collisions. No wide record passes a legacy presence check: different magic, different size, `layout_version 3`.
- **No relabel.** Prefix `P`, `Q`, `RING` of a wide province are zero and a nonzero value is refused (`LegacyIdentityInPrefix`); the dense index and `host_id` are never computed for a wide coordinate.
- **No genesis substitute.** A wide ring seed has one path: request (round fixed) → verified consume. A zero seed is refused as a seed; a requested record with a seed is refused as malformed.
- **One inventory.** A slot is spent in exactly one representation; the tested legacy slot allocator skips a wide-bound slot; complete legacy-reader and writer compatibility remains unproven; a wide binding counts in `holdings_n`; slot 1 stays legacy.
- **No partial debit.** A wide holding with any issued host, transit or explore under identity version 0 is unreadable; a wide departure is refused at the identity gate before any escrow.
- **Fail closed, write nothing.** Every refusing handler is compared before and after on the fund, payer, Citizen, holding and seed count.

## 5. Files

| file | change |
|---|---|
| `frontier-abi/src/world_index/land.rs` | new (ring seed, wide province, rules, readiness) |
| `frontier-abi/src/world_index/holding.rs` | new (slot marker, binding model, wide holding record) |
| `frontier-abi/src/world_index/march.rs` | new (wide transit record, lifecycle table, identity gate) |
| `frontier-abi/src/world_index/wide_ix.rs` | new (draft band, encodings, account lists, version bit) |
| `frontier-abi/src/world_index/mod.rs` | module registration, doc rows, re-exports |
| `permutation-frontier/Cargo.toml` | feature `wide-world-experimental` |
| `permutation-frontier/src/lib.rs` | `PROGRAM_VERSION` cfg matrix (the default and NFT-only values unchanged), the draft-band dispatch arm under the feature |
| `permutation-frontier/src/proc/mod.rs` | `pub mod wide` under the feature |
| `permutation-frontier/src/proc/wide.rs` | new (the five handlers) |
| `permutation-frontier/src/map_growth_runtime_tests.rs` | one feature-gated child-module declaration (the harness itself is unchanged) |
| `permutation-frontier/src/wide_land_runtime_tests.rs` | new (the three host tests) |
| this note; `INTEGRATION-20261107.md` | a pointer section |

Overlapping existing files: `lib.rs` (version constant and dispatch), `proc/mod.rs`, `map_growth_runtime_tests.rs`, `world_index/mod.rs`, `permutation-frontier/Cargo.toml`. No verifier, findex, herald, keeper, web, vector, preset, layout or kernel file was changed.

## 6. Suggested commands (executed subset recorded below)

```sh
# the identity, slot, march and wire models (pure)
cargo test --locked -p frontier-abi --features world-index-experimental world_index::land
cargo test --locked -p frontier-abi --features world-index-experimental world_index::holding
cargo test --locked -p frontier-abi --features world-index-experimental world_index::march
cargo test --locked -p frontier-abi --features world-index-experimental world_index::wide_ix
cargo test --locked -p frontier-abi --features world-index-experimental world_index
# the real-dispatch host tests (the harness is process-global: one thread)
cargo test --locked -p permutation-frontier --features wide-world-experimental --lib map_growth_runtime_tests:: -- --test-threads=1
# the default build is unchanged
cargo test --locked -p permutation-frontier --lib map_growth_runtime_tests:: -- --test-threads=1
cargo check --locked --offline -p permutation-frontier
cargo check --locked --offline -p frontier-abi --no-default-features --lib
cargo run --locked -p frontier-abi --bin abi-vectors -- --check
# lints and format on the touched files
cargo clippy --locked -p frontier-abi --features world-index-experimental --all-targets -- -D warnings
cargo clippy --locked -p permutation-frontier --features wide-world-experimental --all-targets -- -D warnings
rustfmt --edition 2021 --check frontier-abi/src/world_index/land.rs frontier-abi/src/world_index/holding.rs frontier-abi/src/world_index/march.rs frontier-abi/src/world_index/wide_ix.rs frontier-abi/src/world_index/mod.rs permutation-frontier/src/proc/wide.rs permutation-frontier/src/wide_land_runtime_tests.rs permutation-frontier/src/lib.rs
```

Key-path assessment: the new tests derive public with-seed addresses (`sha256`) and the Season PDA (`find_program_address`, in the shared harness) and set `is_signer` by hand; no keypair is generated or derived, nothing is signed, and the one BLS verification reachable (0xD7) is asserted to fail closed on the host. `abi-vectors --check` is expected to report the same stale `v2/layouts.json` and `v2/logs.json` as before this change (no vector or generator was touched); it is not an all-checks-pass claim. A build with both `nft-experimental` and `wide-world-experimental` has `PROGRAM_VERSION = 0xC004`; like the NFT build, a wide build cannot run `CreateSeason` (`SeasonParamsV2::validate` accepts only 3 and 4), so its Seasons are written by the harness; lifting that is part of the version allocation.

## Native review corrections

The SBF target now refuses `wide-world-experimental` at compile time. Merely saying a draft is non-deployable was insufficient. Host seed-request tests are not a deployed or signed transaction; the experimental Season itself is manually initialized.

Unknown host-identity versions now fail closed in holding records instead of bypassing the no-debit invariant. The standalone march comparison accepts only its explicit hypothetical version 1; no current wide holding accepts that version and no program departure is enabled. Different-world march records, overflowing departure times, different-season seeds, and corrupt slot-1/count unbinding are rejected. Fixed regression cases were added.

This does not complete NFT authorization for wide actions, an authenticated migration, capture/outpost execution, arrival/combat/return execution, accounting, or the game view of new records. No claim that every legacy reader is compatible should be inferred from the marker tests. Existing reads may need explicit wide-marker support before activation.

## Native validation result

Initial runs found two ABI test setup defects (a patterned HOST_SEQ violated the no-debit invariant; subtraction underflow on a three-account table), and one host-test helper that panicked before sending invalid coordinates to dispatch. These were corrected without weakening program checks.

After native review: the broad world_index suite passed 79/79, including the inventory-count consistency regression; the experimental map-growth dispatcher suite passed 9/9 (six legacy tests plus three new tests); both libraries passed clippy. Tests do not authenticate a real owner signature or verify a real beacon consume. Full SBF, deployment and browser checks were not run.

The default dispatcher regression also passed 6/6. The combined NFT plus wide feature passed a library compile check, not an NFT-wide authorization test. Final checks used offline locked dependencies and existing caches. The quoted clippy checks covered libraries, not all targets. No CI, main merge or deployment was performed.
