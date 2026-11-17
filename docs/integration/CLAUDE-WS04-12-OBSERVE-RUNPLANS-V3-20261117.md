# ⑫ run plan v3 and a first ④ observe run plan on the aggregate (both NOT run), and ④'s producer against the 16/16 run (2026-11-17)

**Base:** the aggregate `claude/aggregate-approved-20261117` at `9737f885`. Read with `git show` only; the aggregate ref is Lane D's.

**Not done:**
- no test, import, CLI run, `cargo`, request, world, key or signing;
- `bash -n` only.

**v2 (`0cef6efe`) is withdrawn.** Neither plan below is an approval.

## 1. ⑫ run plan v3: the two gaps v2 left

**Script:** scratchpad `scripts/run-ws12-observe-a7cd14b6-v3.sh`, **SHA-256 `0981afcf71cbc151eb1faabaea3a1c43afc095001f46bfbe6b51dd0f21db9a86`**, 189 lines.

**Unchanged from v2:** the 23-path extraction, the pins, Node, the guard, the command, and the fail-closed endings.

| v2's gap | v3 |
|---|---|
| `run_one` took an empty or failed `ps` as "gone". It then went to `wait`, and the 120 s cap and the space and socket checks were lost. | **`job_state` keeps three answers apart:** running, ended, and not checkable. "Not checkable" is a failure. **Ended:** a `Z` state, or `ps` rc 1 with no output **and** `kill -0` failing too (an unreaped child still answers `kill -0`, so a disagreement is "not checkable"). **Running:** any other state. Any other `ps` answer is a failure. |
| `wt_state` printed through `echo "$(git …)"`, which hid a failing `git` | **each `git` is its own assignment** (`rev-parse`, `status`, `diff --cached`), and its failure is returned. Any failure ends the run `FAILED`, before or after. |
| `listening` accepted any lsof answer without stderr | **one `lsof_q` for every lsof use:** found is rc 0 with output; none is rc 1 with no output; anything else (other rc, output with rc 1, any stderr) is "not checkable", which is a failure. `df` must give a number. |
| an unconfirmed group could be signalled | **`OWNED` becomes 1** only after `pgid = pid` and `ppid = $$` are confirmed. **Just before any signal, both are checked again**, because a reaped pid could be reused. Confirmed: the group gets TERM, then KILL. Unconfirmed: nothing is signalled, and that is logged. Before confirmation, only the job's own pid is signalled (this shell's unreaped child). |

**Expected:** 9 and 6 passing. The second file runs only after the first passes. No retry.

**Refusal check (kept):** the target, purpose and dependencies are 12's and 13's own (see `31740386` §1). There is no split, copy or alternative of a refused run, so no reason to hold the plan.

## 2. ④'s read-only producer on the aggregate, against the 16/16 run

**What the earlier evidence covers:**
- The 16/16 (4 + 5 + 7) ran in `6005b380`'s tree, under `floor21.sh` → `conquest-guard.sh`.
- **The six observe files are byte-identical** at `9737f885`: `src/observation.rs`, `src/main.rs`, `src/lib.rs`, `tests/observation.rs`, `tests/observe_cli.rs` and `tests/store_observation.rs`.
- So are `Cargo.toml`, `Cargo.lock` (`e740c00c…`), both `.cargo/config.toml` files, `rust-toolchain.toml`, `frontier-abi` and `permutation-rules`.

**What differs in ④'s tree:**
- **Code:** `src/acts.rs`, `src/gateway.rs` and `src/store.rs`, this lane's earlier fixes. They change bodies only: no `pub`, `fn`, `struct`, `enum` or `use` line differs, and `observation.rs` imports none of them.
- **Tests:** three other test files (`acts_code`, `gateway_facts`, `reconcile_limit`), which `--test` does not build.

**The real path to a real index (checked in `31740386` §3, unchanged):**
- findex's tables and markers are what observe reads;
- an index not marked complete is refused (held);
- a failed transaction has no records;
- the output is one JSON line.

**No defect within the adopted contracts, so no code.**

**Not a refused alternative:**
- These are ④'s own observe tests: the producer and its command on synthetic stores in `temp_dir()`.
- The only subprocess is the runexec binary just built (`CARGO_BIN_EXE_runexec`), running `observe`.
- No world, runner, walls-items, muster, ⑬ guard, G or H.

