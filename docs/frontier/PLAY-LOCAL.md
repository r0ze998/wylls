# Play it locally and check it yourself (TEST only, one command)

How to check the playable version (expeditions, wide land, keep capture) on your own Mac. The same version is on devnet
(its world was created on 2026-11-26: [PLAY-DEVNET.md](PLAY-DEVNET.md)).
It uses a local chain and test keys only. No real key, SOL, devnet or paid API is ever used.
Matches main as of 2026-11-26 (through #262; §8 was last re-checked at #244). **English is the page's primary language: every quoted text here is the
English page's own wording** (the top-right button switches 日本語 ⇄ English; the Japanese page's texts are in
[PLAY-LOCAL.ja.md](PLAY-LOCAL.ja.md)).

The world is continuous: there are no seasons, and the world has no end. Only the test worlds here have limits of their own
(`--minutes`; and a `--demo` or `--wide` world's program takes orders up to a fixed turn, §4 and §6).

New since the last refresh (#222), in `--wide` worlds unless said otherwise: the village card shows **your own land**
(tiles owned, the next tile's price, land upkeep, and a warning while upkeep is unpaid: #231; read from the world's herald
since #242 → §4.1 step 1); the **map draws players' land tile by tile**: your own tiles always, other players' tiles while
they are in sight and faded afterwards. It no longer colours whole provinces: who holds a province is said by its keep
(#234, #240 → §4.1, §5); land upkeep is thirty times the first numbers (#233, #235 → §4.1 step 5), and the first village's
food rate is shown after it, with the land's part beside it (#244); tiles now also move with a keep when the same player
captures a second keep (#233 → §4.1 step 7); in every world "Send a caravan" lists only your own places, your nation's,
and what is in sight now (#244 → §5); the AI residents keep ore for their troops, build a mine first and save for their
first wide village (#236, #241 → §4.1), and `--ai-near` puts one beside you (#237 → §4.0); an external resident reads and
plays its own land (#227 → §11); what loop-play15 and loop-play16 found is fixed (#223, #225, #237 → §3 step 6, §4, §4.1,
§12); the first, whole-world view of the map is fast again (#239). What is left: §8.
When the food cannot pay a turn's land upkeep, the food the first village holds is now taken and the land stays unpaid
(#243, owner decision Q-LP17-1 (b) → §4.1 step 6; how it goes turn by turn and the refusal table: #245). Also #245: the
Train form says a part hundred costs a whole hundred, a tile claim refused for the turn limit or unpaid upkeep has no
"Try again", and the join card says its two deadlines to ten minutes ("about 1 h 40 min left").
Then #247 (loop-play18): a full province's "Claim a tile" is off with the reason, tiles let go for unpaid upkeep are
free again on the card, a falling food store says "Empty in …", and the caravan form never picks its own start as the
destination (§4.1, §5).
The devnet playable version: [PLAY-DEVNET.md](PLAY-DEVNET.md) (player land there: §7).

## 1. Install once

The script installs nothing. If something is missing it prints the name and how to get it, and stops.

| What | Version | Example |
|---|---|---|
| Rust (rustup) | 1.89.0 and 1.95.0 | `rustup toolchain install 1.89.0 1.95.0 --profile minimal` |
| cargo-build-sbf and platform-tools | 3.1.9 / v1.52 | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"` |
| Node.js | 20 or newer | `brew install node` (fine as is when `node -v` says v20 or more) |
| git, python3 | macOS standard | `xcode-select --install` if absent |
| Free disk | 20 GiB or more for the first build | |

The first build fetches crates over the network. When the world starts (its first seed) and while you play, it reads public drand randomness over HTTPS.

## 2. One command

Run it at the top of the repository. It checks the tools, builds (skipped when nothing changed), starts a world and
opens `http://localhost:41920/` in the browser. The first build takes about 3 minutes; later starts take seconds.

```bash
scripts/play-local.sh                 # a kept world (a turn is 10 min; stop it and continue with --resume)
scripts/play-local.sh --demo          # the 15-minute capture demo (×60, a turn is 10 s; not kept)
scripts/play-local.sh --wide          # the wide version (the rim and the wide land; ×60; not kept) → §4
scripts/play-local.sh --coexist --demo --two   # ② rights (Vault), the whole loop for two (×60; not kept) → §10 (⑨/⑩: §12, ① requests: §13)
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
| `--ai-near` | with `--wide` and `--ai 1–4` (off by default): one AI resident waits for your first village, then joins the nearest **other** nation and puts its village on the rim beside yours (3 provinces away on the standard map) and claims wide land toward you (§4.0) | anything but `--wide` |
| `--two` | two people in one world (§3.1) | `--wide` `--external` |
| `--coexist` | a world with ②+⑨+⑩ (§10, §12; ① request caravans only here, §13): a kept world or `--demo`; works with `--ai` `--two` `--random-map` `--resume` `--external` | `--wide` |
| `--external ADDR[,ADDR]` | admit up to two external AI residents by their **public addresses** (§11; never a key). Also starts the read-only MCP server on 127.0.0.1. A kept world, `--demo` or `--wide`; works with `--ai` `--random-map` `--coexist` `--resume` | `--two` |
| `--no-mcp` | with `--external`: do not start the MCP server | refused without `--external` |
| `--no-coop-board` | leave out the ① co-op board and ⑮'s "Titles and records" card (attached by default, §13) | |
| `--no-world-goals` | do not judge the world goals: no "World goals" card and no gold pennants (the flag-keeps judge is on by default, §14) | `--flag-keeps-hold` `--flag-keeps-need` |
| `--flag-keeps-hold N` | TEST only: how many turns a flag keep must be held, 1–100000 (default 144 = 24 hours of the chain clock; §14) | `--no-world-goals` |
| `--flag-keeps-need N` | TEST only: how many **captured** flag keeps one nation must hold, 1–12 (default: half of the flag keeps, rounded up; never more than all the flag keeps less the most one nation held when they were posted, so it can be 0; §14) | `--no-world-goals` |
| `--speed N` | the clock of `--demo` / `--wide`, 10–60 (default 60) | a kept world |
| `--minutes N` | minutes until the world's processes stop, 15–240 (default 90). A `--wide` world stops then too. To play `--wide` to the end use `--minutes 240` (§4) | |
| `--port BASE` | the page's port (default 41920). It uses 22 ports from BASE (14 with `--ai 0`); `--external` takes 8 more and the MCP server 1 (with the defaults the MCP server is on 41950, with `--ai 0` on 41942; none with `--no-mcp`). All within 41000–41999 and clear of 41904–41907 and 41970 | |
| `--lang ja\|en` | the language of the script's messages (the page: its top-right button) | |
| `--no-open` `--no-build` `--rebuild` `--check-only` `--print-plan` | do not open / never build / always build / check only / print the settings and the launcher command, and exit | |
| `--cluster NAME` | only `localnet` is accepted (any other name is refused and the script exits; it never talks to devnet or mainnet) | |
| `--coexist-node` | the page-less ②⑨⑩ node alone (for development, not for playing) | everything but `--port` |

- The AI residents' nations are fixed: the first joins Borealis, the second Ember, the third Cinder, the fourth Fjordal.
  Pick **a nation without an AI** (with `--ai 4`: Aster or Dunmar) and you never compete with one for a village site.
  The "Choose a nation" screen marks the nations that have an AI resident with a small plate, **"AI present"**, under
  the banner's doctrine; the chosen nation's lines add "This nation has an AI resident. If you choose it, that AI is your
  nation-mate." Joining such a nation works: the AI shares your nation's reach and keeps. (With `--ai-near` the first
  AI resident has no nation yet when you choose, so the marks are Ember, Cinder and Fjordal; a line under the banners says so.)
- `--random-map` starts the world at a randomly picked earlier time, and the program derives another genesis seed by its
  unchanged rules.
- The page opens at two addresses only: `http://localhost:<port>/` and `http://127.0.0.1:<port>/` (no other name, no other machine; §9).
- Stop it with **Ctrl-C** in the terminal (§6).

## 3. The 15-minute check

`--demo` takes you through 1–8. In a kept world do 1–5, then stop and continue as in §6 (at 1× a mustered host can
move only once its turn is settled: about 17 minutes later).

**March first** (owner decision 2026-11-26, Q-PT-2; pt-first-battle): the guide at the top right now leads
"Train troops" → "Form a host" → "Raid a nearby barbarian camp" (step 5a below) → "Build" → "March on a keep" →
hold → capture, eight steps ("Guide 1/8" …). Building and scouting come while the first march walks. The steps below
keep their old numbers; follow the guide's order. A newcomer can also check a battle in this browser within minutes:
the **"While you wait"** panel (bottom left, above the to-do tab; step 7).

1. **Join**: "Start the world (a kept world resumes)" (with `--demo`: "Start a new world") → "Choose a nation" → pick a flag, then
   press "Join (nation)". The first village is placed for you. No key card and no wallet prompt appears.
2. **Village**: "This is your village." means it worked. The bar above the map shows a number per good, as many as fit
   (in a 1280-px-wide window: food, wood, stone and ore with "2 more" at first, only food and wood with "4 more" once the
   "Fields" chip joins the bar); "N more" (or any number in the bar) opens "Resources", every good with its rate
   (e.g. "Ore" "+4 per hour"; loop-play21, verify-pr255). A village with
   "No ore from the land" can only grow to about 600 troops (on the standard map every auto-placed first village in loop-play21 was one: 4 of 4).
3. **Build**: "Choose your first building" → the farm's "Build". It finishes in about one (in-game) minute. The guide
   asks for it after the first march has left ("Guide 4/8 Open the build list", with "Your first march is on its way; its
   report is expected in about N min …"); you may build earlier, it does not skip the camp step.
4. **Train**: "Train" in the bottom bar → "Max 500" → "Train 500 Spearmen". It finishes at once.
5. **Muster**: "Form a host" in the bottom bar (or the guide at the top right when it says "Form a host") → "All" (the whole reserve when the order goes, including a training batch that lands after the card opened; fix-loop9 LP9-5) →
   "Form N Spearmen here". When it says "This province is still resolving the last turn." you **may press anyway**: the
   muster waits and is sent once, as soon as the province is ready (no need to press again; it is withdrawn if the
   unit or the number changes). Even in `--demo` at ×60 this wait is now rare (#146: your province is ready for a muster
   about 80 % of the time, before about 30 %; in verify-pr146 the line was absent and the order went at once; §8.2).
   The village screen's "Troops" → "Form" cannot be pressed while the province settles
   (only the bottom bar's "Form a host" waits and sends). While the host forms, the guide at the top right says
   "Guide 2/8 Wait for the host to form" (with something to do meanwhile added as "Meanwhile: Open the build list" or the like). When it
   says "Prepare a march on this camp" (or "See the keeps in reach" later), the host is mustered.
5a. **First battle: a nearby barbarian camp** (pt-first-battle): "Guide 3/8 Raid a nearby barbarian camp". The guide picks the
   nearest camp in sight that your host beats even with bad luck ("Make your first battle the barbarian camp of (place) (N defenders).
   Your host (500 Spearmen) should win even with bad luck. Seal and depart, and the first battle report comes in about 38 min
   (about 38 seconds in real time) at the earliest."). Its button "Prepare a march on this camp" opens the march card with the camp
   filled in: press "Send this order". Before the host is formed, "Train troops" already says what the camp takes ("Your first battle
   is a nearby barbarian camp (156 defenders). Gather 200 Spearmen or more into one host …"). With too few troops it says the odds and
   "Train more troops before you go"; with no camp in sight it offers "March: choose on the map"; "Skip this step" moves on to building.
   The guide only picks a camp that will **fight** (fix-firstcamp): a camp joins a battle only while fewer than 12 villages stand in
   its province, so a camp in a province of 12 villages is passed by and named ("The camp of (place) is nearer, but 12 villages stand
   in its province, so it does not join battles …"). In a `--demo` world (fixed map) the home province and soon a neighbour fill with
   12 villages, so the first camp is further away. The step also says the way there ("The way there: 6 tiles · 2 provinces · arrives
   turn 9 (…)") and when the report is expected after that arrival. If every camp in sight sits battles out, it offers "Fight a
   practice clash" (a practice battle, not a chain record) and says to look further with "March". The march card's outlook does not
   count a camp that sits out ("The barbarian camp here (196) does not join the battle …", outlook "Unopposed").
   The guide also names only a camp your host can **reach** (fix-camp-reach): one march crosses at most 4 provinces and 32
   tiles, and the guide asks the same route question as the march card, so it never names a camp whose card would say "No path
   there was found". A `--wide` rim village whose camps in sight are all out of reach gets "No camp in reach yet: no barbarian
   camp in sight is within this host's reach (one march goes at most 4 provinces and 32 tiles). Meanwhile, try a practice
   battle …" and "Fight a practice clash". The fog is unchanged: a camp under the fog, even in your own province, is not named.
   In the live checks (×60) a 500- or 200-Spearmen first host beat camps of 156–389 defenders.
6. **March on a keep**: press the guide at the top right when it says "See the keeps in reach" (if it stays on
   "Check your host's readiness", open "Nation & territory" in the bottom bar once). Pick a keep's row and press "Send this order".
   The card the guide opens, "March on a keep · N keeps in reach", gives each row's arrival as "Turn 22 · arrival (13 tiles)"; the
   order card then says the wait, "Turn 23 · in about 32 s on the test clock" (loop-play21). The keep rows under "Nation & territory"
   say both in one line: "13 tiles · 3 provinces · arrives turn 36 (in about 28 s on the test clock)"
   (at the natural clock "… arrives turn 6 (in about 48 min)"). A march arrives when its arrival turn begins, so this is longer than the walk itself
   (before fix-loop15 the row said the walk's time, "about 40 min", beside an order card saying "in about 48 min": loop-play15 LP15-9).
   The arrival turn can move on by one or two while the card is open or the send waits for the province (loop-play21: row turn 22,
   card turn 23, "It arrives on turn 24" after the wait).
   While the province is settling, the same order is sent once, as soon as it can be. "The first march" means it left.
   - In a kept world that has just started (a turn is 10 min), a press at the start of turn 2 shows "Finding the keeps you can reach…"
     and "In a world that has just started, the list of keeps in reach appears once the first turn's results are all in (a few minutes)." until the world's first
     turn results are all in (1–2 minutes into turn 2); the list follows about 30 s later (#195; loop-play13: 3 s).
   - When the list says "0 keeps in reach" ("No other nation's keep you have seen is within this host's reach now."), no other nation's
     keep is in sight from your village (common with `--random-map`). The guide at the top right and the list's card then
     offer "March: choose on the map" (#130). Press it, or "Marches" in the bottom bar, pick the ring-1 keep's tile on the map as the destination (you can
     press it while it is blank under the fog) and "Send this order" (the destination is called "Out of sight").
     Every march spends 74 stamina (the same for any path length, nothing comes back for a short one; the cap is 120) and
     stamina returns 1 per turn: after a scouting march to a far blank tile the host has to wait for stamina (28 turns
     when it left with full stamina) before it can march on a keep (loop-play6: about 30 turns).
   - **When no host is in the village** (#176): after the host marched out, the guide at the top right says "There is no host at the village now. When the march's record is closed, its surviving troops come back to the village (none come back if it was wiped out)." with "See the march's result".
     When the host did not come back (wiped out, or it took the keep and became its garrison) it says
     "Your last host was destroyed at (province) and no troops came back." or "No host can march (your last host did not come back).", then
     "A march on a keep needs a new host: first train troops." (with troops in the reserve: "… muster one from the reserve.") and the
     button "Train troops for the next host" or "Muster the next host". The button only opens "Train" or "Form a host"; nothing is sent. The wiped-out line has not been seen in a live world
     yet (unit tests only; verify-pr176).
   - **When a sent march gets no answer** (the relay answers after the page's 30 s limit; rare, seen under load): the notice says
     "The march was sent, but it is not confirmed yet. The same march is not sent again. The page keeps checking for a while (Try again checks too). Signature …"
     and the page asks again by itself for about 2 minutes. If the march was recorded after all, it shows as an ordinary
     march. If it was not, the notice says "That did not work" with "The march was not recorded in time, and now it never will be."
     (asked later: "The march that was sent was not recorded in time, and now it never will be. The host is still at the village and can be ordered again.";
     refused by the chain: "The march that was sent was refused on chain. The host is still at the village and can be ordered again.").
     The host is at the village, the guide goes back to "Guide 5/8", and "Try again" reopens the march card: press
     "Send this order" again (#193, #200; verify-pr193 and verify-pr200 played both in English and Japanese). What is
     left: once the 2 minutes are over, no button asks again (§8.1).
7. **Check the clash**: a turn or two after the arrival turn the notice "The clash on the (place) is resolved (arrivals of turn N)"
   appears, with "View" and "Report". "Report" → "Verify in this browser";
   "Match: the outcome recomputed in this browser is the chain's record" means it was recomputed and agrees.
   **"While you wait"** (pt-first-battle; owner decisions Q-PT-1, Q-PT-3, Q-PT-13): a panel at the bottom left, always there, folded
   or opened by its title button (the choice is kept per world). It is built from your own records only: "Your battle report (arrival on
   turn N): in about … ", "Seal and depart this turn and the battle report comes at the earliest …", "(troops) are regaining stamina and
   can march again from turn N …", the land upkeep (wide land) and a keep you are holding. Under "Things you can do": **"Verify a real
   battle in this browser"** opens your own resolved clash, or else the newest clash in a place you can see now (the fog's own rule; no
   other battle is offered), and "Verify in this browser" then shows "Match". With no such battle yet it offers **"Try "Recompute" on a
   practice battle"**: the practice battle (not a chain record) → "Run the clash" → "Recompute in this browser" → "Match (practice)".
   After your first "Match" (or the practice one) the offer goes away. In the live checks the practice match came about a minute after the
   village, the real "Match" on your own camp raid about 4–5 real minutes after it (×60; at 1× the own report is about an hour after the
   village: the march takes at least two turns and the seals' window and the seed another ~12 minutes).
   The same in a `--coexist` world (it answered "Could not check (a record is missing)" there until fix-loop14, LP14-4).
   A report whose record does not say what was left of a side — an older turn of a host standing on a keep's tile:
   "316 → —" — runs this check by itself when it opens and shows the numbers with "Match".
   After the notice is gone, the "Report" button stays in the list under "More" in the bottom bar.
8. **Capture**: hold the keep's tile for 72 turns (about 12 minutes or more at ×60; about 12 hours at 1×). "Holding the keep"
   and the round number on the keep, or "(nation) has besieged it for N of the 72 turns a capture takes" in the clash report, show the progress. A held turn counts
   whether the province's turn is resolved or skipped (the #120 check: 11 AI captures at ×60 in `--wide --ai 4`, each
   after exactly 72 held turns).
   The keep list and the guide at the top right also say how long 72 turns are ("about 12 hours" at 1×,
   "about 12 minutes of real time in this world" at ×60). After a capture the guide of a kept world says
   "This world goes on; war-period winners and counts are not decided yet.". **There are no seasons and the world does not
   end**; what a nation can achieve is the permanent world goals, and the first of them, the flag keeps, has its card under
   "Nation & territory" (§14). In `--demo` and `--wide` worlds, whose TEST program still has an end turn, the guide says
   "This test world stops taking new orders at a set turn. That is a limit of test worlds, not a rule for winning." and
   "Nation & territory" names the turn: "This test world takes new orders until turn N (… left). That is a limit of test worlds, not a rule for winning."
   (#208; no text names a winner at an end any more). The only thing that ends there is the test world itself (§6).

Good to know:

- **There is no centre (a rule of local worlds only, #88).** The six ring-1 provinces are ordinary land, each starting
  with a keep held by some nation (on the usual map: one per nation). Heartland keeps (rings 2–3) are protected and
  cannot be taken, but **ring-1 keeps can be contested**. In a kept world too the AI residents march there (in the #98
  check: departures on turn 8, clashes on turns 12–13); when your own nation's keep is attacked, a notice says
  "(nation) began contesting the keep of province P,Q / Your nation is defending". "Nation & territory" lists it under "Keeps of your nation that another nation is taking … Defend", also when no host of yours can reach that keep (it then adds "None of your hosts can reach it now."; #130). Only the middle province (0,0) is "Ring 0 (centre, no province)": never
  a destination or a road. A first village can only stand in ring 2 or further out.
- **Because of the fog, the keep list shows only the other nations' keeps you can see** (§5). "No other nation's keep you have seen is within this host's reach now." is not a defect.
- In a 1× kept world you can see sieges but hardly a capture (72 turns = 12 hours). Check captures with `--demo` or
  `--wide`.

### 3.1 Two people in one world (`--two`)

Normally every browser (address) gets its own world (two at once at most). `--two` puts two people in one world.

```bash
scripts/play-local.sh --two            # a kept world for two
scripts/play-local.sh --demo --two     # the 15-minute capture demo for two
```

1. The first person presses "Start the world" at `http://localhost:41920/`. It says "Waiting for the other player" and
   waits (about 4 minutes; after that, press again).
2. The second person opens the same address in **another browser** (or profile), or in the same browser
   **`http://127.0.0.1:41920/`**, and presses the same button (one test key per browser and address).
3. With both there, one world starts; each picks a nation and places a village.
- `--resume` brings the same two back (`--two` is not needed). Open it in the same browser at the same address as before.
- A kept world started for one person cannot become a two-person world later (start a new one with `--fresh --two`).
- When either presses "End this world…" (a kept world: "Stop this world…") it stops for both. A third person cannot join. `--wide` is for one person.

## 4. Check the wide land (`--wide`, about 60–90 minutes)

```bash
scripts/play-local.sh --wide --ai 4 --minutes 240
```

The wide version is started with `--wide` alone (no `--fresh`, `--resume`, `--demo` or `--two`; the table in §2).

During the world's setup (about 20 seconds) the program's own instructions grow the map to ring 128 (the rim) and open
the wide land beyond it (rings 129–131, 108 provinces). The game starts around turn 140, at ×60 (a turn is 10 s).
The wide land starts **neutral**: every wide keep is unowned. Land is owned **tile by tile** by players, and the map
colours only those tiles (in the colour of the owner's nation); who holds a province is said by its keep. Both are in
§4.1, after the four steps below.
The default 90 minutes may not even reach step 2 below, so add `--minutes 240` (the maximum): saving a wide village's
cost took 36–75 minutes and a keep is held for 72 turns, 12 minutes or more (measured in fix-loop10, verify-pr173 and
verify-pr175 at load 60–160).
A `--wide` world is a TEST world with a limit of its own: its program takes new orders up to a fixed turn. The join card
says so ("This test world takes new orders until turn 1,008 (about 2 hours left; a limit of test worlds)."; the
game starts around turn 140, so that is about 145 minutes of play at ×60). This is the test world's limit, not a rule of
the game: the real world is continuous.
In the wide version every page that presses "Start a new world" gets **a world of its own** (a second page cannot enter
the first page's world; two at a time, a third is refused with `WorldLimit`; verify-pr176).

1. **A rim village**: at "Choose a nation" pick a nation without an AI (with `--ai 4`: Aster or Dunmar) and press
   "Join (nation)". You do not pick the place: the page files a village on a **rim (ring 128) province**
   ("Requesting a village on the rim…" → "The rim village request was sent (turn N, M turns ago). The world decides it at the end of a turn. … This page keeps waiting; no need to press again."), and a few turns later (3–5 turns in verify-pr130; under heavy load
   about 60 turns / 10 minutes; **no need to press again**) "You now have the hamlet of (name)" appears. While the village name carries "Provisional" (provisional), press "Harvest" on the
   village screen once to confirm it ("… is now confirmed"). A rim village has no "First building" (one-minute first
   build): the farm takes 1 h 30 min (about 1.5 minutes at ×60).
   - "Join (nation)" takes on one press (#130; each of the 8 joins in verify-pr130 took one). While the page is
     reading the village sites the button reads "Preparing your village…" and cannot be pressed.
   - If a card "While you were away: This device holds no "seen" mark for this world and wallet…" comes first, close it with
     "Mark as seen" (the world starts around turn 140; it is not a defect).
2. **A wide village (30–60 minutes at ×60; 75 under heavy load)**: the village screen's "Found a village on the wide land (test)" shows
   the cost — the program's price, for a second village "Cost (from the village's stores): Food 800 · Wood 800 · Stone 400 · Gold 200" — and the
   candidate provinces. Once the stores hold that amount, "Found a village here" can be pressed (until then the card says
   "Short: …" and the button is off). **It takes two presses** (#209: a village stands only on your own tile). The first
   press claims the site's tile, at once, for ore (10 at first; §4.1): "That tile of wide-land province P,Q is now your land. Press again to put a village on it.".
   The second press files the village: "A village was requested in wide-land province P,Q. It is decided at the end of the turn.".
   A tile claim is one a turn: if you pressed "Claim a tile" in this turn already, the first press is refused (§4.1,
   "When a press is refused"); press again next turn. The claim is decided at the end of the turn and the village is drawn on the map
   with your nation's sigil. Right after the claim the same card already quotes the next (third) village's cost,
   Food 1,200 · Wood 1,200 · Stone 600 · Gold 300: that is not what you just paid (loop-play13).
   - While the first village's name still carries "Provisional" the program refuses this claim (NotFinal). Press "Harvest" once
     first to make it final (step 1; the card does not check this).
   - **More provinces than the ones near home** (#206): the rows marked "from your nation's land (P', Q')" are reached
     through your nation's land, not from your village (§4.1).
   - Each province row also has "Claim a tile" (#209): your own land, tile by tile (§4.1).

   Once the village exists (the "W2" button normally comes within a few turns of the claim; once, under load, about
   80 turns later: loop-play12), the easiest way to
   open it is the "W2" button under the village plate at the bottom left (it opens "Far village, ring 129 (slot 2)");
   inspecting that province on the map → "Your village (wide land)" → "Open this village" works too.
   - Training (§3 step 4) spends the stores' food and gold. Claim the wide village first, then train: the wait is
     shorter.
3. **An expedition (rim → wide land)**: train and muster in the rim village (§3 steps 4–5), select the host in the
   bottom bar (e.g. "500 Spearmen") and press "Prepare a boundary route".
   1. Draw the road one step at a time with the direction buttons ("East", "North-east", "North-west", "West", "South-west", "South-east") or the dashed tiles
      on the map, until "Endpoint derived from the route" is a wide-land province (ring 129 or more). Only the provinces the map draws
      are open (at first the strip of rings 129–131; more opens later around villages and won keeps). When the road ends on an unopened one, the card says at once "The end province P,Q is not open in this world … The nearest open province is … (N provinces away).".
      A road is at most 32 steps and may enter at most 4 provinces; the card counts both ("27/32 · 4/4 entered provinces").
      At the limit a press adds nothing and the card says why (fix-loop16, LP16-6): "The geometric route is limited to 32
      steps and 4 entered provinces. This step cannot be added. Change the road with "Undo step", or pick a nearer keep."
      (the line goes after an undo). A keep farther than that is out of an expedition's reach.
   2. "Check terrain and time". "A host cannot march onto mountains or water (N)" means step N is impassable: "Undo step" or "Clear route"
      and draw another road (the card draws roads without looking at terrain). A passable road shows
      "Proposed arrival range: turns A–B" and the button that fills in the arrival turn (step 3). The card scrolls its newest result
      into view by itself. When the world's clock moves during the read, the page reads again by itself up to 2 times
      ("… it is being read again (1 of 2)…"); if that still fails it says "The world's clock moved on while reading … Press again.": press again. A read's result now stays until you change the road, with
      "This is what was read for this road. It stays until you change the road." (#137; in loop-play8 an impassable road's "A host cannot march onto mountains or water The road stops at step N (West). …" was still there after 15 s).
   3. Press "Use a turn that leaves time to send (N)" (at ×60; at 1× it is "Use the earliest proposed turn (A)"). At ×60 the proposal is
      the earliest turn A plus the turns the clock moves while you check and send (3) plus the province's settle lag.
      The bare earliest turn had already gone by when the next "Check departure conditions" came back, and was refused every time
      (loop-play6 LP6-1, fixed by #130; in verify-pr130 no arrival turn was refused in 5 departures). The press fills
      the arrival field and the page reads the road again. The field for typing an arrival turn yourself is inside
      "Details" at the bottom of the card (normally not needed).
   4. "Check departure conditions" → when it says "The host and holding satisfy the departure conditions at this observation.", press
      "Depart (local play)".
      - At ×60 "… do not satisfy the departure conditions at this observation. (NotResident)" is common (the province is settled for only part of each turn).
        **This is the one place where you do press again**: wait 1–2 s and press "Check departure conditions" again. The check only
        reads; it sends nothing (and does not count against the relay's send limit). In verify-pr130, 3 of 5 departures
        were refused on the first press and passed on the second or third (before #130: 17 presses / 18 s in
        loop-play6, 16 presses / 27 s in fix-loop5).
      - At ×60 a check's result leaves the screen at every read of the world's clock (0.3–2 s; verify-pr117 V117-1).
        Right after it has gone, "Depart" still works as long as the road and the arrival turn are unchanged: the
        page reads the conditions again and departs if they hold (#130). If the button is no longer shown, press again
        from "Check departure conditions".
      - When it does not work:
        "The proposed arrival turn is outside the range calculated from these records." = the arrival turn is too early (press step 3's button
        again, or type a later turn in "Details"). "No arrival turn yet. Press Check terrain and time …" = the
        arrival field is empty (go back to step 2).
   5. "Departure confirmed (arrives turn N; transit slot 0)" means it departed.
      - **If the card stays on "Sent. Not confirmed yet. Signature …"**, wait for the page's own check or press
        "Check the result". When the chain refused the departure after it was sent (NotResident, when the turn changed between the
        check and the send; loop-play11 LP11-1), what the page says and how to send again is under "The chain can refuse a
        departure after it was sent" below (since #184 a refused expedition does not stay in the "Marches" list).
   - **The world's keeper opens the seal.** After the arrival the map tag goes "Arrives on turn N" → "Arrived · waiting for the seal to open" → "Arrived · the seal is open · waiting for the result", and once the target province has caught up the
     march screen says "The result has been collected. Stays: the host stands in the wide-land province (500 troops)". Just wait (in fix-loop5,
     verify-pr117 and loop-play6 the keeper opened it inside the window every time).
   - **An expedition that lands on a wide keep's tile holds it** (72 turns take it). The march card follows the hold
     (fix-loop9 LP9-2; it reads that one province about once a turn): "The expedition is holding the keep of province P,Q: n / 72 turns. …",
     then "Keep taken: the host became the keep's garrison (keep garrison N, as recorded at turn T)" and "Result: the expedition took the keep of province P,Q. …",
     or "Result: the keep of province P,Q was not taken. …". The number in brackets is the garrison in the chain's keep record
     (fix-loop10 LP10-5). A capture leaves half of the holding
     host in the keep, or all of it when the rest would be under 100 (loop-play10: arrived with 1,289, garrison 644;
     fix-loop10's check: arrived with 189, garrison 177). The result is also said once as the notice at the top of the
     screen (checked for LP10-6: it is the page's single notice slot, shown until the next notice replaces it; there is no
     list to read it again, so if you miss it, look at the march card). After a capture, a wiped-out expedition ("Destroyed: the host was lost") or a host gone from the keep's tile, the card adds that the next expedition needs a new host and a "Raise the next host at the village" button (it only opens that village's "Form a host" or "Train" card; nothing is sent; w2-wipeout). When the host that takes the keep has 200 troops or more, the half that does not become the garrison stays on the keep's tile as a host, but the page has no order for it (there is no order for a rim village's host standing in the wide land; verify-pr176: arrived with 488, garrison 242, 242 on the tile; whether it should be usable is undecided). The host sees from its tile, so the province is drawn on the map
     (since #197 each wide province also shows its keep with its holder's standard, the hosts standing on it as one figure per tile with their troops, and a plate that names the keep's holder, "Keep: Aster" / "Keep: your nation" / "Keep: no nation", with "Dunmar is taking the keep · n/72 turns" at a keep that is being taken (until #234 the plate named the land, "Lands of Aster"; the land's colour is now the players' own tiles, §4.1); under the fog only hosts on tiles in sight; a province whose holder was never in sight has no plate and no keep, and before the first village no host or keep contest is drawn: verify-pr197), and "Nation & territory" lists it under "Keeps your hosts have reached (not your nation's)". Since #197 an
     expedition's column also walks its road on the map from the departure turn on, instead of standing at the village until
     the arrival (verify-pr197: turns 189 → 193, half-way at 191).
   - As a backup, on the arrival turn this page can open the seal too ("Check whether the seal can be opened" inside the boundary card →
     "Open the seal (local play)"). Before #105, at ×60 on a loaded machine, the keeper did miss the window of about 10 s
     (§8). "The period for opening this seal is over. (RevealWindowClosed)" means that expedition will never settle.
   - While the card says "Sent. Not confirmed yet.", the next host's "Depart" is not shown. Since
     fix-loop11 the page checks the result itself on each read and the line turns into confirmed or refused (verify-pr184:
     confirmed within seconds without a press). If it does not change, press "Check the result" under it once.
   - **The chain can refuse a departure after it was sent** (NotResident when the turn changes between the check and the
     send). The page checks the result itself each time it reads the "Marches" list; when it was refused it says once at the top
     "The chain refused the expedition's departure: … (NotResident). The host is still in the village. Press "Check departure conditions" on the boundary card to read again, then you can depart again.".
     The card says "The chain refused the departure: …. The host did not leave (it is still in the village) and is not listed under marches."
     and the expedition leaves the "Marches" list. More often the refusal comes from the world's check **before** the chain
     (loop-play12 saw only this one): "The expedition's departure was refused by the check before sending (it never reached the chain): … (NotResident). The host is still in the village. …".
     Either way the host is home: read again with "Check departure conditions" and depart again. The refusal notice goes
     away once a later departure of that host is confirmed (#195).
   - **Looking at "Marches" keeps the road you drew** (#195): you can open the "Marches" list while the boundary card
     is open and come back to the same road. Closing the drawer, pressing the open tab again or pressing "Map" still clears
     the road (verify-pr195): then reopen the card from the host and draw it again.
   - The bar button says "No sending" (does not send), but in local play the card's last button really departs.
4. **A march inside the wide land (wide → wide)**: open the village of step 2; it has the card
   "Wide-land host (test)". Pressing "Next step (wide land)" goes one step at a time: train spearmen → muster a
   host → march on the next province's keep. **Press once per step, then wait** (three presses in all).
   - **A new wide village starts with empty stores.** Until it has saved the first step's cost (100 Spearmen: Food 60 ·
     Ore 20 · Gold 10; a village makes at least 4 ore an hour, more beside hills, mountains or iron, so at most about
     30 turns after it stands) the press is refused, and the toast and the card say what is short and when to press
     again (fix-loop16, LP16-2): "The wide-land village's stores do not cover training 100 Spearmen yet (Food 60 · Ore 20 ·
     Gold 10). A new village starts with empty stores, which fill by the hour (4 ore an hour without a Mine). Wait about
     30 turns, then press "Next step (wide land)" again." The 30 turns are a fixed estimate from an empty store (this
     village's screen shows the stores only as recorded when it was read); loop-play16 saw the refusal at turn 288 and
     the training at turn 296 for a village requested at turn 257.
   - Pressing the bottom bar's tabs ("Village", "Hosts", "Marches", "Nation & territory", "More", "Map") or the settings under "More" no longer makes the
     card forget its march (#173). A page reload still forgets it (§6).
   - The card's wait goes on when you close this wide village's screen and open the rim village or another tab (#184,
     fix-loop11 LP11-2; see the province-lag item below. verify-pr184: with W2 closed and "Marches", "Nation & territory" and "Village" open,
     it checked 2 → 28 times and sent the train by itself).
   - The village's header says "What this village's record shows is read-only. Orders are sent only by the Wide-land host (test) card below (train, form a host, march). Harvest, build, caravan and catch-up cannot be sent to this village." (the records are
     read-only; only the card below sends orders; #130).
   - The card states each step's reason in the page's language (#130; English on the English page):
     "Training N Spearmen at the wide-land village." (train) → "Forming a host of N Spearmen at the wide-land village." (muster) →
     "The host (N troops) marches on the keep of province P,Q (held by (nation)). It arrives on turn N." (march). Once the host is out it
     says "The host is out on a march.": nothing to do now. Right after the march is sent the card does not read again by itself;
     one more press of "Next step (wide land)" shows the result or where the march is and starts following it about once a turn
     (that press sends nothing; verify-pr184). After the card's first march, sent by itself, that press can show only the
     wait "This village's province is N turns behind. …" for a few minutes; the march's state comes with it later (loop-play12).
   - When the keep this village's host reaches was already being held by your own expedition (the march of step 3), the
     card does not say "took" (fix-loop10 LP10-2): "Result: the keep of province P,Q is now your nation's (seen at turn N). Your expedition reached it first and was already holding it. This village's host did not take it alone." (the keep is now
     your nation's; your expedition reached it first; this host did not take it alone). When the keep was already your
     nation's on arrival: "Result: the keep of province P,Q was already your nation's when this village's host arrived (seen at turn N). This host did not take it.". Either way the card goes on with "This village's host has reached that keep's tile. …".
   - A new village's province starts far behind the chain (loop-play4: 77 turns after the village was made;
     loop-play5: up to about 180 turns). **Do not keep pressing while the province is behind.** The card says
     "This village's province is N turns behind. … This page checks automatically about once a turn and sends the step when it can." and waits by itself (the button reads "Waiting… (no need to press)" and is disabled;
     "Stop waiting" stops it). The wait **goes on while another village (the rim village, say) is open**; back on the card
     you see what it last checked (fix-loop11 LP11-2). A page reload stops it. Other reasons it waits for: "The host is forming or resting." and the like. A step refused because the turn changed while it was being sent (NotResident; also when the
     chain refuses it after sending), or a march send that failed once, is sent again next turn by itself (a march the chain
     refused does not count toward the 2; fix-loop11) (verify-pr117: with "Next step" pressed every 2 s for 10
     minutes the page sent only 4 acts and got through train → muster → march; loop-play6: the card waited by itself
     through a 187-turn lag and sent about 3 minutes later).
   - The world's keeper opens the march's seal and catches the target province up even when it is far behind
     (verify-pr106: reveal, clash and settlement within minutes of the arrival). The bottom bar's "Marches" list does not show
     marches inside the wide land. Staying on a keep for 72 turns takes it. The same card follows the march (#130; it reads again about once a turn):
     "The host is marching on the keep of province P,Q. It arrives on turn N (now turn M)." → "Arrival turn N has passed. Waiting for the outcome at the destination (a few turns when the province is behind)." → "Result: the host (N troops) stands in province P,Q." plus
     the keep's state ("The keep is held by (nation) (your nation is not holding it).", "Your nation is holding the keep: n / 72 turns." or "The keep is your nation's."). A lost march says "Result: the host could not stay in province P,Q (it lost the fight).". When the beaten host comes home under 100 troops (a host under 100 cannot march, and a local
     page cannot dissolve it), the card adds "N surviving troops are back at the village. … a new host is raised. Next step: train 100 Spearmen (a host can be mustered once 100 are ready)." and "The next step can be sent (raising a new host). It is not sent automatically. …": press
     to train, press again to muster; the new host then marches as the first did (fix-loop9 LP9-1). When the host was **wiped out with nobody home** the card says "Result: the host could not stay in province P,Q (it lost the fight). The host was wiped out: no troops survived and none came back to the village. … a new host is raised. Next step: …";
     when it **took the keep and stayed as its garrison**, "The host that took the keep stays there as its garrison. … a new host is raised for the next keep. Next step: …" — both with the same "The next step can be sent (raising a new host). It is not sent automatically. …" offer. The first time, a
     press of your own also only shows the result and the offer; the next press sends (w2-wipeout). A village sends at most 2 marches inside the wide land in a test world. After
     the second is sent, the card says where that march is (on its way, being decided, standing beside a keep, …) followed by
     "A test world allows 2 marches inside the wide land from this village. No further march is planned (expeditions from a rim village still work).";
     once it has ended (beaten, wiped out, or the keep taken and the host its garrison), the last result and the same sentence
     (fix-loop11 LP11-4). While the village's province lags a few turns, the card shows
     "This village's province is N turns behind. …" instead (neither sends a third march). During a wait, the count in
     "is holding the keep: n / 72 turns" is the last one read while the province lags and cannot be read (verify-pr173: 52 / 72 from
     turn 429 to 448). (verify-pr130 saw "… marches on the keep …" → "Arrival turn N has passed. …" → "Result: the host (76 troops) stands in province -63,-66").
- **What you see**: the wide land is drawn on the ordinary map and on "World", outside its six corners, **as far as you
  have seen it** (fog). "Provinces held" and the standings also count rim and wide-land keeps (#102).
- **The AI residents** also take rim villages, save up, claim wide land and wage war (loop-play6: 4 wide villages, 70
  departures on keeps). Their battles are on other nations' rims, so the fog hides almost all of it; only an attack on
  your own nation's keep is announced. The AI's rim → wide expeditions land too (#130: 10 of 10 in verify-pr130), and so
  do their marches inside the wide land. They claim by the same reach rule as your
  card: the best target first, farther from their home, each resident along its own heading (outward, clockwise,
  counter-clockwise), through the nation's land when that reaches farther.
- **To watch an AI capture**, `--wide --speed 15` (a turn is 40 s) is the steady choice (the #102 check: standings kept
  up, and a capture reached them about 90 turns after the start). Since runner-throughput the standings keep up at ×60
  too (a few turns behind), but a war goes by fast there. A wide village's cost then takes about 2 hours to save.
- The faster the clock, the further this machine's load makes the world trail (§8). Stop other heavy work while you test.

### 4.0 An AI neighbour (`--ai-near`, TEST only; owner decision Q-LP16-2)

Without it, the nations that have no AI (Aster and Dunmar with `--ai 4`) start beside each other on the rim, so no other
nation's tile is ever within an expedition's road (32 steps, 4 provinces) and you never see tiles change hands.
`scripts/play-local.sh --wide --ai 4 --ai-near` (off by default; `--ai 1`–`4`) changes only where ONE AI resident
settles; no rule, price or reach changes:

1. The first AI resident joins no nation at the start. The "Choose a nation" screen says so under the banners
   ("Launch option --ai-near: once your first village stands, one AI resident joins the nearest other nation and puts its
   village near yours (that one is not in the "AI present" marks above).").
2. Once your first village stands, that resident joins the **other** nation whose rim village site is nearest to it
   and asks for that site: on the standard map, with you in Aster at (-68, -60), it joined Dunmar at (-65, -63), 3
   provinces away, 2 minutes after the join (×60). The AI residents' log (`operators.out` in the world's directory)
   says `"step":"near","outcome":"chosen"` with the distance.
3. It then claims wide land **toward you**: seen live, 24 tiles in (-68, -61), the province next to the player's
   village, within 100 turns (one tile a turn). Since the AI ore reserve (#236) it is slower: about one tile every 8
   turns (3 tiles in the first 40 turns, verify-pr237).
4. Send an expedition onto that province's keep (§4 step 3) and hold it 72 turns. When the keep becomes your nation's,
   the tiles the AI owned there become yours (§4.1 item 7): seen live at turn 264, all 24 tiles (read from the chain's territory
   record then). Since #234 the map shows it: the tiles are redrawn in your nation's colour (verify-pr234: 8 tiles of an
   Aster player, 5 of them out of sight until then, redrawn as the captor's in the turn of the capture).

The neighbour is at war like the other AI residents (`--ai-peaceful` turns that off): it marches on keeps near you too.

### 4.1 Neutral wide land and your own land (player territory; `--wide` only, #206 and #209)

Every `--wide` world plays these rules; a kept world and `--demo` have no wide land and no player land. The numbers are
the owner's decisions of 2026-11-24 (12:09, 13:15). Some readings are still open questions to the owner (VQ-1 … VQ-6);
this section describes what the program does today, and none of it is a promise that it stays so.

**The wide land starts neutral (#206).**

- At the start every wide keep (rings 129–131, 108 provinces) is unowned. The map leaves such a province's land uncoloured, and the
  plate at its keep reads "Keep: no nation" (only where you have seen it: fog, §5). A keep a nation took is drawn in that
  nation's colour, with "Keep: Aster" (your own: "Keep: your nation"). The land itself is coloured only tile by tile, where
  a player owns the tile (below).
- A neutral keep is guarded by 50 troops. Take it like any keep: put a host on the keep's tile and hold it for 72 turns
  (about 12 minutes at ×60, 48 minutes at `--speed 15`; 12 hours at 1×), by an expedition from the rim village (§4 step 3)
  or by the wide village's host (§4 step 4).
- **Your nation's land** in the wide land is every wide province where your nation has a village (yours, a nation-mate's or
  an AI resident's), or whose keep your nation has **taken**. A village claim or a tile claim may go up to 3 provinces
  from your first village, or up to 3 provinces from your nation's land. The card lists the second kind below the first,
  marked "from your nation's land (P', Q')", with the line "You can also found a village within 3 provinces of any province where your nation has a village or has taken the keep. The more land your nation holds, the farther you can go.".
  Only nation-mates' villages on the wide land count (ring 129 or more), not their rim or heartland villages (open
  question VQ-6).
- The world opens new wide land around the nations' villages and won keeps: at most 3 provinces a turn, out to ring 136
  (verify-pr206-209, ×60, `--ai 4`: 108 provinces at the start, 114 after about 150 turns, 137 after about 280).
  Design: docs/design/expansion/01-reach-from-land.md

**Your own land: follow these presses (#209).** You need a confirmed rim village (§4 step 1) with 10 ore in its stores.
A new village is "Provisional" at first: "Claim a tile" can still be pressed, and the press is then refused: the notice says
"That did not work" with "The village is not confirmed yet." (nothing is sent; on devnet the press first shows the cost and
"Sign and claim", and the refusal comes after you sign, PLAY-DEVNET.md). The program confirms the village on your own next
act there once its turn's villages are placed (in world3-local-replica one "Harvest" did it at once). Since #268 the village card, the guide and "While you
wait" say when it can be confirmed and offer "Harvest to confirm your village" once it can.
(In verify-pr206-209's world the rim village made 26 ore an hour; an hour is one minute at ×60. A village with
"No ore from the land" makes much less.)

1. Open your **rim village** ("Village" in the bottom bar) and scroll to the card "Found a village on the wide land (test)".
   The card is on the first village's screen only. Each row is one province: "Province P,Q", "Village site N", then two
   buttons, "Claim a tile" and "Found a village here". Above the rows the card says what you own (territory-card):
   "**Your land**: tiles owned: N · next tile: N ore · land upkeep: N food per hour" — your own land only, read about
   every 10 s in a local world (every 60 s on devnet) and right after a claim. The page reads it from the world's herald (`/h/world/wide/territory/player/<your
   Citizen>`, the chain's record as the herald recorded it), and asks the play relay only when that herald has no such
   route.
   Under that line the card also says how many tiles this food can support, and for how many turns: if the first
   village's food production covers the land, that the land is sustainable and how many more tiles at the current
   distance would still be; if not, both when unpaid upkeep starts and when tiles start being let go (24 turns after
   unpaid starts), in turns and in game time, with real time in parentheses on a faster clock. Food in a second village
   is not counted unless it is sent to the first (and on a `--wide` local world you cannot send a caravan). The numbers
   are the same settle the program uses. This game has no population, so the measure is tiles and turns — after
   Buckminster Fuller's World Game ("how many people, for how many forward days, we are now technically organized to
   cope with"). The same note sits in the food row of the resource HUD, and on the first village's food ledger when
   the village has no wide-land card. "?" opens the glossary term "Logistics horizon".
   The card lists at most 4 provinces near your first village and 6 reached through your nation's land, nearest first, so
   a province in reach can be missing and rows change as land opens. A province where you own a tile ("you own tiles
   here") or whose keep your host is taking ("your host is taking this keep") or has taken ("your host took this keep")
   always keeps its row (the tiles are those claimed in this visit of the page).
2. Press **"Claim a tile"** on a row. It can be pressed when the village holds the ore of the next tile (the "next tile"
   number of the land line; 10 for your first tiles), whatever the village cost line above says. With less, every
   "Claim a tile" is off and the card says why: "You have less than 10 ore, so "Claim a tile" cannot be pressed for now."
   or, from the fifth tile on, "You have less ore than the next tile costs (N), so "Claim a tile" cannot be pressed for now.". One tile of that province becomes yours **at once** (no wait for the end of the turn), and the notice
   says "One tile of wide-land province P,Q is now your land.". The ore leaves the village's stores ("Ore" on the same screen).
   - You do not choose the tile: the page takes the lowest-numbered tile of the province that is not a village site, not
     the keep's tile and not already yours (a province has 61 tiles, numbered 0–60).
   - **One tile a turn**, for all provinces together. Wait for the next turn (10 s at ×60) and press again.
3. Press it again each turn to grow. **What a tile costs**: 10 ore, plus 2 % of that for every tile you already own,
   rounded down to whole ore (the rounding is the owner's open question VQ-2):

   | Tiles you own | 0–4 | 5–9 | 10–14 | 15–19 | 20–24 | 50 | 100 |
   |---|---|---|---|---|---|---|---|
   | Ore for the next tile | 10 | 11 | 12 | 13 | 14 | 20 | 30 |

4. **A village on your land.** A village stands only on a tile you own, so "Found a village here" takes two presses
   (§4 step 2): the first claims that site's tile (it counts as this turn's one claim and costs ore like any tile), the
   second files the village for the usual cost (second village: Food 800 · Wood 800 · Stone 400 · Gold 200).
   - Two villages of one province need at least one free village site between them (the program counts a village on a
     site within 3 tiles as too near), and you hold 3 villages at most (the rim village and two more; then the card says
     "You already have 3 villages." and its rows keep "Claim a tile" only).
   - A province where a wide village of yours stands stays on the card as its own row, "Province P,Q your village stands here",
     with "Claim a tile" only (no second village there): the land around your own village can be claimed from the page
     (loop-play15, #223; before, that row and its button were gone). Local worlds only: the devnet page leaves this row
     out today, so there the province of your wide village has no row at all (PLAY-DEVNET.md §5).
5. **Upkeep.** Your land costs food, taken from your **first village's** stores by the world's keeper, about once a turn:
   - 0.99 food an hour for each tile;
   - plus 0.48 food an hour for each province a tile lies beyond 3 from your nearest own village (the first village or
     a wide village of yours). It is measured once, when you claim the tile, and does not change later.
   - Examples: 10 tiles near home cost 9.9 food an hour; 100 tiles 99; one tile 5 provinces from your nearest village
     costs 0.99 + 2 × 0.48 = 1.95. A starting village makes about 40 food an hour, so 41 tiles near home cost more than
     it makes (claiming them takes 558 ore in all), and sooner if you spend your food on troops and buildings (owner
     decision Q-CUF-1 (b), 11-25 12:04: thirty times the first numbers; with those the land went unpaid only past about
     1,200 tiles, and with the ×10 of Q-LP15-1 (b) past about 120).
   - The first village's food rate is shown after land upkeep, with the land's part beside it: with 73 tiles near home
     and a village that makes 40, the top bar and the village screen's "Per hour" column read "−32.27/h (land −72.27)"
     (the top bar shows rates on a window at least 1,600 px wide; its hover text and the resource list always do:
     "Food 11 / 2,000 · −32.27 per hour (village +40 · land −72.27) · Empty in 20:28" — a falling store says when it is
     empty at that rate, as a rising one says "Full in …"). The amount in store is the record's, as before. Once the
     rate is 0 or below, the card adds under the land line: "Your food no longer grows (−5.54/h): the food your first
     village makes each turn cannot pay for another tile." "Claim a tile" stays open (the rule still takes the claim
     while the store pays).
6. **When the food cannot pay.** The food in your first village is taken (all of it, never more than the upkeep owed),
   and your land counts as unpaid from that turn (owner decision Q-LP17-1 (b), 11-25 21:22;
   before it nothing was taken, so the next turn's food paid a whole turn and the land never stayed unpaid):
   - at once: you cannot claim tiles (the refusal is in the table below);
   - after 24 unpaid turns (**4 minutes at ×60**, 16 minutes at `--speed 15`; **4 hours at 1×**): your **farthest** tile
     goes back to unowned, **one tile each turn** (one every 10 s at ×60; one every 10 minutes at 1×), for as long as it
     stays unpaid. A tile under one of your villages can be let go too (open question VQ-4);
   - it ends when the first village's stores again hold at least one turn's land upkeep at the keeper's next visit.
     Each short turn takes the stores, so in practice it ends when the village makes at least as much food a turn as the
     land costs a turn (fewer tiles, or more food). The food missed meanwhile is not charged later (open question VQ-5).
   - **The card warns you** (territory-card), under the land line, for as long as the chain's record says unpaid:
     "Your land upkeep (food from your first village) is unpaid. No new tile can be claimed. If it stays unpaid for N more turns, your farthest tiles are let go, one per turn."
     (N counts down from 24), and after that "Your land upkeep (food from your first village) is unpaid. Your farthest tiles are being let go, one per turn. It stops once your first village makes enough food for your land each turn.".
     While it shows, every "Claim a tile" is off (owner decision 11-26 10:52) with the line "Land upkeep is unpaid, so "Claim a tile" cannot be pressed for now."
     (The devnet page does not have this yet: there the button can still be pressed and the page stops before signing, PLAY-DEVNET.md §5.)
     The card follows the chain's record (read every 10 s in a local world, once a minute on devnet), so the button can stay off for that long after
     the food is back (a claim settles upkeep first, so the rule would already take it then: owner question Q-TC-1, now decided this way).
     The program charges no food for troops (the rule that large hosts eat food is in the simulator only; loop-play15,
     owner question Q-LP15-1), so a village's food falls only by what you spend: with no other spending it takes about
     41 tiles near home (one claim a turn: 41 turns or more) before land upkeep passes a starting village's 40 food an
     hour.
   - **How it goes** (the program's own test of loop-play17's case: 73 tiles near home, a village that makes 40 food
     an hour, 510 food in its stores). The land costs 72.27 food an hour, so the stores fall and are empty after 94
     turns. From turn 95 the land is unpaid, every turn: each turn's new food is taken and is not enough. From turn 119
     (24 turns later) one tile goes back each turn, 33 in all. At 40 tiles (39.6 food an hour) the village pays a whole
     turn again, and it stops. Before Q-LP17-1 (b) the same land flipped between unpaid and paid every other turn and
     lost no tile.
   - Seen live: the warning and the refusal on a real page in loop-play17 (EN and JA, under the rule before (b));
     the whole course under (b) — unpaid at every turn, the release after 24 turns, the card and the map with the
     tiles gone — in #243's P18 run on a local chain. Since then seen in live worlds too (verify-pr243, loop-play18: the release one tile a turn on a real page).
7. **Losing and winning land by a keep.** When a nation takes a wide province's keep, the tiles that players of **other**
   nations own in that province go to the owner of the army that took it. Tiles of that army owner's nation-mates stay,
   and so does a tile with a village on it. The keeper moves them (verify-pr234: in the turn of the capture). Since #233 this also works when the same player's
   army takes a second keep (before, the program refused that move every time). No notice tells you; the map redraws the
   tiles in their new owner's colour.
   While the nation still holds the keep, tiles claimed there later by other nations' players move the same way (open
   question VQ-3).

**When a press is refused.** A refused tile claim is answered in the claim's own words for the first three rows (#223;
read on a live page, JA and EN: the first and third in verify-pr223, the unpaid one in loop-play17). The first two
carry no "Try again" button (fix-loop17): in the same turn that press could only be refused again, so use the card's
"Claim a tile" in the next turn, or once the land is paid. The other rows
are the program's general sentence for that error, which does not always fit (from the code):

| What happened | The notice says | What to do |
|---|---|---|
| A second tile claim in the same turn | "You already claimed a tile this turn. It is one tile a turn: press again next turn." | wait for the next turn |
| Land upkeep unpaid | "Your land upkeep (food from your first village) is unpaid, so you cannot claim a new tile. Once your first village has food again you can. After 24 unpaid turns your farthest tiles are let go, one a turn." | get the first village to hold a whole turn's land upkeep when the keeper next looks (more food an hour, or fewer tiles: step 6), then claim again |
| Not enough ore (rare now: the button is off below the next tile's price) | "Not enough ore. A tile costs 10 ore, plus 2 % for each tile you own (paid from your first village's stores)." | wait for ore |
| Another player owns that tile | "That site is taken." | press again: the page tries the next tile |
| The tile is yours already (the page had lost track of it) | "Already done." | press again: the page remembers it and goes on |
| The province is out of reach | "Outpost requirements are not met. Check your town and province control." | pick a nearer row |
| No free tile left in the province | the row's "Claim a tile" is off with "No tile is left to claim in this province." beside it once the page knows (your own tiles always; other players' tiles only in sight). Pressed before the page knew: the same words as a notice, with no "Try again" | another province |
| The province could not be read | "No tile can be claimed in this province (a world without player land, or the province could not be read)." | press again |
| A village too near another village of the province (second press of "Found a village here") | "That site is reserved (rings 0 and 1)." | press again: the page names the next site; its tile has to be claimed first |

**Where your tiles are.** The map draws player land tile by tile, in the colour of the owner's nation (#234): your own
tiles always, other players' tiles while they are in your sight, and out of sight as you last saw them, faded (#240).
Village sites and the keep's tile stay open. The card's land line
gives the count, the next price and the upkeep. The card's own
paragraph ("Your land: "Claim a tile" makes one tile of that province yours at once (10 ore, +2 % per tile you own, one tile a turn). …")
states the rules in short. The card's last line, "A request is decided at the end of the turn (by lot if someone else chose the same place).",
is about villages; a tile claim is instant.

**The AI residents** claim tiles too (the same rules and prices): the tile under each village they found, and one more
from time to time while they save for the next village. They **keep ore back for their troops** first (ai-ore-reserve,
owner 2026-11-25): a tile is claimed only when the ore pays it and still leaves one training batch (100 Spearmen: 20
ore), plus the troops their next host still lacks; while a keep of their own nation near them is under attack they
claim no tile at all; and once they have a host's worth of troops (300), tiles and training take turns. They also no
longer ask for a training their stores cannot pay. Measured at ×60, `--ai 4`, about 39 minutes after the player's
village stood, against the same world without the change (verify-pr236, land upkeep ×30): training refused 0 (before
274), 54 trainings landed (24), 17 marches on keeps (1), 6 rim keeps taken (0), 30 tiles claimed (79), 4 wide villages
(4); after an hour 1 wide-land keep was taken too (0), and no AI resident's upkeep was unpaid in either world. So with that change alone the AI nations owned less land and fought more (the saving below gives them more land again). Under the fog you see their tiles only where you have sight (§5). Each AI resident also **builds one mine first** (ai-early-mine, owner 2026-11-25 17:58): its village's first command is the
same Build a player has (food 40, wood 80, stone 20; +6 ore an hour), once; not while a keep of its nation near it is
under attack. And **until its first wide-land village is built it saves for it** (owner 2026-11-25 20:03 and 22:28): it
keeps no more than one host (300 troops — at home, in its hosts and on the march; it trains again only to replace troops it
lost), and it claims no new tile but the one that village will stand on, so its food and gold go to the village. Once the
village is claimed it trains and grows its land freely. Measured (verify-pr241; ×60, `--ai 4`, same map, with and without
these changes; in brackets the world without them): the four AI wide villages stood at turns 309, 309, 309, 312 (313, 313,
337, 395), about 26 minutes after the player's village; 38.5 minutes after it, ore an hour of the four AI villages 46 in all
(22), 52 trainings landed (50), 72 tiles claimed (19); at 66 minutes 85 trainings (73), 95 tiles (28), 12 keeps changed
hands (10), 4 wide-land keeps taken (1). No AI resident's upkeep was unpaid in either world. With the mine alone and no
saving the AI residents founded no wide village in that time. An external resident run with workstream ⑬'s
client (§11) claims tiles too: its next village's site first, then growth at its own slower pace.
Neither kind of AI takes **land it cannot feed** (owner 2026-11-26 10:52, Q-LP19-1 (a); no rule change): a village site
reached through its nation's land (a nation-mate's village far away) is skipped when that site's tile would cost more upkeep
an hour than its village's food surplus — the distance part counts from its nearest own village, so a site on the far side
of the world is skipped. Before (loop-play19, verify of this change on the same map): the Borealis AI took a tile 259
provinces from its village, its land cost 122.94 food an hour against 40 made, it was unpaid for 24 turns and lost the tile;
with the change it skipped that site and had 15 tiles, paid, at the same turn. A tile let go for unpaid upkeep also leaves
the AI's own count of its tiles (its 24-tile limit and its next site choice).

**An idle first village is not taken away** in a `--wide` world: the rule that frees a long-idle village needs 7 game
days without an order, longer than the test world takes orders (§4).
Design: docs/design/expansion/02-player-territory.md

## 5. Fog of war (every local test world, #93)

A player's view, as in Civ. It is display only: the local chain's records stay public. The devnet page shows the same
view (fog-devnet; runbook §7 P5).

| | What you see |
|---|---|
| In sight now | around your villages and hosts, around your nation's villages and the provinces your nation holds. Allies do not share sight |
| Seen before | stays as last seen, dimmed (villages, keeps and their holders). Kept in this browser |
| Never seen | blank on the map and on "World": no terrain, village, keep or nation colour |
| Players' land (`--wide`, #234, #240) | your own tiles: always drawn. Another player's tile: drawn while that tile is in sight now; once out of sight it stays as you last saw it, faded; a tile you never saw is not drawn. While such land is in the picture a small key, "Who holds the land", names the colours ("Your nation (Aster)", the other nations by name, "A player's land (nation not known)"), with "Faded: the owner when last seen (out of sight now)" while a faded tile is in the picture, and "Keep colour: the nation holding the province" while a nation's keep is (that line also shows alone, with no tile in the picture) |
| Other nations' hosts, marches, clashes, contests | only where you see now; no afterimage |
| An enemy marching on your village | announced ("Attack") when it leaves from a place in sight, or from 3 turns before arrival |

- The keep list, the inspector, the chronicle, the notices and the minimap follow the same rule.
- **Other nations' clash reports and "Replay the clash"** are offered only while the province's keep tile (the whole
  province when it has no keep) is in sight now; a few rim tiles in sight are not enough. Your village's province and
  the clashes your own marches arrived at are always yours to see. Opening a report out of sight says
  "This place is out of sight now. …" and reads nothing. The map's clash marks (the red ring, the minimap dot,
  "A clash this turn"), the chronicle's clash lines and "Recent clashes", and other nations' keep contests and captures
  follow the same rule (keep news your own nation is in is always shown). Other nations' map moments ("New village of …",
  a host setting out, an arrival, a camp gone) play only where their tile is in sight now, and the march card's
  "Nearby destinations" lists camps only on tiles you have surveyed.
- **"Send a caravan" destinations** (owner decision Q-LP17-4, 11-25 21:22): the list holds your own places, your
  nation's villages and storehouses, and other villages and storehouses that are in sight now — nothing seen before or
  never seen (it used to name every village of every province the page had read, with province and tile). The form says
  so. A place that goes out of sight leaves the list; if that happens between drawing the form and pressing "Send a
  caravan", nothing is sent ("The destination list has changed … Choose the destination again."; the notice has no
  "Try again": choose in the field and press "Send a caravan"). The village the caravan leaves from is not listed when
  it is the form's only start; with nothing of your own to send to, the field starts on "(choose a destination)" —
  another player's place is never chosen for you. "① Request
  destination" (§13) stays listed whatever is in sight: the requester published that place on the board.
  - **Caravans are sent only in a `--coexist` world** (owner decision Q-LP18-1 (a), 11-26 10:52): every other local world,
    `--wide` included, refuses every caravan. There the form says so above its fields, "Caravans cannot be sent in this
    world. The lists below are for reading only.", and "Send a caravan" is off (the line is the button's description for
    screen readers). The lists stay readable.
- In a fog world the map's "Records" view (every recorded province) and the links to the spectator page (the legend's and
  the settings' "Spectator page") are **not shown**, from the first picture on (fog-devnet).
- One switch per mode in `permutation-server/web/frontier/map/fog.mjs`: `LOCAL_FOG` (local test worlds) and
  `DEVNET_FOG` (fog-devnet: the play page of a world whose pinned cluster is `devnet`); `false` = no fog in that mode.
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

   The same address opens; press "Start the world (a kept world resumes)" and you are back in your village.
   If you stopped with a march out, the page no longer knows its sealed destination (it is revealed on the arrival turn):
   the guide at the top right says "Guide 5/8 See the marches" (before the march-first order: "Guide 4/7"; with nothing built yet it says "Guide 4/8 Open the build list" first) and "Your host is out on a march. Its destination stays sealed until its arrival turn, N. …" (fix-loop12), or, when the page sees no host of yours in any province, "There is no host at the village now. …" with "See the march's result".
- `--demo` and `--wide` worlds are not kept. Close the browser tab after a stop. **Do not reload the page** while
  playing them (the test key lives in memory only; you could not get back into that world).
- After a `git pull` that changes the program, the old world cannot continue. The script says so; start again with `--fresh`.
- `--resume` opens only the kept world started last. To go back to an older one, write its folder
  (`…/.local/play-local/kept/<date-time>`) into `.local/play-local/last-kept`.
- **A paused kept world (#218).** A world's processes stop after 90 minutes by default (`--minutes`). A kept world is
  then **paused, not ended**: the dial reads "Turn N · paused" and the banner says
  "This world is paused. Your progress is saved. While it is paused its turns do not advance and no order can be sent, but play continues from where it stopped. To continue, open the start page again and press "Start the world" (if the start service was stopped, first run scripts/play-local.sh --resume in a terminal).".
  So there are two ways on:
  1. the script is still running in its terminal: open `http://localhost:41920/` again and press "Start the world (a kept world resumes)";
  2. the script was stopped (Ctrl-C, or the terminal closed): run `scripts/play-local.sh --resume`, then press the same button.

  Either way you are back in your village at the turn where it stopped (verify-pr218 did both, in English and Japanese).
  The same holds when you stop a kept world yourself in the start page's list: "Stop this world…" → "Stop it" →
  "The world was stopped. Its progress is saved: pressing "Start the world" in the same browser resumes it from where it stopped.".
  (A `--demo` or `--wide` world that stops says "This test world has ended (a test world that is not saved, with a time limit and other limits). …":
  it cannot be resumed.) A world with many AI residents can stop before `--minutes`, when its logs reach the launcher's
  size limit (loop-play14: a `--demo --ai 4` world at about 71 minutes); a kept world is paused then in the same way.
  `--resume` does not remember `--minutes`: for a long session pass it again, e.g. `--resume --minutes 240`.
- **What ends, and what does not.** The game has no seasons and its world does not end. A kept world follows that: it has
  no last turn, and only its processes stop (`--minutes`), to be continued with `--resume`. `--demo` and `--wide` worlds are
  throw-away TEST worlds: besides `--minutes`, their program takes new orders only up to a fixed turn, which the join card
  names ("This test world takes new orders until turn N (about … left; a limit of test worlds)."; 1,008 in a `--wide` world).
  After that, start a new world.
- To delete the test key, press "Delete the test key kept in this browser" in the page's panel. A world's folder stays until
  you delete it.

## 7. Local only, and the same as devnet

| | Local (this script) | The devnet playable version (on devnet since 2026-11-23; how to play: [PLAY-DEVNET.md](PLAY-DEVNET.md)) |
|---|---|---|
| Program | a local-only `.so` (program id `[0x45; 32]`, never deployable) | the devnet `.so` (another build; the local features are not in it) |
| Centre | **none** (the world's own rule byte `centre` = 1) | the presets keep the centre (the `CENTRE_PLAYABLE` switch is r0ze's) |
| Village that may claim wide land | from a Hamlet (`--wide` only: `outpost_tier_min` = 0) | also from a Hamlet: the devnet world's preset `S1_DEVNET_TERRITORY` is built on the wide preset `S1_DEVNET_WIDE_7D` (0 since #104); `S1_LOCAL_7D` from a Town (1) |
| First village on the rim, wide villages | test participants settle first in the setup; the keeper settles the claim | done in #104 (the keeper's rings role opens the rim provinces, its tickets role settles the request); keeper A's `wide-tickets` role settles wide claims (#107). After the Join, the devnet page waits up to 180 s for your own record to appear before it files the rim village (#172; past that, "Check again"; checked offline) |
| Expedition rim → wide land | works (the 0x4804 expedition, #92) | the same instructions are in it; the departure is sent from the same card of the devnet page, paid by the connected wallet ("Review what will be sent" → "Sign with the wallet and send"; #129, runbook §7 P15). Keeper A's `expeditions` role sends every step after the departure (#121) and its `wide-resolve` role keeps the wide provinces resolved turn by turn (#129). All checked offline |
| Neutral wide land, reach from the nation's land, land opening where nations go (#206) | every `--wide` world (§4.1) | in the devnet world created on 2026-11-26: every wide keep starts unowned (preset `S1_DEVNET_TERRITORY`, keep holder `NeutralTerritoryV1`, `scripts/devnet/devnet-new-world-profile.json`), and the program on devnet has #206 (updated 2026-11-25 and 2026-11-26). Played end to end on a local chain with that world's own build (world3-local-replica, 2026-11-26) |
| Your own land: tile claims, upkeep, decay, tiles moving with a keep (#209) | every `--wide` world (§4.1); the launcher's keeper loop settles upkeep, decay and the moves | in the devnet world created on 2026-11-26, with the unpaid-upkeep rule of #243 (§4.1 step 6): the devnet page has the tile claim (with a cost preview in ore and SOL before you sign) and keeper A settles upkeep, decay and the moves (#221). The row "your village stands here" (§4.1 step 4) is not on the devnet page. Played on a local chain with that world's own build (world3-local-replica, 2026-11-26) |
| March wide → wide, capture of a wide keep | works (the local-only feature `localnet-wide-depart`, #94) | **closed** (WideDepart) |
| Clock | can run ×10–×60 (a TEST clock) | the natural speed only |
| Opening a march's seal, clash, settlement, keep capture | the keeper loop inside the launcher (TEST machinery; the keeper program is not run) | keeper A's roles (#118, #122). A held keep is resolved every turn and taken after exactly 72 (#120; #160 ran a capture by a 72-turn hold and a march there and back offline on the devnet `.so`; 12 hours of real time) |
| AI residents | yes (at war by default) | none (local only; runbook §7 P4) |
| ② rights (Vault) | `--coexist` worlds only (§10) | not in it |
| ⑨ workshop lending, ⑩ ore custody, storehouse seizure, stopping a caravan to take or burn it | `--coexist` worlds only (preview card, §12) | not in it |
| External AI residents (⑬ / ⑤B), the read-only MCP server, `--plan` (④) | `--external` worlds only (§11) | none (admission of external residents and the MCP server are undecided) |
| ① co-op board, ⑮ title "Answered a request" | board and card in every world (`--no-coop-board` leaves them out); a caravan can deliver only in `--coexist` worlds (§13). No effect on winning, score or prize | none |
| Guide and helpers of the page: "march first" guide (8 steps, §3 step 5a), "While you wait" panel (§3 step 7), "Claim a tile" off while upkeep is unpaid (§4.1 step 6), notifications outside the page and the calendar file (§15) (#261, #257, #262) | every world | **not on the devnet page today**: its page files are main of 2026-11-26 10:58 (#252), with the 7-step guide ("Guide 1/7"). They come only with a page update, which is not decided yet (PLAY-DEVNET.md §5 step 4) |
| World goals (flag keeps) | judged off chain by the launcher in every world; card and pennants; the prize is an estimate, nothing is paid (§14) | **no card on the devnet page today**, and no judge runs. Main has a devnet card ("Planned — not judged yet"; Free Cities cannot be taken yet there) and an off-chain judge (#260); neither is live: the page update and the judge's start are not decided (PLAY-DEVNET.md §5). The prize program has a goals pool since #202 (feature `goals`, test USDC only); neither `play-local.sh` nor the devnet page uses it |
| Fog | yes (display only) | yes, the same player view on the devnet page (fog-devnet, `DEVNET_FOG`) |

Heartland protection of keeps, the 72-turn capture, the clash computation and the costs of villages, building and
training are the same rules as devnet.
A local world costs no SOL and no rent (the test keys are funded with test balances). Devnet costs and rent (since #147 and
#150 they follow the cluster's own rent rate) are in the devnet runbook (`docs/frontier/devnet/`, refreshed by #177 and #182; what a player pays: [PLAY-DEVNET.md](PLAY-DEVNET.md) §4),
not in this guide. #179 (the verifier reads declared patches), #180 (the operator's tool `frontier-operator end-season`)
and #181 (the read-only deploy-day preflight `scripts/devnet/preflight.mjs`) are devnet and verifier changes too: nothing
changes in a `play-local.sh` world (the script uses none of these tools; a local test world stops at its time limit or on Ctrl-C).

## 8. Known problems (2026-11-26, main through #244 and #243)

### 8.1 Still on main (after #244)

Everything loop-play6 … 12 found (LP6 … LP12) is fixed on main, with these exceptions, all in the table and notes below:
the cause of one Ctrl-C that did not stop a world (LP6-3), the lag under load (LP8-4), the late "W2" button seen once
(LP12-6, not reproduced) and the road cleared when the drawer closes (LP12-5, half fixed). loop-play13 played the English
page end to end (kept world, ②⑨⑩, ① → ⑮, `--wide` with both captures, an external resident) and found LP13-1 … 12:
LP13-5 and LP13-6 (English wording) are fixed by #207 and the others by #208 (verify-pr208 played them in English and
Japanese), except what is listed below: the march card's cut line (part of LP13-12) and siege lines other than your own
nation's (part of LP13-3). None is a rules question. loop-play14's LP14-1 … 15 are fixed by #216, #217 and #218
(verify-pr217 and verify-pr218 played them). New with player land (#209): one row of the table (the unconfirmed village; fixed since: by #234 and #240 the map, which drew no player tiles; by #223 the refusal sentences and the tile rows that went missing with a village of your own in the province or with 3 villages; by territory-card the missing tile count, next price, upkeep and "unpaid" warning, and the "Claim a tile" button that opened at 10 ore whatever the price).

| Where | What happens on main | Workaround now |
|---|---|---|
| Your own land (`--wide`) | a tile claim on a village that was only just placed is refused "The village is not confirmed yet." until the village has done one thing (the chain confirms it lazily; territory-card saw it live) | press "Harvest" once, then claim |
| March order card | a march held as "not confirmed yet" can no longer be asked about once the page's own 2-minute re-check is over: "Try again" does not ask, and the guide stays on its hold step ("5/7" before the march-first order, now "6/8"; verify-pr200; rare) | none while playing (a reload loses a `--demo` / `--wide` world) |
| Boundary card | closing the drawer, pressing the open tab again or "Map" clears the road you drew (verify-pr195; opening "Marches" keeps it) | draw the road again |
| Boundary card (×60) | "Check departure conditions" is refused NotResident once or twice (the province is still settling) | wait 1–2 s and press again (it only reads) |
| ⑩ stopping a caravan (×60) | from the moment "Stop the caravan" is offered you have in practice about 2 turns (about 20 s) to stop and decide (the limit is 6 turns from the turn the caravan stood; the province settles 2–4 turns late; verify-pr145) | try it with `--speed 15` (§12) |
| ⑩ seizing a storehouse | "Seize the Storehouse" can be pressed while the owner's host stands on the tile; the program refuses it (NotOnTile, as the rules say) | press it when no host of the owner is there |
| ① co-op board | after a partial delivery the board says "Did not reach the amount asked (everything finished; proven by the upper bound)". The request stays "Open" and turns to "Reached the amount asked" once the rest is delivered (verify-pr152) | deliver the rest and link it (§13) |
| The external residents' MCP | the MCP server reads the first world only (a second world of the same launcher has no MCP reads; verify-pr142) | test with one world |
| Boundary card | after a departure the card can stay on "Sent. Not confirmed yet." (2 of 5 in verify-pr130); until then the next host's "Depart" is not shown. Since fix-loop11 the page checks the result itself on each read and the line turns into confirmed or refused. The card also stays bound to the departed host ("Reopen this card") | wait, or press "Check the result" once; reopen the card for the next host |
| Stopping | the cause of the one Ctrl-C that did not end a world hours past its time (LP6-3) is still unknown. #130 added the 20 s bound and the second Ctrl-C; in verify-pr130 all four cases ended in 0.1–2.4 s | press Ctrl-C again (§6 item 1) |
| Wide village (W2) | the card says "This village's province is N turns behind." twice in a row | none (display only) |
| Wide village (W2) | the notice after a "Next step (wide land)" step is sent is an English sentence on the Japanese page too (e.g. “train 100 Spearmen at the wide village -66,-63 …”; verify-pr162) | none (display only; the reason on the card itself is in the page's language) |
| ② rights caravans | in the caravan form, switching the source from the storehouse to the village leaves that same village as the destination | choose the destination again |
| ② rights | opening "Issue a right" before the workshop is finished (about 9 turns) says "To issue a right you need a village with a workshop." | wait for the workshop (§10 step 2) |

Small ones (nothing blocks play):
- The open "About this test world" box lies over the top of the map; "Hide details" folds it, and with a village standing
  it folds by itself to one line at the left under the "Provinces held" strip (#205; it no longer sits behind the hand bar, LP13-7).
- For the first seconds of the ×60 nation picker the clock rate is not known yet: the intro says "10 minutes of game time" and
  the remaining time is not shown.
- A siege line near the top edge of the map can still be cut or sit under the turn dial when it is not about your own nation's keep (your own "Holding the keep · n / 72 turns", or one between two other nations). The line "(nation) is holding your nation's keep · n / 72 turns" is whole since #208 (LP13-3).
- English label cut short: the march card's "Price · Stamina −74 · Estimate …" line (LP13-12; the keep row and the guide pill are whole since #208).
- Selecting a never-seen province says "Unsurveyed … Only the terrain is charted." but the map draws it blank.
- After a wide village (W2) takes a keep, until that march's record is closed the card waits with "The host that took the keep stays there to defend it. … (it does not send it automatically)";
  then it says "The host that took the keep stays there as its garrison. …" with the new host's step and "The next step can be sent (raising a new host). It is not sent automatically. Press to send the step above." (w2-wipeout). The "Result: you took the keep of province …" line stays after the next training is sent (#149, LP8-5).
- The N in the expedition card's "Stays: the host stands in the wide-land province (N troops)" stays at the arrival strength (verify-pr175:
  188 on the card, 171 in the chain's host). After a capture, "(keep garrison N, as recorded at turn T)" is the chain's number (#175; §4 step 3).
- The card writes "Keep taken: the host became the keep's garrison", but of a host of 200 or more only half becomes the garrison (§4 step 3).
- In a `--wide` world the guide at the top right does not count wide-land keep captures (it looks at keeps up to ring 128).
  After a W2 village or an expedition takes a keep the guide stays on its earlier step (w2-wipeout: still "Guide 1/7 Open the build list"
  after the capture; with the march-first order the earlier step is "Train troops" or the camp step: not re-checked live).
- The short address in the ⑨ and ⑩ choices ("4dkm…7rAz" and the like) is the owner's resident record (Citizen), not the
  owner's wallet. The page shows neither of your own addresses anywhere, so tell the options apart by village name and tile
  (loop-play11 LP11-5; §12).
- The W2 card's memory (march count and result) is one per page. With two wide villages the second would show the first's
  card (verify-pr173; a third village can be founded since #206, so this can happen; not re-checked since).
- Under heavy load (load average 12–31) a wide village's province can stay 200+ turns behind for tens of minutes
  (loop-play8 LP8-4; a load matter, only measured in #149).

### 8.2 How ×60 behaves (after #102, #105, #109, #117, #120)

- **Contested provinces trail the chain under load.** At ×60 every province is normally two to four turns behind the
  turn bar (the runner-throughput check, `--wide --random-map --ai 4`); before that change, and on a heavily loaded Mac,
  10–24 turns (the #102 check). Meanwhile a muster or a departure waits; the page says "This province's turns are N behind: this machine is under heavy load …" and sends it once when the province has caught up. No need to press again.
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
  most 3–4). The keeper loop now settles your home again before every AI village's
  turn, so a muster or march is usually sent on the first press, within a few seconds (the check: muster 1.8–5 s, marches
  2–14 s; the author's sessions withdrew none, the verify-pr109 session withdrew 2 of 12 marches, pressed while the home
  was 3 turns behind, and each went on the next press; one muster press in the turn's last second was refused and the
  next press, 3 s later, went through). If one is still withdrawn ("The waiting send is cancelled …"),
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
  While it is not ready, the page's "Form a host" waits and sends once, as before.
- **A wide-land expedition whose reveal window was missed never settles** (the program has no settlement for it; that
  waits on r0ze). The march screen stays on "Arrived. Waiting for the seal to be opened", and that rim village cannot
  send another expedition ("Could not depart (DepartRolesUnavailable)."). It happened once, before #105
  (verify-pr106, a loaded Mac at ×60; `runner.out`: `never revealed: transit 0: the reveal window of bell 262 closed
  unrevealed`). In fix-loop5, verify-pr117 and loop-play6 the keeper opened every seal in time (0 `reveal-missed`).
  If in doubt, press "Open the seal (local play)" yourself on the arrival turn (§4 step 3).
- **A sieged province keeps up with the chain** at ×60 (the runner-throughput check: every province 5.9–6 turns a
  minute against the chain's 6). The keeper loop resolves the other provinces' and the sieges' turns in
  same-block batches. The standings' "Province-hour reference record through turn N." is the slowest province's turn: a few turns behind
  the turn bar (before: up to hundreds, e.g. turn 251 at turn 495).
- **A rim village that stays "Provisional village"** is confirmed by one action of your own (e.g. "Harvest") after the time
  the screen states, not at that time by itself (the screen says so since #268).
- **The AI residents spend many turns on refused sends** (e.g. training the stores cannot pay). They look slow; it is
  by the rules. An AI no longer stops after 256 sends (#117; loop-play6: about 3,000 sends, none refused by the relay).
- **Pressing too often can no longer lock a world out (#117).** The launcher's relay remembers at most 256 commands per
  world that have **not settled yet**; a sent command stops counting once its transaction's validity (about 1 minute on
  the local chain, a little longer under load) has passed. A full limit says "Too many orders you just sent are not resolved yet. This one was not sent. Wait about a minute and press again." and clears within about a minute. The march relay
  (limit 64) works the same way. Before #117 every command ever sent counted, so after 256 sends that world could never
  send again, with the false text "You have used up the actions you can send today. …" (loop-play5). Even so, **do not press again
  where the page says it is waiting**: a waiting muster or march and "Next step (wide land)" wait by themselves and send
  once. Pressing again is needed only for the boundary card's "Check departure conditions" (a read) and after
  "The waiting send is cancelled …".
- **A keep is taken after exactly 72 held turns** (the #120 check: all 11 AI captures at ×60 in
  `--wide --random-map --ai 4` came after 72 held turns; provinces ran 5.99 turns a minute).
- **An expedition's result**: once its seal is open, the map tag changes to "Arrived · the seal is open · waiting for the result". The result ("Stays: …" and so on) shows once the target province has caught up.
- A wide claim offers free sites only; in a `--wide` world the site's tile must be yours first (two presses, §4.1). A third village costs food 1,200, wood 1,200, stone 600, gold 300 (the program's
  price, which the card shows since #183).
- The expedition card draws roads without looking at terrain ("Check terrain and time" then says "A host cannot march onto mountains or water (N)").
- The "Records" view is not shown in a fog world (it is with `LOCAL_FOG` set to `false`).

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
  "Start a new world" for a new world (the earlier world runs on until its time is up; at most two run at once, so end the
  earlier one in the start screen's list with "End this world…"; `--two` cannot start until the earlier world is ended. A kept
  world goes on after a reload). #170's static cache in the herald is not used by
  local worlds (the launcher serves the page; a world's herald runs without `--web`). Where a herald does serve the page (the
  devnet set-up), an edited file is read again on its next request once its size or times change, so no restart there either.
  A restart is needed after changing the launcher's or relay's code (`permutation-gateway/src/`) or Rust code (Ctrl-C, then
  `scripts/play-local.sh` again, with `--resume` to continue a kept world: it rebuilds only what changed).
- "ports in use": choose another `--port` (e.g. `--port 41450`), or stop the earlier world.
- Report through a GitHub Issue (r0ze998/wylls), with a screenshot and the folder above.

## 10. Play ② rights (Vault) (`--coexist`, TEST-only)

This is owner decision ② A (the stock swap became the facility Vault; the page's card is "Rights (Vault)"): the owner of a
workshop village grants a right to another player's storehouse in the same province. The grantee swaps its own ore and wood for arms the workshop has made, and takes those arms out
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
  seconds (#128: both lanes build in the same `frontier-node/target/debug`).

Steps (the quoted texts are the English page's buttons and texts):

1. **Get into one province**: A and B both press "Start the world" (with `--demo`: "Start a new world") → "Choose a nation" and pick the **same nation** (one without
   an AI: with `--ai 2`, not Borealis or Ember). A `--two` pair that picks one nation gets its villages in the same
   province, on different sites (#130: 3 of 3 worlds in verify-pr130, 1 of 1 in verify-pr133). The province is shown under "Village details" at the
   bottom of each village screen (e.g. "Province -2,0"). With different nations the provinces are apart and no caravan
   reaches (a path is at most 32 tiles / 4 provinces).
2. **A: build a workshop**: in the village's build list open "Other buildings (6)", then "Workshop" → "Build" (60 food, 120 wood, 80 stone, 40 ore).
   Only a `--coexist` world offers "Workshop"; a plain world's list says "Workshops cannot be built in this test world (only in the --coexist test world, where workshops are lent and rights issued)." instead (fix-loop9 LP9-3: it was offered and refused).
   The notice says "Workshop: building begun". The
   build takes about 1.5 hours (9 turns; about 1.5 minutes at ×60), also when it is the village's first building: the
   one-minute "First building" is for the six production buildings only, and the workshop's row says "1 h 30 min" (the
   program's rule; the row was stamped "1:00 First building" until fix-loop14, LP14-6). Either
   way step 6's "Issue a right" went through only from about turn 18–20 (verify-pr133, loop-play11). Once it stands, the village is a workshop village
   and makes 4 arms an hour (a workshop can be built only in a `--coexist` world).
3. **B: build a storehouse**: select a free tile of A's province on the map, "Build here" → "Build: Storehouse"
   (200 wood, 200 stone, 50 gold from the selected village). It says "Built the Storehouse".
   On a mountain or water tile it says "This structure cannot be built on this tile (impassable, …)" and cannot be pressed: pick a flat tile.
4. **B: bring ore and wood into the storehouse**: select the storehouse's tile → "Send a caravan here" (or the village
   screen's "Trade and defences" → "Send a caravan"). Check that "From" is your village and "Destination" the storehouse, type the
   wood and ore, "Send a caravan". One arm takes 2 ore and 1 wood (e.g. 20 wood + 40 ore for up to 20 arms).
5. **B: deliver the arrived caravan**: a local test world has nobody delivering caravans. The village screen's
   "Rights (Vault)" card shows "Caravans that have arrived (you deliver them)". At first it says "Waiting for the province it crossed, P,Q, to settle past its arrival turn N. Then it can be delivered (a few turns)." and has no button (#130). A turn or two later
   "Deliver the caravan" appears: press it ("The caravan was delivered"; the fee comes back. In verify-pr133 both deliveries took one press).
6. **A: issue the right**: the village screen's "Rights (Vault)" → open "Issue a right", choose B's storehouse under
   "Workshop village and the other player's storehouse", set "Number of swaps" (default 3), "Most arms" (30) and "Days valid" (1), and press
   "Issue a right" (25 gold from the workshop village). A's card shows "A right you issued Active … swaps 0 / 3 · arms 0 / 30".
   - "No other player's storehouse is visible in your workshop village's province. …": B's storehouse is not there yet, or is in another
     province. "To issue a right you need a village with a workshop.": step 2 is not done, or the workshop is still being built (verify-pr133: shown on turn 11, issued on turn 18).
7. **B: swap**: in B's card "Re-read the rights" → "A right granted to you Active". Type a number, "Reserve a swap"
   ("N reserved": ore and wood leave the storehouse, arms leave the workshop village) → "Execute the swap" ("Swapped. The arms are in your storehouse"). "Release the reservation" undoes a reservation.
8. **B: haul the arms home by caravan**: the storehouse's tile → "Send a caravan from here". The form opens with the storehouse
   as "From" and your village as "Destination", and the fields' limits are what the storehouse holds (#130; verify-pr133:
   wood 18, ore 36, arms 2). Type the arms, "Send a caravan". When it has arrived, "Deliver the caravan" as in step 5: the arms
   are in the village's stores.
9. **A: revoke and close**: "Revoke the right" → "Revoked" (B's open reservation is undone) → "Close the right" →
   "closed" (the rent comes back). After the revoke B can reserve no more.

Good to know:
- Fog rule: the card lists only rights you issued or received; rights between others and others' storehouse contents
  are never drawn. To A, B's storehouse is just "(nation) storehouse (tile N)".
- When the other side's card has not caught up, press "Re-read the rights".
- Issuing and revoking are for the wallet only (this browser's test key); AI residents and delegates cannot. (The
  program itself still accepts a session key for the revoke; locally the relay refuses it. To fix before devnet.)
- Caravans can be raided on the road. The long notice after a delivery, "… It arrived, but the amount taken in cannot be verified …",
  is not a failure (it means stores cut off what exceeds their cap). A caravan to a village can instead say
  "… Its journey is concluded. The amount taken in is not verified yet …": not a failure either (the goods are in the village).
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
   `Read-only MCP (③): http://127.0.0.1:<port>/mcp`). It reads the first world only. It offers only
   read tools, and a link is the resident's own (its wallet signs the link statement). `--no-mcp` leaves it off. It runs as long as
   the script (across worlds: when a world's time runs out it waits for the next one) and stops with everything on Ctrl-C.

   In a `--wide` world the server has one more read tool, **`get_territory_status`** (ws13-territory): the connected
   resident's own land (§4.1) as that player sees it — its tiles, the next claim's price in ore, its upkeep in food per
   hour, whether upkeep is unpaid, the claims used this turn, and for each province a claim can reach its tiles as
   own / free / taken / unseen. Fog of war (§5): free and taken are said only for tiles in the resident's sight; a tile
   out of sight is `unseen` (it may be free or another player's). The server still sends nothing: this tool reads the
   world herald's public territory routes (`/h/world/wide/territory` and `/h/world/wide/territory/player/<its own
   Citizen>`), and the page's own read-only account read on the world's relay only when that herald has no such route.

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

   In a `--wide` world this resident also plays **its own land** (§4.1, the same rules and prices as you): before it
   claims a wide village it claims the tile under that village's site (`"order":"TerritoryClaim"` in its log; one claim
   a turn, and its one action a turn), then the village on its own tile, and afterwards one more tile next to its land
   from time to time. It buys such a growth tile only from ore it does not need — the ore beyond its build plan, its
   reserve and one training hundred — at most one every 6 turns, up to 24 tiles, and only while its land's upkeep
   stays within a tenth of its first village's food per hour. The tile under its next village's site is bought once the
   first village's ore pays it and still leaves one training hundred (30 ore for the first tile). (These are the
   resident's own pace, not rules of the world. The operator AI residents keep ore back for their troops too since
   ai-ore-reserve, §4.1; in loop-play15, before that, they bought a tile whenever the ore covered it and then failed
   to train.)

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
     terrain ore, as the program counts it (LP9-4).
   - Plans hold the six orders, and in a `--wide` world the wide land's (below): no caravans, no ordinary marches (caravans wait on r0ze, Q4).

- In `--demo` the ×N clock starts only after **your** first village is placed. Until then a turn is 10 minutes, so
  the resident's second order waits for you.
- Not with `--two`. It works with kept worlds, `--demo`, `--wide`, `--ai`, `--random-map`, `--coexist` and `--resume`
  (pass `--external` again on resume).
- **In a `--wide` world** (external-wide) the launcher tells the resident the world is wide (`wideLand` in its start answer,
  as it tells your page). ⑬'s resident then picks its first village the way your page does there: outward first, the
  free sites of its nation in a settled rim province, farthest ring first. Past the heartland it asks for the village by a
  one-site request (`FileTicket`, the page's "The rim village was requested"), which the world settles at a turn's end; it waits
  for that (up to 72 turns) and does not file a second one meanwhile. The request is its action of that turn. After that it
  plays its rim village with the six orders **and the wide land's own orders, exactly as your page has them there**
  (external-wide-orders): the wide claim (0xD9, the village screen's "Found a village on the wide land (test)"), its wide village's
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

The village screen of a `--coexist` world has a second card, "Storage and workshop lending (test)", under the ② card. Set up as §10
steps 1–5 (same nation, same province; A builds a "Workshop", B builds a "Storehouse" and brings ore and wood into it).

⑨ lend a workshop (A owns the workshop village, B has a storehouse in that province):
1. A: open "Lend workshops", type how many workshops, "Lend workshops" (the pool opens and the copies leave the village's own
   arms production). "Workshops lent".
2. A: choose B under "Who may use them (a player with a storehouse in this province)" (since #149 each option names the village and the storehouse tile; the short address at its end is the owner's resident record, not the wallet: loop-play11 LP11-5), the workshops, "Most arms" and "Days valid", then
   "Let them use the workshops" (the wallet signs). "Workshop use granted".
3. B: under "Workshops you may use", set "Workshops to use" and "Arms to make", then "Book and put in materials": one transaction books the job
   and takes 2 ore + 1 wood per arm from B's storehouse. The job starts two minutes of chain time later.
   The materials must already be in B's storehouse (send them from the village by caravan first). Since fix-loop15 the card shows
   "Your storehouse (tile N): X ore · Y wood"; with nothing there the button is off ("Your storehouse (tile N) holds no materials for this …"),
   and a press for more arms than the storehouse can feed says "Your storehouse (tile N) does not hold enough materials. 10 arms need 20 ore and 10 wood (it holds 6 ore and 3 wood). …"
   before anything is signed (before: "The chain's node rejected this order before running it. It was not sent." — loop-play15 LP15-8).
4. B: "Your jobs" counts "arms N / M" (4 arms an hour a workshop; at ×60 ten arms take about 2.5 minutes). Then
   "Take into the storehouse": "The arms and the unused materials are in your storehouse". Haul them home by caravan as in §10 step 8.
5. A: "Remove" ends the grant (a booked job keeps running), "Take back idle workshops" gives the copies back to the village.

⑩ store ore (B keeps the storehouse, A deposits):
1. B: open "Hold ore for others", choose A's village (since #149 each option names the village, its tile and a short address — the resident record's, as above: "tile (storehouse) → the (nation) village (name) (tile N · 63hY…y3Qe)"; with more than one person to choose from the list starts on "(choose who deposits)", or on the one picked last — fix-loop9 LP9-7), the
   "Space for ore", then "Open ore storage" (wallet). "Ore storage opened".
2. A: "Your stored ore" lists the storehouse. Type an amount, "Store ore": A's own caravan leaves with A's ore. When it has
   arrived and the province it crossed has resolved, "Deliver the ore": "Your ore was delivered to storage" (the ② card does not offer
   these caravans).
3. A: "Take back" sends the ore home in an ordinary caravan; deliver it with the ② card's "Deliver the caravan". "Close the ore storage" once
   it is empty.
4. B sees only "Ore you hold for others": whose ore (by nation) and how much.

Losses (told once as an alert, and kept on the card, from the viewer's side; but the road-loss row "caravan N: taken on the road"
leaves the card once "Check the ledger" is pressed, and then only the map's alert history keeps it): a storehouse seized ("Check the ledger" then
records it; "The storehouse holding your ore was seized: …"), a custody caravan taken on the road ("The N ore on its way to storage was taken on the road."),
a workshop village lost ("Record the village's seizure"; "The workshop village you used was seized: its captor took …").
Since #145 (fix-9-10-followups) the first two can be made to happen in a `--coexist --two` world as real orders (the
program's own SeizeVault, RaidDomestic and RaidCaravan; nothing changed on chain). A village capture still cannot (tests only).
A plain world (no `--coexist`) offers none of these buttons. Muster hosts of 100 troops or more (the program refuses a smaller one).
At ×60 there are only about 20 s between stopping and deciding, so `scripts/play-local.sh --coexist --demo --two --speed 15`
(a turn is 40 s) is easier.
- **A caravan stopped on the road** (B takes A's custody ore). A pair is one nation, and a clash never raids its own nation's
  caravan, so B stops it itself. A caravan stands on a tile only at a turn's start (about 5 flat tiles a turn), so one that
  departs and arrives within a turn can never be stopped. In verify, A's village on tile 28 and B's storehouse on tile 22 of
  province (-1, 2): A's caravan stood on tile 20 when "Store ore" was pressed with about 5½ minutes of game time (about 22
  seconds at ×15) left in the turn. Steps: B forms a host on that tile first (village screen "Form a host", choose the tile on the
  board). When the turn the caravan stood there has resolved, B taps the tile, opens the host card's ⓘ (the tile panel) and
  presses "Stop the caravan (until turn N)" → "You stopped the caravan. …", then "Take it home" or "Burn it" in the same panel (six turns
  from the turn it stood there). It works at ×60 too (loop-play16: B's host on tile 20 from turn 27, A's "Store ore" on
  turn 31, the offer on B's tile panel from turn 33, "until turn 37"): the host has to stand on that tile already in
  the turn the caravan is sent, and the offer shows about 2 turns after the send, once the province has resolved past it.
  A is told "The N ore on its way to storage was taken on the road." (or "… was burned on the road.") and presses
  "Check the ledger" (ReconcileLot) to free the room. A taken caravan goes to B's village; B delivers it with the ② card's
  "Caravan you took" → "Deliver the caravan" (the ore goes into B's village). While it is still on its way the ② card lists it under "Caravans you took (on their way to your village)" with "Arrives on turn N. …", and the map tag says its arrival turn (a short road home arrives at once and shows only under "Caravans that have arrived": in verify-pr162 it showed there the turn after the take, map tag "Raided caravan arrives turn 108"). A burned one goes on empty; A delivers it with "Deliver the ore".
- **A storehouse seized**: the other player forms a host on the storehouse tile (none of the owner's hosts may stand there),
  taps the tile → ⓘ → "Seize the Storehouse" (the button can be pressed with an owner's host there, but the program refuses). The keeper is told "Your storehouse was seized, and the ore you held for others went with it.". With two
  players the captor is the depositor itself: its card says "Storehouse you seized" and no loss; "Check the ledger" then forfeits
  the lot into the storehouse it now owns (captor takes all). A third party's seizure, and "the depositor's troops do not
  defend", need a third seat (not built).
- The herald drops a delivered custody caravan from the map (#145).
- Delivering a burned, empty custody caravan still says "Your ore was delivered to storage" (it carries 0; verify-pr145).


## 13. ① The cross-nation request board and the ⑮ title "Answered a request" (TEST-only, #149, #152)

`play-local.sh` attaches workstream 01's co-op board to every world (launcher option `--coop-board ws01-board-v1`);
add `--no-coop-board` to leave it out. With the board, the village's "Trade and defences" card has "Open requests across nations" and the
bottom bar's "More" shows ⑮'s "Titles and records" card ("What cooperation between nations achieved. It does not affect who wins, scores or prizes").
The board follows the game page's language (#171: switch the game page to English with its top-right button and an open board
window turns English too; the board window has its own switch. The texts quoted below are the board's English).

From request to delivery (only a `--coexist` world sends caravans; an ordinary world's village sends none):

```bash
scripts/play-local.sh --coexist --two --demo --ai 0      # ×60, two people in one world (as in §10; `--ai 0`: no AI residents)
```

**To check the title too, A and B pick different nations** (a request inside one nation can be delivered, but earns no
title). In verify-pr152, on the usual map (no `--random-map`), A = Aster and B = Borealis, and the caravan arrived (a caravan's
road is at most 32 tiles and 4 provinces).

1. **A (asks)**: "Village" → "Trade and defences" → "Open requests across nations". The board opens in another window. "Sign with this wallet"
   (the page's test wallet signs the board's records only) → enter wood and stone → "Make the request (sign)". The destination
   is A's village (e.g. "Wood 20, Stone 20 → … (Aster, as declared; not used in judging), village (-1,2) site 5 Open"). The board's "Your nation" select names
   the nations as the game does and, once the wallet is connected, follows the nation checked on chain (it is still only a
   declaration).
2. **B (delivers)**: open the board the same way, "Sign with this wallet" → the request's "Accept (you mean to send; no obligation)".
3. **B**: in the game, "Village" → "Trade and defences" → "Send a caravan". Within about 15 s the destinations include "① Request destination: village (-1, 2 · tile 28)"
   (followed by the nation, e.g. "· Aster"). **Only someone who answered "Accept" to that request gets this destination**:
   only the place the requester published on the board; the land around it stays out of sight (fog unchanged). Enter
   the amounts → "Send a caravan" → "A caravan to another player is signed with your wallet…" → "The caravan has set out".
4. **B**: reload the board → "Link caravan #0 (Wood 20, Stone 20) to this request" → "linked. Only final arrivals are counted".
5. When it arrives, B's "Rights (Vault)" card shows "Deliver the caravan" under "Caravans that have arrived (you deliver them)" (after the
   provinces on the way have settled past the arrival turn; tens of seconds at ×60). Press it → "The caravan was delivered".
6. The board's "Caravans and arrivals" row says "Arrived (final) · Arrived: Wood 20 or more, Stone 20 or more (from the rules) · Fulfilled" and the request
   reads "Fulfilment of the request: Reached the amount asked (proven by the lower bound of the counted amount)". After a partial delivery it says "Did not reach the amount asked (everything finished; proven by the upper bound)", but the request stays "Open"; deliver and link the rest and it turns to "Reached the amount asked".
7. **The ⑮ title "Answered a request" (#152, owner decision Q1-⑮)**: once the request has reached its amount, the deliverer B's page
   shows "Turn N You earned the title “Answered a request”" under "More" → "Titles and records" (N is the
   turn of the arrival that reached the amount; reading the board takes a moment). The requester A's card shows nothing
   (still "No titles yet": a title is shown to its holder only).

When the title is earned (⑮'s ruleset B version 4, `workstreams/15-coop-outcomes/src/rulesets.mjs`):
- You **delivered with your own caravan** to a request of **someone of another nation**, and that request **reached its
  requested amount** (the board's proof by the lower bound of what it counted). Every counted delivery counts toward the
  amount, also those of the requester's own nation (owner decision 2026-11-26, Q-TG2-2): A asks for 20 wood, C of A's nation
  delivers 15 and B of another nation 5 → the request reached its amount and B earns the title; C earns nothing.
- Not earned by: answering "Accept" alone, a partial delivery to a request that did not reach its amount, a request of someone of
  your own nation, your own request (the board refuses that in the first place).
- Titles and records only: nothing is added to the world goals, score or prize (owner decision ⑮ B; the
  decisions of 2026-11-24 also keep cooperation out of the “world goals”).
- The other title earnable now is P-raider ("Raider of foreign caravans": took goods from another nation's caravans; raids at home do not count), which has nothing to do with requests.
  - What you took from foreign caravans, added up per resource over all your raids, must reach the minimum in at least one
    resource: 100 food, wood, stone or ore, 10 arms or 20 gold (`rulesets.mjs` `minQty`, `goals.mjs` raider).
  - A foreign caravan is raided only in the clash, and a caravan joins a province's clash only while that province has fewer than
    12 garrisons (villages and Free Cities on its sites, the bandit camp, manned forts; contract `S1-1B-CONTRACT.md` §3.5,
    `clash_model::build_v2`). A caravan on a site's tile is sheltered. In a `--demo` world (fixed map) Aster's home province (-1, 2)
    fills with 12 villages in the first turns, so no caravan is ever raided there (loop-play20 LP20-3 tried exactly
    that); a `--wide` world does not put those villages there.
  - A route that works in `--coexist --demo --two` with A = Aster, B = Borealis (caravan-raid-investigate, ×60): B makes a
    request on the board, A accepts and sends Wood 120 to "① Request destination: village (-2, 2 · tile 6)"; B reads the
    caravan's tiles in (-2, 2) and musters 100 Spearmen on one of them before the caravan stands there; B's tile panel offers
    "Take it home", and "Turn N You earned the title “Raider of foreign caravans”" appears under "More" → "Titles and records".
- The card's "Achievements not decided yet: N" is the total of every resident's undecided goals (not necessarily yours).

## 14. World goals: the flag keeps (TEST-only, first slice, no money)

The world is continuous: there are no seasons, and the world has no end. Instead it has four permanent goals without a deadline
([design](../design/win-conditions/01-proposal.ja.md), Japanese; accepted by r0ze on 2026-11-24). Only the first is judged so far:

- **Flag keeps (hegemony).** Each nation's contestable keeps (not heartland) carry flags: two per nation, border keeps
  first, ordered by the world's drand seed. A nation achieves the round when it holds flag keeps **captured from other
  nations**, as many as **half of the flag keeps**, each for **144 turns** (24 hours of the chain clock; 24 minutes at
  the ×60 TEST clock). **The flag keeps a nation starts the round with do not count for it** (owner decision,
  2026-11-24 22:00: with them counted, a need of 2 was met by every nation without doing anything). A starting flag
  keep that a nation lost and took back is still its own starting flag keep and does not count for it either; it does
  count for any other nation that holds it. The next round is posted at once, drawn from what each nation holds then,
  so nobody starts a round with a captured flag keep.
- World-first technology, wonder and unexplored mark are on the card as "coming".

Every play-local world has the judge (`--no-world-goals` turns it off). The launcher judges off chain in its own process.
It reads the world's Province and Citizen accounts and serves the result read-only at
`/goals-world/<world proxy port>/goals/state`. Open "Nation & territory" to see the "World goals" card
("Four goals without a deadline. Any nation can go for them at any time"): the four goals, the round
("Round N: a nation that holds 3 flag keeps captured from other nations, each for 144 turns (24 h) without a break, achieves it (6 flag keeps in all; the flag keeps a nation starts with do not count for it)"), each flag keep with
its holder and, once captured, its hold timer (a flag keep still in its first nation's hands says "a starting flag keep of this nation (does not count toward the goal)"), your nation's progress ("Your nation: captured flag keeps 0 / need 3; 0 have met the hold time")
and every nation's count of captured flag keeps ("No nation has captured a flag keep from another nation yet" at the start). On the map each flag keep you can see has a gold pennant beside its standard.
On a ×60 TEST clock the card says its times in real minutes ("72 turns (about 12 minutes of real time in this world)");
at 1× in turns and hours (#208).
Under the fog of war the card tells a flag keep as the map does: a keep in sight with its holder, hold timer and siege;
one you saw before with its last-known holder only; one you have never seen by its place alone ("You have not seen this
province's keep yet."). Your own nation's flag keeps are always shown (also in `--wide`, where the page's keep list does
not hold far rim keeps: the judge's holder is enough; #208). A flag keep your nation held and lost stays on the card
with the nation that took it — "held by Ember · holder when your nation lost it (turn 92)" —, without a timer or a
siege: the capture was told to you, what happened there afterwards is not (fix-loop14, LP14-3). Every nation's count stays public, like the "Provinces held" strip.

After an achievement the card names it ("Round 1: Aster achieved it (turn 162)") and
says what the prize **would** have paid you: "If prizes were on, you would have received X test USDC". This is an estimate from a simulated vault: one 25 test USDC pass per person, 80 % to the prize, 30 % of
the hegemony vault per achievement. Inside the nation the payout is split by contribution points (a capture is 10 points;
reinforcement is 1 point per 100 troops on the keep). Operator AI residents earn points but no money, an external AI resident is not paid either (the card:
"Prizes for external AI residents wait for a legal review"), and someone who joined the nation less than 24 hours (144
turns) before the achievement gets nothing for that round. Nothing is paid, nothing is sent, and the chain is not
changed: the prize program's goals pool (#202, test USDC only) is not connected to `play-local.sh`.
An achievement is also told as a notice and a feed line while the page is open (#208): "World goals: Ember achieved round 1 of
the flag keeps (turn N)", or for your own nation "World goals: your nation (Aster) achieved round 1 of the flag keeps (turn N). If prizes were on,
you would have received X test USDC". Achievements that were already on record when the page opened go into the list
quietly.

In a local world rings 2–3 are heartland and round 1 is posted at the start, before ring 4 opens, so the only
contestable keeps then are ring 1's: each nation has **one** flag keep, 6 flags, need 3 (when ring 4 opens — in one
×60 run by turn 13, in another not by turn 60 — its 24 keeps are contestable, without a flag; a later round is chosen
from the keeps open at its posting; loop-play13's `--wide` world had 12 flags, need 6). For a quick try, use the TEST overrides `--flag-keeps-need N` and `--flag-keeps-hold N` (turns). For
example `scripts/play-local.sh --demo --ai 0 --flag-keeps-need 1 --flag-keeps-hold 72`: capture one neighbouring flag keep
(72 turns), then hold it 72 more turns. (With `--flag-keeps-need 2` you must capture two; your own flag keep does not count.)

**AI residents and the flag keeps.** With `--ai N` (at war) the AI residents read the same "World goals" card as a player
of their nation, under the same fog: the posting and every nation's count, and each flag keep's holder and siege only
where their own villages, hosts and their nation's held provinces see it (never the judge's live answer for a keep they
cannot see). They defend their nation's flag keep under siege before any other keep, and march first on a flag keep captured
by a nation that holds the need minus one or more captured flag keeps (still only with 1.5× the keep's garrison; that nation's own starting flag keep is an ordinary flag target). Otherwise a flag keep they
see only wins a near tie. A resident with one march already on a flag keep gets no more of that tie-break (two for a
close rival's flags), so its other hosts fight the ordinary war. Once ring 4 is open its keeps are contestable too
but carry no flag in round 1, and the AI residents keep fighting over them. Their log (`operators.out`) names the reason of a march: `defend-flag`, `stop-rival` or `flag`.

## 15. Notifications outside the page and a calendar file (every world; owner decisions Q-PT-8 (a)+(b), Q-PT-10)

More → **Notifications (outside the page)**. Nothing here leaves the browser: no account, no server, no third party.

- **While the tab is open.** Press **Turn on browser notifications**: only then does the browser ask for permission.
  While the tab is in front, the notices over the map are all you see. While it is behind (another tab or app), each
  new event you chose comes as one browser notification; if the browser refuses notifications (or has none), the
  button reads **Show a count in the tab title** and the tab title shows "(2) Wylls" instead. The count goes when you
  come back. Each event is told once. Once you turned this on, a hidden tab keeps reading at its slow pace (every
  60 s, faster in a ×60 world) so it can tell you; nothing else changes for players who did not.
- **Which events.** On by default: **attacked** (a siege on your village, your nation's keep contested or taken, a
  village or land of yours taken, a caravan or storehouse of yours raided or seized, a host of yours attacked where it
  stood) and **battle report ready**. Off until you switch them on: an enemy host may reach your village, a host can
  march again, land upkeep unpaid, a keep capture complete. Only your own events the page already reads count (the
  fog is the same).
- **Calendar (.ics).** **Save calendar file** writes your coming timers — a host ready again, a march's arrival and
  its report, a keep your nation is taking (or one it holds that may fall), unpaid upkeep letting land go — into a
  file for the calendar app you choose (titles in English and Japanese). Times are estimates. Save and import it again
  after plans change: the same events move. In a ×60 world the times are seconds or minutes away.
- Not yet: notifications when the browser is closed (Web Push, the next step; it needs a fixed public address).
