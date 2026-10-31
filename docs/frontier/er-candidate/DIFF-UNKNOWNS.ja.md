# 旧版との差・未確認事項・文書とコードの食い違い（⑲）

2026-10-31。

## 1. 旧版（permutation-chain、V5）との差

旧版の devnet での記録（`docs/earlier-prototype/devnet-season-1790355636798-verification.txt`、14/14）は**旧版のもの**です。今回の候補の実績には数えません。旧版のコードは移植していません。参考にしたのは、委任・callback・脱出の命令の形と、その注意点だけです。

| 観点 | 旧版 | 今回の候補 |
|---|---|---|
| 委任対象 | 世界のチャンク 20 個と国の口座。ゲームの状態そのもの（参加費・賞金は USDC の保管口座） | 価値のない「板」1 つ。S1 の口座は委任しない |
| 期間 | シーズンに 1 回だけ委任し、最後の tick の後に決まった順で解除。脱出はシーズンの期限の後。ロールバックするとシーズンは返金で終わる | 期間に依存しない。セッションは commit の予算・交代・保守で閉じ、再委任する。脱出の後も続く |
| 一意性・二重実行 | 委任のビット、undelegation の順序の数え上げ | 板の `(seq, head)` の compare-and-set と要求 ID。状態で着地を判定する |
| 検証者の指定 | Season に記録した検証者 | authority が委任時に指定する。keeper と調停器が識別子を確認する（プログラムには固定しない。課題） |
| commit の形 | 1 つの intent に、チャンク 1 つか国 1〜3（committor の上限を devnet で実測） | 1 つの intent に板 1 つ |
| SDK | `ephemeral-rollups-sdk` 0.16.2、solana-program 4.0.0 | 同じ版（公式の native-rust の例と同じ組合せ）。最新の 0.17.3 でも、native の API は同じ |
| 委任プログラム | dlp-api 3.1.0 の判別子（26・27） | 現行の v2.0.1（api 4.0.1）。26・27 は同じ番号。ロールバックの口座の並びも同じであることを確かめた |
| 試験 | LiteSVM の stand-in と、`DLP_SO` による実物 | LiteSVM で実物 3 種。ローカルの base＋ER を一巡（旧版の記録には、ローカル ER での一巡はない） |
| 料金 | 「委任された支払い口座なしでは commit 10 回」を研究で記録 | 計画器が 9 回で区切る |

## 2. 未確認事項

| 項目 | 状態 |
|---|---|
| 公開 devnet での一巡・脱出 | 未実行（承認待ち、OPERATIONS §3） |
| 実物の ER で、RequestUndelegation の後に検証者が自分から解除するか（約 5 分ごとに見る、と文書にある） | モデルだけ。ローカルの ER では試していない |
| 実物のスタックでのロールバック（9,000 slot、ローカルで約 1 時間） | LiteSVM だけ（slot を進めた）。ローカルの ER では未実行 |
| 解除時に、板の lamports から手数料が引かれるか、いくらか | ローカルでは確かめていない（devnet の文書では 0.003＋0.001/回） |
| commit 11 回目の拒否（`0xA0000000`） | 文書と研究だけ。ローカルでは計画器が 9 回で止めるので、出していない |
| ER の時計・slot が base と同じ意味か。BLS12-381 の syscall が ER で使えるか | 未確認（S1 の口座を委任しない理由の 1 つ） |
| 公開 ER の履歴保持期間、blockhash の有効期間 | 未確認。ER 宛ての送信は、署名の状態から「着地していない」としない |
| ER の検証者が commit した内容と、ER の取引ログの再生との突き合わせ | 未実装（仕組みは `board::replay` とログ `ERB` で用意してある） |
| 委任プログラムの 3 種のバイナリ（devnet・mainnet・npm）の hash が違う理由 | 未確認。3 種とも LiteSVM の試験は通った |
| base の RPC を切り替えたとき、ER（committor）の側の挙動 | 未確認（ER の `--remotes` は固定で起動した） |
| ローカルのログに出た「VAT: failed to connect to admin RPC」の影響 | 未確認（試験はすべて通った） |
| fclient で `maxSupportedTransactionVersion` を 1 にしたとき、Agave 3.1.9 の RPC が受け付けるか | 未確認（④の判断の材料） |
| 長時間の運転（ローカル） | 未実行。長期の確認は mock の 1440 bell だけ |
| Private ER（TEE） | 対象外 |

