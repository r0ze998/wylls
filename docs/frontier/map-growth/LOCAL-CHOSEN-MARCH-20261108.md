# Local chosen-destination march: protocol v4 (2026-11-08)

**Status:** validated locally (results below).
- **Native host:** 92/92 example tests, clean build and clippy.
- **Browser:** all six focused v4 browser test files pass (94/94), and both Chrome flows (to (129,−2) and to (129,−3)) completed.
- **Branches not exercised by any test or smoke:** see the last item under Scope.

This is a bounded local prototype. It is not an infinite or continuous world, not complete gameplay, and not chain execution.

## Scope (exact limits)

- **Opening:** ring 129 only, at most four opened provinces per reset, opened by the real WideOpenProvince over the LOCAL land records.
- **Route:** 1..=32 directions, entering at most four provinces, judged by the host's quote on current bytes and by the real Reveal.
- **Destination:** only a province newly opened in this session, with no resolve history and no entries. The origin and the exported fixture destination are refused as chosen destinations.
- **Arrival:** bell 20 only, with the outcome "stays". Any other fate is refused, not wired.
- **One march per reset:** one holding, one host, transit slot 0. After `returned` (bell 25) there is no further march until `reset`.
- **Implemented but untested:** two branches are exercised by no test or smoke.
  - A chosen destination whose region equals the fixture destination's region 6, where PostAnchor and PostSeed would write the region-shared fixture records `arrival_anchor` and `arrival_cache`. Both observed destinations are in regions 7 and 11.
  - The camp-citizen branch of SettleTransit, which lists the citizen only when the handler's camp rule names this march.

## Local validation results (2026-11-08)

### Native host: direct runtime evidence (real program handlers, in-process)

Logs: `.local/cc-chosen-march-20261108/native-final-build.log`, `native-final-tests.log`, `native-final-clippy.log`.

- **Build:** an offline, locked build of the executable passed.
- **Tests:** **92/92** example tests passed after rustfmt, each invoked individually by exact name: the 78 from v3, the 13 v4 tests below, and the bent-route regression `v4_bent_route_to_a_second_opened_province_marches_and_returns`.
- **Clippy:** the example's clippy with `-D warnings` is clean.
- **History:** the first compile had two E0502 borrow errors in new test lines. They were fixed by building each command line before the mutable borrow; nothing else changed. (Earlier interim logs: `native-build2.log`, `native-tests.log` with 91/91, `native-clippy.log`.)

### Native host: raw-host smokes, real handlers

Captures: `native-v4-sample.jsonl`, `second-destination-smoke.json`.

- **First selected province (129,−2), tile 60, region 7.**
  - Route: twelve direction-2 steps.
  - Thirteen and fourteen direction-2 steps also reach (129,−2), at tiles 59 and 58. Each such march departed and returned.
  - A longer straight path enters unknown (130,−3). It was refused `ROUTE_UNREACHABLE`, with nothing changed.
- **Second, separate selected province (129,−3), tile 60, region 11.**
  - Route: `222222222222222233332` (21 steps). It enters (129,0), (129,−1), (129,−2) and (129,−3), the four-province maximum; the first three are read-only path provinces of the Reveal.
  - Full Depart through Return: 300,000 milli-troops survived the arrival and 300 whole units were returned.
  - There was no enemy fixture at the destination, and the escrow ended at 0.

### Browser (`permutation-gateway/screens/wide-march-local/`)

- **Focused v4 browser suite** (`.local/cc-chosen-march-20261108/browser-final-tests.log`): all six files pass, **94/94**, with no skips and no failures. The files are map, bridge, model, ui, receipts and real-host; the real-host file runs against the current v4 executable.
- **Interim history:** before that run, 5/5 real-host integration tests passed and all 12 captured v4 response transitions parsed and validated. An interim focused count of 87/89 was caused by two synthetic test-fixture expectations, since fixed.
- **Older economy regression:** `wide-economy-local`, 48/48.
- **Chrome flow 1, to (129,−2):**
  - Open (129,−2), then quote the twelve direction-2 steps.
  - Harvest, Farm and Train invalidate the quote; re-quote.
  - Explicit `depart_route`.
  - SettleDeparture.
  - Reveal, with the real preparation Resolves.
  - Harvest.
  - The arrival Resolve.
  - SettleTransit.
  - Dissolve and Return.
  - **Result:** reserve 910 and escrow 0. The page showed protocol v4 and the actual selected destination, and the fixed original destination was unchanged. Reset gave reserve 600 and no opened provinces.
