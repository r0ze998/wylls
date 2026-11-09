# Wide garrison combat, NFT authorization and Resolve commit safety

Date: 2026-11-09. Base: `34d1049f4171aa9c36ade35ff2dff61c3b00c8a6`.
This continues the provisional host-only WideGarrison slice. It does not
enable production wide worlds or decide any new gameplay/economic rule.

## Concrete fix

`proc::wide::resolve` used to copy the Province, roster and gathered-arrival
bytes before constructing the final Resolve receipt. A receipt sequence
overflow could therefore return an error after activating pending garrison
troops. A later roster or arrival-account borrow error could likewise occur
after an earlier account had been changed.

The new direct-dispatch overflow regression reproduced the defect against
the original implementation: the instruction returned `Overflow`, but its
account-state equality assertion failed. No rollback executor hid the write.

Resolve now constructs the receipt and advances its Province chain on the
scratch image before allocation or live writes. For existing accounts it
acquires every mutable borrow and checks every length before the first copy.
Only complete copies and the final log follow. The input/output commitments,
combat model, receipt format, account order and gameplay rules are unchanged.

Regressions cover receipt overflow, retained roster and arrival-data borrows,
unchanged account bytes/lamports/owners and unchanged logs on refusal, then
successful retry after releasing the borrow. Retry activates reinforcement
once, resolves the gathered input and advances the receipt chain once.

The optional System-program roster allocation still has the runtime's
transaction-rollback boundary. These tests use present rosters and do not
exercise allocation or assert host-level rollback of CPI effects.

## Actual hostile-combat dispatch

Two tests use the actual WideGarrison and WideResolve handlers, at coordinate
`(129, 0)`, with a literal fully gathered hostile arrival and a present roster.
The stored terrain is a synthetic grassland site, and the cache seed is a
literal. No model-only outcome is substituted for dispatch.

With 100,000 milli-troops initially on each side:

| Case | Garrison after bell | Attacker after bell |
|---|---:|---:|
| No walls | 77,014 | 88,448 |
| Walls | 84,676 | 88,448 |
| No walls, +20 troops queued this bell | 97,014 | 88,448 |

Each is one engagement. The queued 20,000 milli-troops join after the same
clash, rather than changing its result. An initially empty garrison likewise
leaves the 100,000-milli-troop attacker untouched whether or not reinforcement
is queued, then ends with zero or 20,000 garrison respectively.

These results exercise the existing wall protection and delayed activation
rules. They are not a new balance choice or an end-to-end march provenance
test: arrival records are literal pre-state, not produced by Reveal/Gather.

## NFT resident authorization

Five direct-dispatch tests reach WideResidentAct -> WideGarrison through the
real policy, canonical-address, link, Core asset guard, generation and current
holder/session checks. Fixtures contain literal public identities and account
bytes. There is no NFT mint, transfer, account creation or signature operation.

- Current owner and valid resident session succeed; proof accounts are unchanged.
- Previous holder, stale generation, and old generation after buy-back refuse.
  The new current owner/current generation succeeds.
- Expired session, wrong session setter and stale session generation refuse.
- Unsigned actor, plain-wallet bypass, writable proof, wrong proof owner and
  wrong proof address refuse.
- Missing plugin header, thawed permanent freeze, wrong permanent-transfer
  authority, each mismatched link identity and a mismatched Citizen asset refuse.

Every refusal compares all supplied account bytes, lamports, owners and both
log collectors. No authorization defect was found in these cases.

## Pre-execution safety review

The existing `CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md` applies to the unchanged
Cargo 1.89.0 native aarch64 host graph: 170 packages, 18 build scripts and 12
proc-macro crates. No manifest, dependency, feature selection or Cargo
configuration changed. Root Cargo.lock SHA256 remains
`87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.
No new build-time entrypoint is introduced by these ordinary Rust test modules.

Exact runtime paths were read before execution:

- Existing literal fixture helpers, memory-backed AccountInfo, clock/log stubs,
  public Season PDA and with-seed address calculations.
- ArrivalDay/ClashInputs/Arrival byte codecs; actual Resolve's anchor/cache reads;
  wide build, shared clash kernel, apply, settle, step and receipt hashes.
- Resident policy/link/Citizen byte codecs and public resident tag/PDA derivation;
  `resident::start/check`, `resident_binding::authorize`, `resident_auth` and
  `resident_guard` byte validation; the existing staged Garrison handler.
- New atomicity tests use the same literal Garrison/Resolve paths, account/log
  snapshots and public receipt-chain hashing. They never restore refused state.

No private-key generation, private-key derivation or signing was executed.
No native-crypto tests, key-guard self-tests, fixture exporters, CI, real
transactions, SBF build or deployment ran. The synthetic signer flag and literal
beacon cache do not establish real signature or drand provenance. No browser or
Node suite was rerun because this slice changes no browser/Node source.

## Validation

Final aggregate: **16 passed, 0 failed, 171 filtered out**. This includes the
previous seven Garrison tests, two hostile-combat tests, five NFT tests and two
Resolve atomicity tests. The only compiler warning is the pre-existing unused
`Wide::at` helper. Rustfmt and `git diff --check` pass.

```sh
env -u WS19_GOLDEN_WRITE -u WYLLS_WIDE_ECONOMY_FIXTURES_DIR CARGO_BUILD_JOBS=2 \
  cargo +1.89.0 test --offline --locked -p permutation-frontier \
  --features wide-world-experimental --lib \
  map_growth_runtime_tests::wide_land::wide_garrison:: -- --test-threads=1
```

The existing experimental version, SBF exclusion, Season creation, departure
debit, automatic-write and legacy/wide boundary gates are untouched. Remaining
work includes independent Garrison replay, broader resolve/allocation failure
coverage and the already-gated complete wide-world lifecycle. This is a tested
host integration improvement, not production readiness or an infinite world.
