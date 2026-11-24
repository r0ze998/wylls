# Playing Frontier locally: build and start from this repository

This page says how to build and start the local-play launcher from a clone of this branch. It also says what each of
the two modes shows on screen, and what is not done yet. Every step here comes from the sources in this repository.
A start from a fresh clone on a new machine has **not** been run end to end yet.

**Shortcut:** `scripts/play-local.sh` does §1's checks and §2's builds (land-preview lane), then starts a kept world
(§3 (1) with (5): `--continuous` + `--persist`; `--resume` reopens it) or, with `--demo`, §3 (2)'s capture demo, in one
command; see [PLAY-LOCAL.md](PLAY-LOCAL.md) / [PLAY-LOCAL.ja.md](PLAY-LOCAL.ja.md).

Two modes, never mixed:

| | (1) Natural world | (2) Capture demo (TEST-ONLY) |
|---|---|---|
| Clock | real time: a turn is 600 s | after your home, compressed ×10–×60 (`--demo-scale`) |
| Other villages | none; you are alone (unless operator AI residents are added, §3 (6)) | test participants, each with its own in-memory key (and residents, §3 (6)) |
| Rules | the program's rules | the same rules; nothing is changed |
| On screen | always the session notice | also a fourth line: 「この世界は試験用の攻略デモです…」 |
| What it can show | home, economy, army, an ordinary march | also the next ring opening, the fort list, a march onto a fort and its hold count |

## 1. What you need (installed beforehand; nothing here installs anything)
- **Node.js** 20 (20.19 was used). The launcher and its relay use only Node's built-in modules, so no `npm install` is needed
  to start them.
- **Rust** through rustup, two pinned toolchains: the repository root's `rust-toolchain.toml` pins **1.89.0** (the
  program and its `.so`), and `frontier-node/rust-toolchain.toml` pins **1.95.0** (the runners, herald and tools).
  rustup picks each by the directory a build runs in.
  - The builds below use `--locked`.
  - The `frontier-node` builds need network access to fetch crates the first time, or a filled cargo cache.
  - The program build (§2, first block) runs **offline** and never downloads. On a machine whose cargo cache does not
    yet hold the program's crates, fill it once beforehand with network access, for example
    `cargo fetch --locked --manifest-path permutation-frontier/Cargo.toml` from the repository root. A build from an
    empty cache has not been tried.
- **For the program artefact:** `solana-cargo-build-sbf 3.1.9` and platform-tools v1.52, already installed.
  `scripts/build-frontier.sh` checks both and refuses to download anything.
- **A browser** on the same machine. Everything listens on 127.0.0.1 only.
- **Network during play:** the keeper reads public drand rounds over HTTPS.
- **No wallet, key or funds.** The page makes a memory-only key for each world. The local chain lives in memory and
  ends with the world.

## 2. Build (from the repository root)
Every binary goes into the usual cargo target directories. The launcher asks for absolute paths to them (§3).

```bash
# the program artefact (localnet test lane; never deployable): writes
#   permutation-frontier/target/deploy-localnet-conquest-sbf/permutation_frontier.so
scripts/build-frontier-localnet-conquest-sbf.sh
```

```bash
# the runners: localnet-natural-play (natural world and capture demo) and localnet-expedition-play
(cd frontier-node && cargo build --locked -p itest --features localnet-expedition-play --bin localnet-natural-play --bin localnet-expedition-play)
```

```bash
# the herald: default features are enough for the natural world and the demo
(cd frontier-node && cargo build --locked -p herald --bin frontier-herald)
```

```bash
# the depart / preview / resident command-line tools the relay calls
(cd frontier-node && cargo build --locked -p keeper --features expedition-dispatch-experimental --bin frontier-experimental-expedition-depart-prepare --bin frontier-original-expedition-preview --bin frontier-experimental-expedition-prepare)
```

