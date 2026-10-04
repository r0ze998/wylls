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

Merge base of the two branches: `73408a5` (contract v1.2). Files changed on both sides since it: **two**, both documents.

| Conflict | Resolution |
|---|---|
| `docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md`, 3 hunks (the `clash_own_win`/`clash_own_loss`/`clash_own_fought` rows of 5.2, the M11 row of 7.3, the R12 row of 14.4) | the ai-integ side (the unify copy equals `19fe89c`, ai-integ has R12 and later); checked: the file is byte-equal to `frontier/ai-integ` after the resolution |
| `docs/frontier/ai-citizens/GAME-DESIGN-CORE.ja.md` | no conflict: both sides carry the same change (the copy of `19fe89c`) |

No conflict in the four hook files, `Cargo.toml`, `Cargo.lock`, the herald or the web files: unify's only changes under `frontier-node` are two herald lines (`herald/src/server.rs`, `herald/tests/server.rs`) and, under `permutation-gateway`, `screens/interaction.screen.mjs`, `screens/logic.screen.mjs` and `test/web-frontier-hud.test.mjs`; ai-integ touches none of them. The 92 web files that unify changed are untouched by the merge (`git diff frontier/unify HEAD -- permutation-server/web` lists only the 19 AI council files, `council.html` and `council/**`, which unify does not have). `permutation-server/web/session.mjs` and the design web files are identical to `frontier/unify`.

`permutation-gateway/package.json` and the lockfile are the same on both sides, so the `node_modules` copied from the ai-integ worktree (`cp -c -R`, 59 entries) serves this tree; no package was installed and none is missing.

## 3. The gate in the merged tree (run on `c76b0f3`; the re-merge added documents only)

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
2. Not run here: the live smoke from this tree, any served-page check, `verify-minds`, the A/B runs. Gemma was not started.
3. Test counts above are from the merge at `c76b0f3`; the re-merge `71ce29b` changed documents only, and only the hook check was repeated on it.

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
| Decisions | report.md: 177 decision records, 12 model decisions (gate open), 12 of 12 valid, 0 fallbacks, 0 dropped for time; latency p50 2747 ms, p90 2925 ms (session); 6 reflections, 6 ok; by:model share 18.3 % (17 of 93 actions); GETs per step 4.94. |
| **Model march** | **none.** 0 model marches in this run (the report: "0 model marches sent"), so Y = 0 and no sealed or released march decision exists. The model's choices were build/train orders (c3, c5) and one scout order (c4, "explore"); the one explore appears on the map as "Dato of Aster explores province 3,0". The 6-game-hour length is the likely reason (smoke-b5, 14 h, had 14 model marches); this is not proven here. |
| Memory | 0 of 12 model decisions cite memory; only `build_done` episodes existed (23); so no "Remembered" line with content was produced. The council page shows "Remembered (cited by the model): nothing cited". |
| Council / Strike Order | no council this period (6 game hours do not reach the first council); the page says "No council this period". |

### 8.1 What the pages looked like (Playwright Chromium 1208 from ~/Library/Caches/ms-playwright, playwright 1.58.2 from the npx cache, 1280x800)

Screenshots (outside git, in /private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/video): `runtree-spectate.png`, `runtree-spectate-art.png`, `runtree-client.png`, `runtree-client-art.png`, `runtree-council.png`, plus `*-ja.png` for the language switch. I looked at each.

