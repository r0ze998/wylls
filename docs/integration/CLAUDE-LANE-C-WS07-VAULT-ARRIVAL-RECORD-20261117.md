# ⑦ caravan state, arrival and quantity on the game page: one completion unit (Lane C, 2026-11-17)

The first commit (`f99af84d`) fixed the storehouse record. The section "Completion unit" below covers the rest of the same display path, done on the same branch.

**Branch:** `claude/lane-c-ws07-vault-arrival-record-20261117`, from the shared aggregate at `51daba36b64eed064db3ba4d3f8c109eda487c5c` (fixed base). The aggregate and every other branch are unchanged.

**Written, not run:** no test, syntax check, import, page or world. The policy was approved by the parent.

## The facts (source at `51daba36`)

- **Producer:** `permutation-frontier/src/proc/caravan.rs:402-409` `cargo_log` writes `floor(milli / 1000)`, saturated at `u32::MAX`. The vault branch (`:1035`) adds the **milli** cargo and then cuts at the cap: `min(have + c, max(cap, have))`. So what a storehouse took in can exceed the recorded whole number by up to just under 1, and by any amount if the record saturated. An all-zero record can still mean a fraction went in.
- **The real path:** `hud/returnsum.mjs` `withArrival` → `hud/statussources.mjs` `arrivalSettled` → `hud/statusview.mjs` `arrivalView`. The result shows in the returns feed (`hud/returnwords.mjs`) and on the village card (`screens/s1.mjs`).
- **Before:** `statusview.mjs` `atMostText` gave "到着しましたが、入った量は確認できません（食料 最大 400）", and "（最大 0）" for an all-zero record. That claims an upper bound the record does not support, and with zero it states 0 as a maximum. ⑦'s `CONTRACTS.ja.md` said "（最大 n）" (v7).

## The change (display only)