- **Artefact hash:** `--artifact-sha` is the SHA-256 of your `.so`. The launcher refuses a file whose hash differs.
  - On 2026-11-13 this branch's program sources rebuilt to
    `b64a539afe066c59c6584ff7928f620647428f1a115df41f9289c772c4447f80` with the tools above.
  - Another toolchain may give another hash. Pass the hash of the file you built.
- **The herald's `local-play-bootstrap` feature** (named in the launcher's usage text) is used only by the
  launcher's non-natural presets. The two modes here do not pass `--local-play-metadata`, so they do not need it.
  A non-natural preset (with `--prepare-scale`) needs a herald built with both features, because the launcher's
  prepare step also reads the herald's wide route (`/h/world/wide/route`), which a herald without
  `wide-world-experimental` refuses:
  `(cd frontier-node && cargo build --locked -p herald --features local-play-bootstrap,wide-world-experimental --bin frontier-herald)`.

### 2a. ⑳ NFT resident ID lane (owner decision 2026-11-18 18:26 JST: devnet/local only, no sale)
Reopened 2026-11-18 by owner; devnet/local only. A separate artefact of the same lane with the NFT resident
instructions (`nft-experimental`: CreateResidentPolicy 0xE0, JoinResident 0xE1, ResidentAct 0xE2):

```bash
# writes permutation-frontier/target/deploy-localnet-nft-sbf/permutation_frontier.so (version 0xC804; never deployable)
scripts/build-frontier-localnet-nft-sbf.sh
# the local play check on that artefact (an NFT resident and a wallet player in one world, then a transfer)
(cd frontier-node && WYLLS_NFT_SBF=$SO WYLLS_NFT_SBF_SHA256=$SHA \
  cargo test --locked -p itest --features localnet-nft-harness --test localnet_nft_resident -- --nocapture)
```

- The launcher (§3) does **not** start this artefact yet: its runner, herald metadata check and the keeper's
  expedition prepare tools accept only version `0x4804`. The NFT lane's Seasons are `0xC804`.
- Metaplex Core and the resident program are not run locally: the harness writes the asset and the resident record
  in the state their instructions leave (`frontier-node/crates/itest/tests/localnet_nft_resident.rs`, module doc).
- The undecided items run on the defaults of `frontier-abi/src/resident_terms.rs` (not owner decisions).

## 3. Start
Choose a new directory for the worlds' records (logs and the herald's fold files; nothing secret, except with
`--persist`, §3 (5), which also keeps each world's two TEST operator keys there, in private 0700/0600 directories and files). Put each path in
a shell variable first, as absolute paths:
- `ROOT`: the repository root;
- `DATA`: the records directory;
- `T`: `ROOT/frontier-node/target/debug`;
- `SO`: the `.so` file built in §2;
- `SHA`: its SHA-256.

### (1) Natural world
```bash
node "$ROOT/permutation-gateway/src/frontier/local-play-launcher.mjs" --root "$ROOT" --data "$DATA" --runner "$T/localnet-expedition-play" --natural-runner "$T/localnet-natural-play" --world-preset local-natural-v1 --economy page-signed-v1 --march-trial local-march-trial-v1 --herald "$T/frontier-herald" --depart "$T/frontier-experimental-expedition-depart-prepare" --preview "$T/frontier-original-expedition-preview" --resident "$T/frontier-experimental-expedition-prepare" --artifact "$SO" --artifact-sha "$SHA"
```
- **Without `--march-trial`** the world is the same, but the ordinary march stays closed. Its live readiness is
  not proven yet.
- **`--world-ttl-minutes <n>`:** each world's life. The default is two hours.
- **`--port` / `--world-port`:** default 41920 / 41924. Each world uses five ports from `--world-port` (ten for the two
  worlds). All of them and the launcher's port must be within 41000–41999, must not overlap, and must avoid 41904–41907.
- **Disk:** the launcher starts no world while the records directory's disk has less than 5.25 GiB free, and it stops a
  running world when free space falls below that, or when that world's records pass 128 MiB.
