# Wide-economy LOCAL demo (Node + browser half)

A **LOCAL SIMULATION with MOCK authorization**. You press Harvest / Build / Train / advance-the-clock / reset in a page, a
Node server forwards one validated command at a time to a prebuilt local Rust host over stdio, and the page shows the
host's resulting bytes in the **production** wide village card. There is no wallet, no signature, no transaction, no RPC,
no chain. Nothing in this directory computes an economy: every number on screen is the host's, read by the production
parser.

Not claimed: chain provenance, replay, authenticity, finality, or that the host's rules equal the chain's. The
"mock auth" is the host harness setting an `is_signer` flag; nothing is signed.

Test status: **48 focused Node tests passed** with `scripts/ci/no-keys-guard.mjs` on 2026-11-08. Tests use a fake host; the HTTP regression opens and closes an ephemeral loopback server. A manual smoke test also passed in actual Chrome against the local Rust host; this is local simulation only, not chain execution.

## Run

From the repository root. The Rust half builds the host to the fixed path
`.local/wide-economy-demo/target/debug/examples/local_economy_demo` (this directory never builds it).

```sh
# key-free Node tests (fake host, ephemeral loopback HTTP; no real child process)
node --import ./scripts/ci/no-keys-guard.mjs --test \
  permutation-gateway/test/wide-economy-local-model.test.mjs \
  permutation-gateway/test/wide-economy-local-bridge.test.mjs \
  permutation-gateway/test/wide-economy-local-client.test.mjs \
  permutation-gateway/test/wide-economy-local-server.test.mjs \
  permutation-gateway/test/wide-economy-local-ui.test.mjs

# the demo (prints one 127.0.0.1 URL; Ctrl-C stops the server and kills the host)
node --import ./scripts/ci/no-keys-guard.mjs permutation-gateway/screens/wide-economy-local/local-server.mjs
```

The server refuses to start (exit 1, nothing listening) if the host binary is missing/not the exact expected regular file,
or if the host's first reply is not revision 0 and byte-identical to the original harvest "pre" fixture state. It never
retries and never restarts the host.

## Files

| File | Role |
| --- | --- |
| `local-model.mjs` | Pure: command lines, exact body schema, reply-line schema, validation through the production parser, transition checks. No economics. |
| `host-bridge.mjs` | Node-only: fixed child spawn + line protocol with limits. The only file that touches `child_process`. |
| `local-server.mjs` | Loopback HTTP server, serialized controller, static allowlist. |
| `local-client.mjs` | Browser request logic (injectable `fetch`): one in flight, tokens, fail-closed, GET-only recovery. |
| `local.mjs`, `index.html`, `local.css` | Japanese-first UI. The production card is rendered by `screens/holding.mjs` and made inert. |
| `fake-host.mjs` | **Test only.** Never served. Moves between two byte sets the test supplies; implements no rules. |

## Host contract

Source of truth: `permutation-frontier/examples/local_economy_demo/{main,protocol,engine}.rs` and
`docs/frontier/map-growth/WIDE-ECONOMY-LOCAL-DEMO-PROTOCOL-20261108.md`.

Commands: bounded ASCII lines (<= 256 B): `get`, `act REV harvest`, `act REV build ITEM`, `act REV train UNIT COUNT`,
`advance REV SECONDS`, `reset REV`. Build 0..8, Train unit 0..6, count 1..1000 (transport cap), SECONDS in
{600, 3600, 86400}. REV is the caller's current revision. Success increments it, including reset; refusals keep it.
The host caps its session revision at 1,000,000.

Replies are compact JSON lines (<= 64 KiB, printable ASCII) with exactly:
`protocol`, `mode`, `auth`, `status`, `revision`, `now`, `command`, `action`, `code`,
`seasonHex`, `citizenHex`, `holdingHex`, `provinceHex`, `recordHex`.

- Fixed metadata: `wylls-local-economy-v1`, `local-only`, `MOCK_AUTH_NO_SIGNATURE`.
- `command`: get/act/advance/reset/invalid. `action`: harvest/build/train for act, null otherwise.
- `ok` requires null code. `refused`/`fault` require a code. Faults never yield trusted state.
- Successful act requires one structurally valid receipt for the requested action, holding and exact current time.
  Wall/tier builds use mirror receipts. Acts do not move the simulated clock.
- Get, advance, reset, refusals and faults carry null receipts. Receipts are per-response, never retained by get.
- Advance changes only the clock, by the requested interval. Refusals change no account, time or revision.
- Reset restores the original four harvest pre-fixture byte arrays and `1800088200`, but increments revision.
- Startup must be a pristine successful get at revision zero.
- Every reply carries lowercase hex account fields of 2048 / 384 / 1344 / 4864 bytes.

## Safety shape

