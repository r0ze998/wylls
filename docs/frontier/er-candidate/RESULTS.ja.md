# 結果：mock・ローカル・公開 devnet（⑲、候補）

2026-10-31。コードは枝 `claude/ecstatic-cannon-d0jfc4`（未 push）。完全な SHA は [PACKAGE.ja.md](PACKAGE.ja.md) にあります。**三つの層の結果を混ぜないでください。** mock の合格は、MagicBlock の挙動を示しません。ローカルの合格は、公開ネットワークの挙動を示しません。

## 1. mock（モデル、依存なし）

`frontier-er`：`cargo test --offline`（Rust 1.89.0）。すべて合格。

| 試験 | 件数 | 何を確かめるか |
|---|---|---|
| `src/*`（単体） | 5 | SHA-256 の FIPS ベクタ。二重送信が一度しか効かないこと。`(seq, head)` の compare-and-set。head が書込みの再生と一致すること。署名の状態から「着地していない」と言える条件 |
| `tests/lifecycle.rs` | 15 | 一巡。Delegate の応答消失。`confirmed` では動かない。CommitState と Finalize の間の停止。commit の応答消失と再送。ER の停止と脱出（失った書込みが Behind になる）。検証者が生きているときの解除要求。RPC の切替（遅れたレプリカ、別の識別子）。再起動後の再送。両方の層への二重送信。live と committed の区別。矛盾での停止。commit の上限。停止中の取り残し。ストレージを消した ER（ErRegressed、Orphaned） |
| `tests/continuing.rs` | 4 | 10 戦期（1440 bell）・多数セッションで一本の鎖が続く（各セッションの commit は 9 回以下、口座の大きさは一定）。終了予約の直後の keeper 再起動。検証者の交代。セッション中の戦期境界で何も変わらない |

## 2. ローカル（実物のソフト、ローカルだけ）

### 2.1 LiteSVM＋実物の委任プログラム

`frontier-er/svm-tests`：`DLP_SO=<dump> cargo test`（Rust 1.95.0、litesvm 0.16.0）。板のプログラムは SBPF v2 で build しました（cargo-build-sbf 3.1.9、`.so` の sha256 は PACKAGE を参照）。

| 委任プログラムのバイナリ | sha256 | 結果 |
|---|---|---|
| devnet から読取り（`getAccountInfo`、送信なし） | `1bc71771d324fa6c4bbf06651a9065ac6686d63e5b37779e8170e9dc8627b00f` | 合格 |
| mainnet から読取り（同上） | `8484348416d92c604dcb23568bdf5fa7314188bfb32ab9f559f7b2099a58812e` | 合格 |
| npm `@magicblock-labs/ephemeral-validator` 1.1.1 同梱 | `13df9e61e48dc002c9a46277ec41953938bbaf02cdd3ed9b0f9bc9d96375a2ba` | 合格 |

確かめたこと：

- base での compare-and-set（Duplicate `0x5`、Stale `0x4`）。
- authority だけが委任できる。
- 委任中は base の書込みを拒否する（`0x8`）。
- 委任中の base の内容は委任前と同じ。
- 二重の委任は拒否される。
- 要求のないロールバックは拒否される。
- authority 以外の解除要求は拒否される。
- 期限前（9,000−10 slot）のロールバックは拒否される。
- 期限後のロールバックで、所有者が戻り、内容と印が付き、委任記録・メタデータ・要求の PDA が閉じる。
- その後、書込みが再開し、再委任もできる。

3 つのバイナリの hash が違う理由は確かめていません（中身の版の差か、ダンプの余白の差か）。

### 2.2 ローカルの base＋ER の一巡

- **スクリプト：** `frontier-er/svm-tests/e2e-local.sh`。
- **構成：** base は Agave 4.2.2 の `solana-test-validator`。ER は ephemeral-validator 1.1.1 で、識別子は `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`。
- **記録：** 2 回続けて同じ結果（[results/local-e2e-run2.jsonl](results/local-e2e-run2.jsonl)、[results/local-e2e-run3.jsonl](results/local-e2e-run3.jsonl)）。時間はローカルの一例で、性能の主張ではありません。

