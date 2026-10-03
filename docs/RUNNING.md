# Running Wylls locally

Everything here is local: a test chain on your machine, no wallet, no devnet, no paid service. Nothing of the new game has run on devnet or mainnet. Commands were written and run on macOS; CI runs the tests on Linux; a full stack run on Linux is not recorded. Back to the [README](../README.md).

## 1. The practice page (no chain, no build)

The practice battle needs only the page and its WebAssembly rules kernel (checked against its published sha256 when loaded). From the repository root, with Python 3:

```sh
cd permutation-server/web && python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/frontier/practice.html   (JA or EN follows your browser; toggle at top right)
```

Serve from `permutation-server/web`, not from `frontier/`: the page imports shared modules from the web root. Without a herald the page shows a "no season" notice and practice still runs. Checked 2026-10-03 on Python 3.13.1 in a scratch clone by a reviewer: the page loads, the painted art loads, and a practice clash runs; the only 404s are the `/h/` herald endpoints. Older Python versions were not tested.

## 2. The full local stack (the game, on a local test chain)

Needs, installed by you (nothing here installs anything):

- Rust via `rustup`, with both pinned toolchains: `rustup toolchain install 1.89.0 1.95.0 --profile minimal`. The root workspace, `permutation-rules` and `permutation-server` pin 1.89.0; `frontier-node`, `frontier-wasm` and the `svm-tests` folders pin 1.95.0. The `wasm32-unknown-unknown` target for 1.95.0 is only needed for `scripts/build-wasm.sh`.
- The Solana SBF tools for the program build: `cargo-build-sbf` from Agave 3.1.9 (platform-tools v1.52), expected under `~/.local/share/solana/install/active_release/bin`.
- Node 20 or later and `curl`. Cargo and npm need internet access to fetch crates and packages.

A quick stack uses the **test beacon** (a test drand key) and needs no archive. These are the commands of [`run-onboarding.sh`](../permutation-gateway/screens/live/run-onboarding.sh), [`m1-nightly.sh`](../scripts/m1-nightly.sh) and [RUN-A-KEEPER](frontier/m1/RUN-A-KEEPER.md).

```sh
(cd frontier-node && cargo build --locked --release --workspace)
scripts/build-frontier.sh --features test-beacon        # test-beacon program, never deployable
S=frontier-node/target/release/frontier-stack           # holds only if CARGO_TARGET_DIR is unset
$S check-ports --config frontier-node/configs/w5-smoke.toml --base-port 41000

# `up` stays in the foreground for the whole run (1 game day at 20x is about 72 minutes).
# Run it in this terminal; do the next steps in a SECOND terminal.
$S up --mode accel --beacon test-key --scale 20 --days 1 --bots 20 --run-id try --base-port 41000

# --- second terminal ---
# Wait for the herald (about a minute), then open the client:
#   http://127.0.0.1:41040/frontier/frontier/        (the herald serves it; port = base + 40)
# When you are done (or press Ctrl-C in the first terminal):
S=frontier-node/target/release/frontier-stack
$S down --run-id try
```

Ports are 41000 to 41999 only. Open **`/frontier/frontier/`**, not `/`: the bare address still lands on an older page ([overview §8](DESIGN-OVERVIEW.md#8-what-is-not-built-honest-limits-roadmap), item 6).

**In the browser** the local flow joins with the page's built-in **Dev Wallet (localnet)**, a random key kept in the browser and usable on the local chain only. The in-game key is derived from that wallet's signature over a fixed text. No real wallet is involved.

**Known issue (found 2026-10-03, not fixed in this docs-only branch).** The herald's static file handler (`frontier-node/crates/herald/src/server.rs`, function `web`) accepts only `[A-Za-z0-9/._-]` in paths, but every painted-art file lives under a folder with an `@` in its name (`art/*/@1x/...`). So on the herald URL above, the painted terrain, props, fog and sites return 404 and the map looks plainer than the README screenshot (a reviewer counted 78 of 188 first-load requests failing). The static server of section 1 serves the art. The fix is one character (`b"/._-@"`), and a herald test is still to be written.

**The scripted browser run** (join, build, scout, sealed march, report, verify in the browser, JA and EN) is `permutation-gateway/screens/live/run-onboarding.sh --base-port 41000`, after `cd permutation-gateway/screens && npm ci && npm run browser` (that step downloads Chromium). The script starts `up` in the background itself.

**A 100-bot, 1-game-day nightly** with verifier and tamper suite: `scripts/m1-nightly.sh` (config `frontier-node/configs/nightly.toml`, 100x). Its commands, for a second terminal while `up` runs:

```sh
S=frontier-node/target/release/frontier-stack
$S up --config frontier-node/configs/nightly.toml --run-id try        # first terminal, about 15 to 20 minutes
# second terminal: http://127.0.0.1:41540/frontier/frontier/   (also practice.html, spectate.html)
$S verify --run-id try && $S tamper --run-id try
$S down --run-id try
```

## 3. The exit season itself

Needs a recorded drand archive that is **not in this repository** (real quicknet rounds, 246,001 of them) and about 8 h 39 min:

```sh
scripts/m1-run-s7.sh --adversary --viewer-window-hours 24 --run-id m1-exit
```

`--dry-run` does the full build first (release `frontier-node`, then the deployable `.so` and its checks) and only then prints the commands without starting the season; add `--no-build` as well to skip the build. The recorded result is [runs/m1-exit/](frontier/m1/runs/m1-exit/).

**Run a keeper:** [RUN-A-KEEPER](frontier/m1/RUN-A-KEEPER.md). Local stack only; no devnet or mainnet keeper exists.

## 4. Tests

Counts quoted in the README are from the M1 closing tree `864b622` and were not re-run on this branch for the README. To re-run:

```sh
cargo test --locked --release -p permutation-rules                    # rules kernels
(cd frontier-sim && cargo test --locked --release)                    # simulator and its gate
(cd permutation-gateway && npm ci --ignore-scripts && npm test)       # relay, SDK, web client
(cd permutation-gateway/screens && npm ci && npm run browser && node --test *.screen.mjs)
scripts/build-frontier.sh --twice                                     # reproducible release build
permutation-frontier/svm-tests/run.sh --release                       # program tests (RELEASE_CHECK=1 for the full gate)
(cd frontier-node && cargo test --locked --workspace)                 # off-chain workspace
scripts/build-wasm.sh --check                                         # WebAssembly module matches the source
scripts/check-v9-frozen.sh                                            # earlier-prototype files untouched (needs full git history)
```
