# ④向けの独立した変更候補：読むだけの認証の口 `agent_whoami`（パッチ 0004、未適用、2026-10-30）

**他のパッチとは独立しています。** 0001・0002・0002b・0003 や③の 0005 を採るかどうかに関係なく、単独で判断できます。採るかどうかは④（共有コードの統合担当）が決めます。

## 何のためか

今の中継には、capability が今の物かを、記録を残さずに確かめる方法がありません（`agent_view` は公開の読み取りで、認証しない）。⑤は代わりに、門で必ず断られる `agent_act` を送っています（`ACCESS-CHECK.ja.md`）。しかしこれには、次の問題があります。
- 冪等の記録が1件残る（2,000 件の上限で、古い本物の記録を押し出しうる）
- 保証は、検証した中継のコードの版にしか及ばない

## 変更（`patches/0004-agent-wallet-whoami.patch`）

| ファイル | 変更 |
|---|---|
| `src/frontier/agent/gateway.mjs` | `whoami(agentId, credential)`：`submit` と**同じ** `#authenticate` で確かめ、代理・所有者・capability の版・mode・epoch・方針の版・許可・村を返す。何も書かない |
| `src/frontier/routes/agent.mjs` | `POST /f/agent/whoami {agentId, capability}`。代理ごとの回数制限（10回、毎秒1回） |
| `src/frontier/app.mjs` | 公開の経路に追加（資金を使う経路には入れない）。IP ごとの制限（20回、毎秒1回） |
| `mcp/agent-mcp.mjs` | ツール `agent_whoami` |
| `test/agent-wallet-whoami.test.mjs`（新規） | 3件：今の token は答える・何も記録しない（状態ファイルの保存回数、冪等の記録、履歴が増えない）・token を返さない。回された token、別の代理の token、token 無しは `BadCapability`（401）。MCP から使える |
| `test/agent-wallet-mcp.test.mjs` | ツールの一覧の期待を 4 → 5 に（`agent_whoami` を加えた）。**共有の試験の変更** |

## 保証の違い

| | probe（今の暫定策） | `agent_whoami`（0004） |
|---|---|---|
| 記録 | 冪等の記録が1件残る | 何も残らない（試験で確かめた） |
| 認証 | `submit` の認証を通る | 同じ `#authenticate` |
| 送信の可能性 | 検証したツリーでは無い。他のツリーでは分からない | 送信の経路を通らない |
| 中継の版への依存 | 門の順と `NEVER_DELEGATED` に依存 | 依存しない |
| 失効の直後の競合 | 残る（確認の後に回されれば、本操作で断られる） | 同じく残る。**本操作の時の確認は、どちらでも省かない** |

## 試験（使い捨ての worktree、⑤ `29365e60` の基準のツリー `560f8659…` に 0004 だけを当てた物）

- `agent-wallet-*`・`frontier-relay*`：100/100
- `permutation-gateway` の全体：0004 だけで 2,532 件、通過 2,531、失敗 0、スキップ 1。5つ（③ 0005 → 0002b → 0001 → 0003 → 0004）で 2,546 件、通過 2,545、失敗 0、スキップ 1
- ⑤の `checkAccess` は、MCP サーバーの一覧に `agent_whoami` があれば、probe より先にそれを使う（`citizen: checkAccess (stub server) …`）

## ④に決めてほしいこと

1. 採るか。採るなら、返す欄（`allowed`・`village` を含めるか）
2. 回数の制限の値
3. ③の MCP サーバーも同じ口を持つか（③は capability を封印して持つので、同じ確認ができる）
4. 他のパッチとの当てる順（`agent-mcp.mjs` は 0003 とも触れる。組み合わせの結果は `CONTRACT-DIFF-4.ja.md` §9）
