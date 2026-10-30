# ⑫ 調査：既存の記憶・意思決定と、外部の手法比較

基点 `4cd901de`（`integrate/claude-consolidation-20261029`。GitHub `main` `92142932` に PR #21 の試遊文書を加えたもの）で確認した事実。

## 1. 既存コードで再利用したもの・しなかったもの

| 既存 | 場所 | 内容 | ⑫での扱い |
|---|---|---|---|
| エピソード | `permutation-gateway/citizens/memory/episodes.mjs` | 公開記録（DEPART/REVEAL/CLASH/CAMP/BUILD）から code が作る事実。id は `sha256(tag‖kind‖bell‖created_bell‖src)`。純関数・再生可能 | 方針（記録から純関数で導出、id で冪等）を踏襲。隊商の記録は読まないため、⑫は独自の fact を持つ |
| 台帳 | `citizens/memory/ledger.mjs` | trust = `t_code + t_model`（±100 で clamp）、日毎の減衰、grievance、`commitments: []` は予約で常に空 | 置き換えない。trust は「上げ下げする1本の数」なので、⑫は根拠一覧付きの Beta 推定を別に持つ |
| 想起 | `citizens/memory/retrieve.mjs` | `importance × 0.5^(age/72) × (1+0.5×重なり)`、埋め込みなし、決定的 | 同じ「半減期で古い根拠を薄める」形を信頼度の重みに採用（半減期は 432 bell） |
| 文字列の消毒 | `citizens/mind/sanitize.mjs` | 固定の消毒手順。`memory/safe.mjs` は stand-in で「信頼できない文字列には代用不可」と自ら明記 | **`mind/sanitize.mjs` を import**（発言は untrusted、code 文は trusted） |
| 正規 JSON・sha256 | `citizens/memory/config.mjs` | `canonical`, `sha256hex` | import して id とハッシュに使用 |
| 隔離 | 契約 §5.6 | 描画は自分の ownState・公開・自国の封印情報だけ | 同じ原則を「fold の最初に可視性で絞る」形で実装 |
| 評議会 | `citizens/social/council.mjs` | 国ごとの Strike Order | 直接は使わず、可視性 `nation` で国の卓の発言を表現 |
| 判断 | `frontier-node/crates/bots/src/ai/brain.rs`、`citizens/mind/*` | code が候補（≤12）を作り、モデルは選ぶだけ。検証に落ちたら autopilot | 同じ構造：code が候補と費用項を作り、policy は選ぶだけ、検証に落ちたら参照 policy |
| 隊商の事実 | `fclient/src/conquest.rs` `CqEvent::CaravanSent/Settled/Raided`、`frontier-abi` `caravan_outcome`（DELIVERED 0, LOST 1） | 送り主 tag・seq・積荷・目的地・結果 | ⑫の fact の正本。**CARAVAN_SETTLED は受取人の tag を持たない**（目的地の場所だけ）ので、④に解決を依頼（02 参照） |

既存の AI 市民は**約束（pact）を意図的に作っていない**（契約 v1.3 付録 A.5：ledger `commitments` は常に空、pact 語は検証で拒否、テストが persona・prompt・PUB を grep）。⑫はこの不活性経路に触れず、`workstreams/12-memory/` の独立 module として作った。本線へ接続するには契約の新版と所有者の判断が要る（README「限界」）。

## 2. 外部 OSS の比較（GitHub で検索・読了したもの）

| 手法 | 出典 | 長所 | ⑫に合わない点 | 採否 |
|---|---|---|---|---|
| 記憶ストリーム＋ recency×importance×relevance 想起 | joonspk-research/generative_agents（`retrieve.py` の `new_retrieve`、重み `[0.5, 3, 2]`） | 単純、説明しやすい | relevance に埋め込み（非決定的・外部呼出し）。出典が要約で消える | 半減期による減衰だけ採用（既存 retrieve.mjs も同系） |
| 時間付き知識グラフ。矛盾は削除せず `invalid_at`/`expired_at` で失効、edge は `episodes` で出典を保持 | getzep/graphiti（`edges.py` EntityEdge、`edge_operations.py` `resolve_edge_contradictions`） | 訂正・失効・出典の扱いがまさに要件 | 事実抽出と矛盾判定を LLM が行う | **採用（考え方）**：追記のみ、訂正は新記録、rollback で失効、全派生行が出典 id を持つ |
| LLM が ADD/UPDATE/DELETE を決める記憶層 | mem0ai/mem0 | 導入が容易 | 削除と上書きが LLM 任せで再生不能。偽申告に弱い | 不採用 |
| Beta 評判（Jøsang & Ismail 2002）：E=(r+1)/(r+s+2)、忘却係数 | 論文の式（OSS 依存なし） | 正負の根拠を分けて持てる。根拠ゼロで 0.5、不履行で下がる、古い根拠は薄まる | — | **採用**：「関係値を上げ続けない」要件に合う |

外部コードは取り込んでいない（ライセンス上も依存を増やさない）。式と設計だけを参考にした。
