# Running Wylls locally

This integrated tree contains conquest, a test-asset prize pool and AI-citizen code. Since 2026-10-24 its program runs the **S1 rules** only (stage 1 of the redesign: arms, caravans, raids, towers, palisades, forts, nation votes; program version 4): every season the recipes below create is an S1 season, and the earlier M1 and conquest (MC) seasons need an earlier commit (section 6). The recipes below start a **local test chain** with test tokens ("test USDC", no value). The rebuild has not run on devnet or mainnet; the earlier prototype's devnet season used test USDC. A future mainnet season with live USDC is planned, not launched. No production wallet or paid model API is needed. Commands were developed on macOS; CI tests components on Linux, but a full Linux stack run is not recorded. See the [README](../README.md) for status and the [demo guide](pitch/DEMO_SCRIPT.md) for what the current recorded preview actually shows.

Ports are in 41000 to 41999 only. With base port `B`: the chain's RPC is `B+10`, the relay `B+33`, the herald (which serves the web client) `B+40`. The AI runs use base 41900, with the model server on 41901 and the council audit page on 41902. Use a clean checkout for an AI run: its guard refuses uncommitted changes to the code it measures.

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
- For AI runs only: a local llama.cpp `llama-server` and the Gemma 4 GGUF file (`gemma-4-26B-A4B-it-Q4_0.gguf`). The model weights are not in this repository. No paid API is used; the run script refuses to start if a paid-API key variable is set.

Build, from the repository root:

```sh
scripts/build-frontier.sh --features test-beacon     # the game program with the test randomness beacon; never deployable
scripts/build-prize.sh                               # the prize pool program (test assets)
npm ci --prefix permutation-gateway
(cd frontier-node && cargo build --locked --release --workspace)
```

## 3. A browser world: conquest and the test-asset prize pool

`up` stays in the foreground; use a second terminal for everything else. The flags below mirror [`ai-cq-season.toml`](../permutation-gateway/citizens/stack/ai-cq-season.toml) without bots or AI: 16 game hours (96 turns) at 10x, ended at the end of play so that provinces can be tallied. This makes a **new** world, not the recorded `own1` ledger.

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

