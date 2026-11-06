# 11. ②③④の契約への接続と、⑪との照合（2026-11-05）

**前提：** 補遺 [ADDENDUM-20261030.ja.md](../ADDENDUM-20261030.ja.md) が優先します（回数制限の正本は未決定の3層、StockSwap は工房の代替にしない）。この版から、補遺は git の中にあります。

## 1. 読んだ契約（GitHub の上の実物）

| 担当 | ブランチ | commit | 読んだもの |
|---|---|---|---|
| ② 権利 | `preserve/ws02-rights-dc3bd3d` | `dc3bd3d93465eebb65f1815eb702ca779cc31827` | `workstreams/02-rights/03-CONTRACT.ja.md`、`HANDOFF.ja.md` |
| ③ 外部接続 | `preserve/ws03-mcp-acdcd0bf` | `acdcd0bf795d10a65f6b8192076c4f8d6357e557` | `workstreams/03-composability/02-instruction-matrix.ja.md`、`04-interface-contract.ja.md`、`patches/0006-receipt-port.md` |
| ④ 実行 | `preserve/ws04-a967f5f1` | `a967f5f1c64facc32facf07010f39a679c77d80a` | `workstreams/04-execution/docs/CONTRACTS.ja.md`、`STATE-MACHINE.ja.md`、`QUANTITY-CONTRACT.ja.md`、`CONTINUITY.ja.md`、`contracts/registry.txt`、`src/model.rs` |
| ⑪ 拡張 | `integration/ws09-13-v16-d0949fd4` | `ef63544c727490fc6801d30affd11c5b7106c480` | `workstreams/11-extensions/01-contract.ja.md`、`07-discrepancies.ja.md` |

どれも統合候補・保全ブランチで、main に入った確定仕様ではありません。②④は自分の契約を「提案」としています。

## 2. 定義の側と、実行の側

| | 中身 | 状態 |
|---|---|---|
| **定義の側（⑥が持つ）** | 定義の形式と検証器、作者の署名による公開、公開状態（listed / suspended / withdrawn）、利用者の署名による採用、版・内容ハッシュ・効果の意味の版への固定、更新の通知、写して編集 | ⑥で実装済み。署名は Ed25519（試作の鍵は固定の種）。一覧はローカルだけ |
| **実行の側（④③が持つ）** | 実行の受付（Run）、命令の組み立てと署名・送信、資源の消費、到着の判定、Receipt | ⑥は持たない。⑥の `execute.mjs`・`ledger.mjs`・束は比較のための模擬のまま |
| **つなぎ目（今回の実装）** | `src/connect/caravan.mjs`：採用済みの計画の荷車の手順 → ④の RunSpec。④の Run の結果 → ⑥の結果（数えてよい量、到着量の確度、C の証拠に使えるか）。④の Receipt の重複の除去 | 実装。署名・送信・チェーンの読み取りはしない。場所の記録は、④③がチェーンから読む前提の関数として受け取る |

## 3. 荷車（採用済みの命令）の接続

採用済みの命令は、main の S1 にある `SendCaravan (0xB1)` / `SettleCaravan (0xB2)` だけです。⑥の効果のうち、つながるのは `caravan.send` だけです。

