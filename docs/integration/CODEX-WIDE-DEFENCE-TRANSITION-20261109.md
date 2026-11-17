# Wide defence supplied-transition checker

Date: 2026-11-09. Base: `adf4ca07` on
`codex/route-preview-refresh-20261108`. This slice adds no ABI, handler,
keeper, fee rule, dependency, production activation or whole-Season verdict.

## API and precise claim

Under the existing, off-by-default `wide-economy-experimental` feature,
`verify_core::wide_defence::verify_transition(&Transition)` accepts:

- Exact nine-byte WideClaimDefence envelope, program and Season identities.
- Ordered keeper, Season, shared DefencePool, **existing** DefenceClaim,
  System, and 1–6 wide ArrivalSlot/live BellAnchor pairs.
- Complete before/after account data, balance, public key, owner, executable
  flag, rent epoch and asserted invocation signer/writable privileges.
- All supplied Clock fields, the Rent rate/threshold/burn fields, and the
  exact separate PS2 prefix and DEFENCE_CLAIM body including its zero-link tail.

A successful result states consistency of these supplied facts with one
successful instruction transition. It is **not authenticated receipt replay**.
The legacy PS2 record binds only beneficiary, current bell, current day, slot
count, amount and partial bit. It does not bind slot identities, timestamp,
input state or output state. A regression supplies two different slots and
timestamps with the same receipt; both are consistent. No transaction,
signature, execution success, program binary, account-source authority,
snapshot freshness, Clock/Rent provenance or historical evidence is inferred.
Both `AUTHENTICATED_RECEIPT_REPLAY_SUPPORTED` and
`FULL_SEASON_REPLAY_SUPPORTED` are false. The default verifier is not wired
to this API. This differs from Garrison's explicit state-digest receipt.

## Independent semantics

The checker was transcribed from `proc/wide_defence_exec.rs`, the account
prologue, `clock.rs`, `frontier/fees.rs` and the public Rent implementation.
It does not call a program handler, keeper stage/planner/refund helper, kernel
refund helper or V13 payment accumulation. ABI use is restricted to existing
instruction/slot/receipt codecs, constants and public address identities.

- Exact account shape/privileges and canonical Season stored-bump hash,
  shared pool, keeper/day claim, full-world wide slots and live anchors.
- At least 2,048 Season bytes, S1 ruleset and pinned wide S1 version (the
  existing NFT bit may also be present). Other experimental versions refuse.
- Effective Running **or Ended**, including Seeded after genesis. There is
  no economy-only `now_bell < end_bell` requirement. The claim day is the
  current landing day, not necessarily the day of its slots.
- Beneficiary, unclaimed evidence, duplicate-slot rejection, canonical live
  anchor bell/region, scheduled reveal window, strict six-bell grace,
  saturating slot lateness and a positive independently computed refund.
- Cost includes the recorded created-day write flag; priority payment rounds
  upward, the defence cap downward, and the minimum-tip deduction upward.
- Per-(bell, region) caps start empty **for every call**. Keeper-day allowance
  uses **actual paid**, not admitted demand. Pool liquidity is balance minus
  supplied Rent floor. Zero allowance yields `paid=0, partial=false`, while
  positive capped demand with an empty pool yields `paid=0, partial=true`.
  Both consume eligible evidence and increment counts.
- Checked counters and keeper credit. Full data and metadata comparison
  catches changed reserved/unaffected/trailing bytes, balances, owners,
  executable/rent metadata and invocation flags, including immutable reads.

`WideArrivalSlot::read` requires its exact length, canonical flags/booleans,
host/world/coordinate codecs and zero reserved ranges. Consequently the
handler's full `write` rewrite preserves every accepted byte except CLAIMED.
This checker independently changes only that byte. Legacy short-header
accounts accept minimum size and preserve extra allocated bytes, matching
the handler. Repeated anchor positions require identical complete images.
Other aliased roles fail closed.

## Explicit boundaries

- Absent or prefunded-empty claims refuse with `Unsupported`: allocation,
  System CPI and its rollback guarantees are not modelled.
- Rent supports exactly the 1.0 and 2.0 integer threshold encodings, with
  solana-rent 4.4's maximum-rate bound. Other thresholds explicitly refuse,
  rather than claiming parity for arbitrary floating-point configurations.
  The ignored burn field and unused Clock fields remain supplied metadata.
