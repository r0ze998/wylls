# ⑦ village card / returns: a storehouse arrival shows the record's cargo as the record, never "最大" (Lane C, 2026-11-17)

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
