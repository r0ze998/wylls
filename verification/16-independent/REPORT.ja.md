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