- **Ending a world from the page:** the launcher prints its `open` address with an owner proof in the fragment
  (`http://localhost:41920/#owner=<43 characters>`, new for each launcher start; `scripts/play-local.sh` opens it). Only a
  page opened at that address can end a world from the list of running worlds (`/local-play/stop {wallet, owner}`); a
  page opened at the bare address plays as before but is refused that end (403 `NotWorldOwner`). A world's public address
  alone never ends it, so an admitted external resident (`--external-residents`; workstreams/03-composability/mcp/examples/external-resident/README.md) cannot stop the world it lives in.

### (2) Capture demo (TEST-ONLY)
Add both words to the natural command above:
```bash
--capture-demo capture-demo-v1 --demo-scale 20
```
- The launcher refuses the demo words on anything but a natural world with `--march-trial`. It also refuses them if
  the runner's first line does not state the same demo.
- The page address gets `demo=capture` from the launcher only.

### (3) Two people in one world (TEST-ONLY contest pair)
Add one more word to the capture demo command above (it is refused without the demo):
```bash
--contest-pair contest-pair-v1
```
- **Who plays:** two people, each in their **own browser tab** (or own browser), each with its own memory-only key.
  The second side is a person, not a program: there is **no automatic opponent** and nothing here is an AI.
- **Starting:** both open `http://localhost:41920/` and press 「新しい世界を開始」. The first tab says it is waiting for
  the other player and sends nothing. When a **different** tab (another key) presses start, the launcher starts **one**
  world for both. Press the second start soon: the first tab waits only within its own start time limit.
  A third tab is refused while the pair's world runs. The pair uses both of the launcher's two world slots.
- **Each side's relay:** each tab sends through its own relay, which accepts only that tab's own address.
- **Which nation the second player chooses:** the demo picks a fort of another nation that the first player can reach,
  and a home site of that fort's nation from which the second player can reach the same fort. After the first player
  has placed their village, the second player presses 「二人の対戦の国と砦を確認」 on the page's standing notice. The page
  names the fort and the nation to choose to defend it, and the standard village candidate. The choice stays the
  player's: the page chooses nothing and sends nothing. After the second player's village is placed, the same key says
  whether both routes were checked on the world's own records (and names the real village), or that this world could
  not set the contest up (then end it and start a new world).
  - The page shows this only for the second player of a pair, only for the world it started in, and only before that
    world's end. Any other answer is not shown.
- **Defending:** the fort's own nation sees its fort as 「守りに向かう」 while another nation is counting on it: in the
  host's fort list (「砦へ進軍」 on the host's bar), and in 「国と領土」 under its own heading
  「他国が占拠を進めている、あなたの国の砦」, apart from the other nations' forts. A host of the holding nation that stays
  on the fort's tile breaks the count (the program's own rule).
- **Ending:** one Ctrl-C (or the end of the world's time) ends the world for **both**. Each person then closes their own
  tab, which discards that tab's key. A page whose world the launcher has ended says so once its next read of the
  world fails and the launcher (still running) answers that it no longer runs that world: the turn dial stands at the
  last turn the world reported (「ターン N · 終了済み」) and the banner reads 「このテスト用の世界は終了しました（…）。…」 (a kept
  world, `--persist`: 「ターン N · 一時停止」 and 「この世界は止まっています。進行は保存されています。…」). If the launcher
  itself is gone (Ctrl-C), the page cannot confirm the end and says only that it cannot connect. After a confirmed end
  the far-village card no longer raises its own "could not be read (network)" with a Retry; a panel that reads
  something else of the world may still say that its own read failed. Use `--world-ttl-minutes 45` for a short trial.
- **What is not natural:** the clock is the demo's compressed clock and the other villages are test participants, as
  in (2). At ×30 a turn is 20 s, so the 72-turn hold takes 24 minutes: it fits a 45-minute world only when the hold
  starts early (a trial on 2026-11-14 completed the capture at turn 84 after a hold that began at turn 13).

### (4) A long test world: compact herald output (TEST-ONLY)
A capture, the 288 turns in which a taken fort cannot be counted against, and a recapture need about 446 turns. At ×60
(a turn is 10 s) that is about 75 minutes, and the herald's output grows with every turn. Add to the capture demo
command (refused without the demo):
```bash
--herald-output compact-v1 --world-ttl-minutes 90
```
- **What changes:** each new world's herald keeps only the compressed `.gz` of each output file. Every file of every turn
  is still kept, and is served as before (decompressed for a client that does not accept gzip).
- **What does not change:** the game's rules (72 turns to take, 288 turns of protection), the launcher's 128 MiB output
  limit and its disk floor. A world that reaches either is stopped as before.
- **The herald must support it:** build it from this guide's commit or later. A world whose herald did not record the
  mode is never handed over (`HeraldOutputNotCompact`); an older herald is refused, not used.
- **Measure first:** before a long world, run a short one with the same options and check that its output stays well
  under the limit for the turns you plan.
- **`--herald-output compact-v2` (TEST-ONLY):** the same as `compact-v1`, and the herald's own transaction store (its
  archive and index) is kept gzip-compressed too. Every record is kept and read back byte for byte. In a two-person world
  the store, not the output files, was most of the growth (about 0.4 MiB per turn at ×30). On that world's data, gzip
  made the store about a sixth of its size. This has not been measured in a running world yet: measure first, as above.
  A world started with one word is never reopened with another word, or without it.

