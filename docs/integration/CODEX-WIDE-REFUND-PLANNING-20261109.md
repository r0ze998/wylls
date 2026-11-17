# Unsigned wide refunds and arrival-record cleanup

Date: 2026-11-09. Base: `c1a9e350a73a5896121b9912794dd2af4ea4e349`.
Continues the original-game wide lifecycle without enabling production writes.

## Read-only refund planner

The existing `wide-world-experimental` feature now exposes
`keeper_core::wideclaim`. Its synchronous APIs are:

- `required_keys`: bounded canonical read keys for a keeper, observed claim
  day and 1–6 full `(world, coordinate, bell, faction, index)` slot identities.
- `plan_claim_defence`: unsigned instruction and predicted facts from supplied
  `Reads`, or exact missing keys/refusal. Ordinary reads remain incoherent.
- `plan_snapshot`: judges only one existing sealed snapshot, including Clock
  and Rent. It refuses incomplete responses rather than patching them with
  another read. No new RPC driver is added.

The planner checks the pinned experimental Season, canonical account families,
live anchors, beneficiary/day, recorded created-day evidence, grace and
lateness. It predicts the existing shared pool/keeper-day accounting, per-call
bell/region caps, actual payment, partial bit, consumed slots, counters, claim
rent shortfall and keeper/pool/claim balances. The keeper must fund creation
before receiving the refund. A zero-paid claim still consumes eligible slots.

Candidate fields are private with immutable accessors. Its snapshot metadata
is retained only after the existing digest re-verifies the exact account,
Clock, Rent and minimum-slot bytes. Mutating a cloned instruction/facts object
does not change the candidate; changing reads loses coherence. Coherence
means one response at a context slot, not source authority, freshness,
signatures, permission, or successful execution.

The payer is conservatively restricted to a distinct, non-executable,
System-owned, data-less account. This is an explicit planner boundary, not a
new handler/game rule. Transaction fees, actual rent transitions, allocation
CPI and signature validity remain unverified. `AUTOMATIC_SEND` is false; the
candidate is not integrated with Duty, tick, admission, simulation or sending.

### Concrete checks and limits

Independent source review found the shared Season decoder accepts a 1,024-byte
prefix while the actual handler requires at least 2,048 bytes. This planner
now checks the full minimum before decoding. Tests reject 1,024/2,047 bytes and
still accept longer records, matching the handler's minimum-size rule. The
shared decoder and other planners were not changed in this slice.

Six slots with distinct live anchors need **16 account keys plus Clock and
Rent**, and 17 instruction metas. The actual focused test pins the packet
bound to **807 bytes**, including the widest four-instruction ComputeBudget
prefix and the existing extra 32-byte cushion, below the 1,232-byte limit.
Oversized packets have an explicit policy refusal.

One literal example predicts a 40,711-lamport refund and a 156-lamport creation
shortfall when the claim is prefunded by 100 and its synthetic Rent floor is
256. These are test inputs, not current network prices or a real payment.

## ArrivalDay and ClashInputs cleanup

Four direct-host tests reproduced WideClose(3)/(4) resizing/assigning the
source before discovering a recipient overflow or lamport-borrow failure.
The borrow case could also debit the source before failing on the recipient.

The staged WideClose(2) protection is now a private helper shared by slot,
day and inputs closes. It checks existing Sink::Never payment arithmetic and
rent, stages the zero-link receipt, then probes all eventual mutable data and
lamport borrows before resize/assign/payment. Deterministic refusal leaves
account bytes, ownership, balances and logs intact. Shared init semantics,
successful payment rules and immutable recipients are unchanged.

The case rules remain unchanged:

- ArrivalDay waits until its province has resolved all 144 bells of the day.
- Resolved ClashInputs needs every present arrival settled and its close
  grace elapsed. A populated but absent position does not require settlement.
- No-arrival inputs needs the province past its bell and grace from bell end.
- Ended +72h or a valid Closed tombstone permits cleanup after the province
  has closed, but the province position must still have its canonical address.
- Aborted is an admitted Season status but does not bypass these case rules.
- Zero payouts, program-owned recipients and external-account rent floors
  keep the previous payment behavior. Impossible self-recipient records refuse.

No changes were made to transit/holding/ticket/province close semantics.
Real Solana runtime rollback already protects failed transactions; these
fixes make the direct-host paths reject predictable failures before effects.

## Audit and validation

All executed paths were statically traced before running them, including the
exact selected dependency versions. The prior root Cargo 1.89 and Node-workspace
Cargo 1.95 build audits still cover the unchanged manifests, features, locks,
build scripts, procedural macros and constructors.

The planner target uses only literal synthetic account construction, public
PDA/address hashes, byte codecs, scalar arithmetic, bounded collections and
locally constructed JSON/base64 snapshots. Packet sizing reaches
`solana-message 4.4.1` key-map/index compilation, then
`solana-transaction 4.1.6::new_unsigned` (zero-filled signature placeholders),
then in-memory bincode 1.3.3 serialization. No signer/verification API or
network port is called. Synthetic snapshot metadata uses public SHA256.

The cleanup tests use literal accounts and actual direct dispatch. Newly
covered tombstone/deadline paths check public identity and scalar clocks.
Closing uses in-memory resize/assign, borrowed lamport arithmetic and zero-link
record encoding. No CPI, lifecycle executor, rollback wrapper or exporter runs.

Focused validation:

- Four cleanup regressions failed before the fix and pass afterward.
- Program Garrison/defence/cleanup aggregate: **53 passed** (12 new cleanup
  tests plus the previous 41 tests).
- Unsigned planner integration target: **18 passed**.
- Existing keeper evidence regressions: **2 passed**.
- Rustfmt and `git diff --check` pass. The program emits only the pre-existing
  unused `Wide::at` warning. This is not a full-workspace test run.

With `CARGO_BUILD_JOBS=2`, `WS19_GOLDEN_WRITE` and
`WYLLS_WIDE_ECONOMY_FIXTURES_DIR` unset, native host and non-login shell:

```sh
# Repository root
cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_garrison:: -- --test-threads=1
# frontier-node
cargo +1.95.0 test --offline --locked -p keeper \
  --features wide-world-experimental --test wide_claim
cargo +1.95.0 test --offline --locked -p keeper --lib \
  --features wide-world-experimental widesettle::claim_evidence_tests::
```

## Remaining boundaries

The planner is a library API, not a browser action or automatic claim loop.
Neither this slice nor the preceding claim handler supplies full wide-world
or Season replay. Full post-proof SettleTransit remains unexecuted. No browser
or JavaScript suite ran for these Rust-only changes.

Production/SBF, experimental version and Season creation, departure-debit,
automatic-write, and mixed-family movement gates remain unchanged. No private
key generation/derivation/signing, native-crypto suite, guard self-test,
transaction submission, deployment, private NFT prize publication or CI ran.
