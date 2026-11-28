# Walletless demo (static)

One URL, no wallet, no sign-up, no server, no chain: the real Wylls page plays a
sample world that runs inside the browser.

```sh
cd permutation-gateway/demo
npm ci --ignore-scripts
node build.mjs            # → dist/ (≈ 43 MiB on disk, ≈ 3,700 files; a cold load fetches ≈ 5.2 MiB, ≈ 2.0 MiB gzipped)
node check.mjs            # key-free checks of dist/ (CI runs these)
node serve.mjs --port 41751 --prefix /play/ --gzip   # try it: http://127.0.0.1:41751/play/ (--gzip: as static hosts send text)
node smoke.mjs --loop     # Playwright play-through (signs with the page's test Dev Wallet: manual key-tests job only)
node smoke.mjs --origin https://r0ze998.github.io --prefix /wylls/ --path frontier/index.html --act [--mobile] [--lang ja]
                          # the same, AT the Pages host name (routed in the browser): no wallet prompt, one order
node smoke.mjs --origin https://r0ze998.github.io --prefix /wylls/ --pre-join   # stops at the start button; only the load-time Ed25519 test (seed 0x07, fixed text) signs, once: runs on every PR (ci.yml walletless-demo, Q-FDW-1/2)
```

`npm run build:demo` in `permutation-gateway/` does the install, build and check in one go.

## What is in `dist/`

- A copy of `permutation-server/web/` — the same HTML, JS modules, CSS, art, Japanese/English text and
  `frontier.wasm` rules kernel the live page uses.
- `index.html` — the URL to share; it opens `frontier/index.html` by a relative link.
- `frontier/app.bundle.mjs` + `frontier/chunk-*.mjs` — the page's ≈ 350 ES modules bundled by esbuild (minified,
  split at the page's own dynamic imports; entry `src/page-app.mjs`, which runs the real `app.mjs` unchanged). Every
  game page loads `app.bundle.mjs` instead of `app.mjs`: a cold load is ≈ 257 requests / 5.2 MiB (≈ 2.0 MiB gzipped)
  instead of ≈ 560 / 10 MiB. Each module's `import.meta.url` is rebased at build time to where the module lives, so
  its art, style sheets, wasm and seal workers resolve as before. The module files themselves stay in `dist/` (the
  seal workers and the council page load them). A test must not import `fstate.mjs` etc. by URL (that is a second,
  idle copy): the bundle's own instances are on `__wyllsDemo.modules` (`fstate.mjs`, `map/fmap.mjs`, `fgeo.mjs`,
  `../map.mjs`). Style sheets are minified in place.
- `frontier/demo-world.js` — `src/boot.mjs` bundled by esbuild (the page's modules it borrows — keys, codecs, clash
  arguments, clock — are marked side-effect free there, so it carries no text tables or UI: ≈ 550 KiB): the screenshot suite's sample world
  (`screens/liveworld.mjs`: M1 rules in the real herald/relay shapes, clashes by the same `frontier.wasm`, other
  nations by a seeded script) plus a `fetch` shim that answers the page's `/h/*`, `/gw/*` and `/coop/*` reads in
  the page. Any request to another origin is refused (`walletless demo: no network`). Each game page loads it
  before `app.mjs`.

It works from any static host and any path prefix (`/`, `/play/`, `/wylls/`). It does not work from `file://`
(Chrome refuses module scripts and SVG `<use>` there).

## The world

- `createLive({opening, territory, nations, landUpkeep, landClaim})`: the guest picks one of six nations and gets a
  first village at once; every nation has an AI village (`nations`) that marches into the guest's province.
