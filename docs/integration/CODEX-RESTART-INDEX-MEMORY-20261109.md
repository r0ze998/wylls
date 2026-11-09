# Bound captured-world restart copy memory

Base: `57c5cea2103fbd93e99851029a09dd797e9e694f`.

## Change and tradeoff

`Fold::with_state` previously cloned every captured account payload into a
vector before rebuilding derived indexes. Restart therefore temporarily held
another complete copy of the captured world's account bytes.

The rebuild now starts at the first ordered capture address and seeks strictly
after each processed address. It clones one account payload, indexes it and
explicitly drops that clone before seeking the next. The source map remains
fully present: wide replay still reads each capture's original slot. Sorted
address order, including the maximal address, is unchanged. Existing index
hooks were checked not to mutate `State.accounts`.

Temporary source-payload duplication is now O(largest payload), rather than
O(total payload). Source-map traversal changes from O(N) iteration to
O(N log N) seeks. This is a memory/lookup-work tradeoff, not a measured startup
speedup. Captured State, decoder allocations and persistent derived indexes
still consume memory proportional to their contents. No checkpoint format,
view schema, game rule or production gate changed.

## Verification

Independent review cleared the exact source and test runtime before execution:

- `fold.rs`: `54afaff30cdb70116238068f4d33b0da67a25e910848161ece04bab5b8c24413`.
- `rebuild_capture_tests.rs`: `a7d0e65250bbd44f55d5647ac5a1d1a6eee6a61e82e3b900a7fab3fbac0b8090`.

Tests compare the actual rebuild against the frozen prior bulk-copy traversal,
initialized with an empty Fold so the reference does not replay test records
through the new loop. They verify unchanged full State and encoded checkpoint
bytes, derived province/ring/region/wallet/Season data, actual player responses,
and wide stamp/epoch/refusal/manifest/page/inventory results. The legacy
province_latest comparison is absent-value parity; nonempty legacy view
coverage comes from me_json. Wide coverage includes nonempty pages and both
ambiguous and uniquely captured inventory slots.

Cases include empty and unrecognized records, truncated data, reversed insertion,
duplicate legacy province coordinates, all-zero and maximal addresses, wide
Province/Holding addresses in both relative orders, and a wrong-address wide
capture. A control replacing capture slots with the global last slot changes
the wide stamp, demonstrating sensitivity to preserving the original slots.

The test-only counters measure logical temporary source-payload bytes, not
allocator overhead, RSS, retained decoded objects or total process memory.
For 257 payloads of 1,024–1,026 bytes, the new measured high-water is **1,026
bytes**, with zero outstanding copied bytes after rebuilding. The old bulk
traversal retained all **263,424 payload bytes** at once. Every payload is still
processed exactly once; the test does not claim reduced total bytes processed.

New runtime paths are in-memory byte construction, slice writes, ordered-map
operations, decoding/serialization, public address derivation and public hashing.
Checkpoint encoding returns bytes without file IO. Out is inert. No fixture
generator, full Fold::apply, startup, output method, private-key generation or
derivation, signing, native proof, network or transaction is invoked.

Manifests, lockfiles, build scripts, default features and Cargo configuration
are unchanged from the prior native audits. Selected execution retained installed
Rust 1.95.0, offline/locked dependencies, two build jobs and the existing native
cache, with both fixture/export write variables unset.

From frontier-node:

```sh
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib fold::rebuild_capture_tests:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --lib fold::rebuild_capture_tests:: -- --test-threads=1
```

Both passed: **3 wide tests and 2 default tests**. The previously audited wide
configuration filters also passed: conquest::player_siege_index_tests:: (4),
conquest::tests:: (5), fold::player_host_index_tests:: (6), and wide:: (11).
Together this is **29 distinct test functions and 31 successful selected
executions**, not the entire workspace suite.

Formatting and git diff checks passed. No review metadata, guard, dependency,
production/SBF/debit/send boundary or pending live-observation UI changed.
No CI, deployment or actual transaction was run. This reduces one concrete
large-world restart cost; it does not provide disk-backed unbounded state or activate playable
radius-greater-than-128 gameplay.
