# Play it locally and check it yourself (TEST only, one command)

How to check the playable version (expeditions, wide land, keep capture) on your own Mac before it goes to devnet.
It uses a local chain and test keys only. No real key, SOL, devnet or paid API is ever used.
Matches main as of 2026-11-21 (through #122; loop-play6 corrections). Japanese: [PLAY-LOCAL.ja.md](PLAY-LOCAL.ja.md)

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
     keep is in sight from your village (common with `--random-map`; the guide counts unseen keeps too and still says
     「届く砦を見る」). Press 「進軍」 in the bottom bar, pick the ring-1 keep's tile on the map as the destination (you can
     press it while it is blank under the fog) and 「確認した命令で出発」 (the destination is called 「見えていない土地」).
     A scouting march to some other blank tile spends 74 stamina, so the next departure is about 30 turns later.
7. **Check the clash**: on the arrival turn 「戦闘 … 衝突が決着しました」 appears. 「報告」 → 「このブラウザで確かめる」;
   「一致：このブラウザで計算し直した結果はチェーンの記録と同じです」 means it was recomputed and agrees.
   After the notice is gone, the 「報告」 button stays in the list under 「その他」 in the bottom bar.
8. **Capture**: hold the keep's tile for 72 turns (about 12 minutes or more at ×60; about 12 hours at 1×). 「砦を保持中」
   and the round number on the keep, or 「奪取まで N/72 ターン」 in the clash report, show the progress.

Good to know:

