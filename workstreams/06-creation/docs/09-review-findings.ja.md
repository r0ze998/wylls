# 9. 独立レビューの11件：欠陥・修正・テスト・確かめ方

**経緯：** 最初の版（commit `4f3a6921`）を、別のエージェントにコードだけを渡して読ませ、再現つきで11件の欠陥の報告を受けた（2026-10-29）。修正は commit `c9160f32`。その後の設計変更（commit `953a3040` 以降：採用・実行の依頼・束）で、いくつかのテストは新しい形に書き換えた。

**確かめ方の記号：**
- **T**：`c9160f32` の `test/review.test.mjs` を、修正前の `4f3a6921` の木に入れて実行し、失敗することを確認した（9件のテストすべてが失敗、`c9160f32` では9件すべて通過）。
- **S**：レビュー担当の再現スクリプト（`p.mjs`・`r.mjs`。repo には入れていない）を、修正前と修正後の木に向けて実行し、結果が変わることを確認した。テストが同じテストの前の段で先に失敗するため、そのテスト単独では修正前の失敗を示せない項目に使った。

| # | 欠陥（修正前の振る舞い） | 修正した場所 | 対応するテスト（今） | 修正前の失敗の確かめ方 |
|---|---|---|---|---|
| 1 | 接続先（B）が世界にない場所でも、何かの束 id を書けば実行前の確認を通り、模擬実行が例外になった | `src/plan.mjs` preflight の接続の検査（`DEPENDENCY_UNAVAILABLE`）。実行時は `src/execute.mjs` の工房の手順でも検査 | `review`「a connect target that is not in the world…」 | T（`ready` が true になった） |
| 2 | 同じ使用権の束を二つの接続に名指しすると、回数を二重に使えた | `src/plan.mjs`（束ごと・工房ごとに合計して比較）。実行時は `src/execute.mjs` の手順ごとの原子的な検査と加算 | `review`「one lot bound to two connect dependencies…」、`resources`「one lot, one stock, one balance shared by concurrent plans…」 | T（`GRANT_INSUFFICIENT` が出なかった） |
| 3 | 同じ完了記録を二つの依存に使えた。模擬実行も使用済みの印の失敗を無視していた | 記録（証明）と束（消費する権利）を分けた：`src/ledger.mjs`（記録は消費されない）、`src/execute.mjs`（束を一度だけ消費）、`src/plan.mjs`（`BATCH_INVALID duplicate-in-plan`） | `review`「one batch bound to two consume dependencies…」（束の形に書き換え）、`resources`「one batch, two adopted plans, run concurrently…」 | T（`duplicate-in-plan` が出なかった。当時のテストは記録の形） |
| 4 | 作者の古い状態変更の署名を出し直すと、後の停止を取り消せた | `src/registry.mjs`（署名に状態の履歴の番号 `seq` を含め、`setStatus` で一致を要求） | `required`「4 削除・停止された依存先」の後半（出し直しの拒否） | S（修正前：出し直しが通り、状態が `listed` に戻った。修正後：拒否）。今のテストは新しい API（`seq`）を使うので、修正前の木では動かない |
| 5 | `constructor`・`toString` などの名前が、効果・出力・合図として読めて例外・素通りになった | `src/canonical.mjs`（`plain`・`own`）、`src/catalog.mjs`・`src/types.mjs`（プロトタイプのない表） | `review`「inherited names are not effects, outputs, triggers or versions」（前半） | T（TypeError） |
| 6 | 深い入れ子（2万段）で検証器がスタック溢れ | `src/canonical.mjs`（深さ32で `CanonicalError` → `SHAPE`） | `review`「deep nesting and non-integers are findings, not crashes」（前半） | T（RangeError） |
| 7 | 計画の版名が `constructor` などのとき、実行前の確認が例外 | `src/registry.mjs` `getVersion`（自分の欄だけ読む）、`src/plan.mjs`（`env?.manifest`） | `review`「inherited names…」（後半） | S（修正前：TypeError。修正後：findings を返す）。テストは #5 の段で先に失敗するため |
| 8 | 計画の束縛に小数があると、実行前の確認が例外 | `src/plan.mjs` `verifyPlanSignature`（正規化できなければ署名不一致として扱う） | `review`「deep nesting and non-integers…」（後半） | S（修正前：CanonicalError を投げた。修正後：`PLAN_SIGNATURE_INVALID`）。テストは #6 の段で先に失敗するため |
| 9 | 記録の出力名が、作り手が公開した出力名でなく手順の出口の名前だった（正しい記録を拒否し、別の手順の記録を受け入れうる） | `src/execute.mjs`（記録に公開した出力名 `outputs` を入れる）、`src/ledger.mjs`（`outputs` で照合） | `review`「a receipt answers to the producer's published output name」 | T |
| 10 | 量に上限のない入力が荷の量なら通った／工房の回数を手順ごとにしか数えていなかった／宣言だけの上限があった | `src/validate.mjs` `checkLimits`、`src/catalog.mjs`（使われない上限を削除） | `review`「load caps: unbounded cargo, and workshop runs summed over steps」 | T |
| 11 | 待つ手順のない C の依存が、場所の確認なしに使われた | `src/validate.mjs`（どこかの手順の `after` に挙げることを必須に：`REF_UNKNOWN`） | `review`「a consume dependency must be waited on by a step」 | T |
| （外） | 既定値が null の入力の追加が minor 扱いだった（レビュー報告の「小さなすき間」。11件には数えていない） | `src/upgrade.mjs` | `review`「a new input with a null default is a major change」 | T |

