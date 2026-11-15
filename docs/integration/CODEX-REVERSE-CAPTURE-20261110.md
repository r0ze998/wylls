# Reverse marker occupancy and original capture

The shared original-Holding occupancy parser now distinguishes reverse marker
version 2 from outbound bridge version 1. Both remain occupied. Reverse decode
is strict and its packed original host binds to the canonical issuer Holding.
Unknown versions, noncanonical reserved bytes, wrong issuer and malformed later
slots are refused. Occupancy is not external-record pairing or economic
settlement authority: callers still authenticate the program-owned Holding.

Original resident/Depart host locks inspect every slot and lock only the exact
host ID. Dormant release continues to treat the reservation as occupied. Existing
season-end CloseHolding retains its contract: it closes all remaining escrow
to the stored rent payer, after which reverse terminal cleanup is rent-only.
Original Gather now explicitly skips both marker representations,
so it cannot consume reverse bytes as a legacy arrival/result. Existing legacy
settlement state checks and the outbound codecs remain unchanged.

Original SettleCapture uses the existing owner, generation, Citizen slot,
reservation, rent refund, capture-effects, PREV_GEN/PREV_OWNER_TAG/PREV_HOME,
Citizen/JoinShard updates and PS2 event contracts. It refunds each occupied
slot's still-escrowed Season bond to the original rent payer and clears only
that financial flag. Reverse tip, fee flag, host/digest and immutable external
record survive capture; the external pair still authenticates afterward.
No external record or additional authority account is added to SettleCapture.

For a Holding containing a reverse reservation, new before-effects checks:

- Every reverse host must be the current Holding generation and have an issued
  sequence below HOST_SEQ. A subsequent capture while a previous-generation
  reverse remains is explicitly unsupported, preventing overwrite of the one
  previous-owner/home history record.
- Holding escrow must cover the sum of all still-bonded occupied slots across
  all four slots, including legacy/outbound slots.
- The captor's ticket escrow must cover the existing rent swap.

These checks do not authorize previous-generation final economic settlement.
That remains a separate reverse lifecycle contract; the current settlement
implementation requires current owner/generation. Terminal cleanup separately
uses immutable original owner plus the existing captured-history match. A
pending prior reverse can therefore block a later capture until its authorized
cleanup, deliberately preserving rights rather than discarding history.

## Exact verification

Direct Rust 1.95, offline/locked, native only, `-j2`, serial test execution:

```text
cargo test --manifest-path permutation-frontier/runtime-contract-tests/Cargo.toml \
  --features public-proof-tests,system-cpi-tests --lib \
  proc::conquest::reverse_capture_tests:: --offline --locked -j2 \
  -- --test-threads=1
# 3 passed

cargo test --manifest-path permutation-frontier/runtime-contract-tests/Cargo.toml \
  --features public-proof-tests,system-cpi-tests --lib \
  proc::wide::expedition_reverse::tests:: --offline --locked -j2 \
  -- --test-threads=1
# 3 passed

cargo test -p frontier-abi --features world-index-experimental \
  --test legacy_bridge_interlocks --offline --locked -j2 -- --test-threads=1
# 5 passed
```

The new tests deserialize the unchanged public resident archive and adjust
only disposable public account state. They use official native AccountInfo
serialization/writeback and balance checks, with no CPI. Positive assertions
cover capture ownership/history, previous home, actual bond/rent lamport
transfers, preserved fee/tip and pair binding, Citizen slot removal and shard
counts. A second capture after that actual writeback is refused unchanged.
Negative cases swallow rejection inside successful writeback and compare all
accounts, CPI and logs: prior generation, unissued sequence, malformed later
slot, unknown marker version, wrong issuer, single/aggregate bond shortfall,
captor rent shortfall and actual dormant-release refusal.

No new valid seal, key material, signature, RPC, chain, CI, SBF build, deployment,
public dispatch gate change, commit or push is part of this change.
