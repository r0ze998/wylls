# 01 既存の利用可能範囲（作り直さずに整理）

外部の作者が今の WYLLS に作用するための部品を、**MCP、SDK、CPI を別の機能として**並べる。三つは「誰が署名し、どこで検査され、何と一緒に原子的に動けるか」が違う。

| 経路 | 何をするか | 署名するのは | 検査する場所 | 他の操作との原子的な合成 |
|---|---|---|---|---|
| **MCP**（`permutation-gateway/mcp/agent-mcp.mjs`） | 外部の AI アプリが、運営の relay に「この1体のエージェントの行動」を頼む | relay が保管するエージェントの session 鍵（AI アプリは鍵を見ない） | relay のサーバー（方針・予算・許可行動・1村の規則）＋チェーン（session の範囲） | なし（relay が1命令ずつ送る） |
| **SDK**（Rust の `frontier-abi`・`fclient`、JS の `client/src/frontier`） | 外部のクライアントが自分で命令を組み、署名し、relay か RPC に送る | 所有者の wallet か session 鍵 | チェーン（＋relay を使うなら relay の shape 検査） | 同じトランザクションに複数命令を並べられる（制約は [03](03-composition.ja.md)） |
| **CPI**（この担当の `courier/`） | 別の作者の**オンチェーンプログラム**が、自分の処理と Frontier の命令を1つの命令の中で合成する | 外側のトランザクションの署名（所有者）か、呼び出し側プログラムの PDA（session 鍵に設定された場合） | チェーン（Frontier が全規則を再検査）＋呼び出し側プログラム自身の規則 | 呼び出し側の処理と Frontier の命令が同じ命令内で成否を共にする |

MCP は「運営に頼む」経路、SDK は「自分で取引を作る」道具、CPI は「別のプログラムが取引の一部になる」経路で、互いの代わりにならない。MCP で許されていることが CPI で許されるわけではなく、その逆もない。

## 1. ABI（`frontier-abi`、Rust、no_std）

**事実（courier で確認）:** 別の SBF プログラムがこの crate に依存してビルドでき（SBPF v2、platform-tools v1.52）、以下をそのまま使える。courier は Frontier プログラム本体には依存していない。

| 部品 | 場所 | 外部作者にとっての意味 |
|---|---|---|
| 命令タグ・class・`top_level_only`・relay shape | `src/v2/tags.rs` | タグは再利用されない（M1 契約 §5.5）。`top_level_only=true` の 13 命令は CPI を `NotTopLevel` で拒否 |
| 命令データの型と符号化 | `src/v2/ix.rs`（`SendCaravan::to_bytes`/`decode` など） | 固定長・リトルエンディアン・タグ先頭。courier は受け取ったデータを `SendCaravan::decode` で型検査してから転送する |
| 口座の並び（数・署名・書込・種類） | `src/v2/prologue.rs` `accounts_of` | Frontier が最初に照合する表。CPI でも同じ表で検査される |
| 口座の配置・magic・大きさ | `src/v2/layout/` | courier は Season の `PROGRAM_VERSION`・`RULESET_HASH`、Citizen の `WALLET` をこれで読む |
| アドレス | `src/addr.rs`、`src/v2/addr.rs` | Season は PDA `["season", le64(id), bump]`、それ以外は `create_with_seed(season_pda, "<種別>‖hex(key)", program)` |
| エラー | `src/error.rs`（`FrontierError` 1–61, 99）、`src/v2/error.rs`（`CqError` 62 以降） | CPI 越しでも同じ番号で返る（`assert_code` が Frontier 自身の失敗行を確認） |
| 予算 | `src/v2/budgets.rs`（`cu_limit_s1`、`loaded_limit_s1`、`budget().tx_contract`） | relay はこの値と**完全一致**の compute-budget 前置きを要求する |
| 版 | `src/v2/presets.rs`（`PROGRAM_VERSION_S1 = 4`、`RULESET_HASH_V3`） | 接続先の版の判定に使う（courier の `FrontierVersion`） |
| JSON ベクタ | `frontier-abi/vectors/v2/*.json` | JS の生成元（`permutation-gateway/scripts/sync-web-sdk.mjs`） |

