# 付録D 出典と根拠の対応表

## D.1 この原稿が説明している状態

### 執筆した環境

| 項目 | 執筆の開始時 | 執筆の終了時 |
|---|---|---|
| 記録の時刻（UTC） | 2026-10-23T13:54:29Z | 2026-10-23T15:23:34Z（第1版）。更新：2026-10-23T15:45:18Z に GitHub 側を再確認 |
| リポジトリ | `/home/user/wylls`（クラウドのコンテナ、GitHub から新しく複製） | 同左 |
| ブランチ | `claude/determined-ride-engpa4` | 同左 |
| HEAD | `2321d5572b7b2e288483c3ba55edef7a17079fc4` | 同じ |
| `origin/main` | `2321d5572b7b2e288483c3ba55edef7a17079fc4` | 同じ |
| 未コミットの変更（原稿のフォルダを除く） | 0 件 | 0 件（未追跡は原稿のフォルダ `gitbook-design/` だけ） |

未 push の最新の作業ツリーは、この環境にありませんでした。

### 執筆の途中で GitHub に現れたブランチ

執筆の開始時の `git ls-remote` にはなく、その後の確認（14:42 UTC と、その後の再確認）で見つかったものです。読み取りだけで扱いました。

| ブランチ | commit | 最終 commit の時刻 |
|---|---|---|
| `ccr-184d6862-fqutoz` | `41ba516ea38deff29ad04926a70e154d1ff0322d` | 2026-10-23 12:59:38 UTC |
| `docs/eve-eternum-supply-design` | `fc0ac0c3`（上のブランチに 1 commit を足したもの。作者は r0ze117） | 2026-10-24 00:07:14 +0900 |
| `agent-wallet/integrate` | `e3e8a4723da585710bddf0d16cd1210b690553b4` | 2026-10-23 14:25:06 UTC |
| `ccr-184d6862-fqutoz`（更新後） | `ad391eec9580fa8c457bd3f4bf35013e820a611e`（段階 1e の手順 1、決定 K1〜K4） | 2026-10-23 15:35:00 UTC |
| `docs/eve-eternum-supply-design`（更新後） | `5090501a2d36c020d12e4dcf93a21699c9001752`（`fc0ac0c` の後に 2 commit。チェーンの比較、最上位の判断基準） | 2026-10-24 00:30:43 +0900 |
| `agent-wallet/delegation-notice` | `0c5d8345675784d0a89ab2f6301289f9dafeac07` | 2026-10-23 14:46:00 UTC |
| `refactor/maintainability` | `116b9945611afc0fb6adccd2aed83aaf12bdbfd7` | 2026-10-23 10:58:05 +0900 |

### 執筆の開始時からあった、main に未統合のブランチ

| ブランチ | commit | 日付 |
|---|---|---|
| `origin/feature/agent-wallet` | `33cb4c7f2faf6dd0a785ea0329d83bd3f688430e` | 2026-10-17 |
| `origin/frontier/season-complete` | `f265d7bb1d5c13fa42e31fde83fbd13a31d336b2` | 2026-10-17 |

### 原稿の版

最初の版は main だけを基準に書きました。再設計のブランチが見つかったので、全体を書き直しました。最初の版は、添付のアーカイブの `gitbook-design-v0-main-based/` にだけ残します（GitBook の目次には入れません）。

最初の版にあった独自の案は、再設計の決定と食い違うので取り下げました。

| 旧版の案 | 取り下げた理由（再設計の決定） |
|---|---|
| 「看板」（施設の利用条件のひな形） | 建物の設定は部品の近道。使う権利は使用権の札 |
| 「元請け」と「保証金」（元請けが下請けの依頼者になり、失敗を保証金で補償する） | 組み合わせは札をつなぎ目にした仕組み。失敗は止まって記録。補給網の案（27a）も、金融の保証や保険で失敗を隠さないとしている |
| 襲撃で積み荷の半分を奪う | 奪うと荷車ごと持ち主が移る（J2）、または全部焼く |
| 作業枠を予約しない、予約料、予告期間 | 条件の変更は新しく出す札にだけ効く。手数料は前払い、取り合いは割合で分ける |
| 継続する世界を未決定として扱う | 世界は続き、戦争だけを戦期で区切る（C 案） |

## D.2 再設計の文書（設計の基準）

ブランチ `ccr-184d6862-fqutoz`、フォルダ `docs/design/redesign/`。決定ログ（`99-decisions.ja.md`）の最終変更は commit `e66fafed`（2026-10-23 07:20 UTC、「PLAM セッションから復元」）。

