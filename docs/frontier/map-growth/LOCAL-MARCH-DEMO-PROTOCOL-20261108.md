# Local village-and-march demo protocol v3

v3 adds `open_province`, the `land` object and the dynamic province list. The browser refuses v2 replies and the server refuses the v2 action header.

**Latest validation (authoritative):** `LOCAL-WORLD-V3-VALIDATION-20261108.md`. All final checks are green there: Rust 78/78, frontend and real host 64/64, old economy 48/48, clippy clean. The interim list below is kept as history.

**v3 (land opening) status, supervisor runs, 2026-11-08 (interim):**
- **Rust:** all 73 example tests passed, each selected by exact name. They include the 14 `land_bootstrap` tests, the 9 `order_material` tests, the 9 destination-module tests and the new engine/protocol land tests.
- **Clippy:** one warning, in `order_material.rs`, has since been fixed (one character).
- **Raw host smoke:** `get` → `open_province 0 129 -2` → a 12-step `quote_route` → `get`, with each reply accepted by the frontend's `validateState`/`checkOpen`/`checkQuote`.
- **JS, first run:** 60/63. Both real-host march flows were refused at `settle_departure`, because phase steps compared the whole map while real Resolve legitimately advances a fixture's `resolvedNext`. One map test had an unsatisfiable geometry expectation. After the model fix (below), both real-host full flows pass.
- **JS, interim rerun:** 63/64. The only failure was a map test that expected all four opened provinces inside a radius-2 view centred on (129,0); (129,-3) lies three provinces away. The test now asserts the visible counts (3 opened, 2 known) and the six-province input cap separately. It awaits a rerun, so the full JS suite is not yet confirmed green.
- **Browser (Chrome, localhost):**
  - Opened (129,-2) at bell 6 (revision 1).
  - A 12-step quote in direction 2 was reachable into (129,-2), tile 60.
  - Harvest, Farm, Train, Depart, departure settlement, Reveal, Harvest, arrival resolve, transit settlement and Dissolve/Return all worked. Final reserve 907, escrow 0.
  - Reset restored the two fixture provinces and reserve 600. Re-opening (129,-2) then succeeded, ending at `ready`, revision 13.
  - A screenshot is a local artifact.

This is local evidence only: no chain, signing or synchronized world.

The status list below records the **v2** validation (same day), which v3 does not inherit.

v2 status: implemented private local prototype, validated locally (supervisor runs, 2026-11-08).

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
- **What a synchronized world still lacks in the current fixture.** Established so far:
  - The current initial fixture has the destination already resolved through bell 19.
  - It does not contain the origin and destination seed cache/anchor pairs that a general synchronized run would resolve, nor arrival beacon material for any arrival bell other than 20.

  The exporter (`permutation-frontier/src/wide_land_runtime_tests.rs`, the march test whose initial-only export starts at `:6275`) contains no key generation or signing: it verifies public signatures, sets mock signer flags and writes seeds as the consume path would (`:822-829`). The missing non-arrival cache/anchor pairs are staged synthetic records whose layout is in source (`stage_seed`, `:567-609`). Building such state with audited keyless code therefore looks possible; it has not been done in this slice. The v1 fixture set is preserved byte-for-byte. Free time advance is also deliberately absent: advancing the origin past bell 6 would need caches/anchors the current fixture does not contain.

## Transport

One printable ASCII command per LF-terminated stdin line, at most 128 bytes. Exactly one JSON response per command, at most 1048576 bytes excluding LF. No other stdout. Fixed binary, no arguments, minimal environment. Never invoke Cargo from a browser request. EOF terminates. Overlong or malformed input refuses without mutation. One command at a time. Host fatal error makes the session uncertain; no automatic respawn/retry.

Commands (exact tokens, canonical decimal REV 0..1000000):

