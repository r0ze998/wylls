# WS04: held observations read from a findex store directory (2026-11-17)

**Branch:** `claude/ws04-store-dir-observation-20261117`, an integration branch from candidate d16048aa. It merges:
- `codex/ws04-read-observation-20261116` @ 7baa4d93 (4's reader);
- `claude/findex-observed-source-20261117` @ a99b961f (findex's `observed` epochs).

The two touch no common file; static checks found no secrets in either. The candidate, the canon, and both source branches are not changed.

**Written only:** no compile, test, syntax check, import, RPC, launch or world run.

## What was added

**`observation::read_store_observations(store_dir, after, limit)`:** the same `ws04-observation/0` page as `read_observations`, read from a findex store directory (`index.sqlite` and `archive/manifest.json`, findex `lib.rs` `Findex`), with diagnostics.

1. **Symbolic links** are refused at the directory, `index.sqlite`, `archive/` and the manifest. Checked before opening, and only as the last part of each path.
2. **Reads, in this order:**
   1. the manifest, as a plain file (≤ 16 MiB);
   2. the index page, in the one read-only transaction `read_observations` already uses. That transaction now also reads `MAX(tx.seq)` (`read_observations_with_last`; the public `read_observations` is unchanged);
   3. the manifest again.

   No `Findex::open` or `Archive::open`: those write and recover. Nothing is written.
3. **The manifest is validated by findex's own rules for `observed`** (a99b961f): version 1; `next_seq ≥ 1`; epochs strictly increasing, each `1 ≤ from_seq < next_seq`; `source` a string; `program_configured` / `commitment_requested` a string or null. Anything else refuses the whole read. `genesis_hash`, `endpoint` and other keys are not read.
4. **Per row, `archive_epoch: {epoch, why}`:**
   - `covered_by_epoch`: the epoch whose range covers the row's `archive_sequence`;
   - `before_first_epoch`: `epoch: null`;
   - `past_manifest_end`: `epoch: null`; the index row is at or past the durable manifest's `next_seq` (findex commits the index at once, the archive up to a second later);
   - `manifest_changed_during_read`: `epoch: null` for every row.
5. **The page's `store`:**
   - `same_directory` (the one directory the caller named);
   - `index_last_seq`;
   - `manifest_next_seq_before` / `_after`;
   - `manifest_stable`;
   - `generation`: `index_matches_manifest`, `index_ahead_of_manifest`, `index_behind_manifest` or `manifest_changed_during_read`;
   - `limits`.
6. **Holds:**
   - every hold is kept: the four per row, and the three per page;
   - two are added to the page: `store_pairing_is_not_a_snapshot_or_proof` and `archive_epoch_is_producer_setting_not_evidence`;
   - `basis` stays `unproven`, and `world` / `finality` / `complete` stay null.

## What it is not

- **Not proof that the index was built from this archive.** One directory named by a caller is not that proof, even though findex keeps `index.sqlite`'s `tx.seq` equal to the archive's sequence when it opens the store itself.
- **Not one snapshot:** the two files are read one after the other.
- **Not evidence:** an epoch is the producer's kind and settings (the program as configured, the commitment as requested; no endpoint, no genesis hash). It is not world, finality, record identity or authenticity evidence, and it lifts no hold.

## Compatibility

- **The plain reader's page is byte-for-byte as before:** `store` and `archive_epoch` are skipped when absent, and its three page holds are unchanged.
- **12's held report** (`heldFromWs04Observation`, on `claude/ws12-13-live-observation-20261116`) reads named fields only, keeps 4's reasons verbatim and requires the four per-row holds. The extra page holds and fields are ignored, not rejected.

**Tests (written, not run):** `tests/store_observation.rs`.
- epochs per row, with all holds kept;
- `past_manifest_end` and `index_ahead_of_manifest`;
- no epochs → `before_first_epoch`;
- a malformed manifest or epoch list, a missing manifest, or another version refuses the read;
- symbolic links refused, both a linked manifest and a linked store directory;
- nothing written (size, modification time and bytes);
- the plain reader's page unchanged.

**Not covered:** the manifest changing between its two reads, which would need a concurrent writer.

**Out of scope:** 13's branch, bcd29aac, a CLI or runtime wiring (the reader is still not on runexec's command line), and any admission rule.
