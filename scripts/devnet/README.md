# scripts/devnet: the devnet dry run (DRAFT, 2026-11-18)

**The PLAYABLE profile (`devnet-playable-profile.json`) is deployed on devnet since 2026-11-23 (devnet-deploy-2); the S1 profile (`devnet-profile.json`) is not.** The dry run checks the deployable `permutation-frontier` `.so`, computes
what a devnet deploy and one season cost in SOL, and prints the plan and the exact commands. It sends nothing unless
its gate is open, and only r0ze opens it.

| File | What it is |
|---|---|
| `devnet-profile.json` | Cluster URL, allowed RPC hosts, program-id and upgrade-authority **placeholders**, rent rates, the season cost lines (sizes from `frontier-abi/vectors/v2/layouts.json`), the `operator` block read by `frontier-operator` |
| `plan.mjs` | The cost model, the `.so` checks (ported from `scripts/build-frontier.sh`), the send gate and the command list; no side effects of its own |
| `dry-run.mjs` | The command line: wires the real file system and processes into `plan.mjs` |
| `devnet-playable-profile.json` | The **playable lane**'s profile (owner decision B7: expedition / wide land + the land preview, version 0x4804; no Free City conquest kinds since P14 b, 2026-11-22): its own program-id placeholder, build `scripts/build-frontier-devnet-playable-sbf.sh`, required marker `PSF_DEVNET_PLAYABLE_BUILD`, cap = the loader's 10 MiB, measured devnet rent 5,080, and the `operator` block read by `frontier-operator` (preset `S1_DEVNET_WIDE_CONTINUOUS` since devnet-continuous-1: the continuous world, season 2; `S1_DEVNET_WIDE_7D` before) |
| `test/dry-run.test.mjs` | 40 tests (33 + 7 of ⑰ `--with-prize` / `prize.enabled`) with a fake file system and a fake Solana CLI (CI job `devnet-dry-run`, key-free) |
| `test/playable-profile.test.mjs` | 10 tests of the playable profile (marker drift guard both ways, cap, build wiring, gate) |
| `preflight.mjs`, `preflight-checks.mjs`, `test/preflight.test.mjs` | The **deploy-day preflight** (runbook §8 step 0): every MUST item checked read-only, one PASS / FAIL / WARN / SKIP line each with the fix; 34 tests with fakes (CI job `devnet-dry-run`) |
| `readonly-guard.mjs`, `test/readonly-guard.test.mjs` | The loopback guard of the read-only devnet runs (B5, #123): a read-method allow-list, batches refused, devnet-only upstream with a genesis check, spacing, a hard request budget, a JSONL log; and its tests |

```sh
node scripts/devnet/dry-run.mjs                  # check the existing .so, print the plan (rate 5,080 lamports/byte, measured on devnet 2026-11-18)
node scripts/devnet/dry-run.mjs --rate 6960      # the same at the old pre-SIMD-0437 rate
node scripts/devnet/dry-run.mjs --build          # build first (scripts/build-frontier.sh), then plan
node scripts/devnet/dry-run.mjs --build --twice  # reproducible build (two fresh target dirs, same hash)
node scripts/devnet/dry-run.mjs --players 200 --json
node scripts/devnet/dry-run.mjs --with-prize      # ⑰ (devnet/test USDC only): also check the epochs prize .so and add its cost; never sent
node scripts/devnet/dry-run.mjs --nft-resident      # ⑳ (devnet/local only, no sale): plan the nft-experimental build; the send gate stays closed
```

**The playable lane** (B7) is a second program with its own profile:

```sh
scripts/build-frontier-devnet-playable-sbf.sh --twice                                   # reproducible, key-free
node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json   # plan at 5,080 lamports/byte
node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json --build --twice
```

It is the land lane's code (`localnet-land-sbf`) as cargo feature `devnet-playable-sbf`, without the localnet lane's
`[0x45; 32]` program-id check, so it can run under a real program id. Each profile refuses the other's artefact:
the S1 profile refuses `PSF_DEVNET_PLAYABLE_BUILD`, and the playable profile requires it and refuses both localnet
markers. The build keeps the release profile (opt-level 3). Smaller profiles were measured and push S1 instructions
past the CU limits the clients request (reports/devnet-playable-lane.md).

**⑰ prize (`--with-prize`).** The owner reopened ⑰ on 2026-11-18, for devnet and test USDC only. A real-money prize on mainnet needs a legal review first. The profile's `prize` section is `enabled: false` (`true` includes it as `--with-prize` does). Its test mint is a placeholder, and it refuses Circle's mainnet USDC mint. `--with-prize` checks the `scripts/build-prize.sh --features epochs` artefact (SBPF v2, overflow checks, marker `PRZ_EPOCHS_TEST_USDC_BUILD`), then prints its deploy peak and rent per window. The send gate and its steps are the game program's only: this tool never deploys the prize program.

**`--build` stays key-free.** `cargo-build-sbf` writes `<name>-keypair.json` next to the `.so` when that file is
missing, and never reads it (agave v3.1.9 `platform-tools-sdk/cargo-build-sbf/src/post_processing.rs`:
`if !program_keypair.exists() { write_keypair_file(&Keypair::new(), …) }`). So before building, the dry run writes a
text placeholder (`PLACEHOLDER: not a key…`) there if nothing exists (creating `target/deploy/` on a fresh
checkout). An existing file is never changed. `--twice` builds into two temporary directories, and
`scripts/build-frontier.sh --twice` puts the same kind of placeholder in both and fails (exit 5) if either was
replaced.

**The send gate.** Every one of these must hold, or the dry run prints `SEND GATE: CLOSED` with the reasons and exits
without starting any process:

- `--i-have-r0ze-approval`;
- `--keypair FILE` (fee payer), `--program-keypair FILE` and `--upgrade-authority FILE`. Each must be an absolute
  path to a regular file with mode 600, owned by you and outside the repository. The script never reads these files;
  the Solana CLI does;
- `--approved-sha256 HEX`, equal to the `.so`'s `file_sha256`. The approval is for one artefact;
- `programId` and `upgradeAuthority` filled in the profile with real base58 addresses;
- an `https` RPC URL whose host is in `allowedRpcHosts`. Hosts naming mainnet or testnet are refused by the code
  itself, whatever a `--profile` file allows;
- a `.so` that passes every check.

With the gate open, it runs these steps in order and stops at the first failure:

1. `solana --version`. It must be 4.0.0 or newer: the 3.1.9 CLI cannot verify this program's BLS12-381 syscalls
   (`sol_curve_decompress`, `sol_curve_pairing_map`) and would stop with an ELF error. The build stays on
   `cargo-build-sbf` 3.1.9.
2. `solana address` on both key files. Each address must match the profile.
3. `solana balance`.
4. `solana program deploy … --max-len <round_up(1.25 × .so, 4 KiB)> --max-sign-attempts 50` (no `--use-rpc`: the public endpoint throttles `sendTransaction`, so the buffer writes go to the TPUs; runbook §5).
5. `solana program show`.
6. `solana program dump`. The dumped bytes, with trailing zeros removed, must hash to the `.so`'s `program_hash`.

**Cost.** A first deploy needs ProgramData rent + Program rent + fees at its peak (8.99 SOL at 5,080 lamports per
byte, devnet's rate as read on 2026-11-18, for today's `.so`; 12.31 SOL at the old 6,960), not twice that: the CLI funds the buffer with the ProgramData rent and the deploy returns it
before the ProgramData is paid. A later upgrade holds a returned buffer float (`upgrade(temp)` in the plan).

There is no airdrop, no `--final` (the upgrade authority is the only `AnnounceSeason` signer, I-51, so an immutable
program could never start a season) and no season step. The season setup (AnnounceSeason, CreateSeason,
InitBeaconLogs, InitShards) is a separate tool, `frontier-operator` (`frontier-node/crates/stack`), run **after** r0ze
has confirmed the deploy. It reads this profile (`rpcUrl`, the host lists, `programId`, `upgradeAuthority`,
`rent.assume`, `season.preset` and the `operator` block) and is a dry run unless given `--yes-send`. See the
runbook §6. The playable lane's season (`devnet-playable-profile.json`, preset `S1_DEVNET_WIDE_CONTINUOUS` (season 2, no end; was `S1_DEVNET_WIDE_7D`), version 0x4804,
plus WideSetRules) is the same tool built with `--features playable-lane`; on devnet a send also needs
`--i-have-r0ze-approval` and `--approved-sha256` (runbook §6b).

