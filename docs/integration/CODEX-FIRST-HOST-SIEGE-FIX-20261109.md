# First issued host siege correction — 2026-11-09

Base: 4897d2c80e15ce4bad91289bad7a5cd94ac152f8.

## Defect and correction

Both legacy host::muster and wide::muster_as issue the current H::HOST_SEQ,
then checked-add one. The counter is the NEXT unissued sequence. The first
legitimate host is sequence zero, and all issued sequences are strictly below
the stored counter.

The gated wide declaration handler incorrectly rejected sequence zero while
accepting a sequence equal to the counter. Its original fixture also encoded
seq1/count1, an unissued host. Earlier passing handler tests therefore did not
validate the issuance boundary correctly. This increment corrects that defect,
not a new game rule: reject seq >= HOST_SEQ, retaining full-reference identity,
canonical source, generation and roster/entry/lead checks.

Base declaration and continuous lifecycle fixtures now use first issued
seq0/count1. The declaration receipt evidence follows that exact host. A new
six-case regression checks (sequence, next-unissued counter):

- 0/0 refused; 0/1 accepted.
- 1/1 refused; 1/2 accepted.
- MAX-1/MAX accepted; MAX/MAX refused.

Each case updates the full roster reference and matching entry alias, validates
the pairing, calls the actual private authenticated handler, and checks that
successful declaration leaves HOST_SEQ unchanged. Refusals preserve all account
bytes and balances. The three continuous successful scenarios now exercise the
first issued host through actual combat, capture and terminal cleanup.

## Review and verification

Independent source review checked both Muster implementations, the final strict
predicate, complete changed fixture paths and the new regression closure.
No new key operation, CPI, network, exporter or subprocess path was introduced.
The separately reviewed additive expedition identity module was present in the
working tree during compilation; it has only ordinary types/functions/derives,
no constructor or build hook, and no runtime call from these conquest tests.

With installed Rust/Cargo1.89.0, offline/locked mode, non-login shell, two jobs,
existing native cache and no explicit --target, these serialized exact filters
passed under permutation-frontier --features wide-world-experimental --lib:

- proc::wide::conquest_exec::tests:: — 7 passed.
- proc::wide::conquest_settle_exec::tests:: — 18 passed.

Total 25 selected tests passed, zero failures. This adds one test function with
six boundary cases; the other 24 were rerun. Compile-only wide program library
check also passed. Scoped rustfmt and diff checks passed. Existing Wide::at
unused-helper warning remains. Prior static build audit is reused under the
unchanged dependency/cache assumption, not a fresh archive certification.

No public lifecycle gate, family admission, economic rule, legacy-only combat,
SBF, automatic-send or security review control changed. No real transaction,
private-key generation/derivation/signing, native-crypto test, CI or deployment
ran. Existing host-test limitations, including fixture beacon/terminal evidence
and unexpected-CPI transaction rollback, still apply.

## Source SHA-256

- permutation-frontier/src/proc/wide_conquest_exec.rs: 5c3ed23df75bdc64457fb658cee2abca752e28b84eb30dfde9151eba74977b03
- permutation-frontier/src/proc/wide_conquest_exec_tests.rs: 9f725a5d0f9bde32191398b01643f870a350b1915eb7206ce9f5b2d7418a3c93
- permutation-frontier/src/proc/wide_conquest_lifecycle_tests.rs: e30dfde8439440ca09e88a0ff023dbad7cd11691844b8fed709b4ea5afa3c82f
