# WS14 centre feed reader: broken feeds refused, not thrown on (2026-11-16, Claude; static, NOT run)

Branch `claude/ws14-feed-reader-20261116`, cut from the candidate d16048aa. Files: `game/centre.mjs`, `game/centre.test.mjs`,
this report. Nothing was run, syntax-checked or imported; `git diff --check` and reading only.

## Contract (source)
The herald writes `h/caravans.json` as `{v: 1, moving: [...], vaults: [...]}` and `h/structures.json` as
`{v: 1, structures: [...], sightings: [...]}` (`frontier-node/crates/herald/src/caravan.rs` 8–13, 91, 132;
`structure.rs` 15–18, 196, 273, 281). Every `ownerTag` is `owner_tag.to_string()` — a u64 as a decimal string.

## Counterexamples (before), each a throw instead of a refusal
1. `moving` / `vaults` present but not an array (an object, a string): the problem was noted, then
   `(caravans.moving ?? []).forEach` threw.
2. A `null` (or non-object) element of `moving`, `vaults`, `structures`: `m.ownerTag`, `v.p`, `s.p` threw.
3. `structures.structures` not an array: `.forEach` threw.
4. A vault's or a structure's `ownerTag` was never checked: `tagOrder`'s `BigInt(x.ownerTag)` threw for a non-decimal
   string or `undefined` (with two or more items to sort).
5. `sightings` present but not iterable (an object): `for (const s of structures?.sightings ?? [])` threw; a `null`
   sighting threw on `s.tower`.
6. `caravans` / `structures` not an object (a string, a number): read `.v` loosely; now refused as such.

## Change (`feedProblems` only)
A list that is not an array, an element that is not an object, or an `ownerTag` that is not a decimal string (moving,
vaults, structures) is a problem; a present `sightings` must be an array of objects. `centreFacts` already refuses on
any problem, so nothing below it can meet those inputs. Places stay `Number.isSafeInteger` (unchanged; `2 ** 53` is
refused). Accepted as before: the herald's own shapes, a missing `structures` list (empty), no `sightings`, any long
decimal tag (`BigInt` reads it). No rule and no output field changed.

## Boundaries left as they were
- `tagOrder`'s tie-break `(a.seq ?? a.tile ?? 0) - …` with a non-number `seq` gives `NaN` (an unstable order, not a
  throw); not changed (not a crash; the herald writes a number).
- `cargo` stays lenient (a non-array is 0; a non-integer slot is 0), as before.

## Regression (SOURCE ONLY, not run)
Two tests appended to `game/centre.test.mjs`: 23 broken feeds — each must not throw and must be refused with no facts;
and the herald's shapes still read (the fixture, no structures list, no sightings, a u64::MAX tag).
