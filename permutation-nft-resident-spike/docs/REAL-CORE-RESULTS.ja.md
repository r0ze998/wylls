# 実 Core＋住民プログラムの LiteSVM 検証結果（2026-10-31、v0.6）

承認範囲（R1・R2 の MintResident／TransferResident・R7）の実施結果。**ローカルの LiteSVM 内**での検証であり、devnet・mainnet への配備は行っていない。

## 1. 使用したバイナリ・版・ハッシュ

| 物 | 版・出所 | sha256 | 大きさ |
|---|---|---|---|
| Metaplex Core プログラム（`mpl_core.so`） | mainnet 配備（program `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`、programdata `9ZC25KLUrfgSoFVgjE1rrydZBbZns58UXi8A8ZhTdGfr`、last deployed slot 455005931、読取スロット 463549898）。ELF 長はヘッダから算出 | `515541c84caa71a2f142c603fc1e2372196825003e66126d1e824dd9213ea056` | 810,288 B |
| 同、programdata buffer 全体 | 同上（末尾 padding 込み） | `51d41542456639a01820c747e72b9d3b4ca258930a5bbb7e78db0cda133dc209` | 848,320 B |
| 住民プログラム（`wylls_resident_program.so`） | 本リポジトリ `permutation-nft-resident-spike/program/`、`cargo-build-sbf` 3.1.9 ＋ platform-tools v1.52 | `95e462f39364b10ca5b2773a169a00755c64ce41e64fead97632477ac408e8bf` | 153,120 B |
| LiteSVM | 0.16.0（crates.io） | `svm-core/Cargo.lock` | — |
| `mpl-core` クレート | 0.12.1（crates.io） | 同上 | — |
| Rust | 1.95.0（テスト）／platform-tools v1.52 の rustc（SBF） | ENV-RECORD | — |

LiteSVM のプログラム ID：Core は本物の ID、住民プログラムは `sha256("wylls-resident-program id (test)")` から導いたテスト ID。鍵はすべて `sha256(ラベル)` 由来の使い捨て。

## 2. 実 Core で通った試験（`svm-core/tests/core.rs`、9 件すべて合格）

| # | 試験 | 確認したこと | 実 Core の挙動（記録） |
|---|---|---|---|
| C1 | **一括成立**：ウォレット A が `MintResident` 1 命令 | A の減少 ＝ 価格 ＋ asset の rent ＋ 住民口座の rent ＋ 署名 2 件の手数料、treasury ＝ 価格、asset は Core 所有・owner A・`update_authority = Collection(collection)`、住民口座は gen 0・tag15 = `sha256("PSF-RES" ‖ asset)[0..15]` | Core `CreateV1`（collection authority ＝ プログラム PDA の invoke_signed、Permanent Freeze frozen=true ＋ Permanent Transfer Delegate）が成功 |
| C2 | **途中失敗の全体ロールバック**：価格不一致／treasury 違い／collection 違いの 3 取引 | 3 回とも失敗。A の減少は手数料 3×2 署名分のみ。treasury 0、asset 無し、住民口座無し | 住民プログラムの `PriceChanged`（1005）・`WrongTreasury`（1006）・`WrongCollection`（1007） |
| C2b | 同じ asset への 2 回目の mint | 同一取引の再送は runtime の `AlreadyProcessed`（手数料なし）。新しい取引は `AlreadyInitialized`（1008）で支払い前に拒否 | — |
| C3〜C5 | **迂回試験**（owner の通常 `TransferV1`、owner が承認した Transfer Delegate の `TransferV1`、owner／運営による Permanent Freeze の thaw、Permanent Transfer Delegate の authority 変更、Permanent Freeze の削除、owner-managed FreezeDelegate 追加後の `TransferV1`、作成後の永続プラグイン追加） | **すべて失敗**。owner・世代は不変。その後 `TransferResident` だけが成功（owner B、gen 1） | 記録 `svm-core/out/_bypass-attempts.json`：通常 transfer ＝ `Custom(9) InvalidAuthority`（ログに `permanent_freeze_delegate.rs … Reject`）、delegate transfer ＝ `Custom(9)`、thaw ＝ `Custom(26)`「Neither the asset or any plugins have approved this operation」、authority 変更 ＝ `Custom(27)`「Plugin Manager cannot redelegate a delegated plugin without revoking first」、Permanent Freeze 削除 ＝ `Custom(9)`、作成後の永続プラグイン追加 ＝ `Custom(9)`（`permanent_transfer_delegate.rs:34:Reject`）。owner-managed の TransferDelegate／FreezeDelegate の**追加自体は成功**するが、譲渡は依然拒否 |
| P1 | **譲渡と世代更新と session 失効が同じ取引** | `TransferResident`（A 署名）後：owner B、gen 1、session 0。A が設定した session 鍵 K の op は `NotOwner`（1003） | Core `TransferV1`（Permanent Transfer Delegate の PDA 署名）が凍結中でも成功（forceApprove） |
| P2 | **relay 未観測の A→B→A** | チェーンだけで A→B→A。A の旧 session K、A の署名済み未送信 op（gen 0）、B の session K2、K2 の署名済み op：すべて拒否（`NotOwner`／`StaleGen`（1004））。ops は 0 のまま。A は gen 2 で新たに op・再委任でき、再委任後も gen 0 の op は `StaleGen` | — |
| P3 | **二重実行・再送** | 同一署名済み取引の再送 ＝ `AlreadyProcessed`（手数料なし、残高不変）。別取引での同 asset ＝ `AlreadyInitialized`。treasury への支払いは 1 回 | — |
| P4 | **譲渡と操作の競合** | 先に着いた op は成立し B が引き継ぐ（ops 1）。譲渡後に届いた A の署名済み op は `NotOwner`。B の gen 0 の op は `StaleGen` | — |
| P5 | session の規則 | 保有者以外の `SetSession` ＝ `NotOwner`、期限 30 日超 ＝ `SessionExpiry`（1010）、期限切れの session ＝ `NotOwner` | Clock sysvar を進めて確認 |

