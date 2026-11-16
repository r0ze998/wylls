# ⑬ resident `observe` against the herald's public reads: what maps, what does not (2026-11-17)

**Base:** the shared aggregate `claude/aggregate-approved-20261117` at `78f22cb5`. Read with `git show` and `git grep` only.

**Not done:**
- No instantiation, import, test, syntax check, HTTP, RPC, model, key, signing or world.
- Not touched: ③, ⑤, Lane D, Lane C and the shared refs.

**Verdict:** **no code.**
- ⑬'s only `observe` consumer is the `Resident`. On every tick it reads the board and the stores and positions of every village, and it decides from its own event kinds.
- The herald's public reads cover the world identity, the clock, the reader's own citizen and holdings, raw chain event rows and moving caravans. They have **no board**, **no other villages' stores or buildings**, **no failed-action events** and **no relay quota for a citizen**.
- A herald-backed `observe` would therefore be partial. Filling the gaps with empty arrays, "no requests" or zeros would fake a complete view, which the brief rules out.
- No other existing consumer takes a partial view, so there is nothing safe to wire read-only.

## What ⑬'s consumer reads (`resident/*.mjs` at `78f22cb5`)

The shape is `world/testworld.mjs` `view()` (`:84-102`) plus `world/board.mjs` `view()`, returned by `observe(me, since)` as `{world, board}`. The port also declares `.world` and `.clock` (`resident/frame.mjs`: `MOCK_WORLD`, `MOCK_CLOCK`).