The full runbook: [`docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md`](../../docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md).

## Deploy-day preflight (`preflight.mjs`)

```sh
node scripts/devnet/preflight.mjs                                   # offline: toolchain, profile, key files, the .so on disk, planner at 5,080
node scripts/devnet/preflight.mjs --build                           # + rebuild with the profile's build script --twice (key-free)
node scripts/devnet/preflight.mjs --rpc https://api.devnet.solana.com   # + read-only devnet checks (OFF by default; B5)
node scripts/devnet/preflight.mjs --services start.sh --keeper-config keeper-a/keeper.toml   # on the host, from the repo root (services up)
node scripts/devnet/preflight.mjs --public-url https://<host>     # from a machine OUTSIDE the host (only its ep.* lines matter there)
node scripts/devnet/preflight.mjs --help                            # every flag
```

**What it can never do** (pinned by `test/preflight.test.mjs`): send a transaction, sign, airdrop or spend SOL (the
only processes it starts are `<cli> --version`, `rustup toolchain list` and, with `--build`, the profile's build script
with `--twice`, through an allow-list; the send flags of `dry-run.mjs` are refused outright); read or create a key
(the three deploy key files and keeper A's seed / token are `stat()`ed: present, regular, mode 600, yours, outside
the repository — never opened); contact a cluster without `--rpc` (then only `getGenesisHash`, `getVersion`,
`getMinimumBalanceForRentExemption`, `getMultipleAccounts`, `getBalance`, at most 8 calls 300 ms apart, mainnet /
testnet hosts refused, and a genesis other than devnet's stops it after the first call); print a secret (RPC URLs as
their host, env assignments in the services file by name).

