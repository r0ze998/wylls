# Local public march-order material reuse (2026-11-08)

**Status: written, declared, not yet compiled or run; not called.** One new
file, `permutation-frontier/examples/local_march_demo/order_material.rs`. The
only existing-file change is `mod order_material;` in `main.rs`, so the module
is built with the example and its tests can run. Nothing calls it; no march is
wired. The author executed no command, build, test, network, key
or signing operation.

## What it is

The module builds march-order material for **arrival bell 20 only**. It takes
a chosen host, destination province, destination tile and direction list. It
packs the deployed wide plaintext (`frontier_abi::world_index::seal::
WidePlain`), and rebuilds the 264-byte wide seal step for step as the original
exporter's `seal_of` closure does
(`permutation-frontier/src/wide_land_runtime_tests.rs:6243-6266`):

1. `pt = wseal::pack(plain)` after `wseal::validate(plain, host, 20)`.
2. `seal = wseal::assemble(PUBLIC_IBE_HEADER, wseal::body_xor(PUBLIC_K, pt))`.
3. `salt = salt_of(PUBLIC_K)`, the fixed public salt.
4. `commit = wseal::commit(pt, salt)`, `ct_hash = wseal::ct_hash(seal)`,
   `root = wseal::seal_root(commit, ct_hash)`.
5. Self-check: `open_body(PUBLIC_K, seal, commit) == pt` and `unpack(pt) ==
   plain`.

The reused bytes are all published fixture bytes:

| Constant | Bytes | Source |
|---|---|---|
| `PUBLIC_VECTOR_SEAL` | 165 | `permutation-rules/vectors/seal-vectors-v1.json`, case `valid_spv2_32551361`, `seal`, verbatim (the exporter reads the same case, `:6087-6095`) |
| `PUBLIC_IBE_HEADER` | 128 (`U ‖ V ‖ W`) | its first 128 bytes, the exporter's `ibe = legacy[..IBE_LEN]` (`:6094`); identical to `metadata.tsv` `seal[..128]` |
| `PUBLIC_K` | 16 | the same case's `k` (= `stock_k`) |
| `PUBLIC_SALT` | 32 | `salt_of(k)`: the case's `salt` and `metadata.tsv` `salt` |
| `PUBLIC_SIG_T` | 48 | quicknet round 32,551,361: vector `open_sig`, `frontier-node/crates/fclient/fixtures/quicknet/32551361.json`, `metadata.tsv` `sig_t` |
| `PUBLIC_SIG_S` | 48 | quicknet round 32,551,652: `fclient/fixtures/quicknet/32551652.json`, `metadata.tsv` `sig_s` |
| `T_ROUND`, `S_ROUND`, `ANCHOR_TS` | | the exporter's pins (`:6033-6083`) |

The hints are not embedded. `arrival_beacon` reads `hints_t` and `hints_s`
from `metadata.tsv`, length-checked. They are verification material only.

**Not done:**
- no keypair, key generation or key derivation;
- no signature;
- no key encapsulation: the IBE header is reused byte for byte, never
  computed;
- no network, no writes;
- no new secrecy claim.

**No secrecy.** `k` and the salt are public, so anyone can open every order
(`open_body(PUBLIC_K, ...)`; tested). This is local test material shaped like
a commitment, not a hidden order.

## API (`order_material`, pure)

```rust
pub struct Snapshot<'a> { pub key: [u8; 32], pub owner: [u8; 32], pub data: &'a [u8] }
pub struct OrderBinding { program, season_key, season_id, world, genesis_ts, citizen, host }
impl OrderBinding {
    pub fn new(program: &[u8; 32], season: Snapshot, citizen: Snapshot, holding: Snapshot,
               host: WideHostRef) -> Result<OrderBinding, OrderError>;
}
pub struct OrderRequest<'a> { dest: ProvinceKey, dest_tile: u8, directions: &'a [u8],
                              stance: u8, retreat_bps: u16, arrive_bell: u32 }
pub fn order_plain(b: &OrderBinding, r: &OrderRequest) -> Result<WidePlain, OrderError>;
pub fn build_order(b: &OrderBinding, r: &OrderRequest) -> Result<OrderMaterial, OrderError>;
pub fn replace_order(current: &mut OrderMaterial, b: &OrderBinding, r: &OrderRequest)
    -> Result<(), OrderError>;              // assigns only on success
impl OrderMaterial {
    pub fn depart(&self, transit_slot: u8, tip: u64) -> wide_ix::Depart;
    pub fn reveal_fields(&self) -> ([u8; 136], [u8; 32], [u8; 32]); // plain, salt, ct_hash
}
pub fn arrival_beacon(meta: &BTreeMap<String, String>) -> Result<ArrivalBeacon, OrderError>;
pub const ORDER_EVIDENCE_LABELS: [(&str, &str); 6];
```

