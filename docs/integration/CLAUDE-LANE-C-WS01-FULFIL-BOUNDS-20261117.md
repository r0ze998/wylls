# ① coop screen: the request-fulfilment bounds text says "exactly 0", never "less than 0" (Lane C, 2026-11-17)

Branch `claude/lane-c-ws01-fulfil-bounds-20261117`, from `d16048aa` (the canonical candidate; the ① files and ④'s `QUANTITY-CONTRACT.ja.md` are byte-identical there and at the WS14/15 branch heads). Written, not run: nothing was imported, syntax-checked, tested or served.

## What was checked (static)

- **Docs:** ① docs 21–23 and ④ `docs/QUANTITY-CONTRACT.ja.md` §3–4. The intervals are `[b, b+1)` for a lower bound, `[0, cargo_logged+1)` for an unknown amount, and exactly 0 for `KnownZero`.
- **The display path:** `coop/coop-ui.mjs` → `coop/ws04.mjs` (`deliveredText`, `fulfilmentOf`, `FULFILMENT_JA`) and `coop/goal.mjs` (`countOf`, `coopView`).

The real consumer is the coop screen (`coop/index.html` loads `coop-ui.mjs`). The board (`coop/board.mjs`) serves the whole `coop/` directory (`SERVE`) and `/coop/view` (`coopView`).

| Display | Finding |
|---|---|
| Arrival amount (`deliveredText`) | Consistent. Lower bound: "届いた 木材 196 以上", and 0 is still "0 以上". Unknown: "確認できない（最大 …＋端数）". KnownZero: "届かなかった（理由）". DestinationMismatch: "原因を確認中", with no "奪われた". In transit, or state not known: no amount |
| Counted amount (`arrival-counted`) | Consistent. Not counted: "算入 0（理由）", which is a counted amount, not the arrival amount |
| **Request fulfilment (`req-fulfilment`, coop-ui.mjs:149)** | **Mismatch, fixed.** It always printed "上限 {upperExclusive} 未満" when `upperExclusive` was not null. But `fulfilmentOf` returns an object with every requested resource, and `countOf` gives exactly-zero arrivals (`KnownZero`, a duplicate, a recipient who is not the requester, a send before accepting) an upper bound of 0. So a request whose only caravan was burned showed "数えた量の下限 石材 0、上限 石材 0 未満": at least 0 and less than 0. This is request r3 in ①'s own `test/fixtures/ws15-fold-e2e.json` (`lower {stone:0}`, `upperExclusive {stone:0}`, `not-reached`) |
| Fulfilment status (`FULFILMENT_JA`) | Consistent: fulfilled when L ≥ G; not-reached when every caravan has finished and U ≤ G; otherwise undetermined, including in transit or "原因を確認中" |
| Joint precision (`joint-precision`, coop-ui.mjs:101) | **Observation, not changed.** It prints "本当の量は表示より 石材 0 未満 多いことがある" when `underBy` is 0. `underBy` counts counted arrivals with a positive record (`goal.mjs` `if (v > 0)`), so a counted arrival recorded as 0 (a fraction under 1, like r5) is not counted, although its true amount may be up to 1 more. Changing that count changes a field that an existing test pins (`test/coop.test.mjs:765`, stone `underBy` 0) and the committed fixture's `joint` values. Left for ① to decide |

## The change (display only)

- **New `coop/fulfil-bounds.mjs`** (no imports) exports `fulfilBoundsText(fulfilment, ja)`.
  - Positive terms are at least 1, so a resource's upper sum is 0 only when every term is exactly 0. That resource is "{name} ちょうど 0（どの隊商も数えられないと決まった）".
  - Resources with a positive upper bound read "数えた量の下限 b、上限 u 未満". This is the same sentence as before.
  - When there is no upper bound (a caravan has not finished), only the lower bound is given. A 0 there is never called exact.
- **`coop/coop-ui.mjs`:** the fulfilment line uses the helper (2 lines). Nothing else on the screen changed.
- **Not changed:**
  - `fulfilmentOf` (status, `lower`, `upperExclusive`), `countOf`, the judges, rules, sending, signing, permissions, records and ④'s receipts;
  - D's ③, the WS14/15 branches, the ⑨/⑩ branches and the canonical tree;
  - the 25 deleted media files.
- **① doc 22:** a note under the upper-bound paragraph.

## Regression (written, not run)

`workstreams/01-national-strategy/test/coop.fulfil-bounds.test.mjs` has five tests, using hand-made values copied from the fixture's five requests:

1. A positive upper bound, or none, gives exactly the old sentence (r1, r2, r4, r5).
2. Upper 0 (r3) is "ちょうど 0", never "0 未満".
3. Mixed resources are handled per resource.
4. No upper bound with 0 never says "ちょうど".
5. Missing fields and unknown resource names do not crash.

## Static audit

| Item | Finding |
|---|---|
| Import closure | `coop.fulfil-bounds.test.mjs` → `node:test`, `node:assert/strict`, `../coop/fulfil-bounds.mjs` (no imports). It does not import `ws04.mjs`, `record.mjs` (signing, `permutation-server/web/frontier/faddr.mjs`), the board, the chain or the DOM |
| Top-level code | The helper has declarations only. The test has imports, `const` helpers and `test(...)` calls |
| I/O, keys, network | None: no `fs`, `fetch`, `process`, `child_process`, `worker_threads`, dynamic `import()`, `new Function`, or key or sign API. Nothing for the key scan to flag, so `scripts/ci/node-key-tests.txt` needs no entry and is unchanged. No CI job runs ①'s tests |
| Screen load | `coop-ui.mjs` gains one relative import of a file in the directory the board already serves (`board.mjs` `SERVE`, `.mjs` type known) |
| Existing tests | No existing test asserts the fulfilment text; `coop.browser.nokey.mjs:169` reads only `data-status`, which is unchanged |
| Refused work | It touches no walls, muster, G, runner or world code, and it is not a substitute for any refused run |
| Candidate command (for the coordinator; not run) | `node --test workstreams/01-national-strategy/test/coop.fulfil-bounds.test.mjs` |

**Not done here:** the screen was not loaded and the browser test was not run, so the change is unverified on the real screen.

## Run record (the coordinator's run; Lane C ran nothing)

| Item | Result |
|---|---|
| Who and when | The coordinator, once, at `e5f39a3c`, after re-checking the whole dependency closure of the helper and the test, the environment, side effects, and that it does not overlap any refused route. Not to be rerun |
| Command | `node --test workstreams/01-national-strategy/test/coop.fulfil-bounds.test.mjs`, with Homebrew's `node` (Node 23.11.0) |
| Result | 5/5 pass; fail 0, cancelled 0, skipped 0; exit 0; duration 41.893125 ms; 53,600,000 KiB free |
| Scope | The pure helper only. The screen and a real world are not verified |

## Joint precision: `underBy` counts every counted arrival, including those recorded as 0 (2026-11-17)

Written, not run. Nothing was imported, run, served or loaded in a browser.

**The trace.**
- `underBy` is made only in `coop/goal.mjs` `coopView`, as `h.records[r]`, and is read only by the screen's `joint-precision` line (`coop-ui.mjs`) and by `ws15Export`'s copy of `joint[].progress` into the fixture.
- No judge, count, send, permission, ownership or rule reads it: the verdict uses `perResource`.

**What the existing contracts fix.**
- ④ `QUANTITY-CONTRACT.ja.md` §3: a `RuleDerived` arrival is `[b, b+1)`, "b＝0 でも 0 とは限らない".
- §4: n runs together are `[Σb, Σb+n)`, where n is the number of `RuleDerived`/`Recorded` runs. Only a `KnownZero` run carries no fraction.
- ①'s own comment (`goal.mjs`, above `progress`) says `underBy` is "その k（数えた到着の件数）", and ① doc 19 says "`underBy`（数えた件数）".
- The code counted an arrival only when `v > 0`. So a counted arrival recorded as 0, which may really be up to 1 more, was left out of k. This is a mismatch with the stated contract, not an open question.

**What was not adopted.** "Sent 0 ⇒ exactly 0" (reading the sent cargo to call a 0 exact) is not in ④'s contract, so it is not used.

**The change.**

| File | Change |
|---|---|
| `coop/goal.mjs` | `h.records[r]` counts every counted arrival that carries resource r (the `v > 0` condition removed), with a comment citing §3–4 |
| `coop/fulfil-bounds.mjs` | Adds `jointPrecisionText(progress, ja)`. When k > 0 the sentence is the same as before. A resource with k = 0 has no counted arrival, so its counted amount is exactly 0 and it reads "…は数えた到着がなく、数えた量はちょうど 0", not "0 未満多い". `fulfilBoundsText` is unchanged; the already-run `coop.fulfil-bounds.test.mjs` is byte-identical (`b24fb9b0…ef717645`), but the module it imports now has a new hash |
| `coop/coop-ui.mjs` | The `joint-precision` line uses the helper |
| `test/coop.test.mjs` | A wrong expectation corrected with its reason: stone `underBy` 0 → 2. Two counted arrivals each carry stone 0, and each is `[0, 1)` |
| `test/coop.e2e.test.mjs` | The fixture is kept byte-identical as history (`c4d64fe3…47900bfa`). The test asserts that the fixture's wood `underBy` is 4 as made, applies the one correction (4 → 5: five counted wood arrivals 119, 81, 5, 4 and 0, the last being r5's), then compares the whole export as before |
| `docs/19-reconcile-04.ja.md` | A note on the corrected count |

