# Isolated local village-and-march prototype (protocol v4)

One session in which the village economy (Harvest, the fixed Farm, the fixed Train ×10), the recorded march, the opening of ring-129 provinces and (v4) a march to a chosen, session-opened province act on the SAME sandbox, under one revision and one simulated clock. It is separate from `wide-economy-local`: it never reads or mutates that server/session and shares no balance with it. This is a plain technical prototype, not finished gameplay or artwork.

**v4 status (2026-11-08): validated locally.** The browser implements the contract in `docs/frontier/map-growth/LOCAL-CHOSEN-MARCH-20261108.md` against the native `protocol.rs` / `chosen_march.rs` / `engine.rs` of this worktree. All results below are local evidence:
- no key pair was generated or derived, no private key was used, and no signature was created;
- no real chain transaction was made;
- the only signatures involved are prerecorded, published quicknet beacon signatures, which the native host reads and verifies.

Local validation results (final):
- **Focused JS:** all six v4 files (`wide-march-local-{map,bridge,model,ui,receipts,real-host}.test.mjs`) pass 94/94, with no skips or failures (log `.local/cc-chosen-march-20261108/browser-final-tests.log`). The older `wide-economy-local` regression passes 48/48.
- **Native host:** 92/92 example tests by exact name; executable build and example clippy with `-D warnings` clean.
- **Actual replies:** all 12 actual native v4 responses passed the browser model, transition and quote checks.
- **Chrome on localhost, chosen march to (129,−2):**
  - open (129,−2) and quote twelve direction-2 steps;
  - Harvest, Farm and Train invalidated the quote; re-quote;
  - the explicit `depart_route`, then departure settlement, reveal with the destination preparation, harvest, arrival resolve, transit settlement, and dissolve and return.
  - Final reserve 910, escrow 0; the actual selected route was displayed. Reset gave reserve 600 and no opened province.
- **Chrome on localhost, chosen march to (129,−3):**
  - open (129,−2) and (129,−3), quote `222222222222222233332`;
  - the explicit `depart_route` to (129,−3) tile 60, then departure settlement, reveal, resolve, settlement and return.
  - Reserve 900, returned 300, escrow 0. The browser was left at `returned`, revision 20.
- **Native flow** to (129,−3), tile 60, via the same directions, with its native regression.

Historical fix note: an interim focused run went 87/89. Both failures were synthetic test-data issues, not production checks, and were fixed in the tests only:
- a quote fixture kept the previous mutation's evidence, but a read-only host quote renders none;
- a substituted-receipt case expected `ReceiptChain` where the accurate refusal is `ReceiptChainEnd`. The holding chain is walked first and ends with the wrong head.

Not exercised against the real host or in Chrome: `ROUTE_DESTINATION_UNSUPPORTED`, `ROUTE_REHEARSAL_REFUSED` and `ARRIVAL_FATE_UNSUPPORTED`. They are covered by native tests and synthetic browser tests only. The v3 results below are v3 evidence only.

## Run

Once the Rust host (v4) has been built at `.local/wide-march-demo/target/debug/examples/local_march_demo`:

```
node permutation-gateway/screens/wide-march-local/local-server.mjs
```

The server prints its unique ephemeral `http://127.0.0.1:PORT/...` URL. It does not invoke Cargo, search PATH, accept a binary argument, use a wallet, or connect to a chain. The subprocess has no arguments and receives only literal `LANG`, `LC_ALL` and `RUST_BACKTRACE`. A v1, v2 or v3 binary is refused at start (protocol label), and so is a first state that already has opened land, economy history or a march.

## Contract and safety

Browser intents can choose only: the fixed phase actions (`depart` sends the recorded order); `harvest`, `build_farm`, `train`; reset; opening one unknown ring-129 cell the map offers (`/api/open`); a non-mutating route quote (`/api/quote`); and (v4) one chosen departure (`/api/depart_route`, body exactly `{"expectedRevision":N,"dirs":"…"}`). The chosen departure is sent only by its own button, only while `ready`, only when the host offers `depart_route`, and only from the current, reachable host quote of exactly the selected directions ending in a session-opened province; it sends that quote's directions and the shown revision. A quote never departs. The host re-quotes the directions, refuses the origin, the fixture destination and unsupported provinces, rehearses the real settlement and Reveal on a dropped copy, and commits all or nothing. A refusal changes nothing; nothing is re-sent automatically and nothing falls back to the recorded route.

Host/Origin and canonical JSON checks reject cross-origin mutation on every mutation route, `/api/depart_route` included; requests serialize with the revision compared inside the queue. Static serving is limited to the exact files of `LOCAL_FILES` (now including `local-receipts.mjs` and `local-route.mjs`) and eight pure production dependencies. Host failure or an invalid reply makes the session uncertain for good (no retry, no respawn); a browser transport failure clears the shown state until an explicit GET.

## What the browser checks (v4)

Everything v3 checked (schema, labels, byte correspondence of the holding, village, provinces and land records, the economy and opening transitions), plus:

