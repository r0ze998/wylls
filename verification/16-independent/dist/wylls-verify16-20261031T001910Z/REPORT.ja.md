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
