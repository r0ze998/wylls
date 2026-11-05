# 05 試験結果と測定

実行日 2026-10-30、この作業機（Linux）。ログは [results/](results/)。

実行の種類:
- **ホスト**: `ext-kernel` を Rust 1.89.0 で `cargo test --locked`。コア資源の増減は本物の規則カーネル（`permutation-rules`）を通す。**Solana のランタイム（署名検証・口座の権限・CU）は使っていない。**
- **既存の検証器**: 基準 commit の `frontier-node/crates/verify` を一時 worktree（`git worktree add --detach … 4cd901de`、作業後に削除）で Rust 1.95.0 によりビルドし、記録済みの fixture（`fixtures/verify/land-program.json`）に対して実行。

## 1. ext-kernel（`results/ext-kernel-tests.log`）

`cargo fmt --check`、`cargo clippy --all-targets -D warnings`、`cargo test --locked`: **18 件すべて通過、失敗 0**。

| ファイル | 件数 | 内容 |
|---|---|---|
| `tests/flow.rs` | 3 | `f01` 必須の実証（A 公開→B 確認→B の許可だけで呼出し→第三者 PASS）、`f02` 決定性、`f03` 保存則 |
| `tests/refusals.rs` | 11 | `r01`–`r11`（[03](03-prototype.ja.md) §3） |
| `tests/verifier.rs` | 4 | `v01`–`v04`（偽造は FAIL、未知は UNVERIFIABLE、FAIL が優先） |

**開発中の失敗（記録）。** 最初の実行で `v02` と `v03` が失敗した。どちらも試験の作り方の誤りで、検証器の誤りではなかった:
- `v02`：最初の記録を消すと、鎖の検査より先に seq の検査が `SeqReplay` で FAIL する（期待を `ChainBreak` と書いていた）。期待を `SeqReplay` に直し、鎖の分岐は `prev_receipt` を書き換える別の例で `ChainBreak` を確かめた。
- `v03`：新しい語彙の例で、記録の id だけを付け替え、後の状態の id を付け替えていなかったため `UnexplainedWrite` で FAIL した。後の状態も付け替えて UNVERIFIABLE を確かめた。

## 2. 大きさ（`results/sizes.txt`、ホスト）

| 対象 | 値 |
|---|---|
| 「見張りの誓い」manifest | 438 B、id `67e2e82e3ff03e72ca18b2883dbcb4db226f08e06bcedc761694c1e033bd7ecb` |
| 同 v2 | 440 B、id `b0fb1e6e0894ad9d18aa7dc55f412833cc980f35d0a93d90f82bb00840b9b78e` |
| 「木の奉納」manifest | 172 B、id `8570a292b5977792607c4f2f2a27452b13f64773d474511270ba1e9576147cc1` |
| 利用者ごとの状態（口座にした場合） | 240 B、rent 免除 2,561,280 lamports（計算値: (128＋240)×6,960） |
| 1,024 B の manifest 口座（ヘッダ 64 B） | rent 免除 8,463,360 lamports（計算値） |

## 3. 既存の検証器: 知らないタグの命令（[patches/0001](patches/0001-verify-unknown-instruction-is-unverifiable.patch)）

記録済みの land fixture の、最初の成功した Frontier 取引に、**v2 にないタグ 0xD4 の Frontier 命令（口座なし）を 1 つ足した**入力で検証した。

| 検証器 | 結果 | ログ |
|---|---|---|
| 基準 commit のまま | **PASS**（V9 の情報の警告だけ） | `results/verify-before.log` |
| パッチ 0001 を当てた後 | **UNVERIFIABLE**（V2 `MissingData`: 知らないタグ） | `results/verify-after.log` |

パッチ後に既存の検証器の試験も実行し、すべて通過した: lib 12、`camp_clear` 3、`fixtures` 9、`tamper` 58、`unit` 8、追加の `unknown_ix` 2（計 92）。`record` 試験（localnet と SBF の `.so` が要る）は実行していない。パッチは基準 commit に `git apply --check` で当たることを確認した。

**副次の観察。** 命令を足すと取引の message の byte 列が変わるが、署名は元のままなのに検証器は FAIL にしなかった。既存の検証器は archive の取引の署名を再検査しない設計である（`frontier-node/crates/verify/src/tamper.rs` 179–181 行の注記「the verifier reads what the archive says the chain accepted」）。したがって拡張の receipt の検証も、archive の真正性は既存の検証器と同じく RPC・索引の信頼に依存する（[04](04-safety.ja.md)）。

## 4. 実行していないこと

- SBF ビルド、LiteSVM、`solana-test-validator`、CU の測定（[00](00-context.ja.md) §4）。
- 解釈器を Frontier プログラムに組み込むこと（[patches/0002](patches/0002-core-extension-instructions.md) は設計案）。
- ④⑥②⑨⑩の成果物との照合（コンテナ外で読めない。[06](06-adoption.ja.md) §3）。
- 第三者の拡張コードの取得・実行（していない。例はすべて試験内のデータ）。
- devnet・mainnet、実資金、外部 API の課金、鍵の設定（禁止事項）。

## 5. r3 の追加検証（2026-10-30）

