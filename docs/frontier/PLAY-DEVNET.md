# Play on devnet (for players, a test)

The playable version of Wylls (villages, marches, keep capture, the wide land) went out on Solana **devnet** on
2026-11-23. **Its world was created on 2026-11-26 and you can join it now** (the title page says “World no. 3”).
Devnet is a test network: the SOL used here has no value and no real money is involved.
Japanese: [PLAY-DEVNET.ja.md](PLAY-DEVNET.ja.md). To play on your own Mac only, see [PLAY-LOCAL.md](PLAY-LOCAL.md).

| | |
|---|---|
| Network | Solana devnet (not mainnet) |
| Program id | `GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr` |
| Can be joined from | **now.** The world was created on 2026-11-26 (12:14 JST), after the rules update of the same day |
| World length | **it does not end** (a continuous world); you can join at any time. One turn is 10 minutes; there is no fast clock |
| Devnet SOL to hold | **about 0.05 SOL**, or **0.1 SOL** if you go to the wide land |

## 1. The page's address

Get the address from the operator's announcement. **The address can change** (today it is a temporary public
entrance, and it gets a new name when the operator reconnects it). If the page stops opening, look for a new
announcement. That is why no address is written in this document.

The address ends with `/frontier/frontier/`. You are in the right place when you see the title and the six nations.

## 2. Set your wallet to devnet

Install a Solana wallet in your browser (Phantom, Solflare, Backpack, …) and switch its network to devnet. The game
page does not show these steps; they are the wallets' own settings:

- Phantom: Settings → Developer Settings → turn on “Testnet Mode” (Solana Devnet)
- Solflare: Settings → Network → switch to “Devnet”
- Backpack: Settings → Solana → RPC Connection → switch to “Devnet”

Left on mainnet, the wallet shows mainnet balances and mainnet confirmations: switch first.
We suggest making a new wallet (account) just for this test.

## 3. Get devnet SOL

Devnet SOL is free from a faucet, for example <https://faucet.solana.com>: choose devnet and enter your wallet's
address. Faucets limit how often they pay and may refuse; wait a while and try again.

- **0.05 SOL** is enough to found a village and march.
- Hold **0.1 SOL** if you will found a village on the wide land and muster a host there.

## 4. What each act costs

On devnet your wallet signs each command once and pays its fees and rent (a deposit for keeping a record) itself.
The page says: “On devnet your wallet signs each command once and pays its fees and rent itself (devnet SOL, of no
value; no in-game key is made).”

| Act | Devnet SOL | What it is |
|---|---|---|
| Join | 0.0026 | the fee and the rent of your resident record |
| First village (a heartland village, or the request for a rim village) | 0.0072 | the fee and the rent of the village's record. The join press sends it right after the Join (§5 step 2), so joining takes 0.0098 in all |
| Harvest, build, train, muster | 0.000005 each | the fee only |
| One march (the march back home counts as one more) | 0.00005 | the fee and the seal's deposit |
| A second or third village | 0.0072 | the fee and the rent of the village's record |
| The request for a village on the wide land | 0.0091 | the fee and the rent of the request's record |
| One expedition from the rim to the wide land | 0.0024 | the fee and the rent of the expedition's record |
| The first muster in a wide-land province | 0.0172 | the rent of that province's roster; every later muster there, by anyone, is the fee only |
| One tile of your own land ([PLAY-LOCAL.md](PLAY-LOCAL.md) §4.1; the tile itself is paid in ore) | 0.000005 | the fee only. More the first time: **0.004064** when nobody has claimed a tile in that province yet (the rent of the province's land record), and **0.00227584** for your first tile ever (the rent of your own land record). Your first tile, in a province nobody has claimed in, is 0.00634484 (0.004064 + 0.00227584 + the fee 0.000005) |

- Each figure was measured on a local chain at devnet's rent rate (5,080 lamports per byte), not on devnet itself.
  If devnet's rent rate changes, the rent parts change with it. On 2026-11-26 a local chain running the devnet
  world's own build charged a new wallet exactly these amounts (join 0.0026, first village 0.0072, first tile
  0.00634484, later tiles 0.000005, a wide-land village 0.0091); the first tile's charge was the page's cost preview
  to the lamport.
- In the dress rehearsal the busiest page spent 0.0173 SOL without the wide land, and 0.0366 SOL with one village on
  the wide land.
- Your wallet's confirmation shows what you pay before you send. Cards such as the expedition's take two presses,
  “Review what will be sent” and then “Sign with the wallet and send”, and show the amount first. A tile claim shows
  its cost in ore and in SOL the same way (“… SOL (from your wallet)”, with “this province's land record … SOL” and
  “your land record … SOL” when they apply), then “Sign and claim”.

## 5. How a game goes

1. Open the page. The title page shows the six nations, the world's number (“World no. 3”) and one button: press
   “Choose a nation” (a wallet that has already joined sees “Back to your village” or “Back to the Frontier”). The nation screen says “To begin, connect a wallet first.” with one button per wallet, named by the wallet (for example
   “Phantom”): press yours. Then press a nation's card and “Join <nation>” (for example “Join Dunmar”).
