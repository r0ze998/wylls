# ④への統合の材料（いずれも未適用）

この担当は `workstreams/15-coop-outcomes/` の外を変えていない。統合は次のどちらかで行う。

1. **この担当の commit をそのまま取り込む。** 添付の `ws15.bundle`、または `patches/series/*.patch`（`git format-patch 4cd901de..ws/15-coop-outcomes`）を使う。基準 4cd901de に当たる。共有コードへの差分は含まない。
2. **評価器だけを使う。** `src/` は依存のない ES module。Node 20 以上とブラウザで動く。リポジトリの `permutation-gateway/client/src/sha256.mjs` だけを相対パスで読む。

## 統合で決める点（④の判断）

| # | 点 | 案 |
|---|---|---|
| I1 | Run Receipt の `body` の欄 | [src/adapters/ws04.mjs](../src/adapters/ws04.mjs) の仮定（`owner_tag, seq, cargo[8], dst, credited?, verification, choice, taken[8], raider_tag`）と、④の実物の照合。違えば adapter だけを直す |
| I2 | P1（settle に `credited`・`lost`） | 入れば `RuleDerived` の解釈の差（①は下限、④は正確な量）が消える。評価器の側の変更は不要 |
| I3 | 記録の流れの番号 | 評価器は流れごとの連続番号で欠落を見る。ヘラルドの `/h/events` の番号を使うか、④の journal の番号を使うかを決める |
| I4 | 建物の利用の記録 | 砦の守備（FORT_GARRISONED）以外の利用の記録がない。共同目標の「実際の利用」を塔・柵に広げるなら、プログラムへの記録の追加（コアの担当） |
| I5 | 早期終了（案 C を採る場合だけ） | ゲームの Season と `permutation-prize` の Tally を、作成時の `end_bell` より前に閉じられるようにする変更。この担当は案 C を推していない（[04](../docs/04-variants.ja.md)） |

統合しても、勝利条件・賞金・世界の終わりは変わらない。評価器は判定を返すだけで、送金もチェーンへの書き込みもしない。
