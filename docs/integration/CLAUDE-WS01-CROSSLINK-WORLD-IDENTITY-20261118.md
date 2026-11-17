# WS01 crosslinks: unknown world identity must not link (2026-11-18)

Scope: ordinary cooperation UI only (not MCP). One narrow fail-closed fix. No new rules, features or spec adoption.

## Bug (confirmed by coordinator)

`workstreams/01-national-strategy/coop/crosslinks.mjs` `sameCtx` compared `String(c.seasonId) === String(s.seasonId)`
and only `typeof c.programId === 'string'`. Effects:
- Request and board both missing `seasonId` → `'undefined' === 'undefined'` → same world.
- `null`/`null`, `''`/`''`, and `'undefined'` vs missing also matched; `programId: ''` was accepted.
- Objects were coerced with `String()`, e.g. `{toString: () => '90'}` matched `'90'`.

Repro: `ctx = {programId: 'P'}`, request `r` with goal `g` and requester `A`, plus a matching joint →
`jointOfRequest` returned `one` and `requestsOfJoint` returned `ok`. The source comment says it should link only
known same-world entries and otherwise report unknown.

Call sites (read only, unchanged): `coop/coop-ui.mjs:149` `requestsOfJoint(view, j, cfg.season)` and
`coop/coop-ui.mjs:162` `jointOfRequest(view, q, cfg.season)`. With the fix, these return `mixed` or `other-world`
and show their existing "do not link" text instead of nav buttons.

## Fix

`sameCtx` now requires a non-empty string `programId` that is identical on both sides. It also requires each
`seasonId` to be either a non-empty string or a finite number. The comparison key is the string itself or
`String(number)`. Anything else (missing, `null`, `''`, objects, arrays, booleans, `NaN`, `±Infinity`) means
unknown, so the result is not the same world. Numeric `90` ≡ `'90'` still works, and zero (`0`, `'0'`) is still valid.
No trimming or other canonicalization was added.

## Changed paths (exactly)

- `workstreams/01-national-strategy/coop/crosslinks.mjs`: `sameCtx` and the new private `seasonKey` helper.
- `workstreams/01-national-strategy/test/coop.crosslinks.test.mjs`: two new pure tests.
  - Unknown world: the coordinator repro, plus 13 bad-identity cases. Each case checks `sameCtx` in both
    argument orders, forward `!== 'one'` and reverse `!== 'ok'`.
  - Known world: 90/'90' both ways and the zero forms. Each case checks forward `one` and reverse `ok`
    with `ids: ['r']`, and confirms that 89 vs '90' is still false.
- This document.

Existing tests are unchanged. They still expect `sameCtx({programId:'P', seasonId:90}, {…'90'}) === true`
and `null` ctx → `other-world`, and the fix keeps both. The source-scan test's forbidden-call regex does not
match the new code.

## Verification (run by the coordinator, not by Claude)

The coordinator independently audited the full source and tests and reported these results:
- `crosslinks.mjs` has zero imports. The test imports only `node:test`, `node:assert/strict` and `node:fs` (read-only),
  plus the module under test. `coop-ui.mjs` is read as text and is never executed.
- `node --test workstreams/01-national-strategy/test/coop.crosslinks.test.mjs`: **7/7 passed**, 0 failed and 0 skipped (39.3 ms).
- `node --check` passed on both `.mjs` files, and the scoped `git diff --check` passed.

Claude ran no commands in this unit, so the results above are the coordinator's.

## Correction after independent review (2026-11-18)

- `crosslinks.mjs`: a whitespace-only `programId` or string `seasonId` is now unknown. A private helper `blank(v)`
  returns `v.trim() === ''`, and `trim` is used only for that emptiness test. Comparison still uses the original
  strings, so `' 90'` ≠ `'90'` and `' 90'` === `' 90'`. Numbers, zero and the 90/'90' cases are unchanged.
- Test: 7 new unknown-world fixtures. Each one checks `sameCtx` both ways round, forward ≠ `one` and reverse ≠ `ok`:
  - space-only, tab-only and space/tab `seasonId`
  - space-only and tab-only `programId`
  - padded `' 90'` vs `'90'`
  - padded `'P\t'` vs `'P'`
- Test: 1 new known-world fixture. `' 90'` vs `' 90'` still links (forward `one`, reverse `ok`).
- Test header: now records the coordinator's final passing rerun. The test file still has 7 `test()` blocks; the new
  fixtures sit inside two of them.

## Final verification (coordinator rerun after the correction, not by Claude)

The coordinator ran this after all the blank and padded-string fixtures were added:
- `node --test workstreams/01-national-strategy/test/coop.crosslinks.test.mjs`: **7/7 passed**, 0 failed and 0 skipped.
- `node --check` passed on both `.mjs` files, and the scoped `git diff --check` passed.

This supersedes the earlier 7/7 result, which was from before the correction. Claude ran no commands.

## Not done

- No test in a real browser or real world. Source integration (commit or aggregate) is still pending with the coordinator.
- I did not touch `clock.mjs`, MCP files, `coop-ui.mjs` (its own `applyFocus` ctx check at `coop-ui.mjs:359` is
  outside this scope and was left as is), the guard candidate, or any git state, settings or permissions.
