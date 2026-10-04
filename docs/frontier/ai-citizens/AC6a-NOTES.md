# AC6a notes: the feed (events, province, clash, owners, wakes)

Unit AC6a of wave A, branch `frontier/ai-ac6a` (cut from `frontier/ai-integ` 73408a5). Contract: AI-CITIZENS-CONTRACT v1.2, §0.2, §1.3 C5, §3.2, §5.2, §11.3 (AC6a row), §11.6. Everything below ran on this Mac against a **local test chain** (the paused m1-exit herald, rule bots only). Nothing here touches devnet or mainnet, and nothing was played by humans.

## What was built

| File | What |
|---|---|
| `permutation-gateway/citizens/watcher/owners.mjs` | host id → holder, holdings, home, nation. Derived from public events only (below). |
| `permutation-gateway/citizens/watcher/feed.mjs` | `createFeed({herald, roster, clock, ...})`: polls `/h/events`, normalises the decoded rows, serves `provinceAt`, `clashAt`, `clashDetail`, `prepare`, the wake derivation W-CLASH and W-THREAT, `completeThrough` (the `feed_lag` input), `subscribe`. Reads only; the herald URL must be loopback. |
| `permutation-gateway/test/citizens-owners.test.mjs` (11 tests), `test/citizens-feed.test.mjs` (26 tests) | on the captured fixtures and a loopback fake herald |
| `permutation-gateway/test/fixtures/ai-herald-*` | the captured shapes (first task), `ai-herald-fake.mjs` (a fake herald over them), `ai-herald-capture.mjs` (the capture script) |

Imports (read-only, for the AC1/AC5 permission-model read list; the whole graph, checked by running `feed.mjs` under `node --experimental-permission` with exactly these allowed and a read of a file outside them refused with `ERR_ACCESS_DENIED`): `permutation-server/web/frontier/{abi,fcodec,fgeo,herald}.mjs`, `…/frontier/people/roster.mjs`, `permutation-server/web/sdk/{base58,bytes,sha256}.mjs`, plus `node:crypto`.

## Captured herald shapes (first task, committed in 880bc62)

Source: the paused m1-exit herald (`frontier-herald`, 127.0.0.1:41040, season 7, program `9U2L…HYb7`, 600 s bells, 171,028 events, 169 provinces, log head at bell 1033). Read-only GETs only. Full record of what exists and what does not is in `test/fixtures/ai-herald-meta.json` (`shapes`, `absent`).