2. That one press asks your wallet for **two signatures**: first the Join (your resident record, 0.0026 SOL), then
   your first village (a heartland village, or the request for a rim village; its record, 0.0072 SOL). They are two separate commands of the program, and on
   devnet your wallet signs each command itself, so it asks twice. The second comes once the page sees your join,
   which can take tens of seconds (“Waiting for the record…”; no need to press again. If it has not shown after
   180 seconds, press “Check again”; nothing is sent twice).
3. Harvest, build and train in the village, muster a host and march on a keep. The screens work as in the local
   version, so [PLAY-LOCAL.md](PLAY-LOCAL.md) §3 is your guide.

Good to know:

- **Time is real time.** One turn is 10 minutes. A keep is taken by holding it for 72 turns (about 12 hours).
- Every march spends 74 stamina and stamina returns 1 per turn (the cap is 120), so the same host waits about
  28 turns (about 4 hours 40 minutes) before its next march.
- For the first while, first villages are placed in the heartland. A rim village can be requested once the map has
  grown out to the rim (about 21 hours after the world starts, under today's settings). Wide-land requests come
  after that.
- A second village or a wide-land village takes a day or more of harvests (a second village, on the wide land:
  food 800, wood 800, stone 400, gold 200).
- **Your own land** (tile claims from the village screen, paid in ore, with land upkeep in food) follows
  [PLAY-LOCAL.md](PLAY-LOCAL.md) §4.1. In real time: when the first village's food cannot pay a turn's land upkeep, the
  food it holds is taken and the land is unpaid; no tile can be claimed; after 24 unpaid turns (4 hours) the farthest
  tile goes back, one every turn (10 minutes), until the village pays a whole turn again (owner decision Q-LP17-1 (b),
  2026-11-25; the devnet world has had this rule from its start: the program was updated on 2026-11-26 before the
  world was created).
- **A new village is “Provisional” at first** (shown beside its name). While it is, “Claim a tile” still shows its cost
  and “Sign and claim”, but the claim is then refused with “The village is not confirmed yet.” (nothing is sent and
  nothing is paid). The program confirms the village on your own next act there once its turn's villages are placed:
  in the local run of 2026-11-26 one “Harvest” did it at once (“The hamlet of … is now confirmed”). The page does not
  say this, so harvest once before you claim your first tile.
- Your land line (“Your land: tiles owned: …”) is read every 60 seconds on devnet, and once right after a claim. That
  read can come before the world's record has the claim, so the count can stay at the old number for up to a minute.
- **One row of [PLAY-LOCAL.md](PLAY-LOCAL.md) §4.1 is not on the devnet page:** once you have a village on the wide
  land, the local page keeps that province on the card as “your village stands here” with “Claim a tile”. The devnet
  page leaves that row out today: once your wide village stands, its province has no row at all, so no more tiles of
  that province can be claimed from the page (other provinces' rows work as usual).
- Marching from a wide-land village to other wide land (taking a wide-land keep) is closed on devnet, and there are
  no AI residents. The differences from the local version are in the table of [PLAY-LOCAL.md](PLAY-LOCAL.md) §7.
- The 7-day world announced on 2026-11-23 was cancelled (2026-11-24) and never created. The world does not end
  (decision of 2026-11-23): the devnet world is one continuous world. Its creation, first planned for 2026-11-25, waited
  for the rules update (decision of 2026-11-24); it was created on 2026-11-26.
- **There is no winning or losing yet.** After a keep is taken the guide says “This world goes on; war-period winners and counts
  are not decided yet.” The direction decided after that text was written (2026-11-24)
  is that “world goals” are always posted in the world (holding flag keeps for 24 hours, and others) and a nation that
  achieves one receives a prize. That is a plan and is not built: the devnet world has no prize.
  The design record is [design 01](../design/win-conditions/01-proposal.ja.md) (Japanese).
- **World goals on the page (decision of 2026-11-26).** “Nation & territory” has a “World goals” card. Until the
  goals are judged it says “Planned — not judged yet” and names the goal: capture a neutral keep or a Free City in the
  wide land and hold it for 144 turns (24 hours). Free Cities cannot be taken yet in this world (the
  devnet program has no Free City conquest), and the card says so. The judging is planned to run off chain (no money, nothing written
  to the chain) from what the chain already records about each keep, including since when it has been held. When it
  runs, the card says “Being judged” and shows your nation's flag keeps, the flag keeps in sight, and how many each
  nation took or holds. No money is paid for a goal.

## 6. When something goes wrong

| What happens | What to do |
|---|---|
| The page does not open | The address may have changed. Look for the operator's new announcement (§1) |
| “The world is not open yet. …” | The page cannot find a world record. The devnet world exists since 2026-11-26, so this shows only if the world is being started over (see the last line of this guide). There is nothing to do: the line says when it opens (“It opens on or after …”, in your own time zone) or “It opens soon”, and the page shows the world automatically once it opens. You do not need to reload |
| “No wallet found. …” | Install a wallet, then reload the page |
| The wallet shows a balance of 0, or its confirmation shows mainnet amounts | The wallet is not on devnet (§2) |
| The wallet or the page refuses for lack of balance | Add devnet SOL (§3) |
| “Waiting for the record…” goes on | Wait. “Check again” appears after 180 seconds (§5 step 2) |

This is a test. The world may stop or be started over part-way. Devnet records and devnet SOL have no value.
