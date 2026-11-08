# 広域 writer 草案の保全合流

## 入力と競合の解決

- 親候補: 1d050f79254f26095247028a29aebcf31a62ff31。
- 広域草案: 46df053e14d7c69e9af49e11ea2aff43638e427d。
- Cargo.toml と lib.rs が競合した。両方の feature を残し、PROGRAM_VERSION の条件を統合した。
- 通常版は 4、NFT は 0x8004、wide は 0x4004、NFT+wide は host-only の 0xC004。custody 単独は 5。
- 未設計の custody+NFT と custody+wide は compile_error。3つ同時も拒否する。異なる ruleset を勝手に一つにしない。
- wide の Solana target 向け compile_error を維持。既定無効。
- verify/findex/ResidentFeed と UI画面コードは親候補から変更していない。

## 実行した確認

鍵ペア生成・秘密鍵導出・署名をしない試験だけを実行した。PDA/with_seed 公開アドレス計算は許可範囲。

- permutation-frontier --lib --features wide-world-experimental map_growth_runtime_tests::: 9件通過。
- permutation-frontier --lib map_growth_runtime_tests::: 6件通過。
- frontier-abi --lib --features world-index-experimental world_index::: 79件通過。
- ホスト cargo check の8組合せ: 通常/NFT/custody/wide/NFT+wide の5つが成功。custody+NFT/custody+wide/3つ同時の3つは意図した compile_error で失敗。全8条件で期待どおり。
- frontier-node の cargo check --offline --workspace --all-targets: 通過。コンパイルのみ。

## 未実行・失敗を分けた記録

- 親候補で通過した verifier/custody/history の58件をこの木でも再実行しようとしたが、実行前の安全審査が integration test binary 全体に鍵操作の可能性があるとして拒否した。再実行はしていない。親候補の結果をこの木での実行結果とは数えない。
- wide版の cargo +1.95.0 clippy --lib -- -D warnings は依存の permutation-rules にある既存の manual_is_multiple_of 7件で失敗。変更していない laurel/gov/tick の範囲。今回その無関係なコードを変更せず、clippy全通過とは扱わない。

## 完成ではない範囲

- 土地を実際に開く WideOpenProvince、取得する WideClaimSite、出発する WideDepart は NotImplemented として書込み前に拒否する。広域の実用ゲーム完成ではない。
- 広域seed consume成功は実暗号検証ではなくfixtureの用意を含む。試験の詳細と限界は docs/frontier/map-growth/WIDE-LAND-WRITER.md と試験の冒頭にある。
- custody命令再生、NFTとの権限統合、V26番号重複は未解決。
- 実チェーン、SBF、署名付きE2E、NFT賞金成功は未確認。
- mainと本番公開は変更しない。[skip ci]付き保全pushのみ。
