# Original HOST の境界ルートと実地図入力

## 実装した範囲

既存ゲームの `FrontierMap` と境界ルートカードを接続する。選択済みの実在を観測した original HOST を保持したまま、地図上の終点に隣接するマスをタップすると、canonical direction が一歩だけ追加される。カードの六方向・Undo・Reset と同じ draft を使う。Enter キーも同じ入口で処理する。

元のキャンバスに紫の破線で geometry-only の経路と次の候補マスを描く。元のリング 128 の外側も同じ地理座標で表示するが、地形・開放・通行可能性・費用・到着時刻を推定しない。到着候補の入力前でも形を表示する。通常の進軍リボンとは別の描画レイヤーで、到着表示は付けない。

タップは host/keep の立体ヒット領域や通常の進軍処理より先に扱う。終点の連打は何もしない。遠いマス・不正な world/key/tile・32 歩超・5 番目の州は拒否する。ズームが遠いときは拡大だけを行い、選択 HOST は変えない。pointer-down と pointer-up の間に Close、再度 Open、編集、source/clock の変更が起きた場合は古い押下を破棄する。終了後の通常マップ操作は従来の経路へ戻る。

## 座標と状態

- world、56-byte host reference、province key、wide tile 座標は canonical 文字列のまま保持する。unsafe Number 入力は拒否する。
- 描画へ変換するのはリング 128 以内と検証した original 出発点と、その出発点から最大 33 歩の差分だけ。任意の i64 wide 座標を Number に狭めない。
- 現在の選択、観測した HOST、所有者、session、接続元、season、clock の既存照合を描画取得・タップ直前にも行う。失効すると draft と overlay を消す。
- 元の `FS.selected`、`provinces`、`holdings`、`compose`、`marches`、`book`、session を書き換えない。map overlay は入力中のローカル表示のみ。

## 未実装・未検証

これは実際の元ゲーム地図で使えるルート編集であって、出発を実行するゲーム機能ではない。Seal、Send、署名、鍵作成、トランザクション、RPC、公開 dispatch は一切追加していない。各 readiness flag は引き続き false。wide inventory 選択や、別の province-only wide inspection chart へのプレイ接続も追加しない。任意の遠方 wide origin の操作は対象外。

後続の実ブラウザ検証では、読み取り専用 localhost の元ゲーム画面で公開 fixture と synthetic local state を使用した。デスクトップのクリックとスマホのタップで、リング129への入力・Undo・Reset・再表示・失効を確認した。カードを開いた際のカメラ復帰、スマホの通知と操作欄による遮蔽、ミニマップの未収録リング参照を修正した。詳細は [ブラウザ検証記録](../../integration/CODEX-ORIGINAL-BOUNDARY-BROWSER-20261109.md)。live chain・CI・deploy、および出発トランザクションは実行していない。

## 限定検証の手順

import graph と呼出し先を静的に確認してから、リポジトリルートで次の exact file のみ実行する。既存 fixture を再生成しない。

```sh
node --import ./scripts/ci/no-keys-guard.mjs \
  --import ./permutation-gateway/screens/codex/no-key-node.mjs \
  --test ./permutation-gateway/test/web-frontier-expedition-map.test.mjs
```

既存 composer 回帰の確認は同じ二つの preload で `permutation-gateway/test/web-frontier-expedition-compose.test.mjs` を exact 指定する。全 suite は実行しない。ブラウザ側の限定起動と検証は上記の別記録を参照。

2026-11-09 の限定結果: 新規 map テスト 16/16、既存 composer テスト 15/15 が両方の no-key preload 下で成功。`app.mjs` の `node --check` と変更対象の `git diff --check` も成功。新規テストには実際の canvas bind/tap/Enter、連打、Close/再 Open/取消/編集/clock 変更をまたぐ押下、六つの境界角、2^53 超の座標保持、候補枠の pixel 中心、controller 接続、camera 保持、追加英訳を含む。実ブラウザや live gameplay の成功を示す結果ではない。
