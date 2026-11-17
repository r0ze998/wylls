# findex archive: a manifest whose numbers contradict each other is refused before any recovery write (2026-11-17)

**Branch:** `claude/findex-manifest-structure-20261117`, **on `5de93797`** (the fixed segment-name unit, `claude/findex-segment-names-20261117`, unchanged). This is a follow-on: it needs that unit, and adds one commit on top. The aggregate is at `bb05d56a`, and its findex is the same as `5de93797`'s base.

**Static change, NOT run:**
- no `cargo`, test or build;
- no real store, RPC, world or key;
- `142c1cdb` (directory sync) and `a99b961f` (writer) are not taken, and nothing of them is changed.

## The defect

**Numbers taken by type alone:**
- `Manifest::from_json` took `segment_bytes`, `next_seq` and each segment's `first_seq`, `last_seq`, `records` and `bytes` as **any u64**.
- `Archive::open` then **writes by them, before anything else checks them:**
  - **the open segment** is cut to its `bytes` (`set_len`);
  - **unnamed segments** are removed;
  - **the manifest** is rewritten.

**`verify()` is not a defence:** it is a separate call after open.

**What a contradicting manifest did:**
- **`records > 0` with `bytes` 0 (or fewer bytes than the records' frame heads):** truncated the open segment's **named, good frames** at open.
- **A gap, overlap or wrong `next_seq`:** a later append numbers records against the wrong next sequence, so there are duplicate or skipped sequences in the archive.

## What the writer always writes (checked first, so nothing normal is refused)

| Writer step (`archive.rs`) | What it leaves |
|---|---|
| a new archive | no segment, `next_seq` 1, `segment_bytes` = `segment_bytes.max(1)` |
| a roll | a new segment with `first_seq` = the next sequence, `last_seq` = `first_seq - 1`, `records` 0, `bytes` 0. Its first frame follows in the same step, before any manifest write. |
| each frame | `bytes += frame length` (head 12 B + payload), `records += 1`, `last_seq = seq`, `next_seq += 1` |
| removal | **none**: segments are only appended (`push`), so the first segment starts at sequence 1 |
| an empty batch, group commit pending, a crash | the durable manifest is the last committed one, which is consistent. The open recovery drops what it does not name. |

## The fix (`frontier-node/crates/findex/src/archive.rs`)

**`check_structure`, called in `Manifest::from_json`,** so before `open` writes anything. It refuses, with "refused, nothing opened or changed":
- `segment_bytes` 0;
- a segment not starting at 1 (the first) or right after the previous one's last;
- `records` ≠ `last_seq - first_seq + 1`, computed as `first_seq + records == last_seq + 1` with checked addition, so an overflow is refused. An empty segment (`records` 0, `last = first - 1`) is allowed, as a roll creates it.
- `records` 0 with `bytes` > 0, or `records` > 0 with `bytes` 0, or fewer `bytes` than 12 per record (checked multiplication);
- `next_seq` ≠ one past the last segment (1 with none).

**Not done (deliberately):**
- **No frames are read at open.** findex's own codec tests damage frames in the open segment and expect `open` to succeed and the **reads**/`verify` to find the damage (`tests/store_codec.rs` `:240-280`). Reading frames at open would change that contract.
- The checks are on the manifest's numbers only. **Not checked:** a `bytes` count that is consistent but wrong (for example short by part of a frame).
- No new rule about sealing (which segments carry `sha256`).

**Compatibility:**
- **findex's tests change** a segment's `bytes` only together with a matching frame (`store_codec.rs` `:291`, 1 record and `bytes` = the frame's length), so they still pass the check.
- **Others:** the real manifests in the other tests are the writer's own.
- **The segment-name unit's duplicate case** is refused by the name check first, as before.

## Regression (written, NOT run): two more cases in `archive.rs` `mod tests`

**How the fixtures are made:** they reuse the segment-name unit's `segname_root` (a new root via `create_dir`, removed only by its owner, also on unwind) and `snapshot`. Each case writes its manifest from a saved copy of the writer's own.

| Case | What it checks |
|---|---|
| `every_state_the_writer_leaves_still_opens` | an empty archive; one rolled into 3 or more segments plus an empty batch; a pending group commit dropped ("crash"). Each reopens; the last verifies 9 with `next_seq` 10. |
| `a_manifest_whose_numbers_contradict_each_other_is_refused_and_nothing_changes` | 12 edits: records without bytes (the open segment), bytes without records, fewer bytes than frame heads, sequence 0, a range longer than its records, a range turned round, a gap, an overlap, `next_seq` behind, `next_seq` ahead, `segment_bytes` 0, an overflowing range. Each is refused, and the archive directory's entries, kinds, lengths and bytes are unchanged (no truncation, removal or rewrite). The writer's manifest put back opens and verifies 9. |

**Running them needs its own pre-run evidence and approval** (`cargo test -p findex --lib archive::tests`, under the unchanged `floor21.sh` → `conquest-guard.sh`).

## Counter-review (static, once)

**Every writer state:**
- **The archive's own writes:** open after a validated parse, a roll, frames, an empty batch, a commit. Each keeps the five rules, because each step updates the numbers together.
- **An append that fails part-way** leaves a consistent in-memory manifest (a roll's empty segment is allowed) and is not written: the callers poison on the error.

**Arithmetic:** checked add and multiply; nothing subtracts, so there is no underflow.

**Order:**
- `from_json` runs before the file-type and link checks and before every recovery write (`5de93797`'s checks are unchanged).
- A refused manifest leaves the archive byte for byte as it was.

**Not claimed:**
- race freedom (TOCTOU), a file swapped after open, and the store directory being a link (as in `5de93797`);
- that the consistent numbers match the files: that is still what reads and `verify` check.

## Hand-over (Lane D)

**Unit:** `claude/findex-manifest-structure-20261117`, one commit on `5de93797`, all `100644`:
- `frontier-node/crates/findex/src/archive.rs` (M)
- `docs/integration/CLAUDE-FINDEX-MANIFEST-STRUCTURE-20261117.md` (A)

**Depends on** `5de93797` (it uses that unit's test helpers and sits after its checks). Adopt after it, or not at all.

**Not run:** anything.
