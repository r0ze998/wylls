# Closed resolved-member settlement candidate, 2026-11-09

Base: `6e33ec87a657aef178cdd330633c35d6933a599e`.
This checkpoint implements the private same-call member settlement writer and
paired original/wide receipts. It does not enable public dispatch. Preparation,
codec and refusal tests run; successful runtime closing/writeback is NOT verified.

## Concrete implementation

- Private proof child repeats the real seal proof and original-owner return
  staging in the same invocation. No saved preview is accepted as authority.
- Complete ordered account snapshots validate privileges and storage aliases.
  Legitimate repeated payment recipients share one evolving balance. Distinct
  keys sharing backing, inconsistent same-key views and forbidden structural
  aliases refuse before effects.
- Existing tip, fee and bond legs are processed in that order, preserving each
  leg's rent-floor and program-owned-recipient diversion. Diverted lamports stay
  in the original Holding and increase POOL_OWED. Exact native DIVERT records,
  including intended recipient and reason, are prepared before effects. Zero
  amounts and self-diversion emit no DIVERT record.
- Original Holding escrow and marker, original home or captured matching-generation
  PREV_HOME credit, input settled mask and strict v2 retained arrival slot are
  staged. Original Citizen identity, wear and CLAIMED survive slot retention.
- Existing claim eligibility determines retention. Otherwise a slot closes only
  to a listed immutable rent recipient. The owned external bridge closes to its
  immutable recipient. No WideHolding or OPEN_TRANSITS update is invented.
- All records and output borrows are prepared before effects. The writer then
  shrinks/closes records, copies staged data/balances and emits DIVERT followed by
  paired settlement records. Real runtime failures require transaction rollback;
  host preparation tests do not prove that rollback or successful writeback.
- Camp-loot winners are explicitly refused before effects until original-Citizen
  Works and its complete chain handling exist. Bad seals/nonmembers remain refused.

## Paired record boundary

See CODEX-BOUNDARY-SETTLEMENT-RECEIPTS-20261109.md. Conflict-scanned provisional
PS2/148 and PSW1/25 have a bounded dedicated codec. Existing strict readers refuse
both; existing event kinds are unchanged. Both records share identity, operation
ID and complete manifest commitments. Original links identify issuer Holding and
actually changed original Province or PREV_HOME Holding; the wide link is only
its destination Province. No fictitious WideHolding link is emitted.

The source owner is already the original Citizen account address, not a wallet
from which another Citizen must be derived. Optional Citizen encoding now binds
that address directly, though preparation currently refuses this inactive option.
Public Record verification independently revalidates context, identity, checksum,
side shape and link count/entities; callers cannot bypass checks by constructing
public fields instead of decoding. Issuer aliases in optional targets refuse.

## Retained-slot close

The private strict-v2 close counterpart preserves the existing settled/claimed,
anchor grace, Ended+72h and tombstone policy. It authenticates canonical identity
and immutable rent recipient, probes fallible borrows before inherited infallible
views, and refuses cross-key shared backing. Native v1 close remains unchanged.

Only refusal tests execute. The proposed homemade positive AccountInfo backing
was not run: SDK resize/assign require runtime layout/ownership contracts and
cannot be certified merely from a writable leaked buffer. It is outside compiled
source. An isolated official-runtime serializer harness is being prepared and is
not part of this checkpoint. No success shim, signing or key generation is used.

## Tests and defects caught before runtime execution

Independent static source/dependency review preceded exact filtered runs:
- Paired codec8 passed: strict bytes/pairing/chain histories, manifests, payment
  conservation, forged public records, wrong context and optional identity aliases.
- Settlement11 passed:5 pure helpers plus6 real-public-proof preparation/refusal
  cases. Covers all member fates, captured PREV_HOME, absent/retained slots, ordered
  shared payees/diversions, camp/bad-seal/nonmember/privilege refusals, and a late
  borrow refusal before resize/payment. No positive settlement commit executes.
- Retained-slot close3 passed: identity/flags/balances, shared/exclusive borrows,
  and grace/end boundaries. A shared data guard prevents every close effect;
  exact error assertions distinguish intended refusal from that guard.

Original proof12, unit/linked-library configuration2 and v2 claims13 also passed
after integration. Default and wide/NFT library checks passed; unused private
candidate warnings remain. These49 selected tests are not a full suite or
transaction test. Review fixed diversion
recipient validation, repeated PREV_HOME alias acceptance, missing native DIVERT
records, incorrect wallet/Citizen interpretation, forged public-record bypass and
optional Citizen/issuer alias. Static review caught a Context reference mismatch;
compile-only checks caught an obsolete System-program path, now using existing
init::SYSTEM. No new
rule, dependency or private-key operation was needed.

Use of the public signature/IBE fixture and recovered symmetric key remains
explicitly synthetic: no new keys/signatures/randomness, no confidential sealing,
no historical producer provenance. Clock/anchor accounts are canonical fixtures,
not successful PostAnchor allocation output. Real cryptography is test-only;
normal linked libraries keep stubs, and all public gameplay gates remain false.

Root Cargo.lock remains
87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9.
Used existing audited native Cargo/Rust1.89 offline/locked cache with two jobs.
No SBF, CI, deployment, real transaction, native-crypto-tests or broad test suite.
The separate runtime harness has a different lock/toolchain and remains outside
this audit/execution claim. Protected pending UI files/review metadata unchanged.

## Still required

Positive official-runtime write/close/refund and failure validation; complete
producer-to-settlement replay; camp Works, bad-seal and nonmember settlement;
terminal original bridge cleanup; keeper/UI/strict reader integration and all
production release gates. This remains closed experimental code, not a playable
unlimited original-game release.
