# ④・共有コードへの変更案（いずれも未適用）

この担当は共有コードを変更していない。差分は、一時 worktree（4cd901de）で適用し、`permutation-gateway` の `agent-wallet-*` 試験を通してから取り出した。二つを順に当てても衝突せず、73件通過（2026-10-30）。

| 案 | 対象 | 種類 | 必要性 | 検証 |
|---|---|---|---|---|
| [0001](0001-agent-runner-tier-names.patch) | `src/frontier/agent/runner.mjs` の `TIERS`、その試験 | 差分 | **不具合の修正**。モデルに伝える村の段階名が Rust（`control.rs tier_from_u8`：0 Hamlet、1 Town、2 City、3 Stronghold）・web（集落・町・都市・城塞）と違い、Town を「Village」、City を「Town」と伝えていた。既存の試験も誤った名前を固定していた | agent-wallet 72件通過 |
| [0002](0002-agent-sources-resident-and-ledger-day.patch) | `contract.mjs SOURCES`、`ledger.mjs`、`gateway.mjs` | 差分 | ④が住民の要求も ActionRequest で受けるなら `source: 'resident'`。予算の日を UTC 日以外（ゲーム日）で数えられる `dayKey`（既定は従来どおり UTC 日。住民は今は起点を UTC 0時にそろえて回避している） | agent-wallet 73件通過（新しい試験1件） |

## 差分にしていない要求（④・relay への入力）

1. **S1 の SendCaravan（と BuildVault）を Node で組む builder**。web の `fplay.mjs accountsFor` と `fchainio.mjs` にはあるが、`gateway.mjs accountsFor` にはない。住民は代理ではないので AgentGateway を通す必要はないが、自分の財布鍵で relay の player shape を送るには、web と同じ口座の並び（`src`・`dst` の place、Caravan PDA、経路の Province）を Node で作る必要がある。web の faddr の `A.of(...)` と gateway の `FrontierAddresses` は別物なので、写すより共通化を勧める。チェーンなしで正しさを確かめられないため、差分は書いていない。
2. **依頼・返答の署名記録**を citizens の social 層に足すこと（[03](../03-contracts.ja.md) §5）。
3. **住民の参加の経路**：運営招待（参加費なし・賞金対象外）か x402 の参加費か。資金の徴収方式と賞金対象に関わるので、所有者の判断。