| ⑥の値 | ④の RunSpec / ③の命令 | 対応 |
|---|---|---|
| 計画のハッシュ＋実行の依頼の使い捨て番号＋手順の id | `run_id`（④の冪等キー） | `ws06:<計画のハッシュ>:<番号>:<手順>`。同じ依頼は同じ id |
| 送り元・届け先の論理名（`vault:M-mine` など） | `stock`・`ship.dst`：`{kind, p, q, at, gen}` | ④③が読んだ場所の記録で引く。⑥は位置も世代も作らない。世代は識別の一部 |
| 積荷（⑥の資源名） | `ship.cargo`：8枠、整数単位、S1 の順（food, wood, stone, ore, arms, gold, science, influence） | 名前で枠に入れる。S1 では5番目の枠（コアの Horses）が arms（`arms.rs`：`ARMS = Resource::Horses`、③の `RESOURCES_S1`）。science・influence は誓約だけで運べない。**2026-11-05 版の「arms はコアの資源にない」は誤りで、2026-11-06 に訂正した** |
| 利用者 | `owner`：Citizen の tag | 送り元の持ち主と一致しなければ拒否 |
| 他人の場所あて | ④の保留 `WalletRequired`（session は自分の場所の間だけ。③ 02） | `walletRequired: true` を付ける |
| 定義の版・内容ハッシュ・効果の版 | ④の Run に欄がない | ⑥が `run_id` の横に持つ（`pin`） |
| ― | `seq`（Citizen.CARAVANS）、`steps`・`path`、`fee`（50,000 lamports 以上） | ④③が決める。⑥は入れない |
| ― | `deadline_slot`、`budget` | ⑥の外から渡す（予算は⑤） |
| ― | `facility`（④では必須） | **不一致。** 荷車だけの Run に施設はない。⑥は `null` のまま返し、仮の施設では埋めない |

④の結果 → ⑥の結果（④の数量契約に従う）：

| ④の状態・確度 | ⑥で数える量 | 到着量について言えること | C の証拠 |
|---|---|---|---|
| Fulfilled / Partial、RuleDerived・Recorded | 検証した量（下限） | 少なくともその量（資源ごとに +1 未満の端数がありうる） | 使える（下限まで） |
| DeliveredUnverified、Unverifiable | 0 | **分からない**（0 とは書かない。上限は記録の量 +1） | 使えない |
| Failed、KnownZero（burn・take の記録がある） | 0 | 0 | 使えない |
| Cancelled / Expired、NotShipped | 0 | 送っていない。ただし取消までに起きたこと（effects）はそのまま残す | 使えない |
| 終わっていない状態、保留（DestinationMismatch など） | 0 | まだ決まらない。保留の理由を出す | 使えない |

Receipt は種類と対象（`kind|subject`）で重複を除きます。出どころ（feed か履歴か）の違いは同じ出来事です。

## 4. つながらないもの（正式仕様にしない）

| ⑥の要素 | 理由 | 扱い |
|---|---|---|
| 工房（`workshop.run`） | ②の契約に加工能力の貸出がない。StockSwap は交換で、代替にしない（補遺 §2）。⑥の工房は S2 の UseRun の模擬 | 模擬のまま。接続しない |
| 束（配達の物の押さえ） | ②④に押さえの契約がない。④の Receipt は「過去の出来事の証拠で、今も物が残っている証明ではない」 | 採用保留のまま。⑥の模擬の比較用 |
| 新しい世界効果（D） | コアだけが足す（2026-10-30 の決定） | 何も足さない |
| 前の手順を待つ荷車（`after`） | ④の Run は荷車を1つ送る。後の荷車は前の Run が固定する seq を `inbound` で待つ必要があり、その受け渡しは未接続 | つなげない理由を返す |
| 完了結果の消費（C の `consume`） | ⑥の束・証拠を④の Receipt に置き換える設計が未決定 | つなげない理由を返す |
| 1日の回数 | 補遺 §1 の3層。⑥の模擬の中の制限だけが実装。④の実行サービスで数えるかは統合案。チェーンの強制はない | 変更なし |

## 5. ⑪との照合（状態・識別子）

⑪は⑥の 2026-10-30 の回答を、`01-contract.ja.md` §3 と末尾の確認事項にそのまま記録しています（読んで確認した）。コードの接続はありません。

