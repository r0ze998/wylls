# ⑧ 続く世界で、新人・敗者・離席した人にも役割を残す設計

**状態（2026-10-30）：** 抽象モデルによる比較と、仮説の整理です。

- A・B1・B2・C の**いずれも採用していません。**
- 次の検証の候補は B2（B1＋軍解散）です。A と C は比較の対象として残します。
- どの数字も、実プレイヤーへの効果を確かめたものではありません。

**基準：**
- 基準 commit は `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補）。main 統合済み・CI 全成功とは扱っていません。
- 基準 commit には `AGENTS.md` と関連スキルがありませんでした。代わりに `docs/DEVELOPMENT-HANDOFF.ja.md` と `docs/frontier/MAINTENANCE.md` に従いました。

**範囲：**
- ①は一つの国の作戦と参加、⑧は長期の世界構造と参加経路を扱います。
- 他担当の仕様、本番のルール・期間・資源量、共有コアは変更していません。
- 新しい通貨、投資商品、収益の保証、現金の報酬は追加していません。

## 成果物

| 章 | ファイル | 中身 |
|---|---|---|
| 1 | [01-current-rules.ja.md](01-current-rules.ja.md) | 現行ルール表（根拠の行とテスト名つき） |
| 2 | [02-retention-matrix.ja.md](02-retention-matrix.ja.md) | 地形・施設・資源・軍事力・所属・権利・履歴・創作定義・評判を、対象ごとに残す・戻す |
| 3 | [03-proposals.ja.md](03-proposals.ja.md) | 案（P0、A、B1、B2、C）の比較。次の検証の候補と、その限界・失うもの・コスト |
| 4 | [04-simulator.ja.md](04-simulator.ja.md) | シミュレーターの仕組み、再現手順、限界、テスト |
| 5 | [05-results.ja.md](05-results.ja.md) | 結果、対になった差と区間、頑健さ、維持された条件と崩れた条件、離脱の格子、反例 |
| 6 | [06-play-scenarios.ja.md](06-play-scenarios.ja.md) | 新人・敗者・復帰者の筋書き：何が残り、何を失い、次に何を選べるか |
| 7 | [07-rights-boundary.ja.md](07-rights-boundary.ja.md) | 所有権と区切りの境界：贈与・預かり・使用権・輸送中の4つを分ける。追跡データの要件。①②④⑥への接続案 |
| 8 | [08-playtest-checks.ja.md](08-playtest-checks.ja.md) | 試遊での観察項目の一覧 |
| 9 | [09-metrics.ja.md](09-metrics.ja.md) | 指標の定義・分母・期間・集計単位、不確実性の読み方、組み込みと結果の区別 |
| 10 | [10-demobilization.ja.md](10-demobilization.ja.md) | 軍の解散（B2 の追加規則）：対象、残す兵力、払い戻し、駆け込み、失う人への影響 |
| 11 | [11-season-end-suspicions.ja.md](11-season-end-suspicions.ja.md) | シーズン終了時の実装上の疑い（隊商、倉）。LiteSVM の最小再現と、修正の草案（未適用） |
| 12 | [12-multi-account.ja.md](12-multi-account.ja.md) | 多重アカウント：便益と費用、対策の候補ごとの負担と抜け道 |
| 13 | [13-handoff-01-operations.ja.md](13-handoff-01-operations.ja.md) | ①への引き渡し：受付時間、非同期の申し出、離席中の参加、期限 |
| 14 | [14-handoff-05-ai.ja.md](14-handoff-05-ai.ja.md) | ⑤への引き渡し：常時稼働 agent は格差を縮めるか、広げるか |
| 15 | [15-playtest-four-scenes.ja.md](15-playtest-four-scenes.ja.md) | 試遊案：新規参加・敗北・復帰・区切り直前の4場面（外部募集はしない） |
| — | [sim/](sim/) | シミュレーター（Node.js、依存ライブラリなし） |
| — | [results/](results/) | 生成された結果。`core`、`replication-seeds101-130`、`sensitivity`、`exploits`、`retention` |
| — | [repro/](repro/) | シーズン終了時の再現テスト（リポジトリの外で組み立てて実行）と、修正の草案 |

## 再現

```sh
cd workstreams/08-persistence/sim
node --test ./*.test.mjs                                        # 20件
node run.mjs --seeds 30 --only core --out ../results/core       # ほかの群は 4章
workstreams/08-persistence/repro/run.sh [作業ディレクトリ]        # Agave 3.1.9 が要る（11章）
```

## 結論の要約（詳しくは3章・5章）

1. **既存決定（B1：砦の中立化と守備兵の帰還）は、現行（P0）より、前の勝者が再び勝ちやすかった。**
   - 首位の連続率は 0.44 → 0.59。
   - 感度31条件のすべてで、同じ向きだった。
2. **⑧が加えた軍の解散（B2）は、その傾向を下げた。**
   - B2−B1 は −0.23（95%区間 −0.39〜−0.07）。感度31条件のすべてで、同じ向きだった。
   - B2 と A の差は、区別できなかった。
3. **蓄積を残すと、資産は偏り、新人の重みは下がる。** これは、すべての条件で起きた。
   - ジニ係数 0.23 → 0.35。
   - 途中参加の7日貢献比 0.55 → 0.21。
4. **A と B2 のどちらが人を残すかは、人がやめる理由の仮定で決まった。**
   - 他人と比べてやめるなら、A。
   - 世界の作り直しを自分の損と感じるなら、B2。
   - どちらが現実に近いかは、試遊で確かめる（15章）。
5. **接続回数による貢献の差は、大部分が作戦の受付の規則から直接決まる**（組み込み）。①の作戦の作りで変えられる（13章）。
6. **シーズン終了時の2つの疑いは、LiteSVM で再現した**（11章）。
   - 終了をまたいだ隊商は、永久に決着できない。
   - 倉は、終了後に閉じられない。

## テストの状態（最新のローカル commit）

| 対象 | 状態 |
|---|---|
| `node --test workstreams/08-persistence/sim/*.test.mjs` | **通過 20／失敗 0** |
| `node run.mjs` 全5群（core、replication、sensitivity、exploits、retention） | 実行済み、終了コード 0 |
| `repro/run.sh`（LiteSVM、test-beacon ビルド） | **通過 3／失敗 0**（＝2つの疑いが再現した） |
| リポジトリ既存のテスト（Rust、LiteSVM の共有スイート、web など） | **未実行**。この作業は既存のコードを変えていない |
| CI | **未実行**。push していない |
