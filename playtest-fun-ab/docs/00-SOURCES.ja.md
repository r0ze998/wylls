# 調査の基準にした記録

調べた日：2026-10-24。この作業のブランチは `playtest/fun-ab`（`d789ee3d` から切った。push していない）。試作と文書は、この中の `playtest-fun-ab/` にあります。

## 基準にした commit

| 何 | ブランチ | commit | 時刻 | 使い方 |
|---|---|---|---|---|
| 実装（最新） | `origin/ccr-184d6862-fqutoz` | `d789ee3d11d8` | 2026-10-23 16:44 UTC | ルールの数値と戦いの計算の出どころ。S1（段階 1a〜1e）を含む。`git fetch` で取り直したとき、GitBook が照合した `ad391ee` より 1 commit 進んでいた（`d789ee3` S1 1e：国の提案・投票・構え・追放） |
| 土台 | `origin/main` | `2321d5572b7b` | 2026-10-17 | S1 より前のルール（征服を含む）との差を見るため |
| GitBook 原稿 | `origin/claude/determined-ride-engpa4` | `dbde3acf090a` | 2026-10-23 | 設計の決定・提案・未決の区別の出どころ。実装そのものとは扱わない |
| 比較資料と補給網の案 | `origin/docs/eve-eternum-supply-design` | `5090501a2d36` | 2026-10-24 00:30 +0900 | 最上位の判断基準（①〜⑤）、補給網 27a が「検証する候補」であること |
| コアのプレイテスト一式 | `docs/core-playtest`（ローカル） | `b4985b2aaa9b` | 2026-10-22 | 既存の人間向けテストの手順（実時間）。結果の記入はない |
| 14 日のシーズンの記録 | `frontier/season-complete`（ローカル） | `adb4ac98f9b1` | 2026-10-18 | ボットのシーズン（sc-14d）の結果 |
| 参考に見ただけ | `origin/agent-wallet/integrate` `d716613e67de`、`origin/agent-wallet/delegation-notice` `ba815865047c`、`refactor/maintainability` `116b9945611a`、`design/redesign` `8dcfccc8181b`、`stage1a/arms-economy` `2aca855749ec` | ― | ― | 面白さの判断に直接は使っていない。`stage1a/arms-economy` は作業中に先頭が `c4942a85` から動いた（別の作業が進んでいる）ので、内容を前提にしていない |

この作業ツリーのもとのチェックアウト（`codex/magicblock-playable` `fd3f01ab`、2026-10-02）は、上のどれよりも古いので基準にしていません。

**この環境になかったもの。** GitBook が「未 push の最新の作業ツリー」と呼んでいるものは、ここでも見つかりませんでした。上の commit にない変更は、想像で補っていません。

## 実装済み・決定済み・提案の区別（面白さに関わるところだけ）

| 要素 | 状態 | 根拠 |
|---|---|---|
| 10 分のターン、州ごとの戦い、封じた進軍（行き先だけ隠れ、出発・兵の数・着くターンは見える） | 実装済み（main から） | `permutation-rules/src/frontier/seal.rs`、`docs/frontier/DESIGN.md` §6.2 |
| 戦いの計算（強さ・相性 ×1.5・城壁 ×0.667・丘 ×0.8・反撃 ×0.5 など） | 実装済み | `permutation-rules/src/combat.rs`、`frontier/clash.rs`。試作はこの計算を 400 件で突き合わせて一致（`tests/`） |
| 砦：守り手のいない状態で 72 ターン居続けると奪える。砦は取った人に何も払わない。守備は増えない | 実装済み | `permutation-rules/src/frontier/keep.rs` 1〜37 行 |
| 勝ち負け：シーズンの終わりに砦（州）を最も多く持つ国。賞金 80%、運営 20% | 実装済み（賞金のプログラム） | `permutation-prize/src/lib.rs` 1〜24 行。決定ログには対応する行がない（GitBook G2） |
| 戦いに勝っても略奪なし | 実装済み（そう作られている） | `siege::raid` は呼ばれていない（`docs/frontier/conquest/CONQUEST-CONTRACT.md` 291 行付近） |
| 出発ごとに体力 74、上限 120、1 ターンに 1 回復 | 実装済み | `permutation-frontier/src/proc/host.rs` 591 行、`permutation-rules/src/frontier/host.rs` 32 行 |
| 解散した軍勢の兵は、どこにいても次の精算で村の控えに戻る。新しい軍勢は体力満タン | 実装済み | `permutation-frontier/src/proc/host.rs` 322〜330 行、`permutation-rules/src/frontier/host.rs` 185〜214 行 |
| 兵器と工房、強い兵に兵器、倉、荷車、襲撃（奪うか焼く）、見張り塔、柵、砦の建物、国の投票 | 実装済み（S1、main には未統合） | `docs/frontier/stage1a〜1e` のメモ。**遊ぶための画面はまだない**（どの人もボットも遊べない） |
| 包囲の兵器、砦の建物の戦い、国内の襲撃 | 決定済み、未実装 | `docs/frontier/stage1e/S1-1E-NOTES.md`「Steps 3–5」 |
| 世界は続き、戦争だけ 2 週間の戦期で区切る | 決定済み、未実装（コードはシーズンで終わる） | GitBook 第2章 2.3、第10章 G4 |
| 札・決まり・公開する仕組み（段階 2〜4） | 決定済み（規則）、未実装 | GitBook 第10章 10.2 |
| 補給網（他人の生産枠を使う補給サービス） | 検証する候補（採用は決まっていない） | GitBook 第11章、`5090501` の 27a |
| 人間のプレイテスト | **一度も行われていない** | `docs/design/redesign/00-diagnosis.ja.md` 56 行（C6）、`docs/frontier/ai-citizens/SUMMARY.ja.md` 12 行。core-playtest の記入用紙は空欄 |

## ボットや AI の走行で分かっていること（人間の証拠ではない）

| 記録 | 中身 | 出典 |
|---|---|---|
| 14 日のシーズン sc-14d（ルールのボット 120、20 倍速） | 戦い 149 回と出発 7 回は、すべて最初の 244 ターン（約 1.7 日）まで。その後の約 1,800 ターンは軍が動かなかった。包囲 0、前哨 0、奪った砦 2。記録は、ボットの砦の命令が古くなった（`order_stale` 55）ことを理由に挙げている。ボットの作りの問題も含むので、ルールだけの結果とは言えない | `frontier/season-complete:docs/frontier/conquest/CQ3-A-NOTES.md` 110〜129 行 |
| 征服の契約 R-10 と OD-14 | 「砦はまだ何も払わないので、人間のプレイヤーには砦を取る組み込みの理由がない。ボットが取るのはそう作ってあるから」。砦に点を付けるかは未決の判断 OD-14 | `docs/frontier/conquest/CONQUEST-CONTRACT.md` 32 行、204 行 |
| 征服の契約 R-12 | 1 万人・28 日の想定で、76% の州は一度も持ち主が変わらない。契約はこれを「雪だるまにならない、意図した性質」としている | 同 2164 行 |
| S1 の交易のシミュレーター | 国内の道の運搬は 9〜21 分で、襲われうる地点は 1〜2。襲撃はまれと予測 | `docs/frontier/stage1b/S1-1B-NOTES.md` |
| AI 市民の走行 | AI 自身が始めた進軍は、12 体の走行で 7・1・1 回 | `docs/frontier/ai-citizens/RESULTS-2026-10.md` |

## 外部の資料

出典と、Wylls に当てはめるときの限界は、[02-EVALUATION](02-EVALUATION.ja.md) の「参考にした作品と研究」にまとめました。
