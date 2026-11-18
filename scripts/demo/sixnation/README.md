# Six-nation bot session + multi-view recording (TEST local world only)

One command starts a **TEST-only local world** on the playable lane (natural preset, page-signed economy, capture-demo
clock), adds **six operator AI residents (⑤ A), one per nation**, lets a headless page join as a player, and records
**9 views** with Playwright's built-in `recordVideo`. If `ffmpeg` is installed, it also combines them into a 3×3 `grid.mp4`.

```
# once: Playwright for Node (the repo's screens package) and its Chromium
npm install --prefix permutation-gateway/screens
npx --prefix permutation-gateway/screens playwright-core install chromium   # skip if chromium-1208 is cached

# the run (~20 min of recording plus ~2–4 min of world set-up)
scripts/demo/sixnation/sixnation.sh --bins <dir with the 7 binaries> --out <new evidence dir> --seed 7 --minutes 20

# see what it would do, start nothing
scripts/demo/sixnation/sixnation.sh --dry-run --seed 7
```

`--bins` must hold the 7 playable-lane binaries the local-play launcher needs: `localnet-natural-play`,
`localnet-expedition-play`, `frontier-herald` (feature `local-play-bootstrap`), `frontier-experimental-expedition-prepare`,
`frontier-experimental-expedition-depart-prepare`, `frontier-original-expedition-preview` and `permutation_frontier.so`.
These are the same files `scripts/play2-land-ops/play2-start.sh` uses. The tool hashes every one into `manifest.json`.

## Options

| flag | default | meaning |
|---|---|---|
| `--seed <0-4294967295>` | 1 | which resident takes which nation, and which nation the player page joins |
| `--minutes <1-120>` | 20 | recording length (wall clock) |
| `--turns <n>` | 0 (off) | also stop once the herald has advanced this many turns |
| `--demo-scale <10-60>` | 20 | TEST demo clock: game seconds per real second (20 → one turn every 30 s) |
| `--port-base <41000-41999>` | 41300 | 32 loopback ports from here: launcher, 2 worlds × 5, 2 × 6 resident relays |
| `--max-acts <1-9999>` | 400 | each resident's send budget (the launcher's `--operator-max-acts`; the residents' own default is 60) |
| `--tile WxH` | 800x500 | viewport and video size of each view |
| `--player-nation <0-5>` | from the seed | the nation the player page joins |
| `--no-grid` | — | skip the ffmpeg grid (the HTML player is always written) |
| `--cluster localnet` | localnet | the only value accepted. `devnet`, `mainnet`, any URL, and every `--rpc/--url/--key/--wallet` flag are refused with exit 3 |

Nations: 0 Aster, 1 Borealis, 2 Cinder, 3 Dunmar, 4 Ember, 5 Fjordal.

## What is recorded (`--out`)

- `views/*.webm`, one per view:
  - `player`: the page that started the world and joined
  - `overview`: the spectator page over the whole world
  - `nation-N-<name>` (×6): the spectator page with that nation's filter and its camera set once on that nation's village. Every 2 min the panel and filter are re-applied; the camera is not moved again. The spectator's camera-follows-battles switch is off in these views; the overview keeps it on.
  - `summary`: a live table of each nation's landed commands, built from `operators.out`
- `grid.mp4`: the 3×3 grid (ffmpeg `xstack`, H.264). `grid.html` plays the webm files together, with no ffmpeg needed.
- `snapshots/`: JPEGs of every view every 5 min.
- `operators.out` / `operators.json`: the residents' own log, one JSON line per step, and their roster. Only public addresses; the keys stay in memory.
- `summary.{json,md}`: per-nation counts of commands landed, refused and failed.
- `manifest.json`: seed, plan, commit (+ dirty flag), sha256 of each binary and video, versions, ports, start and end turns, and the clean-up check (ports free again, no world process left).
- `world-data/`: the launcher's world directory (runner, herald and relay logs).

Every view carries a small label in its bottom-left corner. The tool adds it for the recording; the game does not show it.

