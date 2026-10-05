# A/B result (contract 9.3, gate G7): NOT RUN. No pair exists.

Local test chain only (no devnet, no mainnet, no paid API). Written 2026-10-06 00:35 JST on `frontier/ai-run` at code commit `5c39263`. Every statement below is from a file or a command named here; what was not run says "not run".

## 0. The answer first

1. **The pilot did not pass** (`runs/PILOT-RESULTS.md`, run `ai-pilot-A1`): a Strike Order was adopted in nation 0, but 0 invited hosts left, and verify-minds failed on M8 and M11. Fixes were committed and unit-tested, but they were never shown in a live run.
2. **None of the four A/B runs (rep 1 and rep 2, arms A and B) was made.** The owner's HOLD file (`scratchpad/HOLD`, created 2026-10-05 12:02 JST: "Do not start any new live run until this file is removed") was present for the whole of this task's 6-hour wait (my first check 18:30, last check 00:31 JST, a re-check every 2 minutes; `scratchpad/ab-wait.log` has 180 checks, all "hold present"). The pilot task had waited 12:27 to 18:28 on the same file. The file was therefore present at every check from 12:02 on 2026-10-05 to 00:31 on 2026-10-06, about 12.5 hours, and rule 6 allows no start while it exists. I started no Gemma, no stack and no run. The 6-hour limit has now ended, so this task stops here.
3. **G7 is not met and not evaluated.** There is no pair, no `options_hash` comparison, no pass rule result, and no reduced claim. The pre-registered outcome for "no valid pair" is "not met" (contract 9.3, `abOutcome`); because it is not run rather than run-and-failed, this document says "not run" and does not report a failed pair. **The A/B claim of contract 12.2 cannot be made.** Per section 11.8 the A/B is the item that goes at level 2; the claims sheet then drops "In an A/B test ... only the run in which the council adopted the AI's proposal produced the march and the clash".
4. **What the one pilot run does support** (n = 1, arm-A-like, not a pair): "a Strike Order adopted in nation 0 with a scripted seat ballot (origin 2) and 2 AI ballots; no nation-0 host followed it". That is a statement about one run's council, not an effect and not a comparison.

## 1. Table of every run

