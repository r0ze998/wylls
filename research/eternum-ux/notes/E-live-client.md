# E. 実画面の確認記録（Realms 公式サイトとクライアント）

確認日: 2026-10-29。ブラウザ: Claude Desktop の内蔵ブラウザ（ログインなし、ウォレット接続なし）。

## 確認できたこと

| URL | 結果 | 区分 |
|---|---|---|
| https://realms.world/ | トップの「LIVE」は Realms: Blitz。「one-hour onchain RTS where humans and AI agents compete」、賞金は $LORDS プール。Play Now は https://blitz.realms.world/ | 実画面で確認 |
| https://realms.world/games/realms-eternum | 状態は「DEVELOPMENT」。本文では Season 1 は終了しており、次の公開キャンペーンを準備中。ダッシュボードとして「ETERNUM SEASON ONE REVENUE & REWARDS DASHBOARD」(https://eternum-stats-mu.vercel.app/) へのリンクがある | 実画面で確認 |
| https://realms.world/games/blitz | 状態は「LIVE / MAINNET」。ジャンルは Real-Time Strategy / Free-for-All / PvP | 実画面で確認 |
| https://blitz.realms.world/ | **読み込めない。** Starknet RPC（alchemy）への接続が CORS で拒否され、`#root` が空のまま。2回試して同じ結果。内蔵ブラウザの環境に起因する可能性があり、一般のブラウザでも同じかどうかは未確認 | 未確認 |

## 結論（調査対象の確定）

- **現在遊べるのは Blitz（1時間の対戦）だけ。** Eternum は Season 1 が終了し、本編のクライアントで遊べる期間ではない（2026-10-29 時点の公式ページ）。
- そのため、Eternum 本編の UI は「終了済みシーズンの資料、コード、プレイヤーの声」でしか確認できない。現在の Blitz の画面も、今回は内蔵ブラウザで表示できなかったため**実画面では未確認**。
- スクリーンショット: 内蔵ブラウザのペインが非表示の状態では画像が黒くなり、有効な画像は取れなかった。画面の記録はテキストとアクセシビリティツリーで行った。

## 追記：現行の統合クライアント https://play.realms.party（2026-10-29）

| 画面 | 確認したこと | 区分 | 画像 |
|---|---|---|---|
| Play（入口） | 見出し「The mist forgets. Your realm remembers.」。Frontier は「A new land every day / Play free」。Blitz は「No Blitz scheduled this season.」。ほかに「Build orders」 | 実画面で確認 | `shots/realms-01-play-landing.jpg` |
| Play free を押した後 | 「Connect」のモーダル。Discord か、メールのコード（Send code）。**ウォレットの選択は出ない**。ここで止めた（アカウントは作っていない） | 実画面で確認 | `shots/realms-02-connect-login.jpg` |
| Season | Frontier「Season 1 · Day 12」の上位 10 人（sites cleared と LORDS）と、Blitz のレーティング上位 9 人。ログインなしで見られる | 実画面で確認 | `shots/realms-03-season-boards.jpg` |
| What's new（/scroll） | 2026-10-29 付けの「Season alpha」のパッチノート。内容は A-official-docs.md の「現行版」節に整理した | 実画面で確認＋公式に記載 | — |

- **入口の比較:** Realms の現行版は「Discord かメールでサインイン → すぐ無料で遊ぶ」。ウォレットは、賞金を受け取るとき（Blitz の参加費を払うとき）だけリンクする。WYLLS は「ウォレットをつなぐ → 2 回署名」で始まる（F-wylls-live-screens.md の画面 1b）。
- Frontier と Blitz の中の画面（HUD、Next up、攻撃予測）は、ログインが必要なため**未確認**。公式パッチノートの記述だけがある。

## 未確認として残すもの

- Blitz の現在の画面（ロビー、マッチ参加、ゲーム内 HUD）。一般の Chrome（Claude in Chrome）で開けば確認できる可能性がある。ただし、ウォレット接続を要求された時点で止める。
