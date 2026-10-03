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
| ピッチで言えること | 人数は必ず分母つき。「N人招待、うちM人が参加、うちK人が後の日(日本時間のカレンダー日)に操作」。それ以上は言わない(第7節) |

## 1. Start order

### Days before (nothing is exposed)

1. **Merge the design session's last changes** into the tree (the herald serves `permutation-server/web/` as it is at the start; do not edit that directory while friends play). Then build once, with low priority because the Mac is shared: `(cd frontier-node && nice cargo build --offline --locked --release --workspace)`. The release program must be the pinned one (`scripts/playtest-up.sh --dry-run` checks the sha256).
2. **Survey.** Create the external form from [`SURVEY-QUESTIONS.md`](SURVEY-QUESTIONS.md) (no e-mail, no name, no sign-in required). Put its https address in `permutation-server/web/frontier/playtest/config.json` as `"surveyUrl"` (PT-B request M7; the start page then shows "Open the survey" in its footer) and in the `{SURVEY_LINK}` of the guides. Fill `{CONTACT}` in both tester guides (the way friends reach you).
3. `scripts/playtest-up.sh --dry-run` must end clean (binaries, pinned program, drand archive, node 20, web client, ports 41100-41139, 40 GB free, AC power). Optional: `scripts/playtest-selftest.sh` (about 30 minutes, throw-away directory) and a rehearsal (`scripts/playtest/rehearse.sh`, PT-C section 9).
4. Decide the invitation batches and who gets which. Issue **exactly as many codes as you will send** (a spare code counts as "invited" in the numbers, section 8). Keep your own list of who got a code **outside this repository and away from the logs**, or keep only a count.

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
- [ ] **Own test code:** `scripts/playtest-invite.sh 1 --label ops --base-url http://127.0.0.1:41117` and open the link in a browser **on this Mac**; Start; Join. Everything you do with a code labelled `ops` is left out of the numbers with `--exclude-labels bots,ops` (section 8). (This uses one place and is not undone.)
- [ ] `node scripts/playtest-metrics.mjs --exclude-labels bots,ops` runs and shows `N_invited 0` (nothing issued to friends yet) and your `ops` code only under `batches`.
- [ ] `/opt/homebrew/bin/cloudflared --version` answers. No other `cloudflared` is running (`pgrep -fl cloudflared` is empty).
- [ ] Tester guides have no `{CONTACT}` or `{SURVEY_LINK}` left (`grep -n '{' docs/frontier/playtest/TESTER-GUIDE*.md docs/frontier/playtest/INVITE-MESSAGE*.md` shows only the placeholders you mean to fill at send time, i.e. `{LINK}`).
- [ ] A notes file is open for the run (section 4, "Keep a log"): time you said go, the URL, batches sent and how many.
- [ ] Two phones ready for the phone check (one on mobile data, not on your Wi-Fi).

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
3. Open the game page from the phone with your `ops` code and look at the live parts (bell chip moves, map loads): this checks WebSockets through the tunnel.

**Invitations.** At least 10 minutes after genesis:

```sh
scripts/playtest-invite.sh 20 --label friends-1 --base-url https://<words>.trycloudflare.com
```

It prints the path of a CSV (`invite_code,url`, mode 0600, nothing personal) in `$DATA/invites/`. Each url is the start page with the code in the link's fragment (`.../frontier/frontier/playtest/#i=<code>`): the browser never sends the fragment to any server. Send each friend **their own** line with [`INVITE-MESSAGE.md`](INVITE-MESSAGE.md) or [`INVITE-MESSAGE.ja.md`](INVITE-MESSAGE.ja.md) and the tester guide. Use a new label for each batch (`friends-2`, ...), and a separate label for any replacement code (`replace-1`, section 5) and for your own tests (`ops`). Do not use `--max-players` unless you mean bots + people (PT-B M5).

Tell friends the first hour is waiting (a village appears 11 to 21 minutes after joining; a first march is realistic 50 to 90 minutes after joining).

## 4. Monitoring: what to look at every few hours

