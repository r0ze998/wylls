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
