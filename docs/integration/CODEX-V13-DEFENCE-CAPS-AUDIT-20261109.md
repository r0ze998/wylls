# V13 defence cap correction: source review and validation

Base: `adf4ca07f0c1cf643da9235746b5e831222d031b`.
Owned code: `frontier-node/crates/verify/src/checks/v13_payments.rs` only.
The separate wide defence consistency module is outside this report.

## Verified semantics and correction

Source reviewed directly:

- `permutation-frontier/src/proc/defence.rs`: `claim_defence` constructs
  `Caps::default()` inside the handler, sums admitted refunds with
  `checked_add`, applies the remaining keeper-day allowance, pays the lesser
  of capped demand and pool availability, and increments `DefenceClaim.claimed`
  by `paid`. Its module documentation explicitly calls out the per-call
  bell-region scope and the absence of a global region counter.
- `permutation-frontier/src/proc/wide_defence_exec.rs`: the experimental
  handler uses the same per-call `Caps` and adds `paid` to the shared claim
  account. This confirms the existing semantics; it does not authorize
  widening V13's instruction handling.
- `frontier-node/crates/verify/src/world.rs`: `Tx::ix` returns the first
  matching instruction. `Rec` has transaction and log-order position but
  no instruction or invocation identity. `state_before` is transaction-level.

V13 now creates fresh `ClaimCaps` for each attributable legacy claim and
charges the keeper-day allowance only the recorded paid amount. Thus with
region cap 17 and day cap 25, two calls can pay 17 then 8. A partial payment
of 7 followed by 17 consumes 24, leaving 1. Different keepers' calls do not
exhaust one another's regional cap.

Attribution requires one legacy ClaimDefence instruction and one DEFENCE_CLAIM
receipt in that transaction. Multiple instructions or receipts are MissingData,
not ordered or first-match pairings. The unique instruction must decode and
match the receipt's beneficiary, day and slot count; the slot account list must
be complete. No wide tag is recognized by this legacy path.

Observed receipt totals are accumulated independently with checked addition.
A skipped, ambiguous or rejected earlier claim taints its keeper/day: later
claims receive MissingData and the observed paid-before total, not a claim of
verified remaining allowance. A later day or different keeper is independent.
Refund sums use checked addition. Lateness uses the handlers' saturating
subtraction rather than potentially overflowing `anchor_slot + lateness`.

## Exact selected runtime closure

The command below selects all and only these 13 tests in this module:

1. `region_cap_resets_per_call_while_day_cap_pays_17_then_8`
2. `partial_7_then_17_consumes_24_not_25`
3. `region_cap_is_shared_by_slots_in_one_call_only`
4. `keeper_days_have_separate_allowances`
5. `amount_above_remaining_day_allowance_fails`
6. `multiple_instructions_are_missing_and_taint_later_day_claims`
7. `multiple_receipts_are_not_assigned_to_the_first_instruction`
8. `missing_legacy_call_is_not_a_zero_demand_claim`
9. `receipt_identity_must_match_the_unique_instruction`
10. `receipt_total_overflow_fails_without_wrapping`
11. `refund_total_overflow_is_checked_before_counter_mutation`
12. `lateness_near_u64_max_does_not_overflow`
13. `ambiguous_claim_taint_stays_with_its_keeper_and_day`

Test helpers are contained in the same module:

- `facts`: copies the constant M1 preset, overrides four numeric fields,
  constructs literal Facts/AddrCtx/AnchorFact/BeaconClock, calls the pure
  `WindowSchedule::fixed` and `Facts::region`, and constructs empty collections.
  It does not call `Facts::build` or `Facts::build_with_ctx`.
- `tx`: constructs a literal World Tx with empty vectors/maps. The signature
  field is an empty string; no transaction or signature is constructed.
- `scenario`: calls those helpers; constructs a literal World, Account DTOs,
  instruction account arrays and raw 14-byte receipt payloads; writes literal
  ArrivalSlot evidence into in-memory buffers; invokes ClaimDefence's fixed
  byte encoder and public `AddrCtx::bell_anchor` hashing. Each evidence record
  has price 20,000 micro-lamports and CU limit 1,000, yielding refund 20 with
  the literal numeric parameters. Its addresses are literal byte arrays.
- `judge`: constructs literal Config/Input/Ctx and empty default counters,
  SigCache and History, then calls only `claims`, not V13 `run`, `transits`,
  `checks::run` or the whole verifier.

