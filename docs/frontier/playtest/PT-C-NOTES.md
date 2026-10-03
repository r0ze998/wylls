# PT-C: rehearsal of the friends' playtest, and the numbers for the pitch

Unit PT-C of the friends' playtest (branch `frontier/playtest`, local commits only). Scope: before the owner invites anyone, run **a crowd of about 20 scripted "friends"** against the playtest stack that PT-A and PT-B built, at the real clock and at 10x, break the stack on a schedule while they play, measure what a friend would feel, and write the script that turns the relay's log into the numbers of the pitch. Everything ran on this Mac, on 127.0.0.1 and an https stand-in for the tunnel; **no real tunnel was started**, nothing was pushed, and the real data directory `.claude/data/playtest/` was never created (each rehearsal had its own throw-away data directory).

Contents: 1 what was run, 2 results at the real clock, 3 results at 10x (3 game days), 4 drills, 5 the metrics script and its validation, 6 problems found and fixed, 7 problems found and not fixed here (requests), 8 what this does not show, 9 how to rerun.

## 1. What was run

| | rehearsal `r1x` | rehearsal `r10x` |
|---|---|---|
| clock | **1x** (the real clock), `scale = 1` | **10x**, `scale = 10` |
| stack | `configs/playtest-1x.toml` as it is (release `.so` pinned, archive beacon, 60 rule bots, keepers A and B, invite gate, guest-key page, landing page), only `run_id` and the ports differ (`scripts/playtest/mkconfig.mjs`) | the same with `scale = 10`, ports shifted by 12 (41124-41135), so both ran side by side |
| crowd | 20 friends + 2 "bad invitation" visitors, for **180 min** (about 15 bells) after the world opened | 20 + 2 for **432 min** (= 3 game days: bells 0 to 403) |
| invitations | 26 issued with label `friends-crowd` (20 redeemed), the 60 bot invitations have label `bots` | the same |
| wall time | 2026-10-04 00:08 to 03:20 JST | 2026-10-04 00:08 to 07:24 JST |

**The crowd** (`scripts/playtest/crowd.mjs`). One headless Chromium, one browser context per friend, opened on `https://wylls.test:<port>` (`scripts/playtest/fake-tunnel.mjs` with `--client-ip-from-header`): a secure, non-loopback page, so there is no dev wallet and only the **guest key**, exactly what a friend behind the tunnel gets, and **every friend has an address of its own** (203.0.113.x; ids 0-1, 2-3 and 4-6 share one address each, as households do), so the herald's and relay's per-address limits really apply. A friend arrives through the **landing page with the invitation in the fragment** (`#i=<code>`), makes the guest key, picks a nation, presses Join, waits for the village, builds, harvests, trains, musters, explores with a Scout, composes and seals marches to a random listed destination (60 % the barbarian camp), looks at the map, the march list and reports, and **comes back later**: a new session in the same site data, by the bare host (65 %) or the invitation link again (35 %: "welcome back"). Four personas (seeded; `--seed`): diehard (sessions 6-15 min, gaps 8-25 min), regular (3-8, 25-70), casual (3-6, one or two returns after 60-150 min), bouncer (1-3 min, once). Think time between clicks is log-normal, median 4 s. A tester presses what a person presses; it reads the game's own state through the page's modules (as `play-one.mjs` does) and edits nothing. Two further visitors present a garbage invitation and an invitation a friend already used (the start page must say so and offer no start button; it did, both runs).

**The drills** (`scripts/playtest/drills.mjs`), on a schedule after the crowd starts, the same list at both clocks (r1x minutes / r10x minutes): `kill -9` of keeper A (25 / 40), keeper B (40 / 70), herald (55 / 100), relay (70 / 130), localnet (85 / 160), bots (100 / 190), drand-replay (112 / 220); a **30-minute pause** (125 / 250): the tunnel stand-in answers 530 (Cloudflare's "tunnel not connected") and every process of the run, the stack supervisor and the babysitter get `SIGSTOP`, then `SIGCONT`; an **invalid-invite and junk burst** (165 / 330: `scripts/playtest/abuse-burst.mjs` plus PT-B's `abuse-check.mjs`, 94 checks) while the crowd plays. Restarts are done by the stack supervisor, never by hand. A sampler (`sample.mjs`) read `ps` every 30 s.