`OrderMaterial` carries the host, destination, bell, plaintext, seal, salt,
commit, ct_hash and root.

### Binding (host, Citizen, Season, world)

`OrderBinding::new` checks the Season, Citizen and holding snapshots. These
are canonical-address and record-consistency checks over supplied snapshot
bytes. They do not authenticate the bytes.

- **Season.** Owned by `program`, with the Season magic. Its key equals
  `season_pda(id, bump, program)`. The world is
  `WorldId::derive_legacy_season(season, program)`. Its clock must give
  `T(20) = 32,551,361`, `S(20, A) = 32,551,652` and
  `A ≥ round_time(T(20))`. This ties the reused header to bell 20 *of this
  Season's genesis and drand clock*.
- **Citizen.** Owned by `program`, with the Citizen magic and this Season's
  id.
- **Holding.** Passes `WideHolding::read`, with this Season and world.
  `holding.key == holding_address(coord, site)`. Its coordinate, site and
  generation are the host's, and `owner_citizen` is the Citizen's key.
- **Host.** Its world is the Season's.

The plaintext itself commits only the host reference and the destination key,
which includes the world. The Citizen and Season are bound through the
holding and the world.

### Order refusals (before any output; inputs only borrowed)

These run in order, all in `order_plain`:

- `arrive_bell != 20` gives `UnsupportedArrivalBell`.
- An empty path gives `EmptyPath`. More than 32 steps gives
  `TooManyDirections`. A step ≥ 6 gives `BadDirection{index, dir}`.
- A destination in another world gives `DestinationWorld`. A destination in
  ring < 129 (legacy disk or Concord) gives `NotWideDestination`.
- Then the deployed `wseal::validate` gives `Plain(Tile | Stance | Retreat |
  ...)`.

`replace_order` leaves the caller's current material untouched on any
refusal.

## Limits

- **Bell 20 only.** The one published header is sealed to round 32,551,361,
  which is `T(20)` for this Season.
- **The route is not walked.** Terrain passability, the provinces entered,
  travel time (`check_arrival_bell`), shields and quota are judged only by
  the real WideReveal (`proc/wide.rs:4772-4980`, `walk_wide:4681-4734`).
  The module validates the plaintext's syntax, not the route.
- Stance and retreat are passed through within the deployed ranges. The
  recorded order uses 0 and 0 (`:6251-6252`).
- No secrecy, no authentication (above). The binding checks consistency of
  supplied bytes.
- Pure Rust over committed ABI functions. The native test relies on the
  `local-march-demo` build's real BLS math (`crypto/sys.rs:33-71`); other
  host builds are fail-closed there.

## UI labels (`ORDER_EVIDENCE_LABELS`)

- `PUBLIC_SEAL_MATERIAL_NO_SECRECY`
- `REUSED_PUBLIC_IBE_HEADER_T20`
- `PUBLIC_BEACON_SIGNATURES_T20_S20`
- `ARRIVAL_BELL_20_ONLY`
- `NO_KEY_NO_SIGNATURE_NO_ENCAPSULATION`
- `PLAINTEXT_VALIDATED_ROUTE_NOT_WALKED`

## Tests (in the module; status: **not run**)

They parse the committed `fixtures/accounts.tsv` and `metadata.tsv`,
`seal-vectors-v1.json` and the two fclient quicknet JSONs with `include_str!`.
They call no exporter or signing code.

| Test | Shows |
|---|---|
| `order_material_golden_reproduces_recorded_fixture_order_byte_for_byte` | from the fixture's host, Season, Citizen and holding and the recorded destination (129,−1), tile 34 and directions `020202`, the rebuilt `plain`, `seal`, `salt`, `commit`, `ct_hash`, `root` and host equal `metadata.tsv` byte for byte; `depart()` carries bell 20, commit and seal |
| `order_material_public_constants_match_published_vectors` | header, k, `stock_k`, salt, round and `open_sig` equal the vector file; signatures equal the fclient JSONs and the metadata; header equals the metadata seal prefix; labels present |
| `order_material_new_destination_reuses_header_and_changes_only_body` | an order to (129,−2), tile 10, `[2,2,2,3]` keeps the 128-byte header and the salt; body, plain, commit and root differ; it unpacks to the request and validates; the public k opens it; deterministic |
| `order_material_rejects_unsupported_arrival_bell_without_mutation` | bells 0, 19, 21, 22, 72 and `u32::MAX` refused; current material unchanged |
| `order_material_rejects_bad_or_excessive_directions_without_mutation` | empty, 33 steps, directions 6, 7 and 255 refused by index, unchanged; exactly 32 steps of every direction accepted and encoded |
| `order_material_rejects_bad_destination_shape_without_mutation` | another world, ring 128, the Concord, tile 61, stance 4 and retreat 60,001 refused, unchanged |
| `order_material_binding_rejects_mismatched_host_citizen_season` | another site, generation or province gives `HoldingMismatch`; another world `HostWorld`; another Citizen `OwnerMismatch`; a non-Citizen record `CitizenKind`; a moved Season key `SeasonAddress`; another program `SeasonKind`; a shifted genesis `RoundMismatch`; a non-canonical holding key `HoldingMismatch` |
| `order_material_arrival_beacon_pins_public_metadata` | the metadata beacon is accepted; a changed round, bell, anchor time, `sig_s`, a short hint or a missing `sig_t` is refused by name |
| `order_material_native_opener_recovers_public_k_and_judges_new_order_valid` | **native BLS:** `quick::verify` accepts `sig_t` at T(20) and `sig_s` at S(20, A) against the production quicknet key, and refuses `sig_t` at S; `crypto::seal::recover_key(sig_t, header)` returns the published k through the real pairing and FO check; `judge_wide` gives VALID with the plaintext for both the golden and the new-destination order; a flipped body byte gives `COMMIT_MISMATCH`; another host or bell gives `BAD_PLAINTEXT`. Verification only |

