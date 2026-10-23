# Verifying the agent wallet yourself (fourth round, 2026-10-17)

Every claim in the reports can be checked from this worktree without trusting the reports. Localnet only; test tokens only; no paid API. Paths are relative to the worktree root (`feature/agent-wallet`).

## 1. The unit and module tests (minutes)

```sh
cd permutation-gateway && npm test                      # the whole suite (the count is in the report)
node --test test/agent-wallet-*.test.mjs                # the agent wallet alone: gateway, money, runner, server, review, billing, triggers, caps, regression
```

What each file pins (DESIGN.md §8):

| File | Claims |
|---|---|
| `test/agent-wallet-caps.test.mjs` | a released hold never gives the day's call count back (stop, TTL, deadline, operator refund; the cap then refuses; the scheduler's cap reads the same count; the view shows the new day before any hold); a burst of owner commands is one call per owner gap and the caps hold; `settle` records the credential (token fingerprint, address) and keeps the body's `by` as `claimedBy`; what the model is told (state, catalog, no secret) and what the decider refuses (Train n=0, an unaffordable answer) |
| `test/agent-wallet-regression.test.mjs` | the daily cap across a UTC midnight, a restart and a call that began the day before; the herald's recorded shapes (`test/fixtures/`): an arrival and a camp are events, a quiet turn is not, an unchanged world asks nothing |
| `test/agent-wallet-triggers.test.mjs` | no call on an unchanged state; turn / event / owner triggers; the minimum gap, the owner gap, the operator's cap, the owner's `callsPerDay`; one call per agent at a time; the digests over fields; the herald's real province shape (`{bytes, slots}`) |
| `test/agent-wallet-billing.test.mjs` | restart and TTL → `unresolved` (never guessed); late results; operator settlement audited and never double; the deadline rule behind its flag; sponsored deposits; no action from a stale decision |
| `test/agent-wallet-gateway.test.mjs`, `-money`, `-runner`, `-server`, `-review` | the earlier rounds: auth, idempotency, holds, withdrawals, deposits by instruction, config flags, the review's findings |

## 2. The deadline rule on localnet (about 70 minutes, unattended)

Needs the builds of `frontier-node`, `permutation-frontier` (test beacon) and `permutation-prize` (docs/RUNNING.md §2). Ports 41000–41999 only; pick a free hundred (`lsof -nP -iTCP -sTCP:LISTEN`).

```sh
RUN=agent-e2e-10; R=$PWD/frontier-node/.local/frontier/$RUN/relay     # do not create the directory: the stack refuses an existing run id
FRONTIER_AGENT_WALLET=1 FRONTIER_AGENT_RUNNER=1 FRONTIER_AGENT_TICK_MS=5000 FRONTIER_AGENT_RECONCILE_MS=5000 \
FRONTIER_AGENT_LLM_URL=http://127.0.0.1:41698 FRONTIER_AGENT_UNRESOLVED_RELEASE_MS=3600000 \
FRONTIER_AGENT_CUSTODY_KEY_FILE=$R/agent-custody.json FRONTIER_AGENT_KEYS_DIR=$R/agent-keys \
frontier-node/target/release/frontier-stack up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 \
  --game-hours 16 --season-end-at-play-end --bots 0 --personas off --prize-so permutation-prize/target/deploy/permutation_prize.so \
  --entry-fee 25000000 --run-id $RUN --base-port 41600 --season 99 &
# then, once http://127.0.0.1:41640/h/season answers:
AGENT_E2E_URL=http://127.0.0.1:41640 AGENT_E2E_RPC=http://127.0.0.1:41610 AGENT_E2E_MODEL_PORT=41698 \
AGENT_E2E_SCENARIO=unresolved AGENT_E2E_RUN_DIR=$PWD/frontier-node/.local/frontier/$RUN AGENT_E2E_OPERATOR_URL=http://127.0.0.1:41630 \
AGENT_E2E_WAIT_RELEASE_MS=4800000 AGENT_E2E_OUT=$PWD/.local/agent-wallet-e2e/my-unresolved \
node permutation-gateway/scripts/agent-wallet-e2e.mjs
frontier-node/target/release/frontier-stack down --run-id $RUN
```

The transcript's `scenario` steps show: the call in flight (a `running` hold), the relay killed (-9) and back in about 2.5 s with the hold `unresolved` (reason `restart`, nothing charged), the owner's stop and full withdrawal with exactly the unresolved amount left reserved, the release after the hour (`auto-release`, the day's call count unchanged, the operator's `released-call` record), the owner's cap counting the released call (no model call in auto; the autopilot's free Harvest), and the last withdrawal (`deposited = withdrawn`). The 2026-10-17 run is `.local/agent-wallet-e2e/run8-unresolved-1h/transcript.json`.

