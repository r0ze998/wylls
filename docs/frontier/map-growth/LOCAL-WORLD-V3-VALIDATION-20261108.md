# Local world v3: validation record (2026-11-08)

This is the authoritative status of the isolated local village-and-march demo at protocol `wylls-local-march-v3`. It is a private, keyless, local prototype: not chain execution, not a deployment, and not a published service. The detailed contracts are in:
- `LOCAL-MARCH-DEMO-PROTOCOL-20261108.md`: the stdio protocol, JSON schema and browser checks;
- `LOCAL-LAND-BOOTSTRAP-20261108.md`: the land records and the golden gate;
- `permutation-frontier/examples/local_march_demo/README.md`: the host;
- `permutation-gateway/screens/wide-march-local/README.md`: the browser and server.

## Delivered in v3

One serialized controller, one revision, one simulated clock, and the same holding bytes for everything below.

- **Village economy:** Harvest, the fixed Farm Build (item 0) and the fixed Train (unit 0 ×10) run on the real program dispatch. They never move the clock and are limited to 8 per simulated instant.
- **Fixed march:** Depart, departure settlement, Reveal, arrival Resolve with hostile combat, transit settlement, and Dissolve/Return run with the real handlers. The route is the recorded one, (129,0) → (129,−1).
- **Opening ring-129 provinces:** `open_province REV P Q` runs the real `WideOpenProvince` handler at the session's simulated time, through `land_bootstrap`'s staged, judged path.
  - The LOCAL land records (ring seed, rules configuration, six funds) are installed into the baseline only after the real handler re-opens both exported provinces and reproduces their gated bytes. Reset rebuilds that baseline.
  - At most four extra provinces may be opened, on ring 129 only, within the existing 96-image cap.
  - Every refusal commits nothing.
- **Route quote:** `quote_route DIRS` (1..=32 directions) validates a chosen path with the shared `world_index::tiles::verify_route` and the real passability bytes of every province the host holds, opened ones included. It is non-mutating, and a step into unknown land is refused as unknown.
- **Browser:**
  - **Byte checks:** it re-reads every reported number it checks from the returned account bytes: holding, village, provinces (key, wedge, region, cursors, mask, ring seed) and land records.
  - **Transition checks:** it judges each transition.
    - An opening changes exactly the new province, the ring seed record and one fund.
    - Economy steps leave the map and land unchanged.
    - Phase steps may advance only a fixture's byte-bound resolve cursor, and only forward.
  - **Display:** only cells the host returned are drawn as land. Unknown ring-129 cells offer an "open" button.

## Tested but not wired

Two helper modules are declared in `main.rs` and covered by their own tests. **No command calls them.**

- `order_material.rs` (`LOCAL-ORDER-MATERIAL-20261108.md`): march-order material for arrival bell 20, rebuilt from published test-vector bytes.
- `destination_stage.rs` (`LOCAL-DESTINATION-STAGE-20261108.md`): preparing an opened province's resolve history up to the arrival bell, including a sub-map dispatch helper.

## Validation observed (supervisor runs)

- **Rust:** 78/78 example tests, each selected by exact name, after rustfmt:
  - `land_bootstrap`: 14;
  - `order_material`: 9;
  - `destination_stage`: 14 (9, plus 5 sub-map tests);
  - the engine, protocol and runtime tests: the remaining 41, including the 13 v3 land-integration tests.
- **Clippy:** the example's clippy with `-D warnings` is clean.
- **`git diff --check`:** clean.
- **Frontend:** 64/64, made up of 60 synthetic contract tests (`wide-march-local-{map,bridge,model,ui}.test.mjs`) and 4 real-host tests (`wide-march-local-real-host.test.mjs`) against the built binary.
- **Regression:** the older `wide-economy-local` suites passed 48/48.
- **Chrome on localhost (loopback):**
  - Opened (129,−2) at bell 6 (revision 1).
  - A 12-step direction-2 quote was reachable into (129,−2), tile 60.
  - Harvest, Farm, Train, Depart, departure settlement, Reveal, Harvest, arrival resolve, transit settlement and Dissolve/Return all worked. Final reserve 907, escrow 0.
  - Reset restored the two fixture provinces and reserve 600. Re-opening (129,−2) then gave `ready` at revision 13.
  - A screenshot is a local artifact only.

## Toolchain and commands

- **Host:**
  - Rust 1.89, offline and locked, feature `local-march-demo`, example `local_march_demo`, isolated target `.local/wide-march-demo/target`.
  - Tests are run one by one with `--exact --test-threads=1`, never through unrelated key-bearing suites.
  - Clippy is run on the example with `-D warnings`.
- **Frontend:** `node --test permutation-gateway/test/wide-march-local-{map,bridge,model,ui}.test.mjs` under `scripts/ci/no-keys-guard.mjs`. The real-host test runs only after the binary is built.
- **Serve locally:** `node permutation-gateway/screens/wide-march-local/local-server.mjs`. It binds to loopback only and prints a fresh ephemeral port each run. That URL is not a durable or published address.

## Honest limits

- **Synthetic and candidate inputs:**
  - The ring-129 seed is a synthetic literal (`[0x81;32]`, round 32,547,581), not a verified beacon output.
  - The rules are the original prototype candidate `RuleBytes{1,2,2,1}`, not a product rule decision.
  - The funds are local fixtures.
  - The enemy resident, initial stock, Season setup and non-arrival beacons are fixtures.
- **Public material:** the arrival beacon signatures are published test material, checked with native BLS math. The public fixture seal material gives no order secrecy.
- **Mock auth:** `MOCK_AUTH_NO_SIGNATURE`. Payer and actor signer flags are simulated. No key pair is generated or derived, no private signing key is used, and no signature is created. The demo does use published fixture material: the symmetric order-opening bytes from the public test vectors, and the public beacon signatures it verifies natively. That material is public, so it gives no secrecy and no authentication.
- **Runtime:** the mock runtime emulates System CPIs and enforces account and lamport constraints. It is not SBF, not compute-budget validation, and not an independent verifier of every handler byte. Host, combat and returned figures are Rust projections, not replayed by the browser.
- **Not a shared world:** one holding on one clock. The destination was precomputed through bell 19 before export, and there is no world clock shared with other sessions.

## Not yet supported

- **Marching to a chosen destination:** the real march still follows the recorded route to (129,−1), and a quote is never an execution.
- **Opened provinces as destinations:** they have no resolve history yet, so they cannot be marched to.
- **Other rings and larger worlds:** rings other than 129, more than four openings, and infinite or synchronized worlds.

## Historical failures, all resolved

- **v2 JS run, 32/42:** a shared-object bug in the synthetic test fixture. Fixed with fresh objects plus an isolation regression; production checks were unchanged.
- **Rust E0596** in a route test (`let mut`).
- **Real-host 2/3:** a geometry assumption about unknown land. Replaced with geometry derived from the host's provinces.
- **`provincesEntered` expectation:** the host does list the start province when a step enters it, so the test now expects `[(129,0),(129,−1)]`.
- **v3 JS run, 60/63:**
  - Both real-host march flows were refused (`IdentityChanged`) at `settle_departure`, because phase steps compared the whole map while real Resolve advances a fixture's `resolvedNext`. Fixed by allowing only that byte-bound cursor to move forward, with tamper regressions.
  - A map test expected openable cells where none exist.
- **v3 interim run, 63/64:** a map test counted a province outside the radius-2 view. It now asserts the visible counts and the six-province cap separately.
- **Clippy `explicit_auto_deref`** in `order_material.rs`: one character.

New feature work continues in a separate worktree, so this validated state stays stable.
