# 一連の操作（NFT 参加 → 権限撤回 → 荷車 → 記憶 → 成果 → 賞金）（④、2026-11-06、ローカルのみ・push していない）

**目的**：同じ統合版の上で、各担当の実装を一本の流れとして動かす。④が流れをつなぎ、⑯が独立に受入検証する。

**利用者の CC と重ねない部分**（④は実装していない）：

- マップの配置・拡張
- NFT 賞金
- 荷車 Run の受付・照会

④の差分はこれらのファイルに触れていません（§5 の一覧）。

**鍵**：どの段でも、鍵の生成・導出・署名はしていません。

- アドレスは、固定の 32 byte か、program 自身が hash で計算するもの（PDA、with-seed）だけです。
- 署名者は、「署名した」と試験が宣言した鍵の集合です。署名そのものは存在しません。
- Node の段は `scripts/ci/no-keys-guard.mjs` を先に読み込んで動かします。

## 1. 動かし方（空の環境から）

1. 統合版の木を取り出す（§6 の SHA）。
2. 依存を取得しておく（`cargo fetch`。network が要るのはここだけ）。
3. `workstreams/04-execution/tools/chain-flow/run.sh [出力先]` を実行する。
   - 段 A・B は `cargo --offline` で動きます。
   - 必要なもの：Rust 1.89 以上、Node 22（`node:sqlite`）。

## 2. 各段と結果（2026-11-06、この木で）

| 段 | 何が本物で動くか | 結果 |
|---|---|---|
| A 参加・撤回 | game program の `dispatch`（`nft-experimental`、⑳ 45d95e31／dc55f159 の JoinResident 0xE1、ResidentAct 0xE2）を e2e-native の host で動かす。loader の入力形式を通し、System の CPI（Allocate、Assign、AllocateWithSeed、Transfer）を通し、lamport の総量を取引ごとに確かめる | 2/2 合格 |
| B 荷車 | runexec（④）の荷車だけの Run。owner は、A の Citizen の `citizen_tag` | 1/1 合格。Fulfilled、receipt は caravan_sent と caravan_settled |
| C 記憶 | ⑫ の adapter（`readWs04Store`、`ingestReceipts`）。変更せずに使った | fact 4 件（identity_alias、caravan_sent、caravan_settled、caravan_credited）。held は 0、再投入で増えない |
| D 成果 | ⑮ の adapter（`fromRunReceipts`）と `normalize`。変更せずに使った | §3 の F1。④の対応付け（提案）を通すと ship.send と ship.arrive がどちらも `chain`、拒否は 0 |
| E 賞金 | 動かしていない（利用者の CC が実装中） | 賞金の段が受け取る入力を `e-prize.json` に書いた |

### 段 A で確かめたこと（完成条件）

- **正しい参加**：Citizen が `citizen_by_tag15(resident id)` にでき、owner は game program。
  - link（`["nft-citizen-link", season, asset]`）が、この Citizen と asset を記録する。
  - RESIDENT_JOINED（kind 130）が 1 件記録される。key は resident id、generation は 0。
- **重複**：同じ NFT の 2 回目は AlreadyDone。口座は何も変わらない。
- **欠落**：所有者が署名していないと拒否される（host ではなく program が拒否する）。
- **不一致**：
  - 所有者でない鍵 → ResidentNotCurrentAuthority。
  - 世代の違い → ResidentStaleGeneration。
  - 別の世界の link の address → 拒否。
- **偽造**：
  - 移転ガードのない asset → 拒否。
  - 別の collection → ResidentAsset。
  - 別の asset の resident record → ResidentAccount。
  - Core 以外が所有する asset → 拒否。
  - どの場合も Citizen と link は作られない。
- **撤回**：A から B へ譲渡すると、世代が 1 になる。
  - A は古い署名（世代 0）でも新しい署名（世代 1）でも拒否される。
  - B は世代 1 ですぐに動ける。
  - Citizen は元の場所に残る。パスとともに移るので、荷車・記憶・成果が使う tag も変わらない。

**限界**：

- 署名の検証そのものは動かしていません（`is_signer` は試験が置く）。
- SBF の build と compute budget は対象外です。
- Metaplex Core と resident program は動かしていません。それらの口座は、⑳ の配置どおりの byte で置いています。

## 3. 見つかったこと（担当へ）

- **F1（⑮）**：`adapters/ws04.mjs` は、受け取る receipt の body に次の欄があると想定しています。
  - caravan_sent：`body.owner_tag`、`body.dst`
  - caravan_settled：`body.verification`
  - ④の実際の receipt には、どれもありません。
    - caravan_sent の body は `{seq, cargo, content_from}` です。
    - caravan_settled の body は `{key{owner,seq}, dst, cargo, credited, outcome, slot}` です。
  - その結果、送りは「unresolved」として飛ばされ、着荷は `unverified` として数えられます。
  - ④の対応付け（`stages-cde.mjs` の D2。提案で、決めるのは⑮）：
    - owner は subject の 16 進の tag から取る。
    - 行き先は Run の spec（`ship.dst`）から取る。
    - 検証の種類は Run の結果（`detail.outcome.verification`）から取る。
