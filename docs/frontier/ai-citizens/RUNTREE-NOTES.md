# Run tree notes: `frontier/ai-run` (the unify tree with the AI citizens merged in)

Date: 2026-10-05. Local only: nothing was pushed, `frontier/unify` and `frontier/ai-integ` were not edited.

## 1. What this tree is

The owner asked that the screens shown during the AI runs use the LATEST web client (3D miniature units, canvas labels following the language switch, the diorama art with `?art=1`, nation-only join, the 国/村 wording). That client lives on `frontier/unify`; the AI code lives on `frontier/ai-integ`, cut from the older `30ba411`, whose web client and herald are old.

`frontier/ai-run` = `frontier/unify` (`ad1c919`) merged with `frontier/ai-integ` (contract 11.9, brought forward and kept local). Worktree: `/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/ai-run`. Later runs (A/B, main run, the recording) are to be made from this tree, so the evidence comes from the code that will be submitted.

## 2. The merge

| Commit | What |
|---|---|
| `ad1c919` | first parent: `frontier/unify` tip (the branch was created from it) |
| `c76b0f3` | `git merge --no-ff frontier/ai-integ` at `ba1c17d` ("Wylls AI run: smoke-b5 END") |
| `71ce29b` | re-merge of `frontier/ai-integ` at `7350146` (integ-B notes and shots; documents only), made at the end of this work |
| `c972887` | re-merge of `frontier/ai-integ` at `d6f2bc3` (integ-B: the seat ballot fix; code in `citizens/ab/seat.mjs`, `bin/ai-citizens-run.sh`, `mind/speech.mjs`, `verify-minds.mjs`, 4 test files; the contract header now names R12), made in review round 2 (section 9) |

Merge base of the two branches: `73408a5` (contract v1.2). Files changed on both sides since it: **two**, both documents.

| Conflict | Resolution |
|---|---|
| `docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md`, 3 hunks (the `clash_own_win`/`clash_own_loss`/`clash_own_fought` rows of 5.2, the M11 row of 7.3, the R12 row of 14.4) | the ai-integ side (the unify copy equals `19fe89c`, ai-integ has R12 and later); checked: the file is byte-equal to `frontier/ai-integ` after the resolution |
| `docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md` | no conflict: both sides carry the same change (the copy of `19fe89c`) |

No conflict in the four hook files, `Cargo.toml`, `Cargo.lock`, the herald or the web files: unify's only changes under `frontier-node` are two herald lines (`herald/src/server.rs`, `herald/tests/server.rs`) and, under `permutation-gateway`, `screens/interaction.screen.mjs`, `screens/logic.screen.mjs` and `test/web-frontier-hud.test.mjs`; ai-integ touches none of them. The 92 web files that unify changed are untouched by the merge (`git diff frontier/unify HEAD -- permutation-server/web` lists only the 19 AI council files, `council.html` and `council/**`, which unify does not have). `permutation-server/web/session.mjs` and the design web files are identical to `frontier/unify`.

`permutation-gateway/package.json` and the lockfile are the same on both sides, so the `node_modules` copied from the ai-integ worktree (`cp -c -R`, 59 entries) serves this tree; no package was installed and none is missing.

## 3. The gate in the merged tree (run on `c76b0f3`; the re-merge added documents only; the numbers of the final tree are in section 9.2)