- **Chrome flow 2, to (129,−3):**
  - Open (129,−2) and (129,−3).
  - Quote `222222222222222233332`.
  - Explicit `depart_route` to (129,−3), tile 60.
  - Settle the departure, reveal, resolve the arrival, settle the transit, dissolve and return.
  - **Result:** 300 units returned, reserve 900, escrow 0. The browser was left at `returned`, revision 20.
- **Previews:** local only, on loopback.
  - v4: `http://127.0.0.1:63319/permutation-gateway/screens/wide-march-local/index.html`
  - v3: stays on port 55745.

  These are ephemeral local addresses, not published services.

### What is mocked or prerecorded (not runtime proof of anything beyond the local handlers)

- **Order and verification material:** public and prerecorded. The order reuses the published `k`, salt and 128-byte IBE header unchanged. The bell-20 beacon signatures are published quicknet test material, verified by native BLS math. The order has no secrecy.
- **Arrival preparation and later bells:** **synthetic** non-arrival beacon pairs (literal seed, T-model rounds, no signature) feed the real Resolves for bells 6–19 at the chosen destination, and for bells 21–23.
- **Authorization:** mock (`MOCK_AUTH_NO_SIGNATURE`). Signer flags are fixture flags. System CPIs are emulated by the local runtime.
- **Not done:** no key pair is generated or derived, no private key is used, and no signature is created. The only signatures involved are the prerecorded, published quicknet beacon signatures above, which are read and verified. There is no network, no real chain transaction, no deploy, and no SBF or compute-budget validation.
- **LOCAL synthetic inputs, as in v3:** the ring seed, the prototype candidate rules, the funds, the Season, the initial stock and the fixture enemy.

**What this worktree contains.** `wylls-chosen-march-20261108` is based on v3 commit 07ae3f0d and holds the combined v4 change:
- the native example (`permutation-frontier/examples/local_march_demo/`);
- the browser and its local server (`permutation-gateway/screens/wide-march-local/`);
- the focused browser tests (`permutation-gateway/test/wide-march-local-*.test.mjs`, the synthetic helper and the receipt golden file);
- the docs (this file and the screen README).

The sibling v3 worktree and its local preview are not modified.

## What v4 adds

