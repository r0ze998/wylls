# Isolated local village-and-march prototype (protocol v2)

One session in which the village economy (Harvest, the fixed Farm, the fixed Train ×10) and the march act on the SAME holding bytes, under one revision and one simulated clock. It is separate from `wide-economy-local`: it never reads or mutates that server/session and shares no balance with it. The frontend is isolated; the separately documented opt-in host support modifies gated Rust files. This is a plain technical prototype, not finished gameplay or artwork.

## Run

Once the separately audited Rust host (v2) has been built at `.local/wide-march-demo/target/debug/examples/local_march_demo`, run:

```
node permutation-gateway/screens/wide-march-local/local-server.mjs
```

The server prints its unique ephemeral `http://127.0.0.1:PORT/...` URL. It does not invoke Cargo, search PATH, accept a binary argument, use a wallet, or connect to a chain. The subprocess has no arguments and receives only literal `LANG`, `LC_ALL`, and `RUST_BACKTRACE` variables. The expected binary must be regular, executable and realpath-identical. A v1 binary is refused at start (protocol label mismatch).

## Contract and safety

See `docs/frontier/map-growth/LOCAL-MARCH-DEMO-PROTOCOL-20261108.md`. Browser intents can choose only the fixed phase actions, `harvest`, `build_farm`, `train`, or reset, plus the current revision. There is no arbitrary account, route, timestamp, instruction, item, unit, count or amount input. Economy commands never move the clock. The clock moves only by the fixed phase steps. At most 8 economy commands run per simulated instant, a demo transport budget that keeps Depart/Dissolve reachable without a time control.

Host/Origin and canonical JSON checks reject cross-origin mutation. Cross-site top-level navigation may load the page but cannot read the API. Static serving is limited to exact local browser files and eight pure production dependencies. No production dispatcher/router, transaction/wallet module, herald, or live RPC is imported.

Requests serialize with revision comparison inside the queue. Host timeout/exit, malformed/extra/unsolicited output and invalid transitions permanently stop mutations and clear the cached view. No retry or respawn. Browser transport uncertainty clears all displayed state and can recover only through explicit GET. GET reads the cached validated server state; it does not re-execute an instruction. Reset compares all account bytes and projected state (village, economy counters, horizon included) to the server's first validated host state, which must carry no economy history. That startup baseline is local, not an independently pinned chain capture.

## What is checked

- Exact schema, fixed labels, enum/bound checks, unique account keys, fixed two-province world coordinates and route endpoints, the fixed economy constants (budget 8, Farm item 0, Train unit 0 ×10) and horizon labels.
- Header magic/version, owner `[0x12;32]`, size, wide world/sort identities for holding and both provinces.
- Holding V2 prefix decoded by production `fcodec.mjs`: every reported village number (8 stores' value/rate/cap/t0, production, 4 queue items, 8 reserves, tier, flags, owner-action stamp), plus unit-0 reserve, escrow, pool owed and tile. Open transits read from the wide trailer. Holding tile cross-checked against the origin province site. The owner citizen named by the holding bytes must be a returned 384-byte program account.
- Province passability mask and `RESOLVED_NEXT` (the honest horizon) compared to account bytes.
- Economy transitions: same phase and instant, the command's counter +1, `reserve[0]` +10 exactly for Train and unchanged otherwise, host/combat/returned/horizon unchanged, and no account other than the holding and its owner citizen changed (data, lamports, owner).
- Phase transitions: next phase, nondecreasing clock, economy counters unchanged, per-instant usage reset exactly when the clock moves.
- Refused commands preserve every account and summary. Successful reset restores startup state.

Host/combat/returned fields (current troops, fate, engagements, survivor and credited counts), clock, instruction names and receipts are Rust projections, not independently replayed or cryptographically verified by the browser. Store values are shown as stored at their own `t0`. The browser never projects accrual or calculates any cost, yield, completion or combat outcome. No claim of order secrecy, authenticated signing, SBF execution, real-chain provenance or a synchronized world clock. The enemy, initial stock (1,900 each), setup and public beacon material are fixtures.

## Map

The camera is browser view state only and never sends a request. It uses BigInt (`wide.mjs`): pans of 1, 1,000 or 10⁹ provinces, a view-only coordinate jump, a radius of 0 to 2 (at most 19 provinces / 1,159 hexes). Cells are drawn as **known** (the two host-returned provinces with passability), **unknown** (dashed, "?": no data; not opened, not generated, not playable) or **outside** (beyond ±2^62; pans past the bound are refused). No global coordinate passes through Number. No new land is generated or claimed, and route sending remains fixed.

Map markers are phase-level projections confirmed against the host lifecycle: ready/origin roster; departed/origin pending spend; travelling and revealed/no exact tile; resolved and settled/destination roster; returned/home reserve credit, not a remustered host. No travel interpolation or wall-clock animation is used.

## Focused checks

```
node --test permutation-gateway/test/wide-march-local-{map,bridge,model,ui}.test.mjs
```

These are synthetic contract and mocked subprocess tests, not evidence of a real host round trip or browser smoke. They do not start an HTTP server. The real-host test `wide-march-local-real-host.test.mjs` needs the built v2 binary.

v2 status (2026-11-08, supervisor runs):

- **Real host:** the integration passed 2/2 against the built v2 binary, alongside the Rust build, the 21 exact example tests and clippy.
- **Focused JS, fixed and confirmed:** the first run went 32/42. Its 10 failures came from a shared-object bug in the synthetic model-test fixture. After the fix (fresh objects, an isolation regression, exact error-code assertions; production checks unchanged), this suite passed 43/43 under `scripts/ci/no-keys-guard.mjs`. The older `wide-economy-local` suites passed 48/48.
- **Chrome smoke on localhost:** Harvest → Farm → Train ×10 → Depart → origin settlement (bell 8) → Harvest → Reveal (bell 21) → Harvest → arrival combat → arrival settlement → Dissolve/Return (bell 25) on one holding; final reserve 907, escrow 0. A view-only jump to `9007199254740993, 0` kept exact digits, showed 7 unknown provinces and left the revision unchanged. The ±2^62 bound showed outside cells and refused 2^62 + 1. Reset restored `ready`, bell 6, reserve 600 and the initial resources, with the revision increased. A screenshot was captured.

This is local evidence only. It does not show polished visuals, infinite or newly playable land, arbitrary routes, a synchronized world clock, real signatures, chain execution or deployment.

## Earlier v1 results (historical, protocol v1 only)

On 2026-11-08 the v1 real host passed 2/2 integration tests, and Chrome passed Depart → same-holding Train → departure settlement → Reveal → arrival combat → transit settlement → survivor return → Reset: 300000 → 297633 surviving milli-units, 297 returned whole units, reserve unit 0 600 → 610 → 907, zero remaining escrow, reset at revision 8. These are local v1 host results, not chain execution or signing evidence, and not evidence for v2.