- **The world is an S1 season** (`S1_LOCAL_14D` cut to the flags above; `--s1` is accepted as another name for `--conquest`). The page loads the S1 rules module `wasm/frontier-v3.wasm` (committed; `scripts/build-wasm.sh --s1 --check` rebuilds it) and reads the herald's S1 feeds `h/caravans.json`, `h/structures.json` and `h/nations.json` (404 `NotYet` until a record writes one). Played on 2026-10-26 in a short local world: joining (the button waits for the first turn), the ore lens, a workshop, strong units priced in arms, a sealed march with its forecast, and "Verify in this browser" on its report. The S1 orders are on a chosen tile's card ("ここに建てる": storehouse, watchtower, palisade, fort; a won raid to take or burn) and in the village drawer ("交易と防備": caravans to another of your places, fort garrisons, the nation's stances and votes). Tried the same day: a palisade, a storehouse, and a caravan of food delivered to it.
- **Script bots play an S1 world with `--bots-args "--s1"`** (the conquest layer with the S1 budgets and the S1 candidates). With `--conquest` alone they take villages but send with the conquest (MC) budgets; with neither they take no village.
- If the page reports `WasmHashMismatch`, the browser kept a rules module from an earlier world served on the same port; reload it without the cache.
- Open **`/frontier/frontier/`**, not `/`: the bare address lands on an older page.
- A conquest run ID is used once: `up` refuses an existing conquest world. Use a new `--run-id` and `--season` for another world. Do not start it on occupied ports.
- `--entry-fee` is in base units of the 6-decimal test mint: `25000000` is 25 test USDC. `--prize-so` needs `--conquest`.
- In a short season every conquest timer is capped at the season length. Without `--game-hours` and `--season-end-at-play-end` the season is the 14-day preset.
- Leave `--prize-so` and `--entry-fee` out for a world with free joining.

**In the browser.** The page joins with its built-in **Dev Wallet (localnet)**, a random key kept in the browser and usable on the local chain only. On a prize world, press "Get test USDC" on the join screen, then join: the entry fee and Join are one transaction. A private browser window on the same address gets a separate test wallet. In the Nation & territory tab (国と領土), "See the keeps you can reach" lists keeps your army can reach; a march can cross at most 4 provinces.

**Several players in one world.** The Dev Wallet is kept per browser origin, so each of `http://p1.localhost:41940/frontier/frontier/`, `http://p2.localhost:41940/…`, … is a separate player with its own test wallet (browsers resolve `*.localhost` to 127.0.0.1; nothing to configure). Each one gets test USDC and joins on its own. A player's own village, storehouses and hosts are only theirs; a raid, a seizure or a siege needs a player of another nation. A vote needs three villages of one nation that joined at least 288 turns earlier (`ELIGIBLE_BELLS`), so put three players in one nation and run the world at least 300 turns.

**Growing the map in a local world (verification only).** The world grows by rings as the program's rule says (OpenRing when a wedge is crowded past θ, a turn since the last ring, the wedge funds able to pay, at most `r_max`); the keeper sends it. Two `up` flags change only the local season's parameters, for verification, and leave every preset and the program unchanged: `--ring-theta-bps N` (θ for both phases, 0..10000; with 100, two villages of one nation open ring 5 of the genesis-4 map) and `--r-max N` (the last ring; with 6 the season's border is drawn two rings past the open land). `frontier-stack land --run-id ID` prints the rings, their seed state and how many Provinces of each are on chain, and why the next ring waits; `--do open-ring` and `--do open-province --at P,Q` send the program's own permissionless instructions, which the program refuses as it would anyone's (`AlreadyDone` for a Province or ring that exists, `BadData` beyond `r_max`, `SeedNotReady`, `Capacity`, `TooEarly`). `scripts/map-growth-measure.py sample|summary --run-dir frontier-node/.local/frontier/ID` records memory, herald answer times and turn completion against the number of Provinces. See `docs/frontier/map-growth/README.ja.md`. `--keeper-rest` writes `rest = true` into keeper A's `keeper.toml`: resting S1 Provinces are no longer written every turn but fast-forwarded (FastForward) when something wakes them. It is off by default and for local measurement only: until the herald shows the stored score plus the proven tail (stage 4 of `docs/frontier/map-growth/keeper-load-rules.ja.md`), the herald's per-turn map and standings go stale between wake-ups.

The recorded Chrome human-operation world was `own1`, season 100, served from commit `fa13d486` on a **separate local test chain**, with no bots or AI personas. A 72-turn clock advance separates the clash and later occupation footage. The command above does not replay that ledger or film. The current preview shows an ongoing test-USDC season, not its final winner or payout.

## 4. A combined AI season

The example below runs conquest, the test-asset prize pool, 6 AI citizens and 6 script bots in one world for 96 play turns: about 1 h 40 min of play at 10x, plus the drain. It is a new run, **not** the saved `take-1` footage. The world is an S1 season. The brain offers the AI citizens three S1 actions (a caravan from a near-full store, an ambush on another nation's caravan road, an escort of their own), not storehouses, structures, raid decisions or votes; two runs with the model under the S1 rules (`s1-model-1`, `s1-model-2`, this recipe with `ai-cq-season.toml` and `smoke.json`) and one with the stand-in mind below are recorded in [S1-SEASON-RUN](frontier/stage1f/S1-SEASON-RUN.md). On a conquest (S1) stack config the runner gives the AI fleet `--s1`. With Homebrew's llama.cpp, `AI_LLAMA_DIR` is its Cellar folder (`/opt/homebrew/Cellar/llama.cpp/<version>`) and `LLAMA_SERVER` the `bin/llama-server` inside it. One AI stack runs at a time (a lock shared by every worktree). The guards refuse dirty measured code, busy ports and paid-API key variables; `--check` runs the guards only and `--dry-run` prints the plan without starting a stack. Use fresh run IDs. The shorter [`ai-cq-demo.toml`](../permutation-gateway/citizens/stack/ai-cq-demo.toml) has 60 play turns and no prize pool.

```sh
export AI_MODEL=/absolute/path/to/gemma-4-26B-A4B-it-Q4_0.gguf
export AI_LLAMA_DIR=/absolute/path/to/llama.cpp
export LLAMA_SERVER="$AI_LLAMA_DIR/build/bin/llama-server"   # adjust for your build; binary must lie in AI_LLAMA_DIR
mkdir -p .local/frontier
export AI_RUNS_MD="$PWD/.local/frontier/ai-RUNS.md"           # local run log; no repository commit
permutation-gateway/citizens/llama/start-pinned.sh .local/frontier/llama.log &   # wait for http://127.0.0.1:41901/health
RUN=permutation-gateway/citizens/bin/ai-citizens-run.sh
STACK=permutation-gateway/citizens/stack/ai-cq-season.toml
CONFIG=permutation-gateway/citizens/config/smoke.json
$RUN --stack "$STACK" --citizens-config "$CONFIG" --deck deck-1 --run-id my-season --check
$RUN --stack "$STACK" --citizens-config "$CONFIG" --deck deck-1 --run-id my-season --dry-run
$RUN --stack "$STACK" --citizens-config "$CONFIG" --deck deck-1 --run-id my-season --hold 1800
```

- The game: `http://127.0.0.1:41940/frontier/frontier/`. The council page: `http://127.0.0.1:41902/council.html`.
- People join in the browser by paying the entry fee. Join from the game address on port 41940: the council page's proxy on 41902 does not forward the x402 payment header yet. The AI citizens and the script bots join by operator invites the stack mints; they pay nothing and are not prize-eligible.
- `start-pinned.sh` reads `AI_MODEL` and `LLAMA_SERVER`; the runner checks the live binary is inside the measured `AI_LLAMA_DIR` tree. The runner does not start or stop `llama-server`; stop only the process you started when done.
- `--hold SECS` keeps the completed chain, herald, relay and council page up for inspection and tallying. `touch .local/frontier/ai/<run id>/state/hold.stop` ends the hold. The runner then stops the stack it started.
- Output goes to `.local/frontier/ai/<run id>/`: `pub/` (the published files the council page and `verify-minds` read), `report.md`, `logs/`. `.local/` is not committed.
- **Without the model: a stand-in mind.** `permutation-gateway/citizens/probe/mock-mind.mjs` answers the brain's `/v1/decide` and `/v1/outcome` with a fixed rule (an S1 caravan when a store is near full, an ambush or escort the brain offers, a favourable camp, muster, train, an ore mine, one workshop, other builds, else the routine) and logs every observation digest, offer and choice to a JSONL file with `"mock": true`. It runs the same brain, the same candidates and the same sends as a model would, on a port in 41901–41999, and it is **not** AI behaviour: use it to check the pipeline and the S1 candidates, never as evidence of what a model does. Example against a world on base 41700 (the fleet's AI slots and invites are the stack's):

  ```sh
  node permutation-gateway/citizens/probe/mock-mind.mjs --port 41981 --token-file .local/ai/mind.token --log .local/ai/mock-mind.jsonl &
  frontier-node/target/release/frontier-bots --herald http://127.0.0.1:41740 --relay http://127.0.0.1:41733 --rpc http://127.0.0.1:41710 \
    --seed 72 --first-index 1000 --bots 7 --game-hours 80 --scale 40 --personas off --s1 --conquest-personas 0 \
    --ai-slots .local/ai/ai-slots.json --brain http://127.0.0.1:41981 --brain-token-file .local/ai/mind.token \
    --journal .local/ai/fleet --report .local/ai/fleet/report.json --control 127.0.0.1:41771 \
    --invites frontier-node/.local/frontier/<run id>/relay/fleet-invites.txt
  ```
- The current preview's AI scene is from saved run `take-1` at commit `aae47bdb`: real Gemma 4, a model-chosen march and build, and `verify-minds` PASS. It is **not** an AI response to `own1`. A later `take-2` failed one `verify-minds` item after early speech release and is not used for that scene. A new run must be judged by **its own** `pub/verify-minds.json`.

## 5. Verify

All three verifiers are the project's own; none is an independent audit.

**A clash, in the browser.** Open a clash report in the client and press "Verify in this browser".

**A whole season's log.** `frontier-stack verify --run-id <id>` and `frontier-stack tamper --run-id <id>` pick the ruleset hash from the run's season. The standalone `frontier-verify` defaults to M1's hash, so on an S1 world pass the S1 one (`RULESET_HASH_V3` in `frontier-abi/src/v2/presets.rs`):

```sh
V=frontier-node/target/release/frontier-verify
R=234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d
$V --program <program id from state.json> --season <N> --rpc http://127.0.0.1:41910 --localnet --test-key --ruleset $R \
  --out .local/verify --save .local/verify/fixture.json.gz
$V tamper --fixture .local/verify/fixture.json.gz --test-key --ruleset $R --out .local/tamper
```

A tamper class whose record the run never made (no vote, no siege, no revealed bad seal) is reported "not applicable", and then the suite exits 2 ("Required classes detected: no") even though every class it could judge was detected; read the table, not only the exit code.

**The province tally, the recount and the achievements ledger** (after the season has ended; ports of base 41900):

After an AI season completes, the stack leaves the local chain **paused**. Resume it before settling, or the Tally transaction will not land. From the repository root, while the run is held, use zsh or bash:

```sh
scripts/demo-clock.sh 41900 resume
RUN_ID=my-season
U=(--rpc http://127.0.0.1:41910 --relay http://127.0.0.1:41933 --herald http://127.0.0.1:41940)
node permutation-gateway/scripts/prize-settle.mjs "${U[@]}" --out ".local/prize/$RUN_ID" \
  --ledger-file "frontier-node/.local/frontier/$RUN_ID/relay/prize-ledger.json"
node permutation-gateway/scripts/prize-settle.mjs "${U[@]}" --check
node permutation-gateway/scripts/prize-settle.mjs "${U[@]}" --verify ".local/prize/$RUN_ID/ledger.json"
```

The first command sends Tally and Finalize and writes an **estimated** split; `--check` independently recounts provinces without sending; `--verify` re-derives the saved ledger. The URL flags are an array because zsh passes a plain quoted multi-flag variable as one argument.

The contribution weights, tie-break and fallbacks are provisional ([`prize-params.json`](../permutation-gateway/src/frontier/prize-params.json)), and the output says so. `--set-shares` and claims are deferred settlement steps; they are exercised by `prize-e2e.mjs` with `PRIZE_E2E_CLAIM=1` and are not in the recorded preview.

**AI decisions.** The run script runs `verify-minds` itself at the end of a run and writes `pub/verify-minds.json`. To run it again while the stack is held:

```sh
RUN_ID=my-season
AI_DIR=".local/frontier/ai/$RUN_ID"
mkdir -p .local/frontier/verify
node permutation-gateway/citizens/verify-minds.mjs --herald http://127.0.0.1:41940 --rpc http://127.0.0.1:41910 \
  --ai-dir "$AI_DIR" --repo . --stack "$AI_DIR/stack.toml" \
  --citizens-config permutation-gateway/citizens/config/smoke.json --llm http://127.0.0.1:41901 \
  --model "$AI_MODEL" --llama-dir "$AI_LLAMA_DIR" \
  --out ".local/frontier/verify/$RUN_ID-recheck.json"
```

Exit code 0 is PASS, 1 FAIL, 3 INCOMPLETE. The model and llama.cpp options compare the files against the run's commitments.

**A memory comparison** can resend one stored decision with and without a cited event's memory lines using `permutation-gateway/citizens/probe/memory.mjs`. It is a separate experiment. A citation in a recorded decision alone does not show that memory changed the choice.

**End-to-end checks of the prize path** on a disposable stack: `permutation-gateway/scripts/prize-e2e.mjs` (three paid joins, an unpaid Join refused by the relay and on chain, a capture, the season's end, tally, ledger, `--verify`) and `prize-mixed-check.mjs` (a paying person, invited script bots and an invited AI fleet in one gated world). Each file's header gives its environment variables.

## 6. Earlier rule sets (M1 and MC)

The program built from this tree creates S1 seasons only: CreateSeason refuses any other `program_version` (`permutation-frontier/src/proc/season.rs`), and `frontier-stack up` without `--conquest` still asks for an M1 season, so it stops at CreateSeason. The commands below therefore need a checkout of an earlier commit, built there with its own scripts:

| Rule set | Last program of that rule set on `main` | Evidence made with it |
|---|---|---|
| M1 (no conquest, no prize pool) | `bff5087e` (before [PR #4](https://github.com/r0ze998/wylls/pull/4), 2026-10-11) | the M1 exit season |
| MC (conquest, prize pool) | `2321d557` (before [PR #11](https://github.com/r0ze998/wylls/pull/11)); the season-complete work at `adb4ac98` | `own1`, `take-1`, the 14-day season of 2026-10-17/18 |

These checkouts were not re-run on 2026-10-26. On an M1 checkout:

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
