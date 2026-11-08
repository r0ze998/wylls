# ⑮ 協力が達成・勝利につながる条件：評価器と比較

作業日 2026-10-30。基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`。ブランチ `ws/15-coop-outcomes`（未 push）。この担当の変更はこのディレクトリの中だけ。

**本番の勝利条件を決める文書ではない。** 数字はすべて暫定の置き値。人間による理解・面白さは未評価。

## 結論

**2026-10-31 の訂正：世界は続く。** 評価器は世界を終わらせない。評価期間（戦期）は外から与える入力で、閉じるのは判定だけ。
- 荷・建物・移動中の隊商・未完成の計画・記録は、次の評価期間へ引き継がれる。
- C は「評価期間だけを閉じる比較案（未採用）」に変えた。
- B・C は賞金を決めない（未決）。A の賞金は旧経路の互換確認だけ。

変更の詳細は [docs/07-continuity.ja.md](docs/07-continuity.ja.md)。

| | A：現行の競争（旧経路の互換確認） | B：別々に判定 | C：共同達成で評価期間だけを閉じる（比較案） |
|---|---|---|---|
| 協力が記録に残る | 残らない | 理由つきで残る | 理由つきで残る |
| 世界が終わる | 終わらない | 終わらない | 終わらない |
| 共同達成が、閉じた時点の要塞の先頭を変える | — | 変えない（16/16） | 変える（早く閉じた 9 のうち 3） |
| 先行国の早期終了 | — | できない | 一国だけならできない。従う国を使えば、または印のない別アカウントならできる |
| 不利な国の妨害 | — | 達成が遅れるだけ | 閉じる時刻と先頭が動く |
| 待つ・従う以外の選択 | ある（目標なし） | ある（目標あり） | ある |

模型の上では、**B が、協力に意味を持たせつつ勝敗を動かさない**。C は評価期間だけを閉じても、閉じる時刻を握ることが先頭を左右し、早期終了と妨害の動機が残った。採否の判断に要る点は [06](docs/06-conflicts-decisions.ja.md) の Q1〜Q8 と [07](docs/07-continuity.ja.md) の M1〜M8 にある。

## 中身

| パス | 内容 |
|---|---|
| [docs/01-premises.ja.md](docs/01-premises.ja.md) | 確かめたこと：コード・決定・他の担当・OSS の比較 |
| [docs/02-preregistration.ja.md](docs/02-preregistration.ja.md) | 検証の前に決めた差・成功の条件・反証の条件。最初の commit `c74824516f9bdfbfdb2c065dc1583da4b4388fb7` |
| [docs/03-contract.ja.md](docs/03-contract.ja.md) | イベント・目標・判定結果の契約（版 0）。①④⑭と共有 |
| [docs/04-variants.ja.md](docs/04-variants.ja.md) | 3案の定義と得失 |
| [docs/05-results.ja.md](docs/05-results.ja.md) | 試験の結果と予測の当たり外れ |
| [docs/06-conflicts-decisions.ja.md](docs/06-conflicts-decisions.ja.md) | 既存ルールとの衝突、採用に必要な判断、文書とコードの食い違い |
| [docs/08-peer-contracts.ja.md](docs/08-peer-contracts.ja.md) | ①・④・⑭の実出力との照合（§5d：①の fold() と④の runexec の書き出し、u64）：⑭の t・req・cross と掲示・引受の意味、模型の事実を数えないこと、到着量の下限・ゼロ・不明、評価期間の境界 |
| [docs/07-continuity.ja.md](docs/07-continuity.ja.md) | 世界を終わらせない評価への訂正：残っていたシーズン依存、変えた挙動、試験、残る移行の判断 |
| `src/` | 評価器：`contract`（入力）・`ledger`（記録の検査と正準の並び）・`world`（荷・隊商・計画・建物）・`goals`（共同・国・個人）・`evaluate`（判定結果・賞金・選択肢）・`rulesets`（A/B/C） |
| `src/adapters/` | `s1-chain`（S1 の記録）、`ws01`（①の依頼の板）、`ws04`（④の Run Receipt）、`ws14`（⑭の塔、任意） |
| `scenarios/` | 固定入力 16 件、`fixtures/` に①・④・⑭の出力（作り方と出どころの commit つき）。（`build.mjs` で生成、試験で一致を確認）。`long.mjs` は長期の世界を固定の種で作る |
| `test/` | `node --test` の 120 件（①の fold()・④の runexec と chain flow・⑭の実出力に対する契約試験を含む）。もとの 70 件（境界・再開の確認、見直しで見つけた不具合の再現を含む）、画面の確認 `play.browser.mjs`、長期の確認 `long-run.mjs` |
| `play/` | 手で遊べる比較の画面 |
| `bin/` | `eval.mjs`（1件を判定）、`compare.mjs`（全件の比較表） |
| `results/` | 実行ログ、比較表、画面の画像 |
| `patches/` | ④への統合の材料（未適用） |

## 実行

```sh
# 前提：Node 20 以上。依存のインストールは不要
node --test workstreams/15-coop-outcomes/test/*.test.mjs
node workstreams/15-coop-outcomes/bin/eval.mjs workstreams/15-coop-outcomes/scenarios/rush-clients-own.json B C
node workstreams/15-coop-outcomes/bin/compare.mjs
node workstreams/15-coop-outcomes/test/long-run.mjs 160   # 長期（数十秒）
# 画面（127.0.0.1 だけで待ち受ける）
node workstreams/15-coop-outcomes/play/serve.mjs 8715   # → http://127.0.0.1:8715/workstreams/15-coop-outcomes/play/
node workstreams/15-coop-outcomes/test/play.browser.mjs # Playwright と Chromium が要る
```

## 担当の境界

- ①の依頼の仕組み、⑧の地図・人口の模型、⑭の塔は作り直していない。⑧の外部報酬付き協力（COOP）は使っていない。報酬の倉も補助金も足していない。
- 勝利条件の本番への採用、push・merge・deploy、実資金、外部への募集はしていない。
