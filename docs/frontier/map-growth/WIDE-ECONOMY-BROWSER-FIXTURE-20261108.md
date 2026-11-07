# Wide economy: browser fixture of the host recordings (2026-11-08)

Status: implemented and verified.

- **Tests:** all 44 new model/server/render tests pass under `scripts/ci/no-keys-guard.mjs`;
  the existing `web-frontier-wide-holding-ui.test.mjs` passes (all 19). The renderer test
  covers 5 cases × 2 phases × JA/EN.
- **Real native Chrome** on the final server, desktop 1200×1159 and responsive 390×844: all 5
  cases, recorded Before/After, JA/EN, close/reopen, half/full sheet and repeated selections.
  `train` After shows Town, walls 100, reserve/spear 10; `wall` After shows walls 0 with a queued
  construction; `tier` After is still Settlement with a queue and walls 100.
- **Offline:** emulating Offline caused `Failed to fetch` and removed the old card and tables;
  Retry on the same case succeeded after No throttling was restored.
- **Fixes:** a sprite alias route and a close sprite fix removed the initial app asset 404s. The
  latest inspected app console shows no asset 404, but browser-extension warnings and the
  deliberate Offline errors are present, so **no zero-console-errors claim** is made.
- The resource table visibly scrolls inside the card. No measured DOM overflow and no real
  mobile touch behavior is claimed.
- Host and Fetch Metadata gating and the exclusive-create generator were reviewed read-only;
  no remaining major issue was reported.
- Not done: Rust run or build, key pair creation or signing, wallet/RPC/transaction/chain use,
  deploy, publication, push.
- Temporary browser overrides were restored, the task tab closed and the server stopped. Final
  screenshots are preserved locally outside the repo.

This is a host recording viewer, not a replay or interactive economic execution.

`manifest.mjs` is committed and must **not** be regenerated as a setup step;
replacing it is a separately reviewed task. Run the tests and the server directly.

Immutable base: `8c36b961` (`feat: execute wide holding economics on host`).
Code: `permutation-gateway/screens/wide-economy-fixture/` and
`permutation-gateway/test/wide-economy-fixture-*.test.mjs`. Run commands:
that directory's `README.md`.

## What it is

A view-only page that shows the five original host recordings in
`frontier-node/crates/verify/tests/fixtures/wide_economy/{harvest,building,wall,tier,train}/`
(8 files each, 40 in all) through the **production** wide-village renderer. For a
chosen case it shows the recorded **Before** or **After** snapshot, the receipt,
the `instructionDataHex` (unsigned, data only) and a table of exact recorded
strings.

It is **not** a replay, not authenticated, not live and not a simulator. There
is no wallet, session, RPC, signing, transaction, relay or submit path. The
original bytes are fed to the production parser unchanged; nothing is projected,
completed or subtracted. The five cases were separate host dispatches with the
stock reset by hand between them.

## How to read a difference

A before/after difference includes **lazy accrual** and **earlier queued
completions** settled by that dispatch. It is not the isolated price, cost or
yield of the action. Examples of recorded facts (decoded independently from the
raw bytes, resource order Food Wood Stone Ore Horses Gold Science Influence; all
pre-values `1900000` milli-units): the `wall` dispatch leaves walls at `0` and
queues a construction entry; the `tier` dispatch's walls go `0 → 100` while tier
stays `0`; the `train` dispatch's tier goes `0 → 1` and reserve slot 0 `0 → 10`.
These are observations of the recordings, not rules, and nothing here claims a
queued build has completed.

## Fail-closed checks (model.mjs)

| Check | Rule |
|---|---|
| Hash pins | All 8 files of the chosen case equal the SHA-256 in the generated `manifest.mjs` (existing SDK `sha256`; no new crypto). Stale/swapped same-identity files are refused first. |
| Receipt kind | Economy (184 B) vs EconomyMirror (225 B); only `Build` items 6 and 7 are Mirror. |
| Receipt key | site < 12, generation 1..254, non-zero world, ring >= 129, key equals the holding. |
| Province | Exactly 4,864 B; magic, layout 3, family 1, status, readiness, reserved zeros, zero legacy P/Q/RING, canonical sort key, wedge, non-zero seed/world, as `land.rs` `WideProvince::read`; season/world/sort key equal the holding and each other before and after. |
| Case | The receipt action must be the one the case name records. |

The pins identify which checked-in fixture files these are. They are not chain
provenance, not a replay and not evidence that the host run was honest. Receipt
and province decoding are structural; digests, authorization, replay and chain
state are not checked.

## Synthetic parts

Slot 0 and archive sequence 0 are adapter values so the real parser accepts the
bytes; they say nothing about when the bytes were true. The program id and wallet
are public harness literals (`0x12…` / `0xa1…` fills) with no key behind them.
Season, Citizen and holding addresses are public PDA / with-seed derivations.
No ordinary village, map or rail is faked: the page has no map.

## Limits

Chrome DOM/CSS rendering of recorded data only. It does not exercise the app boot
or controller, wallet or NFT refresh, a live herald, chain finality, phone touch
gestures, or any executable wide economy. The production language module stores
the JA/EN preference in local storage; the fixture writes no history entries.
