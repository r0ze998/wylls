# Local village-and-march demo protocol v2

Status: implemented private local prototype, validated locally (supervisor runs, 2026-11-08).

- **Rust:** offline locked build of `local_march_demo` (`local-march-demo` feature) passed; all 21 example tests, each selected by exact name, passed; dedicated example clippy with `-D warnings` passed. The Rust changes after those runs were rustfmt only.
- **Real host:** `wide-march-local-real-host.test.mjs` passed 2/2.
- **Focused JS, fixed and confirmed:** the first run went 32/42. Its 10 failures came from a shared store object in the synthetic model-test fixture, which leaked one test's mutation into later snapshots. After the fixture fix (fresh objects, a direct isolation regression, exact error-code assertions; no production check changed), the focused suite passed 43/43 under `scripts/ci/no-keys-guard.mjs`. The older economy suites (bridge/client/model/server/ui) passed 48/48.
- **Chrome smoke on localhost:**
  - The full loop ran on one holding: Harvest → Farm → Train ×10 → Depart → origin settlement (bell 8) → Harvest → Reveal (bell 21) → Harvest → arrival combat → arrival settlement → Dissolve/Return (bell 25). The final reserve was 907 and escrow 0.
  - A view-only camera jump to `9007199254740993, 0` kept exact digits, showed 7 unknown provinces and left the revision unchanged.
  - At the inclusive ±2^62 bound, outside cells were shown, and a pan to 2^62 + 1 was refused.
  - Reset restored `ready`, bell 6, reserve 600 and the initial resources, while the revision increased.
  - A screenshot was captured.

These are local results. They do not show polished visuals, infinite or newly playable land, arbitrary routes, a synchronized world clock, real signatures, chain execution or deployment. v1 (`wylls-local-march-v1`) results remain v1 evidence only. The browser refuses v1 replies, and the server refuses the v1 action header.

## Boundary

Dedicated private `local_march_demo` process, built only with `local-march-demo`. No wallet, signing, network, chain submission, or arbitrary instruction execution. ONE session: the village economy (Harvest, the fixed Farm Build, the fixed Train) and the march lifecycle act on the same holding and citizen bytes, under one revision and one simulated clock, in one serialized controller. The older `wide-economy-local` demo (Season 11 fixtures) is a separate process and session. It is unchanged, it shares no balance with this one, and it remains its own baseline.

Initial accounts (stores 1,900 of each resource), enemy resident, public encrypted-key material, and non-arrival beacons are fixtures, unchanged from v1 (same `fixtures/` and SHA256SUMS). Arrival anchor/seed, Depart, Reveal, Gather, Resolve, settlement, Return, Harvest, Build and Train run real handlers through `permutation_frontier::dispatch`. No post-action account playback.

## One clock, and the horizon restriction

- The clock moves **only** through the fixed phase steps: Depart/ready at bell 6 +60 s; origin settlement at bell 8 +60 s; PostAnchor at bell 21 +213 s and Reveal at bell 21 +300 s; PostSeed/Gather/arrival Resolve at bell 22 +300 s; SettleTransit at bell 23 +300 s; Dissolve at bell 23 +300 s, then Resolve 22 at bell 24 +60 s and Resolve 23/Return at bell 25 +60 s. All are simulation controls, not wall-clock timers.
- Economy commands run at the instant the last phase step left. They **never** move the clock. There is no advance-time command, so no command can extend the destination's precomputed future.
- **Horizon (reported, not hidden).** The destination was precomputed through bell 19 with real Resolve before the initial export; the session starts at origin bell 6. Every response carries `horizon` with both provinces' `RESOLVED_NEXT` read from their bytes (the browser re-reads them). This is one holding on one clock, **not a globally synchronized whole-world simulation from inception**.
- **Exact remaining blocker for a synchronized world.** Established so far:
  - The current initial fixture has the destination already resolved through bell 19.
  - It lacks the origin and destination seed caches/anchors that a general synchronized run would resolve, and the arrival beacon material for any other arrival bell.
  - The existing fixture/export path uses signing, so it cannot be used for that expansion under this task.

  Alternative keyless ways to build or reuse such state have not been evaluated, so this is not a claim that every approach needs signed-fixture regeneration. The v1 fixture set is preserved byte-for-byte. Free time advance is also deliberately absent: advancing the origin past bell 6 would need caches/anchors the current fixture does not contain.

## Transport

