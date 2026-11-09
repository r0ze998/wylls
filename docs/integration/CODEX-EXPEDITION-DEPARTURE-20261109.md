# Closed original-host expedition departure — 2026-11-09

Base: 1c3c76751624dcf5496bd7e59093e5f7aa0b9cfc.
This increment preserves an original legacy home and issued troop through
ordinary departure Spend and actual source combat, then moves only resolved
survivors into its paired wide transit. It is not a playable crossing release.
Public expedition and conquest lifecycle gates remain unconditionally false;
ResidentAct still rejects the new commands and default/SBF separation remains.

## Implemented boundary

Provisional unfinalized DA FF01 op6 ExpeditionDepart and DC FF01 op10
ExpeditionSettleOrigin have exact369/5-byte envelopes and9/6-account manifests.
They never reinterpret the old Depart/SettleDeparture commands. Existing ABI
reservations were checked and recorded in the preceding checkpoint. The issuer
Province may alias the writable standing/origin Province, with exact ordering
and observed privileges retained. Old readers reject the unknown records.

The original v2 Holding/Province, canonical identity, Citizen inventory slot,
current generation, actual issuance seq < HOST_SEQ, finality, capture lock,
existing four-slot occupancy and original Host::depart are authenticated before
staging. No new troop or source WideRoster is created. Original embedded marker
owns fee/bond/tip escrow; the external304-byte transit has no financial authority.
The same original slot reserves both representations.

Origin settlement requires the actual departed entry and resolved departure
bell. Host::march_values supplies survivor mass/stamina; one atomic copy frees
the original entry and advances the paired external transit. Replays refuse.
Capture-cleared marker flags are current authority and are preserved; this step
never refunds escrow or credits captor reserves. Previous-generation checks do
not use a new captor's reset issuance counter.

PS2 kind146 records continue original Citizen/Holding/Province chains, not
PSW1. Exact468/427-byte bodies fit the inspected800-byte buffer; the advisory
128-byte exception is explicit. Full ordered account snapshots bind aliases,
owners, privileges, lamports, absent/prefunded creation addresses and external
bytes. Input headers remain bound; only actual output chain headers normalize.
The new command codec is validated directly by the receipt digest.

Private origin commit acquires every mutable borrow before any live copy.
Departure prepares buffers, receipts and simultaneous mutable data/lamport
preflight before standard transfer/allocation CPI. Insufficient rent accounts
use only rent shortfall, not full rent. Successful departure CPI allocation is
NOT exercised by this harness; transaction rollback remains required for CPI
failure. There is no stub pretending that this execution succeeded.

## Actual source combat coverage

The nested combat_handoff test begins with the original issued sequence0 troop
and stages its ordinary Spend. It invokes actual ResolveFromInputs against an
opposing resident, using the real build_v2, clash kernel, write-back, pending
Spend settlement and conquest step. Only then does execute_origin transfer the
exact resulting survivor troops/stamina. It verifies casualties, original ID,
unchanged issuance, no payment and refusal/no-change on both replay attempts.
Disposable-copy diagnostics call the same pure stages but do not supply their
results to the actual handler. Survivor output is never injected in this case.

Departure bytes are installed in isolated fixture memory, not by successful
payment/allocation CPI. SeedCache/BellAnchor and fully gathered empty arrivals
are authenticated prior-state fixtures, not proof of PostSeed or Gather
provenance. Other focused tests deliberately isolate Host combat kernels with
a fixed valid combat outcome. This is host AccountInfo execution, not chain
transactions, browser gameplay, deployment or a whole crossing lifecycle.

## Static review and selected results

Independent reviews traced each selected test and imports through public
PDA/address/hash calculations, literal accounts, codecs, scalar game logic,
receipt generation, evidence parsing and the actual legacy clash closure.
No private-key generation, private derivation or signing is reached. No real
CPI, native-crypto test, oracle feature, fixture exporter, key-guard self-test,
external network/process or hidden test helper runs in the selected closure.
Departure success code exists behind the closed gate but was not executed.

The existing root1.89 build/startup/cache audit was reused under unchanged
Cargo.lock/manifests/configuration/environment. Full dependency cache rehash
was not repeated. Non-login shell, offline/locked mode, two jobs, existing
native target cache and no explicit --target were used; exporters unset.

Final selected checks:
- frontier-abi wide_expedition_event:5 passed.
- frontier-abi wide_expedition_ix:2 passed.
- permutation-frontier proc::wide::expedition_exec::tests:::12 passed,
  including the actual ResolveFromInputs handoff.
- Default permutation-frontier library compile-only check passed.
- Combined wide-world-experimental,nft-experimental library check passed.

These19 selected tests are not a complete repository suite. The pre-existing
unused Wide::at test-helper warning remains. No CI, SBF, signing, transaction
or deployment was run.

Execution history: ABI7 passed first. Initial program compile stopped before
runtime tests on a test import path; it was fixed and re-reviewed. A staging
fixture tip100 incorrectly violated the real2500 minimum, so its helper now
uses actual Season fields and exact borrow-refusal assertions replace generic
errors. Full Resolve then exposed impossible fixture stamina1000 and an
inconsistent scoring cursor0 versus resolved bell10. Fixtures were corrected
to actual stamina cap120 and score cursor10; production rules were not relaxed.
Final12 passed. A later doc-comment-only correction accurately names the nested
actual Resolve case without changing executed code or imports.

## Still closed / next work

Mixed-family route validation with legacy tower/palisade/stance/expulsion
semantics is a separate unreferenced candidate, not part of this checkpoint.
Authenticated boundary reveal/admission/gather, arrival and previous-home return,
terminal external cleanup, independent full receipt replay/readers, actual
allocation validation and original-game UI integration remain. No claim of
unbounded world, playable >128 or production readiness follows from these tests.
The separate pending14 UI/Herald files and node security-review metadata remain
untouched. Unrelated material, credentials and secrets are excluded.

## Reviewed source SHA-256

- frontier-abi/src/world_index/mod.rs: 92402660adac0ce5c2aad789e50b2f49c20b6cc3ad8010c4ce56d0056914396f
- frontier-abi/src/world_index/wide_ix.rs: 07dcbbb4ce5b820e64e8a0c9bd313310bb2e6208448ef53a6bccd93b22dd9396
- frontier-abi/src/world_index/expedition_event.rs: b0232cc1454367791c7b4cd47a71afa001557ea5a7803f244b4cd76d9dd0abbe
- frontier-abi/tests/wide_expedition_event.rs: 66813baba7d2773a0232991c4e99a3b41d2cdc934fdf6b948e6bd97c0d26ec81
- frontier-abi/tests/wide_expedition_ix.rs: 16fafe945c28cd37109c7c0528ecb07653cf9f88dc3230e116ec32b17e183e6d
- permutation-frontier/src/proc/wide.rs: c43e7199a2c5a28293543be0ba1f90b4cdd2114361b33e0043256926c87bbaee
- permutation-frontier/src/proc/wide_expedition_exec.rs: 88b247273e2d3e1d647edc93214553caa7a3a55c280860c5de93152a82a11852
- permutation-frontier/src/proc/wide_expedition_exec_tests.rs: bff9128194f729149cab973ee1f6aaa56c09306ee18a781780688d493c7d5abb
- permutation-frontier/src/proc/wide_expedition_combat_tests.rs: 00c2035108f4edd94d5e841b24420add696fced93e073fea742aba2d91f3d36c
