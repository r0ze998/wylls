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
| `fees` | `unconfirmed` が減らない | status の全履歴が読めていない。③-R4 を確認する（RPC の履歴、`searchTransactionHistory`） |
| `cancelsPending` | 取消を要求したが、まだ完了していない run の数 | 送信済みの要求の有効期間が過ぎれば完了する。長く残るなら §3.3 |
| `oldestOpenAgeSlots` | 輸送時間 + 襲撃の窓（`RAID_DECIDE_BELLS`）+ 余裕を超える | `runexec show` で状態を見る |
| `alerts` | 増えている | `alerts` テーブル：`history_gap`（feed の欠落）、`held` |
| `eventCursor` | 進まない | feed の読み取りが失敗している（tick は継続し、canonical な読み取りで進む） |

警告の種類：
- `history_gap`：feed が cursor より後を保持していない。実行者は開いている run を全部見直す。entity 履歴も無ければ `Indeterminate` で保留になる。
- `held`：run が保留になった。理由は `held_reason`。

## 2. 一つの run を調べる

`runexec show --db <path> --run <id>` は、状態、`detail`、所有表の行、遷移（実行者と理由つき）、attempt（要求キー、署名、有効期間、状態）、Receipt（出典つき）を表示する。

attempt の状態：
- `intent`：記録済み。送信したかどうかは不明。
- `sent`：送信し、受け付けられた。
- `unknown`：送信したが、応答が無い。
- `rejected`：事前検査で拒否された。**有効期間の終わりまでは着地しうる**（同じバイト列の別のコピー）。
- `landed`：着地して効いた。
- `failed`：着地して失敗した（手数料あり）。
- `superseded`：もう効かない（要求キーを別の attempt や別の送信者が使った）が、失敗として着地しうる。手数料は未確定。
- `expired`：有効期間を過ぎ、全履歴にも無い。手数料は無い。

`show` は取消の段階（`cancel`）と費用（`fees`：reserved / charged / unconfirmed / released）も表示する。

## 3. 復旧

### 3.1 実行者の停止・クラッシュ

- **何もしなくてよい**。同じ store で実行者を起動し直す（同じ id なら lease を続けて使い、別の id なら lease が切れた後に引き継ぐ）。記録済みの attempt は、署名の状態で照合する。有効期間内なら同じバイト列を再送し、期限を過ぎて不在なら、新しい確認からやり直す（テスト `stop_and_restart_at_every_point`、`restart_after_validity_ran_out`、`zombie_executor_is_fenced`）。
- **してはいけないこと**：attempt の行を消す、状態を手で書き換える。どちらも正本との照合の手がかりを失わせ、二重の効果につながる。

### 3.2 保留の解除

| `held_reason` | 意味 | 手順 |
|---|---|---|
| `WalletRequired` | 他人の場所への送付で、**送信者本人の** wallet の署名が必要（受取人の署名ではない。[SIGNATURES](SIGNATURES.ja.md)）。拒否された署名済みのバイト列の有効期間が過ぎた後、run は `FacilityConfirmed` に戻る。産出物は在庫の場所にある | (a) 依頼者が自分で SendCaravan に署名する。その後 `cancel` で run を閉じる（産出物はもう送られている）。または (b) `cancel` だけする |
| `Indeterminate` | 要求が効いたかどうかを判断できない（署名の状態の履歴、entity 履歴、feed がすべて無い） | 情報源（RPC の履歴、findex）を回復させてから `resume`。回復できない場合は、chain explorer などで要求キーまたは seq を人が確認し、結果を記録してから `cancel` または `resume`。**推測で再送しない** |
| `PortUnavailable` | run の読み取りが `max_port_errors` 回続けて失敗した | RPC を回復させてから `resume` |
| `Inconsistent(…)` | 自分の署名の記録が spec と食い違う、または要求キーを自分以外の署名が使った | adapter、索引、program の不具合を調べる。**成功として扱わず、再送もしない**。原因が分かるまで run は保留のままにする |

`resume` は保留と誤りの回数を消し、version を進める。古い snapshot を持つ実行者の書き込みは無効になる。

### 3.3 取消

`runexec cancel --db <path> --run <id>`。段階は `show` の `cancel` で確認する。

| 段階 | 意味 | 運用者がすること |
|---|---|---|
| `StoppingNew` | 新しい要求は出さない。実行者がまだ見ていない | 待つ |
| `AwaitingSigned{until}` | 署名済みの要求が slot `until` まで着地しうる | 待つ。**「取り消した」と告げない** |
| `Completed{effects}` | 完了。`effects` が空でなければ、取消の前に成立した変化がある | 依頼者に effects をそのまま伝える |
| `Ineffective{at}` | 輸送中のため取り消せない | 依頼者に伝える。run は道の結果に従う |

