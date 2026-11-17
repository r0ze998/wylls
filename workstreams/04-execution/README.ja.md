# ④ 数ターンにまたがる処理を安全につなぐ実行基盤

「材料が届く → 許可された施設を使う → 成果を送る → 到着を確認する」を、停止・重複・失敗があっても資源と権利を壊さずに進める実行器。基準 commit は `4cd901de`（PR #22 の統合候補）。**main への統合と、CI の全成功は前提にしていない**。

## ローカル統合（ブランチ `ws04/integration-20261030`、2026-10-30）

この branch で、③のパッチ 0005（代理の財布の SendCaravan）と⑤のパッチ 0001（上限・期限）を共有コードにそのまま当て、④の隊商 Run を代理の財布の gateway 経由で送る経路（`src/gateway.rs`）をつないだ。**gateway のコードは実物、チェーンは模擬。** 実チェーン・実際の鍵・有料 API には接続していない。詳細・試験・③⑤への依頼は [docs/INTEGRATION-20261030.ja.md](docs/INTEGRATION-20261030.ja.md)。

第3回の受領物（① `3f3c8478`、⑤ `45cba41e`）との照合は [docs/RECONCILE-20261030c.ja.md](docs/RECONCILE-20261030c.ja.md)。`RuleDerived` は正確な量ではなく整数の下限、と直した（動作は不変）。共有パッチの採否は未確定で、この branch に新しい共有パッチは当てていない。

**世界は終わらない（2026-10-31 の方針）。** シーズン依存の洗い出し、④の変更、共通方針の案は [docs/CONTINUITY.ja.md](docs/CONTINUITY.ja.md)。認可と送信経路の案は [docs/AUTH-ROUTES.ja.md](docs/AUTH-ROUTES.ja.md)。命令番号・版・hash・単位の登録表は [contracts/registry.txt](contracts/registry.txt)（コードから生成し、`e2e-native` の試験で照合する）。賞金の host 実行の通し試験（`e2e-native/`）は、旧経路の互換と既存の受取権の確認だけに使う。

**数量の正本は [docs/QUANTITY-CONTRACT.ja.md](docs/QUANTITY-CONTRACT.ja.md)。** 記録の cargo が 0 なだけでは「0 と分かっている」とせず、この隊商の burn の記録があるときだけ 0 と断定する。別の宛先での決着は、take の記録が無ければ「原因未確認」で保留にし、誰も名指ししない（RECONCILE-20261030c §5）。

## いまの到達点（④ 0.2、統合判断待ち）

**新機能の追加は止めている。** 引き渡しの整理は [docs/HANDOFF.ja.md](docs/HANDOFF.ja.md)。②③⑤⑥の最新の資料は取得できておらず、接続済みではない。

**実際の SQLite と模擬正本で実行管理を検証した段階**であり、実チェーンでの安全性は確認していない。

| 区別 | 状態 |
|---|---|
| ローカル（実際の SQLite） | ✅ 永続化付きの実行器（WAL、`synchronous=FULL`、lease、CAS）、停止・再起動、複数の実行者、費用の帳簿、CLI |
| 模擬正本（MOCK） | ✅ 利用権（②）、施設操作、chain の規則を `src/sim.rs` で再現した。障害注入テスト 62 件がすべて通過し、変異 15 件をすべて決定的に検出する |
| 実チェーン | ⬜ 未実行（adapter が無い。送信も deploy もしていない。program の LiteSVM テストも未実行） |

基準 commit は指示どおり `4cd901de` のまま。この commit には `AGENTS.md`、関連スキル、`.claude/` が存在しない（[SURVEY](docs/SURVEY.ja.md) §0）。別の commit には移っていない。

## 中心となる考え方

ネットワーク越しの exactly once は約束しない。次の 5 つで、**一つの要求による資源の変化を一度までに抑える**。

