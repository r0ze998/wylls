# ④ observation → `observe-canonical` → ⑫ held report: input and generation consistency (2026-11-17)

**Branch:** `claude/ws12-13-observe-consistency-20261117`, on `claude/ws04-observe-consumer-20261117` at `06b3e98f`.
- That base is the existing integration branch of the four saved units:
  - `ws04-store-dir-observation` `6005b380`
  - `findex-observed-source` `a99b961f`
  - `ws12-13-live-observation` `5b2bed58`
  - the observe client `76750010`…`8e2e3e85`
- `observed-to-ws04-held` (`c44c6b22`) is a report only.
- **None of these is in the aggregate** (`6a7aea0f`, checked); this unit adds nothing new beside them.

**Static change, NOT run:**
- no `node --test`, `cargo`, build, bind, HTTP, RPC or world;
- `node --check` (a parse) only;
- no earlier run approval reused.

## What was checked (the path that exists)

1. ④ `runexec observe store|db` (`observation.rs`):
   - the page is `basis: unproven`, with `world`, `finality` and `complete` null and every hold kept;
   - store mode adds each row's `archive_epoch` and the page's `store` facts, all from the same two manifest reads and one index read.
2. ⑬ `ws04-observe.mjs`: `execFile`, no shell; the last JSON line is the page or runexec's own error code.
3. ⑬ `bin/observe-canonical.mjs`:
   - the page comes from a file (`--ws04-observation`) or from runexec;
   - `ws04Read` says whether it was read.
4. ⑫ `adapters/ws04-observation.mjs` makes the held report: nothing admitted, and 4's reasons are copied verbatim.

**Already held, unchanged:**
- unknown or malformed fields become reasons, never fewer;
- a claimed world, finality, completeness or basis is not believed;
- an unsafe integer is never put into text;
- a failed read is never "no record".

## The gaps found and fixed (reachable)

| # | Where | What happened | Reachable by | Fix |
|---|---|---|---|---|
| 1 | CLI | `--ws04-observation ''` was read as "no page asked for": `ws04` null, no usage error. The other five page options already refused `''`. | the CLI's own input | exit 64 `--ws04-observation is empty`, before anything is read or started |
| 2 | CLI | The requested mode was never compared with the page's. A `--ws04-db` read that came back with `store` facts, or a `--ws04-store` read without them, was printed as `{status:'read', mode}` with nothing named. | a runexec of another version, or a wrapper at `--runexec` | `ws04Read.why: ['ws04_page_mode_not_the_requested_mode']`. The page is still handed to 12 and held. When the modes agree the output is exactly as before. |
| 3 | ⑫ | The page's `store` facts were checked for shape only. A page whose `manifest_stable`, `generation`, `manifest_next_seq_before/after` and `index_last_seq` contradict each other was carried with no reason. | a page file (`--ws04-observation`), or another version | page reason `ws04_observation_store_generation_inconsistent`, by runexec's own rule (`read_store_observations`) |
| 4 | ⑫ | A row's epoch view was not compared with the page's facts. Each of these was shown with no reason: | as 3 | row reason `archive_epoch_not_the_page_generation`, or `archive_sequence_past_index_last_seq` |
|   |   | • a `covered_by_epoch` on a page whose manifest changed during the read | | |
|   |   | • `manifest_changed_during_read` on a stable page | | |
|   |   | • `covered_by_epoch` at or past the manifest's `next_seq` | | |
|   |   | • `past_manifest_end` inside it | | |
|   |   | • a row past the index's own last sequence | | |
| 5 | ⑫ | A store page with some rows lacking `archive_epoch` was not flagged (only a page with none was). | as 3 | row reason `archive_epoch_missing`. Nothing is guessed for the row. |

**How the new findings behave:**
- They are diagnostics only: every row stays held, every epoch is shown as given, and nothing is dropped, corrected or lifted.
- A number that is not a safe integer is not compared; it is named in `unsafe`, as before.

**runexec's own pages produce none of these reasons:**
- **Stable pages:** runexec's rule gives `index_ahead`, `index_behind` or `index_matches`, and the check uses the same rule.
- **A changed manifest:** every row is `manifest_changed_during_read`.
- **Row sequences:** these are at most `MAX(tx.seq)` in the same read transaction.
- **An empty page:** `index_last_seq` 0 is consistent.

## Regression (written, NOT run)

**`12-memory/test/ws04-observation.test.mjs`** (one case):
- the reader's four consistent page shapes give no findings;
- five self-contradicting pages are named;
- an unsafe number is not compared;
- five row-against-page contradictions are named (and one agreeing row is not), with the epoch still shown as given and every row still held;
- a mixed page names its row without an epoch;
- a plain page is unchanged.

**`12-memory/test/ws04-observe-cli.test.mjs`** (two cases):
- an empty `--ws04-observation` gives exit 64, with no fetch, RPC, store read or subprocess;
- `db`↔`store` mismatches are named in both directions, and agreeing modes add nothing (`deepEqual` as before).

**The existing fixtures are unchanged and stay consistent:** their seq, `index_last_seq` and `next_seq` agree. The ⑬ text pins (`ws04-observe.test.mjs` `:59-61`) still match.

**Running them needs its own approval.**
- They are the two 12 test files already run once each (8/8, 4/4) at `06b3e98f`, now with three new cases.
- They are node only: fakes, with no SQLite, network or subprocess.

## Not done, not decided

- **No new rule:** no new world, finality, identity, coverage, clock or ownership rule, and no `complete: true`.
- **No conversions:** no timestamp↔slot conversion, and no promotion of a page, an epoch or a supplied log to chain or receipt.
- **⑬ is unchanged:** it still has no real observe, join or board, and bell/event mapping is not adopted (`dc74c8a6`, `3907e109`). This unit does not touch them.
- **Lanes not touched:** D ③⑥, C ⑦.

## Hand-over (Lane D)

**Paths** (all `100644`):
- `workstreams/12-memory/adapters/ws04-observation.mjs` (M)
- `workstreams/13-citizens/bin/observe-canonical.mjs` (M)
- `workstreams/12-memory/test/ws04-observation.test.mjs` (M)
- `workstreams/12-memory/test/ws04-observe-cli.test.mjs` (M)
- `docs/integration/CLAUDE-WS12-13-OBSERVE-CONSISTENCY-20261117.md` (A)

**Merging the base into the aggregate is the parent's decision:**
- `06b3e98f` (33 paths) is not in the aggregate.
- `git merge-tree 6a7aea0f 06b3e98f` gives a clean tree.
- The only path both sides change is `workstreams/13-citizens/resident/resident.mjs`: the aggregate's `#run` mayHaveLeft, against the integration branch's `decide-core` split.
- Not merged here.
- **Not the refused items:** no world, runner, walls-items, muster, ⑬ guard, G or H, and not `17f4cca4`.
