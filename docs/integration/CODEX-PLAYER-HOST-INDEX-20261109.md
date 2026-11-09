# Index original-game player hosts and arrival slots

Base: `ba89830916b1fe945c49d1768c6d19bec3631239`.

## Actual read-path change

The original `/h/me/{wallet}` view no longer scans every captured account and
decodes every legacy Province to find a player's hosts and ArrivalSlots.
A derived `PlayerHostIndex` stores active host rows by holding key and arrival
addresses by Citizen tag. A reverse membership map removes old rows on capture
replacement, including malformed or different-kind replacements, and closes.
`Fold::with_state` rebuilds the index from saved captures without changing the
checkpoint format. The new private `capture_wide_post` wrapper reconciles the
index with the surviving capture after the existing wide interception, so a
refused wide replacement preserves the legacy rows and a successful one removes
them. It does not change wide acceptance or introduce a new transaction path.

The view merges matching rows by capture address and entry ordinal, preserving
the former full scan's ordering. Repeated holding references do not duplicate
hosts, while distinct duplicate host entries remain distinct. Existing repeated
seal/transit behavior, inactive-entry filtering, permissive ArrivalSlot tag
parsing (including tag zero and a 48-byte record), and the nonempty-holding-key
gate are unchanged. The Citizen/Holding owner/generation decisions are not
moved or changed. JSON shapes and raw capture envelopes are unchanged.

This trades extra storage proportional to indexed active rows and arrival
records, plus work when captures change, for output-sensitive lookup. It is
not a new ownership or freshness attestation. Directly editing Province or
ArrivalSlot bytes in `State.accounts` bypasses the derived index; production
capture lifecycle hooks or `with_state` must maintain it.

## Source review and verification

Independent review cleared the exact runtime paths before test execution:

- `fold.rs`: `953d40688428a7ffdc5ae894fca0fcd1ccfeea83ce1687c491b45f18b94d1d1a`.
- `views.rs`: `336479b7a814664c6f62ee3ce091a2a9943c10f55167f40b52d8c147b2f28f78`.
- `player_host_index.rs`: `8182bc2fe737a6fd94df37bc4052721fdab4ac304c5fd576afe5b4f2d3d72f1c`.
- `player_host_index_tests.rs`: `b7d753e70a48cae0f344ec8b4265169d94ce80eb890b6962525d40354bf4dc04`.

The tests build literal public account bytes, call the private capture/index
hooks and actual `views::me_json`, and compare its entire response with a frozen
copy of the prior implementation. A separate source comparison confirms that
oracle exactly matches the base function after only the documented function
rename and identical public `account_json` wrapper substitution. Restart tests
clone `State` and rebuild it in memory; they do not claim checkpoint-file IO.
The wide test calls the same narrow interception wrapper now used by `apply`,
not full `Fold::apply` or program dispatch. `Out::new` is inert, conquest
additions return immediately with `cq.on=false`, and no fixture generator,
startup, network, output write, private derivation, key generation or signing
is reachable in these selected tests.

The native build audit is unchanged from
[CODEX-WIDE-INVENTORY-INDEX-20261109.md](CODEX-WIDE-INVENTORY-INDEX-20261109.md).
Manifests, both lockfiles, Cargo configuration and build scripts were checked
again. The wide feature enables only the existing empty ABI feature; omitting
it for the default configuration adds no external dependency, feature or
compile-time execution path. Installed Rust 1.95.0, offline/locked dependency
resolution, two build jobs and the existing native cache were used, with
`WS19_GOLDEN_WRITE` and `WYLLS_WIDE_ECONOMY_FIXTURES_DIR` unset.

From `frontier-node`, the selected commands were:

```sh
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib fold::player_host_index_tests:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --lib fold::player_host_index_tests:: -- --test-threads=1
cargo +1.95.0 test --offline --locked -p herald --features wide-world-experimental --lib wide:: -- --test-threads=1
```

All passed: **6 new tests with wide enabled, the same 5 non-wide tests in the
default configuration, and 11 existing wide regressions**. This is 17 distinct
test functions and 22 successful selected test executions, not a full suite.
The six new cases cover:

1. Complete response parity, capture/entry order, repeated references and IDs,
   unchanged transits/seals, inactive hosts and short ArrivalSlots.
2. Adding 512 unrelated Provinces, 512 unrelated ArrivalSlots and 512 unrelated
   Holdings leaves the entire response unchanged. The new lookup visits only
   the matching one host row and one arrival address after that growth.
3. Recapture, changed holding-key membership, malformed/type replacement, close
   and repeated in-memory restart rebuilding.
4. Missing Citizen, empty references and CQ-rejected Holding preserving the
   old host/arrival gate behavior.
5. Tag zero, duplicate IDs across capture addresses and entry removal.
6. Wide owner/malformed refusals preserving legacy captures, followed by
   successful replacement and close removing legacy index membership.

Explicit Rust formatting and `git diff --check` passed. The unchanged Node
classification scanner passed read-only `--check`: 119 direct, 209 conservative
source-closure and 23 unfollowed exclusions, with 17 reviewed entries. No review
metadata, guard, dependency, feature default, economic rule or production gate
changed. No Node/browser test, full ingest run, CI, deployment or transaction
was executed for this slice.

## Remaining limits

The conquest `me_additions` siege scan remains separate and unchanged. The
number of relevant rows can itself grow, and matching rows still need sorting
and serialization. This is therefore not a constant-time or world-size-independent
claim for the entire `/h/me` response. The previous wide inventory index and
all captured/unverified distinctions remain intact. It neither activates
radius-greater-than-128 gameplay nor makes the finite captured world infinite.
The separate pending live-observation UI and its review metadata are excluded.
