# Host-only expedition dispatch revision

The `expedition-dispatch-experimental` feature makes existing authenticated
expedition consumers reachable through `crate::dispatch` using a distinct
wire revision and Season version. This is executable host-development code,
not a deployment, stable ABI allocation, signed transaction or live-game proof.

## Isolation and collision review

`workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md` revision 3
lists 0xD6–0xDF and 0xEE–0xEF as initially free. Existing wide code already uses
0xDA (P), 0xDC (D), 0xDE (N) and 0xEE (W). This change allocates no new outer tag.
The old wide sub-operation envelope is `[tag, 0xff, 1, op]`. The new envelope
is `[tag, 0xff, 2, kind]` followed by one complete, exact existing inner codec.
Version 1/default parsers reject version 2; nested or trailing bytes fail.
The existing decoder runs first: a legacy ring/coordinate payload beginning
`ff02` (for example ring 767 or P=767) retains its original interpretation.

The provisional host-only revision bit is `0x0800`; no existing ABI/program
use was found in this checkout. It is disjoint from capacity `0x1000`, rights
`0x2000`, wide `0x4000` and NFT `0x8000`. The only supported experiment is
S1 + wide + this revision: **PROGRAM_VERSION = 0x4804**. NFT, rights, capacity
and custody combinations are compile-time errors. The feature implies wide,
whose existing `target_os = "solana"` compile error still forbids SBF builds.
These identifiers are not reserved for production by this note.

## Routed commands

Twelve experimental kinds are admitted; the original eleven keep their numbers.

| Kind | Value | Carrier | Existing consumer |
|---|---:|---:|---|
| Depart | 0 | DA | ExpeditionDepart |
| SettleOrigin | 1 | DC | ExpeditionSettleOrigin |
| Reveal | 2 | EE | ExpeditionReveal producer |
| Gather | 3 | DC | ExpeditionGather producer |
| Dissolve | 4 | DA | Original resident Dissolve |
| Return | 5 | DC | Original resident voluntary Return |
| SettleMember | 6 | DC | Same-call original member proof/settlement |
| SettleCamp | 7 | DC | Camp-v2 proof/settlement |
| SettleFailure | 8 | DC | Destroyed-member failure-v1 |
| SettleForfeit | 9 | DC | Current-generation forfeiture-v2 |
| CloseTerminal | 10 | DE | Terminal bridge rent-only cleanup |
| SettleRetainedFailure | 11 | DC | Current-generation retained-slot failure-v3 |

The wrapper validates kind/carrier/inner codec, carrier top-level policy and
a full program-owned, nonexecutable Season with exact size, v2 layout and
program version. Existing consumers then repeat canonical PDA/ruleset/status,
account-count/flag, ownership, issuance, capture/marker, economic and proof
checks. No authorization outcome, receipt or staged plan is accepted as input.
New-wrapper terminal cleanup requires a full Season: a tombstone cannot prove
this revision and is refused. The old `EXPEDITION_ENABLED = false`, raw resident
and settlement admission, and ResidentAct parser remain unchanged.

Receipts continue to bind their canonical inner commands and existing account
manifests, including the Season bytes. They are not signatures or an assertion
of the outer transaction's identity. Retained-slot failure-v3 is reached only
through explicit kind 11 and its exact distinct inner codec; v1/v2 failure
bytes cannot select it. Reverse movement has separate work in progress and
is not admitted here.

## Focused verification

The exact filter below passed **7 tests** with the two optional features and
**4 tests** without them on 2026-11-10. The independent read-only review's
legacy-prefix collision finding was fixed and covered by the FF02 regressions.

`proc::wide::expedition_dispatch_tests::` runs only fixed-public-input native
tests through the real dispatcher and official runtime serializer. The terminal
test proves rent-only closure, retained escrow and duplicate refusal. Resident
Dissolve/Return read the checked-in BRESv001 public account snapshots, explicitly
replace only the initial Season program version with 0x4804, and compare the
economic account bodies against the original fixture output. The old receipt
bytes are not claimed as provenance for that revised initial state. Tests also
reject bad revision, magic, layout version, PDA, owner, caller flags, malformed
envelopes and raw inner admission without effects.
The retained-v3 regression pins kind 11's carrier and Season index, exact
length, v1/v2 disjointness, raw-inner refusal, and existing-wide-build refusal.

The departure test uses existing literal invalid-public-ciphertext inputs and
the native System CPI adapter. It creates the owned bridge, moves the stated
escrow, checks balance conservation and verifies signer refusal before CPI.
Fixture signer flags are not wallet signatures. It does not open or generate
a seal and is not an end-to-end successful journey.

```sh
CARGO_INCREMENTAL=0 cargo +1.95.0 test \
  --manifest-path permutation-frontier/runtime-contract-tests/Cargo.toml \
  --offline --locked -j2 -p permutation-frontier-runtime-contract-tests --lib \
  --features expedition-dispatch-experimental,system-cpi-tests \
  --target aarch64-apple-darwin \
  --target-dir permutation-frontier/runtime-contract-tests/target \
  'proc::wide::expedition_dispatch_tests::' -- --test-threads=1
```

Run the same filter without the optional features to check existing-wide
refusal. No broad suite, key derivation, signing, seal generation/recovery,
network, chain, SBF, CI, deployment or push is part of these checks.

Remaining production requirements include full lifecycle/failure coverage,
stable allocation, supported Solana crypto adapter and measurements, matching
client/keeper/verifier semantics, deployment and independently authorized live
transaction execution. Enabling this host feature provides none of those.
