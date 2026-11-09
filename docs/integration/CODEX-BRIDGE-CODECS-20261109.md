# Closed expedition and legacy-source codecs — 2026-11-09

Base: c65180623f9a079850c2d6e4df6821f7274b5948.
This increment provides two bounded experimental codecs. It does not emit live
records, write live bridge markers, change node acceptance, or open any gate.

## Bridge pair and one financial authority

expedition_bridge defines a canonical 96-byte embedded legacy marker and
304-byte external envelope with PSWLEXP1/version1. Full original identity,
legacy issuer/origin, timing, seal, original Holding and slot bind the pair.
The external record holds troop transit state and immutable rent recipient;
only the current Holding marker holds tip/fee/bond authority. Financial
projection reads those current flags, preventing a stale external copy from
repaying a bond already refunded on capture. A pure capture plan clears only
the marker bond and performs checked escrow subtraction; it requires no
external record and cannot block normal opponent capture. No plan pays or
mutates real accounts. Runtime atomicity/recovery remains a separate obligation.

## Legacy source receipt

legacy_source_event reserves experimental, unfinalized PS2 kind145 under the
integration allocation procedure after a repository-wide conflict scan. It
uses versioned Debit/Credit direction and an exact 240-byte record: PS2 header,
bridge version/direction, full original legacy source reference and canonical
address, unchanged 100-byte conquest receipt and legacy entity5 tail.
The 198-byte pre-tail body uses the existing PS2 next_head algorithm. It never
advances a legacy Holding with the incompatible PSW1 domain/entity.

Strict validation checks identity/world/family/address, canonical length,
reserved/version/direction/action and chain continuation. Target pairing
requires the same operation receipt and bell, including holding-keyed CAPTURE
and province-keyed DECLARE/LAPSE. Public WideRecord fields are reconstructed
and strictly decoded before use, preventing inconsistent body/tail claims.
This is structural pairing, not proof of authority, issuance, source evidence,
economic effects, record completeness or full history.

The 240-byte record is an explicit exception to the advisory 128-byte budget.
The program's 800-byte maximum can hold it, but the old WIDTHS_V2 table cannot
encode it. Any emitter must use this bounded writer; old strict PS2/fclient
readers reject unknown145. Reader updates and source-chain merging remain
required before acceptance/activation. No deployed semantic kind is reused. The same registry also reserves kind146
and DA6/DC10 for upcoming expedition handlers; those wire/receipt implementations
are not included in this checkpoint and remain unadmitted.

## Static review and selected execution

Separate independent reviews traced both complete test targets and all fixture
callees. Runtime paths are literal public identities, public address/hash
arithmetic, canonical byte codecs, bounded scalar state/financial arithmetic
and assertions. No private-key generation/derivation/signing, native-crypto
entrypoint, guard self-test, exporter, network or subprocess is reachable.
The new exports contain ordinary functions/types/standard derives and a size
assertion, with no constructor, initializer or new build hook. Concurrent ABI
family-validation/occupancy functions were also checked for compile-time
safety; these selected tests do not call the new runtime guard functions.

The prior root1.89 build/cache audit was reused under unchanged-cache
assumptions. Dependencies, manifests, lock and configuration did not change;
full cache rehash was not repeated. Non-login shell, offline/locked mode, two
jobs, existing native cache, no explicit --target, fixture-export variables
unset.

Final command passed:
cargo +1.89.0 test --offline --locked -p frontier-abi
--features world-index-experimental --test wide_expedition_bridge
--test wide_legacy_source_event -- --test-threads=1

- Bridge codec: 9 passed.
- Legacy source record: 4 passed.
- Total: 13 distinct final tests, zero filtered, zero failures on final run.

Verification history is not hidden: first compile failed on an incorrect
transit import path, before tests executed. After correction, bridge9 passed
and legacy3 passed with one negative CAPTURE fixture panic. The target encoder
already correctly rejected an in-disk CAPTURE key; the test was corrected to
assert that refusal and forged-record rejection instead of unwrapping a
nonexistent body. Validation was not loosened. Earlier source review also
corrected CAPTURE's 56-byte Holding key versus 50-byte Province key assumption.
The final complete 13-test run passed. Source/test rustfmt and git diff --check
passed; the unchanged preexisting module ordering/wrapping is not reformatted.

Broad suites, program handler runtime, SBF, CI, deployment and real transactions
were not run by this codec verification. Experimental account interlocks,
legacy-source handlers, boundary departure/arrival/return and node integration
remain separate reviewed/tested slices, with public gates closed throughout.

## Source SHA-256

- frontier-abi/src/world_index/expedition_bridge.rs: d9dc8163eb05435d445deb4209aa81fc51e2f16317bc0804d7a98fa8c83e2e00
- frontier-abi/tests/wide_expedition_bridge.rs: a17aa7ff4c7d49506243371ecaec92c24c6b9f84ef1d64211131a62763ed35b0
- frontier-abi/src/world_index/legacy_source_event.rs: 4f66f69b852a15e2e1acecac3bb2771068d82e1408f0a897aaba948d78f0cfb2
- frontier-abi/tests/wide_legacy_source_event.rs: 5faf784dce95b71e277d84ea94a9f483aa0a2c76c4f415a5a2f1be8ce7dc447c
- frontier-abi/src/world_index/mod.rs: 9bf4ecb48be0e4c672e4935dc8e2d9d8b6e6bf193581b9d348e5ac0bbc2e66fc
- workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md: 1ae24562d874fedd07f75c20b6754127ecf4440d2b02043ede398859c71d6ff9