* **spectate.html** (taken after the intro dialog was dismissed with its button): realm view of the hex map: textured terrain (forest, plains, hills), six nation territories outlined, nation names as large canvas labels (Dunmar, Aster, Borealis, Cinder), the Concord in the middle, a minimap, layer chips (Realms, Military, Terrain, Settle), the "Nation standings" list with the people's portraits, bell clock "Bell N · mm:ss left", Highlights list ("Dato of Aster explores province 3,0"). After the switch to Japanese the canvas labels and every panel switched (ダンマール, アステル, ボレアリス, シンダー, 大協約; "村 6 · 3 州"; "鐘 51 · 残り 3:17"), so the canvas labels follow the language switch.
* **spectate.html?art=1**: the same app zoomed to tile level with the diorama sprite art: dense painted forest, hills, mountains with snow, camps, village tents with a tower, white province borders. 252 art files were requested (fog, terrain, ...) against 115 without `?art=1`.
* **frontier/ (client)**: same map with the Join-side panel: "Not in a nation yet", "Guide 0/7: Welcome", "Connect a wallet / Dev Wallet (localnet)"; the intro dialog button reads "Enter the Frontier". In Japanese: "まだ国に加わっていません", "村", "国と村" in the guide steps: the nation-only join and the 国/村 wording are in the served client.
* **Military layer**: army chips "x1", "x2" per province at the whole-map zoom; at the zoom levels I reached I saw chips and village tokens, **not** the 3D miniature figures. The unit sheet `art/units/@1x/units_0.webp` and `@2x` (faction 0) were requested and served (200), so the miniature code ran, but no screenshot of mine shows a miniature figure. "3D miniatures appear" is therefore **not confirmed** by this run.
* **council.html**: header "Wylls · council, bell N", the banner "LOCAL TEST CHAIN · AI citizens are labelled · recorded 2026-10-04 · run smoke-r1" (the date is UTC), 6 AI citizens with "AI" badges and "by the model N %", a Wyll card (persona quote, trait chips, "Who acted", goals with progress bars, G1 50 % active at bell 53), the Decisions list ("Chose: c3 · goal G1", the AI's words, Said, "Remembered: nothing cited"), the nation council block, Departures and clashes.
* **Console and network**: no `pageerror` and no console error other than HTTP 404s. Every page logs `[lang] no English for: "Wylls"` (the client; a missing English key for the product name, harmless). With `?art=1` the client polls `/h/clash/P,Q/<bell>` for the three bells before each province's bell (preview code, `app.mjs` artClashOf) and the herald answers 404 when no clash happened: dozens of 404s, by design, not a mismatch. The council page 404s on `/h/ai/minds/<bell>.json`, `minds/late/<bell>.json`, `redactions.json`, `council/current.json`, `open/index.json` while those files do not exist (the known polling noise of integ-B-NOTES section 4). No missing field, no schema error between the client and the herald was seen.

### 8.2 Walkthrough video

`/private/tmp/claude-501/-Users-r0ze-Library-Application-Support-Claude-scratch-workspaces-59b0e37b-c381-4b5c-88fe-761b42e364f2-e1e340d9-5c30-4c5a-983e-525e18a0d520-scratch-2026-09-25-dd5411/ca3e79c1-f15f-4c2f-8555-107cb1f00a2a/scratchpad/video/runtree-walkthrough.mp4`: H.264 1280x800, 71.8 s (ffprobe), no audio, no narration, recorded by Playwright recordVideo at bell 30 to 32. It shows: the art map with the Military layer, zoom in and out, the army chips on the whole map, the highlight click, Realms and Military toggles, the language switch to Japanese and back, then the council page (roster, three card clicks, the Decisions list with "Remembered: nothing cited", the council block). Frames extracted at 10 s, 30 s and 55 s (`runtree-walkthrough-f10.png`, `-f30.png`, `-f55.png`): f10 art map at village zoom with the Military layer on; f30 the whole map with the army chips and the nation labels; f55 the council page with the Decisions list. It does **not** show a released march decision (none existed) and no miniature figures were seen in it.

### 8.3 Everything started was stopped

The run script's trap stopped census, registrar-run and the citizens service and ran `frontier-stack down` (localnet, drand replay, relay, herald, keepers, bots); "lock released"; the llama-server (pid 82587) was killed by me; the Playwright browsers closed with their scripts. After the run: `lsof -iTCP:41900-41999 -sTCP:LISTEN` shows nothing, `pgrep llama-server` finds nothing, the lock file `outputs/.git/wylls-ai-stack.lock` is gone. The paused m1-exit stack and the design preview were not touched. Artifacts: `.local/frontier/ai/smoke-r1/` (git-ignored).

### 8.4 Not run / open

* A live model march, a released decision with Remembered lines and a council with a Strike Order were not produced by this 6-hour run; for those a longer run (the 14 h `ai-smoke-14h.toml`) is needed.
* The 3D miniature figures were not seen in my captures.
* Gate numbers for the merged tree were not re-run after the toml (only the run-check test file); the failing tree test of 3.1 is unchanged and still needs a decision.