| Field | Read at (resident.mjs unless noted) | Used for |
|---|---|---|
| `world.bell` | `:414` | the resident's bell: wakes, deadlines, the day's counters, retention windows |
| `world.villages[]`: `citizen`, `owner`, `pos`, `stores`, `name`, `tier`, `cap`, `buildings`, `building[]` | `:370`, `:417-420`, `:785`; `candidates.mjs:32-34, 61, 106` | finding the own citizen at join; partners and requests (others' `stores`); delivery targets |
| `world.events[]` (since a cursor): kinds `CaravanDeparted`, `CaravanArrived`, `CaravanRaided`, `BuildDone`, `Failed` (`Joined`, `BuildStarted` and `BoundaryMarker` are emitted by the mock) | `:594`, `:734` (`#learn`), and the cursor | episodes (raided, failed, built), debts and returns |
| `world.me.quota.{bucket, relayLeft, lamportsLeft}` | `candidates.mjs:37-38` | whether a send or a caravan is possible (quota checks on candidates) |
| `world.me.pending` | (in the view; not read in `resident/`) | — |
| `board.requests[]`, `board.replies[]` | `:316`, `:586`, `:712-789` | offers, accepts and declines, duties, returns, debts |

## What the herald and ⑫ publish (read-only, real)

| Source | Fields | Where it is read today |
|---|---|---|
| `GET /h/season` | `programId`, `cluster`, `season`, `seasonAddress`, `genesisTs`, `bellSecs`, `continuous`, `latestSlot`, `latestUnix` | ⑫ `adapters/canonical.mjs` `worldFromSeason` (world plus clock `{genesisTs, bellSecs, source}`) and `currentBellFromSeason` ("informational: not a finality statement") |
| `GET /h/events` | rows `{seq, slot, sig, kind, bell}` of chain records (caravan sent, settled and raided records, by their chain kinds) | ⑫ (`clockFromHeraldEvents`); ③ `events.mjs` parses caravan records for its own operations |
| `GET /h/me/{wallet}` | `{wallet, citizen: {address, slot, bytes_b64}}` and holdings; **only the reader's own wallet** | ③ `game.mjs` (own village status, `storesAt`) |
| province envelopes, `overview`/`overview2`/`control` bins | sites and their state, majority owners, control | the web client (`herald.mjs`), ③ (`province` for its own holding) |
| `/h/caravans.json` | moving caravans | ③ (`caravansFeed`), the web client |
| `/h/structures.json`, `/h/nations.json`, `/h/sieges/*`, `/h/conquest/*` | structures, nations, sieges, conquest | the web client |

**⑬'s side for the clock and world:** `frame.mjs` `seasonClock({genesisTs, bellSecs, source})` declares a real clock, and `worldMismatch`/`sameClock` compare. `ports/ws12-canonical.mjs` already takes ⑫'s `worldFromSeason(season).clock` from its caller, and gives ⑫ a world bell only when the resident's clock *is* that clock.

## Field by field

| ⑬ field | Herald or ⑫ equivalent | Status |
|---|---|---|
| world identity, clock (`observe.world`, `.clock`) | `/h/season` → ⑫ `worldFromSeason` → ⑬ `seasonClock` | **maps (adopted on both sides)**, but only as a declaration. The resident's bell semantics (charter limits in bells, board deadlines, `BELLS_PER_DAY` days) were made against the mock turn counter. Using the Season bell for them is a world binding that is **not adopted** for the resident's own bell. The mock and Season bells are never treated as the same. |
| `world.bell` | `currentBellFromSeason` (informational, from `latestUnix`) | **partial:** informational, not final; needs the binding above |
| own citizen, own `pos`, own `stores` | `/h/me/{wallet}` + holdings + `storesAt` (③'s use) | **maps for the reader's own village only.** `buildings` and the build queue in ⑬'s words are not mapped. |
| other villages: `citizen`, `owner`, `pos`, `stores`, `buildings` | overview and province data give sites and majority owners; **no public read of another village's stores** | **missing:** others' stores have no public source (the herald's `/h/me` is per wallet). An empty list or zero stores would be a fake known value. |
| `events`: `CaravanDeparted`, `CaravanArrived`, `CaravanRaided` | `/h/events` caravan records (sent, settled, raided) | **mappable in principle, not adopted:** ⑬'s events carry `owner` and `dst` as ⑬ citizen ids, `goods`, and a cursor of ⑬'s own. A mapping from chain records (with their worn cargo and `floor(milli/1000)` precision) is a new specification. |
| `events`: `BuildDone` | a structures read | **not mapped:** no adopted record for a build completing |
| `events`: `Failed` (an action that failed) | **none:** a failed transaction emits no herald record; the wallet's fate is per key | **missing as an event.** The per-key fate already comes through the execution port. |
| `me.quota` | the relay's agent and sponsor limits (`/f/agent`, not the herald), in other units | **missing / undecided:** the mock's bucket, relay and lamport quota have no adopted real counterpart for a resident |
| `board.requests`, `board.replies` | **none** | **missing:** the board is a mock. Its real form (a signed social record kind) is an unimplemented proposal (`03-contracts.ja.md` §5). |

## Why nothing is wired

- **No complete view:** the `Resident` reads `board` and others' `villages` every tick (`:316`, `:417-420`, `:586`, `:712-789`; `candidates.mjs`). An `observe` without them would make the resident decide on a world it cannot see, or on empty data presented as known.
- **No partial consumer:** no other existing consumer takes a partial ⑬ view. ⑫'s evidence path already reads `/h/season` and `/h/events` for itself (`ws12CanonicalEvidence`, handed in by the caller).
- **No helper without a user:** a mapping helper with no real consumer would be the unused helper the brief rules out.

## What is needed, and from whom (not decided here)

1. **A board:** whether a real board exists, its record format and its reader. **Owner and design.**
2. **Other villages' state for a resident:** a public read of another village's stores and buildings, or a decision that the resident works without them, which would change `candidates.mjs`. **Owner and herald.**
3. **A caravan event mapping:** chain records → ⑬'s `CaravanDeparted`/`Arrived`/`Raided` (citizen ids, goods with the road's wear and the record's precision, the cursor). **⑬, adopted with ④/⑧.**
4. **A build-completion record,** if ⑬ is to keep `BuildDone`. **Herald and chain.**
5. **The resident's bell on a real world:** whether its limits and deadlines move to the Season bell (`seasonClock` binding), and how a day is counted. **Owner.**
6. **`me.quota`:** the real sponsor and relay limits for a resident, if it sends through the relay. **Together with the `send` and credential decision** (`CLAUDE-WS13-ASSEMBLY-PROVIDERS-20261117.md`).
