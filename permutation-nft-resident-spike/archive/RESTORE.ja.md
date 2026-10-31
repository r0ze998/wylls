# 保存パッケージと復元手順（v0.7）

この試作は `permutation-nft-resident-spike/` ディレクトリ**そのもの**が保存パッケージ。依存パッケージは無く（Node 20 以上の標準モジュールのみ）、ネットワークも鍵も要らない。**v0.7 は v0.6 以前を置き換える**。旧版の tar.gz（v0.1 `e230cee4…`、v0.2 `b0b2343f…`、v0.3 `46c9275b…`、v0.4 `0a035c1b…`、v0.5 `520216e4…`、v0.6 は v0.6 報告に記載）は使わない。

## 1. 版の記録

| 版 | コミット | tree（全体） | tree（`permutation-nft-resident-spike/` 配下） | MANIFEST.sha256 の SHA-256 | 状態 |
|---|---|---|---|---|---|
| v0.1 | `7fc6bd75ef207478cdc1c8df39bdcad6dc426cb4` | `7918ef47526b0b666e782ed16ee1619af948f05e` | `c691485033113e816bf2e0ad7aad7f278b8b2545` | `9c5e45b0685356a63a1c1fac189bbc2014de632131371d8bd703a1caae98212b` | 旧版（置き換え済み） |
| v0.2 | `413e972089e7403c4f95ede2a3824b5504cdc770` | `c35a455bd64dae9faf2a17e9c460b41ae63adbdb` | `5906ce3796a08e411bf4774ab29357778e2f69bb` | `6bbb226bd0bc3d33cef1b4bd0f4ef58a26965c861e0667f8c8539b77583331ed` | 旧版（置き換え済み） |
| v0.3 | `bd712396fe8f31f56d2f28bcea1c8ceb6ecab869` | `309d2f5883d93f873172b0ad1836bc043665f288` | `f3aa15107334ce99c88f000712562569b9dfd834` | `3ad8947b135561b8e34ceff6fec51188b59284a561d75fffbeae470f4c531fb2` | 旧版（置き換え済み） |
| v0.4 | `436ae472ee88a9d6c8882852cd9ffc6b590cb1b1` | `b39b11ae52aa099157152208482b226ffa97a5cc` | `d517473a803e0c6157ddf1621efaa2f6bad69492` | `e8d17b623b2669dbb33d77267cff611eb9ee13a54cd02490360514c0c1f0fe02` | 旧版（置き換え済み） |
| v0.5 | `c9d9edf37335bf974b49c32d1f269f4dde4d4eac` | `c5e7c9fbd58d136b4492d17bdfb34a8b7cd425f1` | `458bd52a34c6662c386b37ad3ab56bf975529aac` | `96dbb512cd0f75a825b5f087db6dc661cb8a13a76ca87d368da9d9c20a3d4d09` | 旧版（置き換え済み） |
| v0.6 | `4cf01022`（完全 SHA と tree は `git rev-parse 4cf01022 4cf01022^{tree} 4cf01022:permutation-nft-resident-spike` で再計算） | 同左 | 同左 | v0.6 報告に記載 | 旧版（置き換え済み） |
| v0.7 | 最終報告に記載（このファイルはコミットの中にあるため、自分のコミット・tree の SHA を含められない） | 同左 | 同左 | 同左 | 現行 |

