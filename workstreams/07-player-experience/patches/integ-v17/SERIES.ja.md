# ⑦ の系列 integ-v17：④ の現在版 8e96f24d の上（⑳ の web 部分を含む）

- **基準**：④ の `origin/claude/gallant-ride-cunptv` `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（統合候補 `ef63544c` の子孫）。
- **系列のブランチ**：`ws07-integ-v17`、先頭 `a88681911a6a221dd85f32eff40885bf008d5e96`、tree `bbba397fdea243409914ae391ac2c9721d2eb8e7`。
- `8e96f24d` に 0001〜0018 を `git am` すると、tree `bbba397f…` になり、系列の先頭と同じ（確認済み）。
- 0001〜0015 は integ-v16 と同じ内容。
- 0016 は ⑳ の `dc55f159` の web 部分。⑳ のコードで、⑦ は衝突の解決だけをした。
- 0017・0018 がこの回の ⑦ の変更。
- ④・⑳ へ渡すパッチ。どのブランチにも当てていない。

| # | SHA256 | 中身 |
|---|---|---|
| 0001 | `73cb12b2675445067c1c490c977071d0d081f74ab9cd8f8edaa1f7cc7b0a9b83` | v4〜v7 の 0001 |
| 0002 | `29def9861f09762be96b7eae11694f423f0a200db823b79f28f3ab2b240b98ab` | v4〜v7 の 0002 |
| 0003 | `10419fd2eefd38811a62d59dcbe4f5e0f8b90089667e06220caeeaeef31e0868` | v4〜v7 の 0003 |
| 0004 | `b8813dfae487db645eaceac1151985837dbaed9cce476bf67279b1179d2da696` | v4〜v7 の 0004 |
| 0005 | `84d83b1f6224b2afd540673a669dfee9ac24a413e7a51979435ce400f41f449c` | v4〜v7 の 0005 |
| 0006 | `0ef4c73f6410e23ea955adbcc40903b6e5b1d31ec2471336272991309222689b` | v4〜v7 の 0006 |
| 0007 | `937ea018cb101b1fa6bbac9d2f534b103abf8c26e36697bd4e2f82e9b47564dd` | v4〜v7 の 0007 |
| 0008 | `cd6fe64b75ed97fe318cd1d12330d5d8c2b3ea501ceb95a66373f63f4dab8f70` | v4〜v7 の 0008 |
| 0009 | `d82eae7938c1f5d521c5e62ce7238291bb6cfe5b2ad6314c1989296b275876bd` | v4〜v7 の 0009 |
| 0010 | `ee5be63d6dc67bfa91204e30daba5411c28e2130dba8b7401d4c1bf295f567d6` | v4〜v7 の 0010 |
| 0011 | `595f719bb82c8dd5e4d5f4b0aebb636a1d7930d55a3dc996e26986c8eb266ca4` | v4〜v7 の 0011 |
| 0012 | `c6c86236063a24fe3c7d1b2f8e4f73a5bebc31cb3a5b43ab1b7d58cef3ddc7f7` | v4〜v7 の 0012 |
| 0013 | `f3fab049d1059ae2e9453d3e94f35a2ec5897c74010019397c34f8b883fada8c` | v4〜v7 の 0013 |
| 0014 | `2d05ee1313d865ee92ca2a6e7e9425292d6d6f4c57aa218dbda72888a9a57284` | 地図のガイド（`a997a756`） |
| 0015 | `b2e64b958a3f9973410a8f109a1d94944be29f98da8bdb9a74007cbdcb1c6856` | integ-v16 の 0015（観戦の取得失敗、④ の未確定の状態） |
| 0016 | `c2f7c00168bbd5aaf16f9ac71d04fd63f4f1d6b644135bb766e0590198ebff93` | ⑳ の NFT 住民（`dc55f159` の web 部分。衝突の解決は commit の説明に記載） |
| 0017 | `d4b976d57d4f82751b4ec571401336941df374fdaffa30d388c3fa63bc08662b` | **この回**：NFT の一覧の読み込み失敗、閲覧者の切替（アカウント・NFT）、留守の要約の分離、代理人のページの ④ の7状態と取得失敗 |
| 0018 | `4461719e872b673d8a0ad60088937cdb699d5c580a1353a3bf8f6cd59092de7f` | **この回**：NFT 住民の進軍の控えをウォレットのものと分ける。観戦の再読み込みの画面テスト |

## テスト（tree `bbba397f…`）

すべて `tools/nokeys.mjs` の下（ブラウザは同じことをする init script の下）で実行した。

| 対象 | 結果 |
|---|---|
| 単体 47 本（⑦ の 12 本・82 件を含む） | 526 通過、1 件は guard が止めた（`web-frontier-agent` の 1 件が `createPrivateKey` を呼ぶ。結果に数えない） |
| 画面 `ws07-spectate`（英語、スマホ・PC、503・接続リセット・読めたあとの失敗） | 6/6、再読み込みの 2 件も 2/2 |
| 画面 `ws07-v17`（日本語・英語、スマホ・PC、再読み込み。NFT の一覧、代理人の履歴の7状態、年代記の状態） | 4/4 |
| 画面 `ws07-s1`・`ws07-s1-card`（到着の確度） | 8/8、6/6 |

**鍵を使うため実行しなかったもの**：`web-frontier-s1`、`live`、`marches`、`people`、`relay`、`chainio`、`opening-world`、`citizens-seatfix2-chain`、`npm test` 全体、M1 画面、`ws07-s1-page`、`ws07-s1-pure`、ページ全体での NFT の参加とウォレットの切替。
