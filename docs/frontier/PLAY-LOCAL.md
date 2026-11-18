# Play-check locally (TEST only, one command)

How to try the playable lane (expedition, wide land, taking a keep) on your own Mac before anything goes to devnet.
It uses a local chain on this Mac and test keys only. No real key, SOL, devnet or paid API is used.
Japanese version: [PLAY-LOCAL.ja.md](PLAY-LOCAL.ja.md). The longer reference is [LOCAL-PLAY-START.md](LOCAL-PLAY-START.md).

## 1. Install once

The script installs nothing. If something is missing, it prints its name and how to install it, then stops.

| What | Version | Example |
|---|---|---|
| Rust (rustup) | 1.89.0 and 1.95.0 | `rustup toolchain install 1.89.0 1.95.0 --profile minimal` |
| cargo-build-sbf and platform-tools | 3.1.9 / v1.52 | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"` |
| Node.js | 20 or later | `brew install node` (keep what you have if `node -v` is v20 or later) |
| git, python3 | built into macOS | `xcode-select --install` if missing |
| Free disk | 20 GiB or more the first time | |

The first build fetches crates over the network. During play, the keeper reads public drand rounds over HTTPS.

## 2. The one command

From the repository root:

```bash
scripts/play-local.sh
```

- It checks the tools, builds (skipped when nothing changed since the last build), starts a world and opens
  `http://localhost:41920/` in the browser.
- The first build took about 3 minutes (2026-11-18, a Mac with the crates already cached). Later starts take seconds.
- There are two kinds of world:
  - **A kept world (the default):** the natural clock (a turn is 10 minutes), and the world never ends by the rules.
    Stop it any time and continue later with `--resume`, from the same village. The chain is kept in
    `.local/play-local/kept/`, and the page's test key is kept in this browser.
  - **The 15-minute capture demo (`--demo`):** a ×60 clock (a turn is 10 s), so you can try up to taking a keep in about
    15 minutes. It is not kept: a stop ends that world.
