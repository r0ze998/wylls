# findex archive: a failed directory sync is an error, not a durable append (2026-11-17)

**Branch:** `claude/findex-dir-sync-20261117`, on the aggregate `claude/aggregate-approved-20261117` at `09df1519`. The aggregate ref is Lane D's and is not changed.

**Static change, NOT run:**
- no `cargo`, test or build;
- no real store, RPC, world, key or signing;
- no earlier approval reused.

**The unadopted writer:** `a99b961f` (findex observed epochs) is **not** taken. Its `write_manifest` ignores the same failure. It is a separate decision of the parent's and D's.

## What the aggregate's findex does (read with `git show`)

**The `archive.rs` contract (module note):**
- **With the default `commit_every = 0`,** "every `Archive::append` is durable when it returns". The batch's frames are synced once, then the manifest.
- **With group commit,** durability comes at `commit()`.
- **The manifest is written by:** a temporary file, `sync_all`, `rename`, then a sync of the archive directory.

**The defect:**
- `write_manifest` ended with `if let Ok(d) = File::open(&self.dir) { let _ = d.sync_all(); }`. Both the directory's **open** failure and its **sync** failure were dropped, and `Ok(())` was returned.
- **What that sync protects:**
  1. the rename of the new manifest;
  2. the directory entry of a segment file that a roll created just before (`File::create(seg).sync_all()` syncs the file, not its directory entry).
- **So an append reported durable** could, after a power loss:
  - fall back to the previous manifest (loss of a batch the caller was told was durable); or
  - find a manifest naming a rolled segment whose directory entry never reached the disk. `Archive::open` then **refuses** the archive ("segment … is 0 B, the manifest names … B").
- **Reachable:** on every manifest write. That is every default append, every group commit, and every `Archive::open`. Through `Findex::ingest`/`commit` and `WideStore::ingest`/`commit`, the only product callers.

**The fix (one path: `frontier-node/crates/findex/src/archive.rs`):**
- `write_manifest` now returns the directory sync's failure: "manifest renamed, but the archive directory sync was not confirmed: <cause>".
- The sync is a private `fn sync_dir(dir) { File::open(dir)?.sync_all() }`, held in a private field. Product code always uses it; the module's own tests can replace it to make it fail.
- **What happens on failure:**
  - nothing is undone or deleted;
  - the append or commit returns the error, and `dirty` stays set (still uncommitted);
  - **the callers' existing poison applies unchanged:** `Findex` and `WideStore` set `poisoned` on any archive error and refuse every later ingest or commit (reopen required).
- **Unchanged:**
  - `Archive::open`'s recovery (truncating unnamed tail bytes, removing unnamed segments, refusing a segment shorter than its entry);
  - the index roll-back to the archive (`Findex::open_with`);
  - the frame and manifest formats;
  - group commit.

## The other points asked about: what is reachable, what holds

| Point | Product path | Verdict |
|---|---|---|
| **`unsynced.take()` then `sync_data()` fails, then a retry** | The handle is dropped and `dirty` stays set. A later `commit()` on **the same** `Archive` would write a manifest naming frames whose sync failed. **But** the only product callers poison on that first error and never call the archive again (`lib.rs` `:151-154`, `:193-199`; `wide_store.rs` `:116-118`, `:143-145`). | **not reachable in the product. Not changed:** this was not done on a lower-layer hypothesis. The `Archive` API alone does not promise a retry. |
| **A partial frame write (`write_all` fails mid-batch)** | The same: the error poisons the caller. On reopen, `Archive::open` truncates the open segment to the bytes the durable manifest names. | holds |
| **A segment roll, then a crash before the manifest** | Unnamed segment files are removed on open, and the cursor is still before them, so the source re-delivers them (`a_crash_across_a_segment_roll_reopens_clean`). | holds |
| **A rename failure** | An error, so the caller poisons. The old `manifest.json` stays; the next `File::create` overwrites the `.tmp`. | holds |
| **Index ahead of the archive after a lost commit** | `Findex::open_with` rolls the index back to the archive, and the source re-delivers. | holds |
| **Cursor** | It moves only with the manifest (same file). | holds |
| **Observed epochs** | Not in the aggregate (`a99b961f` not taken). Nothing is written, so no unknown source or epoch can appear. | n/a |

## Regression (written, NOT run): two cases in `archive.rs` `mod tests`

**Their own roots:**
- each test makes its root with `fs::create_dir`, so never an existing one;
- an `OwnedRoot` removes only that root, also on unwind;
- the existing tests' helper (which removes first) is untouched.

| Case | What it checks |
|---|---|
| `a_failed_directory_sync_makes_the_append_an_error_and_deletes_nothing` | **Default commit:** the second append's directory sync fails. The result is an error naming the directory sync and keeping the injected cause, and the append stays uncommitted. A reopen verifies, keeps the first batch, and removes nothing it names. |
| `a_failed_directory_sync_makes_the_commit_an_error_and_keeps_it_pending` | **Group commit:** the commit fails the same way and stays pending. With the sync working, a later commit completes. The reopen verifies 3 records and the cursor. |

**Running them needs its own pre-run evidence and approval:** findex crate tests, `cargo test -p findex --lib archive::tests`, under the session's unchanged `floor21.sh` → `conquest-guard.sh`. Not prepared here.

## Counter-review (once)

- **Risk named, not hidden:** on a filesystem where a directory cannot be synced at all, every manifest write now fails, so findex stops (poison) and cannot open. **That is fail-closed:** it was silently "durable" before. Whether this Mac's volume syncs directories is unknown until the tests run; the existing archive tests would show it at once (every one opens an archive).
- **No new rule:** no ownership, trust or durability rule is added. The module's own stated contract ("durable when it returns") is what the change enforces.
- **No repair by deleting or overwriting:** nothing is deleted or overwritten to repair.
- **Not touched:** observed epochs, and the writer branch.
- **Not touched by this lane:** D's ⑥ dispatch and C's app and controller generations.
- **Merge:** a merge-tree check with `a99b961f` is recorded in the hand-over.

## Hand-over (Lane D)

**Unit:** `claude/findex-dir-sync-20261117` on `09df1519`, all `100644`:
- `frontier-node/crates/findex/src/archive.rs` (M)
- `docs/integration/CLAUDE-FINDEX-DIR-SYNC-20261117.md` (A)

**Not run:** anything.

**Merge checks (objects only, `git merge-tree`):**
- **with the aggregate's newer tip `c7c1b1c5`:** clean. findex is unchanged there.
- **with the unadopted writer `a99b961f`:** one conflict in `archive.rs`, only where both append test cases at the end of `mod tests`. Keeping both blocks resolves it.
  - `a99b961f`'s own `write_manifest` still ignores the directory sync; it would need this change too.
  - That is not done here: the writer stays unadopted.
