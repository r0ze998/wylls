# 必要な運用設定と承認依頼（⑲、候補）

2026-10-31。**配備・送信の許可ではありません。** 実際に使うには、④の登録表（命令番号・版）と、ここに挙げる判断が必要です。

## 1. 設定

| 項目 | 値・方針 | 誰が決めるか |
|---|---|---|
| 世界が信頼する検証者 | 1 つ（交代中だけ「退く検証者」を 1 つ追加で許す）。keeper の設定と、調停器の `Policy.validator`・`retiring`。プログラムには固定しない（委任時に authority が指定する） | 運用（④の登録表に載せる） |
| 委任の authority | 世界の既存の運営鍵。新しい鍵は作らない。板の住所に含まれる。Init・委任・commit・セッション終了・脱出の要求はこの鍵だけが出せる。この鍵が委任の家賃支払者になり、脱出に必要。鍵を失うと脱出できない | 運用 |
| 読取りの確定度 | 判断に使う base の読取りは `finalized`。表示は `confirmed` でもよいが、「未確定」と明示する | ④（実行器の共通方針） |
| ER の確認 | 毎回 `getIdentity`（委任記録の検証者と一致すること）と `getDelegationStatus`（ER が委任を知っていること） | keeper・herald |
| 保存する状態 | 書き手：journal（要求 ID、積んだ `(seq, head)`）。keeper・herald：ER の high-water（セッションごと） | 各実装 |
| commit の予算 | 1 セッションに 9 回まで（委任プログラムの上限は、委任された支払い口座なしで 10 回。最後の commit＋解除の分を残す） | 運用。delegated fee payer を使うなら⑰ |
| 脱出を提案するまでの待ち | 既定 750 base slot（約 5 分）。脱出を実行するのは人 | 運用 |
| 解除要求の期限 | 委任プログラムの固定値：9,000 slot（約 60 分） | MagicBlock（変えられない） |
| 板の lamports | 家賃に加えて手数料の余裕が要る。devnet の文書では 0.003 SOL/セッション＋commit 1 回ごとに 0.001 SOL を解除時に口座から引く。ローカルでは引かれたことを確認していない（未確認） | ⑰・運用 |
| findex | 履歴の欠落は止まるようになった。v1 取引には、④の対応（maxSupportedTransactionVersion）が必要 | ④ |
| ローカル試験のポート | base 41680/41681、faucet 41690、gossip 41691、動的範囲 41700〜41740、ER 41670/41671。ER は計測用に `0.0.0.0:9000` も開く | — |
| ローカル試験のソフト | Agave 4.2.2 の test-validator（base 役）、ephemeral-validator 1.1.1（npm、BSL-1.1）、Agave 3.1.9 の cargo-build-sbf（build）、Rust 1.89.0／1.95.0 | — |

## 2. ローカルで再現する手順

```sh
# 1. 板のプログラム（SBPF v2）
(cd frontier-er/program && cargo-build-sbf --arch v2)          # Agave 3.1.9 の cargo-build-sbf
# 2. mock
(cd frontier-er && cargo test --offline)
# 3. LiteSVM＋実物の委任プログラム（ダンプのパスを渡す）
(cd frontier-er/svm-tests && DLP_SO=/path/to/dlp.so cargo test)
# 4. ローカル base＋ER の一巡
AGAVE_BIN=/path/to/agave-4.2.2/bin MB_PKG=/path/to/node_modules NOFILE_SHIM=/path/to/shim.so \
  frontier-er/svm-tests/e2e-local.sh /tmp/er-work
# 5. 履歴の取得
AGAVE_BIN=… MB_PKG=… frontier-er/svm-tests/probe-history.sh /tmp/er-hist
# 6. findex
(cd frontier-node && cargo test --locked -p findex)
```

`NOFILE_SHIM` は、ファイル記述子の上限を 1,000,000 に上げられない環境でだけ使います（RESULTS §2.5）。

## 3. 公開 devnet での試験：承認を求める内容（未実行）

| 項目 | 内容 |
|---|---|
| 対象 | 板のプログラム（`frontier-er/program`）を devnet に配備する。委任 → devnet の ER（`https://devnet-as.magicblock.app`、検証者 `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`）で書込み → commit → 解除 → base で再開、を一巡する。脱出（9,000 slot の待ち）も一度通す |
| 費用 | devnet の SOL だけ（実資金なし）。概算：配備の家賃は約 1.7〜2.5 SOL（`.so` は 241,720 バイト。家賃は `solana rent` で、program data を 1 倍〜2 倍の大きさで取った場合。2 倍は 2.457 SOL）、委任・commit・解除の手数料が 0.01 SOL 未満/回。devnet の SOL は faucet で無料。有料サービスは使わない |
| 権限 | 新しい鍵が 2 つ要る：配備の支払い・upgrade authority 用と、板の authority 用。devnet 専用で、資金を移さない。**今回の指示では新しい鍵・アカウントの作成が禁止なので、承認と保管場所の指定が必要** |
| 変更する場所 | devnet 上の新しいプログラム ID だけ。repo は試験の記録だけ（`docs/frontier/er-candidate/results/devnet-*.jsonl`）。S1 のプログラム・既存の配備・main には触れない |
| 外部サービス | Solana devnet の公開 RPC と、MagicBlock の devnet ER（無料と公表、レート制限は未公表。ルーターの URL は変わりうると記載） |
| 読むだけの確認（承認不要の範囲で実施済み） | devnet ER の `getIdentity`（研究メモ）。委任プログラムのバイナリの読取り |

承認されるまで、devnet の結果は「未実行」のままにします。
