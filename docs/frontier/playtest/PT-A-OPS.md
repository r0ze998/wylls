# Wylls friends' playtest: running it (PT-A)

> **Scope.** 10 to 30 invited friends play the M1 base game for about 3 real days at the **real clock (1x)**, hosted on this Mac, reached through one Cloudflare quick tunnel. Local chain only (`frontier-localnet`), no money, no devnet, no AI citizens. This is **not** the devnet playtest of [`../m1/PLAYTEST-RUNBOOK.md`](../m1/PLAYTEST-RUNBOOK.md) (O-M1-18 stays unapproved); it reuses that runbook's roles and its G8 payer configuration. Unit PT-A, written 2026-10-03; the numbers marked **[measured]** were measured on this Mac in that unit's bring-up (notes: [`PT-A-NOTES.md`](PT-A-NOTES.md)).
>
> **Nothing here starts a tunnel.** The scripts run the stack on 127.0.0.1 only. Exposing it is one command you type yourself (section 8).

## 0. Cheat sheet

```sh
cd <the worktree>                                  # .claude/worktrees/playtest
(cd frontier-node && nice cargo build --offline --locked --release --workspace)   # once, after the last code change
scripts/playtest-up.sh --dry-run                   # checks everything, starts nothing
scripts/playtest-up.sh                             # starts the stack + babysitter (about a minute)
scripts/playtest-status.sh                         # health report (exit 0 healthy, 1 alarm, 2 down)
scripts/playtest-invite.sh 20 --label friends-1 --base-url https://<tunnel-host>   # CSV of invites
scripts/playtest-down.sh                           # stop everything cleanly (keeps all data)
scripts/playtest-selftest.sh                       # whole thing in a throw-away directory, ~30 min
```

| 日本語メモ | |
|---|---|
| 起動 | `scripts/playtest-up.sh`(1分ほど。トンネルは起動しない) |
| 状態確認 | `scripts/playtest-status.sh`(`LAG-ALARM` / `HEALTH-ALARM` ファイルが出たら異常) |
| 招待コード | `scripts/playtest-invite.sh 20 --label friends-1 --base-url https://….trycloudflare.com` → CSV(コード+URL。個人情報なし) |
| 公開 | 起動後に表示される `cloudflared tunnel …` を**自分で**実行する(1コマンド) |
| 停止 | `scripts/playtest-down.sh`(データは残る。再度 `playtest-up.sh` で続きから) |
| スリープ | Macがスリープするとゲーム時計も止まる(遅れるだけで壊れない)。電源接続・蓋を開けたまま |

## 1. What runs

