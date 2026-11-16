# First-play guide with two villages: browser check, run once (2026-11-16, Claude)

Branch `claude/first-session-resume-20261116` @ 5fbed32a: `permutation-gateway/screens/first-guide-villages.screen.mjs`
(the conquest guide's pill with two villages, `cg-go`'s village/host choice; commits 69d288ef…4567130d) and its guard
`screens/first-guide-safety.mjs`. Independent of `web-frontier-first-village-ui` (a Node unit test of the join,
onboarding scout card and holding screens of the v1/v2 home guide; no conquest guide, no `cg-go`): it neither replaces
nor routes around any refused test. The refused key-free runs (build-walls-items, muster-province-full) and the three
single-village tests (web-frontier-firststeps, -first-battle, -conquest-hand) were not run.

## Run
- From the single export, after syncing 5 files at 5fbed32a (app.mjs, screens/conquestguide.mjs, hud/guide.mjs, the
  screen test, its guard); a new empty temp folder; free 27.76 GiB; no browser process before.
  `FIRST_GUIDE_TMP=<new empty folder> node --test first-guide-villages.screen.mjs` — once.
- Fixture: keyless, live mode off (server.mjs `live = null`, never turned on), 127.0.0.1 with `devWallet=off`, the
  exact-origin GET/HEAD gate, no host name resolved, chromiumSandbox, `--mute-audio`, the fail-closed 22 GiB / 300 MiB
  monitor.

## Result: 1 of 2 — the check itself FAILED in its own set-up; the cleanup passed
- `not ok 1`: `page.evaluate: TypeError: Cannot read properties of undefined (reading 'province')` in `scene` — the
  first case's in-page set-up, before any assertion about the guide. Nothing about the guide or `cg-go` was observed.
- `ok 2` (cleanup): each handle closed once, no close error, none left open; Playwright's temp folder emptied.
- Monitor: not tripped; profile peak 7.5 MiB; free low 27.75 GiB. No process left. Writes: a 1,895-byte log and the
  5 synced export files; the 3 page files were restored to integration HEAD afterwards.
- The traffic, key and storage assertions sit after the cases and were NOT reached in this run (the pre-send gate
  was in force, but this run has no assertion record of it).

## Cause (static; not rerun)
`openPage` waits for the bell chip and `#frontier-map`, not for the home province's envelope. `scene` then read
`FS.provinces.get('2,0')` before the page's first refresh had stored it (`land-redraw.screen.mjs`, which passed, waited
for `#frontier-map[data-lod="tile"]`, then 1.5 s and a kernel read before touching the province). A test set-up timing
gap, not a finding about the page.

## Proposed fix (NOT applied; the run is not repeated without the owner's word)
In `openPage`, after the map waits, poll (a few hundred ms at a time, bounded) until the page holds its village and that
village's province — `FS.holdings?.length > 0 && FS.provinces.has(\`${h.p},${h.q}\`)` read through
`import('/frontier/fstate.mjs')` — and fail with that message if it never does; `scene` to throw a plain message
("the home province is not read yet") rather than a TypeError.

## After the run: the test's own structure fixed (static; NOT run again)
- Readiness: before any case, a bounded wait (20 s, every 250 ms) until the page holds the viewer's village and that
  village's province; it fails with the last reason ("the province 2,0 … is not read yet"). `scene` throws that plain
  message instead of a TypeError.
- Phases (`first-guide-safety.mjs` `runPhases`): open → ready → cases, then the safety AUDIT ALWAYS, whatever failed
  before it; every failure is kept (a set-up failure and an audit failure are both reported). The audit runs each of its
  checks (monitor, non-GET requests, other origins, page errors, keys/storage, profile size/readability/storage) and
  reports all that fail; with no browser context it fails ("key use and stored seeds are unchecked").
- Verdict (`verdict`): the cleanup test fails unless the main run ran AND its audit passed — a clean cleanup is no
  longer a passed safety check — besides a trip, a close error, an open handle or a temp folder left.
- Checked with fake dependencies only (`web-frontier-first-guide-safety.test.mjs`, 26/26): set-up failure + audit,
  readiness failure, case + audit failures, audit-only failure, every verdict combination, the bounded wait. No browser,
  server or process; the browser check itself is still not re-run.
