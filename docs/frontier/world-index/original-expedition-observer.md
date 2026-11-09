# Scoped original-expedition observation

The keeper's explicit `WideObserver::new_with_expedition` mode consumes the
Season-scoped typed decoder. Generic `new`, generic transaction observation,
and direct `WideDiscovery::apply` retain their fail-closed boundaries.
`Keeper::enable_wide_observation` selects the scoped observer; it does not
change the legacy feed guard, write gate, duty planner, signer, or dispatcher.

## Receipt lanes

- PS2/146 Depart and SettleOrigin retain exact original identities. Original
  account-chain continuity and source authenticity remain unverified.
- PS2/147 Reveal and Gather are zero-link producer commitments. They do not
  advance a chain or populate wide arrival, input, holding, or host discovery.
- PS2/148 and PSW1/25 must form a canonical same-transaction settlement pair.
  Only the actual PSW1 Province link advances the observed wide chain.
- PS2/149 and PSW1/26 retain the existing canonical resident-pair checks and
  latest exact read selection. A Return receipt is not proven completion.
- PS2/145 and lifecycle PSW1/18–24 use the scoped decoder's structural operation
  pairing. Declaration18 always requires its source. Canonical target-only
  LAPSE21/action4 and CAPTURE22/action5 are accepted because native settlement
  deliberately omits a source-credit receipt when that source is absent or
  stale. Any source145/19/23 actually observed still requires its matching
  target; duplicate or conflicting operations are refused. Absence of a source
  receipt neither invents a source credit nor proves why it was absent.
  Lifecycle receipts remain commitment observations outside discovery.
  Capture does not become an ordinary Resolve or infer ownership or host state.
  Structural pairing does not authenticate source membership in an operation's
  account manifest, replay economics, or prove conservation.
- PSWC checks its exact Season and invoking program. This Citizen sidecar has
  no Province or Holding chain and never creates either identity in discovery.

All lanes report source authentication, complete history, semantic replay,
completion, dispatch availability and automatic writes as unestablished or
unavailable. The latest identity reference can be a holding for PS2/145, a host
for a transport receipt, or absent for a Gather; it is never a short host alias.

## Ordering and bounds

A transaction is decoded and paired before application. Records are processed
in their original log order on a bounded staged observer copy. This preserves
wide chain continuity when ordinary, settlement, resident and lifecycle records
share a Province inside one transaction. Ordinary discovery bodies are applied
once at the transaction's source sequence. Receipt-only lanes never synthesize
ordinary discovery events. Any late chain, scope, shape or state-cap refusal
discards every staged head, receipt, model change and successful-record counter.
The permanent refusal remains visible.

The existing body-count and aggregate-byte limits cover the entire mixed batch.
Dedicated receipt bodies use their bounded codec ceiling; ordinary PSW1 bodies
also retain the generic per-body limit. Chain keys remain capped. Retention is
one latest expedition receipt and one latest lifecycle/sidecar receipt, not an
unbounded history. Resident transaction counts advance once even if one
transaction contains multiple resident pairs. The whole-transaction replay
fingerprint window remains the authority for exact duplicate no-ops and sticky
conflicting or forgotten replay refusals.

## Verification boundary

`keeper/tests/wide_expedition_observer.rs` contains isolated public-identity,
byte-fixture tests for ordered mixed settlement, atomic late failure, source
146 and producer147 identity handling, zero-link behavior, input caps, generic
refusal, and observation-only lifecycle/PSWC scope. These fixtures establish
reader behavior, not native execution or authenticated live-chain parity.
The same test binary imports the immutable, checksum-pinned native fixture
`fclient/tests/fixtures/original_boundary_v1.bin` through its audited reader.
Its 51 supplied transactions and 56 records traverse original departure,
Reveal/Gather, paired settlement, declaration and capture, then resident
Dissolve/Return. The observer checks continued real wide chains, including the
capture's genuine wide Holding link, without creating fake discovery holdings.
This is offline fixture replay; it does not execute a transaction or authenticate
a live source. These seven observer tests passed on native Rust 1.95 with
locked offline dependencies. The 16 existing `wide_expedition` and 14 existing
`wide_discovery` regressions also passed in a final rerun of precisely these
three audited integration binaries after the target-only decoder correction:
37 distinct keeper tests passed total. All runs used the native
`aarch64-apple-darwin` target, `CARGO_INCREMENTAL=0`, two build jobs and serialized
Cargo execution with disk checks. No broad suite, SBF, live RPC, transaction
execution, deployment or signing was run for this observer validation. Fixture
coverage does not prove production readiness.

A further exact observer regression covers both canonical target-only forms,
continued actual wide chain links, no fabricated source or ownership/completion,
and atomic refusal of an orphan source mixed after a valid target. This seventh
observer test passed in the final 37-test checkpoint above.
