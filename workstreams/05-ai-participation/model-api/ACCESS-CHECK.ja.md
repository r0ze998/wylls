# 開始・再開の前の確認と、token を確かめる暫定策（2026-10-30）

**場所：** `src/access-check.mjs`（`checkAccess`）。自動運転は、開始と再開のたびに、**モデルを呼ぶ前に**これを通します。

**この確認が通っても、本操作の時の確認は省きません。** 実際の `agent_act` の時に、中継はもう一度すべてを確かめます（認証、mode、方針の版、epoch、許可、村、予算、委任）。試験 `autopilot: an inference that fails … the relay refuses the game operation` では、確認が通った後でも、中継が予算で断ります。

## 1. 確かめる順

1. `agent_view`（公開の読み取り）で、次を確かめる。
   - 対象の代理が委任条件のものか（`WrongAgent`）
   - 所有者が、最初に始めた時と同じか（`WrongOwner`）
   - mode が `auto` か（`NotAuto`）
   - 委任があるか（`NotDelegated`）
   - 委任条件の命令が、中継の方針に含まれているか（`ScopeNarrowed`）
2. token そのもの：
   1. MCP サーバーに **`agent_whoami`**（読むだけの認証の口、④向けの変更候補 0004）があれば、それを使う。副作用はありません。
   2. 無ければ、**暫定策の probe**（§2）。明示して有効にした時だけ、検証した中継のツリーに対してだけ、1日の回数の上限の中でだけ使う。
   3. どちらも使えなければ **`TokenUnverifiable`** で止まり、開始も再開もしません。

## 2. 暫定策の probe（隔離）

`agent_act` を1回送ります。中継が認証した後、門で必ず断るようにした要求です。

**保証の根拠**（中継のコードを読み、試験で確かめた物。ツリー `560f8659…` と `98f52eb2…` に限る）：

| 根拠 | 中身 | 場所 |
|---|---|---|
| 受け付ける値の範囲 | `policyVersion` は正の整数、`modeEpoch` は 0 以上の整数。上限は無い。probe は両方に `Number.MAX_SAFE_INTEGER` を送る | `contract.mjs` `parseActionRequest` |
| 認証と確認の順 | 解析 → **認証**（`BadCapability`）→ 冪等の記録の照会 → `#run` → **`#gate`**。`#gate` は保留・組み立て・送信より前 | `gateway.mjs` `submit`・`#run` |
| 門の中の順 | mode → 方針の版（完全一致）→ epoch（完全一致）→ `checkAllowed` → 村 | `gateway.mjs` `#gate` |
| 必ず断られる行動 | probe は `SetSession` を名乗る。`checkAllowed` は `NEVER_DELEGATED` を、方針に関係なく断る（コードの定数） | `policy.mjs` `checkAllowed`、`contract.mjs` `NEVER_DELEGATED` |
| 方針の更新の時 | 方針の版は、本人の更新1回ごとに1つ増えるだけ。同時に更新があっても、`MAX_SAFE_INTEGER` には届かない。仮に版と epoch が一致しても、`SetSession` で断られる | `ledger.mjs:103` |

**保証できない時は止めます：**
- 中継のツリーが一覧（`VERIFIED_RELAY_TREES`）に無い → probe を送らず `TokenUnverifiable`。外から中継のコードの版を知る方法は無いので、ツリーは運営が明示します。試験では、そのツリーがこの checkout と同じかを、別の試験（`relay-tree.test.mjs`）で確かめます。
- 答えが門の拒否（`StalePolicy`）でない → `TokenUnverifiable`。`AgentStopped`・`ActionNotAllowed` も、証拠としては使いません。
- 答えが「送った」 → `ProbeUnsafe` で止まり、報告します。

**副作用（0 ではありません）：**

| 物 | 増えるか | 試験 |
|---|---|---|
| 冪等の記録（`ledger.requests`） | **1回につき1件増える** | `citizen: the probe on the real relay …` |
| 保留・送信・履歴・請求 | 増えない（上の2つのツリーで確かめた） | 同上 |
| 冪等の記録の上限 | 中継は代理1つにつき 2,000 件まで持ち、古い物から消す。**probe を繰り返すと、本物の要求の記録を押し出し、その要求の再送が2回目の送信になりうる** | `citizen: why probes are capped …`（2,000 件の後で、同じ要求が実際にもう一度送られることを示す） |
| 上限 | 1日3回まで（`PROBE_LIMIT`）。超えると `ProbeLimit` で止まる | `citizen: checkAccess (stub server) …` |

**キーの衝突：**
- probe の requestId は `p05.probe.<24桁の16進>`、本物は `p05.<40桁の16進>` です。形が違うので、一致しません（試験あり）。
- 同じ probe のキーを2度使うと、中継は認証した後に記録から答えます（`replayed`）。送信はしません（試験あり）。

**失効の直後の競合：** 確認が通った直後に token が回されると、その回の推論の代金は払われます（防げません）。本操作は `BadCapability` で断られ、自動運転は止まります。試験は `citizen: the owner rotates the capability …` です。

## 3. token の値

token の値は、記録・ログ・受領証・誤りの文・自動運転の状態のどこにも残しません。本人のメモに書かれていれば `[capability]` に置き換えます（試験あり）。

## 4. 正式な口（④向けの独立した変更候補）

`patches/0004-agent-wallet-whoami.patch`（未適用）。説明は `WHOAMI-PROPOSAL-4.ja.md`。これが入れば probe は要らなくなり、副作用もなくなります。

**訂正：** 前回のコミット（`29365e60`）の説明文に「nothing held, sent or added to the history」とありましたが、冪等の記録が1件残ることを書いていませんでした。この文書のとおりに訂正します。
