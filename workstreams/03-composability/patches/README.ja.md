# 変更案（いずれも未適用）

この担当はコア・オフチェーン・relay を変更していない。必要と判断した変更を、担当者が判断できる形で分けて置く。

| 案 | 対象（担当外） | 種類 | 必要性 | 検証 |
|---|---|---|---|---|
| [0001](0001-harness-loaded-size-listed-programs.patch) | `permutation-frontier/svm-tests/src/chain.rs`（コアの試験ハーネス） | 差分（適用可能） | CPI を試験する時に読込量を validator と同じに数えるため。合格地点(1)(2)の成否には影響しない | 一時 worktree で適用し、`harness`・`g01_loaded_limit`・`g02_prefund`・`g13_season_beacon`・`caravan`（計 53 件）が未適用時と同じく全通過（2026-10-29、ローカル） |
| [0002](0002-verify-inner-instructions.md) | `frontier-node/crates/verify`、`findex`（再生検証器と索引） | 方針と変更点 | CPI で送られた命令を検証器が判定できるようにする。**外部プログラムの CPI を正式に受け入れる前に必須** | 未実行（コードを読んだ結果） |
| [0003](0003-relay-composed-shapes.md) | `permutation-gateway`（relay） | 方針 | 今は変更不要（推奨）。courier の経路は自分で手数料を払う。スポンサーする場合の条件を整理 | `relay-check` で現状の拒否を確認 |
| [0004](0004-core-scoped-delegation.md) | コアの委任（②と共同） | 要求の整理 | 「所有者のオンライン署名なしの**限定**委任」をコアが保証するため | 該当なし（設計の入力） |

合格地点(1)「所有者が署名すれば呼べる」に必要なコア変更・relay 変更は**なし**。
