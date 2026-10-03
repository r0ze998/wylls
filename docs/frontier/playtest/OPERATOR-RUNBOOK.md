# Wylls friends' playtest: operator runbook (PT-D)

For the person who runs it (the owner). Everything here sits on top of [`PT-A-OPS.md`](PT-A-OPS.md) (the stack and its scripts), [`PT-B-NOTES.md`](PT-B-NOTES.md) (the tester path) and [`PT-C-NOTES.md`](PT-C-NOTES.md) (rehearsals and the metrics script); when this file and one of those disagree about a command, the script's own `--help` wins. This is the **local-chain** playtest: not the devnet playtest of [`../m1/PLAYTEST-RUNBOOK.md`](../m1/PLAYTEST-RUNBOOK.md) (O-M1-18 stays unapproved).

> **Nothing in this repository starts the tunnel.** `playtest-up.sh` runs everything on 127.0.0.1. Exposure is the one `cloudflared` command in section 3, which you type yourself, when you say go.

Shell variable used below (the default data root; `PLAYTEST_DATA` overrides it):

```sh
cd /Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/playtest
DATA=/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/data/playtest
```

| 日本語メモ | |
|---|---|
| 順番 | 準備(ビルド・dry-run・アンケート作成)→ 公開の24時間前に `playtest-up.sh` → 前日チェックリスト → あなたが「go」→ `cloudflared` を1本だけ実行 → 招待を発行して送る |
| 数字の出どころ | `node scripts/playtest-metrics.mjs` だけ(リレーのイベントログ)。**`playtest-down.sh` の前に**実行(`--herald` はチェーンが動いている間だけ使える) |
| URLが変わったら | 新しいリンクを全員に送る。参加済みの人は、保存した鍵を開始ページの「鍵を持っています」に入れる(鍵を保存していない人は村を失う) |
| Macがスリープしたら | ゲーム時計も止まる(壊れない、遅れるだけ)。トンネルは切れる。復帰後に URL を確認し、`status/gaps.jsonl` が記録する |
| ピッチで言えること | 人数は必ず分母つき。「N通の招待を送り、うちM人が参加、うちK人が12時間以上あけてまたゲームの操作をした」。それ以上は言わない(第8節。日付が変わっただけの操作は「戻った」に数えません。数え方は最初の招待を送る前に固定済み) |
| 数える招待 | ラベルが `friends-*` のものだけ。自分のテストは必ず `--label ops`。ラベルなしでは発行できません |
| 警告 | 新しいアラームや、監視の空白(スリープ)は、このMacの通知と音声でも知らせます。`playtest-up.sh` が見張り役(sentinel)も起動します |

## 1. Start order

### Days before (nothing is exposed)

1. **Merge the design session's last changes** into the tree (the herald serves `permutation-server/web/` as it is at the start; do not edit that directory while friends play). Then build once, with low priority because the Mac is shared: `(cd frontier-node && nice cargo build --offline --locked --release --workspace)`. The release program must be the pinned one (`scripts/playtest-up.sh --dry-run` checks the sha256).
2. **Survey.** Create the external form from [`SURVEY-QUESTIONS.md`](SURVEY-QUESTIONS.md) (no e-mail, no name, no sign-in required). Put its https address in `permutation-server/web/frontier/playtest/config.json` as `"surveyUrl"` (PT-B request M7; the start page then shows "Open the survey" in its footer) and in the `{SURVEY_LINK}` of the guides. Fill `{CONTACT}` in both tester guides (the way friends reach you).
3. `scripts/playtest-up.sh --dry-run` must end clean (binaries, pinned program, drand archive, node 20, web client, ports 41100-41139, 40 GB free, AC power). Optional: `scripts/playtest-selftest.sh` (about 30 minutes, throw-away directory) and a rehearsal (`scripts/playtest/rehearse.sh`, PT-C section 9). The exposure checks run against a stack on a **throw-away data directory** (`PLAYTEST_DATA=/some/scratch scripts/playtest-up.sh`, then `abuse-check.mjs`, `abuse-burst.mjs`, `abuse-state.mjs`, `pte-live-checks.mjs`, `landing-states.mjs`, `returning.mjs` under `scripts/playtest/`, then `scripts/playtest-privacy-check.sh`, `playtest-down.sh`); they were run that way on 2026-10-04 (PT-E). Never run them against the real data directory.
4. Decide the invitation batches and who gets which. Issue **exactly as many codes as you will send** (the numbers print codes issued and codes sent side by side, and the pitch quotes the sent number, section 8). **Ask each friend what they will play on before you send a code**: an iPhone needs iOS 17 or newer (older ones cannot run the game in any browser), and a LINE tap needs one extra step (the page tells them). Keep your own list of who got a code **outside this repository and away from the logs**, or keep only a count.
5. **The relay's modules are a copy, not a link.** `permutation-gateway/node_modules` must be a real directory inside this worktree (an APFS clone: `rm permutation-gateway/node_modules && cp -c -R <other>/permutation-gateway/node_modules permutation-gateway/node_modules`, instant and free). A symlink into another worktree dies when that worktree is cleaned, and every relay restart then fails for good; `playtest-up.sh` refuses a symlink and the monitor alarms `relay-modules` if the package disappears. Node is the one at `/opt/homebrew/opt/node@20` (its version is in `launch.json`); do not `brew upgrade` during the test.
6. **The machine is shared with other sessions.** The live stack now runs at normal priority (a rehearsal on a busy Mac: `PLAYTEST_NICE=5 scripts/playtest-up.sh`). Ask the other sessions to stop heavy builds from the night of 6 October until the end; contention only slows bells and the game clock (lag, not breakage), but it is visible to friends. `playtest-up.sh` raises the open-file limit to 10,240 for everything it starts (a Terminal shell has 256) and prints the value; the herald caps its WebSockets at 400.

