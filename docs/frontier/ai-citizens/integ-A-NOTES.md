# integ-A notes: merge of AC2, AC6a, AC5, AC1a, AC3a, the wave-A slice gate, then AC4, AC1b, AC3b and GA-1 (unit level)

**Two parts.** Sections 1 to 6 are the first half (merges up to AC3a and the slice gate, 2026-10-04 morning). Sections 7 to 14 are the second half (merges of AC4, AC1b, AC3b, the wiring of their modules, GA-1 without the live I-A smoke, the MC list refresh, the hook-diff and the merge rehearsal). Where the second half corrects the first, the first says so in place ("corrected in section N").

Branch `frontier/ai-integ`. Local test chain only (Mode-A `frontier-stack`, test-key drand, base port 41900). No devnet, no paid API, no push. Mac: M4 Max shared with the paused m1-exit stack and the usual desktop processes. Times are JST, 2026-10-04.

## 1. Merges (no-ff, order AC2, AC6a, AC5, AC1a, AC3a)

| Unit | Merged head | Conflicts | Per-unit tests after the merge |
|---|---|---|---|
| AC2 | 0e24af3 | none | `node --test test/citizens-*.test.mjs`: 114 pass |
| AC6a | a8bf2c1 | none | 151 pass |
| AC5 | 699d0ad | none | 221 pass |
| AC1a | 739e337 | none | 367 pass, 1 fail: `citizens-mind-server` expected the stubs of units not built yet (feed, serve); both are real now. Test updated (integ commit) |
| AC3a | 1ba1553 | none (hook files merge mechanically) | whole suite 941 pass, 1 fail: the hook check on this tree (below) |

Dependency requests applied: the `sha2` line in `bots/Cargo.toml` inside an `# AI hook` block and the one `Cargo.lock` line (both already on the AC3a branch, kept as is); `/.local/` added to `.gitignore` (AC5). No other manifest or lockfile change. `permutation-frontier/target/deploy-test-beacon/permutation_frontier.so` was copied from the m1-integ worktree (same sha256 b2cef4a7... as the playtest copy; build output, git-ignored, not a tracked change).

### Hook check (G10) and the two blank lines

`ai-hook-check.sh` (AC5) reports 2 violations on AC3a's history: one added blank line directly after an `// AI hook end` marker in `bot.rs` (commit 55644a9) and in `main.rs` (127f094). The check is per commit, so deleting the lines afterwards only adds "removed line outside a block" violations. I used the opt-in `--blank-ok` that AC5 provided (a spacing blank line beside a block is tolerated) and changed AC5's tree test to run with it. This is a relaxation of the contract's literal "every added line outside a block counts"; it covers exactly those two blank lines. `ai-hook-check.sh --blank-ok` on HEAD: PASS (183 MC files from 1 list, 22+ commits since 30ba411). Without `--blank-ok` it fails with the two violations. The architect may prefer to rewrite the AC3a commits instead.

### Whole-suite results (final HEAD `9dd0d10`)

- `cd permutation-gateway && npm test`: 949 tests, 949 pass, 0 fail.
- `cd frontier-node && cargo test -p bots -p agents -p herald -p stack --locked` (CARGO_TARGET_DIR the integ dir, `nice -n 5`, `-j 6`): 211 passed, 0 failed (all `test result` lines ok).
- `cargo fmt --check`: clean. `cargo clippy -p bots -p agents -p herald -- -D warnings`: clean.
- `ai-hook-check.sh --blank-ok`: PASS (35 commits since 30ba411, 183 MC files from the frozen 2026-10-03 list). Without `--blank-ok`: FAIL with the two blank-line violations above.
- Not run in the first half: `cargo test -p itest`, the MC list refresh to the current 282-path union, the hook-diff test against `frontier/cq-integ` and `frontier/playtest`, the merge rehearsal against `frontier/unify` (all I-A tasks, not part of this slice gate). **Done in the second half: sections 10 to 12.**

## 2. Seams found by the first live runs, and what was done

Four live runs of `ai-citizens-run.sh` (slice-1 to slice-4; the first three stopped early, so the three allowed fix-and-rerun iterations were used; every one is in `RUNS.md`).

