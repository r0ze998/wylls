# ④ `tests/gateway_facts.rs` at `23c549d3`: evidence for one run (prepared, NOT run) (2026-11-17)

**What it is for:** one run of `workstreams/04-execution/tests/gateway_facts.rs` (the 7 existing cases plus the 3 added by `559d9015`), to check the gateway port's landing fix.

**Not done yet:** nothing was built or run. No `cargo`, `rustc` or bind; no network.

**Every fact below was read from files:** `git show`, the local cargo registry and `~/.rustup`.

## Not one of the refused tests

**The run touches only:**
- `workstreams/04-execution` (`src/` and the `gateway_facts` target with `tests/common`);
- `frontier-abi` and `permutation-rules` (path crates);
- the root `rust-toolchain.toml`.

**It does not touch:** a world, a runner, walls-items, muster, ⑬'s guard tests, group G's web-frontier closure or H's tests. Not the same test, and not a piece or a copy of one.

**The chain is MOCK:** the test's own loopback stub stands in for the agent wallet gateway. It is not a real chain.

## Dependencies (`workstreams/04-execution/Cargo.lock`, SHA-256 `e740c00c…c695`)

- **83 packages:** 3 path crates (`wylls-runexec`, `frontier-abi`, `permutation-rules`) and **80 registry crates**, all from `crates.io-index`.
- **The cache:** all 80 are present in `~/.cargo/registry`, as `.crate` or unpacked source. `cargo test --locked --offline` should resolve without any fetch. If it cannot, `--offline` refuses and nothing is fetched.
- **Build scripts (16):** `borsh`, `curve25519-dalek`, `generic-array`, `libc`, **`libsqlite3-sys`** (`bundled`: compiles SQLite's C source with the system C compiler), `proc-macro2`, `quote`, `rustversion`, `serde`, `serde_core`, `serde_json`, `sqlite-wasm-rs`, `thiserror`, `wasm-bindgen`, `wasm-bindgen-shared`, `zmij`.
- **Proc-macros (6):** `borsh-derive`, `curve25519-dalek-derive`, `rustversion`, `serde_derive`, `thiserror-impl`, `wasm-bindgen-macro`.
- **Not inspected:** those crates' sources were not audited line by line. They are standard published versions pinned by the lock.
- **The path crates:** they inherit no workspace fields (`frontier-abi` → `permutation-rules`; `permutation-rules` → `borsh`, `sha2`), so they build outside the root workspace.
- **No compile-time file includes** beyond `env!("CARGO_TARGET_TMPDIR")` in `tests/common/mod.rs`.

## Toolchain and configuration

- **The toolchain:** root `rust-toolchain.toml`: `channel = "1.89.0"`, profile minimal. `1.89.0-aarch64-apple-darwin` is installed (`~/.rustup/toolchains`).
- **Configuration:**
  - ④ has its own `.cargo/config.toml` with `[build] target-dir = "target"`;
  - the repository root's `.cargo/config.toml` is **not** in the run tree;
  - there is no `~/.cargo/config(.toml)`;
  - there are no `RUST*` or `CARGO*` environment variables.
- **No ancestor** of the run folder has a `.cargo` or `Cargo.toml`.

## What the run reads and writes

- **The tree:** a new folder in the scratchpad, `ws04-gwf-run-23c549d3`, holding `git archive 23c549d3` of `rust-toolchain.toml`, `workstreams/04-execution`, `frontier-abi` and `permutation-rules`: 6.9 MB, `tar -x -k`, no symlinks. The worktree, its index and its 13 media deletions are not touched.
- **Build output:** `workstreams/04-execution/target` **inside that folder**. An earlier full build of this crate elsewhere left an 803 MB `target`, so **expect under 1 GiB**; there is 50 GiB free, with a floor of 21 GiB.
- **SQLite:**
  - `tests/common/mod.rs` `db_path` creates `CARGO_TARGET_TMPDIR/runexec-tests/` (inside that `target`);
  - its files are named `<case>-<pid>-<n>.sqlite` (with `-wal` and `-shm`);
  - before opening, it removes only those exact three names. **No user data can be in that folder.**
- **The network:**
  - each case binds **`127.0.0.1:0`** (`gateway_facts.rs:102`), and the port connects only to `127.0.0.1:<that port>` (`gateway.rs:64`);
  - `tests/common/passnode.rs` is compiled but not called by this file, so it binds nothing;
  - nothing else is contacted.
- **Keys and signing:** none. The stub's signatures are strings (`sig1`, …).
- **Clean-up:** the stub threads end with the test process. The run folder is **kept** as evidence.
- **Also built:** `cargo test --test gateway_facts` builds the library, this test and the `runexec` binary (cargo builds bins for integration tests). The binary is not run by this test.

## The one-run script (written, NOT run)

- **Where:** scratchpad `scripts/run-ws04-gateway-facts-23c549d3.sh`, SHA-256 `9358c8a7de2c0d2faa5e689ca7707635378fe07141096450f49fc5185fdc1b18`.
- **Hard checks before `cargo`:**
  - the worktree state (13 media deletions, nothing staged);
  - no `RUST*`, `CARGO*`, `LD_*` or `DYLD_*`; no user cargo config;
  - at least 21 GiB free;
  - a new run folder, with no ancestor `Cargo.toml`;
  - the extract, with no symlinks;
  - the hashes of `gateway.rs` (`906b5507…72b9`), `gateway_facts.rs` (`5f161455…e6a`) and `Cargo.lock` (`e740c00c…c695`).
- **Then once:** `cargo test --locked --offline --test gateway_facts`.
- **After:** the target size, the SQLite file count, and HEAD, status and media again.
- **On any failure:** stop. No retry, no substitute.

**What it needs:** an approval naming a `cargo` build (including C compilation by the `libsqlite3-sys` build script), offline use of the local crate cache, and loopback binds on `127.0.0.1:0`.

## Counter-review: do the existing cases need a `sent` to take effect at once? (read only)

| Existing case | Script | Under the fix |
|---|---|---|
| `sent_and_finalized_is_fulfilled_once` | `Sent`; `pending`, `landed` | lands at the `landed` read; `Landed` without a record yet → one-slot wait → `Fulfilled` |
| `failure_after_signing_is_followed_by_its_signature` | `FailedSigned`; `pending` ×2, `landed` | never landed at the answer, before or after: unchanged |
| `result_unknown_holds_as_indeterminate` | `FailedSigned`; `unknown` | unchanged |
| `unqueryable_is_a_read_failure_not_an_outcome` | `Sent`; `http500` ×3, `landed` | effects now wait for the 4th read, which lands it (60 ticks, tick errors counted) → `Fulfilled`, 1 transaction |
| `proved_expiry_allows_one_new_attempt` | `FailedSigned`, `Sent`; `expired` / `pending, landed` | unchanged |
| `failure_before_sending_is_absent` | `FailedUnsent`, `Sent`; `not-sent`, `landed` | the second lands at `landed` |
| `older_gateway_failure_is_still_held` | `FailedOld` | unchanged |

**Own-signature idempotency at the consumers:**
- `land_external` keys on the signature;
- `chain_sig` and the executor's evidence step name the attempt's own signature (`r.signed()`).

So a repeated `landed` read, a restart (history → `remember`, which lands nothing) or a Duplicate naming the same signature applies the effect at most once. **No further defect.**