### T-24 h (the night before the first invitation)

`scripts/playtest-up.sh` (about a minute; the season's genesis is about 9 minutes later). The stack starts in this order, by itself: chain (`frontier-localnet`), `drand-replay`, keeper A, keeper B, relay, herald, bots; the babysitter then watches the supervisor, runs the monitor every 30 s and the hourly backup. Why 24 hours ahead: the 60 bots join on a schedule (36 of them across game day 0), so friends arrive to a world with about 36 bots in it. Starting on the same evening leaves the first hours nearly empty.

After 15 minutes: `scripts/playtest-status.sh` shows genesis passed, 37 provinces, both keepers 150/150, `invite required: true`, no alarm file.

### Order of the whole thing

`up` (T-24 h) -> checklist (section 2, T-2 h) -> **you say go** -> `cloudflared` (section 3) -> phone check -> `playtest-invite.sh` -> send links, about **10 minutes after genesis at the earliest** and never in the first bell (PT-C section 7) -> monitoring (section 4) -> final metrics -> stop `cloudflared` -> `playtest-down.sh` -> archive (section 7).

## 2. Checklist before you say go

Tick every line; do it at T-2 h so there is time to fix something.

- [ ] **Mac:** on AC power, lid open, "Prevent automatic sleeping on power adapter when the display is off" on, automatic update restarts off, Low Power Mode off (PT-A-OPS section 7).
- [ ] `scripts/playtest-status.sh` exits 0: no `LAG-ALARM` / `HEALTH-ALARM` in `$DATA`; every process up; every port on loopback; keepers 150/150; relay pool at least 20 eligible payers; `invite required: true`; free disk above 40 GB; a backup less than 3 hours old; bots joining (`INVITES` line, label `bots`).
- [ ] `scripts/playtest-backup.sh` by hand, then `scripts/playtest-restore.sh --verify` passes.
- [ ] **The tester path is in the served page:** `curl -s http://127.0.0.1:41117/frontier/frontier/index.html | grep -c playtest/boot.mjs` prints `1` (PT-B M1). `curl -s http://127.0.0.1:41117/frontier/frontier/playtest/ | head -5` returns the start page.
- [ ] **Survey:** `surveyUrl` is set to the https form; you opened the form in a private window and submitted a test answer; it asks for no e-mail and does not require sign-in.
- [ ] **Own test code:** `scripts/playtest-invite.sh 1 --label ops --base-url http://127.0.0.1:41117` and open the link in a browser **on this Mac**; Start; Join. Every code you issue for your own tests, a second device included, must carry `--label ops`: only labels starting with `friends-` are counted (section 8) and `--label` is required. (This uses one place and is not undone.) Do not run the browser scripts of `scripts/playtest/` (`abuse-burst.mjs`, `play-one.mjs`, ...) against the real stack's port 41117 once friends are in: they would add citizens and requests to the real log; rehearse on a throw-away data directory.
- [ ] `node scripts/playtest-metrics.mjs` runs and shows `N_invited 0` (nothing issued to friends yet), and the `LABELS` table lists your `ops` code and the bots as "not counted".
- [ ] **The watchers.** `scripts/playtest-sentinel.sh --once` prints nothing and exits 0 (`playtest-up.sh` started the sentinel: it speaks on this Mac if the babysitter dies, the monitor goes quiet for 5 minutes or an alarm file appears). In a terminal you keep visible: `watch -n 60 'ls -l "$DATA"/*ALARM 2>&1 | tail -3; tail -n 2 "$DATA"/status/alarms.jsonl'`.
- [ ] **Hard gate: a real sleep.** With the tunnel up, close the lid (or `pmset sleepnow`) for 10 minutes, wake the Mac, then check: `tail -n 2 "$DATA"/status/gaps.jsonl` shows the gap, the notification "Wylls playtest gap" appeared, the stack is healthy (`playtest-status.sh`), and the tunnel address is the same or you know the new one (section 5). If the stack does not come back by itself, do not go.
- [ ] **Hard gate: the phone check of section 3 passed**, including the iPhone Safari WebSocket step and the LINE step.
- [ ] `/opt/homebrew/bin/cloudflared --version` answers. No other `cloudflared` is running (`pgrep -fl cloudflared` is empty).
- [ ] Tester guides have no `{CONTACT}` or `{SURVEY_LINK}` left (`grep -n '{' docs/frontier/playtest/TESTER-GUIDE*.md docs/frontier/playtest/INVITE-MESSAGE*.md` shows only the placeholders you mean to fill at send time, i.e. `{LINK}`).
- [ ] A notes file is open for the run (section 4, "Keep a log"): time you said go, the URL, batches sent and how many.
- [ ] Two phones ready for the phone check (one on mobile data, not on your Wi-Fi), one of them an iPhone with Safari.
- [ ] You know that several friends behind **one home or office Wi-Fi, or one phone carrier's shared address**, share the per-address limits (quota lookups 2 a second, relayed actions 2 a second, 6 WebSockets): for 10 to 30 friends this is accepted. If two people on one network see slow or missing quota displays, that is why, not a fault; the per-citizen quotas are the real guard.

## 3. Go: the tunnel, the phone check, the first invitations

The one command, in its own terminal tab that you leave open for the whole test (the same command `playtest-up.sh` prints; it exposes the herald, port 41117, and nothing else):

```sh
/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:41117 --logfile "$DATA/logs/cloudflared.log"
```

It prints a random `https://<words>.trycloudflare.com`; the same address is in the logfile, and `playtest-status.sh` shows it. Write it into your notes. Do not point a tunnel at any other port (relay 41115/41116, keepers, chain, drand and bots are not for the outside; `status` alarms on a listener that is not loopback).

**Phone check** (PT-B M6; the tunnel was never started in any rehearsal, so this is the first time the real thing is seen):

1. On the phone **on mobile data**, open `https://<host>/frontier/frontier/playtest/`. The start page should load and say "You need an invitation link" (no code yet). If it says the game is not reachable, look at the tunnel tab and `status`.
2. From this Mac, through the public address, check that the per-visitor limits really see you as a visitor (the limits exempt loopback; if Cloudflare did not pass the visitor's address, every friend would be exempt):

   ```sh
   URL=https://<words>.trycloudflare.com
   curl -s -o /dev/null -w '%{http_code}\n' "$URL/h/status"      # 200
   for i in $(seq 1 14); do curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'Content-Type: application/json' -d '{"invite":""}' "$URL/gw/f/invite-check"; done; echo
   ```

   Expected: `200` for about the first 10, then `429`. Then repeat the invite-check once from the phone (mobile data): it must answer normally, because the limit is per address. **If you never see a 429 here, stop**: the per-address limits are not applying to tunnel visitors (the relay would be counting everyone as one address or as loopback); do not send invitations, note it and ask for a fix.
3. Open the game page from the phone with your `ops` code and look at the live parts (bell chip moves, map loads): this checks WebSockets through the tunnel. **On an iPhone with Safari (iOS 17 or newer):** the game page must keep its live connection (the page's CSP allows `connect-src 'self'` only, and Safari's handling of `wss:` under it was not tested), so watch the bell chip for two minutes and check `ws_open` in `scripts/playtest-status.sh` (the HERALD line) goes up by one for the phone.
4. **The LINE path.** Send yourself the `ops` link in a LINE message and tap it there: the start page must show "Please open this in Safari or Chrome" with a Copy link button and no Start; copy the link, paste it into Safari, and the page must say the invitation works (the code travels in the link). Also try "open in browser" from LINE's menu. Throw the `ops` code away afterwards; no friend's code was used.
5. **No addresses in our files.** After the first requests through the tunnel, and again after the first day, run `scripts/playtest-privacy-check.sh`: it must report no IP address in any file we keep (the relay state, the logs, the event log, the status files, the backups).

**Invitations.** At least 10 minutes after genesis:

```sh
scripts/playtest-invite.sh 20 --label friends-1 --base-url https://<words>.trycloudflare.com
```

It prints the path of a CSV (`invite_code,url`, mode 0600, nothing personal) in `$DATA/invites/`. Each url is the start page with the code in the link's fragment (`.../frontier/frontier/playtest/#i=<code>`): the browser never sends the fragment to any server. Send each friend **their own** line with [`INVITE-MESSAGE.md`](INVITE-MESSAGE.md) or [`INVITE-MESSAGE.ja.md`](INVITE-MESSAGE.ja.md) and the tester guide. Use a new label for each batch (`friends-2`, ...), and a separate label for any replacement code (`replace-1`, section 5) and for your own tests (`ops`). Do not use `--max-players` unless you mean bots + people (PT-B M5).

Tell friends the first hour is waiting (a village appears 11 to 21 minutes after joining, may stay provisional for up to about 4 hours, and only a confirmed village can muster, explore or march; the time from provisional to confirmed was **not measured** in any rehearsal, so write down what the first friends see).

## 4. Monitoring: what to look at every few hours

**Cadence.** The first two hours after go: every 15 to 30 minutes. After that: three or four times a day, always **once before you sleep and once when you wake**, plus when a friend writes to you. The babysitter and the monitor do the watching between your looks; a new alarm, a monitoring gap over 10 minutes and a dead babysitter are also **said aloud on this Mac** (a notification and a spoken line; local only, nothing is sent anywhere). Keep the Mac's volume up at night and Do Not Disturb off for that notification. The alarm files stay the record: `ls "$DATA"/*ALARM`. Nobody is told if the Mac itself is off or asleep: that is what the first look after you wake is for.

**Each look** (about two minutes):

| Look | Command / place | Healthy | Act when |
|---|---|---|---|
| Health and alarms | `scripts/playtest-status.sh` (exit 0 healthy, 1 alarm, 2 down) and `ls "$DATA"/LAG-ALARM "$DATA"/HEALTH-ALARM` | exit 0, no alarm file | any alarm file or exit 1/2: PT-A-OPS sections 4 and 10 |
| The bell moves | `BELL` line against your notes: one bell per 10 real minutes | game day = (hours awake) / 24 | the bell lags the wall clock more than expected: the Mac slept (section 6), see `status/gaps.jsonl` |
| Tunnel | the `MACHINE` line (cloudflared running and its URL) and `curl -s -o /dev/null -w '%{http_code}\n' "$URL/h/status"` | 200, the URL equals your notes | not 200 or URL changed: section 5 |
| Resolve lag | the `RESOLVED` line | lag up to about 27 bells is normal (idle provinces are skipped in batches); alarm at 36 | `world-lag` / `anchor-lag`: keeper A's log; a keeper restart is safe |
| People | the `INVITES` line: issued and joins per label | joins of `friends-*` grow; `bots` joins grow through day 5 | a friend says they cannot join: the code is used or mistyped (PT-A-OPS section 10) |
| Relay and keepers | `RELAY` pool (eligible payers at least 20), `KEEPER-A/B` pending and alerts | pending small, alerts a number not a warning (PT-C section 7) | `relay-pool` alarm: the pool was spent; stop issuing, see the relay log |
| Disk and backups | `DISK` line | free above 40 GB, backup less than 3 h old | under 40 GB: `du -sh "$DATA"/*` |
| Gaps | `tail -n 3 "$DATA"/status/gaps.jsonl` | no new line | a new line is a freeze or sleep: write it in your notes (section 6) |
| Relay catch-up | `grep -c 'caught up by the keeper' "$DATA"/runs/playtest-1/logs/relay.log` and `grep -c 'no catch-up (gave up' ...` | the second count stays 0 or very small | many gave-ups: friends see "has not resolved the previous bells yet"; the wait is 20 s (PT-C section 6) and this log is the first real distribution at 1x |
| Numbers so far | `node scripts/playtest-metrics.mjs` (read-only; counts only labels `friends-*`) | N_joined rises; N_returned stays 0 for the first 12 hours after the first joins | a join count that does not match what friends tell you; a `WARNING: unexpected label` line |

**Keep a log.** One plain text file outside git (for example `$DATA/operator-notes.txt`, which `playtest-up.sh` does not touch): each time you say go, change the URL, restart something, see the Mac sleep, send a batch (label and **how many codes you sent**), hear a problem. Write time (JST) and the one-line fact. The pitch's honest account of downtime and of "who was invited" comes from this file and from `status/alarms.jsonl` and `status/gaps.jsonl`.

**Do not**: edit `permutation-server/web/` while friends play; start a second `cloudflared`; run `playtest-up.sh --fresh` (it moves the old run and kills the old invites); read a friend's guest key or ask for it.

## 5. When the URL changes (the quick tunnel restarted)

**Cause.** The quick tunnel is anonymous and has no uptime promise: if the `cloudflared` process stops (you close its tab, it crashes, the Mac restarts, possibly after a long sleep [unverified]), the next run gives a **new random address**. The old link is dead for good.

**What it does to friends.** A browser keeps its guest key per **address** (a new address is a new origin: site storage does not carry over). So a friend who opens the new link has an empty browser: the start page makes a new random key and, with no invitation, says "You need an invitation link" and, since PT-E, tells them in the same card to paste a saved key into "I already have a key", a box that is opened for them (their old invitation is already used). Their village is not lost **if they saved the key**: they paste it and the page says "Welcome back"; the game then asks them once to rebuild the in-game key (its own SessionMismatch step; the invitation message says so, so they are not surprised). A friend who did not save the key cannot get that village back; give them a new code (label `replace-N`), and note that this friend now counts twice in the codes (section 8). The chain and the game are untouched by any of this: no restart of the stack is needed.

**Steps.**

1. Do not restart the stack. Restart the tunnel with the same command (section 3), in the same tab. Note the new address and the time in your notes.
2. Check it as in the phone check, steps 1 and 3 (the start page loads; the game page shows a live bell).
3. Send **everyone who joined** one message with the new bare link `https://<new>/frontier/frontier/playtest/` (no code) and one sentence: "The address changed; open this, put your saved key into 'I already have a key', and you are back." The "address changed" text in [`INVITE-MESSAGE.md`](INVITE-MESSAGE.md) is written for this. Friends who have **not joined yet** keep their codes (the codes do not depend on the address): send them the same link with the new host, `https://<new>/frontier/frontier/playtest/#i=<code>`; the CSV still holds the old host, so replace it (for example `sed 's#https://[a-z0-9-]*\.trycloudflare\.com#https://<new>#' "$DATA"/invites/<file>.csv`).
4. Later batches: `playtest-invite.sh N --label ... --base-url https://<new>` (the script reads the address from the cloudflared log if you omit it).
5. Prevention: one tab, never closed, no second command, the Mac awake (section 6). Tell friends in the first message to **save the key on day one** (the invitation message and the guide already do).

## 6. When the Mac sleeps

The game clock is the chain's slot count, so a sleeping Mac does **not** break the game: the chain makes no slots, the game clock stops, and when the Mac wakes everything continues; no bell is skipped and nothing resolves early or late on the chain's own clock (PT-A-OPS section 7; the 30-minute freeze drill of PT-C confirmed the freeze half, but a real sleep was not tried). What changes is the mapping between game time and wall time, and friends cannot reach the game meanwhile (the tunnel drops).

- **Prevent it:** AC power, lid open (a closed lid sleeps a laptop unless it is in clamshell mode with an external display, keyboard and power), the battery option in section 2, no manual sleep. `playtest-up.sh` already holds `caffeinate -i -m -s` on the babysitter.
- **If you know you must leave without power or close the lid:** `scripts/playtest-down.sh` first (clean stop, final backup), then `scripts/playtest-up.sh` afterwards (continues the same season). Tell friends the time and that the game is paused.
- **After a sleep (or a reboot):** check the Mac is on, `scripts/playtest-up.sh` if the babysitter is gone (`HEALTH-ALARM: babysitter-down`), `scripts/playtest-status.sh`, and the tunnel: it may be down or may have a **new address** (section 5). `tail "$DATA"/status/gaps.jsonl`: a sleep shows `slots` and `game_secs` near 0 with a large `wall_secs`. Write it in your notes with the time.
- **Account for it in any report.** Say the played time in **game days** (what the chain's clock shows) and how many hours the Mac slept in total: `node scripts/playtest-metrics.mjs ... --gaps "$DATA"/status/gaps.jsonl` prints `machine gaps: <count>, <minutes> min`. A 6-hour sleep makes the game 6 hours younger than the wall clock; friends who returned on "a later day" may have seen the world paused in between.

## 7. Stop and archive

Order matters: the metrics check against the chain (`--herald`) needs the stack running.

1. **Tell friends** the test is ending (a day before if you can) and when the survey closes.
2. **Final numbers, stack still up:**

   ```sh
   mkdir -p "$DATA/final"
   node scripts/playtest-metrics.mjs --final --herald http://127.0.0.1:41117 --gaps "$DATA/status/gaps.jsonl" --invited-sent <codes you actually sent> --replacement-codes <how many of those were replacements> --exclude-codes "$DATA/exclude-codes.txt" --people --json "$DATA/final/metrics.json" | tee "$DATA/final/metrics.txt"
   scripts/playtest-status.sh --json > "$DATA/final/status.json"
   shasum -a 256 "$DATA/runs/playtest-1/relay/relay-events.jsonl" | tee "$DATA/final/relay-events.sha256"
   ```

   `--people` replaces citizens, wallets and codes by numbers in the JSON; the numbers in your pitch come from `metrics.txt` and nothing else. `--final` makes the script **fail (exit 3)** if the log holds any label other than `friends-*`, `bots` or `ops`: look at the `LABELS` table, decide what the unexpected label was (a forgotten test, a replacement batch), and either rename the rule (`--include-labels 'friends-*,replace-*'`, if those codes went to friends) or leave it uncounted, then say so. `exclude-codes.txt` holds one invitation code (or its 24-hex nonce) per line for each friend who asked to be left out; it is yours, outside git, and is deleted with the CSVs. `--reminders <ISO times>` marks returns that came within 6 hours after a reminder you sent.
3. **Stop the tunnel first:** Ctrl-C in its tab (friends see Cloudflare's error page from now on). Then `scripts/playtest-down.sh` (stops the babysitter, the stack and every component in reverse order, takes a last backup). Nothing is deleted; the season is simply never ended.
4. **Archive** (everything the numbers and the account need; the gate key, invite secret, payer keys and relay tokens are left out on purpose):

   ```sh
   A="$DATA/archive/playtest-$(date +%Y%m%d)"; mkdir -p "$A"
   tar -C "$DATA" -czf "$A/playtest-run.tgz" --exclude='secrets' --exclude='keys' --exclude='*token*' --exclude='backups' runs status final launch.json
   shasum -a 256 "$A/playtest-run.tgz" > "$A/playtest-run.sha256"; ls -l "$A"
   ```

   It holds the chain (ledger and snapshots), the keepers' journals, the relay's event log and state, the herald's files, `status/` (history, alarms, gaps), `launch.json` (what ran: git head, sha256 of config, program and binaries) and `final/`. Copy it to a second place (another volume or cloud storage) if you want to keep it: a backup on the same disk does not protect against a dead disk. Also keep your **notes file** (section 4).
5. **Tidy:** delete the CSVs in `$DATA/invites/` once you no longer need them (codes are dead after the season, but the files are bearer secrets); delete any list you made of who got which code unless you have a reason to keep it; if you installed the optional launchd agent (PT-A-OPS section 3), unload and remove it. `scripts/playtest-up.sh --fresh` would later archive the old run **and the old secrets** to `old/<stamp>/`.
6. **Survey:** close the form; export the answers; count responses (`r`).

## 8. The numbers: exact definitions, and what the pitch may say

**These rules were fixed (PT-E, 2026-10-04) before the first invitation goes out, so they are pre-registered: do not change a definition after you have seen the data.** If you must, say so in the writeup.

`scripts/playtest-metrics.mjs` reads **one file**, the relay's event log (`$DATA/runs/playtest-1/relay/relay-events.jsonl`: `invites_issued`, `join`, `action`, `seen`; no name, no e-mail, no address). Its header is the authority; this is the same text in short. A **day** is a calendar day in Japan (UTC+9), taken from the line's own timestamp.

**Why the old "came back on a later calendar day" is gone.** The test opens on the night of 6 October: many people join at 21:00 to 23:59 and keep playing past midnight, so someone who plays 22:00 to 01:00 in one sitting would have counted as having "returned on a later day". Also the page sends some transactions by itself: the first site ticket (`FileTicket`) right after every join (once per join in the rehearsals), a rebuilt in-game key (`SetSession`, which every friend does after an address change) and march settlements (`SettleTransit`, `SettleExplore`). None of those is a person choosing to play. The calendar-day figure survives only as a labelled secondary number.

**Which codes count.** Only batches whose label starts with `friends-` (`--include-labels`, default `friends-*`). Everything else (`bots`, `ops`, `unlabelled-DO-NOT-COUNT`, `replace-1` unless you include it, any typo) is **not counted**, and the `LABELS` table of the script lists every label with its codes issued and its joins, so nothing hides. `playtest-invite.sh` refuses to run without `--label`. With `--final` the script exits 3 if the log holds a label that is not `friends-*`, `bots` or `ops`.

**What a person did.** *Deliberate* actions are `Harvest, Build, Train, Muster, Garrison, Dissolve, Depart, Explore, SetVigil`. `Join`, `FileTicket`, `SetSession`, `SettleTransit`, `SettleExplore` and anything not in that list are never counted as play.

| Figure | Literal definition | What it is not |
|---|---|---|
| **N sent** (`--invited-sent`) | **the number of codes you actually sent to people** (your own note), printed beside `N_invited`; the pitch quotes this one | a code you issued and did not send; replacement codes are printed separately (`--replacement-codes R`) and a friend who received a replacement is one person, so `N sent` minus `R` is the number of people if every replacement replaced a code that was also sent |
| `N_invited` | codes **issued** in counted batches, minus the codes in `--exclude-codes` | not "people told" |
| `N_joined` | **distinct invitation codes that completed a join** in counted batches (minus `--exclude-codes`); `--herald` checks that each joined wallet exists on the chain | not "visitors" (people who opened the link and never joined are in no log); not bots; a person who lost their key and got a second code counts twice (say `R`) |
| **returned** (`N_returned`) | persons with a **deliberate action that came at least 12 hours after their previous deliberate action, or after their join if there is none before it**: "took a game action after a break of at least 12 hours". The 18 and 24 hour versions are printed beside it | not "the date changed"; someone who plays 22:00 to 01:00 in one sitting is **not** counted; not "stayed N hours" |
| `N_acted_late` | persons with a deliberate action **at least 12 hours after their join**, even if they played all the time in between | weaker than `returned`: use only the sentence in the list below |
| **elapsed** | hours from the first counted join to the last deliberate action of a counted person; with the per-day table (people and deliberate actions per calendar day) | not "D days" |
| median sessions | per joined person, a session = a run of their join and deliberate actions with no gap above 30 minutes; the lower median | a count of action bursts, not time spent |
| secondary (not for the pitch) | calendar days with activity (`D`); returned on a later calendar day by any action; "incl. visits" variants | inflated by the night start and automatic actions; kept for validating the pipeline only |

`seen` lines (a page asked for its quota) are **never** used in a headline.

**Reminders.** If you send "your village is still there" messages (the invitation message has one), **write the time and the wording in your operator notes**. Pass the times with `--reminders`: returns whose action came within 6 hours after a reminder are printed separately ("prompted, not organic"). The pitch must name the reminders: "The host sent reminder messages on [dates]; returns after a reminder are not organic."

**Leaving someone out.** A friend who asks (tester guide) goes into `exclude-codes.txt` (their code, or its 24-hex nonce). The script removes them from `N_invited`, `N_joined`, `returned` and sessions and prints how many it removed. Do not hand-subtract.

Derived figures the pitch may use, always as a pair of counts: joined of sent (`N_joined` of `N sent`); returned of joined (`N_returned` of `N_joined`).

**What the pitch may say** (fill the variables from `final/metrics.txt` only; keep the definition next to the number):

- "We sent **N sent** invitation codes (one per person; **R** of them were replacement codes); **N_joined** people joined." (If you cannot say one per person: "**N sent** invitation codes".)
- "**N_returned** of the **N_joined** who joined took a game action again after a break of at least 12 hours." (From `N_returned`. The test ran in real time from the night of 6 October.) Or, if you quote the weaker figure, only in these words: "**N_acted_late** of the **N_joined** took a game action at least 12 hours after joining."
- "The test ran for about **elapsed** hours from the first friend's join to the last game action; activity by calendar day (Japan time) was [per-day table]. The host's Mac was asleep or frozen for **X** minutes in total (from the monitor's gap log)."
- "The host sent reminder messages on [dates]; returns after a reminder are not organic." (Required if you sent any.)
- "**r** anonymous survey responses were received; they cannot be matched to the activity logs or checked for duplicates; **k** of the **r_in** respondents who said they got into the game chose 'very disappointed'." ([`SURVEY-QUESTIONS.md`](SURVEY-QUESTIONS.md).)
- "The world ran on a local test chain with no money, with about 60 rule-based bots among the players (the bots are not counted anywhere above); AI citizens were not part of this test."
- "Of **N_joined**, **M** never took a deliberate game action after joining" (`N_joined_never_acted`, under `secondary`).
- Downtime, only as the logs show it: "The monitor raised **A** alarms (list from `status/alarms.jsonl`) and recorded **G** machine gaps totalling **X** minutes."

**What the pitch may not say:**

- A percentage **without both counts** ("60% retention"). With 10 to 30 people one person is 3 to 10 points: give counts, not decimals.
- "Retention", "D1", "D3", "D7" or "daily active users"; "came back the next day"; "returned on a later day" (the old, withdrawn definition).
- "**r of the N_joined players answered**", or any response rate: the survey is anonymous, open and can be answered twice.
- "N players" or "N users" where bots are included or where it means codes. Bots are excluded from every figure and are never called players or users.
- "N visited / opened the link / tried it". Those people are not in any log.
- Time spent, "engagement", "hours played", "sessions per user" as a measure of enjoyment.
- "Came back because they liked it" or any link between survey answers and returns. "Organic" returns, if any reminder was sent (and say plainly that returns can be prompted).
- **"Multiplayer", "players fought each other / competed / cooperated", "a living community", "social".** The log cannot show it: bots fill most of the world, and nothing in the log ties one friend's march to another friend's. Say it only if a separate per-citizen march log (not part of this test's tooling) shows friend-to-friend interaction.
- "Product-market fit" or a market claim from the survey. 'Very disappointed' from invited friends of the owner, in a small sample, is not a market sample. Quote it only as "k of r_in respondents".
- "AI-driven", "AI citizens" or "AI agents" for this test (they were not in it); "on Solana mainnet / devnet" or "on-chain at scale" (it was a local test chain on one Mac); "scales to N players" (the test had at most 30 people and about 90 citizens in total).
- "No downtime" or "everything worked" unless `alarms.jsonl` and `gaps.jsonl` are empty. Quote them instead.
- Anything about a person by name, or "friend X did...". Counts only.

**Say what you did not measure** (one line in any writeup): the numbers are from invited friends, small and not a sample of anyone; they come from the relay's event log of sponsored game actions; people who never joined are not counted; the survey is anonymous and voluntary; the world ran on one Mac that slept or froze for X minutes.

## 9. Open items for this runbook (not blockers)

- A **real tunnel was never run** in any rehearsal: `CF-Connecting-IP`, WebSockets through it, the address after a restart or sleep, Safari's handling of `wss:` under the page's CSP, and a real lid-closed sleep are unverified. Section 2 and section 3 make them **hard gates** you pass before the first invitation: the phone check (429 must be seen, iPhone Safari live connection, the LINE path) and the 10-minute sleep.
- The time from "provisional" to "confirmed" village (up to 24 bells = 4 hours by the contract) was **not measured**; the guides say "up to about 4 hours".
- The page error in `people/crowds.mjs` (`hexCentre`, null tile) seen at 10x in the crowd rehearsal is the design session's (request C1) and was not fixed here.
- The playtest branch lacks later `frontier/unify` commits (herald art fix 7210ebf, canvas-label language switch 2747344): merge them and re-run `scripts/playtest/abuse-check.mjs`, `landing-states.mjs`, `returning.mjs` and the tests before the go, if the design session wants them in the test.