| Run | Stopped at | Cause (a seam between units built in parallel) | Fix (owner file) |
|---|---|---|---|
| slice-1 | citizens service did not start | the run script gave the permission model one comma-separated `--allow-fs-read` list (Node 20.19.4 refuses it: AC1a measured this), and the list did not cover the web imports of dynamically loaded modules (`watcher/feed.mjs`, `owners.mjs`) and a denied `existsSync` throws instead of returning false | AC5 `ai-citizens-run.sh` takes the flags from `server.mjs --print-permission-flags` (repeated flags); AC1a `permissions.mjs` adds the import closure of every citizens module; `server.mjs tryImport` treats a denied probe as "not there" |
| slice-2 | `registrar deal` | AC5's `buildRoster` handed AC2's `deal()` slots without `kind: 'ai'`; `deal()` keeps only `kind: 'ai'` slots | AC5 `registrar.mjs` passes `kind: 'ai'` (+ its test) |
| slice-3 | stopped by me after 15 decisions, all `autopilot:feed_lag` | AC1a's mind needs `feed.cursorBell()` and AC6a's feed has `completeThrough()` (head bell - 1), and nothing was wired between feed, `episodes_from_events` and the AC2 stores; the watcher was a stub returning no wakes | new `mind/wiring.mjs` (feed view, feed-wake watcher stub, episode pump), `server.mjs` uses it; AC6a `feed.mjs` `completeThrough` also follows the herald's indexed time (`/h/season latestUnix` read before the poll) and counts `late_rows` |
| slice-4 | ran to the end of play (12 game hours), see section 3 | found live, fixed after the run, **not re-run** (iteration cap): (a) the bots step in the first 1-2 seconds of a bell, before the chain's block time has crossed the boundary, so the feed cannot yet vouch for bell - 1: 113 of 127 granted sessions were refused as `feed_lag`; (b) the feed derived 19 wakes (W-THREAT, W-CLASH) and none reached a gate score, because a record logged in bell b lands after the step of bell b and my first watcher stub only looked at (previous bell, this bell] | (a) `feedView.waitCursor` + `api.mjs`: the mind pulls the feed and the pump for at most min(6 s, deadline - now - 15 s) before it declares `feed_lag` (counter `feed_wait`); (b) the stub delivers each wake once from a window of 8 bells. Unit tests only (`citizens-integ-wiring`, `citizens-mind-api`) |

