# Isolated local village-and-march prototype (protocol v3)

One session in which the village economy (Harvest, the fixed Farm, the fixed Train ×10), the march and the opening of ring-129 provinces act on the SAME sandbox, under one revision and one simulated clock. It is separate from `wide-economy-local`: it never reads or mutates that server/session and shares no balance with it. The frontend is isolated; the separately documented opt-in host support modifies gated Rust files. This is a plain technical prototype, not finished gameplay or artwork.

**Latest validation (authoritative):** `docs/frontier/map-growth/LOCAL-WORLD-V3-VALIDATION-20261108.md`. Final checks are all green there: frontend and real host 64/64, Rust 78/78. The interim notes below are history.

**v3 status (supervisor runs, 2026-11-08, interim):**
- **Rust:** all 73 exact-name example tests passed, including the 9 destination-module tests.
- **Raw host smoke:** `get` → open (129,-2) → 12-step quote → `get`, accepted by this model's `validateState`/`checkOpen`/`checkQuote`.
- **JS:**
  - First run: 60/63. Real-host march flows were refused at `settle_departure` (phase steps compared the whole map, but real Resolve advances a fixture's `resolvedNext`). After the model fix, both real-host full flows pass.
  - Interim rerun: 63/64. The only failure was a map test expecting a province outside the radius-2 view to be counted. It now asserts the visible counts and the six-province cap separately, and awaits a rerun.
- **Chrome on localhost:**
  - Opened (129,-2) at bell 6 (revision 1).
  - A 12-step direction-2 quote was reachable into (129,-2), tile 60.
  - The full Harvest/Farm/Train/march loop ended with reserve 907 and escrow 0.
  - Reset restored the two fixture provinces and reserve 600, and (129,-2) could be re-opened (`ready`, revision 13).
  - A screenshot is a local artifact.

The v2 results below are for protocol v2 only.

## Run

Once the separately audited Rust host (v3) has been built at `.local/wide-march-demo/target/debug/examples/local_march_demo`, run:

```
node permutation-gateway/screens/wide-march-local/local-server.mjs
```

The server prints its unique ephemeral `http://127.0.0.1:PORT/...` URL. It does not invoke Cargo, search PATH, accept a binary argument, use a wallet, or connect to a chain. The subprocess has no arguments and receives only literal `LANG`, `LC_ALL`, and `RUST_BACKTRACE` variables. The expected binary must be regular, executable and realpath-identical. A v1 or v2 binary is refused at start (protocol label mismatch), and so is a first state that already has opened land.

## Contract and safety

See `docs/frontier/map-growth/LOCAL-MARCH-DEMO-PROTOCOL-20261108.md`. Browser intents can choose only:
- the fixed phase actions;
- `harvest`, `build_farm` and `train`;
- reset;
- opening one unknown ring-129 cell the map offers (`/api/open` with that cell's canonical `p`, `q` strings);
- a non-mutating route quote.

Each mutating intent also carries the current revision. There is no arbitrary account, timestamp, instruction, item, unit, count or amount input. Economy commands and openings never move the clock; the clock moves only by the fixed phase steps. At most 8 economy commands run per simulated instant, a demo transport budget that keeps Depart/Dissolve reachable without a time control. At most four provinces can be opened per session (the demo budget), on ring 129 only.

Host/Origin and canonical JSON checks reject cross-origin mutation. Cross-site top-level navigation may load the page but cannot read the API. Static serving is limited to exact local browser files and eight pure production dependencies. No production dispatcher/router, transaction/wallet module, herald, or live RPC is imported.

Requests serialize with revision comparison inside the queue. Host timeout/exit, malformed/extra/unsolicited output and invalid transitions permanently stop mutations and clear the cached view. No retry or respawn. Browser transport uncertainty clears all displayed state and can recover only through explicit GET. GET reads the cached validated server state; it does not re-execute an instruction. Reset compares all account bytes and projected state (village, economy counters, horizon, land included) to the server's first validated host state. That state must carry no economy history and no opened land. The startup baseline is local, not an independently pinned chain capture.

## Land (v3)

The host installs LOCAL land records into its baseline (`permutation-frontier/examples/local_march_demo/land_bootstrap.rs`; `docs/frontier/map-growth/LOCAL-LAND-BOOTSTRAP-20261108.md`), and does so only after the real `WideOpenProvince` handler has re-opened both exported provinces and matched their gated bytes. The page states their provenance briefly:
- **ring seed:** a synthetic literal, not a verified beacon output;
- **rules:** the original prototype candidate `RuleBytes{1,2,2,1}`, not a product rule decision;
- **funds:** local mock funds;
- **auth:** a mock payer signer flag with no signature.

An opening runs the real handler at the session's simulated time. A cell is drawn as land only after the host's reply passes the model. An opened province has no resolve history and is not yet a march destination.

## What is checked

- Exact schema, fixed labels, enum/bound checks, unique account keys, fixed fixture world coordinates and route endpoints, the fixed economy constants (budget 8, Farm item 0, Train unit 0 ×10) and horizon labels.
- Header magic/version, owner `[0x12;32]`, size, wide world/sort identities for the holding and every province.
- Holding V2 prefix decoded by production `fcodec.mjs`: every reported village number (8 stores' value/rate/cap/t0, production, 4 queue items, 8 reserves, tier, flags, owner-action stamp), plus unit-0 reserve, escrow, pool owed and tile. Open transits read from the wide trailer. Holding tile cross-checked against the origin province site. The owner citizen named by the holding bytes must be a returned 384-byte program account.
- Every province, read from its own bytes:
  - its sort key equals the reported `p`, `q`, and its prefix `WEDGE` equals that key's wedge;
  - `REGION`, `RESOLVED_NEXT`, `OPENED_BELL` and the passability mask;
  - the trailer's ring seed and seed round equal the ring seed record's;
  - for an opened province: ring 129, `resolvedNext` equal to `openedBell`, `openedBell` not after the clock, and funded lamports equal to its own lamports.
- Land records:
  - the ring seed: ring 129, Seeded, the pinned seed and round, and `provincesCreated`;
  - the rules configuration: version, rule bytes and authority;
  - six funds, whose opening counters add up to `opened`;
  - the provenance tokens, required exactly.
- Economy transitions: same phase and instant, the command's counter +1, `reserve[0]` +10 exactly for Train and unchanged otherwise, host/combat/returned/horizon/land unchanged, and no account other than the holding and its owner citizen changed (data, lamports, owner).
- Opening transitions:
  - phase, clock, economy, village, host, holding, combat, returned, horizon and the fixed route are unchanged;
  - exactly the asked province is added, opened at the current bell;
  - `opened` and `provincesCreated` each rise by one;
  - exactly three accounts change: the new province is added, the ring seed is modified, and one fund pays exactly the new province's lamports.
- Phase transitions: next phase, nondecreasing clock, economy counters and land unchanged, per-instant usage reset exactly when the clock moves. The map may change only in a fixture's byte-bound `resolvedNext`, which, like the horizon, may only move forward. Every opened province's summary and account stay byte-identical. Economy steps leave the map unchanged.
- Refused commands preserve every account and summary. Successful reset restores startup state.

Host/combat/returned fields (current troops, fate, engagements, survivor and credited counts), clock, instruction names and receipts are Rust projections, not independently replayed or cryptographically verified by the browser. Store values are shown as stored at their own `t0`. The browser never projects accrual or calculates any cost, yield, completion, combat outcome or terrain. No claim of order secrecy, authenticated signing, SBF execution, real-chain provenance or a synchronized world clock. The enemy, initial stock (1,900 each), setup, public beacon material and the land records are fixtures.

## Map

The camera is browser view state only and never sends a request. It uses BigInt (`wide.mjs`): pans of 1, 1,000 or 10⁹ provinces, a view-only coordinate jump, a radius of 0 to 2 (at most 19 provinces / 1,159 hexes). Cells are drawn as one of:
- **known:** an exported fixture province, with its passability;
- **opened:** a province the real handler opened this session, drawn in a distinct colour from its own returned mask;
- **unknown:** dashed, "?": no data; not opened, not generated, not playable;
- **outside:** beyond ±2^62; pans past the bound are refused.

Each unknown ring-129 cell in view gets an "open" button. No global coordinate passes through Number. The march that is actually sent still follows the fixed route.

Map markers are phase-level projections confirmed against the host lifecycle: ready/origin roster; departed/origin pending spend; travelling and revealed/no exact tile; resolved and settled/destination roster; returned/home reserve credit, not a remustered host. No travel interpolation or wall-clock animation is used.

## Route chooser (validation only)

The player can build a directions string (1..=32, each 0..5) and send `quote_route`, a **non-mutating** host query. The Rust host validates the chosen path with the shared ABI route model (`world_index::tiles::verify_route`) and the real passability bytes of every province it holds, opened ones included. The page shows every step as host-returned, unknown, or impassable, from the returned `routeQuote`. A step into a province the host does not hold is refused as unknown land.

A quote is **not** a sent march: the real march still follows the recorded fixed route. Marching to a chosen destination is not implemented yet. See the protocol document's "World expansion" section for what it would still need.

## Focused checks

```
node --test permutation-gateway/test/wide-march-local-{map,bridge,model,ui}.test.mjs
```

These are synthetic contract and mocked subprocess tests, not evidence of a real host round trip or browser smoke. They do not start an HTTP server. The real-host test `wide-march-local-real-host.test.mjs` needs the built v3 binary.

v2 status (2026-11-08, supervisor runs; protocol v2 only):

- **Real host:** the integration passed 2/2 against the built v2 binary, alongside the Rust build, the 21 exact example tests and clippy.
- **Focused JS, fixed and confirmed:** the first run went 32/42. Its 10 failures came from a shared-object bug in the synthetic model-test fixture. After the fix (fresh objects, an isolation regression, exact error-code assertions; production checks unchanged), this suite passed 43/43 under `scripts/ci/no-keys-guard.mjs`. The older `wide-economy-local` suites passed 48/48.
- **Chrome smoke on localhost:** Harvest → Farm → Train ×10 → Depart → origin settlement (bell 8) → Harvest → Reveal (bell 21) → Harvest → arrival combat → arrival settlement → Dissolve/Return (bell 25) on one holding; final reserve 907, escrow 0. A view-only jump to `9007199254740993, 0` kept exact digits, showed 7 unknown provinces and left the revision unchanged. The ±2^62 bound showed outside cells and refused 2^62 + 1. Reset restored `ready`, bell 6, reserve 600 and the initial resources, with the revision increased. A screenshot was captured.

This is local evidence only. It does not show polished visuals, infinite or newly playable land, arbitrary routes, a synchronized world clock, real signatures, chain execution or deployment.

## Earlier v1 results (historical, protocol v1 only)

On 2026-11-08 the v1 real host passed 2/2 integration tests, and Chrome passed Depart → same-holding Train → departure settlement → Reveal → arrival combat → transit settlement → survivor return → Reset: 300000 → 297633 surviving milli-units, 297 returned whole units, reserve unit 0 600 → 610 → 907, zero remaining escrow, reset at revision 8. These are local v1 host results, not chain execution or signing evidence, and not evidence for v2.
