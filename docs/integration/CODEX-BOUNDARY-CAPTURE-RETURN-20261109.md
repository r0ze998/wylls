# Continuous boundary capture and original-reserve return, 2026-11-09

Continues `d76e94cf4eef4bd97b3a7c5efd56e1739564be13` and the isolated official
native System harness documented in `CODEX-BOUNDARY-SYSTEM-CPI-20261109.md`.
This is a closed candidate, with public expedition/conquest/departure gates
unchanged and no new instruction dispatcher.

## Executed continuity

The original ring128 Citizen, Holding and issued host follow the actual
private departure, original combat Resolve, origin settlement, ring129 Reveal,
Gather, wide combat Resolve and proof-bound stay settlement from the preceding
checkpoint. The new capture continuation then performs:

1. Actual catch-up Resolve for every older destination bell before declaration.
2. Authenticated initial-Free-City siege declaration by the same arrived host.
   Original source stock pays the actual stake and arms. Official native System
   transfers and AllocateWithSeed create the conquest table and capture escrow.
3. Every actual conquest Resolve bell through the required 36-bell siege.
   The combat model supplies the reports and writes CaptureDue and the mirror;
   neither is inserted by the test.
4. Actual SettleCapture with official System AllocateWithSeed for the fresh wide
   Holding. The original home stays in Citizen slot1; the captured holding binds
   slot2. Original-source debit and stake-credit receipts continue its PS2 chain.
   Repeated capture refuses.

A fourth lifecycle scenario continues from that exact captured world:

5. A new private original-origin resident Dissolve handler authenticates the
   wallet/session, canonical original source, current issued generation, source
   capture lock, inventory binding, embedded transit/bridge lock and full paired
   WideRoster identity. It stages a pending Leave with the deployed bucket and
   holding-touch rules.
6. The actual wide conquest Resolve processes that Leave at its bell and leaves
   a Departed row with the real survivors.
7. A new private resident-return handler rechecks the source and paired row,
   credits `survivor_milli / 1000` whole troops to the original Holding reserve,
   frees the row and releases the roster reference once. The source HOST_SEQ
   remains 1, so the first issued host (sequence0) is not reissued. The original
   home Province, captured Holding and Citizen inventory are preserved.

This return is the deployed Dissolve-to-reserve rule extended to an original
host standing wide. A reverse sealed march back across the map is not added.
Previous captured/refounded source generations and stranded cleanup are refused
by this candidate; they are not redirected to a captor or treated as tested.

Every successful intermediate World account comes exclusively from the previous
successful native runtime output. Each call checks lamport conservation. The
capture and return scenarios use no fabricated siege progress, capture mirror,
arrival fate, prepared authorization, or manually inserted returning host.
Adversarial mutations are confined to separately rejected copies and never fed
back into the successful continuity.

## Paired resident receipts

`frontier-abi/src/world_index/expedition_resident_event.rs` defines dedicated,
provisional PS2/149 and PSW1/26 records. They bind the full original host, original
Citizen, canonical source Holding, wide standing province, ordered account
manifests, permissions, owners, balances, clock, command and exact effects.
Dissolve advances the original Citizen/Holding chains and wide Province chain.
Return advances the original Holding and wide Province chains. The shared
operation digest pairs them; no wide-Holding chain is written into legacy data.

The native scenario decodes both pairs, compares their identity and action,
verifies every link from the actual prior account headers and compares the new
heads with the actual output accounts. Existing generic readers are not extended
to these provisional kinds. A receipt digest is not proof of authorization or
historical state provenance.

## Regression discovered and fixed

The first capture run exposed a real admission mismatch: at current bell14,
ordinary `resident_ok` allowed a declaration with destination cursor13. Its
new declaration_bell14 sidecar then made the strict resolver reject required
historical Resolve13. Declaration now requires all earlier bells resolved
(`RESOLVED_NEXT >= current bell`) before any write or CPI. The model's strict
future-declaration refusal remains unchanged. The happy path uses actual
catch-up Resolve before declaring rather than rewriting the cursor.

A separate native regression covers both wide and original source families,
refusing lagged cursors before any account, lamport, chain, log or CPI effect and
accepting the current cursor. Refusal callbacks deliberately permit official
writeback afterward so a partial mutation cannot be hidden by context disposal.

## Verification and limits

Final verification passed 11 native test functions across five disjoint,
serial exact-module selections: lifecycle4, cursor regression1, System CPI3,
previous settlement regression2 and closed-gate configuration1. All nine pure
resident-receipt ABI tests also passed. Three pre-existing dead-code warnings
remain. The broad library/repository suite was not run.

The exact native lifecycle selections are:

- `contiguous_departure_boundary_combat_and_stays_settlement`
- `contiguous_departure_boundary_retreat_and_original_home_return`
- `contiguous_original_departure_boundary_combat_and_free_city_capture`
- `contiguous_original_boundary_capture_and_resident_home_return`

The resident-return test also rejects missing signer, readonly source, early
return before Leave and before Resolve, repeated Dissolve/Return, stale
source generation, source capture lock, reserve overflow, every nonzero raw Leave
payload field and a bound RetireHost marker. The generic Entry decoder omits
those raw fields; both the candidate and dedicated codec explicitly refuse
them so a redirect cannot silently become original-source credit. Those predictable refusals then permit official writeback and compare every
output account with the input, with no logs or CPI. A partial write cannot be
hidden by discarding the context. This still does not establish bank rollback.

Initial season/join/founding/muster/opening and beacon account provenance remain
synthetic. Source stock and caps are synthetic initial economic state, not a
claim that these balances were historically accrued. Future public beacon
inputs are declared before departure; their producers are not replayed. The
existing public vector is hash-pinned and its Quicknet verification and allowed
symmetric-key recovery remain the only proof operations. No new keypair,
signature, random crypto fixture, Transaction, RPC, SBF or deployment is used.

Official native System execution is not the SBF CPI syscall or a signed bank
transaction. Signer privileges are fixture flags, and transaction-wide compute
budget, rollback and Rust aliasing soundness are not established. The original
UI, keeper send path, verifier/replay integration, public activation and a full
season replay remain unfinished. CI is intentionally skipped. No private prize
information or secrets are included.

## Reproduction

Use installed Rust1.95 with cached dependencies, offline/locked mode and the
same clean tool environment described in the preceding System-CPI report.
Native tests run through `permutation-frontier/runtime-contract-tests/Cargo.toml`
with package `permutation-frontier-runtime-contract-tests`, `--lib`, features
`public-proof-tests,system-cpi-tests`, target `aarch64-apple-darwin` and target
directory `permutation-frontier/runtime-contract-tests/target`. Run these five
filters separately with `-- --test-threads=1`:

- `proc::wide::expedition_gather::exec::lifecycle_tests::`
- `proc::wide::conquest_exec::cursor_runtime_tests::`
- `proc::wide::expedition_exec::tests::system_cpi_tests::`
- `proc::wide::expedition_return::proof::settlement::runtime_contract_tests::`
- `proc::wide::public_proof_config_tests::`

The pure ABI selection uses `frontier-abi/Cargo.toml`, package `frontier-abi`,
`--lib --features world-index-experimental` and filter
`world_index::expedition_resident_event::tests::`, with the same target/cache
and offline/locked settings. Cargo does not accept feature selection for that
non-member dependency from the isolated runtime workspace. No lockfile changed.
