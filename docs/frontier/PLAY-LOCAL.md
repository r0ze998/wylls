# Play-check locally (TEST only, one command)

How to try the playable lane (expedition, wide land, taking a keep) on your own Mac before anything goes to devnet.
It uses an in-memory local chain and test keys only. No real key, SOL, devnet or paid API is used.
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
- Useful options:
  - `--ai 0`: no AI residents (default 2)
  - `--speed 30`: a ×30 clock (default ×60: a turn is 10 s)
  - `--port 41930`: other ports
  - `--lang ja`: the script's messages in Japanese
  - `--check-only`: only the checks
  - `--help`: every option
- The page follows the browser's language; its top-right button switches 日本語 ⇄ English.

## 3. What to try in 15 minutes

1. **Join**: 「新しい世界を開始」 [Start a new world] → 「国を選ぶ」 [Choose a nation] → pick a banner → 「国を選んで始める」.
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

## 4. Stop and resume

- To stop, press **Ctrl-C** in the script's terminal. It closes every world first, then prints where the logs are.
- Then close the browser tab: closing it discards the page's memory-only test key.
- `--resume` is not available yet: until world persistence (PR #38) is on main, every start is a new world.
- A world ends by itself after 90 minutes by default (`--minutes`).

## 5. Problems and where to report them

- Logs are in `.local/play-local/worlds/<date-time>/`: `launcher.log`, and one folder per world (runner, herald, relay
  and operators logs, `stopped.json`).
- Report on GitHub Issues (r0ze998/wylls) with a screenshot and the folder's path.
- Known problems (2026-11-18):
  - If a march says 「できませんでした … この命令は送信済みですが、まだ確認できていません」 [Could not … the order was sent but is not
    confirmed yet], that host can no longer move in this world. Start a new world (see report D-r0ze-play-kit-1).
  - The title's "a turn every 10 minutes" and the start screen's "two hours by default" do not hold for this test world
    (at ×60 a turn is 10 s; the world lasts 90 minutes).
  - At ×60 the land preview's FoldLand is often refused for running out of compute units (`fold_refused` in
    runner.out). To check land yield, use `--speed 30` or lower.
