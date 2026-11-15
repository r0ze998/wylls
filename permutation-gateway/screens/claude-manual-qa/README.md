# 手動QA用の読み取り専用サーバー（元のゲーム画面・鍵なしウォレット）

元のプレイヤー画面（`frontier/index.html`）を、実ウォレットを接続せずに手で操作して確認するためのローカルサーバー。
**保存済みの試験データを表示するだけで、送信は無効、ライブではない。**

## 起動（監督側）

```sh
node permutation-gateway/screens/claude-manual-qa/server.mjs --port 0
```

- `--port N`（既定 0 = 空きポート）。待ち受けは 127.0.0.1 固定で、変更する引数はない。
- `--web DIR`：配信する web ルート（既定はこのリポジトリの `permutation-server/web`）。統合先の web を読み取りで
  指す場合に使う。ファイルは読むだけで書かない。
- `--golden FILE` / `--stage NAME`：herald の記録（既定 `ws19-map-growth-s1.json` の `grown`）。
- `--clock fixed|real`：既定 `fixed`。ページの `Date` を記録の `latestUnix` に固定する（既存 screen テストの
  `page.clock.setFixedTime` と同じ値）。カウントダウンは進まない。
- 起動時に表示される `player page:` の URL を Chrome で開く。`/__qa/status` で拒否した書き込みの一覧を見られる。

## 何をしているか

- `permutation-server/web` をそのまま GET/HEAD で配信する。ディスク上のファイルは変更しない。
- `/h/*` は golden の記録をそのまま返す。記録に無い読取りは 404（作らない）。
- プレイヤー画面にだけ、配信時に同一オリジンのタグを `app.mjs` の直前へ足す:
  `screens/ws07/nokey-page.mjs` の `init`（鍵なしウォレット、WebCrypto と Worker のガード）をそのまま呼ぶ
  スクリプト、時刻固定、表示帯。CSP は既存 screen と同じ（インライン不可、worker 不可、他オリジン不可）。
- `web/session.mjs` は鍵関数を拒否に差し替えて配信する（ws07 の `SESSION_GUARD`）。関数名が変わっていたら 500 で止まる。
- 閲覧者は golden の `wallet`（公開の試験用アドレス）を名乗る。鍵は無く、`signMessage`・`signTransaction` は拒否する。
- プレイヤー画面は必ず `devWallet=off` で開く（付いていなければリダイレクト）。開発用ウォレットは鍵を作るため。

## 拒否するもの

- GET/HEAD 以外はすべて 405 `ReadOnlyFixture`（`/__qa/status` の `refusedWrites` に記録）。
- web ルートの外、ドットファイル、`seal-worker.mjs`、`Host` が `127.0.0.1:port`／`localhost:port` 以外の要求。
- サーバーは外向きの接続を開かない。環境変数・ウォレット・seed・セッションを読まない。

## 置き換えている値（記録のものではない）

- `/gw/f/quota` → `{ok:true,left:38}`、`/gw/f/prize` → 404 `NoPrizePool`、`/coop/config` → 204。
  既存 screen テストと同じ応答で、relay の実値ではない。それ以外の `/gw/*` は 404。

## ここでは確認できないこと（代わりの動作は入れていない）

- **署名・封・送信が要る操作はすべて止まる。** ゲーム内の鍵（session）が無いので、命令の送信は送信前に拒否される
  見込み。進軍は作成画面（行き先・経路・到着ターン）までで、封（Worker）と送信は不可。
- **境界ルートの準備（ring 128 の外への出発）はこの記録では出せない。** 既定の記録は 6 輪の世界で、該当する
  ホストも program version も無い。既存の screen テストはページ内の状態を合成し、読み取り専用の
  `POST /gw/f/expedition/preview` に合成の応答を返して確認している。このサーバーはどちらも行わない
  （POST は一律 405）。
- 記録に無い広域（wide）の読取りは 404 で、画面は「利用不可」を示す。
- relay・keeper・チェーンの挙動、実ウォレットの接続。