- `get`
- `reset REV`
- `depart REV`, `settle_departure REV`, `post_reveal REV`, `resolve_arrival REV`, `settle_transit REV`, `dissolve_return REV`
- `harvest REV`: WideEconomy Harvest (settle and touch)
- `build_farm REV`: WideEconomy Build item 0 (Farm). The item is fixed. It writes the holding alone (`mirror_write` false, asserted at compile time).
- `train REV`: WideEconomy Train unit 0, count 10. Fixed.
- `open_province REV P Q` (v3): opens the ring-129 province `(P, Q)` with the real `WideOpenProvince` at the session's simulated clock (`slot = 1000 + bell`), through `land_bootstrap::open_province`. `P` and `Q` are canonical signed decimals (`0` or `-?[1-9][0-9]*`, at most 19 digits; the ±2^62 bound is `WideCoord::checked`'s). Revisioned and atomic like every mutation: a candidate copy, the module's prechecks, the staged dispatch, its judge, the rendered and bounded reply, then the commit with revision + 1. It never moves the clock, the phase, the economy budget, the holding, the citizen or the march, and emits no receipt (the handler logs nothing). Refusals: `LAND_COORD_BOUNDS`, `LAND_NOT_RING_129`, `LAND_DUPLICATE_OPEN` (by name or by address, the fixtures included), `LAND_BUDGET` (four extra provinces), `LAND_IMAGE_BOUND`, `LAND_RING_UNSEEDED`, `LAND_TIME_BEFORE_GENESIS`; a handler refusal is `HANDLER_REFUSED` with its program code; anything else (a record that is not the installed one, a failed judgement, a runtime fault) is `EXECUTION_FAULT`.
- `quote_route DIRS`: a **non-mutating** route validation. `DIRS` is 1..=32 directions, each `0`..`5`. No REV: it is a read, like `get`. The host walks the chosen path from the host's origin tile with the shared ABI tile geometry (`WideTile::neighbors`), runs `world_index::tiles::verify_route` with a source built from **every province the host holds** (the two fixtures and any opened in this session, each decoded from its bytes), and checks each entered tile against that province's real `PASSABLE_MASK`. It changes no account, clock, phase, revision or record, and emits no receipt. It does **not** execute a march: the real march still follows the recorded seal to the fixed destination. A step into a province this host did not return is `UNKNOWN_PROVINCE` ("unknown land is not land"); an impassable tile is `IMPASSABLE`; a step past the ±2^62 world bound is `OFF_WORLD`; more than four provinces is `TOO_MANY_PROVINCES`.