### What the supervisor should run

1. `mod order_material;` is already declared in
   `examples/local_march_demo/main.rs`; it changes no behaviour.
2. Build and run as in the existing protocol (Rust 1.89, offline/locked,
   feature `local-march-demo`, example `local_march_demo`, isolated target
   `.local/wide-march-demo/target`). Run each of the nine tests above by
   exact name with `--exact --test-threads=1`.
3. Run clippy on the example with `-D warnings`.

Expected compile-time guards: the `const fn hex` asserts every embedded hex
string's exact length, so a transcription error fails the build. The
constants test then checks every byte against the published files.

## Feasibility notes: a dynamic destination (no production change proposed)

These are what a later slice would need to march somewhere other than
(129,−1). Nothing here is implemented or proposed as a production change.

1. **Order material.** Already covered here for bell 20: any wide destination
   key, tile, 1–32 directions, same header, k and salt. The native opener
   test is written to check this end to end, but it has **not been run yet**.
2. **Beacon of the destination's region.** THE anchor and seed cache are
   keyed `(bell, region)`, but the rounds depend only on the bell and `A`
   (`world_index/seal.rs:59-69`). For region `r' = wide_region(dest)`, the
   real PostAnchor(20, r') with `sig_t`/`hints_t` at the same local
   `A = ANCHOR_TS`, and PostSeed(20, r') with `sig_s`/`hints_s`, should
   reuse `arrival_beacon` unchanged (the engine already parameterizes
   `region`, `engine.rs:483-568`). These accounts need absent images at
   their canonical addresses:
   - `bell_anchor(20, r')`;
   - `seed_cache(20, r', 0)`;
   - `anchor_archive(r', part(20))`;
   - `beacon_log(r')` (a fixture "nothing posted" log, as the exporter's
     `beacon_log`, `wide_land_runtime_tests.rs:1563-1578`, which would be a
     new labelled local record).

   Unverified: PostAnchor's evidence and `A` constraints for a second region
   at the same instant. This needs a run.
3. **Destination resolve history.**
   - Reveal needs `dest.resolved_next ≤ 20` (`proc/wide.rs:4905`). A province
     opened by `land_bootstrap` at bell 6 satisfies this.
   - The arrival resolve needs the destination resolved through 19. Every
     bell from its opening to 19 then needs a `(SeedCache, BellAnchor)` of
     region `r'`.
   - The repo has public quicknet signatures only for T(20), T(21) and
     S(20, A), so those bells would need **synthetic** pairs. That is a new
     labelled fixture kind, like the exporter's `stage_seed` with
     `BELL_SEED`, `:567-609`. Using it is a supervisor decision; it is not
     implemented here.
   - Doing those resolves at session start would need the clock past bell
     19, which conflicts with the one-clock design. Deferring them to the
     arrival phase, when the clock is at bell 21 or later, avoids moving the
     clock backwards.
4. **Path provinces.** `walk_wide` requires every province the route enters,
   present and supplied in order (`:4681-4734`). Routes that leave the opened
   set need `land_bootstrap::open_province` for each one, within its budget
   of 4.
5. **Per-destination clash records.** ClashInputs(dest', 20 to 23),
   ArrivalSlots(dest', 20, faction, 0..4), ArrivalDay(dest', day 0) and the
   destination roster need absent images at their canonical `arrival`/`roster`
   addresses. All are public with-seed arithmetic.
6. **Another arrival bell is out of scope.** A public signature for
   T(21) = 32,551,561 exists, but no published header is sealed to it.
   Making one would mean computing a new `V` by pairing. That is a new key
   encapsulation, which this module refuses by design.