| Command | Result |
|---|---|
| `cd permutation-gateway && npm test` | **1555 tests, 1554 pass, 1 FAIL**, 0 skipped, 51 s. The failure is test 881, `ai-hook-check.sh on this tree ...` in `test/citizens-run-check.test.mjs:445` (see 3.1). Every other test passes, including the web-lang completeness, council page and G10 outside-URL grep tests. |
| `cd frontier-node && cargo test -p bots -p agents -p herald -p stack --locked` (target-run) | exit 0; summed over the test binaries: 275 passed, 0 failed, 3 ignored |
| `cargo fmt --check` | exit 0, no output |
| `cargo clippy -p bots -p agents -p herald -- -D warnings` | exit 0 |
| `ai-hook-check.sh --blank-ok --exclude ad1c919d4d3b94eec8dc1d7df1e3a5c8f112f80d HEAD` | **PASS** (101 commits at `c76b0f3`, 103 at `71ce29b`; 282 MC files from 2 lists) |
| never-edit diff between the previous unify tip and the merge, `git diff --name-only ad1c919 c76b0f3` outside the AI directories | only the four hook files, `bots/Cargo.toml`, `frontier-node/Cargo.lock` and `.gitignore` (the integrator's files, contract 11.2); the hook files add 113 lines, no removed line |
| `ai-citizens-run.sh --check` and `--dry-run` with the smoke stack and `smoke.json`, `FRONTIER_BIN` as in section 4 | `guards: PASS`; the dry run printed the plan and wrote nothing (ports 41900-41999 were free, no lock held at that moment) |

### 3.1 The one failing test: NOT fixed, needs a decision

`ai-hook-check.sh` run without `--exclude` walks every commit since `30ba411`. In this tree that includes the unify session's own work (for example `5c111f4`, `fd3a815`: README, the unit art under `permutation-server/web/frontier/art/**`), which the check rightly calls never-edit or existing files. Contract 11.9 step 3 says the never-edit diff is taken between the previous unify tip and the merge commit. That is what `--exclude ad1c919...` does, and with it the check passes (above). The tree test, however, runs the check with no `--exclude`, so it fails here (and passes on `frontier/ai-integ`).

The minimal fix I prepared, and did **not** apply: add `permutation-gateway/citizens/bin/hook-check-exclude.txt` holding the unify tip `ad1c919d4d3b94eec8dc1d7df1e3a5c8f112f80d`, and let the test in `test/citizens-run-check.test.mjs` (AI-owned) pass `--exclude <id>` for every 40-hex line of that file that is a commit in the repository (nothing is excluded when the file is absent, so the ai-integ tree behaves as before). The permission layer of this session denied the edit as a "security test removal" (it loosens a guard test), so I stopped there instead of working around it. The owner decides whether this change is acceptable. Until then this tree has `npm test` 1554 of 1555.

## 4. Binaries and the environment the run script needs

Built in the merged tree: `CARGO_TARGET_DIR=<scratchpad>/frontier/ai-build/target-run` (APFS clone of `target-integ`), `nice -n 5 cargo build --release --locked --workspace -j 6`, 38 s, exit 0. Present in `target-run/release`: `frontier-stack`, `frontier-keeper`, `frontier-herald`, `frontier-localnet`, `frontier-bots`, `drand-replay` (plus `frontier-verify`, `frontier-viewers`).

The Solana program is unchanged (`git diff --stat 30ba411 frontier/unify -- permutation-frontier` and the same against `frontier/ai-integ` are both empty). `permutation-frontier/target/deploy-test-beacon/permutation_frontier.so` was copied from the m1-integ worktree (as in the integ-A notes); sha256 `b2cef4a7502a14cdb002dac984668422ad7bddf740df69a025979ffc8ddda4e7`, equal to the copies in the playtest and ai-integ worktrees. It is git-ignored build output. The stack config finds it by default at that path under `PSF_REPO`.

Environment for a run from this tree:

```
export FRONTIER_BIN=/private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/frontier/ai-build/target-run/release
# a non-smoke run also needs AI_MODEL (the gguf) and AI_LLAMA_DIR (the llama.cpp tree), contract v1.3 R9
cd /Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/ai-run
permutation-gateway/citizens/bin/ai-citizens-run.sh --stack permutation-gateway/citizens/stack/ai-smoke.toml --citizens-config permutation-gateway/citizens/config/smoke.json [--check | --dry-run]
```

`AI_REPO` defaults to the tree the script lives in (`ai-run`) and the script passes `PSF_REPO=$REPO` to `frontier-stack`; llama-server is started separately with `permutation-gateway/citizens/llama/start-pinned.sh` (model `.../.claude/data/models/gemma-4-26B-A4B-it-Q4_0.gguf`, port 41901). The run writes under `ai-run/.local/frontier/ai/<run id>/` and commits its RUNS.md lines on `frontier/ai-run` (local). The stack lock is one file under the git common directory (`/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.git/wylls-ai-stack.lock`), shared with the ai-integ worktree, so the two trees cannot run a stack at the same time.

## 5. The herald serves the latest client from this tree

`frontier-stack` builds the herald arguments in `frontier-node/crates/stack/src/up.rs` (line 658): `--web <resolve(repo, cfg.web_dir)>`. `web_dir` defaults to `permutation-server/web` (`config.rs:274`); none of the four AI stack configs (`ai-smoke.toml`, `ai-smoke-14h.toml`, `ai-ab.toml`, `ai-citizens.toml`) sets it. `repo` is `PSF_REPO`, which the run script sets to the tree it lives in. So the herald serves `/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/ai-run/permutation-server/web`. `permutation-server/web/frontier/people/minis.mjs` exists there (from `fd3a815`; it does not exist in the ai-integ worktree). Checked by reading the code and the files; **no stack was started**, so no served page was fetched or looked at.

## 6. Re-merging ai-integ later

`frontier/ai-integ` keeps receiving commits. In the ai-run worktree:

```
git merge --no-ff frontier/ai-integ -m "Wylls AI run tree: re-merge frontier/ai-integ (<tip>)"
permutation-gateway/citizens/bin/ai-hook-check.sh --blank-ok --exclude ad1c919d4d3b94eec8dc1d7df1e3a5c8f112f80d HEAD
```

then rebuild if Rust changed (`cargo build --release --locked --workspace` with the same `CARGO_TARGET_DIR`) and re-run the gate of section 3. When unify moves, merge it the same way and add its new tip to the exclude list. Conflicts are expected only in documents (the contract keeps the ai-integ side) and, when cq-integ's changes arrive, in the hook files, resolved as in integ-A-NOTES section 11. Do not push.

## 7. Open points

1. The failing tree test of 3.1 (decision needed).
2. (Superseded by sections 8 and 9: the live smokes smoke-r1 and smoke-r2 were run from this tree; the A/B runs were not.)
3. (Superseded by 9.2: the gate numbers of the final tree.)
4. Open after review round 2: the season-end race that failed verify-minds M3 in smoke-r2 (9.5), the herald `real_chain` test race (9.6), the highlights after the play phase (9.3), the design-session items of 9.3.

## 8. Live confirmation from this tree: smoke-r1 (2026-10-05)

Purpose: see the AI stack serve the LATEST web client from the run tree, with real Gemma.

| Item | Result |
|---|---|
| Wait for a free machine | at start nothing listened on 41900-41999, no llama-server ran (the only other processes were the paused m1-exit herald on 41040, untouched, and an `npm test` of the other workflow in the ai-integ worktree, which listens on nothing), the shared lock file was absent, and `RUNS.md` of ai-integ had the END line of smoke-b5. No wait was needed. |
| Re-merge of `frontier/ai-integ` | `git merge --no-ff frontier/ai-integ`: "Already up to date" (ai-integ was still at `7350146`, already merged). No unit tests were re-run for the merge; after adding the toml, `node --test test/citizens-run-check.test.mjs` gave 22 tests, 21 pass, 1 fail: the same known failure of 3.1 (`ai-hook-check.sh on this tree`), nothing new. |
| Stack config | new `permutation-gateway/citizens/stack/ai-smoke-6h.toml` (commit `7b727a7`): `ai-smoke.toml` with `game_hours = 6`. |
| Guards | `ai-citizens-run.sh --check` and `--dry-run` with `AI_MODEL` (the gguf), `AI_LLAMA_DIR=/opt/homebrew/Cellar/llama.cpp/0.5.0`, `FRONTIER_BIN=target-run/release`: `guards: PASS`. |
| Gemma | `citizens/llama/start-pinned.sh` (pid 82587), healthy at 00:44 JST; the run script's llama check: alias, n_ctx 16384, total_slots 1, build b11146-7fe450e19, 11 flags, model file and path, binary inside `AI_LLAMA_DIR`: all ok, "llama check: PASS". Stopped after the run. |
| Run | `ai-citizens-run.sh --stack citizens/stack/ai-smoke-6h.toml --citizens-config citizens/config/smoke.json --deck deck-1 --run-id smoke-r1`, started about 00:46 JST (RUNS.md 2026-10-04T15:44:42Z), END at 01:37 JST (end_unix 1791131823). Status `complete`: "stack complete, publication written (anchors: 61 anchored, 0 gap(s) of 61 closed bells); season-end bundle written; verify-minds PASS". Commits: `45c3a53` (RUNS.md entry), the END line committed after. The code commit in the commitments is `7b727a7`. The commitments are smoke-config but carry the measured model sha256 (d208665a...) and llama tree sha256 (eddbad45...); commit memo "audited". |
| Served from this tree | the herald process (pid 83790) ran with `--web /Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/ai-run/permutation-server/web`, i.e. this worktree; `GET 41902/frontier/frontier/spectate.html`, `.../frontier/frontier/` and `/council.html` returned 200 while the stack was up (this closes the "code reading only" caveat of section 5). |
| verify-minds (as the log prints it) | M1 PASS n=33; M2 PASS n=12; M3 PASS n=122 (bells 0-60, herald last closed bell 60, 61 anchor memos on chain); M7 PASS n=198; M8 PASS n=10; M9 PASS n=18 (18 of 18 equal on replay; llama /props n_ctx 16384, alias gemma-4-26b-a4b-it); M11 PASS n=192. Verdict PASS. Files: `.local/frontier/ai/smoke-r1/pub/verify-minds.json`, `logs/verify-minds.log`. |
| Decisions | report.md: 177 decision records, 12 model decisions (gate open; the council card's counter says "decisions 3 (valid 3)" per AI, 18 in all, because the mind's counter also counts the 6 reflections: 9.3), 12 of 12 valid, 0 fallbacks, 0 dropped for time; latency p50 2747 ms, p90 2925 ms (session); 6 reflections, 6 ok; by:model share 18.3 % (17 of 93 actions); GETs per step 4.94. |
| **Model march** | **none.** 0 model marches in this run (the report: "0 model marches sent"), so Y = 0 and no sealed or released march decision exists. The model's choices were build/train orders (c3, c5; bells 5 to 10), one scout order (c4, "explore", bell 29), muster orders (c3, c5, bells 30 to 34) and one "let the economy run" choice with no transaction (c1, AI 1003, bell 32); the one explore appears on the map as "Dato of Aster explores province 3,0" (corrected in review round 2: the first text left out the muster orders and c1). The 6-game-hour length is the likely reason (smoke-b5, 14 h, had 14 model marches; smoke-r2, 14 h, had 12: section 9.4); this is not proven for r1. |
| Memory | 0 of 12 model decisions cite memory; only `build_done` episodes existed (23); so no "Remembered" line with content was produced. The council page shows "Remembered (cited by the model): nothing cited". |
| Council / Strike Order | no council this period; the page says "No council this period". The reason "6 game hours do not reach the first council" was an inference, not a measurement: the council period is 24 with offset 0 (`commitments.json`), r1 played 36 bells and then drained with the fleet gone; in r2 the first councils have `c0 = 48` (none at `c0 = 24`), which is consistent with the inference (9.4), still not proven for r1. |

### 8.1 What the pages looked like (Playwright Chromium 1208 from ~/Library/Caches/ms-playwright, playwright 1.58.2 from the npx cache, 1280x800)

Screenshots (outside git, in /private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/video): `runtree-spectate.png`, `runtree-spectate-art.png`, `runtree-client.png`, `runtree-client-art.png`, `runtree-council.png`, plus `*-ja.png` for the language switch. I looked at each.

* **spectate.html** (taken after the intro dialog was dismissed with its button): realm view of the hex map: textured terrain (forest, plains, hills), six nation territories outlined, nation names as large canvas labels (Dunmar, Aster, Borealis, Cinder), the Concord in the middle, a minimap, layer chips (Realms, Military, Terrain, Settle), the "Nation standings" list with the people's portraits, bell clock "Bell N · mm:ss left", a Highlights list (in the English spectate capture at bell 51 it reads "No highlights yet": see 9.3, corrected). After the switch to Japanese the canvas labels and every panel switched (ダンマール, アステル, ボレアリス, シンダー, 大協約; "村 6 · 3 州"; "鐘 51 · 残り 3:17"), so the canvas labels follow the language switch.
* **spectate.html?art=1**: the same app zoomed to tile level with the diorama sprite art: dense painted forest, hills, mountains with snow, camps, village tents with a tower, white province borders. 252 art files were requested (fog, terrain, ...) against 115 without `?art=1`.
* **frontier/ (client)**: same map with the Join-side panel: "Not in a nation yet", "Guide 0/7: Welcome", "Connect a wallet / Dev Wallet (localnet)"; the intro dialog button reads "Enter the Frontier". In Japanese: "まだ国に加わっていません", "村", "国と村" in the guide steps: the nation-only join and the 国/村 wording are in the served client.
* **Military layer**: army chips "x1", "x2" per province at the whole-map zoom; at the zoom levels I reached I saw chips and village tokens, **not** the 3D miniature figures. The unit sheet `art/units/@1x/units_0.webp` and `@2x` (faction 0) were requested and served (200), so the miniature code ran, but no screenshot of mine shows a miniature figure. "3D miniatures appear" is therefore **not confirmed** by this run.
* **council.html**: header "Wylls · council, bell N", the banner "LOCAL TEST CHAIN · AI citizens are labelled · recorded 2026-10-04 · run smoke-r1" (the date is UTC), 6 AI citizens with "AI" badges and "by the model N %", a Wyll card (persona quote, trait chips, "Who acted", goals with progress bars, G1 50 % active at bell 53), the Decisions list ("Chose: c3 · goal G1", the AI's words, Said, "Remembered: nothing cited"), the nation council block, Departures and clashes.
* **Console and network** (the walkthrough part is unproven: its script printed errors to stdout and no log was kept; `shots-final.json` of the four client pages shows none; r2 keeps the lists, 9.4): no `pageerror` and no console error other than HTTP 404s. Every page logs `[lang] no English for: "Wylls"` (the client; a missing English key for the product name, harmless). With `?art=1` the client polls `/h/clash/P,Q/<bell>` for the three bells before each province's bell (preview code, `app.mjs` artClashOf) and the herald answers 404 when no clash happened: dozens of 404s, by design, not a mismatch. The council page 404s on `/h/ai/minds/<bell>.json`, `minds/late/<bell>.json`, `redactions.json`, `council/current.json`, `open/index.json` while those files do not exist (the known polling noise of integ-B-NOTES section 4). No missing field, no schema error between the client and the herald was seen.

### 8.2 Walkthrough video

`/private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/video/runtree-walkthrough.mp4`: H.264 1280x800, 71.8 s (ffprobe), no audio, no narration, recorded by Playwright recordVideo at bell 30 to 32. It shows: the art map with the Military layer, zoom in and out, the army chips on the whole map, the highlight click, Realms and Military toggles, the language switch to Japanese and back, then the council page (roster, three card clicks, the Decisions list with "Remembered: nothing cited", the council block). Frames extracted at 10 s, 30 s and 55 s (`runtree-walkthrough-f10.png`, `-f30.png`, `-f55.png`): f10 art map at village zoom with the Military layer on; f30 the whole map with the army chips and the nation labels; f55 the council page with the Decisions list. It does **not** show a released march decision (none existed) and no miniature figures were seen in it.

### 8.3 Everything started was stopped

The run script's trap stopped census, registrar-run and the citizens service and ran `frontier-stack down` (localnet, drand replay, relay, herald, keepers, bots); "lock released"; the llama-server (pid 82587) was killed by me; the Playwright browsers closed with their scripts. After the run: `lsof -iTCP:41900-41999 -sTCP:LISTEN` shows nothing, `pgrep llama-server` finds nothing, the lock file `outputs/.git/wylls-ai-stack.lock` is gone. The paused m1-exit stack and the design preview were not touched. Artifacts: `.local/frontier/ai/smoke-r1/` (git-ignored).

### 8.4 Not run / open

* A live model march, a released decision with Remembered lines and a council with a Strike Order were not produced by this 6-hour run; for those a longer run (the 14 h `ai-smoke-14h.toml`) is needed. (smoke-r2, 14 h, did produce model marches, released decisions with Remembered lines and councils: 9.4.)
* The 3D miniature figures were not seen in my captures. (Seen in smoke-r2: 9.4.)
* Gate numbers for the merged tree were not re-run after the toml (only the run-check test file); the failing tree test of 3.1 is unchanged and still needs a decision. (Gate re-run in 9.2.)

## 9. Review round 2 (2026-10-05): findings checked, fixes, smoke-r2

Two reviewers re-derived the smoke-r1 report. Every blocker and major was checked against code or artifacts; the minors were checked too. Nothing was pushed; `frontier/unify` and the ai-integ worktree were not edited (the ai-integ branch was only read and merged).

### 9.1 What changed in the tree

| Commit | What |
|---|---|
| `c972887` | `git merge --no-ff frontier/ai-integ` at `d6f2bc3` (the seat ballot fix). The finding "7 commits behind, and the lag includes code" was right (`git merge-base --is-ancestor frontier/ai-integ frontier/ai-run` was false); it is true now. No conflict. |
| `f2ad434` | the council page labels a reflection as a reflection (9.3), with a test. Files: `permutation-server/web/frontier/council/decisions.mjs`, `lang.mjs`, `lang.ja.json`, `permutation-gateway/test/citizens-page-decisions.test.mjs` (all in the AI directories of contract 0.2). **This change exists only on `frontier/ai-run`.** The ai-integ owner should take it too, or keep the ai-run side on the next re-merge of these files (they were not touched by ai-integ since `c7bd2f9`, so no conflict is expected). |
| `c13eb79`, `94d600b` | the run script's RUNS.md lines of smoke-r2 (start, END) |
| `91b1664` | the evidence of smoke-r2 under `docs/frontier/ai-citizens/runtree-r2/` (capture scripts, reports, the herald's process arguments, 9 stills) |

The ai-integ tip used for every smoke-r2 result below: **`d6f2bc3`** (code commit `f2ad434` in its commitments; the tree was clean at the start). At the end of this work ai-integ was still at `d6f2bc3` (`git merge-base --is-ancestor frontier/ai-integ HEAD` true).

### 9.2 Gate of the final tree (`91b1664`)

| Command | Result |
|---|---|
| `cd permutation-gateway && npm test` | **1571 tests, 1570 pass, 1 FAIL**, 0 skipped, 0 cancelled (50 s). The one failure is the known test of 3.1 (`ai-hook-check.sh on this tree`, no `--exclude`), unchanged; the new reflection test and the page-lang tests pass. I also ran the new test with the fix removed: it fails (`not ok 11`, 14 of 15 pass), with the fix 15 of 15 pass. |
| `ai-hook-check.sh --blank-ok --exclude ad1c919d4d3b94eec8dc1d7df1e3a5c8f112f80d HEAD` | **PASS** (120 commits since `30ba411`, 282 MC files from 2 lists) |
| `cargo test -p bots -p agents -p herald -p stack --locked -j 6` (target-run, `nice -n 5`) | exit 0; summed over the test binaries: 275 passed, 0 failed, 3 ignored. (No Rust file changed since `c76b0f3`: `git diff --stat c76b0f3 HEAD -- frontier-node` is empty; the release binaries of section 4 are the ones smoke-r2 used.) |
| `cargo fmt --check` | exit 0 |
| `cargo clippy -j 6 -p bots -p agents -p herald -- -D warnings` | finished with no warning in 0.29 s: a cached result for unchanged Rust, not a fresh compile |
| `sha256sum permutation-frontier/target/deploy-test-beacon/permutation_frontier.so` | `b2cef4a7502a14cdb002dac984668422ad7bddf740df69a025979ffc8ddda4e7`, equal to section 4 and to the runs' record |

The one failing test is still the owner's decision (3.1). Until then quote the unit gate as **1570 of 1571, with that one reason**. I did not edit the test.

### 9.3 The findings, one by one

| Finding | Verdict | What I did |
|---|---|---|
| ai-run is 7 commits behind ai-integ, including code (major) | **confirmed** | merged (9.1). `verify-minds` was re-run from the new tip by smoke-r2, and it **FAILED**: 9.5. |
| 3D miniature units not confirmed on the AI screens (major, both reviewers) | **confirmed for smoke-r1, now shown for smoke-r2** | 9.4. |
| Nation-only join not captured (major) | **confirmed for smoke-r1, now captured** | 9.4. |
| One failing unit test in the tree (minor) | confirmed, unchanged | the owner decides; quote 1570 of 1571. |
| Flaky `herald` test `real_chain` (minor) | **confirmed as a one-off; the cause is understood from the code, not reproduced** | 9.6. Not fixed (never-edit path). |
| Herald served the ai-run web directory; console noise (minor) | right; evidence now kept | `runtree-r2/process-evidence.txt`: herald pid 5267 `--web .../worktrees/ai-run/permutation-server/web`, cwd `.../ai-run/frontier-node/.local/frontier/smoke-r2/herald`, and the citizens service (node) with cwd the ai-run tree. The run script does not record it by itself; the capture is a manual step (suggestion for the script owner: add the same `ps -o args=` of the herald to the run directory). The `[lang] no English for "Wylls"` warning and the `?art=1` clash-probe 404s are the design session's files; not edited, and not re-measured in r2 (the r2 capture records page errors and non-404 console errors only: none, `logs: []` on every page). |
| Highlights described wrongly (minor) | **confirmed, my text was wrong** | In the English spectate capture at bell 51 (smoke-r1) the list read "No highlights yet". Cause, from the code: a fresh page reads the chronicle from `headSeq - 500` (`controller.mjs` `CHRONICLE_WINDOW`), and the list shows only DEPART, EXPLORE, SETTLE and CLASH records in that window. During play the list is full (r2: 12 entries at bell 72, `shots/highlights-play-bell72.jpg`, `capture-report-play-bell71.json`; 20 at bell 67 in an earlier capture whose report I did not keep); in the drain after the play phase it is empty (r2: 0 at bell 102, `shots/highlights-drain-bell102.jpg`; r1's bell 51 was in its drain). Same for the bell chips. So **a recording that is made after the play phase shows no highlights**; make it during play. This is the design session's behaviour, not edited. The sentence in 8.1 was corrected. |
| Council card says "decisions 3 (valid 3)" per AI, 18 in all, while the report says 12 (minor) | confirmed, explained | the card shows the mind's counter `decisions`, which counts the reflections too; the report's "model decisions" does not (r1: 12 session decisions plus 6 reflections = 18). Not changed; read the two figures as different counters. |
| Reflections are listed under Decisions as "Chose: no candidate named", "The model wrote no reason." (minor) | **confirmed and FIXED** (`f2ad434`) | a reflection has no candidates, no choice, no reason and cannot cite memory. The page now prints one line instead ("A reflection: the AI looked back over its recent episodes and goals. It chose no action here. Its summary, when the checker passes it, is on the card, marked as written by the model.", and the Japanese text); session, motion and ballot decisions print as before. Seen live in r2 (EN and JA council pages: `.reflection-body` elements present, no "no candidate named" under a reflection: `capture-report-*.json` `council`; `shots/council-en-decisions-reflections.jpg`, `council-ja-...`). Only the reflection kind was changed; I did not look at motion or ballot records for similar gaps. |
| Layout and language details (minor) | partly checked | (b) only some nations carry a canvas label: **by design**, `fmap.mjs` `paintRealmLabels` skips a nation holding fewer than 3 village-weights (`if (a.w < 3) return`): in r1 Ember and Fjordal held 1 to 2 villages. (c) "Dev Wallet (localnet)" stays English in the Japanese client: it is the wallet's own name constant (`wallet.mjs` `DEV_WALLET_NAME`), not a missing translation. (d) a Japanese council capture now exists (`shots/council-ja-decisions-reflections.jpg`). (a) the whole-map view off-centre with a label cut by the left panel in the Military layer after zooming out: **not re-checked**; it is in the design session's files. (e) the warning line: see above. (f) the intro button text: not needed, not captured. |
| Smaller imprecisions in the notes (minor) | 1 confirmed and corrected, 2 and 3 marked | (1) I verified in `pub/minds` of r1: bells 5 to 10 build+train (c3, c5), bell 29 explore (c4), bells 30 to 34 muster (c3, c5; c3 at 31 also harvest), and AI 1003 at bell 32 chose c1 ("let the economy run", no transaction). Section 8 is corrected. (2) "6 game hours do not reach the first council" is an inference: the council period is 24 with offset 0 (`commitments.json`), and in r2 the first councils have `c0 = 48` (`pub/council/2-*.json`; none at `c0 = 24`), r1 played 36 bells; consistent, not proven for r1 (8 is annotated). (3) "no console error" in the walkthrough is unproven (8.1 annotated). |

### 9.4 smoke-r2: what ran and what it showed (every number from the run's own files)

Run: `ai-citizens-run.sh --stack citizens/stack/ai-smoke-14h.toml --citizens-config citizens/config/smoke.json --deck deck-1 --run-id smoke-r2`, 14 game hours (84 bells of play, drain 26 bells), real Gemma (`start-pinned.sh`, pid 4006, stopped after the run; the run script's llama check: PASS, same pins as r1), started 2026-10-05 01:53 JST (RUNS.md `2026-10-04T16:53:55Z`), END 03:34 JST (`end_unix` 1791138874). The machine was free at the start (no listener on 41900-41999, no llama, no lock file; the paused m1-exit stack and the design preview untouched). `permutation_frontier.so` sha256 as in 9.2. Run directory `.local/frontier/ai/smoke-r2/` (git-ignored). The END status is `complete`, with the detail "...verify-minds FAIL" (9.5).

| Item | Result |
|---|---|
| Decisions (`report-r2.md`) | 497 decision records; 57 model decisions, 57 valid, 0 fallbacks, 0 dropped for time; session latency p50 3330 ms, p90 4372 ms; by:model share 32.4 % (58 of 179 actions); GETs per step 5.6; 12 model marches (Y strict 11, an episode proxy); 32 of 57 model decisions cite memory by the records, the mind's own counter says 19 (two different counters; not reconciled here). 11 reflections ok. |
| Councils | 10 council files (periods 2, 3, 4: `c0` 48, 72, 96); `council/current.json` lists `adopted: false` for the nations it names; I did not check further whether a Strike Order was adopted. The council page said "No council this period" at bell 37 and listed councils later. |
| Latest client served from this tree | herald args in `runtree-r2/process-evidence.txt` (`--web` the ai-run web directory). Pages fetched while up: spectate with `?art=1`, the client, `council.html`, all 200. |
| **3D miniature units** | **Seen, for all six AI citizens' armies.** Method: the map's search box finds the AI citizen's name, the page moves to their village, the "Hosts on this tile" panel lists the units (with the unit cards), and zooming in with the + button shows the painted miniature on the map. Stills (bell 68 to 71; the village lord and the host owner shown by the page are the AI citizens named in `pub/cards`): Marao Tawick (Aster) spearman with a round shield, `shots/ai1000-aster-spearman-zoom.jpg`; Semeto Hiwyn (Fjordal) horseman, `shots/ai1005-fjordal-horseman-zoom.jpg`; Soa Evale (Borealis) horseman, Varawen Sebourne (Cinder) two spearmen, Zeiko Owick (Dunmar), Hikael Zewell (Ember), `shots/ai1001-1004-miniatures-mosaic.jpg`. Network (`capture-report-play-bell71.json`, `ais[].units_art`): `art/units/@1x/units_<faction>.webp` and `@2x` and the unit cards `art/units/cards/<faction>_<kind>.webp`, all HTTP 200. What I did **not** capture: a figure in a battle replay (the replay of the clash highlight moved the map to a camp and the stills show no figures), and a figure on the march (marching armies walk their planned road; I did not look for one). |
| **Nation-only join** | **Seen.** Spectate page, Join tab, then the local Dev Wallet connected in a throwaway browser (a random key in that browser's storage; the script records every non-GET request and found none, so nothing was sent to the stack; I did not press Join): the panel reads "Choose a nation: You choose one of the six nations, nothing more. This page files the site ticket for your first village on free sites of your home wedge by itself, and the village is decided at the next bell (in about 11-21 minutes)." with the six nation cards, and the same in Japanese ("国を選ぶ", `shots/join-en-nation-step.jpg`, `join-ja-nation-step.jpg`). No site picker text on either page. |
| Canvas labels following the language | seen again in the join and spectate pages (nation names and "The Concord / 大協約" switch), and in the walkthrough video. |
| Walkthrough video | `/private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/r2/video/runtree-r2-walkthrough.mp4` (H.264 1280x800, 107 s, no audio, recorded at bell 89 to 92, in the drain; outside git, 5.8 MB). It shows: search to two AI citizens (Semeto, Marao), the unit panel, the horseman miniature close up, zoom out, Realms, the language switch, the Join tab with the nation step, the council page. Script: `runtree-r2/walk2.mjs`. |

Reproduce the stills: `node docs/frontier/ai-citizens/runtree-r2/capture.mjs OUTDIR RUN_DIR` against a live stack (it needs Playwright; the default module path is the npx cache used here; no install was made).

### 9.5 NEW and OPEN: smoke-r2's verify-minds FAILED (M3), a season-end race in the AI line (repaired in the code since section 10; not re-run live)

`logs/verify-minds.log`: M1 PASS n=33, M2 PASS n=12, **M3 FAIL n=249 (1 failure)**, M7 PASS n=348, M8 PASS n=30, M9 PASS n=20 (20 of 20 equal on replay), M11 PASS n=520. Verdict **FAIL** (`runtree-r2/verify-minds-r2.json`, `report-r2.md`). The single failure: `anchor_gap` at **bell 109**, reason "the chain was paused (the season is complete): no block can confirm a memo".

What happened (file times of the run directory and the code; this is my reading, not a fix):
* the herald's last closed bell is 108 (`herald_last_closed_bell: 108`); the registrar's `publish` wrote the signed index with `last_bell 108`, 109 anchored, 0 gaps ("109 anchored, 0 gap(s) of 109 closed bells" in the END line), and `state/season-end.json`, all at 03:33:14 JST;
* in the same second the citizens service's closer wrote `pub/talk/109.json` and `pub/minds/109.json` (empty bell, zero roots): the stack's chain completed at game 1785696216, three seconds after the end of bell 109 (1785696213);
* two seconds later the still-running `registrar run` found bell 109 without an anchor on a paused chain and wrote `anchors/109.json` as an `anchor_gap` (its log: "anchor 109: not sent: the chain was paused ..."); it is outside the index;
* `verify-minds` M3 takes its bell range from the union of the anchor, talk and minds files (`checkM3`: `lo..hi`), so it saw 0 to 109 and failed on 109. The run report says the same in its own words: "closed after the season-end index (last_bell 108): 109".

This is the same family as the earlier "bell closed after the season-end index" of `FB1-NOTES.md` and `integ-B-smoke-b4-report.md`; smoke-b5 and smoke-r1 did not hit it (smoke-b5's stack completed at the same game time 1785696216 but its files stop at bell 108). So whether the verifier passes at the end of a 14 h run depends on the closer's timing against the publication; it is **not caused by the run tree** (the closer, registrar and verifier code are identical to `frontier/ai-integ` at `d6f2bc3`; the run tree differs only by the council page change of 9.1) and no code of it was changed here. I did not re-run smoke-r2, did not edit the verifier or the registrar, and do not count smoke-r2 as a verify-minds PASS. The owner of the AI line should decide the repair; the options I see: the closer closes no bell after `STATE/season-end.json` exists or after the herald's last closed bell, or the registrar does not write gaps beyond the signed index, or the publication waits for the closer's last bell. Any of them changes the end of every long run (the A/B runs and the main run), so it belongs on `frontier/ai-integ` and should come here by the next re-merge.

### 9.6 The `herald` test `real_chain` (minor finding): cause by reading, not fixed

`folds_the_programs_beacon_records` (`frontier-node/crates/herald/tests/real_chain.rs:66`) failed once with ENOENT in `ing.checkpoint().unwrap()`. By the code: `Ingest::step` starts a background checkpoint (`checkpoint_background`) every `checkpoint_slots` (150) slots; the blocking `Ingest::checkpoint()` the test calls at the end does not wait for it; both write the same temp file name `.herald.ckpt.tmp` (`files.rs:80`, `write_via_temp`) and then rename it, so the second rename can find the file gone. Production is not exposed in this way (`run` ends with `checkpoint_async`, which settles the background save first; `Ingest::open` has none in flight). I could not reproduce it: the test alone once, then 90 runs (15 rounds of 6 in parallel under `nice`) and a full `cargo test` all passed. **Not fixed**: the herald crate and its tests are never-edit paths (contract 11.1, enforced by `ai-hook-check.sh`). The one-line repair would be `ing.checkpoint_settled().await;` before the call at `real_chain.rs:66` (the same pattern is at `tests/fold.rs:150` and `itest/src/day.rs:556`); it is for whoever owns the herald.

### 9.7 Everything started was stopped

Run script trap: census, registrar-run, citizens service and the stack were stopped ("lock released" in `run.log`); the llama-server (pid 4006) was killed by me. After the run: no listener on 41900-41999, no llama-server, the lock file `outputs/.git/wylls-ai-stack.lock` is gone. The Playwright browsers closed with their scripts. The paused m1-exit stack (ports 410xx) and the design preview were not touched.

### 9.8 Open points after review round 2

1. The failing tree test (3.1): decision needed (the exclude file plus a test that passes `--exclude`). Quote the gate as 1570 of 1571.
2. 9.5, the season-end race that failed smoke-r2's verify-minds: **repaired on `frontier/ai-integ` and re-merged here (section 10); not yet confirmed by a live run.** Until then a long run from this tree can end with a verify-minds FAIL for this reason; look at M3's single failure before reading anything into it.
3. 9.6, the herald test race (a one-line change in a never-edit path).
4. The council page change of `f2ad434` should be taken by `frontier/ai-integ` (or the ai-run side kept on re-merge).
5. Highlights are empty on a fresh page after the play phase (9.3): record during play; the window is the design session's.
6. Not run here: the A/B runs; a figure in a battle replay and a marching figure on the AI screens; the whole-map off-centre/cut-label layout item; the `[lang] ... "Wylls"` warning count.

## 10. Season-end race fix re-merged (2026-10-05)

The repair of 9.5 was made on a new branch `frontier/ai-eosfix` (cut from `frontier/ai-integ` `d6f2bc3`; commit `d803f88`), merged into `frontier/ai-integ` (`eabef5c`, `--no-ff`) and re-merged here (`544c1a8`, `--no-ff`, no conflict; the merge auto-merged `test/citizens-run-check.test.mjs`, which this tree had changed in `cb25c3d`). Nothing was pushed, `frontier/unify` and its worktree were not touched. The full account (cause, rule, tests, limits) is `integ-B-NOTES.md` section 11. In short:

* **Cause (from smoke-r2's own files):** the chain ended at game second `F = start(110) + 3` (genesis `1785630213`, last game second `1785696216`); the close instant of bell 109 is `F + 17`. The closer's clock ran on real time between two herald polls and crossed it, and nothing ordered the closer against the registrar's `publish`.
* **Rule:** (1) once the brain is silent the closer measures against the newest chain time a herald poll returned, never the extrapolation (`closer.mjs` `closeNow`/`noteChain`); (2) the season-end seal ends the closer: `publish` waits for the last bell the chain closed, writes `STATE/season-sealing.json`, waits for a close in flight, then counts the closed bells and writes the index; the closer (claim, then check) closes nothing once sealed (`mind/seal.mjs`). `verify-minds` is unchanged. The smoke-b4 clock fix stays (its 7 tests pass unchanged).
* **Files in this tree changed by the merge:** `citizens/mind/closer.mjs`, `citizens/mind/seal.mjs` (new), `citizens/registrar.mjs`, `citizens/server.mjs`, `citizens/bin/ai-citizens-run.sh` (clears a leftover seal and claim; the dry-run plan names the new step), `test/citizens-eosfix.test.mjs` (new, 13 tests; 13 of 13 fail on `d6f2bc3`), a two-line fixture change in `test/citizens-run-check.test.mjs` (the throwaway-repository copy list), the notes. No Rust, web, herald, agents, program or ABI file changed (`git diff --stat 6ca80a5 HEAD -- frontier-node` is empty); the release binaries of section 4 are therefore still current.

### 10.1 Gate of this tree after the re-merge (`544c1a8`)

| Command | Result |
|---|---|
| `cd permutation-gateway && npm test` | **1584 tests, 1584 pass, 0 fail**, 0 skipped, 0 cancelled (48 s). The one test that failed in 3.1 and 9.2 (`ai-hook-check.sh on this tree`) passes in this tree since `cb25c3d` (the exclude file; that commit is not mine and I did not edit that test or the hook check): so the gate here is "all pass", not "all pass except that test". |
| changed test files alone | `citizens-eosfix` 13/13, `citizens-integ-b-clock` 7/7, `citizens-mind-closer` 5/5, `citizens-registrar` 27/27, `citizens-fb1-anchors` 10/10, `citizens-run-check` 22/22, `citizens-mind-server` 9/9, `citizens-integ-b` 5/5 |
| `ai-hook-check.sh --blank-ok --exclude ad1c919d4d3b94eec8dc1d7df1e3a5c8f112f80d HEAD` | **PASS** (125 commits since `30ba411`, 282 MC files from 2 lists) |
| `ai-citizens-run.sh --stack citizens/stack/ai-smoke-14h.toml --citizens-config citizens/config/smoke.json --deck deck-1 --run-id eosfix-dry --check` / `--dry-run` | `guards: PASS`; the dry run printed the plan (with the new publish wording) and "nothing was started or written" |
| Rust (`cargo test`, `fmt`, `clippy`) | **not run**: no Rust file changed since the last run of 9.2 |

In the ai-eosfix tree (`d803f88`) `npm test` gave 1583 of 1583 on the third run; the first run had one failure in `citizens-run-check` (the throwaway-repository fixture lacked the two new mind imports: fixed before the commit) and the second one failure in `frontier-relay-parts.test.mjs` ("invites: HMAC tokens ...": the test replaces the last two characters of a random token with `AA`, which leaves it unchanged when it already ends in `AA`; by my reading about one run in 4096; it passed in 6 of 6 reruns and in the full run after; not an AI file, not edited).

### 10.2 What is NOT shown

No live run: smoke-r2 was not re-run, no stack, no herald, no llama-server, no run script start (ports 41900-41999 and every other port untouched; the paused m1-exit stack and the design preview not touched), no paid API, no download. That the 14 h run now passes M3 is shown on smoke-r2's own geometry in tests, not on a new run. Open: the geometry hole (a bell closed within a memo's landing time of the chain's end becomes a named gap), the verifier's `headBell - 1` against the closer's +20 game-s, and `F` for the 3-day main and A/B configs, which I did not compute (`integ-B-NOTES.md` 11, limits 1 to 3). The scripted-seat honesty rule of section 10 of the integ-B notes stands: an adopted Strike Order in a run is a scripted seat vote plus AI votes, never "humans and AI decided together"; this fix does not touch the seat or the council.