**まとめ：** `review.test.mjs` の9件のテストは、#1・#2・#3・#5（と#7）・#6（と#8）・#9・#10・#11 と（外）を含む。修正前の失敗はこの9件で確認した（T）。#4・#7・#8 は再現スクリプトで修正前後の違いを確認した（S）。

## 再現の手順

```sh
# 修正前の木を取り出し、修正直後のテストを入れて走らせる（9件すべて失敗する）
git archive 4f3a6921 workstreams/06-creation | tar -x -C /tmp/old
git show c9160f32:workstreams/06-creation/test/review.test.mjs > /tmp/old/workstreams/06-creation/test/review.test.mjs
(cd /tmp/old/workstreams/06-creation && node --test test/review.test.mjs)
```

#4 の確認に使った出し直しの手順（修正前の API：`setStatus(ref, status, day, signature)`）：

```js
const relist = await signStatus(ref, "listed", 4, A);                          // 作者が以前に出した署名
await reg.setStatus(ref, "suspended", 10, await signStatus(ref, "suspended", 10, A)); // 作者が後で停止
const r = await reg.setStatus(ref, "listed", 4, relist);                       // 誰かが古い署名を出し直す
// 4f3a6921: { replayAccepted: true, statusAfter: "listed" }
```

## この後の設計変更で見つけて直したもの（レビュー外）

| 欠陥 | 修正 | テスト |
|---|---|---|
| 同じ計画を同じ日に二回動かすと、記録の内容が同じになり id が衝突した | 記録に実行番号を入れた（`src/execute.mjs`） | `resources`「each run writes its own evidence…」 |
| C を使う計画が特定の束を計画に固定していたため、1回しか動かず、次の回は新しい採用（公開停止中は不可）が要った。決定2（固定版の継続）と両立しない | 束を計画から外し、実行の依頼ごとに名指しする形にした | `policy`「a new definition cannot newly adopt a suspended producer; an adopted consumer keeps going」 |
| 署名つきの計画を持っている人なら誰でも実行を起こせた（利用者の物と残高を、利用者の選ばない時に使わせられる） | 利用者が署名した実行の依頼（使い捨て番号つき）を必須にした | `runtime`「only the plan's user can make it run, once per request」 |
| 画面が、作者の既定の届け先（作者の倉）を利用者の入力に黙って入れていた | 他人の場所の既定は入れず、確認で `PARAM_DEFAULT_FOREIGN` を見せる | `proto/e2e.mjs`「left at the author's default, the receiver (A's fort) is flagged」 |

## 二回目の独立レビュー（commit `308087dc`、採用・実行・束）

採用・実行の依頼・束を足した版を、別のエージェントにコードだけを渡して読ませ、6件の欠陥の報告を受けた（2026-10-30）。すべて直し、`test/review2.test.mjs` に再現を残した。**6件のテストは、修正前の `308087dc` の木ではすべて失敗し、修正後はすべて通る**（15回続けて実行して揺れがないことも確認）。

| # | 欠陥（修正前の振る舞い） | 修正した場所 | 対応するテスト |
|---|---|---|---|
| R2-1 | 一つの実行の依頼で同じ束を二つの依存に名指しすると、束の物を二重に数え、倉の在庫が負になった（物が無から出た）。確認は重複を見ていたが、採用は束なしで確認するため素通りした | `src/execute.mjs`（同じ手順・同じ実行の中の束の重複を `BATCH_INVALID duplicate-in-plan`） | `review2`「one batch named twice in one run is refused…」 |
| R2-2 | 実行の途中で利用者が計画を止めても・置き換えても、残りの手順が動いた。定義の利用期限も最初にしか見ていなかった | `src/execute.mjs`（手順ごとに採用の状態と利用期限を検査し直す） | `review2`「ending or superseding a plan stops a run already under way…」 |
| R2-3 | 採用の検査と書き込みの間に確認の `await` があり、同じ古い計画を二つの更新が同時に置き換えられた。同じ計画を同時に二度採用すると、記録が上書きされ、回数と使い捨て番号が消えた | `src/adoption.mjs`（確認の後に検査をやり直し、書き込みまで `await` を挟まない） | `review2`「adoption re-checks after its preflight…」 |
| R2-4 | 同じ定義の計画を二つ採用すれば、1日の回数の上限を超えて動かせた | `src/adoption.mjs`（回数を「利用者×定義」で数える） | `review2`「runs per day hold per user and definition…」 |
| R2-5 | C の依存を荷車の手順に待たせると、束も記録もなしに動いた | `src/validate.mjs`（C の依存は物を使う手順（工房）にだけ待たせられる）、`src/execute.mjs`（荷車の手順が束を消費しようとしたら止める） | `review2`「a consumed result must feed a step that uses goods…」 |
| R2-6 | 止めた・置き換えた計画をもう一度採用すると「採用済み」と返った（動かないのに） | `src/adoption.mjs`（その理由を返す） | `review2`「re-adopting an ended or superseded plan is not reported as adopted」 |

あわせて、実行前の確認が「1回の回数 × 1日の回数」を要求していたのを、次の1回に要る回数に直した（1日の回数は上限であって、毎回それだけ動く約束ではないため）。