**Not changed:**
- the counted amounts (`perResource`), `verdict`/`done`, `fulfilmentOf`, `countOf` and the judges;
- sending, signing, permissions, ownership and rules;
- ④'s receipts, D's ③, the fixture bytes, the other branches and canonical;
- the 25 deleted media files.

**New pure regression** (`test/coop.joint-precision.test.mjs`, sha256 `5ff550a1…af77b495`, written, not run). It has four tests:
1. k > 0 gives the same sentence as before.
2. k = 0 gives "ちょうど 0" and never "0 未満".
3. k = 1 with an amount of 0 is "1 未満多いことがある", never "ちょうど 0".
4. Missing fields and unknown names do not crash.

The count itself is regressed by the two corrected existing tests above.

**Static audit**

| Item | Finding |
|---|---|
| New test closure | `node:test`, `node:assert/strict`, `../coop/fulfil-bounds.mjs` (sha256 `1adb1d77…b89f9b5d`, no imports, declarations only). No `fs`, `fetch`, `process`, `child_process`, dynamic `import()`, `new Function`, key or sign API, so it needs no `node-key-tests.txt` entry; the lists are unchanged |
| Corrected existing tests | `coop.test.mjs` (`09a610f3…dc991a26`) and `coop.e2e.test.mjs` (`9779bc84…e0b9b49c`) are **not pure**. They build a board, a fake chain and a store, and they are listed in `scripts/ci/node-key-tests.txt` (the key-scan list). Their imports were not changed by this edit. Running them is the coordinator's decision |
| Other changed sources | `goal.mjs` `9a51c583…9799c708`; `coop-ui.mjs` `28e8f2ed…dca602c8` |
| Refused work | It touches no walls, muster, G, runner or world code, and it is not a substitute for any refused run |
| Candidate commands (for the coordinator; not run) | `node --test workstreams/01-national-strategy/test/coop.joint-precision.test.mjs` (pure). The corrected `coop.test.mjs` and `coop.e2e.test.mjs` only after the coordinator's own audit |

