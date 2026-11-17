# Wide defence reimbursement and retained-slot lifecycle

Date: 2026-11-09. Base: `49a9fafc72022f961f790914060c3da3cce2b487`.
This is a host-only experimental implementation, not production wide-world
activation or a complete Season replay.

## Implemented claim

Provisional envelope `0xDC FF 01 06` adds `WideClaimDefence { day: u32, n: u8 }`,
exactly nine bytes with 1–6 slot/live-anchor pairs. It is class D, requires the
beneficiary keeper's signer flag, and cannot run through ResidentAct. Existing
top-level tags and event kinds are unchanged. The allocation is provisional
inside the existing experimental band, not a finalized public ABI reservation.

The handler follows deployed `proc/defence.rs` semantics:

- Running/Ended experimental Season, current landing day, canonical wide
  slot of that Season/world, unclaimed and belonging to the keeper.
- THE live canonical BellAnchor, six-bell claim grace, Season lateness and
  recorded priority/loaded/day-write evidence. Archives cannot support claims.
- The **same** deployed DefencePool and `dc(keeper_tag8, day)` DefenceClaim.
  Wide claims do not create a separate daily refund allowance.
- Existing per-slot refund arithmetic and per-(bell, region) cap **within a
  call**. The known deployed lack of a global region counter is preserved.
- Shared keeper/day cap counts actual paid amounts. Only pool lamports above
  rent are available. Eligible evidence is consumed even when a cap or empty
  pool makes the payout zero. `partial` means pool payment below capped demand.
- Existing `DEFENCE_CLAIM` record: beneficiary/day/count/payment/partial concern
  shared deployed accounting, so no wide coordinate or new receipt is needed.
- Claim rent is funded by the keeper, net of existing prefunding. Claims mark
  slots consumed but do not close them or change immutable rent recipients.

All slot bytes, shared counters, payout arithmetic and event encoding are
staged before writes. Duplicate slots refuse explicitly. Existing-account
commit acquires all mutable borrows before copying bytes or moving lamports.
Absent-claim allocation probes expected borrows before CPI. An unexpected
failure inside System allocation still depends on real runtime transaction
rollback; the direct-host harness is not a substitute for that guarantee.

## Concrete lifecycle corrections

### Preserve created-day fee evidence

WideReveal already stored `FLAG_CREATED_DAY`, but runtime claim retention and
both keeper planning branches reconstructed evidence with `created_day=false`.
`WideArrivalSlot::evidence()` now maps the recorded flag consistently. A pinned
integer example has refund zero without the flag and 300 with it. Setting the
unrelated settled flag does not change eligibility.

### Mark retained slots settled

The deployed transit handler marks every retained own slot `FLAG_SETTLED`,
including evidence kept for a defence claim. WideSettleTransit previously left
claim-eligible slots untouched. Such a slot could be claimed but could not use
the normal running-Season close, which requires settlement.

Both retained cases now use `retained_slot_after_settle`, preserving every
field except adding the settled bit. The keeper's read-only disposition and
JSON description reflect this. The test calls this production helper before
or after actual ClaimDefence dispatch, then executes actual WideClose(2).
It does **not** execute full SettleTransit or its crypto-gated proof path.

### Refuse a failed close before effects

Two direct-host regressions reproduced old WideClose(2) partially mutating a
slot when the rent recipient overflowed or retained a shared lamport borrow.
The shared `close_to` shrinks/assigns before attempting payment, and the borrow
case could also debit the source before failing on the recipient.

The wide slot-close handler now preflights the existing Sink::Never payout
arithmetic/rent rule, rejects impossible self-recipient records, stages its
zero-link receipt and probes all eventual mutable borrows before close_to.
Both reproduced failures now leave bytes, ownership, balances and logs intact.
Under-rent refunds and source data/lamport conflicts are also covered, with
successful retry after releasing the borrow. Shared init semantics are not
changed. These are host failure-atomicity fixes, not a claim that on-chain
transactions previously bypassed runtime rollback.