## 2. 命令 builder と記録の読み取り（`frontier-node/crates/fclient`、Rust、std）

**事実（courier-tests で使用）:** `fclient::ix::v2::send_caravan` などの builder が Frontier 命令をそのまま組む。外部作者はこれで内側の命令を作り、courier 用に包む（`courier-tests/src/lib.rs` の `send_signed`、`send_delegated`）。`fclient::log::bodies_from_logs` は**入れ子のフレームを追い**、CPI で Frontier が出した記録も Frontier の記録として取り出す（`t01` が CPI 取引の CARAVAN_SENT を解読）。`fclient::conquest::parse` が S1 の記録を型にする。

## 3. JS の SDK（`permutation-gateway/client/src/frontier/`）

- `abi-*.mjs`: ABI ベクタからの生成物（編集しない）。
- `codec.mjs`: `ixOf`、`accountSpec`、`encodeIxData`/`decodeIxData`。
- `shapes.mjs`: `frontierIx`（ABI 名と口座名から命令を組む）、`shapeMessage`（relay 用の取引）、`classify`（relay の shape 判定そのもの）。
- `budgets.mjs`、`addresses.mjs`、`fees.mjs`、`herald.mjs`、`seal.mjs`、`profile.mjs`。
- ブラウザ用の同じものが `permutation-server/web/sdk/`（同期スクリプトで複製）。

**注意（コードを読んだ結果）:** `permutation-gateway/client/README.md` と `GameClient`（`src/game.mjs` 系）は**旧版（V5 の官職・MagicBlock）**の API を説明しており、Frontier（現行 S1）の書込経路ではない。外部作者に渡す入口としては古い。

## 4. Herald（`frontier-node/crates/herald`、読取専用 HTTP）

`/h/season`、`/h/world`、`/h/events`、`/h/caravans.json`、`/h/structures.json`、`/h/nations.json`、`/h/me/{wallet}`、`/h/province/...`、`/h/ws` など。書込経路はない。記録はログから読むので、CPI で送った隊商も**ログの解読としては**拾える見込み（`bodies_from_logs` が入れ子を扱う）。Herald 自体を CPI 取引で動かした確認は**していない**（未実行）。

## 5. relay（`permutation-gateway/src/frontier/routes/relay.mjs`）

- `GET /f/relay`、`POST /f/relay`（player shape と settle shape のみ）、`POST /f/join`、エージェント経路 `/f/agent/action`。
- 検査の順序: 厳密な解析 → shape 許可表（`classify`: 前置き3命令＋Frontier 命令1つ、CU 価格 0、CU 上限と `L(kind)` が表と一致、口座と署名者が ABI どおり、余分な鍵なし）→ fee payer が relay のもの・この season → 署名 → 再送と速度制限 → quota → 共同署名 → 署名つき模擬実行 → drain guard → 送信。
- courier の取引は最初の `classify` で拒否される（[05](05-relay.ja.md)）。

## 6. MCP（`permutation-gateway/mcp/agent-mcp.mjs`）

ツールは `agent_view`、`agent_terms`、`agent_act`、`world_read`。1体のエージェントについて、所有者が許した行動群（`economy`: Harvest/Build/Train/Muster/Garrison、`explore`: Explore、`military`: Depart/Dissolve、`vigil`: SetVigil）だけを relay に頼める。**SendCaravan は許可行動に入っていない**（`src/frontier/agent/contract.mjs` `ACTION_GROUPS`）。MCP は CPI とも SDK とも別物で、この担当では変更しない。

## 7. 既存の CPI の検査

- `permutation-frontier/svm-tests/probe/`（tag 3: 汎用の CPI forwarder）と `g13_top_level_only_instructions_refuse_a_cpi` は、**拒否される側**（`NotTopLevel`）だけを確かめている。CPI で**成功する**ことと、その時に規則が保たれることを確かめた試験は、この担当の `courier-tests` が初めて（基準 commit の範囲で検索した結果）。
- `fclient::log` の単体試験が入れ子フレームの記録の帰属を確かめている。