**Not verified:** the screen, a real world, and the two corrected existing tests.

## Correction: a missing or invalid `underBy` is "precision not known", never "exactly 0" (2026-11-17)

The coordinator's static review before any run found that `jointPrecisionText` (at 71764e61) treated anything that is not `> 0` as an explicit zero. That included missing, `null`, negative, fractional, `NaN` and string values, which all read as "数えた到着がなく、数えた量はちょうど 0". The new test also expected a missing `ore` count to be 0. This breaks the existing rule that an unknown stays unknown. **That test had not been run.**

**The fix** (display only; `coop/fulfil-bounds.mjs`, sha256 `85a141fb…30e8c525`).
- k is accepted only when the element is an object and `underBy` is a safe non-negative integer.
- A positive k gives "k 未満多いことがある", the same sentence as before.
- An explicit 0 gives "ちょうど 0".
- Anything else, including a `null` or wrongly shaped element or a missing count, gives "…は数えた到着の件数が示されていないので、精度が分からない". It is never 0 and never "未満".
- **Corrected (2026-11-17):** an earlier version of the line above also listed "a missing `ja`". That was wrong. A missing `ja` only makes the name fall back to the resource key (`ja?.[r] ?? r`). The classification by k is unchanged, so `[{resource: 'wood', underBy: 0}]` without `ja` reads "woodは…ちょうど 0", as the test expects.
- A missing or non-string resource name is shown as "（資源名なし）".
- `fulfilBoundsText` is unchanged.
- Not changed: the count in `goal.mjs` (still every counted arrival, including those recorded as 0), counted amounts, the verdict, sending and permissions.

