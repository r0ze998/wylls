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

## 1b. コードが根拠にしている関連文書（v2 で確認）

`ledger.mjs` の冒頭は「AC2-NOTES.md に記載」、`mind/memory.mjs` は「AC1a-NOTES.md」を参照するが、**基点 `4cd901de`・`main` には `docs/frontier/ai-citizens/AC2-NOTES.md`、`AC1a-NOTES.md`、`integ-A-NOTES.md` が無い**。`origin/frontier/ai-run`、`origin/frontier/ux`、`origin/archive/claude-submit-20261029` にあり、三つのブランチで同一（AC2-NOTES の blob は `dd75b4bc`）。そこから読んだもの：

| 文書の記述 | ⑫への影響 |
|---|---|
| AC2-NOTES 規則 2：記録の `bell` は chain の slot の bell、`created_bell` は使った行の最大 bell。`bell > ref + 14` の行は無視して、遅い行で再生が変わらないようにする | 発生 `bell` と観測 `created_bell` の分け方と名前を踏襲。ただし⑫は遅い記録を**捨てずに**取り込み、`observedBy` で「その時点で知っていたこと」を再現する（再生の決定性は `created_bell` で保つ） |
| integ-A-NOTES §17「Open points after part 3」：province・clash file が 2 bell 以上遅れると `missing_recent` を数えるが cursor は止めない。そのため、判断済みの bell より小さい `created_bell` のエピソードができうる | 今回の指摘 4（記録だけ遅れた配送）と同じ問題が既存側にもある。⑫の `reassess` はこれを扱う形 |
| AC2-NOTES 規則 12：`mind/sanitize.mjs` が未作成のため `memory/safe.mjs` で代用、統合時に差し替え可 | その後 `mind/sanitize.mjs` は作られたが、memory は代用品のまま。integ-A-NOTES は「代用品はもう drop-in と称さず、エピソード文で同じ結果になることをテストで示した」と記す。⑫は本物を使う |
| AC2-NOTES「Additive deviations」：ledger の `decay_day`、`trust.applied`、grievance の `nation`・`answered_bell` など | 契約 §5.1 の例との食い違いの出典はここ（README・報告の食い違い一覧） |
| AC2-NOTES：tag は 16 桁の小文字 hex | ⑫の fixture は短い ASCII の handle。本線では hex tag を渡す |

## 1c. v3 で読んだコード（証拠の意味を決めるため）

| 箇所 | 読んだこと | ⑫への影響 |
|---|---|---|
| `permutation-frontier/src/proc/caravan.rs` `settle_caravan`（0xB2） | 宛先が生きていれば DELIVERED。村宛ては `settle_tiered` で同じ時刻までの生産を精算した後、資源ごとに `h.credit(now, r, c)`。倉宛ては `to = min(have + c, max(cap, have))`。log の積荷は `cargo_log` で `floor(milli / 1000)` の整数単位 | 村宛ては規則で加算量を導ける（下限）。倉宛ては記録だけでは導けない |
| `permutation-rules/src/frontier/holding.rs` `Holding::credit`、`Store::add` | `credit` は `settle` の後に `stores[r].add`。`add` は注記どおり上限を超えてもよい（`saturating_add`） | 村宛ての加算は積荷の全量 |
| 同 `caravan.rs` の `CARAVAN_SENT` を出す箇所 | `send_caravan`（0xB1）と `settle_raid` の TAKE 分岐の 2 か所 | coverage が覆うべき経路 |
| `workstreams/03-composability`（`origin/claude/modest-goldberg-c180fk`） | 外部プログラムが CPI で SendCaravan を呼べる（実チェーンで確認）。`frontier-node` の verify はトップレベルの命令しか集めない（③のコード読み） | トップレベルだけの索引では未発送を証明できない。経路 `send_caravan/cpi` を必須にした |
| `frontier-abi` `caravan_outcome` | DELIVERED 0、LOST 1 のみ。受取人も加算量も記録に無い | 受取人は区間証明、量は上記の根拠 |
| findex（`frontier-node/crates/findex`） | event index と account snapshot を持つ。加算量・所有者区間・完全性の証明を事実として出す機能は無い | ④への依頼（02）。snapshot の前後差は使わない |

## 2. 外部 OSS の比較（GitHub で検索・読了したもの）

| 手法 | 出典 | 長所 | ⑫に合わない点 | 採否 |
|---|---|---|---|---|
| 記憶ストリーム＋ recency×importance×relevance 想起 | joonspk-research/generative_agents（`retrieve.py` の `new_retrieve`、重み `[0.5, 3, 2]`） | 単純、説明しやすい | relevance に埋め込み（非決定的・外部呼出し）。出典が要約で消える | 半減期による減衰だけ採用（既存 retrieve.mjs も同系） |
| 時間付き知識グラフ。矛盾は削除せず `invalid_at`/`expired_at` で失効、edge は `episodes` で出典を保持 | getzep/graphiti（`edges.py` EntityEdge、`edge_operations.py` `resolve_edge_contradictions`） | 訂正・失効・出典の扱いがまさに要件 | 事実抽出と矛盾判定を LLM が行う | **採用（考え方）**：追記のみ、訂正は新記録、rollback で失効、全派生行が出典 id を持つ |
| LLM が ADD/UPDATE/DELETE を決める記憶層 | mem0ai/mem0 | 導入が容易 | 削除と上書きが LLM 任せで再生不能。偽申告に弱い | 不採用 |
| Beta 評判（Jøsang & Ismail 2002）：E=(r+1)/(r+s+2)、忘却係数 | 論文の式（OSS 依存なし） | 正負の根拠を分けて持てる。根拠ゼロで 0.5、不履行で下がる、古い根拠は薄まる | 「根拠が無い」と「根拠が足りない」を区別しない | **採用**。v2 では確認済みの根拠だけを入れ、未確認は別の一覧と caution 項に分けた |

外部コードは取り込んでいない（ライセンス上も依存を増やさない）。式と設計だけを参考にした。
