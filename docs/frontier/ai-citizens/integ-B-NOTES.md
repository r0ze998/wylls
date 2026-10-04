# integ-B notes: the AI line after the review fixes (smoke-b4 and smoke-b5)

Branch `frontier/ai-integ`, local commits only, never pushed. Local test chain only: no devnet, no mainnet, no paid API, no download, no install.
Times are JST, 2026-10-04 evening to 2026-10-05 00:35. The submission is pitch + demo + README; this wave's goal was a correct, honestly documented
AI line and real footage. Nothing here claims human playtest results (none exist), traction, money, an AI that is indistinguishable from or stronger
than rule bots, exact replay of model output, or that the model wants or intends anything. A "cited" memory line shows the line was shown to the model
and named by it, not that the choice rested on it.

## 1. What was merged

`--no-ff` merges of `frontier/ai-fb1` .. `frontier/ai-fb5` (subject `Wylls AI integ-B: merge FBn`). One textual conflict set, resolved by ownership
(nothing dropped):

| file | conflict | resolution |
| --- | --- | --- |
| `citizens/report.mjs` (FB1 + FB2) | the `checks` block: FB1's `every_closed_bell_has_an_anchor_or_gap`, FB2's renamed checks | both kept (FB2's three renamed checks, FB2's two added, FB1's anchor check) |
| `citizens/report.mjs` (FB2 + FB5) | the clash-kind filter, the `y_*` keys and `clash_results`, the Markdown line | FB5's `CLASH_KINDS` plus FB2's `episode.bell >= march bell`; FB2's key names (`y_proxy_clash_any_opening`, `y_proxy_clash_unopened_only`); FB5's `clash_results` (win, win_cleared, win_pre_r12_unverified, fought, loss, camps_cleared); the Markdown line merges both |
| `citizens/verify-minds.mjs` (FB3 + FB5) | the M1 model hash (FB3: unverified without `--model`; FB5: fresh hash, `--model-cache`), FB3's `skippedNote`/`ALL_CHECKS` next to FB5's `episodeRuleOf`, the M9/M11 call lines | FB5's fresh hash with FB3's `unverified` branch; both helper blocks; FB3's M9 arguments plus FB5's `episodeRule` on M11 |
| `test/citizens-report.test.mjs` | pinned `y_*` key and `clash_results` | FB2's key, FB5's `clash_results` |

Two semantic seams that the merge did not flag (the full suite did, 2 failures on the merged head, before any fix):
1. `citizens-report.test.mjs` (FB5's R12 test) still read the key FB2 had renamed (`y_clash_without_opening`): changed to `y_proxy_clash_any_opening`.
2. `citizens-audit-fb3.test.mjs` D1 (a full CLI run, PASS expected) failed in M11 because the mini run publishes the real slice-4 episodes, written under the
   pre-R12 rule, and FB5 chooses the rule from the committed `episode_kinds_sha256` (the mini run's commitments are from the current tree): the test now passes
   `--episode-rule legacy_v1`, the same thing the fixture's `verifyOpts` already did for the other audit tests.

Then, after smoke-b4 (section 4): the closer-clock fix, and `citizens/stack/ai-smoke-14h.toml` (the smoke stack at 14 game hours; everything else equal to
`ai-smoke.toml`; the run script derives the deck from the file name, so `--deck deck-1` is passed).

## 2. The gate (every command, real result)

| command | result |
| --- | --- |
| `cd permutation-gateway && npm test` on the merged head (before the two seam fixes) | 1548 tests, 1546 pass, **2 fail** (the two seams above) |
| `npm test` after the seam fixes | 1548 tests, 1548 pass, 0 fail (48 s) |
| `npm test` on the final code head `00564cd` (with the clock fix and its 7 tests) | **1555 tests, 1555 pass, 0 fail, 0 skipped** |
| `cargo test -p bots -p agents -p herald -p stack --locked` | **not run**: no Rust file changed between `0cc0973` and this head (`git diff --name-only 0cc0973 HEAD` lists none; the release binaries used by the live runs are newer than the last Rust commit `ce11531`) |
| `cargo +1.95.0 fmt --check` (frontier-node, target-integ) | clean (exit 0) |
| `cargo +1.95.0 clippy -j 6 -p bots -p agents -p herald -- -D warnings` | finished, no warnings (cached build: 0.7 s, so this is the result for unchanged Rust, not a fresh compile) |
| `citizens/bin/ai-hook-check.sh --blank-ok` | PASS (102 commits since `30ba411`, 282 MC files from 2 lists) |
| `citizens/bin/mc-files.sh` | 282 files; intersection with `git diff --name-only 30ba411 HEAD` is the AI's own hook files in `crates/bots` and `Cargo.lock` (the allowed hook, unchanged by this wave: none of them is in `0cc0973..HEAD`) |
| G10 grep (`anthropic|openai|devnet|non-loopback URL` over `citizens/**`, bin and guards excluded) | empty |
| `git merge-tree --write-tree HEAD frontier/unify` (read-only rehearsal, unify at `19fe89c`, merge base `73408a5`) | exit 1, **one** conflicted file: `docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md` (3 hunks: both branches edit the contract). Nothing else conflicts. Nothing was merged. |
| `git merge-tree --write-tree --name-only HEAD frontier/cq-integ` (contract 0.2 asks for this rehearsal too; **added after the review**, cq-integ at `6ec65e4`) | exit 1, **three conflicted files, all hook files**: `frontier-node/crates/bots/src/bot.rs`, `fleet.rs`, `main.rs`. Both sides add at the same place (the `Bot` struct field and its `Default`: `ai: BotAi` against `cq: CqMem`; `pace.plan/after` in `fleet.rs`: the AI hook against cq's new argument and the `busy` expression; the `Args` fields and CLI arms in `main.rs`). `Cargo.lock`, `bots/Cargo.toml` and `DECISIONS.md` auto-merge. **So the hook design is not mechanical against cq-integ: the I-C merge needs a hand resolution of three hook blocks** (the hook-check script and the contract's premise say otherwise). Nothing was merged. |
| `git merge-tree --write-tree HEAD frontier/playtest` (playtest at `0058f78`) | exit 0, clean. |

### 2.1 After the three review rounds (integ-B fixes, commits `dae5ee7`, `1b8bcca` and this notes commit)

| command | result |
| --- | --- |
| `cd permutation-gateway && npm test` on `1b8bcca` (plus the contract header line and these notes, no code) | **1557 tests, 1557 pass, 0 fail, 0 skipped** (45 s). Another session's llama-server (pid 82587, 41901) and a stack (run `smoke-r1`, lock file present) were up during this run; the suite binds 127.0.0.1:0 and was not affected. I did not touch them. |
| `citizens/bin/ai-hook-check.sh --blank-ok -q` | PASS |
| Rust | **not run** again: `git diff --name-only 0cc0973 HEAD` lists no `.rs` or `Cargo*` file. |
| live smoke | **not run** after the fixes. The metrics change touches only the counter map that `/h/ai/metrics/latest.json` carries; the M3 change touches the not_sent branch only, and b5 had `0 not_sent`, so no pass condition of b4 or b5 depended on either. A live smoke could not be started anyway: another session's llama-server and stack hold 41901 and the stack lock, and the rules allow one llama-server at a time. b3, b4 and b5 `metrics/latest.json` files are **unchanged and still carry the sealed coordinates** (section 5.1). |

## 3. Runs: what happened, with numbers

Persona: all six AI citizens are conquerors in every run (deck-1, one persona).

Machine: one Mac, Gemma 4 26B A4B Q4_0 through `llama-server` (build b11146, started once by `citizens/llama/start-pinned.sh` at 21:05:19, pid 76128, stopped at
00:32 after the last run; never two at once). Latencies below are the llama call time as the report prints it. "Uptime" is the mind service's uptime at the metrics
snapshot; the llama server's own uptime is longer (it was started before the runs: about 6,100 s at the b4 snapshot 22:47, about 12,300 s at the b5 snapshot 00:30).
Load average (Mac, sampled by `uptime` at the times shown): b4 4.8 at start 21:07, 2.8 to 4.5 during; b5 4.2 at start 22:51, 2.3 to 3.0 at 00:12. For b2 and b3 I did
not record load; the files I read do not carry it.

| | smoke-b2 | smoke-b3 | smoke-b4 | smoke-b5 |
| --- | --- | --- | --- | --- |
| code | `5cbe7b9` | `1636a83` | `54822cd` (merged FB1 to FB5) | `00564cd` (+ clock fix) |
| game hours / closed bells | 12 / 86 (0 to 85) | 12 / 86 | 14 / 98 (0 to 97) | 14 / 109 (0 to 108) |
| mind uptime at snapshot | 5226 s | 5227 s | 5944 s | 5873 s |
| decision records | 419 | 417 | 502 | 495 |
| model decisions, gate open (n) | 49 | 52 | 61 | 59 |
| valid / fallback | 44 / 0 (5 feed_lag, counted as neither by the old report) | 52 / 0 | 61 / 0 | 58 / 1 (`v6_all_refused`) |
| session latency ms (n, p50 / p90 / p99) | 31, 3132 / 4054 / 4575 | 34, 3193 / 4052 / 4696 | 36, 3213 / 4037 / 4694 | 41, 3276 / 4053 / 4673 |
| negative slack | 0 | 0 | 0 | 0 |
| by:model share (upper bound) | 27.9 % (46 of 165) | 29.8 % (51 of 171) | 30.5 % (53 of 174) | 33.3 % (62 of 186) |
| model marches (all records opened) | 9 | 10 | 11 | 14 |
| Y, episode proxy (not the herald rows) | 8 | 9 | 10 | 13 |
| memory citations (records) / mind counter | 22 of 44 / 14 | 26 of 52 / 16 | 35 of 61 / 18 | 36 of 59 / 25 |
| reflections: records / ok / refused (due = ran in b3 to b5) | 13 / 9 / 4 | 12 / 8 / 4 | 18 / 18 / 12 / 6 | 18 / 18 / 11 / 7 |
| anchors | 86 closed, 85 anchored, no gap | 86 closed, 85 anchored, no gap | **Corrected:** 97 anchored (bells 0 to 96), bell 97 an explicit `anchor_gap` (`pub/anchors/97.json`: the chain was paused), bells 98 to 108 closed by the herald but never by the closer | **109 closed, 109 anchored, 0 gaps** |
| verify-minds | FAIL (M8, M11) | PASS (with the old, weaker verifier) | **FAIL (M3 tail_truncated)**, M1 M2 M7 M8 M9 M11 PASS | **PASS** (M1 M2 M3 M7 M8 M9 M11) |
| Strike Order adopted | no | no | no | no |

Every number is from `report.md` / `pub/metrics/latest.json` / `pub/verify-minds.json` of the run (b4 and b5 reports are copied next to this file:
`integ-B-smoke-b4-report.md`, `integ-B-smoke-b5-report.md`, regenerated after the END line so their run table is complete). n is small everywhere (G1 asks for
n >= 300; every run is "underpowered"). b2 and b3 reports were written by the code before the FB fixes; the b2 and b3 columns are the numbers of those reports, not
regenerated with the new report code.

### 3.1 smoke-b4 (first iteration)

Started 21:07, ended 22:48. PASS conditions against the artifacts:

* one record per step with the no_session caveat: 495 brain steps = 459 step records + 31 no_session + 5 same-bell repeats (+ 43 mind-job records); met.
* >= 10 model decisions: 61 (gate open); met. A model march released with Remembered lines: 11 opened, 10 of the 11 opened records cite memory; met.
* AI message accepted: yes. **Corrected after review:** the public talk files hold 39 entries, of which 29 are messages (21 say, 8 motion; brain counter `social_posted:talk` 29) and 10 are ballot leaves (`social_posted:ballot` 10). The mind's per-AI `messages` counters sum to 33; the gap to 29 posted messages is **not explained**. (The first version of these notes called all 39 entries messages.)
* **Memory citations, split (added after review; I re-derived the split from `pub/minds` + `pub/open`):** of the 61 model decisions (36 session, 10 ballot, 15 motion) 35 cite memory: **18 of 36 sessions, 10 of 10 ballots, 7 of 15 motions**; the ballots and motions cite council `motion` episodes. Of the 10 opened march records that cite memory, 7 cite only `build_done` lines (a finished farm, sawmill or library); **only 3 cite a combat line** (a `clash_own_win` or `camp_cleared_own`: AI 1000 at bells 59 and 61, AI 1001 at bell 60; by the review's reading). Kinds over the run: motion 19, build_done 19, clash_own_win 5, council_result 5, camp_cleared_own 3, threat 3. Y = 10 also counts 5 `clash_own_loss` and 1 `clash_own_fought`. For b5 the same split is 36 of 59 = **25 of 41 sessions, 8 of 9 ballots, 3 of 9 motions**; 13 of its 14 opened marches cite memory (the kinds are in 3.2). Keep any demo claim to what the few combat-citing marches show, and note that a citation is not the reason for the choice.
* reflections counted: 18 due, 18 ran, 12 ok, 6 refused (5 `number_not_in_window`, 1 `handle_imitation`).
* anchors: **not met.** The report line `97 anchored, 0 gap(s) of 97 closed bells` (and the `RUNS.md` END line) is what the report saw: it counts only bells the closer closed (98, bells 0 to 97 with files; its own text says `98 closed bells; 97 anchored, 1 anchor_gap`), so `every_closed_bell_has_an_anchor_or_gap = true` is **vacuous at the tail**: the report cannot see bells the closer never closed. Real state: bells 0 to 96 anchored, bell 97 an explicit `anchor_gap`, **bells 98 to 108 (11 bells) closed by the herald and never by the closer** (the first version of these notes said "97 to 108" and "12 bells"; the closer did close 97: `minds/97.json`, `talk/97.json`, `anchors/97.json` exist). The signed index says `last_bell 96`.
* **All six AI citizens in every run are the same persona: the smoke deck `deck-1` is `["conqueror"]`.** The march, camp and clash figures of b2 to b5 therefore come from a camp-hunting persona only and cannot be generalised to other personas (added after review).
* verify-minds: **FAIL, M3 `tail_truncated`**: the last published bell file is 96, the herald logged bell 108 closed. This is FB3's new tail check doing its job.

**The seam it exposed.** The citizens service's bell clock is anchored by the brain's `now_game` and `scale` (10x). When the fleet exits (bell about 84) the brain says
nothing more, and the stack's drain runs the chain at 20x: the closer kept closing bells at 10x, so when the registrar published, the herald had closed bells 97 to 108 that
the closer had not. FB1 had listed this as "pending" (the closer's clock falls behind the drain) and left the choice to the integrator. In b2 and b3 it hid as "bell 85 has no
anchor"; FB1's gap code could not see it, because a bell nobody closed is not a "closed bell" to the registrar. Fix (mine, in `citizens/server.mjs` and
`citizens/mind/closer.mjs`, test `citizens-integ-b-clock.test.mjs`, 7 tests, fail on the old code: the exports did not exist and the service never read `/h/season`):
`catchUpClockFromHerald` reads the herald's `latestUnix` every 2 s; while the brain is active it only moves the clock forward (the herald lags the brain by a little, so
it never pulls the clock back during play); once the brain has been silent 30 s it follows the chain both ways, so it also stops where a paused chain stops (no bell the chain
never reached is closed). The contract's closer rule (section 6.3: close at bell_start(b+1) + 20 game seconds) is unchanged; only the clock source is.

**The scripted seat ballot was not cast in b4, and that was my error plus a limit of the script.** I started `citizens/ab/seat.mjs` by hand at run start (bell 0,
preseason). It gives up after 400 polls (about 20 to 25 minutes; the CLI has no flag for that) and had exited before period 2 (bell 48). I restarted it at bell 73 in period
3, where nation 0 had three candidates but no AI had moved an option, so the stock rule (ballot only after an AI of nation 0 moved an option X) skipped the period.
Result file: `ab/seat-A-1.json` (the first attempt is kept beside it as `seat-A-1.first-attempt-gave-up.json`).

### 3.2 smoke-b5 (second iteration, after the closer fix)

Started 22:52, ended 00:33. Same commands as b4 with run id `smoke-b5`.

* decision records and steps: 495 steps = 459 + 31 no_session + 5 same-bell repeats (+ 36 mind-job records); met.
* >= 10 model decisions: 59 gate open (70 records with mode model: sessions plus reflections, motions, ballots); met.
* model march with Remembered lines: 14 marches, 14 records opened, 13 of the 14 opened records cite memory; met. Cited episode kinds over the run:
  build_done 21, motion 13, threat 9, camp_cleared_own 6, council_result 5, clash_own_win 3, clash_own_loss 2, clash_own_fought 1. Of the 36 decisions that cite memory,
  most cite a build line or a council line; clash lines are a minority (6 of the 60 cited lines are clash_own_*, 6 more are camp_cleared_own), so "the AI remembers its fights" is true for some decisions, not most.
  Among decisions whose retrieved set held an attacked_own, camp_taken_by or threat episode, 30 of 35 cited at least one.
* AI message accepted: yes. **Corrected after review:** 33 entries in the public talk files = 25 messages (`social_posted:talk` 25; `messages_in_talk_files` 25 in the report) + 8 ballot leaves (`social_posted:ballot` 8). The per-AI `messages` counters sum to 26; the gap of 1 is **not explained**.
* reflections: 18 due, 18 ran, 11 ok, 7 refused (V5b), 6 summaries published.
* **anchors for every closed bell: met. 109 closed, 109 anchored, 0 gaps**; the signed index says `last_bell 108`; M3 read the chain: `chain_anchored_bells 109`, `herald_last_closed_bell 108`.
* council: 9 council files; some with three candidates (2-0 had 3, 4-1 had 3), some with one or two (the option count is what the code found at that bell; 2-1, 2-2, 2-4, 3-3, 3-4
  had one). Ballots counted: one AI ballot per nation in period 2 (5) and in period 3 (3 files, 1 ballot each); the page and the files say "ai 1, human 0, scripted 0".
  **No Strike Order was adopted**: every file is `adopted: false`, reason `quorum` (fewer than two ballots for the leading option), `strike_bell: null`.
  Nations 0 and 2 have no period-3 council file at all (no candidates at that bell); there is no council file for nation 5 in any run, although it has an AI citizen (not explained, section 8).
* **scripted seat ballot: not cast.** Period 2: the stock seat script found no AI motion of nation 0 (nation 0's file has 3 candidates and 0 motions), so it skipped the period
  (logged in `skipped_periods`). Its 400-poll budget then ran out at about bell 68, before period 3; I restarted it at bell 75, and by then nation 0 had no period-3 council.
  So in b5 the seat script could not have voted in either period. The commitments carry `seat_script_sha256` and the roster marks the seat `scripted: true`
  (the run script got `--seat-script citizens/ab/seat.mjs`), which the page shows as "Scripted for the A/B test: its ballots are written by the operator's script".
  **No scripted ballot exists in any run**; the page footage nonetheless shows "Ballots by who cast them: ... scripted seat 0" and the roster badge for a scripted seat, which reads as the A/B-test seat: that label comes from the run flags (`--seat-script`), this is **not an A/B run** (`arm` null) and no scripted ballot was cast. Any caption of the footage must say so (the page was not changed: the owner keeps the council page labels). The statement "the seat's ballot is scripted" would apply to a ballot that was never cast.
* verify-minds: **PASS**, all seven: M1 n=33; M2 n=12; **M3 n=248** (bells 0 to 108, the tail check read the herald's last closed bell 108 and 109 anchor memos on chain, 14 sealed
  records, 14 openings timing-checked, 14 destinations from the REVEAL, 0 unrevealed, 0 not_sent); M7 n=356 (172 listed signatures, 178 session-signed on chain, 6 onboarding exempt);
  **M8 n=33** (0 redacted skipped); **M9 n=20** (20 of 20 sampled model records equal on replay, threshold 18; llama /props n_ctx 16384, alias gemma-4-26b-a4b-it); **M11 n=518**
  (14 replay-code files same, `episode_rule: current (R12)`, 495 memory ids checked, 20 sampled decisions, `focus_stored 20, focus_rejected 0`, 0 with a budget cut).
  M8 and M11 failed on smoke-b2; they pass here with the stronger FB3 verifier.

Not claimed from M9: it samples 20 of 70 model records; "equal on replay" means the same request bytes to the same pinned server gave the same answer for those 20.

## 4. Council page, live (STEP 3)

Under the permission model (the citizens service on 41902, Node `--experimental-permission`), during smoke-b4 and again during smoke-b5 (bell 79, stack up):

* HTTP: `/council.html` 200; `council/council.css`, `council/main.mjs`, the 16 modules of its import graph, `council/lang.ja.json` all 200; `/h/ai/roster.json`, `/h/ai/open/index.json`,
  `/h/ai/open/57.json`, `/h/ai/commitments.json`, `/h/ai/council/current.json` all 200. (`/council/lang.en.json` is 404: I guessed that name; English strings live in `lang.mjs`; the page does not request it.)
* Rendered with the Playwright Chromium already in `~/Library/Caches/ms-playwright` (playwright 1.58.2 from the npx cache; no download). It renders: roster of 6 AI citizens, a Wyll card (goals,
  by-model share, stats), released march decisions with "Remembered (cited by the model)" lines, the nation council (options, motions, ballots, "No Strike Order adopted"), departures and clashes, messages.
* Screenshots (b5, 1280x800 and 390x844; copied to `docs/frontier/ai-citizens/integ-B-shots/`): `*-1-top-roster`, `*-2-wyll-card`, `*-3-released-decision`, `*-4-released-decision-remembered`,
  `*-5-council`, `*-6-council-result`, `*-7-events`. I looked at the desktop and phone captures of b4 and the desktop remembered view of b5.
* Walkthrough video (outside git): `/private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/video/council-walkthrough.mp4`
  (smoke-b5 at bell 79 to 80; the same walk on smoke-b4 is `council-walkthrough-smoke-b4.mp4` beside it). H.264 1280x800, 66.7 s, no audio, no narration (ffprobe). Frames: page load and roster (0 to 5 s),
  two Wyll cards (5 to 17 s), card goals and stats, a released march decision with its candidate list, the chosen candidates, destination, the AI's words and "Remembered (cited by the model)" lines
  (about 25 to 46 s), the nation council section with its three code-made options, motions, "Ballots by who cast them: AI 1 ... scripted seat 0" and "No Strike Order adopted" and a click through three nation tabs (46 to 60 s), departures and clashes (60 to 67 s).

Layout and wording problems seen (none fixed; the page files are the design/AI shared surface, and the owner has not asked for UI changes):
1. Every non-session decision (council motion, ballot, reflection) prints "Chose: no candidate named"; reflections print "The model wrote no reason." and "Remembered: nothing cited". Correct as data, odd as wording.
2. Candidate fact lines print raw values (`target: {"p":-2,"q":1,"tile":54}`, `host_id: 4661972...`): developer-looking text on the main decision card.
3. At 1280x800 the three columns end at about 650 px and leave a blank band under the footer; the phone width has no clipped text in the captures, but I did not measure `scrollWidth`.
4. The page asks for `minds/<b>.json` of the open bell and `minds/late/<b>.json` for the last closed bells, and `redactions.json`, on every poll: about 12 console 404s per load when those files do not exist (by design of the FB4 polling; harmless, noisy).
5. The page lists six nations; councils exist for nations 0 to 4 only.
6. The Japanese strings added by FB4 (`dec.remembered` and the new keys) have had no native review.

## 5. Corrections of earlier claims (as the fix plan section 2 lists them, checked against the files)

* **smoke-b2 anchors.** "Anchors for every closed bell" was claimed for b2 and b3. Real: 86 closed bells (0 to 85), 85 anchor files (0 to 84), no gap line: the condition was **not met** by b2 or b3 (FB1-NOTES). Cause found in b4: see 3.1; it is fixed and b5 has 109 of 109.
* **"5 own clash wins" in b2 (and b3).** The old episode rule called a clash a win when the enemy lost more than the own side. Against the same files: b2 had 3 `camp_cleared_own` episodes (b3: 4), so 2 of the 5 "wins" in b2 (1 of 5 in b3) cleared nothing: they were fights. R12 now says win = camp cleared or stack destroyed; `clash_own_fought` is the neutral kind. The "beat the camp" lines at (2,-3) bell 57 and (0,-3) bell 60 in b2 and at (0,-3) bell 60 in b3 must not be used as victories in footage or the pitch. b4 and b5 episodes carry `facts.cleared` and the new text.
* **Council in b2.** 1 candidate per nation, 0 counted ballots (the files: `ballots_cast 0` in all nine), the fleet stopped before the council decisions were posted. b3: one AI ballot per nation in period 2, none in period 3, quorum not met. b4 and b5: same pattern (section 3). A Strike Order has **never been adopted live in any run**; the second beat of the demo ("the council adopts a Strike Order") has not been seen.
* **Memory citations (b2).** 22 of 44 model decisions cite memory (sessions 14 + council 8, the fix plan's reading); 22 of the 42 cited lines are `build_done` (b2 report); only 3 marches cite a combat episode (the fix plan's reading). The mind's own counter says 14 (it counts sessions only). b3: 26 of 52 vs the counter's 16; b4: 35 of 61 vs 18; b5: 36 of 59 vs 25. The two figures differ by definition (records' `choice.mem` over all kinds vs the mind's session-only counter); the report prints both. The G14(b) rubric (do cited lines support the choice) is **not done**.
* **release_bell versus R10.** The code sets `release_bell = planned arrival + 1` (`citizens/mind/api.mjs`, lines 152, 174); contract v1.3 R10 says the planned earliest arrival. No unit changed it. The release job opens on the real REVEAL and the ended arrival bell, so the practical effect is a later floor, not an early opening. Recorded as a deviation; not fixed here (a code change touches the sealed-record commitment, M3 and the tests; a contract change is the architect's).
* **Herald load.** Not measured (R5/R6 partly met: the brain's own GETs are counted; GETs per step 5.58 in b4, 5.67 in b5, per AI 5.1 to 6.4; the first observation of a step, the script bots' GETs and the herald's request rate are not). The report says so.
* **Earlier "by:model share"** is an upper bound on model-chosen actions (an action in a model-mode step may be a duty or economy action); the number printed by the report is always labelled.
* **b2/b3 report numbers** were produced before the FB2 fixes (feed_lag counted as neither valid nor fallback; model marches from any model-mode depart including recalls; GET counter double-counting `follow_fetch_gets`). The b2/b3 columns above are those old reports' figures; b4/b5 are from the fixed report.
* **Y** is an episode proxy (a public `clash_own_*` episode for the march's host id, at or after the march bell). The herald clash rows (`engaged: true`, contract 10.1) were not read, so Y is not the contract's Y. A reused host id can credit a later clash to an earlier march.

### 5.1 Review findings of the third round, verified and handled (commits `dae5ee7`, `1b8bcca`, notes)

* **Sealed coordinate in the public metrics file (major, real; FIXED).** `speech.counts()` tallied the refused word per rule, and for a sealed-coordinate refusal that word is the sealed coordinate. `server.mjs` rewrites `pub/metrics/latest.json` on every closed bell and `serve.mjs` serves it, so the coordinate was public from the refusal until the REVEAL (about 3 bells in b4: AI 1005 decided at bell 60, arrival bell 63, tile (3,-3), published `{"3,-3": 1}`). I verified it in the final files of b4 and b5 (b5: `{"3,-3": 2, "-3,1": 1, "2,0": 1, "-2,3": 1}`; b3: two coordinates). The live window itself was **inferred** from the code (updated every bell, counter increments at refusal), not seen as a time series. Fix (`citizens/mind/speech.mjs`): per-word counts are kept only for `pact_word`, `human_claim`, `capture_claim`, `uncited_memory_claim`, `imperative`, `handle_imitation`; every other rule (sealed coordinate, name, number, direction, target kind, ungrounded numbers) is counted by reason only. Test `citizens-mind-speech.test.mjs` "integ-B: refusals by a sealed-target rule ...": fails on the old `speech.mjs` (1 of 24 fails), passes now. **The b3, b4 and b5 `metrics/latest.json` files in `.local` still carry the coordinates** (all long revealed; the run folders are git-ignored; not edited). The contract (7.2 R2, 5.2) says no record or text names a destination before release; this file did. The contract's 10.1 wording "per-word counts" now means per-word for the listed word lists only.
* **M3 `not_sent_but_sent` false failure on a two-march record (major, real; FIXED).** FB5 opens the refused march of a two-march decision as `not_sent` while the other was sent; FB3's check was per record, not per host. `citizens/verify-minds.mjs` now fails only when more hosted marches (`depart`/`march`, status sent) are in the tx list than `destinations - not_sent`, and the Depart-on-chain test uses the same count; it runs once per record. Tests (`citizens-audit-fb3.test.mjs`): one sent + one `not_sent` passes; every destination labelled `not_sent` while one was sent still fails with `not_sent_but_sent`; the old single-march T2 tests still pass. The new test fails on the old `verify-minds.mjs` (1 of 28 fails). Not re-run on a live stack (b5 had 0 not_sent).
* **Merge rehearsal against cq-integ and playtest (major, real; DOCUMENTED).** Section 2 now carries both results: cq-integ conflicts in three hook files, playtest is clean.
* **Message counts (major, real; CORRECTED in 3.1 and 3.2).**
* **b4 anchor wording (minor, real; CORRECTED in 3.1 and the table).**
* **Memory-citation split for b4 and b5 (minor, real; ADDED in 3.1).** I re-derived 35 = 18 + 10 + 7 and 36 = 25 + 8 + 3 from the files.
* **Published say/why that contradict the action (minor, real; LISTED, not fixed).** Seen in b4: AI 1004 at bell 57 (sealed march, only a depart sent): the opened `say` is "start training" (訓練を開始します) while its `why` says it is marching H3 to a camp (I read this record); the live-artifacts review also lists AI 1004 at bell 63 (why "while training more troops", only an explore chosen) and at bell 9 (why "building my reserve", only a train chosen), and AI 1005 at bell 54 ("nearby camp" for a candidate labelled 10 hexes away): I did **not** re-check these three. V5b does not compare `say` or `why` with the chosen candidates (open point 6). **Do not use these records as footage.** The page also prints "Chose: c4" (a candidate id) for an unsealed decision: add it to the wording problems of section 4.
* **Sealed roster/page labels, all-conqueror deck, `--blank-ok`, trailers (minor, real; DOCUMENTED).** `--blank-ok` is **decided by R1** (contract 0.2, section 14.4: its permanent, documented form); the strict form without the flag fails on two historical commits, `55644a9` (a blank line in `bot.rs`) and `127f094` (`main.rs`), accepted by R1, history not rewritten. Two run commits lack the Co-Authored-By trailer: `bbf452a` ("Wylls AI run: smoke-b4") and `9e611bb` ("smoke-b5"); a deviation from rule 1, history not rewritten. The contract header now says `v1.3 + ruling R12 of §14.4` and states that this R12 is not risk R12 of §12.1 (the episode-kinds hash in the commitments changed with it: `6d139006...` to `e4c0f3d5...`).
* **Residual imprecision of the R12 win rule (minor; NOT changed).** `cleared` is per clash (a third army can clear a camp while an own army fought in the same clash: credited as `clash_own_win`); a raid on a village is never cleared (reads "fought"); the Y proxy has no upper bell bound. In any caption keep "cleared camp or stack" and "episode proxy".
* **A2 run-script test (minor).** The run script's end step is covered by registrar-level tests and the live b5 result (109 of 109), and by a text match on the script; it has no test that runs the script. Accepted, stated.
* **Review-time deletion of 11 tracked files (process note).** A reviewer's scratch command deleted 11 tracked files (`events_pub.mjs` and ten `council/*` files) from this worktree for a short time and restored them with `git checkout HEAD --`; the suite of 1555 had finished before. I re-ran the whole suite on the restored tree: 1557 of 1557 (section 2.1), `git status` clean.

## 6. Seams and deviations (everything not in the contract text)

* **Additive council option field `enemy`** (FB4): every option carries `enemy` next to `value / own / ratio` (for a camp `value` is half the troops, `enemy` the whole; the ratio word is computed from `enemy`). `candidates_hash` covers it for new periods; `options_hash` does not. Contract 6.5/8.3 do not list it; the contract text was not edited.
* **R12 episode rule and `clash_own_fought`** (FB5; written into the contract by FB5 at section 14.4 and the episode table): win means cleared. `legacy_v1` replay and `--episode-rule` exist so M11 still reads slice-4, b2 and b3 under the rule they were written with; the automatic choice reads two committed hashes. `episode_kinds_sha256` moved, so b4 and b5 are on the current rule (M11 printed `current` for b5).
* **Injection corpus:** `allowOutside: ["label"]` for MEM11 narrows the pre-registered G5 reading (FB5 D1); the corpus hash moved from `5626f53d...` to `a56fa2fb...` (b4 and b5 `RUNS.md` lines carry the new one). A G5 write-up must say so.
* **Closer clock** (3.1): contract 6.3's rule unchanged, the clock source changed (brain, then the chain).
* **`ai-smoke-14h.toml`**: 14 game hours; `bots_args "--follow-council"` unchanged. Deck passed explicitly.
* **Seat script launched by hand**, not by the run script (the run script starts it only for `--ab`); `--seat-script` was given to the run so the commitments and roster mark the seat scripted. This is not an A/B run: `arm` is null in `RUNS.md` for b4 and b5.
* **FB2/FB3/FB5 edits to the same files** (`report.mjs`, `verify-minds.mjs`): merged as in section 1; the behaviour changes callers see are in FB3-NOTES (INCOMPLETE verdicts, M3 now fails a run whose last closed bell has no files, M8 null with no AI speech, M1 null without `--model`).
* **Unit rebuttals** (FB1 to FB5 each list findings they declined to change: no re-send while an earlier signature exists; the 5.6 sealed-coordinate exception stays; raid options ignore the sender's shield; reviewer #9 ledger progress 0 vs null; M11 budget-cut token recount) were read and are accepted as stated; they are open points, not fixes.

## 7. What was not run, and why

* **G5 and G11 with real Gemma** (the injection corpus: about 200 calls, about 13 minutes): not run; the only live Gemma use this wave was the two smokes. G5's "0 hijacks" so far is about the stand-in model.
* **The A/B pilot** (arm A/B, replicates): not run; each run is about 100 minutes and the seat script has no way to ballot without an AI motion (below).
* **The memory probe dry run with controls** (`llama/probe.mjs`, free): not run in this wave; only the slice-4 probe files exist.
* **A live Strike Order**: not seen in any run.
* **Rust tests** (`cargo test`): not run, no Rust changed (fmt and clippy were).
* **Herald clash rows for Y, herald load, llama tokens per second and RSS, MC load, per-decision quota**: not measured.
* **arm-B replay llama-check** (fix-plan G2 `AI_LLAMA_URL`): not run, not in this wave's list.
* **G14(b) rubric** for memory citations; **native Japanese review**: not done.

## 8. Open points

1. **A Strike Order has never been adopted live.** A nation needs two ballots for the leading option. With one AI per nation the only way to a second voter in this setup is the seat; the stock seat script ballots only after an AI of nation 0 has moved an option, and in b4 and b5 that condition and the poll budget never lined up with a council that existed (b2 and b3 ran without the seat script). Options (owner's call, section stop_for_owner): a seat rule that ballots without an AI motion; a deck with two AIs in nation 0; the council shown honestly as "no Strike Order: quorum".
2. No council file for nation 5 in b2 to b5, although an AI citizen lives there; and nations 0 and 2 had no period-3 council in b5. Not explained.
3. `release_bell = arrival + 1` versus R10 (section 5).
4. The report's run table is stale when the report is generated before the END line (the run script writes it before `runs-end`); the copies in this folder were regenerated after.
5. Contract text: the `enemy` option field is not in sections 6.5/8.3; the architect may want a v1.4 line. Merge with `frontier/unify` will conflict in the contract (3 hunks).
6. From FB notes, still open: `y` upper bound from the planned arrival; the report excludes reflections from model decisions (contract 10.1 lists them); published minds files still carry an unsealed decision's `public.say` for a redacted message (6.3 deviation); the M7 onboarding exemption; V5b does not compare `why` with the choice; the operator-influenced M9 sample seed.
7. `--blank-ok` is the permanent documented form (R1); the strict form fails on two historical blank-line commits (section 5.1). Nothing to decide.
8. Contract 0.2 asks for the merge rehearsal against cq-integ: three hook files conflict (section 2). The I-C merge needs a hand resolution.
9. Footage caption: the seat is labelled scripted from the run flags although this is not an A/B run and no scripted ballot was cast (section 3.2).

## 9. Everything started was stopped

`llama-server` pid 76128 killed at 00:32 (uptime 3 h 27 min); the run script's trap stopped census, registrar-run and the citizens service and `frontier-stack down` stopped localnet, drand replay, relay, herald and keepers for both runs; the seat processes were killed (b5) or had exited (b4); the stack lock `<git common dir>/wylls-ai-stack.lock` is gone; `lsof -iTCP:41900-41999 -sTCP:LISTEN` shows nothing. The paused m1-exit stack (41010 to 41042), the design preview and the other worktrees were not touched. Run artifacts stay under `.local/frontier/ai/smoke-b4` and `smoke-b5` (git-ignored).
