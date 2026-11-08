# ⑯ 独立検証 報告書（2026-10-30、2026-10-31 更新）

> **2026-10-31 の更新**: 第 2 期（⑰決済・⑱秘密の進軍・⑲MagicBlock/公開運用、§8）と、所有者の方針訂正「シーズン制の廃止・世界の継続」を受けた第 3 期（§9、4 点構成）を追記。§0〜§7 は第 1 期（①〜⑮の横断）のまま。

担当: ⑯（①〜⑮とは別の立場）。目的は「個別テストは通るが、組み合わせると壊れる」箇所を、実行可能な再現テストで示し、担当が直せる形で渡すこと。本体・台帳・実行器は作っていない。push・merge・deploy・実資金・有料 API・鍵設定・Agave 導入は行っていない。

関連文書: [成果物の一覧（SHA・tree・欠落）](INVENTORY.ja.md) · [不変条件](INVARIANTS.ja.md) · [実行手順](README.ja.md) · [修正候補パッチ](patches/README.ja.md) · [ログ](logs/)

## 0. 結論（先に）

| 区分 | 件数 | 内容 |
|---|---|---|
| **統合を止めるもの**（実コードで再現） | 3 | X2 検証器が未知／予約タグの命令を PASS 扱い（③の CPI 形も WARN 止まり）、B1 gateway の冪等記録が 2,000 件で消え古い要求が**再送信**される、A1 略奪で奪われた隊商が feed と画面で**元の持ち主のまま**（契約 J2 違反の表示） |
| **後で改善できるもの**（実コードで再現） | 4 | C2 feed が損耗率を落とす、A7 ③の委任中に Web が「鍵を作り直す」を提示（黙って委任解除）、C3 ウォレット切替に画面が追従しない、A3/C1 記録が「容量超過で消えた量」「焼失後の空荷」を表せない |
| 仕様未決定（判断材料のみ） | 3 | B8 本人 MCP と runner の同一ターン二重行動、A6' 施設喪失時の積荷（LOST で消失。所有権は未決定のまま）、A9 ⑩（鉱石のみ）と ⑨（鉱石+木材）の接続不能部分 |
| 文書とコードの食い違い | 7 | §5 |
| 未実行（環境・実物の不在） | — | §6 |

接続して確かめた実物: 基点 `4cd901de`（= `main` `92142932`）の keeper / herald / verify / gateway (agent wallet, MCP) / Web client、および同じ ABI・規則カーネル。③ `2f8ec700` は文書・パッチ案を読み、その前提（検証器がトップレベル命令のみ）を verify の実行で裏取りした。**①②④〜⑮の実物は入手できず**（§6）、流れ A/B/C は基点の該当部品を代役に検証した。プログラム本体（SBF）は未実行で、Rust ソースの読解と、消費側の実行で裏取りした。

## 1. 使用した成果物

[INVENTORY.ja.md](INVENTORY.ja.md) に完全 SHA・tree・パッチ順を記す。要点: 基点 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（tree `fb0635892650f4ae2b028ec488d14ddb75fe5eeb`）。③ = `2f8ec700fa7533d7fd61c87b5a84f31d05420325`（指示の `acdcd0bf` の後続版、パッチ案 0001–0004 は未適用のまま）。他の 14 件の候補 SHA は origin・ローカル・Drive・Remote Control のいずれにも無い。

## 2. 再現テスト（実行可能）

実行手順は [README.ja.md](README.ja.md)。未修正の基点での結果（`logs/base-*.log`）と、修正候補を当てた隔離コピーでの結果（`logs/patched-*.log`）を併記。

| ID | 試験 | 基点 | パッチ後 |
|---|---|---|---|
| X2, X2b | `verify/tests/v16_unknown_tag.rs` 予約タグ 0xBF／未知タグ 0xE0 の着地命令 | **PASS になる（失敗）** | FAIL `UnknownInstruction`（通る） |
| A8 | 同上 CPI 形（プログラムを口座に挙げ、命令は別プログラム） | **WARN のみで PASS（失敗）** | `MissingData` → Unverifiable（通る） |
| A1, A1c | `herald/tests/v16_caravan_holder.rs` TAKE 後の持ち主・`raided` | **元の持ち主、raided=false（失敗）** | `holderTag` = raider、raided=true（通る） |
| C2 | 同上 `worn_bps` | **feed に無い（失敗）** | `wornBps`（通る） |
| A2 | 同上 同一鍵の再 SENT | 1 件に留まる（通る） | 通る |
| B1 | `v16-agent-wallet-replay.test.mjs` 2,000 件後の同一 key 再送 | **新しい取引が送られる（失敗）** | replayed（通る） |
| B7 | 同上 agent ごとの requestId 名前空間 | 通る | 通る |
| B8 | `v16-agent-wallet-contention.test.mjs` MCP と runner の同一ティック | 2 件とも sent（記録） | 同左 |
| A1, A1b | `v16-web-caravan-holder.test.mjs` 画面の「自分の隊商」・地図の own | **被害者側に表示（失敗）** | 通る |
| A7 | 同上 ③ courier の session 鍵 | **null → 「鍵を作り直す」（失敗）** | foreign（通る） |
| C3 | `v16-web-wallet-switch.test.mjs`（controller の 2 行を**模擬**） | **旧アカウントのまま（失敗）** | 模擬のため不変。P6 は読解と既存試験で確認 |

既存スイートへの影響（修正候補を当てた隔離コピー）: `cargo test -p verify` 全件通過（tamper 58 件を含む、`logs/patched-verify-suite.log`）、`cargo test -p herald`（cq_fold 15・fold 11）通過、`npm test` 2,536 件中 2,533 通過・1 skip・失敗 2 = C3（模擬、想定どおり）と言語表の完全性（P5 の英訳追加で解消、`logs/patched-node-p5-lang.log`）。

変異試験: 既存の安全機構「冪等記録は agent ごと」を一つ壊した（`ledger.request/remember` を全体共有に）ところ、B7 が FAIL で検出した（`logs/mutation-M1-global-idempotency.log`）。P1〜P5 については「未修正で FAIL／修正で PASS」が各試験で成り立つ。

乱択試験は行っていない（固定順の再現のみ）。

## 3. 不具合ごとの詳細

### X2 検証器が未知タグ・予約タグの命令を判定せず PASS（統合を止める）
- **影響**: 「⑩の新処理を含むプログラムが旧 v3 のハッシュを名乗る」が起きた場合、新命令は `Ix::from_tag` が `None` を返し、V23/V24/V25/facts のすべてが `continue` で読み飛ばす（`verify/src/checks/v23_caravans.rs:1105`, `v24_structures.rs:731`, `v25_nations.rs:379`, `facts.rs:167`）。V2 は「命令が一つも無い取引」だけを WARN にする（`checks/v2_program.rs:66-78`）。判定されない命令が記録と口座を書き換えても、記録側の検査に掛からなければ PASS。「新タグを表に足すだけ」でも同じ（判定が無ければ読み飛ばし）。⑪の未知タグ対策だけでは防げない理由がここにある: 表に**ある**が判定の**無い**タグ（SetSession, SetVigil, FastForward, CloseMarch, FoldOccupancy など 34/74）も同じ経路。
- **再現条件**: fixture `march-program.json.gz` に `[0xBF,0,0,0]` の Frontier 命令 1 件を足す。
- **期待**: FAIL または Unverifiable。**実際**: PASS、所見ゼロ。
- **担当**: ⑦⑪（検証器）。**最小修正**: P1（未知／予約タグ → FAIL `UnknownInstruction`）。次段: 判定の無い既知タグの一覧を verify に持ち、`Warn` を出す。
- RULESET_HASH は定数で、規則カーネルの「定数」だけから導かれ、コードを束縛しない（`permutation-rules/src/frontier/mod.rs:130-138` が明言）。`--program-hash` を渡したときだけ .so のハッシュを照合する（`verify/src/main.rs:106`）。公開季節の検証では `--program-hash` を必須にすべき。

### A8 CPI 形の取引が WARN 止まり（③の採用前提。統合を止める）
- 検証器はトップレベルの Frontier 命令だけを `tx.ixs` に集める（`verify/src/world.rs:337-350`）。③ courier のように別プログラムが CPI で SendCaravan を呼ぶと、記録と post 状態はあるのに判定する命令が無く、V2 が WARN を出すだけで PASS。③自身が 0002 で指摘しているとおり。P1 は暫定で Unverifiable にする。本修正は③ 0002（findex が `innerInstructions` を保存し、verify が inner 命令を判定）。

### B1 冪等記録の上限で古い要求が再送信される（統合を止める）
- **影響**: `ledger.remember` は agent ごとに 2,000 件を超えると古い順に削除（`ledger.mjs REQUESTS_MAX`）。削除された key の再送（MCP の retry、runner の再試行、再起動後の再送）は `submit` が新規として扱い、**もう一度送信**する。DESIGN §6.6・MCP ツール説明「reuse it to retry … it is never sent twice」に反する。X5「詳細履歴を削ったあとに古い要求が再実行される」の実例。
- **再現**: sent 1 件 → refused 2,000 件 → 最初の key を再送 → `status: sent` かつ新しい signature、`replayed` 無し（`logs/base-node-v16.log`）。
- **担当**: ④⑤（基点では gateway）。**最小修正**: P4（refused だけを削る）。

### A1 奪われた隊商が feed・画面で元の持ち主のまま（統合を止める）
- **影響**: プログラムは TAKE で OWNER_CITIZEN と FACTION を略奪者に書き換えるが、鍵 (OWNER_TAG, SEQ) は口座シードのため送り主のまま（契約 §3.5）。herald の `h/caravans.json` は鍵の `ownerTag` だけを載せ、再 SENT で `raided` を false に戻す（`herald/src/caravan.rs` fold）。Web は `isMine(c.ownerTag)` で「自分の隊商」を決める（`screens/s1.mjs:274`, `map/s1marks.mjs:107`）。結果: 被害者の画面に「道中の隊商（略奪者の村へ向かう）」が自分のものとして出続け、略奪者の画面には出ない。AI の記憶・達成（⑫⑮）が feed を読めば同じ誤りを引き継ぐ。「略奪後に持ち主が変わる場合」そのもの。
- **担当**: ⑦（feed・画面）。**最小修正**: P2+P3。

### C2 feed が `worn_bps` を落とす（後で改善）
- CARAVAN_SENT の cargo は塔の損耗適用後。herald はこの値を `..` で捨てるため、画面は「発送前の量に対する無損失」を示しうる。P2 で `wornBps` を追加。

### A7 ③の委任中に Web が「鍵を作り直す」を提示（後で改善。③採用時は要判断）
- ③は session 枠を courier の PDA へ向ける。Web はその鍵を自分の agent と照合できず（`fdelegation.delegatedTo` → null）、`renderSessionFix` の「鍵を作り直す」を出す。押すと SetSession で枠を取り戻し、courier の委任は**黙って**解除される（fdelegation.mjs の冒頭コメントが agent について同じ危険を述べている）。既存試験はこの「別の鍵 → 通常カード」を意図的に固定している（`web-frontier-delegation.test.mjs:21`）ので、P5 は設計変更を含む。

### C3 ウォレットのアカウント切替に画面が追従しない（後で改善）
- `wallet.mjs` は change イベントで `connected()` を更新し通知するが、controller の listener は一覧の再描画だけ（`controller.mjs:1882-1883`）。`FS.wallet`・`FS.session`・Citizen・保有地は旧アカウントのまま。別ウォレットに切り替えた人が、前のアカウントとして表示・操作する。P6（再接続として扱う）。自動再現は controller を起動できず**模擬**。

### A3 / C1 記録が「容量超過の消失」「焼失後の空荷」を表せない（後で改善。記録の表現力）
- Vault への配達は `min(cap)` で切り捨て（`caravan.rs settle_caravan`）、契約どおり「超過分は消失」。しかし CARAVAN_SETTLED は **全量 cargo と DELIVERED** を記録し、入った量はどこにも無い。消費側が cargo を「実入荷量」と読めば全量到着と誤る（「部分到着・全量到着の混同」）。
- 焼かれた隊商は cargo 0 のまま目的地へ進み、DELIVERED（state 2）で決済される。CARAVAN_SETTLED(DELIVERED, cargo=0) は通常配達と区別が付かない（送付は cargo 全 0 を拒むので、`DELIVERED ∧ cargo=0 ⇒ 焼失後` と読めるが、記録上の明示は無い）。
- 検証器 V23 はどちらも規則どおりとして受け入れる（正しい）。問題は消費側の解釈。**提案**: 記録に `credited`（実入荷）と `burned` を持たせるか、消費側の読み方を契約に明記。プログラム変更を伴うため担当①⑦の判断。LiteSVM が無く、プログラム側の再現は未実行（§6）。

### B8 本人 MCP と運営 runner の同一ティック二重行動（仕様未決定）
- gateway は source をまたぐ直列化をしない。両者が別 key で同一ティックに Train と Harvest を送れば両方 sent（`v16-agent-wallet-contention.test.mjs`）。予算・mode・policy の門は両方通る。「一人の agent は 1 ターン 1 行動」とは誰も決めていない。決めるのは所有者。

## 4. 確認済み／再現不能／未実行／仕様未決定

**確認済み（期待どおり動く、既存または⑯試験で実行）**
- B2: 停止・policy 変更・mode epoch 変更後に古い判断は送られない（既存 `agent-wallet-gateway/-mcp/-review/-billing`、2,528 件通過 `logs/gateway-test.log`）。
- B4: 委任が無いとき有料推論をしない（runner の scheduler が `delegation()` を事前確認）。
- B6: refused は課金も送信も無し（既存 MCP 試験）。
- B7: requestId は agent ごと（⑯、変異 M1 で検出力も確認）。
- A2: 同一鍵の再 SENT で隊商が増えない（herald・keeper）。keeper の `sentSeen` は 2 になるが status の統計のみで台帳ではない。
- 所有者・保管者・運搬者の権限: session 鍵は他人宛送付・倉の閉鎖を拒む（`WalletRequired`、コード読解。③の t04/t13 は③の報告のみ）。
- 二重受取: SettleCaravan は STATE 検査と口座 close で冪等。DefaultRaid の fee は 1 回。
- 資源の増殖なし: 出発元は全量を払い、到着側は損耗・容量で減ることはあっても増えない。Holding への配達は cap を超えて加算されうる（`holding.rs credit` 「loot, caravans … may exceed the cap」= 設計）。
- 期限切れ: 隊商は期限を持たず、slot が使われている Province は rest できない（`rest_model::rest_limit`）。
- 再起動: keeper は feed を 0 から読み直し、Caravan 口座を読んで決済済みを落とす。engine は `AlreadyDone`/`OutOfOrder` を完了扱い。gateway は `held` を戻し `running` を unresolved に。findex は追記のみで削除しない。
- 単位: 内部 milli、記録・feed は whole（切り捨て）。資源種類の合算は見当たらない。
- ③の主張 2（relay は courier の取引形を受理しない）: ③の `relay-check/relay-shape.test.mjs`（模擬: relay の判定関数を直接呼ぶ）を基点の relay コードに対して実行し 4 件通過（`logs/ws03-relay-check-on-base.log`）。実チェーン側（t01–t14）は未実行。

**再現不能**: なし（試した再現はすべて成立）。

**未実行（§6 の理由）**: LiteSVM 試験全般、③ courier-tests、④の Rust 実行器、⑫ allocate の認証、⑮ 共同目標、⑥ 作成画面の補遺、乱択試験、実機スマホ（再読込・戻る・二重押しの実操作）。Web の二重押し防止は `sendKey(name, fields)` の同一判定（`controller.mjs:225`）で、同じ seq でも cargo が違えば通り、チェーンの `BadData` で止まる（資源は動かない。UX 上の混乱のみ、コード読解）。

**仕様未決定（検証担当は決めない）**: B8、施設（倉）喪失時の積荷の所有（現行は LOST で消失）、「1 Citizen 1 session 枠」を③・agent wallet・本人の間でどう配分するか、CPI 経由の遊び方を正式に認めるか（③ 0002 の採否）。

## 5. 文書とコードの食い違い（コードの書き方に従った）

1. `docs/frontier/stage1b/S1-1B-CONTRACT.md` §1.2 は STATE 3 を「lost（cargo burned or the destination gone）」とするが、§3.5 と `caravan.rs settle_raid`/`settle_caravan` は焼失後も目的地へ進み DELIVERED（state 2）。契約内でも §1.2 と §3.5 が矛盾。
2. `verify/src/checks/v2_program.rs` の冒頭文「every archived transaction invokes it」に対し、実装は WARN（PROGRAM_MISMATCH）で PASS を許す。
3. README「A verifier can replay a season's transaction log」に対し、verify はトップレベル命令のみ（③ 0002 と同じ指摘）。
4. `docs/agent-wallet/DESIGN.md` §6.4「A process crash mid-call leaves a running hold that the restart gives back … a call that outlives the TTL is not charged」に対し、§6.5 とコード（`gateway.recover`, `ledger.expire`, `meterInference`）は running → unresolved（返さない）、TTL 後に結果が来れば課金（`late: true`）。
5. `docs/agent-wallet/DESIGN.md` §6.6 と MCP ツール説明「never sent twice」に対し、`ledger.remember` の上限で記録が消える（B1）。
6. `herald/src/caravan.rs` の冒頭文「one that takes … makes it the raider's」に対し、feed は持ち主を示さない（A1）。
7. `herald/src/conquest.rs:401` の未解読記録カウンタは kind 80–94 のみを数え、S1 の 95–103 は数えない（コメントは「MC record (kinds 80–89)」）。

加えて③の報告: 既存 LiteSVM ハーネスは CPI 先 ProgramData を約 1.74 MB 少なく数える（0001）。本環境では未確認。

## 6. 未実行の理由と、必要なもの

- `cargo-build-sbf`（Agave 3.1.9）が無く、導入は禁止事項。よってプログラム本体（SBF）を動かす試験はすべて未実行。プログラム側の主張（A3/C1、J2 の書き換え）は Rust ソースの読解と契約文書で裏取りし、消費側（keeper/herald/verify/web）は実行した。
- 必要な実物: INVENTORY §3 の 14 件の bundle/patch、⑥補遺、②⑧契約。GitHub の同 repo へのブランチ push が最も確実。
- 環境変更が必要な作業: LiteSVM 試験の実行（Agave）。独立して続けられる作業は続けた。

## 7. 優先順位

1. **X2/A8（検証器）**: 公開季節の「検証 PASS」の意味に直結。P1 を暫定適用し、`--program-hash` を必須化、③ 0002 を正式化。
2. **B1（冪等記録）**: 実資金に近い経路（test USDC）で二重送信。P4。
3. **A1/C2（feed・画面）**: 契約違反の表示。AI 記憶・達成（⑫⑮）の入力にもなる。P2+P3。
4. A7/C3/P6: 画面。③採用の判断と合わせて。
5. A3/C1: 記録の表現力。契約の明記か記録の追加を担当①⑦で判断。
6. B8 ほか仕様未決定: 所有者の決定事項として記録。


---

# 第2期（2026-10-31）：⑰ 決済・⑱ 秘密の進軍と検証・⑲ MagicBlock と公開運用

**前提の変更（2026-10-31、所有者）**: シーズン制は廃止し、世界は継続する。「シーズン終了→賞金受取」を完成形とする指示は撤回された。本節の⑰の試験は**旧経路の互換性と既存の受取権の確認**として残し、新しい世界を終了させる根拠にはしない。新しい料金周期・賞金制度は決めない。

## 8.1 通し経路「x402 参加→操作→終了→検証→受取→着金」の実態

- **④が固定した統合 tree は入手できない**（INVENTORY §3）。基点 `4cd901de` の relay/SDK/web と `permutation-prize` のソースで検証した。チェーン側（prize プログラム、SBF）は未実行。
- **一般の x402 クライアントは通らない。自前 SDK（または同形を作るクライアント）だけが通る。** 402 の要件は公開仕様の形（`scheme exact`, `network`, `asset`=mint, `payTo`=vault, `maxAmountRequired`）だが、支払いは `[compute budget ×3, prize Pay, game Join]` の 5 命令を wallet が署名したものに限られ、仕様どおりの `TransferChecked` 1 命令は 402 `InvalidPayment`（T17-1、記録）。要件の `extra.instruction: 'Pay+Join'` がその旨を示す。
- **支払い成立後に応答を失う**: 同じ X-PAYMENT の再送は 409 `Duplicate`「新しい取引に署名せよ」だけで、決済済みの取引を教えない（T17-2、失敗）。従って新しい取引で再試行すると prize プログラムが `AlreadyPaid`（0x105）を返し、relay は 402「支払い拒否」と答える（T17-3、失敗）。本人は参加済みなのに拒否と読める。回復手段は `GET /f/prize?wallet=` の Entry 確認だけ。relay の replay cache はメモリのみ（30 分 TTL）で再起動後は空。**修正候補 P7**（同一バイト列は決済済み取引で 200、AlreadyPaid かつ Entry・Citizen 既存なら `mode: settled` で 200）。
- **二重受取**: Claim は Entry の `CLAIMED` で拒否（`AlreadyClaimed` → 409）。relay 経由の宛先は wallet の ATA に固定。プログラム自体は宛先の所有者を検査しない（mint は SPL が検査）。
- **誤った mint・宛先・ネットワーク**: ネットワークは 402（T17-4、確認）。mint・vault は `classifyPaidJoin` の口座一致で 402（既存試験）。
- **偽の支払い証拠**: 署名だけの payload は受理されない（取引本体が必要、relay が simulate→send→status で確認）。
- **未確定を 0 とする箇所**: `POST /f/prize/claim` は着地後に Entry を読めないと `amount: "0"` と答える（T17-5、失敗。**P8**: `null` + `amountKnown`）。ほか `prices.game[name] ?? '0'`（無料行動、設計）、settled モードの `paid: '0'`（支払い済みの再参加、妥当）。
- **資金の混在**: 参加費・賞金・運営費はチェーン上の pool（COLLECTED/PRIZE/OPS）、AI 運用費は agent wallet の custody（同じ mint の別口座）と JSON 台帳、手数料は relay の SOL pool。混在なし。
- **プログラム読解で見つかった重大点（未実行、SBF）**:
  - **Pay は無条件**（`permutation-prize/src/lib.rs:518-556`）: pool が OPEN で `counted==0` なら、Season の状態や Join と無関係に誰でも Pay できる。招待で無料参加した Citizen が、季の終了後・最初の Tally 前に直接 RPC へ Pay を送れば Entry を得て `paid` 扱いになる（`achievements.mjs scoreLines` は Entry の有無だけ）。`prize-params.json` の適格性の前提と矛盾。
  - **Finalize の固着**: `counted != keeps` で `WrongExpectedCount`。計上済みの Province が終了後に閉じられると `counted > keeps` となり、OPEN から出る命令が無い（SetShares は FINAL、WithdrawOps は非 OPEN）。参加費が永久に vault に残る。
  - **返金は 80%**: `refund_amount = prize × paid / collected`、運営の 20% は返金モードでも引き出せる。README の「refunds」は全額返金と読める。
  - 端数と未受取分は vault に残り、回収命令なし。
- 継続世界の方針では、この経路（季の終了・Tally・Finalize）は**戦期の集計へ置き換わる候補**であり、ここでは「既存の入金と受取権が壊れないこと」を確認対象とする。受取権の保護に直接関わるのは T17-2/3/5 と上の Pay 無条件・Finalize 固着。

## 8.2 ⑱ 秘密の進軍と検証

- **実装の事実**: 封の round は到着ターン**終了**時刻以降の最初の drand round（`seal.mjs sealRound` = `clock.mjs tlockRound`）。一方、所有者の自己 Reveal は到着ターン**開始**時に送られ（`marchbook.mjs revealStep`、keeper `reveal_accept.rs`「owners submit from the arrival bell's start」、M1 契約の仕様）、プログラムは anchor が無くても Reveal を受ける。従って目的地は決着の最大 1 ターン前に公開される。README:25「到着ターンが終わるまで秘匿」は実装より長く見せている（T18-1、失敗。**P10** 文言案）。
- **公開済み乱数の誤認**: repo の全 quicknet fixture（32 round、2026-09-26 公開）と出口季の archive は使用時点で公開済み。秘匿性を示す試験は無い。README:90 と offchain.md:539 は明記している。drand-replay の 425（公開前拒否）と test-beacon の `TooEarly` は試験環境の性質であり、protocol の性質ではない。**本物の quicknet で「round 公開前は開けない」を確かめる試験は、live drand への到達（O-M1-12 の承認）が要る**ため未実行。
- **偽署名・別 round・遅延**: プログラムは round 規則→BLS pairing の順で検査（`WrongRound` 7、`Crypto` 9）。遅延は anchor の着地時刻 A がずれるだけで待機（明示の遅延規則なし）。これらの試験は LiteSVM（未実行）と fclient（実行可能、既存）。
- **検証器の穴（コード読解）**: V4 は BeaconLog ≥ S(A) による `WindowClosed` を再検査しない。改竄 archive がその条件後の Reveal を示しても検出しない。tamper class 候補。
- **番号だけ既知の未対応命令**: X2c で再現（SetVigil 0x32 の着地命令が PASS で所見ゼロ）。P1b で WARN `UnjudgedInstruction` を出す（判定の無い 16 タグの一覧をコードに置いた）。

## 8.3 ⑲ MagicBlock と公開運用

- **Frontier 再構築に MagicBlock（委任・commit・解除）の配線は存在しない → 未実装**（`permutation-frontier/src/lib.rs:2`「no MagicBlock」、frontier-node・gateway/src/frontier に該当なし）。「委任・commit・解除の途中停止で L1 と ER が食い違う」は Frontier では検証対象が無い。
- **旧 prototype**（permutation-chain + gateway crank）には配線がある。crank の解除 intent 順（国→州 1..→州 0）がプログラムの `undelegation_order`（州 1..19→国→州 0）と逆で、最初の intent が `UndelegationOrder` で拒否される（T19-1、失敗。**P9**）。送信と保存の間で停止すると同じ group を再送し続ける（crank は `meta.undelegated` を読み直さない）。復旧命令（request/rollback undelegation）は builder だけで、運用コードから呼ばれない。
- **公開 RPC**: Frontier の keeper は `RpcPort::localnet` 専用、`fclient/http.rs` は `http://` のみ（TLS なし）、live drand なし → **公開 RPC 追従は未実装**（devnet 草案 G1–G3 と一致）。findex の `RpcPoll` は初回同期で履歴の端（`getFirstAvailableBlock`）を確認せず、`until` 署名の存在も確認しない。keeper の起動時は status 無し＋slot 経過で attempt を expired と記録し履歴範囲を見ない（冪等なので実害は限定）。
- **snapshot に後続更新が混ざる**: herald の `--source rpc` は Enriched が page 収集後に `getMultipleAccounts(minContextSlot)` で bytes を取るため、同一 page 内の先行取引に後続の状態が付く。per-bell file に混入しうる。防御は `exact_post=false` で不一致を `unchecked` に落とすだけ。RPC 経路の試験は未実行。
- **再起動・再読込の重複**: relay の replay cache はメモリのみ（チェーンの署名重複拒否が実害を抑える）、citizens watcher の wakes 配送記録はメモリのみ、agent wallet は B1（P4）。keeper は journal adopt と `AlreadyDone` 分類で冪等（既存試験多数）。

## 8.4 必要な承認（まとめ）

| # | 要るもの | 理由 | 無い場合 |
|---|---|---|---|
| A1 | Agave 3.1.9（`cargo-build-sbf`）の導入 | LiteSVM 試験（Frontier、prize、③ courier）の実行。Pay 無条件・Finalize 固着・封の偽造拒否・境界をまたぐ隊商決済の**実プログラム**での再現 | 読解と消費側実行のみ（現状） |
| A2 | live drand（api.drand.sh 等）への読み取り（O-M1-12） | 本物の round で「公開前は開けない」を確かめる唯一の方法（N7） | 秘匿性は未検証のまま |
| A3 | devnet への読み取り専用アクセス | BLS12-381 syscall・賃料の確認（G6, G7） | 公開運用の前提が未確認 |
| A4 | TLS クライアント依存（rustls 等）の追加 | keeper/herald が https RPC と drand に届くため（G1） | 公開 RPC 追従は未実装のまま |

いずれも今回は行っていない。

---

# 第3期（2026-10-31）：継続世界 — 期間境界をまたぐ世界と処理

所有者の方針訂正: 世界は終了・リセットしない。戦期の区切り・集計・賞金は別途決める（未決定を採用しない）。⑯の役割は「期間境界をまたいで世界と処理が続くこと」の独立検証。以下、指示の 4 点で報告する。本節の試験は**現行コードの境界 = `end_bell`** に対して書いた。継続世界の境界（戦期）が④⑧で定義されたら、同じ試験を新しい境界に向け直す。

## 9.1 残っていたシーズン依存

### 9.1.1 プログラムと ABI（実行で確認）
- **全プレイヤー命令の終了拒否**: `frontier-abi/src/prologue.rs:1066-1068` `PlayerStart::finish` 第 4 段 `bell(now) ≥ end_bell → WrongStatus`。収穫・建設・隊商送付・提案など**すべて**が境界で止まる（`v16_period_boundary.rs` P2、失敗）。
- **長さの上限**: `frontier-abi/src/presets.rs:286` `SeasonParams::validate` が `end_bell ≤ 4_032`（28 日）を要求（P3、失敗）。終了時刻を巨大にする永続化は**不可能**。`MAX_TIMER_BELLS`（30 日）が征服の各タイマーの上限。
- 終了後に許される命令は settle 系のみ（`relay_settle_shape`: SettleCaravan, DefaultRaid, SettleSiege, SettleCapture, CloseMarch, RetireHost ほか）。終了後の閉鎖命令（CloseHolding, CloseCitizen, CloseVault, CloseStructure, CloseProvince, ArchiveAnchors, CloseSeason）は口座を消し rent を返す。
- 識別子: Citizen・Holding・Province・Vault・Caravan・Structure・Nation の PDA は **season_id をシードに含む**（`frontier_abi::addr`）。賞金 pool も `["pool", game_program, season_id]`。Web の鍵（`ps-fsession:<cluster>:<program>:<season>:<wallet>`、署名文に `Season:` 行）と marchbook も season ごと。
- 固定幅: bell `u32`（600 s × 2^32 ≈ 8 万年、十分）、`Citizen.CARAVANS u32`、Province の隊商 slot 5 本（再利用）、archive part = bell/72、`SCAN_BELLS=256`（keeper の anchor 走査窓）、herald `nation.rs DECIDED_MAX` の剪定、agent ledger `HISTORY_MAX 500`/`REQUESTS_MAX 2000`、findex は追記のみで剪定なし（保存量は無限に増える）。

### 9.1.2 各層の依存（読解による棚卸し。引用は file:line）

| 層 | 依存 | 種類 | 世界が続くと／境界をまたぐと |
|---|---|---|---|
| プログラム | `EndSeason` は `bell ≥ end_bell` で誰でも送れる（`proc/season.rs:625-658`）。stack が期日に自動送信（`stack/src/up.rs:1644-1661`） | 寿命 | 誰でも世界を終えられる。継続世界では撤去か門が要る |
| プログラム | Join は `join_close_bell`（長さの 75%）で閉じる（`citizen.rs:349`） | 寿命 | 新規参加が永久に止まる |
| プログラム | CloseHolding/CloseCitizen/CloseProvince/CloseMarch は Ended+72h か tombstone のみ（`citizen.rs:2397-2470`, `conquest.rs:1748`） | 寿命 | 終わらない世界に離脱者の口座を閉じる道が無い。Vault・Structure・Caravan・Nation には終了後の閉鎖命令自体が無い（終了後は stores と rent が取り残される） |
| プログラム | **隊商の取り残し**: SendCaravan に到着 bell の上限が無く、SettleCaravan は `RESOLVED_NEXT > last_bell` を要求、`in_season` は `end_bell` 以降を決して解決しない（`caravan.rs:927-958`, `clash.rs:443`） | 寿命 | 境界をまたぐ隊商は永久に `CaravanEarly`（積荷・rent 消失）。**P4 試験で再現（kernel の schedule + 判定の写し）** |
| プログラム | Depart/Reveal は `arrive ≥ end_bell` を拒否（`host.rs:652`, `reveal.rs:759`）、relay も同じ（`shapes.mjs:57-71`）、keeper も（`reveal_accept.rs:139`） | 寿命 | 封印進軍は境界をまたげない（設計） |
| プログラム | 包囲の `TooLate`、終了時の RetireHost 強制、前哨の最終日ロック（`conquest.rs:779-796, 1598-1617`, `holding.rs:963`） | 寿命 | 終了前提の「終盤」規則 |
| プログラム | 休眠解放 `release_after_secs` = 季の長さ（`v2/presets.rs:447`）。ring 開放・盾の「遅参」判定が genesis からの経過時間（`map.rs:350`, `v2/presets.rs:147-149`） | 寿命 | 14 日後に休眠した本拠が解放され始める。7 日以降の新規はすべて「遅参」扱い |
| プログラム | `MAX_SESSION_SECS` 30 日（`layout/player.rs:54`） | 上限 | session・agent 鍵は 30 日ごとに wallet で更新（委任が途中で切れる） |
| プログラム | 世代 `gen u8`（site/structure/vault）、`EMPTY_GEN=0xFF`（`citizen.rs:1814`, `structure.rs:473`, `caravan.rs:1792`） | 上限 | 約 254 回の再建で永久に使えない。0xFE→0xFF が空の番兵と衝突 |
| プログラム | AnchorArchive は region×半日ごとに 6,144 B、CloseSeason 第 9 部でしか閉じない（`layout/beacon.rs:40-64`, `season.rs:1014`） | 上限 | 1 日約 32 口座、rent 約 1.4 SOL/日が永久に拘束（agent の概算、未計測）。DefenceClaim も同様 |
| プログラム | `r_max ≤ 128`、host_id の ring 128 上限（`presets.rs:282`, `addr.rs:244`） | 上限 | 地図拡張の天井 |
| keeper | `season` は keeper.toml に 1 つ、journal に season 列なし（`config.rs:5`, `journal.rs:107-122`）。journal・索引は削除なしで増え続ける。再起動は feed を 0 から読む（`lib.rs:739`） | 識別・上限 | season id を変えると別 process・別 journal。長期運用で起動時間と容量が無限に増える |
| keeper | anchor 計画は `< end_bell`、rest の早送りは「季の終わり」で行う（`beacon.rs:188`, `play.rs:1602-1775`）。終了時の flush（RetireHost, SettleSiege, CloseMarch） | 寿命 | 終わらない世界では rest の追いつきが起きない／flush は死にコード |
| herald/findex | `--season` と checkpoint の識別 `(program, season)`（`checkpoint.rs:118-125`）。`final.json` は EndSeason 後に一度（`conquest.rs:2303`）。per-bell/day の不変ファイルを剪定なしで書く。`series.bin` は毎時全体を書き直す。findex は追記のみ、`/h/events` の番号は archive ごと | 識別・寿命・上限 | season id を変えると fold をやり直す。保存量は O(日数)。`final.json` の代わりに「戦期の結果」が要る |
| 検証器 | 入力は 1 季の全取引＋最終口座、season id で口座を選別（`input.rs:280-319`）。V20 の `CompletionAfterEnd`/`SiegeNotSettled`、V5 の `ArrivalAfterEnd`、V14 の `SiegeAfterEndRule`、V22 は `end_bell` 前提。fixture は EndSeason で終わる | 識別・寿命 | 検証は毎回ゼロからの全再生で費用が無限に増える。窓付き検証も checkpoint も無い。終了前提の判定は戦期の意味に置き換えが要る |
| gateway | `seasonId` 必須（`frontier/config.mjs:22`）。quota は genesis からの日で 7 日以降は半分（`quota.mjs:1-35`）。invite の HMAC に season id。prize pool は `["pool", game, season_id]`、Tally/Finalize は `STATUS_ENDED` 前提（`permutation-prize/lib.rs:611-693`）。agent wallet の予算は UTC 日と生涯合計で季に依存しない（確認） | 識別・寿命 | 1 relay = 1 season。賞金は終了が無いと決して支払われない（戦期の会計が別途要る） |
| Web | `ps-fsession/ps-fmarch/ps-fui/...:<season>` の保存鍵、署名文に `Season:`（`fsession.mjs:25-34`, `marchbook.mjs:34`） | 識別 | season id が変わると鍵が孤立し、**封印進軍の平文（marchbook）が失われる** |
| Web | 「シーズンは終わりました」「季節の終わりに…勝者」など約 54 行（`hud/provstrip.mjs:115`, `screens/conquest.mjs:210`, `screens/prize.mjs:34,66`, `fi18n.mjs`, `lang/en-frontier-play.mjs`）。bell を `endBell-1` に clamp、`final.json` を終了後に poll（`controller.mjs:843, 1008`） | 文言・寿命 | ⑦の点検対象。戦期の集計と世界の継続を別表示にする |
| AI | 住民の commitments は `run_id`+`season_id`（`registrar.mjs:265`）。封じた記録の公開は `season-end.json` が出るまで保留（`audit/season_end.mjs`）。autopilot `season_end` 理由（`mind/gate.mjs:72`）。bots は `end_bell` で走行終了 | 識別・寿命 | 終わらない世界では封じた監査記録が永久に開かない。「戦期の終わり」に置き換える規則が要る |
| 文書 | DECISIONS T1「季とともにすべて終わる、次の季は新しい地図」、DESIGN §184/239/240/966、DESIGN-OVERVIEW:93,110、GAME-DESIGN.ja §213/785/884/886-903、README:28,64,94、M1-CONTRACT:971-973 | 文言 | 書き換え候補 10 件（⑦⑧） |

## 9.2 変更した挙動
- 本体コードは変えていない（指示どおり本体への取り込みは④へ）。継続世界に向けた変更案は 9.4 の「試験契約」として提示し、④⑧の移行設計に渡す。
- 第 1・2 期の修正候補 P1〜P10 は継続世界でも意味を保つ（検証器の未判定命令、feed の持ち主、冪等記録、旧経路の応答回復）。P7 の「settled」判定は Entry と Citizen の存在に依存し、戦期の会計を決めない。

## 9.3 試験で確認したこと
- P1: 境界直前（bell 1,007）の通常操作は通る（確認）。
- P2: 境界 bell と 1 日後の通常操作は `WrongStatus`（失敗 = 依存の証拠）。
- P3: 28 日超の季は作れない（失敗 = 依存の証拠）。
- P4: 境界直前に送った隊商は、kernel の schedule で最終 bell が境界以降になり、プログラムの決済条件（全 Province の `RESOLVED_NEXT > last_bell`、ただし `end_bell` 以降は決して解決されない）を永久に満たさない（失敗 = **現行コードの取り残し**。積荷と rent が消える）。判定は 2 行の写しで、チェーン上の再現は LiteSVM 待ち。
- 加工・預かり・未確定取引・封印進軍を**境界にまたがらせる通し試験**は、現行コードでは境界 = 終了のため「またげない」ことしか確かめられない（送付・出陣は境界前に拒否される）。新しい境界の定義（④⑧）を受けて、9.4 の契約で実施する。
- 長期運用（状態の増加）は上の固定幅と剪定の表で読解のみ。実行試験は未実施。

## 9.4 移行や仕様判断が残る点（⑯が決めない）
1. 戦期の境界の定義（bell か日付か）、境界で止めるもの（戦闘の集計だけか）と止めないもの（経済・輸送・預かり・加工）。
2. 識別子: season_id をシードに含む PDA を、世界 id に読み替えるか、一つの season_id を世界として使い続けるか（長さ上限 P3 の撤廃が前提）。旧季の口座・証拠の読取りと再検証の方法（過去の履歴は書き換えない）。
3. 賞金・参加費の会計を世界の寿命から分離する設計（⑰）。既存の入金・受取権（Entry・Claim）の保護。Pay 無条件と Finalize 固着は旧経路でも先に直す価値がある。
4. 封印進軍と drand round が戦期をまたぐ場合の扱い（⑱）。現状 round は世界時刻だけに依存し戦期と無関係なので、境界で「決着を打ち切らない」限り問題は無いはず（要確認）。
5. keeper の anchor 走査窓（256 bell）と herald の保存量の剪定方針（長期運用）。

### ⑯からの試験契約（④⑧へ渡す）
境界 B の前後と再起動後で、次が一致すること。
- 隊商: 境界前に送付、境界後に到着。所有者・積荷（損耗後）・決済 1 回・fee 1 回。境界時点の herald feed に持ち主と `wornBps`。
- 加工: 工房の生産が境界をまたいで連続（`settle_tiered` の時間差分が境界で切れない）。二重生産なし。
- 預かり: 倉の stores と cap が境界で変わらない。引出し義務（他人の材料）が消えない。
- 未確定取引: agent wallet の `sending`/`unresolved` hold が境界で解放も課金もされない。relay の quota frame が境界で二重課金しない。
- 封印進軍: 境界前に出陣、境界後に到着。Reveal と決着が境界で拒否されない。
- 再起動: keeper/herald/relay の再起動後に上の件数が変わらない。
- 検証器: 境界をまたぐ archive を一つの run として PASS できる（V20 の end 判定、`ArrivalAfterEnd` 等の扱いを戦期の集計と分ける）。


---

# 第4期（2026-10-31）：正本待ちの間に基点で進めた ⑱⑰ のホスト試験

正本（④ `wylls-ws04-continuity-20261031b.tar.gz`、⑧ `wylls-08-archive-v4.tar.gz`）は未受領。④の報告 commit `eccb833d38604f00d35987bebe710219b6ede6ef`（tree `82bf0762…`、⑱側の試験結果を記録した版）は手元から取得できず、検証していない。新しく現れたリモートブランチ `claude/nice-edison-3boh5r`（`087277477282…`）は別案件で無関係。以下はすべて基点 `4cd901de`（= `main` `92142932`、⑯ブランチ HEAD `c77198759e15c33ff685ed9b11d3d5ff007f132a`、tree `efa7bd6ed34fdb95e7a30bd8c42a73930563b917`）の実コード。

| ID | 再現入力 | 期待結果 | 実結果（基点） | 原因 | 最小修正候補 | 修正後 |
|---|---|---|---|---|---|---|
| T18-2 早期平文 | keeper `/v1/reveal` に、到着ターン開始の 2,993 秒前（出陣直後、到着 bell 7、現在 bell 2）に正しい平文・salt・ct_hash を提出（`keeper/tests/v16_early_reveal.rs`、localnet in-process、program はネイティブ代役） | 到着ターン開始前は拒否、キューに入らない（keeper 自身の表 `play.rs:6`「from the bell start」、M1 契約 §9.3） | `202 accepted`、Reveal 担当のキューに 1 件。Reveal 書込みの `not_before_slot` は `t.slot + jitter` のみ | `reveal_accept.rs judge` に時刻の下限なし、`play.rs reveals()` にも下限なし。既存試験 `reveal_accept_over_localnet` 自体が到着 2 ターン前の `202` を固定している | **P11**: `judge` で `now < bell_start(arrive)` を `425 TooEarly`、`reveals()` で到着ターン開始前を送らない、既存試験を「早期は 425、開始後に 202」に調整 | keeper 全試験通過（`logs/patched-keeper-p11.log`） |
| T18-3 再送と手数料 | 1 件の Reveal（class W）を 27 スロット未応答で保留し、その後に最新版を着地、それ以前の 26 版を `AlreadyDone`（code 52）で着地させる（`keeper/tests/v16_reveal_versions_fees.rs`。送信器は実コード、チェーンと AlreadyDone は台本の代役） | (1) 書込みは 1 回で終わる、(2) 余分な手数料は `per_write_cap` 以下、(3) keeper の `fees_charged` がチェーンの課金と一致 | (1) 1 回（送信器側の二重効果なし。チェーン側の二重効果防止はプログラムの AlreadyDone で、ここでは未実行）、(2) 27 版、チェーン課金 1,459,427 lamports（勝者 57,052、余分 1,402,375）、上限 20,000,000 以下、(3) **keeper の集計は 14,312**（最初に判定された 1 版分だけ） | `engine.rs poll`: 書込みが終わった巡回で後から判定された版（`ended` 分岐）と、その後に解決する `orphans` は journal に状態を書くだけで手数料を数えない。最初に判定された `AlreadyDone` 版が `Landed` として記録される | **P12**: 終了後の版と orphan の着地時に、その版の手数料を `fees_charged` に加算（`orphan_fees` で duty 種別と手数料を保持、期限切れで破棄） | keeper 全試験通過 81 件（`logs/patched-keeper-p12.log`） |

区別:
- **早期漏えい（T18-2）と再送の手数料（T18-3）は別の問題**。⑱が報告した「retries 27 件」は、class W の 1 スロット 1 版の再送で生じうる件数であり、各版が平文を含む。T18-2 が直らない限り、27 版すべてが到着ターン前に平文を RPC へ流しうる。
- **二重の状態変更**: 送信器の側では 1 回で終わる（実測）。チェーン上の二重効果防止はプログラムの Reveal の `AlreadyDone`／slot 存在の検査で、LiteSVM 未実行のため未検証。
- **余分な手数料**: 設計上の上限（`per_write_cap` 0.02 SOL）以内だが、keeper の集計が実課金の約 1% しか数えず、⑰の費用照合に使えない（P12）。

未実行: プログラム本体（SBF）での Reveal の二重効果防止、提供 `.so` での LiteSVM（受領物なし）、④⑧の正本 tree での再実行。


## 第4期の補足（④による独立照合、2026-10-31）

④が P11・P12 を sha256 照合のうえ、自分の `bc09689a`（コードは `4cd901de` と同一）に当て、④自身の Reveal 試験 v4（keeper 実コード、in-process localnet、`--test-threads=1`）で実行した（④ commit `88cc131d4d3cfe6ad8659e3a73658db20b695b8e`、ローカル、未 push。⑯は記録を受け取っただけで、この実行を自分では再現していない）。

| 適用 | keeper 既存試験 | ④の 5 ケース（drand 公開前の送信、anchor 無しの送信） | 再送の手数料（keeper の集計 / チェーン） |
|---|---|---|---|
| なし | 全通過 | 5 件とも失敗 | 252,137 / 681,118 |
| P12 | 全通過 | 変化なし | 681,118 / 681,118 |
| P11+P12 | 全通過 | 変化なし | 681,118 / 681,118 |

**P11 の位置づけの訂正**: P11 は「到着ターン開始前」の受付と送信を止めるだけで、**秘匿性を守る修正ではない**。④のケースでは、所有者の平文が到着ターン開始後・T(arrive) 公開の約 593 秒前に送られ、P11 の下限を通る。anchor が無いまま送られる 7 件にも効かない。秘匿性と正当性には、⑱の条件（チェーン上で確認した anchor と、検証済みの T(arrive) 署名）が要る。これは⑯の T18-1（ターン開始と封の round の間に最大 1 ターンの差）と同じ構造の問題。P11 は「受付の下限」の一案として残し、採否と位置（ターン開始か drand 公開時か）は所有者の判断とする。

**P12 は④の試験でも T18-3 を解消**（全ケースで集計がチェーンと一致）。勝者の記録の正確さは④の試験の対象外で、未検証のまま。


# 第5期（2026-11-05）：各担当の現行版に対する独立検証

⑯の版: `1da3238d03fcb50b3da168fb3618fd4d694e2e05`（tree `f3071569b2a155011ea6b22a8fd81df43418919b`）を保存版とし、その上に試験 commit `87c13e780d8a84225d36caab3bb60da3f7a0dbb2` と本節を積んだ。GitHub の保存ブランチを読み取りで取得し（`git ls-remote`、`git fetch`）、以下の HEAD と tree に固定した。各ツリーは detached worktree に置き、⑯の試験ファイルだけを足した（試験以外のコードは変えていない）。

## 10.1 固定した版

| 担当 | ブランチ | commit | tree |
|---|---|---|---|
| ④ 統合候補 | `integration/ws09-13-v16-d0949fd4` | `d0949fd417180b11704de5690ab0dfb6e5ef3148` | `7198d7d962b35044fd0ace7e3ba7604061c1c66c` |
| ⑧ 継続世界 | `preserve/ws08-cont-verify-b519cd18` | `b519cd18e203a75ec7921f01aef46b29f8f202ea` | `c084b2150e3cd7d0c397341ec0ecfc85b9770b24` |
| ⑰ 決済 | `preserve/ws17-0c80381d` | `0c80381d431c8f897a873aaae6d6c5427f8460f9` | `84b7c910b7661d340633d1d562801379460bb6e0` |
| ⑱ 秘密の進軍 | `fix/ws18-clippy-hostile-20261103`（`preserve/ws18-4fbe0c77` の子孫） | `0bba3f310085639732b038085211f7cb3af5a462` | `c49549742876023fbf9b345aecbecfc9c66a1e3f` |
| ⑲ 公開運用 | `preserve/ws19-supp-d793ebd4`（`preserve/ws19-a91b7a4f` の子孫） | `d793ebd4dfded1a4c4fa23796181c55d29874224` | `6d205008fc24ef325e957d795f9374f24c8fc183` |

- 試験中に統合ブランチが `67fb05a1c604c9f5829195ed3a6f2d2f8c6a1ce6`（tree `694a5197d981aabe3d479aae5e00e9244a5cc454`）へ進んだ。差分は 2 commit（Clippy の型別名・スコープ整理、CI に Prize バイナリのビルドを追加）で、試験した挙動には触れない（コード読解による判断で、`67fb05a1` では再実行していない）。
- `preserve/ws08-persistence-ca67d40e` は `b519cd18` の祖先ではない。中身は `workstreams/08-persistence/` の設計と模擬計算で、検証対象のコードではない。
- 統合候補に入っていないもの: ⑧のプログラム側の継続フラグと再起動の修正 `5366f7c5`、⑰の 9 ファイル、⑲の `frontier-er`。P2・P3 は統合側の隔離コピーで試験中とのことで、⑯は受け取っていない（必要なら bundle か SHA）。P1・P4・P7・P12 は当てず、現行の実装に対する再現試験だけを行った。

実行条件: すべてホストの `cargo test --locked` と `node --test`。program は keeper の試験ではネイティブの代役（`tests/model`）で、SBF の `.so` は無い。LiteSVM、Agave、live drand、devnet、TLS には触れていない。ログは `logs/phase5/`（`*.log` は .gitignore 対象のため強制追加）、実行スクリプトは `phase5-scripts/`。

## 10.2 優先 4 項目の判定

「再現」= 過去の問題が固定した版でも起きる。「修正済み」= ⑯の試験で直ったことを確認。「証拠不足」= ⑯の手元で確かめられない（理由を付す）。

### ⑧ 境界・再起動

| 項目 | 統合候補 d0949fd4 | ⑧ b519cd18 | 根拠 |
|---|---|---|---|
| 有限シーズン（終了 1,008）の境界: P2 境界ターンの操作が `WrongStatus`、P3 28 日超の世界を作れない、P4 境界前の隊商が `CaravanEarly` のまま | 再現 | 再現 | `v16_period_boundary` 1/4（P1 のみ通過）。⑧は旧経路を直したのではなく、終わらない世界を作れるようにした |
| 継続値（`NO_END_BELL`）での境界: 旧終了ターン・+144・10 年後の操作、検証、隊商の精算 | 証拠不足（統合の `validate_world` が `pub(crate)` で⑯の試験から呼べない。プログラム側の継続フラグも未取り込み） | 修正済み（ABI・カーネル水準） | `v16_continuous_boundary` 4/4（⑧ tree） |
| 世界の寿命の上限 | — | 測定: `debit_bucket` は genesis からの u32 秒で、約 136 年（`u32::MAX/600` ターン）を超えると `Overflow` | 同上 v16_c5 |
| 再起動: ターン途中の keeper 再起動で BeaconLog を同じターンに再投稿 | **再現**: 16 地域すべてでターン 3 に 2 回ずつ、計 32 件（余分な PostBeacon 手数料 16 件、状態の二重化なし）。再起動なしの対照は 1 回ずつ | 修正済み（同条件で 1 回ずつ） | `keeper/tests/v16_beacon_restart.rs`。⑧の報告「余分な 16 件」と一致 |
| 継続世界での rest scan の暴走（`rest_limit` を `u32::MAX` で呼ぶ） | 修正済み（コード読解: herald `rn+1`、keeper `now_b+1`） | 修正済み | 実行試験はなし |
| チェーン上でターン境界をまたぐ動作（⑧の LiteSVM `continuous.rs`、ローカルチェーンの記録） | 未実行 | 未実行 | SBF が無い。⑧の記録は⑧の結果で、⑯の結果に数えない |

### ⑱ 早期 Reveal

| 項目 | 統合候補 | ⑱ 0bba3f31 | 根拠 |
|---|---|---|---|
| T(arrive) 公開前に平文が RPC に出る | **修正済み**: 出発直後（到着ターン開始の 1,089 秒前、T(arrive) の約 1,689 秒前）に `/v1/reveal` へ提出しても、公開前の Reveal は 0 件、anchor なしの Reveal も 0 件で、7 件の行軍はすべて公開後に Reveal された | ⑱自身の単体試験（anchor なしでは送らない等）は通過。⑯の送信段の試験は、⑱の tree に④のシナリオが無いため未実行 | `play.rs` に⑯の試験 `v16_api_owner_material_right_after_departure` を追加（`patches/T18-early-api-play-test.patch`、試験のみ）。④の判定（`check`）をそのまま使った |
| 到着ターン前の受付（T18-2: 2,993 秒前の平文が `202` で受け付けられ journal に入る） | 再現 | 再現 | 送信を止める現在の設計では漏えいではない。受付の下限は未決の仕様（10.6.1）。keeper の表 `play.rs:6`「from the bell start」と README:25 は挙動と食い違う |
| Web の自己 Reveal が到着ターン開始時に平文を渡す（T18-1） | 再現 | 再現 | 渡す先は gateway の `/f/reveal` → keeper（送信は保留）で、チェーンではない。運営側が平文を持つのは最大 1 ターン以上早い |
| 再送 27 版の手数料を keeper が数えない（T18-3） | **修正済み**（集計＝チェーン） | **再現**（keeper 14,312 / チェーン 1,459,427 lamports） | `v16_reveal_versions_fees` |
| 二重の状態変更（Reveal が 2 回効く） | 送信器は 1 回で終わる（実測）。プログラムの `AlreadyDone` による防止は未実行 | 同左 | SBF が無い |

### ⑰ 二重効果・費用

| 項目 | 統合候補（⑰未取り込み） | ⑰ 0c80381d | 根拠 |
|---|---|---|---|
| T17-2 応答が失われ、同じ X-PAYMENT を再送 | 再現（`409 Duplicate` だけ） | **修正済み**（同じ決済結果を返し、二度送らない） | `v16-x402-settlement` |
| T17-3 `504` の後に着地、新しい取引で再試行すると `402 AlreadyPaid` | 再現 | 再現 | 2 件目の Pay はシミュレーション段で拒否され、送られない（`cosign.mjs refusal`）。二重課金はないが、支払済みの参加者に「支払い拒否」と答える |
| T17-5 着地した Claim の金額を読めないと `"0"` と答える | 再現 | 再現 | 不明な金額を 0 と表示する |
| ⑰自身の試験（prize・accounts・shares・x402 の 24 件） | — | 全通過 | 二重送信なし、失敗した取引の再送は拒否 |
| 実際の請求額・二重効果（チェーン上） | 未実行 | 未実行 | 試験はすべて台本のチェーン。実資金・devnet には触れていない |

### ⑲ 履歴の欠落

| 項目 | 統合候補 | ⑲ d793ebd4 | 根拠 |
|---|---|---|---|
| G2 保存済みの最後の署名がノードから消えている | 検出して止まる | 検出して止まる | `findex/tests/v16_history_gaps.rs` |
| G1 初回の取得でノードが先頭を削っている | **見逃す**（3〜6 を印なしで保存） | 見逃す | 同上。⑲が書いた限界 (i) の実測 |
| G3 最後の署名は残り、途中（3・4）が欠けている | **見逃す**（5・6 を印なしで保存） | 見逃す | 同上。限界 (iii) の実測 |
| findex 既存試験 | 27/27 | 20/20 | version 1 の取引で取得が止まる試験を含む |
| ER（`frontier-er`） | 未取り込み | 模型のホスト試験 26/26 通過。書込みを失った ER は「止まる」（検出）で、最後に確定した状態へ戻すだけ（失った書込みは復元しない） | 決定的な模型で、実 ER ではない。LiteSVM（`svm-tests`）は未実行 |

**検査を通っても、完全な履歴や「未発送」の証明にはならない**（G1・G3 のとおり）。

## 10.3 その他の再現試験（統合候補）

- 修正済み: herald の A1・A1c・A2・C2（4/4）。verify の X2・X2b・X2c。
- 再現: verify の A8（CPI だけで届いた取引が判定されずに PASS）。gateway の B1（2,000 件後の再送）、B8（同じ tick の二重行動）、A7、C3、T19-1（旧試作の crank の解除順）。
- 統合候補の `npm test` は 2,598 件で、通過 2,588、失敗 9、スキップ 1。失敗はすべて⑯の再現試験。keeper（単体 133、play 14＋無効 1、ほか全通過）、findex 27/27 は⑯の試験を除いて全通過。

## 10.4 重大な残件

1. **統合候補の BeaconLog 再投稿**（⑧の `5366f7c5` 未取り込み）。余分な手数料だけで状態は壊れないが、再起動のたびに地域数ぶん発生する。
2. **A8: 検証器が CPI で届いた取引を判定せずに PASS する**。③の採用の前提にかかわる。
3. **B1・B8: agent の再送と二重行動**。B8 は仕様が決まっていない（10.6.2）。
4. **⑰の応答の誤り（T17-3・T17-5）**。資金は二重に動かないが、利用者に誤った状態を見せる。
5. **履歴の欠落検出の限界（G1・G3）**。公開 RPC の履歴を、完全性の証明に使えない。
6. **有限シーズンの旧経路（P2〜P4）**。継続世界へ移らない世界は境界で止まる。移行の手順は⑧と④の判断。
7. **実チェーン（SBF・LiteSVM・Agave・live drand・devnet・TLS）での確認が全くない**。上の判定は、ネイティブの代役と台本のチェーンの上での結果。

## 10.5 未実行の項目

- SBF の program を使う試験すべて（⑧ `svm-tests/tests/continuous.rs`、⑲ `frontier-er/svm-tests`、Reveal の `AlreadyDone`）。Agave 3.1.9／platform-tools v1.52 の導入は保留のまま。
- live drand での「公開前は開けない」確認、devnet、TLS 依存。
- 統合候補 `67fb05a1` での再実行（差分は Clippy と CI だけ）。
- 統合側の P2・P3 の隔離コピー（未受領）。
- ⑱の tree での出発直後の送信段試験（④のシナリオが⑱の tree に無い）。
## 10.6 未決の仕様：選択肢ごとの挙動とリスク（⑯は決めない）

### 10.6.1 Reveal を受け付ける時刻の下限

現状（統合候補 d0949fd4／⑱ 0bba3f31 の両方）：`/v1/reveal` は時刻の下限なしで受け付け（出発直後でも `202`）、journal に保存します。チェーンへの送信は、チェーン上の THE anchor と、自分で検証した T(arrive) の署名が揃うまで止めます。Web（`marchbook.mjs revealStep`）は到着ターンの開始時に gateway の `/f/reveal` へ平文を渡します。keeper の表（`play.rs:6`「from the bell start」）と README:25（「到着ターンが終わるまで秘匿」）の文言は、どちらも現在の挙動と一致しません。

| 選択肢 | 公開チェーンへの漏えい | 運営（gateway・keeper）が平文を持つ期間 | 所有者側の失敗 | 実装の差分 |
|---|---|---|---|---|
| A. 下限なしで受け付け、送信は anchor と T(arrive) まで保留（現状） | なし。④と⑱の試験で確認済み。⑯の出発直後の試験は 10.2 を参照 | 出発直後から決着まで（最大で行軍の全期間）。journal・バックアップ・ログが漏れると秘匿性が崩れる。運営者自身には秘匿されない | 少ない（端末の時計がずれていても届く） | なし。文言だけ直す |
| B. 到着ターン開始から受け付け、送信は保留（P11 の受付部分＋現状の送信条件） | なし（同上） | 約 1 ターン（600 秒）＋drand の遅延 | 時計の進んだ端末は `425` を受けて再送が必要 | 小さい（`judge` に下限、Web はすでに開始時に送る） |
| C. T(arrive) が公開されてから受け付け | なし | 公開後だけ。誰でも封を開けられるので運営の優位はない | 窓が `A + W − 2 slots` までに縮み、間に合わない所有者は keeper の decrypt 頼みになる。受付時に drand の検証が要る | 中程度（`judge` で drand を参照、Web のタイマー変更） |

どれを選んでも、チェーン上の秘匿は送信側の条件（anchor と T(arrive)）が守ります。選択肢が変えるのは「運営をどこまで信頼するか」と「所有者が間に合うか」だけです。

### 10.6.2 同じターンの二重行動（本人の MCP と運営の runner）

統合候補で B8 は再現します。gateway には、送信元をまたいで同じ agent の行動を直列化する仕組みがなく、同じ tick に 2 件とも `sent` になります。

| 選択肢 | 挙動 | リスク |
|---|---|---|
| 1. 許す（現状） | 両方送る | 両方受理される命令の組なら、二重の状態変更（資源の二重消費、意図しない連続行動）になる。2 件目が拒否される組なら、余分な手数料だけで済む |
| 2. agent ごと・ターンごとの lease で直列化 | 先に取った側だけが送れる | lease を持ったまま落ちた側の扱い（期限、取り消し）。runner が止まると本人も待たされうる |
| 3. 本人を優先（MCP の操作があったターンは runner が引く） | runner がその agent のそのターンを見送る | 本人の操作の検出遅れで競合が残る。「本人の操作」の定義（予約、取り消し）が必要 |

どの命令の組が「両方受理」になるかは、プログラム本体（SBF）の試験が要り、未実行です。


# 第6期（2026-11-05/06）：⑯ 7bce86ff を基準にした、統合の後続候補での再検証

基準: ⑯ `7bce86ffb0169f7d76cbcac745a89b55eae5d971`（GitHub 上の⑯ブランチ、第5期の結果）。

## 11.1 対象の版

- ④に現在の統合版の完全な SHA と tree を問い合わせた（send_message）。本節の作成時点で返信はない。
- GitHub の `integration/ws09-13-v16-d0949fd4` の先頭は `ef63544c727490fc6801d30affd11c5b7106c480`（tree `aa0493bec03dfc0275829ea89f10003acb54cfd2`）。以下は**「GitHub で読める最新」としての ef63544c** に対する結果で、④の現在版とは確認できていない。④の手元にこれより新しい版がある場合は、その完全な SHA と bundle（ファイル名と sha256）が要る。
- d0949fd4 → ef63544c の 7 commit: Clippy の整理（`4a5230b7`）、CI に Prize のビルドを追加（`67fb05a1`）、⑨⑩の Custody adapter（`52a43745`、workstreams/10-custody のみ）、web relay の試験用データ（`06b5686b`）、未知の登録鍵を置き換えるときの開示（`c2e48e50`、A7）、再試行時に支払い済みを説明する（`3a57d9b8`、T17-3）、Wallet Standard のアカウント切替で表示を更新する（`ef63544c`、C3）。

## 11.2 試験の制約（今回から）

固定 seed を含め、鍵の生成・導出・署名を伴う試験は行わない。該当するのは、CPI の誤 PASS（A8：固定 seed の `Keypair` で取引に署名）、BeaconLog 再投稿（keeper が master から支払い鍵を導出して署名）、B1・B8（`Keypair.generate` と所有者の署名）、⑰の T17-2・T17-3・T17-5（支払い取引の署名）、keeper の World 系の試験（運営の鍵で署名）。これらは ef63544c では**実行していない**。代わりに、対象のコードが d0949fd4（第5期に実行した版）と同じであることを git の tree・blob の SHA で確認し、変わった部分はコードを読んで判定した。第5期のこれらの実行（d0949fd4 上）は、この制約より前に行ったもの。

鍵を使わない試験だけを ef63544c で実行した: findex の履歴欠落（署名はただのバイト列）、herald、web の A1・A7・T18-1・T19-1、ABI の境界、C3 の新しい試験（固定のアドレス文字列だけを使い、鍵も取引も作らない）。すべてホスト上の実行で、実 SBF・実チェーンではない（下表の「種別」）。

## 11.3 結果（d0949fd4 で再現したもの／後続候補で直ったもの）

| 項目 | d0949fd4（第5期） | ef63544c（GitHub 最新の統合） | 根拠と種別 |
|---|---|---|---|
| A8 CPI だけで届いた取引の誤 PASS | 再現（実行、ホスト） | **未修正（コード同一）** | `frontier-node/crates/verify/src` の tree `c0e4e3028ad7f67b9c4e7275854bb6a13241f0b0` が両版で同じ。鍵の制約により ef63544c では未実行 |
| BeaconLog の再起動後の再投稿（余分 16 件） | 再現（実行、ホスト、program はネイティブ代役） | **未修正（コード同一）** | `keeper/src/beacon.rs` の blob `9fd7570f95d534a971888f8f3c4f9e63a945802b` が同じ。`engine.rs` の差分はテストモジュール内だけ。未実行 |
| B1 2,000 件後の再送 | 再現（実行、ホスト） | **未修正（コード同一）** | `permutation-gateway/src/frontier/agent` の tree `ebae7d979105e7e2899c89864597c4384e998a54`（`ledger.mjs` の blob `0a47782347309b767b92e58e3555b60a27eb367c`）が同じ。gateway の src で変わったのは `prize.mjs` だけ。未実行 |
| B8 同じ tick の二重行動 | 再現（実行、ホスト。仕様未決） | **未修正（コード同一）** | 同上。未実行 |
| T17-2 応答が失われた後の同じ支払いの再送 | 再現（実行、ホスト）。⑰ 0c80381d では修正済み | **未修正（コード読解）** | `prize.mjs` の差分は AlreadyPaid の分岐の追加だけで、Duplicate の扱いは変わらない。⑰はまだ取り込まれていない。未実行 |
| T17-3 504 の後の新しい取引での再試行が `402 AlreadyPaid` | 再現（実行、ホスト） | **修正（コード読解のみ）** | `3a57d9b8`: AlreadyPaid のとき、確定（finalized）した Entry と Citizen を読み、そろっていれば `409 AlreadyJoined`、なければ `409 AlreadyPaid`（「再び支払わないで」と案内）。⑯の試験の合格条件は `AlreadyJoined` を含むが、署名が要るため未実行 |
| T17-5 読めない Claim の金額を `"0"` と返す | 再現（実行、ホスト） | **未修正（コード読解）** | `prize.mjs` の Claim の経路は変わっていない。未実行 |
| C3 ウォレットのアカウント切替 | 再現（模型の試験） | **修正（実行、ホスト）** | 新しい試験 `v16-web-wallet-switch-adopt.test.mjs`（鍵なし）は、本物の `controller.mjs` の `adoptConnectedWallet` で、前のアカウントの session・Citizen・保有地・賞金が残らないことを確認した。ef63544c で通過、d0949fd4 では失敗（関数がない）。変更イベントから呼ばれる経路（startPlay 内）はコード読解だけ |
| A7 ③の委任中に「鍵がない」と誤表示 | 再現（実行、ホスト） | **一部修正（表示のみ）** | ⑯の試験（`delegatedTo` が別の鍵を見分ける）は ef63544c でも失敗（実行）。ただし `c2e48e50` で、`SessionMismatch` かつ登録鍵があるときは「登録鍵を変更すると現在の鍵は使えなくなる」と開示するカードになった（コード読解）。黙って委任を取り消す害は緩和。誰に委任しているかは判別しない |
| ⑲ 履歴欠落 G2 最後の署名の消失 | 検出（実行） | **検出（実行、ホスト）** | `findex/src` の tree `ad1374331c044dce529c395057c1e102b307b1e0` が同じ。`v16_history_gaps` 3/3 |
| ⑲ G1 初回の先頭の欠落 / G3 途中の欠落 | 見逃す（実行） | **見逃す（実行、ホスト）** | 同上。完全な履歴の証明にはならない |
| herald A1・A1c・A2・C2 | 修正済み | 修正済み（実行、4/4） | |
| ABI P2〜P4（有限シーズンの境界） | 再現 | 再現（実行、1/4） | `frontier-abi/src` の tree `873e1a86f6a62ce4dd70717bb3948dfad338d8e8` が同じ |
| T18-1 / T19-1 | 再現 | 再現（実行） | T18-1 は仕様（10.6.1）、T19-1 は旧試作 |

## 11.4 種別のまとめ

- **実 SBF・実チェーンでの実行: なし。** Agave 未導入、LiteSVM 未実行、devnet・live drand に触れていない。
- **ホストでの実行（ef63544c）:** findex 3、herald 4、ABI 4（1 通過、3 は再現）、web の node 試験 6（通過は A1・A1b・C3b、失敗は T18-1・T19-1・A7）。ログは `logs/phase6/`。
- **コード同一による引き継ぎ（ef63544c では未実行）:** A8、BeaconLog、B1、B8。
- **コード読解だけ:** T17-2（未修正）、T17-3（修正）、T17-5（未修正）、A7 の開示、C3 の呼出し経路。

## 11.5 残件（ef63544c 時点）

1. A8: 検証器が CPI で届いた取引を判定せずに PASS させる。
2. BeaconLog の再起動後の再投稿。⑧の `5366f7c5` が未取り込み。
3. B1・B8（B8 は仕様未決）。
4. ⑰: T17-2（⑰の修正が未取り込み）と T17-5。T17-3 は修正されたが、実行での確認は鍵の制約のためできていない。
5. A7: 開示はされたが、委任先の判別はしない。
6. 履歴欠落の検出の限界（G1・G3）。
7. 有限シーズンの旧経路（P2〜P4）。
8. ④の現在版の確認（SHA・tree の返信待ち）、統合側の P2・P3 の隔離コピー（未受領）。

鍵を使わずにこれらを実行で確かめるには、次のどちらかが要る。(a) 鍵の材料を含まない、署名済みの取引のデータ（ファイル）を試験の入力として受け取る。(b) 署名を検査しない経路（シミュレーション専用の入口など）が実装側に用意される。どちらも⑯は作らない。

## 11.6 ④の現在版 77c5cbe2 での再検証（④の返信後）

④の返信（2026-11-05T23:27Z）: 現在版は `claude/gallant-ride-cunptv` の `77c5cbe2398c89559417f8cf18d4065b51455ee6`（tree `5d39646313d3307c479b9ea761276487b6f0bd8c`、文書だけ）。一つ前の `0a5473af925c713b3a8daf90e59cccf50f7823db`（tree `d12d172022f0d5f947e9d9a0c80dec6538ceae77`）がコードと試験。基点は ef63544c。⑯が GitHub から取得して、SHA・tree・祖先関係（ef63544c ⊂ 0a5473af）が一致することを確かめた。

ef63544c からの差分は agent wallet だけ（`permutation-gateway/src/frontier/agent/{contract,fate,gateway}.mjs`、`app.mjs`、`routes/agent.mjs`）。以下は ef63544c と tree・blob が同じ: 検証器（`c0e4e302…`）、`keeper/src`（`d2cf3e20…`、`beacon.rs` `9fd7570f…`）、`prize.mjs`（`2cb01998…`）、findex（`ad137433…`）、ABI（`873e1a86…`）、Web（`permutation-server/web/frontier` `f5690ca5…`）、herald（`b027227a…`）。

| 項目 | 77c5cbe2 | 根拠と種別 |
|---|---|---|
| A8 CPI の誤 PASS | 未修正（コード同一） | 未実行（鍵の制約） |
| BeaconLog の再投稿 | 未修正（コード同一） | 未実行（鍵の制約） |
| B1 2,000 件後の再送 | 未修正（コード読解） | `ledger.mjs` は変わらない。新しい `GET /f/agent/fate` は、保持期間を過ぎた記録を「not-sent」ではなく「unqueryable / retained:false」と答える（⑯の独立試験 V16-F1〜F3 で確認、鍵なし、ホスト、3/3）。これは「分からない」を正しく言うだけで、上限を過ぎた要求の再送を止める修正ではない |
| B8 同じ tick の二重行動 | 未修正（コード読解） | 送信元をまたぐ直列化は入っていない。仕様未決 |
| T17-2・T17-5 | 未修正（コード同一） | `prize.mjs` が ef63544c と同じ |
| T17-3 | 修正（コード読解のみ） | 同上（ef63544c の修正のまま） |
| C3 | 修正（実行、ホスト） | V16-C3b 通過 |
| A7 | 一部修正（表示のみ） | ⑯の試験はまだ失敗（実行） |
| ⑲ G2 / G1・G3 | 検出 / 見逃す（実行、ホスト） | 3/3 |
| herald | 修正済み（実行、4/4） | |
| ABI P2〜P4 | 再現（実行、1/4） | |
| T18-1・T19-1 | 再現（実行） | |

④が報告した試験（ws04 85 通過・9 無効、e2e-native 8、agent-wallet-run-facts 4）は④の結果で、⑯は再実行していない（⑯の結果に数えない）。

実 SBF・実チェーンでの実行はなし。ログは `logs/phase6/77c5-*.log`。

## 11.7 添付の差分パッケージ（⑮向け）と 1913625d の照合

受領物: `wylls-candidates-clean-patches-20261105.tar.gz`（sha256 `d16b812d5cec881a7997bb0e696f62754e11ff99dcf843a48034d9b502ece7be`、43,931 バイト、10 ファイル）。同梱の `SHA256SUMS` は 9 ファイルすべて OK。MANIFEST の `source_archive_sha256` は `ffe109bd…4bd`（元のアーカイブで、⑯は受け取っていない）。commit オブジェクトと履歴は含まれていない（README の記載どおり）。MANIFEST と SHA256SUMS の写しは `inbox/` に置いた。

### 1913625d の正体（MANIFEST による）

⑮が照合を求めた `1913625d` は、⑮の修正の commit ではなく、**`13-15-integrated` の当て先（`required_base_commit`）`1913625de7f3b1361d509c05982410dccb27718d`** だった。修正後の候補は `refs/heads/fix/ws13-review-integrity-20261105` の `9905c6863e20c9c6db4debfff12022ec6eb3beb9`（期待 tree `93c2263f74ef5c7e0fadd4a2e1b8dda67062b01a`）。⑮だけの系列 `15-separate` は、基点 `32ad894dfe4659e716421c711d8170c7c86e50d4`、候補 `refs/heads/fix/ws15-exact-source-identity-20261105` の `33d8c9fd88448f8dc783f9050c1421cf93cb1861`、期待 tree `d64b3f36401970f8bd59430e3075728a0431ab8c`。

### 一致した点（実行した照合）

- `13-15-integrated.patch` の⑮部分（`workstreams/15-coop-outcomes/src/adapters/s1-chain.mjs` と `test/s1-exact-source-no-keys.test.mjs`）と `15-separate.patch` は、ファイルごとの差分本文が**完全に同じ**。index 行も同じ（`s1-chain.mjs` `fd015ddc…` → `bca55303…`、試験 新規 → `50f8b477…`）。README の「15-separate は 13-15-integrated に含まれる 15 修正の別系列、二重適用しない」と合う。
- MANIFEST の `changed_files` は各パッチ内のファイルと一致する（⑮関係の 2 ファイル）。
- パッチの内容は README の説明（不正な整数・位置・bytes の拒否）と合う。鍵・署名・導出の操作はない（「derive」は数値の導出の意味だけ）。

### 一致しない／確かめられない点

1. **基点が手元にも GitHub にもない**: `1913625d`、`32ad894d`、候補の `9905c686`、`33d8c9fd` はどれも、ローカルのオブジェクトにも `git ls-remote origin` にもない（⑮の公開ブランチは `preserve/ws15-b1a09a0b` だけ）。このため README の手順（基点に当てて `git write-tree` を `expected_tree` と比べる）は**実行できず、expected_tree は未照合**。
2. **基点と⑮の公開版の中身が違う**: パッチの前の状態の `s1-chain.mjs`（blob `fd015ddc…`）は、ローカルのどの commit にもない。⑮の公開版 `b1a09a0b` の同じファイルは blob `9d8da975…`。パッチは `b1a09a0b` にも当たる（3 つの hunk がすべて 1 行ずれで成功）が、結果の blob は `9c4d8764…` で、期待の `bca55303…` と違う。
3. **⑮自身の新しい試験が b1a09a0b では通らない**: `b1a09a0b` に当てると、⑮の 70 件の既存試験は通るが、新しい試験 `S1 source positions, packed places and bytes remain exact` が `cargo: invalid bytes` で失敗した。試験の最後の検査は、荷の無い `CARAVAN_SETTLED` を「`verified exact cargo evidence` が無い」として保留する動作を前提にしている。この動作（文字列を含む）は `b1a09a0b` にも GitHub のどの ref にもない。**基点 1913625d／32ad894d には、⑮の公開版に無い⑮の変更（荷の証拠を確かめる経路）が含まれている**と判断した。その変更自体はこのパッケージに入っていない。

### ⑯の独立試験（鍵なし、ホスト）

`probes/v16-ws15-exact-source.test.mjs`（リテラル入力だけ）。`b1a09a0b` で、パッチ無しとパッチ有りを比べた。

| 試験 | パッチ無し | パッチ有り |
|---|---|---|
| V16-15a 位置の上限（2^53−1 は通る、それを超える数・小数・bigint は拒否） | 失敗 | 通過 |
| V16-15b 同じ位置の表記ゆれ（'7'、7、7n）で event id が同じ | 通過 | 通過 |
| V16-15c bell は u32（0 と logBell は通る、負・小数・2^32 は拒否） | 失敗 | 通過 |
| V16-15d place と cargo の境界 | 失敗 | 通過 |
| ⑮の既存試験 70 件 | 全通過 | 全通過 |
| ⑮の新しい試験 | （無い） | **失敗**（上の 3） |

ログ: `logs/phase6/ws15-b1a09a0b-{patched,unpatched}.log`。

### 未検証

- 基点 `1913625d`／`32ad894d` に当てたときの tree（`93c2263f…`／`d64b3f36…`）。基点の bundle か、基点を含むブランチが要る。
- `13-15-integrated` の⑬部分（⑬の照合記録・請求申告）。今回の依頼の範囲外で、試験もしていない。
- 08・13-retention・18・20 のパッチ。今回は対象外。

## 11.8 ④の更新 95686606（2026-11-06T00:04Z の連絡）

④の新しい現在版は `claude/gallant-ride-cunptv` の `9568660675ad5464dcd2ce1a0f266f5a7dfb39cb`（tree `09d14584a6e03da5e1699883bd1fc390d55f7cb1`、文書だけ）。コードはその親の `b82fafa8f8095f83f157fcf80d2f15943982ebc4`（tree `39a95c7a171c2d536b0cf647cecc035a9cc1dc44`）で、さらにその親が `77c5cbe2`。⑯が GitHub から取得して、SHA・tree・祖先関係を確かめた。

77c5cbe2 からの差分は `workstreams/04-execution/` の中だけ（`runexec act` の入口、`clients/acts.mjs`、chunked 応答の読み取りの修正、その試験）。優先項目のコード（検証器、keeper、`permutation-gateway/src` 全体、agent wallet、`prize.mjs`、findex、ABI、Web、herald）は、77c5cbe2 と tree・blob の SHA が同じ。**したがって 11.6 節の判定は 95686606 でもそのまま当てはまる（コード同一による引き継ぎで、95686606 での再実行はしていない）。** ④の `runexec` と `clients/acts` は⑯の検証対象に入れておらず、④が報告した試験（ws04 91 通過・9 無効、act_cli 5、acts 4、e2e-native 8）は④の結果。


# 第7期（2026-11-06）：④ 77c5cbe2／95686606、⑪ c8d694bd、⑮・⑱・⑲ の新しい版

鍵の生成・導出・署名を伴う試験は行わない（第6期と同じ制約）。実 SBF・実チェーンでの実行はない。すべてホスト上の実行かコード読解。

## 12.1 固定した版と取得状況

| 担当 | 版（完全な SHA） | tree | 取得 |
|---|---|---|---|
| ④ | `9568660675ad5464dcd2ce1a0f266f5a7dfb39cb`（コードは `b82fafa8f8095f83f157fcf80d2f15943982ebc4`、その前が `77c5cbe2398c89559417f8cf18d4065b51455ee6`） | `09d14584a6e03da5e1699883bd1fc390d55f7cb1` | GitHub `claude/gallant-ride-cunptv` |
| ⑪ | `c8d694bd2b3ac4a08e3ad5633bf1d8b623be32f8` | `2be2e7deda9eaf827223871bb7ca482a47d82b96` | GitHub `claude/kind-fermat-earbxe` |
| ⑪の候補を当てた検証用 tree | ④ `95686606` ＋ ⑪ `0004` ＋ `0005`（⑯の試験ファイルを除く） | `7d48ee2d9c8128fb6aa8ae9879028434f7bb2ceb` | ⑯が作成（隔離 worktree、未 commit） |
| ⑮ | `b295ca3eac6767ab0b2f47f5e09c608163c6d732` | `72b885182371907a3da242a4a38441fca9165ccb`（⑮の申告） | **未取得**（bundle 待ち） |
| ⑱ | `b71b8197190ff05e9e999eff45a2ddea6b2b8d1f` | `ff7b7fccb6d8b2eb331dec9b4601527cf4dee05b`（⑱の申告） | **未取得**（bundle 待ち） |
| ⑲ | `6b5f06210642d935a3e1b588b99511fb1666a47a` | `103d7f70e74ff464c8c235066dc42e491ab36c3d`（⑲の申告） | **未取得**（bundle 待ち） |

⑪のパッチの照合: `c8d694bd` の `workstreams/11-extensions/patches/` から取り出した `0004-verify-v0e-evidence-is-unverifiable.patch` の sha256 `258ad75901a637c97f4df06655b2d01b4f744a255eff8bbeacfb6ff22dd21660`、`0005-verify-v0e-cpi-only-and-lost-tail.patch` の `09beb7bce149c3628f516f1b6285c090e9f159ea1b7fb916fcd0e304f4067639` は、⑪の README の値と一致した。README の指定どおり 0004 → 0005 の順に、`ef63544c` と検証器のコードが同じ④の `95686606` に当てた（`git apply --check` 成功）。変更は `frontier-node/crates/verify` の `checks/mod.rs`、`checks/v0_evidence.rs`（新規）、`codes.rs`、`tests/evidence.rs`（新規）だけ。

### 必要な bundle（利用者経由で受け取る。どれも前提の commit は⑯の手元にある）

| 担当 | ファイル名 | sha256（申告） | 前提 | 中の ref → HEAD |
|---|---|---|---|---|
| ⑮ | `ws15-b1a09a0b-to-b295ca3e.bundle`（99,362 バイト） | `8194af20c446c4ab97241a5f8afc8b9672ffd52203ae0f9cc1a18f979959777f` | `b1a09a0b15dd44f587b1158fc40dd3f17577fcca` | `refs/heads/ws/15-coop-outcomes` → `b295ca3e…` |
| ⑱ | `r18-on-integration.bundle` | `a1d0c8b63fd264cdd5c730cc14e0e5f900f7681ea51c8405e728a6b899bcdd69` | `ef63544c727490fc6801d30affd11c5b7106c480` | `refs/heads/r18/on-integration-ws09-13-v16` → `b71b8197…` |
| ⑲ | `ws19-on-77c5cbe2.bundle` | `5aecee6ceb174267655ac229d49d3b2d137ca60b21fb2a14e1c3ecb7e78a12d7` | `77c5cbe2398c89559417f8cf18d4065b51455ee6` | `ws19/on-77c5cbe2` → `6b5f0621…` |

⑲の旧 bundle `ws19-20261105.bundle`（sha256 `a6614bc9…0963`、前提 `d793ebd4` と `d0949fd4`）は、⑲自身が `ws19-on-77c5cbe2` を正としているため不要。

## 12.2 ⑪：CPI の誤 PASS とログ欠落（A8）を、鍵なしの新しい試験で

A8 の旧試験（`v16_unknown_tag.rs` の v16_a8）は固定 seed の鍵で署名するので使わない。代わりに `frontier-node/crates/verify/tests/v16_cpi_keyfree.rs` を書いた。記録済みの fixture（データ）に、署名のない取引（`Transaction::new_unsigned`、署名欄はゼロ）を固定のアドレスで足すか、記録済みの取引のログを削るだけ。PDA の導出もしない。

| 試験 | ④ 95686606（パッチなし） | ＋⑪ 0004＋0005 |
|---|---|---|
| K0 対照: fixture はそのまま PASS | 通過 | 通過 |
| K1 別のプログラムの中で Frontier が動いた（`invoke [2]`） | **PASS になる（再現）** | 非 PASS（修正確認） |
| K2 Frontier を口座に挙げ、ログがない | **PASS（再現）** | 非 PASS（修正確認） |
| K3 Frontier を口座に挙げ、ログが切れている | **PASS（再現）** | 非 PASS（修正確認） |
| K4 完全なログが、Frontier が動いていないことを示す（挙動の記録） | FAIL ではない | FAIL ではない |
| K5 成功した Frontier の取引の、ログの末尾（最後の `success` 以降）が印なしに消えた | **PASS（再現）** | 非 PASS（修正確認） |

⑪自身の `tests/evidence.rs`（8 件、鍵の操作なしを確認）もパッチ後に全通過。ログ: `logs/phase7/a8-95686606-unpatched.log`、`a8-95686606-p0004-p0005.log`。

注意: 第5期の A8 の再現試験は、Courier だけのログ（Frontier が動いていないと読めるログ）を付けていた。これは K4 に当たり、0004＋0005 の後でも PASS のままでよい形だった。今回の K1〜K3・K5 が、A8 の正しい形の再現。0004＋0005 は④の現在版に**未適用**（候補）。

## 12.3 古い版の問題と、現在も残る問題

| 項目 | 古い版で再現（版） | ④の現在版 95686606 | 後続の候補 |
|---|---|---|---|
| A8 CPI の誤 PASS・ログ欠落 | d0949fd4（第5期） | **残る**（K1〜K3・K5 を実行で再現） | ⑪ 0004＋0005 で修正を確認（未適用） |
| BeaconLog の再起動後の再投稿 | d0949fd4 | 残る（コード同一。未実行） | ⑧ `5366f7c5`（未取り込み） |
| B1 保持上限を超えた再送 | d0949fd4 | 残る（コード読解） | なし |
| B8 同じ tick の二重行動 | d0949fd4 | 残る（コード読解、仕様未決） | なし |
| T17-2 / T17-5 | d0949fd4 | 残る（コード読解） | ⑰ 0c80381d で T17-2 は修正（未取り込み） |
| T17-3 | d0949fd4 | 修正（コード読解のみ） | — |
| C3 アカウント切替 | d0949fd4 | 修正（実行） | — |
| A7 委任中の「鍵がない」 | d0949fd4 | 一部修正（表示だけ） | — |
| T18-1 Web の自己公開が到着ターン開始時 | d0949fd4・0bba3f31 | 残る（実行） | ⑱ `b71b8197` が「T(arrive) 公開＋5 秒以降」にすると申告。**未検証**（bundle 待ち） |
| T18-3 Reveal 再送の手数料 | 0bba3f31（⑱の旧版） | 修正済み（d0949fd4 以降） | ⑱ `b71b8197` は「まだ着地しうる W 版を N=2 件まで」と申告。未検証 |
| ⑲ G1・G3（初回・途中の欠落を見逃す） | d793ebd4・d0949fd4 | 残る（実行） | ⑲ `6b5f0621` は RpcPoll の検出を変えていないと申告。未検証 |
| ⑮ 荷の証拠の経路 | b1a09a0b ＋ 15-separate で⑮自身の試験が失敗 | — | ⑮ `b295ca3e` が経路を書き直したと申告。未検証 |
| P2〜P4 有限シーズンの境界 | 全版 | 残る（実行） | — |

## 12.4 未確認

- ⑮ `b295ca3e`、⑱ `b71b8197`、⑲ `6b5f0621`: bundle を受け取っていない（12.1 の表）。
- ⑪ 0004＋0005 を当てた状態での、検証器の既存の試験のうち鍵や World を使うもの（`record.rs` など）。実行していない。
- 実 SBF・実チェーン・LiteSVM: 実行なし。

## 12.5 ⑱ r18-on-integration.bundle（受領後）

受領物: `r18-on-integration.bundle`（12,541 バイト、sha256 `a1d0c8b63fd264cdd5c730cc14e0e5f900f7681ea51c8405e728a6b899bcdd69`、申告と一致）。前提は `ef63544c727490fc6801d30affd11c5b7106c480` だけ。空の検証用リポジトリに `ef63544c` だけを入れ、bundle から `refs/heads/r18/on-integration-ws09-13-v16` を取り込んだ。HEAD `b71b8197190ff05e9e999eff45a2ddea6b2b8d1f`、tree `ff7b7fccb6d8b2eb331dec9b4601527cf4dee05b` で申告と一致。`git fsck` は問題なし。

### ⑱の変更と現在版の区別

- ⑱の 4 commit（`ef63544c` の上）: `70843bb5…`（keeper: 所有者の追跡をチェーン上の REVEAL から landed にする、再起動後の追跡を返す）、`0147a885…`（keeper: まだ着地しうる W 版を N 件まで。keeper.toml の既定 2、`EngineParams::default` は 0）、`3b7c090e…`（Web: 自己公開は T(arrive) の公開＋5 秒以降）、`b71b8197…`（bots: 所有者の material は T(arrive) の公開＋5 秒以降）。
- 変更は 9 ファイル（keeper の `config.rs`・`engine.rs`・`lib.rs`・`play.rs`、agents の `obs.rs`・`policy.rs`、Web の `controller.mjs`・`marchbook.mjs`、試験 `web-frontier-marchbook.test.mjs`）。④の現在版 `95686606` の変更（`workstreams/04-execution/` だけ）と重ならず、`git merge-tree` で衝突なしに合わさる（合わせた tree `1953c4872c466cf442c3c3f3363e5353bd462fa0`、⑯は commit していない）。
- 検証器、findex、herald、ABI、`reveal_accept.rs` は⑱の変更の外。そこでの判定（A8、G1・G3、P2〜P4、T18-2 の早期受付）は⑱の版でも変わらない（コード同一）。

### 実行した試験（鍵なし、ホスト）

| 試験 | ⑱ b71b8197 | 対照 ef63544c |
|---|---|---|
| ⑯ V16-T18-1b: 本物の marchbook・clock・seal で、到着ターン 1〜300、遅延 0・7・20 秒、1 秒ごとに問い合わせ、自己公開が封の round の公開＋5 秒より前に出ない | 通過 | 失敗 |
| ⑯ V16-T18-1c: 公開前に記録された 1 回目の後の再試行も、公開まで待つ | 通過 | 失敗 |
| ⑯ V16-T18-1d（読解）: controller の `revealStep` 呼び出しがすべて `notBefore` を渡し、それが `tlockRound` と余裕から計算されている | 通過 | 失敗 |
| ⑯ v16_r1（agents）: bots の所有者が開くのは公開＋5 秒ちょうどからで、1 秒前は閉じている。到着ターンの開始と arrive+2 では閉じている（ターン 8 通り、genesis のずれ 0〜2 秒） | 通過 | — |
| ⑯ v16_c1・c2（keeper）: 版の上限は、決着しておらず blockhash が有効な版だけを数える。keeper の既定は 2、engine の既定は 0、負の値は拒否 | 通過 | — |
| ⑱自身の試験（⑯が実行）: keeper の owner_track 4 件、`live_unknown_versions`、config、api の journal 2 件、agents の reveal_time 1 件、web の marchbook 7 件 | 全通過 | — |
| ⑯の旧 T18-1（`revealStep` を `notBefore` なしで呼ぶ） | 失敗のまま（`notBefore` を渡さない呼び出しは従来の時刻。想定どおり） | 失敗 |
| A1・A1b・C3b・A7・T19-1 | 第6期と同じ（A7・T19-1 は失敗のまま） | 同じ |

ログ: `logs/phase7/r18-node.log`、`r18-rust-keyfree.log`、`ef-control-reveal-not-before.log`。

### 判定

- **T18-1（Web の自己公開が到着ターン開始時）: ⑱の候補で修正を確認**（関数と controller の呼び出しの読解。ブラウザでの実行はしていない）。④の現在版には未取り込み。
- **bots の所有者の公開時刻: ⑱の候補で修正を確認**（関数の実行）。
- **Reveal の版の上限 N=2:** 数え方と設定の受け渡しは確認した（純関数と設定の読み込み）。上限が実際に送信の件数・手数料を減らすか、窓を逃さないかは、engine が鍵で署名して送る試験が要るため**未確認**。コード読解では、上限にかかった書込みは捨てられず次の巡回まで待つ（`continue`）。古い版が失効する 151 スロット（約 60 秒）までは新しい版を出さない。Reveal の窓 W は 600 秒なので締め切りは越えないが、混雑時に着地が遅れる可能性はある。
- **所有者の追跡状態（landed／再起動後の queued）:** ⑱の単体試験 4 件の実行だけ。API を通した確認は鍵を使う World の試験が要り、未確認。
- **T18-2（keeper の `/v1/reveal` が到着前の平文を受け付けて保持する）:** ⑱の版でも変わらない（`reveal_accept.rs` は変更外）。送信は保留される設計で、受付の下限は未決の仕様（10.6.1）。

### 実行できない試験（鍵の生成・導出・署名を伴う）

- `web-frontier-marches.test.mjs`（サンプル世界が鍵を作って署名する）。⑱によれば、到着ターン内の Reveal を前提にした 4 件が失敗する見込み。
- keeper の `tests/play.rs` の場面と④の Reveal 試験（N=2 で送信件数・手数料・crash injection の件数が変わる見込み）。
- ⑯の T18-2（World）、T18-3（engine の送信）、BeaconLog の再起動試験。
- `cargo clippy`（1.95）は実行していない。


# 第8期（2026-11-06）：賞金の受取権と、終了後の命令の順序

対象: ④ `claude/gallant-ride-cunptv` の `b858e40d954cdc2ebbcac5a7edb8a251fb701730`（tree `5658edc054884d4937b20e40e778db5bed6fa85e`、GitHub から取得）。95686606 からの差分は ABI の割当表と `workstreams/04-execution/` だけで、`permutation-frontier`・`permutation-prize`・`frontier-abi/src`・keeper は 95686606 と同じ。実配備・実害は**未確認**（調べていない）。

鍵の生成・導出・署名は、共通セットアップを含めて行っていない。実行は④の `e2e-native`（賞金プログラムの `process_instruction` をホストで動かす。System と SPL Token はホストの模型、署名は「署名したと扱う鍵の一覧」で ed25519 なし）。口座は固定のアドレス。プログラム自身と補助関数は program-derived **address**（`find_program_address`、公開のアドレスで秘密鍵は無い）を計算する。これは鍵の導出に当たらないと判断した（判断が違えば、この期の実行結果はすべて「未実行」に読み替える）。ゲームのプログラム（`permutation-frontier`）は実行していない。その CloseCitizen・CloseProvince は、ゲームのコードと同じ結果を与える代役（口座を消す、ProvinceFund の `provinces_opened` を 1 減らす）。実 SBF・LiteSVM・実チェーンは未実行。

## 13.1 コード読解（b858e40d）

| 項目 | 箇所 | 内容 |
|---|---|---|
| CloseCitizen の条件 | `permutation-frontier/src/proc/citizen.rs:2447-2510`、`proc/map.rs season_end_close` | 先頭の口座は `[any s]`（誰の署名でもよい）。Season が Ended で `now ≥ bell_start(end_bell) + 72 h`（`END_GRACE_SECS`）、または Aborted ならすぐ、または tombstone。賞金の Entry・未請求の有無は見ない。残高は Citizen の `rent_payer`（作成時の支払者）へ戻り、呼んだ第三者には何も渡らない（得はなく、妨害だけができる） |
| 72 時間の起点 | `map.rs season_end_ts` | `bell_start(end_bell)`＝**予定の終了時刻**。EndSeason が実際に呼ばれた時刻ではない。EndSeason が予定より 72 時間以上遅れると、Ended になった瞬間に CloseCitizen・CloseProvince が開く |
| shares 方式の Claim | `permutation-prize/src/lib.rs:779-860` | 勝った国の Citizen（ゲームのプログラムが持ち、そのアドレスにある口座）を要求する。期限は無い。Citizen が閉じられた後は `BadAccount` で拒否。Join は終了後に作り直せない |
| refund 方式の Claim | 同 `:811-816` | Citizen を読まない。Entry だけで通る。CloseCitizen の影響を受けない |
| SetShares の時期 | 同 `:736-777` | Finalize の後に一度だけ。期限は無い。72 時間を過ぎてから SetShares すると、その前に勝者の Citizen を閉じられうる |
| CloseProvince | `proc/map.rs:910-970` | `[any s]`、条件は CloseCitizen と同じ。Province を閉じ、その wedge の ProvinceFund の `provinces_opened` を 1 減らす |
| Finalize の照合 | `lib.rs:679-734` | 「Tally で数えた数」と「6 つの ProvinceFund の `provinces_opened` の合計 − 7」が等しいことを要求する。CloseProvince で後者が減る |
| Pay | `lib.rs:522-598` | Season の状態も時刻も見ない。pool が OPEN で `counted == 0` なら通る |
| Tally／Finalize | `lib.rs:600-734` | Season が Ended のときだけ。Aborted では通らない |
| WithdrawOps | `lib.rs:890-931` | OPEN 以外。運営の 20% だけを出す |

賞金の文書（`docs/frontier/map-growth/prize-finalize.ja.md:32,44`）は「Tally と Finalize は Ended から 72 時間のうちに行う必要がある」と書くが、プログラムはそれを強制しない。

## 13.2 実行した場面（ホスト、b858e40d）

`probes/v16_prize_claim_rights.rs`（④の `e2e-native/tests/` に置いて実行。補助関数は④の `legacy_season_claims.rs` を写したもの、場面は⑯）。**どれも「今の挙動」を確かめる試験で、通過＝問題の再現**。修正が入れば P1〜P5 は失敗に変わるはず。

| 場面 | 結果 | 判定 |
|---|---|---|
| P1 勝者 b の Citizen を閉じた後（代役）: b の Claim は `BadAccount`、a は受け取れる、WithdrawOps の後も金庫に b の取り分（賞金の半分）が残り、SetShares をやり直せない（`WrongState`） | 通過 | **再現**（shares の受取権が消え、取り分は永久に動かない） |
| P2 Tally を終えた後に Province を 1 つ閉じる（代役）: Finalize は `WrongExpectedCount`、SetShares・WithdrawOps は `WrongState`、参加費は全額金庫に残る | 通過 | **再現**（第2期 8.1 の「Finalize の固着」を、読解からプログラムの実行に格上げ） |
| P3 まだ数えていない、首位の国（12 州）の州を 2 つ閉じてから残りを Tally: Finalize が通り、勝者が国 1 から国 2（11 州）に変わる。対照（全部数える）では国 1 | 通過 | **新規・再現**（72 時間後に誰でも、未集計の州を選んで閉じることで勝者を変えうる） |
| P4 Season が Ended の後、最初の Tally の前の Pay は通る。Tally を 1 回した後は `WrongState` | 通過 | **再現**（第2期 8.1 の「Pay は無条件」を実行で確認） |
| P5 Aborted の Season: Tally・Finalize は `SeasonNotEnded`、WithdrawOps は `WrongState`、参加費は全額金庫に残る | 通過 | **新規・再現**（中止された季の参加費に出口が無い） |
| P6（対照）refund 方式は Citizen を閉じた後も Entry だけで 80% を受け取れる | 通過 | refund 方式は影響を受けない |
| ④の `legacy_season_claims.rs` 4 件（D3 を含む） | 全通過 | ④の試験を⑯が実行（④の結果と一致） |

ログ: `logs/phase8/b858-prize-claims.log`。

## 13.3 既存の報告との重複の整理

| 問題 | 初出 | 今回 |
|---|---|---|
| CloseCitizen で shares の受取権が消える | ④ `CONTINUITY.ja.md` D3、`INTEGRATION-PLAN-20261031.ja.md` C2、④の試験 | ⑯の P1 で独立に再現。72 時間の起点が予定の終了時刻であること、誰でも呼べること、SetShares に期限が無いことを読解で追加 |
| Pay は終了後も最初の Tally まで通る | ⑯ 第2期 8.1（読解） | P4 で実行 |
| Tally 後の州の閉鎖で Finalize が固着 | ⑯ 第2期 8.1（読解）、④ C2（CloseSeason の場合） | P2 で実行 |
| 未集計の州の閉鎖で勝者が変わる | 新規 | P3 |
| Aborted の季の参加費に出口が無い | 新規 | P5 |
| 継続世界では pool が終わらない | ④・⑰ D2（`while_the_world_runs_deposits_have_no_exit`） | ④の試験を実行して確認（重複のため⑯の場面は作らない） |

## 13.4 修正候補の照合

④と⑰の修正候補は**まだ届いていない**（GitHub の `claude/gallant-ride-cunptv` は b858e40d まで、⑰は `preserve/ws17-0c80381d` まで）。届いたら、同じ `v16_prize_claim_rights.rs` を修正前（b858e40d）と修正後で流し、P1〜P5 の変化を比べる。必要なもの: 修正後の完全な commit SHA と tree、GitHub にない場合は bundle（ファイル名・sha256・前提の commit）。

## 13.5 未確認

- ゲームのプログラムの CloseCitizen・CloseProvince・EndSeason を実際に動かすこと（時刻の条件、誰でも呼べること）。SBF か、ゲームのプログラムのホスト実行が要る。
- 実配備されているプログラムで同じ条件が成り立つか、実害があったか。
- 賞金の運用（Tally・Finalize・SetShares を 72 時間以内に行う規則）が実際に守られているか。

## 13.6 ④の修正候補 RecordNation（f43eb4eb）の照合

対象: GitHub `claude/gallant-ride-cunptv` の `f43eb4eb86f9aec6949ecf361ea13d35694ff639`（tree `38a2eb5a48716f57ba5cd5e23796ed9a8ef7f5ad`、親 `b858e40d`）。説明の文書は `e0a48010ddcbf5eede5d88b79e08b7c7c5640ed2`（tree `d107d8395d343e2fa1a6651c0cc979f93ec31193`、④の申告と一致）。採用も配備もされていない候補。

**修正の中身（読解）**: 賞金プログラムに tag 7 RecordNation（口座 `[pool] [entry w] [citizen]`、署名不要、どの pool の状態でも可）を足す。生きている Citizen の国を Entry の byte 10–11 に写す。同じ国の再記録は何もしない。違う国は `BadAccount`。Claim は Citizen が生きていればそれを読み、Citizen のアドレスが空（データ無し、かつ System の持ち物か lamports 0）のときだけ記録を使う。

**前提の確認（読解）**: ゲームのコードで Citizen の `C::FACTION` を書くのは Join（`permutation-frontier/src/proc/citizen.rs:421`）だけ。占領で国が変わるのは Holding（`H::FACTION`）で、Citizen ではない。したがって「記録は Claim が Citizen から読む値と同じ」は今のゲームのコードでは成り立つ。

**実行（ホスト、鍵なし）**: ④の `e2e-native` は、この版からゲームのプログラムの `dispatch` を `Host::with_game` で実際に動かす（CloseCitizen・CloseProvince は代役ではない。Join・EndSeason は動かさず、口座は layout で直接書く）。⑯の `probes/v16_record_nation.rs`（補助関数は④の `claims_vs_closes.rs` を写し、場面は⑯）:

| 場面 | f43eb4eb | 判定 |
|---|---|---|
| F1 第三者（b の署名なし）が b の国を記録 → 本物の CloseCitizen（end+72h、第三者）→ b の Claim は正しい額で通る。2 回目は `AlreadyClaimed` | 通過 | **修正を確認** |
| F2 記録なしで閉じられると、従来どおり `BadAccount` | 通過 | **残る**（誰かが期限内に記録しない限り失われる） |
| F3 閉じられた後は記録できない | 通過 | **残る**（記録の窓は CloseCitizen まで。その起点は予定の終了時刻＋72h） |
| F4 閉じたアドレスに第三者が lamports を送っても、記録済みは通り、未記録は同じ `BadAccount` | 通過 | 新しい抜け道なし |
| F5（代役で国の値を書き換え）記録と生きている Citizen が食い違うと、再記録は `BadAccount`、Citizen が生きている間は Citizen の国（`NotWinner`）、閉じた後は記録の国で通る | 通過 | 挙動の記録。今のゲームでは国は変わらないので起きないが、将来国を変える命令を足すと、閉じる前と後で結果が変わる |
| F6 他の wallet の Citizen、払っていない wallet、プログラム以外が持つ Entry には記録できない | 通過 | 偽装の拒否を確認 |
| ⑯の P1〜P6（記録しない場面） | 6/6 通過 | 修正後も同じ（記録の無い Entry の挙動は変わらない） |
| ④の `claims_vs_closes.rs` 12 件（本物の CloseCitizen・CloseProvince。A＝P1、B＝P3、C＝P2、D＝P4、E＝P5 と修正後の場面） | 12/12 通過 | ④の試験を⑯が実行。P2・P3 は本物の CloseProvince でも再現 |
| ④の `legacy_season_claims.rs` 4 件 | 4/4 通過 | |

ログ: `logs/phase8/f43e-fix.log`。

**修正前後のまとめ**

| 問題 | b858e40d（修正前） | f43eb4eb（修正候補） |
|---|---|---|
| CloseCitizen で shares の受取権が消える | 再現 | **記録済みなら直る**。未記録は残る（記録は誰でもできるが、誰かが閉鎖前に送る運用が要る） |
| refund 方式 | 影響なし | 影響なし |
| Tally 後の州の閉鎖で Finalize 固着（P2） | 再現 | **残る**（この修正の対象外） |
| 未集計の州の閉鎖で勝者が変わる（P3） | 再現 | **残る** |
| 終了後の Pay（P4） | 再現 | **残る** |
| Aborted の季の参加費（P5） | 再現 | **残る** |

**未照合**: ⑰の候補 Attest（同じ tag 7。⑰によれば Ended の後だけ記録でき、Entry の byte 104–105）。⑰の `wylls-17-claimrights-b858.tgz`（sha256 `d100f170b07f5adc337276a6ef5e28dd2b453d4ecf12c85b5ae44f2b9bf3ccc9`、前提 b858e40d、HEAD `a4c8cc96fec2746ca3af22f3b2b1759cf9516461`、tree `be4be82d17601ab002912f2cb88e5a0f220957e0`）を受け取っていない。④と⑰の候補は同じ tag を使うので、どちらか 1 つに決める必要がある（④・⑰が相談中）。Ended の後だけ記録できる案では、EndSeason が予定より 72 時間以上遅れると記録の窓が 0 になる（13.1 の 72 時間の起点）。


# 第9期（2026-11-06）：④の現在版に⑪・⑱を重ねた版、⑮・⑰・⑲ の新しい版

鍵の生成・導出・署名は、共通セットアップを含めて行っていない。プログラムと補助関数が program-derived address（公開のアドレス）を計算するのは第8期と同じ扱い。実 SBF・LiteSVM・実チェーンは未実行。⑰の Attest は撤回済み（対象外）。

## 14.1 固定した版と適用順

| 段階 | 内容 | tree |
|---|---|---|
| 0 | ④ `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（GitHub `claude/gallant-ride-cunptv`。RecordNation 入り。f43eb4eb からはプログラムのコードが変わらず、④の文書と ABI の一覧だけ） | `ebbc0f764dd02490e2cea15ce0403d9480f59a65` |
| 1 | ＋⑪ `0004-verify-v0e-evidence-is-unverifiable.patch`（sha256 `258ad759…dd21660`、⑪ `c8d694bd` から取得） | `4acd1346da2ee6ad2e0a710a8e6b2f3c954a966e` |
| 2 | ＋⑪ `0005-verify-v0e-cpi-only-and-lost-tail.patch`（sha256 `09beb7bc…4067639`） | `d094201993c7a6b03042e5c66600bcca2c80f894` |
| 3 | ＋⑱ `ef63544c..b71b8197` の 4 commit（`r18-on-integration.bundle` から。cherry-pick、衝突なし） | `34dbdd77e479b75721f068f31262144d19a167c1` |

⑯の検証用 commit（ローカル、push しない）の HEAD は `b65c3b40c8488ef7dba64ceef62b2256fbef443e`。tree が同じなら同じ中身。再構築の手順は `phase5-scripts/compose-phase9.sh`。

**未適用（ファイル未受領）**:

| 担当 | 版（申告） | 必要なファイル | sha256（申告） | 前提 |
|---|---|---|---|---|
| ⑰ RecordNation 対応 | HEAD `9abceecdfece14e4dd979525ac0b517d10c7bf87`、tree `dc6879ad916c3becc44a8b72d01e4586aa28cf0e`（SDK・精算ツール・危険の報告の 3 commit） | `wylls-17-rn-on-ws04.tgz`（中に `wylls-17-rn-on-ws04-8e96f24d.bundle`） | `464144b8d244da63c9549621de35c4341919336a170091c7b2b9e0426424cc42` | `8e96f24d` |
| ⑲ | HEAD `4ee79eccc7a5f1d23a3a926e1884cf9003566b8d`、tree `116d8977ffbdd4c28d3e7f64624def88c832dcde`（archive の破損検出、herald の ingest 状態） | `ws19-on-8e96f24d.bundle` | `4b00b549a5afb8f67462160ecc7690a91250a092aa9ae2a58e363c4c28a0accc` | `8e96f24d` |
| ⑮ | `cb87e30ceace7b959657d43b3c07cd4873aae9c7`、tree `1e423b210b389b98559435577393c3b4e41255b7`（親 `b295ca3e`）。その次 `bf7f43fca3f4425160ab8a4c318fb45073261955`（tree `109be0c7…`） | `ws15-cb87e30c-restore.tar.gz`（中の `ws15-from-b1a09a0b.bundle`）、次の版は `ws15-cb87e30c-to-bf7f43fc.bundle` | `af2e5fbe775689bff1bf57f10328e5f1e2e5960147c99f9e42d512530c98c0bb`、`7793cf404094c536def537470ba6d9dcdda87a73e7acd355c42092de01cfb8cb` | `b1a09a0b`（⑯にある）、次の版は `cb87e30c` |

⑰・⑲は④の現在版の上に作られているので、受け取れば段階 3 の上に重ねられる見込み（⑰の変更は gateway の SDK・精算ツール、⑲は findex・herald で、段階 1〜3 と同じファイルは無い。重ねた結果は受領後に確かめる）。⑮は `workstreams/15-coop-outcomes/` だけで、統合の木とは別に検証する。

## 14.2 段階 3 の tree での結果（ホスト、鍵なし）

| 試験 | 結果 |
|---|---|
| ⑯ A8（`v16_cpi_keyfree`、K0〜K5） | 6/6 通過（⑪で修正を確認。段階 0 だけでは K1〜K3・K5 が PASS＝再現、第7期） |
| ⑪ `evidence` | 8/8 |
| ⑯ T18-1b〜1d（Web）、⑱の marchbook 7 件 | すべて通過 |
| ⑯ bots の公開時刻（agents）、⑱の reveal_time | 1/1、1/1 |
| ⑯ 版の上限（keeper）、⑱の keeper 単体 8 件 | 2/2、8/8 |
| ⑯ C3b、⑯ agent の状態語（V16-F1〜F3）、A1・A1b | 通過 |
| A7、旧 T18-1、T19-1 | 失敗のまま（A7 は表示の開示だけ、旧 T18-1 は `notBefore` なしの呼び出し、T19-1 は旧試作） |
| ⑯ 賞金 P1〜P6、F1〜F6、④の `claims_vs_closes` 12・`legacy` 4 | 28/28 |
| ⑯ 履歴欠落 G1〜G3（findex） | 3/3（G2 は検出、G1・G3 は見逃す） |
| ⑯ herald A1・A1c・A2・C2 | 4/4 |
| ⑯ ABI P2〜P4（有限シーズンの境界） | 1/4（P2〜P4 は再現） |

ログ: `logs/phase9/`。

## 14.3 完全修正と扱わない 4 項目の修正前後

| 項目 | 修正前（b858e40d） | 段階 3（④ RecordNation ＋⑪＋⑱） | 判定 |
|---|---|---|---|
| 事前記録のない Citizen の閉鎖 | 受取権が消える（P1） | 記録済みは守られる（F1）。**記録が無ければ従来どおり消える（F2）、閉鎖後は記録できない（F3）** | 一部修正。⑰の精算ツールの危険の報告（未受領）で、記録漏れを見つけられるかは未確認 |
| 州の閉鎖と集計 | Tally 後の閉鎖で固着（P2）、未集計の閉鎖で勝者が変わる（P3） | 同じ（P2・P3、④の B・C も本物の CloseProvince で再現） | **未修正** |
| 終了後の Pay | 最初の Tally まで通る（P4） | 同じ（P4、④の D） | **未修正** |
| 中止時の資金 | 出口が無い（P5） | 同じ（P5、④の E） | **未修正** |

## 14.4 未確認

- ⑰・⑲・⑮の新しい版（ファイル未受領）。
- 本物のゲームのプログラムの EndSeason と、時刻の経過を含む通しの流れ（SBF か、ゲームの全命令のホスト実行が要る）。
- 鍵を使う試験（gateway のサンプル世界、keeper の World、⑰の shares・accounts の試験など）。
- 実配備と実害。

## 14.5 ⑮ cb87e30c（ws15-cb87e30c-restore.tar.gz、受領後）

受領物: `ws15-cb87e30c-restore.tar.gz`（2,040,499 バイト、sha256 `af2e5fbe775689bff1bf57f10328e5f1e2e5960147c99f9e42d512530c98c0bb`、申告と一致）。同梱の `SHA256SUMS` は 17 ファイルすべて OK。ただし `SHA256SUMS` に載る `ws15-full.bundle`（別添付、138 MB、sha256 `1838d39d…57d6`）は tar に入っておらず、照合できない（未受領）。

**復元**: `b1a09a0b15dd44f587b1158fc40dd3f17577fcca` だけを入れた空のリポジトリに、薄型 bundle `ws15-from-b1a09a0b.bundle`（前提 `b1a09a0b` の 1 つ）から `refs/heads/ws/15-coop-outcomes` を取り込んだ。HEAD `cb87e30ceace7b959657d43b3c07cd4873aae9c7`、tree `1e423b210b389b98559435577393c3b4e41255b7` で申告と一致。親は `b295ca3eac6767ab0b2f47f5e09c608163c6d732`、履歴は `b1a09a0b → 5753626c → b295ca3e → cb87e30c`。`git fsck` は問題なし。同梱の `patches/0001〜0010` と `ws15-from-4cd901de.bundle` は使っていない（二重適用を避けた）。

**二重適用の確認**: ⑮の `check-not-double-applied.sh` で、2026-11-05 の候補パッチ `15-separate.patch` と `13-15-integrated.patch`（⑮部分）はどちらも `ALREADY-APPLIED`。⑯は当て直していない。4cd901de からの差分は `workstreams/15-coop-outcomes/` の外に 0 件。

**⑭との関係**: ⑭の `ws14/ws14-bde8d1c1.bundle`（前提 GitHub の `preserve/ws14-7d7f2143`）を復元し、`bde8d1c1a92b5766b79bf0af7aae69052ca8ea34`（tree `99b73ee4d29dd897754c9bebf2080d3f13188b88`）を確認。cb87e30c の祖先ではない（⑭のコードは⑮に入っていない）。⑭の tree に固定データのファイルは無いため、⑭の模型（`proto/model.mjs`・`contract.mjs`、鍵なし）で種 1・21 日・168 時間ごとの区切りの A・B・C を作り直した。`JSON.stringify(facts, null, 1)` ＋改行の sha256 が、⑮の `ws14-v1-bde8d1c1-case{A,B,C}.json`（`90fbd117…`、`59d692bb…`、`ab90c2ad…`）と**バイト単位で一致**。⑭の `checkFacts` は 3 件とも誤り 0。

**実行（ホスト、鍵なし）**

| 試験 | 結果 | 判定 |
|---|---|---|
| ⑮の `node --test`（99 件） | 全通過 | ⑮の試験を⑯が実行 |
| ⑮の `s1-exact-source-no-keys`（b1a09a0b に 15-separate を当てたときは `cargo: invalid bytes` で失敗、11.7） | 通過 | **修正確認**（荷の証拠の経路が b295ca3e で入った） |
| ⑯ `v16-ws15-exact-source`（V16-15a〜d） | 4/4 | 修正確認（b1a09a0b ではパッチ無しで 3 件失敗、11.7） |
| ⑭の `check-ws15.mjs`（⑭の実出力 B を⑮の adapter に通す） | v1 は 1,802 件すべて読む。v0 と偽ると 0 件 | 偽装は読まれない。ただし `refused: null` で「拒否」としては報告されない（黙って読まない） |
| ⑯ `v16-ws15-model-facts`（V16-15m、3 規則 × 3 ケース）: ⑭の事実を入れても入れなくても、賞（awards）と賞金の判定が同じ、⑭の事実だけで `achieved` になる目標が無い | 9/9 | 確認。対照で、規則 B・C のケース B では⑭の事実により 29 件が `model_only` になり、評価に効いていることを確かめた |

**限界**: この入力にはゲームの事実が無く、賞は⑭の事実の有無にかかわらず 0 件。ゲームの事実で賞が出る場面に⑭の事実を足しても賞が増えないことは、この試験では確かめていない（**未確認**）。規則 A（旧経路の互換）は賞金を `decided` と出すが、⑭の事実の有無で変わらない。

ログ: `logs/phase9/ws15-cb87e30c.log`、`ws15-model-facts.log`、`ws15-model-control.log`、`ws14-check-ws15-on-cb87e30c.log`。作り直しと対照のスクリプト: `phase5-scripts/gen-ws14-facts.mjs`、`ws15-model-control.mjs`。

**後続版 bf7f43fc**: `bf7f43fca3f4425160ab8a4c318fb45073261955`（tree `109be0c7f5ce9be402c1a844067d0f33e7087d6c`、親 cb87e30c。⑮の申告では ①の fold() と④の runexec の書き出しへの接続、記録の残し方が入力の順に依存する不具合の修正、試験 113 件）。bundle `ws15-cb87e30c-to-bf7f43fc.bundle`（23,249 B、sha256 `7793cf404094c536def537470ba6d9dcdda87a73e7acd355c42092de01cfb8cb`、前提 cb87e30c）は**未受領**で、検証していない。cb87e30c は⑯の手元に復元済みなので、bundle が届けば復元できる。

**未確認**: bf7f43fc、`ws15-full.bundle`、④の実際の JSON 出力（⑮の `fixtures/ws04-types-a967f5f1.json` は型定義から書いたもので実行の出力ではない、と⑮が明記）、①の実物の fold()。

## 14.6 ⑯の push が起動した CI（鍵を使う試験）

④の連絡（2026-11-06T13:31Z）を受けて確かめた。`.github/workflows/ci.yml`（⑯ブランチの版）は `on: push` で、どのブランチの push でも起動し、gateway の `npm test`（鍵を生成する試験を含む）、LiteSVM、SBF ビルド、frontier-node の workspace 試験（鍵で署名）を走らせる。⑯の担当ブランチへの push で CI が **11 回**起動していた（11/05 の 7bce86ff から 11/06 の b9a4bfeb まで。完了した 10 回はすべて failure、b9a4bfeb の回は 13:33Z 時点で実行中）。⑯は手元で鍵を使う試験を流していないが、push によって GitHub の runner でそれらを起動させていた。**第6期以降の「鍵を使う試験は実行していない」は「⑯の手元では」と読む。** CI の結果は⑯の検証結果に数えていない（中身も見ていない）。以後、⑯の push は最後の commit に `[skip ci]` を付ける。④の統合候補 232a5aa7 の `ci.yml` は、push と pull request では鍵を使わず、鍵を使う試験を手動（`key_tests: approved`）の job に分ける形になっている（④の案 525a623f。採否は利用者）。

## 14.7 ④の統合候補 2026-11-06b（232a5aa7）

対象: GitHub `claude/gallant-ride-cunptv` の `232a5aa700f72b04b810d765c3dbb6d51d56f7d6`（tree `6807a9adb372ba35164d6257a650b31cd994b270`、起点 8e96f24d、`[skip ci]`）。中身は④の申告どおり（⑳ dc55f159・41552f0d、CI の鍵なし化 525a623f、⑬ 745e7ec6、⑫ c6877a1a、⑨ 8fe85cc9、⑩ 563407d9、⑪ c8d694bd と verify への 0004→0005、ABI 割当 rev 4）。**⑱は含まない**、⑤ e9d1551a も含まない。賞金プログラムは 8e96f24d と同じ。ゲームのプログラム、検証器、keeper、findex、herald、ABI、Web、gateway は変わっている。

**読解（⑳の NFT 住民と賞金）**: ⑳の `proc/resident.rs:312` が NFT 住民の Citizen を作るときに `C::FACTION` を書く。作成時の 1 回だけで、RecordNation の前提（国は作成時にだけ書かれる）は保たれる。ただし NFT 住民の Citizen は `WALLET` が 0 で、アドレスは資産から決まる（`citizen_by_tag15(resident id)`）。賞金の shares 方式の Claim と RecordNation は `ctx.citizen(wallet)` のアドレスと `C::WALLET == wallet` を要求するので、**NFT 住民は shares 方式の賞金を請求も記録もできない**見込み（未実行。旧経路の賞金と NFT 住民の組み合わせの問題として、④・⑰・⑳に判断を預ける）。

**実行（ホスト、鍵なし）**: ログ `logs/phase9-232a/`。

| 試験 | 232a5aa7 | ⑯が重ねた版（34dbdd77）との違い |
|---|---|---|
| ⑯ A8（K0〜K5）・⑪ evidence 8 | 6/6、8/8 | 同じ（⑪の 0004→0005 が入っている） |
| ⑯ 賞金 P1〜P6・F1〜F6、④ claims_vs_closes 12・legacy 4 | 28/28 | 同じ（⑳の変更後もゲームの CloseCitizen・CloseProvince で同じ結果） |
| ⑯ 履歴欠落 G1〜G3 | 3/3（G1・G3 は見逃し） | 同じ |
| ⑯ herald 4 | 4/4 | 同じ |
| ⑯ ABI P2〜P4 | 再現 | 同じ |
| ⑯ C3b、agent の状態語 F1〜F3、A1・A1b | 通過 | 同じ |
| ⑯ T18-1b〜1d（Web）、bots の公開時刻、版の上限 | 失敗・コンパイル不可 | **⑱が未取り込み**のため（34dbdd77 では通過） |
| A7、旧 T18-1、T19-1 | 失敗のまま | 同じ |

**既知の未解決（④の申告、⑯は未確認）**: ⑨の `bridge10/tests/connect10.rs` がコンパイルできない。⑤の relay-tree の試験が未合格。

## 14.8 ④の統合候補 12c054f9

対象: `claude/gallant-ride-cunptv` の `12c054f951d000c33c7e054a371d9f9c035d8197`（tree `24bb51874eb4a8e60f0e65155f07b2402128c6bc`、232a5aa7 の子孫、`[skip ci]`）。232a5aa7 からのコードの差分は findex の `index.rs`（⑳ 9e6b0c01、clippy）と検証器（⑪ 0007：`v0_evidence.rs`・`codes.rs`、新しい試験 `new_bands.rs`）だけ。

| 試験（ホスト、鍵なし） | 結果 |
|---|---|
| ⑯ A8（K0〜K5） | 6/6（0007 の後も変わらない） |
| ⑪ evidence | 8/8 |
| ⑪ new_bands（鍵の操作なしを確認） | 4/5。`every_conquest_kind_the_abi_knows_is_modelled` が「conquest kind 130 is not modelled」で失敗。⑳の RESIDENT_JOINED（kind 130）を検証器がまだ扱わないことを知らせる、⑪が意図した検査（④の申告と一致）。**検証器が⑳の記録をまだ判定しない**ことの再現として扱う |
| ⑯ 履歴欠落 G1〜G3 | 3/3（G1・G3 は見逃し、変わらない） |

ログ: `logs/phase9-232a/12c0-*.log`。その他の項目（賞金・Web・ABI など）は 232a5aa7 からコードが変わらないので 14.7 の結果のまま（コード同一による引き継ぎ、12c054f9 では未実行）。

## 14.9 ④の統合候補 d0e96d53（確定）

対象: `claude/gallant-ride-cunptv` の `d0e96d5394d88decf878676f37bc3782654d1045`（tree `1e1a95055467fc38d23c47a0bbe9d27f349b7631`、12c054f9 の子孫、`[skip ci]`）。12c054f9 からのコードの差分は検証器だけ（⑪ 24956acc と verify の 0008：`v0_evidence.rs`、試験 `new_bands.rs`）。

| 試験（ホスト、鍵なし） | 結果 |
|---|---|
| ⑯ A8（K0〜K5） | 6/6 |
| ⑪ evidence | 8/8 |
| ⑪ new_bands | 6/6（12c054f9 で失敗していた kind 130 の検査が通る。⑳の RESIDENT_JOINED は、同じ取引に JoinResident があり世代と国が一致するときだけ判定される、と⑪・④が申告） |

その他（賞金、Web、ABI、findex、herald）は 232a5aa7・12c054f9 からコードが変わらないので、14.7・14.8 の結果のまま（コード同一による引き継ぎ。d0e96d53 では未実行）。**この版は個別の試験の結果であり、統合版から一連の操作が成立することの確認ではない**（次節の完成候補の検証で行う）。

**d0e96d53 時点で残るもの**: 事前記録の無い Citizen の閉鎖、州の閉鎖と集計（固着・勝者の入れ替わり）、終了後の Pay、中止時の資金、NFT 住民と shares の賞金、履歴欠落の見逃し（G1・G3）、有限シーズンの境界（P2〜P4）、A7。⑱の修正、⑰の RecordNation 対応、⑲・⑮の新しい版は④に未着で、この版に入っていない。

## 14.10 findex の退行（⑲の指摘を⑯が再現）

⑲の連絡（2026-11-06T15:10Z）: 「変更を加えていない d0e96d53 でも findex の `store_failure` の `index_failure_requires_reopen_and_catches_up_from_the_archive` が失敗する」。⑯が d0e96d53 で実行して**再現**（4/5、`assertion failed: fx.is_poisoned()`、`tests/store_failure.rs:205`）。この試験は鍵の操作なし。⑯の第5期（d0949fd4）では 5/5 通過していた。

④の統合の流れで要所の commit を直接試した（`phase5-scripts/points-store-failure.sh`、ログ `logs/phase9-232a/store-failure-points.log`）:

| commit | 結果 |
|---|---|
| `8e96f24d`（④、⑳の取り込み前） | 通過 |
| `1a61caa4`（⑳ の候補の取り込み） | コンパイル不可（判定できない） |
| `739618ae`（④が⑳ dc55f159 を統合） | **失敗** |
| `232a5aa7`、`213fa655`（⑳ 9e6b0c01 の統合後） | 失敗 |

**原因の見当（読解のみ）**: ⑳の変更で `frontier-node/crates/findex/src/index.rs`・`lib.rs` に「厳格な索引」の印（`strict_ps2_v1`、`strict_ps2_blocked`、`mark_incomplete`／`mark_complete`、`require_readable`）が入った。試験は索引を `PRAGMA query_only=ON` で書き込み不可にしてから取り込む。取り込みの最初の印の書き込みで先に失敗し、ストアを `poisoned` にする経路を通らずにエラーを返していると読める。そうなら、**索引の書き込みに失敗した後も findex が止まらず、次の取り込みや読み取りを受け付けうる**（第5期の「失敗の後は開き直すまで止める」の性質が失われる）。実害の確認はしていない。④・⑳に送った。


# 第10期（2026-11-06）：完成の基準に照らした検証（④の完成候補の前段）

利用者の基準: 各担当の合格数の合算ではなく、**同じ SHA・tree の統合版から一連の操作（NFT 参加 → 権限の取消 → 荷車の送信と結果 → 記憶の読取り → 成果の計上 → 賞金請求）が成立すること**。正常例と失敗条件（応答の消失、再起動、重複、NFT の譲渡）を分ける。skip、コンパイル不能、mock、既知問題の残存確認は完成に数えない。鍵の生成・導出・署名を伴う試験は CI を含め行わない（⑯の push は `[skip ci]`）。

## 15.1 対象の版

| 版 | commit | tree | 位置づけ |
|---|---|---|---|
| ④ 2026-11-06c | `b954990dd148c51b6591907cf61d8931cb9334a5` | `96c8eaafbc9a103f61f7504f42d758101fba7923` | 統合候補（④自身の §5 で多くが未接続、§6 で未着） |
| ④ 途中経過 | `59f52eaf51935203b32b4310c207dc2da7b5f2d5` | `78247f490f06908bc6284eaefb4c006efbaff139` | findex の退行の修正 d8c876e4、⑪ 0009（V27）。**④自身が「まだ完成候補ではない」と明記** |
| （参考）④の先端 | `6984acfa` | — | 59f52eaf からの差分は検証器 3 ファイル（JoinResident の判定条件）。⑯は未実行 |

**④の完成候補は、まだ出ていない**（③・⑤・⑰・⑱・⑲・⑮ の成果物が④に未着）。以下は完成候補の前段としての確認。

## 15.2 実行結果（ホスト、鍵なし）

| 試験 | b954990d | 59f52eaf |
|---|---|---|
| findex `store_failure` | 4/5（退行、14.10） | **5/5（修正を確認）** |
| ⑯ 履歴欠落 G1〜G3 | 3/3（G1・G3 は見逃し） | 3/3（同じ） |
| ⑳ NFT の runtime 試験（`permutation-frontier --features nft-experimental`、ゲームの `dispatch` をホストで実行、鍵なしを確認） | — | 10/10 |
| ⑯ A8（K0〜K5）・⑪ evidence・⑪ new_bands | 6/6・8/8・6/6 | 6/6・8/8・7/7 |
| ⑯ 賞金 P1〜P6・F1〜F6、④の claims_vs_closes 12・legacy 4 | 28/28 | 未実行（賞金・ゲームのコードは b954990d と同じ） |
| ⑫ `tools/test-nokey.sh`（鍵の操作を止める見張りの下） | ran 49、**needs-key 69**、skipped 1、FAILED 0 | 未実行（同じ） |
| ⑯ Web（C3b、A1・A1b、状態語 F1〜F3） | 通過 | 未実行 |
| ⑯ ⑱関連（T18-1b〜1d、bots の公開時刻、版の上限） | 失敗・コンパイル不可（⑱未取り込み） | 同じ |
| A7・旧 T18-1・T19-1、ABI P2〜P4 | 失敗のまま・再現 | 同じ |

ログ: `logs/phase10/`。

## 15.3 一連の操作の成立（完成の基準に照らして）

| 操作 | この版で鍵なしに動かせる部分（正常例） | 失敗条件で確かめた部分 | 一連のつながり | 判定 |
|---|---|---|---|---|
| NFT 参加 | ⑳ runtime：初回参加で Citizen が 1 つでき RESIDENT_JOINED を記録、同じ NFT が新しい世界に自分の Citizen で参加（ゲームの dispatch、ホスト）。検証器の 0xE1（⑪・④の固定 byte の試験、⑯は new_bands で間接） | 譲渡と買い戻し（A→B→A）で旧権限すべて拒否、署名なし・guard なし・差し替えの拒否、旧グローバル link の不使用 | 参加した NFT Citizen がその後の荷車・賞金の段に進む場面は**無い** | 部品は確認。**一連は未成立** |
| 権限の取消 | ⑳の譲渡でのセッション失効（上と同じ）、④の `GET /f/agent/fate` の状態語（⑯ F1〜F3、純関数） | — | ③・⑤の送り手ごとの資格情報の一本化が**未接続**（③ 7923f900、⑤ 276a392b が未着） | **未成立** |
| 荷車の送信と結果 | ④の荷車だけの Run（④の申告：模擬のチェーン、runexec 96 合格・9 ignored）。⑯は未実行。模擬のチェーンなので完成に数えない | ⑯の賞金側の場面で、閉鎖・重複請求（AlreadyClaimed）は確認 | ⑥の計画→RunSpec の adapter が**未接続** | **未成立** |
| 記憶の読取り | ⑫：鍵なしで走る 49 件は通過 | 再起動後の再生、重複、取り消し、証言の扱いなど中心の試験は **69 件が needs-key**（署名つきの割り当てが前提） | ⑫は④の登録簿と同じ木にあるが、⑳の NFT Citizen・荷車の結果から記憶へ流す場面は**無い** | **鍵なしでは確認できない部分が大半** |
| 成果の計上 | この木の⑮は b1a09a0b（古い版）。⑯は cb87e30c を別に検証済み（14.5） | — | ①が⑮の `fold()` を読む経路が**未接続**、⑮ cb87e30c が④に未着 | **未成立** |
| 賞金請求 | 賞金とゲームの本物の dispatch（ホスト）で、記録済みの請求が閉鎖後も通る（F1） | 応答の消失後の重複請求（AlreadyClaimed）、記録なしの閉鎖（失われる）、州の閉鎖（固着・勝者の入れ替わり）、終了後の Pay、中止時の資金 | **NFT 住民は shares の請求も記録もできない**（WALLET 0、仕様未決）。⑰ 9abceecd（精算と `--risks`）が未着 | 部品は確認、**NFT 住民からの一連は不成立（仕様未決）** |

**結論**: この版で、6 つの操作を同じ統合版の上で一連として通す場面は存在せず、⑯は成立を確認していない。部品ごとの確認は上表のとおり。④も同じ認識（2026-11-06T15:16Z の連絡）。

## 15.4 実行できない最終確認（鍵・署名が要るもの）

1. 署名つきの取引としてローカルチェーン（localnet）・devnet に流す通しの確認（NFT 参加から賞金請求まで）。
2. SBF ビルドと LiteSVM での実プログラムの確認（ゲーム・賞金・⑳ の resident program・Metaplex Core）。
3. ⑫の記憶の中心の試験 69 件（署名つきの割り当て）。
4. keeper の World の試験（Reveal の送信、BeaconLog、⑱の版の上限による送信件数）、gateway のサンプル世界（`web-frontier-marches.test.mjs` など）、⑰の shares・accounts の試験、検証器の `coverage.rs`・`record.rs`。
5. nft-experimental の Season の fixture での 0xE1 の照合（④の申告：署名が要る）。
6. CI の鍵を使う job（`key_tests: approved`、手動）。

## 15.5 判断が要ること

- 一連の場面を誰が書くか（④は「Rust 側の JoinResident → 荷車の Run → 賞金を e2e-native に足すところから」と提案。⑯が独立に書くことも可能）。言語の境界（Rust と Node）をまたぐ部分は、どちらが書いても記録ファイルの受け渡しになる。
- NFT 住民を賞金の受取の対象にするか、譲渡後の受取権を誰に属させるか。
- 未着の成果物（③・⑤・⑰・⑱・⑲・⑮・②・⑦・⑧）を④へ渡すこと。


# 第11期（2026-11-06）：PDA の算出も禁止（新しい基準）

利用者の指示（2026-11-06）: 鍵の生成・**導出（PDA を含む）**・署名を伴う試験は、CI とセットアップを含めて行わない。fixture、未実行、鍵なしのホスト実行、実チェーンを区別する。以後⑯は、試験が呼ぶコードの経路に `find_program_address`／`create_program_address`／`create_with_seed`（アドレスの導出）が無いことを、読解で確かめてから流す。

## 16.1 これまでの結果の扱い（新しい基準）

第8期〜第10期で⑯が実行した次の試験は、**PDA の算出を伴う**（⑯は第8期で「公開アドレスの算出は鍵の導出に当たらない」と判断して実行し、その判断を明記していた）。新しい基準では、**⑯の有効な結果に数えず、再実行もしない**。

| 試験 | PDA の算出の場所 |
|---|---|
| ⑯ 賞金 P1〜P6・F1〜F6、④の `legacy_season_claims`・`claims_vs_closes`（e2e-native） | 補助関数の `find_program_address`（Season・pool・vault・entry）、賞金プログラム自身の `entry_address`、ゲームの CloseCitizen・CloseProvince の `AddrCtx` |
| ⑳ NFT の runtime 試験 | 補助関数の `pda()`、プログラムの `find_program_address`・`with_seed` |
| 検証器を動かす試験すべて（⑯ A8 の K0〜K5、⑪ evidence・new_bands、⑯ X2・A8 の旧試験） | `verify()` の中の `Facts::build` → `findex::addr_ctx` → `season_pda` |

これらの結果は「PDA の算出を伴うホスト実行（旧基準）」として記録に残す。完成の判定には使わない。

**PDA を通らないことを確かめた試験**（このまま有効）: findex の `store_failure`・`v16_history_gaps`（`Findex::open(..., None, ...)` でシーズンを指定しないため `addr_ctx` を通らない、取引は空の本体と固定の署名欄）、`judge_outside_v2` の純関数の試験（下）。その他（herald、ABI、Web、⑫、⑮）の PDA の有無は**未監査**で、監査するまで有効な結果に数えない。

## 16.2 6984acfa での確認（ホスト、鍵なし、PDA なし）

対象: `claude/gallant-ride-cunptv` の `6984acfa4c0f9919c8c424a9bd5f2d59193d1639`（tree `b38d2d8bb3a223be53f3da08a300256b48f32b7a`）。

| 確認 | 方法 | 結果 |
|---|---|---|
| findex の停止・復旧 | `store_failure` 5 件（索引・manifest・checkpoint・roll の書き込み失敗で止まり、開き直すと archive から追いつく）、⑯ G1〜G3 | 5/5、3/3（G1・G3 は見逃しのまま） |
| V27 が動かないとき JoinResident を PASS にしない | ⑯ `verify/tests/v16_v27_gate.rs`（`judge_outside_v2` の純関数だけ。`verify()` は動かさない） | 3/3。NFT の版で V27 が動く（s1）ときだけ判定を V27 に任せ（None）、動かないときは Unverifiable。形の崩れた JoinResident は s1 の有無にかかわらず判定される。NFT でない版では Fail（UnknownInstruction） |
| V27 が動く条件と V0 の条件が同じ | 読解：`checks/mod.rs:269-276`（V27 は `cx.s1` のときだけ）、V0 は同じ `cx.s1` を渡す | 一致 |

**未確認**: V27 自体が JoinResident を正しく判定すること（`verify()` を動かす必要があり、PDA を算出するため実行不可）。

ログ: `logs/phase11/6984-findex.log`、`6984-v27gate.log`。

## 16.3 一連の操作の検証への影響

ゲームのプログラム（NFT 参加、荷車、閉鎖）、賞金プログラム（Pay・Claim・RecordNation）、検証器は、どれも実行の中で PDA を算出する。したがって新しい基準では、④が作る通しの場面（e2e-native の `Host::with_game` など）を⑯が**実行することはできない**。⑯ができるのは、(1) その場面のコードと fixture の読解、(2) PDA を通らない部品（findex、純関数、アドレスを入力として受け取る JS の部分）の実行、(3) ④の実行記録（④の結果）との突き合わせ、に限られる。通しの成立の**実行による**確認は、実行できない最終確認に入る。

# 第12期（2026-11-06）：PDA の算出を再び許可、④の通しの場面と⑲ r2

利用者の指示（2026-11-06、④と同じ基準）: PDA と `with_seed` による公開アドレスの算出は、試験コードの中でもプログラムの中でも**許可**。鍵ペアの生成・導出と署名は、固定 seed、共通セットアップ、CI を含めて**引き続き禁止**。⑯は試験を流す前に、呼び出し先まで読み、`Keypair`／`TestKey`／`sign`／`from_seed` の経路を通らないことを確かめた（検証器の `src/fixture`・`src/tamper.rs` は鍵で署名するので使わない）。

## 17.1 第11期の扱いを戻す

§16.1 の表の試験（⑯ 賞金 P1〜P6・F1〜F6、④の `legacy_season_claims`・`claims_vs_closes`、⑳ runtime、検証器を動かす試験）は、PDA の算出だけが理由で数えないことにしていた。鍵の生成・導出・署名は伴わない（読解済み）ため、**今の基準では有効な結果に戻す**。ただし対象の版はそれぞれの期のもので、最新の統合候補での結果ではない。§16.3 の「⑯は通しの場面を実行できない」も取り消す（下の 17.3 で実行した）。

## 17.2 6984acfa の V27（検証器を動かす）

対象 `6984acfa4c0f9919c8c424a9bd5f2d59193d1639`（tree `b38d2d8bb3a223be53f3da08a300256b48f32b7a`）。

| 試験 | 結果 |
|---|---|
| V27（正直な参加、偽造、食い違い、重複、証拠の欠落） | 5/5 |
| ⑪ evidence | 8/8 |
| ⑪ new_bands | 7/7 |
| ⑯ A8 | 6/6 |
| ⑯ V27 の関門（`v16_v27_gate.rs`、純関数） | 3/3 |

V27 が動かない版で JoinResident が PASS にならないことは §16.2 のとおり（関門 3/3 と `checks/mod.rs:269-276` の読解）。ログ: `logs/phase12/6984-verify.log`。

## 17.3 ④の通しの場面（chain-flow、最新の統合候補）

受領: `36dedc80-ws04-chain-flow-6984acfa.bundle`（sha256 `f863f1634ba135e7d2dc200db3e6348f177129c7c2e737b5a628b4f967703aba`）。空のリポジトリに復元して照合した。

- HEAD `27651beddae7f493957bffe6618e1ca422422c18`
- tree `1ea851ef0faf5e3a063ad62fe57604276136ff84`
- 親 `5a65836e433c4a274bda6001785624587067a746`
- 6984acfa の上に 5 コミット

⑲ r2、⑰ RecordNation、⑮ bf7f43fc、⑳ 4b233e4a、⑪ 0010 は**この候補に入っていない**。この候補は「④の通し＋6984acfa」の版で、全担当の統合版ではない。

### (a) 固定ファイルの照合（fixture、実行ではない）

| 確認 | 結果 |
|---|---|
| コミット済みの fixture（`tools/chain-flow/fixtures-20261106/`）を `check-fixtures.mjs` で照合（PDA を使わない 24 項目） | 24/24 |
| `run.sh` で作り直した出力とコミット済み fixture の比較 | **バイト単位で一致**（同じ入力から同じ出力が出る） |
| 照合器の変異試験（fixture を 1 か所ずつ壊して照合器が気づくか） | 9 件中 7 件で検出、**2 件を見逃した** |

見逃した 2 件:

- M5: `e-prize-run.json` の Citizen を別のアドレスに書き換えた。
- M7: `e-prize-run.json` の請求結果を「支払い済み」に書き換えた。

どちらも 24/24 のままになる。照合器は `e-prize.json` の要約だけを見ていて、賞金段階の実行記録 `e-prize-run.json` と突き合わせていない。**fixture の照合だけでは、賞金段階の記録が偽でも通る**（④へ連絡する）。

### (b) ホストでの実処理（鍵なし、署名なし、PDA あり）

| 段階 | 中身 | 結果 | 位置づけ |
|---|---|---|---|
| A（`chain_nft`） | ゲームのプログラム本体の NFT 参加、NFT 譲渡後の権限撤回 | 2/2 | 実プログラムのコードをホストで実行（System と SPL Token は mock、署名は署名者フラグだけ） |
| B（`chain_caravan`、`--ignored`） | runexec の荷車送信と結果 | 1/1 | **Sim の mock チェーン**。完成には数えない |
| E（`chain_prize`） | 賞金プログラム本体、同じ Season の JoinResident | 2/2 | 実プログラムのコードをホストで実行。NFT 住民の請求はすべて BadAccount（仕様が未定） |
| C・D（`stages-cde.mjs`、no-keys-guard の下） | ⑫ 記憶の取り込み、⑮ 成果の正規化 | 完了（照合 24/24） | JS の実処理。入力は A・B の出力 |

⑯の独立した追加試験 `probes/v16_chain_caravan_faults.rs` は 4/4。④の chain の Citizen（`a-join.json`）を使い、runexec の Sim の上で次を確かめた（**mock チェーン、完成には数えない**）。

- b1 重複: 同じ受付は Existing、別の内容は Conflict、完了後の再受付は Existing(Fulfilled)。
- b2 応答消失: LoseResponse、Timeout、LandLater(3) のどれでも送信は 1 回。
- b3 再起動: `ship.before_send` で落とし、同じ db の新しい executor で再開。
- b4 重複配信: `feed_duplicates`。

4 件すべてで、Fulfilled、搬入先の在庫 4、監査一致、sent と settled の受領がちょうど 1 件ずつ、`check_store` 合格。

### (c) 通しの場面で確かめられていないこと

- 荷車の受付に、依頼者の権限の確認がない。そのため **NFT 譲渡後の旧所有者が荷車を出せるか** は、どの段階でも試されていない（利用者が実装中の荷車受付）。
- 記憶（⑫）の再起動の場面がない。⑫の鍵が要る 69 件は実行できない。
- NFT 住民の賞金請求は仕様が未定で、E は「請求できない」ことだけを確かめる。
- B は mock チェーンなので、荷車の結果が実際のプログラムの状態と一致するかは未確認。

## 17.4 ⑲ r2（c022f4fc）

受領: `ef186085-ws19-on-6984acfa-r2.bundle`（sha256 `a80df60b6e981a1a50cfd1bb25c324c37ae42f1e7acc20c12374fcae0e29cc7f`）。空のリポジトリに復元して照合した。

- HEAD `c022f4fc0dbba51cdcb81fc91b416870e8d670ca`
- tree `dcb6f98d5adfdd6362bcf21e2a706aa27a4b4d1d`
- 親 `803e3b274d6ce3948002193a835dbcffd961e6c1`
- 6984acfa の上に 5 コミット。④の chain の候補とは別の枝

ホストでの実処理（鍵なし）:

| 試験 | 結果 |
|---|---|
| findex coverage | 14/14 |
| findex no_hidden_gap | 4/4 |
| findex store_failure | 5/5 |
| ⑯ v16_history_gaps | 3/3 |
| herald ingest_health | 3/3 |
| verify history | 13/13 |
| ⑯ v16_history_coverage（新規、`probes/`） | 4/4 |

⑯の新しい試験は、`RpcPoll::coverage()` の状態を G1・G3 の場面で確かめる。

- c1: 既定の設定で G1（始まりが刈られている）は `unverifiable`。
- c2: origin を置くと G1 は止まり、`gap`。
- c3: 既定の設定で G3（途中が欠けている）は `cross_checked` にならない。witness を置くと止まり、`gap`。
- c4: 対照。履歴が揃っていれば `cross_checked`、限界の文言も付く。

既定の設定では G1・G3 を**取り込んでしまう**（止まらない）ことは変わらない。r2 では、それを「完全」と報告しないところまでが直った。origin と witness を置いたときだけ止まる。

## 17.5 実チェーンで確かめていないこと（鍵・署名が要る）

- SBF でビルドしたプログラムを LiteSVM、localnet、devnet で、署名付きの取引として流すこと（A〜E のすべて）。
- 荷車の実送信と結果（B は mock）。
- ⑫の鍵が要る 69 件。
- keeper の World。
- gateway の見本の世界。
- ⑰の分配と口座。
- 検証器の `coverage.rs` と `record.rs`（fixture が鍵で署名する）。
- CI の key_tests ジョブ。
- 公開 RPC の実ノードでの履歴の欠け（⑲、⑯の試験は JSON-RPC の代役ノード）。

## 17.6 受け取っていないもの

- ⑰ `wylls-17-rn-on-ws04.tgz`（sha 464144b8…）
- ⑮ bf7f43fc の bundle
- 全担当を入れた統合版（④の chain に ⑲ r2、⑰、⑮、⑳ 4b233e4a、⑪ 0010 を入れたもの）
- ④の新しい統合候補 `ws04-int-6984acfa-r2.bundle`。
  - ④の連絡によると、HEAD は `4ebc0dc384e6dc20d9983fab9f44531264b1158d`、tree は `c809045b80a0c32bcd9d88c9c96291329f356697`、sha256 は `60d80208b33fef92d7468bc8111abea39a139c3abe79a1a5743c14a09390d1c8`。
  - 内容は、6984acfa の上に 12 コミット、⑳ b2f7becc の merge と V28、⑪ 0010。
  - push されておらず、⑯の環境にも届いていないため、照合も実行もしていない。④の報告した結果（A 2/2、B 1/1、E 2/2、照合 24/24、検証器 19/19、new_bands 7/7）は④の結果で、⑯の結果に数えない。
- 利用者が実装中の地図、賞金、荷車受付

ログ: `logs/phase12/`

## 17.7 ⑪ 0010＋0011 を ⑳ b2f7becc に当てた木（⑯が再構成）

- ⑪ のブランチ `claude/kind-fermat-earbxe` を GitHub から取得した。
  - HEAD は `6efd2f076e097f36119d77836729c0367a5c3df6`、tree は `5e64c03ed293f109301692bac37440e5585f3101` で、⑪ の連絡と一致した。
- パッチの sha256 も、⑪ の連絡と一致した。
  - 0010：`6c8fe8342e4f0a8f45a0d7ef24bba5c608a34ef59b9fddd896d77a47e1cc691a`
  - 0011：`f59e1ab5c870d8adb9147611481f19152d1e843d2df464767dd37425073f253c`
- ⑳ の `b2f7becc315e6ec891f78514abc9598ad6cf77b6` に `git apply` で 0010、0011 の順に当てた。
  - 結果の tree は `9a9e49e0b1e38b516d29b9a6cff6afa386b7538a` で、⑪ の連絡と一致した。

実行の前に、呼び出し先まで読んだ。

- `tests/common` の `world()` は、固定 seed の `Keypair`（`[0xA1;32]`）と `TestKey` を作り、署名する。
- 実行した試験は `world()` を呼ばない。
  - 読むのは、コミット済みの fixture（`common::fixture`／`land`／`march`）だけ。
  - `tamper::edit_ix`／`rechain` は、署名欄を書き換えない。
- `fixtures.rs` の `march_fixture_is_fresh` は鍵で作り直すため、除外した。
- lib の `#[cfg(test)]` に鍵の経路はない。

| 試験（ホスト、鍵なし、PDA あり） | 結果 |
|---|---|
| lib（V27 7 件、V28 5 件、V9 6 件などを含む） | 33/33 |
| camp_clear | 3/3 |
| evidence | 8/8 |
| missing_state | 2/2 |
| new_bands | 7/7 |
| open_items | 3/3 |
| unit | 8/8 |
| fixtures（1 件除外） | 8/8 |
| 合計 | 72/72（⑪ の `verify-after-r11.log` と同数） |

1 回目はディスクが満杯になり、リンクの途中で失敗した（`logs/phase12/w11-r11-diskfull/`）。試験は 1 件も動いていないので、結果に数えない。古いビルド出力を消して流し直した。

読解での確認:

- 0011 の `resident_program_of` は、成功した取引の、ゲームのプログラムの最上位命令だけを見る（`world.rs` の `Tx::ixs`）。
- 別のプログラムが同じ tag の命令を出しても、方針の resident_program をすり替えることはできない。
- 方針が命令にも状態にも無いときは Unverifiable（PASS にしない）。

この試験は⑪の試験を⑯が同じ木で再現したもので、⑯の独自の試験ではない。V27・V28 を、NFT 版の Season をまるごと `verify()` に通して確かめることは、まだしていない（⑪ も未確認としている）。

④ の r3（`15bed411bbfec103fafba7a1525ec650e82c1671`、tree `475f2ae92bd72d3731891a042bf7213c5b98b7e3`、sha256 `8937a364…`）と r4（`57c5c1714df8ffb4d5e145b32118b9590dc5459e`、tree `9c5c480c657b0895f63c270999abf7fb9e039889`、sha256 `094341c619b51b408d9f83e5b827920d00dddf4e294db6b1215d23aa3cdf8846`）は届いていない。どちらも照合も実行もしていない。④ が直したという照合器（`e-prize-run.json` を読む 31 項目）も未確認。

## 17.8 ④の訂正（2026-11-07）を受けて、⑯の実行を見直した

④の連絡: ④は `cargo test -p fclient --lib`（94 件）と `--test fixtures` の `march_fixture_is_fresh` を、鍵を使わない試験として流していた。実際は次のとおり鍵を使う。

- `beacon.rs`・`seal.rs` の試験は、`TestKey::new()` で鍵を作る。
- `tx.rs` の試験は、`Keypair::new_from_array([3;32])` で署名する。
- `march_fixture_is_fresh` は、`fixture::march::march()` を通して固定 seed の鍵で署名する。

④の「fclient 94」は、⑯の記録でも鍵なしの試験として扱わない。

⑯がこのセッションで流した試験の命令とログを、すべて調べた。

- **`-p fclient` の試験は、一度も実行していない。**
- **`march_fixture_is_fresh` を流したのは第1期（2026-10-31）だけ。** `cargo test -p verify` の全件で、`logs/patched-verify-suite.log`・`-p1b.log` に残る。
  - 同じ全件の実行に、`tests/tamper.rs` の 58 件も入っている。`TestKey::new()` で鍵を作るものを含む。
  - 第1期の `permutation-gateway` の `npm test` 全件（2,536 件）にも、`Keypair.generate`・署名を使う試験が入っている（agent-wallet、citizens など）。
  - どちらも鍵の制約より前の実行である。今の基準では数えず、再実行もしない。§1 の「`cargo test -p verify` 全件通過（tamper 58 件を含む）」と「npm test 2,533 通過」は、この扱いとする。
- 第12期の実行には、鍵の経路を通る試験はなかった。命令は `scripts/run-v17.sh`・`run-v19.sh` と §17.7。下の試験はどれも、`Keypair`／`TestKey`／`from_seed`／`sign` を、試験の module と、試験が呼ぶ src の関数まで辿って確かめた。
  - 検証器: `--lib`、`v16_v27_gate`、`v16_cpi_keyfree`、`evidence`、`new_bands`、`history`、`unit`、`camp_clear`、`missing_state`、`open_items`。`fixtures` は `march_fixture_is_fresh` を除いて流した。
  - findex: `coverage`、`no_hidden_gap`、`store_failure`、`v16_history_*`。
  - herald の `ingest_health`。`herald_fold::fixture` は `Signature::from(bytes)` で署名欄を埋めるだけで、署名しない。
  - ④の chain-flow の A・E・B と、⑯の荷車の試験。署名者は署名者フラグだけ。

# 第13期（2026-11-07）：④が push した統合候補 6cd6dd14

- 取得: `git fetch origin claude/gallant-ride-cunptv`
- HEAD は `6cd6dd14ef9289dcf0559fbf64e17a48750f6fc1`、tree は `fdad2bcbd0b1a4fa003862dbb43fc615923815da`。④の連絡と一致した。
- 祖先の確認:
  - 入っている: 27651bed、6984acfa、⑲ r2 の c022f4fc・803e3b27、④ r2・r3・r4（4ebc0dc3・15bed411・57c5c171）、⑳ 4b233e4a・b2f7becc・53ec22ab・85a48c7c、公開された統合候補 c7b3c54c。
  - 入っていない: ⑳ cab0bcac（⑯の手元に無い）、④の訂正文書 ba8f77dc（④の手元だけ）。
- 隔離した worktree で流した。⑯の試験は、そこへ写して流した。

実行の前に、試験の module と、試験が呼ぶ src の関数まで辿った。

- 鍵を作る、または署名するので外したもの:
  - 検証器: `tamper`（`TestKey::new()`）、`record`、`coverage`、`fixtures` の `march_fixture_is_fresh`。
  - findex: `ingest`（`Keypair::new_from_array` で署名）。
  - `-p fclient` は流していない。
- 新しい試験は、どれも鍵を使わない。
  - 対象: `custody*`、`history`、`ledger_history`、`resident_ledger`、`ws04_scan_resident`、`ws04_feed_scan`、`ws04_join_adversarial`、`ledger`。
  - 取引は `Transaction::new_unsigned`、アドレスは固定のバイト列。
- 27651bed からの chain-flow の変更は、`chain_nft.rs` と `check-fixtures.mjs` だけ。
  - `chain_nft.rs` は、⑳の `resident_auth::holder` と `Holder::authority` を読む。どちらも純関数。

## 18.1 固定ファイルの照合

| 確認 | 結果 |
|---|---|
| コミット済みの fixture の照合 | 31/31 |
| 作り直した出力とコミット済み fixture の比較 | 7 ファイルすべてバイト単位で一致 |
| 照合器の変異試験（`scripts/mutate-chain.py`） | 12/12 を検出 |

変異試験の中身:

- 第12期の M1〜M9。M5（実行記録の Citizen）と M7（実行記録の請求を Ok）は、第12期では見逃したが、今回は FAIL になった。**修正を確認した。**
- 新しい M10〜M12。実行記録と要約を同じように書き換えるので、要約と実行記録の突き合わせでは見つからない。
  - M10: vault を 0 にする。
  - M11: Citizen を別のアドレスにする。
  - M12: 譲渡後の請求を Ok にする。
  - どれも、固定の値（25,000,000、段 A の Citizen、BadAccount）との照合で FAIL になった。

## 18.2 ホストでの実処理（鍵なし、署名なし、PDA あり）

| 対象 | 結果 | 位置づけ |
|---|---|---|
| A NFT 参加と譲渡 | 2/2 | ゲームのプログラム本体。⑳の holder の定義で、旧所有者に StaleGeneration と NotCurrentAuthority |
| B 荷車 | 1/1 | Sim の mock。完成に数えない |
| E 賞金 | 2/2 | 賞金のプログラム本体。NFT 住民の請求はすべて BadAccount |
| C・D 記憶と成果 | 完了 | JS |
| ⑯ 荷車の障害試験 | 4/4 | mock。完成に数えない |
| 検証器 lib | 47/47 | |
| 検証器 custody 6、custody_history 8、custody_state 7、history 16、ledger_history 6、resident_ledger 3、ws04_scan_resident 4 | すべて通過 | |
| 検証器 camp_clear 3、missing_state 2、new_bands 7、open_items 3、unit 8 | すべて通過 | |
| ⑯ v16_cpi_keyfree 6、v16_v27_gate 3 | すべて通過 | |
| 検証器 evidence | **7/8（1 件失敗）** | 下 |
| 検証器 fixtures（1 件除外） | **7/8（1 件失敗）** | 下 |
| findex coverage 14、ledger 15、no_hidden_gap 4、open_items 5、store_failure 5、ws04_feed_scan 11、ws04_join_adversarial 7 | すべて通過 | |
| ⑯ v16_history_gaps 3、v16_history_coverage 4 | すべて通過 | |
| herald ingest_health | 3/3 | |

**失敗 2 件**（④の連絡のとおり）:

- `fixtures::march_synth_passes`
- `evidence::the_fixtures_have_nothing_for_v0e`

原因:

- どちらも、記録済みの `march-synth.json` を `verify()` に通すと verdict が Fail になる。
- `march_synth_passes` の出力には、`V11 TicketPlacementMismatch`（「site … is outside the placement rule of nation …」）が 6 件ある。
- evidence の試験では、V0e の項目は空で、verdict だけが Fail。同じ入力なので、同じ V11 の Fail と見ている（その出力は読んでいない）。

V11 が変わった経緯:

- `checks/v11_land.rs` は、地図の作業（7df3187a、3ef9b533、dd79c59a：分散配置と範囲の拡大）で変わった。
- この HEAD と公開された統合候補 c7b3c54c で、blob は同じ `13d8489f`。6984acfa の blob は `ae171350`。
- 古い配置規則で作った合成の fixture が、新しい規則で落ちている。

**これは既知の失敗で、完成に数えない。** fixture を作り直す `fixture::march::march()` は、固定 seed の鍵で署名する。そのため、鍵なしでは作り直せない。直すには、次のどれかが要る。

- (a) 利用者が許した場所で、署名済みの fixture を作ってもらう。
- (b) 試験の期待を、新しい配置規則に合わせる。
- (c) V11 が古い Season を古い規則で判定する。

## 18.3 実チェーンで確かめていないこと

§17.5 と同じ。加えて、次のこと。

- 地図の新しい配置規則で、実際に作られた Season を V11 が通すこと（合成の fixture は古い規則のまま）。
- ⑳ cab0bcac。
- 荷車の受付で、依頼者の権限を確かめること（④ §10.2 に要件。実装は利用者の担当）。

ログは `logs/phase13/` にある。

# 第14期（2026-11-07）：④の統合候補 8234b8dd

- 取得は `git fetch origin claude/gallant-ride-cunptv`。
- HEAD `8234b8dd2ce5546d1898ecaf95f24fab0b09853b`、tree `5aaf49522675fadbcca37087481759c02026cadd`。④の連絡と一致した。
- 6cd6dd14 の上に 3 コミットを足した版で、中身は次のとおり。
  - ba8f77dc：文書
  - 52c0bd45：V11 の 2 件
  - 8234b8dd：⑳ cab0bcac（`cab0bcacbd2dc2a6fb4a20e4d52d6562e40e1be6`）の merge
- ⑳ cab0bcac はこの版で初めて入った。

## 19.1 V11 の 2 件（52c0bd45）の独立確認

④の判断は「合成の march の fixture に、プログラムが受け付けえない ticket が 6 件ある。V11 の FAIL は正しい」。⑯はこれを次の 3 点で確かめた。

- **wedge の計算**
  - ゲームのプログラムと同じ `permutation-rules` の `ProvinceCoord` で、3 つの province の ring と wedge を計算した（`probes/v16_wedge_probe_main.rs`）。
  - 結果は (0,−2) が ring 2・wedge 4、(1,−3) が ring 3・wedge 4、(3,−3) が ring 3・wedge 5。
- **プログラムの規則**
  - `proc/citizen.rs::wedge_allowed` が許すのは次の 2 通りだけ。
    - 自分の wedge（faction と同じ番号）。
    - 自分の wedge が満員のとき、隣の wedge（faction±1）の最も外側の ring。
  - V11 の文言の「nation N」は faction の値そのもの（`v11_land.rs` の format）。
  - したがって、国 1 が使えるのは wedge 0〜2、国 2 が使えるのは wedge 1〜3。wedge 4・5 は、どちらの国にも許されない。
  - `ticket_nation_allowed` が規則を変えるのは、分散配置（`PLACEMENT_DISPERSED`）のときだけ。それ以外は `wedge_allowed` の結果そのまま。
- **M1 の時点の規則**
  - M1 の exit commit `629d007b5908932aae2ee992d7b219292c27aa12` の `wedge_allowed` の本体は、今と同じ（読み比べた）。

試験の書き換えも確かめた。

- 新しい `assert_only_the_impossible_tickets` は、次をすべて要求する。
  - Warn 以外の所見がちょうど 6 件。
  - 6 件それぞれが、決まった文言に 1 件だけ当たる。
  - どれも V11・TicketPlacementMismatch・bell 0・Fail。
  - verdict は Fail。
- 6cd6dd14 で⑯が見た失敗の出力（§18.2）は、まさにこの 6 件だった。
- 本物のプログラムの記録（`land`、`march_program`）は、これまでどおり PASS を要求している。

**判定**: V11 の FAIL は正しい。この 2 件は、既知の失敗を隠すものではない。fixture の欠陥を固定の期待として明示したもので、試験の弱め方として妥当である。

ただし、合成の march の Season はもう PASS の基準ではない。fixture を作り直すと鍵で署名することになり、⑯は実行できない。また ④の注意どおり、tamper の試験（鍵を使うので未実行）は march の基準が PASS であることを前提にしている。承認を得てそれを流すときは、この 6 件を考えに入れる必要がある。

## 19.2 固定ファイルの照合

| 確認 | 結果 |
|---|---|
| コミット済みの fixture の照合 | 31/31 |
| 作り直した出力とコミット済み fixture の比較 | 7 ファイルすべてバイト単位で一致 |
| 照合器の変異試験 M1〜M12 | 12/12 を検出 |

## 19.3 ホストでの実処理（鍵なし、署名なし、PDA あり）

| 対象 | 結果 |
|---|---|
| A NFT 参加と譲渡 | 2/2 |
| E 賞金 | 2/2 |
| B 荷車 | 1/1（mock、完成に数えない） |
| C・D 記憶と成果 | 完了 |
| ⑯の荷車の障害試験 | 4/4（mock、完成に数えない） |
| 検証器 lib | 47 |
| 検証器 camp_clear 3、custody 6・8・7、evidence 8、history 16、ledger_history 6、missing_state 2、new_bands 7、open_items 3、resident_ledger 4、unit 8、ws04_scan_resident 4 | すべて通過 |
| ⑯の v16_cpi_keyfree 6、v16_v27_gate 3 | すべて通過 |
| 検証器 fixtures（`march_fixture_is_fresh` を除外） | 8/8 |
| findex lib 10、coverage 14、ledger 15、no_hidden_gap 4、open_items 5、store_failure 5、ws04_feed_scan 11、ws04_join_adversarial 7 | すべて通過 |
| ⑯の v16_history_gaps 3、v16_history_coverage 4 | すべて通過 |
| findex `ingest` のうち鍵を使わない 4 件（`--exact` で名指し、5 件は除外） | 4/4 |
| localnet `feed_scan_tests`（`scan_ledger` の純関数、6 件は除外） | 3/3 |
| herald ingest_health | 3 |

このうち fixtures の `march_synth_passes_but_for_its_six_impossible_tickets` と、evidence の `the_fixtures_have_nothing_for_v0e` は、19.1 の固定の期待で通っている。

鍵の確認の追加:

- `ingest` で鍵を使うのは次の 4 件で、どれも `Keypair::new_from_array` で署名する。
  - `feed_and_rpc_poll_archive_the_same_transactions_and_resume`
  - `rpc_poll_pages_the_local_node`
  - `enriched_poll_archives_post_state`
  - `enriched_poll_retries_the_entire_batch_after_account_read_failure`
- `ingest` の `rpc_poll_against_a_live_node` は、環境変数が無いと何もせずに終わる。そのため数えない。
- localnet の `tests/*.rs` と、`chain.rs` のほかの試験の module は、鍵を使う。
- 変わった `resident_feed.rs`・`resident_ledger.rs` には、鍵の経路はない。

## 19.4 確かめていないこと

§17.5 と §18.3 の項目が残る（⑳ cab0bcac は、今回ホストで確かめた）。それに加えて次がある。

- 合成の march の Season を、正しい配置で記録し直すこと（鍵で署名するため）。
- tamper の試験（鍵を使う）が、新しい基準の march で成り立つこと。
- 実際の localnet のプロセスで、⑳の住民の feed を読むこと。

ログ: `logs/phase14/`

# 第15期（2026-11-08）：④の公開候補 cf517b55（受付の requester・所有者・世代の照合）

## 20.1 対象と差分

- 取得: `git fetch origin claude/gallant-ride-cunptv`
- HEAD は `cf517b558d1303a84dba618550f40cb460b7ad99`、tree は `75b67dc4f929527deaf885ae8858325e0b23b482`。
- 8234b8dd の上に 3 コミット:
  - 7d2fbe0d: cargo-only の run CLI
  - e61ea4db: runexec の受付が、依頼者を pass の現在の holder と照合する
  - cf517b55: 受付が chain の pass を読む
- 変わったのは `workstreams/04-execution` だけ。次の subtree は 8234b8dd と同じだった。
  - frontier-node `e3014ca1`
  - permutation-frontier `13cfd749`
  - permutation-prize `9dbc6350`
  - frontier-abi `486adaa5`
  - permutation-rules `f449a002`
  - permutation-gateway `8c200763`
- **同じ subtree でも、旧 SHA の結果は流用せず、この SHA で流し直した。**

## 20.2 受付の照合（読解）

- 確認は `intake::authorize` → `check_requester` の順に進む。
  1. requester の Citizen の citizen_tag が、run の owner と一致する。
  2. link と policy が、ゲームのプログラムの口座である。
  3. ⑳の `resident_auth::holder` と `Holder::authority` で、所有者と世代を照合する。
- この確認は store を開く前に行われる。同じ run_id を再び依頼した場合も同じ。
- `run accept` の CLI は `--requester` と `--rpc` を必須にしている。拒否は exit 5 で、store に何も書かない。
- 照合を通らない受付の経路は、次の 2 つだけ。どちらも外部からの依頼は通らない。
  - in-process の `Executor::accept`
  - `demo` コマンド
- **残る点**（実装上の制限。④も明記している）:
  - 依頼者が本当に署名したかは、gateway の資格層（③⑤）の責任である。runexec は `is_signer` 相当として受け取る。
  - 照合（pass の読取り）と store への受付の間に譲渡が起きると、旧所有者の run が受け付けられうる。これは受付前の譲渡と同じ扱い（受付済みの run は最後まで走る。利用者の決定 2026-11-07）。
  - executor は、authority の無い run（in-process の経路）もそのまま実行する。

鍵の監査:

- 新しいファイルは、鍵を作らず、署名もしない。
  - `src/intake.rs`、`src/intake_rpc.rs`（PDA の計算だけ）
  - `tests/intake.rs`、`intake_chain.rs`、`run_cli.rs`、`common/passnode.rs`
  - `clients/runs.mjs`・`runs.test.mjs`
- Sim の「署名」は sha256 の digest で、鍵ではない。

## 20.3 ⑯の独立試験と変異

`probes/v16_intake_regressions.rs` は 7/7 で通過した（mock の Sim、鍵なし）。pass の口座のバイトを作る部分は④の `tests/intake.rs` から写し、試験そのものは⑯が書いた。

| 試験 | 内容 |
|---|---|
| i1 | 譲渡後、旧所有者とその session の依頼は、世代が古くても新しくても拒否され、store に何も残らない。新所有者が作った run_id を旧所有者が再び依頼しても、Existing を知ることはできない |
| i2 | holder の session が同じ spec を再依頼すると Existing になる。最初の照合（Owner B、世代 1）は上書きされない。別の spec なら Conflict |
| i3 | 再起動後、照合は store から読み出せる。再依頼は Existing になり、run は Fulfilled まで進む。監査とストア検査も通る |
| i4 | A→B→A と譲渡すると、通るのは (A, 世代 2) だけ。(A,0)、(A,1)、(B,1)、(B,2) は拒否され、何も残らない |
| i5 | session は、期限が now ちょうど・過ぎている・前の世代で設定されたもの、のどれでも拒否される。期限内なら Session として受け付ける |
| i6 | pass の口座を 9 通りに改ざんすると、すべて拒否され、何も残らない（link・policy の所有プログラム、link の Citizen、asset の所有者・guard・key、resident の key・所有者、link の長さ）。citizen の不一致と owner の不一致も拒否される |
| i7 | 譲渡前に受け付けた run は、`ship.before_send` で落ちて再起動しても、1 回だけ Fulfilled になる。照合は (A, 0) のまま残り、旧所有者は新しい run を作れない |

照合のコードを、④の試験と⑯の試験に対して 4 通り壊した（`scripts/mutate-intake.sh`、`--no-fail-fast`）。

| 変異 | ④ intake（6 件） | ⑯（7 件） |
|---|---|---|
| I1 世代を依頼者の値ではなく pass の値で照合する | 2 件 FAIL | i4 が FAIL |
| I2 citizen_tag の照合を外す | 1 件 FAIL（文言の照合） | 通過（`check_requester` が link の Citizen で同じことを確かめるので、拒否の文言が変わるだけ） |
| I3 link・policy の所有プログラムの照合を外す | 1 件 FAIL | i6 が FAIL |
| I4 `accept_as` が照合を通らない | 6 件 FAIL | 7 件 FAIL |

## 20.4 回帰（cf517b55、ホスト、鍵なし、PDA あり）

| 対象 | 結果 | 位置づけ |
|---|---|---|
| chain-flow の照合 | 31/31 | fixture |
| 作り直した出力とコミット済み fixture の比較 | 7 ファイルすべて一致 | fixture |
| 照合器の変異 M1〜M12 | 12/12 を検出 | fixture |
| A NFT 参加と譲渡 | 2/2 | ホスト |
| E 賞金 | 2/2 | ホスト |
| B 荷車 | 1/1 | mock |
| C・D 記憶と成果 | 完了 | JS |
| ⑯の荷車の障害試験 | 4/4 | mock |
| ws04 の全試験（下記） | すべて通過 | mock とホスト |
| e2e-native の chain_nft 2、chain_prize 2、claims_vs_closes 12、error_codes 3、legacy_season_claims 4 | すべて通過 | ホスト |
| **e2e-native の registry** | **0/1（FAIL）** | 20.5 |
| runs の client（実バイナリを含む） | 4/4 | ホスト |

ws04 の全試験の内訳:

- lib 2、act_cli 6、acts 6、arrival 10、cargo_only 4、concurrency 8、continuity 4、faults 39、gateway_facts 7、intake 6、intake_chain 5、routes 4、run_cli 12、signed 6
- ⑯の v16_* 11（荷車 4、受付 7）
- `gateway.rs` の 9 件は ignored で、流していない。20.6 を参照。

検証器・findex・localnet・herald（cf517b55 で流し直した。鍵を使う試験は除いた）:

| 対象 | 結果 |
|---|---|
| 検証器 lib | 47 |
| 検証器 camp_clear 3、custody 6・8・7、evidence 8、history 16、ledger_history 6、missing_state 2、new_bands 7、open_items 3、resident_ledger 4、unit 8、ws04_scan_resident 4 | すべて通過 |
| ⑯の v16_cpi_keyfree 6、v16_v27_gate 3 | すべて通過 |
| 検証器 fixtures（`march_fixture_is_fresh` を除外） | 8/8 |
| findex lib 10、coverage 14、ledger 15、no_hidden_gap 4、open_items 5、store_failure 5、ws04_feed_scan 11、ws04_join_adversarial 7 | すべて通過 |
| ⑯の v16_history_gaps 3、v16_history_coverage 4 | すべて通過 |
| findex ingest の鍵なし 4 件 | 4/4 |
| localnet feed_scan_tests | 3/3 |
| herald ingest_health | 3 |

## 20.5 見つかった欠陥：contracts/registry.txt が古い

- `e2e-native/tests/registry.rs::registry_matches_the_code` が失敗する。メッセージは「the code's numbers differ from contracts/registry.txt」。
- 隔離した worktree で `REGEN=1` を付けて再生成し、差分を記録した（`logs/phase15/registry-diff.txt`）。その後、元に戻した。
- コードにあって registry.txt に無い命令は 12 個。
  - 0xC1 ExtendFrontier（地図の拡大、7df3187a）
  - 0xC2〜0xCC OpenLot … WithdrawLot（⑩の保管、00b36406）
- registry.txt が最後に更新されたのは c37652ed（2026-11-06）。
- ABI の割当表（`ABI-ALLOCATION-20261106.ja.md` の 28・29・44・45 行）には、これらが載っている。
- frontier-abi と permutation-frontier は 8234b8dd でも同じなので、8234b8dd・6cd6dd14 でも同じように失敗するはずである（⑯はその版では e2e-native を全件流していない）。
- **④の担当。直し方は REGEN=1 で生成し、差分を確かめてコミットすること。**

## 20.6 実行していないもの（鍵）と、ゲームへの接続

`tests/gateway.rs`（ws04 の run を agent wallet の gateway に通す 9 件）は流していない。

- この試験の bridge（`bridge/agent-gateway-bridge.mjs`）は `Keypair.generate()` を呼ぶ。gateway も取引に署名する。
- **したがって、④の run が実際の gateway のコードと鍵なしで結びつくことは、確かめていない。**

ゲームの既存の画面への反映（`permutation-server/web`）:

| 機能 | 画面の側 | ⑯の確認 |
|---|---|---|
| NFT 参加と ResidentAct | `frontier/fresident.mjs`・`fplay.mjs`・`controller.mjs`、SDK の `sdk/frontier/resident.mjs`（PDA の計算） | `frontier-resident.test.mjs` と `web-frontier-resident.test.mjs` は 8/8（no-keys-guard の下、鍵なし） |
| run の受付（④ cf517b55） | **画面にも gateway にも呼び出し元がない** | ⑬の resident ports（`13-citizens/resident/ports/ws04-acts.mjs`）だけが ws04 を呼ぶ |
| 賞金の請求 | 旧 Season の `claim.mjs`・`chainio.mjs` だけ | NFT 住民の請求は未実装（E は BadAccount を確かめるだけ） |
| RecordNation | 画面には無い | — |
| 記憶（⑫） | `frontier/council/*` に記憶の語はある。⑫の canonical との接続は読んでいない | 未確認 |
| 成果（⑮） | `drawers/era.mjs`・`hud/top.mjs` | 未確認 |
| 地図の拡大と保管（0xC1〜0xCC） | gateway の tag 表と budget 表だけで、画面は無い | — |

`web-frontier-chainio`・`web-frontier-controller` の試験は、`scripts/ci/node-key-tests.txt`（鍵を使う試験の一覧）に入っているので流していない。

## 20.7 ⑬ 81a03cf5（cdab18e8 を含む）を cf517b55 に重ねた木

- ⑬は `claude/eager-cerf-k74z5s` で公開されていた。
  - HEAD は `81a03cf5b32abe7d757a5cd224b2abce74308a6d`、tree は `ffa82c9f82a9f16017ebcd216e981f0787a07a08`。
  - cdab18e8（`cdab18e84b6f3de0c81a6e2c302f8d4cc5e4d502`）を含む。
  - cf517b55 には入っていない。
- ⑬の変更は `workstreams/13-citizens` の中だけだった。この directory は、⑬の基点 745e7ec6 と cf517b55 で同じ（tree `2aa557cf`）。
  - そこで、cf517b55 に⑬の directory を重ねた。結果の tree は `cb180b5a903b22cda6c9c4e304f36f12e7d1036f`（commit ではない）。
- 鍵の確認:
  - ⑬の keyless guard は、node:crypto、web3.js、solana-tx の PDA を止める。ガードは PDA も止めるので、許可された範囲より厳しい。
  - ⑬の鍵は `resident/keys.mjs`（node:crypto）と、gateway の `talk-node.mjs`（node:crypto）だけ。ガードが覆わない ed25519 の library は import されていない。
- 結果:
  - keyless の試験は **87 通過、0 失敗、57 skip**。skip は鍵が要るもので、数えない。
  - デモは、そのままの実行と bell 70 で再起動した実行の transcript が一致した（`3fa6919f…`）。
- ガードの記録は 11 件で、どれも 1 つの process だった。
  - `keyless.test.mjs` が、ガードが止めることを確かめる自己試験の 11 回（crypto 5、web3 4、solana-tx 2）。
  - ほかに鍵を使おうとした試験は無い。

## 20.8 ①〜⑳の成果の所在（cf517b55 と比べて）

基準:

- 祖先として含むかで分けた。祖先でない場合は、さらに次の 2 点を見た。
  - `git cherry` で、同じ patch が候補にあるか。
  - その branch が触ったファイルが、候補の中で同じ内容になっているか。
- 下の「候補に無い」は、どちらで見ても内容が入っていないもの。

| 担当 | 公開されている最新 | cf517b55 との関係 |
|---|---|---|
| ① | preserve/ws01-coop-s1-3f3c8478 | 含む |
| ② | preserve/ws02-rights-dc3bd3d（10-30） | 候補に無い（7 コミット、31 ファイル） |
| ③ | claude/modest-goldberg-c180fk 84f710d5（11-06） | 候補に無い（20 コミット、`workstreams/03-composability` の 104 ファイル） |
| ④ | cf517b55 | 本体 |
| ⑤ | preserve/ws05-provider-budget-45cba41e（10-30） | 候補に無い |
| ⑥ | preserve/ws06-creation-517796dc | 含む |
| ⑦ | preserve/ws07-series・return-fixes（10-30） | 候補に無い（画面の S1 部品） |
| ⑧ | ws08-persistence は含む。ws08-continuous・cont-verify（10-31） | 後の 2 つは候補に無い（触ったファイルのうち 24 件だけ同じ） |
| ⑨ | `workstreams/09-capacity`（integrate/ws09-10-audit） | 含む |
| ⑩ | claude/great-babbage-3ogkqu 9107b753（11-07） | 候補に無い 3 コミット（patch 0015 の core） |
| ⑪ | claude/kind-fermat-earbxe c137b51b（r12） | 0012 は候補にある。branch の 6 コミット（文書と r12）は無い |
| ⑫ | `workstreams/12-memory` | 候補にある |
| ⑬ | claude/eager-cerf-k74z5s 81a03cf5 | 候補に無い（20.7 で重ねて確認） |
| ⑭ | preserve/ws14-7d7f2143 | 含む |
| ⑮ | preserve/ws15-b1a09a0b | 含む。bf7f43fc は remote に無い（未着） |
| ⑯ | 本 branch | 検証だけ |
| ⑰ | preserve/ws17-0c80381d（10-31） | 候補に無い。RecordNation の tgz（464144b8…）も未着 |
| ⑱ | preserve/ws18-4fbe0c77、fix/ws18-clippy-hostile | 候補に無い（触ったファイル 20 件のうち 8〜9 件だけ同じ） |
| ⑲ | r2 c022f4fc と台帳の巻き戻り対策（3c664a61・7ab2b0b2） | 含む。ER（preserve/ws19-a91b7a4f・supp-d793ebd4）は無い |
| ⑳ | claude/funny-wozniak-cy4n64 d85c42da | 候補に無いのは文書の 1 コミットだけ |

利用者の作業（preserve/wide-*）:

- 次の 10 本ほどが、候補に入っていない。
  - wide-keeper-duties（+39）、wide-read-integration（+25）、wide-keeper-discovery（+24）
  - wide-real-depart-host、wide-recovery-crypto-wip、wide-interprovince-staged-wip、wide-reader-guards、wide-capture-read、wide-seal-records-wip、wide-combat-core、wide-claim-lifecycle、wide-open-province
- 中身は、広い世界の keeper、読取り、戦闘、請求。
- **wide-recovery-crypto-wip には暗号の作業が含まれるので、検証するときは鍵の監査が必要。**

## 20.9 実チェーンで確かめていないこと、次の一手

確かめていないこと（§17.5・§18.3・§19.4 に加えて）:

- 実際の gateway を通る run の受付（`gateway.rs` は鍵を使う）
- 画面から run の受付を呼ぶ経路（呼び出し元が無い）
- 署名した依頼者の認証（③⑤）
- localnet のプロセスで pass を読むこと（`intake_chain` は代役のノード）

次の一手:

- ④:
  - registry.txt を作り直してコミットする。
  - gateway の run の試験を、鍵を使わない形（署名済みのデータを入力にする、または署名を検査しない入口）で用意する。
  - 依頼者の認証が、どの層のどの関数で行われるかを明記する。
  - ⑬ 81a03cf5、⑩ 9107b753、③ 84f710d5 を統合するかどうかを決める。
- ⑬: 81a03cf5 を④に統合してもらう。⑯は、cf517b55 に重ねた木で 87 件の通過を確かめた。
- 未着: ⑮ bf7f43fc、⑰ RecordNation の tgz。

ログ: `logs/phase15/`

# 第16期（2026-11-08）：④の公開 HEAD 20db3313、⑬ d9ac99ad、⑦ 24369382

## 21.1 対象の版（GitHub から取得して照合した）

| 対象 | commit | tree | 備考 |
|---|---|---|---|
| ④ `claude/gallant-ride-cunptv` の公開 HEAD | `20db3313adf25481b714798759b1fdd0cb917275` | `b2304c4fa25e53bb15f1dbbffd42d6042c878957` | 2026-11-08 12:41 UTC。ae0df617 に④の文書（§13）を足しただけ |
| 利用者が示した基準 fa822453 | `fa8224538b8e4e4a92c2aee06ff5186a7e033576` | `8c4b1a852a90bafc777d96eab62d400c53294d17` | 20db3313 の祖先 |
| ④が申告した ae0df617 | `ae0df617cad8bef17b8763abe7f99baad11d78b2` | `4219fe2e03ce2b25776f1441efbe76fe9f2e551a` | 公開されている。20db3313 の親 |
| ⑬ `claude/eager-cerf-k74z5s` | `d9ac99ad1e468426d790e84971f09c43bfd1a3d3` | `92323016897f91d11af48ba945976561bbeccacb` | 候補に入っていない。⑬の 0e6df20e までは候補にある |
| 20db3313 に d9ac99ad の差分を当てた木 | （commit ではない） | `1d762ba11e983a403c8779fd6f730790f0002c0f` | d9ac99ad の差分は ws04-run.mjs と、その試験・fixture・文書だけ。そのまま当たった |
| ⑤ `claude/ai-participation-provider-budget` | `10e749677d96301766c2930a8f903baf28cce0bc` | `50f0f5059c9e74abf9b4ff5cb4524a6d564f35c8` | ⑬の試験の WS05_ROOT に使った |
| ⑦ `claude/wylls-ui-ux-visual-oixhgs` | `243693829bb3d1af5d86e4b7a90c7314fe42371c` | `27b079f9be19e98d6b346c0fd6cd4af35c442f7f` | 20db3313 の上に 5 commit |

旧 SHA の結果は流用していない。すべてこの版で流し直した。

## 21.2 ⑬→④：認証済みの requester を必須とすること

読解で確かめたこと:

- ⑬の `ws04ExecutionPort` は、`requesterOf` が無いとき、または requester を返さないときに `NoAuthenticatedRequester` を返す。このとき `accept` は呼ばれない。
- ④の受付が拒否したとき（NotAuthorized、BadRequest、Conflict）は、確定した拒否として扱い、新しい key で送り直さない。
- **ただし、`ws04ExecutionPort` を組み立てているのは、候補の中では⑬の試験だけである。本物の認証層（③⑤）から requester を渡す経路は、まだ無い。** gateway の `relay.mjs` にある `requesterOf` は settle 用の別のもので、ed25519 の署名を検査する。画面にも gateway にも、run の受付を呼ぶところは無い。

試験（ホスト、鍵なし。⑬の手順 §5 どおり）:

- ④の runexec は 20db3313 から build した（sha256 `dae6ef86…`）。⑤は 10e74967、⑫と⑬は候補の木のもの。
- 二つの鍵ガードを `NODE_OPTIONS` で子 process まで入れた。
- 結果:

| 木 | 件数 | 通過 | 失敗 | skip |
|---|---|---|---|---|
| 20db3313 | 188 | 182 | 0 | 6 |
| d9ac99ad を当てた木 | 193 | 187 | 0 | 6 |

- skip の 6 件は署名を伴うもので、数えない。
- ガードの記録は 11 件。どれも 1 つの process で、keyless.test の自己試験だった。
- 環境変数を付けない run.sh だけで流すと、121 件通過・67 件 skip になる。④の申告（182）は、外部の木（⑤⑫、runexec）をつないだときの数である。

⑬の run port のコードを 4 通り壊した（d9ac99ad の木で。⑬の試験 3 本、17 件に対して）:

| 変異 | 結果 |
|---|---|
| N1 requester が無いときの拒否を外す | 2 件 FAIL |
| N2 NotAuthorized を確定した拒否から外す | 3 件 FAIL |
| N3 矛盾した view の判定を外す | 2 件 FAIL |
| N4 held を unknown にしない | 1 件 FAIL |

## 21.3 unknown のときに送り直さないこと（⑬ d9ac99ad）と、本物の view

- 20db3313 の④の試験（faults、arrival、cargo_only、concurrency、continuity、signed。どれも通過）が保存した run は 157 件ある。それぞれ、実物の `runexec run view` で読んだ（`probes/fixtures/v16-real-views-20db3313.jsonl`）。
  - 状態の内訳: Fulfilled 103、Cancelled 23、Failed 15、Partial 6、Expired 5、DeliveredUnverified 3、Accepted 1、Reserved 1。
- ⑯の `probes/v16-run-view-real.test.mjs` の結果（候補の木と、d9ac99ad の木の両方で）:
  - R1: 本物の view に、矛盾したものは無い。
  - R2: 出発の痕跡（ship attempt が landed、receipt に caravan_sent）がある view を、failed や cancelled と読むことは無い。7 件の Failed（略奪と、輸送中の差し押さえ）は、landed（停止の前に効果あり）と読まれた。
  - 本物の view では、attempts・receipts・sent はいつも一致していた。**d9ac99ad の言うとおり、矛盾は本物の view では観測されなかった。**
- **R3（防御上の穴、本物の view では未観測）**:
  - 停止した view で、effects・outcome.effects・sent がどれも空なのに、次のどれかがあるとする。
    - ship attempt が landed
    - receipt に caravan_sent
    - in_flight が true
    - fees.unconfirmed が 0 より大きい
  - このとき fateOfRun は、Failed と Expired を failed、Cancelled を cancelled と読む（12 通りすべて。d9ac99ad の有無で変わらない）。
  - failed のとき、resident は同じ key では送り直さない。しかし時間を置いてから同じ行動を選び直せるので、新しい key で二重に送る余地がある。
  - 入力は `probes/fixtures/v16-r3-inputs.json`。⑬に渡した。直すかどうかは⑬の判断（④が統合中なので、⑯は直さない）。

## 21.4 費用の復旧（W1）と⑤の台帳

- ⑬の W1 の試験は、21.2 の 182 件に含まれ、すべて通過した。
  - stop の位置は 3 か所: wallet の hold の後、markRunning の後、cost の calling の後。
  - 試したのは、⑤の台帳あり（⑤の回復あり・なし）と、固定の費用の場合。
- ⑯の `probes/v16-ws05-fencing.test.mjs`（⑤ 10e74967、一時 directory、pid と時計は注入）は 3/3 通過した。
  - f1: crash の後に二つの process が同時に再起動しても、lease を取れるのは片方だけ（もう片方は AlreadyRunning）。回復は 1 回だけ（reserved は戻り、calling は undecided）。三度目に開いても、何も変わらない。
  - f2: 心拍が止まったまま生きている process（zombie）は、乗っ取られた後は新しい reserve ができない（LeaseLost）。回復済みの item を動かすことも、二重に戻すこともできない。
  - f3: 乗っ取りのときに呼び出し中だった item は undecided になる。zombie が実測した費用は 1 回だけ settle され、その後の settle と release は効かない。
  - **記録したこと:** 回復済みの item に対する zombie の `calling()` は、何もせず、例外も出さない。呼び出した側は知らされない。⑤の `inferOnce` は reserve と calling を同期で続けて行うので、乗っ取りがその間に入る余地は TTL の境目の一瞬だけである。⑤への改善提案にとどめる。

## 21.5 ゲームの既存画面への接続

| 機能 | 画面（permutation-server/web） | ⑯の確認 |
|---|---|---|
| wide | `app.mjs` が `map/widemode.mjs` を mount する。読み取り専用で、記録された広い世界を表示する | gateway・web の鍵なしの一式に含まれる |
| ⑩の保管 | 誤りの文（fi18n の 100〜104）だけ。操作の画面は無い | 同上 |
| run の受付（④） | **呼び出し元が無い** | — |
| ⑬の住民 | 画面は無い（⑬は「新しい UI は作っていない」と書いている） | ⑬の試験（21.2） |
| ⑫の記憶 | council が `/h/ai/memory/<tag>/episodes.json` を読む | 一式に含まれる |
| ⑤の agent | `fagent.mjs`・`fdelegation.mjs`（`/f/agent`） | 一式に含まれる。③⑤の capability の接続は後続 |
| ⑦の画面 | 協力の板（`hud/coopboard.mjs`）など（24369382） | 21.6 |

gateway・web の鍵なしの一式（CI と同じ `scripts/ci/node-keyfree.sh permutation-gateway 'test/*.test.mjs' 'screens/logic.screen.mjs'`）:

- 192 ファイルを流した。鍵を使う 97 ファイルは一覧に従って除いた。
- 1883 件のうち、1882 件通過、0 件失敗、1 件 skip。NoKeysGuard の発動は 0 回。④の申告 1882/0 と一致した。

## 21.6 ⑦ 24369382

流す前の監査:

- 画面の試験のうち、game と spectate は `startServer({ keyless: true })` を使う。
  - world.mjs の viewer は KEYLESS_WALLET を、liveworld は KEYLESS_FEE_PAYER を使う。どちらも鍵から作らない名前である。
  - ただし fee の鍵は、sponsor のときにだけ導かれる。node の側に no-keys-guard を入れたので、もし導けば例外になる。
- coop と v17 は、ブラウザの init script でガードしている。
- s1 と s1-card にはガードが無い。そこで、ページ（s1-parts.html、s1-card.html）が import するモジュールを静的にすべて辿った（`scripts/import-closure.py`。102 個と 76 個）。
  - 鍵の API にあたるのは、vendor の noble にある関数の定義だけだった。vendor の外から呼んでいるところは無い。
- `ws07-s1-page` と `ws07-s1-pure` は `startServer()`（固定 seed で鍵を導く）を使うので、流していない。

結果（Chromium は `/opt/pw-browsers/chromium`、playwright-core 1.63.0。no-keys-guard の下で）:

| 試験 | 結果 |
|---|---|
| 画面 6 本（spectate、game、s1、s1-card、v17、coop） | 34/34 |
| 単体 `test/web-frontier-ws07-*.test.mjs`（14 本） | 86/86 |

⑦の申告の「95 件」とは数が合わない。⑦に問い合わせた。

## 21.7 回帰（20db3313、ホスト、鍵なし、PDA あり）

| 対象 | 結果 |
|---|---|
| chain-flow の照合 | 31/31。作り直した出力は 7 ファイルとも一致 |
| 照合器の変異 M1〜M12 | 12/12 を検出 |
| ws04 の全試験 | すべて通過（⑯の 11 を含む） |
| e2e-native | すべて通過。registry 1/1 で、④の修正を確認した |
| runs の client | 3 通過、1 skip（実バイナリの試験。cf517b55 で 4/4 を確認済み） |
| 検証器 | lib 50、camp_clear 3、custody 6・8・7、evidence 8、history 16、history_assurance 8、ledger_history 7、missing_state 2、new_bands 10、open_items 3、resident_ledger 4、unit 8、ws04_scan_resident 4、fixtures 8（`march_fixture_is_fresh` を除外）、⑯の 9。すべて通過 |
| findex | lib 10、coverage 14、ledger 15、no_hidden_gap 4、open_items 5、store_failure 7、ws04_feed_scan 11、ws04_join_adversarial 7、ingest の鍵なし 4 件、⑯の 7。すべて通過 |
| findex wide_typed_index（feature wide-records-experimental） | 12 |
| localnet feed_scan_tests | 3 |
| herald | ingest_health 3、wide_index_read 1、wide 1（feature なし）。feature wide-world-experimental を付けると wide 3、wide_capture 9 |
| keeper（feature wide-world-experimental） | wide_duties 70、wide_discovery 14、wide_reveal 30、wide_snapshot_rpc 6、wide_feed_guard 12 |
| frontier-abi world_index（feature world-index-experimental） | 138 |
| permutation-frontier map_growth | 既定 8、wide 19 |

**注意**: findex の wide_typed_index、herald の wide_capture、frontier-abi の world_index は、feature を付けないと 0 件になる。0 件は未実行と同じで、合格には数えない。上の数は、feature を付けて流し直したもの。

- ⑯の変異の script（M4）が、⑮の stage D の patch（d491fd8d）による `d-outcome.json` の形の変更で止まっていた。これは照合器の穴ではなく、⑯の script の不備である。直してから流し直した。
- 鍵を使うので流していないもの:
  - `gateway.rs` の 9 件
  - 検証器の tamper、record、coverage、`march_fixture_is_fresh`
  - findex の ingest の 4 件
  - localnet のほかの試験
  - fclient の試験
  - ⑦の s1-page と s1-pure
- wide で、まだ流していないもの: native-crypto-tests、SBF、LiteSVM、ブラウザでの wide の表示

## 21.8 利用者の判断が要ること（⑯は決めない）

1. 本番で、requester をどの層が認証して④に渡すか（③⑤の gateway の資格層か、新しい経路か）。決まるまで、run は試験の中だけで、gateway の 9 件は鍵なしでは流せない。
2. wide の 6 つのルール（④ §12）。決まるまで、wide は読み取り専用で、境目をまたぐ移動は拒否され、配備用の build では DEPART_DEBIT が無効のまま。
3. ⑰の routes/prize.mjs をどちらにするか。決まるまで、NFT 住民の賞金請求は統合されない。
4. ⑧ d1d07078（製品の判断）。
5. 合成の march の fixture を、鍵を使って記録し直すことを承認するか。承認すれば tamper の試験を戻せる。承認しなければ、既知の失敗として固定したまま。

ログ: `logs/phase16/`

# 第17期（2026-11-08）：④の公開候補 af41e617

## 22.1 対象（GitHub から取得して照合した）

- ④ `claude/gallant-ride-cunptv`: `af41e617218f3a93d94c7374d125ac61fd69833d`、tree `18663848b7262f42edfe0eefac5825f166c5895d`。取得したとき（13:24 UTC）の HEAD で、利用者の指定と一致した。
- 20db3313 の上に、次を足したもの:
  - ⑬ 36376b3b（R3）と c82fe0e1（⑯の R3 の入力を試験データにしたもの）
  - ⑦ 24369382、① c01c7418、② r6、③ 6ee7c4d1、⑥ 7bcdfa24
  - ⑨ capacity-preview（版のビット 0x1000）、⑩ 0002・V26 の再生、⑪ 0013〜0016
  - ⑳ cb47e720（0xDD）、VW1（4ecef1d9）
- その後、④の branch は 970c50a1（tree `7c329699…`）を経て `b3d0897869add543985c3f7a6c7aa8b7991f9bf1`（tree `2e378f3a9fb60e82d504e9b2de410acea9ae132b`）まで進んだ。b3d08978 は 22.6 で別に扱う。

## 22.2 ⑬の R3 の修正

- 修正（36376b3b）は ws04-run.mjs の `sendTraces` である。停止した run で効果の欄が空でも、次のどれかがあれば unknown にする:
  - failed・expired 以外の attempt
  - reserved または unconfirmed の手数料
  - in_flight
  - receipt
- ⑯の R3 の入力 12 件は、すべて unknown になった（`logs/phase17/run-view-real.log`）。
- 本物の view 157 件の読みは、修正の前（20db3313）と後（af41e617）で同じだった（`scripts/fate-dist.mjs`）。効果の無い本物の停止（Failed 6、Expired 4、Cancelled 5）は、今も failed または cancelled と読まれる。**修正で後退した読みは無い。**
- ④の view の生成（view.rs、store.rs、model.rs、executor.rs）は、20db3313 と同じ blob だった。
- ⑬の全件（④の runexec は af41e617 から build、⑤ 10e74967、二つのガード）:
  - 197 件中、189 件通過、1 件失敗、7 件 skip。
  - 失敗の 1 件は longrun の「steady step time」だった。day 42 から ms/day が約 1 秒から約 5.5 秒に跳ねており、同時に走らせていた Rust の build の負荷による。
  - skip のうち 1 件は、WS16_REAL_VIEWS を設定していなかったためのもの。
  - 負荷の無いときに、この 2 ファイル（longrun と ws04-run-view）を流し直すと 10/10 だった（`logs/phase17/ws13-rerun.log`）。
  - 署名を伴う 6 件は skip のままで、数えない。ガードの記録は自己試験の 11 件だけだった。

## 22.3 wide が Unknown のままであること

- V0（⑪ 0016）: 0x4000 の Season の wide の tag は、どの build でも UNVERIFIABLE（WideUnmodelled）になる。VW が build されていなくても、命令が 1 つでもあれば PASS にならない。
- VW1: wide の記録があれば、最後に必ず UNVERIFIABLE（WideUnmodelled）が付く。
- ⑯の `probes/v16_vw_unknown.rs`:
  - w1〜w4 は通過した。確かめたこと:
    - whole で矛盾の無い chain でも PASS にならない。
    - 始めが刈られた、unproven の履歴は WideChainUnproven で、FAIL にならない。
    - ほかのプログラムの frame の記録、失敗した取引の記録は、記録として数えない。
  - **欠陥（af41e617）**: unproven の履歴で途中の記録が 1 件欠けると、FAIL WideChainBroken になる（w3 で記録し、w5 で失敗として再現した。`logs/phase17/v16-vw-w5-af41.log`）。
    - 最終の口座との不一致は「whole のときだけ FAIL」としているので、それと食い違う。
    - その結果、⑲の履歴の欠けが、改ざんの主張に変わってしまう。
    - ④に連絡し、④は b3d08978 で直した（22.6）。

## 22.4 回帰（af41e617、ホスト、鍵なし、PDA あり）

| 対象 | 結果 |
|---|---|
| chain-flow の照合 | 31/31。作り直した出力は 7 ファイルとも一致。変異は 12/12 を検出 |
| ws04 | 130 通過、0 失敗、10 ignored（gateway.rs 9 件は鍵を使う。chain_caravan 1 件は run.sh で流す） |
| e2e-native | 24（registry を含む） |
| ⑯ intake の回帰 7、荷車の障害 4 | 通過 |
| 検証器（既定の build） | 154、fixtures 8（`march_fixture_is_fresh` を除外） |
| 検証器（wide-world-experimental） | 121（VW1 と⑯の w1〜w4 を含む） |
| findex | 80、ingest の鍵なし 4 件、wide_typed_index 12（feature あり） |
| herald | 5（feature なし）、wide と wide_capture で 12（feature あり） |
| keeper の wide | 132 |
| frontier-abi の world_index | 138（feature あり。feature なしだと 0 件で、未実行として扱う） |
| map_growth | 既定 9、wide 20 |
| localnet の feed_scan_tests | 3 |

## 22.5 ゲームの既存画面

- gateway・web の鍵なしの一式（CI と同じ。193 ファイル、鍵を使う 97 ファイルは除外）:
  - 1886 件中、1884 件通過、1 件失敗、1 件 skip。
  - 失敗の 1 件は `citizens-run-check` の hook の監査で、120 秒の timeout ちょうどで止まった。Rust の build と同時に走らせていた。
  - 負荷の無いときに、そのファイルを流し直すと 25/25 だった（`logs/phase17/gateway-run-check-rerun.log`）。
  - ④の申告（1885/0）とは、件数が 1 件違う。
- ⑦の画面 6 本と単体 14 本（af41e617 の上で。screens の server、world、liveworld は 24369382 と同じ）: 120/120。
- 画面への接続は §21.5 から変わっていない。
  - run の受付には、画面からも gateway からも呼び出し元が無い。
  - ⑩の保管は、誤りの文だけ。
  - wide は読み取り専用。

ログ: `logs/phase17/`

# 第18期（2026-11-08）：b3d08978 の verifier と、最終候補 7535a17e

## 23.1 b3d08978 の verifier（完了）

- HEAD は `b3d0897869add543985c3f7a6c7aa8b7991f9bf1`、tree は `2e378f3a9fb60e82d504e9b2de410acea9ae132b`。
- 1 回目は、ディスクが満杯になって出力を失った。不要になった build 出力を消して、流し直した。

| 対象 | 結果 |
|---|---|
| 既定の一式 | exit 0。lib 50、camp_clear 3、custody 6、custody_history 8、custody_replay 10、custody_replay_caravans 11、custody_state 7、evidence 9、history 16、history_assurance 8、ledger_history 7、missing_state 2、new_bands 10、open_items 3、resident_ledger 4、rights_replay 18、unit 8、ws04_scan_resident 4、⑯の v16_cpi_keyfree 6・v16_v27_gate 3 |
| fixtures（`march_fixture_is_fresh` を除外） | 8 |
| wide の build | lib 59、history 16、new_bands 10（1037.8 秒）、⑯の v16_vw_unknown w1〜w5 の 5 件 |

**④の VW1 の修正を確認した。** unproven の履歴で途中が欠けた場合は、FAIL ではなく WideChainUnproven になる。whole の履歴で途中が欠けた場合と、head を書き換えた場合は、FAIL のままである。

wide の new_bands が長くかかった件の調べ:

- process は 598 秒の時点で CPU 99％、CPU 時間は 9 分 52 秒だった。計算が進んでいる状態で、止まってはいなかった。
- af41e617 では、同じ試験に 1045.5 秒かかっていた。
- 最後まで走らせ、10/10 で通過した。

## 23.2 最終候補 7535a17e（照合済み。Node の側）

- HEAD は `7535a17e135ff3b18f7ad1160599f1473b334794`、tree は `1960174902f4e90ac61a004264954757a528cd1e`。b3d08978 の上に 20 commit を足したもの。
  - 中身: chosen-march の core と村の UI の 10 件、⑦ aac14551、⑤⑥⑧、7535a17e での viewer の初期化と wide の消去。
  - ⑦ の screens の server・world・liveworld は 24369382 と同じ。
- gateway・web の鍵なしの一式（194 ファイル。鍵を使う 97 ファイルは除外）: 1909 件のうち、1908 件通過、0 件失敗、1 件 skip。NoKeysGuard の発動は 0 回で、④の申告 1908/0 と一致した。
- ⑦の画面 8 本（spectate、game、s1、s1-card、v17、coop、s1-page、s1-pure）: 46/46。
  - s1-page と s1-pure は、⑦ の nokey-page.mjs で開く。鍵の無い test wallet を使い、ブラウザの WebCrypto の鍵の操作を止める。
  - ページが import するモジュールを辿ると、純 JS で鍵を導く箇所が 2 つある（`publicKeyOf`）。一つは `keyFromSeed` の中で、もう一つは `importBackup` の中である。
    - `keyFromSeed` では、その直後の pkcs8 の importKey がガードで止まり、数えられる。
    - `importBackup` は、利用者が backup を読み込んだときだけ動き、画面の試験は触れない。
- 閲覧者の初期化（resetViewer と clearWide、adoptResident）は、`web-frontier-wide-holding-ui.test.mjs` が確かめ、鍵なしで流した。
  - 確かめたこと: NFT の login・logout、Citizen・world・source の切り替え、遅れて届いた別の閲覧者の答えで、wide の選択とデータが消えること。
  - `web-frontier-controller.test.mjs` は鍵を使う試験の一覧に入っているので、流していない（未実行）。

Rust の側は 23.3 に書く。

## 23.3 最終候補 7535a17e（Rust と ⑬）

- 隔離した worktree で流した。HEAD は `7535a17e135ff3b18f7ad1160599f1473b334794`、tree は `1960174902f4e90ac61a004264954757a528cd1e`。
- 試験は鍵を使わないものだけ。native-crypto-tests と、保留した demo の feature は使っていない。
- **すべて、この SHA で流した。旧 SHA の結果は、どれも流用していない。**

| 対象 | 通過 | 失敗 | 未実行・除外 |
|---|---|---|---|
| verify の既定の一式（custody 6・8・7、custody_replay 10、custody_replay_caravans 11、rights_replay 18、new_bands 10、⑯ の 9 を含む） | 193 | 0 | — |
| verify fixtures | 8 | 0 | `march_fixture_is_fresh`（鍵で署名する） |
| verify wide-world（lib 59、history 16、new_bands 11、⑯ の VW1 w1〜w5） | 91 | 0 | — |
| verify wide-economy（lib 60、wide_economy 6） | 66 | 0 | — |
| keeper の wide（discovery 14、duties 70、economy_index 3、feed_guard 12、reveal 33、snapshot_rpc 6） | 138 | 0 | — |
| findex（既定の 80、ingest の鍵なし 4、wide_typed_index 12） | 96 | 0 | ingest の鍵を使う 4 件 |
| herald（既定 4、wide 13） | 17 | 0 | — |
| localnet の feed_scan_tests | 3 | 0 | 鍵を使うほかの試験 |
| frontier-abi の world_index（feature あり） | 139 | 0 | — |
| permutation-frontier の `map_growth_runtime_tests::wide_land`（wide、wide_economy 12 件を含む） | 23 | 0 | ほかの map growth は ⑧ が担当（10 件と 33 件。⑯ は自分の結果として数えない） |
| chain-flow | 31/31、7 ファイルとも一致、変異は 12/12 を検出 | 0 | — |
| ws04（⑯ の intake 7、荷車 4 を含む） | 130 | 0 | gateway.rs の 9 件（鍵）、chain_caravan 1 件（run.sh で実行） |
| e2e-native（registry を含む） | 24 | 0 | — |
| runs の client（実バイナリ） | 4 | 0 | — |
| ⑬ の全件（runexec は 7535a17e で build、sha256 `4cb6634d…`。⑤ 10e74967、二つのガード、WS16_REAL_VIEWS） | 191 | 0 | 署名を伴う 6 件 |
| gateway・web の鍵なしの一式（23.2） | 1908 | 0 | skip 1 件、鍵を使う 97 ファイル（web-frontier-controller.test.mjs を含む） |
| ⑦ の画面 8 本（23.2） | 46 | 0 | — |

**判定**: 7535a17e の鍵なしの範囲で、失敗は 0 件。

まだ確かめていないもの（鍵、または実チェーンが要る）:

- 署名と送信
- 実チェーン、SBF、LiteSVM
- native-crypto-tests の wide の封印
- gateway を通る run の受付
- web-frontier-controller.test.mjs
- ⑬ の署名を伴う 6 件
- 本番の requester の認証層（③⑤。利用者の判断で、未決）

④ が試して取り下げた relay attestation と pin の修正は、⑤ の review 待ちで、新しい HEAD はまだ無い。

## 23.4 訂正：web-frontier-controller.test.mjs（7535a17e）

- 23.2 と 23.3 では、この試験を「鍵を使う試験の一覧に入っているので未実行」とした。この扱いを改め、確かめてから流した。
- 一覧に入っている理由:
  - `scripts/ci/node-key-tests.txt` の scan が、このファイルの stub の wallet に一致した。
  - stub は Wallet Standard の feature 名 `solana:signTransaction`・`solana:signMessage` を持ち、どちらも空の配列を返すだけ。
  - ファイルの中に、鍵の API の呼び出しは無い。seal の root も固定の hex である。
- 呼び出し先の確認:
  - この試験は controller.mjs と wallet.mjs を import する。
  - web の `keyFromSeed` は、guard が止める pkcs8 の importKey の前に、純 JS で公開鍵を導く（`session.mjs publicKeyOf`）。
  - そのため、repository の no-keys-guard だけでは「導出が無かった」とは言えない。
- 確認の方法:
  - ⑯は `scripts/v16-web-key-hook.mjs` を書いた。web の鍵の入口（publicKeyOf、keyFromSeed、importBackup、devWallet、enableDevWallet）を、load のときに「記録して throw する」形に書き換えるもの。
  - これを no-keys-guard と一緒に preload した。
  - 対照の実験（`scripts/v16-web-key-hook-control.mjs`）で、3 つの入口が拒否され、記録されることを確かめた（`logs/phase19/hookctl.log`）。
- 結果（7535a17e、tree 19601749）: **19/19 通過**。hook の記録は 0 件、NoKeysGuard の発動も 0 回だった。
  - wallet の account の切り替えで前の所有者が消えること、古い /h/me の答えが今の閲覧者を置き換えないことなど、閲覧者の初期化の試験を含む。
- したがって、この試験は**鍵なしで動く**。⑯の未実行の一覧から外し、通過に数える。
- CI の一覧から外すかどうかは、④の判断である。⑯は変更しない。

# 第19期（2026-11-08）：⑤ 07fc6f64 を入れた後継 16576826

## 24.1 対象と差分

- ④ `claude/gallant-ride-cunptv` の HEAD: `16576826084a8ea7bd6b12b845d50b97f3d14904`、tree `7f6ff8b0fd1a3765fe00f4507ee87fdcd1ccdd71`（2026-11-08 16:43 UTC）。
  - 7535a17e の上の 1 commit で、取得した時点の branch の先端。④ が後継として確定させるのを待つ。
- 変わったのは `workstreams/05-ai-participation` の 4 ファイルだけ:
  - RELAY-TREE-ATTESTATION-10.ja.md
  - model-api/src/access-check.mjs
  - model-api/test/relay-tree.mjs
  - model-api/test/relay-tree.test.mjs
- 4 ファイルとも、⑤ の `07fc6f64f7f8acfb6f86fb50ce44d9283ca8932d`（tree `d941f077…`、`claude/ai-participation-provider-budget`）と同じ blob。⑤ の directory は全体で `01582ec1` が一致した。
- 変更の中身:
  - `access-check.mjs`: 検証済みの relay tree に `52ccd7fc…`（7535a17e の permutation-gateway）を足した。
  - `relay-tree.mjs`: 試験の pin を、disk の上の permutation-gateway の tree（node_modules の link は除く）にした。RELAY_TREE を指定するときは、disk の tree と一致しなければならない。
  - permutation-gateway と workstreams/04-execution の subtree は、7535a17e と同じ（`52ccd7fc`、`a33e3b0a`）。

## 24.2 この後継で流したもの（鍵なし）

| 試験 | 結果 |
|---|---|
| ⑤ の鍵なしの 11 ファイル（HANDOFF-GITHUB の一覧どおり。厳しい mode の `P05_GUARD_DERIVE=1`。④ の実物の runexec と clients/acts.mjs を使用） | **61/61** |
| ⑤ の gateway の 4 ファイル（agent-wallet の revoke-transfer、citizen-lane、sender-capability、run-facts。⑤ の guard、厳しい mode） | **13/13** |
| 対照 A：permutation-gateway に、見直していないファイルを 1 つ足す | relay-tree が 1 件落ちる（"not a reviewed relay tree"） |
| 対照 B：RELAY_TREE を別の tree（560f8659）にする | relay-tree が 1 件落ちる |
| 対照の後に元へ戻す | relay-tree 2/2。worktree はきれいなまま |

- runexec は、⑯ が 7535a17e から offline で build したもの（sha256 `4cb6634d…`）。workstreams/04-execution の subtree は後継と同じなので、後継の runexec そのものである。⑤ は代わりの runexec を使っていたが、この確認では実物を使った。
- 最初に import を辿って選んだ autopilot、citizen、continuing、multiprocess-world の 4 ファイルは、ガードが `Keypair.generate` を拒否して落ちた（鍵は作られていない）。どれも ⑤ の鍵なしの一覧には入っていない。鍵を使う試験として扱い、数えない。

## 24.3 引き継いだ結果（コードが変わっていないので）

- 7535a17e の結果（§23.2〜23.4）は、7535a17e のものとして扱う。後継で流し直したことにはしない。
- 後継で変わったのは ⑤ の directory だけで、frontier-node、permutation-*、workstreams/04・13、web は blob ごと同じである。そのため、長い Rust の一式は流し直していない。
- 対象外のまま残るもの:
  - 鍵を使う試験（§23.3 の一覧と同じ）
  - 実チェーン
  - probe を本物の relay に送ること（opt-in のまま）
  - 本番の requester の認証層の判断

## 24.4 ④の確認（2026-11-08 16:50）

- ④は、`16576826084a8ea7bd6b12b845d50b97f3d14904`（tree `7f6ff8b0…`）を確定した後継とした。⑯が流した版と同じである。
- runexec の sha256 は、④ が `f039854a…`、⑯ が `4cb6634d…` で、一致しない。どちらも同じ workstreams/04-execution の subtree `a33e3b0a` から build したもので、build した場所の path がバイナリに入るため、ハッシュが違う。⑯の 61/61 は、⑯が build したバイナリでの結果である。
- web-frontier-controller.test.mjs について、④は CI の鍵の一覧から外さない。一覧は scan が機械的に作るもので、手で例外を足すと、後で鍵に当たる経路が増えたときに見落とすため。この試験は、ガードを付けて手で流す試験として扱う。⑯もこれに同意する。

# 第20期（2026-11-08）：④の後継 4d44f021（⑮③⑥① の差分）

## 25.1 対象と差分の照合

- HEAD は `4d44f021df1e9e6c37a072e81bcfc04f0c2e6d06`、tree は `131c6cb451bd597ccc037546bd96d2373ce9ffa0`。16576826 からの fast-forward で、4 commit（どれも [skip ci]）。
- 変わったのは 19 ファイルで、4 つの directory の中だけ。各 directory は、元の担当の先端と byte 単位で同じだった。

| directory | 候補 | 元の担当（branch） |
|---|---|---|
| workstreams/15-coop-outcomes | `79ae0102` | ⑮ `fb7bbdef`（claude/determined-maxwell-uhc6a3） |
| workstreams/03-composability | `fb6072b2` | ③ `838338be`（claude/modest-goldberg-c180fk） |
| workstreams/06-creation | `fbf70df9` | ⑥ `7232c86b`（claude/wylls-creation-publishing-reuse-31aiyj） |
| workstreams/01-national-strategy | `f0e0d792` | ① `ca44e603`（ws/01-coop-s1） |

- workstreams/04-execution（`a33e3b0a`）は変わっていない。runexec は、⑯ が 7535a17e から build したもの（sha256 `4cb6634d…`）を使った。

## 25.2 見つけた欠陥：⑥ の journal の lock（journal の整合と、下流での再実行の問題）

`probes/v16-ws06-journal-lock.test.mjs`（鍵なし。注入できる `fs` と `alive` で、二つの process の割り込みを決定的に再現する）:

- **J1**：crash の後、二つの process が同時に再起動する。
  - 両方とも、古い holder（pid 999）を読んで「死んでいる」と判断する。
  - A が lock を unlink して作り直した後に、B が A の新しい lock を unlink して自分の lock を作る。
  - その結果、**両方が開けてしまう**。lock のファイルには片方の pid しか残らず、もう片方の save が、知らせなしに上書きされる。
- **J2**：同じ pid での二度目の open が受け付けられる（`holder === pid` を乗っ取りとして扱うため）。一つの process の中に writer が二つでき、`#busy` も instance ごとである。
- **J3**：lock を乗っ取られた writer が、そのまま save し続けられる（fencing が無い）。新しい holder の "sent" の記録が、古い状態で上書きされた。
- **J4**（対照）：別の process の生きている holder は JournalLocked で拒否され、close すると lock が消える（通過）。

影響:

- ⑥ の試験によると、run と request の id は、呼ぶ前に journal に固定されている。そのため、上書きされた後の再実行は、同じ id で下流に再送される（下流の冪等性に頼る）。
- **二重送信を立証したものではなく、journal の整合の欠陥として扱う。**

再現の方法:

    V16_WS06_DISPATCH=<tree>/workstreams/06-creation/src/connect/dispatch.mjs \
      node --import <tree>/scripts/ci/no-keys-guard.mjs --test verification/16-independent/probes/v16-ws06-journal-lock.test.mjs

ログは `logs/phase20/v16-ws06-lock.log`。

## 25.3 影響を受けた試験（4d44f021 で新しく流した。呼び出し先を監査してから流した）

| 試験 | 結果 |
|---|---|
| ⑮ node-keyfree（test/*.test.mjs） | 134/134 |
| ③ run-guarded.sh（no-keys と no-pda）、RUNEXEC_BIN なし | 25 通過、7 skip（RUNEXEC_BIN が要る） |
| ③ run-guarded.sh、実物の runexec と ④ の clients/acts.mjs と候補の ⑤ を渡したもの | 1 回目：31 通過、**1 失敗**。その後の 5 回：32/32 |
| ③ integration.test.mjs だけを流したもの | 候補で 2 回、⑤ 10e74967 で 1 回、基準 16576826 で 1 回。どれも 5/5 |
| ⑥ ports・dispatch・connect・connect-live・intake | 29 通過、1 skip（WS06_RUN4_STORE が要る）。2 回とも同じ |
| ① node-keyfree | 239/239 |
| ① coop.browser.nokey | 10/10（中の check の数）。宛先の新しい 2 件を含む：読めない・空の ?to= では 0,0 の 0 番に依頼しない。宛先が合わないときは、送る・結び付けるを出さない |
| gateway の web-frontier-ws07-coop と ws07-s1-pure（① の board.mjs を使う側） | 12/12 |

③ の 1 回だけの失敗:

- 落ちたのは integration.test の「③ and ⑤ on one agent and one ④ registry」。③ の `send_caravan` と、⑤ の登録・送信を同時に走らせる場面で、`r3.state` が undefined になった。
- その後の 9 回の実行では、再現しなかった。基準の 16576826 でも、同じ並びで 5 回とも通過した。
- 間欠的な失敗として ③ に記録を送る。③ の今回の変更による後退だとは断定しない。ログは `logs/phase20/s03-full.log` と `s03-repeats.txt`。

鍵の扱い:

- ⑥ の roles.test.mjs（`generateKey()` を呼ぶ）は、監査の段階で外し、流していない。
- ① の browser の試験は、署名の確認を固定のバイト列の照合に差し替えている。したがって、これは画面の証拠であって、署名を検証した証拠ではない。

## 25.4 ⑦ の画面の証拠の分け方（訂正）

- ⑯ が 23.2 と 23.4 で数えた ⑦ の画面 46/46 は、どれも `WS07_CHROME=/opt/pw-browsers/chromium`（full の Chromium）で流した。ログに NoWasm や WebCrypto unavailable は無い。
- ただし、8 本の画面の試験は、どれも WASM の march の操作を assert していない。見ているのは、join の画面の文、村のカード・引き出し・協力の板、chronicle の失敗の表示などである。
- したがって、**46/46 は画面の部品と表示の証拠で、本来の WASM の march の操作の証拠ではない**。march の成功、署名、live には数えない。
- ⑦ の NoWasm の訂正（headless shell で secure-origin が効かない）は、その設定で流した run だけに当てはまる。⑯ の run は、その設定ではない。

## 25.5 ⑥ の journal の lock の修正 11be9d44（④ の候補には、まだ入っていない）

- ⑥ の branch `claude/wylls-creation-publishing-reuse-31aiyj` の HEAD: `11be9d4446b8b01bfd34c2e0d1b0ae793ae73a7e`、tree `b001859824a178563a63dcff31c55c54069fb64d`。1360ce51 と 11be9d44 の 2 commit。
- 中身:
  - lock を JSON（pid、process の開始時刻、random の token）にした。
  - 乗っ取りを `.takeover` の mutex の中で行う。lock を読み直して、変わっていないことを確かめ、一時ファイルを rename する。
  - save() は、lock が自分の token のときだけ書き、そうでなければ JournalFenced を返す。
  - 同じ pid の二度目の open は JournalLocked になる。
  - 新しい import は `randomUUID`（node:crypto）だけで、鍵には当たらない。
- ⑯ の probe（隔離した worktree で、④ の候補の no-keys-guard を付けて流した）:
  - `v16-ws06-journal-lock.test.mjs`：4/4。
    - J1：A は JournalLocked で拒否され、B だけが開く。
    - J2：JournalLocked で拒否。
    - J3：JournalFenced で拒否され、journal は B の "sent" のまま。
    - J4：通過。
  - `v16-ws06-journal-lock-r2.test.mjs`（新規）：2/2。
    - J5：死んだ taker の mutex を二つの taker が見つけた場合、A は JournalLocked で拒否され、書いたのは B だけ。lock も B のもの。
    - **J6（残る隙間）**：save() の fence の確認が通った直後に乗っ取りが起きると、その save の rename が 1 回だけ通る。新しい holder の `{"step":"sent"}` が、古い `{"step":"stale"}` で上書きされた。次の save は JournalFenced になる。
      - 失った lock 1 つにつき、古い書き込みが 1 回起きうる、ということである。journal の整合の問題であって、二重送信ではない。
      - 直し方の候補（どれにするかは ⑥ の判断）：rename の直前に lock の token を確かめ直して窓を縮める。あるいは、token ごとの journal に書き、読む側は lock の token で選ぶ（世代の fencing）。
- ⑥ の試験（ports、dispatch、connect、connect-live、intake。③ と ④ は候補の木のものを使った）：36 件のうち、35 件通過、0 件失敗、1 件 skip（WS06_RUN4_STORE が要る）。

# 第21期（2026-11-08）：④の後継 7c7fe932

## 26.1 対象と差分の照合

- HEAD は `7c7fe932015ad4e70c897cd7aeec90f18c669295`、tree は `1c17ecbe668e7c31a0ca8265547f191be11ee2c3`。4d44f021 からの fast-forward で、17 commit。
- directory を重ねたもの（① `9dcb1e88`、⑫ `5370d0fe`、⑬ `a420f924`）は、それぞれ元の担当の directory の tree と一致した（`ef4cd887`、`db36041a`、`df0901fb`）。
- merge した file は、どれも元の担当の commit と同じ blob だった。
  - ⑳ v28_resident_acts.rs
  - ② v0_coverage.rs、rights_replay.rs
  - ⑲ ingest.rs、ws19_feed_pages.rs
  - ⑨ の rules と frontier の capacity.rs
- 例外は keeper の play.rs（⑱ `0bf02548`）で、④ が申告したとおり 1 token だけ違う（`clone()` を外した）。

## 26.2 見つけた欠陥：⑫ の journal が、二度目の crash の後に開けなくなる

`probes/v16-ws12-torn-marker.test.mjs`（鍵なし。note だけを使い、allocation の検証の経路は通らない。memory の module の import の閉包には、鍵の API が無いことを確かめた）:

- 状況：torn の最後の行がある journal を開き直す。その後の最初の書き込みは、`\n`、`{torn:{line,sha256}}`、本体の行を、一度の append で書く。その途中で二度目の crash が起きた場合を、5 か所で切って試した。

| 切った場所 | 開き直した結果 |
|---|---|
| 改行だけ | 開く（torn 1、n1・n2） |
| **marker の途中** | **開けない：`journal: corrupt line 3`** |
| marker の後で、改行の前 | 開く |
| marker と改行の後 | 開く |
| 本体の行の途中 | 開く（torn 2） |

- 原因：最初の torn の行が、もう最後の行ではない。次の行（marker の切れ端）も parse できない。このため、marker の規則にも最後の行の規則にも当てはまらず、`corrupt line` を投げる。
- 記録は失われていない（file の中には n1・n2 が残っている）。ただし memory は、人が直すまで開けない（可用性の欠陥）。
- ⑫ と ④ に、再現の方法を送った。

## 26.3 ④ の scan の修正（9781d04e）の確かめ

- scan の対象が増えた：git で管理される全ての *.test.mjs、その test directory の中の相対 import、裸の import。`--covers` で、scan が見ていない file を拒む。
- ⑯ の静的な監査（`scripts/v16-key-closure.py`。src/ も含めて、全ての相対 import を辿る。何も実行しない）の結果:
  - CI で鍵なしとして流す 3 つの package のうち、gateway には、一覧に無いのに import の閉包の中で鍵の API の名前に当たる試験が 106 本ある（`logs/phase21/key-closure-audit.txt`）。
  - ほとんどは、定義に当たっているだけである（vendor の noble、client/src/keys.mjs など）。誤検出もある（Math.sign）。
  - これは、scan が src/ を見ないという設計どおりで、実行のときの guard だけが守りになっている範囲である。
- その guard が見えない、web の純 JS の鍵の導出（publicKeyOf など）について、CI の鍵なしの gateway の一式（194 file）を、⑯ の web の hook を足して流した。
  - 1877 件のうち、1839 件通過、37 件失敗、1 件 skip。**hook の記録は 0 件**だった。
  - 37 件の失敗は、hook（Node 22 の registerHooks）と一部の module の link が合わないために起きたもの（"request for './max.js' is from a module not been linked"）で、候補の欠陥ではない。④ の hook なしの実行は 1908/0。
  - したがって、この 37 件（14 file の全体と、ほかの 7 file の中の 23 件。§29 で訂正。file の一覧は `logs/phase21/hook-inconclusive-files.txt`、件ごとの一覧は `logs/phase23/hook37-list.txt`）については、hook での確かめは結論が出ていない。

## 26.4 そのほか

- ⑬ の port（必須の欄が欠けた、版つきの view は unknown にする）：本物の view 157 件の読みは、4d44f021 の port と全件同じだった。④ の view.rs は 20db3313 から変わっていない。
- ⑨ の capacity：読んで確かめただけで、流していない。
  - 足し算を checked_add と saturating_add にし、overflow のときは CapError::Overflow を返す。
  - flag と recipe の byte を厳しく decode する。
  - 結果が緩む方向の変更は、見当たらない。
- 流していないもの:
  - ⑨、②、⑳、⑲、⑱ の Rust の試験。④ の結果だけがある。
  - ① の試験。
  - browser の画面（⑦ の guard が入るまで流さない）。

## 26.5 ⑥ の journal の lock の修正 5f74a270（④ の候補には、まだ入っていない）と J6 についての反例

- 対象：⑥ の `5f74a270c92f8c5aa565bbc65d99ce318d01d228`（tree `8fd27045cf69c84f2d4e93dda6dd17470ee4c03a`）。
- ⑥ が直したもの：lock と mutex を一時ファイルに書いてから link で置くので、空のファイルが見えない。他の process のファイルは、誰も消さない。
- ⑯ の probe を、この版に対して流した:
  - 1 回目の probe：4/4（J1・J2・J3 は拒否され、J4 は通過）。
  - 2 回目の probe：2/2（J5 は拒否される。J6 は、注入した `alive` のもとでは WROTE のまま）。
  - **3 回目の probe（新規、`v16-ws06-journal-lock-r3.test.mjs`）**：2/2。`alive` も `startOf` も注入しない（本物の処理の表を使う）。
    - J7a：生きている A が持っている lock が、外から消される（一時ファイルを掃除するもの、運用の後始末など）。すると、別の process の B が開いて書く。A の次の save は JournalFenced で拒否され、journal は B の "sent" のまま。
    - **J7b**：lock が消されるのが、A の save の窓の中（fence の確認が通った後）の場合。B が開いて書いた後、**A の古い書き込みが通り、B の "sent" を上書きした**。
- ⑥ は「J6 に届くには、嘘をつく alive が要る」と述べている。これには反例がある。**生死を正しく答えたままでも、lock の file が外から消されれば J6 に届く。**
  - 起きる条件は、外部の操作で lock が消えることだけで、深刻さは低い。§8 の限界（別の機械や別の pid 名前空間から書く場合）と同じ種類として、文書に書くのがよい。
  - 直すなら、保持している lock の inode を open のときに覚えて、holds() で path の inode と比べる、あるいは flock を使う、などの方法がある。どれにするかは ⑥ の判断。

## 27. ④ の後続 82ddc29f → 4b3b399e → 695e1d83、⑫ 13903d94、⑥ 0918a973、⑦ e28d6b38

### 27.1 対象と差分の照合

- ④ `claude/gallant-ride-cunptv` @ `695e1d834466c058e48acbc3e37c76d5dfe75357`（tree `8847f898b59d7dd224ee31150f5bebca3591bccf`）。3e617b28 の上に 3 commit：
  - `82ddc29f`（tree `8b1f848d…`）：`workstreams/06-creation` が ⑥ `5f74a270` の同じ dir と**一致**。
  - `4b3b399e`（tree `33ba3f7c…`）：`workstreams/12-memory` が ⑫ `13903d94`（tree `b41ff840d50c45c2deee41773f5b054c5998b06c`）と**一致**。
  - `695e1d83`：`06-creation` が ⑥ `0918a973`（tree `5cfc6e0c7faa28125ecf8e5286482709687142db`）と**一致**。12-memory も 13903d94 と一致のまま。
- 3e617b28 からの変更は 8 file（06 の 5、12 の 3）だけ。
- ⑥ 0918a973 の src の差分は、comment の行だけ（comment でない行の増減は 0）。
- 基準は引き続き 16576826。

### 27.2 ⑫ 13903d94：二度の crash の、まだ開けない形

静的監査：`src/index.mjs` の import 閉包は 8 module、`persistence-keyfree.test.mjs` の閉包は 12 module。鍵の語が出るのは comment と、公開鍵による署名の**検証**だけ。生成・導出・署名はない。④ の `no-keys-guard` の下で流した。

- ⑫ の試験 `persistence-keyfree.test.mjs`：13/13。
- ⑯ の T1（`probes/v16-ws12-torn-marker.test.mjs`）：1/1。5 つの切り方すべてで開く。「marker の中」は torn 2 で n1・n2 が残る（以前は corrupt line 3）。
- **新しい probe `probes/v16-ws12-torn-marker-r2.test.mjs`**：
  - T2：torn tail の後の 1 回目の書き込みを全 byte（338 通り）で切り、それぞれについて次の書き込みも全 byte で切った。reload は 123,219 回。
    - **9,024 回で、journal を開けない**（`journal: corrupt line 4`）。
    - 書いた note が黙って消える reload は 0 件。失敗はすべて「開けない」。
  - T3：3 回続けて marker の中で切る。2 回目の crash の後で開けなくなる（T2 と同じ形）。
  - T4：同じ process の中で、書き込みが途中で失敗して再試行する（338 通り）。失敗 0。memory にも reload 後にも n3 が 1 回だけある。
- 開けない形は 1 種類だけ（`logs/phase22/ws12-t2-shape.txt`）:
  - 1 回目の crash が、1 個目の marker の途中で起きる。
    - 3 行目の torn の後に、marker の切れ端が 4 行目の読めない行として残る。
  - 次の reload は、3 行目と 4 行目の 2 行を torn tail にする。ここまでは正しい。
  - 次の書き込みは、marker(3)、marker(4)、本文の順に書く。2 回目の crash が次のどこかで起きる:
    - marker(4) の途中（8,930 回）。
    - marker(3) の直後で、改行の前（94 回）。
  - すると 3〜4 行目の run の後ろに、読める marker(3) が来る。そのため、この run は末尾の run にならない。
  - 名前を探す走査は、次の読めない行（marker(4) の切れ端）か、ファイルの終わりで止まる。4 行目は名前のないまま残り、journal は拒否される。
- 直し方の案（どうするかは ⑫ の判断）：ファイルの終わりまで、torn の marker と読めない行しか続かない run は、末尾の run と同じに扱う（名前を付けている途中の crash）。
- 影響：④ の 4b3b399e と 695e1d83 にも、同じ 12-memory の tree が入っている。

### 27.3 ⑥ の整理（R1/R2 は 5f74a270 で修正、J7 は 0918a973 で運用の限界）への ⑯ の見解

695e1d83 の `dispatch.mjs` に対して、⑯ の probe を再び流した（④ の guard の下）。

| probe | 結果 |
|---|---|
| 1 回目 | 4/4。J1・J2・J3 は拒否、J4 は通過 |
| r2 | 2/2。J5 は拒否。J6 は、嘘をつく `alive` を注入すると WROTE のまま |
| r3 | 2/2。J7a は fenced。J7b は WROTE（lock を外から消す場合） |

結果は 5f74a270 と同じ。

**整理には同意する。**
- 通常の open・takeover・save・close の手順だけでは、⑯ の probe で再現できる未解決の競合は残っていない。
- 古い書き込みが通るのは、次のどちらかの場合だけ:
  - 生死の判定が嘘をつく（J6、注入した場合）。
  - 生きている持ち主の lock が、手順の外で消される、または置き換えられる（J7）。
- ⑯ が前に挙げた「inode を比べる」案は、取り下げる。⑥ の指摘どおり、確認の後に消されれば、窓が後ろにずれるだけになる。
- 窓を本当に塞げるのは、カーネルの lock か、条件付きで書ける保存先だけ。新しい native の依存を入れてまで塞ぐ必要はない。§8.3 の制約と限界の書き方で足りる。
- 確かめていないこと:
  - 共有や network の file system。
  - 別の pid 名前空間（§8 の限界）。
  - Node 22.22.0 以外の版。
  - 実際の掃除の道具（tmp 掃除など）が、lock を消す頻度。

### 27.4 ⑦ の browser の key guard（487e75e8 → e28d6b38）の監査と、届いた範囲

- 対象：⑦ `claude/wylls-ui-ux-visual-oixhgs` の `e28d6b388e19c595b17bdc07d30f3a4fad44325b`（tree `ef7c58c45333b42d2bfca4a93da78893e619a6fe`）。16576826 からの fast-forward で、8 file。
- **静的監査（Node 側）**：
  - fixture の `world.mjs` の `viewer()` が `keyFromSeed(DEV_SEED / SESSION_SEED)` を呼ぶのは `keyless=false` のときだけ。
  - `liveworld.mjs` の `keyFromSeed(FEE_SEED)` は live mode の中だけ。
  - guard と march の試験は、どちらも `startServer({keyless:true})` と `stage('holding')` だけを使い、live にしない。
  - JS の `publicKeyOf` は、Node 側からは呼ばれない。repo の guard は、pure JS の導出までは止めないので、これは監査で確かめた。
- **静的監査（page 側、`ws07/nokey-page.mjs`）**:
  - `session.mjs` を配るときに、`keyFromSeed` と `publicKeyOf` を拒否に置き換える。export の binding なので、`fsession.mjs`、`wallet.mjs`、`importBackup`、`restore` / `cached` → `sessionOf` を通る経路もすべて止まる。
  - `session.mjs` の top level には、鍵の呼び出しがない。
  - route の regex は `/frontier/session.mjs`（council/main.mjs が import する。その file は無い）にも当たる。
  - WebCrypto の generateKey、deriveKey、deriveBits、sign、unwrapKey、秘密鍵の importKey は拒否される。
  - test wallet は署名を拒否する。
- **気づいた点（どれも低い）**:
  - G1：`ws07-guard.screen.mjs`（installed proof）は、guard が入ったかを**先に確かめずに**、`keyFromSeed(zero)`、`publicKeyOf(zero)`、`generateKey(Ed25519)` を呼ぶ。
    - 置き換えが黙って効かなかった場合、この試験自身が、固定の seed（zero）から公開鍵を導出し、鍵を生成してしまう（fail-open）。
    - march の試験のように、呼ぶ前に `String(m.keyFromSeed).includes('key use blocked')` と subtle の各 method の置き換えを確かめ、入っていなければ中止するのがよい。
    - ⑯ は、禁止の経路を guard に止めさせる試験になるので、この file を**流していない**。⑦ の結果（1/1）だけがある。
  - G2：init script は Web Worker の中では動かない。`seal-worker.mjs`（BLS の timelock）の realm は guard の外にある。
    - 今は worker の中に `subtle` の呼び出しがなく、march の試験は seal を押さないので、届いていない。
    - seal を押す試験を作るときには、worker 側にも guard が要る（または inline mode を使う）。
  - G3：guard は SubtleCrypto の instance を置き換えるので、`SubtleCrypto.prototype.*.call` を使えば迂回できる。web の code には、そうする箇所はない（grep で確認）。
- **⑯ の独立の実行**：`ws07-march.screen.mjs`、full Chromium（channel 'chromium'）、repo の `no-keys-guard` の下で、**2/2**（desktop・phone）。`logs/phase22/ws07-march-e28d.txt`。
  - ⑯ の web key hook は、registerHooks の link error（既知）で使えなかった。Node 側の根拠は、監査と repo の guard。
  - **届いた範囲**：
    - secure context。
    - page 自身の WASM kernel で、通れる tile を選ぶ。
    - order card の作成、変更、stance、取り消し、繰り返しの押下、refresh、戻る・進む、reload。
    - 封印・署名・送信は**していない**（relay への request は無い。page の key 記録は空）。
  - march の成功、seal、signed、live の証拠には**しない**。
  - これは、以前の headless shell での run（NoWasm）とは別の、新しい証拠として扱う。
- 流していないもの：ws07-guard（上の理由）、s1-page、s1-pure、coop の試験、interaction の keyless mode（⑦ の作業中）。

### 27.5 c260c438 の verifier（以前から残っていた分）

`cargo test --locked --offline -p verify`（lib と、custody・history・state・replay・replay_caravans・rights_replay・v16_v27_gate・v16_cpi_keyfree）：**128/128**、exit 0（`logs/phase22/verify-custody-c260.txt`）。

### 27.6 ④ 11bc9698：⑦ の取り込みと、src を通る scan

- 対象：`11bc9698e7ac6526e60bdf930df0476b9b573521`（tree `8141858b50b368ba033e1006ab06afaf4e87ee9d`）= 695e1d83 + `a23f02bb`（⑦ e28d6b38 の merge）+ `11bc9698`（scan）。
- ⑦ 由来の path（`permutation-gateway/screens`、`test/web-frontier-ws07-coop.test.mjs`、`hud/coopboard.mjs`）は、e28d6b38 と**一致**。§27.4 の監査と march 2/2 は、そのまま当てはまる。G1（installed proof の fail-open）は残っている。
- scan：`--check` は exit 0（119 直接 / 205 src を通る / 5 review 済み）。作り直した `node-key-tests.txt` は byte まで同じ。scan の fixture 試験は 4/4。どれも file を読むだけで、試験は流していない。
- ⑥ の review 済みの 5 件：
  - 閉包の中で `keys.mjs` を import するのは plan.mjs・registry.mjs・validate.mjs で、どれも caravan.mjs → plan.mjs から入る。
  - caravan が使うのは `resolve` だけ。`resolve` は own() だけを使う純粋な関数（plan.mjs 92〜107 行）。
  - plan.mjs と keys.mjs の top level には、呼び出しがない。
  - **review の結論は正しい。** ただし理由の文の「plan.mjs の import だけで届く」は不正確で、registry.mjs と validate.mjs も keys.mjs を import する（どちらも plan.mjs の先）。
- **scan の見落とし（新規）**：
  - scan がたどるのは、文字列で書かれた相対 import だけ。
  - list に載らない（＝流してよいとされる）試験 164 件のうち 26 件は、scan がたどれない経路で code を動かす：子 process の spawn・exec、`import(new URL(…))`、`import(変数)`（`logs/phase22/scan-unfollowed-runnable-11bc.txt`）。
  - その先を ⑯ が scan の PAT でたどると、2 件で鍵の API の名前に届いた:
    - `workstreams/05-ai-participation/model-api/test/safety-e2e.test.mjs` → spawn `test/procs/autopilot-worker.mjs` → `permutation-gateway/src/frontier/agent/gateway.mjs`（`.sign(`）。
    - `workstreams/12-memory/test/adapters-ws13-real.test.mjs` → `import(new URL('demo/run-demo.mjs', WS13))` → `workstreams/13-citizens/world/harness.mjs`（`.sign(`）。
  - 今の CI には影響しない。⑫ の list は adapters-ws13-real を手で外しており、⑤ の model-api には CI の job がない。
  - ただし、scan の「list に無い＝鍵を使わない」という判定は、この 2 件では誤り。`node-keyfree.sh --covers` も通してしまう。
  - そのほかに、⑯ が行き先をたどったもの:
    - gateway の citizens-* の spawn 先 7 件。
    - web-sdk の sdk / frontier の 9 module。
    - 12-memory の ws13 の frame・ws12-canonical・public-evidence。
    - ⑤ の ledger-worker。
    - いずれも、鍵の API の名前はない。
  - たどっていないもの:
    - ⑬ integration-records の `RUNEXEC_BIN`（Rust の binary）。
    - gateway の ac10a の 2 件（一時的に作る変異 module を import する）。
    - connect-live の `load(root, rel)`（③・④ の tree を読む。subtle の鍵の method は、試験が自分で置き換える）。
- 案：
  - 上の 2 件を、保守的な除外として list に載せる。
  - spawn や計算した import を持つ試験は「たどれない」として印を付け、review を要るものにする。

### 27.7 ⑫ a7ac51b7：二度の crash の形の修正の独立の確認

- 対象：⑫ `a7ac51b7ca41fa2b7973979b743ee929dbcea8c3`（tree `a00e577c2fc081ce9f19bd50bfafd33ac6ad1c6b`、12-memory の tree `7dd95fbbb3991de6e2006320cf85dddcdb15724c`）。親は 13903d94。変わったのは store.mjs、persistence-keyfree.test.mjs、mutate.sh の 3 file。
- 規則：
  - 読めない行から始めて、その後に続く読めない行と marker をすべて含め、最初の読める記録の手前までを、一つの範囲とする。
  - 範囲がファイルの終わりまで続けば、torn tail とする。まだ名前のない行だけを、次の書き込みで名指しする。
  - それ以外の範囲では、読めない行がどれも、範囲の中の marker で（行番号と sha256 で）名指しされていなければ拒否する。
  - 書き込みに失敗した後の `_rescanTail` も、同じ規則になった。
- import の閉包は 13903d94 と同じ（store.mjs の import は変わらない）。鍵の API はない。④ の guard の下で流した。

| 試験 | 結果 |
|---|---|
| ⑫ の persistence-keyfree | 14/14 |
| ⑯ の T1 | 5/5 開く |
| ⑯ の r2 の T2（二度の crash、全 byte × 全 byte） | reload 123,219 回で失敗 0 |
| ⑯ の r2 の T3（crash を 2〜4 回） | どれも開く |
| ⑯ の r2 の T4（338 通り） | 失敗 0 |
| ⑯ の shape の分類 | `{}` |
| **新しい r3 の T6（三度の crash。1 回目と 2 回目は 11 byte おき、3 回目は全 byte）** | reload 401,837 回で**失敗 0**（拒否も、書き終えた note の消失も、重複もない） |
| **r3 の T7（陰性の対照）** | 下の表 |
| **対照：r3 を 13903d94 に向けて流す** | T6 が `corrupt line 4` で失敗する。probe が前の欠陥を検出できることの確認 |

T7（crash では作れない損傷）の結果：

| 入れた損傷 | 結果 |
|---|---|
| 途中の記録が読めない | 拒否 |
| 途中の記録の 1 byte を変えた | 拒否 |
| 読めない行を、間違った sha の marker が名指しする | 拒否 |
| marker が別の行を名指しする | 拒否 |
| 正しく名指しされた途中の範囲 | 開き、n1・n2・n3 が残る |
| marker が読める記録の行を名指しする | 記録は消えない（n1・n2・n3） |

**結論**：⑯ が見つけた二度の crash の形は直った。三度の crash の標本と陰性の対照でも、新しい問題は見つからない。

確かめていないこと：
- 三度の crash を全 byte × 全 byte × 全 byte で試すこと（1 回目と 2 回目は 11 byte おき）。
- 書き込み 1 回が、ファイルの中で連続していない形で失われる場合（file system の性質）。
- allocation（署名の検証の経路）。
- ④ の候補にはまだ入っていない（④ の 11bc9698 は 13903d94 のまま）。

### 27.8 ④ 64960c1e → bb41fc0d → d415e013：review 済みの判断が、変更の後も残り続けるか

- 対象:
  - `64960c1ecba9343f4df7624a5b0d0bcb4fd3a519`（tree `7673ab42…`）：12-memory が ⑫ a7ac51b7 と**一致**。§27.7 がそのまま当てはまる。
  - `bb41fc0d9bda0a7cbff5afcfccfdfcce959dff6c`（tree `c21df14035a0ceed52cf354b72b7e9fbecf17234`）：scan の変更。
  - その上の `d415e0131c275cd5ee4e8e97da78b6dd349e129a`（tree `f4529f406c17ce36d81531400c2295470981fea0`）：⑦ 780acac7 の merge。
- bb41fc0d の scan：
  - `--check` は exit 0（119 / 205 / 23 unfollowed / 8 reviewed）。fixture の試験は 5/5。
  - ⑯ が §27.6 で挙げた 2 件は、unfollowed として list に載った。
- **review が古くなる問題（新規）**：
  - `node-key-reviewed.txt` の entry は、path と理由の文だけ。
  - scan が review を外すのは、次のどれかの場合だけ:
    - 直接または helper での hit になった。
    - 閉包が鍵の API の名前を含まなくなった。
    - その file が、scan の調べる対象から外れた。
  - そのため、review の後で、試験自身や依存先に鍵を**呼ぶ**変更を入れても、review は通り続ける。
- 確かめ方：⑯ の静的 fixture `probes/v16-scan-stale-review.mjs`。
  - 一時ディレクトリに text の file を書き、scan に読ませるだけ。import も実行もしない。
  - 鍵の API の名前は、文字列をつないで作る。

| 場合 | ④ bb41fc0d の scan | ⑯ の試作（閉包の digest） |
|---|---|---|
| S0 review したまま | 流してよいまま。`--check` は 0 | 同じ |
| S1 依存先（caravan）が plan.sealPlan → signHash を呼ぶようになる | **流してよいまま。`--check` は 0** | exit 5 「stale review」 |
| S2 試験自身が signHash を呼ぶ（試験の text には鍵の API の名前が出ない） | **流してよいまま。`--check` は 0** | exit 5 |
| S3 鍵を生成する新しい依存を import して呼ぶ | **流してよいまま。`--check` は 0** | exit 5 |
| S4 閉包の中の無害な comment の変更 | 流してよいまま | exit 5（再審査が要る。代償） |
| C0 対照：S1 で review の entry が無い場合 | `--check` は 3。再生成すると list に載る | 同じ |

ログは `logs/phase22/scan-stale-review-{bb41,proto}.txt`。

- **最小の仕組みの案**（試作：`patches/v16-scan-review-digest.diff`、57 行、bb41fc0d の scan に対して）:
  - entry を `<path>  closure=<hex 16 桁以上> [targets=a,b]  # 理由` にする。
  - digest は、試験の文字列の相対 import の閉包**全体**（試験自身を含む）について、（path、bytes の sha256）を並べ替えたものの sha256。`targets=` には、review が読んだ計算 import や spawn の先を書き、その閉包も digest に含める。
  - scan は毎回 digest を計算し直す。一致しなければ exit 5 で「stale review」と出し、新しい digest を示す。その間、その試験は保守的な除外のほうに戻る。
  - digest の無い entry も exit 5 になる。今ある 8 件には、再審査のうえで digest を付ける必要がある。
  - unfollowed から review で外す entry（⑫ の adapters-ws13-*、connect-live の `load(root, rel)`、scan の fixture 試験）は、`targets=` が無いと、行き先の変更を検知できない。
- 試作の確認：上の表の 6 場合だけ。fixture は ④ の scan の fixture 試験と同じ形。実際の tree の 8 件には当てていない。
- ⑦ 780acac7（d415e013 に入った）：5 file が 780acac7 と一致する。
  - web の差分は表示の順番、css、締め切りの行だけ。鍵・署名・session・wallet の経路の変更はない（文言の行は既存の表示のまま）。
  - browser は、④ が G1 の修正まで止めているので、流していない。

### 27.9 誤って force-add した file の監査（71713b34）

- **何が起きたか**：`git add -f verification/16-independent` を使ったため、`.gitignore` で外していた、または追跡していなかった、⑯ の過去の受け渡しパッケージとログが、必要な 4 file と一緒に commit され、push された。
  - 入った commit：`71713b3492704053fd3ef942a058d8081bb699a4`（親 `eb78357b…`）。`origin/claude/dreamy-ramanujan-ijj8qj` に push 済み。
  - 不要だった file：61 件、618,468 byte。
  - 追跡を外した commit：
    - `925e6f891c7425015049a6d6be65eb79b5027db5`：60 件。
    - 次の commit：`dist/wylls-verify16-20261031T001910Z/REPORT.ja.md` の 1 件。925e6f89 での filter に漏れていた。
  - **追跡を外しても、公開済みの履歴からは消えない。** 履歴の書き換えも force-push もしていない。
- 監査の範囲（`logs/phase22/audit-71713b34.txt` に、全 path、blob SHA、byte 数を記録）:
  - 61 file を、push した commit から取り出した。
  - 2 つの tar.gz は空のディレクトリに展開し、114 個の member を調べた。
  - 3 つの bundle は、head と前提 commit を確かめた。
  - それぞれの blob が、71713b34 より前の公開履歴にあったかを、`git hash-object` と照合した。
  - text の 151 file について、pattern で走査した:
    - PEM の秘密鍵、64 byte の keypair の JSON、base58 で 87〜88 文字の値、128 桁の hex。
    - session の backup にある `Key:` の行、secret・seed・token・password の代入、cloud の token。
    - 認証の header、proxy の設定、e-mail。
    - NFT、artwork、未公開、景品、賞品などの語。
- 結果:
  - 61 件のうち 15 件（REPORT・INVENTORY・INVARIANTS・README と patches P1〜P10）は、71713b34 より前にすでに公開されていた。
  - 新しく公開された 46 件の内訳:
    - 試験の実行ログ。
    - パッケージの照合用 file（HEAD.sha、HEAD.tree、PREREQUISITE.sha、SHA256SUMS、RESTORE.ja.md）。
    - tar.gz とその sha256。
  - bundle の head（`fc8e8ec3…`、`1da3238d…`）は、どちらもすでに公開されている branch に含まれる。
  - tar の member で新しいものは、ログと照合用 file だけ。パッケージは当時から `inbox/` を除いていた。
  - pattern の hit：鍵・seed・token・認証・e-mail は 0。base58 の長い値は 3 種類あり、どれも試験の出力の中の取引の**署名**（`"signature":`、`settled transaction`）。署名は秘密ではない。
  - 賞品の素材を示す語は 0。「prize」は、公開済みの prize program の code と試験の名前としてだけ出る。
- **判断**：秘密や未公開の賞品素材を含むものは見つからなかった。公開を止める必要がある、疑わしいものはない。
  - 限界：pattern による走査と、公開済みの blob との照合による判断。全ログを人の目で全文読んだわけではない。
- 今後は、明示した必要な path だけを stage する。広い `add -f` と履歴の書き換えはしない。

### 27.10 ④ 02be5f41（⑩ 3fd1db24、patch 0006）：V26 が custody の送り出しの経路を判定する

- 対象：`02be5f41be115150801b868d00a9ba240cacc7b8`（tree `92cdd2eb762a534c6f6fa433707b304bb6853be5`、親 d415e013）。`cherry picked from 3fd1db24dc51b028945cbe78b32c54977bd6e95c` で、差分は ⑩ の 3fd1db24 と**同じ**（`git diff` を比べた）。
- 静的監査:
  - 追加された行に、鍵の API はない。
  - verify crate のうち、固定の seed の Keypair を使う code は `src/tamper.rs`、`src/fixture/{mod,march}.rs`、`tests/common/mod.rs` の `world()` にある。
  - lib の unit test 55 件と、下の 6 file の試験は、どれもそこへ届かない（test module は fixture・tamper・common::world を呼ばない）。
    - custody_replay と custody_replay_caravans は、その file の中だけの `World`（in-memory の map）を使う。
    - rights_replay は `verify_core::world::World::parse` を使う。
  - c260c438 で流した同じ対象にも、この監査が当てはまる。
- 実行（`cargo test --locked --offline`。target は c260 のものを使い回した）：lib 55、custody 6、custody_history 9、custody_replay 14、custody_replay_caravans 13、custody_state 7、rights_replay 19。**123/123**、exit 0（`logs/phase22/verify-02be.txt`）。
- **見つけた点（低い）：account の並びが短い記録を FAIL にする**
  - `provinces: c.accounts.get(first..).unwrap_or_default()` のため、path Province の account が並びに無いと空になる。
  - send_route は、Season の有無を確かめる**前に**、`wrong("it lists no path Province")` を返す。
  - ⑯ の probe（`probes/v16_v26_short_accounts.rs.part`。⑯ の worktree の試験 file に一時的に足して流し、元に戻した。`logs/phase22/v16-short-accounts-02be.txt`）で、DepositLot・ShipLot・WithdrawLot のどれも次のとおりになった:
    - 完全な並び：Partial（Season が input に無い）。
    - path Province を外した並び：**Mismatch「landed, but it lists no path Province」**。
    - vault より前で切った並び：Unreplayed「the instruction lacks its accounts」。
  - program（`permutation-frontier/src/proc/custody.rs` 428 行の `send`、574 行の holding の分岐）は、path Province の無い送り出しを `TooManyAccounts` で拒否する。したがって、landed した送り出しには必ず path Province がある。
    - ④ のメモにある「program は Province なしの 0 歩も受け付ける」は、この code と食い違う。
  - path Province の無い記録は「account が欠けた入力」なので、同じ file の慣例（account が欠ければ UNVERIFIABLE）に合わせるのがよい。
  - 案：`get(first..)` が None か空のときは Partial「the instruction lacks its path Province accounts」にする。どうするかは ⑩ の判断。
  - 実害：landed した本物の記録では起きない。切れた記録や偽の記録で、UNVERIFIABLE の代わりに FAIL になるだけ。

### 27.11 ④ 5045fe3d → 0dd37253 → 6de240aa：review の digest、V26 の修正、⑦ の fail-closed の guard

- 対象：`6de240aa4e8c6d0ce4732fe9c63d9b5bdb9a7e99`（tree `6115eac21df58c5a16ce8527f0b0438319ce2bae`）。02be5f41 の上に次の 3 つ:
  - `5045fe3d`（tree `21d7c76e…`）：scan に review の digest を入れた。
  - `0dd37253`（tree `7fe5ddb6…`）：⑩ `995bfe3ccd1b97ab41ab2a9718c36afc69a68b06`（0007）の cherry-pick。差分は⑩と**同じ**。
  - `6de240aa`：⑦ `84251e5a…`（tree `c2e576ef…`）の merge。`permutation-gateway/screens` と `permutation-server/web` は 84251e5a と**一致**。
- **V26（0007）**：
  - path Province が無いと、`wrong` の代わりに `missing`（Partial）になった。
  - ⑯ の probe で、DepositLot・ShipLot・WithdrawLot のどれも「not judged: the instruction lists no path Province」になった。§27.10 の点は直った。
  - custody_replay_caravans は 13 件に ⑯ の probe 1 件を足して 14/14（`logs/phase22/v16-short-accounts-6de2.txt`）。試験 file は元に戻した。
  - 「0 歩の例外は無い」という ⑩ の訂正は、⑯ が読んだ custody.rs:428 と一致する。
- **scan の review の digest（5045fe3d）**：
  - `--check` は exit 0（119/205/23/8）。fixture の試験は 6/6。
  - ⑯ の fixture を、`--digest` で正しい digest を付ける形に直して流した（`logs/phase22/scan-stale-review-6de2.txt`）:
    - S0（review したまま）は通る。
    - S1・S2・S3（鍵の呼び出しを足す）と S4（comment）は、exit 5「stale review」。
    - C0（entry が無い）は list に載る。
  - 実際の list は、流す前と byte まで同じ。
  - 8 件の entry の閉包には、bare の package import が無い（node_modules の外の code が digest から漏れない）。
  - **残る限界（低い）**：connect-live の `load(WS03_ROOT, …)` と `load(WS04_ROOT, …)` は、環境変数が指す**別の tree** から、実行のときに読む。
    - digest が固定するのは、この repo の中の同じ path の file だけ。違う commit の ③・④ を指せば、review していない code が動く。
    - CI では環境変数が無いので skip される（試験の 33 行）。
    - 案：WS03_ROOT と WS04_ROOT が repo の root でなければ、読む前に target の digest を確かめるか、skip する。または、review はこの repo の root を指すときだけ有効と、理由の文に書く。RUNEXEC_BIN（Rust）も同じ。
- **⑦ の guard（84251e5a）の静的な読み**:
  - ws07-guard は、10 個の sentinel（配る session.mjs の末尾、2 つの関数の本体、subtle の 6 つの method、Worker）を、呼び出しなしに source の text で確かめる。
  - 一つでも外れれば何も呼ばずに止まり、page の中でも呼ぶ前に確かめ直す。wallet の 2 つの sign も、source を確かめてから呼ぶ。
  - 陰性の試験は、guard 無しで 10 件、route の無い init で 3 件の sentinel が外れることを示し、そのときの記録は空。
  - NK.init は Worker と SharedWorker の生成を拒否し、記録する。
  - G1（fail-open）と G2（Worker の生成）は直った。Worker の realm の中の guard は無いまま（seal を押す試験は無い）。
  - ⑯ は ws07-guard を流していない（④ の 2/2 だけがある）。
- ⑯ の独立の実行：6de240aa の ws07-march を、full Chromium と repo の `no-keys-guard` の下で流し、**2/2**（desktop・phone）。`logs/phase22/ws07-march-6de2.txt`。
  - 届いた範囲は、§27.4 と同じく封印前の order の作成まで。seal・署名・送信・march の成功の証拠にはしない。

## 28. この pass の最終 checkpoint：④ 55d5c2da

### 28.1 対象と、55d5c2da で独立に確かめた範囲

- **checkpoint**：④ `claude/gallant-ride-cunptv` @ `55d5c2daa22b0ce63e6ad02c6ee5e607bbfd2255`（tree `40f00de6a9c2a9e63ec4549457e2f8889679b561`）。基準は引き続き `16576826084a8ea7bd6b12b845d50b97f3d14904`（tree `7f6ff8b0…`）。
- 55d5c2da は 6de240aa からの fast-forward で、⑦ の 1 commit。変わったのは 4 file:
  - `screens/server.mjs`
  - `screens/ws07-wide.screen.mjs`（新規）
  - `screens/ws07/wide-stage.mjs`（新規）
  - INTEGRATION.ja.md
- 次のものは 6de240aa と同じ tree:
  - frontier-node、scripts/ci、workstreams/06-creation、workstreams/12-memory
  - nokey-page.mjs、ws07-guard.screen.mjs、world.mjs、permutation-server/web
  - したがって、§27.7〜27.11 の custody・scan・⑫・⑥・guard の結果は、そのまま当てはまる。
- 55d5 の限られた差分の監査:
  - `meWith` は、試験が設定したときだけ /h/me を書き換える。設定しなければ、world.mjs の答えそのまま。
  - wide-stage・fwide.mjs・map/wide.mjs の閉包（world.mjs を除く）に、鍵の API はない。world.mjs の keyFromSeed は、keyless の viewer では呼ばれない（§27.4）。
  - wide holding の address は `withSeed(season, seed, program)` で、公開の with-seed 計算だけを使う。
- ⑯ の実行：ws07-wide を、full Chromium と repo の no-keys-guard の下で流し、**3/3**（`logs/phase22/ws07-wide-55d5.txt`）:
  - 既定の stage が byte まで同じこと（sha256 `8e00cf59…`。未設定のとき、設定して外したとき）。
  - desktop と phone で、wide village を選ぶ、保つ、戻る、戻る・進む、reload、別の world の拒否。
  - 範囲は表示だけ。herald の wide index、捕獲の通貨、chain は含まない。

### 28.2 この pass で直り、⑯ が独立に確かめたもの

| 項目 | 直した版 | ⑯ の確認 |
|---|---|---|
| ⑥ の journal の lock の競合（J1〜J5、⑥ の R1・R2） | ⑥ 5f74a270（④ 82ddc29f） | J1〜J5 は拒否される（695e・§27.3） |
| ⑫ の二度の crash で journal が開けない | ⑫ a7ac51b7（④ 64960c1e） | 二度の crash：123,219 回で 0。三度の crash：401,837 回で 0。損傷は拒否される。対照で検出できる（§27.7） |
| scan が spawn や計算した import をたどれない | ④ bb41fc0d | 2 件が載った（§27.8） |
| review が古くなっても有効なまま | ④ 5045fe3d | S0 は通り、S1〜S4 は exit 5（§27.11） |
| V26 が path Province の無い記録を FAIL にする | ⑩ 995bfe3c（④ 0dd37253） | Partial になる（§27.11） |
| ⑦ G1（installed proof の fail-open）・G2（Worker の生成） | ⑦ 84251e5a（④ 6de240aa） | 静的に読んだ。ws07-guard は ⑯ は流していない。march は 2/2 |

### 28.3 合意した運用の限界（**直してはいない**。別枠で記録する）

- **⑥ J7**：生きている持ち主の `.lock` や `.takeover` が、手順の外で消されたり置き換えられたりすると、古い書き込みが 1 回通りうる。
  - ⑥ の §8.3 に、制約（外から消さない、自動で掃除されるディレクトリに置かない）として書いた。
  - 塞ぐには、カーネルの lock か、条件付きで書ける保存先が要る。持ち主は、新しい native の依存を入れないと決めた。
  - J6 は手順の中では起きない。注入した `alive` でだけ届く。
- **review の digest の範囲**：digest が固定するのは、この repo の中の JS の閉包と `targets=` だけ。
  - connect-live が実行のときに `WS03_ROOT` と `WS04_ROOT` から読む**外の tree**、試験が spawn する **Rust の binary**（`RUNEXEC_BIN`）は、digest の外にある。
  - **今回の実行を監査した証拠**（過去の、特定の実行についてのもの）:
    - ⑯ は 4d44f021 で、WS03_ROOT と WS04_ROOT を候補の tree そのものにして connect-live を流した（§25.3）。
    - その runexec は ⑯ が a33e3b0a から build したもの（sha256 `4cb6634d…`）。ws04 の Rust の source には、鍵の API の呼び出しが無い（comment だけ）。
    - 55d5 では、ws04 の subtree は同じ a33e3b0a。connect-live の閉包（98 file）のうち、4d44f021 から変わったのは `06-creation/src/connect/dispatch.mjs` の 1 つだけで、⑯ が監査して probe も流した。
    - ④ の 55d5 での実行が、どの root と binary を使ったかは、⑯ は確かめていない。
  - **将来の保証**：無い。別の root や別の binary を指せば、review していない code が動く。CI では環境変数が無く、skip される。
- **Worker の realm**：page の中の guard は、Worker の**中**を守らない。Worker の生成は拒否し、記録する。seal を押す試験が無いので、今は届かない。

### 28.4 未解決のもの（実害の可能性があるものだけ）

- この pass の範囲で、実害が確かめられた未解決の欠陥は**ない**。
- 説明できていないもの：③ の integration「③ and ⑤ on one agent…」が 4d44f021 で 1 回だけ失敗した（`r3.state` が undefined）。その後の 9 回と基準の 5 回では再現しない。原因は分かっておらず、閉じていない。

### 28.5 確かめていないもの（欠陥ではなく、証拠の範囲）

- 封印・署名・送信・chain への着地・march の成功。鍵を使う interaction の実行。
- 保守的に除外している試験（src を通る 205 件、unfollowed の 23 件。今回、除外を解いてはいない）。⑬ の ws12-* の試験。⑫ の allocation の経路。
- ②・⑨・⑱・⑲・⑳ の Rust の試験の一括（④ の結果だけ）。ws07-guard（④ の結果だけ）。
- ⑯ の web key hook が registerHooks と合わずに結論の出なかった gateway の 37 件。

### 28.6 ⑯ 自身の手順の誤り

- `71713b34` での広い `git add -f`：61 件を誤って公開した。§27.9 で監査し、秘密も賞品の素材も無いと判断した。追跡は外したが、履歴には残っている。
- それ以降は、明示した path だけを stage している。

**結論**：55d5c2da を、この pass の checkpoint とすることを ④ に提案する。全機能の完成を意味しない。上の限界と、確かめていないものが残る。

### 28.7 ④ 95b0ab22（最終 HEAD）と、16576826 以降の各後継についての判定

- **最終 checkpoint**：④ `claude/gallant-ride-cunptv` @ `95b0ab225ca9e9e626941b51981df2240198d91c`（tree `89a64830da399101530eef3e004b81d5007d2203`）。55d5c2da からの fast-forward で、変わったのは `scripts/ci/node-keyfree.sh` だけ（+19 行）。
- 静的監査:
  - 新しい確認は、`cd` と `node --test` より前で行われる。拒否されれば、何も実行されない。
  - `^WS[0-9]+_[A-Z0-9_]*ROOT$` は、試験が読む code の root の変数をすべて覆う（WS03_ROOT、WS04_ROOT、WS05_ROOT、WS03_GATEWAY_ROOT。分割代入での読み込みも grep した）。
  - binary の変数は RUNEXEC_BIN と RUNEXEC_VIEW_BIN の 2 つで、それ以外に binary を指す変数は無い。
  - symlink は `pwd -P` で解決される。
- 無害な fixture での確かめ。どの場合も、glob はどの file にも当たらないので、試験は一つも動かない:

| 入力 | 結果 |
|---|---|
| 外のディレクトリを指す WS04_ROOT | exit 6 |
| この checkout への symlink の WS04_ROOT | 通る（0 件で exit 0） |
| WS03_GATEWAY_ROOT=/tmp | exit 6 |
| `/bin/sh` の小さな script を RUNEXEC_BIN にし、sha を付けない | exit 6 |
| 同じく、間違った sha を付ける | exit 6 |
| 同じく、正しい sha を付ける | 通る（0 件） |
| 何も設定しない | 0 件で、`node --test` を起動しない |

- **限界（将来の保証と、今回の証拠を分けて書く）**:
  - `_SHA256` が確かめるのは、bytes が名指しされたものと同じことだけ。「この checkout の監査済みの source から build した」というのは、運用者の申告。check と実行の間で file が入れ替わることも防がない。
  - ④ の build（`f039854a…`、16576826 から）は、⑯ は bytes を見ていない。
  - ⑯ が確かめたのは次のことだけ:
    - ws04 の source が 16576826 から 95b0 まで `a33e3b0a` のまま変わらないこと。
    - その Rust の source に、鍵の API の呼び出しが無いこと（comment だけ）。
    - ⑯ 自身の build（sha256 `4cb6634d…`）の由来。
  - 外の tree を手で監査して流すことは、この script では覆えない。
- これまで判定を記録していなかった 3 つの commit を、静的に確かめた:
  - `eb700a8a`：06-creation が ⑥ 11be9d44 と一致。
  - `d3b89ede`：keeper の api・journal・lib・play.rs が ⑱ b55f64a4 と一致。play.rs は a7bc0d01 から clone_on_copy の 1 token だけ違う。
  - `3e617b28`：v27_residents.rs が、16576826 に ⑪ patch 0017（d58e9de2）を当てたものと同じ blob（`59d49126…`）。この file は 95b0 まで変わらず、⑯ が 02be5f41 で流した lib の v27 の unit test 7 件が、この版で通っている。

16576826 以降の各後継についての判定:

| 後継 | ⑯ の判定 | 記録 |
|---|---|---|
| 0541478f、7e820189、d35604d6、4d44f021 | 4d44f021 でまとめて確かめた。各 directory は元の担当と一致し、影響する試験を流した。⑥ の J1〜J3 を見つけた | §25 |
| 9781d04e、42b1f393、720ab60b、5133f3c7、7d25f1eb、8d8e8c18、387721c2、83e10889、6875228d、7c7fe932 | 7c7fe932 でまとめて確かめた。⑫ の torn marker の欠陥（のちに直った）、scan の監査、hook での実行 | §26 |
| d83a9707、c260c438 | verify の lib・custody・rights：128/128 | §27.5 |
| eb700a8a、d3b89ede、3e617b28 | 静的な一致（上）。keeper の試験は流していない | §28.7 |
| 82ddc29f、4b3b399e、695e1d83 | 一致。⑥ の J1〜J7 を再実行。⑫ の二度の crash の欠陥を見つけた（のちに直った） | §27.1〜27.3 |
| a23f02bb、11bc9698 | ⑦ の guard の監査、march 2/2。scan の見落とし 2 件（のちに直った） | §27.4、27.6 |
| 64960c1e、bb41fc0d、d415e013 | ⑫ の修正を確認。review が古くなる問題（のちに直った）。⑦ は表示だけ | §27.7、27.8 |
| 02be5f41 | verify 123/123。account の並びが短い記録を FAIL にする（のちに直った） | §27.10 |
| 5045fe3d、0dd37253、6de240aa | digest は成り立つ。V26 は Partial。⑦ は fail-closed。march 2/2 | §27.11 |
| 55d5c2da | ws07-wide 3/3、差分の監査 | §28.1 |
| 95b0ab22 | 上の静的監査と fixture | §28.7 |

- commit の単位で、確かめていない後継は無い。ただし、§28.5 に挙げたもの（keeper と Rust の一括、ws07-guard ほか）は、⑯ は流していない。
- 未解決のまま記録に残すもの:
  - ③ の 1 回だけ再現しない失敗。
  - ⑯ の hook と合わなかった gateway の 37 件（inconclusive）。
  - どちらも ④ の §17 にも残すよう求める。

**結論**：95b0ab22 を、この bounded pass の最終 checkpoint とすることに同意する。§28.3 の運用の限界と、§28.5 の確かめていないものを条件とする。全機能の完成を意味しない。

### 28.8 ④ との合意（最終）

- ④ は、checkpoint `95b0ab225ca9e9e626941b51981df2240198d91c`（tree `89a64830…`）を確認した。
  - ④ の INTEGRATION §17 は、`review/ws04-docs-handoff-20261108` の `b7c0806454336e42335512fe9e07cb47e4b74ee0` で直された。⑯ が 55d5c2da（§28.1）と 95b0ab22（§28.7）を確かめたこと、⑯ が挙げた限界が書かれている。
  - ③ の 1 回だけの失敗、⑯ の hook での gateway の 37 件、⑯ の 71713b34 の手順の誤りも、§17 に残っている。
- **④ の申告**（⑯ は確かめていない。④ の言明として記録する）:
  - ⑥ の connect-live・ports・dispatch・connect・intake のどの run でも、WS03_ROOT と WS04_ROOT は候補の tree そのものだった。
  - RUNEXEC_BIN は、16576826 から build した debug の runexec（sha256 `f039854aaaad26d141201f9e1066eacf4be11e69f0c2f1e6365ad0bd3d76819b`）だった。
  - ⑯ が確かめられるのは、ws04 の source が 16576826 から 95b0 まで `a33e3b0a` のまま変わらないことまで。その binary の bytes は見ていない。
- 結論は §28.7 のまま。この bounded pass の checkpoint であって、全機能の完成ではない。

# 第23期（2026-11-09）：「gateway の 37 件 inconclusive」の再調査

checkpoint の `95b0ab225ca9e9e626941b51981df2240198d91c`（tree `89a64830da399101530eef3e004b81d5007d2203`）は、区切りとしてそのまま保つ。基準は 16576826 のまま。

## 29.1 37 件とは何か（訂正を含む）

- 前の記録（§26.3、§28.4）の「37 file」は**誤り**。37 は失敗した**件**で、内訳は次のとおり（件ごとの一覧は `logs/phase23/hook37-list.txt`）:
  - 14 個の file 全体（ERR_TEST_FAILURE）。
  - ほかの 7 file の中の 23 件の subtest。
  - 合わせて 21 file になる。
- その run は 7c7fe932 で、`NODE_OPTIONS="--import v16-web-key-hook.mjs"` を付けて `node-keyfree.sh permutation-gateway` を流したもの。hook の記録は 0 件だった。

| 95b0 での scan の区分 | 件数 | 見えた誤り |
|---|---|---|
| RUNNABLE（鍵の閉包なし） | 4 file | file ごとの失敗（ERR_TEST_FAILURE） |
| unfollowed（子 process） | 4 件 | ERR_ACCESS_DENIED |
| via-src（閉包が鍵の API の名前に届く） | 16 件 | `request for './max.js' is from a module not been linked` |
| via-src | 10 file | file ごとの失敗 |
| via-src | 3 件 | 判定の失敗（下の 29.2） |

## 29.2 原因の切り分け

- **誤った runner 条件（⑯ の道具）**。直接の証拠がある:
  - Node 22.22 で `registerHooks` に同期の `load` を登録しただけで、`@solana/web3.js` → jayson → uuid の ESM の require が link に失敗する。
    - 鍵を使わない `import('@solana/web3.js')` だけで再現した（v1 では失敗、v2 では読み込める。`logs/phase23/hook2-proof.txt`）。
  - hook を `NODE_OPTIONS` で渡したため、試験が permission model の下で起動する子 process にも hook が入った。その file が読めずに ERR_ACCESS_DENIED になった（4 件）。
  - 判定の失敗 2 件は、子 process がこの link error で落ちたもの:
    - 「forbidden ports」は、実際の値が link error の文だった。
    - 「a real start without the other units」は、終了 code が 2 ではなく 1 だった。
- **同じ code は、hook なしでは通っている**:
  - 7535a17e と 20db3313 の gateway の src、これらの試験 file、package-lock は、7c7fe932 と同じ blob。
  - その版での hook なしの key-free の run は 1908/1908（`logs-v27`）で、37 件は失敗しなかった。
- **仕組みを観測できていないもの（1 件）**：`frontier-relay-resume`「resume rejects malformed budget … while accepting valid records」。
  - v1 の run では、正しい faucet の記録が「invalid」とされた（`new PublicKey(...)` が try の中で throw したと推定）。
  - ⑯ の純粋な関数の probe（`probes/v16-gw-relay-records.mjs`。fixture も seed も鍵も使わず、validateRelayRecords だけを呼ぶ）では、hook なし・v2・v1 のどれでも、正しい記録は通り、13 個の変形はすべて拒否された（`logs/phase23/relay-records.txt`）。
  - 単独では再現しないので、v1 の hook と試験 process の状態の組み合わせによるものと見る。実際の欠陥の証拠は無い。
- race と実際の欠陥：37 件のどれにも、証拠は無い。

## 29.3 再調査（key-free に流せるものだけ）

- ⑯ の hook v2（`scripts/v16-web-key-hook2.mjs`、loader `-loader.mjs`）:
  - `module.register`（別の thread で動く async の hook）を使うので、`require` には触れない。
  - `--import` だけで渡し、NODE_OPTIONS は使わない。
  - 入ったことの証明は source の text だけで行う（`v16-web-key-hook2-proof.mjs`）。v2 では入っており、無い場合は 6 件が欠けると出る。
  - `node --test` の子 process でも有効なことを、source の text だけを見る試験で示した（hook なしの対照は失敗する）。
  - v1 の対照の script（`v16-web-key-hook-control.mjs`）は鍵の関数を呼ぶ形（fail-open）なので、使わない。
- **RUNNABLE の 4 file**（agent-wallet-bench、agent-wallet-s1、frontier-resident、frontier-s1-relay）:
  - 静的監査：閉包は 20〜30 file。PAT の hit は無い。spawn、計算した import、Keypair、鍵の入口の名前も無い。web3.js からは PublicKey・Connection・Transaction・定数だけを import する。
  - `scan --covers` が通り、list に載っていない。
  - repo の guard と hook v2 の下で、**22/22**。hook の記録は 0 件（`logs/phase23/gw4-hook2.txt`）。
- **残り 17 file**（via-src 14、unfollowed 3）は、95b0 の scan の保守的な除外なので、**流していない**。
  - 不変条件のうち、純粋な関数で確かめられたのは、frontier-relay-resume の validateRelayRecords だけ（上）。
  - そのほかの子 process や permission model の試験（citizens-run-check、seat-live-run、memory/audit-permission、mind-server ほか）は、fixture が runner の起動や seed のファイルを伴うので、⑯ の probe では置き換えていない。

## 29.4 結論

- 37 件は、⑯ の v1 hook の runner 条件によるもので、候補の欠陥ではない。根拠は、link error の再現、NODE_OPTIONS が子 process に伝わったこと、同じ code が hook なしで 1908/1908 だったこと。
- 1 件（relay-resume）だけは仕組みを観測できていないが、純粋な関数で不変条件を確かめた。
- ④ に渡す修正は無い。⑯ の道具の側の問題で、node-keyfree.sh は `--import` で guard を渡しており、NODE_OPTIONS を使わない。
- ③ の 1 回だけの失敗：③ が主担当で調べている。③ の新しい commit は、まだ無い（`838338be` のまま）。
  - ⑯ は、失敗した run の記録（`logs/phase23/s03-one-off-failure-4d44.txt`）を ③ に渡した。期待は `['accepted', true, 'real']`、実際は `[undefined, true, 'real']`、integration.test.mjs の 85 行。
  - ⑯ は、独自の修正はしない。

## 29.5 ③ の 1 回だけの失敗：③・④ の調査と、⑯ の独立のレビュー

- ⑯ の run の条件（③ と ④ に送った）:
  - 2026-11-08T17:44:00Z。foreground で約 3.1 秒。NODE_OPTIONS は無い。
  - WS03_GATEWAY_ROOT=`<4d44f021 の tree>/permutation-gateway`。WS04_ROOT と WS05_ROOT は、どちらも 4d44f021 の tree。
  - RUNEXEC_BIN は、⑯ が a33e3b0a から build したもの（sha256 `4cb6634d…`）。run-guarded.sh はそのまま使った。
  - 4 vCPU。⑯ のほかの job は無かった（最後の job は 16:32Z に終わっていた）。並列に動いていたのは、node --test が file ごとに並べたものだけ。
- **③ `d4b22c971d5e16e1e17dbe593bfa5790e9816ca5`**（③ の dir の tree `7cf99188…`、親 838338be）。変わったのは試験と文書だけ:
  - harness の `openRunStore`（store を setup で 1 回開く）。
  - integration と run に、それを 1 行ずつ足した。
  - mock の `registry-busy.test.mjs`。
  - 再現の script。
- ⑯ の確認:
  - 候補の ③ の dir（838338be と一致する）に ③ の 6 file を重ね、89232fad の build を使って run-guarded.sh を流した。**33/33 を 3 回**。
  - registry-busy は、registry の最初の StoreError で何も送らずに RunRegistryUnavailable を返し、再試行では 1 回だけ登録して 1 回だけ送ることを確かめる。
  - 元の失敗の形（`[undefined, true, 'real']`：r3 の state が無い）は、registry が StoreError を返したときの ③ の答えと合う。ただし、ログが無いので因果は確かめられない（③・④ と同じ結論）。
  - 注意：③ の setup が store を先に開くので、③ の試験は ④ の cold open の修正が後で退行しても気づかない。退行の検知は、④ の `store_cold_open` に任せることになる。
- **④ `89232fad1b648750fa63026a80902d1c0926bc07`**（tree `0301f85e0e0ab7ad8d58eac1c60caf475fe00524`、95b0 からの 1 commit）。`store.rs` の `wal()` は、`PRAGMA journal_mode=WAL` だけを、SQLITE_BUSY のときに 10 秒の予算の中で 5 ms ごとに再試行する。ほかの誤り、SQLite が返す mode を見ないことは、前のまま。
  - 静的監査：runexec の依存に鍵も HTTP も無い。concurrency の試験は Sim だけで、passnode を使わない。store_cold_open は SQLite の一時 file だけ。
  - ⑯ の build：sha256 `3438c7d0…`（④ の `72740db3…` とは build の環境が違う）。
  - 結果（`logs/phase23/ws04-89232fad.txt`）:
    - lib 2/2、store_cold_open 2/2。
    - ③ の再現（2 process × 200 回）：**古い binary は 400 回中 42 回失敗**（"database is locked"）、**新しい binary は 0 回**。
    - concurrency：最初の 1 回だけ `cancels_race_executors` が「the race was not exercised」で失敗した（cancelled 0、fulfilled 36）。その後の 8 回は 8/8 で、cancelled は 11〜17。
      - 古い ws04（a33e3b0a）でも 6 回とも 8/8 で、cancelled は 9〜16。
      - 分布が同じなので、この修正のせいではない。競合が起きたことを要求する試験が、その run で競合を起こせなかった（試験の時間依存）と見る。
      - 実際の欠陥ではなく、試験の設計の問題として ④ に伝える。
- **⑦ `9b547d9d6daf68447dca3a6ba731f710df497bc1`**（親 95b0）。drawer.mjs の viewerState に 5 行足した。
  - ⑯ の純粋な関数の probe（`probes/v16-ws07-viewer-state.mjs`。drawer.mjs の閉包には封印用の noble の BLS があるが、読み込むだけで呼ばない。repo の guard の下で流した）。結果（`logs/phase23/ws07-9b547d9d-viewer-state.txt`）:
    - 最初の read が失敗した場合：古い版は known で join が開いた（⑦ の言う不具合）。新しい版は unreachable で join は閉じる。
    - **⑦ の問いへの答え**：NotFound（not joined が分かった）の後で、refresh が失敗した場合。
      - applyMeResult の error は citizen と holdings を残すので、citizen は null、holdings は空のまま、meStatus は 'error' になる。
      - 新しい版では unreachable になり、join は閉じる。古い版では known で、join は開いていた。
      - つまり、前の read で「not joined」が分かっていても、一時的な失敗で join の流れが閉じる。次の refresh（controller 1847 行）が成功するまで閉じたまま。
      - Citizen を知っている場合は known のままなので、扱いが非対称。
    - ただし、他の端末から参加したかもしれないので、閉じるほうが安全側とも言える。欠陥ではなく、⑦ が決めること（表示の判断で、game の規則ではない）として伝える。

## 29.6 ④ の後続 490407d8 → 8afe8426 → dc9974e2 → f2e63ff2、③ a24d6dbb、⑦ 08928ea5 / c4eae408

- ④ `f2e63ff2298cfa03149356ce8b5390934c83717c`（tree `7372d19bc7fb6a80057c864888b5470c356993ca`）。89232fad の上の commit:
  - `490407d8`：⑦ 9b547d9d の 3 file と一致（§29.5 で確かめたもの）。
  - `8afe8426`：③ の dir が ③ d4b22c97 と一致。`node-key-tests.txt` の変更は、registry-busy.test.mjs を via-src に 1 行足しただけ。
  - `dc9974e2`：⑦ 08928ea5 の onboarding・ws07-read・first-village-ui と一致。
  - `f2e63ff2`：passnode.rs に型の別名を 1 つ足しただけ。型は同じで、動作は変わらない。ws04 の src は 89232fad と一致。
  - scan の `--check` は exit 0（119 / 206 / 23 / 8）。
- **③ `a24d6dbbcef67a6321bd9abc009fe15aa9b440f1`**（③ の dir の tree `76322139…`）。`cold-open.test.mjs` は、③ と ⑤ の同時の最初の open を、SQLite の lock を握ることで強制する（時間に頼らない）。
  - ⑯ は、89232fad に ③ の dir を重ねて流した（`logs/phase23/s03-ws07-f2e6.txt`）:
    - 古い runexec（4cb6634d）：3 回とも 2/2。旧 setup の場合に、元の失敗の値 `[undefined, true, 'real']`、RunRegistryUnavailable、送信 0 が毎回再現する。
    - 新しい runexec（89232fad）：3 回とも 2/2。毎回「the cold-open race is fixed」の診断が出て、登録は他方の open を待って通る。
  - **結論**：仕組みは確かめられた。古い binary で値まで再現し、④ の修正で消える。4d44f021 の元の run がこの順序だったことそのものは、ログが無いので確かめられない（③・④ と同じ）。
- **⑦ 08928ea5 / c4eae408**（村の province が読めないとき、guide は Muster や Train を勧めない。hosts の画面は「記録をまだ読み込めていません」と出す）。⑦ の問いへの答え（静的な読みと、純粋な関数の probe `probes/v16-ws07-unread-guide.mjs`）:
  - **ずっと止まったままになる正当な状態はあるか**：見つからない。
    - web の code で `FS.provinces` に対して行うのは set だけで、delete・clear・追い出しは無い。
    - `refresh()` は、/h/me が読めた poll のたびに、すべての holding の province を `loadEnvelope` で読み直す（`wantProvince` の 12 件の上限は通らない）。poll は 30 秒ごとで、誤りのたびに倍、最長 5 分。
    - したがって guard は、次に province が読めたときに外れる。外れないのは、/h/province（または /h/me）が失敗し続けている間だけで、そのときは本当に読めていない。
    - 注意：/h/me が失敗すると、`refresh()` はその場で戻るので、province は読み直されない。その間は、drawer も unreachable なので、表示は食い違わない。
  - **marchObjective にも同じ guard が要るか**：province が読めないとき、hostRows は空なので、marchObjective は `{tab:'holding'}`「村で兵を準備する」を返す（probe で確認）。
    - 村の画面の Train は、`actionBlocks` が resident の操作（Muster、Garrison、Depart など）しか止めないので、province が読めなくても押せる。
    - つまり、軍勢があるかもしれないのに、訓練を勧めて村へ案内する。重複した命令ではないが、資源を使う方向へ誤って導く。
    - 同じ「読み込んでいます」の扱いにするのがよい。どうするかは ⑦ が決める（表示の判断）。
  - ⑯ は ⑦ の画面と unit の試験を流していない（④ と ⑦ の結果がある）。

## 29.7 ④ b9a4c0a2 → b381c2bb → 1398f44c

- ④ `1398f44c199c4aa530ab184ca2cf18ba292514f1`（tree `90d60003c52dfe4f2d7d0d092be3cc11e695f79c`）。f2e63ff2 の上の commit:
  - `b9a4c0a2`（tree `4333da14…`）：③ の dir が ③ a24d6dbb と一致（§29.6 で流したもの）。cold-open.test.mjs は via-src に載った。
  - `b381c2bb`：⑦ c4eae408 の merge。host.mjs・onboarding.mjs・ws07-read・ws07-unread が c4eae408 と一致（§29.6 の probe は c4eae408 で流した）。
  - `1398f44c`：ws07-unread.test.mjs を via-src に載せた。③ の dir は ③ c029948a（a24d6dbb に doc 24 を 18 行足しただけ）と一致。
  - scan の `--check` は exit 0（119 / 208 / 23 / 8）。
- **④ の記述への同意**：「仕組みは決まった形で再現し、観測した値のすべてと合い、89232fad で直った。古い版と新しい版の両方の証拠がある。4d44f021 の 1 回の run がまさにこの順序だったことは、r3 が出力されていないので確かめられていない」に**同意する**。⑯ の独立の run（§29.5、§29.6）とも合う。
- 補足（試験の性質）：cold-open.test.mjs の試験 1 は、古い形の失敗も、「直った」という分岐も、どちらも pass にする。
  - したがって、④ の修正が退行して古い形に戻っても、赤くはならない（分岐の診断が消えるだけ）。
  - 退行を赤で捕まえるのは、④ の `store_cold_open` だけになる。③ はこの形で変更しないとした。⑯ は、これを限界として記録する。
- ⑦ の marchObjective（§29.6）は、c4eae408 のまま変わっていない（⑦ の判断を待つ）。

## 29.8 ⑦ a8c9eccb（`FS.meAnswered`）の独立のレビュー（静的な読み）

- 対象：⑦ `a8c9eccb6ddc8fa9a469488386cc3a3bdd409ae6`（tree `47bbfbdffd6ce6c585cef6653b30974388e3dbed`、親 c4eae408）。⑯ が §29.5 で挙げた「NotFound の後で refresh が失敗すると、join の流れが閉じる」に対する修正。
  - meAnswered は、applyMeResult の 2 つの答えの分岐（found、NotFound）でだけ true になる。
  - false に戻るのは、resetViewer、useHerald、page の読み込み直し。
  - drawer の viewerState は、`meStatus==='error' && !meAnswered && Citizen も村も無い` のときだけ unreachable を返す。
- **(a) resetViewer と useHerald を通らずに viewer を変える経路はあるか**：見つからない。
  - FS.wallet、FS.resident、FS.citizen を代入するのは controller だけ。wallet の切り替えも NFT の切り替えも resetViewer を通る（controller 146・547〜560）。
  - herald を換えるのは useHerald だけで、startPlay（2123）と app.mjs:3595 から呼ばれる。season の pin は startPlay で決まる。
  - 代入はあるが、viewer の変更ではないもの:
    - 318 行：actOnce が、同じ wallet が持つ同じ NFT の generation を、送る直前に読み直す。Citizen は FS.resident.citizen のまま。
    - 1462 行：refreshOverviews が、同じ herald の season record で FS.season を置き換える。
- **(b) 「not joined」を失敗の後も保つと、Join を出すべきでないときに出せるか**：**出せる（低い）**。
  - ⑦ が挙げた確認（instantHome の 1215、waitForOwn の 1265、confirmHome の 1301）は、instant home の流れのもの。
  - 通常の `join` の action（1907〜1925 行）と、prize の季節の `paidJoin`（x402 の入場料と Join を 1 つの transaction で送る）は、meStatus を確かめずに、session を導出し、Join を送る。`act()` も meStatus を見ない。
  - したがって、「NotFound の後で refresh が失敗した」状態（meStatus が error、meAnswered が true）では、join の流れが開いたまま Join を送れる。
  - これは 95b0 の振る舞いに戻ったもので、16576826 から退行したわけではない。
  - 起こりうること：他の端末から既に参加していれば、program が Join を拒否する（Citizen がすでにある）。paidJoin は 1 つの transaction なので、入場料だけが引かれることはないと見るが、⑯ は program の側を確かめていない。
  - 案（最小）：`join` と `paidJoin` の前に、confirmHome と同じ確認を入れる（`if (FS.meStatus !== 'ready') { await refresh(); if (FS.meStatus !== 'ready') return; }`）。表示（nation choice を残すこと）はそのままにできる。
- ⑯ は ⑦ の試験を流していない。⑦ の 6/6、174/174、ws07-read の 6/6 は、⑦ の結果だけ。

## 29.9 ④ 883b4be6 → 8c53176a、⑦ 9cd15799、未決の項目

- ④ `8c53176a5d149d21f40ac3ad3b03c3a6f541c68b`（tree `13fb04244627d0176379d2b8fea08796e7b4f53c`）:
  - `883b4be6`：⑦ a8c9eccb の 6 file（controller・fstate・drawer・ws07-read・wave3-hud・ws07-me-answered）と一致。
  - `8c53176a`：ws07-me-answered.test.mjs を via-src に載せた。
  - scan の `--check` は exit 0（119 / 209 / 23 / 8）。
- ⑦ `9cd15799f58911ea5f10babfac202a2129247f00`（tree `5aeb18dc…`、親 a8c9eccb。④ にはまだ入っていない）。§29.6 の marchObjective への対応。
  - ⑯ の probe では、province が読めないとき、marchObjective は `{act:'guide-open'}`「記録を読み込んでいます…」を返し、村の tab へ案内しない（`logs/phase23/ws07-9cd15799-unread-guide.txt`）。§29.6 の点は直った。
- **未決のまま残すもの（⑯ の判断ではない）**:
  - §29.8 (b)：通常の `join` と `paidJoin` は meStatus を確かめずに送る。
    - ⑦ は「持ち主が、送信と署名の境界を変えないと決めた範囲の外」として、この round では変更しなかった。④ と利用者に、別の項目として渡した。
    - 16576826 から変わっていない振る舞い。paidJoin が入場料だけを引きうるかは、program の側で確かめていない。
  - concurrency の `cancels_race_executors` の非決定性。④ が別の commit で調べている。
- ④ の訂正（持ち主から）：③ の cold-open.test.mjs は、退行を止める門ではなく、再現と診断のためのもの。⑯ の §29.7 の補足と同じ。

## 29.10 paidJoin の入場料と Join は同じ atomic な transaction か（静的な事実の確認だけ。仕様は決めていない）

対象は ④ `8c53176a5d149d21f40ac3ad3b03c3a6f541c68b`。公開の source だけを読んだ。署名、keypair、実際の transaction、CI は使っていない。金額などの賞品の詳細は書かない。

用語：「ネットワークの手数料」は Solana の transaction fee（lamports）。「入場料」は、アプリの prize program の Pay が動かす token。

**確かめた事実**
1. **client（web/frontier/controller.mjs paidJoin、fprize.mjs、sdk/frontier/prize.mjs joinViaX402）**:
   - wallet の残高が入場料に足りないときは、先に `POST /f/faucet` を呼ぶ。
     - これは relay が自分で送る**別の transaction** で、localnet だけで動き、test token を渡す。
     - 後で Join が失敗しても、元には戻らない。ただし、これは渡すもので、取るものではない。
   - 次に `/f/x402/join` に 2 回 POST する。
     - 1 回目は 402 と価格を受け取るだけで、状態は変えない。
     - 2 回目は、client が `[CU の上限, price 0, loaded data の上限, Pay, Join]` を **1 つの message** として組み、wallet が 1 回署名して送る。
   - ネットワークの手数料を払うのは relay（`feePayer` は relay のもの）で、wallet ではない。
2. **relay（permutation-gateway/src/frontier/routes/prize.mjs `POST /f/x402/join`、routes/relay.mjs `sponsor`）**:
   - 受け付ける形は 2 つだけ:
     - `atomic`：`classifyPaidJoin` が、ちょうど上の 5 つの instruction の形を要求する。
     - `settled`：入場料を含まない通常の Join。この wallet の Entry がすでに `finalized` で存在し、その額が入場料以上のときだけ。
   - ⑯ の純粋な probe（`probes/v16-paid-join-shape.mjs`、`logs/phase23/paid-join-shape-8c53.txt`）では、SDK の paidJoinMessage は atomic として受け付けられた。次の形はすべて拒否された:
     - Pay だけ。
     - Join だけ（atomic としては拒否。settled の確認に回る）。
     - Join を Pay より前に置いたもの。
     - Pay を 2 回含むもの。
   - relay は、署名した**同じ bytes** を先に simulate する。simulate が失敗すれば送らないので、状態も手数料も動かない。
   - その後 `sendRawTransaction`（skipPreflight）で送り、結果を待つ。
   - atomic の AlreadyPaid は、finalized の確認のうえで 409（AlreadyJoined または AlreadyPaid）になる。
3. **program**:
   - game の Join（permutation-frontier/src/proc/citizen.rs、396 行のあたり）は、Citizen がすでにあれば `Err(AlreadyDone)` を返す。何もせずに成功する扱いにはならない。
   - prize の Pay（permutation-prize/src/lib.rs、577〜580 行）は、Entry がすでにあれば `Err(AlreadyPaid)` を返す。そうでなければ、同じ instruction の中で、token の移動（CPI）と Entry の作成を行う。
   - Solana の transaction は全体が atomic なので、atomic の形で Join が失敗すれば、同じ transaction の Pay の token の移動と Entry の作成（その rent を払うのは relay）も取り消される。
   - **結論**：relay の paidJoin（atomic）では、入場料だけが引かれて Join が無い状態は、source の上では起きない。
4. **ネットワークの手数料**:
   - simulate が通り、実行のときに失敗した場合（simulate と実行の間に状態が変わった場合）は、Solana の規則で、ネットワークの手数料は relay の fee payer から引かれる。wallet からではない。
   - relay はそれを、その wallet の quota（`moved`）に数える。入場料は動かない。

**確かめていないこと**
- program を実際に動かしての確認。SVM の試験は keypair を使うので流していない。Solana の atomicity が成り立つことは前提とした。
- relay を通さずに、wallet が自分で Pay だけを送る場合。program の Pay は単独でも呼べる。その場合は、入場料と Entry ができて Join の無い状態があり得て、後で settled の Join が受け付けられる。ただし、これは paidJoin の外の、利用者自身の別の transaction。
- `RelayOutcomeUnknown`（送った結果が分からない）とき。client は失敗として扱うが、transaction は Pay と Join を一緒に含んだまま着地するかもしれない。結果が分からないということで、入場料だけが引かれるということではない。
- 表示の鮮度や Join の gating の方針は変えていない（§29.8 (b) は未決のまま）。

## 29.11 継続分の集約：④ 8c53176a → 6af321d2 → 7e6ef2b6（cancel の試験の同期化）

- **review 済みの HEAD**：④ `7e6ef2b62132e05944454229d7e094c48a6ec5db`（tree `580c2614bb929b1b26c0f9dc7d81034688b7d435`）。基準は 16576826、pass の checkpoint は 95b0ab22 のまま。
  - `6af321d2`（④）：変わったのは `workstreams/04-execution/tests/concurrency.rs` だけ（+31 −6）。production の code は変わらない。
  - `7e6ef2b6`：⑦ 9cd15799 の merge。onboarding.mjs と ws07-unread.test.mjs が 9cd15799 と一致（§29.9 の probe で確認した marchObjective の修正）。
- **6af321d2 の静的な読み（④ の主張との照合）**:
  - 一致する点:
    - production の cancel と executor の code、試験の assertion、再試行、timeout は変わっていない。
    - executor と clock の**両方**が gate で待つ。
    - 最初の cancel だけが gate より前に出て、その run がまだ終わっていないことを確かめる。2 回目以降の cancel は、前と同じ乱数の待ち（0〜4 ms）で、動いている executor と競う。
    - cancel が無いときは gate が最初から開いているので、many_executors_many_runs は前と同じ。
  - **④ の「何も弱めていない」と食い違う点（低い）**：最後の `assert!(cancelled > 0 && fulfilled > 0, "the race was not exercised")` は文字の上では同じだが、意味が変わった。
    - 最初の cancel は、executor が動き出す前の run（Accepted）に当たるので、`cancelled > 0` は競合が無くても満たされる。
    - 動いている run との競合を示すのは、印刷される `after the facility` の数だけで、これは assert されていない。
    - ⑯ の 5 回では 1〜8 で、競合はいつも起きていた。案：`cancelled >= 2` か `after the facility > 0` を assert する。後者は再び非決定になりうるので、どうするかは ④ が決める。
  - **新しい欠陥（試験の失敗の仕方）**：canceller の thread が `go` を立てる前に panic すると、clock の `while !go.load(...)` が止まらず、試験は**失敗せずに hang** する。
    - panic の原因になりうるのは、最初の cancel の新しい assertion か、`Store::open`・`request_cancel` の unwrap。
    - ⑯ は scratch の写しで、最初の assertion を一時的に必ず外れる形に変えて確かめた（commit していない。後で元に戻した）。panic の文（`s01: the first cancel finds its run in flight (Some(Accepted))`）が出た後、180 秒で timeout に殺された（exit 124）。
    - cargo test には既定の timeout が無いので、CI では止まったままになりうる。
    - 案：`go.store(true)` を drop guard に入れる、あるいは clock の待ちで canceller の thread が終わったか（is_finished）も見る。
- **⑯ の実行**（`logs/phase23/ws04-concurrency-gate-6af3.txt`。concurrency は Sim と SQLite だけで、鍵の API は無い）:
  - 7e6ef2b6 の concurrency：5 回とも 8/8。cancelled は 10〜17、after the facility は 1〜8、fulfilled は 19〜26。
  - ④ の「2 秒遅らせた canceller」での旧版と新版の比較は、⑯ は再現していない（④ の結果だけ）。
- **この継続分で確かめた範囲の全体（§29.5〜29.11）**:
  - ④ の cold open の修正：再現で 42/400 → 0/400。store_cold_open は 2/2。③ の強制した順序で、旧版は失敗の値が 3/3、新版は 3/3。
  - ③ の試験：33/33 を 3 回、cold-open 2/2 を 3 回ずつ。
  - ⑦ の 9b547d9d・a8c9eccb・08928ea5・c4eae408・9cd15799：純粋な関数の probe と静的な読み。⑦ の画面と unit は流していない。
  - paidJoin：静的な事実（§29.10）。
  - 各 merge の file は、元の commit と一致した。scan の `--check` は、確かめたどの HEAD でも exit 0。
- **cold open の門について**：厳密に退行を止めるのは、④ の `store_cold_open` だけ。③ の cold-open.test.mjs は、旧と新の両方を通す診断であって、門ではない（④ の訂正と同じ）。
- **残る制限**:
  - ⑦ の画面と unit、gateway.rs・signed.rs（署名を使う）、保守的に除外したもの（via-src 209、unfollowed 23）は流していない。
  - §29.8 (b)（join と paidJoin の meStatus）は、持ち主が決めること。
  - 4d44f021 の元の run の順序は、確かめられていない。

## 29.12 ④ caeb1b74：§29.11 の 2 点の修正の確認

- 対象：④ `caeb1b7463e5a7e5b473a71c9c4f08a34bc17fea`（tree `5916b6461432226867036a33948a73fcbae7334d`、親 7e6ef2b6）。変わったのは `tests/concurrency.rs` だけ（+27 −10）。production の code は変わらない。
- **hang**：canceller の thread が、drop guard（`OpenOnDrop`）で、どう終わっても（panic のときも）gate を開く。panic は `join().unwrap()` で試験の失敗になる。
  - ⑯ が scratch で最初の assertion を一時的に必ず外れる形にすると、**1 秒で exit 101（FAILED）**になり、hang しなかった。前の版（6af321d2）は 180 秒で殺された。
- **assertion の意味**：gate より前に cancel した run を `cancelled_at_gate` として別に数え、`cancelled` から外した。
  - したがって `cancelled > 0 && fulfilled > 0` は、6af321d2 より前と同じく、動いている executor と競った cancel を要求する。
  - その run を飛ばす `continue` は、`row.state.terminal()` と `shipped == 0` の assertion の**後**で、match がループの最後の文なので、飛ばされる確認は無い。
- **⑯ の実行**（`logs/phase23/ws04-concurrency-caeb.txt`）:
  - 通常の run を 5 回：どれも 8/8。競った cancel は 7〜11、そのうち facility の後のものは 1〜5。fulfilled は 22〜26、gate での cancel は 3（seed ごとに 1）。
  - canceller を最初の cancel の前に 2 秒遅らせた（一時的な変更）：pass。競った cancel は 9、gate での cancel は 3。
- ④ の言うとおり、gate が取り除くのは「canceller が遅れて、仕事がすべて終わった後に来る」原因だけ。後の cancel が実行の途中に当たるかは、まだ時間に依存する。完全に決定的になったわけではない。
- 残る制限：これまでと同じ（§29.11）。

## 29.13 ⑧ a6e261f8（growth の route の試験）の独立のレビュー

- 対象：⑧ `a6e261f8dd5ac2d1626951d8c285886c2c95198f`（tree `77a95e662a2e475953e58723b535044408eee5e3`、親 caeb1b74）。branch `claude/festive-tesla-iwwc5t` の `6507c519` は tree が同じ。3 file、+194 行。
- **1. reviewed の理由**：おおむね正しい。
  - `scan --check` は exit 0。`--digest` は記された `closure=34a5b8e0…` と一致した。
  - 閉包は 64 file。鍵の API の名前は 4 file だけで、すべて vendor の noble BLS（bls.mjs、modular.mjs、weierstrass.mjs、bls12-381.mjs）。
  - そこへの経路は、どれも `terrain.mjs → fconquest.mjs → fland.mjs → fmarch.mjs → seal.mjs` を経て、`seal.mjs` の **動的な** `import('./seal-worker.mjs')` から入る。
  - その import は `sealMarch` の中の、Worker が無いときの inline の分岐だけにある。`new Worker(...)` も `startWorker()` の中だけ。どちらも封印のときにしか動かない。
  - 理由の文の補足：理由の文は Worker の経路しか書いていない。scan がたどる辺は inline の動的な import のほうなので、それも書くとよい。
  - 試験が呼ぶのは planRoute（`kernel.call('plan_path')` と tileHex）、world・terrain・fgeo の関数、loadKernel だけ。sealMarch は呼ばない。
- **2. 期待値が kernel の答えを固定しているだけか**：一部はそう。
  - 構造としての確認（kernel とは独立）:
    - 段階ごとの place（world.mjs）。
    - seed が無いときの NoPath と terrain の null。
    - 画面と kernel の geometry の一致（ring 4 と 5 のすべての Province）。
  - 固定値:
    - terrain の sha256、sites、passableMask、route の dirs と secs。
    - これらは、**この tree の中の他のどこにも無い**（⑯ が digest と mask で grep した）。⑲ の Rust fixture との照合は、まだ無い。今は kernel の答えを固定した回帰の値。
  - ⑯ の独立の照合:
    - tile 0 は (4,0) で axial (32,−16)、(5,0) で (41,−20)。hex の距離は max(9, 4, 5) = 9。
    - 固定値の pathLen 9（dirs も 9 個）と一致するので、最短の経路であることとは矛盾しない。
- **3. v3 の読み込みは画面と同じ確認か**：同じ 3 つを通る（`wasm.mjs` loadKernel）。
  - bytes の sha256 が公開の `.sha256` と一致すること。試験は commit された同じ file を読む。画面は `${url}.sha256` を fetch する。
  - ABI の版。
  - ruleset hash。違いは 1 つ：画面は season の record の rulesetHash を使い、試験は `PRESETS.ruleset_hash_v3` を使う。
  - kernelFile は、S1（layout 2、program_version 4）で `frontier-v3.wasm` を選ぶ（試験が assert）。
- **⑯ の実行**：repo の guard と ⑯ の hook v2 の下で 2 回とも **4/4**。hook の記録は 0 件（`logs/phase23/ws08-growth-route.txt`）。鍵の生成・導出・署名は無い。ring の seed は、公開の label の sha256。

## 29.14 ⑦ 9c23282d（`openRings` の hook と ws07-grow）の独立のレビュー

- 対象：⑦ `9c23282d6013c01e75e49b7cefd5397ee48cef3b`（tree `937ed44b…`、親 caeb1b74）。product の code の変更は無い。
- ④ の後続 `a6e261f8`（⑧ の commit そのものへの fast-forward）は、§29.13 で確かめたものと同じ。
- **(1) 既定で byte が同じか**：成り立つ。
  - `ringsOpen` が null のとき、`seasonNow()` は `W.seasonRecord()` をそのまま返す。
  - `ringOpen(d)` は `d <= 2` になる（前の `d > 2 → 404` の否定）。
  - 変わったのは /h/season、/h/overview、/h/roster の 3 つの route だけ。
  - `openRings` は n > 3 の整数だけを受け付け、それ以外は null にする。
  - ws07-grow の最初の試験が、未設定のとき、設定して外した後の、既定の sha256（`8e00cf59…`）を確かめる。`after()` で null に戻す。
- **(2) seed の形は fixture の既存の ring と同じか**：同じ。
  - world.mjs の ring 0〜2 の seed は、どれも「byte d+1 を 32 回」で、hook が足す ring 3 以降と同じ形（⑯ が 3 つとも確かめた）。
  - 変わるのは record の `rings` だけで、ほかの growth の field を作り足してはいない（この fixture の record には rMax 16 しかなく、ringsOpened などは無い）。
  - ring 3 と 4 の overview と roster の bytes は、world.mjs が前から作っていた。404 は server の gate だけだった。
- **(3) 画面が見せる以上のことを assert していないか**：一部はしている。
  - DOM を見る assert：panel の文、`#mc-title`、hand の按鈕。
  - 内部の状態を読むもの:
    - `state()` は `FS.compose`（dest、route の province、bell、earliest）と `FS.mapNote`、`FS.record.rings` を読む。route や arrival の turn は、画面に出る形ではなく内部の値で確かめている。
    - 届く tile は、page の kernel の `planRoute` を試験の側から呼んで選ぶ。
  - **`clear()`（3 回）は `FS.compose`・`selected`・`hand`・`mapNote`・`inspectOpen` を直接 null にする**。UI の操作ではなく状態を書き換えるので、取り消しや選び直しの画面の経路は、その箇所では確かめていない。取り消しの経路は、別の段（cancel、戻る・進む、reload）で UI から確かめている。
- **⑯ の実行**：ws07-grow を full Chromium と repo の no-keys-guard の下で 1 回流し、**3/3**（`logs/phase23/ws07-grow-9c23.txt`）。範囲は封印前の order まで。

## 29.15 ⑧ 5e7ac44c・fdac9b62・4eeb6c7f、⑳ 8443d12e、④ 5e0f2ec2

### ⑧（S1 の Season と Frontier の bytes、genesis の seed の規則、review の理由）
- 対象：⑧ `4eeb6c7f`（tree `47d4b300…`）。6507c519 の上に 3 commit。
- **M1 と S1 の口座の混同**：
  - ⑯ の probe（`probes/v16-ws08-season-bytes.mjs`）では、Season は 2048 bytes、Frontier は 512 bytes で、layout 2、program_version 4、genesis_ring 3、R_MAX 4 だった。
  - **ただし SDK の encodeAccount は、profile 1（M1）でも profile 2 でも、Season 2048・Frontier 512 になる**。したがって、大きさの assert だけでは M1 と S1 を区別できない。
  - 区別するのは layout_version 2、program_version 4、v3 の ruleset。test 5 はこれらも確かめているので、全体としては区別できている。大きさの assert を「M1 でない根拠」とは書かないほうがよい。
- **`upper()` で項目が落ちるか**：落ちない。
  - MC_LOCAL_7D の conquest の 34 項目（r_max_ceiling、placement、continuous の上書きを含む）と、SDK で decode した CONQUEST_PARAMS の 34 項目は 1 対 1 で一致した。欠け、余り、値の違いは無い。
- **genesis の seed**：`sha256("PSF-RING" ‖ genesis_seed ‖ le16 d)` は、program の `proc/map.rs` genesis_ring_seed（`RS::GENESIS_RING_DOMAIN = b"PSF-RING"`）と同じ。
- **review の理由**（fdac9b62）：Worker の経路と inline の `import('./seal-worker.mjs')` の両方を書くようになった。§29.13 の指摘は直った。
- 実行：4eeb6c7f で scan の `--check` は exit 0、digest も一致した。growth-route は repo の guard と hook v2 の下で **5/5**、hook の記録は 0 件。
- 固定値（terrain と route）に Rust との照合が無いことは変わらない（⑧ も同じ認識）。

### ⑳ 8443d12e（NFT resident の /h/me）
- 対象：⑳ `8443d12e7bcc0e72760ee037e337259ce4dd8e94`（tree `2c532ae0…`、親 caeb1b74）。
- **mark が付いているのに無効な場合は、どこでも拒否されるか**：拒否される。
  - fcodec は、flag があって wallet が 0 でない、または asset が 0 のとき、`residentAsset: null` にする。
  - checkMe（herald.mjs）と parseWideInventory（fwide.mjs）は、どちらも null を WrongKey にする。
  - ⑳ の試験 4 が、別の asset、別の address、無効な mark、別の持ち主を確かめる。
- **wallet の経路は byte まで変わらないか**：変わらない。
  - ⑯ の probe（`probes/v16-ws20-wallet-citizen.mjs`）で、SDK で作った wallet の v2 Citizen を、caeb1b74 と 8443d12e の fcodec で decode した。出力の sha256 は同じ（`e7e412fe…`）で、residentAsset は無い。
  - 違いは 1 つだけ：wallet の Citizen の 380 番目の byte に flag が立っていると、新しい版では `residentAsset: null` になり、WrongKey で拒否される（前の版は読んだ）。program はそれを書かないので、壊れたデータに対して厳しくなっただけ。
  - 新しい `BadLayout` の throw は、layout の RSV_348 の位置が frontier-abi と違うときだけ起きる（今の layout では起きない）。
- **切れた bytes、壊れた bytes、別の season**：⑳ の試験 5 が、codec で拒否されることを確かめる。
- **試験は鍵を作らないか**：作らない。web-frontier-resident-me に鍵の名前は 0 行。base58、with-seed、sha256 だけ。
- ⑯ の実行：resident-me（流してよいもの）を repo の guard と hook v2 の下で **5/5**、hook の記録は 0 件。wide-holding-ui は保守的な除外なので流していない。
- **⑳ の commit 単独での注意**：8443d12e では、scan の `--check` が **exit 5** になる。connect-live の review の閉包に、変わった fcodec・herald・fwide が入っているので、stale になる。この commit をそのまま CI に入れると、scan で止まる。

### ④ 5e0f2ec2（⑧ と ⑳ の取り込み）
- 対象：④ `5e0f2ec2d6989108bf7cca80495f10b87f1c5724`（tree `8074f8ac7ea33fe8f4c74172ed54be0fa6b6a0f1`）。5461e842 の上に ⑧ の 3 commit、⑳ の merge（ff831702）、review の再審査（5e0f2ec2）。
- ⑧ の fixture と試験は 4eeb6c7f と一致する。⑳ の fcodec・fwide・herald・resident-me・vector は 8443d12e と一致する。
- 5e0f2ec2 は、connect-live と growth-route を再審査して digest を付け直した。
  - 新しく閉包に入った `sdk/frontier/resident.mjs` には、鍵の API の名前が無い（⑯ が確かめた）。
  - 理由の文にも residentCitizen が書き足された。
- scan の `--check` は exit 0。§27.8 の digest の仕組みが、設計どおり stale を捕まえ、再審査させた例になる。
- 5461e842（⑦ 9c23282d の merge）：server.mjs と ws07-grow が 9c23282d と一致する（§29.14）。
- 記録は `logs/phase23/ws08-ws20-5e0f.txt`。

## 29.16 ⑦ 4f60a629（seasonWith、ws07-grow-r5）と ⑲ 15b4c0ae（map の契約の golden）

### ⑦ 4f60a629
- 対象：⑦ `4f60a629075bc20859a71e5413298d293187bc6b`（tree `e3dac524…`、親 d7dd5ffc = ⑧ 6507c519 の merge）。product の code の変更は無い。
- **(a) 既定で byte が同じか**：成り立つ。
  - `ringOpen(d)` は `d < seasonNow().rings.length` になった。既定では fixture の record の rings は 3 つなので、`d <= 2` と同じ。
  - `seasonWith` が null なら、seasonNow は前と同じものを返す。`after()` で null に戻す。
  - ⑯ の実行で、ws07-grow（既定の sha256 `8e00cf59…` を、未設定のときと、設定して外した後に確かめる）は **3/3**。
  - 注意：`ringOpen` は rings の一覧が 0 から隙間なく並ぶことを前提にしている。⑧ の withGrowth はそうなっているので、今は問題ない。
- **(b) 主張の範囲**：先頭の comment に、⑦ の言うとおりの範囲が書かれていて、誇張は無い。
  - 確かめているのは、place、inspector の文、route だけ。
  - owner と overview は合成のもので、⑲ の golden ではない。
  - (4,0) の host と order card は無い。何も封印・署名・送信しない。
- **⑯ の実行**（full Chromium、repo の no-keys-guard）:
  - ws07-grow-r5：⑦ が commit したまま（⑧ 6507c519 の fixture）で **2/2**。
  - **④ の今の fixture（⑧ 4eeb6c7f の growth-route.mjs。ring 0〜3 の seed が PSF-RING の規則になった）に一時的に差し替えても 2/2**。元に戻した。統合しても通る見込み。
- 文書の注意：ws07-grow-r5 の先頭の「seed sha256("ring"+d)」は、⑧ 4eeb6c7f 以降、ring 4 以上についてだけ正しい。
- 記録は `logs/phase23/ws07-ws19-4f60-15b4.txt`。

### ⑲ 15b4c0ae
- 対象：⑲ `15b4c0ae9b7114c567d76db6fa6017c0b3961016`（tree `a9931155…`、caeb1b74 の上の 2 commit。試験と fixture だけ）。
- **鍵の経路を避けているか**：避けている。
  - scan の `--check` は exit 0。Node の試験は list に載っておらず、`--covers` も通る。
  - 試験は golden の上の stub の fetch、herald.mjs、map/world.mjs、faddr の公開の with-seed PDA だけを使う。
  - ⑯ が repo の guard と hook v2 の下で流して **9/9**、hook の記録は 0 件。
  - Rust の試験と 2 つの fixture に、鍵の API の名前は無い（grep）。⑯ は Rust を流していない。
- **golden の assert が herald と画面の食い違いを隠していないか**：1 か所、空の assert がある。
  - wide index の試験の `assert.match(wi.code, /^WideIndex|^[A-Za-z0-9]+$/)` は、2 つ目の選択肢がどんな英数字の code にも当たるので、何も確かめていない。
  - herald の status を見るなら、golden の body.code と完全一致させるのがよい。
  - Rust の側は、golden を既定で比べ、`WS19_GOLDEN_WRITE=1` のときだけ書き直す。黙って書き換わることはない。
- **chain ではありえない状態**:
  - ⑲ が書いているとおり、genesis の ring 0〜3 の seed が、program の `sha256("PSF-RING" ‖ genesis_seed ‖ le16 d)` ではなく `sha256("ring"+d)` になっている。
  - **⑧ は 4eeb6c7f（④ に入った）でこれを program の規則に直したので、⑧ と ⑲ の fixture は ring 0〜3 で食い違うようになった**。ring 4〜5 の terrain と route は影響を受けない。
- **⑧ の固定値との照合**:
  - ⑲ の S1 の fixture は、Province の terrain・sites・passable mask を Rust の `permutation_rules::frontier::terrain::generate_province`（ring seed と座標から）で作る。
  - Node の試験は、それを ⑧ の GEOMETRY（wasm の kernel から固定した値）と比べて一致した。
  - したがって、§29.13 と §29.15 で「Rust との照合が無い」とした ⑧ の固定値は、⑲ のこの試験が入れば、Rust の規則と wasm の kernel の両方で確かめられることになる（ring 4 と 5 の (4,0) と (5,0) について）。

## 29.17 ④ b64cef2c、⑦ b1142259、⑧ 631c1963

- **④ `b64cef2c687d9b8c94ceaad90dc901fe26d18518`**（tree `d129e9c5e57b4c3848aba32fe834d2cc9418d21f`、親 5e0f2ec2 と ⑦ 4f60a629 の merge）:
  - server.mjs と ws07-grow-r5 は 4f60a629 と一致する。
  - ⑧ の growth-route の fixture（4eeb6c7f のもの）と node-key-reviewed（付け直した digest）は 5e0f2ec2 のまま。
  - この組み合わせは、⑯ が §29.16 で fixture を差し替えて流したものと同じで、ws07-grow-r5 は 2/2 だった。④ も b64cef2c で 2/2 と報告している。
- **⑦ `b1142259232f134e39aca7613a134e3cb867d8aa`**（tree `da784228…`、親 4f60a629。④ にはまだ入っていない）:
  - ws07-grow の `clear()` は、hand の close と drawer の close を UI で押し、状態が消えるのを待つ形になった。`FS` を直接書き換える行は 0 になった（§29.14 の指摘 (3) は直った）。
  - route と arrival は今も `FS.compose` から読む（⑦ が明記している）。
  - ⑯ の実行：ws07-grow を full Chromium と repo の guard の下で **3/3**。
- **⑧ `631c1963`**（親 b5ce03ba = 5e0f2ec2 の merge）：fixture の注と試験の assert の文言だけを変えた。§29.15 の「大きさは M1 と S1 で同じ」を反映している。scan の `--check` は exit 0。
- 記録は `logs/phase23/ws07-b114-ws08-631c-b64c.txt`。

## 29.18 ⑲ 32e13f7c・023088ea（§29.16 の 2 点の修正）

- 対象：⑲ `023088ea7922058e3d7f069116a5674c9e695a11`（tree `0b3911ad…`）。15b4c0ae の上に、④ 5e0f2ec2 の merge（a2362f78）、32e13f7c、023088ea。
- **空の assert**（023088ea）：直った。
  - wide world と wide index は、golden の両方で `503 {ok:false, code}` を、client の code は `WideWorldUnavailable` と `WideIndexUnavailable` を、完全一致で確かめるようになった。
  - どんな英数字でも通る正規表現と、status による分岐は無くなった。
- **genesis の seed の食い違い**（32e13f7c）：直った。
  - Rust の `cqfixture/growth.rs` の `ring_seed` は、d ≤ GENESIS_RING で `RS::GENESIS_RING_DOMAIN`（`PSF-RING`）‖ genesis_seed ‖ le16 d を使う。
  - Node の試験は、各段階で、router の rings と growth の field を、⑧ の `growthFields` と比べる。
  - これで ⑧（4eeb6c7f）と ⑲ の fixture は、ring 0〜3 でも一致する。
- ⑯ の実行:
  - scan の `--check` は exit 0。試験は list に載っておらず、`--covers` も通る。import は herald・world・faddr と node の組み込みだけ。
  - repo の guard と hook v2 の下で **11/11**、hook の記録は 0 件（`logs/phase23/ws19-0230.txt`）。
  - Rust の試験（ws19_map_contract）は、⑯ は流していない。

## 29.19 ④ dd7f8735（⑧ e01fff60 の merge：⑲ 32e13f7c と ⑧ 631c1963 を含む）

- 対象：④ `dd7f8735a1feb1d89c6506325a108ebc70c0ffa6`（tree `a47c4694fb649cb2aa940a6fafe0e5b2976347e6`、b64cef2c の上）。
- 一致するもの:
  - ⑲ の Rust の fixture 2 つ、ws19_map_contract.rs、golden 2 つは ⑲ 32e13f7c と一致する（023088ea でも同じ。023088ea が変えたのは Node の試験だけ）。
  - ⑧ の growth-route の fixture、試験、node-key-reviewed は ⑧ e01fff60 と一致する。
  - scan の `--check` は exit 0。
- **足りないもの**：`web-frontier-map-contract.test.mjs` は ⑲ **32e13f7c** の版で、⑲ **023088ea** の版ではない。
  - したがって、§29.16 で指摘した空の assert（`assert.match(wi.code, /^WideIndex|^[A-Za-z0-9]+$/)`、125 行）と、status による分岐が、④ の候補に残っている。
  - 023088ea は、この 1 file だけを変える（+13 −6）。
  - 案：⑲ 023088ea（branch `claude/ecstatic-cannon-d0jfc4`）の map-contract を取り込む。それで §29.18 で確かめた版（11/11）になる。
- ⑯ は dd7f8735 の Rust と Node の試験を流していない（④ の 2/2 と 17/17 がある。⑲ の版は §29.18 で 11/11）。

## 29.20 ④ 233731c5（§29.19 の欠けの解消）

- 対象：④ `233731c520db70974582369734c9e4ef1130142c`（tree `50ec96cdc56959db46e751ab6387bc6c3b5a14e9`）= dd7f8735 に ⑲ 023088ea と ⑦ b1142259 を merge したもの。dd7f8735 からの変更は 2 file（+21 −7）。
- `web-frontier-map-contract.test.mjs` は ⑲ 023088ea と一致する。空の正規表現の assert は 0 件になった（§29.19 の欠けは解消した。⑯ が §29.18 で 11/11 を確かめた版）。
- `ws07-grow.screen.mjs` は ⑦ b1142259 と一致する（⑯ が §29.17 で 3/3 を確かめた版）。
- scan の `--check` は exit 0（119 / 209 / 23 / 9）。
- ⑯ は 233731c5 の上で流し直していない。2 file とも、⑯ が実行で確かめた版と blob が同じ。Rust の ws19_map_contract は、④ の dd7f8735 での 2/2 だけがある。

## 29.21 ④ fc6b923b（⑲ 5ff7ad50：S1 の Season の bytes と map-arrival の試験）

- 対象：④ `fc6b923bcfc4c5c601686764f4d19b5a3b191dfa`（tree `36824be3e322b673dcb28fbda9437eff3b8c1abf`）= 233731c5 に ⑲ 5ff7ad50 を merge したもの。5 file、+261 −50。
- ⑲ の cqfixture/growth.rs、S1 の golden、ws19_map_contract.rs、web-frontier-map-arrival.test.mjs は、⑲ 5ff7ad50 と一致する。
- **新しい reviewed の行（map-arrival）**：成り立つ。
  - `--digest` は記された `closure=bc7c1370…` と一致し、scan の `--check` は exit 0（119 / 209 / 23 / 10）。
  - 試験が呼ぶのは fmarch の `checkMarch`（147 行）、`arrivalWindow`（82 行）、`tipOptions`（71 行）、`RETREAT_CHOICES` だけ。
    - ⑯ が 3 つの関数を読んだ。seal・sign・key・Worker・動的な import を使う行は無い。「seal」は手数料の `sealBond` の field 名としてだけ出る。
  - ほかの import は herald の createHerald（golden の上の stub の fetch）、faddr の seasonAddresses、⑧ の ROUTE。
  - 鍵の API の名前は、⑧ の growth-route と同じく、vendor の BLS にしかない（seal-worker の経路で、封印のときだけ）。
- ⑯ の実行：map-arrival、map-contract、growth-route を repo の guard と hook v2 の下で **20/20**、hook の記録は 0 件（`logs/phase23/fc6b-map-arrival.txt`）。
- ⑯ が流していないもの：Rust の ws19_map_contract（④ の fc6b923b での 2/2 がある）。S1 の Season の bytes が MC_LOCAL_7D の write_params と同じになったことは、Rust の側の主張で、⑯ は確かめていない。

## 29.22 §29.21 の残り：S1 の Season の bytes と write_params（静的な照合）

- 対象：④ fc6b923b の `frontier-node/crates/herald/src/cqfixture/growth.rs` `season_bytes_from` と、`permutation-frontier/src/proc/season.rs` `write_params`。
- ⑯ の静的な照合（両方の関数が書く field の名前を抜き出して比べた）:
  - 共通する 49 の field は、**同じ順番**で書かれる。
  - write_params にあって fixture に無いもの：`STATUS_CREATED`、`GENESIS_ROUND`、`PAYOUT_PARAMS_HASH`、`SHADE_AUDITOR`。
  - fixture にあって write_params に無いもの：`SIZE`、`SEASON_ID`、`STATUS_RUNNING`、`RULESET_HASH_V3`、`RULES_VERSION_S1`、`CONQUEST_PARAMS`。
  - これらの差は、④ が挙げたもの（STATUS は CREATED ではなく RUNNING、GENESIS_ROUND・PAYOUT_PARAMS_HASH・SHADE_AUDITOR は 0、CONQUEST_PARAMS は write_params の外）と合う。
- 確かめていないこと:
  - 値（min_lead / max_lead が preset の 2 / 72 であること、GENESIS_SEED、CREATED_TS など）の照合。
  - write_params を実際に走らせて byte を比べること。そうする試験は無い。
  - したがって、「write_params と同じ field を同じ順で、述べられた違いだけを除いて書く」ところまでが確かめられた範囲。

## 29.23 ⑲ 68d9c6d4（beacon の値）と ⑳ 5ee5fa35（NFT の viewer が自分の Citizen だけを採る）

### ⑲ 68d9c6d4
- 対象：⑲ `68d9c6d48cb9603635c6f9f057cfaa9171af737b`（tree `a5fbf199…`、④ fc6b923b の上。試験と fixture だけ）。
- **program と profile から一意に決まるか**：決まる。
  - M1 の growth の Season の QUICKNET_PK_HASH は、写した値ではなく、共通の定数 `frontier_abi::presets::QUICKNET_PK_HASH` を書く。
  - NETWORK 2（`NETWORK_QUICKNET`）、quicknet の genesis と period も presets の定数で、presets の validate が S1 にそれを課す。
- **食い違いを隠す assert があるか**：見つからない。
  - checkBeacon（seal.mjs 161 行）は、network、公開鍵の pin、clock、chain hash、pk hash を順に確かめ、それぞれ別の code を返す。
  - 試験は、S1 の 4 段階と M1 の 3 段階で kind が quicknet であること（ok のときだけ kind が付く）を確かめる。
  - 否定の場合：NETWORK 0 と 0 の hash（NotQuicknet）、pk hash の 1 byte の違い（PkHashMismatch）、別の公開鍵（NotQuicknet）。
  - 「NETWORK 2 で hash だけが 0」の場合は、hash の違いの場合に含まれる。
- **鍵の code に届くか**：届かない。checkBeacon は sha256 と文字列の比較だけ。BLS は seal-worker の経路だけで、起動しない。
- ⑯ の実行：scan の `--check` は exit 0（reviewed 10）、`--covers` も通る。map-arrival と map-contract を repo の guard と hook v2 の下で **15/15**、hook の記録は 0 件。Rust は流していない。

### ⑳ 5ee5fa35
- 対象：⑳ `5ee5fa3566b15514020e4f40567818aa0ddbd0e0`（tree `f3db89f4…`、親 ④ dd7f8735）。product の変更は、controller.mjs の `viewerOwnCitizen` と、applyMeResult の入口の 1 行。
- **wallet の経路は変わらないか**：変わらない。
  - wallet で遊ぶとき（FS.resident が null）は、`residentAsset === undefined` の Citizen（mark の無い wallet の Citizen）だけを採る。§29.15 で確かめたとおり、wallet の Citizen の decode には residentAsset が無い。
  - 違いは、wallet の Citizen に無効な mark（residentAsset が null）があるときに拒否されることだけ（herald の checkMe と同じ扱い）。
- **NFT で遊ぶとき**：mark があり、その asset が遊んでいる NFT と一致する Citizen だけを採る。
  - wallet の Citizen（mark が無い）と、無効な mark（null）は WrongKey になる。
- **拒否された read は、前に採った Citizen を残すか**：残す。
  - 拒否は `me = {ok:false, code:'WrongKey'}` にして、applyMeResult の既存の error の分岐に入れる。その分岐は FS.citizen と holdings を変えず、meStatus を 'error' にする。
  - ⑦ の meAnswered（§29.8）の下では、前に答えがあれば表示はそのまま保たれる。
- **NFT の Citizen はいつも mark つきで decode されるか**：条件つきで成り立つ。
  - fcodec は header の byte 16〜17 が 2 のときだけ profile 2 で decode し、mark を読む。program は layout_version を書く（⑳ が挙げた layout/mod.rs）。
  - layout_version が 2 でない NFT の Citizen は mark が読まれず、NFT の viewer には WrongKey になる。偽って受け入れるのではなく、拒否する側に倒れる。
- **試験の閉包**：
  - ⑳ が変えた 2 つの試験のうち、`web-frontier-resident-home` は scan の **direct** の区分。試験そのものの mock の wallet が `signTransaction` と `signMessage` の名前を持つ。
  - `web-frontier-wide-holding-ui` は via-src。
  - ⑯ はどちらも流していない。この 2 つでの ⑳ の結果（修正を戻すと 2 件が失敗する）は、⑳ の静的な監査と受け身の monitor に基づくもので、⑯ は鍵を使わないことを確かめていない。
  - ⑯ が流したのは、流してよい `web-frontier-resident-me` だけで、5/5、hook の記録は 0 件。
  - ⑳ が前の round で、鍵を導出する 4 つの file を流したと開示していることも記録する（HOLDER-CONTRACT §15）。
- 記録は `logs/phase23/ws19-68d9-ws20-5ee5.txt`。
- 追記（⑳ の訂正）：
  - ⑳ は、web-frontier-wide-holding-ui と web-frontier-resident-home を、`node-key-tests.txt` を確かめずにじかに流したと訂正した。web-frontier-herald と ws07-nft/me-answered も同じ。
  - これらの old-fails / new-passes の数は、鍵を使わない手順の外のものとして扱う。⑳ の鍵を使わない回帰の証拠は web-frontier-resident-me だけ（⑯ も 5/5）。
  - 記録は HOLDER-CONTRACT §15（⑳ `1da4a517166c487e4736f55f4c4f22a29a69b162`。5ee5fa35 の上で、文書を 6 行足しただけ）。
  - ⑯ の §29.23 の判断（controller の修正は静的に正しい。2 つの試験の証拠は鍵を使わないと確かめられていない）は変わらない。

## 29.24 訂正：⑳ の「v0.24 の 103 file は鍵を使わない」は無効

⑳ の公開の記録 HOLDER-CONTRACT §15（⑳ `1da4a517166c487e4736f55f4c4f22a29a69b162`）に基づき、次のとおり記録する。seed や秘密の値は、ここには書かない。

- **無効とする主張**：⑳ v0.24 の「103 file を鍵なしで流した」。この数は、鍵を使わない合格には数えない。
- **実際に行われたこと（⑳ の記録による）**:
  - v0.24 の 103 file には、`web-frontier-opening-world`、`web-frontier-s1`、`web-frontier-territory`、`web-frontier-live` の 4 file が入っていた。
  - これらでは、固定の seed からの鍵の導出と署名が実行された（試験の file の中で `keyFromSeed` を呼ぶもの）。
- **今回の広い再実行（v0.25）で起きたこと（⑳ の記録による）**:
  - ⑳ の監視は、最初の `subtle.importKey('pkcs8')` で 26 回止めた。署名の前。
  - **これを「鍵が導出されなかった」証拠や、鍵を使わない合格には数えない**。
  - ⑯ の静的な読み（web/session.mjs の `keyFromSeed`、85〜94 行）:
    - `publicKeyOf(s)` による公開鍵の JS での導出（89 行）が、importKey の**前**に走る。
    - 最初の `importKey('pkcs8')`（92 行）は try/catch の中にあるので、そこで止められても飲み込まれ、94 行の 2 回目の importKey で止まる。
    - つまり、importKey での停止は、seed からの公開鍵の導出が終わった**後**の停止である。止まったのは、秘密鍵の取り込みと署名の前。
  - 分かること：4 file で importKey が呼ばれたこと、署名の前で止まったこと。
  - 分からないこと:
    - 26 回の停止の前に、ほかに何が導出されたか。
    - 監視が覆わない経路（JS の別の導出、子 process）で何が起きたか。
    - v0.24 の 4 file で何回署名したか。
- **⑳ が `node-key-tests.txt` に載る file を、確かめずに流したこと**（⑳ の訂正。§29.23 の追記）：wide-holding-ui、resident-home、web-frontier-herald、ws07-nft/me-answered。
  - これらの結果（old-fails / new-passes、「56 件中 55 件、鍵の呼び出し 0」、「101 file で 0」を含む）は、鍵を使わない手順の外のものとして扱う。
- **resident の修正（⑳ 8443d12e、5ee5fa35）の評価に使う証拠**は、次の 2 つだけ:
  - 静的な審査（§29.15、§29.23）。
  - 呼び出しが 0 件だった限定試験：`web-frontier-resident-me`。⑯ の実行で 8443d12e と 5ee5fa35 の両方で **5/5**、repo の guard と ⑯ の hook v2 の下で鍵の入口の呼び出しは 0 件。scan の list に載らず、`--covers` も通る。
  - §29.15 で ⑯ が流した probe（wallet の Citizen の decode の比較）は、鍵を使わない純粋な関数。
  - ⑳ が 2026-11-08 に送ってきた「1014/1014 across 103 web-frontier and frontier-resident files」は、⑯ の記録のどこにも合格として数えていない（今回、ここで無効と明記する）。
- **⑯ 自身の手順**:
  - ⑯ は、guard に既知の鍵の経路を止めさせる目的で試験を流していない。今回の pass で流したのは、scan の list に載らないか、review された file と、⑯ の純粋な probe だけ。
  - 以前の ⑤ の 4 file の件（§ phase 18 より前。guard で Keypair.generate に当たったもの）は、当時から鍵を使うものとして記録し、合格に数えていない。

## 29.25 ⑳ の確定訂正 0a766757 の照合（文書のみ）

対象：⑳ `0a766757cffbee6e7229e385d59633e72e00ffbf`（tree `6bef5b7824771be3e65eb8972fa775dd01f14763`）。親 `1da4a517` からの差分は `permutation-nft-resident-spike/docs/HOLDER-CONTRACT.ja.md` の 7 行追加だけ。`5ee5fa35` から見ても、変わったのは同じ文書だけで（`git diff 5ee5fa35 1da4a517` も同じ文書の 6 行）、コードと `scripts/` は変わっていない。

照合した内容（静的な照合のみ、新しい試験は走らせていない）：
- 無効とする主張は 2 つ：§14 の「103 file・1014 件」と、§15 の「残りの 101 file も 0」。§29.24 の記録と一致する。guard が止めた 26 回の pkcs8 import は、鍵が作られなかった証拠にも、鍵なしの合格にも数えない。この扱いも変わらない。
- 適格な実行は 1 件だけ（resident-me 単独、1da4a517、5/5）。`web-frontier-resident-me` は 0a766757 の `node-key-tests.txt` にも `node-key-reviewed.txt` にも載っていない。0a766757 の木で scan の `--check` は exit 0、`--covers` も exit 0。1da4a517 のコードは 5ee5fa35 と同じなので、⑯ が 8443d12e と 5ee5fa35 で得た resident-me の 5/5（§29.24）は同じコードに当たる。1da4a517 そのものでは、⑯ は走らせていない。
- 適格でない 5 file（wide-holding-ui、resident-home、ws07-nft、ws07-me-answered、herald）は、どれも `node-key-tests.txt` に 1 回ずつ載り、reviewed の一覧には無い。⑳ の記述どおり。controller の修正 5ee5fa35 の「旧で落ち、新で通る」結果は、鍵なしの証拠ではない。

判定：5ee5fa35 は §29.23 の静的な審査と、resident-me の zero-call の実行（5/5）だけで評価する。
- 通過：静的な照合 3 件、scan の --check と --covers の 2 件。
- 失敗：0。
- blocked：0。
- 未実行：controller の 2 file を含む、一覧に載る 5 file。⑯ は鍵経路を guard に止めさせる実行をしない。
- 全体の完了は宣言しない。

## 29.26 ④ ff749ed2 の照合と、resident の controller 修正に足す、鍵なしの限定試験

### ④ `ff749ed2e16985aff7e6e550bb2e091868b73800`（tree `58a844b374eb8a41922a01aefe3323267a84ed69`）

- **⑲ の merge** `2bbbc33c`：tree `a5fbf199…` は ⑲ `68d9c6d4` の tree と同じ。§29.23 のレビューはそのまま有効。
- **⑳ の merge** `7311597f`：tree `abd6beba…` は、`git merge-tree 2bbbc33c 5ee5fa35` が出す tree と同じ。手で加えた変更は無い。
- **④ の文書の commit** `ff749ed2`：HOLDER-CONTRACT だけを変える。§14 の行には無効の印を付けた。§15 には「4 による訂正」を加えた。
- **④ の訂正と ⑳ の確定訂正の差。** ④ の訂正は「評価に使う証拠」の最初に、⑳ の 7 file の実行（55/56、鍵の呼び出し 0）を挙げている。⑳ の確定訂正 `0a766757`（§29.25）では、この実行の 5 file は一覧に載り reviewed にも無いので、適格でない。ユーザーの指示も同じである。だから、この 7 file の実行は「適格でない」へ移すのが正しい。
- **HOLDER-CONTRACT の版が 2 つある。** ④ の枝は ⑳ の `1da4a517` と `0a766757`（§15 の訂正の 2 回）を取り込んでいない。§15 の末尾は、⑳ の版と ④ の版で別々に書かれている。後で merge すると、同じ場所で衝突する。
- **herald の既知の不具合（静的に確認）。** `web-frontier-herald` の「the fixtures are fresh」は、`test/fixtures/frontier/` の file の一覧が make-fixtures の一覧と同じであることを求める。`growth-route.mjs`（⑧ `631c1963` が最後に変更）はその dir にあるが、make-fixtures には無い。だから、この試験は落ちる。④ の記述どおり。この file は一覧に載るので、⑯ も走らせていない。

### 新しく作った名指しの試験（`web-frontier-viewer-own-citizen.test.mjs`、⑯ が作った候補）

既存の 2 file（wide-holding-ui、resident-home）は走らせない。代わりに、修正の 4 つの性質だけを確かめる file を新しく作った。
- 試験 file 本体と、reviewed の 1 行を合わせた差分：`patches/v16-viewer-own-citizen-on-ff749ed2.patch`（ff749ed2 に当てる）。
- 取り込みは ④ に任せる。試験の内容は ⑳ の確認待ち。production の規則は変えていない。

**中身。** program 自身の bytes（`frontier-abi/vectors/v2/resident-citizen.json`）を、page の codec で decode して使う。
- NFT の viewer のとき、WALLET が asset の財布の Citizen を拒む。その前に採っていた Citizen と holdings は、同じ object のまま残る。
- NFT の viewer は、別の asset を名指す印、無効な印 2 種、ふつうの財布の Citizen も拒む。この場合も、すでにある値は上書きされない。
- NFT の viewer は、asset を名指す本物の印の Citizen を採る。holdings も採る。
- 財布の viewer は、印の無い財布の Citizen を今も採る（以前の動作を壊していない）。印のある Citizen と無効な印は拒み、すでにある値は上書きされない。
- Citizen の無い読みは今も `found`、NotFound は今も `missing`。
- fixture が説明どおりの中身かどうかも、試験の中で確かめる。

**実行の前に行った静的な審査**（`scripts/v16-closure-audit.mjs`、`scripts/v16-toplevel-refs.mjs`。どちらも text を読むだけ）：
- 試験の text に、鍵の API の名前は無い。spawn、worker、計算した import() も無い。
- import の閉包は 137 file。鍵の API を名指す file は 11 ある：session、wallet、fsession、fplay、fprize、sdk/frontier/prize、map/tilt（`Math.sign` の誤検出）と、vendored の noble の 4 file。
- **読み込みの時点。** どの file も、top-level で鍵の module の束縛を呼ばない。top-level にあるのは束縛の参照だけ（例：`let tx = { submit, track }`）。top-level の文で実行されるのは次だけで、どれも鍵に触れない：
  - `fwide.guardLegacy`（閉包に鍵の file が無い）
  - `onLangChange`
  - `onArtWanted`
  - seal-worker の `WorkerGlobalScope` の判定（node では偽）
  - lang の `if (inBrowser)`（偽）
  - base58 と bytes の表の作成
- **呼び出しの経路。** `applyMeResult` から届くのは次だけ：
  - `viewerOwnCitizen`（base58）
  - fwide（閉包に鍵の file が無い）
  - `fland.landState`（`rent`、`isZeroRef` だけで、fmarch や seal を呼ばない）
  - pin が無いので、メモリの中の land の記録
  - `fstate.invalidate`（この閉包のどこにも `registerRenderers(` が無いので、描画は走らない）
  - `refreshDelegation`。wallet があり、sessionProblem が null で、agentWallet が定義済みなので、`loadAgents` の前に戻る。
  - `FS.session` は null なので、`fsession.matchesCitizen` は呼ばれない。
- **reviewed の行。** `closure=3175899e36b67c25bdc8eefb7f38ff8522531dbcb2ffd376edd93090a74b26b8` を加えた。scan を作り直しても `node-key-tests.txt` は変わらない。`--check` は exit 0（11 file が reviewed で走れる）。

**実行**（ff749ed2 に上の差分を当てた木）：
- `node-keyfree.sh permutation-gateway test/web-frontier-viewer-own-citizen.test.mjs`：**4/4 合格**。1 file だけで、221 file は一覧に載るので除かれた。
- repo の guard と ⑯ の hook v2（`--import` だけ）の下で同じ file を走らせた。hook が働いていることは source の text で確かめた（同じ実行の active check、1/1）。**4/4 合格**、hook の記録は **0 行**。
- **変異の対照。** 5ee5fa35 が controller に加えた 14 行だけを戻し、digest を付け直して、`node-keyfree.sh` で走らせた。拒否の 2 試験が `'found' !== 'error'` で落ちた。採る側の 2 試験は通った（2 合格、2 失敗）。
- log：`logs/phase23/viewer-own-citizen-ff74.txt`。

**証拠の区別。**
- 以前からある適格な実行：resident-me の 5/5（§29.24、§29.25）。
- 今回の新しい証拠：上の名指しの試験。修正ありで 4/4、修正を戻すと 2 件が落ちる。どちらも key-free の runner と guard の下で、鍵の入口の呼び出しは 0。
- wide-holding-ui と resident-home の 2 file は、今も走らせていない。⑳ の 55/56 の実行も、今も証拠に数えない。

**集計。**
- 通過：静的な審査 3 件（merge の tree 2 件と herald の静的確認）、新しい試験の 4/4 を 2 通りの監視で、変異の対照（期待どおり 2 件が落ちる）。
- 失敗：0。
- blocked：0。
- 未実行：一覧に載る file すべて（wide-holding-ui、resident-home、herald など）。⑯ の木の外での CI。
- 全体の完了は宣言しない。

### 29.26a 試験への 1 件の追加（⑳ の静的な確認を受けて）と、④ 5cdc4cac の上での再実行

⑳ が試験の場面を静的に確かめた。意図と合っているとのこと。⑳ は何も走らせていない。

⑳ の提案で、財布の viewer が拒む Citizen に `flagged_zero_asset` を 1 つ加えた。`flagged_with_wallet` と同じ null の分岐を通る。

④ `5cdc4cac44cdbd75082d7673ed898d9c50da3e1c`（tree `0ad68c8c…`）の上で：
- digest は `closure=87c87356c018d1e54c1b88e738afa47381f0a1ca3ab113552a50b1bb6fa59da0` に変わった。閉包の file は ff749ed2 から変わっていない。
- `--check` は exit 0（11 file が reviewed）。
- `node-keyfree.sh`：**4/4**。
- repo の guard と hook v2（active check を含む）：**5/5**、hook の記録は 0 行。

差分：`patches/v16-viewer-own-citizen-on-5cdc4cac.patch`。ff749ed2 版の差分は、記録のために残す。

変異の対照（修正を戻すと拒否の 2 試験が落ちる）は、ff749ed2 版の試験で得た結果である。追加した場合は、そのとき既に落ちていた試験の中にあるので、v2 では対照を取り直していない。

## 29.27 ⑦ 2329031c（地図の 2 回目の押下と ws07-grow-s1）の独立のレビュー

対象：⑦ `2329031c48de7ba36fd064518db20d8a638c3eee`（tree `dda088d2…`、親 `d91fa625`）。変わったのは `app.mjs`（+3 −1）、新しい `screens/ws07-grow-s1.screen.mjs`、INTEGRATION の 3 つ。

**(1) `NOTE_TEXT.wait` の同一性（静的）。**
- `NOTE_TEXT` は `map/actions.mjs:697` の `Object.freeze` した object で、`wait` は 1 つの arrow 関数である。
- 地図の注記に `wait` を渡すのは 2 か所で、どちらも同じ参照を渡す。`app.mjs:1039` は `NOTE_TEXT.wait` をそのまま渡す。`refusalText('NoKernel')`（:954）は `NOTE_TEXT.wait` を返す。
- 断りを書く他の場所は、どれも別の関数を渡す。
  - `refusalText` の他の分岐：その場で作る arrow か `NOTE_TEXT.unreachable`
  - `NOTE_TEXT.unopened`
  - `PLACE_NOTE[where]`：world.mjs の別の freeze した表で、`wait` を含まない
  - `pickRefusal`：その場で作る arrow
  - :1024、:1430、:1701、:1777、:1840：その場で作る arrow
- だから、断りが「読み込み中」と取り違えられることは無い。`FS.mapNote` を `mapNote()` 以外で書く場所は、null を代入するものだけである。
- **限界。** 規則の module の読み込みが失敗し続けると、`wantKernel` の catch が `kernelAsked=false` に戻し、押すたびに読み込みをやり直す。その間は注記がずっと `wait` なので、同じマスを 2 回押しても選択にならない。軍勢は手に残るので、手を閉じる操作で抜けられる。これは UX の判断で、⑦ の担当。
- `routeTo` は `!A?.actor` のときも null を返し、注記は `wait` になる。ただし mapTap のこの枝では、`actionsNow()` が actor の無いときに null を返す。その場合は手前の `!A` で return するので、この枝には来ない。

**(2) ws07-grow-s1 の実行。**
- 実行の前に、node 側の import の閉包を審査した。鍵の API を名指す file の集合は、§29.14 で審査して走らせた ws07-grow と同じである。`startServer({ keyless: true })` なので、`world.viewer` は `keyFromSeed` を呼ばない。`growth-route.mjs` が使う node:crypto は `createHash` だけ。
- 実行：full Chromium と repo の no-keys-guard の下で、⑦ の commit のままの版は **2/2**。
- **対照。** `app.mjs` の 1 行の修正を戻すと、**0/2**。デスクトップもスマホも grown の段で止まった（`who: null`、`compose: null`。軍勢が手から落ち、札が開かない）。⑦ の「古い版 0/2、新しい版 2/2」と一致する。

**(3) 404 は、主張を実際より強く見せるか（⑦ の問い）。**
- ⑯ は、記録だけを加えた写し（`probes/v16-grow-s1-404.screen.mjs.txt`。`page.on('response')` で 404 を集め、console.log を 1 行出すだけ）を 2/2 で走らせた。
- ページが受けた 404 は、すべて `/h/` だった。ページ自身の file の 404 は 0 件。
- relay が 404 を返した `/h/` の path は 21 種類で、デスクトップとスマホで同じだった：
  - `caravans.json`、`conquest`、`control`、`events`、`keep`、`nations.json`、`standings`、`structures.json`
  - `overview/0..2`、`overview2/2`
  - `province/3,0`、`3,1`、`4,-1`
  - `roster/0..5`
- **INTEGRATION の記述は狭い。** 記述は「events、roster、輪 0〜2 の overview、隣の州」だけで、conquest、control、keep、standings、caravans、structures、nations、overview2/2、roster 3〜5 が抜けている。
- **主張に効くもの。** `structures.json` の 404 では、柵（palisade）が 0 になる。だから「⑧ の ROUTE と一歩ずつ一致」は、柵の無い条件での一致である。本物の herald がこの段で structures を返すかどうかは、この golden からは分からない。「router と同じ 404」という説明も、golden に無いことからの推定で、router の実物は見ていない。
- **主張に効かないもの。** 隣の州の 404 は、(4,0) から (5,0) への道筋と assertion には効かない。lead window と beacon の判定は `/h/season` の本物の値に基づく。
- **試験の穴。**
  - console error の除外は「status of 404」の文字列で行っている。ページ自身の file の 404 も黙って許されてしまう（今回は 0 件だった）。
  - `missing` の集合は集めているのに、assert していない。
  - 提案：404 は `/h/` だけで、`missing` は記録した 21 種類と一致する、と assert する。こうすれば、新しく欠けた path に気づける。

**集計。**
- 通過：静的な照合 1 件、2/2、記録版 2/2。
- 対照：期待どおり 0/2。
- 失敗：0。
- blocked：0。
- 未実行：封・署名・送信・着地。本物の router の上での実行。
- log：`logs/phase23/ws07-grow-s1-2329.txt`。
- 全体の完了は宣言しない。

## 29.28 ④ 685c4dda の照合（⑦ 2329031c と ⑯ の試験 v2 の取り込み）

対象：④ `685c4dda70ea2adc271f5f03fe2f4dacd650951a`（tree `d41c239b4e2d5d7aeb8d2ce338ed7b48547e4fc2`）。親は 5cdc4cac から続く。

- **⑦ 2329031c の merge** `819831e4`：tree `285554b6…` は、`git merge-tree 5cdc4cac 2329031c` が出す tree と同じ。§29.27 のレビューはそのまま有効。
- **⑦ 53ea9008 の merge** `fa8b2a8e`：tree `ab75723f…` は、merge-tree が出す tree と同じ。⑦ 側の変更は、ws07-grow-r5 の注釈の 2 行だけ。
- **⑯ の試験** `dae7e567`：⑯ の `patches/v16-viewer-own-citizen-on-5cdc4cac.patch` と、内容が一字一句同じ。685c4dda の木で `--digest` を取ると `closure=87c87356…` で、登録された値と一致する。`node-keyfree.sh` で走らせると **4/4**（11 file が reviewed）。
- **HOLDER-CONTRACT §15（`685c4dda`）。** 証拠の項に、この試験と ④ の静的審査、4/4、修正を戻したときの 2/4 を記した。wide-holding-ui は登録していないことと、resident-home は直接 scan に載るので登録できないことも、正しく書いている。⑯ の §29.26 の点 2（⑳ の 7 file の実行を証拠から外すこと）は、④ の 16777540 と d9e34303 で既に直っていた。
- **集計。**
  - 通過：merge の tree の照合 2 件、patch の同一性、digest の一致、4/4。
  - 失敗：0。
  - blocked：0。
  - 未実行：一覧に載る file すべて。
  - 全体の完了は宣言しない。

## 29.29 ⑦ 75653728、⑲ e3abbee1、④ 025c93b0・c378c1ce（§29.27 の 404 の指摘への対応）

- **⑦ `756537280443c8374f2c98ebf3a4182a9158305a`**（tree `895f2b05…`）：試験と INTEGRATION だけを変える。
  - `ABSENT` に挙げた 21 の path は、⑯ の記録版の写しが拾った 21 種類と完全に一致した。デスクトップとスマホで同じ。
  - 新しい assertion は 2 つ：ページが受けた 404 はすべて `/h/` の下にあること、そのすべてが `ABSENT` に入っていること。だから、ページ自身の file の 404 は落ちるようになった。
  - ⑯ の実行（full Chromium、repo の no-keys-guard）：**2/2**。
- **⑲ `e3abbee11c337641db816cdea541c5a6cee2ef0c`**（tree `71d5a766…`）：変わったのは試験と golden の 3 つの file だけ。
  - Rust の試験は、`/h/structures.json` を `s1_paths` に加え、4 つの段のすべてで 200 と `{"v":1,"structures":[],"sightings":[]}` を確かめる。
  - この試験は、router の実際の答え `g` を golden の file と `assert_eq!(g, want)` で突き合わせる。だから、空の答えは golden を読み込んだものではなく、router の実物の答えである。
  - ⑯ の実行：`cargo test -p herald --test ws19_map_contract` が **2/2**。`WS19_GOLDEN_WRITE` は設定していない。走らせた後も worktree に変更は無い。
  - Node の試験は `herald.structures()` と `s1walk.blockedHexes` を使い、どの段でも `[]` になる。
    - ページの `palisadeHexesOf` も、同じ `structures` の配列を `blockedHexes` に渡す。stances は、試験が `{}`、ページが nations の 404 による null で違う。しかし配列が空なので、結果はどちらも `[]` になる。
    - `s1walk.mjs` の閉包は 6 file で、鍵の API を名指す file は無い。map-contract も 51 file で同じく無く、一覧にも載っていない。
    - ⑯ の実行（`node-keyfree.sh`、map-contract と map-arrival）：**16/16**。新しい structures の試験も含む。
  - **⑲ の問いへの答え。** route の条件のうち「柵が無い」ことは、これで router の答えとして読まれた。残る推定は 2 つ：残りの 20 の ABSENT の path と、柵のある世界。どちらも ⑲ が書いたとおり、意図して対象にしていない。
- **④ の merge。**
  - `025c93b06d3c01df696f49ff7c3ae7b2bbe3af92`（tree `43877414…`）は 685c4dda と 75653728 の merge。
  - `c378c1cecb2272cf9d2381f28abbb6d15e9db853`（tree `7a2df3cc…`）は 025c93b0 と e3abbee1 の merge。
  - どちらの tree も、`git merge-tree` が出す tree と同じ。
- **⑦ `adfdecaf9da81e8a9967e8ec887b5963ce5c1a08`**（tree `b161e1c2…`）。親 f8f426b3 の tree は c378c1ce と同じ `7a2df3cc…`。
  - ABSENT から structures を外した（20 の path）。grown の段で、feed を読んだこと（`read: true`）、structure が 0、`palisadeHexesOf(FS)` が 0、の 3 つを確かめる。
  - 注意：`palisadeHexesOf` は `walkerOf` が null（S1 が無効か、faction が無い）のときも `[]` を返す。`blocked: 0` だけでは、feed を通ったかどうかは分からない。`read: true` と `n: 0` が、その分を補っている。
  - 実行の結果は、下の追記に書く。
- **集計**（ここまで）：
  - 通過：一覧の一致 1 件、2/2、16/16、cargo 2/2、merge の tree の照合 2 件。
  - 失敗：0。
  - blocked：0。
  - 未実行：柵のある世界。封・署名・送信。
  - log：`logs/phase23/ws07-7565-ws19-e3ab.txt`。

**追記（⑦ adfdecaf と ④ 585e9fab）。**
- ⑯ は ⑦ `adfdecaf` の ws07-grow-s1 を、full Chromium と repo の no-keys-guard の下で走らせ、**2/2**。grown の段の feed の assertion（`read: true`、`n: 0`、`blocked: 0`）も通った。
- ④ `585e9fab66390656eaf580aed73c72a9f51997e3` は c378c1ce と adfdecaf の merge。tree `b161e1c2…` は adfdecaf の tree と同じなので、この実行がそのまま当てはまる。
- 集計：失敗 0、blocked 0。全体の完了は宣言しない。

## 29.30 ④ の引継ぎ文書 §19（review/ws04-docs-handoff-20261108 @ 308fa4b0）の照合（静的のみ）

対象：`308fa4b06be6dfb9ff454670e15903c67642f3a0`（tree `c5dbb398…`、親 591458a1）。INTEGRATION-20261107 §19 の 55 行だけ。

**正しかったもの**
- 表の 20 組（担当の SHA → 候補の commit）は、どれも正しい。
  - merge の 16 組では、候補の第 2 親が担当の SHA と一致する。
  - ⑧ の 4 組では、`ceb4cc9e`・`a5faebec`・`6a20fa67` の patch-id が担当の commit と同じ。`a6e261f8` は ⑧ の commit そのもので、`6507c519` はその上の merge（tree が同じ）。
  - どの候補も 585e9fab の祖先である。
- caeb1b74 から first-parent で 26 commit、32 file。基準 16576826 の tree は `7f6ff8b0`。
- write_params の照合は §29.22、無効と有効の区別は §29.23〜§29.25 を指していて、どちらも正しい。

**直すべき点**
- **merge の tree についての主張。** §19 は「各 merge の tree が親の merge-tree と一致する（手の編集なし）」と書く。⑯ が今回 16 の merge をすべて計算し直すと、15 は一致した。
  - `0b105a33`（⑳ 0a766757 の merge）は HOLDER-CONTRACT.ja.md で衝突していて、④ が手で解いた（+18 −18、この file だけ）。④ は以前にこの解き方を説明している。
  - この 1 件は「手の編集なし」から外すべき。
- **数の帰属。**
  - 「修正の 14 行だけを戻すと 2/4」は、④ の実行だけでなく ⑯ の実行でもある（試験の v1、ff749ed2 の上で。§29.26）。
  - ⑯ の cargo の ws19_map_contract 2/2 は、585e9fab ではなく e3abbee1 の上で走らせたもの。
- **一覧に載る file を直接走らせた件**（42 行目）。「101 file 呼び出し 0」は、一覧に載る file を名指しで走らせた実行ではなく、41 行目の広い再実行（26 回の停止）の結果である。また、file の名前は `web-frontier-ws07-nft`、`web-frontier-ws07-me-answered` が正しい。
- **判断待ちの一覧に抜けがある。** ⑯ が開いたままにしている次の 4 つが無い：
  - ⑥ J7 の外部の lock の削除の限界
  - digest と runner の範囲
  - Worker の realm
  - （⑦ の判断）規則の読み込みが失敗し続けるときの、2 回目の押下
- **⑯ が確かめていないもの。** 「この枝の workflow run は 16 のまま」は、⑯ は確かめていない。

**追記（④ c57f63d6）。** docs の枝 `c57f63d64ab0b5e2be3a1e58e8568a350cac9f48`（tree `60936112…`、親 308fa4b0）。§19 だけで、+7 −5。

⑯ の 5 点はすべて直っていた。
- 0b105a33 は手で解いた merge として名指されている。
- 2/4 の帰属は ⑯ の v1 と ④ の v2 の両方になった。
- ws19_map_contract を走らせた commit と人が並べられた。
- 「101 file 呼び出し 0」は広い再実行の側へ移り、file の名前も正しくなった。
- 判断待ちの 4 点が加わった。

「585e9fab の上では走らせていないが、その後の差分は ws07-grow-s1 と ⑦ の文書だけ」は、`git diff c378c1ce 585e9fab` で確かめた。その 2 file だけである。

workflow run が 16 のままであることは ④ が数えたもので、⑯ は確かめていない。

## 29.31 ⑲ の柵の場合 3c7c0929 と 2db2db4b の独立のレビュー

対象：⑲ `3c7c0929455fe7e80bc355c186211e919cc5c336`（tree `9a03b8f2…`、585e9fab の上）と、その上の `2db2db4b`（tree `bf9619ba…`）。

**(1) map_growth の出力は変わらない。**
- 変更は 3 つだけ：`rec` が `rec_at(NO_BELL)` を呼ぶようになったこと、`Tx.last`（push のたびに記録するだけ）、`growth_tx` への切り出し。
- ⑯ の実行：`cargo test -p herald --test ws19_map_contract` が **3/3**。この試験は、本物の router の答えを、空の世界の S1 golden とも柵の golden とも突き合わせる。`WS19_GOLDEN_WRITE` は設定しておらず、走らせた後も worktree に変更は無い。

**(2) `build_structure` との照合（静的）。** program 側は `proc/structure.rs:189-378`。
- 一致するもの：
  - Structure の各 field：P、Q、TILE、STATE_LIVE、FACTION、GEN 1、OWNER_CITIZEN、OWNER_TAG、BUILT_TS、SEIZED_BELL=NO_BELL、NOTIFY、ENTRY、KIND。
  - Province の structure entry 0（kind、tile、faction、gen 1）。
  - Citizen の PALISADES +1（offset 314。abi の assert で固定）。
  - key9（i32 p、i32 q、tile）。
  - payload の順（owner_tag、faction、1、entry、notify、host_id、cost_digest、kind。53 B）。`cost_digest` は holding.rs と同じく、8 つの i64 の LE を sha256 にかけたもの。cost は同じ `permutation_rules::frontier::structure::cost`。
  - chain の順は Citizen、Holding、Province、Structure。
  - bell 0：BELL_SECS は 600 なので、GENESIS_TS+300 は bell 0。
- **違うもの、または新たに選んだもの：**
  - **`RENT_TO`（offset 128）。** program は payer の key を書くが、fixture は 0 のまま。
  - **Holding の chain の頭。** `rec_at` は hd の seq と head（24..64）を進めるが、hd は repost されない。だから、公開される Holding の chain の頭は、STRUCTURE_BUILT がつなぐ先より古いままになる。これは「支払いを再現していない」とは別の帰結である。
  - **holding key の gen。** `host_id(4,0,1,0,0)` の gen 0 は、fixture の Holding の GEN（一度も設定されず 0）と合っている。program は `hh.gen` を使う。
  - **選んだもの**：notify = NOTIFY_OWNER、建てる者 = faction 2 の NFT の住民、tile = 道筋の上で最初に建てられる hex。

**(3) (4,0) t6（hex 33,-16）。** router が返す `/h/province/4,0` の bytes を、page の codec で読んだ（`probes/v16-ws19-palisade-hex.mjs`）。
- passableMask の bit 6 は 1。sites に 6 は無い。keep は tile 1。camp は state 0（tile 0）。
- 柵の段では、entry 0 が {kind 2, tile 6, faction 2, gen 1} になる。
- `palisade_at` の判定には camp の条件が無い（program にはある）。今回の場所には camp が無いので、結果は同じ。
- この hex が ⑧ の道筋の上にあり、行き先ではないことは、Rust と Node の両方の試験が確かめている。

**(4) stance は feed から読んでいる。**
- page の `refreshS1` は `s1.nations = r.nations` とし、`walkerOf` は `fs.s1.nations.stances` を使う。試験の `na.nations.stances` と同じ field である。
- **限界。** golden の stance の表は、すべて 0（STANCE_WAR）。`stanceOf` は、表が無いときも war を返す。だから、この場合の判定は「feed を読んだ」ときと「既定の値を使った」ときで同じになり、区別できない。通行を許す、または同盟の stance での判定は、試すものが無い。

**(5) 2db2db4b：kernel が柵を避ける道筋。**
- **閉包。** 66 file。鍵の API を名指すのは vendored の noble の 4 file だけで、seal-worker の後ろにある。追えない構文は 0。
  - seal-worker の top-level にあるのは、`bls.G2` などの束縛の参照だけ。
  - `wasm.mjs` は `WebAssembly.instantiate(bytes, {})` で、import の object が空なので、wasm から外を呼べない。
  - `--digest` は `a6fb6711…` で、reviewed の行と一致する。`--check` は exit 0。
- **固定した道筋は kernel の答えか。** ⑯ の probe（`probes/v16-ws19-palisade-route.mjs`、repo の guard の下）で、kernel の答えをそのまま表示した：
  - 柵なし：dirs [0,0,0,0,1,1,0,1,1]、1320 s、9 hex。
  - (33,-16) を塞いだとき：[5,0,0,1,0,1,1,0,1,1]、1320 s、10 hex。
  - これは ⑲ が固定した AROUND と同じで、⑲ が選んだ値ではない。
  - 道筋の上のどの 1 hex を塞いでも、kernel は 1320 s の道筋を返した（9〜11 hex）。
- `checkMarch` に渡す `arriveBell: 3` は試験が与える値である。kernel の `earliestBell`（bell 0 の +300 s に出発）も 3 で、整合している。
- ⑯ の実行：`node-keyfree.sh` で map-arrival、map-contract、growth-route が **24/24**。

**集計。**
- 通過：cargo 3/3、node 23/23（3c7c0929）と 24/24（2db2db4b）、静的な照合。
- 失敗：0。
- blocked：0。
- 未実行：柵のある世界の全画面、Holding の支払い、通行を許す・同盟の stance、封・署名・送信。
- log：`logs/phase23/ws19-palisade-3c7c-2db2.txt`。
- 全体の完了は宣言しない。

**追記（④ b45bb806）。**
- `b45bb806c3eff7b210a17fadb507724d2d5fbbb7` は 585e9fab と ⑲ 3c7c0929 の merge。
- tree `9a03b8f2…` は 3c7c0929 の tree と同じで、merge-tree が出す tree とも一致する。だから、§29.31 の 3c7c0929 での実行（cargo 3/3、node 23/23）がそのまま当てはまる。
- ⑲ の 2db2db4b（map-arrival の柵の試験）は、まだ取り込まれていない。
- §29.31 の 3 点（RENT_TO、Holding の chain の頭、holding key の gen）は、取り込んだ後も残っている。

**追記（⑲ 8945b582、tree `b8f9fc27…`、2db2db4b の上）。**
- `palisade_at` に camp の条件が加わった。使う camp の layout は、program と同じ `frontier_abi::layout::province::camp`（STATE @1、STATE_PRESENT=1）である。golden は変わっていない。cargo の突き合わせが通るので、結果に影響が無いことが確かめられる。
- 新しい Node の試験は、読んだ表の stance [2][1] を 1（pass）にすると塞がれず、0（war）に戻すと 1 hex が塞がれることを確かめる。これで、`blockedHexes` が表の値を使うことが示された。
  - `stanceOf` の向きは `stances[n][f]` で、n = 柵の国 2、f = 見る者の faction 1。
  - ただし、page が実際に feed の表を store に入れることは、§29.31 の静的な確認（`refreshS1` が `s1.nations = r.nations` とする）に頼っている。
- RENT_TO、Holding の chain の頭の遅れ、場面の選択は、`palisade_case` の doc に書かれた。値は変えていない。payer と支払いは定義が決めないので、変えないという ⑲ の理由は妥当である。
- ⑯ の実行：`node-keyfree.sh` で map-contract、map-arrival、growth-route が **25/25**。cargo の ws19_map_contract が **3/3**。worktree に変更は無い。

## 29.32 ⑦ ws07-grow-palisade（5d8292cb、827aabcc）、④ 91bbfef5・c47d0acd、ページの province の要求の嵐

**④ `91bbfef517cb7af8f3107e5f962ec895e48ea775`（tree `708de771…`）**
- 2 つの merge から成る。
  - `078e946c`（⑲ 2db2db4b の merge）：tree は merge-tree が出す tree と同じ。
  - `91bbfef5`（⑧ d1ba760c の merge）：`node-key-reviewed.txt` の衝突を、④ が手で解いた。差はこの 1 file の行だけ。
- ④ が付け直した digest は、⑯ が計算し直した値と同じ：growth-route `6af13991…`、map-arrival `61acfc1b…`。map-arrival の digest が変わったのは、閉包に growth-route.mjs が入っているため。`--check` は exit 0。
- ⑧ d1ba760c の `ROUTE_AROUND_PALISADE` は、⑯ の probe が kernel から表示した答え（§29.31）と同じ。growth-route の閉包は 74 file で、鍵の API を名指すのは vendored の noble の 4 file だけ。
- ⑯ の実行：`node-keyfree.sh` で map-arrival、map-contract、growth-route、viewer-own-citizen が **29/29**。

**④ `c47d0acd9d5e5ddd467c43626bf2fac2084c02e9`（tree `bd1f3c5a…`）**
- 2 つの merge（⑲ 8945b582 の `b226f6e2`、⑦ 5d8292cb の `c47d0acd`）とも、tree は merge-tree が出す tree と同じ。
- 取り込んだ ⑦ の試験は 5d8292cb の版で、締めた 827aabcc の版ではない。

**⑦ 5d8292cb と 827aabcc（ws07-grow-palisade）**
- 静的な確認。
  - 5d8292cb の NoPath の枝は緩すぎた。route が無ければ、どんな断りでも通っていた。
  - 827aabcc はこの枝を外し、⑲ が固定した AROUND（[5,0,0,1,0,1,1,0,1,1]、1320 s）との一致を要求する。これで十分である。
  - ⑧ が `G.ROUTE_AROUND_PALISADE` を export したので、⑦ は自分で値を書き写さずにそれを使える。
- 実行（⑯ の機械、full Chromium、repo の no-keys-guard）。
  - 5d8292cb の版と、記録だけを加えた写しを**同時に**走らせた。2 つの browser が並んで動き、資源が尽きた。これは ⑯ の runner の誤りなので、この結果は数えない。それでも、記録の写しが示した道筋は、デスクトップでもスマホでも AROUND と同じだった。
  - 827aabcc の版を単独で走らせた：**デスクトップは通り、スマホは落ちた**。console に `net::ERR_INSUFFICIENT_RESOURCES` が 27 件出た。
  - 要求を数える写し（`probes/v16-grow-palisade-req.screen.mjs.txt`）を単独で走らせた。
    - デスクトップは約 2 分で計 1712 件の要求を出した。そのうち `/h/province/4,-1`、`3,0`、`3,1`（golden に無く 404 になる隣の州）が 345、331、326 件で、約 740 件が `ERR_ABORTED` だった。
    - スマホでは renderer が落ちた（`touchscreen.tap: Target crashed`）。
- **原因はページの不具合である（静的に確認）。** `controller.mjs` の `wantProvince`（917〜926 行）：
  - 読み込みに失敗した州（404 など）は `FS.provinces` に入らない。だから `have` が undefined になり、`fetchedAt` の 30 s の間隔は見られない。
  - そのため、読み込みが終わるたびに `onLoad` が描き直しを起こし、描き直しの中から `wantProvince` がすぐまた要求を出す。404 の州は、待ちなしで要求され続ける。
  - この挙動は、基準 16576826 の時点から既にある（33bb7d9a、2026-10-01）。⑦ の今回の変更で入ったものではない。
  - 本物の herald でも、まだ書かれていない州や種の無い州が 404 を返せば、同じ嵐が起きうる。
  - ws07-grow-s1 も同じ 3 つの州で 404 を受ける。⑯ の機械では 2/2 で通ったが、嵐の有無は数えていない。
- **区別。** 嵐は、ページの実際の不具合で、⑦ の画面の担当になる。スマホが落ちるかどうかは機械の速さ（環境）によるらしい。④ と ⑦ の機械では 2/2 だった。⑯ の機械では 827aabcc のスマホは**通らない**。
- **提案（判断は ⑦）。** 見つからなかった州にも `fetchedAt` の間隔を当てる（否定の cache）。そうすれば、試験の 404 にも本物の 404 にも嵐が起きない。

**集計。**
- 通過：node 29/29、merge の照合 4 件、静的な照合、827aabcc のデスクトップ 1/1。
- 失敗：827aabcc のスマホ 1/1（ページの嵐による。機械の速さにも依存）。
- 数えないもの：5d8292cb を 2 つ同時に走らせた実行。
- blocked：0。
- log：`logs/phase23/ws07-palisade-storm.txt`。
- 全体の完了は宣言しない。

**追記（④ 0cdd8491、⑦ 4e5f0915）。**
- ④ `0cdd8491ee420d2d5b95ee747d230da90c70ee72`（tree `ebc1fea7…`）は c47d0acd と ⑦ 4e5f0915 の merge。tree は merge-tree が出す tree と同じ。⑦ の 827aabcc も含む。
- 4e5f0915 で、AROUND は ⑧ の `G.ROUTE_AROUND_PALISADE` から作るようになった。また、golden の柵が `G.PALISADE`（4,0,6）と同じであることを確かめるようになった。⑯ の提案どおり。
- ⑯ は 0cdd8491 の画面を走らせ直していない。§29.32 の嵐は直っていないので、⑯ の機械ではスマホが落ちる見込み。④ の機械では 2/2。
- ④ は ⑦ に 2 つを頼んだ：機械によらずに嵐を再現する試験（決めた時間の窓の中で、失敗した州ごとの要求の数に上限を置き、今の controller.mjs で落ちるもの）と、最小の修正（成功する読み込みと 30 s の fetchedAt の規則は変えない）。届いたら、⑯ が review する。

## 29.33 7 の province の要求の嵐の修正（1fc0a5aa、01bb323f）と、19 の S1 golden の追加（f001c9c3）

以後、担当の番号は丸で囲まずに書く。

### 7 `1fc0a5aa1c05b6ce8268e4bd7b9f473bc272beb6` と `01bb323f60ce579b6a9427795d813f81f4afb95f`（tree `3b99e205…`）

**静的な確認。**
- 修正は `wantProvince` に足した 1 行：`if (!have && fetchedAt.has(key) && now - fetchedAt.get(key) < WANT_REFRESH_MS) return false;`
  - 最初の読み込み（`fetchedAt` にまだ無い）は止めない。
  - 読み込みが成功して保存された州（`have` がある）は、これまでと同じ規則のまま。
  - 境界は `<` なので、ちょうど 30 s で再び要求する。
  - `fetchedAt` は要求を始めた時刻で、失敗した時刻ではない。404 に限らず、一時的な失敗（Unavailable など）も 30 s 待つ。
  - `FS.provinces` は fstate の初期化のほかに作り直されないので、「保存が消えた後に止められる」退行は無い。
- 失敗の直後にすぐ要求し直すことに頼る呼び出し元は無い。
  - `refresh()`、holdings と host の州、compose の refresh、選んだ州は、`loadEnvelope` を直接呼ぶ。この修正の影響を受けない。
  - `wantProvince` の呼び出し元（app.mjs 1318・1793・2963・3784・3831、controller.mjs 1170）は、戻り値によらず自分の処理を続ける。`onLoad` は描き直すだけ。
- **scan の門（新しい指摘）。** 7 の head（01bb323f）では `scan --check` が **exit 5** になる。controller.mjs が変わったので、⑯ の viewer-own-citizen の reviewed の digest が古くなった。
  - 変わったのは `wantProvince` の 3 行で、`applyMeResult` の経路には無い（applyMeResult の中に wantProvince の呼び出しは 0）。
  - だから付け直しは正当で、新しい値は `c57b84cc…`。
- **7 の unit 試験について。** 7 の 13/13 は `web-frontier-hud.test.mjs` の中にあり、この file は `node-key-tests.txt` に載っている。だから鍵なしの証拠にはならず、⑯ もこの file は走らせていない。
- 代わりに ⑯ が最小の名指しの試験を作った：`web-frontier-want-province.test.mjs`。
  - 閉包は 137 file で、viewer-own-citizen と同じ。
  - 読み込みの時点の top-level の監査をやり直し、鍵の入口を呼ぶものは無かった。
  - 試験が通る経路：`wantProvince` → `loadEnvelope` → 差し替えた herald の province()、`latestEnvelope`、`protoLand`（FS.proto は null）、`keepFromProvince`（純粋）。`useHerald` → `fwide.clearWide`。
  - 確かめること：最初の読み込みは止まらない。失敗の後は、すぐにも、30 s 以内にも（新しい bell でも）要求せず、30 s ちょうどで要求する。失敗の後の成功は保存され、その後は保存された州の規則に従う。最初から成功する州は、これまでの規則のまま。
  - reviewed の行は `closure=a623aab2…`。

**実行**（⑯ の機械。以前スマホが落ちた環境。画面は 1 本ずつ単独で、full Chromium と repo の no-keys-guard の下で走らせた）：
- 新しい controller：`node-keyfree.sh` で want-province と viewer-own-citizen（付け直し後）が **8/8**。`--check` は exit 0（12 file が reviewed）。
- 古い controller（7 の 3 行を戻し、走らせる間だけ digest を付け直し、終わった後に戻した）：want-province は **3/4**。落ちたのは「失敗の直後に再び要求しない」の 1 件だけ。最初の読み込み、成功後の回復、成功した読み込みの 3 件は、古いコードでも新しいコードでも同じ答え。だから、この修正が変えるのは失敗の経路だけである。
- 新しい controller の画面：ws07-grow-palisade **2/2**（以前は ⑯ の機械でスマホが落ちた）、ws07-grow-s1 **2/2**。
  - 要求を数える写しで数えた。404 の州（3,0、3,1、4,-1）への要求は、それぞれ 2 件（page を読み込むたびに 1 件）。使っている州 (4,0) は最大 6 件。
- 古い controller の画面：ws07-grow-palisade **0/2**。どちらも、落ちたのは要求の上限の assertion（デスクトップは 405〜414 件、スマホは 430〜514 件）で、browser が落ちたのではない。
- **上限 20 の妥当性。** 新しいコードの最大は 6、古いコードは 405 以上で、差は大きい。1 回の page の読み込みで 1 件に、30 s ごとの再要求が加わるだけなので、遅い機械でも 20 には届かない見込み。
- **pan の helper**（01bb323f）。
  - 押す位置の下端を、action bar と、幅が画面の 6 割を超える #panel（スマホの sheet）の上端にした。デスクトップの横の drawer は除外する。
  - host を押す前にも、その tile を視野に入れる。動かし方は、map 自身の矢印 key。
  - 12 回動かしても視野に入らなければ、そのまま押し、そのあとの `inHand` の assert か `until` の timeout で落ちる。だから、ページの失敗を隠さない。
  - 別の論点（判断は 7）：スマホでは、深い link `?at=` の tile が sheet の下に入ることがある。
- **差分。** `patches/v16-want-province-on-01bb323f.patch`：新しい試験と、reviewed の 2 行（viewer-own-citizen の付け直しと、want-province の追加）。log は `logs/phase23/ws07-storm-fix-01bb.txt`。

### 19 `f001c9c3a149a5f7931f3902828332310af374be`（tree `39518426…`）

- **(1) 既存の答えは変わっていない。** 0cdd8491 の S1 golden の entry をすべて突き合わせ、変わったものは 0 件。最上位の field も同じ。M1 の golden と柵の golden は触っていない。
- **追加された path。** 各段に 18 の path が増えた：7 の ABSENT のうち 16（events、roster 0〜5、overview 0〜2、overview2/2、州 3,0・3,1・4,-1、caravans、nations）と、overview2/0・1。
  - ABSENT に残るのは conquest/0.json、control、keep/4,0.json、standings の 4 つ。
- **(2) index。** main.rs は 95 行で無条件に、208 行で read-only でないときに `app.index` を設定する。`app.index` を読むのは server.rs の `events`（591 行）だけである。
- **(3) status。** 増えた path は、roster 5 を除いてどの段でも 200。roster 5 は grown より前の段で 404 NoSuchRing（router の本物の答え）。cargo の突き合わせで確かめた。
- **(5) 閉包。** `people/roster.mjs` は import が 0。map-contract の閉包は 52 file で、鍵の API を名指す file は無く、一覧にも載っていない。golden に secret や mnemonic の文字は無い。prize の名がつく field は、公開の `prizeMaxRing` だけ。
- **⑯ の実行。** `node-keyfree.sh` で map-contract、map-arrival、growth-route が **29/29**。cargo の ws19_map_contract が **3/3**（`WS19_GOLDEN_WRITE` は設定していない。worktree に変更は無い）。
- **元の page の fixture への影響。**
  - 7 の ws07-grow-s1 の ABSENT（20 の path）は、この golden を取り込むと 16 の path が過大になる。試験は「404 は ABSENT の部分集合」だけを見るので、通り続ける。ただし header の記述は古くなる。
  - 隣の州の 3 つが 200 になるので、ws07-grow-s1 は嵐を起こさなくなる。嵐の再現は、柵の golden（6 つの path だけ）の側に残る。
  - まだ生成されていない州の 404 は、柵の golden と roster 5 に残っている。
  - 組み合わせた実行の結果は、下の追記に書く。
- log：`logs/phase23/ws19-f001.txt`。

**追記（組み合わせた実行）。** 7 の 01bb323f（新しい controller）の ws07-grow-s1 を、19 の f001c9c3 の S1 golden に差し替えて、単独で走らせた。走らせたのは記録だけを加えた写しで、golden は終わった後に戻した。
- 結果は **2/2**。
- ページが受けた 404 は、デスクトップで conquest、control、standings の 3 つ、スマホではそれに keep/4,0 を加えた 4 つ。どれも残る ABSENT の 4 つの中にある。
- だから、19 の golden を取り込んでも、7 の画面の試験は通る。ただし ABSENT の 16 の path と header の記述は古くなる。7 が ABSENT を 4 つに減らせば、assertion は締まる。

**追記（7 の 3c7e8cb4 と 4532651d。41a52e19 の上）。**
- 41a52e19 は 01bb323f と 19 の f001c9c3 の merge で、tree は merge-tree が出す tree と同じ。
- 3c7e8cb4 で、ABSENT は残る 4 つに減った。roster 5 の NoSuchRing は、`ROUTER_404`（router 自身の 404）として分けて扱う。
- 4532651d で、relay は `/h/province/4,-1/latest` をわざと 404 にする。(4,-1) は進軍の道の上に無い。また、その州が実際に要求されたこと（1 回以上）も確かめる。こうして、要求の上限が golden の中身に頼らずに試される。
- ⑯ の実行（単独、full Chromium、repo の no-keys-guard）。
  - 新しい controller：**2/2**。
  - 古い controller：**0/2**。どちらも上限の assertion で落ちた。(4,-1) への要求はデスクトップで 332 件、スマホで 525 件。7 の数（287 件、508 件）と、桁が一致する。
- 7 は、4 に ⑯ の want-province の差分（付け直しを含む）を取り込むよう頼んだ。7 自身は付け直していない。

### 4 の統合：fe7a810a と 553f7fe7

- **A `fe7a810ad8654fe63635988ab242e74570154c9e`**（tree `a56e56c5…`）。
  - `f9be57bf` は 7 の 01bb323f の merge で、tree は merge-tree が出す tree と同じ。
  - `872ec015` は、4 による viewer-own-citizen の付け直し（`c57b84cc`）。
  - `fe7a810a` は、⑯ の want-province の試験と reviewed の行。
- **B `553f7fe79f904415e8f42482ba06b4caef90f650`**（tree `dcbc1970…`）は、A と 7 の 4532651d の merge で、tree は merge-tree が出す tree と同じ。4532651d は、19 の f001c9c3 と、7 の 41a52e19・3c7e8cb4 も含む。
- **最後の統合の差分の確かめ。** `git diff 4532651d 553f7fe7` で 7 の head と比べると、差は `web-frontier-want-province.test.mjs`（+68）と `node-key-reviewed.txt` の 2 行だけ。
  - 試験の file は、⑯ の差分（`patches/v16-want-province-on-01bb323f.patch`）と一字一句同じ。
  - reviewed の行は viewer-own-citizen `c57b84cc` と want-province `a623aab2`。
  - 553f7fe7 の木で計算し直した digest は、viewer-own-citizen、want-province、map-arrival（`61acfc1b`）、growth-route（`6af13991`）の 4 つすべてが、登録された値と一致した。
  - `--check` は exit 0（12 file が reviewed）。
- **⑯ の実行**（553f7fe7）：`node-keyfree.sh` で want-province、viewer-own-citizen、map-contract、map-arrival、growth-route が **37/37**。
- **画面の扱い。** B の画面は、⑯ は走らせ直していない。ws07-grow-s1 の file は 7 の 4532651d と同じで、⑯ はそこで新しい controller 2/2、古い controller 0/2 を得ている。
- 4 が数えた CI の run は 16 のまま。⑯ は確かめていない。
- **集計（§29.33 全体）。**
  - 通過：新しいコードの試験と画面のすべて。
  - 落ちたもの：古いコードの対照だけで、期待どおり（want-province 3/4、ws07-grow-palisade 0/2、ws07-grow-s1 0/2）。
  - blocked：0。
  - 未実行：web-frontier-hud（一覧に載る）、封・署名・送信。
  - 全体の完了は宣言しない。

## 29.34 4 の引継ぎ文書 §20（docs の枝 @ 6ddefe36）の照合（静的のみ）

対象：`6ddefe36bea6f6c6ff12654e856464896bbce9ca`（tree `e09cd869…`、親 c57f63d6）。INTEGRATION-20261107 §20 の 43 行だけ。

**正しかったもの**
- 表の SHA の組はどれも正しい。候補の第 2 親が担当の SHA と一致するか、担当の SHA を含む：
  - b45bb806 ← 3c7c0929
  - 078e946c ← 2db2db4b
  - 91bbfef5 ← d1ba760c
  - b226f6e2 ← 8945b582
  - c47d0acd ← 5d8292cb
  - 0cdd8491 ← 4e5f0915（827aabcc を含む）
  - f9be57bf ← 01bb323f（1fc0a5aa を含む）
  - 553f7fe7 ← 4532651d（f001c9c3、41a52e19、3c7e8cb4 を含む）
  - 872ec015 と fe7a810a は first-parent の上にある。
- 手で解いた merge は、91bbfef5 の 1 つだと正しく書かれている。
- want-province の 3/4（修正前）と 4/4（修正後）、553f7fe7 での 37/37、「hud の 13/13 は数えない」は、§29.33 と一致する。
- §29.31 の fixture の 3 点も、正しく引かれている。
- ⑦ の挙げた routeCache の点も、静的に正しい。app.mjs:906 の key は、柵の hex の中身ではなく `palisadeHexesOf(FS).length` の数だけを含む。

**直すとよい点（帰属）**
- **27 行目。** ws07-grow-s1 の修正前 0/2（304 回、475 回）は、4 の数である。⑯ は 4532651d の上で、332 回と 525 回を測っている（§29.33）。両方を書くとよい。
- **29 行目。** fe7a810a の上の画面の一覧（guard、grow-s1、grow-palisade、grow-r5、march、read、wide、grow）は、4 だけの実行である。⑯ がその上で走らせたのは画面ではなく、node の試験だけ。帰属に「4」と書くとよい。
- **24 行目。** ws07-grow-palisade 2/2 の ⑯ の分は、7 の 01bb323f（新しい controller）の上での実行で、553f7fe7 の上ではない。

数え間違いと SHA の誤りは無かった。新しい実行はしていない。