| 論点 | ⑥ | ⑪ | 照合 |
|---|---|---|---|
| 状態 | 公開状態：listed / suspended / withdrawn（作者＋名前ごと）。公開停止は新しい採用だけを止める | 実行状態：Active / Paused / Revoked（manifest_id ごと）。停止は新しい呼出しを拒否する | **別の系列。** 自動で対応づけない（⑪も同じ記載） |
| 履歴 | `{status, day, seq}`。権限者・理由の欄なし | `history: [(ts, status)]`。⑥の案の欄（権限者・理由・番号）は⑪でも「未実装」 | どちらも案の欄は未実装 |
| 識別子 | 作者の公開鍵＋名前、semver、正準 JSON の SHA-256（接頭辞なし） | `manifest_id = sha256("WYLLS-EXT-MANIFEST" ‖ 0x00 ‖ bytes)` | **別の型。** 同じものとして扱わない。結びつける契約（計画に `{ extension: manifest_id }`）は案のまま、作っていない |
| 更新 | 通知だけ。利用者が新しい計画を確認して置き換える | 新しい id を `supersedes` 付きで登録。Grant は古い id に固定 | 方向は同じ。自動で同じ操作にはならない |
| 権利の失効 | 実行時に止まる（⑥の模擬） | 預かりの出口が開く条件に「Grant の終了」「コアの版の変更」を含む | ⑪は出口の規則を持つ。⑥には預かりがないので対応する欄はない |
| 回数 | 補遺 §1 の3層（⑥は模擬の中だけ） | `calls_left`・`seq` を「チェーンが強制する層」に置いたが、今はホストの試作の中（⑪ 07・08） | 層の名前は合うが、どちらもチェーン上の強制は未実装 |
| 世界の継続 | 論理名で署名し、アドレスは④の移行に任せる（docs/10） | 所有者の変わらない識別で引き、根は④が決める | 方向は同じ（④ CONTINUITY §4.1：Season PDA を世界の口座として固定する案） |

## 6. 試験

`test/connect.test.mjs`（6件）。鍵の生成・取り込み・導出・署名・検証の関数を、呼んだら失敗する関数に置き換えてから走らせます。計画は中身とハッシュだけで作り、署名しません。場所の記録と④の Run は、④の型（`src/model.rs`）に合わせた fixture で、チェーンから読んだものではありません。

## 7. 残件・判断が要ること

1. **④：** RunSpec の `facility` を省ける形にするか（荷車だけの Run）。省けないなら、⑥の荷車の定義は④の Run に載らない。
2. **④：** Run に、定義の固定（作者・名前・版・内容ハッシュ・効果の版）を載せる欄を持つか。今は⑥が `run_id` の横に持つ。
3. **④③：** 論理名から `{kind, p, q, at, gen}` と Citizen の tag を引く読み取り口（herald・findex）。⑥は fixture でしか試していない。
4. **④：** 前の手順を待つ荷車の受け渡し（`inbound` に前の Run の seq を渡す）。
5. （取り消し）⑥の資源名：⑥の `arms` は S1 の5番目の枠と一致していた（§3、2026-11-06 の訂正）。
6. **②：** 加工能力の貸出の契約がない限り、工房は模擬のまま。
7. **⑪：** 計画に manifest_id を含める契約を作るか。
8. 補遺 §1 の回数の正本、緊急停止、束の採否、docs/10 §4 の継続世界の判断は、変わらず未決定。

## 8. ④の行動の登録簿と③の実装への接続（2026-11-06）

**読んだもの：** ④ `claude/gallant-ride-cunptv` = `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（`docs/EXECUTION-CONTRACT-20261106.ja.md`、`src/acts.rs`、`clients/acts.mjs`、`src/model.rs`）、③ `acdcd0bf…`（`mcp/src/game.mjs`・`server.mjs`・`tools.mjs`）、④ の枝にある代理の財布（`permutation-gateway/src/frontier/agent/contract.mjs`・`gateway.mjs`）。③ に新しい版はない。

### 8.1 経路

④の RunSpec は 8e96f24d でも `facility` が必須（`pub facility: FacilityRef`）なので、荷車だけの Run は④の Run に載らない。荷車の送信は、④が⑤⑬③に示した act の経路に載せる。

```
⑥ 採用済みの計画（版・内容ハッシュ・効果の版に固定）
  → toMcpCaravans：③ prepare_caravan の引数 {from, to, cargo[8]}、send_caravan の requestId、⑥の実行 id
  → ③ prepare_caravan（道・seq・命令の欄は③が計算する。⑥は計算しない）
  → ③ send_caravan → 代理の財布 POST /f/agent/action（source mcp、key ws03:<linkId>:<requestId>）
  → ④ runexec act register --source mcp --run <⑥の実行 id>
  → ④ runexec act status / list → resultOfAct（⑥の結果）
