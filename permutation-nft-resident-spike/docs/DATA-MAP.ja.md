# データ対応表：NFT 譲渡で移るもの・残るもの・決めるべきもの（2026-10-31）

前提：住民 ID は asset から導出され不変。譲渡で変わるのは「現在の保有者＝操作権限者」だけ。**他人の所有権・債務は消えない**。試作（`src/world.mjs`）はこの表の最小部分を模擬している（列「試作」）。実物の列は現在の `main` のコードで該当するものを示す。

## 1. 住民に属する（NFT と共に買い手へ移る）

| 項目 | 実物（現在のコード） | 試作 | 備考 |
|---|---|---|---|
| 村・前哨（Holding） | `Holding.OWNER_CITIZEN` が Citizen を指す（`frontier-abi/src/layout/player.rs`） | `world.residents[residentId].buildings` | Citizen を住民 ID 由来にすれば自然に移る |
| 物資・倉の中身・生産 | Holding の stores / production | `stores` | 自由な資産 |
| 建物・成長（tier・works） | Holding / Citizen.WORKS | `buildings` | |
| 兵・軍（hosts）・封じた進軍 | Province entries / transit | （未模擬） | 進軍は召還不可なので譲渡後も進む。結果は住民へ |
| 隊商（輸送中） | S1 caravan（`OWNER_CITIZEN`） | `caravans[]` → 到着で住民へ加算 | 襲撃された隊商は襲撃者の物（J2） |
| 加工中の注文（工房） | S1 workshop（Holding） | `orders[]` → 完成で住民へ | |
| ゲーム内履歴（イベント連鎖、記録） | 公開イベントログ（herald） | `history[]` | 公開記録。買い手が読める |
| 国の所属・投票資格（join bell） | `Citizen.FACTION`, `JOIN_BELL` | （未模擬） | **要判断（U5）**：資格日数を住民に残すか |
| 封印中の進軍の中身（seal） | drand 時限錠で公開される | （未模擬） | 公開予定のもの。到着で開くので買い手にも見える |
| 住民が**預かっている他人の物** | 倉に入った他人の隊商の荷（S1 の shelter）など | `heldForOthers[]`（owner 付きで保持） | 移るが**自由な資産ではない**。預け主の所有権は残る |
| 住民が**負っている債務** | （実物に明示の債務はまだ無い） | `owed[]` | 移る。買い手が引き継ぐ義務として表示する |

## 2. ウォレット（人）に属する（移らない）

| 項目 | 実物 | 試作 | 備考 |
|---|---|---|---|
| 個人ウォレット残高（SOL/USDC） | ウォレット | — | 対象外 |
| 秘密鍵・session 鍵の seed | ブラウザ（`fsession.mjs`）/ relay keyring | — | 対象外。買い手は自分の鍵を作る |
| API キー・MCP capability トークン | `AgentLedger.capabilityHash` | `auth.credentials`（epoch 束縛） | 譲渡で**失効**する（移らない） |
| 外部アカウント・メール | （waitlist 試案はメールを集める想定） | — | 対象外 |
| agent wallet の預け金・予約・未確定 | `AgentLedger`（owner = wallet） | — | ウォレットの金。住民ではない。**U3** |
| 未受取の賞金（prize Entry） | `entryAddress(prize.program, pool, wallet)` はウォレット鍵 | `walletRewards[wallet]` | 現コードではウォレットに残る。**U4** |
| 費用確認待ち（承認待ちの操作） | agent wallet の hold / 画面の確認 | `approvals`（wallet+epoch） | 譲渡で**無効**。誰も実行できない |
| 入場料の支払い記録 | prize Entry / x402 の `payer` | `entry.payments[].wallet` | 支払者の記録は残る（返金等の根拠） |

## 3. 自動で開示せず、扱いを決める（分離して保留）

| 項目 | 実物 | 試作 | 判断項目 |
|---|---|---|---|
| 私的な会話（talk、council の発言） | `permutation-gateway/src/talk.mjs`、council | — | **U8**：住民の発言か人の発言か。既定は非開示 |
| AI の非公開記憶（episodes, reflection） | `citizens/memory/*`、`mind/reflection.mjs` | — | **U9**：住民の「人格」として移すか、人の資産として消すか |
| 封印中で**まだ公開されていない**情報（未到着の封じた進軍の目的地） | seal（時限錠） | — | 公開前に買い手へ見せると売り手の意図が漏れる。**U10** |
| 運営側の非公開メモ（audit、undecided の記録） | relay の operatorCosts 等 | — | 運営の記録。移さない |

## 4. 譲渡の境界で起きること（順序の規則）

- **チェーンの実行順が境界**。譲渡 tx より前に実行された操作は成立し、その結果は住民のもの（＝買い手が受け取る）。譲渡より後に実行された売り手の操作は prologue で `NotOwner`。
- relay は送信前に保有者を読み直し（`beforeSend`）、変わっていれば送らない。送ってしまった後の最終判定はチェーン。
- 売り手が**署名済みで未送信**の取引は、遅れて届けば拒否（`NotOwner`）。blockhash 期限切れなら `BlockhashExpired`。
- **進行中の処理**（輸送中の隊商、加工中の注文、到着待ちの進軍）は住民のもので、止めずに進む。結果は住民へ。
- **費用確認待ち**は売り手の wallet+epoch に束縛され、譲渡で無効。買い手が同じ操作をしたいなら新たに確認する。
- **他人に預かった物・他人への債務**は消えない。買い手は「預かり」「債務」として引き継ぐ。