### (5) A world that does not end, and that survives a stop and a reload (TEST-ONLY, NOT FOR PRODUCTION)
Add one or both words to the natural command of (1). Both are refused with the capture demo (its compressed clock
cannot be resumed) and off the natural preset:
```bash
--continuous local-continuous-v1 --persist local-persist-v1
```
- **`--continuous local-continuous-v1`:** the world's Season is the program's continuous preset `S1_LOCAL_CONTINUOUS`
  (the same parameters as `S1_LOCAL_7D`, no end bell, joins always open, `EndSeason` refused by the program). The page
  shows that the world does not end. The launcher's own limits (`--world-ttl-minutes`, output, disk) still stop the
  world's processes.
- **`--persist local-persist-v1`:** each player's world lives in `DATA/persist/<the page's public address>/`, a private
  directory (0700):
  - `run/`: the chain's ledger and its last two snapshots, `world.json`, and the world's two operator keys
    (`keys/upgrade.seed`, `keys/payer.seed`: TEST keys of this disposable chain, files 0600 in 0700 directories);
  - `herald/`: the herald's checkpoint and archive;
  - `starts/<n>/`: the logs of each start.
- **A stop keeps it:** Ctrl-C, the end of the world's time, or the page's end of a world stops the processes and keeps
  the directory. The next start for the same address **resumes** the world: the runner re-opens its chain from the
  ledger (every re-executed transaction must repeat its recorded outcome). It refuses another address, another artefact
  (`--artifact-sha`), the other `--continuous` choice, a missing ledger, a symbolic link, and a key file or directory
  that another user may read (mode looser than 0600/0700). The world's clock stands still while it is stopped.
- **The page keeps its key:** the page is addressed with `persist=local`. Only then it keeps its test key in this
  browser's IndexedDB as a **non-extractable** WebCrypto Ed25519 key (`extractable = false`: no script can read or
  export it, but a script of the page can sign with it while the page is open), and its march book (the sealed
  marches' reveal halves) encrypted with a non-extractable AES-GCM key. A reload, or closing and reopening the
  browser, returns to the same address, world and village. The panel's 「このブラウザに保存した試験用の鍵を消す」
  [Delete the test key kept in this browser] deletes it; the world's directory stays with the launcher until you
  delete it yourself (the launcher never deletes anything).
- **With `--operator-residents <n>`:** the residents' TEST keys are kept in `operator-keys/` (0700, one 0600 file each) of
  the same directory, so a resumed world has the same residents and villages (without `--persist` they stay memory-only).
- **What is private:** the wallet's directory, `run/`, `keys/`, `operator-keys/` and `starts/` are 0700, and the key files
  are 0600. The herald's records, the ledger, the snapshots and the logs keep their default modes (0755/0644): they are no
  keys, and they sit inside the 0700 wallet directory.
- **Not for production:** a key a page script can use is acceptable only for a disposable local test chain. Never use
  this with a key of any public cluster.
- **Checked (2026-11-18, ws08-p1p2):** start, Join and PlaceHome, a reload (the same village), Ctrl-C of the launcher,
  a new launcher, the same browser profile: the world resumed with the same village, and a build signed by the kept key
  landed on the resumed chain. Disk: a continuous world's ledger grows with every turn; the launcher's 128 MiB output
  limit counts the whole directory and stops the world when it is reached.

### (6) Operator AI residents, the six-nation recording and the co-op board (TEST-ONLY)
Natural preset only, and never set over HTTP. Add one of these (and, separately, the co-op board below):
```bash
--operator-residents 3                 # 1-4 residents; their nations are fixed: 1, 4, 2, 5
--operator-nations 1,4,2,5,0,3         # one resident per named nation, up to six (6 relay ports per world); not with --persist
--operator-max-acts 400                # optional: a cap on each resident's sends for the whole world (default: none)
```
Each resident is an ordinary participant. It has a memory-only TEST key (kept on disk only in a `--persist` world,
§3 (5)), is funded like the player, and has its own relay. It joins, places a home and uses the economy commands by a fixed offline rule
(`permutation-gateway/src/frontier/local-play-operator-policy.mjs`). It never marches (except in the war world of (7)). The page is not told which
residents are AI. `scripts/demo/sixnation/sixnation.sh` starts a world with all six nations and records it
(see its README, EN and 日本語). With the capture demo, let the residents place their homes before the player does:
afterwards a PlaceHome in the player's own nation was refused (`TicketState`, 45) in a trial on 2026-11-18.
So with these options the world is **not** "no automatic opponent, nothing here is an AI" (contrast §3 (3)). Their
roster is `operators.json` and their log `operators.out` in the world's directory.
- **Pace:** each resident takes at most **one action per bell** (owner decision Q16-2: one action per resident per
  turn; the bell is the program's own, counted from the Season's genesis on the chain's clock), with no cap for the
  whole world, so residents keep playing until the world ends. On a ×10 two-hour test world (about 120 bells) that is
  at most about 120 actions per resident; on 1× (12 bells) at most 12. A resident stops for good only after 12 refusals
  in a row. Its log says a wait once, not every round. (Before 2026-11-18 the budget was 60 actions per world, spent in
  about 20 turns: loop-play2 B12.)
```bash
--coop-board ws01-board-v1                         # ① the co-op board of each world
```
- **Co-op board** (`--coop-board ws01-board-v1`): workstream 01's board of requests between nations, for each world. The
  launcher keeps it in its own process (records in the world's directory, `coop/`) and serves it on its own origin under
  `/coop-world/<the world's proxy port>/`. The village card's co-op slot then opens 「国をまたぐ依頼を開く」 in a new
  tab. That tab is offered **"Local Play Wallet (memory only) — co-op records only"**: the game tab's own key, which
  there signs only ①'s board records (never a transaction). Choose it, press connect, and file or answer a request.
  - Keep the game tab open: the board tab signs through it. Reloading the game tab makes a new key (as always in local
    play), which is a different person to the board.
  - Not in local play: sending a caravan from the board's page (the launcher passes no relay route there, and the board
    page shows no send button). Requests and answers are records only; a caravan is sent from the village card.