- No transaction fee adjustment, unrelated account inspection, native
  borrow conflicts, runtime account ownership enforcement, actual signature,
  live RPC provenance, archive-anchor fallback, full SettleTransit or close.
- Synthetic prior shared counters may include legacy claims, but the
  checker does not authenticate or replay those legacy calls. A refill
  between two calls is a supplied new pre-state, not a verified transfer.
- No byte-fixture exporter or host-generated fixture is used. Tests prove
  self-consistency/rejections of independent literal expectations, not
  execution parity against a new program-dispatch or real-chain trace.

## Prospective runtime closure and build delta

The selected integration target contains 23 ordinary `#[test]` functions.
Its closure is literal/codec construction, bounded vectors, byte reads and
writes, integer arithmetic and comparisons, existing coordinate/host codecs,
public SHA256 address/world/region hashes, and this new checker. The expected
payments and counters are explicit literals. PS2 serialization is an explicit
literal version/kind/key/payload/tail sequence, not verifier staging.

No test imports keeper, fclient, localnet, a handler, a fixture generator,
transaction, signer, keypair, secret derivation, random generator, filesystem,
network or process API. Only built-in derives/test attributes are introduced;
no procedural macro, build script, unsafe code, include-generated artifact,
runtime constructor, static initializer, thread-local or lazy global is added.
The ABI's byte/layout macros expand constants and ordinary Rust. Its native
public hash path is `permutation_rules::hash::sha256` → sha2 0.10.9; it does
not invoke BLS, Ed25519, account signing, key generation or private derivation.

Read-only offline/locked Cargo tree and metadata inspection for native
`aarch64-apple-darwin` found **385 selected packages, 378 external packages,
33 build scripts and 31 procedural-macro crates**, matching the prior wide
verifier audit. Comparing `verify/wide-economy-experimental` with
`verify/wide-world-experimental` yields only the root feature-name difference.
Every external package feature set is identical. The seven selected local
packages have no build-script/proc-macro targets. Agents' build script is not
selected by this verify integration target.

Since the prior reader build audit's base `b7f733b545b06a311b76f8285d30149e52412910`,
the only manifest/build-script/lock/config delta is the separately reviewed
keeper preview binary declaration. It adds no dependency and is not a target
of this verify integration test. Existing dependency/key-related library
functions may compile; none are called by this test. The prior external
build/cache reviews in `CODEX-WIDE-VERIFY-AUDIT-20261109.md` and
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md` remain the basis for unchanged
build-time paths. This is a source/graph review, not binary certification or
a fresh full cache-content re-audit.

## Coverage and validation status

The 23 tests cover six-slot batches, per-call grouping across bells/regions,
7 then 17 paid after refill (24 actual paid), 17 then 8 against a 25 day cap,
zero pool versus zero allowance, created-day 0 versus 300 evidence, rounding,
minimum-tip, extreme-price and maximum-Season-fee arithmetic, Running/Ended and scheduled-window
gates, grace/lateness boundaries, current-day rollover, duplicate/alias and
wrong owner/address/day/world/anchor/beneficiary cases, absent/legacy/malformed
accounts, counters/keeper overflow, Rent subset and exact maximum-rate edges,
positive extra-signer/writable-System privileges, every post-state data byte,
every account balance/metadata field, and every receipt byte. The claim sum
overflow and pool debit underflow are algebraically prevented by allowance
and available-balance bounds; checks still fail closed.

After full static source/runtime review and an independent semantic review,
the exact target below completed: **23 passed, 0 failed**, in 0.02 seconds.
The unchanged Garrison replay regressions (4 unit + 7 integration) and wide
chain regressions (14) also passed. The concurrent narrow V13 correction has
13 passing focused tests, documented separately. This is **61 selected tests**
across the two verifier changes, not a full-workspace or whole-Season pass.
Rustfmt and `git diff --check` pass. The exact new-target command was:

```sh
cd frontier-node
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR \
  CARGO_BUILD_JOBS=2 cargo +1.95.0 test --offline --locked -p verify \
  --features wide-economy-experimental --test wide_defence -- --test-threads=1
```

Use a non-login shell and the unchanged native host configuration. Do not
broaden to other targets, all-features, native-crypto, guard tests, fixture
exporters or CI. No transaction, deployment, private-key generation/derivation,
signing, native proof execution or live network validation was performed.
