# Wide Economy Execution (experimental, host-only) — 2026-11-08

## Status

Experimental, host-only implementation built on top of the preview commit
`62f27eb25d4ec55753733368c8321a205d12daee` ("preview wide holding economics
with unchanged S1 rules"). Work lives in the dedicated worktree
`work/wide-economy-execution-20261108`.

What this is **not**:

- No stable ABI allocation and no deployable target. The Solana build ban,
  the production default wide refusal, the Depart gate, and the UI write guard
  are all unchanged.
- No new economics. Existing S1 rules are reused as-is. There are no new asset
  or rent rules.
- All changes are local source only. No keys, signatures, live sends,
  deployments, or pushes were involved.

## Wire format

The action rides in the existing `0xDA` envelope, `FF01`, op `03`. The action
body is 6 bytes, so the whole payload is 10 bytes. The op byte disambiguates
this action from Muster.

| Action  | Byte 0 | Bytes 1..6                                   |
|---------|--------|----------------------------------------------|
| Harvest | `0`    | zeros                                        |
| Build   | `1`    | item `0..8`, then zeros                      |
| Train   | `2`    | unit `0..6`, then `n` as LE32, `n > 0`       |

Exactly 6 accounts, in this order: actor, payer, Season, Citizen, Holding,
own Province. Holding and Citizen are writable. Province may be either, except
for walls (item 6) and tier (item 7), which require Province writable.

Authentication reuses the existing wallet, session, and NFT-resident
current-owner / generation paths. Address checks use the canonical public PDA
and the with-seed form. Owner, world, season, slot, order, live, capture, and
mirror checks are the existing ones.

## Execution model

- Citizen bucket and stamp, S1 preview state, lazy finality, the receipt, and
  the event chains are all staged on copies first.
- All mutable borrows are obtained and all lengths are checked before the
  first live copy. After that point the only operations are copies and logs.
- No CPI and no lamport movement.
- The Citizen PS2 chain is untouched, but the full Citizen pre and post bytes
  are committed to the receipt digests.

### Events

- Event `15` Economy: Holding chain only.
- Event `16` EconomyMirror: Province chain and Holding chain.
- Record is 56 bytes with the full holding key. Sequence `0` is the key
  record, generations run `1..254`, ring size is at least 129. The host is
  never faked.

### Receipt v1

Fields: action, time, finality, input digest, output digest.

- Input covers the whole Season, the raw pre-Citizen, pre-Holding, and
  pre-Province, including their prior chains.
- Output covers the whole post-Citizen plus the normalized post-Holding and
  post-Province.
- Digests are domain-separated and length-separated.
- The receipt alone proves nothing about authentication.

## Independent verify (feature `wide-economy-experimental`)

The verify crate gains an opt-in feature that replays an economy action
independently of the program preview. It uses the existing
`verify::holding::replay` with S1 rules through independent glue over the
shared kernel.

- The two-byte v2 projection restores only those two bytes, which preserves
  the wide shield.
- The replay rebuilds mirrors, bucket, finality, all post bytes, and the
  actual chains. The input digest is computed before any arithmetic.
- Numeric preflight covers ore times tier bonus for all four tiers, old and
  new dormancy sums, settle time differences, and the canonical fraction
  `0 <= frac < HOUR`. This is a representability guard, not a new ore cap or
  clamp.
- Citizen magic and season structural checks are applied.

### Explicit limits

- There is no V0 or full-Season PASS.
- There is no proof of signature, session, or NFT authentication.
- There is no proof of canonical address or owner-account binding.
- There is no proof of freshness or clock source.
- There is no proof over the Citizen's whole history or surrounding actions.
- There is no blanket claim that all malformed state is panic-free.

## Node indexing

- Findex typed index: new kinds for the two events. It knows nothing about the
  host. It distinguishes holding-only from both-chain records and filters on
  successful frames.
- Keeper: updates holding and province observations and read candidates only.
  No host interaction, no march duty, no automatic writes.
- Separate return-path changes have not been merged or jointly tested in this
  branch. The existing wide runtime test file only gains a child-module
  registration; its existing test bodies are unchanged.

## Observed test results (as of this writing)

Root (Rust 1.89):

- ABI integration: 8 pass. Pure economy 1, event 7, wire 5 pass.
- Host runtime: 12 pass, including wallet, session, and NFT auth paths, all 9
  Build items, multiple Train cases, late holding chain overflow after Province
  staging, due finality plus Insufficient and QueueFull, borrow failures, and
  all-bytes / lamports / logs unchanged on refusal.
- The existing detached-preview regression suite: 27 pass.
- Root lib clippy with `-D warnings` and default lib check pass.

Node (Rust 1.95):

- Findex: 4 new plus 12 existing pass.
- Keeper: 3 new pass.
- Verify: 10 focused unit tests and 6 fixture/tamper tests pass. All five
  normal host-dispatch transitions match the independent replay. The byte-flip
  sweep, numeric-boundary cases, Citizen header checks, and separately resealed
  event/post-header tamper cases pass.
- Verify lib clippy with `--no-deps -D warnings` and its default lib check pass.

These are 95 selected tests, not a full workspace or cryptographic test run.
The native program test build retains 9 pre-existing unused-code warnings in
`crypto/quick.rs` and `wide_land_runtime_tests.rs`. No release/SBF build, real
transaction, signature verification, deployment, push or CI was run.

## Targeted commands

Run from the worktree root. Use a dedicated target directory. Do not run the
full suite, CI, SBF builds, sends, or pushes from this document.

```sh
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
# Substitute fresh, dedicated directories. Do not reuse a parallel build target.
export CARGO_TARGET_DIR=/tmp/wylls-economy-check-root

cargo +1.89.0 test --offline --locked -p frontier-abi --features world-index-experimental --test wide_economy -- --test-threads=1
for filter in world_index::economy::tests world_index::event::tests world_index::wide_ix::tests; do
  cargo +1.89.0 test --offline --locked -p frontier-abi --features world-index-experimental --lib "$filter" -- --test-threads=1
done
cargo +1.89.0 test --offline --locked -p permutation-frontier --features wide-world-experimental --lib map_growth_runtime_tests::wide_land::wide_economy:: -- --test-threads=1
cargo +1.89.0 test --offline --locked -p permutation-frontier --features wide-world-experimental --lib proc::wide_economy::tests:: -- --test-threads=1
cargo +1.89.0 clippy --offline --locked -p permutation-frontier --features wide-world-experimental --lib -- -D warnings
cargo +1.89.0 check --offline --locked -p permutation-frontier --lib

export CARGO_TARGET_DIR=/tmp/wylls-economy-check-node
export CARGO_BUILD_JOBS=2
cargo +1.95.0 test --manifest-path frontier-node/Cargo.toml --offline --locked -p findex --features wide-records-experimental --test wide_economy_index --test wide_typed_index -- --test-threads=1
cargo +1.95.0 test --manifest-path frontier-node/Cargo.toml --offline --locked -p keeper --features wide-world-experimental --test wide_economy_index -- --test-threads=1
cargo +1.95.0 test --manifest-path frontier-node/Cargo.toml --offline --locked -p verify --features wide-economy-experimental --lib wide_economy::tests:: -- --test-threads=1
cargo +1.95.0 test --manifest-path frontier-node/Cargo.toml --offline --locked -p verify --features wide-economy-experimental --test wide_economy -- --test-threads=1
cargo +1.95.0 clippy --manifest-path frontier-node/Cargo.toml --offline --locked -p verify --features wide-economy-experimental --lib --no-deps -- -D warnings
cargo +1.95.0 check --manifest-path frontier-node/Cargo.toml --offline --locked -p verify --lib
```

Fixture details are in
`frontier-node/crates/verify/tests/fixtures/wide_economy/README.md`.