No client account bytes, timestamps, lamports, items, units, counts or instruction bytes. The only client inputs beyond a command token and a revision are the bounded `quote_route` directions string and the two `open_province` coordinates. Reset reconstructs the initial fixtures (clock, counters and images, the installed land records included, no opened province) and increments the revision. Get never changes the revision. Every successful mutation increments the revision once. Refused/fault commands never commit staged account changes, clock, counters or revision. Revision overflow refuses. A repeated or stale command is `STALE_REVISION` and never replays.

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
  "protocol": "wylls-local-march-v3",
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
  "allowed": ["depart", "harvest", "build_farm", "train", "open_province", "reset"],
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
  "land": {"ring": 129, "budget": 4, "opened": 0, "provincesCreated": 3,
           "ringSeedKeyHex": "...", "rulesConfigKeyHex": "...", "fundKeysHex": ["...", "...", "...", "...", "...", "..."],
           "provenance": {"ringSeed": "LOCAL_SYNTHETIC_RING_SEED", "rules": "PROTOTYPE_CANDIDATE_RULES_V1",
                          "funds": "LOCAL_FIXTURE_FUNDS", "golden": "GOLDEN_REOPEN_STATIC_FIELDS_MATCH",
                          "opened": "REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME", "resolveHistory": "NO_RESOLVE_HISTORY",
                          "auth": "MOCK_PAYER_SIGNER_FLAG_NO_SIGNATURE", "budget": "DEMO_BUDGET_4_EXTRA_PROVINCES"}},
  "map": {"worldHex": "...", "origin": {"p":"129","q":"0"}, "destination": {"p":"129","q":"-1"},
          "route": [{"p":"129","q":"0","tile":1}],
          "provinces": [{"p":"129","q":"0","accountKeyHex":"...","passableMask":"...","source":"fixture","openedBell":1,"resolvedNext":5,"wedge":0,"region":8},
                        {"p":"129","q":"-1","accountKeyHex":"...","passableMask":"...","source":"fixture","openedBell":1,"resolvedNext":20,"wedge":5,"region":6},
                        {"p":"129","q":"-2","accountKeyHex":"...","passableMask":"...","source":"opened","openedBell":6,"resolvedNext":6,"wedge":5,"region":3}]},
  "host": {"refHex":"...","originTile":1,"destinationTile":2,"initialMilli":300000,"currentMilli":300000,"transitState":"absent","fate":null},
  "holding": {"accountKeyHex":"...","tile":1,"reserveUnits":600,"escrowLamports":"0","poolOwedLamports":"0","openTransits":0},
  "combat": {"engagements":0,"arrivalSurvivorMilli":null,"enemyFixture":true},
  "returned": {"creditedUnits":0,"creditedMilli":0},
  "evidence": {"instructions": [], "recordsHex": [], "accounts": [{"keyHex":"...","ownerHex":"...","lamports":"0","dataHex":"..."}]},
  "routeQuote": null
}
```

`routeQuote` is `null` on every response except a successful `quote_route`, where it is:

```
"routeQuote": {
  "start": {"p":"129","q":"0","tile":2},
  "reachable": true,
  "reason": null,
  "blockedStep": null,
  "steps": [{"p":"129","q":"0","tile":1,"known":true,"passable":true},
            {"p":"129","q":"-1","tile":34,"known":true,"passable":true}],
  "end": {"p":"129","q":"-1","tile":34},
  "provincesEntered": [{"p":"129","q":"0"},{"p":"129","q":"-1"}]
}
```

`provincesEntered` is `verify_route`'s list in first-entered order: a step that stays in the start's province counts that province as entered (observed for the recorded path: `(129,0)` then `(129,-1)`).

`reachable` is true iff there is an `end` and no `reason`; a reachable route has every step `known` (its province is one of those in `map.provinces`) and `passable` (from that province's real mask). `reason` is a fixed token (`UNKNOWN_PROVINCE`, `TOO_MANY_PROVINCES`, `IMPASSABLE`, `OFF_WORLD`, `NOT_ADJACENT`, `TOO_LONG`, `EMPTY`, …). `known` is the host's own flag and the browser cross-checks it against the provinces the host returned; an unknown step has `passable: null`. The browser never computes any of these.

Example values are illustrative; never hardcode them in the UI. `stores` has 8 entries (Food, Wood, Stone, Ore, Arms in the Horses slot, Gold, Science, Influence): `value` is milli-units **at that store's `t0`** (its last settle), `rate` milli-units per hour, `cap` milli-units. Nothing is projected to the current clock anywhere: accrual since `t0` is settled only by the next host action. `production` has 8 milli-unit-per-hour entries. `queue` has 4 entries; `kind` is 0 free, 1 production, 2 upkeep, 3 tier-up, 4 walls. `reserve` has 8 whole-troop entries, and `reserve[0]` equals `holding.reserveUnits`. Every `village` and `horizon` number is read from the returned account bytes, and the browser re-reads it from those bytes with the production `fcodec` V2 layout. `refusalCode` is the program's stable `ProgramError::Custom` code, present only with `error: "HANDLER_REFUSED"`. The other fields keep their v1 meanings (route, `passableMask`, `refHex`, `currentMilli`, `transitState`, fate).

**`land` and `map.provinces` (v3).** `map.provinces` lists the two exported fixtures first (`source: "fixture"`), then every province opened in this session (`source: "opened"`, at most four, ring 129 only), each decoded from its own account bytes. The browser re-reads, from the returned accounts:
- each province's sort key (the reported `p`, `q`), its prefix `WEDGE` (equal to that key's wedge), `REGION`, `RESOLVED_NEXT`, `OPENED_BELL` and passability mask;
- the trailer's ring seed and seed round, which must equal the ring seed record's;
- for an opened province, a `resolvedNext` equal to its `openedBell` (no resolve history), an `openedBell` not after the clock, and funded lamports equal to its own lamports.

`land` names the LOCAL records, all of which are in `evidence.accounts`. The browser checks:
- the ring seed record: ring 129, Seeded, the pinned literal seed `0x81…` and round 32,547,581, the reported `provincesCreated` (3 at install, plus one per opening);
- the rules configuration: version 1, `RuleBytes{1,2,2,1}`, authority `0xaa…`;
- six funds with wedge bytes 0..5, whose opening counters add up to `opened`.

The `provenance` values are the land module's fixed evidence tokens (`land_bootstrap.rs` `EVIDENCE_LABELS`), and the browser requires them exactly.

`error` is null on success or one fixed token: `BAD_COMMAND`, `STALE_REVISION`, `REVISION_LIMIT`, `BAD_PHASE`, `INSTANT_BUDGET`, `HANDLER_REFUSED`, `EXECUTION_FAULT`, `RESPONSE_LIMIT`, and for `open_province` the `LAND_*` refusals listed above. `allowed` is the phase step (if any), the three economy commands while the instant's budget lasts, `open_province` while fewer than four provinces have been opened, and reset. An opening is not an economy command and uses no per-instant budget. `instructions` lists the handler names executed by this successful command (`Harvest`, `BuildFarm`, `Train` for the economy). `recordsHex` contains their newly emitted PSW1 receipts, in order. Get/reset have no new receipts.

UI must validate protocol labels, enum values, bounds, key lengths, hex, unique account keys, revision progression, phase progression, the economy transition (same phase and instant, the command's counter by one, `reserve[0]` by exactly the fixed count for Train and unchanged otherwise, no account other than the holding and its owner citizen changed, host/combat/returned/horizon unchanged), the opening transition, and response size. An opening must leave phase, clock, economy, village, host, holding, combat, returned, horizon and the fixed route unchanged. It must add exactly the asked province, opened at the current bell, raise `opened` and `provincesCreated` by one each, and change exactly three accounts: the new province is added, the ring seed record is modified, and exactly one fund pays exactly the new province's lamports. Economy and phase steps must leave `land` unchanged. An economy step must leave the map unchanged.

A phase step may change the map only in a fixture province's `resolvedNext`, the cursor real Resolve advances. That value is already bound to the account bytes and to `horizon`, and it, and the horizon, may only move forward. Everything else stays exact:
- every other map field: world, origin, destination, route, the province list, and each province's key, mask, source, bells, wedge and region;
- every opened province, both its summary and its whole account (data, lamports, owner). Do not claim transaction authentication, real-chain balances, hidden orders, arbitrary routing, synchronized world time or SBF validation. Mark the enemy, the initial stock and the setup explicitly as fixtures.

## Map (browser only)

The page's camera is view state and never reaches the host. It uses the production BigInt helpers (`wide.mjs` `originAt`/`parseWideInt`, `fgeo.mjs` lattice geometry). Pans move 1, 1,000 or 10⁹ provinces in the six axial directions. A view-only jump takes canonical decimals. The radius is 0 to 2, so a view holds at most 19 provinces and 1,159 hexes. Cells are `known` (an exported fixture province, with its passability), `opened` (a province the real handler opened in this session, drawn in a distinct colour from its own returned mask), `unknown` (no data: not opened, not generated, not playable) or `outside` (beyond the ±2^62 coordinate bound; a pan past it is refused). No global coordinate passes through Number.

Each unknown ring-129 cell in view gets an "open this province" button. It sends `open_province` with that cell's canonical coordinate strings. Nothing is drawn as land until the host's reply has passed the model, and the coordinate is bounded at the browser (`parseWideInt`), the server body check and the host.

The route chooser lets the player build a `DIRS` string and send `quote_route`; the host validates it (above) and the page shows each step distinctly (host-returned vs unknown vs impassable) from the returned `routeQuote`. The quote uses every province the host holds, so a path into a newly opened province is judged on that province's bytes. A quote is an estimate, never an execution: the march that is actually sent still follows the recorded fixed route.

## World expansion: what this slice does and does not do

The user priority of 2026-11-08 was to open currently-unknown provinces and to let the player choose a march destination. Outcome:

- **Delivered — validated selectable routes.** `quote_route` is a real program-model computation over every province the host holds: `world_index::tiles::verify_route` plus each province's real passability bytes. It is non-mutating and refuses unknown land as unknown.
- **Delivered (v3, pending supervisor validation) — opening ring-129 provinces.**
  - **Records.** `Sandbox::new` installs the LOCAL land records with `land_bootstrap::install` (see `LOCAL-LAND-BOOTSTRAP-20261108.md`). The ring-129 seed is the literal `[0x81;32]` with round 32,547,581, written as the consume path would (`wide_land_runtime_tests.rs:125,822`). The rules are the original prototype candidates `RULES` v1 {1,2,2,1} under the Season's authority `[0xaa;32]` (`:130,142`). The six wedge funds are local, with zero counters.
  - **Golden gate.** Installation happens only after the real handler re-opens both exported provinces at bell 1 and reproduces their gated bytes. Reset rebuilds this baseline.
  - **Opening.** `open_province` runs the real `WideOpenProvince` at the session's clock, through the module's staged, judged path (its only CPI, `AllocateWithSeed` with the Season PDA base, is emulated; the wedge-fund debit is direct lamport arithmetic, `permutation-frontier/src/init.rs:326`).
  - **What it is not.** The candidate rules are a local prototype candidate, not a product rule decision. The seed is not a verified beacon output.
  - **Limits.** A new province has no resolve history. The demo budget is four provinces, on ring 129 only.
- **Not yet delivered — marching to a chosen destination.** The current demo already executes the real wide Depart, Reveal, Gather, Resolve, SettleTransit, Dissolve and Return handlers. Older design notes that call those forms or the host identity absent (`WIDE-LAND-WRITER.md` §3) are stale for this demo.
  - **What a new destination needs.** The recorded order commits to (129,-1) only, so a new destination needs a new order.
  - **Possible reuse at bell 20 (from source reading; not executed).** At the **same arrival bell 20**, the existing public `sig_t`/`sig_s` and hints look region-independent and reusable: `PostAnchor`/`PostSeed` take the region as a parameter in `examples/local_march_demo/engine.rs`, and the rounds depend on the bell and anchor time, `wide_land_runtime_tests.rs:6067-6083`. A new plaintext looks sealable from published test-vector material (`seal-vectors-v1.json`; `world_index/seal.rs` `body_xor`) without generating or deriving a key, and without signing.
  - **Not shown to be required.** New signatures, key generation or a consensus change have not been shown to be needed. This slice does not implement any of it.
  - **Constraints that still apply.** Arrival timing; the destination's resolve cursor (an opened province would need staged beacon pairs and resolves up to the arrival bell); and every entered province being opened.
