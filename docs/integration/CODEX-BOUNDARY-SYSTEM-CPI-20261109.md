# Actual native System CPI departure, 2026-11-09

The legacy departure candidate now runs through real native System processing
inside the isolated unsigned runtime harness. Its wallet-to-holding escrow
transfer, rent shortfall transfer and Season-authorized AllocateWithSeed are
executed by official System program 4.2.2 through InvokeContext. The original
private `execute_depart` handler is unchanged. Public dispatch stays closed.

Three filtered functions passed, with multiple scenarios:
- Empty, short-prefunded and excess-prefunded bridge records are created with
  the correct owner, length and rent. Only the shortfall is charged; excess stays.
- Original troops retain their host identity and acquire the actual Spend
  operation. Escrow, payer and bridge balances conserve lamports; the original
  departure receipt is emitted. Replaying the departure refuses.
- Runtime signer/writable escalation, wrong PDA signer seeds, wrong derived
  target, insufficient funds and unauthorized caller debit refuse.
- The native adapter also refuses omitted CPI AccountInfos, spoofed key backing,
  a missing caller System account and invalid System owner/executable fixtures.
- A failed helper exposes no snapshots; original inputs stay unchanged.

The prior two actual settlement/runtime integrity tests also pass with the
updated locked dependency graph, including home/PREV_HOME credit, paired
receipts, exact diversions, retained-slot cleanup, closing and rent refunds.

No real transaction, cryptographic wallet signature, private key or keypair,
RPC, validator, SBF build, CI or deployment was used. Program-address derivation
is used for the existing Season PDA and seeded accounts. Existing public-fixture
symmetric recovery remains explicit in the proof tests.

Limits remain: unsafe native SDK aliasing contracts, a test-only synchronization
bridge rather than the SBF CPI syscall, fixture signer privileges, synthetic
initial state, disposable failure contexts rather than proven bank rollback,
and no transaction-wide compute accounting. This is not yet a playable release.
The two continuous producer/combat/settlement variants also passed; their exact
scope and remaining capture/UI limits are recorded in
`CODEX-BOUNDARY-LIFECYCLE-20261109.md`. Across the four disjoint final filters,
eight functions passed, including the constant-only closed-gate check.

Implementation and reproducible filters are in
`permutation-frontier/runtime-contract-tests/README.md` and
`SYSTEM-CPI-AUDIT.md`. Root/production manifests and lock are unchanged.
