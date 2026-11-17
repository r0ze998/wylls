# 前提：コード・文書・他の担当で確かめたこと

作業日 2026-10-30。基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（`integrate/claude-consolidation-20261029` の上。`main` の `921429322d5aecd1a3df0dd8d82c405c87dd985a` の子孫で、`main` にはまだない）。

## 1. 作業開始時の状態

- この環境の checkout は `claude/determined-maxwell-uhc6a3` @ `921429322d5aecd1a3df0dd8d82c405c87dd985a`（= `main`）、未 commit の変更なし。
- `AGENTS.md`・`CLAUDE.md`・リポジトリの skill（`SKILL.md`）は、`main` にも基準 commit にもない。作業の決まりは [DEVELOPMENT-HANDOFF.ja.md](../../../docs/DEVELOPMENT-HANDOFF.ja.md)（提案を採用済みとして扱わない・作業ごとに独立ブランチ・`git add .` しない）に従った。
- 作業は worktree `wylls-ws15`、ブランチ `ws/15-coop-outcomes`（基準 commit から）。`workstreams/15-coop-outcomes/` の外は一行も変えていない。

## 2. 現行の勝ち方（コード）

| 事実 | 場所 |
|---|---|
| 勝者は、シーズン終了時に最も多くの要塞（province）を持つ国（「Decided (owner)」） | `permutation-prize/src/lib.rs` 冒頭、`winners()` |
| 同点は領土の鐘（TERRITORY_BELLS）、なお同点は等分（暫定） | 同 `provisional::RULES`, `break_tie` |
| 参加費の 80% が賞金、20% が運営 | 同、`prize-params.json` `decided.split` |
| 国の中の取り分は運営が出す台帳（capture・reinforcement、暫定） | `permutation-gateway/src/frontier/prize-params.json`, `achievements.mjs` |
| 数えるのは Season が Ended の後、`end_bell` は作成時に決まる | `lib.rs` の Tally の説明 |
| 戦期（世界は続き、戦争だけを区切る）は**実装されていない** | `戦期`・`war period` はコードに現れない |
| 建物の費用：砦 wood 500 / stone 800 / arms 50 / gold 200、塔 300/400/20/100、柵 200/100/0/20 | `permutation-rules/src/frontier/structure.rs` `cost_units` |
| 隊商の記録：CARAVAN_SENT(91)・SETTLED(92)・RAIDED(93)、積荷は u32×8 | `frontier-abi/src/v2/log.rs` |
| 建物の利用の記録は砦の守備（FORT_GARRISONED）だけ | 同 |

## 3. 決まっている設計（決定ログ）

- 世界は続き、戦争だけを戦期で区切る（C 案、2026-10-23）。戻すのは勝敗の砦・戦争の状態・勝ち点。
- お金の守るべき線：発行で払わない、札は賞金の取り分を表さない、価値の出どころを示す。
- 国の中の取り分は「国の戦いで消費されたもの」だけ（28）。売った量・送った量・使われた回数は数えない。
- 6か国固定、国内の襲撃は記録に残る、新しく来た村の守り。

## 4. 他の担当（伝え聞き。各担当の transcript から、ファイルは手元にない）

| 担当 | ここで使ったこと |
|---|---|
| ① | 候補 **X**（共同成果・国の目標・個人の目標を別々に記録、世界を終えない）と **Y**（共同達成で期間を閉じる）。依頼の板（`record.mjs` の `fold()`、`link` は先着）、到着の数え方（村あては積荷を下限、倉あては未検証、量はチェーンの記録から）。最新 `ws/01-coop-s1` @ `3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52` |
| ⑧ | 一般の競争（CMP）・国際取引（TRD）・**外部報酬付き協力（COOP：配った量に応じて共有の取り分を足す）**の模型。COOP は①の共同達成と別物として扱い、この担当では使っていない（取り分も補助金も足さない）。取引の回数で配ると往復取引が得をする、という⑧の結果は、ここで取引の回数を理由にしない根拠の一つ。EndSeason をまたぐ隊商が精算できない不具合の報告 |
| ⑭ | 中央塔の3案。⑭は勝ち負けも世界の終わりも決めず、`toFacts()`（`wylls.ws14.tower-facts/0`）で事実だけを出す |
| ④ | Run Receipt、到着の判定（Recorded／RuleDerived／Unverifiable／KnownZero）、提案 P1（`credited` を記録に足す） |

案の対応：この担当の **B ≒ ①の X**、**C ≒ ①の Y**。違い：①の例は「使われた交易 50」を資源をまたいで合計しているが、ここでは合計しない。

## 5. オープンソースの比較（手を動かす前に）

| 対象 | 方式 | 取り入れたこと | 取り入れなかったこと |
|---|---|---|---|
| [CacheControl/json-rules-engine](https://github.com/CacheControl/json-rules-engine)（docs/rules.md を読んだ） | 条件の木を評価し、各条件の成否を `RuleResult` に残す | 判定の各段階に成否と理由を残す（`stages`・`reasons`） | 依存の追加、非同期の事実、優先度の仕組み（決定性と単純さを優先） |
| イベントソーシングの再生（例：Shivay00001/event-sourcing-stream） | 追記だけの記録を純粋関数で畳む | 正準の並び＋重複除去＋純粋な畳み込み、入力と結果の hash | 永続化・スナップショット |
| [gitcoinco/quadratic-funding](https://github.com/gitcoinco/quadratic-funding)（README を読んだ）の pairwise 方式 | 一緒に動く組を協調の証拠として、上乗せを減らす | 「人数」は独立した参加者で数える（`cluster` で一人に寄せる、国と人の最大マッチング）。ラベルがなければ防げないことも同じ | 上乗せの資金（ここでは足さない）、連続的な割引 |
| 往復取引の検出（有向グラフの閉路、例：nitishabharathi/Washtrade-Detection） | 取引のグラフの閉路を探す | 閉路を探す代わりに、**消費された量だけを数える**（荷の保存で閉路は自然に効かなくなる） | 閉路の検出そのもの（閾値の決め方が恣意的になる） |

GitHub の MCP はこのリポジトリ以外を読めなかったので、上の README・docs は公開の raw ファイルを取得して読んだ。
