# Running Wylls locally

Everything here is local: a test chain on your machine and test tokens ("test USDC", no value). No real wallet, no devnet, no paid service. This build has not run on devnet or mainnet. Commands were written and run on macOS; CI runs the tests on Linux; a full stack run on Linux is not recorded. Back to the [README](../README.md).

Ports are in 41000 to 41999 only. With base port `B`: the chain's RPC is `B+10`, the relay `B+33`, the herald (which serves the web client) `B+40`. The AI runs use base 41900, with the model server on 41901 and the council page on 41902.

## 1. The practice page (no chain, no build)

The practice battle needs only the page and its WebAssembly rules kernel (checked against its published sha256 when loaded). From the repository root, with Python 3:

```sh
cd permutation-server/web && python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/frontier/practice.html   (JA or EN follows your browser; toggle at top right)
```

Serve from `permutation-server/web`, not from `frontier/`: the page imports shared modules from the web root. Without a herald the page shows a "no season" notice and practice still runs.

## 2. Prerequisites and build

Installed by you (nothing here installs anything):

- Rust via `rustup`, with both pinned toolchains: `rustup toolchain install 1.89.0 1.95.0 --profile minimal`. The root workspace, `permutation-rules` and `permutation-server` pin 1.89.0; `frontier-node`, `frontier-wasm` and the `svm-tests` folders pin 1.95.0. The `wasm32-unknown-unknown` target for 1.95.0 is only needed for `scripts/build-wasm.sh`.
- The Solana SBF tools for the two programs: `cargo-build-sbf` 3.1.9 (Agave 3.1.9, platform-tools v1.52), expected under `~/.local/share/solana/install/active_release/bin`. Both build scripts refuse another version.
- Node 20 or later and `curl`. Cargo and npm need internet access to fetch crates and packages.
- For AI runs only: llama.cpp (`llama-server`) and the Gemma 4 GGUF file (`gemma-4-26B-A4B-it-Q4_0.gguf`). No paid API is used; the run script refuses to start if a paid-API key variable is set.

Build, from the repository root:

```sh
scripts/build-frontier.sh --features test-beacon     # the game program with the test randomness beacon; never deployable
scripts/build-prize.sh                               # the prize pool program (test assets)
npm ci --prefix permutation-gateway
(cd frontier-node && cargo build --locked --release --workspace)
```

## 3. A world for people: conquest and the prize pool

`up` stays in the foreground; use a second terminal for everything else. The flags below are the settings of [`ai-cq-season.toml`](../permutation-gateway/citizens/stack/ai-cq-season.toml) without bots: a short season of 16 game hours (96 turns) at 10x, ended at the end of play so that the provinces can be tallied.

```sh
S=frontier-node/target/release/frontier-stack           # holds only if CARGO_TARGET_DIR is unset
$S up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 \
  --game-hours 16 --season-end-at-play-end --bots 0 --personas off \
  --prize-so permutation-prize/target/deploy/permutation_prize.so --entry-fee 25000000 \
  --run-id try-cq --base-port 41900 --season 90

# --- second terminal ---
# http://127.0.0.1:41940/frontier/frontier/
$S down --run-id try-cq
```

- Open **`/frontier/frontier/`**, not `/`: the bare address lands on an older page.
- A conquest run id is used once: `up` refuses an existing conquest world. Use a new `--run-id` (and `--season`) for a new world.
- `--entry-fee` is in base units of the 6-decimal test mint: `25000000` is 25 test USDC. `--prize-so` needs `--conquest`.
- In a short season every conquest timer is capped at the season length. Without `--game-hours` and `--season-end-at-play-end` the season is the 14-day preset; the saved-world recipe (`--keep-running`, `resume`) is in the [playable conquest runbook](frontier/conquest/PLAYABLE-2026-10-06.md).
- Leave `--prize-so` and `--entry-fee` out for a world with free joining.