## 3. 文書とコードの食い違い（見つけたものすべて。コードに従った）

| # | 文書 | コード | 扱い |
|---|---|---|---|
| 1 | `findex/src/index.rs` の表：`snapshot` は「その取引の後の状態」 | 公開 RPC では `Enriched` が minContextSlot で読み、「その slot 以降のどこかの状態」 | 文書を直した（7b53a87） |
| 2 | `herald/src/fold.rs:5-9`：post-state は書いた口座の「正確な内容」で、公開 RPC でも `Enriched` がそれを取ってくる | 同じファイルの `FoldCfg::exact_post`（:67-71）と `Enriched` の説明は「slot 以降の状態」 | 報告のみ（herald は④の統合範囲） |
| 3 | `findex/src/ingest.rs` の冒頭：RpcPoll は「最後に見た署名までページングする」 | 刈り込まれたノードでは、最後の署名に届かずに黙って終わり、欠落を保存していた | 直した（7b53a87） |
| 4 | `verify/src/input.rs:18`：「最終状態で、すべての鎖を終わらせる」 | 最終状態は「今の slot」で読む。Clock と口座の確定度が違い、100 件ごとに slot が違いうる。静かな終わりがないと HEAD_MISMATCH になる | 報告のみ（CONTINUING-WORLD §4） |
| 5 | `docs/earlier-prototype/INDEX.md`：V5 のコード（`permutation-rules`、`permutation-chain`、`permutation-server`、`permutation-gateway`）は枝 `codex/magicblock-playable` にある | これらの crate は、この基点のツリーにもある。`permutation-chain` はルートの workspace のメンバーで、`ephemeral-rollups-sdk` 0.16.2 を固定している | 報告のみ |
| 6 | ルートの `Cargo.toml` のコメント：LiteSVM の solana crate は「プログラムの MagicBlock SDK」と一緒に解決できない | 現行のプログラム（`permutation-frontier`）は MagicBlock SDK を使わない。SDK を使うのは旧版の `permutation-chain` | 報告のみ |
| 7 | `docs/frontier/stage1b/S1-1B-CONTRACT.md:31`、`docs/frontier/stage1d/S1-1D-CONTRACT.md:43`：Vault・Structure（Tower）の seed の座標は i16 | `frontier-abi/src/v2/addr.rs:42-52`：i32、生の key は 9 バイト | 報告のみ |
| 8 | `permutation-frontier/src/lib.rs:111-113`：S1 の命令は 0xB0〜0xBE | FastForward 0xC0 も dispatch している（`lib.rs:218`） | 報告のみ |
| 9 | `Season.BELL_SECS` は bell の長さを変えられるように見える | 600 に固定（`frontier-abi/src/presets.rs:284`）。bell のコードはこの値を読まない | 報告のみ |
| 10 | `fclient/src/rpc.rs:1-6`：公開 RPC での feed は findex の RpcPoll | keeper の実行ファイルは常に `RpcPort::localnet` を作る（`keeper/src/main.rs:164-168`）。公開 RPC で keeper を動かす経路がない | 報告のみ |
| 11 | `docs/frontier/research/onchain-mmo-patterns.md:87`：`magicblock-delegation-program-api` 3.1.0 | 現行の委任プログラムは v2.0.1（api 4.0.1）。解除要求の期限は 9,000 slot | 報告のみ（研究の記録で、日付付き） |
| 12 | （確認の結果、食い違いではない）README・SUBMISSION の MagicBlock・x402・試験用 USDC の記述（`README.md:60`、`SUBMISSION.md:117,158`） | 現行のプログラムは「no money, no MagicBlock」（`permutation-frontier/src/lib.rs:2`）。README と SUBMISSION は、どちらも「旧版の試作」と明記している | 整合している |
| 13 | `docs/RUNNING.md`：ポートは 41000〜41999 だけ | MagicBlock の ER（ローカル）は `0.0.0.0:9000` に計測用サーバを開く | 候補の手順に明記した（OPERATIONS §1） |
