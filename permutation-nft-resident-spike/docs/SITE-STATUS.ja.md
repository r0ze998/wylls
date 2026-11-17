# 既存サイトの状態と、ホスティング復旧に必要な作業（2026-10-31）

## 1. 確認したこと

| 項目 | 結果 | 確認方法 |
|---|---|---|
| 公開先 `https://wylls-site.vercel.app/` | **HTTP 402、`x-vercel-error: DEPLOYMENT_DISABLED`**（Vercel がデプロイを無効化している。ゲームの x402 とは無関係。原因は Vercel 側の設定か請求状態で、本環境からは判別できない） | `curl -I`（2026-10-31） |
| サイトのソース | **このリポジトリには無い**。`docs/site-proposal/README.ja.md`：「元のソースは、作業フォルダの `wylls-site/` にあります（リポジトリ管理外）」。リポジトリにあるのは文言修正案の `index.html` だけで、それが参照する `app.js`、`style.css`、`media/` は無い | `ls docs/site-proposal`、`grep` |
| 別リポジトリの有無 | このセッションが見られるリポジトリは `r0ze998/wylls` のみ。`wylls-site` という名のリポジトリは見つからない（権限外か、ローカルのみ） | `list_repos` |
| サイト担当 | リポジトリ内に記録なし。SUBMISSION.md が公開先 URL を載せているだけ | `grep` |
| Vercel プロジェクトの管理者・チーム | 本環境からは不明（Vercel への権限なし） | — |

## 2. 必要なファイル（手元に無いので挙げる）

既存サイトを直してウォレット接続〜mint 完了の画面をつなぐには、次が要る：

| ファイル | 用途 | 所在（README の記載） |
|---|---|---|
| `wylls-site/index.html` | 現行の公開ページ（`docs/site-proposal/index.html` はその文言修正版） | オーナーの作業フォルダ |
| `wylls-site/app.js` | 画面の挙動（waitlist フォームの送信先、TURN 表示、簡易モデル） | 同上 |
| `wylls-site/style.css`、`wylls-site/media/` | 見た目と映像 | 同上 |
| Vercel の設定（`vercel.json` があれば）、プロジェクト名、チーム、ドメイン設定 | 公開先の復旧 | Vercel ダッシュボード |
| waitlist フォームの送信先（`app.js` 内の endpoint）と、そこに溜まっているメール | 「別の登録フォームを挟まない」方針に合わせて**撤去または NFT 取得へ置き換える**判断の材料 | 同上 |

これらが無いまま別サイトを新設して置き換えることは、指示どおり**していない**。試作の `web/mint.html` は、既存サイトに**組み込むための部品**（`mint.mjs`・`wallet-standard.mjs` は依存なしの ES module）で、既存の `index.html` の `#waitlist` 節を置き換える形を想定している（MINT-FLOW §6）。

## 3. 復旧に必要な作業（ホスティング。本件の mint とは分けて扱う）

| # | 作業 | 誰が | 必要な権限 |
|---|---|---|---|
| H1 | Vercel ダッシュボードで該当プロジェクトの状態を確認（Deployment Protection／Pause／請求停止のいずれか）し、無効化を解除するか再デプロイする | サイト担当（Vercel の所有者） | Vercel プロジェクトの管理権限 |
| H2 | ソース `wylls-site/` を Git 管理に入れる（このリポジトリの `site/` か別リポジトリ）。現在はローカルのみで、復元できない | オーナー | リポジトリ書き込み |
| H3 | 公開先の決定：Vercel 継続、GitHub Pages、または herald に同居。devnet の mint 画面は**別途承認**（MINT-FLOW §7） | オーナー | — |
| H4 | `index.html` の文言を `docs/site-proposal` の修正案に合わせる（既存の提案） | サイト担当 | — |

## 4. 本試作が既存サイトに求める接点

- 既存の `#waitlist` 節（メール入力フォーム）を、`web/mint.html` の「接続先と費用」「ウォレット」「mint」「あなたの住民」の 4 カードに置き換える。
- サイトから `GET /mint/config`、`/mint/status`、`/mint/mine`、`/mint/derive`、`POST /rpc` に到達できること（同一オリジンか、CORS を許可した companion server。devnet では `/rpc` は公開 RPC への転送か直接呼び出し）。
- サイトは HTTPS（WebCrypto の Ed25519 と Wallet Standard は secure context が必要）。