Production functions reached are `claims`, `unique_claim`, `ClaimCaps::admit`
and `ClaimCaps::capped`. Their remaining nonstandard calls are:

- World `of`, `state_before`; Ix `tag`, `key`; Rec `k`, `p`, numeric readers
  and `le`; ABI log field-table lookup.
- ClaimDefence fixed-width encode/decode through existing ABI Writer/Cursor,
  tags and integer Wire implementations; ArrivalSlot `evidence` through ABI
  byte readers; constant `defence_claim::MAX_SLOTS`.
- `Facts::anchor`, `Facts::region` and pure ProvinceCoord/region arithmetic.
- Existing fees `min_tip_lamports`, `defence_refund`, cost and integer rounding
  helpers. The program handler's optimized refund function is not called.
- Public `AddrCtx::bell_anchor` -> `bell_anchor_seed` -> kernel anchor seed
  codec -> `AddrCtx::of` -> `with_seed` -> `permutation_rules::hash::sha256` ->
  native `sha2`. Only public literal bytes are hashed. No PDA curve search,
  key generation, private-key derivation, private data or signing is involved.
- `world::b58` -> `Address::new_from_array` and Address Display/base58;
  Address literal constructors in the helpers. These wrap/format public
  literal bytes, not key material generated by a signer.
- `Ctx::fail`, `Ctx::missing`, `Ctx::push` to append in-memory findings;
  normal standard-library collections, formatting, slices, integer operations,
  test assertions and the test harness.

`SigCache::ok` and all signature verification are unreachable from these tests.
No fixture builder/exporter, existing tamper helper, guard test, dispatcher,
native-crypto test, keypair helper, RPC, network, process launch, account
creation, transaction submission, CI or deployment is called. Filesystem
activity is limited to the normal compiler/test harness if later authorized;
the test bodies use only memory. No external fixture file is included.

## Build scripts, macros and dependency delta

This change adds no dependency, feature, manifest/lockfile modification,
build script, custom procedural macro, constructor or runtime initializer.
Added attributes/macros are built-in `cfg(test)`, `test`, `derive(Default)`
and standard `vec!`, `format!`, assertions and `unreachable!`. Existing ABI
instruction/layout macros are unchanged. There is no new invocation of a
custom derive or build script.

The proposed command deliberately uses the previously reviewed
`verify + wide-world-experimental` graph on native aarch64-apple-darwin.
Build-time dependencies remain subject to
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md` and
`CODEX-WIDE-VERIFY-AUDIT-20261109.md`, only while those inspected dependencies,
features, toolchain and cached sources remain unchanged. This report does not
re-certify them or authorize unrelated concurrent changes. No Cargo dependency
resolution, compilation, test or formatter was run to produce this report.

## Focused validation

From `frontier-node`, using a non-login shell, after static review of the
complete final source and build/runtime closure:

```sh
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 cargo +1.95.0 test --offline --locked -p verify --features wide-world-experimental --lib checks::v13_payments::tests:: -- --test-threads=1
rustfmt +1.95.0 --edition 2021 --check crates/verify/src/checks/v13_payments.rs
git diff --check
```

Result: **13 passed, 0 failed, 73 filtered out**, in 0.00 seconds. The final
taint-isolation regression confirms an ambiguous keeper/day does not suppress
checks for another keeper or a later day; it uses the same audited helpers.
Rustfmt and `git diff --check` pass. Independent semantic review found no
regression within this narrow correction. The bugs were confirmed by direct
source comparison; the old implementation was not executed with these tests.
No whole-verifier pass, complete defence replay, deployment or completion is
claimed. No key operation, native proof, transaction, exporter or CI ran.

## Remaining source limits

This is an arithmetic/attribution correction, not a complete defence replay.
It does not authenticate logs or account snapshots, prove complete history,
or reconstruct intra-transaction account states. Prior allowance still comes
from observed history, not an authenticated DefenceClaim pre-state. Missing
history remains subject to the existing history/coverage gates. Ambiguous
calls conservatively stop later checks for that keeper/day rather than guessing.

The legacy payment check still does not reproduce the handler's complete
account-address/prologue checks, day-at-clock and claim-grace windows, duplicate
slot handling, positive-refund eligibility, pool rent/available balance,
partial-flag exactness, account writes or lamport conservation. Its existing
partial rule permits an amount at or below capped demand. These are not
silently declared verified by this correction. Existing absent-slot/anchor
eligibility findings are otherwise unchanged. V13 is not extended to wide
receipts, and this report makes no full-Season support claim.
