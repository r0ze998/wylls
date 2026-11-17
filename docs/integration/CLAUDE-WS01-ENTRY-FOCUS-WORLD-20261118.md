# WS01 cooperation UI: unknown-world entry and focus (2026-11-18)

Status: **verified by the coordinator.** The worker used only Read/Edit/Write and ran nothing. The coordinator audited the
change and ran the pure fixtures (evidence below). No browser, network, wallet, keys or world were used.

## Problem (malformed/unknown input; not an observed real-board failure)

`coop-ui.mjs` decided "same world" with its own comparison:

- entry: `qs.get('program') === cfg.season.programId && qs.get('season') === String(cfg.season.seasonId)`
- `applyFocus`: `q.ctx && q.ctx.programId === cfg.season.programId && String(q.ctx.seasonId) === String(cfg.season.seasonId)`

Prior executable repro (empty season only): the actual source snippets were run with a fake DOM, using
`cfg.season = {programId: "P", seasonId: ""}`, the URL `program=P&season=&to=0,0,1,0&request=r`, and a request in the view
with the same ctx and destination. Result: `sameWorld === true` and the focus was created. `applyFocus` then added the
`focus` class, opened the history, scrolled and set `seen = true`.
The `null`/`"null"`/`"undefined"`, missing, whitespace-only and empty-program cases were not reproduced on the old code.
They are covered only as fixture cases against the fixed code.

## Change (one product file)

`workstreams/01-national-strategy/coop/coop-ui.mjs`:

- import `sameCtx` from the existing `./crosslinks.mjs` (already published in e37c1b6a; not edited)
- entry: `const sameWorld = sameCtx({ programId: qs.get('program'), seasonId: qs.get('season') }, cfg.season);`
- `applyFocus`: `const ctxOk = sameCtx(q.ctx, cfg.season);`

There are no new rules. Known worlds work as before: the URL season is a string, so `'90'` matches a board's `90` or `'90'`,
and `0`/`'0'` match. Whitespace is still compared as raw text. These are unchanged: the destination regex, the request
parameter presence/length check, the `to` check, the fill → other-world → broken warning chain, the focus messages, and signing.

Behaviour note, unchanged structure: an entry whose `program` and `season` are present but unreadable (for example `season=`)
still takes the existing "another world" warning branch, which shows an empty `シーズン ）`. That text was not changed because
the scope kept the warning branch structure.

## Tests

- New: `workstreams/01-national-strategy/test/coop.entry-focus-world.test.mjs`. It reads the UI source as text, extracts only
  the entry fragment and `applyFocus`, and runs them with `new Function`, a fake DOM and the real `sameCtx`. It never imports
  or runs the whole UI. Cases: unknown blank/missing/null/whitespace/empty-program worlds; known number/string worlds and zero;
  another world; mismatched `to`; a broken `to`; a missing, blank or too-long request; a request missing from the view or not
  rendered; already-seen; no focus or no view.
- Updated: `workstreams/01-national-strategy/test/coop.entry-world.test.mjs`.
  - Three exact-source pieces now expect `sameCtx`: the `sameWorld` assertion, the `ctxOk` assertion, and the slice anchor
    `const sameWorld = sameCtx(`.
  - Two assertion bugs that predate this change were repaired (test bugs, not product regressions):
    1. `post`: the test counted `/署名できない/g` and expected 1, but the match also hit the comment at `coop-ui.mjs:105-106`.
       It now counts only the executable `say(\`署名できない` sites, and still expects exactly one.
    2. Branch adjacency: `i.slice(fill, other)` excluded the `else if` it then asserted. The slice now ends at
       `other + 'else if'.length`. The ordering assertion is unchanged.
  - No feature expectation was skipped or weakened. Stale "written only / not run" headers were updated to this evidence.
- Not edited: `crosslinks.mjs`, `coop.crosslinks.test.mjs`, and their prior evidence doc.

## Evidence (coordinator, 2026-11-18)

- Baseline, before the assertion repair: the existing `coop.entry-world.test.mjs` suite passed 8 of 10. For the two failures,
  the exact failing predicates were checked against the old HEAD UI with read-only string checks (`git show`). The full old
  suite was not run at old HEAD.
- After the change and repair: both test files together passed 17/17, with 0 failures and 0 skips (44.166292 ms):
  `node --test workstreams/01-national-strategy/test/coop.entry-focus-world.test.mjs workstreams/01-national-strategy/test/coop.entry-world.test.mjs`
- `node --check` passed on all 3 `.mjs` files, and a scoped `git diff --check` passed.