**署名済みのバイト列は、DB の操作では止められない。** 停止していた実行者のプロセスが復帰して送信すれば、有効期間内なら着地する。取消を急ぐために attempt の行を消したり、状態を書き換えたりしない。記録が消えると、着地した変化を照合できなくなる。

### 3.4 feed の欠落

警告 `history_gap` が出たら、findex の entity 索引が使えるか確認する。使えれば、実行者は自動で照合する（`history_gap_is_reconciled_from_entity_history`）。使えなければ §3.2 の `Indeterminate` の手順に従う。

## 4. 照合（検証者向け）

1. `transitions` は、run ごとに version 1..n が欠けずに一件ずつある（UNIQUE 制約）。
2. 着地した attempt（`landed`）は、要求キーごとに一つ以下。施設の着地は正本の `facility_use(key).sig` と、発送の着地は `CaravanSent.sig` と一致する。
3. 終端の run は `reservations` を持たない。
4. `Fulfilled`／`Partial` の run には `caravan_settled` の Receipt がある。`outcome.verification` が `Recorded` なら `credited` が、`RuleDerived` なら holding 宛ての cargo が `outcome.delivered` と一致する。`DeliveredUnverified` は `delivered` を持たない。
5. `fees` の reserved + charged + unconfirmed ≤ `budget.max_fee`。
6. `caravan_sent` の Receipt の署名は、その run の attempt の一つであり、正本の `CaravanSent` の中身（送り元、宛先、資源、量）が spec と一致する。

## 5. 費用

| 区分 | 意味 |
|---|---|
| `reserved` | まだ着地しうる attempt の手数料（予算の予約） |
| `charged` | chain が報告した、着地した attempt の手数料（成功・失敗とも） |
| `unconfirmed` | 着地した、または失敗として着地しうるが、手数料が報告されていない |
| `released` | 有効期間を過ぎ、全履歴にも無いと確認された attempt。**予約を解放しただけで、返金ではない** |

期限だけで「課金されていない」と判断しない。各 tick で、有効期間を過ぎた `superseded` と、手数料が未報告の `landed`／`failed` を status で照合する（`reconcile_fees`）。

## 6. 永続化（SQLite）

| 項目 | 設定 |
|---|---|
| journal モード | `PRAGMA journal_mode=WAL` |
| 同期 | `PRAGMA synchronous=FULL`（WAL での commit ごとに fsync） |
| ロック待ち | `busy_timeout` 10 秒。複数のプロセスや接続が一つのファイルを共有する。**WAL は同じホストの共有メモリを使うので、ネットワーク上のファイルシステムには置かない** |

transaction の境界：

| 操作 | 境界 |
|---|---|
| 状態の遷移（`Store::transition`） | `BEGIN IMMEDIATE` の一つの transaction で、runs の CAS 更新、transitions の追加、ops（予約、attempt の記録と状態、Receipt）を書き、commit する。CAS が失敗すれば何も書かない |
| lease の取得（`claim`）、取消（`request_cancel`）、再開（`resume`） | 条件付きの UPDATE 一文（自動 commit） |
| event の記録（`record_event`）と cursor（`set_cursor`） | event ごとに一文、その後に cursor。間で止まれば読み直し、id で重複を除く |
| 費用の照合（`settle_attempt`） | 一文 |

署名済みの要求を保存する順序：

1. 署名する（`Chain::prepare`。メモリの中だけ。送信はしない）。
2. 一つの transaction で、状態を `*Requested` にし、attempt（`intent`、ワイヤのバイト列、署名、有効期間、手数料）を書いて commit する。
3. 送信する。
4. 応答を、別の transaction で記録する（`sent`／`unknown`／`rejected`）。

1 と 2 の間で止まった場合、署名は記録されず、送信もされていない。2 と 3 の間で止まった場合、再起動した実行者は記録から同じバイト列を再送するか、有効期間の終わりを待つ。3 と 4 の間で止まった場合、status と正本で照合する。

**検証の範囲**：停止は、プロセスの中の名前付きの停止点で再現した（`CRASH_POINTS`）。**OS の停止、電源断、fsync の失敗に対する耐性は検証していない**。これは `synchronous=FULL` の SQLite の性質に依存しており、別の検証範囲として残す。

## 7. 停止条件（無限の再試行や支出を防ぐもの）

| 条件 | 既定値 | 到達したとき |
|---|---|---|
| 各段階の attempt 数 | 3 | `Failed(AttemptsExhausted)` |
| 手数料（予約 + 確定 + 未確定 + 次の attempt） | 200,000 lamports | `Failed(BudgetExhausted)` |
| 読み取りの誤りが続く回数 | 5 | 保留 `PortUnavailable` |
| 判断できない状態が続く回数 | 5 | 保留 `Indeterminate` |
| 期限 | run ごと | `Expired`（送信中の要求の決着を待ってから） |
| 同じ署名の再送 | 有効期間内で、見るたびに 1 回 | 有効期間を過ぎれば止まる |