## Runtime evidence and audit boundary

The new tests use literal/public account identities, codec-written synthetic
states, direct dispatch and captured logs. No lifecycle executor, rollback
wrapper, fixture exporter or real transaction is used.

- Nine claim tests cover six-slot batches, immutable fields, duplicate and
  malformed evidence, beneficiary/day/anchor/grace/status, created-day fees,
  per-call and shared day caps, empty pool, prefunding, counter/payment overflow
  and data/lamport conflicts.
- Eight close/helper tests cover both claim/settlement orderings, immutable
  rent recipient, unsettled refusal, retained-bit/evidence preservation and
  the close failures above.
- Two cross-family tests execute actual deployed ClaimDefence and actual
  WideClaimDefence in both orders over the same claim/pool. With a per-call cap
  of 17 and day cap of 25, payouts are 17 then 8, with shared counters. Each
  handler refuses the other's slot bytes without effects.

Exact call paths were traced before execution. The optional claim allocator
uses the already audited `init_with_seed -> top_up/Transfer -> AllocateWithSeed`
host stub, with public Season PDA checks, public hashes and in-memory resizing.
It generates no key or cryptographic signature. The close path uses account
resize/assign, borrowed lamport arithmetic and zero-link event encoding, no CPI.
Legacy claim coverage uses an existing claim, so its allocation branch is not
reached. Keeper tests call only pure evidence/refund/eligibility arithmetic.

The unchanged manifests, features, lockfiles and native toolchains retain the
root Cargo 1.89 and reader/verifier Cargo 1.95 build audits documented in
`CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md` and
`CODEX-GARRISON-READER-BUILD-AUDIT-20261109.md`. No dependency, build script,
procedural macro or runtime constructor was added. Exporter variables stayed
unset. Only explicitly audited test filters were executed.

## Validation

Final focused results: **58 passed** after the final source check.

- Program Garrison/defence/close aggregate: 41 tests, including the previous
  22 Garrison/combat/NFT/allocation/replay-anchor tests.
- New ABI target: 3 tests; exact existing march-envelope compatibility: 1.
- Keeper pure evidence regressions: 2 tests.
- Independent Garrison replay: 4 unit tests and 7 integration tests.

Rustfmt and `git diff --check` pass. The only emitted program warning is the
pre-existing unused `Wide::at` helper. These are focused targets, not the full
workspace test suite.

Commands use `CARGO_BUILD_JOBS=2`, unset `WS19_GOLDEN_WRITE` and
`WYLLS_WIDE_ECONOMY_FIXTURES_DIR`, offline/locked mode and a non-login shell:

```sh
# Repository root
cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_garrison:: -- --test-threads=1
cargo +1.89.0 test --offline --locked -p frontier-abi \
  --features world-index-experimental --test wide_defence
cargo +1.89.0 test --offline --locked -p frontier-abi \
  --features world-index-experimental --lib \
  world_index::wide_ix::tests::march_stage_envelopes_preserve_class_and_collide_with_nothing -- --exact
# frontier-node
cargo +1.95.0 test --offline --locked -p keeper --lib \
  --features wide-world-experimental widesettle::claim_evidence_tests::
cargo +1.95.0 test --offline --locked -p verify \
  --features wide-economy-experimental --lib wide_garrison::tests::
cargo +1.95.0 test --offline --locked -p verify \
  --features wide-economy-experimental --test wide_garrison
```

## Remaining boundaries

The default whole-Season payment verifier still expects a legacy ClaimDefence
instruction/slot family; a wide claim is not silently marked verified. A wide
claim planner, automatic admission/send path and complete wide-world replay
are not added here. Full SettleTransit after its cryptographic proof remains
unexecuted by this slice. Browser/JavaScript tests were not rerun.

SBF exclusion, experimental version and Season creation, production departure
debit, automatic-write and mixed-family movement gates remain closed. No key
generation/private derivation/signing, native-crypto suite, guard self-test,
real transaction, deployment, private NFT prize publication or CI ran.
