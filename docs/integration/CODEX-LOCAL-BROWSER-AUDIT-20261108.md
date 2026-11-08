# Original-page route preview: audit and verification

Target: the original `frontier/index.html` and route preview from `f764d1fb`,
with an explicit local `?devWallet=off` opt-out added for inspection.
Runner: `permutation-gateway/screens/codex-route-preview.screen.mjs`.

## Runner and dependency boundary

- Node imports built-in test/assert/http/fs/path/url, the existing no-key page
  helper, and Playwright Core **1.58.2**. No fixture world constructor, package
  script, npm lifecycle script, key-guard self-test, chain or Rust test runs.
- `codex/no-key-node.mjs` only replaces prohibited crypto entrypoints with
  counted failures. It never calls them to test the guard. Playwright is loaded
  afterwards. Node WebCrypto entrypoints are also guarded. A counted attempt
  sets a failing exit code even if a caller catches its refusal. This guard
  supplements the following call-path review.
- Playwright's scanned library contains key generation and signing in
  `server/utils/crypto.js:generateSelfSignedCertificate`. Its caller is
  `socksClientCertificatesInterceptor.js:loadDummyServerCertsIfNeeded`, reached
  when creating a ClientCertificatesProxy. `Browser.newContext` only creates
  that proxy when `options.clientCertificates?.length` is nonzero. This test
  does not set client certificates or a proxy. It uses local launch, not a
  persistent context or Selenium; an inherited Selenium URL is refused.
- Chromium runs from the already installed 1.58.2 browser bundle, with
  `chromiumSandbox:true`. No unsafe-origin flag, HTTPS-error override,
  self-signed certificate, external browser profile or browser installation.
- The server imports no game helper. It reads committed router JSON and serves
  static files. It binds to 127.0.0.1, refuses every non-GET/HEAD request, and
  cannot forward anything to a chain or outside service.

## Browser boot and interaction boundary

The page's relative-import closure was scanned (261 files); sensitive calls
were traced through these entrypoints:

- `controller.startPlay`: `cfg.devWallet === false` skips enableDevWallet
  before it can generate or derive a Dev Wallet. Normal local defaults are
  unchanged. A remote URL can never enable the local wallet.
- Wallet discovery/connect uses the test wallet's already provided public
  address. The test wallet has no secret material. Its signing methods refuse.
- `fsession.restore` sees no session in a fresh context and returns null before
  `sessionOf`/`keyFromSeed`. Stored state is only language, title-seen and wallet
  name. Reload does not introduce a session.
- `session.preflight` is not on the Frontier boot path (it is used by the older
  lobby). `fsession.derive` is called only by join/session actions, neither of
  which is invoked. `fplay` signatures occur only in submission, not composition.
- The golden already has a final holding and no locally stored march book.
  `autoTicket` returns before sending for the holding stage; `readMarches` has
  no local entries to reveal. At the fixed golden time the province does not
  lag, so `shouldAutoNudge` is false. No clock advance crosses a turn here.
- Map host selection, hover, destination composition and cancel use the
  original handlers. `march-send` is inspected but never pressed. No control
  that creates/imports a session, signs, pays, seals or sends is invoked.
- `sealMarch` is not called. Both Worker/SharedWorker and the inline fallback
  module are refused as defence in depth; this is not used as permission to
  exercise a prohibited path.
- The helper's WebCrypto refusals and session-function refusals are installed
  without invoking them. The page must independently report native secure
  context and real crypto.subtle on localhost; there is no dummy crypto.
- Game kernels are the committed hash-checked WASM. Load checks use SHA-256,
  ABI/version and public ruleset hash. Preview exports reach deterministic
  geometry, terrain generation from public ring seeds, path planning and
  arrival arithmetic (`frontier-wasm/src/{api,path,lib}.rs`, rules geometry,
  terrain, travel, mapgen noise, rng and hash). Public addresses use PDA/hash
  operations. No private-key derivation, encryption or signing export is used.

