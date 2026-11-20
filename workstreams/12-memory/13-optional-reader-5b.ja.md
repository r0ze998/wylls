# ⑫ を ⑤B（外部の独立 AI 住人）の「任意の公開証拠リーダー」として差し込む（2026-11-20、Q12-1 A）

> コードが正。`adapters/public-evidence-reader.mjs`、`tools/advise.mjs`、`test/public-evidence-reader.test.mjs`。

## 何を決めたか・何を決めていないか

- **⑤A（運営 AI 住人）には差し込まない。** 所有者の決定（⑤A は決まった、説明できる規則）。`permutation-gateway/src/frontier/local-play-operator-policy.mjs` は⑫を import しない（試験が本文で確かめる）。
- **ゲームの規則は変えない。** リーダーは読むだけ。署名・送信・書き込み・鍵の生成をしない。
- **既定で切。** `createPublicEvidenceReader(...)` は何も読まない。外部住人が `advise({about})` を呼んだときだけ、その 1 回だけ読む。呼ばない住人には何も起きない。
- Q12-1 の推奨 A（⑤B に任意の読み手として出す）と Q12-2 の推奨 A（思い出す量の上限と保存の上限を分ける）に沿う。所有者の新しい判断は要らない。

## どこに差し込むか（⑤B の参照クライアント）

`workstreams/03-composability/mcp/examples/external-resident/agent.mjs` の 1 ラウンドは「観察 → `decide` → 署名 → 送信」。差し込み口は **観察と `decide` の間**。

```js
import { createPublicEvidenceReader } from '../../../../12-memory/adapters/public-evidence-reader.mjs';
const reader = createPublicEvidenceReader({ heraldUrl: herald, io: { getJson } });   // 何も読まない
// 相手を選ぶ場面でだけ:
const evidence = await reader.advise({ about: [wallet1, wallet2] });               // ここで初めて読む
const d = decide(mem, { obs, homes, nowSecs, village, evidence });                // 使うかどうかは住人の AI が決める
```

参照クライアントの `rule.mjs` は今の 6 つの命令（Join・PlaceHome・Harvest・Build・Train・Muster）に相手が無いので、`evidence` を使わない。だから参照クライアントのコードは変えていない。別の言語の住人は `node workstreams/12-memory/tools/advise.mjs --herald URL --about W1,W2` で同じ答えを 1 行の JSON で受け取れる。

## 何を読むか

| 入力 | 必須 | 読み方 |
|---|---|---|
| herald `/h/season`・`/h/events`・`/h/me/{wallet}` | 必須 | `observeLive` そのまま。頁は `recall.eventPages` まで。足りなければ時計は不完全として全件保留 |
| RPC `getSlot(finalized)` | 任意 | クラスタとの対応の宣言（`rpcBinding`）が要る。無ければ `rpc_not_given`、記録は保留 |
| ④の store（runexec SQLite、読み取りのみ） | 任意 | 世界の宣言（`binding`）が要る。無ければ `ws04_store_not_given`、記録は保留 |
| 住人自身の⑫の記憶（`own: {memory, viewer}`） | 任意 | 住人が当事者として持つ約束・メモの行と reliability。読むだけ |

## 何を返すか（相手ごと）

- `status`：`ok`（herald がこの世界の市民と対にした）／`identity_unverified`／`world_unverified`。
- `facts`：その市民の隊商の公開事実の件数（送った・届いた／失った・襲われた・襲った・加算）と、新しい順に数件（出典と basis 付き）。**記録が保留のときは `held: true`、`counts: null`（不明であってゼロではない）。**
- `own`：渡されたときだけ、住人自身の記憶の行（上限付き、文字数も切る）と reliability。
- 全体：`reasons`（上限付き）、`provenance`（呼び手の申告を上げない：chain の札は integration-output に下げる）、`recall`（使った上限、読まなかった相手の一覧）。
- 決定はしない。caution は誠実さの判定ではない（`advise.mjs` の CAUTION）。

## 上限（Q12-2 A）

`RECALL_DEFAULT` = 相手 4、事実 6、行 6、1 行 200 文字、herald 頁 16、理由 12。呼び手は `RECALL_MAX`（16・32・24・280・64・32）まで上げられ、それ以上は上がらない。上限は **読む量** の上限で、⑫ の journal（住人が持つ場合）を削らない。リーダー自身は呼び出しの間に何も持たない。

## 今の限界

1. ローカル遊びの世界には④の store が無く、RPC も住人の proxy から見えない。だから今のローカル世界では `facts` はいつも `held`（不明）。市民の対応（`status: ok`）だけが分かる。
2. 公開記録には約束（会話）が無いので、評判（reliability）は住人が自分の記憶を渡したときだけ出る。
3. MCP の道具にはしていない（③ の read-only サーバーの道具一覧と source pin を変えない）。必要なら ③ 側で `get_public_evidence` のような read 道具を足す設計になる（未実装）。
