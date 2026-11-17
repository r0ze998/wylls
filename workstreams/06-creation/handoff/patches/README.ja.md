# ⑥から他の担当への提案パッチ（未適用）

どれも⑥の外のコードへの**提案**です。⑥はどの担当のブランチにも適用・push していません。採否と、どう直すかは各担当が決めます。

| ID | 宛先 | 基点 | ファイル | 状態 |
|---|---|---|---|---|
| P06-4a | ④ 実行 | `d0e96d53` | （削除） | **取り下げ（2026-11-06）。** ④が `30a3fd2e` で荷車だけの Run を実装し、受付・照会の CLI も④で作成中。⑥は重ねない |
| P06-3a | ③ 外部接続 | ③の最新 `7923f900`（GitHub に無く未受領） | なし（契約だけ。下） | 依存待ち |

## P06-4a：④の荷車だけの Run と、Run の受け渡し口（取り下げ。以下は記録）

**中身**
- `RunSpec.facility` を `Option<FacilityRef>` にする。保存済みの spec（施設あり）は `Some` として読める。
- 施設のない Run は、`Accepted` で荷が `stock` にそろうのを待つ。そろったら `FacilityConfirmed` に進み、そこからは既存の発送・到着・量の判定をそのまま通る。
  - 前の荷車（`inbound`）が失われたという証拠があれば `InputLost` で止まる。
  - 権利の予約はしない。
- `validate_spec`：施設のない Run が `inputs`・`outputs`・`rights_units` を持つことは拒否する。
- `runexec run accept --db <db> --spec <file>`：⑥の RunSpec の JSON を受け付ける。冪等で、同じ id に別の spec を渡すと `Conflict`（終了コード 4）。
- `runexec run view --db <db> --run <id>`：Run を JSON で返す（`p04-run/0.1`：状態・保留・取消・detail（`outcome`・`ship_seq`）・spec・receipts）。無い id は `NoRecord`（終了コード 3）。
- 試験 `tests/ship_only.rs`（4件）。⑥が書いた `tests/fixtures/ws06-runspecs.json` を読み、次を確かめる。
  - 2段の荷車が「送る → 待つ → 到着と量の判定 → 次を送る」まで進む。
  - 前の荷車が焼かれたら、次の Run は `InputLost` で止まる。
  - 施設ありの Run は変わらない。
- **④の判断が要る点：** `faults.rs` の不変条件「FacilityConfirmed に入るのは施設の要求からだけ」に、`Accepted`（施設のない Run だけ）を足した。代わりに新しい状態（例：`ShipReady`）を足す案もある。状態の数（15）と名前は他の担当も読むので、④が選ぶこと。

**確かめたこと（2026-11-06、⑥の scratch の checkout、鍵なし）**
- `git apply --check` が `d0e96d53` に通る。
- ④の試験：lib・bins・`act_cli`・`acts`・`arrival`・`concurrency`・`continuity`・`faults`・`gateway_facts`・`routes`・`ship_only`・`signed` で、96件通過・0件失敗。
  - `tests/gateway.rs` は鍵を使うので、実行していない。コンパイルが通るよう `Some(...)` だけ直した。
- ⑥の `test/connect-live.test.mjs` が、パッチを当てた `runexec` で `run accept|view` を確かめた。

## P06-3a：③ `send_caravan` で⑥の実行 id を④に渡す（契約の案、コードなし）

③の最新（`7923f900`、共有パッチ 0008）は GitHub に無く、受け取れていない。古い `acdcd0bf` にコードを書いても③の最新とずれるので、契約だけを置く。

- `send_caravan` の入力に、省略できる `runId` を足す。
  - 形式：`ws06:<計画のハッシュ 64桁>:<依頼の番号>:<手順>`。⑥の `toMcpCaravans` が出す値。
  - 同じ `requestId` で別の `runId` が来たら、`IdempotencyConflict` にする。
- ③は送る前に、④の `runexec act register --source mcp --key ws03:<linkId>:<requestId> --run <runId>` を呼ぶ（④ EXECUTION-CONTRACT §7.3 の③の使い方）。
- `get_operation_status` と `list_operations` の結果に `runId` を含める。
- ⑥は④の `act list --run <runId>` で、③を通らずに状態を読める。
- 代案：④が `act status` を `requestId` で引けるようにする。この場合、③の変更は「④に登録すること」だけになる。