1. **識別**：各段階の要求キーを、最初の attempt の前に固定する。施設は `fac:<run_id>`、発送は caravan の `(owner_tag, seq)`。program は `seq ≠ Citizen.CARAVANS` を拒否する。
2. **先に記録**：署名済みの attempt を、送信の前に、状態の遷移と同じ transaction で記録する。
3. **正本で確認**：確定は正本の読み取り（要求キーの記録、自分の署名の着地、entity 履歴）でだけ行う。送信の応答や Receipt では確定しない。
4. **重複の拒否**：二度目は canonical な側が拒否する。新しい attempt は、前の attempt がすべて決着してから署名する（有効期間を過ぎて全履歴にも無い、または失敗）。
5. **fence**：書き込みはすべて `(version, lease, epoch)` の CAS で行う。古い実行者は書き込まず、新しく署名しない。

**store で止められないもの**：既に署名したバイト列。停止から復帰した実行者は、有効期間内なら送信して着地させうる。取消は、すべての署名済みの要求が決着してから完了とし、それまでに起きた変化を完了の表示に含める（[STATE-MACHINE](docs/STATE-MACHINE.ja.md)「署名済みの要求」）。

## 成果物

| 依頼の納品物 | ファイル |
|---|---|
| 引き渡し整理（StockSwap との違い、到着量未検証、不在の条件、未確認事項） | [docs/HANDOFF.ja.md](docs/HANDOFF.ja.md) |
| 既存実装の調査 | [docs/SURVEY.ja.md](docs/SURVEY.ja.md) |
| 署名の要件（送信者本人・委任 agent・他人宛て） | [docs/SIGNATURES.ja.md](docs/SIGNATURES.ja.md) |
| 状態遷移表・所有表 | [docs/STATE-MACHINE.ja.md](docs/STATE-MACHINE.ja.md)、`src/model.rs` |
| 資源・権利の不変条件 | [docs/INVARIANTS.ja.md](docs/INVARIANTS.ja.md) |
| 動く実行器 | `src/executor.rs`、`src/store.rs`、`src/main.rs`（`runexec`） |
| 再現可能な障害テスト | `tests/faults.rs`、`tests/concurrency.rs`、`tests/signed.rs`、`tests/routes.rs`、`tests/arrival.rs`、[docs/TEST-REPORT.ja.md](docs/TEST-REPORT.ja.md) |
| 監視・復旧の手順 | [docs/RUNBOOK.ja.md](docs/RUNBOOK.ja.md) |
| ①②③⑤⑥⑦への契約案（Run、Event、Receipt、費用、表示）。すべて提案で、確定したものは無い | [docs/CONTRACTS.ja.md](docs/CONTRACTS.ja.md)、`src/ports.rs` |
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
# 機械可読（1 行の JSON）：Run の受付と閲覧（⑥の荷車だけの Run、⑬の実行ポート）。送信はしない
cargo run --bin runexec -- run accept --db /tmp/x.sqlite --spec spec.json [--slot <n>]   # --spec - で標準入力
cargo run --bin runexec -- run view   --db /tmp/x.sqlite --run <id>
```

`run accept` / `run view` の欄と終了コードは [docs/EXECUTION-CONTRACT-20261106.ja.md](docs/EXECUTION-CONTRACT-20261106.ja.md) §8。試験は `tests/run_cli.rs`（鍵なし、模擬の世界）。

この crate は独自の `[workspace]` と lock を持ち、root の workspace と frontier-node には加えていない。ビルドの出力先は `workstreams/04-execution/target`（`.cargo/config.toml`）。

## 範囲の外にしたこと

- 攻撃・進軍・襲撃・押収・投票の自動開始（`policy::AUTOMATABLE = [SendCaravan]`。施設操作は MOCK）。
- SettleCaravan の送信（keeper の `csettle` の任務。④は観測するだけ）。
- 他人の場所への自動送付（**送信者本人の** wallet の署名が必要。受取人の署名ではない。保留にして人に渡す）。
- ①の国の制度、②の利用権の設計、共通コアと共有 UI の変更。
- 本番への送信、公開リポジトリへの push、main への merge、deploy、追加の課金。

## 作業環境について（元の checkout）

この worktree を作るときに、元の checkout を変更した。自動では元に戻していない（別の作業が始まっている可能性があるため）。

| 項目 | 内容 |
|---|---|
| 元の checkout | `/home/user/wylls` |
| 元のブランチ | `claude/gallant-ride-cunptv`（当時 `9214293`。`origin/main` と `origin/claude/gallant-ride-cunptv` も同じ commit） |
| 行った操作 | `git checkout --detach`（未 commit の変更は無かった）→ `git branch -f claude/gallant-ride-cunptv 4cd901de` → `git worktree add /home/user/wylls-ws04 claude/gallant-ride-cunptv` |
| 理由 | 指定のブランチで、基準 commit `4cd901de` から専用の worktree を作るため。一つのブランチは一つの worktree でしか checkout できない |
| 現在の状態 | `/home/user/wylls` は `9214293` の detached HEAD で、変更は無い。ローカルの `claude/gallant-ride-cunptv` は④の commit を指し、`/home/user/wylls-ws04` で checkout されている。`origin/claude/gallant-ride-cunptv` は `9214293` のまま（push していない） |
| 戻す場合 | 人の判断で行う。worktree がそのブランチを持っている間は、元の checkout でそのブランチに switch できない |

## 保留つき観測の読み取り（`runexec observe`、2026-11-17、**未実行**）

findex の索引の CARAVAN_SETTLED / RAIDED を、保留したまま JSON 1 行で読む診断用のコマンドです。**ビルドも実行もしていません。** 下の例は使い方を示すだけで、出力例は実行結果ではありません。

```bash
# findex のストアのディレクトリ（index.sqlite と archive/manifest.json）を読む
runexec observe store --store /path/to/findex-store --limit 64
# 索引のファイルだけを読む（アーカイブの epoch は付かない）
runexec observe db --db /path/to/findex-store/index.sqlite --after 0 --limit 64
```

- **2 つのモードは明示して選ぶ。** 自動では判別しない。`store` は `observation::read_store_observations`、`db` は `observation::read_observations`。
- **他の経路には届かない。**
  - ほかのどのコマンドより先に振り分ける。
  - 実行ストアを開かない（`Store::open` なし）。
  - スキーマ、受け付け、取り消し、送信、HTTP、RPC のどれにも届かない。
- **出力は観測のページそのまま。**
  - `basis: "unproven"`、`world` / `finality` / `complete` は null で、保留はすべて残る。
  - `store` モードでは、行ごとの `archive_epoch` と、ページの `store`（同じディレクトリであること、索引と manifest の世代、限界）が付く。
  - どれも、受領、確定した出来事、送られた隊商の証拠ではない。admit されたものは何もない。
- **引数は、何かを開く前に確かめる。** 次は exit 2 `BadRequest`:
  - 未知・重複・値なしのオプション;
  - 別のオプションを値に取ること;
  - `--after` / `--limit` が数字だけでないこと;
  - `--limit` が 1〜256 の外;
  - `--after` が i64 の範囲を超えること。
- **読めないとき・拒否したときは exit 1 `ObservationNotRead`。**
  - 理由: ディレクトリやファイルが無い、シンボリックリンク、通常のファイルでない、スキーマやモードの不一致、manifest の形の違反。
  - これは隊商や実行について何も言わない。「記録なし」（`NoRecord`）でも「未送信」でもない。
- **書き込みについて。** このコマンド自身は何も書かない。ただし findex の索引は WAL モードなので、SQLite が `-shm` の補助ファイルを作ることはありうる（「ファイルが一切変わらない」とは言えない）。
- **試験は書いただけで、一度も走らせていない:** `tests/observe_cli.rs`、`tests/store_observation.rs`。
