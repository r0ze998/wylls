# WS06 — the shape of ④'s quantity vectors in `resultOf` / `resultOfRun4` (2026-11-17)

Bounded bugfix. Scope: reading results only (`workstreams/06-creation/src/connect/caravan.mjs` `resultOf`, reached also through `resultOfRun4`). Unchanged: send, prepare, authority, the state writer, Dispatch, `toRunSpecs`, `coreCargo`, `bindInbound`, `resultOfAct`.

Files:
- `workstreams/06-creation/src/connect/caravan.mjs` (edited)
- `workstreams/06-creation/test/result-shape.test.mjs` (new)
- this note (new)

Baseline: the caravan blob was `6a81b4e242dcf18b23e58b3c2abfce76ca9cd661` before this edit. The coordinator reports the same blob on the remote `claude/aggregate-approved-20261117`. I did not check that myself because I had no git access.

## 1. The defect (reproduced by the coordinator under no-key guards)

When a terminal run has `verification` `Recorded` or `RuleDerived`, `resultOf` passed `outcome.delivered` to `byName` / `atCap` without checking it:

| input (`Fulfilled`/`Recorded`) | before |
|---|---|
| `delivered: null` | `TypeError` (`byName(null)`) |
| `delivered: []` | `ok: true`, `evidence.usable: true`, `lowerBound: {}`: an empty vector was accepted as evidence of a verified delivery |
| `delivered: ["4",0,0,0,0,0,0,0]` | `"4"` was counted as food (`counted.food === "4"`) |

`cargo_logged` had the same gap in the "unknown" branch. A non-null, non-array value threw at `.map`. An array of the wrong length or with wrong entries produced an upper bound that ④ never stated.

## 2. The producer (what ④ actually emits)

- `workstreams/04-execution/src/model.rs:15`: `pub type Res = [u64; RESOURCES];`, whole units. `Outcome.delivered: Option<Res>` and `Outcome.cargo_logged: Option<Res>` (:398, :402). serde writes `Option<[u64; 8]>` as `null` or as a JSON array of exactly 8 non-negative integers.
- `workstreams/04-execution/docs/QUANTITY-CONTRACT.ja.md` §1: "④の `Res`（`[u64; 8]`）は整数単位である" ("④'s `Res` (`[u64; 8]`) is in whole units"). The u32 limit in §1 belongs to the program's **record** cargo (`cargo_log`, which saturates at u32). It is **not** a limit on `Res`.
- Therefore 06 imposes **no u32 maximum** and **no `Number.MAX_SAFE_INTEGER` cutoff** on these vectors. A value above u32 is ④'s own output, and it is accepted.
- The upper bound is u64's, at its JS representation: `RES_MAX = Number(0xffffffffffffffffn)`, which equals `2 ** 64`.
  - `JSON.parse("18446744073709551615")` (u64::MAX) rounds to exactly that double, so it is accepted. So is every non-negative integer up to it.
  - A larger finite integer (`2 ** 64 + 4096`, the next double, or `1e100`) cannot be a u64, so it is refused as SHAPE (`… is beyond u64: …`). `Number.isInteger` alone would have accepted it. A reviewer flagged this in the follow-up.
- **Boundary ambiguity:** in a parsed JS number, u64::MAX and a literal `2^64` (which is not a u64) are the same value. They cannot be told apart at this layer, so a parsed `2^64` is accepted.
  - Telling them apart would need the raw JSON text, a BigInt reviver or a string format. This change adds none of those and does not redesign the number format.
- The existing cap rule still handles values at or above `LOG_MAX = 4294967295`: the lower bound is kept, and the upper bound becomes unknown (`below: null`).
- Precision limitation: a u64 above 2^53 cannot be held exactly in a JS number. `JSON.parse` rounds it to a nearby integer double, for example `18446744073709551615` → `18446744073709551616`.
  - 06 accepts that rounded integer as it is, and displays such an amount with the rounding. In practice these values are also at or above the cap, so the upper bound is null.
  - If exact large amounts ever matter, ④ and 06 would need to agree on a format. This change does not invent one.

## 3. The change (`caravan.mjs`)

1. New pure helper `resProblem(res)` → `null` or a reason. It requires:
   - `Array.isArray`, and length exactly `CORE_RESOURCES.length` (8);
   - every index present (`Object.hasOwn`, so sparse arrays are refused);
   - every entry `typeof === "number"`, `Number.isInteger` (this rejects fractions, NaN and ±Infinity), and `>= 0`;
   - every entry `<= RES_MAX` (`Number(0xffffffffffffffffn)`, which is `2 ** 64`; see §2).

   There is no u32 or `MAX_SAFE_INTEGER` bound. The reason text never throws, including for BigInt or object entries.
2. In `resultOf`, after the existing state and verification checks and **before** any `byName` / `atCap` / `.map`, the check applies only when the outcome is non-null and the run is terminal:
   - verification `Recorded` or `RuleDerived`: `outcome.delivered` must pass `resProblem`. Otherwise the result is `{ ok: false, code: "SHAPE", detail: "outcome.delivered: <reason>" }`.
   - any other verification except `KnownZero` / `NotShipped` (that is, `Unverifiable` or none): a **non-null, non-undefined** `outcome.cargo_logged` must pass `resProblem`. Otherwise the result is `{ ok: false, code: "SHAPE", detail: "outcome.cargo_logged: <reason>" }`.

   This uses the existing `ok:false, code:"SHAPE", detail` contract, the same one used for an unknown state or verification. No new code or field was added.