**Cadence.** The first two hours after go: every 15 to 30 minutes. After that: three or four times a day, always **once before you sleep and once when you wake**, plus when a friend writes to you. The babysitter and the monitor do the watching between your looks; nothing here messages you (the alarm files are the signal: `ls "$DATA"/*ALARM`).

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
| Numbers so far | `node scripts/playtest-metrics.mjs --exclude-labels bots,ops` (read-only) | N_joined rises; N_returned stays 0 until the first JST midnight | a join count that does not match what friends tell you |

**Keep a log.** One plain text file outside git (for example `$DATA/operator-notes.txt`, which `playtest-up.sh` does not touch): each time you say go, change the URL, restart something, see the Mac sleep, send a batch (label and **how many codes you sent**), hear a problem. Write time (JST) and the one-line fact. The pitch's honest account of downtime and of "who was invited" comes from this file and from `status/alarms.jsonl` and `status/gaps.jsonl`.

**Do not**: edit `permutation-server/web/` while friends play; start a second `cloudflared`; run `playtest-up.sh --fresh` (it moves the old run and kills the old invites); read a friend's guest key or ask for it.

## 5. When the URL changes (the quick tunnel restarted)

**Cause.** The quick tunnel is anonymous and has no uptime promise: if the `cloudflared` process stops (you close its tab, it crashes, the Mac restarts, possibly after a long sleep [unverified]), the next run gives a **new random address**. The old link is dead for good.