**The test** (`test/coop.joint-precision.test.mjs`, sha256 `bd8b8c53…54d7b922`, written, not run).
- The wrong expectation (missing `ore` → "ちょうど 0") is corrected, with the reason, to "精度が分からない".
- New cases:
  - thirteen invalid `underBy` values (`undefined`, `null`, -1, 1.5, `NaN`, ±`Infinity`, '2', '0', `true`, 2^53, `{}`, `[]`);
  - `null` and wrongly shaped elements, and missing or non-string names;
  - a mix of positive, zero and unknown;
  - no `ja`.
- Kept: explicit 0 gives "ちょうど 0"; k = 1 with an amount of 0 gives "1 未満"; k > 0 gives the old sentence.

**Re-audit (static).**

| Item | Finding |
|---|---|
| Closure | The test imports `node:test`, `node:assert/strict` and `../coop/fulfil-bounds.mjs`, which has no imports and only declarations: two `const` helpers and two exported functions. No `fs`, `fetch`, `process`, `child_process`, `worker_threads`, dynamic `import()`, `new Function` or `require`, and no key or sign API. No `node-key-tests.txt` entry is needed and the lists are unchanged |
| Other files | `coop.fulfil-bounds.test.mjs` is byte-identical (`b24fb9b0…ef717645`), but the module it imports changed. Its function (`fulfilBoundsText`) is unchanged; its earlier 5/5 run was against the module at e5f39a3c |
| Not audited for running | The corrected existing `coop.test.mjs` and `coop.e2e.test.mjs` (board, fake chain and store, on the key-scan list) and the screen tests: not to be run until audited |
| Refused work | It touches no walls, muster, G, runner or world code, and it is not a substitute for any refused run |
| Candidate command (for the coordinator; not run) | `node --test workstreams/01-national-strategy/test/coop.joint-precision.test.mjs` |

## Run record (the coordinator's run of the joint-precision test; Lane C ran nothing)

| Item | Result |
|---|---|
| Who and when | The coordinator, once, at `6e812809`, after reading the whole pure test and helper and re-checking the environment, side effects, and that it does not overlap any refused route. Not to be rerun |
| Command | `node --test workstreams/01-national-strategy/test/coop.joint-precision.test.mjs`, with Homebrew's `node` (Node 23.11.0) |
| Result | 8/8 pass; fail 0, cancelled 0, skipped 0; exit 0; duration 42.985042 ms; 53,600,000 KiB free |
| What it verifies | Only `jointPrecisionText`, the wording for given `progress` values |
| What it does not verify | The count in `goal.mjs` `coopView` (`h.records` → `underBy`), the corrected expectations in `coop.test.mjs` and `coop.e2e.test.mjs`, the screen (`coop-ui.mjs`), or a real world |

