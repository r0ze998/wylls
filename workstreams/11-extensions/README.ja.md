# ⑪ 拡張方式: 利用者や AI が世界の機能を増やす方法

作業日 2026-10-30〜11-06（r11 まで）。**r11: V27 で JoinResident の policy、link、resident の正規アドレス（PDA。オーナーの許可の範囲）を照合する（パッチ 0011）。****r9: 正しい NFT 参加（JoinResident）を検証する V27（パッチ 0009、⑳の 45d95e31 の上）。****r7: ④の現在版 `8e96f24d` へ 1 つで当たる検証器パッチ 0006、②⑳の新しい命令・記録との照合、DIVERT の PASS の経路を塞いだ。****r6: 検証器パッチ 0005（0004 の上）、⑥の公開状態と⑪の実行状態の分離の契約試験。****r5: ⑥との接続準備（`creation-bridge/`）と検証器の残件（パッチ 0004）。****r4: 世界は終了・リセットしない（2026-10-31 の方針訂正）。⑪の対応は [09](09-continuing-world.ja.md)。**基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`。この担当の成果物はすべてこのディレクトリにあり、共有コア（`permutation-frontier`、`frontier-abi`、`permutation-rules`、`frontier-node`、`permutation-gateway`）は一行も変えていない。

> **これは本番に任意コード実行を開く決定ではない。案 B、Burn、運営の停止権限はいずれも採用していない（2026-10-30）。** 以下の結果はホスト上の試験で、オンチェーンの保証ではない（[08](08-host-vs-onchain.ja.md)）。 比較と試作の許可の範囲で、案を比べ、推奨案をホスト上の隔離した crate で試作した。例の機能（「見張りの誓い」）は例であり、採用したゲームルールではない。

## 結論

| 問い | 答え | 根拠 |
|---|---|---|
| 三案のどれを推すか | **B 宣言型の効果**: 作者は manifest（状態の宣言と閉じた効果の列）を公開し、コアが解釈する。作者のコードは実行しない | [02](02-comparison.ja.md) |
| A（既存命令の合成）の限界 | 74 命令の部分集合にとどまり、新しい状態遷移を足せない（③ `t01`・`t11`）。検証器はトップレベルの Frontier 命令しか判定しない | [02](02-comparison.ja.md)、③ |
| C（外部プログラム接続）の限界 | 再入禁止・CPI 深さ 5・hook の CU と読込量・upgrade authority による無断の意味変更。コア資源に効かせるにはコア側の効果の語彙（＝B）が結局要る。検証には第三者の `.so` の再実行が要る | [02](02-comparison.ja.md)、[10](10-research.ja.md) |
| 必須の実証（A が作る→B が確認→B の許可だけで呼ぶ→第三者が検証） | **ホスト上で通過**（`f01`）。新しい状態遷移（時間で解ける預かりと名声）を扱う | [03](03-prototype.ja.md) §2 |
| 拒否の例 | 権限逸脱、二重実行、異なる版、コアの版違い、停止中、無限実行・未知 op、過大な状態、発行、偽の完了記録、未知の語彙 → すべて期待どおり拒否／FAIL／UNVERIFIABLE | [03](03-prototype.ja.md) §3、[05](05-results.ja.md) |
| 未知・不足を PASS にしない（r3） | 試作の検証器: 1,254 個の改変で PASS 0、知らない・欠けたものは UNVERIFIABLE | [05](05-results.ja.md) §5 |
| 返却（r3） | 出口は停止・Grant の終了・コアの版の変更で開き、一度だけ。5 手の全 16,807 通りで二重返却も取り出せない預かりもない | [05](05-results.ja.md) §5、[01](01-contract.ja.md) §3 |
| 分割書込み（r3） | 未完成・欠落・順序逆転・重複・食い違いを扱い、hash の確認前は登録も実行もされない | [01](01-contract.ja.md) §3b |
| 継続世界（r4） | 拡張の状態・Grant・預かり・返却義務が期間の境界・再起動・30 年の空白をまたいで続き、二重適用も消失もない。期間の終わりで返却を拒否する依存（パッチ 0002 の初版）を除いた | [09](09-continuing-world.ja.md) |
| 既存の検証器の穴 | 知らないタグの命令、CPI で呼ばれた Frontier、Holding の post-state の欠落を PASS にする（実行で確認）。残る未確認の範囲は [08](08-host-vs-onchain.ja.md) §3 | [patches/0001](patches/0001-verify-unknown-instruction-is-unverifiable.patch)、[0003](patches/0003-verify-v7-missing-holding-state-is-unverifiable.patch) |
| Solana 上で動くか | **未確認**。SBF ツールチェーンの導入が承認されず、チェーン上の試験と CU の測定はしていない | [00](00-context.ja.md) §4 |

## 文書

| 文書 | 内容 |
|---|---|
| [00-context](00-context.ja.md) | 基準、ブランチ、AGENTS とスキルの有無、他担当の状態、実行できなかったこと |
| [01-contract](01-contract.ja.md) | **④⑥⑨⑩②へ渡した最小契約**: manifest・効果・登録簿・許可・Call/Receipt・検証の三値 |
| [02-comparison](02-comparison.ja.md) | 三案の比較（作れる／作れない、Solana の制約、費用、検証、更新・停止権限）と推奨 |
| [03-prototype](03-prototype.ja.md) | 試作の構成、必須の実証、拒否の例の一覧 |
| [04-safety](04-safety.ja.md) | 安全境界ごとの仕組み・試験・防げない範囲 |
| [05-results](05-results.ja.md) | 試験結果、測定、未実行 |
| [06-adoption](06-adoption.ja.md) | 採用前に決めること（オーナーの判断・技術の確認・他担当との照合） |
| [07-discrepancies](07-discrepancies.ja.md) | 文書とコードの食い違い |
| [16-verifier-r11](16-verifier-r11.ja.md) | **r11**: JoinResident の証明口座の正規アドレス、禁止操作が無いことの呼び出し先までの確認、⑲の履歴判定との整合、実装・試験・未確認の区別 |
| [15-verifier-r9](15-verifier-r9.ja.md) | **r9**: JoinResident の照合（命令・NFT・世代・国・shard・時刻・世界ごとの重複・post-state）、V0 の NFT 版と②の命令の区別、当てる順 |
| [14-verifier-r7](14-verifier-r7.ja.md) | **r7**: ④の現在版へのパッチ 0006（0004＋0005＋r7）、②⑳⑪の新しいタグ・記録種別が PASS にならないこと、TRANSIT_SETTLED の外の DIVERT、未知の conquest 種別の仕掛け |
| [13-verifier-r6](13-verifier-r6.ja.md) | **r6**: 0004 を統合候補 `ef63544c` と照合、⑯の P1 との関係、残っていた PASS の経路（ログの無い CPI だけの取引、印なしに失われたログの末尾）を塞ぐパッチ 0005、③④⑯との分担 |
| [11-creation-boundary](11-creation-boundary.ja.md) | **r5**: ⑥との境界（⑥が登録・版固定・公開状態、⑪が実行時の検証）、意味を変えずに対応する部分と拒否する部分、⑥自身のコードで作った期待値による契約試験 10 件 |
| [12-verifier-r5](12-verifier-r5.ja.md) | **r5**: 統合の先端での検証器の残件（CPI、切れたログ、ログ無し、Holding 以外の post-state）、パッチ 0004、0001 を再適用しない理由 |
| [09-continuing-world](09-continuing-world.ja.md) | 継続世界への対応: 残っていたシーズン依存、変えた挙動、境界・再起動・長期運用の試験、残る判断（r4） |
| [08-host-vs-onchain](08-host-vs-onchain.ja.md) | ホスト試験で確かめた範囲とオンチェーンの保証の区別、CPI・V7 の未確認範囲（r3） |
| [10-research](10-research.ja.md) | OSS の先例（BOLT、Metaplex Core、Transfer Hook、MUD、Dojo、Swig、Lighthouse）と Solana の一次資料（Agave v3.1.9） |
| [patches/](patches/) | 共有コアへの変更案（**未適用**） |

## 実行

```sh
workstreams/11-extensions/run.sh   # fmt --check, clippy -D warnings, cargo test --locked, sizes
```

Rust 1.89.0（リポジトリの `rust-toolchain.toml`）。依存は `permutation-rules` と `frontier-abi`（どちらも path）と、ルートの `Cargo.lock` と同じ版の crates.io の crate だけ（`ext-kernel/Cargo.lock` はルートの lock を複製して刈り込んだもの）。Solana のツールチェーンは使わない。