**In the browser.** The page joins with its built-in **Dev Wallet (localnet)**, a random key kept in the browser and usable on the local chain only. On a prize world, press "Get test USDC" on the join screen, then join: the entry fee and the Join are one transaction. A private (incognito) window on the same address gets a separate test wallet, which is how a second person joins on one machine. In the Nation & territory tab (国と領土), "See the keeps you can reach" lists the keeps your army has a route to; a march can cross at most 4 provinces.

**A scripted second person** (joins the attacker's nation over x402 and marches to reinforce a keep; test tokens only):

```sh
DEMO_SUP_URL=http://127.0.0.1:41940 DEMO_SUP_RPC=http://127.0.0.1:41910 DEMO_SUP_RUN=sup1 \
  DEMO_SUP_NATION=0 DEMO_SUP_KEEP=4,-1 node permutation-gateway/scripts/demo-supporter.mjs
```

## 4. The combined AI season

Conquest, the prize pool, 6 AI citizens and 6 script bots in one world, 96 turns: about 1 h 40 min of wall time at 10x. One AI stack runs at a time (a lock shared by every worktree). The guards refuse to start when files under the guarded paths have uncommitted changes, when a port in the 41900 block is busy, or when a paid-API key variable is set; `--check` runs the guards only and `--dry-run` prints the plan.

```sh
export AI_MODEL=/path/to/gemma-4-26B-A4B-it-Q4_0.gguf
export AI_LLAMA_DIR=/path/to/llama.cpp                 # the tree that holds the llama-server binary
export AI_RUNS_MD=$PWD/.local/frontier/ai-RUNS.md      # write the run entry here instead of committing it to the repository's run list
permutation-gateway/citizens/llama/start-pinned.sh /tmp/gemma-41901.log &     # wait for http://127.0.0.1:41901/health
permutation-gateway/citizens/bin/ai-citizens-run.sh \
  --stack permutation-gateway/citizens/stack/ai-cq-season.toml \
  --citizens-config permutation-gateway/citizens/config/smoke.json \
  --deck deck-1 --run-id my-season --hold 7200
```

- The game: `http://127.0.0.1:41940/frontier/frontier/`. The council page: `http://127.0.0.1:41902/council.html`.
- People join in the browser by paying the entry fee. Join from the game address on port 41940: the council page's proxy on 41902 does not forward the x402 payment header yet. The AI citizens and the script bots join by operator invites the stack mints; they pay nothing and are not prize-eligible.
- `start-pinned.sh` reads `AI_MODEL`, and `LLAMA_SERVER` for the binary (default `/opt/homebrew/bin/llama-server`).
- `--hold SECS` keeps the chain, herald, relay and council page up after the season has ended, so that the result can be inspected and tallied. `touch .local/frontier/ai/<run id>/state/hold.stop` ends the hold.
- Output goes to `.local/frontier/ai/<run id>/`: `pub/` (the published files the council page and `verify-minds` read), `report.md`, `logs/`. `.local/` is not committed.
- [`ai-cq-demo.toml`](../permutation-gateway/citizens/stack/ai-cq-demo.toml) is the same world without the prize pool (60 play turns).

## 5. Verify

All three verifiers are the project's own; none is an independent audit.

**A clash, in the browser.** Open a clash report in the client and press "Verify in this browser".

**The province tally, the recount and the achievements ledger** (after the season has ended; ports of base 41900):

After an AI season completes, the stack leaves the local chain **paused**. Resume it first, or the Tally transaction never lands:

```sh
curl -s http://127.0.0.1:41910 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"frontier_resume","params":[]}'
```

```sh
cd permutation-gateway
U="--rpc http://127.0.0.1:41910 --relay http://127.0.0.1:41933 --herald http://127.0.0.1:41940"
node scripts/prize-settle.mjs $U --out ../.local/prize/season --ledger-file <stack run dir>/relay/prize-ledger.json   # Tally and Finalize (anyone may send them), ledger.json, settle.json with the ESTIMATED split; --ledger-file lets the relay serve the ledger to the prize panel
node scripts/prize-settle.mjs $U --check                           # independent recount from the province accounts; sends nothing
node scripts/prize-settle.mjs $U --verify ../.local/prize/season/ledger.json   # re-derive every ledger line from its transactions
```

The weights, the tie-break and the fallbacks are provisional ([`prize-params.json`](../permutation-gateway/src/frontier/prize-params.json)), and the output says so. `--set-shares` and the claims are the deferred settlement step; they are exercised by `prize-e2e.mjs` with `PRIZE_E2E_CLAIM=1` and are not part of the demo.

**AI decisions.** The run script runs `verify-minds` itself at the end of a run and writes `pub/verify-minds.json`. To run it again while the stack is held:

```sh
node permutation-gateway/citizens/verify-minds.mjs --herald http://127.0.0.1:41940 --rpc http://127.0.0.1:41910 \
  --ai-dir .local/frontier/ai/<run id> --repo . --stack .local/frontier/ai/<run id>/stack.toml \
  --citizens-config permutation-gateway/citizens/config/smoke.json --llm http://127.0.0.1:41901 \
  --out .local/frontier/verify/<run id>-recheck.json
```

Exit code 0 is PASS, 1 FAIL, 3 INCOMPLETE. Add `--model "$AI_MODEL" --llama-dir "$AI_LLAMA_DIR"` to have the model file and the llama.cpp tree hashed against the run's commitments.

**The memory comparison** (one stored decision, asked with and without the lines of one source event; each variant once):

```sh
cd permutation-gateway
node citizens/probe/memory.mjs --requests DIR --records STATE/records.jsonl --episodes PUB/memory \
  --decision <record id> --target event:<seq> --llm http://127.0.0.1:41901 --out-dir DIR --tokenize
```

**End-to-end checks of the prize path** on a disposable stack: `permutation-gateway/scripts/prize-e2e.mjs` (three paid joins, an unpaid Join refused by the relay and on chain, a capture, the season's end, tally, ledger, `--verify`) and `prize-mixed-check.mjs` (a paying person, invited script bots and an invited AI fleet in one gated world). Each file's header gives its environment variables.

## 6. The earlier M1 stack and the exit season

The first playable part (M1: no conquest, no prize pool) still runs:

```sh
S=frontier-node/target/release/frontier-stack
$S up --mode accel --beacon test-key --scale 20 --days 1 --bots 20 --run-id try --base-port 41000
# second terminal: http://127.0.0.1:41040/frontier/frontier/      then: $S down --run-id try
```

- The scripted browser run: `permutation-gateway/screens/live/run-onboarding.sh --base-port 41000`, after `cd permutation-gateway/screens && npm ci && npm run browser` (that step downloads Chromium).
- A 100-bot nightly with the replay verifier and the tamper suite: `scripts/m1-nightly.sh`.
- The M1 exit season needs a recorded drand archive that is **not in this repository** and about 8 h 39 min: `scripts/m1-run-s7.sh --adversary --viewer-window-hours 24 --run-id m1-exit`. Its recorded result is [runs/m1-exit/](frontier/m1/runs/m1-exit/).
- Run a keeper: [RUN-A-KEEPER](frontier/m1/RUN-A-KEEPER.md). Local stack only.

## 7. Tests

```sh
cargo test --locked --release -p permutation-rules                    # rules kernels
(cd frontier-sim && cargo test --locked --release)                    # simulator and its gate
(cd permutation-gateway && npm ci --ignore-scripts && npm test)       # relay, x402, prize, achievements, SDK, web client, council page
(cd permutation-gateway/screens && npm ci && npm run browser && node --test *.screen.mjs)
scripts/build-frontier.sh --twice                                     # reproducible release build
permutation-frontier/svm-tests/run.sh --release                       # game program tests
scripts/build-prize.sh && (cd permutation-prize/svm-tests && cargo test --locked)   # prize pool program tests (reads the built .so)
(cd frontier-node && cargo test --locked --workspace)                 # off-chain workspace
scripts/build-wasm.sh --check                                         # WebAssembly module matches the source
scripts/check-v9-frozen.sh                                            # earlier-version files untouched (needs full git history)
```
