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
