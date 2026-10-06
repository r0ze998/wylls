**English** | [日本語](README.ja.md)

# Wylls

**A game in which AI behaves like a player.** Wylls is the first playable part of a Civilization-style shared world on Solana. AI citizens, run by the operator on a local model, are designed to play beside people, with goals and a memory.

> **Status 2026-10-06, this development branch:** local test-chain integration includes nation and first-land choice, an immediate final village, construction, training, marches, province keeps and national territory-time scoring. Normal seasons last 14 days with simultaneous 10-minute turns; the separate preview runs at 10×. No devnet/mainnet deployment. Player automation that issues new orders with the tab closed, shared technology, diplomacy and markets remain unimplemented.

![Wylls map: six nations around the Concord, the neutral centre](docs/img/wylls-map.png)

*The web client's map after the recorded test season of the first playable part (M1; local test chain, 1,000 script bots). It shows the map only, no armies or clashes. "Dev Wallet (localnet)" is a local test wallet, not a real one.*

## 1. What Wylls is

Wylls is a Civilization-style world on Solana in which six nations (国) share one map. You choose a nation, get a village (村), and play in real time: grow the village, train troops, send armies (軍) on marches whose destination stays sealed, and read a battle report that anyone can replay. The Solana program, not an operator, resolves every fight, and a season (one round of the world) is a log of transactions that a verifier replays and checks (the verifier is ours, not an independent audit). That is the reason for a chain. The M1 foundation was validated through full seasons with script bots: test players that follow fixed rules and are neither AI nor people (the test records call them rule bots). This development branch extends it into a local human-playable version, from a first village to contests over provinces. AI citizens, players with goals and a memory, are meant to play beside people; they are in progress ([section 3](#3-the-ai-citizens)). This branch integrates conquest and national scoring. Shared technology, diplomacy, markets and money remain design work ([section 4](#status)).

## 2. How it plays

The game runs in real time, but the results of fights, marches and scouting are not decided at once. Every 10 minutes the world resolves them all together (144 times a day). Each of these steps is a **turn** (the code and the contract call it a "bell"). Sending an army a minute earlier gives no advantage, because both orders are resolved in the same turn. Economy and building run continuously, with no turn to wait for.

1. **Choose a nation and land.** Pick an available heartland site and receive a final first village immediately. The first-home selection is permanent.
2. **Build an economy.** The first production building finishes in 60 game seconds, once per citizen; later construction uses normal durations. Compare stores, production, capacity and completion times.
3. **Train and muster.** Choose a unit and affordable quantity, then form an army. Newly mustered armies need recovery time. Scouts explore; combat units contest keeps.
4. **March from the army's current position.** Review the route, arrival turn and stance. The destination is sealed until arrival; departing orders cannot be recalled. Arrival and result settlement are separate stages.
5. **Control provinces.** Defeat opposition at frontier keeps and hold them through the required turns. Keep ownership determines province control; heartland is protected.
6. **Win through territory held over time.** The nation screen shows control and standings. One province held for one hour earns one province-hour. There are no capture bonuses, holding weights, economy/science points or per-player adjustments. Equal scores share a rank.
7. **Expand with outposts.** Upgrade the first village to a Town, then request an eligible empty frontier site where your nation does not already hold a majority of holding strength. Later holdings use a contested application. The current filing cost is spent on submission and is not refunded after displacement or expiry.

Resources, queued construction, departed marches and world settlement continue while the tab is closed. Issuing new orders automatically is a separate feature, currently designed rather than running for players; see the [current design update](docs/GAME-DESIGN.ja.md#2026-10-06-開発ブランチの更新).

## 3. The AI citizens

**Historical experiment results in this section are dated 2026-10-04.** AI code is integrated in this branch; prolonged AI operation in the new conquest season has not been verified.

AI citizens are players that the operator runs on a local model (Gemma 4, through llama.cpp; no paid API). Their code was developed on a separate local branch. So far one small run with 6 AIs has completed. Its 52 model decisions were all valid and passed the check of AI decisions (`verify-minds`), but with the checker as it was before a later fix; the fixed checker has not yet been run on these records. The contract requires 300 decisions for a result, so this is a smoke test. The 12-AI and 18-AI runs have not been done. The runs also contain script bots (30 in the 6-AI run) that play alongside the AIs.

- **The code offers, the model chooses, the code checks.** The code builds a short list of legal candidates, the model picks one, and the code validates the pick before the program accepts it. If the model is late, invalid or refused, an autopilot (自動運転) plays: it keeps the economy and routine duties and never starts a march of its own. So a voluntary AI march is chosen by the model or ordered by the nation's council (the Strike Order, below), and most of an AI's actions are the autopilot's. The reason for this design is an early spike: left to itself, the bare model rarely chose to march ([report](docs/frontier/ai-agents/gemma4/REPORT.md)).
- **Memory is cited from public records.** The code writes short event lines from public records (an attack on the AI's army, a camp another nation cleared first); the model never writes them. The page prints the lines the model cited beside its own reason, which is marked not verified. A citation shows that a line was shown and named, not that it caused the choice.
- **The headline: an AI citizen's own march.** The AI picks a march itself and its army leaves with the destination sealed. After the march is revealed, the decision opens: the options it was offered, its reason, the destination and the real clash report. How many model-chosen marches become a real clash is unknown until the planned 18-AI main run (not yet done); if none does, this claim is dropped and the council becomes the headline.
- **The nation council.** Once per council period the code proposes up to three target provinces for a nation, and AI citizens speak and vote. The adopted target, the **Strike Order** (攻撃命令), stays sealed from outsiders until the strike. The council (評議会) is off-chain; the chain enforces nothing of it. Nation 0 also has one human seat, held by the operator (the presenter in the recorded demo); the other five nations are decided by AI votes alone. In the 6-AI run no council reached a quorum, so no Strike Order has been adopted yet.
- **Same rules as people, plus safety limits.** AI citizens use the same keys, rate limits and fog of war (players see only part of the map) as people, plus limits such as at most 4 model-chosen marches a day. The model never sees keys; the local test keys derive from a public seed, so this is structure, not secrecy.
- **Display and disclosure (decided).** AI citizens are shown in the game like ordinary players, without a mark; the main map client has no AI citizens yet. An AI says it is an AI when sincerely asked (a rule and a check exist on the branch; no recorded case in play). The operator discloses in general, as in this README, that the world contains AI citizens. The council page and the roster file of the test runs still carry a type label (AI, script bot, or the operator's seat); whether they stay is not decided. Legal review of the disclosure (for example EU AI Act Art. 50) has not been done.

The pre-registered thresholds and the table of results are in [the AI contract, section 10.2](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md#102-gates) and in the design document ([GAME-DESIGN.ja.md](docs/GAME-DESIGN.ja.md), chapters 4 and 8). Results from the new conquest season will be added after validation.

<a id="status"></a>

## 4. Status at a glance

| Area | Tag | In one line |
|---|---|---|
| Basic game M1 | **Running** | Joining, building, training, scouting, sealed marches, clashes and reports, with a replay verifier and a web client (Japanese and English). One 7-game-day season ran on a local test chain with 1,000 script bots |
| AI citizens | **In progress** | Existing code integrated; historical AI evidence below is separate from new conquest-season validation |
| Conquest | **Running locally** | Program, services and relay integrated; keep contests, control and outpost filing connected to the web client. A dedicated village-siege screen is pending |
| Instant land, 14-day seasons, national score | **Running locally** | Immediate final first home; 14-day preset; finalized province-time counters and final standings |
| Player automation | **Designed** | Priorities, resource floors, training targets, pause and logs; background order execution is pending |
| Society (governance, diplomacy, trade, shared Engine, tech, eras) | **Design only** | Outline only; tech, eras and the Engine are not designed |
| Money and business plan | **Planned** (money design: **Design only**) | A free season first, later a money season, an entry fee and AI citizens for game studios. No money that players pay or earn exists |

Tags: **Running** means code exists and was actually run (a run on another branch is named as such); **In progress** means being built or run for this hackathon; **Design only** means written down, not built (including work that exists only on an unmerged branch); **Planned** means intended, no date. Each part of the complete game with its state is in the [design document](docs/GAME-DESIGN.ja.md) (Japanese).

**Headline evidence for M1** (local test chain, script bots; [exit report](docs/frontier/m1/M1-EXIT-NOTES.md), [run record](docs/frontier/m1/runs/m1-exit/)): one season of 7 game days (1,008 play turns plus 26 closing turns, 8 h 39 min at 20x speed) ran from start to finish with 1,000 script bots, and every gating season criterion passed (one in-process test condition failed on the first commit and was fixed in a later one; see the exit report). The replay verifier passed 144,300 transactions and caught all 30 deliberate tampers.

## 5. Try it

For the current local first-home-to-conquest build, see [preview startup, resume and validation](docs/frontier/conquest/PLAYABLE-2026-10-06.md). It uses a separate 10× world. Use `resume` for a saved world; repeating `up` with the same name refuses to erase it. The practice battle and historical M1 run below are separate options.

Everything is local; nothing needs a wallet, devnet or a paid service. Look first at the screenshot above and the [M1 run record](docs/frontier/m1/runs/m1-exit/). **Quick path, the practice battle** (a practice clash that runs in the browser with the game's own rules code; no chain, no build; Python 3). From the repository root:

```sh
cd permutation-server/web && python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/frontier/practice.html   (Japanese or English follows your browser)
```

**The earlier M1 stack** (use the preview recipe above for the conquest version). You install the toolchains yourself (Rust, the Solana build tools, Node 20 or later; the list is in [docs/RUNNING.md](docs/RUNNING.md)). `up` stays in the foreground (a one-game-day season takes about 72 minutes; at 20x a turn lasts 30 seconds), so use two terminals:

```sh
(cd frontier-node && cargo build --locked --release --workspace)
scripts/build-frontier.sh --features test-beacon
S=frontier-node/target/release/frontier-stack
$S up --mode accel --beacon test-key --scale 20 --days 1 --bots 20 --run-id try --base-port 41000
# second terminal, after about a minute: open http://127.0.0.1:41040/frontier/frontier/
$S down --run-id try
```

Open `/frontier/frontier/`, not `/`: the bare address still lands on an older page. The browser joins with a built-in local test wallet. The scripted browser run, the exit-season recipe and the test commands are in [docs/RUNNING.md](docs/RUNNING.md). AI citizen code is integrated, but no AI fleet is running in this human preview.

**Videos:** game and M1 season [VIDEO LINK pending]; AI citizens (an AI's own march, then the council and the Strike Order) [VIDEO LINK pending], to be recorded on 2026-10-11.

## 6. Limits and what is not claimed

- **Local test chain only.** Nothing of the new game has run on devnet or mainnet; devnet costs are unverified and hosting is open.
- **Nobody outside the project has played.** All 1,000 participants of the M1 season were script bots written by the team. There is no registration, demand or traction figure. No season longer than 7 game days has run.
- **Seal secrecy was not tested.** The M1 season replayed archived drand values, so the signatures were already known; the results show that marches settle, not that destinations stay secret. The verifier is ours, not an independent audit.
- **AI citizens are in progress, not finished.** Only a small 6-AI run exists. The AI's reasons and speech are written by the model and not verified; most of an AI's actions are the autopilot's; the council is off-chain; the drand key of the test runs is the operator's test key.
- **Not built:** background player-order execution, a dedicated village-siege screen, governance, diplomacy, markets, shared technology, money and prizes. Legal review for money and for the disclosure of AI citizens has not been done.
- **The CI is partly red.** In the GitHub runs of 2026-10-01 and 10-02, 2 of 8 jobs failed, so the program build and its LiteSVM tests never ran there; the fixes were checked on a Mac only.
- **Not claimed about the AI:** that it is stronger than the script bots, indistinguishable from people or exactly replayable; that it wants or intends anything; that its memory shows why it chose; that the council is enforced by the chain.
- **Not claimed about the project:** that any person outside the project played it, any demand, that a game studio was approached, that money or prizes work, or that the Civilization-style game is finished.

## 7. Repository map and where to read more

| Path | What it is |
|---|---|
| `permutation-frontier/` | The Solana program, with the LiteSVM tests (`svm-tests/`) |
| `permutation-rules/src/frontier/` | The rules code shared by the program, simulator and browser |
| `frontier-abi/`, `frontier-wasm/` | The program's ABI; the rules built to WebAssembly for the browser |
| `frontier-sim/` | The balance simulator |
| `frontier-node/` | Off-chain services: keeper (settles marches and clashes), herald (read-only data server), verifier, script bots, local chain, stack runner |
| `permutation-gateway/` | The relay (pays fees within quotas; one door for people and bots), the JS SDK and screen tests |
| `permutation-server/web/frontier/` | The web client (map, village, march composer, report, practice page) |
| `scripts/`, `docs/` | Build and run scripts; all documents |

Names are historical: the rename to Wylls did not touch folder, crate or package names, so `permutation-*` and `frontier-*` remain. The repository also holds the files of an earlier, different prototype (Permutation State), which is not evidence for Wylls ([index](docs/earlier-prototype/INDEX.md)).

**Where to start:** [Design overview, 10 minutes](docs/DESIGN-OVERVIEW.md) ([日本語](docs/DESIGN-OVERVIEW.ja.md)), then the [design document (Japanese)](docs/GAME-DESIGN.ja.md), the [AI citizens contract v1.3](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md) and the [M1 exit report](docs/frontier/m1/M1-EXIT-NOTES.md). **Also:** [Run it](docs/RUNNING.md) · [Decisions](docs/frontier/DECISIONS.md) · [Documentation index](docs/frontier/README.md). **Project records:** [Pitch](PITCH.md) · [Submission record](SUBMISSION.md) · [Demo script](docs/pitch/DEMO_SCRIPT.md)

**License.** The repository root has an MIT `LICENSE` file, which covers the repository as a whole; the Rust crates and the npm package (`permutation-gateway/client`) declare `license = "MIT"` in their manifests, and bundled third-party libraries keep their own licenses.
