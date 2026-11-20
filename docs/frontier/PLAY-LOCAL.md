# Play it locally and check it yourself (TEST only, one command)

How to check the playable version (expeditions, wide land, keep capture) on your own Mac before it goes to devnet.
It uses a local chain and test keys only. No real key, SOL, devnet or paid API is ever used.
Matches main as of 2026-11-20 (through #102). Japanese: [PLAY-LOCAL.ja.md](PLAY-LOCAL.ja.md)

## 1. Install once

The script installs nothing. If something is missing it prints the name and how to get it, and stops.

| What | Version | Example |
|---|---|---|
| Rust (rustup) | 1.89.0 and 1.95.0 | `rustup toolchain install 1.89.0 1.95.0 --profile minimal` |
| cargo-build-sbf and platform-tools | 3.1.9 / v1.52 | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"` |
| Node.js | 20 or newer | `brew install node` (fine as is when `node -v` says v20 or more) |
| git, python3 | macOS standard | `xcode-select --install` if absent |
| Free disk | 20 GiB or more for the first build | |

The first build fetches crates over the network. While you play, the keeper reads public drand randomness over HTTPS.

## 2. One command

Run it at the top of the repository. It checks the tools, builds (skipped when nothing changed), starts a world and
opens `http://localhost:41920/` in the browser. The first build takes about 3 minutes; later starts take seconds.

```bash
scripts/play-local.sh                 # a kept world (a turn is 10 min; stop it and continue with --resume)
scripts/play-local.sh --demo          # the 15-minute capture demo (×60, a turn is 10 s; not kept)
scripts/play-local.sh --wide          # the wide version (the rim and the wide land; ×60; not kept) → §4
```

There are three worlds. All of them have fog of war (§5), and the AI residents are at war by default.

| World | Clock | Kept | Good for checking |
|---|---|---|---|
| Kept world (default) | natural (a turn is 10 min) | yes (`.local/play-local/kept/`, the test key in the browser) | join, village, build, train, muster; stop and continue |
| `--demo` | ×60 (`--speed` 10–60) | no | march on a keep, clash, capture in 15 minutes |
| `--wide` | ×60 (`--speed` 10–60) | no | rim village → wide village → expedition → march inside the wide land |

Options:

| Option | Meaning | Not together with |
|---|---|---|
| `--resume` | continue the kept world started last (same browser, same port, same number of AI residents) | `--fresh` `--demo` `--wide` `--random-map`, another `--port` / `--ai` |
| `--fresh` | start a new kept world (the same as giving nothing) | `--resume` `--wide` |
| `--demo` | the 15-minute capture demo | `--resume` `--wide` |
| `--wide` | the wide version (§4) | `--demo` `--resume` `--fresh` `--two` |
| `--random-map` | give the new world its own map. Without it **every local world has the same map** | `--resume` |
| `--ai N` | AI residents, 0–4 (default 2). **At war by default**: they march on other nations' reachable keeps and siege them (one action per resident per turn) | |
| `--ai-peaceful` | the AI residents do not march on keeps (build, harvest, train, muster; in `--wide` they still take rim and wide villages and send expeditions) | |
| `--two` | two people in one world (§3.1) | `--wide` |
| `--speed N` | the clock of `--demo` / `--wide`, 10–60 (default 60) | a kept world |
| `--minutes N` | minutes until the world's processes stop, 15–240 (default 90) | |
| `--port BASE` | the page's port (default 41920). It uses 22 ports from BASE (14 with `--ai 0`), all within 41000–41999 and clear of 41904–41907 and 41970 | |
| `--lang ja\|en` | the language of the script's messages (the page: its top-right button) | |
| `--no-open` `--no-build` `--rebuild` `--check-only` `--print-plan` | do not open / never build / always build / check only / print the settings and the launcher command, and exit | |

- The AI residents' nations are fixed: the first joins Borealis, the second Ember, the third Cinder, the fourth Fjordal.
  Pick **a nation without an AI** (with `--ai 4`: Aster or Dunmar) and you never compete with one for a village site.
- `--random-map` starts the world at a randomly picked earlier time, and the program derives another genesis seed by its
  unchanged rules.
- Stop it with **Ctrl-C** in the terminal (§6).

## 3. The 15-minute check

`--demo` takes you through 1–8. In a kept world do 1–5, then stop and continue as in §6 (at 1× a mustered host can
move only once its turn is settled: about 17 minutes later).

1. **Join**: 「世界を開始（保存された世界は続きから）」 (with `--demo`: 「新しい世界を開始」) → 「国を選ぶ」 → pick a flag, then
   press 「（nation）で始める」. The first village is placed for you. No key card and no wallet prompt appears.
2. **Village**: 「ここが、あなたの村です。」 means it worked. Look at 「鉱石 +2」 above the map. A village with
   「地形の鉱石なし」 can only grow to about 600 troops.
3. **Build**: 「最初の建設を選ぶ」 → the farm's 「建てる」. It finishes in about one (in-game) minute.
4. **Train**: 「訓練」 in the bottom bar → 「最大 500」 → 「槍兵 500 を訓練する」. It finishes at once.
5. **Muster**: 「兵」 on the village screen → 「全部（500）」 → 「編成する」. When it says
   「この州はまだ前のターンの決着が済んでいません」 you **may press anyway**: the muster waits and is sent once, as soon as
   the province is ready (no need to press again; it is withdrawn if the unit or the number changes). 「立っている 1」
   means the host can move.
6. **March on a keep**: press the guide at the top right when it says 「届く砦を見る」 (if it stays on
   「軍勢の準備を確かめる」, open 「国と領土」 in the bottom bar once). Pick a keep's row and press 「確認した命令で出発」.
   While the province is settling, the same order is sent once, as soon as it can be. 「最初の出陣」 means it left.
7. **Check the clash**: on the arrival turn 「戦闘 … 衝突が決着しました」 appears. 「報告」 → 「このブラウザで確かめる」;
   「一致：このブラウザで計算し直した結果はチェーンの記録と同じです」 means it was recomputed and agrees.
   After the notice is gone, the 「報告」 button stays in the list under 「その他」 in the bottom bar.
8. **Capture**: hold the keep's tile for 72 turns (about 12 minutes or more at ×60; about 12 hours at 1×). 「砦を保持中」
   and the round number on the keep, or 「奪取まで N/72 ターン」 in the clash report, show the progress.

Good to know:

- **There is no centre (a rule of local worlds only, #88).** The six ring-1 provinces are ordinary land, each starting
  with a keep held by some nation (on the usual map: one per nation). Heartland keeps (rings 2–3) are protected and
  cannot be taken, but **ring-1 keeps can be contested**. In a kept world too the AI residents march there (in the #98
  check: departures on turn 8, clashes on turns 12–13); when your own nation's keep is attacked, 「国と領土」 says
  「他国が占拠を進めている、あなたの国の砦 … 守りに向かう」. Only the middle province (0,0) is 「第0輪（中央・州なし）」: never
  a destination or a road. A first village can only stand in ring 2 or further out.
- **Because of the fog, the keep list shows only the other nations' keeps you can see** (§5). 「見えている他国の砦で、
  この軍勢がいま届くものはありません。」 is not a defect.
- In a 1× kept world you can see sieges but hardly a capture (72 turns = 12 hours). Check captures with `--demo` or
  `--wide`.

### 3.1 Two people in one world (`--two`)

Normally every browser (address) gets its own world (two at once at most). `--two` puts two people in one world.

```bash
scripts/play-local.sh --two            # a kept world for two
scripts/play-local.sh --demo --two     # the 15-minute capture demo for two
```

1. The first person presses 「世界を開始」 at `http://localhost:41920/`. It says 「もう一人のプレイヤーを待っています」 and
   waits (about 4 minutes; after that, press again).
2. The second person opens the same address in **another browser** (or profile), or in the same browser
   **`http://127.0.0.1:41920/`**, and presses the same button (one test key per browser and address).
3. With both there, one world starts; each picks a nation and places a village.
- `--resume` brings the same two back (`--two` is not needed). Open it in the same browser at the same address as before.
- A kept world started for one person cannot become a two-person world later (start a new one with `--fresh --two`).
- When either presses 「世界を終了」 it stops for both. A third person cannot join. `--wide` is for one person.

## 4. Check the wide land (`--wide`, about 60–90 minutes)

```bash
scripts/play-local.sh --wide --ai 4 --minutes 180
```

During the world's setup (about 20 seconds) the program's own instructions grow the map to ring 128 (the rim) and open
the wide land beyond it (rings 129–131, 108 provinces). The game starts around turn 140, at ×60 (a turn is 10 s).
The default 90 minutes may not reach step 4 below, so add `--minutes 180`.

1. **A rim village**: pick a nation without an AI at 「国を選ぶ」; the first-village candidates list **rim (ring 128)
   provinces first**. Start as offered. If the village stays 「仮の村」 (provisional), one action of your own, e.g.
   「収穫する」, confirms it.
2. **A wide village (about 30 minutes at ×60)**: the village screen's 「広い土地に村を出す（テスト）」 shows the cost
   (1,200 wood and more) and the candidate provinces. Once the stores hold it, press 「ここに村を出す」. The claim is
   decided at the end of the turn and the village is drawn on the map with your nation's sigil. Inspecting that
   province shows 「あなたの村（広い土地）」 and 「この村を開く」.
3. **An expedition (rim → wide land)**: train and muster in the rim village (§3 steps 4–5), select the host and press
   「境界への道を準備」. Press the dashed tiles on the map to extend the road beyond ring 128 → enter
   「到着ターンの候補」 → 「地形・時間を確認」 → 「出発条件を確認」 → 「出発する（ローカルプレイ）」. When the arrival turn
   ends, the world's keeper opens the seal and settles it.
   - Enter the arrival turn **before** 「地形・時間を確認」 (changing it afterwards means starting over).
   - The road can be drawn regardless of terrain. If a mountain refuses it, draw another road.
   - The bar button says 「送信しません」 (does not send), but in local play the card's last button really departs.
4. **A march inside the wide land (wide → wide)**: open the village of step 2; it has the card
   「広い土地の軍勢（テスト）」. Pressing 「次の一手（広い土地）」 once per turn goes one step at a time: train spearmen →
   muster a host → march on the next province's keep (the card shows the reason). A new village's stores start empty,
   and its muster is refused for a few minutes until its province has caught up. Staying on a keep for 72 turns takes it.
- **What you see**: the wide land is drawn on the ordinary map and on 「全体図」, outside its six corners, **as far as you
  have seen it** (fog). 「支配する州」 and the standings also count rim and wide-land keeps (#102).
- **The AI residents** also take rim villages, save up, claim wide land, send expeditions and wage war. Their battles
  are on other nations' rims, so the fog hides almost all of it; only an attack on your own nation's keep shows in
  「国と領土」.
- **To watch an AI capture**, `--wide --speed 15` (a turn is 40 s) is the steady choice (the #102 check: standings kept
  up, and a capture reached them about 90 turns after the start). A wide village's cost then takes about 2 hours to save.
- The faster the clock, the further this machine's load makes the world trail (§8). Stop other heavy work while you test.

## 5. Fog of war (every local test world, #93)

A player's view, as in Civ. It is display only: the local chain's records stay public and nothing changes for devnet.

| | What you see |
|---|---|
| In sight now | around your villages and hosts, around your nation's villages and the provinces your nation holds. Allies do not share sight |
| Seen before | stays as last seen, dimmed (villages, keeps and their holders). Kept in this browser |
| Never seen | blank on the map and on 「全体図」: no terrain, village, keep or nation colour |
| Other nations' hosts, marches, clashes, contests | only where you see now; no afterimage |
| An enemy marching on your village | announced (「来襲」) when it leaves from a place in sight, or from 3 turns before arrival |

- The keep list, the inspector, the chronicle, the notices and the minimap follow the same rule.
- In a fog world the map's 「記録」 view (every recorded province) and the link to the spectator page are **not shown**.
- One switch: `LOCAL_FOG` in `permutation-server/web/frontier/map/fog.mjs` (`false` = no fog). The radii and the like
  are `FOG_RULES` in the same file. Devnet, the spectator page and the practice page have no fog.

## 6. Stop it, continue tomorrow

1. To stop, press **Ctrl-C** in the terminal that runs the script. It closes the world, then prints where the logs are.
2. A kept world continues the next day on the same Mac in the same browser. Its clock stands still while stopped.

   ```bash
   scripts/play-local.sh --resume
   ```

   The same address opens; press 「世界を開始（保存された世界は続きから）」 and you are back in your village.
- `--demo` and `--wide` worlds are not kept. Close the browser tab after a stop. **Do not reload the page** while
  playing them (the test key lives in memory only; you could not get back into that world).
- After a `git pull` that changes the program, the old world cannot continue. The script says so; start again with `--fresh`.
- `--resume` opens only the kept world started last. To go back to an older one, write its folder
  (`…/.local/play-local/kept/<date-time>`) into `.local/play-local/last-kept`.
- A world's processes stop after 90 minutes by default (`--minutes`). A kept world still continues with `--resume`.
- To delete the test key, press 「このブラウザに保存した試験用の鍵を消す」 in the page's panel. A world's folder stays until
  you delete it.

## 7. Local only, and the same as devnet

| | Local (this script) | The devnet playable version (not deployed yet) |
|---|---|---|
| Program | a local-only `.so` (program id `[0x45; 32]`, never deployable) | the devnet `.so` (another build; the local features are not in it) |
| Centre | **none** (the world's own Season byte `centre` = 1) | the presets keep the centre (the `CENTRE_PLAYABLE` switch is r0ze's) |
| Village that may claim wide land | from a Hamlet (`--wide` only: `outpost_tier_min` = 0) | from a Town (the presets say 1) |
| First village on the rim | test participants settle first in the setup; the keeper settles the claim | in progress in #104 (draft) |
| Expedition rim → wide land | works (the 0x4804 expedition, #92) | the same instructions are in it |
| March wide → wide, capture of a wide keep | works (the local-only feature `localnet-wide-depart`, #94) | **closed** (WideDepart) |
| Clock | can run ×10–×60 (a TEST clock) | the natural speed only |
| AI residents at war, the keeper opening seals | the launcher's TEST machinery | none of this launcher's machinery |
| Fog | yes (display only) | no |

Heartland protection of keeps, the 72-turn capture, the clash computation and the costs of villages, building and
training are the same rules as devnet.

## 8. Known problems (2026-11-20, main)

- **Contested provinces trail the chain under load.** At ×60, minutes after you join, every province can fall 10–24
  turns behind (the #102 check, a loaded Mac). Meanwhile a muster or a departure waits; the page says 「この州の決着が N
  ターン遅れています。このマシンの負荷が高く…」 and sends it once when the province has caught up. No need to press again.
- **At ×60 a march whose reveal window (about 10 s) was missed stops its province.** The siege count stands still, your
  own host heading there stays on 「位置を読み込んでいます」, and 「支配する州」 and the standings stop at that turn (the
  #102 check: 3 times in one ×60 world, 0 times at ×15). Ordinary marches are being fixed in #105 (draft). A missed
  wide-land expedition has no settlement in the program; that waits on r0ze (§−2.4f (d)).
- **A sieged province advances only about one turn a minute** (a sixth of the chain at ×60; the #105 check). After a
  capture it catches up quickly. The standings' 「第 N ターンまでの確定した得点」 is the slowest province's turn.
- **A rim village that stays 「仮の村」** is confirmed by one action of your own (e.g. 「収穫する」), not at the
  「遅くとも…」 time the screen states.
- **The AI residents spend many turns on refused sends** (e.g. training the stores cannot pay). They look slow; it is
  by the rules. In a ×60 `--wide --ai 4` world an AI stops after 256 sends (about 45–60 minutes in).
- A wide claim offers free sites only. The third village's cost (2,400) does not fit a Hamlet's stores (cap 2,000).
- The expedition card does not look at terrain (a road over a mountain is refused at departure).
- The 「記録」 view is not shown in a fog world (it is with `LOCAL_FOG` set to `false`).

## 9. Trouble, and where to report

- Where the logs are:
  - a kept world: `.local/play-local/kept/<date-time>/` (`launcher-<date-time>.log`;
    `persist/<address>/starts/<n>/` has the runner, herald, relay and operators logs)
  - `--demo` and `--wide`: `.local/play-local/worlds/<date-time>/` (`launcher-<date-time>.log` and one folder per world.
    With `--wide`, `wide-land.json` lists the grown rings and opened provinces, and the first line of `runner.out`
    states under `local_rules` which bytes differ from the preset)
  - the launcher command is in `command.txt` in the same folder.
- "ports in use": choose another `--port` (e.g. `--port 41450`), or stop the earlier world.
- Report through a GitHub Issue (r0ze998/wylls), with a screenshot and the folder above.
