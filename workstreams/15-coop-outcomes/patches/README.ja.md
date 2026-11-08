# ④への統合の材料

## ④の公開統合候補 cf517b55 への適用（2026-11-08）

④の `claude/gallant-ride-cunptv` @ `cf517b558d1303a84dba618550f40cb460b7ad99` には、⑮が `b1a09a0b` のまま入っている（`workstreams/15-coop-outcomes` の tree `4d7f8e74`）。④はそのあと⑮の中を変えていない。だから、⑮の新しい commit は早送りの形で重ねられる。

1. ⑮の `ws/15-coop-outcomes` を取り込む：`git fetch origin ws/15-coop-outcomes && git merge --no-ff FETCH_HEAD`。⑮の中は衝突しない（`git merge-tree` で確認）。
2. 続けて `git apply workstreams/15-coop-outcomes/patches/ws04-chain-flow-stage-d-cf517b55.patch`。④の chain flow の stage D（`tools/chain-flow/stages-cde.mjs`・`check-fixtures.mjs`・`fixtures-20261106/d-outcome.json`）を、⑮の今の adapter の呼び方に合わせる。**④の領域なので、適用するかは④が決める。**
   - 1 だけを当てて 2 を当てないと、⑮の adapter の呼び方が変わっているので、stage D を作り直すときに検査が 2 つ落ちる（「4 wood の送り」「到着が chain で正確」）。⑮は古い呼び方 `(receipts, map, opts)` も受け付けるので、例外では止まらない。
   - 2 を当てると、送りは 4 wood、到着は「少なくとも 4」になる。到着は下限（`lower_bound`、`chain_lower_bound`）で、正確な 4 ではない。④の数量契約 §3 の Recorded（案 B）のとおり。stage C（⑫）と E（賞金）の出力はバイト単位で変わらない。`check-fixtures.mjs` は 31/31。
   - 確かめ方：④の固定データ `b-store-dump.json` から SQLite の store を作り直し（列は `dump-store.mjs` が読むものと同じ）、`stages-cde.mjs` を `--import ./scripts/ci/no-keys-guard.mjs` の下で動かした。cargo の stage A・B は動かしていない（鍵を作る試験を含むため）。

統合しても、勝利条件・評価期間・賞金・世界の終わりは決まらない。評価器は判定を返すだけで、送金もチェーンへの書き込みもしない。

## 以前の材料（2026-10-30、記録として残す）


この担当は `workstreams/15-coop-outcomes/` の外を変えていない。統合は次のどちらかで行う。

1. **この担当の commit をそのまま取り込む。** 添付の `ws15.bundle`、または `patches/series/*.patch`（`git format-patch 4cd901de..ws/15-coop-outcomes`）を使う。基準 4cd901de に当たる。共有コードへの差分は含まない。
2. **評価器だけを使う。** `src/` は依存のない ES module。Node 20 以上とブラウザで動く。リポジトリの `permutation-gateway/client/src/sha256.mjs` だけを相対パスで読む。

## 統合で決める点（④の判断）

| # | 点 | 案 |
|---|---|---|
| I1 | Run Receipt の `body` の欄 | **済み（5753626c 以後）**：adapter は subject の持ち主・run の spec・run の outcome を読む。④の実物（runexec demo・chain flow）で確かめた |
| I2 | P1（settle に `credited`・`lost`） | 入れば `RuleDerived` の解釈の差（①は下限、④は正確な量）が消える。評価器の側の変更は不要 |
| I3 | 記録の流れの番号 | 評価器は流れごとの連続番号で欠落を見る。ヘラルドの `/h/events` の番号を使うか、④の journal の番号を使うかを決める |
| I4 | 建物の利用の記録 | 砦の守備（FORT_GARRISONED）以外の利用の記録がない。共同目標の「実際の利用」を塔・柵に広げるなら、プログラムへの記録の追加（コアの担当） |
| I5 | 早期終了（案 C を採る場合だけ） | ゲームの Season と `permutation-prize` の Tally を、作成時の `end_bell` より前に閉じられるようにする変更。この担当は案 C を推していない（[04](../docs/04-variants.ja.md)） |

統合しても、勝利条件・賞金・世界の終わりは変わらない。評価器は判定を返すだけで、送金もチェーンへの書き込みもしない。