すべてホスト上の試験と、一時 worktree での既存の検証器の実行。オンチェーンの保証との区別は [08](08-host-vs-onchain.ja.md)。

### ext-kernel（`results/ext-kernel-tests.log`）: 33 件すべて通過、clippy `-D warnings` 通過

| ファイル | 件数 | 内容 |
|---|---|---|
| `tests/exit.rs` | 6 | 出口の条件、一度だけの返却、行き先、5 手の全 16,807 通り（出口 578 回・fulfil 794 回を含む）で保存則・利用者だけでの全量回収・検証 PASS |
| `tests/buffer.rs` | 7 | 分割書込み（未完成、欠落、120 通りの順序、重複、食い違い、違う内容、不正な manifest、他人、範囲外）。登録前は実行できない |
| `tests/never_pass.rs` | 2 | 2 つの正直な履歴に 1,254 個の改変（変化のない 3 個は数えない）: H1 FAIL 610・UNVERIFIABLE 15、H2 FAIL 611・UNVERIFIABLE 15、PASS 0。知らない・欠けたものは UNVERIFIABLE |
| 既存（flow 3、refusals 11、verifier 4） | 18 | `r06` の期待を新しい出口の規則に合わせた（`NotStopped`→`ExitNotOpen`、再開後の fulfil は `InstanceClosed`） |

**検証で見つかり、直したもの（試作の欠陥）:**
1. **預かりが取り出せなくなる穴。** r2 の出口は「停止中」だけで開いたため、利用者の Grant が期限切れ・取消・回数切れになったり、コアの版が変わったりすると、拡張が Active のまま fulfil も出口も使えず預かりが残った。出口の条件を 3 つにし、コア側と検証器で同じ関数を使うようにした。
2. **返却後の不整合。** r2 では停止中に返却し再開すると、manifest の欄（誓いの量）が残ったまま預かりが 0 になり、その利用者は二度と誓えなかった。返却で instance を閉じるようにした。
3. **Grant の更新が検証されていなかった。** 改変の網羅で「Grant の更新を証拠から消しても PASS」になった。Grant の更新の位置（`grant_log`）と最終状態（`grants_after`）を検証器に渡し、照合するようにした。
4. **欠けたデータを偽造と判定していた。** manifest が欠けた履歴で、Grant の最終状態の照合が FAIL を出していた（再実行できなかったので消費が合わない）。追えなかった鎖の Grant は照合しない（UNVERIFIABLE のまま）ようにした。

**開発中の試験側の誤り（記録）:** 改変の網羅で、Grant の更新を後ろへずらす改変が H1（停止による出口）では結果を変えず PASS になった。どちらの順序も規則上正しい履歴なので、H2（Grant の取消による出口）を加え、変化のない改変は数えないようにした。`v03` の語彙の例で Grant の鍵を付け替えていなかった。

### 既存の再生検証器（`results/verify-before-r3.log`、`results/verify-after-r3.log`）

| 入力 | パッチ前 | パッチ後 |
|---|---|---|
| 知らないタグの命令 | PASS | UNVERIFIABLE（0001） |
| CPI で呼ばれた Frontier（135 取引を 1 つずつ、ログは `invoke [2]`） | tx#0 で PASS（V2 の警告のみ） | 135 件すべて非 PASS（0001） |
| Holding の post-state を 1 つ落とす（8 個を 1 つずつ） | tx#88 で PASS | 8 件すべて非 PASS（0003） |
| post-state のない archive | V7 は何も言わない（V11 が UNVERIFIABLE） | V7 も `MissingData`（0003） |

パッチ後の既存の試験: lib 12、camp_clear 3、fixtures 9、tamper 58、unit 8 と追加の unknown_ix 3、missing_state 2、計 95 件通過。

**開発中に見つかった範囲の不足（記録）:** パッチ 0003 の最初の版（前の状態が無いときだけ報告）は、間の書込の post-state を落とす場合（tx#90）を見逃し、唯一の post-state を落とす場合（tx#89）は Holding と認識できなかった。「書込可の既知の Holding に post-state が無い」検査と、最終状態からの Holding の認識を足した。

## 6. r4 の追加検証（2026-10-31、継続世界）

ext-kernel: **43 件すべて通過**、clippy `-D warnings` 通過（`results/ext-kernel-tests.log`）。追加は `tests/continuity.rs` 6 件、`tests/long_run.rs` 4 件。内容と結果の表は [09](09-continuing-world.ja.md) §3。

**検証で見つかり、直したもの:** 再送の判定順（[09](09-continuing-world.ja.md) E5）。Grant の回数が尽きた後に同じ呼出しを再送すると `GrantCalls` が返り、完了済みの判別ができなかった。古い seq を最初に判定するようにした。

**開発中の試験側の誤り（記録）:** 長期運用の試験で、例の manifest の数の上限（1,000）に 1,001 回目で達し失敗した。これは上限の性質そのもの（`g02` で扱う）なので、長期運用の試験は上限を大きくした manifest で行った。`cargo fmt` が行を折り返した後の文字列置換が当たらず、一度は上限の変更が反映されていなかった（実行時の状態を表示して気づいた）。

既存の再生検証器は r4 で再実行していない（パッチ 0001・0003 は変更なし）。
