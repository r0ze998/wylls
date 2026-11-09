# Shared original-game conquest site transition

Date: 2026-11-09. Base: `6699d9052859973307b1d774b0fae64126cd91dc`.

## Player-facing gap and bounded change

A wide host can already exist, fight and return under the experimental host
runtime, but cannot besiege and acquire a Free City beyond radius 128.
Enabling only declaration would freeze its province: wide Resolve deliberately
rejects every active conquest record, and its bell step does not process siege
records. Merely deleting that refusal would leave capture, reservation rent,
source stake and season-end closure obligations unhandled.

This change extracts the existing siege/occupation site state machine and
connects the actual legacy `conquest_model::step` to it. It is not a separate
alternate game model. Its input contains rule fields and a mirror snapshot,
not a packed holding ID or an actor identity. The output describes record,
capture-mirror and event effects, with explicit retention/clearing of opaque
actor and source context. A future full-reference wide adapter can consume
the same rule transition without truncating a coordinate or source identity.

The legacy adapter continues to apply those effects to the existing Province
layout. The record codec and event wire do not change. Required siege bells,
vigil, failure, stake/slot obligations, capture credit, wall retention,
occupation tenure, liberation, respite, generation wrap and saturation rules
remain those of the existing game. Territory scoring, keep resolution and
hourly snapshots retain their ordering around the site loop.

The pure function is not a declaration authority check or a settlement API.
It consumes the rule inputs supplied by a validated caller. No wide conquest
record, new account, instruction, seed, rent regime or executable player
button is introduced here.

## Next complete wide gameplay slice

The smallest useful siege vertical slice is host-only Free City capture
inside one wide province with an already-mustered wide host. Before enabling
its declaration, the same branch must include:

1. A versioned full-source reference record, authenticated against the target
   province and included in Resolve commitments and account closure guards.
2. Reports from actual wide clash results, this shared site transition, and
   every bell of success/failure progression in the existing resolve order.
3. Slot-2/3 reservation and rent accounting for a wide Holding. Existing
   legacy Citizen escrow is sized for a 1,280-byte holding; wide holdings are
   1,344 bytes. The wide outpost ticket already keeps isolated escrow in its
   own retained record. These regimes cannot be silently mixed.
4. Capture settlement, source-generation-aware stake treatment, failed and
   end-of-season slot/escrow release, repeat-call behavior and replay.

Those are remaining storage and lifecycle contracts, not permission to alter
siege economics. Cross-family movement and first-home conquest remain outside
this slice. Wide outposts alone do not provide a first-home occupation path.

## Safety and verification

Independent pre-execution review followed the new tests and all helpers, and
reviewed the existing conquest and fixed-vector suites. Runtime paths contain
byte codecs, scalar game state, deterministic terrain/game RNG and public-data
SHA256 only. The new tests use high-u64 opaque context sentinels and compare
complete Province bytes with independently constructed expectations; they do
not compare two calls to the extracted helper. This covers failure/slot/stake,
capture-credit thresholds, Free City behavior, faction wall retention,
generation wrap, saturated counters, occupation paid/unpaid stake, respite,
expiry precedence, same-bell/error handling and site event order.

Compilation uses the unchanged locked build graph and source audit recorded
in `CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md`. The selected ABI package has
only permutation-rules as a local dependency; no local build script or runtime
constructor was added. Cargo may compile abi-vectors for integration targets,
but none of these tests executes it. The non-login environment had no compiler
or dynamic-library overrides. The existing native host target cache was reused
with two build jobs, without an explicit duplicate --target output tree.

Verified on Rust1.89.0, aarch64-apple-darwin, offline and locked:

- conquest_site_transition: 8 passed with default features disabled, and 8
  passed with world-index-experimental.
- cq_conquest_model: 14 passed in each configuration.
- cq_kernel_vectors: 6 passed in each configuration.
- Total: 28 distinct tests, 56 successful executions; zero failures.
- permutation-frontier library compile checks: default and
  wide-world-experimental both passed.
- Only the two changed Rust files were formatted; git diff --check passed.

The selected test command was `cargo +1.89.0 test --offline --locked -p
frontier-abi --no-default-features --test conquest_site_transition --test
cq_conquest_model --test cq_kernel_vectors -- --test-threads=1`, repeated with
`--features world-index-experimental`. Build commands were `cargo +1.89.0
check --offline --locked -p permutation-frontier --lib`, default and with
`--features wide-world-experimental`.

Reviewed and executed source SHA256:

- conquest_model.rs:
  `ef028d3eb246f5e23c64bc0629359c97094496a0f491b11c5463b698b68c55ed`.
- conquest_site_transition.rs:
  `8a63cc6ddf30c3e87773db245a5d7f43e39af0f867058fb9170bccfb67a2a6fd`.
- Root Cargo.lock remains
  `87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.

This is focused host verification, not exhaustive property testing, SBF
compilation, on-chain compute-unit/stack-budget measurement or deployment.
The new tests isolate the site phase; the existing suites cover its position
within full resolve/quiet processing, keep handling and snapshots.

The original pending 14-file village-observation/UI slice and its review
metadata are outside this worktree change. The wide ConquestRecord refusal,
SBF compile refusal, native-crypto-only departure debit, mixed-family refusal
and automatic-send gates remain intact. No private-key operation, real
transaction, fixture exporter, deployment or CI run is authorized by this
change. The original user-playable path remains radius 128; this is not
production wide conquest or a claim of an infinite playable world.
