# ④ `tests/reconcile_limit.rs` at `23e2af8a`: one run, 2/2 passed (2026-11-17)

**Result: `cargo test` exit 0; 2 passed, 0 failed.**
- **When:** run once, 2026-11-17 03:59:39–03:59:50 UTC. There was no retry and no other route. The earlier `gateway_facts` run was **not** run again.
- **What it covers:** ④'s `Store::attempts_to_reconcile` only, in the test's own SQLite file. No network, no bind, no key, no world, no runner.

## Inputs

- **Script:** scratchpad `scripts/run-ws04-reconcile-limit-23e2af8a.sh`, SHA-256 `be9c3752eb28a4eeb6174b68440848a5909c8839719c7f9a4c9a70ca6dc935e0`, checked again just before.
- **Checked before, outside the script:**
  - no other `cargo`, `rustc` or `clang` process;
  - 49.5 GiB free;
  - the worktree's HEAD `9fe9018e`, status and index hashes as audited, and its 13 media deletions;
  - every output path free;
  - the listening TCP sockets recorded (25).
- **Checked by the script** (hard conditions, unchanged v3 guards):
  - the worktree state;
  - the pinned `cargo` and `rustc` 1.89.0, Command Line Tools `clang`, `ar` and `ld`, and the SDK;
  - no build-environment variables;
  - no ancestor cargo configuration, and the two pinned in-tree configurations;
  - the archive SHA-256 `bd87a346…90ea`;
  - `store.rs` `422f885f…`, `reconcile_limit.rs` `385c647e…`, `Cargo.lock` `e740c00c…` (the same 83 packages as before);
  - free space of 51,926,956 KiB (at least 23 GiB required).

## The run

- **Process group:** cargo pid 84455, in **its own process group 84455**; the script's group was 84366.
- **The build:** offline, locked, from the local cache, 7.94 s. The test binary is `reconcile_limit-6c6d947aa7b91d3c`.

| Test | Result |
|---|---|
| `never_expiring_rows_do_not_starve_later_ones` | ok |
| `limit_counts_returned_rows_and_filters_are_unchanged` | ok |

## After

- **Processes:** `pgrep -g 84455` found no member, and no test or cargo process was left.
- **Sockets:** the listening TCP sockets are **unchanged** (the test binds none).
- **Writes:**
  - the run folder `ws04-rl-run-23e2af8a` (422 MB; target 415 MB; 2 SQLite files);
  - the archive (6.9 MB);
  - the dedicated `TMPDIR`, empty.
  - **Kept as evidence.**
- **Free space:** 49.1 GiB.
- **The worktree:** unchanged (HEAD, status and index), 13 media deletions, nothing staged.
- **Log:** scratchpad `logs/ws04-rl-run-23e2af8a.log`, 3,342 bytes, SHA-256 `8979dd2c892583df79ac2677bdd8a79d16ba9de1ef3167e7c8fb0c0f7e785351`.

## What this shows

**Shown:**
- the fixed `attempts_to_reconcile` returns the past-validity rows behind 20 never-expiring ones;
- it caps at `limit`, oldest first;
- it never returns an unexpired row, a landed row with a known fee, or a decided one;
- a `limit` of 0 returns nothing.

**Not shown:**
- the executor's `reconcile_fees` end to end;
- a real chain;
- any other ④ test.

**Hand-over:** the code (`23e2af8a`) is already in the aggregate. This report is the only file on `claude/ws04-reconcile-limit-run-20261117`.