One printable ASCII command per LF-terminated stdin line, at most 128 bytes. Exactly one JSON response per command, at most 1048576 bytes excluding LF. No other stdout. Fixed binary, no arguments, minimal environment. Never invoke Cargo from a browser request. EOF terminates. Overlong or malformed input refuses without mutation. One command at a time. Host fatal error makes the session uncertain; no automatic respawn/retry.

Commands (exact tokens, canonical decimal REV 0..1000000):

- `get`
- `reset REV`
- `depart REV`, `settle_departure REV`, `post_reveal REV`, `resolve_arrival REV`, `settle_transit REV`, `dissolve_return REV`
- `harvest REV`: WideEconomy Harvest (settle and touch)
- `build_farm REV`: WideEconomy Build item 0 (Farm). The item is fixed. It writes the holding alone (`mirror_write` false, asserted at compile time).
- `train REV`: WideEconomy Train unit 0, count 10. Fixed.

No client coordinates, paths, account bytes, timestamps, lamports, items, units, counts or instruction bytes. Reset reconstructs the initial fixtures (clock, counters and images) and increments the revision. Get never changes the revision. Every successful mutation increments the revision once. Refused/fault commands never commit staged account changes, clock, counters or revision. Revision overflow refuses. A repeated or stale command is `STALE_REVISION` and never replays.

**Per-instant budget.** At most 8 economy commands run at one simulated instant (`INSTANT_BUDGET`). This is a demo transport budget, not a game rule. Without a time control, an emptied citizen action bucket (Season burst 20, refill 1/min) at `ready` or `settled` would otherwise refuse Depart or Dissolve for good. `ready` and `departed` share bell 6, so they share one budget. Every phase step that moves the clock starts a new instant.

## Phases

`ready` -> depart -> `departed` -> settle_departure -> `travelling` -> post_reveal -> `revealed` -> resolve_arrival -> `resolved` -> settle_transit -> `settled` -> dissolve_return -> `returned`.

Economy commands are offered in every phase, `returned` included, while the instant's budget lasts. The handler decides each one: stock (`Insufficient` 21), queue (`QueueFull` 22), action bucket (`Bucket` 17), and so on. With the fixture's tier and production, the Farm queued at bell 6 is due before bell 21, so a Harvest at `revealed` completes it. That is an outcome of the real handler, not a scripted step.

## Judgement of an economy command

On top of the runtime checks and the receipt-kind/chain walk every handler gets:

- every image other than the citizen and the holding byte-identical, lamports and owners included;
- the citizen changed only in `BUCKET_MILLI`, `BUCKET_T` and `LAST_ACTION_TS`, with the stamp equal to the clock;
- the holding changed only in its chain header, `STATE` (provisional -> final only), `TIER`, `FLAGS`, `LAST_OWNER_ACTION` (equal to the clock), the kernel block (`STORES` .. `FOOD_SHORTFALL`), and for Train `reserve[0]`, by exactly 10. Transit, escrow, host identity and the wide trailer are therefore untouched;
- exactly one `Economy` record at the clock's bell and keyed by the holding reference, whose receipt equals the one recomputed with `world_index::economy::{input_digest, output_digest}` from the complete before/after Season, citizen, holding and origin bytes;
- the holding chain advanced by that record alone, no province link, `verify_chain` walked.

Any failed judgement is `EXECUTION_FAULT` and commits nothing.

## Response schema

All fields below are present. Numbers are nonnegative safe JSON integers unless stated. Chain-sized unsigned quantities and signed coordinate/time/store values are canonical decimal strings. Hex is lowercase, even length, no prefix.

