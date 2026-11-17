# Camp-v2 scoped readback

The existing private camp settlement emits PS2/148 and PSW1/25 with settlement byte 6 = 2. Previously the off-chain expedition reader decoded both only as member-v1 and rejected the camp result. The scoped reader now selects a distinct `CampSettlement(CampRecord)` variant, pairs the two v2 halves within the captured transaction, and rejects missing, repeated, mixed-version or mismatched halves. The member-v1 ABI decoder is unchanged and still refuses v2.

The wide index and keeper observer now recompute the Province chain using the selected version's body and operation domain. Camp records keep full original-host, destination and original Citizen identities. The original Holding/Citizen chains remain unverified observations; no balance, host, holding or gameplay duty is created from these receipts. Failed index batches remain atomic and latch their blocker. Previously blocked indexes are not silently repaired or reset.

Herald serializes the distinct `ORIGINAL_EXPEDITION_SETTLE_CAMP` and `WIDE_ORIGINAL_EXPEDITION_SETTLE_CAMP` names with the exact raw bytes and existing explicit unverified metadata. The browser expedition-history reader accepts only version 2 with exactly the Citizen flag, the camp operation domain, immutable-original-owner Citizen identity and correct links. It uses a separate page-local pairing class. Member-v1 labels, domains and failure behavior remain distinct. The existing original history sheet can render these rows without an action button or inferred Works balance.

## Validation

Eleven distinct exact Rust tests passed: six new camp readback tests and five existing v1/native-log regressions. Commands used cached Rust 1.95, `CARGO_INCREMENTAL=0`, `--offline --locked --target aarch64-apple-darwin -j 2`, and one `--exact --test-threads=1` filter per invocation. No entire Rust test suite ran.

- fclient `typed_camp_log`: two new tests for exact bytes, explicit version/Citizen, v2 chain recomputation, v1 refusal, mixed-version pairs, wrong scope, bad domains, orphans, duplicates and rolled-back transactions.
- findex `wide_camp_index`: two new in-memory tests for full raw storage, Province-only chain advance, malformed pair/chain refusal and whole-batch rollback.
- keeper `wide_camp_observer`: one new test for v2 chain observation, no invented host/holding, corruption refusal and retaining the prior chain.
- herald library `wide_read::camp_tests::camp_rows_keep_exact_version_citizen_and_unverified_metadata`: one new direct serialization test, without a server.
- Existing regressions: fclient `native_trace_preserves_scoped_bytes_and_old_reader_refusals` and `native_pairs_reject_orphans_duplicates_corruption_and_tag_swaps`; findex `native_trace_indexes_without_fabricating_original_holding_chains`; keeper `ordered_settlement_mixed_batch_is_atomic_and_no_fake_host`; herald `wide_read::expedition_tests::native_scoped_rows_preserve_identity_and_explicit_unverified_metadata`.

The exact browser test file passed 8/8 tests (three new camp tests, five existing regressions) with both unchanged guard preloads:

```sh
cd permutation-gateway
node --import ../scripts/ci/no-keys-guard.mjs \
  --import ./screens/codex/no-key-node.mjs \
  --test test/web-frontier-wide-expedition-history.test.mjs
```

All newly added camp fixtures are explicitly synthetic public receipt observations. They do not establish native reward execution. Existing original-boundary immutable logs and proof fixtures are unchanged. The original native camp execution evidence remains documented separately in `CODEX-MEMBER-CAMP-RUNTIME-20261109.md`.

## Limits

`EXPEDITION_ENABLED` and both resident/member `PUBLIC_DISPATCH_AVAILABLE` flags remain false. Camp settlement still has a private handler and no new public dispatch. Reverse sealed movement, bad-seal/nonmember forfeiture and roster/reward contracts, and deployable Solana-target integration remain outside this readback change. No keypairs were generated, no private-key derivation, signing or sealing was performed, and no services, chain, RPC, deployment or CI ran. Public PDA/with-seed address derivation was used for structural identity checks. Browser tests used an injected in-memory herald response and a DOM stub, not live visual verification.