`depart_route REV DIRS` sends the host to a province **opened in this session**, along a route the player chose. Every step runs the real program handlers on private images, with one revision and one simulated clock, as v3 does. The recorded march (`depart REV`, then the same phase steps) is unchanged. (The fixed path's command is `depart REV`; there is no `advance` command.)

Supported family: a destination province opened by `open_province` (ring 129, at most four, from the v3 land module), with no resolve history and no entries, reached by a route of 1..=32 steps that the host's own quote finds reachable over the provinces it holds, entering at most four provinces (the destination plus at most three path provinces), arriving at **bell 20 only**. It is not an unrestricted or infinite world.

## Exact stdin commands (v4)

One printable ASCII line per command, at most 128 bytes, LF-terminated. `REV` is a canonical decimal (`0` or `[1-9][0-9]{0,6}`) equal to the current revision.

| Command | Mutates | Notes |
|---|---|---|
| `get` | no | |
| `quote_route DIRS` | no | unchanged from v3; also allowed during a march |
| `reset REV` | yes | clears the march binding and every opened province |
| `open_province REV P Q` | yes | unchanged from v3 |
| `depart REV` | yes | the recorded march, unchanged |
| `depart_route REV DIRS` | yes | **new**; `DIRS` = 1..=32 characters `0`..`5`, single spaces only |
| `settle_departure REV`, `post_reveal REV`, `resolve_arrival REV`, `settle_transit REV`, `dissolve_return REV` | yes | follow the bound march (recorded or chosen) |
| `harvest REV`, `build_farm REV`, `train REV` | yes | unchanged; at most 8 per instant |

Example session: `get`, `open_province 0 129 -2`, `quote_route 222222222222`, `depart_route 1 222222222222`, `settle_departure 2`, `post_reveal 3`, `resolve_arrival 4`, `settle_transit 5`, `dissolve_return 6`.

## What `depart_route` does, in order (all or nothing)

1. **Phase gate.** The phase must be `ready` (`BAD_PHASE` otherwise). The syntax is checked first; anything malformed is `BAD_COMMAND`.
2. **Route.** The host's quote of `DIRS` is recomputed now, on the current province bytes. It uses `quote_route`'s walk, `verify_route` and the real `PASSABLE_MASK` bytes. If it is not reachable, the reply is `ROUTE_UNREACHABLE`, and its `routeQuote` is the host's quote with the reason (`UNKNOWN_PROVINCE`, `IMPASSABLE`, `TOO_MANY_PROVINCES`, `OFF_WORLD`, ...). The route is never replaced by the recorded one.
3. **Destination.** It is the quote's end province and tile.
   - Ending in the origin province is refused as `ROUTE_DESTINATION_ORIGIN`: alias semantics for a march into the host's own province (roster and entry) are not implemented.
   - Ending in the exported fixture destination is refused as `ROUTE_DESTINATION_FIXTURE`: `depart` sends the recorded order there.
   - Otherwise the end must be a `land_province_*` image at its canonical address, with its stored region equal to `wide_region`, `resolved_next == opened_bell` (between 1 and 19), and zero entries. If not, the reply is `ROUTE_DESTINATION_UNSUPPORTED`.
4. **Path provinces.** These are `verify_route`'s first-entered provinces without the destination: at most three image names, in the order the real Reveal's `walk_wide` requires.
5. **Order.**
   - `OrderBinding::new` binds the Season, Citizen, holding and host from the current bytes.
   - The recorded order is rebuilt from the published material and must equal the fixture's `plain`, `seal`, `commit`, `ct_hash`, `root` and `salt` byte for byte (an `EXECUTION_FAULT` otherwise).
   - Then `build_order` builds the chosen order: destination key, quote-end tile, `DIRS`, stance 0, retreat 0, bell 20.
6. **Depart.** The real Depart runs on a staged copy, with the recorded flow's account list and the rebuilt commit and seal. The transit must be `Departed`, of this host, at bell 20, with `seal_root` equal to the order's root.
7. **Rehearsal.** The real SettleDeparture and the chosen `post_reveal` (preparation, PostAnchor, Reveal) run on a **copy that is then dropped**. Only the result is kept: success, or the refusal.
   - A handler refusal there is `ROUTE_REHEARSAL_REFUSED` with the program code, when the runtime gave one. Any judge or runtime fault there is `EXECUTION_FAULT`.
   - Purpose: a route that the real Reveal rejects (path, arrival bell, shield, quota) is refused before a host departs, instead of being stranded. No schedule rule is computed; the handler decides.
8. **Commit.** The protocol renders the reply and checks it against 1,048,576 bytes before committing (`RESPONSE_LIMIT` otherwise). The commit sets revision + 1, phase `departed`, the clock unchanged, and the binding.

Any refusal or fault in steps 1 to 8 commits nothing: images, clock, phase, binding, counters and revision are all unchanged, and `instructions`/`recordsHex` are empty.

## Phase steps of a chosen march (real handlers only)

Every instruction after Depart is dispatched over a **bounded sub-map** (`destination_stage::dispatch_sub_map`) of exactly the accounts it lists. Absent planned accounts (`arrival_plan`) are staged for that one instruction and dropped unless the handler created them.

Each instruction is judged by `chosen_march::judge_march` over the whole persistent map:
- exactly the expected receipt: kind; the destination as `province_of`; this host when host-keyed; the bell for a Resolve. PostAnchor and PostSeed leave no wide receipt;
- no image removed;
- every image changed or added named in a per-instruction allow-list;
- at most 96 images;
- the receipt chains of the holding **and every province held** walked;
- lamports conserved by key.

| Step | Instant | Handlers | May change | May add (persistent) |
|---|---|---|---|---|
| `depart_route` | bell 6 +60 s (unchanged) | Depart | citizen, holding, origin, transit_0, payer (as `depart`) | none |
| `settle_departure` | bell 8 +60 s | Resolve origin 5, 6; SettleDeparture (the v3 code, shared) | origin (cursor 5 → 7, entries, chain), `origin_roster`, holding, transit_0, and the handlers' lamport moves; judged by the v3 receipt-kind and all-province chain checks | none |
| `post_reveal` | bell 21 +213 s, then +300 s | 14 × Resolve (bells 6..19, `prepare_destination`); PostAnchor (20, region); Reveal | selected province (cursor 6 → 20, chain +14); payer | THE anchor (20, region), unless it already exists by region; ArrivalDay; ArrivalSlot (faction, 0) |
| `resolve_arrival` | bell 22 +300 s | PostSeed (20, region); Gather (24 positions); Resolve 20 | payer; transit_0; selected province (→ 21) | seed cache (20, region), unless it exists by region; ClashInputs 20; roster |
| `settle_transit` | bell 23 +300 s | SettleTransit | holding, selected province (chain), ClashInputs 20, the slot, transit_0 (closed), payer; the citizen **only** when the handler's camp rule names this march (`camp_works`) | none |
| `dissolve_return` | bell 23 +300 s, bell 24 +60 s, bell 25 +60 s | Resolve 21; Dissolve; Resolve 22; Resolve 23; Return | selected province (→ 24), its roster, citizen, holding | none |

Resolves 21 to 23 stage the synthetic non-arrival pairs per dispatch (or alias identical existing records of the same region). These are the same `stage_seed` construction as the exported fixture's own `destination_*_21..23` pairs.

Outcome judgement:
- The arrival's fate, survivors and engagements are read from the gathered record and the province summary as the handlers wrote them. No enemy is staged at an opened province, so zero engagements is a legitimate result, and there is no `> 0` engagement assertion.
- The fate must be "stays", with survivors between 1 and the departed milli-troops. Any other fate is refused as `ARRIVAL_FATE_UNSUPPORTED`, atomically (the phase stays `revealed`). Returning or destroyed hosts are not wired.
- The settlement requires transit_0 closed and the holding's escrow at 0.
- The credit at Return is the standing milli-troops divided by 1,000, added to the reserve before Return, on the same holding.

**The fixed destination.** The map's `destination` image keeps its key, bytes and role. A chosen route through (129,−1) lists it as a read-only path province of the Reveal; nothing writes it. Region-keyed records are shared by key, whichever province names them. So if the chosen province's region were the fixture destination's region 6, PostAnchor and PostSeed would create the existing fixture images `arrival_anchor` and `arrival_cache` (THE anchor and cache of (20, 6)). The binding's `accounts` then names them.

**Account budget.** Committed: 61 fixture images + 8 land records + at most 4 opened provinces + at most 6 created per march (anchor, cache, day, slot, ClashInputs, roster) = at most 79 of 96. Gather's sub-map holds about 33 images (56 metas). The persistent bound is enforced by `dispatch_sub_map` and by the judge; the runtime's 128 and 96 are unchanged.

**Naming fix (existing helper).** `destination_stage` named a new destination's planned accounts `land_province_{p}_{q}_{role}`. The engine (`provinces`, `opened_count`) and the land module (budget, `opened_provinces`) treat every `land_province_*` name as a province. A persisted roster or ClashInputs would therefore have broken rendering and the opening budget. Default names are now `march_dest_{p}_{q}_{role}` (`destination_stage::default_name`, `ACCOUNT_PREFIX`), with one test line updated. Fixture aliases are unchanged.

## Response schema (v4 delta; everything else as v3)

**Which route is which:**
- `map.route`, `map.destination` and `host.destinationTile` keep their v3 meaning in every phase: the **recorded fixture order's** route, destination (129,−1) and tile 34. A chosen march never changes them.
- The route actually sent is `marchBinding.steps`, with `marchBinding.directions`, `provincesEntered`, `pathProvinces` and `destination`. For `kind: "recorded"` these equal the recorded route. For `kind: "chosen"` they are the host's quote at the departure, fixed from then on.
- A UI must draw the sent march from `marchBinding`, never from `map.route`.

- `"protocol": "wylls-local-march-v4"`.
- `allowed`: `depart_route` is offered while `ready` **and** at least one province has been opened. Order: phase step, `depart_route`, economy, `open_province`, `reset`.
- `horizon.selectedDestinationResolvedNext`: `null` with no binding. Otherwise the bound destination's `RESOLVED_NEXT`, read from its bytes: for `depart` it equals `destinationResolvedNext`.
- `map.provinces[i].history`, a fixed token:
  - `FIXTURE_EXPORT` (the two fixtures);
  - `NONE` (opened, no history; `resolvedNext == openedBell` must hold);
  - `PREPARED_FOR_SELECTED_MARCH`: only the chosen binding's destination, once `marchBinding.preparation` is non-null.
- `combat.enemyFixture`: `true` unless a **chosen** march is bound (no enemy fixture at an opened province).
- `routeQuote`: also present on a `depart_route` refusal `ROUTE_UNREACHABLE` (the host's read-only quote); `null` on every other `depart_route` reply.
- `marchBinding` (between `returned` and `evidence`): `null` while no march is bound, else:

```
"marchBinding": {
  "kind": "recorded" | "chosen",
  "directions": "222222222222",
  "arriveBell": 20,
  "departedMilli": 300000,
  "destination": {"p":"129","q":"-2","tile":60,"accountKeyHex":"...","source":"opened"|"fixture"},
  "steps": [{"p":"129","q":"0","tile":1}, ...],
  "provincesEntered": [{"p":"129","q":"0"},{"p":"129","q":"-1"},{"p":"129","q":"-2"}],
  "pathProvinces": [{"p":"129","q":"0","accountKeyHex":"..."},{"p":"129","q":"-1","accountKeyHex":"..."}],
  "order": {"source": "RECORDED_FIXTURE_ORDER" | "REBUILT_FROM_PUBLIC_MATERIAL_T20",
            "commitHex":"...", "rootHex":"...",
            "labels": [] | ["PUBLIC_SEAL_MATERIAL_NO_SECRECY","REUSED_PUBLIC_IBE_HEADER_T20",
                            "PUBLIC_BEACON_SIGNATURES_T20_S20","ARRIVAL_BELL_20_ONLY",
                            "NO_KEY_NO_SIGNATURE_NO_ENCAPSULATION","PLAINTEXT_VALIDATED_ROUTE_NOT_WALKED"]},
  "preparation": null | {"fromBell":6,"toBell":19,"resolvedNext":20,"scoreNextBell":20,"atUnix":"...",
                         "resolves":14,"region":3,"pairsAliased":0,
                         "provenance":"REAL_RESOLVE_OVER_SYNTHETIC_NON_ARRIVAL_PAIRS",
                         "labels":["SYNTHETIC_NON_ARRIVAL_BEACON_PAIRS","REAL_WIDE_RESOLVE_AT_SUPPLIED_TIME",
                                   "CLOCK_NOT_MOVED","LOCAL_FIXTURE_BEACON_LOG","NO_KEY_NO_SIGNATURE_NO_NEW_CRYPTO"]},
  "accounts": [{"role":"arrival_anchor","keyHex":"..."}, {"role":"day","keyHex":"..."}, ...],
  "trail": ["RECORDED_ORDER_REPRODUCED","REBUILT_FROM_PUBLIC_MATERIAL_T20","REAL_DEPART", ...]
}
```

Example values are illustrative (the tile 60 end of twelve direction-2 steps was observed in v3; region and score values are not pinned).

Field meanings:
- `accounts` names every per-destination planned account that a chosen-march instruction **created or wrote**: role (an `arrival_plan` role: `arrival_anchor`, `arrival_cache`, `archive`, `beacon_log`, `inputs_20`, `day`, `roster`, `slot_F_I`, `inputs_21..23`, `cache_21..23`, `anchor_21..23`) and key. They are listed in first-touch order, at most 16, each key once, every key one of `evidence.accounts`. It is empty for `recorded`.
- `trail` is an ordered list of fixed provenance tokens, at most 24.
  - Chosen march: `RECORDED_ORDER_REPRODUCED`, `REBUILT_FROM_PUBLIC_MATERIAL_T20`, `REAL_DEPART`, `REVEAL_REHEARSED_ON_DROPPED_COPY`, `DESTINATION_PREPARED_THROUGH_BELL_19`, `REAL_POSTANCHOR_PUBLIC_SIG_T20`, then `BEACON_LOG_LOCAL_FIXTURE_STAGED_FOR_REVEAL` or `BEACON_LOG_EXISTING_RECORD`, then `REAL_REVEAL`, `REAL_POSTSEED_PUBLIC_SIG_S20`, `REAL_GATHER`, `REAL_ARRIVAL_RESOLVE`, optionally `CAMP_CITIZEN_LISTED`, then `REAL_SETTLE_TRANSIT`, then `PAIRS_21_23_SYNTHETIC_STAGED_PER_DISPATCH` or `PAIRS_21_23_EXISTING_IDENTICAL_RECORDS`, then `REAL_DISSOLVE`, `REAL_RETURN`.
  - Recorded march: `RECORDED_FIXTURE_ORDER`, `REAL_DEPART` only.
- `instructions` and `recordsHex` for a chosen `post_reveal` are 14 × `Resolve`, then `PostAnchor`, then `Reveal`, with 15 receipts: 14 Resolve receipts for bells 6..19 keyed by the selected province, then one Revealed. For `resolve_arrival` they are `PostSeed`, `Gather`, `Resolve`; for `dissolve_return`, `Resolve`, `Dissolve`, `Resolve`, `Resolve`, `Return`.

New `error` tokens:
- `ROUTE_UNREACHABLE`, `ROUTE_DESTINATION_ORIGIN`, `ROUTE_DESTINATION_FIXTURE` and `ROUTE_DESTINATION_UNSUPPORTED` (refused, no code);
- `ROUTE_REHEARSAL_REFUSED` (refused, `refusalCode` = the rehearsed handler's program code or `null`);
- `ARRIVAL_FATE_UNSUPPORTED` (refused).

`refusalCode` may now be non-null with `HANDLER_REFUSED` or `ROUTE_REHEARSAL_REFUSED`.

## Browser contract

The browser in `permutation-gateway/screens/wide-march-local/` implements this contract (see its README for the checks in detail). Accept only `wylls-local-march-v4`, and keep every v3 check. Then:

1. **Binding shape.** Check `marchBinding`:
   - `null` exactly when the phase is `ready`, or after a reset;
   - `kind` one of the two tokens; `directions` 1..32 digits 0..5; `arriveBell` 20;
   - `destination` with the `p`/`q` strings and `accountKeyHex` of an entry in `map.provinces` with the same `source`, and `tile` 0..60;
   - `steps.length == directions.length`, with the last step equal to the destination's `p`, `q` and `tile`;
   - `provincesEntered` containing the destination, with `pathProvinces` = `provincesEntered` minus the destination, in order, at most 3, each key in `map.provinces`;
   - for `recorded`: destination equal to `map.destination` and tile equal to `host.destinationTile`; `order.source` `RECORDED_FIXTURE_ORDER`, labels empty; `preparation` null; `accounts` empty;
   - for `chosen`: `destination.source` is `opened`; `order.source` `REBUILT_FROM_PUBLIC_MATERIAL_T20` with exactly the six labels; `combat.enemyFixture` false.
2. **Byte-bound cursors.**
   - Re-read the selected destination's `RESOLVED_NEXT` from its account bytes; it must equal `horizon.selectedDestinationResolvedNext`.
   - An opened province with `history: "NONE"` must have `resolvedNext == openedBell`.
   - `PREPARED_FOR_SELECTED_MARCH` is allowed only for the chosen destination with a non-null `preparation`, and then `resolvedNext >= preparation.resolvedNext` (20).
   - `preparation`, when present: `fromBell` equals the province's `openedBell`, `toBell` 19, `resolvedNext` 20, and `resolves == toBell - fromBell + 1`.
3. **Accounts.** Each `accounts[i].keyHex` is in `evidence.accounts` exactly once, without duplicates, and the list is at most 16 entries long.
4. **Transitions** (in addition to the v3 rules).
   - `depart_route` behaves like `depart`: same instant, revision + 1, binding `null` → `chosen`, and the map unchanged (provinces, land, and every opened province's account untouched).
   - A phase step of a **chosen** march:
     - may change, in the map, only the chosen destination's `resolvedNext` (forward only: 6 → 20 at `post_reveal`, → 21 at `resolve_arrival`, → 24 at `dissolve_return`) and its `history` (`NONE` → `PREPARED_FOR_SELECTED_MARCH` once, at `post_reveal`). The `settle_departure` exception below also allows the origin's cursor;
     - leaves every other province summary and account byte-identical, the recorded destination and every non-selected opened province included;
     - **exception, `settle_departure`:** this step is the origin's, and a chosen march runs the **same code as v3** (`engine.rs` `step("settle_departure")`): the real origin Resolves of bells 5 and 6, then SettleDeparture.
       - **What may change:** the origin province (its `resolvedNext` 5 → 7, forward only, a fixture cursor exactly as v3 allows; its entries and chain), `origin_roster`, the holding, `transit_0` (state `settled`), and the lamport moves those handlers make. The browser applies the v3 rule for that step unchanged.
       - **How it is judged natively:** by the v3 checks (each receipt's kind and the receipt-chain walk over the holding and **every** province held), not by a per-account allow-list. The selected and the other opened provinces are therefore chain-checked but not written, because nothing in this step lists them.
       - **What it never touches:** the chosen destination, `marchBinding`, `land` and the funds;
     - may add only accounts that appear in the new `marchBinding.accounts`, and never removes an account;
     - leaves `land` and fund counters unchanged;
     - changes `marchBinding` only in `preparation` (null → object at `post_reveal`), `accounts` (append only) and `trail` (append only). Everything else in the binding is fixed after `depart_route`.
   - A step of a **recorded** march follows the v3 rules; its binding never changes after `depart`.
   - Economy steps leave `marchBinding` and the map unchanged.
   - `reset`: binding `null`, `opened` 0, `selectedDestinationResolvedNext` `null`.
5. **Labels and display.**
   - Show the `trail`, the order labels and the preparation labels verbatim.
   - Describe the chosen march as a local simulation over public fixture material and synthetic non-arrival beacon pairs. It is not chain execution, not a signed order, not a hidden order, not a synchronized world.
   - Never infer a route, tile, fate or credit; take each from the host's reply and its bytes.

## Synthetic inputs and limits (disclose; never present as live-chain proof)

- **Inherited from v3:** the ring seed (`[0x81;32]`, a literal), the rules (prototype candidate `RuleBytes{1,2,2,1}`), the funds, the Season setup, the initial stock and the fixture enemy are all local fixtures.
- **Preparation:**
  - The chosen destination's history for bells 6..19 is real WideResolve output computed at bell 21 +213 s, over **synthetic** non-arrival pairs: literal seed `0x5a…`, T-model rounds, no signature.
  - It was computed after the fact, at the post_reveal instant. It is local deterministic history, not beacon-derived and not a synchronized world clock. The clock never moves backwards.
- **Bell-20 beacon:** the published quicknet signatures `sig_t`/`sig_s` (rounds 32,551,361 and 32,551,652), verified by native BLS. A region with no exported beacon log uses the local fixture log (nothing posted), staged for the Reveal only.
- **Bells 21 to 23:** synthetic pairs, staged per dispatch.
- **Order:** a public-material order. It reuses the published order-opening material unchanged: the `k`, the salt and the 128-byte IBE header of the public seal vector. Anyone can open it. No key pair is generated or derived, no private signing key is used, nothing is signed, and no new key encapsulation is computed. Mock signer flags remain mock (`MOCK_AUTH_NO_SIGNATURE`).
- **Public address arithmetic (allowed and used):** PDA and with-seed derivation of public account addresses only, for example the Season PDA check, `province_address`, `arrival_plan`'s anchor, cache, day, slot, ClashInputs and roster addresses, and the runtime's `AllocateWithSeed` check. These are public hashes of public inputs, not key material.
- **Scope:**
  - Bell 20 only; ring 129 only; at most four opened provinces. Routes enter at most four provinces.
  - Destinations in the origin, or in the fixture destination, are refused.
  - Arrival fates other than "stays" are refused.
  - One holding, one host, transit slot 0, faction slot 0.

## Not wired (explicitly)

- Returning, bounced, withdrawn or destroyed arrivals.
- Marching to the origin province or to the fixture destination via `depart_route`.
- Any arrival bell but 20.
- Second marches, more than one host, other transit slots.
- A second march after `returned` without a `reset`, or a continuous world clock. Every march arrives at bell 20 of a fresh session.
- Opening beyond ring 129, or more than four provinces.
- SBF, compute budget and live-runtime validation.

The rehearsal judges route feasibility only against the state at departure. Economy commands between departure and `post_reveal` change only citizen and holding fields the Reveal does not read for an opened province's free tile. The real `post_reveal` remains the authority and refuses atomically.

## Native tests added

All 14 v4 tests below pass in the final run (92/92, together with the 78 from v3). The bent-route regression `v4_bent_route_to_a_second_opened_province_marches_and_returns` opens (129,−2), (129,−3) and (129,−4), then checks:
- the quote of `222222222222222233332` ends on (129,−3) and enters exactly four provinces;
- the real Depart: the binding's destination, tile (equal to the quote's end), 21 steps, path `[origin, destination, land_province_129_-2]`, and the transit's host, seal root and bell 20;
- all five phases: the 14 preparation Resolves keyed by (129,−3), its cursor 20 → 21 → 24, survivors within the departed troops, escrow 0, transit closed, and the credit added to the reserve, ending in `returned`;
- that the recorded destination, its roster, the path province (129,−2) and the unrelated (129,−4) stay byte-identical throughout;
- that the binding stays fixed after the departure.

All of them use the committed fixtures and the real handlers, and call no exporter or signing code.

**`chosen_march.rs`:**

| Test | Shows |
|---|---|
| `chosen_march_depart_route_refusals_leave_the_sandbox_untouched` | Unknown land, origin, fixture, length, direction and wrong phase are each refused before dispatch; sandbox identical. |
| `chosen_march_depart_route_binds_the_rebuilt_order_and_keeps_the_map` | One real Depart; the transit `seal_root` is the rebuilt root; the commit differs from the recorded one and the header is reused; path `[origin, destination]`; the recorded destination untouched; the clock unchanged; the quote stays a read. |
| `chosen_march_rehearsal_refusal_commits_no_departure` | A foreign record at the chosen ArrivalDay key makes the rehearsed real handler refuse, so no Depart is kept. |
| `chosen_march_judge_refuses_forged_stages` | Beacon with a receipt, missing receipt, wrong kind, unlisted write, removed image, moved chain on an opened province (also `verify_chains`). |
| `chosen_march_planned_names_never_alias_the_province_prefix` | The naming fix. |

**`protocol.rs` (`chosen_march_protocol_tests`):**

| Test | Shows |
|---|---|
| `v4_depart_route_marches_to_the_opened_province_and_returns_to_the_holding` | Opens (129,−2) and quotes it; harvest, farm and train, then `depart_route 222222222222`, train, the departure settlement, harvest, `post_reveal` (14 Resolve receipts for bells 6..19 keyed by the province, then Revealed; cursor 20; `PREPARED_FOR_SELECTED_MARCH`), harvest, `resolve_arrival` (survivors and engagements as the handlers wrote them; cursor 21), `settle_transit` (escrow 0), train, `dissolve_return` (credit = reserve before + survivors / 1,000), harvest. Revision 15, cursor 24, recorded destination and roster byte-identical, binding accounts complete and present. |
| `v4_chosen_march_with_the_full_opening_budget_stays_within_the_image_bound` | Four openings; the full chosen flow; at most 96 images and at most 6 added; the three other opened provinces untouched with `history: NONE`. |
| `v4_depart_route_refusals_are_atomic_and_never_reroute` | Unknown (with the host's quote), origin, fixture, stale, eleven malformed lines, impassable (a path found by breadth-first search over the real masks), unknown land past the opened province, replay, wrong phase (after `depart_route` and after `depart`). Each one leaves images, revision, phase, clock, binding and budget identical. |
| `v4_handler_and_rehearsal_refusals_commit_no_departure` | Depart refused (`Insufficient` code); rehearsal refused; oversized reply. |
| `v4_reset_clears_the_selected_route_and_the_opened_provinces` | After `post_reveal`, a reset gives binding `null`, `opened` 0, and fresh images. |
| `v4_recorded_march_reports_its_binding_and_keeps_the_v3_flow` | Recorded binding and fixture enemy engagement unchanged; an opened province untouched. |
| `v4_quote_stays_read_only_during_a_chosen_march` | |
| `v4_classify_route_maps_only_fixed_tokens` | |

**Updated existing test:** `get_reports_village_bytes_and_the_honest_horizon` (v4 label, null binding). `destination_stage_refuses_conflicting_existing_records_without_mutation` uses `default_name`.

**How to run:**
- Same build as v3: Rust 1.89, offline and locked, feature `local-march-demo`, example `local_march_demo`, target `.local/wide-march-demo/target`.
- Run all 78 previous tests and the 14 v4 tests above (92 in total; all passed in the final run), each by exact name with `--exact --test-threads=1`; stderr prints reply sizes and image counts (use `--nocapture` to see them).
- Run clippy on the example with `-D warnings`.

**Audit of transitive test calls:** `Controller`/`Sandbox` methods, `runtime::dispatch`, `land_bootstrap::{install, open_province}`, `destination_stage::{destination, arrival_plan, prepare_destination, dispatch_sub_map}`, `order_material::{OrderBinding::new, build_order, arrival_beacon}`, and the ABI codecs. Nothing generates or derives a key pair or a private key, nothing signs, nothing uses the network. Public PDA and with-seed address derivation and the published order-opening material (`k`, salt, IBE header, public beacon signatures) are used, as stated under "Synthetic inputs and limits".
