# 19. ④の到着量の契約との照合（受領版 2e536b6b）

**状態（2026-10-30）：** ブランチ `ws/01-coop-s1`。④の受領版を実物で照合し、①の到着量の言葉と意味を④に合わせた。**本物のチェーンでは未検証**（Agave 3.1.9 は未承認。17章 17-4b）。

## 19-1. 受領したもの（④の進行中の HEAD とは区別する）

| 項目 | 値 | 確かめたこと |
|---|---|---|
| ファイル | `wylls-ws04-handoff-20261030.tar.gz`（326,426 B） | 別の空のフォルダに展開。絶対パス・`..` を含む項目はない |
| SHA256 | `dc5a8007db7d0602911582f608472ee11bb9ecd687b1378dab7ec6831e7ed04d` | 受け取ったファイルの値と一致 |
| 中の SHA256SUMS | 19 ファイル OK | `wylls-ws04-full.bundle` は一覧にあるが、このアーカイブには入っていない（MANIFEST の「別の添付」）。照合には増分の bundle を使った |
| 復元 | 増分の bundle（前提 `4cd901de`、①の clone から取得）を別の一時リポジトリへ。`ws04/handoff` = `2e536b6b119d8eaa4e9f4d795e856b696249a664`、`ws04/v0.2` = `bd415e7430dafe7284f7bbf7bbce1f78940b2ec6`、`ws04/v0.1` = `4066a1b6fdbbef59b0e154045d303d2a7e9239dd`、tree `0a02f9e07fc7b2e3f2ea7d6ae0c5386c5da41e7a`（MANIFEST と一致） | パッチ 3 本を `4cd901de` に当てた tree も同じ。増分の bundle には `ws04/base` の参照はない（前提として名指しされるだけ。MANIFEST の表とは違うが、中身の不一致ではない） |
| ④のテスト | 実行していない（④の `cargo test` は①の作業の外。④の記録 `restored-clone-tests.txt` は 62 件通過） | — |

## 19-2. 到着量の照合

④の文書：CONTRACTS §1・§2・§3・§9、STATE-MACHINE「到着量の判定」、HANDOFF §2、PATCH-PROPOSALS P1。

| 点 | ④（2e536b6b） | ①（3f3c847 の時点） | ①（今回） |
|---|---|---|---|
| 村あて DELIVERED、credited なし | `delivered = cargo`、`verification: RuleDerived`（`Accrual::add` は上限なし） | 「記録の積荷を下限として」と①独自の言い方 | **④に合わせた**：`delivered = cargo`（整数単位）、`RuleDerived`。根拠を加算処理と対応づけた（下） |
| 倉あて DELIVERED、credited なし | `delivered: None`、`Unverifiable`、`cargo_logged` は上限 | 数えない（量 null） | `delivered: null`、`Unverifiable`、`cargoLogged` を上限として別に示す |
| LOST・襲撃の奪取と焼却 | `delivered: Some(0)`、`KnownZero` | 量 null（「分からない」と区別していなかった） | **`delivered` は0、`KnownZero`**。「分からない」（null）と分けた |
| 進捗への算入 | Recorded か RuleDerived の delivered だけ。cargo_logged を足さない | 同じ方針 | `counted`（数えた量）を、到着の事実（`delivered`・`verification`）とは別の欄にした。数えない理由も別の欄 |
| 記録の credited（P1） | 未適用の提案。実装済みとは扱わない | なし | 同じ。①は `Recorded` を作らない（P1 が入ったら読む） |
| 自分の送信の確認 | `(owner, seq)` が同じだけでは自分の送信とみなさない。自分の署名の着地か、自分の署名を名指す `CaravanSent` | 隊商の口座の持ち主・行き先・荷で確かめた | **自分の取引の署名で確かめる**（`chain.mjs` `sendOutcome`）。番号の競合・結果不明もこれで分ける |
| 宛先の世代 | 世代は識別子の一部。世代が変われば LOST・KnownZero | 依頼の届け先に世代を含めた | 同じ。加えて「到着時の受取人」を世代で決める（19-3） |
| 残高の差 | 使わない（並行する入出庫で分からない） | 使わない | 使わない（送る前の不足の見込みだけ在庫を読む。判定には使わない） |
| 占領の決着待ち | `CapturePending` で待ち、InTransit のまま | 確定の記録がなければ輸送中 | 同じ（テストあり） |