**What it does to friends.** A browser keeps its guest key per **address** (a new address is a new origin: site storage does not carry over). So a friend who opens the new link has an empty browser: the start page makes a new random key and, with no invitation, says "You need an invitation link" (their old invitation is already used). Their village is not lost **if they saved the key**: on the start page they paste it into "I already have a key" and the page says "Welcome back"; the game then asks them once to rebuild the in-game key (its own SessionMismatch step). A friend who did not save the key cannot get that village back; give them a new code (label `replace-N`), and note that this friend now counts twice in the codes (section 8). The chain and the game are untouched by any of this: no restart of the stack is needed.

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
   node scripts/playtest-metrics.mjs --exclude-labels bots,ops --herald http://127.0.0.1:41117 --gaps "$DATA/status/gaps.jsonl" --people --json "$DATA/final/metrics.json" | tee "$DATA/final/metrics.txt"
   scripts/playtest-status.sh --json > "$DATA/final/status.json"
   shasum -a 256 "$DATA/runs/playtest-1/relay/relay-events.jsonl" | tee "$DATA/final/relay-events.sha256"
   ```

   `--people` replaces citizens, wallets and codes by numbers in the JSON; the numbers in your pitch come from `metrics.txt` and nothing else. (Add `--exclude-labels bots,ops,<your other test labels>` if you issued any.)
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

`scripts/playtest-metrics.mjs` reads **one file**, the relay's event log (`$DATA/runs/playtest-1/relay/relay-events.jsonl`: `invites_issued`, `join`, `action`, `seen`; no name, no e-mail, no address). Its header is the authority; this is the same text in short. A **day** is a calendar day in Japan (UTC+9), taken from the line's own timestamp. Labels matched by `--exclude-labels` (default `bots`; you add `ops` and any test label) are not counted.

| Figure | Literal definition | What it is not |
|---|---|---|
| **N** (`N_invited`) | the sum of `count` over `invites_issued` lines whose label is not excluded: **invitation codes issued** | not "people told" (a spare code, a lost-and-replaced code, a forwarded code all count as codes); equals the number of people invited only if each issued code went to a different person, which is yours to know and note |
| `N_joined` | the number of **distinct invitation codes that completed a join** (a `join` line whose code belongs to a non-excluded batch; `--herald` also checks that each joined wallet exists on the chain) | not "visitors" (people who opened the link and never joined are not in any log); not bots; a person who lost their key and got a second code counts twice |
| **D** | the number of **distinct JST calendar days on which at least one person has a `join` or `action` line** (days nobody acted are not counted; the days need not be consecutive) | not the length of the test: a test from the night of 6 Oct to the night of 9 Oct touches up to 4 calendar days (6, 7, 8, 9), whatever its length in hours |
| per-day active | distinct persons with a `join` or `action` line that day (a join is activity on its day) | "active" means the client was open and a signed action was sent, not "clicked", not time spent |
| **returned** (`N_returned`) | the number of persons with an `action` line on a calendar day **later than the calendar day of their join** (the join itself does not count) | not "stayed N hours"; not "second session"; a join at 23:50 and an action at 00:10 counts as returned (the day changed); the page sends some actions by itself when it is open (the site ticket after a join, settlements), so a tab left open overnight can produce a later-day action |
| median sessions | per joined person, a session = a run of their `join` and `action` lines with no gap above 30 minutes; the lower median over all joined persons | a count of actions, not of visits; two actions 31 minutes apart are two sessions |

`seen` lines (a page asked for its quota) are **never** used in the headline: anyone can ask for anyone's quota. The "incl. visits" variants are printed under `secondary` and must not be quoted as returns.

Derived figures the pitch may use, always as a pair of counts:

- joined of invited: `N_joined` of `N`;
- returned of joined: `N_returned` of `N_joined`.

**What the pitch may say** (fill the variables from `final/metrics.txt` only; keep the definition next to the number):

- "We invited **N** people (N invitation codes, each given to one person); **N_joined** of them joined." (Only if you noted that each code went to a different person; else say "N invitation codes".)
- "**N_returned** of the **N_joined** who joined took a game action on a later calendar day (Japan time) than the day they joined."
- "The test ran in real time for about 3 days; there was activity on **D** calendar days (Japan time). The host's Mac was asleep or frozen for **X** minutes in total (from the monitor's gap log)."
- "In the survey, **k** of **r** respondents chose 'very disappointed'. **r** of the **N_joined** players answered." (The form is anonymous, so the answers cannot be matched to the logs.)
- "The world ran on a local test chain with no money, with about 60 rule-based bots among the players; AI citizens were not part of this test."
- "Of **N_joined**, **M** never took a game action after joining" (`N_joined_never_acted`, under `secondary`).
- Downtime, only as the logs show it: "The monitor raised **A** alarms (list from `status/alarms.jsonl`) and recorded **G** machine gaps totalling **X** minutes."

**What the pitch may not say:**

- A percentage **without both counts** ("60% retention"). With 10 to 30 people one person is 3 to 10 points: give counts, not decimals.
- "Retention", "D1", "D3", "D7" or "daily active users". Those terms have standard meanings (a fixed number of days after install, or a rolling window); our `returned` is "an action on any later calendar day". Say what we measured in the literal words above.
- "N players" or "N users" where bots are included or where it means codes. Bots are excluded from every figure and are never called players or users in the result.
- "N visited / opened the link / tried it". Those people are not in any log.
- Time spent, "engagement", "hours played", "sessions per user" as a measure of enjoyment. The log has no time spent; `median sessions` is a count of action bursts with a 30-minute rule.
- "Came back because they liked it" or any link between survey answers and returns. The survey is anonymous and separate.
- "Product-market fit" or a market claim from the survey. 'Very disappointed' from invited friends of the owner, in a small sample, is not a market sample. Quote it only as "k of r respondents".
- "AI-driven", "AI citizens" or "AI agents" for this test (they were not in it); "on Solana mainnet / devnet" or "on-chain at scale" (it was a local test chain on one Mac); "scales to N players" (the test had at most 30 people and about 90 citizens in total).
- "No downtime" or "everything worked" unless `alarms.jsonl` and `gaps.jsonl` are empty. Quote them instead.
- Anything about a person by name, or "friend X did...". Counts only.

**Say what you did not measure** (one line in any writeup): the numbers are from invited friends, small and not a sample of anyone; they come from the relay's event log of sponsored game actions; people who never joined are not counted; the survey is anonymous and voluntary; the world ran on one Mac that slept or froze for X minutes.

## 9. Open items for this runbook (not blockers)

- A **real tunnel was never run** in any rehearsal: `CF-Connecting-IP`, WebSockets, the address after a restart or sleep, and the request limits are from documentation memory. The phone check in section 3 is the first real test.
- A friend's wish to leave the numbers (tester guide) is done by hand: subtract their code from `N_joined`/`N_returned` and say so; the script has no `--exclude-codes` option yet (see the PT-D report's requests).
- The "returned" measure has no minimum gap (a join at 23:50 and an action at 00:10 count). Say "on a later calendar day".
