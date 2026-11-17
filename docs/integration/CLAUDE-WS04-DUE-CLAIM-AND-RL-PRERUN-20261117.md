# ④ executor: `due` → `claim` across workers; `reconcile_limit` one-run preparation (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `8c7f4de1` (for the reading), and the fixed unit `claude/ws04-reconcile-limit-20261117` at `23e2af8a` (for the run preparation).

**Not done:** no `cargo`, test, build or bind. The earlier one-run approval (for `gateway_facts`) is spent and is not reused.

## 1. Can runs held by other workers starve this worker's due runs? **No, within the existing guarantees. No code change.**

**The path** (`executor.rs` `tick`, `store.rs` `due` and `claim`):
- `due(now, max_runs_per_tick = 64)` returns open, unheld runs with `next_check <= now`, ordered by `(next_check, run_id)`, `LIMIT 64`, **whoever holds their lease**.
- For each, `claim` either succeeds (free, ours, or an expired lease; a take-over bumps the epoch) or the run is skipped.

**Could the first 64 stay due while unclaimable, forever?** Each way a run can stay due:

| How a due run is left | What moves `next_check` | Bounded? |
|---|---|---|
| a **live** worker holds it and steps it | every step writes a new `next_check`: progress (its own next look), `Wait(at)` (a write when `at` differs; equal means already in the future), a port error (`now + poll`) | it leaves the due list after that worker's tick |
| the holder's write was stale (`Fault::Stale`) | the writer that won wrote its own `next_check` | yes |
| a **crashed or paused** worker's lease | none until the lease ends (`lease` = 8 slots); then `claim` succeeds (`lease_until < now`) and the epoch fences the old holder | yes, at most the lease length |
| a held run (`held_reason`) | not in `due` at all | — |

**Result:**
- **A worker can be delayed** by at most one lease length when another worker dies holding 64 or more due runs. That is the lease design (`claim`, `store.rs:6`).
- **It is not starved:** no run stays due and unclaimable indefinitely.
- **Not checked:** a fairness rule (for example skipping held leases in SQL) would be a new scheduling policy. It is not added.

**Also checked:**
- **The same owner** extends its own lease without an epoch bump.
- **A restart** under the same identity continues.
- **`limit = 0`** gives no runs (SQL `LIMIT 0`).
- **The CAS on every write** is unchanged.

## 2. `tests/reconcile_limit.rs` (2 cases): one run, prepared, NOT run

**What differs from the `gateway_facts` run** (checked against `23c549d3`):
- `git diff 23c549d3 23e2af8a -- workstreams/04-execution frontier-abi permutation-rules rust-toolchain.toml` changes **only** `src/store.rs` and adds `tests/reconcile_limit.rs`.
- The **`Cargo.lock` is identical** (SHA-256 `e740c00c…c695`): the same 83 packages, all in the local cache, so offline still holds.
- The same toolchain and the same two `.cargo/config.toml` files (`07a9a319…`, `b108f239…`).

**What the test itself does:**
- **Imports:** only `runexec::{ports, store}`, `tests/common`, `rusqlite::params` and `serde_json`.
- **Store:** `Store::open(db_path(…))` in the run's own `target/.../runexec-tests`, and direct `INSERT`s into `attempts`.
- **No bind, spawn, network, key or other file I/O** (checked by text).
- **`tests/common/passnode.rs`** is compiled with `common` but **not called**, so it binds nothing.
- **`db_path`** removes only its own `<name>-<pid>-<n>.sqlite` (plus `-wal` and `-shm`) in that folder before opening.

**The script:** scratchpad `scripts/run-ws04-reconcile-limit-23e2af8a.sh`, **SHA-256 `be9c3752eb28a4eeb6174b68440848a5909c8839719c7f9a4c9a70ca6dc935e0`**, 152 lines.
- **How it was made:** derived from the gateway_facts v3 script (`254a42a6…`, whose one run is done). 14 lines differ:
  - the description;
  - **new output paths** (`ws04-rl-run-23e2af8a`, `ws04-rl-tmp-23e2af8a`, `ws04-rl-23e2af8a.tar`, `logs/ws04-rl-run-23e2af8a.log`, all free, so nothing of the earlier run is overwritten);
  - the commit `23e2af8a`;
  - the archive SHA-256 `bd87a346…90ea`;
  - the hashes of `store.rs` (`422f885f…1cb4`) and `reconcile_limit.rs` (`385c647e…ccfc5`);
  - `cargo test --locked --offline --test reconcile_limit`.
- **Unchanged from v3:**
  - its own process group, stopped and checked as a whole, with a trap;
  - `df -k` fail-closed, 23 GiB to start and stop below 22 GiB, 30 minutes;
  - the pinned `cargo`, `rustc`, `clang`, `ar` and `ld` under `env -i` (rustup bypassed);
  - the ancestor and in-tree cargo configuration checks and the real-path checks;
  - the hashed archive;
  - the worktree's HEAD, status and index hashes before and after. These are the same values as today, unchanged since the last run.

**Not one of the refused tests:** only ④'s store and this test file. No world, runner, walls-items, muster, ⑬ guard, G or H.

**Approval needed for one run:** a `cargo` build (the same crates and C compilation as before, offline, from the cache). **This test makes no bind.**

## Hand-over

- **No code unit this round.** This report is the only file on `claude/ws04-due-claim-review-20261117` (on `8c7f4de1`).
- **The fixed unit `23e2af8a`** and the aggregate are unchanged.