## Reproducibility: what the seed fixes and what it doesn't

**The same seed gives the same:** nation → resident order (`--operator-nations`), player nation, launcher flags,
decision rule (`local-play-operator-policy.mjs`: Join → PlaceHome on the nearest untried heartland site → a fixed
Harvest/Build/Train/Muster rotation, with cooldown after a refusal), budget, view layout and timing schedule.

**Not deterministic:**
- The world itself. The natural runner seeds its Season from the **public drand round current at start time**, so the map and heartland sites differ from run to run.
- The keys. Residents and the player page make fresh memory-only TEST keys every run, by design (#40 / fephemeral-wallet).
- Wall-clock interleaving: which turn a command lands in, how long a follow-up takes, and therefore which Build/Train is refused (QueueFull or Insufficient) and when cooldowns fire.
- Capture-demo test participants. The runner places them in the **player's** nation to open the next ring, so the player's nation shows many more villages than the others.

So two runs with one seed tell the same story (the same nations, the same rule, the same order of moves per resident) on a different map, with slightly different timing.

## Safety

- TEST only. The world is the launcher's memory-only local chain on 127.0.0.1. The tool refuses any other cluster and never takes a chain address or a key.
- No paid API and no model. Residents follow a fixed offline rule.
- Network: loopback only, plus the natural runner's **public drand beacon reads** (GET `api.drand.sh`, BLS-verified). That fetch is in the runner, not in this tool, and every natural world needs it.
- Stopping: when it finishes, on Ctrl-C, SIGTERM or SIGHUP, it closes the views and ends the launcher, which stops the runner, herald, relays and residents. It then checks every one of its ports is free and records the result in `manifest.json`.
- Long runs: launch it detached (e.g. `nohup … &` from a terminal that stays open, or a detached spawn) so a closing shell does not end the run early.

Evidence of the first recorded run: `~/Projects/wylls-grok-state/evidence/sixnation-recording/` (outside the repo).

---

## 日本語（再実行の手順）

TEST専用のローカルワールドを1コマンドで立ち上げます。6つの国それぞれに運営AI住民（⑤A）を1人ずつ入れ、
9画面（プレイヤー、全体観戦、国別観戦×6、集計）を Playwright の `recordVideo` で録画します。ffmpeg があれば
3×3 の `grid.mp4` にまとめます。

```
npm install --prefix permutation-gateway/screens          # 初回だけ
scripts/demo/sixnation/sixnation.sh --bins <7つのバイナリがあるディレクトリ> --out <新しい出力先> --seed 7 --minutes 20
scripts/demo/sixnation/sixnation.sh --dry-run --seed 7    # 何も起動せずに計画だけ表示
```

- `--seed` で決まるもの: どの住民がどの国に入るか、プレイヤー画面の国、起動フラグ、AIの判断ルール、画面の並び。
- 毎回変わるもの: 地図（起動時点の公開 drand ラウンドから作られる）、鍵（毎回メモリ上で新しく作る）、コマンドがどのターンに通るかと、それに伴う拒否のタイミング。
  また、キャプチャデモのテスト参加者はプレイヤーの国に置かれるので、その国だけ村が多く見えます。
- 時計: `--demo-scale 20` で1ターン約30秒（TEST用のデモ時計）。
- 安全: `localnet` 以外のクラスタ、RPC・URL・鍵を渡すフラグはすべて拒否します（終了コード3）。有料APIもモデルも使いません。
  外部への通信は、ナチュラルワールドのランナーが行う公開 drand の読み取り（GETのみ）だけです。
- 終了時（Ctrl-C を含む）には、自分で起動したプロセスをすべて止め、ポートが空いたことを確かめて `manifest.json` に記録します。
- 出力: `views/*.webm`、`grid.mp4`、`grid.html`（ffmpeg がなくても同時再生できます）、`summary.md`（国別の集計）、
  `manifest.json`（seed、コミット、バイナリと動画の sha256）。