- Useful options:
  - `--resume`: continue the last kept world
  - `--fresh`: start a new kept world (the same as leaving out `--resume`)
  - `--random-map`: give the new world its own map. Without it **every local world has the same map** (the local chain
    always starts at one fixed clock origin, so every world draws the same genesis seed: the same terrain, village
    sites and Free City). With it the world starts at a randomly picked earlier origin and the program derives another
    seed by its unchanged rules. What stays the same by rule: the six-fold symmetry of the terrain, and (until the
    centre-free rules of PR #69) each nation's homes in its own wedge. Not with `--resume`: a kept world keeps its map.
  - `--demo`: the 15-minute capture demo (`--speed 30` makes it ×30)
  - `--ai 0`: no AI residents (default 2)
  - `--port 41930`: other ports
  - `--lang ja`: the script's messages in Japanese
  - `--check-only`: only the checks
  - `--help`: every option
- The page follows the browser's language; its top-right button switches 日本語 ⇄ English.

## 3. What to try

In a kept world, try 1–5 (join, home, build, train, muster), then stop and come back as in §4. A new host can move only
once its turn has resolved (about 17 minutes at the natural clock). Try 6–8 (keep, clash, capture) with `--demo`, in about
15 minutes.

1. **Join**: 「世界を開始（保存された世界は続きから）」 [Start the world (a kept world continues)] (with `--demo`:
   「新しい世界を開始」 [Start a new world]) → 「国を選ぶ」 [Choose a nation] → pick a banner → the button below becomes
   「(the nation's name)で始める」 [Begin as …]: press it.
   The first village is placed for you. The AI residents join Borealis and Ember; pick another nation to stay clear of them.
2. **Home**: 「ここが、あなたの村です。」 [This is your village] means it worked. Look for "ore +2" marks on the map.
   A village with 「地形の鉱石なし」 [no ore on the terrain] can grow to only about 600 troops.
3. **Build**: 「最初の建設を選ぶ」 → the farm's 「建てる」 [Build]. It completes in about a minute (game time).
4. **Train**: the bar's 「訓練」 [Train] → 「最大 500」 → 「槍兵 500 を訓練する」. Training is immediate.
5. **Muster**: the village panel's 兵 section → 「全部（500）」 → 「編成する」 [Form a host].
   While it says 「この州はまだ前のターンの決着が済んでいません」 [the province has not resolved the last turn yet], the button
   is disabled: wait a few seconds and press it once the line is gone. 「立っている 1」 [1 standing] means it can move.
6. **March on a keep**: when the guide (top right) says 「届く砦を見る」 [See the keeps you can reach], press it (if it stays on
   「軍勢の準備を確かめる」, open the bar's 「国と領土」 [Realm] once and it switches), pick the keep's row
   and press 「確認した命令で出発」 [Depart with this order]. Press it while the red "not resolved yet" line is NOT shown.
   「最初の出陣」 [First sortie] means it left.
7. **Verify the clash**: on arrival, 「… 衝突が決着しました」 [the clash was resolved] appears (once the notice is gone, its
   「報告」 button stays in the list under the bar's 「その他」 [More]). Press 「報告」 [Report] →
   「このブラウザで確かめる」 [Check in this browser]; 「一致：…」 [Match] means the browser recomputed the chain's record.
8. **Capture**: hold the keep's tile for 72 turns (12 minutes or more at ×60). The map shows 「砦を保持中」 [Holding the keep]
   with a round counter over the keep, and the clash report says 「奪取まで N/72 ターン」 [N/72 turns to capture].

## 4. Stop, and come back tomorrow

1. To stop, press **Ctrl-C** in the script's terminal. It closes every world first, then prints where the logs are and
   "This world is kept. To continue it later, in the same browser: scripts/play-local.sh --resume".
2. You can close the browser tab. In a kept world, the page's test key stays in this browser.
3. The next day, on the same Mac and in the same browser, run:

   ```bash
   scripts/play-local.sh --resume
   ```

   The same address (`http://localhost:41920/`) opens. Press 「世界を開始（保存された世界は続きから）」 and you are back in your
   village. The world's clock stood still while it was stopped.
- `--resume` opens with the same port and number of AI residents as before (another `--port` or `--ai` is refused),
  because the browser keeps the test key per address.
- If the program changes (after a `git pull`, for example), the old world cannot continue. The script says so and stops;
  start a new world with `--fresh`.
- `--resume` opens only the kept world that was started last. After a `--fresh`, the earlier world's folder stays, but
  `--resume` opens the newer one. To go back to the earlier world, write its folder's path
  (`…/.local/play-local/kept/<date-time>`) into `.local/play-local/last-kept`.
- A world's processes stop after 90 minutes by default (`--minutes`). A kept world can still be resumed after that.
- To delete the test key, press the page panel's 「このブラウザに保存した試験用の鍵を消す」 [Delete the test key kept in this
  browser]. The world's folder (`.local/play-local/kept/<date-time>/`) stays until you delete it yourself.
- A `--demo` world is not kept. After stopping it, close that browser tab (its memory-only test key goes with it).

## 5. Problems and where to report them

- Logs:
  - a kept world: `.local/play-local/kept/<date-time>/` (`launcher-<date-time>.log`; runner, herald, relay and operators
    logs in `persist/<address>/starts/<n>/`);
  - `--demo`: `.local/play-local/worlds/<date-time>/` (`launcher-<date-time>.log` and one folder per world).
- Report on GitHub Issues (r0ze998/wylls) with a screenshot and the folder's path.
- Known problems (2026-11-18):
  - If a march says 「できませんでした … この命令は送信済みですが、まだ確認できていません」 [Could not … the order was sent but is not
    confirmed yet], that host can no longer move in this world. Start a new world (see report D-r0ze-play-kit-1).
  - The title's "a turn every 10 minutes" and the start screen's "two hours by default" do not hold for this test world
    (at ×60 a turn is 10 s; the world lasts 90 minutes).
  - At ×60 the land preview's FoldLand is often refused for running out of compute units (`fold_refused` in
    runner.out). To check land yield, use `--demo --speed 30` or lower.
