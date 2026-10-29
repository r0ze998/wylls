# 3. 検証器：何を、いつ、どう確かめるか

**正本：** `src/codes.mjs`（コードと既定の重さ）、`src/validate.mjs`（定義）、`src/registry.mjs`（公開と依存）、`src/plan.mjs`（実行前の確認）、`src/ledger.mjs`（完了記録、④の代わりの模擬）。

検証器は純粋な関数で、同じ入力からは同じ結果を返します。定義の検証と実行前の確認は、壊れた入力にも例外を投げず、所見（finding）の配列を返します（`test/core.test.mjs` の総当たりで確認：定義の102か所をそれぞれ13通りに壊した 1,326 通り、計画の束縛を壊した 78 通り）。計画の準備（`preparePlan`）だけは、正規化できない値（小数）を受け取ると署名の前に `CanonicalError` で止まります。

## 1. 四つの段階

| 段階 | 誰が・いつ | 入力 | 主なコード |
|---|---|---|---|
| **定義** | 作る人が書くたび（画面は入力ごと）／公開時 | 定義だけ＋効果の表＋世界の規則の水準 | `SHAPE` `NUMBER_NOT_INTEGER` `TYPE_*` `REF_UNKNOWN` `EFFECT_*` `STEP_CYCLE` `GRANT_KIND_MISMATCH` `LIMIT_EXCEEDED` `FLOW_*` `CLAIM_*` `NOTE_PROMISE` `MANIFEST_EXPIRED` `TRIGGER_UNAVAILABLE` |
| **公開（一覧）** | 公開時。依存は利用者の確認でも再び見る | 署名つき封筒＋一覧 | `HASH_MISMATCH` `SIGNATURE_*` `VERSION_*` `NOT_AUTHOR` `DEPENDENCY_UNKNOWN/WITHDRAWN/SUSPENDED/VERSION/CYCLE` `DERIVED_FROM_UNKNOWN` |
| **実行前の確認** | 利用者が計画を準備したあと、実行の直前 | 利用者の署名つき計画＋一覧＋世界のスナップショット＋台帳 | `PLAN_SIGNATURE_INVALID` `ENTRY_NOT_LISTED` `ACTOR_UNKNOWN` `PARAM_*` `PLACE_*` `NOT_OWNER` `MISSING_GRANT` `GRANT_*` `DEPENDENCY_UNAVAILABLE` `CAPACITY` `STOCK_SHORT` `WALLET_REQUIRED` |
| **完了記録** | C の成果を使う計画の確認時 | 記録の id、または誰かが差し出した記録の本文 | `RECEIPT_INVALID`（理由：`unbound` `unknown` `tampered` `not-in-ledger` `not-final` `failed-run` `wrong-producer` `wrong-version` `wrong-output` `not-beneficiary` `already-consumed` `place-mismatch`） |

重さ：`error` は止める。`warning` は止めないが画面に出す（在庫は実行までに変わりうる、など）。`info` は知らせるだけ（ウォレットの署名が要る、など）。

## 2. 課題の「機械的に検査できる形」との対応

| 課題の項目 | 定義の欄 | 検査 |
|---|---|---|
| 入力・出力 | `params`・`outputs`・手順の引数 | 型（部分型あり）、参照の存在、出力の型と C の宣言の一致 |
| 場所 | 引数の `own`・`sameProvinceAs`・`unshared`、入力の `own` | 実行前：持ち主、工房と同じ州、共有でない倉（S2 L4） |
| 必要な権利 | `uses.*.grant`（B）・`uses.*.manifest`（C） | 定義：札の種類と接続先の型。実行前：利用者の束の持ち手・種類・発行元・世代・期限・残り回数、工房全体の残り回数。記録の確定・作った定義・受け取り手・未使用 |
| 費用 | 効果の表の `tx`・`cu`・`feeLamports`、物の出入り | 紙に出す。1日の取引数と CU の上限。実行前：在庫（警告） |
| 容量 | 倉の `cap`（資源ごと 5000） | 実行前の空実行：届いた荷・作った兵器が容量を超えれば `CAPACITY` |
| 期限 | `validUntilDay`、束の `untilDay` | `MANIFEST_EXPIRED`・`GRANT_EXPIRED` |
| 依存先 | `uses` | 一覧にあるか・停止/取り下げ・版・循環。接続先の施設が生きているか・工房が残っているか |
| 版 | `version`・`range`・`hash` | 書き換え禁止、前より新しいこと、変更の大きさに見合う上げ方（[05](05-update-policy.ja.md)） |
| 失敗条件 | 効果の表の `failures` | 紙に「止まって記録に残る」として列挙。模擬実行は失敗した手順で止まり、失敗の記録を残す |

## 3. 必須テストとの対応

すべて `node --test workstreams/06-creation/test/*.test.mjs` で動く。定義だけで決まるものは `fixtures/`（成功4件・失敗23件）にもある。

| 必須テスト | テスト | fixture |
|---|---|---|
| 型の不一致 | `required` 1 | `ng/type-*.json` `ng/number-not-integer.json` `ng/flow-place-mismatch.json` |
| 必要権利なし | `required` 2（なし・他人の束・別の工房の束・回数不足） | `ng/grant-kind-mismatch.json` |
| 利用期限切れ | `required` 3（束の期限・定義の期限） | `ng/manifest-expired.json` |
| 削除・停止された依存先 | `required` 4 ×2（施設が閉じた・奪われた・工房がなくなった・定義の停止・C の依存先の停止と取り下げ・作者以外の状態変更） | |
| 版の不一致 | `required` 5（範囲・ハッシュ固定・同じ版の再公開・上げ方不足・別の版の記録・計画の固定ハッシュ） | |
| 循環する依存 | `required` 6（手順・定義どうし・自分自身） | `ng/step-cycle.json` |
| 過大な処理量 | `required` 7（1日の工房回数・上限なし・工房全体の残り・容量） | `ng/limit-*.json` |
| 偽の完了結果 | `required` 8（12の理由のうち9つ＋使用済み） | |
| 公開者の説明と機械条件の不一致 | `required` 9（量・署名・合図の主張、保証の言葉、紙と説明の分離） | `ng/claim-*.json` `ng/note-promise.json` |
| コピー後の権限未設定 | `required` 10（写らないもの・署名なしの公開・入力と札が未設定・Aの束は使えない・自分の束で通る） | |

ほかに：作者と利用者の分離（`roles`）、A/B/C/D の区別（`abcd`）、版と既存利用者（`upgrade`）、SHA-256 と正規化・総当たり・CLI デモ（`core`）、fixture の再生成の一致（`fixtures`）。

## 4. 検証器が確かめないこと（限界）

- **履行。** 荷車が襲われない、工房の持ち主が工房を壊さない、といったことは保証しない。検査は「今のスナップショットで、規則上、始められるか」まで。
- **作者の自由文。** `note` の内容は照合しない（保証の言葉に警告を出すだけ）。
- **経路。** 荷車の経路（州の枠・8ターンの制限・襲撃の危険）は、S1 の経路計算を呼んでいないので検査しない。失敗の仕方として紙に出すだけ。本番では SDK の経路計算（`caravan.rs` の `walk`）を呼ぶ形にする。
- **価格と公正さ。** 札の値段、引き換えの条件の良し悪しは扱わない。
- **本当の記録。** 完了記録は模擬の台帳。本番では④の Receipt（チェーンの記録を検証器が判定したもの）を引く。
