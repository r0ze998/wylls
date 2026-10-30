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
