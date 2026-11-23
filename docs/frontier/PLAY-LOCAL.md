# Play it locally and check it yourself (TEST only, one command)

How to check the playable version (expeditions, wide land, keep capture) on your own Mac before it goes to devnet.
It uses a local chain and test keys only. No real key, SOL, devnet or paid API is ever used.
Matches main as of 2026-11-23 (through #187; #173–#182 added: tab and setting presses no longer make the page forget a wide village's march #173, the next army offered after a capture or a wipe-out #176 and the text fixes of #175 → §3 step 6 and §4, external AI residents in `--wide` sending the wide land's orders #178 → §11. #177 and #179–#182 are devnet and verifier changes; local play is unchanged by them → §7. #184, fix-loop11: a departure the chain refuses no longer stays under 進軍, the W2 wait goes on while another village is open, the cap line also comes while the second march is followed → §4. #183: the wide-claim card quotes the program's settler cost, 800 for a second village → §4 step 2. #187: text fixes for first-time players (how long a keep must be held, the guide's line in a world that goes on, 伐採場, the search hint) → §3 step 8). What is left: §8. The devnet playable version went out on 2026-11-23; how to play it is in [PLAY-DEVNET.md](PLAY-DEVNET.md). Japanese: [PLAY-LOCAL.ja.md](PLAY-LOCAL.ja.md)

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
scripts/play-local.sh --coexist --demo --two   # ② rights (stock swap), the whole loop for two (×60; not kept) → §10 (⑨/⑩: §12, ① requests: §13)
scripts/play-local.sh --demo --external <address>   # admit an external AI resident (×60; not kept) → §11
```

The wide version is started with `--wide` alone (given with `--demo`, `--resume`, `--fresh` or `--two` it stops and names
which; nor with `--coexist`; `--ai`, `--ai-peaceful`, `--random-map`, `--speed`, `--minutes`, `--port`, `--external` and
`--no-coop-board` go with it).

There are three worlds. All of them have fog of war (§5), and the AI residents are at war by default. `--coexist` is
not a fourth world: it runs a kept world or `--demo` on the program that carries ②+⑨+⑩ (② rights §10; ⑨ workshop lending,
⑩ custody and seizures §12; ① request deliveries §13). `--external` is no world kind either: it admits external AI residents
into a kept world, `--demo` or `--wide` (§11).

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
| `--wide` | the wide version (§4) | `--demo` `--resume` `--fresh` `--two` `--coexist` |
| `--random-map` | give the new world its own map. Without it **every local world has the same map** | `--resume` |
| `--ai N` | AI residents, 0–4 (default 2). **At war by default**: they march on other nations' reachable keeps and siege them (one action per resident per turn) | |
| `--ai-peaceful` | the AI residents do not march on keeps (build, harvest, train, muster; in `--wide` they still take rim and wide villages and send expeditions) | |
| `--two` | two people in one world (§3.1) | `--wide` `--external` |
| `--coexist` | a world with ②+⑨+⑩ (§10, §12; ① request caravans only here, §13): a kept world or `--demo`; works with `--ai` `--two` `--random-map` `--resume` `--external` | `--wide` |
| `--external ADDR[,ADDR]` | admit up to two external AI residents by their **public addresses** (§11; never a key). Also starts the read-only MCP server on 127.0.0.1. A kept world, `--demo` or `--wide`; works with `--ai` `--random-map` `--coexist` `--resume` | `--two` |
| `--no-mcp` | with `--external`: do not start the MCP server | refused without `--external` |
| `--no-coop-board` | leave out the ① co-op board and ⑮'s 「称号と記録」 card (attached by default, §13) | |
| `--speed N` | the clock of `--demo` / `--wide`, 10–60 (default 60) | a kept world |
| `--minutes N` | minutes until the world's processes stop, 15–240 (default 90). A `--wide` world stops then too (before the local-perf fix a long-running wide world could run past it). To play `--wide` to the end use `--minutes 240` (§4) | |
| `--port BASE` | the page's port (default 41920). It uses 22 ports from BASE (14 with `--ai 0`); `--external` takes 8 more and the MCP server 1 (with the defaults the MCP server is on 41950, with `--ai 0` on 41942; none with `--no-mcp`). All within 41000–41999 and clear of 41904–41907 and 41970 | |
| `--lang ja\|en` | the language of the script's messages (the page: its top-right button) | |
| `--no-open` `--no-build` `--rebuild` `--check-only` `--print-plan` | do not open / never build / always build / check only / print the settings and the launcher command, and exit | |
| `--cluster NAME` | only `localnet` is accepted (any other name is refused and the script exits; it never talks to devnet or mainnet) | |
| `--coexist-node` | the page-less ②⑨⑩ node alone (for development, not for playing) | everything but `--port` |

- The AI residents' nations are fixed: the first joins Borealis, the second Ember, the third Cinder, the fourth Fjordal.
  Pick **a nation without an AI** (with `--ai 4`: Aster or Dunmar) and you never compete with one for a village site.
- `--random-map` starts the world at a randomly picked earlier time, and the program derives another genesis seed by its
  unchanged rules.
- The page opens at two addresses only: `http://localhost:<port>/` and `http://127.0.0.1:<port>/` (no other name, no other machine; §9).
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
5. **Muster**: 「編成」 in the bottom bar (or the guide at the top right when it says 「軍勢を編成する」) → 「全部」 (the whole reserve when the order goes, including a training batch that lands after the card opened; fix-loop9 LP9-5) →
   「槍兵 N をここに集める」. When it says 「この州はまだ前のターンの決着が済んでいません」 you **may press anyway**: the
   muster waits and is sent once, as soon as the province is ready (no need to press again; it is withdrawn if the
   unit or the number changes). Even in `--demo` at ×60 this wait is now rare (#146: your province is ready for a muster
   about 80 % of the time, before about 30 %; in verify-pr146 the line was absent and the order went at once; §8.2).
   The village screen's 「兵」 → 「編成する」 cannot be pressed while the province settles
   (only the bottom bar's 「編成」 waits and sends). While the host forms, the guide at the top right says
   「ガイド 3/7 軍勢の整列を待つ」 (with something to do meanwhile added as 「待つ間に：建設をひらく」 or the like). When it
   says 「軍勢の準備を確かめる」 or 「届く砦を見る」, the host is mustered.
6. **March on a keep**: press the guide at the top right when it says 「届く砦を見る」 (if it stays on
   「軍勢の準備を確かめる」, open 「国と領土」 in the bottom bar once). Pick a keep's row and press 「確認した命令で出発」.
   While the province is settling, the same order is sent once, as soon as it can be. 「最初の出陣」 means it left.
   - In a kept world that has just started (a turn is 10 min), a press at the start of turn 2 shows 「届く砦を調べています…」
     and 「始まったばかりの世界では、最初のターンの決着がそろうまで（数分）届く砦の一覧は出ません。」 until the world's first
     turn results are all in (1–2 minutes into turn 2); the list follows about 30 s later (fix-loop12; before, the page
     waited until turn 3, up to 10 minutes; loop-play12 LP12-2).
   - When the list says 「届く砦 0」 (「見えている他国の砦で、この軍勢がいま届くものはありません。」), no other nation's
     keep is in sight from your village (common with `--random-map`). The guide at the top right and the list's card then
     offer 「進軍で地図から選ぶ」 (#130). Press it, or 「進軍」 in the bottom bar, pick the ring-1 keep's tile on the map as the destination (you can
     press it while it is blank under the fog) and 「確認した命令で出発」 (the destination is called 「見えていない土地」).
     Every march spends 74 stamina (the same for any path length, nothing comes back for a short one; the cap is 120) and
     stamina returns 1 per turn: after a scouting march to a far blank tile the host has to wait for stamina (28 turns
     when it left with full stamina) before it can march on a keep (loop-play6: about 30 turns).
   - **When no host is in the village** (#176): after the host marched out, the guide at the top right says 「いま村に軍勢は
     いません。進軍の記録が締めくくられると、生き残った兵が村に戻ります（全滅していれば戻りません）。」 with 「進軍の結果を見る」.
     When the host did not come back (wiped out, or it took the keep and became its garrison) it says
     「前の軍勢は（州）で壊滅し、戻った兵はいません。」 or 「進軍できる軍勢がいません（前の軍勢は戻りませんでした）。」, then
     「砦へ進軍するには新しい軍勢が要ります：まず兵を訓練します。」 (with troops in the reserve: 「…控えの兵を編成します。」) and the
     button 「次の軍勢の兵を訓練する」 or 「次の軍勢を編成する」. The button only opens 訓練 or 編成; nothing is sent. Before #176
     the guide stayed on 「軍勢の準備を確かめる」 with no host to march. The wiped-out line has not been seen in a live world
     yet (unit tests only; verify-pr176).
7. **Check the clash**: on the arrival turn 「戦闘 … 衝突が決着しました」 appears. 「報告」 → 「このブラウザで確かめる」;
   「一致：このブラウザで計算し直した結果はチェーンの記録と同じです」 means it was recomputed and agrees.
   After the notice is gone, the 「報告」 button stays in the list under 「その他」 in the bottom bar.
8. **Capture**: hold the keep's tile for 72 turns (about 12 minutes or more at ×60; about 12 hours at 1×). 「砦を保持中」
   and the round number on the keep, or 「奪取まで N/72 ターン」 in the clash report, show the progress. A held turn counts
   whether the province's turn is resolved or skipped (the #120 check: 11 AI captures at ×60 in `--wide --ai 4`, each
   after exactly 72 held turns).
   Since #187 the keep list and the guide at the top right also say how long 72 turns are (「約 12 時間」 at 1×,
   「この世界の実時間で約 12 分」 at ×60). In a world that goes on (the kept 1× world) the guide after a capture says
   「この世界は続きます。戦期の勝敗と集計は未決定です。」 (in `--demo` and `--wide` worlds, which end, it still says
   「シーズンの終わりに、支配する州が最も多い国が勝ちます。」). Both lines are older than the decisions of 2026-11-23/24
   (no seasons; the game is won through permanent “world goals” with prizes): the flag-keeps goal has its own card under
   **Nation & territory** (section 14); the other three goals are a plan ([design 01](../design/win-conditions/01-proposal.ja.md), Japanese). The same PR made the first-building hints say 「伐採場」, as the
   village screen does, and the search's nothing-found hint is now 「州の座標（例：4,0）、見えている村の国の名前、領主の名前で探せます」
   (verify-pr187 saw them in a live world).

Good to know:

- **There is no centre (a rule of local worlds only, #88).** The six ring-1 provinces are ordinary land, each starting
  with a keep held by some nation (on the usual map: one per nation). Heartland keeps (rings 2–3) are protected and
  cannot be taken, but **ring-1 keeps can be contested**. In a kept world too the AI residents march there (in the #98
  check: departures on turn 8, clashes on turns 12–13); when your own nation's keep is attacked, a notice says
  「州 P,Q の砦を （国）が攻めはじめた／あなたの国が守っている」. 「国と領土」 lists it under 「他国が占拠を進めている、
  あなたの国の砦 … 守りに向かう」, also when no host of yours can reach that keep (it then adds 「いまのあなたの軍勢では届きません。」; #130). Only the middle province (0,0) is 「第0輪（中央・州なし）」: never
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
scripts/play-local.sh --wide --ai 4 --minutes 240
```

The wide version is started with `--wide` alone (no `--fresh`, `--resume`, `--demo` or `--two`; the table in §2).

During the world's setup (about 20 seconds) the program's own instructions grow the map to ring 128 (the rim) and open
the wide land beyond it (rings 129–131, 108 provinces). The game starts around turn 140, at ×60 (a turn is 10 s).
The default 90 minutes may not even reach step 2 below, so add `--minutes 240` (the maximum): saving a wide village's
cost took 36–75 minutes and a keep is held for 72 turns, 12 minutes or more (measured in fix-loop10, verify-pr173 and
verify-pr175 at load 60–160).
In the wide version every page that presses 「新しい世界を開始」 gets **a world of its own** (a second page cannot enter
the first page's world; two at a time, a third is refused with `WorldLimit`; verify-pr176).

1. **A rim village**: at 「国を選ぶ」 pick a nation without an AI (with `--ai 4`: Aster or Dunmar) and press
   「（国の名前）で始める」. You do not pick the place: the page files a village on a **rim (ring 128) province**
   (「辺境の村を申し込んでいます…」 → 「辺境の村の申し込みを送りました（ターン N、M ターン前）。世界の進行役がターンの終わりに決めます。…
   このページは待ち続けます。押し直す必要はありません。」), and a few turns later (3–5 turns in verify-pr130; under heavy load
   about 60 turns / 10 minutes; **no need to press again**) 「（名前）の集落ができました」 appears. While the village name carries 「仮」 (provisional), press 「収穫する」 on the
   village screen once to confirm it (「…が確定しました」). A rim village has no 「初めての建設」 (one-minute first
   build): the farm takes 1 h 30 min (about 1.5 minutes at ×60).
   - 「（国の名前）で始める」 takes on one press (#130; each of the 8 joins in verify-pr130 took one). While the page is
     reading the village sites the button reads 「村を準備しています…」 and cannot be pressed.
   - If a card 「留守のあいだ：この端末では、このシーズンとウォレットで確認した記録がありません…」 comes first, close it with
     「確認した」 (the world starts around turn 140; it is not a defect).
2. **A wide village (30–60 minutes at ×60; 75 under heavy load)**: the village screen's 「広い土地に村を出す（テスト）」 shows
   the cost — the program's price, for a second village 「費用（村の蔵から）: 食料 800 · 木材 800 · 石材 400 · 金 200」 — and the
   candidate provinces. Once the stores hold that amount, 「ここに村を出す」 can be pressed (until then the card says
   「足りません: …」 and the button is off). The claim is decided at the end of the turn and the village is drawn on the map
   with your nation's sigil. (Until #183 the card asked 1,200 / 1,200 / 600 / 300 and kept the button off until the stores
   held that much; verify-pr183 claimed live with exactly 800.)
   - While the first village's name still carries 「仮」 the program refuses this claim (NotFinal). Press 「収穫する」 once
     first to make it final (step 1; the card does not check this).

   Once the village exists, the easiest way to
   open it is the 「W2」 button under the village plate at the bottom left (it opens 「遠方の村 第129輪（枠 2）」);
   inspecting that province on the map → 「あなたの村（広い土地）」 → 「この村を開く」 works too.
   - Training (§3 step 4) spends the stores' food and gold. Claim the wide village first, then train: the wait is
     shorter.
3. **An expedition (rim → wide land)**: train and muster in the rim village (§3 steps 4–5), select the host in the
   bottom bar (e.g. 「槍兵 500」) and press 「境界への道を準備」.
   1. Draw the road one step at a time with the direction buttons (東・北東・北西・西・南西・南東) or the dashed tiles
      on the map, until 「道から決まる終点」 is a wide-land province (ring 129 or more). Only the provinces of rings
      129–131 that the map draws are open. When the road ends on an unopened one, the card says at once 「終点の州 P,Q は、
      この世界ではまだ開いていません… いちばん近い開いた州は …（N 州先）です。」.
   2. 「地形・時間を確認」. 「山や水のマスには進めません (N)」 means step N is impassable: 「一歩戻す」 or 「道を消す」
      and draw another road (the card draws roads without looking at terrain). A passable road shows
      「到着候補：ターン A〜B」 and the button that fills in the arrival turn (step 3). The card scrolls its newest result
      into view by itself. When the world's clock moves during the read, the page reads again by itself up to 2 times
      (「…読み直しています（1 / 2 回目）…」); if that still fails it says 「読み取りの途中で世界の時計が進んだため…
      もう一度押してください。」: press again. A read's result now stays until you change the road, with
      「この道を読み取った結果です。道を変えるまで出ています。」 (#137; in loop-play8 an impassable road's 「山や水のマスには進めません
      N 歩め（西）のマスで止まります。…」 was still there after 15 s).
   3. Press 「間に合う候補（ターン N）を使う」 (at ×60; at 1× it is 「最も早い候補（ターン A）を使う」). At ×60 the proposal is
      the earliest turn A plus the turns the clock moves while you check and send (3) plus the province's settle lag.
      The bare earliest turn had already gone by when the next 「出発条件を確認」 came back, and was refused every time
      (loop-play6 LP6-1, fixed by #130; in verify-pr130 no arrival turn was refused in 5 departures). The press fills
      the arrival field and the page reads the road again. The field for typing an arrival turn yourself is inside
      「詳細」 at the bottom of the card (normally not needed).
   4. 「出発条件を確認」 → when it says 「この読取時点では、軍勢と村の出発条件を満たしています。」, press
      「出発する（ローカルプレイ）」.
      - At ×60 「…満たしていません。 (NotResident)」 is common (the province is settled for only part of each turn).
        **This is the one place where you do press again**: wait 1–2 s and press 「出発条件を確認」 again. The check only
        reads; it sends nothing (and does not count against the relay's send limit). In verify-pr130, 3 of 5 departures
        were refused on the first press and passed on the second or third (before #130: 17 presses / 18 s in
        loop-play6, 16 presses / 27 s in fix-loop5; before #109: about 60 presses, about 10 minutes).
      - At ×60 a check's result leaves the screen at every read of the world's clock (0.3–2 s; verify-pr117 V117-1).
        Right after it has gone, 「出発する」 still works as long as the road and the arrival turn are unchanged: the
        page reads the conditions again and departs if they hold (#130). If the button is no longer shown, press again
        from 「出発条件を確認」.
      - When it does not work:
        「到着ターンの候補が、記録から計算した範囲に入りません。」 = the arrival turn is too early (press step 3's button
        again, or type a later turn in 「詳細」). 「到着ターンはまだ入っていません。「地形・時間を確認」を押すと…」 = the
        arrival field is empty (go back to step 2).
   5. 「出発が確定しました（ターン N に到着予定・移動枠 0）」 means it departed.
      - **If the card stays on 「送信しました。確定はまだ確認できていません。署名 …」**, wait for the page's own check or press
        「結果を照合する」. When the chain refused the departure after it was sent (NotResident, when the turn changed between the
        check and the send; loop-play11 LP11-1), what the page says and how to send again is under "The chain can refuse a
        departure after it was sent" below (since #184 a refused expedition does not stay in the 進軍 list).
   - **The world's keeper opens the seal.** After the arrival the map tag goes 「ターン N に到着」 → 「到着 · 開封を
     待っています」 → 「到着 · 封は開きました · 結果の確定を待っています」, and once the target province has caught up the
     march screen says 「結果を受け取りました　留まる：軍勢は広い土地の州に立っています（兵 500）」. Just wait (in fix-loop5,
     verify-pr117 and loop-play6 the keeper opened it inside the window every time).
   - **An expedition that lands on a wide keep's tile holds it** (72 turns take it). The march card follows the hold
     (fix-loop9 LP9-2; it reads that one province about once a turn): 「遠征の軍勢が州 P,Q の砦を占拠中です：n / 72 ターン。…」,
     then 「砦を奪いました：軍勢は砦の守備兵になりました（砦の守備兵 N・ターン T の記録）」 and 「結果：遠征の軍勢が州 P,Q の砦を奪いました。…」,
     or 「結果：州 P,Q の砦は奪えませんでした。…」. The number in brackets is the garrison in the chain's keep record
     (fix-loop10 LP10-5; before, the card showed the strength the host arrived with). A capture leaves half of the holding
     host in the keep, or all of it when the rest would be under 100 (loop-play10: arrived with 1,289, garrison 644;
     fix-loop10's check: arrived with 189, garrison 177). The result is also said once as the notice at the top of the
     screen (checked for LP10-6: it is the page's single notice slot, shown until the next notice replaces it; there is no
     list to read it again, so if you miss it, look at the march card). After a capture, a wiped-out expedition (「全滅：軍勢は失われました」) or a host gone from the keep's tile, the card adds that the next expedition needs a new host and a 「村で次の軍勢を作る」 button (it only opens that village's 編成 or 訓練 card; nothing is sent; w2-wipeout). When the host that takes the keep has 200 troops or more, the half that does not become the garrison stays on the keep's tile as a host, but the page has no order for it (there is no order for a rim village's host standing in the wide land; verify-pr176: arrived with 488, garrison 242, 242 on the tile; whether it should be usable is undecided). The host sees from its tile, so the province is drawn on the map
     (the wide land draws no keep icon or host figure yet: verify-pr162), and 国と領土 lists it under 「あなたの軍勢が着いている他国の砦」. (loop-play9: the keep was taken on chain and the page
     said nothing.)
   - As a backup, on the arrival turn this page can open the seal too (「封を開けるか確認する」 inside the boundary card →
     「封を開く（ローカルプレイ）」). Before #105, at ×60 on a loaded machine, the keeper did miss the window of about 10 s
     (§8). 「封を開ける期間が終わっています。(RevealWindowClosed)」 means that expedition will never settle.
   - While the card says 「送信しました。確定はまだ確認できていません」, the next host's 「出発する」 is not shown. Since
     fix-loop11 the page checks the result itself on each read and the line turns into confirmed or refused (verify-pr184:
     confirmed within seconds without a press). If it does not change, press 「結果を照合する」 under it once.
   - **The chain can refuse a departure after it was sent** (NotResident when the turn changes between the check and the
     send). The page checks the result itself each time it reads the 「進軍」 list; when it was refused it says once at the top
     「遠征の出発はチェーンで断られました：送るあいだにターンが変わり、出発する州の前のターンの決着がまだでした（NotResident）。軍勢は村にいます。…」
     (EN: "The chain refused the expedition's departure: … (NotResident). The host is still in the village. …"). The card says
     「出発はチェーンで断られました：…。軍勢は出発していません（村にいます）。進軍の一覧にも出しません。」 and the expedition leaves the
     「進軍」 list. The host is home: read again with 「出発条件を確認」 and you can depart again (fix-loop11 LP11-1; before, a refused
     expedition stayed in the list as 「この遠征の記録が見つかりません」 or 「到着しました。封が開けられるのを待っています」, and the reason
     was raw text such as `{"InstructionError":[4,{"Custom":26}]}`).
   - The bar button says 「送信しません」 (does not send), but in local play the card's last button really departs.
4. **A march inside the wide land (wide → wide)**: open the village of step 2; it has the card
   「広い土地の軍勢（テスト）」. Pressing 「次の一手（広い土地）」 goes one step at a time: train spearmen → muster a
   host → march on the next province's keep. **Press once per step, then wait** (three presses in all).
   - Pressing the bottom bar's tabs (村, 軍勢, 進軍, 国と領土, その他, 地図) or the settings under その他 no longer makes the
     card forget its march (#173; before, one tab press was enough: the card stayed on 「軍勢は進軍に出ています。」 with no
     result and the count for "at most 2" went back to 0. verify-pr173: 40+ presses, and the card still followed the
     arrival → 「占拠中 18 / 72」 → the capture). A page reload still forgets it (§6).
   - The card's wait goes on when you close this wide village's screen and open the rim village or another tab (#184,
     fix-loop11 LP11-2; see the province-lag item below. verify-pr184: with W2 closed and 「進軍」, 「国と領土」 and 「村」 open,
     it checked 2 → 28 times and sent the train by itself).
   - The village's header says 「この村の記録の表示は読み取り専用です。命令は、下の「広い土地の軍勢（テスト）」だけが
     送ります（訓練・編成・進軍）。収穫・建設・隊商・追いつかせる は、この村には送れません。」 (the records are
     read-only; only the card below sends orders; #130).
   - The card states each step's reason in the page's language (#130; English on the English page):
     「広い土地の村で槍兵 N を訓練します。」 (train) → 「広い土地の村で槍兵 N の軍勢を編成します。」 (muster) →
     「軍勢（兵 N）が州 P,Q の砦へ進軍します（（国）が保持）。到着はターン N です。」 (march). Once the host is out it
     says 「軍勢は進軍に出ています。」: nothing to do now. Right after the march is sent the card does not read again by itself;
     one more press of 「次の一手（広い土地）」 shows the result or where the march is and starts following it about once a turn
     (that press sends nothing; verify-pr184).
   - When the keep this village's host reaches was already being held by your own expedition (the march of step 3), the
     card does not say 「奪いました」 (fix-loop10 LP10-2): 「結果：州 P,Q の砦はあなたの国のものになりました（ターン N に確認）。
     あなたの遠征の軍勢が先に着いて占拠を進めていた砦です。この村の軍勢だけで奪ったのではありません。」 (the keep is now
     your nation's; your expedition reached it first; this host did not take it alone). When the keep was already your
     nation's on arrival: 「結果：州 P,Q の砦は、この村の軍勢が着いたときにはすでにあなたの国のものでした（ターン N に確認）。
     この軍勢が奪ったのではありません。」. Either way the card goes on with 「この村の軍勢は、その砦のマスに着いています。…」.
   - A new village's province starts far behind the chain (loop-play4: 77 turns after the village was made;
     loop-play5: up to about 180 turns). **Do not keep pressing while the province is behind.** The card says
     「この村の州の決着が N ターン遅れています。…このページが約 1 ターンごとに自動で確かめ、送れるようになったら一手を
     送ります。」 and waits by itself (the button reads 「待っています…（押す必要はありません）」 and is disabled;
     「待つのをやめる」 stops it). The wait **goes on while another village (the rim village, say) is open**; back on the card
     you see what it last checked (fix-loop11 LP11-2; before, closing the W2 view stopped it silently and the card came back
     with an old 「N ターン遅れています」 and a live button). A page reload stops it. Other reasons it waits for: 「軍勢が整列中か休んでいます。」 and the like. A step refused because the turn changed while it was being sent (NotResident; also when the
     chain refuses it after sending), or a march send that failed once, is sent again next turn by itself (a march the chain
     refused does not count toward the 2; fix-loop11) (verify-pr117: with 「次の一手」 pressed every 2 s for 10
     minutes the page sent only 4 acts and got through train → muster → march; loop-play6: the card waited by itself
     through a 187-turn lag and sent about 3 minutes later).
   - The world's keeper opens the march's seal and catches the target province up even when it is far behind
     (verify-pr106: reveal, clash and settlement within minutes of the arrival). The bottom bar's 「進軍」 list does not show
     marches inside the wide land. Staying on a keep for 72 turns takes it. The same card follows the march (#130; it reads again about once a turn):
     「軍勢は州 P,Q の砦へ進軍中です。到着はターン N です（いまはターン M）。」 → 「到着ターン N を過ぎました。到着先での
     決着を待っています（州の決着が遅れると数ターンかかります）。」 → 「結果：軍勢（兵 N）は州 P,Q に立っています。」 plus
     the keep's state (「砦は（国）が保持しています（あなたの国は占拠できていません）。」, 「あなたの国が砦を占拠中です：
     n / 72 ターン。」 or 「砦はあなたの国のものです。」). A lost march says 「結果：軍勢は州 P,Q に残れませんでした
     （戦いに敗れました）。」. When the beaten host comes home under 100 troops (a host under 100 cannot march, and a local
     page cannot dissolve it), the card adds 「生き残った兵 N が村に戻っています。…新しい軍勢を作ります。 次の一手：槍兵 100 を
     訓練します（兵 100 そろうと編成できます）。」 and 「次の一手を送れます（新しい軍勢づくり）。自動では送りません。…」: press
     to train, press again to muster; the new host then marches as the first did (fix-loop9 LP9-1; before, the card waited
     for good on 「軍勢が整列中か休んでいます。」). When the host was **wiped out with nobody home** the card says 「結果：軍勢は州 P,Q
     に残れませんでした（戦いに敗れました）。 軍勢は全滅しました：生き残った兵はなく、村に戻った兵はいません。…新しい軍勢を作ります。 次の一手：…」;
     when it **took the keep and stayed as its garrison**, 「砦を奪った軍勢は、砦の守備兵としてそこに残りました。…次の砦へ向かう新しい軍勢を
     作ります。 次の一手：…」 — both with the same 「次の一手を送れます（新しい軍勢づくり）。自動では送りません。…」 offer. The first time, a
     press of your own also only shows the result and the offer; the next press sends (w2-wipeout; before, both cases waited
     「its host left」 for good and a press sent nothing). A village sends at most 2 marches inside the wide land in a test world. After
     the second is sent, the card says where that march is (on its way, being decided, standing beside a keep, …) followed by
     「この村からの広い土地の中の進軍は、テスト世界では 2 回までです。これ以上の進軍は計画しません（辺境の村からの遠征は続けられます）。」;
     once it has ended (beaten, wiped out, or the keep taken and the host its garrison), the last result and the same sentence
     (fix-loop11 LP11-4; before, a second host standing beside a keep it could not take never got the sentence; verify-pr184 saw it
     after 「…進軍中です。到着はターン 527 です…」). While the village's province lags a few turns, the card shows
     「この村の州の決着が N ターン遅れています。…」 instead (neither sends a third march). During a wait, the count in
     「占拠中です：n / 72 ターン」 is the last one read while the province lags and cannot be read (verify-pr173: 52 / 72 from
     turn 429 to 448). (verify-pr130 saw 「…進軍します」 → 「…過ぎました…」 → 「結果：軍勢（兵 76）は州 -63,-66 に
     立っています」).
- **What you see**: the wide land is drawn on the ordinary map and on 「全体図」, outside its six corners, **as far as you
  have seen it** (fog). 「支配する州」 and the standings also count rim and wide-land keeps (#102).
- **The AI residents** also take rim villages, save up, claim wide land and wage war (loop-play6: 4 wide villages, 70
  departures on keeps). Their battles are on other nations' rims, so the fog hides almost all of it; only an attack on
  your own nation's keep is announced. The AI's rim → wide expeditions land too (#130: 10 of 10 in verify-pr130; before it, 0 of 454 in loop-play6), and so
  do their marches inside the wide land.
- **To watch an AI capture**, `--wide --speed 15` (a turn is 40 s) is the steady choice (the #102 check: standings kept
  up, and a capture reached them about 90 turns after the start). Since runner-throughput the standings keep up at ×60
  too (a few turns behind), but a war goes by fast there. A wide village's cost then takes about 2 hours to save.
- The faster the clock, the further this machine's load makes the world trail (§8). Stop other heavy work while you test.

## 5. Fog of war (every local test world, #93)

A player's view, as in Civ. It is display only: the local chain's records stay public. The devnet page shows the same
view (fog-devnet; runbook §7 P5).

| | What you see |
|---|---|
| In sight now | around your villages and hosts, around your nation's villages and the provinces your nation holds. Allies do not share sight |
| Seen before | stays as last seen, dimmed (villages, keeps and their holders). Kept in this browser |
| Never seen | blank on the map and on 「全体図」: no terrain, village, keep or nation colour |
| Other nations' hosts, marches, clashes, contests | only where you see now; no afterimage |
| An enemy marching on your village | announced (「来襲」) when it leaves from a place in sight, or from 3 turns before arrival |

- The keep list, the inspector, the chronicle, the notices and the minimap follow the same rule.
- **Other nations' clash reports and 「戦いを再生」** are offered only while the province's keep tile (the whole
  province when it has no keep) is in sight now; a few rim tiles in sight are not enough. Your village's province and
  the clashes your own marches arrived at are always yours to see. Opening a report out of sight says
  「この場所はいま見えていません。…」 and reads nothing. The map's clash marks (the red ring, the minimap dot,
  「このターンに衝突あり」), the chronicle's clash lines and 「最近の衝突」, and other nations' keep contests and captures
  follow the same rule (keep news your own nation is in is always shown). Other nations' map moments (「…の新しい村」,
  a host setting out, an arrival, a camp gone) play only where their tile is in sight now, and the march card's
  「近くの行き先」 lists camps only on tiles you have surveyed.
- In a fog world the map's 「記録」 view (every recorded province) and the links to the spectator page (the legend's and
  the settings' 「観戦ページ」) are **not shown**, from the first picture on (fog-devnet: before, the legend and the
  settings still linked to the spectator page until the first village).
- One switch per mode in `permutation-server/web/frontier/map/fog.mjs`: `LOCAL_FOG` (local test worlds) and
  `DEVNET_FOG` (fog-devnet: the play page of a season whose pinned cluster is `devnet`); `false` = no fog in that mode.
  The radii and the like are `FOG_RULES` in the same file. The spectator page and the practice page have no fog.

## 6. Stop it, continue tomorrow

1. To stop, press **Ctrl-C** in the terminal that runs the script. It closes the world, then prints where the logs are.
   It waits at most 20 s for the worlds to close. A world that still has not closed is named in the log, and the processes
   the launcher started are ended. To skip the wait, press **Ctrl-C** again: it ends at once (also after a world's time ran
   out; loop-play6 LP6-3, fixed in fix-loop6).
2. A kept world continues the next day on the same Mac in the same browser. Its clock stands still while stopped.

   ```bash
   scripts/play-local.sh --resume
   ```

   The same address opens; press 「世界を開始（保存された世界は続きから）」 and you are back in your village.
   If you stopped with a march out, the page no longer knows its sealed destination (it is revealed on the arrival turn):
   the guide at the top right says 「ガイド 4/7 進軍を見る」 and 「軍勢は進軍に出ています。行き先は封をしたままで、到着の
   ターン N に明かされます。…」 (fix-loop12; before, it fell back to 「軍勢の準備を確かめる」; loop-play12 LP12-3).
- `--demo` and `--wide` worlds are not kept. Close the browser tab after a stop. **Do not reload the page** while
  playing them (the test key lives in memory only; you could not get back into that world).
- After a `git pull` that changes the program, the old world cannot continue. The script says so; start again with `--fresh`.
- `--resume` opens only the kept world started last. To go back to an older one, write its folder
  (`…/.local/play-local/kept/<date-time>`) into `.local/play-local/last-kept`.
- A world's processes stop after 90 minutes by default (`--minutes`). A kept world still continues with `--resume`.
  `--resume` does not remember `--minutes`: for a long session pass it again, e.g. `--resume --minutes 240`.
- To delete the test key, press 「このブラウザに保存した試験用の鍵を消す」 in the page's panel. A world's folder stays until
  you delete it.

## 7. Local only, and the same as devnet

| | Local (this script) | The devnet playable version (on devnet since 2026-11-23; how to play: [PLAY-DEVNET.md](PLAY-DEVNET.md)) |
|---|---|---|
| Program | a local-only `.so` (program id `[0x45; 32]`, never deployable) | the devnet `.so` (another build; the local features are not in it) |
| Centre | **none** (the world's own Season byte `centre` = 1) | the presets keep the centre (the `CENTRE_PLAYABLE` switch is r0ze's) |
| Village that may claim wide land | from a Hamlet (`--wide` only: `outpost_tier_min` = 0) | the wide preset `S1_DEVNET_WIDE_7D` also from a Hamlet (0 since #104); `S1_LOCAL_7D` from a Town (1) |
| First village on the rim, wide villages | test participants settle first in the setup; the keeper settles the claim | done in #104 (the keeper's rings role opens the rim provinces, its tickets role settles the request); keeper A's `wide-tickets` role settles wide claims (#107). After the Join, the devnet page waits up to 180 s for your own record to appear before it files the rim village (#172; past that, 「もう一度確かめる」; checked offline) |
| Expedition rim → wide land | works (the 0x4804 expedition, #92) | the same instructions are in it; the departure is sent from the same card of the devnet page, paid by the connected wallet (「送る内容を確認」 → 「ウォレットで署名して送る」; #129, runbook §7 P15). Keeper A's `expeditions` role sends every step after the departure (#121) and its `wide-resolve` role keeps the wide provinces resolved turn by turn (#129). All checked offline |
| March wide → wide, capture of a wide keep | works (the local-only feature `localnet-wide-depart`, #94) | **closed** (WideDepart) |
| Clock | can run ×10–×60 (a TEST clock) | the natural speed only |
| Opening a march's seal, clash, settlement, keep capture | the keeper loop inside the launcher (TEST machinery; the keeper program is not run) | keeper A's roles (#118, #122). A held keep is resolved every turn and taken after exactly 72 (#120; #160 ran a capture by a 72-turn hold and a march there and back offline on the devnet `.so`; 12 hours of real time) |
| AI residents | yes (at war by default) | none (local only; runbook §7 P4) |
| ② rights (stock swap) | `--coexist` worlds only (§10) | not in it |
| ⑨ workshop lending, ⑩ ore custody, storehouse seizure, stopping a caravan to take or burn it | `--coexist` worlds only (preview card, §12) | not in it |
| External AI residents (⑬ / ⑤B), the read-only MCP server, `--plan` (④) | `--external` worlds only (§11) | none (admission of external residents and the MCP server are undecided) |
| ① co-op board, ⑮ title 「依頼に応えた」 | board and card in every world (`--no-coop-board` leaves them out); a caravan can deliver only in `--coexist` worlds (§13). No effect on winning, score or prize | none |
| Fog | yes (display only) | yes, the same player view on the devnet page (fog-devnet, `DEVNET_FOG`) |

Heartland protection of keeps, the 72-turn capture, the clash computation and the costs of villages, building and
training are the same rules as devnet.
A local world costs no SOL and no rent (the test keys are funded with test balances). Devnet costs and rent (since #147 and
#150 they follow the cluster's own rent rate) are in the devnet runbook (`docs/frontier/devnet/`, refreshed by #177 and #182; what a player pays: [PLAY-DEVNET.md](PLAY-DEVNET.md) §4),
not in this guide. #179 (the verifier reads declared patches), #180 (the operator's season-end tool `frontier-operator end-season`)
and #181 (the read-only deploy-day preflight `scripts/devnet/preflight.mjs`) are devnet and verifier changes too: nothing
changes in a `play-local.sh` world (the script uses none of these tools; a local world stops at its time limit or on Ctrl-C).

## 8. Known problems (2026-11-23, main through #187)

### 8.1 Still on main (after #187)

The problems loop-play6 … 9 found (LP6-1 … 15, LP7-1 … 8, LP8-1 … 11, LP9-0 … 8) were fixed by #128, #130, #137, #149, #157
and #162, and verify-pr130, 133, 137, 149 and 162 played them. The `play-local.sh` build that failed after #154 (LP9-0) was
fixed by #157, and since #159 CI checks the play-local builds on every change. The exceptions are the ones kept in the table and
notes below (the Ctrl-C cause LP6-3, the lag under load LP8-4; the rim village's long-wait text LP6-9 and the 国と領土 line after
an arrival LP7-6 were seen live only in part).
loop-play10's LP10-1 … 6 are fixed too (a tab press making the W2 card forget its march, LP10-1, by #173; the text items
LP10-2 … 5 by #175; a W2 village never raising another host after a capture or a wipe-out by #176; verify-pr173, 175, 176 and
loop-play11 played them). LP11-1 … 5, new in loop-play11 (main at #173–#180), are fixed: LP11-1, 2, 4 and 5 by #184 (verify-pr184 played them),
LP11-3 (the wide-claim card asked 1,200 for a second village) by #183 (verify-pr183 claimed live with exactly 800).
What is left is below. None is a rules question.

| Where | What happens on main | Workaround now |
|---|---|---|
| Boundary card (×60) | 「出発条件を確認」 is refused NotResident once or twice (the province is still settling) | wait 1–2 s and press again (it only reads) |
| ⑩ stopping a caravan (×60) | from the moment 「隊商を止める」 is offered you have in practice about 2 turns (about 20 s) to stop and decide (the limit is 6 turns from the turn the caravan stood; the province settles 2–4 turns late; verify-pr145) | try it with `--speed 15` (§12) |
| ⑩ seizing a storehouse | 「貯蔵庫を奪う」 can be pressed while the owner's host stands on the tile; the program refuses it (NotOnTile, as the rules say) | press it when no host of the owner is there |
| ① co-op board | after a partial delivery the board says 「依頼量に届かなかった（すべて終わり、上限で証明）」. The request stays 「受付中」 and turns to 「依頼量に届いた」 once the rest is delivered (verify-pr152) | deliver the rest and link it (§13) |
| The external residents' MCP | the MCP server reads the first world only (a second world of the same launcher has no MCP reads; verify-pr142) | test with one world |
| Boundary card | after a departure the card can stay on 「送信しました。確定はまだ確認できていません」 (2 of 5 in verify-pr130); until then the next host's 「出発する」 is not shown. Since fix-loop11 the page checks the result itself on each read and the line turns into confirmed or refused. The card also stays bound to the departed host (「カードを開き直してください」) | wait, or press 「結果を照合する」 once; reopen the card for the next host |
| Stopping | the cause of the one Ctrl-C that did not end a world hours past its time (LP6-3) is still unknown. #130 added the 20 s bound and the second Ctrl-C; in verify-pr130 all four cases ended in 0.1–2.4 s | press Ctrl-C again (§6 item 1) |
| Wide village (W2) | the card says 「この村の州の決着が N ターン遅れています。」 twice in a row | none (display only) |
| Wide village (W2) | the notice after a 「次の一手（広い土地）」 step is sent is an English sentence on the Japanese page too (e.g. “train 100 Spearmen at the wide village -66,-63 …”; verify-pr162) | none (display only; the reason on the card itself is in the page's language) |
| ② rights caravans | in the caravan form, switching the source from the storehouse to the village leaves that same village as the destination | choose the destination again |
| ② rights | opening 「権利を出す」 before the workshop is finished (about 9 turns) says 「権利を出すには、工房のある村が要ります。」 | wait for the workshop (§10 step 2) |

Small ones (nothing blocks play):
- The 「この試験世界について」 box covers the 「支配する州」 bar and the top of 「全体図」; 「たたむ」 folds it.
- For the first seconds of the ×60 nation picker the clock rate is not known yet: the intro says 「ゲーム内の 10 分」 and
  the remaining time is not shown (#149; before, 「あと約 2 時間」 and 「あと約 73 分」 alternated and the intro said 10 minutes of real time).
- Selecting a never-seen province says 「未測量 … 地形だけを図にしています。」 but the map draws it blank.
- After a wide village (W2) takes a keep, until that march's record is closed the card waits with 「砦を奪った軍勢は、その砦に残って守っています。…（自動では送りません）」;
  then it says 「砦を奪った軍勢は、砦の守備兵としてそこに残りました。…」 with the new host's step and 「次の一手を送れます（新しい軍勢づくり）。
  自動では送りません。押すと上の一手を送ります。」 (w2-wipeout; #149's text said 「…新しい軍勢の訓練から…」 would appear, but no step ever
  came and the card kept waiting). The 「結果：…砦を奪いました。」 line stays after the next training is sent (#149, LP8-5).
- The N in the expedition card's 「留まる：軍勢は広い土地の州に立っています（兵 N）」 stays at the arrival strength (verify-pr175:
  188 on the card, 171 in the chain's host). After a capture, 「（砦の守備兵 N・ターン T の記録）」 is the chain's number (#175; §4 step 3).
- The card writes 「砦を奪いました：軍勢は砦の守備兵になりました」, but of a host of 200 or more only half becomes the garrison (§4 step 3).
- In a `--wide` world the guide at the top right does not count wide-land keep captures (it looks at keeps up to ring 128).
  After a W2 village or an expedition takes a keep the guide stays on its earlier step (w2-wipeout: still 「ガイド 1/7 建設をひらく」
  after the capture).
- The short address in the ⑨ and ⑩ choices (「4dkm…7rAz」 and the like) is the owner's resident record (Citizen), not the
  owner's wallet. The page shows neither of your own addresses anywhere, so tell the options apart by village name and tile
  (loop-play11 LP11-5; §12).
- The W2 card's memory (march count and result) is one per page. With two wide villages the second would show the first's
  card (verify-pr173; today's page cannot found a third village, so it does not normally happen: §8.2).
- Under heavy load (load average 12–31) a wide village's province can stay 200+ turns behind for tens of minutes
  (loop-play8 LP8-4; a load matter, only measured in #149).

### 8.2 How ×60 behaves (after #102, #105, #109, #117, #120)

- **Contested provinces trail the chain under load.** At ×60 every province is normally two to four turns behind the
  turn bar (the runner-throughput check, `--wide --random-map --ai 4`); before that change, and on a heavily loaded Mac,
  10–24 turns (the #102 check). Meanwhile a muster or a departure waits; the page says 「この州の決着が N
  ターン遅れています。このマシンの負荷が高く…」 and sends it once when the province has caught up. No need to press again.
- **An ordinary march whose reveal window (about 10 s at ×60) is missed no longer stops its province** (#105). The
  keeper loop reveals every due march at the start of each pass and again before each village's pass; a march that
  still misses it (seen: a 3-turn march under heavy load) is settled the way the program settles an unrevealed march —
  its destination's turns are resolved without it, then SettleTransit (the program decides: routed home, or bounced) —
  and the runner says `reveal-missed` on stderr. A village's march driver stopped by a refusal reads the chain again
  after 6 steps (doubling to 96; driver steps, not passes: one per pass in a kept world, up to 4 per round of a pass
  with `--demo` and `--wide`), and the provinces where its hosts stand go back to
  the world sweep meanwhile. A host whose arrival turn is more than 2 turns past shows "Host's arrival turn N was M
  turns ago · waiting for its result". A missed wide-land expedition still has no settlement in the program; that
  waits on r0ze (§−2.4f (d)).
- **At ×60 your own province is one or two turns behind** (the runner-throughput check: median 2 on the page, at
  most 3–4; before it, median 4 and up to 8). The keeper loop now settles your home again before every AI village's
  turn, so a muster or march is usually sent on the first press, within a few seconds (the check: muster 1.8–5 s, marches
  2–14 s; the author's sessions withdrew none, the verify-pr109 session withdrew 2 of 12 marches, pressed while the home
  was 3 turns behind, and each went on the next press; one muster press in the turn's last second was refused and the
  next press, 3 s later, went through). If one is still withdrawn (「送信待ちを取り消しました…」),
  press it again.
- **With `--demo` (and `--external`) at ×60, your province is ready for a muster about 80 % of the time, and an external
  resident's about the same** (runner-throughput-2, BREAK-143-1). "Ready" is the program's rule for resident orders (muster,
  garrison, dissolve, explore): the province settled through two turns ago. Before this change it was about 30 % for your
  province and 0–6 % for an external resident's: the demo's keeper loop slept a whole 10-s turn between quiet passes,
  cranked the demo's 60 provinces one transaction at a time, and did not serve an external resident's village at all.
  Now, on a compressed clock (`--demo`, `--wide`), every player home (yours, the AI residents', an external resident's)
  is settled together in one block, first and whenever one comes due, and the loop wakes at the next turn edge.
  Measured (demo ×60, 1 AI, 1 external): yours 79 %, the external resident's 86 % (before: 30 % and 6 %; verify-pr146's re-measurement: 82 % and 88 %); at ×15:
  93 % and 96 % (before: 79 % and 60 %). It can never be 100 %: a turn can only be settled once the next turn has begun.
  Every home gets the same batch at the same moment; what remains is the province's own state. A turn with a host
  mustered at home (or an arrival) is not quiet, so it needs the real seed of the next public drand round (about 2 s at
  ×60) instead of a same-block FastForward. In these runs you trained and mustered (23–27 times) while the external
  resident, at one order per turn, mostly harvested: that is the 79 vs 86 %. With the nations swapped the gap followed
  the army, not the role or the place (verify-pr146).
  While it is not ready, the page's 「編成」 waits and sends once, as before.
- **A wide-land expedition whose reveal window was missed never settles** (the program has no settlement for it; that
  waits on r0ze). The march screen stays on 「到着しました。封が開けられるのを待っています」, and that rim village cannot
  send another expedition (「出発できませんでした（DepartRolesUnavailable）」). It happened once, before #105
  (verify-pr106, a loaded Mac at ×60; `runner.out`: `never revealed: transit 0: the reveal window of bell 262 closed
  unrevealed`). In fix-loop5, verify-pr117 and loop-play6 the keeper opened every seal in time (0 `reveal-missed`).
  If in doubt, press 「封を開く」 yourself on the arrival turn (§4 step 3).
- **A sieged province keeps up with the chain** at ×60 (the runner-throughput check: every province 5.9–6 turns a
  minute against the chain's 6; before it, 1–2). The keeper loop resolves the other provinces' and the sieges' turns in
  same-block batches. The standings' 「第 N ターンまでの確定した得点」 is the slowest province's turn: a few turns behind
  the turn bar (before: up to hundreds, e.g. turn 251 at turn 495).
- **A rim village that stays 「仮の村」** is confirmed by one action of your own (e.g. 「収穫する」), not at the
  「遅くとも…」 time the screen states.
- **The AI residents spend many turns on refused sends** (e.g. training the stores cannot pay). They look slow; it is
  by the rules. An AI no longer stops after 256 sends (#117; loop-play6: about 3,000 sends, none refused by the relay).
- **Pressing too often can no longer lock a world out (#117).** The launcher's relay remembers at most 256 commands per
  world that have **not settled yet**; a sent command stops counting once its transaction's validity (about 1 minute on
  the local chain, a little longer under load) has passed. A full limit says 「送ったばかりの命令がまだ多く決着して
  いません。送っていません。1 分ほど待ってから、もう一度押してください。」 and clears within about a minute. The march relay
  (limit 64) works the same way. Before #117 every command ever sent counted, so after 256 sends that world could never
  send again, with the false text 「今日送れる操作の回数を使い切りました…」 (loop-play5). Even so, **do not press again
  where the page says it is waiting**: a waiting muster or march and 「次の一手（広い土地）」 wait by themselves and send
  once. Pressing again is needed only for the boundary card's 「出発条件を確認」 (a read) and after
  「送信待ちを取り消しました…」.
- **A keep is taken after exactly 72 held turns** (the #120 check: all 11 AI captures at ×60 in
  `--wide --random-map --ai 4` came after 72 held turns; provinces ran 5.99 turns a minute).
- **An expedition's result**: once its seal is open, the map tag changes to 「到着 · 封は開きました · 結果の確定を
  待っています」. The result (「留まる：…」 and so on) shows once the target province has caught up.
- A wide claim offers free sites only. A third village costs food 1,200, wood 1,200, stone 600, gold 300 (the program's
  price, which the card shows since #183; before it the card said 2,400, which a Hamlet's stores, cap 2,000, never reach).
- The expedition card draws roads without looking at terrain (「地形・時間を確認」 then says 「山や水のマスには進めません (N)」).
- The 「記録」 view is not shown in a fog world (it is with `LOCAL_FOG` set to `false`).

## 9. Trouble, and where to report

- Where the logs are:
  - a kept world: `.local/play-local/kept/<date-time>/` (`launcher-<date-time>.log`;
    `persist/<address>/starts/<n>/` has the runner, herald, relay and operators logs)
  - `--demo` and `--wide`: `.local/play-local/worlds/<date-time>/` (`launcher-<date-time>.log` and one folder per world.
    With `--wide`, `wide-land.json` lists the grown rings and opened provinces, and the first line of `runner.out`
    states under `local_rules` which bytes differ from the preset)
  - the launcher command is in `command.txt` in the same folder.
- **Two addresses open the page, no other**: `http://localhost:<port>/` and `http://127.0.0.1:<port>/` (the second is what
  `--two`'s second player uses). The launcher and the worlds listen on 127.0.0.1 only and refuse a request whose Host is
  not one of the two: `http://[::1]:41920/`, `http://<your Mac's name>.local:41920/`, a LAN IP address, another machine or
  a phone do not work (nothing listens on any address but 127.0.0.1, so normally the connection itself fails; a request that
  reaches 127.0.0.1 under another name gets 403 `{"error":"HostDenied"}` instead of the page; a world's reads answer `WorldOriginDenied`).
  Since #164 a world's relay follows the same rule: it takes only requests whose Host is `127.0.0.1:<that relay's port>` or
  `localhost:<the same>` and that carry **no Origin header**; anything else is 403 `LocalPlayHostNotAllowed`. The page, the AI
  residents and the bundled external residents (Node) already call it that way, so ordinary play is unchanged (verify-pr164:
  both `--two` players, 0 × 403). What does hit it: a tool of your own that calls a relay port straight from a browser page
  (a browser adds Origin), and hand-made requests such as `curl -H 'Origin: …'` or another Host name.
- **After editing the page's files (`permutation-server/web/`)** the script needs no restart. The launcher reads from disk on
  every request and lets the browser keep no code or page (`no-store`; pictures and fonts are checked on every load). Reload the
  browser and you have the new files. In `--demo` and `--wide` a reload loses the test key (§6), so after it press
  「新しい世界を開始」 for a new world (the earlier world runs on until its time is up; at most two run at once, so end the
  earlier one in the start screen's list with 「この世界を終了…」; `--two` cannot start until the earlier world is ended. A kept
  world goes on after a reload). #170's static cache in the herald is not used by
  local worlds (the launcher serves the page; a world's herald runs without `--web`). Where a herald does serve the page (the
  devnet set-up), an edited file is read again on its next request once its size or times change, so no restart there either.
  A restart is needed after changing the launcher's or relay's code (`permutation-gateway/src/`) or Rust code (Ctrl-C, then
  `scripts/play-local.sh` again, with `--resume` to continue a kept world: it rebuilds only what changed).
- "ports in use": choose another `--port` (e.g. `--port 41450`), or stop the earlier world.
- Report through a GitHub Issue (r0ze998/wylls), with a screenshot and the folder above.

## 10. Play ② rights (stock swap) (`--coexist`, TEST-only)

This is owner decision ② A: the owner of a workshop village grants a "stock swap" right to another player's storehouse
in the same province. The grantee swaps its own ore and wood for arms the workshop has made, and takes those arms out
**only by caravan**. Only a wallet can issue a right.

```bash
scripts/play-local.sh --coexist --demo --two --ai 2     # ×60; the whole loop in about 10 minutes; not kept
scripts/play-local.sh --coexist --two                   # a kept world (natural clock: a storehouse costs about a day)
```

- **It takes two.** The grantee must be another player. Checking alone, use two browser windows: A at
  `http://localhost:41920/`, B at `http://127.0.0.1:41920/` (§3.1). Below, **A = the workshop village's owner**,
  **B = the grantee**.
- `--coexist` runs a kept world or `--demo` on the ②+⑨+⑩ **coexist lane** (program version 0x7805,
  `RULESET_HASH_V4`). It works with `--ai`, `--two`, `--random-map` and `--resume`, not with `--wide`. ⑨ and ⑩ have a
  TEST-only preview card since local-9-10-preview (§12).
- The first `--coexist` builds for a minute or two. A plain world started afterwards relinks its own binaries in a few
  seconds (#128: both lanes build in the same `frontier-node/target/debug`; before #128 it did not, and the plain
  world never started, the page staying on 「—」).

Steps (「」 are the page's buttons and texts as they are; the page's English mode has its own labels):

1. **Get into one province**: A and B both press 「世界を開始」 (with `--demo`: 「新しい世界を開始」) → 「国を選ぶ」 and pick the **same nation** (one without
   an AI: with `--ai 2`, not Borealis or Ember). A `--two` pair that picks one nation gets its villages in the same
   province, on different sites (#130: 3 of 3 worlds in verify-pr130, 1 of 1 in verify-pr133; before it 4 of 5 worlds
   put them in opposite provinces and the world had to be started again). The province is shown under 「村の詳細」 at the
   bottom of each village screen (e.g. 「州 -2,0」). With different nations the provinces are apart and no caravan
   reaches (a path is at most 32 tiles / 4 provinces).
2. **A: build a workshop**: in the village's build list open 「ほかの建物（6）」, then 「工房」 → 「建てる」 (60 food, 120 wood, 80 stone, 40 ore).
   Only a `--coexist` world offers 工房; a plain world's list says 「工房はこの試験世界では建てられません（…--coexist でだけ建てられます）。」 instead (fix-loop9 LP9-3: it was offered and refused).
   The notice says 「工房の建設を始めました」. The
   build takes about 1.5 hours (9 turns; about 1.5 minutes at ×60). Built as the village's first building, the list shows
   「1:00 初めての建設」 and it takes one game minute (the first building of a village, whichever it is; loop-play11). Either
   way step 6's 「権利を出す」 went through only from about turn 18–20 (verify-pr133, loop-play11). Once it stands, the village is a workshop village
   and makes 4 arms an hour (a workshop can be built only in a `--coexist` world).
3. **B: build a storehouse**: select a free tile of A's province on the map, 「ここに建てる」 → 「貯蔵庫を建てる」
   (200 wood, 200 stone, 50 gold from the selected village). It says 「貯蔵庫を建てました」.
   On a mountain or water tile it says 「この建物はこのマスに建てられません（通れない土地、…）」 and cannot be pressed: pick a flat tile.
4. **B: bring ore and wood into the storehouse**: select the storehouse's tile → 「ここへ隊商を送る」 (or the village
   screen's 「交易と防備」 → 「隊商を送る」). Check that 「出発地」 is your village and 「行き先」 the storehouse, type the
   wood and ore, 「隊商を送る」. One arm takes 2 ore and 1 wood (e.g. 20 wood + 40 ore for up to 20 arms).
5. **B: deliver the arrived caravan**: a local test world has nobody delivering caravans. The village screen's
   「権利（在庫の交換）」 card shows 「着いた隊商（あなたが届けます）」. At first it says 「通った州（P, Q）の決着が到着の
   ターン N を過ぎるのを待っています。過ぎると届けられます（数ターン）。」 and has no button (#130). A turn or two later
   「隊商を届ける」 appears: press it (「隊商が届きました」; the fee comes back. In verify-pr133 both deliveries took one press).
6. **A: issue the right**: the village screen's 「権利（在庫の交換）」 → open 「権利を出す」, choose B's storehouse under
   「工房の村と相手の貯蔵庫」, set 「交換の回数」 (default 3), 「兵器の上限」 (30) and 「有効な日数」 (1), and press
   「権利を出す」 (25 gold from the workshop village). A's card shows 「あなたが出した権利 有効 … 交換 0 / 3 回 · 兵器 0 / 30」.
   - 「工房のある村の州に、ほかの人の貯蔵庫が見えていません。…」: B's storehouse is not there yet, or is in another
     province. 「権利を出すには、工房のある村が要ります。」: step 2 is not done, or the workshop is still being built (verify-pr133: shown on turn 11, issued on turn 18).
7. **B: swap**: in B's card 「権利の一覧を読み直す」 → 「あなたが受けた権利 有効」. Type a number, 「交換を予約する」
   (「予約中 N」: ore and wood leave the storehouse, arms leave the workshop village) → 「交換を実行する」 (「交換しました。
   兵器はあなたの貯蔵庫に入りました」). 「予約を戻す」 undoes a reservation.
8. **B: haul the arms home by caravan**: the storehouse's tile → 「ここから隊商を送る」. The form opens with the storehouse
   as 「出発地」 and your village as 「行き先」, and the fields' limits are what the storehouse holds (#130; verify-pr133:
   wood 18, ore 36, arms 2). Type the arms, 「隊商を送る」. When it has arrived, 「隊商を届ける」 as in step 5: the arms
   are in the village's stores.
9. **A: revoke and close**: 「権利を取り消す」 → 「取り消し済み」 (B's open reservation is undone) → 「権利を閉じる」 →
   「閉じた」 (the rent comes back). After the revoke B can reserve no more.

Good to know:
- Fog rule: the card lists only rights you issued or received; rights between others and others' storehouse contents
  are never drawn. To A, B's storehouse is just 「（国）の貯蔵庫（マス N）」.
- When the other side's card has not caught up, press 「権利の一覧を読み直す」.
- Issuing and revoking are for the wallet only (this browser's test key); AI residents and delegates cannot. (The
  program itself still accepts a session key for the revoke; locally the relay refuses it. To fix before devnet.)
- Caravans can be raided on the road. The long notice after a delivery, 「…到着しましたが、入った量は確認できません…」,
  is not a failure (it means stores cut off what exceeds their cap). A caravan to a village can instead say
  「…決着しました。入った量はまだ確かめられていません…」: not a failure either (the goods are in the village).
- In a plain world (no `--coexist`) a workshop cannot be built and there is no deliver button (an arrived caravan is never delivered).
- `--coexist-node` is the old page-less node (for development).

## 11. Let an outside AI resident join (`--external`, TEST-only)

An *external resident* is a program you (or someone else) run in its own process, with its own TEST key. It joins
your local world as a newcomer under the same rules as a person (workstream ⑬ independent residents / ⑤ option B).
The world's operator gives it no privilege and never sees its key. The page shows it as an ordinary resident, with no AI mark.

1. Make the resident's TEST key, once, and keep the file (`0600`; only the printed public address leaves it):

   ```sh
   cd workstreams/03-composability/mcp && npm ci --ignore-scripts
   node -e "import('./examples/external-resident/key.mjs').then(m => console.log(m.createKeyFile('/path/to/resident.json').address))"
   ```

2. Start the world with that address (up to two, comma-separated). The MCP server imports the gateway client, so run
   `(cd permutation-gateway && npm ci --ignore-scripts)` once. The check phase lists it as missing if you skip it.

   ```sh
   scripts/play-local.sh --demo --external <address>
   ```

   With `--external` the script also starts workstream ③'s **read-only** MCP server for the world. It listens on 127.0.0.1
   only, on the port after the world's ports (41950 with the default `--port` and `--ai`, 41942 with `--ai 0`; printed as
   `Read-only MCP (③): http://127.0.0.1:<port>/mcp`, with `--lang ja` 「読み取り専用の MCP (③): …」). It reads the first world only. It offers only
   read tools, and a link is the resident's own (its wallet signs the link statement). `--no-mcp` leaves it off. It runs as long as
   the script (across worlds: when a world's time runs out it waits for the next one) and stops with everything on Ctrl-C.

3. Press start in your page as usual, then start the resident (it waits for your world if it is early):

   ```sh
   node workstreams/03-composability/mcp/examples/external-resident/agent.mjs --launcher http://localhost:41920 \
     --key /path/to/resident.json --mcp http://127.0.0.1:<port>/mcp
   ```

   It prints one JSON line per step (`discover`, `mcp`, `act` … `landed` / `refused`). Its orders are the page's six
   (Join, PlaceHome, Harvest, Build, Train, Muster). Each is signed by its own key and sent through its own relay.
   Like the operator AI residents, it may act once per turn (Join does not count; a second order in the same turn is
   `ResidentAlreadyActed`). Your own page has no such cap. To plug in your own AI, replace
   `decide()` in `examples/external-resident/rule.mjs` (see that folder's README).

   **Workstream ⑬'s own resident** runs the same way, with ⑬'s goals, limits and memory instead of the reference rule
   (no model, no paid API; `workstreams/13-citizens/resident/local/README.ja.md`):

   ```sh
   node workstreams/13-citizens/resident/local/client.mjs --launcher http://localhost:41920 \
     --key /path/to/resident.json --dir /abs/path/resident-state [--goal village-first|surplus-use] [--nation 0-5] \
     [--mcp http://127.0.0.1:<port>/mcp]
   ```

   Its decisions go to `<dir>/decisions.jsonl` (one JSON line per step) and its memory to `<dir>/state.json`. A restarted
   resident follows its last order by its signature and never acts twice in a turn. `touch <dir>/HALT` pauses it.
   If the `--key` file does not exist yet, `--new-key` makes it there (instead of step 1; the address is the `wallet` of the
   first line, `start`. The world must admit that address with `--external` before it starts, so normally make the key first, step 1).

4. **Multi-turn plans (`--plan`, run by ④, #148)**: give ⑬'s resident `--plan --runexec <absolute path of runexec>` and, once
   its village exists, it makes a 12-step plan of its own village's next orders (buildings → harvest → train → … → muster a
   host); ④'s plan store (SQLite, `<dir>/plans.sqlite` by default) runs it at most one step per turn (a step the
   village cannot pay for yet waits: the `"what":"wait"` lines in `decisions.jsonl` name the missing resource and about how many
   turns it takes; in verify-pr156 the sixth step, a building, waited a dozen turns for wood). `--plan` is an option of this
   resident (`client.mjs`), not of `play-local.sh`.

   ```sh
   (cd workstreams/04-execution && cargo build --release --locked --bin runexec)   # once
   (cd workstreams/03-composability/mcp && npm ci)
   node workstreams/13-citizens/resident/local/client.mjs --launcher http://localhost:41920 \
     --key /path/to/resident.json --dir /abs/path/resident-state \
     --plan --runexec "$PWD/workstreams/04-execution/target/release/runexec" [--plan-db /abs/path/plans.sqlite] [--plan-steps 12]
   ```

   - `--runexec` is an absolute path and goes only with `--plan` (`--plan-db` is absolute too; `--plan-steps` 4–64, default 12).
   - Where to look: the plan lines (`planStep`) in `<dir>/decisions.jsonl`. The intent is written to ④ before signing and the
     signature before sending, so after a stop (Ctrl-C or a kill) a restart with the same options reads the signature on chain,
     continues from there and never sends an order twice (verify-pr148: all 12 steps landed up to the muster, 0 double acts).
   - A second process on the same `--dir` cannot act; a restarted process waits until the previous one's lease (20 s) runs out.
   - A refusal by the chain or a changed world stops the plan and remakes it from the village as it is (at most 24 plans per world).
     A building the chain refused for lack of resources is not sent again until the village's stock has grown in every resource
     it costs, and a new plan does not start with it. A building of its own that landed but is not in the herald's record yet
     makes the resident wait for the record, not replan (fix-loop9, LP9-4). On S1 worlds a mine is counted above the village's own
     terrain ore, as the program counts it (LP9-4: before, the resident priced a 4th mine as a 2nd and was refused 8 times).
   - Plans hold the six orders, and in a `--wide` world the wide land's (below): no caravans, no ordinary marches (caravans wait on r0ze, Q4).

- In `--demo` the ×N clock starts only after **your** first village is placed. Until then a turn is 10 minutes, so
  the resident's second order waits for you.
- Not with `--two`. It works with kept worlds, `--demo`, `--wide`, `--ai`, `--random-map`, `--coexist` and `--resume`
  (pass `--external` again on resume).
- **In a `--wide` world** (external-wide) the launcher tells the resident the world is wide (`wideLand` in its start answer,
  as it tells your page). ⑬'s resident then picks its first village the way your page does there: outward first, the
  free sites of its nation in a settled rim province, farthest ring first. Past the heartland it asks for the village by a
  one-site request (`FileTicket`, the page's 「辺境の村を申し込みました」), which the world settles at a turn's end; it waits
  for that (up to 72 turns) and does not file a second one meanwhile. The request is its action of that turn. After that it
  plays its rim village with the six orders **and the wide land's own orders, exactly as your page has them there**
  (external-wide-orders): the wide claim (0xD9, the village screen's 「広い土地に村を出す」), its wide village's
  train / muster / march onto a neighbouring keep (the page's wide-village planner), and the expedition of a ready rim host
  into the bordering wide land (the page's depart route). Its rule, with no model and no paid API:
  - **Save, then claim.** With an opened wide province within reach (3 provinces) and no wide village yet, it saves for the
    settler cost as your page's card quotes it, which is what the program takes (slot 2: food 800, wood 800, stone 400,
    gold 200; until verify-pr183 it saved for 1,200 / 1,200 / 600 / 300, D-external-wide-orders-8): when production covers the shortfall within 240
    turns, builds and training that would spend it wait (a harvest and a muster spend nothing). With the cost in its stores
    it claims the nearest target's first free site (the herald's public route capture, as your card reads it), then waits up
    to 12 turns for the world to settle the claim at a turn's end. A claim whose site was taken at the settle founds nothing
    and costs the stores (the program's rule); after 3 such claims it stops claiming. The program takes a claim only from a
    **final** first village (`NotFinal`, Custom 24 — rejected before sending). A rim village becomes final lazily, on its
    owner's next action after its provisional time, so a resident that only saved first sends a harvest (it spends
    nothing), then the claim. Your page's card does not check this (D-external-wide-orders-7).
  - **Wide village.** Once its wide village is in its own `/h/me` (read with the page's wide-inventory parser), each turn
    may be the page planner's one act there: train 100, muster up to 300, then march wide → wide onto a neighbouring
    province's keep (at most 2 marches, as the page). A landed training is not asked again for 12 turns.
  - **Expedition.** A rim village (ring 128) bordering an opened wide province forms a host and sends one expedition when
    the page's route check finds a passable path; no passable path (`RouteImpassable`, seen live) means no expedition from
    that village. With 100+ in the reserve the host is mustered (it spends nothing) before the save; otherwise its training
    waits until after the claim.
  - With `--plan` these are ④ plan steps too (`WideClaim`, `WideTrain`, `WideMuster`, `WideDepart`, `Expedition`): a plan
    starts with the claim while it saves, and a build that would spend the saved cost remakes the plan.
  Every one of these is ONE action of its turn, through its own relay's one-action-per-turn lease, rebuilt byte for byte by
  the relay and judged by the program as your page's. It reads only the launcher's `wideLand` answer (your page gets the
  same), the public herald through its own world proxy, and its own relay's read-only wide read (your page's
  `frontier-local-play-act-wide-read-v1`). Its relay is the operator residents' relay: the launcher no longer passes
  verify-pr163's `--no-wide-orders` (still a relay option).
  The reference resident (`agent.mjs`) still reads heartland sites only (PlaceHome, rings 2–3) and sends none of these.
  Example: `scripts/play-local.sh --wide --random-map --ai 2 --external <address> --speed 60`, then
  `node workstreams/13-citizens/resident/local/client.mjs --launcher http://localhost:<port> --key <file> --dir <abs> --plan --runexec <abs runexec>`.
- The keeper loop settles an external resident's home province in the same batch as yours (#146; in kept worlds too). In
  `--demo` at ×60 its province is ready for a muster 80–90 % of the time (before: 0–6 %; §8.2).
- The two residents shipped here send the six orders (and, in `--wide`, the first village's request; ⑬'s resident also the
  wide land's orders above): no caravans, no ordinary (legacy-disk) marches, and they do not use the ① board. The resident's
  relay itself also serves the ordinary march routes and, in every world, the expedition routes (a client of your own could
  send one — verify-pr163 D-2; whether external residents may march on the legacy disk waits on r0ze). The relay
  takes only requests whose Host is its own address and that carry no Origin (#164; a Node resident passes as it is, §9). An external resident cannot pause
  the world's clock or change its speed: those controls need the launcher's own token (#137).
- Local only: on devnet there is no external-resident admission and no MCP server (the public MCP policy questions
  MCP-1..11 are open).

## 12. Preview: ⑨ lend a workshop, ⑩ store ore in another's storehouse (`--coexist`, TEST-only)

Owner rules of 2026-11-21: ⑨ a local preview built on ② A's storehouse and caravans, and the captor takes everything;
⑩ folded into ② A's storehouse — goods on the road are the carrier's and are lost if the carrier is beaten, the
depositor's troops do not defend, seizures and losses are shown on screen, ore only. Nothing here is on devnet: the
coexist lane's own program instructions (⑨ 0xF0–0xFA, ⑩ 0xC2–0xCC) are sent by the page and checked by the program.

The village screen of a `--coexist` world has a second card, 「預かりと工房貸し（試験）」, under the ② card. Set up as §10
steps 1–5 (same nation, same province; A builds a 工房, B builds a 貯蔵庫 and brings ore and wood into it).

⑨ lend a workshop (A owns the workshop village, B has a storehouse in that province):
1. A: open 「工房を貸す」, type how many workshops, 「工房を貸し出す」 (the pool opens and the copies leave the village's own
   arms production). 「工房を貸し出しました」.
2. A: choose B under 「使わせる相手（この州に貯蔵庫がある人）」 (since #149 each option names the village and the storehouse tile; the short address at its end is the owner's resident record, not the wallet: loop-play11 LP11-5), the workshops, 「兵器の上限」 and 「有効な日数」, then
   「工房を使わせる」 (the wallet signs). 「工房を使う権利を出しました」.
3. B: under 「使える工房」, set 「使う工房の数」 and 「作る兵器の数」, then 「予約して材料を入れる」: one transaction books the job
   and takes 2 ore + 1 wood per arm from B's storehouse. The job starts two minutes of chain time later.
4. B: 「あなたの作業」 counts 「兵器 N / M」 (4 arms an hour a workshop; at ×60 ten arms take about 2.5 minutes). Then
   「貯蔵庫へ受け取る」: 「兵器と残りの材料が貯蔵庫に入りました」. Haul them home by caravan as in §10 step 8.
5. A: 「取り消す」 ends the grant (a booked job keeps running), 「空いた工房を戻す」 gives the copies back to the village.

⑩ store ore (B keeps the storehouse, A deposits):
1. B: open 「鉱石を預かる」, choose A's village (since #149 each option names the village, its tile and a short address — the resident record's, as above: 「マス (storehouse) → (nation) の村 (name)（マス N · 63hY…y3Qe）」; with more than one person to choose from the list starts on 「（預ける人を選んでください）」, or on the one picked last — fix-loop9 LP9-7), the
   「鉱石の枠」, then 「預かりの枠を開く」 (wallet). 「預かりの枠を開きました」.
2. A: 「預けた鉱石」 lists the storehouse. Type an amount, 「鉱石を預ける」: A's own caravan leaves with A's ore. When it has
   arrived and the province it crossed has resolved, 「鉱石を届ける」: 「預ける鉱石が届きました」 (the ② card does not offer
   these caravans).
3. A: 「引き取る」 sends the ore home in an ordinary caravan; deliver it with the ② card's 「隊商を届ける」. 「枠を閉じる」 once
   it is empty.
4. B sees only 「あなたの貯蔵庫の預かり」: whose ore (by nation) and how much.

Losses (told once as an alert, and kept on the card, from the viewer's side; but the road-loss row 「隊商 N：道中で奪われた」
leaves the card once 「帳簿を確かめる」 is pressed, and then only the map's alert history keeps it): a storehouse seized (「帳簿を確かめる」 then
records it; 「預けていた貯蔵庫が奪われ、…」), a custody caravan taken on the road (「預けに向かった鉱石 N は道中で奪われました。」),
a workshop village lost (「村が奪われたことを記録する」; 「借りていた工房の村が奪われ、…は占領者のものになりました。」).
Since #145 (fix-9-10-followups) the first two can be made to happen in a `--coexist --two` world as real orders (the
program's own SeizeVault, RaidDomestic and RaidCaravan; nothing changed on chain). A village capture still cannot (tests only).
A plain world (no `--coexist`) offers none of these buttons. Muster hosts of 100 troops or more (the program refuses a smaller one).
At ×60 there are only about 20 s between stopping and deciding, so `scripts/play-local.sh --coexist --demo --two --speed 15`
(a turn is 40 s) is easier.
- **A caravan stopped on the road** (B takes A's custody ore). A pair is one nation, and a clash never raids its own nation's
  caravan, so B stops it itself. A caravan stands on a tile only at a turn's start (about 5 flat tiles a turn), so one that
  departs and arrives within a turn can never be stopped. In verify, A's village on tile 28 and B's storehouse on tile 22 of
  province (-1, 2): A's caravan stood on tile 20 when 「鉱石を預ける」 was pressed with about 5½ minutes of game time (about 22
  seconds at ×15) left in the turn. Steps: B forms a host on that tile first (village screen 「編成」, choose the tile on the
  board). When the turn the caravan stood there has resolved, B taps the tile, opens the host card's ⓘ (the tile panel) and
  presses 「隊商を止める（ターン N まで）」 → 「隊商を止めました。…」, then 「奪って運ぶ」 or 「焼き払う」 in the same panel (six turns
  from the turn it stood there). A is told 「預けに向かった鉱石 N は道中で奪われました。」 (or 「…焼き払われました。」) and presses
  「帳簿を確かめる」 (ReconcileLot) to free the room. A taken caravan goes to B's village; B delivers it with the ② card's
  「奪った隊商」 → 「隊商を届ける」 (the ore goes into B's village). While it is still on its way the ② card lists it under 「奪った隊商（あなたの村へ向かっています）」 with 「ターン N に着きます。…」, and the map tag says its arrival turn (a short road home arrives at once and shows only under 「着いた隊商」: in verify-pr162 it showed there the turn after the take, map tag 「略奪された隊商 ターン 108 着」) (fix-loop9 LP9-6: it said 「ターン 0 着」 and nothing showed for ~65 turns). A burned one goes on empty; A delivers it with 「鉱石を届ける」.
- **A storehouse seized**: the other player forms a host on the storehouse tile (none of the owner's hosts may stand there),
  taps the tile → ⓘ → 「貯蔵庫を奪う」 (the button can be pressed with an owner's host there, but the program refuses). The keeper is told 「あなたの貯蔵庫が奪われ、預かっていた鉱石も奪われました。」. With two
  players the captor is the depositor itself: its card says 「あなたが奪った貯蔵庫」 and no loss; 「帳簿を確かめる」 then forfeits
  the lot into the storehouse it now owns (captor takes all). A third party's seizure, and "the depositor's troops do not
  defend", need a third seat (not built).
- The herald drops a delivered custody caravan from the map (#145; before, it stayed as 「隊商 ターン N 着・位置は推定」).
- Delivering a burned, empty custody caravan still says 「預ける鉱石が届きました」 (it carries 0; verify-pr145).


## 13. ① The cross-nation request board and the ⑮ title 「依頼に応えた」 (TEST-only, #149, #152)

`play-local.sh` attaches workstream 01's co-op board to every world (launcher option `--coop-board ws01-board-v1`);
add `--no-coop-board` to leave it out. With the board, the village's 「交易と防備」 card has 「国をまたぐ依頼を開く」 and the
bottom bar's 「その他」 shows ⑮'s 「称号と記録」 card (「国をまたぐ協力の達成。勝敗・得点・賞金には関わらない」).
The board follows the game page's language (#171: switch the game page to English with its top-right button and an open board
window turns English too; the board window has its own switch. Its Japanese is unchanged; the 「」 below are the Japanese texts).

From request to delivery (only a `--coexist` world sends caravans; an ordinary world's village sends none):

```bash
scripts/play-local.sh --coexist --two --demo --ai 0      # ×60, two people in one world (as in §10; `--ai 0`: no AI residents)
```

**To check the title too, A and B pick different nations** (a request inside one nation can be delivered, but earns no
title). In verify-pr152, on the usual map (no `--random-map`), A = Aster and B = Borealis, and the caravan arrived (a caravan's
road is at most 32 tiles and 4 provinces).

1. **A (asks)**: 村 → 交易と防備 → 「国をまたぐ依頼を開く」. The board opens in another window. 「このウォレットで署名する」
   (the page's test wallet signs the board's records only) → enter wood and stone → 「依頼を出す（署名）」. The destination
   is A's village (e.g. 「木材 20・石材 20 → …（アステル・申告。判定には使わない）の村 (-1,2) 村5 受付中」). The board's 「自分の国」 select names
   the nations as the game does and, once the wallet is connected, follows the nation checked on chain (it is still only a
   declaration; fix-loop9 LP9-8: it offered 「国1…国6」 and defaulted to 「国1」).
2. **B (delivers)**: open the board the same way, 「このウォレットで署名する」 → the request's 「応じる（送るつもり。義務はない）」.
3. **B**: in the game, 村 → 交易と防備 → 隊商を送る. Within about 15 s the destinations include 「① 依頼の届け先：村（-1, 2 · マス 28）」
   (followed by the nation, e.g. 「 · アステル」). **Only someone who answered 「応じる」 to that request gets this destination**:
   only the place the requester published on the board; the land around it stays out of sight (fog unchanged). Enter
   the amounts → 「隊商を送る」 → 「ほかの人の村か貯蔵庫へ送る隊商は、ウォレットで署名します…」 → 「隊商が出発しました」.
   (Before #149 this was refused with 「ローカルプレイでは、まだ命令を送れません（読み取りのみ）」, LP8-3.)
4. **B**: reload the board → 「隊商 #0（木材 20・石材 20）をこの依頼に結び付ける」 → 「結び付けた。数えるのは確定した到着だけ」.
5. When it arrives, B's 「権利（在庫の交換）」 card shows 「隊商を届ける」 under 「着いた隊商（あなたが届けます）」 (after the
   provinces on the way have settled past the arrival turn; tens of seconds at ×60). Press it → 「隊商が届きました」.
6. The board's 「隊商と到着」 row says 「到着（確定）・届いた 木材 20 以上・石材 20 以上（規則から）・Fulfilled」 and the request
   reads 「依頼の充足：依頼量に届いた（数えた量の下限で証明）」. After a partial delivery it says 「依頼量に届かなかった
   （すべて終わり、上限で証明）」, but the request stays 「受付中」; deliver and link the rest and it turns to 「依頼量に届いた」.
7. **The ⑮ title 「依頼に応えた」 (#152, owner decision Q1-⑮)**: once the request has reached its amount, the deliverer B's page
   shows 「ターン N あなたが称号「依頼に応えた」を得た」 under 「その他」 → 「称号と記録」 (English page: “Answered a request”; N is the
   turn of the arrival that reached the amount; reading the board takes a moment). The requester A's card shows nothing
   (still 「まだ称号はありません」: a title is shown to its holder only).

When the title is earned (⑮'s ruleset B version 4, `workstreams/15-coop-outcomes/src/rulesets.mjs`):
- You **delivered with your own caravan** to a request of **someone of another nation**, and that request **reached its
  requested amount** (the board's proof by the lower bound of what it counted).
- Not earned by: answering 「応じる」 alone, a partial delivery to a request that did not reach its amount, a request of someone of
  your own nation, your own request (the board refuses that in the first place).
- Titles and records only: nothing is added to winning, score, prize or the season's end (owner decision ⑮ B; the
  decisions of 2026-11-24 also keep cooperation out of the “world goals”).
- The other title earnable now is P-raider (「他の国の隊商から奪った（国内の襲撃は数えない）」), which has nothing to do with requests.
- The card's 「まだ判定できない達成 N」 is the total of every resident's undecided goals (not necessarily yours).

## 14. World goals: the flag keeps (TEST-only, first slice, no money)

The world is continuous: there is no season end. Instead it has four permanent goals without a deadline
(docs/design/win-conditions/01-proposal.ja.md, accepted by r0ze on 2026-11-24). Only the first is judged so far:

- **Flag keeps (hegemony).** Each nation's contestable keeps (not heartland) carry flags: two per nation, border keeps
  first, ordered by the Season's drand seed. A nation that holds **half of the flag keeps**, each for **144 turns**
  (24 hours of the chain clock; 24 minutes at the ×60 TEST clock), achieves the round. The next round is posted at once.
- World-first technology, wonder and unexplored mark are shown as "coming".

Every play-local world has the judge (`--no-world-goals` turns it off). The launcher judges off chain in its own process.
It reads the world's Province and Citizen accounts and serves the result read-only at
`/goals-world/<world proxy port>/goals/state`. Open **Nation & territory** to see the **World goals** card: the four
goals, each flag keep with its holder and its hold timer, your nation's progress, and every nation's count. On the map
each flag keep has a gold pennant beside its standard.
Under the fog of war the card tells a flag keep as the map does: a keep in sight with its holder, hold timer and siege;
one you saw before with its last-known holder only; one you have never seen by its place alone ("You have not seen this
province's keep yet"). Your own nation's flag keeps are always shown. Every nation's count stays public, like the
provinces-held strip.

After an achievement the card says what the prize **would** have paid you: "If prizes were on, you would have received
X test USDC". This is an estimate from a simulated vault: one 25 test USDC pass per person, 80 % to the prize, 30 % of
the hegemony vault per achievement. Inside the nation the payout is split by contribution points (a capture is 10 points;
reinforcement is 1 point per 100 troops on the keep). Operator AI residents earn points but no money. Nothing is paid,
nothing is sent, and the chain is not changed.

In a local world only ring 1 keeps are contestable (rings 2–3 are heartland), so each nation has **one** flag keep: 6
flags, need 3. For a quick try, use the TEST overrides `--flag-keeps-need N` and `--flag-keeps-hold N` (turns). For
example `scripts/play-local.sh --demo --ai 0 --flag-keeps-need 2 --flag-keeps-hold 72`: capture one neighbouring flag keep
(72 turns), then hold it 72 more turns.