- **Image bound:** at most 96 accounts (the host's persistent bound; every image is in `evidence.accounts`).
- **Binding (`marchBinding`):** null exactly while `ready`. Its `steps` are re-walked in the browser from its `directions` and the host's origin tile (`local-route.mjs`, a BigInt port of `world_index/tiles.rs`), must stand only on returned, passable tiles (each province's own mask bytes) and end at the destination's tile; `provincesEntered` is recomputed; `pathProvinces` is that list without the destination, with the map's account keys. Recorded: the recorded destination, tile, route, order source, empty labels, accounts and preparation, trail `RECORDED_FIXTURE_ORDER, REAL_DEPART`. Chosen: an opened destination, `REBUILT_FROM_PUBLIC_MATERIAL_T20` with exactly the six order labels, the exact trail of the phase, `enemyFixture` false, a preparation only from `revealed` on (opened bell → 19, `resolves` = 20 − opened bell, the five labels, the province's region). Accounts: known roles, each key present once.
- **Cursors and history:** `selectedDestinationResolvedNext` is the bound destination's RESOLVED_NEXT bytes. `NONE` requires no resolve history; `PREPARED_FOR_SELECTED_MARCH` only on the chosen, prepared destination at cursor ≥ 20.
- **Transit record:** while a march is in flight, exactly one 288-byte transit of this host (version byte and host reference), program-owned, in the phase's state (1, 2, 2, 4), from the origin, for bell 20, whose seal root equals the binding's `order.rootHex` (and, once gathered, whose destination key is the bound destination's); none otherwise. This is a layout read; the browser does not open, decrypt or authenticate the sealed order, and does not rebuild or verify the order material (that is the host's: the recorded order reproduced byte for byte, then rebuilt).
- **Transitions:** `depart_route` binds exactly the sent directions, at the same instant, with the standing troops as `departedMilli`. A chosen phase step may change the chosen destination's cursor only to 20 (`post_reveal`), 21 (`resolve_arrival`) and 24 (`dissolve_return`), its history once (`post_reveal`), and its bytes only outside the GATED ranges (header identity, prefix identity, opened bell, terrain, trailer), never its owner or lamports; the origin may resolve forward (`settle_departure` writes it in both marches); the recorded destination and every other opened province stay byte-identical. No account is removed (a closed transit is an emptied image); only a chosen `post_reveal`/`resolve_arrival` may add accounts, each named in the new binding. Land records stay byte-identical except through `open_province`. The binding changes only by `preparation` (null → object at `post_reveal`) and append-only `accounts`/`trail`. A chosen arrival has no enemy: zero engagements is legitimate; survivors must be 1..departed. Return credits the reserve by exactly `creditedUnits`.
- **Receipt chains (`local-receipts.mjs`):** for every committed command except reset, the holding (by its host's holding reference, bound to the holding bytes) and every held province (by its full key, bound to its bytes; a newly opened one from the fresh `(0, zero)` header) are walked with the ported ABI `verify_chain` from the previous reply's header bytes through the receipts to the new reply's. No link to an undeclared identity is accepted, only the command's own non-chain kinds (Revealed, Gathered) may appear, and the kinds, Resolve bells, provinces, host and sealed destination are the command's plan (14 preparation Resolves for an opened bell of 6). The instruction names must be the command's. Payload facts and digests are not replayed.

Host, combat and returned figures, clock, instruction names and receipts' payloads are Rust projections, not independently replayed or cryptographically verified by the browser. Nothing is inferred: route, tile, fate and credit come from the host's reply and its bytes.

## Disclosed limits (not supported, never presented as live-chain proof)

Synthetic or public inputs: the ring-129 seed literal, the prototype candidate rules, local funds, the Season setup, the initial stock and the fixture enemy; a chosen destination's history for bells 6..19 computed at post_reveal by real WideResolve over **synthetic non-arrival beacon pairs**; the bell-20 beacon from prerecorded, published quicknet signatures, verified natively; a public-material order anyone can open. No key pair is generated or derived, no private key is used, no signature or new key encapsulation is created, and signer flags are mock. Scope: arrival bell 20 only, ring 129 only, at most four opened provinces, routes of at most four provinces, one holding, one host, transit slot 0. Refused: destinations in the origin or the fixture destination, provinces with resolve history or entries, arrival fates other than "stays". Not wired: returning/bounced/destroyed arrivals, other bells, second marches, other rings, SBF/compute validation, a synchronized world clock.

## Focused checks

```
node --test permutation-gateway/test/wide-march-local-{map,bridge,model,ui,receipts}.test.mjs
node --test permutation-gateway/test/wide-march-local-real-host.test.mjs   # needs the built v4 binary
```

`wide-march-local-synthetic.mjs` (test helper, not served) builds byte-coherent SYNTHETIC v4 snapshots with the receipt module's own encoder and chain rule; it never calls a native or fixture generator and never generates keys or signs. These are contract tests, not evidence of a host round trip. `wide-march-local-real-host.test.mjs` needs the built v4 binary: both recorded flows, opening and quoting, and the chosen flow (open (129,−2), quote 12 × direction 2, `depart_route`, every phase with the economy, return), with the unknown/origin/fixture/impassable/stale/replay/wrong-phase refusals.

## Earlier results (historical)

v3 (2026-11-08): frontend and real host 64/64, Rust 78/78; Chrome on localhost opened (129,−2), a 12-step direction-2 quote was reachable into (129,−2) tile 60, and the full recorded loop ended with reserve 907 and escrow 0. v2 and v1 results are evidence for those protocols only.