## 3. ④ observe run plan (one run of 16 cases on `9737f885`)

**Script:** scratchpad `scripts/run-ws04-observe-9737f885.sh`, **SHA-256 `4645991aee8608086b9e4ee0493d43e820fb4ae2b2c2bcd0d38ee75559488181`**, 185 lines.
- Derived from the approved `reconcile_limit` script (`be9c3752`, whose one run is done; nothing reused or overwritten).
- The v3 rules of §1 are carried over.

**Inputs:**
- **The extraction:** `git archive` of `rust-toolchain.toml`, `workstreams/04-execution`, `frontier-abi` and `permutation-rules` at `9737f885`, SHA-256 **`8380f2b5cbe6a8cd987aa12e610ba30e05d18068ea19f100df810dc77d918ad1`** (git 2.49.0), with no links.
- **Nine file pins:** the six observe files, `Cargo.lock`, and the two in-tree cargo configs (`07a9a319…`, `b108f239…`). Exactly those two configs are allowed.
- **Toolchain:** the pinned `cargo`/`rustc` 1.89.0 and the Command Line Tools `clang`/`ar`/`ld`, all hashes unchanged from the last run; the SDK `MacOSX27.0.sdk`.
- **Environment:** no build variables. `env -i` with `RUSTC`, `CC`, `AR`, `SDKROOT`, the linker, `CARGO_NET_OFFLINE=true` and a dedicated `TMPDIR`; rustup bypassed.
- **Command:** `cargo test --locked --offline --test observation --test observe_cli --test store_observation`.

**Checked before (each a stop):**
- the worktree HEAD `9fe9018e`, status hash `458ebc6e…` and index hash `013c8679…`, exactly as audited;
- no user cargo config, and no `.cargo`, `Cargo.toml` or link in any ancestor (checked now as well);
- no `cargo` or `rustc` running (`pgrep` rc 1 only);
- at least 23 GiB free;
- every output path free (checked now as well).

**While cargo runs** (its own process group, confirmed as in §1), every 2 s:
- free space at least 22 GiB;
- no network file in the build's group;
- **the target at most 4 GiB** (`conquest-guard.sh`'s size limit; earlier builds were about 0.42 GB);
- at most 30 minutes.

An unreadable `ps`, `df`, `du` or `lsof` is a failure.

**After:**
- exit 0;
- no member left in the group;
- the dedicated `TMPDIR` empty (the tests remove their own fixtures);
- the worktree state unchanged;
- free space.

**Expected:** 16 passed. No retry.

**A known limit, fail-closed:** `du` can fail if a file vanishes during the build. That stops the build as "not checkable" rather than being ignored.

**The guard question for the owner:**
- The 16/16 ran under `floor21.sh` → `conquest-guard.sh`. This plan checks the same limits itself: a 4 GiB target, at least 21 GiB never reached, and 30 minutes.
- The two later ④ runs (`gateway_facts`, `reconcile_limit`) were approved with the self-contained v3 script.
- Whether this run should instead go through `conquest-guard.sh` unchanged is the owner's choice. The script is not a relaxed copy of that guard.

## 4. What is still not connected, and the next implementable unit

| # | Item | State |
|---|---|---|
| 1 | ④ observe on the aggregate tree | plan §3; needs its own approval |
| 2 | ⑫'s two files | plan §1; needs its own approval |
| 3 | ⑬'s three tests | held: they run under 13's guard (its `@solana/web3.js` tree is not approved) |
| 4 | epochs from a real store | held: needs findex's writer side (`a99b961f`), the parent's and D's decision |
| 5 | a real herald, RPC and findex at once | held: needs a running world (not authorized) |

**The next implementable unit, within adopted contracts (static):** the end-to-end composition test that is still missing.
- No test feeds the **actual** runexec page format (as `observe_cli.rs` asserts it) into 12's held report.
- The ⑫ fixtures are hand-written to the serde shape.
- A ④-side test could print a page from a synthetic store and save it. A ⑫ test could read that saved file through `heldFromWs04Observation` and expect zero findings and every hold kept.
- That joins the two sides' evidence without a world, an RPC or a key. Writing it is source only; each side's run needs its own approval.

## Hand-over

- **This report** is the only file on `claude/ws04-12-observe-runplans-v3-20261117` (on `9737f885`).
- **No code unit; the aggregate is unchanged by this lane.**