| 段階 | 結果（run3） |
|---|---|
| base で Init と書込み | 書込み 1 件 約 460 ms（`confirmed` まで） |
| 委任 | ER が委任を知るまで 1〜102 ms。調停器の判断は Er |
| 委任中の base の書込み | 拒否 |
| ER の書込み 5 件 | 157 ms（初回、複製を含む）、その後 2〜3 ms |
| 同じ要求の再送 | 同じ blockhash の窓内：「already processed」。新しい blockhash：`0x5` Duplicate |
| commit | 約 0.4 s で base に反映（seq 6）。所有者は DLP のまま |
| 終了を予約した後の ER の書込み | `0x8` で拒否 |
| 解除 | 約 0.4 s で base の所有者が戻る（seq 9） |
| base で書込みを再開 | 360 ms、seq 10 |
| 再委任と、base の確定版に積んだ書込み | `0x4` Stale で拒否（live は ER の seq 13） |
| ER を停止 | 調停器は Hold（ErUnreachable）。base の書込みは `0x8` で拒否 |
| 同じストレージで ER を再開 | live 13 が残る。解除して base seq 13 |
| 再委任し、3 件書き、ER のストレージを消して再開 | ER は seq 13 を複製し直し、14〜16 が消えた。調停器は `Stop(ErRegressed { seen: 16, now: 13 })` |

### 2.3 履歴の取得（ローカル）

- **スクリプト：** `frontier-er/svm-tests/probe-history.sh`。
- **記録：** [results/local-history-probe.jsonl](results/local-history-probe.jsonl)。

| 問い | 結果 |
|---|---|
| base：所有プログラムのアドレスの署名 | 5 件。うち 1 件は委任プログラムの解除（**transaction version 1**）。`maxSupportedTransactionVersion: 0` で -32015 |
| base：板のアドレスの署名 | 6 件。commit の finalize（v1）は、こちらにしか現れない |
| ER：プログラム・板のアドレスの署名 | 13 件・15 件。`getTransaction` は取れた |
| findex RpcPoll（実物、opt-in の試験 `rpc_poll_against_a_live_node`） | `Rpc { code: -32015 … }` で失敗。何度 pull しても同じ（[results/local-findex-live.txt](results/local-findex-live.txt)） |

### 2.4 findex（公開 RPC 向け、ローカルの試験）

`frontier-node`：`cargo test --locked --workspace` は exit 0、失敗 0。追加した試験は次の 3 つです。

| 試験 | 結果 |
|---|---|
| `rpc_poll_refuses_a_history_gap` | 修正前は失敗し（欠落を黙って保存）、修正後は合格 |
| `provenance::tests::only_a_header_the_records_made_is_the_post_state` | 合格 |
| `rpc_poll_against_a_live_node` | opt-in。CI では何もしない |

### 2.5 ローカル環境で必要だったこと（そのまま事実として）

- **Agave 3.1.9 の base では commit が届かない。** MagicBlock 1.1.1 の committor が送る v1 取引を、3.1.9 の test-validator は解釈できませんでした（"failed to deserialize VersionedTransaction"）。MagicBlock 1.1.1 自身の CI は Agave v4.2.2 です。
- **ファイル記述子の上限。** ER は起動時に、ファイル記述子の上限を 1,000,000 に上げられないと終了します。このコンテナの上限は 20,000 で、上げられません。そこで、上げる要求を実際の上限に丸めて成功扱いにする `LD_PRELOAD` の小さな shim（scratchpad に置いた。repo には入れていない）を使いました。実際の上限は変わりません。
- **起動順。** base の slot 1 の時点で ER を起動すると、手数料用 vault の準備に失敗して ER が終了しました。スクリプトは、委任プログラムが実行可能になり、base の finalized slot が 5 以上になるまで待ちます。
- **範囲外のポート。** ER は `0.0.0.0:9000` に計測用サーバを開きます（41000〜41999 の範囲外。CLI では変えられませんでした）。

## 3. 公開 devnet：未実行

公開 devnet への配備・送信は、一度もしていません。必要なもの（新しい鍵、devnet の SOL、プログラムの配備）は、今回禁止されているか、承認がありません。承認を求める内容は [OPERATIONS.ja.md](OPERATIONS.ja.md) §3 にあります。公開ネットワークにしたのは、読取りだけです（調査のための `getHealth`、エンドポイントの識別子、委任プログラムのバイナリの読取り）。
