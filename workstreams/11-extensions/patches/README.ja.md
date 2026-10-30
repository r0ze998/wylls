# patches: 共有コアへの変更案（すべて未適用）

| パッチ | 対象 | 種類 | 確認 |
|---|---|---|---|
| [0001-verify-unknown-instruction-is-unverifiable.patch](0001-verify-unknown-instruction-is-unverifiable.patch) | `frontier-node/crates/verify`（V2 と試験 1 本） | コード差分（88 行追加） | 基準 commit に `git apply --check` で当たる。一時 worktree で当てて、検証器の試験 92 件が通過。当てる前は同じ入力が PASS、当てた後は UNVERIFIABLE（[05](../05-results.ja.md) §3）。SHA-256 `55324a5d4e98fb1f877a65f8e4d661708a9f08550581f16b00a9c29d624910b1` |
| [0002-core-extension-instructions.md](0002-core-extension-instructions.md) | `frontier-abi`、`permutation-frontier`、検証器 V7、relay | 設計案（コード差分なし） | 未実行 |

当て方（採用が決まった場合、integrator の作業）:

```sh
git apply workstreams/11-extensions/patches/0001-verify-unknown-instruction-is-unverifiable.patch
cd frontier-node && cargo test --locked -p verify --test unknown_ix
```

0001 は拡張の採否と無関係に、既存の検証器が「知らない操作を黙って飛ばす」ことを塞ぐ。③の [patches/0002](https://github.com/r0ze998/wylls/blob/2f8ec700/workstreams/03-composability/patches/0002-verify-inner-instructions.md)（CPI の内側の命令を集める）と組み合わせると、内側に現れた知らないタグも同じ扱いになる。
