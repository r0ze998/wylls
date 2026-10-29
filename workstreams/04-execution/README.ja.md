# ④ 数ターンにまたがる処理を安全につなぐ実行基盤

「材料が届く → 許可された施設を使う → 成果を送る → 到着を確認する」を、停止・重複・失敗があっても資源と権利を壊さずに進める実行器。基準 commit は `4cd901de`（PR #22 の統合候補）。**main への統合と、CI の全成功は前提にしていない**。

## いまの到達点

| 区別 | 状態 |
|---|---|
| ローカル成功 | ✅ 永続化付きの実行器（SQLite、lease、CAS）、停止・再起動、複数の実行者、CLI |
| 模擬成功 | ✅ 利用権（②）と施設操作、chain の規則を **MOCK**（`src/sim.rs`）で再現し、障害注入テスト 44 件がすべて通過 |
| 実チェーンでの成功 | ⬜ 未実行（adapter が無い。送信も deploy もしていない） |

## 中心となる考え方

ネットワーク越しの exactly once は約束しない。次の 5 つで、**一つの要求による資源の変化を一度までに抑える**。

1. **識別**：各段階の要求キーを、最初の attempt の前に固定する。施設は `fac:<run_id>`、発送は caravan の `(owner_tag, seq)`。program は `seq ≠ Citizen.CARAVANS` を拒否する。
2. **先に記録**：署名済みの attempt を、送信の前に、状態の遷移と同じ transaction で記録する。
3. **正本で確認**：確定は正本の読み取り（要求キーの記録、自分の署名の着地、entity 履歴）でだけ行う。送信の応答や Receipt では確定しない。
4. **重複の拒否**：二度目は canonical な側が拒否する。新しい attempt は、前の attempt がすべて決着してから署名する（有効期間を過ぎて不在、または失敗）。
5. **fence**：書き込みはすべて `(version, lease, epoch)` の CAS で行う。古い実行者は何も書かず、何も送らない。

## 成果物

| 依頼の納品物 | ファイル |
|---|---|
| 既存実装の調査 | [docs/SURVEY.ja.md](docs/SURVEY.ja.md) |
| 状態遷移表・所有表 | [docs/STATE-MACHINE.ja.md](docs/STATE-MACHINE.ja.md)、`src/model.rs` |
| 資源・権利の不変条件 | [docs/INVARIANTS.ja.md](docs/INVARIANTS.ja.md) |
| 動く実行器 | `src/executor.rs`、`src/store.rs`、`src/main.rs`（`runexec`） |
| 再現可能な障害テスト | `tests/faults.rs`、`tests/concurrency.rs`、[docs/TEST-REPORT.ja.md](docs/TEST-REPORT.ja.md) |
| 監視・復旧の手順 | [docs/RUNBOOK.ja.md](docs/RUNBOOK.ja.md) |
| ②③⑤⑥⑦への契約案（Run、Event、Receipt） | [docs/CONTRACTS.ja.md](docs/CONTRACTS.ja.md)、`src/ports.rs` |
| 共通コア・共有 UI への変更案（未適用） | [patches/README.ja.md](patches/README.ja.md) |

## 使い方

```sh
cd workstreams/04-execution
cargo test                                   # 障害注入テスト（MOCK）
cargo run --bin runexec -- demo --db /tmp/x.sqlite --scenario crash   # happy | lost-response | crash | raid
cargo run --bin runexec -- status --db /tmp/x.sqlite --slot 100
cargo run --bin runexec -- show   --db /tmp/x.sqlite --run demo-crash
cargo run --bin runexec -- cancel --db /tmp/x.sqlite --run <id>
cargo run --bin runexec -- resume --db /tmp/x.sqlite --run <id>
```

この crate は独自の `[workspace]` と lock を持ち、root の workspace と frontier-node には加えていない。ビルドの出力先は `workstreams/04-execution/target`（`.cargo/config.toml`）。

## 範囲の外にしたこと

- 攻撃・進軍・襲撃・押収・投票の自動開始（`policy::AUTOMATABLE = [SendCaravan]`。施設操作は MOCK）。
- SettleCaravan の送信（keeper の `csettle` の任務。④は観測するだけ）。
- 他人の場所への自動送付（wallet が必要。保留にして人に渡す）。
- ①の国の制度、②の利用権の設計、共通コアと共有 UI の変更。
- 本番への送信、公開リポジトリへの push、main への merge、deploy、追加の課金。