## Static audit: the real `underBy` producer and consumer, and the corrected existing tests (2026-11-17; nothing run)

**Producer** (`coop/goal.mjs` `coopView`, the joint loop, at `6e812809`). Checked against the source:

| Boundary | What the source does | Agrees with ④ §3–4? |
|---|---|---|
| Duplicate arrival | `allocate` marks a second link of the same caravan `duplicateOf`. The joint loop skips it (`if (a.duplicateOf) continue`) before counting, and `countOf` also gives it `counted: null` | Yes: not double-counted in `perResource` or `underBy` |
| `KnownZero` (burned, taken, lost) | `countOf` gives `counted: null` and an upper bound of 0. The arrival never reaches `h.records`; it is not `delivered`, so it is neither unproven nor open | Yes: §4 says a `KnownZero` run carries no fraction |
| Counted with b = 0 (`{wood: 0}`) | `a.counted` is an object, so truthy, and every key counts once in `h.records` (since 71764e61) | Yes: §3 `[0, 1)`, §4 n |
| A resource outside a request's `need` | `counted` = `pickNeed(delivered, need)` has only the request's keys, so it is not counted | Yes |
| Counted with an unshipped resource in `need` (sent 0) | Counted as `[0, 1)`. "Sent 0 ⇒ exactly 0" is not in ④'s contract and is not used. `fulfilmentOf`'s `countUpper` (`plus1(delivered)`) treats the same arrival the same way | Yes, and consistent with `fulfilmentOf` |
| `Unverifiable`, unverified recipient or time, `DestinationMismatch` | `counted: null`. They go to `unprovenDeliveries` or `unverifiedCaravans`, not `underBy`. Their uncertainty is shown on other lines ("到着したが数えられない", "輸送中・不明") | Yes: `underBy` is about counted amounts only |
| What reads `h.records` | Only `progress[].underBy`. The verdict uses `perResource` | Counting and the verdict are unchanged |

**Consumers.**
- `coop-ui.mjs` `joint-precision` uses `jointPrecisionText`.
- `test/scenario-e2e.mjs` `ws15Export` copies `joint[].progress` into the export, and so into the fixture when it is remade.
- No ⑮ source reads `underBy`.

**Personal view (observation, not changed).** `myVerified` keeps only positive totals (`v > 0`), and the screen shows "自分が届けた確定の量：—" when all are 0. It states neither an exact 0 nor a bound, so it does not contradict the contract. No change.

**Corrected existing tests: their closure and side effects** (read only; not audited for running, not to be run):

| File | Imports and effects |
|---|---|
| `test/coop.test.mjs` | `node:http`, `node:fs`, `node:os`; `coop/record.mjs`, `arrival.mjs`, `goal.mjs`, `board.mjs`, `chain.mjs`; `test/nokey.mjs` (a fixed signer and unsigned records), `test/coop-chain.mjs` (a fake chain); `permutation-server/web/frontier/fplay.mjs`, `faddr.mjs`, `herald.mjs` and `web/sdk/base58.mjs`. It starts local HTTP servers (`createServer`/`listen`: 5), makes `fetch` calls (8), uses a temporary directory, and writes or removes files (4). It is listed in `scripts/ci/node-key-tests.txt` |
| `test/coop.e2e.test.mjs` | `test/scenario-e2e.mjs` (the board, `coop/send.mjs`, the fake chain, `web/frontier/fplay.mjs`, `web/sdk/solana-tx.mjs`); `coop/record.mjs`, `goal.mjs`, `ws04.mjs`. It uses a temporary directory and writes or removes files. It reads the fixture `ws15-fold-e2e.json`. It is listed in `scripts/ci/node-key-tests.txt` |

