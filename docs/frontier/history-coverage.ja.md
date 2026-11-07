# 履歴の取得範囲（coverage）と検証器の history：読み手との約束

⑲、2026-11-06。herald の `/h/status` の `ingest.coverage` と、検証器の `report.json` の `history` を読む側（⑫ の記憶、⑬ の住民など）が、意味を取り違えないための取り決めです。

## 1. 用語の意味

### coverage の `state`（findex `RpcPoll::coverage`）

| state | 意味 | 意味しないこと |
|---|---|---|
| `not_fetched` | 何も取得していない | 空の履歴。「何も起きなかった」 |
| `gap` | 欠落を検出したか、アーカイブの末尾が分からない。取込みは止まっている | — |
| `unverifiable` | 取得した範囲の一部が照合されていない。理由は `unverifiable[]` に入っている | 欠落があるという断定（照合できていないだけ） |
| `cross_checked` | 起点に届き、すべての取得分が照合先のノードと一致した | **完全であることの証明でも、確定（finalized）の証明でもない** |

- `range`：取得した slot の範囲です。範囲の外に記録が無いことは、その外で何も起きなかった証拠になりません。
- `heldBack`：一覧には出たが、まだ取得していない署名の数です。0 でなければ、取得はまだ終わっていません。
- `limit`：RPC からの応答では示せないことを説明する文言です。どの状態でも付きます。

### 検証器の `history`（`report.json`）

| basis | 出どころ | verdict への影響 | `complete` |
|---|---|---|---|
| `as_given` | `history` 欄の無いフィクスチャ（記録済みの試験入力） | 変えない | `null`（完全だとは主張しない） |
| `ledger_feed` | ローカルノード自身の台帳の feed（そのままか、アーカイブ経由） | 変えない | `null` |
| `unproven` | 公開 RPC。coverage がどの状態でも該当し、`cross_checked` も含む。出どころの分からないアーカイブも含む | **PASS にはならない**（所見 `HistoryUnproven`）。FAIL になるのは、取得済みの取引の中だけで決まる FAIL（⑪ の一覧：V0（`Undecodable` を除く）、V27、⑳ の V9 の住民の参加）があるときだけ。それ以外は UNVERIFIABLE。すべての FAIL の所見は一覧に残るが、一覧外のものは欠落した範囲が原因の可能性がある（件数は `selfContainedFails`／`otherFails`） | `false` |

`complete` が `true` になることはありません。

## 2. 読み手がしてはいけないこと

1. `cross_checked` を「全部そろった」「確定した」と言い換えること。
2. `range` の外、`not_fetched`、`gap` を「その間は何も起きなかった」と記憶すること。
3. 所見 `HistoryUnproven` があるときに、一覧外の FAIL の所見（`otherFails` に数えられるもの）を不正の確定として扱うこと。
4. 履歴をフィクスチャに保存し直して `as_given` に変えること。`Input::to_json` は `history` を保持し、`from_json` は `"fixture"` と記録された値を `unproven` として読みます。

## 3. 住民の記憶（⑫・⑬）での推奨

- 出来事の記憶には、根拠として `basis` と `state` を一緒に持たせてください。`unproven` の範囲から得た出来事は「観測された」とは言えても、「それで全部だった」とは言えません。
- 「何かが無かった」という記憶（不在の記憶）は、`ledger_feed` の範囲でしか作らないでください。

## 4. 実装の場所

- findex：`frontier-node/crates/findex/src/ingest.rs`（`RpcPoll::coverage`、`coverage_from_cursor`、`COVERAGE_LIMIT`）
- 検証器：`frontier-node/crates/verify/src/history.rs`、`input.rs`（`fetch_txs` と `read_archive` が `History` を返す）
- herald：`/h/status` の `ingest.coverage`

## 5. 未決定（④・⑪）

- 欠落があっても成り立つ FAIL の一覧：⑪ の分（V0、V27、⑳ の V9 の住民の参加）は反映済みです。V1、V5、V7 などの残りは ④ の判断です（`history::self_contained`）。
- ローカルの feed から作ったアーカイブが古い控えだった場合、history では検出できません（最終状態の K4 照合でだけ分かります）。
- 本番の起点の署名と、照合先のノードの選び方。

## 6. 統合時の入力保全（2026-11-07）

19 r2 を正本とし、独立の HistoryEvidence 実装は重ねません。そちらの厳密な入力扱いから、次の境界を取り込みました。

- `feed_after` は符号なし整数で、実際に記録を持つアーカイブの場合だけローカル feed の根拠にします。null、文字列、負数、小数は根拠にしません。
- 空のアーカイブ、空のローカル feed の読み取りは「何も起きなかった」の証拠にしません。
- `ledger_feed` と RPC coverage が混じった保存入力は unproven にします。
- レポートに scope を追加しました。fixture と local feed の verdict は dataset_only です。RPC 等は observed_transactions であり、完全性も確定性も主張しません。
- 19 r2 の FAIL の扱いは維持します。V0 の Undecodable は履歴不足時の確定 FAIL に数えません。V0H の所見を追加するだけでは、履歴不足から生じた FAIL が最終判定に残るためです。

残る限界：自己申告の source は暗号学的な来歴証明ではありません。履歴の削除・偽装を可能にする編集権限を持つ相手に対する認証は別です。local feed の古いバックアップ検出、観測範囲と取引の一対一照合、V28 の共有履歴はこの変更では実装していません。

## 7. ローカルノードの台帳とアーカイブ（2026-11-07）

### アーカイブを台帳の記録（`ledger_feed`）として扱う条件

ローカルノードの記録を保存したアーカイブ（プログラムごとに 1 本）は、`findex::ledger` の検査で問題が無いときだけ `ledger_feed` として扱います。条件は次の 3 つです。

- 記録の起点が台帳の先頭（0）である。
- 台帳の識別子（`runId`）が記録されている。
- すべての取引に、元の台帳番号（`feed_seq`）が残っている。

### ノードを指定した場合（`--archive DIR --rpc URL`）

`input::confirm_archive` で、アーカイブとノードの台帳の今の状態を照合します。

| 照合すること | 合わないときに考えられること |
|---|---|
| `runId` が同じ | ノードの台帳が作り直された |
| 台帳のサイズ（`ledgerBytes`）が、保存したときより小さくない | 台帳が巻き戻った |
| 台帳の取引数が、アーカイブの最後の台帳番号以上ある | 台帳が巻き戻った |
| アーカイブの最後の取引が、同じ台帳番号・同じ署名のまま台帳にある | 同じ `runId` のまま巻き戻った |

- 照合がすべて合えば、出どころは `ledger <runId>` になり、ノードから直接読んだ場合と同じ表記になります。
- ひとつでも合わないとき、またはノードを読めないときは、`unknown`（UNVERIFIABLE）です。

### アーカイブだけで検証する場合

出どころは `ledger <runId> (archive only: …)` と表記します。

- **限界**：保存した後にノードの台帳が巻き戻っても、アーカイブだけでは検出できません。同じ `runId` のまま、最後に保存した取引の台帳番号に別の取引が付いた場合も同じです。
- **照合への影響**：この表記はノードから直接読んだ場合（`ledger <runId>`）と一致しないので、照合を経ていないアーカイブがライブの読取りと組み合わされることはありません。

### ノードからそのまま読む場合

`fetch_txs` は、読む前と後に `frontier_status` を読みます。次のどちらかなら `unknown` です。

- `runId` が変わった。
- `ledgerBytes` が減った。
