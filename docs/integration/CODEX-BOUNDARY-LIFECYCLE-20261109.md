# Continuous native boundary lifecycle, 2026-11-09

Base: `44efd9ecf34fd65f65d18b6be28dea28b379b448` plus the isolated native
runtime/System CPI harness described in `CODEX-BOUNDARY-SYSTEM-CPI-20261109.md`.

## Executed result

Two exact-filtered native test functions pass:

1. `contiguous_departure_boundary_combat_and_stays_settlement`
2. `contiguous_departure_boundary_retreat_and_original_home_return`

Both begin with an original-game Citizen, Holding and issued host standing in
original province `(128, 0)`. Each follows this continuous sequence:

- Real private departure: payer transfer, bridge rent funding, and official
  System `AllocateWithSeed`; the actual writer records Spend, escrow, original
  Citizen identity and the original PS2 chains.
- Actual legacy `ResolveFromInputs`: an opposing original resident causes
  combat. The departing host's survivor count and stamina come from that
  handler, not from a supplied outcome.
- Real private origin settlement: those survivors enter the bridge, and the
  original roster entry is freed without issuing another host.
- Real private boundary Reveal: the geometrically valid two-step route enters
  ring129; the actual producer allocates ArrivalDay and ArrivalSlot, preserves
  the original Citizen and departure quota mass, and emits its receipt.
- Real private Gather: the producer allocates ClashInputs, scans every slot,
  and carries the actual origin survivors into the destination row. Repeating
  Gather produces identical account state and performs no additional CPI.
- Actual wide Resolve: the stay variant fights a wide resident, preserves the
  full original host identity in the wide roster and uses the real survivor
  count. The return variant has a sealed retreat threshold; the real resolver
  derives Retreated before destination combat, without injecting that fate.
- Actual proof-bound settlement: the same committed seal is reopened using the
  existing public fixture, then the real writer clears escrow and the embedded
  marker, sets the settlement bit, closes the bridge and slot, returns rent,
  and emits decodable paired PS2/PSW1 receipts.
- The stay variant leaves the original home unchanged. The retreat variant
  credits the exact resolved survivors to the original host ID as a pending
  muster, with the original issuance sequence unchanged. Repeating settlement
  is refused with no successful account output or duplicate return.

Every intermediate account is taken from the preceding successful runtime
output. No prepared plan, generated combat result, rewritten bridge, injected
arrival, manually set destination fate, or post-departure fixture byte mutation
is used to connect these stages. Each successful call checks global lamport
conservation and official runtime writeback. The two tests are two scenarios,
not real transactions.

## Isolation and verification

The new source is `permutation-frontier/src/proc/wide_expedition_lifecycle_tests.rs`.
It is a test-only child of the existing private Gather writer. Two narrow
forwarders in the return/proof modules call the unchanged same-call settlement
helper using full accounts, commit and seal, never a prepared authorization or
caller-supplied verdict. They require test, runtime-contract, public-proof and
System-CPI features on a non-Solana target. Production dispatch and public gates
are unchanged.

The test source and the forwarders were reviewed before selected execution.
An initial native run correctly rejected the plain-host fixture's System-owned
instructions sysvar. The initial fixture was corrected to the official Sysvar
owner; no runtime validation was weakened. Compile-only checks also caught two
test naming mismatches. The final exact run passed both scenarios after adding
the duplicate-settlement refusal checks. Existing three dead-code warnings
remain; the broad library suite and CI were not run here.

From the repository root, with installed Rust1.95, cached dependencies and the
reviewed isolated lock:

```sh
cargo +1.95.0 test \
  --manifest-path permutation-frontier/runtime-contract-tests/Cargo.toml \
  --offline --locked -p permutation-frontier-runtime-contract-tests --lib \
  --features public-proof-tests,system-cpi-tests \
  --target aarch64-apple-darwin \
  --target-dir permutation-frontier/runtime-contract-tests/target \
  'proc::wide::expedition_gather::exec::lifecycle_tests::' \
  -- --test-threads=1
```

Execution used direct installed Cargo/rustc and Apple clang/ar paths, a clean
environment, offline mode and two build jobs. The unchanged public vector file
is SHA-256 pinned. Quicknet verification and recovery of its already-public
symmetric material are real operations; the deterministic in-memory wide body
is unsafe for production sealing and provides no confidentiality. No new keys,
signatures, fixture randomness, Transaction, RPC, bank, SBF, CI or deployment
was used. No private prize data or credential was read or added.

## Remaining limits

Initial season creation, joining, founding, muster, province opening, origin
empty-arrival collection, anchor and seed producers remain synthetic prior
state. The origin seed is a fixed literal. This is not a complete season replay
or proof of their provenance. The live model/GUI/keeper paths did not run.

The native System bridge is not the SBF CPI syscall or bank transaction
processor; signer bits are fixture privileges, failed contexts are discarded,
and no transaction-wide compute-budget or rollback guarantee is claimed.
Official ABI backing does not establish Rust aliasing soundness.

This run has zero march fee/bond and no nonzero tower wear, camp Works,
conquest/capture, captured PREV_HOME continuation, bad-seal/nonmember or terminal
cleanup scenario. The earlier settlement tests cover some of those cases only
from separate prior-state snapshots. Public expedition/conquest/departure gates
remain closed. This is a continuous native departure-to-return checkpoint, not
an activated playable wide-world release.