**Exists (real, verbatim):**
- `/h/events` rows `{seq, slot, sig, kind, bell, tx, body_b64, decoded}` with the server-side `decoded` field (`{kind, name, bell, key, payload, links}`; 8-byte integers are decimal strings, 4-byte are numbers). `ai-herald-events.json` is an **excerpt**: 566 verbatim rows chosen by `ai-herald-capture.mjs` (the cases' departures, reveals, settlements, clashes, camps, builds, the JOIN and SETTLE rows of every involved citizen, one sample of every kind present, one never-revealed DEPART). The page envelope fields `next`/`full` are those of the excerpt; the real herald pages 500 rows.
- Decoded kinds present: JOIN, SETTLE, TICKET, HOLDING_FINAL, BUILD, TRAIN, HARVEST, MUSTER, EXPLORE, EXPLORE_RESULT, **DEPART, REVEAL, DEPARTURE_SETTLED, TRANSIT_SETTLED, CLASH, CAMP**, GATHER, SKIP, DIVERT, POOL_SWEEP and the beacon/anchor/seed/close/archive/fold noise.
- Per-bell province envelopes `/h/province/{p},{q}/{bell}`: 3 consecutive bells around each of 7 clashes plus the departure bell of the arriving armies (25 files).
- Clash reports `/h/clash/{p},{q}/{bell}` for 7 cases: camp fight with one army; an arrival that did not engage (Retreated); two arrivals of different nations on a camp tile; an arrival against a resident army on a village tile (and the next bell, a second clash in the same province); two resident armies of different nations with no arrival; three owners engaged.
- `/h/me/{wallet}` of an attacker (1 host, 8 seals) and a defender (3 hosts, a village), `/h/season`.
- A DEPART that was never revealed (18 in the capture), a REVEAL for 1,694 of 1,712 DEPARTs, a departure together with its host owner (via SETTLE and JOIN).

**Does not exist (and what was done):**
- `/h/roster/{ring}/latest.bin`: the running herald answers 404 NotFound (its binary predates the route; the source has it). I wrote **synthetic** roster files (`ai-herald-roster-synthetic-{3,5,6}.bin`, `roster.rs` layout, owners from the real SETTLE rows, founded bell from `final_ts`, tier 0). They are labelled synthetic in the file name, the meta and the tests, and only test the roster decoder path. Ownership itself does not need the roster (below).
- Record kinds never seen: RELEASE, DISSOLVE, STRANDED, GARRISON, WINDOW, SESSION, VIGIL, DEFENCE_CLAIM. SETTLE outcome 1 (displace) never occurs (outcomes seen: fresh 1000, taken 50, expired 5). Tests for RELEASE and displacement use **synthetic rows** and say so.
- A `/h/me` with a transit in flight or an open ArrivalSlot (both captured files have empty `transits` and `slots`; a paused run has nothing in flight). AC3a's `ai_meview.rs` must use another source for that shape; the I-A smoke can capture it.
- The cq-integ/MC herald differences are not captured (this is the m1-exit herald, `30ba411`-era).

## How owners are derived (no roster, no brain input)

- Host id = `index(p,q) << 44 | site << 40 | gen << 32 | seq` (checked against `frontier-abi/vectors/addresses.json` and the web `faddr.hostParts` on every host id of the capture).
- SETTLE (outcome fresh/displace) names the holder `citizen_tag` and `gen` of `(p,q,site)`; a host id's `(site, gen)` therefore names one holder; RELEASE or a displacing SETTLE ends it (an old generation still resolves to the old holder).
- JOIN gives `(citizen_tag15, wallet, faction)`. The Citizen address is `sha256(season_address ‖ "ct" ‖ hex(tag15) ‖ program_id)` and the citizen tag is its first 8 bytes little-endian. Measured: **1000 of 1000** SETTLE holders in the capture resolve to a JOIN, which gives the **nation of every citizen from events alone** (the roster file has no nation).
- Cross-checks in the tests, all on real data: `citizenOfHost` equals the `citizen_tag` of the ClashInputs arrival records (raw account bytes, independent path); every resident of every captured province file resolves, with the same nation as its entry and, at home, the same holder as the site mirror; `holdingsOf`/`homeOf` equal the `Holding` bytes in the two `/h/me` files (owner bytes, gen).
- Tags are 16-digit lowercase hex strings (`tagHex(BigInt)`, `tagFromDecimal(string)`; `tagHex` refuses strings because a 16-digit decimal and a 16-digit hex look alike).

## Interfaces as built (§11.6 `createFeed`)

`createFeed({herald, roster, clock, season?, kinds?, clashMode?, fetch?, timeoutMs?}) → {start(), stop(), poll(), ingest(rows), events(bell), eventsFor(bell), batchSince(cursor), cursor(), headBell(), completeThrough(), provinceAt(p,q,bell), provinceBefore(p,q,bell), clashAt(p,q,bell), clashDetail(p,q,bell), prepare(events), departOf(host,arrive), revealOf(host,arrive), rosterRing(ring), owners, watch(), setRoster(), kindOfTag(tag), wakeEvents(tag, bell), wakeSummary(tag, bell), subscribe(fn), season(), stats}`.

- **Normalised events** (`normalizeRow`): `{seq, slot, tx, sig, bell (log bell), kind, code, key, …fields}`. A CLASH has `clash_bell` (its own key bell, 2 bells before it is logged), `engagements`, `fates` (24 numbers decoded from the 9-byte 3-bit packing; equals the report's), `arrivals`, `real`. DEPART has `host`, `origin_p/q/tile`, `depart_bell`, `arrive_bell`, `dep_mass` and **no destination and no seal**. TRANSIT_SETTLED `outcome` is 1-based (`Stays`=1 … `BadSeal`=8, frontier-abi `transit_outcome`). Kept kinds: `KEPT_KINDS` (JOIN, SETTLE, RELEASE, HOLDING_FINAL, BUILD, TRAIN, MUSTER, DISSOLVE, STRANDED, DEPART, REVEAL, DEPARTURE_SETTLED, TRANSIT_SETTLED, CLASH, CAMP); the rest are counted in `stats.kinds` and skipped.
- **`provinceAt`**: decoded by `parseEnvelope` from the raw account bytes (key and bell checked), shaped to `{p,q,bell,slot,sites[{tile,state,faction,tier,gen,owner}],hosts[{id,owner,faction,unit,tile,troops,stamina,ready_bell,from_bell}],camp,inputs{arrivals[{host_id,citizen,troops,troops_after,fate,…}]},slots,summary}`. **The file of bell b is the province after bell b resolved** (verified: at 1,4 the camp is alive with 224 troops in file 303 and cleared in file 304, whose ClashInputs carry the two arrivals). It exists only once b is resolved (the paused herald serves none past bell ~1008 although its log reaches 1033), so `null` = not served yet, never cached; `provinceBefore` takes the newest served file within 4 bells.
- **`clashAt`**: the herald's report (`heraldCheck` carried as `herald_check`) with each fighter's owner and nation; `fighters[].troops` are the troops **after** the clash. A bell with no CLASH record has no file; once the log is past that bell `clashAt` answers `null` without a request.
- **`clashDetail`**: adds `troops_before`, `troops_after`, `lost`, `before_source` per fighter. Before-troops of an arriving host come from its ClashInputs arrival record; of a resident from the report's `province_before_b64` (exact, `pre_source: "report"`), else the previous bell's file. The test asserts the two agree for every resident of the village_attack case (so the contract's "consecutive province files" route and the exact route give the same numbers there).
- **Sync vs async (for AC2):** `provinceAt`/`clashAt` are async (HTTP). `episodes_from_events` is pure, so call `const ctx = await feed.prepare(batch.events)` first: it fetches what the batch needs (CLASH: report, files of `clash_bell − 1` and `clash_bell`, the detail; REVEAL: the destination province at the **DEPART bell**, the sender's view for the §6.4 hostile-act rule, and at the arrival bell) and returns synchronous `ctx.province(p,q,b)`, `ctx.clash(p,q,b)`, `ctx.clashDetail(p,q,b)`, `ctx.owners`, and `ctx.missing` (keys the herald did not serve yet; AC2 should wait up to 12 bells, as §6.4 says, before `unknown`). `departOf(host_id, arrive_bell)` links a REVEAL to its DEPART bell.
- **`completeThrough()`** (the `feed_lag` input): the last poll reached the end of the herald's index, so every record logged in a bell ≤ (head bell − 1) is in hand; −1 before the first good poll and after a failed one. It uses only the log's own head (beacon rows are written every bell), no clock. If the herald or the chain stalls the value stops moving and the mind goes to autopilot with `feed_lag`.

## Wake derivation (§3.2)

`feed.wakeEvents(tag, bell)` for watched citizens (the roster's `ai` tags, or `watch([...])`); the wake belongs to the **log bell of the record** (when it became public), not to the clash or arrival bell; `wakeSummary` gives the uncapped weight sum and codes for the gate to cap.

- **W-CLASH, weight 4:** a CLASH that lists one of the citizen's hosts (arrival or resident), or that happened at a province where the citizen holds a village. Fields: `p, q, clash_bell, engagements, arrivals, village, own_hosts, own_arrival, own_engaged`. Needs the report of every **real** clash (1,712 reports over the whole 171,028-row log, one GET each).
- **W-THREAT, weight 2 (3 if big):** a DEPART of a host of another nation whose origin is ≤ 3 provinces (hex distance of province coordinates) from the citizen's home (first village). Fields: `origin, distance, nation, actor, host_id, arrive_bell, depart_bell, dep_mass, home_troops_est, big`. There is **no destination, no tile and no `p,q`**: a test asserts it, including for a DEPART that was never revealed.
- Tests compare the W-THREAT set with an independent recomputation from the raw rows (faddr host parts, JOIN factions via the address rule, `fgeo.hexDistance`) for the attacker and the defender of the village_attack case (every departure in the excerpt within 3 provinces of another nation), and check W-CLASH for: the attacker (own arrival), the defender (village and engaged), a bystander village owner (woken by a real clash in its province, `own_engaged: false`), a citizen elsewhere (no wake), an arrival that did not engage (still woken), a report not served yet (no wake, then the wake appears after a later poll).

## Deviations from the contract (read these)

1. **W-CLASH counts only real clashes by default (`clashMode: 'real'`).** Literally, §3.2 wakes on "a CLASH at a province where the AI has a holding or a host, or that lists one of its hosts". On the capture, 20,857 of 21,674 CLASH records (96 %) have `engagements: 0`, and a sample of 30 had no arrival in 26 cases: they are resident roll calls of provinces that hold hosts. Read literally, W-CLASH (weight 4 ≥ the gate's 3) would wake an AI on most bells. Measured on 12 stand-in citizens (the first two to join each of the 6 nations, 7.2 game days, 1,033 bells): **literal mode 3,449 W-CLASH (up to 684 of 1,033 bells for one citizen); default mode 206 (3 to 35 per citizen, about 0.4 to 5 per game day)**. `clashMode: 'literal'` reproduces the literal reading (it still uses real-clash reports for host listing; only village-based wakes on quiet records are added). The architect may overrule; AC1a's gate budget was designed around the default.
2. **W-THREAT "+1 if dep_mass ≥ ½ of home troops" is an estimate here.** The feed sums the citizen's resident non-scout hosts in the home province from the newest served province file within 4 bells before the departure (a DEPART logged at bell d finds the file of d − 2 or d − 3 at best). The brain's `home_troops` (also the reserve and the garrison, §4.2) is better; `dep_mass` and `home_troops_est` are in the wake so the gate can recompute. In the capture a full host (300 troops) against about 500 troops of home hosts makes most threats "big".
3. **Commit trailer:** the task text says `Co-Authored-By: Claude Sonnet 5.5`; contract §11.2 says Opus 5.5. I used the task's.
4. `provinceAt` and `clashAt` return `null` for "not served yet" and the feed retries pending clash reports up to 8 polls (`clashRetries`), then counts `stats.clash_missing`. The contract does not specify this.

## Measurements (real, this Mac, shared)

All against the paused m1-exit herald over loopback, reading all 343 pages (171,028 rows; 42,633 kept):
- one full `poll()` from cursor 0 with no watched citizen (a probe feed): **3.08 s, 2.14 s, 3.52 s** in three runs; with 12 watched citizens (1,712 clash reports fetched, plus the W-THREAT province lookups): **3.57 s and 3.62 s** (default mode), **3.65 s and 3.37 s** (literal mode); `uptime` load averages at the first run `1.90 2.09 2.58`, at the last `3.16 2.77 2.74`.
- Node heap after the full log: 69 to 102 MB without watchers, 140 to 236 MB with 12 watched citizens (the LRU caches of 512 provinces and 512 clashes included).
- W-THREAT on those 12 citizens over 7.2 game days: 2,065 wakes, 138 to 219 per citizen (about 19 to 30 per game day) in the m1-exit population of 1,000 rule-bot citizens in 169 provinces. The AI runs have about 180 script bots, so expect fewer; this is not measured for that population.
- Steady state: one `/h/events?after=<cursor>` request per poll (tests assert it).

## Commands run and results

- `cd permutation-gateway && node --test test/citizens-feed.test.mjs test/citizens-owners.test.mjs`: **37 tests, 37 pass, 0 fail** (26 feed, 11 owners).
- `cd permutation-gateway && node --test test/citizens-*.test.mjs`: the same 37 (no other `citizens-*` test exists on this branch).
- `cd permutation-gateway && npm test` (`node --test test/*.test.mjs screens/logic.screen.mjs`, includes the 37): **611 tests, 611 pass, 0 fail**, 23 s.
- `node test/fixtures/ai-herald-capture.mjs --herald http://127.0.0.1:41040`: run three times (the last after adding JOIN rows for sampled SETTLEs and the `shapes`/`absent` sections); the committed fixtures are from the last run, 40 files written by the script (42 `ai-herald-*` files with the fake and the script itself), 817 KB of captured data.
- `node --experimental-permission` with only the 8 web files and the 2 watcher files allowed: `feed.mjs` loads and a read outside is refused (`ERR_ACCESS_DENIED`).
- Not run (not applicable, JS only): `cargo`, `rustfmt`, `clippy`. No llama-server, no Gemma, no stack. No port was bound except 127.0.0.1:0 by tests; no process was started that outlives a test or script.

## Open points

- **AC2:** call `await feed.prepare(batch.events)` and pass `ctx.province/clash` to `episodes_from_events`; wait for `ctx.missing` to clear up to 12 bells. Tags are 16-hex strings, troops are milli-troops (`MILLI = 1000`, `troopsOf` rounds), unit 6 is a scout. The `ref`/`src` of an episode can use `event.seq` (unique) or `event.key` (herald-style `NAME:key,fields`).
- **AC1a / AC5:** the web-import read list above; `feed.completeThrough()` is the `feed_lag` input; the 41980/41902 services are not touched by this unit.
- **AC6:** `wakeEvents`/`wakeSummary` are what `createWatcher().wakeEvents` forwards in wave A; the §3.2 W-READY/W-QUEUE/W-DM/W-HALL/W-CALL/W-PULSE are not here.
- Observation, not edited (file is design-session territory): `permutation-server/web/frontier/flog.mjs` `TRANSIT_OUTCOMES` is 0-based (`Stays` = 0) while the ABI and the captured rows are 1-based (`Retreated` = 4). Any code that reads outcomes through flog would be off by one.
- `ai-herald-capture.mjs` reads the herald's `/h/me`, which makes the herald ask the relay for a quota; that is a read, but re-running it needs the same paused stack. A re-capture from the I-A smoke should add a `/h/me` with a transit in flight and a displace/RELEASE only if M1 can produce one (it cannot capture villages).
- Nothing of this unit was run against a live AI stack (no stack exists yet); the slice gate is the first live use.
