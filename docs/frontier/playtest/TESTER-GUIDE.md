# Wylls friends' test: guide for players

(Japanese version: [`TESTER-GUIDE.ja.md`](TESTER-GUIDE.ja.md). The operator fills in the two placeholders `{CONTACT}` and `{SURVEY_LINK}` before sending this on.)

## What Wylls is

Wylls is a strategy game about a civilization, played by many people in one shared world and in real time. You choose a nation, a village appears for you, and you grow it, train troops and send them out on sealed marches (only you can see where a march is going until it arrives). The world keeps running while you are away, so you play a little, leave, and come back later.

## What this test is

- **Small and invite-only.** About 10 to 30 friends, one invitation link per person.
- **A test world, not the real thing.** The game runs on a local test chain on the host's own computer. There is **no money, no crypto wallet, no prizes and no trading**. Nothing you do here has any value outside this test.
- **The base game only.** Build, train, explore, send marches, read clash reports. Features that are planned but not built are not in this test.
- **Bots live in the world.** Many of the other nations' villages are run by simple rule-based computer players (bots), so the world is not empty. **AI citizens are not part of this test.**
- **Real time.** One "bell" is 10 minutes, a game day is 24 real hours, and nothing is sped up. The test runs for about three days, from the night of 6 October to the night of 9 October 2026 (Japan time). The host will tell you if the dates move.
- **It is unfinished.** Something may break, be unclear, or be down for a while (the host's computer may sleep or restart). That is exactly what we want to find out.

## How to join

1. Open the link you were sent, exactly as it is. It looks like `https://....trycloudflare.com/frontier/frontier/playtest/#i=...`. The part after `#` is your personal invitation. It works for one person once, so please do not forward it.
2. Open it in **Chrome, Edge, Firefox or Safari 17 or newer**, not inside the LINE, Instagram or mail app's built-in browser (those can lose your data when you close them). Do **not** use a private or incognito window.
3. The page checks your invitation and says "Your invitation works". Press **Start**.
4. **Save your guest key** (the "Save key as a file" or "Copy key" button on the start page). The game makes a guest key in your browser instead of asking for a wallet or a login. It holds nothing of value, but it **is your village**: if you clear your browser's data, switch browser or device, or the host's link changes, the saved key is how you get back in ("I already have a key" on the start page). Do not show the key to anyone.
5. Always come back with the same browser on the same device.

## Your first 10 minutes

1. Pick one of the six nations and press **Join**. (If your village is not ready yet, the game says so; it needs the next bell.)
2. Your **first village appears about 11 to 21 minutes after you join**. This wait is part of how the game works, not a fault. In the rehearsals it took about 18 minutes.
3. While you wait, open the **guide card** (steps: Welcome, Join, First build, First scout, A practice clash, First sealed march, First report). Five words are enough: **village** (your land), **host** (troops you move), **bell** (the 10-minute beat), **march** (a sealed move), **explore** (scouts look around). Look around the map, and try the **practice clash**, which sends nothing to the world.
4. When the village is there: on the Village tab build a Farm and a Lumber Camp, train Scouts, muster them into a host and explore two neighbouring tiles.
5. Then compose a sealed march to a barbarian camp in reach and press **Depart**.
6. Close the page whenever you like. The game goes on without you.

You do not have to do all of this in one sitting.

## What to expect

- **Waiting is normal.** Village: about 11 to 21 minutes after joining. Exploration result: about the same. **First clash report: about 30 to 45 minutes after you send your first march** (in rehearsal 33 to 42 minutes). Realistically your first report comes roughly **an hour and a half after you joined**, because the village and the first host take time. Do not wait at the screen.
- **The world runs in real time, so come back tomorrow.** Things you queued finish while you are away, resources collect in your village (up to a limit, then they stop), and other nations' marches may reach you. A few visits a day, a few minutes each, is the intended way to play.
- **Some messages are expected.** "Not enough resources or balance" (you pressed Train or Build without enough resources: the game does not yet show the cost clearly), "This province is full" when mustering, or "This province has not resolved the previous bells yet" (wait a few seconds and press again). If one of these confuses you, tell us: that is useful.
- **If the page does not load**, the host's computer is probably asleep or restarting. Wait a few minutes and open the link again. If the address itself changed, the host will send you the new one.

## What data we keep, and that taking part is voluntary

Taking part is **voluntary**. You can stop at any time without giving a reason, just stop opening the link. If you want your activity left out of the numbers we report, tell {CONTACT} and we will leave your invitation code out of the counts.

What we keep, all on the host's own computer:

- Per **invitation code**: whether it was used to join, and what the game did for that citizen afterwards (build, train, march and similar actions, with timestamps). The citizen is a random player number made by your browser (the guest key's public half), not your name.
- Game records of the test chain (the same actions, as the game itself needs them).
- Plain technical logs of the programs (errors, restarts).

What we do **not** collect: your name, e-mail address, phone number, or any account. We do not write your IP address to any of our files. (The host's program keeps request counters per address in memory only, to slow down abuse; they are not written anywhere and are lost when it restarts. The link goes through Cloudflare's tunnel service, which, like any web host, handles your connection, so Cloudflare can see addresses; we do not receive or store them.) The game pages are served with a security policy that lets them talk only to the host (no third-party requests), and we use no analytics or advertising service. The game keeps your guest key and settings in your browser's own site storage on your device.

One honest limit: your invitation code is personal to you, so **the person who sent you the link could in principle look up which activity belongs to your code**. We only report counts (for example how many people joined and how many came back on a later day), never what a named person did.

The survey ({SURVEY_LINK}) is an external form that asks no personal data and is not linked to your code.

When the test ends, the logs are kept on the host's computer for the report and then deleted or archived without your guest key.

## How to report a problem

Send a message to {CONTACT} with:

- **What you pressed** and what you expected, and the **exact text of any message** (copy it).
- **When** it happened (date and time, Japan time).
- **Your device and browser** (for example iPhone, Safari).
- A screenshot, if it helps. **Never send your guest key, and crop it out of screenshots.**

If something is only confusing, not broken, say that too. The survey at the end also has room for it.

Thank you for playing.
