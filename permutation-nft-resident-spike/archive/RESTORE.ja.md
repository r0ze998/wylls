# 保存パッケージと復元手順

この試作は `permutation-nft-resident-spike/` ディレクトリ **そのもの**が保存パッケージです。依存パッケージは無く（Node 20 以上の標準モジュールのみ）、ネットワークも鍵も要りません。

## 1. 中身

| 場所 | 内容 |
|---|---|
| `src/` | 試作本体（Core 資産の復号と判定、模擬チェーン、住民 registry、ログインと資格情報、世界、入場デスク、gateway、HTTP） |
| `test/` | 必須テスト（34 件、`node --test`） |
| `demo/run-loop.mjs` | 一巡のローカルデモ（A 取得 → waitlist → 公開切替 → A ログイン・操作 → A→B 譲渡 → B 同じ住民でログイン → A 拒否） |
| `docs/` | 接続契約（CONTRACT）、データ対応表（DATA-MAP）、方式比較（METHODS）、④ への提案（INTEGRATION-04）、未決定（UNDECIDED）、食い違い（DISCREPANCIES） |
| `patches/` | 共有コード向けの独立パッチ 5 本（本ブランチでは**適用していない**） |
| `archive/MANIFEST.sha256` | 全ファイルの完全 SHA-256（このマニフェスト自身を除く） |

## 2. 復元と検証

```sh
# 1. 取り出す（git から、または tar から）
git clone <repo> && cd wylls && git checkout <このコミットの SHA>
#    または: tar -xzf permutation-nft-resident-spike-<sha>.tar.gz

# 2. 完全性を確かめる（全ファイルの SHA-256 が一致し、未記載のファイルが無いこと）
cd permutation-nft-resident-spike
node archive/manifest.mjs verify          # "N files verified" で終了コード 0
#    sha256sum でも同じ: sha256sum -c archive/MANIFEST.sha256

# 3. 動かす
node --test test/*.test.mjs               # 34 件
node demo/run-loop.mjs --out .local/nft-resident-demo/transcript.json
node src/http.mjs                          # （任意）接続面を 127.0.0.1 で立てる場合は test/http.test.mjs の使い方を参照

# 4. 共有コードへの提案を見る（適用はしない）
for p in patches/*.patch; do git -C .. apply --check -p1 "$p" && echo "applies: $p"; done
```

マニフェストを書き直すのは `node archive/manifest.mjs write`。書き直したら、その出力に出る「manifest sha256」を引き渡しの記録（最終報告・コミットメッセージ）に写す。

## 3. 境界

ここにあるものは全て**模擬**（ローカル、テスト値、価値の無い鍵）。実チェーン・実資金・公開発行・新しい鍵の設定は含まない（CONTRACT.ja.md §8、UNDECIDED.ja.md）。