| Path | Change |
|---|---|
| `permutation-server/web/frontier/hud/statusview.mjs` | `atMostText`, used nowhere else, is replaced by `recordedText`: the record's numbers ("食料 400・木材 50"), and **"0"** for all zero, never "なし" or "最大 0". The vault text is "到着しましたが、入った量は確認できません（記録の積荷：…）". The vault detail shows the same recorded value and adds "記録の数は 1 未満を切り捨て、大きすぎる値は上限で止まるため、入った量の上限も記録からは決まりません" |
| `permutation-server/web/lang/en-frontier-play.mjs` | The two new keys added ("…(cargo on the record: {0})", and the sentence on truncation and saturation); the now unused `'{0} 最大 {1}'` and `'最大 0'` removed. None of the banned English words |
| `workstreams/07-player-experience/CONTRACTS.ja.md` | The `settledUnverified` row corrected (v7's "最大 n" was wrong, with the reason). The storehouse section states the record's rounding and saturation, and that no "最大" is shown |
| `permutation-gateway/test/web-frontier-ws07-contracts.test.mjs` | The pinned "（食料 最大 400）" corrected to "（記録の積荷：食料 400）", with the reason. Added: no "最大" anywhere in text or details; an all-zero record reads "（記録の積荷：0）" with no "最大 0" or "なし" |
| `permutation-gateway/test/web-frontier-ws07-connect.test.mjs` | The pinned feed line corrected the same way |
| `permutation-gateway/screens/ws07-s1-page.screen.mjs`, `ws07-s1-pure.screen.mjs` | The pinned regular expression corrected to "（記録の積荷：…）" |
| `permutation-gateway/test/web-frontier-ws07-vault-record-text.test.mjs` (new) | See below |

**Not changed:**
- the village lower bound (`atLeastText`: "n 以上", "0 以上") and `cargoText` (still used for lost cargo);
- the arrival states and how they are judged (`statussources.mjs`, `returnsum.mjs`);
- sending, assets, rules and MCP;
- main's ④ and D's ③ server store.

## Regression (written, not run)

- **Behaviour:** the corrected cases in `web-frontier-ws07-contracts.test.mjs` and `web-frontier-ws07-connect.test.mjs`. They import `statusview.mjs`, whose closure loads `fi18n.mjs` and `lang.mjs` (the subjects of refused tests), so they are **not** claimed independent. Whether to run them is the coordinator's decision. The two page screens are browser runs and were not started.
- **Key-free text check:** `web-frontier-ws07-vault-record-text.test.mjs` imports only `node:test`, `node:assert/strict` and `node:fs`, and reads `statusview.mjs`, the English dictionary and `caravan.rs` as text. It checks:
  - **V1:** `cargo_log` is floor and saturating;
  - **V2:** `atMostText` is gone, the vault text and detail use `recordedText`, all-zero is '0', and there is no "最大" in the vault branch;
  - **V3:** the new English keys are present, the at-most keys are gone, and there are no banned words.

  Candidate command (not run): `node --test permutation-gateway/test/web-frontier-ws07-vault-record-text.test.mjs`.

## Not verified

No run of anything. The real page (returns feed, village card) was not loaded.

## Hand-over

- **Base:** `51daba36b64eed064db3ba4d3f8c109eda487c5c`.
- **Branch:** `claude/lane-c-ws07-vault-arrival-record-20261117` (the tip is given in the session report).
- **Nine paths:** the seven above, this report, and the new text test.

## Completion unit: the whole display path, same branch (2026-11-17; nothing run)

**Path traced once, end to end (source):**
- **Producer:** `permutation-frontier/src/proc/caravan.rs`. `cargo_log` writes floor(milli / 1000) saturated at u32::MAX; the vault cuts after adding milli; `caravan_outcome` is 0 DELIVERED or 1 LOST.
- **Away summary:** `hud/returnsum.mjs` (`itemOf`, `withArrival`) → `hud/statussources.mjs` `arrivalSettled` → `hud/statusview.mjs` `arrivalView` → `hud/returnwords.mjs` `itemText`.
- **Village card:** `screens/s1.mjs` `caravanStatus` (④'s registered `caravanArrival`, else `arrivalOnRoad` → overdue) → `arrivalView`.
- **Dictionary:** `lang/en-frontier-play.mjs`.

**Mismatches found and fixed:**

| # | Where | Before | After |
|---|---|---|---|
| F1 | `statusview.mjs` vault (`f99af84d`) | "（食料 最大 400）", "（最大 0）" | "（記録の積荷：食料 400）", "（記録の積荷：0）", plus the truncation and saturation sentence |
| F2 | `statusview.mjs` lost | "積荷は失われました：食料 400", and "：なし" for all zero (a fraction may have been lost) | "積荷は失われました（記録の積荷：食料 400）", "（記録の積荷：0）" |
| F3 | `statusview.mjs` verifiedPartial detail | "送付記録の数量：なし" for an all-zero send record | "送付記録の数量：0". Non-zero is unchanged |
| F4 | `returnwords.mjs` uncertain settle (your send, holder not known) | Always "到着が記録されました", even for **LOST (outcome 1, a valid ABI value)** or an unreadable outcome | Outcome 0: unchanged. 1: "積荷が失われたと記録されました…失ったのは奪った側です". Other: "決着が記録されました。結果を記録から読めないため、着いたとも失われたとも言いません" |
| F5 | `returnsum.mjs` `itemOf` | `delivered: true` for any outcome other than 1 | `delivered` only for outcome 0. The uncertain path carries `lost` and `delivered` for F4. Tones are unchanged (the holder-me text already comes from `arrivalSettled` `outcomeUnknown`) |

**Checked and consistent (no change):**
- the village lower bound ("n 以上", "0 以上", saturation still a valid lower bound) and verifiedFull/Partial against the send record;
- misdelivered (no amount, no cause named), overdue, unread and outcomeUnknown;
- invalid cargo: `isCargo` refuses negative, NaN, text and wrong length, so verified states return "状態を受け取れていません", and the vault and lost lines omit the amounts. The provider's loose `ok()` is therefore not visible.

**Out of scope, noted:**
- `costView` "未確定：最大 …" belongs to ⑤ costs.
- `workstreams/07-player-experience/src/return-summary.mjs` is ⑦'s prototype copy, consumed only by `prototype/app.mjs` and its own tests, not by the game page.
- An unknown **raid** choice in MCP was noted earlier.

**Dictionary:** English entries were added for every new Japanese template. The keys that became unused were removed: `'{0} 最大 {1}'`, `'最大 0'`, `'積荷は失われました：{0}'`. There are no banned English words.

**Contract:** `workstreams/07-player-experience/CONTRACTS.ja.md` now has:
- the `settledUnverified` row (F1) and the `lost` row (F2);
- a new paragraph on the uncertain settle (F4/F5);
- the storehouse section's note on rounding and saturation.

**Existing expectations corrected (with reasons in place):**
- `test/web-frontier-ws07-contracts.test.mjs` (vault, lost);
- `test/web-frontier-ws07-connect.test.mjs` (vault feed line);
- `screens/ws07-s1-page.screen.mjs`, `screens/ws07-s1-pure.screen.mjs` (vault).

All other pins still hold. "送付記録の数量：食料 400" and the uncertain-delivered line (`screens/ws07-s1.screen.mjs:52`) are unchanged. No test deep-compares the uncertain item's facts.

**Regression sources (written, not run):**
- `test/web-frontier-ws07-arrival-quantity.test.mjs` (new). It drives the real functions (`arrivalSettled` → `arrivalView`, `itemText`) for:
  - normal; not read; 0; fractions; u32 saturation; invalid;
  - the uncertain settle by outcome;
  - English.
- `test/web-frontier-ws07-vault-record-text.test.mjs`: a key-free text check, V1–V4 (V4 covers F4/F5 and the dictionary).

## Pre-run audit of the test candidates (static; nothing run)

| Test | Static import closure | Refused subjects reached | Key scan | Verdict |
|---|---|---|---|---|
| `web-frontier-ws07-vault-record-text.test.mjs` | Itself only (`node:test`, `node:assert`, `node:fs`). It reads five source files as text; no write, network, key or environment | None | Not listed, no key API | **The only independent candidate**: `node --test permutation-gateway/test/web-frontier-ws07-vault-record-text.test.mjs` (from the repository root; or through `scripts/ci/node-keyfree.sh permutation-gateway test/web-frontier-ws07-vault-record-text.test.mjs`) |
| `web-frontier-ws07-arrival-quantity.test.mjs` | 29 files; no `child_process`, `worker_threads`, dynamic `import()` or `new Function` | `lang.mjs`, `fi18n.mjs` | No key API in the closure (it would not need listing) | **Held**: refused-adjacent; the coordinator decides |
| `web-frontier-ws07-contracts.test.mjs`, `web-frontier-ws07-connect.test.mjs` | ~100 files | `fland.mjs`, `rulebook.mjs`, `lang.mjs`, `fi18n.mjs` | **Listed** in `node-key-tests.txt` (the closure names key APIs: the vendored noble curves, `tilt.mjs`) | **Held**: manual key-tests job only, and refused-adjacent |
| `screens/ws07-s1*.screen.mjs` | Browser (Chromium) | — | — | **Not run**: unaudited page runs |

## Done / not done

- **Done (static):** F1–F5 in the real page path, English synced, the contract aligned, expectations corrected, regression sources written, the closures audited.
- **Not done or not verified:**
  - no test has run;
  - the returns feed and the village card were not loaded;
  - no real world was run;
  - `myVerified`-like data decisions are not in this unit.

## Hand-over to D (the aggregate is not changed here)

- **Base:** `51daba36b64eed064db3ba4d3f8c109eda487c5c`.
- **Branch:** `claude/lane-c-ws07-vault-arrival-record-20261117`, two commits: `f99af84d`, then this completion unit, which is the tip.
- **Paths against the base (12):**
  - code: `hud/statusview.mjs`, `hud/returnsum.mjs`, `hud/returnwords.mjs` and `lang/en-frontier-play.mjs` (all under `permutation-server/web/`);
  - `workstreams/07-player-experience/CONTRACTS.ja.md`;
  - tests: `permutation-gateway/test/web-frontier-ws07-{contracts,connect}.test.mjs` (corrected), `web-frontier-ws07-arrival-quantity.test.mjs` (new), `web-frontier-ws07-vault-record-text.test.mjs` (new);
  - screens: `permutation-gateway/screens/ws07-s1-{page,pure}.screen.mjs` (corrected);
  - this report.
- **Likely conflict points:** `en-frontier-play.mjs`, near the arrival keys, is a shared dictionary, and `CONTRACTS.ja.md` is shared. Both edits are local and line-based.
