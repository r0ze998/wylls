# 02 公開プロジェクトの比較と、採用した考え方

慣れない部分（自律エージェントの反復、再起動に強い実行、複数エージェントの共謀）について、手を動かす前に公開プロジェクトと文献を調べた（2026-10-30、Web 検索と各リポジトリの文書。ソースコードを読み込んだのは AI Town の ARCHITECTURE.md のみ）。依存として取り込んだものはない（Node の標準と既存の gateway モジュールだけ）。

| 対象 | どう解いているか | 採用したこと／しなかったこと |
|---|---|---|
| [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md) | 世界は1本のゲームループが進め、エージェントの LLM 処理は「operation」として外で走り、結果は input として世界に返す。1体につき進行中の operation は1つ。予定した実行は世代番号を持ち、世代が変わると古い実行は失敗する | **採用**：世界（`testworld.mjs`）だけが状態を変え、住民は署名した要求を出すだけ。住民ごとに「同じ行動の進行中は1つ」（`in-flight` で除外）。世代番号の代わりにエージェント財布の `modeEpoch`（停止で増える）を使う |
| [google-deepmind/concordia](https://arxiv.org/pdf/2312.03664) | Game Master が世界の結果を決め、エージェントは行動を提案するだけ。部品（component）と連想記憶で行動を作る | **採用**：結果を決めるのは世界と掲示板の公開事実（掲示板は「届いた」を自己申告でなく隊商の到着記録から判定）。記憶は部品として差し替え可能（⑫） |
| [daydreamsai/daydreams](https://github.com/daydreamsai/daydreams)（Eternum のエージェント） | context ごとの状態と記憶、型付きの action。再起動時の永続化は記憶の拡張に任せる。上限・再試行の方針は文書にない | **参考のみ**：action の型付け（候補 id の enum）は同じ発想。上限・再試行は自前で定義した（[04](04-safety-limits.ja.md)） |
| 耐久実行（Temporal・Restate など。[Diagrid の FAQ](https://www.diagrid.io/faq/682-does-catalyst-guarantee-exactly-once-execution-for-external-api-calls-from-ai-agents)、[実践記事](https://tianpan.co/blog/2026/07/01/exactly-once-was-hard-before-your-agent-could-retry-itself)） | 再実行は外部への副作用を一度きりにしない。副作用の冪等キーは**手順の位置**から作り、モデルの出力から作らない。結果を記録する前に落ちると再送が起きるので、送る前に台帳を見る。通信の再試行（同じ結果がほしい）とモデルの再サンプル（違う結果がほしい）を混ぜない | **採用**：キーは `<住民>:t<ターン>:<手順>`。判断を保存してから送り、再起動後は判断し直さず、世界にキーの結果を問い合わせる。通信由来の拒否だけを同じ行動として再試行し、恒久的な拒否は再試行しない |
| 共謀の研究（[Cournot 市場の LLM](https://arxiv.org/html/2601.17263v1)、[二重オークション](https://alphaxiv.org/overview/2507.01413v1)、[Audit the Whisper](https://arxiv.org/html/2510.04303v1)、[Agent Bazaar](https://docs.swarms.world/examples/research/open_agent_bazaar)、[Magentic Marketplace](https://infoq.com/news/2025/11/magentic-marketplace-microsoft)） | LLM 同士は指示がなくても暗黙に共謀しうる。検出は価格・流れ・推論記録の事後分析、隠れた通信路の検出など | **採用**：検出は公開事実の流れ（贈与の循環、同一所有者間の流れ、同じ品の往復）で行い、住民の側でも「循環を閉じる贈与」「同じ所有者への贈与」を候補から外す。**未対応**：言葉に隠した合図（ステガノグラフィ）の検出。掲示板の文は provider に untrusted として渡すだけで、候補を変えられないことは試験した |

## 採用しなかった選択肢

- **Temporal 等の実行基盤を入れる**：この規模では、既存の `createStateStore`（rename による原子保存）と冪等キーで足りる。④が実行基盤を決めたら、その上に `ExecutionPort` を載せ替える。
- **埋め込みによる記憶検索**：既存の AI 市民も使っていない（契約の非目標）。⑫の担当範囲。
