# ④ `gateway_facts` one-run script, v2 guards (prepared, NOT run) (2026-11-17)

**What it replaces:** the v1 script described in `CLAUDE-WS04-GATEWAY-FACTS-PRERUN-20261117.md` (SHA-256 `9358c8a7…1b18`, never run).

**v2:** scratchpad `scripts/run-ws04-gateway-facts-23c549d3-v2.sh`, **SHA-256 `85ee423fb9740a7891479a3662761cba386cc898eeaa39c5423c3d4f9a1bfa15`**, 124 lines. The diff from v1 is 111 lines added and 30 removed.

**Not run:**
- the script itself (not even `bash -n`);
- `cargo`, `rustc` and the compiler;
- any bind.

**Not committed here:** the script itself, because it contains local home-directory paths.

## The six guards, as requested

| # | Request | v2 |
|---|---|---|
| 1 | Search every ancestor for cargo configuration; pin the configurations inside the extract | `~/.cargo/config` and `config.toml` must not exist. Every ancestor of the scratchpad, up to `/`, must have no `.cargo/config`, `.cargo/config.toml` or `Cargo.toml`, and must not be a link. Inside the extract, the set of `*/.cargo/*` files must be exactly `workstreams/04-execution/.cargo/config.toml` (SHA-256 `07a9a319…15bc`) and `workstreams/04-execution/e2e-native/.cargo/config.toml` (`b108f239…71c7`, not on cargo's search path from `workstreams/04-execution`). `R/.cargo` and `R/workstreams/.cargo` must not exist. |
| 2 | Independent checks; the output paths real and dedicated | Each check is its own condition. The run folder, a dedicated `TMPDIR` folder and the archive file must not exist, not even as links. The scratchpad's physical path (`pwd -P`) must equal its path. After `mkdir`, each folder must be a directory, not a link, with physical path equal to its path. The extract must contain no links (count = 0). |
| 3 | `pipefail`; no failure counted as success | `set -u -o pipefail`. `git archive` is written to a file first and its **SHA-256 checked** (`f7247e26…8c20`; git 2.49.0 pinned) before `tar -x -k`, and both steps are checked. Every check calls `stop` (exit 3); a changed worktree afterwards is exit 5. |
| 4 | Reserve the build's use above the floor; watch it while it runs | Start only if free ≥ **21 + 2 GiB** (the audited estimate is under 1 GiB; 803 MB elsewhere). While `cargo` runs, every 5 s: if free < 21 GiB, or after **1,800 s**, the build is stopped (TERM to `cargo` and its children, then KILL). It is recorded as stopped (exit 4). |
| 5 | Pin the real binaries and the build-script environment; no rustup download | These binaries must be regular files (not links) with pinned SHA-256: `cargo` and `rustc` of toolchain `1.89.0-aarch64-apple-darwin` (`798a97c0…89c5`, `af4a9eb3…c21c`), and Command Line Tools `clang` (`1590ac95…a0c9`), `ar` (`85d15bd3…cbd7`) and `ld` (`374d9f07…42e4c`). The SDK `MacOSX27.0.sdk` must be a real folder. **Stop if** any of these is set: `RUST*`, `CARGO*`, `CC`, `CXX`, `AR`, `LD`, `CFLAGS`, `CXXFLAGS`, `CPPFLAGS`, `LDFLAGS`, `SDKROOT`, `DEVELOPER_DIR`, `MACOSX_DEPLOYMENT_TARGET`, `LD_*`, `DYLD_*`. The run uses `env -i` with only `HOME`, `CARGO_HOME`, `TMPDIR` (the dedicated folder), a fixed `PATH` (toolchain, Command Line Tools, `/usr/bin`, `/bin`), `RUSTC`, `CC`, `AR`, `SDKROOT` and the linker (`CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER`), all set to those pinned files, plus `CARGO_NET_OFFLINE=true`. It calls the toolchain's own `cargo` directly, **bypassing the rustup proxy, so nothing is downloaded**, with `--locked --offline`. |
| 6 | The whole tracked state, before and after | Before: HEAD `9fe9018e…`, SHA-256 of `git status --porcelain=v1 -z` `458ebc6e…a1b`, and SHA-256 of `git ls-files -s` (the index) `013c8679…fa7` must all equal the audited values. After: the same three must be unchanged, or the script exits 5 ("worktree changed"). The worktree is only read: nothing is written, restored or staged there. |

**Unchanged from v1:**
- the archived paths: `rust-toolchain.toml`, `workstreams/04-execution`, `frontier-abi`, `permutation-rules` at `23c549d3`;
- the file hashes: `gateway.rs` `906b5507…`, `gateway_facts.rs` `5f161455…`, `Cargo.lock` `e740c00c…`;
- the command: `cargo test --locked --offline --test gateway_facts`, once;
- the log in the scratchpad's `logs/`;
- the run folder, kept as evidence.

**Found while reviewing v2's own text:** the first draft used `declare -A`, which macOS's `/bin/bash` 3.2 does not have. It now uses a plain `path:hash` list.

**Not covered by the guards:**
- When the build is stopped, `pkill -P` reaches `cargo`'s direct children. A grandchild (a C compile under a build script) ends when its parent does, or at the KILL.
- The 16 build scripts and 6 proc-macros run with the pinned tools and environment. Their sources were not audited line by line.

## Still not one of the refused tests

The run touches only ④'s crate, its two path crates and the toolchain pin, with the test's own loopback stub. It has nothing to do with a world, a runner, walls-items, muster, ⑬'s guard tests, group G or H. Nothing in v2 changes that.

**Approval needed for one run:** a cargo build with C compilation (`libsqlite3-sys`), offline use of the local crate cache, loopback binds on `127.0.0.1:0`, and the pinned tools above.