One run directory, one season, eight processes, all on 127.0.0.1. Ports are `41100-41139` only (the owner's reserved ports and 41300+ are never used); **only the herald's is meant to be exposed**.

| Process | Port | Role | Restarted by |
|---|---|---|---|
| `frontier-localnet` | 41112 (ws 41113) | the chain (LiteSVM), 400-ms slots, game clock = slot count, ledger WAL + snapshots on disk | stack supervisor |
| `drand-replay` | 41114 | serves the real quicknet rounds of the archive, each when the chain's clock reaches it (+1 s) | stack supervisor |
| `frontier-keeper` A | 41118 | every role: beacon, reveal, resolve, skip, settle, tickets, archive, close, rings, ... | stack supervisor |
| `frontier-keeper` B | 41119 | public profile: reveal, settle-departure, settle, claims (8-slot backup delay) | stack supervisor |
| relay (`node permutation-gateway/src/frontier/server.mjs`) | 41115 operator, 41116 public | sponsors players' transactions, invites, the join gate, quotas | stack supervisor |
| `frontier-herald` | **41117** | serves the web client, `/h/*`, WebSocket, and the relay's public routes as `/gw/*` | stack supervisor |
| `frontier-bots` | 41122 (control) | 60 rule bots so the world is not empty | stack supervisor |
| `frontier-stack` (the supervisor) | none | starts the above in order, restarts any that dies (2, 4, 8 ... 60 s back-off), samples keepers and herald each bell | **babysitter** |
| `playtest-supervise.sh` (the babysitter) | none | restarts the stack itself (`resume`), runs the monitor every 30 s, rotates logs, takes the hourly backup | you (`playtest-up.sh`) |
| `caffeinate` | none | prevents idle/disk/system sleep while the babysitter lives | exits with it |

Config: [`frontier-node/configs/playtest-1x.toml`](../../../frontier-node/configs/playtest-1x.toml) (every choice is commented there).

- **Season:** preset `M1_LOCAL_7D` with `join_gate` = the relay's gate public key (the `M1_PLAYTEST` preset, I-51): joins close at bell 756 (day 5.25), the season would end at bell 1,008 (day 7). The playtest stops by hand after 3 to 4 days; the season is never ended. Every Join needs the relay's co-signature, which it gives only for a valid unused invite, so the invite rule holds on chain, not only in the relay.
- **Program:** the release `.so`, pinned by sha256 `d85e1bd7...f2281` (the M1 exit build; rebuilt from this tree it is bit-identical **[measured]**). The stack refuses any other file.
- **Clock:** `scale = 1`: one game second per real second. The 24-hour pre-season lead the program requires runs at 2,000x (about 45 s), then the clock is 1x. A bell (600 game s) is 10 real minutes; a game day is 144 bells.
- **Bots:** 60, seed 11, the exit-run profile scaled down (below 100 bots the 13 adversarial personas are off, so these are plain rule bots on the simulator's human mix: 60 % join on day 0, the rest spread over days 1 to 5). They join through the gate with 60 invites the stack asks the relay for, so their joins show as label `bots` in the event log.
- **Keepers:** 150 reveal payers, 32 delay payers, 4 funders each, with the G8 small-season floors of the runbook (`r99_reveals = 150`, `delay_floor = 0.05 SOL`; reveal payers start at 0.012 SOL, delay payers at 0.075 SOL, the middle of their bands). Effective reveal N = 150 on both keepers **[measured]**.
- **No chaos, no adversary, no simulated viewers.**

## 2. Before the day

1. **Build** (once the tree is final; the machine is shared, so `nice`): `cd frontier-node && nice cargo build --offline --locked --release --workspace`. The release `.so` is `permutation-frontier/target/deploy/permutation_frontier.so` (`scripts/build-frontier.sh`; its sha256 must be `d85e1bd7...`). `permutation-gateway/node_modules` must exist (symlink an existing one; no installs).
2. **Dry run:** `scripts/playtest-up.sh --dry-run`. It checks binaries, the pinned `.so`, the drand archive (8.54 game days of rounds; the stack also refuses to start unless it covers the 7-day season and the drain), node 20, the web client, the ports, 40 GB free, AC power.
3. **Selftest (optional, about 30 minutes: the season's genesis alone is 9):** `scripts/playtest-selftest.sh` does everything below in a throw-away directory with 12 bots.
4. **The web files** the herald serves are the worktree's `permutation-server/web/` as of the start. Merge the design session's last changes **before** `playtest-up.sh`. (The herald reads the files from disk per request [unverified], so a later change would reach friends at their next page load, with a changed `.mjs` module possibly mixing old and new until a reload: do not edit the web directory while friends are playing.)

## 3. Start, stop, continue

- `scripts/playtest-up.sh` starts the babysitter (own session, under `caffeinate`), which runs `frontier-stack up` the first time. The first start takes about a minute (it airdrops the test SOL, announces and creates the season, funds the payers) and the **season starts about 9 minutes later** (genesis is when the first drand round of the season is public; **[measured]** 8 min 20 s). Joins are accepted from genesis.
- **When to start.** The bots join on the simulator's schedule: 60 % of them (36) at a uniformly random bell of game day 0, the rest at random bells between day 1 and day 5.25, so the world fills at about one bot every 4 bells (40 minutes) in the first day. **Start the stack about 24 hours before the first invitation goes out** (for a playtest opening on the night of 2026-10-06, start on the night of 2026-10-05): then the friends arrive to a world with about 36 bots in it and the late bots keep arriving while they play. Starting on the same evening leaves the first hours nearly empty. The invites carry no date; they work whenever the season is open (joins close at bell 756).
- `scripts/playtest-down.sh` stops the babysitter first, then the stack and components in reverse order, then takes a last backup. Everything stays on disk.
- `scripts/playtest-up.sh` again **continues the same season** (`resume`): same chain, same invites used, same keepers' journals. Use `--fresh` only for a new season: it moves the old run **and the old secrets** to `old/<stamp>/` (so the old gate key and invites die together).
- After a reboot or a crash of the babysitter: `scripts/playtest-up.sh`. (Section 5 says what restarts by itself.)

Data root: `/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/data/playtest/` (override: `PLAYTEST_DATA`), mode 0700, outside git:

```
secrets/        gate.key, invite.secret (0600)         never printed, never in git
runs/playtest-1/  state.json, events.jsonl, logs/, localnet/ (ledger.wal, snap-*.bin), keeper-a|b/ (journals),
                  relay/ (relay-state.json, relay-events.jsonl, tokens), herald/, bots/, metrics/, keys/
backups/<stamp>/  hourly (section 6)          logs/, logs-archive/        status/ (status.json, history.jsonl, alarms.jsonl, gaps.jsonl)
invites/          the CSVs (0600)             launch.json                 what ran: git head, sha256 of config, .so and binaries
LAG-ALARM, HEALTH-ALARM   present only while the condition holds         STOP   a stop was requested
```

## 4. The health report and the alarms

`scripts/playtest-status.sh [--json]` probes everything live (a few seconds). The babysitter runs the same probe every 30 s and keeps `status/status.json` (latest), `status/history.jsonl` (one line per 30 s: bell, lag, queues, joins, free disk), `status/alarms.jsonl` (every raise and clear) and `status/gaps.jsonl` (see section 7).

What it prints, and the literal definition of each figure:

| Line | Meaning |
|---|---|
| `BELL` | `bell = floor((chain game time - genesis_ts) / 600)`; `game day = bell div 144` |
| `RESOLVED` | from the herald's overview of every ring: each opened province has `resolved_next`; *resolved through* = `resolved_next - 1`. Printed: the minimum (every province is resolved at least through this bell), the newest, **lag = bell now - the minimum**, and how many provinces are more than 2 bells behind. Idle provinces are skipped in batches of up to 24 bells by design, so a lag up to about 27 is normal and the program itself refuses a player's action in a province more than 2 bells behind until it is nudged (section 9) |
| second line | last bell anchored (newest landed `anchor-multi`/`anchor` in keeper A's journal); last clash resolved (newest landed `resolve`); attempts not landed (journal, by status) |
| `CHAIN` | slot, game time, scale, slots per wall second (a healthy chain makes 2.5), and a `[gap ...]` note if the monitor was suspended |
| `HERALD` | fold lag in slots (newest program transaction on the chain minus the newest the herald folded), provinces and rings, WebSocket clients, dropped slow clients |
| `KEEPER-A/B` | pending writes, alerts, effective reveal and delay payers, funders' SOL, anchor and seed latency p99 (slots), counts of resolves, skips, reveals, nudges |
| `RELAY` / `INVITES` | pool SOL and eligible payers; invite required; issued per label; joins per label (from the relay's event log) |
| `PROCESSES` / `PORTS` | pid, uptime, cpu, memory, number of starts; every port open, **which address it listens on, and an alarm if any is not loopback** |
| `DISK` / `MACHINE` | free GB, run directory and chain sizes, backups, logs; load, keep-awake assertion, whether `cloudflared` runs and its URL |

**Alarm files.** `LAG-ALARM` exists (JSON: since, bell, reasons) while any *lag* condition holds; `HEALTH-ALARM` while any other does. Both vanish when the condition clears and every change is appended to `status/alarms.jsonl`.

| Class | Raised when |
|---|---|
| lag | `chain-stalled`: fewer than 1 slot per wall second over a probe interval of 20 s or more (not judged across a suspended machine); `chain-paused`; `chain-unreachable`; `world-lag`: a province more than 36 bells behind (warning at 28); `anchor-lag`: the newest anchored bell is more than 3 bells before now; `herald-lag`: the herald more than 150 slots (60 s) behind on two probes in a row; `keeper-a-queue`/`keeper-b-queue`: 100 or more pending writes |
| health | any process of the stack down (and the supervisor, and the babysitter); a port closed or **listening beyond loopback**; herald, relay or a keeper's API not answering; herald alarms `badRecords`, `clashMismatch`, `writeErrors`; relay pool with fewer than 20 eligible payers; the season **not** gated although the run was started gated; free disk under 20 GB (warning at 40) |

The monitor (the alarm *files*) debounces what the supervisors restart by themselves: a process, port, API or the supervisor that is down on one 30-second tick is a warning (`once:...`); the same thing on two ticks in a row raises the alarm. `playtest-status.sh` is a single live look and alarms at once.

Warnings (printed, not alarms): effective reveal payers below 150, dead writes increasing, backup older than 3 hours, herald lag on one probe. During the first start and a `resume` (state `setup`/`resuming`, up to 15 minutes) closed ports are warnings, not alarms.

The alarm files are just files: `ls <data>/LAG-ALARM` in a prompt, a Finder badge, or `watch` them as you like. Nothing here sends a message anywhere.

## 5. Robustness

Three layers, each tested by `kill -9` in the bring-up **[measured]**:

1. **Components.** The stack supervisor notices a dead component within 0.4 s and restarts it from its own files after 2 s (4, 8, 16, 32, 60 s if it keeps dying within a minute of its start; a component that ran longer starts over at 2 s). Killing each of relay, herald, keeper A, keeper B, drand-replay, bots and the chain in turn: all came back. The chain recovers from `ledger.wal` + the newest snapshot (the ledger record of a block is written and fsynced before any client sees its result; a torn last record is cut off); a keeper from its SQLite journal (it reconciles in-flight writes with the chain); the relay from `relay-state.json` (quotas and **used invites**); the herald from its checkpoint; the bots from their march journal.
2. **The stack supervisor.** The babysitter notices it died and starts `frontier-stack resume` (10 s later; 10, 20, 40 ... 300 s if it keeps failing within 10 minutes; it gives up only on a *first* start that fails three times). `resume` keeps the run directory, stops any stray component of the dead supervisor (matching the **exact command line**, so another stack's process of the same binary is never touched), recovers the chain, starts everything in order and takes up supervising. A `kill -9` of the supervisor: back in about 15 s with a new pid, season intact, `1 resume` in the report **[measured]**.
3. **The babysitter.** Nothing restarts *it*: if the Mac reboots or the process is killed, run `scripts/playtest-up.sh` (it continues the run). `HEALTH-ALARM: babysitter-down` says so. If you want it to start by itself after a login, a launchd agent that runs `scripts/playtest-up.sh --no-wait` once at load does it. It is **not installed** (changing login items is your call); the file would be `~/Library/LaunchAgents/games.wylls.playtest.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>games.wylls.playtest</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string>
    <string>cd "/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/playtest" &amp;&amp; scripts/playtest-up.sh --no-wait</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

(`launchctl load` it yourself; `playtest-up.sh` is a no-op when the babysitter already runs, and `playtest-down.sh` leaves a `STOP` file that the next `playtest-up.sh` clears, so it only matters after a reboot or login.) Note that a login does not mean the Mac is awake and plugged in.

What is **not** restarted: `cloudflared` (yours, section 8), and a season that finished (`frontier-stack` exit 0 after the season's end is the one exit the babysitter treats as final).

Logs rotate: any `runs/playtest-1/logs/*.log` over 64 MB is copied to `logs-archive/<name>.<time>.gz` and truncated in place (the writers append, so nothing is lost or reopened); the 8 newest archives per log are kept. The monitor, babysitter, stack, backup and cloudflared logs are in `logs/`. Components log little (a relayed transaction is one line); **[measured]** the run's `logs/` directory was 6 kB after 30 minutes; the monitor adds one line of about 100 bytes every 30 seconds to `<data>/logs/watch.log`.

## 6. Backups, restore, disk, what is logged

- **Hourly** (and at `playtest-down.sh`): `scripts/playtest-backup.sh` copies the newest chain snapshots, then the ledger (this order matters: a restore re-executes the ledger from the newest snapshot, so the ledger copy must not be older than any snapshot copy), the keepers' journals through `sqlite3 .backup` (integrity-checked), the relay's state and event log, the bots' journal and invites, the herald's checkpoint and archive, `state.json`, `events.jsonl`, the keys and `secrets/`. Copies are APFS clones (instant, no extra space until a file changes). Kept: every backup of the last 24 hours, then one per UTC day, at most 120. **[measured]** 10 MB and 1 s for a 15-minute-old season.
- A backup on the same disk protects against a bad restart or a corrupted file, not a dead disk. `PLAYTEST_BACKUP_COPY_TO=/Volumes/<other>/dir` also rsyncs the newest to another volume after each run.
- **Verify** without touching anything: `scripts/playtest-restore.sh --verify [backup]` opens the backup's chain on 127.0.0.1:41138 (paused, then stopped), integrity-checks the journals, checks the relay state.
- **Restore:** `scripts/playtest-down.sh`, then `scripts/playtest-restore.sh <backup>` (moves the current run to `old/restore-<stamp>/`, never deletes it; `--with-secrets` also restores the gate key), then `scripts/playtest-up.sh`. The game clock is the slot count, so the time between the backup and the restore is simply not game time; players who joined after the backup are not in the chain and must re-join with a new invite.
- **Disk:** the exit run (1,000 bots, 7 game days at 20x) used 0.65 GB of ledger and 3.6 GB of herald files; this world is about 1/15 of that and runs 1x. The ledger grows about 9 MB a day from empty blocks alone **[measured]**. Budget 5 GB for the run, 1 GB for backups; the monitor warns under 40 GB free and alarms under 20.
- **What is logged about people.** Nothing in our own systems carries a name, an e-mail, an address or an IP. The relay keeps per-IP counters **in memory only** (rate limits; PT-E: the one thing that does reach its state file is the quota entry of a request not tied to a citizen on the chain, whose key is `addr:` plus 16 hex of an HMAC-SHA256 of the address bucket under a random salt held in memory only, so it cannot be reversed and means nothing after a restart; the log line says `quota anonymous`; `scripts/playtest-privacy-check.sh` greps every file we keep for an address) and an append-only `relay/relay-events.jsonl`: `invites_issued` (label, count, the codes' **nonces**, which cannot be redeemed) and `join` (the invite's nonce, the wallet's public key, the transaction signature, a timestamp). A wallet is a pseudonym the browser makes (and is public on chain anyway); an invite maps to a citizen only through that join line. **Who you handed an invite to is yours to remember, not ours to record**: `playtest-invite.sh` writes `invite_code,url` and nothing else. The survey is an external form you create.
- **Metrics** (literal, from files only): *invited people who joined* = `join` lines whose invite nonce belongs to an `invites_issued` batch not labelled `bots`; *bots* = label `bots`; a person's later days = the herald's `/h/events` (`name`, `bell`, `key.citizen_tag15`) or the chain itself, by game day = bell div 144. Wall days and game days differ by the time the Mac slept; `status/gaps.jsonl` records every such interval (section 7). Never claim more than these files show.

## 7. Sleep, power, and what time is

The game clock is **the chain's slot count** (`game_ms += 400 x scale` per slot, 400-ms slots, no catch-up after a pause: the ticker's missed-tick policy is `Delay`). The keepers, bots and drand-replay all follow that clock, not the wall clock. So:

- **If the Mac sleeps** the chain makes no slots: the game clock stops and nothing is lost. The tunnel drops (players see Cloudflare's error page); on wake every process continues and `cloudflared` reconnects (whether it keeps the same URL is [unverified]; check `status`). It is "lag only waits": no bell is skipped, no march is resolved early or late relative to the chain's own clock, no reveal window is missed. What changes is the **mapping between game time and wall time**: a 6-hour sleep makes the game 6 hours "younger" than the wall. The monitor writes one line to `status/gaps.jsonl` per interval in which it did not run for over 100 s: `{wall_secs, slots, game_secs, from, to}`; a sleep shows `slots` and `game_secs` near 0 with a large `wall_secs`. Report the played time in **game days** and say how long the Mac slept.
- **If everything is merely frozen at once** (the proxy used in the bring-up: the monitor stopped for 116 s while the chain ran) the monitor records the gap and raises **no** stall alarm **[measured]**.
- **Keep it awake:** plug in AC power (`caffeinate -s` only holds *system* sleep on AC); lid open (a closed lid sleeps a laptop unless it is in clamshell mode with an external display, keyboard and power); System Settings > Battery > Options > "Prevent automatic sleeping on power adapter when the display is off" on; Lock Screen "turn display off" may stay short; turn off automatic restarts for updates for these days. `playtest-up.sh` starts `caffeinate -i -m -s` on the babysitter's pid; `status` shows whether a keep-awake assertion is held.
- **Reboot / power loss:** run `scripts/playtest-up.sh`. Restore time is the ledger replay since the newest snapshot (every 36 game bells = 6 h; empty blocks replay in milliseconds); **[measured]** 0.4 s for a resume of a 3-minute-old chain; not measured on a multi-day chain. If the chain's ledger was corrupted, the backups above are the way back.

## 8. Exposure: one port, one command

Only the herald is for the outside. **Do not run this until you say go.**

```sh
/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:41117 --logfile "<data>/logs/cloudflared.log"
```

It prints a random `https://<words>.trycloudflare.com` (also in the logfile, which `status` reads). Every restart of that command gives a **new** URL: invites stay valid, only the link changes, so send the new link. No account, nothing installed.

What a visitor can reach through it (the herald's routes): the static web client under `/frontier/` (note: the **game page is `/frontier/frontier/`** and the landing page `/frontier/frontier/playtest/`; `/` and `/frontier/` redirect to the landing page, because the stack's herald runs with `--landing`; request R2 is answered); read-only `/h/*` (season, status, province, clash, overview, roster, events, `/h/me/<wallet>`), `WS /h/ws`; and `/gw/*` = the relay's **public** routes only (`GET /f/season`, `/f/relay`, `/f/quota`, `/f/tx/<sig>`, `POST /f/relay`, `/f/join`, `/f/reveal`, `/f/nudge`; GET/POST/OPTIONS, bodies up to 64 KiB). The operator routes (`/f/operator/*`: invites, pool), the keepers' APIs (with their bearer tokens), the chain's RPC, drand-replay and the bots' control port are on 127.0.0.1 and **not** behind the herald; `status` alarms if any listener is not loopback. The relay trusts `X-Forwarded-For` only from the herald's loopback peer, and when the herald's own peer is loopback (the tunnel) it takes the visitor's address from Cloudflare's `CF-Connecting-IP`, else the last `X-Forwarded-For` entry (PT-B, `25a8d97`), so per-IP limits (`/f/join` burst 10 then 1 per 5 s, `/f/relay` burst 40 then 2/s, ...) apply per visitor; confirm in the rehearsal that two phones on different networks are counted separately [unverified: no tunnel was run].

Quick-tunnel limits worth knowing (Cloudflare's, not ours; as documented to my knowledge, [unverified] here because no tunnel was run): no uptime promise, about 200 concurrent in-flight requests, no Server-Sent Events; WebSockets should work. 30 friends are well inside that.

## 9. Known behaviour and open issues

- **"This province has not resolved the previous bells yet" (HTTP 409, `NotResident`)** is the program's rule (a resident action needs the province resolved through the bell before the previous one), not a stack fault. See the diagnosis in [`PT-A-NOTES.md`](PT-A-NOTES.md) section 2: at 20x the keeper's per-bell catch-up of a nudged province lands up to most of a bell late in game time, so the window in which Depart is refused was inflated 20-fold in the 2026-10-01 recording; at 1x it shrinks to seconds per bell, and a quiet province needs one nudge (the page does it; PT-B's relay-side catch-up retries it for every client). A friend who sees the message presses the button again a few seconds later.
- **The link to send** is the playtest landing page, `https://<host>/frontier/frontier/playtest/#i=<code>` (PT-B's page: it checks the invite without spending it, explains in plain words, and goes on to the game; the code is in the URL *fragment*, which is never sent to a server or logged). `playtest-invite.sh` writes exactly that into the CSV when the page is in the tree (`--game-page` writes the raw game page instead). The game page itself, `/frontier/frontier/`, takes the code only from its join screen's field (it does not read `?invite=`: request R1), so a friend who lands there pastes the code.
- `/` and `/frontier/` redirect to the landing page (`--landing`; PT-B). Send the landing link above, never the bare host.
- Joining is open from genesis. The first holding appears about 11 to 21 minutes after a friend files a site ticket (the draw needs the next bell's seed) and the first clash report about 31 to 41 minutes after the first march departs (design numbers [model]); tell friends that things happen in **bells (10 minutes)**.

## 10. If something looks wrong

| You see | Do |
|---|---|
| `status` says a component DOWN for more than a minute | `tail <data>/runs/playtest-1/logs/<name>.log`; the supervisor retries by itself; if it loops, `playtest-down.sh` then `playtest-up.sh` |
| `HEALTH-ALARM: babysitter-down` | `scripts/playtest-up.sh` (continues; strays are stopped by exact command line) |
| `LAG-ALARM: chain-stalled` | is the Mac asleep or heavily loaded? (`load` in status); if the chain process is alive but not advancing, `playtest-down.sh`, `playtest-up.sh` |
| `LAG-ALARM: world-lag` or `anchor-lag` | keeper A's log and `status` KEEPER-A line (alerts, payers, pending); a keeper restart (`kill` its pid; the supervisor restarts it) is safe |
| `relay-pool` | the relay's payers are funded 10 test SOL each at start; this means they were spent: restart is not enough; see the relay log, stop invites |
| a friend cannot join | the invite is used or mistyped (`relay-events.jsonl` has the used nonces); issue a new one |
| disk under 40 GB | `du -sh <data>/*`; the biggest are `runs/` and `backups/` |
| you want to stop early | `scripts/playtest-down.sh` (and stop `cloudflared`). The season simply stops; nothing needs ending |

## 11. Day plan (a suggestion; the dates are yours)

| When | Do |
|---|---|
| Days before | Merge the design session's and PT-B's last changes; rebuild (section 2); `scripts/playtest-selftest.sh` once; `scripts/playtest-up.sh --dry-run` clean. Create the survey form yourself (an external form; this repository holds no personal data) |
| **T-24 h** (night of 2026-10-05 for a 10-06 night opening) | Mac on AC power, lid open, updates off. `scripts/playtest-up.sh`. Check `scripts/playtest-status.sh` after 15 minutes (genesis passed, 37 provinces, keepers 150/150, `invite required: true`) |
| T-2 h | `scripts/playtest-status.sh`: no alarm files; bots joining (`INVITES ... joins ... bots`); `scripts/playtest-backup.sh` once by hand and `scripts/playtest-restore.sh --verify` |
| **T-0** | You say go: run the cloudflared command from section 8 in its own terminal tab. `scripts/playtest-invite.sh 20 --label friends-1` (the URL is read from the tunnel's log); send each friend their own code and link, by whatever channel you like |
| During | Glance at `status` a few times a day (or watch for `LAG-ALARM` / `HEALTH-ALARM`). A second batch: `playtest-invite.sh 10 --label friends-2` |
| End (about day 3 to 4 after T-0) | Stop `cloudflared`; `scripts/playtest-down.sh` (final backup); keep `<data>/runs/playtest-1/` (chain, journals, relay event log, herald files), `<data>/status/` (history, alarms, gaps) and `<data>/launch.json`: the numbers in the pitch (codes sent, who joined, who took a game action again after a break of at least 12 hours, elapsed hours) come from these files only, as defined in [`OPERATOR-RUNBOOK.md`](OPERATOR-RUNBOOK.md) section 8 |

## 12. Rehearsal and the numbers for the pitch (PT-C)

- **Rehearse before the day:** `scripts/playtest/rehearse.sh --detach --out DIR --scale 1 --minutes 180 --plan "..."` runs a throw-away stack, an https stand-in for the tunnel, 20 scripted friends, drills (kills, a 30-minute freeze, an invalid-invite burst) and writes the numbers; the whole account, results of the 2026-10-04 rehearsals and requests are in [`PT-C-NOTES.md`](PT-C-NOTES.md).
- **The numbers of the pitch** come from one command: `node scripts/playtest-metrics.mjs` (default: this run's `relay/relay-events.jsonl`). `N_invited` (codes issued in batches labelled `friends-*`; every other label is listed and not counted), `N_joined` (distinct invite codes that completed a join), `N_returned` (a deliberate action at least 12 hours after the previous one or after the join), elapsed hours, per-day people and deliberate actions, median session count: the definitions are literal and in the script's header and are pre-registered in the operator runbook section 8 (PT-E replaced the earlier calendar-day return). Label your own test batches `ops` (`playtest-invite.sh` requires `--label`). Add `--herald http://127.0.0.1:41117` to check each joined wallet on the chain.
- First link: send it about **10 minutes after genesis**, not at it; the first march of a friend comes about **50 to 90 minutes** after they join (village 11-21 min, then a host), so the first hour has little to see.
