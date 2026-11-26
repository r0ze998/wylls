# ⑮ 協力が達成・勝利につながる条件：評価器と比較

> **状況 2026-11-19（main `1d6c0039`、コードが正）：** 案 B は main につながっている（PR #31、所有者の決定 t335u）：称号と年代記だけ、勝敗・賞金には効かない、`carryInputs` は true。CI の `coop15`（PR #26）。`scripts/play-local.sh` の世界は板を起動しないので、称号はそこでは見えない（未マージの PR #60 で直す）。全体の表は [台帳](../../docs/integration/CLAUDE-WORKSTREAMS-1-20-LEDGER-20261116.md) の「Status 2026-11-19 JST」。下の本文は当時の記録で、書き換えていない。

作業日 2026-10-30。基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`。ブランチ `ws/15-coop-outcomes`（未 push）。この担当の変更はこのディレクトリの中だけ。

**本番の勝利条件を決める文書ではない。** 数字はすべて暫定の置き値。人間による理解・面白さは未評価。

## 結論

**2026-10-31 の訂正：世界は続く。** 評価器は世界を終わらせない。評価期間（戦期）は外から与える入力で、閉じるのは判定だけ。
- 荷・建物・移動中の隊商・未完成の計画・記録は、次の評価期間へ引き継がれる。
- C は「評価期間だけを閉じる比較案（未採用）」に変えた。
- B・C は賞金を決めない（B は 2026-11-18 に決定済み、C は凍結。下の「持ち主の決定」）。A の賞金は旧経路の互換確認だけ。

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

## 本番への接続（2026-11-18、持ち主の決定：案 B）

持ち主の決定（2026-11-18）：**案 B を採る。** 評価器は共同の達成を判定し、**称号と年代記の行としてだけ**残す。勝敗・得点・賞金・シーズンの終わりには何も加えない。材料は評価期間をまたいで数える（`carryInputs: true`、07 の M5）。案 C は凍結（コードは残すが、本番の経路からは呼ばない）。A は旧経路の互換確認だけ。

| 層 | 場所 | すること |
|---|---|---|
| ⑮ | `src/live.mjs` | `PRODUCTION`（variant 'B'）・`productionRuleset()`（B 以外・持ち越しなし・賞金あり・早く閉じる設定を拒む）。ヘラルドの `/h/events` の行と①の板（ws01-board v1）から評価器の入力を作り、判定結果の `awards` から称号・理由（日本語と英語）・年代記の行を作る。`scores`・`prize` は写さない。`effects` は四つとも 'none' |
| ① | `coop/board.mjs` の `GET /coop/outcomes` | ヘラルドの `/h/season` と `/h/events`（最初から、読んだ所から続ける）を読み、`evaluateLive` に渡す。読むだけ。チェーンの状態・ABI は変えない |
| ⑦（画面） | `permutation-server/web/frontier/hud/coopoutcomes.mjs` | 同じ入口の `/coop/outcomes` を読み、「その他」の年代記の下に「称号と記録」の札を出す。効果を名乗る答え・B 以外の答えは出さない。板の無いサーバーでは何も出さない |

**2026-11-22 の持ち主の決定（11:56、Q1-⑮）：「依頼に応えた」の称号。** ①の協力の依頼が依頼量に届いた（①の板が、数えた量の下限で証明した）とき、その依頼に自分の隊商で届け、自分の到着が数えられた人に、個人の称号 P-board-helper「依頼に応えた」を与える。勝敗・得点・賞金には関わらない（称号と年代記だけ）。

| 場所 | すること |
|---|---|
| ① `coop/export.mjs` `fulfilmentsForEvaluators` | 板の表示と同じ確かめ（`coopView`：到着時の受取人が依頼した人・応じた後の送信・規則の版）で、status `fulfilled` の依頼だけを、契約「ws01-fulfilled v1」で渡す。届けた人は、数えられた到着（counted が正）のある人だけ。到着ごとに CARAVAN_SETTLED の署名を付ける |
| ① `coop/board.mjs` `outcomes()` | 上を `evaluateLive({ fulfilled })` に渡す。チェーンを読めない板では空 |
| ⑮ `src/live.mjs` `fulfilledEvents` | やり直して確かめる：依頼の資源ごとに、届けた人の下限の和が依頼量以上か。到着の署名がヘラルドの `/h/events` の行にあるか（無ければ待つ。称号のターンはその行のターンの最大）。イベント `request.fulfilled`（流れ `ws01-fulfilled`、verified `derived`） |
| ⑮ `src/goals.mjs` | B 版 4 の P-board-helper（`sources: ['ws01-fulfilled']`）：自分の下限が正・依頼が依頼量に届いた（届いたかは、依頼した人と同じ国の人の届け物も含めた、数えたすべての届け物で決める。2026-11-26 持ち主の決定 Q-TG2-2）・依頼した人ではない（同じ cluster でもない）・依頼した人と国が違う（記録で確かめた国。分からなければ未判定）。一人一つの評価期間に一つ（報酬枠） |
| ⑦ `hud/coopoutcomes.mjs` | この称号の行は `audience: 'subject'`：本人のページだけに「あなたが称号「依頼に応えた」を得た」と出す。依頼した人・ほかの人のページには出さない（`/coop/outcomes` の答えそのものは公開。板の結び付けも公開） |

版：B は版 3 → **版 4**（hash `d3bd326d…` → `463e2487…`）。status も `comparison-only` → `production-titles-only`（D-verify-pr31-1 の食い違いを同じ版で直した）。A・C は版 3 のまま、hash も同じ（C は凍結。C の P-board-helper は①を読まない）。版 3 の判定を再生するには、版 3 の rulesets.mjs が要る。

まだ決まっていないこと（持ち主の判断待ち）：別の国にいる自分の別アカウント（印のない sybil）は記録からは見分けられない。依頼量の下限が無いので、木材 1 の依頼でも称号になる（ただし一人一つの評価期間に一つ）。依頼量に届いた後に着いた分（余り）を届けた人にも称号が出る（①の板が数えるので）。

今の記録で判定できるもの：①の目標 `crossing-storehouse-v1`（倉）には B の目標が対応しない（B の共同目標は砦）。対応を決めるのはルールの判断なので、`GOAL_MAP` は空（持ち主の判断待ち）。このため本番で今出る称号は、S1 の隊商の記録だけで判定できる個人目標 P-raider（他国の隊商を襲った）が中心。共同・材料・発起人・利用の称号は、対応と「どの記録で計画が完成したか」の結び付けが決まってから出る。試験（`test/live.test.mjs`）は、評価器の境界の場面（`boundary-crossing`）で共同・個人の称号が出ることも確かめる。

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
| `src/` | 評価器：`contract`（入力）・`ledger`（記録の検査と正準の並び）・`world`（荷・隊商・計画・建物）・`goals`（共同・国・個人）・`evaluate`（判定結果・賞金・選択肢）・`rulesets`（A/B/C）・`live`（本番の接続：案 B だけ、称号と年代記） |
| `src/adapters/` | `s1-chain`（S1 の記録）、`ws01`（①の依頼の板）、`ws04`（④の Run Receipt）、`ws14`（⑭の塔、任意） |
| `scenarios/` | 固定入力 16 件、`fixtures/` に①・④・⑭の出力（作り方と出どころの commit つき）。（`build.mjs` で生成、試験で一致を確認）。`long.mjs` は長期の世界を固定の種で作る |
| `test/` | `node --test` の 165 件（2026-11-22：「依頼に応えた」の `request-title`（12 件）を追加。2026-11-18：本番の接続の `live`（10 件）・`live-board`（4 件、①の板の `/coop/outcomes` と画面の読み手）を追加。同日、Node 20 で④の u64 を読む `parse-exact` の 5 件を追加。CI の `coop15` が Node 20 と 22 で実行。①の fold() と ws01-board v1・④の runexec と chain flow・⑭の tower-facts と centre-facts に対する契約試験を含む）。もとの 70 件（境界・再開の確認、見直しで見つけた不具合の再現を含む）、画面の確認 `play.browser.mjs`・`live.browser.mjs`（ゲームの画面の称号の札。ヘラルドと Playwright が要る）、長期の確認 `long-run.mjs` |
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
