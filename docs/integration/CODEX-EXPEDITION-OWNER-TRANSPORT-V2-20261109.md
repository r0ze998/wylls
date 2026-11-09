# Expedition owner transport v2 runtime migration

Base reviewed local commit: `aebfb96c340e066468b52b52e77e7b7a399773fe`.
This report covers only `wide_expedition_exec.rs`, its exec/combat tests,
`wide_expedition_route.rs`, and its route tests. ABI transport changes are
separately owned and require independent review. No build, test, commit, push,
transaction, key generation, private derivation, signing or native-crypto
operation was performed for this migration. Installed rustfmt and static
diff/source inspection were used. These results are not an execution pass.

## Explicit version transition

- New departures produce only `OwnedBridgeTransit`, version 2, exactly 336
  bytes. Its original Citizen address occupies bytes 304..336.
- `player_start_as` authenticates the supplied Citizen; `ap::check_holding`
  matches its complete address against the original Holding's OWNER_CITIZEN.
  Only then is that address stored. The captor is never substituted later.
- Allocation, rent, plans and complete account snapshots use all 336 bytes.
  Origin settlement uses `settle_origin`, retaining the owner in the wrapper.
  Both receipt directions include the complete external data without slicing.
- Route inspection requires strict v2 decoding. Its old marker pairing uses
  only `common()`; the complete wrapper is not replaced by a serialized v1.
  The marker remains the original 96-byte v1 occupancy/financial authority.
- Ownerless 304-byte v1 external records are rejected. There is no promotion,
  owner reconstruction, short-tag inversion, reallocation, or recovery path in
  this change. Historical v1 reports remain historical, not rollout guidance.
- The original generation, captured issuer and Reveal lifecycle eligibility
  checks are unchanged. Routing remains read-only and does not authenticate a
  commitment or admit an arrival. Public expedition gates remain false; no
  dispatch, wide roster, economic or combat rule has been changed here.

## Prospective test coverage

The selected exec suite contains 14 tests plus its nested actual-combat test;
the route suite contains 11 tests. None was run in this migration.

New assertions cover authenticated departure owner preservation, refusal of a
different Holding owner, captured-origin owner preservation, origin/route v1
refusal, and captured-route read-only behavior. A manifest test changes each
of the 32 owner bytes in isolated fixture memory and checks both receipt
digests differ; it is a hashing test, not permission to rewrite provenance.
Route lifecycle cases retain Departed, Settled, DestroyedAtOrigin and Gathered;
the Gathered fixture now uses an explicit v2 arrival with zero tower wear.

The actual ResolveFromInputs survivor regression is retained. Its fixtures
still use STAMINA_CAP (120), actual minimum tip 2500, and scoring cursor 10.
No departure allocation CPI is exercised. Existing private departure borrow
tests refuse before any transfer/allocation CPI. Origin commit tests perform
only local fixture-account changes and existing receipt logging.

## Static call-path boundary

New paths add strict byte decoding, copies, length/rent arithmetic and the
pure owner-preserving origin transition. Marker pairing and legacy source
resolution remain the prior paths. New tests use literal public identities,
existing public PDA derivation, public hashing, test clock, account snapshots
and the previously reviewed combat kernels. No seal-opening, secret material,
signing stub, crypto override, guard self-test, oracle, SBF or CI was added.
The new ABI codec is still an independently reviewed dependency of these paths.

`CODEX-WIDE-PROGRAM-BUILD-AUDIT-20261109.md` was read. This change does not edit
manifests, lockfiles or configuration. Root Cargo.lock still hashes to
`87459163de25f9c13b7dbb84c281c4e1adc20d077a54164d04ca402d58067bc9`.
That prior build audit is reusable only if its toolchain, target, feature,
source/cache and environment assumptions remain true. This report does not
reauthorize or execute its build graph.

## Remaining integration limits

