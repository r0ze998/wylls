# ③ 外部接続とコンポーザビリティ：別の作者のプログラムが WYLLS に作用できるか

作業日 2026-10-29。基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補。`main` 統合済みでも CI 全成功でもない）。この担当の成果物はすべてこのディレクトリにあり、コア（`permutation-frontier`、`frontier-abi`、`frontier-node`、`permutation-gateway`）は一行も変えていない。

> **読み方。** 各文書は「事実（実行して確かめた）」「コードを読んだ結果（未実行）」「提案」を分けて書く。測定値はすべてこの作業機のローカル条件（LiteSVM 0.16、または `solana-test-validator` 3.1.9）での値で、本番の費用や性能を保証しない。

## 結論

| 合格地点 | 判定 | 根拠 |
|---|---|---|
| **(1) 所有者が署名すれば、別の作者のプログラムが呼べる** | **確認できた（ローカル実チェーン）** | 外部プログラム `wylls-courier` が CPI で SendCaravan を呼び、直接呼んだ場合と**書込先の口座がバイト単位で同一**になった（`t01`）。署名なし、他人の出発元、権限不足の session、誤った PDA、所有プログラム違い、口座の不足・過剰、重複、到着前の受取、版違いはすべて拒否された（`t02`–`t10`）。悪意あるラッパーの直接書込・lamport 引出・署名の水増しはランタイムが拒否した（`t11`）。 |
| **(2) 所有者のオンライン署名なしに、限定委任で動く** | **仕組みとしては動いた。ただし「限定」はコアではなく仮アダプターが課している** | 所有者が一度だけ `SetSession` で session 鍵を courier の PDA に向け、courier の**仮の委任アダプター**（②の Grant ではない）に上限を登録すると、所有者以外の cranker が所有者の署名なしで送れた（`t12`）。上限（積荷、回数、期限）は courier だけが守る。コアから見ると courier は**session 鍵そのもの**で、session が許すすべての命令を行使できる立場にある（`02`、`04` を参照）。コア側で範囲を絞った委任は存在しない。 |

その他の主な発見（いずれも実行で確認）:

1. **`top_level_only = false` は CPI 成功を意味しない。** 加えて、(a) 同じトランザクションの他の命令が書く口座を読取専用で並べる命令は `BadAccount` で拒否される（BuildVault + SendCaravan、SendCaravan + SettleCaravan は同一トランザクションに入らない）、(b) 呼び出し側プログラムの ProgramData も SIMD-0186 の読込量に数えられる、(c) actor と payer の署名は CPI で作れない。詳細は [02-instruction-matrix.ja.md](02-instruction-matrix.ja.md)、[03-composition.ja.md](03-composition.ja.md)。
2. **スポンサー relay は courier の取引を受理しない**（4 番目の命令が Frontier プログラムでない、`RelayRejected`）。relay の検査は無効化していない。courier の経路は今は手数料を自分で払う（delegated は cranker が払う）。[05-relay.ja.md](05-relay.ja.md)。
3. **コアの LiteSVM ハーネスは CPI 取引の読込量を約 1.74 MB 少なく数える。** `solana-test-validator` 3.1.9 で測ると、列挙されただけ／CPI で呼ばれただけの LoaderV3 プログラムの ProgramData も数えられる（`drill`）。ハーネスの修正をパッチ案として分離した（[patches/](patches/)）。
4. **再生検証器（`frontier-node/crates/verify`）はトップレベルの Frontier 命令しか集めない**（コードを読んだ結果、未実行）。CPI で送られた隊商は、記録はログに残るが、それを判定する命令が見つからない。CPI 呼出しを正式に扱う前に検証器の変更が要る（パッチ案）。

## 成果物の地図

| パス | 内容 |
|---|---|
| [courier/](courier/) | **外部接続の最小サンプル**：別作者の Solana プログラム `wylls-courier`（SBF）。op 0 所有者署名の SendCaravan 転送、op 1–3 仮の委任アダプター。`--features hostile` は試験専用の悪意ある命令 |
| [courier-tests/](courier-tests/) | LiteSVM の実チェーン試験（`tests/courier.rs` 16 件）、validator 演習（`tests/validator_drill.rs`）、命令表の生成（`tests/matrix.rs`） |
| [relay-check/](relay-check/) | relay の shape 判定（`classify`）に courier の取引形を通す Node 試験（模擬） |
| [drill/](drill/) | `solana-test-validator` 3.1.9 で CPI 先 ProgramData の数え方を測る演習 |
| [results/](results/) | この作業機での実行ログと測定 JSON |
| [01-existing-surface.ja.md](01-existing-surface.ja.md) | 既存の SDK・Herald・ABI・命令 builder・relay・MCP の利用可能範囲（作り直さない） |
| [02-instruction-matrix.ja.md](02-instruction-matrix.ja.md) | 主要命令ごとの入力・口座・署名者・PDA・CPI 可否・費用・エラー。全 74 命令は [generated/](generated/instruction-matrix.generated.ja.md) |
| [03-composition.ja.md](03-composition.ja.md) | 同一トランザクションで合成できる操作／④の非同期実行が要る操作 |
| [04-interface-contract.ja.md](04-interface-contract.ja.md) | 権利を伴う機能を呼ぶ公開インターフェースの契約案（入出力型・版・エラー、②への差し替え点） |
| [05-relay.ja.md](05-relay.ja.md) | relay が受理する形と実験の取引形の比較、使えない経路と必要な対応 |
| [06-results.ja.md](06-results.ja.md) | テスト結果（通過/失敗/未実行）、費用・計算量の測定 |
| [patches/](patches/) | コア・オフチェーン・relay への変更案（**未適用**） |

## 実行手順

前提: Agave 3.1.9（`cargo-build-sbf`、platform-tools v1.52。コア CI と同じインストール）、Rust 1.95.0、Node 20 以上。ネットワーク送信・deploy はしない（演習の validator はローカル）。

```sh
# 1. Frontier プログラムの SBF ビルド（無ければ run.sh が作る）
scripts/build-frontier.sh
scripts/build-frontier.sh --features test-beacon
# 2. courier（通常版と hostile 試験版）をビルドし、LiteSVM 試験・命令表の生成・relay 判定を実行
workstreams/03-composability/run.sh
# 3. 加えて validator 演習（solana-test-validator 3.1.9 を 41280 番台で起動・停止）
workstreams/03-composability/run.sh --drill
```

`run.sh` は `courier-tests` の target をコアのハーネス（`permutation-frontier/svm-tests/target`）と共有する（lock はハーネスの複製）。結果は `results/` に書く。

## 担当の境界

- ②の権利ルール（Grant）、④の Run（非同期実行）、⑤の AI 判断、⑥の作成画面は作っていない。courier の op 1–3 は**明示した仮アダプター**で、②の Grant を受領したら置き換える前提（[04](04-interface-contract.ja.md) §4）。
- コアにない機能を外部プログラムだけで実現できるとは主張しない。courier が行うことは、コアの SendCaravan が許すことの部分集合だけ（`t01` が同一効果、`t11` が迂回不可を示す）。
- コア・relay の変更は [patches/](patches/) に案として分離し、適用していない。
- 本番ネットワーク送信、公開 push、`main` への merge、deploy、追加課金、既存作業の削除はしていない。