## 3. The model's judgement by situation (a minute, needs the local model)

```sh
sh permutation-gateway/citizens/llama/start-pinned.sh /tmp/llama.log &      # Gemma 4 26B A4B Q4_0 on 127.0.0.1:41901; wait for "model loaded"
AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_OUT=$PWD/.local/agent-wallet-e2e/my-bench node permutation-gateway/scripts/agent-decision-bench.mjs
```

`report.md` is the table (situation, expected, the model's answer and fields, right/wrong/invalid, latency); `report.json` has every prompt and reason. Temperature 0 and a fixed seed: the same model gives the same answers. The runs of 2026-10-17 are `bench-1` … `bench-4` (DESIGN.md §12.2).

## 4. The real model in the live world (about 15 minutes)

As §2 but with the model server: `FRONTIER_AGENT_LLM_URL=http://127.0.0.1:41901 FRONTIER_AGENT_TICK_MS=8000 FRONTIER_AGENT_MIN_CALL_GAP_MS=30000`, then `AGENT_E2E_MODEL=real AGENT_E2E_LLM=http://127.0.0.1:41901 AGENT_E2E_WINDOW_MS=420000 node permutation-gateway/scripts/agent-wallet-e2e.mjs`. The transcript's `model` and `window` sections record the model (`/props`), every decision with the model's own reason, the charges, and the window's calls, cost, actions and skips.

## 5. The page in a real browser (about 3 minutes; Google Chrome, no Playwright, no extension)

`scripts/agent-page-browser.mjs` drives Google Chrome (headless, the DevTools protocol over the `ws` package already in `node_modules`) through the page as a visitor gets it: real clicks, typed values, the page's own modules signing with its dev wallet, the herald's CSP on. It is not the fake-DOM smoke. Start a stack whose relay's model URL is the stand-in this script serves (the E2E's command with `FRONTIER_AGENT_LLM_URL=http://127.0.0.1:41698`, `FRONTIER_AGENT_TICK_MS=5000`), then:

```sh
AGENT_PAGE_URL=http://127.0.0.1:41640 AGENT_PAGE_RPC=http://127.0.0.1:41610 AGENT_PAGE_MODEL_PORT=41698 \
AGENT_PAGE_OUT=$PWD/.local/agent-wallet-e2e/my-browser node permutation-gateway/scripts/agent-page-browser.mjs
```

(`AGENT_PAGE_DEVTOOLS_PORT` picks Chrome's DevTools port, default 41697; set it to a free port in your own hundred when other stacks run beside yours. The window's `breakdown` in the E2E transcript takes refusals on chain and rests from the runner's outcome counters, since a refusal leaves no action line in the ledger; the independent review of 2026-10-17 found the earlier count read a refusal as a rest.)

18 steps with a screenshot and the page's text each (`report.json`, `NN-step.png`): connect, create, deposit, the policy form, the key handed over (confirmed on chain), auto, the runner's action on the page, a refused message signature and a refused transaction signature (the wallet rejects at the Wallet Standard boundary; nothing changes), offline and back, a reload, a stop while a model call is in flight and a withdrawal with that call running, the late result charged once, the key taken back, everything withdrawn. The console's errors and every failed resource are in `report.json` too. **Not covered:** a real wallet extension (Phantom, Backpack …) — its approval window cannot be driven here. The fake-DOM flow stays as `node permutation-gateway/scripts/agent-page-smoke.mjs` (DESIGN.md §10). The runs of 2026-10-17 are `.local/agent-wallet-e2e/browser-1` and `browser-2`.

## 6. Linux, and what the 2026-10-23 round added

* `scripts/agent-page-browser.mjs` on Linux: `CHROME=/opt/pw-browsers/chromium-<n>/chrome-linux/chrome AGENT_PAGE_CHROME_ARGS=--no-sandbox` (root in a container). It now waits for the action line, the decision line with the model's reason and the driver sentence (the word 判断 alone is on the page from the start), and has a 19th step: the owner's decision cap set from the page makes the free autopilot stand in, said apart from a stop.
* `permutation-gateway/screens/live/agent-manual.live.mjs` (Playwright): manual play on the play page, the hand-over on the agent page, the agent's action, the play page refused while delegated, the key taken back and the same village played by hand again; each hand-played action checked on chain.
* `node --test test/agent-wallet-mcp.test.mjs` (the MCP contract) and `test/agent-wallet-decisions.test.mjs`.
* A real model other than the pinned Gemma 4: `FRONTIER_AGENT_LLM_ALIAS=<the loaded model>`; `FRONTIER_AGENT_LLM_STRICT_SCHEMA=1` for the opt-in schema; `AGENT_BENCH_STRICT=1` for the bench.
