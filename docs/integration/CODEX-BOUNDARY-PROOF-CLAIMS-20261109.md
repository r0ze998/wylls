# Closed boundary proof and defence claims, 2026-11-09

Base: `cca16cd861fbdc436abfa78cc251b6475e6ad50a`.
This checkpoint binds actual wide-seal opening to original-host return staging
and adds actual private v2 defence claims. Public gameplay remains closed. It is
not a complete settlement, original-game browser lifecycle, or chain transaction.

## Actual changes

- Private `claim_expedition_defence` uses the strict original-to-wide v2 slot
  reader. The native v1 command still refuses v2 records. Shared existing refund,
  day allowance, per-call region cap, pool-rent floor and rounding semantics are
  retained. Actual preallocated slot/pool/claim balances and bytes are updated;
  only CLAIMED changes in the slot, preserving its original owner, wear and rent.
  A v2-only fallible borrow preflight prevents exclusive balance/data borrows
  from reaching inherited infallible view reads. No public wire/dispatcher added.
- A private return proof candidate authenticates the owned bridge and original
  marker, stored wide seal root, canonical destination, anchor/archive and exact
  reveal-close-plus-settlement grace. The actual opener binds full host, arrival
  bell and destination, then existing return staging validates full original
  Citizen, unique final-set membership, retained slot and capture history.
  It returns an opaque read-only observation with no effect/commit interface.
- The isolated wide proof target verifies the published Quicknet signature,
  recovers the existing symmetric key through real pairing/FO verification, and
  opens a deterministic 264-byte wide ciphertext with coordinates above i16.
  Existing 128-byte IBE bytes are retained; only a fixed wide body is constructed
  in memory. This reused public key/keystream is UNSAFE production sealing and
  gives no confidentiality or new timelock. No synthetic fixture is exported.

## Explicitly isolated test arithmetic

The empty `public-proof-tests` feature enables the existing real native arithmetic
only under `cfg(test)` on a non-Solana target. Ordinary linked host libraries,
including one built with that feature, still select failing host stubs. SBF and
combinations with native-crypto-tests/test-beacon/oracle have compile errors.
Those forbidden combinations were checked statically, not built or executed.

An immutable diagnostic constant uses the exact adapter-selection predicate.
Separate unit and linked-library tests check that selection, the production
Quicknet key hash and gameplay gates. The unit test also checks the actual private
EXPEDITION constant. DEPART, EXPEDITION and CONQUEST remain false. Existing native
flag behavior is unchanged, and native-crypto-tests was never selected.

Only the ordinary-host valid-public-signature refusal test is excluded under the
new feature: real decompression must accept a valid public signature. Malformed
point/input refusal assertions remain unchanged. Configuration evidence does not
run key guards, cryptography, accounts, dispatch or CPI. All test selection is
narrow; this feature is not permission to run the full suite.

## Verification actually run

Independent static path/dependency reviews preceded execution. Distinct selected
new/regression evidence in this checkpoint:

- Private v2 claims:13 passed. Covers exact six-slot refunds, shared native/v2 day
  allowance in both orders, caps/rent/zero payment, grace/lateness, malformed
  evidence, strict versions, overflows, borrow refusals and CLAIMED independence.
- Three individually audited native defence parity leaves:3 passed. Their log-only
  runtime stub rejects CPI. The broader defence suite was not selected.
- Actual return proof namespace:12 passed. Real public signature/FO/opening,
  timing/schedule/archive, changed roots, malformed seals, full identity/destination,
  original-owner/PREV_HOME history, final-set duplicate/nonmember/replay, claimed
  independence and inert stale preview are covered.
- Unit/linked-library configuration:2 passed, exactly one test per invocation.
- Isolated synthetic wide proof:1 passed; list and unrelated exact-filter modes
  correctly execute no proof. Total31 distinct tests above, not a full suite.

The previously audited expedition regression namespace also passed71 with the
proof feature off. Default and wide-world-experimental,nft-experimental library
checks passed. Unused private candidate warnings remain. Diff check passed.

A compile-only check first caught an absolute i64 fixture timestamp assigned to
resolved_ts. It was corrected to checked u32 seconds since season genesis, matching
actual Resolve, and independently reviewed before execution. No rule was changed.

Used Cargo/Rust1.89, non-login native host, offline/locked, two build jobs and the
existing cache. The baseline is CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md; no new
dependencies, build scripts or proc macros. Cache was not exhaustively rehashed.
Cargo.lock remains 87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9.
No fresh keypair, private signing key, signature, randomness, transaction, SBF,
exporter, CI or production gate activation. Public-fixture symmetric-key recovery
and deterministic memory-only synthetic bodies are explicit proof-test operations.

## Limits and next executable work

Return proof inputs are canonical prior-state fixtures, not outputs from actual
PostAnchor/ArchiveAnchors, Reveal/Gather/Resolve in a single replay. The signature
is actually verified separately and fixture clock/round is pinned. Anchor selection
trusts program-owned producer invariants. PostAnchor creation needs allocation CPI;
no allocation override or success-CPI stub was introduced. Resolved-account
survivors, stance and route history are trusted, not recomputed by the proof bridge.

Return currently performs no payment, claim, receipt, cleanup or account write.
Bad seals and nonmembers remain unsupported/refused. Future settlement must reread
and verify in the same call, execute escrow payments/diversion, settled masks,
retained-slot handling, original home/Reserve/PREV_HOME return, external rent and
paired mixed receipts atomically. A saved preview is not an authority to do so.

Claim successes use already allocated records. Missing claim with insufficient
payer fails before allocation; successful allocation/payment CPI is unexecuted.
Native defence regressions retain their historical fixture timing and are not
claims of producer provenance. Unrelated pending UI files and security metadata
remain unchanged. Original-game UI/keeper integration and actual chain execution
are still not demonstrated.