- **F2（⑫）**：記憶の principal は、citizen tag か base58 の address しか受け付けません。NFT パスを表す型がありません。
  - 流れでは、パスの asset の address を principal にしました。
  - owner の wallet は譲渡で変わるので、principal には使いませんでした。
  - これでよいかは⑫が確認してください。
  - あわせて、`ingestReceipts` は `memory.observe` が投げた RecordError をそのまま外へ出します。`refused` として数えません。
- **F3（④、修正済み）**：runexec の試験の `check_store` は、荷車だけの Run の正しい遷移（Accepted → FacilityConfirmed）を拒否していました（30a3fd2e の漏れ）。
  - `allowed_for` を使うよう直しました。
  - cargo_only の試験でも確かめるようにしました。

## 4. 賞金の段へ渡すもの（利用者の CC へ。④は実装していない）

- **入力**（`e-prize.json`）：season、Citizen、`citizen_tag`、asset、譲渡後の owner と世代、成果の event。
- **方針**（利用者の決定）：全プレイヤーが NFT パスを持つ。譲渡前の未受取賞金は、パスとともに新しい所有者へ移る。
  - 段 A は、この方針と矛盾しないことを示しています。
    - Citizen と tag はパスに付いたまま残る。
    - 古い所有者は、すぐに動けなくなる。
- **賞金の段の接点**（提案）：
  - NFT Citizen の Claim の権限は「パスの現在の所有者で、現在の世代」とする（ResidentAct と同じ）。参加した時の wallet ではない。
  - Entry と RecordNation は Citizen に紐づくので、譲渡前の分は新しい所有者が受け取れる。
- **未決**：返金、ほかの資産・履歴の移転。④は決めていません。
- **Run の受付**（利用者の CC）：runexec は spec をそのまま受け付けます。この Citizen の Run を頼めるのはパスの現在の権限者だけ、という確認は、受付の側で必要です。

## 5. 触れたファイル（差分の照合用）

- `workstreams/04-execution/e2e-native/Cargo.toml`：feature `nft`（既定では off）
- `workstreams/04-execution/e2e-native/src/lib.rs`：MOCK System に Allocate、Assign、AllocateWithSeed を加え、`sol_log_data` を記録する
- `workstreams/04-execution/e2e-native/tests/chain_nft.rs`（新規）：段 A
- `workstreams/04-execution/tests/chain_caravan.rs`（新規）：段 B（`--ignored`）
- `workstreams/04-execution/tests/common/mod.rs`、`tests/cargo_only.rs`：F3
- `workstreams/04-execution/tools/chain-flow/run.sh`、`stages-cde.mjs`（新規）：段 C・D・E と全体

game program、prize、⑫、⑮、⑳ のファイルは変えていません。

## 6. 版

- **基点**：公開線 `ws04/int-20261106-pub` の 6984acfa4c0f9919c8c424a9bd5f2d59193d1639。
- **この commit**：ローカルのみ。SHA と tree は、受渡しの bundle に添えます。

## 7. PDA の算出について（追記）

- **段 A・B は PDA を算出します**。対象は Season、link、policy、Citizen の with-seed です。
  - ④は、利用者の回答（「鍵ペアと署名」が禁止の範囲）に従って、2026-11-06 に一度だけ実行しました。
- **⑯と⑲の連絡**：利用者の新しい指示で、PDA の算出も対象外になった、とのことです。
  - ④は、範囲を利用者に確かめるまで、PDA を算出する段（A・B）を再び実行しません。
- **PDA なしで照合する方法**：その実行の各段の入出力を、固定のファイルとして残しました（`tools/chain-flow/fixtures-20261106/`）。
  - `a-join.json` から `e-prize.json` まで。`b-store-dump.json` は store の receipts、runs、world を JSON にしたものです。
  - `node --import ./scripts/ci/no-keys-guard.mjs workstreams/04-execution/tools/chain-flow/check-fixtures.mjs` で、段の間の整合を PDA なしで確かめられます。
    - 確かめる内容：citizen_tag と Citizen の address の関係、記録の key、receipt の owner（u64 で正確に）、⑫ の sender、⑮ の event。
    - 結果：22/22 が整合しました。
  - **限界**：address そのものは、段 A で program が計算した値をそのまま使います。この照合は段どうしが一致することを示すだけで、address が正しいことは示しません。

## 8. 利用者の確認（2026-11-06、追記）

**確認の結果**：④でも、PDA の算出は禁止です。

**この木での扱い**
- `run.sh` は、既定では PDA なしの照合（`check-fixtures.mjs`）だけを動かします。
- 段 A〜E は、`CHAIN_PDA=approved` を付けたときだけ動きます。付けるには利用者の承認が要ります。
- §1 の手順 3 は、この承認がある場合だけ行えます。

**④の作業の範囲**
- 段 A・B と e2e-native の既存の試験は、④は実行しません。e2e-native の既存の試験も、prize と game の PDA を算出します。

**未対応**：CI の提案（KEY-FREE-CI）は、まだ見直していません。
- 提案の `exec-native` と、Frontier・prize の host の試験などに、PDA を算出するものが含まれます。
- この規則に合わせた見直しが必要です。