v0.7 の値は `git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`git rev-parse HEAD:permutation-nft-resident-spike`、`sha256sum archive/MANIFEST.sha256` で再計算できる。報告の値と一致すれば同じ版。

## 2. 基準（この版が満たすこと）

- `node --test test/*.test.mjs`：67 件すべて合格（Playwright が無い環境ではブラウザ試験 18 件が skip；validator・Core `.so`・プログラムのビルドが無い環境では実プログラム上の 6 件が skip；`svm-core/out` が無ければ 3 件が skip）（必須テスト項目との対応は `docs/CONTRACT.ja.md` §7、実プログラム上は `docs/LOCALNET-RESULTS.ja.md` §2）。
- `node demo/run-loop.mjs`：11 段の一巡が終了コード 0 で終わり、`demo/TRANSCRIPT.txt` と同じ段の構成になる（アドレスは実行ごとに変わる）。
- `node archive/manifest.mjs verify`：全ファイルの SHA-256 が一致し、未記載のファイルが無い。
- `patches/*.patch`：リポジトリ root で `git apply --check -p1` が通る。02 は独立作業コピーで `cargo test -p frontier-abi` 全件合格（`patches/README.ja.md`）。
- push・merge・deploy・実資金・課金・新しい鍵の設定はしていない（`docs/PUSH-AUDIT.ja.md`）。

## 3. 中身

| 場所 | 内容 |
|---|---|
| `src/` | 試作本体（Core 資産の復号と判定、模擬チェーンと模擬住民プログラム、住民 registry、ログインと資格情報、世界、入場デスク、gateway、HTTP、模擬 JSON-RPC と mint の companion server） |
| `web/` | mint 画面（Wallet Standard、テストウォレット。実 RPC モードでは PDA をページで導出） |
| `program/` | 住民プログラム（Rust、Core への CPI）。ビルド生成物 `target/` は管理外。復元後は `cargo-build-sbf` で再ビルドし、`docs/REAL-CORE-RESULTS.ja.md` の sha256 と比べる |
| `svm-core/` | LiteSVM 検証（実 Core の `.so` は `.local/programs/` に ENV-RECORD の手順で取得して置く。管理外） |
| `svm-core/out/` | 実 Core が作った口座バイトの書き出し（公開鍵のみ。`test/real-bytes.test.mjs` が読む） |
| `test/` | テスト 67 件（`node --test`；うち 18 件は Chromium、その 6 件は実プログラム上） |
| `demo/` | 一巡のローカルデモ（11 段）と記録、mint 画面の記録（`screens/` 模擬、`screens-localnet/` 実プログラム） |
| `docs/` | 接続契約（CONTRACT）、データ対応表（DATA-MAP）、方式比較（METHODS）、④ への提案（INTEGRATION-04）、未決定（UNDECIDED）、食い違い（DISCREPANCIES）、push 監査（PUSH-AUDIT）、専用売買経路（SALE-PATH）、市場互換候補（MARKET-COMPAT）、比較と推奨（COMPARISON）、実 Core 試験の可否（REAL-CORE-TEST）、実 Core 検証計画と導入物（REAL-CORE-PLAN）、信頼モデル（TRUST-MODEL）、初回 mint の一巡と承認依頼（MINT-FLOW）、既存サイトの状態（SITE-STATUS）、導入記録（ENV-RECORD）、実 Core＋LiteSVM の結果（REAL-CORE-RESULTS）、実プログラム×ページの接続結果（LOCALNET-RESULTS）、devnet の承認一覧（DEVNET-APPROVALS） |
| `patches/` | 共有コード向けの独立パッチ 5 本（本ブランチでは**適用していない**）と検証状態 |
| `archive/MANIFEST.sha256` | 全ファイルの完全 SHA-256（このマニフェスト自身を除く） |

## 4. 復元と検証

```sh
# 1. 取り出す（git から、または tar から）
git clone <repo> && cd wylls && git checkout <v0.7 のコミット SHA>
#    または: tar -xzf permutation-nft-resident-spike-<sha>.tar.gz

# 2. 完全性を確かめる
cd permutation-nft-resident-spike
node archive/manifest.mjs verify          # "N files verified"、終了コード 0
#    sha256sum でも同じ: sha256sum -c archive/MANIFEST.sha256
#    版の確認: git rev-parse HEAD HEAD^{tree} HEAD:permutation-nft-resident-spike

# 3. 動かす
node --test test/*.test.mjs
node demo/run-loop.mjs --out .local/nft-resident-demo/transcript.json
#    実 Core の検証（ENV-RECORD §1 の導入物が要る）：
#    export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
#    (cd program && cargo-build-sbf --manifest-path Cargo.toml) && (cd svm-core && cargo +1.95.0 test)
#    実プログラム上のページ試験（同じ導入物。validator は Agave に同梱）：
#    node --test test/browser.localnet.test.mjs && node demo/mint-screens.mjs --localnet

# 4. 共有コードへの提案を見る（適用はしない）
for p in patches/*.patch; do git -C .. apply --check -p1 "$p" && echo "applies: $p"; done
```

マニフェストを書き直すのは `node archive/manifest.mjs write`。書き直したら、その出力の「manifest sha256」を引き渡しの記録に写す。

## 5. 境界

ここにあるものは全て**模擬**（ローカル、テスト値、価値の無い鍵）。実チェーン・実資金・公開発行・新しい鍵の設定は含まない（`docs/CONTRACT.ja.md` §8、`docs/UNDECIDED.ja.md`）。