**Corrections found in the second half (section 8): (a)** in all four slice runs `server.mjs` handed `serve.mjs` the directory `AI_DIR/pub`, and `createServe` appends `/pub` itself, so `/h/ai/*` was an empty directory during the slice (no pass condition read it: the conditions were checked on the files on disk and `/v1/*`); **(b)** the service ran with the mind's default season 0 while the stack's season is 41 (the run script did not pass `--season`); no published record carries a season, so no number in this file changes, but it would have broken every signed social record against a real social store. Other integrator edits: `citizens/config/slice.json` (= `smoke.json` with `allow_speech_stub: true`; AC1b's `mind/speech.mjs` does not exist yet, so V5/V5b are the labelled stub: `/v1/health` says `speech: "stub"`, the service reports `stubs: [speech, social, watcher]`), registrar test and server test adjustments, `CITIZENS_DEBUG=1` prints the stack of a startup error.

## 3. Slice gate: run slice-4

Command (from the worktree root; `FRONTIER_BIN` = the integ release build, `AI_UNIT=ai-integ-A`):

`permutation-gateway/citizens/bin/ai-citizens-run.sh --stack permutation-gateway/citizens/stack/ai-smoke.toml --citizens-config permutation-gateway/citizens/config/slice.json --run-id slice-4`

Setup: llama-server started by `citizens/llama/start-pinned.sh` on 41901 (`-np 1 -c 16384 --reasoning off`), 6 AI citizens (deck-1: 6 conquerors, one per nation) + the presenter seat + 30 script bots, 12 game hours at 10x (72 bells of play, 10:31 to 11:46 real, then the 26-bell drain). Commit memo landed before genesis (`PUB/anchors/commit.json` status `audited`, slot 4). Code under test: `4b7a9b9` (the run was started from it; the two post-run fixes of section 2 are the later commits `028a0c3` and `9dd0d10`).

Pass conditions (evidence in the final report and `AI_DIR` = `.local/frontier/ai/slice-4/`, git-ignored):

1. One decision record per step: 387 records in `pub/minds/<bell>.json`, one per (AI, bell), no duplicate and no gap for any AI from its first final-village bell (5 to 10) to bell 71. The brain counted 423 steps; 387 reached the mind as a first call (+5 repeat calls of the same bell answered from the cache, total answers 392 = `outcomes`); the other 36 steps made no mind call (consistent with the steps before an AI's village is final; I did not attribute them one by one).
2. Episode files: `PUB/memory/<tag>/episodes.json` published for all 6 AIs, 57 episodes in total at the end (build_done, threat, clash_own_win, clash_own_loss, camp_cleared_own, camp_taken_by), produced from real herald rows by `episodes_from_events` through the pump.
3. Model-chosen marches: 7 (bell 40 x3: AIs 1001, 1003, 1004; bell 52: 1000; bell 64: 1003, 1004; bell 70: 1001). Each is a record with `mode: model`, `kind: session`, sealed, `release_bell` = arrival + 1, a `depart` tx `status: sent`, and a marchbook trail sealed/sent/accepted/revealed/settled. The private record of 1001 at bell 40 shows candidate c3 `kind: march`, target camp (-1,3) tile 53, which is the destination in the marchbook. The model cited memory (`mem` handles) in 9 of 14 model decisions.

Everything else measured on this run:

- Model decisions: 14 (all `valid_choices`, 0 `no_time`, 0 errors, 0 timeouts); latency ms (llama call as recorded) 2299 to 4236, p50 2984, p90 4034 (n = 14; tokens per second not measured here). Mac load (`uptime`, 1/5/15 min): 2.9/3.5/3.5 at 10:50, 2.6/2.6/2.7 at 11:47 (paused m1-exit stack and desktop running; no MC, no playtest).
- Gate: 387 decisions; 260 `autopilot:below_gate`, 113 `feed_lag`, 14 model sessions. 127 sessions were granted by the gate and only 14 ran: the feed_lag race of section 2 (the gate keeps granting a session each bell until one runs, so each AI did get through eventually).
- Wakes seen by the gate: W-PULSE 127, W-QUEUE 249, W-READY 13 (all brain hints or the pulse). The feed's 19 W-THREAT/W-CLASH wakes were not delivered (bug b above). Reflection: `reflect_due` fired 12 times, no reflection job exists (AC1b), so none ran.
- `say`: 7 withheld by the stub; 1 `why` dropped for a sealed coordinate; `params_stray_dropped` 3.
- Feed: 0 errors; `late_rows` 0 (no record arrived at a bell the feed had already claimed complete); pump 0 errors, `unknown` empty.
- Real clashes of model-sent marches produced `clash_own_win` x5 and `camp_cleared_own` x4 episodes, `clash_own_loss` x1, and a `camp_taken_by` x1 (not own march).

## 4. AC3a step 0 items (c), (d), (e) on this smoke

(c) Census (`census/<bell>.json` at bells 16, 28, 40, 52, 64, `ready.jsonl` every bell): all 6 AIs reached a final village (census final bells 4 to 9; the brain's own timeline reads 5 to 10, one bell later). The census **camp column is wrong on live data**: it reports 0 camps in the window at every snapshot while the AIs' prompts at bell 16 list camps of 105 to 152 troops at distance 0 and 1, and from their first ready host every AI had 2 camp-march candidates (`target_kind: camp`) in every decision (230 decisions with a march candidate; 26 field-stack candidates). The reader in `scenario/census.mjs` (`ov.sites.some(s => s === 2)` filter and `pv.camp.state === 1`) does not match the live Province data (a cleared camp reads `state 0, troops 0`); I did not fix it (AC5 file; the census was not part of the pass conditions). So (a) "does each AI have a live camp near it" is answered by the candidates, not by the census: yes, for all 6, from the first ready host.

(d) Bells from an AI's first final village to its first ready host (census `can_depart`): 14, 13, 29, 11, 10, 21 (min 10, median 13.5, max 29); the brain's timeline agrees exactly (first ready bells 19, 19, 36, 19, 19, 31 minus first final 5..10). To the second ready host: census 25, 23, 29, 46 (two AIs never had a second host that could depart during play); brain timeline 25, 36, 23, 29, 45 (one AI none): median about 29 bells (about 4.8 game hours). The smoke length of 12 game hours (72 bells) is therefore enough for the first march of every AI and the second host of 4 or 5 of 6; 8 game hours would have been too short for the second.

(e) Host-size distribution under the AI brain (autopilot economy plus model muster choices), combat hosts (unit != scout) read from the 5 census snapshots (47 rows, rows repeat across snapshots, so this is not 47 independent hosts): min 100, p25 188, median 200, p75 200, max 400; sizes 200 x27, 400 x7, 100 x6, 178 x2, 188 x2, 183 x2, 171 x1 (the 17x/18x values are hosts that already fought a camp). At bell 64 (13 hosts): 100 x3, 171, 178, 183, 188, 200 x4, 400 x2. Hosts that could depart: 28 rows, median 200. The private record of AI 1001 at bell 40 shows the marching host as 200 troops (c3); I did not read the troop count of the other six marches.

## 5. Deviations and open points

- Relaxed G10 for 2 blank lines (`--blank-ok`), see section 1.
- The gate ran with the labelled speech stub and a wave-A watcher stub that carries feed wakes only (contract 11.6 says a stub returning feed wakes only is the wave-A watcher); social is the AC1a stub (no messages, no council). No AC4, AC1b, AC3b, AC6 code was involved.
- `feed.mjs` `completeThrough` semantics changed (AC6a notes had said "head bell - 1"): it is now max(head - 1, bell of the herald's `latestUnix` read before the poll - 1). The assumption (the index holds every record of an earlier bell once `latestUnix` is past it) is checked live by `late_rows`: 0 in slice-4. Test: `citizens-feed.test.mjs`.
- Open, not re-run on a live stack: the two post-run fixes (waitCursor, watcher delivery). Their expected effect (fewer `feed_lag`, W-THREAT/W-CLASH wakes opening sessions) is unmeasured.
- AC5 `census.mjs` camp reader (section 4): **fixed in the second half (section 8, seam 7)**. The "one decision record per step" count for the 36 steps without a mind call is still open.
- Per-worktree stack lock: only one stack ran (`AI_STACK_LOCK` unchanged). The run script commits `RUNS.md` entries on this branch (slice-1 to slice-4, END lines included); they are run records, not code.
- Ports used: 41901 (llama), 41902, 41980, 41981 (service), 41900-41975 (stack), 41971 (fleet control); the paused m1-exit stack, the playtest ports and every forbidden port were not touched. llama-server, the stack, the citizens service were stopped at the end (section 6).
- rustfmt and clippy are installed here (the units' notes say they are not): `cargo fmt --check` and `cargo clippy -p bots -p agents -p herald -- -D warnings` both pass on the merged tree.

## 6. What was started and stopped

Started: llama-server (pid from `start-pinned.sh`, 41901), one stack run at a time via the run script (slice-1 .. slice-4: localnet, drand replay, relays, herald, keepers, 30 script bots, the citizens service on 41980/41981/41902, registrar, fleet of 6 AIs + seat, census), a throwaway preflight service in test mode (ports from 0, the golden decide request through the real prompt and real Gemma: valid model march choice in 3.7 s) and a 5-second permission-model start of the service on 41990-41992. Stopped at the end: llama-server killed, the run script's trap stopped every child and released the lock (`stack.lock` is gone), `lsof` shows nothing listening on 41900-41999, no process of this worktree left. The m1-exit stack (41010/41040 and the rest) and the design preview were never touched.

slice-4 final status in `RUNS.md`: `complete` (stack complete, publication written; commit memo `audited`; 74 per-bell anchor files).


---

# Part 2: the second half of integ-A (AC4, AC1b, AC3b, wiring, GA-1 without the live smoke)

Branch `frontier/ai-integ`, 2026-10-04 afternoon (JST), same rules as part 1: local test chain only, no devnet, no paid API, no push, no download. Nothing in part 2 started llama-server, a stack or a long-lived service on 41901 to 41999 (the only listeners were the 5-second permission-model starts of the citizens service on 41990 to 41992 and in-process tests on `127.0.0.1:0`; `lsof` showed nothing on 41990-41992 afterwards). Mac load (`uptime`, 1/5/15 min) at the long commands: 2.8/3.0/3.1 before the cargo test, 4.0/3.9/3.5 before itest, 3.6/4.0/3.7 around g14; the paused m1-exit stack and the desktop were running; no MC, no playtest. All counts below are from the final tree unless a line says otherwise.

## 7. Merges (no-ff, order AC4, AC1b, AC3b)

| Unit | Unit head | Merge commit | Conflicts | After the merge |
|---|---|---|---|---|
| AC4 | 42eef66 | 7989bf4 | none | `node --test test/citizens-*.test.mjs`: 426 tests, 425 pass, 1 fail (the G10 outside-URL grep: seam 1) |
| AC1b | 9b0c11e (cut from AC1a 739e337) | af35f7a | none (changes `mind/prompt.mjs`, AC1a's file: 14 insertions, 9 deletions) | 498 pass, 0 fail |
| AC3b | fd051ce (cut from AC3a 1ba1553) | ffbad0d | none (`brain.rs`, `mod.rs`, `raid.rs`, `recall.rs`, `ai_brain.rs`, `ai_wire.rs`, the golden `ai-decide-v1.json` merge mechanically) | `cargo test -p bots -p agents -p herald -p stack --locked`: 265 passed, 0 failed, 3 ignored (all ignored are pre-existing) |

`permutation-gateway/test/fixtures/ai-social-v1.json` is byte-identical in AC4 and AC3b (sha256 `c59969ef45ea264427c955cc759e8b66f4638ebd849c3f337b8fe2017d8b9cea`), so the Rust side (`ai_social_vectors.rs`: 7 tests; `ai_sign_domain.rs`) reads AC4's committed vectors and passes: **AC3b's signing conforms to AC4's byte vectors** (6 talk, 3 ballot, 2 call-read vectors, the refused byte strings). `vectors.mjs --check` (AC4's freshness check) is part of `citizens-social.test.mjs` and passes.

## 8. Seams found and fixed (each a minimal commit; commits `381116f`, `cec0662`, `79b2370`)

1. **G10 grep after the AC4 merge.** `citizens/social/routes.mjs` parsed request URLs against `'http://x'`; the contract's outside-URL grep (`citizens-run-check`) refuses any `http://` that is not loopback. Now `'http://127.0.0.1'`, the same convention as `mind/api.mjs`. (`381116f`)
2. **`serve.mjs` served an empty directory** (also in part 1's slice runs, see the correction there): `server.mjs` passed `aiDir: PUB`; `createServe` appends `/pub`. Now `aiDir`. Found by the new service-level test (a council file written by AC4 returned 404 through serve). Also `server.mjs` pointed serve's `/f/ai/*` forward at the configured social port even when that is 0 (tests); now at the port the social listener really bound.
3. **AC4's store was not constructible from the old stub call**: it needs `aiDir` = AI_DIR (it writes `pub/talk`, `pub/council`, `state/social` itself; the service passed PUB), a roster **function** returning a stable object (`rosterJsonCur`, the registrar's `roster.json`; its `script.wallets` and `seat` are what labels a wallet), a `{bell(), unix()}` clock (new `socialClock` over the mind's game clock; wall time before the clock has an anchor, when the store refuses with `BellSkew` anyway), the provenance in the `{provenance, consume}` form (new `provenanceOf(records)`; AC4 calls `consume(id, item)` without a type, so it tries `talk` and then `ballot`), AC1b's sanitiser, the stack's `season`.
4. **Season.** The run script now passes `--season "$SEASON_ID"` to `server.mjs` (the service already parsed `--season`; it defaulted to 0). The mind signs items for that season, the store verifies against it and asks the herald's `/h/me` for it.
5. **AC1a's views read `social.read.{council, inbox, hall}` synchronously** (shapes in `views.mjs`'s header); AC4 offers `book.list` (sync), `book.inbox` (async), `council.publicState`. New `socialReadViews` in `mind/wiring.mjs` adapts: an incremental row cache over `book.list` (dropped when `pub/redactions.json` changes, so a redacted message does not stay in a prompt), channel numbers as AC4 gives them (the prompt already reads 3 as direct), the council view without `ballots` and `tally_split` (a ballot never reaches a prompt; closed periods list them in AC4's public state).
6. **AC1b's pieces:** `server.mjs` now creates the reflection job (`createReflection`, started with the watcher, stopped in `close()`; `config.memory.reflection:false` turns it off); `mind/api.mjs` merges `speech.counts()` into `/v1/metrics` under `speech` (per-word refusal counts) and passes `nations` in the sealed entries of the speech check (AC1b's checker refuses "nation 3", "N3", 国3); `prompts/reflection.en.txt` says numbers must come from the EPISODES below (the validator accepts only the window's episodes); `mind/speech-stub.mjs` and `config/slice.json` are deleted, `allow_speech_stub` is removed from `smoke.json`, `ab.json`, `main.json`, and the service refuses to start without `mind/speech.mjs` in test mode too (A.5: the pact words appear only in `mind/speech.mjs`; a `git grep -iE 'pact|betray|promise|alliance'` over `citizens/`, the council directory and `bots/src/ai/` finds, besides `speech.mjs`, only comments naming Appendix A and the reserved TAG in `aisocial.mjs` and `aisign.rs`, which A.5 (3) allows, plus the JavaScript word `Promise`).
7. **Council files are not immutable.** §8.3 gives `<digits>-<digits>.json` the immutable header, and AC4's `council/<k>-<f>.json` is rewritten up to six times per period (AC4 notes, open point 1). `serve.mjs` now applies `immutable` only under `talk/`, `minds/` (incl. `minds/late/`), `open/`, `anchors/`; the rest, including `council/` and `chronicle/<day>.json`, gets `max-age=2`. **Deviation from the literal §8.3 text** (the contract table lists both files as rewritten, so the text contradicts itself; the unit test and a service-level test pin the new rule).
8. **Census camp reader (open item of part 1) fixed.** The overview's `sites` are the 12 village slots (free, holding, reserved) and never mark a camp. Recorded herald data of the m1-exit stack (`test/fixtures/ai-brain-real`): the provinces with a live camp (state 1, 212 to 344 troops) read overview sites `111111111111`. The reader's `sites.some(s => s === 2)` gate therefore found no camp at all. Now a live camp is read from the Province record (`camp.state === 1 && troops > 0`) for every province of the window from ring 2 on; the per-bell poll (`ready.jsonl`) no longer scans the window or reads overviews (it reads `/h/me` and the provinces of its own hosts), the full scan runs only when a census file is due. Cost of a census read: up to one request per province of the window, at most about 800 (the whole map at rMax 16), 6 in flight; not measured on a live herald. Tests: `citizens-census.test.mjs` (a regression test over the recorded provinces: five live camps, none marked in the overview; a request-count test).

New test file: `test/citizens-integ-social.test.mjs` (5 tests): the service builds the real social store, the real speech checker and the reflection job (only `watcher` remains in `stubs`); a mind `say` is accepted once when signed with the citizen's session key (provenance equal), the same record again is refused, a tampered text is `NotFromMind`, a decision id the mind never issued is `NotFromMind`, an origin-0 record of an AI wallet and an AI record without `decision_id` are refused; the accepted text comes back through the hall into the next AI's prompt, wrapped as `<untrusted from=...>`; a council motion (kind 1, `ref = period << 8 | option`) and a ballot (with the period's `candidates_hash` and the mind's nonce) are accepted in their windows, `ballots_cast` counts it and no ballot is in the public view; through `serve.mjs` (`/f/ai/talk`, `/gw/f/ai/council`, `/h/ai/talk/40.json` immutable, `/h/ai/council/2-0.json` 2 s). What it does not show: the Rust brain's own POST (its bytes are checked against the vectors, its HTTP call by `ai_social_post.rs` against a fake), any live herald (`/h/me` is a double: the social kit of AC4 plus one recorded real `/h/me` in `citizens-social`), and any model behaviour (the model is a fake llama-server).

Also verified by running, not by test: the service starts under the permission-model flags with the real social store (stubs `["watcher"]`, 5 s on 41990-41992), `GET /f/ai/council` answers, an unauthenticated `POST /f/ai/talk` reaches the herald client (`HeraldUnavailable`, the herald being absent), `herald.mjs` imports under the flags and a read of `Cargo.toml` is `ERR_ACCESS_DENIED`; the read list already contains `web/frontier/{herald,fcodec,abi}.mjs` and `web/sdk/*` through the import closure of the citizens modules (AC4's dependency note is covered).

## 9. GA-1 (contract 11.4) at the final tree, everything except the live I-A smoke

| Command | Result |
|---|---|
| `cd permutation-gateway && npm test` | **1079 tests, 1079 pass, 0 fail** (run at `79b2370`, load 4.6/4.2/3.6) |
| `cd permutation-gateway && node --test test/citizens-*.test.mjs` | 505 tests, 505 pass, 0 fail (42 files) |
| `cd frontier-node && cargo test -p bots -p agents -p herald -p stack --locked -j 6` (target-integ, `nice -n 5`) | exit 0, **265 passed, 0 failed**, 3 ignored (run after the AC3b merge; the Rust tree has not changed since: the later commits touch JavaScript, scripts and docs only) |
| `cargo fmt --check` | clean (no output) |
| `cargo clippy -p bots -p agents -p herald -j 6 -- -D warnings` | clean |
| `cargo test -p itest --locked -j 6` | **13 passed, 0 failed, 3 ignored** (`inproc_smoke`, `native_rerun` 5, `relay_standin`, 6 unit tests; ignored by attribute: `g14_two_game_days`, `recheck_a_kept_recording`, `inproc_day`). `git diff 30ba411 HEAD -- frontier-node/crates/itest` is empty, so the test sources and their ignore attributes are those of `30ba411`. I did not build and run `30ba411` for a side-by-side comparison. |
| `cargo test -p itest --locked --test inproc_day -- --include-ignored` | **passed** (1 test, 152 s, `nice -n 5`); the contract lists it as known open on `30ba411`, where I did not run it, so this is a result on this tree only: the hooks with AI off do not break the in-process day |
| `cargo test -p itest --locked --test g14 -- --include-ignored g14_` | **passed** (1 test run, 298 s, `nice -n 5`; `recheck_a_kept_recording` filtered out); like `inproc_day`, listed as known open on `30ba411` and not run there by me: a result on this tree only |
| `ai-hook-check.sh` (no flag) | **FAIL, 2 violations**, both an added blank line next to an AI hook marker in AC3a's commits 55644a9 (`bot.rs`) and 127f094 (`main.rs`): the same two as in part 1; the check is per commit, so only rewriting those two commits removes them. Not rewritten (they sit under merged history). |
| `ai-hook-check.sh --blank-ok -q` (HEAD) | **PASS** (the opt-in tolerates exactly those spacing lines; part 1 deviation 1 stands, the architect may still prefer the history rewrite) |
| `citizens/bin/mc-files.sh` | 282 paths (see section 10) |

Not run: the live I-A smoke (llama-server and a stack; not part of this task), `g14`/`inproc_day` on `30ba411`, anything on devnet (nothing here touches it).

## 10. MC list refresh (contract 0.2)

`permutation-gateway/citizens/bin/mc-files.sh > docs/frontier/ai-citizens/MC-FILES-2026-10-04.txt` (new script, committed with the list; read-only: `git for-each-ref` and `git diff --name-only 30ba411...<branch>` over every `refs/heads/frontier/cq-*`, sorted, deduplicated). **282 paths**, the number the contract states for 2026-10-04; 99 are new against the frozen 2026-10-03 list (183 paths), none was dropped. Branch tips read: cq-1a-rules e17e8f5, cq-1b-sim 136f972, cq-1c-abi 45c06f1, cq-1d-docs 0b9a75e, cq-2a-core 8b8223a, cq-2b-clash 935b619, cq-2c-conquest 6efa621, cq-2d-keeper ba5c3d2, cq-2e-herald 3674c88, cq-2f-bots 592019a, cq-integ 6ec65e4, cq-w1c-contract 1693c27, cq-w1c-kernels c1d4fec, cq-w1c-sim 7a1cead (`mc-files.sh --tips` prints these). No AI-directory path is in the list. The five hook paths (`bot.rs`, `fleet.rs`, `main.rs`, `lib.rs`, `bots/Cargo.toml`) and `frontier-node/Cargo.lock` are in it, as expected; `ai-hook-check.sh` reads both list files (union).

## 11. Hook-diff test and merge rehearsal (read-only against the other branches)

`git merge-tree --write-tree --name-only HEAD <branch>` writes tree objects into this repository's object store (unreachable, no ref or working file touched); the three branches themselves were only read.

| Against | Tip | Result |
|---|---|---|
| `frontier/playtest` | 0058f78 | **clean** (exit 0) |
| `frontier/unify` | 65b011c | **clean** (exit 0) |
| `frontier/cq-integ` | 6ec65e4 | **3 conflicting files, 10 hunks, all in the hook files**: `bot.rs` (2), `fleet.rs` (3), `main.rs` (5). Every one is two insertions at the same place (the AI hook block next to MC's `cq` line or block). |

Conflict list (what MC added next to each AI hook block): `bot.rs` the field `pub cq: CqMem` beside `pub ai: BotAi`, and `cq: CqMem::default()` beside `ai: Default::default()`; `fleet.rs` MC's rewritten `busy` expression (`|| (cq_play && !bot.cq.orders.is_empty())`) after the `let eager = eager || bot.ai.on;` hook, `let cq = sh.conquest.is_some(); let ran = pace.plan(.., eager, cq)` after `follow_wake`, and `pace.after(.., eager, cq)` before `follow_next_wake`; `main.rs` the `conquest*` and `bot_share` fields, defaults, flags (`--conquest`, `--conquest-personas`, `--bot-share`), the `Conquest::new` block after `ai::setup`, and two tests next to `ai_flags_parse`.

**Rehearsal of the resolution** (scratch copy of the merged tree, nothing committed): resolving every hunk as "keep both sides, AI hook block first, MC's lines as MC has them" (in `fleet.rs` the hooks stay around MC's new lines, `follow_next_wake` after MC's `pace.after(.., cq)`) leaves **one compile error**: `main.rs` `let shared = match ai::setup(...)` is immutable and MC's block later assigns `shared = shared.with_conquest(c)`; the AI hook line must read `let mut shared = match ...` (inside the hook block, no new line). With that: `cargo check -p bots --all-targets --locked` is clean and **`cargo test -p bots --locked` on the cq-integ merge passes 140 tests, 0 failed** (17 `ai_*` test binaries included, so the golden request, the autopilot filter and the follow logic hold on MC's `policy::decide_with(.., war)` call). I did not run the other crates on that tree, and the AI hook at the `decide_with` call merged without a textual conflict. This is a rehearsal on a scratch copy; I-C does the real merge and must repeat the resolution (the recipe above is the whole of it).

**Hook-diff** (the AI side of the four hook files plus the manifest, `git diff 30ba411 HEAD`): 114 added lines in 6 files, no removed line; **20 hook blocks** in the four source files and one in `Cargo.toml`, largest block 17 lines between its markers (limit 30). The rows below are the missing hook rows, one per block (lines are the marker lines at HEAD; "body" counts the lines between the markers):

| File | Marker lines | Body | What it hooks |
|---|---|---|---|
| `bots/src/bot.rs` | 164-170 | 5 | the fields `Shared.ai` (the brain's shared state, set by `ai::install`) and `Shared.outcome_sink` |
| `bots/src/bot.rs` | 185-188 | 2 | `ai: None, outcome_sink: None` in the `Shared` constructor |
| `bots/src/bot.rs` | 247-251 | 3 | `Shared::record` hands every outcome to the sink (the brain keeps its own bot's signatures for `/v1/outcome`) |
| `bots/src/bot.rs` | 291-294 | 2 | `Bot.ai: BotAi` field (`on` only for slots `kind:"ai"`) |
| `bots/src/bot.rs` | 336-338 | 1 | `ai: Default::default()` in `Bot::new` |
| `bots/src/bot.rs` | 342-353 | 10 | two accessors for the brain: `ai_quota_left` (the relay quota this bot may still spend) and `ai_spent_reset` |
| `bots/src/bot.rs` | 511-515 | 3 | in `Bot::step`, after the rule policy has computed its intents: an AI slot hands them to `ai::brain::step_ai` (autopilot filter, the model's choice) and returns |
| `bots/src/fleet.rs` | 248-250 | 1 | AI bots are eager (the 90 to 150 s offset) |
| `bots/src/fleet.rs` | 283-285 | 1 | the same for the second pacing pass |
| `bots/src/fleet.rs` | 423-425 | 1 | `ai::follow_wake` (the Strike-Order follow wake, AC3b) |
| `bots/src/fleet.rs` | 432-434 | 1 | `ai::follow_next_wake` |
| `bots/src/main.rs` | 54-56 | 1 | `Args.ai: AiOpts` |
| `bots/src/main.rs` | 86-88 | 1 | its default |
| `bots/src/main.rs` | 142-148 | 5 | the flags `--brain`, `--brain-token-file`, `--ai-slots`, `--follow-council`, `--export-seat-key` |
| `bots/src/main.rs` | 166-170 | 3 | `a.ai.check()` (flag consistency) |
| `bots/src/main.rs` | 302-310 | 7 | `ai::setup(...)` (builds the shared brain state; refuses on error) |
| `bots/src/main.rs` | 312-315 | 2 | `ai::mark_bots(&mut fleet)` (marks the AI slots) |
| `bots/src/main.rs` | 393-395 | 1 | `ai::write_stats` (`ai-brain.json`) |
| `bots/src/main.rs` | 503-521 | 17 | the test `ai_flags_parse` |
| `bots/src/lib.rs` | 32-34 | 1 | `pub mod ai;` |
| `bots/Cargo.toml` | 29-31 | 1 | `sha2.workspace = true` (`# AI hook`) |

AC3b added no hook line (its code is in `bots/src/ai/**`, `bots/tests/ai_*`). `Cargo.lock`: one line (`sha2 0.10.9` in `bots`).

## 12. Stubs and test doubles after this merge

Real now: social store (AC4), speech checker and sanitiser (AC1b), reflection job (AC1b), Rust follow, fetch, signing, raid, recall (AC3b). Still a stub: **the watcher** (`createWaveAWatcher`: feed wakes only; AC6 is wave B). Consequences until AC6 merges: no council is ever opened by the service (nothing calls `council.open`), no Strike Order is adopted or sealed (`fixCall` is unused, so no `invited` list), no chronicle, no cards job, no release job: **a march decision stays sealed in `PUB/minds` and is never opened** until AC6's release job exists (part 1 said the same), and `council.tick()` runs only through `closeBell` (every bell, in the background) and the GET routes. The speech word lists now run on real model text for the first time in the I-A smoke.

## 13. Deviations from the contract in part 2

1. §8.3 cache rule narrowed to four directories (seam 7); the contract's own table contradicts the literal rule.
2. G10 without `--blank-ok` still fails on two blank lines in AC3a history (part 1, unchanged).
3. `server.mjs` takes a `socialHerald` override (a `me(wallet)` client for the real store) so that a service-level test needs no herald; in production the store is given the herald URL.
4. `mind/api.mjs` and `prompts/reflection.en.txt` (AC1a files) and `social/routes.mjs`, `serve.mjs`, `scenario/census.mjs` (AC4, AC5) were edited by the integrator for the seams above; each edit is in `cec0662`, `381116f` or `79b2370`.
5. The census read is heavier than before when a census file is due (section 8, seam 8).

## 14. Open points

- **Not run live**: the second half has no live evidence. The I-A smoke (llama-server, stack, real brain posting `say` and `motion` through `serve.mjs`, a real reflection, speech refusal rates, `/v1/metrics` `speech`) is the next step; before it, the two part-1 fixes (`waitCursor`, watcher delivery) are still unmeasured live.
- AC1b's own open points stand: the word lists and number grounding have not seen real Gemma text for `say`, `why` or summaries; a `why` of a march decision that names kind, place or number is replaced by the code string (contract 7.2/4.5 as written), so the demo's opened reason may often read "(reason withheld by the checker: ...)"; a refused reflection (record kind `reflection`, reason `invalid:V5b`) counts as a model decision that is not valid in 10.1 unless AC9's report filters by kind; M11's `retrieve()` recomputation does not apply to reflection records (AC8); delete nothing else of AC1b (its stub is gone).
- AC4's own open points stand: `tally_split` counts a human's self-declared origin 1 as `ai` (the badge comes from the roster only); the default voter eligibility over-approximates "final by rule"; script bots may not POST; the redaction tombstone blanks files and API output but `STATE/social/records.jsonl` keeps the raw record until the 2026-10-31 purge.
- AC3b's own open points stand: the Call window under the real clock, the real council from AC6, the relay quota effect of 18 AIs and about 180 following script bots, and any model latency are unmeasured; the brain's threat feed reads `/h/events` from event 0 (at most 20 pages per bell), and a herald without the `findex` index answers 503 `NoIndex` and the feed is then silent.
- `ai_social_post.rs` posts to a fake social service; the first real Rust-signed record through the real store happens in the I-A smoke. The JS side of the same path is in `citizens-integ-social.test.mjs`.
- Reflection fires from the first step at or after bell mod `reflect_every` (24 in `smoke.json`); it needs a clock anchor from a `/v1/decide` and at least one episode in its window, else it is skipped and counted (`reflection_skipped`).
- `docs/frontier/DECISIONS.md` part X (13.1) is not written by this unit.
- Wave B must not re-introduce the stub: AC6's `createWatcher` is picked up by `server.mjs` from `watcher/index.mjs` or `watcher/watcher.mjs` with `{feed, social, ledgers, records, aiDir, config}`; it will need `social.council.open`, `social.council.seal` or a `fixCall` passed to `createSocial` (not wired: today `createSocial` is built without `fixCall`; AC6 owns that decision, one line in `server.mjs`).