LiteSVM の取引失敗はランタイムのロールバック。C2 で「支払い・発行・紐付けがすべて戻り、手数料だけ残る」ことを残高で確認した。

## 3. 自前 registry（R7、`test/real-bytes.test.mjs`、3 件合格）

LiteSVM が書き出した**実 Core の口座バイト**（`svm-core/out/*.json`：mint 後・A→B 後・A→B→A 後の 3 場面、asset 233 B・住民口座 133 B）に対して：

- `verifyResidentAsset` が Core プログラム所有・`AssetV1`・`Collection(期待値)`・保有者を判定し、場面の保有者と一致。同じバイトを別 collection に対して照合すると `NotInCollection`。実口座は base 構造の後にプラグイン領域を持つ（233 B ＞ base 長）。
- 住民口座の tag15 ＝ `residentId(asset)`（JS 側の導出と一致）、gen ＝ 場面の世代、A→B 直後の session ＝ 0。
- registry：`observe` の保有者と `epoch`（＝チェーンの世代）が場面どおり。別インスタンス（再読込）でも同じ答え。A→B 後、A の `entitlement` は false、B は true。

**索引の情報だけで認可しない**：registry の答えは毎回 asset 口座の読取から導く。索引（`/mint/mine` の走査や将来の registry）は候補を挙げるだけ。

## 4. 失敗と未実施

| 項目 | 状態 |
|---|---|
| ELF の切り出し（v0.4 の記録） | **誤り**：末尾ゼロを削った `af40bd11…` は LiteSVM に拒否された。ヘッダから算出した `515541c8…` に訂正（ENV-RECORD） |
| mint 画面（`web/mint.mjs`）と実プログラムの接続 | **未実施**。画面の `MintResident` は模擬 RPC 向け（口座順・データは実プログラムと同じ 9 口座・`0x50 ‖ price`）。実プログラムでは `resident` が PDA（`["resident", asset]`）、`collectionAuthority`・`config` も PDA で、画面はまだサーバの `/mint/derive` に頼る。devnet 配備後に接続・検証する |
| devnet 配備・collection 作成・treasury・公開 | 未承認・未実施 |
| 実ウォレット・実機 | 未実施 |
| List／Buy（専用売買） | 今回の必須範囲外（模擬のみ） |
| `mpl-core` 0.12.1 の SBF ビルド警告（3 関数のスタック超過） | 本プログラムの経路では呼ばないが、配備前に確認（U26） |
| CU | `MintResident`・`TransferResident` の CU は未計測（LiteSVM のメタデータから取れる。次回） |
| gateway/web の ABI 生成物と既存テスト | 未実施のまま |

## 5. 変更ファイル（v0.6）

新規：`program/`（Cargo.toml、Cargo.lock、rust-toolchain.toml、src/lib.rs）、`svm-core/`（Cargo.toml、Cargo.lock、rust-toolchain.toml、tests/core.rs、out/*.json）、`test/real-bytes.test.mjs`、`docs/ENV-RECORD.ja.md`、本書。更新：README、MINT-FLOW（文言）、RESTORE、UNDECIDED、DISCREPANCIES。共有コードは無変更。

## 6. 再現

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
# 1. Core の .so（ENV-RECORD §1 #4 の手順で .local/programs/ に置き、sha256 515541c8… を確認）
# 2. ビルド（root の .cargo/config.toml により permutation-chain/target/deploy に出る → program/target/deploy へコピー）
(cd permutation-nft-resident-spike/program && cargo-build-sbf --manifest-path Cargo.toml)
# 3. 検証
(cd permutation-nft-resident-spike/svm-core && cargo +1.95.0 test -- --test-threads=1)
(cd permutation-nft-resident-spike && node --test test/real-bytes.test.mjs)
```