```

### 8.2 実物で照合したこと（`test/connect-live.test.mjs`）

| 照合 | 相手の実物 | 結果 |
|---|---|---|
| 資源の順 | ③ `game.mjs` の `RESOURCES_S1` | 一致（⑥の訂正後） |
| 場所 | ③ `Game.placeOf`：⑥の placeId を引ける。他人の場所は `NotYourPlace` | 一致 |
| requestId | ③ `tools.mjs` の `REQUEST_ID`（8〜100文字） | 一致。⑥の requestId は計画・依頼・手順から決まり、同じ判断の再試行は同じ値 |
| 命令の欄 | ③が使う web の `cargoBytes`・`placeData` | 荷の8枠（u32 LE）、届け先の kind/p/q/at/gen が⑥の値と一致 |
| 荷車だけの Run | ④ `src/model.rs` | **不一致を確認**：`facility` は必須 |
| 登録と照会 | ④ `runexec`（8e96f24d からビルド）と `clients/acts.mjs`、台本の `GET /f/agent/fate` | 登録は冪等。同じキーで別の実行 id は `Conflict`。⑥の実行 id は受領書の `runId` に残る。7つの状態がそのまま読める。確定した状態は後の食い違う読みで変わらない（`conflict` として残る）。`list --run` で⑥の実行 id の行動が引ける |
| 財布の要求の形 | ④の枝の `parseActionRequest` | **未実行。** 依存（`@solana/web3.js` など）がこのコンテナに入っておらず、入れていない |

### 8.3 完了扱いにしないもの

`resultOfAct` は、act の受領書から次のように読む。**どの状態も⑥の実行を完了にせず、量も数えない。**

| ④の状態 | ⑥の読み |
|---|---|
| `registered`・`pending` | 待つ |
| `unknown`（結果不明） | 保留。着地したかもしれないので、再送しない |
| `unqueryable`（照会不能） | 読み直す。送信について何も言っていない |
| `landed` | 送信が確定した（荷車は道の上）。**到着と量は未検証** |
| `failed` | 送信が確定的に失敗した |
| `expired`・`not-sent` | 何も起きていないと示せた。やり直すなら、⑥の新しい依頼（新しい番号、新しい requestId）でだけ |

到着と量は、決着の記録を④の数量契約で判定したもの（`resultOf`）からだけ得る。act の登録簿はそれを持たない。

### 8.4 残る不一致・未接続

1. **③：** `send_caravan` の入力は `{planId, requestId}` だけで、⑥の実行 id を④の `act register --run` に渡す欄がない。また③の今の実装は④の登録簿を呼んでいない（④ EXECUTION-CONTRACT §5）。どちらかが要る：③が呼び出し側の実行 id を受け取って登録する、または④が requestId で行動を引ける。
2. **④：** 荷車だけの Run（`facility` を省ける形）。これがない限り、到着・量の判定（`resultOf`）は④の act の経路からは得られない。
3. **③④：** 場所と Citizen の読み取り（③の `get_village_status`）は、ヘラルドとリレーを読む。照合は③の形の fixture で行い、実際のヘラルド・チェーンは読んでいない。
4. 代理の財布の要求の形の検査（`parseActionRequest`）は未実行（§8.2）。
5. 他人の場所あての荷車は、この経路では送らない（送り手の財布の署名が要る）。
