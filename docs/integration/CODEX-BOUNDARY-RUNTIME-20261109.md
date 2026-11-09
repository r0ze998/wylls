# Actual native-runtime member settlement, 2026-11-09

Base: `44efd9ecf34fd65f65d18b6be28dea28b379b448`.
The prior checkpoint's positive close/writeback gap is now covered by two
narrow native SDK/runtime-contract tests. The tests passed using official
serialized accounts, not homemade AccountInfo memory prefixes or success stubs.

## Actual operations that ran

- Private same-call settlement reopened the real public-fixture-derived wide
  seal and applied original home return, escrow/marker cleanup, final-set settled
  bit, fee/bond/tip handling, external bridge close and immutable rent refund.
- Official writeback accepted the resulting owners, data lengths and balances;
  TransactionContext pop accepted lamport conservation.
- Captured generation returned whole troops to the authenticated live PREV_HOME,
  with the second original Holding chain link. Existing home remained unchanged.
- Repeated recipient roles shared the same runtime account. A small first leg
  diverted below rent, the following leg reached rent, and the last paid normally.
  Program-owned recipients diverted to original POOL_OWED under existing rules.
- Actual native DIVERT and paired PS2/PSW1 log bytes matched prepared records.
- A claimed v2 slot with an unlisted immutable rent recipient was retained and
  marked settled, preserving owner and wear. A second real close invocation used
  that successful output, returned its full rent and cleared data/owner/balance.
- Missing privilege, changed seal root and unsupported camp winner refused at
  the expected helper stage, without success records.

The second function checks actual official-runtime safeguards: no-op, duplicate
alias and owned mutation, conflicting duplicate privileges, readonly/external
writeback refusal, unbalanced lamports, helper-failure discard and growth limits.
Two functions passed; they contain multiple scenarios, not two real transactions.
A separate constant-only test also passed with all gameplay gates closed.

## Execution and isolation

`permutation-frontier/runtime-contract-tests` is independently locked. It compiles
unchanged program source plus a test-only child, using Rust1.95 and official
runtime4.2.2/SDK3.1.1. The root Rust1.89 manifests/lock and public dispatch remain
unchanged. No new package was installed or fetched. Cached dependency/build-script,
macro and startup review preceded compile and exact filtered execution. An initial
compile caught an overconstrained helper lifetime; separate buffer/slice-borrow
lifetimes fixed it without leaking or cloning AccountInfos past their scope.

The wrapper creates no Transaction, keypair or signature. Fixture signer bits
are unauthenticated. No new fixture RNG, private signing key, CPI, SBF, CI or
deployment occurred. Public Quicknet verification, FO symmetric-key recovery and
deterministic synthetic wide-body construction remain explicit. This is not a
production sealer. The limited standard build-helper filename randomness is
recorded in the harness README and never creates keys or test vectors.

## Exact limits

Native SDK unsafe pointer/aliasing contracts remain; official serialized backing
is operational runtime-contract evidence, not Rust soundness. Failed contexts are
discarded, not proven rolled back. No bank/signature validation, deployed SBF,
actual account creation/allocation CPI or historical producer chain is established.
Expected post-state comes from the same preparation routine; additional assertions
pin key ledger/closure effects, but this is not an independent complete rules proof.

Initial season/seed/anchor/arrival/resolution accounts are valid synthetic prior
state. Departure, Reveal, Gather, combat and capture were not connected into one
continuous replay here. That shortest coherent end-to-end path is the next focus,
followed by original UI/keeper integration. Camp Works, bad-seal/nonmember and
terminal cleanup remain separate gaps. No public gameplay gate is enabled and
this is not yet a playable unlimited-map release.

## Follow-on checkpoint

This report describes the original no-CPI settlement selection. The subsequent
`CODEX-BOUNDARY-SYSTEM-CPI-20261109.md` and
`CODEX-BOUNDARY-LIFECYCLE-20261109.md` record official native System processing
and continuous departure-to-stays/return paths. Their explicit limits replace
this report's then-pending CPI and shortest-path gaps, not its other limits.
The original two functions were rerun successfully on the updated isolated lock.
