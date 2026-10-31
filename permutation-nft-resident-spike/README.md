# permutation-nft-resident-spike：NFT で譲渡できる住民アカウント（隔離試作）

**状態（2026-10-31）**：ローカルの模擬のみ。公開発行・実チェーン・実資金・新しい鍵は無し。価格・発行数・販売方法・ロイヤリティは未決定（`docs/UNDECIDED.ja.md`）。依存パッケージ無し（Node 20+ の標準モジュールだけ）。

## 何を試したか

Wylls の住民アカウントを **NFT（Metaplex Core 資産）に紐付け**、

- NFT の取得＝waitlist 登録（別の先行登録・引換券を挟まない）、
- 公開前は参加待ちの資格、公開後は同じ NFT で住民へログイン、
- 保有型で売却・譲渡でき、譲渡すると住民のゲームデータと操作権が買い手へ移り、売り手は同じ住民を操作できない、

という一巡を、**変更できない住民 ID（asset 由来）と、現在操作するウォレット（現保有者）を分けた**構成で動かした。認可は名前・画像・メタデータではなく、**Core プログラム・collection・asset・現在の保有者**で判定し、ログイン時だけでなく**操作の権限を判定する時点**で保有者を読み直す。

## 動かす

```sh
cd permutation-nft-resident-spike
node --test test/*.test.mjs        # 34 tests
node demo/run-loop.mjs             # the loop, printed; transcript at .local/nft-resident-demo/transcript.json (or --out)
node archive/manifest.mjs verify   # the package's SHA-256 manifest
```

## 構成

| ファイル | 役割 |
|---|---|
| `src/core-asset.mjs` | Core `AssetV1` の Borsh 復号・符号化と、住民資産の判定（`WrongProgram` / `NotAnAsset` / `NotInCollection` / `Malformed` / `NoAccount`）。**実物の判定ロジック** |
| `src/mock-chain.mjs` | 模擬チェーン：Core 形の口座（実物同形の bytes）、スロットと履歴（遅延 RPC の模擬）、署名検証と実行順、**模擬の住民プログラム**（`SetSession` の設定者を記録し、prologue で「現保有者 or 現保有者が設定した session」だけ通す） |
| `src/registry.mjs` | 住民 registry：チェーン読取からだけ記録を作る。通知は「読み直せ」の合図。`epoch`（確認済み保有者変更の回数）。waitlist はその投影 |
| `src/auth.mjs` | SIWS 形のログイン、ログイン token・MCP capability・AI 委任の記録（全て保有者＋epoch に束縛）。`authorize` は毎回保有者を読み直す |
| `src/world.mjs` | 最小の村：住民 ID 鍵。輸送中の隊商・加工中の注文・預かり物・債務。ウォレット鍵の未受取報酬と費用確認待ち |
| `src/entry.mjs` | 支払い → 発行 → 資格の 3 記録。冪等・結果不明・送信後クラッシュの復旧 |
| `src/gateway.mjs` | relay 側の操作入口：認可時と送信直前の保有者読取、費用確認、署名、送信 |
| `src/http.mjs` | 契約の HTTP 面（loopback） |
| `docs/` | 接続契約・データ対応表・方式比較・④ への提案・未決定・食い違い |
| `patches/` | 共有コード向けの独立パッチ（未適用） |
| `archive/` | SHA-256 マニフェストと復元手順 |

## 模擬と実物の境界（要約。詳細は `docs/CONTRACT.ja.md` §8）

- **実物と同じ**：Core の口座レイアウトの判定（プログラム ID、`AssetV1`、`update_authority = Collection`、`owner`）、ed25519 署名検証、SIWS 文面の検証規則、冪等と再起動の規則。
- **模擬**：チェーン（スロット・実行順・手数料無し）、Core のプラグイン領域（凍結は口座フラグで模擬）、RPC の遅延・欠落、決済レール、発行鍵（relay が持つテスト鍵）、世界。
- **していないこと**：実チェーンでの発行・譲渡、Frontier プログラムの変更（提案とレイアウトパッチのみ、`cargo check` は通した）、x402 facilitator との接続、ウォレット拡張での署名。

## 必須テストとの対応

`docs/CONTRACT.ja.md` §7 の表を参照。偽物・同名別 collection・古い保有情報・他人の署名／再送・二重押し・支払い結果不明・通知重複／譲渡と操作の競合・譲渡後の旧 session・MCP・AI／署名済み操作の遅延到着／再起動・RPC 遅延欠落・住民 ID 重複／複数 NFT・買い戻し、の各項目に対応するテストがある。
