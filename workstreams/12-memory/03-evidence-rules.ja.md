# ⑫ 事実認定の規則（fold v2）

二度目のレビュー（2026-10-30）で指摘された「誤った評価で関係を壊す」経路を塞ぐための規則。実装は `src/fold.mjs`、テストは `test/evidence.test.mjs`。重みはすべて仮設定（`WEIGHTS.provisional: true`、`CAUTION.provisional: true`）で、調整していない。

## 1. 記録がないことは、不履行や嘘の証拠にしない

- 期限＋猶予（6 bell）を過ぎても判断材料が揃わない約束は **`unconfirmed`**（未確認）。理由を必ず付ける：`no_record_found`（記録が見つからない）、`lookup_failed`（④が照会できなかった）、`in_transit`（輸送中）、`settle_unobserved`（到着予定を過ぎても精算記録がない）、`caravan_unknown`（割当てた隊商の発送記録がない）、`recipient_unverified` / `recipient_conflict`、`qty_unverified`、`qty_split_ambiguous`、`record_conflict`、`unassigned_caravan`、`coverage_caravan_unresolved`。
- **不足（`partial` / `not_delivered`）が確定するのは、④の `coverage`（その送り主の、約束から期限＋猶予までの全発送が漏れなく揃っている、という索引の証明）があるときだけ。** 区間が途切れていれば確定しない（区間は連続する場合だけ結合する）。
- `unconfirmed` は信頼度 E を動かさない。取引判断で慎重になる場合は、別の **caution 項**（自分への約束のうち期限を過ぎて未確認のものの数×仮の係数）を使う。これは誠実さの評価ではないと入力に明記し、証拠が届けばどちらの結果でも消える。
- 襲撃（`raided`）・目的地消失（`lost`）・精算時の所有者違い（`recipient_changed`）・期限前の取り下げ（`withdrawn`）は**中立**。

## 2. 約束と配送を推測で結び付けない

- 結び付けは、当事者（債務者または債権者）の **`allocate` 発言**だけ：`{ref: 約束 id, caravan: {sender, seq}, qty}`。これは発言（said）で、事実と照合して初めて効く。
- 照合：隊商の送り主＝債務者、発送記録の目的地（**種類・座標・site/tile・世代**）＝約束の場所、資源を積んでいること、**隊商の容量を宣言順に全約束で消費**（超えた割当は `over_allocated` で無効。同じ数量を二度使わない）。
- 第三者の割当は無効（`not_a_party`）。当事者の間で数量が食い違えば小さいほうを採り、`disputed` を付ける。
- 誰も割当てていない隊商は **`unassigned`**。目的地が約束の場所と一致していても自動では結び付けない。期限後にそのような隊商があれば、約束は `unconfirmed`（`unassigned_caravan`）のまま。

## 3. DELIVERED だけで数量や受取人を確定しない

| ④からの事実 | 意味 | ないとき |
|---|---|---|
| `caravan_settled` DELIVERED | 精算が起きた（記録上の積荷 `cargo_recorded` 付き） | 輸送中または `settle_unobserved` |
| `caravan_credited`（`basis: account_diff`） | 目的地の在庫が実際に増えた量 | **`qty_unverified`**（記録上の積荷は量として使わない） |
| `place_owner`（区間 `[from_bell, to_bell]`） | **精算時点**の所有者 | **`recipient_unverified`** |

- 1 隊商を複数の約束に割当てていて実加算が合計に足りないとき、内訳は推測しない。各約束に **下限・上限**（`delivered_min..delivered_max`）を持たせ、差があれば `qty_split_ambiguous` で未確認にする。
- 受取人は「今の所有者」ではなく、精算 bell を含む区間の所有者で判断する。精算時に別人が持っていれば `recipient_changed`（中立）。証明が食い違えば `recipient_conflict`。
- 世代の違う場所は別の場所（`misdirected`）。誤配送であって嘘ではない。

## 4. 発生時刻と観測時刻を分ける

