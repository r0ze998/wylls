# WS12 live observation: herald event page `full` must be a boolean (2026-11-17)

**Status: VERIFIED (single file).** The coordinator ran the focused test file: 11 passed, 0 failed, 0 skipped. See
"Verification" below.

Narrowly authorized, read-only consumer bug fix in workstream 12. No spec change and no new operation is adopted.

## Files changed (only these three)

- `workstreams/12-memory/adapters/live-observation.mjs`
- `workstreams/12-memory/test/live-observation.test.mjs`
- `docs/integration/CLAUDE-WS12-EVENT-PAGE-SHAPE-20261117.md` (this file)

No other files were changed.

## Baseline (before edits)

- Remote exact HEAD `0cc3ca309e1e4f8e8ab0d414c6a2c9e3e0480646` matched the local blobs:
  - adapter `live-observation.mjs` blob `2b61e13a41d09011611555a7373e33584a499947`
  - test `live-observation.test.mjs` blob `943b671d049b740f84bbef8bbf4c72a35630d0d3`
- Existing suite: 10 tests; no key calls; imports `node:sqlite` transitively, but `io.readStore` is injected in every
  test, so no database is opened.

## Bug

`readHerald` validated each `/h/events` page for `v`, `events` and `next`, but not `full`. The loop then ended the
read as complete on `body.full !== true`, so a page whose `full` was missing, `null`, a string (`"true"`) or a number
(`1`) was taken as the last page: `eventsComplete: true`, `why: []`. `observeLive` would then pass a possibly partial
event clock to `connectCanonical` and ingest from it.

Coordinator reproduction (before the fix; nokey preload, in-memory fake `getJson`; no network, no DB opened, no keys,
no world): missing / `null` / `"true"` / `1` each gave `eventsComplete: true, why: []`.

## Producer

`frontier-node/crates/herald/src/server.rs`, `events`: emits `full` as a boolean, `rows.len() == EVENTS_PAGE`
(lines 638 / 648 per the coordinator's reading). A non-boolean `full` is therefore never a producer shape.

## Fix

In `readHerald`, the page shape check now also requires `typeof body.full === 'boolean'`; otherwise the page is
`events_malformed` and the read stops (fail closed, as for every other malformed page). Pagination is unchanged:
`full === false` ends complete; `full === true` continues to the next `after`. The header comment lists the
non-boolean `full` among the incomplete-read causes.

Effect in `observeLive`: a malformed page (first or later) leaves `eventsComplete: false`, so every receipt is held
`herald_events_incomplete`, nothing is ingested, the in-process memory's journal stays empty, provenance is null.

## Tests added (one new `test(...)`, so 11 in the file)

`a page whose `full` is not a boolean …`, all with injected fake I/O (fixture JSON read from disk only; no writes,
no DB, no network, no keys):

- For each of missing / `null` / `"true"` / `1`:
  - direct `readHerald`, first page bad: `events_malformed`, `eventsComplete: false`, `eventPages: 0`, no events,
    no `events_page_limit`;
  - direct `readHerald`, valid `full: true` page then a bad second page: `events_malformed`,
    `eventsComplete: false`, `eventPages: 1`;
  - `observeLive`, bad first page and valid-then-bad second page: status `held`, reasons include `events_malformed`
    and `herald_events_incomplete`, `held.length` equals all fixture receipts, each `herald_events_incomplete`,
    `ingest` undefined, `provenance` null, `memory.journal.records()` empty.
- Boolean flow retained: `full: true` then `full: false` gives `eventPages: 2`, `eventsComplete: true`, status `ok`,
  provenance present, no `events_malformed`.

Existing tests already use boolean `full` on every page, so their expectations are unchanged.

## Safety / import audit (coordinator's review)

- The test's import graph is 14 modules.
- `node:sqlite` (Node built-in) is imported through `adapters/canonical.mjs` (`readWs04Store`), but no database is
  opened: every `observeLive` call in the test injects `io.readStore`, which returns a store built in memory from
  `fixtures/ws04-receipts/*.json` (read only).
- The memory is `createMemory({ world, partitions })` with no path: its Journal has a null path, so nothing is
  written to disk.
- `crypto` is used only for hashing; no key is generated, derived, loaded or used, and nothing is signed. The run was
  under `tools/nokey-guard.mjs`, which guards key operations.
- No network: `io.getJson` / `io.rpc` are in-process fakes.

## Verification

The coordinator ran the final check after normal review:

```
node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test --test-reporter=tap \
  workstreams/12-memory/test/live-observation.test.mjs
```

Result: **11 passed, 0 failed, 0 skipped**; Node v23.11.0; duration 56.031042 ms. `git diff --check` passed.

Only this single file was run; no full suite or live gameplay test.

## Scope and claims

- This is the existing WS12 → WS13 read path (`observeLive` → 13's live port). It is not the deployed, full ordinary
  gameplay assembly; no gameplay success is claimed.
- No network, DB open, keys, signing, world/resident/server start, publish, git action or policy change was made.
  The existing world (restart denied) remains stopped and was not touched.