End-to-end Reveal, slot admission, wear, Gather, return/cleanup and paired
receipts are outside these five files and must be reviewed together before
activation. Pure codecs do not prove original issuance. Program ownership,
authenticated creation, retained full bytes and exact history are required.
Old markers deliberately do not contain or independently hash the new full
owner. Marker pairing alone must never be presented as owner provenance.

## Candidate SHA256

- exec: `9b666f64c63eb39c5c42c502d75c3b9de9b7d887d550d26b7c460d0a8638937e`
- exec tests: `e3e8f630628f6d4ff9470b9e87dbb74cfd377ab233b585a65d4a1974da5e8f57`
- combat tests: `3dec4a0b9ca4997a52fb6274066712994de97bc42b77741ecd6ba4ba750a1351`
- route: `093a6d9626cde161fa89af7e7aa4085bbf62e5f00defaac1ac6d06defb4bce44`
- route tests: `94ab1b19bc0f4e4178e69326c25967a6eb17e1c3ab5f83e70b1b41190b8ca39d`


## Integrator verification

The ABI is a new explicit wrapper, not a global version change. Owned bridge
v2 preserves the old96-byte marker and old304-byte BridgeTransit codec while
serializing336 bytes with immutable original owner. ExpeditionArrivalSlot keeps
288 bytes, explicitly uses slot-local version2, stores WORN_BPS at188..190 and
requires residual reserved bytes zero. Old v1 parsers reject new v2 records,
including zero-wear v2 slots. Typed mixed reads preserve each variant during
claim/settled rewrites. Numeric Season ID and producer history remain caller
authentication obligations, not properties proven by codec round trips.

First Gather transport applies existing structure::wear once and preserves
original DEP_MASS. Repeated same-destination transport is identical; alternate
destination refuses. The codec does not create WideArrival records or prove
first/repeat destroyed-arrival stamina equivalence. A runtime Gather must bind
the actual retained slot/history and produce identical complete arrival rows.

Independent review found and corrected an invalid comparison between arrival
slot dealt_bps and departure Hold dealt_bps. A real S1 faction2 regression
preserves legitimate Hold10500 versus Assault11025. The fixture now uses legal
march stamina74 and post-cost46. No damage or wear rule was altered.

Final selected runs after static review:
- ABI transport6, original expedition receipt5 and wire2:13 passed.
- Original-host exec15 (including actual ResolveFromInputs) and mixed route11:
  26 passed.
- Total39 selected tests, not a full repository suite.
- Default and wide-world-experimental,nft-experimental library compile checks
  passed. Existing unused Wide::at and six unconnected-route warnings remain.

The same offline/locked root1.89 graph, existing native target cache, two jobs,
non-login shell and serialized tests were used; exporters unset, no explicit
--target. No private-key generation/derivation/signing, native-crypto tests,
CPI, real transaction, SBF, CI or deployment occurred. Existing dependency cache
was not fully rehashed again. Manifests, lock and Cargo configuration are unchanged.

Full original Citizen attribution after capture is an intentional boundary
interpretation: the new wide route retains the departure owner rather than the
legacy Reveal implementation's current-holder quota tag. Original-only legacy
behavior is untouched. This is not a claim of byte-for-byte old quota parity.

Reveal/Gather/return candidates, operation receipts, node readers, public
activation and original-game UI integration are still separate pending work.
No ownerless v1 records are silently migrated. Pending14 UI/Herald files and
security-review metadata are untouched.

ABI reviewed hashes:
- frontier-abi/src/world_index/expedition_transport.rs: a8962036cfdf69eda718941187dd62bda89b789c432919f1be7f09eb1959ecee
- frontier-abi/tests/wide_expedition_transport.rs: 63c445e6f5b5d848146e48193322041e515fc0583d7183675eaf4007a09573a5
- frontier-abi/src/world_index/mod.rs: 669fcf22fb6913aec7aadc482971c39e5fa524ee3ce1678d208b99fc2e2775ae