## Assertions and limitations

Each context must finish with no counted key call, no stored session/dev key,
no browser/server write, no outside-origin app request and no page exception.
The server copies actual S1 golden records. The moved-palisade case deliberately
changes one structure tile to test cache invalidation; it is a synthetic feed
change, not evidence that a BuildStructure transaction occurred.

Timing measures the original map source at a stationary target over 120 frames.
It is a local browser measurement, not a large-world load test or production
frame-rate guarantee. March sealing, submission and landing remain untested.

## Result on the isolated `f764d1fb` continuation

The new local URL opt-out suppresses automatic Dev Wallet creation only. It
is **not** a general read-only mode, and it does not prevent a person from
choosing a real wallet or sending from an already authorized session.
The runner's separate fixture server, fresh context and interaction boundary
are what keep this verification read-only.

- Narrow Node run: **25/25 passed**. Explicit files: dev-wallet-optout,
  route-preview, viewer-own-citizen and want-province. The latter two controller
  closures were re-read before their review hashes were updated. The first
  calls only applyMeResult with a public wallet and null session; the second
  calls wantProvince/useHerald with in-memory replies. Neither calls startPlay.
- Whole-page run: **2/2 passed**, desktop 1440×900 and touch phone 390×844.
  The real original page and committed, hash-checked S1 kernel were used.
- Desktop keeps the pointer on the same target while a palisade appears and
  then moves with the structure count unchanged. Both route ribbons update
  and avoid the current blocked hex.
- Both viewports compose the real 10-step detour (1,320 seconds), cancel it,
  repeat the interaction, and reload without restoring an order or creating
  a session. The send button is present and enabled but is never activated.
- A 120-frame stationary-source sample triggered **zero extra plan_path
  calls**. Observed source samples were 0–1 ms on this Mac. Browser timing is
  coarse here; these figures are not a production frame-rate guarantee.
- Final checks are fail-closed even after an earlier assertion fails: the
  expected page must remain readable and the only page in the context.
  Page and persisted key-use arrays, Node key-use array and seed/session
  storage were empty. No browser/server write or outside-fixture request was
  observed. Successful runs had no page exceptions or failed asset/worker
  requests (the cancelled `/coop/config` 204 read is expected).
- The first desktop attempts exposed a test timing issue, not a product fix:
  selection's camera movement had not settled before pointer placement.
  The runner now waits for the actual camera tween to finish and verifies the
  target hex. This does not disable or replace the original map camera.
- Independent read-only review found and closed a fail-open issue in the old
  helper's final checker. This runner does not call that checker; its own
  `finally` asserts page readability, keys and request boundaries.
- Syntax, `git diff --check`, and the static Node test scanner passed.

Local result files are under `/tmp/wylls-route-preview-20261108/`: focused
Node/browser logs, desktop performance JSON, and desktop/phone order-card
screenshots. No screenshots or user state are required to run the test.

## Repeat the bounded verification

With already installed Playwright Core **1.58.2** resolvable from the screen
runner and its matching Chromium bundle (do not install or fetch implicitly):

```sh
node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test \
  permutation-gateway/test/web-frontier-dev-wallet-optout.test.mjs \
  permutation-gateway/test/web-frontier-route-preview.test.mjs \
  permutation-gateway/test/web-frontier-viewer-own-citizen.test.mjs \
  permutation-gateway/test/web-frontier-want-province.test.mjs
node --test permutation-gateway/screens/codex-route-preview.screen.mjs
node scripts/ci/scan-node-key-tests.mjs --check
```

The fixture inputs, browser helper, app boot or dependency version changing
requires fresh static review before execution. No broad test script, guard
self-test, recorder WIP, chain transaction or CI job is authorized by this
verification record. Zero guard counts are runtime evidence for the audited
path, not proof about every cryptographic operation in Chromium internals.
