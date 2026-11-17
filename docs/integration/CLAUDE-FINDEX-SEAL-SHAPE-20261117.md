# findex archive: a seal of the wrong type, or an unsealed segment before the last, is refused before any recovery write (2026-11-17)

**Branch:** `claude/findex-seal-shape-20261117`, one commit **on `b7ec5124`** (the structure unit, which is on `5de93797`; both unchanged). Adoption order: `5de93797` → `b7ec5124` → this. findex is unchanged in the aggregate since their base.

**Static change, NOT run:**
- no `cargo`, test or build;
- no real store, RPC, world or key;
- `142c1cdb` and `a99b961f` are not taken and not changed.

## The defect

**The parse:** `Manifest::from_json` read each segment's seal as `s.get("sha256").and_then(|x| x.as_str())`, so **any non-string** (a number, a bool, an object) silently became `None`, meaning "not sealed".

**For a sealed segment, that means:**
- **as the last segment:**
  - `open` treats it as the open segment (recovery `set_len`);
  - the next append writes frames **into it**, whose recorded hash is then lost;
  - the roll does not seal it again first.
- **before the last:** `verify` skips its hash check, so tampering is no longer caught.

**A related shape gap:** an unsealed segment before the last was accepted too.

## What the writer has always written (`git log -S`: `seal_open`, `"sha256": s.sha256` and `file_sha256` since `e8638677`, the archive's creation)

- **`sha256`:** `null` for the open segment, `hex::encode(sha256(file))` (64 lowercase hex) once sealed. The key is always written. Its absence is treated as before, as `null`.
- **Sealing:** every roll runs `seal_open` on the previous segment before pushing the next, so **every segment but the last is sealed**. The existing `appends_rolls_seals_and_verifies` asserts exactly that.
- **The last segment:** unsealed in every durable manifest the writer writes. **A sealed last one stays allowed:** the roll code itself handles it (`s.sha256.is_some()` rolls), and refusing it would be a new rule.

## The fix (`frontier-node/crates/findex/src/archive.rs`)

1. **`from_json`:** `sha256` absent or `null` gives `None`; a string gives `Some`; **any other type is refused**: "segment k sha256 is neither null nor a string: refused, nothing opened or changed".
2. **`check_structure`** (from `b7ec5124`, still before any recovery write): **a segment before the last without a `sha256` is refused.**
3. **Not changed:**
   - a string that is not the writer's hex is still taken as sealed. It is never truncated or appended to, and `verify` reports the mismatch, as before. It is not refused here (only the type is), since it changes nothing on open.
   - the codec tests' contract: damaged frames are found by the reads and `verify`, not at open.

**Normal states still open:** empty, rolled, an empty batch, group commit pending, and a crash (the earlier tests from `b7ec5124` and `5de93797` stay as they are).

## Regression (written, NOT run): one more case in `archive.rs` `mod tests`

**`a_seal_of_another_type_or_an_unsealed_middle_segment_is_refused_and_nothing_changes`.** It uses `b7ec5124`'s owned root (`segname_root`), `edit_manifest`, `case` and `snapshot`, starting from the writer's own 3-or-more-segment manifest.

**Refused, with the archive directory's entries, kinds, lengths and bytes unchanged:**
- a number or an object as a sealed segment's `sha256`;
- a bool as the open segment's;
- `null` on a middle segment;
- the key removed from a middle segment.

**Still opening and verifying 9:**
- the open segment without the key (as `null`);
- the writer's manifest itself.

**Running it needs its own pre-run evidence and approval** (`cargo test -p findex --lib archive::tests`, under the unchanged `floor21.sh` → `conquest-guard.sh`).

## Counter-review (static, once)

**What the writer could produce:**
- every manifest the writer writes passes: the key is always `null` or its hex string, and segments before the last are always sealed;
- an append that fails after `seal_open` but before the roll's file exists is never written: the callers poison.

**No existing test edits `sha256`** in a manifest (`git grep`). The tamper tests change segment files only.

**Order:** the type check runs during the parse and the shape check in `check_structure`; both come before `5de93797`'s file checks and before every recovery write.

**Not claimed:** race freedom, files swapped after open, a link at the store directory (as before).

## Hand-over (Lane D)

**Unit:** `claude/findex-seal-shape-20261117`, one commit on `b7ec5124`, all `100644`:
- `frontier-node/crates/findex/src/archive.rs` (M)
- `docs/integration/CLAUDE-FINDEX-SEAL-SHAPE-20261117.md` (A)

**Depends on** `b7ec5124` (and so on `5de93797`).

**Not run:** anything.