**村あての RuleDerived の根拠（実際の加算処理との対応）：**

1. `permutation-frontier/src/proc/caravan.rs` `settle_caravan`：宛先が生きていて（`pl.kind == dplace.kind && pl.gen == dplace.gen`）holding なら、cargo の各資源について `h.credit(now.ts, Resource::ALL[r], *c)`（`c > 0` だけ、ミリ単位）。
2. `permutation-rules/src/frontier/holding.rs:774-783` `Holding::credit`：`self.settle(now)` の後に `self.stores[r].add(now, amount)`。
3. `holding.rs:296-300` `Accrual::add`：`self.value = self.value.saturating_add(amount.max(0))`。上限で切らない（コメント「may exceed the cap」）。
4. 記録：`caravan.rs:402-409` `cargo_log` はミリ単位の cargo を 1000 で割って切り捨てた整数。

→ 加えられたミリ単位の量は、記録の値 ×1000 以上、(値＋1)×1000 未満。整数単位では、記録の値が入荷量（切り捨て）。④の「cargo を入荷量とする」と同じ数になる。④の文書は単位（ミリ・整数）を書いていないので、**整数単位で切り捨てた量**であることを④に確かめてほしい（19-5）。

倉あて：`settle_caravan` の vault 分岐は `to = have.saturating_add(*c).min(cap.max(have))` で切り捨て、記録は元の cargo。④の文書の行番号（`caravan.rs:1005`・`:1037`）は、基準 `4cd901de` で一致する（vault の書き込みが 1005〜1006 行、記録の `cargo_log(&cargo)` が 1037 行）。

## 19-3. 到着時の受取人と、今の持ち主

| 確かめたこと（基準 `4cd901de` のコード） | 根拠 |
|---|---|
| Holding の `OWNER_CITIZEN` を書くのは、占領（`conquest.rs:1295`、`:1425`）と入植（`citizen.rs:1468`）だけ | `grep` で全件 |
| 占領は世代を1つ進める：`SettleCapture` は `hgen + 1 == mgen` を求め（`conquest.rs:1322`）、`GEN = mgen` を同時に書く（`:1292`、`:1426`） | 同上 |
| 入植は `gen = old_gen + 1`（`citizen.rs:1814`）を同時に書く（`:1465`） | 同上 |
| 確定は宛先の世代が同じときだけ届く（違えば LOST） | `caravan.rs` `settle_caravan` の `live` |

→ 同じ世代の間、村の持ち主は変わらない。だから、今の口座の世代が到着の記録の世代と同じなら、今の持ち主が到着時の受取人。世代が違えば（到着の後の占領・再入植）、到着時の受取人は今の口座からは確定できない → **未検証として数えない**（推測しない）。今の持ち主は別の欄に示す（`goal.mjs` `recipientOf`）。

テスト：発送の後・到着の前の占領（LOST・KnownZero）、到着の後の占領（受取人は未検証・数えない・今の持ち主は c）、同じ世代のまま持ち主だけ違う口座（規則にない状態：依頼した人ではないので数えない）、占領の決着待ち（輸送中のまま）。

## 19-4. ①の記録と④の記録の、まだ合っていない点

