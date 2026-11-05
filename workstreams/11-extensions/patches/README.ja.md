# patches: 共有コアへの変更案

> **r5（2026-11-05）の状態。** 統合の先端 `integration/ws09-13-v16-d0949fd4` では **0003 が適用済み**。**0001 は再適用しない**（知らないタグは⑱の V0 が FAIL とし、0001 の UNVERIFIABLE と食い違う。⑱を正とする。0001 の CPI の部分は 0004 が置き換える）。**0004 は新規・未適用**で、統合の先端に当たる。詳細は [12](../12-verifier-r5.ja.md)。
>
> | パッチ | 当て先 | 状態 | SHA-256 |
> |---|---|---|---|
> | [0004-verify-v0e-evidence-is-unverifiable.patch](0004-verify-v0e-evidence-is-unverifiable.patch) | 統合の先端 `d0949fd4`（V0 の後に V0E を足す。⑱の V0 は変えない） | 未適用。当てた後、検証器の試験 106 件通過、CPI・切れたログ・ログ無し・Holding 以外の post-state の欠落 902 件で PASS 0（前は 452 件 PASS） | `258ad75901a637c97f4df06655b2d01b4f744a255eff8bbeacfb6ff22dd21660` |
> | 0001 | — | 取り下げ（再適用しない） | — |
> | 0003 | — | 統合の先端に適用済み | — |
>
> 以下は r3 時点の記述（基準 `4cd901de` に対するもの）。


| パッチ | 対象 | 種類 | 確認 |
|---|---|---|---|
| [0001-verify-unknown-instruction-is-unverifiable.patch](0001-verify-unknown-instruction-is-unverifiable.patch) | `frontier-node/crates/verify`（V2 と試験 `unknown_ix.rs`） | コード差分。**r3 で拡張**: 知らないタグの命令に加え、Frontier が CPI で呼ばれた取引（ログの `invoke [n]`、n > 1）も UNVERIFIABLE | 基準 commit に単独で `git apply --check` が通る。当てる前: 知らないタグも CPI も PASS。当てた後: 知らないタグ、CPI の 135 取引すべてが非 PASS。SHA-256 `89047a7f781c3998f2753c68e7ac47d4c3b6ad5c4cc7eaacae1a81ce7ad45c36`（r2 の版は `55324a5d4e98fb1f877a65f8e4d661708a9f08550581f16b00a9c29d624910b1`、r2 のパッケージと commit `93f51b69` に残る） |
| [0003-verify-v7-missing-holding-state-is-unverifiable.patch](0003-verify-v7-missing-holding-state-is-unverifiable.patch) | `frontier-node/crates/verify`（V7 と試験 `missing_state.rs`） | コード差分（r3 新規）: 前の post-state の無い Holding の書込、書込可の既知の Holding に post-state が無い取引、post-state の無い archive を UNVERIFIABLE | 単独でも 0001 と一緒でも当たる。当てる前: Holding の post-state を落とすと PASS。当てた後: 8 個すべて非 PASS。SHA-256 `d18c2f34fc87cc31cdebd5350297fb417fdef64c8b2bc40dcae16db1c0f02a76` |
| [0002-core-extension-instructions.md](0002-core-extension-instructions.md) | `frontier-abi`、`permutation-frontier`、検証器 V7、relay | 設計案（コード差分なし）。案 B は未採用 | 未実行 |

両方を当てた状態で、既存の検証器の試験（lib 12、camp_clear 3、fixtures 9、tamper 58、unit 8）と追加の試験（unknown_ix 3、missing_state 2）の計 95 件が通過（`../results/verify-after-r3.log`）。チェーン上では何も確かめていない。

当て方（採用が決まった場合、integrator の作業）:

```sh
git apply workstreams/11-extensions/patches/0001-verify-unknown-instruction-is-unverifiable.patch
git apply workstreams/11-extensions/patches/0003-verify-v7-missing-holding-state-is-unverifiable.patch
cd frontier-node && cargo test --locked -p verify --test unknown_ix --test missing_state
```

0001 と 0003 は拡張の採否と無関係に、既存の検証器が「知らない操作・欠けた状態を黙って飛ばす」ことを塞ぐ。③の [patches/0002](https://github.com/r0ze998/wylls/blob/2f8ec700/workstreams/03-composability/patches/0002-verify-inner-instructions.md)（CPI の内側の命令を集める）と組み合わせると、内側に現れた知らないタグも同じ扱いになる。
