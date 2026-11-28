# How to play the walletless demo

The demo is one web page: **https://r0ze998.github.io/wylls/**. It needs no wallet, no sign-up and no install. Nothing
is sent to a chain or a server. You play a small sample world that runs in your browser, on the real Wylls page.
Japanese: [PLAY-DEMO.ja.md](PLAY-DEMO.ja.md). How the demo is built and hosted: [permutation-gateway/demo/README.md](../../permutation-gateway/demo/README.md).

Matches main as of 2026-11-29 (through #325 and #324). Every number below is read from the code:

- `DEMO_GOAL` in `permutation-gateway/screens/demogoal.mjs`;
- `DEMO_CAMPS` in `permutation-server/web/frontier/democamps.mjs`;
- `TRAVELERS_V1` in `permutation-gateway/screens/travelers.mjs`;
- `TERRITORY_V1` in `permutation-server/web/frontier/flocalplay-territory.mjs`.

Quoted texts are the English page's own words. The top-right button switches 日本語 ⇄ English.

## 1. The world in one paragraph

Six nations share a small map: a centre (ring 0), an inner ring of provinces (ring 1) and an outer ring (ring 2). You
pick a nation and get your first village at once. Every other nation, and your own, has an AI village. The map does not
tell you whether a village is ruled by a person or by the AI. **One turn is 12 seconds** of real time, which is 10
minutes on the demo's game clock. The first turn begins 3 seconds after the page loads. Times on the page are game time.

## 2. The goal: take 3 rival flag castles and hold each for 20 turns

This is the real flag-keeps win condition of the continuous world, made smaller.

- **Flag castles.** There are 6, one per nation. Each stands on the tile nearest the centre of that nation's ring-1
  province. A pennant on the map marks each castle in its holder's colour. At the start each castle is guarded by 110
  troops of its own nation's AI village.
- **Win.** Hold **3** flag castles of **other** nations, each for **20 turns** (4 minutes of real time). 3 is half of
  the 6 castles. Your own nation's castle never counts, even if you lose it and take it back. Each castle's 20 turns
  start when you take it. If another nation takes it from you, its timer starts again from zero the next time you
  take it.
- **Lose.** An AI nation reaches the same goal first. If you and an AI reach it on the same turn, you win.
- **How a castle changes hands.** Castle tiles are the only tiles that change hands by battle. After a turn's battles,
  if one nation's host is the only one left standing on a castle, that nation holds it. Leaving the castle does not
  give it up: you keep it until another nation's host is the lone survivor there.
- **The goal card** is at the top left. It is folded to one line on a phone; press "Show" to open it. It shows:
  - "Goal: the flag castles";
  - "Your captured castles: k / 3";
  - each castle: who holds it and its "n/20 turns" timer, or "held long ✓";
  - your own castle: "your nation’s (does not count)";
  - the rival leader: "Rival (nation): k/3", with "— wins in N turns if nothing changes" when its castles are enough;
  - "Next AI attack wave in N turns (about N troops a host)".

  While you are choosing where a host marches (Hosts → march a host), each castle of another nation that you do not
  hold has **"March here"**.
- **The end.** A result screen says "Victory" or "Defeat" and how long the game took ("Time: … (N turns, … on the demo
  clock)"). "Play again" starts a new world at once. "Keep looking" closes the screen and leaves the finished world on
  the map.

### The AI nations

- **Grace.** For 28 turns after your first village no wave comes.
- **Waves.** Then a wave comes every 10 turns: turns 28, 38, 48 and so on after your village. Each wave's host has
  100 troops × 1.12 for every earlier wave (100, 112, 125, 140 …).
- **The rival leader** is the nation two along from yours. It marches every wave with 20 % more troops. It races you
  for castles. It takes back its own castle, stops a nation that has captured 2 or more castles (yours first), strengthens what it holds,
  and otherwise marches on the nearest castle it does not hold.
- **The other nations.** One more AI nation marches each wave (they take turns). It takes its own castle back, or
  raids you: your castles first, otherwise your land. A raid on land only brings a host to fight yours. Land never
  changes hands by marching.
- **Your own nation's AI village** sends no wave. Its 110 troops stand on your nation's castle.
- **Late escalation** (#325). The wave at turn 128 after your village is the last on the 10-turn rhythm; it is the
  first wave at or after turn 120. After it:
  - waves come every 5 turns (turns 133, 138 …);
  - each wave is 1.2 × the one before, up to 30,000 troops a host;
  - a wave host left at home marches again with the next wave;
  - the other AI nations stop taking their castles back from the leader.

  The card then says "The AI waves now come every 5 turns and grow faster each time." The goal itself does not change.
  Because of this every game ends, and a game that is still open at about turn 128 now usually ends with the AI winning
  (reports/verify-pr325.md; owner question Q-V325-1 is open, so this may change).

## 3. The guide

The guide is in the side drawer as "Guide n/6: …" (n counts the steps already done, so the last step reads 5/6). Its six steps:

1. **"Nation and village"**: press "Choose a nation", pick one and press "Join (nation)". The pick screen says "Pick a
   nation to start. To win, hold 3 flag castles of other nations for 20 turns each, before a rival nation does."
2. **"First build"**: "On the Village tab, build a Farm and a Lumber camp."
3. **"Train troops"**: "Balance food, ore and gold as you train your first troops."
4. **"Form a host"**: "Muster your reserve troops into a host. Once it is ready, you can move it on the map."
5. **"Your first march to empty land"**: "Select a host, then choose an empty tile within reach or another nation's
   flag castle ("March here" on the goal card, top left). Once you take a castle, its hold toward victory starts
   counting." The same step also explains the camps: "The tents on the map are barbarian camps, with their defenders:
   beat one for food, ore and gold (press a camp in sight to see its loot)."
6. **Claim a tile.** The step's heading is "Waiting for arrival and the claim", and its button is "View territory
   changes". In the demo, though, the step is done only by **claiming a tile**: "Claim a tile" on the village screen.
   A host's arrival takes no land (§5). Until you claim one, the guide stays on this step, even through a won game
   (loop-play32 BREAK-3). No guide step tells you to march on a castle; the goal card does ("To attack: Hosts → march
   a host, then press "March here" on a castle.").

After step 6 the guide shows "Next, the goal: the flag castles": "Take 3 flag castles of other nations and hold each for
20 turns to win. The other nations want the same castles and will attack the castles you capture. They also send hosts
onto your land, but marching never takes land. The goal card at the top left shows the castles and their hold times."

Every march costs the host 74 stamina. Stamina comes back 1 a turn, up to 120, so the same host can march again only
after about 28 turns. The AI's wave hosts start with full stamina. To defend a castle you hold, train and send a new host.

## 4. Bandit camps (#319)

A tent marker on the map is a **"Barbarian camp"**. The number on the tent is its defenders. The marker shows even under
the fog.

- **Where.** There is one camp in every ring-1 and ring-2 province (18 camps). Each stands on the passable tile farthest
  from every village site. In ring 1 a camp is at least 3 tiles from the province's centre, where the castle is. The
  map is the same every time.
- **Defenders.** 300 + 200 for each province the camp is away from your first village: 300, 500, 700, 900 or 1,100.
  Before you have a village, every camp has 700.
- **Fighting.** A camp fights like any battle of the game: march a host onto it. The AI nations never march on a camp,
  and camps never leave their tile.
- **Loot.** Beat a camp and the winning host's village (your first village) gets, for each defender the camp had when the battle began, 0.3 food,
  0.1 ore and 0.05 gold. A camp of 300 gives 90 food, 30 ore and 15 gold.
  - Before you march, a camp's tile card (when the camp is in sight) says "Loot if beaten: N food · N ore · N gold".
  - After the battle, the report says "Loot: +N food · +N ore · +N gold".
  - What does not fit in a full store is left behind ("What did not fit in your village's full stores was left behind.").
- **Comeback.** 20 turns after a camp is beaten it comes back on the same tile, 20 % stronger each time (at most 1,500
  defenders). It comes back only once nobody stands on the tile and no march is heading there, so a host left on the
  tile keeps it away. The report says "From turn N, once nobody stands on its tile, the camp comes back stronger."
- **Is a camp worth it?** A camp is not on the way to the goal. Its loot is small next to a castle race: the castles'
  guards are 110 troops, and a camp costs the same 74 stamina as any march. loop-play32 found this, and owner question
  Q-LP32-1 is open. These are today's numbers; they may change.

## 5. Your land

Land is the live game's single-tile claim (#306). Press **"Claim a tile"** on the village screen to make one tile of a
nearby province yours at once. The price is 10 ore plus 2 % for each tile you already own, and you can claim one tile a
turn. You can claim in provinces up to 3 away from your first village, from a province where you own a tile, or from a
province with a village of your nation. Every tile costs food upkeep from your first village each turn: 0.99 food a game
hour for each tile, plus 0.48 for each province beyond 3 from your first village. One turn is 10 game minutes. If the upkeep
cannot be paid you cannot claim more. 24 turns later your farthest tiles start being let go, one a turn. The village
card's land lines and the logistics horizon follow every claim. Only castle tiles change hands by battle.

## 6. Travelers (#318)

Three travelers walk the map:

- "Tamsin, ore carrier" walks the outer ring;
- "Odo, grain dealer" walks the inner ring;
- "Lio, peddler" walks from AI village to AI village.

They walk 3 tiles a turn and rest 2 turns at each stop. A traveler cannot be attacked and never blocks or meets a
march: "Travelers cannot be attacked and never block a march."

- **The list.** The "Travelers" button at the bottom left lists them all. It says "Travelers · 1 visiting" while one
  is near you. Press a traveler to open its panel, which has "Talk" and "Trade".
- **Visiting.** A traveler within 1 province of your village is visiting: "Visiting your village — you can trade now."
  One unbroken run of such turns is one visit.
- **Trade.** Food for ore, in lots of 10 ore, with at most 3 lots a visit (bought and sold together; "Trades left this
  visit: N of 3").
  - A lot costs 30 food to buy and brings 18 food when sold. Each visit moves both prices by −4, 0 or +4.
  - Odo leans to the lower step (buy 26 or 30, sell 14 or 18). Lio leans to the higher step (buy 30 or 34, sell 18 or
    22). Tamsin may have any of the three.
  - Buying always costs more food than selling brings.
  - The buttons read "Buy 10 ore for N food" and "Sell 10 ore for N food".

  The amounts are small next to a host's cost: Q-LP32-2 asks whether they should matter more, and is open.
- **Talk.** Each traveler has three short lines about the demo's rules, in turn.

## 7. Saving, Start over, Play again (#308)

- **Save.** Your world is saved in this browser and survives a reload: "Your progress is saved in this browser, so you
  can reopen the page and carry on." The demo stores the world's inputs (your orders, trades and their times) and replays
  them at load, so the camps, castles, timers and travelers all come back as they were. A long game takes a moment longer
  to load: about 1.2 s for 300 turns (measured in Node; a browser can be slower).
- **Start over.** "Start over" is on the "Playable demo" tag at the top of the screen. It asks first ("Start the demo
  over? Your village and land will be gone, and this can't be undone.") and then starts a new world.
- **Play again** on the result screen does the same without the question.
- **A new demo version** starts a new world. If the demo has been updated since you saved, the nation picker says "Your
  saved demo world is from an earlier version of the demo, so it can't be continued. A new world starts here." A damaged
  save gets "Your saved demo world couldn't be loaded, so a new world starts here."
- **A full store.** If the browser refuses to store more, or the save grows past 2 million characters, the save is
  dropped. The tag then stops offering "Start over" and says that reloading starts over. A short session is a few KB.
- Every new world is the same map and the same start: the demo's world has a fixed seed.

## 8. Browsers that cannot run the demo

The demo signs your orders in the browser with WebCrypto Ed25519 and tests this when the page loads. If the browser
cannot do it, the picker says "This browser can't start the demo" in place of the join button, with one of two reasons:

- "The demo uses your browser's signing feature (Ed25519 in WebCrypto), and this browser doesn't support it. Please open
  the demo in Chrome or Edge 137 or later, Firefox 129 or later, or Safari 17 or later."
- "This page isn't open over a secure connection (https), so the browser's signing feature is turned off. Open the demo
  at its https address."

Nothing is saved or replayed then.

## 9. What the demo is not

- **Not the devnet world.** Nothing is signed by a real wallet, no SOL is used, and no other player is in your world.
  The devnet game is [PLAY-DEVNET.md](PLAY-DEVNET.md); the full local game is [PLAY-LOCAL.md](PLAY-LOCAL.md).
- **Some rules exist only in the demo:**
  - the castles, the waves and the result screen;
  - the camps' placement, defenders, loot and comeback;
  - the travelers.

  The marches, battles, buildings, training and the tile claim are the real game's rules, computed by the same
  `frontier.wasm`.
- **No "Records" view.** The map's "Records" button is hidden. The sample world does have a last turn for orders, as
  every test world does, but the page does not show it while it is ahead (turn 1,008; the demo opens at turn 42, so about 965 turns, 3 h 13 min of play, are left: a game normally ends with
  the result screen long before).
- **Not decided yet** (open owner questions, so these may change):
  - Q-LP32-1: whether camps should matter more for the goal;
  - Q-LP32-2: the traders' trade size;
  - Q-LP32-3: what you are told when a rival nears 3 castles, or when your castle is attacked or lost. Today there is
    no toast or notice for either. Only the goal card changes: its rival line, and the castle row's holder ("held by
    (nation)"). The Defeat screen can be the first news;
  - Q-V325-1/2: whether a comeback should still be possible after turn 128, and the win rate of careful players.
- **Known rough edges** (loop-play32; draft #327, fix-loop32, is not merged, so they are still there):
  - a camp beaten by holding the field can read as won in the battle report and then "Held: the enemy is still on the
    field too" after "Verify in this browser" (the camp is gone and the loot is paid either way);
  - Ember's (the white nation's) troop label on the map is hard to read;
  - the castle pennants and traveler markers draw over the side drawer;
  - when the turn changes while the march order card is open, "Seal and depart" can answer "Time has moved on: the host
    now arrives on turn N (until a moment ago it was turn M)." instead of sending: the host has not left, so press again.

  The texts of #327 are not described here.
