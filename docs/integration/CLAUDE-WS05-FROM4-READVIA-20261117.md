# ⑤ RunReceipt from4 keeps the acts port's `readVia` (2026-11-17)

Branch `claude/ws05-from4-readvia-20261117`, from ⑤ `claude/ws05-runreceipt-from4-20261116` at `fc43eb72` (remote
equal). Not merged with, nor cherry-picked from, `claude/ws05-cancel-until-readvia-20261117` (`fada02f9`, the
producer), which was only read; no other branch touched.

**Static, NOT run, NOT integrated.** Nothing was executed (no test old or new, node syntax check, import, scanner,
fixture, relay, world or runner); the two guard-refused frontier tests were not run in any form. Commands: source/
history reads, file edits (one Python exact-string replacement script), `git diff --check`, git save/push.

## Producer (read only, fada02f9)

`workstreams/05-ai-participation/model-api/src/acts-port.mjs`: every answer of `fourActsPort` / `localActsPort` is
tagged `readVia`: `'gateway'` (this call read GET /f/agent/fate once), `'store-only'` (register, list, `read: false`,
no gateway port, no fate reader), or `null` (a ④-client port not told its gateway port). Not a chain claim.

## Consumer change (this branch, `model-api/src/run-receipt.mjs` only)

- `actFrom4(receipt)` adds `readVia: readViaOf(receipt)`: `'gateway'` or `'store-only'` as given, otherwise `null`
  (missing, null, or any other value).
- `attachAct` copies `f.readVia` into `a.from4` on both paths: the filled path and the mismatch path (another key or
  another signature), so the diagnosis keeps the same observation class.
- Nothing reads it to decide: fate, finality, `missingFrom4` (still keyed on `connection === 'real'` and no mismatch, and
  per-field values), the history correlation, `refreshFates`, conformance, authorization, budget, retry and sending are
  unchanged. `from4.chain` stays null with `REGISTRY_CHAIN_NOTE`.

## Regression source (written, NOT run)

`model-api/test/receipt-from4.test.mjs`: F1's expected `from4` gains `readVia: null` (its receipt has none); new F13 —
gateway / store-only kept, undefined / null / `'chain'` → null, on the matched and the mismatch paths and in
`actFrom4`; the same fate and `missingFrom4` for gateway and store-only. Imports unchanged (`run-receipt.mjs`,
`run-receipt.conformance.mjs`; neither imports anything). Each assertion traced by hand.

## Integration note (not done)

With both branches integrated, `fada02f9`'s ports produce `readVia` and this branch's receipt keeps it. Neither branch
alone shows it end to end: on `fc43eb72`'s base the ports do not tag it, so `from4.readVia` is null there.

## Checks NOT run (all open)

`receipt-from4.test.mjs`, `cancel-until-readvia.test.mjs` (other branch), `citizen.test.mjs`, `acts-fate.test.mjs`,
`acts-port.test.mjs`, `acts-runexec.test.mjs`; no syntax check, import or guard scan.
