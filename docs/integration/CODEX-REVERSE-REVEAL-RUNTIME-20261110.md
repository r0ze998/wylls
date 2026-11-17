# Reverse Reveal: original destination producer, 2026-11-10

This change implements the **private** reverse Reveal producer for an original
host marching from a wide standing position to an original destination. It does
not enable a public instruction or claim a complete playable return lifecycle.

## State and wire

- `frontier-abi/src/world_index/expedition_reverse_reveal.rs` defines independent
  `PSRREVL1` command bytes. Existing `ExpeditionReveal::decode` rejects them.
- `permutation-frontier/src/proc/wide_expedition_reverse_reveal.rs` authenticates
  the original Holding, full original owner, current generation/issuance, reverse
  marker v2, external reverse record, explicit original destination, plaintext
  and commitment. It uses real clock/window/archive/latch/shield/fee checks.
- `wide_expedition_route::inspect_reverse` reuses the mixed-family canonical land
  reader, first-entered path order, movement/arrival-bell calculation and tower
  wear. Active or malformed wide structures retain the existing closed refusal.
- Admission calls the original `admit_arrival` against the **same four canonical
  original ArrivalSlots**, with strict full-host-to-original-`u64` conversion.
  The original short Citizen tag is used only by that existing shared quota;
  the full owner remains authenticated in the reverse record and manifest.
- Outputs are original ArrivalSlot **160 bytes** and ArrivalDay **96 bytes** at
  original addresses. Slot wear and fee evidence retain their original offsets;
  displacement preserves the previous slot's rent recipient. No second quota,
  parallel day, host alias, transit mutation, or Holding history rewrite occurs.
- Allocation uses real `init_with_seed`; insufficient funds, wrong shapes,
  aliases and borrow failures are checked before deterministic effects. Actual
  post-CPI owner, size and all three payer/day/slot balances are checked before
  copying either staged data buffer. CPI failures rely on transaction rollback.

`PSRREV1` receipts independently commit the complete ordered before/after raw
manifest, including account address/owner/absence/privileges/lamports/data, full
reverse identity, and unmodified history-chain bytes. Context includes program,
Season, full command, current timestamp and slot; output additionally commits
route, wear, slot choice, creation/displacement and exact prefund-adjusted rents.
Reveal modifies only short-header accounts and advances **no entity chain**.
The shared raw-manifest helper is also used by the separate reverse Gather
consumer under its distinct action domain. This receipt is execution evidence,
not an authorization token or proof of complete historical economic replay.

## Executed verification

All six tests below passed through individually selected `--exact` native tests
in `permutation-frontier/runtime-contract-tests`. Prefix:
`proc::wide::expedition_reverse_reveal::tests::`.

1. `stages_canonical_original_creation_without_new_seal_or_second_quota`
2. `actual_original_slot_displacement_and_day_write_preserve_every_other_account`
3. `commitment_window_latch_pair_quota_and_fee_refuse_before_writes`
4. `full_raw_manifest_commits_original_history_and_owner_beyond_short_tag`
5. `real_native_system_cpi_creates_original_day_and_slot_with_exact_prefunds`
6. `actual_reveal_output_flows_into_gather_creation_without_account_replacement`

Test 3 checks nine refusal variants and unchanged account snapshots. Test 4
changes original history bytes and then only the owner suffix beyond the shared
short tag, retaining a consistent reverse-marker pair; both full raw receipt
digests change. A held writable-target borrow refuses without partial writes.

Test 5 runs the official native System program via the existing scoped CPI
adapter, with prefunds 0, 17, and 1,000,000,000 lamports. It verifies allocation,
owner, exact data, exact debit/credit, immutable other accounts, and receipt
bytes after official caller writeback. The signer flags are literal fixture
privileges; PDA derivation authorizes addresses, not wallet signatures.

Test 6 begins with an **explicit literal prior origin-Settled reverse record**.
It executes actual Reveal creation, transfers the resulting runtime accounts
unchanged into reverse Gather after advancing only the test clock, then executes
actual original ClashInputs **1280-byte** creation and reverse Gathered stamping.
The original Holding, ArrivalDay, ArrivalSlot and other read-only accounts remain
identical. A repeated Gather has no CPI and identical account state. No account
data/owner/balance is replaced between these producer and consumer calls.

Configuration: Rust 1.95 direct aarch64 binaries, target
`aarch64-apple-darwin`, `CARGO_INCREMENTAL=0`, `-j2 --offline --locked`, features
`public-proof-tests,system-cpi-tests`, shared
`permutation-frontier/runtime-contract-tests/target`, `--test-threads=1`.

## Limits

The fixture uses fixed public plaintext/salt and an arbitrary invalid ciphertext
hash. Reveal checks commitment only; no valid seal, keypair, private derivation,
signature or `recover_key` operation is created or executed. The continuous test
does not execute origin settlement itself; that is a prior-state fixture.

These tests do not run an SBF VM, bank/chain transaction, authenticated wallet,
whole-transaction compute budget, Resolve combat, reverse terminal settlement,
or original-screen gameplay. Captured/previous-generation sources remain closed.
Public dispatch/gates, deployment, network publication and push are unchanged.
