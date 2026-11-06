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
