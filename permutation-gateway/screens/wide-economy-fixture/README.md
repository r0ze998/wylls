# Wide-economy browser fixture

A **view-only** browser fixture of the five original wide-economy host
recordings (`harvest`, `building`, `wall`, `tier`, `train`). The village card is
the production renderer (`screens/holding.mjs`, a wide village selected) fed the
original **before** and **after** snapshot bytes through the production parser.
It is not a replay, not authenticated, not live, and not a simulator. No wallet,
session, signer, RPC, relay or chain is connected, and nothing can be submitted.

Immutable base: `8c36b961` (`feat: execute wide holding economics on host`).

## Run

From the repository root. `manifest.mjs` (the 40 SHA-256 pins) already exists and is
committed; **do not regenerate it as a setup step**. Run the tests and the server directly.

```sh
# 1. key-free Node tests
node --import ./scripts/ci/no-keys-guard.mjs --test \
  permutation-gateway/test/wide-economy-fixture-model.test.mjs \
  permutation-gateway/test/wide-economy-fixture-server.test.mjs \
  permutation-gateway/test/wide-economy-fixture-render.test.mjs

# 2. the fixture server (prints one loopback URL; OS-assigned port; Ctrl-C to stop)
node --import ./scripts/ci/no-keys-guard.mjs permutation-gateway/screens/wide-economy-fixture/server.mjs
```

Open the printed URL (it ends in `/permutation-gateway/screens/wide-economy-fixture/index.html`).
`make-manifest.mjs` takes no argument and has no overwrite mode: it creates `manifest.mjs`
with exclusive create only, so it fails on anything already there (file, symlink, directory)
and follows nothing. Deliberately replacing the manifest is a separately reviewed task.

The server answers only requests whose `Host` is exactly the listening `127.0.0.1:<port>` and
whose `Sec-Fetch-Site`, when sent, is `same-origin` or `none` (anything else: 403, before any
redirect or file), so a DNS-rebinding or cross-site page cannot read it.

## QA status (verified)

Base `8c36b961`.

**Tests**
- All 44 new model/server/render tests pass under `scripts/ci/no-keys-guard.mjs`.
- The existing `web-frontier-wide-holding-ui.test.mjs` passes (all 19).
- The renderer test covers 5 cases × 2 phases × JA/EN.

**Real native Chrome, on the final server**, at desktop 1200×1159 and responsive 390×844:
- All 5 cases selected; Before/After recorded; JA/EN; close/reopen; half/full sheet; repeated selections.
- `train` After shows Town, walls 100, reserve/spear 10.
- `wall` After shows walls 0 with a queued construction.
- `tier` After is still Settlement, with a queue and walls 100.
- With Offline emulation, a fetch failed (`Failed to fetch`) and the old card and tables were removed.
  Retry on the same case succeeded once No throttling was restored.
- The resource table visibly scrolls inside the card.

**Fixes found in QA**
- Initial `art/ui/icons.svg#...` 404s (markup inserted before `rebaseArt`) are fixed by a
  read-only alias route `/permutation-gateway/screens/wide-economy-fixture/art/**` onto the same
  public `frontier/art` files (same extension and dot-segment rules), plus a close sprite fix.
  The latest inspected app console shows no asset 404.

**Not claimed**
- Zero console errors: browser-extension warnings and the deliberate Offline errors are present.
- Measured DOM overflow, or real mobile touch behavior (390×844 was a responsive viewport).
- Rust runs or builds, key pair creation or signing, wallet/RPC/transaction/chain use, deploy,
  publication or push: none happened.

Temporary browser overrides were restored, the task tab was closed and the server was stopped.
The Host and Fetch Metadata gating and the exclusive-create generator were reviewed read-only,
with no remaining major issue reported. Final screenshots are kept locally, outside the repo.

The panel title names the visible recorded state (for example `train · After (recorded)`), so
it is clear on the phone full sheet, where the inspector controls are covered. This is a host
recording viewer, not a replay or interactive economic execution.

## What you see

- A banner that is always visible: **HOST FIXTURE · RECORDED HOST DISPATCHES · VIEW ONLY · NO WALLET · NO CHAIN · NO SUBMIT**.
- Case selector, **Before / After** (recorded snapshots, not a run), JA / EN, a card open/close toggle, phone sheet
  half/full, and a retry that reloads only the currently selected case.
- The production village card (resources, construction, reserve) for the chosen snapshot.
- Receipt facts (action, kind, `now`, `bell`, holding key), decoded **structurally** and unverified, and the
  `instructionDataHex` labelled **UNSIGNED · DATA ONLY**.
- A changes table of exact recorded strings (stores, queue, reserve, record fields). Nothing is subtracted.
- Provenance: the synthetic slot/archive note, public addresses, the wide-province identity metadata, and the SHA-256 pins.

**Read the differences correctly.** Each case is one host dispatch with the stock
reset by hand between cases. A before/after difference includes lazy accrual and
**earlier queued completions** settled by that dispatch. It is not the isolated
price, cost or yield of the action. A queue entry in an After snapshot is a
recorded entry; the page does not claim it completed.

## Checks the model enforces (fail closed)

- **Hash pins.** All 8 snapshots of the chosen case must match a static SHA-256
  manifest generated from the original files (`manifest.mjs`), checked with the
  existing SDK `sha256`. A stale or swapped file of the same identity is refused
  before anything is decoded. The pins identify *which checked-in fixture files
  these are*. They are not chain provenance, not a replay, and not proof the host
  run was honest.
- **Receipt.** Structural decode only: the action must agree with the receipt kind
  (only `Build` items 6 and 7 are `EconomyMirror`; everything else is `Economy`),
  holding key site < 12, generation 1..254, non-zero world, ring >= 129. Digests,
  authorization, replay and chain state are **not** checked.
- **Province.** Exactly 4,864 bytes with the wide trailer (`frontier-abi/src/world_index/land.rs`,
  `WideProvince::read`): magic, layout and family versions, status, readiness,
  reserved bytes, zero legacy P/Q/RING, canonical sort key, wedge, non-zero seed and
  world; season, world and sort key must equal the holding's and each other's in
  both snapshots. Only identity metadata is shown, not proof of province state.

## Data, dependencies and limits

- Slot 0 and archive 0 are **synthetic adapter values** so the real parser accepts
  the bytes. They are not a chain slot, an archive position, or a time.
- The program id and wallet are public harness literals; Season, Citizen and holding
  addresses are public PDA / with-seed derivations. No key pair is created or used.
- `fixture.mjs` imports only the pure renderer/parser modules. It does not import
  the controller, app, session or wallet modules, or the existing screens server.
  Some real rendering dependencies contain unused march/seal code; the fixture never
  calls it. Game actions and forms are inert; only close/home is handled.
- Routes are repo paths: `/permutation-server/web/**` (public assets, extension
  allowlist) and `/permutation-gateway/screens/wide-economy-fixture/` (exact file
  names). The 40 binaries are served read-only from their repo path. GET/HEAD only.
- Language switching uses the production `lang.mjs`, which stores the JA/EN
  preference in the browser's local storage. The fixture writes no history entries.
- This is Chrome DOM/CSS rendering of recorded data. It is not the full app, a wallet
  flow, a live herald, finality, or phone touch gestures. Real browser QA is a
  separate step; see QA status above.