```
{
  "protocol": "wylls-local-march-v2",
  "mode": "local-only",
  "auth": "MOCK_AUTH_NO_SIGNATURE",
  "beacon": "PUBLIC_FIXTURES_REAL_VERIFICATION",
  "session": "integrated-economy-march-same-holding",
  "status": "ok|refused|fault",
  "error": null,
  "refusalCode": null,
  "command": "get",
  "revision": 0,
  "phase": "ready",
  "allowed": ["depart", "harvest", "build_farm", "train", "reset"],
  "clock": {"unix": "1790448507", "bell": 6},
  "horizon": {"model": "PHASE_STEPS_ONLY", "finalBell": 25, "destinationPreparedThroughBell": 19,
              "originResolvedNext": 5, "destinationResolvedNext": 20},
  "economy": {"perInstantBudget": 8, "usedThisInstant": 0, "harvests": 0, "farmBuilds": 0, "trains": 0,
              "farmItem": 0, "trainUnit": 0, "trainCount": 10},
  "village": {
    "tier": 0, "flags": 0, "lastOwnerAction": "...",
    "stores": [{"value": "...", "rate": "...", "cap": "...", "t0": "..."}],
    "production": ["..."],
    "queue": [{"doneAt": "...", "kind": 0, "arg": 0, "delta": "..."}],
    "reserve": [0]
  },
  "map": {"worldHex": "...", "origin": {"p":"129","q":"0"}, "destination": {"p":"129","q":"-1"},
          "route": [{"p":"129","q":"0","tile":1}],
          "provinces": [{"p":"129","q":"0","accountKeyHex":"...","passableMask":"..."},
                        {"p":"129","q":"-1","accountKeyHex":"...","passableMask":"..."}]},
  "host": {"refHex":"...","originTile":1,"destinationTile":2,"initialMilli":300000,"currentMilli":300000,"transitState":"absent","fate":null},
  "holding": {"accountKeyHex":"...","tile":1,"reserveUnits":600,"escrowLamports":"0","poolOwedLamports":"0","openTransits":0},
  "combat": {"engagements":0,"arrivalSurvivorMilli":null,"enemyFixture":true},
  "returned": {"creditedUnits":0,"creditedMilli":0},
  "evidence": {"instructions": [], "recordsHex": [], "accounts": [{"keyHex":"...","ownerHex":"...","lamports":"0","dataHex":"..."}]}
}
```

Example values are illustrative; never hardcode them in the UI. `stores` has 8 entries (Food, Wood, Stone, Ore, Arms in the Horses slot, Gold, Science, Influence): `value` is milli-units **at that store's `t0`** (its last settle), `rate` milli-units per hour, `cap` milli-units. Nothing is projected to the current clock anywhere: accrual since `t0` is settled only by the next host action. `production` has 8 milli-unit-per-hour entries. `queue` has 4 entries; `kind` is 0 free, 1 production, 2 upkeep, 3 tier-up, 4 walls. `reserve` has 8 whole-troop entries, and `reserve[0]` equals `holding.reserveUnits`. Every `village` and `horizon` number is read from the returned account bytes, and the browser re-reads it from those bytes with the production `fcodec` V2 layout. `refusalCode` is the program's stable `ProgramError::Custom` code, present only with `error: "HANDLER_REFUSED"`. The other fields keep their v1 meanings (route, `passableMask`, `refHex`, `currentMilli`, `transitState`, fate).

`error` is null on success or one fixed token: `BAD_COMMAND`, `STALE_REVISION`, `REVISION_LIMIT`, `BAD_PHASE`, `INSTANT_BUDGET`, `HANDLER_REFUSED`, `EXECUTION_FAULT`, `RESPONSE_LIMIT`. `allowed` is the phase step (if any), the three economy commands while the instant's budget lasts, and reset. `instructions` lists the handler names executed by this successful command (`Harvest`, `BuildFarm`, `Train` for the economy). `recordsHex` contains their newly emitted PSW1 receipts, in order. Get/reset have no new receipts.

UI must validate protocol labels, enum values, bounds, key lengths, hex, unique account keys, revision progression, phase progression, the economy transition (same phase and instant, the command's counter by one, `reserve[0]` by exactly the fixed count for Train and unchanged otherwise, no account other than the holding and its owner citizen changed, host/combat/returned/horizon unchanged), and response size. Do not claim transaction authentication, real-chain balances, hidden orders, arbitrary routing, synchronized world time or SBF validation. Mark the enemy, the initial stock and the setup explicitly as fixtures.

## Map (browser only)

The page's camera is view state and never reaches the host. It uses the production BigInt helpers (`wide.mjs` `originAt`/`parseWideInt`, `fgeo.mjs` lattice geometry). Pans move 1, 1,000 or 10⁹ provinces in the six axial directions. A view-only jump takes canonical decimals. The radius is 0 to 2, so a view holds at most 19 provinces and 1,159 hexes. Cells are `known` (the two provinces whose bytes the host returned, with their passability), `unknown` (no data: not opened, not generated, not playable) or `outside` (beyond the ±2^62 coordinate bound; a pan past it is refused). No global coordinate passes through Number. No new province generation is claimed. This slice does not implement host/program province opening or generation; what that would require has not been determined here.
