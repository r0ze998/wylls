# Main run result (contract 11.7, gates G1 to G3, G12 to G15): NOT RUN. No main-run evidence exists.

Local test chain only (no devnet, no paid API). Written 2026-10-06 06:40 JST on `frontier/ai-run` (code commit `1079966`, which adds only documents to `5c39263`). Every statement is from a file or a command named here; what was not run says "not run".

## 0. The answer first

1. **The main run (`ai-main`: `ai-citizens.toml` + `main.json`, 18 AIs, deck-3, 3 game days at 10x) was not started.** The owner's HOLD file (`scratchpad/HOLD`, created 2026-10-05 12:02 JST, text: "Do not start any new live run until this file is removed") stood at every check from 2026-10-06 00:33 to 06:33 JST: 180 checks every 2 minutes (`scratchpad/main-wait.log`), the full 6-hour wait of rule 6. A stack was not started, nor Gemma, nor any proxy. I did not remove the file: it is the owner's.
2. **So there are no numbers.** Not run: model latency percentiles (G3), dropped-for-time share (G2), valid rate (G1), by:model share, model marches and Y (G12), memory citations by decision kind and by episode kind (G13 to G15), councils and Strike Orders, verify-minds M1 M2 M3 M7 M8 M9 M11, anchors against closed bells, the hourly Mac load of a run. Nothing in this file may be quoted as a result of the main run. No 2-day degradation run was made either (contract 11.7 allows it only as a reported degradation of a run that is made).
3. **The previous evidence stays what it was:** smoke-r4 (6 AIs, 14 game hours) passed all seven verify-minds checks; the A/B pilot `ai-pilot-A1` (12 AIs, 24 game hours) failed M8 and M11, and its fixes are unit-tested but not shown live (`runs/PILOT-RESULTS.md`, `runs/../RUNTREE-NOTES.md` section 13, `runs/AB-RESULT.md`). The 18-AI, 3-day configuration has never run live in this tree; its first live use is this run.

## 1. What was done (every command and its real result)

| Step | Result |
|---|---|
| Tree state: `frontier/ai-run` at `1079966`; HOLD file present; no listener on 41900-41999 except the owner's llama-server (pid 52029, port 41901, started 2026-10-05 12:55, idle, `-np 1 -c 16384 -ngl 999 -fa on --jinja --reasoning off`); no stack lock file | as stated (checked 00:33 and again 06:34 JST; load average 3.0 at 06:34, 4.4 at 00:33) |
| `cd permutation-gateway && nice -n 10 npm test` | **1648 tests, 1648 pass, 0 fail**, 0 skipped (56 s). The unit gate of the tree the run would have used |
| `ai-citizens-run.sh --stack citizens/stack/ai-citizens.toml --citizens-config citizens/config/main.json --deck deck-3 --run-id ai-main --seat-script <ai-run>/permutation-gateway/citizens/ab/seat.mjs --dry-run` (with `FRONTIER_BIN`, `AI_MODEL`, `AI_LLAMA_DIR=/opt/homebrew/Cellar/llama.cpp/0.5.0`) | `guards: PASS`; printed the plan and started nothing ("dry run: nothing was started or written"): base 41900, herald 41940, rpc 41910, 18 AI citizens + the presenter seat, bot seed 31, season 31, fleet `--bots 19 --days 3 --scale 10 --follow-council`, scripted seat (`--seat-script`, council script, no `--arm`) |
| Wait for the HOLD file (rule 6), polled every 120 s | 180 checks, 00:33 to 06:33 JST, all "hold present"; the 6-hour limit was reached |
| Live run, hourly load, latency, report, verify-minds, anchors | **not run** |
| Stack, Gemma, census, seat, proxies started by me | none; nothing to stop |

## 2. The command that is ready (nothing in it was run)

```
export FRONTIER_BIN=<scratchpad>/frontier/ai-build/target-run/release
export AI_MODEL=<repo>/.claude/data/models/gemma-4-26B-A4B-it-Q4_0.gguf AI_LLAMA_DIR=/opt/homebrew/Cellar/llama.cpp/0.5.0
# Gemma on 41901: either the owner's running llama-server (pid 52029, if bin/llama-check.mjs passes against the commitments and the owner agrees)
# or: LLAMA_SERVER=/opt/homebrew/Cellar/llama.cpp/0.5.0/bin/llama-server nice -n 5 sh permutation-gateway/citizens/llama/start-pinned.sh <log> &
nice -n 5 bash permutation-gateway/citizens/bin/ai-citizens-run.sh --stack permutation-gateway/citizens/stack/ai-citizens.toml \
  --citizens-config permutation-gateway/citizens/config/main.json --deck deck-3 --run-id ai-main \
  --seat-script permutation-gateway/citizens/ab/seat.mjs
```

Expected duration: 3 game days = 432 bells of play at 10x = 7.2 h, plus preseason and a 26-bell drain at 20x (about 13 min): about 8 h in all (arithmetic on `ai-citizens.toml`, not measured). Council periods: 48 bells, offset 12, strike lead 6 (`main.json`), so C0 at bells 12, 60, 108 and so on; the scripted seat finalises its village by a Build of walls (300 stone), as in smoke-r4 and the pilot. Any Strike Order adopted there is "a scripted seat vote plus AI votes", never "humans and AI decided together".

## 3. Open points for the owner

1. **Remove the HOLD file (or say when)**; the main run needs the Mac for about 8 hours and the A/B for about 8 more. Which of the two goes first is the owner's choice: the A/B (T not yet decided) or the main run (needs no T). The pilot's fixes (early Call sealing, informed-hold rule, M8, M11) have not been shown live, so either run is also their first live test.
2. **The owner's llama-server (pid 52029, port 41901)** is still up. A run needs it stopped or reused deliberately; `start-pinned.sh` cannot bind 41901 while it lives. I left it alone.
3. **RUNS.md** carries an uncommitted line (the END line of the owner's `ai-record-3`). The run script commits RUNS.md with its own line, so that line would be swept into the next run's commit; I did not commit it.
4. Open from before and unchanged: G1 in the pilot was 88.7 % (236 of 266) and the cause is not investigated; this matters most for a main run, whose G1 needs n >= 300 and 95 %. The geometry hole and F for the 3-day config are arithmetic only (`integ-B-NOTES.md` 11): with the 20x drain the brain is silent about 780 s before the chain ends, but this has never been run for 3 days.
5. The claims sheet and the README must not quote a main-run result: the AI section's measured lines (valid rate, by:model share, Y, memory citations, councils) have no 18-AI, 3-day source until this run is made. The smoke-r4 numbers (n = 57 model decisions, 6 AIs, 14 game hours) are the largest live set so far and are small n.
