# PT-A notes: the playtest stack and its operations

Unit PT-A (stack and operations), 2026-10-03, branch `frontier/playtest` (cut from `frontier/unify`). The operator's guide is [`PT-A-OPS.md`](PT-A-OPS.md); this file is the unit's reasoning, evidence and requests. Local commits only; nothing was pushed, no tunnel was started, no devnet or mainnet was touched, nothing was installed or downloaded.

## 1. What was built

| Piece | Where |
|---|---|
| The stack config: M1_LOCAL_7D + invite gate (the `M1_PLAYTEST` preset), release `.so` pinned by sha256, real quicknet rounds from the archive, scale 1, 60 bots, G8 payer floors, ports 41112-41123 | `frontier-node/configs/playtest-1x.toml` |
| `frontier-stack`: `playtest.secrets_dir` (gate key + invite secret outside git, gate public key into CreateSeason, relay started with both, bots get invites), `resume`, crash back-off, exact-command-line pid matching, keeper `r99_reveals`/`delay_floor` and payer start lamports as config keys | `frontier-node/crates/stack/src/{playtest,up,config,setup,procs,main,lib}.rs`, `fclient/src/http.rs` (`request_with_headers`) |
| The relay's JSONL event log and the optional invite label | `permutation-gateway/src/frontier/{eventlog,config,server,app}.mjs`, `routes/{operator,relay}.mjs` |
| `playtest-up.sh`, `-down.sh`, `-status.sh`, `-invite.sh`, `-backup.sh`, `-restore.sh`, `-selftest.sh`, the babysitter `-supervise.sh`, the monitor `-watch.mjs`, the join check `-join-check.mjs`, `-lib.sh` | `scripts/` |
| Tests | `stack` 77 unit tests on the merged tree (PT-A's new: config keys and the committed playtest config, gate key and secrets modes, gated params, crash back-off, G8 keys reach `keeper.toml` and the keeper's own parser, exact command lines); relay tests (event log); `permutation-gateway/test/playtest-ops.test.mjs` (alarm classes, slot-rate and gap rule, event-log counts, report) |
| The guide | `docs/frontier/playtest/PT-A-OPS.md` |

Data lives outside git in `.claude/data/playtest/` (not created until the first `playtest-up.sh`; all bring-up evidence below comes from a throw-away directory, so the real run directory is clean).

## 2. The 2026-10-01 stall: HTTP 409 "This province has not resolved the previous bells yet"

**What the recorder saw** (`.claude/data/demo/attempts/demo-try4.log`, `summary.json`): the EN run composed a march to a tile of its own province, pressed Depart twice and got `Depart: This province has not resolved the previous bells yet.` twice (three 409s in the console), then waited 1,200 s for `march-send:not([disabled])` and failed.

**What the message is.** The English text is `fi18n.mjs`'s `NotResident` (program error 26). The program checks `resident_ok(province.resolved_next, now_bell)` before a resident action (Depart, Muster, Garrison, Dissolve, Explore): the province must be resolved through bell `now - 2` (the page's `provinceLags`: `resolved_next + 1 < now_bell`). Refusing is the rule working, not a fault.

**What the chain shows** (the stack's run directory of that attempt, `frontier-demo-play/.../demo-playflow-try4`, read-only; keeper A's journal copied to the scratch directory):
- The EN province (0,-2) was caught up by one nudge (`skip:0,-2:0:19`, slot 1,762) and then skipped **one bell at a time**, each skip landing after the bell it covers: 58 per-bell `skip` writes for nudged provinces, every one landed. They land late in the bell: measured from the start of bell `b+2` (the bell in which the skip for bell `b` becomes possible), the landing offset is **2.8 to 64.8 slots, median 40.8, of a 75-slot bell** (a bell is 600 game seconds = 75 slots at 20x). So at 20x the province is *not resident* for **about half of every bell** (median 54 %, up to 86 %), and two Departs 7 s apart can easily both fall in that window.
- The EN march nevertheless **landed**: its Depart is on chain (`sdep:...:29`, slot 2,526), the keeper revealed it (slot 2,612), gathered and resolved bell 32 (slot 2,759) and settled the transit (slot 2,825), about 19 minutes after the stack started, while the recorder was still waiting. Its two refusals were transient.