| Line | MUST | Checks | PASS when |
|---|---|---|---|
| `play-local` | 1 | — | always SKIP (manual: `scripts/play-local.sh`, then `--wide`) |
| `tool.solana4` | 3 | `--solana4` (default `~/solana-4x/bin/solana`) `--version` | ≥ 4.0.0 (`plan.mjs` `MIN_SOLANA_CLI`) |
| `tool.build-sbf` | 3/6 | `active_release/bin/cargo-build-sbf --version` | `3.1.9` + `platform-tools v1.52` (what `build-frontier.sh` requires) |
| `tool.node`, `tool.cargo` | 3/6 | `node --version`, `cargo --version`, `rustup toolchain list` | node ≥ 20; toolchains 1.89.0 and 1.95.0 installed (the two `rust-toolchain.toml`) |
| `profile.shape` | 4 | the profile | cluster devnet, lane playable, 0x4804, marker, preset, keeper A roles + rings duty = runbook §8 step 5 |
| `profile.keys` | 4 | `programId`, `upgradeAuthority` | both filled with different 32-byte base58 addresses |
| `keys.files` (+ `keys.dir` WARN) | 4 | `--keys-dir` (default `~/wylls-devnet-keys`) `deployer.json`, `program-playable.json`, `authority.json` | stat only: present, regular, mode 600, owned, outside the repo, three different files |
| `so.build` | 6 | `--build`: the profile's build script `--twice` | exit 0 (else SKIP: the .so on disk is checked) |
| `so.checks`, `so.sha256`, `so.program_hash`, `so.size` | 6 | `plan.mjs` `checkSo` on the .so | checks pass; sha256 / program_hash = `67a33c92…06b3` / `8dcaef87…74bb` (or `--expect-*`, or the profile's `program.expectedSha256` / `expectedProgramHash`); so_len ≤ cap, ProgramData ≤ 10 MiB |
| `rpc.*` | 2/3/5 | `--rpc` only | devnet genesis; rent = a SIMD-0437 step (WARN if ≠ 5,080: the planner adds that rate); BLS + SBPF v2 active, SIMD-0500 inactive; program id free; authority ≥ 57.14 SOL (WARN), `--deployer-address` ≥ the planner's deploy peak at the rate just read (21.93 at 5,080, 30.03 at 6,960; WARN) |
| `plan.<rate>` | 2/5 | `plan.mjs`'s own dry run, offline, `--json` | totals and faucet request counts at 5,080 (and at `--measured-rate` / the rate read with `--rpc`) |
| `faucet` | 5 | — | always SKIP (funding is r0ze's) |
| `ep.tls`, `ep.hsts` (WARN), `ep.season`, `ep.game`, `ep.root` (WARN), `ep.xff`, `ep.ports` | 7/7b | `--public-url` only | https with a valid certificate (`--ca` for a test CA); `/h/season` cluster devnet + the profile's program (WARN `NoSeasonYet` before §6b); `/frontier/frontier/` is the game page; §8a: 15 `POST /gw/f/nudge {}` each with a forged `X-Forwarded-For` → 10 × non-429 then 429s; 41040/41050/41030/41033 closed on the public name (SKIP for a loopback URL) |
| `cfg.herald`, `cfg.gateway`, `cfg.keeper` | 7b | `--services FILE` (any shell script holding the §8 step 5–7 lines), `--keeper-config FILE` | herald `--source rpc --cluster devnet --rpc-min-gap-ms 100 --poll-ms 1000`, loopback `--listen`, `--public-host`, no test flags; gateway `--public-proxy xff`, no `--dev`, `--devnet-play` + ruleset hash, pool ≥ 150, ports, and the gateway's own `loadFrontierConfig` accepts it (when its `node_modules` exist); keeper `rpc_min_gap_ms` ≥ 250, roles + rings duty = profile, api loopback, seed / token mode 600 (a relative `token_file` / `master_seed_file` is looked up from the repository root: the keeper's working directory in runbook §8) |
| `witness` | 8 | — | always SKIP (retention is the provider's) |

Limits: the X-Forwarded-For check from ONE client cannot tell a proxy that sends no header from a right one (with
`--public-proxy xff` both put this client into one bucket): confirm from a second outside address that it gets its own
400s, and that the gateway log shows no growing `unattributed_client` count. Wait 20 s between two runs (the bucket
refills at 0.5/s), or the 429s start inside the first 10. A nudge answered with anything but 400 / 429 (e.g. 502: the
herald could not reach the gateway) is its own FAIL: the bucket cannot be judged from that run.

Exit codes: 0 no FAIL, 1 at least one FAIL (or the run stopped on an unexpected error: "NOT READY (no verdict)"), 2 bad
arguments (including any send flag of `dry-run.mjs`).


## Live-stack health check (`health.mjs`, `health-loop.sh`)

Read-only monitor for the devnet stack running on the operator's Mac (reports/devnet-deploy-2.md):
season driver, gateway starter/gateway, herald, keeper A, Cloudflare quick tunnel, join check.

    node scripts/devnet/health.mjs            # one line per check, then `overall OK|WARN|FAIL`; exit 0 / 1 / 2
    node scripts/devnet/health.mjs --no-rpc --no-public --json

Checks: the processes the logs say should be up (see "Process checks" below), devnet genesis, Season PDA status (Announced/Created/Seeded/Running/Ended) vs the scheduled
CreateSeason time (late CreateSeason / genesis seed → WARN/FAIL), balances of the deployer, authority and keeper A
funders vs thresholds, herald `/h/season` + `/h/status` (ingest, alarms) and lag (herald live slot vs RPC slot; with a
herald that reports `ingest.backlog` > 0: WARN "behind, progressing" when `ingest.lastArchivedSlot` advanced since the
previous `--state` run, FAIL when it did not, WARN once when it fell below the previous run's (a rebuilt archive); "≈ N s" at `--slot-s` [0.4], devnet measured 0.240 s/slot on 11-27),
the gateway's public `/f/season`, keeper A's API (`/v1/status` without a token must answer 401: the token is not
read, so duties/rent/lag come from its log), `keeper.landed` (keeper A's journal read with `sqlite3 -readonly`: the newest
`landed` write vs the RPC slot already read for `herald.lag` (no extra call; the herald-based age is shown too, and
without RPC it falls back to the herald live slot and says "(herald slot; rpc unavailable)"), WARN > 7,500 slots ≈ 30 min, FAIL > 22,500 ≈ 90 min or no landed write; a
healthy keeper lands anchor/seed/beacon-log every bell even in a quiet world), tunnel name vs the herald's `public-host`, the public page and
`/h/season` through the tunnel, the join check's result, disk free, and error/restart/STOP lines in the last
500 lines of each `devnet-*.log`.

Process checks: a process is found by its command line only — no PID is written in `health.mjs`. Each pattern
starts at the program being run (`zsh ./run-herald.sh`, `…/frontier-herald … --listen 127.0.0.1:41140`), so a
line that only names it (`pgrep -f …`, `tail -f …`, an editor) is not taken for it. A script must keep its own name: a copy named `season-driver-2.sh` or `run-herald-2.sh` is not matched (a FAIL), so keep a copy under the same name in its own run directory. Wanted and not running = FAIL. "restarted" is a WARN only for a while, so a planned restart (a herald swap) clears by itself:

- with `--state FILE` (the loop uses it): the run that finds a different PID than the previous run did is a WARN
  (`pid 7001 up 02:10 — was 94463 at the previous run (restarted)`), and it stays a WARN until the new process is
  30 minutes old (`--restart-warn-min N`); after that it is `OK pid 7001 up 42:00`. A process the state file has
  not seen before is OK (a first start is not a restart). The state file keeps `procs: {key: {pid, restarted, was}}`.
- without `--state`: there is no previous run, so a wanted process younger than 30 minutes is the WARN
  (`started 2 min ago (restarted or first start; …)`).
- optional `<run-dir>/health-procs.json` (default run dir `~/wylls-devnet-run`; read only, absent = no overrides):
  `{ "restartWarnMin": 30, "procs": { "proc.herald": { "pid": 12345 }, "proc.keeper": { "pidfile": "keeper-a/keeper.pid" } } }`.
  A key with an expected PID (given, or read from the pidfile; path relative to the run dir) is OK only with that
  PID, at any age, and a WARN with any other. A broken file or entry is one `proc.overrides` WARN line and is
  otherwise ignored. Nothing in the stack writes a pidfile today, so this file is for the operator to write by hand.

World creation postponed / no world yet (owner decision 2026-11-24 12:07: the scheduled CreateSeason is not sent and
the season driver was stopped by hand). By default a stopped driver is `FAIL proc.season-driver not running`, and
15 min after the scheduled time `FAIL season.phase … CreateSeason has not landed`. Tell the monitor it is on purpose
with one of (all read-only for `health.mjs`; nothing changes without them):

    node scripts/devnet/health.mjs --no-world-yet
    echo "owner 11-24 12:07: creation postponed" > ~/wylls-devnet-run/world-postponed                          # marker in --run-dir
    echo "owner 11-24 12:07: creation postponed" > ~/Projects/wylls-grok-state/logs/devnet-create-postponed    # marker in --logs

A marker's first line is printed as the reason; delete the file to go back to the default checks (do that before the
driver is started again). In this mode:

| check | default | postponed |
|---|---|---|
| `world.creation` | (no line) | `OK postponed, no world yet (marker …: reason)` |
| `proc.season-driver` | not running = FAIL | not running = OK; **running = FAIL** (it would send CreateSeason) |
| `proc.gateway-starter`, `proc.join-check` | not running = FAIL until their work is done | running or not = OK (they only wait) |
| gateway / keeper A processes, `gateway.health`, `keeper.api`, `keeper.landed`, `join.check` | OK "not yet" until the driver log shows them started | the same, worded "not expected: world creation postponed" |
| `season.phase` Announced | FAIL 15 min after the scheduled time | OK `Announced, creation postponed`, with both deadlines (below); WARN once the 7-day create window has closed |
| `season.phase` Aborted | FAIL | OK (announcement cancelled, no world yet) |
| `balance.authority` | WARN below CreateSeason's need (≈56.13) | plain thresholds; the need is only quoted |
| `--timeline` line 2 | `scheduled CreateSeason opens …` | `world creation POSTPONED, no world yet (…); CreateSeason was scheduled to open … — not sent` |

Herald, tunnel, caffeinate, `tunnel.host`, the public page, the other balances, disk and the logs are checked exactly
as by default (a dead herald is still a FAIL). The two deadlines `season.phase` prints come from the program
(`proc/season.rs`): the authority's AbortSeason returns the creation bond only before the genesis round time
(`t_create_min` + 660 s rounded up to a drand round: 2026-11-25 02:31:06 JST for the world announced on 11-24), after
that an abort burns it; and CreateSeason can land until `t_create_min` + 7 days (2026-12-02 02:20:04 JST). If the
driver log shows a CreateSeason run although the flag / marker is there, the marker is stale: `world.creation` is a
WARN and every check runs as by default; if only the chain shows the world (Created / Seeded / Running),
`season.phase` is at least a WARN and says to remove the marker. With `--state`, the file keeps
`postponed: {since, src, reason}` (and `until` once the mode is off again).

It never stops, signals or starts a process, never reads a key, `keeper.seed` or `keeper.token`, and never sends
a transaction. Devnet RPC: only getGenesisHash / getSlot / getBalance / getAccountInfo to
`https://api.devnet.solana.com` (the genesis hash is checked first), one call per 1.1 s, 9 calls a run.

`health-loop.sh` runs it every 10 min (every 2 min inside 02:12–03:30 JST 11-25, the scheduled CreateSeason window)
until 05:00 JST 11-25 (env `UNTIL`, `INTERVAL`, `FAST_FROM`, `FAST_TO`, `FAST_INTERVAL`; `HEALTH_ARGS` = extra
`health.mjs` options such as `--no-world-yet` — a marker file needs no option and no restart of the loop), appending
to `~/Projects/wylls-grok-state/logs/devnet-health.log`, keeping first-seen milestone times in
`evidence/devnet-health/state.json` and an `ALERT` line at the top of `reports/devnet-health.md` after a FAIL.
Stop it with `touch ~/Projects/wylls-grok-state/logs/devnet-health.stop` (or `kill $(cat …/logs/devnet-health-loop.pid)`).