**Limits of what has run.**
- The two pure runs (5/5 `fulfilBoundsText`, 8/8 `jointPrecisionText`) check only the wording for given values.
- Nothing has run that checks:
  - the count in `goal.mjs` (`h.records` → `underBy`);
  - the corrected expectations (`coop.test.mjs` stone `underBy` 0 → 2, and the `coop.e2e.test.mjs` fixture wood 4 → 5 correction);
  - the screen;
  - a real world.
- Those need the existing board, chain-fake and key-listed tests above, which are still not audited for running.

**Result of this audit.** No further mismatch was found in the counted-0, `KnownZero` and duplicate boundaries, so no code was changed in this step.

## The joint count moved to an import-free helper and wired into the real consumer (2026-11-17; nothing run)

**What moved.**
- `coop/joint-count.mjs` (new; no imports; sha256 `e6520b93…549fecfa`) exports `addCounted(perResource, records, counted)`.
- It is the joint loop's one line from `goal.mjs` (71764e61 to 6e812809), with the arithmetic unchanged: `perResource[r] += v` and `records[r] = (records[r] ?? 0) + 1`, for every key of `counted`, including a 0. It changes the caller's objects in place and returns nothing.

**The real consumer.**
- `coop/goal.mjs` `coopView` (sha256 `f167e2e5…6db5ed31`) imports it and calls `addCounted(h.perResource, h.records, a.counted)` in place of the inline line.
- The guards around it are unchanged:
  - `if (a.duplicateOf) continue`;
  - `if (a.counted)`;
  - the contributor and nation bookkeeping, `unprovenDeliveries` and `unverifiedCaravans`.
- Also unchanged: `blank()` (8 resources at 0), the verdict (reads `perResource`), `underBy` (reads `records`), `fulfilmentOf`, `countOf`, the judges, sending, signing and permissions.
- `goal.mjs` gains one relative import of a file in the directory the board serves.

**Pure regression** (`test/coop.joint-count.test.mjs`, sha256 `9000a3d5…5204ad05`, written, not run). It has five tests:
1. The fixture's five counted arrivals (copied by hand) give `perResource` wood 209 and stone 200, and `records` wood 5 and stone 2.
2. Arrivals recorded as 0 add 0 to the amount and 1 to the count.
3. The result equals a verbatim copy of the old inline line on six inputs.
4. The objects are changed in place, nothing is returned, and an empty `counted` changes nothing.
5. The arithmetic is unchanged even for a resource not seeded in `perResource`: it gives `NaN`, as before. `coopView` always seeds the 8 resources with `blank()`.

**Static audit.**

| Item | Finding |
|---|---|
| Closure | The test imports `node:test`, `node:assert/strict` and `../coop/joint-count.mjs` (no imports). It does not import `goal.mjs`, `record.mjs`, the board, the chain, `permutation-server/web/frontier` or the DOM |
| Top-level code | The helper has comments and one exported function. The test has imports, `const` helpers and `test(...)` calls |
| I/O, keys, network | None: no `fs`, `fetch`, `process`, `child_process`, `worker_threads`, dynamic `import()`, `new Function`, `require`, `document`, `window`, or key or sign API. No `node-key-tests.txt` entry is needed and the lists are unchanged |
| Refused work | It touches no walls, muster, G, runner or world code, and it is not a substitute for any refused run |
| Candidate command (for the coordinator; not run) | `node --test workstreams/01-national-strategy/test/coop.joint-count.test.mjs` |

**Not verified.** The pure test checks only the addition. Nothing has run that checks:
- that `coopView` calls the helper with the right guards;
- the board, chain-fake or key-listed tests (`coop.test.mjs`, `coop.e2e.test.mjs`, including their corrected expectations);
- the screen;
- a real world.

Those are not treated as done.
