# 6. ②③④とのつなぎ目（⑥が必要とする形だけ）

⑥は、権利（②）・命令の型（③）・実行と完了記録（④）の **別仕様を作らない**。⑥のコードの中でそれらに当たる部分は、どれも「今ある S1/S2 のデータを読むアダプタ」か「模擬」で、置き換える場所を一か所に集めてある。

| ⑥が必要とするもの | 置き換え先 | 今の実装（暫定） | 置き換える場所 |
|---|---|---|---|
| 利用者がある施設・倉に対して、ある種類の権利を、今日、何回分持っているか | ② Grant | S2 の束（Lot）と発行（Issue）の欄を写した模擬データを読む（`grantProblem`・`useRunsLeft`・`workshopRunsLeft`・`candidateLots`） | `src/world.mjs` |
| 組み合わせてよい効果の一覧と、その型・使う物・作る物・費用・失敗の仕方 | ③ 命令型 | S1/S2 の既存命令を⑥が手で写した表（タグ・CU は ABI から） | `src/catalog.mjs` |
| 成果の記録を id で引き、作った定義・出力・受け取り手・場所・物・結果・確定を読み、1回だけ使用済みにする | ④ Run/Receipt | 模擬の台帳（内容のハッシュを id にする） | `src/ledger.mjs`、模擬実行は `src/run.mjs` |

提案の詳細（欄の名前、エラーの対応、⑥のテストをどう流用できるか）は `proposals/` に分けた。**どれも提案で、他担当の仕様・共通コア・共有 UI は変更していない。**

- [proposals/02-grant.ja.md](../proposals/02-grant.ja.md)
- [proposals/03-command-types.ja.md](../proposals/03-command-types.ja.md)
- [proposals/04-run-receipt.ja.md](../proposals/04-run-receipt.ja.md)
- [proposals/05-shared-ui-and-ci.ja.md](../proposals/05-shared-ui-and-ci.ja.md)