| # | 点 | ①の扱い |
|---|---|---|
| D1 | ④の `CaravanSettled` の event は `slot`・`credited/lost`（P1）を持つ。①の提案パッチ 0002（ヘラルドの `ended`）は `slot`・取引の署名を持たない（ヘラルドの fold には bell・署名が渡らない） | ①は量をヘラルドの `ended` から数えない（チェーンの取引の記録だけ）。0002 は表示用。④の findex の event を使えるなら、①はそちらに合わせる |
| D2 | 単位 | **解決**：④のコード（`src/model.rs`：`pub type Res = [u64; RESOURCES]`「Whole units per resource (the PS2 logs' unit for cargo)」、`executor.rs:1432-1437` で RuleDerived の delivered は記録の cargo）も整数単位。①と④は同じ数（契約テスト「村あて」「単位」） |
| D3 | ④の状態名（Fulfilled・Partial・DeliveredUnverified など、15 の状態）は④の実行器の状態。①は依頼の板で、到着ごとに `state`（moving・delivered・lost・misdelivered・raided-*・unknown）と `verification` を持つ | 対応表：delivered＋RuleDerived ≒ Fulfilled/Partial、delivered＋Unverifiable ≒ DeliveredUnverified、lost・raided-*・misdelivered ≒ Failed（KnownZero） |
| D4 | ④は「依頼量以上なら Fulfilled、少なければ Partial」。①は依頼の量で到着を切らず、共同の目的の判定は資源ごとの合計 | 依頼ごとの充足の表示は①では作らない（今回は増やさない） |
| D5 | MANIFEST・SHA256SUMS が完全な bundle を載せるが、このアーカイブにない | 照合には影響しない（増分の bundle とパッチで同じ tree） |
| D6 | ①の 18章の「村あては下限」という書き方 | 今回④の言葉（RuleDerived）に直した。量は同じ |

## 19-4b. 契約テスト（`test/coop.contract04.test.mjs`、7件）

最小の実データ：`test/fixtures/ws04-outcomes-2e536b6b.json`。④の受領版のコードの `Outcome` を、この作業の一時的な写しで `serde_json` で書き出したもの（RuleDerived・Unverifiable・KnownZero・Recorded・NotShipped の5つ）。④の tree は変えていない（書き出しに使った一時的なテストは消した）。①の側の変換は `coop/ws04.mjs`。

| テスト | 確かめる不一致・一致 |
|---|---|
| 形 | ④の JSON を①が読める。`Unverifiable` なのに delivered がある・`KnownZero` なのに 0 でない・整数でない・知らない verification は断る |
| 村あて | ①がチェーンの CARAVAN_SETTLED から作る到着を④の形にすると、④の RuleDerived の Outcome と同じ（D2） |
| 倉あて | ①も④も delivered は null・Unverifiable |
| LOST | ①も④も delivered は 0・KnownZero（null とは別） |
| Recorded・NotShipped | ①は Recorded を作らない（P1 未適用）が、④から届けば数える。NotShipped は数えない |
| 単位 | 記録はミリ単位を1件ずつ切り捨てた整数。3件（100.6・100.6・100.999 単位）は、切り捨ててから足すと 300、足してから切り捨てると 302。差は最大 k−1。①も④も記録の整数を足す（ミリ単位は記録にないので、足してから切り捨てた値は作れない）。共同の目的の表示に `underBy`（数えた件数）を出す |
| 状態 | ①の到着の状態と④の終わりの状態の対応（D3）。Fulfilled と Partial は①では分けない（D4） |

## 19-5. ④に確かめてほしいこと

1. （解決：④のコードで整数単位と確認）④の文書にも「整数単位・1件ずつ切り捨て」を書くか。複数の到着の合計の精度（最大 k 未満）を④の進捗の表示でも示すか。
2. 依頼に対する「自分の送信」の確認で、①の板が使う「結び付けの署名をした人＝隊商の鍵（OWNER_TAG）の持ち主、かつ今の OWNER_CITIZEN」で足りるか（④は実行器の署名の着地で確かめる。①の板は送った人の署名付きの結び付けの記録で確かめる）。
3. findex の `CaravanSettled` の event（slot・署名つき）を①が読めるか。読めるなら、①の提案パッチ 0002 は要らなくなる。
