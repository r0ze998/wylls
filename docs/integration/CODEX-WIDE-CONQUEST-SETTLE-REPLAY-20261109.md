# Detached wide siege refund replay — 2026-11-09

Base: 38922fd34495ad8e37d22e9180f7df17a372699b.
This increment independently checks one SettleSiege transition over complete
caller-supplied invocation evidence. It covers FAILED and season-end LAPSE, not
declaration, combat, capture or close. It is deliberately detached from verifier
season verdicts, Keeper acceptance and runtime activation.

## Evidence and result

The opt-in wide_conquest_settle module is exported under the existing
wide-economy-experimental feature. Context pins public program/Season identity,
exact DE FF01 op5 bytes, Clock timestamp and current rent minima. Before/after
manifests retain every wire role, address, owner, presence, lamports, data and
supplied role-level privileges. Ordered event bodies must describe exactly the
one invocation. stage_settle_siege calculates expected state/events;
verify_settle_siege first verifies the raw input commitment, then independently
stages and compares the complete supplied post-state and receipt bundle.

The result carries ConditionalProofLimits explicitly and
FULL_SEASON_REPLAY_SUPPORTED remains false. A successful check proves no
signature, snapshot/Clock/Rent provenance, authenticated invocation, prior
history, freshness or full-season result. Per-role flags are not authenticated
global message privileges. State aliases must agree, but their supplied flags
may differ; a real message adapter must reconstruct/globalize effective
privileges. No authentication boolean can upgrade this result.

Current feeds cannot alone fill these requirements: final transaction posts do
not supply full pre-state, read-only accounts, instruction-intermediate state or
authenticated Clock/Rent. Flattened logs also do not establish an invocation
bundle. This module does not hide those gaps or turn them into a pass.

## Independent effects

ABI codecs, canonical address/hash definitions, paired inventory validators and
receipt/chain formats are shared. Expected effects do not call the program
handler, WideConquest::settle or WideCaptureEscrow::refund.

The replay checks canonical Season/Province/table/Citizen/escrow identity,
Citizen v2 header, all table/prefix positions, exact optional source position,
current escrow rent floor and immutable funder. It independently clears the
selected prefix/table entry and only the selected wide inventory reservation,
refunds min(current Holding rent, escrow ledger), changes the isolated ledger,
and transfers lamports with alias propagation and checked arithmetic. No account
may close, resize or change owner. Unique-account balances must be conserved.

FAILED releases its owed obligation even if target ownership later changed.
LAPSE requires the original initial-Free-City mirror, ended status/time and the
fully resolved final bell. It authenticates the canonical original source;
missing, stale or nonlive source burns stake, while malformed/wrong-address/
wrong-owner data refuses. Live source uses independent verifier tiered economy
and capped gold credit. Numeric preflight is a conservative representability
boundary, not a claim to exactly reproduce runtime admission of malformed
numbers. The established wide layout-version adapter preserves unaffected data.

Receipt cardinality is exact: one ConquestSettled, followed by one
ConquestCredited iff a live original source was processed. A capped source still
emits credit even if added gold is zero. FAILED or absent/stale source has no
credit partner. Keys, bells, payloads, order, counts, digests and chain tails must
match. Only genuinely chained Province/source Holding headers are normalized;
private Citizen/table/escrow headers and all other bytes remain binding.

## Review and selected execution

Independent source review traced all fourteen new tests, fixture constructors,
ABI validation/address calls and independent holding replay. Test paths use
literal public identities, public SHA256/PDA calculations, canonical codecs,
fixture escrow reserve/captured Holding construction and scalar economy
arithmetic. No private-key generation/derivation/signing, native-crypto test,
key-guard self-test, exporter, network or external process is reached.

The existing node build audit and dependency-cache review were reused under
unchanged-cache assumptions. Cargo.lock remains
ba8f0e3f3a6a1451ed90ea6567e828232899d352eafec2eccc35edcad9291499.
No dependency, manifest, build script or configuration changed; full cached
archive rehashing was not repeated. Installed Rust/Cargo1.95.0, a non-login
shell, offline/locked mode, two jobs and the existing native target cache were
used, without explicit --target. Fixture-export variables were unset.

Passed: cargo +1.95.0 test --offline --locked -p verify
--features wide-economy-experimental --test wide_conquest_settle
-- --test-threads=1. All 14 selected tests passed, zero filtered, zero failures.

Coverage includes failed settlement after target change, live/cap-full source,
absent/stale/nonlive burn, malformed source, current rent/ledger/floor/overflow,
early/unresolved/CaptureDue refusal, receipt permutations, complete post-state
and private-header tampering, funder/source and signer/funder aliases, Citizen
v2 and input-commitment-first rejection. Elapsed-time/queued source economy is
not independently exercised by these fixtures; it relies on the established
holding replay rather than a new coverage claim.

Compile-only verify library checks passed for default features and combined
wide-economy-experimental,wide-world-experimental. Scoped rustfmt/diff checks
passed. Broad tests, SBF, CI, deployment and real transactions were not run.

After execution, scoped rustfmt sorted the feature-gated module declarations
in lib.rs; this formatting-only order change did not alter imports, features or
behavior. Tests were not repeated solely for declaration ordering.

Pre-execution review corrected the proposed feature selection: wide-world alone
would select zero of these tests. That command was never executed. Review also
caught and fixed a missing Citizen layout-version check before tests ran.

## Remaining integration

Keeper, VW/V0, full-source authentication and all public activation gates remain
unchanged. Declaration/capture/close replay and invocation-source evidence are
still outstanding. The approved legacy-origin boundary expedition is separate
work and does not change this wide-source-only replay's current admission. The
pending UI/Herald slice and security-review metadata remain untouched.

## Source SHA-256

- frontier-node/crates/verify/src/wide_conquest_settle.rs: dda612bd99657c2c8489524bec296867672f8c45f0f77563d35fa96cb8d2388e
- frontier-node/crates/verify/tests/wide_conquest_settle.rs: 1b5120cc04d5daac83fff3da64576645e1d9f810fc80184f628ec014790eb02c
- frontier-node/crates/verify/src/lib.rs: a08d1b3bba08fa737ae59369731520e09c442f436b038c7cc9322bdba60056bd