| run id | arm | rep | status | code commit | what it is | result |
|---|---|---|---|---|---|---|
| `ai-ab-A-1` | A | 1 | **not run** (HOLD) | `5c39263` planned | `ai-ab.toml` (16 game hours), bot_seed 33, deck-2, `ab.json`, seat ballots X at C0 + 4 | none |
| `ai-ab-B-1` | B | 1 | **not run** (HOLD; needs arm A rep 1's PUB first) | `5c39263` planned | same, seat ballots `none`, arm A's council answers replayed through the loopback proxy on 41990 | none |
| `ai-ab-A-2` | A | 2 | **not run** (HOLD) | `5c39263` planned | bot_seed 34 | none |
| `ai-ab-B-2` | B | 2 | **not run** (HOLD) | `5c39263` planned | bot_seed 34, replay of `ai-ab-A-2` | none |
| rep 3 | A, B | 3 | not planned (the contract reaches rep 3 only if rep 1 and 2 do not give 2 valid pairs) | | | |
| `ai-pilot-A1` (reference, **not part of any pair**) | A | 1 | complete, verify-minds **FAIL** (M8, M11) | `89cfd5b` | the pilot: `ai-pilot.toml` (24 game hours, not the A/B's 16), bot_seed 33, deck-2, real Gemma, 12 AIs, 120 script bots, 09:31 to 12:12 JST 2026-10-05 | nation 0 period 2: option 1 (camp (1,1)) adopted, tally AI 2 + scripted seat 1, strike bell 60, `options_hash` `1a830cba...`; invited hosts 4 (all AI hosts), ready at C0 + 6: 4, **departed 0**; source `runs/PILOT-RESULTS.md` sections 0 to 3, `runs/ai-pilot-A1/pilot-run1.json` |

Pair table (the table `run-ab.mjs result` prints): **0 pairs, 0 valid, 0 invalid, 0 passed.** Pair validity by `options_hash`: not evaluated. Pass rule: not evaluated. The only `options_hash` known is the pilot's (`1a830cba...`), and it belongs to a 24-hour configuration, so it says nothing about whether the A/B's own reps will agree between arms.

## 2. Could the A/B still be run validly? My decision from the evidence

This is the question I was asked to decide before running. I did not skip the runs for this reason (the HOLD file did), but the evidence says the following, and the next person should use it.

**What can be valid.** Pair validity (9.3) asks only that both arms have equal `options_hash` for the period, the same AI motion option and AI ballot options, and that the seat is pivotal in arm B (the tally does not adopt X without the seat's ballot). The pilot shows that nation 0's AIs can produce an option, a motion and ballots (4 of 4 periods with options had an AI motion; period 2 had both nation-0 AIs on the winning option, so the seat was pivotal). None of that depends on whether hosts follow. So a pair can be valid in the contract's sense. Whether it is valid is an outcome of the runs and cannot be predicted from one pilot (the model is not deterministic across runs, script-bot timing differs, and arm B's replay proxy has never run live: `AC9-NOTES.md` sections 7 and 8, "the A/B arms ... not run", the seat's clash observation path "unproven live").

**What cannot pass as pre-registered.** The pass rule needs "at least T hosts of nation 0 present at X at S" in arm A. The pre-registered formula (9.3) gives `T = min(3, ready invited hosts at C0 + 6)`, never below 2; the pilot saw 4 ready, so **T = 3**. The pilot's reading (`PILOT-RESULTS.md` section 4) is that at most 2 hosts of nation 0 can reach the target in this configuration: a bot follows a Call at most once (6.6), the invited hosts were all held by the two nation-0 AIs, and no script bot of nation 0 held an invited host. If that holds in the reps, **G7 cannot pass at T = 3 whatever the AIs choose**. I did not change the formula and I did not append a T line to `RUNS.md` (the contract says T is written there before rep 1, and no rep 1 was started). `node permutation-gateway/citizens/ab/run-ab.mjs threshold --ready 4 --followers 2` prints `T: 3`, `bots_that_can_follow: 2`, `T_attainable: false` (the pilot's notes; I did not rerun it in this task).

**Decision needed from the owner before the runs, not from the runs:** (a) keep T = 3 (then G7 is "not met" by construction and the runs would only report counts); (b) T = 2, counting followers, which is inside the contract's "never below 2" but a reading the pre-registration did not state; (c) a follow rule that lets one AI send two invited hosts (a change of 6.6 and the V3 caps in the AI line's own files, `bots/src/ai/**`; the program and the base game stay unchanged, as the owner decided). My recommendation, as a recommendation and not a decision: run the A/B only after (b) or (c) is written into `RUNS.md` before rep 1, and report any pass at T = 2 as "T = 2, set by the owner after the pilot saw at most 2 followers", never as a pass at the original formula.

**Do not run reps 1 and 2 as a blind sequence.** Arm A rep 1 is also the first live test of the pilot's fixes (early Call sealing, the informed-hold rule, the M8 item fix, the M11 window fix). So the order should be: run arm A rep 1, read it with `ab/pilot.mjs` before the stack is torn down, and check verify-minds M8 and M11. If A1 again shows 0 departures or a verify-minds FAIL, stop and fix (at most two iterations per phase) before spending arm B and rep 2. If A1 shows at least 2 hosts present at the strike bell, the rest of the plan is reasonable.

**Time.** The pilot's 24 game hours took 2 h 41 min (09:31 to 12:12). A 16-game-hour run should take about 1.9 h including start-up and the drain, so four runs are about 7.5 to 8 hours of the Mac, one at a time, with the shared stack lock and Gemma alone on 41901. This is my estimate from one run, not a measurement.

## 3. Recipe for the later run (nothing here was executed in this task)

Environment (RUNTREE-NOTES section 4): `FRONTIER_BIN=<scratchpad>/frontier/ai-build/target-run/release`, `AI_MODEL=<the Gemma 4 26B A4B Q4_0 gguf>`, `AI_LLAMA_DIR=/opt/homebrew/Cellar/llama.cpp/0.5.0`; Gemma through `citizens/llama/start-pinned.sh` on 41901 (**an owner's llama-server, pid 52029 started 2026-10-05 12:55, was still listening on 41901 at 00:31; it is not mine and was not touched, so a later run must either reuse it deliberately or have the owner stop it**). Then, one at a time and each only after the HOLD check:

```
node permutation-gateway/citizens/ab/run-ab.mjs run --arm A --rep 1      # run id ai-ab-A-1, bot_seed 33
node permutation-gateway/citizens/ab/run-ab.mjs run --arm B --rep 1      # run id ai-ab-B-1, replays ai-ab-A-1's council answers
node permutation-gateway/citizens/ab/run-ab.mjs analyze --rep 1 --a .local/frontier/ai/ai-ab-A-1 --b .local/frontier/ai/ai-ab-B-1 --t <T> --out <pair-1.json>
(the same for rep 2, bot_seed 34)
node permutation-gateway/citizens/ab/run-ab.mjs result --pairs <pair-1.json>,<pair-2.json> --t <T> --runs docs/frontier/ai-citizens/RUNS.md --out docs/frontier/ai-citizens/AB-RESULT.md
```

After each run: all seven verify-minds checks, anchors against closed bells, `report.mjs`, the `RUNS.md` END line committed, everything stopped, no listener on 41900 to 41999, lock released. `run-ab.mjs plan --rep 1` (run now, it starts nothing) prints the same commands with the full paths: arm A uses `stack/ai-ab.toml`, `config/ab.json`, `--seat-script ab/seat.mjs`; arm B uses `.local/frontier/ai/ab-config/ab-B-1.json` behind the proxy on 41990.

## 4. What an A/B result would and would not show, once it exists

* It would show, for one rep, whether a Strike Order adopted **with an operator-scripted seat ballot (origin 2)** in nation 0 was followed by nation-0 hosts and produced a clash at X at S, and whether the arm without the seat's ballot did not. The seat is scripted: the word "human" is not used for it, and the evidence is never "humans and AI decide together" (9.2). Nation 0 only.
* n is at most 2 pairs of runs, with a model that is not deterministic and script bots that act on their own timing. It is a pre-registered demonstration, not a rate, and not evidence of strength. Arm B replays arm A's AI council answers, so those arm B records are not model calls and are not an audit claim (the count `council_replayed` goes beside the table). Memory differs between arms in ways the runs do not control.
* It would not show that the model wants anything, that the council has any power over an individual AI's own march, or that anything is enforced by the chain.

## 5. What was done in this task

| step | result |
|---|---|
| Read contract 9.3, 9.4, 10.2, 11.7, 11.9, 12.2, `PILOT-RESULTS.md`, `AC9-NOTES.md`, `run-ab.mjs`, `ai-ab.toml`, `ab.json` | done |
| Check the HOLD file before any live run | present at 18:30; polled every 2 minutes until 00:31 (the 6 hours of rule 6); still present at 00:31 |
| Run arm A and B of reps 1 and 2 | **not run** |
| Evaluate with the harness (`analyze`, `result`) | **not run** (no run directories exist) |
| `run-ab.mjs plan --rep 1` | run; printed the two arm commands; started nothing |
| Anything started | nothing: no Gemma, no stack, no proxy, no run; no port opened. The listeners on 41901 (owner's llama-server, pid 52029) and the owner's earlier run `ai-record-3` (RUNS.md: 17:48 to 21:42 JST, `verify-minds PASS`, held up 7200 s) are not mine |
| Code or `RUNS.md` changes | none. `RUNS.md` showed an uncommitted modification at the start of my check (the END line of the owner's `ai-record-3`); it is not mine and is not committed here. No T line was appended |
| Push | none |

## 6. Open points for the owner

1. **Remove the HOLD file** (or say when) and decide T (section 2: keep 3, count followers as 2, or change the follow rule).
2. Stop the owner's llama-server (pid 52029) or say it may be reused, so that the pinned Gemma can start on 41901.
3. The pilot's G1 was 88.7 % (236 of 266, `PILOT-RESULTS.md` section 7, point 3) and its cause is not investigated. This matters for the main run, not for G7.
4. The pilot's fixes are unit-tested and not live-tested. Arm A rep 1 would be their first live test.
