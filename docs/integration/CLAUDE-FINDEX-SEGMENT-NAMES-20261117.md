# findex archive: a manifest's segment names are checked before the open writes anything (2026-11-17)

**Branch:** `claude/findex-segment-names-20261117`, on the aggregate `claude/aggregate-approved-20261117` at `c7c1b1c5`. It is independent of the held directory-sync unit (`142c1cdb`): this branch does not contain that change.

**Static change, NOT run:**
- no `cargo`, test or build;
- no real store, RPC, world or key;
- the unadopted writer `a99b961f` is not taken.

## The defect

**The path:**
- `Manifest::from_json` took each `segments[].name` as **any string**.
- `Archive::open` then joined it to the archive directory and, **before any check of it, wrote through it:**
  - **the open (last, unsealed) segment:** `metadata(dir.join(name))`, then `OpenOptions::write().open(..).set_len(manifest_bytes)` when the file is longer than the manifest says;
  - **unnamed segments:** every `seg-*.log` in the directory whose name the manifest does not contain is removed;
  - **the manifest:** rewritten at the end of `open`.

**What a manifest naming a segment otherwise could do on open:**

| The manifest names | What happened |
|---|---|
| `../x` or an absolute path | the "open segment" is a file **outside the store**, and it is truncated to the manifest's byte count |
| `./seg-000001.log`, or `SEG-000001.LOG` on a case-insensitive volume | the same file under another spelling. The real `seg-000001.log` counts as "unnamed" and is **removed** |
| the wrong number for its position (for example `seg-000003.log` as the 2nd segment) | the next roll creates `seg-{len+1:06}.log` with `File::create` and so **truncates** a segment the manifest still names |
| a duplicate | as above |

**And a named segment that is a symbolic link** (open or sealed): followed by `set_len` (a write through the link) and by the reads.

**Reachable:** `Archive::open` is how `Findex::open_with` and `WideStore::open` start, with whatever `manifest.json` is in the store directory. It is not hypothetical lower-layer code: it runs on every start.

## What the writer has always written (compatibility)

- **The names:**
  - The k-th segment is `seg-{k:06}.log`: six digits **at least**, so `seg-1000000.log` past 999999.
  - Unchanged since the archive was created (`e8638677`, `git log -S`).
- **The order:**
  - Segments are only ever appended (`segments.push` is the only change in product code).
  - **So every manifest this writer wrote names segment k exactly `seg-{k:06}.log`.**
- **No test hand-writes or reorders names.** findex's tests only read them (`no_hidden_gap.rs`) or change `bytes`/`sha256` (`store_codec.rs`).
- **Other readers of this manifest:**
  - ④'s `observation.rs` `read_manifest` checks only that `name` is a string, so it keeps accepting every manifest it did.
  - It now accepts some that findex refuses. That is a parity note for ④'s owner, not a safety issue: ④ opens no segment by name.
- **Not this format:** `drand-replay`'s manifest is another format with its own name check, and is untouched.

## The fix (one path: `frontier-node/crates/findex/src/archive.rs`)

1. **`Manifest::from_json`:** segment i + 1 must be named exactly `segment_name(i + 1)` (`format!("seg-{k:06}.log")`, which the roll now uses too). Anything else is refused, shown cut to 80 characters: another number, a path, `./`, a different case, a duplicate. This happens while the manifest is read, **before** `Archive::open` truncates, removes or writes anything.
2. **`Archive::open`:** before the recovery, every named segment that exists must be a **regular file**. The check uses `symlink_metadata`, which does not follow a link, so a symbolic link, a directory or anything else is refused. A missing segment is left to the existing rules (refused when the manifest names bytes, as before).
3. **Unchanged:**
   - the recovery itself;
   - the removal rule for unnamed segments, which with canonical names can no longer meet an alias;
   - the formats;
   - group commit, the codec check, and every reader.

**Not claimed:**
- **Not race-free:** the checks are made once, at open. A file swapped between the check and `set_len`, or later, is not covered. Nothing here canonicalizes paths.
- **The store directory itself is not covered:** if it, or a component of its path, is a link, that is the caller's choice and is not checked.
- **No repair:** nothing is deleted or rewritten to repair a refused archive. It is left exactly as it was.

## Regression (written, NOT run): four cases in `archive.rs` `mod tests`

**Their own roots:**
- each test makes its own root with `fs::create_dir`, never an existing one;
- a `SegnameRoot` removes only that root, also on unwind;
- every fixture file (the archive, `outside.txt`, links) is inside it.

| Case | What it checks |
|---|---|
| `the_writers_own_names_still_open_and_large_numbers_keep_their_digits` | `seg-000001`, `seg-999999`, `seg-1000000`. An archive that rolled into 3 or more segments reopens with the same names and verifies. |
| `a_name_the_writer_never_gives_is_refused_and_nothing_inside_or_outside_changes` | `../outside.txt`, the outside file's absolute path, `./seg-000001.log`, `seg-1.log`, `seg-000002.log` in position 1, a duplicate, `SEG-000001.LOG`. Each is refused. The archive directory's entries, kinds, lengths and bytes are unchanged, and the 4 KiB file outside is unchanged. The real archive still opens and verifies afterwards. |
| `a_named_segment_that_is_a_link_or_a_directory_is_refused_and_nothing_is_written_through_it` | (unix) the open segment replaced by a link to the bigger outside file is refused, with nothing truncated through it and the directory unchanged. A directory in its place is refused. With the real segment back, the archive opens and verifies. |
| `a_sealed_segment_that_is_a_link_is_refused_too` | (unix) the first, sealed segment is a link: refused, and nothing changes. |

**Running them needs its own pre-run evidence and approval:** `cargo test -p findex --lib archive::tests`, under the unchanged `floor21.sh` → `conquest-guard.sh`. Not prepared here.

## The held directory-sync unit (`142c1cdb`): what the static check can and cannot say

**Supports it:**
- The repository already returns a failed directory open or sync in two other crates, in the same form: `stack/src/recovery_seal.rs` `sync_dir` and `bots/src/decision_ledger.rs` (`File::open(parent)?.sync_all()?`). That change would make findex follow the repository's own convention.

**Unknown:**
- No recorded run of either crate's tests was found in this repository. So it is **not shown** that this Mac's volume syncs a directory without error.
- The Rust standard library's `sync_all` on macOS is `F_FULLFSYNC` on the directory's descriptor. Whether every volume type accepts that for a directory is not shown here.
- **It stays held** until an approved run (or the owner) settles it.

## Hand-over (Lane D)

**Unit:** `claude/findex-segment-names-20261117` on `c7c1b1c5`, all `100644`:
- `frontier-node/crates/findex/src/archive.rs` (M)
- `docs/integration/CLAUDE-FINDEX-SEGMENT-NAMES-20261117.md` (A)

**Not run:** anything.

**Combining with the directory-sync unit,** if both are adopted: both add test blocks at the end of `archive.rs` `mod tests` and a paragraph to the module note. The merge needs both kept. Their helpers have different names (`SegnameRoot`/`segname_root` here, `OwnedRoot`/`owned_root` there), so both compile side by side.