### (7) Operator AI residents at war (TEST-ONLY, owner t359u 2026-11-19)
Add to the capture demo command (both words are refused without `--operator-residents` and the capture demo):
```bash
--operator-residents 12 --operator-war operator-war-v1 --demo-scale 15
```
- **Who:** up to 12 operator AI residents (⑤ A): two per nation, every nation from six on (residents 0–3 join Borealis,
  Ember, Cinder and Fjordal as before; 4 and 5 add Aster and Dunmar). 5–12 residents are accepted only with this word.
  Each one has its own memory-only TEST key, its own relay and the player's funding, as in ⑤ A.
- **What they do:** the war rule (`permutation-gateway/src/frontier/local-play-operator-war.mjs`), ONE action per
  resident per turn (Q16-2). In order: defend an own keep another nation is counting on; attack a reachable keep of
  another nation with at least 1.5× its garrison; muster the reserve once it holds 300 troops; train; otherwise the
  economy (Harvest, Build). The home is placed on the outermost heartland ring. No randomness: a run depends only on
  the world.
- **Same path as a person:** the page's own reads (herald client), keeps (control snapshot + ring overviews), target
  finder (`fkeepreach.mjs`), route planner, timelock seal and local march sender (`fmarch.mjs` + `flocalplay-march.mjs`)
  to the resident's own relay. The march opens only when that relay answers the page's capability read with the
  TEST-ONLY trial. While the village's province has not settled the turn, the resident holds its turn, as the page's
  muster card waits.
