# ④・共有コードへの変更案（いずれも未適用）

この担当は共有コードを変更していない。差分は、一時 worktree（4cd901de）で適用し、`permutation-gateway` の `agent-wallet-*` 試験を通してから取り出した。0001・0002 を順に当てて agent-wallet 73件通過（2026-10-30）。0003 を加えた3つは衝突なく当たる（2026-10-31 に `git apply --check` で確認）。

| 案 | 対象 | 種類 | 必要性 | 検証 |
|---|---|---|---|---|
| [0001](0001-agent-runner-tier-names.patch) | `src/frontier/agent/runner.mjs` の `TIERS`、その試験 | 差分 | **不具合の修正**。モデルに伝える村の段階名が Rust（`control.rs tier_from_u8`：0 Hamlet、1 Town、2 City、3 Stronghold）・web（集落・町・都市・城塞）と違い、Town を「Village」、City を「Town」と伝えていた。既存の試験も誤った名前を固定していた | agent-wallet 72件通過 |
| [0002](0002-agent-sources-resident-and-ledger-day.patch) | `contract.mjs SOURCES`、`ledger.mjs`、`gateway.mjs` | 差分 | ④が住民の要求も ActionRequest で受けるなら `source: 'resident'`。予算の日を UTC 日以外（ゲーム日）で数えられる `dayKey`（既定は従来どおり UTC 日。住民は今は起点を UTC 0時にそろえて回避している） | agent-wallet 73件通過（新しい試験1件） |
| [0003](0003-mind-prompt-no-end-bell.patch) | `citizens/mind/prompt.mjs`、その試験 | 差分 | 継続する世界（終わりのターンがない）で、モデルに「Season ends at turn undefined」と伝えないようにする。終わりの値がある旧シーズン・記録済みの実行は文言そのまま（記録を読み替えない） | citizens-mind・probe 試験 258件通過（新しい試験1件） |

## 差分にしていない要求（④・relay への入力）

1. **S1 の SendCaravan（と BuildVault）を Node で組む builder**。web の `fplay.mjs accountsFor` と `fchainio.mjs` にはあるが、`gateway.mjs accountsFor` にはない。住民は代理ではないので AgentGateway を通す必要はないが、自分の財布鍵で relay の player shape を送るには、web と同じ口座の並び（`src`・`dst` の place、Caravan PDA、経路の Province）を Node で作る必要がある。web の faddr の `A.of(...)` と gateway の `FrontierAddresses` は別物なので、写すより共通化を勧める。チェーンなしで正しさを確かめられないため、差分は書いていない。
2. **依頼・返答の署名記録**を citizens の social 層に足すこと（[03](../03-contracts.ja.md) §5）。
3. **住民の参加の経路**：運営招待（参加費なし・賞金対象外）か x402 の参加費か。資金の徴収方式と賞金対象に関わるので、所有者の判断。毎戦期の参加費・パスの買い直しは前提にしない。

## 継続する世界のための要求（2026-10-31、④・⑧へ。差分にしていない）

4. **AI の判断の証拠の公開**（`registrar.mjs`・`audit/season_end.mjs`・`verify-minds.mjs`）：今はシーズン終了時だけ。終わらない世界では区切りごとの公開が要る（周期は未決）。
5. **エージェント台帳の履歴**（`ledger.mjs` の HISTORY_MAX 500 行を状態ファイルに保持）：長く生きる住民・代理では、状態の書き込みの大半になる（45日の測定で状態約148KBの大半）。履歴を追記専用ファイルへ移す案。
6. **口座の基点**（`addresses.mjs`：全口座が Season PDA から導かれる）：世界を作り直さないことが継続の前提。移行するなら、旧口座から新口座への対応（少なくとも財布アドレス→村）を公開すること。⑬の住民は財布アドレスで覚えるので、その対応があれば記憶は続く。