- **There is no centre (a rule of local worlds only, #88).** The six ring-1 provinces are ordinary land, each starting
  with a keep held by some nation (on the usual map: one per nation). Heartland keeps (rings 2–3) are protected and
  cannot be taken, but **ring-1 keeps can be contested**. In a kept world too the AI residents march there (in the #98
  check: departures on turn 8, clashes on turns 12–13); when your own nation's keep is attacked, a notice says
  「州 P,Q の砦を （国）が攻めはじめた／あなたの国が守っている」. 「国と領土」 lists it under 「他国が占拠を進めている、
  あなたの国の砦 … 守りに向かう」 only when that keep is within your host's reach (loop-play6). Only the middle province (0,0) is 「第0輪（中央・州なし）」: never
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

1. **A rim village**: at 「国を選ぶ」 pick a nation without an AI (with `--ai 4`: Aster or Dunmar) and press
   「（国の名前）で始める」. You do not pick the place: the page files a village on a **rim (ring 128) province**
   (「辺境の村を申し込んでいます…」 → 「辺境の村を申し込みました。ターンの終わりに決まります。」), and a few turns later (under heavy load
   about 60 turns / 10 minutes, showing 「村の受け取りを確認しています…」 meanwhile) 「（名前）の集落ができました」 appears. While the village name carries 「仮」 (provisional), press 「収穫する」 on the
   village screen once to confirm it (「…が確定しました」). A rim village has no 「初めての建設」 (one-minute first
   build): the farm takes 1 h 30 min (about 1.5 minutes at ×60).
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
      「到着候補：ターン A〜B」. The card scrolls its newest result into view by itself. A read that is still running
      when the world's clock moves cannot be used; the page reads again by itself up to 2 times, and if that still
      fails it says 「読み取りの途中で世界の時計が進んだため… もう一度押してください。」: press again.
   3. Press 「最も早い候補（ターン A）を使う」 (the field for typing an arrival turn yourself is inside 「詳細」 at the
      bottom of the card).
      At ×60 the next 「出発条件を確認」 may keep refusing this candidate with 「到着ターンの候補が、記録から計算した範囲に
      入りません。」 (all 24 tries in loop-play6: the check recomputes on the chain's clock). Then type the current turn + 5
      or so into the arrival field in 「詳細」 first, and press 「地形・時間を確認」 → 「出発条件を確認」 (loop-play6: 17
      presses, 18 s, then it departed). Do the same when 「地形・時間を確認」 with an empty arrival shows nothing.
   4. 「出発条件を確認」 → when it says 「この読取時点では、軍勢と村の出発条件を満たしています。」, press
      「出発する（ローカルプレイ）」. At ×60 「…満たしていません。 (NotResident)」 is common (the province is settled for
      only part of each turn): wait a few seconds and press 「出発条件を確認」 again. In this check it took more than
      10 presses, about 2 minutes (loop-play5, before the runner-throughput change #109: about 60 presses, about 10 minutes at load 5–6 on this Mac; fix-loop5, after #109: 16 presses, about 27 s). A turn
      change clears the check's result; press again then too.
   5. 「出発が確定しました（ターン N に到着予定・移動枠 0）」 means it departed.
   - **On the arrival turn this page can open the seal.** Normally the world's keeper opens it, but at ×60 on a
     loaded machine it can miss the window of about 10 s (in this check the first expedition was missed, §8). On the
     arrival turn press 「封を開けるか確認する」 inside the boundary card → 「封を開く（ローカルプレイ）」 (this check did not
     get to press it inside the window). 「封を開ける期間が終わっています。(RevealWindowClosed)」 means that expedition
     will never settle.
   - Before sending the next host, press 「結果を照合する」 under the card's 「送信しました。確定はまだ確認できていません」
     once (until then 「出発する」 is not shown).
   - The bar button says 「送信しません」 (does not send), but in local play the card's last button really departs.
4. **A march inside the wide land (wide → wide)**: open the village of step 2; it has the card
   「広い土地の軍勢（テスト）」. Pressing 「次の一手（広い土地）」 goes one step at a time: train spearmen → muster a
   host → march on the next province's keep (the card states the next step in English, e.g. `a host of 100 Spearmen
   at the wide village …` = muster, `the host (100 troops) marches wide -> wide … arriving turn N` = march).
   - A new village's province starts far behind the chain (loop-play4: 77 turns after the village was made;
     loop-play5: up to about 180 turns). **Do not keep pressing while the province is behind.** The card says
     「この村の州の決着が N ターン遅れています。…このページが約 1 ターンごとに自動で確かめ、送れるようになったら一手を
     送ります。」 and waits by itself (the button reads 「待っています…（押す必要はありません）」; 「待つのをやめる」 stops
     it). A step refused because the turn changed while it was being sent (NotResident) is sent again next turn by
     itself.
   - The world's keeper opens the march's seal and catches the target province up even when it is far behind (in this
     check: reveal, clash and settlement within minutes of the arrival). The bottom bar's 「進軍」 list does not show
     marches inside the wide land. Staying on a keep for 72 turns takes it. **The page does not yet show that march's
     result (clash, hold progress)**: after the departure the card keeps saying `its host is away (a march is open)`
     (loop-play6: revealed on turn 365, destination settled through turn 433), and the destination stays blank in the fog.
- **What you see**: the wide land is drawn on the ordinary map and on 「全体図」, outside its six corners, **as far as you
  have seen it** (fog). 「支配する州」 and the standings also count rim and wide-land keeps (#102).
- **The AI residents** also take rim villages, save up, claim wide land, send expeditions and wage war. Their battles
  are on other nations' rims, so the fog hides almost all of it; only an attack on your own nation's keep shows in
  「国と領土」.
- **To watch an AI capture**, `--wide --speed 15` (a turn is 40 s) is the steady choice (the #102 check: standings kept
  up, and a capture reached them about 90 turns after the start). Since runner-throughput the standings keep up at ×60
  too (a few turns behind), but a war goes by fast there. A wide village's cost then takes about 2 hours to save.
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
- **Other nations' clash reports and 「戦いを再生」** are offered only while the province's keep tile (the whole
  province when it has no keep) is in sight now; a few rim tiles in sight are not enough. Your village's province and
  the clashes your own marches arrived at are always yours to see. Opening a report out of sight says
  「この場所はいま見えていません。…」 and reads nothing. The map's clash marks (the red ring, the minimap dot,
  「このターンに衝突あり」), the chronicle's clash lines and 「最近の衝突」, and other nations' keep contests and captures
  follow the same rule (keep news your own nation is in is always shown). Other nations' map moments (「…の新しい村」,
  a host setting out, an arrival, a camp gone) play only where their tile is in sight now, and the march card's
  「近くの行き先」 lists camps only on tiles you have surveyed.
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
  `--resume` does not remember `--minutes`: for a long session pass it again, e.g. `--resume --minutes 240`.
- To delete the test key, press 「このブラウザに保存した試験用の鍵を消す」 in the page's panel. A world's folder stays until
  you delete it.

## 7. Local only, and the same as devnet

| | Local (this script) | The devnet playable version (not deployed yet) |
|---|---|---|
| Program | a local-only `.so` (program id `[0x45; 32]`, never deployable) | the devnet `.so` (another build; the local features are not in it) |
| Centre | **none** (the world's own Season byte `centre` = 1) | the presets keep the centre (the `CENTRE_PLAYABLE` switch is r0ze's) |
| Village that may claim wide land | from a Hamlet (`--wide` only: `outpost_tier_min` = 0) | the wide preset `S1_DEVNET_WIDE_7D` also from a Hamlet (0 since #104); `S1_LOCAL_7D` from a Town (1) |
| First village on the rim | test participants settle first in the setup; the keeper settles the claim | done in #104 (the keeper's rings role opens the rim provinces, its tickets role settles the request); no keeper role settles wide claims yet |
| Expedition rim → wide land | works (the 0x4804 expedition, #92) | the same instructions are in it |
| March wide → wide, capture of a wide keep | works (the local-only feature `localnet-wide-depart`, #94) | **closed** (WideDepart) |
| Clock | can run ×10–×60 (a TEST clock) | the natural speed only |
| AI residents at war, the keeper opening seals | the launcher's TEST machinery | none of this launcher's machinery |
| Fog | yes (display only) | no |

Heartland protection of keeps, the 72-turn capture, the clash computation and the costs of villages, building and
training are the same rules as devnet.

## 8. Known problems (2026-11-20, main)

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
- **A wide-land expedition whose reveal window was missed never settles.** The march screen stays on 「到着しました。
  封が開けられるのを待っています」. Worse, that rim village cannot send another expedition (the page finds no free
  transit slot: 「出発できませんでした（DepartRolesUnavailable）」). In this check, on a loaded Mac at ×60, the first
  expedition was missed (`runner.out`: `never revealed: transit 0: the reveal window of bell 262 closed unrevealed`;
  3 of the 4 AI residents' villages also logged missed reveal windows). On the arrival turn press 「封を開く」 yourself
  (§4 step 3).
- **A sieged province keeps up with the chain** at ×60 (the runner-throughput check: every province 5.9–6 turns a
  minute against the chain's 6; before it, 1–2). The keeper loop resolves the other provinces' and the sieges' turns in
  same-block batches. The standings' 「第 N ターンまでの確定した得点」 is the slowest province's turn: a few turns behind
  the turn bar (before: up to hundreds, e.g. turn 251 at turn 495).
- **A rim village that stays 「仮の村」** is confirmed by one action of your own (e.g. 「収穫する」), not at the
  「遅くとも…」 time the screen states.
- **The AI residents spend many turns on refused sends** (e.g. training the stores cannot pay). They look slow; it is
  by the rules. (Before fix-loop5 an AI stopped after 256 sends in a ×60 `--wide --ai 4` world; see the next item.)
- **The relay's send limit (changed by fix-loop5)**: the launcher's relay remembers at most 256 commands per world that
  have **not settled yet**; a sent command stops counting once its transaction's validity (about 1 minute on the local
  chain) has passed. Before, every command ever sent counted, so after 256 sends that world could never send again, with
  the false text 「今日送れる操作の回数を使い切りました…」 (loop-play5). Now a full limit clears within about a minute and
  says 「送ったばかりの命令がまだ多く決着していません。送っていません。1 分ほど待ってから、もう一度押してください。」.
  The march relay (limit 64) works the same way.
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

## 10. ② rights in a coexist world (`--coexist`, TEST-only, 2026-11-20)

`scripts/play-local.sh --coexist` runs the usual kept world (or `--demo --speed N`) on the ②+⑨+⑩ **coexist lane**
(program version 0x7805, `RULESET_HASH_V4`; `scripts/build-frontier-localnet-coexist-sbf.sh`). Its runners, herald and
tools are built with their `coexist-lane` feature into `.local/play-local/coexist-bin/`; the default world's binaries
are untouched. It works with `--ai`, `--two`, `--random-map` and `--resume`, not with `--wide`. `--coexist-node` is the
old page-less node.

The village screen gets a **Rights (stock swap)** card (owner decision ② A):
1. A workshop village (Build → Workshop) is the *facility*. Another player builds a storehouse (Vault) on a free tile
   of the **same Province** (map tile card → build a storehouse), and brings ore and wood into it by caravan.
2. The facility's owner issues a right (wallet only, 25 gold from the facility): number of swaps, most arms, days.
3. The grantee reserves units (2 ore + 1 wood per arm leave its Vault, arms leave the facility), then executes: the
   arms land in its Vault and leave it **only by caravan** (raidable).
4. The issuer may revoke (an open reservation is undone) and then close the right (its rent comes back).
5. Local play has no keeper delivering caravans: once your caravan has arrived, press **Deliver the caravan** in the
   same card (SettleCaravan; the fee comes back to you).

Fog rule: the card lists only rights you issued or received; rights between others and others' storehouse contents are
never drawn. At the natural clock a Vault takes most of a day of production; `--coexist --demo --speed 60` plays the
whole loop in about 10 minutes. The caravan path limit (32 tiles / 4 provinces) means both players should be close:
with `--two`, both join the same nation.
Even in the same nation, `--random-map` may put the two homes in opposite provinces across the centre (2 of 3 worlds
in loop-play6); then stop with Ctrl-C and start the world again until both homes share a province.
