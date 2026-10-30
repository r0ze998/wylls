# 変更案（いずれも未適用）

この担当はコア・オフチェーン・relay を変更していない。必要と判断した変更を、担当者が判断できる形で分けて置く。

| 案 | 対象（担当外） | 種類 | 必要性 | 検証 |
|---|---|---|---|---|
| [0001](0001-harness-loaded-size-listed-programs.patch) | `permutation-frontier/svm-tests/src/chain.rs`（コアの試験ハーネス） | 差分（適用可能） | CPI を試験する時に読込量を validator と同じに数えるため。合格地点(1)(2)の成否には影響しない | 一時 worktree で適用し、`harness`・`g01_loaded_limit`・`g02_prefund`・`g13_season_beacon`・`caravan`（計 53 件）が未適用時と同じく全通過（2026-10-29、ローカル） |
| [0002](0002-verify-inner-instructions.md) | `frontier-node/crates/verify`、`findex`（再生検証器と索引） | 方針と変更点 | CPI で送られた命令を検証器が判定できるようにする。**外部プログラムの CPI を正式に受け入れる前に必須** | 未実行（コードを読んだ結果） |
| [0003](0003-relay-composed-shapes.md) | `permutation-gateway`（relay） | 方針 | 今は変更不要（推奨）。courier の経路は自分で手数料を払う。スポンサーする場合の条件を整理 | `relay-check` で現状の拒否を確認 |
| [0004](0004-core-scoped-delegation.md) | コアの委任（②と共同） | 要求の整理 | 「所有者のオンライン署名なしの**限定**委任」をコアが保証するため | 該当なし（設計の入力） |
| [0005](0005-agent-wallet-sendcaravan.patch) | `permutation-gateway/src/frontier/agent/{contract,gateway}.mjs`（⑤ 代理人の財布）＋試験 1 本 | 差分（適用可能） | MCP の `send_caravan` を代理人の財布で通すため（SendCaravan を `transport` 群として代理人の行動に加える。出発は代理人の村か所有者の倉庫、宛先と経路は `action.route`） | 一時 worktree で適用。`agent-wallet-*` と `frontier-relay*` の試験が、適用前 97/97、適用後 102/102（新規 5 件）で通過（[results/gateway-patch-0005.log](../results/gateway-patch-0005.log)）。ローカルの実チェーンで MCP から 2 本の隊商が届いた（[09](../09-mcp-run-and-video.ja.md)） |

| [0006](0006-receipt-port.md) | ④ 実行台帳とつなぐ口（③の側の差し替え場所と、③が渡せる値） | **③の側は採用・実装済み**（`mcp/src/receipt-port.mjs`）。④との契約は未確定 | ④の契約が来た時に、③の MOCK（受領証、取消、到着量）を置き換えるため。共通部分のコードは変えていない | 適合試験 `mcp/test/port-conformance.mjs`（local の adapter は通過）。④の adapter は資料待ち（[13](../13-runreceipt-port.ja.md)） |

合格地点(1)「所有者が署名すれば呼べる」に必要なコア変更・relay 変更は**なし**。

**0005 の適用条件（⑤の判断）。** (1) 代理人に隊商を許すことを⑤が認める（所有者の方針で `transport` 群を選んだ時だけ有効。既定では許可されない）。(2) 隊商に価格を付けるかは⑤の価格表（`prices.game.SendCaravan`、今は空）。(3) relay の quota は既存のまま（SendCaravan の rent と fee は既存の drain guard の許容額）。(4) runner（運営の AI）の候補には加えていない。加える場合は⑤が別に決める。
