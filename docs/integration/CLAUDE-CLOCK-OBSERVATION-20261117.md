# Chain clock: an invalid observation no longer poisons the clock (workstream 7, 2026-11-17)

## Bug (reproduced by the parent before this change)

`ChainClock.observe(unix, slot)` in `permutation-server/web/frontier/clock.mjs` coerced both fields with
`Number(...)` and stored the result unchecked. `app.mjs` passes `record.latestUnix` / `record.latestSlot`
straight through, so a record missing either field produced a NaN sample. On a fixed injected wall:

- `observe(1000, 1)` → `now() === 1000`
- `observe(undefined, 2)` → `now()` is NaN (and `floor` becomes NaN; `Math.max(NaN, x)` stays NaN)
- `observe(1001, 3)` → `now()` stays NaN; `bellChip` shows NaN `bell` / `secondsLeft`

A NaN slot was also accepted (NaN < last.slot is false) and from then on disabled the older-slot check;
a NaN unix also made `minOffset` NaN, so `behind()` / `offset()` were NaN too.

## Fix (only `permutation-server/web/frontier/clock.mjs`)

A module-private `sampleNumber(v)` returns a finite number or null:

- accepted: a finite `number`; a `bigint` whose `Number(...)` is finite; a non-blank `string` whose
  `Number(...)` is finite (so `'0'`, `' 1000 '` keep their earlier meaning);
- rejected: `undefined`, `null`, booleans, blank strings, non-numeric strings, anything reading as NaN or
  ±Infinity, symbols, functions, and every object/array (never coerced, so no `valueOf`/`toString` runs and
  nothing can throw).

`observe` validates both fields first and returns before reading the wall or touching any state if either
is invalid, so a bad sample is ignored atomically. Valid samples follow exactly the earlier code path
(older-slot rejection, accelerated rate estimate, `advancedAt`, `minOffset`, `prev`/`last`). The return
value is unchanged (`undefined`). `declare`, `setAccelerated`, `now`, `age`, `behind`, `offset`,
`pollCap`, `bellChip` and the beacon/pipeline arithmetic are untouched.

Behaviour change for formerly-accepted inputs: `null`, `''`/blank strings, booleans and one-element arrays
used to coerce to numbers (e.g. `null` → slot 0); they are now ignored as invalid.

## Test (new, `permutation-gateway/test/web-frontier-clock-observation-regression.test.mjs`)

Imports only `node:test`, `node:assert/strict` and `clock.mjs` (`ChainClock`, `bellChip`); fixed injected
wall; no I/O, timers, network, decoder, keys or storage. `bellChip` gets a plain `{genesisTs, endBell,
continuous}` object (no `seasonClock`/`windowAt` call). Eleven cases (1–7 original, 8–11 follow-up):

1. the reported reproduction, ending with a finite bell chip `{bell: 1, secondsLeft: 599}`;
2. cold clock: 27 invalid values × (unix, slot, both) → no throw, state identical to a fresh clock, then a
   valid sample starts it;
3. warm clock: same matrix → no state change, extrapolation unchanged, then valid recovery (`prev` is the
   last good sample);
4. older-slot handling still refuses late answers, and invalid slots cannot disable it;
5. `0`, `'0'`, padded numeric strings and BigInts remain valid; blank strings are not zero;
6. accelerated clock: invalid samples do not estimate a rate; the next valid sample estimates 20× against
   the last good one; behaviour after the estimate is unchanged by further invalid samples;
7. real cluster, fixed wall: `offset()` / `behind()` / `minOffset` stay finite and unchanged.

Follow-up cases (added after the coordinator's review; no source change):

8. counted injected wall, cold and warm: no invalid sample calls `wall()`; a valid sample calls it once;
9. hostile objects (throwing `valueOf` / `toString` / `Symbol.toPrimitive`, a getter-defined `valueOf`, a
   Proxy object and a Proxy function whose handler counts every trap lookup) as unix, slot and both, cold
   and warm: no throw, no state change, no wall read, and the touch counter stays 0;
10. declared accelerated clock, `declare(0)`: cold and warm invalid samples leave `declared`/`rate` (0),
    `last`, `minOffset`, `behind()` (0), `offset()` (0), `now()` and the wall count unchanged; a valid
    sample is then taken with the declared rate kept (no estimate);
11. declared accelerated clock, `declare(20)`: the same, with `advancedAt`, `behind()` (1 s) and `now()`
    extrapolated at 20×; a valid sample 3 wall seconds later is taken, the declared 20 is not replaced by
    an estimate, and extrapolation continues at 20×.

## Status

- Cases 1–7: **coordinator-run, 7/7 pass** (coordinator's independent review, which also reported
  `node --check` and diff whitespace checks passing). I did not run them myself.
- Final coordinator verification (2026-11-17 UTC): **11/11 passed**, zero failures, skips or cancellations.
  Both changed/new JavaScript files passed `node --check`; tracked source passed `git diff --check`.
  The implementation CLI had read/edit/write tools only and did not execute tests itself.
- The pre-existing `web-frontier-clock.test.mjs` was inspected as text only and was **not run**; it is
  outside the assigned audited test scope and no claim is made about it.

The coordinator ran only the new fixture:

```
node --test permutation-gateway/test/web-frontier-clock-observation-regression.test.mjs
```

Limits: injected fixed wall and ordinary in-memory observations only. No browser, live relay/world, signing,
keys, decoder invocation or full historical suite was exercised; no publication or deployment is implied.