3. Nothing else changed:
   - `verified`, `actual`, `counted`, `evidence`, the cap handling (`LOG_MAX`, `atCap`) and `byName` are as before.
   - `null` or absent `cargo_logged` still gives `below: null` (no upper bound, never 0).
   - `KnownZero` / `NotShipped` and non-terminal runs read exactly as before. Their vectors are not used for amounts, so they are not checked.
   - A terminal run with no outcome or no verification still gives `evidence.usable: false`. No absent or unverified outcome becomes success.

Small behaviour change: a terminal unknown outcome whose `cargo_logged` is a falsy non-null value (`0`, `""`, `false`) used to read as `below: null`. It is now SHAPE. ④ never emits those values (it emits `null` or an array).

## 4. How callers handle it

- `resultOfRun4` returns `resultOf(...)` unchanged, so it gets the same SHAPE answer. This covers outcomes at `view.outcome` and at `view.detail.outcome`.
- `Dispatch.#advanceRun` (`workstreams/06-creation/src/connect/dispatch.mjs:193-194`): `const r = resultOfRun4(v); if (!r.ok) { s.lastError = r.detail; this.#save(); return; }`.
  - On SHAPE, the step keeps state `accepted`. It stores no `view`, `result` or `final`, and records the detail as `lastError`.
  - The next `advance` reads ④ again.
  - `status().complete` requires `final && result.state === "Fulfilled" && result.evidence.usable`, so a SHAPE answer can never make a request complete.
  - The test checks this by reading `dispatch.mjs` **as text**. It does not import or execute Dispatch.

## 5. Test (`workstreams/06-creation/test/result-shape.test.mjs`)

- The test installs throwing replacements for the `crypto.subtle` key and signature functions (`generateKey`, `importKey`, `exportKey`, `deriveKey`, `deriveBits`, `sign`, `verify`, `wrapKey`, `unwrapKey`, `encrypt`, `decrypt`). It does this **before** loading `caravan.mjs` with a dynamic `await import`. It makes no world, network, chain, key or signature calls.
- The main malformed and normal cases go through both entry points, `resultOf` and `resultOfRun4`. The malformed `delivered` cases also go through `resultOfRun4` with the outcome placed under `detail.outcome`. Some single-point checks use only one entry point, for example parts of the unknown-cargo and old-behaviour cases.
- Malformed `delivered`: tested for terminal `Recorded` and `RuleDerived` in `Fulfilled`, `Partial`, `DeliveredUnverified` and `Failed`. Each value must give SHAPE, not throw, and produce no `evidence` or `counted`. The values:
  - `null`, `[]`, a short array (7), a long array (9), a sparse array;
  - an entry that is a string `"4"`, a negative number, a fraction, NaN, Infinity, -Infinity, null or a boolean;
  - an entry beyond u64: `2^64 + 4096` or `1e100`;
  - an array-like object, a string, a number.
- Beyond-u64 values (`2^64 + 4096`, `1e100`, `Number.MAX_VALUE`) are refused with the detail `… is beyond u64`, in both `delivered` and `cargo_logged`. The parsed u64::MAX is accepted. The test also asserts that `JSON.parse("18446744073709551615") === 2 ** 64 === Number(0xffffffffffffffffn)`, which is the boundary ambiguity described in §2.
- The coordinator's three reproductions are tested directly.
- Malformed non-null `cargo_logged` is tested for `Unverifiable` and for a missing verification. Null or absent `cargo_logged` must still give `below: null`.
- Valid inputs:
  - zeros (`Partial`/`RuleDerived`: usable, lower `{}`, below `lower + 1`);
  - normal amounts;
  - the cap `4294967295` (lower kept, below null);
  - values above u32: `2^32`, `2^53`, `2^53+2`, `2^64 − 4096`, and the boundary `JSON.parse("18446744073709551615")`. All are accepted, with below null;
  - an unknown amount with a normal logged cargo (below = logged + 1), and with a logged cargo at the cap (null).
- Old behaviour: `KnownZero`, `NotShipped` with a cancel phase, non-terminal runs carrying malformed vectors (still pending, not checked), an `Arrived` run held as `DestinationMismatch`, a terminal `Fulfilled` without an outcome or verification (not evidence), `Fulfilled`/`Unverifiable` (not evidence), and the existing SHAPE refusals.
- The Dispatch handling is checked from the source text, as described in §4.

The new file has 8 tests: the 7 from the first pass plus one for beyond-u64 values.

**Not run by the implementer.** This session used Read, Edit and Write only. It ran no runner, test, world, Bash, network or git. (This records how the change was written; the verification below was done separately.)

## 6. Verified result (coordinator, 2026-11-17 UTC)

After the static audit and the normal review, the coordinator ran the approved command independently:

```
node --test workstreams/06-creation/test/result-shape.test.mjs workstreams/06-creation/test/result-log-cap.test.mjs workstreams/06-creation/test/ports-run-view.test.mjs workstreams/06-creation/test/ports-registry-truncated.test.mjs
```

- Result: **24/24 pass**. fail 0, cancelled 0, skipped 0. The 24 are the 8 new tests, the 4 result/log-cap tests and the 12 ports tests.
- `node --check` passed on `workstreams/06-creation/src/connect/caravan.mjs` and on the new test file.
- `git diff --check` scoped to the source file passed.

Limitations of this verification:
- **Dispatch was checked from its source text only.** The test reads `dispatch.mjs` as text. It does not import or execute Dispatch, so no real Dispatch, journal or advance loop ran.
- No runner or world was run. Nothing touched a network, keys, signatures, transactions or a DB.
- **The full `test/connect.test.mjs` suite was not run**, because its imports pull in a broader set of modules.
  - Its `resultOf` / `resultOfRun4` cases were only read statically. Their fixtures are well-formed `[u64; 8]` vectors well below 2^64, so this change is not expected to alter them.
  - That expectation has not been confirmed by a run.

Nothing was committed by the implementer.