- Land is the live game's single-tile claim (`landClaim`, demo-claim-1, Q-WD-4): no tile is taken on arrival. The
  village card's "Your land / あなたの土地" card (`web/frontier/screens/sampleclaim.mjs`, built from the real card's
  parts) lists the provinces in reach; "Claim a tile" shows the cost (ore, and the tile's food upkeep), the
  preview's own "Claim a tile" claims at once. The judge is the kernel's (`web/frontier/sampleland.mjs`:
  frontier-abi `judge_claim` + permutation-rules `may_claim` through `territory-rules.mjs`, numbers TERRITORY_V1:
  10 ore + 2 % per tile owned, reach 3 from the home / an own tile / the nation's land, one a turn, none while
  upkeep is unpaid). The real V1 food upkeep (`landUpkeep`) is paid from the first village, and the land
  logistics horizon on the card follows every claim. The other nations' villages claim too, by the same judge.
  Simpler than the program: every province of the demo map (rings 0–2) is territory land (the program's is ring
  129 and out), the camp's tile stands for the keep's, nothing is signed, and tiles do not change hands in battle.
- A turn lasts 12 s (`--turn`), the first turn begins 3 s after load (`--delay`). A reload continues the saved
  world (see Save / resume below); without a save, or with an old or damaged one, it is a new world (same seed) and the
  demo clears its own `ps-*` storage at load, keeping only the language.
- The guest signs with the page's test Dev Wallet (`screens/world.mjs` `storageFor`: the sample world's fixed seed and
  `ps-wallet`, kept in this browser only; it never reaches a chain). The real page offers that wallet only on a loopback
  host (`frontier/config.mjs` `dev`), so `build.mjs` bundles `config.mjs` with `dev` true: the demo offers it on any
  host. Before fix-demo-wallet-p0 it did not, and on GitHub Pages the nation picker asked for a wallet ("To begin,
  connect a wallet first."); every earlier smoke ran on 127.0.0.1 and passed. `smoke.mjs --origin` runs on the real
  host name; `build.mjs` fails if the `const dev = LOOPBACK(host);` line it replaces moves.
- The pre-join screen says "Playable demo · no wallet needed / 体験版・ウォレット不要" next to "Choose a nation".
  A demo world does not show the test-world end turn (1,008) while it is ahead (join screen, standings card), and
  hides the map's "Records" button (a demo has no recorded wide world).
- The season record carries `sample.demo = {live}`: the page's tag says "Playable demo / 体験版" and, only when
  `--live-url https://…` is given, links the live world ("The live world / 本物の世界へ"). There is no default: the
  label promises a world to play, so it must not point at the source repository (Q-WD-1).
- Hosting: put the demo on an origin that never serves the real page. The demo clears every `ps-*` key of
  its origin's `localStorage` (keeping only `ps-lang`) whenever it starts a fresh world (no save, an old one, or
  Start over), so on a shared origin it would wipe the real page's saved wallet choice and in-game key.

## Bandit camps (demo-npc-camps)

`createLive({camps: true})` (boot.mjs turns it on; off for every other caller): bandit camps ("Barbarian camp" /
「蛮族の野営地」, the page's own word) that a player marches on and beats for loot. The rule's numbers are
`DEMO_CAMPS` in `permutation-server/web/frontier/democamps.mjs` (pure; the world and the page read the same file).

- **They are the program's camps**: the Province's one Camp record, a neutral garrison in the clash the page's
  `frontier.wasm` resolves, cleared when an arrival beats it (`camp_mask`; the program's 10 Works go to the winner as
  before). Nothing of the march or the clash is new. The program's day check (camp.rs `place`: chance ½ a game day,
  100–400 troops, ring 2 only) is switched off by `NEXT_CHECK_DAY` = 0xffffffff (the kernel then skips it too).
- **Placement**: one camp in every ring-1 and ring-2 province (18), on the passable tile farthest from every village
  site (taken or free; ≥ 3 tiles on this map), in ring 1 at least 3 tiles from the centre (the flag castle's place);
  ties by a fixed hash. Deterministic: the same map every time.
- **Defenders**: 300 + 200 per province between the camp and the player's first village (300 / 500 / 700 / 900 /
  1,100), set at the first resolve after the village is placed (700 before it).
