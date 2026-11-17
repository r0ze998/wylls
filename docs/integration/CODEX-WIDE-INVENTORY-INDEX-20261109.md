# Bound original-game wide inventory lookup

Base: `26fcfc3b1730113dd0286b31cc0e23e7db9d23b7`.

## User-facing change

The actual Herald `/h/me/{wallet}` response previously decoded every captured
wide Holding for each of the player's two wide inventory slots. It also
serialized all matching holdings before reporting an ambiguous slot. A growing
world therefore made the player's own village list progressively more costly.

`WideIndex` now keeps a derived owner-Citizen/inventory-slot address index and
its reverse membership. Captures update it only after the existing program,
season, world, format and public-address checks succeed. Rebinding first removes
the old owner/slot; closes remove membership and empty buckets. Checkpoint
restoration rebuilds the index from captured accounts, so no checkpoint format
or persistent schema changes.

The read seeks only the requested owner and slot. A second valid candidate
establishes ambiguity without serializing either; only a unique candidate is
serialized. Existing JSON shapes and `captured-unverified`, `not-captured` and
`ambiguous` statuses are preserved. This is an index of captured bytes, not
ownership authority, freshness, replay verification or permission to act.

The cost is additional O(N) index storage and logarithmic membership maintenance.
The bounded lookup depends on the existing capture lifecycle maintaining the
index. It does not authorize direct mutation of captured account storage.

## Audited verification

The exact final Rust source was reviewed independently before execution:

- `wide.rs`: `336eafb0b32d7e8b4500065bf3d0addf24683fef66ad1ba69ce461965c3eda14`.
- `wide_inventory_index.rs`: `d5424cac0df152127f0033d9ce9146544a4145a81483a116564b4421d9258c1b`.

The new six-test module uses literal account/transaction bytes, public PDA/hash
operations, in-memory captures and checkpoint encode/decode. Its `Out` values
are inert and no output method is called. It calls neither fixture generators,
Fold dispatch, startup, wallets nor signing. The existing five-test filter uses
only public namespace/stamp hashing, index/coordinate/cursor operations and
JSON/hex. No key generation, private derivation or signing is executed.

The native build review renewed the existing map/garrison/verify audits for this
checkout and selected feature. The selected graph contains 385 packages,
33 build scripts and 31 procedural-macro crates, with no external version or
feature delta from the prior reviewed Herald/verify graph. All 378 selected
cached registry archives match the lockfile; 11,365 regular source members match
the archives, with no extra source files or symlinks. Ancestor Cargo configuration
only selects output directories; reviewed native tools are the installed Apple
compiler/archive tools. This is source-path review, not formal certification of
the installed toolchain. Neither lockfile nor any dependency was changed.

Both commands ran from `frontier-node`, with installed Rust 1.95.0,
`--offline --locked`, `CARGO_BUILD_JOBS=2`, the existing native build cache,
`WS19_GOLDEN_WRITE` and `WYLLS_WIDE_ECONOMY_FIXTURES_DIR` unset:

```sh
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib wide::wide_inventory_index:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib wide::tests:: -- --test-threads=1
```

**11 selected tests passed (6 new, 5 existing).** The new assertions cover:

- Idempotent recapture, separate owner and slot transfer, close and empty-bucket cleanup.
- Wrong program owner, malformed bytes, wrong world/season/address replacements preserving the prior capture and membership.
- Adding 1,024 unrelated holdings without increasing the player's candidate reads or changing the response.
- 33 candidates for one slot needing only two reads and zero discarded serializations; removing duplicates restoring the unique result.
- In-memory checkpoint restoration and the existing read-only post-state envelope.
- Missing Citizen/index and non-wide bindings retaining their prior shapes.
- The real `views::me_json` caller with a canonical public Citizen address and two wide holdings: the complete response is unchanged by 1,024 unrelated holdings, and the wide lookup reads and serializes exactly two candidates.

Formatting and `git diff --check` passed. The unchanged Node classification
scanner ran in read-only `--check` mode and passed: 119 direct, 209 conservative
source-closure and 23 unfollowed exclusions, 17 reviewed entries. No Node test,
guard self-test, review metadata update, CI, deployment or transaction was run.

## Boundaries

This removes one concrete growth bottleneck in the original game's captured
inventory path. Mixed legacy inventory still uses the existing global
Province/ArrivalSlot scan in `views.rs`; the entire `/h/me` path is not claimed
to be world-size independent. No browser layout changed or new browser session
was run for this Rust-only change.

The experimental wide feature remains default-off, captured data remains
unverified, and all SBF, debit, keeper-send and mixed-family gates remain intact.
This is not a completed production wide-world gameplay path or a truly infinite
map. Separate live-observation work and its pending review metadata are excluded
from this branch.
