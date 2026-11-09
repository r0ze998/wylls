# Closed mixed legacy/wide route stage — 2026-11-09

Base: 6f534d8fb5f55d61042f70bc0edde21791a0bf30.
This private read-only stage is intended for boundary Reveal. It is not wired
to public admission, does not create arrivals or move troops, and opens no gate.

## Route contract

inspect authenticates the original legacy Holding, its embedded marker and
external bridge, the Season, committed wide plaintext shape and destination-
first Province accounts. Expected full keys are derived from exact WideTile
geometry before choosing account family/address. Ring<=128 requires original
v2 Province accounts; outer coordinates require canonical WideProvince data.
Wrong world, address/family, order, owner, writable inputs and extra accounts
refuse. The destination must be wide; no shadow-wide legacy account is accepted.

Original structure::watch_of reads actual standing structures, current Season
stances, recorded troop faction and current Holding expulsion flag. Tower wear
seconds and palisade blocking use the original rules; rough/road/mounted costs,
doctrine travel adjustment, arrival bell and wear BPS are retained. Wide
structures remain unsupported. Unknown/nonzero inactive fort records refuse;
canonical allzero inactive records pass, matching opening and CloseStructure.
The review corrected an initial forts_at-only check that ignored malformed
inactive records. Unrelated conquest/caravan state is not newly forbidden.

Durable marker pairing permits the same previous-generation and lifecycle
eligibility as original Reveal, including destroyed-at-origin and gathered
states. No invented current-generation requirement was added. The initial
review concern about those states was checked against original in_transit and
withdrawn. Running/Ended status and the Ended arrival cutoff remain.

## Selected verification

Independent static review cleared exactly nine tests plus the module-only
hookup. Tests cover literal128-to129 mixed accounts, route ordering/family,
world/direction/padding, tower/palisade effects, war/allied/expelled stances,
rough/road/mounted arithmetic, lifecycle and malformed fort refusal. Cavalry
parity uses the walk kernel, not a full mounted inspect fixture. These are
focused examples, not exhaustive geometry/state coverage.

All9 passed. The combined exact departure12 + route9 selection also passed21,
including actual original ResolveFromInputs survivor handoff. Default and
wide-world-experimental,nft-experimental library checks passed. The existing
unused Wide::at warning and six new unused-route warnings remain because the
candidate is deliberately not connected to live admission.

The previous root1.89 build/cache/startup audit was reused with unchanged lock,
manifests and configuration. Runtime closure is public PDA/address hashes,
literal accounts, borrowed reads, codecs, geometry and scalar game arithmetic.
No private key generation/derivation/signing, native crypto test, seal opening,
CPI, network, transaction, CI, SBF or deployment was executed. Offline/locked,
serialized tests, two jobs, existing native cache and no explicit --target.

## Integration still required

This result does not establish commitment/window/latch/shield/quota acceptance,
authenticated receipts, arrival creation, Gather/Resolve or return. It returns
route cost but does not yet carry tower wear through the wide arrival format.
WideArrivalSlot currently lacks the legacy wear field, and the bridge does not
retain the original full owner Citizen needed after capture. Versioned transport
work must preserve those facts rather than drop wear or attribute a victim to
the captor. No representation or game-rule shortcut is authorized here.
Separate return/reveal candidates remain unreviewed/uncommitted at this checkpoint.
Pending14 UI/Herald files and security-review metadata are untouched.

## Reviewed source SHA-256

- permutation-frontier/src/proc/wide.rs: b6c4acd6c7f9fb8ae9c8fb076f7e6cbbe6d95daf8f40dd34e758cf30ea5d497c
- permutation-frontier/src/proc/wide_expedition_route.rs: d3a7be44ec8cabfb739b93d70e2902409d7ce30f8738e3b2259ed9905938a094
- permutation-frontier/src/proc/wide_expedition_route_tests.rs: 25d946ebf354ace15a8971880b1d0d26d5b3d84d868b6d40b9db27bed9f38d6a
