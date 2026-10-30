# 06 採用前に決めること

この試作は**本番に任意コード実行を開く決定ではない**。**案 B、Burn、運営の停止権限はいずれも採用していない**（2026-10-30 のオーナーの指示）。⑩との接続は、⑩の実物を照合してから行う。採用するなら、次をこの順に決める必要がある（決定ログ `docs/design/redesign/99-decisions.ja.md` への記録はオーナーの判断）。

## 1. 方針の判断（オーナー）

| # | 問い | 選択肢 | ⑪の推奨と理由 |
|---|---|---|---|
| D1 | 「新しい世界効果はコア側が追加する」を続けるか | (a) 続ける（拡張は A の合成だけ） (b) B を加える (c) C まで開く | **(b)**。新しい状態遷移を足せて、作者のコードを実行せず、検証の約束を保てる（[02](02-comparison.ja.md) §3）。(c) はコア資源に効く段階で B の語彙が要るので、先に B を決めるのが順 |
| D2 | v1 で消費（Burn）を許すか | 許す／禁じる／運営の受け皿へ送る | 試作は許している。資源の総量の設計（[25](../../docs/design/redesign/25-money-structure.ja.md)）と照合してから。禁じるなら op を外すだけ |
| D3 | 拡張の呼出しを「所有者の行動」として扱うか（休眠の時計） | 扱う／扱わない | 試作は扱わない（`touch_owner` しない）。扱うと拡張で休眠を避けられる |
| D4 | 誰が公開できるか | 誰でも／許可制／運営だけ | 最初は**許可制**（運営が登録前に Active にする）。登録は誰でも、Active は運営の承認、という 2 段が⑥の採用の流れと合うかを⑥に確認 |
| D5 | 緊急停止の権限者 | 運営鍵／国の投票／なし | 試作は運営鍵（`operator`）で実装したが、**決定ではない**。⑥の権限表でも「提案・未決定」。権限者・閾値・範囲を決める。システムの安全停止（コアの停止）は別の判断 |

## 2. 技術の確認（承認があれば⑪が続ける）

| # | 内容 | 必要な承認・資源 |
|---|---|---|
| T1 | 解釈器を Frontier プログラムに組み込み、SBF でビルドして CU を測る | Agave 3.1.9 の導入（CI と同じ `release.anza.xyz`）の承認 |
| T2 | LiteSVM で `f01` と拒否の試験をチェーン上で再現 | 同上 |
| T3 | 再生検証器 V7 に拡張の Holding 書込の判定を足す | 共有コアの変更（integrator） |
| T4 | 検証器の未知タグと CPI（[patches/0001](patches/0001-verify-unknown-instruction-is-unverifiable.patch)）、Holding の post-state の欠落（[0003](patches/0003-verify-v7-missing-holding-state-is-unverifiable.patch)） | 同上。B を採らなくても入れてよい修正 |
| T5 | instance を閉じる命令と `max_instances` の数え方 | 設計 |
| T6 | 利用者をまたぐ op（相手の Grant を同じ取引で確かめる）を effect_set 2 として設計するか | D1 の後 |

## 3. 他担当との照合（未完）

| 相手 | 照合すること | 状態 |
|---|---|---|
| ② | Grant の欄（per_call・budget・回数・期限）と②の Grant の対応 | ②の HANDOFF を未読（コンテナ外） |
| ④ | Receipt を Run の結果に入れる。`SeqMismatch`＋`last_receipt` 一致＝完了済み | 契約を送付、返信待ち |
| ⑥ | 登録簿の最小欄、停止権限、利用者に見せる説明（`describe`） | **回答あり**（[01](01-contract.ja.md) §7-1）。公開状態と実行状態は別系列、識別子は別の型、上限の表示には強制する場所を添える。運営の緊急停止は⑥でも未決定 |
| ⑨⑩ | escrow を保管の契約で表せるか | 未連絡。⑩との接続は実物を照合してから（指示） |

## 4. 採らない場合に残るもの

- [patches/0001](patches/0001-verify-unknown-instruction-is-unverifiable.patch)（未知タグと CPI を UNVERIFIABLE に）と [0003](patches/0003-verify-v7-missing-holding-state-is-unverifiable.patch)（Holding の post-state の欠落を UNVERIFIABLE に）は、拡張の採否と無関係に既存の検証器の穴を塞ぐ。
- [01 契約](01-contract.ja.md) の Receipt・版固定・三値の検証は、案 A（③の CPI）にもそのまま当てはまる（courier の receipt を鎖にする等）。