- **Loot** (the demo's; the program pays only Works): food 0.3, ore 0.1, gold 0.05 per defender the camp had when the
  clash that cleared it began, into the winner's first village (a full store takes less). A camp of 300 pays 90 food,
  30 ore, 15 gold — enough to train about 150 Spearmen. The battle report shows it (`demoCamp` on the clash record).
- **Comeback**: 20 turns after it is cleared, on the same tile, once no host stands there and no arrival is bound for
  it, 20 % stronger each time (cap 1,500). A host left on the tile keeps it away.
- **On the page**: a tent marker with the defenders over every standing camp, also under the fog (`src/camphud.mjs`;
  the page draws a camp only in sight); the tile card says the camp and "Loot if beaten: …"; the guide's march step says
  what the tents are. The AI nations never march on a camp (Q-NPC-1), and camps never leave their tile (Q-NPC-2).
- **Save**: nothing new is saved. The save is the world's inputs, replayed (below); the camps are part of the
  deterministic world, so a reload makes them again — cleared, comeback turn, loot and all (`smoke.mjs --camps --reload`).
- `node camps-playtest.mjs [--nation all] [--turns 75] [--strategy hunter,reckless,none] [--ratio 0.9] [--chunk 500]
  [--set baseTroops=…,perProvince=…,lootMilli=f:o:g,regrowBells=…]`: headless games in Node (the numbers'
  playtests: reports/demo-npc-camps.md).
- `node smoke.mjs --origin https://r0ze998.github.io --prefix /wylls/ --path frontier/index.html --camps --reload
  [--lang ja]`: the browser play-through (train, form a host, march on the nearest camp, the report's loot, reload);
  it signs with the page's test Dev Wallet like `--loop` (manual key-tests job). `--pre-join` checks the camps are on
  the map and signs nothing.

## GitHub Pages (https://r0ze998.github.io/wylls/)

`.github/workflows/pages-demo.yml` builds `dist/` with `--base /<repo>/` and deploys it with `actions/deploy-pages`
on every push to `main` that touches the demo's sources (and by hand: Actions → "Walletless demo → GitHub Pages" →
Run workflow). It needs no secret. One-time: Settings → Pages → Source = "GitHub Actions". The repository variable
`DEMO_LIVE_URL` (optional, an `https://` page) becomes the tag's live-world link; empty = no link.

Try the Pages layout locally: `node build.mjs --base /wylls/ && node serve.mjs --port 41850 --prefix /wylls/` →
http://127.0.0.1:41850/wylls/ (`serve.mjs` answers a missing path with `dist/404.html`, as Pages does).

## The saved world, and browsers without Ed25519 (demo-polish-2; owner Q-WD-6, Q-WD-8)

- **Save / resume** (`src/save.mjs`): the world survives a reload. What is kept in `localStorage`
  (`wylls-demo-save`) is the world's **inputs**, not its state: the clock reading of the page's first read, and every
  POST the page sent (signed join / orders / reveals, as text) with the world clock reading it was taken at and a
  digest of the answer. At load the same seeded world is made and the inputs are replayed at their readings; the
  world is deterministic, so it is the same world (every answer is checked against its digest). The page's own
  `ps-*` keys (its guest wallet, in-game key, seal book) stay as they are, as in the real game. It is written after
  every POST, at every turn change and on `pagehide`.
- **Versions**: `v` (the format) and `world` (sha256 of the built `demo-world.js`, first 16 hex, filled in by
  `build.mjs`). A save of another format or world build, a damaged one, or one whose replay answers differently
  starts a fresh world, and the nation picker says so in one line. So a deploy that changes the world bundle starts
  everyone over; a page-only change does not.
- **Cost**: the replay catches the world up through every turn, ≈ 4 ms a turn (1.2 s for 300 turns ≈ an hour of
  play; the fixture encoder's `snake()` was memoized for this). The cold load to the village is ≈ 4 s.
- **Quota**: past 2 M characters, or when the storage refuses a write, the save is dropped (a reload then starts
  fresh) and the tag stops offering "Start over" and says a reload starts over. A short session is a few KB.
- **Start over**: the demo tag's button asks first (`confirm`), then clears the save and the `ps-*` keys and reloads.
- **No Ed25519** (or not https): the demo tests the browser at load (the `session.mjs` preflight's test: sign and
  verify with WebCrypto Ed25519). If it fails, the world is made keyless (it shows the picker and signs nothing),
  nothing is saved or replayed, and the picker shows a notice naming Chrome / Edge 137+, Firefox 129+ and Safari 17+
  (the versions `session.mjs` states) in place of the join button.
- `node smoke-save.mjs [--lang en|ja] [--only save,long,bad,reset,crypto] [--port N]`: the Playwright check of all of
  this (manual key-tests job, like `smoke.mjs`).

## Travelers (demo-npc-merchants; owner r0ze 2026-11-28 16:21, NPCs part 2)

Three travelers walk the map (`screens/travelers.mjs`, the world option `travelers`; the page side is
`src/travelhud.mjs`, bundled into the page): Tamsin (the outer ring), Odo (the inner ring), Lio (the AI villages).

- **Walk**: a fixed loop of stops, by the shortest path over passable tiles of rings 0–2, 3 tiles a turn, 2 turns of
  rest at each stop. Where a traveler stands is a function of the turn (no state, no randomness), so a reload puts it
  back. A traveler is in no province's roster: it never blocks or meets a march, and it cannot be attacked (v1).
- **Visit**: a traveler within 1 province of the player's village is visiting; one unbroken run of such turns is one
  visit, with its own rates and limit.
- **Trade**: food ↔ ore in lots of 10 ore, at most 3 lots a visit (bought + sold). A lot costs 30 food to buy and brings
  18 to sell, moved together by ±4 a visit (seeded by the traveler and the visit's first turn; Odo leans cheaper and Lio dearer, by
  one step). Buying is always dearer than selling. The page sends POST `/gw/f/sample/trade`
  `{traveler, side, lots}` to the in-page world: a world input, saved and replayed like every order.
- **Talk**: three short lines a traveler (EN + JA) about the demo's own rules. Which line comes next is kept in the
  save's own section `sections.travelers = {v: 1, talk}` (`src/save.mjs`: optional, versioned sections a reader
  ignores when it does not know them; nothing in them is replayed).
- The page: a marker on each traveler (a ring when it is visiting), a "Travelers" button (bottom left) listing all of
  them, and a panel (Talk / Trade). GET `/h/demo/travelers` answers the record the panel reads.
- `node travelers-playtest.mjs [--grid]`: the headless playtest the numbers came from (every ring-2 home, 100 turns ≈ a
  20-minute game). `node smoke-travelers.mjs [--lang ja] [--mobile] [--pre-join]`: the Playwright check at the real
  Pages host name (pre-join: talk only, nothing signed but the load-time preflight; otherwise join, trade to the limit,
  reload).

## Build options

`node build.mjs [--out dist] [--live-url https://…] [--base /wylls/] [--turn 12] [--delay 3] [--land-ms 400]`

`--base` is the path the host serves `dist/` under. Only `404.html` uses it (written only with `--base`: a host
serves it at whatever missing URL was asked for, so its link must be absolute); it sends the player to the demo.
Every other file stays relative and works under any prefix. `dist/.nojekyll` is always written (the page has files
named `_*.mjs`, which a Jekyll pass would drop).

## The goal: win or lose (demo-solo-goal; owner 2026-11-28 14:32, Option A "本番の縮小版")

The demo is a complete single-player game: the real flag-keeps win condition (`src/frontier/world-goals.mjs`),
compressed (`screens/demogoal.mjs`, liveworld option `goal`). Every number is `DEMO_GOAL` there.

- **Flag castles**: one per nation (6), each on the tile nearest the centre of the nation's ring-1 province, guarded
  from the start by 110 troops of the nation's AI village. A castle's holder is its tile's owner. Castle tiles are the only
  tiles that change hands by conquest (a lone surviving host of one nation after a resolve takes it; leaving does not
  give it up); every other tile is claimed one at a time (#306).
- **Win**: hold **3** castles of other nations, each for **20 turns** (4 min at 12 s a turn), as the real rule counts:
  only captured castles (never your own nation's), each from when it was taken, a capture resets that castle's timer.
  Need = half of the 6 castles (the real `needOf`) = half of the 5 rivals' rounded up.
- **Lose**: an AI nation meets the same rule first (a same-turn tie is your win).
- **The AI**: 28 turns of grace after your village, then a wave every 10 turns (100 troops ×1.12 a wave, capped at
  2,000): the rival leader (two nations along from yours) every wave, +20 % troops, racing for castles (retake its own,
  stop a nation one castle short, hold what it has, capture the nearest); one more AI nation a wave (they take turns)
  takes its own castle back or raids you (your castles, else your land: a raid on land only brings a host there to fight
  yours, since land never changes hands by marching). Your own nation's AI village only defends.
- **On the page** (`src/goalhud.mjs`, bundled into the page): the goal card at the top left (castles, holders, hold
  timers, rivals, the next wave; "March here" on a castle while a march is open), a pennant over each castle on the map,
  and the result screen (Victory / Defeat, the time, Play again = Start over without the question). The guide's march
  step and its last card point at the goal. EN and JA; never "season".
- **Save**: nothing new is saved — the castles, holders and timers come back with the replayed world (#308).
- `node goal-playtest.mjs [--strategy active,human,idle,turtle] [--set holdBells=15,...]`: headless games in Node
  (the same world and kernel, a scripted player) — the tuning tool.
- `node smoke-goal.mjs --path win|lose [--lang ja] [--fast 4] [--reload] [--url https://r0ze998.github.io/wylls/]`:
  Playwright, at the Pages host name, played to the result screen through the page's controls (manual key-tests job:
  the page signs with its test Dev Wallet). `--fast` steps the demo's clock (`__wyllsDemo.skip`, the clock the save
  reads) while no march of yours is out; `--reload` reloads mid-hold and checks every castle and timer.
