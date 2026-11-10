# Closed camp-v2 wire and runtime integration

The camp settlement entry now consumes an isolated 301-byte draft with exact
prefix `[0xFF, 0x43, 0x53, 2]`, followed by the existing transit slot, 32-byte
public commitment and 264-byte public ciphertext. `CS` and schema version 2
identify this private proposal; it does not allocate an instruction or reuse
an operation in the existing wide envelope. Current v1/v2 instruction tag
parsers, WideCommand, ResidentAct and the member settlement decoder refuse it.
The original member prefix `[0xDC, 0xFF, 1, 13]` and its payload are unchanged.

`expedition_settlement_ix::camp_v2` specifies exact 15/16-role layouts. The
unchanged member roles are followed by one distinct writable original Citizen.
Account count alone selects the current/PREV_HOME split; no split, outcome,
Works amount or retained proof is supplied by the caller. The runtime decoder
checks version, length, slot, required privileges and role aliases, then calls
the existing same-invocation anchor/seal proof and camp settlement. That
consumer still authenticates the actual camp winner and original Citizen,
checks Works addition, stages all effects and writes the existing v2 receipts.
Receipt schemas, domains and bytes have not changed.

`fclient::original_expedition_settlement_draft::CampDraft` reuses the existing
public-address derivation for member roles and accepts the full original
Citizen address as an explicit unauthenticated claim. It rejects zero/program
Citizen keys and every Citizen alias, retains legal payee privilege unions,
and emits only proposed bytes/roles. It has no Instruction, Transaction, send,
signing or sealing conversion. Admission and public dispatch remain false.

The continuous camp lifecycle now passes real encoded bytes through the
private decoder after actual departure, original combat, proof/Gather and wide
Resolve. It also checks generic dispatcher refusal, other-schema refusal,
malformed bytes, commitment/seal mismatch, wrong accounts, missing required
privileges, Citizen alias, replay and unchanged state on refusal. The existing
native current-owner/PREV_HOME camp writer test now passes these same bytes
for success, overflow and replay, including official ABI writeback. Initial
accounts remain synthetic; the immutable public proof fixtures are unchanged.

## Verification

Eleven selected exact tests passed with zero failures or ignored tests:

- ABI: `camp_schema_is_exact_and_disjoint_from_all_existing_instruction_parsers`
  and `camp_roles_require_distinct_citizen_for_exact_fifteen_or_sixteen_accounts`.
- fclient's `original_expedition_settlement_draft` target:
  `camp_draft_preserves_public_roles_and_uses_only_the_disjoint_camp_schema`,
  `camp_draft_refuses_every_citizen_alias_and_keeps_payee_privilege_union`,
  and existing `member_draft_cannot_claim_proof_or_public_admission`.
- Native `proc::wide::expedition_gather::exec::lifecycle_tests`:
  `contiguous_original_boundary_camp_loot_settlement`,
  `contiguous_departure_boundary_combat_and_stays_settlement`,
  `contiguous_departure_boundary_retreat_and_original_home_return`,
  `contiguous_original_departure_boundary_combat_and_free_city_capture`,
  `contiguous_original_boundary_capture_and_resident_home_return`.
- Native `proc::wide::expedition_return::proof::settlement::camp_v2_tests::runtime`:
  `camp_v2_actual_unsigned_writer_closes_bridge_and_chains_original_citizen`.

The five native lifecycle functions preserve the existing immutable trace/role
snapshot assertions. The native compile retained five existing dead-code
warnings. No immutable fixture, dependency, lock, workflow or gate changed.

ABI tests use its own manifest with `--lib --features world-index-experimental`;
fclient uses `frontier-node/Cargo.toml -p fclient --features wide-records-experimental
--test original_expedition_settlement_draft`; native tests use
`permutation-frontier/runtime-contract-tests/Cargo.toml -p
permutation-frontier-runtime-contract-tests --lib --features
public-proof-tests,system-cpi-tests` and the existing runtime-contract target
directory. Each invocation supplies the complete individual test name.

Selected exact native tests use installed Rust 1.95, cached offline locked
dependencies, `aarch64-apple-darwin`, two jobs, `CARGO_INCREMENTAL=0` and one
`--exact --test-threads=1` filter per invocation. No whole suite, key creation,
private-key derivation, signing, new sealing, chain, SBF, service or CI run is
part of this work. Public fixture verification/recovery remains the previously
authorized test path and is not production confidentiality evidence.

## Remaining limits

This closes the missing camp bytes-to-runtime path, not public gameplay.
Generic admission and all gameplay gates remain closed. No browser submission,
live RPC, transaction execution, deployment, reverse sealed movement or
unsupported bad-seal/nonmember settlement is implemented here. Original
Citizen/payee aliases remain deliberately unsupported. Host-native writeback
does not establish Solana VM rollback or measured SBF budgets.
