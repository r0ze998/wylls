# Play-check locally (TEST only, one command)

How to try the playable lane (expedition, wide land, taking a keep) on your own Mac before anything goes to devnet.
Only the `--wide` world shows the wide land (rings 129 and out, §6); every other local world's map ends at ring 16.
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
- There are three kinds of world:
  - **A kept world (the default):** the natural clock (a turn is 10 minutes), and the world never ends by the rules.
    Stop it any time and continue later with `--resume`, from the same village. The chain is kept in
    `.local/play-local/kept/`, and the page's test key is kept in this browser.
  - **The 15-minute capture demo (`--demo`):** a ×60 clock (a turn is 10 s), so you can try up to taking a keep in about
    15 minutes. It is not kept: a stop ends that world.
  - **The wide version (`--wide`):** during its setup the map is grown to ring 128 and the wide land beyond it (rings
    129–131) is opened. It is not kept. See §6.
- Useful options:
  - `--resume`: continue the last kept world
  - `--fresh`: start a new kept world (the same as leaving out `--resume`)
  - `--random-map`: give the new world its own map. Without it **every local world has the same map** (the local chain
    always starts at one fixed clock origin, so every world draws the same genesis seed: the same terrain, village
    sites and Free City). With it the world starts at a randomly picked earlier origin and the program derives another
    seed by its unchanged rules. What stays the same by rule: the six-fold symmetry of the terrain, and (until the
    centre-free rules of PR #69) each nation's homes in its own wedge. Not with `--resume`: a kept world keeps its map.
  - `--demo`: the 15-minute capture demo (`--speed 30` makes it ×30)
  - `--wide`: the wide version (§6)
  - `--ai 0`: no AI residents (default 2). The AI residents are **at war by default** (fix-loop4): besides building and
    training they muster hosts and march on other nations' reachable keeps (siege, capture), one action per turn, in
    every world (kept, `--random-map`, `--wide`, `--demo`)
  - `--ai-peaceful`: the AI residents do not go to war (build, harvest, train and muster only)
  - `--two`: two people in one world (§3.1; a kept world or `--demo`)
  - `--port 41930`: other ports
  - `--lang ja`: the script's messages in Japanese
  - `--check-only`: only the checks
  - `--help`: every option
- The page follows the browser's language; its top-right button switches 日本語 ⇄ English.

## 3. What to try

In a kept world, try 1–5 (join, home, build, train, muster), then stop and come back as in §4. A new host can move only
once its turn has resolved (about 17 minutes at the natural clock). Try 6–8 (keep, clash, capture) with `--demo`, in about
15 minutes.

**In a kept world (1×) no keep of another nation is in reach of a first village.** This is the rules and the clock, not a bug:
- At the start only rings 2–3 have provinces, and every one of them is some nation's heartland. A heartland keep is never
  contested (`fkeepreach.mjs` `contestableKeeps`, the rules' `heartland_safe`), so the page says 「この軍勢がいま届く他国の砦は
  ありません」 [No keep of another nation is within this host's reach now].
- Contestable keeps come with ring 4, which opens once 65% of a wedge's open village sites are settled (OpenRing's crowding
  rule). Two AI residents and one or two people will not get there.
- Even then, at 1× a march to a keep takes several turns (a turn is 10 minutes: an hour or more), longer than the
  15-minute checklist.
- `--demo` opens ring 4 with test participants and runs a ×60 clock, so a keep can be tried in about 15 minutes.
- A tuning of the TEST preset cannot change this (heartland protection is the same rule as on devnet). In a kept world,
  check 1–5 and §4; check keeps with `--demo`.

**The centre (rings 0–1)**: the seven provinces at the map's centre have no province in this world, because the season's
rules do not make the centre ordinary land yet (the ⑭ R2 switch `CENTRE_PLAYABLE` stays off until the page's terrain and
route modules support it). The inspector says 「第1輪（中央・州なし）」 [Ring 1 (centre, no province)]; no village can be
placed there, and no march can end there or pass through (fixed 2026-11-19, fix-b14-b16: it said 「生まれるところです」 [being
made], a march there could be sent, and the host never came back). If such a march reaches the chain anyway, once its
arrival turn's window has closed the host comes home routed (half its troops).

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

### 3.1 Two people in one world (`--two`)

Normally every browser gets its own world (the launcher runs one world per browser and address, two at most). To put two
people in the same world, add `--two`:

```bash
scripts/play-local.sh --two            # a kept world for two
scripts/play-local.sh --demo --two     # the 15-minute capture demo for two
```

1. The first person opens `http://localhost:41920/` as usual and presses the start button. It says 「もう一人のプレイヤーを
   待っています」 [Waiting for the other player] and waits (about 4 minutes; after that, press again).
2. The second person opens the same address in **another browser** (or another profile), or **`http://127.0.0.1:41920/`**
   in the same browser, and presses the same button. A kept world's test key is one per browser and address, so another
   tab of the same browser would be the same player.
3. Once both have pressed, one world starts; each chooses a nation and gets a village. Marches and clashes happen in the
   same world.
- `--resume` reopens the same two-person world (with or without `--two`). Whoever presses first, the world opens for both
  without waiting. Each person uses the same browser and address as before.
- A kept world started for one person cannot become a two-person world later (start a new one with `--fresh --two`).
- Either person's 「世界を終了」 [End this world] stops it for both (a kept world can be resumed with `--resume`). A third person cannot join.


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
  - `--demo` and `--wide`: `.local/play-local/worlds/<date-time>/` (`launcher-<date-time>.log` and one folder per world;
    with `--wide` the world folder's `wide-land.json` lists the rings grown and the provinces opened).
- Report on GitHub Issues (r0ze998/wylls) with a screenshot and the folder's path.
- Known problems (2026-11-18):
  - (Fixed 2026-11-19, fix-b14-b16) A march to a ring-1 tile could be sent, and the host stayed 「封を開ける鍵を待って
    います」 [Waiting for the key that opens the seal] for good. The page no longer uses the centre (rings 0–1) as a
    destination or road, and the runner brings such a march home routed.
  - (Fixed 2026-11-19, fix-march-held) A march the chain's node did not take (sent as the turn changed, for example) now
    says 「進軍は送られていません」 [The march was not sent] with the reason, and its order card stays: the host can move;
    check the card and press again. A march sent whose outcome is not known yet is checked again by the page for about
    two minutes and released once it has expired.
  - The title's "a turn every 10 minutes" and the start screen's "two hours by default" do not hold for this test world
    (at ×60 a turn is 10 s; the world lasts 90 minutes).
  - (Fixed 2026-11-19, fix-march-held) At ×60 the land preview's FoldLand no longer runs out of compute units: it
    folds as many turns as fit (a `fold_fit` line in runner.out is a fold that asked for fewer turns).

## 6. The wide version (`--wide`, TEST only)

```bash
scripts/play-local.sh --wide
```

- The Season uses the devnet playable preset `S1_DEVNET_WIDE_7D` (PR #70: centre-free nation placement, map ceiling
  ring 128, θ 1 bp, a 36 SOL province fund).
- During the world's setup (before 「国を選ぶ」 [Choose a nation]) the program's own instructions grow the map **one ring
  per turn** to ring 128; only during that setup the local chain's clock is moved a turn at a time (the setup took about
  11 s on 2026-11-19). Then the clock runs at `--speed` (default ×60, a turn is 10 s) and the game starts at about turn 130.
  - One test resident per nation places a village near the centre (the growth rule needs "a settler in some wedge").
    One centre province is opened first and the rest after the growth, so every province is resolved up to the turn
    the game starts at.
  - The wide land on rings 129–131 is opened (WideRequestRingSeed / WideConsumeRingSeed / WideSetRules /
    WideOpenProvince): 6 provinces in the middle of each wedge, 108 in all, plus the 42 ring-128 provinces just inside.
  - Provinces on rings 5–127 are not opened (as the devnet keeper's `lazy_provinces`); the map shows their terrain only.
- To see the wide land:
  - The ordinary map and 「全体図」 [World chart]: the recorded provinces of rings 129–131 are drawn outside the
    heartland in their terrain and their keep nation's colour (a 「広い土地／第129–131輪・記録」 [Wide land / Rings
    129–131 · recorded] tag in each of the six directions). From far a mosaic of the nations' colours, nearer the
    terrain under the nation's colour, closest the 61 tiles and their sites. A place the record does not list stays
    cloud (read-only: nothing here lets a village be placed there).
  - (Under the fog of war, §7, the wide land is drawn only as far as you have seen it, and the 「記録」 view below is not
    offered.)
  - 「記録」 [Records] at the map's bottom right → 「記録された世界（読み取り専用・実験中）」 [The recorded world]. Pick a
    「第129輪」 [ring 129] province in the list, press 「ここを原点にする」 [Make this the origin] and zoom in: ring 128
    (gold) and rings 129–131 (the six nations' colours) side by side.
  - 「全体図」 [World chart] shows your village in the middle and the wide land just outside the six corners.
  - A village on the wide land (yours or an AI resident's) is drawn as its nation's sigil: on its own site when zoomed in,
    and as one mark on its province from farther and on 「全体図」, once the herald has recorded it.
- Playing on the wide land (TEST-only rules, 2026-11-19; the devnet settings and the program are unchanged):
  - **This world's own Season bytes**: the centre free (⑭ R2, `centre` = 1: rings 0–1 are ordinary land; ring 1's six
    provinces are opened; (0,0) is not, because the page's terrain kernel still draws the Concord there) and
    `outpost_tier_min` = 0 (a Hamlet first village may claim wide land; `S1_LOCAL_7D` says 1 = Town, and since owner
    decision Q-W1 of 2026-11-20 the devnet wide preset `S1_DEVNET_WIDE_7D` says 0 as well). The presets are not
    changed by this world.
  - In the setup, test residents take real first villages on two ring-128 provinces per nation (beside the wide land,
    in different wedges) by the legacy request (FileTicket → the bell's beacon anchor and seed → SettleTicket).
  - After 「国を選ぶ」 the page offers **rim (ring 128) provinces first** as the first village. A rim village is a
    one-site request (FileTicket) the runner settles at the turn's end (PlaceHome cannot name a province past the
    Season's base r_max of 16).
  - The village screen's 「広い土地に村を出す（テスト）」 [Found a village on the wide land] claims a site of a wide
    province within range 3 as the 2nd or 3rd village (0xD9 WideClaimSite; the cost comes from the village's stores,
    1,200 wood etc.; the runner settles it with WideSettleTicket / WideFinalize).
  - The clock runs at `--speed` (default 60, 10–60). A Hamlet saves the cost in about 30 game hours: ~30 min at ×60.
  - AI residents (`--ai N`) request rim villages too, save, claim wide land and send expeditions into it; by default
    they also go to war (marches on reachable keeps of other nations). One action per turn.
  - The setup brings every opened province up to the turn the world opens at, and until your first village lands a
    TEST-only warm keeper keeps every province's turns current (wide-herald-lag; before it, the rim started tens of turns
    behind and took ~10 min at ×60 to catch up). If a province still falls behind (a loaded machine), a muster or a
    departure becomes a waiting send: the page says "This province's turns are N behind: this machine is under heavy
    load …" and sends it once as soon as it catches up (no need to press again).
  - 「支配する州」 [Provinces held] and the standings count the rim (ring 128) and the wide land's keeps too (counts
    only; the herald's per-turn control map still covers rings 0–127, and its 州・時間 score counts no wide province).
- Not possible yet (2026-11-19):
  - a march into the wide land works only as the rim village's expedition (「境界への道を準備」, the 0x4804 wrapper,
    #92), and wide → wide only in the TEST-only local build (`localnet-wide-depart`, #94); devnet's SBF WideDepart is
    still closed;
  - the 「記録」 view at its smallest zoom fits one arc of ring 129 at a time;
  - a march whose reveal window closed unrevealed (the keeper loop's pass was longer than the ×60 window) holds its
    province for good (no program settlement, §−2.4f (d), blocked on r0ze); the herald writes a turn's records only
    once every opened province has resolved it, so 「支配する州」 and the standings then stop at that turn.
- Not with `--demo`, `--resume`, `--fresh` or `--two` (the wide version is for one player). A stop ends the world.

## 7. Fog of war (every local test world)

Local test worlds show a player's view, as in Civ: the page draws only what your people can see. It is presentation only
(cosmetic fog): every account on the local chain stays public and unchanged, and nothing on devnet changes. A page that is
not a local test world (devnet, the spectator page, practice) looks exactly as before.

- **What you see now:** the land around your own villages and hosts, and around your own nation's villages and the
  provinces your nation holds. Alliances share nothing.
- **What you saw before:** stays on the map as you last saw it (muted): villages, keeps and their holders as they were
  then. It is kept in this browser per world and player (`localStorage` key `ps-ffog:v1:…`).
- **Never seen:** plain paper, on the map and on 「全体図」 [World chart]; no terrain, village, keep or nation colour.
- **Other nations' hosts, marches, clashes and contests:** only inside what you see now (no ghosts). An enemy column
  coming at your village is told once it sets out from a place you see, or once it is 3 turns from arriving.
- The keep lists, the inspector, the chronicle, alarms and the minimap follow the same rule. The 「記録」 [Records] view
  (every recorded province) and the map legend's link to the spectator page are not offered under the fog.
- The one switch: `LOCAL_FOG` in `permutation-server/web/frontier/map/fog.mjs` (`false` = local worlds as before). The
  radii and the other choices are in `FOG_RULES` there.

