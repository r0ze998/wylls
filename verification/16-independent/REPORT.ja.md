# ⑯ 独立検証 報告書（2026-10-30）

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
