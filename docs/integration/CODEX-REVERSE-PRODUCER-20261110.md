# Closed original-issued reverse departure producer

The private producer now writes an actual reverse transit from an authenticated
original-issued host resident in a wide Province. It separates the original
issuer Holding/Province from the current wide standing Province/roster and from
the explicit original-family destination. No public command admits this route.

## Independent bytes and pairing

`expedition_reverse_transport::ReverseTransit` uses `PSWLREV1`, version 1, and
386 bytes: header 16 (slot at 9, reserved 10..16), unchanged WideTransit bytes
16..304, immutable original Citizen 304..336, and explicit destination key
336..386. The host must resolve to an original issuer, the origin to wide land,
and the explicit destination to original land in the same Season-derived world.
Existing outbound `OwnedBridgeTransit` codecs and wire meanings are unchanged.

Before Gather, common `WideTransit.dest` is absent. After Gather it must equal
the explicit destination. The owned lifecycle is Departed -> Settled or
DestroyedAtOrigin -> Gathered; the immutable origin/owner/destination and rent
recipient survive each transition. `gather_worn` applies authenticated slot wear
once, with the existing cap, and repeating the same Gather is idempotent.

The reverse marker is 96 bytes at the original Holding's selected embedded
slot. State remains reserved bridge state 4, with a distinct version 2 at byte
93. Only host-id, financial tip/flags, and a domain-separated digest of the
complete initial reverse record are populated; all other bytes are zero.
`authenticate_pair` checks canonical Holding, canonical external slot address,
slot number, and that full immutable digest, including the actual wide origin.
Tip and the existing fee/bond flags remain marker-side financial authority.

`expedition_reverse_ix::Depart` is a closed 419-byte `ff 52 44 01` envelope:
full host 56, destination key 50, slot 1, arrival bell 4 LE, tip 8 LE,
commitment 32, and opaque seal 264. The public wide/v2 parsers reject it.
Only public ciphertext shape and root hashing occur at departure, as in the
existing Depart contract. This does not assert a valid seal or open one.

## Runtime writes

Departure has eleven exact roles, in order:

1. actor signer
2. payer signer writable
3. Season
4. original Citizen writable
5. original issuer Holding writable
6. wide standing Province writable
7. executable System program
8. original issuer Province
9. canonical external transit writable
10. canonical wide standing roster
11. original destination Province

Actor/payer may alias with coherent effective privileges and shared storage.
Issuer/destination may alias. Every other alias, cross-key shared storage and
unexpected executable account is refused before effects.

The handler repeats wallet/player authorization, current original owner and
Citizen binding, exact issuer address/gen/issued sequence, capture lock, all
four embedded transit slots, full roster pairing, resident/readiness/faction,
arrival window/end bell, actual Season minimum tip/fee/bond, selected free slot,
canonical absent external account, and payer funds. It stages Spend, Citizen
rate/accounting, Holding escrow/marker and receipts before transfer/allocation.
It then uses actual System transfer/AllocateWithSeed and copies all prepared
bytes only after acquiring all write borrows and checking resulting balances.
CPI failures retain the runtime transaction rollback requirement.

Origin settlement has seven exact roles: payer signer, Season, original Holding
writable, issuer Province, wide standing writable, wide roster writable,
external reverse transit writable. It authenticates the record/marker pair and
current issuer again, reads the actual resolved departed row and kernel march
values, clears that row and its full-reference side-table entry, and advances
the external state. It does not refund/credit troops, change escrow, or perform
CPI. A staged value cannot be supplied as authority to either handler.

An isolated `PSFR` observation binds the command and full ordered input/output
account manifests. Output Citizen/Holding/standing chain tails are normalized
before advancing the appropriate original and wide chains. This is not a new
allocated PS2/PSW1 event and has no existing public indexer admission.

## Validation and limits

Three exact native tests passed through official ABIv1 account serialization,
actual native System CPI, official writeback and instruction balance checks:

```text
cargo test --manifest-path permutation-frontier/runtime-contract-tests/Cargo.toml \
  --features public-proof-tests,system-cpi-tests --lib \
  proc::wide::expedition_reverse::tests:: --offline --locked -j2 \
  -- --test-threads=1
```

Inputs use the unchanged public native resident archive `dissolve_v1.bin`
(SHA-256 `0d46cd2d175c57c947af8e67f14f2d002e18c9e7e7d47fb4a944e98023f39a84`).
Readiness is explicitly adjusted in disposable test accounts; the test does
not claim the archived state historically authorized a new departure. The seal
is an invalid all-zero literal with only the compressed-point flag set. No key,
signature, valid seal, seal opening, RPC or transaction API is exercised.

Positive checks cover real allocation, full transport pairing, source/standing
separation, Season-derived monetary totals, escrow and payer balances, old codec
refusal, replay refusal, and resolved Spend -> released roster -> Settled ->
once-worn Gathered pairing. Negative cases cover actor, owner, generation,
issuance, selected slot, a duplicate active host in another slot, malformed
fourth slot, funds, destination family, roster alias/pairing and a late borrow
conflict. Deterministic refusals are swallowed inside a successful native
writeback to prove no data, balances, logs or CPI changed before rejection.

The original `host.rs` resident/Depart paths in wide builds use
`host_in_transit_with_bridge`; clash/capture/release paths use the shared
occupancy parser. Those readers reject reverse marker version 2, preventing
old readers from treating the reservation as a free/ordinary transit. Default
program builds reject the experimental Season version. This is deliberately
fail-closed, not capture or terminal support: existing original Holding actions
that scan all slots can be blocked while a reverse reservation exists. Capture,
terminal cleanup, previous generation, reverse final economic settlement and
public admission require explicit reverse-aware contracts before this route
can be exposed. No existing marker/capture semantics were silently changed.

The origin test uses the real Host Spend kernel to prepare the resolved row;
it does not claim a complete Resolve/Reveal/Gather/settlement end-to-end run.
Sibling reverse arrival/Reveal consumers are separate work. No CI, SBF build,
chain, deployment, push or key/signature/seal generation was performed.