Runner: `scripts/playtest/rehearse.sh` (one command for a whole rehearsal); report: `scripts/playtest/run-summary.mjs`.

## 2. Results at the real clock (r1x, 3 hours, 20 friends)

Every figure is from the crowd's own events (`crowd-events.jsonl`), the monitor's history or `ps`. "Chain" times come from the crowd's poller of the herald (`/h/me`, `/h/clash`), so they do not depend on the friend looking at the screen.

| Measure | Result |
|---|---|
| Joined / never joined | 20 of 20 friends joined on the first press (Join answered 200 by the relay: 14 ms median, 20 ms max); the browser shows "Recorded on chain" after **1.8 s** (p50, p90 1.8, max 3.4) |
| Landing page | invitation card shown in < 0.2 s; page ready (bell chip drawn) **2.1 s** p50, 3.3 s max; 62 returning visits all got "Welcome back" |
| **Join to village** (chain) | **18.0 min p50** (min 11.4, p90 19.6, max 20.7); every one of the 20 villages appeared. Design number: 11-21 min (draw needs the next bell's seed) |
| First march | 9 of the 20 friends sent a march within the 3 hours (all 6 diehards and 3 of the 7 regulars; none of the 7 casual and bouncer friends, who play a few minutes); from the join to the first march **median 83 min, earliest 50 min** (a village needs 11-21 min, then a host needs bells to form and rest; the friends' sessions set the rest) |
| **Depart acceptance** | the relay answered 200 to **19 of 19** Depart presses, **no 409 NotResident and no other refusal**; the composer itself blocked a send 3 times ("No path there was found", a destination the script picked that has no road) |
| Seal and send (press to "Departed") | 1.7 s p50, 1.9 s max |
| **First clash report** (Depart accepted to the report on the herald) | **39 min p50 of all 15 marches that had one, range 33 to 42 min**, the wait of the arrival bell the friends took (the page's earliest: 2 bells). 8 marches that straddled the 30-minute pause took 65-72 min of wall time; with the frozen half hour taken out (`--drills`), the same range. Design number: 31-41 min |
| Relay answers (366 relayed transactions + 20 joins) | 201 x 200, 123 x 400 Insufficient, 40 x 400 QueueFull, 2 x 409 NotResident; **0 x 5xx, 0 x 429** (the refusals are the script pressing Train/Build/Muster without checking what it can afford, see section 7) |
| Latency of the relay (as the browser saw it) | relay: p50 6 ms, p99 19 ms (max 8.1 s = a catch-up that waited the full 8 s, section 6); nudge 2 ms |
| Page and tester errors | **0 tester errors, 0 action errors**; outside the drills no failed request apart from the herald's normal 404 for bell files that do not exist yet (827, "NotYet") |
| **Lag** (monitor, every 30 s) | resolved-through lag up to 16 bells (the run was 15 bells long: idle provinces are skipped in batches, so it grows by one a bell until a batch; PT-A's alarm is at 28/36); herald fold lag max 37 slots (15 s); keeper A pending max 4, keeper B 0; **no LAG-ALARM, no HEALTH-ALARM in 3 hours** |
| **CPU and memory** (`ps`, percent of one core) | whole stack: **2.0 % p50, 5.7 % p99, 12.5 % max**; resident **249 MB p50, 274 MB max**. Per process (p50 / max CPU, max RSS): relay 0 / 6.2 %, 116 MB; localnet 0.8 / 2.2 %, 51 MB; keeper A 0.5 / 3.4 %, 18 MB; keeper B 0.3 / 1.0 %, 21 MB; herald 0.1 / 10.6 %, 29 MB; bots 0.1 / 0.3 %, 6 MB; drand-replay 0 / 0.3 %, 26 MB. The 20 browsers (which on the day are the friends' phones, not this Mac) took 4 % p50, 303 % at a burst, 612 MB p50 and 3.8 GB at a burst |
| Disk | 181 GB free before and after; the whole data directory (run, backups, logs) is 149 MB after the 3 hours |
| Machine load | load1 p50 2.1, but it peaked at 51: other sessions on this shared Mac (builds), not the stack |

## 3. Results at 10x (r10x, 3 game days in 7.2 hours, 20 friends)

A bell is 1 minute, so one rehearsal hour is 10 game hours. Times below are wall time unless marked "game".

| Measure | Result |
|---|---|
| Joined | 20 of 20 on the first press; "Recorded on chain" after 1.8 s |
| Join to village | **106 s p50 (= 17.7 game min), range 73-133 s (12-22 game min)**; 20 of 20 |
| Marches | **114 accepted Departs by 13 of the 20 friends** (all 5 diehards and all 8 regulars; none of the 7 casual and bouncer friends); first clash report of a march **230 s p50, 191 to 405 s (32-68 game min)**, the report existed on the herald for 111 of the 114 (the rest had not arrived by the end) |
| **Depart acceptance** | of **141 presses** that produced an answer: **114 accepted (81 %)**, 27 refused: 17 "arrival bell does not fit the path" (the bell turned between composing and sending: a bell is 1 minute here, 10 at the real clock, where it did not happen once), 10 "province has not resolved the previous bells yet" (the page's own check or the relay's NotResident; the relay answered NotResident 3 times in the whole run, see below). The composer blocked 118 further sends before any press ("No path there was found", "arrival bell does not fit"). Every friend who tried got a march away in the end; **10 of 13 first attempts** were accepted at once |
| Relay catch-up (PT-B's fix) | the relay logged 44 NotResident catch-ups that **succeeded** (it nudged the keeper and simulated again; the longest relay answer was 4.9 s); 3 NotResident answers came back in 4-5 ms, so with no catch-up attempted (probably the 1.5 s per-province gap after a catch-up); none waited out the 8 s |
| Relay answers (1,508) | 1,263 x 2xx; 4xx all rule answers: 127 Insufficient, 95 ProvinceFull, 12 QueueFull, 7 ArrivalBell, 3 NotResident, 1 SimulationFailed; **0 x 5xx outside the drills, 0 x 429**; relay p50 6 ms, p99 0.8 s (catch-up waits); join p50 13 ms |
| Page errors | one: `Cannot read properties of null (reading 'q')` in `people/crowds.mjs` (`hexCentre`, called from `paintPeople`): **74 times on 13 of the 20 friends' pages** (15 times on 9 pages in r1x): section 7, request C1 |
| **Lag** | resolved-through lag **p50 24, max 26 bells** over 403 bells (this is the idle-province batching of PT-A: no alarm at 28/36); herald fold lag max 123 slots (49 s, during the localnet kill), p99 3 slots; keeper A pending max 29, B max 1; **no alarm file at any time**; keeper writes: 0 dead, 0 missed reveals (reveals 83 landed of 86 sent by A, 52 of 55 by B: the other keeper landed first) |
| **CPU and memory** | whole stack **2.4 % p50, 21.6 % p99, 45 % max** of one core (60 bots, 3 game days of chain work in 7 h); resident **364 MB p50, 462 MB max**. Biggest: relay 111 MB, localnet 101 MB p50 / 171 MB max, herald 39 / 59 MB, keepers 35 / 33 MB |
| Disk | run directory **507 MB** after 3 game days (herald files 394 MB, chain ledger and snapshots 101 MB, keepers 8 MB); 181 GB free to 180 GB; the nine hourly backups are APFS clones (`du` counts them at 2.3 GB, they take far less); PT-A's budget of 5 GB for the run holds |

## 4. Drills

Restart times are from `kill -9` to: a new pid in `state.json` (**pid**), its port accepting (**port**), herald `/h/status` and relay `/f/season` both answering with the chain's slot advancing (**healthy**). "Crowd saw" is what the browsers logged in the 45 s around it. All restarts were by the stack supervisor. **No drill raised LAG-ALARM or HEALTH-ALARM** (the monitor debounces a restart on two ticks, as PT-A designed), and the chain kept its rate (2.5 slots/s: 51 to 59 slots in the ~22 s of each kill drill; while the chain itself is down, 3-4 s, the game clock, which is the slot count, simply waits, with no burst afterwards).

| Drill | r1x: pid / port / healthy (s) | r1x crowd saw | r10x: pid / port / healthy (s) | r10x crowd saw |
|---|---|---|---|---|
| kill keeper A | 2.6 / 2.6 / 2.6 | nothing | 2.3 / 2.3 / 2.3 | nothing |
| kill keeper B | 2.3 / 2.3 / 2.3 | nothing | 2.3 / 2.3 / 2.3 | nothing |
| kill herald | 2.3 / 2.3 / 2.3 | 5 requests failed (502 from the tunnel) | 2.3 / 2.3 / 2.3 | 5 requests failed (502) |
| kill relay | 2.3 / 2.5 / 2.6 | nothing | 2.3 / 2.6 / 2.6 | nothing |
| kill localnet (the chain) | 3.0 / 3.0 / 3.0 | nothing | 3.8 / 3.8 / 3.8 | 5 requests failed (500 from the relay: "chain unreachable") |
| kill bots | 2.5 / 2.5 / 2.5 | nothing | 2.3 / 2.3 / 2.3 | nothing |
| kill drand-replay | 2.6 / 2.6 / 2.6 | nothing | 2.3 / 2.3 / 2.3 | nothing |
| **pause 30 min** (tunnel 530, everything `SIGSTOP`ped) | healthy 0.5 s after `SIGCONT` | 19 visits that began during the half hour got Cloudflare's error (the page does not load; no tester error, the crowd counts them as "unreachable"); pages already open resumed by themselves | healthy 0.04 s | 15 unreachable visits, the same |

**The pause.** The monitor wrote one gap line (`wall_secs 1804, slots 10, game_secs 4` at 1x; `1806, 16, 64` at 10x): in a half hour the chain made 10 (16) slots, **the game clock lost nothing and gained nothing**; after `SIGCONT` the slot count advanced 151 to 152 slots in the next minute (the normal 150): **no catch-up burst, no alarm, no stalled keeper, no duplicate or lost bell**. The marches that were in the air continued: clash reports arrived at the same game-time distance (section 2). What this stand-in does not do is sleep the Mac for real (`pmset sleepnow` was not used: it would sleep this whole session): `SIGSTOP` freezes the process but the wall and monotonic clocks go on, whereas a real sleep may stop the monotonic clock of the Rust and Node processes; PT-A's analysis (the game clock is the chain's slot count) says the same outcome, this rehearsal confirms the freeze half of it.

**The abuse burst** (r1x and r10x, identical): 300 invite-check requests with invalid codes from one address in 5 s: 12 x 200, 288 x 429; 200 junk `/gw/f/join` from one address: 10 x 400, 190 x 429; 200 junk `/gw/f/relay`: 40 x 400, 160 x 429; the same invite-check from **100 different addresses (3 each)**: all 300 answered 200 ("invalid"): the limits are per address, as designed, and what answers a distributed flood is the invite check itself; an honest control address asking during the flood: **12 of 12 x 200, p50 5 ms**. The crowd saw nothing during it (no failed request, no tester error). Before the herald fix of section 6 the same burst turned 17 of 1,000 requests into a 502; after it, 0 of 1,000, in both rehearsals. `abuse-check.mjs`: **94 of 94 pass** each time.

## 5. The metrics script (`scripts/playtest-metrics.mjs`) and its validation

```sh
node scripts/playtest-metrics.mjs                         # the real run: .claude/data/playtest/runs/playtest-1/relay/relay-events.jsonl
node scripts/playtest-metrics.mjs RELAY-EVENTS.jsonl [--exclude-labels bots] [--tz-offset-hours 9] [--session-gap-min 30]
        [--since ISO] [--until ISO] [--herald http://127.0.0.1:41117] [--gaps status/gaps.jsonl] [--json out.json] [--people]
```

It reads **one file**, the relay's event log (`invites_issued`, `join`, `action`, `seen`; no name, e-mail or address in it) and prints the figures below; the definitions are the header of the script and are literal:

| Figure | Definition |
|---|---|
| `N_invited` | sum of `count` of `invites_issued` lines whose label is not excluded (default: `bots`): invitation **codes issued**. It is the number of people invited only if each code went to one person: who got a code is the operator's to remember |
| `N_joined` | distinct invite **nonces** in `join` lines whose nonce belongs to a non-excluded batch = codes that completed a join. A join naming an invite of no batch in the log is not counted and is reported (`joins_unknown_batch`) |
| `D` | number of distinct calendar days (JST by default, `--tz-offset-hours`) on which any person has a `join` or `action` line |
| per-day active citizens | distinct persons with a `join` or `action` line that day (a join is activity on its day) |
| `N_returned` | persons with an `action` line on a day **later** than the day of their join (the join does not count as the return) |
| median session count | per joined person, sessions = runs of that person's `join` + `action` lines with no gap above 30 minutes; the lower median over all joined persons |

`action` is every transaction the relay sponsored for a Citizen, including the ones the page sends by itself when it is open (the site ticket after a join, settlements): "active" means "the client was open and acting", not "clicked". `seen` lines (a page asked for its quota; anyone can ask for anyone's) are **never** used in the headline; the "incl. visits" variants are in `secondary`. `--herald` additionally checks every joined wallet on the chain (`/h/me`: **20 of 20 found** in both rehearsals). People who opened the link and never joined are not in the log; do not claim them.

**Validated** (`scripts/playtest/metrics-validate.mjs`, `scripts/playtest/metrics.test.mjs`, 8 tests): the same figures were recomputed **from a second source**, the crowd's own record of what its browsers saw (the relay's answers to each friend's join and relayed transactions, with the browser's clock), and compared person by person (the code of friend *i* is row *i* of the invitations CSV; its nonce is the first 12 bytes of the code):

| rehearsal | N_invited | N_joined | D (JST) | N_returned (JST) | median sessions | agreement |
|---|---|---|---|---|---|---|
| r1x | 26 | 20 | 1 | 0 | 2 | all agree |
| r10x | 26 | 20 | 1 | 0 | 2 | all agree |

Both rehearsals fell inside one JST calendar day (00:08-03:20 and 00:08-07:24), so `D = 1` and `N_returned = 0` there is the **correct** answer to the literal definition and exercises nothing. To exercise the day boundary on real logs, the validation was repeated with the day boundary moved into the middle of each run (`--tz-offset-hours 7.5` for r1x, local midnight at 01:30 JST; `3.5` for r10x, 03:30 JST): r1x **D = 2, N_returned = 16, per-day active 20 and 16, median sessions 2**; r10x **D = 2, N_returned = 13, per-day active 20 and 13**; per person, join day, active days, returned and sessions agreed in all 40 comparisons, and the crowd's own count (16 and 13) matched. The unit tests cover the JST midnight itself (a session that straddles 23:59 / 00:01, a join on the last minute of a day), a repeated invite, a nonce from no batch, bots, windows and an empty log.

`median sessions` is 2 in both because friends with gaps under 30 minutes are one session by this rule (the crowd's own sessions, which are browser sessions, have a median of 4 at 1x and 7 at 10x). Say "median 2 sessions" only with its definition.

## 6. Problems found and fixed

1. **Herald `/gw` turned an early relay answer into a 502.** The herald wrote the head and the body of a proxied request in two writes; when the relay answered early (a rate limit) and closed before the body arrived, macOS answered the second segment with a reset, which discards the answer already received: the friend got `502 RelayUnavailable` instead of `429`. Seen as 17 of 1,000 requests in a burst (1 of the 300 invite-checks, 12 of the 200 junk joins, 4 of the 200 junk relays) and once as a single 502 in the dev rehearsal; honest traffic was not hit. Fix (`frontier-node/crates/herald/src/server.rs`): one write, and a reset after an answer has arrived keeps the answer. After it: **0 of 1,000** in three bursts. `cargo test -p herald --test playtest --test server` green.
2. **Relay catch-up waited the full 8 s and gave up in both of its 2 catch-ups at 1x** (PT-B's `catchup.mjs`, `waitMs = 8000`; two friends' provinces at the same second, 12 s after a bell boundary, when the keeper is busiest: the friend saw "province has not resolved the previous bells yet" and pressed again; the other 3 NotResident refusals of the rehearsals, at 10x, came back at once). At 10x all 44 catch-ups succeeded, the longest taking 4.9 s. So the evidence for a longer wait is two events at 1x, thin but one-sided. The wait is now **20 s** (the browser's POST timeout is 45 s) and the relay log says how long it took (`caught up by the keeper in N ms`, or `no catch-up (gave up or none possible after N ms)`), so the first hours of the real playtest give the real distribution. `frontier-playtest-b.test.mjs` and `frontier-relay.test.mjs` green (30 tests). **The running r10x relay had the old value; the fix is not rehearsed.**
3. `fake-tunnel.mjs` gained `--asleep-file` (530 and dropped WebSockets while the file exists) and the crowd uses `--client-ip-from-header`: test tooling only.

## 7. Problems found and not fixed here (requests)

**Design session** (files this unit must not touch):

- **C1 `permutation-server/web/frontier/people/crowds.mjs`, `hexCentre(p, q, idx)` line 45 called from `paintPeople` line 336 (the loop "the viewer's own marches on their road"): `tileHex(...)` returns null for some marches (`m.from.tile` or `m.to.tile` not a valid tile index) and `h.q` throws.** 74 page errors on 13 of 20 pages at 10x, 15 on 9 pages at 1x: it happens for friends who have a march in the air, and an uncaught error in a paint function may stop the painting of the people layer for that frame. Guard a null `tileHex` (skip that march). Stack as the browser reports it: `hexCentre (people/crowds.mjs:45:83) < paintPeople (people/crowds.mjs:336:67)`.
- **C2 Train/Muster/Build can be pressed when they cannot be afforded, and the refusal does not say what is missing.** The Train form is enabled whenever the holding has no block, with no cost shown; the relay then answers `Insufficient` and the page says "Not enough resources or balance." At 1x the relay refused the script's random Train **84 of 112 times** (83 `Insufficient`) and its Build 52 of 84 (12 `Insufficient`, 40 `QueueFull`); at 10x Train 67 of 255, Build 43 of 179 (31 `Insufficient`, 12 `QueueFull`). The picks are random, so the share is the script's, but a friend has no cost to look at either. Showing the cost beside each unit (as Build already does) and disabling what is not affordable would remove most of them. A friend's first ten minutes will contain several of these.
- **C3 "This province is full" on Muster** (`ProvinceFull`): **95 refusals at 10x** (84 + 11 in the two languages), none at 1x. A province holds a limited number of hosts for everyone; the script kept mustering and never dissolved. A friend who plays for days will meet it. The page should show the province's free slots in the Muster panel and point to Dissolve/Garrison.
- **C4 Arrival bell goes stale in the composer**: 17 of 141 Depart presses at 10x were "arrival bell does not fit the path" (the bell turned between composing and pressing; a bell is 1 minute there); at 1x none in 22. Low risk at the real clock; a friend who composes for more than 10 minutes will meet it. The composer could re-pick the earliest valid bell when the selected one is past.
- C5 (earlier, still true) PT-B's R1-R3: `join.mjs` wording for the guest key, `CATCH_UP_RETRY` with `'Depart'`, and the recorder's stale-notice read (`record-playflow.mjs`).

**Pitch and operation** (information for the owner):

- **A friend's first march is late.** Joining takes 18 min p50 to a village at the real clock (11-21), then a host and its rest: in r1x the earliest first march was **50 min after joining, the median 83 min**, and its clash report came 33-42 min after that. Tell friends that the first hour is waiting, and plan the first day's count of "marches" accordingly.
- **Invite no one in the first bell.** The world reports "open" (the start page says "Start") at genesis, and the first Join of the first minutes at 20x answered `WrongStatus` in PT-A's e2e; at 1x and 10x here it landed on the first press 40 of 40 times, but only because the crowd started a few seconds into bell 0; send the first links about **10 minutes after genesis** to be safe.
- **No `LAG-ALARM` or `HEALTH-ALARM` file appeared in the 10 hours of rehearsal** (two stacks, 6 hours at the same time), including the half-hour pauses and the seven kills each: absence of alarms there is a result, not a missing feature (the monitor's gap line did record both pauses).
- The keepers' status "alerts 5 / 3" and "attempts not landed {failed: 5}" at the end of r10x are the second keeper's reveal and the archive write that lost the race to the first (reveals: 0 dead, 0 missed); `playtest-status.sh` prints them as a number, not as a warning.

## 8. What this does not show

- **No real tunnel and no real sleep.** The https stand-in sets `CF-Connecting-IP` as the herald expects; whether Cloudflare does is PT-B's open question M6 (open the link from a phone on mobile data and look at the relay log). The pause is `SIGSTOP` plus a 530 stand-in, not a sleeping Mac.
- **Desktop Chromium driven by DOM clicks**, widths 390-1440 px, no touch, no Safari, no Firefox, no in-app browser; presses are `element.click()` (no actionability check), so a button hidden under the narrow layout's sheet would not have been noticed. The crowd measures the servers, not the usability on a phone.
- **The friends are scripted**: the refusal shares (Insufficient, ProvinceFull, no path) depend on the script's random picks and its pace (a press every 4 s median); real people will press less and read more. The share of friends who came back, the sessions per person and the first-march time are the script's behaviour, not a forecast of people's: only the **method** (and the script that computes it) is validated, not the numbers.
- **3 hours at the real clock is 15 bells.** The multi-day dynamics at 1x (lag growing to 26 bells and being skipped, the ledger growing, the keepers' payers being spent) were seen only in the 10x rehearsal (3 game days in 7 h). The relay's keeper-payer pool and the herald's per-address buckets were far from their limits at 20 friends.
- **Both rehearsals ran inside one JST day**, so the real-log numbers for `D` and `N_returned` are 1 and 0 (correct, and uninformative); the day boundary was exercised by moving it, on the same logs, and by unit tests.
- **The crowd shared the Mac with other work** (load1 peaked at 51 from other sessions' builds) and the 1x and 10x stacks ran side by side; CPU and latency numbers are therefore upper bounds for a quiet Mac.

## 9. Rerun

```sh
cd <worktree>      # .claude/worktrees/playtest; binaries current: (cd frontier-node && nice cargo build --offline --locked --release --workspace)
# one whole rehearsal in the background; log and exit code in OUT/logs/{rehearse.log,rc}; results in OUT/results/
scripts/playtest/rehearse.sh --detach --out /some/dir/r1x  --scale 1  --minutes 180 --plan "kill:keeper-a@25,kill:keeper-b@40,kill:herald@55,kill:relay@70,kill:localnet@85,kill:bots@100,kill:drand-replay@112,pause:30@125,abuse@165"
scripts/playtest/rehearse.sh --detach --out /some/dir/r10x --scale 10 --minutes 432 --arrive-min 60 --port-shift 12 --tunnel-port 41103 --plan "kill:keeper-a@40,...,pause:30@250,abuse@330"
# afterwards (rehearse.sh does these itself): the numbers of a run, the metrics, the check of the metrics
node scripts/playtest/run-summary.mjs --run /some/dir/r1x
node scripts/playtest-metrics.mjs /some/dir/r1x/data/runs/ptc-r1x/relay/relay-events.jsonl --herald http://127.0.0.1:41117
node scripts/playtest/metrics-validate.mjs --crowd .../crowd/crowd-events.jsonl --relay-log .../relay-events.jsonl --invites .../invites.csv
node --test scripts/playtest/metrics.test.mjs
```

Ports used: 41112-41123 (r1x), 41124-41135 (r10x), the https stand-ins 41102 and 41103 (the dev rehearsal used 41101 and the 41112-41123 range before r1x). The tooling refuses any port outside 41100-41139.

Results of the two rehearsals (no names, no addresses, no keys; invites and citizens as numbers): `docs/frontier/playtest/pt-c-results/{r1x,r10x}-{run-summary,metrics}.json`, `-metrics-validation.txt`, `-drills.jsonl`.

Files of this unit: `scripts/playtest/{crowd,crowd-report,run-summary,drills,abuse-burst,sample,rehearse,mkconfig,metrics-validate}.mjs/.sh`, `scripts/playtest/metrics.test.mjs`, `scripts/playtest-metrics.mjs`; changed: `fake-tunnel.mjs`, `frontier-node/crates/herald/src/server.rs`, `permutation-gateway/src/frontier/{catchup,routes/relay}.mjs`.
