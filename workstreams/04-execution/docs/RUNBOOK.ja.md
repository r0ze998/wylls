# 監視と復旧の手順

対象は run store（SQLite ファイル）と、それを使う実行者のプロセスである。**現時点で実行者は模擬世界（MOCK）にしか接続できない**。実チェーン用の adapter はまだ無い。手順は store の操作として書いたので、adapter ができても変わらない。

コマンドは `workstreams/04-execution` で `cargo run --release --bin runexec -- <cmd> --db <path> ...` として実行する（以下では `runexec` と略す）。

## 1. 監視

`runexec status --db <path> --slot <現在の slot>` の出力：

| 欄 | 見ること | 対応 |
|---|---|---|
| `byState` | `FacilityRequested`、`FacilitySubmitted`、`ShipRequested`、`ShipSubmitted` が長く減らない | §3.1 |
| `held` | 0 件でない | §3.2 |
| `attemptsUndecided` | 有効期間（151 slot）を大きく超えて残る | 実行者が止まっていないか確認する（lease が切れれば別の実行者が引き継ぐ） |
| `oldestOpenAgeSlots` | 輸送時間 + 襲撃の窓（`RAID_DECIDE_BELLS`）+ 余裕を超える | `runexec show` で状態を見る |
| `alerts` | 増えている | `alerts` テーブル：`history_gap`（feed の欠落）、`held` |
| `eventCursor` | 進まない | feed の読み取りが失敗している（tick は継続し、canonical な読み取りで進む） |

警告の種類：
- `history_gap`：feed が cursor より後を保持していない。実行者は開いている run を全部見直す。entity 履歴も無ければ `Indeterminate` で保留になる。
- `held`：run が保留になった。理由は `held_reason`。

## 2. 一つの run を調べる

`runexec show --db <path> --run <id>` は、状態、`detail`、所有表の行、遷移（実行者と理由つき）、attempt（要求キー、署名、有効期間、状態）、Receipt（出典つき）を表示する。

attempt の状態：`intent`（記録済み、送信は不明）、`sent`、`unknown`（応答なし）、`rejected`（事前検査で拒否。着地しない）、`landed`、`failed`（着地して失敗。手数料あり）、`expired`（有効期間を過ぎて不在）、`superseded`（seq を他人が使った）。

## 3. 復旧

### 3.1 実行者の停止・クラッシュ

- **何もしなくてよい**。同じ store で実行者を起動し直す（同じ id なら lease を続けて使い、別の id なら lease が切れた後に引き継ぐ）。記録済みの attempt は、署名の状態で照合する。有効期間内なら同じバイト列を再送し、期限を過ぎて不在なら、新しい確認からやり直す（テスト `stop_and_restart_at_every_point`、`restart_after_validity_ran_out`、`zombie_executor_is_fenced`）。
- **してはいけないこと**：attempt の行を消す、状態を手で書き換える。どちらも正本との照合の手がかりを失わせ、二重の効果につながる。

### 3.2 保留の解除

| `held_reason` | 意味 | 手順 |
|---|---|---|
| `WalletRequired` | 他人の場所への送付で、wallet の署名が必要。run は `FacilityConfirmed` に戻り、産出物は在庫の場所にある | (a) 依頼者が自分で SendCaravan に署名する。その後 `cancel` で run を閉じる（産出物はもう送られている）。または (b) `cancel` だけする |
| `Indeterminate` | 要求が効いたかどうかを判断できない（署名の状態の履歴、entity 履歴、feed がすべて無い） | 情報源（RPC の履歴、findex）を回復させてから `resume`。回復できない場合は、chain explorer などで要求キーまたは seq を人が確認し、結果を記録してから `cancel` または `resume`。**推測で再送しない** |
| `PortUnavailable` | run の読み取りが `max_port_errors` 回続けて失敗した | RPC を回復させてから `resume` |

`resume` は保留と誤りの回数を消し、version を進める。古い snapshot を持つ実行者の書き込みは無効になる。

### 3.3 取消

`runexec cancel --db <path> --run <id>`。送信中の要求があれば、その決着を待ってから止まる。`InTransit` 以降には効かない（呼び戻しの命令がない）。取消の後に資源がどこにあるかは、所有表と `detail.outcome.note` で確認する。

### 3.4 feed の欠落

警告 `history_gap` が出たら、findex の entity 索引が使えるか確認する。使えれば、実行者は自動で照合する（`history_gap_is_reconciled_from_entity_history`）。使えなければ §3.2 の `Indeterminate` の手順に従う。

## 4. 照合（検証者向け）

1. `transitions` は、run ごとに version 1..n が欠けずに一件ずつある（UNIQUE 制約）。
2. 着地した attempt（`landed`）は、要求キーごとに一つ以下。施設の着地は正本の `facility_use(key).sig` と、発送の着地は `CaravanSent.sig` と一致する。
3. 終端の run は `reservations` を持たない。
4. `Fulfilled` の run には `caravan_settled` の Receipt があり、`credited`（または未確認の印）が `outcome.delivered` と一致する。
5. `fee_committed` ≤ `budget.max_fee`。

## 5. 停止条件（無限の再試行や支出を防ぐもの）

| 条件 | 既定値 | 到達したとき |
|---|---|---|
| 各段階の attempt 数 | 3 | `Failed(AttemptsExhausted)` |
| 手数料（署名の時点で数え、着地しないと決まれば戻す） | 200,000 lamports | `Failed(BudgetExhausted)` |
| 読み取りの誤りが続く回数 | 5 | 保留 `PortUnavailable` |
| 判断できない状態が続く回数 | 5 | 保留 `Indeterminate` |
| 期限 | run ごと | `Expired`（送信中の要求の決着を待ってから） |
| 同じ署名の再送 | 有効期間内で、見るたびに 1 回 | 有効期間を過ぎれば止まる |