- **What the world adds (runner `--operator-villages`):** the keeper reveals and settles marches only for the villages
  it serves, so it also serves each resident's village once that village's PlaceHome has landed (as for the pair's
  second player). The demo's new ring is opened whole, by the program's own OpenProvince (simulated first), so every
  nation has border keeps to contest. No rule, parameter, turn length or keep timer changes.
- **Siege and capture here** are the keep contest of the rules: a host of one hostile nation on a keep's tile counts one
  turn per resolved turn, a defender on the tile breaks the count, and at 72 the keep is taken (then 288 turns of
  protection). A village siege (DeclareSiege) has no local-play route; the residents never ask for one.
- **Pace:** use ×15 (a turn is 40 s). At ×60 (10 s) and at ×30 (20 s) the keeper (13 villages) missed reveal
  windows (village keepers stopped their destination driver) and the herald's control snapshot fell 14–49 turns behind
  in a 12-resident world (ws05-ai-war trials 2–5, 2026-11-19).
- **Ports:** with 12 residents each world slot keeps 12 relay ports, so the launcher spans `--world-port` + 33
  (for example 41404–41437).

### Then
The page follows the browser's language; the top-right button switches Japanese ⇄ English. English labels in brackets
(as the page showed them on 2026-11-15).
1. Open `http://localhost:41920/` and press 「新しい世界を開始」 [Start a new world]. A contest pair starts only when a
   second tab presses it too (§3 (3)).
2. Choose a nation [Choose a nation → Join <nation>]. The first village is placed for you.
3. Build, train (訓練) [Train], then muster (編成) [Form a host]. The army can act once the keeper has resolved the turn,
   about 17 minutes later at 1×. While the province is still resolving the last turn, the muster card's one press is
   held and sent once it can be.
4. Use 進軍 [March] (or [March on a keep] on the demo) to choose a destination, then press the order card's send button
   [Send this order]. The keeper settles the march by itself. In local play, while the province is still resolving the
   last turn, the press waits [Waiting to send]; if the order changes meanwhile (its arrival turn moves), the wait is
   cancelled and nothing is sent: check the card and press again.
5. On the demo only: once the next ring is open, the guide offers 「届く砦を見る」 and the fort list 「届く砦」.
   A march onto a fort starts its hold count, 「…争奪中 N/72ターン」.
6. To stop, press Ctrl-C in the launcher's terminal. It ends every world of that launcher.
7. (With `--persist`, §3 (5), the key is KEPT in this browser across tab and browser close until the panel's delete
   key; the rest of this step is for the memory-only key.) Then close that world's browser tab. Ctrl-C alone does not remove the page's memory-only key from the browser;
   closing the tab discards it. Close only the tab you opened for this world and leave every other tab alone. A key
   in a tab left open is gone only when that tab closes, and that cannot be confirmed from outside it.

## 4. What is done, and what is not
- **Natural world, on screen:** nation, home, economy, army, the ordinary march sent by the page's own key, and its
  settlement.
- **Natural world, by the rules:** no area expansion or capture.
  - A ring past the heartland opens only at θ occupancy of one wedge, which one player cannot reach alone.
  - Every keep inside a heartland is safe and never counts.
