# Isolated local march prototype

Separate session from `wide-economy-local`; it never reads or mutates the existing economy server/session. The frontend is isolated; the separately documented opt-in host support modifies gated Rust files. This is a plain technical prototype, not finished gameplay or artwork.

## Run

Once the separately audited Rust host has been built at `.local/wide-march-demo/target/debug/examples/local_march_demo`, run:

```
node permutation-gateway/screens/wide-march-local/local-server.mjs
```

The server prints its unique ephemeral `http://127.0.0.1:PORT/...` URL. It does not invoke Cargo, search PATH, accept a binary argument, use a wallet, or connect to a chain. The subprocess has no arguments and receives only literal `LANG`, `LC_ALL`, and `RUST_BACKTRACE` variables. The expected binary must be regular, executable and realpath-identical.

## Contract and safety

See `docs/frontier/map-growth/LOCAL-MARCH-DEMO-PROTOCOL-20261108.md`. Browser intents can choose only the fixed phase actions, Train, or Reset plus the current revision. No arbitrary account, route, timestamp, instruction, or amount input exists. Train is fixed unit0/count10 on this march's holding.

Host/Origin and canonical JSON checks reject cross-origin mutation. Cross-site top-level navigation may load the page but cannot read the API. Static serving is limited to exact local browser files and eight pure production dependencies. No production dispatcher/router, transaction/wallet module, herald, or live RPC is imported.

Requests serialize with revision comparison inside the queue. Host timeout/exit, malformed/extra/unsolicited output and invalid transitions permanently stop mutations and clear the cached view. No retry or respawn. Browser transport uncertainty clears all displayed state and can recover only through explicit GET. GET reads the cached validated server state; it does not re-execute an instruction. Reset compares all account bytes and projected state to the server's first validated host state. That startup baseline is local, not an independently pinned chain capture.

## What is checked

- Exact schema, fixed labels, enum/bound checks, unique account keys, fixed two-province world coordinates and route endpoints.
- Header magic/version, owner `[0x12;32]`, size, wide world/sort identities for holding and both provinces.
- Holding V2 prefix decoded by production `fcodec.mjs`: unit0 reserve, escrow, pool owed and tile. Open transits read from wide trailer. Holding tile cross-checked against origin province site.
- Province passability mask compared to account bytes. Display geometry reuses production BigInt-relative coordinates and tile offsets. No global Number-coordinate conversion.
- Host ref world/province/site/generation correspondence; revision, phase, train flag and nondecreasing simulated clock.
- Refused commands preserve every account and summary. Successful reset restores startup state.

Host/combat/returned fields (including current troops, fate, engagements, survivor and credited counts), clock, instruction names and receipts are Rust projections, not independently replayed or cryptographically verified by the browser. No claim of order secrecy, authenticated signing, SBF execution or real-chain provenance. Enemy/setup/public beacon material are fixtures; dispatch, arithmetic and combat stay in the Rust host. The browser never calculates game outcomes.

## Focused checks

```
node --test permutation-gateway/test/wide-march-local-{map,bridge,model,ui}.test.mjs
```

These are synthetic contract and mocked subprocess tests, not evidence of a real host round trip or browser smoke. They do not start an HTTP server. Real-host and browser integration are separate validation stages; their completed checks are recorded below.

Map markers are phase-level projections confirmed against the host lifecycle: ready/origin roster; departed/origin pending spend; travelling and revealed/no exact tile; resolved and settled/destination roster; returned/home reserve credit, not a remustered host. No travel interpolation or wall-clock animation is used.

## Real-host integration and Chrome smoke (2026-11-08)

`wide-march-local-real-host.test.mjs` passed 2/2 real-host integration tests. Actual Chrome UI passed Depart → same-holding Train → departure settlement → Reveal → arrival combat → transit settlement → survivor return → Reset.

The real host reported 300000 → 297633 surviving milli-units, 297 returned whole units, reserve unit0 600 → 610 → 907, and zero remaining escrow. Reset restored the initial state at revision 8. These are local host results, not chain execution or signing evidence. The server uses an ephemeral loopback port; no fixed URL is part of this result.

The fixed scenario precomputes the destination through bell 19 while the command clock starts at departure bell 6. This does not validate a synchronously simulated whole world.
