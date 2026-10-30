# 引き渡し整理（④ 0.2、統合判断待ち）

- 対象 commit：基準 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46` → `4066a1b6fdbbef59b0e154045d303d2a7e9239dd` → `bd415e7430dafe7284f7bbf7bbce1f78940b2ec6` → この文書整理の commit（保存パッケージの `MANIFEST` に完全な SHA を記録する）。
- 状態：**新機能の追加を止め、統合判断を待つ。** 検証は実際の SQLite と模擬正本（MOCK）に対するものだけで、実チェーンでの安全性は確認していない。

## 0. 他担当の資料の取得状況

2026-10-30 に、この作業環境から次を探した。どれも取得できなかった。

| 担当 | 報告された版 | 探した場所 | 結果 |
|---|---|---|---|
| ② | `dc3bd3d` | ローカルの全 ref。origin の全ブランチ（render-farm を除く 24 本）と PR head 22 本を取得して確認。GitHub API（`r0ze998/wylls` の commit 検索） | **見つからない** |
| ③ | `47b05ac6` | 同上 | **見つからない** |
| ⑤ | `ba3c180b` | 同上 | **見つからない** |
| ⑥ | `517796dc` と Git 外の `ADDENDUM-20261030.ja.md` | 同上。ADDENDUM はファイルシステム全体を名前で検索 | **見つからない** |

そのため、以下の②③⑤⑥に関する記述は**報告の文面に基づく未検証の整理**であり、どれも「接続済み」ではない。④の adapter（`src/ports.rs`）と共通コアは、今回変更していない。

## 1. ②の StockSwap と、④の模擬「施設使用」の違い

報告によれば、②の StockSwap は**既存在庫の交換**であり、**加工能力の貸出ではない**。④の模擬の「施設使用」（`Request::UseFacility`、`src/sim.rs`）は、利用権の単位を消費して、施設で材料を産出物に変える操作である。両者を同じ契約として扱わない。

| 観点 | ④の模擬「施設使用」（MOCK、④の提案 P3） | ②の StockSwap（報告のみ、未検証） |
|---|---|---|
| 何をするか | 施設の加工能力を、利用権の下で一回使う。`inputs` を消費し、`outputs` を新しく生む | 既にある在庫どうしを交換する。新しい資源は生まない（報告による） |
| 資源の総量 | 変わる（材料が減り、産出物が増える） | 交換の当事者の間で移るだけ、と推定される。**未確認** |
| 必要な入力 | `key`（`fac:<run_id>`）、`holder`、`facility`（Place と recipe）、`stock`、`inputs`、`outputs`、`rights_units` | **未確認**。交換の相手、双方の在庫の場所と量、価格や比率、合意の形式などが想定されるが、資料が無い |
| 原子的な検査 | 一つの処理の中で：施設が生きていて世代が一致、利用権が有効で残量 ≥ `rights_units`、`stock` が holder のもので材料が足りる。そのうえで消費、産出、利用権の減算 | **未確認**。少なくとも「双方の在庫が交換の時点で足りること」と「双方の権限」の原子的な検査が必要と考えられる |
| 重複の拒否 | 要求キー `fac:<run_id>` の二度目を `AlreadyDone` で拒否。キーで正本の記録を引ける（模擬だけの機能） | **未確認**。交換の識別子や連番があるかどうかが分からない |
| 記録 | `FacilityUsed{key, sig, slot, consumed, produced, rights_units}` | **未確認** |
| 利用権 | 単位を消費する（②-R2：施設使用と同じ原子処理の中で） | 交換に利用権が関わるかどうかは**未確認** |
| ④の run での位置 | 「許可された施設を使う」段階 | **④の run の段階には当てはまらない**。在庫の交換を run に組み込むなら、別の段階として契約を作る必要がある（今回は作らない） |

結論：④の `UseFacility` の提案（CONTRACTS ②-R1〜R4、③-R1、patches P3）を、StockSwap の契約として読み替えない。StockSwap を④の run から使う必要があるかどうかは、②の資料を受け取った後に判断する。

## 2. 「到着量未検証」は「到着量 0」でも「全損」でもない

| 区別 | 実際の到着量 | 記録（`outcome`） | ①⑥の進捗への算入量 | 表示 |
|---|---|---|---|---|
| `DeliveredUnverified`（到着量未検証） | **分からない**（0 以上、`cargo_logged` 以下） | `delivered: None`、`verification: Unverifiable` | **0**（検証できた量が 0 だから。実際の量を 0 と断定するのではない） | 「到着したが、入った量を確認できない（最大 n 個）」。「0 個」「全損」「失敗」とは表示しない |
| 0 と分かっている（take、burn、宛先の世代変更、容量に全く入らなかった `credited` 0） | 0 と分かっている | `delivered: Some(0)`、`verification: KnownZero`（または Recorded で 0） | 0 | 「届かなかった（理由）」 |
| `Partial`／`Fulfilled` | 検証した量（RuleDerived は整数の下限：資源ごとに 1 未満多く入っていうる） | `delivered: Some(n)`、Recorded か RuleDerived | n | 「届いた n 個」（RuleDerived は「n 個以上」） |

- ①と⑥は、算入量（検証済みの量）と、実際の到着量の状態（分からない／0 と分かる／n と分かる）を**別の欄として**扱う。算入量が 0 だからといって、実際の到着量を 0 として記録したり表示したりしない。
- 後から検証できた場合（P1 の記録が使えるようになった、など）は、算入量を増やしうる。その更新の扱い（再計上の可否）は①⑥の判断とする。
- 実装との対応：`delivered: Option<Res>` の `None` が「分からない」、`Some(ZERO)` が「0 と分かる」（`src/model.rs` の `Outcome`、`Verification`）。テストは `vault_record_without_credit_is_unverified_even_if_balance_matches`（None）と `known_zero_outcomes`（Some(0)）。

## 3. 「全履歴で不在」と言える条件

attempt を `Absent`（＝着地していないし、これからも着地しない）と判断してよいのは、次の**すべて**を満たす場合に限る。

1. **対象期間**：その署名が着地しうる全区間、つまり署名に使った blockhash の slot から `valid_until`（blockhash の有効期間の最後の slot）までを照会したこと。直近の status cache だけの照会は、この区間を覆わない。
2. **完全性**：照会した履歴に、その区間の欠落が無いと保証できること（台帳の欠けや刈り込みが無い、または欠けが無いことを履歴の提供者が保証している）。
3. **確定性**：その区間が確定していること（`finalized` の slot が `valid_until` を超えている）。分岐でまだ入りうる区間について、不在とは言わない。

一つでも保証できない場合、adapter は `Unavailable` を返す（③-R4 の訂正）。

### 引き渡しで守ること

履歴の欠落、照会の失敗、照会できない（`Unavailable`）状態を、次のどれとしても扱わない。

| 扱ってはいけないこと | ④の実装での扱い |
|---|---|
| **失敗の確定** | run は送信中の状態に留まる。決められた回数だけ見直した後は `Indeterminate` で保留にする（`indeterminate_is_held_then_resumed`） |
| **未課金** | 手数料は `reserved` または `unconfirmed` のまま。`released` にしない（`Store::fees`） |
| **再署名してよい** | 新しい attempt に署名しない。新しい署名は、前の attempt がすべて `Absent`（上の条件）か着地で決着した後だけ（`Undecided::Indeterminate` は新しい署名に進まない） |
| **取消の完了** | 取消は `AwaitingSigned` のまま。完了と表示しない |

注意：模擬正本（`src/sim.rs`）は、`valid_until` を過ぎた不明な署名を `Absent` と答える。これは「全履歴があり、確定している」世界を模したものであり、実チェーンの RPC がこの条件を満たすことの証明ではない。欠落は `faults.status_unavailable` で別に試している。

## 4. ③⑤⑥との未確認事項

③ `47b05ac6`、⑤ `ba3c180b`、⑥ `517796dc` と ADDENDUM は取得できなかった（§0）。そのため、次の項目は**どの担当が持つかを含めて未確認**である。④の側の現状と、④が必要とすることだけを示す。

| 項目 | ④の現状（所在） | ④が必要とすること | 想定される相手（未確認） |
|---|---|---|---|
| 取消の段階（停止、署名済みの確認待ち、完了、手遅れ） | `CancelPhase`（`src/model.rs`）、[STATE-MACHINE](STATE-MACHINE.ja.md)「取消の三段階と限界」、CONTRACTS §8.2 | 表示の担当と、手動／自動の切替（署名済み要求は止まらない）との対応 | ⑤（切替）、⑦（表示） |
| 費用の 4 区分（予約、確定、未確定、解放） | `FeeBook`（`src/store.rs`）、CONTRACTS §6.2、RUNBOOK §5 | 予算と staking の会計で同じ区分を使うか。lamports から何に換算するか | ⑤ |
| 署名済み要求（store では止められない） | STATE-MACHINE「署名済みの要求」、INVARIANTS E3 | ワイヤのバイト列の保存と同じバイト列の再送（③-R3）。§3 の不在の条件（③-R4） | ③ |
| 到着量未検証 | §2、CONTRACTS §7・§9 | 算入量と実際の到着量の状態を分けて扱うこと。P1 の記録の要否 | ①、⑥、③（P1） |
| 回数・費用の上限（`max_attempts`、`max_fee`、`max_port_errors`、期限） | `Budget`（`src/model.rs`）、RUNBOOK §7 | 上限を誰が決めるか（依頼者、AI の予算、運営）。⑤の予算との関係 | ⑤ |

これらは、資料を受け取るまで「接続済み」として扱わない。

## 5. 既存資料の所在（今回は内容を変えていないもの）

| 内容 | 所在 |
|---|---|
| 状態遷移、所有表、到着量の判定、模擬正本の fencing の監査 | [STATE-MACHINE](STATE-MACHINE.ja.md) |
| 不変条件と依存先（DB／模擬／実チェーン） | [INVARIANTS](INVARIANTS.ja.md) |
| 署名の要件 | [SIGNATURES](SIGNATURES.ja.md) |
| 契約の提案 | [CONTRACTS](CONTRACTS.ja.md) |
| 監視、復旧、SQLite の設定と保存順 | [RUNBOOK](RUNBOOK.ja.md) |
| テスト結果と変異テスト | [TEST-REPORT](TEST-REPORT.ja.md) |
| 共通コアへの変更案（未適用） | [patches](../patches/README.ja.md) |
| 元の checkout の状態 | [README](../README.ja.md)「作業環境について」 |