- **Capture demo, on screen (×20):** the next ring opened; the fort list showed two forts; a march reached a fort and
  started its hold count.
  - **At ×20 the 72-turn capture was not completed on screen** (it was at ×30 in a two-person world: below).
  - **First run (2026-11-13):** while a fort is contested, each of its turns needs three keeper steps, and the keeper
    took one step per 10-second tick, so the hold advanced about one turn per minute. At that rate 72 turns could not
    fit in the world's 45-minute limit. So the world was stopped by hand (Ctrl-C) about 17 minutes after it started,
    at 4/72. It did not reach its limit.
  - **Second run (2026-11-14), with the demo pace:** on a demo world only, the keeper's next tick comes after 1 s while
    its steps land (at most 8 in a row); a natural world ticks as before. The fort's turns then resolved every 29.9 s
    on average, the ×20 clock's own rate. The hold started at turn 14. When the world reached its 45-minute limit
    (not extended), the chain's hold count was **71/72**, one turn short, and the world ended by itself. The page
    showed 65/72 at that moment and said its display was 180 seconds behind.
  - At ×20, a hold that starts at turn 14 cannot reach 72 inside 45 minutes, even at the clock's own rate.
  - **Third run (×30, 2026-11-14):** stopped by hand early, with no capture possible: both forts the demo opened then
    belonged to the player's own nation. Since then the demo opens a fort of **another** nation that the player's home
    can reach by a legal route (at most 4 provinces and 32 steps, checked on the chain's records), or says it is not
    ready and why.
- **Two people in one world (×30, 2026-11-14):** both tabs got one world with the same end time and each its own relay.
  The first player's host reached another nation's fort and its count started (turn 46). The defender (the second
  player) marched onto the fort's tile and the count was broken (turn 57); both pages said so. One host of the first
  player then departed and arrived twice. No retake was tried there.
- **Capture on screen (×30, two people, 2026-11-14):** the first player's host held another nation's fort from turn 13;
  at turn 84 the fort passed to the first player's nation. Both pages said so, the province took the new holder's colour
  and both pages' province counts changed. The second player did not defend. No retake was tried: after a capture the
  fort cannot be counted against for 288 turns (about 48 minutes at ×60, 96 at ×30).
- **Page display on local play:** a page that is shown again after being hidden reads the latest state at once
  (checked in a real browser, 2026-11-14, for the play read). The season read that moves the page's clock is now woken
  the same way and by the re-read button; that part is proven by tests only, not yet in a real browser. When the view is behind, the banner on local play says not to reload
  (that would lose the world's key) and offers 「最新の状態を読み直す」, which only reads.
- **One player, the same host twice, then a capture (2026-11-15; OLD binaries, not a build of this page's commit):**
  live32 (×10, natural preset + demo + pair, page of 427c4963): one host marched, arrived, recovered to 74 stamina and
  marched again (the same host id on both legs, read from the herald's records). live33 (×30, page of 2cd30f23): one host
  marched to a plain tile, arrived, recovered, marched onto another nation's fort and held it 72 turns; at turn 141 the
  fort passed to the player's nation. Both used binaries built 2026-11-14 from a snapshot tree (the herald's sources
  differ from this branch's commit); the second tab only pressed start. A build of the current commit has not run a world.
- **What one ordinary player can do, by the rules:** in a natural world (1), alone: home, economy, army and ordinary
  marches, but **no area expansion or capture** (see above). Taking another nation's fort on screen needs the capture
  demo (2) or (3): TEST-ONLY, compressed clock, test participants.
- **The retake** (after the 288 protected turns) is proven only by the in-process tests on the real program, on a
  compressed clock. It is not proven through the page.
- **Not run:** a build and start from a fresh clone on another machine; any world on binaries built from this branch's
  current commit (the worlds above used earlier builds).
- **Not checked here:** the runner crate's `localnet-conquest-play` feature set (the contest pair does not need it), and
  the wide-world experimental features.
