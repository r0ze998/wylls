# 07 文書とコードの食い違い（見つけたもの）

依頼の指示どおり、食い違いではコードの書き方に従った。共有コアの文書もコードも直していない。

| # | 文書の記述 | コードの事実 | ⑪の扱い |
|---|---|---|---|
| 1 | `README.md` 15 行「A verifier can replay a season's transaction log」 | 再生検証器は、知らないタグの Frontier 命令を各検査で `continue` して飛ばし、成功した取引に未知タグの命令を足した入力を **PASS** にした（実行で確認、[05](05-results.ja.md) §3）。トップレベルで Frontier を呼ばない取引は V2 の警告だけ（`checks/v2_program.rs` 66–79 行） | 試作の検証器は未知を UNVERIFIABLE にした。既存の検証器への修正案は [patches/0001](patches/0001-verify-unknown-instruction-is-unverifiable.patch) |
| 2 | `frontier-abi/src/v2/tags.rs` 冒頭「v1's [`crate::tags::Ix`] keeps its 50 variants」 | `frontier-abi/src/tags.rs` の v1 の `Ix` は 51 個（同ファイルの注記「Every M1 instruction (51, the test-only ResolveClash included)」と試験 `assert_eq!(Ix::ALL.len(), 51)`） | 51 を正とした（⑪のコードは v1 の数に依存しない） |
| 3 | 依頼文「現在の方針は『新しい世界効果はコア側が追加する』」 | 決定ログ `docs/design/redesign/99-decisions.ja.md` にこの方針の行はない（検索した結果）。コードの事実としては、Frontier の効果はすべてコアの 74 命令で、外部から足す入口はない（③が CPI で確認） | 依頼文の方針をコードの事実と一致するものとして扱った。決定ログへの記録はオーナーの判断（[06](06-adoption.ja.md) D1） |
| 4 | 検証器の枠組み（`checks/mod.rs` の `missing`）「Data the check needs is absent (UNVERIFIABLE unless a FAIL exists)」と、V7 の注記（`v7_replay.rs` 834–846 行）「the Holding is carried forward from its founding through every write」 | V7 の Holding の照合は、前の状態が無いと `continue`、post-state の無い archive では `return` して何も報告しない（978–980 行、852–854 行）。**r3 で実行して確認**: Holding の post-state を 1 つ落とした fixture が PASS（[05](05-results.ja.md) §5） | 修正案 [patches/0003](patches/0003-verify-v7-missing-holding-state-is-unverifiable.patch)。⑪の検証器は欠落を UNVERIFIABLE にした |
| 4b | V2 の注記（`checks/v2_program.rs` 3–5 行）「the season lives under the program the verifier was told … every archived transaction invokes it」 | 最上位で Frontier を呼ばない取引は**警告だけ**（66–79 行）。CPI で Frontier を呼んだ取引は PASS になる（r3 で実行して確認） | 修正案 [patches/0001](patches/0001-verify-unknown-instruction-is-unverifiable.patch)（CPI を UNVERIFIABLE に。内側の命令の判定は③のパッチ 0002 が要る） |
| 5 | ③ `01-existing-surface` §3「`permutation-gateway/client/README.md` と `GameClient` は旧版の API を説明」 | ③の発見（⑪は再確認していない） | ⑪は SDK を使っていない |

## r5 で見つけたもの（2026-11-05）

| # | 記述 | 事実 | 扱い |
|---|---|---|---|
| 6 | ⑪ の `describe` が資源の枠 4 を `Horses` と表示 | S1 ではこの枠に兵器（arms）が入る（`permutation_rules::frontier::arms::ARMS = Resource::Horses`）。⑥ も `arms` と呼ぶ | ⑪の表示を `Arms` に直した |
| 7 | ④の `workstreams/04-execution/docs/CONTINUITY.ja.md`（`preserve/ws04-a967f5f1`）142 行「⑪ `fc61a21`」 | ⑪の最新は `3a55a518`（r4）、今回 r5 | ④への引渡しで最新の SHA を伝える必要 |
| 8 | CI（`.github/workflows/ci.yml` の frontier-node の job）は Rust 1.95.0 で `cargo clippy --locked --workspace --all-targets -- -D warnings` を行う | 統合の先端 `d0949fd4` では `crates/keeper/src/journal.rs` 431・464 行が `clippy::type_complexity` で失敗する（ローカルで再現。⑪は触っていない） | 統合担当へ報告 |
| 9 | ⑥ README「D 新しい世界効果 … コアの拡張（新しいシーズン）」、docs/04「新しいシーズンで出す」 | 2026-10-31 の方針訂正で世界は終わらない。規則の版の切替を戦期と結び付けない（④の CONTINUITY-DECISIONS §1.5、⑪の要件） | ⑥の文書の言い回し。⑪は変えていない |
| 10 | 0001 の「知らないタグは UNVERIFIABLE」 | ⑱の V0 は FAIL（固定したプログラムは知らないタグを拒否するので、成功は別のプログラムの実行） | ⑱を正とし 0001 を取り下げた |

## 他担当の要約との食い違い（参考）

- ⑥の要約では「回数制限の正本」を補遺で「統合案（3 層）」に訂正している。⑪の契約では回数（`calls_left`）と seq は**チェーンが強制する層**に置いた（`Host::call` と検証器の両方）。⑥の 3 層のどれに当たるかは統合時に照合する（⑥への確認の往復はオーナーの指示で止めた）。ただし⑪の層は**ホストの試作の中**の強制で、チェーン上の強制は未実装（[08](08-host-vs-onchain.ja.md)）。
