# 統合候補へ移した ⑦ の系列（integ-v16）

- **基準**：統合候補 `integration/ws09-13-v16-d0949fd4` の `ef63544c727490fc6801d30affd11c5b7106c480`（④ の `77c5cbe2` の親）。
- 統合候補には ⑦ の 0001〜0013 も、地図のガイドの修正（`a997a756`）も入っていなかった。`a997a756` は統合候補の祖先でもない。そこで 0001〜0013 を 3-way で当て直し、`a997a756` を cherry-pick した（0014）。衝突は無かった。
- 0015 がこの回の変更：観戦画面の `/h/events` 取得失敗、④ の送信の7状態。
- 系列のブランチ：`ws07-integ-v16`、先頭 `7889f873d3f6ad82836b62a30820683f1fbe0e1a`。
- `ef63544c` に 0001〜0015 を `git am` すると tree `66916259af482fc61f08e751412a9a7377cfabd0` になり、系列の先頭と同じ（確認済み）。
- ④ へ渡すパッチ。統合候補にも他担当のブランチにも当てていない。

| # | SHA256 | 中身 |
|---|---|---|
| 0001 | `dad7e0f1bb4884c0ac90588825db87d0d26c22cc908d43cbab69a6c25e02affd` | v4〜v7 の 0001 と同じ内容（統合候補へ当て直し） |
| 0002 | `deb233b8a2f36e8a098e7ec31a44bda671b36ca21e52020afde836606338a1f5` | v4〜v7 の 0002 と同じ内容（統合候補へ当て直し） |
| 0003 | `f3b3f7f840919b46c2df723ca571272af9c7eca2e8e5d4a877232225aac52f8c` | v4〜v7 の 0003 と同じ内容（統合候補へ当て直し） |
| 0004 | `127870bfb1e0c0ed69f80698795b9281dfdc82d39ecba9a3d7d880f93b087bf4` | v4〜v7 の 0004 と同じ内容（統合候補へ当て直し） |
| 0005 | `9527e8d58d9f6c71873fdeed74b9911d23992eb6192f53359d08bacf5aae52e4` | v4〜v7 の 0005 と同じ内容（統合候補へ当て直し） |
| 0006 | `58a8a52743bca8cfb02506e81397a67c8e44ba989d4026aa8512d874d93f6d99` | v4〜v7 の 0006 と同じ内容（統合候補へ当て直し） |
| 0007 | `21992ada1e4bbb189bfdcf3b8641768fcdd77dc75f42d872f7613b41e45148ac` | v4〜v7 の 0007 と同じ内容（統合候補へ当て直し） |
| 0008 | `de5108cf7804b6927f2f942480a9f0d40b3f99c0af1dc82e7b5fbe9ea0ce4251` | v4〜v7 の 0008 と同じ内容（統合候補へ当て直し） |
| 0009 | `1bc93665c1264bd7248c4245de15af59af8c15a128d9de41fe5cf9dcfbb75cb6` | v4〜v7 の 0009 と同じ内容（統合候補へ当て直し） |
| 0010 | `67534b279d5a7fa7d9571bf2428503f7fbec5e1de9af6ae4dd6d9ef471f3f542` | v4〜v7 の 0010 と同じ内容（統合候補へ当て直し） |
| 0011 | `68e09254c49c8000349ada6b8b6d6f54e5447efd21548abebcefef3bf0180a3e` | v4〜v7 の 0011 と同じ内容（統合候補へ当て直し） |
| 0012 | `958d4f8764611d97ac15f7206b1a62eabda4a001f8b3cfe12ffa1a95e6a3d919` | v4〜v7 の 0012 と同じ内容（統合候補へ当て直し） |
| 0013 | `eb576d84be304ee56d81af6c1f6e205c486d8571e4845efc74623469934e8a28` | v4〜v7 の 0013 と同じ内容（統合候補へ当て直し） |
| 0014 | `7041303431f42bb553460e292586f005076af884da1e108cb37424f2abe07a06` | 地図のガイドの修正（v1 の局所修正 `a997a756` の cherry-pick） |
| 0015 | `3131a6e2f30be5206e5c0b428a62979c9a7a88da9d00048b55ce63cd10b43b2f` | **この回**：記録を読めないことを空の記録と言わない（観戦）、④ の未確定の状態を分ける |

ファイル名は `ls` のとおり（`0001-…patch` 〜 `0015-…patch`）。

## テスト（tree `66916259…`、鍵の生成・導出・取り込み・署名を止める preload の下で）

すべて `node --import nokeys.mjs` で実行した。この preload は、WebCrypto と `node:crypto` の鍵の生成・導出・秘密鍵の取り込み・署名を止めて記録する（`INTEGRATION.ja.md` §0g.5）。止まった呼び出しは 0 件。

| 対象 | 結果 |
|---|---|
| 単体 44 本：⑦ の 10 本（73 件。新しい spectate 3 件と sendstates 2 件を含む）、ほかの 34 本（web-frontier の画面・HUD・地図・征服・練習など、i18n、lang、citizens-page-lang、errors） | 510/510（英語の 1 文を直したあと、影響する wave3-hud・sendstates・lang を再実行） |
| 画面 `ws07-spectate`（英語、スマホ 390・PC 1440、固定データのサーバーで `/h/events` を 503 か接続リセットにする） | 6/6 |
| 画面 `ws07-s1`、`ws07-s1-card` | 8/8、6/6 |

**鍵を使うため実行しなかったもの**：`web-frontier-s1`（1 件が固定シードの鍵で署名する）、`web-frontier-live`、`web-frontier-marches`、`web-frontier-people`、`web-frontier-relay`、`web-frontier-chainio`、`web-frontier-opening-world`、`citizens-seatfix2-chain`、`npm test` 全体、M1 画面、`ws07-s1-page`、`ws07-s1-pure`。guard の下では、鍵に届いた時点で失敗する。