- **Child**: fixed path, must be a regular executable file whose `realpath` equals the expected path (no symlink on it);
  spawned once with no shell, **no arguments**, a closed literal environment (`LANG`, `LC_ALL`, `RUST_BACKTRACE`; nothing
  inherited, no keys, no fixture-export variables) and the binary's directory as cwd. No client input reaches path, argv or env.
- **Failure = uncertain.** Timeout (5 s), exit, spawn error, stderr flood, oversize/malformed/extra/unsolicited output, a
  reply that fails validation, a `fault`, or an impossible transition makes the state **uncertain** for good: the host is
  killed, mutations get 503, no retry, no restart. Recovery is stopping and restarting the server by hand.
- **Server**: `127.0.0.1` ephemeral port only; `Host` must equal the listening address exactly; cross-site GET/HEAD top-level document navigation may load static pages, but never API routes; no CORS headers; `OPTIONS` is 405.
  Mutating `POST /api/action|advance|reset` need the exact same `Origin`, `Sec-Fetch-Site: same-origin` when present, header
  `X-Wylls-Local-Action: wylls-local-economy-v1`, `Content-Type: application/json`, a numeric `Content-Length` <= 512, and a
  body that is **canonical** `JSON.stringify` output with the exact key set (so no duplicate keys, spacing or `1.0`).
  `expectedRevision` is mandatory. Requests run one at a time through a bounded chain (>8 waiting: 429); the revision is
  checked inside the turn, so a duplicate or stale request gets 409 and never reaches the host. `reset` bumps the revision,
  which invalidates everything outstanding. `GET /api/state` serves the cached validated view and never contacts the host. If the bridge has died while idle, the next read clears that view and permanently blocks mutations.
- **Static**: exact files of this directory (not README, server, bridge, fake host), the fixture's `model.mjs`/`manifest.mjs`,
  four harvest "pre" binaries, a read-only `art/` alias, and extension-allowlisted confined `/permutation-server/web/**`.
  No arbitrary production endpoints, no proxy, no query strings.
- **Provenance**: only the *initial* state (startup and every reset) is held to the original harvest pre bytes (SHA-256 pins
  of those four files, then byte equality). A mutated state is validated **structurally** (fixed program, wallet, season bytes,
  world, owner, holding and province identity; parser acceptance; record key/action/time). The original before/after manifest
  pins are never applied to it. The parser requires the literals `captured-unverified` / slot 0 in its input envelope; here
  they are adapter values, not a claim of capture (`FS.verification` is `local-simulation-mock-auth`).

## UI

Japanese first. `LOCAL SIMULATION · MOCK AUTH · NO WALLET / CHAIN / REAL TRANSACTION` is static markup that script never
touches. LOCAL controls (Harvest, Build #0-8, Train unit/count, +10 min / +1 h / +1 day, reset, GET refresh) are **outside**
the production card; on phones everything stacks in normal flow. The production card is read-only: its buttons are disabled,
links lose `href`, forms are cancelled, and capture-phase handlers swallow clicks/keys. The card's own read-only
warning stays and no production button is unlocked.

**Queue semantics, stated on the page:** advancing the clock does not settle anything; accrual and construction completion
show up only on the next action. The clock moves only when you press a button; there is no live clock or elapsed timer.

**Requests:** one in flight (controls disabled meanwhile, duplicates refused in the client too), every reply tagged with a
token and older ones discarded. A failed/garbled fetch or 10-second request timeout **clears** the shown state (it is no longer known) and never re-sends
the submission; the only recovery is the explicit "state refresh" button, a plain `GET /api/state`.

## Limits

- Language: local controls use Japanese text. The production card respects its existing language setting; this demo does not change persistent language preferences.
- Build captions (#0 農場 … #7 昇格, #8 工房) are labels only. They state no cost or effect. Item 8 follows `permutation-rules/src/frontier/arms.rs` (`ITEM_WORKSHOP`), the ABI maximum in `frontier-abi/src/world_index/economy.rs`, and the production caption in `permutation-server/web/frontier/fi18n.mjs`.
- The Chrome smoke below checks the listed flow; it is not exhaustive browser, responsive layout, or accessibility coverage.

## Real-host Chrome smoke (2026-11-08)

Actual Chrome exercised the local Rust host through the Node server at `127.0.0.1:54011` (a run-specific ephemeral port):

1. Harvest → revision 1.
2. Build #0 → revision 2, farm construction queued.
3. Train #0 ×10 → revision 3, 10 reserve units.
4. Advance one day → revision 4; Harvest → revision 5, construction queue cleared and hourly food production changed from 40 to 52.
5. Three Train #0 ×1000 actions succeeded at revisions 6–8. The fourth was refused with `E21`, keeping revision 8.
6. Reset → revision 9, restoring initial stores of 1900 and zero reserve units.

Reset screenshot: `.local/wide-economy-demo/browser-smoke-reset.jpg` (local QA artifact).
No wallet, signing, real transaction, chain state, deployment or chain provenance was involved.