| 本文 | 記述 | 根拠（再設計の文書） |
|---|---|---|
| README、00、第1章 | 核、土台、組み立て、遊びの循環、なぜ戦略になるか、境界 | `15-direction-2026-10-23.ja.md`、`27-design-v1.ja.md` の 1 章、決定ログ |
| 第2章、第3章 | 部品（倉・札・送る・動かす＋まとめる）、世界のルール | `16-primitives.ja.md` の 1〜2 章 |
| 第3章 | 建物は部品の近道、出しっぱなしの申し出、建物が入る段階 | `12-structures.ja.md` の 5 章 |
| 第2章、第4章 | 段階 1 の規則（兵器の使い道、荷の見せ方、奪う・焼く、鉱石の偏り、国内の襲撃） | `18-stage1-play.ja.md` の 7〜11 章 |
| 第3章、第4章 | 段階 2 の規則（札 3 種、引き換えの預かり、奪われた倉の札、割合で減らす、清算） | `20-stage2-play.ja.md` の 2、5 章 |
| 第3章 | 段階 3 の規則（合図 4 種、すること 2 つ、判定、手数料、上限、失敗） | `21-stage3-play.ja.md` の 2 章 |
| 第3章 | 段階 4 の規則（仕組みの紙、条件の変更、放置、AI の確認、写す） | `22-stage4-play.ja.md` の 4 章 |
| 第7章 | 世界と戦期（C 案） | `23-world-and-periods.ja.md` |
| 第6章 | AI の 4 つの役割、共通の決まり、代理の札、表示 | `24-ai-roles.ja.md` の 1〜3、5 章 |
| 第6章、第7章 | お金の流れ、守るべき線、トークンの案 | `25-money-structure.ja.md` |
| 第1章 | 最初の 30 分 | `26-first-session.ja.md` |
| 第7章 | 国の中の取り分の 5 項目 | `28-prize-shares.ja.md` |
| 各章 | 残りの 22 件の決定（A1〜G3） | `29-remaining-decisions.ja.md` |
| 第10章、第11章、付録C | 段階 1 の実装計画、J1〜J6 | `30-stage1-build-plan.ja.md` |
| 第2章 | 新しく来た村の守り | `19-newcomers.ja.md` |
| 第2章 | 土地と国の 8 項目 | `14-land-and-nation.ja.md` の 5 章 |
| 第2章 | 見えない情報 | `13-hidden-information.ja.md` |
| 第8章、付録C | 独自性の判定（旧）、組み込みの考え方 | `17-summary-uniqueness-integration.ja.md` の 2〜3 章 |
| README、第3章、第5章、第6章、第8章、第9章、第11章 | 独自性の更新、最上位の判断基準、補給網の案（4 段階、他人を使う理由、最小試作、比べて判定、会計の論点、AI の 3 つの役割）、チェーンの比較（第9章） | `27-design-v1.ja.md` の 1 章の更新、`27a-composable-supply-design-proposal.ja.md`、`17a-eve-frontier-eternum-evidence.ja.md`、`README.ja.md`（ブランチ `docs/eve-eternum-supply-design` の `5090501`） |
| 第10章 G3 | 「フェーズ7より前にコードを書かない」 | `README.ja.md` の決まりごと |

## D.3 実装の根拠

| 本文 | 記述 | 根拠 | 種類 |
|---|---|---|---|
| 第2章、第10章、付録C | 兵器、工房、強い兵の費用、地形の鉱石 | `docs/frontier/stage1a/S1-1A-NOTES.md`（ブランチ `ccr-184d6862-fqutoz`） | 実装メモ |
| 同上 | 倉、荷車、命令 0xB0〜0xB6、倉の上限と満杯、他人宛ての財布の署名 | `docs/frontier/stage1b/S1-1B-NOTES.md`、`S1-1B-CONTRACT.md` | 実装メモ、契約書 |
| 同上 | 荷車の戦いへの参加、護衛、守られるマス、試験 366/366、計算量 280,855 | `docs/frontier/stage1b/S1-1C-NOTES.md` | 実装メモ |
| 同上 | 見張り塔、削る量、命令 0xB7〜0xB9、封を開く命令の上限 28,000 | `docs/frontier/stage1d/S1-1D-NOTES.md` | 実装メモ |
| 第10章 | 新参の守りは時間だけ | `permutation-rules/src/frontier/holding.rs` の `shield_secs`（同ブランチ） | コード |
| 第10章 G2 | 賞金の勝者のコメント | `permutation-prize/src/lib.rs:23-24`（main） | コード（コメント） |
| 第6章 | AI 予算の位置づけ、保管、料金、出金、鍵の保有者、停止と委任 | `docs/agent-wallet/DESIGN.md` §0、§1、§5、§6、§10（`feature/agent-wallet` と `agent-wallet/integrate`） | 文書 |
| 第6章 | 委任がないときは有料の呼び出しをしない | commit `0866734d`（`agent-wallet/integrate`） | commit の説明 |
| 第6章、第12章 | 「鍵を作り直す」が委任を解除する | `docs/agent-wallet/PLAN-NEXT-2026-10-23.ja.md` の段階 2（`agent-wallet/integrate`） | 文書（コードを読んで確認と記載） |
| 第6章 | MCP の接続口 | `docs/agent-wallet/MCP.md`（`agent-wallet/integrate`） | 文書 |
| 第7章 | 14 日のシーズンを最後まで動かした | commit `adb4ac98` の説明（`refactor/maintainability`） | commit の説明 |
| 第9章 | Wylls の配置（最初の版は devnet、今の版はローカル、本番は計画） | `README.md`（main） | 文書 |
| 第2章、第5章 | 州は 61 マス、1 回の移動は 4 州まで | `frontier-abi/src/layout/province.rs`、`frontier-abi/src/error.rs`（main） | コード |
| 第10章、第11章 | 段階 1e の手順 1 | commit `ad391ee` の説明と段階 1e のメモ（`ccr-184d6862-fqutoz`） | commit の説明、実装メモ |
| 第5章（地図と画面の案） | hex を内部に残し「生きた文明の地図」として見せる | あなたの 2026-10-23 の指示（チャット）。再設計の文書には記録がない | 指示 |
| 00 | 古い決定 T1、Y1、Y2、Y6、V2 | `docs/frontier/DECISIONS.md:397,424-477`（main） | 文書 |
| 第8章、付録B | EVE Frontier と Eternum | 付録B の各行に出典、版、確認日 | 外部 |
| 付録E | GitBook の取り込み形式 | https://gitbook.com/docs/getting-started/git-sync/content-configuration（2026-10-23 に確認） | 外部 |