**Why it stalled.** The recorder (`record-playflow.mjs`) loops "wait for `march-send` enabled, click, expect an ok notice; on a refusal wait and click again, at most 3 times". After the second refusal it waited 1,200 s for a `march-send` button that [inferred] no longer existed once the Depart had gone through (the composer closes), and gave up on a selector, not on the chain. The page's own catch-up (`retryAfterCatchUp`) deliberately excludes Depart ("the march has its own path"), so a player who presses Depart in the window gets the refusal and must press again.

**What it means for the 1x playtest.** The *protocol* delay (a bell's reveal window must close before it can be skipped) is in game seconds and does not change with the scale; the *keeper's* latency is a number of slots (400 ms each), which is 20 times larger in game time at 20x than at 1x. A province is resident only while `resolved_next + 1 >= now_bell`, and the keeper catches an idle province up **only when nudged** (otherwise in 24-bell batches, so a quiet province lags by up to 4 hours at 1x). What was measured on the 1x stack of this unit: a `POST /gw/f/nudge` (the page's own call, through the herald) on six idle provinces caught each of them up from `resolved_next` 0 to 2 in **0.52, 0.51, 0.52, 0.78, 1.04 and 1.05 s** (polling every 0.25 s); a first catch-up seen in keeper A's journal landed 1 slot after it was sent. After a catch-up the province stays resident for the rest of that bell; at the next bell boundary it lags again until the next nudge, which the page sends once per bell and PT-B's relay now sends on the refusal (`catchup.mjs`). So at 1x the window in which a resident action can be refused is the second or two between a bell boundary and the next catch-up, about **0.2 % of a bell**, not the half bell of the 20x recording (there the same ~1 s of keeper latency is 20 game seconds, and the per-bell skip cadence the recorder relied on landed up to 86 % of a bell late). Both cases are bounded and recoverable and need no stack change. What the playtest should do: say "press it again" in the invite, watch `RESOLVED` and `LAG-ALARM` in `playtest-status.sh`, and re-measure during the rehearsal with PT-B's relay in place.

Query (keeper journal, per-bell skips): `select object_key, sent_slot, landed_slot from attempts where kind='skip' and object_key like 'skip:%:1'`, offset = `landed_slot - slot_at_start_of_bell(b+2)`, the bell-start slots from `metrics/keeper-a.jsonl` (one line per bell with `bell` and `slot`).

**Request for the design session (not done here):** `record-playflow.mjs` should treat `NotResident` on Depart as "wait for the next catch-up and press again" and, after any click, wait on the *outcome* (the tracker's march row) rather than on the button.

## 3. Decisions

**Beacon: the archive replay with the release `.so`, not the test key.** Both run at 1x because `drand-replay` releases a round when the chain's clock passes it (+1 s), whatever the scale. What decides it:
- *Same program as the M1 exit.* The test-key path needs the `test-beacon` `.so` (marker `PSF_TEST_BEACON_BUILD`, never deployable, a different program hash) and the herald's `--test-key`; the archive path runs the release build the exit season passed. Rebuilt from this tree, the release `.so` is **bit-identical** to the exit's (`d85e1bd7...f2281`), so what friends play is the program that was gated.
- *Real tlock.* Sealed marches are encrypted to future quicknet rounds with quicknet's public key; the keepers open them with the archive's real signatures, exactly what a devnet playtest would do.
- *Enough rounds.* The archive holds 246,001 rounds from G0 (2026-09-10T00:00Z): 8.54 game days. The run needs the 1-day lead plus 7 days plus the drain and an hour (8.2 days) for the season as configured, and about 5 days if it is stopped after 4; the stack refuses to start unless the archive covers the whole 7-day season, and the playtest clock only runs while the Mac is awake, so it cannot outrun it.
- *Cost.* The archive is finite (no extension past day 8.5). The pairing release `.so` + archive had been exercised before only through the bots (Rust seals); the browser's own seal against the archive was exercised in this unit's bring-up at 20x on the production config (section 4: a march sealed in the page was revealed, resolved and settled by the keepers). At 1x the same code runs 20 times slower in wall time; the 1x run completed everything up to the muster (section 4) and the server side (anchors, seeds, ticket settlements) for about an hour without a fault.
Live drand is out (no TLS client in `frontier-node`, no external network).

**Gate.** `join_gate` = the relay's gate public key; the relay co-signs a Join only for a valid unused invite, and the program refuses a Join without that signature, so the rule holds on chain. The gate key and the invite secret are created once by the stack (OS CSPRNG, 0600 in a 0700 directory), their paths (never their contents) go to the relay, only the public key goes on chain and into `state.json`. The bots are admitted by the same gate with 60 invites the relay issues for them, labelled `bots`.

**Clock.** `scale = 1`; the 24-hour pre-season lead the program requires runs at 2,000x (45 s) and then the clock is 1x. The season is the 7-day preset (joins close at day 5.25); the playtest is stopped by hand.

**Ports.** 41112-41123 inside 41100-41139, deliberately clear of PT-B's rehearsal layout (41100-41103, 41106, 41110, 41120, 41121, 41130, 41135) so both can run on the same machine (a test in the stack's config tests pins this). Only the herald (41117) is meant to be exposed; `status` alarms on any listener that is not loopback.

**Keepers.** The G8 floors (`r99_reveals = 150`, `delay_floor = 0.05 SOL`) with payers started in the middle of their bands (0.012 and 0.075 SOL; the floors are 0.0080 and 0.05), 150 reveal / 32 delay / 4 funders each, keeper B with the 8-slot backup delay. Effective reveal N is 150 on both from the first slot and stayed there through every kill in the bring-up.

**Layers of restart.** Component (stack supervisor, existed) -> the supervisor (babysitter + `resume`, new) -> the babysitter (you: `playtest-up.sh`, or an optional launchd agent that is not installed). Kept as separate scripts so each can be tested and killed on its own.

**Pid matching.** The stack used to decide "is this pid still our component" by the binary's file name. After a crash or a reboot recorded pids are stale and the machine runs other stacks' processes of the same binaries (the paused exit season's chain and keepers are two), so `down` and `resume` would have signalled someone else's process. Both now require the exact recorded command line (and the supervisor its recorded one).

**What is not here on purpose.** No network alerting channel (no message is sent anywhere; PT-E added local ones: a notification and a spoken line on this Mac for a new alarm, a long monitoring gap or a dead babysitter, from the monitor and from `scripts/playtest-sentinel.sh`), no launchd agent, no log shipping, no off-disk backup unless `PLAYTEST_BACKUP_COPY_TO` is set.

## 4. Evidence (bring-up on 2026-10-03, throw-away data directory, real binaries and `.so`)

| Check | Result |
|---|---|
| `scripts/build-frontier.sh` from this tree | `file_sha256 d85e1bd74e29...f2281` = the exit build; `deployable yes`; the pin in the config is this value |
| `cargo test -p stack` (offline, locked, release, merged tree) | 77 passed |
| `node --test` of the relay's tests (event log, config) and `playtest-ops.test.mjs` | pass (see the report's test list) |
| `playtest-up.sh --dry-run` | preflight ok; refuses on a stale binary, a missing/changed `.so`, busy ports; creates nothing |
| `playtest-up.sh` | herald answering after 56 s; season created at game 2026-09-11T00:22:09 (genesis); keepers 150/150 reveal and 32/32 delay payers; `invite required: true`; 60 bot invites issued (`{"bots":60}`) |
| Join through the herald in a headless browser with an invite (`playtest-join-check.mjs`) | page asked for the invite, notice "Recorded on chain" after 2 s, `/h/me/<wallet>` has the citizen; event log has `join` with the invite's nonce and label `selftest` |
| `kill -9` of relay, herald, keeper A, keeper B, drand-replay, bots, chain, one after the other | each restarted by the supervisor after 2 s; the chain recovered from its ledger (`recovered: slot 836, ... 576 history entries`) |
| `kill -9` of the stack supervisor | `HEALTH-ALARM supervisor-down` raised; babysitter ran `frontier-stack resume` 10 s later; 7 strays stopped by exact command line; chain recovered in 0.4 s; everything started in 2 s; the report said `1 resume`; alarm cleared 30 s later; season, invites and quotas intact |
| monitor suspended for 116 s while the chain ran (a stand-in for a machine that sleeps) | one line in `status/gaps.jsonl` (`wall_secs 116, slots 291, game_secs 116`), **no** stall alarm |
| all processes (components, supervisor, babysitter) frozen with SIGSTOP for 100 s, then thawed: the closest stand-in for sleep that does not put this Mac to sleep | during the freeze `status` (outside, live) alarmed `chain-unreachable`, `herald-unreachable`, `keeper-a-status`; after the thaw: no crash event, no restart, keeper alerts 0, reveal payers 150/150, no catch-up burst of slots (146 slots in the 52 awake seconds of that interval, 2.8 per second), one `gaps.jsonl` line (`wall_secs 119, slots 48, game_secs 19`: a gap with almost no game time in it is what a sleep looks like), no alarm file (the monitor was frozen too) |
| `playtest-backup.sh`, `playtest-restore.sh --verify` | 10 MB, 1 s; the backup's chain opens (`slot 1705, game time 1789086238`), both journals `integrity_check ok`, relay state present |
| log rotation with a 1 kB threshold | five logs copied to `logs-archive/*.gz` and truncated in place; the writers continue |
| `playtest-invite.sh` | CSV `invite_code,url`, mode 0600, rejects N=0, a bad label and a non-https base url; the operator token is never printed or put on a command line (read from a 0600 file, handed to curl as a header file) |
| what the herald exposes (probed through 127.0.0.1:41129 and, for the bind, through the LAN address 192.168.3.12) | `/gw/f/operator/pool`, `/gw/f/operator/invites`, `/gw/f/keeper/status`, `/h/admin` and two path-traversal forms all 404 (the operator routes are not on the relay's public listener); every service, the herald included, refuses a connection on the LAN address (all listeners are bound to 127.0.0.1; only a tunnel makes the herald reachable) |
| `playtest-selftest.sh` on the production config and ports (41112-41123, 12 bots, throw-away directory) | up, invite, browser join, event-log line, status healthy, relay `kill -9` and restart, supervisor `kill -9` and resume, backup and verify, clean down with no listener left: **SELFTEST PASSED**; then `playtest-up.sh` again continued the same run (`2 resumes`), and `--fresh` after a down archived the old run and secrets (the gate key changed); `--fresh` while the babysitter runs is refused |
| nudge latency at 1x (`POST /gw/f/nudge` through the herald, six idle provinces) | resolved_next 0 -> 2 in 0.52, 0.51, 0.52, 0.78, 1.04, 1.05 s |
| a full browser playthrough, **at 1x** (PT-B's `play-one.mjs`, headless Chromium, in-page dev wallet, invite typed) | join "Recorded on chain" 2 s after the click; the ticket was filed automatically; the village appeared about 21 minutes after the join (the ticket's draw needs the next bell's seed: settle-ticket landed 1 slot after the seed); Build and Train landed. The browser was then killed from outside twice (a Chromium started by this unit vanished mid-wait, no error in the stack; another session's cleanup of "chrom" processes is the likely cause), so the first 1x march was not completed |
| the same playthrough **at 20x on the production config** (ports 41112-41123, archive + release `.so`, merged tree with PT-B's guest-key page, 12 bots; a throw-away copy of `playtest-1x.toml` with `scale = 20`) | join, village, Build, Train, Muster, compose, **Depart ok in 169 s**; then keeper A: `settle-departure` (bell 5), `reveal` (bell 7: the keeper opened the browser's tlock seal with the archive's real quicknet round), `gather`, `resolve`, `settle-transit` all landed; both keepers show `reveals 1/1`; `status` printed `last clash resolved at bell 7`; one bot had joined through the gate with its issued invite (`joins {"e2e":1,"bots":1}`) |

## 5. Findings

1. **The game page is `/frontier/frontier/`, not `/frontier/`.** The herald maps `permutation-server/web/` under `/frontier/`, so `/` and `/frontier/` open the old prototype's page ("Wylls: ひとつの文明、6つの勢力", the v9 client). A friend given the bare host lands there. PT-B's landing page (`/frontier/frontier/playtest/`, with `--landing` making `/` lead there) fixes it; without those herald flags the invite link must be the landing or game path. **Request R2.**
2. **The game page does not read an invite from the URL.** The invite is typed or pasted into the join screen. PT-B's landing page takes it from `#i=<code>` (a fragment, never sent to a server). `playtest-invite.sh` writes that link when the landing page is in the tree. **Request R1** (for the game page itself, if the landing page is dropped): read `?invite=` or `#i=` into the join draft.
3. **The relay's per-IP limits rely on the herald's `X-Forwarded-For` handling behind a tunnel.** When the herald's peer is loopback it now takes `CF-Connecting-IP` (Cloudflare sets it itself), else the last `X-Forwarded-For` entry (PT-B); if a tunnel ever delivered neither, every friend would look like 127.0.0.1 and be exempt from the per-IP limits (loopback is exempt for the bots). Not testable without a tunnel; the rehearsal should check it with two networks. PT-B's `--ip-rate` on the herald is a second line.
4. **Genesis is about 9 minutes after the start**, and bell 1 (when most state first appears) 10 minutes later; `preseason_scale` could be raised to shorten the first part but the drand round at genesis is the limit. Plan the start accordingly (invites should not go out before genesis + 1 bell is comfortable; joins are accepted from genesis).
5. The stack's `down` and `live_components` used binary-name matching (fixed here, section 3).
6. The shared scratch directory `.../scratchpad/frontier/playtest/` is used by PT-B as well; PT-A's files there are `pta-*`, `probe*`, `dev/`, `bin-test/`, `data-test/`, `test-1x.toml`, `kj-demo4.sqlite`, `join-*`, `play-one.log`.

## 6. Requests

- **R1 (design session, `permutation-server/web/frontier/{controller,screens/join}.mjs`):** read the invite from the page URL (`?invite=` or `#i=`) into `FS.joinDraft.invite` (and drop it from the address bar), so a link works without the landing page.
- **R2 (done by PT-B):** `/` leads to the start page with `--landing` (now in `playtest-1x.toml`); the invite CSV carries the full landing path anyway.
- **R3 (design session, `record-playflow.mjs`):** the Depart loop of section 2.
- **R4 (integrator, before the real start):** rebuild every binary from the merged tree (`cd frontier-node && nice cargo build --offline --locked --release --workspace`; `playtest-up.sh` refuses a binary older than its sources). PT-B committed its herald flags into `playtest-1x.toml` (`[playtest] herald_args`: the guest-key injection and the start page, `a079f81`/`25a8d97`); a binary built before that does not read the key, so a stale `frontier-stack` fails on the config.
- **R5 (owner):** the cloudflared command is printed by `playtest-up.sh` and in `PT-A-OPS.md` section 8; it is yours to run. Decide about a launchd agent for the babysitter, and about `PLAYTEST_BACKUP_COPY_TO`.

## 7. Not verified

- Anything through a real tunnel (the URL, `X-Forwarded-For`, WebSocket through the quick tunnel, whether the URL survives a reconnect after sleep, the quick-tunnel limits): no tunnel was started.
- A real Mac sleep (the stand-ins above; `pmset sleepnow` was not used).
- Restore time for a multi-day chain: 0.4 s measured on a 3-minute-old chain; the ledger is replayed from the newest snapshot (every 6 game hours), and the 20x chaos runs of the exit season recovered a 7-day, 1,000-bot chain, but its time was not re-measured here.
- 30 concurrent human browsers; the herald's behaviour under that is PT-B's rehearsal.
- The numbers marked [model] in the runbook (first holding 11 to 21 minutes after filing, first clash report 31 to 41 after a march departs).
