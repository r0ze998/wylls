# 01 既存の AI 市民・エージェント財布：再利用したもの、使えなかった経路

調べた対象（4cd901de）：`permutation-gateway/citizens/**`（AI 市民の mind・記憶・social・監査）、`permutation-gateway/src/frontier/agent/**`（エージェント財布＝人間の村の代理）、`frontier-node/crates/bots/src/ai`（AI 市民の brain、Rust）、`docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md`、`docs/agent-wallet/DESIGN.md`、`docs/design/redesign/24-ai-roles.ja.md`、`docs/frontier/playtest-kou/RESIDENTS.ja.md`。AGENTS.md と workstreams 用のスキルは、どのブランチにもなかった（`workstreams/` は③の `claude/modest-goldberg-c180fk` にのみあり、その書き方に合わせた）。④⑤⑫の作業はどのリモートブランチにもまだない（2026-10-30 に `git fetch` で確認）。

## 1. 変更せずに import して使ったもの（事実）

| 既存コード | 住民での使い道 |
|---|---|
| `src/frontier/agent/ledger.mjs` `AgentLedger` | 住民ごとの推論予算：保留→実行中→精算、1日の回数上限 `callsPerDay`、総額・日額、再起動時の `unresolved`、収支の検査 `check()`。所有者＝住民の所有者、`agentKey`＝住民の鍵 |
| `src/frontier/agent/owner-auth.mjs` `verifyCommand`・`signCommand` | 所有者の停止・再開（mode コマンド）。期限・nonce の一回性・署名者の確認 |
| `src/config.mjs` `createStateStore` | 状態ファイルの原子的な保存（一時ファイル＋rename）。journal と台帳を一つのファイルに置き、同時に保存 |
| `citizens/mind/sanitize.mjs` `sanitize`・`wrapUntrusted`・`wrapMemory` | 依頼文の無害化と、provider に渡すときの untrusted 囲み |
| `citizens/mind/schema.mjs` `WHY_MAX_CODEPOINTS` | 理由文の上限 |
| `citizens/mind/guards.mjs` `assertNoApiKeys`・`canonicalJson` | 有料 API の鍵があれば起動しない／署名する JSON の正規化 |
| `citizens/memory/retrieve.mjs` `retrieve` | 記憶の想起（重要度×減衰×関係者の重なり） |
| `citizens/social/limits.mjs` `TALK_PER_BELL`・`TALK_PER_DAY` | 掲示板の送信者ごとの上限（3/ターン、40/日） |
| `client/src/talk-node.mjs` `signTalk`・`verifyTalk`、`client/src/base58.mjs` | 署名とアドレス |
| `src/frontier/agent/runner.mjs` `CATALOG_S1`・`RESOURCES_S1` | S1 の建物の費用・生産（arms.rs に固定済み） |
| `src/frontier/quota.mjs` `QUOTA` | 中継の1日の取引数 |

数値（初期資源・基本生産・保管上限・隊商の速さと手数料・行動バケット）は Rust から読み戻す試験で固定した（`test/rules-pinned.test.mjs`）。

## 2. 設計として合わせたもの（コードは別）

- **コードが候補を出し、選ぶ側が選び、コードが確かめる**（AI-CITIZENS-CONTRACT §4）。住民の候補は `candidates.mjs`、選ぶのは provider、確かめるのは `validateResponse`（候補 id の enum、理由の無害化、記憶 handle の照合）。
- **約束は code の義務として果たす**（同 §3.1 の duties を先に送る考え方）。依頼が届いたら申し出た品を返す送りは、モデルに選ばせない。
- **遅い・不正・拒否された回答は fallback**（同 §3.6）。ただし既定の fallback は新しい約束をしない（⑤の Autopilot に置き換える口）。
- **呼んだ推論は応答の有無にかかわらず課金**（エージェント財布、所有者の決定 2026-10-17）。

## 3. 使えなかった既存経路と理由

| 経路 | 状態（コードを読んだ結果） | 住民に要るもの |
|---|---|---|
| AI 市民の判断経路（Rust の bot `--brain` → mind `/v1/decide`） | bot fleet が鍵を持ち、候補は brain（Rust）が作る。S1 の候補は「満杯に近い倉からの隊商・待ち伏せ・護衛」の3種で、**依頼・協力・断りの候補はない** | 依頼板と、依頼を受ける／断る候補。今回は Node の住民側に置いた |
| エージェント財布の実行（`AgentGateway.submit`） | 所有者の村を session 鍵で動かす**代理**の経路。委任できる行動に **S1 の SendCaravan・BuildVault がない**（`contract.mjs ACTION_GROUPS`、`gateway.mjs accountsFor`） | 住民は代理ではないので、自分の財布鍵で relay に直接送る（ブラウザと同じ）。ただし Node で S1 の SendCaravan を組む builder がゲートウェイにない（web の `fplay.mjs` にはある）。④への要求として [patches/README.ja.md](patches/README.ja.md) に記載 |
| 参加（`relay.mjs /f/join` の運営招待、x402 の参加費） | AI 市民と script bot は**運営招待で参加費なし・賞金対象外**（`achievements.mjs operatorInvited`）。人間は x402 で参加費を払う | 設計の決定（24-ai-roles §2「参加費は人間もAIも同じ」）と食い違う。どちらで参加するかは所有者の判断（資金の徴収方式・賞金対象を含むため、決めていない） |
| 観測（herald `/h/*`） | 公開記録の読み出し。住民の `observe()` に置き換えられる形 | チェーンがないので未接続 |
| 依頼の記録 | social 層の記録種は talk・ballot・council。依頼・返答はない | 模擬の掲示板（`world/board.mjs`）。social 層への追加は提案（[03](03-contracts.ja.md) §5） |
| 試遊の「運営の住人」（`playtest-kou/RESIDENTS.ja.md`） | 人が手で動かす、役割の決まった住人（北の軍需組合、南の工房の貸し出し） | 参考のみ。指示どおり恒久的な職業・国別の役割にはしていない（目的は重みだけ。[03](03-contracts.ja.md) §1） |