## D.4 確かめていないこと

| 項目 | 理由 |
|---|---|
| 未 push の最新の作業ツリー | この環境にない |
| ブランチの試験、ビルド、実ブラウザでの確認 | 設計書の作成が目的のため、実行していない。実装メモの試験結果は引用として扱い、今回の動作確認としては扱わない |
| 画面の図 | この文書の提案の図で、実装の画面ではない |
| 本文の例の数値の釣り合い | 仮置き。S1 の数値も「フェーズ6」の印の付いた仮の値 |
| 再設計の文書 17 の Eternum の運搬の引用 | 執筆者は再確認していない |
| 17a が引く Sui、Starknet、Solana、Circle の公開資料 | 執筆者は再取得していない。第9章 は 17a の記述として引用した |

## D.5 執筆の終了時の確認

| 項目 | 結果 |
|---|---|
| 時刻 | 2026-10-23T15:23:34Z（第1版）、2026-10-23T15:51:33Z（更新）、2026-10-23T16:17:42Z（統合版） |
| 作業ツリー | HEAD、`origin/main` ともに `2321d55` のまま。未コミットの変更は 0 件。未追跡は `gitbook-design/` だけ。既存のファイルは変更していない |
| 未コミットの状態の指紋（原稿のフォルダを除く） | `e3b0c44298fc1c14`（空。開始時と同じ） |
| 差分の指紋（`git diff HEAD`） | `e3b0c44298fc1c14`（空。開始時と同じ） |
| GitHub 側のブランチ | 開始時の 12 本に、`ccr-184d6862-fqutoz`、`docs/eve-eternum-supply-design`、`agent-wallet/integrate`、`refactor/maintainability` の 4 本が加わった（D.1）。その後、`ccr-184d6862-fqutoz` と `docs/eve-eternum-supply-design` が進み、`agent-wallet/delegation-notice` が加わった（D.1 の「更新後」の行） |
| 原稿の検査（`tools/check_links.py`） | 20 ファイル、エラー 0、警告 0（リンク先、画像の参照、目次の重複、状態のタグ）。表の列数もすべて一致 |
| 図 | `images/three-layers.svg`、`images/composite-flow.svg` を Chromium で描画して、文字の重なりがないことを目で確かめた |
| 第三者の査読 | 3 回（旧版、書き直した版、統合版に各 1 回）。統合版の指摘 37 件のうち、内容の矛盾、状態の誤り、参照、用語の指摘を反映した |
| commit と push | していない |

## D.6 この版の作り方の記録

| 時期 | したこと |
|---|---|
| 第1版（2026-10-23 15:23 UTC まで） | main だけを基準に書き始め、再設計のブランチが見つかったので全体を書き直した（D.1） |
| 補給網の前提 | 一度「27a を採用する前提で第9章（今の第11章）を直して」と指示を受けて書き直しかけた。その後の指示（補給網は採用決定ではない候補の一つ）を優先し、【検証する候補】として扱っている |
| 統合版（この版） | 章の順を「プレイ → ルール → 画面 → AI → 経済 → 比較 → チェーン → 実装との差 → 検証と開発順序 → 未決定事項」に並べ替えた。UI/UX と地図の章（第5章）とチェーンの章（第9章）を独立させた。言葉を「補給網」「検証する候補」にそろえた |
