# Play it locally and check it yourself (TEST only, one command)

How to check the playable version (expeditions, wide land, keep capture) on your own Mac before it goes to devnet.
It uses a local chain and test keys only. No real key, SOL, devnet or paid API is ever used.
Matches main as of 2026-11-21 (through #131, #129 and #130: fix-loop6's #130, which fixed the loop-play6 problems, is in. What is left: §8). Japanese: [PLAY-LOCAL.ja.md](PLAY-LOCAL.ja.md)

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
scripts/play-local.sh --coexist --demo --two   # ② rights (stock swap), the whole loop for two (×60; not kept) → §10
```

The wide version is started with `--wide` alone (given with `--demo`, `--resume`, `--fresh` or `--two` it stops and names
which; nor with `--coexist`; `--ai`, `--ai-peaceful`, `--random-map`, `--speed`, `--minutes` and `--port` go with it).

There are three worlds. All of them have fog of war (§5), and the AI residents are at war by default. `--coexist` is
not a fourth world: it runs a kept world or `--demo` on the program that carries ② rights (§10).

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
| `--two` | two people in one world (§3.1) | `--wide` |
| `--coexist` | a world with ② rights (§10): a kept world or `--demo`; works with `--ai` `--two` `--random-map` `--resume` | `--wide` |
| `--speed N` | the clock of `--demo` / `--wide`, 10–60 (default 60) | a kept world |
| `--minutes N` | minutes until the world's processes stop, 15–240 (default 90). A `--wide` world stops then too (before the local-perf fix a long-running wide world could run past it) | |
| `--port BASE` | the page's port (default 41920). It uses 22 ports from BASE (14 with `--ai 0`), all within 41000–41999 and clear of 41904–41907 and 41970 | |
| `--lang ja\|en` | the language of the script's messages (the page: its top-right button) | |
| `--no-open` `--no-build` `--rebuild` `--check-only` `--print-plan` | do not open / never build / always build / check only / print the settings and the launcher command, and exit | |
| `--coexist-node` | the page-less ②⑨⑩ node alone (for development, not for playing) | everything but `--port` |

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
5. **Muster**: 「編成」 in the bottom bar (or the guide at the top right when it says 「軍勢を編成する」) → 「全部」 →
   「槍兵 N をここに集める」. When it says 「この州はまだ前のターンの決着が済んでいません」 you **may press anyway**: the
   muster waits and is sent once, as soon as the province is ready (no need to press again; it is withdrawn if the
   unit or the number changes). The village screen's 「兵」 → 「編成する」 cannot be pressed while the province settles
   (only the bottom bar's 「編成」 waits and sends). While the host forms, the guide at the top right says
   「ガイド 3/7 軍勢の整列を待つ」 (with something to do meanwhile added as 「待つ間に：建設をひらく」 or the like). When it
   says 「軍勢の準備を確かめる」 or 「届く砦を見る」, the host is mustered.
6. **March on a keep**: press the guide at the top right when it says 「届く砦を見る」 (if it stays on
   「軍勢の準備を確かめる」, open 「国と領土」 in the bottom bar once). Pick a keep's row and press 「確認した命令で出発」.
   While the province is settling, the same order is sent once, as soon as it can be. 「最初の出陣」 means it left.
   - When the list says 「届く砦 0」 (「見えている他国の砦で、この軍勢がいま届くものはありません。」), no other nation's
     keep is in sight from your village (common with `--random-map`). The guide at the top right and the list's card then
     offer 「進軍で地図から選ぶ」 (#130). Press it, or 「進軍」 in the bottom bar, pick the ring-1 keep's tile on the map as the destination (you can
     press it while it is blank under the fog) and 「確認した命令で出発」 (the destination is called 「見えていない土地」).
     A march spends 10 + 2 × tiles of stamina (28 for 9 tiles, 74 for 32; the cap is 120) and stamina returns 1 per turn:
     after a scouting march to a far blank tile the host may have to wait for stamina before it can march on a keep
     (loop-play6: about 30 turns).
7. **Check the clash**: on the arrival turn 「戦闘 … 衝突が決着しました」 appears. 「報告」 → 「このブラウザで確かめる」;
   「一致：このブラウザで計算し直した結果はチェーンの記録と同じです」 means it was recomputed and agrees.
   After the notice is gone, the 「報告」 button stays in the list under 「その他」 in the bottom bar.
8. **Capture**: hold the keep's tile for 72 turns (about 12 minutes or more at ×60; about 12 hours at 1×). 「砦を保持中」
   and the round number on the keep, or 「奪取まで N/72 ターン」 in the clash report, show the progress. A held turn counts
   whether the province's turn is resolved or skipped (the #120 check: 11 AI captures at ×60 in `--wide --ai 4`, each
   after exactly 72 held turns).

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
scripts/play-local.sh --wide --ai 4 --minutes 180
```

The wide version is started with `--wide` alone (no `--fresh`, `--resume`, `--demo` or `--two`; the table in §2).

During the world's setup (about 20 seconds) the program's own instructions grow the map to ring 128 (the rim) and open
the wide land beyond it (rings 129–131, 108 provinces). The game starts around turn 140, at ×60 (a turn is 10 s).
The default 90 minutes may not reach step 4 below, so add `--minutes 180`.

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
2. **A wide village (about 30 minutes at ×60)**: the village screen's 「広い土地に村を出す（テスト）」 shows the cost
   (1,200 wood and more) and the candidate provinces. Once the stores hold it, press 「ここに村を出す」. The claim is
   decided at the end of the turn and the village is drawn on the map with your nation's sigil. The easiest way to
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
      もう一度押してください。」: press again. At ×60 the 「到着候補：ターン A〜B」 line is gone after 1–3 s, but step 3's
      button stays (verify-pr130).
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
   - **The world's keeper opens the seal.** After the arrival the map tag goes 「ターン N に到着」 → 「到着 · 開封を
     待っています」 → 「到着 · 封は開きました · 結果の確定を待っています」, and once the target province has caught up the
     march screen says 「結果を受け取りました　留まる：軍勢は広い土地の州に立っています（兵 500）」. Just wait (in fix-loop5,
     verify-pr117 and loop-play6 the keeper opened it inside the window every time).
   - As a backup, on the arrival turn this page can open the seal too (「封を開けるか確認する」 inside the boundary card →
     「封を開く（ローカルプレイ）」). Before #105, at ×60 on a loaded machine, the keeper did miss the window of about 10 s
     (§8). 「封を開ける期間が終わっています。(RevealWindowClosed)」 means that expedition will never settle.
   - Before sending the next host, press 「結果を照合する」 under the card's 「送信しました。確定はまだ確認できていません」
     once (until then 「出発する」 is not shown).
   - The bar button says 「送信しません」 (does not send), but in local play the card's last button really departs.
4. **A march inside the wide land (wide → wide)**: open the village of step 2; it has the card
   「広い土地の軍勢（テスト）」. Pressing 「次の一手（広い土地）」 goes one step at a time: train spearmen → muster a
   host → march on the next province's keep. **Press once per step, then wait** (three presses in all).
   - The village's header says 「この村の記録の表示は読み取り専用です。命令は、下の「広い土地の軍勢（テスト）」だけが
     送ります（訓練・編成・進軍）。収穫・建設・隊商・追いつかせる は、この村には送れません。」 (the records are
     read-only; only the card below sends orders; #130).
   - The card states each step's reason in the page's language (#130; English on the English page):
     「広い土地の村で槍兵 N を訓練します。」 (train) → 「広い土地の村で槍兵 N の軍勢を編成します。」 (muster) →
     「軍勢（兵 N）が州 P,Q の砦へ進軍します（（国）が保持）。到着はターン N です。」 (march). Once the host is out it
     says 「軍勢は進軍に出ています。」: nothing to do now.
   - A new village's province starts far behind the chain (loop-play4: 77 turns after the village was made;
     loop-play5: up to about 180 turns). **Do not keep pressing while the province is behind.** The card says
     「この村の州の決着が N ターン遅れています。…このページが約 1 ターンごとに自動で確かめ、送れるようになったら一手を
     送ります。」 and waits by itself (the button reads 「待っています…（押す必要はありません）」 and is disabled;
     「待つのをやめる」 stops it). Other reasons it waits for: 「軍勢が整列中か休んでいます。」 and the like. A step refused because the turn changed while it was being sent (NotResident), or a march
     send that failed once, is sent again next turn by itself (verify-pr117: with 「次の一手」 pressed every 2 s for 10
     minutes the page sent only 4 acts and got through train → muster → march; loop-play6: the card waited by itself
     through a 187-turn lag and sent about 3 minutes later).
   - The world's keeper opens the march's seal and catches the target province up even when it is far behind
     (verify-pr106: reveal, clash and settlement within minutes of the arrival). The bottom bar's 「進軍」 list does not show
     marches inside the wide land. Staying on a keep for 72 turns takes it. The same card follows the march (#130; it reads again about once a turn):
     「軍勢は州 P,Q の砦へ進軍中です。到着はターン N です（いまはターン M）。」 → 「到着ターン N を過ぎました。到着先での
     決着を待っています（州の決着が遅れると数ターンかかります）。」 → 「結果：軍勢（兵 N）は州 P,Q に立っています。」 plus
     the keep's state (「砦は（国）が保持しています（あなたの国は占拠できていません）。」, 「あなたの国が砦を占拠中です：
     n / 72 ターン。」 or 「砦はあなたの国のものです。」). A lost march says 「結果：軍勢は州 P,Q に残れませんでした
     （戦いに敗れました）。」 (verify-pr130 saw 「…進軍します」 → 「…過ぎました…」 → 「結果：軍勢（兵 76）は州 -63,-66 に
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

| | Local (this script) | The devnet playable version (not deployed yet) |
|---|---|---|
| Program | a local-only `.so` (program id `[0x45; 32]`, never deployable) | the devnet `.so` (another build; the local features are not in it) |
| Centre | **none** (the world's own Season byte `centre` = 1) | the presets keep the centre (the `CENTRE_PLAYABLE` switch is r0ze's) |
| Village that may claim wide land | from a Hamlet (`--wide` only: `outpost_tier_min` = 0) | the wide preset `S1_DEVNET_WIDE_7D` also from a Hamlet (0 since #104); `S1_LOCAL_7D` from a Town (1) |
| First village on the rim, wide villages | test participants settle first in the setup; the keeper settles the claim | done in #104 (the keeper's rings role opens the rim provinces, its tickets role settles the request); keeper A's `wide-tickets` role settles wide claims (#107) |
| Expedition rim → wide land | works (the 0x4804 expedition, #92) | the same instructions are in it; the departure is sent from the same card of the devnet page, paid by the connected wallet (「送る内容を確認」 → 「ウォレットで署名して送る」; #129, runbook §7 P15). Keeper A's `expeditions` role sends every step after the departure (#121) and its `wide-resolve` role keeps the wide provinces resolved turn by turn (#129). All checked offline |
| March wide → wide, capture of a wide keep | works (the local-only feature `localnet-wide-depart`, #94) | **closed** (WideDepart) |
| Clock | can run ×10–×60 (a TEST clock) | the natural speed only |
| Opening a march's seal, clash, settlement, keep capture | the keeper loop inside the launcher (TEST machinery; the keeper program is not run) | keeper A's roles (#118, #122). A held keep is resolved every turn and taken after exactly 72 (#120, checked offline; 12 hours of real time) |
| AI residents | yes (at war by default) | none (local only; runbook §7 P4) |
| ② rights (stock swap) | `--coexist` worlds only (§10) | not in it |
| Fog | yes (display only) | yes, the same player view on the devnet page (fog-devnet, `DEVNET_FOG`) |

Heartland protection of keeps, the 72-turn capture, the clash computation and the costs of villages, building and
training are the same rules as devnet.

## 8. Known problems (2026-11-21, main through #131 and #129)

### 8.1 Still on main (after #130)

The problems loop-play6 found (LP6-1 … 15) were fixed by #128 and #130, and verify-pr130 and verify-pr133 played them
(only the rim village's long-wait text, LP6-9, was not seen: the load never got that high). What is left is below. None
is a rules question.

| Where | What happens on main | Workaround now |
|---|---|---|
| Boundary card (×60) | the 「到着候補：ターン A〜B」 line and a check's result are gone after 1–3 s (every read of the world's clock; V117-1, LP6-8). The 「間に合う候補（ターン N）を使う」 button stays | press the next button anyway (§4 step 3) |
| Boundary card (×60) | 「出発条件を確認」 is refused NotResident once or twice (the province is still settling) | wait 1–2 s and press again (it only reads) |
| Boundary card | after a departure the card can stay on 「送信しました。確定はまだ確認できていません」 (2 of 5 in verify-pr130); until then the next host's 「出発する」 is not shown. The card also stays bound to the departed host (「カードを開き直してください」) | press 「結果を照合する」 once; reopen the card for the next host |
| Stopping | the cause of the one Ctrl-C that did not end a world hours past its time (LP6-3) is still unknown. #130 added the 20 s bound and the second Ctrl-C; in verify-pr130 all four cases ended in 0.1–2.4 s | press Ctrl-C again (§6 item 1) |
| Wide village (W2) | the card says 「この村の州の決着が N ターン遅れています。」 twice in a row | none (display only) |
| ② rights caravans | in the caravan form, switching the source from the storehouse to the village leaves that same village as the destination | choose the destination again |
| ② rights | opening 「権利を出す」 before the workshop is finished (about 9 turns) says 「権利を出すには、工房のある村が要ります。」 | wait for the workshop (§10 step 2) |

Small ones (nothing blocks play):
- The 「この試験世界について」 box covers the 「支配する州」 bar and the top of 「全体図」; 「たたむ」 folds it.
- On the ×60 nation picker 「参加の受付は第 N ターンまで（あと約 2 時間）」 and 「（あと約 73 分）」 alternate. The `--demo`
  picker's intro may say a turn is about 10 minutes of real time; at ×60 it is about 10 s (verify-pr119).
- After a march has left, the guide still says 「ガイド 4/7 軍勢の準備を確かめる」; 「国と領土」's reach list offers the keep
  your host already occupies.
- Selecting a never-seen province says 「未測量 … 地形だけを図にしています。」 but the map draws it blank.
- With `--coexist`, building a workshop gives a notice with an empty name (「の建設を始めました」).

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
- A wide claim offers free sites only. The third village's cost (2,400) does not fit a Hamlet's stores (cap 2,000).
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
   The notice has an empty name: 「の建設を始めました」 (§8.1). The
   build takes about 1.5 hours (9 turns; about 1.5 minutes at ×60). Once it stands, the village is a workshop village
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
   only, on the port after the world's ports (printed as `Read-only MCP (③): http://127.0.0.1:<port>/mcp`). It offers only
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

- In `--demo` the ×N clock starts only after **your** first village is placed. Until then a turn is 10 minutes, so
  the resident's second order waits for you.
- Not with `--two` or `--wide`. It works with kept worlds, `--demo`, `--ai`, `--random-map`, `--coexist` and `--resume`
  (pass `--external` again on resume).
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
2. A: choose B under 「使わせる相手（この州に貯蔵庫がある人）」, the workshops, 「兵器の上限」 and 「有効な日数」, then
   「工房を使わせる」 (the wallet signs). 「工房を使う権利を出しました」.
3. B: under 「使える工房」, set 「使う工房の数」 and 「作る兵器の数」, then 「予約して材料を入れる」: one transaction books the job
   and takes 2 ore + 1 wood per arm from B's storehouse. The job starts two minutes of chain time later.
4. B: 「あなたの作業」 counts 「兵器 N / M」 (4 arms an hour a workshop; at ×60 ten arms take about 2.5 minutes). Then
   「貯蔵庫へ受け取る」: 「兵器と残りの材料が貯蔵庫に入りました」. Haul them home by caravan as in §10 step 8.
5. A: 「取り消す」 ends the grant (a booked job keeps running), 「空いた工房を戻す」 gives the copies back to the village.

⑩ store ore (B keeps the storehouse, A deposits):
1. B: open 「鉱石を預かる」, choose 「マス (storehouse) → (nation) の村（マス N）」 (A's village is the one on its tile), the
   「鉱石の枠」, then 「預かりの枠を開く」 (wallet). 「預かりの枠を開きました」.
2. A: 「預けた鉱石」 lists the storehouse. Type an amount, 「鉱石を預ける」: A's own caravan leaves with A's ore. When it has
   arrived and the province it crossed has resolved, 「鉱石を届ける」: 「預ける鉱石が届きました」 (the ② card does not offer
   these caravans).
3. A: 「引き取る」 sends the ore home in an ordinary caravan; deliver it with the ② card's 「隊商を届ける」. 「枠を閉じる」 once
   the room is empty.
4. B sees only 「あなたの貯蔵庫の預かり」: whose ore (by nation) and how much.

Losses (told once as an alert, and kept on the card, from the viewer's side): a storehouse seized (「帳簿を確かめる」 then
records it; 「預けていた貯蔵庫が奪われ、…」), a custody caravan taken on the road (「預けに向かった鉱石 N は道中で奪われました。」),
a workshop village lost (「村が奪われたことを記録する」; 「借りていた工房の村が奪われ、…は占領者のものになりました。」).
Local play has no way yet to raid a caravan, seize a storehouse or capture a village, so these were checked with tests and
injected state only (local-9-10-preview report).

