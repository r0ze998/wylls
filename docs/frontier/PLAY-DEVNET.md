# Play on devnet (for players, a test)

The playable version of Wylls (villages, marches, keep capture, the wide land) went out on Solana **devnet** on
2026-11-23. **The world is not created yet, so nobody can join today**; the date will be announced.
Devnet is a test network: the SOL used here has no value and no real money is involved.
Japanese: [PLAY-DEVNET.ja.md](PLAY-DEVNET.ja.md). To play on your own Mac only, see [PLAY-LOCAL.md](PLAY-LOCAL.md).

| | |
|---|---|
| Network | Solana devnet (not mainnet) |
| Program id | `GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr` |
| Can be joined from | **not yet: the world is not created.** The date will be announced (the creation planned for 2026-11-25 was postponed on 2026-11-24; the world is created after a rules update) |
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
| First village (a heartland village, or the request for a rim village) | 0.0072 | the fee and the rent of the village's record |
| Harvest, build, train, muster | 0.000005 each | the fee only |
| One march (the march back home counts as one more) | 0.00005 | the fee and the seal's deposit |
| A second or third village | 0.0072 | the fee and the rent of the village's record |
| The request for a village on the wide land | 0.0091 | the fee and the rent of the request's record |
| One expedition from the rim to the wide land | 0.0024 | the fee and the rent of the expedition's record |
| The first muster in a wide-land province | 0.0172 | the rent of that province's roster; every later muster there, by anyone, is the fee only |

- Each figure was measured on a local chain at devnet's rent rate (5,080 lamports per byte), not on devnet itself.
  If devnet's rent rate changes, the rent parts change with it.
- In the dress rehearsal the busiest page spent 0.0173 SOL without the wide land, and 0.0366 SOL with one village on
  the wide land.
- Your wallet's confirmation shows what you pay before you send. Cards such as the expedition's take two presses,
  “Review what will be sent” and then “Sign with the wallet and send”, and show the amount first.

## 5. How a game goes

1. Open the page, press “Enter the Frontier”, then “Connect a wallet”. Choose a nation and join (one signature).
2. Your first village comes next. It can take tens of seconds for your join to show on the page
   (“Waiting for the record…”; no need to press again. If it has not shown after 180 seconds, press “Check again”;
   nothing is sent twice).
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
  2026-11-25; devnet gets this rule with the program update planned before the world is created).
- Marching from a wide-land village to other wide land (taking a wide-land keep) is closed on devnet, and there are
  no AI residents. The differences from the local version are in the table of [PLAY-LOCAL.md](PLAY-LOCAL.md) §7.
- Until the world is created the page cannot show it: it says that the record cannot be read. That is expected
  today. Open the page again after the announced start.
- The 7-day world announced on 2026-11-23 was cancelled (2026-11-24) and is never created. The world does not end
  (decision of 2026-11-23): the devnet world will be one continuous world. Its creation, planned for 2026-11-25,
  was postponed (decision of 2026-11-24) until the rules update is ready; the new date will be announced.
- **There is no winning or losing yet.** After a keep is taken the guide says 「この世界は続きます。戦期の勝敗と集計は未決定です。」
  (this world goes on; its result and tally are undecided). The direction decided after that text was written (2026-11-24)
  is that “world goals” are always posted in the world (holding flag keeps for 24 hours, and others) and a nation that
  achieves one receives a prize. That is a plan and is not built: the devnet world has no goals and no prize today.
  The design record is [design 01](../design/win-conditions/01-proposal.ja.md) (Japanese).

## 6. When something goes wrong

| What happens | What to do |
|---|---|
| The page does not open | The address may have changed. Look for the operator's new announcement (§1) |
| “The world is not open yet. …” | The world has not been created yet. Nothing is wrong and there is nothing to do: the line says when it opens (“It opens on or after …”, in your own time zone) or “It opens soon”, and the page shows the world automatically once it opens. You do not need to reload |
| “No wallet found. …” | Install a wallet, then reload the page |
| The wallet shows a balance of 0, or its confirmation shows mainnet amounts | The wallet is not on devnet (§2) |
| The wallet or the page refuses for lack of balance | Add devnet SOL (§3) |
| “Waiting for the record…” goes on | Wait. “Check again” appears after 180 seconds (§5 step 2) |

This is a test. The world may stop or be started over part-way. Devnet records and devnet SOL have no value.
