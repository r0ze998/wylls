# Recording run: the council beat with a live human ballot (recipe)

Local test chain only (no devnet, no paid API). Contract: 9.1 (beat 2), 9.2 (the seat), 9.4 (recording procedure), 6.5 (council, human-present rule).
Owner-facing guide in Japanese: `RECORDING-GUIDE.ja.md`. This file is the recipe: the command, the geometry, the expected timeline, what changed in the code and what is and is not shown.

## 1. What the run is for, and the only sentence it can support

The owner (the operator, nation 0, the presenter seat) votes **live on the council page** so that nation 0's Strike Order is adopted by the AI ballot(s) of nation 0 plus the owner's own ballot. This is the only source that supports "a human and AI citizens decided together" (contract 9.2), and only under these conditions:

* the ballot was cast by the owner on the page in this run (origin 0; the page's tally line reads "human (the presenter) 1"),
* it counts toward the adopted option (the council file shows `adopted: true`, `tally_split.human >= 1`),
* the sentence says the human is the operator and that this holds for **nation 0 only**.

If the order is not adopted, or the owner's ballot was refused or was not for the adopted option, the sentence is not used. The one Build of walls that makes the seat's village final is done by the run harness (the seat process), not by the owner; this is disclosed in `PUB/seat/live.json` and in the guide. Nothing about a strike's military result is claimed unless the page's Result panel shows it.

## 2. The command

Preconditions (the same as every run; the guards refuse otherwise): the machine is free (no process on 41900-41999, no `wylls-ai-stack.lock` held, no other run), `frontier/ai-run` is clean under the guarded paths (commit first), no paid-API variable is set. The evidence runs hold the lock until they finish; do not start this one while they run.

```
cd /Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/ai-run
export FRONTIER_BIN=/private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/frontier/ai-build/target-run/release
export AI_MODEL=/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/data/models/gemma-4-26B-A4B-it-Q4_0.gguf
export AI_LLAMA_DIR=/opt/homebrew/Cellar/llama.cpp/0.5.0
# the pinned Gemma on 41901 (skip if the evidence workflow's llama-server is still up and healthy: the run script checks it against the commitments either way)
permutation-gateway/citizens/llama/start-pinned.sh ~/gemma-41901.log &      # then wait for http://127.0.0.1:41901/health
permutation-gateway/citizens/bin/ai-citizens-run.sh \
  --stack permutation-gateway/citizens/stack/ai-ab.toml \
  --citizens-config permutation-gateway/citizens/config/ab.json \
  --deck deck-2 --run-id ai-record-1 --seat-live --hold 7200
```

* `--deck deck-2`: 12 AI citizens (2 per nation) and the presenter seat (index 1012). `ai-ab.toml` names deck-2 by default; it is given explicitly here.
* `--seat-live` (new): the seat process runs `ab/seat.mjs --live 1`. No `--seat-script` (so the commitments carry no seat script and the roster says `scripted: false`), no `--ab`; the script refuses either together with `--seat-live`.
* `--hold 7200` (new): after the run is complete (publication, verify-minds, report) the stack and the citizens service stay up for at most 7200 s; `touch <AI_DIR>/state/hold.stop` (the path is printed) or Ctrl-C ends it. Without `--hold` the script stops everything when the run is complete, as before.
* The run id is used once (`ai-record-1`; `ai-record-2` for a repeat). The script writes and commits its RUNS.md line on `frontier/ai-run` (local) before genesis, like every run.
* `ai-ab.toml` gives bot_seed 33 and season 33 (the same world as the A/B rep 1 and the pilot `ai-pilot-A1`; the LLM makes the run itself non-deterministic).
* The environment of the evidence workflow is reused: the binaries in `FRONTIER_BIN` are the integrator's `target-run/release` build (RUNTREE-NOTES section 4; check that the directory exists on the day), `AI_MODEL` / `AI_LLAMA_DIR` are required because `ab.json` is not `smoke.json` (R9).
* Keep the Mac awake for the whole run (about 2 h 15 min; `caffeinate -i` in another terminal tab).

`--dry-run` against a clean checkout prints the plan (checked with this command in the test tree: `guards: PASS`, 12 AI citizens, `--bots 13`, `PLAN start seat: ... ab/seat.mjs --live 1 ...`, `PLAN print: ... record-info.mjs ...`, `PLAN hold: ... 7200 s`).

## 3. The geometry and why

`ai-ab.toml` + `ab.json` (the A/B geometry): 16 game hours at 10x (96 bells of play, a bell = 60 s of real time), council `period 24, offset 0, strike_lead 6`, deck-2, 120 script bots with `--follow-council`, drain 26 bells.

Council period k: `C0 = 24 k`; motions in bells C0..C0+2, **ballots in bells C0+3..C0+5**, close when C0+6 begins, strike bell `S = C0+12`, the order opens and the result is published at `S+2`.

| period | C0 | motion bells | ballot bells | close | strike S | opens S+2 | inside play (bell 96)? |
|---|---|---|---|---|---|---|---|
| 1 | 24 | 24-26 | 27-29 | 30 | 36 | 38 | yes, but the seat's village is not final yet (see below) |
| **2** | **48** | 48-50 | **51-53** | 54 | **60** | **62** | yes, 34 bells to spare |
| 3 (second chance) | 72 | 72-74 | 75-77 | 78 | 84 | 86 | yes, 10 bells to spare |
| 4 | 96 | | | | | | no: play ends at bell 96 |

Why this and not the others:

* **Seat eligibility.** A nation council runs only if every AI of the nation holds a final village at C0, and the eligible voters are the citizens with a final holding at C0. The seat's village is provisional; the seat process makes it final with one Build of walls (300 stone) once the program would take the flip. In the pilot `ai-pilot-A1` (same geometry) the walls were sent at bell 34 and the village was final at bell 35, so **period 1 (C0 24) is not votable for nation 0 and period 2 (C0 48) is the first**; the council opened for all six nations at bell 49.
* **14 game hours (the smoke geometry, 84 bells)** has period 2 inside play but period 3's strike bell (84) is the first drain bell, so it leaves no second chance (integ-B-NOTES 13.1, RUNTREE-NOTES 14.2); 16 hours gives one.
* **The main geometry** (`main.json`, period 48, offset 12: C0 60, 108, ...) is a 3-game-day run (7 h) and is not used here.
* **Pilot geometry** (`ai-pilot.toml`, 24 hours) would add periods 4 and 5 but costs 40 more minutes of play for nothing the owner can use.

### Timeline (minutes after the script was started, T0)

Measured on `ai-pilot-A1` (same stack and config; the minds files `pub/minds/<b>.json` close at T0 + 2.8 + b minutes; genesis was 1 min 49 s after T0): bell b begins at about **T0 + 1.8 + b** minutes. At 10x a bell is 60 s of wall time. These are estimates (about plus or minus 2 min); the page's bell chip and the terminal's `[seat]` lines are exact.

| bell | about T0 + min | what happens |
|---|---|---|
| (script start) | 0 | guards, llama check, commitments, RUNS.md line, stack up (about 1 min) |
| 0 | 2 | genesis; the fleet exports the seat key at about T0 + 1 min, the seat process writes `keys/presenter-key.json` seconds later |
| 24 | 26 | period 1: no council for nation 0 (the seat's village is provisional; in the pilot all six nations were skipped, `not_all_final`) |
| 35 | 37 | the seat's village is final (pilot; depends on the 300 stone) |
| 48 | 50 | C0 of period 2. **Be at the keyboard from about T0 + 47 min** |
| 49 | 51 | the council of nation 0 opens on the page (the watcher opens at C0 + 1); motion window until the end of bell 50 (AIs move an option, with a speech) |
| 51 | 53 | **ballot window opens** (bells 51, 52, 53); the AIs ballot around bell 51-52 |
| 54 | 56 | close: adopted or not; the council file shows the tally split; nation 0's armies may follow from here (bells 54-59) |
| 60 | 62 | the strike bell |
| 62 to 63 | 64 to 65 | the Strike Order opens, the Result panel appears (pilot: council file rewritten when bell 62 closed) |
| 72 to 87 | 74 to 89 | second chance: period 3 (ballot bells 75-77, about T0 + 77 to 80; result about T0 + 89) |
| 96 | 98 | end of play; then the drain, publication, verify-minds (M9 re-sends to the llama server), report: about 10 to 15 min |
| complete | about 110 to 115 | with `--hold`: stack and page stay up (nothing new is played) until the stop file, Ctrl-C or the time is up |

During play the terminal prints, as `[seat]` lines with a clock time, when the council of nation 0 opens, when the ballot window opens ("BALLOT WINDOW OPEN ... the presenter votes on the council page now"), and how it closed (adopted with the strike bell, or the reason). If the seat's village is not final when the council opens, the line carries a `WARNING ... would be refused NotEligible`; if the seat process dies the script prints a warning.

## 4. What is printed, and where

When the services are up the script prints (`bin/record-info.mjs`): the council page `http://127.0.0.1:41902/council.html?recorded=<date>` (the date feeds the banner "recorded <date>"), the map `http://127.0.0.1:41902/frontier/frontier/spectate.html?art=1`, the presenter key file `<AI_DIR>/keys/presenter-key.json` with `pbcopy < <file>`, the council timeline of periods 1 to 3 in bells and minutes after genesis, what not to do, and how to stop. After the run is complete (with `--hold`) it prints the page, the key file and the stop file again, and a reminder every 10 minutes.

`AI_DIR` = `<repo>/.local/frontier/ai/ai-record-1/`: `pub/` (served as `/h/ai/*`), `state/` (private), `keys/` (mode 700; `seat.txt` and `presenter-key.json`), `logs/` (`seat.log` is the source of the `[seat]` lines).

## 5. The seat key and what the page takes

`frontier-bots --export-seat-key` writes `keys/seat.txt` = `{index, wallet, wallet_keypair_b58, session, session_keypair_b58}`. The council page (`council/keys.mjs parseKeyText`) accepts it as is (JSON with `session_keypair_b58`, checked against `session`), reads the 32-byte session seed and discards the rest, so **no change was needed on the page side**. But pasting that file would put the WALLET secret into the textarea for a moment, and the file is multi-line. The seat process therefore also writes **`keys/presenter-key.json`** (mode 600): one line, exactly `{wallet, session, session_keypair_b58}` (no wallet secret). The owner copies it with `pbcopy < <file>` (nothing appears on screen), pastes it into "Presenter key" and presses "Use this key"; the page clears the box at once and keeps the key in memory only (a reload forgets it). Test: the page's own `parseKeyText` and `makeSigner` read the file, sign a ballot with web/session.mjs Ed25519, and the real social service accepts it.

The page needs WebCrypto Ed25519: Chrome or Edge 137+, Firefox 129+, Safari 17+ (the page says so itself otherwise).

## 6. What changed in the code (AI-owned paths only)

| file | change |
|---|---|
| `citizens/ab/seat.mjs` | `--live 1` mode: `runSeatLive` (finaliser only; no `postJson` parameter, so it cannot post a ballot or a message; prints the council status lines with clock times and schedule estimates; refuses a roster that marks the seat scripted), `createSeatFinaliser({mode: 'live'})` (same single Build of walls, state `scripted: false`, line prefix "live seat (run harness): finalising its village"), `writePresenterKey`, `liveRecordOf` (`PUB/seat/live.json`: `scripted: false, casts_ballots: false, origin 0`, no option), `councilSchedule`, `scheduleLines`; the log is `AI_DIR/seat/seat-live-log.json`. The scripted and A/B modes are untouched (their tests pass unchanged). |
| `citizens/bin/ai-citizens-run.sh` | `--seat-live` (starts the seat with `--live 1`; refused with `--ab` or `--seat-script`), `--hold SECS` (`hold_run`: stack and service stay up after completion until SECS pass, `<AI_DIR>/state/hold.stop` appears, or a process dies; Ctrl-C works), the `[seat]` lines and a dead-seat warning in the terminal, the info block, `PLAN` lines in the dry run. Without the new flags nothing changes. |
| `citizens/bin/record-info.mjs` (new) | prints the info block (text only). |
| `citizens/report.mjs` | reads `seat-live-log.json` and prints "Live seat (run harness; the presenter votes on the page), finalising its village ..." instead of "Scripted seat ...". |
| tests | `test/citizens-seat-live.test.mjs` (12), `test/citizens-seat-live-run.test.mjs` (6), `test/citizens-seat-live-chain.test.mjs` (2). |

No page file, no contract text, no never-edit file (program, herald, agents, session.mjs, the design session's web files) was touched. The roster flag needed no change: `scripted` is `seat_script_sha256 !== null`, which a run without `--seat-script` has `null`, so the roster says `scripted: false`, the page badges the seat "presenter seat (human operator)" (not the dashed "scripted for the A/B test" badge) and `verify-minds` M1's `seat_scripted_flag` holds.

## 7. What the tests show, and what they do not

(See section 9 for the real commands and results.) In process, with the REAL social service, census, owners index, council job, finaliser and the page's own key, ballot and render modules:

* **Old setup** (no seat process): the seat's village stays provisional and the presenter's page ballot is refused `NotEligible`.
* **Live seat**: one Build of walls at the first bell the program would take the flip (never before); the seat is on the council's eligible list at C0; `ballots_cast` is 1 (the AI) and nothing was posted by the seat; the presenter's ballot signed with `presenter-key.json` through the page's `castBallot` is accepted, counted as `human` (origin 0), `tally_split {ai 1, human 1, scripted 0}`, adopted (the human-present rule is satisfied by it); the page text reads "Ballots by who cast them: AI 1 · human (the presenter) 1 · scripted seat 0", "Strike Order adopted with 1 AI ballot(s) + the presenter's ballot — strike at bell 60 (target sealed)", and the pivotal verdict is "Yes ... (yours was the only human or scripted-seat ballot for it ...)"; the chronicle phrase is "with 1 AI ballot and the presenter's ballot". Without the presenter's ballot the AI's single ballot is below the quorum: not adopted.
* **Process level** (`citizens-seat-live-chain`): the real Frontier relay over a scripted chain and a herald double: the live seat process sends one Build of walls, writes the presenter key (three fields, no wallet secret), prints the labelled lines, posts nothing to a recording social double, ends on the stop file.
* **Run script**: dry-run plan, flag conflicts, the hold loop (the script's own function run with stubs: SECS, stop file, a dead process, a leftover stop file).

Not shown (not run, by instruction, while the evidence workflow holds the machine): a live stack with this flag, a real browser pasting the key (the page's modules are exercised under node with a fake DOM; the QuickTime recording and the browser's Ed25519 support are the owner's check on the day), a real llama, a real program flip (read, not run: integ-B-NOTES 12), and whether the AI hosts of nation 0 are ready to follow the order (the evidence workflow's follow fixes are in `b89b437`; the result of a strike is whatever the run produces).

## 8. Open points

1. **The follow path.** The Strike Order moves armies only if invited AI or script-bot hosts of nation 0 are ready in bells 54-59; in the pilot period 2 `present: 0`. The recording uses the newest `frontier/ai-run` (the pilot fixes are in). The footage and the pitch say what the Result panel shows, nothing more.
2. **First-load quirk** (RUNTREE-NOTES 13.4, cause not found): the page can say "No council this period" for nation 0 until the nation tab is clicked. The guide says to click the Aster tab.
3. **The seat's flip time** (bell 35 in the pilot) is one measurement; if the 300 stone arrive later than C0 the terminal warns and period 3 is the chance.
4. **Whether the AI ballots the option the owner picks.** AI ballots are hidden; AI motions are public. The owner's choice is his own; voting for an option an AI moved is the likeliest to be adopted but is not guaranteed (two ballots for the leading option are needed). Adoption is not scripted.
5. The page keeps the key in memory only; a reload needs it pasted again (off camera).
6. Beat 1 (an AI's own march) comes from the main run (contract 9.4.1); this run is beat 2. If a model march with a clash occurs in this run it may be used, captioned as from this run.

## 9. Gate (this change, code commit `5eacc8c` on `frontier/ai-run`; every command and real result)

| Command | Result |
|---|---|
| `cd permutation-gateway && nice -n 5 npm test` in the run tree after the change landed | **1645 tests, 1645 pass, 0 fail, 0 skipped**, 49 s (1625 before; 20 new). A first run in the scratch copy used for development had one failure, `web-frontier-relay.test.mjs` "program refusals come back by name and number ..." ("Duplicate this exact transaction was relayed already"): not an AI file, not edited, 3 of 3 passes when run alone and a full pass in the two later runs; not investigated. |
| `node --test test/citizens-seat-live.test.mjs` | 12 of 12 pass |
| `node --test test/citizens-seat-live-run.test.mjs` | 6 of 6 pass |
| `node --test test/citizens-seat-live-chain.test.mjs` | 2 of 2 pass |
| the same three files on the OLD code (`b89b437` tree, only the test files copied in, plus a one-line stub for the missing `bin/record-info.mjs` so the file loads) | `citizens-seat-live`: 11 of 12 FAIL (the one that passes is the first, which reproduces the finding with the old setup: no seat process, the presenter's page ballot is refused `NotEligible`); `citizens-seat-live-run`: 6 of 6 FAIL; `citizens-seat-live-chain`: 2 of 2 FAIL |
| the earlier seat and run tests, unchanged: `citizens-run-check`, `citizens-seatfix`, `citizens-seatfix2`, `citizens-seatfix2-chain`, `citizens-seatfix2-review`, `citizens-ab`, `citizens-seat-script`, `citizens-page-council` | 111 of 111 pass |
| `ai-citizens-run.sh --stack citizens/stack/ai-ab.toml --citizens-config citizens/config/ab.json --deck deck-2 --run-id ai-record-1 --seat-live --hold 7200 --dry-run` (with the three environment variables of section 2), in the run tree | `guards: PASS`; `run ai-record-1: stack ai-ab base 41900 (herald 41940, rpc 41910), 12 AI citizens + the presenter seat (deck-2), bot seed 33, season 33`; `PLAN start seat: node .../ab/seat.mjs --live 1 --ai-dir .../ai-record-1 --herald http://127.0.0.1:41940 --social http://127.0.0.1:41981 --relay http://127.0.0.1:41933 --key-file .../keys/seat.txt ...`; `PLAN print: ... record-info.mjs ...`; `PLAN hold: ... at most 7200 s ...`; `dry run: nothing was started or written` |
| `node citizens/bin/record-info.mjs --config citizens/config/ab.json ...` | prints the info block of section 4 (period 2: C0 48, ballot bells 51-53, strike 60, opens 62) |
| Rust (`cargo test`, `fmt`, `clippy`) | not run: no Rust file was touched |

Not run, by instruction (the evidence workflow holds the machine and the stack lock): any stack, herald, llama-server, run script start or process on 41900-41999. Everything the tests started in process (fake servers on `127.0.0.1:0`, child `node` processes of the seat and `record-info`) ended with the tests; nothing needed stopping. The change was developed in a scratch git worktree (removed afterwards) so that no file under the guarded paths was uncommitted while the evidence runs could start, and landed as one fast-forward commit; the running run script of the pilot was never edited in place.

## 10. Rollback

`git revert 5eacc8c` removes the live seat; the A/B, the scripted seat and every other run are unaffected by it (no flag, no behaviour of theirs was changed: the scripted finaliser state and lines are byte-identical, and `--seat-live` / `--hold` default off).