- すべての記録に `bell`（発生）と `created_bell`（観測＝記憶に入った時。`created_bell < bell` は拒否）。既存エピソードの `bell` / `created_bell`（AC2-NOTES 規則 2）と同じ分け方。
- 期限内かどうかは**精算の発生 bell**で判断する。後から届いた記録でも、期限内に精算していれば `fulfilled`。
- `knowledge(viewer, clock, {observedBy})`：`clock` で状態を判断し、`observedBy` までに観測された記録だけを使う。
- **再評価** `m.reassess(decisionId, observedBy)`：判断時点の bell で、後から観測された記録も含めて判断し直す。約束状態の変化・候補ごとの費用項の変化・参照ルールなら選択が変わったかを返す。元の判断記録は書き換えない。判断後になされた発言（例：判断後に初めてなされた割当）は判断時点の事実には含めない。
- rollback された事実は除外され、そこから導かれた判定（例：偽申告の認定）も、その根拠とともに取り消される。

## 5. 評判と観測の不足を分ける

`reliability[相手]` の出力：

- `E, r, s`：**確認済みの根拠だけ**の Beta 推定。`fulfilled` r+1、`late` r+0.5・s+0.5、`partial` r+f・s+(1−f)、`not_delivered` s+1、偽の申告 s+0.5（仮）。各項目に経過の重み（半減期 432 bell）と、観察しただけの約束なら 0.5 倍。
- `verified`：確認済みの件数。`claims`：申告の内訳（consistent / contradicted / mismatch / unverified）。
- `unresolved`：未確認・進行中の約束と理由。`neutral`：中立の結末。`mismatches`：食い違いはあるが嘘とは判定しないもの。
- `evidence[]`：信頼度に入った各項目と、その出典 id・判定規則。

### 偽の申告（`contradicted`、信頼度に入る）の判定基準

| 基準 | 内容 |
|---|---|
| `caravan_absent_in_complete_index` | 申告が名指しした隊商が、約束から申告までを覆う完全な索引に存在しない |
| `no_caravan_to_place_in_complete_index` | 隊商を名指ししない申告で、完全な索引に、約束から申告までの送り主から約束の場所への発送が一つもない |

### 食い違い（`mismatch`、表示するが信頼度に入れない）

`caravan_of_another`（他人の隊商を名指し）、`caravan_to_other_place`（別の場所・世代への隊商）、`premature`（発送・精算が申告より後。猶予 2 bell）、`not_delivered_by_record`（名指しした隊商が襲撃・消失）。

「送った」（`claim_sent`）と「届いた」（`claim_delivered`）は別の申告として判定する。索引がなければ、どちらも `unverified` のまま。

## テストとの対応（`test/evidence.test.mjs`）

| 指摘 | テスト名（抜粋） |
|---|---|
| 記録遅延 | `time: an on-time delivery observed late is on time…`、`time: a decision taken before evidence arrived can be reassessed…` |
| 複数の同時配送 | `allocation: parallel promises…`、`allocation: one caravan split over two promises…`、`allocation: a short credit shared…` |
| 部分履行 | `quantity: a partial delivery before the index is complete…`、`quantity: DELIVERED without a measured credit…` |
| 未検証量 | `quantity: DELIVERED without a measured credit is unverified…` |
| 受取人の変更 | `recipient: the owner AT THE SETTLE BELL decides…`、`recipient: a place of another generation…` |
| 観測欠落 | `absence: no record at all…`、`absence: a failed lookup and a gap in the index…`、`absence: in transit…` |
| 訂正後の判断の回復 | `time: a wrong index attestation rolled back…`、core の `a rollback retracts a fact…` |
| 偽の判定基準 | `a claim is false only by a stated criterion…`、`absence: "sent" and "delivered"…` |

主要な防御 25 個を一つずつ壊すと、どれも少なくとも 1 件のテストが失敗することを確認した（判定の根拠を無視、観測時刻を無視、容量、settle を加算量とみなす、内訳の推測、所有者、現在の所有者、受取人の仮定、第三者割当、世代、食い違いを嘘扱い、偽申告の重み、未割当の推測結合、索引の穴、caution、未確認を E に入れる、可視性、rollback、collision、余分な field など）。
