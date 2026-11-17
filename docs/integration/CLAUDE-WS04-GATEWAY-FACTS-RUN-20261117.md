# ④ `tests/gateway_facts.rs` at `23c549d3`: one run, 10/10 passed (2026-11-17)

**Result: `cargo test` exit 0; 10 passed, 0 failed, 0 ignored.**
- **When:** run once, 2026-11-17 03:39:17–03:39:27 UTC, with the v3 script. There was no retry and no other route.
- **What it covers:** the gateway port's landing fix, against the test's own loopback stub, with the simulated world (**MOCK**). **No real chain, world or runner.** No key was generated and nothing was signed.

## Inputs

**Run script:** scratchpad `scripts/run-ws04-gateway-facts-23c549d3-v3.sh`, SHA-256 `254a42a66edf504aacb0c4a2958ca47e465759aff012157eaf775722e6127ace`. Its hash was checked again just before the run.

**Checked as hard conditions** by the script before `cargo` (as `CLAUDE-WS04-GATEWAY-READ-CODES-20261117.md` §2 describes):
- the worktree state: HEAD `9fe9018e`, the status hash and the index hash;
- the pinned binaries (`cargo` and `rustc` 1.89.0; Command Line Tools `clang`, `ar` and `ld`) and the SDK;
- no build-environment variables;
- no cargo configuration above the tree, and exactly the two pinned configurations inside it;
- the archive's SHA-256 `f7247e26…8c20`;
- the hashes of `gateway.rs` (`906b5507…`), `gateway_facts.rs` (`5f161455…`) and `Cargo.lock` (`e740c00c…`);
- free space of 52,446,368 KiB (at least 23 GiB required).

**Checked just before, outside the script:**
- no other `cargo`, `rustc` or `clang` process was running;
- 50.0 GiB free;
- the listening TCP sockets were recorded (25).

## The run

- **Process group:** cargo pid 78211 in **its own process group 78211**; the script's group was 78110.
- **The build:** offline, locked, all 83 locked packages from the local cache, finished in 7.99 s. `libsqlite3-sys` compiled with the pinned `clang`.
- **The test binary:** `target/debug/deps/gateway_facts-baf589ff25c3566a`. 10 tests, 0.07 s.

| Test | Result |
|---|---|
| `sent_and_finalized_is_fulfilled_once` | ok |
| `failure_after_signing_is_followed_by_its_signature` | ok |
| `result_unknown_holds_as_indeterminate` | ok |
| `unqueryable_is_a_read_failure_not_an_outcome` | ok |
| `proved_expiry_allows_one_new_attempt` | ok |
| `failure_before_sending_is_absent` | ok |
| `older_gateway_failure_is_still_held` | ok |
| **`sent_then_finalized_failed_applies_no_effect`** (new) | ok |
| **`sent_then_proved_expired_then_new_attempt_delivers_once`** (new) | ok |
| **`sent_then_unknown_holds_without_effect`** (new) | ok |

## After the run

- **Processes:** `pgrep -g 78211` found no member, and no test or cargo process was left. The script's own group check reported nothing left.
- **Sockets:**
  - the test's stub sockets (`127.0.0.1:0`) are gone;
  - the only difference from the recorded list is two new sockets of **`codex` pid 88254** (`127.0.0.1:53494`, `:53495`). That is a separate program, not part of this run's process group, and it was not started or touched by it.
- **Writes:**
  - the run folder `ws04-gwf-run-23c549d3` (432 MB, of which the target is 424 MB);
  - 10 SQLite files under its `target/.../runexec-tests`;
  - the archive `ws04-gwf-23c549d3.tar` (6.9 MB);
  - the dedicated `TMPDIR` folder, empty.
  - **Kept as evidence.**
- **Free space:** 49.6 GiB.
- **The worktree:** "worktree unchanged" (HEAD, status and index hashes equal), 13 media deletions, nothing staged.
- **Log:** scratchpad `logs/ws04-gwf-run-23c549d3.log`, 3,759 bytes, SHA-256 `a310adcdd798bf5572bfa0e2ef58db8fab6aff93c61ac7373e6a8ce90c6194d0`.

## What this shows and what it does not

**Shown, on the mock stack:**
- **No phantom effect:** a `sent` answer finalized `failed`, proved `expired`, or left `unknown` leaves no effect in the simulated world.
- **No double effect:** an expiry followed by one new attempt delivers once.
- **The existing behaviour holds:** a plain send finalized `landed`, and the other six existing cases, still behave as before, now with the landing done on the `landed` read.

**Not shown:**
- a real chain or the real agent wallet gateway;
- the bridge-based tests in `tests/gateway.rs` (`#[ignore]`, need node; not run);
- any other ④ test.

## Hand-over (Lane D)

- **Code:** already in the aggregate (Lane D took `23c549d3`'s three paths).
- **This report:** the only file on `claude/ws04-gateway-facts-run-20261117`.
