# 保存パッケージと復元手順（v0.2）

この試作は `permutation-nft-resident-spike/` ディレクトリ**そのもの**が保存パッケージ。依存パッケージは無く（Node 20 以上の標準モジュールのみ）、ネットワークも鍵も要らない。**v0.2 は v0.1（コミット `7fc6bd75ef207478cdc1c8df39bdcad6dc426cb4`）を置き換える**。v0.1 の tar.gz（SHA-256 `e230cee40a79e2f0fc260da4181713eac36ab57041344dae99d36ad50a0d4231`）は旧版として扱い、使わない。

## 1. 版の記録

| 版 | コミット | tree（全体） | tree（`permutation-nft-resident-spike/` 配下） | MANIFEST.sha256 の SHA-256 | 状態 |
|---|---|---|---|---|---|
| v0.1 | `7fc6bd75ef207478cdc1c8df39bdcad6dc426cb4` | `7918ef47526b0b666e782ed16ee1619af948f05e` | `c691485033113e816bf2e0ad7aad7f278b8b2545` | `9c5e45b0685356a63a1c1fac189bbc2014de632131371d8bd703a1caae98212b` | 旧版（置き換え済み） |
| v0.2 | 最終報告に記載（このファイルはコミットの中にあるため、自分のコミット・tree の SHA を含められない） | 同左 | 同左 | 同左 | 現行 |

v0.2 の値は `git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`git rev-parse HEAD:permutation-nft-resident-spike`、`sha256sum archive/MANIFEST.sha256` で再計算できる。報告の値と一致すれば同じ版。

## 2. 基準（この版が満たすこと）

- `node --test test/*.test.mjs`：38 件すべて合格（必須テスト項目との対応は `docs/CONTRACT.ja.md` §7）。
- `node demo/run-loop.mjs`：10 段の一巡が終了コード 0 で終わり、`demo/TRANSCRIPT.txt` と同じ段の構成になる（アドレスは実行ごとに変わる）。
- `node archive/manifest.mjs verify`：全ファイルの SHA-256 が一致し、未記載のファイルが無い。
- `patches/*.patch`：リポジトリ root で `git apply --check -p1` が通る。02 は独立作業コピーで `cargo test -p frontier-abi` 全件合格（`patches/README.ja.md`）。
- push・merge・deploy・実資金・課金・新しい鍵の設定はしていない（`docs/PUSH-AUDIT.ja.md`）。

## 3. 中身

| 場所 | 内容 |
|---|---|
| `src/` | 試作本体（Core 資産の復号と判定、模擬チェーンと模擬住民プログラム、住民 registry、ログインと資格情報、世界、入場デスク、gateway、HTTP） |
| `test/` | テスト 38 件（`node --test`） |
| `demo/` | 一巡のローカルデモ（10 段）と記録 |
| `docs/` | 接続契約（CONTRACT）、データ対応表（DATA-MAP）、方式比較（METHODS）、④ への提案（INTEGRATION-04）、未決定（UNDECIDED）、食い違い（DISCREPANCIES）、push 監査（PUSH-AUDIT） |
| `patches/` | 共有コード向けの独立パッチ 5 本（本ブランチでは**適用していない**）と検証状態 |
| `archive/MANIFEST.sha256` | 全ファイルの完全 SHA-256（このマニフェスト自身を除く） |

## 4. 復元と検証

```sh
# 1. 取り出す（git から、または tar から）
git clone <repo> && cd wylls && git checkout <v0.2 のコミット SHA>
#    または: tar -xzf permutation-nft-resident-spike-<sha>.tar.gz

# 2. 完全性を確かめる
cd permutation-nft-resident-spike
node archive/manifest.mjs verify          # "N files verified"、終了コード 0
#    sha256sum でも同じ: sha256sum -c archive/MANIFEST.sha256
#    版の確認: git rev-parse HEAD HEAD^{tree} HEAD:permutation-nft-resident-spike

# 3. 動かす
node --test test/*.test.mjs
node demo/run-loop.mjs --out .local/nft-resident-demo/transcript.json

# 4. 共有コードへの提案を見る（適用はしない）
for p in patches/*.patch; do git -C .. apply --check -p1 "$p" && echo "applies: $p"; done
```

マニフェストを書き直すのは `node archive/manifest.mjs write`。書き直したら、その出力の「manifest sha256」を引き渡しの記録に写す。

## 5. 境界

ここにあるものは全て**模擬**（ローカル、テスト値、価値の無い鍵）。実チェーン・実資金・公開発行・新しい鍵の設定は含まない（`docs/CONTRACT.ja.md` §8、`docs/UNDECIDED.ja.md`）。
